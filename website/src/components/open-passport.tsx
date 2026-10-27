import { Building2, Route, FileCode2 } from 'lucide-react'

// The section links nowhere until Open Passport has its own public page (it is in research): no placeholder URL.

const apps = ['ChatGPT', 'Claude', 'Cursor', 'VS Code', 'Codex', 'Any MCP client']

const tiers = [
  { tier: 'L0', name: 'Company card', tokens: '~300 tokens', width: '22%', note: 'Always loaded' },
  { tier: 'L1', name: 'Department slot', tokens: '~600 tokens', width: '44%', note: 'Loaded for the task' },
  { tier: 'L2', name: 'Everything else', tokens: 'on demand', width: '100%', note: 'Searched when needed' },
]

const points = [
  { title: 'Every company has one.', body: 'Each Principia company keeps a Passport: who it is, its departments and people, what it decided, and its taste: what its people like and dislike.', icon: Building2 },
  { title: 'It travels with you.', body: 'Connect the same Passport to ChatGPT, Claude, Cursor and other AI apps. Each app sees only the scopes you grant, and its writes arrive as proposals for you to review.', icon: Route },
  { title: 'An open standard.', body: 'Open Passport is an open spec: plain markdown notes plus a manifest. Keep it local or self-host it; a hosted service is coming soon. No lock-in.', icon: FileCode2 },
]

export function OpenPassport() {
  return <section className="shell section-space" id="open-passport">
    <div className="grid items-end gap-8 md:grid-cols-2">
      <div><span className="pill">Open Passport</span><h2 className="section-title mt-[18px]">One memory.<br/>Every AI you use.</h2></div>
      <div className="max-w-[490px] space-y-4 text-[15px] leading-[1.75] text-muted"><p>Your company’s Passport follows the Open Passport standard, so the context Principia builds is not trapped in Principia. Bring it into the chat apps and editors your team already works in.</p><p>It is built not to waste tokens: a small company card and one department slot load up front. The rest is searched only when the work needs it.</p></div>
    </div>
    <div className="mt-14 grid gap-1.5 md:grid-cols-[1.15fr_.85fr]">
      <div className="min-w-0 rounded-[18px] border border-white/[.07] bg-[#101416] p-6 sm:p-8" aria-label="Open Passport memory tiers">
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-white/10 pb-5"><span className="display text-[22px]">What an agent loads</span><span className="font-mono text-[9px] tracking-[.16em] text-muted">TOKEN BUDGET</span></div>
        <div className="space-y-6">{tiers.map(t => <div key={t.tier}>
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><span className="flex items-baseline gap-3"><span className="font-mono text-[11px] tracking-[.12em] text-soft">{t.tier}</span><span className="text-sm text-soft">{t.name}</span></span><span className="font-mono text-[11px] text-muted">{t.tokens}</span></div>
          <div className="relative h-[10px] rounded-full border border-white/[.09]"><div className={`absolute inset-y-[-1px] left-[-1px] rounded-full border ${t.tier === 'L2' ? 'border-dashed border-white/25' : 'border-white/60 bg-white/[.06]'}`} style={{ width: t.width }}/></div>
          <p className="mt-2 text-[12px] text-muted">{t.note}</p>
        </div>)}</div>
        <div className="mt-8 border-t border-white/10 pt-5"><p className="font-mono text-[10px] tracking-[.12em] text-muted">CONNECTS TO</p><div className="mt-3.5 flex flex-wrap gap-1.5">{apps.map(a => <span key={a} className="rounded-lg border border-white/[.12] px-3 py-1.5 text-[12.5px] text-soft">{a}</span>)}</div></div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">{points.map(({ title, body, icon: Icon }) => <article key={title} className="flex-1 rounded-[18px] bg-panel p-6"><Icon size={20} strokeWidth={1.3} aria-hidden="true" className="mb-5 text-soft"/><h3 className="font-serif text-[23px] leading-[1.2] tracking-[-.02em]">{title}</h3><p className="mt-2 text-[13.5px] leading-relaxed text-muted">{body}</p></article>)}</div>
    </div>
    <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3"><span className="rounded-md border border-white/15 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-soft">IN RESEARCH · COMING SOON</span><span className="text-xs text-muted">Open spec · local or self-hosted, hosted soon · plain markdown you own</span></div>
  </section>
}
