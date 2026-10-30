/**
 * CHAT-UI.md §8: the live task card. When a task is filed from (or for) a conversation, the conversation does not get
 * a grey "Julia made VO-9 from this message." line any more: it gets a card that says what is being done, by whom,
 * where it stands now, and what came back. The card is one Forum message (kind 'system' with a `task` payload) that
 * main patches in place; the desktop reads the live task, run and agent on top of it.
 *
 * Pure: shared by main (the stored state, the phone), the renderer and the phone web app.
 */
import { AGENT_MAX_PARALLEL, DEFAULT_MAX_IN_FLIGHT, agentFullLine } from './company'

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
  /** the board ask the filer already put to the person in this conversation (taskAskKey): one question message per ask */
  askKey?: string | null
  /** that question: the filer's message in the conversation (the strip and the card's Answer point at it) */
  askMessageId?: string | null
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

/** A ticking clock: "12s", "1m 12s", "1h 5m" (the working line counts seconds while it runs). */
export function clockLabel(fromIso: string, toIso: string | null | undefined = null, now: number = Date.now()): string {
  const from = Date.parse(fromIso)
  const to = toIso ? Date.parse(toIso) : now
  if (!Number.isFinite(from) || !Number.isFinite(to)) return ''
  const s = Math.max(0, Math.floor((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** What a queued card needs to say why it waits: the gates the dispatcher checks (DEPARTMENTS.md §3). */
export interface QueueInput {
  task: { status: string; identifier?: string; blockReason?: string | null; agentId?: string | null; assigneeProfileId?: string | null; ask?: { answer?: string | null } | null }
  /** the seat on it (null: nobody, or its row is gone) */
  agent: { name: string; archivedAt?: string | null; pausedAt?: string | null; data?: { autonomy?: string; mode?: string } } | null
  company: { name: string; autopilot?: boolean; pausedAt?: string | null; maxInFlight?: number } | null
  /** identifiers of its dependencies that are not done yet */
  depsOpen?: readonly string[]
  /** the company's tasks in flight right now (in progress with a run) */
  inFlight?: number
  /** how many other tasks its agent is running right now (an agent works on up to AGENT_MAX_PARALLEL at once) */
  agentRunning?: number
  /** work the founder already said go to starts with autopilot off too (startsWithoutAutopilot) */
  startsAnyway?: boolean
  /** "Run now" for a company with code, "Start" without */
  runLabel?: string
}
export interface QueueReason {
  /** one line: why it waits ("Autopilot is off in Vibiz: it waits for you to press Run now") */
  text: string
  /** Run now can start it from the card: an agent, nothing it waits on, no question open */
  canRun: boolean
}

const listIds = (ids: readonly string[]): string => (ids.length <= 2 ? ids.join(' and ') : `${ids.slice(0, 2).join(', ')} and ${ids.length - 2} more`)

/** Why a queued task has not started, in words, and whether Run now can start it from the card (CHAT-UI.md §8). */
export function queuedReason(i: QueueInput): QueueReason {
  const t = i.task
  const run = i.runLabel ?? 'Run now'
  const who = i.agent?.name ?? 'Its agent'
  const deps = i.depsOpen ?? []
  const company = i.company
  if (!t.agentId && !t.assigneeProfileId) return { text: t.status === 'triage' ? 'Waiting to be routed to an agent' : 'Nobody is on it yet: assign an agent', canRun: false }
  if (company?.pausedAt) return { text: `${company.name} is paused: nothing starts until you resume it`, canRun: false }
  if (i.agent && (i.agent.archivedAt || i.agent.pausedAt)) return { text: `${i.agent.name} is ${i.agent.archivedAt ? 'archived' : 'paused'}`, canRun: false }
  if ((t.status === 'blocked' && t.blockReason === 'deps') || deps.length) return { text: deps.length ? `Waiting for ${listIds(deps)} to finish` : 'Waiting for its dependencies to finish', canRun: false }
  if (t.ask && !t.ask.answer) return { text: 'Waiting for your answer', canRun: false }
  if (t.status === 'backlog') return { text: `In the backlog: it starts when it moves to To do, or with ${run}`, canRun: true }
  if (t.status === 'triage') return { text: `In triage: it starts once it is routed, or with ${run}`, canRun: true }
  if (i.agent?.data?.mode === 'session') return { text: `${who} works in a session: it starts when you press ${run}`, canRun: true }
  if (!company?.autopilot && !i.startsAnyway) return { text: `Autopilot is off${company ? ` in ${company.name}` : ''}: it waits for you to press ${run}`, canRun: true }
  if (i.agent?.data?.autonomy && i.agent.data.autonomy !== 'auto' && !i.startsAnyway) return { text: `${who} starts only when you say so: press ${run}`, canRun: true }
  const max = typeof company?.maxInFlight === 'number' && company.maxInFlight >= 1 ? company.maxInFlight : DEFAULT_MAX_IN_FLIGHT
  const inFlight = i.inFlight ?? 0
  if (inFlight >= max) return { text: `${inFlight} tasks are already running${company ? ` in ${company.name}` : ''} (at most ${max} at once)`, canRun: true }
  const mine = i.agentRunning ?? 0
  if (mine >= AGENT_MAX_PARALLEL) return { text: agentFullLine(who, mine, t.identifier ?? 'this task'), canRun: true }
  return { text: 'Starting in a moment', canRun: true }
}

/** One open task for the strip. */
export interface StripTask {
  taskId: string
  identifier: string
  /** who is on it (display name); null = nobody yet */
  who: string | null
  state: TaskCardState
  startedAt: string
  /** when its run started working (the run's root agent): a working task's clock counts from here */
  since?: string | null
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
    // the same clock as the card: a working task counts from its run's start, a queued one from when it was filed
    const age = elapsedLabel(t.state === 'working' && t.since ? t.since : t.startedAt, null, now)
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
  const queued = tasks.filter((t) => t.state === 'queued').length
  const needLine = needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : ''
  // "running" only when nothing waits for its turn: a queued task is not running yet
  if (!queued) return { line: `${tasks.length} tasks running${needLine}`, tasks, focus }
  const working = tasks.length - queued - needs
  return { line: `${tasks.length} tasks${working ? ` · ${working} working` : ''} · ${queued} queued${needLine}`, tasks, focus }
}

/** The card's text line (what an older client, a search hit or a notification shows). */
export function taskCardLine(byName: string, identifier: string, title: string): string {
  return `${byName} started ${identifier}: ${title}`
}

/** The line a task's result comes back as (in a conversation, or a chat's notice). */
export function taskResultLine(c: { identifier: string; state: TaskCardState; result?: string | null; prUrl?: string | null }, canceled = false): string {
  const res = c.result ? `: ${c.result}` : '.'
  const head =
    c.state === 'failed'
      ? `${c.identifier} ${canceled ? 'was canceled' : 'stopped before it was finished'}${res}`
      : c.state === 'in_review'
        ? `${c.identifier} is ready for your review${res}`
        : `${c.identifier} is done${res}`
  return `${head}${c.prUrl ? `\nPull request: ${c.prUrl}` : ''}`
}

// ---------- the task's question, said by the agent in the conversation ----------

/** The task waits for the person's answer to its board ask (tasks:answer, or the Forum's answer path, resumes it). */
export function waitsForAnswer(t: { status: string; ask?: { prompt?: string; answer?: string | null } | null }): boolean {
  return !!t.ask?.prompt && !t.ask.answer && t.status !== 'done' && t.status !== 'canceled' && t.status !== 'in_review'
}

/** One ask of one run: the same prompt asked again on another run is a new question. FNV-1a, 8 hex chars. */
export function taskAskKey(taskId: string, runId: string | null | undefined, prompt: string): string {
  let h = 0x811c9dc5
  const s = `${taskId}\u0000${runId ?? ''}\u0000${prompt.trim()}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Principia's blocker prefixes (orchestrator/apply.ts blockerLine), said in the agent's own voice. */
const FIRST_PERSON: [RegExp, string][] = [
  [/^Needs your decision:\s*/i, 'I need your decision: '],
  [/^Needs access:\s*/i, 'I need access: '],
  [/^Needs money \(nothing is spent without your yes\):\s*/i, 'I need money for this (nothing is spent without your yes): '],
  [/^Needs a connection:\s*/i, 'I need a connection: '],
  [/^Principia:\s*/i, '']
]
const firstPerson = (line: string): string => FIRST_PERSON.reduce((l, [re, to]) => l.replace(re, to), line.trim())

/**
 * The agent's message when a task it filed from this conversation stops for the person (CHAT-UI.md §8): the whole
 * question in plain words, what it found so far, the options, and where to answer. Connect links stay in the text
 * (`principia://connect/<tool>`): the conversation draws them as Connect buttons.
 */
export function taskAskSay(i: { identifier: string; prompt: string; options?: readonly string[] | null; summary?: string | null; where?: string }): string {
  const lines = i.prompt.split('\n').map(firstPerson).filter(Boolean)
  const summary = i.summary?.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const out = [`${i.identifier} is stuck and needs you.`]
  if (summary && !lines.some((l) => l.includes(summary) || summary.includes(l))) out.push(`So far: ${summary.length > 300 ? `${summary.slice(0, 299)}…` : summary}`)
  if (lines.length === 1) out.push(lines[0]!)
  else out.push(...lines.map((l) => `- ${l}`))
  const opts = (i.options ?? []).map((o) => o.trim()).filter(Boolean)
  if (opts.length) out.push(`Options: ${opts.length === 1 ? opts[0] : `${opts.slice(0, -1).join(', ')} or ${opts[opts.length - 1]}`}.`)
  out.push(i.where ?? `Reply here and I'll pass it on to ${i.identifier}.`)
  return out.join('\n')
}

/**
 * What the agent says once the answer went back to the task. "Back on VO-15" only when the task really resumed (`go`
 * absent, or its run started / was already running); otherwise the true state ("Got it. Julia is running 3 tasks; VO-15
 * starts when one finishes.").
 */
export function taskAskAck(identifier: string, elsewhere = false, go?: { state: string; line: string } | null): string {
  if (go && go.state !== 'started' && go.state !== 'running') return `${elsewhere ? 'Got your answer.' : 'Got it.'} ${go.line}`
  return elsewhere ? `Got your answer. Back on ${identifier}.` : `Got it, back on ${identifier}.`
}

/** A message that starts something new, not an answer: "also…", "btw", "another thing", "new task". */
const NEW_TOPIC = /^\s*(also|btw|by the way|another thing|one more thing|unrelated|separately|new task|different question|can you also|and also|forget (that|it)|never ?mind|stop|cancel)\b/i
/** A question about how the work is going, never an answer to the task's question ("are u working on it? or what?"). */
const STATUS_QUESTION = /\b(are (yo)?u (still )?(working|on it|doing it|there)|is it (done|working|running|ready)|did (yo)?u (start|finish)|(any|an) update|what'?s (the )?(status|happening|going on)|how'?s it going|how is it going|where are (yo)?u at|still (waiting|working)|eta)\b|\b(status|progress|or what)\s*\?*\s*$/i

/** The person said one of the ask's options back ("both." for Both). */
export function matchesOption(text: string, options?: readonly string[] | null): boolean {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '')
  return !!t && !!options?.some((o) => o.trim().toLowerCase() === t)
}

/** A plain yes from the person ("go ahead", "do it", "sounds good", "just hire it"), with no "no", "wait" or "don't" in it. */
const GO = /\b(go ahead|go for it|do it|just do|yes|yeah|yep|yup|sure|ok(ay)?|sounds good|approved?|ship it|hire (it|them|him|her)|just hire|let'?s do it|proceed|green light|lgtm)\b/i
const HOLD = /\b(no|nope|not yet|don'?t|do not|wait|hold (on|off)|stop|cancel|never ?mind|later)\b/i
export function saysGoAhead(text: string): boolean {
  const t = text.trim()
  return !!t && GO.test(t) && !HOLD.test(t)
}

/** Surely not an answer: it starts something new, or asks how the work is going. Anything else may be one. */
export function notAnAnswer(text: string): boolean {
  const t = text.trim()
  return !t || NEW_TOPIC.test(t) || STATUS_QUESTION.test(t)
}

/** How a task in a conversation stands right now, for the agent asked about it (CHAT-UI.md §8: status questions). */
export interface TaskStatusInput {
  identifier: string
  title?: string | null
  status: string
  blockReason?: string | null
  ask?: { prompt?: string | null; answer?: string | null } | null
  /** who is on it */
  who?: string | null
  /** when its current run started (working), else when it last moved */
  since?: string | null
  /** its newest activity line */
  latest?: { at: string; text: string } | null
  /** why a queued task has not started (queuedReason) */
  waiting?: string | null
}

const cut = (s: string, n: number): string => {
  const f = s.replace(/\s+/g, ' ').trim()
  return f.length > n ? `${f.slice(0, n - 1)}…` : f
}

/** One line: "VO-16 “Landing page”: working now (Julia), for 12m; latest: Opened a PR (2m ago)". */
export function taskStatusLine(t: TaskStatusInput, now: number = Date.now()): string {
  const state = taskCardState(t)
  const head = `${t.identifier}${t.title ? ` “${cut(t.title, 80)}”` : ''}`
  const ago = (iso: string) => elapsedLabel(iso, null, now)
  let body: string
  if (state === 'working') body = `working now${t.who ? ` (${t.who})` : ''}${t.since ? `, for ${ago(t.since)}` : ''}`
  else if (state === 'needs_you') body = t.ask?.prompt && !t.ask.answer ? `waiting for the person's answer: “${cut(t.ask.prompt, 200)}”` : `blocked (${t.blockReason ?? 'needs the person'})`
  else if (state === 'queued') body = `not started yet: ${t.waiting ? cut(t.waiting, 160) : 'waiting for its turn'}`
  else if (state === 'in_review') body = 'finished, waiting for the person to review it'
  else if (state === 'done') body = 'done'
  else body = `stopped${t.blockReason ? ` (${t.blockReason})` : t.status === 'canceled' ? ' (canceled)' : ''}`
  const latest = t.latest?.text ? `; latest: ${cut(t.latest.text, 160)} (${ago(t.latest.at)} ago)` : ''
  return `${head}: ${body}${latest}`
}

/** Lowercase words only: "Lift UGC conversion!" → "lift ugc conversion". */
export const normTaskTitle = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** The same request, said twice: equal titles, or one long enough title inside the other. */
export function sameRequest(a: string, b: string): boolean {
  const x = normTaskTitle(a)
  const y = normTaskTitle(b)
  if (!x || !y) return false
  return x === y || (x.length >= 12 && y.includes(x)) || (y.length >= 12 && x.includes(y))
}

// ---------- tasks filed from a chat session (company_file_task, task_create) ----------

/** The board tools a chat files a task with (`mcp__hive__company_file_task`, bare or prefixed). */
const CHAT_TASK_TOOL = /(?:^|__|\.)(company_file_task|task_create)$/
interface ToolLike { name: string; status: string; resultText: string; startedAt: number | null }

/** The task a chat's company_file_task / task_create call filed, as a card; null for any other call or a repeat. */
export function chatTaskCard(item: ToolLike): ForumTaskCard | null {
  if (!CHAT_TASK_TOOL.test(item.name) || item.status !== 'ok' || !item.resultText) return null
  const r = parseToolJson(item.resultText)
  const t = r?.task as { id?: unknown; identifier?: unknown; title?: unknown; status?: unknown; agent?: { id?: unknown } | null } | undefined
  if (!r || r.ok !== true || !t || typeof t.id !== 'string' || typeof t.identifier !== 'string') return null
  // a repeat (already filed, a replayed call) points at the first card instead of drawing a second
  if (r.already || r.replayed) return null
  return {
    taskId: t.id,
    identifier: t.identifier,
    title: typeof t.title === 'string' ? t.title : t.identifier,
    agentId: t.agent && typeof t.agent.id === 'string' ? t.agent.id : null,
    filedBy: null,
    state: taskCardState({ status: typeof t.status === 'string' ? t.status : 'todo' }),
    runId: null,
    startedAt: new Date(item.startedAt ?? Date.now()).toISOString()
  }
}
/** Every task a chat filed, once each, in order. */
export function chatTaskCards(items: readonly { kind: string }[]): ForumTaskCard[] {
  const out: ForumTaskCard[] = []
  for (const it of items) {
    if (it.kind !== 'tool') continue
    const c = chatTaskCard(it as unknown as ToolLike)
    if (c && !out.some((x) => x.taskId === c.taskId)) out.push(c)
  }
  return out
}
function parseToolJson(text: string): Record<string, unknown> | null {
  const tries = [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const s of tries) {
    try {
      const v = JSON.parse(s) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
      // MCP content array: [{ type: 'text', text: '{…}' }]
      if (Array.isArray(v)) for (const c of v) if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') return parseToolJson((c as { text: string }).text)
    } catch {
      /* next */
    }
  }
  return null
}
