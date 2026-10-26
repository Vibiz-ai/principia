/**
 * docs/USAGE.md: the Usage page (tokens and dollars per day, company, department and agent; plan limits; disk) and the
 * portfolio Activity canvas (every Claude Code session on this Mac). Wire types only; no logic.
 */
import type { ISODate, Id } from './types'

/** Rolling days, or the calendar: 'week' = since Monday, 'month' = since the 1st (five doors §4.9, local time). */
export const USAGE_RANGES = ['7d', '30d', '90d', 'week', 'month'] as const
export type UsageRange = (typeof USAGE_RANGES)[number]

/** One money figure. usd null = no price known (tokens only, shown as "—"); estimated = from the price table ("~"). */
export interface UsageMoney {
  usd: number | null
  estimated: boolean
  /** Some rows in this bucket had tokens for a model with no price: the dollar figure leaves them out. */
  unpriced: boolean
}
export interface UsageBucket extends UsageMoney {
  tokensIn: number
  tokensOut: number
  /** Agent roots counted (a run step, a session). */
  agents: number
}
export interface UsageDay extends UsageBucket {
  date: string // YYYY-MM-DD, local
}
export interface UsageRow extends UsageBucket {
  key: string
  label: string
  /** By department / agent: the company the row belongs to (All companies lists every company's rows). */
  companyId: Id | null
}
export interface PlanLimits {
  /** 'unknown': no limit event seen. Never a percentage we cannot read. */
  state: 'unknown' | 'seen'
  lastHitAt: ISODate | null
  resetAt: ISODate | null
  /** Where we saw it: a run or a session pane. */
  source: { runId?: Id; sessionId?: Id; title?: string } | null
}
export interface UsageSummary {
  range: UsageRange
  since: ISODate
  companyId: Id | null
  total: UsageBucket
  days: UsageDay[]
  byCompany: UsageRow[]
  byDepartment: UsageRow[]
  byAgent: UsageRow[]
  limits: PlanLimits
  priceSource: string
}

// ---------- disk ----------
export type DiskKind = 'worktrees' | 'artifacts' | 'logs' | 'company'
export interface DiskCompany {
  companyId: Id | null // null = not attributed (a run or session Principia no longer knows)
  bytes: number
  byKind: Record<DiskKind, number>
}
export interface DiskUsage {
  measuredAt: ISODate
  total: number
  companies: DiskCompany[]
  /** The walk stopped early (too many files); the sizes are a lower bound. */
  partial: boolean
}
export interface CleanupItem {
  id: string // 'wt:<worktree id>' | 'log:<run id>'
  kind: 'worktree' | 'log'
  companyId: Id | null
  title: string
  path: string
  bytes: number
  selectable: boolean
  /** Why it cannot be removed ('uncommitted changes', 'unpushed commits', 'pushed, not merged', 'still running'). */
  reason: string | null
  at: ISODate | null
}
export interface CleanupResult {
  removed: number
  freedBytes: number
  failed: { id: string; reason: string }[]
}

// ---------- activity canvas ----------
/** A Claude Code session outside Principia, from its transcript (read-only). */
export interface ActivitySession {
  id: string // claude session id
  path: string
  cwd: string | null
  /** Company whose repo (or worktree, or company folder) holds the cwd; null = Elsewhere. */
  companyId: Id | null
  title: string
  state: 'working' | 'idle'
  /** What it is doing now: the last tool line, or the last thing said. */
  doing: string | null
  model: string | null
  gitBranch: string | null
  startedAt: ISODate | null
  /** Start of the current turn (the last typed prompt). */
  turnStartedAt: ISODate | null
  lastAt: ISODate | null
  tokensIn: number
  tokensOut: number
  /** Tokens counted from part of the file only (it is larger than the scan cap). */
  tokensPartial: boolean
}
export interface ActivitySnapshot {
  at: ISODate
  /** Sessions active within this many minutes are shown. */
  windowMin: number
  sessions: ActivitySession[]
  /** Claude history is off in Settings: outside sessions are not read. */
  disabled: boolean
}
