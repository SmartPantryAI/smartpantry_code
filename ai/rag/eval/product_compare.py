"""RAG-A 카테고리 보정 효과 측정 (옵션 B: 최종 이름에 lookup_product 적용).

입력: eval/product_eval.jsonl  (영수증 고유항목 + gold_category 라벨)
비교: baseline(현재 저장 카테고리) vs B(임계값 t 이상 매칭 시 카테고리 덮어씀)

지표(garbage 제외):
  ACC     — 카테고리 정확도
  FIXED   — 저장이 틀렸는데 B가 gold로 고침
  BROKEN  — 저장이 맞았는데 B가 틀리게 바꿈  (← 이게 커지면 위험)
  FALSE_FIRE — 생재료(rag_should_fire=False)인데 RAG-A가 발동
  FIRED   — 전체 발동 건수

사용: python3 ai/rag/eval/product_compare.py
"""
import json
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))  # ai/rag
from product_store import lookup_product, is_raw_ingredient  # noqa: E402


def main():
    rows = [json.loads(l) for l in open(os.path.join(HERE, "product_eval.jsonl"), encoding="utf-8")]
    ev = [r for r in rows if r["conf"] != "garbage" and r["gold_category"] not in (None, "None")]
    n = len(ev)
    base_acc = sum(r["stored_category"] == r["gold_category"] for r in ev) / n

    print(f"평가 대상 {n}건 (garbage/None 제외)   baseline ACC = {base_acc:.3f}\n")
    print(f"{'t':>5} {'ACC':>7} {'ΔACC':>7} {'FIXED':>6} {'BROKEN':>7} {'FIRED':>6} {'FALSE_FIRE':>11}")
    print("-" * 56)

    for t in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]:
        correct = fixed = broken = fired = false_fire = 0
        details_fixed, details_broken = [], []
        for r in ev:
            hit = lookup_product(r["name"], min_score=t)
            pred = hit["category_name"] if hit else r["stored_category"]
            if hit:
                fired += 1
                if not r["rag_should_fire"]:
                    false_fire += 1
            if pred == r["gold_category"]:
                correct += 1
            if hit and r["stored_category"] != r["gold_category"] and pred == r["gold_category"]:
                fixed += 1
                details_fixed.append(r["name"])
            if hit and r["stored_category"] == r["gold_category"] and pred != r["gold_category"]:
                broken += 1
                details_broken.append((r["name"], r["stored_category"], pred))
        acc = correct / n
        print(f"{t:>5.2f} {acc:>7.3f} {acc-base_acc:>+7.3f} {fixed:>6} {broken:>7} {fired:>6} {false_fire:>11}")
        if t in (0.60, 0.65):
            for nm in details_fixed:
                print(f"        +fix  {nm}")
            for nm, s, p in details_broken:
                print(f"        -brk  {nm}: {s} → {p}")

    print("\n[참고] rag_should_fire=True인데 baseline이 이미 맞은 경우가 대부분이라")
    print("       ACC 상승폭은 작다. 핵심은 FIXED>BROKEN & FALSE_FIRE 최소 여부.\n")

    # ── 좁은 안전망 규칙 ─────────────────────────────────────────────────
    # override 조건: score≥0.80 정확 매칭 AND 저장=신선 카테고리 AND 큐레이션=가공 카테고리
    FRESH = {"채소류", "과일류", "육류", "수산물", "유제품·계란", "두부·콩류"}
    PROC = {"가공·즉석식품", "음료·주류", "양념·소스", "곡류·면류", "스낵·과자"}
    print("═══ 좁은 안전망 규칙 (score≥0.80 & 신선→가공 방향만) ═══")
    correct = fixed = broken = fired = false_fire = 0
    logs = []
    for r in ev:
        hit = lookup_product(r["name"], min_score=0.80)
        pred = r["stored_category"]
        if hit and r["stored_category"] in FRESH and hit["category_name"] in PROC:
            pred = hit["category_name"]
            fired += 1
            if not r["rag_should_fire"]:
                false_fire += 1
            tag = "fix" if (r["stored_category"] != r["gold_category"] and pred == r["gold_category"]) \
                else ("brk" if (r["stored_category"] == r["gold_category"] and pred != r["gold_category"])
                      else "neut")
            logs.append(f"  [{tag}] {r['name']:22s} {r['stored_category']} → {pred}  "
                        f"(gold {r['gold_category']}, score {hit['score']})")
            if tag == "fix":
                fixed += 1
            elif tag == "brk":
                broken += 1
        if pred == r["gold_category"]:
            correct += 1
    acc = correct / n
    for line in logs:
        print(line)
    print(f"\n  ACC {acc:.3f} ({acc-base_acc:+.3f})   FIRED {fired}   FIXED {fixed}   "
          f"BROKEN {broken}   FALSE_FIRE {false_fire}")


if __name__ == "__main__":
    main()
