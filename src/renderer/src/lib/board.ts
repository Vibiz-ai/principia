/**
 * DEPARTMENTS.md §9 Board: pure helpers behind the kanban, list, drag and drop, the inspector timeline, Needs you and
 * the Home Overnight strip. Lanes come from `taskLane` (laneOf with the renderer's live inputs, lib/departments), so a
 * card's column, its reason chip and every count agree. No hive / DOM access: the tests drive these directly.
 */
import { LANE_LABELS, TASK_LANES, agentActive, type BlockReason, type BoardSettings, type CompanyAgent, type CompanyTask, type Department, type NeedsYouReason, type TaskActivity, type TaskActivityKind, type TaskLane } from '@shared/company'
import type { Id } from '@shared/types'
import { taskDepartment, taskLane, taskReason, type LaneContext } from './departments'

export const BOARD_LANES = TASK_LANES
export { LANE_LABELS }

/** The short chip on a Needs you card (and the list view's lane/reason column). */
export const REASON_LABEL: Record<NeedsYouReason, string> = {
  review: 'Review', live_ask: 'Asking', unassigned: 'Unassigned', blocked: 'Blocked',
  deps: 'Waiting on dependencies', needs_input: 'Question', run_failed: 'Run failed', interrupted: 'Interrupted', no_report: 'No report',
  limit: 'Limit reached', agent: 'Agent is blocked', handoff_cap: 'Too many handoffs', manual: 'Parked'
}
/** Why a parked task is parked, in a sentence (inspector, Needs you tooltip). */
export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  deps: 'Waiting for its dependencies to be done. It moves back to the queue by itself.',
  needs_input: 'The agent asked a question. Answer it and the same agent picks the task back up.',
  run_failed: 'The run failed. Check the run, then Unpark or Run now.',
  interrupted: 'The app quit while the task was running. It is never restarted by itself.',
  no_report: 'The run stopped without reporting back. Check what it did, then Unpark or Run now.',
  limit: 'A time or wake limit was reached. Unpark to let it continue.',
  agent: 'The agent reported it is blocked. Read its report, then Unpark or reassign.',
  handoff_cap: 'The task was handed off too many times. Pick an agent, then Unpark.',
  manual: 'Parked by hand. Unpark when it should go back to the queue.'
}

/** Lower number is more urgent; 0 = no priority sorts last. */
const prio = (p: number): number => (p === 0 ? 9 : p)
const newer = (a: CompanyTask, b: CompanyTask): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)
/** Column order: most urgent first, then most recently touched. Done is newest first only. */
export function sortForLane(lane: TaskLane, list: CompanyTask[]): CompanyTask[] {
  return [...list].sort(lane === 'done' ? newer : (a, b) => prio(a.priority) - prio(b.priority) || newer(a, b))
}

export interface BoardFilter {
  /** All mode passes undefined (every company) */
  companyId?: Id
  departmentId?: Id | null
  agentId?: Id | null
  search?: string
  /** the Backlog toggle: off hides backlog tasks from Queued */
  showBacklog?: boolean
}
export function filterTasks(tasks: CompanyTask[], f: BoardFilter, ctx: LaneContext): CompanyTask[] {
  const q = f.search?.trim().toLowerCase()
  return tasks.filter((t) =>
    (!f.companyId || t.companyId === f.companyId) &&
    (!f.departmentId || taskDepartment(t, ctx) === f.departmentId) &&
    (!f.agentId || t.agentId === f.agentId) &&
    // a plan's tasks wait in Backlog for the plan pilot: they show either way, so an approved plan is visible on the Board
    (f.showBacklog !== false || t.status !== 'backlog' || !!t.plan) &&
    (!q || `${t.identifier} ${t.title} ${t.description}`.toLowerCase().includes(q)))
}

/** The five kanban columns. Every task lands in exactly the column laneOf names. */
export function laneColumns(tasks: CompanyTask[], ctx: LaneContext): Record<TaskLane, CompanyTask[]> {
  const out = Object.fromEntries(BOARD_LANES.map((l) => [l, [] as CompanyTask[]])) as Record<TaskLane, CompanyTask[]>
  for (const t of tasks) out[taskLane(t, ctx)].push(t)
  for (const l of BOARD_LANES) out[l] = sortForLane(l, out[l])
  return out
}

export interface Swimlane {
  /** null = tasks with no department */
  department: Department | null
  columns: Record<TaskLane, CompanyTask[]>
  count: number
}
/** Swimlanes by department: the given departments in order (empty ones included), then "No department" when used. */
export function swimlanes(tasks: CompanyTask[], departments: Department[], ctx: LaneContext): Swimlane[] {
  const by = new Map<Id | null, CompanyTask[]>()
  const known = new Set(departments.map((d) => d.id))
  for (const t of tasks) {
    const d = taskDepartment(t, ctx)
    const key = d && known.has(d) ? d : null
    by.set(key, [...(by.get(key) ?? []), t])
  }
  const lanes: Swimlane[] = departments.map((d) => ({ department: d, columns: laneColumns(by.get(d.id) ?? [], ctx), count: by.get(d.id)?.length ?? 0 }))
  const loose = by.get(null) ?? []
  if (loose.length) lanes.push({ department: null, columns: laneColumns(loose, ctx), count: loose.length })
  return lanes
}

/** The list view's lane/reason cell: "Needs you · Question", "Working", "Queued · Waiting on dependencies". */
export function laneText(t: CompanyTask, ctx: LaneContext): string {
  const lane = taskLane(t, ctx)
  const reason = taskReason(t, ctx)
  if (reason) return `${LANE_LABELS[lane]} · ${REASON_LABEL[reason]}`
  if (t.status === 'blocked' && t.blockReason === 'deps') return `${LANE_LABELS[lane]} · ${REASON_LABEL.deps}`
  if (t.status === 'backlog') return `${LANE_LABELS[lane]} · Backlog`
  if (t.status === 'canceled') return `${LANE_LABELS[lane]} · Canceled`
  return LANE_LABELS[lane]
}

// ---------- drag and drop ----------

/** What a legal drop does; the board turns it into one IPC call. */
export type DropAction =
  | { kind: 'status'; status: 'triage' | 'todo' }
  | { kind: 'unpark' }
  | { kind: 'assign'; agentId: Id; departmentId?: Id }
export type DropResult = { ok: true; action: DropAction } | { ok: false; reason: string } | { ok: true; action: null }
const routed = (t: CompanyTask): boolean => !!(t.departmentId || t.agentId)

/**
 * A card dropped on a column. Mirrors §1.4 (main enforces it again): nothing is ever dragged into Working (work starts
 * with Run now or Autopilot), Needs you fills itself, and Done needs an approval with a note. `action: null` = the
 * card is already in that column (no-op, no toast).
 */
export function laneDrop(t: CompanyTask, target: TaskLane, ctx: LaneContext): DropResult {
  const from = taskLane(t, ctx)
  if (from === target) return { ok: true, action: null }
  if (target === 'working') return { ok: false, reason: 'Cards can’t be dragged into Working. Use Run now, or turn on Autopilot for assigned agents.' }
  if (target === 'needs_you') return { ok: false, reason: 'Tasks land in Needs you by themselves when they wait for you.' }
  if (t.status === 'in_progress') return { ok: false, reason: 'This task is running. Stop it before moving it.' }
  if (target === 'done') return { ok: false, reason: t.status === 'in_review' ? 'Approve it in the task details: a done note is required.' : 'Only a reviewed task can be approved as done.' }
  if (t.status === 'in_review') return { ok: false, reason: 'Use Send back with a note in the task details.' }
  // a routed task with no eligible agent stays in Needs you whatever its status: only an assignment moves it
  if (taskReason(t, ctx) === 'unassigned') return { ok: false, reason: 'Assign an agent first: drop the card on an agent in the filter bar.' }
  if (target === 'inbox') {
    if (['todo', 'backlog', 'done', 'canceled'].includes(t.status)) return { ok: true, action: { kind: 'status', status: 'triage' } }
    return { ok: false, reason: 'Unpark this task before moving it to the Inbox.' }
  }
  // target === 'queued'
  if (t.status === 'blocked') {
    if (t.blockReason === 'deps') return { ok: true, action: null }
    // an open question is answered, not dragged away: the agent would resume without the answer it asked for
    if (t.blockReason === 'needs_input' && t.ask && !t.ask.answer) return { ok: false, reason: 'The agent asked a question. Answer it in Needs you or the task details.' }
    return { ok: true, action: { kind: 'unpark' } }
  }
  if (t.status === 'triage' && !routed(t)) return { ok: false, reason: 'Choose a department first: drop the card on an agent, or pick one in the task details.' }
  if (t.status === 'triage' || t.status === 'todo' || t.status === 'done' || t.status === 'canceled') return { ok: true, action: { kind: 'status', status: 'todo' } }
  return { ok: false, reason: 'This task can’t move to Queued.' }
}

/** A card dropped on an agent avatar in the filter bar: assigns it (the department follows the agent's). */
export function agentDrop(t: CompanyTask, agent: CompanyAgent): DropResult {
  if (agent.companyId !== t.companyId) return { ok: false, reason: 'That agent works for another company.' }
  if (agent.archivedAt) return { ok: false, reason: `${agent.name} is archived.` }
  if (t.status === 'in_progress') return { ok: false, reason: 'This task is running. Stop it before reassigning it.' }
  if (t.status === 'done' || t.status === 'canceled') return { ok: false, reason: 'Reopen this task before assigning it.' }
  if (t.agentId === agent.id) return { ok: true, action: null }
  return { ok: true, action: { kind: 'assign', agentId: agent.id, ...(agent.departmentId ? { departmentId: agent.departmentId } : {}) } }
}

/** The drag payload type (one task id). */
export const TASK_DRAG_TYPE = 'application/x-principia-task'

// ---------- inspector ----------

export interface TimelineItem extends TaskActivity {
  /** coalesced repeats folded into this row ("coalesced ×3"); 1 = a single row */
  count: number
}
/**
 * The typed activity timeline: oldest first, consecutive rows of the same repeatable kind (coalesced, woke,
 * comment-free system notes with the same text) folded into one row with a count.
 */
export function coalesceActivity(activity: TaskActivity[]): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const a of activity) {
    const last = out[out.length - 1]
    const same = last && last.kind === a.kind && last.by === a.by && (a.kind === 'coalesced' || (a.kind !== 'comment' && last.message === a.message))
    if (same) out[out.length - 1] = { ...a, id: last.id, count: last.count + 1 }
    else out.push({ ...a, count: 1 })
  }
  return out
}
export const ACTIVITY_LABEL: Record<TaskActivityKind, string> = {
  created: 'Created', routed: 'Routed', assigned: 'Assigned', woke: 'Woke', coalesced: 'Coalesced', started: 'Started', report: 'Report', asked: 'Asked',
  answered: 'Answered', parked: 'Parked', healed: 'Healed', handoff: 'Handoff', approved: 'Approved', sent_back: 'Sent back', comment: 'Comment',
  run_finished: 'Run finished', interrupted: 'Interrupted', updated: 'Updated', work: 'Work', paused: 'Paused'
}

export type InspectorAction = 'run' | 'openSession' | 'takeover' | 'stop' | 'approve' | 'sendBack' | 'unpark'
/** Which inspector actions apply to a task (§9). `hasAgent`: an agent seat or a legacy profile is set. */
const openQuestion = (t: CompanyTask): boolean => t.status === 'blocked' && t.blockReason === 'needs_input' && !!t.ask && !t.ask.answer
export function inspectorActions(t: CompanyTask, opts: { hasAgent: boolean; headlessRun: boolean }): Set<InspectorAction> {
  const out = new Set<InspectorAction>()
  const parked = t.status === 'blocked' && t.blockReason !== 'deps'
  if (t.status === 'in_progress') {
    out.add('stop')
    if (opts.headlessRun) out.add('takeover')
  } else if (t.status !== 'done' && t.status !== 'canceled' && !(t.status === 'blocked' && t.blockReason === 'deps') && !openQuestion(t) && opts.hasAgent) {
    // an unanswered question is answered first: a run now would resume the agent without the answer
    out.add('run')
    out.add('openSession')
  }
  if (t.status === 'in_review') { out.add('approve'); out.add('sendBack') }
  if (parked) out.add('unpark')
  return out
}
/**
 * The inspector's status picker values (`blocked:manual` = park by hand), limited to the human moves §1.4 allows from
 * the task's status: a parked task only unparks to Todo or is canceled; a finished one reopens or is canceled.
 */
export type StatusChoice = 'triage' | 'backlog' | 'todo' | 'blocked:manual' | 'canceled'
export function statusChoices(t: Pick<CompanyTask, 'status'>): StatusChoice[] {
  if (t.status === 'blocked') return ['blocked:manual', 'todo', 'canceled']
  if (t.status === 'done' || t.status === 'canceled') return ['triage', 'backlog', 'todo', 'canceled']
  return ['triage', 'backlog', 'todo', 'blocked:manual', 'canceled']
}
/** Approve as done needs a written note (§1.4: `doneNote` required). */
export const canApprove = (t: Pick<CompanyTask, 'status'>, note: string): boolean => t.status === 'in_review' && note.trim().length > 0

// ---------- Autopilot ----------

/** What the Autopilot switch shows: the optimistic value while a request is out (null = the company row's value). */
export interface AutopilotView { pending: boolean | null; busy: boolean }
/**
 * The header switch's round trip through board:autopilot: one request at a time (a double click cannot leave the
 * switch showing the opposite of main), the switch then shows what main stored, and an error reverts it.
 * `flip` resolves the stored settings, or null when a request was already out.
 */
export function autopilotToggle(request: (q: { companyId: Id; on: boolean }) => Promise<BoardSettings>, companyId: Id, onView: (v: AutopilotView) => void): { flip: (on: boolean) => Promise<BoardSettings | null> } {
  let busy = false
  return {
    flip(on) {
      if (busy) return Promise.resolve(null)
      busy = true
      onView({ pending: on, busy: true })
      return request({ companyId, on }).then(
        (s) => { busy = false; onView({ pending: s.autopilot, busy: false }); return s },
        (e: unknown) => { busy = false; onView({ pending: null, busy: false }); throw e }
      )
    }
  }
}

// ---------- live hub ----------

/** A run's task: the run's own runs.task_id when the row carries it, else the task whose latest run it is. */
export function taskForRun(tasks: CompanyTask[], q: { runId?: Id | null; taskId?: Id | null; sessionTaskId?: Id | null }): CompanyTask | undefined {
  const id = q.taskId ?? q.sessionTaskId
  if (id) return tasks.find((t) => t.id === id)
  return q.runId ? tasks.find((t) => t.runId === q.runId) : undefined
}
/**
 * Learns a run's runs.task_id from a run:updated payload into `cache` (run id → task id, null = not a task run).
 * The engine emits the in-memory Run, which carries no taskId: an absent field says nothing and never overwrites what
 * runs:get answered (a run's task link never changes). True when the cache changed.
 */
export function learnRunTask(cache: Map<Id, Id | null>, run: { id: Id; taskId?: Id | null }): boolean {
  if (!run.taskId || cache.get(run.id) === run.taskId) return false
  cache.set(run.id, run.taskId)
  return true
}
/** "PRN-42 · Marketing/Copywriter" (department and agent when set). */
export function taskRunLabel(t: CompanyTask, departments: Department[], agents: CompanyAgent[]): string {
  const agent = t.agentId ? agents.find((a) => a.id === t.agentId && a.companyId === t.companyId) : undefined
  const depId = t.departmentId ?? agent?.departmentId ?? null
  const dep = depId ? departments.find((d) => d.id === depId && d.companyId === t.companyId) : undefined
  const who = [dep?.name, agent?.name].filter(Boolean).join('/')
  return who ? `${t.identifier} · ${who}` : t.identifier
}

// ---------- Needs you ----------

export type NeedsYouGroup = 'review' | 'ask' | 'parked' | 'unassigned'
export const NEEDS_GROUP_LABEL: Record<NeedsYouGroup, string> = { review: 'Reviews', ask: 'Asks', parked: 'Parked', unassigned: 'Unassigned' }
export function needsGroupOf(reason: NeedsYouReason): NeedsYouGroup {
  return reason === 'review' ? 'review' : reason === 'needs_input' || reason === 'live_ask' ? 'ask' : reason === 'unassigned' ? 'unassigned' : 'parked'
}
export interface NeedsYouItem { task: CompanyTask; reason: NeedsYouReason; group: NeedsYouGroup }
/**
 * Needs-you task items, asks first (answerable inline), then reviews, parked and unassigned; oldest first inside.
 * `skipLiveAsks`: where the live ask rows are listed too (All mode, Portfolio), a running task waiting on a live ask is
 * already there once; it is not listed again as a task.
 */
export function needsYouTasks(tasks: CompanyTask[], ctx: LaneContext, companyId?: Id, opts: { skipLiveAsks?: boolean } = {}): NeedsYouItem[] {
  const order: NeedsYouGroup[] = ['ask', 'review', 'parked', 'unassigned']
  const out: NeedsYouItem[] = []
  for (const t of tasks) {
    if (companyId && t.companyId !== companyId) continue
    const reason = taskReason(t, ctx)
    if (reason && !(opts.skipLiveAsks && reason === 'live_ask')) out.push({ task: t, reason, group: needsGroupOf(reason) })
  }
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (a.task.updatedAt < b.task.updatedAt ? -1 : 1))
}

// ---------- Home: Overnight ----------

export type OvernightKind = 'done' | 'parked' | 'review'
export interface OvernightGroup {
  departmentId: Id | null
  name: string
  color: string | null
  items: { task: CompanyTask; kind: OvernightKind }[]
}
/**
 * §9 Overnight: the company's tasks done, parked or awaiting review since `since` (last seen), grouped by department
 * in sidebar order, then "No department". A task counts by its current state and its last change.
 */
export function overnight(tasks: CompanyTask[], companyId: Id, since: string, departments: Department[], ctx: LaneContext): OvernightGroup[] {
  const kindOf = (t: CompanyTask): OvernightKind | null =>
    t.status === 'done' ? 'done' : t.status === 'in_review' ? 'review' : t.status === 'blocked' && t.blockReason !== 'deps' ? 'parked' : null
  const by = new Map<Id | null, OvernightGroup['items']>()
  const known = new Map(departments.filter((d) => d.companyId === companyId).map((d) => [d.id, d]))
  for (const t of tasks) {
    if (t.companyId !== companyId || t.updatedAt < since) continue
    const kind = kindOf(t)
    if (!kind) continue
    const d = taskDepartment(t, ctx)
    const key = d && known.has(d) ? d : null
    by.set(key, [...(by.get(key) ?? []), { task: t, kind }])
  }
  const order: OvernightKind[] = ['review', 'parked', 'done']
  const sortItems = (l: OvernightGroup['items']): OvernightGroup['items'] => l.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.task.updatedAt < b.task.updatedAt ? 1 : -1))
  const groups: OvernightGroup[] = []
  for (const d of [...known.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
    const items = by.get(d.id)
    if (items?.length) groups.push({ departmentId: d.id, name: d.name, color: d.color, items: sortItems(items) })
  }
  const loose = by.get(null)
  if (loose?.length) groups.push({ departmentId: null, name: 'No department', color: null, items: sortItems(loose) })
  return groups
}

/**
 * The department filter after the board's company changes: kept only when the department belongs to the new company
 * (All mode keeps any), so a filter left over from another company never empties the board behind an "All" select.
 */
export function keptDepartmentFilter(depId: Id | null, companyId: Id | undefined, departments: Pick<Department, 'id' | 'companyId'>[]): Id | null {
  if (!depId || !companyId) return depId
  return departments.some((d) => d.id === depId && d.companyId === companyId) ? depId : null
}

/** Seats shown as drop targets in the filter bar: the company's (or department's) non-archived agents, active first. */
export function dropSeats(agents: CompanyAgent[], companyId: Id | undefined, departmentId?: Id | null): CompanyAgent[] {
  if (!companyId) return []
  return agents
    .filter((a) => a.companyId === companyId && !a.archivedAt && (!departmentId || a.departmentId === departmentId || a.departmentId === null))
    .sort((a, b) => Number(agentActive(b)) - Number(agentActive(a)) || a.name.localeCompare(b.name))
}
