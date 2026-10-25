/**
 * Five doors step 3, the agent desk's conversation (design §4.3): everything you and one agent said, built from that
 * agent's tasks and their activity, oldest first. Your requests and answers are your bubbles; the agent's reports,
 * questions and replies are its bubbles; a task that came from setup, the Board or Linear is a task card; starts,
 * approvals and stops are one quiet line. The latest report of a task waiting for review carries the draft card
 * (Approve / Send back), and an open question carries its answer box. Pure (desk.test.ts covers the words).
 */
import type { CompanyTask, TaskActivity, TaskDetail } from '@shared/company'
import { DESK_PREFIX, finishedLine, taskOrigin, type TaskOrigin } from './desk'

export type ThreadItem =
  | { kind: 'me'; id: string; at: string; text: string; taskId: string }
  | { kind: 'agent'; id: string; at: string; text: string; taskId: string; card: 'review' | 'ask' | 'blocked' | null }
  | { kind: 'task'; id: string; at: string; taskId: string; origin: TaskOrigin }
  | { kind: 'note'; id: string; at: string; text: string; taskId: string }

const PREFIX = /^(Ready for review|Agent is blocked|Agent asked|Answer|Approved|Sent back|Gate passed|Gate failed):\s*/
const unprefix = (m: string): string => m.replace(PREFIX, '').trim()

export function deskThread(details: readonly TaskDetail[], o: { companyCreatedAt?: string | null; agentName: string }): ThreadItem[] {
  const out: ThreadItem[] = []
  for (const { task, activity } of details) {
    const desk = !!task.externalId?.startsWith(DESK_PREFIX)
    const acts = [...activity].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    const lastReport = [...acts].reverse().find((a) => a.kind === 'report')
    const lastAsk = [...acts].reverse().find((a) => a.kind === 'asked')
    let opened = false
    for (const a of acts) {
      const base = { id: a.id, at: a.createdAt, taskId: task.id }
      switch (a.kind) {
        case 'created':
          if (opened) break
          opened = true
          out.push(desk ? { ...base, kind: 'me', text: task.description || task.title } : { ...base, kind: 'task', origin: taskOrigin(task, o.companyCreatedAt) })
          break
        case 'comment':
          if (a.by === 'human') out.push({ ...base, kind: 'me', text: a.message })
          else if (a.by === 'agent') out.push({ ...base, kind: 'agent', text: a.message, card: null })
          else out.push({ ...base, kind: 'note', text: a.message })
          break
        case 'report': {
          const latest = a.id === lastReport?.id
          const review = latest && task.status === 'in_review'
          const blocked = latest && task.status === 'blocked' && task.blockReason === 'agent'
          // the latest report reads in full from the task (activity keeps a clipped copy)
          const text = latest && task.report?.summary ? task.report.summary : unprefix(a.message)
          out.push({ ...base, kind: 'agent', text, card: review ? 'review' : blocked ? 'blocked' : null })
          break
        }
        case 'asked': {
          const open = a.id === lastAsk?.id && !!task.ask && !task.ask.answer
          out.push({ ...base, kind: 'agent', text: open ? task.ask!.prompt : unprefix(a.message), card: open ? 'ask' : null })
          break
        }
        case 'answered':
        case 'sent_back':
          out.push({ ...base, kind: 'me', text: unprefix(a.message) })
          break
        case 'approved':
          out.push({ ...base, kind: 'note', text: `You approved ${task.title}` })
          break
        case 'started':
          out.push({ ...base, kind: 'note', text: `${o.agentName} started ${task.title}` })
          break
        case 'interrupted':
        case 'paused':
          out.push({ ...base, kind: 'note', text: a.message })
          break
        case 'parked':
          // waiting on dependencies heals by itself: not worth a line in a conversation
          if (!/dependenc/i.test(a.message)) out.push({ ...base, kind: 'note', text: a.message })
          break
        default:
          break
      }
    }
    // a draft that came back without a written report (the run just ended in review): say so, with its card
    if (task.status === 'in_review' && !out.some((m) => m.taskId === task.id && m.kind === 'agent' && m.card === 'review'))
      out.push({ id: `review:${task.id}`, at: [...acts].reverse().find((a) => a.kind !== 'comment' && a.kind !== 'coalesced')?.createdAt ?? task.updatedAt, taskId: task.id, kind: 'agent', text: task.report?.summary || finishedLine(task.title), card: 'review' })
    if (!opened) out.push({ id: `t:${task.id}`, at: task.createdAt, taskId: task.id, ...(desk ? { kind: 'me' as const, text: task.description || task.title } : { kind: 'task' as const, origin: taskOrigin(task, o.companyCreatedAt) }) })
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

/** The tasks a desk loads: the agent's, newest activity first, at most `limit`. */
export function deskTasks(tasks: readonly CompanyTask[], agentId: string, companyId: string, limit = 15): CompanyTask[] {
  return tasks
    .filter((t) => t.agentId === agentId && t.companyId === companyId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit)
}

/** The last line of a conversation, for the Chats list row. */
export function lastLine(items: readonly ThreadItem[], titleOf: (taskId: string) => string): string {
  const last = items[items.length - 1]
  if (!last) return ''
  if (last.kind === 'task') return titleOf(last.taskId)
  return last.kind === 'me' ? `You: ${last.text}` : last.text
}

export type { TaskActivity }
