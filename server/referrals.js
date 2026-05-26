import fs from 'fs/promises';
import path from 'path';
import { formatISO, differenceInCalendarDays, parseISO, isValid } from 'date-fns';
import { findFieldByAliases, normalizeKey } from './googleSheets.js';

const REFERRER_ALIASES = [
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

const USERNAME_ALIASES = [
  'telegram',
  'tg',
  'username',
  'telegram username',
  'юзернейм',
  'телеграм',
  'tg username'
];

const STATUS_ALIASES = [
  'status',
  'статус',
  'work status',
  'рабочий статус'
];

const START_DATE_ALIASES = [
  'start date',
  'started_at',
  'дата старта',
  'дата выхода',
  'дата начала',
  'вышел',
  'выход'
];

const PHONE_ALIASES = [
  'phone',
  'телефон',
  'номер',
  'номер телефона',
  'mobile'
];

const NAME_ALIASES = [
  'name',
  'full name',
  'fio',
  'фио',
  'имя',
  'candidate'
];

const EMAIL_ALIASES = [
  'email',
  'почта',
  'e-mail'
];

const TIMER_DAYS = 30;
const STORAGE_FILE = path.join(process.cwd(), 'server', 'data', 'referralStartDates.json');

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(value);
}

function isWorkingStatus(value) {
  return normalizeStatus(value) === 'работает';
}

function parseDateSafe(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const ddmmyyyy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy, hh = '00', min = '00'] = ddmmyyyy;
    const parsed = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${min}:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function getField(record, aliases) {
  return findFieldByAliases(record, aliases);
}

function extractIdentity(record) {
  return {
    username: normalizeUsername(getField(record, USERNAME_ALIASES)),
    phone: normalizePhone(getField(record, PHONE_ALIASES)),
    email: normalizeText(getField(record, EMAIL_ALIASES)),
    name: normalizeText(getField(record, NAME_ALIASES))
  };
}

function makeStorageKey(candidate) {
  const id = extractIdentity(candidate);

  return id.username || id.phone || id.email || id.name || normalizeKey(JSON.stringify(candidate || {}));
}

async function readStartDateStorage() {
  try {
    const raw = await fs.readFile(STORAGE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStartDateStorage(data) {
  await fs.mkdir(path.dirname(STORAGE_FILE), { recursive: true });
  await fs.writeFile(STORAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export function matchCandidateToActive(candidate, activeUser) {
  const c = extractIdentity(candidate);
  const a = extractIdentity(activeUser);

  // Priority: username -> phone -> email -> name.
  if (c.username && a.username && c.username === a.username) {
    return { matched: true, reason: 'username' };
  }

  if (c.phone && a.phone && c.phone === a.phone) {
    return { matched: true, reason: 'phone' };
  }

  if (c.email && a.email && c.email === a.email) {
    return { matched: true, reason: 'email' };
  }

  if (c.name && a.name && c.name === a.name) {
    return { matched: true, reason: 'name' };
  }

  return { matched: false, reason: null };
}

function findBestActiveMatch(candidate, activeUsers) {
  let byName = null;

  for (const active of activeUsers) {
    const res = matchCandidateToActive(candidate, active);
    if (!res.matched) continue;

    if (res.reason === 'username') return { active, reason: res.reason };
    if (res.reason === 'phone') return { active, reason: res.reason };
    if (res.reason === 'email') return { active, reason: res.reason };

    if (res.reason === 'name' && !byName) {
      byName = { active, reason: res.reason };
    }
  }

  return byName;
}

function buildTimerStatus(isWorking, daysPassed) {
  if (!isWorking) return 'Ожидает выхода / не работает';
  if (daysPassed >= TIMER_DAYS) return 'Готов к выплате';
  return 'Таймер идет';
}

export async function buildReferralRows(candidates, activeUsers) {
  const storage = await readStartDateStorage();
  let storageChanged = false;

  const rows = [];

  for (const candidate of candidates) {
    const referrerUsername = normalizeUsername(getField(candidate, REFERRER_ALIASES));
    if (!referrerUsername) continue;

    const matched = findBestActiveMatch(candidate, activeUsers || []);
    const matchedActiveUser = matched?.active || null;

    const activeStatus = matchedActiveUser ? getField(matchedActiveUser, STATUS_ALIASES) : '';
    const isWorking = isWorkingStatus(activeStatus);

    const storageKey = makeStorageKey(candidate);

    let timerStartDate = null;

    if (isWorking) {
      const sheetDateRaw = matchedActiveUser ? getField(matchedActiveUser, START_DATE_ALIASES) : '';
      const parsedSheetDate = parseDateSafe(sheetDateRaw);

      // Keep timer start date stable: prefer sheet start date, otherwise store first working detection date.
      if (parsedSheetDate) {
        timerStartDate = formatISO(parsedSheetDate);
      } else if (storage[storageKey]) {
        timerStartDate = storage[storageKey];
      } else {
        timerStartDate = formatISO(new Date());
        storage[storageKey] = timerStartDate;
        storageChanged = true;
      }
    }

    let daysPassed = 0;
    let daysLeft = TIMER_DAYS;
    let progressPercent = 0;
    let payoutReady = false;

    if (timerStartDate) {
      const date = parseISO(timerStartDate);
      if (isValid(date)) {
        daysPassed = Math.max(0, differenceInCalendarDays(new Date(), date));
        daysLeft = Math.max(0, TIMER_DAYS - daysPassed);
        progressPercent = Math.max(0, Math.min(100, Math.round((daysPassed / TIMER_DAYS) * 100)));
        payoutReady = daysPassed >= TIMER_DAYS;
      }
    }

    rows.push({
      candidate,
      referrerUsername,
      matchedActiveUser,
      isWorking,
      workingStatus: activeStatus || 'не работает',
      timerStartDate,
      daysPassed,
      daysLeft,
      progressPercent,
      payoutReady,
      timerStatus: buildTimerStatus(isWorking, daysPassed),
      matchReason: matched?.reason || null
    });
  }

  if (storageChanged) {
    await writeStartDateStorage(storage);
  }

  return rows;
}
