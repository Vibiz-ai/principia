/**
 * CHAT-UI.md §8: what a live task card shows, from the stored card (main's last read) and the live sources the rest
 * of the app already uses: the board task (state.tasks), the run's root agent (state.agents: its activity line) and
 * open asks (state.asks). The live task wins over the stored state, so the card moves the moment the task does.
 * Pure: no hive, no DOM.
 */
import type { AgentEvent, AgentNode, Ask } from '@shared/live'
import type { CompanyTask } from '@shared/company'
import type { ForumMessage } from '@shared/forum'
import { elapsedLabel, isFinishedCard, taskCardResult, taskCardState, TASK_CARD_LABEL, type ForumTaskCard, type StripTask, type TaskCardState } from '@shared/taskCard'
import { parseDeepLink } from '@shared/deepLink'
import { plainActivity } from './plainActivity'

export interface TaskCardView {
  state: TaskCardState
  label: string
  /** the live activity line while it works ("Reading the PostHog funnel"); null otherwise */
  activity: string | null
  elapsed: string
  /** when the work started: the run's root agent while it works ("Working · 1m 12s" ticks from here), else the card */
  since: string
  /** the one-line result once it came back (also the report of a task that stopped to wait for you) */
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
  // blocked waiting for you (needs input, parked): the report it stopped with is the outcome line too
  const outcome = finished || (state === 'needs_you' && task?.status === 'blocked')
  const result = outcome ? ((task ? taskCardResult({ report: task.report ?? null, doneNote: task.doneNote ?? null }) : null) ?? (finished ? (card.result ?? null) : null)) : null
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
  const since = state === 'working' && root && root.runId === runId && root.startedAt ? root.startedAt : card.startedAt
  return { state, label: TASK_CARD_LABEL[state], activity, elapsed: elapsedLabel(since, end, now), since, result, prUrl, runId, needs, onBoard: !!task }
}

/** One line of what the agent is doing, for the card's live tail ("Reading taskCard.ts", "Running npm test"). */
export interface TailLine {
  key: number
  kind: AgentEvent['kind']
  text: string
  /** a tool still running, failed or denied; null for text */
  state: AgentEvent['state']
}

const clipLine = (s: string, n = 140): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * The last few things a run's root agent did, as plain lines: tool calls in words (a command reads "Running npm
 * test" in a company with code), its latest message's first line, errors and asks. Thinking and answers are left out.
 */
export function tailLines(events: readonly AgentEvent[], opts: { n?: number; code?: boolean } = {}): TailLine[] {
  const n = opts.n ?? 4
  const code = opts.code ?? true
  const out: TailLine[] = []
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i]!
    let text: string | null = null
    if (e.kind === 'tool') {
      const cmd = /^(?:Bash|shell|exec_command|run_shell_command)\s+(.+)$/.exec(e.summary)
      text = cmd && code ? `Running ${cmd[1]}` : plainActivity(e.summary, { code })
    } else if (e.kind === 'text') text = (e.detail ?? e.summary).split('\n').find((l) => l.trim()) ?? null
    else if (e.kind === 'error' || e.kind === 'ask' || e.kind === 'status') text = e.summary
    if (!text?.trim()) continue
    out.push({ key: e.seq, kind: e.kind, text: clipLine(text), state: e.state })
  }
  return out.reverse()
}

/** The services a message's principia://connect/<tool> links name (a task's question draws them as Connect buttons). */
export function connectToolsIn(text: string): string[] {
  const out: string[] = []
  for (const raw of text.match(/principia:\/\/connect\/[^\s)>\]]+/gi) ?? []) {
    const l = parseDeepLink(raw.replace(/[.,;:!?]+$/, ''))
    if (l?.kind === 'connect' && l.tool !== 'mcp' && !out.includes(l.tool)) out.push(l.tool)
  }
  return out
}

/** A task's question in its conversation (the filer's message, ForumService.followAsk) that still waits for the person. */
export function isOpenTaskQuestion(m: Pick<ForumMessage, 'kind' | 'ask'>): boolean {
  return m.kind === 'ask' && !!m.ask?.taskId && m.ask.status === 'open'
}

/** The task cards of a conversation's messages, newest card per task, in order. */
export function cardsOfMessages(msgs: readonly ForumMessage[]): ForumTaskCard[] {
  const byTask = new Map<string, ForumTaskCard>()
  for (const m of msgs) if (m.task) byTask.set(m.task.taskId, m.task)
  return [...byTask.values()]
}

/** The "Working on it" strip's tasks from cards (a conversation's, or a chat's), with the live state. */
export function stripTasks(cards: readonly ForumTaskCard[], tasks: readonly LiveTaskWithId[], who: (agentId: string | null) => string | null, openRuns: ReadonlySet<string> = new Set(), runSince: (runId: string) => string | null = () => null): StripTask[] {
  return cards.map((card) => {
    const t = tasks.find((x) => x.id === card.taskId)
    const state = t ? taskCardState({ status: t.status, blockReason: t.blockReason ?? null, ask: t.ask ?? null, runId: t.runId }, { openAsk: !!t.runId && openRuns.has(t.runId) }) : card.state
    const runId = t?.runId ?? card.runId ?? null
    return { taskId: card.taskId, identifier: card.identifier, who: who(t?.agentId ?? card.agentId), state, startedAt: card.startedAt, since: state === 'working' && runId ? runSince(runId) : null }
  })
}

/** "runId=startedAt;…" for the runs of open cards: a primitive the strip can select without re-rendering on every agent change. */
export function runStartsKey(agents: Iterable<AgentNode>, runIds: ReadonlySet<string>): string {
  if (!runIds.size) return ''
  const best = new Map<string, AgentNode>()
  for (const a of agents) {
    if (!a.runId || a.parentId !== null || !runIds.has(a.runId)) continue
    const cur = best.get(a.runId)
    if (!cur || a.updatedAt > cur.updatedAt) best.set(a.runId, a)
  }
  return [...best].map(([r, a]) => `${r}=${a.startedAt}`).sort().join(';')
}
export function parseRunStarts(key: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const part of key ? key.split(';') : []) {
    const i = part.indexOf('=')
    if (i > 0) m.set(part.slice(0, i), part.slice(i + 1))
  }
  return m
}

type LiveTaskWithId = LiveTask & Pick<CompanyTask, 'id'> & Partial<Pick<CompanyTask, 'agentId'>>
