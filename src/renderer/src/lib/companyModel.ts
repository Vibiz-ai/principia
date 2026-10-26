/**
 * Pure company helpers for the shell (COMPANY.md §8): ordering, badges and the Needs-you list. No hive / DOM access,
 * so the store, the rail, the sidebar and the tests share one implementation.
 */
import type { CompanyOverview, CompanyPassport, CompanyTask } from '@shared/company'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import { taskLane, type LaneContext } from './departments'
import type { AgentNode, Ask } from '@shared/live'
import type { Id, Repo, Session, Workflow } from '@shared/types'
import { liveTruth, needsIn, truthResolver, workingIn, type LiveTruth, type TruthInput } from './liveTruth'

export type ActiveCompany = Id | 'all'

/** A row's company: NULL / missing stamps read as Personal (§1.4). */
export function companyOf(x: { companyId?: Id | null } | null | undefined): Id {
  return x?.companyId || PERSONAL_COMPANY_ID
}

export function isPersonal(c: Pick<CompanyPassport, 'id' | 'system'>): boolean {
  return c.id === PERSONAL_COMPANY_ID || c.system === 'personal'
}

/** Rail / sidebar order: archived hidden, `sortOrder`, then name; Personal / Unassigned always last (§2.2). */
export function sortCompanies(list: CompanyPassport[]): CompanyPassport[] {
  return list
    .filter((c) => !c.archivedAt)
    .sort((a, b) => Number(isPersonal(a)) - Number(isPersonal(b)) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
}

/** §8.1: the rail and company grouping show once there is Personal plus one; a Personal-only user sees no change. */
export function isMultiCompany(companies: readonly Pick<CompanyPassport, 'id'>[]): boolean {
  return companies.length >= 2
}

/**
 * The label the UI uses. Five doors §2.7: "Personal / Unassigned" is just **Personal** everywhere now (rail, palette,
 * menus); `long` is kept for callers that used to ask for the long form.
 */
export function companyLabel(c: Pick<CompanyPassport, 'id' | 'system' | 'name'>, _long = false): string {
  return c.name
}

export function companyInitials(name: string): string {
  const words = name.trim().split(/[\s_\-./]+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/**
 * Five doors E14: what a company's rail tile says: its own short label (1-3 characters) when set, else its initials.
 * Personal is the person glyph, never letters.
 */
export function railText(c: Pick<CompanyPassport, 'name' | 'railLabel'>): string {
  return (c.railLabel ?? '').trim().toUpperCase() || companyInitials(c.name)
}
/** The rail's hover label: "Harbor Dental Group · client". */
export function railName(c: Pick<CompanyPassport, 'name' | 'client'>): string {
  return c.client ? `${c.name} · client` : c.name
}
/**
 * Five doors E14: the other companies whose tile would look the same as this one (same letters and same colour), so
 * Company settings can say "Harbor Health looks the same on the rail" before an agency mixes up two clients.
 */
export function railLookAlikes<C extends Pick<CompanyPassport, 'id' | 'name' | 'railLabel' | 'color' | 'system' | 'archivedAt'>>(c: C, companies: readonly C[], rgbOf?: (color: string) => Rgb | null): C[] {
  const text = railText(c)
  const same = (a: string, b: string): boolean => {
    if (a === b) return true
    const x = rgbOf?.(a)
    const y = rgbOf?.(b)
    return !!x && !!y && colorsNear(x, y)
  }
  return companies.filter((o) => o.id !== c.id && !isPersonal(o) && !o.archivedAt && railText(o) === text && same(o.color || '', c.color || ''))
}

export type Rgb = readonly [number, number, number]
/** "#3987e5" or "rgb(57, 135, 229)" as [r, g, b]; null for anything else. */
export function parseRgb(css: string): Rgb | null {
  const v = css.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v)
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null
}
/**
 * Two colours a person would call the same on a rail tile at a glance: the same hue family and close in brightness
 * (#6e8cff accent beside #3987e5 Blue reads "the same blue"; Blue beside Cyan or Purple does not). A redmean distance.
 */
export function colorsNear(a: Rgb, b: Rgb, max = 100): boolean {
  const r = (a[0] + b[0]) / 2
  const [dr, dg, db] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db) <= max
}

/**
 * "13 agents · 3 companies": the same company count as the sidebar header (Personal is not a company you run), with
 * Personal named only when it has agents of its own.
 */
export function teamMeta(seats: { companyId: string }[], companies: Pick<CompanyPassport, 'id' | 'system'>[], grouped: boolean): string {
  const agents = `${seats.length} agent${seats.length === 1 ? '' : 's'}`
  if (!grouped) return agents
  const real = companies.filter((c) => !isPersonal(c))
  const personalSeats = companies.some((c) => isPersonal(c) && seats.some((a) => a.companyId === c.id))
  return `${agents} · ${real.length} compan${real.length === 1 ? 'y' : 'ies'}${personalSeats ? ' and Personal' : ''}`
}

/**
 * A4: the pause / resume toast. Pausing says what was saved ("Pliny's work on “Competitor research” is saved; Pliny
 * continues when you resume.") and, with other companies, "Other companies keep running." (never one company's name);
 * resuming says what continues.
 */
export function pauseToastText(company: string, saved: readonly { agentName: string | null; title: string }[], paused: boolean, others = true): string {
  const one = saved.length === 1 ? saved[0]! : null
  if (!paused) {
    const cont = one ? ` ${one.agentName ?? 'Its agent'} continues “${one.title}”.` : saved.length ? ` ${saved.length} saved tasks continue.` : ''
    return `Resumed ${company}.${cont}`
  }
  const work = one
    ? ` ${one.agentName ? `${one.agentName}’s` : 'The'} work on “${one.title}” is saved; ${one.agentName ?? 'it'} continues when you resume.`
    : saved.length
      ? ` Work on ${saved.length} tasks is saved; it continues when you resume.`
      : ''
  return `Paused ${company}.${work}${others ? ' Other companies keep running.' : ''}`
}
/** A4: a company is paused when its row says so (company:pause), the one rule every surface reads. */
export function isCompanyPaused(c: Pick<CompanyPassport, 'pausedAt'> | null | undefined): boolean {
  return !!c?.pausedAt
}
/** A company reads "paused" when it has agents and every one of them is paused (header, rail card, rail title). */
export function companyPaused(seats: readonly { companyId: Id; pausedAt: string | null; archivedAt?: string | null }[], companyId: Id): boolean {
  const own = seats.filter((a) => a.companyId === companyId && !a.archivedAt)
  return own.length > 0 && own.every((a) => !!a.pausedAt)
}

/** ⌃1…⌃9: the Nth company in rail order (1-based). */
export function companyAtSlot(companies: CompanyPassport[], n: number): CompanyPassport | undefined {
  return n >= 1 ? companies[n - 1] : undefined
}

/** `Principia — {Company | All companies} — {View}`; no company part for a Personal-only user (§8.4). */
export function windowTitle(view: string, company: CompanyPassport | null | 'all', multi: boolean): string {
  if (!multi) return `Principia — ${view}`
  return `Principia — ${company === 'all' || !company ? 'All companies' : company.name} — ${view}`
}

/** Move `id` next to `targetId` in an id list (rail drag reorder). Unknown ids leave the list unchanged. */
export function reorderIds(ids: Id[], id: Id, targetId: Id, placement: 'before' | 'after'): Id[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids
  const rest = ids.filter((x) => x !== id)
  const at = rest.indexOf(targetId) + (placement === 'after' ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** One company's repos in its own `repo_order:<companyId>` (falls back to the list order). */
export function reposOf(repos: Repo[], companyId: Id): Repo[] {
  return repos
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => companyOf(r) === companyId)
    .sort((a, b) => (a.r.companyOrder ?? a.i) - (b.r.companyOrder ?? b.i) || a.i - b.i)
    .map(({ r }) => r)
}

/** Workflows with a node or worktree aimed at this repo: listed in the "move repo to company" confirm (§8.3). */
export function workflowsTargetingRepo(workflows: Workflow[], repoId: Id): Workflow[] {
  return workflows.filter((w) => w.worktree?.repo === repoId || w.nodes.some((n) => n.cwd === repoId))
}

// ---------- live badges ----------
type StampedAgent = AgentNode & { companyId?: Id | null }
type StampedAsk = Ask & { companyId?: Id | null }

export interface CompanyBadge {
  /** open asks + unseen idle session roots (the same rule as the global Needs-you count) */
  needsYou: number
  /** working or starting root agents (sessions and run steps) */
  working: number
  /** a run failed in the last 24 h (from company:overview, refreshed on run updates) */
  failed: boolean
}
export interface BadgeInput {
  companies: Pick<CompanyPassport, 'id'>[]
  agents: Iterable<StampedAgent>
  asks: Iterable<StampedAsk>
  seen: ReadonlySet<Id>
  sessions: Session[]
  overview?: Record<Id, Pick<CompanyOverview, 'failed24h'> & Partial<Pick<CompanyOverview, 'working'>>>
}

/**
 * Resolves an agent's company: its own stamp, else its root's, else the session it runs in, else (with `tasks`) the
 * task its run works on, else Personal. One implementation with the live source (liveTruth.truthResolver).
 */
export function agentCompanyResolver(agents: Iterable<StampedAgent>, sessions: Session[], tasks?: TruthInput['tasks']): (a: StampedAgent | undefined, sessionId?: Id | null) => Id {
  const r = truthResolver({ agents, sessions, tasks })
  return (a, sessionId) => r(a, sessionId)
}

/**
 * Per-company badges, a slice of the one live source (lib/liveTruth.ts): needs you (live items, plus board tasks when
 * `taskNeeds` is given), working roots, and the failed-in-24 h flag from company:overview. The overview's own working
 * count is not mixed in any more: it lagged run ends, so a finished run kept its working ring (five doors A2).
 */
export function companyBadges(input: BadgeInput & { tasks?: TruthInput['tasks']; taskNeeds?: Record<Id, number> }): { byCompany: Record<Id, CompanyBadge>; total: CompanyBadge } {
  const truth = liveTruth({ agents: input.agents, asks: input.asks, seen: input.seen, sessions: input.sessions, tasks: input.tasks, taskNeeds: input.taskNeeds })
  return badgesFromTruth(truth, input.companies, input.overview)
}
export function badgesFromTruth(truth: LiveTruth, companies: readonly Pick<CompanyPassport, 'id'>[], overview?: BadgeInput['overview']): { byCompany: Record<Id, CompanyBadge>; total: CompanyBadge } {
  const byCompany: Record<Id, CompanyBadge> = {}
  const slot = (id: Id): CompanyBadge => (byCompany[id] ??= { needsYou: 0, working: 0, failed: false })
  for (const c of companies) slot(c.id).failed = (overview?.[c.id]?.failed24h ?? 0) > 0
  for (const [id, n] of Object.entries(needsIn(truth, 'all').byCompany)) slot(id).needsYou = n
  for (const [id, n] of Object.entries(workingIn(truth, 'all').byCompany)) slot(id).working = n
  const total: CompanyBadge = { needsYou: 0, working: 0, failed: false }
  for (const b of Object.values(byCompany)) {
    total.needsYou += b.needsYou
    total.working += b.working
    total.failed ||= b.failed
  }
  return { byCompany, total }
}

export const EMPTY_BADGE: CompanyBadge = Object.freeze({ needsYou: 0, working: 0, failed: false }) as CompanyBadge

// ---------- Needs you / live rows ----------
export interface LiveItem {
  key: string
  companyId: Id
  kind: 'ask' | 'idle' | 'working'
  agentId: Id
  askId: Id | null
  title: string
  detail: string | null
  sessionId: Id | null
  runId: Id | null
  at: string
  /** when the work began (the agent's start, or its task's start before the agent shows up): every elapsed time reads it */
  startedAt?: string
  /** the board task this item works on, when it is one */
  taskId?: Id
  /** your own chat (a session with no task): live, but not an agent of the team */
  chat?: boolean
}

/**
 * Every open ask plus every unseen idle session root, oldest first, each with its company (All-mode "Needs you",
 * rail popovers). With `working`, live working roots follow (rail popover only).
 */
export function liveItems(input: Omit<BadgeInput, 'companies' | 'overview'> & { working?: boolean; companyId?: Id; tasks?: TruthInput['tasks'] }): LiveItem[] {
  return itemsFromTruth(liveTruth({ agents: input.agents, asks: input.asks, seen: input.seen, sessions: input.sessions, tasks: input.tasks }), input)
}
/** Needs-you rows (oldest first), then with `working` the working roots (newest first), of one company or all. */
export function itemsFromTruth(truth: LiveTruth, opts: { working?: boolean; companyId?: Id }): LiveItem[] {
  const scope = opts.companyId ?? 'all'
  return [...needsIn(truth, scope).items, ...(opts.working ? workingIn(truth, scope).items : [])]
}

/** The company a cross-company open should focus, or null when no switch is needed (All mode or the same company). */
export function switchTarget(active: ActiveCompany, multi: boolean, target: Id | null | undefined, known?: (id: Id) => boolean): Id | null {
  if (!multi || active === 'all' || !target || target === active) return null
  // an archived or unknown company has no rail tile or sidebar: focusing it would leave an empty, unnamed scope
  if (known && !known(target)) return null
  return target
}

/**
 * §8.3 "groups with needs-you auto-expand": a folded group peeks open whenever its needs-you count grows, and a fold
 * while it peeks holds until the next new item (not just the first one after a quiet spell).
 */
export function nextGroupPeek(peek: boolean, prevNeeds: number, needs: number): boolean {
  return needs > prevNeeds ? true : peek
}

/** The focus the UI can show: 'all' when the company is gone or archived (or before the list has loaded). */
export function effectiveCompany(active: ActiveCompany, companies: Pick<CompanyPassport, 'id'>[]): ActiveCompany {
  if (!isMultiCompany(companies) || active === 'all') return 'all'
  return companies.some((c) => c.id === active) ? active : 'all'
}

/**
 * Rows of the companies the rail lists: an archived company's tasks leave every surface (Board, Home, All companies,
 * counts) until it is unarchived. Before the company list has loaded (or when it failed) nothing is dropped.
 */
export function listedRows<T extends { companyId?: Id | null }>(rows: T[], companies: readonly Pick<CompanyPassport, 'id'>[]): T[] {
  if (!companies.length) return rows
  const ids = new Set(companies.map((c) => c.id))
  const out = rows.filter((r) => ids.has(r.companyId || PERSONAL_COMPANY_ID))
  return out.length === rows.length ? rows : out
}

/**
 * Personal is the catch-all for unstamped rows (§1.4). If main lists companies without it (a failed backfill), add a
 * placeholder so Personal's repos, chats and badges still have a group instead of disappearing from All mode.
 */
export function withPersonal(list: CompanyPassport[]): CompanyPassport[] {
  if (!list.length || list.some(isPersonal)) return list
  const personal: CompanyPassport = {
    id: PERSONAL_COMPANY_ID, name: 'Personal', slug: 'personal', color: 'var(--series-other)', sortOrder: Number.MAX_SAFE_INTEGER, system: 'personal', archivedAt: null, vaultPath: null,
    mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds: [], createdAt: '', updatedAt: ''
  }
  return [...list, personal]
}

// ---------- board counts (DEPARTMENTS.md §9) ----------
export interface TaskCounts {
  working: number
  needsYou: number
  /** done (approved) since local midnight */
  doneToday: number
  /** of needsYou, running tasks there only because their run has an open live ask (that ask is listed on its own) */
  liveAsks?: number
}
/**
 * Board tasks waiting on you in a scope (undefined = every company), the part of Home's Needs you that is not a live
 * ask: a running task waiting on a live ask is already counted as that ask. Home's header and the sidebar Home badge
 * both add it, so they show the same number.
 */
export function taskNeedsIn(counts: Record<Id, TaskCounts>, scope?: Id): number {
  let n = 0
  for (const [id, c] of Object.entries(counts)) if (!scope || id === scope) n += Math.max(0, c.needsYou - (c.liveAsks ?? 0))
  return n
}
export const EMPTY_TASK_COUNTS: TaskCounts = Object.freeze({ working: 0, needsYou: 0, doneToday: 0 }) as TaskCounts

/** Local midnight of `now`, as an ISO string comparable with task timestamps. */
export function startOfDay(now: Date): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** Per-company "N working · N need you · N done today", every task counted through laneOf (taskLane). */
export function taskCounts(tasks: CompanyTask[], ctx: LaneContext, now: Date = new Date()): Record<Id, TaskCounts> {
  const midnight = startOfDay(now)
  const out: Record<Id, TaskCounts> = {}
  for (const t of tasks) {
    const lane = taskLane(t, ctx)
    const c = (out[t.companyId] ??= { working: 0, needsYou: 0, doneToday: 0 })
    if (lane === 'working') c.working++
    else if (lane === 'needs_you') {
      c.needsYou++
      if (t.status === 'in_progress') c.liveAsks = (c.liveAsks ?? 0) + 1
    } else if (t.status === 'done' && t.updatedAt >= midnight) c.doneToday++
  }
  return out
}

/** "3 working · 2 need you · 5 done today"; null when the board is quiet (nothing in any of the three). */
export function taskCountsLine(c: TaskCounts | undefined): string | null {
  if (!c || (!c.working && !c.needsYou && !c.doneToday)) return null
  return `${c.working} working · ${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you · ${c.doneToday} done today`
}
