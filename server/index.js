import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadCandidatesFromSheets, loadActiveUsersFromSheets, findFieldByAliases } from './googleSheets.js';
import { buildReferralRows } from './referrals.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const clientDistPath = path.join(rootDir, 'client', 'dist');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

function safeText(value) {
  return String(value || '').toLowerCase();
}

function hasReferrer(candidate) {
  const aliases = [
    'referral',
    'referal',
    'ref',
    'referrer',
    'referred_by',
    'invited_by',
    'кто пригласил',
    'от кого',
    'реферал',
    'реферер',
    'telegram ref',
    'username ref'
  ];

  return Boolean(findFieldByAliases(candidate, aliases));
}

function matchesSearch(record, query) {
  const q = safeText(query).trim();
  if (!q) return true;

  return Object.values(record || {}).some((value) => safeText(value).includes(q));
}

function normalizeWorkingStatusText(activeUser) {
  const value = findFieldByAliases(activeUser, ['status', 'статус', 'work status']) || '';
  const normalized = value.trim().toLowerCase();

  return {
    raw: value,
    normalized,
    isWorking: normalized === 'работает'
  };
}

async function getCandidates() {
  return loadCandidatesFromSheets();
}

async function getActiveUsers() {
  const rows = await loadActiveUsersFromSheets();

  return rows.map((row) => {
    const working = normalizeWorkingStatusText(row);
    return {
      ...row,
      _workingStatus: working.raw,
      _workingNormalized: working.normalized,
      _isWorking: working.isWorking
    };
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/smoke', async (req, res) => {
  const requiredEnv = [
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_SPREADSHEET_ID',
    'GOOGLE_SPREADSHEET_NAME',
    'TEAM_SPREADSHEET_ID',
    'TEAM_SHEET_NAME'
  ];

  const env = Object.fromEntries(
    requiredEnv.map((key) => [key, Boolean(String(process.env[key] || '').trim())])
  );

  const missingEnv = requiredEnv.filter((key) => !env[key]);
  const deep = String(req.query.deep || '').trim().toLowerCase();
  const runDeepCheck = deep === '1' || deep === 'true' || deep === 'yes';

  if (!runDeepCheck) {
    return res.json({
      ok: missingEnv.length === 0,
      mode: 'basic',
      env,
      missingEnv,
      timestamp: new Date().toISOString()
    });
  }

  const checks = {
    candidates: { ok: false, count: 0, error: '' },
    active: { ok: false, count: 0, error: '' }
  };

  try {
    const rows = await getCandidates();
    checks.candidates.ok = true;
    checks.candidates.count = rows.length;
  } catch (error) {
    checks.candidates.error = error.message || 'Failed to load candidates';
  }

  try {
    const rows = await getActiveUsers();
    checks.active.ok = true;
    checks.active.count = rows.length;
  } catch (error) {
    checks.active.error = error.message || 'Failed to load active users';
  }

  const ok = missingEnv.length === 0 && checks.candidates.ok && checks.active.ok;

  return res.status(ok ? 200 : 500).json({
    ok,
    mode: 'deep',
    env,
    missingEnv,
    checks,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/candidates', async (req, res) => {
  try {
    const rows = await getCandidates();
    const search = String(req.query.search || '').trim();
    const withReferrer = String(req.query.withReferrer || '').trim().toLowerCase();

    let result = rows.filter((row) => matchesSearch(row, search));

    if (withReferrer === '1' || withReferrer === 'true' || withReferrer === 'yes') {
      result = result.filter((row) => hasReferrer(row));
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load candidates' });
  }
});

app.get('/api/active', async (req, res) => {
  try {
    const rows = await getActiveUsers();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load active users' });
  }
});

app.get('/api/referrals', async (req, res) => {
  try {
    const [candidates, activeUsers] = await Promise.all([getCandidates(), getActiveUsers()]);
    const rows = await buildReferralRows(candidates, activeUsers);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load referrals' });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [candidates, activeUsers, referrals] = await Promise.all([
      getCandidates(),
      getActiveUsers(),
      getReferralsSafe()
    ]);

    const totalCandidates = candidates.length;
    const totalActive = activeUsers.length;
    const totalReferrals = referrals.length;
    const workingReferrals = referrals.filter((item) => item.isWorking).length;
    const payoutReadyCount = referrals.filter((item) => item.payoutReady).length;

    res.json({
      totalCandidates,
      totalActive,
      totalReferrals,
      workingReferrals,
      payoutReadyCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to build dashboard' });
  }
});

async function getReferralsSafe() {
  const [candidates, activeUsers] = await Promise.all([getCandidates(), getActiveUsers()]);
  return buildReferralRows(candidates, activeUsers);
}

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`AllStars CRM server is running on port ${PORT}`);
});
