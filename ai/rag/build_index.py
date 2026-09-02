"""
ai/rag/build_index.py — 소비기한 참고값 검색 색인 빌드 (오프라인 1회 실행)

** 임베딩 방식 폐기, 음절 n-gram 어휘 검색으로 전환 **
사유: 이 서버의 nomic-embed-text는 한국어를 처리하지 못한다(한글 입력이 전부
같은 <unk> 토큰으로 뭉개져 서로 다른 단어가 완전히 동일한 벡터로 나옴 —
diagnose_embed.py로 확인됨). 다국어 임베딩 모델(bge-m3 등)을 pull할 권한이
없는 상황이라, 외부 API 의존 없이 numpy만으로 되는 음절 n-gram 코사인 유사도로
전환한다. 한글은 토크나이저를 타지 않고 글자 그대로 비교하므로 이 문제가 없다.

실행:
    cd ai/rag
    python3 build_index.py   (네트워크 불필요, 즉시 완료)

산출물:
    data/shelf_life_vectors.npy   — (N, V) float32 카운트벡터(L2 정규화됨)
    data/shelf_life_vocab.json    — n-gram → 인덱스 매핑
    data/shelf_life_meta.jsonl    — 원본 메타데이터 (벡터와 같은 순서)
"""
import json
import os
import re
from collections import Counter

import numpy as np

SRC = os.path.join(os.path.dirname(__file__), "data", "shelf_life.jsonl")
OUT_VEC = os.path.join(os.path.dirname(__file__), "data", "shelf_life_vectors.npy")
OUT_VOCAB = os.path.join(os.path.dirname(__file__), "data", "shelf_life_vocab.json")
OUT_META = os.path.join(os.path.dirname(__file__), "data", "shelf_life_meta.jsonl")

N = 2  # 음절 n-gram 크기 (2 = bigram)

# 소비자 저장고(pantry) 도메인 밖의 식품유형은 색인에서 제외한다.
#   식품유형번호 대분류 10 = 특수영양식품(영·유아용 조제식, 체중조절식 등)
#   식품유형번호 대분류 11 = 특수의료용도식품("암환자용 식단형 식품" 등)
# → 냉동 탕수육/닭꼬치가 "암환자용 식단형 식품"과 글자만 겹쳐 708일로 오매칭되는
#   사례가 있었다(RAG-B 평가에서 확인).
# food_group_major 텍스트는 PDF 파싱 시 옆 칸 값으로 밀려 들어가는 경우가 있어
# (예: "암환자용..." 행의 major가 "12) 장류"로 잘못 찍힘) 신뢰할 수 없다.
# 대신 food_type_no_base 끝의 숫자 코드("... 11-3-3-1")에서 대분류 번호를 뽑는다.
_EXCLUDE_MAJOR_NOS = {10, 11}
_EXCLUDE_KEYWORDS = ("암환자용", "특수의료용도", "특수영양", "영·유아용", "영유아용", "체중조절")

_CODE_RE = re.compile(r'(\d+)(?:-\d+)*\s*$')


def _major_no(row: dict) -> int | None:
    for field in ("food_type_no_base", "food_type_no"):
        m = _CODE_RE.search(str(row.get(field) or ""))
        if m:
            return int(m.group(1))
    return None


def is_excluded(row: dict) -> bool:
    if _major_no(row) in _EXCLUDE_MAJOR_NOS:
        return True
    blob = f"{row.get('food_type_no_base','')} {row.get('food_type_no','')} {row.get('item_name','')}"
    return any(k in blob for k in _EXCLUDE_KEYWORDS)


def build_search_text(row: dict) -> str:
    parts = [
        row.get("food_group_mid") or row.get("food_group_major") or "",
        row.get("item_name") or "",
        row.get("description") or "",
    ]
    return " ".join(p for p in parts if p).strip()


def to_ngrams(text: str, n: int = N) -> list[str]:
    """공백/구두점 제거 후 음절 n-gram 추출. 한글·영문·숫자만 남긴다."""
    cleaned = re.sub(r'[^가-힣a-zA-Z0-9]', '', text)
    if len(cleaned) < n:
        return [cleaned] if cleaned else []
    return [cleaned[i:i + n] for i in range(len(cleaned) - n + 1)]


def main():
    all_rows = [json.loads(l) for l in open(SRC, encoding="utf-8")]
    rows = [r for r in all_rows if not is_excluded(r)]
    print(f"원본 {len(all_rows)}건 → 도메인 밖 {len(all_rows) - len(rows)}건 제외 → {len(rows)}건 색인")
    texts = [build_search_text(r) for r in rows]

    doc_ngrams = [to_ngrams(t) for t in texts]

    vocab: dict[str, int] = {}
    for grams in doc_ngrams:
        for g in grams:
            if g not in vocab:
                vocab[g] = len(vocab)

    print(f"문서 수: {len(rows)}, 어휘(n-gram) 수: {len(vocab)}")

    arr = np.zeros((len(rows), len(vocab)), dtype=np.float32)
    for i, grams in enumerate(doc_ngrams):
        c = Counter(grams)
        for g, cnt in c.items():
            arr[i, vocab[g]] = cnt

    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    arr = arr / norms

    np.save(OUT_VEC, arr)
    with open(OUT_VOCAB, "w", encoding="utf-8") as f:
        json.dump(vocab, f, ensure_ascii=False)
    with open(OUT_META, "w", encoding="utf-8") as f:
        for r, t in zip(rows, texts):
            r = dict(r)
            r["_search_text"] = t
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"완료: {arr.shape} 벡터 저장 → {OUT_VEC}")
    print(f"어휘 → {OUT_VOCAB}")
    print(f"메타데이터 → {OUT_META}")


if __name__ == "__main__":
    main()
