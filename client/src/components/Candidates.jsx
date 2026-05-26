import { useMemo, useState } from 'react';
import SheetTable from './SheetTable.jsx';
import RecordDetails from './RecordDetails.jsx';
import { getRecordSubtitle, getRecordTitle, hasAnyField, pickFirstField } from './recordHelpers.js';

const REFERRER_FIELDS = [
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

export default function Candidates({ rows = [] }) {
  const [search, setSearch] = useState('');
  const [onlyReferrals, setOnlyReferrals] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return rows.filter((candidate) => {
      const textMatch = !q || Object.values(candidate).some((value) => String(value || '').toLowerCase().includes(q));

      if (!textMatch) return false;

      if (!onlyReferrals) return true;

      return hasAnyField(candidate, REFERRER_FIELDS);
    });
  }, [rows, search, onlyReferrals]);

  const columns = [
    { key: 'name', label: 'Имя', render: (row, index) => getRecordTitle(row, `Кандидат ${index + 1}`), cellClassName: 'font-semibold text-white' },
    { key: 'telegram', label: 'Telegram', render: (row) => row.telegram || row.tg || row.username || '—' },
    { key: 'phone', label: 'Телефон', render: (row) => row.phone || row['Телефон'] || '—' },
    { key: 'city', label: 'Город', render: (row) => row.city || row['Город'] || '—' },
    { key: 'status', label: 'Статус', render: (row) => pickFirstField(row, ['status', 'Статус']) || '—' },
    { key: 'referrer', label: 'Реферер', render: (row) => pickFirstField(row, REFERRER_FIELDS) || '—' }
  ];

  return (
    <section className="space-y-4">
      <div className="rounded-xl bg-app-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по имени, Telegram, телефону и любому полю"
            className="w-full rounded-lg border border-slate-700 bg-app-soft px-3 py-2 text-sm outline-none ring-app-accent focus:ring-2"
          />
          <label className="flex items-center gap-2 text-sm text-app-muted">
            <input
              type="checkbox"
              checked={onlyReferrals}
              onChange={(e) => setOnlyReferrals(e.target.checked)}
              className="h-4 w-4"
            />
            Только с реферером
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-white/10 bg-app-card/70 px-4 py-3 text-sm text-app-muted backdrop-blur-xl">
        <span>Показано {filtered.length} из {rows.length}</span>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.2em] text-app-muted">
          Sheet view · все поля внутри строки
        </span>
      </div>

      <SheetTable
        rows={filtered}
        columns={columns}
        emptyText="Кандидаты не найдены."
        getRowKey={(row, index) => `${getRecordTitle(row, `candidate-${index}`)}-${index}`}
        getRowTitle={(row, index) => getRecordTitle(row, `Кандидат ${index + 1}`)}
        getRowSubtitle={(row) => getRecordSubtitle(row)}
        getRowBadge={(row) => (
          <span className={`rounded-full border px-2 py-1 text-xs ${hasAnyField(row, REFERRER_FIELDS) ? 'bg-app-success/20 text-emerald-300 border-emerald-500/40' : 'bg-app-warning/20 text-amber-300 border-amber-500/40'}`}>
            {hasAnyField(row, REFERRER_FIELDS) ? 'Есть реферер' : 'Без реферера'}
          </span>
        )}
        renderExpanded={(candidate) => <RecordDetails record={candidate} />}
      />
    </section>
  );
}
