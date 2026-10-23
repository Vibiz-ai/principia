/**
 * Production transport (SLACK.md §2.4): HttpPort on global fetch, SocketPort on `ws`. The URL guard is code, not a
 * setting: API_BASE is a const, the method name is pattern-checked, and a socket URL must be wss:// on slack.com or a
 * subdomain. There is NO base-URL override of any kind; tests and the dev-only fake replace these objects instead.
 */
import WebSocket from 'ws'
import { HiveError } from '../../../../shared/errors'
import type { HttpDownload, HttpPort, HttpResponse, SocketLike, SocketPort } from '../core/ports'

export const API_BASE = 'https://slack.com/api/'
const METHOD_RE = /^[a-z]+(\.[a-zA-Z]+)+$/

export function assertSlackSocketUrl(url: string): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new HiveError('forbidden', 'Not a Slack Socket Mode URL')
  }
  if (u.protocol !== 'wss:' || !(u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'))) {
    throw new HiveError('forbidden', `Refusing a socket to ${u.protocol}//${u.hostname}: Slack sockets must be wss:// on slack.com`)
  }
  return u
}

export function formBody(body: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  return p.toString()
}

/** SLACK.md §9.6: the only image types an agent gets (what the vision models accept). */
export const DOWNLOAD_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const DOWNLOAD_MAX_HOPS = 3
export const DOWNLOAD_TIMEOUT_MS = 15_000

/** True for https://files.slack.com/… or another https *.slack.com host (no credentials, default port). */
export function isSlackFileUrl(u: URL): boolean {
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    (u.port === '' || u.port === '443') &&
    (u.hostname === 'files.slack.com' || u.hostname.endsWith('.slack.com'))
  )
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * GET one auth-gated Slack file. The bot token is sent only to Slack file hosts: the URL is checked before the request
 * and every redirect hop is followed by hand (max 3) and checked again; a hop anywhere else is refused, never followed
 * without the header. Errors never carry the token or the URL.
 */
export async function slackDownload(
  req: { url: string; token: string; maxBytes: number; signal?: AbortSignal },
  fetchImpl: FetchLike = fetch,
  timeoutMs = DOWNLOAD_TIMEOUT_MS
): Promise<HttpDownload> {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    throw new HiveError('forbidden', 'Not a Slack file URL')
  }
  if (!isSlackFileUrl(url)) throw new HiveError('forbidden', 'Refusing to download a file that is not hosted by Slack')
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${req.token}` }, redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      const loc = res.headers.get('location')
      if (!loc) throw new HiveError('forbidden', `Slack redirected without a location (${res.status})`)
      if (hop >= DOWNLOAD_MAX_HOPS) throw new HiveError('forbidden', 'Too many redirects downloading a Slack file')
      let next: URL
      try {
        next = new URL(loc, url)
      } catch {
        throw new HiveError('forbidden', 'Slack redirected to an invalid URL')
      }
      if (!isSlackFileUrl(next)) throw new HiveError('forbidden', 'Refusing a redirect that leaves Slack while downloading a file')
      url = next
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new HiveError('forbidden', `Slack file download failed (HTTP ${res.status})`)
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type === 'text/html') {
      await res.body?.cancel().catch(() => undefined)
      throw new HiveError('forbidden', 'Slack returned a login page instead of the file: reinstall the Slack app with the files:read scope')
    }
    if (!DOWNLOAD_IMAGE_TYPES.includes(type)) {
      await res.body?.cancel().catch(() => undefined)
      throw new HiveError('forbidden', `Not a supported image (${type || 'no content type'})`)
    }
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > req.maxBytes) {
      await res.body?.cancel().catch(() => undefined)
      throw new HiveError('forbidden', `Image too large (${declared} bytes)`)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > req.maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new HiveError('forbidden', `Image too large (over ${req.maxBytes} bytes)`)
        }
        chunks.push(value)
      }
    }
    const bytes = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      bytes.set(c, off)
      off += c.byteLength
    }
    return { contentType: type, bytes }
  }
}

export const nodeHttp: HttpPort = {
  download: (req) => slackDownload(req),
  async call(req): Promise<HttpResponse> {
    if (!METHOD_RE.test(req.method)) throw new HiveError('forbidden', `Invalid Slack method ${req.method}`)
    const res = await fetch(API_BASE + req.method, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.token}`,
        'Content-Type': req.json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded'
      },
      body: req.json ? JSON.stringify(req.body) : formBody(req.body),
      signal: req.signal,
      redirect: 'error'
    })
    const ra = res.headers.get('retry-after')
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, headers: { retryAfter: ra && /^\d+$/.test(ra) ? Number(ra) : null, scopes: res.headers.get('x-oauth-scopes') }, body }
  }
}

export const nodeSocket: SocketPort = {
  open(url: string): SocketLike {
    assertSlackSocketUrl(url)
    const ws = new WebSocket(url, { handshakeTimeout: 10_000, followRedirects: false, maxPayload: 8 * 1024 * 1024 })
    const like: SocketLike = {
      send: (t) => ws.send(t),
      close: (code, reason) => {
        try {
          ws.close(code ?? 1000, reason)
        } catch {
          ws.terminate()
        }
      },
      ping: () => ws.ping(),
      on: ((ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === 'message') ws.on('message', (data: WebSocket.RawData) => cb(data.toString()))
        else if (ev === 'close') ws.on('close', (code: number, reason: Buffer) => cb(code, reason.toString()))
        else if (ev === 'error') ws.on('error', (e: Error) => cb(e))
        else ws.on(ev as 'open' | 'pong' | 'ping', () => cb())
      }) as SocketLike['on']
    }
    return like
  }
}
