/**
 * docs/DEMO.md: a fresh, fully synthetic Principia user-data folder to try every feature without setting anything up.
 * Run with `HIVE_USER_DATA=<dir> node scripts/seed-demo.mjs <dir>`, then open Principia on that folder.
 *
 * Three demo businesses, built through the app's own stores (Store, CompanyStore, DepartmentStore, ForumStore, the
 * engine and live stores, the Passport vault seed), so the result is exactly what the app would have written:
 * - Pinecone Coffee, a neighbourhood coffee shop: Marketing, Support, Ops; an agent that needed Instagram.
 * - Ledgerline, a small SaaS: a fixture git repository it creates under the folder, Development (a Codex developer),
 *   Marketing, Support; the open pull requests routine turned on.
 * - Brightline Studio, an agency, and its two clients (Juniper Yoga, Harlow Bikes), each tagged as a client.
 * Each gets tasks across the board's columns, Knowledge notes, Forum posts between its agents, and spend rows.
 *
 * Nothing here is real: no real people, emails, paths outside the folder, keys or tokens. Agents run on the Claude
 * and Codex profiles (the CLIs on this Mac); nothing starts by itself (Autopilot stays off).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { createEngineStore } from '../db/engineStore'
import { LiveStore } from '../db/liveStore'
import { CompanyStore } from '../company'
import { ForumStore } from '../forum/store'
import { describeWhen } from '../engine/scheduler'
import { seedVault } from '../memory/vault/seed'
import { resolvePersonas } from '../../shared/personas'
import { connectLink } from '../../shared/deepLink'
import { buildRoutine, planRoutine, routineDef, setRoutine, type CompanyRoutines, type RoutineContext } from '../../shared/routines'
import { renderNote, isoDate } from '../../shared/vault/serialize'
import { defaultFolder, sanitizeFilename } from '../../shared/vault/slug'
import { newNoteId } from '../../shared/vault/ids'
import { newId } from '../../shared/ids'
import type { BoardTask, CompanyAgent, CompanyTaskInput, Department, DepartmentPresetKey } from '../../shared/company'
import type { NoteType } from '../../shared/vault/grammar'
import type { AgentProfile, Id, Run } from '../../shared/types'

export interface DemoSeedResult {
  userData: string
  companies: { id: Id; name: string }[]
  tasks: number
  notes: number
  forumPosts: number
  repo: string | null
}

const DAY = 86_400_000

interface AgentSpec {
  dept: DepartmentPresetKey
  name: string
  adapter: 'claude' | 'codex'
  capabilities: string
}
type Col = 'todo' | 'review' | 'done' | 'ask' | 'deps'
interface TaskSpec {
  title: string
  description: string
  dept: DepartmentPresetKey
  col: Col
  /** review / done: what the agent reported */
  report?: string
  ask?: string
  comments?: string[]
}
interface NoteSpec {
  title: string
  type: NoteType
  summary: string
  facts: string[]
}
interface CompanySpec {
  name: string
  railLabel?: string
  client?: boolean
  mission: string
  brandVoice: string
  audience: string
  products: string
  goals: string
  departments: DepartmentPresetKey[]
  agents: AgentSpec[]
  tasks: TaskSpec[]
  notes: NoteSpec[]
  /** [author dept, text] in #general, the second replying in a thread to the first */
  forum: [DepartmentPresetKey, string][]
  /** days ago the company was created (Home suggestions wait a day) */
  age: number
  repo?: boolean
}

export function demoCompanies(): CompanySpec[] {
  return [
    {
      name: 'Pinecone Coffee',
      railLabel: 'PC',
      mission: 'A neighbourhood coffee shop and roastery with a weekly bean subscription.',
      brandVoice: 'Warm, plain-spoken, a little playful. Never pushy.',
      audience: 'Locals within a 15-minute walk, remote workers, weekend regulars.',
      products: 'Espresso drinks, pastries, the Weekly Beans subscription (12 dollars a bag).',
      goals: '- More Weekly Beans subscribers\n- Post on Instagram three times a week\n- Answer reviews within a day',
      departments: ['marketing', 'support', 'ops'],
      agents: [
        { dept: 'marketing', name: 'Content Writer', adapter: 'claude', capabilities: 'Writes posts, captions and the newsletter. Does not publish without approval.' },
        { dept: 'support', name: 'Support Lead', adapter: 'claude', capabilities: 'Drafts replies to reviews and emails. Escalates refunds.' },
        { dept: 'ops', name: 'Operations', adapter: 'claude', capabilities: 'Supplier orders, opening checklists, the weekly numbers.' }
      ],
      tasks: [
        { title: 'Draft three Instagram posts for the autumn menu', description: 'Pumpkin spice is out; the maple oat latte is in. Three posts, one with a photo idea each.', dept: 'marketing', col: 'review', report: `Drafted 3 posts for the maple oat latte launch.\n\n1. Monday: "Autumn has a new favourite. The maple oat latte is here, warm and not too sweet." Photo: the latte on the window ledge, morning light.\n2. Wednesday: "4.50 for a maple oat latte and a seat by the window. See you before work?" Photo: a laptop, a latte, the street outside.\n3. Friday: "Weekly Beans subscribers: this month's bean pairs perfectly with maple. Pick up Thursday to Sunday." Photo: a bag of beans next to the cup.\n\nTo post them straight from Principia, connect Instagram: ${'{{connect:instagram}}'}`, comments: ['Kept captions under 150 characters; the second one leads with the price.'] },
        { title: 'Reply to the two new Google reviews', description: 'One 5-star about the cinnamon bun, one 3-star about the wait on Saturday.', dept: 'support', col: 'review', report: 'Two replies drafted. The 3-star one thanks them, explains the Saturday queue and mentions the new mobile pre-order.' },
        { title: 'Weekly Beans: welcome email for new subscribers', description: 'A short welcome with how pickup works and the first bean of the month.', dept: 'marketing', col: 'done', report: 'Welcome email written and approved.' },
        { title: 'Order oat milk before the weekend', description: 'We ran out last Saturday. Check stock and draft the order for the supplier.', dept: 'ops', col: 'done', report: 'Draft order: 4 cases. Approved and placed by the owner.' },
        { title: 'Opening checklist for the new barista', description: 'One page, in the order things happen at 6:30.', dept: 'ops', col: 'done', report: 'Checklist written (14 steps), pinned in Knowledge.' },
        { title: 'Plan the loyalty card change', description: 'Ten stamps or a free bag of beans every eighth visit?', dept: 'marketing', col: 'ask', ask: 'Should the loyalty card reward a free drink after 10 stamps, or a free bag of beans after 8? I can draft either.' },
        { title: 'Holiday hours post', description: 'Once the holiday hours are decided, announce them on every channel.', dept: 'marketing', col: 'deps' },
        { title: 'Price list for the catering inquiry', description: 'A local office asked about coffee for 30 people every Friday.', dept: 'ops', col: 'todo' }
      ],
      notes: [
        { title: 'Weekly Beans', type: 'product', summary: 'The bean subscription: one 250 g bag a week, picked up in store.', facts: ['12 dollars a bag, billed monthly', 'Pickup Thursday to Sunday', '41 subscribers in October'] },
        { title: 'Regulars', type: 'customer', summary: 'Who comes in and when.', facts: ['Weekday mornings: remote workers, mostly oat flat whites', 'Saturday 9-11 is the rush; the queue goes out the door'] },
        { title: 'No discounts on Saturdays', type: 'decision', summary: 'Promotions run on weekdays only.', facts: ['Saturdays are already full; discounts there only lengthen the queue'] },
        { title: 'Supplier: Northside Dairy', type: 'person', summary: 'Oat and dairy milk supplier.', facts: ['Orders before Wednesday noon arrive Friday', 'Minimum order is 3 cases'] }
      ],
      forum: [
        ['marketing', 'The autumn posts are ready for review. I could post them myself if Instagram were connected; for now they wait in Needs you.'],
        ['ops', 'Noted. Oat milk is ordered for Friday, so the maple oat latte can launch this weekend.'],
        ['support', 'Tip for the owner: a morning brief every weekday would catch reviews like Saturday’s sooner. principia://automations/routines?add=morning-brief']
      ],
      age: 3
    },
    {
      name: 'Ledgerline',
      railLabel: 'LL',
      mission: 'Simple invoicing and expense tracking for freelancers.',
      brandVoice: 'Clear and precise. Short sentences, no jargon in customer copy.',
      audience: 'Freelance designers and developers who hate spreadsheets.',
      products: 'Ledgerline web app: free plan, Pro at 9 dollars a month.',
      goals: '- Ship recurring invoices\n- Cut support replies under 4 hours\n- 100 Pro customers',
      departments: ['development', 'marketing', 'support'],
      agents: [
        { dept: 'development', name: 'Developer', adapter: 'codex', capabilities: 'Builds features and fixes bugs in the ledgerline-app repository, with tests.' },
        { dept: 'marketing', name: 'Growth Writer', adapter: 'claude', capabilities: 'Changelog posts, landing page copy, the monthly newsletter.' },
        { dept: 'support', name: 'Support Agent', adapter: 'claude', capabilities: 'Answers customer questions, turns repeat bugs into tasks.' }
      ],
      tasks: [
        { title: 'Recurring invoices: monthly schedule', description: 'Let a user mark an invoice as monthly. Store the rule and generate the next one on the 1st.', dept: 'development', col: 'review', report: 'Added a `recurrence` field and a monthly generator with tests (12 passing). Branch: feat/recurring-invoices.', comments: ['Kept the generator idempotent: running it twice on the 1st makes one invoice.'] },
        { title: 'Fix: totals round wrong with 3 line items', description: 'A customer saw 10.01 instead of 10.00 on an invoice with three lines of 3.333.', dept: 'development', col: 'done', report: 'Summed the exact amounts and rounded once (rounding each line lost a cent). Regression test added.' },
        { title: 'Changelog post for recurring invoices', description: 'Announce it once it ships.', dept: 'marketing', col: 'deps' },
        { title: 'Answer: can I export to CSV?', description: 'Three customers asked this week.', dept: 'support', col: 'done', report: 'Replied with the export steps; added a help note to Knowledge.' },
        { title: 'Landing page: new pricing table', description: 'Free and Pro side by side, the yearly discount shown.', dept: 'marketing', col: 'review', report: 'Pricing table copy drafted with the yearly price (90 dollars). Needs your OK on the headline.' },
        { title: 'Dark mode for the invoice editor', description: 'Requested by several Pro users.', dept: 'development', col: 'todo' },
        { title: 'Which bank export formats first?', description: 'Bank import is next quarter; we need to pick the first two formats.', dept: 'development', col: 'ask', ask: 'For bank import, should I start with OFX and CSV, or CSV only to ship sooner?' }
      ],
      notes: [
        { title: 'Pro plan', type: 'offer', summary: '9 dollars a month or 90 a year.', facts: ['Unlimited invoices and clients', 'Recurring invoices are Pro-only'] },
        { title: 'Money is stored in cents', type: 'convention', summary: 'Every amount is an integer number of cents.', facts: ['Never use floats for money', 'Round per line item, then sum'] },
        { title: 'CSV export', type: 'process', summary: 'How customers export their invoices.', facts: ['Settings, then Export, then CSV', 'The export includes paid and unpaid invoices'] }
      ],
      forum: [
        ['development', 'Recurring invoices are in review. @support: once it ships, the CSV export also includes the recurrence column.'],
        ['support', 'Great, that answers two open questions. I will update the help note after the release.'],
        ['marketing', 'I will hold the changelog post until it is approved, so we announce what actually shipped.']
      ],
      age: 5,
      repo: true
    },
    {
      name: 'Brightline Studio',
      railLabel: 'BS',
      mission: 'A two-person brand and social media studio for local businesses.',
      brandVoice: 'Confident and friendly; we speak for each client in their own voice.',
      audience: 'Small local businesses that want a steady social presence.',
      products: 'Monthly social retainers, brand kits, launch campaigns.',
      goals: '- Deliver every client calendar by the 25th\n- Sign two new retainers',
      departments: ['marketing', 'sales', 'ops'],
      agents: [
        { dept: 'marketing', name: 'Social Lead', adapter: 'claude', capabilities: 'Plans and drafts each client’s content calendar in that client’s voice.' },
        { dept: 'sales', name: 'New Business', adapter: 'claude', capabilities: 'Researches leads and drafts proposals. Never sends without approval.' },
        { dept: 'ops', name: 'Studio Ops', adapter: 'codex', capabilities: 'Invoices, the client tracker, the monthly report.' }
      ],
      tasks: [
        { title: 'November calendar: Juniper Yoga', description: '12 posts: class schedule, two teacher spotlights, the winter retreat.', dept: 'marketing', col: 'review', report: `Calendar drafted: 12 posts with captions (Mon, Wed, Fri). Two need photos from the client: the winter retreat and the new teacher.\n\nWeek 1: class schedule carousel; "Slow mornings start here" (sunrise flow); teacher spotlight on Maya.\n\nThe calendar lives in this task for now. To share it with Juniper Yoga as a page they can comment on, connect Notion: ${'{{connect:notion}}'}` },
        { title: 'November calendar: Harlow Bikes', description: '10 posts around the winter tune-up offer.', dept: 'marketing', col: 'todo' },
        { title: 'Proposal for a bakery lead', description: 'Warm intro from Juniper Yoga. Retainer at the standard rate.', dept: 'sales', col: 'ask', ask: 'The bakery asked for a 3-month trial. Offer the standard retainer with a trial month, or a fixed 3-month package?' },
        { title: 'October report for both clients', description: 'Reach, saves and best post per client.', dept: 'ops', col: 'done', report: 'Both reports written and approved; sent by the owner.' },
        { title: 'Invoice Harlow Bikes for October', description: 'Retainer plus the extra reel.', dept: 'ops', col: 'done', report: 'Invoice drafted and approved.' },
        { title: 'Update the client tracker', description: 'Add the bakery lead and the renewal dates.', dept: 'ops', col: 'done', report: 'Tracker updated: 2 clients, 1 lead, renewals in January.' }
      ],
      notes: [
        { title: 'Juniper Yoga', type: 'customer', summary: 'Client since spring: a yoga studio with two locations.', facts: ['Voice: calm, warm, no exclamation marks', 'Posts Monday, Wednesday, Friday'] },
        { title: 'Harlow Bikes', type: 'customer', summary: 'Client: a bike repair and sales shop.', facts: ['Voice: practical, a bit of humour', 'Winter tune-up offer runs November to February'] },
        { title: 'Calendars due on the 25th', type: 'convention', summary: 'Every client gets next month’s calendar by the 25th.', facts: ['Drafts go to the client only after the owner approves'] }
      ],
      forum: [
        ['sales', '@marketing the bakery lead loved the Juniper Yoga feed. Could you pull three example posts for the proposal?'],
        ['marketing', 'Sure: the retreat announcement, the teacher spotlight and the class schedule carousel. Linking them in the proposal task.'],
        ['ops', 'Reminder: the November calendars are due on the 25th. Juniper is in review, Harlow starts this week.']
      ],
      age: 4
    }
  ]
}

const CLIENTS: { name: string; railLabel: string; mission: string; audience: string; products: string }[] = [
  { name: 'Juniper Yoga', railLabel: 'JY', mission: 'A yoga studio with two neighbourhood locations.', audience: 'Beginners and regulars, 25-55.', products: 'Drop-in classes, monthly memberships, a winter retreat.' },
  { name: 'Harlow Bikes', railLabel: 'HB', mission: 'Bike repairs, tune-ups and sales.', audience: 'Commuters and weekend riders.', products: 'Tune-ups from 45 dollars, new and used bikes.' }
]

/** A small fixture repository with a few synthetic commits (no network, no real author). */
export function createFixtureRepo(dir: string): string | null {
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Demo Developer', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Demo Developer', GIT_COMMITTER_EMAIL: 'dev@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    const git = (...args: string[]): void => void execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env, stdio: 'ignore' })
    git('init', '-q')
    const files: [string, string, string][] = [
      ['README.md', '# ledgerline-app\n\nSimple invoicing for freelancers (demo fixture).\n\n    npm test\n', 'Initial commit'],
      ['package.json', `${JSON.stringify({ name: 'ledgerline-app', private: true, version: '0.3.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, 'Add package.json'],
      ['src/money.js', "// Money is stored in cents.\nexport const toCents = (n) => Math.round(n * 100)\n// sum the exact amounts, round once (rounding each line first loses a cent)\nexport const total = (lines) => Math.round(lines.reduce((s, l) => s + l * 100, 0))\n", 'Sum exact amounts, round once'],
      ['src/money.test.js', "import test from 'node:test'\nimport assert from 'node:assert'\nimport { total } from './money.js'\ntest('three lines of 3.333 make 10.00', () => assert.equal(total([3.333, 3.333, 3.334]), 1000))\n", 'Regression test for rounding']
    ]
    for (const [file, text, msg] of files) {
      fs.writeFileSync(path.join(dir, file), text)
      git('add', file)
      git('commit', '-q', '-m', msg)
    }
    git('checkout', '-q', '-b', 'feat/recurring-invoices')
    fs.writeFileSync(path.join(dir, 'src', 'recurring.js'), "// Monthly invoices: one per rule per month, idempotent.\nexport const nextRun = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1)\n")
    git('add', 'src/recurring.js')
    git('commit', '-q', '-m', 'Recurring invoices: monthly generator')
    git('checkout', '-q', 'main')
    return dir
  } catch {
    return null // no git on this Mac: the SaaS still gets everything else
  }
}

/** Seeds a fresh user-data folder. Refuses a folder that already has a Principia database. */
export function seedDemo(userData: string, opts: { now?: Date } = {}): DemoSeedResult {
  const root = path.resolve(userData)
  const dbFile = path.join(root, 'hive.db')
  if (fs.existsSync(dbFile)) throw new Error(`${dbFile} already exists. Point the demo at a new, empty folder.`)
  fs.mkdirSync(root, { recursive: true })
  const now = opts.now ?? new Date()
  const db = openDatabase(dbFile)
  try {
    return seedInto(db, root, now)
  } finally {
    db.close()
  }
}

function seedInto(db: DB, root: string, now: Date): DemoSeedResult {
  const store = new Store(db)
  const companiesRoot = path.join(root, 'companies')
  const c = new CompanyStore(store, { companiesRoot })
  const engine = createEngineStore(db, { describe: () => describeWhen })
  const live = new LiveStore(db)
  const forum = new ForumStore(db, {
    directory: {
      departments: (id) => c.departments.list(id, { includeArchived: true }).map((d) => ({ id: d.id, key: d.key, name: d.name, archivedAt: d.archivedAt })),
      agents: (id) => {
        const agents = c.departments.listAgents({ companyId: id, includeArchived: true })
        const personas = resolvePersonas(agents, c.departments.list(id, { includeArchived: true }))
        return agents.map((a) => ({ id: a.id, departmentId: a.departmentId, name: a.name, archivedAt: a.archivedAt, personaName: personas.get(a.id)?.name ?? null }))
      },
      ownerName: () => 'You',
      hasCompany: (id) => c.listPassports({ includeArchived: true }).some((p) => p.id === id)
    }
  })

  store.updateSettings({ experimental: { companies: true, vault: true, departments: true }, onboardingDone: true, proactiveAgents: true, trackTasks: 'auto' })
  const profiles: Record<'claude' | 'codex', AgentProfile> = {
    claude: store.defaultProfileFor('claude') ?? store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false }, true),
    codex: store.defaultProfileFor('codex') ?? store.createProfile({ name: 'Codex', adapter: 'codex', permissionMode: 'bypass', secretNames: ['*'], useApiKeyAuth: false }, true)
  }
  for (const a of ['claude', 'codex']) store.setMeta(`seeded_profile:${a}`, now.toISOString())

  const out: DemoSeedResult = { userData: root, companies: [], tasks: 0, notes: 0, forumPosts: 0, repo: null }
  const routines: Record<Id, CompanyRoutines> = {}
  let firstId: Id | null = null

  for (const spec of demoCompanies()) {
    let repoId: Id | null = null
    if (spec.repo) {
      const dir = createFixtureRepo(path.join(root, 'demo-repos', 'ledgerline-app'))
      if (dir) {
        repoId = store.addRepo(dir)[0].id
        out.repo = dir
      }
    }
    const co = c.create({ name: spec.name, mission: spec.mission, brandVoice: spec.brandVoice, audience: spec.audience, products: spec.products, goals: spec.goals, repoIds: repoId ? [repoId] : [] })
    firstId ??= co.id
    if (spec.railLabel) c.update(co.id, { railLabel: spec.railLabel })
    backdate(db, co.id, new Date(now.getTime() - spec.age * DAY))
    out.companies.push({ id: co.id, name: co.name })

    const deps = c.departments.createPresets(co.id, spec.departments)
    const depOf = (k: DepartmentPresetKey): Department => deps.find((d) => d.key === k)!
    const agents = new Map<DepartmentPresetKey, CompanyAgent>()
    for (const a of spec.agents) {
      const seat = c.departments.saveAgent({ companyId: co.id, departmentId: depOf(a.dept).id, kind: 'profile', refId: profiles[a.adapter].id, name: a.name, data: { capabilities: a.capabilities, autonomy: 'manual', ...(a.dept === 'development' && repoId ? { defaultRepoId: repoId } : {}) } })
      agents.set(a.dept, seat)
    }

    const made: BoardTask[] = []
    for (const t of spec.tasks) made.push(seedTask(c, co.id, t, depOf(t.dept), agents.get(t.dept)!, repoId, made))
    out.tasks += made.length

    out.notes += seedNotes(c.vaultPathFor(co.id), co.id, co.name, spec, now)

    forum.sync(co.id)
    const general = forum.channelByName(co.id, 'general')!
    let rootId: string | null = null
    for (const [dept, text] of spec.forum) {
      const member = forum.memberForAgent(agents.get(dept)!.id)
      if (!member) continue
      const m = forum.post(member.id, { channelId: general.id, text, threadId: rootId, origin: 'demo' })
      rootId ??= m.id
      out.forumPosts++
    }

    seedSpend(engine, live, co.id, made, agents, new Set([profiles.codex.id]), now)

    if (spec.repo && repoId) {
      const ctx: RoutineContext = {
        companyId: co.id, companyName: co.name, departmentsOn: true, departments: deps, agents: [...agents.values()], dashboards: [], socials: [],
        profiles: [profiles.claude, profiles.codex], defaultAdapter: 'claude', tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', repoIds: [repoId],
        passport: { mission: spec.mission, audience: spec.audience, products: spec.products }
      }
      const plan = planRoutine(routineDef('repo-health'), ctx)
      const input = buildRoutine(plan, ctx).schedule(null)
      const { companyId, ...sched } = input
      const scheduleId = store.insertSchedule(sched, companyId)
      routines[co.id] = setRoutine(routines, co.id, 'repo-health', { scheduleId, workflowId: null, onAt: now.toISOString() })[co.id]!
    }

    if (spec.name === 'Brightline Studio')
      for (const cl of CLIENTS) {
        const client = c.create({ name: cl.name, mission: cl.mission, audience: cl.audience, products: cl.products, brandVoice: '', goals: '' })
        c.update(client.id, { client: true, railLabel: cl.railLabel })
        backdate(db, client.id, new Date(now.getTime() - spec.age * DAY))
        const [mkt] = c.departments.createPresets(client.id, ['marketing'])
        const seat = c.departments.saveAgent({ companyId: client.id, departmentId: mkt!.id, kind: 'profile', refId: profiles.claude.id, name: 'Social Writer', data: { capabilities: `Drafts ${cl.name} posts in its own voice.`, autonomy: 'manual' } })
        seedTask(c, client.id, { title: `Three posts for ${cl.name} next week`, description: 'Drafts for the owner to approve, then for the client.', dept: 'marketing', col: 'review', report: `Three drafts ready, each with a photo idea.\n\n1. ${cl.name === 'Harlow Bikes' ? '"Winter is coming for your chain. Tune-ups from 45 dollars, done in a day." Photo: a mechanic\'s hands on a gear.' : '"New to yoga? Our Monday beginners class is the gentlest start." Photo: the studio before class.'}\n2. ${cl.name === 'Harlow Bikes' ? '"Commuters: lights, fenders and a quick check, all in one visit." Photo: a bike at the door in the rain.' : '"Two locations, one calm hour. Find your nearest class." Photo: both studio doors side by side.'}\n3. ${cl.name === 'Harlow Bikes' ? '"Used bikes, checked and ready. Ask us what fits." Photo: three bikes in a row.' : '"The winter retreat has 6 places left." Photo: a mat by a window with snow outside.'}` }, mkt!, seat, null, [])
        out.tasks++
        out.notes += seedNotes(c.vaultPathFor(client.id), client.id, client.name, { notes: [] } as unknown as CompanySpec, now)
        forum.sync(client.id)
        out.companies.push({ id: client.id, name: client.name })
      }
  }

  // a new user never saw the old sidebar: no "Things moved" card
  store.updateSettings({ routines, activeCompanyId: firstId ?? 'all', notices: { 'things-moved': now.toISOString() } })
  return out
}

/** The company's creation time, for history (Home suggestions wait a day). */
function backdate(db: DB, companyId: Id, at: Date): void {
  db.prepare("UPDATE company_passports SET data = json_set(data, '$.createdAt', ?) WHERE id = ?").run(at.toISOString(), companyId)
}

function seedTask(c: CompanyStore, companyId: Id, t: TaskSpec, dep: Department, agent: CompanyAgent, repoId: Id | null, earlier: readonly BoardTask[]): BoardTask {
  const report = t.report?.replace(/\{\{connect:([a-z-]+)\}\}/g, (_, tool: string) => connectLink(tool, companyId))
  const depTask = t.col === 'deps' ? earlier.find((x) => x.status !== 'done') : undefined
  const base: CompanyTaskInput = {
    title: t.title, description: t.description, companyId, repoId: dep.key === 'development' ? repoId : null,
    status: t.col === 'ask' ? 'blocked' : t.col === 'deps' ? 'blocked' : t.col === 'todo' ? 'todo' : 'in_review',
    priority: t.col === 'ask' ? 2 : 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null,
    dependencyIds: depTask ? [depTask.id] : [], departmentId: dep.id, agentId: agent.id,
    ...(t.col === 'ask' ? { blockReason: 'needs_input' as const, ask: { kind: 'question' as const, prompt: t.ask ?? 'What should I do next?' } } : {})
  }
  let task = c.createTask(base)
  for (const m of t.comments ?? []) c.activity(task.id, 'comment', m, 'agent')
  if (t.col === 'review' || t.col === 'done') {
    task = c.patchInFlight(task.id, { report: { outcome: 'review', summary: report ?? 'Done.', evidence: [], at: new Date().toISOString() } })
    c.activity(task.id, 'report', report ?? 'Done.', 'agent')
  }
  if (t.col === 'done') task = c.approve(task.id, `Approved: ${report ?? t.title}`.slice(0, 400))
  return task
}

function seedNotes(vault: string, companyId: Id, name: string, spec: Pick<CompanySpec, 'notes' | 'mission'>, now: Date): number {
  seedVault(vault, { companyId, companyName: name, summary: spec.mission ?? null, now })
  const date = isoDate(now)
  let n = 0
  for (const note of spec.notes ?? []) {
    const folder = defaultFolder(note.type)
    const dir = folder ? path.join(vault, ...folder.split('/')) : vault
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${sanitizeFilename(note.title)}.md`)
    if (fs.existsSync(file)) continue
    const text = renderNote({
      id: newNoteId(), title: note.title, type: note.type, created: date, source: 'user', summary: note.summary,
      observations: note.facts.map((f) => ({ category: 'fact', text: f, prov: { actor: 'user' as const, date } })),
      relations: [{ rel: 'part_of', target: name, prov: { actor: 'user' as const, date } }]
    })
    fs.writeFileSync(file, text)
    n++
  }
  return n
}

/** Spend: one finished run per task that has a report, with the agent's tokens and cost, over the last ten days. */
function seedSpend(engine: ReturnType<typeof createEngineStore>, live: LiveStore, companyId: Id, tasks: readonly BoardTask[], agents: Map<DepartmentPresetKey, CompanyAgent>, codexProfiles: ReadonlySet<Id>, now: Date): void {
  const byId = new Map([...agents.values()].map((a) => [a.id, a]))
  tasks.forEach((t, i) => {
    if (!t.report || !t.agentId) return
    const agent = byId.get(t.agentId)
    if (!agent) return
    const codex = codexProfiles.has(agent.refId)
    const ended = new Date(now.getTime() - ((i * 37) % 10) * DAY - 3_600_000)
    const started = new Date(ended.getTime() - (6 + (i % 5) * 3) * 60_000)
    const run: Run = {
      id: newId('run'), kind: 'prompt', title: t.title.slice(0, 60), target: { kind: 'prompt', profileId: agent.refId, repoId: t.repoId, prompt: t.title },
      workflowId: null, scheduleId: null, parentRunId: null, trigger: 'task', status: 'passed', reason: null,
      createdAt: started.toISOString(), startedAt: started.toISOString(), endedAt: ended.toISOString(), artifactsDir: '', artifactCount: 0, companyId
    }
    engine.insertRun(run, null, { taskId: t.id, agentId: agent.id })
    const tokensIn = 18_000 + ((i * 7919) % 40_000)
    const tokensOut = 2_000 + ((i * 104_729) % 6_000)
    const id = newId('agent')
    live.insertAgent({
      id, kind: 'step', parentId: null, rootId: id, sessionId: null, runId: run.id, stepId: null, provider: codex ? 'codex' : 'claude', repoId: t.repoId, cwd: '',
      title: t.title, agentType: null, externalId: null, toolUseId: null, model: codex ? 'gpt-5-codex' : 'claude-sonnet-5', depth: 0, background: false, attribution: 'exact',
      status: 'done', needs: null, activity: null, lastTool: null, toolCount: 4 + (i % 9), memReads: i % 3, filesTouched: [], tokensIn, tokensOut,
      costUsd: codex ? null : Math.round((tokensIn * 3 + tokensOut * 15) / 10_000) / 100, modelUsage: null, report: t.report.summary,
      startedAt: started.toISOString(), updatedAt: ended.toISOString(), endedAt: ended.toISOString(), companyId
    } as Parameters<LiveStore['insertAgent']>[0])
  })
}
