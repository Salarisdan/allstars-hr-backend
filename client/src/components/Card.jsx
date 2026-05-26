export default function Card({ title, subtitle, children, rightSlot }) {
  return (
    <article className="group relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(18,26,46,0.96),rgba(9,13,28,0.94))] p-5 shadow-[0_24px_80px_rgba(2,6,23,0.35)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-1 hover:border-white/20">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold tracking-tight text-app-text">{title || 'Без имени'}</h3>
          {subtitle ? <p className="mt-1 truncate text-sm text-app-muted">{subtitle}</p> : null}
        </div>
        {rightSlot ? <div className="flex-none">{rightSlot}</div> : null}
      </header>
      <div className="space-y-3 text-sm text-app-text/90">{children}</div>
    </article>
  );
}
