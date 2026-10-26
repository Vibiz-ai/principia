/**
 * The live socket (/api/live): one WebSocket, a ping every 25 s, and reconnect with backoff. Same-origin it carries the
 * device cookie; hosted (REMOTE.md RA6) its first message is `{ t: 'auth', token }`: the token is never in the URL.
 * iPhone Safari drops sockets in the background: coming back to the page reconnects at once and asks for a refetch.
 */
import type { PhoneClientMsg, PhoneServerMsg } from '../../shared/remote'

export interface Live {
  send(m: PhoneClientMsg): void
  close(): void
  readonly connected: boolean
}

export function openLive(o: {
  onMessage(m: PhoneServerMsg): void
  onState(connected: boolean): void
  onReconnect(): void
  /** 4401 with no bye before it: the Mac does not know this token (hosted: signed out) */
  onUnauthorized?(): void
  url?: string
  /** hosted: the device token for the first message */
  token?: () => string | null
}): Live {
  let ws: WebSocket | null = null
  let closed = false
  let tries = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let ping: ReturnType<typeof setInterval> | null = null
  let last: PhoneClientMsg | null = null
  let up = false
  let byeSeen = false
  /** the open socket that has said who it is (hosted: auth went first); nothing else is sent before */
  let ready: WebSocket | null = null
  const url = o.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`
  const setUp = (v: boolean): void => {
    if (up === v) return
    up = v
    o.onState(v)
  }
  const connect = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = null
    try {
      ws = new WebSocket(url)
    } catch {
      return retry()
    }
    const sock = ws
    sock.onopen = () => {
      const again = tries > 0
      tries = 0
      const token = o.token?.()
      if (token) sock.send(JSON.stringify({ t: 'auth', token } satisfies PhoneClientMsg))
      ready = sock
      setUp(true)
      if (last) sock.send(JSON.stringify(last))
      if (again) o.onReconnect()
    }
    sock.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as PhoneServerMsg
        if (m.t === 'bye') byeSeen = true
        o.onMessage(m)
      } catch {
        /* not JSON */
      }
    }
    sock.onclose = (ev) => {
      if (ws !== sock) return
      ws = null
      ready = null
      setUp(false)
      if (ev.code === 4401 && !byeSeen && o.onUnauthorized) {
        closed = true
        return o.onUnauthorized()
      }
      // 4401 revoked / 1001 Phone turned off: the bye message already said so; keep trying slowly in case it comes back
      retry(ev.code === 4401 ? 30_000 : undefined)
    }
    sock.onerror = () => sock.close()
  }
  const retry = (min?: number): void => {
    if (closed || timer) return
    tries++
    const wait = min ?? Math.min(15_000, 500 * 2 ** Math.min(tries, 5))
    timer = setTimeout(connect, wait)
  }
  const kick = (): void => {
    if (closed) return
    if (!ws || ws.readyState > 1) {
      tries = Math.max(tries, 1)
      if (timer) clearTimeout(timer)
      timer = null
      connect()
    }
  }
  ping = setInterval(() => {
    if (ready && ready.readyState === 1) ready.send(JSON.stringify({ t: 'ping' }))
  }, 25_000)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick())
  window.addEventListener('online', kick)
  window.addEventListener('pageshow', kick)
  connect()
  return {
    send(m) {
      if (m.t === 'sub') last = m
      if (ready && ready.readyState === 1) ready.send(JSON.stringify(m))
    },
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      if (ping) clearInterval(ping)
      ws?.close()
    },
    get connected() {
      return up
    }
  }
}
