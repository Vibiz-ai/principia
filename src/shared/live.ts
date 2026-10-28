/**
 * Hive live agents: shared domain types (docs/LIVE.md, CONTRACT.md §12). Normative.
 * TYPE-ONLY except small `as const` lists. No Node or DOM imports.
 */
import type { AdapterId, Artifact, ISODate, Id, Run, StatusSnapshot, StopReason } from './types'
import type { MemoryFact } from './memory'

export const AGENT_KINDS = ['session', 'step', 'subagent'] as const
export const AGENT_STATUSES = ['starting', 'working', 'needs_you', 'idle', 'done', 'failed', 'canceled'] as const
export const ASK_KINDS = ['permission', 'question', 'trust', 'approval', 'slack_reply'] as const
export const ASK_CHANNELS = ['stdio', 'hook_gate', 'mcp', 'pty', 'acp', 'author', 'slack'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]
export type AgentStatus = (typeof AGENT_STATUSES)[number]
export type AskKind = (typeof ASK_KINDS)[number]
export type AskChannel = (typeof ASK_CHANNELS)[number]
export type NeedsKind = AskKind | 'idle'
export type Attribution = 'exact' | 'timing' | 'completion'

/** Statuses that mean the agent is still alive (hub "live"). */
export const LIVE_AGENT_STATUSES = ['starting', 'working', 'needs_you', 'idle'] as const satisfies readonly AgentStatus[]

export interface ModelUsage {
  tokensIn: number
  tokensOut: number
  costUsd: number | null
}
export interface AgentNode {
  id: Id
  kind: AgentKind
  parentId: Id | null
  rootId: Id
  sessionId: Id | null
  runId: Id | null
  stepId: Id | null
  provider: AdapterId
  repoId: Id | null
  cwd: string
  title: string
  agentType: string | null
  externalId: string | null
  toolUseId: string | null
  model: string | null
  depth: number
  background: boolean
  attribution: Attribution
  status: AgentStatus
  needs: NeedsKind | null
  activity: string | null
  lastTool: string | null
  toolCount: number
  memReads: number
  filesTouched: string[]
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  modelUsage: Record<string, ModelUsage> | null
  report: string | null
  /** A3: interactive root idle whose pane has been seen (window focused + visible). Not counted as Needs you. */
  seen?: boolean
  /** Roots: 'rate_limited' once the CLI said it hit a usage / rate limit ("Hit usage limit · resets 15:00"). */
  stopReason?: StopReason | null
  /** Roots: when that limit resets, if the CLI said so. */
  resetAt?: ISODate | null
  /** Roots: a pending "Retry at reset" (step roots mirror their run's retryAt; session roots resume the pane). */
  retryAt?: ISODate | null
  /** Roots: set while a working root has shown no output and no hook activity for Settings.stallMinutes ("Stalled?"). Never auto-killed. */
  stalledSince?: ISODate | null
  startedAt: ISODate
  updatedAt: ISODate
  endedAt: ISODate | null
}
export interface AgentEvent {
  seq: number
  agentId: Id
  ts: ISODate
  kind: 'tool' | 'text' | 'thinking' | 'status' | 'ask' | 'answer' | 'error'
  toolUseId: string | null
  name: string | null
  summary: string // <= 200 chars
  detail: string | null // <= 4 KB, redacted
  state: 'running' | 'ok' | 'error' | 'denied' | null
  /** a tool call's own one-line description of what it does (Claude's Bash `description`), <= 200 chars; absent = none */
  description?: string | null
}
/** `allow_always` is kept for shape compatibility; A1 drops it for interactive sessions. */
export interface AskOption {
  id: string
  label: string
  kind: 'allow' | 'allow_always' | 'allow_step' | 'deny' | 'choice' | 'focus'
}
export interface Ask {
  id: Id
  agentId: Id
  rootId: Id
  sessionId: Id | null
  runId: Id | null
  stepId: Id | null
  provider: AdapterId
  kind: AskKind
  channel: AskChannel
  title: string
  detail: string | null
  toolName: string | null
  toolInput: unknown | null
  question: string | null
  options: AskOption[]
  status: 'open' | 'answered' | 'expired' | 'canceled'
  answer: AskAnswer | null
  answeredVia: 'hive' | 'terminal' | 'timeout' | null
  createdAt: ISODate
  answeredAt: ISODate | null
  expiresAt: ISODate | null
  /** kind 'approval' (channel 'author'): the author draft this card decides (AUTHORING.md §2). */
  draftId?: Id | null
  /**
   * kind 'slack_reply' (channel 'slack', SLACK.md §8.3): the Slack draft this card sends or discards. Options
   * [{id:'send', kind:'allow'}, {id:'discard', kind:'deny'}]; answer.message = the edited text.
   */
  slackDraftId?: Id | null
}
export interface AskAnswer {
  askId: Id
  optionId?: string
  text?: string
  message?: string
}
export interface AgentListQuery {
  status?: AgentStatus[]
  runId?: Id
  sessionId?: Id
  rootsOnly?: boolean
  /** include agents ended at/after since (with any status filter OR'ed for live ones) */
  since?: ISODate
  /** default 200, max 1000 */
  limit?: number
}
export interface AgentDetail {
  agent: AgentNode
  descendants: AgentNode[]
  events: AgentEvent[]
  asks: Ask[]
}

export interface RunCard {
  run: Run
  durationMs: number | null
  costUsd: number | null
  tokens: { in: number; out: number } | null
  filesChanged: number
  files: string[]
  artifacts: Artifact[]
  failedStep: { stepId: Id; nodeId: string; error: string | null } | null
}
export interface LearnedFact {
  fact: MemoryFact
  entityName: string
  repoName: string | null
  runId: Id | null
  runTitle: string | null
}
export interface ActivityDay {
  date: string // YYYY-MM-DD, local
  runs: number
  passed: number
  failed: number
  tokens: number
  costUsd: number | null
  byModel: { model: string; tokens: number; costUsd: number | null }[]
}
export interface ComingUp {
  scheduleId: Id
  name: string
  at: ISODate
  sentence: string
}
export interface DashboardData {
  since: ISODate
  lastSeenAt: ISODate | null
  status: StatusSnapshot
  needsYou: { asks: Ask[]; idle: AgentNode[] }
  done: RunCard[] // <= 20
  learned: LearnedFact[] // <= 10
  activity: { days: ActivityDay[]; successRate: number | null } // 14 days
  live: AgentNode[] // live roots + descendants
  comingUp: ComingUp[] // <= 5
  morningBrief: Artifact | null
}
