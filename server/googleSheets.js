import { google } from 'googleapis';

const READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function parseServiceAccountFromEnv() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();

  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be a valid JSON string');
  }

  const clientEmail = String(parsed.client_email || '').trim();
  const privateKey = String(parsed.private_key || '')
    .replace(/\\n/g, '\n')
    .trim();

  if (!clientEmail || !privateKey) {
    throw new Error('Service account credentials are incomplete in GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  return {
    ...parsed,
    client_email: clientEmail,
    private_key: privateKey
  };
}

function getSheetsApi() {
  const creds = parseServiceAccountFromEnv();

  // Service account JWT auth is used server-side only with readonly scope.
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [READONLY_SCOPE]
  });

  return google.sheets({ version: 'v4', auth });
}

function normalizeHeader(value, index) {
  const text = String(value || '').trim();
  return text || `field_${index + 1}`;
}

function rowValuesToObject(headers, row) {
  const result = {};

  for (let i = 0; i < headers.length; i += 1) {
    result[headers[i]] = String(row?.[i] ?? '').trim();
  }

  return result;
}

export function sheetRowsToObjects(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const headerRow = Array.isArray(values[0]) ? values[0] : [];
  const headers = headerRow.map((item, index) => normalizeHeader(item, index));
  const dataRows = values.slice(1);

  return dataRows
    .filter((row) => Array.isArray(row))
    .map((row) => rowValuesToObject(headers, row));
}

export function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function findFieldByAliases(record, aliases = []) {
  const entries = Object.entries(record || {});
  const normalizedAliases = aliases.map((alias) => normalizeKey(alias));

  for (const [key, value] of entries) {
    if (!String(value || '').trim()) continue;

    const normalizedKey = normalizeKey(key);
    if (normalizedAliases.includes(normalizedKey)) {
      return String(value).trim();
    }
  }

  return '';
}

async function getFirstSheetTitle(sheetsApi, spreadsheetId) {
  const res = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });

  return String(res.data?.sheets?.[0]?.properties?.title || '').trim();
}

async function getValues(spreadsheetId, range) {
  const sheetsApi = getSheetsApi();
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return response.data?.values || [];
}

export async function loadCandidatesFromSheets() {
  const spreadsheetId = String(process.env.GOOGLE_SPREADSHEET_ID || '').trim();
  const preferredSheetName = String(process.env.GOOGLE_SPREADSHEET_NAME || '').trim();

  if (!spreadsheetId) {
    throw new Error('GOOGLE_SPREADSHEET_ID is required');
  }

  let range = 'A:Z';

  if (preferredSheetName) {
    range = `${preferredSheetName}!A:Z`;
  } else {
    const sheetsApi = getSheetsApi();
    const firstSheetTitle = await getFirstSheetTitle(sheetsApi, spreadsheetId);
    if (firstSheetTitle) {
      range = `${firstSheetTitle}!A:Z`;
    }
  }

  const rows = await getValues(spreadsheetId, range);
  return sheetRowsToObjects(rows);
}

export async function loadActiveUsersFromSheets() {
  const spreadsheetId = String(process.env.TEAM_SPREADSHEET_ID || '').trim();
  const sheetName = String(process.env.TEAM_SHEET_NAME || '').trim();

  if (!spreadsheetId) {
    throw new Error('TEAM_SPREADSHEET_ID is required');
  }

  if (!sheetName) {
    throw new Error('TEAM_SHEET_NAME is required');
  }

  const range = `${sheetName}!A:Z`;
  const rows = await getValues(spreadsheetId, range);
  return sheetRowsToObjects(rows);
}
