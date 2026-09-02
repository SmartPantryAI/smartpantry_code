// 이미 import된 recipes에 mafra "레시피 기본정보"의 TY_NM(요리유형)을 백필한다.
// recipes.id는 import_mafra_recipes.mjs가 빈 테이블에 mafra fetch 순서 그대로 삽입해
// 1..N으로 빈틈없이 채워졌으므로(재조회 결과와 위치가 1:1 대응), 제목 매칭(중복 4건 존재) 대신
// 위치 기반 매핑을 쓴다. 실행: docker exec smartpantry-web node scripts/backfill_dish_type.mjs
import mysql from 'mysql2/promise';

const API_KEY = '9b03debeba791ce0d3e7365732dd34a88005a0dbb35f943b66959f701689ccad';
const BASE_URL = `http://211.237.50.150:7080/openapi/${API_KEY}/json`;
const RECIPE_GRID = 'Grid_20150827000000000226_1';

const fetchGrid = async (gridId, start, end) => {
  const res = await fetch(`${BASE_URL}/${gridId}/${start}/${end}`);
  const data = await res.json();
  const key = Object.keys(data)[0];
  if (!data[key]?.row) throw new Error(`API 오류: ${JSON.stringify(data)}`);
  return data[key].row;
};

const main = async () => {
  const rows = await fetchGrid(RECIPE_GRID, 1, 1000);
  console.log(`mafra 레시피 기본정보 ${rows.length}건 재조회 완료`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '1234',
    database: process.env.DB_NAME || 'smartpantry',
  });

  try {
    const [dbRows] = await conn.query('SELECT id, title FROM recipes ORDER BY id');
    if (dbRows.length !== rows.length) {
      throw new Error(`recipes 행 수(${dbRows.length})가 mafra 조회 결과(${rows.length})와 다릅니다 - 위치 기반 매핑을 중단합니다.`);
    }
    // 앞부분 몇 개를 대조해서 실제로 같은 순서인지 확인 (안전장치)
    for (let i = 0; i < 5; i++) {
      if (dbRows[i].title !== rows[i].RECIPE_NM_KO) {
        throw new Error(`위치 ${i}에서 제목 불일치: DB="${dbRows[i].title}" vs mafra="${rows[i].RECIPE_NM_KO}"`);
      }
    }

    let updated = 0;
    for (let i = 0; i < dbRows.length; i++) {
      await conn.query('UPDATE recipes SET dish_type = ? WHERE id = ?', [rows[i].TY_NM || null, dbRows[i].id]);
      updated++;
    }
    console.log(`dish_type 백필 완료: ${updated}건`);
  } finally {
    await conn.end();
  }
};

main().catch((err) => {
  console.error('백필 실패:', err);
  process.exit(1);
});
