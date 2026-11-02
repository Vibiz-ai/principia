/**
 * DEPARTMENTS.md §1.4: the task state machine, pure. Every board move (run start and end, heal, answer, unpark,
 * approve, send back, cancel, a human status edit on a board task) goes through assertTransition, which throws a
 * HiveError('bad_request') naming why the move is illegal. Plain company tasks (no department, no agent) keep today's
 * free status edits; CompanyStore only routes their run start and end through here.
 *
 * Rules that are never relaxed (§0.7): an agent never marks a task done; done needs a non-empty done note; only a
 * dependency block heals automatically (a run stopped by a usage limit is not a block: it waits in To do, LIVE.md §16.1).
 */
import type { ActivityBy, BlockReason, TaskStatus } from '../../shared/company'
import { HiveError } from '../../shared/errors'

export type Actor = ActivityBy
/** A status, plus its block reason when blocked. */
export interface TaskState { status: TaskStatus; blockReason?: BlockReason | null }
export interface TransitionCtx {
  /** the task has a department or an agent after the move (a board task leaves the Inbox only once routed) */
  routed?: boolean
  /** every dependency is done */
  depsDone?: boolean
  /** approve: the done note */
  doneNote?: string | null
  /** answer: the human's answer */
  answer?: string | null
  /** send back: the note that becomes the next wake */
  note?: string | null
  /** the move starts a run or session (todo → in_progress); a plain status edit can never start work */
  start?: boolean
  /** a dependency of a blocked(deps) task was canceled: it can never heal, so it parks for the human */
  depCanceled?: boolean
  /** PROACTIVE.md §3: the move is the chat that tracks this task (shared/company.ts trackedBy) moving it */
  tracked?: boolean
  /** WORKTREE.md: the task's own PR moved its status (opened and ready, changes requested, merged by a human) */
  work?: 'pr_ready' | 'changes_requested' | 'merged' | 'approved'
  /** WORKTREE.md: the task's worktree is gone and the founder chose Back to Backlog */
  worktreeGone?: boolean
  /** ORCHESTRATOR.md §2: a teammate answered the blocking question the agent parked this task on */
  teammateAnswered?: boolean
}

const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const blank = (s: string | null | undefined) => !s || !s.trim()
const STATUS_LABEL: Record<TaskStatus, string> = { triage: 'Inbox', backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done', canceled: 'Canceled' }
export const stateLabel = (s: TaskState): string => s.status === 'blocked' && s.blockReason ? `Blocked (${s.blockReason})` : STATUS_LABEL[s.status]

interface Rule {
  /** a §1.4 row, or "carried over" for a move today's board already allows */
  row: string
  from: TaskStatus | ((s: TaskState) => boolean)
  to: TaskStatus | ((s: TaskState) => boolean)
  actors: readonly Actor[]
  /** an extra condition; returns the refusal, or null */
  check?: (ctx: TransitionCtx, from: TaskState, to: TaskState) => string | null
  /** the row exists only for this kind of move (WORKTREE.md): other moves never see it, nor its refusal */
  when?: (ctx: TransitionCtx) => boolean
}
const isDeps = (s: TaskState) => s.status === 'blocked' && s.blockReason === 'deps'
const parked = (s: TaskState) => s.status === 'blocked' && s.blockReason !== 'deps'
/** where a run end may leave a task */
const RUN_END_REASONS: readonly (BlockReason | null | undefined)[] = ['needs_input', 'agent', 'run_failed', 'no_report', 'interrupted', 'limit', 'deps', 'handoff_cap']
const HUMAN = ['human'] as const
const SYSTEM = ['system'] as const
const AGENT = ['agent'] as const

/** §1.4, row by row. Order does not matter: a move is legal when any row allows it. */
export const TRANSITIONS: readonly Rule[] = [
  { row: 'triage → todo / backlog (routed)', from: 'triage', to: s => s.status === 'todo' || s.status === 'backlog', actors: ['human', 'system'],
    check: ctx => ctx.routed === false ? 'Choose a department before moving the task out of the Inbox' : null },
  { row: 'todo (deps unmet) → blocked(deps)', from: 'todo', to: isDeps, actors: SYSTEM, check: ctx => ctx.depsDone === false ? null : 'Every dependency is done; nothing blocks this task' },
  // a canceled dependency never becomes done: the task would wait forever in Queued, so it moves to Needs you
  { row: 'blocked(deps) → blocked(manual) (a dependency was canceled)', from: isDeps, to: s => s.status === 'blocked' && s.blockReason === 'manual', actors: SYSTEM,
    check: ctx => ctx.depCanceled ? null : 'Only a canceled dependency parks a task waiting on its dependencies' },
  { row: 'blocked(deps) → todo (heal)', from: isDeps, to: 'todo', actors: SYSTEM, check: ctx => ctx.depsDone ? null : 'Dependencies are not done yet' },
  { row: 'todo → in_progress (claim or Run now)', from: 'todo', to: 'in_progress', actors: ['human', 'system'], check: startCheck },
  // carried over: Run now on a parked, reviewed, backlog or inbox task is an explicit human retry (today's "Run agent")
  { row: 'Run now (human retry)', from: s => parked(s) || s.status === 'in_review' || s.status === 'backlog' || s.status === 'triage', to: 'in_progress', actors: HUMAN, check: startCheck },
  { row: 'in_progress → in_review (run end)', from: 'in_progress', to: 'in_review', actors: SYSTEM },
  { row: 'in_progress → blocked(…) (run end, reconcile, caps)', from: 'in_progress', to: s => s.status === 'blocked' && RUN_END_REASONS.includes(s.blockReason), actors: SYSTEM },
  // §6 task_handoff: at run end the task goes back to todo with the new agent
  { row: 'in_progress → todo (handoff at run end)', from: 'in_progress', to: 'todo', actors: SYSTEM },
  { row: 'blocked(needs_input) → todo (answer)', from: s => s.status === 'blocked' && s.blockReason === 'needs_input', to: 'todo', actors: HUMAN,
    check: ctx => ctx.answer === undefined || !blank(ctx.answer) ? null : 'Write an answer first' },
  // ORCHESTRATOR.md §2: the agent parked itself waiting on a teammate's answer; the answer puts the task back in To do
  { row: 'blocked(agent) → todo (a teammate answered)', from: s => s.status === 'blocked' && s.blockReason === 'agent', to: 'todo', actors: SYSTEM,
    check: ctx => ctx.teammateAnswered ? null : 'Only a teammate\'s answer moves a task the agent parked' },
  { row: 'blocked(not deps) → todo (Unpark)', from: parked, to: 'todo', actors: HUMAN,
    // an answer attempt is held to the answer row, whatever the reason
    check: ctx => ctx.answer !== undefined && blank(ctx.answer) ? 'Write an answer first' : null },
  { row: 'in_review → done (approve)', from: 'in_review', to: 'done', actors: HUMAN, check: ctx => blank(ctx.doneNote) ? 'A done note is required to approve a task' : null },
  // the founder drops a card on Done (or marks it done): it is done, whatever lane it waited in; the store writes the note
  { row: 'not in flight → done (marked done by hand)', from: s => !['in_progress', 'in_review', 'done', 'canceled'].includes(s.status), to: 'done', actors: HUMAN,
    check: ctx => blank(ctx.doneNote) ? 'A done note is required' : null },
  { row: 'in_review → todo (Send back)', from: 'in_review', to: 'todo', actors: HUMAN, check: ctx => ctx.note === undefined || !blank(ctx.note) ? null : 'Say what to change' },
  { row: 'not in flight → canceled', from: s => s.status !== 'in_progress' && s.status !== 'canceled', to: 'canceled', actors: HUMAN },
  // carried over: planning moves a human makes on the board, reopening, and parking by hand
  { row: 'plan (todo ↔ backlog ↔ triage)', from: s => ['todo', 'backlog', 'triage'].includes(s.status), to: s => ['todo', 'backlog', 'triage'].includes(s.status), actors: HUMAN,
    check: (ctx, from, to) => from.status === 'triage' && to.status !== 'triage' && ctx.routed === false ? 'Choose a department before moving the task out of the Inbox' : null },
  { row: 'reopen (done / canceled → todo / backlog / triage)', from: s => s.status === 'done' || s.status === 'canceled', to: s => ['todo', 'backlog', 'triage'].includes(s.status), actors: HUMAN },
  { row: 'park by hand → blocked(manual)', from: s => ['todo', 'backlog', 'triage'].includes(s.status), to: s => s.status === 'blocked' && s.blockReason === 'manual', actors: HUMAN },
  // PROACTIVE.md §3: the chat that tracks a task moves it through its own work (never to done)
  { row: 'tracked: start (todo / backlog / parked / in review → in_progress)', from: s => ['todo', 'backlog', 'triage', 'in_review'].includes(s.status) || parked(s), to: 'in_progress', actors: AGENT,
    check: (ctx) => !ctx.tracked ? 'Only the chat that tracks this task can move it' : ctx.depsDone === false ? 'Complete dependencies before starting this task' : null },
  { row: 'tracked: in_progress → in_review', from: 'in_progress', to: 'in_review', actors: AGENT, check: (ctx) => ctx.tracked ? null : 'Only the chat that tracks this task can move it' },
  { row: 'tracked: in_progress → blocked(agent)', from: 'in_progress', to: s => s.status === 'blocked' && s.blockReason === 'agent', actors: AGENT, check: (ctx) => ctx.tracked ? null : 'Only the chat that tracks this task can move it' },
  // WORKTREE.md: the task follows its PR (never while a run holds it; the run end comes first)
  { row: 'PR opened and ready → in_review', from: s => s.status !== 'in_progress' && s.status !== 'done' && s.status !== 'canceled' && s.status !== 'in_review', to: 'in_review', actors: SYSTEM,
    when: ctx => ctx.work === 'pr_ready' },
  { row: 'changes requested on its PR → in_progress', from: 'in_review', to: 'in_progress', actors: SYSTEM,
    when: ctx => ctx.work === 'changes_requested', check: startCheck },
  { row: 'PR merged → done', from: s => s.status !== 'in_progress' && s.status !== 'done' && s.status !== 'canceled', to: 'done', actors: SYSTEM,
    when: ctx => ctx.work === 'merged', check: ctx => blank(ctx.doneNote) ? 'A done note is required' : null },
  // PM A3: approved by a reviewer on GitHub (never the PR's author, so never an agent) → done; the PR stays open to merge
  { row: 'PR approved → done', from: 'in_review', to: 'done', actors: SYSTEM,
    when: ctx => ctx.work === 'approved', check: ctx => blank(ctx.doneNote) ? 'A done note is required' : null },
  { row: 'worktree gone → Back to Backlog', from: s => s.status !== 'in_progress' && s.status !== 'done' && s.status !== 'canceled', to: 'backlog', actors: HUMAN,
    when: ctx => !!ctx.worktreeGone }
]
function startCheck(ctx: TransitionCtx): string | null {
  if (!ctx.start) return 'Use Run now to start this task'
  return ctx.depsDone === false ? 'Complete dependencies before starting this task' : null
}
const matches = (m: TaskStatus | ((s: TaskState) => boolean), s: TaskState) => typeof m === 'function' ? m(s) : m === s.status

/** The refusal for a move, or null when §1.4 allows it. */
export function transitionError(from: TaskState, to: TaskState, actor: Actor, ctx: TransitionCtx = {}): string | null {
  // never relaxed, whatever the row: done is a human's (a PR merged by a human on GitHub or from Principia counts; the
  // agent shims refuse gh pr merge, so no agent can merge)
  if (to.status === 'done' && actor !== 'human' && !(actor === 'system' && (ctx.work === 'merged' || ctx.work === 'approved'))) return 'Only a human can mark a task done'
  if (to.status === 'blocked' && !to.blockReason) return 'A blocked task needs a reason'
  if (from.status === to.status && (from.blockReason ?? null) === (to.blockReason ?? null)) return null
  const rows = TRANSITIONS.filter(r => (!r.when || r.when(ctx)) && matches(r.from, from) && matches(r.to, to))
  if (!rows.length) return `A task cannot move from ${stateLabel(from)} to ${stateLabel(to)}`
  const allowed = rows.filter(r => r.actors.includes(actor))
  if (!allowed.length) return to.status === 'done' ? 'Only a human can mark a task done' : `Only ${rows[0].actors.join(' or ')} can move a task from ${stateLabel(from)} to ${stateLabel(to)}`
  let first: string | null = null
  for (const r of allowed) {
    const why = r.check?.(ctx, from, to) ?? null
    if (!why) return null
    first ??= why
  }
  return first
}
/** Throws HiveError('bad_request') when §1.4 does not allow the move. */
export function assertTransition(from: TaskState, to: TaskState, actor: Actor, ctx: TransitionCtx = {}): void {
  const why = transitionError(from, to, actor, ctx)
  if (why) fail(why)
}

// ---------- carried over from today's board (§1.4, last paragraph) ----------

interface EditSubject { companyId: string; status: TaskStatus; departmentId?: string | null; agentId?: string | null }
/** No edits while in flight, and a task's company never changes. */
export function assertEditable(old: EditSubject, next: Pick<EditSubject, 'companyId'>): void {
  if (next.companyId !== old.companyId) fail('Company cannot change after task creation; create a new task in the correct company')
  if (old.status === 'in_progress') fail('This task is running. Cancel its run before editing it.')
}
/** Department or agent changes need the task not to be in flight. */
export function assertReassignable(old: EditSubject, next: { departmentId?: string | null; agentId?: string | null }): void {
  const changed = (next.departmentId !== undefined && (next.departmentId ?? null) !== (old.departmentId ?? null)) || (next.agentId !== undefined && (next.agentId ?? null) !== (old.agentId ?? null))
  if (changed && old.status === 'in_progress') fail('This task is running. Stop it before changing its department or agent.')
}

// ---------- run end (§1.4 rows from in_progress, §4.5) ----------

/**
 * LIVE.md §16.1: a failed run that stopped at the usage limit. 'wait': back to To do for its one restart at the reset;
 * 'again': that restart stopped at the limit too, so it parks like any failed run.
 */
export type LimitEnd = 'wait' | 'again'
/** Why main canceled a run: a restart, its company's pause, or "Pause this task" (task_paused). */
export type StopReason = 'interrupted' | 'handoff_cap' | 'paused' | 'task_paused' | 'worktree_in_the_way'

export interface RunEnd {
  to: TaskState
  kind: 'report' | 'asked' | 'run_finished' | 'parked' | 'paused'
  by: Actor
  message: string
  /** in_review with no report: the card shows "no report" */
  noReport?: boolean
  /** back in To do to wait for the usage limit's reset (LIVE.md §16.1) */
  limitWait?: boolean
}
interface RunEndTask {
  ask?: { prompt: string; answer?: string } | null
  report?: { outcome: 'review' | 'blocked'; summary: string } | null
}
const clip = (s: string, n = 300) => s.length > n ? `${s.slice(0, n - 1)}…` : s
/** "Waiting on PR-40", "blocked by NC-3", "once PR-40 merges", "until NC-8 ships" */
const WAITS_ON = /\b(wait(s|ing)?\s+(on|for)|blocked\s+(on|by)|depends\s+on|until|once|after)\b/i
const TASK_REF = /\b([A-Za-z][A-Za-z0-9]{0,9}-\d+)\b/g
/**
 * PR-47: the open tasks a blocked line only waits for ("Waiting on PR-40 to merge"), else []. Every id it names must be
 * an open task of `tasks` other than `selfId` (an unknown, done or canceled one keeps it the founder's call). Pure.
 */
export function waitsOnTasks<T extends { id: string; identifier: string; status: string }>(text: string, tasks: readonly T[], selfId: string): T[] {
  if (!WAITS_ON.test(text)) return []
  const ids = [...new Set([...text.matchAll(TASK_REF)].map((m) => m[1]!.toUpperCase()))]
  const on = ids.map((id) => tasks.find((t) => t.identifier.toUpperCase() === id)).filter((t): t is T => !!t && t.id !== selfId && t.status !== 'done' && t.status !== 'canceled')
  return on.length && on.length === ids.length ? on : []
}
/**
 * Where a finished run leaves its task. The report and ask were cleared when the run started, so any present were set
 * by this run (task_report / task_ask, or the fenced report block of an inject adapter). `stopReason`: why main
 * canceled the run (time or wake cap), when it did.
 */
export function runEndState(t: RunEndTask, run: { status: 'passed' | 'failed' | 'canceled'; reason?: string | null }, depsDone: boolean, stopReason?: StopReason | null, limit?: LimitEnd | null): RunEnd {
  if (t.ask && !t.ask.answer) return { to: { status: 'blocked', blockReason: 'needs_input' }, kind: 'asked', by: 'agent', message: `Agent asked: ${clip(t.ask.prompt)}` }
  // task_create({blocksCurrent}) added a dependency during the run (or the agent is blocked only on other tasks): wait
  // for it, then heal. Never Needs you: nothing in it waits on a person
  if (!depsDone && (t.report || run.status === 'passed')) return { to: { status: 'blocked', blockReason: 'deps' }, kind: 'parked', by: 'system', message: t.report?.outcome === 'blocked' ? `Waiting for the tasks this one depends on: ${clip(t.report.summary)}` : 'Waiting for the tasks this one depends on' }
  if (t.report?.outcome === 'blocked') return { to: { status: 'blocked', blockReason: 'agent' }, kind: 'report', by: 'agent', message: `Agent is blocked: ${clip(t.report.summary)}` }
  if (t.report?.outcome === 'review') return { to: { status: 'in_review' }, kind: 'report', by: 'agent', message: `Ready for review: ${clip(t.report.summary)}` }
  if (run.status === 'passed') return { to: { status: 'in_review' }, kind: 'run_finished', by: 'system', message: 'Agent finished without a report (no report). Human review required.', noReport: true }
  // five doors A4: its company was paused mid-turn. The work is saved: back to To do, and Resume starts it again
  if (stopReason === 'paused') return { to: { status: 'todo' }, kind: 'paused', by: 'system', message: 'Paused with its company. The work so far is saved; it continues when you resume.' }
  // five doors C9 "Pause this task": the founder paused this one task. Back to To do, held there until Start (never a failure)
  if (stopReason === 'task_paused') return { to: { status: 'todo' }, kind: 'paused', by: 'human', message: 'Paused by you. The work so far is saved; Start picks it up again.' }
  // PR-84: a folder at the task's worktree path could not be adopted. No run went wrong: a person has to move it
  if (stopReason === 'worktree_in_the_way') return { to: { status: 'blocked', blockReason: 'agent' }, kind: 'parked', by: 'system', message: clip(run.reason || "The task's worktree folder is in the way.", 500) }
  const why = run.reason ? `: ${clip(run.reason, 200)}` : ''
  if (stopReason) return { to: { status: 'blocked', blockReason: stopReason as 'interrupted' | 'handoff_cap' }, kind: 'parked', by: 'system', message: `Run stopped (${stopReason})${why}` }
  if (run.status === 'failed' && limit === 'wait') return { to: { status: 'todo' }, kind: 'paused', by: 'system', message: 'Stopped at the usage limit. The work so far is saved; it restarts by itself once the limit resets.', limitWait: true }
  if (run.status === 'failed') return { to: { status: 'blocked', blockReason: 'run_failed' }, kind: 'run_finished', by: 'system', message: `Run failed${why}${limit === 'again' ? '. It stopped at the usage limit again after its one automatic restart.' : ''}` }
  return { to: { status: 'blocked', blockReason: 'no_report' }, kind: 'run_finished', by: 'system', message: `Run canceled${why} before the agent reported. Review and Unpark or retry.` }
}
