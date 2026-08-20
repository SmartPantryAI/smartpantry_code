import base64, tempfile, os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from food_pipeline import process_food_image
from receipt_pipeline import process_receipt_image
from food_llm_pipeline import process_food_llm


app = FastAPI()

_raw_origins = os.getenv("ALLOWED_ORIGINS", "")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()] or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

EMOJI_MAP = {
    # ── 채소류 ──
    "양파": "🧅", "마늘": "🧄", "당근": "🥕", "감자": "🥔", "고구마": "🍠",
    "배추": "🥬", "상추": "🥗", "시금치": "🌿", "브로콜리": "🥦", "오이": "🥒",
    "토마토": "🍅", "호박": "🎃", "애호박": "🥒", "단호박": "🎃",
    "파": "🌿", "대파": "🌿", "쪽파": "🌿", "부추": "🌿",
    "버섯": "🍄", "표고버섯": "🍄", "느타리버섯": "🍄", "팽이버섯": "🍄", "새송이버섯": "🍄",
    "콩나물": "🌱", "숙주": "🌱", "두부": "🫘", "순두부": "🫘",
    "고추": "🌶️", "청양고추": "🌶️", "피망": "🫑", "파프리카": "🫑",
    "무": "🥬", "연근": "🍡", "우엉": "🌿",
    "양배추": "🥬", "적양배추": "🥬", "깻잎": "🌿", "미나리": "🌿",
    "셀러리": "🥬", "아스파라거스": "🌿", "가지": "🍆", "옥수수": "🌽",
    "비트": "🫛", "콜리플라워": "🥦",
    "오크라": "🫛", "콩": "🫘", "완두콩": "🫛", "강낭콩": "🫘",

    # ── 과일류 ──
    "사과": "🍎", "배": "🍐", "바나나": "🍌", "딸기": "🍓", "포도": "🍇",
    "수박": "🍉", "참외": "🍈", "복숭아": "🍑", "귤": "🍊", "오렌지": "🍊",
    "레몬": "🍋", "라임": "🍋", "망고": "🥭", "키위": "🥝", "자몽": "🍊",
    "블루베리": "🫐", "체리": "🍒", "파인애플": "🍍", "멜론": "🍈",
    "감": "🍊", "유자": "🍋", "석류": "🍎", "무화과": "🍑",
    "아보카도": "🥑", "코코넛": "🥥", "두리안": "🍈", "리치": "🍑",
    "자두": "🍑", "살구": "🍑", "모과": "🍐", "한라봉": "🍊",

    # ── 육류 ──
    "소고기": "🥩", "한우": "🥩", "돼지고기": "🥩", "한돈": "🥩",
    "닭고기": "🍗", "닭": "🍗", "오리고기": "🍗", "양고기": "🥩",
    "삼겹살": "🥓", "목살": "🥩", "갈비": "🍖", "불고기": "🥩",
    "안심": "🥩", "등심": "🥩", "차돌박이": "🥩", "사태": "🥩",
    "닭가슴살": "🍗", "닭다리": "🍗", "닭날개": "🍗",
    "베이컨": "🥓", "햄": "🥩", "소시지": "🌭", "비엔나": "🌭",
    "스팸": "🥫", "런천미트": "🥫", "리챔": "🥫",

    # ── 수산물 ──
    "생선": "🐟", "연어": "🐟", "참치": "🐟", "고등어": "🐟",
    "갈치": "🐟", "삼치": "🐟", "조기": "🐟", "광어": "🐟",
    "새우": "🦐", "오징어": "🦑", "낙지": "🐙", "문어": "🐙",
    "게": "🦀", "꽃게": "🦀", "대게": "🦀", "킹크랩": "🦀",
    "조개": "🐚", "바지락": "🐚", "홍합": "🐚", "굴": "🐚",
    "전복": "🐚", "소라": "🐚", "가리비": "🐚",
    "어묵": "🍢", "맛살": "🍢", "게맛살": "🍢",
    "김": "🌿", "미역": "🌿", "다시마": "🌿", "톳": "🌿",
    "멸치": "🐟", "북어": "🐟", "황태": "🐟", "명태": "🐟",
    "임연수": "🐟", "아귀": "🐟", "장어": "🐟", "뱀장어": "🐟",

    # ── 유제품·계란 ──
    "우유": "🥛", "달걀": "🥚", "계란": "🥚", "메추리알": "🥚",
    "치즈": "🧀", "체다": "🧀", "모짜렐라": "🧀", "버터": "🧈",
    "요거트": "🥛", "요구르트": "🥛", "생크림": "🥛", "휘핑크림": "🥛",

    # ── 두부·콩류 ──
    "연두부": "🫘", "검은콩": "🫘",
    "두유": "🥛", "유부": "🫘",

    # ── 가공·즉석식품 ──
    "라면": "🍜", "국수": "🍜", "파스타": "🍝", "스파게티": "🍝",
    "우동": "🍜", "소바": "🍜", "당면": "🍜", "냉면": "🍜",
    "만두": "🥟", "냉동만두": "🥟", "군만두": "🥟",
    "즉석밥": "🍚", "햇반": "🍚", "떡": "🍡", "떡볶이": "🍡",
    "통조림": "🥫", "참치캔": "🥫",
    "냉동치킨": "🍗", "치킨": "🍗", "너겟": "🍗",

    # ── 양념·소스 ──
    "간장": "🫗", "된장": "🫙", "고추장": "🫙", "쌈장": "🫙",
    "참기름": "🫙", "들기름": "🫙", "식용유": "🫙", "올리브유": "🫙",
    "고춧가루": "🌶️", "소금": "🧂", "설탕": "🍬", "후추": "🫙",
    "케첩": "🍅", "마요네즈": "🫙", "머스타드": "🫙",
    "굴소스": "🫙", "스리라차": "🌶️", "핫소스": "🌶️",
    "식초": "🫙", "미림": "🫙", "맛술": "🫙",
    "밀가루": "🌾", "전분": "🌾", "부침가루": "🌾", "튀김가루": "🌾",

    # ── 곡류·면류 ──
    "쌀": "🌾", "현미": "🌾", "잡곡": "🌾", "보리": "🌾", "귀리": "🌾",
    "식빵": "🍞", "빵": "🍞", "베이글": "🥯", "크루아상": "🥐",
    "오트밀": "🌾",

    # ── 스낵·과자 ──
    "과자": "🍪", "쿠키": "🍪", "크래커": "🍪", "비스킷": "🍪",
    "초콜릿": "🍫", "사탕": "🍬", "젤리": "🍬", "캐러멜": "🍮",
    "아이스크림": "🍦", "견과류": "🥜", "아몬드": "🥜",
    "호두": "🪨", "땅콩": "🥜", "캐슈": "🥜", "피스타치오": "🥜",
    "팝콘": "🍿", "칩": "🍟", "포카칩": "🍟",

    # ── 음료·주류 ──
    "물": "💧", "생수": "💧", "탄산수": "💧",
    "주스": "🧃", "음료": "🥤", "탄산음료": "🥤",
    "콜라": "🥤", "사이다": "🥤", "이온음료": "🥤",
    "커피": "☕", "녹차": "🍵", "홍차": "🍵", "유자차": "🍵",
    "맥주": "🍺", "소주": "🍶", "막걸리": "🍶", "와인": "🍷",
    "위스키": "🥃", "보드카": "🥃",

    # ── 기타 ──
    "김치": "🥬", "깍두기": "🥬", "열무김치": "🥬",
    "젓갈": "🫙", "장아찌": "🫙", "피클": "🥒",
}

DEFAULT_EMOJI = "🛒"

# 길이가 긴(구체적인) 키워드부터 매칭해야 "애호박"이 "호박"에 먼저 걸리는 일이 없다.
_SORTED_EMOJI_ITEMS = sorted(EMOJI_MAP.items(), key=lambda kv: len(kv[0]), reverse=True)


def get_emoji(name: str) -> str:
    # "식재료명(브랜드명)" 형식에서 괄호 앞 식재료명만 추출해 우선 매칭
    base = name.split("(")[0].strip()
    for keyword, emoji in _SORTED_EMOJI_ITEMS:
        if keyword in base:
            return emoji
    for keyword, emoji in _SORTED_EMOJI_ITEMS:
        if keyword in name:
            return emoji
    return DEFAULT_EMOJI


class ScanRequest(BaseModel):
    image: str
    mode: str = 'food'  # 'food' | 'receipt'


class ScanItem(BaseModel):
    name: str
    category_name: Optional[str] = None   # ← 추가: 식재료 카테고리명
    qty: float                            # 500g, 1.5kg 등 소수 가능하므로 int → float
    unit: Optional[str] = None            # "개" | "g" | "ml" | None(판단 불가 시에만)
    storage: str
    use_by: str
    emoji: str


class ScanResponse(BaseModel):
    source: str
    purchase_date: str
    items: list[ScanItem]


@app.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest):
    raw_b64 = req.image
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[1]

    img_bytes = base64.b64decode(raw_b64)

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(img_bytes)
        tmp_path = tmp.name

    try:
        if req.mode == 'food_llm':
            result = process_food_llm(tmp_path)
        elif req.mode == 'receipt':
            result = process_receipt_image(tmp_path)
        else:
            result = process_food_llm(tmp_path)
        #  result = process_food_image(tmp_path)  # ← YOLO
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.unlink(tmp_path)

    enriched_items = [
        ScanItem(
            name=it["name"],
            category_name=it.get("category_name") or None,   # ← 추가
            qty=it["qty"],
            unit=it.get("unit") or None,
            storage=it["storage"],
            use_by=it["use_by"],
            emoji=get_emoji(it["name"]),
        )
        for it in result.get("items", [])
    ]

    return ScanResponse(
        source=result.get("source", "unknown"),
        purchase_date=result.get("purchase_date", ""),
        items=enriched_items,
    )


@app.get("/health")
async def health():
    return {"status": "ok"}