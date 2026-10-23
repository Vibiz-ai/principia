import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OnboardingDraft, OnboardingStatus } from '@shared/onboarding'
import { templatePlan } from '@shared/onboardingPlan'

// server markup needs a server snapshot; the store passes only the client one
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
const saved: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => saved[k] ?? null,
  setItem: (k: string, v: string) => void (saved[k] = v),
  removeItem: (k: string) => void delete saved[k]
})
vi.stubGlobal('window', { hive: { onboarding: {}, app: {} }, addEventListener: () => {}, removeEventListener: () => {} })

const status = (p: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
  firstRun: true,
  journal: null,
  providers: [{ adapter: 'claude', installed: true }],
  claudeCli: true,
  flags: {},
  sharedKeys: { FAL_KEY: false, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false },
  gh: 'ok',
  ghLogin: 'lautaro',
  defaultCloneDir: '/Users/me/Projects',
  waitlistUrl: null,
  ...p
})

async function draft(p: Partial<OnboardingDraft> = {}): Promise<OnboardingDraft> {
  const { newDraft } = await import('../../state/onboarding')
  const d = newDraft('new', { id: 'ob_test' })
  return { ...d, ...p, answers: { ...d.answers, ...(p.answers ?? {}) } }
}

async function render(
  d: OnboardingDraft,
  opts: { mode?: 'first' | 'new'; resumable?: boolean; status?: Partial<OnboardingStatus>; extra?: Record<string, unknown>; tone?: 'playful' | 'plain'; personas?: boolean } = {}
): Promise<string> {
  const { setState } = await import('../../state/store')
  const { OnboardingFlow } = await import('./OnboardingFlow')
  setState({
    settings: {
      experimental: {},
      onboardingDone: false,
      launchAtLogin: false,
      ...(opts.tone ? { tone: opts.tone } : {}),
      ...(opts.personas === undefined ? {} : { personas: opts.personas })
    } as never,
    providers: [],
    companies: [],
    repos: [],
    onboarding: { open: true, mode: opts.mode ?? d.mode, resumable: !!opts.resumable },
    onboardingDraft: d,
    onboardingStatus: status(opts.status),
    onboardingOffer: null,
    onboardingPlanPending: false,
    onboardingProgress: { journalId: null, steps: {}, clone: null },
    ...(opts.extra ?? {})
  })
  return renderToStaticMarkup(createElement(OnboardingFlow))
}

const unescape = (h: string): string => h.replace(/&#x27;|&#39;/g, "'")
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

beforeEach(async () => {
  const { setState } = await import('../../state/store')
  setState({ onboarding: null, onboardingDraft: null })
})

describe('OnboardingFlow screens (§2 copy)', () => {
  it('renders nothing when closed', async () => {
    const { setState } = await import('../../state/store')
    const { OnboardingFlow } = await import('./OnboardingFlow')
    setState({ onboarding: null, onboardingDraft: null })
    expect(renderToStaticMarkup(createElement(OnboardingFlow))).toBe('')
  })

  it('S0 first run: welcome, the code question, explore link, agents found, no ✕', async () => {
    const html = await render(await draft({ mode: 'first' }), { mode: 'first' })
    const t = text(html)
    expect(t).toContain('Welcome to Principia')
    expect(t).toContain("Let's set up your business. About two minutes.")
    // playful is the default tone: the question carries the wink
    expect(t).toContain('Already have code, or are we laying the first stone?')
    expect(t).toContain('Yes, connect it')
    expect(t).toContain('A folder on this Mac or a GitHub repo')
    expect(t).toContain("Not yet, it's an idea")
    expect(t).toContain("We'll start with a name")
    expect(t).toContain("I'll explore on my own")
    expect(t).toContain('Agents found:')
    expect(t).toContain('Claude')
    expect(t).toContain('Step 1 of')
    expect(html).not.toContain('ob-close')
    expect(html).toContain('ob-layer--first')
    expect(html).toContain('aria-live="polite"')
  })

  it('S0 new company: Guided / From a prompt / From a repo first; the code question only under Guided', async () => {
    const t = text(await render(await draft()))
    expect(t).toContain('How do you want to start?')
    expect(t).toContain('Guided')
    expect(t).toContain('From a prompt')
    expect(t).toContain('Paste a description or brief')
    expect(t).toContain('From a repo')
    expect(t).toContain('Quick create (just a name)')
    expect(t).not.toContain('Yes, connect it')
    expect(text(await render(await draft({ start: 'guided' })))).toContain('Yes, connect it')
    expect(text(await render(await draft({ start: 'prompt' })))).not.toContain('Yes, connect it')
  })

  it('S0b Brief: the textarea, Build my plan (⌘↵) and the way back to the questions', async () => {
    const html = await render(await draft({ start: 'prompt', step: 'brief', history: ['start'], hasCode: false, brief: 'Sunday Bakery' }))
    const t = text(html)
    expect(t).toContain('Describe your business')
    expect(html).toContain('ob-brief')
    expect(t).toContain('Build my plan')
    expect(t).toContain('⌘↵')
    expect(t).toContain('Answer questions instead')
    expect(t).toContain('Sunday Bakery')
  })

  it('S0 new company with a saved draft: resume banner, Quick create, ✕', async () => {
    const d = await draft({ step: 'voice', hasCode: false, history: ['start', 'name', 'about'], answers: { name: 'Sunday Bakery' } as never })
    const t = text(await render(d, { resumable: true }))
    expect(t).toContain('Welcome back. Pick up Sunday Bakery at step 3 of')
    expect(unescape(await render(d, { resumable: true }))).toContain('Pick up <b>Sunday Bakery</b> at step 3 of')
    expect(text(await render(d, { resumable: true, tone: 'plain' }))).toContain('Pick up where you left off? Sunday Bakery · step 3 of')
    expect(t).toContain('Start over')
    expect(t).toContain('New business')
    expect(t).toContain('Quick create (just a name)')
    expect(await render(d, { resumable: true })).toContain('ob-close')
  })

  it('S0 with no agent CLI shows the install note', async () => {
    const t = text(await render(await draft(), { status: { providers: [{ adapter: 'claude', installed: false }], claudeCli: false } }))
    expect(t).toContain('No agent CLI found. You can finish setup, but agents need Claude Code, Codex, Cursor or Gemini to work.')
    expect(t).toContain('How to install ↗')
  })

  it('S1a Connect: segmented control, choose folders, clone line, No code after all', async () => {
    const t = text(await render(await draft({ step: 'connect', hasCode: true, history: ['start'] })))
    expect(t).toContain('Connect your code')
    expect(t).toContain('This Mac')
    expect(t).toContain('GitHub')
    expect(t).toContain('Choose folders…')
    expect(t).toContain('or drop folders here')
    expect(t).toContain('Nothing is added until you launch.')
    expect(t).toContain('No code after all')
    expect(t).toContain('← Back')
  })

  it('S1b Name: the only required field and its placeholders', async () => {
    const html = await render(await draft({ step: 'name', hasCode: false, history: ['start'] }))
    const t = text(html)
    expect(t).toContain('Every empire starts with a name.')
    expect(t).toContain('Only the name is required. The rest can wait.')
    expect(html).toContain('placeholder="e.g. Sunday Bakery"')
    expect(html).toContain('placeholder="Sourdough delivered to offices in Lisbon"')
    expect(html).toContain('placeholder="sundaybakery.com or @sundaybakery"')
    expect(t).toContain('Got a website or Instagram? (optional)')
    // Continue stays disabled until a name is typed
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>Continue<\/span>/)
  })

  it('S1b Name: an Instagram handle is saved as a link', async () => {
    const t = text(await render(await draft({ step: 'name', hasCode: false, history: ['start'], answers: { name: 'Sunday Bakery', siteUrl: '@sundaybakery' } as never })))
    expect(t).toContain("Saved as a link. Principia can't read Instagram yet.")
  })

  it('S2 About on the code branch: prefill pills and stack chips', async () => {
    const d = await draft({
      step: 'about',
      hasCode: true,
      history: ['start', 'connect'],
      answers: { name: 'Acme Web', oneLiner: 'Invoices for freelancers' } as never,
      scan: {
        repos: [{ source: 'local', label: 'acme-web', path: '/Users/me/acme-web', packageName: 'acme-web', description: 'Invoices for freelancers', stack: ['Next.js', 'Stripe'] }],
        stack: ['Next.js', 'Stripe']
      }
    })
    const t = text(await render(d))
    expect(t).toContain('What do you sell, and to whom?')
    expect(t).toContain("Filled in from your README and package.json. Fix anything that's off.")
    expect(t).toContain('From package.json')
    expect(t).toContain('What you sell')
    expect(t).toContain('Who buys it')
    expect(t).toContain('Next.js')
    expect(t).toContain('Stripe')
    expect(t).toContain('Skip')
  })

  it('S3 Voice: six vibe cards with samples built from the name', async () => {
    const t = text(await render(await draft({ step: 'voice', hasCode: false, history: ['start', 'name', 'about'], answers: { name: 'Sunday Bakery' } as never })))
    expect(t).toContain('How should it sound?')
    for (const v of ['Friendly & warm', 'Expert & precise', 'Bold & punchy', 'Playful', 'Calm & premium', 'Straight-talking']) expect(t).toContain(v)
    expect(t).toContain('Sunday Bakery')
    expect(t).toContain('Or describe it')
    expect(t).toContain('Words to avoid (optional)')
  })

  it('S4 Goals: eight chips, code-only goal disabled without code, soft note on a 4th pick', async () => {
    const html = await render(await draft({ step: 'goals', hasCode: false, history: ['start', 'name', 'about', 'voice'], answers: { name: 'B', goals: ['website', 'social'] } as never }))
    const t = text(html)
    expect(t).toContain('What should happen in the next 30 days?')
    expect(t).toContain("Rome wasn't built in a day. Pick up to 3; we'll build the team around them.")
    for (const g of ['Get first customers', 'Launch a website', 'Post on social', 'Run ads', 'Get found on Google', 'Fix bugs & ship features', 'Customer support', 'Something else']) expect(t).toContain(g)
    expect(html).toMatch(/aria-pressed="true"[^>]*><span class="ob-kbd">2<\/span>Launch a website/)
    expect(t).toContain('“Fix bugs & ship features” appears when you connect code.')
    const four = text(await render(await draft({ step: 'goals', hasCode: false, history: ['start'], answers: { name: 'B', goals: ['website', 'social', 'ads', 'seo'] } as never })))
    expect(four).toContain('Three keeps the first week focused.')
  })

  it('S5 Content: capabilities, Coming soon items, the Vibiz card and the key field', async () => {
    const base = { step: 'content' as const, hasCode: false, history: ['start', 'name', 'about', 'voice', 'goals'] as OnboardingDraft['history'], answers: { name: 'B', goals: ['social'] } as never }
    const off = text(await render(await draft(base)))
    expect(off).toContain('Want to start posting already?')
    expect(off).toContain('Agents can draft posts and make on-brand images. Nothing is published, sent or paid without your seal.')
    expect(off).toContain('Image workflows stay off. Add keys later in Keys.')
    const d = await draft({ ...base, content: { wants: true, provider: null, keySource: null, vibizInterest: false } })
    const html = await render(d)
    const t = text(html)
    expect(t).toContain('Images')
    expect(t).toContain('Carousels, product photos, ad creatives, thumbnails · 9 workflows with fal, 1 with OpenAI')
    expect(t).toContain('Needs a key')
    expect(t).toContain('Social posting')
    expect(t).toContain('Coming soon. For now, posts are saved as ready-to-copy drafts and land in review.')
    expect(t).toContain('Vibiz key')
    expect(t).toContain('Recommended')
    expect(t).toContain('One key for images, email, scraping and more, billed in one place. Not available yet.')
    expect(t).toContain('Notify me')
    expect(t).not.toContain('Join the waitlist')
    expect(t).toContain('fal (recommended · 9 workflows)')
    expect(t).toContain('OpenAI (1 workflow)')
    expect(t).toContain('Check & save')
    expect(t).toContain("Saved encrypted for this business only when you launch. We don't keep it in the draft.")
    expect(t).toContain('Get a fal key ↗')
    expect(html).toContain('type="password"')
    expect(html).toMatch(/type="password"[^>]*value=""/)
    // a waitlist link only with a real URL
    expect(text(await render(d, { status: { waitlistUrl: 'https://vibiz.example/waitlist' } }))).toContain('Join the waitlist ↗')
    // a Shared key is used, nothing copied
    const shared = text(await render(d, { status: { sharedKeys: { FAL_KEY: true, OPENAI_API_KEY: false, FIRECRAWL_API_KEY: false } } }))
    expect(shared).toContain('You already have FAL_KEY in Shared keys. This business will use it.')
    expect(shared).toContain('Ready')
  })

  it('S6 Plan: departments, rows, consent switch, fine print and the create button', async () => {
    const { planInput, availableFor, draftInputsHash } = await import('../../state/onboarding')
    const d0 = await draft({ step: 'plan', hasCode: false, history: ['start', 'name', 'about', 'voice', 'goals'], answers: { name: 'Sunday Bakery', goals: ['website', 'customers'] } as never })
    const input = planInput(d0, { flagsOn: false })
    const plan = templatePlan(input, availableFor(input, ['claude']))
    const d = { ...d0, plan: { value: plan, source: 'template' as const, edited: false, inputsHash: draftInputsHash(d0, { flagsOn: false }) } }
    const html = await render(d)
    const t = text(html)
    expect(t).toContain("Here's your team for the first week")
    expect(t).toContain('Starter plan')
    expect(t).toContain('Tailor with Claude')
    expect(t).toContain('Uses your Claude login · about 1 small call')
    expect(t).toContain('Marketing')
    expect(t).toContain('Sales')
    expect(t).toContain('Works on its own')
    expect(t).toContain('Asks first')
    expect(t).toContain('Off until you start')
    expect(t).toContain('Turn on Departments, Board and Passport vault (beta)')
    expect(t).toContain('Costs nothing until you start. Agents use your Claude Code login.')
    expect(t).toContain('Nothing is posted, sent or paid without your approval.')
    expect(t).toContain('Create Sunday Bakery')
    expect(t).toContain('⌘↵')
    // tailoring states
    expect(text(await render(d, { extra: { onboardingPlanPending: true } }))).toContain('Tailoring with Claude…')
    expect(text(await render({ ...d, plan: { ...d.plan, source: 'agent' } }))).toContain('Tailored by Claude ✓')
    expect(text(await render(d, { extra: { onboardingOffer: plan } }))).toContain('Claude tailored a plan for you')
    // consent off, and no CLI
    expect(text(await render({ ...d, enableFlags: false }))).toContain("You'll get the company, tasks and schedules, but no departments, agents or passport notes.")
    const noCli = text(await render(d, { status: { providers: [], claudeCli: false } }))
    expect(noCli).toContain('Install Claude Code so agents can work. Tasks will wait on the board.')
    expect(noCli).not.toContain('Tailor with Claude')
    // the switch is hidden when every flag is already on
    expect(text(await render(d, { status: { flags: { companies: true, departments: true, vault: true } } }))).not.toContain('Turn on Departments')
  })

  it('S7 Launching / failed: live list, the failure line and Retry / Continue without this / Discard, no ✕', async () => {
    const { planInput, availableFor } = await import('../../state/onboarding')
    const d0 = await draft({ step: 'failed', journalId: 'jr_1', hasCode: false, history: ['start', 'name', 'about', 'voice', 'goals', 'plan'], answers: { name: 'Sunday Bakery', goals: ['website'] } as never })
    const input = planInput(d0)
    const d = { ...d0, plan: { value: templatePlan(input, availableFor(input, ['claude'])), source: 'template' as const, edited: false, inputsHash: 'x' } }
    const ev = (step: 'company' | 'schedules', st: 'done' | 'failed', error?: string) => ({ journalId: 'jr_1', step, status: st, label: step, ...(error ? { error } : {}) })
    const html = await render(d, { extra: { onboardingProgress: { journalId: 'jr_1', steps: { company: ev('company', 'done'), schedules: ev('schedules', 'failed', 'the scheduler is paused') }, clone: null } } })
    const t = text(html)
    expect(t).toContain('Setting up Sunday Bakery…')
    expect(t).toContain('Company')
    expect(t).toContain("Couldn't create the schedules: the scheduler is paused")
    expect(t).toContain('Retry')
    expect(t).toContain('Continue without this')
    expect(t).toContain('Discard')
    expect(html).not.toContain('ob-close')
    expect(html).not.toContain('Step 1 of')
    expect(html).not.toContain('← Back')
  })

  it('S8 Ready: summary, Start now / I\'ll review first, schedule checkboxes, What happens next, Launch at Login on first run', async () => {
    const { planInput, availableFor } = await import('../../state/onboarding')
    const { setLocal } = await import('./actions')
    const d0 = await draft({ mode: 'first', step: 'ready', journalId: 'jr_1', hasCode: false, history: [], answers: { name: 'Sunday Bakery', goals: ['social'] } as never })
    const input = { ...planInput(d0), keys: { fal: true, openai: false } }
    const plan = templatePlan(input, availableFor(input, ['claude']))
    const d = { ...d0, plan: { value: plan, source: 'template' as const, edited: false, inputsHash: 'x' } }
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: plan.schedules.map((s, i) => ({ ref: s.ref, id: `sch_${i}`, costly: s.target.kind === 'workflow' && s.target.workflow === 'social-post-carousel' })) } })
    const html = await render(d, { mode: 'first' })
    const t = text(html)
    expect(t).toContain('Sunday Bakery is ready.')
    expect(t).toContain('(off)')
    expect(t).toContain('Start now?')
    expect(t).toContain('Start now')
    expect(t).toContain("I'll review first")
    expect(t).toContain('Will start on their own:')
    expect(t).toContain('Also turn on schedules')
    expect(t).toContain('images a week on your fal credits')
    expect(t).toContain('What happens next')
    expect(t).toContain('Everything agents make lands in review. Nothing is posted, sent or paid without you.')
    expect(t).toContain('Launch at Login')
    // the paid schedule starts unchecked, free ones checked
    const boxes = [...html.matchAll(/<input type="checkbox" class="ob-cb"( checked="")?/g)].map((m) => !!m[1])
    expect(boxes.filter(Boolean).length).toBe(plan.schedules.length - 1)
    expect(t).not.toContain('Install Claude Code')
    // no agent CLI: Start now leaves Autopilot off (main), and Ready says so
    expect(text(await render(d, { mode: 'first', status: { providers: [], claudeCli: false } }))).toContain('Install Claude Code so agents can work. Until then Autopilot stays off and tasks wait on the board.')
    // not on "+ New company"
    expect(text(await render({ ...d, mode: 'new' }, { mode: 'new' }))).not.toContain('Launch at Login')
    setLocal({ result: null })
  })
})

// ---------- the Roman stage (VOICE.md §3, §5.7, §8) ----------

const LATIN_WORDS = /\b(alea|iacta|festina|lente|fortes|fortuna|adiuvat|ovo)\b/i

/** A plan with three agents in two departments, each with a persona (finalizePlan's job in the app). */
async function threeAgentPlan(): Promise<import('@shared/onboarding').OnboardingPlan> {
  const { pickPersona } = await import('@shared/personas')
  const D = 'Deliverable: a file. When done, move this task to review.'
  const agents = [
    { ref: 'copywriter', departmentKey: 'marketing' as const, name: 'Copywriter', role: 'content' as const, auto: true },
    { ref: 'site-builder', departmentKey: 'marketing' as const, name: 'Site builder', role: 'builder' as const, auto: true },
    { ref: 'lead-researcher', departmentKey: 'sales' as const, name: 'Lead researcher', role: 'researcher' as const, auto: false }
  ]
  const used = new Set<string>()
  return {
    version: 1,
    summary: 'A first week for Sunday Bakery.',
    departments: [
      { key: 'marketing', name: 'Marketing', include: true },
      { key: 'sales', name: 'Sales', include: true }
    ],
    agents: agents.map((a) => {
      const persona = pickPersona({ departmentKey: a.departmentKey, role: a.role, used, seed: `co:${a.ref}` })
      used.add(persona.name.toLowerCase())
      return { ...a, adapter: 'claude' as const, instructions: 'Draft.', capabilities: 'drafts', include: true, persona }
    }),
    tasks: [
      { ref: 'posts', title: 'Draft 3 launch posts', description: D, departmentKey: 'marketing', agentRef: 'copywriter', priority: 2, dependsOn: [], where: 'workspace', include: true },
      { ref: 'site', title: 'One-page site with menu and order form', description: D, departmentKey: 'marketing', agentRef: 'site-builder', priority: 2, dependsOn: [], where: 'workspace', include: true },
      { ref: 'leads', title: 'List 20 Lisbon offices', description: D, departmentKey: 'sales', agentRef: 'lead-researcher', priority: 3, dependsOn: [], where: 'workspace', include: true }
    ],
    schedules: []
  }
}

async function planDraft(): Promise<OnboardingDraft> {
  const d0 = await draft({ step: 'plan', hasCode: false, history: ['start', 'name', 'about', 'voice', 'goals'], answers: { name: 'Sunday Bakery', goals: ['website', 'customers'] } as never })
  const { draftInputsHash } = await import('../../state/onboarding')
  return { ...d0, plan: { value: await threeAgentPlan(), source: 'agent' as const, edited: false, inputsHash: draftInputsHash(d0, { flagsOn: false }) } }
}

async function readyDraft(): Promise<OnboardingDraft> {
  const d0 = await draft({ step: 'ready', journalId: 'jr_1', hasCode: false, history: [], answers: { name: 'Sunday Bakery', oneLiner: 'Sourdough delivered to offices in Lisbon', siteUrl: 'sundaybakery.com', goals: ['website'] } as never })
  return { ...d0, plan: { value: await threeAgentPlan(), source: 'template' as const, edited: false, inputsHash: 'x' } }
}

/** prefers-reduced-motion for the next renders (window is a stub here). */
function reducedMotion(on: boolean): void {
  ;(window as unknown as { matchMedia?: unknown }).matchMedia = on
    ? (q: string) => ({ matches: q.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} })
    : undefined
}

const MOTION = /\b(rm-rise|rm-draw|rm-tile|rm-letters-in|rm-laurel--draw|rm-seal--stamp|ob-cer--anim)\b/

describe('the Roman stage: tone, tesserae, passport tablet', () => {
  it('playful and plain differ only in copy, Latin and classical letters', async () => {
    const d = await draft({ step: 'name', hasCode: false, history: ['start'], answers: { name: 'Sunday Bakery' } as never })
    const playful = await render(d)
    const plain = await render(d, { tone: 'plain' })
    expect(text(playful)).toContain('Every empire starts with a name.')
    expect(text(plain)).toContain('Give your business a name.')
    expect(text(plain)).not.toContain('empire')
    // the tablet: classical letters and a numeral year in playful, plain letters and digits in plain; craft in both
    expect(playful).toMatch(/SVNDAY<span class="rm-pp__dot">·<\/span>/)
    expect(plain).toMatch(/SUNDAY<span class="rm-pp__dot">·<\/span>/)
    expect(plain).not.toContain('SVNDAY')
    expect(text(playful)).toContain('FOUNDED · MMXXVI')
    expect(text(plain)).toContain(`FOUNDED ${new Date().getFullYear()}`)
    expect(text(plain)).not.toMatch(/\bM{1,3}[CDXLVI]+\b/)
    for (const h of [playful, plain]) {
      expect(h).toContain('rm-pp--portrait')
      expect(h).toContain('rm-tess')
      expect(h).toContain('rm-arch')
      expect(h).toContain('rm-display')
    }
    // the rail hint
    expect(text(playful)).toContain('Your passport is drawn as you answer.')
    expect(text(plain)).toContain('The passport updates as you answer.')
    // plain sub copy on the other steps
    const goals = await draft({ step: 'goals', hasCode: false, history: ['start', 'name', 'about', 'voice'], answers: { name: 'B', goals: ['website'] } as never })
    expect(text(await render(goals, { tone: 'plain' }))).toContain("Pick up to 3. We'll build the team around them.")
    const start = text(await render(await draft({ mode: 'first' }), { mode: 'first', tone: 'plain' }))
    expect(start).toContain('Do you already have code for this business?')
    expect(start).not.toContain('first stone')
  })

  it('screen readers get the plain twin of playful copy: the visible playful words are aria-hidden', async () => {
    const name = await render(await draft({ step: 'name', hasCode: false, history: ['start'], answers: { name: 'B' } as never }))
    const h1 = unescape(/<h1[^>]*>(.*?)<\/h1>/.exec(name)?.[1] ?? '')
    expect(h1).toBe('<span aria-hidden="true">Every empire starts with a name.</span><span class="ob-sr">Give your business a name.</span>')
    // plain renders the words once, with no twin
    const plainH1 = unescape(/<h1[^>]*>(.*?)<\/h1>/.exec(await render(await draft({ step: 'name', hasCode: false, history: ['start'], answers: { name: 'B' } as never }), { tone: 'plain' }))?.[1] ?? '')
    expect(plainH1).toBe('Give your business a name.')
    // entries with no playful form are not doubled
    const goals = unescape(await render(await draft({ step: 'goals', hasCode: false, history: ['start', 'name', 'about', 'voice'], answers: { name: 'B' } as never })))
    expect(/<h1[^>]*>(.*?)<\/h1>/.exec(goals)?.[1]).toBe('What should happen in the next 30 days?')
    expect(goals).toContain('<span class="ob-sr">Pick up to 3. We\'ll build the team around them.</span>')
    // the resume banner reads the plain sentence
    const resume = unescape(await render(await draft({ step: 'about', hasCode: false, history: ['start', 'name'], answers: { name: 'Sunday Bakery' } as never }), { resumable: true }))
    expect(resume).toMatch(/<span class="ob-sr">Pick up where you left off\? Sunday Bakery · step \d of 6<\/span>/)
  })

  it('tesserae replace the dots: six aria-hidden tiles and the "Step n of N" label', async () => {
    const h = await render(await draft({ step: 'voice', hasCode: false, history: ['start', 'name', 'about'], answers: { name: 'B' } as never }))
    expect(h).not.toContain('ob-dots')
    expect(h).toMatch(/<span class="rm-tess__tiles" aria-hidden="true">/)
    expect((h.match(/rm-tess__tile /g) ?? []).length).toBe(6)
    const n = Number(/Step (\d) of 6/.exec(text(h))?.[1])
    expect(n).toBeGreaterThan(1)
    // every step before the current one is a filled tile, the current one has the white outline
    expect((h.match(/rm-tess__tile--done/g) ?? []).length).toBe(n - 1)
    expect((h.match(/rm-tess__tile--cur/g) ?? []).length).toBe(1)
    expect((h.match(/rm-tess__tile--todo/g) ?? []).length).toBe(6 - n)
  })

  it('the rail shows the passport tablet (no PassportCover): inscription aria-hidden, the readable name in sans', async () => {
    const h = await render(await draft({ step: 'about', hasCode: false, history: ['start', 'name'], answers: { name: 'Sunday Bakery', oneLiner: 'Sourdough delivered to offices in Lisbon' } as never }))
    expect(h).not.toContain('ob-cover')
    expect(h).toMatch(/<div class="rm-pp__ins" aria-hidden="true"[^>]*>SVNDAY<span class="rm-pp__dot">·<\/span><wbr\/>BAKERY<\/div>/)
    expect(h).toContain('<div class="rm-pp__name">Sunday Bakery</div>')
    expect(text(h)).toContain('Sourdough delivered to offices in Lisbon')
    // not launched yet: the dashed seal outline
    expect(h).toContain('rm-seal--open')
    // with no name yet the tablet says so in plain sans
    expect(text(await render(await draft({ step: 'name', hasCode: false, history: ['start'] })))).toContain('Your business')
  })

  it('the polite live region reads plain titles, never Latin or the playful twin', async () => {
    const steps: [Partial<OnboardingDraft>, string][] = [
      [{ step: 'name', hasCode: false, history: ['start'] }, 'Give your business a name.'],
      [{ step: 'goals', hasCode: false, history: ['start'] }, 'What should happen in the next 30 days?']
    ]
    for (const [p, plain] of steps) {
      const h = await render(await draft({ ...p, answers: { name: 'Sunday Bakery' } as never }))
      const live = /<div class="ob-sr" aria-live="polite">([^<]*)<\/div>/.exec(unescape(h))?.[1]
      expect(live).toBe(plain)
    }
    const { stepTitle } = await import('./OnboardingFlow')
    const d = await draft({ answers: { name: 'Sunday Bakery' } as never })
    for (const s of ['start', 'connect', 'name', 'about', 'voice', 'goals', 'content', 'plan', 'launching', 'failed', 'ready'] as const) {
      const line = stepTitle(s, d, 'new')
      expect(line).not.toMatch(LATIN_WORDS)
      expect(line).not.toMatch(/empire|charter|seal|Rome/i)
    }
    expect(stepTitle('ready', d, 'new')).toBe('Sunday Bakery is ready.')
    expect(stepTitle('plan', d, 'new')).toBe("Here's your team for the first week")
  })

  it('line art on a flat stage: no stage gradient, no stone classes, the rail passport in a mono beam', async () => {
    const h = await render(await draft({ step: 'about', hasCode: false, history: ['start', 'name'], answers: { name: 'Sunday Bakery' } as never }))
    // VOICE.md §5.7: the flat app --bg; the retired material classes are gone
    expect(h).toMatch(/<div class="ob-panel ">/)
    expect(h).not.toMatch(/\brm-(stage|stone|marble|carved|gilt|bronze)\b/)
    // the arch at its default .14
    expect(h).toMatch(/<svg class="rm-la rm-arch ob-arch"[^>]*style="opacity:0.14"/)
    // the beam around the rail passport is mono (white/silver, VOICE.md §5.12) and still travels the edge
    const rail = h.slice(h.indexOf('class="ob-rail"'), h.indexOf('class="ob-rail__hint"'))
    expect(rail).toContain('rm-pp rm-pp--portrait rm-pp--open rm-pp--beam')
    expect(rail).toMatch(/rim-travel-/)
    expect(rail).not.toMatch(/rim-hue-shift/)
  })
})

describe('Plan: the founding charter', () => {
  it('playful: kicker and "Meet your team"; three agents make three plinths with unique carved names and rename buttons', async () => {
    const d = await planDraft()
    const h = await render(d)
    const t = text(h)
    expect(t).toContain('The founding charter')
    expect(t).toContain('Meet your team')
    // VOICE.md §5.7: a near-black card with the double rule and four corner lozenges, no marble or parchment
    expect(h).toContain('<div class="ob-charter"><i class="rm-cn rm-cn0" aria-hidden="true"></i><i class="rm-cn rm-cn1" aria-hidden="true"></i>')
    expect(h).not.toMatch(/\brm-(marble|stone|carved|gilt)\b/)
    expect(h).toMatch(/<h2 class="ob-charter__h">[^<]+<\/h2>/)
    expect(h).toContain('ob-kicker')
    const team = h.slice(h.indexOf('class="ob-team"'), h.indexOf('class="ob-plan"'))
    // a meander divides the team from the departments
    expect(team).toContain('<div class="ob-meander" aria-hidden="true"><svg class="rm-la"')
    expect((team.match(/class="rm-plinth"/g) ?? []).length).toBe(3)
    const names = d.plan!.value.agents.map((a) => a.persona!.name)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3)
    for (const n of names) {
      expect(team).toContain(`<span class="rm-sr">${n}</span>`)
      expect(team).toContain(`aria-label="Rename ${n}"`)
      expect(team).toContain(`aria-label="Include ${n}"`)
    }
    // lettered in classical letters inside the drawn plinth, aria-hidden
    expect(team).toMatch(/class="rm-plinth__base" aria-hidden="true"/)
    expect(team).toContain('class="rm-la rm-plinth__svg"')
    // role label with the department, personality and the first task
    expect(t).toContain('Copywriter · Marketing')
    expect(t).toContain('Lead researcher · Sales')
    expect(t).toContain('First task: Draft 3 launch posts')
    expect(t).toContain(d.plan!.value.agents[0]!.persona!.personality)
    expect(team).toContain('aria-label="Your team: 3 agents"')
    // the department cards, rows and keyboard model are still there
    expect(h).toContain('role="grid"')
    expect(h).toContain('ob-dept--charter')
    expect(h).toContain('data-row="agent:copywriter"')
    expect(h).toContain('data-row="task:posts"')
    expect(t).toContain('Create Sunday Bakery')
  })

  it('plain: "Your plan" + "Here\'s your team for the first week", the craft stays', async () => {
    const h = await render(await planDraft(), { tone: 'plain' })
    const t = text(h)
    expect(t).toContain('Your plan')
    expect(t).toContain("Here's your team for the first week")
    expect(t).not.toContain('The founding charter')
    expect(t).not.toContain('Meet your team')
    expect(h).toContain('rm-plinth')
    expect(h).toContain('rm-bust')
  })

  it('personas off: plinths fall back to the role label and initials, no busts', async () => {
    const d = await planDraft()
    const h = await render(d, { personas: false })
    const team = h.slice(h.indexOf('class="ob-team"'), h.indexOf('class="ob-plan"'))
    expect(team).not.toContain('rm-bust')
    expect((team.match(/ob-plinth--plain/g) ?? []).length).toBe(3)
    expect(team).toContain('seat-avatar')
    expect(team).toContain('>CO<')
    expect(team).toContain('aria-label="Rename Copywriter"')
    for (const a of d.plan!.value.agents) expect(team).not.toContain(a.persona!.name)
  })
})

describe('Ready: the sealed diploma', () => {
  it('landscape tablet, playful title, the Latin with its translation, persona names with roles', async () => {
    const { setLocal } = await import('./actions')
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: [] } })
    const d = await readyDraft()
    reducedMotion(false)
    const h = await render(d)
    const t = text(h)
    expect(t).toContain('Sunday Bakery is ready. Signed and sealed.')
    expect(h).toContain('rm-pp--landscape')
    expect(h).toContain('rm-seal--pressed')
    // the line roundel draws itself when the step first appears
    expect(h).toContain('rm-seal--stamp')
    // the diploma sits in a mono (white/silver) beam that still travels its frame (VOICE.md §5.12)
    const dip = h.slice(h.indexOf('class="ob-diploma"'), h.indexOf('class="ob-startbox"'))
    expect(dip).toContain('rm-pp rm-pp--landscape rm-pp--sealed rm-pp--beam')
    expect(dip).toMatch(/rim-spin-/)
    expect(dip).not.toMatch(/rim-hue-shift/)
    expect(h).toMatch(/<span class="rm-latin" lang="la" aria-hidden="true"[^>]*>Fortes fortuna adiuvat<\/span>/)
    expect(t).toContain('Fortune favors the bold')
    expect(t).toContain('Start now?')
    const [m, v, a] = d.plan!.value.agents.map((x) => x.persona!.name)
    expect(t).toContain(`Will start on their own: ${m} (Copywriter), ${v} (Site builder). Ask first: ${a} (Lead researcher).`)
    // no rail on Ready: the diploma is the passport here
    expect(h).not.toContain('rm-pp--portrait')
    // plain: no Latin, plain title
    const plain = await render(d, { tone: 'plain' })
    expect(text(plain)).toContain('Sunday Bakery is ready.')
    expect(text(plain)).not.toContain('Signed and sealed')
    expect(plain).not.toContain('lang="la"')
    setLocal({ result: null })
  })

  it('reduced motion: the seal appears pressed, no stamp', async () => {
    const { setLocal } = await import('./actions')
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: [] } })
    reducedMotion(true)
    const h = await render(await readyDraft())
    expect(h).toContain('rm-seal--pressed')
    expect(h).not.toContain('rm-seal--stamp')
    reducedMotion(false)
    setLocal({ result: null })
  })
})

describe('the launch ceremony (VOICE.md §8)', () => {
  const api = (): Record<string, any> => (window as unknown as { hive: Record<string, any> }).hive

  it('renders over Ready when set: dialog, Skip first, the Latin aria-hidden, plinths, the CTA', async () => {
    const { setLocal } = await import('./actions')
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: [] }, ceremony: { companyId: 'co_new' } })
    reducedMotion(false)
    const d = await readyDraft()
    const h = unescape(await render(d))
    const cer = h.slice(h.indexOf('class="ob-cer'))
    expect(cer).toMatch(/^class="ob-cer ob-cer--anim" role="dialog" aria-modal="true" aria-label="Your team is set up"/)
    // Skip is the first control in the layer (it gets focus first)
    expect(cer.indexOf('<button')).toBe(cer.indexOf('<button type="button" class="ob-cer__skip"'))
    expect(text(cer)).toContain('Skip')
    expect(cer).toMatch(/class="ob-cer__alea rm-letters-in" lang="la" aria-hidden="true"[^>]*>Alea iacta est\.<\/div>/)
    expect(cer).not.toMatch(/\brm-(gilt|stone|marble|carved|tile-in|tablet-in)\b/)
    expect(text(cer)).toContain('The die is cast. Your team is assembled.')
    expect((cer.match(/class="rm-plinth"/g) ?? []).length).toBe(3)
    // F0: the line arch at .2 drawing itself; F1: the pixel wreath's tiles appear in order; F2: the 96 px roundel draws
    expect(cer).toMatch(/<svg class="rm-la rm-arch ob-cer__arch"[^>]*style="opacity:0.2;--rm-ds:2.5;--rm-delay:0ms"/)
    expect(cer).toContain('class="rm-draw"')
    const { WREATH, CER } = await import('./Ceremony')
    expect(CER.tileStep).toBe(28)
    expect(cer).toMatch(/<svg class="rm-mosaic ob-cer__wreath"[^>]*shape-rendering="crispEdges"/)
    expect((cer.match(/class="rm-tile"/g) ?? []).length).toBeGreaterThanOrEqual(WREATH.tiles.length)
    // only white, blue and the clean mosaic palette: no warm tiles, no rounding or rotation
    expect(cer).not.toMatch(/<rect[^>]*(rx=|transform=)/)
    expect(cer).toContain('rm-seal rm-seal--pressed rm-seal--stamp ob-cer__seal')
    expect(cer).toMatch(/class="rm-seal[^"]*ob-cer__seal" role="img"[^>]*style="width:96px;height:96px"/)
    expect(text(cer)).toContain('Go to Sunday Bakery')
    expect(text(cer)).toContain('Autopilot is on. 2 agents will start on their own.')
    expect(cer).toMatch(MOTION)
    // the app behind is inert and hidden from screen readers
    expect(h).toMatch(/<div class="ob-panel ob-panel--norail" aria-hidden="true" inert=""/)
    // no agent CLI installed: main left Autopilot off, so the line is not shown
    const noCli = text(unescape(await render(d, { status: { providers: [], claudeCli: false } })))
    expect(noCli).toContain('Go to Sunday Bakery')
    expect(noCli).not.toContain('Autopilot is on')
    setLocal({ result: null, ceremony: null })
  })

  it('a launch that made no agents shows no plinths and no autopilot line', async () => {
    const { setLocal } = await import('./actions')
    const steps = [{ name: 'agents', status: 'skipped', created: [] }, { name: 'company', status: 'done', created: [{ kind: 'company', id: 'co_new' }] }]
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps, scheduleRefs: [] } as never, ceremony: { companyId: 'co_new' } })
    const h = unescape(await render(await readyDraft()))
    const cer = h.slice(h.indexOf('class="ob-cer'))
    expect(cer).not.toContain('rm-plinth')
    expect(text(cer)).not.toContain('Autopilot is on')
    expect(text(cer)).toContain('Go to Sunday Bakery')
    expect(text(cer)).toContain('Sunday Bakery is set up.')
    expect(text(cer)).not.toContain('Your team is assembled')
    expect(cer).toContain('aria-label="Sunday Bakery is set up"')
    const { ceremonyTeam } = await import('./model')
    const plan = await threeAgentPlan()
    expect(ceremonyTeam(plan, true, { agents: 0 })).toEqual([])
    expect(ceremonyTeam(plan, true, null)).toHaveLength(3)
    setLocal({ result: null, ceremony: null })
  })

  it('a leftover ceremony never makes another step inert or shows over it', async () => {
    const { setLocal } = await import('./actions')
    setLocal({ result: null, ceremony: { companyId: 'co_old' } })
    const h = await render(await draft({ step: 'name', hasCode: false, history: ['start'], answers: { name: 'Next Co' } as never }))
    expect(h).not.toContain('inert')
    expect(h).not.toContain('class="ob-cer')
    setLocal({ ceremony: null })
  })

  it('reduced motion: every frame shows at once, with no animation classes', async () => {
    const { setLocal } = await import('./actions')
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: [] }, ceremony: { companyId: 'co_new' } })
    reducedMotion(true)
    const h = unescape(await render(await readyDraft()))
    const cer = h.slice(h.indexOf('class="ob-cer'))
    expect(cer).toContain('Alea iacta est.')
    expect((cer.match(/class="rm-plinth"/g) ?? []).length).toBe(3)
    expect(text(cer)).toContain('Go to Sunday Bakery')
    // the static end state is all there: the drawn arch, the complete wreath, the pressed roundel
    expect(cer).toContain('rm-arch ob-cer__arch')
    expect(cer).toContain('rm-mosaic ob-cer__wreath')
    expect(cer).toContain('rm-seal--pressed')
    expect(h).not.toMatch(MOTION)
    expect(cer).not.toContain('--rm-delay')
    reducedMotion(false)
    setLocal({ result: null, ceremony: null })
  })

  it('the screen-reader lines are plain: no Latin, the title then one line per agent', async () => {
    const { ceremonyLines, ceremonyLabel, teamOf } = await import('./model')
    const plan = await threeAgentPlan()
    const lines = ceremonyLines(teamOf(plan, true, true))
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('Your team is set up.')
    expect(lines[1]).toBe(`${plan.agents[0]!.persona!.name}, Copywriter. First task: Draft 3 launch posts.`)
    for (const l of lines) expect(l).not.toMatch(LATIN_WORDS)
    expect(ceremonyLabel()).toBe('Your team is set up')
    // personas off: the role, then the department
    expect(ceremonyLines(teamOf(plan, false, true))[1]).toBe('Copywriter, Marketing. First task: Draft 3 launch posts.')
    // no agents created: the company is set up, no team is announced
    expect(ceremonyLines([], 'Acme')).toEqual(['Acme is set up.'])
    expect(ceremonyLabel('Acme', true)).toBe('Acme is set up')
    expect(ceremonyLabel('Acme', false)).toBe('Your team is set up')
  })

  it('only Start now in playful plays it; Skip/CTA/Esc finish through the existing close + enterCompany', async () => {
    const { getState, setState } = await import('../../state/store')
    const { start, finishCeremony, getLocal, setLocal } = await import('./actions')
    const d = await readyDraft()
    setState({ onboarding: { open: true, mode: 'new', resumable: false }, onboardingDraft: d, onboardingStatus: status() })
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: [] }, ceremony: null })
    api().onboarding.start = vi.fn(async () => ({ ok: true }))
    api().company = { list: vi.fn(async () => []), overview: vi.fn(async () => []) }
    api().tasks = { list: vi.fn(async () => []) }
    api().settings = { update: vi.fn(async () => ({})) }
    api().memory = { overview: vi.fn(async () => null) }
    api().onboarding.cancelPlan = vi.fn(async () => undefined)
    // Start now, playful: autopilot is turned on, then the ceremony, and the flow stays open
    expect(await start({ autopilot: true, scheduleRefs: [], ceremony: true })).toBe(true)
    expect(api().onboarding.start).toHaveBeenCalledWith({ journalId: 'jr_1', autopilot: true, scheduleRefs: [] })
    expect(getLocal().ceremony).toEqual({ companyId: 'co_new' })
    expect(getState().onboarding?.open).toBe(true)
    // Skip (or the CTA, or Esc): the flow closes and lands in the company
    await finishCeremony()
    expect(getLocal().ceremony).toBeNull()
    expect(getState().onboarding).toBeNull()
    expect(getState().onboardingDraft).toBeNull()
    // a second skip is a no-op
    await finishCeremony()

    // I'll review first never passes `ceremony`, and `ceremony` without autopilot does nothing
    setState({ onboarding: { open: true, mode: 'new', resumable: false }, onboardingDraft: d })
    setLocal({ result: { journalId: 'jr_1', companyId: 'co_new', status: 'done', steps: [], scheduleRefs: [] }, ceremony: null })
    expect(await start({ autopilot: false, scheduleRefs: [], ceremony: true })).toBe(true)
    expect(getLocal().ceremony).toBeNull()
    expect(getState().onboarding).toBeNull()
  })

  it('the ceremony layer is flat near-black: no radial or warm gradient stage (VOICE.md §8)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../../styles/onboarding.css'), 'utf8')
    const block = (sel: string): string => {
      const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)
      return m?.[2] ?? ''
    }
    const cer = block('.ob-cer')
    expect(cer).toContain('background: var(--rm-ink)') // spec change (VOICE.md §8): opaque, the Ready step no longer shows through
    expect(cer).not.toMatch(/gradient/)
    // nowhere in the onboarding styles: a radial stage, the retired stage token, gold or the brown inks
    expect(css).not.toMatch(/radial-gradient/)
    expect(css).not.toMatch(/--rm-(stage|gold|carve|marble|travertine|bronze)\b|--ob-ink-/)
    expect(css).not.toMatch(/rgba\(\s*(74, 58, 40|212, 168, 75|176, 119, 58)/)
    expect(css).not.toMatch(/#(2d2920|5c5040|6b5a44|b0773a|d4a84b|22603f|7a4d06|4a3a7a)\b/i)
  })

  it('the onboarding Roman surfaces name no material, warm beam or raw colour (founder rule, 21 Oct 2026)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const files = ['OnboardingFlow.tsx', 'ReadyStep.tsx', 'PlanStep.tsx', 'bits.tsx', 'Ceremony.tsx', 'LaunchStep.tsx'].map((f) => [f, readFileSync(resolve(__dirname, f), 'utf8')] as const)
    files.push(['onboarding.css', readFileSync(resolve(__dirname, '../../styles/onboarding.css'), 'utf8')])
    for (const [name, src] of files) {
      expect(src, name).not.toMatch(/\b(bronze|travertine|terracotta|beige|copper|gold|gilt|ochre|mustard|parchment|marble|wax)\b/i)
      expect(src, name).not.toMatch(/['"]stone['"]|rm-stone|surface="(stone|dark)"/)
      expect(src, name).not.toMatch(/colorVariant="(sunset|ocean|colorful)"/)
      // the only raw colours allowed: white strokes (#fff) and the flat ceremony layer (--rm-ink at 96%)
      for (const hex of src.match(/#[0-9a-f]{3,8}\b/gi) ?? []) expect(['#fff', '#ffffff'], `${name} ${hex}`).toContain(hex.toLowerCase())
    }
  })

  it('the Ready step asks for the ceremony only in playful', async () => {
    const { wantsCeremony } = await import('./model')
    expect(wantsCeremony(true, 'playful')).toBe(true)
    expect(wantsCeremony(true, 'plain')).toBe(false)
    expect(wantsCeremony(false, 'playful')).toBe(false)
  })
})

describe('keys stay out of the store and storage', () => {
  it('a key check result keeps only the stash handle and last 4 in the draft, store and saved JSON', async () => {
    const typed = 'fal-key-1234567890abcdefSECRET4f2a'
    const { onboardingDispatch, getState, setState, flushOnboardingDraft } = await import('../../state/store')
    const d = await draft({ step: 'content', hasCode: false, history: ['start'], answers: { name: 'B', goals: ['social'] } as never, content: { wants: true, provider: 'fal', keySource: null, vibizInterest: false } })
    setState({ onboarding: { open: true, mode: 'new', resumable: false }, onboardingDraft: d })
    // what ContentStep forwards from KeyField: the IPC result, never the value
    onboardingDispatch({ type: 'keyChecked', provider: 'fal', result: { status: 'valid', stashId: 'stash_abc', last4: '4f2a' } })
    flushOnboardingDraft()
    const state = JSON.stringify(getState())
    expect(state).not.toContain(typed)
    expect(state).not.toContain('SECRET')
    expect(getState().onboardingDraft?.content).toMatchObject({ keySource: 'stash', stashId: 'stash_abc', last4: '4f2a' })
    for (const v of Object.values(saved)) expect(v).not.toContain('SECRET')
  })
})

describe('launch recovery never orphans a company', () => {
  const api = (): Record<string, any> => (window as unknown as { hive: Record<string, any> }).hive

  it('a launch call that throws after progress events keeps the journal; Discard undoes it in main', async () => {
    const { getState, setState } = await import('../../state/store')
    const { planInput, availableFor } = await import('../../state/onboarding')
    const { launch, discard, setLocal } = await import('./actions')
    const d0 = await draft({ step: 'plan', hasCode: false, history: ['start', 'name', 'about', 'voice', 'goals'], answers: { name: 'Sunday Bakery', goals: ['website'] } as never })
    const input = planInput(d0)
    const d = { ...d0, plan: { value: templatePlan(input, availableFor(input, ['claude'])), source: 'template' as const, edited: false, inputsHash: 'x' } }
    setState({ onboarding: { open: true, mode: 'new', resumable: false }, onboardingDraft: d, onboardingStatus: status(), onboardingProgress: { journalId: null, steps: {}, clone: null } })
    // main made the journal (progress arrived), then the call itself failed without a 'failed' event
    api().onboarding.launch = vi.fn(async () => {
      setState({ onboardingProgress: { journalId: 'jr_9', steps: { company: { journalId: 'jr_9', step: 'company', status: 'done', label: 'Company' } }, clone: null } })
      throw new Error('IPC channel closed')
    })
    await launch()
    expect(getState().onboardingDraft?.step).toBe('failed')
    expect(getState().onboardingDraft?.journalId).toBe('jr_9')
    // Discard with the journal on the draft
    api().ui = { confirm: vi.fn(async () => true) }
    api().onboarding.discard = vi.fn(async () => ({ undone: [] }))
    api().onboarding.key = vi.fn(async () => undefined)
    api().onboarding.cancelPlan = vi.fn(async () => undefined)
    await discard()
    expect(api().onboarding.discard).toHaveBeenCalledWith({ journalId: 'jr_9' })
    setLocal({ launchError: null, result: null })
  })

  it('Discard falls back to the progress journal when the draft lost it', async () => {
    const { setState } = await import('../../state/store')
    const { discard } = await import('./actions')
    const d = await draft({ step: 'failed', hasCode: false, history: [], answers: { name: 'B' } as never })
    setState({ onboarding: { open: true, mode: 'new', resumable: false }, onboardingDraft: d, onboardingProgress: { journalId: 'jr_7', steps: {}, clone: null } })
    api().ui = { confirm: vi.fn(async () => true) }
    api().onboarding.discard = vi.fn(async () => ({ undone: [] }))
    await discard()
    expect(api().onboarding.discard).toHaveBeenCalledWith({ journalId: 'jr_7' })
  })
})
