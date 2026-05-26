import { useCallback, useEffect, useMemo, useState } from 'react';
import Tabs from './components/Tabs.jsx';
import ActiveUsers from './components/ActiveUsers.jsx';
import Candidates from './components/Candidates.jsx';
import Referrals from './components/Referrals.jsx';

const REFRESH_MS = 60_000;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function StatCard({ title, value, accent = 'text-app-text' }) {
  return (
    <div className="rounded-xl border border-slate-700/40 bg-app-card p-4">
      <div className="text-xs uppercase tracking-wide text-app-muted">{title}</div>
      <div className={`mt-2 text-2xl font-semibold ${accent}`}>{value}</div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [dashboard, setDashboard] = useState(null);
  const [activeUsers, setActiveUsers] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [referrals, setReferrals] = useState([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [dashboardData, activeData, candidatesData, referralsData] = await Promise.all([
        fetchJson('/api/dashboard'),
        fetchJson('/api/active'),
        fetchJson('/api/candidates'),
        fetchJson('/api/referrals')
      ]);

      setDashboard(dashboardData);
      setActiveUsers(activeData);
      setCandidates(candidatesData);
      setReferrals(referralsData);
    } catch (err) {
      setError(err.message || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const timer = setInterval(loadAll, REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadAll]);

  const counters = useMemo(() => {
    return {
      totalCandidates: dashboard?.totalCandidates ?? candidates.length,
      totalActive: dashboard?.totalActive ?? activeUsers.length,
      totalReferrals: dashboard?.totalReferrals ?? referrals.length,
      payoutReadyCount: dashboard?.payoutReadyCount ?? referrals.filter((row) => row.payoutReady).length
    };
  }, [dashboard, candidates.length, activeUsers.length, referrals]);

  return (
    <main className="min-h-screen px-4 py-6 md:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-app-text md:text-3xl">AllStars Internal CRM</h1>
            <p className="mt-1 text-sm text-app-muted">Google Sheets synchronized internal dashboard</p>
          </div>
          <button
            type="button"
            onClick={loadAll}
            className="rounded-lg bg-app-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Обновить данные
          </button>
        </header>

        <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Кандидаты" value={counters.totalCandidates} />
          <StatCard title="Действующие" value={counters.totalActive} accent="text-emerald-300" />
          <StatCard title="Рефералы" value={counters.totalReferrals} accent="text-sky-300" />
          <StatCard title="Готовы к выплате" value={counters.payoutReadyCount} accent="text-amber-300" />
        </section>

        <Tabs activeTab={activeTab} onChange={setActiveTab} />

        {loading ? <div className="rounded-xl bg-app-card p-6 text-app-muted">Загрузка данных...</div> : null}
        {error ? <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-200">{error}</div> : null}

        {!loading && !error ? (
          <>
            {activeTab === 'active' ? <ActiveUsers rows={activeUsers} /> : null}
            {activeTab === 'candidates' ? <Candidates rows={candidates} /> : null}
            {activeTab === 'referrals' ? <Referrals rows={referrals} /> : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
