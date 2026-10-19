/**
 * Slack Web API client (SLACK.md §5). Every call goes through the limiter. 429 / `ratelimited` -> block the method for
 * Retry-After (default 30 s) and requeue at the front of its lane (not an attempt). Transient failures retry 3x at
 * 1 s, 4 s and 15 s with jitter, except for calls that opt out (`retryTransient: false`, chat.postMessage). Permanent errors map to HiveErrors; auth errors are SlackAuthError so the connector
 * can move to `error`. Tokens never appear in an error or log line.
 */
import { HiveError } from '../../../../shared/errors'
import { keysFor, type Lane, type Limiter } from './limiter'
import type { Clock, HttpPort, Logger } from './ports'

export const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type', 'no_permission'])
const TRANSIENT = new Set(['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable', 'network', 'timeout'])
const RETRY_DELAYS = [1000, 4000, 15000]

export class SlackApiError extends Error {
  constructor(
    readonly slack: string,
    readonly method: string,
    readonly needed: string | null = null,
    /** A timeout, network error, 5xx or bad body: Slack may or may not have done the work. */
    readonly transient = false
  ) {
    super(`${method}: ${slack}${needed ? ` (needs ${needed})` : ''}`)
    this.name = 'SlackApiError'
  }
  get isAuth(): boolean {
    return AUTH_ERRORS.has(this.slack)
  }
  /** Readable HiveError for IPC and tool results (SLACK.md §5.2). */
  toHive(channelLabel?: string): HiveError {
    const ch = channelLabel ? ` ${channelLabel}` : ' the channel'
    switch (this.slack) {
      case 'not_in_channel':
      case 'channel_not_found':
        return new HiveError('not_found', `Invite @hive to${ch}, then retry`)
      case 'missing_scope':
        return new HiveError('forbidden', `Reinstall the Slack app: missing ${this.needed ?? 'a scope'}`)
      case 'is_archived':
        return new HiveError('validation', `${channelLabel ?? 'The channel'} is archived`)
      case 'msg_too_long':
        return new HiveError('validation', 'The message is too long for Slack')
      case 'no_text':
        return new HiveError('validation', 'The message is empty')
      case 'ratelimited':
        return new HiveError('conflict', 'Slack asked Hive to slow down; try again shortly')
      default:
        if (this.isAuth) return new HiveError('forbidden', 'Slack rejected the token. Reconnect in Settings › Connections.')
        return new HiveError('internal', `Slack error: ${this.slack}`)
    }
  }
}

export interface ApiCallOpts {
  lane: Lane
  token: 'bot' | 'app'
  /** chat.postMessage: per-channel 1/s bucket. */
  channel?: string | null
  json?: boolean
  timeoutMs?: number
  /**
   * false: a transient failure (timeout, network, 5xx, bad body, Slack internal error) throws at once as a
   * SlackApiError with `transient: true` instead of retrying. Used for non-idempotent writes (chat.postMessage), where
   * Slack may have accepted the request before the failure; the caller resolves it (outbox: metadata lookup).
   * 429 / ratelimited is still requeued: Slack did not do the work.
   */
  retryTransient?: boolean
}
export interface ApiResult<T = Record<string, unknown>> {
  body: T
  scopes: string | null
}

export class SlackApi {
  /** Called once per auth failure (token revoked mid-session). */
  onAuthError: (e: SlackApiError) => void = () => {}

  constructor(
    private d: {
      http: HttpPort
      limiter: Limiter
      clock: Clock
      log: Logger
      token(kind: 'bot' | 'app'): Promise<string | null>
      random?: () => number
    }
  ) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => this.d.clock.setTimeout(r, ms))
  }

  async call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>, opts: ApiCallOpts, tokenOverride?: string): Promise<ApiResult<T>> {
    const token = tokenOverride ?? (await this.d.token(opts.token))
    if (!token) throw new HiveError('conflict', 'Slack is not connected')
    let attempt = 0
    let front = false
    const rnd = this.d.random ?? Math.random
    for (;;) {
      await this.d.limiter.acquire(keysFor(method, opts.channel), opts.lane, { front })
      front = false
      let status = 0
      let retryAfter: number | null = null
      let scopes: string | null = null
      let resBody: Record<string, unknown> | null = null
      let transient: string | null = null
      try {
        const ac = new AbortController()
        const timeoutMs = opts.timeoutMs ?? (opts.lane === 'interactive' ? 15_000 : 30_000)
        let timedOut = false
        const t = this.d.clock.setTimeout(() => {
          timedOut = true
          ac.abort()
        }, timeoutMs)
        try {
          const r = await Promise.race([
            this.d.http.call({ method, token, body, json: opts.json, signal: ac.signal }),
            new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('timeout')), { once: true }))
          ])
          status = r.status
          retryAfter = r.headers.retryAfter
          scopes = r.headers.scopes
          resBody = r.body && typeof r.body === 'object' ? (r.body as Record<string, unknown>) : null
        } finally {
          this.d.clock.clearTimeout(t)
          if (timedOut) transient = 'timeout'
        }
      } catch (e) {
        transient = transient ?? 'network'
        this.d.log.warn('slack api network error', { method, e: e instanceof Error ? e.message : String(e) })
      }
      if (!transient) {
        if (status === 429 || resBody?.error === 'ratelimited') {
          const secs = retryAfter ?? 30
          this.d.limiter.block(method, this.d.clock.now() + secs * 1000)
          this.d.log.warn('slack rate limited', { method, retryAfter: secs })
          front = true
          continue
        }
        if (status >= 500 || !resBody) transient = status >= 500 ? `http_${status}` : 'bad_body'
        else if (resBody.ok !== true && TRANSIENT.has(String(resBody.error))) transient = String(resBody.error)
      }
      if (transient) {
        if (opts.retryTransient === false || attempt >= RETRY_DELAYS.length) throw new SlackApiError(transient, method, null, true)
        const base = RETRY_DELAYS[attempt++]
        await this.sleep(Math.round(base * (0.75 + rnd() * 0.5)))
        continue
      }
      const b = resBody as Record<string, unknown>
      if (b.ok !== true) {
        const err = new SlackApiError(String(b.error ?? 'unknown_error'), method, typeof b.needed === 'string' ? b.needed : null)
        if (err.isAuth && !tokenOverride) this.onAuthError(err)
        throw err
      }
      return { body: b as T, scopes }
    }
  }

  /** Cursor pagination (`response_metadata.next_cursor`), up to maxPages. onPage persists the cursor after every page. */
  async paginate<T = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown>,
    opts: ApiCallOpts,
    onPage: (page: T, nextCursor: string | null) => Promise<boolean | void>,
    maxPages = 50
  ): Promise<{ pages: number; nextCursor: string | null }> {
    let cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : null
    let pages = 0
    for (;;) {
      const { body: page } = await this.call<T>(method, { ...body, ...(cursor ? { cursor } : {}) }, opts)
      const next = ((page as Record<string, unknown>).response_metadata as { next_cursor?: string } | undefined)?.next_cursor || null
      pages++
      const stop = await onPage(page, next)
      cursor = next
      if (!next || stop === true || pages >= maxPages) return { pages, nextCursor: next }
    }
  }
}
