/**
 * CHAT-UI.md §8.6: tasks are the subagents of the conversation that filed them. The conversation's row is where the
 * eye goes: "2 tasks working" (or "1 needs you") while they run, "VO-16 finished · unread" once a result came back
 * that you have not read, and LIVE lists conversations with work in progress, not the agents' resting chats. A task
 * nobody filed from a conversation (autopilot, Board › Run now, a routine) is a row of its own that opens its task chat.
 * Pure: no hive, no DOM (convWork.test.ts).
 */
import type { CompanyTask } from '@shared/company'
import { isFinishedCard, taskCardState, type TaskCardState } from '@shared/taskCard'
import type { LiveItem } from './companyModel'
import { liveTaskOf, type LiveTask } from './liveRow'

export type WorkTask = LiveTask & Partial<Pick<CompanyTask, 'blockReason' | 'ask' | 'createdAt' | 'report' | 'doneNote'>>

/** A task's card state from the board task (the same rules the card uses). */
export function workState(t: Pick<WorkTask, 'status' | 'runId'> & Partial<Pick<WorkTask, 'blockReason' | 'ask'>>): TaskCardState {
  return taskCardState({ status: t.status, blockReason: t.blockReason ?? null, ask: t.ask ?? null, runId: t.runId })
}

export interface ConvWork<T extends WorkTask = WorkTask> {
  working: T[]
  needs: T[]
  queued: T[]
  /** tasks whose result (or question) is among the conversation's unread messages */
  unread: T[]
}
const EMPTY: ConvWork<never> = { working: [], needs: [], queued: [], unread: [] }

/** The work of one conversation: its tasks (taskChannels: task id → channel id) by state, and the unread results. */
export function workOf<T extends WorkTask>(channelId: string, tasks: readonly T[], taskChannels: Readonly<Record<string, string>> | null | undefined, unreadTasks: readonly string[] = []): ConvWork<T> {
  if (!taskChannels) return EMPTY
  const w: ConvWork<T> = { working: [], needs: [], queued: [], unread: [] }
  for (const t of tasks) {
    if (taskChannels[t.id] !== channelId) continue
    const s = workState(t)
    if (s === 'working') w.working.push(t)
    else if (s === 'needs_you') w.needs.push(t)
    else if (s === 'queued') w.queued.push(t)
  }
  for (const id of unreadTasks) {
    const t = tasks.find((x) => x.id === id)
    if (t && !w.needs.includes(t) && !w.working.includes(t)) w.unread.push(t)
  }
  return w
}

export const hasWork = (w: ConvWork): boolean => w.working.length > 0 || w.needs.length > 0
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const name = (t: Pick<WorkTask, 'identifier' | 'title'>, code: boolean): string => (code ? t.identifier : `“${t.title.length > 40 ? `${t.title.slice(0, 39)}…` : t.title}”`)

/**
 * The row's second line for its work, or null (the row keeps its own line): "1 needs you · 2 tasks working",
 * "2 tasks working", "VO-16 finished · unread", "2 results to read", "1 task queued".
 */
export function workLine(w: ConvWork, opts: { code?: boolean } = {}): string | null {
  const code = opts.code ?? true
  const parts: string[] = []
  if (w.needs.length) parts.push(`${w.needs.length} need${w.needs.length === 1 ? 's' : ''} you`)
  if (w.working.length) parts.push(`${plural(w.working.length, 'task')} working`)
  if (parts.length) return parts.join(' · ')
  if (w.unread.length === 1) {
    const t = w.unread[0]!
    const s = workState(t)
    return `${name(t, code)} ${s === 'failed' ? 'stopped' : isFinishedCard(s) ? 'finished' : 'has news'} · unread`
  }
  if (w.unread.length > 1) return `${w.unread.length} results to read`
  if (w.queued.length) return `${plural(w.queued.length, 'task')} queued`
  return null
}

/** Where a row sorts: needs you, then work in progress (or someone answering), then unread results, then the rest. */
export function workRank(w: ConvWork, answering = false): number {
  if (w.needs.length) return 3
  if (w.working.length || answering) return 2
  if (w.unread.length) return 1
  return 0
}

/** Rows by rank, then newest first (the eye goes to the conversation with work). */
export function byWork<R extends { rank: number; at: string }>(rows: readonly R[]): R[] {
  return [...rows].sort((a, b) => b.rank - a.rank || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

/** A task with no owning conversation (autopilot, Run now, a routine): its own row, opening its task chat. */
export function isOrphanTask(t: Pick<WorkTask, 'id'>, taskChannels: Readonly<Record<string, string>> | null | undefined): boolean {
  return !taskChannels?.[t.id]
}

export type LiveEntry =
  /** a conversation with work in progress: its working items (tasks, an answer on its way) together */
  | { kind: 'conv'; key: string; channelId: string; items: LiveItem[]; taskIds: string[]; answering: boolean }
  /** anything else live: a task with no conversation, your own chat, a workflow step */
  | { kind: 'item'; key: string; item: LiveItem; taskId: string | null }

/**
 * LIVE's rows from the one live source's working items: every item that is a task filed from a conversation (or an
 * agent answering in one) joins that conversation's entry, in the order the first one appears; the rest stay rows.
 * `replyConv` maps a reply run's title to its conversation (conversationOfRunTitle).
 */
export function groupLive(items: readonly LiveItem[], o: { tasks: readonly LiveTask[]; taskChannels: Readonly<Record<string, string>> | null | undefined; replyConv?: (it: LiveItem) => string | null }): LiveEntry[] {
  const out: LiveEntry[] = []
  const byConv = new Map<string, Extract<LiveEntry, { kind: 'conv' }>>()
  for (const it of items) {
    const t = liveTaskOf(it, o.tasks)
    const ch = t ? (o.taskChannels?.[t.id] ?? null) : (o.replyConv?.(it) ?? null)
    if (!ch) {
      out.push({ kind: 'item', key: it.key, item: it, taskId: t?.id ?? null })
      continue
    }
    let e = byConv.get(ch)
    if (!e) {
      e = { kind: 'conv', key: `conv:${ch}`, channelId: ch, items: [], taskIds: [], answering: false }
      byConv.set(ch, e)
      out.push(e)
    }
    e.items.push(it)
    if (t) {
      if (!e.taskIds.includes(t.id)) e.taskIds.push(t.id)
    } else e.answering = true
  }
  return out
}

/**
 * Where the status bar's "2 working" goes: the conversation when every working item belongs to one, the task chat when
 * it is one task with no conversation, else Chats › Live only.
 */
export function workingTarget(items: readonly LiveItem[], o: Parameters<typeof groupLive>[1]): { kind: 'conv'; channelId: string } | { kind: 'task'; taskId: string } | { kind: 'live' } {
  const g = groupLive(items, o)
  if (g.length === 1 && g[0]!.kind === 'conv') return { kind: 'conv', channelId: g[0]!.channelId }
  if (g.length === 1 && g[0]!.kind === 'item' && g[0]!.taskId) return { kind: 'task', taskId: g[0]!.taskId }
  return { kind: 'live' }
}

/** "Julia" or "Julia and Marcus": who works on a conversation's live tasks. */
export function workersLine(names: readonly string[]): string {
  const n = [...new Set(names.filter(Boolean))]
  return n.length <= 1 ? (n[0] ?? '') : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n[0]} and ${n.length - 1} others`
}

/**
 * CHAT-UI.md §8.6: a task with no conversation that came back (or stopped for you) since you last opened its chat is
 * unread. `seen`: task id → when its chat was last open; `since`: when Principia started keeping this (older results
 * never light up), and only the last week counts.
 */
export function orphanUnread(t: Pick<WorkTask, 'id' | 'status' | 'runId' | 'updatedAt'> & Partial<Pick<WorkTask, 'blockReason' | 'ask' | 'report'>>, seen: Readonly<Record<string, string>>, since: string, now = Date.now()): boolean {
  const s = workState(t)
  if (!isFinishedCard(s) && s !== 'needs_you') return false
  if (!t.runId && !t.report) return false
  const at = t.updatedAt ?? ''
  if (!at || Date.parse(at) < now - 7 * 86_400_000) return false
  return at > (seen[t.id] ?? '') && at > since
}
