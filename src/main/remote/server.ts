/**
 * REMOTE.md RA1-RA3, RA6: the Phone server. HTTP + one WebSocket path, bound to 127.0.0.1 only on a random port. It
 * serves exactly the files of its own bundle (a fixed list read at start, never a path from the request), the pairing
 * route, and the Phone API, where every request carries a device token. Two ways to carry it:
 * - same-origin (the Mac serves the app): an httpOnly SameSite=Strict cookie, and every write the device's CSRF value;
 * - hosted (the app on its own https site): `Authorization: Bearer`, CORS for that one origin (exact match), and the
 *   socket's first message. A bearer is never sent by a browser on its own, so it needs no CSRF value.
 * Unknown Host headers are refused (DNS rebinding) in both. No Electron imports.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { matchRemoteRoute, REMOTE_AUTH_SCHEME, REMOTE_COOKIE, REMOTE_CSRF_HEADER, REMOTE_WS_AUTH_MS, type RemoteRouteName } from '../../shared/remote'
import { PairError, type RemoteAuth, type StoredDevice } from './auth'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface RemoteApi {
  /** One Phone API route (everything but pair and sign-out). Throws HttpError or HiveError-like { code }. */
  handle(name: RemoteRouteName, params: Record<string, string>, body: unknown, device: StoredDevice): Promise<unknown>
  /** A live socket of an authenticated device. */
  socket(ws: WebSocket, device: StoredDevice): void
}

export interface RemoteServerOptions {
  auth: RemoteAuth
  api: RemoteApi
  /** the built phone app (index.html, assets/…); null or missing = a plain "not built" page */
  bundleDir: string | null
  /** hosts besides 127.0.0.1:<port> and localhost:<port> that may call (the tunnel host) */
  extraHosts: () => string[]
  /** RA6: origins of the hosted phone app that may call cross-origin (exact match; never a wildcard) */
  allowedOrigins?: () => string[]
  /** how long a hosted socket may wait before its auth message (tests shorten it) */
  wsAuthMs?: number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
}
const BODY_MAX = 64 * 1024

/** url path -> absolute file, for every file under the bundle (built once; the request never names a disk path). */
export function bundleFiles(dir: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!dir || !fs.existsSync(dir)) return out
  const root = fs.realpathSync(dir)
  const walk = (d: string, depth: number): void => {
    if (depth > 4) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs, depth + 1)
      else if (e.isFile() && TYPES[path.extname(e.name)]) out.set(`/${path.relative(root, abs).split(path.sep).join('/')}`, abs)
    }
  }
  walk(root, 0)
  return out
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim()
    if (!(k in out)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

/** `Authorization: Bearer <token>` -> the token, else null (any other scheme, or junk). */
export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^\s*(\S+)\s+([A-Za-z0-9_-]{16,200})\s*$/.exec(header)
  return m && m[1]!.toLowerCase() === REMOTE_AUTH_SCHEME.toLowerCase() ? m[2]! : null
}

/**
 * Sockets that opened but have not said who they are yet (hosted mode). Origin is only a header, so a script outside a
 * browser can open these too: each caller (CF-Connecting-IP through the tunnel) may hold a few and open only so many a
 * minute, and when the whole pool is full the oldest waiting socket goes, never the newcomer. The real phone says who it
 * is within one round trip, so a flood can delay it at most until it reconnects, never shut it out.
 */
export const PENDING_MAX = 64
export const PENDING_PER_CALLER = 4
export const UPGRADES_PER_MINUTE = 30

export class RemoteServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private files = new Map<string, string>()
  private sockets = new Map<WebSocket, string>()
  /** waiting socket -> who opened it (insertion order = oldest first) */
  private pending = new Map<WebSocket, string>()
  /** caller -> times of their recent hosted upgrades (the attempt limit) */
  private upgrades = new Map<string, number[]>()
  private port = 0

  constructor(private readonly o: RemoteServerOptions) {}

  get listening(): boolean {
    return !!this.server?.listening
  }
  get localUrl(): string | null {
    return this.listening ? `http://127.0.0.1:${this.port}` : null
  }
  get address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null) ?? null
  }
  /** device ids with a live socket */
  onlineDevices(): Set<string> {
    return new Set(this.sockets.values())
  }

  async start(): Promise<number> {
    if (this.server) return this.port
    this.files = bundleFiles(this.o.bundleDir)
    const server = http.createServer((req, res) => void this.onRequest(req, res))
    server.headersTimeout = 15_000
    server.requestTimeout = 30_000
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      const gate = this.upgradeGate(req)
      const no = (status: string): void => {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      }
      if (!gate) return no('401 Unauthorized')
      const caller = gate === 'first-message' ? this.callerOf(req) : ''
      if (gate === 'first-message' && !this.mayWait(caller)) return no('429 Too Many Requests')
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (gate !== 'first-message') return this.admit(ws, gate)
        // RA6: the hosted app says who it is in its first message; nothing else is read before that
        this.makeRoom()
        this.pending.set(ws, caller)
        const timer = setTimeout(() => this.refuse(ws), this.o.wsAuthMs ?? REMOTE_WS_AUTH_MS)
        ws.once('message', (raw) => {
          clearTimeout(timer)
          this.pending.delete(ws)
          let token: unknown = null
          try {
            const m = JSON.parse(String(raw)) as { t?: unknown; token?: unknown }
            if (m?.t === 'auth') token = m.token
          } catch {
            /* not JSON: refused below */
          }
          const device = typeof token === 'string' ? this.o.auth.verify(token) : null
          if (!device || !this.server) return this.refuse(ws)
          this.admit(ws, device)
        })
        ws.on('close', () => {
          clearTimeout(timer)
          this.pending.delete(ws)
        })
      })
    })
    this.server = server
    this.wss = wss
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // RA1: loopback only. Never 0.0.0.0, never '::'.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.port = (server.address() as AddressInfo).port
    return this.port
  }

  /** a caller may hold PENDING_PER_CALLER waiting sockets and open UPGRADES_PER_MINUTE hosted sockets a minute */
  private mayWait(caller: string): boolean {
    const now = Date.now()
    const recent = (this.upgrades.get(caller) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= UPGRADES_PER_MINUTE) {
      this.upgrades.set(caller, recent)
      return false
    }
    let held = 0
    for (const c of this.pending.values()) if (c === caller) held++
    if (held >= PENDING_PER_CALLER) return false
    recent.push(now)
    this.upgrades.set(caller, recent)
    // the map never grows without bound: callers with nothing recent go
    if (this.upgrades.size > 1024) for (const [c, ts] of this.upgrades) if (!ts.some((t) => now - t < 60_000)) this.upgrades.delete(c)
    return true
  }
  /** the pool is full: the oldest waiting socket goes (a newcomer is never refused for someone else's flood) */
  private makeRoom(): void {
    while (this.pending.size >= PENDING_MAX) {
      const oldest = this.pending.keys().next().value as WebSocket | undefined
      if (!oldest) return
      this.refuse(oldest)
    }
  }

  private admit(ws: WebSocket, device: StoredDevice): void {
    this.sockets.set(ws, device.id)
    ws.on('close', () => this.sockets.delete(ws))
    this.o.api.socket(ws, device)
  }
  /** 4401: not signed in (unknown, revoked, or no auth message in time). The phone app shows how to pair again. */
  private refuse(ws: WebSocket): void {
    this.pending.delete(ws)
    try {
      ws.close(4401, 'unauthorized')
    } catch {
      /* gone */
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const ws of this.pending.keys()) {
      try {
        ws.terminate()
      } catch {
        /* gone */
      }
    }
    this.pending.clear()
    this.upgrades.clear()
    for (const ws of this.sockets.keys()) {
      try {
        ws.close(1001, 'off')
        ws.terminate()
      } catch {
        /* gone */
      }
    }
    this.sockets.clear()
    this.wss?.close()
    this.wss = null
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((r) => server.close(() => r()))
  }

  /** Closes the live sockets of one device (Revoke). */
  closeDevice(id: string): void {
    for (const [ws, dev] of this.sockets) {
      if (dev !== id) continue
      try {
        // the Phone API already said bye (revoked); this only closes
        ws.close(4401, 'revoked')
      } catch {
        /* gone */
      }
      this.sockets.delete(ws)
    }
  }

  private hostOk(host: string | undefined): boolean {
    if (!host) return false
    const h = host.toLowerCase()
    if (h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`) return true
    return this.o.extraHosts().some((x) => x.toLowerCase() === h)
  }

  /**
   * Who asks, for the pairing limit. Through the tunnel every request comes from cloudflared on this Mac, so the
   * caller is the address Cloudflare's edge puts in CF-Connecting-IP (the edge sets it; a client cannot). Locally it is
   * the socket's own address.
   */
  private callerOf(req: http.IncomingMessage): string {
    const host = (req.headers.host ?? '').toLowerCase()
    const viaTunnel = this.o.extraHosts().some((x) => x.toLowerCase() === host)
    const cf = req.headers['cf-connecting-ip']
    if (viaTunnel && typeof cf === 'string' && cf.trim()) return `cf:${cf.trim().slice(0, 64)}`
    return `local:${req.socket.remoteAddress ?? '?'}`
  }

  /** RA6: the hosted app's origin, exactly as configured (scheme, host and port), or false */
  private originAllowed(origin: string | string[] | undefined): origin is string {
    if (typeof origin !== 'string' || !origin) return false
    return (this.o.allowedOrigins?.() ?? []).some((o) => o === origin)
  }

  /** an Origin that is neither this host (the Mac's own page) nor the hosted app; no Origin (not a browser) is not foreign */
  private foreignOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !origin) return false
    if (this.originAllowed(origin)) return false
    try {
      return new URL(origin).host.toLowerCase() !== (req.headers.host ?? '').toLowerCase()
    } catch {
      return true
    }
  }

  /** The device and how it proved itself: a bearer (hosted, no CSRF) or the cookie (same-origin, CSRF on writes). */
  private deviceOf(req: http.IncomingMessage): { device: StoredDevice; bearer: boolean } | null {
    const auth = req.headers.authorization
    if (auth !== undefined) {
      // a bearer never falls back to a cookie: a bad one is a no
      const d = this.o.auth.verify(bearerOf(auth))
      return d ? { device: d, bearer: true } : null
    }
    const d = this.o.auth.verify(parseCookies(req.headers.cookie)[REMOTE_COOKIE])
    return d ? { device: d, bearer: false } : null
  }

  /**
   * Who may open the live socket: the page must be ours (same host, with the cookie) or the hosted app (allowed origin,
   * whose socket must name its token in the first message).
   */
  private upgradeGate(req: http.IncomingMessage): StoredDevice | 'first-message' | null {
    if (!this.hostOk(req.headers.host)) return null
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/live') return null
    const origin = req.headers.origin
    if (!origin) return null
    let oh: string
    try {
      oh = new URL(origin).host.toLowerCase()
    } catch {
      return null
    }
    // the Mac's own page: the cookie, checked now (as before RA6)
    if (oh === (req.headers.host ?? '').toLowerCase()) return this.o.auth.verify(parseCookies(req.headers.cookie)[REMOTE_COOKIE])
    // the hosted app: no cookie crosses origins, so the token comes in the first message
    return this.originAllowed(origin) ? 'first-message' : null
  }

  private secure(req: http.IncomingMessage): boolean {
    const h = (req.headers.host ?? '').toLowerCase()
    return !(h.startsWith('127.0.0.1:') || h.startsWith('localhost:'))
  }

  private headers(req: http.IncomingMessage, extra: Record<string, string> = {}): Record<string, string> {
    const host = req.headers.host ?? ''
    return {
      'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://${host} ws://${host}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...(this.secure(req) ? { 'strict-transport-security': 'max-age=31536000' } : {}),
      ...extra
    }
  }

  private json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = JSON.stringify(body ?? null)
    res.writeHead(status, this.headers(req, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...this.cors(req), ...extra }))
    res.end(text)
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.hostOk(req.headers.host)) {
        res.writeHead(421, { 'content-type': 'text/plain', connection: 'close' })
        return void res.end('Misdirected request')
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const method = req.method ?? 'GET'
      if (url.pathname.startsWith('/api/') && method === 'OPTIONS') return this.preflight(req, res)
      if (url.pathname.startsWith('/api/')) return await this.onApi(req, res, method, url.pathname)
      if (method !== 'GET' && method !== 'HEAD') return this.json(req, res, 405, { message: 'Not allowed' })
      return this.serveFile(req, res, url.pathname)
    } catch (e) {
      this.o.log?.warn('[remote] request failed', { e: e instanceof Error ? e.message : String(e) })
      if (!res.headersSent) this.json(req, res, 500, { message: 'Something went wrong on the Mac' })
      else res.end()
    }
  }

  /** RA6: CORS for the hosted app only, exact origin; no credentials (the bearer is a header, not a cookie). */
  private cors(req: http.IncomingMessage): Record<string, string> {
    const origin = req.headers.origin
    if (!this.originAllowed(origin)) return { vary: 'Origin' }
    return { 'access-control-allow-origin': origin, vary: 'Origin', 'cross-origin-resource-policy': 'cross-origin' }
  }
  private preflight(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin
    const method = String(req.headers['access-control-request-method'] ?? '').toUpperCase()
    const asked = String(req.headers['access-control-request-headers'] ?? '')
      .toLowerCase()
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    const okHeaders = asked.every((x) => x === 'authorization' || x === 'content-type' || x === 'accept')
    if (!this.originAllowed(origin) || (method !== 'GET' && method !== 'POST') || !okHeaders) {
      res.writeHead(403, { vary: 'Origin', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return void res.end('Not allowed')
    }
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'authorization, content-type, accept',
      'access-control-max-age': '600',
      vary: 'Origin',
      'cache-control': 'no-store'
    })
    res.end()
  }

  private serveFile(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const key = pathname === '/' ? '/index.html' : pathname
    const file = this.files.get(key) ?? (key.includes('.') ? undefined : this.files.get('/index.html'))
    if (!file) {
      if (!this.files.size) {
        res.writeHead(503, this.headers(req, { 'content-type': 'text/plain; charset=utf-8' }))
        return void res.end('The phone app is not built in this Principia.')
      }
      res.writeHead(404, this.headers(req, { 'content-type': 'text/plain; charset=utf-8' }))
      return void res.end('Not found')
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream'
    const hashed = key.startsWith('/assets/')
    res.writeHead(200, this.headers(req, { 'content-type': type, 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' }))
    if (req.method === 'HEAD') return void res.end()
    fs.createReadStream(file).pipe(res)
  }

  private async body(req: http.IncomingMessage): Promise<unknown> {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    // a cross-site form can only send form types: JSON is required for every write
    if (type !== 'application/json') throw new HttpError(415, 'Send JSON')
    const chunks: Buffer[] = []
    let n = 0
    for await (const c of req) {
      n += (c as Buffer).length
      if (n > BODY_MAX) throw new HttpError(413, 'Too large')
      chunks.push(c as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new HttpError(400, 'Bad JSON')
    }
  }

  private async onApi(req: http.IncomingMessage, res: http.ServerResponse, method: string, pathname: string): Promise<void> {
    const route = matchRemoteRoute(method, pathname)
    if (!route || route.name === 'live') return this.json(req, res, 404, { message: 'Not found' })
    try {
      if (route.name === 'pair') {
        // a page on another origin the Mac does not allow would get a cookie it can never use: refuse before the code
        // is spent, so the same link still works once the Mac's Phone app address is right
        if (this.foreignOrigin(req)) return this.json(req, res, 403, { message: 'Your Mac does not know this phone app yet. On your Mac, check Settings › App › Phone › Phone app address, then scan a new code.', code: 'origin' })
        const b = (await this.body(req)) as { code?: unknown; name?: unknown }
        const { token, device } = this.o.auth.pair(b?.code, b?.name, this.callerOf(req))
        // RA6: the hosted app (an allowed origin) keeps the token itself and sends it as a bearer; no cookie crosses
        if (this.originAllowed(req.headers.origin)) return this.json(req, res, 200, { device: { id: device.id, name: device.name }, token })
        const cookie = `${REMOTE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`
        return this.json(req, res, 200, { device: { id: device.id, name: device.name } }, { 'set-cookie': cookie })
      }
      const who = this.deviceOf(req)
      if (!who) return this.json(req, res, 401, { message: 'Open the pairing link from Principia on your Mac.' })
      const device = who.device
      if (method !== 'GET' && !who.bearer) {
        if (!this.o.auth.checkCsrf(device.id, req.headers[REMOTE_CSRF_HEADER] as string | undefined)) return this.json(req, res, 403, { message: 'Reload the page and try again.' })
      }
      const body = method === 'GET' ? {} : await this.body(req)
      if (route.name === 'signOut') {
        this.o.auth.revoke(device.id)
        this.closeDevice(device.id)
        return this.json(req, res, 200, { ok: true }, { 'set-cookie': `${REMOTE_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` })
      }
      // the one query value a route reads (the room's channel); path params always win
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('channelId')
      const params = { ...(q && /^[a-z]+_[0-9a-z]+$/.test(q) ? { channelId: q } : {}), ...route.params }
      const out = await this.o.api.handle(route.name, params, body, device)
      // the CSRF value rides on /api/me only (bound to this device)
      if (route.name === 'me') return this.json(req, res, 200, { ...(out as object), csrf: this.o.auth.csrfFor(device.id) })
      return this.json(req, res, 200, out ?? { ok: true })
    } catch (e) {
      if (e instanceof PairError) return this.json(req, res, e.code === 'rate_limited' ? 429 : 400, { message: e.message, code: e.code })
      if (e instanceof HttpError) return this.json(req, res, e.status, { message: e.message })
      const code = (e as { code?: string } | null)?.code
      const message = e instanceof Error ? e.message : 'Something went wrong'
      const status = code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'bad_request' || code === 'validation' ? 400 : code === 'forbidden' || code === 'not_implemented' ? 403 : 500
      if (status === 500) this.o.log?.warn('[remote] api failed', { route: route.name, e: message })
      return this.json(req, res, status, { message: status === 500 ? 'Something went wrong on the Mac' : message })
    }
  }
}
