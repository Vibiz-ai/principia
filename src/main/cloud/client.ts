/**
 * Principia Cloud, the desktop's HTTP client (docs/CLOUD.md §6). Typed over CLOUD_ROUTES and routePath, with the
 * device token as a Bearer, a 15 s timeout, CloudError -> HiveError mapping, and an SSE reader for /v1/events with
 * reconnect and backoff. Nothing here logs a token, a request body or a response body.
 */
import { HiveError } from '../../shared/errors'
import type { HiveErrorCode } from '../../shared/types'
import { routeMethod, routePath, type CloudError, type CloudErrorCode, type CloudEvent, type CloudRouteName } from '../../shared/cloud'

export const CLOUD_TIMEOUT_MS = 15_000
/** company create carries the passport bundle (up to 20 MB) */
export const CLOUD_BUNDLE_TIMEOUT_MS = 120_000

/** A failed cloud call: a HiveError (so IPC carries a code) that keeps the cloud's own code, status and rev. */
export class CloudRequestError extends HiveError {
  readonly cloudCode: CloudErrorCode | 'network' | 'timeout'
  readonly status: number
  readonly rev?: number
  constructor(code: HiveErrorCode, message: string, cloudCode: CloudRequestError['cloudCode'], status: number, rev?: number) {
    super(code, message)
    this.cloudCode = cloudCode
    this.status = status
    if (rev !== undefined) this.rev = rev
  }
}

const HIVE_CODE: Record<CloudErrorCode, HiveErrorCode> = {
  bad_request: 'bad_request',
  unauthorized: 'forbidden',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  quota_exceeded: 'conflict',
  paused: 'conflict',
  payload_too_large: 'bad_request',
  rate_limited: 'conflict',
  unavailable: 'internal',
  internal: 'internal',
  not_in_v1: 'not_implemented'
}

/** Plain sentences for the codes whose server message is not for founders. */
const PLAIN: Partial<Record<CloudErrorCode, string>> = {
  unauthorized: 'This Mac is no longer connected to your cloud. Paste a new connect link.',
  rate_limited: 'Too many tries. Wait a few minutes and try again.',
  paused: 'Your cloud is paused. Resume it to run anything.',
  unavailable: 'Your cloud is running, but a part of it is down. Try again in a minute.',
  not_in_v1: 'This is not in Principia Cloud yet.'
}

export function toCloudError(status: number, body: unknown): CloudRequestError {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<CloudError>
  const known = typeof b.error === 'string' && b.error in HIVE_CODE
  const code: CloudErrorCode = known ? (b.error as CloudErrorCode) : status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 429 ? 'rate_limited' : status === 501 ? 'not_in_v1' : status >= 500 ? 'internal' : 'bad_request'
  const message = PLAIN[code] ?? (typeof b.message === 'string' && b.message ? b.message.slice(0, 400) : `Your cloud answered ${status}.`)
  return new CloudRequestError(HIVE_CODE[code], message, code, status, typeof b.rev === 'number' ? b.rev : undefined)
}

export interface CloudClientOptions {
  /** control plane base URL (no trailing slash) */
  url: string
  /** device token; absent for pairing */
  token?: string | null
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface CallOptions {
  params?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  timeoutMs?: number
}

export class CloudClient {
  readonly url: string
  private token: string | null
  private f: typeof fetch
  private timeoutMs: number
  constructor(o: CloudClientOptions) {
    this.url = o.url.replace(/\/+$/, '')
    this.token = o.token ?? null
    this.f = o.fetch ?? fetch
    this.timeoutMs = o.timeoutMs ?? CLOUD_TIMEOUT_MS
  }

  /** `/v1/runs/x?tail=200` from a route name, params and query. */
  path(route: CloudRouteName, params: Record<string, string> = {}, query: CallOptions['query'] = {}): string {
    const q = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    const qs = q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : ''
    return `${routePath(route, params)}${qs}`
  }

  private headers(json: boolean): Record<string, string> {
    return { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }
  }

  /** One JSON call. Throws CloudRequestError (network, timeout or the server's CloudError). 204 resolves undefined. */
  async call<T>(route: CloudRouteName, o: CallOptions = {}): Promise<T> {
    const method = routeMethod(route)
    const hasBody = o.body !== undefined && method !== 'GET'
    let res: Response
    try {
      res = await this.f(`${this.url}${this.path(route, o.params, o.query)}`, {
        method,
        headers: this.headers(hasBody),
        ...(hasBody ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? this.timeoutMs)
      })
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new CloudRequestError(
        'internal',
        timeout ? `Your cloud at ${this.url} did not answer in time.` : `Can't reach your cloud at ${this.url}. Check that it is running and reachable from this Mac.`,
        timeout ? 'timeout' : 'network',
        0
      )
    }
    if (res.status === 204) return undefined as T
    let body: unknown = null
    const text = await res.text().catch(() => '')
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    if (!res.ok) throw toCloudError(res.status, body)
    return body as T
  }

  /**
   * GET /v1/events as Server-Sent Events, reconnecting with backoff (1 s doubling to 30 s, reset after a good
   * connection). A stream silent for `idleMs` (the server sends a heartbeat every 20 s) is dropped and reopened.
   */
  events(onEvent: (e: CloudEvent) => void, o: { runId?: string; onOpen?: () => void; onError?: (e: unknown) => void; idleMs?: number; maxBackoffMs?: number; minBackoffMs?: number } = {}): { close(): void } {
    let closed = false
    let ctrl: AbortController | null = null
    let timer: NodeJS.Timeout | null = null
    let backoff = o.minBackoffMs ?? 1000
    const max = o.maxBackoffMs ?? 30_000
    const idleMs = o.idleMs ?? 60_000
    const loop = async (): Promise<void> => {
      while (!closed) {
        ctrl = new AbortController()
        let idle: NodeJS.Timeout | null = null
        const kick = (): void => {
          if (idle) clearTimeout(idle)
          idle = setTimeout(() => ctrl?.abort(), idleMs)
        }
        try {
          const res = await this.f(`${this.url}${this.path('events', {}, { runId: o.runId })}`, {
            headers: { accept: 'text/event-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
            signal: ctrl.signal
          })
          if (!res.ok || !res.body) throw toCloudError(res.status, null)
          o.onOpen?.()
          backoff = o.minBackoffMs ?? 1000
          kick()
          const parser = sseParser((ev) => {
            try {
              const data = JSON.parse(ev.data) as Record<string, unknown>
              const kind = (data.kind as string | undefined) ?? ev.event
              if (kind) onEvent({ ...data, kind } as CloudEvent)
            } catch {
              /* not JSON: ignore */
            }
          })
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            kick()
            parser(dec.decode(value, { stream: true }))
          }
        } catch (e) {
          if (closed) return
          o.onError?.(e)
          // a revoked device never comes back by retrying
          if (e instanceof CloudRequestError && e.cloudCode === 'unauthorized') return
        } finally {
          if (idle) clearTimeout(idle)
        }
        if (closed) return
        await new Promise<void>((r) => (timer = setTimeout(r, backoff)))
        backoff = Math.min(max, backoff * 2)
      }
    }
    void loop()
    return {
      close: () => {
        closed = true
        if (timer) clearTimeout(timer)
        ctrl?.abort()
      }
    }
  }
}

/** Incremental `text/event-stream` parser: feed chunks, get `{event, data}` per blank-line-terminated block. */
export function sseParser(onMessage: (m: { event: string | null; data: string }) => void): (chunk: string) => void {
  let buf = ''
  return (chunk: string) => {
    buf += chunk.replace(/\r\n?/g, '\n')
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event: string | null = null
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const c = line.indexOf(':')
        const field = c < 0 ? line : line.slice(0, c)
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length) onMessage({ event, data: data.join('\n') })
    }
  }
}
