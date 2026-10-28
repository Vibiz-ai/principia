/**
 * CHAT-UI.md §8.4: a task at work reads as a chat, not a log. The thread is the task's brief as the first message, then
 * what the agent said (its messages and thoughts) as bubbles, the tool calls between them folded into one line each
 * ("Ran 6 commands · read 3 files · checked memory"), its questions, and your notes, in time order. Pure: no hive, no DOM.
 */
import type { AgentEvent } from '@shared/live'
import type { CompanyTask, TaskActivity } from '@shared/company'
import { connectorCall, plainActivity, serviceName } from './plainActivity'

export type ThreadItem =
  | { kind: 'brief'; key: string; at: string; text: string }
  /** something said: by the agent (a message, a thought, a report, a comment) or by you (a note, an answer) */
  | { kind: 'say'; key: string; at: string; by: 'agent' | 'you'; text: string; thought?: boolean; question?: boolean }
  /** consecutive tool calls, folded: the line says what they did together; the events open on click */
  | { kind: 'tools'; key: string; at: string; events: AgentEvent[]; label: string; running: boolean }
  /** a quiet line: started, paused, stopped */
  | { kind: 'note'; key: string; at: string; text: string }

type BriefTask = Pick<CompanyTask, 'id' | 'title' | 'description' | 'createdAt'>

const SHELL = /^(?:Bash|shell|exec_command|run_shell_command|BashOutput|KillShell)$/
const toolName = (e: Pick<AgentEvent, 'name' | 'summary'>): string => e.name ?? /^(\S+)/.exec(e.summary)?.[1] ?? ''

/**
 * What one tool call did, in words: its own description when it gave one (Claude's Bash `description`: "Run the unit
 * tests"), else the plain sentence for its tool line ("Reading taskCard.ts", "Loading tools"). Never the raw call.
 */
export function toolWords(e: Pick<AgentEvent, 'name' | 'summary' | 'description'>, code = true): string {
  const d = e.description?.trim()
  if (d) return d.length > 120 ? `${d.slice(0, 119)}…` : d
  return plainActivity(e.summary, { code }) ?? 'Working'
}

type Bucket = 'command' | 'read' | 'edit' | 'search' | 'web' | 'memory' | 'save' | 'task' | 'plan' | 'helper' | 'tools' | 'other'
/** One tool call's kind, for the folded line. */
export function toolBucket(e: Pick<AgentEvent, 'name' | 'summary'>): { bucket: Bucket; service?: string; task?: string } {
  const n = toolName(e)
  if (SHELL.test(n)) return { bucket: 'command' }
  if (/^(?:Read|NotebookRead)$/.test(n)) return { bucket: 'read' }
  if (/^(?:Edit|MultiEdit|Write|NotebookEdit)$/.test(n)) return { bucket: 'edit' }
  if (/^(?:Grep|Glob|LS)$/.test(n)) return { bucket: 'search' }
  if (/^(?:WebSearch|WebFetch)$/.test(n)) return { bucket: 'web' }
  if (n === 'ToolSearch') return { bucket: 'tools' }
  if (n === 'TodoWrite') return { bucket: 'plan' }
  if (n === 'Task' || n === 'Agent') return { bucket: 'helper' }
  const mem = /^\[memory\]\s+(\w+)/.exec(e.summary)
  if (mem) return { bucket: /^(?:write|link|invalidate|forget|taste)$/.test(mem[1]!) ? 'save' : 'memory' }
  const c = connectorCall(e.summary) ?? connectorCall(n)
  if (c) {
    const s = c.server.toLowerCase()
    if (s === 'hivemem' && /^task_/.test(c.tool)) return { bucket: 'task', task: c.tool }
    if (s === 'hivemem') return { bucket: /write|link|invalidate|forget|taste/.test(c.tool) ? 'save' : 'memory' }
    return { bucket: 'other', service: serviceName(c.server) }
  }
  return { bucket: 'other' }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const TASK_PAST: Record<string, string> = {
  task_get: 'read the task',
  task_list: 'looked at the board',
  task_comment: 'commented on the task',
  task_update: 'updated the task',
  task_create: 'filed a task',
  task_report: 'reported back',
  task_ask: 'asked you',
  task_handoff: 'handed it over',
  task_brief_edit: 'updated the brief',
  task_criterion: 'checked off the brief',
  task_attach_proof: 'attached proof',
  task_decide: 'recorded a decision'
}

/**
 * The folded line of a run of tool calls: "Ran 6 commands · read 3 files · checked memory". One call reads as itself
 * (its description, else its words). Loading tools is said only when it is all that happened. A company with no code
 * never reads "command" or "file" (C7).
 */
export function toolsLabel(events: readonly Pick<AgentEvent, 'name' | 'summary' | 'description'>[], code = true): string {
  if (!events.length) return ''
  if (events.length === 1) return toolWords(events[0]!, code)
  const n: Partial<Record<Bucket, number>> = {}
  const services: string[] = []
  const tasks: string[] = []
  for (const e of events) {
    const b = toolBucket(e)
    n[b.bucket] = (n[b.bucket] ?? 0) + 1
    if (b.service && !services.includes(b.service)) services.push(b.service)
    if (b.task && !tasks.includes(b.task)) tasks.push(b.task)
  }
  const parts: string[] = []
  if (n.command) parts.push(code ? `ran ${plural(n.command, 'command')}` : `worked through ${plural(n.command, 'step')}`)
  if (n.read) parts.push(code ? `read ${plural(n.read, 'file')}` : `read ${plural(n.read, 'note')}`)
  if (n.edit) parts.push(code ? `edited ${plural(n.edit, 'file')}` : `wrote ${plural(n.edit, 'note')}`)
  if (n.search) parts.push(code ? 'searched the files' : 'looked through its notes')
  if (n.web) parts.push('searched the web')
  if (n.memory) parts.push('checked memory')
  if (n.save) parts.push('saved to memory')
  for (const t of tasks) parts.push(TASK_PAST[t] ?? 'worked on the task')
  if (n.plan) parts.push('planned the next steps')
  if (n.helper) parts.push(`worked with ${n.helper === 1 ? 'a helper' : `${n.helper} helpers`}`)
  for (const s of services) parts.push(`used ${s}`)
  const unnamed = (n.other ?? 0) - events.filter((e) => toolBucket(e).service).length
  if (unnamed > 0) parts.push(`used ${plural(unnamed, 'tool')}`)
  if (!parts.length && n.tools) parts.push('loaded tools')
  const line = parts.join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** Agent text that is only a tool's echo or empty. */
const said = (e: AgentEvent): string => (e.detail ?? e.summary ?? '').trim()

/**
 * The task's thread (see the module doc). `events` are the run's root agent's, `activity` the task's (tasks:get), both
 * any order; the result is in time order with consecutive tool calls folded into one item.
 */
export function taskThread(input: { task: BriefTask; activity?: readonly TaskActivity[]; events?: readonly AgentEvent[]; agentName?: string; code?: boolean }): ThreadItem[] {
  const code = input.code ?? true
  const who = input.agentName ?? 'The agent'
  const flat: (ThreadItem | { kind: 'tool'; key: string; at: string; e: AgentEvent })[] = []
  const brief = [input.task.title, input.task.description?.trim()].filter(Boolean).join('\n\n')
  flat.push({ kind: 'brief', key: `brief:${input.task.id}`, at: input.task.createdAt, text: brief })
  for (const a of input.activity ?? []) {
    const msg = a.message?.trim()
    if (!msg) continue
    const key = `act:${a.id}`
    if (a.kind === 'comment') flat.push({ kind: 'say', key, at: a.createdAt, by: a.by === 'human' ? 'you' : 'agent', text: msg })
    else if (a.kind === 'report') flat.push({ kind: 'say', key, at: a.createdAt, by: 'agent', text: msg })
    else if (a.kind === 'asked') flat.push({ kind: 'say', key, at: a.createdAt, by: 'agent', text: msg, question: true })
    else if (a.kind === 'answered') flat.push({ kind: 'say', key, at: a.createdAt, by: a.by === 'agent' ? 'agent' : 'you', text: msg })
    else if (a.kind === 'started') flat.push({ kind: 'note', key, at: a.createdAt, text: `${who} started` })
    else if (a.kind === 'paused' || a.kind === 'interrupted' || a.kind === 'run_finished') flat.push({ kind: 'note', key, at: a.createdAt, text: msg.replace(/\brun_[A-Za-z0-9_-]+\b/g, 'the run') })
  }
  for (const e of input.events ?? []) {
    const key = `ev:${e.seq}`
    if (e.kind === 'tool') flat.push({ kind: 'tool', key, at: e.ts, e })
    else if (e.kind === 'text' && said(e)) flat.push({ kind: 'say', key, at: e.ts, by: 'agent', text: said(e) })
    else if (e.kind === 'thinking' && said(e)) flat.push({ kind: 'say', key, at: e.ts, by: 'agent', text: said(e), thought: true })
    else if (e.kind === 'error' && e.summary.trim()) flat.push({ kind: 'note', key, at: e.ts, text: e.summary.trim() })
  }
  // stable by time; ties keep the order above (the brief first, activity before the run's events)
  const order = flat.map((x, i) => ({ x, i })).sort((a, b) => (a.x.at < b.x.at ? -1 : a.x.at > b.x.at ? 1 : a.i - b.i))
  const out: ThreadItem[] = []
  for (const { x } of order) {
    if (x.kind !== 'tool') {
      out.push(x)
      continue
    }
    const last = out[out.length - 1]
    if (last?.kind === 'tools') last.events.push(x.e)
    else out.push({ kind: 'tools', key: x.key, at: x.at, events: [x.e], label: '', running: false })
  }
  for (const it of out)
    if (it.kind === 'tools') {
      it.label = toolsLabel(it.events, code)
      it.running = it.events.some((e) => e.state === 'running')
    }
  return out
}

/**
 * The line under the task chat's composer: what sending does now. A note is a task comment (tasks:comment): it is in the
 * task's activity at once, and the dispatcher queues it as the task's wake, the same inbox a teammate's question uses
 * (coalesced while the run works, so the agent picks it up the moment this turn ends). With an open question, Send
 * answers it (tasks:answer) and the task goes on.
 */
export function noteHint(name: string, state: 'working' | 'queued' | 'needs_you' | 'in_review' | 'done' | 'failed', opts: { answers?: boolean } = {}): string {
  if (opts.answers) return `→ Answers ${name}’s question, and the task goes on`
  if (state === 'working') return `→ ${name} gets it as soon as this turn ends, and goes on from there`
  if (state === 'queued') return `→ ${name} reads it when the task starts`
  if (state === 'done') return '→ Added to the task’s notes (it is done, so nobody is woken)'
  return `→ ${name} reads it on the next turn of this task`
}
