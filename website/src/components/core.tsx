import { MessagesSquare, KanbanSquare, Smartphone, BookOpen, LayoutDashboard, GitBranch, TerminalSquare, Globe, Network, type LucideIcon } from 'lucide-react'

// What Principia is, in the order a company meets it. Plain claims only: each line is something the current build does.
type Item = { tag: string; title: string; body: string; icon: LucideIcon; note?: string; wide?: boolean; visual?: 'phone' | 'harnesses' | 'branches' | 'browser' }

const items: Item[] = [
  {
    tag: 'I · COMMUNICATION', title: 'Talk to your company.', icon: MessagesSquare, wide: true,
    body: 'The Forum is your company’s own Slack: channels, DMs and threads where people and agents work together. Chat with one agent or a whole department; agents talk to each other, hand work over with its context, and ask you when they need a decision. Your real Slack comes into the same place.',
  },
  {
    tag: 'II · TASKS', title: 'A board that runs itself.', icon: KanbanSquare,
    body: 'Every department has its board. Agents take the next task, move it as the work moves, and close it when the PR merges. Turn on Autopilot and they pick up work on their own, as many at once as you allow. Already on Linear? It stays in sync both ways.',
  },
  {
    tag: 'III · WORKTREES', title: 'Every task, its own branch.', icon: GitBranch, visual: 'branches',
    body: 'Start a code task and it opens in its own git worktree and branch, with an agent on it. Your checkout is never touched, and merging stays yours.',
  },
  {
    tag: 'IV · ANY HARNESS', title: 'Bring the agent you already pay for.', icon: TerminalSquare, visual: 'harnesses',
    body: 'Principia runs the coding agents you have installed and signed in to. When one hits its limit, hand the work to another with its context.',
  },
  {
    tag: 'V · MEMORY', title: 'A company that remembers.', icon: BookOpen,
    body: 'Decisions, conventions, house style and what your people like, shared by every agent. Each saved fact is open to review and edit, and stays on your Mac.',
  },
  {
    tag: 'VI · DASHBOARDS', title: 'See every department at a glance.', icon: LayoutDashboard,
    body: 'Live dashboards per department from the services you connect once: what moved, what is stuck, what needs you, and what it all costs.',
  },
  {
    tag: 'VII · PHONE', title: 'Your company, from your phone.', icon: Smartphone, wide: true, visual: 'phone',
    body: 'Reply to agents, allow or deny what they ask, pick a session back up and check the board. Pair once with a QR code: the phone reaches your Mac through a private tunnel and everything stays on the Mac.',
    note: 'Phone web app today · iPhone app coming soon to TestFlight',
  },
  {
    tag: 'VIII · BROWSER', title: 'A browser your agents can drive.', icon: Globe, wide: true, visual: 'browser',
    body: 'Every company has its own browser, right beside the chat, with its own cookies and sign-ins kept apart from every other company. Agents open pages, click, fill forms and read what they find while you watch, and Take over hands you the wheel whenever you want it.',
  },
  {
    tag: 'IX · DIAGRAMS', title: 'Agents draw what they mean.', icon: Network,
    body: 'Plans, flows and org charts come back as real, interactive diagrams, wherever you read an agent’s answer.',
  },
]

const harnesses = ['Claude Code', 'Codex', 'Cursor Agent', 'Gemini CLI']

function Harnesses() {
  return <div className="mt-6 flex flex-wrap gap-1.5">{harnesses.map(h => <span key={h} className="rounded-lg border border-white/[.12] px-3 py-1.5 text-[12px] text-soft">{h}</span>)}</div>
}

// main with two task branches leaving and merging back: strokes only, like the engravings
function Branches() {
  return <svg viewBox="0 0 240 64" className="mt-6 h-auto w-full" fill="none" stroke="#edf1f2" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 50h228" strokeOpacity=".7"/>
    <path d="M40 50c14 0 14-32 30-32h60c16 0 16 32 30 32" strokeOpacity=".5"/>
    <path d="M90 50c12 0 12-18 26-18h36c14 0 14 18 26 18" strokeOpacity=".35"/>
    {[40, 160, 90, 178].map((x, i) => <circle key={i} cx={x} cy={50} r={3.5} fill="#0f1213" strokeOpacity=".9"/>)}
    <circle cx={100} cy={18} r={3} fill="#0f1213" strokeOpacity=".6"/>
    <circle cx={134} cy={32} r={3} fill="#0f1213" strokeOpacity=".5"/>
  </svg>
}

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

// a browser window with an agent's cursor on a button: strokes only
function BrowserSketch() {
  return <svg viewBox="0 0 200 130" className="hidden h-[150px] w-auto shrink-0 sm:block" fill="none" stroke="#edf1f2" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="192" height="122" rx="12" strokeOpacity=".7"/>
    <path d="M4 26h192" strokeOpacity=".35"/>
    {[16, 27, 38].map(x => <circle key={x} cx={x} cy={15} r={3} strokeOpacity=".45"/>)}
    <rect x="52" y="9" width="132" height="12" rx="6" strokeOpacity=".35"/>
    <path d="M20 44h96M20 56h70M20 68h84" strokeOpacity=".4"/>
    <rect x="20" y="84" width="58" height="18" rx="9" strokeOpacity=".9"/>
    <path d="M70 94l12 26 4-11 11-4z" strokeOpacity=".95" fill="#0f1213"/>
  </svg>
}

export function Core() {
  return <section className="shell section-space" id="product">
    <div className="mb-12 text-center"><span className="pill">The product</span><h2 className="section-title mt-[18px]">Everything your company runs on.</h2><p className="mx-auto mt-5 max-w-[540px] text-[15px] leading-relaxed text-muted">All in the desktop preview you can download today.</p></div>
    <div className="grid gap-1.5 md:grid-cols-2 lg:grid-cols-3">
      {items.map(({ tag, title, body, icon: Icon, note, wide, visual }) => <article key={tag} className={`flex min-w-0 flex-col rounded-[18px] bg-panel p-6 sm:p-7 ${wide ? 'lg:col-span-2' : ''}`}>
        <div className="flex items-center justify-between gap-4"><span className="roman-tag text-[10px] text-muted">{tag}</span><Icon size={20} strokeWidth={1.3} aria-hidden="true" className="text-soft"/></div>
        <div className={visual === 'phone' || visual === 'browser' ? 'flex items-end gap-8' : ''}>
          <div className="min-w-0 flex-1">
            <h3 className="mt-6 font-serif text-[25px] leading-[1.2] tracking-[-.02em]">{title}</h3>
            <p className="mt-3 max-w-[560px] text-[13.5px] leading-relaxed text-muted">{body}</p>
            {note && <p className="mt-5 inline-flex rounded-md border border-white/10 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-soft">{note}</p>}
          </div>
          {visual === 'phone' && <PhoneSketch/>}
          {visual === 'browser' && <BrowserSketch/>}
        </div>
        {visual === 'harnesses' && <Harnesses/>}
        {visual === 'branches' && <Branches/>}
      </article>)}
    </div>
  </section>
}

// the small stuff: one line each, newest first
const changelog = [
  ['Oct 2026', 'Mac preview download on useprincipia.com'],
  ['Oct 2026', 'Token activity: every token across Claude Code, Codex and Principia in one year-long grid'],
  ['Oct 2026', 'Sounds only for what matters: Done, Needs you, Problem'],
  ['Oct 2026', 'Connect a service once and every agent, dashboard and routine uses it'],
  ['Oct 2026', 'Autopilot routines: morning brief, weekly review, a chief of staff that suggests what is next'],
  ['Oct 2026', 'Phone pairing with a QR code'],
] as const

export function Changelog({ releases }: { releases: string }) {
  return <section className="shell pb-16" id="changelog">
    <div className="mx-auto max-w-[760px] border-t border-white/[.07] pt-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><h2 className="display text-[clamp(20px,2.2vw,26px)]">Changelog</h2><a href={releases} className="border-b border-white/20 text-[13px] text-soft">All releases</a></div>
      <ul className="space-y-2.5">{changelog.map(([when, what]) => <li key={what} className="flex gap-5 text-[13.5px] leading-relaxed"><span className="w-[64px] shrink-0 font-mono text-[11px] leading-[1.9] text-muted">{when}</span><span className="text-soft">{what}</span></li>)}</ul>
    </div>
  </section>
}
