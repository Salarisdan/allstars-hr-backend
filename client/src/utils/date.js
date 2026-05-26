import { format, formatDistanceStrict, parseISO, isValid } from 'date-fns';

export function formatDateTime(value) {
  if (!value) return '-';
  const parsed = parseISO(value);
  if (!isValid(parsed)) return '-';
  return format(parsed, 'dd.MM.yyyy HH:mm');
}

export function relativeFromNow(value) {
  if (!value) return '-';
  const parsed = parseISO(value);
  if (!isValid(parsed)) return '-';
  return formatDistanceStrict(parsed, new Date(), { addSuffix: true });
}

export function clampPercent(value) {
  const num = Number(value || 0);
  return Math.max(0, Math.min(100, num));
}
