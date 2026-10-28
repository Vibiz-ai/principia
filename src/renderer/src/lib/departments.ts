/**
 * DEPARTMENTS.md §9: pure helpers behind the department rows, agent seats and Board badges. Every count goes through
 * `laneOf` (§1.5) with the two inputs only the renderer knows: whether the task's run has an open live ask, and whether
 * its agent is still eligible (not paused, archived or gone).
 */
import { agentActive, laneOf, needsYouReason, type CompanyAgent, type NeedsYouReason, type CompanyTask, type Department, type TaskLane } from '@shared/company'
import type { Ask } from '@shared/live'
import type { Id, Schedule, Workflow } from '@shared/types'
import type { SlackTrigger } from '@shared/slack'

/** Runs that have an open live ask (permission, question, trust): a task in flight on one of them needs you. */
export function openAskRuns(asks: Record<Id, Ask> | Iterable<Ask>): Set<Id> {
  const list = Symbol.iterator in Object(asks) ? (asks as Iterable<Ask>) : Object.values(asks as Record<Id, Ask>)
  const runs = new Set<Id>()
  for (const a of list) if (a.status === 'open' && a.runId) runs.add(a.runId)
  return runs
}

export interface LaneContext {
  openRuns: Set<Id>
  agentsById: Map<Id, CompanyAgent>
  /**
   * Five doors A4: companies paused as a whole. Their seats are paused by the company pause, which is waiting, not
   * missing: a task assigned to one stays To do instead of turning into a new Needs you item.
   */
  pausedCompanies?: ReadonlySet<Id>
}
export function laneContext(asks: Record<Id, Ask>, agents: CompanyAgent[], pausedCompanies?: ReadonlySet<Id>): LaneContext {
  return { openRuns: openAskRuns(asks), agentsById: new Map(agents.map((a) => [a.id, a])), pausedCompanies }
}

/** The task's seat, only when it belongs to the task's company: a seat of another company never counts (§0.3). */
function seatOf(t: CompanyTask, ctx: LaneContext): CompanyAgent | undefined {
  const a = t.agentId ? ctx.agentsById.get(t.agentId) : undefined
  return a && a.companyId === t.companyId ? a : undefined
}
function laneInputs(t: CompanyTask, ctx: LaneContext): [boolean, boolean] {
  const openLiveAsk = t.status === 'in_progress' && !!t.runId && ctx.openRuns.has(t.runId)
  const agent = seatOf(t, ctx)
  const held = !!agent && !agent.archivedAt && !!ctx.pausedCompanies?.has(t.companyId)
  return [openLiveAsk, !t.agentId || (!!agent && (agentActive(agent) || held))]
}

/** laneOf with the renderer's live inputs. A task whose agent row is gone counts as having no eligible agent. */
export function taskLane(t: CompanyTask, ctx: LaneContext): TaskLane {
  return laneOf(t, ...laneInputs(t, ctx))
}
/** needsYouReason with the same inputs as taskLane, so a chip never disagrees with the lane. */
export function taskReason(t: CompanyTask, ctx: LaneContext): NeedsYouReason | null {
  return needsYouReason(t, ...laneInputs(t, ctx))
}

/** The department a task counts under: its own, else its agent's (a company-level task handed to a Marketing seat). */
export function taskDepartment(t: CompanyTask, ctx: LaneContext): Id | null {
  return t.departmentId ?? seatOf(t, ctx)?.departmentId ?? null
}

export interface LaneCounts {
  needsYou: number
  working: number
  /** of needsYou, tasks there only because their run has an open live ask (the ask itself already counts elsewhere) */
  liveAsks?: number
}
const zero = (): LaneCounts => ({ needsYou: 0, working: 0 })

/** Needs-you and working counts per department id (sidebar rows). */
export function departmentCounts(tasks: CompanyTask[], ctx: LaneContext): Record<Id, LaneCounts> {
  const out: Record<Id, LaneCounts> = {}
  for (const t of tasks) {
    const dep = taskDepartment(t, ctx)
    if (!dep) continue
    const lane = taskLane(t, ctx)
    if (lane !== 'needs_you' && lane !== 'working') continue
    const c = (out[dep] ??= zero())
    if (lane === 'needs_you') c.needsYou++
    else c.working++
  }
  return out
}

/** The company's whole board (All-mode Board row): every task of the company, with or without a department. */
export function boardCounts(tasks: CompanyTask[], companyId: Id, ctx: LaneContext): LaneCounts {
  const c: LaneCounts = { ...zero(), liveAsks: 0 }
  for (const t of tasks) {
    if (t.companyId !== companyId) continue
    const lane = taskLane(t, ctx)
    if (lane === 'needs_you') {
      c.needsYou++
      if (t.status === 'in_progress') c.liveAsks!++
    } else if (lane === 'working') c.working++
  }
  return c
}

/**
 * The company header badge with departments on: the live badge (asks, unseen idle sessions, running agents) plus the
 * Board's needs-you tasks. A task waiting on a live ask is the same thing as that ask, so it is not counted twice; a
 * task in flight is a running agent already, so working is the larger of the two rather than their sum.
 */
export function mergeBoardBadge<B extends { needsYou: number; working: number }>(badge: B, board: LaneCounts): B {
  return { ...badge, needsYou: badge.needsYou + board.needsYou - (board.liveAsks ?? 0), working: Math.max(badge.working, board.working) }
}

export type SeatKind = 'working' | 'needs' | 'parked' | 'idle' | 'paused' | 'archived'
export interface SeatState {
  kind: SeatKind
  /** the task in flight the seat leads with (one asking the human first), if any */
  current: CompanyTask | null
  /** every task in flight: an agent works on several at once */
  working: CompanyTask[]
  /** blocked for any reason other than deps: waits for the human */
  parked: CompanyTask[]
  /** todo, backlog and dependency-blocked tasks assigned to the seat, highest priority first */
  queue: CompanyTask[]
  /** in_review tasks the seat finished */
  review: CompanyTask[]
  /** "PRN-12 · working", "idle", "2 parked", "paused" */
  label: string
}

const QUEUED = new Set(['todo', 'backlog', 'triage'])
/** Lower number is more urgent; 0 = no priority sorts last. */
const prio = (p: number): number => (p === 0 ? 9 : p)

export function seatState(agent: CompanyAgent, tasks: CompanyTask[], openRuns: Set<Id>): SeatState {
  const mine = tasks.filter((t) => t.agentId === agent.id && t.companyId === agent.companyId)
  const working = mine.filter((t) => t.status === 'in_progress')
  const askingOf = (t: CompanyTask): boolean => !!t.runId && openRuns.has(t.runId)
  const current = working.find(askingOf) ?? working[0] ?? null
  const parked = mine.filter((t) => t.status === 'blocked' && t.blockReason !== 'deps')
  const queue = mine
    .filter((t) => QUEUED.has(t.status) || (t.status === 'blocked' && t.blockReason === 'deps'))
    .sort((a, b) => prio(a.priority) - prio(b.priority) || (a.createdAt < b.createdAt ? -1 : 1))
  const review = mine.filter((t) => t.status === 'in_review')
  const base = { current, working, parked, queue, review }
  const what = (t: CompanyTask): string => (working.length > 1 ? `${working.length} tasks` : t.identifier)
  if (agent.archivedAt) return { ...base, kind: 'archived', label: 'archived' }
  // a paused seat may still finish the turns it was on; say both
  if (agent.pausedAt) return { ...base, kind: 'paused', label: current ? `${what(current)} · paused` : 'paused' }
  if (current) {
    const asking = askingOf(current)
    return { ...base, kind: asking ? 'needs' : 'working', label: `${asking ? current.identifier : what(current)} · ${asking ? 'needs you' : 'working'}` }
  }
  if (parked.length) {
    // a question is not "parked" to the human: the board calls it a Question (needsYouReason 'needs_input')
    const questions = parked.filter((t) => t.blockReason === 'needs_input').length
    const label = questions === parked.length ? `${questions} question${questions === 1 ? '' : 's'}` : `${parked.length} parked`
    return { ...base, kind: 'parked', label }
  }
  return { ...base, kind: 'idle', label: queue.length ? `idle · ${queue.length} queued` : 'idle' }
}

export interface RecurringItem {
  kind: 'workflow' | 'schedule' | 'trigger'
  id: Id
  name: string
  enabled: boolean
}
/** §8: workflows, schedules and Slack triggers that joined the department (shown muted under its agents). */
export function recurringOf(departmentId: Id, src: { workflows?: Workflow[]; schedules?: Schedule[]; triggers?: SlackTrigger[] }): RecurringItem[] {
  const out: RecurringItem[] = []
  for (const w of src.workflows ?? []) if (w.departmentId === departmentId) out.push({ kind: 'workflow', id: w.id, name: w.name, enabled: true })
  for (const s of src.schedules ?? []) if (s.departmentId === departmentId) out.push({ kind: 'schedule', id: s.id, name: s.name, enabled: s.enabled })
  for (const t of src.triggers ?? []) if (t.departmentId === departmentId) out.push({ kind: 'trigger', id: t.id, name: t.name, enabled: t.enabled })
  return out
}

/** Rows of one company: a stamped row of another company is dropped (unstamped rows predate stamping and pass). */
export function inCompany<T extends { companyId?: Id | null }>(list: T[], companyId: Id): T[] {
  return list.filter((x) => !x.companyId || x.companyId === companyId)
}

/** Active departments of a company in their order. */
export function departmentsOf(departments: Department[], companyId: Id): Department[] {
  return departments.filter((d) => d.companyId === companyId && !d.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}
/** Non-archived seats of a department (null = company-level seats). */
export function agentsOf(agents: CompanyAgent[], companyId: Id, departmentId: Id | null): CompanyAgent[] {
  return agents.filter((a) => a.companyId === companyId && a.departmentId === departmentId && !a.archivedAt).sort((a, b) => a.name.localeCompare(b.name))
}

/** One or two letters for a seat avatar ("Bug fixer" -> "BF"). */
export function seatInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase()
}

/** §1.1: does and does-not share one 600-char budget. */
export function charterLength(c: { does: string; doesNot: string }): number {
  return c.does.length + c.doesNot.length
}

/** Vault path of a department's passport section (§7: `Departments/<Name>.md`). */
export function departmentNotePath(d: Pick<Department, 'name' | 'data'>): string {
  return `Departments/${d.data.passportNote || d.name}.md`
}
