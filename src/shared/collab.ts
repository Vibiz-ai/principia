/**
 * AGENT-COLLAB.md: agents asking agents. Shared types (main, renderer). Pure: no node or electron imports.
 *
 * An agent asks another agent (forum_ask_agent, or an @agent / @department mention in its own post); the target wakes
 * in a short reply run and answers in the thread. Every wake is a row (`forum_agent_wakes`), checked against the
 * guards below first, so the owner sees who asked whom, why, how deep the chain went and what it cost.
 */

/** Settings → agentCollab. Every field is a guard; absent = the default. */
export interface AgentCollabSettings {
  /** off = agents can still post and mention, but nothing they write wakes another agent */
  enabled: boolean
  /** hops in one chain: A asks B = 1, B then asks C = 2 … */
  maxHops: number
  /** agent wakes in one thread */
  perThread: number
  /** times one agent can be woken by other agents per rolling hour */
  perAgentPerHour: number
  /** asks one agent can send per rolling hour */
  perAskerPerHour: number
  /** agent-to-agent wakes per company per rolling 24 h */
  perCompanyPerDay: number
  /** how long forum_ask_agent waits for the answer by default (seconds; 0 = never waits) */
  waitDefaultS: number
  /** the most an asker may wait (seconds) */
  waitMaxS: number
}

export const DEFAULT_AGENT_COLLAB: AgentCollabSettings = {
  enabled: true,
  maxHops: 3,
  perThread: 4,
  perAgentPerHour: 6,
  perAskerPerHour: 8,
  perCompanyPerDay: 40,
  waitDefaultS: 120,
  waitMaxS: 300
}

/** Validation ranges (settings:update, the Agent talk panel). */
export const AGENT_COLLAB_RANGES: Record<Exclude<keyof AgentCollabSettings, 'enabled'>, [number, number]> = {
  maxHops: [1, 6],
  perThread: [1, 20],
  perAgentPerHour: [1, 60],
  perAskerPerHour: [1, 60],
  perCompanyPerDay: [1, 500],
  waitDefaultS: [0, 600],
  waitMaxS: [0, 600]
}

export function collabSettings(raw: Partial<AgentCollabSettings> | null | undefined): AgentCollabSettings {
  const out = { ...DEFAULT_AGENT_COLLAB }
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  for (const [k, [lo, hi]] of Object.entries(AGENT_COLLAB_RANGES) as [keyof typeof AGENT_COLLAB_RANGES, [number, number]][]) {
    const v = raw[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, Math.round(v)))
  }
  if (out.waitDefaultS > out.waitMaxS) out.waitDefaultS = out.waitMaxS
  return out
}

/** Why a wake did not happen (`refused`), as a stable code + the line the asking agent saw. */
export const COLLAB_REFUSALS = ['off', 'self', 'not_agent', 'cannot_answer', 'cycle', 'hops', 'thread_cap', 'target_cap', 'asker_cap', 'company_cap', 'start_failed'] as const
export type CollabRefusal = (typeof COLLAB_REFUSALS)[number]

export type CollabWakeStatus = 'started' | 'queued' | 'answered' | 'refused'

export interface CollabWake {
  id: string
  companyId: string
  /** the root message of the thread the conversation lives in */
  threadMessageId: string
  /** the message that asked (the root, or a reply with a mention) */
  messageId: string
  channelId: string
  fromMemberId: string
  toMemberId: string
  /** display names at read time (the Run view has no Forum context) */
  fromName: string
  toName: string
  fromAgentId: string | null
  toAgentId: string | null
  /** the asker's run (task run, workflow step, reply run) */
  fromRunId: string | null
  /** the reply run that answered; null while queued or when refused */
  toRunId: string | null
  /** 1 = asked by an agent whose run was not itself woken by an agent */
  depth: number
  /** member ids of the agents already in this chain, the asker last */
  chain: string[]
  via: 'ask' | 'mention'
  why: string
  status: CollabWakeStatus
  refusal: CollabRefusal | null
  /** the line the asking agent was told */
  note: string
  createdAt: string
  answeredAt: string | null
  /** of the reply run (agents table roots); null = not reported (yet) */
  costUsd: number | null
  /** true when costUsd is estimated from tokens (src/main/forum/pricing.ts) */
  costEstimated: boolean
  tokens: number | null
}

/** One agent conversation (a thread with at least one agent wake), for the Forum's Agent talk panel. */
export interface CollabThread {
  threadMessageId: string
  channelId: string
  ref: string
  /** the root text, clipped */
  text: string
  startedAt: string
  lastAt: string
  members: string[]
  wakes: CollabWake[]
  maxDepth: number
  costUsd: number | null
  costEstimated: boolean
}

export interface CollabState {
  companyId: string
  settings: AgentCollabSettings
  /** rolling counters against the caps */
  usage: { wakesToday: number; refusedToday: number; capPerDay: number }
  threads: CollabThread[]
}

/** The Forum conversation of one run (Run view): what it asked, what it was asked, what it posted. */
export interface RunConversation {
  runId: string
  /** wakes this run made (it asked) and the one that started it (it answered) */
  asked: CollabWake[]
  answered: CollabWake | null
  messages: { id: string; ref: string; channelId: string; channelName: string | null; threadId: string | null; authorId: string; authorName: string; authorKind: 'human' | 'agent' | 'guest'; text: string; createdAt: string }[]
}
