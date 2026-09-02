#!/usr/bin/env python3
"""
식품안전나라 I2570 유통바코드 전체 수집 — RAG-A 상품 마스터 v1.

전체 ~53,000행. 1,000건씩 페이징(약 54콜, 2분). 중단 시 이어받기.
인증키: ai/rag/.mfds_key (첫 줄에 키만)

산출물:
    ai/rag/data/barcode_products.jsonl   — 정규화 상품명별 1건 (카테고리는 다수결)
    ai/rag/data/barcode_hrnk_hist.tsv    — HRNK 분포 + 매핑 결과 (매핑 누락 확인용)
    ai/rag/data/barcode_rows_raw.jsonl   — 원본 행(정규화이름·HRNK 포함, 재매핑용)
    ai/rag/data/.barcode_progress
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(ROOT, "ai/rag/.mfds_key")
DATA_DIR = os.path.join(ROOT, "ai/rag/data")
OUT_PATH = os.path.join(DATA_DIR, "barcode_products.jsonl")
HIST_PATH = os.path.join(DATA_DIR, "barcode_hrnk_hist.tsv")
RAW_PATH = os.path.join(DATA_DIR, "barcode_rows_raw.jsonl")
PROG_PATH = os.path.join(DATA_DIR, ".barcode_progress")

SERVICE = "I2570"
PAGE = 1000
SLEEP = 0.2
MAX_RETRY = 5

# ── HRNK_PRDLST_NM(상위품목명) → SmartPantry 11개 카테고리 (정확 일치) ────────
HRNK_CATEGORY = {
    "과자류, 빵류 또는 떡류": "스낵·과자",
    "초콜릿류": "스낵·과자",
    "코코아가공품류": "스낵·과자",
    "빙과류": "스낵·과자",
    "당류": "스낵·과자",
    "올리고당류": "스낵·과자",
    "과당류": "스낵·과자",
    "엿류": "스낵·과자",
    "설탕류": "스낵·과자",
    "땅콩 또는 견과류가공품류": "스낵·과자",

    "다류": "음료·주류",
    "음료류": "음료·주류",
    "기타음료": "음료·주류",
    "과일.채소류음료": "음료·주류",
    "탄산음료류": "음료·주류",
    "발효음료류": "음료·주류",
    "두유류": "음료·주류",
    "인삼.홍삼제품류": "음료·주류",

    "면류": "곡류·면류",
    "밀가루류": "곡류·면류",
    "생식류": "곡류·면류",

    "장류": "양념·소스",
    "소스류": "양념·소스",
    "고춧가루 또는 실고추": "양념·소스",
    "식물성유지류": "양념·소스",
    "식용유지가공품": "양념·소스",
    "향신료가공품": "양념·소스",
    "식염": "양념·소스",
    "식초류": "양념·소스",
    "조미식품": "양념·소스",
    "잼류": "양념·소스",
    "카레(커리)": "양념·소스",

    "두부류 또는 묵류": "두부·콩류",

    "유가공품류": "유제품·계란",
    "알가공품류": "유제품·계란",

    "수산가공식품류": "가공·즉석식품",
    "기타식품류": "가공·즉석식품",
    "즉석섭취.편의식품류": "가공·즉석식품",
    "기타 농산가공품류": "가공·즉석식품",
    "절임류": "가공·즉석식품",
    "절임류 또는 조림류": "가공·즉석식품",
    "김치류": "가공·즉석식품",
    "젓갈류": "가공·즉석식품",
    "어육가공품류": "가공·즉석식품",
    "만두류": "가공·즉석식품",
    "건포류": "가공·즉석식품",
    "식육가공품 및 포장육": "가공·즉석식품",
    "동물성가공식품류": "가공·즉석식품",
    "농산가공식품류": "가공·즉석식품",
    "전분류": "가공·즉석식품",
}

# 도메인 밖 — 아예 버린다 (RAG-B와 동일 취지)
DROP_HRNK = {
    "특수영양식품", "특수의료용도등식품", "건강기능식품", "맞춤형 영양조제식품",
    "혼합제제류", "식품첨가물", "첨가물", "기타첨가물", "팽창제제",
    "기구등의 살균·소독제", "면류첨가알칼리제", "얼음류", "벌꿀류", "",
}

# 정규화: 제조사 접두 / 용량·규격 / 포장·묶음 / 군더더기 제거
_MAKER_PREFIX = re.compile(
    r'^\s*(\(주\)|㈜|주식회사|\(유\)|농업회사법인|영농조합법인)?\s*'
    r'(농심|오리온|롯데웰푸드|롯데제과|롯데|해태제과|해태|크라운제과|크라운|씨제이|CJ제일제당|CJ|'
    r'동원F&B|동원에프앤비|동원|오뚜기|풀무원|빙그레|남양유업|남양|매일유업|매일|서울우유|'
    r'삼양식품|삼양|팔도|대상|청정원|백설|hy|한국야쿠르트|이마트|홈플러스|홈에버)\s*[\)\]_]?\s*'
)
_TRAIL_SIZE = re.compile(
    r'\s*[\(\[/_]*\s*\d[\d.,]*\s*'
    r'(g|G|㎏|kg|KG|Kg|ml|ML|mL|L|리터|미|매|입|포|팩|봉|개|정|캡슐|EA|ea|P|pcs|년|호)\b.*$'
)
_PACK = re.compile(
    r'(미니팩|지퍼백|지퍼팩|지퍼|스탠드팩|파우치|스틱|낱개|기획팩|기획세트|기획|리필|증정|묶음|'
    r'멀티팩|번들|묶음팩|BOX|박스|세트|VINYL|FOIL\s*BAG|외박스|박스\)?|\*\s*\d+\s*(입|개|EA|ea)?)',
    re.IGNORECASE)
_PRICE = re.compile(r'[\(\[]?\s*\d{2,4}\s*원\s*[\)\]]?')
_JUNK = re.compile(r'(["“”\'`~｜|]|^\s*(신|구|NEW|new)\s*[\)\].]\s*|\s*[-–]\s*$|\s{2,})')


def normalize_name(prdt_nm: str) -> str:
    s = (prdt_nm or "").replace("　", " ").strip()
    for _ in range(4):
        s2 = _MAKER_PREFIX.sub("", s)
        s2 = _PRICE.sub(" ", s2)
        s2 = _TRAIL_SIZE.sub("", s2)
        s2 = _PACK.sub(" ", s2)
        s2 = _JUNK.sub(" ", s2)
        s2 = re.sub(r'\s{2,}', " ", s2).strip(" -–_/()[]")
        if s2 == s:
            break
        s = s2
    return s.strip()


def load_key():
    if not os.path.exists(KEY_PATH):
        sys.exit(f"인증키 파일 없음: {KEY_PATH}")
    k = open(KEY_PATH, encoding="utf-8").readline().strip()
    return k or sys.exit(f"{KEY_PATH} 비어 있음")


def fetch_page(key, start, end):
    url = (f"http://openapi.foodsafetykorea.go.kr/api/"
           f"{urllib.parse.quote(key)}/{SERVICE}/json/{start}/{end}")
    for attempt in range(1, MAX_RETRY + 1):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
            svc = body.get(SERVICE, {})
            code = svc.get("RESULT", {}).get("CODE", "")
            if code == "INFO-200":
                return [], None, True
            if code and code != "INFO-000":
                raise RuntimeError(f"{code}: {svc.get('RESULT', {}).get('MSG')}")
            tc = svc.get("total_count")
            return svc.get("row", []), int(tc) if tc else None, False
        except Exception as e:  # noqa: BLE001
            wait = min(2 ** attempt, 20)
            print(f"  ! {start}-{end} {e} — {wait}s 재시도 {attempt}/{MAX_RETRY}")
            time.sleep(wait)
    sys.exit(f"{start}-{end} 반복 실패")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--restart", action="store_true")
    args = ap.parse_args()
    os.makedirs(DATA_DIR, exist_ok=True)
    key = load_key()

    rows_raw = []          # {name, hrnk, prdlst, maker, report_no, barcode}
    start = 1
    if not args.restart and os.path.exists(PROG_PATH):
        prog = json.load(open(PROG_PATH, encoding="utf-8"))
        start = prog["next_start"]
        if os.path.exists(RAW_PATH):
            rows_raw = [json.loads(l) for l in open(RAW_PATH, encoding="utf-8")]
        print(f"이어받기: {start}부터, 기존 원본행 {len(rows_raw)}")
    else:
        for p in (OUT_PATH, HIST_PATH, RAW_PATH, PROG_PATH):
            if os.path.exists(p):
                os.remove(p)

    total = None
    t0 = time.time()
    while True:
        end = start + PAGE - 1
        rows, tc, eod = fetch_page(key, start, end)
        if tc:
            total = tc
        if eod or not rows:
            break
        for row in rows:
            norm = normalize_name(row.get("PRDT_NM"))
            if len(norm) < 2:
                continue
            rows_raw.append({
                "name": norm,
                "hrnk": row.get("HRNK_PRDLST_NM", ""),
                "prdlst": row.get("PRDLST_NM", ""),
                "maker": (row.get("CMPNY_NM") or "").strip(),
                "report_no": row.get("PRDLST_REPORT_NO", ""),
                "barcode": row.get("BRCD_NO", ""),
            })
        print(f"{end:>7,}/{total or '?'}  원본행 {len(rows_raw):>7,}")
        with open(RAW_PATH, "w", encoding="utf-8") as f:
            for r in rows_raw:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        json.dump({"next_start": end + 1}, open(PROG_PATH, "w"))
        start = end + 1
        if total and start > total:
            break
        time.sleep(SLEEP)

    # ── 집계: 정규화이름별 1건, 카테고리는 HRNK 다수결 ──────────────────
    hrnk_hist = Counter(r["hrnk"] for r in rows_raw)
    by_name: dict[str, dict] = {}
    for r in rows_raw:
        cat = HRNK_CATEGORY.get(r["hrnk"])
        if r["hrnk"] in DROP_HRNK:
            continue
        m = by_name.setdefault(r["name"], {
            "name": r["name"], "cat_votes": Counter(), "hrnk_votes": Counter(),
            "makers": set(), "report_nos": set(), "barcodes": 0, "examples": [],
        })
        if cat:
            m["cat_votes"][cat] += 1
        m["hrnk_votes"][r["hrnk"]] += 1
        if r["maker"]:
            m["makers"].add(r["maker"])
        if r["report_no"]:
            m["report_nos"].add(r["report_no"])
        m["barcodes"] += 1

    master = []
    for m in by_name.values():
        if not m["cat_votes"]:
            continue
        cat = m["cat_votes"].most_common(1)[0][0]
        master.append({
            "name": m["name"],
            "category_name": cat,
            "hrnk": m["hrnk_votes"].most_common(1)[0][0],
            "makers": sorted(m["makers"])[:3],
            "report_nos": sorted(m["report_nos"])[:3],
            "barcode_variants": m["barcodes"],
        })
    master.sort(key=lambda x: (x["category_name"], x["name"]))
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        for r in master:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    with open(HIST_PATH, "w", encoding="utf-8") as f:
        f.write("count\tcategory\thrnk_prdlst_nm\n")
        for h, c in hrnk_hist.most_common():
            tag = "DROP" if h in DROP_HRNK else (HRNK_CATEGORY.get(h) or "??미매핑??")
            f.write(f"{c}\t{tag}\t{h}\n")

    by_cat = Counter(r["category_name"] for r in master)
    unmapped = [(h, c) for h, c in hrnk_hist.items()
                if h not in DROP_HRNK and not HRNK_CATEGORY.get(h)]
    print(f"\n=== 완료: 마스터 {len(master):,}건 (원본 {len(rows_raw):,}행), {time.time()-t0:.0f}s ===")
    for c, n in by_cat.most_common():
        print(f"  {c:12s} {n:>6,}")
    if unmapped:
        print("  ── 미매핑 HRNK (규칙 추가 필요):")
        for h, c in sorted(unmapped, key=lambda x: -x[1]):
            print(f"     {c:>5,}  {h}")
    print(f"\n산출물: {OUT_PATH}\n       {HIST_PATH}\n       {RAW_PATH}")


if __name__ == "__main__":
    main()
