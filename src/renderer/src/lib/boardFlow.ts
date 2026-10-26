/**
 * Five doors step 5 (design §4.5, pm-review step 5 / A3 / E13): the Board's four columns, the quick create row's
 * branch preview, and the one next step of a task that has a branch. Pure: no store, no IPC, so the tests drive it.
 *
 * - Columns: To do · Working · Needs you · Done. "To do" holds what used to be Inbox and Queued (laneOf is unchanged:
 *   every count elsewhere keeps reading the same lanes).
 * - Status follows the pull request (main's nextMove): opened → Needs you (review), approved or merged → Done. The
 *   inspector never offers a "Mark merged"; a task with an open PR says it moves on its own.
 */
import type { CompanyTask, TaskLane } from '@shared/company'
import { taskBranchName, workGone, workQueued, workStarted, type GhState, type TaskWork } from '@shared/taskWork'
import { laneDrop, sortForLane, type DropResult } from './board'
import { taskLane, type LaneContext } from './departments'
import { routeAsk, type DeskAgent } from './desk'

export type BoardColumn = 'todo' | 'working' | 'needs_you' | 'done'
export const BOARD_COLUMNS: readonly BoardColumn[] = ['todo', 'working', 'needs_you', 'done']
export const COLUMN_LABEL: Record<BoardColumn, string> = { todo: 'To do', working: 'Working', needs_you: 'Needs you', done: 'Done' }
/** The column glyph (always glyph + word, never colour alone: design §2.6). */
export const COLUMN_GLYPH: Record<BoardColumn, string> = { todo: '○', working: '●', needs_you: '◆', done: '✓' }

/** Inbox and Queued are both "To do" on the Board. */
export function columnOfLane(lane: TaskLane): BoardColumn {
  return lane === 'inbox' || lane === 'queued' ? 'todo' : lane
}
export function columnOf(t: CompanyTask, ctx: LaneContext): BoardColumn {
  return columnOfLane(taskLane(t, ctx))
}

/** Every task in exactly one of the four columns; To do sorts like Queued (most urgent, then most recent). */
export function boardColumns(tasks: CompanyTask[], ctx: LaneContext): Record<BoardColumn, CompanyTask[]> {
  const out: Record<BoardColumn, CompanyTask[]> = { todo: [], working: [], needs_you: [], done: [] }
  for (const t of tasks) out[columnOf(t, ctx)].push(t)
  out.todo = sortForLane('queued', out.todo)
  out.working = sortForLane('working', out.working)
  out.needs_you = sortForLane('needs_you', out.needs_you)
  out.done = sortForLane('done', out.done)
  return out
}

/** A card dropped on a column: To do means Queued (an Inbox card already in To do stays where it is). */
export function columnDrop(t: CompanyTask, target: BoardColumn, ctx: LaneContext): DropResult {
  if (columnOf(t, ctx) === target) return { ok: true, action: null }
  return laneDrop(t, target === 'todo' ? 'queued' : target, ctx)
}

// ---------- branch preview (before Start) ----------

/** The branch a task gets on Start, as git will name it (`hive/la-19-add-vat-field`). */
export function branchFor(identifier: string, title: string): string {
  return taskBranchName(identifier, title)
}
/**
 * The identifier a new task of this company will get: the company's counter + 1 (main counts inside the company,
 * company_passports.taskSeq). null when the counter is not known: the preview then names no number.
 */
export function nextIdentifier(prefix: string | undefined, seq: number | undefined): string | null {
  if (!prefix || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
  return `${prefix}-${seq + 1}`
}
/** The quick create line: "Starting creates the branch hive/la-20-fix-pdf-export in ledgerly-app". */
export function quickBranchLine(identifier: string | null, title: string, repoName: string | null): string | null {
  if (!repoName || !title.trim() || !identifier) return null
  return `Starting creates the branch ${branchFor(identifier, title)} in ${repoName}`
}

// ---------- the one next step ----------

export type WorkStepKey = 'branch' | 'pr' | 'merged' | 'done'
export type WorkStepState = 'done' | 'current' | 'todo'
export interface WorkStep { key: WorkStepKey; label: string; state: WorkStepState }
/**
 * The stepper Branch → Pull request → Merged. A step is done when it happened; the first one not done is current.
 * (No commit count: Principia does not count commits, and the stepper never shows a number it doesn't have.)
 */
export function workSteps(w: TaskWork | null | undefined, status?: CompanyTask['status']): WorkStep[] {
  const branch = !!w && (workStarted(w) || !!w.startedAt || !!w.pr)
  // approved as done (or canceled) without a merged pull request: the stepper ends there, it never says "PR next"
  if ((status === 'done' || status === 'canceled') && w?.pr?.state !== 'MERGED') {
    const end: WorkStep = { key: 'done', label: status === 'done' ? (w?.pr ? 'Done' : 'Done, no pull request') : 'Canceled', state: 'done' }
    return [{ key: 'branch', label: 'Branch', state: branch ? 'done' : 'todo' }, ...(w?.pr ? [{ key: 'pr' as const, label: 'Pull request', state: 'done' as const }] : []), end]
  }
  const pr = !!w?.pr
  const merged = w?.pr?.state === 'MERGED'
  const done = [branch, pr, merged]
  const firstOpen = done.indexOf(false)
  const keys: [WorkStepKey, string][] = [['branch', 'Branch'], ['pr', 'Pull request'], ['merged', 'Merged']]
  return keys.map(([key, label], i) => ({ key, label, state: done[i] ? 'done' : i === firstOpen ? 'current' : 'todo' }))
}

export type NextStepKind = 'start' | 'connectGithub' | 'openChat' | 'openPr' | 'review' | 'queued' | 'gone' | 'done' | 'none'
export interface NextStep {
  kind: NextStepKind
  /** the button, or null when nothing is for you to press */
  label: string | null
  /** one plain sentence: what happens next */
  note: string
}
/**
 * What a code task shows after its branch exists: only the next step (design §4.5). `canStart`: it has a repository of
 * its company and no live binding yet. `inFlight`: an agent is on it now. `liveChat`: that work is open in a chat.
 */
export function nextWorkStep(t: Pick<CompanyTask, 'status' | 'work'>, o: { canStart: boolean; inFlight: boolean; liveChat: boolean; repoName?: string | null; branch?: string | null; who?: string | null }): NextStep {
  const w = t.work
  const who = o.who || 'The agent'
  if (t.status === 'done' || t.status === 'canceled' || w?.pr?.state === 'MERGED') return { kind: 'done', label: null, note: w?.pr?.state === 'MERGED' ? `Merged #${w.pr.number}. Done.` : 'Done.' }
  if (o.canStart && !workStarted(w) && !workQueued(w)) {
    const where = o.repoName ? ` in ${o.repoName}` : ''
    return { kind: 'start', label: 'Start on a new branch', note: `Starting creates the branch ${o.branch ?? 'for this task'}${where}, in its own folder, so your checkout is untouched.` }
  }
  if (!w) return { kind: 'none', label: null, note: '' }
  if (workGone(w)) return { kind: 'gone', label: null, note: 'Its folder is gone. Choose what to do with it below.' }
  if (workQueued(w)) return { kind: 'queued', label: null, note: 'Waiting for a free seat: it starts when a running task finishes.' }
  if (o.inFlight) return { kind: 'openChat', label: o.liveChat ? 'Open the chat' : 'Watch the work', note: `${who} is working on ${w.branch}.` }
  if (w.gh === 'missing' || w.gh === 'signed_out') return { kind: 'connectGithub', label: 'Connect GitHub', note: `${who} can't open the pull request yet: GitHub isn't connected for this company.` }
  if (w.pr && w.pr.state === 'OPEN') {
    const changes = w.pr.reviewDecision === 'CHANGES_REQUESTED'
    return { kind: 'openPr', label: 'Open the pull request', note: changes ? `Changes requested on #${w.pr.number}. ${who} picks them up.` : `#${w.pr.number} is open. The task moves to Done by itself when it is approved or merged.` }
  }
  if (t.status === 'in_review') return { kind: 'review', label: null, note: 'Review the work below, then approve it or send it back.' }
  return { kind: 'none', label: null, note: w.pr?.state === 'CLOSED' ? `#${w.pr.number} was closed without merging.` : 'No pull request yet.' }
}

/** A task with an open pull request is approved on GitHub, not with a done note here (status follows the PR, A3). */
export function followsPr(t: Pick<CompanyTask, 'work'>): boolean {
  return t.work?.pr?.state === 'OPEN'
}

/** "Connect GitHub" or the PR, the card's short state for a code task ("PR #14 open", "Needs GitHub"). */
export function cardWorkLine(w: TaskWork | null | undefined, gh?: GhState | null): string | null {
  if (!w) return null
  if (w.pr) return w.pr.state === 'MERGED' ? `PR #${w.pr.number} merged` : w.pr.state === 'CLOSED' ? `PR #${w.pr.number} closed` : `PR #${w.pr.number} open`
  const g = gh ?? w.gh
  if (workStarted(w) && (g === 'missing' || g === 'signed_out')) return 'Needs GitHub'
  return null
}
/** The branch as a card shows it: without the `hive/` namespace every task branch shares. */
export function shortBranch(branch: string): string {
  return branch.replace(/^hive\//, '')
}

// ---------- quick create "auto" ----------

export interface RouteSeat { id: string; departmentId: string | null; archivedAt?: string | null }
/**
 * Quick create's "Agent · auto" (design §4.5, §9 Diego): the agent the title would reach, as the Ask box routes it
 * (lib/desk.routeAsk: a word of its role, its department, else the first active agent), among the seats of the chosen
 * department (or every seat when Department is auto too). null only when the company has no agent, so a task made with
 * the default chips is assigned and ⌘↵ really starts it.
 */
export function quickRoute(title: string, depId: string | null, seats: readonly RouteSeat[], desk: readonly DeskAgent[]): { agentId: string; departmentId: string | null } | null {
  const pool = seats.filter((a) => !a.archivedAt && (!depId || a.departmentId === depId || a.departmentId === null))
  const ids = new Set(pool.map((a) => a.id))
  const routed = routeAsk(title, desk.filter((d) => ids.has(d.id)))
  if (!routed) return null
  const seat = pool.find((a) => a.id === routed.agent.id)!
  return { agentId: seat.id, departmentId: depId || seat.departmentId }
}
