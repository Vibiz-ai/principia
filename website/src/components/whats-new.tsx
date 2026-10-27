import { Smartphone, Plug, Activity, BellRing, Repeat, BookOpen, ShieldCheck, type LucideIcon } from 'lucide-react'

// What shipped recently (merged into the app). Plain claims only: each line is something the current build does.
type Item = { tag: string; title: string; body: string; icon: LucideIcon; note?: string; wide?: boolean; visual?: 'phone' | 'grid' | 'sounds' }

const items: Item[] = [
  {
    tag: 'I · PHONE', title: 'Your company, from your phone.', icon: Smartphone, wide: true, visual: 'phone',
    body: 'Live chats with your agents and terminal sessions. Reply, pick a finished Claude Code session back up, allow or deny what an agent asks, and check the tasks board. Pair once with a QR code: the phone reaches your Mac through an outbound tunnel only paired phones can use, and everything stays on the Mac.',
    note: 'Phone web app today · iPhone app coming soon to TestFlight',
  },
  {
    tag: 'II · CONNECTIONS', title: 'Connect once. Used everywhere.', icon: Plug,
    body: 'One connection per service: an API key, a sign-in or an MCP server. Dashboards, agents, Knowledge and Autopilot all see it connected, and anywhere it is missing offers Connect right there. Keys never leave your Mac.',
  },
  {
    tag: 'III · TOKENS', title: 'Every token, one grid.', icon: Activity, visual: 'grid',
    body: 'Token activity counts every token across Claude Code, Codex and Principia’s own agents, once each, in a year-long activity grid with your streaks and peak day.',
  },
  {
    tag: 'IV · SOUNDS', title: 'Sounds only for what matters.', icon: BellRing, visual: 'sounds',
    body: 'Three short sounds: Done, Needs you, Problem. Quiet for routine work, and never for the thing you are already looking at.',
  },
  {
    tag: 'V · AUTOPILOT', title: 'Work that moves on its own.', icon: Repeat,
    body: 'Turn on Autopilot and agents pick up the next task by themselves, as many at once as you allow. Ready-made routines like a morning brief or a weekly review, and a chief of staff that suggests what to do next. One switch pauses every agent.',
  },
  {
    tag: 'VI · MEMORY', title: 'A company that remembers.', icon: BookOpen, wide: true,
    body: 'Agents share your company’s memory: its decisions, conventions and house style, and what your people like and dislike, with every saved fact open to review and edit. Open Passport, to carry that memory into other AI apps, is in research.',
  },
  {
    tag: 'VII · OPEN SOURCE', title: 'Built in the open. Built carefully.', icon: ShieldCheck,
    body: 'MIT licensed. Pinned, linted CI, checksums with every download, build-provenance attestations for signed releases, and an OpenSSF Scorecard.',
  },
]

// a quiet year of dots, brighter where the work was: white on black, deterministic (no random per render)
function DotGrid() {
  const cols = 26, rows = 7
  const level = (c: number, r: number) => { const v = Math.sin(c * 1.7 + r * 2.3) * Math.cos(c * .45 - r) + c / cols; return v > 1.05 ? 4 : v > .7 ? 3 : v > .35 ? 2 : v > 0 ? 1 : 0 }
  const alpha = ['.06', '.18', '.34', '.58', '.9']
  return <svg viewBox={`0 0 ${cols * 9} ${rows * 9}`} className="mt-6 h-auto w-full" aria-hidden="true">{Array.from({ length: cols * rows }, (_, i) => { const c = Math.floor(i / rows), r = i % rows; return <circle key={i} cx={c * 9 + 4.5} cy={r * 9 + 4.5} r={3.1} fill="#edf1f2" fillOpacity={alpha[level(c, r)]}/> })}</svg>
}

function Sounds() {
  return <div className="mt-6 flex flex-wrap gap-1.5" aria-hidden="true">{['Done', 'Needs you', 'Problem'].map(s => <span key={s} className="rounded-lg border border-white/[.12] px-3 py-1.5 text-[12px] text-soft">{s}</span>)}</div>
}

// a line-art phone with a chat: strokes only, like the engravings
function PhoneSketch() {
  return <svg viewBox="0 0 120 210" className="hidden h-[210px] w-auto shrink-0 sm:block" fill="none" stroke="#edf1f2" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
    <rect x="6" y="4" width="108" height="202" rx="20" strokeOpacity=".7"/>
    <rect x="44" y="12" width="32" height="8" rx="4" strokeOpacity=".35"/>
    <rect x="18" y="36" width="62" height="20" rx="8" strokeOpacity=".45"/>
    <rect x="40" y="64" width="62" height="14" rx="7" strokeOpacity=".7"/>
    <rect x="18" y="86" width="74" height="30" rx="8" strokeOpacity=".45"/>
    <rect x="18" y="124" width="84" height="34" rx="9" strokeOpacity=".8"/>
    <path d="M27 136h40M27 146h24" strokeOpacity=".5"/>
    <rect x="66" y="141" width="28" height="11" rx="5.5" strokeOpacity=".9"/>
    <rect x="18" y="178" width="84" height="16" rx="8" strokeOpacity=".35"/>
  </svg>
}

export function WhatsNew() {
  return <section className="shell section-space" id="whats-new">
    <div className="mb-12 text-center"><span className="pill">What’s new</span><h2 className="section-title mt-[18px]">New in Principia.</h2><p className="mx-auto mt-5 max-w-[540px] text-[15px] leading-relaxed text-muted">What we shipped lately, all in the desktop preview you can download today.</p></div>
    <div className="grid gap-1.5 md:grid-cols-2 lg:grid-cols-3">
      {items.map(({ tag, title, body, icon: Icon, note, wide, visual }) => <article key={tag} className={`flex min-w-0 flex-col rounded-[18px] bg-panel p-6 sm:p-7 ${wide ? 'lg:col-span-2' : ''}`}>
        <div className="flex items-center justify-between gap-4"><span className="roman-tag text-[10px] text-muted">{tag}</span><Icon size={20} strokeWidth={1.3} aria-hidden="true" className="text-soft"/></div>
        <div className={visual === 'phone' ? 'flex items-end gap-8' : ''}>
          <div className="min-w-0 flex-1">
            <h3 className="mt-6 font-serif text-[25px] leading-[1.2] tracking-[-.02em]">{title}</h3>
            <p className="mt-3 max-w-[560px] text-[13.5px] leading-relaxed text-muted">{body}</p>
            {note && <p className="mt-5 inline-flex rounded-md border border-white/10 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-soft">{note}</p>}
          </div>
          {visual === 'phone' && <PhoneSketch/>}
        </div>
        {visual === 'grid' && <DotGrid/>}
        {visual === 'sounds' && <Sounds/>}
      </article>)}
    </div>
  </section>
}
