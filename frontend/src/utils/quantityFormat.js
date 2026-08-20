const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

// 흔히 쓰이는 분모(1/2, 1/3, 2/3, 1/4, 3/4, 1/8 ...) 중 가장 근접한 분수로 변환한다.
// 깔끔하게 맞는 분수가 없으면 소수 둘째 자리까지 표시한다.
export const decimalToFraction = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);

  const whole = Math.trunc(num);
  const frac = Math.abs(num - whole);
  if (frac < 0.01) return String(whole);

  const denominators = [2, 3, 4, 8];
  for (const d of denominators) {
    const numerator = Math.round(frac * d);
    if (numerator === 0 || numerator === d) continue;
    if (Math.abs(frac - numerator / d) < 0.01) {
      const g = gcd(numerator, d);
      const fracStr = `${numerator / g}/${d / g}`;
      return whole === 0 ? fracStr : `${whole} ${fracStr}`;
    }
  }

  return String(Math.round(num * 100) / 100);
};

// 펜트리 수량+단위를 화면에 표시할 문자열로 변환.
// unit이 '개'이고 정수가 아닐 때만 분수로 표기하고, 그 외에는 숫자 그대로 보여준다.
export const formatPantryQuantity = (quantity, unit) => {
  const num = Number(quantity);
  const unitLabel = unit || '개';
  if (!Number.isFinite(num)) return `${quantity}${unitLabel}`;
  if (unit !== '개' || Number.isInteger(num)) return `${num}${unitLabel}`;
  return `${decimalToFraction(num)}${unitLabel}`;
};

// 레시피 재료 문구(예: "양배추 1/4개", "우유 200ml") 맨 앞의 수량 표현을 찾는다.
// 혼합 분수("1 1/2")·단순 분수("1/2")·정수/소수("3", "0.5") 순으로 시도하고,
// 일치하는 항목이 없으면 null. matchLength는 뒤이어 붙는 단위 토큰을 잘라내기 위해 사용한다.
// "한 꼬집", "두 알"처럼 숫자 대신 고유어 수사를 쓰는 경우(1~10)를 위한 보조 테이블.
// 뒤에 공백이 와야만 인정한다("세제"처럼 다른 단어 일부를 숫자로 잘못 인식하지 않도록).
const NATIVE_NUMBER_WORDS = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5,
  여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};
const _SORTED_NATIVE_WORDS = Object.keys(NATIVE_NUMBER_WORDS).sort((a, b) => b.length - a.length);

const matchLeadingQuantity = (text) => {
  if (!text) return null;
  const trimmed = String(text).trim();

  const mixed = trimmed.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed) {
    const denom = Number(mixed[3]);
    if (denom) return { qty: Number(mixed[1]) + Number(mixed[2]) / denom, matchLength: mixed[0].length };
  }

  const frac = trimmed.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    const denom = Number(frac[2]);
    if (denom) return { qty: Number(frac[1]) / denom, matchLength: frac[0].length };
  }

  const dec = trimmed.match(/^(\d+(?:\.\d+)?)/);
  if (dec) return { qty: Number(dec[1]), matchLength: dec[0].length };

  const native = _SORTED_NATIVE_WORDS.find(w => trimmed.startsWith(`${w} `));
  if (native) return { qty: NATIVE_NUMBER_WORDS[native], matchLength: native.length + 1 };

  return null;
};

// 레시피 재료 문구 맨 앞의 수량을 숫자로 파싱한다(단위 환산은 하지 않음 - 숫자만 참고).
// 인식 가능한 수량 표현이 없으면 null을 반환한다.
export const parseLeadingQuantity = (text) => {
  const matched = matchLeadingQuantity(text);
  return matched ? matched.qty : null;
};

// 수량 뒤에 붙는 단위 토큰까지 함께 추출한다(예: "1/2개" → { qty: 0.5, unit: '개' }).
// 긴 토큰을 먼저 검사해야 "큰술"이 "술" 등 부분 토큰으로 잘못 잡히지 않는다.
const UNIT_TOKENS = [
  '작은술', '종이컵', '큰술', 'kg', 'ml', '포기', '마리', '송이', '줄기', '조각', '뿌리', '꼬집', '공기',
  '개', '알', '톨', '쪽', '모', '단', '대', '통', '판', '다', '장', '봉', '줌', '캔', '병', '컵',
  'T', 't', 'g', 'L',
];

export const parseQuantityWithUnit = (text) => {
  const matched = matchLeadingQuantity(text);
  if (!matched) return { qty: null, unit: null };

  const rest = String(text).trim().slice(matched.matchLength).trim();
  const unit = UNIT_TOKENS.find(u => rest.startsWith(u)) || null;
  return { qty: matched.qty, unit };
};
