/**
 * Pure company helpers for the shell (COMPANY.md §8): ordering, badges and the Needs-you list. No hive / DOM access,
 * so the store, the rail, the sidebar and the tests share one implementation.
 */
import type { CompanyOverview, CompanyPassport, CompanyTask } from '@shared/company'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import { taskLane, type LaneContext } from './departments'
import type { AgentNode, Ask } from '@shared/live'
import type { Id, Repo, Session, Workflow } from '@shared/types'
import { isLive, isUnseenIdle } from './live'

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

/** The label the UI uses: Personal reads "Personal / Unassigned" in lists (§2.2). */
export function companyLabel(c: Pick<CompanyPassport, 'id' | 'system' | 'name'>, long = false): string {
  return long && isPersonal(c) && c.name === 'Personal' ? 'Personal / Unassigned' : c.name
}

export function companyInitials(name: string): string {
  const words = name.trim().split(/[\s_\-./]+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
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
 * Resolves an agent's company: its own stamp, else its root's, else the session it runs in, else Personal. Older
 * mains (before C3) send no stamps; the session fallback keeps badges right for interactive work in that case.
 */
export function agentCompanyResolver(agents: Iterable<StampedAgent>, sessions: Session[]): (a: StampedAgent | undefined, sessionId?: Id | null) => Id {
  const byId = new Map<Id, StampedAgent>()
  for (const a of agents) byId.set(a.id, a)
  const sessionCo = new Map(sessions.map((s) => [s.id, companyOf(s)]))
  // `sessionId`: an ask whose agent is not loaded (yet) still lands in its session's company, not Personal
  return (a, sessionId) => {
    if (!a) return (sessionId && sessionCo.get(sessionId)) || PERSONAL_COMPANY_ID
    if (a.companyId) return a.companyId
    const root = a.rootId !== a.id ? byId.get(a.rootId) : undefined
    if (root?.companyId) return root.companyId
    const sid = a.sessionId ?? root?.sessionId
    return (sid && sessionCo.get(sid)) || PERSONAL_COMPANY_ID
  }
}

export function companyBadges(input: BadgeInput): { byCompany: Record<Id, CompanyBadge>; total: CompanyBadge } {
  const agents = [...input.agents]
  const resolve = agentCompanyResolver(agents, input.sessions)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const byCompany: Record<Id, CompanyBadge> = {}
  const slot = (id: Id): CompanyBadge => (byCompany[id] ??= { needsYou: 0, working: 0, failed: false })
  for (const c of input.companies) slot(c.id).failed = (input.overview?.[c.id]?.failed24h ?? 0) > 0
  for (const ask of input.asks) {
    if (ask.status !== 'open') continue
    slot(ask.companyId || resolve(byId.get(ask.agentId) ?? byId.get(ask.rootId), ask.sessionId)).needsYou++
  }
  for (const a of agents) {
    if (a.kind === 'subagent') continue
    if (isUnseenIdle(a, input.seen)) slot(resolve(a)).needsYou++
    else if (a.status === 'working' || a.status === 'starting') slot(resolve(a)).working++
  }
  // §8.2: queued/running runs count too (a shell-only run has no agent); main's overview counts root agents plus runs,
  // so the larger of the two never double counts and stays live between overview refreshes
  for (const c of input.companies) {
    const w = input.overview?.[c.id]?.working ?? 0
    if (w > (byCompany[c.id]?.working ?? 0)) slot(c.id).working = w
  }
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
}

/**
 * Every open ask plus every unseen idle session root, oldest first, each with its company (All-mode "Needs you",
 * rail popovers). With `working`, live working roots follow (rail popover only).
 */
export function liveItems(input: Omit<BadgeInput, 'companies' | 'overview'> & { working?: boolean; companyId?: Id }): LiveItem[] {
  const agents = [...input.agents]
  const resolve = agentCompanyResolver(agents, input.sessions)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const out: LiveItem[] = []
  const withAsk = new Set<Id>()
  for (const ask of input.asks) {
    if (ask.status !== 'open') continue
    const agent = byId.get(ask.agentId)
    const root = byId.get(ask.rootId) ?? agent
    withAsk.add(ask.rootId)
    out.push({
      key: `ask:${ask.id}`,
      companyId: ask.companyId || resolve(agent ?? root, ask.sessionId),
      kind: 'ask',
      agentId: ask.agentId,
      askId: ask.id,
      title: ask.kind === 'question' ? (ask.question ?? ask.title) : ask.title,
      detail: root?.title ?? null,
      sessionId: ask.sessionId,
      runId: ask.runId,
      at: ask.createdAt
    })
  }
  const working: LiveItem[] = []
  for (const a of agents) {
    if (a.kind === 'subagent' || withAsk.has(a.id)) continue
    const base = { companyId: resolve(a), agentId: a.id, askId: null, title: a.title, sessionId: a.sessionId, runId: a.runId, at: a.updatedAt }
    if (isUnseenIdle(a, input.seen)) out.push({ ...base, key: `idle:${a.id}`, kind: 'idle', detail: 'Finished, your turn' })
    else if (input.working && isLive(a) && (a.status === 'working' || a.status === 'starting')) working.push({ ...base, key: `work:${a.id}`, kind: 'working', detail: a.activity })
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  working.sort((a, b) => (a.at < b.at ? 1 : -1))
  const all = [...out, ...working]
  return input.companyId ? all.filter((i) => i.companyId === input.companyId) : all
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
