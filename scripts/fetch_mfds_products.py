#!/usr/bin/env python3
"""
식품(첨가물)품목제조보고(원재료) C002 수집 — RAG-A 상품 마스터 원본.

전체 107만 건 중, 식품유형(PRDLST_DCNM)이 SmartPantry 11개 카테고리에
매핑되는 것만 골라 저장한다. 1,000건씩 페이징, 중단 후 재시작 지원.

인증키: ai/rag/.mfds_key  (첫 줄에 키만)

사용:
    python3 scripts/fetch_mfds_products.py            # 이어받기(있으면)
    python3 scripts/fetch_mfds_products.py --restart  # 처음부터
    python3 scripts/fetch_mfds_products.py --limit 20000   # 앞부분만 (시험용)

산출물:
    ai/rag/data/products_raw.jsonl        — 채택된 상품 (report_no로 중복 병합)
    ai/rag/data/mfds_type_histogram.tsv   — 본 모든 식품유형 + 건수 + 매핑카테고리
    ai/rag/data/.fetch_progress           — 마지막으로 끝낸 위치(재시작용)
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(ROOT, "ai/rag/.mfds_key")
DATA_DIR = os.path.join(ROOT, "ai/rag/data")
OUT_PATH = os.path.join(DATA_DIR, "products_raw.jsonl")
HIST_PATH = os.path.join(DATA_DIR, "mfds_type_histogram.tsv")
PROG_PATH = os.path.join(DATA_DIR, ".fetch_progress")

SERVICE = "C002"
PAGE = 1000
SLEEP = 0.25          # 요청 간 간격(초)
MAX_RETRY = 5

# ── 식품유형(PRDLST_DCNM) → SmartPantry 11개 카테고리 ─────────────────────
# PRDLST_DCNM 안에 아래 부분문자열이 들어 있으면 그 카테고리로 채택.
# 위에서부터 먼저 맞는 카테고리가 이긴다(두부·유제품을 가공식품보다 먼저 둔 이유).
# 신선 채소·과일·육류·수산물 원물은 품목제조보고 대상이 아니라 거의 안 잡힌다 —
# RAG-A 마스터는 사실상 가공/브랜드 상품(브랜드명≠원재료명 문제가 있는 쪽)을 겨냥한다.
CATEGORY_RULES = [
    ("유제품·계란", ["우유류", "가공유", "발효유", "치즈", "버터", "유크림", "분유",
                   "연유", "유가공품", "유청", "알가공품", "난백", "전란", "난황"]),
    ("두부·콩류", ["두부", "묵류", "두류가공품", "장류제조용", "된장분말"]),
    ("곡류·면류", ["면류", "국수", "냉면", "유탕면", "건면", "생면", "숙면", "당면",
                 "곡류가공품", "곡분", "시리얼", "즉석섭취·편의식품류(밥류", "밥류",
                 "미숫가루", "선식"]),
    ("스낵·과자", ["과자", "캔디", "츄잉껌", "껌", "초콜릿", "코코아", "빙과", "아이스크림",
                 "빵류", "떡류", "튀김식품"]),
    ("음료·주류", ["음료", "다류", "커피", "액상차", "고형차", "인삼", "홍삼",
                 "주류", "탁주", "약주", "청주", "맥주", "과실주", "소주", "위스키",
                 "브랜디", "일반증류주", "리큐르", "발효주", "두유"]),
    ("양념·소스", ["소스", "드레싱", "마요네즈", "케첩", "복합조미", "조미식품", "향신료",
                 "카레", "식초", "식용유", "참기름", "들기름", "향미유", "당류", "설탕",
                 "물엿", "당시럽", "포도당", "과당", "올리고당", "잼", "식염", "천일염",
                 "정제소금", "장류", "된장", "고추장", "간장", "춘장", "쌈장",
                 "고춧가루", "혼합장"]),
    ("가공·즉석식품", ["즉석조리식품", "즉석섭취식품", "간편조리세트", "만두", "국·탕",
                    "찌개", "카레·짜장", "어육", "연육", "맛살", "어묵", "젓갈",
                    "절임", "김치", "짠지", "장아찌", "통조림", "병조림", "레토르트",
                    "식육", "햄", "소시지", "베이컨", "건포", "건조저장육", "육포",
                    "분쇄가공육", "양념육", "포장육", "식육추출가공품", "서류가공품",
                    "전분", "과·채가공품", "과채가공품", "농산가공", "버섯가공",
                    "견과류가공품", "땅콩버터", "밤·대추", "옥수수", "감자"]),
]


def load_key():
    if not os.path.exists(KEY_PATH):
        sys.exit(f"인증키 파일이 없습니다: {KEY_PATH}\n첫 줄에 키만 넣어 저장하세요.")
    with open(KEY_PATH, encoding="utf-8") as f:
        k = f.readline().strip()
    if not k:
        sys.exit(f"{KEY_PATH} 가 비어 있습니다.")
    return k


def map_category(prdlst_dcnm: str) -> str | None:
    t = prdlst_dcnm or ""
    for cat, subs in CATEGORY_RULES:
        if any(s in t for s in subs):
            return cat
    return None


def fetch_page(key: str, start: int, end: int) -> dict:
    url = (f"http://openapi.foodsafetykorea.go.kr/api/"
           f"{urllib.parse.quote(key)}/{SERVICE}/json/{start}/{end}")
    last_err = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
            svc = body.get(SERVICE, {})
            code = svc.get("RESULT", {}).get("CODE", "")
            if code and code not in ("INFO-000",):
                # INFO-200 = 해당하는 데이터가 없음 (마지막 페이지 지나침)
                if code == "INFO-200":
                    return {"rows": [], "total": None, "eod": True}
                raise RuntimeError(f"API {code}: {svc.get('RESULT', {}).get('MSG')}")
            total = svc.get("total_count")
            return {"rows": svc.get("row", []),
                    "total": int(total) if total else None, "eod": False}
        except Exception as e:  # noqa: BLE001
            last_err = e
            wait = min(2 ** attempt, 30)
            print(f"  ! {start}-{end} 실패({e}) — {wait}s 후 재시도 {attempt}/{MAX_RETRY}")
            time.sleep(wait)
    raise RuntimeError(f"{start}-{end} {MAX_RETRY}회 실패: {last_err}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--restart", action="store_true", help="진행상황 무시하고 처음부터")
    ap.add_argument("--limit", type=int, default=0, help="이 위치까지만 수집(시험용)")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    key = load_key()

    # 이어받기: 기존 산출물 로드
    kept: dict[str, dict] = {}
    type_hist: Counter = Counter()
    type_cat: dict[str, str | None] = {}
    start = 1
    if not args.restart and os.path.exists(PROG_PATH):
        with open(PROG_PATH, encoding="utf-8") as f:
            prog = json.load(f)
        start = prog.get("next_start", 1)
        type_hist.update(prog.get("type_hist", {}))
        type_cat.update(prog.get("type_cat", {}))
        if os.path.exists(OUT_PATH):
            with open(OUT_PATH, encoding="utf-8") as f:
                for line in f:
                    r = json.loads(line)
                    kept[r["report_no"]] = r
        print(f"이어받기: {start}부터, 기존 채택 {len(kept)}건")
    else:
        for p in (OUT_PATH, HIST_PATH, PROG_PATH):
            if os.path.exists(p):
                os.remove(p)

    total = None
    t0 = time.time()
    while True:
        end = start + PAGE - 1
        if args.limit and start > args.limit:
            print(f"--limit {args.limit} 도달, 중단")
            break
        res = fetch_page(key, start, end)
        if res["total"]:
            total = res["total"]
        rows = res["rows"]
        if res["eod"] or not rows:
            print("마지막 페이지 도달")
            break

        for row in rows:
            dcnm = row.get("PRDLST_DCNM", "")
            type_hist[dcnm] += 1
            if dcnm not in type_cat:
                type_cat[dcnm] = map_category(dcnm)
            cat = type_cat[dcnm]
            if not cat:
                continue
            rno = row.get("PRDLST_REPORT_NO", "")
            name = (row.get("PRDLST_NM") or "").strip()
            if not rno or not name:
                continue
            raw = (row.get("RAWMTRL_NM") or "").strip()
            if rno in kept:
                # 같은 품목의 원재료가 여러 행에 나뉜 경우 이어붙임
                prev = kept[rno]["raw_materials"]
                if raw and raw not in prev:
                    kept[rno]["raw_materials"] = (prev + ", " + raw).strip(", ")
            else:
                kept[rno] = {
                    "report_no": rno,
                    "name": name,
                    "food_type": dcnm,
                    "category_name": cat,
                    "maker": (row.get("BSSH_NM") or "").strip(),
                    "report_date": row.get("PRMS_DT", ""),
                    "raw_materials": raw,
                }

        done = end
        pct = f"{done/total*100:.1f}%" if total else "?"
        rate = done / max(time.time() - t0, 1)
        eta = (total - done) / rate / 60 if total else 0
        print(f"{done:>9,}/{total or '?':>9} ({pct})  채택 {len(kept):>6,}  "
              f"유형 {len(type_hist):>3}  ETA {eta:4.0f}분")

        # 체크포인트(페이지마다)
        with open(OUT_PATH, "w", encoding="utf-8") as f:
            for r in kept.values():
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        with open(PROG_PATH, "w", encoding="utf-8") as f:
            json.dump({"next_start": end + 1,
                       "type_hist": dict(type_hist),
                       "type_cat": type_cat}, f, ensure_ascii=False)

        start = end + 1
        if total and start > total:
            break
        time.sleep(SLEEP)

    # 유형 히스토그램 출력
    with open(HIST_PATH, "w", encoding="utf-8") as f:
        f.write("count\tcategory\tfood_type\n")
        for t, c in type_hist.most_common():
            f.write(f"{c}\t{type_cat.get(t) or '-'}\t{t}\n")

    by_cat = Counter(r["category_name"] for r in kept.values())
    print(f"\n=== 완료: 채택 {len(kept):,}건 / 전체 {total:,}건 ===")
    for c, n in by_cat.most_common():
        print(f"  {c:12s} {n:>7,}")
    unmapped = sum(v for t, v in type_hist.items() if not type_cat.get(t))
    print(f"  (매핑 안 됨: 유형 {sum(1 for t in type_hist if not type_cat.get(t))}종 / {unmapped:,}건)")
    print(f"\n산출물: {OUT_PATH}\n       {HIST_PATH}")


if __name__ == "__main__":
    main()
