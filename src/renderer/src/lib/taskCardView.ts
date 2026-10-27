/**
 * CHAT-UI.md §8: what a live task card shows, from the stored card (main's last read) and the live sources the rest
 * of the app already uses: the board task (state.tasks), the run's root agent (state.agents: its activity line) and
 * open asks (state.asks). The live task wins over the stored state, so the card moves the moment the task does.
 * Pure: no hive, no DOM.
 */
import type { AgentNode, Ask } from '@shared/live'
import type { CompanyTask } from '@shared/company'
import type { ForumMessage } from '@shared/forum'
import { elapsedLabel, isFinishedCard, taskCardResult, taskCardState, TASK_CARD_LABEL, type ForumTaskCard, type StripTask, type TaskCardState } from '@shared/taskCard'
import { plainActivity } from './plainActivity'

export interface TaskCardView {
  state: TaskCardState
  label: string
  /** the live activity line while it works ("Reading the PostHog funnel"); null otherwise */
  activity: string | null
  elapsed: string
  /** the one-line result once it came back */
  result: string | null
  prUrl: string | null
  /** the run to Watch (its live view); null before it starts */
  runId: string | null
  /** what it waits on you for: the board ask's prompt, or the live ask's title */
  needs: { prompt: string; options: string[]; live: boolean } | null
  /** the task still exists on the board (Open task works) */
  onBoard: boolean
}

type LiveTask = Pick<CompanyTask, 'status' | 'runId' | 'updatedAt'> & Partial<Pick<CompanyTask, 'blockReason' | 'ask' | 'report' | 'doneNote' | 'work'>>

/** The run's root agent (a step root), newest first: where the activity line comes from. */
export function rootOfRun(agents: Iterable<AgentNode>, runId: string | null | undefined): AgentNode | null {
  if (!runId) return null
  let best: AgentNode | null = null
  for (const a of agents) if (a.runId === runId && a.parentId === null && (!best || a.updatedAt > best.updatedAt)) best = a
  return best
}

/** The open live ask of a run (a permission or question the CLI shows now), if any. */
export function openAskOfRun(asks: Iterable<Ask>, runId: string | null | undefined): Ask | null {
  if (!runId) return null
  for (const a of asks) if (a.status === 'open' && a.runId === runId) return a
  return null
}

export function taskCardView(card: ForumTaskCard, task: LiveTask | null | undefined, live: { root?: AgentNode | null; ask?: Ask | null; code?: boolean; now?: number } = {}): TaskCardView {
  const now = live.now ?? Date.now()
  const state = task ? taskCardState({ status: task.status, blockReason: task.blockReason ?? null, ask: task.ask ?? null, runId: task.runId }, { openAsk: !!live.ask }) : card.state
  const finished = isFinishedCard(state)
  const runId = task?.runId ?? card.runId ?? null
  const result = finished ? ((task ? taskCardResult({ report: task.report ?? null, doneNote: task.doneNote ?? null }) : null) ?? card.result ?? null) : null
  const prUrl = task?.work?.pr?.url ?? card.prUrl ?? null
  const root = live.root ?? null
  const activity = state === 'working' && root && (root.status === 'working' || root.status === 'starting') ? plainActivity(root.activity, { code: live.code ?? true }) : null
  // the clock stops when it came back: the card's own finish time, else the task's last change
  const end = finished ? (card.state === state && card.finishedAt ? card.finishedAt : (task?.updatedAt ?? card.finishedAt ?? null)) : null
  let needs: TaskCardView['needs'] = null
  if (state === 'needs_you') {
    if (live.ask) needs = { prompt: live.ask.title, options: [], live: true }
    else if (task?.ask && !task.ask.answer) needs = { prompt: task.ask.prompt, options: task.ask.options ?? [], live: false }
    else needs = { prompt: task?.status === 'blocked' ? 'It is blocked and waits for you' : 'It waits for you', options: [], live: false }
  }
  return { state, label: TASK_CARD_LABEL[state], activity, elapsed: elapsedLabel(card.startedAt, end, now), result, prUrl, runId, needs, onBoard: !!task }
}

/** The task cards of a conversation's messages, newest card per task, in order. */
export function cardsOfMessages(msgs: readonly ForumMessage[]): ForumTaskCard[] {
  const byTask = new Map<string, ForumTaskCard>()
  for (const m of msgs) if (m.task) byTask.set(m.task.taskId, m.task)
  return [...byTask.values()]
}

/** The "Working on it" strip's tasks from cards (a conversation's, or a chat's), with the live state. */
export function stripTasks(cards: readonly ForumTaskCard[], tasks: readonly LiveTaskWithId[], who: (agentId: string | null) => string | null, openRuns: ReadonlySet<string> = new Set()): StripTask[] {
  return cards.map((card) => {
    const t = tasks.find((x) => x.id === card.taskId)
    const state = t ? taskCardState({ status: t.status, blockReason: t.blockReason ?? null, ask: t.ask ?? null, runId: t.runId }, { openAsk: !!t.runId && openRuns.has(t.runId) }) : card.state
    return { taskId: card.taskId, identifier: card.identifier, who: who(t?.agentId ?? card.agentId), state, startedAt: card.startedAt }
  })
}

type LiveTaskWithId = LiveTask & Pick<CompanyTask, 'id'> & Partial<Pick<CompanyTask, 'agentId'>>
