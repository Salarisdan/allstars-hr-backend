import { Fragment, useMemo, useState } from 'react';

function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '—';
    }
  }

  const text = String(value).trim();
  return text || '—';
}

export default function SheetTable({
  rows = [],
  columns = [],
  getRowKey,
  getRowTitle,
  getRowSubtitle,
  getRowTone,
  getRowBadge,
  renderExpanded,
  emptyText = 'Нет данных'
}) {
  const [expandedIndex, setExpandedIndex] = useState(null);

  const visibleColumns = useMemo(() => columns.filter(Boolean), [columns]);

  if (!rows.length) {
    return (
      <div className="rounded-[1.5rem] border border-white/10 bg-app-card p-6 text-app-muted backdrop-blur-xl">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(16,24,42,0.92),rgba(8,12,24,0.95))] shadow-[0_30px_100px_rgba(2,6,23,0.34)] backdrop-blur-xl">
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[rgba(13,19,35,0.98)] text-[11px] uppercase tracking-[0.24em] text-app-muted">
              <th className="w-14 border-b border-white/10 px-4 py-4 text-left">#</th>
              {visibleColumns.map((column) => (
                <th
                  key={column.key}
                  className={`border-b border-white/10 px-4 py-4 text-left ${column.width || ''}`.trim()}
                >
                  {column.label}
                </th>
              ))}
              <th className="w-28 border-b border-white/10 px-4 py-4 text-left">Детали</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const expanded = expandedIndex === rowIndex;
              const tone = getRowTone ? getRowTone(row, rowIndex) : '';
              const title = getRowTitle ? getRowTitle(row, rowIndex) : '';
              const subtitle = getRowSubtitle ? getRowSubtitle(row, rowIndex) : '';
              const badge = getRowBadge ? getRowBadge(row, rowIndex) : null;
              const rowKey = getRowKey ? getRowKey(row, rowIndex) : rowIndex;

              return (
                <Fragment key={rowKey}>
                  <tr
                    className={`group ${tone || ''} bg-white/[0.015] transition hover:bg-white/[0.05]`}
                  >
                    <td className="border-b border-white/8 px-4 py-4 align-top text-sm text-app-muted">
                      {String(rowIndex + 1).padStart(2, '0')}
                    </td>
                    {visibleColumns.map((column) => (
                      <td
                        key={column.key}
                        className={`border-b border-white/8 px-4 py-4 align-top text-sm text-app-text/95 ${column.cellClassName || ''}`.trim()}
                      >
                        <div className={column.wrap ? 'whitespace-pre-wrap break-words' : 'truncate'}>
                          {column.render ? column.render(row, rowIndex) : formatCell(row[column.key])}
                        </div>
                      </td>
                    ))}
                    <td className="border-b border-white/8 px-4 py-4 align-top">
                      <button
                        type="button"
                        onClick={() => setExpandedIndex(expanded ? null : rowIndex)}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-app-text transition hover:bg-white/10"
                      >
                        {expanded ? 'Скрыть' : 'Открыть'}
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td className="border-b border-white/8 bg-slate-950/30 px-4 py-4" colSpan={visibleColumns.length + 2}>
                        <div className="flex flex-col gap-4 rounded-[1.5rem] border border-white/10 bg-[rgba(255,255,255,0.03)] p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-base font-semibold text-app-text">{title}</div>
                              {subtitle ? <div className="mt-1 text-sm text-app-muted">{subtitle}</div> : null}
                            </div>
                            {badge ? <div>{badge}</div> : null}
                          </div>
                          {renderExpanded ? renderExpanded(row, rowIndex) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}