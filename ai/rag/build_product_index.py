"""
ai/rag/build_product_index.py — RAG-A 상품 마스터 n-gram 역색인 빌드 (오프라인 1회).

음절 bigram 역색인(순수 stdlib, 수백 KB). 코사인 유사도.

**RAG-A는 "좁은 안전망"으로 재설계됨** (2026-08-30 평가 결과):
유통바코드 35k는 카테고리가 파이프라인 관례와 안 맞아 오분류를 유발 → 색인에서 뺀다.
기본 색인 = 손 큐레이션(product_master_curated.jsonl)만.
--with-barcode 를 주면 barcode도 합치지만, 그 경우 오탐이 늘 수 있다(평가로 확인 후 사용).

입력:
    data/product_master_curated.jsonl  — 손 큐레이션 (주 소스). {name, category_name, makers, source}
    data/barcode_products.jsonl        — I2570 유통바코드 (기본 미포함, --with-barcode 시만)
산출물:
    data/product_postings.json  — {bigram: [[doc_id, weight], ...]}  weight = tf / L2norm(doc)
    data/product_meta.jsonl     — doc_id 순서의 {name, category_name, makers, hrnk, source}
"""
import argparse
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from product_store import _RAW_INGREDIENTS  # noqa: E402  가드 대상 생재료명

_DIR = os.path.join(os.path.dirname(__file__), "data")
SRC_BARCODE = os.path.join(_DIR, "barcode_products.jsonl")
SRC_CURATED = os.path.join(_DIR, "product_master_curated.jsonl")
OUT_POST = os.path.join(_DIR, "product_postings.json")
OUT_META = os.path.join(_DIR, "product_meta.jsonl")

N = 2


def to_ngrams(text: str, n: int = N) -> list[str]:
    cleaned = re.sub(r'[^가-힣a-zA-Z0-9]', '', text or "")
    if len(cleaned) < n:
        return [cleaned] if cleaned else []
    return [cleaned[i:i + n] for i in range(len(cleaned) - n + 1)]


def load_rows(with_barcode: bool) -> list[dict]:
    rows: dict[str, dict] = {}
    n_barcode = 0
    if with_barcode and os.path.exists(SRC_BARCODE):
        for l in open(SRC_BARCODE, encoding="utf-8"):
            r = json.loads(l)
            r.setdefault("source", "barcode")
            rows[r["name"]] = r
            n_barcode += 1
    n_curated = 0
    if os.path.exists(SRC_CURATED):
        for l in open(SRC_CURATED, encoding="utf-8"):
            r = json.loads(l)
            if not r.get("name"):
                continue
            r["source"] = "curated"
            rows[r["name"]] = r  # 큐레이션이 barcode를 덮어씀
            n_curated += 1
    if not rows:
        raise SystemExit(f"입력 없음. {SRC_CURATED} 를 만드세요 (또는 --with-barcode).")

    # "이름이 곧 생재료명"인 항목 제거 (curated는 손으로 넣은 것이니 예외)
    dropped = [n for n, r in rows.items()
               if r.get("source") != "curated"
               and n.replace(" ", "") in _RAW_INGREDIENTS]
    for n in dropped:
        del rows[n]

    print(f"curated {n_curated}행" + (f" + barcode {n_barcode}행 (생재료명 {len(dropped)}건 제외)"
          if with_barcode else " (barcode 미포함)") + f" → 고유 {len(rows)}건")
    return list(rows.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-barcode", action="store_true",
                    help="유통바코드 35k도 색인에 포함(오탐 증가 가능, 평가 후 사용)")
    args = ap.parse_args()
    rows = load_rows(with_barcode=args.with_barcode)

    postings: dict[str, list] = defaultdict(list)
    for doc_id, r in enumerate(rows):
        tf = Counter(to_ngrams(r["name"]))
        if not tf:
            continue
        norm = math.sqrt(sum(c * c for c in tf.values())) or 1.0
        for g, c in tf.items():
            postings[g].append([doc_id, c / norm])

    json.dump(postings, open(OUT_POST, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    with open(OUT_META, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({
                "name": r["name"],
                "category_name": r.get("category_name"),
                "makers": r.get("makers", []),
                "hrnk": r.get("hrnk", ""),
                "source": r.get("source", "barcode"),
            }, ensure_ascii=False) + "\n")

    sz = os.path.getsize(OUT_POST) / 1e6
    print(f"완료: 문서 {len(rows)}, bigram {len(postings)}, "
          f"포스팅 {sum(len(v) for v in postings.values()):,}개, {sz:.1f}MB")
    print(f"  → {OUT_POST}\n  → {OUT_META}")


if __name__ == "__main__":
    main()
