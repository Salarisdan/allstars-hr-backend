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
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  console.warn('WARNING: JWT_SECRET not set, using insecure default for development only');
}

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

function parseSheetDate(value) {
  if (!value) return null;

  if (value instanceof Date) return value;

  const s = String(value).trim();
  if (!s) return null;

  const native = new Date(s);
  if (!Number.isNaN(native.getTime())) return native;

  const m1 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (m1) {
    const [, dd, mm, yyyy, hh = '00', min = '00'] = m1;
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`);
  }

  return null;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const CANDIDATE_STATUSES = [
  'Изучает гайд',
  'Тест смена',
  'Принятый',
  'Отказ',
  'Работает',
  'Ожидание старта',
  'Верификация',
  'Ждет тест',
  'Хочу взять',
  'Ждет собеседования',
  'Лист ожидания',
  'Уволен',
  'Не рассчитан',
  'Нет ответа',
  'Убрать'
];

const INTERVIEW_STATUSES = [
  'Работает',
  'Ожидание старта',
  'Верификация',
  'Ждет тест',
  'Изучает гайд',
  'Хочу взять',
  'Ждет собеседования',
  'Лист ожидания',
  'Уволен',
  'Не рассчитан',
  'Нет ответа',
  'Убрать',
  'Тест смена',
  'Принятый',
  'Отказ'
];

const TEAM_STATUSES = [
  'Работает',
  'Ожидание старта',
  'Верификация',
  'Ждет тест',
  'Изучает гайд',
  'Хочу взять',
  'Ждет собеседования',
  'Лист ожидания',
  'Уволен',
  'Не рассчитан',
  'Нет ответа',
  'Убрать',
  'Тест смена',
  'Принятый',
  'Отказ'
];

const TEAM_STATUSES_CLEAR_TRANSACTION_ENDING = new Set([
  'Уволен',
  'Нет ответа',
  'Убрать'
]);

function shouldClearTransactionEndingByStatus(status) {
  return TEAM_STATUSES_CLEAR_TRANSACTION_ENDING.has(String(status || '').trim());
}

function normalizePersonKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\(f\)/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSexterEnding(value) {
  const s = String(value || '').trim();
  const match = s.match(/5[,.](\d{2})$/);
  if (!match) return null;

  const n = Number(match[1]);
  return n >= 1 && n <= 99 ? n : null;
}

function namesLooselyMatch(a, b) {
  const x = normalizePersonKey(a);
  const y = normalizePersonKey(b);

  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

async function readSexterEndingMap() {
  const spreadsheetId = process.env.SHELL_OF_SPREADSHEET_ID;
  const sheetName = process.env.SHELL_OF_SEXTER_SHEET_NAME || '# sexter';

  if (!spreadsheetId) {
    throw new Error('SHELL_OF_SPREADSHEET_ID is missing');
  }

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z200`
  });

  const values = response.data.values || [];
  const used = [];

  for (const row of values) {
    let ending = null;
    let endingRaw = '';
    let name = '';

    for (const cell of row) {
      const n = extractSexterEnding(cell);
      if (n !== null) {
        ending = n;
        endingRaw = String(cell || '').trim();
        break;
      }
    }

    if (ending === null) continue;

    for (const cell of row) {
      const text = String(cell || '').trim();
      if (!text) continue;
      if (extractSexterEnding(text) !== null) continue;
      if (/^\d+$/.test(text)) continue;
      if (text.toLowerCase() === 'number example') continue;

      name = text;
      break;
    }

    used.push({
      ending,
      ending_raw: endingRaw,
      name,
      person_key: normalizePersonKey(name)
    });
  }

  used.sort((a, b) => a.ending - b.ending);

  const usedSet = new Set(used.map(x => x.ending));
  const free = [];
  for (let i = 1; i <= 99; i++) {
    if (!usedSet.has(i)) free.push(i);
  }

  return {
    used,
    free,
    used_count: used.length,
    free_count: free.length
  };
}

async function clearSexterEndingByName(personName) {
  const spreadsheetId = process.env.SHELL_OF_SPREADSHEET_ID;
  const sheetName = process.env.SHELL_OF_SEXTER_SHEET_NAME || '# sexter';

  if (!spreadsheetId || !personName) return false;

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z200`
  });

  const values = response.data.values || [];
  if (!values.length) return false;

  let matchedRow = -1;
  let matchedCol = -1;

  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];

    let rowName = '';
    let rowEndingCol = -1;

    for (let c = 0; c < row.length; c++) {
      const text = String(row[c] || '').trim();
      if (!text) continue;

      if (extractSexterEnding(text) !== null) {
        rowEndingCol = c;
      } else if (!/^\d+$/.test(text) && text.toLowerCase() !== 'number example' && !rowName) {
        rowName = text;
      }
    }

    if (!rowName || rowEndingCol === -1) continue;

    if (namesLooselyMatch(personName, rowName)) {
      matchedRow = r + 1;
      matchedCol = rowEndingCol + 1;
      break;
    }
  }

  if (matchedRow === -1 || matchedCol === -1) return false;

  const colLetter = columnToLetter(matchedCol);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${colLetter}${matchedRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['']]
    }
  });

  return true;
}

function normalizeCandidateStatus(value) {
  const s = String(value || '').trim();
  return CANDIDATE_STATUSES.includes(s) ? s : '';
}

function normalizeInterviewStatus(value) {
  const s = String(value || '').trim();
  return INTERVIEW_STATUSES.includes(s) ? s : '';
}

function normalizeTeamStatus(value) {
  const s = String(value || '').trim();
  return TEAM_STATUSES.includes(s) ? s : '';
}

function parseNumberLoose(value) {
  if (value === null || value === undefined) return 0;

  const s = String(value).trim().replace(',', '.');
  const n = Number(s);

  return Number.isFinite(n) ? n : 0;
}

function countByPeriod(rows, dateField, predicate, days = null) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);

  let total = 0;
  let month = 0;
  let week = 0;

  for (const row of rows) {
    if (predicate && !predicate(row)) continue;

    total++;

    const dt = parseSheetDate(row[dateField]);
    if (!dt) continue;

    if (dt >= monthStart) month++;
    if (dt >= weekStart) week++;
  }

  return { total, month, week };
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
    id: rowIndex,
    row_number: rowIndex,
    created_at: get('Дата'),
    telegram_username: get('TG Username', 'Username'),
    telegram: get('TG Username', 'Username'),
    username: get('TG Username', 'Username'),
    telegram_user_id: get('TG ID', 'ID'),
    tg: get('TG Username', 'Username'),
    source: get('Источник', 'Откуда вы о нас узнали?'),
    name: get('Имя', 'Как вас зовут?'),
    age: get('Возраст'),
    english: get('Английский', 'Уровень английского'),
    english_level: get('Английский', 'Уровень английского'),
    platform: get('Платформа'),
    platforms: get('Платформа'),
    shift: get('Смены', 'Смена'),
    experience: get('Опыт'),
    exp: get('Опыт'),
    profiles: get('Анкеты', 'С какими анкетами работал-а (топ, %)'),
    top_profile: get('Анкеты', 'С какими анкетами работал-а (топ, %)'),
    verification: get('Верификация', 'Вериф'),
    status: get('Статус') || 'Новая заявка',
    interviewer: get('Кто проводит собеседование'),
    interviewer_name: get('Кто проводит собеседование'),
    owner_name: get('Кто проводит собеседование'),
    interview_date: get('Дата собеседования'),
    interview_time: get('Время собеседования'),
    notes: get('Комментарии'),
    comments: get('Комментарии')
  };
}

function columnToLetter(column) {
  let temp = '';
  let letter = '';

  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }

  return letter;
}

function sanitizeTeamFieldLabel(label) {
  return String(label || '').trim();
}

function normalizePlatformForTeam(value) {
  const s = String(value || '').trim().toLowerCase();

  if (!s) return '';
  if (s.includes('onlyfans') || s === 'of') return 'OnlyFans';
  if (s.includes('fansly')) return 'Fansly';
  if (s.includes('обе') || s.includes('оба') || s.includes('both')) return 'OnlyFans / Fansly';
  if (s.includes('km')) return 'KM';

  return String(value || '').trim();
}

function normalizeShiftForTeam(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';

  const shifts = [];

  if (s.includes('00–06') || s.includes('00-06') || s.includes('0-6') || s.includes('0–6')) {
    shifts.push('00-06');
  }
  if (s.includes('06–12') || s.includes('06-12') || s.includes('6-12') || s.includes('6–12')) {
    shifts.push('06-12');
  }
  if (s.includes('12–18') || s.includes('12-18')) {
    shifts.push('12-18');
  }
  if (s.includes('18–00') || s.includes('18-00') || s.includes('18-24')) {
    shifts.push('18-00');
  }

  return shifts.join(', ');
}

function parseExperienceMonthsLoose(value) {
  const s = String(value || '').trim().toLowerCase().replace(',', '.');
  if (!s) return '';

  if (
    s === 'нет' ||
    s === '0' ||
    s.includes('нет опыта') ||
    s.includes('без опыта')
  ) {
    return '0';
  }

  if (s.includes('полгода') || s.includes('пол года')) {
    return '6';
  }

  const years = s.match(/(\d+(?:\.\d+)?)\s*(год|года|лет)/);
  if (years) {
    return String(Math.round(Number(years[1]) * 12));
  }

  const months = s.match(/(\d+(?:\.\d+)?)\s*(месяц|месяца|месяцев|мес)/);
  if (months) {
    return String(Math.round(Number(months[1])));
  }

  const plain = s.match(/(\d+(?:\.\d+)?)/);
  if (plain) {
    return String(Math.round(Number(plain[1])));
  }

  return '';
}

function normalizeTelegramForTeam(value) {
  const s = String(value || '').trim();
  if (!s) return '';

  if (s.startsWith('@')) return s;
  return `@${s}`;
}

function normalizeNeedStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  return ['none', 'search', 'urgent', 'bg'].includes(s) ? s : 'none';
}

function normalizeNeedPlatform(value) {
  const s = String(value || '').trim().toLowerCase();
  return s === 'fansly' ? 'fansly' : 'onlyfans';
}

async function moveCandidateToTeamSheet(candidate) {
  const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
  const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

  if (!spreadsheetId) {
    throw new Error('TEAM_SPREADSHEET_ID is missing');
  }

  const sheets = await getSheetsClient();

  const headersRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:AU1`
  });

  const headers = headersRes.data.values?.[0] || [];
  if (!headers.length) {
    throw new Error('Headers not found in team sheet');
  }

  const rowMap = {
    'Имя': candidate.name || '',
    'Телеграм': candidate.tg || '',
    'Актуальный статус кандидата (Hr)': 'Ждет тест',
    'OnlyFans / Fansly': candidate.platforms || '',
    'Смены (основные)': candidate.shift || '',
    'Опыт, мес.': candidate.exp || '',
    'Английский': candidate.english || '',
    'Комментарий': candidate.notes || ''
  };

  const row = headers.map(h => rowMap[String(h || '').trim()] ?? '');

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:AU`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row]
    }
  });

  teamStatsCache = {
    data: null,
    ts: 0
  };
}

async function teamSheetHasCandidateByTelegram(telegram) {
  const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
  const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

  if (!spreadsheetId || !telegram) return false;

  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:AU5000`
  });

  const values = response.data.values || [];
  if (!values.length) return false;

  const headers = values[0];
  const rows = values.slice(1);

  const telegramIdx =
    headers.indexOf('Телеграм') >= 0 ? headers.indexOf('Телеграм')
    : headers.indexOf('Telegram') >= 0 ? headers.indexOf('Telegram')
    : -1;

  if (telegramIdx === -1) return false;

  const normalized = String(telegram).trim().toLowerCase();

  return rows.some(row => String(row[telegramIdx] || '').trim().toLowerCase() === normalized);
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

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE users
    ADD CONSTRAINT users_email_unique UNIQUE (email)
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_needs (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN ('onlyfans', 'fansly')),
      model_name TEXT NOT NULL,
      shift_00_06 TEXT NOT NULL DEFAULT 'none' CHECK (shift_00_06 IN ('none', 'search', 'urgent', 'bg')),
      shift_06_12 TEXT NOT NULL DEFAULT 'none' CHECK (shift_06_12 IN ('none', 'search', 'urgent', 'bg')),
      shift_12_18 TEXT NOT NULL DEFAULT 'none' CHECK (shift_12_18 IN ('none', 'search', 'urgent', 'bg')),
      shift_18_00 TEXT NOT NULL DEFAULT 'none' CHECK (shift_18_00 IN ('none', 'search', 'urgent', 'bg')),
      comment TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE hr_needs
    ADD CONSTRAINT hr_needs_platform_model_name_unique
    UNIQUE (platform, model_name)
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE hr_needs
    ADD COLUMN IF NOT EXISTS top_percent TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS operator_salary_percent TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS experience_kd_months TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS avg_shift_check TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS revenue_month_k TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    INSERT INTO hr_needs (platform, model_name, shift_00_06, shift_06_12, shift_12_18, shift_18_00)
    VALUES

    -- ONLYFANS
    ('onlyfans','Judy','none','none','none','none'),
    ('onlyfans','Riley','urgent','urgent','none','urgent'),
    ('onlyfans','Eva','none','none','none','none'),
    ('onlyfans','Sofia','urgent','urgent','none','none'),
    ('onlyfans','Ivanka','none','urgent','urgent','none'),
    ('onlyfans','Ivy','none','none','none','none'),
    ('onlyfans','Alyaska','none','none','none','none'),
    ('onlyfans','Alyaska 3','none','none','none','none'),
    ('onlyfans','Иванка фри','none','none','none','none'),

    -- FANSLY
    ('fansly','Sofia','none','none','search','none'),
    ('fansly','Sia','none','none','search','none'),
    ('fansly','Riley','none','none','search','none'),
    ('fansly','Ivanka','none','none','none','none'),
    ('fansly','Eva','none','none','none','none'),
    ('fansly','Eira','none','none','none','none'),
    ('fansly','Ivy','none','none','none','none'),
    ('fansly','Kate','none','none','none','none'),
    ('fansly','Leia','none','none','none','none'),
    ('fansly','Kiana','none','none','none','none'),
    ('fansly','Judy','none','none','none','none'),
    ('fansly','Alyaska','none','none','none','none')

    ON CONFLICT (platform, model_name) DO NOTHING;
  `);
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

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `SELECT id, agency_id, full_name, email, role, is_active
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [decoded.id || decoded.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Доступ отключён' });
    }

    req.user = {
      ...user,
      userId: user.id,
      agencyId: user.agency_id
    };

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
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Введите email и пароль' });
    }

    const result = await pool.query(
      `SELECT id, agency_id, email, password_hash, full_name, role, is_active
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Доступ отключён' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      me: {
        id: user.id,
        email: user.email,
        name: user.full_name,
        role: user.role,
        is_active: user.is_active
      },
      user: {
        id: user.id,
        agency_id: user.agency_id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        is_active: user.is_active
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         email,
         full_name AS name,
         role,
         is_active,
         created_at
       FROM users
       WHERE agency_id = $1
       ORDER BY created_at DESC, id DESC`,
      [req.user.agencyId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Users list error:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить пользователей' });
  }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'hr').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'Email обязателен' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Имя обязательно' });
    }

    if (!['owner', 'teamlead', 'hr'].includes(role)) {
      return res.status(400).json({ error: 'Некорректная роль' });
    }

    const exists = await pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (exists.rows.length) {
      return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (
        agency_id,
        full_name,
        email,
        password_hash,
        role,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, email, full_name AS name, role, is_active, created_at`,
      [req.user.agencyId, name, email, passwordHash, role]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create user error:', err.message);
    res.status(500).json({ error: 'Не удалось создать пользователя' });
  }
});

app.patch('/api/users/:id/status', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const isActive = Boolean(req.body?.is_active);

    if (!id) {
      return res.status(400).json({ error: 'Некорректный id' });
    }

    const result = await pool.query(
      `UPDATE users
       SET is_active = $1
       WHERE id = $2 AND agency_id = $3
       RETURNING id, email, full_name AS name, role, is_active`,
      [isActive, id, req.user.agencyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('User status update error:', err.message);
    res.status(500).json({ error: 'Не удалось обновить статус пользователя' });
  }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Некорректный id' });
    }

    const result = await pool.query(
      `DELETE FROM users
       WHERE id = $1 AND agency_id = $2
       RETURNING id`,
      [id, req.user.agencyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete user error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить пользователя' });
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

app.get('/api/status-options', auth, async (_req, res) => {
  res.json({
    candidates: CANDIDATE_STATUSES,
    interviews: INTERVIEW_STATUSES,
    team: TEAM_STATUSES
  });
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
  const normalizedCandidateStatus = normalizeCandidateStatus(fields.status);

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
      normalizedCandidateStatus,
      fields.source || 'manual',
      fields.notes || '',
      JSON.stringify(ratings),
      total || 0
    ]
  );

  if (normalizedCandidateStatus) {
    await query(
      `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
       VALUES ($1,$2,$3)`,
      [candidate.rows[0].id, normalizedCandidateStatus, req.user.userId]
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
    status: fields.status !== undefined ? normalizeCandidateStatus(fields.status) : row.status,
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

    if (next.status === 'Тест смена') {
      try {
        const alreadyExists = await teamSheetHasCandidateByTelegram(updated.rows[0].tg || updated.rows[0].telegram || '');

        if (!alreadyExists) {
          await moveCandidateToTeamSheet(updated.rows[0]);
        }
      } catch (teamErr) {
        console.error('Move candidate to team sheet error:', teamErr.message);
      }
    }
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

app.get('/leads', auth, async (req, res) => {
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

    const range = `${sheetName}!A1:AU5000`;

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

app.get('/api/interviews/:rowNumber', auth, async (req, res) => {
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

    const sheets = await getSheetsClient();

    const [headersRes, rowRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:AU1`
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A${rowNumber}:AU${rowNumber}`
      })
    ]);

    const headers = headersRes.data.values?.[0] || [];
    const row = rowRes.data.values?.[0] || [];

    if (!row.length) {
      return res.status(404).json({ error: 'Row not found' });
    }

    const candidate = normalizeRow(headers, row, rowNumber);
    res.json(candidate);
  } catch (err) {
    console.error('Interview row read error:', err.message);
    res.status(500).json({ error: 'Failed to read interview row' });
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

    const sheets = await getSheetsClient();

    // Get headers first
    const headersRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU1`
    });

    const headers = headersRes.data.values?.[0] || [];

    // Helper to find column index by field names
    const findColumnIndex = (...names) => {
      for (const name of names) {
        const idx = headers.indexOf(name);
        if (idx >= 0) return idx + 1; // Column numbers are 1-indexed
      }
      return -1;
    };

    // Helper to convert column number to letter
    const columnToLetter = (col) => {
      let temp = '';
      let letter = '';
      while (col > 0) {
        temp = (col - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        col = (col - temp - 1) / 26;
      }
      return letter;
    };

    const updates = [];

    // Map request body fields to sheet columns
    const fieldMappings = [
      { field: 'name', names: ['Имя', 'Как вас зовут?'] },
      { field: 'telegram', names: ['TG Username', 'Username'] },
      { field: 'username', names: ['TG Username', 'Username'] },
      { field: 'age', names: ['Возраст'] },
      { field: 'platform', names: ['Платформа'] },
      { field: 'top_profile', names: ['Анкеты', 'С какими анкетами работал-а (топ, %)'] },
      { field: 'experience', names: ['Опыт'] },
      { field: 'shift', names: ['Смены', 'Смена'] },
      { field: 'english_level', names: ['Английский', 'Уровень английского'] },
      { field: 'notes', names: ['Комментарии'] },
      { field: 'status', names: ['Статус'] },
      { field: 'interviewer_name', names: ['Кто проводит собеседование'] },
      { field: 'interview_date', names: ['Дата собеседования'] },
      { field: 'interview_time', names: ['Время собеседования'] },
      { field: 'comments', names: ['Комментарии'] }
    ];

    for (const mapping of fieldMappings) {
      if (req.body?.[mapping.field] !== undefined) {
        const colIdx = findColumnIndex(...mapping.names);
        if (colIdx > 0) {
          const colLetter = columnToLetter(colIdx);
          let value = String(req.body[mapping.field] || '').trim();

          // Validate status
          if (mapping.field === 'status') {
            value = normalizeInterviewStatus(value);
          }

          updates.push({
            range: `${sheetName}!${colLetter}${rowNumber}`,
            values: [[value]]
          });
        }
      }
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Apply updates
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });

    // Get updated row and return it
    const updatedRowRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}:AU${rowNumber}`
    });

    const updatedRow = updatedRowRes.data.values?.[0] || [];
    const candidate = normalizeRow(headers, updatedRow, rowNumber);

    res.json(candidate);
  } catch (err) {
    console.error('Interview update error:', err.message);
    res.status(500).json({ error: 'Failed to update interview' });
  }
});

app.get('/api/stats', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ error: 'GOOGLE_SPREADSHEET_ID is missing' });
    }

    const sheets = await getSheetsClient();

    const [summaryRes, weeklyRes, detailRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Статистика!B3:C7'
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Статистика!B28:F31'
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Статистика!B12:E20'
      })
    ]);

    const summary = summaryRes.data.values || [];
    const weekly = weeklyRes.data.values || [];
    const detail = detailRes.data.values || [];

    const toNum = (v) => {
      const n = Number(String(v || '').replace(',', '.').trim());
      return Number.isFinite(n) ? n : 0;
    };

    const totals = {
      leads: 0,
      interviews: 0,
      waiting: 0,
      rejects: 0
    };

    for (const row of summary) {
      const label = String(row[0] || '').trim().toLowerCase();
      const value = toNum(row[1]);

      if (label.includes('всего лидов')) totals.leads = value;
      if (label.includes('собеседования')) totals.interviews = value;
      if (label.includes('ожидание')) totals.waiting = value;
      if (label.includes('отказы')) totals.rejects = value;
    }

    const weeklyRows = weekly.map(row => ({
      period: row[0] || '',
      total: toNum(row[1]),
      interviews: toNum(row[2]),
      waiting: toNum(row[3]),
      rejects: toNum(row[4])
    }));

    const lastWeek = weeklyRows[weeklyRows.length - 1] || {
      total: 0,
      interviews: 0,
      waiting: 0,
      rejects: 0
    };

    const month = {
      leads: weeklyRows.reduce((sum, x) => sum + x.total, 0),
      interviews: weeklyRows.reduce((sum, x) => sum + x.interviews, 0),
      waiting: weeklyRows.reduce((sum, x) => sum + x.waiting, 0),
      rejects: weeklyRows.reduce((sum, x) => sum + x.rejects, 0)
    };

    const week = {
      leads: lastWeek.total,
      interviews: lastWeek.interviews,
      waiting: lastWeek.waiting,
      rejects: lastWeek.rejects
    };

    const details = detail.map(row => ({
      status: row[0] || '',
      count: toNum(row[1]),
      percent: row[2] || '',
      category: row[3] || ''
    })).filter(x => x.status);

    res.json({
      totals,
      month,
      week,
      weekly: weeklyRows,
      details
    });
  } catch (err) {
    console.error('Stats read error:', err.message);
    res.status(500).json({ error: 'Failed to read stats from Google Sheets' });
  }
});

let teamStatsCache = {
  data: null,
  ts: 0
};

const TEAM_STATS_CACHE_TTL = 60 * 1000;

app.get('/api/team-stats', auth, async (req, res) => {
  try {
    const now = Date.now();

    if (teamStatsCache.data && now - teamStatsCache.ts < TEAM_STATS_CACHE_TTL) {
      return res.json(teamStatsCache.data);
    }

    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z5000`
    });

    const values = response.data.values || [];

    if (!values.length) {
      return res.json({
        totals: {
          total: 0,
          active: 0,
          fired: 0,
          unpaid: 0,
          onlyfans: 0,
          fansly: 0
        },
        averages: {
          experience_months: 0,
          work_days: 0
        },
        statuses: []
      });
    }

    const headers = values[0];
    const rows = values.slice(1);

    const idx = (name) => headers.indexOf(name);

    const statusIdx = idx('Актуальный статус кандидата (Hr)');
    const platformIdx = idx('OnlyFans / Fansly');
    const expIdx = idx('Опыт, мес.');
    const workDaysIdx = idx('Срок работы, дни');

    const safeGet = (row, i) => (i >= 0 && i < row.length ? row[i] : '');

    const dataRows = rows.filter(row =>
      row.some(cell => String(cell || '').trim() !== '')
    );

    let total = 0;
    let active = 0;
    let fired = 0;
    let unpaid = 0;
    let onlyfans = 0;
    let fansly = 0;

    let expSum = 0;
    let expCount = 0;

    let workDaysSum = 0;
    let workDaysCount = 0;

    const statusMap = new Map();
    const statusPlatformMap = new Map();

    for (const row of dataRows) {
      const statusRaw = String(safeGet(row, statusIdx) || '').trim();
      const status = normalizeText(statusRaw);
      const platform = normalizeText(safeGet(row, platformIdx));
      const normalizedStatusName = statusRaw || 'Без статуса';
      const platformName =
        platform.includes('onlyfans') ? 'onlyfans'
        : platform.includes('fansly') ? 'fansly'
        : '';
      const exp = parseNumberLoose(safeGet(row, expIdx));
      const workDays = parseNumberLoose(safeGet(row, workDaysIdx));

      total++;

      statusMap.set(normalizedStatusName, (statusMap.get(normalizedStatusName) || 0) + 1);

      const statusPlatformKey = `${normalizedStatusName}__${platformName}`;
      statusPlatformMap.set(statusPlatformKey, (statusPlatformMap.get(statusPlatformKey) || 0) + 1);

      if (status.includes('работает')) active++;
      if (status.includes('уволен')) fired++;
      if (status.includes('не рассчитан')) unpaid++;

      if (platform.includes('onlyfans')) onlyfans++;
      if (platform.includes('fansly')) fansly++;

      if (exp > 0) {
        expSum += exp;
        expCount++;
      }

      if (workDays > 0) {
        workDaysSum += workDays;
        workDaysCount++;
      }
    }

    const statuses = [...statusMap.entries()]
      .map(([name, count]) => {
        const onlyfansCount = statusPlatformMap.get(`${name}__onlyfans`) || 0;
        const fanslyCount = statusPlatformMap.get(`${name}__fansly`) || 0;

        return {
          name,
          count,
          onlyfans: onlyfansCount,
          fansly: fanslyCount
        };
      })
      .sort((a, b) => b.count - a.count);

    const payload = {
      totals: {
        total,
        active,
        fired,
        unpaid,
        onlyfans,
        fansly
      },
      averages: {
        experience_months: expCount ? Number((expSum / expCount).toFixed(1)) : 0,
        work_days: workDaysCount ? Number((workDaysSum / workDaysCount).toFixed(1)) : 0
      },
      statuses
    };

    teamStatsCache = {
      data: payload,
      ts: now
    };

    res.json(payload);
  } catch (err) {
    console.error('Team stats read error:', err.message);
    res.status(500).json({ error: 'Failed to read team stats from Google Sheets' });
  }
});

app.get('/api/team-status-members', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const requestedStatus = String(req.query.status || '').trim();

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    if (!requestedStatus) {
      return res.status(400).json({ error: 'status query is required' });
    }

    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z5000`
    });

    const values = response.data.values || [];
    if (!values.length) {
      return res.json([]);
    }

    const headers = values[0];
    const rows = values.slice(1);

    const idx = (name) => headers.indexOf(name);
    const safeGet = (row, i) => (i >= 0 && i < row.length ? row[i] : '');

    const statusIdx = idx('Актуальный статус кандидата (Hr)');
    const nameIdx =
      idx('Имя') >= 0 ? idx('Имя')
      : idx('Имя / ник') >= 0 ? idx('Имя / ник')
      : idx('Ник') >= 0 ? idx('Ник')
      : -1;

    const telegramIdx =
      idx('Телеграм') >= 0 ? idx('Телеграм')
      : idx('Telegram') >= 0 ? idx('Telegram')
      : idx('Username') >= 0 ? idx('Username')
      : idx('TG Username') >= 0 ? idx('TG Username')
      : -1;

    const platformIdx = idx('OnlyFans / Fansly');
    const startDateIdx = idx('Дата старта');
    const workDaysIdx = idx('Срок работы, дни');

    const members = rows
      .filter(row => row.some(cell => String(cell || '').trim() !== ''))
      .map((row, index) => {
        const status = String(safeGet(row, statusIdx) || '').trim() || 'Без статуса';

        return {
          row_number: index + 2,
          status,
          name: String(safeGet(row, nameIdx) || '').trim(),
          telegram: String(safeGet(row, telegramIdx) || '').trim(),
          platform: String(safeGet(row, platformIdx) || '').trim(),
          start_date: String(safeGet(row, startDateIdx) || '').trim(),
          work_days: String(safeGet(row, workDaysIdx) || '').trim()
        };
      })
      .filter(person => String(person.status).trim() === requestedStatus);

    res.json(members);
  } catch (err) {
    console.error('Team status members read error:', err.message);
    res.status(500).json({ error: 'Failed to read team status members' });
  }
});

app.get('/api/team-all-members', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z5000`
    });

    const values = response.data.values || [];
    if (!values.length) return res.json([]);

    const headers = values[0];
    const rows = values.slice(1);

    const idx = (name) => headers.indexOf(name);
    const safeGet = (row, i) => (i >= 0 && i < row.length ? String(row[i] || '').trim() : '');

    const statusIdx = idx('Актуальный статус кандидата (Hr)');
    const nameIdx = idx('Имя') >= 0 ? idx('Имя') : idx('Имя / ник') >= 0 ? idx('Имя / ник') : idx('Ник');
    const telegramIdx = idx('Телеграм') >= 0 ? idx('Телеграм') : idx('Telegram') >= 0 ? idx('Telegram') : idx('TG Username');
    const platformIdx = idx('OnlyFans / Fansly');
    const transactionEndingIdx = idx('Transaction ending');
    const startDateIdx = idx('Дата старта');
    const workDaysIdx = idx('Срок работы, дни');

    const members = rows
      .filter(row => row.some(cell => String(cell || '').trim() !== ''))
      .map((row, index) => ({
        row_number: index + 2,
        name: safeGet(row, nameIdx),
        telegram: safeGet(row, telegramIdx),
        status: safeGet(row, statusIdx) || 'Без статуса',
        platform: safeGet(row, platformIdx),
        transactionEnding: safeGet(row, transactionEndingIdx),
        start_date: safeGet(row, startDateIdx),
        work_days: safeGet(row, workDaysIdx)
      }));

    res.json(members);
  } catch (err) {
    console.error('Team all members read error:', err.message);
    res.status(500).json({ error: 'Failed to read team members' });
  }
});

app.get('/api/team-transaction-endings', auth, async (req, res) => {
  try {
    const data = await readSexterEndingMap();
    res.json(data);
  } catch (err) {
    console.error('Team transaction endings read error:', err.message);
    res.status(500).json({ error: 'Failed to read transaction endings' });
  }
});

app.get('/api/sexter-endings', auth, async (req, res) => {
  try {
    const data = await readSexterEndingMap();
    res.json(data);
  } catch (err) {
    console.error('Sexter endings read error:', err.message);
    res.status(500).json({ error: 'Failed to read sexter endings' });
  }
});

app.patch('/api/team-transaction-endings/clear', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const rowNumber = Number(req.body?.row_number);

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    if (!rowNumber || rowNumber < 2) {
      return res.status(400).json({ error: 'Некорректный row_number' });
    }

    const sheets = await getSheetsClient();

    const headersRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU1`
    });

    const headers = headersRes.data.values?.[0] || [];
    const txIdx = headers.findIndex(
      h => String(h || '').trim() === 'Transaction ending'
    );

    if (txIdx === -1) {
      return res.status(400).json({ error: 'Колонка Transaction ending не найдена' });
    }

    const colLetter = columnToLetter(txIdx + 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!${colLetter}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['']]
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Transaction ending clear error:', err.message);
    res.status(500).json({ error: 'Не удалось очистить ending' });
  }
});

app.get('/api/team-member/:rowNumber', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const rowNumber = Number(req.params.rowNumber);

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    if (!rowNumber || rowNumber < 2) {
      return res.status(400).json({ error: 'Invalid row number' });
    }

    const sheets = await getSheetsClient();

    const [headersRes, rowRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:AU1`
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A${rowNumber}:AU${rowNumber}`
      })
    ]);

    const headers = headersRes.data.values?.[0] || [];
    const row = rowRes.data.values?.[0] || [];

    if (!headers.length) {
      return res.status(500).json({ error: 'Headers not found in team sheet' });
    }

    const fields = headers
      .map((header, index) => ({
        index,
        label: sanitizeTeamFieldLabel(header) || `Колонка ${index + 1}`,
        value: row[index] ?? ''
      }))
      .filter(field => field.label && field.label !== 'null');

    res.json({
      row_number: rowNumber,
      fields
    });
  } catch (err) {
    console.error('Team member read error:', err.message);
    res.status(500).json({ error: 'Failed to read team member' });
  }
});

app.patch('/api/team-member/:rowNumber', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const rowNumber = Number(req.params.rowNumber);
    const updates = req.body?.updates || {};

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    if (!rowNumber || rowNumber < 2) {
      return res.status(400).json({ error: 'Invalid row number' });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'updates object is required' });
    }

    const sheets = await getSheetsClient();

    const headersRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU1`
    });

    const headers = headersRes.data.values?.[0] || [];
    if (!headers.length) {
      return res.status(500).json({ error: 'Headers not found in team sheet' });
    }

    const statusLabel = 'Актуальный статус кандидата (Hr)';
    const transactionEndingLabel = 'Transaction ending';
    const transactionEndingCheckboxLabel = 'Transaction ending (есть/нет в табл.)@dvedenis';
    const nameLabel = 'Имя';
    const currentRowMap = {};

    const currentRowRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}:AU${rowNumber}`
    });

    const currentRow = currentRowRes.data.values?.[0] || [];
    headers.forEach((header, index) => {
      const key = String(header || '').trim();
      if (!key) return;
      currentRowMap[key] = currentRow[index] ?? '';
    });

    if (Object.prototype.hasOwnProperty.call(updates, statusLabel)) {
      const nextStatus = String(updates[statusLabel] || '').trim();

      if (shouldClearTransactionEndingByStatus(nextStatus)) {
        updates[transactionEndingLabel] = '';
        updates[transactionEndingCheckboxLabel] = '';

        const personName =
          String(updates[nameLabel] || '').trim() ||
          String(currentRowMap?.[nameLabel] || '').trim();

        if (personName) {
          await clearSexterEndingByName(personName).catch(err => {
            console.error('Clear sexter ending by name error:', err.message);
          });
        }
      }
    }

    const data = [];

    for (const [label, value] of Object.entries(updates)) {
      const colIndex = headers.findIndex(h => String(h || '').trim() === String(label || '').trim());
      if (colIndex === -1) continue;

      const columnLetter = columnToLetter(colIndex + 1);
      const normalizedLabel = String(label || '').trim();
      let nextValue = value ?? '';

      if (normalizedLabel === statusLabel) {
        nextValue = normalizeTeamStatus(value);
      }

      data.push({
        range: `${sheetName}!${columnLetter}${rowNumber}`,
        values: [[nextValue]]
      });
    }

    if (!data.length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    if (Object.prototype.hasOwnProperty.call(updates, transactionEndingLabel)) {
      const nextValue = String(updates[transactionEndingLabel] || '').trim();

      if (nextValue) {
        if (!/^\d+$/.test(nextValue)) {
          return res.status(400).json({ error: 'Transaction ending должен быть числом от 1 до 99' });
        }

        const num = Number(nextValue);
        if (num < 1 || num > 99) {
          return res.status(400).json({ error: 'Transaction ending должен быть в диапазоне 1–99' });
        }

        const allRowsRes = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!A1:AU5000`
        });

        const allValues = allRowsRes.data.values || [];
        const allHeaders = allValues[0] || [];
        const allRows = allValues.slice(1);

        const txIdx = allHeaders.findIndex(
          h => String(h || '').trim() === transactionEndingLabel
        );

        if (txIdx >= 0) {
          const duplicate = allRows.some((row, idx) => {
            const realRowNumber = idx + 2;
            if (realRowNumber === rowNumber) return false;
            return String(row[txIdx] || '').trim() === nextValue;
          });

          if (duplicate) {
            return res.status(400).json({ error: `Transaction ending ${nextValue} уже занят у другого сотрудника` });
          }
        }
      }
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data
      }
    });

    teamStatsCache = {
      data: null,
      ts: 0
    };

    res.json({ ok: true });
  } catch (err) {
    console.error('Team member update error:', err.message);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

app.post('/api/team-member', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const values = req.body?.values || {};

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    const sheets = await getSheetsClient();

    const headersRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU1`
    });

    const headers = headersRes.data.values?.[0] || [];
    if (!headers.length) {
      return res.status(500).json({ error: 'Headers not found in team sheet' });
    }

    const row = headers.map(h => values[String(h).trim()] ?? '');

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:AU`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row]
      }
    });

    teamStatsCache = {
      data: null,
      ts: 0
    };

    res.json({ ok: true });
  } catch (err) {
    console.error('Team member create error:', err.message);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

app.get('/api/hr-needs', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        platform,
        model_name,
        shift_00_06,
        shift_06_12,
        shift_12_18,
        shift_18_00,
        comment,
        top_percent,
        operator_salary_percent,
        experience_kd_months,
        avg_shift_check,
        revenue_month_k,
        created_at,
        updated_at
      FROM hr_needs
      ORDER BY platform ASC, model_name ASC, id ASC
    `);

    const rows = result.rows || [];

    res.json({
      sections: [
        {
          key: 'onlyfans',
          label: 'OnlyFans',
          models: rows.filter(x => x.platform === 'onlyfans')
        },
        {
          key: 'fansly',
          label: 'Fansly',
          models: rows.filter(x => x.platform === 'fansly')
        }
      ]
    });
  } catch (err) {
    console.error('HR needs read error:', err.message);
    res.status(500).json({ error: 'Failed to load HR needs' });
  }
});

app.post('/api/hr-needs', auth, async (req, res) => {
  try {
    const platform = normalizeNeedPlatform(req.body?.platform);
    const modelName = String(req.body?.model_name || '').trim();
    const comment = String(req.body?.comment || '').trim();
    const topPercent = String(req.body?.top_percent || '').trim();
    const operatorSalaryPercent = String(req.body?.operator_salary_percent || '').trim();
    const experienceKdMonths = String(req.body?.experience_kd_months || '').trim();
    const avgShiftCheck = String(req.body?.avg_shift_check || '').trim();
    const revenueMonthK = String(req.body?.revenue_month_k || '').trim();

    if (!modelName) {
      return res.status(400).json({ error: 'model_name is required' });
    }

    const result = await pool.query(`
      INSERT INTO hr_needs (
        platform,
        model_name,
        comment,
        top_percent,
        operator_salary_percent,
        experience_kd_months,
        avg_shift_check,
        revenue_month_k
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      platform,
      modelName,
      comment,
      topPercent,
      operatorSalaryPercent,
      experienceKdMonths,
      avgShiftCheck,
      revenueMonthK
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('HR needs create error:', err.message);
    res.status(500).json({ error: 'Failed to create HR need card' });
  }
});

app.patch('/api/hr-needs/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const updates = [];
    const values = [];
    let index = 1;

    if (req.body?.platform !== undefined) {
      updates.push(`platform = $${index++}`);
      values.push(normalizeNeedPlatform(req.body.platform));
    }

    if (req.body?.model_name !== undefined) {
      updates.push(`model_name = $${index++}`);
      values.push(String(req.body.model_name || '').trim());
    }

    if (req.body?.comment !== undefined) {
      updates.push(`comment = $${index++}`);
      values.push(String(req.body.comment || '').trim());
    }

    if (req.body?.top_percent !== undefined) {
      updates.push(`top_percent = $${index++}`);
      values.push(String(req.body.top_percent || '').trim());
    }

    if (req.body?.operator_salary_percent !== undefined) {
      updates.push(`operator_salary_percent = $${index++}`);
      values.push(String(req.body.operator_salary_percent || '').trim());
    }

    if (req.body?.experience_kd_months !== undefined) {
      updates.push(`experience_kd_months = $${index++}`);
      values.push(String(req.body.experience_kd_months || '').trim());
    }

    if (req.body?.avg_shift_check !== undefined) {
      updates.push(`avg_shift_check = $${index++}`);
      values.push(String(req.body.avg_shift_check || '').trim());
    }

    if (req.body?.revenue_month_k !== undefined) {
      updates.push(`revenue_month_k = $${index++}`);
      values.push(String(req.body.revenue_month_k || '').trim());
    }

    if (req.body?.shift_00_06 !== undefined) {
      updates.push(`shift_00_06 = $${index++}`);
      values.push(normalizeNeedStatus(req.body.shift_00_06));
    }

    if (req.body?.shift_06_12 !== undefined) {
      updates.push(`shift_06_12 = $${index++}`);
      values.push(normalizeNeedStatus(req.body.shift_06_12));
    }

    if (req.body?.shift_12_18 !== undefined) {
      updates.push(`shift_12_18 = $${index++}`);
      values.push(normalizeNeedStatus(req.body.shift_12_18));
    }

    if (req.body?.shift_18_00 !== undefined) {
      updates.push(`shift_18_00 = $${index++}`);
      values.push(normalizeNeedStatus(req.body.shift_18_00));
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(`
      UPDATE hr_needs
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING *
    `, values);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'HR need card not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('HR needs update error:', err.message);
    res.status(500).json({ error: 'Failed to update HR need card' });
  }
});

app.delete('/api/hr-needs/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const result = await pool.query(`
      DELETE FROM hr_needs
      WHERE id = $1
      RETURNING id
    `, [id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'HR need card not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('HR needs delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete HR need card' });
  }
});

app.post('/api/interviews/:rowNumber/notify', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const hrChatId = process.env.HR_CHAT_ID;

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'GOOGLE_SPREADSHEET_ID is missing' });
    }

    if (!botToken) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN is missing' });
    }

    const rowNumber = Number(req.params.rowNumber);
    if (!rowNumber || rowNumber < 2) {
      return res.status(400).json({ error: 'Invalid row number' });
    }

    const { interview_date = '', interview_time = '' } = req.body || {};

    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}:Q${rowNumber}`
    });

    const row = response.data.values?.[0] || [];
    if (!row.length) {
      return res.status(404).json({ error: 'Row not found in sheet' });
    }

    const telegramUserId = row[2] || '';
    const candidateName = row[4] || '';
    const username = row[1] || '';

    if (!telegramUserId) {
      return res.status(400).json({ error: 'Candidate TG ID is missing' });
    }

    const message =
`Привет! 🙌
Это HR агентства Allstars — вы недавно оставляли у нас заявку на работу чаттером.

Мы рассмотрели вашу анкету и хотели бы пригласить вас на небольшой созвон.
Расскажем подробнее об условиях, ответим на вопросы и познакомимся поближе 😊

Предлагаем созвониться ${interview_date} в ${interview_time} по мск.

Если это время неудобно — нажмите кнопку ниже, и мы подберём другое 🙌

Почему пришлось немного подождать?
Потому что сейчас очень большой поток кандидатов, и мы физически не успеваем обработать всех сразу 🙏`;

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramUserId,
        text: message,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Подтверждаю', callback_data: `interview_confirm:${rowNumber}` },
              { text: '🕒 Нужно другое время', callback_data: `interview_reschedule:${rowNumber}` }
            ]
          ]
        }
      })
    });

    const tgData = await tgRes.json();

    if (!tgRes.ok || !tgData.ok) {
      return res.status(500).json({
        error: tgData.description || 'Failed to send Telegram message'
      });
    }

    // опционально: уведомить HR-чат, что приглашение отправлено
    if (hrChatId) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: hrChatId,
          text:
`📨 Приглашение на собеседование отправлено

Кандидат: ${candidateName || '—'}
Username: ${username || '—'}
TG ID: ${telegramUserId}
Дата: ${interview_date}
Время: ${interview_time}`
        })
      }).catch(err => {
        console.error('HR chat notification failed:', err.message);
      });
    }

    res.json({
      ok: true,
      candidate_name: candidateName,
      telegram_user_id: telegramUserId
    });
  } catch (err) {
    console.error('Telegram notify error:', err.message);
    res.status(500).json({ error: 'Failed to send Telegram notification' });
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

// AI endpoints
app.post('/api/ai/summary', auth, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is missing' });
    }

    const { notes = '', status = '', candidate = {} } = req.body || {};

    if (!String(notes).trim()) {
      return res.status(400).json({ error: 'Notes are required' });
    }

    const prompt = `
Ты HR-ассистент.

Сделай структурированное summary кандидата.

Формат:

📌 Кратко о кандидате
...

💬 Коммуникация
...

🧠 Опыт
...

🇬🇧 Английский
...

🕒 Готовность / график
...

⚠️ Что важно учесть
...

✅ Следующий шаг
${status || 'Не указан'}

Данные кандидата:
Имя: ${candidate.name || '—'}
Возраст: ${candidate.age || '—'}
Telegram: ${candidate.tg || '—'}
Опыт: ${candidate.exp || '—'}
Средний чек: ${candidate.avgcheck || '—'}
Топ страницы: ${candidate.top || '—'}
Занятость: ${candidate.job || '—'}
Английский: ${candidate.english || '—'}
Платформы: ${candidate.platforms || '—'}
Смены: ${candidate.shifts || '—'}
График: ${candidate.schedule || '—'}

Заметки HR:
${notes}
`.trim();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini summary HTTP error:', data);
      return res.status(500).json({
        error: data?.error?.message || 'Gemini request failed'
      });
    }

    console.log('Gemini summary raw response:', JSON.stringify(data));

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || '')
        .join('')
        .trim() || '';

    if (!text) {
      const blockReason = data?.promptFeedback?.blockReason || '';
      const finishReason = data?.candidates?.[0]?.finishReason || '';
      return res.status(500).json({
        error: `Gemini returned empty text${blockReason ? `, blockReason: ${blockReason}` : ''}${finishReason ? `, finishReason: ${finishReason}` : ''}`
      });
    }

    res.json({ summary: text });
  } catch (err) {
    console.error('Gemini summary error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

app.post('/api/ai/teamlead-handoff', auth, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is missing' });
    }

    const { notes = '', status = '', candidate = {} } = req.body || {};

    if (!String(notes).trim()) {
      return res.status(400).json({ error: 'Notes are required' });
    }

    const prompt = `
Сделай передачу кандидата тимлиду.

Формат:

📌 Передача кандидата тимлиду

Кандидат: ${candidate.name || '—'}
Telegram: ${candidate.tg || '—'}
Возраст: ${candidate.age || '—'}

1. Что по кандидату
...

2. Что показал на собеседовании
...

3. Сильные стороны
...

4. Слабые стороны / риски
...

5. Условия / график / смены
...

6. Что важно учесть в работе
...

7. Решение HR
${status || 'Не указан'}

Заметки HR:
${notes}
`.trim();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini handoff HTTP error:', data);
      return res.status(500).json({
        error: data?.error?.message || 'Gemini request failed'
      });
    }

    console.log('Gemini handoff raw response:', JSON.stringify(data));

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || '')
        .join('')
        .trim() || '';

    if (!text) {
      const blockReason = data?.promptFeedback?.blockReason || '';
      const finishReason = data?.candidates?.[0]?.finishReason || '';
      return res.status(500).json({
        error: `Gemini returned empty text${blockReason ? `, blockReason: ${blockReason}` : ''}${finishReason ? `, finishReason: ${finishReason}` : ''}`
      });
    }

    res.json({ summary: text });
  } catch (err) {
    console.error('Gemini handoff error:', err.message);
    res.status(500).json({ error: 'Failed to generate handoff' });
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