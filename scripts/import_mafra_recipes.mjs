// mafra(농림축산식품 공공데이터) "레시피 기본정보"/"레시피 재료정보" API를 가져와
// recipes / recipe_ingredients 테이블을 채운다.
// 실행: docker exec smartpantry-web node scripts/import_mafra_recipes.mjs
import mysql from 'mysql2/promise';

const API_KEY = '9b03debeba791ce0d3e7365732dd34a88005a0dbb35f943b66959f701689ccad';
const BASE_URL = `http://211.237.50.150:7080/openapi/${API_KEY}/json`;
const RECIPE_GRID = 'Grid_20150827000000000226_1';
const INGREDIENT_GRID = 'Grid_20150827000000000227_1';
const PAGE_SIZE = 1000; // API 제약: 끝행-시작행 <= 1000

const DIFFICULTY_MAP = { 초보환영: 'easy', 보통: 'normal', 어려움: 'hard' };

const fetchGrid = async (gridId, start, end) => {
  const res = await fetch(`${BASE_URL}/${gridId}/${start}/${end}`);
  const data = await res.json();
  const key = Object.keys(data)[0];
  if (!data[key]?.row) throw new Error(`API 오류 (${gridId} ${start}-${end}): ${JSON.stringify(data)}`);
  return { rows: data[key].row, totalCnt: data[key].totalCnt };
};

const fetchAllPages = async (gridId) => {
  const first = await fetchGrid(gridId, 1, PAGE_SIZE);
  const rows = [...first.rows];
  for (let start = PAGE_SIZE + 1; start <= first.totalCnt; start += PAGE_SIZE) {
    const end = Math.min(start + PAGE_SIZE - 1, first.totalCnt);
    const page = await fetchGrid(gridId, start, end);
    rows.push(...page.rows);
  }
  return rows;
};

// ── IRDNT_CPCTY 전용 파서 ─────────────────────────────────────
// 이 필드는 "수량+단위"만 오는 구조화된 텍스트라, 자유서술문을 다루는
// frontend/src/utils/quantityFormat.js의 UNIT_TOKENS 화이트리스트보다
// "숫자 뒤에 남는 텍스트는 전부 unit"으로 캡처하는 편이 예외 패턴에 더 강건하다.
// unitConvert.js는 모르는 단위를 만나면 null을 반환해 CookModal의
// "0 + 경고" 폴백으로 자연스럽게 이어지므로 unit 값 검증은 여기서 하지 않는다.
const UNICODE_FRACTIONS = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

const NATIVE_NUMBER_WORDS = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5,
  여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};
const SORTED_NATIVE_WORDS = Object.keys(NATIVE_NUMBER_WORDS).sort((a, b) => b.length - a.length);

// 순수 숫자/분수 선두 부분만 매칭 (단위는 호출부에서 나머지 텍스트로 캡처)
const matchLeadingNumber = (text) => {
  const mixed = text.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed) {
    const denom = Number(mixed[3]);
    if (denom) return { qty: Number(mixed[1]) + Number(mixed[2]) / denom, matchLength: mixed[0].length };
  }
  const frac = text.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    const denom = Number(frac[2]);
    if (denom) return { qty: Number(frac[1]) / denom, matchLength: frac[0].length };
  }
  const dec = text.match(/^(\d+(?:\.\d+)?)/);
  if (dec) return { qty: Number(dec[1]), matchLength: dec[0].length };
  return null;
};

export const parseIngredientCapacity = (raw) => {
  let text = (raw || '').trim();
  if (!text) return { amount: null, unit: null };

  // 날짜스럽게 깨진 원본 데이터 오류(예: "-03-04")는 버린다.
  if (/^-\d{2}-\d{2}$/.test(text)) return { amount: null, unit: null };

  // 유니코드 분수 문자를 ASCII 분수로 치환
  for (const [ch, ascii] of Object.entries(UNICODE_FRACTIONS)) {
    text = text.split(ch).join(ascii);
  }

  // "각 100g" 같은 접두사 제거
  text = text.replace(/^각\s*/, '');

  // "1과1/2큰술" / "1와1/2큰술" (혼합분수를 과/와로 연결)
  const guaMixed = text.match(/^(\d+)\s*(?:과|와)\s*(\d+)\s*\/\s*(\d+)\s*(.*)$/);
  if (guaMixed) {
    const denom = Number(guaMixed[3]);
    if (denom) {
      return {
        amount: Number(guaMixed[1]) + Number(guaMixed[2]) / denom,
        unit: guaMixed[4].trim() || null,
      };
    }
  }

  // "1~2큰술" / "~5개" 범위 표기 → 상한값 사용
  const range = text.match(/^(?:(\d+(?:\.\d+)?)\s*)?~\s*(\d+(?:\.\d+)?)\s*(.*)$/);
  if (range) {
    return { amount: Number(range[2]), unit: range[3].trim() || null };
  }

  // "반컵" / "반개" / "반모" / "반말" (반 + 단위, 공백 없음)
  const half = text.match(/^반([가-힣a-zA-Z]+)$/);
  if (half) return { amount: 0.5, unit: half[1] };

  // 고유어 수사 + 단위, 공백 있는 경우("한 줌")와 없는 경우("한줌") 모두 처리
  for (const word of SORTED_NATIVE_WORDS) {
    if (text.startsWith(`${word} `)) {
      const unit = text.slice(word.length + 1).trim();
      return { amount: NATIVE_NUMBER_WORDS[word], unit: unit || null };
    }
    if (text.startsWith(word) && text.length > word.length && !/^\d/.test(text[word.length])) {
      const unit = text.slice(word.length).trim();
      if (unit) return { amount: NATIVE_NUMBER_WORDS[word], unit };
    }
  }

  // 일반 숫자/분수 선두 매칭 → 나머지 전부를 unit으로 캡처
  let matched = matchLeadingNumber(text);
  let base = text;
  if (!matched) {
    // "작은거1개", "소1/2"처럼 수식어가 숫자 앞에 공백 없이 붙은 경우:
    // 첫 숫자 위치부터 다시 시도한다 (CookModal의 기존 처리 방식과 동일).
    const digitIdx = text.search(/\d/);
    if (digitIdx > 0) {
      base = text.slice(digitIdx);
      matched = matchLeadingNumber(base);
    }
  }
  if (matched) {
    const unit = base.slice(matched.matchLength).trim();
    return { amount: matched.qty, unit: unit || null };
  }

  // 끝까지 숫자를 못 찾음 ("약간", "적당량", "조금", "만드는법 참조" 등)
  // → 수량은 없지만 원문은 표시용으로 보존한다.
  return { amount: null, unit: text.slice(0, 50) };
};

// ── main ─────────────────────────────────────────────────────
const main = async () => {
  console.log('mafra 레시피 데이터 조회 중...');
  const [recipeRows, ingredientRows] = await Promise.all([
    fetchAllPages(RECIPE_GRID),
    fetchAllPages(INGREDIENT_GRID),
  ]);
  console.log(`레시피 ${recipeRows.length}건, 재료 ${ingredientRows.length}건 조회 완료`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '1234',
    database: process.env.DB_NAME || 'smartpantry',
  });

  try {
    const [[{ cnt: existingRecipeCount }]] = await conn.query('SELECT COUNT(*) AS cnt FROM recipes');
    if (existingRecipeCount > 0) {
      console.log(`recipes 테이블에 이미 ${existingRecipeCount}건이 있습니다. 중복 삽입을 피하기 위해 중단합니다.`);
      return;
    }

    const idMap = new Map(); // mafra RECIPE_ID -> db recipe id
    let insertedRecipes = 0;
    for (const r of recipeRows) {
      const cookingTimeMatch = String(r.COOKING_TIME || '').match(/\d+/);
      const cookingTime = cookingTimeMatch ? Number(cookingTimeMatch[0]) : null;
      const difficulty = DIFFICULTY_MAP[r.LEVEL_NM] || null;
      const [result] = await conn.query(
        'INSERT INTO recipes (title, description, cooking_time, difficulty, image_url, dish_type) VALUES (?, ?, ?, ?, NULL, ?)',
        [r.RECIPE_NM_KO, r.SUMRY?.trim() || null, cookingTime, difficulty, r.TY_NM || null]
      );
      idMap.set(r.RECIPE_ID, result.insertId);
      insertedRecipes++;
    }
    console.log(`recipes 삽입 완료: ${insertedRecipes}건`);

    const ingredientIdCache = new Map(); // 정규화된 이름 -> ingredient id
    const getIngredientId = async (name) => {
      if (ingredientIdCache.has(name)) return ingredientIdCache.get(name);
      await conn.query('INSERT IGNORE INTO ingredients (name) VALUES (?)', [name]);
      const [[row]] = await conn.query('SELECT id FROM ingredients WHERE name = ?', [name]);
      ingredientIdCache.set(name, row.id);
      return row.id;
    };

    let insertedIngredientRows = 0;
    let skippedOrphan = 0;
    let nullAmountCount = 0;

    for (const ing of ingredientRows) {
      const recipeDbId = idMap.get(ing.RECIPE_ID);
      if (!recipeDbId) { skippedOrphan++; continue; }

      const rawName = (ing.IRDNT_NM || '').trim();
      if (!rawName) { skippedOrphan++; continue; }
      const normalizedName = rawName.replace(/^\[[^\]]+\]\s*/, '').trim() || rawName;

      const { amount, unit } = parseIngredientCapacity(ing.IRDNT_CPCTY);
      if (amount === null) nullAmountCount++;

      const isRequired = ing.IRDNT_TY_NM === '양념' ? 0 : 1;

      const ingredientId = await getIngredientId(normalizedName);
      await conn.query(
        'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit, is_required) VALUES (?, ?, ?, ?, ?)',
        [recipeDbId, ingredientId, amount, unit, isRequired]
      );
      insertedIngredientRows++;
    }

    console.log(`recipe_ingredients 삽입 완료: ${insertedIngredientRows}건`);
    console.log(`- orphan(대응 레시피 없음/이름 없음) 스킵: ${skippedOrphan}건`);
    console.log(`- amount 파싱 실패(수량 없음으로 저장): ${nullAmountCount}건`);
    console.log(`- 신규 생성된 ingredients: ${ingredientIdCache.size}종 (기존 재사용분 포함)`);
  } finally {
    await conn.end();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('import 실패:', err);
    process.exit(1);
  });
}
