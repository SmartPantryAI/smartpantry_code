require('dotenv').config();

const express  = require('express');
const mysql    = require('mysql2');
const session  = require('express-session');
const passport = require('passport');
const Kakao    = require('passport-kakao').Strategy;
const Google   = require('passport-google-oauth20').Strategy;
const axios    = require('axios');
const webpush  = require('web-push');
const cron     = require('node-cron');

const app = express();

// ── VAPID ────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails('mailto:sj297916@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ── 미들웨어 ──────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000, httpOnly: true, secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── DB 커넥션 풀 ──────────────────────────────────────────────
const db = mysql.createPool({
    host:             process.env.DB_HOST     || 'db',
    user:             process.env.DB_USER     || 'root',
    password:         process.env.DB_PASSWORD || '1234',
    database:         process.env.DB_NAME     || 'smartpantry',
    waitForConnections: true,
    connectionLimit:  10,
    queueLimit:       0,
});
db.getConnection((err, conn) => {
    if (err) { console.error('DB 초기 연결 실패:', err.message); return; }
    console.log('DB 연결 성공 ✅');
    conn.release();
});

// Promise 래퍼 (async/await 지원)
const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
    );

// ── Passport 소셜 로그인 ──────────────────────────────────────
const socialLoginVerify = async (snsId, provider, name, email, done) => {
    try {
        const providerUserId = String(snsId);

        // 기존 계정 조회
        const rows = await query(
            `SELECT u.* FROM users u
             JOIN social_accounts sa ON u.id = sa.user_id
             WHERE sa.provider = ? AND sa.provider_user_id = ?`,
            [provider, providerUserId]
        );

        if (rows.length > 0) {
            // 이메일 없으면 업데이트
            if (email && !rows[0].email) {
                await query('UPDATE users SET email = ? WHERE id = ?', [email, rows[0].id]);
            }
            return done(null, rows[0]);
        }

        // 신규 가입
        const result = await query(
            'INSERT INTO users (name, email, is_agreed) VALUES (?, ?, 0)',
            [name || '유저', email || null]
        );
        await query(
            'INSERT INTO social_accounts (user_id, provider, provider_user_id) VALUES (?, ?, ?)',
            [result.insertId, provider, providerUserId]
        );
        return done(null, { id: result.insertId, name: name || '유저', email, is_agreed: 0, is_admin: 0 });

    } catch (err) {
        return done(err);
    }
};

passport.use(new Kakao({
    clientID:    process.env.KAKAO_CLIENT_ID,
    clientSecret:process.env.KAKAO_CLIENT_SECRET,
    callbackURL: 'https://smpa.aikopo.net/auth/kakao/callback',
}, (at, rt, profile, done) => {
    const name = profile.displayName || profile._json?.kakao_account?.profile?.nickname || '유저';
    socialLoginVerify(profile.id, 'kakao', name, null, done);
}));

passport.use(new Google({
    clientID:    process.env.GOOGLE_CLIENT_ID,
    clientSecret:process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://smpa.aikopo.net/auth/google/callback',
}, (at, rt, profile, done) => {
    const email = profile.emails?.[0]?.value || null;
    socialLoginVerify(profile.id, 'google', profile.displayName, email, done);
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const rows = await query('SELECT * FROM users WHERE id = ?', [id]);
        if (!rows[0]) return done(null, false);
        db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [id]);
        done(null, rows[0]);
    } catch (err) { done(err); }
});

// ── 미들웨어 ──────────────────────────────────────────────────
const isLoggedIn = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
};

const isAdminConsole = (req, res, next) => {
    if (req.session?.adminConsole) return next();
    res.status(403).json({ success: false, message: '관리자 로그인이 필요합니다.' });
};

// ── 동의(약관/개인정보) 관리 ───────────────────────────────────
const CONSENT_TYPES = ['terms', 'age14', 'privacy', 'pantry_data', 'camera', 'push', 'marketing'];
const REQUIRED_CONSENTS = ['terms', 'age14', 'privacy', 'pantry_data'];
const CONSENT_VERSIONS = {
    terms: 'terms_v1', age14: 'age14_v1', privacy: 'privacy_v1', pantry_data: 'pantry_v1',
    camera: 'camera_v1', push: 'push_v1', marketing: 'marketing_v1',
};

const upsertConsent = async (userId, consentType, agreed) => {
    const version = CONSENT_VERSIONS[consentType];
    const prev = await query('SELECT agreed FROM user_consents WHERE user_id = ? AND consent_type = ?', [userId, consentType]);
    const previousValue = prev.length ? prev[0].agreed : null;
    await query(
        `INSERT INTO user_consents (user_id, consent_type, agreed, consent_version)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE agreed = ?, consent_version = ?, agreed_at = CURRENT_TIMESTAMP`,
        [userId, consentType, agreed ? 1 : 0, version, agreed ? 1 : 0, version]
    );
    await query(
        `INSERT INTO user_consent_history (user_id, consent_type, previous_value, new_value, consent_version)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, consentType, previousValue, agreed ? 1 : 0, version]
    );
};

const getConsentsMap = async (userId) => {
    const rows = await query('SELECT consent_type, agreed, consent_version FROM user_consents WHERE user_id = ?', [userId]);
    const map = {};
    for (const type of CONSENT_TYPES) map[type] = { agreed: false, version: null };
    for (const row of rows) map[row.consent_type] = { agreed: !!row.agreed, version: row.consent_version };
    return map;
};

// ── 인증 ─────────────────────────────────────────────────────
app.get('/api/user', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ loggedIn: false });
    try {
        const consents = await getConsentsMap(req.user.id);
        res.json({ loggedIn: true, user: req.user.name, isAgreed: req.user.is_agreed, consents });
    } catch { res.status(500).json({ success: false }); }
});

app.post('/api/agree', isLoggedIn, async (req, res) => {
    const consents = req.body?.consents || {};
    const missingRequired = REQUIRED_CONSENTS.filter(type => !consents[type]);
    if (missingRequired.length) {
        return res.status(400).json({ success: false, message: '필수 항목에 모두 동의해야 합니다.', missing: missingRequired });
    }
    try {
        for (const type of CONSENT_TYPES) {
            await upsertConsent(req.user.id, type, !!consents[type]);
        }
        await query('UPDATE users SET is_agreed = 1 WHERE id = ?', [req.user.id]);
        req.user.is_agreed = 1;
        req.session.save(() => res.json({ success: true }));
    } catch { res.status(500).json({ success: false }); }
});

app.patch('/api/user/consents', isLoggedIn, async (req, res) => {
    const { consent_type, agreed } = req.body || {};
    if (!['push', 'marketing'].includes(consent_type)) {
        return res.status(403).json({
            success: false,
            message: '필수 동의 항목은 마이페이지에서 철회할 수 없습니다. 철회를 원하시면 회원 탈퇴를 진행해주세요.',
        });
    }
    try {
        await upsertConsent(req.user.id, consent_type, !!agreed);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

app.get('/auth/kakao', passport.authenticate('kakao'));
app.get('/auth/kakao/callback',
    passport.authenticate('kakao', { failureRedirect: '/' }),
    (req, res) => req.session.save(() => res.redirect('/'))
);

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => req.session.save(() => res.redirect('/'))
);

app.get('/logout', (req, res) => {
    req.logout(() => {
        req.session.destroy(() => {
            res.clearCookie('connect.sid');
            res.redirect('/');
        });
    });
});

// ── 사용자 계정 관리 ──────────────────────────────────────────
app.put('/api/user/name', isLoggedIn, async (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: '이름을 입력해주세요.' });
    try {
        await query('UPDATE users SET name = ? WHERE id = ?', [name.trim(), req.user.id]);
        req.user.name = name.trim();
        req.session.save(() => res.json({ success: true, name: name.trim() }));
    } catch { res.status(500).json({ success: false }); }
});

app.delete('/api/user', isLoggedIn, async (req, res) => {
    const userId = req.user.id;
    try {
        await query('DELETE FROM saved_recipes WHERE user_id = ?', [userId]);
        await query('DELETE FROM recommendation_logs WHERE user_id = ?', [userId]);
        await query('DELETE FROM scan_logs WHERE user_id = ?', [userId]);
        await query('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
        await query('DELETE FROM used_ingredient_logs WHERE user_id = ?', [userId]);
        await query('DELETE FROM pantry WHERE user_id = ?', [userId]);
        await query('DELETE FROM social_accounts WHERE user_id = ?', [userId]);
        await query('DELETE FROM users WHERE id = ?', [userId]);
        req.logout(() => req.session.destroy(() => {
            res.clearCookie('connect.sid');
            res.json({ success: true });
        }));
    } catch { res.status(500).json({ success: false }); }
});

// ── 식재료 카테고리 추정 ──────────────────────────────────────
const FOOD_CATEGORIES = [
  '채소류', '과일류', '육류', '수산물',
  '유제품·계란', '두부·콩류', '가공·즉석식품',
  '음료·주류', '양념·소스', '곡류·면류', '스낵·과자'
];

const guessCategory = async (name) => {
  if (!name) return null;
  try {
    const { data } = await axios.post('http://ollama.aikopo.net/api/chat', {
      model: 'gemma4:26b',
      messages: [
        {
          role: 'system',
          content: `너는 식재료 분류 AI다. 주어진 식재료 이름이 아래 11개 카테고리 중 어디에 속하는지 카테고리명만 출력한다. 다른 텍스트는 절대 출력하지 않는다.

카테고리:
- 채소류: 당근, 양파, 배추, 가지, 파프리카, 버섯, 콩나물 등 신선 채소
- 과일류: 사과, 바나나, 딸기, 수박, 포도, 망고 등 신선 과일
- 육류: 소고기, 돼지고기, 닭고기, 삼겹살, 베이컨, 스팸 등
- 수산물: 고등어, 오징어, 새우, 참치, 김, 미역, 북어 등
- 유제품·계란: 우유, 치즈, 요거트, 버터, 계란 등
- 두부·콩류: 두부, 순두부, 두유, 콩, 검은콩 등
- 가공·즉석식품: 라면, 즉석밥, 냉동만두, 햄, 통조림 등
- 음료·주류: 생수, 주스, 사이다, 맥주, 소주, 에너지드링크 등
- 양념·소스: 간장, 고추장, 된장, 케첩, 마요네즈, 참기름, 고춧가루 등
- 곡류·면류: 쌀, 밀가루, 국수, 식빵, 오트밀 등
- 스낵·과자: 과자, 아이스크림, 초콜릿, 젤리 등`,
        },
        { role: 'user', content: name },
      ],
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 20 },
    }, { timeout: 10000 });

    const result = (data?.message?.content || '').trim();
    const matched = FOOD_CATEGORIES.find(cat => result.includes(cat));
    return matched || null;
  } catch (err) {
    console.error('카테고리 추정 LLM 오류:', err.message);
    return null;
  }
};

// ── 식재료 (Pantry) ───────────────────────────────────────────
// 수정 전
// app.get('/api/pantry', isLoggedIn, async (req, res) => {
//     try {
//         const items = await query(
//             'SELECT * FROM pantry WHERE user_id = ? AND status != "deleted" ORDER BY expiry_date ASC',
//             [req.user.id]
//         );
//         res.json(items);
//     } catch { res.status(500).json({ error: '조회 실패' }); }
// });
// 수정 후 (식재료 카테고리 추가, 유통기한 임박 순 정렬)
app.get('/api/pantry', isLoggedIn, async (req, res) => {
  try {
    const items = await query(
      `SELECT p.*, i.category AS food_category
       FROM pantry p
       LEFT JOIN ingredients i ON p.ingredient_id = i.id
       WHERE p.user_id = ? AND p.status NOT IN ('deleted', 'expired')
       ORDER BY p.expiry_date ASC`,
      [req.user.id]
    );
    res.json(items);
  } catch (err) {
    console.error('pantry 조회 오류:', err.message);
    res.status(500).json({ error: '조회 실패' });
  }
});

app.post('/api/add-item', isLoggedIn, async (req, res) => {
    const userId    = req.user.id;
    const itemsToAdd = Array.isArray(req.body) ? req.body : [req.body];
    if (!itemsToAdd.length) return res.status(400).json({ success: false, message: '추가할 항목이 없습니다.' });

    try {
        for (const item of itemsToAdd) {
            const name     = item.item_name  || item.name;
            const emoji    = item.item_emoji || item.emoji   || '🛒';
            const category = item.category   || item.storage || '냉장';
            const expiry   = item.expiry_date || item.use_by;
            const source   = item.source     || (item.use_by ? 'camera' : 'manual');
            const quantity = item.quantity   || 1;
            // AI가 단위를 추출하지 못한 경우 '개'로 단정하지 않고 NULL로 남겨 사용자가 추후 직접 확인하게 한다
            const unit     = item.unit       || null;

            const foodCategory = item.category_name || await guessCategory(name);
            await query('INSERT IGNORE INTO ingredients (name, emoji, category) VALUES (?, ?, ?)', [name, emoji, foodCategory]);
            await query('UPDATE ingredients SET category = ? WHERE name = ? AND category IS NULL', [foodCategory, name]);
            const [ing] = await query('SELECT id FROM ingredients WHERE name = ?', [name]);
            await query(
                'INSERT INTO pantry (user_id, ingredient_id, item_name, item_emoji, expiry_date, category, quantity, unit, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [userId, ing?.id || null, name, emoji, expiry, category, quantity, unit, source]
            );
        }
        res.json({ success: true, count: itemsToAdd.length });
    } catch (err) {
        console.error('식재료 저장 오류:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 식재료 상태 변경 (used / expired / deleted)
app.patch('/api/pantry/:id', isLoggedIn, async (req, res) => {
    const { quantity, expiry_date } = req.body;
    const updates = [];
    const values  = [];
    if (quantity    !== undefined) { updates.push('quantity = ?');    values.push(parseFloat(quantity)); }
    if (expiry_date !== undefined) { updates.push('expiry_date = ?'); values.push(expiry_date); }
    if (!updates.length) return res.status(400).json({ success: false, message: '수정할 항목이 없습니다.' });
    values.push(req.params.id, req.user.id);
    try {
        await query(`UPDATE pantry SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, values);
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.patch('/api/pantry/:id/status', isLoggedIn, async (req, res) => {
    const { status } = req.body;
    const allowed = ['available', 'used', 'expired', 'deleted'];
    if (!allowed.includes(status)) return res.status(400).json({ success: false });
    try {
        await query('UPDATE pantry SET status = ? WHERE id = ? AND user_id = ?', [status, req.params.id, req.user.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

app.delete('/api/delete-item/:id', isLoggedIn, async (req, res) => {
    try {
        await query('DELETE FROM pantry WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

app.post('/api/delete-items', isLoggedIn, async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false });
    try {
        const result = await query('DELETE FROM pantry WHERE id IN (?) AND user_id = ?', [ids, req.user.id]);
        res.json({ success: true, deletedCount: result.affectedRows });
    } catch (err) {
        console.error('다중 삭제 오류:', err.message);
        res.status(500).json({ success: false });
    }
});

app.post('/api/delete-all-items', isLoggedIn, async (req, res) => {
    try {
        await query('DELETE FROM pantry WHERE user_id = ?', [req.user.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

// ── AI 스캔 ───────────────────────────────────────────────────
const AI_SERVER_URL = process.env.AI_SERVER_URL || 'http://ai:8000';

// 한글 음절 없거나, 너무 짧거나, 숫자/특수문자만인 이름은 인식 실패로 처리
const isValidIngredientName = (name) => {
    if (!name || typeof name !== 'string') return false;
    const t = name.trim();
    if (t.length < 1 || t.length > 40) return false;
    if (!/[가-힣]/.test(t)) return false;
    return true;
};

app.post('/api/scan', isLoggedIn, async (req, res) => {
    const { image, mode = 'food' } = req.body;
    if (!image) return res.status(400).json({ success: false, message: '이미지가 없습니다.' });

    try {
        console.log(`🤖 AI 서버 전송 (mode: ${mode})`);
        const { data } = await axios.post(`${AI_SERVER_URL}/scan`, { image, mode }, { timeout: 120000 });

        const validItems   = data.items.filter(it => isValidIngredientName(it.name));
        const invalidItems = data.items.filter(it => !isValidIngredientName(it.name));
        if (invalidItems.length) console.log(`⚠️  필터 제외 (${invalidItems.length}개):`, invalidItems.map(i => i.name));
        data.items = validItems;

        console.log(`✅ AI 인식 완료 (${data.source}): ${validItems.length}개 유효 / ${invalidItems.length}개 제외`);

        // 스캔 로그 저장 (비동기)
        db.query(
            'INSERT INTO scan_logs (user_id, mode, source, image_data, item_count, items_json, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.user.id, mode, data.source, image, validItems.length, JSON.stringify(validItems), 'success']
        );

        res.json({ success: true, ...data });
    } catch (err) {
        console.error('❌ AI 서버 오류:', err.message);
        db.query(
            'INSERT INTO scan_logs (user_id, mode, source, image_data, item_count, status) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.id, mode, 'error', image, 0, 'failed']
        );
        res.status(500).json({ success: false, message: 'AI 인식에 실패했습니다. 다시 시도해주세요.' });
    }
});

// ── 레시피 추천 (LLM) ─────────────────────────────────────────
const RECIPE_PROMPT = `너는 창의적인 한국 요리 레시피 추천 API다. 반드시 순수 JSON만 출력한다. 마크다운, 설명, 코드블럭, 주석을 절대 출력하지 않는다.

출력 형식:
{
  "recipes": [
    {
      "name": "요리명",
      "servings": "2인분",
      "used_ingredients": ["양파 1개 (채 썰기)", "돼지고기 300g"],
      "missing_ingredients": ["참기름 1큰술"],
      "steps": ["1단계 상세 설명", "2단계 상세 설명"],
      "tips": ["핵심 팁"],
      "time": "30분",
      "difficulty": "쉬움"
    }
  ]
}

규칙:
- recipes 정확히 2개, 서로 다른 종류 (예: 국물 + 볶음)
- 앞쪽 재료일수록 유통기한 임박 → 우선 활용
- used_ingredients: 분량 포함, steps: 5~7개 구체적 설명, tips: 1~2개
- difficulty: "쉬움"|"보통"|"어려움", 모든 값 한국어
- JSON만 출력`;

const isValidRecipe = (r) =>
    r && typeof r.name === 'string' && r.name.trim() &&
    Array.isArray(r.steps) && r.steps.length > 0;

// Ollama가 간헐적으로 타임아웃/네트워크 오류를 내므로 1회 재시도한다
async function callOllamaWithRetry(payload, retries = 1) {
    try {
        return await axios.post('http://ollama.aikopo.net/api/chat', payload, { timeout: 120000 });
    } catch (err) {
        if (retries > 0) {
            console.warn('⚠️ Ollama 호출 실패, 재시도:', err.message);
            return callOllamaWithRetry(payload, retries - 1);
        }
        throw err;
    }
}

app.post('/api/recommend', isLoggedIn, async (req, res) => {
    // 같은 재료가 여러 배치로 등록돼 있어도 이름 기준 1건으로 합쳐 전달한다
    const ingredients = [...new Set(req.body?.ingredients || [])];
    const priorityIngredients = [...new Set(req.body?.priorityIngredients || [])];
    if (!ingredients.length) return res.status(400).json({ recipes: [] });

    const priorityRule = priorityIngredients.length > 0
        ? `- 우선 사용 재료: [${priorityIngredients.join(', ')}] → 이 재료들이 반드시 메인 재료로 활용되어야 한다`
        : `- 앞쪽 재료일수록 유통기한 임박 → 우선 활용`;

    const dynamicPrompt = RECIPE_PROMPT.replace(
        '- 앞쪽 재료일수록 유통기한 임박 → 우선 활용',
        priorityRule
    );

    const userMessage = priorityIngredients.length > 0
        ? `우선 사용할 재료: ${priorityIngredients.join(', ')}\n전체 보유 재료: ${ingredients.join(', ')}\n우선 재료를 메인으로 활용한 요리를 JSON만 출력해라.`
        : `보유 재료: ${ingredients.join(', ')}\n위 재료로 만들 수 있는 요리를 JSON만 출력해라.`;

    try {
        const { data } = await callOllamaWithRetry({
            model: 'gemma4:26b',
            messages: [
                { role: 'system', content: dynamicPrompt },
                { role: 'user', content: userMessage },
            ],
            stream: false,
            think: false,
            options: { temperature: 0.7, num_predict: 3000 },
        });

        const text = data?.message?.content || data?.response || '';
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { parsed = null; }

        const recipes = Array.isArray(parsed?.recipes) ? parsed.recipes.filter(isValidRecipe) : [];

        if (recipes.length === 0) {
            console.error('❌ LLM 추천 응답 파싱 실패 또는 빈 결과:', text.slice(0, 300));
            return res.status(502).json({ recipes: [], error: 'invalid_ai_response' });
        }

        // 추천 이력 저장 (비동기, 오류 무시)
        db.query(
            "INSERT INTO recommendation_logs (user_id, recommendation_type, input_ingredients, llm_response) VALUES (?, 'llm_generated', ?, ?)",
            [req.user.id, ingredients.join(','), JSON.stringify({ recipes })],
            (err) => { if (err) console.error('추천 로그 저장 실패:', err.message); }
        );

        res.json({ recipes });
    } catch (err) {
        console.error('❌ LLM 추천 에러:', err.message);
        res.status(500).json({ recipes: [], error: err.message });
    }
});

// ── 공지 (사용자용) ───────────────────────────────────────────
app.get('/api/notice', isLoggedIn, async (req, res) => {
    try {
        const rows = await query('SELECT message FROM notices WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1');
        res.json(rows[0] || null);
    } catch { res.status(500).json({ success: false }); }
});

// ── Web Push ─────────────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', isLoggedIn, async (req, res) => {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth)
        return res.status(400).json({ success: false, message: '구독 정보가 올바르지 않습니다.' });
    try {
        await query(
            'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)',
            [req.user.id, endpoint, keys.p256dh, keys.auth]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('구독 저장 오류:', err.message);
        res.status(500).json({ success: false });
    }
});

app.post('/api/push/unsubscribe', isLoggedIn, async (req, res) => {
    try {
        await query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, req.body.endpoint]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

app.get('/api/push/status', isLoggedIn, async (req, res) => {
    try {
        const rows = await query('SELECT id FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
        res.json({ subscribed: rows.length > 0 });
    } catch { res.status(500).json({ success: false }); }
});

// ── 관리자 콘솔 ───────────────────────────────────────────────
let activeAdminSessionId = null; // 단일 세션 강제
const ADMIN_ID       = process.env.ADMIN_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.post('/api/admin/console-login', (req, res) => {
    const { id, pw } = req.body;
    if (id === ADMIN_ID && pw === ADMIN_PASSWORD) {
        if (activeAdminSessionId && activeAdminSessionId !== req.sessionID) {
            req.sessionStore.destroy(activeAdminSessionId, () => {});
        }
        activeAdminSessionId = req.sessionID;
        const ua = req.headers['user-agent'] || '';
        req.session.adminConsole = true;
        req.session.loginAt = new Date().toISOString();
        req.session.loginIp = req.ip;
        req.session.loginUa = ua;
        req.session.save(() => {
            auditLog('admin', 'ADMIN_LOGIN', null, `IP: ${req.ip}`, req.ip);
            res.json({ success: true });
        });
    } else {
        auditLog('admin', 'ADMIN_LOGIN_FAIL', null, `IP: ${req.ip}`, req.ip);
        res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
});

app.post('/api/admin/console-logout', (req, res) => {
    if (activeAdminSessionId === req.sessionID) activeAdminSessionId = null;
    req.session.adminConsole = false;
    req.session.save(() => res.json({ success: true }));
});

app.get('/api/admin/session-info', isAdminConsole, (req, res) => {
    const ua = req.session.loginUa || '';
    let browser = '알 수 없음';
    if (ua.includes('Edg'))                                   browser = 'Edge';
    else if (ua.includes('Chrome'))                           browser = 'Chrome';
    else if (ua.includes('Firefox'))                          browser = 'Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
    let os = '';
    if (ua.includes('Windows'))                               os = 'Windows';
    else if (ua.includes('iPhone') || ua.includes('iPad'))    os = 'iOS';
    else if (ua.includes('Android'))                          os = 'Android';
    else if (ua.includes('Mac'))                              os = 'macOS';
    else if (ua.includes('Linux'))                            os = 'Linux';
    res.json({
        loginAt: req.session.loginAt || null,
        loginIp: req.session.loginIp || req.ip,
        device:  browser + (os ? ` / ${os}` : ''),
    });
});

// 감사 로그 기록 헬퍼
const auditLog = (actor, action, target, detail, ip) => {
    db.query('INSERT INTO audit_logs (actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)',
        [actor, action, target || null, detail || null, ip || null]);
};

app.get('/api/admin/stats', isAdminConsole, async (req, res) => {
    try {
        const [totalUsers, dau, mau, byProvider, recentUsers, recentScans, totalScans, scansToday, totalPantry] = await Promise.all([
            query('SELECT COUNT(*) AS count FROM users'),
            query('SELECT COUNT(*) AS count FROM users WHERE DATE(last_login_at) = CURDATE()'),
            query('SELECT COUNT(*) AS count FROM users WHERE last_login_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'),
            query('SELECT sa.provider, COUNT(*) AS count FROM social_accounts sa GROUP BY sa.provider'),
            query('SELECT DATE(created_at) AS date, COUNT(*) AS count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY DATE(created_at) ORDER BY date ASC'),
            query('SELECT DATE(created_at) AS date, COUNT(*) AS count FROM scan_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY DATE(created_at) ORDER BY date ASC'),
            query('SELECT COUNT(*) AS count FROM scan_logs'),
            query('SELECT COUNT(*) AS count FROM scan_logs WHERE DATE(created_at) = CURDATE()'),
            query('SELECT COUNT(*) AS count FROM pantry WHERE status = "available"'),
        ]);
        auditLog('admin', 'VIEW_STATS', null, null, req.ip);
        res.json({ totalUsers, dau, mau, byProvider, recentUsers, recentScans, totalScans, scansToday, totalPantry });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.get('/api/admin/users', isAdminConsole, async (req, res) => {
    try {
        const rows = await query(`
            SELECT u.id, u.name, u.email, u.is_agreed, u.is_admin, u.created_at,
                   GROUP_CONCAT(DISTINCT sa.provider) AS provider,
                   COUNT(DISTINCT p.id) AS pantry_count
            FROM users u
            LEFT JOIN social_accounts sa ON u.id = sa.user_id
            LEFT JOIN pantry p ON u.id = p.user_id AND p.status = 'available'
            GROUP BY u.id
            ORDER BY u.created_at DESC
        `);
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

app.get('/api/admin/users/:id/pantry', isAdminConsole, async (req, res) => {
    try {
        const rows = await query('SELECT * FROM pantry WHERE user_id = ? ORDER BY expiry_date ASC', [req.params.id]);
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

app.get('/api/admin/users/:id/logs', isAdminConsole, async (req, res) => {
    try {
        const rows = await query('SELECT * FROM recommendation_logs WHERE user_id = ? ORDER BY created_at DESC', [req.params.id]);
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/users/:id', isAdminConsole, async (req, res) => {
    try {
        const [user] = await query('SELECT name, email FROM users WHERE id = ?', [req.params.id]);
        if (!user) return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
        const uid = req.params.id;
        await query('DELETE FROM saved_recipes WHERE user_id = ?', [uid]);
        await query('DELETE FROM recommendation_logs WHERE user_id = ?', [uid]);
        await query('DELETE FROM scan_logs WHERE user_id = ?', [uid]);
        await query('DELETE FROM push_subscriptions WHERE user_id = ?', [uid]);
        await query('DELETE FROM pantry WHERE user_id = ?', [uid]);
        await query('DELETE FROM social_accounts WHERE user_id = ?', [uid]);
        await query('DELETE FROM users WHERE id = ?', [uid]);
        auditLog('admin', 'DELETE_USER', `user:${uid}`, `${user.name}(${user.email})`, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('사용자 삭제 오류:', err.message);
        res.status(500).json({ success: false });
    }
});

// 전체 사용자에게 푸시 알림 전송 (만료된 구독은 자동 정리)
const sendPushToAll = async (title, body, url = '/') => {
    const subs = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
    let sent = 0;
    for (const s of subs) {
        const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
            await webpush.sendNotification(sub, JSON.stringify({ title, body, icon: '/notif-icon-192.png', badge: '/notif-badge-72.png', url }));
            sent++;
        } catch (e) {
            if (e.statusCode === 410 || e.statusCode === 404) {
                await query('DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]);
            }
        }
    }
    return sent;
};

app.get('/api/admin/notices', isAdminConsole, async (req, res) => {
    try {
        const rows = await query('SELECT * FROM notices ORDER BY created_at DESC');
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

app.post('/api/admin/notices', isAdminConsole, async (req, res) => {
    const { message, sendPush } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false });
    try {
        const result = await query('INSERT INTO notices (message) VALUES (?)', [message.trim()]);
        let pushSent = 0;
        if (sendPush) {
            pushSent = await sendPushToAll('📢 SmartPantry 공지', message.trim(), '/');
            await query('UPDATE notices SET push_sent = 1 WHERE id = ?', [result.insertId]);
        }
        auditLog('admin', 'CREATE_NOTICE', `notice:${result.insertId}`, sendPush ? `푸시 발송 ${pushSent}건` : '푸시 미발송', req.ip);
        res.json({ success: true, pushSent });
    } catch (err) { console.error('공지 등록 오류:', err.message); res.status(500).json({ success: false }); }
});

app.patch('/api/admin/notices/:id', isAdminConsole, async (req, res) => {
    try {
        await query('UPDATE notices SET is_active = ? WHERE id = ?', [req.body.is_active ? 1 : 0, req.params.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/notices/:id', isAdminConsole, async (req, res) => {
    try {
        await query('DELETE FROM notices WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

// 식재료 통계 (관리자용)
app.get('/api/admin/ingredient-stats', isAdminConsole, async (req, res) => {
    try {
        const [topItems, topConsumed, categoryStats, sourceStats, totalRows] = await Promise.all([
            query(`SELECT item_name, item_emoji, COUNT(*) AS count
                   FROM pantry
                   GROUP BY item_name, item_emoji
                   ORDER BY count DESC LIMIT 20`),
            query(`SELECT item_name, item_emoji, COUNT(*) AS count
                   FROM pantry
                   WHERE status = 'used'
                   GROUP BY item_name, item_emoji
                   ORDER BY count DESC LIMIT 10`),
            query(`SELECT category, COUNT(*) AS count
                   FROM pantry
                   GROUP BY category
                   ORDER BY count DESC`),
            query(`SELECT source, COUNT(*) AS count
                   FROM pantry
                   GROUP BY source
                   ORDER BY count DESC`),
            query(`SELECT COUNT(*) AS total FROM pantry`),
        ]);
        res.json({ topItems, topConsumed, categoryStats, sourceStats, total: totalRows[0].total });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// 식재료 낭비(폐기) 통계
app.get('/api/admin/waste-stats', isAdminConsole, async (req, res) => {
    try {
        const [statusStats, usedLogStats, topWasted, categoryStats] = await Promise.all([
            query(`SELECT status, COUNT(*) AS count
                   FROM pantry
                   WHERE status IN ('used', 'expired')
                   GROUP BY status`),
            query(`SELECT COUNT(*) AS count FROM used_ingredient_logs`),
            query(`SELECT item_name, item_emoji, COUNT(*) AS count
                   FROM pantry
                   WHERE status = 'expired'
                   GROUP BY item_name, item_emoji
                   ORDER BY count DESC LIMIT 10`),
            query(`SELECT category, COUNT(*) AS count
                   FROM pantry
                   WHERE status = 'expired'
                   GROUP BY category
                   ORDER BY count DESC`),
        ]);

        const used    = Number(statusStats.find(r => r.status === 'used')?.count ?? 0) + Number(usedLogStats[0]?.count ?? 0);
        const expired = Number(statusStats.find(r => r.status === 'expired')?.count ?? 0);
        const wasteRate = (used + expired) > 0 ? Math.round((expired / (used + expired)) * 1000) / 10 : 0;

        res.json({ used, expired, wasteRate, topWasted, categoryStats });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// 사용 완료 / 폐기 식재료 목록 (최근순)
app.get('/api/admin/waste-list', isAdminConsole, async (req, res) => {
    try {
        const [usedItems, expiredItems] = await Promise.all([
            query(`SELECT l.id, l.item_name, l.item_emoji, l.category, l.expiry_date, u.name AS user_name
                   FROM used_ingredient_logs l
                   JOIN users u ON l.user_id = u.id
                   ORDER BY l.id DESC LIMIT 50`),
            query(`SELECT p.id, p.item_name, p.item_emoji, p.category, p.expiry_date, u.name AS user_name
                   FROM pantry p
                   JOIN users u ON p.user_id = u.id
                   WHERE p.status = 'expired'
                   ORDER BY p.id DESC LIMIT 50`),
        ]);
        res.json({ usedItems, expiredItems });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// 스캔 로그 (이미지 포함)
app.get('/api/admin/scan-logs', isAdminConsole, async (req, res) => {
    try {
        const rows = await query(`
            SELECT sl.id, sl.user_id, sl.mode, sl.source, sl.item_count,
                   sl.items_json, sl.status, sl.created_at,
                   sl.image_data,
                   u.name AS user_name, u.email AS user_email
            FROM scan_logs sl
            JOIN users u ON sl.user_id = u.id
            ORDER BY sl.created_at DESC
            LIMIT 100
        `);
        auditLog('admin', 'VIEW_SCAN_LOGS', null, null, req.ip);
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

// 스캔 로그 삭제
app.delete('/api/admin/scan-logs/:id', isAdminConsole, async (req, res) => {
    try {
        const result = await query('DELETE FROM scan_logs WHERE id = ?', [req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ success: false, message: '로그를 찾을 수 없습니다.' });
        auditLog('admin', 'DELETE_SCAN_LOG', `scan_log:${req.params.id}`, null, req.ip);
        res.json({ success: true });
    } catch (err) { console.error('스캔 로그 삭제 오류:', err.message); res.status(500).json({ success: false }); }
});

// 감사 로그 조회
app.get('/api/admin/audit-logs', isAdminConsole, async (req, res) => {
    try {
        const rows = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

// ── 레시피 찜 ─────────────────────────────────────────────────
app.post('/api/recipes/save', isLoggedIn, async (req, res) => {
    const { recipe } = req.body;
    if (!recipe?.name) return res.status(400).json({ success: false });
    try {
        const result = await query(
            'INSERT INTO saved_recipes (user_id, recipe_name, recipe_json) VALUES (?, ?, ?)',
            [req.user.id, recipe.name, JSON.stringify(recipe)]
        );
        res.json({ success: true, id: result.insertId });
    } catch { res.status(500).json({ success: false }); }
});

app.get('/api/recipes/saved', isLoggedIn, async (req, res) => {
    try {
        const rows = await query(
            'SELECT id, recipe_name, recipe_json, created_at FROM saved_recipes WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json(rows);
    } catch { res.status(500).json({ success: false }); }
});

app.delete('/api/recipes/saved/:id', isLoggedIn, async (req, res) => {
    try {
        await query('DELETE FROM saved_recipes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

// 요리 완료 - 식재료 사용 처리
// used_ingredients: 문자열 배열("양파 1개") 또는 객체 배열({ name, used_qty, unit })
// 단위 환산은 하지 않으므로 클라이언트가 unit을 보내도 무시하고 항상 펜트리에 저장된 item.unit을 기준으로 기록한다.
app.post('/api/pantry/cook', isLoggedIn, async (req, res) => {
    const { used_ingredients } = req.body;
    if (!Array.isArray(used_ingredients) || !used_ingredients.length)
        return res.status(400).json({ success: false, updatedCount: 0 });

    let conn;
    try {
        conn = await db.promise().getConnection();
        await conn.beginTransaction();

        let updatedCount = 0;
        for (const ingredient of used_ingredients) {
            const isObj        = typeof ingredient === 'object' && ingredient !== null;
            const rawName      = isObj ? ingredient.name : ingredient;
            const name         = (rawName || '').trim().split(/[\s\d(]/)[0];
            const pantryItemId = isObj ? ingredient.pantry_item_id : null;
            const usedQtyRaw   = isObj ? ingredient.used_qty : undefined;
            const usedQty      = (usedQtyRaw === undefined || usedQtyRaw === null || usedQtyRaw === '')
                ? null : Number(usedQtyRaw);

            if (!name && !pantryItemId) continue;
            if (usedQty !== null && (!Number.isFinite(usedQty) || usedQty < 0)) continue; // 비정상 값은 건너뜀

            let rows;
            if (pantryItemId) {
                // ID로 직접 조회 (정확한 매칭)
                [rows] = await conn.query(
                    `SELECT id, item_name, item_emoji, category, quantity, unit, expiry_date FROM pantry
                     WHERE id = ? AND user_id = ? AND status = 'available' LIMIT 1`,
                    [pantryItemId, req.user.id]
                );
            } else {
                [rows] = await conn.query(
                    `SELECT id, item_name, item_emoji, category, quantity, unit, expiry_date FROM pantry
                     WHERE user_id = ? AND status = 'available' AND item_name LIKE ? LIMIT 1`,
                    [req.user.id, `%${name}%`]
                );
            }
            const item = rows[0];
            if (!item) continue;

            const actualQty = usedQty !== null ? usedQty : Number(item.quantity);
            if (!Number.isFinite(actualQty) || actualQty < 0) continue;
            const actualUnit = item.unit || '개';
            const remaining  = Number(item.quantity) - actualQty;

            await conn.query(
                `INSERT INTO used_ingredient_logs (user_id, item_name, item_emoji, category, quantity, unit, expiry_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [req.user.id, item.item_name, item.item_emoji, item.category, actualQty, actualUnit, item.expiry_date]
            );

            if (remaining <= 0) {
                const [result] = await conn.query('DELETE FROM pantry WHERE id = ? AND user_id = ?', [item.id, req.user.id]);
                updatedCount += result.affectedRows;
            } else {
                await conn.query('UPDATE pantry SET quantity = ? WHERE id = ? AND user_id = ?', [remaining, item.id, req.user.id]);
                updatedCount++;
            }
        }

        await conn.commit();
        res.json({ success: true, updatedCount });
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('요리 완료 처리 오류:', err.message);
        res.status(500).json({ success: false, updatedCount: 0 });
    } finally {
        if (conn) conn.release();
    }
});

// ── 유통기한 알림 발송 함수 (크론 + 수동 테스트 공용) ──────────
const sendExpiryPushNotifications = async () => {
    console.log('🔔 유통기한 알림 실행...');
    let sentCount = 0;
    try {
        // 1) 임박/만료 식재료 목록 (구독 정보 제외, 중복 없이)
        const items = await query(`
            SELECT user_id, item_name, item_emoji,
                   DATEDIFF(expiry_date, CURDATE()) AS days_left
            FROM pantry
            WHERE DATEDIFF(expiry_date, CURDATE()) <= 3
              AND status = 'available'
            ORDER BY user_id, days_left ASC
        `);

        if (!items.length) { console.log('알림 대상 없음'); return 0; }

        // 2) 유저별로 아이템 그룹화
        const byUser = {};
        items.forEach(r => {
            if (!byUser[r.user_id]) byUser[r.user_id] = { upcoming: [], expired: [] };
            const target = r.days_left < 0 ? byUser[r.user_id].expired : byUser[r.user_id].upcoming;
            target.push({ name: r.item_name, emoji: r.item_emoji, days: r.days_left });
        });

        // 3) 유저별 모든 구독에 개별 발송
        for (const [userId, { upcoming, expired }] of Object.entries(byUser)) {
            const subs = await query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
            if (!subs.length) continue;

            const lines = [];
            upcoming.forEach(it => lines.push(`${it.emoji} ${it.name} (${it.days === 0 ? 'D-Day' : `D-${it.days}`})`));
            expired.forEach(it  => lines.push(`🗑️ ${it.name} (유통기한 ${Math.abs(it.days)}일 지남)`));

            const title = expired.length > 0 ? '🧊 유통기한 알림 - 정리가 필요해요' : '🧊 유통기한 임박 식재료 알림';
            const body  = expired.length > 0 ? `${lines.join('\n')}\n\n지난 식재료를 버릴지 확인해주세요.` : lines.join('\n');
            const payload = JSON.stringify({ title, body, icon: '/notif-icon-192.png', badge: '/notif-badge-72.png', url: expired.length > 0 ? '/?check=expired' : '/' });

            for (const s of subs) {
                const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
                try {
                    await webpush.sendNotification(sub, payload);
                    sentCount++;
                    console.log(`✅ 알림 전송: 유저 ${userId} (임박 ${upcoming.length} / 만료 ${expired.length})`);
                } catch (e) {
                    console.error(`❌ 알림 실패 유저 ${userId}:`, e.statusCode, e.message);
                    if (e.statusCode === 410 || e.statusCode === 404) {
                        await query('DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]);
                    }
                }
            }
        }
    } catch (err) { console.error('크론잡 오류:', err.message); }
    return sentCount;
};

// ── 크론잡: 매일 오전 7시 / 오후 5시 30분 유통기한 임박/만료 푸시 알림 ──
cron.schedule('0 7 * * *',  () => sendExpiryPushNotifications(), { timezone: 'Asia/Seoul' });
cron.schedule('30 17 * * *', () => sendExpiryPushNotifications(), { timezone: 'Asia/Seoul' });

// ── 관리자: 유통기한 알림 수동 테스트 발송 ───────────────────────
app.post('/api/admin/push-test-expiry', isAdminConsole, async (req, res) => {
    try {
        const sent = await sendExpiryPushNotifications();
        res.json({ success: true, sent });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 기존 DB에 unit 컬럼이 없을 경우 자동 추가
(async () => {
    try {
        const [rows] = await query(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'used_ingredient_logs' AND COLUMN_NAME = 'unit'`,
            [process.env.DB_NAME || 'smartpantry']
        );
        if (!rows.cnt) {
            await query(`ALTER TABLE used_ingredient_logs ADD COLUMN unit VARCHAR(20) DEFAULT '개' AFTER quantity`);
            console.log('✅ used_ingredient_logs.unit 컬럼 추가 완료');
        }
    } catch (e) { console.error('마이그레이션 오류:', e.message); }
})();

app.listen(3000, () => console.log('Backend server running on port 3000 🚀'));
