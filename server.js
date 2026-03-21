require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { google } = require('googleapis');

async function getGoogleSheet() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_NAME);

  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  return doc;
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Configure PostgreSQL first.');
}

app.use(cors({
  origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN.split(',').map(x => x.trim()),
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function query(text, params = []) {
  return pool.query(text, params);
}

function getGoogleCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing');
  }

  return JSON.parse(raw);
}

async function getSheetsClient() {
  const creds = getGoogleCreds();

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

function mapRussianInterviewStatus(status = '') {
  const s = String(status || '').trim();

  if (!s) return 'Новая заявка';

  const known = new Set([
    'Новая заявка',
    'Собеседование',
    'Подтвердил',
    'Не пришёл',
    'Собеседование проведено',
    'Отказ до собеседования',
    'Отказ после собеседования',
    'Отправлен гайд',
    'Тестовое задание',
    'Тест-смена',
    'Принят'
  ]);

  if (known.has(s)) return s;
  return s;
}

function normalizeRow(headers, row, rowIndex) {
  const get = (...names) => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx >= 0) return row[idx] ?? '';
    }
    return '';
  };

  return {
    row_number: rowIndex,
    created_at: get('Дата'),
    telegram_username: get('TG Username', 'Username'),
    telegram_user_id: get('TG ID', 'ID'),
    source: get('Источник', 'Отдкуда вы о нас узнали?'),
    name: get('Имя', 'Как вас зовут?'),
    age: get('Возраст'),
    english: get('Английский', 'Уровень английского'),
    platform: get('Платформа'),
    shift: get('Смены', 'Смена'),
    experience: get('Опыт'),
    profiles: get('Анкеты', 'С какими анкетами работал-а (топ, %)'),
    verification: get('Верификация', 'Вериф'),
    status: get('Статус') || 'Новая заявка',
    interviewer_name: get('Кто проводит собеседование'),
    interview_date: get('Дата собеседования'),
    interview_time: get('Время собеседования'),
    comments: get('Комментарии')
  };
}

const bootstrapSql = `
CREATE TABLE IF NOT EXISTS agencies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  plan TEXT DEFAULT 'starter',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','teamlead','hr')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS candidates (
  id SERIAL PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL DEFAULT '',
  tg TEXT DEFAULT '',
  age TEXT DEFAULT '',
  english TEXT DEFAULT '',
  exp TEXT DEFAULT '',
  platforms TEXT DEFAULT '',
  shift TEXT DEFAULT '',
  schedule TEXT DEFAULT '',
  top_pages TEXT DEFAULT '',
  avg_check TEXT DEFAULT '',
  job TEXT DEFAULT '',
  status TEXT DEFAULT '',
  stage TEXT DEFAULT 'new',
  source TEXT DEFAULT 'manual',
  notes TEXT DEFAULT '',
  ratings JSONB NOT NULL DEFAULT '{}'::jsonb,
  total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS candidate_status_history (
  id SERIAL PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS candidate_ai_insights (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  recommendation TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  summary TEXT NOT NULL,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidates_agency_created ON candidates(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_agency_status ON candidates(agency_id, status);
CREATE INDEX IF NOT EXISTS idx_candidates_agency_owner ON candidates(agency_id, owner_user_id);
`;

async function initDb() {
  await query(bootstrapSql);
}

function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      agencyId: user.agency_id,
      role: user.role,
      email: user.email,
      fullName: user.full_name
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function canSeeCandidate(row, user) {
  if (user.role === 'owner' || user.role === 'teamlead') return true;
  return Number(row.owner_user_id) === Number(user.userId) || Number(row.created_by_user_id) === Number(user.userId);
}

function candidateVerdict(total) {
  if (total >= 40) return 'hire';
  if (total >= 28) return 'review';
  if (total > 0) return 'reject';
  return 'unrated';
}

function buildAiInsight(candidate) {
  const strengths = [];
  const risks = [];

  if ((candidate.english || '').match(/B2|C1|Native/i)) strengths.push('Сильный английский для premium-фанов');
  if ((candidate.exp || '').trim() && Number(candidate.exp) >= 1) strengths.push('Есть подтвержденный опыт в adult/продажах');
  if ((candidate.platforms || '').includes('OnlyFans') || (candidate.platforms || '').includes('Fansly')) strengths.push('Знает профильные платформы');
  if ((candidate.schedule || '').includes('6/1')) strengths.push('Готов к интенсивному графику');
  if ((candidate.total || 0) >= 40) strengths.push('Высокий score по интервью');

  if (!candidate.exp) risks.push('Не указан опыт — нужен дополнительный скрининг');
  if ((candidate.total || 0) < 28) risks.push('Низкий балл по чеклисту');
  if (!candidate.shift) risks.push('Не зафиксированы смены');
  if (!candidate.status) risks.push('Нет статуса после звонка');
  if ((candidate.notes || '').length < 25) risks.push('Мало заметок — низкая прозрачность решения');

  const total = Number(candidate.total || 0);
  let recommendation = 'REVIEW';
  let confidence = 62;

  if (total >= 40) {
    recommendation = 'HIRE';
    confidence = 82;
  } else if (total < 28 && total > 0) {
    recommendation = 'REJECT';
    confidence = 77;
  }

  const summary = recommendation === 'HIRE'
    ? 'Кандидат выглядит сильным для тест-смены или оффера. Есть признаки fit по метрикам и по процессу.'
    : recommendation === 'REJECT'
      ? 'Кандидат пока слабый: либо мало структуры в ответах, либо заметны риски по графику/опыту/результатам.'
      : 'Нужна дополнительная проверка: тест-смена, примеры переписок или уточнение по цифрам и загрузке.';

  return {
    recommendation,
    confidence,
    summary,
    strengths: strengths.slice(0, 4),
    risks: risks.slice(0, 4)
  };
}

app.post('/auth/register', async (req, res) => {
  try {
    const { agencyName, fullName, email, password } = req.body || {};

    if (!agencyName || !fullName || !email || !password) {
      return res.status(400).json({ error: 'agencyName, fullName, email, password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const agencySlug = agencyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const agency = await query(
      'INSERT INTO agencies(name, slug) VALUES ($1,$2) RETURNING *',
      [agencyName, `${agencySlug || 'agency'}-${Date.now().toString().slice(-5)}`]
    );

    const hash = await bcrypt.hash(password, 10);

    const user = await query(
      `INSERT INTO users(agency_id, full_name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,'owner')
       RETURNING id, agency_id, full_name, email, role`,
      [agency.rows[0].id, fullName, normalizedEmail, hash]
    );

    const token = signToken(user.rows[0]);

    res.status(201).json({
      token,
      user: user.rows[0],
      agency: agency.rows[0]
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();

    const result = await query(
      'SELECT * FROM users WHERE email = $1 AND is_active = TRUE LIMIT 1',
      [normalizedEmail]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const ok = await bcrypt.compare(password || '', user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        agency_id: user.agency_id,
        full_name: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/auth/me', auth, async (req, res) => {
  const user = await query(
    `SELECT u.id, u.agency_id, u.full_name, u.email, u.role, a.name AS agency_name
     FROM users u
     JOIN agencies a ON a.id = u.agency_id
     WHERE u.id = $1`,
    [req.user.userId]
  );

  res.json(user.rows[0] || null);
});

app.get('/users', auth, requireRole('owner', 'teamlead'), async (req, res) => {
  const users = await query(
    `SELECT id, full_name, email, role, is_active, created_at
     FROM users
     WHERE agency_id = $1
     ORDER BY created_at DESC`,
    [req.user.agencyId]
  );

  res.json(users.rows);
});

app.post('/users', auth, requireRole('owner'), async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body || {};

    if (!fullName || !email || !password || !role) {
      return res.status(400).json({ error: 'fullName, email, password, role are required' });
    }

    if (!['owner', 'teamlead', 'hr'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const hash = await bcrypt.hash(password, 10);

    const created = await query(
      `INSERT INTO users(agency_id, full_name, email, password_hash, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, agency_id, full_name, email, role, is_active, created_at`,
      [req.user.agencyId, fullName, normalizedEmail, hash, role]
    );

    res.status(201).json(created.rows[0]);
  } catch (err) {
    console.error('Create user error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.patch('/users/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    const { fullName, role, isActive, password } = req.body || {};

    const found = await query(
      'SELECT * FROM users WHERE id = $1 AND agency_id = $2 LIMIT 1',
      [req.params.id, req.user.agencyId]
    );

    if (!found.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const current = found.rows[0];
    const nextFullName = fullName ?? current.full_name;
    const nextRole = role ?? current.role;
    const nextIsActive = typeof isActive === 'boolean' ? isActive : current.is_active;
    let nextPasswordHash = current.password_hash;

    if (!['owner', 'teamlead', 'hr'].includes(nextRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      nextPasswordHash = await bcrypt.hash(password, 10);
    }

    const updated = await query(
      `UPDATE users
       SET full_name = $3,
           role = $4,
           is_active = $5,
           password_hash = $6
       WHERE id = $1 AND agency_id = $2
       RETURNING id, agency_id, full_name, email, role, is_active, created_at`,
      [req.params.id, req.user.agencyId, nextFullName, nextRole, nextIsActive, nextPasswordHash]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.get('/candidates', auth, async (req, res) => {
  const { search = '', status = '', verdict = '', ownerId = '' } = req.query;
  const params = [req.user.agencyId];
  let where = 'WHERE c.agency_id = $1';

  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where += ` AND (
      LOWER(c.name) LIKE $${params.length}
      OR LOWER(c.tg) LIKE $${params.length}
      OR LOWER(c.english) LIKE $${params.length}
      OR LOWER(c.platforms) LIKE $${params.length}
      OR LOWER(c.notes) LIKE $${params.length}
    )`;
  }

  if (status) {
    params.push(status);
    where += ` AND c.status = $${params.length}`;
  }

  if (ownerId) {
    params.push(Number(ownerId));
    where += ` AND c.owner_user_id = $${params.length}`;
  }

  if (req.user.role === 'hr') {
    params.push(req.user.userId);
    where += ` AND (c.owner_user_id = $${params.length} OR c.created_by_user_id = $${params.length})`;
  }

  const result = await query(
    `SELECT c.*,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name
     FROM candidates c
     LEFT JOIN users owner ON owner.id = c.owner_user_id
     LEFT JOIN users creator ON creator.id = c.created_by_user_id
     ${where}
     ORDER BY c.created_at DESC`,
    params
  );

  let rows = result.rows;
  if (verdict) rows = rows.filter(r => candidateVerdict(r.total) === verdict);

  res.json(rows);
});

app.post('/candidates', auth, async (req, res) => {
  const { fields = {}, ratings = {}, total = 0, ownerUserId } = req.body || {};

  const candidate = await query(
    `INSERT INTO candidates(
      agency_id, owner_user_id, created_by_user_id, updated_by_user_id,
      name, tg, age, english, exp, platforms, shift, schedule, top_pages, avg_check, job, status, source, notes, ratings, total
    ) VALUES (
      $1,$2,$3,$3,
      $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    ) RETURNING *`,
    [
      req.user.agencyId,
      ownerUserId || req.user.userId,
      req.user.userId,
      fields.name || '',
      fields.tg || '',
      fields.age || '',
      fields.english || '',
      fields.exp || '',
      fields.platforms || '',
      fields.shift || '',
      fields.schedule || '',
      fields.top || '',
      fields.avgcheck || '',
      fields.job || '',
      fields.status || '',
      fields.source || 'manual',
      fields.notes || '',
      JSON.stringify(ratings),
      total || 0
    ]
  );

  if (fields.status) {
    await query(
      `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
       VALUES ($1,$2,$3)`,
      [candidate.rows[0].id, fields.status, req.user.userId]
    );
  }

  const ai = buildAiInsight(candidate.rows[0]);

  await query(
    `INSERT INTO candidate_ai_insights(candidate_id, recommendation, confidence, summary, strengths, risks)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     ON CONFLICT (candidate_id)
     DO UPDATE SET recommendation = EXCLUDED.recommendation,
                   confidence = EXCLUDED.confidence,
                   summary = EXCLUDED.summary,
                   strengths = EXCLUDED.strengths,
                   risks = EXCLUDED.risks,
                   generated_at = NOW()`,
    [candidate.rows[0].id, ai.recommendation, ai.confidence, ai.summary, JSON.stringify(ai.strengths), JSON.stringify(ai.risks)]
  );

  res.status(201).json(candidate.rows[0]);
});

app.patch('/candidates/:id', auth, async (req, res) => {
  const existing = await query(
    'SELECT * FROM candidates WHERE id = $1 AND agency_id = $2 LIMIT 1',
    [req.params.id, req.user.agencyId]
  );

  const row = existing.rows[0];

  if (!row) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (!canSeeCandidate(row, req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { fields = {}, ratings, total, ownerUserId } = req.body || {};

  const next = {
    name: fields.name ?? row.name,
    tg: fields.tg ?? row.tg,
    age: fields.age ?? row.age,
    english: fields.english ?? row.english,
    exp: fields.exp ?? row.exp,
    platforms: fields.platforms ?? row.platforms,
    shift: fields.shift ?? row.shift,
    schedule: fields.schedule ?? row.schedule,
    top_pages: fields.top ?? row.top_pages,
    avg_check: fields.avgcheck ?? row.avg_check,
    job: fields.job ?? row.job,
    status: fields.status ?? row.status,
    source: fields.source ?? row.source,
    notes: fields.notes ?? row.notes,
    ratings: ratings ?? row.ratings,
    total: total ?? row.total,
    owner_user_id: ownerUserId ?? row.owner_user_id
  };

  const updated = await query(
    `UPDATE candidates
     SET owner_user_id = $3,
         updated_by_user_id = $4,
         updated_at = NOW(),
         name = $5, tg = $6, age = $7, english = $8, exp = $9, platforms = $10,
         shift = $11, schedule = $12, top_pages = $13, avg_check = $14,
         job = $15, status = $16, source = $17, notes = $18, ratings = $19::jsonb, total = $20
     WHERE id = $1 AND agency_id = $2
     RETURNING *`,
    [
      req.params.id,
      req.user.agencyId,
      next.owner_user_id,
      req.user.userId,
      next.name, next.tg, next.age, next.english, next.exp,
      next.platforms, next.shift, next.schedule, next.top_pages,
      next.avg_check, next.job, next.status, next.source, next.notes,
      JSON.stringify(next.ratings), next.total
    ]
  );

  if (next.status && next.status !== row.status) {
    await query(
      `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
       VALUES ($1,$2,$3)`,
      [req.params.id, next.status, req.user.userId]
    );
  }

  const ai = buildAiInsight(updated.rows[0]);

  await query(
    `INSERT INTO candidate_ai_insights(candidate_id, recommendation, confidence, summary, strengths, risks)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     ON CONFLICT (candidate_id)
     DO UPDATE SET recommendation = EXCLUDED.recommendation,
                   confidence = EXCLUDED.confidence,
                   summary = EXCLUDED.summary,
                   strengths = EXCLUDED.strengths,
                   risks = EXCLUDED.risks,
                   generated_at = NOW()`,
    [req.params.id, ai.recommendation, ai.confidence, ai.summary, JSON.stringify(ai.strengths), JSON.stringify(ai.risks)]
  );

  res.json(updated.rows[0]);
});

app.delete('/candidates/:id', auth, async (req, res) => {
  const existing = await query(
    'SELECT * FROM candidates WHERE id = $1 AND agency_id = $2 LIMIT 1',
    [req.params.id, req.user.agencyId]
  );

  const row = existing.rows[0];

  if (!row) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (!canSeeCandidate(row, req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await query(
    'DELETE FROM candidates WHERE id = $1 AND agency_id = $2',
    [req.params.id, req.user.agencyId]
  );

  res.json({ ok: true });
});

app.get('/candidates/:id/history', auth, async (req, res) => {
  const check = await query(
    'SELECT * FROM candidates WHERE id = $1 AND agency_id = $2 LIMIT 1',
    [req.params.id, req.user.agencyId]
  );

  if (!check.rows[0]) {
    return res.status(404).json({ error: 'Not found' });
  }

  const history = await query(
    `SELECT h.*, u.full_name AS changed_by_name
     FROM candidate_status_history h
     LEFT JOIN users u ON u.id = h.changed_by_user_id
     WHERE h.candidate_id = $1
     ORDER BY h.created_at DESC`,
    [req.params.id]
  );

  const insight = await query(
    'SELECT * FROM candidate_ai_insights WHERE candidate_id = $1',
    [req.params.id]
  );

  res.json({
    history: history.rows,
    ai: insight.rows[0] || null
  });
});

app.get('/analytics/overview', auth, async (req, res) => {
  const baseFilter = req.user.role === 'hr'
    ? 'WHERE c.agency_id = $1 AND (c.owner_user_id = $2 OR c.created_by_user_id = $2)'
    : 'WHERE c.agency_id = $1';

  const params = req.user.role === 'hr'
    ? [req.user.agencyId, req.user.userId]
    : [req.user.agencyId];

  const totals = await query(
    `SELECT
      COUNT(*)::int AS total_candidates,
      COALESCE(AVG(total), 0)::numeric(10,2) AS avg_score,
      COUNT(*) FILTER (WHERE status = 'Принят')::int AS hired,
      COUNT(*) FILTER (WHERE status = 'Тест-смена')::int AS trial,
      COUNT(*) FILTER (WHERE status = 'Изучает гайд')::int AS guide,
      COUNT(*) FILTER (WHERE status = 'Отказ')::int AS rejected
     FROM candidates c
     ${baseFilter}`,
    params
  );

  const byHr = await query(
    `SELECT
      COALESCE(u.full_name, 'Без владельца') AS hr_name,
      COUNT(c.id)::int AS total,
      COUNT(c.id) FILTER (WHERE c.status = 'Принят')::int AS hired,
      COALESCE(AVG(c.total), 0)::numeric(10,2) AS avg_score
     FROM candidates c
     LEFT JOIN users u ON u.id = c.owner_user_id
     ${baseFilter}
     GROUP BY COALESCE(u.full_name, 'Без владельца')
     ORDER BY total DESC, hired DESC`,
    params
  );

  const statusFunnel = await query(
    `SELECT COALESCE(status, 'Без статуса') AS status, COUNT(*)::int AS count
     FROM candidates c
     ${baseFilter}
     GROUP BY COALESCE(status, 'Без статуса')
     ORDER BY count DESC`,
    params
  );

  const bestProfiles = await query(
    `SELECT english, platforms, schedule, COUNT(*)::int AS total, ROUND(AVG(total), 2) AS avg_score
     FROM candidates c
     ${baseFilter}
     GROUP BY english, platforms, schedule
     HAVING COUNT(*) >= 1
     ORDER BY avg_score DESC, total DESC
     LIMIT 8`,
    params
  );

  res.json({
    overview: totals.rows[0],
    byHr: byHr.rows,
    statusFunnel: statusFunnel.rows,
    bestProfiles: bestProfiles.rows
  });
});

app.get('/dashboard/feed', auth, async (req, res) => {
  const params = [req.user.agencyId];
  let where = 'WHERE c.agency_id = $1';

  if (req.user.role === 'hr') {
    params.push(req.user.userId);
    where += ' AND (c.owner_user_id = $2 OR c.created_by_user_id = $2)';
  }

  const recent = await query(
    `SELECT c.id, c.name, c.status, c.total, c.updated_at, u.full_name AS owner_name
     FROM candidates c
     LEFT JOIN users u ON u.id = c.owner_user_id
     ${where}
     ORDER BY c.updated_at DESC
     LIMIT 10`,
    params
  );

  res.json(recent.rows);
});

app.get('/leads', async (req, res) => {
  try {
    const doc = await getGoogleSheet();

    const sheet = doc.sheetsByTitle['AllStarsLeads']; // главный лист
    const rows = await sheet.getRows();

    const leads = rows.map(row => ({
      name: row['Имя'],
      tg: row['TG Username'],
      tg_id: row['TG ID'],
      age: row['Возраст'],
      english: row['Английский'],
      platform: row['Платформа'],
      shift: row['Смены'],
      exp: row['Опыт'],
      status: row['Статус'],
      interviewer: row['Кто проводит собеседование'],
      interview_date: row['Дата собеседования'],
      interview_time: row['Время собеседования'],
      comment: row['Комментарии']
    }));

    res.json(leads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка чтения таблицы' });
  }
});

app.get('/api/interviews', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ error: 'GOOGLE_SPREADSHEET_ID is missing' });
    }

    const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';
    const sheets = await getSheetsClient();

    const range = `${sheetName}!A1:Q5000`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    const values = response.data.values || [];

    if (!values.length) {
      return res.json([]);
    }

    const headers = values[0];
    const rows = values.slice(1);

    const normalized = rows
      .map((row, index) => normalizeRow(headers, row, index + 2))
      .filter(x => x.telegram_user_id || x.telegram_username || x.name)
      .sort((a, b) => {
        const ad = String(a.created_at || '');
        const bd = String(b.created_at || '');

        const parseRuDate = (s) => {
          const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
          if (!m) return 0;
          const [, dd, mm, yyyy, hh = '00', min = '00'] = m;
          return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`).getTime();
        };

        return parseRuDate(bd) - parseRuDate(ad);
      });

    res.json(normalized);
  } catch (err) {
    console.error('Google Sheets read error:', err.message);
    res.status(500).json({ error: 'Failed to read Google Sheet' });
  }
});

app.patch('/api/interviews/:rowNumber', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ error: 'GOOGLE_SPREADSHEET_ID is missing' });
    }

    const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';
    const rowNumber = Number(req.params.rowNumber);

    if (!rowNumber || rowNumber < 2) {
      return res.status(400).json({ error: 'Invalid row number' });
    }

    const {
      status = '',
      interviewer_name = '',
      interview_date = '',
      interview_time = '',
      comments = ''
    } = req.body || {};

    const sheets = await getSheetsClient();

    // M = Статус
    // N = Кто проводит собеседование
    // O = Дата собеседования
    // P = Время собеседования
    // Q = Комментарии
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${sheetName}!M${rowNumber}`, values: [[status]] },
          { range: `${sheetName}!N${rowNumber}`, values: [[interviewer_name]] },
          { range: `${sheetName}!O${rowNumber}`, values: [[interview_date]] },
          { range: `${sheetName}!P${rowNumber}`, values: [[interview_time]] },
          { range: `${sheetName}!Q${rowNumber}`, values: [[comments]] }
        ]
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Google Sheets write error:', err.message);
    res.status(500).json({ error: 'Failed to update Google Sheet' });
  }
});

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`AllStars HR SaaS running on ${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
}

start();