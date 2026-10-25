/**
 * Five doors A2 "one live source": the single computation behind every working and needs-you number and list (rail,
 * sidebar, LIVE, Home, Team, Chats, status bar, All companies, palette). Each surface takes a slice of the same
 * result, so two surfaces cannot disagree, and a run that ends drops out of all of them in the same render.
 *
 * Rules (the hub's, LIVE.md §6):
 * - Working: a root agent (subagents fold into it) that is starting or working, or a headless step waiting without an
 *   ask row, and that does not need you.
 * - Needs you: one item per open ask; one per root that needs you without an ask (a permission prompt the CLI shows,
 *   or an interactive turn that finished and was not looked at yet); plus the board tasks waiting on you that are not
 *   already a live ask (taskNeedsIn).
 * - Company: the agent's stamp, else its root's, its session's, its task run's; Personal only when none applies.
 *
 * Pure: no hive, no DOM. state/live.ts memoises it over the store.
 */
import { plainActivity } from './plainActivity'
import type { CompanyTask } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { Id, Session } from '@shared/types'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import { isLive, isUnseenIdle } from './live'
import type { LiveItem } from './companyModel'

type Stamped = { companyId?: Id | null }
export type LiveScope = Id | 'all' | undefined

export interface TruthInput {
  agents: Iterable<AgentNode & Stamped>
  asks: Iterable<Ask & Stamped>
  seen: ReadonlySet<Id>
  sessions: readonly Session[]
  /**
   * company tasks: a task run's agent belongs to the task's company even when the agent row has no stamp. With their
   * status, a task's run is working exactly while the task is in progress: a run of a task that moved on (paused, in
   * review) drops out at once, and a task that just started counts before its agent shows up ("Starting").
   */
  tasks?: readonly (Pick<CompanyTask, 'companyId' | 'runId'> & Partial<Pick<CompanyTask, 'id' | 'status' | 'title' | 'agentId' | 'updatedAt'>>)[]
  /** board tasks waiting on you per company, live asks excluded (taskNeedsIn per company) */
  taskNeeds?: Record<Id, number>
  /**
   * The companies the rail lists (archived ones are not). When given, an item of any other company drops out of every
   * slice: archiving Harbor takes its asks and tasks off All companies in the same render, so the counts agree.
   */
  listed?: ReadonlySet<Id>
  /** companies with a repository: the others read activity without developer words (pm-review C7) */
  code?: ReadonlySet<Id>
}

export interface LiveTruth {
  /** working roots, newest activity first */
  working: LiveItem[]
  /** asks and roots that need you, oldest first */
  needs: LiveItem[]
  taskNeeds: Record<Id, number>
  /** the resolved company of every known agent id (subagents included) */
  companyOf: (agentId: Id) => Id
}

export interface WorkingSlice {
  count: number
  items: LiveItem[]
  byCompany: Record<Id, number>
  /** agents of the team working (task runs, workflow steps): your own chats are not agents */
  agents: number
  /** your own chats that are live */
  chats: number
}
export interface NeedsSlice {
  /** every needs-you item of the scope: live items + board tasks */
  count: number
  /** live needs items (asks, finished turns) of the scope */
  items: LiveItem[]
  /** board tasks waiting on you in the scope (not a live ask) */
  tasks: number
  byCompany: Record<Id, number>
}

/** Company of an agent: own stamp, root's, session's, task run's; Personal last. */
export function truthResolver(input: Pick<TruthInput, 'agents' | 'sessions' | 'tasks'>): (a: (AgentNode & Stamped) | undefined, sessionId?: Id | null, runId?: Id | null) => Id {
  const byId = new Map<Id, AgentNode & Stamped>()
  for (const a of input.agents) byId.set(a.id, a)
  const sessionCo = new Map(input.sessions.map((s) => [s.id, (s as Session & Stamped).companyId || PERSONAL_COMPANY_ID]))
  const runCo = new Map<Id, Id>()
  for (const t of input.tasks ?? []) if (t.runId) runCo.set(t.runId, t.companyId)
  return (a, sessionId, runId) => {
    if (!a) return (sessionId && sessionCo.get(sessionId)) || (runId && runCo.get(runId)) || PERSONAL_COMPANY_ID
    if (a.companyId) return a.companyId
    const root = a.rootId !== a.id ? byId.get(a.rootId) : undefined
    if (root?.companyId) return root.companyId
    const sid = a.sessionId ?? root?.sessionId
    const rid = a.runId ?? root?.runId
    return (sid && sessionCo.get(sid)) || (rid && runCo.get(rid)) || PERSONAL_COMPANY_ID
  }
}

export function liveTruth(input: TruthInput): LiveTruth {
  const agents = [...input.agents]
  const resolve = truthResolver({ agents, sessions: input.sessions, tasks: input.tasks })
  const byId = new Map(agents.map((a) => [a.id, a]))
  const needs: LiveItem[] = []
  const working: LiveItem[] = []
  const withAsk = new Set<Id>()
  for (const ask of input.asks) {
    if (ask.status !== 'open') continue
    const agent = byId.get(ask.agentId)
    const root = byId.get(ask.rootId) ?? agent
    withAsk.add(ask.rootId)
    needs.push({
      key: `ask:${ask.id}`,
      companyId: ask.companyId || resolve(agent ?? root, ask.sessionId, ask.runId),
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
  // a task's run: in progress (working) or moved on (its run, if still reported live, is stale)
  const taskOfRun = new Map<Id, NonNullable<TruthInput['tasks']>[number]>()
  for (const t of input.tasks ?? []) if (t.runId && t.status) taskOfRun.set(t.runId, t)
  const covered = new Set<Id>()
  for (const a of agents) {
    if (!isLive(a)) continue
    if (a.runId) covered.add(a.runId)
    if (a.sessionId) covered.add(a.sessionId)
  }
  for (const ask of input.asks) if (ask.status === 'open') for (const k of [ask.runId, ask.sessionId]) if (k) covered.add(k)
  for (const a of agents) {
    if (a.kind === 'subagent' || withAsk.has(a.id) || !isLive(a)) continue
    const task = (a.runId && taskOfRun.get(a.runId)) || (a.sessionId && taskOfRun.get(a.sessionId)) || undefined
    // a run whose task is no longer in progress (paused, sent to review) stops counting in the same render
    if (task && a.kind !== 'session' && task.status !== 'in_progress') continue
    const chat = a.kind === 'session' && !task?.agentId
    const base = { companyId: resolve(a), agentId: a.id, askId: null, title: a.title, sessionId: a.sessionId, runId: a.runId, at: a.updatedAt, startedAt: a.startedAt ?? a.updatedAt, ...(task?.id ? { taskId: task.id } : {}), ...(chat ? { chat: true } : {}) }
    if (isUnseenIdle(a, input.seen)) needs.push({ ...base, key: `idle:${a.id}`, kind: 'idle', detail: 'Finished, your turn' })
    // a permission prompt shown by the CLI with no ask row yet: it waits on you all the same
    else if (a.status === 'needs_you' && a.needs !== 'idle' && a.needs !== null) needs.push({ ...base, key: `wait:${a.id}`, kind: 'ask', detail: a.activity ?? 'Waiting for you' })
    else if (a.status === 'working' || a.status === 'starting' || (a.status === 'needs_you' && a.kind !== 'session'))
      // §2.6: a sentence, never a raw tool line (`Bash cd "/private/…"`)
      working.push({ ...base, key: `work:${a.id}`, kind: 'working', detail: plainActivity(a.activity, input.code ? { code: input.code.has(base.companyId) } : {}) })
  }
  // a task that just started, before its agent reports in: it is working already (Team and the Board say so)
  for (const t of input.tasks ?? []) {
    if (t.status !== 'in_progress' || !t.runId || !t.agentId || !t.id || covered.has(t.runId)) continue
    const at = t.updatedAt ?? new Date().toISOString()
    working.push({ key: `task:${t.id}`, companyId: t.companyId, kind: 'working', agentId: '', askId: null, title: t.title ?? '', detail: 'Starting', sessionId: null, runId: t.runId, at, startedAt: at, taskId: t.id })
  }
  needs.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
  working.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
  const listed = input.listed?.size ? input.listed : null
  const keep = (i: { companyId: Id }): boolean => !listed || listed.has(i.companyId)
  const taskNeeds = listed ? Object.fromEntries(Object.entries(input.taskNeeds ?? {}).filter(([co]) => listed.has(co))) : (input.taskNeeds ?? {})
  return { working: working.filter(keep), needs: needs.filter(keep), taskNeeds, companyOf: (id) => resolve(byId.get(id)) }
}

const inScope = (companyId: Id, scope: LiveScope): boolean => !scope || scope === 'all' || companyId === scope

export function workingIn(t: LiveTruth, scope: LiveScope): WorkingSlice {
  const byCompany: Record<Id, number> = {}
  for (const i of t.working) byCompany[i.companyId] = (byCompany[i.companyId] ?? 0) + 1
  const items = t.working.filter((i) => inScope(i.companyId, scope))
  const chats = items.filter((i) => i.chat).length
  return { count: items.length, items, byCompany, agents: items.length - chats, chats }
}

export function needsIn(t: LiveTruth, scope: LiveScope): NeedsSlice {
  const byCompany: Record<Id, number> = {}
  for (const i of t.needs) byCompany[i.companyId] = (byCompany[i.companyId] ?? 0) + 1
  for (const [co, n] of Object.entries(t.taskNeeds)) if (n > 0) byCompany[co] = (byCompany[co] ?? 0) + n
  const items = t.needs.filter((i) => inScope(i.companyId, scope))
  let tasks = 0
  for (const [co, n] of Object.entries(t.taskNeeds)) if (inScope(co, scope)) tasks += Math.max(0, n)
  return { count: items.length + tasks, items, tasks, byCompany }
}

/** "1 working", "2 working"; "" when nothing works. */
export function workingLabel(n: number): string {
  return n > 0 ? `${n} working` : ''
}
/** "1 needs you", "3 need you"; "" when nothing waits. */
export function needsLabel(n: number): string {
  return n > 0 ? `${n} need${n === 1 ? 's' : ''} you` : ''
}
