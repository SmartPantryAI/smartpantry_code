"""RAG-B 전후 정량 비교 (Step 6).

입력:
  eval/scan_items.jsonl    — scan_logs 최근 receipt 성공 30건에서 추출한 고유 품목 109개
  eval/ground_truth.jsonl  — 사람이 검수할 정답 소비기한(일) 초안

비교 대상:
  OLD = RAG-B 이전 로직 (git HEAD): 카테고리 무시 + _MFDS_USE_BY 첫 매칭, 없으면 storage 기본값
  NEW = 현재 calculate_use_by: 카테고리 게이트 + 최장 키워드 매칭 + RAG-B 폴백

지표:
  MAE(일), 중앙값 절대오차, 치명 오류율
    - UNDER100  : 실제 >=100일인데 예측 <=10일 (지시서 정의: 과소예측 → 멀쩡한 식품 폐기)
    - UNDER_R   : 예측 < 실제*0.34 이고 (실제-예측) >= 30 (과소예측, 완화 기준)
    - OVER_R    : 예측 > 실제*3   이고 (예측-실제) >= 30 (과대예측 → 상한 식품 섭취 위험)

사용:
  docker cp ai/rag/eval smartpantry-ai:/app/rag/eval   # (바인드 마운트면 불필요)
  docker exec -w /app smartpantry-ai python3 rag/eval/compare.py
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, "/app")
from pipeline_common import _STORAGE_DEFAULT_DAYS, calculate_use_by, RAG_AVAILABLE

HERE = os.path.dirname(__file__)
BASE = "2000-01-01"

# RAG-B 이전(git 774e568~bbf3c54) `_MFDS_USE_BY`를 원래 순서 그대로 동결한 것.
# OLD 기준선은 반드시 이 리스트로 "위에서부터 첫 매칭"해야 당시 동작과 일치한다
# (pipeline_common의 현재 테이블은 fresh/shelf-stable로 재정렬돼 순서가 다르다).
_OLD_MFDS_USE_BY = [
    (["발효유", "요거트", "요구르트"], 18),
    (["가공유", "딸기우유", "초코우유", "바나나우유"], 16),
    (["우유", "멸균우유"], 14),
    (["치즈", "체다", "모짜렐라"], 70),
    (["버터"], 180),
    (["생크림", "휘핑크림"], 14),
    (["두부"], 14),
    (["순두부"], 10),
    (["콩나물"], 5),
    (["숙주"], 4),
    (["어묵", "맛살", "게맛살"], 29),
    (["젓갈"], 60),
    (["김치", "겉절이"], 30),
    (["단무지", "장아찌", "피클"], 90),
    (["햄", "소시지", "비엔나"], 38),
    (["베이컨"], 30),
    (["스팸", "런천미트"], 365),
    (["다짐육", "간고기"], 2),
    (["삼겹살", "목살", "갈비", "불고기", "소고기", "돼지고기", "닭고기", "한우", "한돈"], 5),
    (["회", "활어", "생물"], 1),
    (["고등어", "갈치", "삼치", "조기", "생선"], 2),
    (["연어"], 3),
    (["새우", "오징어", "조개", "게", "어패"], 2),
    (["달걀", "계란", "특란", "메추리알"], 30),
    (["라면", "국수", "당면", "파스타", "스파게티"], 180),
    (["즉석밥", "햇반"], 270),
    (["냉동만두", "만두"], 270),
    (["참치캔", "통조림", "캔"], 365),
    (["간장", "된장", "고추장", "쌈장", "춘장"], 540),
    (["참기름", "들기름", "식용유", "올리브유"], 365),
    (["고춧가루", "소금", "설탕", "밀가루", "전분"], 365),
    (["케첩", "마요네즈", "소스", "드레싱"], 270),
    (["쌀", "현미", "잡곡", "보리", "콩"], 180),
    (["과자", "스낵", "크래커", "쿠키", "비스킷", "초콜릿"], 180),
    (["빵", "식빵", "베이글"], 5),
    (["견과류", "아몬드", "호두", "땅콩", "캐슈"], 180),
    (["생수", "물"], 365),
    (["탄산음료", "콜라", "사이다"], 270),
    (["주스", "음료"], 180),
    (["맥주"], 365),
    (["소주", "막걸리", "와인"], 365),
    (["상추", "시금치", "깻잎", "배추", "잎채소", "쌈채소"], 5),
    (["오이", "애호박", "호박", "가지", "파프리카", "고추"], 7),
    (["당근", "무", "양배추", "브로콜리"], 10),
    (["대파", "쪽파", "부추"], 7),
    (["버섯", "표고", "느타리", "팽이"], 7),
    (["딸기", "블루베리", "산딸기"], 4),
    (["복숭아", "자두", "포도", "체리"], 7),
    (["사과", "배", "감", "귤", "오렌지", "레몬", "자몽"], 14),
    (["바나나", "망고", "키위", "참외", "수박", "멜론"], 7),
    (["양파", "마늘", "감자", "고구마", "생강"], 21),
]


def _days(d):
    return (datetime.strptime(d, "%Y-%m-%d") - datetime.strptime(BASE, "%Y-%m-%d")).days


def old_calc(name, storage):
    for keywords, days in _OLD_MFDS_USE_BY:
        if any(kw in name for kw in keywords):
            if storage == "냉동":
                days = max(days, 90)
            return days
    return _STORAGE_DEFAULT_DAYS.get(storage, 7)


def new_calc(name, storage, category_name):
    d, ev = calculate_use_by(name, storage, BASE, category_name=category_name)
    return _days(d), ev


def load(fn):
    return [json.loads(l) for l in open(os.path.join(HERE, fn), encoding="utf-8")]


def metrics(rows, key):
    """rows: list of dict with true/old/new. key in {'old','new'}"""
    n = len(rows)
    aes = sorted(abs(r[key] - r["true"]) for r in rows)
    mae = sum(aes) / n
    med = aes[n // 2] if n % 2 else (aes[n // 2 - 1] + aes[n // 2]) / 2
    under100 = sum(1 for r in rows if r["true"] >= 100 and r[key] <= 10)
    under_r = sum(1 for r in rows if r[key] < r["true"] * 0.34 and (r["true"] - r[key]) >= 30)
    over_r = sum(1 for r in rows if r[key] > r["true"] * 3 and (r[key] - r["true"]) >= 30)
    return dict(n=n, mae=mae, med=med, under100=under100, under_r=under_r, over_r=over_r)


def fmt(m):
    return (f"n={m['n']:3d}  MAE={m['mae']:6.1f}일  중앙값AE={m['med']:5.1f}일  "
            f"UNDER100={m['under100']:2d} ({m['under100']/m['n']*100:4.1f}%)  "
            f"UNDER_R={m['under_r']:2d} ({m['under_r']/m['n']*100:4.1f}%)  "
            f"OVER_R={m['over_r']:2d} ({m['over_r']/m['n']*100:4.1f}%)")


def main():
    items = {(r["name"], r["storage"], r["category_name"]): r for r in load("scan_items.jsonl")}
    gt = load("ground_truth.jsonl")

    rows = []
    for g in gt:
        if g["conf"] == "exclude" or g["true_days"] is None:
            continue
        name, storage, cat = g["name"], g["storage"], g["category_name"]
        o = old_calc(name, storage)
        n, ev = new_calc(name, storage, cat)
        rows.append({
            "name": name, "storage": storage, "cat": cat, "conf": g["conf"],
            "true": g["true_days"], "old": o, "new": n,
            "new_basis": ev.get("basis"), "new_conf": ev.get("confidence"),
        })

    print(f"RAG_AVAILABLE={RAG_AVAILABLE}   평가 품목 수(exclude 제외)={len(rows)}\n")

    print("═══ 전체 ═══")
    print(f"  OLD  {fmt(metrics(rows, 'old'))}")
    print(f"  NEW  {fmt(metrics(rows, 'new'))}\n")

    hi = [r for r in rows if r["conf"] == "high"]
    print(f"═══ 고신뢰 라벨만 (conf=high, n={len(hi)}) ═══")
    print(f"  OLD  {fmt(metrics(hi, 'old'))}")
    print(f"  NEW  {fmt(metrics(hi, 'new'))}\n")

    print("═══ 카테고리별 MAE (OLD → NEW) ═══")
    cats = sorted(set(r["cat"] for r in rows), key=lambda c: c or "")
    for c in cats:
        sub = [r for r in rows if r["cat"] == c]
        mo, mn = metrics(sub, "old"), metrics(sub, "new")
        arrow = "↓개선" if mn["mae"] < mo["mae"] - 0.5 else ("↑악화" if mn["mae"] > mo["mae"] + 0.5 else "≈")
        print(f"  {str(c):14s} n={len(sub):3d}  MAE {mo['mae']:6.1f} → {mn['mae']:6.1f}  {arrow}")

    print("\n═══ 큰 변화 품목 (|OLD-NEW| >= 20일) ═══")
    big = sorted([r for r in rows if abs(r["old"] - r["new"]) >= 20], key=lambda r: -abs(r["old"] - r["new"]))
    print(f"  {'품목':16s} {'카테고리':12s} {'실제':>5s} {'OLD':>5s} {'NEW':>5s}  평가")
    for r in big:
        do, dn = abs(r["old"] - r["true"]), abs(r["new"] - r["true"])
        verdict = "NEW 개선" if dn < do - 3 else ("NEW 악화" if dn > do + 3 else "비슷")
        print(f"  {r['name'][:15]:16s} {str(r['cat'])[:11]:12s} {r['true']:5d} {r['old']:5d} {r['new']:5d}  {verdict} ({r['new_basis']})")

    print("\n═══ NEW에서 새로 생긴 치명 과대예측 (OVER_R, NEW만) ═══")
    for r in rows:
        o_over = r["old"] > r["true"] * 3 and (r["old"] - r["true"]) >= 30
        n_over = r["new"] > r["true"] * 3 and (r["new"] - r["true"]) >= 30
        if n_over and not o_over:
            print(f"  {r['name'][:15]:16s} 실제 {r['true']:4d} → NEW {r['new']:4d}  ({r['new_basis']}, conf={r['new_conf']})")

    print("\n═══ OLD에 있던 치명 과대예측 중 NEW가 고친 것 ═══")
    for r in rows:
        o_over = r["old"] > r["true"] * 3 and (r["old"] - r["true"]) >= 30
        n_over = r["new"] > r["true"] * 3 and (r["new"] - r["true"]) >= 30
        if o_over and not n_over:
            print(f"  {r['name'][:15]:16s} 실제 {r['true']:4d}  OLD {r['old']:4d} → NEW {r['new']:4d}  ({r['new_basis']})")


if __name__ == "__main__":
    main()
