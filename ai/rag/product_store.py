"""
ai/rag/product_store.py — RAG-A 상품명 인식 (음절 n-gram 어휘 검색)

목적: 영수증 상품명("오감자")이 브랜드 상품인지 판별해서, 원재료명("감자")으로
붕괴시키지 않고 올바른 카테고리를 붙인다.

가드: 질의어가 생재료 일반명(감자·양파·우유·두부 등)이면 조회 자체를 스킵한다.
      마스터(유통바코드)에는 생재료가 단독 상품으로 없고 가공품 안에 부분문자열로만
      존재해서, 가드 없이는 "감자"가 "감자깡"에 매칭돼 생감자를 과자로 바꿔버린다.

build_product_index.py를 1회 실행해 data/product_*.{npy,json,jsonl}을 만들어둬야 한다.
"""
import json
import math
import os
import re
import threading
from collections import defaultdict

_DIR = os.path.join(os.path.dirname(__file__), "data")
_POST = os.path.join(_DIR, "product_postings.json")
_META = os.path.join(_DIR, "product_meta.jsonl")

N = 2

# ── 가드: 이 목록에 (사실상) 해당하면 RAG-A를 건너뛴다 ──────────────────────
# 신선 농·수·축산물 + 기본 조미/유제품 일반명. 영수증에 이 이름이 그대로 찍히면
# 그건 정말 그 재료다(브랜드 오인식이 아니다).
_RAW_INGREDIENTS = {
    # 채소
    "감자", "고구마", "양파", "대파", "쪽파", "마늘", "깐마늘", "생강", "당근", "무",
    "배추", "양배추", "브로콜리", "오이", "애호박", "호박", "가지", "파프리카", "피망",
    "고추", "청양고추", "상추", "시금치", "깻잎", "부추", "미나리", "쑥갓", "콩나물",
    "숙주", "버섯", "표고버섯", "느타리버섯", "팽이버섯", "새송이버섯", "양송이버섯",
    "토마토", "방울토마토", "옥수수", "단호박", "연근", "우엉", "도라지", "더덕",
    "목이버섯", "어린잎채소", "쌈채소", "샐러드채소", "모듬쌈",
    # 과일
    "사과", "배", "감", "귤", "감귤", "한라봉", "천혜향", "바나나", "포도", "청포도",
    "딸기", "블루베리", "키위",
    "오렌지", "레몬", "자몽", "참외", "수박", "멜론", "복숭아", "자두", "체리", "망고",
    "파인애플", "아보카도", "석류", "무화과",
    # 육류/수산(생물)
    "삼겹살", "목살", "항정살", "갈매기살", "front갈비", "돼지고기", "소고기", "쇠고기",
    "한우", "한돈", "닭고기", "닭가슴살", "닭다리", "닭날개", "오리고기", "계란", "달걀",
    "메추리알", "고등어", "갈치", "삼치", "조기", "임연수", "명태", "동태", "코다리",
    "새우", "오징어", "낙지", "쭈꾸미", "문어", "조개", "바지락", "홍합", "굴", "전복",
    "게", "꽃게", "대게", "연어", "참치",
    # 기본 유제품/두부
    "우유", "저지방우유", "멸균우유", "두유", "두부", "순두부", "연두부",
}

# 질의어 정규화(마스터 정규화와 대략 맞춘다)
_STRIP = re.compile(
    r'(\(주\)|㈜|주식회사|[\(\[].*?[\)\]]|\d[\d.,]*\s*(g|kg|ml|L|개|입|포|팩|봉|매|미)\b|'
    r'[^가-힣a-zA-Z0-9 ])', re.IGNORECASE)


def _clean(q: str) -> str:
    return re.sub(r'\s+', ' ', _STRIP.sub(' ', q or "")).strip()


def _to_ngrams(text: str, n: int = N) -> list[str]:
    cleaned = re.sub(r'[^가-힣a-zA-Z0-9]', '', text or "")
    if len(cleaned) < n:
        return [cleaned] if cleaned else []
    return [cleaned[i:i + n] for i in range(len(cleaned) - n + 1)]


_TRAIL_NUM = re.compile(r'\s*\d[\d.,x×*]*\s*$')  # "브로콜리 1", "딸기 4", "오이 3입" 등


def is_raw_ingredient(name: str) -> bool:
    base = _TRAIL_NUM.sub("", _clean(name)).strip()
    c = base.replace(" ", "")
    if c in _RAW_INGREDIENTS:
        return True
    # "국산 감자", "햇 양파", "냉동 새우", "제주 감귤" 처럼 수식어 + 생재료 한 단어
    toks = base.split()
    if toks and toks[-1] in _RAW_INGREDIENTS and len(toks) <= 3:
        return True
    # "감자 500", "양파 1" 처럼 생재료 + 숫자 (단위 이미 _clean에서 제거됨)
    if toks and toks[0] in _RAW_INGREDIENTS and len(toks) <= 2:
        return True
    return False


class ProductStore:
    _instance = None
    _lock = threading.Lock()

    def __init__(self):
        for p in (_POST, _META):
            if not os.path.exists(p):
                raise FileNotFoundError(
                    f"색인 없음: {p}\n먼저 build_product_index.py 실행")
        self.postings: dict[str, list] = json.load(open(_POST, encoding="utf-8"))
        self.meta = [json.loads(l) for l in open(_META, encoding="utf-8")]

    @classmethod
    def get(cls) -> "ProductStore":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        grams = _to_ngrams(_clean(query))
        if not grams:
            return []
        # 쿼리 bigram tf → L2 정규화
        qtf: dict[str, float] = defaultdict(float)
        for g in grams:
            qtf[g] += 1.0
        qnorm = math.sqrt(sum(v * v for v in qtf.values())) or 1.0

        scores: dict[int, float] = defaultdict(float)
        for g, qw in qtf.items():
            for doc_id, dw in self.postings.get(g, ()):  # dw는 이미 문서 L2 정규화됨
                scores[doc_id] += (qw / qnorm) * dw
        if not scores:
            return []
        top = sorted(scores.items(), key=lambda kv: -kv[1])[:top_k]
        return [{**self.meta[doc_id], "score": float(s)} for doc_id, s in top]


def lookup_product(raw_name: str, min_score: float = 0.55) -> dict | None:
    """브랜드 상품이면 {name, category_name, makers, score, source} 반환, 아니면 None.

    min_score=0.55: "오감자"→"오감자그라탕"(~0.63), "새우깡"→"새우깡"(1.0),
    "매콤한양파링"→"양파링"(~0.7)은 통과. 애매한 부분 겹침은 탈락.
    평가셋으로 튜닝 필요.
    """
    if not raw_name or is_raw_ingredient(raw_name):
        return None
    try:
        store = ProductStore.get()
    except FileNotFoundError as e:
        print(f"[RAG-A] {e}")
        return None

    hits = store.search(raw_name, top_k=5)
    if not hits or hits[0]["score"] < min_score:
        return None
    best = hits[0]
    return {
        "name": best["name"],
        "category_name": best["category_name"],
        "makers": best.get("makers", []),
        "score": round(best["score"], 3),
        "source": best.get("source", "barcode"),
    }


if __name__ == "__main__":
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "오감자"
    print(f"is_raw_ingredient({q!r}) = {is_raw_ingredient(q)}")
    r = lookup_product(q)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    try:
        print("--- top5 ---")
        for h in ProductStore.get().search(q):
            print(f"  {h['score']:.3f}  {h['name']}  [{h['category_name']}]")
    except FileNotFoundError as e:
        print(e)
