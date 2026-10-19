/**
 * Sync (SLACK.md §6): channels/users refresh, resumable backfill (cursor persisted after every page), gap-fill after a
 * reconnect or wake, thread jobs, on-demand freshness fetches and unknown-id resolution. Backfilled messages never
 * trigger; gap-filled ones younger than Settings.slackTriggerCatchupMin go to `inbound` with catchup:true.
 */
import type { SlackChannel, SlackMessage, SlackUser } from '../../../../shared/slack'
import { SlackApiError, type SlackApi } from './api'
import { mentionsUser, msToTs, tsCmp, tsMax, tsToMs, type Resolver } from './format'
import { channelRow, messageRow, userFromWire, userLabel } from './ingest'
import type { Lane } from './limiter'
import type { Clock, Logger, SettingsPort, SlackMessageRow, SlackStore, SlackWorkspace, SyncState } from './ports'
import { channelSchema, messageSchema, userSchema, type WireMessage } from './types'

const DAY = 86400_000
const NEG_CACHE_MS = 3600_000

export interface SyncProgress {
  state: 'idle' | 'running' | 'error'
  channelsDone: number
  channelsTotal: number
  threadsPending: number
  days: number
  error: string | null
}

/** In-memory names for the sync resolver (mrkdwn -> plain). Misses are resolved in the background. */
export class NameCache implements Resolver {
  users = new Map<string, SlackUser>()
  channels = new Map<string, string>()
  missUser: (id: string) => void = () => {}
  user(id: string): string | null {
    const u = this.users.get(id)
    if (!u) {
      this.missUser(id)
      return null
    }
    return userLabel(u, id)
  }
  channel(id: string): string | null {
    return this.channels.get(id) ?? null
  }
}

export interface SyncDeps {
  api: SlackApi
  store: SlackStore
  clock: Clock
  log: Logger
  settings: SettingsPort
  names: NameCache
  ws(): SlackWorkspace | null
  /** Persisted batch -> UI. */
  emitMessages(channelId: string, messages: SlackMessage[]): void
  emitChannels(list: SlackChannel[]): void
  /** Live-ish message for trigger matching (gap-fill catch-up). */
  inbound(row: SlackMessageRow, opts: { source: 'gapfill'; catchup: true; isMention: boolean }): void
  progress(): void
}

const parseMessages = (raw: unknown): WireMessage[] =>
  (Array.isArray(raw) ? raw : []).flatMap((m) => {
    const p = messageSchema.safeParse(m)
    return p.success ? [p.data] : []
  })

export class SlackSync {
  progress: SyncProgress = { state: 'idle', channelsDone: 0, channelsTotal: 0, threadsPending: 0, days: 7, error: null }
  private threadQueue = new Map<string, { channelId: string; threadTs: string; oldest: string | null }>()
  private userMiss = new Map<string, number>()
  private resolving = new Set<string>()
  private backfillRun: Promise<void> | null = null
  private extraBackfill: { channelId: string; days: number }[] = []
  private stopped = false

  constructor(private d: SyncDeps) {
    d.names.missUser = (id) => this.queueUser(id)
  }

  stop(): void {
    this.stopped = true
  }
  restart(): void {
    this.stopped = false
  }

  private iso(): string {
    return new Date(this.d.clock.now()).toISOString()
  }

  /** Loads users + channels from the store into the name cache. */
  async warm(): Promise<void> {
    const ws = this.d.ws()
    if (!ws) return
    for (const u of await this.d.store.listUsers(ws.teamId)) this.d.names.users.set(u.id, u)
    for (const c of await this.d.store.listChannels(ws.teamId)) this.d.names.channels.set(c.id, c.name)
  }

  // ---------- channels + users ----------
  async refreshChannels(lane: Lane = 'live'): Promise<SlackChannel[]> {
    const ws = this.d.ws()
    if (!ws) return []
    const granted = new Set(ws.scopes)
    const types = [
      ['public_channel', 'channels:read'],
      ['private_channel', 'groups:read'],
      ['im', 'im:read'],
      ['mpim', 'mpim:read']
    ]
      .filter(([, s]) => !ws.scopes.length || granted.has(s))
      .map(([t]) => t)
    if (!types.length) return []
    const rows: ReturnType<typeof channelRow>[] = []
    await this.d.api.paginate<{ channels?: unknown[] }>(
      'conversations.list',
      { exclude_archived: true, limit: 200, types: types.join(',') },
      { lane, token: 'bot' },
      async (page) => {
        for (const c of page.channels ?? []) {
          const p = channelSchema.safeParse(c)
          if (p.success) rows.push(channelRow(p.data))
        }
      }
    )
    for (const r of rows) {
      if (r.kind === 'dm' && r.dmUserId) {
        r.name = this.d.names.user(r.dmUserId) ?? r.dmUserId
        // DMs with other bots / Slackbot are not conversations with the Hive bot's users
      }
    }
    await this.d.store.upsertChannels(ws.teamId, rows)
    const list = await this.d.store.listChannels(ws.teamId)
    for (const c of list) this.d.names.channels.set(c.id, c.name)
    this.d.emitChannels(list)
    return list
  }

  async refreshUsers(lane: Lane = 'live'): Promise<void> {
    const ws = this.d.ws()
    if (!ws) return
    const users: SlackUser[] = []
    await this.d.api.paginate<{ members?: unknown[] }>('users.list', { limit: 200 }, { lane, token: 'bot' }, async (page) => {
      for (const u of page.members ?? []) {
        const p = userSchema.safeParse(u)
        if (p.success) users.push(userFromWire(p.data))
      }
    })
    await this.d.store.upsertUsers(ws.teamId, users)
    for (const u of users) this.d.names.users.set(u.id, u)
  }

  private queueUser(id: string): void {
    if (!/^[UWB][A-Z0-9]+$/.test(id) || this.resolving.has(id)) return
    const miss = this.userMiss.get(id)
    if (miss && this.d.clock.now() - miss < NEG_CACHE_MS) return
    this.resolving.add(id)
    void this.resolveUser(id).finally(() => this.resolving.delete(id))
  }

  async resolveUser(id: string): Promise<SlackUser | null> {
    const ws = this.d.ws()
    if (!ws) return null
    const known = this.d.names.users.get(id) ?? (await this.d.store.getUser(ws.teamId, id))
    if (known) {
      this.d.names.users.set(id, known)
      return known
    }
    try {
      const { body } = await this.d.api.call<{ user?: unknown }>('users.info', { user: id }, { lane: 'live', token: 'bot' })
      const p = userSchema.safeParse(body.user)
      if (!p.success) return null
      const u = userFromWire(p.data)
      await this.d.store.upsertUsers(ws.teamId, [u])
      this.d.names.users.set(u.id, u)
      return u
    } catch {
      this.userMiss.set(id, this.d.clock.now())
      return null
    }
  }

  /** Unknown channel id from an event: conversations.info. */
  async resolveChannel(id: string): Promise<SlackChannel | null> {
    const ws = this.d.ws()
    if (!ws) return null
    const known = await this.d.store.getChannel(ws.teamId, id)
    if (known) return known
    try {
      const { body } = await this.d.api.call<{ channel?: unknown }>('conversations.info', { channel: id }, { lane: 'live', token: 'bot' })
      const p = channelSchema.safeParse(body.channel)
      if (!p.success) return null
      const row = channelRow(p.data)
      if (row.kind === 'dm' && row.dmUserId) row.name = (await this.resolveUser(row.dmUserId).then((u) => userLabel(u, row.dmUserId!))) ?? row.name
      await this.d.store.upsertChannels(ws.teamId, [row])
      this.d.names.channels.set(id, row.name)
      const list = await this.d.store.listChannels(ws.teamId)
      this.d.emitChannels(list)
      return list.find((c) => c.id === id) ?? null
    } catch (e) {
      this.d.log.warn('slack: conversations.info failed', { id, e: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  // ---------- persistence helper ----------
  private async persist(channelId: string, wire: WireMessage[], source: 'backfill' | 'gapfill' | 'fetch'): Promise<SlackMessageRow[]> {
    const ws = this.d.ws()
    if (!ws || !wire.length) return []
    const rows = wire.map((m) => messageRow(m, channelId, this.d.names))
    await this.d.store.upsertMessages(ws.teamId, rows, source)
    const newest = rows.reduce<string | null>((acc, r) => tsMax(acc, r.ts), null)
    const st = await this.d.store.getSyncState(ws.teamId, channelId)
    if (newest && (!st?.latestTs || tsCmp(newest, st.latestTs) > 0)) {
      await this.d.store.putSyncState({ ...(st ?? this.freshState(ws.teamId, channelId)), latestTs: newest })
    }
    const stored = (await Promise.all(rows.map((r) => this.d.store.getMessage(ws.teamId, channelId, r.ts)))).filter((m): m is SlackMessage => !!m)
    if (stored.length) this.d.emitMessages(channelId, stored)
    return rows
  }

  private freshState(teamId: string, channelId: string): SyncState {
    return { teamId, channelId, backfillStatus: 'pending', backfillDays: this.d.settings.backfillDays(), backfillOldestTs: null, backfillCursor: null, latestTs: null, error: null }
  }

  // ---------- backfill (§6.2) ----------
  /** First connect / newly joined channel / "Load older". Runs in the background; one run at a time. */
  backfill(opts: { channelId?: string; days?: number } = {}): Promise<void> {
    if (opts.channelId) this.extraBackfill.push({ channelId: opts.channelId, days: opts.days ?? this.d.settings.backfillDays() })
    if (!this.backfillRun) {
      this.backfillRun = this.runBackfill(opts.channelId ? undefined : opts.days).finally(() => {
        this.backfillRun = null
      })
    }
    return this.backfillRun
  }

  private async runBackfill(daysOverride?: number): Promise<void> {
    const ws = this.d.ws()
    if (!ws) return
    const days = daysOverride ?? this.d.settings.backfillDays()
    this.progress = { state: 'running', channelsDone: 0, channelsTotal: 0, threadsPending: 0, days, error: null }
    this.d.progress()
    try {
      const channels = (await this.d.store.listChannels(ws.teamId)).filter((c) => c.isMember && !c.isArchived)
      const states = new Map((await this.d.store.listSyncStates(ws.teamId)).map((s) => [s.channelId, s]))
      // DMs first, then channels by recent activity
      channels.sort((a, b) => {
        const dm = (c: SlackChannel) => (c.kind === 'dm' || c.kind === 'group_dm' ? 0 : 1)
        return dm(a) - dm(b) || tsCmp(b.lastMessageTs ?? '0', a.lastMessageTs ?? '0')
      })
      const todo = channels.filter((c) => {
        const s = states.get(c.id)
        return !s || s.backfillStatus !== 'done' || s.backfillDays < days
      })
      this.progress.channelsTotal = todo.length
      for (const t of await this.d.store.pendingThreads(ws.teamId)) this.threadQueue.set(`${t.channelId}:${t.threadTs}`, { channelId: t.channelId, threadTs: t.threadTs, oldest: null })
      this.progress.threadsPending = this.threadQueue.size
      this.d.progress()
      for (const c of todo) {
        if (this.stopped) return
        await this.backfillChannel(c.id, days)
        this.progress.channelsDone++
        this.d.progress()
      }
      while (this.extraBackfill.length && !this.stopped) {
        const x = this.extraBackfill.shift()!
        this.progress.channelsTotal++
        await this.backfillChannel(x.channelId, x.days, true)
        this.progress.channelsDone++
        this.d.progress()
      }
      await this.drainThreads('backfill')
      this.progress.state = 'idle'
    } catch (e) {
      this.progress.state = this.stopped ? 'idle' : 'error'
      this.progress.error = e instanceof Error ? e.message : String(e)
      if (!this.stopped) this.d.log.warn('slack backfill failed', { e: this.progress.error })
    } finally {
      this.d.progress()
    }
  }

  async backfillChannel(channelId: string, days: number, force = false): Promise<void> {
    const ws = this.d.ws()
    if (!ws) return
    let st = (await this.d.store.getSyncState(ws.teamId, channelId)) ?? this.freshState(ws.teamId, channelId)
    if (!force && st.backfillStatus === 'done' && st.backfillDays >= days) return
    const oldest = msToTs(this.d.clock.now() - days * DAY)
    // a resumed run keeps its window and cursor
    const resuming = (st.backfillStatus === 'running' || st.backfillStatus === 'error') && !!st.backfillCursor && !force
    const windowOldest = resuming && st.backfillOldestTs ? st.backfillOldestTs : oldest
    st = { ...st, backfillStatus: 'running', backfillDays: days, backfillOldestTs: windowOldest, backfillCursor: resuming ? st.backfillCursor : null, error: null }
    await this.d.store.putSyncState(st)
    try {
      await this.d.api.paginate<{ messages?: unknown[]; has_more?: boolean }>(
        'conversations.history',
        { channel: channelId, oldest: windowOldest, limit: 200, inclusive: true, ...(st.backfillCursor ? { cursor: st.backfillCursor } : {}) },
        { lane: 'backfill', token: 'bot' },
        async (page, next) => {
          const msgs = parseMessages(page.messages)
          await this.persist(channelId, msgs, 'backfill')
          for (const m of msgs) if ((m.reply_count ?? 0) > 0 && m.latest_reply && tsCmp(m.latest_reply, windowOldest) >= 0) await this.queueThread(channelId, m.ts, m.latest_reply)
          const cur = (await this.d.store.getSyncState(ws.teamId, channelId)) ?? st
          await this.d.store.putSyncState({ ...cur, backfillCursor: next })
          if (this.stopped) return true
        },
        10_000
      )
      if (this.stopped) return
      const cur = (await this.d.store.getSyncState(ws.teamId, channelId)) ?? st
      await this.d.store.putSyncState({ ...cur, backfillStatus: 'done', backfillCursor: null })
    } catch (e) {
      // stopped (quit, sleep, disconnect): keep `running` + cursor so the next start resumes exactly here
      if (this.stopped || (e instanceof Error && /stopped/.test(e.message))) return
      const msg = e instanceof SlackApiError ? e.slack : e instanceof Error ? e.message : String(e)
      const cur = (await this.d.store.getSyncState(ws.teamId, channelId)) ?? st
      const skipped = e instanceof SlackApiError && (e.slack === 'not_in_channel' || e.slack === 'channel_not_found' || e.slack === 'missing_scope')
      await this.d.store.putSyncState({ ...cur, backfillStatus: skipped ? 'skipped' : 'error', error: msg })
      if (!skipped && !(e instanceof Error && /stopped/.test(e.message))) this.d.log.warn('slack channel backfill failed', { channelId, e: msg })
    }
  }

  private async queueThread(channelId: string, threadTs: string, latestReply: string | null): Promise<void> {
    const ws = this.d.ws()
    if (!ws) return
    const key = `${channelId}:${threadTs}`
    if (this.threadQueue.has(key)) return
    const ts = await this.d.store.getThreadSync(ws.teamId, channelId, threadTs)
    if (ts?.status === 'done' && ts.syncedThroughTs && latestReply && tsCmp(ts.syncedThroughTs, latestReply) >= 0) return
    await this.d.store.putThreadSync({ teamId: ws.teamId, channelId, threadTs, syncedThroughTs: ts?.syncedThroughTs ?? null, fetchedAt: ts?.fetchedAt ?? null, status: 'pending' })
    this.threadQueue.set(key, { channelId, threadTs, oldest: null })
    this.progress.threadsPending = this.threadQueue.size
  }

  private async drainThreads(lane: Lane): Promise<void> {
    while (this.threadQueue.size && !this.stopped) {
      const [key, job] = this.threadQueue.entries().next().value as [string, { channelId: string; threadTs: string }]
      try {
        await this.syncThread(job.channelId, job.threadTs, lane)
      } catch (e) {
        this.d.log.warn('slack thread sync failed', { key, e: e instanceof Error ? e.message : String(e) })
      }
      this.threadQueue.delete(key)
      this.progress.threadsPending = this.threadQueue.size
      this.d.progress()
    }
  }

  /** conversations.replies for one thread (all pages). */
  async syncThread(channelId: string, threadTs: string, lane: Lane, maxPages = 20): Promise<SlackMessageRow[]> {
    const ws = this.d.ws()
    if (!ws) return []
    const all: SlackMessageRow[] = []
    try {
      await this.d.api.paginate<{ messages?: unknown[] }>(
        'conversations.replies',
        { channel: channelId, ts: threadTs, limit: 200 },
        { lane, token: 'bot' },
        async (page) => {
          all.push(...(await this.persist(channelId, parseMessages(page.messages), lane === 'interactive' ? 'fetch' : lane === 'gapfill' ? 'gapfill' : 'backfill')))
        },
        maxPages
      )
      const newest = all.reduce<string | null>((a, r) => tsMax(a, r.ts), null)
      await this.d.store.putThreadSync({ teamId: ws.teamId, channelId, threadTs, syncedThroughTs: newest, fetchedAt: this.iso(), status: 'done' })
    } catch (e) {
      await this.d.store.putThreadSync({ teamId: ws.teamId, channelId, threadTs, syncedThroughTs: null, fetchedAt: this.iso(), status: 'error' })
      throw e
    }
    return all
  }

  // ---------- gap-fill (§6.3) ----------
  /** After a reconnect that followed a gap, and on wake. */
  async gapFill(): Promise<number> {
    const ws = this.d.ws()
    if (!ws) return 0
    const catchupMs = this.d.settings.triggerCatchupMin() * 60_000
    const states = new Map((await this.d.store.listSyncStates(ws.teamId)).map((s) => [s.channelId, s]))
    const fallback = msToTs(this.d.clock.now() - this.d.settings.backfillDays() * DAY)
    // every member channel: anchored at the newest ts seen, else at the backfill window
    const anchors = (await this.d.store.listChannels(ws.teamId))
      .filter((c) => c.isMember && !c.isArchived)
      .map((c) => {
        const st = states.get(c.id)
        return { channelId: c.id, oldest: st?.latestTs ?? st?.backfillOldestTs ?? fallback, hasLatest: !!st?.latestTs }
      })
      .sort((a, b) => Number(b.hasLatest) - Number(a.hasLatest) || tsCmp(b.oldest, a.oldest))
    let found = 0
    for (const s of anchors) {
      if (this.stopped) break
      const fresh: WireMessage[] = []
      try {
        await this.d.api.paginate<{ messages?: unknown[] }>(
          'conversations.history',
          { channel: s.channelId, oldest: s.oldest, inclusive: false, limit: 200 },
          { lane: 'gapfill', token: 'bot' },
          async (page) => {
            fresh.push(...parseMessages(page.messages))
          }
        )
      } catch (e) {
        this.d.log.warn('slack gap-fill failed', { channel: s.channelId, e: e instanceof Error ? e.message : String(e) })
        continue
      }
      if (!fresh.length) continue
      fresh.sort((a, b) => tsCmp(a.ts, b.ts))
      const rows = await this.persist(s.channelId, fresh, 'gapfill')
      found += rows.length
      const now = this.d.clock.now()
      for (const r of rows) {
        if (now - tsToMs(r.ts) <= catchupMs) this.d.inbound(r, { source: 'gapfill', catchup: true, isMention: mentionsUser(r.text, ws.botUserId) })
      }
      // threads the gap changed
      for (const m of fresh) {
        if ((m.reply_count ?? 0) > 0 && m.latest_reply) {
          const t = await this.d.store.getThreadSync(ws.teamId, s.channelId, m.ts)
          if (!t?.syncedThroughTs || tsCmp(m.latest_reply, t.syncedThroughTs) > 0) {
            try {
              await this.syncThread(s.channelId, m.ts, 'gapfill')
            } catch {
              /* logged by syncThread's caller path */
            }
          }
        }
      }
    }
    return found
  }

  // ---------- on open (§6.3) ----------
  /** One interactive page of the newest channel history. */
  async fetchLatest(channelId: string): Promise<void> {
    const { body } = await this.d.api.call<{ messages?: unknown[] }>('conversations.history', { channel: channelId, limit: 50 }, { lane: 'interactive', token: 'bot' })
    await this.persist(channelId, parseMessages(body.messages), 'fetch')
  }
  /**
   * One message whose live ingest failed: fetch it (conversations.replies for a reply, else history at exactly that ts),
   * store it, and hand it to trigger matching as a catch-up when it is still young enough (like gap-fill).
   */
  async recoverMessage(channelId: string, ts: string, threadTs: string | null): Promise<boolean> {
    const ws = this.d.ws()
    if (!ws) return false
    const reply = !!threadTs && threadTs !== ts
    const { body } = await this.d.api.call<{ messages?: unknown[] }>(
      reply ? 'conversations.replies' : 'conversations.history',
      reply ? { channel: channelId, ts: threadTs, oldest: ts, latest: ts, inclusive: true, limit: 1 } : { channel: channelId, oldest: ts, latest: ts, inclusive: true, limit: 1 },
      { lane: 'interactive', token: 'bot' }
    )
    const hit = parseMessages(body.messages).filter((m) => m.ts === ts)
    if (!hit.length) return false
    const [row] = await this.persist(channelId, hit, 'gapfill')
    if (row.threadTs && row.threadTs !== row.ts) await this.d.store.bumpParent(ws.teamId, channelId, row.threadTs, row.ts, row.userId)
    if (this.d.clock.now() - tsToMs(row.ts) <= this.d.settings.triggerCatchupMin() * 60_000) {
      this.d.inbound(row, { source: 'gapfill', catchup: true, isMention: mentionsUser(row.text, ws.botUserId) })
    }
    return true
  }
  /** One interactive page of a thread. */
  async fetchThread(channelId: string, threadTs: string): Promise<void> {
    await this.syncThread(channelId, threadTs, 'interactive', 1)
  }
}
