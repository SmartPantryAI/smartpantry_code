// recipes 테이블에 소스 무관 다중 API import를 위한 컬럼을 추가하고(is_main_dish/source_api/external_id),
// 기존 mafra 537건의 is_main_dish를 dish_type 기준으로 백필한다. init.sql은 최초 컨테이너 기동 시에만
// 실행되므로, 이미 데이터가 있는 운영 DB에는 이 스크립트로 별도 적용해야 한다.
// 실행: docker exec smartpantry-web node scripts/migrate_recipe_source_schema.mjs
import mysql from 'mysql2/promise';

const DB_NAME = process.env.DB_NAME || 'smartpantry';

// mafra TY_NM(요리유형) 중 "메인요리로 볼 수 있는 유형"만 허용한다.
// 제외: 나물/생채/샐러드·밑반찬/김치·부침·도시락/간식·떡/한과·양념장·빵/과자·음료
// (전수 조사 결과 대부분 곁들임/안주/간식류였다 - 예: 고추장아찌가 밑반찬/김치로 분류되어
// 메인 요리로 추천되던 버그의 원인). server.js의 이전 MAIN_DISH_TYPES와 동일한 목록.
const MAIN_DISH_TYPES = [
  '밥', '만두/면류', '국', '볶음', '찌개/전골/스튜', '구이', '찜',
  '튀김/커틀릿', '조림', '양식', '그라탕/리조또', '샌드위치/햄버거', '피자',
];

const columnExists = async (conn, table, column) => {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, column]
  );
  return rows[0].cnt > 0;
};

const indexExists = async (conn, table, indexName) => {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB_NAME, table, indexName]
  );
  return rows[0].cnt > 0;
};

const main = async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '1234',
    database: DB_NAME,
  });

  try {
    if (!(await columnExists(conn, 'recipes', 'is_main_dish'))) {
      await conn.query('ALTER TABLE recipes ADD COLUMN is_main_dish TINYINT(1) AFTER dish_type');
      console.log('✅ recipes.is_main_dish 컬럼 추가');
    } else {
      console.log('- recipes.is_main_dish 이미 존재, 스킵');
    }

    if (!(await columnExists(conn, 'recipes', 'source_api'))) {
      await conn.query("ALTER TABLE recipes ADD COLUMN source_api VARCHAR(20) NOT NULL DEFAULT 'mafra' AFTER is_main_dish");
      console.log('✅ recipes.source_api 컬럼 추가');
    } else {
      console.log('- recipes.source_api 이미 존재, 스킵');
    }

    if (!(await columnExists(conn, 'recipes', 'external_id'))) {
      await conn.query('ALTER TABLE recipes ADD COLUMN external_id VARCHAR(50) NULL AFTER source_api');
      console.log('✅ recipes.external_id 컬럼 추가');
    } else {
      console.log('- recipes.external_id 이미 존재, 스킵');
    }

    if (!(await indexExists(conn, 'recipes', 'uq_recipes_source'))) {
      await conn.query('ALTER TABLE recipes ADD UNIQUE KEY uq_recipes_source (source_api, external_id)');
      console.log('✅ recipes UNIQUE(source_api, external_id) 추가');
    } else {
      console.log('- uq_recipes_source 이미 존재, 스킵');
    }

    const [result] = await conn.query(
      `UPDATE recipes SET is_main_dish = IF(dish_type IN (?), 1, 0)
       WHERE is_main_dish IS NULL AND source_api = 'mafra'`,
      [MAIN_DISH_TYPES]
    );
    console.log(`✅ mafra is_main_dish 백필 완료: ${result.affectedRows}건`);

    const [[{ cnt: stillNull }]] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM recipes WHERE is_main_dish IS NULL AND source_api = 'mafra'"
    );
    if (stillNull > 0) console.warn(`⚠️ 백필 후에도 is_main_dish NULL인 mafra 행 ${stillNull}건 남음`);
  } finally {
    await conn.end();
  }
};

main().catch((err) => {
  console.error('스키마 마이그레이션 실패:', err);
  process.exit(1);
});
