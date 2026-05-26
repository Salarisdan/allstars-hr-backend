export default function Card({ title, subtitle, children, rightSlot }) {
  return (
    <article className="rounded-2xl border border-slate-700/50 bg-app-card p-4 shadow-lg shadow-black/20">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-app-text">{title || 'Без имени'}</h3>
          {subtitle ? <p className="mt-1 text-xs text-app-muted">{subtitle}</p> : null}
        </div>
        {rightSlot}
      </header>
      <div className="space-y-2 text-sm text-app-text/90">{children}</div>
    </article>
  );
}
