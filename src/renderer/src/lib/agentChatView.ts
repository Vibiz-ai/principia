/**
 * AGENT CHAT (part 2, the Grok-style conversation): the pure view models behind the chat's reading aids and the
 * agent's right panel. No React, no IPC: the components pass what they hold and draw what comes back.
 * - stampsFor / stampLabel: a quiet time line before a message that starts a new stretch of the conversation;
 * - countMessages: what the "N new messages" pill counts (finished answers and your own messages, not tool lines);
 * - computerView: the Computer tab (its helper agents and its recent tool activity, in the chat's own words);
 * - agentRoutines / routineLine: the agent's routines with their time in plain words;
 * - libraryOf: what the agent produced (files, notes, finished tasks), newest first;
 * - sessionUnread: an agent's chat finished a turn you have not looked at yet (the list's dot).
 */
import type { ChatItem, ChatToolItem } from '@shared/chat'
import type { ChatBlock } from '@shared/chatView'
import type { CompanyTask } from '@shared/company'
import type { AgentNode } from '@shared/live'
import type { Artifact, Id, Schedule } from '@shared/types'
import { isSubagentTool, toolLine, type ToolIcon } from '@shared/toolVerbs'

// ---------- time stamps between groups ----------

/** A new stretch starts after this much quiet (Grok/iMessage style). */
export const STAMP_GAP_MS = 15 * 60_000

/** The key a block renders with (ChatCards' Blocks uses the same ids). */
export function blockKey(b: ChatBlock): string {
  return b.t === 'group' ? b.id : b.item.id
}

/**
 * Which blocks get a time line above them: the first message you sent, then any of your messages that comes after
 * `gap` of quiet or on another day. Keyed by blockKey, valued by its ms time.
 */
export function stampsFor(blocks: readonly ChatBlock[], gap = STAMP_GAP_MS): Map<string, number> {
  const out = new Map<string, number>()
  let prev: number | null = null
  for (const b of blocks) {
    if (b.t !== 'item' || b.item.kind !== 'user') continue
    const at = b.item.at
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    if (prev === null || at - prev >= gap || new Date(at).toDateString() !== new Date(prev).toDateString()) out.set(b.item.id, at)
    prev = at
  }
  return out
}

/** "Today 14:32", "Yesterday 09:05", "Mon 3 Nov 14:32" (and the year when it is not this one). */
export function stampLabel(at: number, now = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(n) - day(d)) / 86_400_000)
  if (diff === 0) return `Today ${time}`
  if (diff === 1) return `Yesterday ${time}`
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) })
  return `${date} ${time}`
}

// ---------- the "N new messages" pill ----------

/** Messages a reader counts: your own and each finished answer (tool lines, thinking and notices are activity). */
export function countMessages(items: readonly ChatItem[]): number {
  let n = 0
  for (const i of items) {
    if (i.parent) continue
    if (i.kind === 'user') n++
    else if (i.kind === 'text' && !i.streaming && i.md.trim()) n++
  }
  return n
}

/** The pill's words: "3 new messages", "1 new message", or "New activity" when only tools moved. */
export function newPillLabel(n: number): string {
  return n <= 0 ? 'New activity' : `${n} new message${n === 1 ? '' : 's'}`
}

// ---------- the Computer tab ----------

export interface ComputerLine {
  id: string
  verb: string
  target: string
  icon: ToolIcon
  status: ChatToolItem['status']
  at: number | null
}
export interface ComputerView {
  /** helper agents (subagents) it started, running first */
  helpers: (ComputerLine & { running: boolean; steps: number })[]
  /** its last tool lines, newest first (helpers' own steps included, marked) */
  recent: (ComputerLine & { inHelper: boolean })[]
}

export function computerView(items: readonly ChatItem[], max = 8): ComputerView {
  const tools = items.filter((i): i is ChatToolItem => i.kind === 'tool' && i.name !== 'TodoWrite')
  const helperIds = new Set(tools.filter((t) => isSubagentTool(t.name)).map((t) => t.toolUseId))
  const line = (t: ChatToolItem): ComputerLine => {
    const l = toolLine(t)
    return { id: t.id, verb: l.verb, target: l.target, icon: l.icon, status: t.status, at: t.startedAt }
  }
  const helpers = tools
    .filter((t) => isSubagentTool(t.name))
    .map((t) => ({ ...line(t), running: t.status === 'pending' || t.status === 'running', steps: items.filter((i) => i.parent === t.toolUseId && i.kind === 'tool').length }))
    .reverse()
    .sort((a, b) => Number(b.running) - Number(a.running))
  const recent = tools
    .filter((t) => !isSubagentTool(t.name))
    .slice(-max)
    .reverse()
    .map((t) => ({ ...line(t), inHelper: !!t.parent && helperIds.has(t.parent) }))
  return { helpers, recent }
}

// ---------- routines ----------

/** The agent's routines: schedules aimed at it (a recurring task for it), in its company. */
export function agentRoutines(schedules: readonly Schedule[], agent: { id: Id; companyId: Id }): Schedule[] {
  return schedules.filter((s) => s.target?.agentId === agent.id && (!s.companyId || s.companyId === agent.companyId)).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

/** "Every weekday at 9:00", without the time zone in brackets; a one-off says when. */
export function routineLine(s: Pick<Schedule, 'sentence' | 'enabled' | 'nextFireAt'>): string {
  const plain = (s.sentence || '').replace(/\s*\([^)]*\/[^)]*\)\s*$/, '').trim() || 'On a schedule'
  return s.enabled ? plain : `${plain} · off`
}

// ---------- the Library tab ----------

export interface LibraryItem {
  key: string
  kind: 'draft' | 'file' | 'note' | 'task'
  title: string
  detail: string | null
  at: string
  /** the artifact / fact / task id it opens */
  id: Id
}

/**
 * What the agent produced: drafts waiting for your OK first, then, newest first, files from its task runs and its chat,
 * Knowledge notes it wrote there, and the tasks it finished.
 */
export function libraryOf(o: {
  agentId: Id
  tasks: readonly CompanyTask[]
  artifacts: readonly Artifact[]
  notes: readonly { id: Id; text: string; entityName: string; createdAt: string; provenance: { runId: Id | null; sessionId?: Id | null } | null }[]
  sessionIds: readonly Id[]
}): LibraryItem[] {
  const mine = o.tasks.filter((t) => t.agentId === o.agentId)
  const runs = new Set(mine.map((t) => t.runId).filter((x): x is Id => !!x))
  const sessions = new Set(o.sessionIds)
  const ofAgent = (runId: Id | null | undefined, sessionId: Id | null | undefined): boolean => (!!runId && (runs.has(runId) || sessions.has(runId))) || (!!sessionId && sessions.has(sessionId))
  const out: LibraryItem[] = []
  for (const a of o.artifacts) if (ofAgent(a.runId, a.sessionId)) out.push({ key: `file:${a.id}`, kind: 'file', title: a.name, detail: a.kind, at: a.mtime || a.createdAt, id: a.id })
  for (const n of o.notes) if (n.provenance && ofAgent(n.provenance.runId, n.provenance.sessionId)) out.push({ key: `note:${n.id}`, kind: 'note', title: n.text.length > 140 ? `${n.text.slice(0, 139)}…` : n.text, detail: n.entityName, at: n.createdAt, id: n.id })
  for (const t of mine) if (t.status === 'done') out.push({ key: `task:${t.id}`, kind: 'task', title: t.title, detail: t.report?.summary ? t.report.summary.split('\n')[0]!.slice(0, 140) : null, at: t.updatedAt, id: t.id })
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const drafts: LibraryItem[] = mine.filter((t) => t.status === 'in_review').map((t) => ({ key: `draft:${t.id}`, kind: 'draft', title: t.title, detail: 'Waiting for your OK', at: t.updatedAt, id: t.id }))
  return [...drafts, ...out]
}

// ---------- the conversation list ----------

/** Where Chats remembers the last conversation open in a company (a per-Mac convenience; 'all' = All companies). */
export const lastChatKey = (scope: Id | null | undefined): string => `hive.chats.last.${scope ?? 'all'}`

/** The agent's chat finished a turn and waits for you, and you have not looked at it yet: the list's dot. */
export function sessionUnread(node: Pick<AgentNode, 'status' | 'needs'> | undefined, seen: boolean): boolean {
  return !!node && node.status === 'needs_you' && node.needs === 'idle' && !seen
}
