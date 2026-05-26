import SheetTable from './SheetTable.jsx';
import RecordDetails from './RecordDetails.jsx';
import { getRecordSubtitle, getRecordTitle, pickFirstField } from './recordHelpers.js';
import { formatDateTime, relativeFromNow, clampPercent } from '../utils/date.js';

function timerTone(row) {
  if (!row.isWorking) return 'bg-app-warning/20 text-amber-300 border-amber-500/40';
  if (row.payoutReady) return 'bg-app-success/20 text-emerald-300 border-emerald-500/40';
  return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
}

export default function Referrals({ rows = [] }) {
  if (!rows.length) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-app-card p-6 text-app-muted">Реферальных карточек пока нет.</div>;
  }

  const columns = [
    { key: 'name', label: 'Имя', render: (row, index) => getRecordTitle(row.candidate || {}, `Реферал ${index + 1}`), cellClassName: 'font-semibold text-white' },
    { key: 'telegram', label: 'Telegram', render: (row) => getRecordSubtitle(row.candidate || {}) || '—' },
    { key: 'referrer', label: 'От кого', render: (row) => `@${row.referrerUsername || '-'}` },
    { key: 'status', label: 'Статус', render: (row) => row.workingStatus || 'не работает' },
    { key: 'timer', label: 'Таймер', render: (row) => row.timerStatus },
    { key: 'progress', label: 'Прогресс', render: (row) => `${clampPercent(row.progressPercent)}%` }
  ];

  return (
    <SheetTable
      rows={rows}
      columns={columns}
      emptyText="Реферальных карточек пока нет."
      getRowKey={(row, index) => `${getRecordTitle(row.candidate || {}, `referral-${index}`)}-${index}`}
      getRowTitle={(row, index) => getRecordTitle(row.candidate || {}, `Реферал ${index + 1}`)}
      getRowSubtitle={(row) => getRecordSubtitle(row.candidate || {})}
      getRowTone={(row) => (row.isWorking ? 'bg-emerald-500/5' : 'bg-amber-500/5')}
      getRowBadge={(row) => (
        <span className={`rounded-full border px-2 py-1 text-xs ${timerTone(row)}`}>
          {row.timerStatus}
        </span>
      )}
      renderExpanded={(row) => (
        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
                <div className="text-[11px] uppercase tracking-[0.24em] text-app-muted">От кого</div>
                <div className="mt-2 text-sm text-app-text">@{row.referrerUsername || '-'}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
                <div className="text-[11px] uppercase tracking-[0.24em] text-app-muted">Статус</div>
                <div className="mt-2 text-sm text-app-text">{row.workingStatus || 'не работает'}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
                <div className="text-[11px] uppercase tracking-[0.24em] text-app-muted">Старт таймера</div>
                <div className="mt-2 text-sm text-app-text">{formatDateTime(row.timerStartDate)}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
                <div className="text-[11px] uppercase tracking-[0.24em] text-app-muted">Осталось</div>
                <div className="mt-2 text-sm text-app-text">{row.daysLeft} дн.</div>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs text-app-muted">
                <span>Прогресс 30 дней</span>
                <span>{clampPercent(row.progressPercent)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-app-soft">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-app-accent via-cyan-400 to-emerald-400 transition-all"
                  style={{ width: `${clampPercent(row.progressPercent)}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-app-muted">Обновлено: {relativeFromNow(row.timerStartDate)}</div>
            </div>
          </div>
          <RecordDetails record={row} exclude={["candidate"]} />
        </div>
      )}
    />
  );
}
