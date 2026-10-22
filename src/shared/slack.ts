/**
 * Hive Slack (docs/SLACK.md, CONTRACT "## Slack"): shared types. TYPE-ONLY except small `as const` lists.
 * No Node or DOM imports. PO amendments PO-S1..PO-S10 (SLACK.md §0.3) are applied here:
 * - no `hidden` channels, no `threads` filter, no configurable maxRunsPerHour / maxAutoPostsPerRun / inThread;
 * - `slack:connect` is the single Connect button; `slack:join` / `slack:joinAll`; `auto_paused` draft reason.
 */
import type { ISODate, Id, RunStatus, WorkflowOrigin } from './types'

export type SlackConnState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'error'
export interface SlackStatus {
  state: SlackConnState
  error: string | null
  /** Missing scopes, split connection ("Another Hive is connected…"), rate-limit notice. */
  warnings: string[]
  since: ISODate | null
  nextRetryAt: ISODate | null
  lastEventAt: ISODate | null
  workspace: { teamId: string; name: string; domain: string | null; botUserId: string; botName: string } | null
  /** Masked only ("xoxb-…a1b2"). The renderer never receives a token value. */
  tokens: { bot: string | null; app: string | null }
  missingScopes: string[]
  sync: {
    state: 'idle' | 'running' | 'error'
    channelsDone: number
    channelsTotal: number
    threadsPending: number
    rateLimitedUntil: ISODate | null
    days: number
  }
  /** PO-S1: the first human DM while no alert user is set ("Got it from Dana Lee. Send your alerts here?"). */
  alertSuggestion: { userId: string; name: string } | null
  /** Dev fake build only. */
  fake?: boolean
}
export interface SlackTestResult {
  ok: boolean
  botToken: 'ok' | string
  appToken: 'ok' | string
  socket: 'ok' | string
  scopes: string[]
  missingScopes: string[]
}
export type SlackChannelKind = 'channel' | 'private' | 'dm' | 'group_dm'
export interface SlackChannel {
  id: string
  teamId: string
  kind: SlackChannelKind
  name: string
  dmUserId: string | null
  topic: string | null
  isMember: boolean
  isArchived: boolean
  memberCount: number | null
  lastMessageTs: string | null
  unread: boolean
  sync: 'pending' | 'running' | 'done' | 'error' | 'skipped'
}
export interface SlackUser {
  id: string
  name: string
  realName: string | null
  displayName: string | null
  isBot: boolean
  deleted: boolean
  avatarUrl: string | null
  tz: string | null
  /** Multi-channel guest (users.list `is_restricted`). Absent on rows stored before this field existed = false. */
  restricted?: boolean
  /** Single-channel guest (`is_ultra_restricted`). */
  ultraRestricted?: boolean
  /** The user's home workspace (`team_id`). Differs from the connected workspace for Slack Connect externals. */
  homeTeamId?: string | null
  /** `enterprise_user.enterprise_id` (Enterprise Grid). */
  enterpriseId?: string | null
}
export interface SlackFile {
  name: string
  mimetype: string | null
  size: number | null
  permalink: string | null
  /** Slack file id (F…). Absent on rows mirrored before image support. */
  id?: string | null
  /** Auth-gated download URL (url_private_download, else url_private). Main-only: never sent to agents or tools. */
  urlPrivate?: string | null
}
export interface SlackMessage {
  teamId: string
  channelId: string
  ts: string
  threadTs: string | null
  userId: string | null
  botId: string | null
  subtype: string | null
  text: string /* raw mrkdwn */
  plain: string
  files: SlackFile[]
  reactions: { name: string; count: number }[]
  replyCount: number
  latestReply: string | null
  editedTs: string | null
  deleted: boolean
  fromHive: boolean
  isMention: boolean
}
export interface SlackMessagePage {
  messages: SlackMessage[]
  hasMoreLocal: boolean
  oldestLocalTs: string | null
  backfillOldestTs: string | null
}
export interface SlackThread {
  channel: SlackChannel
  parent: SlackMessage | null
  replies: SlackMessage[]
  fetchedAt: ISODate | null
  drafts: SlackDraft[]
}
export interface SlackSearchQuery {
  query: string
  channelId?: string
  userId?: string
  after?: ISODate
  before?: ISODate
  limit?: number /* <= 100 */
}
export interface SlackSearchHit {
  message: SlackMessage
  channelName: string
  snippet: string /* match wrapped in «» */
}

export type SlackDraftStatus = 'pending' | 'sending' | 'sent' | 'discarded' | 'failed' | 'expired'
export const SLACK_DRAFT_REASONS = ['draft_mode', 'not_allowlisted', 'other_thread', 'interactive', 'auto_limit', 'auto_paused', 'no_trigger', 'manual'] as const
export type SlackDraftReason = (typeof SLACK_DRAFT_REASONS)[number]
export interface SlackDraft {
  id: Id
  status: SlackDraftStatus
  channelId: string
  channelName: string
  threadTs: string | null
  text: string
  originalText: string
  edited: boolean
  reason: SlackDraftReason
  note: string | null
  ownerLabel: string
  sessionId: Id | null
  runId: Id | null
  stepId: Id | null
  triggerId: Id | null
  askId: Id | null
  sentTs: string | null
  error: string | null
  createdAt: ISODate
  decidedAt: ISODate | null
  expiresAt: ISODate
}
export interface SlackDraftDetail {
  draft: SlackDraft
  context: SlackMessage[] /* last 3 */
  newSinceDraft: number
}

export type SlackReplyMode = 'draft' | 'auto' | 'none'
/**
 * SLACK.md SA2 (add-only, AI): what the agent steps of a Slack-triggered run may do. Slack text is untrusted, so the
 * default is restricted: claude only, no shell / file writes / web tools, nothing that would prompt (denied unattended),
 * only Hive's own MCP servers, and NO vault keys. `fullPermissions` restores the profile's own permission mode (the
 * approval card shows it in red); `secretNames` allow-lists vault keys by name ('*' is never accepted).
 */
export interface SlackAgentAccess {
  fullPermissions: boolean
  secretNames: string[]
  /**
   * Slack reads beyond the triggering conversation. By default the slack_* read tools of a Slack-triggered run see only
   * the conversation that started it (the triggering thread; a DM / group DM as a whole). Channel ids listed here
   * (public or private channels, never DMs or group DMs) are readable in full. Absent = none. Posting and drafting
   * stay limited to the triggering conversation whatever this says.
   */
  readChannels?: string[]
}
/** A channel id a trigger may list in `access.readChannels`: public (C…) or private (G…) channels; never DMs (D…). */
export const SLACK_READ_CHANNEL_ID = /^[CG][A-Z0-9]{1,20}$/
/** Normalizes a stored / authored access value; anything unknown collapses to the restricted default. */
export function slackAccessOf(v: unknown): SlackAgentAccess & { readChannels: string[] } {
  if (!v || typeof v !== 'object') return { fullPermissions: false, secretNames: [], readChannels: [] }
  const a = v as Record<string, unknown>
  const names = Array.isArray(a.secretNames) ? a.secretNames : []
  const reads = Array.isArray(a.readChannels) ? a.readChannels : []
  return {
    fullPermissions: a.fullPermissions === true,
    secretNames: [...new Set(names.filter((n): n is string => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n)))].slice(0, 50),
    readChannels: [...new Set(reads.filter((c): c is string => typeof c === 'string' && SLACK_READ_CHANNEL_ID.test(c)))].slice(0, 50)
  }
}
/**
 * Placement is fixed (channels: in the triggering thread; DMs: top-level, PO-S4) and one auto-post per run is fixed
 * (PO-S3b), so neither is a setting.
 */
export interface SlackReplyPolicy {
  mode: SlackReplyMode
  /**
   * Channel ids plus the literal 'dm' for DMs with the bot. Required non-empty for 'auto'. The literal '*' allows any
   * conversation the trigger fires in; only for triggers on mention / DM (someone addressed @hive directly).
   */
  autoChannels: string[]
  /** Node whose final output becomes the reply. Default on create: the workflow's last agent node (PO-S10). null = tools only. */
  replyNode: string | null
}
export type SlackTriggerOn = 'mention' | 'dm' | 'message'
export type SlackTriggerAction = 'run' | 'task'
export interface SlackTriggerMatch {
  on: SlackTriggerOn[]
  channels: string[]
  keywords: string[]
  regex: string | null
  fromUsers: string[]
  /**
   * Who can trigger. Absent / false (the default): full workspace members only; guests, Slack Connect externals,
   * deactivated and unknown users never trigger (a person named in `fromUsers` is always allowed: naming them is the
   * opt-in). true: anyone who can post where @hive listens, including guests and people from other organizations.
   * Auto replies with `allowGuests` need a `fromUsers` list (autoModeProblem).
   */
  allowGuests?: boolean
  /**
   * Fallback: fires only when no other enabled, non-fallback trigger matched the message (the built-in "Reply when
   * tagged" responder). Specific workflows win; the fallback covers every other mention / DM.
   */
  fallback?: boolean
}
export interface SlackTriggerLimits {
  /** Default 3 when on ⊆ {mention, dm}, else 15; 0..600. */
  debounceSec: number
  /** Default 4, 1..30. */
  maxRunsPerThreadPerHour: number
}
export interface SlackTriggerInput {
  name: string
  workflowId: Id
  enabled?: boolean
  match: SlackTriggerMatch
  /** replyNode may be omitted: it then defaults to the workflow's last agent node (PO-S10). */
  reply: Omit<SlackReplyPolicy, 'replyNode'> & { replyNode?: string | null }
  limits?: Partial<SlackTriggerLimits>
  inputs?: Record<string, string>
  /** Absent = restricted, no keys (SA2). */
  access?: SlackAgentAccess
  /**
   * DEPARTMENTS.md §8: 'run' (default) starts the workflow; 'task' creates a board task (source 'slack', one per thread,
   * later thread messages become comments plus a coalesced wake).
   */
  action?: SlackTriggerAction
  /** DEPARTMENTS.md §8: slack_triggers.department_id; a task-mode trigger routes its tasks here. */
  departmentId?: Id | null
}
export interface SlackTrigger {
  id: Id
  name: string
  workflowId: Id
  enabled: boolean
  match: SlackTriggerMatch
  reply: SlackReplyPolicy
  limits: SlackTriggerLimits
  inputs: Record<string, string>
  /** SA2: restricted by default. Older rows read as restricted. */
  access: SlackAgentAccess
  /** Absent = 'run'. */
  action?: SlackTriggerAction
  departmentId?: Id | null
  origin: WorkflowOrigin | null
  createdAt: ISODate
  updatedAt: ISODate
  /** "When @hive is mentioned in #support · replies as drafts" */
  sentence: string
  lastFiredAt: ISODate | null
  lastRunId: Id | null
  lastRunStatus: RunStatus | null
  /** Set when the trigger cannot run, e.g. "Slack disconnected" / "Connect Slack to enable". */
  note?: string | null
}
export type SlackTriggerEventKind =
  | 'fired'
  | 'debounced'
  | 'coalesced'
  | 'skipped_own'
  | 'skipped_bot'
  | 'skipped_limit'
  | 'skipped_stale'
  | 'skipped_paused'
  | 'error'
export interface SlackTriggerEvent {
  id: Id
  triggerId: Id
  kind: SlackTriggerEventKind
  channelId: string | null
  threadTs: string | null
  ts: string | null
  runId: Id | null
  message: string | null
  createdAt: ISODate
}
export interface SlackTriggerTestResult {
  fires: boolean
  reasons: string[]
  inputs: Record<string, string>
}

/** Persisted on the Run (runs.slack_json). */
export interface SlackRunContext {
  triggerId: Id
  teamId: string
  channelId: string
  channelName: string
  channelKind: SlackChannelKind
  /** Channels: thread_ts ?? ts of the triggering message. DMs: the newest batched ts (replies go top-level, PO-S4). */
  threadTs: string
  messageTs: string[]
  userId: string
  userName: string
  text: string
  permalink: string
  isMention: boolean
  isDm: boolean
  catchup: boolean
  /** SA2: the trigger's access at fire time. Absent (older runs) = restricted, no keys. */
  access?: SlackAgentAccess
}
/** Main -> engine, live only (never backfill). */
export interface SlackInboundMessage {
  teamId: string
  channelId: string
  channelKind: SlackChannelKind
  channelName: string
  ts: string
  threadTs: string | null
  userId: string | null
  userName: string | null
  botId: string | null
  subtype: string | null
  plain: string
  isMention: boolean
  isDmToBot: boolean
  /** bot user, bot id, hive_ref or hive_post metadata */
  isOwn: boolean
  fromBot: boolean
  eventTime: number /* epoch s */
  receivedAt: number /* epoch ms */
  source: 'event' | 'gapfill'
  catchup: boolean
  /**
   * Who wrote it, from slack_users + the event's user_team: 'member' (full member of the connected workspace),
   * 'guest' (multi- or single-channel guest), 'external' (Slack Connect: another organization), 'deleted'
   * (deactivated), 'unknown' (could not be resolved). Absent = 'unknown'. Only 'member' passes the default gate
   * (slackAuthorProblem).
   */
  author?: SlackAuthorKind
}
export type SlackAuthorKind = 'member' | 'guest' | 'external' | 'deleted' | 'unknown'

/** Classifies a message author. Pure; `userTeam` is the event's `user_team` when Slack sent one. */
export function slackAuthorKind(
  user: Pick<SlackUser, 'deleted' | 'restricted' | 'ultraRestricted' | 'homeTeamId' | 'enterpriseId'> | null | undefined,
  ws: { teamId: string; enterpriseId?: string | null },
  userTeam?: string | null
): SlackAuthorKind {
  const sameOrg = (team: string | null | undefined, ent: string | null | undefined): boolean =>
    !team || team === ws.teamId || (!!ws.enterpriseId && (team === ws.enterpriseId || ent === ws.enterpriseId))
  if (userTeam && !sameOrg(userTeam, null)) return 'external'
  if (!user) return 'unknown'
  if (user.deleted) return 'deleted'
  if (!sameOrg(user.homeTeamId, user.enterpriseId)) return 'external'
  if (user.restricted || user.ultraRestricted) return 'guest'
  return 'member'
}

const AUTHOR_LABEL: Record<Exclude<SlackAuthorKind, 'member'>, string> = {
  guest: 'a guest',
  external: 'someone from another organization (Slack Connect)',
  deleted: 'a deactivated user',
  unknown: 'someone Hive could not identify'
}

/**
 * The "who can trigger" gate (default members only). null = allowed. A user listed in `fromUsers` is always allowed.
 * Messages without `author` are treated as 'unknown' (fail closed).
 */
export function slackAuthorProblem(match: Pick<SlackTriggerMatch, 'fromUsers' | 'allowGuests'>, m: Pick<SlackInboundMessage, 'userId' | 'author'>): string | null {
  const kind = m.author ?? 'unknown'
  if (kind === 'member') return null
  if (m.userId && match.fromUsers.includes(m.userId)) return null
  if (match.allowGuests && kind !== 'deleted') return null
  return `From ${AUTHOR_LABEL[kind]}: this trigger is for workspace members only`
}

/** Plain "who can trigger this" line for the trigger editor and the authoring approval card. */
export function slackWhoCanTrigger(match: Pick<SlackTriggerMatch, 'fromUsers' | 'allowGuests'>): string {
  const n = match.fromUsers.length
  if (n) return `Only ${n === 1 ? '1 chosen person' : `${n} chosen people`} can trigger this`
  if (match.allowGuests) return 'Anyone who can post there can trigger this, including guests and people from other organizations'
  return 'Workspace members can trigger this (not guests or people from other organizations)'
}
export type NotifySlackTarget = { kind: 'me' } | { kind: 'channel'; channel: string }

export const SLACK_TOOLS = ['slack_list_channels', 'slack_read_thread', 'slack_search', 'slack_draft_reply', 'slack_post'] as const
export type SlackTool = (typeof SLACK_TOOLS)[number]
/**
 * SLACK.md §11.4: the `work` toolset, listed only for agent steps of Slack-triggered runs: pick a repo and start an
 * interactive Principia session there with the thread as context (main enforces the trigger, policy and company).
 */
export const SLACK_WORK_TOOLS = ['principia_repos', 'principia_start_session'] as const
export type SlackWorkTool = (typeof SLACK_WORK_TOOLS)[number]
/** Exactly the manifest's bot scopes (SLACK.md §3.1, PO-S2). */
export const SLACK_REQUIRED_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'channels:join',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'chat:write',
  'users:read',
  'reactions:read',
  'files:read'
] as const
export const SLACK_BOT_EVENTS = ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'member_joined_channel'] as const

/** PO-S3 hard anti-spam floor: not settings, cannot be raised. */
export const SLACK_AUTO_LIMITS = {
  perChannelPerHour: 6,
  perRun: 1,
  maxUserMentions: 3,
  /** Fixed per trigger (PO-S9). */
  runsPerTriggerPerHour: 30
} as const

/** The DM thread key (PO-S4): a DM conversation is one thread. */
export const dmThreadKey = (channelId: string): string => `dm:${channelId}`

/**
 * PO-S3c: auto needs on ⊆ {mention, dm}, or `message` with ≥ 1 of keywords / regex / fromUsers. Auto with
 * `allowGuests` also needs fromUsers (members-only or named people). null = allowed.
 */
export function autoModeProblem(match: Pick<SlackTriggerMatch, 'on' | 'keywords' | 'regex' | 'fromUsers' | 'allowGuests'>): string | null {
  // auto replies to guests / other organizations only for an explicit list of people
  if (match.allowGuests && !match.fromUsers.length) return 'Auto replies need a list of people when guests and other organizations can trigger; keep it to workspace members or pick people'
  if (!match.on.includes('message')) return null
  if (match.keywords.length || (match.regex ?? '').trim() || match.fromUsers.length) return null
  return 'Auto replies on "any message" need at least one keyword, regex or person filter'
}

/** PO-S9 defaults: 3 s for mention/DM triggers, 15 s when `message` is included. */
export const defaultDebounceSec = (on: SlackTriggerOn[]): number => (on.includes('message') ? 15 : 3)
