import { useMemo, useState } from 'react';
import Card from './Card.jsx';

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

      {!filtered.length ? (
        <div className="rounded-xl bg-app-card p-6 text-app-muted">Кандидаты не найдены.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((candidate, index) => {
            const title =
              candidate.name ||
              candidate['Имя'] ||
              candidate['ФИО'] ||
              candidate.full_name ||
              `Кандидат ${index + 1}`;

            const subtitle = candidate.telegram || candidate.tg || candidate.username || candidate.phone || '';

            return (
              <Card key={`${title}-${index}`} title={title} subtitle={subtitle}>
                {Object.entries(candidate)
                  .filter(([, value]) => String(value || '').trim())
                  .slice(0, 10)
                  .map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-3 border-b border-slate-700/40 pb-1">
                      <span className="text-app-muted">{key}</span>
                      <span className="max-w-[55%] truncate text-right">{String(value || '-')}</span>
                    </div>
                  ))}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
