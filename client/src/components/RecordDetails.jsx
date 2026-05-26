const PRIORITY_MATCHES = [
  ['Имя', ['имя', 'name', 'full name', 'full_name', 'fio', 'фио']],
  ['Telegram', ['telegram', 'tg', 'username', 'ник', 'юзернейм']],
  ['Телефон', ['phone', 'phone number', 'mobile', 'телефон', 'тел']],
  ['Статус', ['status', 'статус', 'working status', 'work status']],
  ['Город', ['city', 'город', 'location', 'локация']],
  ['Источник', ['source', 'источник', 'referral', 'referal', 'referrer', 'referred by', 'invited by']],
  ['Вакансия', ['vacancy', 'position', 'role', 'должность', 'вакансия']],
  ['Опыт', ['experience', 'exp', 'опыт']],
  ['Зарплата', ['salary', 'rate', 'pay', 'оклад', 'ставка']],
  ['Комментарий', ['comment', 'notes', 'note', 'комментарий', 'заметка']]
];

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function formatLabel(key) {
  const raw = String(key || '').trim();

  if (!raw) {
    return 'Поле';
  }

  if (/[А-Яа-яЁё]/.test(raw)) {
    return raw;
  }

  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined) {
    return '—';
  }

  if (Array.isArray(value)) {
    return value.length ? value.map(formatValue).join(', ') : '—';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '—';
    }
  }

  const text = String(value).trim();
  return text || '—';
}

function getPriorityScore(key) {
  const normalized = normalizeKey(key);

  for (let index = 0; index < PRIORITY_MATCHES.length; index += 1) {
    const [, aliases] = PRIORITY_MATCHES[index];
    if (aliases.some((alias) => normalized.includes(alias))) {
      return index;
    }
  }

  return PRIORITY_MATCHES.length + 1;
}

export default function RecordDetails({ record = {}, exclude = [] }) {
  const excluded = new Set(exclude.map((item) => normalizeKey(item)));

  const entries = Object.entries(record)
    .filter(([key, value]) => {
      if (key.startsWith('_')) return false;
      if (excluded.has(normalizeKey(key))) return false;
      return String(value ?? '').trim().length > 0;
    })
    .sort((left, right) => {
      const priorityDelta = getPriorityScore(left[0]) - getPriorityScore(right[0]);
      if (priorityDelta !== 0) return priorityDelta;
      return formatLabel(left[0]).localeCompare(formatLabel(right[0]), 'ru');
    });

  if (!entries.length) {
    return <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-app-muted">Нет заполненных полей.</div>;
  }

  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="rounded-2xl border border-white/10 bg-slate-950/35 p-3 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]"
        >
          <dt className="text-[11px] font-semibold uppercase tracking-[0.24em] text-app-muted">
            {formatLabel(key)}
          </dt>
          <dd className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-app-text/95">
            {formatValue(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}