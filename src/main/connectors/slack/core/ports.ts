/**
 * Slack connector ports (SLACK.md §2.2, PO-S5). Everything the core touches goes through these interfaces, so the core
 * can move unchanged into a future "Hive Core" daemon or server: a cloud build writes a new SlackStore, SecretPort and
 * AskPort and nothing else. NO electron, NO better-sqlite3, NO node:fs anywhere under core/ (purity.test.ts).
 */
import type {
  SlackChannel,
  SlackChannelKind,
  SlackDraftReason,
  SlackDraftStatus,
  SlackInboundMessage,
  SlackMessage,
  SlackSearchHit,
  SlackSearchQuery,
  SlackStatus,
  SlackUser
} from '../../../../shared/slack'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}
export interface Logger {
  info(m: string, meta?: object): void
  warn(m: string, meta?: object): void
  error(m: string, meta?: object): void
}

export type SecretName = 'bot_token' | 'app_token'
/** Tokens. Desktop: connector_secrets + safeStorage. Cloud: KMS / secret manager. Never returns tokens outside core. */
export interface SecretPort {
  get(name: SecretName): Promise<string | null>
  /** Throws HiveError('vault_unavailable') when encryption is unavailable (never a plaintext fallback). */
  set(name: SecretName, value: string): Promise<void>
  clear(): Promise<void>
  /** Masked forms for status ("xoxb-…a1b2"); null when unset. */
  masked(): Promise<{ bot: string | null; app: string | null }>
}

/** Who a draft belongs to (the caller identity main resolved from the live dir, never from tool args). */
export interface SlackDraftOwner {
  kind: 'session' | 'step' | 'run'
  sessionId: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  triggerId: string | null
  label: string
}

/** Human approval surface. Desktop: live-hub Asks. Cloud: whatever UI the server has. */
export interface AskPort {
  open(a: { draftId: string; title: string; question: string; owner: SlackDraftOwner }): Promise<string | null /* askId */>
  close(askId: string, outcome: 'answered' | 'cancelled', answer?: { optionId: 'send' | 'discard'; message?: string | null }): Promise<void>
}

export interface HttpResponse {
  status: number
  headers: { retryAfter: number | null; scopes: string | null }
  body: unknown
}
export interface HttpPort {
  /** POST https://slack.com/api/<method>. */
  call(req: { method: string; token: string; body: Record<string, unknown>; json?: boolean; signal?: AbortSignal }): Promise<HttpResponse>
}
export interface SocketLike {
  send(text: string): void
  close(code?: number, reason?: string): void
  ping(): void
  on(ev: 'open' | 'pong' | 'ping', cb: () => void): void
  on(ev: 'message', cb: (text: string) => void): void
  on(ev: 'close', cb: (code: number, reason: string) => void): void
  on(ev: 'error', cb: (e: Error) => void): void
}
export interface SocketPort {
  open(url: string): SocketLike
}

export interface ConnectorEvents {
  status(s: SlackStatus): void
  /** After persist. */
  messages(batch: { teamId: string; channelId: string; messages: SlackMessage[] }): void
  channels(list: SlackChannel[]): void
  /** Live inbound user-visible messages for trigger matching (source 'event' or a fresh 'gapfill'). */
  inbound(m: SlackInboundMessage): void
  /** PO-S1: the first human DM while no alert user is set. */
  alertSuggestion?(s: { userId: string; name: string }): void
  /** A draft row changed (created, decided, sent, failed, expired). */
  draft?(d: SlackDraftRow): void
  /** Connector entered `error` (token revoked, link disabled). Main coalesces the Mac notification. */
  fatal?(message: string): void
}

/** The few settings the core reads (re-read at every use). */
export interface SettingsPort {
  backfillDays(): number
  triggerCatchupMin(): number
  autoPaused(): boolean
  alertUserId(): string | null
}

// ---------- rows ----------
export type MessageSource = 'backfill' | 'event' | 'gapfill' | 'fetch' | 'post'

export interface SlackWorkspace {
  teamId: string
  teamName: string
  domain: string | null
  url: string | null
  enterpriseId: string | null
  appId: string | null
  botUserId: string
  botId: string
  scopes: string[]
  connectedAt: string
  updatedAt: string
}
export interface SlackChannelRow {
  id: string
  kind: SlackChannelKind
  name: string
  dmUserId: string | null
  topic: string | null
  purpose: string | null
  isMember: boolean
  isArchived: boolean
  memberCount: number | null
  lastMessageTs: string | null
}
export interface SlackMessageRow {
  channelId: string
  ts: string
  threadTs: string | null
  userId: string | null
  botId: string | null
  subtype: string | null
  text: string
  plain: string
  files: SlackMessage['files']
  reactions: SlackMessage['reactions'] | null
  replyCount: number | null
  latestReply: string | null
  replyUsers: string[] | null
  editedTs: string | null
  hiveRef: string | null
}
export interface SyncState {
  teamId: string
  channelId: string
  backfillStatus: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  backfillDays: number
  backfillOldestTs: string | null
  backfillCursor: string | null
  latestTs: string | null
  error: string | null
}
export interface ThreadSync {
  teamId: string
  channelId: string
  threadTs: string
  syncedThroughTs: string | null
  fetchedAt: string | null
  status: 'pending' | 'done' | 'error'
}
export type OutboxPurpose = 'reply' | 'auto' | 'notify' | 'mirror'
export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown'
export interface OutboxRow {
  id: string
  purpose: OutboxPurpose
  teamId: string
  channelId: string
  threadTs: string | null
  threadKey: string | null
  text: string
  draftId: string | null
  runId: string | null
  stepId: string | null
  status: OutboxStatus
  attempts: number
  ts: string | null
  error: string | null
  createdAt: string
  sentAt: string | null
}
export interface SlackDraftRow {
  id: string
  status: SlackDraftStatus
  teamId: string
  channelId: string
  threadTs: string | null
  text: string
  originalText: string
  edited: boolean
  reason: SlackDraftReason
  owner: SlackDraftOwner
  note: string | null
  askId: string | null
  outboxId: string | null
  sentTs: string | null
  error: string | null
  createdAt: string
  decidedAt: string | null
  expiresAt: string
}

type P<T> = Promise<T>
/** Repository functions. ALL async (PO-S5): desktop wraps better-sqlite3 in resolved Promises; cloud uses a pool. */
export interface SlackStore {
  getWorkspace(): P<SlackWorkspace | null>
  saveWorkspace(w: SlackWorkspace): P<void>
  clearAll(opts: { keepMessages: boolean }): P<void>
  upsertUsers(teamId: string, u: SlackUser[]): P<void>
  getUser(teamId: string, id: string): P<SlackUser | null>
  listUsers(teamId: string): P<SlackUser[]>
  upsertChannels(teamId: string, c: SlackChannelRow[]): P<void>
  setMember(teamId: string, channelId: string, isMember: boolean): P<void>
  listChannels(teamId: string): P<SlackChannel[]>
  getChannel(teamId: string, id: string): P<SlackChannel | null>
  upsertMessages(teamId: string, m: SlackMessageRow[], source: MessageSource): P<{ inserted: number; updated: number }>
  /** Thread bookkeeping for a reply that arrived live: parent's reply_count / latest_reply. */
  bumpParent(teamId: string, channelId: string, threadTs: string, replyTs: string, userId: string | null): P<void>
  /** Tombstone; a thread reply also lowers its parent's reply_count. Returns the parent ts for a reply. */
  markDeleted(teamId: string, channelId: string, ts: string): P<{ parentTs: string | null }>
  getMessage(teamId: string, channelId: string, ts: string): P<SlackMessage | null>
  getMessages(q: { teamId: string; channelId: string; beforeTs?: string; limit: number }): P<SlackMessage[]>
  getThread(q: { teamId: string; channelId: string; threadTs: string; limit: number }): P<SlackMessage[]>
  search(q: SlackSearchQuery & { teamId: string }): P<SlackSearchHit[]>
  /** dedupe: false when event_id was already recorded (INSERT OR IGNORE of (event_id, received_at)). */
  recordEvent(eventId: string): P<boolean>
  /** Releases an event_id whose ingest failed, so a redelivery or Hive's own re-ingest is processed. */
  forgetEvent(eventId: string): P<void>
  /** Trigger-matching dedupe per (team, channel, ts): true the first time only (survives restarts, shared by instances). */
  claimInbound(teamId: string, channelId: string, ts: string): P<boolean>
  getSyncState(teamId: string, channelId: string): P<SyncState | null>
  putSyncState(s: SyncState): P<void>
  getThreadSync(teamId: string, channelId: string, threadTs: string): P<ThreadSync | null>
  putThreadSync(s: ThreadSync): P<void>
  /** Thread jobs not finished yet (backfill resumes them). */
  pendingThreads(teamId: string): P<ThreadSync[]>
  /** Channels' sync rows (backfill progress, gap-fill anchors). */
  listSyncStates(teamId: string): P<SyncState[]>
  outbox: {
    insert(o: OutboxRow): P<void>
    update(id: string, p: Partial<OutboxRow>): P<OutboxRow>
    get(id: string): P<OutboxRow | null>
    /** Rows in queued | sending (crash recovery). */
    pending(): P<OutboxRow[]>
  }
  drafts: {
    insert(d: SlackDraftRow): P<void>
    update(id: string, p: Partial<SlackDraftRow>): P<SlackDraftRow>
    get(id: string): P<SlackDraftRow | null>
    list(q: { status?: SlackDraftStatus[]; channelId?: string; threadTs?: string; runId?: string; limit?: number }): P<SlackDraftRow[]>
    /** Pending drafts past expires_at. */
    expired(nowIso: string): P<SlackDraftRow[]>
    /** Pending drafts of one owner (5-per-owner cap). */
    pendingForOwner(owner: { sessionId?: string | null; stepId?: string | null }): P<number>
    /** Drafts + posts a run made itself (reply binding skips when > 0). */
    countForRun(runId: string): P<number>
  }
  /** Auto-post counters for the PO-S3 floor (rolling window), read from slack_outbox purpose 'auto' (not failed). */
  /** withNotify: also count notify-node posts (purpose 'notify'), for the per-channel floor. */
  autoPostsSince(q: { teamId: string; channelId?: string; threadKey?: string; runId?: string; sinceMs: number; withNotify?: boolean }): P<number>
  /** Notify-node posts (outbox purpose 'notify', not failed) since a time, optionally for one run (alert rate guard). */
  notifyPostsSince(q: { runId?: string | null; sinceMs: number }): P<number>
  pruneOld(nowMs: number, opts: { backfillDays: number }): P<void>
}
