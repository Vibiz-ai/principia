/**
 * Pure helpers for live agents (LIVE.md §1, §6, §7, §8, §11): the agent tree, hub grouping, Needs-you counting with
 * the A3 "seen" rule, next-needs-you order, labels, memory chip text and dashboard chart math. No DOM, no IPC.
 */
import type { AgentEvent, AgentNode, AgentStatus, Ask, AskOption } from '@shared/live'
import type { Id, Run } from '@shared/types'
import type { VisualStatus } from './graph'
import { promptTitle } from './format'

export const LIVE_STATUSES: readonly AgentStatus[] = ['starting', 'working', 'needs_you', 'idle']
const TERMINAL: readonly AgentStatus[] = ['done', 'failed', 'canceled']
const DAY = 24 * 60 * 60_000

export function isLive(a: Pick<AgentNode, 'status'>): boolean {
  return LIVE_STATUSES.includes(a.status)
}
export function isTerminal(s: AgentStatus): boolean {
  return TERMINAL.includes(s)
}

export type AgentVisual = VisualStatus | 'needs'
/** Canvas/list glyph status. Needs you is the accent everywhere (five doors A2). */
export function agentVisual(a: Pick<AgentNode, 'status' | 'needs'>, seen = false): AgentVisual {
  switch (a.status) {
    case 'starting':
      return 'queued'
    case 'working':
      return 'running'
    case 'needs_you':
      return a.needs === 'idle' && seen ? 'idle' : 'needs'
    case 'idle':
      return 'idle'
    case 'done':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
  }
}

// ---------- merge (events can arrive out of order; terminal statuses are final) ----------
export function mergeAgent(prev: AgentNode | undefined, next: AgentNode): AgentNode {
  if (!prev) return next
  if (isTerminal(prev.status) && !isTerminal(next.status)) return prev
  // the renderer ends a run's agents itself at the run's end (A2); main's own final row (cost, report) still wins
  if (isTerminal(prev.status) && isTerminal(next.status)) return next
  if (next.updatedAt < prev.updatedAt && !(isTerminal(next.status) && !isTerminal(prev.status))) return prev
  return next
}
export function mergeAsk(prev: Ask | undefined, next: Ask): Ask {
  if (!prev) return next
  if (prev.status !== 'open' && next.status === 'open') return prev
  return next
}
/** Merge event pages/updates by seq (an update for a running tool reuses its seq). Oldest first, capped. */
export function mergeEvents(list: AgentEvent[], incoming: AgentEvent[], cap = 500): AgentEvent[] {
  if (!incoming.length) return list
  const by = new Map<number, AgentEvent>()
  for (const e of list) by.set(e.seq, e)
  for (const e of incoming) by.set(e.seq, e)
  const out = [...by.values()].sort((a, b) => a.seq - b.seq)
  return out.length > cap ? out.slice(out.length - cap) : out
}

// ---------- tree ----------
export interface AgentIndex {
  byId: Map<Id, AgentNode>
  children: Map<Id, AgentNode[]>
  roots: AgentNode[]
}
export function indexAgents(agents: Iterable<AgentNode>): AgentIndex {
  const byId = new Map<Id, AgentNode>()
  for (const a of agents) byId.set(a.id, a)
  const children = new Map<Id, AgentNode[]>()
  const roots: AgentNode[] = []
  for (const a of byId.values()) {
    if (a.kind !== 'subagent' || !a.parentId) {
      roots.push(a)
      continue
    }
    const l = children.get(a.parentId)
    if (l) l.push(a)
    else children.set(a.parentId, [a])
  }
  for (const l of children.values()) l.sort((x, y) => (x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : 0))
  return { byId, children, roots }
}
/** Depth-first descendants (not including the agent itself), with their depth below it. */
export function descendants(idx: AgentIndex, id: Id): { agent: AgentNode; depth: number }[] {
  const out: { agent: AgentNode; depth: number }[] = []
  const walk = (pid: Id, d: number): void => {
    for (const c of idx.children.get(pid) ?? []) {
      out.push({ agent: c, depth: d })
      if (out.length < 400) walk(c.id, d + 1)
    }
  }
  walk(id, 1)
  return out
}
export function rootOf(idx: AgentIndex, a: AgentNode): AgentNode {
  return idx.byId.get(a.rootId) ?? a
}
export function subagentCount(idx: AgentIndex, rootId: Id): number {
  return descendants(idx, rootId).length
}
export function liveSubagentCount(idx: AgentIndex, rootId: Id): number {
  return descendants(idx, rootId).filter((d) => isLive(d.agent)).length
}
/** Sum of memory reads over an agent and its descendants (LIVE.md §7 "Read"). */
export function treeMemReads(idx: AgentIndex, id: Id): number {
  const self = idx.byId.get(id)?.memReads ?? 0
  return descendants(idx, id).reduce((n, d) => n + d.agent.memReads, self)
}

// ---------- asks ----------
export function openAsks(asks: Iterable<Ask>): Ask[] {
  return [...asks].filter((a) => a.status === 'open').sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}
export function asksByRoot(asks: Ask[]): Map<Id, Ask[]> {
  const m = new Map<Id, Ask[]>()
  for (const a of asks) {
    const l = m.get(a.rootId)
    if (l) l.push(a)
    else m.set(a.rootId, [a])
  }
  return m
}
export function asksByAgent(asks: Ask[]): Map<Id, Ask[]> {
  const m = new Map<Id, Ask[]>()
  for (const a of asks) {
    const l = m.get(a.agentId)
    if (l) l.push(a)
    else m.set(a.agentId, [a])
  }
  return m
}
export function optionOf(ask: Ask, kind: AskOption['kind']): AskOption | undefined {
  return ask.options.find((o) => o.kind === kind)
}

// ---------- A3: idle counts only while unseen ----------
export function isIdleWaiting(a: Pick<AgentNode, 'kind' | 'status' | 'needs'>): boolean {
  return a.kind === 'session' && a.status === 'needs_you' && a.needs === 'idle'
}
export function isSeen(a: Pick<AgentNode, 'id' | 'seen'>, seen: ReadonlySet<Id>): boolean {
  return a.seen === true || seen.has(a.id)
}
export function isUnseenIdle(a: AgentNode, seen: ReadonlySet<Id>): boolean {
  return isIdleWaiting(a) && !isSeen(a, seen)
}

/** Badge/tray number: open asks + unseen idle session roots (LIVE.md §4.5, A3). */
export function needsYouCount(agents: Iterable<AgentNode>, asks: Ask[], seen: ReadonlySet<Id>): number {
  let n = asks.filter((a) => a.status === 'open').length
  for (const a of agents) if (a.kind !== 'subagent' && isUnseenIdle(a, seen)) n++
  return n
}

/** Sessions and runs that need you right now (open asks + unseen idle session roots): sidebar rows, Canvas badge. */
export function needsOwners(agents: Iterable<AgentNode>, asks: Ask[], seen: ReadonlySet<Id>): { sessions: Set<Id>; runs: Set<Id> } {
  const sessions = new Set<Id>()
  const runs = new Set<Id>()
  for (const a of asks) {
    if (a.status !== 'open') continue
    if (a.sessionId) sessions.add(a.sessionId)
    if (a.runId) runs.add(a.runId)
  }
  for (const a of agents) if (a.kind === 'session' && a.sessionId && isUnseenIdle(a, seen)) sessions.add(a.sessionId)
  return { sessions, runs }
}

/** ⌘J: the oldest open ask anywhere, else the session that has waited longest for its turn. */
export function nextNeedsYou(agents: Iterable<AgentNode>, asks: Ask[], seen: ReadonlySet<Id>): { agentId: Id; askId: Id | null } | null {
  const open = openAsks(asks)
  if (open[0]) return { agentId: open[0].agentId, askId: open[0].id }
  let best: AgentNode | null = null
  for (const a of agents) if (a.kind !== 'subagent' && isUnseenIdle(a, seen) && (!best || a.updatedAt < best.updatedAt)) best = a
  return best ? { agentId: best.id, askId: null } : null
}

// ---------- hub groups (LIVE.md §6) ----------
export interface HubGroups {
  needs: { root: AgentNode; asks: Ask[] }[]
  working: AgentNode[]
  /** Live sessions that are idle or whose idle turn was seen: dimmed, each keeps its Reply box. */
  open: AgentNode[]
  done: AgentNode[]
}
const NEEDS_RANK: Record<string, number> = { permission: 0, question: 0, trust: 1, idle: 2 }

export function hubGroups(agents: Iterable<AgentNode>, asks: Ask[], seen: ReadonlySet<Id>, opts: { repoId?: Id | null; now?: number } = {}): HubGroups {
  const now = opts.now ?? Date.now()
  const byRoot = asksByRoot(openAsks(asks))
  const out: HubGroups = { needs: [], working: [], open: [], done: [] }
  for (const a of agents) {
    if (a.kind === 'subagent') continue
    if (opts.repoId !== undefined && opts.repoId !== null && a.repoId !== opts.repoId) continue
    const rootAsks = byRoot.get(a.id) ?? []
    if (rootAsks.length || (isLive(a) && a.status === 'needs_you' && a.needs !== 'idle' && a.needs !== null) || isUnseenIdle(a, seen)) {
      out.needs.push({ root: a, asks: rootAsks })
    } else if (a.status === 'starting' || a.status === 'working') out.working.push(a)
    else if (a.status === 'idle' || isIdleWaiting(a) || (a.status === 'needs_you' && a.kind === 'session')) out.open.push(a)
    else if (a.status === 'needs_you') out.working.push(a)
    else if (a.endedAt && now - Date.parse(a.endedAt) <= DAY) out.done.push(a)
  }
  const needsKey = (g: { root: AgentNode; asks: Ask[] }): [number, string] => {
    const first = g.asks[0]
    if (first) return [NEEDS_RANK[first.kind] ?? 0, first.createdAt]
    return [NEEDS_RANK[g.root.needs ?? 'idle'] ?? 2, g.root.updatedAt]
  }
  out.needs.sort((x, y) => {
    const [rx, tx] = needsKey(x)
    const [ry, ty] = needsKey(y)
    return rx !== ry ? rx - ry : tx < ty ? -1 : tx > ty ? 1 : 0
  })
  const byUpdatedDesc = (x: AgentNode, y: AgentNode): number => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0)
  out.working.sort(byUpdatedDesc)
  out.open.sort(byUpdatedDesc)
  out.done.sort((x, y) => ((x.endedAt ?? '') < (y.endedAt ?? '') ? 1 : -1))
  out.done = out.done.slice(0, 30)
  return out
}

// ---------- labels ----------
export function money(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`
}
export function tokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
/** Cost when the CLI reported it, else tokens, else nothing (never an estimate). */
export function costOrTokens(a: Pick<AgentNode, 'costUsd' | 'tokensIn' | 'tokensOut'>): string {
  if (a.costUsd != null) return money(a.costUsd)
  const t = (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
  return t > 0 ? `${tokens(t)} tok` : ''
}
/** Honest degradation note for gemini/cursor subagents (LIVE.md §11). */
export function attributionNote(a: Pick<AgentNode, 'attribution' | 'kind'>): string | null {
  if (a.kind !== 'subagent') return null
  if (a.attribution === 'timing') return 'activity matched by timing'
  if (a.attribution === 'completion') return 'details arrive when it finishes'
  return null
}
export function agentLabel(a: Pick<AgentNode, 'title' | 'agentType' | 'kind'>): string {
  if (a.kind === 'subagent') return a.title || a.agentType || 'Subagent'
  return a.title
}
/** Short display title for a root: step roots titled by a raw prompt read as its first sentence (full text on hover). */
export function rootTitle(a: Pick<AgentNode, 'title' | 'kind'>, max = 60): string {
  if (a.kind === 'subagent') return a.title
  if (a.kind === 'step' && a.title.length > 24) return promptTitle(a.title, max) || a.title
  return a.title
}
/** One status line: the activity, or a fallback that says what state it is in. */
export function activityLine(a: AgentNode, seen = false): string {
  if (a.activity) return a.activity
  switch (a.status) {
    case 'starting':
      return 'Starting…'
    case 'working':
      return a.lastTool ?? 'Working…'
    case 'needs_you':
      return a.needs === 'idle' ? (seen ? 'Waiting for your next message' : 'Your turn') : 'Waiting for you'
    case 'idle':
      return 'Ready'
    case 'done':
      return a.report ? firstLineOf(a.report) : 'Done'
    case 'failed':
      return 'Failed'
    case 'canceled':
      return 'Canceled'
  }
}
/** A tree row's activity, or null when it would only repeat the row's label (a subagent's description = title). */
export function rowActivity(a: AgentNode): string | null {
  const line = activityLine(a)
  const norm = (s: string): string => s.replace(/[\s.…:]+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const l = norm(line)
  const label = norm(agentLabel(a))
  if (!l || l === label || (l.length >= 12 && label.startsWith(l)) || (label.length >= 12 && l.startsWith(label) && l.length - label.length < 4)) return null
  return line
}
function firstLineOf(s: string, max = 120): string {
  const l = s.split('\n').map((x) => x.trim()).find(Boolean) ?? ''
  return l.length > max ? `${l.slice(0, max - 1)}…` : l
}
export function elapsedMs(a: Pick<AgentNode, 'startedAt' | 'endedAt'>, now = Date.now()): number {
  return Math.max(0, (a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt))
}

// ---------- memory chip (LIVE.md §7) ----------
export function memoryChipText(c: { reads: number; saved: number; briefOnly: boolean; granted: boolean }): string | null {
  // zero activity says nothing useful: no chip until something was read or saved (a brief still shows)
  if (c.reads === 0 && c.saved === 0 && !c.briefOnly) return null
  if (!c.granted && c.reads === 0 && c.saved === 0) return null
  const parts: string[] = []
  if (c.briefOnly) parts.push('brief')
  else parts.push(`${c.reads} read`)
  if (!c.briefOnly || c.saved) parts.push(`${c.saved} saved`)
  return parts.join(' · ')
}

// ---------- answered asks (hub trace) ----------
/** What the user sent, in one line: "You answered: users", "You allowed it", "You denied: too risky". */
export function answerText(ask: Ask): string | null {
  if (ask.status === 'expired') return 'Expired — Principia denied it'
  if (ask.status === 'canceled') return null
  if (ask.status !== 'answered') return null
  if (ask.answeredVia === 'terminal') return 'Answered in the terminal'
  const a = ask.answer
  const opt = a?.optionId ? ask.options.find((o) => o.id === a.optionId) : undefined
  const cut = (t: string): string => (t.length > 80 ? `${t.slice(0, 79)}…` : t)
  if (opt?.kind === 'choice') return `You answered: ${cut(opt.label)}`
  if (a?.text) return `You answered: ${cut(a.text.replace(/\s+/g, ' ').trim())}`
  if (opt?.kind === 'allow' || opt?.kind === 'allow_step') return opt.kind === 'allow_step' ? 'You allowed it for this step' : 'You allowed it'
  if (opt?.kind === 'deny') return a?.message ? `You denied: ${cut(a.message)}` : 'You denied it'
  return 'You answered'
}
/** What a waiting agent last said (its turn's final message), for the reply box. The end matters most. */
export function lastSaid(a: Pick<AgentNode, 'report'>, max = 400): string | null {
  const t = a.report?.replace(/\n{3,}/g, '\n\n').trim()
  if (!t) return null
  return t.length > max ? `…${t.slice(t.length - max + 1).trimStart()}` : t
}
/**
 * Markdown as plain words for a one-line preview (a chat's row in Chats, Needs you on the phone): no code fences,
 * headings, list marks, **bold**, `code` or link syntax; a principia:// link keeps only its label.
 */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s*\(\s*<?principia:\/\/[^\s)]+>?\s*\)/g, '')
    .replace(/<?principia:\/\/\S+>?/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
/**
 * The gist of what an agent said last, for a list row: its first real line in plain words (a list of 300 numbers
 * previews as "1", never as its last number).
 */
export function saidPreview(a: Pick<AgentNode, 'report'>, max = 160): string | null {
  const t = a.report?.trim()
  if (!t) return null
  const lines = plainText(t)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const first = lines.find((l) => l.length > 3 && /[A-Za-z\u00C0-\u024F]/.test(l)) ?? lines[0]
  if (!first) return null
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}
export const ANSWER_TRACE_MS = 3 * 60_000
/**
 * The row's "↩ You allowed it" trace: only once nothing is pending for that root (no open ask in its tree, root not
 * waiting for the user). A row that waits always shows what it waits for instead.
 */
export function answerTrace(root: Pick<AgentNode, 'id' | 'status'>, asks: Iterable<Ask>, now = Date.now()): Ask | null {
  if (root.status === 'needs_you') return null
  const all = [...asks]
  if (all.some((a) => a.rootId === root.id && a.status === 'open')) return null
  return recentAnswer(all, root.id, now)
}
/** The most recent ask of a root answered in Principia within `windowMs`, for the row's last-activity line. */
export function recentAnswer(asks: Iterable<Ask>, rootId: Id, now = Date.now(), windowMs = ANSWER_TRACE_MS): Ask | null {
  let best: Ask | null = null
  for (const a of asks) {
    if (a.rootId !== rootId || a.status === 'open' || a.status === 'canceled' || !a.answeredAt) continue
    if (now - Date.parse(a.answeredAt) > windowMs) continue
    if (!best || a.answeredAt > (best.answeredAt ?? '')) best = a
  }
  return best
}

// ---------- canvas pills (LIVE.md §11) ----------
export interface Pill {
  id: Id
  label: string
  activity: string
  visual: AgentVisual
  depth: number
  note: string | null
}
export const PILL_MAX = 4
/** Subagents of a root as pills: live ones first, then newest; at most 4 plus "+n more". */
export function pillsFor(idx: AgentIndex, rootId: Id, askAgents: ReadonlySet<Id>): { pills: Pill[]; more: number } {
  const all = descendants(idx, rootId)
  const ranked = [...all].sort((x, y) => {
    const lx = askAgents.has(x.agent.id) ? 0 : isLive(x.agent) ? 1 : 2
    const ly = askAgents.has(y.agent.id) ? 0 : isLive(y.agent) ? 1 : 2
    if (lx !== ly) return lx - ly
    return x.agent.startedAt < y.agent.startedAt ? 1 : -1
  })
  const pills = ranked.slice(0, PILL_MAX).map(({ agent, depth }) => ({
    id: agent.id,
    label: agentLabel(agent),
    activity: activityLine(agent),
    visual: askAgents.has(agent.id) ? ('needs' as const) : agentVisual(agent),
    depth,
    note: attributionNote(agent)
  }))
  return { pills, more: Math.max(0, all.length - PILL_MAX) }
}

// ---------- events ----------
export function eventGlyph(e: AgentEvent): string {
  if (e.kind === 'ask') return '◆'
  if (e.kind === 'answer') return '↩'
  if (e.kind === 'error' || e.state === 'error') return '✕'
  if (e.state === 'denied') return '⊘'
  if (e.state === 'running') return '●'
  if (e.kind === 'text') return '¶'
  if (e.kind === 'thinking') return '…'
  if (e.kind === 'status') return '·'
  return '✓'
}
/** Duration of a tool row: from its ts to the next event's ts (rows are updated in place when the result lands). */
export function eventDurations(list: AgentEvent[]): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i + 1 < list.length; i++) {
    const e = list[i]!
    if (e.kind === 'tool' && e.state !== 'running') m.set(e.seq, Math.max(0, Date.parse(list[i + 1]!.ts) - Date.parse(e.ts)))
  }
  return m
}

// ---------- dashboard (LIVE.md §8) ----------
const CLOCK = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Since 09:14", "Since 09:14 yesterday", "Since Oct 12 09:14". */
export function sinceLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(now) - start(d)) / DAY)
  if (days <= 0) return `Since ${CLOCK(d)}`
  if (days === 1) return `Since ${CLOCK(d)} yesterday`
  return `Since ${MONTHS[d.getMonth()]} ${d.getDate()} ${CLOCK(d)}`
}

/**
 * Home's window label. "Since my last visit" on a first visit (no last-seen mark yet) covers the default 24 hours, so
 * it says so instead of an odd clock time ("Since 04:09 yesterday").
 */
export function homeWindowLabel(mode: 'last' | '24h' | '7d', since: string, neverSeen: boolean, now: Date = new Date()): string {
  if (mode === '24h' || (mode === 'last' && neverSeen)) return 'Last 24 hours'
  if (mode === '7d') return 'Last 7 days'
  return sinceLabel(since, now)
}

export interface ModelSeries {
  models: string[] // top models, then 'other' when more
  /** per day, tokens per model in `models` order */
  values: number[][]
}
/** Tokens/day by model: the 5 biggest models over the window, the rest folded into "other". */
export function modelSeries(days: { byModel: { model: string; tokens: number }[] }[], max = 5): ModelSeries {
  const total = new Map<string, number>()
  for (const d of days) for (const m of d.byModel) total.set(m.model, (total.get(m.model) ?? 0) + m.tokens)
  const ranked = [...total.entries()].filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]).map(([m]) => m)
  const top = ranked.slice(0, max)
  const hasOther = ranked.length > max
  const models = hasOther ? [...top, 'other'] : top
  const values = days.map((d) => {
    const row = models.map(() => 0)
    for (const m of d.byModel) {
      const i = top.indexOf(m.model)
      if (i >= 0) row[i]! += m.tokens
      else if (hasOther) row[models.length - 1]! += m.tokens
    }
    return row
  })
  return { models, values }
}
/** A "nice" axis max ≥ v: 1, 2, 2.5, 5 × 10^n. */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}
/**
 * Axis ticks for a bar chart: 0 and max, plus the midpoint only when it is exactly representable at the axis
 * resolution (`step`: 1 for counts and tokens, 0.01 for dollars). Avoids "1, 1, 0" and "$0.05 / $0.03 / 0".
 */
export function axisTicks(max: number, step: number): number[] {
  if (max <= 0) return [0]
  const mid = max / 2
  const q = mid / step
  return Math.abs(q - Math.round(q)) < 1e-9 && mid >= step ? [0, mid, max] : [0, max]
}
/** Integer-valued axis max: never below 1, and a value with an integer midpoint when it can (1, 2, 4, 6, 10, 20…). */
export function niceIntMax(v: number): number {
  if (v <= 1) return 1
  if (v <= 2) return 2
  const m = niceMax(v)
  return m % 2 === 0 ? m : Math.ceil(v / 2) * 2
}
/** "Mon 14" style short day label from YYYY-MM-DD (local). */
export function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1)
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]} ${dt.getDate()}`
}

// ---------- usage limits + stalled (LANDSCAPE "Elon's cut" #4) ----------
/** A live root with no output and no hook activity for Settings.stallMinutes ("Stalled?"). Never auto-killed. */
export function isStalled(a: Pick<AgentNode, 'status' | 'stalledSince'> | null | undefined): boolean {
  return !!a && !!a.stalledSince && isLive(a)
}
/** Minutes a stalled agent has been quiet (rounded down, ≥ 1). */
export function stalledMinutes(a: Pick<AgentNode, 'stalledSince'>, stallMinutes: number, now = Date.now()): number {
  if (!a.stalledSince) return stallMinutes
  return Math.max(1, Math.floor((now - Date.parse(a.stalledSince)) / 60_000) + stallMinutes)
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "15:00" on the same local day, else "Tue 15:00". */
export function resetClock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return same ? CLOCK(d) : `${WD[d.getDay()]} ${CLOCK(d)}`
}
/** "Hit usage limit · resets 15:00", or "Hit usage limit" when the CLI did not say. */
export function limitLine(x: { resetAt?: string | null }, now: Date = new Date()): string {
  const c = x.resetAt ? resetClock(x.resetAt, now) : ''
  return c ? `Hit usage limit · resets ${c}` : 'Hit usage limit'
}
/** "Retry scheduled 15:01". */
export function retryLabel(retryAt: string, now: Date = new Date()): string {
  return `Retry scheduled ${resetClock(retryAt, now)}`
}
/** "Retry at reset", or "Retry in 1 h" when the reset time is unknown (main then retries in an hour). */
export function retryAtResetLabel(resetAt: string | null | undefined): string {
  return resetAt ? 'Retry at reset' : 'Retry in 1 h'
}
/** True for a rate-limited row whose scheduled retry has not started yet. */
export function isRateLimited(x: { stopReason?: string | null } | null | undefined): boolean {
  return x?.stopReason === 'rate_limited'
}

/** The run ids waiting for a free slot, after one run's update (the same map when nothing changed). */
export function slotWaitsWith(waits: Readonly<Record<Id, string>>, run: Pick<Run, 'id' | 'status' | 'slotWaitSince'>): Record<Id, string> {
  const since = run.status === 'queued' || run.status === 'running' ? (run.slotWaitSince ?? null) : null
  if (since === (waits[run.id] ?? null)) return waits
  const next = { ...waits }
  if (since) next[run.id] = since
  else delete next[run.id]
  return next
}
