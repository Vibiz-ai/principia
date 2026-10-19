/**
 * Production transport (SLACK.md §2.4): HttpPort on global fetch, SocketPort on `ws`. The URL guard is code, not a
 * setting: API_BASE is a const, the method name is pattern-checked, and a socket URL must be wss:// on slack.com or a
 * subdomain. There is NO base-URL override of any kind; tests and the dev-only fake replace these objects instead.
 */
import WebSocket from 'ws'
import { HiveError } from '../../../../shared/errors'
import type { HttpPort, HttpResponse, SocketLike, SocketPort } from '../core/ports'

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

export const nodeHttp: HttpPort = {
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
