export function getRecordTitle(record = {}, fallback = 'Запись') {
  return (
    record.name ||
    record['Имя'] ||
    record['ФИО'] ||
    record.full_name ||
    record.fullName ||
    record.username ||
    fallback
  );
}

export function getRecordSubtitle(record = {}) {
  return record.telegram || record.tg || record.username || record.phone || record['Телефон'] || '';
}

export function pickFirstField(record = {}, keys = []) {
  for (const key of keys) {
    const value = record[key];
    if (String(value || '').trim()) return String(value).trim();
  }

  return '';
}

export function hasAnyField(record = {}, keys = []) {
  return keys.some((key) => String(record[key] || '').trim());
}