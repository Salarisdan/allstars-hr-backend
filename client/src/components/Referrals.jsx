import Card from './Card.jsx';
import RecordDetails from './RecordDetails.jsx';
import { formatDateTime, relativeFromNow, clampPercent } from '../utils/date.js';

function timerTone(row) {
  if (!row.isWorking) return 'bg-app-warning/20 text-amber-300 border-amber-500/40';
  if (row.payoutReady) return 'bg-app-success/20 text-emerald-300 border-emerald-500/40';
  return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
}

export default function Referrals({ rows = [] }) {
  if (!rows.length) {
    return <div className="rounded-xl bg-app-card p-6 text-app-muted">Реферальных карточек пока нет.</div>;
  }

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {rows.map((row, index) => {
        const candidate = row.candidate || {};
        const title = candidate.name || candidate['Имя'] || candidate.full_name || `Реферал ${index + 1}`;
        const subtitle = candidate.telegram || candidate.tg || candidate.username || '';
        const progress = clampPercent(row.progressPercent);

        return (
          <Card
            key={`${title}-${index}`}
            title={title}
            subtitle={subtitle}
            rightSlot={
              <span className={`rounded-full border px-2 py-1 text-xs ${timerTone(row)}`}>
                {row.timerStatus}
              </span>
            }
          >
            <div className="flex justify-between gap-2 border-b border-slate-700/40 pb-1">
              <span className="text-app-muted">От кого</span>
              <span>@{row.referrerUsername || '-'}</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-slate-700/40 pb-1">
              <span className="text-app-muted">Статус</span>
              <span>{row.workingStatus || 'не работает'}</span>
            </div>

            {row.isWorking ? (
              <>
                <div className="flex justify-between gap-2 border-b border-slate-700/40 pb-1">
                  <span className="text-app-muted">Старт таймера</span>
                  <span>{formatDateTime(row.timerStartDate)}</span>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-700/40 pb-1">
                  <span className="text-app-muted">Прошло</span>
                  <span>{row.daysPassed} дн.</span>
                </div>
                <div className="flex justify-between gap-2 border-b border-slate-700/40 pb-1">
                  <span className="text-app-muted">Осталось</span>
                  <span>{row.daysLeft} дн.</span>
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-xs text-app-muted">
                    <span>Прогресс 30 дней</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-app-soft">
                    <div
                      className="h-full rounded-full bg-app-accent transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
                <div className="text-xs text-app-muted">Обновлено: {relativeFromNow(row.timerStartDate)}</div>
              </>
            ) : (
              <div className="text-sm text-app-muted">Ожидает выхода / не работает</div>
            )}

            <div className="pt-1">
              <RecordDetails record={row} exclude={["candidate"]} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
