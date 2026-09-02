"""
ai/rag/store.py — 소비기한 참고값 RAG 검색 (음절 n-gram 어휘 검색)

임베딩(nomic-embed-text)이 한국어를 처리하지 못해(diagnose_embed.py로 확인)
음절 n-gram 코사인 유사도 방식으로 전환했다. 외부 API 호출이 전혀 없다 —
색인이 이미 로컬 파일(.npy/.json)로 존재하므로 네트워크 지연/장애와 무관하게
동작한다.

사용 전 build_index.py를 1회 실행해서 data/shelf_life_vectors.npy,
data/shelf_life_vocab.json, data/shelf_life_meta.jsonl을 만들어둬야 한다.
"""
import json
import os
import re
import threading

import numpy as np

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
_VEC_PATH = os.path.join(_DATA_DIR, "shelf_life_vectors.npy")
_VOCAB_PATH = os.path.join(_DATA_DIR, "shelf_life_vocab.json")
_META_PATH = os.path.join(_DATA_DIR, "shelf_life_meta.jsonl")

N = 2  # build_index.py와 반드시 동일해야 함

STORAGE_COMPATIBLE = {
    "냉장": ["냉장", "냉동"],
    "냉동": ["냉동", "냉장"],
    "실온": ["실온"],
    None: ["실온", "냉장", "냉동"],
}


def _to_ngrams(text: str, n: int = N) -> list[str]:
    cleaned = re.sub(r'[^가-힣a-zA-Z0-9]', '', text)
    if len(cleaned) < n:
        return [cleaned] if cleaned else []
    return [cleaned[i:i + n] for i in range(len(cleaned) - n + 1)]


class ShelfLifeStore:
    _instance = None
    _lock = threading.Lock()

    def __init__(self):
        for p in (_VEC_PATH, _VOCAB_PATH, _META_PATH):
            if not os.path.exists(p):
                raise FileNotFoundError(
                    f"색인 파일이 없습니다: {p}\n먼저 build_index.py를 실행하세요."
                )
        self.vecs = np.load(_VEC_PATH)  # (N, V), 이미 L2 정규화됨
        self.vocab: dict[str, int] = json.load(open(_VOCAB_PATH, encoding="utf-8"))
        self.meta = [json.loads(l) for l in open(_META_PATH, encoding="utf-8")]
        assert len(self.meta) == self.vecs.shape[0], "벡터/메타 개수 불일치"

    @classmethod
    def get(cls) -> "ShelfLifeStore":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _vectorize_query(self, text: str) -> np.ndarray:
        """색인에 등장한 n-gram만 반영한 쿼리 벡터(어휘에 없는 n-gram은 무시)."""
        vec = np.zeros(len(self.vocab), dtype=np.float32)
        for g in _to_ngrams(text):
            idx = self.vocab.get(g)
            if idx is not None:
                vec[idx] += 1.0
        norm = np.linalg.norm(vec)
        return vec / norm if norm > 0 else vec

    def search(self, query_text: str, storage: str | None = None, top_k: int = 5) -> list[dict]:
        qvec = self._vectorize_query(query_text)
        if not np.any(qvec):
            return []  # 색인에 없는 문자로만 이루어진 쿼리 (전부 OOV)

        scores = self.vecs @ qvec
        order = np.argsort(-scores)

        compatible = STORAGE_COMPATIBLE.get(storage, STORAGE_COMPATIBLE[None])
        preferred, others = [], []
        for idx in order[: top_k * 6]:
            row = self.meta[int(idx)]
            hit = {**row, "score": float(scores[idx])}
            if scores[idx] <= 0:
                continue
            if storage and row.get("storage") == storage:
                preferred.append(hit)
            elif row.get("storage") in compatible:
                others.append(hit)

        return (preferred + others)[:top_k]


def lookup_shelf_life(query_text: str, storage: str | None = None,
                      min_score: float = 0.40) -> dict | None:
    """가장 유력한 소비기한 참고값 1건을 반환. 신뢰도가 낮으면 None.

    n-gram 코사인은 임베딩(0.55)보다 값의 분포가 다르므로 임계값을 낮게 잡았다
    (음절 겹침이 실제로 있을 때만 점수가 나오는 방식이라 애매한 매칭이 잘 안 남음).

    0.40은 RAG-B 평가에서 정한 값이다: 플래그십 케이스 "오감자"(0.404)는 살리되
    "올리브유→1020일"(0.389)·"탕수/마른멸치"(0.377) 같은 저신뢰 오매칭은 걸러낸다.
    이보다 높이면 "오감자"가 탈락하고, 낮추면 오매칭이 다시 들어온다.
    (0.44로 매칭되는 "고구마빵→잼"은 이 임계값으로 못 막는 잔여 케이스 — 상품명이
    스낵·과자로 잘못 분류된 상위 단계 문제라 calculate_use_by 폴백에 맡긴다.)
    """
    try:
        store = ShelfLifeStore.get()
    except FileNotFoundError as e:
        print(f"[RAG-B] {e}")
        return None

    hits = store.search(query_text, storage=storage, top_k=5)
    if not hits:
        return None

    best = hits[0]
    if best["score"] < min_score:
        return None

    return {
        "days": best["shelf_life_days"],
        "food_type": best.get("food_group_mid") or best.get("food_group_major"),
        "item_name": best.get("item_name"),
        "value_basis": best.get("value_basis"),
        "score": best["score"],
        "source": f"식약처 소비기한 참고값 - {best.get('food_type_no_base', best.get('food_type_no'))}",
    }


if __name__ == "__main__":
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "오감자 스낵 과자"
    st = sys.argv[2] if len(sys.argv) > 2 else "실온"
    result = lookup_shelf_life(q, storage=st)
    print(json.dumps(result, ensure_ascii=False, indent=2))
