/**
 * CHAT-UI.md §8: the live task card. When a task is filed from (or for) a conversation, the conversation does not get
 * a grey "Julia made VO-9 from this message." line any more: it gets a card that says what is being done, by whom,
 * where it stands now, and what came back. The card is one Forum message (kind 'system' with a `task` payload) that
 * main patches in place; the desktop reads the live task, run and agent on top of it.
 *
 * Pure: shared by main (the stored state, the phone), the renderer and the phone web app.
 */

/** What the card says about its task. */
export const TASK_CARD_STATES = ['queued', 'working', 'needs_you', 'in_review', 'done', 'failed'] as const
export type TaskCardState = (typeof TASK_CARD_STATES)[number]
export const TASK_CARD_LABEL: Record<TaskCardState, string> = {
  queued: 'Queued',
  working: 'Working',
  needs_you: 'Needs you',
  in_review: 'In review',
  done: 'Done',
  failed: 'Failed'
}

/** The stored payload of a card message (ForumMessage.task). */
export interface ForumTaskCard {
  taskId: string
  identifier: string
  title: string
  /** company_agents.id of who is on it; null = nobody yet */
  agentId: string | null
  /** the Forum member who filed it (the agent who replied, or the person who pressed Make task) */
  filedBy: string | null
  /** the person's message it was filed from (one task per message, whoever files it) */
  messageId?: string
  /** main's last read of the task (the phone shows it; the desktop recomputes it live) */
  state: TaskCardState
  runId?: string | null
  /** one line: the run report's summary, the done note */
  result?: string | null
  prUrl?: string | null
  /** when the card was posted (elapsed time starts here) */
  startedAt: string
  /** set when it reached in review, done or failed */
  finishedAt?: string | null
  /** the run whose result was posted back into the conversation (one post per run) */
  resultFor?: string | null
  /** the task is done or canceled: main stops following it */
  final?: boolean
}

/** The task fields the state needs (CompanyTask, ForumTaskView). */
export interface CardTask {
  status: string
  blockReason?: string | null
  ask?: { answer?: string | null } | null
  runId?: string | null
}

/** Blocked because the run went wrong (not because it waits on a person or on other tasks). */
const RUN_WENT_WRONG = new Set(['run_failed', 'interrupted', 'no_report', 'limit'])

/**
 * The card's state from the task (and, on the desktop, whether its run has an open live ask: a permission or a
 * question the CLI shows right now).
 */
export function taskCardState(t: CardTask, live: { openAsk?: boolean } = {}): TaskCardState {
  switch (t.status) {
    case 'done':
      return 'done'
    case 'canceled':
      return 'failed'
    case 'in_review':
      return 'in_review'
    case 'blocked':
      if (t.blockReason === 'deps') return 'queued'
      if (t.blockReason && RUN_WENT_WRONG.has(t.blockReason)) return 'failed'
      return 'needs_you'
    case 'in_progress':
      return live.openAsk || (t.ask && !t.ask.answer) ? 'needs_you' : 'working'
    default:
      // triage, backlog, todo: waiting for its turn
      return t.ask && !t.ask.answer ? 'needs_you' : 'queued'
  }
}

/** Still open: the strip at the top of the conversation lists it. In review waits on you, but the work came back. */
export function isOpenCard(s: TaskCardState): boolean {
  return s === 'queued' || s === 'working' || s === 'needs_you'
}
/** The work came back (the result is posted once per run). */
export function isFinishedCard(s: TaskCardState): boolean {
  return s === 'in_review' || s === 'done' || s === 'failed'
}

/** The one-line result: the report's summary, else the done note. */
export function taskCardResult(t: { report?: { summary?: string } | null; doneNote?: string | null }): string | null {
  const raw = t.report?.summary?.trim() || t.doneNote?.trim() || ''
  const one = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  if (!one) return null
  return one.length > 200 ? `${one.slice(0, 199)}…` : one
}

/** "40s", "2m", "1h 5m", "2d" between two times. */
export function elapsedLabel(fromIso: string, toIso: string | null | undefined, now: number = Date.now()): string {
  const from = Date.parse(fromIso)
  const to = toIso ? Date.parse(toIso) : now
  if (!Number.isFinite(from) || !Number.isFinite(to)) return ''
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** One open task for the strip. */
export interface StripTask {
  taskId: string
  identifier: string
  /** who is on it (display name); null = nobody yet */
  who: string | null
  state: TaskCardState
  startedAt: string
}
export interface WorkingStrip {
  /** the collapsed line: "Julia is working on VO-9 · 2m", "2 tasks running · 1 needs you" */
  line: string
  /** open tasks, needs-you first, then oldest first */
  tasks: StripTask[]
  /** the one to Watch from the collapsed line (the only one, or the first that needs you) */
  focus: StripTask
}

/** "Working on it": the open tasks started from this conversation, or null when there are none. */
export function workingStrip(cards: readonly StripTask[], now: number = Date.now()): WorkingStrip | null {
  const open = cards.filter((c) => isOpenCard(c.state))
  if (!open.length) return null
  const rank = (s: TaskCardState): number => (s === 'needs_you' ? 0 : s === 'working' ? 1 : 2)
  const tasks = [...open].sort((a, b) => rank(a.state) - rank(b.state) || Date.parse(a.startedAt) - Date.parse(b.startedAt))
  const focus = tasks[0]!
  if (tasks.length === 1) {
    const t = focus
    const age = elapsedLabel(t.startedAt, null, now)
    const who = t.who ?? 'Nobody yet'
    const line =
      t.state === 'needs_you'
        ? `${t.identifier} needs you${t.who ? ` · ${t.who} is waiting` : ''}`
        : t.state === 'working'
          ? `${who} is working on ${t.identifier}`
          : `${t.identifier} is queued${t.who ? ` for ${t.who}` : ''}`
    return { line: age ? `${line} · ${age}` : line, tasks, focus }
  }
  const needs = tasks.filter((t) => t.state === 'needs_you').length
  return { line: `${tasks.length} tasks running${needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : ''}`, tasks, focus }
}

/** The card's text line (what an older client, a search hit or a notification shows). */
export function taskCardLine(byName: string, identifier: string, title: string): string {
  return `${byName} started ${identifier}: ${title}`
}
