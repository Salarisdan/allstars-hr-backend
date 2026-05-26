const TABS = [
  { key: 'active', label: 'Действующие' },
  { key: 'referrals', label: 'Рефералы' },
  { key: 'candidates', label: 'Кандидаты' }
];

export default function Tabs({ activeTab, onChange }) {
  return (
    <div className="mb-6 flex flex-wrap gap-2 rounded-[1.5rem] border border-white/10 bg-[rgba(18,26,46,0.7)] p-2 backdrop-blur-xl">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition-all duration-200 ${
            activeTab === tab.key
              ? 'bg-gradient-to-r from-app-accent to-cyan-400 text-white shadow-lg shadow-app-accent/20'
              : 'bg-white/5 text-app-muted hover:bg-white/10 hover:text-app-text'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
