import json, cv2
import numpy as np
from datetime import date

from pipeline_common import (
    MODEL, encode_image, fix_exif_rotation, VALID_UNITS,
    is_valid_date, parse_llm_json, stream_llm, pass2_normalize
)

"""
PASS1_PROMPT — 20종 영수증 패턴 분석 반영 (최종)

분석한 영수증 출처:
  - 일반 마트 (별표* 형식)
  - HMP마트 (번호+불릿• 형식)
  - 주류마트 (NO. + 바코드 별도줄)
  - 농협 (P코드 형식)
  - 이마트/할인마트 (번호없음)
  - 지구마트 (품명/수/금액 심플)
  - 해피유통/푸르너/신비로마트 (NO. + 바코드 같은줄)
  - 다온마트 (번호없음 심플)
  - 식당 영수증 (한도니, J House)
  - 카페/베이커리 (타르틴베이커리)
"""

PASS1_PROMPT = """너는 한국 영수증 OCR 전문가다. 생각하지 말고 바로 JSON만 출력해라.

할 일은 딱 두 가지다:
1. 영수증에서 구매/판매 날짜를 찾아 YYYY-MM-DD 형식으로 변환
2. 식품/식재료 상품명과 수량을 영수증에 인쇄된 그대로 읽기

[가장 중요한 원칙]
- 너의 역할은 '전사(transcription)'다. 글자가 흐리거나 깨져 보여도 추측해서
  다른 상품명으로 바꾸지 마라. 보이는 글자를 그대로 적어라.
  맞춤법/오인식 교정은 다음 단계에서 처리한다.
- 영수증에 없는 상품을 절대 만들어내지 마라(환각 금지).

[날짜 변환]
아래 키워드 뒤에 오는 날짜를 찾는다:
  판매일, 판매일자, 매출일, 거래일시, 거래일자, 일시, 영수일자, 결제일시
- "2026-04-22 11:45"        → "2026-04-22"
- "25-10-24 13:38"          → "2025-10-24"  (YY → 20YY)
- "26-04-12 14:59,일요일"   → "2026-04-12"
- "2026/04/22"              → "2026-04-22"
- "매출일 2025-06-25 13:32" → "2025-06-25"
- 날짜 없으면 "unknown"

[영수증 형식별 읽기 규칙]

형식1 — 별표(*) 접두사 (마트):
  "*깻잎           2,500  1   2,500"  → name:"깻잎", qty:1
  다음 줄의 6자리 이하 숫자(상품코드)는 무시

형식2 — 번호+불릿(•) 접두사:
  "01• 양다리훈합 닭다리  6,000  1"   → name:"양다리훈합 닭다리", qty:1
  번호와 •는 제거, 상품명만 추출

형식3 — NO./번호 + 바코드 별도줄 (지역마트):
  "001 시금치/국산 1단"
  "22207505  495  2  990"             → name:"시금치 1단", qty:2
  바코드(7자리 이상 숫자)줄에서 수량 추출, 바코드 제거

형식4 — P코드 접두사 (농협):
  "001 P 국모닝우유 900ML  [2,150]"   → name:"국모닝우유 900ML", qty:1
  번호와 "P " 제거, 상품명만 추출

형식5 — 번호없음 심플 (지구마트/다온마트):
  "한우 안심 1kg      1    62,900"    → name:"한우 안심 1kg", qty:1
  "대림)알뜰어묵사  2,580  1  2,580"  → name:"대림)알뜰어묵사", qty:1

형식6 — 번호없음 + 바코드 별도줄 (이마트/할인마트):
  "어메이징닭강정"
  "2452480139803  13,980  1  13,980"  → name:"어메이징닭강정", qty:1

형식7 — 6자리 상품코드 (카페/베이커리):
  "002177  우유"
  "3,000   2개   0   6,000"           → name:"우유", qty:2
  6자리 숫자 코드 제거, 수량이 "N개" 형식일 수 있음

형식8 — 편의점 (CU/GS25/세븐일레븐/이마트24/미니스톱):
  상품명·단가·수량·금액이 한 줄 또는 두 줄로 나뉜다.
  "삼각김밥전주비빔  1,300  1  1,300"  → name:"삼각김밥전주비빔", qty:1
  "서울우유1A 1L      2,900  2  5,800" → name:"서울우유1A 1L", qty:2
  - "행사", "1+1", "2+1", "덤", "증정" 표기는 name에서 제거하되,
    아래 [증정/덤 수량 규칙]에 따라 수량에 반영한다.

[증정/덤 수량 규칙]
편의점 1+1·2+1은 같은 상품이 '구매분'과 '증정분'으로 따로 찍힌다.
실제 냉장고에 들어가는 총 개수를 기록하는 것이 목적이므로,
같은 상품의 증정/덤 줄은 그 상품의 qty에 더한다.
  예) "참이슬 1,900 1" + "참이슬(증정) 0 1" → name:"참이슬", qty:2
증정분 단가가 0원이라도 수량은 합산한다.

[괄호/옵션/원산지 처리]
- 괄호 안 내용은 상품명에 포함
  예) "무항생제 특란 (30구)"    → "무항생제 특란 (30구)"
- /원산지 표기 중 단순 원산지(국산 등)는 제거, 품질 의미(제주산 등)는 유지
  예) "시금치/국산 1단"         → "시금치 1단"
  예) "제주산 은갈치(대)"       → "제주산 은갈치(대)"

[식당/카페 영수증 처리]
- 오믈렛, 스크램블, 샌드위치, 팬케이크 등 조리 음식은 제외
- (신규), (추가) 접두사는 제거하고 식재료로 처리
  예) "(신규)생삼겹살" → name:"생삼겹살", qty:2

[반드시 제외할 줄]
- 할인 줄: 할인금액, 특매할인, e날특가, 행사할인, (*)표시 할인
- 묶음행사 안내문: "컵라면3개구매33%", "조)파스타소스행사" 등 (실제 상품 줄이 아님)
- 합계/세금: 소계, 합계, 합 계, 과세물품, 면세물품, 부가세, 받을금액, 결제대상금액
- 카드/결제: 카드번호, 승인번호, 신용카드지불, 포인트적립
- 바코드/상품코드만 있는 줄

[수량 추출 규칙]
- "N개" 형식도 수량으로 인식: "1개"→1, "2개"→2
- 수량 컬럼명이 "수" 또는 "수량" 모두 인식
- 묶음 표기가 있어도 실제 구매 수량만 기록
  예) "제주 삼다수 2L   6   6,480"    → qty:6

[영문 코드/브랜드 처리]
- HMP, GSI, B3, CJ 등 영문 코드는 그대로 유지(교정은 다음 단계)
  예) "HMPIA우유1L"          → name:"HMPIA우유1L"
  예) "CJ 스팸 클래식 200g"  → name:"CJ 스팸 클래식 200g"

[무게/용량(unit) 추출 규칙]
상품명에 무게/부피 표기(g, kg, ml, mL, L)가 보이면 숫자와 단위를 별도 필드로 추출한다.
- kg→g(×1000), L→ml(×1000), mL/ml→그대로. unit은 "g" 또는 "ml"로 정규화.
- 추출한 무게/용량 값을 그 상품의 qty로 사용한다(수량 컬럼과 무관).
  예) "고추장 500g  ... 1 ..." → name:"고추장 500g", qty:500, unit:"g"
  예) "국모닝우유 900ML [2,150]" → name:"국모닝우유 900ML", qty:900, unit:"ml"
- name은 영수증 원문 표기를 그대로 유지(무게 표기 제거는 다음 단계).
- 무게/부피 표기가 없으면 qty는 수량 컬럼 값, unit은 null.

출력 스키마:
{
  "purchase_date": "YYYY-MM-DD 또는 unknown",
  "items": [
    {"name": "영수증 원문 그대로 (정제 후)", "qty": 1, "unit": "g | ml | null"}
  ]
}
JSON만 출력.
"""


def _crop_receipt(img: np.ndarray) -> np.ndarray:
    """
    영수증 윤곽을 감지해서 크롭 후 확대.
    감지 실패 시 원본 반환.
    """
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edged   = cv2.Canny(blurred, 30, 150)

        kernel  = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        dilated = cv2.dilate(edged, kernel, iterations=2)

        contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            print("[크롭] 윤곽선 없음 → 원본 사용")
            return img

        largest  = max(contours, key=cv2.contourArea)
        img_area = img.shape[0] * img.shape[1]

        if cv2.contourArea(largest) < img_area * 0.10:
            print("[크롭] 영수증 감지 실패 (면적 너무 작음) → 원본 사용")
            return img

        x, y, w, h = cv2.boundingRect(largest)
        pad = 20
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(img.shape[1], x + w + pad)
        y2 = min(img.shape[0], y + h + pad)
        cropped = img[y1:y2, x1:x2]

        crop_area = (x2 - x1) * (y2 - y1)
        if crop_area < img_area * 0.30:
            print("[크롭] 크롭 결과 너무 작음 → 원본 사용")
            return img

        print(f"[크롭] 성공: {img.shape[1]}x{img.shape[0]} → {x2-x1}x{y2-y1}")
        return cropped

    except Exception as e:
        print(f"[크롭] 오류 → 원본 사용: {e}")
        return img


def _upscale(img: np.ndarray, target_width: int = 1200) -> np.ndarray:
    """
    이미지가 target_width보다 작으면 확대.
    이미 충분히 크면 그대로 반환.
    """
    h, w = img.shape[:2]
    if w >= target_width:
        return img
    scale    = target_width / w
    new_w    = int(w * scale)
    new_h    = int(h * scale)
    upscaled = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
    print(f"[업스케일] {w}x{h} → {new_w}x{new_h}")
    return upscaled


def _binarize(img: np.ndarray) -> np.ndarray:
    """
    적응형 이진화로 배경 제거, 글자만 선명하게.
    조명이 불균일해도 잘 동작하는 adaptive threshold 사용.
    실패 시 원본 반환.
    """
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 노이즈 제거
        gray = cv2.fastNlMeansDenoising(gray, h=10)

        # 적응형 이진화 (조명 불균일에 강함)
        binary = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=15,   # 주변 픽셀 블록 크기 (홀수)
            C=8             # 평균에서 뺄 상수 (클수록 더 많이 이진화)
        )

        # BGR로 다시 변환 (LLM에 컬러로 전달)
        result = cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)
        print("[이진화] 완료")
        return result

    except Exception as e:
        print(f"[이진화] 오류 → 원본 사용: {e}")
        return img


def _preprocess_for_ocr(img: np.ndarray) -> np.ndarray:
    # 1. 영수증 크롭
    img = _crop_receipt(img)

    # 2. 업스케일 (글자가 작으면 확대)
    img = _upscale(img, target_width=1200)

    # 3. CLAHE 대비 향상
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    img = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

    # 4. 샤프닝
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    img = cv2.filter2D(img, -1, kernel)

    # # 5. 이진화 (배경 제거, 글자만 선명하게)
    # img = _binarize(img)

    return img


def _pass1_ocr(img: np.ndarray, fallback_date: str) -> dict:
    img_b64 = encode_image(img, max_width=1500)

    payload = {
        "model": MODEL,
        "think": False,
        "messages": [
            {"role": "system", "content": PASS1_PROMPT},
            {
                "role": "user",
                "content": "이 영수증의 날짜와 상품 목록을, 영수증에 적힌 무게/용량 표기(예: 500g, 1kg, 1L)가 있으면 함께 읽어줘.",
                "images": [img_b64]
            }
        ],
        "format": "json",
        "stream": True,
        "options": {"temperature": 0, "num_predict": 2048}
    }

    raw_text = stream_llm(payload)
    result   = parse_llm_json(raw_text)

    purchase_date = (result.get("purchase_date") or "").strip()
    if purchase_date == "unknown" or not is_valid_date(purchase_date):
        purchase_date = fallback_date

    items = []
    for it in result.get("items", []):
        if isinstance(it, str):
            it = {"name": it, "qty": 1}
        if not isinstance(it, dict):
            continue
        name = (it.get("name") or "").strip()
        if not name:
            continue
        # 이름 기반 휴리스틱/포장단위 환산은 2pass(pass2_normalize)에서 한 번만 적용한다.
        # 여기서는 LLM이 실제로 읽어낸 무게/용량 표기만 유효성 검증해서 넘긴다 —
        # 미리 추측값을 채우면 "망"/"포대"처럼 무게 표기 유무로 분기하는 2pass 로직이 깨진다.
        unit = (it.get("unit") or "").strip()
        items.append({
            "name": name,
            "qty": float(it.get("qty") or 1),
            "unit": unit if unit in VALID_UNITS else None,
        })

    return {"purchase_date": purchase_date, "items": items}


def process_receipt_image(img_path: str) -> dict:
    fallback_date = date.today().strftime("%Y-%m-%d")
    img     = fix_exif_rotation(img_path)
    img_ocr = _preprocess_for_ocr(img)

    print("[영수증 모드] OCR 시작 (1pass)...")
    pass1         = _pass1_ocr(img_ocr, fallback_date)
    purchase_date = pass1["purchase_date"]
    raw_items     = pass1["items"]
    print(f"  구매일: {purchase_date}")
    print(f"  원문 상품 수: {len(raw_items)}개")

    if not raw_items:
        return {"source": "receipt_ocr", "purchase_date": purchase_date, "items": []}

    print("[영수증 모드] 정규화 중 (2pass)...")
    items = pass2_normalize(purchase_date, raw_items, fallback_date)
    print(f"  정규화 완료: {len(items)}개")

    return {
        "source":        "receipt_ocr",
        "purchase_date": purchase_date,
        "items":         items
    }


if __name__ == "__main__":
    import sys
    img_path = sys.argv[1] if len(sys.argv) > 1 else "input.jpg"
    result   = process_receipt_image(img_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))