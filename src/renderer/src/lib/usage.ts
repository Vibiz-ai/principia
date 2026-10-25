/**
 * USAGE.md: pure helpers for the Usage page (money and byte labels, chart columns) and the portfolio Activity canvas
 * (one item per Claude session, grouped in a frame per company, laid out on a grid). No React, no IPC.
 */
import type { AgentNode } from '@shared/live'
import type { ActivitySession, UsageBucket, UsageDay } from '@shared/usage'
import type { AdapterId, Id } from '@shared/types'
import { durationMs } from './time'

// ---------- Usage ----------
/** "$1.20", "~$1.20" (estimated), "—" (tokens with no price), "$0" (nothing). A partly unpriced bucket gets "+". */
export function moneyLabel(b: Pick<UsageBucket, 'usd' | 'estimated' | 'unpriced' | 'tokensIn' | 'tokensOut'>): string {
  if (b.usd == null) return b.tokensIn + b.tokensOut > 0 ? '—' : '$0'
  const v = b.usd === 0 ? '0' : b.usd < 0.01 ? '<0.01' : b.usd < 100 ? b.usd.toFixed(2) : b.usd.toFixed(0)
  return `${b.estimated ? '~' : ''}$${v}${b.unpriced ? '+' : ''}`
}
export function moneyTitle(b: Pick<UsageBucket, 'usd' | 'estimated' | 'unpriced'>): string {
  const parts: string[] = []
  if (b.usd == null) parts.push('No price for this model: tokens only')
  else if (b.estimated) parts.push('Includes estimates from the price table (~)')
  else parts.push('Reported by the CLI')
  if (b.usd != null && b.unpriced) parts.push('plus tokens of models with no price (+)')
  return parts.join(', ')
}
export function tokenLabel(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`
}
export type UsageMetric = 'tokens' | 'cost'
export function dayValue(d: UsageDay, metric: UsageMetric): number {
  return metric === 'tokens' ? d.tokensIn + d.tokensOut : (d.usd ?? 0)
}
/** The day had tokens the dollar figure leaves out (a model with no price): drawn as a hollow dashed mark in Cost. */
export function unpricedDay(d: UsageDay): boolean {
  return d.unpriced || (d.usd == null && d.tokensIn + d.tokensOut > 0)
}
/** "Remove 3 items (1.2 GB)" */
export function removeLabel(count: number, bytes: number): string {
  if (!count) return 'Remove'
  return `Remove ${count} item${count === 1 ? '' : 's'} (${bytesLabel(bytes)})`
}

// ---------- Activity canvas ----------
export type ActivityOpen = { kind: 'outside'; sessionId: string } | { kind: 'session'; sessionId: Id } | { kind: 'run'; runId: Id; stepId: Id | null }
export interface ActivityItem {
  key: string
  companyId: Id | null
  title: string
  doing: string | null
  state: 'working' | 'idle' | 'needs'
  /** The running timer starts here. */
  since: string | null
  tokens: number | null
  tokensPartial: boolean
  provider: AdapterId
  model: string | null
  /** 'Principia' agent or an outside Claude Code session. */
  source: 'principia' | 'outside'
  background: boolean
  open: ActivityOpen | null
}
export const ACTIVITY_WINDOW_MS = 15 * 60_000
const LIVE = new Set(['starting', 'working', 'needs_you'])

/** Principia's own agents for the canvas: live roots and background subagents (idle roots only if recent). */
export function principiaItems(agents: Iterable<AgentNode>, companyOf: (a: AgentNode) => Id, now: number): ActivityItem[] {
  const all = [...agents]
  const byId = new Map(all.map((a) => [a.id, a]))
  const out: ActivityItem[] = []
  for (const a of all) {
    const recent = now - Date.parse(a.updatedAt) < ACTIVITY_WINDOW_MS
    const live = LIVE.has(a.status) || (a.status === 'idle' && recent)
    if (!live) continue
    if (a.kind === 'subagent' && !a.background) continue
    if (a.provider === 'shell') continue
    const root = a.rootId !== a.id ? byId.get(a.rootId) : a
    const open: ActivityOpen | null = root?.runId ? { kind: 'run', runId: root.runId, stepId: root.stepId } : root?.sessionId ? { kind: 'session', sessionId: root.sessionId } : null
    const tokens = a.tokensIn == null && a.tokensOut == null ? null : (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
    out.push({
      key: `p:${a.id}`,
      companyId: companyOf(a),
      title: a.title || 'Agent',
      doing: a.activity ?? a.lastTool ?? null,
      state: a.status === 'needs_you' ? 'needs' : a.status === 'idle' ? 'idle' : 'working',
      since: a.startedAt,
      tokens,
      tokensPartial: false,
      provider: a.provider,
      model: a.model,
      source: 'principia',
      background: a.kind === 'subagent',
      open
    })
  }
  return out
}

export function outsideItems(sessions: ActivitySession[]): ActivityItem[] {
  return sessions.map((s) => ({
    key: `o:${s.id}`,
    companyId: s.companyId,
    title: s.title,
    doing: s.doing,
    state: s.state,
    // the turn start can be unknown (a huge transcript read head + tail, no typed prompt in the tail): then no timer,
    // never the session's age
    since: s.state === 'working' ? s.turnStartedAt : s.lastAt,
    tokens: s.tokensIn + s.tokensOut,
    tokensPartial: s.tokensPartial,
    provider: 'claude',
    model: s.model,
    source: 'outside',
    background: false,
    open: { kind: 'outside', sessionId: s.id }
  }))
}

/** The card's timer: "4m02s" on the current turn, "idle 3m" since the last activity, null when the start is unknown. */
export function cardTimer(it: Pick<ActivityItem, 'state' | 'since'>, now: number = Date.now()): string | null {
  if (!it.since) return null
  const t = durationMs(Math.max(0, now - Date.parse(it.since)))
  return it.state === 'idle' ? `idle ${t}` : t
}
/** Frame meta: "3 agents · 2 working" (Principia agents, background subagents and terminal sessions all count). */
export function frameMeta(count: number, working: number): string {
  return `${count} agent${count === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}`
}

export const ELSEWHERE = '__elsewhere'
export interface ActivityFrame {
  key: string // company id or ELSEWHERE
  companyId: Id | null
  items: ActivityItem[]
  x: number
  y: number
  width: number
  height: number
}
export const CARD_W = 240
export const CARD_H = 124
const GAP = 16
const PAD = 16
const HEAD = 40
const COLS = 3
const ROW_MAX = 1800

/** One frame per company (in `order`), Elsewhere last; cards in rows of 3, frames flowing left to right. */
export function layoutActivity(items: ActivityItem[], order: Id[]): ActivityFrame[] {
  const groups = new Map<string, ActivityItem[]>()
  for (const it of items) {
    const k = it.companyId ?? ELSEWHERE
    const l = groups.get(k)
    if (l) l.push(it)
    else groups.set(k, [it])
  }
  const rank = (k: string): number => (k === ELSEWHERE ? 1e9 : order.indexOf(k) < 0 ? 1e8 : order.indexOf(k))
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b))
  const frames: ActivityFrame[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const k of keys) {
    const list = groups.get(k)!.sort((a, b) => Number(b.state !== 'idle') - Number(a.state !== 'idle') || (a.source === b.source ? 0 : a.source === 'principia' ? -1 : 1) || a.title.localeCompare(b.title))
    const cols = Math.min(COLS, list.length)
    const rows = Math.ceil(list.length / COLS)
    const width = PAD * 2 + cols * CARD_W + (cols - 1) * GAP
    const height = HEAD + PAD + rows * CARD_H + (rows - 1) * GAP
    if (x > 0 && x + width > ROW_MAX) {
      x = 0
      y += rowH + 40
      rowH = 0
    }
    frames.push({ key: k, companyId: k === ELSEWHERE ? null : k, items: list, x, y, width, height })
    x += width + 40
    rowH = Math.max(rowH, height)
  }
  return frames
}
/** Card position inside its frame. */
export function cardPos(i: number): { x: number; y: number } {
  return { x: PAD + (i % COLS) * (CARD_W + GAP), y: HEAD + Math.floor(i / COLS) * (CARD_H + GAP) }
}
