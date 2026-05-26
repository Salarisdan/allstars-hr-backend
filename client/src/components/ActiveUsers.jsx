import SheetTable from './SheetTable.jsx';
import RecordDetails from './RecordDetails.jsx';
import { getRecordSubtitle, getRecordTitle, pickFirstField } from './recordHelpers.js';

function statusBadge(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'работает') {
    return 'bg-app-success/20 text-emerald-300 border-emerald-500/40';
  }

  return 'bg-app-warning/20 text-amber-300 border-amber-500/40';
}

export default function ActiveUsers({ rows = [] }) {
  if (!rows.length) {
    return <div className="rounded-[1.5rem] border border-white/10 bg-app-card p-6 text-app-muted">Нет данных по действующим.</div>;
  }

  const columns = [
    { key: 'name', label: 'Имя', render: (row, index) => getRecordTitle(row, `Сотрудник ${index + 1}`), cellClassName: 'font-semibold text-white' },
    { key: 'telegram', label: 'Telegram', render: (row) => row.telegram || row.tg || row.username || '—' },
    { key: 'phone', label: 'Телефон', render: (row) => row.phone || row['Телефон'] || '—' },
    { key: 'status', label: 'Статус', render: (row) => pickFirstField(row, ['status', 'Статус', '_workingStatus']) || '—' },
    { key: 'city', label: 'Город', render: (row) => row.city || row['Город'] || '—' },
    { key: 'notes', label: 'Заметки', render: (row) => row.notes || row['Заметки'] || '—' }
  ];

  return (
    <SheetTable
      rows={rows}
      columns={columns}
      emptyText="Нет данных по действующим."
      getRowKey={(row, index) => `${getRecordTitle(row, `employee-${index}`)}-${index}`}
      getRowTitle={(row, index) => getRecordTitle(row, `Сотрудник ${index + 1}`)}
      getRowSubtitle={(row) => getRecordSubtitle(row)}
      getRowBadge={(row) => (
        <span className={`rounded-full border px-2 py-1 text-xs ${statusBadge(row._workingStatus || row.status || row['Статус'] || 'Не указан')}`}>
          {row._workingStatus || row.status || row['Статус'] || 'Не указан'}
        </span>
      )}
      renderExpanded={(user) => <RecordDetails record={user} />}
    />
  );
}
