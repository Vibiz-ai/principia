/**
 * FORUM.md: the Forum's shared types (main, renderer, the forum CLI). Pure: no node or electron imports.
 * One Forum per company; every row carries companyId. Messages are addressed by `ref` (m + base36 seq) in the agent
 * protocol and by `id` (fmsg_…) everywhere else.
 */

import type { ForumTaskCard } from './taskCard'

export const FORUM_PROTOCOL_VERSION = 1

export const FORUM_MEMBER_KINDS = ['human', 'agent', 'guest'] as const
export type ForumMemberKind = (typeof FORUM_MEMBER_KINDS)[number]
export const FORUM_ROLES = ['owner', 'admin', 'member', 'guest', 'agent'] as const
export type ForumRole = (typeof FORUM_ROLES)[number]
/** Roles an invite can grant (owner is never invited; agents are added, never invited). */
export const FORUM_INVITE_ROLES = ['admin', 'member', 'guest'] as const
export type ForumInviteRole = (typeof FORUM_INVITE_ROLES)[number]
export type ForumMemberStatus = 'active' | 'invited' | 'removed'

export interface ForumMember {
  id: string
  companyId: string
  kind: ForumMemberKind
  role: ForumRole
  /** company_agents.id for agent members */
  agentId: string | null
  /** lowercase, unique per company: what `@handle` resolves */
  handle: string
  /** display name; agents: the persona name (the role label comes from the seat) */
  name: string
  status: ForumMemberStatus
  createdAt: string
  data: { email?: string; title?: string; inviteId?: string }
}

export const FORUM_CHANNEL_KINDS = ['public', 'private', 'dm', 'group'] as const
export type ForumChannelKind = (typeof FORUM_CHANNEL_KINDS)[number]
export type ForumChannelSystem = 'general' | 'department' | 'proposals'

export interface ForumChannel {
  id: string
  companyId: string
  kind: ForumChannelKind
  /** slug for public/private channels; null for DMs */
  name: string | null
  topic: string
  purpose: string
  departmentId: string | null
  system: ForumChannelSystem | null
  createdBy: string | null
  createdAt: string
  archivedAt: string | null
  memberIds: string[]
  lastSeq: number
  lastMessageAt: string | null
  /** for the viewer (`forum:state`): */
  joined: boolean
  lastReadSeq: number
  unread: number
  mentions: number
  /** CHAT-UI.md §8.6: tasks whose result or question is among the unread messages ("VO-16 finished · unread") */
  unreadTasks?: string[]
  /**
   * CHAT-UI.md §7.1, conversations only: who set the title. 'first' = the first message's words (the fallback),
   * 'ai' = Principia named it, 'you' = renamed by a person (never overwritten). Absent on older conversations.
   */
  titleBy?: ConversationTitleBy
  /** CHAT-UI.md §7.2: Principia is still picking who answers this conversation */
  picking?: boolean
}
export type ConversationTitleBy = 'first' | 'ai' | 'you'

export const FORUM_MESSAGE_KINDS = ['text', 'ask', 'proposal', 'system'] as const
export type ForumMessageKind = (typeof FORUM_MESSAGE_KINDS)[number]
export const FORUM_REF_KINDS = ['task', 'note', 'artifact', 'run', 'url', 'message'] as const
export type ForumRefKind = (typeof FORUM_REF_KINDS)[number]
export interface ForumRef {
  kind: ForumRefKind
  /** task id or PRN-12, note title, art_…, run_…, url, message ref */
  id: string
  label: string
}

export interface ForumAsk {
  status: 'open' | 'answered' | 'closed'
  /** member ids asked */
  to: string[]
  options?: string[]
  taskId?: string | null
  runId?: string | null
  answer?: string
  answeredBy?: string
  answeredAt?: string
  /** an answer given while the task's run was still running: applied when it parks */
  pendingTaskAnswer?: boolean
}

export const FORUM_PROPOSAL_KINDS = ['department', 'agent'] as const
export type ForumProposalKind = (typeof FORUM_PROPOSAL_KINDS)[number]
export const FORUM_AGENT_ADAPTERS = ['claude', 'codex', 'gemini', 'cursor'] as const
export type ForumAgentAdapter = (typeof FORUM_AGENT_ADAPTERS)[number]
export interface ForumProposalDepartment { name: string; key?: string; does: string; doesNot: string }
export interface ForumProposalAgent {
  departmentKey: string | null
  role: string
  instructions: string
  capabilities: string
  adapter?: ForumAgentAdapter
}
export interface ForumProposal {
  kind: ForumProposalKind
  status: 'open' | 'approved' | 'rejected'
  reason: string
  department?: ForumProposalDepartment
  agent?: ForumProposalAgent
  decidedBy?: string
  decidedAt?: string
  note?: string
  result?: { departmentId?: string; agentId?: string }
  error?: string
  /**
   * CHAT-UI.md §7.2, a hire proposed in a conversation: the person's message the new agent answers once it is created
   * (it joins the conversation), the closest existing agent offered instead ("Use Julia instead"), and the need in a
   * few words ("social media scheduling").
   */
  forMessageId?: string
  insteadAgentId?: string | null
  need?: string
  /** agent id brought in instead of hiring (decide reject with useAgentId) */
  usedAgentId?: string
}

export interface ForumMessage {
  id: string
  seq: number
  /** m + base36(seq): the short ref agents quote */
  ref: string
  companyId: string
  channelId: string
  /** root message id of a thread reply, else null */
  threadId: string | null
  authorId: string
  kind: ForumMessageKind
  text: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  replyCount: number
  lastReplyAt: string | null
  /** up to five member ids who replied (thread avatars) */
  repliers: string[]
  mentions: string[]
  mentionDepartments: string[]
  refs: ForumRef[]
  reactions: Record<string, string[]>
  ask?: ForumAsk
  proposal?: ForumProposal
  /** CHAT-UI.md §8: a task started from this conversation (a system line drawn as the live task card) */
  task?: ForumTaskCard
  /** 'local' | 'agent:<stepId>' (FORUM.md §7) | 'principia:<runId>' (ORCHESTRATOR.md: Principia posted it for the agent) */
  origin: string
  /** ORCHESTRATOR.md: 'principia' when Principia posted this for the agent (from its run report), not the agent's own tool */
  via?: 'principia'
}

export type ForumInviteStatus = 'active' | 'expired' | 'used' | 'revoked'
export interface ForumInvite {
  id: string
  companyId: string
  role: ForumInviteRole
  channelIds: string[]
  label: string
  codeHint: string
  createdBy: string
  createdAt: string
  expiresAt: string | null
  maxUses: number
  uses: number
  revokedAt: string | null
  status: ForumInviteStatus
  /** only in the forum:invite answer (shown once) */
  code?: string
  link?: string
}

/** 'queued': a reply run was started but has no free slot yet. */
export type ForumPresenceState = 'queued' | 'working' | 'reading' | 'composing' | 'idle'
export interface ForumPresence {
  companyId: string
  memberId: string
  state: ForumPresenceState
  channelId: string | null
  at: string
}

export interface ForumState {
  companyId: string
  /** the viewer (the owner on this Mac) */
  me: string
  members: ForumMember[]
  channels: ForumChannel[]
  presence: ForumPresence[]
  openAsks: number
  openProposals: number
  /** CHAT-UI.md §8.6: the conversation each task was filed from (task id → channel id): its work shows on that row */
  taskChannels?: Record<string, string>
}

export interface ForumSearchHit { message: ForumMessage; channelId: string }

export type ForumEvent =
  | { kind: 'message'; companyId: string; message: ForumMessage }
  | { kind: 'channel'; companyId: string; channel: ForumChannel | null; channelId: string }
  | { kind: 'members'; companyId: string }
  | { kind: 'presence'; companyId: string; presence: ForumPresence }
  | { kind: 'read'; companyId: string; channelId: string; seq: number }

// ---------- request shapes (forum:* IPC) ----------
export interface ForumPostRequest {
  companyId: string
  channelId: string
  text: string
  threadId?: string | null
  /** post an ask card: member ids asked (and quick answers) */
  ask?: { to: string[]; options?: string[] }
  /** post a proposal card (a human may propose too; an admin decides) */
  proposal?: Pick<ForumProposal, 'kind' | 'reason' | 'department' | 'agent'>
}
export interface ForumCreateChannelRequest {
  companyId: string
  name: string
  kind: 'public' | 'private'
  purpose?: string
  memberIds?: string[]
}
/**
 * CHAT-UI.md §7: New conversation, started in main (forum:startConversation). `agentIds`: the people you picked (To:
 * a person, @names, Everyone), who answer at once. `pick`: Principia picks (§7.2): main reads the request against
 * the team and brings in the best fit, or proposes a new specialist; `pick.agentIds` and `pick.handoff` are the
 * deterministic route (lib/conversations.ts routeTeam), used when no model can be asked.
 */
export interface ForumStartConversationRequest {
  companyId: string
  text: string
  /** the first-message title (the fallback until Principia names it) */
  title: string
  /** the channel slug (conversationSlug) */
  name: string
  /** the handoff line */
  purpose: string
  agentIds?: string[]
  pick?: { agentIds: string[]; handoff: string }
}
export interface ForumInviteRequest {
  companyId: string
  role: ForumInviteRole
  channelIds?: string[]
  label?: string
  /** 0 = never */
  expiresInDays?: number
  maxUses?: number
}
export interface ForumDecideRequest {
  messageId: string
  decision: 'approve' | 'reject'
  note?: string
  /** reject a conversation's hire proposal by bringing in this existing agent instead ("Use Julia instead") */
  useAgentId?: string
  /** approve with edits (the sheet's fields) */
  edits?: { name?: string; key?: string; role?: string; departmentKey?: string | null; profileId?: string; instructions?: string; capabilities?: string; does?: string; doesNot?: string }
}

// ---------- limits (FORUM.md §2.3, §4.4) ----------
export const FORUM_LIMITS = {
  agentText: 2000,
  humanText: 8000,
  postsPerStep: 12,
  postsPerHour: 40,
  agentChannelsPerDay: 3,
  proposalsPerDay: 5,
  openAsksPerAgent: 3,
  mentionsPerMessage: 8,
  waitMaxS: 600,
  httpPerMinute: 60,
  digestBudget: 4000,
  digestMax: 12000,
  digestLine: 400,
  threadLine: 2000,
  briefMax: 900,
  injectBriefMax: 1500,
  fencedOps: 5,
  reactionKinds: 12
} as const

/** m + base36(seq) */
export const messageRef = (seq: number): string => `m${seq.toString(36)}`
export const cursorRef = (seq: number): string => `c${seq.toString(36)}`
/** seq of `m3fk` / `c3fk`, or null */
export function parseSeqRef(ref: string, prefix: 'm' | 'c'): number | null {
  const m = new RegExp(`^${prefix}([0-9a-z]{1,10})$`).exec(ref.trim())
  if (!m) return null
  const n = parseInt(m[1], 36)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * CHAT-UI.md §7: a conversation started from the Home composer or "New conversation" is a private channel named
 * `chat-…` with you and the agents Principia brought in. Its agents answer every message, like a group DM, and an
 * @someone adds them. The UI calls it a conversation, never a channel (the Forum view does not list it).
 */
export const CONVERSATION_PREFIX = 'chat-'
export const isConversationChannel = (c: Pick<ForumChannel, 'kind' | 'name'>): boolean => c.kind === 'private' && !!c.name?.startsWith(CONVERSATION_PREFIX)

/** Channel slug: lowercase, [a-z0-9-], 2..40. */
export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
export function channelSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
/** Member handle: lowercase [a-z0-9._-], 1..32. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/
export function handleSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9._-]+/g, '')
      .replace(/^[._-]+/, '')
      .slice(0, 32) || 'member'
  )
}

/** Display label of a channel: `#marketing`, or the other members' names for a DM. */
export function channelLabel(c: Pick<ForumChannel, 'kind' | 'name' | 'memberIds'>, members: ReadonlyMap<string, Pick<ForumMember, 'name'>>, me: string): string {
  if (c.name) return `#${c.name}`
  const others = c.memberIds.filter((id) => id !== me).map((id) => members.get(id)?.name ?? 'someone')
  return others.length ? others.join(', ') : 'Just you'
}
