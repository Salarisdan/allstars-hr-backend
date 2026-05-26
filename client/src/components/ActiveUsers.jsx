import Card from './Card.jsx';

function statusBadge(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'работает') {
    return 'bg-app-success/20 text-emerald-300 border-emerald-500/40';
  }

  return 'bg-app-warning/20 text-amber-300 border-amber-500/40';
}

export default function ActiveUsers({ rows = [] }) {
  if (!rows.length) {
    return <div className="rounded-xl bg-app-card p-6 text-app-muted">Нет данных по действующим.</div>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((user, index) => {
        const name = user['Имя'] || user.name || user.full_name || `Сотрудник ${index + 1}`;
        const status = user._workingStatus || user.status || user['Статус'] || 'Не указан';

        return (
          <Card
            key={`${name}-${index}`}
            title={name}
            subtitle={user.telegram || user.tg || user.username || user.phone || ''}
            rightSlot={
              <span className={`rounded-full border px-2 py-1 text-xs ${statusBadge(status)}`}>
                {status}
              </span>
            }
          >
            {Object.entries(user)
              .filter(([key]) => !key.startsWith('_'))
              .slice(0, 6)
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
  );
}
