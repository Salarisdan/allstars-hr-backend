import { useMemo, useState } from 'react';
import Card from './Card.jsx';
import RecordDetails from './RecordDetails.jsx';

function getCandidateTitle(candidate, index) {
  return (
    candidate.name ||
    candidate['Имя'] ||
    candidate['ФИО'] ||
    candidate.full_name ||
    candidate.fullName ||
    candidate.username ||
    `Кандидат ${index + 1}`
  );
}

function getCandidateSubtitle(candidate) {
  return candidate.telegram || candidate.tg || candidate.username || candidate.phone || candidate['Телефон'] || '';
}

function hasReferrer(candidate) {
  const refFields = [
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

  return refFields.some((field) => String(candidate[field] || '').trim());
}

export default function Candidates({ rows = [] }) {
  const [search, setSearch] = useState('');
  const [onlyReferrals, setOnlyReferrals] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return rows.filter((candidate) => {
      const textMatch = !q || Object.values(candidate).some((value) => String(value || '').toLowerCase().includes(q));

      if (!textMatch) return false;

      if (!onlyReferrals) return true;

      const refFields = [
        'referral', 'referal', 'ref', 'referrer', 'referred_by', 'invited_by',
        'кто пригласил', 'от кого', 'реферал', 'реферер', 'telegram ref', 'username ref'
      ];

      return refFields.some((field) => String(candidate[field] || '').trim());
    });
  }, [rows, search, onlyReferrals]);

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
          Все поля отображаются в карточке
        </span>
      </div>

      {!filtered.length ? (
        <div className="rounded-[1.5rem] border border-white/10 bg-app-card p-6 text-app-muted">Кандидаты не найдены.</div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {filtered.map((candidate, index) => {
            const title = getCandidateTitle(candidate, index);
            const subtitle = getCandidateSubtitle(candidate);
            const referrerLabel = hasReferrer(candidate) ? 'Есть реферер' : 'Без реферера';

            return (
              <Card key={`${title}-${index}`} title={title} subtitle={subtitle}>
                <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.24em] text-app-muted">
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Кандидат</span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{referrerLabel}</span>
                  {subtitle ? <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{subtitle}</span> : null}
                </div>
                <RecordDetails record={candidate} />
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
