/**
 * SlackConnector (SLACK.md §2-§8): lifecycle + state machine + wiring of socket, API, limiter, sync, ingest, outbox,
 * policy and drafts. Pure TS on injected ports (no Electron, no SQLite, no fs): it moves unchanged to a server.
 *
 * Envelope path (PO-S8): dedupe by event_id -> local ingest -> ack (always, even if ingest throws) -> events. A failed
 * ingest releases its event_id and is retried locally, then fetched from Slack (reingest).
 * One socket (PO-S6): warning / refresh_requested / close -> reconnect at once (attempt 0) + gap-fill.
 */
import { HiveError } from '../../../../shared/errors'
import { SLACK_AUTO_LIMITS, slackAuthorKind, type SlackChannel, type SlackChannelKind, type SlackInboundMessage, type SlackMessage, type SlackStatus, type SlackTestResult } from '../../../../shared/slack'
import { SlackApi, SlackApiError, AUTH_ERRORS } from './api'
import { SlackDrafts } from './drafts'
import { fallbackPermalink, maskTokens, tsCmp, tsToMs, userMentions } from './format'
import { CONTENT_SUBTYPES, classifyEvent, isOwnMessage, kindFromChannelType, userLabel } from './ingest'
import { Limiter } from './limiter'
import { REQUIRED_SCOPES } from './manifest'
import { Outbox, OutboxError } from './outbox'
import { decideReply, inRunConversation, outsideRunConversation, policyCounters, threadKeyFor, type ReplyCaller, type ReplyDecision } from './policy'
import type {
  AskPort,
  Clock,
  ConnectorEvents,
  HttpPort,
  Logger,
  SecretPort,
  SettingsPort,
  SlackDraftOwner,
  SlackDraftRow,
  SlackMessageRow,
  SlackStore,
  SlackWorkspace,
  SocketPort
} from './ports'
import { SocketConn, type CloseCause } from './socket'
import { NameCache, SlackSync } from './sync'
import { eventSchema, idOf, type WireEnvelope } from './types'

export const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{20,}$/
export const APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{20,}$/
const HEALTHY_RESET_MS = 120_000
const MAX_BACKOFF_MS = 60_000
const ACK_WARN_MS = 500
const REINGEST_DELAYS_MS = [1000, 5000, 30_000]
const PERMANENT = new Set([...AUTH_ERRORS, 'link_disabled', 'missing_scope', 'not_allowed_token_type'])

export interface ConnectorDeps {
  store: SlackStore
  secrets: SecretPort
  http: HttpPort
  socket: SocketPort
  asks: AskPort
  clock: Clock
  log: Logger
  events: ConnectorEvents
  settings: SettingsPort
  /** Vault redaction (agents, posts, logs). */
  redact(s: string): string
  newId(kind: 'slackDraft' | 'slackOutbox'): string
  random?: () => number
  /** Dev fake build marker for status. */
  fake?: boolean
}

export interface ValidatedTokens {
  bot: string
  app: string
  auth: { teamId: string; team: string; url: string | null; userId: string; botId: string; enterpriseId: string | null }
  scopes: string[]
  missingScopes: string[]
  socketUrl: string
}

export type ReplyResult =
  | { status: 'posted'; ts: string; channelId: string; outboxId: string }
  | { status: 'drafted'; draftId: string; reason: string }
  | { status: 'refused'; reason: string }

const ownerOf = (caller: ReplyCaller, label: string, agentId: string | null): SlackDraftOwner =>
  caller.kind === 'session'
    ? { kind: 'session', sessionId: caller.sessionId, runId: null, stepId: null, agentId, triggerId: null, label }
    : { kind: caller.stepId ? 'step' : 'run', sessionId: null, runId: caller.runId, stepId: caller.stepId, agentId, triggerId: caller.trigger?.id ?? caller.ctx?.triggerId ?? null, label }

export class SlackConnector {
  readonly limiter: Limiter
  readonly api: SlackApi
  readonly names = new NameCache()
  readonly sync: SlackSync
  readonly outbox: Outbox
  readonly drafts: SlackDrafts

  private ws: SlackWorkspace | null = null
  private tokens: { bot: string | null; app: string | null } = { bot: null, app: null }
  private masked: { bot: string | null; app: string | null } = { bot: null, app: null }
  private conn: SocketConn | null = null
  private state: SlackStatus['state'] = 'disabled'
  private error: string | null = null
  private since: number | null = null
  private nextRetryAt: number | null = null
  private retryTimer: unknown = null
  private healthyTimer: unknown = null
  private attempt = 0
  private numConnections = 1
  private lastEventAt: number | null = null
  private everConnected = false
  private gapPending = false
  private stopping = false
  private connecting = false
  private suggestion: { userId: string; name: string } | null = null
  private suggested = false
  private warnedTypes = new Set<string>()
  private dmCache = new Map<string, string>()
  private permalinks = new Map<string, string>()
  private replyChain: Promise<unknown> = Promise.resolve()
  private lastStatusJson = ''
  private ingestFault: ((e: unknown) => void) | null = null

  constructor(private d: ConnectorDeps) {
    this.limiter = new Limiter(d.clock)
    this.api = new SlackApi({ http: d.http, limiter: this.limiter, clock: d.clock, log: d.log, token: (k) => this.token(k), random: d.random })
    this.api.onAuthError = (e) => this.fail(`Slack rejected the token (${e.slack}). Reconnect in Settings › Connections.`)
    this.sync = new SlackSync({
      api: this.api,
      store: d.store,
      clock: d.clock,
      log: d.log,
      settings: d.settings,
      names: this.names,
      ws: () => this.ws,
      emitMessages: (channelId, messages) => this.ws && d.events.messages({ teamId: this.ws.teamId, channelId, messages }),
      emitChannels: (list) => d.events.channels(list),
      inbound: (row, o) => void this.emitInbound(row, { source: o.source, catchup: o.catchup, isMention: o.isMention, eventTime: tsToMs(row.ts) / 1000 }),
      progress: () => this.emitStatus()
    })
    this.outbox = new Outbox({
      store: d.store,
      api: this.api,
      clock: d.clock,
      log: d.log,
      redact: d.redact,
      workspace: () => this.ws,
      newId: () => d.newId('slackOutbox'),
      resolver: this.names,
      channelLabel: (id) => this.channelLabel(id)
    })
    this.drafts = new SlackDrafts({
      store: d.store,
      asks: d.asks,
      outbox: this.outbox,
      clock: d.clock,
      log: d.log,
      newId: () => d.newId('slackDraft'),
      redact: d.redact,
      workspace: () => this.ws,
      title: (id) => this.draftTitle(id),
      emit: (row) => d.events.draft?.(row)
    })
  }

  // ---------- small helpers ----------
  private iso(ms: number | null): string | null {
    return ms == null ? null : new Date(ms).toISOString()
  }
  private async token(kind: 'bot' | 'app'): Promise<string | null> {
    if (!this.tokens[kind]) this.tokens[kind] = await this.d.secrets.get(kind === 'bot' ? 'bot_token' : 'app_token')
    return this.tokens[kind]
  }
  workspace(): SlackWorkspace | null {
    return this.ws
  }
  isConnected(): boolean {
    return this.state === 'connected'
  }
  /** Tokens saved (state is not `disabled`). */
  isConfigured(): boolean {
    return this.state !== 'disabled'
  }
  channelLabel(id: string): string {
    const n = this.names.channel(id)
    return n ? (id.startsWith('D') ? `the DM with ${n}` : `#${n}`) : id
  }
  private draftTitle(id: string): string {
    const n = this.names.channel(id)
    if (id.startsWith('D')) return `Reply to ${n ?? 'a DM'} (DM)`
    return `Reply in #${n ?? id}`
  }
  /** For tests: make the next ingest throw. */
  injectIngestFault(fn: ((e: unknown) => void) | null): void {
    this.ingestFault = fn
  }

  // ---------- status ----------
  status(): SlackStatus {
    const rl = this.limiter.rateLimited()
    const warnings: string[] = []
    const missing = this.ws ? REQUIRED_SCOPES.filter((s) => !this.ws!.scopes.includes(s)) : []
    if (missing.length) warnings.push(`Reinstall the app: missing ${missing.join(', ')}`)
    if (this.numConnections > 1) warnings.push('Another Hive is connected with this Slack app; events are split between them')
    if (rl) warnings.push(`Slack asked Hive to slow down (${rl.method.split('.').pop()}) · resumes ${new Date(rl.until).toISOString()}`)
    const p = this.sync.progress
    return {
      state: this.state,
      error: this.error,
      warnings,
      since: this.iso(this.since),
      nextRetryAt: this.iso(this.nextRetryAt),
      lastEventAt: this.iso(this.lastEventAt),
      workspace: this.ws ? { teamId: this.ws.teamId, name: this.ws.teamName, domain: this.ws.domain, botUserId: this.ws.botUserId, botName: 'hive' } : null,
      tokens: { ...this.masked },
      missingScopes: missing,
      sync: { state: p.state, channelsDone: p.channelsDone, channelsTotal: p.channelsTotal, threadsPending: p.threadsPending, rateLimitedUntil: rl ? this.iso(rl.until) : null, days: p.days },
      alertSuggestion: this.d.settings.alertUserId() ? null : this.suggestion,
      ...(this.d.fake ? { fake: true } : {})
    }
  }
  private emitStatus(): void {
    const s = this.status()
    const j = JSON.stringify(s)
    if (j === this.lastStatusJson) return
    this.lastStatusJson = j
    this.d.events.status(s)
  }
  private setState(s: SlackStatus['state'], error: string | null = null): void {
    if (this.state !== s) this.since = this.d.clock.now()
    this.state = s
    this.error = error
    this.emitStatus()
  }

  // ---------- lifecycle ----------
  /** Boot: connects only when both tokens exist. With no tokens Hive makes zero requests. */
  async start(): Promise<void> {
    this.stopping = false
    this.sync.restart()
    this.ws = await this.d.store.getWorkspace()
    const bot = await this.token('bot')
    const app = await this.token('app')
    this.masked = await this.d.secrets.masked()
    if (!bot || !app || !this.ws) {
      this.setState('disabled')
      return
    }
    await this.sync.warm()
    this.attempt = 0
    void this.connect(null)
  }

  /** Quit: close with 1000, no retries. */
  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    this.sync.stop()
    this.conn?.close(1000, 'quit')
    this.conn = null
    this.limiter.reset()
  }

  /** powerMonitor suspend: close with 1000, no retries. */
  pause(): void {
    if (this.state === 'disabled' || this.state === 'error') return
    this.clearTimers()
    this.gapPending = true
    const c = this.conn
    this.conn = null
    c?.close(1000, 'sleep')
    this.setState('paused')
  }

  /** wake / network change: close any (probably half-open) socket, connect at once, then gap-fill. */
  resume(reason: 'wake' | 'network' | 'retry' = 'wake'): void {
    if (this.state === 'disabled' || this.stopping) return
    // permanent errors never retry on their own: only "Retry now" or new tokens
    if (this.state === 'error' && reason !== 'retry') return
    this.clearTimers()
    const c = this.conn
    this.conn = null
    c?.close(1000, 'resume')
    this.gapPending = true
    this.attempt = 0
    this.error = null
    void this.connect(null)
  }

  private clearTimers(): void {
    if (this.retryTimer) this.d.clock.clearTimeout(this.retryTimer)
    if (this.healthyTimer) this.d.clock.clearTimeout(this.healthyTimer)
    this.retryTimer = this.healthyTimer = null
    this.nextRetryAt = null
  }

  private fail(message: string): void {
    this.clearTimers()
    const c = this.conn
    this.conn = null
    c?.close(1000, 'error')
    if (this.state !== 'error') this.d.events.fatal?.(message)
    this.setState('error', message)
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.state === 'paused' || this.state === 'error' || this.state === 'disabled') return
    const cap = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt)
    const delay = Math.floor((this.d.random ?? Math.random)() * cap)
    this.attempt++
    this.nextRetryAt = this.d.clock.now() + delay
    this.setState('reconnecting', this.error)
    this.retryTimer = this.d.clock.setTimeout(() => {
      this.retryTimer = null
      this.nextRetryAt = null
      void this.connect(null)
    }, delay)
  }

  /** Last computed backoff bound (tests). */
  backoffAttempt(): number {
    return this.attempt
  }

  private async connect(url: string | null): Promise<void> {
    if (this.stopping || this.connecting || this.conn) return
    this.connecting = true
    this.setState(this.everConnected ? 'reconnecting' : 'connecting', null)
    let socketUrl = url
    try {
      if (!socketUrl) {
        const { body } = await this.api.call<{ url: string }>('apps.connections.open', {}, { lane: 'interactive', token: 'app' })
        socketUrl = body.url
      }
    } catch (e) {
      this.connecting = false
      if (e instanceof SlackApiError && PERMANENT.has(e.slack)) return this.fail(`Slack rejected the app-level token (${e.slack}). Reconnect in Settings › Connections.`)
      if (e instanceof Error && /stopped/.test(e.message)) return
      this.error = e instanceof Error ? maskTokens(e.message) : String(e)
      return this.scheduleReconnect()
    }
    if (this.stopping || this.state === 'paused') {
      this.connecting = false
      return
    }
    const conn = new SocketConn(this.d.socket, this.d.clock, this.d.log, {
      hello: (h) => this.onHello(conn, h),
      envelope: (env, at) => void this.onEnvelope(conn, env, at),
      disconnectMsg: (reason) => this.onDisconnectMsg(conn, reason),
      closed: (info) => this.onClosed(conn, info)
    })
    this.conn = conn
    this.connecting = false
    try {
      conn.open(socketUrl!)
    } catch (e) {
      this.conn = null
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('slack socket open refused', { e: maskTokens(msg) })
      return this.fail(`Hive refused the Socket Mode URL: ${maskTokens(msg)}`)
    }
  }

  private onHello(conn: SocketConn, h: WireEnvelope): void {
    if (this.conn !== conn) return
    this.numConnections = h.num_connections ?? 1
    const appId = h.connection_info?.app_id ?? null
    if (appId && this.ws && !this.ws.appId) {
      this.ws = { ...this.ws, appId }
      void this.d.store.saveWorkspace(this.ws)
    }
    const first = !this.everConnected
    this.everConnected = true
    this.setState('connected')
    this.healthyTimer = this.d.clock.setTimeout(() => {
      this.attempt = 0
      this.healthyTimer = null
    }, HEALTHY_RESET_MS)
    if (first) void this.afterFirstConnect()
    else if (this.gapPending) {
      this.gapPending = false
      void this.sync.gapFill().catch((e) => this.d.log.warn('slack gap-fill failed', { e: String(e) }))
    }
  }

  private async afterFirstConnect(): Promise<void> {
    try {
      await this.outbox.recover()
      await this.sync.refreshUsers()
      await this.sync.refreshChannels()
      if (this.gapPending) {
        this.gapPending = false
        await this.sync.gapFill()
      }
      void this.sync.backfill()
    } catch (e) {
      if (!(e instanceof Error && /stopped/.test(e.message))) this.d.log.warn('slack initial sync failed', { e: e instanceof Error ? e.message : String(e) })
    }
  }

  private onDisconnectMsg(conn: SocketConn, reason: string): void {
    if (this.conn !== conn) return
    if (reason === 'link_disabled') {
      this.conn = null
      conn.close(1000, 'link_disabled')
      return this.fail('Socket Mode is turned off for this app. Turn it on in the app’s settings, then Retry.')
    }
    // warning / refresh_requested: one socket, reconnect at once (PO-S6)
    this.conn = null
    this.gapPending = true
    this.attempt = 0
    conn.close(1000, reason)
    void this.connect(null)
  }

  private onClosed(conn: SocketConn, info: { code: number; reason: string; cause: CloseCause }): void {
    if (this.healthyTimer) this.d.clock.clearTimeout(this.healthyTimer)
    this.healthyTimer = null
    if (this.conn !== conn) return
    this.conn = null
    if (this.stopping || this.state === 'paused' || this.state === 'error') return
    this.gapPending = true
    this.error = info.cause === 'remote' ? null : info.cause.replace('_', ' ')
    this.scheduleReconnect()
  }

  // ---------- envelopes (§4.5) ----------
  private async onEnvelope(conn: SocketConn, env: WireEnvelope, receivedAt: number): Promise<void> {
    const ack = () => {
      if (!env.envelope_id) return
      conn.ack(env.envelope_id)
      const took = this.d.clock.now() - receivedAt
      if (took > ACK_WARN_MS) this.d.log.warn('slack: slow ack', { ms: took })
    }
    if (env.type !== 'events_api') {
      if (!this.warnedTypes.has(env.type)) {
        this.warnedTypes.add(env.type)
        this.d.log.info('slack: envelope type not subscribed in v1; acked', { type: env.type })
      }
      return ack()
    }
    const p = env.payload
    const ws = this.ws
    if (!ws || !p || p.team_id !== ws.teamId || (ws.appId && p.api_app_id && p.api_app_id !== ws.appId)) {
      ack()
      this.d.log.warn('slack: envelope for another workspace or app dropped', { team: p?.team_id ?? null })
      return
    }
    let after: (() => Promise<void>) | null = null
    let failed = false
    const eventTime = p.event_time ?? receivedAt / 1000
    try {
      const fresh = p.event_id ? await this.d.store.recordEvent(p.event_id) : true
      if (fresh) after = await this.ingest(p.event, eventTime, receivedAt)
    } catch (e) {
      failed = true
      this.d.log.error('slack ingest failed; acked, retrying locally', { e: e instanceof Error ? e.message : String(e) })
    }
    ack()
    // The ack means Slack will not redeliver: release the event_id (a redelivery after a lost ack is processed) and
    // re-ingest the payload Hive already holds, then fetch the message itself as a last resort.
    if (failed) void this.reingest(p.event_id ?? null, p.event, eventTime, receivedAt, 0)
    this.lastEventAt = receivedAt
    this.emitStatus()
    if (after) await after().catch((e) => this.d.log.warn('slack post-ack handling failed', { e: String(e) }))
  }

  /** After a failed ingest: re-ingest at 1 s, 5 s, 30 s, then fetch the message from Slack (sync.recoverMessage). */
  private async reingest(eventId: string | null, raw: unknown, eventTime: number, receivedAt: number, attempt: number): Promise<void> {
    if (eventId) await this.d.store.forgetEvent(eventId).catch(() => undefined)
    if (this.stopping) return
    if (attempt >= REINGEST_DELAYS_MS.length) {
      const ev = eventSchema.safeParse(raw)
      const channelId = ev.success ? idOf(ev.data.channel) : null
      const ts = ev.success ? (ev.data.ts ?? null) : null
      if (!channelId || !ts || !ev.success || (ev.data.type !== 'message' && ev.data.type !== 'app_mention')) {
        this.d.log.warn('slack ingest gave up; gap-fill will recover it', { eventId })
        return
      }
      try {
        await this.sync.recoverMessage(channelId, ts, ev.data.thread_ts ?? null)
      } catch (e) {
        this.d.log.warn('slack targeted fetch failed; gap-fill will recover it', { eventId, e: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    await new Promise<void>((r) => this.d.clock.setTimeout(r, REINGEST_DELAYS_MS[attempt]))
    if (this.stopping || !this.ws) return
    let after: (() => Promise<void>) | null = null
    try {
      // a redelivery may have processed it meanwhile
      if (eventId && !(await this.d.store.recordEvent(eventId))) return
      after = await this.ingest(raw, eventTime, receivedAt)
    } catch (e) {
      this.d.log.warn('slack re-ingest failed', { eventId, attempt: attempt + 1, e: e instanceof Error ? e.message : String(e) })
      return this.reingest(eventId, raw, eventTime, receivedAt, attempt + 1)
    }
    if (after) await after().catch((e) => this.d.log.warn('slack post-ack handling failed', { e: String(e) }))
  }

  /** Local ingest. Returns the post-ack work (events, inbound, background lookups). */
  private async ingest(raw: unknown, eventTime: number, receivedAt: number): Promise<(() => Promise<void>) | null> {
    if (this.ingestFault) this.ingestFault(raw)
    const ws = this.ws!
    const parsed = eventSchema.safeParse(raw)
    if (!parsed.success) return null
    const a = classifyEvent(parsed.data, ws, this.names)
    switch (a.kind) {
      case 'ignore':
        return null
      case 'member': {
        if (a.userId !== ws.botUserId) return null
        await this.d.store.setMember(ws.teamId, a.channelId, a.joined)
        return async () => {
          await this.sync.resolveChannel(a.channelId)
          this.d.events.channels(await this.d.store.listChannels(ws.teamId))
          if (a.joined) void this.sync.backfill({ channelId: a.channelId })
        }
      }
      case 'deleted': {
        const { parentTs } = await this.d.store.markDeleted(ws.teamId, a.channelId, a.ts)
        return async () => {
          await this.emitStored(a.channelId, [a.ts, ...(parentTs ? [parentTs] : [])])
          // a deleted reply: Slack's own reply_count comes back with the thread (or a parent message_changed)
          if (parentTs && this.isConnected()) {
            await this.sync.fetchThread(a.channelId, parentTs).catch((e) => this.d.log.warn('slack thread refresh after delete failed', { e: e instanceof Error ? e.message : String(e) }))
          }
        }
      }
      case 'changed':
      case 'replied':
        await this.d.store.upsertMessages(ws.teamId, [a.row], 'event')
        return () => this.emitStored(a.channelId, [a.row.ts])
      case 'upsert': {
        const row = a.row
        await this.d.store.upsertMessages(ws.teamId, [row], 'event')
        if (row.threadTs && row.threadTs !== row.ts) await this.d.store.bumpParent(ws.teamId, a.channelId, row.threadTs, row.ts, row.userId)
        const st = await this.d.store.getSyncState(ws.teamId, a.channelId)
        if (!st?.latestTs || tsCmp(row.ts, st.latestTs) > 0) {
          await this.d.store.putSyncState({
            ...(st ?? { teamId: ws.teamId, channelId: a.channelId, backfillStatus: 'pending', backfillDays: this.d.settings.backfillDays(), backfillOldestTs: null, backfillCursor: null, error: null }),
            latestTs: row.ts
          })
        }
        // bot membership changes from system rows
        if ((row.subtype === 'channel_join' || row.subtype === 'channel_leave') && row.userId === ws.botUserId) {
          await this.d.store.setMember(ws.teamId, a.channelId, row.subtype === 'channel_join')
        }
        return async () => {
          await this.emitStored(a.channelId, [row.ts, ...(row.threadTs && row.threadTs !== row.ts ? [row.threadTs] : [])])
          await this.emitInbound(row, { source: 'event', catchup: false, isMention: a.isMention, eventTime, receivedAt, channelType: a.channelType, userTeam: a.userTeam })
        }
      }
    }
  }

  private async emitStored(channelId: string, tss: string[]): Promise<void> {
    const ws = this.ws
    if (!ws) return
    const msgs = (await Promise.all(tss.map((ts) => this.d.store.getMessage(ws.teamId, channelId, ts)))).filter((m): m is SlackMessage => !!m)
    if (msgs.length) this.d.events.messages({ teamId: ws.teamId, channelId, messages: msgs })
  }

  /** One inbound message per (channel, ts) for trigger matching; plus the PO-S1 alert suggestion. */
  private async emitInbound(
    row: SlackMessageRow,
    o: { source: 'event' | 'gapfill'; catchup: boolean; isMention: boolean; eventTime: number; receivedAt?: number; channelType?: string | null; userTeam?: string | null }
  ): Promise<void> {
    const ws = this.ws
    if (!ws) return
    if (row.subtype && !CONTENT_SUBTYPES.has(row.subtype)) {
      // system rows never reach trigger matching
      return
    }
    const now = this.d.clock.now()
    // one delivery per (channel, ts): app_mention + message, event + gap-fill, before and after a restart (durable)
    if (!(await this.d.store.claimInbound(ws.teamId, row.channelId, row.ts))) return
    let ch: SlackChannel | null = await this.d.store.getChannel(ws.teamId, row.channelId)
    if (!ch) ch = await this.sync.resolveChannel(row.channelId)
    const kind: SlackChannelKind = ch?.kind ?? kindFromChannelType(o.channelType, row.channelId)
    const user = row.userId ? (this.names.users.get(row.userId) ?? (await this.sync.resolveUser(row.userId))) : null
    const isOwn = isOwnMessage(row, ws)
    const fromBot = !isOwn && (!!row.botId || !!user?.isBot || row.subtype === 'bot_message')
    const author = slackAuthorKind(user, ws, o.userTeam ?? null)
    const m: SlackInboundMessage = {
      teamId: ws.teamId,
      channelId: row.channelId,
      channelKind: kind,
      channelName: ch?.name ?? row.channelId,
      ts: row.ts,
      threadTs: row.threadTs,
      userId: row.userId,
      userName: row.userId ? userLabel(user, row.userId) : null,
      botId: row.botId,
      subtype: row.subtype,
      plain: row.plain,
      isMention: o.isMention,
      isDmToBot: kind === 'dm',
      isOwn,
      fromBot,
      eventTime: o.eventTime,
      receivedAt: o.receivedAt ?? now,
      source: o.source,
      catchup: o.catchup,
      author
    }
    // PO-S1: the first human DM while no alert user is set -> one suggestion (members only: never a guest or external)
    if (kind === 'dm' && !isOwn && !fromBot && author === 'member' && row.userId && !this.suggested && !this.d.settings.alertUserId()) {
      this.suggested = true
      this.suggestion = { userId: row.userId, name: m.userName ?? row.userId }
      this.d.events.alertSuggestion?.(this.suggestion)
      this.emitStatus()
    }
    this.d.events.inbound(m)
  }

  // ---------- tokens (§3.3) ----------
  /** Shape checks, auth.test (bot), apps.connections.open (app). Stores nothing. */
  async validateTokens(t: { botToken: string; appToken: string }): Promise<ValidatedTokens> {
    const errors: { path: string; message: string }[] = []
    const bot = t.botToken.trim()
    const app = t.appToken.trim()
    if (!BOT_TOKEN_RE.test(bot)) errors.push({ path: 'botToken', message: 'The Bot User OAuth Token starts with xoxb-' })
    if (!APP_TOKEN_RE.test(app)) errors.push({ path: 'appToken', message: 'The app-level token starts with xapp-' })
    if (errors.length) throw new HiveError('validation', errors.map((e) => e.message).join('; '), errors)
    let auth: ValidatedTokens['auth']
    let scopes: string[] = []
    try {
      const r = await this.api.call<{ team_id: string; team: string; url?: string; user_id: string; bot_id?: string; enterprise_id?: string }>(
        'auth.test',
        {},
        { lane: 'interactive', token: 'bot' },
        bot
      )
      auth = { teamId: r.body.team_id, team: r.body.team, url: r.body.url ?? null, userId: r.body.user_id, botId: r.body.bot_id ?? '', enterpriseId: r.body.enterprise_id ?? null }
      scopes = (r.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } catch (e) {
      const why = e instanceof SlackApiError ? e.slack : e instanceof Error ? maskTokens(e.message) : String(e)
      throw new HiveError('validation', `Bot token: ${why}`, [{ path: 'botToken', message: `Slack said: ${why}` }])
    }
    let socketUrl: string
    try {
      const r = await this.api.call<{ url: string }>('apps.connections.open', {}, { lane: 'interactive', token: 'app' }, app)
      socketUrl = r.body.url
    } catch (e) {
      const why = e instanceof SlackApiError ? e.slack : e instanceof Error ? maskTokens(e.message) : String(e)
      throw new HiveError('validation', `App-level token: ${why}`, [{ path: 'appToken', message: `Slack said: ${why}${why === 'not_allowed_token_type' || why === 'invalid_auth' ? ' (paste the xapp- token with connections:write)' : ''}` }])
    }
    return { bot, app, auth, scopes, missingScopes: REQUIRED_SCOPES.filter((s) => !scopes.includes(s)), socketUrl }
  }

  /** The workspace the stored tokens belong to (team switch confirm). */
  currentTeam(): { teamId: string; name: string } | null {
    return this.ws ? { teamId: this.ws.teamId, name: this.ws.teamName } : null
  }

  /** After validateTokens (and the team-switch confirm): store, save the workspace, start. */
  async commitTokens(v: ValidatedTokens): Promise<SlackStatus> {
    const switching = !!this.ws && this.ws.teamId !== v.auth.teamId
    await this.stop()
    if (switching) {
      await this.d.store.clearAll({ keepMessages: false })
      this.names.users.clear()
      this.names.channels.clear()
    }
    await this.d.secrets.set('bot_token', v.bot)
    await this.d.secrets.set('app_token', v.app)
    const now = new Date(this.d.clock.now()).toISOString()
    const prev = switching ? null : this.ws
    let domain: string | null = null
    try {
      domain = v.auth.url ? new URL(v.auth.url).hostname.split('.')[0] : null
    } catch {
      domain = null
    }
    this.ws = {
      teamId: v.auth.teamId,
      teamName: v.auth.team,
      domain,
      url: v.auth.url,
      enterpriseId: v.auth.enterpriseId,
      appId: prev?.appId ?? null,
      botUserId: v.auth.userId,
      botId: v.auth.botId,
      scopes: v.scopes,
      connectedAt: prev?.connectedAt ?? now,
      updatedAt: now
    }
    await this.d.store.saveWorkspace(this.ws)
    this.tokens = { bot: v.bot, app: v.app }
    this.masked = await this.d.secrets.masked()
    this.stopping = false
    this.sync.restart()
    this.everConnected = false
    this.attempt = 0
    this.error = null
    this.state = 'connecting'
    await this.sync.warm()
    void this.connect(v.socketUrl)
    this.emitStatus()
    return this.status()
  }

  /** validate + commit in one call (no team-switch confirm; the desktop service confirms first). */
  async connectTokens(t: { botToken: string; appToken: string }): Promise<SlackStatus> {
    return this.commitTokens(await this.validateTokens(t))
  }

  /** Re-runs the checklist on the stored tokens. */
  async test(): Promise<SlackTestResult> {
    const bot = await this.token('bot')
    const app = await this.token('app')
    const out: SlackTestResult = { ok: false, botToken: 'not set', appToken: 'not set', socket: this.state === 'connected' ? 'ok' : this.error ?? this.state, scopes: [], missingScopes: [] }
    if (bot) {
      try {
        const r = await this.api.call('auth.test', {}, { lane: 'interactive', token: 'bot' }, bot)
        out.botToken = 'ok'
        out.scopes = (r.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        out.missingScopes = REQUIRED_SCOPES.filter((s) => !out.scopes.includes(s))
      } catch (e) {
        out.botToken = e instanceof SlackApiError ? e.slack : String(e)
      }
    }
    if (app) {
      try {
        await this.api.call('apps.connections.open', {}, { lane: 'interactive', token: 'app' }, app)
        out.appToken = 'ok'
      } catch (e) {
        out.appToken = e instanceof SlackApiError ? e.slack : String(e)
      }
    }
    out.ok = out.botToken === 'ok' && out.appToken === 'ok' && out.socket === 'ok'
    return out
  }

  /** Closes the socket, clears tokens; purge deletes every slack_* row except triggers. */
  async disconnect(purge: boolean): Promise<SlackStatus> {
    await this.stop()
    await this.d.secrets.clear()
    await this.d.store.clearAll({ keepMessages: !purge })
    this.tokens = { bot: null, app: null }
    this.masked = { bot: null, app: null }
    this.ws = purge ? null : await this.d.store.getWorkspace()
    if (purge) {
      this.names.users.clear()
      this.names.channels.clear()
    }
    this.everConnected = false
    this.suggestion = null
    this.setState('disabled')
    return this.status()
  }

  /** "Retry now" (also clears `error` after link_disabled is fixed). */
  retry(): SlackStatus {
    if (this.state === 'disabled') return this.status()
    this.resume('retry')
    return this.status()
  }

  // ---------- reads / helpers used by the service and the tools ----------
  async permalink(channelId: string, ts: string): Promise<string> {
    const key = `${channelId}:${ts}`
    const hit = this.permalinks.get(key)
    if (hit) return hit
    try {
      const { body } = await this.api.call<{ permalink: string }>('chat.getPermalink', { channel: channelId, message_ts: ts }, { lane: 'interactive', token: 'bot' })
      this.permalinks.set(key, body.permalink)
      return body.permalink
    } catch {
      return fallbackPermalink(this.ws?.domain ?? null, channelId, ts)
    }
  }

  /** DM channel id with a user (conversations.open users=<id>), cached. */
  async openDm(userId: string): Promise<string> {
    const hit = this.dmCache.get(userId)
    if (hit) return hit
    const { body } = await this.api.call<{ channel: { id: string } }>('conversations.open', { users: userId }, { lane: 'interactive', token: 'bot' })
    this.dmCache.set(userId, body.channel.id)
    return body.channel.id
  }

  /** conversations.join on an explicit click (never automatic, PO-S2). */
  async join(channelId: string): Promise<SlackChannel | null> {
    const ws = this.ws
    if (!ws) throw new HiveError('conflict', 'Slack is not connected')
    try {
      await this.api.call('conversations.join', { channel: channelId }, { lane: 'interactive', token: 'bot' })
    } catch (e) {
      throw e instanceof SlackApiError ? e.toHive(this.channelLabel(channelId)) : e
    }
    await this.d.store.setMember(ws.teamId, channelId, true)
    void this.sync.backfill({ channelId })
    const list = await this.d.store.listChannels(ws.teamId)
    this.d.events.channels(list)
    return list.find((c) => c.id === channelId) ?? null
  }

  async joinAll(): Promise<{ joined: number; failed: string[] }> {
    const ws = this.ws
    if (!ws) throw new HiveError('conflict', 'Slack is not connected')
    const todo = (await this.d.store.listChannels(ws.teamId)).filter((c) => c.kind === 'channel' && !c.isMember && !c.isArchived)
    let joined = 0
    const failed: string[] = []
    for (const c of todo) {
      try {
        await this.api.call('conversations.join', { channel: c.id }, { lane: 'interactive', token: 'bot' })
        await this.d.store.setMember(ws.teamId, c.id, true)
        joined++
      } catch {
        failed.push(c.name)
      }
    }
    this.d.events.channels(await this.d.store.listChannels(ws.teamId))
    if (joined) void this.sync.backfill()
    return { joined, failed }
  }

  /**
   * `channel` from a tool: id (C/G/D), `#name` or `@handle`. `@handle` opens the DM on demand only for writes.
   */
  async resolveChannelRef(ref: string, opts: { openDm: boolean }): Promise<SlackChannel> {
    const ws = this.ws
    if (!ws) throw new HiveError('conflict', 'Slack is not connected')
    const r = ref.trim()
    const list = await this.d.store.listChannels(ws.teamId)
    if (/^[CGD][A-Z0-9]+$/.test(r)) {
      const c = list.find((x) => x.id === r) ?? (await this.sync.resolveChannel(r))
      if (!c) throw new HiveError('not_found', `No channel ${r}. Invite @hive first or use slack_list_channels.`)
      return c
    }
    if (r.startsWith('#')) {
      const name = r.slice(1).toLowerCase()
      const c = list.find((x) => x.kind !== 'dm' && x.name.toLowerCase() === name)
      if (!c) throw new HiveError('not_found', `No channel #${name}. Invite @hive first or use the id`)
      return c
    }
    const handle = r.replace(/^@/, '').toLowerCase()
    const user = [...this.names.users.values()].find((u) => u.id.toLowerCase() === handle || u.name.toLowerCase() === handle || (u.displayName ?? '').toLowerCase() === handle)
    if (!user) throw new HiveError('not_found', `No Slack user @${handle}`)
    const existing = list.find((x) => x.kind === 'dm' && x.dmUserId === user.id)
    if (existing) return existing
    if (!opts.openDm) throw new HiveError('not_found', `No DM with @${handle} yet`)
    const id = await this.openDm(user.id)
    await this.d.store.upsertChannels(ws.teamId, [{ id, kind: 'dm', name: userLabel(user, user.id), dmUserId: user.id, topic: null, purpose: null, isMember: true, isArchived: false, memberCount: null, lastMessageTs: null }])
    return (await this.d.store.getChannel(ws.teamId, id))!
  }

  // ---------- replies (§8) ----------
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.replyChain.then(fn, fn)
    this.replyChain = run.catch(() => undefined)
    return run
  }

  /** The policy decision alone (tests, tool previews). */
  async decide(caller: ReplyCaller, channel: SlackChannel, threadTs: string | null, text: string): Promise<ReplyDecision> {
    const ws = this.ws
    if (!ws) throw new HiveError('conflict', 'Slack is not connected')
    const ctx = caller.kind === 'step' ? caller.ctx : null
    const key = threadKeyFor(channel.id, channel.kind, ctx?.channelId === channel.id ? ctx.threadTs : threadTs)
    const counters = await policyCounters(this.d.store, { teamId: ws.teamId, runId: caller.kind === 'step' ? caller.runId : null, channelId: channel.id, threadKey: key, nowMs: this.d.clock.now() })
    return decideReply(caller, { channelId: channel.id, channelKind: channel.kind, threadTs }, text, { autoPaused: this.d.settings.autoPaused(), live: this.state === 'connected' }, counters)
  }

  /**
   * slack_post and the post-run reply: §8.2 decides post / draft / refused. Serialized so two concurrent decisions
   * never both pass the counters.
   */
  reply(req: { caller: ReplyCaller; channel: SlackChannel; threadTs: string | null; text: string; ownerLabel: string; agentId: string | null; note?: string | null }): Promise<ReplyResult> {
    return this.locked(async () => {
      const dec = await this.decide(req.caller, req.channel, req.threadTs, req.text)
      if (dec.action === 'refused') return { status: 'refused', reason: dec.reason }
      if (dec.action === 'draft') {
        const row = await this.drafts.create({ owner: ownerOf(req.caller, req.ownerLabel, req.agentId), channelId: req.channel.id, threadTs: req.threadTs, text: req.text, reason: dec.reason, note: req.note ?? null })
        return { status: 'drafted', draftId: row.id, reason: dec.reason }
      }
      const caller = req.caller as Extract<ReplyCaller, { kind: 'step' }>
      try {
        const row = await this.outbox.post({ purpose: 'auto', channelId: req.channel.id, threadTs: dec.threadTs, threadKey: dec.threadKey, text: req.text, runId: caller.runId, stepId: caller.stepId })
        return { status: 'posted', ts: row.ts!, channelId: row.channelId, outboxId: row.id }
      } catch (e) {
        if (e instanceof OutboxError) throw new HiveError('internal', e.message)
        throw e
      }
    })
  }

  /** slack_draft_reply: never posts. `none` mode refuses. */
  async draftReply(req: { caller: ReplyCaller; channel: SlackChannel; threadTs: string | null; text: string; note?: string | null; ownerLabel: string; agentId: string | null }): Promise<ReplyResult> {
    const c = req.caller
    let reason: SlackDraftRow['reason'] = 'interactive'
    if (c.kind === 'step') {
      // a Slack-triggered run drafts only in the conversation that started it (fail closed)
      if (c.ctx && !inRunConversation(c.ctx, { channelId: req.channel.id, threadTs: req.threadTs })) return { status: 'refused', reason: outsideRunConversation(c.ctx) }
      if (!c.ctx || !c.trigger) reason = 'no_trigger'
      else if (c.trigger.reply.mode === 'none') return { status: 'refused', reason: "This workflow's Slack trigger has replies turned off." }
      else reason = 'draft_mode'
    }
    const row = await this.drafts.create({ owner: ownerOf(c, req.ownerLabel, req.agentId), channelId: req.channel.id, threadTs: req.threadTs, text: req.text, reason, note: req.note ?? null })
    return { status: 'drafted', draftId: row.id, reason }
  }

  /**
   * Notify node / Needs-you mirror: DM to a user or a post in a channel (outbox purpose notify | mirror).
   * `floor`: a notify-node post to a channel from a Slack-triggered run goes through the same PO-S3 floor as auto
   * replies (pause switch, 6 automatic posts per channel per hour, 1 per run in that channel, at most 3 @people),
   * serialized with the reply decisions so the two paths never both take the last slot. Over the floor it throws.
   */
  async postAlert(target: { userId: string } | { channelId: string }, text: string, purpose: 'notify' | 'mirror', runId?: string | null, stepId?: string | null, opts: { floor?: boolean } = {}): Promise<string> {
    if (!this.ws || this.state === 'disabled') throw new HiveError('conflict', 'Slack is not connected')
    if (opts.floor && 'channelId' in target) {
      return this.locked(async () => {
        const why = await this.alertFloorProblem(target.channelId, text, runId ?? null)
        if (why) throw new HiveError('conflict', why)
        const row = await this.outbox.post({ purpose, channelId: target.channelId, threadTs: null, text, runId: runId ?? null, stepId: stepId ?? null })
        return row.ts!
      })
    }
    const channelId = 'userId' in target ? await this.openDm(target.userId) : target.channelId
    const row = await this.outbox.post({ purpose, channelId, threadTs: null, text, runId: runId ?? null, stepId: stepId ?? null })
    return row.ts!
  }

  /** The PO-S3 floor for a Slack-triggered run's channel alert; null = allowed. */
  private async alertFloorProblem(channelId: string, text: string, runId: string | null): Promise<string | null> {
    const ws = this.ws
    if (!ws) return 'Slack is not connected'
    if (this.d.settings.autoPaused()) return 'auto-posts are paused (Pause auto-replies)'
    if (userMentions(text).length > SLACK_AUTO_LIMITS.maxUserMentions) return `it mentions more than ${SLACK_AUTO_LIMITS.maxUserMentions} people`
    const since = this.d.clock.now() - 3600_000
    const [channelHour, runHere] = await Promise.all([
      this.d.store.autoPostsSince({ teamId: ws.teamId, channelId, sinceMs: since, withNotify: true }),
      runId ? this.d.store.autoPostsSince({ teamId: ws.teamId, channelId, runId, sinceMs: 0, withNotify: true }) : Promise.resolve(0)
    ])
    if (channelHour >= SLACK_AUTO_LIMITS.perChannelPerHour) return `the channel already has ${SLACK_AUTO_LIMITS.perChannelPerHour} automatic posts this hour`
    if (runHere >= SLACK_AUTO_LIMITS.perRun) return 'this run already posted in that channel'
    return null
  }

  /** Notify-node posts since a time (durable alert rate guard). Failed posts do not count. */
  notifyPostsSince(q: { runId: string | null; sinceMs: number }): Promise<number> {
    return this.d.store.notifyPostsSince(q)
  }

  /** Daily maintenance: expire drafts, prune old rows. */
  async maintenance(): Promise<void> {
    await this.drafts.expire()
    await this.d.store.pruneOld(this.d.clock.now(), { backfillDays: this.d.settings.backfillDays() })
  }

  /** Called by the service when the user picks an alert user (clears the suggestion). */
  alertUserChanged(): void {
    this.emitStatus()
  }

  /** Sorted ascending messages of a thread (transcripts). */
  async threadMessages(channelId: string, threadTs: string, limit = 200): Promise<SlackMessage[]> {
    if (!this.ws) return []
    return this.d.store.getThread({ teamId: this.ws.teamId, channelId, threadTs, limit })
  }
}
