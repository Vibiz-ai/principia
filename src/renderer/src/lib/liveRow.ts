/**
 * LIVE.md §6 + CHAT-UI.md §8.4: what a live row says and where it goes. A row is labelled by what is running ("Julia ·
 * VO-15 Check why maria@example.com's…", then "Running a SQL query in PostHog"), one row per running task (an agent on two
 * tasks at once is two rows), and a click opens that task's live view in Chats (`task:<id>`), never the agent's
 * resting chat. Pure: no hive, no DOM.
 */
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { Id } from '@shared/types'
import type { LiveItem } from './companyModel'
import { taskName } from './desk'

export type LiveTask = Pick<CompanyTask, 'id' | 'companyId' | 'identifier' | 'title' | 'status' | 'runId' | 'agentId'> & Partial<Pick<CompanyTask, 'updatedAt'>>
type Seat = Pick<CompanyAgent, 'id' | 'companyId'>

/** The Chats key of a task's live view. */
export const liveTaskKey = (taskId: Id): string => `task:${taskId}`
/** The task id of a `task:<id>` Chats key, else null. */
export function taskOfChatKey(chat: string | null | undefined): Id | null {
  return chat?.startsWith('task:') ? chat.slice(5) || null : null
}

/** The board task a live item works on: its own taskId, else the in-progress task whose run it is. */
export function liveTaskOf<T extends LiveTask>(it: Pick<LiveItem, 'taskId' | 'runId' | 'sessionId'>, tasks: readonly T[]): T | undefined {
  if (it.taskId) {
    const t = tasks.find((x) => x.id === it.taskId)
    if (t) return t
  }
  return tasks.find((x) => x.status === 'in_progress' && !!x.runId && (x.runId === it.runId || x.runId === it.sessionId))
}

export interface LiveRowView {
  /** who: the agent's name, or the run's own title when it is no task */
  name: string
  /** what is running: "VO-15 Check why…" (the title alone in a company with no code, C7); null when it is no task */
  task: string | null
  /** what it is doing now, in words (the one live source's activity sentence) */
  activity: string | null
  /** the task whose live view a click opens */
  taskId: Id | null
  companyId: Id
  /** the agent seat on it */
  seatId: Id | null
}

export function liveRowView<S extends Seat>(it: LiveItem, o: { tasks: readonly LiveTask[]; seats: readonly S[]; nameOf: (seat: S) => string; code: boolean }): LiveRowView {
  const t = liveTaskOf(it, o.tasks)
  if (t) {
    const seat = t.agentId ? o.seats.find((a) => a.id === t.agentId && a.companyId === t.companyId) : undefined
    const task = taskName(t, o.code)
    // "Starting" (its agent did not report in yet) and a missing line both read as the work having begun
    const activity = it.detail && it.detail !== task ? it.detail : null
    return seat ? { name: o.nameOf(seat), task, activity, taskId: t.id, companyId: t.companyId, seatId: seat.id } : { name: task, task: null, activity, taskId: t.id, companyId: t.companyId, seatId: null }
  }
  return { name: o.code ? it.title : it.title.replace(/^[A-Z][A-Z0-9]{0,5}-\d+ · /, ''), task: null, activity: it.detail, taskId: null, companyId: it.companyId, seatId: null }
}

/** The tasks an agent is working on now, oldest start first (the banner on its resting chat names them). */
export function workingTasksOf<T extends LiveTask>(seatId: Id, companyId: Id, tasks: readonly T[]): T[] {
  return tasks.filter((t) => t.agentId === seatId && t.companyId === companyId && t.status === 'in_progress' && !!t.runId).sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? -1 : 1))
}

/** The Chats list row a task's live view belongs to (its agent's row), so the list keeps it selected. */
export function rowKeyOfLive(chat: string | null | undefined, tasks: readonly LiveTask[]): string | null {
  const id = taskOfChatKey(chat)
  const t = id ? tasks.find((x) => x.id === id) : undefined
  return t?.agentId ? `agent:${t.agentId}` : null
}
