require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { google } = require('googleapis');

function parseGoogleServiceAccountCredentials() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const envClientEmail = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const envPrivateKeyRaw = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim();
  const envProjectId = String(process.env.GOOGLE_PROJECT_ID || '').trim();

  if (!raw && process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    try {
      raw = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8');
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64');
    }
  }

  let creds = {};

  if (raw) {
    raw = String(raw).trim();
    const hasOuterSingleQuotes = raw.startsWith("'") && raw.endsWith("'");
    const hasOuterDoubleQuotes = raw.startsWith('"') && raw.endsWith('"');

    if (hasOuterSingleQuotes || hasOuterDoubleQuotes) {
      raw = raw.slice(1, -1);
    }

    try {
      creds = JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }

  const privateKeySource = creds.private_key || envPrivateKeyRaw;
  const privateKey = String(privateKeySource)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();
  const clientEmail = String(creds.client_email || envClientEmail || '').trim();

  if (!clientEmail || !privateKey) {
    throw new Error('Google credentials are missing: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  }

  if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
    throw new Error('GOOGLE service account private_key has invalid format');
  }

  return {
    type: 'service_account',
    ...creds,
    project_id: creds.project_id || envProjectId || undefined,
    client_email: clientEmail,
    private_key: privateKey
  };
}

async function getGoogleSheet() {
  const creds = parseGoogleServiceAccountCredentials();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || process.env.GOOGLE_SPREADSHEET_NAME;

  if (!spreadsheetId) {
    throw new Error('GOOGLE_SPREADSHEET_ID is missing');
  }

  const doc = new GoogleSpreadsheet(spreadsheetId);

  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  return doc;
}

const app = express();

const CRM_EVENTS_FILE =
  process.env.CRM_EVENTS_FILE ||
  path.join(process.cwd(), 'data', 'crm-events.json');

const DASHBOARD_STATS_SPREADSHEET_ID =
  process.env.DASHBOARD_STATS_SPREADSHEET_ID ||
  '19zpp7Qnhx8RO5kM6iC83mBxcT6f2s5oUk8Uep_mdNeg';

async function ensureCrmEventsFile() {
  const dir = path.dirname(CRM_EVENTS_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(CRM_EVENTS_FILE)) {
    await fsp.writeFile(CRM_EVENTS_FILE, '[]', 'utf8');
  }
}

async function readCrmEvents() {
  await ensureCrmEventsFile();

  try {
    const raw = await fsp.readFile(CRM_EVENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('readCrmEvents error:', err.message);
    return [];
  }
}

async function writeCrmEvents(events) {
  await ensureCrmEventsFile();
  await fsp.writeFile(CRM_EVENTS_FILE, JSON.stringify(events, null, 2), 'utf8');
}

async function appendCrmEvent(event) {
  console.log('APPEND CRM EVENT CALLED');

  const events = await readCrmEvents();
  const rawAgencyId = Number(event.agency_id);
  const agencyId = Number.isInteger(rawAgencyId) && rawAgencyId > 0 ? rawAgencyId : null;

  const nextEvent = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    entity_type: String(event.entity_type || ''),
    entity_id: String(event.entity_id || ''),
    event_type: String(event.event_type || ''),
    old_value: String(event.old_value || ''),
    new_value: String(event.new_value || ''),
    meta: event.meta || {},
    agency_id: agencyId,
    created_at: new Date().toISOString(),
    created_by: String(event.created_by || '')
  };

  if (agencyId) {
    nextEvent.meta = {
      ...nextEvent.meta,
      agencyId
    };
  }

  events.push(nextEvent);

  console.log('APPEND CRM EVENT =>', nextEvent);
  console.log('CRM EVENTS FILE =>', CRM_EVENTS_FILE);
  console.log('CRM EVENTS COUNT BEFORE WRITE =>', events.length);

  await writeCrmEvents(events);

  const verify = await readCrmEvents();
  console.log('CRM EVENTS COUNT AFTER WRITE =>', verify.length);
}

const PORT = process.env.PORT || 3000;
const isProductionRuntime =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production' ||
  Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
const JWT_SECRET = String(process.env.JWT_SECRET || '').trim() ||
  (isProductionRuntime ? '' : 'allstars-dev-jwt-secret');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const AUTH_BYPASS_TOKEN = String(process.env.AUTH_BYPASS_TOKEN || 'allstars-bypass-token').trim();
const AUTH_BYPASS_AGENCY_ID = Number(process.env.AUTH_BYPASS_AGENCY_ID || 0) || 0;

if (!JWT_SECRET) {
  if (isProductionRuntime) {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  console.warn('WARNING: JWT_SECRET not set, using insecure default for development only');
}

function buildDatabaseConfig() {
  function resolveSslConfig(rawHost, rawConnectionString) {
    const host = String(rawHost || '').toLowerCase();
    const conn = String(rawConnectionString || '');
    const dbSsl = String(process.env.DB_SSL || '').trim().toLowerCase();
    const pgSslMode = String(process.env.PGSSLMODE || '').trim().toLowerCase();

    if (dbSsl === 'true' || dbSsl === '1') return { rejectUnauthorized: false };
    if (dbSsl === 'false' || dbSsl === '0') return false;

    if (pgSslMode === 'disable' || pgSslMode === 'allow' || pgSslMode === 'prefer') return false;
    if (pgSslMode === 'require' || pgSslMode === 'verify-ca' || pgSslMode === 'verify-full') {
      return { rejectUnauthorized: false };
    }

    if (/sslmode=disable/i.test(conn)) return false;
    if (/sslmode=require/i.test(conn)) return { rejectUnauthorized: false };

    if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
      return false;
    }

    return { rejectUnauthorized: false };
  }

  const connectionString = String(process.env.DATABASE_URL || '').trim();
  const pgHost = String(process.env.PGHOST || '').trim();

  if (connectionString) {
    let parsedHost = '';
    try {
      parsedHost = new URL(connectionString).hostname || '';
    } catch {
      parsedHost = '';
    }

    return {
      connectionString,
      ssl: resolveSslConfig(parsedHost, connectionString)
    };
  }

  if (pgHost) {
    return {
      host: pgHost,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: resolveSslConfig(pgHost, '')
    };
  }

  console.warn('DATABASE_URL/PGHOST are not set. PostgreSQL connection is not configured.');
  return {
    connectionString: 'postgresql://localhost/allstars_dev',
    ssl: false
  };
}

const databaseConfig = buildDatabaseConfig();

const poolRuntimeOptions = {
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  max: 20
};

const liveBackfillDisabledRaw = String(process.env.DISABLE_LIVE_BACKFILL || '').trim().toLowerCase();
const LIVE_BACKFILL_DISABLED = liveBackfillDisabledRaw === '1' || liveBackfillDisabledRaw === 'true' || liveBackfillDisabledRaw === 'yes';
const sheetsWriteEnabledRaw = String(process.env.ENABLE_SHEETS_WRITE || '').trim().toLowerCase();
const SHEETS_WRITE_ENABLED = sheetsWriteEnabledRaw === '1' || sheetsWriteEnabledRaw === 'true' || sheetsWriteEnabledRaw === 'yes';

function ensureSheetsWriteEnabled() {
  if (SHEETS_WRITE_ENABLED) return;

  const err = new Error('Google Sheets write is disabled: CRM -> Sheets sync is blocked');
  err.code = 'SHEETS_WRITE_DISABLED';
  throw err;
}

function flipSslConfig(rawSsl) {
  return rawSsl ? false : { rejectUnauthorized: false };
}

function isConnectionResetError(err) {
  const text = String(err?.message || '').toLowerCase();
  return (
    err?.code === 'ECONNRESET' ||
    text.includes('econnreset') ||
    text.includes('connection terminated unexpectedly') ||
    text.includes('socket hang up')
  );
}

function hasConnectionStringConfig(config) {
  return Boolean(String(config?.connectionString || '').trim());
}

function buildAlternateDatabaseConfig(config) {
  if (!config) return null;

  if (hasConnectionStringConfig(config)) {
    const connectionString = String(config.connectionString);
    const hasSslDisable = /([?&])sslmode=disable/i.test(connectionString);
    const hasSslRequire = /([?&])sslmode=require/i.test(connectionString);

    let nextConnectionString = connectionString;
    if (hasSslDisable) {
      nextConnectionString = connectionString.replace(/sslmode=disable/ig, 'sslmode=require');
    } else if (hasSslRequire) {
      nextConnectionString = connectionString.replace(/sslmode=require/ig, 'sslmode=disable');
    }

    return {
      ...config,
      connectionString: nextConnectionString,
      ssl: flipSslConfig(config.ssl)
    };
  }

  return {
    ...config,
    ssl: flipSslConfig(config.ssl)
  };
}

function safeDbConfigSummary(config) {
  if (!config) return { configured: false };

  let host = String(config.host || '').trim();
  let port = Number(config.port || 0) || undefined;

  if (!host && config.connectionString) {
    try {
      const url = new URL(config.connectionString);
      host = url.hostname || '';
      port = Number(url.port || 5432);
    } catch {
      host = '';
    }
  }

  return {
    configured: true,
    mode: hasConnectionStringConfig(config) ? 'DATABASE_URL' : 'PGHOST',
    host: host || 'unknown',
    port: port || 5432,
    ssl: config.ssl ? 'on' : 'off'
  };
}

let pool = null;
let dbSwitchPromise = null;
const alternateDatabaseConfig = buildAlternateDatabaseConfig(databaseConfig);
const canToggleDbConfig = Boolean(alternateDatabaseConfig);
let usingAlternateDbConfig = false;

function createPool(config) {
  const instance = new Pool({
    ...config,
    ...poolRuntimeOptions
  });

  const originalQuery = instance.query.bind(instance);
  instance.query = async (...args) => {
    try {
      return await originalQuery(...args);
    } catch (err) {
      if (instance === pool && isConnectionResetError(err)) {
        const switched = await switchPoolToAlternate(err.message);
        if (switched) {
          return pool.query(...args);
        }
      }
      throw err;
    }
  };

  instance.on('error', (err) => {
    console.error('Pool error:', err.message);
  });

  return instance;
}

async function switchPoolToAlternate(reason) {
  if (!canToggleDbConfig) return false;
  if (dbSwitchPromise) return dbSwitchPromise;

  dbSwitchPromise = (async () => {
    const nextUseAlternate = !usingAlternateDbConfig;
    const nextConfig = nextUseAlternate ? alternateDatabaseConfig : databaseConfig;
    const nextModeLabel = nextUseAlternate ? 'fallback' : 'primary';
    const previousPool = pool;
    pool = createPool(nextConfig);
    usingAlternateDbConfig = nextUseAlternate;

    console.warn('Switching database connection mode after error:', reason);
    console.warn(`Database config ${nextModeLabel} summary:`, safeDbConfigSummary(nextConfig));

    if (previousPool) {
      try {
        await previousPool.end();
      } catch {
        // Ignore pool shutdown errors.
      }
    }

    return true;
  })();

  try {
    return await dbSwitchPromise;
  } finally {
    dbSwitchPromise = null;
  }
}

pool = createPool(databaseConfig);
console.log('Database config summary:', safeDbConfigSummary(databaseConfig));

if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  console.warn('PostgreSQL env is not set. Configure DATABASE_URL or PG* variables first.');
}

app.use(cors({
  origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN.split(',').map(x => x.trim()),
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (isConnectionResetError(err)) {
      const switched = await switchPoolToAlternate(err.message);
      if (switched) {
        return pool.query(text, params);
      }
    }

    throw err;
  }
}

function getGoogleCreds() {
  return parseGoogleServiceAccountCredentials();
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

const UNIFIED_STATUS_OPTIONS = [
  'Назначено собеседование',
  'Ждет собеседования',
  'Изучает гайд',
  'Ждет тест',
  'Тест смена',
  'Хочу взять',
  'Верификация',
  'Ожидание старта',
  'Принятый',
  'Работает',
  'Лист ожидания',
  'Нет ответа',
  'Отказ',
  'Уволен',
  'Не рассчитан',
  'Убрать'
];

const STATUS_ALIASES = {
  'Принят': 'Принятый',
  'Тест-смена': 'Тест смена',
  'Ждёт тест': 'Ждет тест',
  'ждет тест': 'Ждет тест',
  'ждёт тест': 'Ждет тест',
  'Собеседование': 'Ждет собеседования',
  'Отписал': 'Ждет собеседования',
  'Не пришел на собес': 'Отказ'
};

const CANDIDATE_STATUSES = [...UNIFIED_STATUS_OPTIONS];
const INTERVIEW_STATUSES = [...UNIFIED_STATUS_OPTIONS];
const TEAM_STATUSES = [...UNIFIED_STATUS_OPTIONS];

const TEAM_STATUSES_CLEAR_TRANSACTION_ENDING = new Set([
  'Уволен',
  'Нет ответа',
  'Убрать'
]);

const TEAM_DASHBOARD_EXCLUDED_STATUSES = new Set([
  'Назначено собеседование',
  'Ждет собеседования'
]);

const TEAM_DASHBOARD_VISIBLE_STATUSES = new Set(
  UNIFIED_STATUS_OPTIONS.filter(status => !TEAM_DASHBOARD_EXCLUDED_STATUSES.has(status))
);

const HIRED_CANDIDATE_STATUSES = new Set([
  'Принятый',
  'Работает'
]);
const DASHBOARD_HIRED_CANDIDATE_STATUSES = new Set([
  ...HIRED_CANDIDATE_STATUSES,
  'Принят'
]);

const REJECTED_CANDIDATE_STATUS = 'Отказ';
const STARTED_CANDIDATE_STATUS = 'Ожидание старта';
const FIRED_CANDIDATE_STATUS = 'Уволен';
const TRIAL_CANDIDATE_STATUS = 'Тест смена';
const DASHBOARD_TRIAL_CANDIDATE_STATUSES = new Set([
  TRIAL_CANDIDATE_STATUS,
  'Тест-смена'
]);
const WAITING_TEST_CANDIDATE_STATUS = 'Ждет тест';
const UNPAID_CANDIDATE_STATUS = 'Не рассчитан';
const OFFBOARDED_CANDIDATE_STATUSES = new Set([
  FIRED_CANDIDATE_STATUS,
  UNPAID_CANDIDATE_STATUS
]);
const DASHBOARD_TRACKED_STATUSES = new Set([
  ...DASHBOARD_HIRED_CANDIDATE_STATUSES,
  REJECTED_CANDIDATE_STATUS,
  STARTED_CANDIDATE_STATUS,
  FIRED_CANDIDATE_STATUS,
  ...DASHBOARD_TRIAL_CANDIDATE_STATUSES,
  WAITING_TEST_CANDIDATE_STATUS,
  UNPAID_CANDIDATE_STATUS
]);

function isVisibleTeamDashboardStatus(status) {
  return TEAM_DASHBOARD_VISIBLE_STATUSES.has(String(status || '').trim());
}

function isHiredCandidateStatus(status) {
  return HIRED_CANDIDATE_STATUSES.has(String(status || '').trim());
}

function isDashboardHiredStatus(status) {
  return DASHBOARD_HIRED_CANDIDATE_STATUSES.has(String(status || '').trim());
}

function isDashboardTrialStatus(status) {
  return DASHBOARD_TRIAL_CANDIDATE_STATUSES.has(String(status || '').trim());
}

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

function extractTransactionEndingNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const fromSexter = extractSexterEnding(raw);
  if (fromSexter !== null) return fromSexter;

  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= 99 ? n : null;
  }

  return null;
}

function namesLooselyMatch(a, b) {
  const x = normalizePersonKey(a);
  const y = normalizePersonKey(b);

  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function findHeaderIndex(headers, exactNames = [], partialNames = []) {
  const normalizedHeaders = (headers || []).map(header => String(header || '').trim());

  for (const name of exactNames) {
    const index = normalizedHeaders.findIndex(header => header === name);
    if (index >= 0) return index;
  }

  const loweredHeaders = normalizedHeaders.map(header => header.toLowerCase());

  for (const part of partialNames) {
    const needle = String(part || '').trim().toLowerCase();
    if (!needle) continue;

    const index = loweredHeaders.findIndex(header => header.includes(needle));
    if (index >= 0) return index;
  }

  return -1;
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

    // Fallback: some rows may have only Number column filled (1..99) without Example 5,NN.
    if (ending === null) {
      for (const cell of row) {
        const n = extractTransactionEndingNumber(cell);
        if (n !== null) {
          ending = n;
          endingRaw = String(cell || '').trim();
          break;
        }
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

function buildTransactionEndingBoardFromTeamMembers(sheetMembers) {
  const byEnding = new Map();
  const duplicates = [];

  for (const item of sheetMembers) {
    const ending = extractTransactionEndingNumber(item.transactionEnding);
    if (ending === null) continue;

    const payload = {
      ending,
      row_number: Number(item.row_number),
      name: String(item.name || '').trim(),
      telegram: String(item.telegram || '').trim(),
      status: String(item.status || '').trim(),
      transaction_ending: String(item.transactionEnding || '').trim(),
      platform: String(item.platform || '').trim(),
      source: 'team'
    };

    if (byEnding.has(ending)) {
      duplicates.push(payload);
      continue;
    }

    byEnding.set(ending, payload);
  }

  const slots = [];
  let usedCount = 0;

  for (let ending = 1; ending <= 99; ending++) {
    const assigned = byEnding.get(ending) || null;
    if (assigned) usedCount += 1;

    slots.push({
      ending,
      assigned
    });
  }

  return {
    slots,
    used_count: usedCount,
    free_count: 99 - usedCount,
    duplicates
  };
}

async function ensureTransactionEndingsInitialized() {
  await pool.query(`
    INSERT INTO transaction_endings (ending)
    SELECT gs
    FROM generate_series(1, 99) AS gs
    ON CONFLICT (ending) DO NOTHING
  `);

  // Normalize legacy/broken rows so they do not appear as occupied.
  await pool.query(`
    UPDATE transaction_endings
    SET assigned_to = NULL,
        assigned_row_number = NULL,
        assigned_user_id = NULL,
        updated_at = NOW()
    WHERE COALESCE(assigned_row_number, 0) < 2
      AND lower(trim(COALESCE(assigned_to, ''))) IN ('', '0', '-', '—', 'null', 'без имени')
  `);
}

function hasMeaningfulEndingAssigneeName(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return false;
  if (['0', '-', '—', 'null', 'без имени'].includes(s)) return false;
  return true;
}

function inspectSexterRow(row = []) {
  let rowName = '';
  let rowNameCol = 1;
  let rowEnding = null;
  let rowEndingCol = -1;

  for (let c = 0; c < row.length; c++) {
    const text = String(row[c] || '').trim();
    if (!text) continue;

    const maybeEnding = extractTransactionEndingNumber(text);
    if (maybeEnding !== null) {
      if (rowEnding === null) {
        rowEnding = maybeEnding;
        rowEndingCol = c + 1;
      }
      continue;
    }

    if (!/^\d+$/.test(text) && text.toLowerCase() !== 'number' && text.toLowerCase() !== 'example' && !rowName) {
      rowName = text;
      rowNameCol = c + 1;
    }
  }

  return {
    rowName,
    rowNameCol,
    rowEnding,
    rowEndingCol
  };
}

async function assignSexterEndingByName(personName, ending) {
  if (!SHEETS_WRITE_ENABLED) return false;

  const spreadsheetId = process.env.SHELL_OF_SPREADSHEET_ID;
  const sheetName = process.env.SHELL_OF_SEXTER_SHEET_NAME || '# sexter';

  if (!spreadsheetId || !personName || !Number.isInteger(Number(ending))) return false;

  const normalizedEnding = Number(ending);
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z200`
  });

  const values = response.data.values || [];
  if (!values.length) return false;

  let targetRow = -1;
  let targetNameCol = 1;
  let previousRow = -1;
  let previousNameCol = 1;

  for (let r = 0; r < values.length; r++) {
    const info = inspectSexterRow(values[r] || []);

    if (info.rowEnding === normalizedEnding) {
      targetRow = r + 1;
      targetNameCol = info.rowNameCol || 1;
    }

    if (info.rowName && namesLooselyMatch(personName, info.rowName)) {
      previousRow = r + 1;
      previousNameCol = info.rowNameCol || 1;
    }
  }

  if (targetRow === -1) return false;

  const data = [];
  if (previousRow !== -1 && previousRow !== targetRow) {
    data.push({
      range: `${sheetName}!${columnToLetter(previousNameCol)}${previousRow}`,
      values: [['']]
    });
  }

  data.push({
    range: `${sheetName}!${columnToLetter(targetNameCol)}${targetRow}`,
    values: [[String(personName).trim()]]
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data
    }
  });

  return true;
}

async function clearSexterEndingByEnding(ending) {
  if (!SHEETS_WRITE_ENABLED) return false;

  const spreadsheetId = process.env.SHELL_OF_SPREADSHEET_ID;
  const sheetName = process.env.SHELL_OF_SEXTER_SHEET_NAME || '# sexter';

  if (!spreadsheetId || !Number.isInteger(Number(ending))) return false;

  const normalizedEnding = Number(ending);
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z200`
  });

  const values = response.data.values || [];
  if (!values.length) return false;

  let matchedRow = -1;
  let matchedNameCol = 1;

  for (let r = 0; r < values.length; r++) {
    const info = inspectSexterRow(values[r] || []);
    if (info.rowEnding === normalizedEnding) {
      matchedRow = r + 1;
      matchedNameCol = info.rowNameCol || 1;
      break;
    }
  }

  if (matchedRow === -1) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${columnToLetter(matchedNameCol)}${matchedRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['']]
    }
  });

  return true;
}

async function clearSexterEndingByName(personName) {
  if (!SHEETS_WRITE_ENABLED) return false;

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
  const s = normalizeStatusAlias(value);
  return CANDIDATE_STATUSES.includes(s) ? s : '';
}

function normalizeInterviewStatus(value) {
  const s = normalizeStatusAlias(value);
  return INTERVIEW_STATUSES.includes(s) ? s : '';
}

function normalizeTeamStatus(value) {
  const s = normalizeStatusAlias(value);
  return TEAM_STATUSES.includes(s) ? s : '';
}

function normalizeStatusAlias(value) {
  const raw = String(value || '').trim();
  return STATUS_ALIASES[raw] || raw;
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

function extractSourceFromText(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';

  const patterns = [
    /(?:^|\n)\s*источник\s*[:\-]\s*([^\n]+)/iu,
    /(?:^|\n)\s*откуда\s+вы\s+о\s+нас\s+узнали\??\s*[:\-]\s*([^\n]+)/iu,
    /(?:^|\n)\s*откуда\s+приш[её]л\s+кандидат\s*[:\-]\s*([^\n]+)/iu
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const found = String(match?.[1] || '').trim();
    if (found) return found;
  }

  return '';
}

function normalizeHeaderMatchKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isLikelyDateTimeText(value = '') {
  const s = String(value || '').trim();
  if (!s) return false;

  if (/^\d{2}\.\d{2}\.\d{4}(?:\s+\d{1,2}:\d{2})?$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(s)) return true;

  return false;
}

function isValidInterviewSourceValue(value = '') {
  const s = String(value || '').trim();
  if (!s) return false;
  if (isLikelyDateTimeText(s)) return false;

  const normalized = s.toLowerCase();
  const disallowed = new Set([
    'manual',
    'new',
    'screening',
    'interview',
    'test_task',
    'test_shift',
    'hired',
    'rejected'
  ]);

  if (disallowed.has(normalized)) return false;
  return true;
}

function findInterviewSourceColumnIndex(headers = []) {
  const normalized = (headers || []).map(h => normalizeHeaderMatchKey(h));

  // 1) Exact canonical matches first.
  const exactCandidates = [
    'источник',
    'источник кандидата',
    'откуда вы о нас узнали',
    'откуда пришел кандидат',
    'откуда пришел кандидат',
    'источник откуда пришел'
  ];

  for (const candidate of exactCandidates) {
    const idx = normalized.findIndex(h => h === candidate);
    if (idx >= 0) return idx;
  }

  // 2) Token-based tolerant match (handles typos like "отдкуда").
  const idxByTokens = normalized.findIndex(h => {
    if (!h) return false;
    const hasSourceWord = h.includes('источник') || h.includes('реферал');
    const hasDiscoveryPhrase = h.includes('узнали') && (h.includes('откуда') || h.includes('отдкуда'));
    const hasFromCandidate = h.includes('пришел') && h.includes('кандидат');
    return hasSourceWord || hasDiscoveryPhrase || hasFromCandidate;
  });

  return idxByTokens;
}

function normalizeRow(headers, row, rowIndex) {
  const normalizedHeaders = headers.map(h => String(h || '').trim().toLowerCase());
  const normalizedHeaderKeys = headers.map(h => normalizeHeaderMatchKey(h));

  const get = (...names) => {
    for (const rawName of names) {
      const name = String(rawName || '').trim().toLowerCase();
      const idx = normalizedHeaders.indexOf(name);
      if (idx >= 0) return row[idx] ?? '';
    }

    for (const rawName of names) {
      const nameKey = normalizeHeaderMatchKey(rawName);
      if (!nameKey) continue;

      const idx = normalizedHeaderKeys.findIndex(headerKey => headerKey === nameKey);
      if (idx >= 0) return row[idx] ?? '';
    }

    for (const rawName of names) {
      const nameKey = normalizeHeaderMatchKey(rawName);
      if (!nameKey || nameKey.length < 4) continue;

      const idx = normalizedHeaderKeys.findIndex(headerKey =>
        Boolean(headerKey) && (
          headerKey.includes(nameKey) ||
          (nameKey.includes(headerKey) && headerKey.length >= 7)
        )
      );

      if (idx >= 0) return row[idx] ?? '';
    }

    return '';
  };

  const rawComments = get('Комментарии', 'Комментарий', 'Comment', 'Comments');
  const sourceColIdx = findInterviewSourceColumnIndex(headers);
  const sourceFromColumns = sourceColIdx >= 0
    ? (row[sourceColIdx] ?? '')
    : get(
      'Источник',
      'Источник кандидата',
      'Источник кандидата / реферал',
      'Источник/реферал',
      'Откуда вы о нас узнали?',
      'Откуда вы о нас узнали',
      'Откуда узнали о нас',
      'Откуда пришел кандидат',
      'Откуда пришёл кандидат',
      'Источник (откуда пришел)'
    );
  const rawSource = String(sourceFromColumns || '').trim() || extractSourceFromText(rawComments);
  const source = isValidInterviewSourceValue(rawSource) ? rawSource : '';

  return {
    id: rowIndex,
    row_number: rowIndex,
    created_at: get('Дата'),
    updated_at: get('Updated At', 'Дата обновления', 'Дата смены статуса', 'Дата обновления статуса'),
    status_changed_at: get('Дата смены статуса', 'Дата обновления статуса', 'Updated At', 'Дата обновления'),
    telegram_username: get('TG Username', 'Username'),
    telegram: get('TG Username', 'Username'),
    username: get('TG Username', 'Username'),
    telegram_user_id: get('TG ID', 'ID'),
    tg: get('TG Username', 'Username'),
    source,
    name: get('Имя', 'Как вас зовут?'),
    age: get('Возраст'),
    english: get('Английский', 'Уровень английского'),
    english_level: get('Английский', 'Уровень английского'),
    platform: get('Платформа'),
    platforms: get('Платформа'),
    shift: get('Смены', 'Смена'),
    experience: get('Опыт', 'Опыт работы', 'Опыт работы (лет)', 'Опыт в adult', 'Опыт в adult (лет)'),
    exp: get('Опыт', 'Опыт работы', 'Опыт работы (лет)', 'Опыт в adult', 'Опыт в adult (лет)'),
    profiles: get('Анкеты', 'С какими анкетами работал-а (топ, %)'),
    top_profile: get('Анкеты', 'С какими анкетами работал-а (топ, %)'),
    verification: get('Верификация', 'Вериф'),
    status: get('Статус') || 'Новая заявка',
    interviewer: get('Кто проводит собеседование'),
    interviewer_name: get('Кто проводит собеседование'),
    owner_name: get('Кто проводит собеседование'),
    interview_date: get('Дата собеседования'),
    interview_time: get('Время собеседования'),
    completed_at: get('completed_at', 'Completed At', 'Дата завершения'),
    notes: rawComments,
    comments: rawComments
  };
}

function normalizeTelegramKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
}

function normalizeNameKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase();
}

async function buildInterviewSourceFallbackMap(agencyId, interviews = []) {
  const tgSet = new Set();
  const nameSet = new Set();

  for (const item of interviews) {
    const tgKey = normalizeTelegramKey(item.telegram || item.tg || item.username || item.telegram_username);
    if (tgKey) tgSet.add(tgKey);

    const nameKey = normalizeNameKey(item.name);
    if (nameKey) nameSet.add(nameKey);
  }

  if (!tgSet.size && !nameSet.size) {
    return { byTelegram: new Map(), byName: new Map() };
  }

  const tgKeys = [...tgSet];
  const nameKeys = [...nameSet];

  const result = await query(
    `SELECT name, tg, telegram, lead_source
     FROM candidates
     WHERE agency_id = $1
       AND (
         lower(regexp_replace(coalesce(tg, ''), '^@', '')) = ANY($2::text[])
         OR lower(regexp_replace(coalesce(telegram, ''), '^@', '')) = ANY($2::text[])
         OR lower(coalesce(name, '')) = ANY($3::text[])
       )`,
    [agencyId, tgKeys, nameKeys]
  );

  const byTelegram = new Map();
  const byName = new Map();

  for (const row of result.rows) {
    const source = String(row.lead_source || '').trim();
    if (!isValidInterviewSourceValue(source)) continue;

    const tgKey = normalizeTelegramKey(row.tg || row.telegram);
    if (tgKey && !byTelegram.has(tgKey)) {
      byTelegram.set(tgKey, source);
    }

    const nameKey = normalizeNameKey(row.name);
    if (nameKey && !byName.has(nameKey)) {
      byName.set(nameKey, source);
    }
  }

  return { byTelegram, byName };
}

function applyInterviewSourceFallback(item, sourceMap) {
  const current = String(item.source || '').trim();
  if (isValidInterviewSourceValue(current)) return item;

  const tgKey = normalizeTelegramKey(item.telegram || item.tg || item.username || item.telegram_username);
  const nameKey = normalizeNameKey(item.name);

  const fallback =
    sourceMap?.byTelegram?.get(tgKey) ||
    sourceMap?.byName?.get(nameKey) ||
    '';

  if (!isValidInterviewSourceValue(fallback)) return {
    ...item,
    source: ''
  };

  return {
    ...item,
    source: fallback
  };
}

function mergeInterviewCrmMeta(candidate, meta) {
  if (!meta) return candidate;

  const completedAtDate = meta.interview_completed_at || null;

  return {
    ...candidate,
    crm_created_at: meta.created_at || '',
    crm_status_changed_at: meta.status_changed_at || '',
    crm_interview_completed_at: completedAtDate || '',
    interview_date: candidate.interview_date || (completedAtDate ? formatRuDate(completedAtDate) : '')
  };
}

async function getInterviewCrmMetaMap(agencyId, rowNumbers = []) {
  const normalizedRowNumbers = [...new Set(rowNumbers.map(Number).filter(x => Number.isInteger(x) && x > 1))];
  if (!normalizedRowNumbers.length) return new Map();

  const result = await query(
    `SELECT agency_id, row_number, created_at, updated_at, status_changed_at, interview_completed_at
     FROM interview_crm_meta
     WHERE agency_id = $1 AND row_number = ANY($2::int[])`,
    [agencyId, normalizedRowNumbers]
  );

  return new Map(result.rows.map(row => [Number(row.row_number), row]));
}

async function getInterviewCrmMeta(agencyId, rowNumber) {
  const map = await getInterviewCrmMetaMap(agencyId, [rowNumber]);
  return map.get(Number(rowNumber)) || null;
}

async function ensureInterviewCrmMeta(agencyId, rowNumber, fallbackCreatedAt = null) {
  const createdAt = normalizeDateInput(fallbackCreatedAt) || new Date();

  await query(
    `INSERT INTO interview_crm_meta (agency_id, row_number, created_at, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agency_id, row_number)
     DO UPDATE SET updated_at = interview_crm_meta.updated_at`,
    [agencyId, Number(rowNumber), createdAt]
  );

  return getInterviewCrmMeta(agencyId, rowNumber);
}

async function updateInterviewCrmMeta(agencyId, rowNumber, patch = {}, fallbackCreatedAt = null) {
  const createdAt = normalizeDateInput(fallbackCreatedAt) || new Date();
  const statusChangedAt = patch.status_changed_at || null;
  const interviewCompletedAt = patch.interview_completed_at || null;

  const result = await query(
    `INSERT INTO interview_crm_meta (
       agency_id,
       row_number,
       created_at,
       updated_at,
       status_changed_at,
       interview_completed_at
     )
     VALUES ($1, $2, $3, NOW(), $4, $5)
     ON CONFLICT (agency_id, row_number)
     DO UPDATE SET
       updated_at = NOW(),
       status_changed_at = COALESCE($4, interview_crm_meta.status_changed_at),
       interview_completed_at = COALESCE($5, interview_crm_meta.interview_completed_at)
     RETURNING agency_id, row_number, created_at, updated_at, status_changed_at, interview_completed_at`,
    [agencyId, Number(rowNumber), createdAt, statusChangedAt, interviewCompletedAt]
  );

  return result.rows[0] || null;
}

async function ensureInterviewCrmMetaForCandidates(agencyId, candidates = []) {
  const rows = candidates
    .map(candidate => ({
      row_number: Number(candidate.row_number || candidate.id),
      created_at: normalizeDateInput(candidate.created_at) || new Date()
    }))
    .filter(item => Number.isInteger(item.row_number) && item.row_number > 1);

  if (!rows.length) return;

  const values = [];
  const placeholders = rows.map((item, index) => {
    const base = index * 3;
    values.push(agencyId, item.row_number, item.created_at);
    return `($${base + 1}, $${base + 2}, $${base + 3}, NOW())`;
  });

  await query(
    `INSERT INTO interview_crm_meta (agency_id, row_number, created_at, updated_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (agency_id, row_number) DO NOTHING`,
    values
  );
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

async function logCrmEvent({
  entityType,
  entityId,
  eventType,
  oldValue = '',
  newValue = '',
  meta = {},
  createdBy = ''
}) {
  try {
    await pool.query(
      `
      INSERT INTO crm_events (
        entity_type,
        entity_id,
        event_type,
        old_value,
        new_value,
        meta_json,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      `,
      [
        String(entityType || ''),
        String(entityId || ''),
        String(eventType || ''),
        String(oldValue || ''),
        String(newValue || ''),
        JSON.stringify(meta || {}),
        String(createdBy || '')
      ]
    );
  } catch (err) {
    console.error('logCrmEvent error:', err.message);
  }
}

function startOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + diff);
  return d;
}

function endOfWeek(date = new Date()) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function startOfMonth(date = new Date()) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfMonth(date = new Date()) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function resolveDashboardPeriodRange({ period = 'week', mode = 'current' } = {}) {
  const normalizedPeriod = String(period || 'week').trim().toLowerCase() === 'month' ? 'month' : 'week';
  const normalizedMode = String(mode || 'current').trim().toLowerCase() === 'previous' ? 'previous' : 'current';
  const now = new Date();

  let fromDate;
  let toDate;
  let previousFrom;
  let previousTo;

  if (normalizedPeriod === 'month') {
    const base = new Date(now);
    if (normalizedMode === 'previous') {
      base.setMonth(base.getMonth() - 1);
    }

    fromDate = startOfMonth(base);
    toDate = endOfMonth(base);

    const prevBase = new Date(base);
    prevBase.setMonth(prevBase.getMonth() - 1);
    previousFrom = startOfMonth(prevBase);
    previousTo = endOfMonth(prevBase);
  } else {
    const base =
      normalizedMode === 'previous'
        ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        : now;

    fromDate = startOfWeek(base);
    toDate = endOfWeek(base);

    previousFrom = new Date(fromDate);
    previousFrom.setDate(previousFrom.getDate() - 7);
    previousFrom.setHours(0, 0, 0, 0);

    previousTo = new Date(toDate);
    previousTo.setDate(previousTo.getDate() - 7);
    previousTo.setHours(23, 59, 59, 999);
  }

  return {
    period: normalizedPeriod,
    mode: normalizedMode,
    fromDate,
    toDate,
    previousFrom,
    previousTo
  };
}

function formatDateOnly(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWithinRange(date, from, to) {
  const d = new Date(date);
  return !Number.isNaN(d.getTime()) && d >= from && d <= to;
}

function normalizeDateInput(value) {
  if (!value) return null;

  const str = String(value).trim();

  const fullDateTime = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (fullDateTime) {
    const [, dd, mm, yyyy, hh = '12', min = '00'] = fullDateTime;
    return new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${min}:00`);
  }

  const shortYearDate = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (shortYearDate) {
    const [, dd, mm, yy] = shortYearDate;
    const yyyy = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
    return new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T12:00:00`);
  }

  const fullDate = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (fullDate) {
    const [, dd, mm, yyyy] = fullDate;
    return new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
  }

  const shortDate = str.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (shortDate) {
    const [, dd, mm] = shortDate;
    const yyyy = new Date().getFullYear();
    return new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T12:00:00`);
  }

  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatRuDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';

  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();

  return `${dd}.${mm}.${yyyy}`;
}

function isPreInterviewStatus(status) {
  const s = String(status || '').trim();
  return !s || s === 'Назначено собеседование' || s === 'Ждет собеседования';
}

function hasInterviewOccurredByStatus(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  return !isPreInterviewStatus(s);
}

function buildBackfillEvent({
  entityType,
  entityId,
  eventType,
  date,
  oldValue = '',
  newValue = '',
  meta = {},
  createdBy = 'backfill',
  agencyId = null,
  approximate = false
}) {
  const normalizedAgencyId = Number.isInteger(Number(agencyId)) && Number(agencyId) > 0
    ? Number(agencyId)
    : null;

  return {
    id: `bf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    entity_type: String(entityType || ''),
    entity_id: String(entityId || ''),
    event_type: String(eventType || ''),
    old_value: String(oldValue || ''),
    new_value: String(newValue || ''),
    meta: {
      ...meta,
      ...(normalizedAgencyId ? { agencyId: normalizedAgencyId } : {}),
      approximate
    },
    agency_id: normalizedAgencyId,
    created_at: new Date(date).toISOString(),
    created_by: createdBy
  };
}

async function loadAllCandidatesForBackfill(agencyId) {
  try {
    const result = await query(
      `SELECT
         id,
         created_at,
         updated_at,
         name,
         tg,
         telegram,
         platform,
         platforms,
         status,
         hired_at,
         rejected_at,
         started_at,
         fired_at
       FROM candidates
       WHERE agency_id = $1
       ORDER BY created_at DESC`,
      [agencyId]
    );

    return result.rows || [];
  } catch (err) {
    console.warn('loadAllCandidatesForBackfill fallback:', err.message);
    return [];
  }
}

function pushCandidateDateBackfillEvent(newEvents, candidate, agencyId, dateValue, newValue) {
  const eventDate = normalizeDateInput(dateValue);
  if (!eventDate) return;

  newEvents.push(buildBackfillEvent({
    entityType: 'candidate',
    entityId: candidate.id || candidate.row_number || candidate.name,
    eventType: 'status_changed',
    date: eventDate,
    agencyId,
    newValue,
    meta: {
      name: candidate.name || '',
      telegram: candidate.telegram || candidate.tg || '',
      platform: candidate.platform || candidate.platforms || ''
    }
  }));
}

async function loadCandidateStatusHistoryForBackfill(agencyId) {
  try {
    const result = await query(
      `SELECT
         h.candidate_id,
         h.status,
         h.created_at,
         c.name,
         c.tg,
         c.telegram,
         c.platform,
         c.platforms
       FROM candidate_status_history h
       JOIN candidates c ON c.id = h.candidate_id
       WHERE c.agency_id = $1
       ORDER BY h.created_at DESC`,
      [agencyId]
    );

    return result.rows || [];
  } catch (err) {
    console.warn('loadCandidateStatusHistoryForBackfill fallback:', err.message);
    return [];
  }
}

async function loadAllInterviewsForBackfill() {
  if (LIVE_BACKFILL_DISABLED) return [];

  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) return [];

    const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU5000`
    });

    const values = response.data.values || [];
    if (!values.length) return [];

    const headers = values[0];
    const rows = values.slice(1);

    return rows
      .map((row, index) => {
        const normalized = normalizeRow(headers, row, index + 2);
        const get = (...names) => {
          for (const name of names) {
            const idx = headers.indexOf(name);
            if (idx >= 0) return row[idx] ?? '';
          }
          return '';
        };

        return {
          ...normalized,
          completed_at: get('completed_at', 'Completed At', 'Дата завершения'),
          updated_at: get('updated_at', 'Updated At', 'Дата обновления'),
          tg: normalized.tg || normalized.telegram || normalized.username || ''
        };
      })
      .filter(x => x.telegram_user_id || x.telegram_username || x.name);
  } catch (err) {
    console.warn('loadAllInterviewsForBackfill fallback:', err.message);
    return [];
  }
}

async function loadAllTeamMembersForBackfill() {
  if (LIVE_BACKFILL_DISABLED) return [];

  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    if (!spreadsheetId) return [];

    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU5000`
    });

    const values = response.data.values || [];
    if (!values.length) return [];

    const headers = values[0];
    const rows = values.slice(1);

    return rows
      .filter(row => row.some(cell => String(cell || '').trim() !== ''))
      .map((row, index) => {
        const obj = {};
        headers.forEach((header, colIndex) => {
          obj[header] = row[colIndex] || '';
        });

        const model = String(
          obj['Модели (основные)'] ||
          obj['Модели'] ||
          obj['Актуальная модель'] ||
          obj['Топ страниц'] ||
          ''
        ).trim();

        return {
          row_number: index + 2,
          name: String(obj['Имя'] || obj['Имя / ник'] || obj['Ник'] || '').trim(),
          telegram: String(obj['Телеграм'] || obj['Telegram'] || obj['ТГ'] || obj['Telegram / username'] || obj['TG Username'] || obj['Username'] || '').trim(),
          status: String(obj['Актуальный статус кандидата (Hr)'] || '').trim() || 'Без статуса',
          platform: String(obj['OnlyFans / Fansly'] || obj['Платформа'] || '').trim(),
          model,
          date_start: String(obj['Дата старта'] || '').trim(),
          date_fired: String(obj['Дата увольнения'] || obj['Дата уволен'] || obj['Дата расчета'] || obj['Дата расчёта'] || '').trim(),
          updated_at: String(obj['Updated At'] || obj['Дата обновления'] || '').trim(),
          raw: obj
        };
      });
  } catch (err) {
    console.warn('loadAllTeamMembersForBackfill fallback:', err.message);
    return [];
  }
}

async function collectBackfillEvents({ agencyId, fromDate, toDate }) {
  const candidates = await loadAllCandidatesForBackfill(agencyId);
  const candidateStatusHistory = await loadCandidateStatusHistoryForBackfill(agencyId);
  const interviews = await loadAllInterviewsForBackfill();
  const teamMembers = await loadAllTeamMembersForBackfill();
  const newEvents = [];

  for (const c of candidates) {
    const createdAt = normalizeDateInput(c.created_at || c.date_created || c.created);
    if (createdAt && isWithinRange(createdAt, fromDate, toDate)) {
      newEvents.push(buildBackfillEvent({
        entityType: 'candidate',
        entityId: c.id || c.row_number || c.name,
        eventType: 'lead_created',
        date: createdAt,
        agencyId,
        meta: {
          name: c.name || '',
          telegram: c.telegram || c.tg || '',
          platform: c.platform || c.platforms || ''
        }
      }));
    }

    if (c.hired_at && isWithinRange(c.hired_at, fromDate, toDate)) {
      pushCandidateDateBackfillEvent(newEvents, c, agencyId, c.hired_at, 'Принятый');
    }

    if (c.started_at && isWithinRange(c.started_at, fromDate, toDate)) {
      pushCandidateDateBackfillEvent(newEvents, c, agencyId, c.started_at, STARTED_CANDIDATE_STATUS);
    }

    if (c.rejected_at && isWithinRange(c.rejected_at, fromDate, toDate)) {
      pushCandidateDateBackfillEvent(newEvents, c, agencyId, c.rejected_at, REJECTED_CANDIDATE_STATUS);
    }

    if (c.fired_at && isWithinRange(c.fired_at, fromDate, toDate)) {
      pushCandidateDateBackfillEvent(newEvents, c, agencyId, c.fired_at, FIRED_CANDIDATE_STATUS);
    }
  }

  for (const i of interviews) {
    const interviewLeadAt = normalizeDateInput(i.created_at || i.updated_at || i.interview_date || i.completed_at);
    if (interviewLeadAt && isWithinRange(interviewLeadAt, fromDate, toDate)) {
      newEvents.push(buildBackfillEvent({
        entityType: 'interview',
        entityId: i.id || i.row_number || i.name,
        eventType: 'lead_created',
        date: interviewLeadAt,
        agencyId,
        meta: {
          name: i.name || '',
          telegram: i.telegram || i.tg || '',
          platform: i.platform || i.platforms || ''
        },
        approximate: !i.created_at && !!(i.updated_at || i.interview_date || i.completed_at)
      }));
    }

    const interviewAt = normalizeDateInput(i.interview_date || i.completed_at || i.updated_at);
    if (interviewAt && isWithinRange(interviewAt, fromDate, toDate)) {
      newEvents.push(buildBackfillEvent({
        entityType: 'interview',
        entityId: i.id || i.row_number || i.name,
        eventType: 'interview_completed',
        date: interviewAt,
        agencyId,
        meta: {
          name: i.name || '',
          telegram: i.telegram || i.tg || '',
          platform: i.platform || i.platforms || ''
        },
        approximate: !i.interview_date && !!(i.completed_at || i.updated_at)
      }));
    }

    const interviewStatus = String(i.status || '').trim();
    if (['Отказ', 'Отказ до собеседования', 'Отказ после собеседования'].includes(interviewStatus)) {
      const rejectAt = normalizeDateInput(i.interview_date || i.completed_at || i.updated_at || i.created_at);
      if (rejectAt && isWithinRange(rejectAt, fromDate, toDate)) {
        newEvents.push(buildBackfillEvent({
          entityType: 'candidate',
          entityId: i.id || i.row_number || i.name,
          eventType: 'status_changed',
          date: rejectAt,
          agencyId,
          newValue: REJECTED_CANDIDATE_STATUS,
          meta: {
            name: i.name || '',
            telegram: i.telegram || i.tg || '',
            platform: i.platform || i.platforms || ''
          },
          approximate: !i.interview_date && !!(i.completed_at || i.updated_at || i.created_at)
        }));
      }
    }
  }

  for (const item of candidateStatusHistory) {
    const status = normalizeStatusAlias(item.status);
    if (!DASHBOARD_TRACKED_STATUSES.has(status)) continue;

    const eventDate = normalizeDateInput(item.created_at);
    if (eventDate && isWithinRange(eventDate, fromDate, toDate)) {
      newEvents.push(buildBackfillEvent({
        entityType: 'candidate',
        entityId: item.candidate_id || item.name,
        eventType: 'status_changed',
        date: eventDate,
        agencyId,
        newValue: status,
        meta: {
          name: item.name || '',
          telegram: item.telegram || item.tg || '',
          platform: item.platform || item.platforms || ''
        }
      }));
    }
  }

  for (const m of teamMembers) {
    const teamStatus = String(m.status || '').trim();
    const startDate = normalizeDateInput(m.date_start);
    if (startDate && isWithinRange(startDate, fromDate, toDate)) {
      newEvents.push(buildBackfillEvent({
        entityType: 'team_member',
        entityId: m.id || m.row_number || m.name,
        eventType: 'status_changed',
        date: startDate,
        agencyId,
        newValue: STARTED_CANDIDATE_STATUS,
        meta: {
          name: m.name || '',
          telegram: m.telegram || '',
          platform: m.platform || ''
        }
      }));
    }

    const firedDate = normalizeDateInput(m.date_fired);
    if (firedDate && isWithinRange(firedDate, fromDate, toDate)) {
      newEvents.push(buildBackfillEvent({
        entityType: 'team_member',
        entityId: m.id || m.row_number || m.name,
        eventType: 'status_changed',
        date: firedDate,
        agencyId,
        newValue: FIRED_CANDIDATE_STATUS,
        meta: {
          name: m.name || '',
          telegram: m.telegram || '',
          platform: m.platform || ''
        }
      }));
    }

    const fallbackStatusDate = normalizeDateInput(m.updated_at);

    if (
      !firedDate &&
      teamStatus === FIRED_CANDIDATE_STATUS &&
      fallbackStatusDate &&
      isWithinRange(fallbackStatusDate, fromDate, toDate)
    ) {
      newEvents.push(buildBackfillEvent({
        entityType: 'team_member',
        entityId: m.id || m.row_number || m.name,
        eventType: 'status_changed',
        date: fallbackStatusDate,
        agencyId,
        newValue: FIRED_CANDIDATE_STATUS,
        meta: {
          name: m.name || '',
          telegram: m.telegram || '',
          platform: m.platform || ''
        },
        approximate: true
      }));
    }

    if (
      teamStatus === UNPAID_CANDIDATE_STATUS &&
      fallbackStatusDate &&
      isWithinRange(fallbackStatusDate, fromDate, toDate)
    ) {
      newEvents.push(buildBackfillEvent({
        entityType: 'team_member',
        entityId: m.id || m.row_number || m.name,
        eventType: 'status_changed',
        date: fallbackStatusDate,
        agencyId,
        newValue: UNPAID_CANDIDATE_STATUS,
        meta: {
          name: m.name || '',
          telegram: m.telegram || '',
          platform: m.platform || ''
        },
        approximate: true
      }));
    }
  }

  return newEvents;
}

function mergeCrmEvents(existingEvents, newEvents) {
  const existingKeys = new Set(
    existingEvents.map(e =>
      [
        String(e.agency_id || getDashboardEventMeta(e).agencyId || ''),
        e.entity_type,
        e.entity_id,
        e.event_type,
        e.new_value || '',
        formatDateOnly(e.created_at)
      ].join('|')
    )
  );

  const filteredNew = newEvents.filter(e => {
    const key = [
      String(e.agency_id || getDashboardEventMeta(e).agencyId || ''),
      e.entity_type,
      e.entity_id,
      e.event_type,
      e.new_value || '',
      formatDateOnly(e.created_at)
    ].join('|');

    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  const merged = [...existingEvents, ...filteredNew].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  return {
    filteredNew,
    merged
  };
}

function summarizeDashboardEvents(events, from, to) {
  const summary = {
    leads: 0,
    interviews: 0,
    hired: 0,
    rejected: 0,
    fired: 0,
    raw_total: 0
  };

  const samples = [];

  for (const event of events) {
    if (!isWithinRange(event.created_at, from, to)) continue;

    summary.raw_total += 1;
    const next = String(event.new_value || '').trim();

    if (event.event_type === 'lead_created') summary.leads += 1;
    if (event.event_type === 'interview_completed') summary.interviews += 1;
    if (event.event_type === 'status_changed' && isDashboardHiredStatus(next)) summary.hired += 1;
    if (event.event_type === 'status_changed' && next === REJECTED_CANDIDATE_STATUS) summary.rejected += 1;
    if (event.event_type === 'status_changed' && OFFBOARDED_CANDIDATE_STATUSES.has(next)) summary.fired += 1;

    if (samples.length < 10) {
      samples.push({
        created_at: event.created_at,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        event_type: event.event_type,
        new_value: event.new_value || '',
        meta: event.meta || {}
      });
    }
  }

  return {
    summary,
    samples
  };
}

function getStatusDatePatch(status, existingDates = {}) {
  const normalizedStatus = String(status || '').trim();
  if (!normalizedStatus) return {};

  const now = new Date();
  const hasValue = value => value !== null && value !== undefined && String(value).trim() !== '';
  const patch = {
    status_changed_at: now
  };

  switch (normalizedStatus) {
    case 'Принятый':
    case 'Работает':
      if (!hasValue(existingDates.hired_at)) {
        patch.hired_at = now;
      }
      break;

    case REJECTED_CANDIDATE_STATUS:
      if (!hasValue(existingDates.rejected_at)) {
        patch.rejected_at = now;
      }
      break;

    case STARTED_CANDIDATE_STATUS:
      if (!hasValue(existingDates.started_at)) {
        patch.started_at = now;
      }
      break;

    case FIRED_CANDIDATE_STATUS:
      if (!hasValue(existingDates.fired_at)) {
        patch.fired_at = now;
      }
      break;

    default:
      break;
  }

  return patch;
}

async function moveCandidateToTeamSheet(candidate) {
  ensureSheetsWriteEnabled();

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
    'Актуальный статус кандидата (Hr)': candidate.teamStatus || candidate.status || 'Ждет тест',
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

  invalidateTeamStatsCache();
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

function normalizeTelegramKey(value) {
  return String(value || '').trim().toLowerCase().replace(/^@+/, '');
}

async function syncInterviewSheetStatus({ status, telegram, name }) {
  if (!SHEETS_WRITE_ENABLED) {
    return { updated: 0, skipped: 'sheets_write_disabled' };
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';
  const normalizedStatus = normalizeInterviewStatus(status);
  const telegramKey = normalizeTelegramKey(telegram);
  const personName = String(name || '').trim();

  if (!spreadsheetId || !normalizedStatus || (!telegramKey && !personName)) {
    return { updated: 0 };
  }

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:AU5000`
  });

  const values = response.data.values || [];
  if (!values.length) return { updated: 0 };

  const headers = values[0] || [];
  const rows = values.slice(1);

  const statusIdx = findHeaderIndex(headers, ['Статус'], ['статус']);
  const tgIdx = findHeaderIndex(headers, ['TG Username', 'Username'], ['username', 'tg username', 'telegram']);
  const nameIdx = findHeaderIndex(headers, ['Имя', 'Как вас зовут?'], ['имя']);

  if (statusIdx < 0) return { updated: 0 };

  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 2;
    const rowStatus = String(row[statusIdx] || '').trim();
    const rowTelegramKey = tgIdx >= 0 ? normalizeTelegramKey(row[tgIdx]) : '';
    const rowName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';

    const matchedByTelegram = telegramKey && rowTelegramKey && rowTelegramKey === telegramKey;
    const matchedByName = !telegramKey && personName && rowName && namesLooselyMatch(personName, rowName);

    if ((matchedByTelegram || matchedByName) && rowStatus !== normalizedStatus) {
      const colLetter = columnToLetter(statusIdx + 1);
      updates.push({
        range: `${sheetName}!${colLetter}${rowNumber}`,
        values: [[normalizedStatus]]
      });
    }
  }

  if (!updates.length) return { updated: 0 };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates
    }
  });

  return { updated: updates.length };
}

async function syncInterviewSheetPlatform({ platform, shift, englishLevel, telegram, name }) {
  if (!SHEETS_WRITE_ENABLED) {
    return { updated: 0, skipped: 'sheets_write_disabled' };
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';
  const nextPlatform = String(platform || '').trim();
  const nextShift = String(shift || '').trim();
  const nextEnglish = String(englishLevel || '').trim();
  const telegramKey = normalizeTelegramKey(telegram);
  const personName = String(name || '').trim();

  if (!spreadsheetId || (!nextPlatform && !nextShift && !nextEnglish) || (!telegramKey && !personName)) {
    return { updated: 0 };
  }

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:ZZ5000`
  });

  const values = response.data.values || [];
  if (!values.length) return { updated: 0 };

  const headers = values[0] || [];
  const rows = values.slice(1);

  const platformIdx = findHeaderIndex(headers, ['Платформа', 'OnlyFans / Fansly'], ['платформа', 'onlyfans', 'fansly']);
  const shiftIdx = findHeaderIndex(headers, ['Смены', 'Смена'], ['смены', 'смена', 'shift']);
  const englishIdx = findHeaderIndex(headers, ['Английский', 'Уровень английского'], ['англий', 'english']);
  const tgIdx = findHeaderIndex(headers, ['TG Username', 'Username'], ['username', 'tg username', 'telegram']);
  const nameIdx = findHeaderIndex(headers, ['Имя', 'Как вас зовут?'], ['имя']);

  if (platformIdx < 0 && shiftIdx < 0 && englishIdx < 0) return { updated: 0 };

  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 2;
    const rowPlatform = platformIdx >= 0 ? String(row[platformIdx] || '').trim() : '';
    const rowShift = shiftIdx >= 0 ? String(row[shiftIdx] || '').trim() : '';
    const rowEnglish = englishIdx >= 0 ? String(row[englishIdx] || '').trim() : '';
    const rowTelegramKey = tgIdx >= 0 ? normalizeTelegramKey(row[tgIdx]) : '';
    const rowName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';

    const matchedByTelegram = telegramKey && rowTelegramKey && rowTelegramKey === telegramKey;
    const matchedByName = !telegramKey && personName && rowName && namesLooselyMatch(personName, rowName);

    if (matchedByTelegram || matchedByName) {
      if (nextPlatform && platformIdx >= 0 && rowPlatform !== nextPlatform) {
        const colLetter = columnToLetter(platformIdx + 1);
        updates.push({
          range: `${sheetName}!${colLetter}${rowNumber}`,
          values: [[nextPlatform]]
        });
      }

      if (nextShift && shiftIdx >= 0 && rowShift !== nextShift) {
        const colLetter = columnToLetter(shiftIdx + 1);
        updates.push({
          range: `${sheetName}!${colLetter}${rowNumber}`,
          values: [[nextShift]]
        });
      }

      if (nextEnglish && englishIdx >= 0 && rowEnglish !== nextEnglish) {
        const colLetter = columnToLetter(englishIdx + 1);
        updates.push({
          range: `${sheetName}!${colLetter}${rowNumber}`,
          values: [[nextEnglish]]
        });
      }
    }
  }

  if (!updates.length) return { updated: 0 };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates
    }
  });

  return { updated: updates.length };
}

async function syncCandidatesPlatformFromInterview({ agencyId, platform, shift, englishLevel, telegram, name, updatedByUserId }) {
  const nextPlatform = String(platform || '').trim();
  const nextShift = String(shift || '').trim();
  const nextEnglish = String(englishLevel || '').trim();
  const telegramKey = normalizeTelegramKey(telegram);
  const personName = String(name || '').trim();

  if (!agencyId || (!nextPlatform && !nextShift && !nextEnglish) || (!telegramKey && !personName)) {
    return { updated: 0 };
  }

  const result = await query(
    `SELECT id, tg, telegram, name, platform, platforms, shift, english, english_level
     FROM candidates
     WHERE agency_id = $1`,
    [agencyId]
  );

  const matchedIds = result.rows
    .filter(row => {
      const rowTgKey = normalizeTelegramKey(row.telegram || row.tg);
      const byTelegram = telegramKey && rowTgKey && rowTgKey === telegramKey;
      const byName = !telegramKey && personName && row.name && namesLooselyMatch(personName, row.name);
      return byTelegram || byName;
    })
    .filter(row => {
      const platformDiff = nextPlatform && String(row.platform || row.platforms || '').trim() !== nextPlatform;
      const shiftDiff = nextShift && String(row.shift || '').trim() !== nextShift;
      const englishDiff = nextEnglish && String(row.english_level || row.english || '').trim() !== nextEnglish;
      return platformDiff || shiftDiff || englishDiff;
    })
    .map(row => Number(row.id))
    .filter(id => Number.isInteger(id) && id > 0);

  if (!matchedIds.length) return { updated: 0 };

  await query(
    `UPDATE candidates
     SET platform = CASE WHEN $3 <> '' THEN $3 ELSE platform END,
         platforms = CASE WHEN $3 <> '' THEN $3 ELSE platforms END,
         shift = CASE WHEN $4 <> '' THEN $4 ELSE shift END,
         english = CASE WHEN $5 <> '' THEN $5 ELSE english END,
         english_level = CASE WHEN $5 <> '' THEN $5 ELSE english_level END,
         updated_at = NOW(),
         updated_by_user_id = COALESCE($6, updated_by_user_id)
     WHERE agency_id = $1 AND id = ANY($2::int[])`,
    [agencyId, matchedIds, nextPlatform, nextShift, nextEnglish, updatedByUserId || null]
  );

  return { updated: matchedIds.length };
}

async function syncTeamSheetStatus({ status, telegram, name }) {
  if (!SHEETS_WRITE_ENABLED) {
    return { updated: 0, skipped: 'sheets_write_disabled' };
  }

  const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
  const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
  const normalizedStatus = normalizeTeamStatus(status);
  const telegramKey = normalizeTelegramKey(telegram);
  const personName = String(name || '').trim();

  if (!spreadsheetId || !normalizedStatus || (!telegramKey && !personName)) {
    return { updated: 0 };
  }

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:AU5000`
  });

  const values = response.data.values || [];
  if (!values.length) return { updated: 0 };

  const headers = values[0] || [];
  const rows = values.slice(1);

  const statusIdx = findHeaderIndex(headers, ['Актуальный статус кандидата (Hr)'], ['статус кандидата', 'актуальный статус', 'status']);
  const tgIdx = findHeaderIndex(headers, ['Телеграм', 'Telegram', 'TG Username', 'Username'], ['телеграм', 'telegram', 'username']);
  const nameIdx = findHeaderIndex(headers, ['Имя', 'Имя / ник', 'Ник'], ['имя', 'ник']);

  if (statusIdx < 0) return { updated: 0 };

  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 2;
    const rowStatus = String(row[statusIdx] || '').trim();
    const rowTelegramKey = tgIdx >= 0 ? normalizeTelegramKey(row[tgIdx]) : '';
    const rowName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';

    const matchedByTelegram = telegramKey && rowTelegramKey && rowTelegramKey === telegramKey;
    const matchedByName = !telegramKey && personName && rowName && namesLooselyMatch(personName, rowName);

    if ((matchedByTelegram || matchedByName) && rowStatus !== normalizedStatus) {
      const colLetter = columnToLetter(statusIdx + 1);
      updates.push({
        range: `${sheetName}!${colLetter}${rowNumber}`,
        values: [[normalizedStatus]]
      });
    }
  }

  if (!updates.length) return { updated: 0 };

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates
    }
  });

  invalidateTeamStatsCache();

  return { updated: updates.length };
}

async function syncCandidatesStatusInDb({ agencyId, status, telegram, name, updatedByUserId }) {
  const normalizedStatus = normalizeCandidateStatus(status);
  const telegramKey = normalizeTelegramKey(telegram);
  const personName = String(name || '').trim();

  if (!agencyId || !normalizedStatus || (!telegramKey && !personName)) {
    return { updated: 0 };
  }

  const result = await query(
    `SELECT id, status, name, tg, telegram, hired_at, rejected_at, started_at, fired_at
     FROM candidates
     WHERE agency_id = $1`,
    [agencyId]
  );

  const matched = result.rows.filter(row => {
    const rowTelegramKey = normalizeTelegramKey(row.telegram || row.tg);
    if (telegramKey && rowTelegramKey) {
      return rowTelegramKey === telegramKey;
    }

    return !telegramKey && personName && namesLooselyMatch(personName, row.name || '');
  });

  let updated = 0;

  for (const row of matched) {
    const prevStatus = String(row.status || '').trim();
    if (prevStatus === normalizedStatus) continue;

    const statusDatePatch = getStatusDatePatch(normalizedStatus, row);

    await query(
      `UPDATE candidates
       SET status = $2,
           updated_by_user_id = $3,
           updated_at = NOW(),
           status_changed_at = COALESCE($4, status_changed_at),
           hired_at = COALESCE($5, hired_at),
           rejected_at = COALESCE($6, rejected_at),
           started_at = COALESCE($7, started_at),
           fired_at = COALESCE($8, fired_at)
       WHERE id = $1`,
      [
        row.id,
        normalizedStatus,
        updatedByUserId || null,
        statusDatePatch.status_changed_at || null,
        statusDatePatch.hired_at || null,
        statusDatePatch.rejected_at || null,
        statusDatePatch.started_at || null,
        statusDatePatch.fired_at || null
      ]
    );

    await query(
      `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
       VALUES ($1, $2, $3)`,
      [row.id, normalizedStatus, updatedByUserId || null]
    );

    updated += 1;
  }

  return { updated };
}

async function loadAgencyCandidatesForStatusOverlay(agencyId) {
  if (!agencyId) return [];

  const result = await query(
    `SELECT id, name, tg, telegram, status, updated_at, created_at
     FROM candidates
     WHERE agency_id = $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC`,
    [agencyId]
  );

  return result.rows || [];
}

function findCandidateByIdentity(candidates, { telegram, name }) {
  const telegramKey = normalizeTelegramKey(telegram || '');
  const personName = String(name || '').trim();
  const list = Array.isArray(candidates) ? candidates : [];

  if (telegramKey) {
    const byTelegram = list.find((row) => {
      const rowTelegramKey = normalizeTelegramKey(row.telegram || row.tg || '');
      return rowTelegramKey && rowTelegramKey === telegramKey;
    });

    if (byTelegram) return byTelegram;
  }

  if (!personName) return null;

  const byName = list.filter((row) => namesLooselyMatch(personName, row.name || ''));
  if (byName.length === 1) return byName[0];

  // When multiple name matches exist, avoid overlaying a potentially wrong candidate.
  return null;
}

async function overlayStatusesFromCrm(agencyId, items, mapItemIdentity) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;

  const candidates = await loadAgencyCandidatesForStatusOverlay(agencyId);
  if (!candidates.length) return list;

  return list.map((item) => {
    const identity = mapItemIdentity(item) || {};
    const matched = findCandidateByIdentity(candidates, identity);
    if (!matched) return item;

    const crmStatus = normalizeStatusAlias(matched.status || '') || String(matched.status || '').trim();
    if (!crmStatus) return item;

    return {
      ...item,
      status: crmStatus
    };
  });
}

async function syncStatusAcrossSources({
  source,
  agencyId,
  status,
  telegram,
  name,
  updatedByUserId
}) {
  const tasks = [];

  // Status sync to Google Sheets is intentionally disabled for new updates.
  // Existing sheet rows remain untouched.

  // Keep duplicates in candidates DB consistent regardless of source.
  tasks.push(syncCandidatesStatusInDb({
    agencyId,
    status,
    telegram,
    name,
    updatedByUserId
  }));

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.error('syncStatusAcrossSources error:', result.reason?.message || result.reason);
    }
  }
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
  telegram TEXT DEFAULT '',
  age TEXT DEFAULT '',
  english TEXT DEFAULT '',
  english_level TEXT DEFAULT '',
  exp TEXT DEFAULT '',
  experience TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  platforms TEXT DEFAULT '',
  shift TEXT DEFAULT '',
  schedule TEXT DEFAULT '',
  schedule_preference TEXT DEFAULT '',
  top_pages TEXT DEFAULT '',
  top_profile TEXT DEFAULT '',
  avg_check TEXT DEFAULT '',
  job TEXT DEFAULT '',
  main_activity TEXT DEFAULT '',
  interview_report TEXT DEFAULT '',
  team_card_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT DEFAULT '',
  stage TEXT DEFAULT 'new',
  source TEXT DEFAULT 'manual',
  lead_source TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status_changed_at TIMESTAMPTZ,
  hired_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  fired_at TIMESTAMPTZ,
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
  try {
    // Test connection first
    const client = await pool.connect();
    client.release();
    console.log('Database connection verified ✓');
  } catch (err) {
    console.error('Failed to connect to database:', err.message);
    console.warn('Server will start but database features will be unavailable');
    return;
  }

  try {
    await query(bootstrapSql);
    console.log('Database schema initialized ✓');
  } catch (err) {
    console.warn('Warning initializing schema:', err.message);
  }

  await pool.query(`
    ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS telegram TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS english_level TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS experience TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS schedule_preference TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS top_profile TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS main_activity TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS interview_report TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS team_card_meta JSONB NOT NULL DEFAULT '{}'::jsonb
  `).catch(() => {});

  await pool.query(`
    ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lead_source TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS hired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fired_at TIMESTAMPTZ
  `).catch(() => {});

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transaction_endings (
      id SERIAL PRIMARY KEY,
      ending INT UNIQUE NOT NULL,
      assigned_to TEXT DEFAULT NULL,
      assigned_row_number INT DEFAULT NULL,
      assigned_user_id INT DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE transaction_endings
    ADD COLUMN IF NOT EXISTS assigned_row_number INT DEFAULT NULL
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_events (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      meta_json JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by TEXT DEFAULT ''
    )
  `).catch(err => {
    console.error('crm_events init error:', err.message);
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS interview_crm_meta (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status_changed_at TIMESTAMPTZ,
      interview_completed_at TIMESTAMPTZ,
      UNIQUE (agency_id, row_number)
    )
  `).catch(err => {
    console.error('interview_crm_meta init error:', err.message);
  });

  await pool.query(`
    ALTER TABLE interviews
    ADD COLUMN IF NOT EXISTS interview_date TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS interview_time TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
  `).catch(() => {});
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

function isDbUnavailableError(err) {
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('econnreset') ||
    message.includes('connect econnrefused') ||
    message.includes('connection terminated') ||
    message.includes('timeout') ||
    message.includes('database') ||
    err?.code === '57P01' ||
    err?.code === '53300'
  );
}

function readEmergencyAuthConfig() {
  const enabledRaw = String(process.env.AUTH_FALLBACK_ENABLED || '').trim().toLowerCase();
  const enabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes';

  const email = normalizeEmail(process.env.AUTH_FALLBACK_EMAIL || '');
  const password = String(process.env.AUTH_FALLBACK_PASSWORD || '');

  if (!enabled || !email || !password) return null;

  const roleRaw = String(process.env.AUTH_FALLBACK_ROLE || 'owner').trim().toLowerCase();
  const allowedRoles = new Set(['owner', 'teamlead', 'hr', 'senior_operator']);
  const role = allowedRoles.has(roleRaw) ? roleRaw : 'owner';

  const agencyId = Number(process.env.AUTH_FALLBACK_AGENCY_ID || 1) || 1;
  const userId = Number(process.env.AUTH_FALLBACK_USER_ID || -1) || -1;

  return {
    email,
    password,
    role,
    agencyId,
    userId,
    fullName: String(process.env.AUTH_FALLBACK_NAME || 'Emergency Access').trim() || 'Emergency Access'
  };
}

function buildEmergencyAuthPayload(config) {
  return {
    id: config.userId,
    userId: config.userId,
    agency_id: config.agencyId,
    agencyId: config.agencyId,
    full_name: config.fullName,
    email: config.email,
    role: config.role,
    is_active: true,
    authMode: 'fallback'
  };
}

function signEmergencyToken(profile) {
  return jwt.sign(
    {
      id: profile.userId,
      agencyId: profile.agencyId,
      email: profile.email,
      role: profile.role,
      fullName: profile.full_name,
      authMode: 'fallback'
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

let cachedBypassAgency = {
  id: AUTH_BYPASS_AGENCY_ID > 0 ? AUTH_BYPASS_AGENCY_ID : 0,
  name: 'AllStars Emergency Bypass'
};

async function resolveBypassAgency() {
  if (cachedBypassAgency.id > 0) {
    return cachedBypassAgency;
  }

  try {
    const configured = Number(process.env.AUTH_BYPASS_AGENCY_ID || 0) || 0;
    if (configured > 0) {
      const exact = await query(
        `SELECT id, name
         FROM agencies
         WHERE id = $1
         LIMIT 1`,
        [configured]
      );

      if (exact.rows[0]) {
        cachedBypassAgency = {
          id: Number(exact.rows[0].id),
          name: String(exact.rows[0].name || 'AllStars Emergency Bypass')
        };
        return cachedBypassAgency;
      }
    }

    const first = await query(
      `SELECT id, name
       FROM agencies
       ORDER BY id ASC
       LIMIT 1`
    );

    if (first.rows[0]) {
      cachedBypassAgency = {
        id: Number(first.rows[0].id),
        name: String(first.rows[0].name || 'AllStars Emergency Bypass')
      };
      return cachedBypassAgency;
    }
  } catch (err) {
    console.warn('resolveBypassAgency fallback:', err.message);
  }

  return {
    id: AUTH_BYPASS_AGENCY_ID > 0 ? AUTH_BYPASS_AGENCY_ID : 1,
    name: 'AllStars Emergency Bypass'
  };
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    const queryToken = String(req.query?.token || '').trim();
    const token = bearerToken || queryToken;

    if (token && token === AUTH_BYPASS_TOKEN) {
      const bypassAgency = await resolveBypassAgency();

      req.user = {
        id: -2,
        userId: -2,
        agency_id: bypassAgency.id,
        agencyId: bypassAgency.id,
        full_name: 'Bypass Access',
        email: 'bypass@allstars.local',
        role: 'owner',
        is_active: true,
        agency_name: bypassAgency.name,
        authMode: 'bypass'
      };

      return next();
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded?.authMode === 'fallback') {
      const fallbackConfig = readEmergencyAuthConfig();
      if (!fallbackConfig) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      req.user = buildEmergencyAuthPayload({
        ...fallbackConfig,
        email: String(decoded.email || fallbackConfig.email),
        role: String(decoded.role || fallbackConfig.role),
        agencyId: Number(decoded.agencyId || fallbackConfig.agencyId) || fallbackConfig.agencyId,
        userId: Number(decoded.id || decoded.userId || fallbackConfig.userId) || fallbackConfig.userId,
        fullName: String(decoded.fullName || fallbackConfig.fullName)
      });

      return next();
    }

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
  } catch (err) {
    if (err && ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(err.name)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    console.error('Auth middleware error:', err?.message || err);
    return res.status(503).json({ error: 'Сервис авторизации временно недоступен' });
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

function candidateVerdict(candidateOrStatus, maybeStatus) {
  const status = typeof candidateOrStatus === 'object'
    ? String(candidateOrStatus?.status || '').trim()
    : String(maybeStatus || '').trim();

  if (isHiredCandidateStatus(status)) return 'hire';
  if (['Отказ', 'Уволен', 'Не рассчитан', 'Убрать', 'Не пришел на собес'].includes(status)) return 'reject';
  if (status) return 'review';
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
      JWT_SECRET,
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

    const isDbUnavailable = isDbUnavailableError(err);

    if (isDbUnavailable) {
      const fallbackConfig = readEmergencyAuthConfig();
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (fallbackConfig && email === fallbackConfig.email && password === fallbackConfig.password) {
        const profile = buildEmergencyAuthPayload(fallbackConfig);
        const token = signEmergencyToken(profile);

        console.warn('Emergency auth fallback login granted because database is unavailable');

        return res.json({
          token,
          mode: 'fallback',
          me: {
            id: profile.userId,
            email: profile.email,
            name: profile.full_name,
            role: profile.role,
            is_active: true
          },
          user: {
            id: profile.userId,
            agency_id: profile.agencyId,
            full_name: profile.full_name,
            email: profile.email,
            role: profile.role,
            is_active: true
          }
        });
      }

      return res.status(503).json({ error: 'База данных временно недоступна. Попробуйте через 1-2 минуты.' });
    }

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

    if (!['owner', 'teamlead', 'hr', 'senior_operator'].includes(role)) {
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

    broadcastRealtimeUpdate({ scope: 'users' });
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

    broadcastRealtimeUpdate({ scope: 'users' });
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

    broadcastRealtimeUpdate({ scope: 'users' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete user error:', err.message);
    res.status(500).json({ error: 'Не удалось удалить пользователя' });
  }
});

app.get('/auth/me', auth, async (req, res) => {
  if (req.user?.authMode === 'bypass') {
    return res.json({
      id: req.user.userId,
      agency_id: req.user.agencyId,
      full_name: req.user.full_name,
      email: req.user.email,
      role: req.user.role,
      agency_name: req.user.agency_name || 'AllStars Emergency Bypass'
    });
  }

  if (req.user?.authMode === 'fallback') {
    return res.json({
      id: req.user.userId,
      agency_id: req.user.agencyId,
      full_name: req.user.full_name,
      email: req.user.email,
      role: req.user.role,
      agency_name: 'Emergency mode'
    });
  }

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
    unified: UNIFIED_STATUS_OPTIONS,
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

    if (!['owner', 'teamlead', 'hr', 'senior_operator'].includes(role)) {
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

    if (!['owner', 'teamlead', 'hr', 'senior_operator'].includes(nextRole)) {
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
  if (verdict) rows = rows.filter(r => candidateVerdict(r) === verdict);

  res.json(rows);
});

app.post('/candidates', auth, async (req, res) => {
  console.log('POST /candidates BODY =', req.body);

  try {
    const body = req.body || {};
    const source =
      body && typeof body.fields === 'object' && !Array.isArray(body.fields)
        ? { ...body, ...body.fields }
        : body;

    const safe = (value) => {
      if (value === undefined || value === null) return '';
      if (Array.isArray(value)) return JSON.stringify(value);
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    };

    const ownerUserId =
      typeof body.ownerUserId === 'string' || typeof body.ownerUserId === 'number'
        ? String(body.ownerUserId)
        : String(req.user.userId);

    const candidate = {
      name: safe(source.name),
      tg: safe(source.tg || source.telegram || source.username),
      telegram: safe(source.telegram || source.tg || source.username),
      age: safe(source.age),

      english: safe(source.english || source.english_level),
      english_level: safe(source.english_level || source.english),

      exp: safe(source.exp || source.experience),
      experience: safe(source.experience || source.exp),

      platform: safe(source.platform || source.platforms),
      platforms: safe(source.platforms || source.platform),

      shift: safe(source.shift),

      schedule: safe(source.schedule || source.schedule_preference),
      schedule_preference: safe(source.schedule_preference || source.schedule),

      top_pages: safe(source.top_pages || source.top_profile || source.top),
      top_profile: safe(source.top_profile || source.top_pages || source.top),

      avg_check: safe(source.avg_check || source.avgcheck),

      job: safe(source.job || source.main_activity),
      main_activity: safe(source.main_activity || source.job),

      interview_report: safe(source.interview_report),
      status: normalizeCandidateStatus(source.status || 'Без статуса'),
      source: safe(source.source) || 'manual',
      lead_source: safe(source.lead_source || source.candidate_source),
      notes: safe(source.notes),

      ratings: body.ratings && typeof body.ratings === 'object' && !Array.isArray(body.ratings)
        ? JSON.stringify(body.ratings)
        : '{}',

      total: Number.isFinite(Number(body.total)) ? Number(body.total) : 0,
      owner_user_id: ownerUserId
    };

    const initialStatusDatePatch = candidate.status
      ? getStatusDatePatch(candidate.status, {})
      : {};

    console.log('POST /candidates NORMALIZED =', candidate);

    const result = await pool.query(
      `
      INSERT INTO candidates (
        agency_id,
        owner_user_id,
        created_by_user_id,
        updated_by_user_id,
        name,
        tg,
        telegram,
        age,
        english,
        english_level,
        exp,
        experience,
        platform,
        platforms,
        shift,
        schedule,
        schedule_preference,
        top_pages,
        top_profile,
        avg_check,
        job,
        main_activity,
        interview_report,
        status,
        source,
        lead_source,
        notes,
        status_changed_at,
        hired_at,
        rejected_at,
        started_at,
        fired_at,
        ratings,
        total
      )
      VALUES (
        $1,  $2,  $3,  $4,  $5,
        $6,  $7,  $8,  $9,  $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25,
        $26, $27, $28, $29, $30,
        $31, $32, $33, $34
      )
      RETURNING *
      `,
      [
        req.user.agencyId,
        candidate.owner_user_id,
        req.user.userId,
        req.user.userId,
        candidate.name,
        candidate.tg,
        candidate.telegram,
        candidate.age,
        candidate.english,
        candidate.english_level,
        candidate.exp,
        candidate.experience,
        candidate.platform,
        candidate.platforms,
        candidate.shift,
        candidate.schedule,
        candidate.schedule_preference,
        candidate.top_pages,
        candidate.top_profile,
        candidate.avg_check,
        candidate.job,
        candidate.main_activity,
        candidate.interview_report,
        candidate.status,
        candidate.source,
        candidate.lead_source,
        candidate.notes,
        initialStatusDatePatch.status_changed_at || null,
        initialStatusDatePatch.hired_at || null,
        initialStatusDatePatch.rejected_at || null,
        initialStatusDatePatch.started_at || null,
        initialStatusDatePatch.fired_at || null,
        candidate.ratings,
        candidate.total
      ]
    );

    const createdCandidate = result.rows[0];

    console.log('=== AFTER INSERT, BEFORE EVENT ===');

    try {
      await appendCrmEvent({
        entity_type: 'candidate',
        entity_id: String(createdCandidate.id),
        event_type: 'lead_created',
        agency_id: req.user?.agencyId,
        meta: {
          name: candidate.name,
          telegram: candidate.telegram || candidate.tg,
          platform: candidate.platform || candidate.platforms
        },
        created_by: req.user?.email || req.user?.full_name || ''
      });

      console.log('✅ EVENT WRITTEN SUCCESS');
    } catch (err) {
      console.error('❌ EVENT WRITE ERROR:', err);
    }

    if (candidate.status) {
      await query(
        `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
         VALUES ($1,$2,$3)`,
        [result.rows[0].id, candidate.status, req.user.userId]
      );
    }

    const ai = buildAiInsight(result.rows[0]);

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
      [result.rows[0].id, ai.recommendation, ai.confidence, ai.summary, JSON.stringify(ai.strengths), JSON.stringify(ai.risks)]
    );

    const created = createdCandidate;

    await logCrmEvent({
      entityType: 'candidate',
      entityId: created.id,
      eventType: 'lead_created',
      meta: {
        platform: candidate.platform,
        name: candidate.name,
        telegram: candidate.telegram
      },
      createdBy: req.user?.email || String(req.user?.userId || '')
    });

    invalidateTeamStatsCache();

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /candidates ERROR =', err);
    res.status(500).json({ error: err.message || 'Не удалось сохранить кандидата' });
  }
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
    telegram: fields.telegram ?? fields.tg ?? row.telegram ?? row.tg,
    age: fields.age ?? row.age,
    english: fields.english ?? row.english,
    english_level: fields.english_level ?? fields.english ?? row.english_level ?? row.english,
    exp: fields.exp ?? row.exp,
    experience: fields.experience ?? fields.exp ?? row.experience ?? row.exp,
    platform: fields.platform ?? fields.platforms ?? row.platform ?? row.platforms,
    platforms: fields.platforms ?? row.platforms,
    shift: fields.shift ?? row.shift,
    schedule: fields.schedule ?? row.schedule,
    schedule_preference: fields.schedule_preference ?? fields.schedule ?? row.schedule_preference ?? row.schedule,
    top_pages: fields.top ?? row.top_pages,
    top_profile: fields.top_profile ?? fields.top_pages ?? fields.top ?? row.top_profile ?? row.top_pages,
    avg_check: fields.avgcheck ?? row.avg_check,
    job: fields.job ?? row.job,
    main_activity: fields.main_activity ?? fields.job ?? row.main_activity ?? row.job,
    interview_report: fields.interview_report ?? row.interview_report,
    status: fields.status !== undefined ? normalizeCandidateStatus(fields.status) : row.status,
    source: fields.source ?? row.source,
    lead_source: fields.lead_source ?? fields.candidate_source ?? row.lead_source,
    notes: fields.notes ?? row.notes,
    ratings: ratings ?? row.ratings,
    total: total ?? row.total,
    owner_user_id: ownerUserId ?? row.owner_user_id
  };

  const statusDatePatch = next.status && next.status !== row.status
    ? getStatusDatePatch(next.status, row)
    : {};

  const updated = await query(
    `UPDATE candidates
     SET owner_user_id = $3,
         updated_by_user_id = $4,
         updated_at = NOW(),
         name = $5, tg = $6, telegram = $7, age = $8, english = $9, english_level = $10,
         exp = $11, experience = $12, platform = $13, platforms = $14, shift = $15,
         schedule = $16, schedule_preference = $17, top_pages = $18, top_profile = $19,
         avg_check = $20, job = $21, main_activity = $22, interview_report = $23,
         status = $24, source = $25, lead_source = $26, notes = $27, ratings = $28::jsonb, total = $29,
         status_changed_at = COALESCE($30, status_changed_at),
         hired_at = COALESCE($31, hired_at),
         rejected_at = COALESCE($32, rejected_at),
         started_at = COALESCE($33, started_at),
         fired_at = COALESCE($34, fired_at)
     WHERE id = $1 AND agency_id = $2
     RETURNING *`,
    [
      req.params.id,
      req.user.agencyId,
      next.owner_user_id,
      req.user.userId,
      next.name, next.tg, next.telegram, next.age, next.english, next.english_level,
      next.exp, next.experience, next.platform, next.platforms, next.shift,
      next.schedule, next.schedule_preference, next.top_pages, next.top_profile,
      next.avg_check, next.job, next.main_activity, next.interview_report,
      next.status, next.source, next.lead_source, next.notes, JSON.stringify(next.ratings), next.total,
      statusDatePatch.status_changed_at || null,
      statusDatePatch.hired_at || null,
      statusDatePatch.rejected_at || null,
      statusDatePatch.started_at || null,
      statusDatePatch.fired_at || null
    ]
  );

  const platformChanged = String(next.platform || '').trim() && String(next.platform || '').trim() !== String(row.platform || '').trim();
  const shiftChanged = String(next.shift || '').trim() && String(next.shift || '').trim() !== String(row.shift || '').trim();
  const englishChanged = String(next.english_level || next.english || '').trim() && String(next.english_level || next.english || '').trim() !== String(row.english_level || row.english || '').trim();

  if (platformChanged || shiftChanged || englishChanged) {
    try {
      await syncInterviewSheetPlatform({
        platform: next.platform,
        shift: next.shift,
        englishLevel: next.english_level || next.english,
        telegram: next.telegram || next.tg,
        name: next.name
      });
    } catch (syncErr) {
      console.error('syncInterviewSheetPlatform error:', syncErr.message);
    }
  }

  if (next.status && next.status !== row.status) {
    const candidateId = req.params.id;
    const prevStatus = row.status;
    const newStatus = next.status;
    const candidateName = next.name;
    const candidateTelegram = next.telegram || next.tg;
    const candidatePlatform = next.platform || next.platforms;

    await appendCrmEvent({
      entity_type: 'candidate',
      entity_id: String(candidateId || Date.now()),
      event_type: 'status_changed',
      agency_id: req.user?.agencyId,
      old_value: String(prevStatus || ''),
      new_value: String(newStatus || ''),
      meta: {
        name: candidateName || '',
        telegram: candidateTelegram || '',
        platform: candidatePlatform || ''
      },
      created_by: req.user?.email || req.user?.full_name || ''
    });

    await query(
      `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
       VALUES ($1,$2,$3)`,
      [req.params.id, next.status, req.user.userId]
    );

    await logCrmEvent({
      entityType: 'candidate',
      entityId: req.params.id,
      eventType: 'status_changed',
      oldValue: row.status,
      newValue: next.status,
      meta: {
        platform: next.platform || ''
      },
      createdBy: req.user?.email || String(req.user?.userId || '')
    });

    // Team sheet is kept as legacy base only; status workflows are CRM-only.

    await syncStatusAcrossSources({
      source: 'candidates',
      agencyId: req.user.agencyId,
      status: next.status,
      telegram: next.telegram || next.tg,
      name: next.name,
      updatedByUserId: req.user.userId
    });
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

  invalidateTeamStatsCache();
  broadcastRealtimeUpdate({ scope: 'candidates' });

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

  invalidateTeamStatsCache();

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
      COUNT(*) FILTER (WHERE status IN ('Принятый', 'Работает'))::int AS hired,
      COUNT(*) FILTER (WHERE status = 'Тест смена')::int AS trial,
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
      COUNT(c.id) FILTER (WHERE c.status IN ('Принятый', 'Работает'))::int AS hired,
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
    const sheetName = process.env.GOOGLE_SPREADSHEET_NAME || 'AllStarsLeads';

    const sheet = doc.sheetsByTitle[sheetName] || doc.sheetsByTitle['AllStarsLeads'];
    if (!sheet) {
      return res.status(500).json({ error: `Sheet tab not found: ${sheetName}` });
    }

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

    const range = `${sheetName}!A1:ZZ5000`;

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

    const sourceFallbackMap = await buildInterviewSourceFallbackMap(req.user.agencyId, normalized);
    const normalizedWithSource = normalized.map(item => applyInterviewSourceFallback(item, sourceFallbackMap));

    await ensureInterviewCrmMetaForCandidates(req.user.agencyId, normalizedWithSource);

    const metaMap = await getInterviewCrmMetaMap(
      req.user.agencyId,
      normalizedWithSource.map(item => item.row_number)
    );

    const interviewsWithMeta = normalizedWithSource.map(item => mergeInterviewCrmMeta(item, metaMap.get(Number(item.row_number))));
    const interviewsWithCrmStatus = await overlayStatusesFromCrm(
      req.user.agencyId,
      interviewsWithMeta,
      (item) => ({
        telegram: item.telegram || item.username || item.telegram_username || '',
        name: item.name || ''
      })
    );

    res.json(interviewsWithCrmStatus);
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
        range: `${sheetName}!A1:ZZ1`
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A${rowNumber}:ZZ${rowNumber}`
      })
    ]);

    const headers = headersRes.data.values?.[0] || [];
    const row = rowRes.data.values?.[0] || [];

    if (!row.length) {
      return res.status(404).json({ error: 'Row not found' });
    }

    const candidate = normalizeRow(headers, row, rowNumber);
    const sourceFallbackMap = await buildInterviewSourceFallbackMap(req.user.agencyId, [candidate]);
    const candidateWithSource = applyInterviewSourceFallback(candidate, sourceFallbackMap);

    await ensureInterviewCrmMeta(req.user.agencyId, rowNumber, candidateWithSource.created_at);
    const meta = await getInterviewCrmMeta(req.user.agencyId, rowNumber);
    const merged = mergeInterviewCrmMeta(candidateWithSource, meta);
    const [withCrmStatus] = await overlayStatusesFromCrm(
      req.user.agencyId,
      [merged],
      (item) => ({
        telegram: item.telegram || item.username || item.telegram_username || '',
        name: item.name || ''
      })
    );
    res.json(withCrmStatus || merged);
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
      range: `${sheetName}!A1:ZZ1`
    });

    const headers = headersRes.data.values?.[0] || [];
    const currentRowRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}:ZZ${rowNumber}`
    });
    const currentRow = currentRowRes.data.values?.[0] || [];
    const currentCandidate = normalizeRow(headers, currentRow, rowNumber);
    const currentMeta = await ensureInterviewCrmMeta(req.user.agencyId, rowNumber, currentCandidate.created_at);
    const prevInterviewStatus = normalizeInterviewStatus(currentCandidate.status || req.body?.status || '');

    // Helper to find column index by field names
    const findColumnIndex = (...names) => {
      for (const name of names) {
        const idx = headers.indexOf(name);
        if (idx >= 0) return idx + 1; // Column numbers are 1-indexed
      }

      const loweredHeaders = headers.map(h => String(h || '').trim().toLowerCase());
      const normalizedHeaderKeys = headers.map(h => normalizeHeaderMatchKey(h));
      for (const rawName of names) {
        const name = String(rawName || '').trim().toLowerCase();
        if (!name) continue;

        const nameKey = normalizeHeaderMatchKey(rawName);
        if (nameKey) {
          const idxExactNormalized = normalizedHeaderKeys.findIndex(headerKey => headerKey === nameKey);
          if (idxExactNormalized >= 0) return idxExactNormalized + 1;
        }

        const idx = loweredHeaders.findIndex(header =>
          Boolean(header) && (
            header.includes(name) ||
            (name.includes(header) && header.length >= 7)
          )
        );

        if (idx >= 0) return idx + 1;

        if (nameKey && nameKey.length >= 4) {
          const idxNormalized = normalizedHeaderKeys.findIndex(headerKey =>
            Boolean(headerKey) && (
              headerKey.includes(nameKey) ||
              (nameKey.includes(headerKey) && headerKey.length >= 7)
            )
          );

          if (idxNormalized >= 0) return idxNormalized + 1;
        }
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

    const updatesByRange = new Map();

    const addUpdate = (range, value) => {
      updatesByRange.set(range, {
        range,
        values: [[String(value || '').trim()]]
      });
    };

    // Map request body fields to sheet columns
    const sourceColumnIdx = findInterviewSourceColumnIndex(headers);
    const fieldMappings = [
      { field: 'name', names: ['Имя', 'Как вас зовут?'] },
      { field: 'telegram', names: ['TG Username', 'Username'] },
      { field: 'username', names: ['TG Username', 'Username'] },
      { field: 'age', names: ['Возраст'] },
      { field: 'platform', names: ['Платформа'] },
      {
        field: 'source',
        names: [
          'Источник',
          'Источник кандидата',
          'Источник кандидата / реферал',
          'Источник/реферал',
          'Откуда вы о нас узнали?',
          'Откуда вы о нас узнали',
          'Откуда узнали о нас',
          'Откуда пришел кандидат',
          'Откуда пришёл кандидат',
          'Источник (откуда пришел)'
        ]
      },
      { field: 'top_profile', names: ['Анкеты', 'С какими анкетами работал-а (топ, %)'] },
      { field: 'experience', names: ['Опыт', 'Опыт работы', 'Опыт работы (лет)', 'Опыт в adult', 'Опыт в adult (лет)'] },
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
        const colIdx = mapping.field === 'source' && sourceColumnIdx >= 0
          ? sourceColumnIdx + 1
          : findColumnIndex(...mapping.names);
        if (colIdx > 0) {
          const colLetter = columnToLetter(colIdx);
          let value = String(req.body[mapping.field] || '').trim();

          addUpdate(`${sheetName}!${colLetter}${rowNumber}`, value);
        }
      }
    }

    const nextRequestedStatus = req.body?.status !== undefined
      ? normalizeInterviewStatus(req.body.status)
      : prevInterviewStatus;
    const interviewTransitionedToCompleted =
      hasInterviewOccurredByStatus(nextRequestedStatus) &&
      !hasInterviewOccurredByStatus(prevInterviewStatus);

    const updates = [...updatesByRange.values()];

    if (!updates.length && req.body?.status === undefined) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (updates.length && SHEETS_WRITE_ENABLED) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });
    }

    // When only status is changed, we intentionally keep sheet data untouched.
    const updatedRow = updates.length && SHEETS_WRITE_ENABLED
      ? (await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A${rowNumber}:ZZ${rowNumber}`
      })).data.values?.[0] || []
      : currentRow;
    const candidate = normalizeRow(headers, updatedRow, rowNumber);
    const now = new Date();
    const nextMeta = await updateInterviewCrmMeta(
      req.user.agencyId,
      rowNumber,
      {
        status_changed_at:
          req.body?.status !== undefined && nextRequestedStatus !== prevInterviewStatus
            ? now
            : null,
        interview_completed_at: interviewTransitionedToCompleted ? now : null
      },
      currentMeta?.created_at || currentCandidate.created_at
    );
    const candidateWithMeta = mergeInterviewCrmMeta(candidate, nextMeta);

    if (interviewTransitionedToCompleted) {
      const interviewId = rowNumber;
      const createdCandidate = candidateWithMeta;

      await appendCrmEvent({
        entity_type: 'interview',
        entity_id: String(interviewId || createdCandidate.id || Date.now()),
        event_type: 'interview_completed',
        agency_id: req.user?.agencyId,
        meta: {
          name: candidateWithMeta.name,
          telegram: candidateWithMeta.telegram || candidateWithMeta.tg,
          platform: candidateWithMeta.platform || candidateWithMeta.platforms
        },
        created_by: req.user?.email || req.user?.full_name || ''
      });

      await logCrmEvent({
        entityType: 'interview',
        entityId: rowNumber,
        eventType: 'interview_completed',
        meta: {
          platform: candidateWithMeta.platform || req.body?.platform || '',
          name: candidateWithMeta.name || req.body?.name || '',
          telegram: candidateWithMeta.telegram || candidateWithMeta.username || req.body?.telegram || req.body?.username || ''
        },
        createdBy: req.user?.email || String(req.user?.userId || '')
      });
    }

    if (nextRequestedStatus && req.body?.status !== undefined) {
      await syncStatusAcrossSources({
        source: 'interviews',
        agencyId: req.user.agencyId,
        status: nextRequestedStatus,
        telegram: candidateWithMeta.telegram || candidateWithMeta.username || req.body?.telegram || req.body?.username || '',
        name: candidateWithMeta.name || req.body?.name || '',
        updatedByUserId: req.user.userId
      });
    }

    try {
      await syncCandidatesPlatformFromInterview({
        agencyId: req.user.agencyId,
        platform: candidateWithMeta.platform || req.body?.platform || '',
        shift: candidateWithMeta.shift || req.body?.shift || '',
        englishLevel: candidateWithMeta.english_level || req.body?.english_level || '',
        telegram: candidateWithMeta.telegram || candidateWithMeta.username || req.body?.telegram || req.body?.username || '',
        name: candidateWithMeta.name || req.body?.name || '',
        updatedByUserId: req.user.userId
      });
    } catch (syncErr) {
      console.error('syncCandidatesPlatformFromInterview error:', syncErr.message);
    }

    res.json(candidateWithMeta);
  } catch (err) {
    console.error('Interview update error:', err.message);
    res.status(500).json({ error: 'Failed to update interview' });
  }
});

app.get('/api/stats', auth, async (req, res) => {
  try {
    const spreadsheetId = DASHBOARD_STATS_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ error: 'DASHBOARD_STATS_SPREADSHEET_ID is missing' });
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

function getDashboardEventMeta(event) {
  if (event?.meta_json && typeof event.meta_json === 'object') {
    return event.meta_json;
  }

  if (event?.meta && typeof event.meta === 'object') {
    return event.meta;
  }

  return {};
}

function getDashboardEventAuthor(event) {
  const meta = getDashboardEventMeta(event);
  const createdBy = String(event?.created_by || meta.hr || meta.owner || '').trim();

  if (!createdBy || createdBy.toLowerCase() === 'backfill') {
    return '';
  }

  return createdBy;
}

function getDashboardEventAgencyId(event) {
  const directAgencyId = Number(event?.agency_id);
  if (Number.isInteger(directAgencyId) && directAgencyId > 0) {
    return directAgencyId;
  }

  const meta = getDashboardEventMeta(event);
  const metaAgencyId = Number(meta.agencyId || meta.agency_id);
  if (Number.isInteger(metaAgencyId) && metaAgencyId > 0) {
    return metaAgencyId;
  }

  return null;
}

function filterDashboardEventsByAgency(events, agencyId) {
  const normalizedAgencyId = Number(agencyId);
  if (!Number.isInteger(normalizedAgencyId) || normalizedAgencyId <= 0) {
    return [];
  }

  return events.filter(event => getDashboardEventAgencyId(event) === normalizedAgencyId);
}

function createDashboardPlatformStats() {
  return {
    leads: 0,
    test_shift: 0,
    hired: 0,
    started: 0
  };
}

function createDashboardPlatformBreakdown() {
  return {
    onlyfans: createDashboardPlatformStats(),
    fansly: createDashboardPlatformStats(),
    unknown: createDashboardPlatformStats()
  };
}

function getDashboardPlatformBuckets(value) {
  const platform = String(value || '').trim().toLowerCase();
  const hasOnlyFans = platform.includes('onlyfans') || platform.includes('only fans');
  const hasFansly = platform.includes('fansly');

  const buckets = [];

  if (hasOnlyFans) buckets.push('onlyfans');
  if (hasFansly) buckets.push('fansly');
  if (!buckets.length) buckets.push('unknown');

  return buckets;
}

function incrementDashboardPlatformMetric(platformBreakdown, platformValue, metric) {
  const buckets = getDashboardPlatformBuckets(platformValue);

  for (const bucket of buckets) {
    if (!platformBreakdown[bucket]) {
      platformBreakdown[bucket] = createDashboardPlatformStats();
    }

    platformBreakdown[bucket][metric] += 1;
  }
}

function buildDashboardWorkingSnapshot(teamMembers) {
  const snapshot = {
    onlyfans: 0,
    fansly: 0,
    unknown: 0,
    total: 0
  };

  for (const member of teamMembers) {
    if (String(member?.status || '').trim() !== 'Работает') {
      continue;
    }

    const buckets = getDashboardPlatformBuckets(member?.platform || '');
    for (const bucket of buckets) {
      snapshot[bucket] += 1;
    }
    snapshot.total += 1;
  }

  return snapshot;
}

function getDashboardLeadKey(event) {
  const meta = getDashboardEventMeta(event);
  const telegram = String(meta.telegram || meta.tg || meta.username || '').trim().toLowerCase().replace(/^@/, '');
  if (telegram) {
    return `tg:${telegram}`;
  }

  const name = String(meta.name || '').trim().toLowerCase();
  if (name) {
    return `name:${name}`;
  }

  return `${String(event.entity_type || '').trim()}:${String(event.entity_id || '').trim()}`;
}

function buildDashboardRangeStats(events, rangeStart, rangeEnd) {
  const summary = {
    leads: 0,
    interviews: 0,
    hired: 0,
    rejected: 0,
    fired: 0,
    started: 0,
    test_shift: 0,
    waiting_test: 0,
    unpaid: 0
  };

  const platforms = {
    onlyfans: 0,
    fansly: 0
  };
  const platformBreakdown = createDashboardPlatformBreakdown();

  const dailyMap = new Map();
  const hrMap = new Map();
  const countedLeadKeys = new Set();
  const countedHiredKeys = new Set();
  const countedRejectedKeys = new Set();
  const countedFiredKeys = new Set();
  const countedStartedKeys = new Set();
  const countedTestShiftKeys = new Set();
  const countedUnpaidKeys = new Set();

  for (let cursor = new Date(rangeStart); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
    const dateStr = formatDateOnly(cursor);
    dailyMap.set(dateStr, {
      date: dateStr,
      leads: 0,
      interviews: 0,
      hired: 0,
      rejected: 0,
      fired: 0,
      started: 0,
      test_shift: 0,
      unpaid: 0
    });
  }

  const bumpHr = (who, key) => {
    if (!who) return;

    if (!hrMap.has(who)) {
      hrMap.set(who, {
        name: who,
        leads: 0,
        interviews: 0,
        hired: 0,
        rejected: 0,
        fired: 0
      });
    }

    hrMap.get(who)[key] += 1;
  };

  for (const event of events) {
    const createdAt = new Date(event.created_at);
    if (Number.isNaN(createdAt.getTime()) || createdAt < rangeStart || createdAt > rangeEnd) {
      continue;
    }

    const meta = getDashboardEventMeta(event);
    const dateStr = formatDateOnly(createdAt);
    const dayRow = dailyMap.get(dateStr);
    const platform = String(meta.platform || '').toLowerCase();
    const createdBy = getDashboardEventAuthor(event);
    const nextStatus = normalizeStatusAlias(event.new_value);

    if (event.event_type === 'lead_created') {
      const leadKey = getDashboardLeadKey(event);
      if (!countedLeadKeys.has(leadKey)) {
        countedLeadKeys.add(leadKey);
        summary.leads += 1;
        if (dayRow) dayRow.leads += 1;
        bumpHr(createdBy, 'leads');
        incrementDashboardPlatformMetric(platformBreakdown, platform, 'leads');

        if (platform.includes('onlyfans')) platforms.onlyfans += 1;
        if (platform.includes('fansly')) platforms.fansly += 1;
      }

      continue;
    }

    if (event.event_type === 'interview_completed') {
      summary.interviews += 1;
      if (dayRow) dayRow.interviews += 1;
      bumpHr(createdBy, 'interviews');
      continue;
    }

    if (event.event_type !== 'status_changed') {
      continue;
    }

    const personKey = getDashboardLeadKey(event);

    if (nextStatus === REJECTED_CANDIDATE_STATUS) {
      if (!countedRejectedKeys.has(personKey)) {
        countedRejectedKeys.add(personKey);
        summary.rejected += 1;
        if (dayRow) dayRow.rejected += 1;
        bumpHr(createdBy, 'rejected');
      }
    }

    if (OFFBOARDED_CANDIDATE_STATUSES.has(nextStatus)) {
      if (!countedFiredKeys.has(personKey)) {
        countedFiredKeys.add(personKey);
        summary.fired += 1;
        if (dayRow) dayRow.fired += 1;
        bumpHr(createdBy, 'fired');
      }
    }

    if (isDashboardHiredStatus(nextStatus) || nextStatus === STARTED_CANDIDATE_STATUS) {
      if (!countedHiredKeys.has(personKey)) {
        countedHiredKeys.add(personKey);
        summary.hired += 1;
        incrementDashboardPlatformMetric(platformBreakdown, platform, 'hired');

        if (dayRow) {
          dayRow.hired += 1;
        }

        bumpHr(createdBy, 'hired');
      }
    }

    if (nextStatus === STARTED_CANDIDATE_STATUS) {
      if (!countedStartedKeys.has(personKey)) {
        countedStartedKeys.add(personKey);
        summary.started += 1;
        incrementDashboardPlatformMetric(platformBreakdown, platform, 'started');

        if (dayRow) {
          dayRow.started += 1;
        }
      }
    }

    if (isDashboardTrialStatus(nextStatus) || nextStatus === WAITING_TEST_CANDIDATE_STATUS) {
      if (!countedTestShiftKeys.has(personKey)) {
        countedTestShiftKeys.add(personKey);
        summary.test_shift += 1;
        incrementDashboardPlatformMetric(platformBreakdown, platform, 'test_shift');
        if (dayRow) dayRow.test_shift += 1;
      }
    }

    if (nextStatus === WAITING_TEST_CANDIDATE_STATUS) {
      summary.waiting_test += 1;
    }

    if (nextStatus === UNPAID_CANDIDATE_STATUS) {
      if (!countedUnpaidKeys.has(personKey)) {
        countedUnpaidKeys.add(personKey);
        summary.unpaid += 1;
        if (dayRow) dayRow.unpaid += 1;
      }
    }
  }

  const daily = [...dailyMap.values()];

  const conversion = {
    lead_to_interview:
      summary.leads > 0
        ? Math.round((summary.interviews / summary.leads) * 1000) / 10
        : 0,
    interview_to_hired:
      summary.interviews > 0
        ? Math.round((summary.hired / summary.interviews) * 1000) / 10
        : 0,
    hired_to_started:
      summary.hired > 0
        ? Math.round((summary.started / summary.hired) * 1000) / 10
        : 0
  };

  const topPeople = [...hrMap.values()]
    .sort((a, b) => {
      const scoreA = a.hired * 5 + a.interviews * 2 + a.leads;
      const scoreB = b.hired * 5 + b.interviews * 2 + b.leads;
      return scoreB - scoreA;
    })
    .slice(0, 5);

  return {
    summary,
    platforms,
    platform_breakdown: platformBreakdown,
    daily,
    conversion,
    top_people: topPeople
  };
}

function collectDashboardOffboardedEvents(events, rangeStart, rangeEnd) {
  const matches = [];

  for (const event of events) {
    const createdAt = new Date(event.created_at);
    if (Number.isNaN(createdAt.getTime()) || createdAt < rangeStart || createdAt > rangeEnd) {
      continue;
    }

    if (event.event_type !== 'status_changed') {
      continue;
    }

    const nextStatus = String(event.new_value || '').trim();
    if (!OFFBOARDED_CANDIDATE_STATUSES.has(nextStatus)) {
      continue;
    }

    const meta = getDashboardEventMeta(event);

    matches.push({
      created_at: event.created_at,
      date: formatDateOnly(createdAt),
      entity_type: String(event.entity_type || ''),
      entity_id: String(event.entity_id || ''),
      status: nextStatus,
      name: String(meta.name || '').trim(),
      telegram: String(meta.telegram || '').trim(),
      platform: String(meta.platform || '').trim(),
      author: getDashboardEventAuthor(event),
      approximate: !!meta.approximate,
      source: event.meta_json ? 'db' : 'file/backfill'
    });
  }

  matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    total: matches.length,
    fired: matches.filter(item => item.status === FIRED_CANDIDATE_STATUS).length,
    unpaid: matches.filter(item => item.status === UNPAID_CANDIDATE_STATUS).length,
    items: matches
  };
}

async function buildDashboardStatsPayload({ week = 'current', period = 'week', mode = undefined, date_from, date_to }) {
  let fromDate;
  let toDate;
  let previousFrom;
  let previousTo;
  let normalizedPeriod = 'week';
  let normalizedMode = 'current';

  if (date_from && date_to) {
    fromDate = parseDateOnly(date_from);
    toDate = parseDateOnly(date_to);

    if (!fromDate || !toDate) {
      throw new Error('INVALID_DATE_RANGE');
    }

    fromDate.setHours(0, 0, 0, 0);
    toDate.setHours(23, 59, 59, 999);

    previousFrom = new Date(fromDate);
    previousFrom.setDate(previousFrom.getDate() - 7);
    previousFrom.setHours(0, 0, 0, 0);

    previousTo = new Date(toDate);
    previousTo.setDate(previousTo.getDate() - 7);
    previousTo.setHours(23, 59, 59, 999);
  } else {
    const resolved = resolveDashboardPeriodRange({
      period,
      mode: mode || week
    });

    normalizedPeriod = resolved.period;
    normalizedMode = resolved.mode;
    fromDate = resolved.fromDate;
    toDate = resolved.toDate;
    previousFrom = resolved.previousFrom;
    previousTo = resolved.previousTo;
  }

  const [currentRes, previousRes] = await Promise.all([
    pool.query(
      `
      SELECT
        id,
        entity_type,
        entity_id,
        event_type,
        old_value,
        new_value,
        meta_json,
        created_at,
        created_by
      FROM crm_events
      WHERE created_at >= $1
        AND created_at <= $2
      ORDER BY created_at ASC
      `,
      [fromDate.toISOString(), toDate.toISOString()]
    ),
    pool.query(
      `
      SELECT
        id,
        entity_type,
        entity_id,
        event_type,
        old_value,
        new_value,
        meta_json,
        created_at,
        created_by
      FROM crm_events
      WHERE created_at >= $1
        AND created_at <= $2
      ORDER BY created_at ASC
      `,
      [previousFrom.toISOString(), previousTo.toISOString()]
    )
  ]);

  const currentEvents = currentRes.rows || [];
  const previousEvents = previousRes.rows || [];

  const current = buildDashboardRangeStats(currentEvents, fromDate, toDate);
  const previous = buildDashboardRangeStats(previousEvents, previousFrom, previousTo);

  const trendValue = (curr, prev) => {
    const diff = curr - prev;
    const diff_percent =
      prev > 0 ? Math.round((diff / prev) * 1000) / 10 : (curr > 0 ? 100 : 0);

    return {
      current: curr,
      previous: prev,
      diff,
      diff_percent
    };
  };

  const trends = {
    leads: trendValue(current.summary.leads, previous.summary.leads),
    interviews: trendValue(current.summary.interviews, previous.summary.interviews),
    hired: trendValue(current.summary.hired, previous.summary.hired),
    rejected: trendValue(current.summary.rejected, previous.summary.rejected),
    fired: trendValue(current.summary.fired, previous.summary.fired),
    started: trendValue(current.summary.started, previous.summary.started),
    unpaid: trendValue(current.summary.unpaid, previous.summary.unpaid)
  };

  return {
    range: {
      date_from: formatDateOnly(fromDate),
      date_to: formatDateOnly(toDate),
      week: normalizedMode,
      period: normalizedPeriod,
      mode: normalizedMode
    },
    previous_range: {
      date_from: formatDateOnly(previousFrom),
      date_to: formatDateOnly(previousTo)
    },
    summary: current.summary,
    platforms: current.platforms,
    daily: current.daily,
    conversion: current.conversion,
    top_people: current.top_people,
    trends
  };
}

app.get('/api/dashboard/stats', auth, async (req, res) => {
  try {
    const payload = await buildDashboardStatsPayload(req.query || {});
    res.json(payload);
  } catch (err) {
    if (err.message === 'INVALID_DATE_RANGE') {
      return res.status(400).json({ error: 'Некорректный date_from/date_to' });
    }

    console.error('GET /api/dashboard/stats error:', err);
    res.status(500).json({ error: 'Не удалось загрузить dashboard статистику' });
  }
});

app.get('/api/dashboard/stats-live', auth, async (req, res) => {
  try {
    const resolved = resolveDashboardPeriodRange({
      period: req.query?.period,
      mode: req.query?.mode || req.query?.week
    });
    const fromDate = resolved.fromDate;
    const toDate = resolved.toDate;
    const prevFrom = resolved.previousFrom;
    const prevTo = resolved.previousTo;

    const existingEvents = await readCrmEvents();
    const liveEvents = LIVE_BACKFILL_DISABLED
      ? []
      : await collectBackfillEvents({
          agencyId: req.user.agencyId,
          fromDate: prevFrom,
          toDate
        });
    const { filteredNew, merged } = mergeCrmEvents(existingEvents, liveEvents);

    if (filteredNew.length) {
      await writeCrmEvents(merged);
    }

    const allEvents = filterDashboardEventsByAgency(merged, req.user.agencyId);
    const teamMembers = LIVE_BACKFILL_DISABLED ? [] : await loadAllTeamMembersForBackfill();
    const workingSnapshot = buildDashboardWorkingSnapshot(teamMembers);

    const current = buildDashboardRangeStats(allEvents, fromDate, toDate);
    const previous = buildDashboardRangeStats(allEvents, prevFrom, prevTo);

    const trend = (curr, prev) => ({
      current: curr,
      previous: prev,
      diff: curr - prev,
      diff_percent: prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : (curr > 0 ? 100 : 0)
    });

    res.json({
      range: {
        date_from: formatDateOnly(fromDate),
        date_to: formatDateOnly(toDate),
        week: resolved.mode,
        period: resolved.period,
        mode: resolved.mode
      },
      previous_range: {
        date_from: formatDateOnly(prevFrom),
        date_to: formatDateOnly(prevTo)
      },
      summary: current.summary,
      daily: current.daily,
      platforms: current.platforms,
      platform_breakdown: current.platform_breakdown,
      working_snapshot: workingSnapshot,
      conversion: current.conversion,
      top_people: current.top_people,
      trends: {
        leads: trend(current.summary.leads, previous.summary.leads),
        interviews: trend(current.summary.interviews, previous.summary.interviews),
        hired: trend(current.summary.hired, previous.summary.hired),
        rejected: trend(current.summary.rejected, previous.summary.rejected),
        fired: trend(current.summary.fired, previous.summary.fired),
        started: trend(current.summary.started, previous.summary.started),
        unpaid: trend(current.summary.unpaid, previous.summary.unpaid)
      }
    });
  } catch (err) {
    console.error('GET /api/dashboard/stats-live error:', err);
    try {
      const empty = resolveDashboardPeriodRange({
        period: req.query?.period,
        mode: req.query?.mode || req.query?.week
      });

      return res.json({
        range: {
          date_from: formatDateOnly(empty.fromDate),
          date_to: formatDateOnly(empty.toDate),
          week: empty.mode,
          period: empty.period,
          mode: empty.mode
        },
        previous_range: {
          date_from: formatDateOnly(empty.previousFrom),
          date_to: formatDateOnly(empty.previousTo)
        },
        summary: { leads: 0, interviews: 0, hired: 0, rejected: 0, fired: 0, started: 0, unpaid: 0 },
        daily: [],
        platforms: [],
        platform_breakdown: [],
        working_snapshot: buildDashboardWorkingSnapshot([]),
        conversion: { interview_rate: 0, hire_rate: 0, reject_rate: 0 },
        top_people: [],
        trends: {
          leads: { current: 0, previous: 0, diff: 0, diff_percent: 0 },
          interviews: { current: 0, previous: 0, diff: 0, diff_percent: 0 },
          hired: { current: 0, previous: 0, diff: 0, diff_percent: 0 },
          rejected: { current: 0, previous: 0, diff: 0, diff_percent: 0 },
          fired: { current: 0, previous: 0, diff: 0, diff_percent: 0 },
          started: { current: 0, previous: 0, diff: 0, diff_percent: 0 },
          unpaid: { current: 0, previous: 0, diff: 0, diff_percent: 0 }
        }
      });
    } catch (fallbackErr) {
      console.error('GET /api/dashboard/stats-live fallback error:', fallbackErr);
      res.status(500).json({ error: 'Не удалось загрузить live dashboard статистику' });
    }
  }
});

app.post('/api/dashboard/backfill-last-2-weeks', auth, async (req, res) => {
  try {
    const now = new Date();
    const currentWeekStart = startOfWeek(now);
    const previousWeekStart = new Date(currentWeekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);

    const fromDate = previousWeekStart;
    const toDate = endOfWeek(now);

    const existingEvents = await readCrmEvents();
    const newEvents = await collectBackfillEvents({
      agencyId: req.user.agencyId,
      fromDate,
      toDate
    });
    const { filteredNew, merged } = mergeCrmEvents(existingEvents, newEvents);

    await writeCrmEvents(merged);

    res.json({
      ok: true,
      added: filteredNew.length,
      total: merged.length,
      range: {
        from: formatDateOnly(fromDate),
        to: formatDateOnly(toDate)
      }
    });
  } catch (err) {
    console.error('backfill-last-2-weeks error:', err);
    res.status(500).json({ error: err.message || 'Backfill failed' });
  }
});

let teamStatsCache = {
  data: null,
  ts: 0
};

const TEAM_STATS_CACHE_TTL = 60 * 1000;

// SSE clients for real-time page refresh notifications.
const realtimeSseClients = new Set();

function writeSseEvent(res, eventName, payload = {}) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastRealtimeUpdate(payload = {}) {
  const message = {
    ts: Date.now(),
    ...payload
  };

  for (const client of realtimeSseClients) {
    try {
      writeSseEvent(client, 'update', message);
    } catch (_) { /* client disconnected */ }
  }
}

function attachRealtimeSseClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  writeSseEvent(res, 'connected', { ts: Date.now() });

  realtimeSseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    realtimeSseClients.delete(res);
  });
}

function invalidateTeamStatsCache() {
  teamStatsCache = { data: null, ts: 0 };
  broadcastRealtimeUpdate({ scope: 'team-stats' });
}

function buildTeamItemFromCandidate(candidate) {
  const status = normalizeStatusAlias(candidate.status || '') || String(candidate.status || '').trim();
  const createdAtRaw = candidate.created_at || null;
  const startedAtRaw = candidate.started_at || candidate.hired_at || null;
  const meta = candidate.team_card_meta && typeof candidate.team_card_meta === 'object' && !Array.isArray(candidate.team_card_meta)
    ? candidate.team_card_meta
    : {};
  const model = String(
    meta['Модели (основные)']
    || meta['Актуальная модель']
    || candidate.top_profile
    || candidate.top_pages
    || ''
  ).trim();

  let workDays = '';
  if (startedAtRaw) {
    const startedAt = new Date(startedAtRaw);
    if (!Number.isNaN(startedAt.getTime())) {
      const days = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / (24 * 60 * 60 * 1000)));
      workDays = String(days);
    }
  }

  return {
    row_number: Number(candidate.id),
    raw: {
      ...meta,
      'Дата первого касания': createdAtRaw ? String(createdAtRaw) : String(meta['Дата первого касания'] || meta['Дата'] || '').trim(),
      'Дата': createdAtRaw ? String(createdAtRaw) : String(meta['Дата'] || '').trim(),
      'created_at': createdAtRaw ? String(createdAtRaw) : String(meta['created_at'] || '').trim(),
      'Имя': candidate.name || '',
      'Telegram': candidate.telegram || candidate.tg || '',
      'Telegram / username': candidate.telegram || candidate.tg || '',
      'Актуальный статус кандидата (Hr)': status,
      'OnlyFans / Fansly': candidate.platform || candidate.platforms || '',
      'Модели (основные)': model,
      'Опыт, мес.': candidate.exp || candidate.experience || '',
      'Срок работы, дни': workDays,
      'Дата старта': startedAtRaw ? String(startedAtRaw) : '',
      'От кого': candidate.main_activity || candidate.job || String(meta['От кого'] || '').trim(),
      'Transaction ending': String(meta['Transaction ending'] || '').trim()
    },
    name: candidate.name || '',
    telegram: candidate.telegram || candidate.tg || '',
    status,
    platform: candidate.platform || candidate.platforms || '',
    model,
    first_contact_date: createdAtRaw ? String(createdAtRaw) : '',
    created_at: createdAtRaw ? String(createdAtRaw) : '',
    experience_months: candidate.exp || candidate.experience || '',
    work_days: workDays,
    start_date: startedAtRaw ? String(startedAtRaw) : '',
    transactionEnding: ''
  };
}

async function loadTeamItemsFromCandidatesDb(agencyId) {
  // CRM is the single source of truth for statuses.
  // Sheet data supplements with extra fields (model, experience, work_days, etc.).
  // This guarantees any candidate with a visible status in CRM always appears here.

  const [teamRowsResult, candidateResult, transactionEndingResult] = await Promise.allSettled([
    loadAllTeamMembersForBackfill(),
    query(
      `SELECT id, name, tg, telegram, status, platform, platforms, top_pages, top_profile, main_activity, exp, experience, started_at, hired_at, created_at, updated_at, team_card_meta
       FROM candidates
       WHERE agency_id = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC`,
      [agencyId]
    ),
    pool.query(
      `SELECT assigned_row_number, ending
       FROM transaction_endings
       WHERE assigned_row_number IS NOT NULL`
    )
  ]);

  const teamRows = teamRowsResult.status === 'fulfilled'
    ? (teamRowsResult.value || [])
    : [];

  const crmCandidates = candidateResult.status === 'fulfilled'
    ? (candidateResult.value?.rows || [])
    : [];

  const transactionEndingRows = transactionEndingResult.status === 'fulfilled'
    ? (transactionEndingResult.value?.rows || [])
    : [];

  if (candidateResult.status === 'rejected') {
    console.warn('loadTeamItemsFromCandidatesDb: candidates query failed, using sheet-only fallback:', candidateResult.reason?.message || candidateResult.reason);
  }

  const transactionEndingByRow = new Map(
    transactionEndingRows.map(row => [
      Number(row.assigned_row_number),
      String(row.ending || '').trim()
    ])
  );

  // Build sheet lookup by identity for fast supplemental data access
  const sheetItemsRaw = (teamRows || []).map((row) => {
    const status = normalizeStatusAlias(row.status || '') || String(row.status || '').trim();
    const model = String(row?.raw?.['Модели (основные)'] || row?.raw?.['Актуальная модель'] || '').trim();
    return {
      row_number: Number(row.row_number),
      source: 'sheet',
      raw: row.raw || {},
      name: row.name || '',
      telegram: row.telegram || '',
      status,
      platform: row.platform || '',
      model,
      experience_months: String(row?.raw?.['Опыт, мес.'] || row?.raw?.['Опыт'] || '').trim(),
      work_days: String(row?.raw?.['Срок работы, дни'] || '').trim(),
      start_date: row.date_start || '',
      transactionEnding: String(row?.raw?.['Transaction ending'] || transactionEndingByRow.get(Number(row.row_number)) || '').trim()
    };
  });

  const normTgKey = (v) => normalizeTelegramKey(v || '');
  const normNameKey = (v) => normalizePersonKey(v || '');

  // Identity dedup key: prefer telegram, fall back to name
  const primaryKey = (telegram, name) => {
    const tg = normTgKey(telegram);
    if (tg) return `tg:${tg}`;
    const nm = normNameKey(name);
    return nm ? `name:${nm}` : null;
  };

  // Build sheet maps keyed by telegram (primary) and name (fallback with uniqueness checks)
  const sheetByTg = new Map();
  const sheetByName = new Map();
  const sheetByNameAll = new Map();
  for (const s of sheetItemsRaw) {
    const nm = normNameKey(s.name);
    if (nm) {
      const bucket = sheetByNameAll.get(nm) || [];
      bucket.push(s);
      sheetByNameAll.set(nm, bucket);
    }

    const tg = normTgKey(s.telegram);
    if (tg) {
      if (!sheetByTg.has(tg)) sheetByTg.set(tg, s);
    } else {
      if (nm && !sheetByName.has(nm)) sheetByName.set(nm, s);
    }
  }

  function findSheetRow(telegram, name) {
    const tg = normTgKey(telegram);
    const nm = normNameKey(name);

    // If CRM has telegram, only allow exact telegram match.
    // Fallback by name is allowed only to sheet rows without telegram.
    if (tg) {
      if (sheetByTg.has(tg)) return sheetByTg.get(tg);
      if (nm && sheetByName.has(nm)) return sheetByName.get(nm);
      return null;
    }

    // No telegram in CRM: name fallback is allowed only when unambiguous.
    if (nm) {
      const matches = sheetByNameAll.get(nm) || [];
      if (matches.length === 1) return matches[0];
      if (sheetByName.has(nm)) return sheetByName.get(nm);
    }
    return null;
  }

  // Step 1: CRM-first — every CRM candidate with a visible status is authoritative
  const seen = new Set();
  const result = [];

  for (const candidate of crmCandidates) {
    const status = normalizeStatusAlias(candidate.status || '') || String(candidate.status || '').trim();
    if (!isVisibleTeamDashboardStatus(status)) continue;

    const tg = candidate.telegram || candidate.tg || '';
    const name = candidate.name || '';
    const pk = primaryKey(tg, name);

    // Dedup identical CRM records (same person entered twice in candidates table)
    if (pk && seen.has(pk)) continue;
    if (pk) seen.add(pk);

    // Supplement with sheet data if available
    const sheetRow = findSheetRow(tg, name);
    const base = buildTeamItemFromCandidate(candidate);

    result.push({
      ...base,
      row_number: sheetRow ? sheetRow.row_number : -Number(candidate.id),
      candidate_id: Number(candidate.id),
      source: sheetRow ? 'sheet' : 'crm',
      status, // CRM status always wins
      model: base.model || sheetRow?.model || '',
      experience_months: base.experience_months || sheetRow?.experience_months || '',
      work_days: base.work_days || sheetRow?.work_days || '',
      start_date: base.start_date || sheetRow?.start_date || '',
      transactionEnding: base.transactionEnding || sheetRow?.transactionEnding || transactionEndingByRow.get(sheetRow ? Number(sheetRow.row_number) : -Number(candidate.id)) || '',
      raw: sheetRow ? { ...sheetRow.raw, ...base.raw } : base.raw
    });
  }

  // Step 2: Add sheet-only rows (legacy entries not yet in CRM) that have visible statuses
  for (const s of sheetItemsRaw) {
    if (!isVisibleTeamDashboardStatus(s.status)) continue;
    const pk = primaryKey(s.telegram, s.name);
    if (pk && seen.has(pk)) continue; // already covered by CRM
    if (pk) seen.add(pk);
    result.push(s);
  }

  return result;
}

app.get('/api/team-stats', auth, async (req, res) => {
  try {
    if (teamStatsCache.data && Date.now() - teamStatsCache.ts < TEAM_STATS_CACHE_TTL) {
      return res.json(teamStatsCache.data);
    }

    let items = [];
    try {
      items = await loadTeamItemsFromCandidatesDb(req.user.agencyId);
    } catch (err) {
      console.warn('loadTeamItemsFromCandidatesDb fallback:', err.message);
      items = [];
    }

    const toNumber = (value) => {
      const n = Number(String(value || '').replace(',', '.').trim());
      return Number.isFinite(n) ? n : 0;
    };

    const totals = {
      total: items.length,
      active: items.filter(x => String(x.status || '').trim() === 'Работает').length,
      onlyfans: items.filter(x => String(x.platform || '').toLowerCase().includes('onlyfans')).length,
      fansly: items.filter(x => String(x.platform || '').toLowerCase().includes('fansly')).length,
      unpaid: items.filter(x => String(x.status || '').trim() === 'Не рассчитан').length
    };

    const expValues = items.map(x => toNumber(x.experience_months)).filter(x => x > 0);
    const workDayValues = items.map(x => toNumber(x.work_days)).filter(x => x > 0);

    const avg = (arr) => {
      if (!arr.length) return 0;
      return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
    };

    const averages = {
      experience_months: avg(expValues),
      work_days: avg(workDayValues)
    };

    const payload = {
      totals: {
        ...totals
      },
      averages,
      items
    };

    teamStatsCache = {
      data: payload,
      ts: Date.now()
    };

    res.json(payload);
  } catch (err) {
    console.error('Team stats error:', err);
    if (teamStatsCache.data) {
      return res.json(teamStatsCache.data);
    }

    return res.json({
      totals: { total: 0, active: 0, onlyfans: 0, fansly: 0, unpaid: 0 },
      averages: { experience_months: 0, work_days: 0 },
      items: [],
      data_source: 'fallback'
    });
  }
});

app.get('/api/team-status-members', auth, async (req, res) => {
  try {
    const requestedStatus = normalizeStatusAlias(req.query.status);

    if (!requestedStatus) {
      return res.status(400).json({ error: 'status query is required' });
    }

    const members = (await loadTeamItemsFromCandidatesDb(req.user.agencyId))
      .filter(person => String(person.status).trim() === requestedStatus)
      .map(person => ({
        row_number: person.row_number,
        source: person.source || 'sheet',
        status: person.status,
        name: person.name,
        telegram: person.telegram,
        platform: person.platform,
        start_date: person.start_date,
        work_days: person.work_days
      }));

    res.json(members);
  } catch (err) {
    console.error('Team status members read error:', err.message);
    res.status(500).json({ error: 'Failed to read team status members' });
  }
});

app.get('/api/team-all-members', auth, async (req, res) => {
  try {
    const members = await loadTeamItemsFromCandidatesDb(req.user.agencyId);
    res.json(members);
  } catch (err) {
    console.error('Team all members read error:', err.message);
    res.status(500).json({ error: 'Failed to read team members' });
  }
});

app.get('/api/team-transaction-endings', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM transaction_endings ORDER BY ending ASC
    `);

    const rows = result.rows || [];
    const used = rows.filter(x => String(x.assigned_to || '').trim());
    const free = rows.filter(x => !String(x.assigned_to || '').trim());

    res.json({
      used,
      free,
      used_count: used.length,
      free_count: free.length
    });
  } catch (err) {
    console.error('Team transaction endings read error:', err.message);
    res.status(500).json({ error: 'Failed to read transaction endings' });
  }
});

app.get('/api/team-transaction-endings/board', auth, async (req, res) => {
  try {
    const members = await loadTeamItemsFromCandidatesDb(req.user.agencyId);
    const assignableMembers = members.filter(item => Number.isInteger(Number(item.row_number)) && Number(item.row_number) !== 0);

    await ensureTransactionEndingsInitialized();

    const endingsRes = await pool.query(`
      SELECT ending, assigned_to, assigned_row_number
      FROM transaction_endings
      ORDER BY ending ASC
    `);

    const slots = [];
    let usedCount = 0;

    for (const row of endingsRes.rows || []) {
      const ending = Number(row.ending);
      const assignedTo = String(row.assigned_to || '').trim();
      const assignedRowNumberRaw = row.assigned_row_number;
      const parsedAssignedRowNumber = Number(assignedRowNumberRaw);
      const hasAssignedRowNumber = Number.isInteger(parsedAssignedRowNumber) && parsedAssignedRowNumber !== 0;
      let assigned = null;

      if (hasAssignedRowNumber) {
        const matchedMember = assignableMembers.find(m => Number(m.row_number) === parsedAssignedRowNumber);

        // Slot is occupied only when assignment resolves to a real member on the active page.
        if (!matchedMember) {
          slots.push({ ending, assigned: null });
          continue;
        }

        const displayName = String(matchedMember.name || '').trim() || assignedTo;
        assigned = {
          ending,
          name: displayName,
          transaction_ending: String(ending),
          row_number: matchedMember ? Number(matchedMember.row_number) : (hasAssignedRowNumber ? parsedAssignedRowNumber : null),
          telegram: matchedMember ? String(matchedMember.telegram || '').trim() : '',
          status: matchedMember ? String(matchedMember.status || '').trim() : '',
          platform: matchedMember ? String(matchedMember.platform || '').trim() : '',
          source: matchedMember ? String(matchedMember.source || '').trim() : 'db'
        };
        usedCount += 1;
      }

      slots.push({
        ending,
        assigned
      });
    }

    res.json({
      slots,
      used_count: usedCount,
      free_count: 99 - usedCount,
      duplicates: [],
      assignable_members: assignableMembers.map(item => ({
        row_number: Number(item.row_number),
        name: String(item.name || '').trim(),
        telegram: String(item.telegram || '').trim(),
        status: String(item.status || '').trim(),
        transaction_ending: String(item.transactionEnding || '').trim(),
        platform: String(item.platform || '').trim()
      }))
    });
  } catch (err) {
    console.error('Team transaction ending board error:', err.message);
    res.status(500).json({ error: 'Failed to read transaction ending board' });
  }
});

app.patch('/api/team-transaction-endings/assign', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const rowNumber = Number(req.body?.row_number);
    const ending = Number(req.body?.ending);
    const telegramRaw = String(req.body?.telegram || '').trim();
    const hasEnding = Number.isInteger(ending) && ending >= 1 && ending <= 99;
    const hasTelegram = Boolean(telegramRaw);

    if (!Number.isInteger(rowNumber) || rowNumber === 0) {
      return res.status(400).json({ error: 'Некорректный row_number' });
    }

    if (!hasEnding && !hasTelegram) {
      return res.status(400).json({ error: 'Передай ending (1..99) или telegram' });
    }

    if (rowNumber < 0) {
      const members = await loadTeamItemsFromCandidatesDb(req.user.agencyId);
      const targetMember = (members || []).find(item => Number(item.row_number) === rowNumber);
      if (!targetMember || !String(targetMember.name || '').trim()) {
        return res.status(404).json({ error: 'Сотрудник не найден в CRM' });
      }

      const targetName = String(targetMember.name || '').trim();
      const targetTelegram = String(targetMember.telegram || '').trim();

      if (hasEnding) {
        await ensureTransactionEndingsInitialized();

        await pool.query(
          `UPDATE transaction_endings
           SET assigned_to = NULL,
               assigned_row_number = NULL,
               assigned_user_id = NULL,
               updated_at = NOW()
           WHERE assigned_row_number = $1
              OR lower(trim(coalesce(assigned_to, ''))) = lower(trim($2))`,
          [rowNumber, targetName]
        );

        const occupied = await pool.query(
          `SELECT assigned_row_number
           FROM transaction_endings
           WHERE ending = $1
           LIMIT 1`,
          [ending]
        );
        const occupiedRow = Number(occupied.rows?.[0]?.assigned_row_number || 0);
        if (occupiedRow && occupiedRow !== rowNumber) {
          return res.status(400).json({ error: 'Этот ending уже занят' });
        }

        await pool.query(
          `UPDATE transaction_endings
           SET assigned_to = $1,
               assigned_row_number = $2,
               assigned_user_id = $3,
               updated_at = NOW()
           WHERE ending = $4`,
          [targetName, rowNumber, Number(targetMember.candidate_id) || null, ending]
        );
      }

      if (hasTelegram) {
        const normalizedTelegram = normalizeTelegramForTeam(telegramRaw);
        await query(
          `UPDATE candidates
           SET tg = $3,
               telegram = $4,
               updated_by_user_id = $5,
               updated_at = NOW()
           WHERE id = $1 AND agency_id = $2`,
          [Math.abs(rowNumber), req.user.agencyId, normalizedTelegram, normalizedTelegram, req.user.userId]
        );
      }

      invalidateTeamStatsCache();
      broadcastRealtimeUpdate({ scope: 'transaction-endings' });

      return res.json({
        ok: true,
        row_number: rowNumber,
        ending: hasEnding ? ending : null,
        telegram: hasTelegram ? normalizeTelegramForTeam(telegramRaw) : targetTelegram
      });
    }

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    const sheets = await getSheetsClient();
    const [headersRes, rowsRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:AU1`
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A2:AU5000`
      })
    ]);

    const headers = headersRes.data.values?.[0] || [];
    const rows = rowsRes.data.values || [];
    const tgIdx = findHeaderIndex(headers, ['Телеграм', 'Telegram', 'TG Username', 'Username'], ['телеграм', 'telegram', 'username']);
    const txIdx = findHeaderIndex(headers, ['Transaction ending', 'Transaction Ending'], ['transaction ending', 'transaction']);
    let targetExists = false;
    let targetName = '';
    let targetTelegram = '';
    const nameIdx = headers.findIndex(h => String(h || '').trim() === 'Имя');

    for (let i = 0; i < rows.length; i++) {
      const absoluteRow = i + 2;
      const row = rows[i] || [];

      if (absoluteRow === rowNumber) {
        targetExists = true;
        if (nameIdx >= 0) {
          targetName = String(row[nameIdx] || '').trim();
        }
        if (tgIdx >= 0) {
          targetTelegram = String(row[tgIdx] || '').trim();
        }
        break;
      }
    }

    if (!targetExists) {
      return res.status(404).json({ error: 'Сотрудник не найден в таблице Действующие' });
    }

    if (hasEnding) {
      await ensureTransactionEndingsInitialized();
      await pool.query(
        `UPDATE transaction_endings
         SET assigned_to = NULL,
             assigned_row_number = NULL,
             assigned_user_id = NULL,
             updated_at = NOW()
         WHERE assigned_row_number = $1
            OR lower(trim(coalesce(assigned_to, ''))) = lower(trim($2))`,
        [rowNumber, targetName]
      );

      await pool.query(
        `UPDATE transaction_endings
         SET assigned_to = $1,
             assigned_row_number = $2,
             assigned_user_id = $3,
             updated_at = NOW()
         WHERE ending = $4`,
        [targetName, rowNumber, Number(req.user?.userId) || null, ending]
      );

      if (txIdx === -1) {
        return res.status(400).json({ error: 'Колонка Transaction ending не найдена в Действующие' });
      }

      if (SHEETS_WRITE_ENABLED) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!${columnToLetter(txIdx + 1)}${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[String(ending)]]
          }
        });
      }
    }

    if (hasTelegram) {
      if (tgIdx === -1) {
        return res.status(400).json({ error: 'Колонка Telegram не найдена в Действующие' });
      }

      const normalizedTelegram = normalizeTelegramForTeam(telegramRaw);
      if (normalizedTelegram !== targetTelegram && SHEETS_WRITE_ENABLED) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!${columnToLetter(tgIdx + 1)}${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[normalizedTelegram]]
          }
        });
      }
    }

    invalidateTeamStatsCache();
    broadcastRealtimeUpdate({ scope: 'transaction-endings' });
    res.json({
      ok: true,
      row_number: rowNumber,
      ending: hasEnding ? ending : null,
      telegram: hasTelegram ? normalizeTelegramForTeam(telegramRaw) : targetTelegram
    });
  } catch (err) {
    console.error('Transaction ending assign error:', err.message);
    res.status(500).json({ error: 'Не удалось назначить ending' });
  }
});

app.post('/api/team-transaction-endings/import-sexter', auth, async (req, res) => {
  try {
    if (!SHEETS_WRITE_ENABLED) {
      return res.status(409).json({
        error: 'CRM -> Sheets sync disabled. Import to sheet is blocked.'
      });
    }

    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    const sexterMap = await readSexterEndingMap();
    const used = Array.isArray(sexterMap?.used) ? sexterMap.used : [];

    if (!used.length) {
      return res.json({ ok: true, imported: 0, not_found: [] });
    }

    const sheets = await getSheetsClient();
    const [headersRes, rowsRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:AU1`
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A2:AU5000`
      })
    ]);

    const headers = headersRes.data.values?.[0] || [];
    const rows = rowsRes.data.values || [];

    const txIdx = headers.findIndex(h => String(h || '').trim() === 'Transaction ending');
    const nameIdx = findHeaderIndex(headers, ['Имя'], ['имя']);

    if (txIdx === -1) {
      return res.status(400).json({ error: 'Колонка Transaction ending не найдена' });
    }

    if (nameIdx === -1) {
      return res.status(400).json({ error: 'Колонка Имя не найдена' });
    }

    const txCol = columnToLetter(txIdx + 1);
    const indexedRows = rows.map((row, idx) => ({
      row_number: idx + 2,
      name: String(row?.[nameIdx] || '').trim()
    }));

    const updates = [];
    const notFound = [];

    for (const item of used) {
      const target = indexedRows.find(row => namesLooselyMatch(item.name, row.name));

      if (!target) {
        notFound.push({
          name: item.name,
          ending: item.ending
        });
        continue;
      }

      updates.push({
        range: `${sheetName}!${txCol}${target.row_number}`,
        values: [[String(item.ending)]]
      });
    }

    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });
    }

    invalidateTeamStatsCache();

    res.json({
      ok: true,
      imported: updates.length,
      not_found: notFound
    });
  } catch (err) {
    console.error('Transaction ending import sexter error:', err.message);
    res.status(500).json({ error: 'Не удалось импортировать ending из таблицы' });
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

app.post('/api/init-endings', async (req, res) => {
  try {
    for (let i = 1; i <= 99; i++) {
      await pool.query(`
        INSERT INTO transaction_endings (ending)
        VALUES ($1)
        ON CONFLICT (ending) DO NOTHING
      `, [i]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Init endings error:', err.message);
    res.status(500).json({ error: 'Failed to initialize endings' });
  }
});

app.get('/api/endings', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM transaction_endings ORDER BY ending ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Endings read error:', err.message);
    res.status(500).json({ error: 'Failed to read endings' });
  }
});

app.post('/api/endings/assign', auth, async (req, res) => {
  try {
    const { ending, user_id, name } = req.body || {};

    const check = await pool.query(`
      SELECT * FROM transaction_endings WHERE ending = $1
    `, [ending]);

    if (!check.rows.length) {
      return res.status(404).json({ error: 'Ending not found' });
    }

    if (check.rows[0].assigned_to) {
      return res.status(400).json({ error: 'Ending already taken' });
    }

    await pool.query(`
      UPDATE transaction_endings
      SET assigned_to = $1,
          assigned_user_id = $2,
          updated_at = NOW()
      WHERE ending = $3
    `, [String(name || '').trim(), Number(user_id) || null, ending]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Ending assign error:', err.message);
    res.status(500).json({ error: 'Failed to assign ending' });
  }
});

app.post('/api/endings/free', auth, async (req, res) => {
  try {
    const { ending } = req.body || {};

    await pool.query(`
      UPDATE transaction_endings
      SET assigned_to = NULL,
          assigned_user_id = NULL,
          updated_at = NOW()
      WHERE ending = $1
    `, [ending]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Ending free error:', err.message);
    res.status(500).json({ error: 'Failed to free ending' });
  }
});

app.patch('/api/team-transaction-endings/clear', auth, async (req, res) => {
  try {
    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';
    const rowNumber = Number(req.body?.row_number);
    const ending = Number(req.body?.ending);

    const rowProvided = Number.isInteger(rowNumber) && rowNumber >= 2;
    const endingProvided = Number.isInteger(ending) && ending >= 1 && ending <= 99;

    if (!rowProvided && !endingProvided) {
      return res.status(400).json({ error: 'Передай row_number >= 2 или ending от 1 до 99' });
    }

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
    }

    const sheets = await getSheetsClient();
    const headersRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:AU1`
    });
    const headers = headersRes.data.values?.[0] || [];
    const txIdx = findHeaderIndex(headers, ['Transaction ending', 'Transaction Ending'], ['transaction ending', 'transaction']);

    if (txIdx === -1) {
      return res.status(400).json({ error: 'Колонка Transaction ending не найдена в Действующие' });
    }

    const txCol = columnToLetter(txIdx + 1);

    await ensureTransactionEndingsInitialized();

    if (rowProvided) {
      const members = await loadTeamItemsFromCandidatesDb(req.user.agencyId);
      const targetMember = (members || []).find(item => Number(item.row_number) === rowNumber);

      if (!targetMember || !String(targetMember.name || '').trim()) {
        return res.status(404).json({ error: 'Сотрудник не найден в Действующие' });
      }

      await pool.query(
        `UPDATE transaction_endings
         SET assigned_to = NULL,
             assigned_row_number = NULL,
             assigned_user_id = NULL,
             updated_at = NOW()
         WHERE assigned_row_number = $1
            OR lower(trim(coalesce(assigned_to, ''))) = lower(trim($2))`,
        [rowNumber, String(targetMember.name || '').trim()]
      );

      if (SHEETS_WRITE_ENABLED) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!${txCol}${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [['']]
          }
        });
      }

      invalidateTeamStatsCache();
      broadcastRealtimeUpdate({ scope: 'transaction-endings' });
      return res.json({ ok: true, row_number: rowNumber });
    }

    const assignedRowRes = await pool.query(
      `SELECT assigned_row_number
       FROM transaction_endings
       WHERE ending = $1
       LIMIT 1`,
      [ending]
    );

    const assignedRowNumber = Number(assignedRowRes.rows?.[0]?.assigned_row_number || 0);

    await pool.query(
      `UPDATE transaction_endings
       SET assigned_to = NULL,
           assigned_row_number = NULL,
           assigned_user_id = NULL,
           updated_at = NOW()
       WHERE ending = $1`,
      [ending]
    );

    if (assignedRowNumber >= 2 && SHEETS_WRITE_ENABLED) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${txCol}${assignedRowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['']]
        }
      });
    }

    invalidateTeamStatsCache();
    broadcastRealtimeUpdate({ scope: 'transaction-endings' });
    res.json({ ok: true, ending });
  } catch (err) {
    console.error('Transaction ending clear error:', err.message);
    res.status(500).json({ error: 'Не удалось очистить ending' });
  }
});

app.get('/api/team-member/:rowNumber', auth, async (req, res) => {
  try {
    const rowNumber = Number(req.params.rowNumber);
    if (!Number.isFinite(rowNumber) || rowNumber === 0 || (rowNumber > 0 && rowNumber < 2)) {
      return res.status(400).json({ error: 'Некорректный row number' });
    }

    if (rowNumber < 0) {
      const candidateId = Math.abs(rowNumber);
      const existing = await query(
        'SELECT * FROM candidates WHERE id = $1 AND agency_id = $2 LIMIT 1',
        [candidateId, req.user.agencyId]
      );

      const row = existing.rows[0];
      if (!row) {
        return res.status(404).json({ error: 'Кандидат не найден в CRM' });
      }

      const status = normalizeStatusAlias(row.status || '') || String(row.status || '').trim();
      const meta = row.team_card_meta && typeof row.team_card_meta === 'object' && !Array.isArray(row.team_card_meta)
        ? row.team_card_meta
        : {};
      const assignedEndingRes = await pool.query(
        `SELECT ending
         FROM transaction_endings
         WHERE assigned_row_number = $1
         LIMIT 1`,
        [rowNumber]
      );
      const assignedEnding = Number(assignedEndingRes.rows?.[0]?.ending || 0);
      const assignedEndingValue = Number.isInteger(assignedEnding) && assignedEnding >= 1 && assignedEnding <= 99
        ? String(assignedEnding)
        : '';

      const mappedValues = new Map();
      const setMapped = (value, aliases = []) => {
        const text = String(value || '').trim();
        if (!text) return;

        for (const alias of aliases) {
          const key = normalizeHeaderMatchKey(alias);
          if (!key) continue;
          mappedValues.set(key, text);
        }
      };

      setMapped(row.name, ['Имя', 'Имя / ник', 'Ник']);
      setMapped(row.telegram || row.tg || '', ['Telegram', 'Telegram / username', 'Телеграм', 'ТГ', 'Username']);
      setMapped(status, ['Актуальный статус кандидата (Hr)', 'Статус']);
      setMapped(row.platform || row.platforms || '', ['OnlyFans / Fansly', 'Платформа']);
      setMapped(row.exp || row.experience || '', ['Опыт, мес.', 'Опыт']);
      setMapped(row.top_profile || row.top_pages || '', ['Модели (основные)', 'Актуальная модель']);
      setMapped(row.shift || row.schedule || row.schedule_preference || '', ['Смены (основные)', 'Смены']);
      setMapped(row.notes, ['Комментарий', 'Комментарий HR', 'Пометки']);
      setMapped(row.main_activity || row.job || '', ['От кого']);
      setMapped(assignedEndingValue, ['Transaction ending', 'Transaction Ending']);

      const metaByKey = new Map();
      for (const [label, value] of Object.entries(meta)) {
        const key = normalizeHeaderMatchKey(label);
        const text = String(value || '').trim();
        if (!key || !text) continue;
        if (!metaByKey.has(key)) {
          metaByKey.set(key, text);
        }
      }

      let fields = [
        { label: 'Имя', value: String(row.name || '').trim() },
        { label: 'Telegram', value: String(row.telegram || row.tg || '').trim() },
        { label: 'Актуальный статус кандидата (Hr)', value: status },
        { label: 'OnlyFans / Fansly', value: String(row.platform || row.platforms || '').trim() },
        { label: 'Опыт, мес.', value: String(row.exp || row.experience || '').trim() },
        { label: 'Модели (основные)', value: String(row.top_profile || row.top_pages || '').trim() },
        { label: 'Комментарий', value: String(row.notes || '').trim() }
      ];

      const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
      const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

      if (spreadsheetId) {
        try {
          const sheets = await getSheetsClient();
          const headersRes = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A1:AU1`
          });
          const headers = headersRes.data.values?.[0] || [];

          if (headers.length) {
            fields = headers
              .map((header) => {
                const label = String(header || '').trim();
                if (!label) return null;

                const key = normalizeHeaderMatchKey(label);
                const directMeta = String(meta[label] || '').trim();
                const isIdentityField = [
                  'имя',
                  'имя ник',
                  'ник',
                  'telegram',
                  'telegram username',
                  'телеграм',
                  'тг',
                  'username',
                  'актуальный статус кандидата hr',
                  'статус',
                  'onlyfans fansly',
                  'платформа',
                  'опыт мес',
                  'опыт'
                ].includes(key);

                const value = isIdentityField
                  ? (mappedValues.get(key) || directMeta || metaByKey.get(key) || '')
                  : (directMeta || metaByKey.get(key) || mappedValues.get(key) || '');

                return {
                  label,
                  value
                };
              })
              .filter(Boolean);
          }
        } catch (err) {
          console.warn('CRM card headers fallback:', err.message || err);
        }
      }

      return res.json({
        row_number: rowNumber,
        source: 'crm',
        candidate_id: candidateId,
        fields
      });
    }

    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
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

    if (!headers.length || !row.length) {
      return res.status(404).json({ error: 'Кандидат не найден в таблице' });
    }

    const fields = headers
      .map((header, idx) => ({
        label: String(header || '').trim(),
        value: String(row[idx] || '').trim()
      }))
      .filter(field => field.label);

    const statusIdx = findHeaderIndex(headers, ['Актуальный статус кандидата (Hr)', 'Статус'], ['статус кандидата', 'актуальный статус', 'status']);
    const tgIdx = findHeaderIndex(headers, ['Телеграм', 'Telegram', 'ТГ', 'Telegram / username', 'TG Username', 'Username'], ['телеграм', 'telegram', 'username']);
    const nameIdx = findHeaderIndex(headers, ['Имя', 'Имя / ник', 'Ник'], ['имя', 'ник']);

    if (statusIdx >= 0) {
      const rowTelegram = tgIdx >= 0 ? String(row[tgIdx] || '').trim() : '';
      const rowName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
      const candidates = await loadAgencyCandidatesForStatusOverlay(req.user.agencyId);
      const matched = findCandidateByIdentity(candidates, {
        telegram: rowTelegram,
        name: rowName
      });

      if (matched?.status) {
        const crmStatus = normalizeStatusAlias(matched.status || '') || String(matched.status || '').trim();
        if (crmStatus) {
          const statusLabel = String(headers[statusIdx] || '').trim();
          for (const field of fields) {
            if (String(field.label || '').trim() === statusLabel) {
              field.value = crmStatus;
              break;
            }
          }
        }
      }
    }

    res.json({ row_number: rowNumber, fields });
  } catch (err) {
    console.error('GET /api/team-member/:rowNumber error:', err);
    res.status(500).json({ error: 'Не удалось загрузить карточку сотрудника' });
  }
});

app.patch('/api/team-member/:rowNumber', auth, async (req, res) => {
  try {
    const rowNumber = Number(req.params.rowNumber);
    const updates = req.body?.updates || {};

    if (!Number.isInteger(rowNumber) || rowNumber === 0) {
      return res.status(400).json({ error: 'Invalid row number' });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'updates object is required' });
    }

    const pickUpdateValue = (src, keys) => {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(src, key)) {
          return src[key];
        }
      }
      return undefined;
    };

    // CRM-backed rows are exposed in team dashboard as negative row numbers: -candidate_id.
    if (rowNumber < 0) {
      const candidateId = Math.abs(rowNumber);
      const normalizeLabel = (label) => normalizeHeaderMatchKey(label);
      const coreFieldKeys = new Set([
        'имя',
        'имя ник',
        'ник',
        'telegram',
        'telegram username',
        'телеграм',
        'тг',
        'username',
        'актуальный статус кандидата hr',
        'статус',
        'status',
        'onlyfans fansly',
        'платформа',
        'platform',
        'platforms',
        'опыт мес',
        'опыт',
        'exp',
        'experience',
        'модели основные',
        'актуальная модель',
        'model',
        'top profile',
        'top pages',
        'transaction ending',
        'от кого',
        'main activity',
        'job',
        'комментарий',
        'комментарии',
        'comment',
        'notes'
      ]);

      const rawNextName = pickUpdateValue(updates, ['Имя', 'name']);
      const rawNextTelegram = pickUpdateValue(updates, ['Telegram', 'telegram', 'tg', 'Telegram / username']);
      const rawNextStatus = pickUpdateValue(updates, ['Актуальный статус кандидата (Hr)', 'Статус', 'status']);
      const rawNextPlatform = pickUpdateValue(updates, ['OnlyFans / Fansly', 'Платформа', 'platform', 'platforms']);
      const rawNextExp = pickUpdateValue(updates, ['Опыт, мес.', 'Опыт', 'exp', 'experience']);
      const rawNextModel = pickUpdateValue(updates, ['Модели (основные)', 'Актуальная модель', 'model', 'top_profile', 'top_pages']);
      const rawNextTransactionEnding = pickUpdateValue(updates, ['Transaction ending', 'Transaction Ending', 'transaction ending']);
      const rawNextFromWho = pickUpdateValue(updates, ['От кого', 'main_activity', 'job']);
      const rawNextNotes = pickUpdateValue(updates, ['Комментарий', 'Комментарии', 'notes', 'comment']);

      const hasAnyEditableField = Object.keys(updates)
        .some(label => String(label || '').trim());

      if (!hasAnyEditableField) {
        return res.status(400).json({ error: 'Нет поддерживаемых полей для обновления CRM-карточки' });
      }

      const existing = await query(
        'SELECT * FROM candidates WHERE id = $1 AND agency_id = $2 LIMIT 1',
        [candidateId, req.user.agencyId]
      );

      const row = existing.rows[0];
      if (!row) {
        return res.status(404).json({ error: 'Кандидат не найден в CRM' });
      }

      const prevStatus = String(row.status || '').trim();

      let nextStatus = prevStatus;
      if (rawNextStatus !== undefined) {
        const normalized = normalizeCandidateStatus(String(rawNextStatus || '').trim());
        if (!normalized) {
          return res.status(400).json({ error: 'Некорректный статус' });
        }
        nextStatus = normalized;
      }

      const nextName = rawNextName !== undefined ? String(rawNextName || '').trim() : String(row.name || '').trim();
      const nextTelegram = rawNextTelegram !== undefined
        ? String(rawNextTelegram || '').trim()
        : String(row.telegram || row.tg || '').trim();
      const nextPlatform = rawNextPlatform !== undefined
        ? String(rawNextPlatform || '').trim()
        : String(row.platform || row.platforms || '').trim();
      const nextExp = rawNextExp !== undefined
        ? String(rawNextExp || '').trim()
        : String(row.exp || row.experience || '').trim();
      const nextModel = rawNextModel !== undefined
        ? String(rawNextModel || '').trim()
        : String(row.top_profile || row.top_pages || '').trim();
      const nextFromWho = rawNextFromWho !== undefined
        ? String(rawNextFromWho || '').trim()
        : String(row.main_activity || row.job || '').trim();
      const nextNotes = rawNextNotes !== undefined
        ? String(rawNextNotes || '').trim()
        : String(row.notes || '').trim();
      const nextTransactionEndingRaw = rawNextTransactionEnding !== undefined
        ? String(rawNextTransactionEnding || '').trim()
        : undefined;

      if (nextTransactionEndingRaw !== undefined && nextTransactionEndingRaw !== '') {
        const endingNumber = Number(nextTransactionEndingRaw);
        if (!Number.isInteger(endingNumber) || endingNumber < 1 || endingNumber > 99) {
          return res.status(400).json({ error: 'Transaction ending должен быть числом от 1 до 99' });
        }
      }

      const currentMeta = row.team_card_meta && typeof row.team_card_meta === 'object' && !Array.isArray(row.team_card_meta)
        ? { ...row.team_card_meta }
        : {};
      const nextMeta = { ...currentMeta };

      for (const [label, value] of Object.entries(updates || {})) {
        const labelText = String(label || '').trim();
        const labelKey = normalizeLabel(labelText);
        if (!labelText || !labelKey || coreFieldKeys.has(labelKey)) continue;

        const textValue = String(value ?? '').trim();
        if (!textValue) {
          if (Object.prototype.hasOwnProperty.call(nextMeta, labelText)) {
            delete nextMeta[labelText];
          }

          for (const existingKey of Object.keys(nextMeta)) {
            if (normalizeLabel(existingKey) === labelKey) {
              delete nextMeta[existingKey];
            }
          }
          continue;
        }

        for (const existingKey of Object.keys(nextMeta)) {
          if (normalizeLabel(existingKey) === labelKey && existingKey !== labelText) {
            delete nextMeta[existingKey];
          }
        }

        nextMeta[labelText] = textValue;
      }

      if (nextTransactionEndingRaw !== undefined) {
        const txMetaLabel = 'Transaction ending';
        const txKey = normalizeLabel(txMetaLabel);

        if (!nextTransactionEndingRaw) {
          for (const existingKey of Object.keys(nextMeta)) {
            if (normalizeLabel(existingKey) === txKey) {
              delete nextMeta[existingKey];
            }
          }
        } else {
          for (const existingKey of Object.keys(nextMeta)) {
            if (normalizeLabel(existingKey) === txKey && existingKey !== txMetaLabel) {
              delete nextMeta[existingKey];
            }
          }
          nextMeta[txMetaLabel] = nextTransactionEndingRaw;
        }
      }

      const statusDatePatch = nextStatus !== prevStatus
        ? getStatusDatePatch(nextStatus, row)
        : {};

      const updated = await query(
        `UPDATE candidates
         SET updated_by_user_id = $3,
             updated_at = NOW(),
             name = $4,
             tg = $5,
             telegram = $6,
             platform = $7,
             platforms = $8,
             exp = $9,
             experience = $10,
             top_profile = $11,
             top_pages = $12,
             main_activity = $13,
             job = $14,
             notes = $15,
             team_card_meta = $16::jsonb,
             status = $17,
             status_changed_at = COALESCE($18, status_changed_at),
             hired_at = COALESCE($19, hired_at),
             rejected_at = COALESCE($20, rejected_at),
             started_at = COALESCE($21, started_at),
             fired_at = COALESCE($22, fired_at)
         WHERE id = $1 AND agency_id = $2
         RETURNING *`,
        [
          candidateId,
          req.user.agencyId,
          req.user.userId,
          nextName,
          nextTelegram,
          nextTelegram,
          nextPlatform,
          nextPlatform,
          nextExp,
          nextExp,
          nextModel,
          nextModel,
          nextFromWho,
          nextFromWho,
          nextNotes,
          JSON.stringify(nextMeta || {}),
          nextStatus,
          statusDatePatch.status_changed_at || null,
          statusDatePatch.hired_at || null,
          statusDatePatch.rejected_at || null,
          statusDatePatch.started_at || null,
          statusDatePatch.fired_at || null
        ]
      );

      if (nextTransactionEndingRaw !== undefined) {
        await ensureTransactionEndingsInitialized();

        await pool.query(
          `UPDATE transaction_endings
           SET assigned_to = NULL,
               assigned_row_number = NULL,
               assigned_user_id = NULL,
               updated_at = NOW()
           WHERE assigned_row_number = $1
              OR lower(trim(coalesce(assigned_to, ''))) = lower(trim($2))`,
          [rowNumber, String(nextName || row.name || '').trim()]
        );

        if (nextTransactionEndingRaw) {
          const endingNumber = Number(nextTransactionEndingRaw);
          const occupied = await pool.query(
            `SELECT assigned_row_number
             FROM transaction_endings
             WHERE ending = $1
             LIMIT 1`,
            [endingNumber]
          );
          const occupiedRow = Number(occupied.rows?.[0]?.assigned_row_number || 0);
          if (occupiedRow && occupiedRow !== rowNumber) {
            return res.status(400).json({ error: 'Этот ending уже занят' });
          }

          await pool.query(
            `UPDATE transaction_endings
             SET assigned_to = $1,
                 assigned_row_number = $2,
                 assigned_user_id = $3,
                 updated_at = NOW()
             WHERE ending = $4`,
            [String(nextName || row.name || '').trim(), rowNumber, candidateId, endingNumber]
          );
        }
      }

      if (nextStatus !== prevStatus) {
        await query(
          `INSERT INTO candidate_status_history(candidate_id, status, changed_by_user_id)
           VALUES ($1,$2,$3)`,
          [candidateId, nextStatus, req.user.userId]
        );

        await appendCrmEvent({
          entity_type: 'candidate',
          entity_id: String(candidateId),
          event_type: 'status_changed',
          agency_id: req.user?.agencyId,
          old_value: prevStatus,
          new_value: nextStatus,
          meta: {
            name: updated.rows[0]?.name || row.name || '',
            telegram: updated.rows[0]?.telegram || updated.rows[0]?.tg || row.telegram || row.tg || '',
            platform: updated.rows[0]?.platform || updated.rows[0]?.platforms || row.platform || row.platforms || ''
          },
          created_by: req.user?.email || req.user?.full_name || ''
        });

        await logCrmEvent({
          entityType: 'candidate',
          entityId: candidateId,
          eventType: 'status_changed',
          oldValue: prevStatus,
          newValue: nextStatus,
          meta: {
            platform: updated.rows[0]?.platform || updated.rows[0]?.platforms || ''
          },
          createdBy: req.user?.email || String(req.user?.userId || '')
        });

        await syncStatusAcrossSources({
          source: 'candidates',
          agencyId: req.user.agencyId,
          status: nextStatus,
          telegram: updated.rows[0]?.telegram || updated.rows[0]?.tg || row.telegram || row.tg || '',
          name: updated.rows[0]?.name || row.name || '',
          updatedByUserId: req.user.userId
        });
      }

      invalidateTeamStatsCache();
      return res.json({ ok: true, row_number: rowNumber, source: 'crm', candidate_id: candidateId });
    }

    const spreadsheetId = process.env.TEAM_SPREADSHEET_ID;
    const sheetName = process.env.TEAM_SHEET_NAME || 'Действующие';

    if (!SHEETS_WRITE_ENABLED) {
      return res.status(409).json({
        error: 'CRM -> Sheets sync disabled. Редактирование строк таблицы заблокировано, обновляйте CRM-карточки.'
      });
    }

    if (!spreadsheetId) {
      return res.status(500).json({ error: 'TEAM_SPREADSHEET_ID is missing' });
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

    if (!headers.length || !row.length) {
      return res.status(404).json({ error: 'Кандидат не найден в таблице' });
    }

    const normalizedHeaders = headers.map(h => normalizeHeaderMatchKey(h));
    const nextRow = [...row];

    const findInRowByAliases = (rowValues, ...aliases) => {
      for (const alias of aliases) {
        const key = normalizeHeaderMatchKey(alias);
        const idx = normalizedHeaders.findIndex(h => h === key || h.includes(key) || key.includes(h));
        if (idx >= 0) return String(rowValues[idx] || '').trim();
      }
      return '';
    };

    const prevStatus = findInRowByAliases(row, 'Актуальный статус кандидата (Hr)', 'Статус');

    for (const [label, value] of Object.entries(updates)) {
      const key = normalizeHeaderMatchKey(label);
      if (!key) continue;

      let idx = normalizedHeaders.findIndex(h => h === key);
      if (idx < 0) {
        idx = normalizedHeaders.findIndex(h => h.includes(key) || key.includes(h));
      }
      if (idx < 0) continue;

      nextRow[idx] = String(value ?? '').trim();
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}:AU${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [nextRow]
      }
    });

    const findByAliases = (...aliases) => findInRowByAliases(nextRow, ...aliases);

    let nextStatusRaw = prevStatus;
    let fallbackStatusRaw = '';
    for (const [label, value] of Object.entries(updates)) {
      const key = normalizeHeaderMatchKey(label);
      if (!key || !key.includes('статус')) continue;

      const normalizedValue = String(value || '').trim();

      // Prefer canonical team status column over any legacy "Статус" fields.
      if (
        key.includes('актуальный') ||
        key.includes('кандидата') ||
        key.includes('candidate')
      ) {
        nextStatusRaw = normalizedValue;
        fallbackStatusRaw = '';
        break;
      }

      if (!fallbackStatusRaw) {
        fallbackStatusRaw = normalizedValue;
      }
    }

    if (fallbackStatusRaw && nextStatusRaw === prevStatus) {
      nextStatusRaw = fallbackStatusRaw;
    }
    const nextStatus = normalizeCandidateStatus(nextStatusRaw) || nextStatusRaw;

    if (nextStatus) {
      await syncStatusAcrossSources({
        source: 'team',
        agencyId: req.user.agencyId,
        status: nextStatus,
        telegram: findByAliases('Телеграм', 'Telegram', 'ТГ', 'Telegram / username', 'TG Username', 'Username'),
        name: findByAliases('Имя', 'Имя / ник', 'Ник'),
        updatedByUserId: req.user.userId
      });
    }

    invalidateTeamStatsCache();
    res.json({ ok: true, row_number: rowNumber });
  } catch (err) {
    console.error('Team member update error:', err.message);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

app.post('/api/team-member', auth, async (req, res) => {
  try {
    const values = req.body?.values || {};

    const name = String(values['Имя'] || '').trim();
    const telegram = String(values['Telegram'] || values['ТГ'] || '').trim();
    const status = normalizeCandidateStatus(values['Актуальный статус кандидата (Hr)'] || 'Изучает гайд');
    const platform = String(values['OnlyFans / Fansly'] || '').trim();
    const exp = String(values['Опыт, мес.'] || '').trim();
    const shift = String(values['Смены (основные)'] || '').trim();
    const notes = String(values['Комментарий'] || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'Имя обязательно' });
    }

    const initialStatusDatePatch = status
      ? getStatusDatePatch(status, {})
      : {};

    const created = await query(
      `INSERT INTO candidates (
         agency_id,
         owner_user_id,
         created_by_user_id,
         updated_by_user_id,
         name,
         tg,
         telegram,
         status,
         platform,
         platforms,
         exp,
         experience,
         shift,
         notes,
         source,
         status_changed_at,
         hired_at,
         rejected_at,
         started_at,
         fired_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual',$15,$16,$17,$18,$19
       ) RETURNING *`,
      [
        req.user.agencyId,
        req.user.userId,
        req.user.userId,
        req.user.userId,
        name,
        telegram,
        telegram,
        status,
        platform,
        platform,
        exp,
        exp,
        shift,
        notes,
        initialStatusDatePatch.status_changed_at || null,
        initialStatusDatePatch.hired_at || null,
        initialStatusDatePatch.rejected_at || null,
        initialStatusDatePatch.started_at || null,
        initialStatusDatePatch.fired_at || null
      ]
    );

    invalidateTeamStatsCache();
    res.json({ ok: true, candidate: created.rows[0] });
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

    broadcastRealtimeUpdate({ scope: 'hr-needs' });
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

    broadcastRealtimeUpdate({ scope: 'hr-needs' });
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

    broadcastRealtimeUpdate({ scope: 'hr-needs' });
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

app.get('/api/debug/crm-events', auth, async (req, res) => {
  try {
    const events = await readCrmEvents();
    res.json({
      file: CRM_EVENTS_FILE,
      count: events.length,
      last10: events.slice(-10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'debug failed' });
  }
});

app.get('/api/debug/dashboard-live-sources', auth, async (req, res) => {
  try {
    const now = new Date();
    const currentWeekStart = startOfWeek(now);
    const previousWeekStart = new Date(currentWeekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);
    const currentWeekEnd = endOfWeek(now);
    const previousWeekEnd = new Date(currentWeekStart);
    previousWeekEnd.setMilliseconds(-1);

    const existingEvents = await readCrmEvents();
    const liveEvents = await collectBackfillEvents({
      agencyId: req.user.agencyId,
      fromDate: previousWeekStart,
      toDate: currentWeekEnd
    });
    const { filteredNew, merged } = mergeCrmEvents(existingEvents, liveEvents);

    res.json({
      crm_events_file: CRM_EVENTS_FILE,
      stats_spreadsheet_id: DASHBOARD_STATS_SPREADSHEET_ID,
      added_now: filteredNew.length,
      current_week: {
        from: formatDateOnly(currentWeekStart),
        to: formatDateOnly(currentWeekEnd),
        ...summarizeDashboardEvents(merged, currentWeekStart, currentWeekEnd)
      },
      previous_week: {
        from: formatDateOnly(previousWeekStart),
        to: formatDateOnly(previousWeekEnd),
        ...summarizeDashboardEvents(merged, previousWeekStart, previousWeekEnd)
      }
    });
  } catch (err) {
    console.error('dashboard-live-sources debug error:', err);
    res.status(500).json({ error: err.message || 'dashboard live debug failed' });
  }
});

app.get('/api/debug/dashboard-offboarded', auth, async (req, res) => {
  try {
    const { week = 'current' } = req.query;

    const baseDate =
      week === 'previous'
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        : new Date();

    const fromDate = startOfWeek(baseDate);
    const toDate = endOfWeek(baseDate);

    const existingEvents = await readCrmEvents();
    const liveEvents = await collectBackfillEvents({
      agencyId: req.user.agencyId,
      fromDate,
      toDate
    });
    const { filteredNew, merged } = mergeCrmEvents(existingEvents, liveEvents);
    const offboarded = collectDashboardOffboardedEvents(merged, fromDate, toDate);

    res.json({
      range: {
        date_from: formatDateOnly(fromDate),
        date_to: formatDateOnly(toDate),
        week
      },
      added_now: filteredNew.length,
      offboarded
    });
  } catch (err) {
    console.error('dashboard-offboarded debug error:', err);
    res.status(500).json({ error: err.message || 'dashboard offboarded debug failed' });
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

/* ─── SSE: real-time updates ─────────────────────────────────── */
app.get('/api/realtime/stream', auth, (req, res) => {
  attachRealtimeSseClient(req, res);
});

app.get('/api/team-stats/stream', auth, (req, res) => {
  attachRealtimeSseClient(req, res);
});

/* ─── Bulk sync: candidates → team sheet ─────────────────────── */
app.post('/api/admin/sync-candidates-to-team', auth, async (req, res) => {
  try {
    const agencyId = req.user.agencyId;

    // Load all candidates with team-visible statuses from the DB
    const result = await query(
      `SELECT id, name, tg, telegram, status, platforms, shift, exp, english, notes
       FROM candidates
       WHERE agency_id = $1`,
      [agencyId]
    );

    const candidates = result.rows || [];

    let added = 0;
    let skipped = 0;
    const errors = [];

    for (const c of candidates) {
      const rawStatus = c.status || '';
      const normalizedStatus = normalizeStatusAlias(rawStatus);

      if (!isVisibleTeamDashboardStatus(normalizedStatus)) {
        skipped++;
        continue;
      }

      const tg = c.tg || c.telegram || '';

      try {
        const alreadyExists = await teamSheetHasCandidateByTelegram(tg);
        if (alreadyExists) {
          skipped++;
          continue;
        }

        await moveCandidateToTeamSheet({
          ...c,
          teamStatus: normalizedStatus
        });

        added++;
      } catch (err) {
        errors.push({ name: c.name, error: err.message });
      }
    }

    invalidateTeamStatsCache();

    res.json({ ok: true, added, skipped, errors });
  } catch (err) {
    console.error('sync-candidates-to-team error:', err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

function uniqueNonEmpty(values = []) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const v = String(value || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }

  return out;
}

async function readSheetRowsWithFallback({ spreadsheetId, sheetNames, rangeSuffix = 'A1:AU5000' }) {
  if (!spreadsheetId) {
    return { spreadsheetId: '', sheetName: '', headers: [], rows: [] };
  }

  const names = uniqueNonEmpty(sheetNames);
  if (!names.length) {
    return { spreadsheetId, sheetName: '', headers: [], rows: [] };
  }

  const sheets = await getSheetsClient();
  let lastError = null;

  for (const sheetName of names) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!${rangeSuffix}`
      });

      const values = response.data.values || [];
      const headers = values[0] || [];
      const rawRows = values.slice(1);
      const rows = rawRows
        .filter(row => row.some(cell => String(cell || '').trim() !== ''))
        .map((row, index) => {
          const obj = {};
          headers.forEach((header, colIndex) => {
            const key = String(header || '').trim();
            if (!key) return;
            obj[key] = String(row[colIndex] || '').trim();
          });

          return {
            row_number: index + 2,
            raw: obj
          };
        });

      return { spreadsheetId, sheetName, headers, rows };
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return { spreadsheetId, sheetName: '', headers: [], rows: [] };
}

function getRawValueByAliases(raw = {}, aliases = []) {
  const entries = Object.entries(raw || {});
  if (!entries.length) return '';

  for (const alias of aliases) {
    const aliasKey = normalizeHeaderMatchKey(alias);
    if (!aliasKey) continue;

    const exact = entries.find(([key, value]) => {
      const headerKey = normalizeHeaderMatchKey(key);
      return headerKey === aliasKey && String(value || '').trim();
    });
    if (exact) return String(exact[1] || '').trim();
  }

  for (const alias of aliases) {
    const aliasKey = normalizeHeaderMatchKey(alias);
    if (!aliasKey || aliasKey.length < 3) continue;

    const partial = entries.find(([key, value]) => {
      const headerKey = normalizeHeaderMatchKey(key);
      if (!String(value || '').trim()) return false;
      return headerKey.includes(aliasKey) || aliasKey.includes(headerKey);
    });
    if (partial) return String(partial[1] || '').trim();
  }

  return '';
}

function normalizeSheetCandidateRow(raw = {}) {
  const name = getRawValueByAliases(raw, ['Имя', 'Имя / ник', 'Ник', 'Как вас зовут?']);
  const telegram = getRawValueByAliases(raw, ['Телеграм', 'Telegram', 'ТГ', 'Telegram / username', 'TG Username', 'Username']);
  const status = getRawValueByAliases(raw, ['Актуальный статус кандидата (Hr)', 'Статус']);
  const platform = getRawValueByAliases(raw, ['OnlyFans / Fansly', 'Платформа']);

  return {
    name,
    telegram,
    status,
    platform,
    age: getRawValueByAliases(raw, ['Возраст']),
    english: getRawValueByAliases(raw, ['Английский', 'Уровень английского']),
    exp: getRawValueByAliases(raw, ['Опыт, мес.', 'Опыт', 'Опыт работы', 'Опыт в adult', 'Опыт в adult (лет)']),
    shift: getRawValueByAliases(raw, ['Смены (основные)', 'Смены', 'Смена']),
    schedule: getRawValueByAliases(raw, ['График/предпочтение', 'График']),
    topPages: getRawValueByAliases(raw, ['Модели (основные)', 'Топ страниц', 'С какими анкетами работал-а (топ, %)']),
    topProfile: getRawValueByAliases(raw, ['Актуальная модель', 'Топ профиль', 'Top profile']),
    avgCheck: getRawValueByAliases(raw, ['Средний чек']),
    mainActivity: getRawValueByAliases(raw, ['Основная деятельность/учеба']),
    interviewReport: getRawValueByAliases(raw, ['Отчет интервью', 'Комментарий HR', 'Интервью отчет']),
    notes: getRawValueByAliases(raw, ['Комментарий', 'Комментарии', 'Comment', 'Comments']),
    source: getRawValueByAliases(raw, ['Источник']),
    leadSource: getRawValueByAliases(raw, ['Источник лида', 'Источник кандидата', 'Откуда вы о нас узнали?'])
  };
}

function shouldImportToMetaLabel(label = '') {
  const key = normalizeHeaderMatchKey(label);
  if (!key) return false;

  const excluded = new Set([
    'имя',
    'имя ник',
    'ник',
    'как вас зовут',
    'телеграм',
    'telegram',
    'тг',
    'telegram username',
    'tg username',
    'username',
    'актуальный статус кандидата hr',
    'статус',
    'onlyfans fansly',
    'платформа',
    'дата',
    'дата обновления',
    'updated at',
    'completed at',
    'completed_at',
    'updated_at'
  ]);

  return !excluded.has(key);
}

function mergeSheetIntoCandidateDraft(draft, normalizedRow, rawMeta = {}) {
  const coalesce = (current, next) => {
    const v = String(next || '').trim();
    return v ? v : current;
  };

  draft.name = coalesce(draft.name, normalizedRow.name);

  const nextTelegram = coalesce(draft.telegram || draft.tg, normalizedRow.telegram);
  draft.telegram = nextTelegram;
  draft.tg = nextTelegram;

  const nextStatusRaw = coalesce(draft.status, normalizedRow.status);
  const nextStatus = normalizeCandidateStatus(nextStatusRaw) || draft.status;
  draft.status = nextStatus;

  const nextPlatform = coalesce(draft.platform || draft.platforms, normalizedRow.platform);
  draft.platform = nextPlatform;
  draft.platforms = nextPlatform;

  draft.age = coalesce(draft.age, normalizedRow.age);

  const nextEnglish = coalesce(draft.english || draft.english_level, normalizedRow.english);
  draft.english = nextEnglish;
  draft.english_level = nextEnglish;

  const nextExp = coalesce(draft.exp || draft.experience, normalizedRow.exp);
  draft.exp = nextExp;
  draft.experience = nextExp;

  draft.shift = coalesce(draft.shift, normalizedRow.shift);

  const nextSchedule = coalesce(draft.schedule || draft.schedule_preference, normalizedRow.schedule);
  draft.schedule = nextSchedule;
  draft.schedule_preference = nextSchedule;

  draft.top_pages = coalesce(draft.top_pages, normalizedRow.topPages);
  draft.top_profile = coalesce(draft.top_profile || draft.top_pages, normalizedRow.topProfile || normalizedRow.topPages);
  draft.avg_check = coalesce(draft.avg_check, normalizedRow.avgCheck);

  const nextMainActivity = coalesce(draft.main_activity || draft.job, normalizedRow.mainActivity);
  draft.main_activity = nextMainActivity;
  draft.job = nextMainActivity;

  draft.interview_report = coalesce(draft.interview_report, normalizedRow.interviewReport);
  draft.notes = coalesce(draft.notes, normalizedRow.notes);
  draft.source = coalesce(draft.source, normalizedRow.source);
  draft.lead_source = coalesce(draft.lead_source, normalizedRow.leadSource);

  const currentMeta = draft.team_card_meta && typeof draft.team_card_meta === 'object' && !Array.isArray(draft.team_card_meta)
    ? draft.team_card_meta
    : {};
  const nextMeta = { ...currentMeta };

  for (const [label, value] of Object.entries(rawMeta || {})) {
    const key = String(label || '').trim();
    const val = String(value || '').trim();
    if (!key || !val) continue;
    if (!shouldImportToMetaLabel(key)) continue;
    nextMeta[key] = val;
  }

  draft.team_card_meta = nextMeta;
}

function resolveCandidateForSheetRow(row, candidateMaps, allCandidates) {
  const tgKey = normalizeTelegramKey(row.telegram || '');
  const nameKey = normalizePersonKey(row.name || '');

  if (!tgKey && !nameKey) {
    return { candidate: null, reason: 'missing_identity' };
  }

  if (tgKey) {
    const tgMatches = candidateMaps.byTelegram.get(tgKey) || [];
    if (tgMatches.length === 1) {
      return { candidate: tgMatches[0], reason: 'telegram' };
    }
    if (tgMatches.length > 1) {
      return { candidate: null, reason: 'ambiguous_telegram' };
    }
  }

  if (nameKey) {
    const exactNameMatches = candidateMaps.byName.get(nameKey) || [];
    if (exactNameMatches.length === 1) {
      return { candidate: exactNameMatches[0], reason: 'name' };
    }
    if (exactNameMatches.length > 1) {
      return { candidate: null, reason: 'ambiguous_name' };
    }
  }

  const loose = allCandidates.filter(candidate => namesLooselyMatch(candidate.name || '', row.name || ''));
  if (loose.length === 1) {
    return { candidate: loose[0], reason: 'loose_name' };
  }

  if (loose.length > 1) {
    return { candidate: null, reason: 'ambiguous_loose_name' };
  }

  return { candidate: null, reason: 'not_found' };
}

app.post('/api/admin/import-candidates-from-sheets', auth, requireRole('owner', 'teamlead'), async (req, res) => {
  try {
    const dryRun =
      req.body?.dryRun === true ||
      String(req.query?.dryRun || '').trim() === '1';
    const sourceModeRaw = String(req.body?.source || req.query?.source || 'both').trim().toLowerCase();
    const sourceMode = ['both', 'newcomers', 'active'].includes(sourceModeRaw)
      ? sourceModeRaw
      : 'both';

    const agencyId = req.user.agencyId;

    const newcomersSpreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || DASHBOARD_STATS_SPREADSHEET_ID;
    const activeSpreadsheetId = process.env.TEAM_SPREADSHEET_ID || DASHBOARD_STATS_SPREADSHEET_ID;

    const newcomersSheet = await readSheetRowsWithFallback({
      spreadsheetId: newcomersSpreadsheetId,
      sheetNames: [
        process.env.NEWCOMERS_SHEET_NAME,
        process.env.GOOGLE_SPREADSHEET_NAME,
        'Новички',
        'AllStarsLeads'
      ]
    });

    const activeSheet = await readSheetRowsWithFallback({
      spreadsheetId: activeSpreadsheetId,
      sheetNames: [
        process.env.TEAM_SHEET_NAME,
        'Действующие'
      ]
    });

    const sourceRows = [
      ...(sourceMode !== 'active'
        ? (newcomersSheet.rows || []).map(row => ({ source: 'newcomers', ...row }))
        : []),
      ...(sourceMode !== 'newcomers'
        ? (activeSheet.rows || []).map(row => ({ source: 'active', ...row }))
        : [])
    ];

    const seenTelegrams = new Set();
    let inserted = 0;
    let skipped = 0;
    const insertErrors = [];
    const skippedSample = [];

    for (const sourceRow of sourceRows) {
      const normalized = normalizeSheetCandidateRow(sourceRow.raw || {});

      if (!normalized.name && !normalized.telegram) {
        skipped++;
        continue;
      }

      const tgKey = normalizeTelegramKey(normalized.telegram || '');

      if (tgKey) {
        if (seenTelegrams.has(tgKey)) {
          skipped++;
          skippedSample.push({ reason: 'duplicate_in_sheet', name: normalized.name, telegram: normalized.telegram });
          continue;
        }
        seenTelegrams.add(tgKey);
      }

      if (!dryRun) {
        try {
          const status = normalizeCandidateStatus(normalized.status || '') || 'Без статуса';
          const statusDatePatch = getStatusDatePatch(status, {});

          await query(
            `INSERT INTO candidates (
               agency_id,
               owner_user_id,
               created_by_user_id,
               updated_by_user_id,
               name,
               tg,
               telegram,
               age,
               english,
               english_level,
               exp,
               experience,
               platform,
               platforms,
               shift,
               schedule,
               schedule_preference,
               top_pages,
               top_profile,
               avg_check,
               job,
               main_activity,
               interview_report,
               status,
               source,
               lead_source,
               notes,
               status_changed_at,
               hired_at,
               rejected_at,
               started_at,
               fired_at,
               ratings,
               total
             )
             VALUES (
               $1,$2,$3,$4,$5,
               $6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,
               $26,$27,$28,$29,$30,
               $31,$32,$33,$34
             )
             ON CONFLICT DO NOTHING`,
            [
              agencyId,
              req.user.userId,
              req.user.userId,
              req.user.userId,
              normalized.name || '',
              normalized.telegram || '',
              normalized.telegram || '',
              normalized.age || '',
              normalized.english || '',
              normalized.english || '',
              normalized.exp || '',
              normalized.exp || '',
              normalized.platform || '',
              normalized.platform || '',
              normalized.shift || '',
              normalized.schedule || '',
              normalized.schedule || '',
              normalized.topPages || '',
              normalized.topProfile || normalized.topPages || '',
              normalized.avgCheck || '',
              normalized.mainActivity || '',
              normalized.mainActivity || '',
              normalized.interviewReport || '',
              status,
              normalized.source || sourceRow.source || 'sheets',
              normalized.leadSource || '',
              normalized.notes || '',
              statusDatePatch.status_changed_at || null,
              statusDatePatch.hired_at || null,
              statusDatePatch.rejected_at || null,
              statusDatePatch.started_at || null,
              statusDatePatch.fired_at || null,
              '{}',
              0
            ]
          );
          inserted++;
        } catch (err) {
          insertErrors.push({ name: normalized.name, telegram: normalized.telegram, error: err.message });
        }
      } else {
        inserted++;
      }
    }

    if (inserted > 0 && !dryRun) {
      invalidateTeamStatsCache();
    }

    res.json({
      ok: true,
      dry_run: dryRun,
      source_mode: sourceMode,
      agency_id: agencyId,
      total_sheet_rows: sourceRows.length,
      inserted,
      skipped,
      insert_errors: insertErrors,
      skipped_sample: skippedSample.slice(0, 50),
      sources: {
        newcomers: {
          spreadsheet_id: newcomersSheet.spreadsheetId,
          sheet_name: newcomersSheet.sheetName,
          rows: newcomersSheet.rows.length
        },
        active: {
          spreadsheet_id: activeSheet.spreadsheetId,
          sheet_name: activeSheet.sheetName,
          rows: activeSheet.rows.length
        }
      }
    });
  } catch (err) {
    console.error('import-candidates-from-sheets error:', err);
    res.status(500).json({ error: err.message || 'Import from sheets failed' });
  }
});

app.post('/api/admin/restore-candidates-from-sheets', auth, requireRole('owner', 'teamlead'), async (req, res) => {
  try {
    const dryRun =
      req.body?.dryRun === true ||
      String(req.query?.dryRun || '').trim() === '1';
    const sourceModeRaw = String(req.body?.source || req.query?.source || 'both').trim().toLowerCase();
    const sourceMode = ['both', 'newcomers', 'active'].includes(sourceModeRaw)
      ? sourceModeRaw
      : 'both';

    const agencyId = req.user.agencyId;

    const dbCandidatesRes = await query(
      `SELECT
         id,
         agency_id,
         name,
         tg,
         telegram,
         age,
         english,
         english_level,
         exp,
         experience,
         platform,
         platforms,
         shift,
         schedule,
         schedule_preference,
         top_pages,
         top_profile,
         avg_check,
         job,
         main_activity,
         interview_report,
         status,
         source,
         lead_source,
         notes,
         team_card_meta
       FROM candidates
       WHERE agency_id = $1`,
      [agencyId]
    );

    const dbCandidates = dbCandidatesRes.rows || [];

    const byTelegram = new Map();
    const byName = new Map();

    for (const candidate of dbCandidates) {
      const tgKeys = [
        normalizeTelegramKey(candidate.tg || ''),
        normalizeTelegramKey(candidate.telegram || '')
      ].filter(Boolean);

      for (const key of tgKeys) {
        const list = byTelegram.get(key) || [];
        list.push(candidate);
        byTelegram.set(key, list);
      }

      const personKey = normalizePersonKey(candidate.name || '');
      if (personKey) {
        const list = byName.get(personKey) || [];
        list.push(candidate);
        byName.set(personKey, list);
      }
    }

    const newcomersSpreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || DASHBOARD_STATS_SPREADSHEET_ID;
    const activeSpreadsheetId = process.env.TEAM_SPREADSHEET_ID || DASHBOARD_STATS_SPREADSHEET_ID;

    const newcomersSheet = await readSheetRowsWithFallback({
      spreadsheetId: newcomersSpreadsheetId,
      sheetNames: [
        process.env.NEWCOMERS_SHEET_NAME,
        process.env.GOOGLE_SPREADSHEET_NAME,
        'Новички',
        'AllStarsLeads'
      ]
    });

    const activeSheet = await readSheetRowsWithFallback({
      spreadsheetId: activeSpreadsheetId,
      sheetNames: [
        process.env.TEAM_SHEET_NAME,
        'Действующие'
      ]
    });

    const sourceRows = [
      ...(sourceMode !== 'active'
        ? (newcomersSheet.rows || []).map(row => ({ source: 'newcomers', ...row }))
        : []),
      ...(sourceMode !== 'newcomers'
        ? (activeSheet.rows || []).map(row => ({ source: 'active', ...row }))
        : [])
    ];

    const candidateDrafts = new Map();
    const unmatched = [];

    let processed = 0;
    let matched = 0;

    for (const sourceRow of sourceRows) {
      processed += 1;

      const normalized = normalizeSheetCandidateRow(sourceRow.raw || {});
      const match = resolveCandidateForSheetRow(normalized, { byTelegram, byName }, dbCandidates);

      if (!match.candidate) {
        unmatched.push({
          source: sourceRow.source,
          row_number: sourceRow.row_number,
          name: normalized.name || '',
          telegram: normalized.telegram || '',
          reason: match.reason
        });
        continue;
      }

      matched += 1;
      const candidateId = Number(match.candidate.id);
      const draft = candidateDrafts.get(candidateId) || {
        ...match.candidate,
        team_card_meta: match.candidate.team_card_meta && typeof match.candidate.team_card_meta === 'object'
          ? { ...match.candidate.team_card_meta }
          : {}
      };

      mergeSheetIntoCandidateDraft(draft, normalized, sourceRow.raw || {});
      candidateDrafts.set(candidateId, draft);
    }

    let updated = 0;
    const updateErrors = [];

    if (!dryRun) {
      for (const [candidateId, draft] of candidateDrafts.entries()) {
        const original = dbCandidates.find(c => Number(c.id) === Number(candidateId));
        if (!original) continue;

        const statusDatePatch = draft.status && draft.status !== original.status
          ? getStatusDatePatch(draft.status, original)
          : {};

        try {
          await query(
            `UPDATE candidates
             SET name = $3,
                 tg = $4,
                 telegram = $5,
                 status = $6,
                 platform = $7,
                 platforms = $8,
                 exp = $9,
                 experience = $10,
                 shift = $11,
                 schedule = $12,
                 schedule_preference = $13,
                 top_pages = $14,
                 top_profile = $15,
                 avg_check = $16,
                 job = $17,
                 main_activity = $18,
                 interview_report = $19,
                 source = $20,
                 lead_source = $21,
                 age = $22,
                 english = $23,
                 english_level = $24,
                 notes = $25,
                 team_card_meta = $26::jsonb,
                 updated_by_user_id = $27,
                 updated_at = NOW(),
                 status_changed_at = COALESCE($28, status_changed_at),
                 hired_at = COALESCE($29, hired_at),
                 rejected_at = COALESCE($30, rejected_at),
                 started_at = COALESCE($31, started_at),
                 fired_at = COALESCE($32, fired_at)
             WHERE id = $1 AND agency_id = $2`,
            [
              candidateId,
              agencyId,
              draft.name || '',
              draft.tg || draft.telegram || '',
              draft.telegram || draft.tg || '',
              normalizeCandidateStatus(draft.status) || draft.status || '',
              draft.platform || draft.platforms || '',
              draft.platforms || draft.platform || '',
              draft.exp || draft.experience || '',
              draft.experience || draft.exp || '',
              draft.shift || '',
              draft.schedule || draft.schedule_preference || '',
              draft.schedule_preference || draft.schedule || '',
              draft.top_pages || '',
              draft.top_profile || draft.top_pages || '',
              draft.avg_check || '',
              draft.job || draft.main_activity || '',
              draft.main_activity || draft.job || '',
              draft.interview_report || '',
              draft.source || '',
              draft.lead_source || '',
              draft.age || '',
              draft.english || draft.english_level || '',
              draft.english_level || draft.english || '',
              draft.notes || '',
              JSON.stringify(draft.team_card_meta || {}),
              req.user.userId,
              statusDatePatch.status_changed_at || null,
              statusDatePatch.hired_at || null,
              statusDatePatch.rejected_at || null,
              statusDatePatch.started_at || null,
              statusDatePatch.fired_at || null
            ]
          );

          updated += 1;
        } catch (err) {
          updateErrors.push({ candidate_id: candidateId, error: err.message });
        }
      }

      if (updated > 0) {
        invalidateTeamStatsCache();
      }
    }

    res.json({
      ok: true,
      dry_run: dryRun,
      source_mode: sourceMode,
      processed_rows: processed,
      matched_rows: matched,
      unmatched_rows: unmatched.length,
      touched_candidates: candidateDrafts.size,
      updated_candidates: dryRun ? 0 : updated,
      update_errors: updateErrors,
      unmatched_sample: unmatched.slice(0, 200),
      sources: {
        newcomers: {
          spreadsheet_id: newcomersSheet.spreadsheetId,
          sheet_name: newcomersSheet.sheetName,
          rows: newcomersSheet.rows.length
        },
        active: {
          spreadsheet_id: activeSheet.spreadsheetId,
          sheet_name: activeSheet.sheetName,
          rows: activeSheet.rows.length
        }
      }
    });
  } catch (err) {
    console.error('restore-candidates-from-sheets error:', err);
    res.status(500).json({ error: err.message || 'Restore from sheets failed' });
  }
});

app.post('/api/admin/rebuild-local-crm-from-sheets', auth, requireRole('owner', 'teamlead'), async (req, res) => {
  try {
    const dryRun =
      req.body?.dryRun === true ||
      String(req.query?.dryRun || '').trim() === '1';
    const sourceModeRaw = String(req.body?.source || req.query?.source || 'both').trim().toLowerCase();
    const sourceMode = ['both', 'newcomers', 'active'].includes(sourceModeRaw)
      ? sourceModeRaw
      : 'both';
    const resetTransactionEndings =
      req.body?.resetTransactionEndings !== false &&
      String(req.query?.resetTransactionEndings || '').trim().toLowerCase() !== '0';

    const agencyId = req.user.agencyId;

    const newcomersSpreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || DASHBOARD_STATS_SPREADSHEET_ID;
    const activeSpreadsheetId = process.env.TEAM_SPREADSHEET_ID || DASHBOARD_STATS_SPREADSHEET_ID;

    const newcomersSheet = await readSheetRowsWithFallback({
      spreadsheetId: newcomersSpreadsheetId,
      sheetNames: [
        process.env.NEWCOMERS_SHEET_NAME,
        process.env.GOOGLE_SPREADSHEET_NAME,
        'Новички',
        'AllStarsLeads'
      ]
    });

    const activeSheet = await readSheetRowsWithFallback({
      spreadsheetId: activeSpreadsheetId,
      sheetNames: [
        process.env.TEAM_SHEET_NAME,
        'Действующие'
      ]
    });

    const sourceRows = [
      ...(sourceMode !== 'active'
        ? (newcomersSheet.rows || []).map(row => ({ source: 'newcomers', ...row }))
        : []),
      ...(sourceMode !== 'newcomers'
        ? (activeSheet.rows || []).map(row => ({ source: 'active', ...row }))
        : [])
    ];

    const seenTelegrams = new Set();
    const insertPayload = [];
    const skippedSample = [];

    for (const sourceRow of sourceRows) {
      const normalized = normalizeSheetCandidateRow(sourceRow.raw || {});

      if (!normalized.name && !normalized.telegram) {
        skippedSample.push({
          reason: 'missing_identity',
          source: sourceRow.source,
          row_number: sourceRow.row_number
        });
        continue;
      }

      const tgKey = normalizeTelegramKey(normalized.telegram || '');
      if (tgKey && seenTelegrams.has(tgKey)) {
        skippedSample.push({
          reason: 'duplicate_telegram',
          source: sourceRow.source,
          row_number: sourceRow.row_number,
          name: normalized.name,
          telegram: normalized.telegram
        });
        continue;
      }

      if (tgKey) {
        seenTelegrams.add(tgKey);
      }

      const status = normalizeCandidateStatus(normalized.status || '') || 'Без статуса';
      const statusDatePatch = getStatusDatePatch(status, {});

      insertPayload.push({
        source: sourceRow.source,
        row_number: sourceRow.row_number,
        normalized,
        status,
        statusDatePatch
      });
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dry_run: true,
        source_mode: sourceMode,
        agency_id: agencyId,
        total_sheet_rows: sourceRows.length,
        would_insert: insertPayload.length,
        would_skip: sourceRows.length - insertPayload.length,
        skipped_sample: skippedSample.slice(0, 100),
        sources: {
          newcomers: {
            spreadsheet_id: newcomersSheet.spreadsheetId,
            sheet_name: newcomersSheet.sheetName,
            rows: newcomersSheet.rows.length
          },
          active: {
            spreadsheet_id: activeSheet.spreadsheetId,
            sheet_name: activeSheet.sheetName,
            rows: activeSheet.rows.length
          }
        }
      });
    }

    const txClient = await pool.connect();
    const insertErrors = [];

    let removedCandidates = 0;
    let removedStatusHistory = 0;
    let removedInsights = 0;
    let removedInterviewMeta = 0;
    let removedLegacyEvents = 0;
    let resetEndingsCount = 0;

    try {
      await txClient.query('BEGIN');

      const existingCandidateIdsRes = await txClient.query(
        `SELECT id
         FROM candidates
         WHERE agency_id = $1`,
        [agencyId]
      );
      const existingCandidateIds = (existingCandidateIdsRes.rows || [])
        .map(row => Number(row.id))
        .filter(id => Number.isInteger(id) && id > 0);

      if (existingCandidateIds.length) {
        const historyDeleteRes = await txClient.query(
          `DELETE FROM candidate_status_history
           WHERE candidate_id = ANY($1::int[])`,
          [existingCandidateIds]
        );
        removedStatusHistory = Number(historyDeleteRes.rowCount || 0);

        const insightsDeleteRes = await txClient.query(
          `DELETE FROM candidate_ai_insights
           WHERE candidate_id = ANY($1::int[])`,
          [existingCandidateIds]
        );
        removedInsights = Number(insightsDeleteRes.rowCount || 0);
      }

      const interviewMetaDeleteRes = await txClient.query(
        `DELETE FROM interview_crm_meta
         WHERE agency_id = $1`,
        [agencyId]
      );
      removedInterviewMeta = Number(interviewMetaDeleteRes.rowCount || 0);

      const candidatesDeleteRes = await txClient.query(
        `DELETE FROM candidates
         WHERE agency_id = $1`,
        [agencyId]
      );
      removedCandidates = Number(candidatesDeleteRes.rowCount || 0);

      const legacyEventsDeleteRes = await txClient.query(
        `DELETE FROM crm_events
         WHERE (meta_json ? 'agencyId')
           AND (meta_json->>'agencyId') ~ '^\\d+$'
           AND (meta_json->>'agencyId')::int = $1`,
        [agencyId]
      ).catch(() => ({ rowCount: 0 }));
      removedLegacyEvents = Number(legacyEventsDeleteRes.rowCount || 0);

      if (resetTransactionEndings) {
        const endingsResetRes = await txClient.query(
          `UPDATE transaction_endings
           SET assigned_to = NULL,
               assigned_row_number = NULL,
               assigned_user_id = NULL,
               updated_at = NOW()`
        ).catch(() => ({ rowCount: 0 }));
        resetEndingsCount = Number(endingsResetRes.rowCount || 0);
      }

      for (const item of insertPayload) {
        const normalized = item.normalized;
        const statusDatePatch = item.statusDatePatch;

        try {
          await txClient.query(
            `INSERT INTO candidates (
               agency_id,
               owner_user_id,
               created_by_user_id,
               updated_by_user_id,
               name,
               tg,
               telegram,
               age,
               english,
               english_level,
               exp,
               experience,
               platform,
               platforms,
               shift,
               schedule,
               schedule_preference,
               top_pages,
               top_profile,
               avg_check,
               job,
               main_activity,
               interview_report,
               status,
               source,
               lead_source,
               notes,
               status_changed_at,
               hired_at,
               rejected_at,
               started_at,
               fired_at,
               ratings,
               total
             )
             VALUES (
               $1,$2,$3,$4,$5,
               $6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,
               $26,$27,$28,$29,$30,
               $31,$32,$33,$34
             )`,
            [
              agencyId,
              req.user.userId,
              req.user.userId,
              req.user.userId,
              normalized.name || '',
              normalized.telegram || '',
              normalized.telegram || '',
              normalized.age || '',
              normalized.english || '',
              normalized.english || '',
              normalized.exp || '',
              normalized.exp || '',
              normalized.platform || '',
              normalized.platform || '',
              normalized.shift || '',
              normalized.schedule || '',
              normalized.schedule || '',
              normalized.topPages || '',
              normalized.topProfile || normalized.topPages || '',
              normalized.avgCheck || '',
              normalized.mainActivity || '',
              normalized.mainActivity || '',
              normalized.interviewReport || '',
              item.status,
              normalized.source || item.source || 'sheets',
              normalized.leadSource || '',
              normalized.notes || '',
              statusDatePatch.status_changed_at || null,
              statusDatePatch.hired_at || null,
              statusDatePatch.rejected_at || null,
              statusDatePatch.started_at || null,
              statusDatePatch.fired_at || null,
              '{}',
              0
            ]
          );
        } catch (err) {
          insertErrors.push({
            source: item.source,
            row_number: item.row_number,
            name: normalized.name,
            telegram: normalized.telegram,
            error: err.message
          });
        }
      }

      if (insertErrors.length) {
        throw new Error(`Failed to insert ${insertErrors.length} candidates`);
      }

      await txClient.query('COMMIT');
    } catch (err) {
      await txClient.query('ROLLBACK');
      throw err;
    } finally {
      txClient.release();
    }

    try {
      await writeCrmEvents([]);
    } catch (eventsErr) {
      console.warn('Failed to clear local CRM events file:', eventsErr.message);
    }

    invalidateTeamStatsCache();
    broadcastRealtimeUpdate({ scope: 'all' });

    res.json({
      ok: true,
      dry_run: false,
      source_mode: sourceMode,
      agency_id: agencyId,
      total_sheet_rows: sourceRows.length,
      inserted: insertPayload.length,
      skipped: sourceRows.length - insertPayload.length,
      skipped_sample: skippedSample.slice(0, 100),
      cleared: {
        candidates: removedCandidates,
        candidate_status_history: removedStatusHistory,
        candidate_ai_insights: removedInsights,
        interview_crm_meta: removedInterviewMeta,
        crm_events: removedLegacyEvents,
        transaction_endings_reset: resetEndingsCount
      },
      sources: {
        newcomers: {
          spreadsheet_id: newcomersSheet.spreadsheetId,
          sheet_name: newcomersSheet.sheetName,
          rows: newcomersSheet.rows.length
        },
        active: {
          spreadsheet_id: activeSheet.spreadsheetId,
          sheet_name: activeSheet.sheetName,
          rows: activeSheet.rows.length
        }
      }
    });
  } catch (err) {
    console.error('rebuild-local-crm-from-sheets error:', err);
    res.status(500).json({
      error: err.message || 'Failed to rebuild local CRM from sheets'
    });
  }
});

async function start() {
  try {
    await initDb();
  } catch (err) {
    console.error('Database initialization error:', err.message);
    console.warn('Starting server anyway - database may be unavailable');
  }

  app.listen(PORT, () => {
    console.log(`AllStars HR SaaS running on ${PORT}`);
  });
}

start();
