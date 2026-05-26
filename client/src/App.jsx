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
    <div className="rounded-[1.5rem] border border-white/10 bg-[linear-gradient(180deg,rgba(18,26,46,0.92),rgba(9,13,28,0.9))] p-4 shadow-[0_20px_60px_rgba(2,6,23,0.24)]">
      <div className="text-[11px] uppercase tracking-[0.24em] text-app-muted">{title}</div>
      <div className={`mt-2 text-3xl font-semibold tracking-tight ${accent}`}>{value}</div>
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
    <main className="relative min-h-screen overflow-hidden px-4 py-6 md:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(31,142,241,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(23,178,106,0.16),transparent_26%),radial-gradient(circle_at_50%_120%,rgba(124,58,237,0.18),transparent_32%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:72px_72px]" />

      <div className="relative mx-auto flex max-w-7xl flex-col gap-6">
        <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(9,13,28,0.92),rgba(12,18,36,0.86))] p-6 shadow-[0_30px_120px_rgba(2,6,23,0.45)] backdrop-blur-xl md:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.28em] text-app-muted">
                Live sync · Google Sheets · auto refresh 60s
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-app-text md:text-5xl">
                AllStars Internal CRM
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-app-muted md:text-base">
                Единая панель для кандидатов, действующих сотрудников и реферальной логики с живой синхронизацией из таблиц.
              </p>
            </div>
            <button
              type="button"
              onClick={loadAll}
              className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-r from-app-accent to-cyan-400 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-app-accent/20 transition hover:scale-[1.01] hover:shadow-app-accent/30"
            >
              Обновить данные
            </button>
          </div>

          <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard title="Кандидаты" value={counters.totalCandidates} />
            <StatCard title="Действующие" value={counters.totalActive} accent="text-emerald-300" />
            <StatCard title="Рефералы" value={counters.totalReferrals} accent="text-sky-300" />
            <StatCard title="Готовы к выплате" value={counters.payoutReadyCount} accent="text-amber-300" />
          </section>
        </section>

        <Tabs activeTab={activeTab} onChange={setActiveTab} />

        {loading ? (
          <div className="rounded-[1.5rem] border border-white/10 bg-app-card/80 p-6 text-app-muted backdrop-blur-xl">
            Загрузка данных...
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-[1.5rem] border border-red-500/30 bg-red-500/10 p-4 text-red-200 backdrop-blur-xl">
            {error}
          </div>
        ) : null}

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
