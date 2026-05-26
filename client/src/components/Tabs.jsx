const TABS = [
  { key: 'active', label: 'Действующие' },
  { key: 'referrals', label: 'Рефералы' },
  { key: 'candidates', label: 'Кандидаты' }
];

export default function Tabs({ activeTab, onChange }) {
  return (
    <div className="mb-6 flex flex-wrap gap-2 rounded-xl bg-app-card p-2">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
            activeTab === tab.key
              ? 'bg-app-accent text-white'
              : 'bg-app-soft text-app-muted hover:text-app-text'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
