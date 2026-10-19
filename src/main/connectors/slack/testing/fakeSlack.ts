/**
 * FakeSlack (SLACK.md §13): an in-process fake workspace that implements HttpPort and SocketPort directly. No sockets,
 * no listeners, no network. Tests build `new SlackConnector({ http: fake.http, socket: fake.socket, … })`; production
 * code paths are identical above the ports. Imported only by tests and the dev-only fake build.
 *
 * Simulates (per Slack's docs): events_api envelopes, redelivery of unacked envelopes after 3 s with retry_attempt+1
 * (up to 3), hello with num_connections, warning / refresh_requested / link_disabled, ping/pong, half-open sockets,
 * per-tier 429 + Retry-After, cursor pagination, scope and membership errors, and chat.postMessage echoing a bot
 * `message` event with the metadata back over the socket.
 */
import type { Clock, HttpPort, HttpResponse, SocketLike, SocketPort } from '../core/ports'

export const HIVE_FAKE_SLACK_MARKER = 'HIVE_FAKE_SLACK_MARKER'

export const FAKE_SCOPES = [
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
  'reactions:read'
]

export interface FakeUser {
  id: string
  name: string
  real_name?: string
  display_name?: string
  is_bot?: boolean
  bot_id?: string
  deleted?: boolean
  /** Multi-channel guest. */
  is_restricted?: boolean
  /** Single-channel guest. */
  is_ultra_restricted?: boolean
  /** Home team; another org's id = a Slack Connect external (left out of users.list, events carry user_team). */
  team_id?: string
}
export type FakeChannelKind = 'channel' | 'private' | 'dm' | 'group_dm'
export interface FakeChannel {
  id: string
  name: string
  kind: FakeChannelKind
  members: string[]
  archived?: boolean
  topic?: string
  /** dm: the other user */
  user?: string
}
export interface FakeMessage {
  ts: string
  user?: string
  bot_id?: string
  text: string
  thread_ts?: string
  subtype?: string
  reactions?: { name: string; count: number; users?: string[] }[]
  metadata?: { event_type: string; event_payload: Record<string, unknown> }
  edited?: { ts: string; user: string }
  reply_count?: number
  latest_reply?: string
  reply_users?: string[]
  files?: { name: string; mimetype?: string; size?: number; permalink?: string }[]
}

export interface FakeSlackOptions {
  team?: { id: string; name: string; domain: string }
  bot?: { userId: string; botId: string; appId: string }
  scopes?: string[]
  tokens?: { bot: string; app: string }
  users?: FakeUser[]
  channels?: FakeChannel[]
  messages?: Record<string, Omit<FakeMessage, 'ts'> & { ts?: string }[] | FakeMessage[]>
  clock: Clock
  /** Enforce Slack's per-tier minute limits with 429 (default true). */
  enforceTiers?: boolean
  /** Redeliver unacked envelopes after this many ms (default 3000). */
  ackTimeoutMs?: number
}

/** Documented tier minimums per minute (Tier 1: 1+, Tier 2: 20+, Tier 3: 50+, Tier 4: 100+). */
const TIER_LIMITS: Record<string, number> = {
  'auth.test': 100,
  'apps.connections.open': 10,
  'conversations.list': 20,
  'conversations.info': 50,
  'conversations.history': 50,
  'conversations.replies': 50,
  'conversations.open': 50,
  'conversations.join': 50,
  'users.list': 20,
  'users.info': 100,
  'chat.postMessage': 60,
  'chat.getPermalink': 100
}

interface Conn {
  id: number
  url: string
  handlers: Record<string, ((...a: unknown[]) => void)[]>
  open: boolean
  halfOpen: boolean
  closeTimer: unknown
}
interface Pending {
  envelopeId: string
  eventId: string
  payload: Record<string, unknown>
  attempt: number
  timer: unknown
}

const ok = (body: Record<string, unknown>, extra: Partial<HttpResponse['headers']> = {}): HttpResponse => ({
  status: 200,
  headers: { retryAfter: null, scopes: null, ...extra },
  body: { ok: true, ...body }
})
const err = (error: string, extra: Record<string, unknown> = {}): HttpResponse => ({ status: 200, headers: { retryAfter: null, scopes: null }, body: { ok: false, error, ...extra } })

export class FakeSlack {
  team: { id: string; name: string; domain: string }
  bot: { userId: string; botId: string; appId: string }
  scopes: string[]
  tokens: { bot: string; app: string }
  users = new Map<string, FakeUser>()
  channels = new Map<string, FakeChannel>()
  messages = new Map<string, FakeMessage[]>()
  readonly clock: Clock

  calls: { method: string; at: number; body: Record<string, unknown>; status: number; error: string | null }[] = []
  posted: { channel: string; thread_ts: string | null; text: string; metadata: unknown; ts: string }[] = []
  acks: { envelopeId: string; atMs: number }[] = []
  frames: string[] = []
  /** Every connection ever opened (tests assert "never 2 sockets open"). */
  maxOpenConnections = 0

  private revoked = { bot: false, app: false }
  private issued = new Set<string>()
  private conns: Conn[] = []
  private connSeq = 0
  private pending = new Map<string, Pending>()
  private queue: Pending[] = []
  private envSeq = 0
  private eventSeq = 0
  private lastTsMicros = 0
  private rr = 0
  private limits = new Map<string, { retryAfter: number; times: number }>()
  private fails = new Map<string, string[]>()
  private lostAnswers = new Map<string, ('5xx' | 'network')[]>()
  private minuteHits = new Map<string, number[]>()
  private blockedUntil = new Map<string, number>()
  private enforceTiers: boolean
  private ackTimeoutMs: number
  linkDisabled = false

  constructor(o: FakeSlackOptions) {
    this.clock = o.clock
    this.team = o.team ?? { id: 'T1', name: 'Acme', domain: 'acme' }
    this.bot = o.bot ?? { userId: 'UBOT', botId: 'BBOT', appId: 'A1' }
    this.scopes = o.scopes ? [...o.scopes] : [...FAKE_SCOPES]
    this.tokens = o.tokens ?? { bot: 'xoxb-test-0000000000-1111111111111-abcdefghijklmnop', app: 'xapp-1-A1-0000000000-abcdefghijklmnopqrstuvwxyz' }
    this.enforceTiers = o.enforceTiers ?? true
    this.ackTimeoutMs = o.ackTimeoutMs ?? 3000
    this.users.set(this.bot.userId, { id: this.bot.userId, name: 'hive', real_name: 'hive', is_bot: true, bot_id: this.bot.botId })
    for (const u of o.users ?? []) this.users.set(u.id, u)
    for (const c of o.channels ?? []) this.channels.set(c.id, { ...c, members: [...c.members] })
    for (const [cid, msgs] of Object.entries(o.messages ?? {})) {
      const list = (msgs as (FakeMessage | (Omit<FakeMessage, 'ts'> & { ts?: string }))[]).map((m) => ({ ...m, ts: m.ts ?? this.nextTs() }) as FakeMessage)
      list.sort((a, b) => cmpTs(a.ts, b.ts))
      for (const m of list) this.bumpTsFloor(m.ts)
      this.messages.set(cid, list)
      this.recountThreads(cid)
    }
  }

  // ---------- helpers ----------
  private now(): number {
    return this.clock.now()
  }
  private bumpTsFloor(ts: string): void {
    const [s, u] = ts.split('.')
    const micros = Number(s) * 1e6 + Number((u ?? '0').padEnd(6, '0'))
    if (micros > this.lastTsMicros) this.lastTsMicros = micros
  }
  /** Monotonic Slack-style ts from the clock. */
  nextTs(atMs = this.now()): string {
    const micros = Math.max(Math.floor(atMs) * 1000, this.lastTsMicros + 1)
    this.lastTsMicros = micros
    const s = Math.floor(micros / 1e6)
    return `${s}.${String(micros % 1e6).padStart(6, '0')}`
  }
  private recountThreads(cid: string): void {
    const list = this.messages.get(cid) ?? []
    const byParent = new Map<string, FakeMessage[]>()
    for (const m of list) if (m.thread_ts && m.thread_ts !== m.ts) byParent.set(m.thread_ts, [...(byParent.get(m.thread_ts) ?? []), m])
    for (const m of list) {
      const r = byParent.get(m.ts)
      if (r?.length) {
        m.thread_ts = m.ts
        m.reply_count = r.length
        m.latest_reply = r[r.length - 1].ts
        m.reply_users = [...new Set(r.map((x) => x.user ?? '').filter(Boolean))]
      }
    }
  }
  private channelType(c: FakeChannel): string {
    return c.kind === 'channel' ? 'channel' : c.kind === 'private' ? 'group' : c.kind === 'dm' ? 'im' : 'mpim'
  }
  private hasScope(s: string): boolean {
    return this.scopes.includes(s)
  }
  private historyScope(c: FakeChannel): string {
    return c.kind === 'channel' ? 'channels:history' : c.kind === 'private' ? 'groups:history' : c.kind === 'dm' ? 'im:history' : 'mpim:history'
  }
  private botIn(c: FakeChannel): boolean {
    return c.members.includes(this.bot.userId)
  }
  private wireChannel(c: FakeChannel): Record<string, unknown> {
    return {
      id: c.id,
      name: c.kind === 'dm' ? undefined : c.name,
      is_channel: c.kind === 'channel',
      is_group: c.kind === 'private',
      is_im: c.kind === 'dm',
      is_mpim: c.kind === 'group_dm',
      is_private: c.kind !== 'channel',
      is_member: this.botIn(c),
      is_archived: !!c.archived,
      user: c.kind === 'dm' ? c.user : undefined,
      num_members: c.members.length,
      topic: { value: c.topic ?? '' },
      purpose: { value: '' }
    }
  }
  private wireUser(u: FakeUser): Record<string, unknown> {
    return {
      id: u.id,
      name: u.name,
      real_name: u.real_name ?? u.name,
      deleted: !!u.deleted,
      is_bot: !!u.is_bot,
      is_restricted: !!u.is_restricted,
      is_ultra_restricted: !!u.is_ultra_restricted,
      team_id: u.team_id ?? this.team.id,
      tz: 'Europe/Madrid',
      profile: { display_name: u.display_name ?? '', real_name: u.real_name ?? u.name, image_72: `https://avatars.slack-edge.com/${u.id}_72.png`, bot_id: u.bot_id }
    }
  }
  private wireMessage(m: FakeMessage): Record<string, unknown> {
    return { type: 'message', ...m }
  }

  // ---------- test controls ----------
  rateLimit(method: string, retryAfterSec: number, times = 1): void {
    this.limits.set(method, { retryAfter: retryAfterSec, times })
  }
  failNext(method: string, error: string | '5xx' | 'network', times = 1): void {
    this.fails.set(method, [...(this.fails.get(method) ?? []), ...Array(times).fill(error)])
  }
  /** Slack does the work, then the answer is lost (network drop or 5xx): a non-idempotent call must not be repeated blindly. */
  failAfterAccept(method: string, error: '5xx' | 'network', times = 1): void {
    this.lostAnswers.set(method, [...(this.lostAnswers.get(method) ?? []), ...Array(times).fill(error)])
  }
  revoke(which: 'bot' | 'app'): void {
    this.revoked[which] = true
    if (which === 'app') for (const c of [...this.conns]) this.closeConn(c, 1011, 'token revoked')
  }
  unacked(): string[] {
    return [...this.pending.keys()]
  }
  openConnections(): number {
    return this.conns.filter((c) => c.open).length
  }
  callsOf(method: string): { at: number; body: Record<string, unknown> }[] {
    return this.calls.filter((c) => c.method === method)
  }

  // ---------- HttpPort ----------
  readonly http: HttpPort = {
    call: async (req) => {
      const at = this.now()
      const record = (r: HttpResponse): HttpResponse => {
        const b = r.body as { ok?: boolean; error?: string }
        this.calls.push({ method: req.method, at, body: req.body, status: r.status, error: b?.ok === false ? (b.error ?? null) : null })
        return r
      }
      const f = this.fails.get(req.method)
      if (f?.length) {
        const e = f.shift()!
        if (e === 'network') {
          this.calls.push({ method: req.method, at, body: req.body, status: 0, error: 'network' })
          throw new Error('fake network error')
        }
        if (e === '5xx') return record({ status: 503, headers: { retryAfter: null, scopes: null }, body: null })
        return record(err(e))
      }
      const lim = this.limits.get(req.method)
      if (lim && lim.times > 0) {
        lim.times--
        this.blockedUntil.set(req.method, at + lim.retryAfter * 1000)
        return record({ status: 429, headers: { retryAfter: lim.retryAfter, scopes: null }, body: { ok: false, error: 'ratelimited' } })
      }
      const blocked = this.blockedUntil.get(req.method) ?? 0
      if (at < blocked) return record({ status: 429, headers: { retryAfter: Math.ceil((blocked - at) / 1000), scopes: null }, body: { ok: false, error: 'ratelimited' } })
      if (this.enforceTiers && TIER_LIMITS[req.method]) {
        const hits = (this.minuteHits.get(req.method) ?? []).filter((t) => at - t < 60_000)
        if (hits.length >= TIER_LIMITS[req.method]) {
          this.minuteHits.set(req.method, hits)
          return record({ status: 429, headers: { retryAfter: Math.ceil((hits[0] + 60_000 - at) / 1000), scopes: null }, body: { ok: false, error: 'ratelimited' } })
        }
        hits.push(at)
        this.minuteHits.set(req.method, hits)
      }
      const res = record(this.route(req.method, req.token, req.body))
      const lost = this.lostAnswers.get(req.method)
      if (lost?.length && (res.body as { ok?: boolean })?.ok) {
        const e = lost.shift()!
        if (e === 'network') throw new Error('fake network error after accept')
        return { status: 502, headers: { retryAfter: null, scopes: null }, body: null }
      }
      return res
    }
  }

  private route(method: string, token: string, b: Record<string, unknown>): HttpResponse {
    const isApp = method === 'apps.connections.open'
    if (isApp) {
      if (token.startsWith('xoxb-')) return err('not_allowed_token_type')
      if (token !== this.tokens.app) return err('invalid_auth')
      if (this.revoked.app) return err('token_revoked')
    } else {
      if (token.startsWith('xapp-')) return err('not_allowed_token_type')
      if (token !== this.tokens.bot) return err('invalid_auth')
      if (this.revoked.bot) return err('token_revoked')
    }
    const chan = (): FakeChannel | null => this.channels.get(String(b.channel ?? '')) ?? null
    switch (method) {
      case 'auth.test':
        return ok(
          { url: `https://${this.team.domain}.slack.com/`, team: this.team.name, user: 'hive', team_id: this.team.id, user_id: this.bot.userId, bot_id: this.bot.botId, is_enterprise_install: false },
          { scopes: this.scopes.join(',') }
        )
      case 'apps.connections.open': {
        if (this.linkDisabled) return err('invalid_auth')
        const url = `wss://wss-primary.slack.com/link/?ticket=t${++this.connSeq}&app_id=${this.bot.appId}`
        this.issued.add(url)
        return ok({ url })
      }
      case 'conversations.list': {
        const types = String(b.types ?? 'public_channel').split(',')
        const need: Record<string, string> = { public_channel: 'channels:read', private_channel: 'groups:read', im: 'im:read', mpim: 'mpim:read' }
        for (const t of types) if (need[t] && !this.hasScope(need[t])) return err('missing_scope', { needed: need[t] })
        const kindOf: Record<string, FakeChannelKind> = { public_channel: 'channel', private_channel: 'private', im: 'dm', mpim: 'group_dm' }
        const wanted = new Set(types.map((t) => kindOf[t]))
        const all = [...this.channels.values()].filter((c) => wanted.has(c.kind) && (c.kind === 'channel' || this.botIn(c)) && !(b.exclude_archived && c.archived))
        return this.page(all.map((c) => this.wireChannel(c)), 'channels', b)
      }
      case 'conversations.info': {
        const c = chan()
        if (!c || (c.kind !== 'channel' && !this.botIn(c))) return err('channel_not_found')
        return ok({ channel: this.wireChannel(c) })
      }
      case 'conversations.history': {
        const c = chan()
        if (!c) return err('channel_not_found')
        if (!this.hasScope(this.historyScope(c))) return err('missing_scope', { needed: this.historyScope(c) })
        if (!this.botIn(c)) return err(c.kind === 'channel' ? 'not_in_channel' : 'channel_not_found')
        const oldest = b.oldest ? String(b.oldest) : null
        const latest = b.latest ? String(b.latest) : null
        const inclusive = b.inclusive === true || b.inclusive === 'true'
        const list = (this.messages.get(c.id) ?? [])
          .filter((m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === 'thread_broadcast')
          .filter((m) => !oldest || (inclusive ? cmpTs(m.ts, oldest) >= 0 : cmpTs(m.ts, oldest) > 0))
          .filter((m) => !latest || (inclusive ? cmpTs(m.ts, latest) <= 0 : cmpTs(m.ts, latest) < 0))
          .slice()
          .reverse()
          .map((m) => this.wireMessage(m))
        const r = this.page(list, 'messages', b)
        ;(r.body as Record<string, unknown>).has_more = !!((r.body as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor)
        return r
      }
      case 'conversations.replies': {
        const c = chan()
        if (!c) return err('channel_not_found')
        if (!this.hasScope(this.historyScope(c))) return err('missing_scope', { needed: this.historyScope(c) })
        if (!this.botIn(c)) return err(c.kind === 'channel' ? 'not_in_channel' : 'channel_not_found')
        const ts = String(b.ts ?? '')
        const list = (this.messages.get(c.id) ?? []).filter((m) => m.ts === ts || m.thread_ts === ts)
        if (!list.length) return err('thread_not_found')
        return this.page(list.map((m) => this.wireMessage(m)), 'messages', b)
      }
      case 'conversations.open': {
        if (!this.hasScope('im:write')) return err('missing_scope', { needed: 'im:write' })
        const uid = String(b.users ?? '')
        if (!this.users.has(uid)) return err('user_not_found')
        let dm = [...this.channels.values()].find((c) => c.kind === 'dm' && c.user === uid)
        if (!dm) {
          dm = { id: `D${uid.slice(1)}`, name: uid, kind: 'dm', members: [this.bot.userId, uid], user: uid }
          this.channels.set(dm.id, dm)
        }
        return ok({ channel: { id: dm.id } })
      }
      case 'conversations.join': {
        if (!this.hasScope('channels:join')) return err('missing_scope', { needed: 'channels:join' })
        const c = chan()
        if (!c || c.kind !== 'channel') return err('channel_not_found')
        if (c.archived) return err('is_archived')
        this.join(c.id)
        return ok({ channel: this.wireChannel(c) })
      }
      case 'users.list':
        if (!this.hasScope('users:read')) return err('missing_scope', { needed: 'users:read' })
        return this.page([...this.users.values()].filter((u) => !u.team_id || u.team_id === this.team.id).map((u) => this.wireUser(u)), 'members', b)
      case 'users.info': {
        const u = this.users.get(String(b.user ?? ''))
        return u ? ok({ user: this.wireUser(u) }) : err('user_not_found')
      }
      case 'chat.postMessage': {
        if (!this.hasScope('chat:write')) return err('missing_scope', { needed: 'chat:write' })
        const c = chan()
        if (!c) return err('channel_not_found')
        if (c.archived) return err('is_archived')
        if (!this.botIn(c)) return err('not_in_channel')
        const text = String(b.text ?? '')
        if (!text) return err('no_text')
        if (text.length > 40_000) return err('msg_too_long')
        const thread = b.thread_ts ? String(b.thread_ts) : undefined
        const meta = typeof b.metadata === 'string' ? JSON.parse(b.metadata) : b.metadata
        const m: FakeMessage = { ts: this.nextTs(), user: this.bot.userId, bot_id: this.bot.botId, text, ...(thread ? { thread_ts: thread } : {}), ...(meta ? { metadata: meta as FakeMessage['metadata'] } : {}) }
        this.append(c.id, m)
        this.posted.push({ channel: c.id, thread_ts: thread ?? null, text, metadata: meta ?? null, ts: m.ts })
        // Slack echoes the bot's own message as a `message` event (the loop guard must ignore it)
        this.emitMessage(c, m)
        return ok({ channel: c.id, ts: m.ts, message: this.wireMessage(m) })
      }
      case 'chat.getPermalink': {
        const c = chan()
        if (!c) return err('channel_not_found')
        const ts = String(b.message_ts ?? '')
        return ok({ channel: c.id, permalink: `https://${this.team.domain}.slack.com/archives/${c.id}/p${ts.replace('.', '')}` })
      }
      default:
        return err('unknown_method')
    }
  }

  private page(items: unknown[], key: string, b: Record<string, unknown>): HttpResponse {
    const limit = Math.max(1, Math.min(Number(b.limit ?? 100) || 100, 1000))
    const start = b.cursor ? Number(Buffer.from(String(b.cursor), 'base64').toString().replace('o:', '')) || 0 : 0
    const slice = items.slice(start, start + limit)
    const next = start + limit < items.length ? Buffer.from(`o:${start + limit}`).toString('base64') : ''
    return ok({ [key]: slice, response_metadata: { next_cursor: next } })
  }

  private append(cid: string, m: FakeMessage): void {
    const list = this.messages.get(cid) ?? []
    list.push(m)
    list.sort((a, b) => cmpTs(a.ts, b.ts))
    this.messages.set(cid, list)
    if (m.thread_ts && m.thread_ts !== m.ts) this.recountThreads(cid)
  }

  // ---------- humans ----------
  /** A human posts: appends + emits message.* (and app_mention when it mentions the bot). Returns the ts. */
  post(channelId: string, m: { user: string; text: string; thread_ts?: string; atMs?: number; emit?: boolean; subtype?: string; bot_id?: string }): string {
    const c = this.channels.get(channelId)
    if (!c) throw new Error(`fake: no channel ${channelId}`)
    const msg: FakeMessage = { ts: this.nextTs(m.atMs), user: m.user, text: m.text, ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}), ...(m.subtype ? { subtype: m.subtype } : {}), ...(m.bot_id ? { bot_id: m.bot_id } : {}) }
    this.append(channelId, msg)
    if (m.emit !== false) this.emitMessage(c, msg)
    return msg.ts
  }
  edit(channelId: string, ts: string, text: string): void {
    const c = this.channels.get(channelId)!
    const m = (this.messages.get(channelId) ?? []).find((x) => x.ts === ts)
    if (!m) throw new Error('fake: no message')
    m.text = text
    m.edited = { ts: this.nextTs(), user: m.user ?? '' }
    if (this.botIn(c)) this.deliver({ type: 'message', subtype: 'message_changed', channel: channelId, channel_type: this.channelType(c), hidden: true, message: this.wireMessage(m), ts: this.nextTs(), event_ts: this.nextTs() })
  }
  delete(channelId: string, ts: string): void {
    const c = this.channels.get(channelId)!
    const gone = (this.messages.get(channelId) ?? []).find((m) => m.ts === ts)
    this.messages.set(channelId, (this.messages.get(channelId) ?? []).filter((m) => m.ts !== ts))
    // a deleted reply: the parent's reply_count / latest_reply drop, as in Slack
    if (gone?.thread_ts && gone.thread_ts !== ts) {
      const list = this.messages.get(channelId) ?? []
      const parent = list.find((m) => m.ts === gone.thread_ts)
      const left = list.filter((m) => m.thread_ts === gone.thread_ts && m.ts !== gone.thread_ts)
      if (parent) {
        parent.reply_count = left.length
        parent.latest_reply = left.length ? left[left.length - 1].ts : undefined
        parent.reply_users = [...new Set(left.map((x) => x.user ?? '').filter(Boolean))]
      }
    }
    if (this.botIn(c)) this.deliver({ type: 'message', subtype: 'message_deleted', channel: channelId, channel_type: this.channelType(c), hidden: true, deleted_ts: ts, ts: this.nextTs() })
  }
  /** The bot joins (conversations.join or /invite): member_joined_channel + channel_join. */
  join(channelId: string): void {
    const c = this.channels.get(channelId)!
    if (this.botIn(c)) return
    c.members.push(this.bot.userId)
    this.deliver({ type: 'member_joined_channel', user: this.bot.userId, channel: channelId, channel_type: c.kind === 'channel' ? 'C' : 'G', team: this.team.id, event_ts: this.nextTs() })
  }
  leave(channelId: string): void {
    const c = this.channels.get(channelId)!
    c.members = c.members.filter((u) => u !== this.bot.userId)
  }

  private emitMessage(c: FakeChannel, m: FakeMessage): void {
    if (!this.botIn(c)) return
    const team = (m.user && this.users.get(m.user)?.team_id) || this.team.id
    const ev = { ...this.wireMessage(m), channel: c.id, channel_type: this.channelType(c), event_ts: m.ts, user_team: team, source_team: team }
    this.deliver(ev)
    if (m.user !== this.bot.userId && m.text.includes(`<@${this.bot.userId}>`) && c.kind !== 'dm') {
      this.deliver({ type: 'app_mention', user: m.user, text: m.text, ts: m.ts, ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}), channel: c.id, event_ts: m.ts })
    }
  }

  // ---------- envelopes ----------
  /** Wraps an Events API event in an envelope and delivers it (or queues it while nobody is connected). */
  deliver(event: Record<string, unknown>): string {
    const eventId = `Ev${String(++this.eventSeq).padStart(8, '0')}`
    const p: Pending = {
      envelopeId: `env-${++this.envSeq}`,
      eventId,
      payload: {
        team_id: this.team.id,
        api_app_id: this.bot.appId,
        event,
        type: 'event_callback',
        event_id: eventId,
        event_time: Math.floor(this.now() / 1000),
        authorizations: [{ team_id: this.team.id, user_id: this.bot.userId, is_bot: true }]
      },
      attempt: 0,
      timer: null
    }
    this.send(p)
    return eventId
  }

  private send(p: Pending): void {
    const conn = this.pickConn()
    if (!conn) {
      this.queue.push(p)
      return
    }
    this.pending.set(p.envelopeId, p)
    this.frame(conn, {
      envelope_id: p.envelopeId,
      type: 'events_api',
      accepts_response_payload: false,
      retry_attempt: p.attempt,
      retry_reason: p.attempt ? 'timeout' : '',
      payload: p.payload
    })
    p.timer = this.clock.setTimeout(() => {
      if (!this.pending.has(p.envelopeId)) return
      this.pending.delete(p.envelopeId)
      if (p.attempt >= 3) return
      // Slack redelivers with a NEW envelope id and the same event_id
      this.send({ ...p, envelopeId: `env-${++this.envSeq}`, attempt: p.attempt + 1, timer: null })
    }, this.ackTimeoutMs)
  }

  private pickConn(): Conn | null {
    const open = this.conns.filter((c) => c.open)
    if (!open.length) return null
    return open[this.rr++ % open.length]
  }

  /** Arbitrary frame (malformed JSON, unknown types, slash_commands). */
  emitRaw(frame: string | Record<string, unknown>): void {
    const conn = this.pickConn()
    if (!conn) return
    if (typeof frame === 'string') this.rawFrame(conn, frame)
    else this.frame(conn, frame)
  }

  private frame(conn: Conn, obj: Record<string, unknown>): void {
    this.rawFrame(conn, JSON.stringify(obj))
  }
  private rawFrame(conn: Conn, text: string): void {
    if (!conn.open || conn.halfOpen) return
    this.frames.push(text)
    for (const cb of conn.handlers.message ?? []) cb(text)
  }

  // ---------- SocketPort ----------
  readonly socket: SocketPort = {
    open: (url: string): SocketLike => {
      if (!this.issued.has(url)) throw new Error(`fake: socket URL was not issued by apps.connections.open: ${url}`)
      this.issued.delete(url)
      if (this.conns.filter((c) => c.open).length >= 10) throw new Error('fake: too many connections')
      const conn: Conn = { id: this.connSeq, url, handlers: {}, open: true, halfOpen: false, closeTimer: null }
      this.conns.push(conn)
      this.maxOpenConnections = Math.max(this.maxOpenConnections, this.openConnections())
      const like: SocketLike = {
        send: (text: string) => {
          if (!conn.open || conn.halfOpen) return
          try {
            const o = JSON.parse(text) as { envelope_id?: string }
            if (o.envelope_id) {
              this.acks.push({ envelopeId: o.envelope_id, atMs: this.now() })
              const p = this.pending.get(o.envelope_id)
              if (p) {
                this.clock.clearTimeout(p.timer)
                this.pending.delete(o.envelope_id)
              }
            }
          } catch {
            /* ignore */
          }
        },
        close: (code?: number, reason?: string) => this.closeConn(conn, code ?? 1000, reason ?? ''),
        ping: () => {
          if (!conn.open || conn.halfOpen) return
          this.clock.setTimeout(() => {
            if (conn.open && !conn.halfOpen) for (const cb of conn.handlers.pong ?? []) cb()
          }, 5)
        },
        on: ((ev: string, cb: (...a: unknown[]) => void) => {
          ;(conn.handlers[ev] ??= []).push(cb)
        }) as SocketLike['on']
      }
      // hello right after open, then whatever queued while nobody was connected
      this.clock.setTimeout(() => {
        if (!conn.open) return
        for (const cb of conn.handlers.open ?? []) cb()
        this.frame(conn, {
          type: 'hello',
          num_connections: this.openConnections(),
          debug_info: { host: 'applink-fake', build_number: 1, approximate_connection_time: 18060 },
          connection_info: { app_id: this.bot.appId }
        })
        const q = this.queue
        this.queue = []
        for (const p of q) this.send({ ...p, timer: null })
      }, 1)
      return like
    }
  }

  private closeConn(conn: Conn, code: number, reason: string): void {
    if (!conn.open) return
    conn.open = false
    if (conn.closeTimer) this.clock.clearTimeout(conn.closeTimer)
    // envelopes in flight on this connection are redelivered elsewhere (or queued) by their timers
    for (const cb of conn.handlers.close ?? []) cb(code, reason)
  }

  /** Server-initiated disconnect message; the server closes 10 s later if the client has not. */
  disconnect(reason: 'warning' | 'refresh_requested' | 'link_disabled'): void {
    const conn = this.conns.find((c) => c.open)
    if (!conn) return
    if (reason === 'link_disabled') this.linkDisabled = true
    this.frame(conn, { type: 'disconnect', reason, debug_info: { host: 'applink-fake' } })
    conn.closeTimer = this.clock.setTimeout(() => this.closeConn(conn, 1001, reason), reason === 'link_disabled' ? 100 : 10_000)
  }
  /** Abrupt drop (network gone). */
  dropSocket(): void {
    for (const c of this.conns.filter((x) => x.open)) this.closeConn(c, 1006, 'abnormal')
  }
  /** Stops answering pongs and delivering frames without closing (sleep / NAT timeout). */
  halfOpen(): void {
    for (const c of this.conns.filter((x) => x.open)) c.halfOpen = true
  }
}

export function cmpTs(a: string, b: string): number {
  const [as, au = '0'] = a.split('.')
  const [bs, bu = '0'] = b.split('.')
  return Number(as) - Number(bs) || Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0'))
}

/** Clock on the global timers (vitest fake timers drive it). */
export const globalClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}
