/**
 * REMOTE.md RA6: the Phone server in hosted mode. CORS for exactly one origin (and its preflight), the bearer token (no
 * CSRF, no cookie), the socket's first-message auth (refused without it, refused when revoked, closed on Revoke and
 * Turn off), the Host allowlist still in force, the token never in a URL or a log line, and the pairing link format.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { WebSocket } from 'ws'
import { REMOTE_CSRF_HEADER, type PhoneServerMsg } from '@shared/remote'
import { RemoteAuth } from './auth'
import { PENDING_MAX, PENDING_PER_CALLER, RemoteServer, UPGRADES_PER_MINUTE, bearerOf, type RemoteApi } from './server'
import { RemoteService } from './service'
import type { PhoneHost } from './api'

const SITE = 'https://phone.example.com'
const TUNNEL = 'quiet-tree-42.trycloudflare.com'

/** an API that answers every route with its name and the device, and greets sockets */
function fakeApi(): RemoteApi & { seen: { name: string; device: string }[] } {
  const seen: { name: string; device: string }[] = []
  return {
    seen,
    async handle(name, _params, _body, device) {
      seen.push({ name, device: device.id })
      return name === 'me' ? { device: { id: device.id, name: device.name }, host: 'mac', companies: [] } : { ok: true }
    },
    socket(ws) {
      ws.send(JSON.stringify({ t: 'hello' } satisfies PhoneServerMsg))
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { t: string }
        if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
      })
    }
  }
}

describe('RemoteServer, hosted mode (RA6)', () => {
  let server: RemoteServer
  let auth: RemoteAuth
  let api: ReturnType<typeof fakeApi>
  let base: string
  let host: string
  let logs: string[]
  let allowed: string[]
  beforeEach(async () => {
    auth = new RemoteAuth()
    api = fakeApi()
    logs = []
    allowed = [SITE]
    const log = { warn: (m: string, meta?: Record<string, unknown>) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`) }
    server = new RemoteServer({ auth, api, bundleDir: null, extraHosts: () => [TUNNEL], allowedOrigins: () => allowed, wsAuthMs: 300, log })
    const port = await server.start()
    base = `http://127.0.0.1:${port}`
    host = `127.0.0.1:${port}`
  })
  afterEach(async () => {
    await server.stop()
  })

  const pairFrom = async (origin: string | null): Promise<Response> =>
    fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ code: auth.createCode().code, name: 'iPhone' }) })
  const bearer = async (): Promise<string> => {
    const r = await pairFrom(SITE)
    expect(r.status).toBe(200)
    const b = (await r.json()) as { token?: string }
    expect(b.token).toBeTruthy()
    return b.token!
  }

  it('pairing from the hosted site returns the token in the body and sets no cookie', async () => {
    const r = await pairFrom(SITE)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(r.headers.get('access-control-allow-credentials')).toBeNull()
    const b = (await r.json()) as { token: string; device: { id: string } }
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // only the hash is kept on the Mac
    expect(JSON.stringify(auth.devices())).not.toContain(b.token)
  })
  it('pairing from any other origin gets no token, and the code is not spent (no orphan device)', async () => {
    for (const o of ['https://evil.example.com', 'https://phone.example.com.evil.com', 'http://phone.example.com', 'https://PHONE.example.com:443x']) {
      const code = auth.createCode().code
      const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', origin: o }, body: JSON.stringify({ code, name: 'iPhone' }) })
      expect(r.status).toBe(403)
      expect(r.headers.get('set-cookie')).toBeNull()
      expect(((await r.json()) as { token?: string }).token).toBeUndefined()
      expect(r.headers.get('access-control-allow-origin')).toBeNull()
      // the same code still pairs from the right place
      const ok = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify({ code, name: 'iPhone' }) })
      expect(ok.status).toBe(200)
    }
    expect(auth.devices()).toHaveLength(4)
    // the Mac's own page (Origin = its host) and a non-browser (no Origin) take the cookie path
    for (const o of [base, null]) {
      const r = await pairFrom(o)
      expect(r.status).toBe(200)
      expect(((await r.json()) as { token?: string }).token).toBeUndefined()
      expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/)
    }
  })
  it('CORS answers exactly the configured origin, never a wildcard, never another site', async () => {
    const token = await bearer()
    const get = (origin: string) => fetch(`${base}/api/me`, { headers: { origin, authorization: `Bearer ${token}` } })
    const ok = await get(SITE)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(ok.headers.get('vary')).toMatch(/Origin/)
    for (const o of ['https://evil.example.com', `${SITE}.evil.com`, 'null', `${SITE}:8443`, 'http://phone.example.com']) {
      const r = await get(o)
      expect(r.headers.get('access-control-allow-origin')).toBeNull()
    }
    // no origin configured: no CORS for anyone
    allowed = []
    expect((await get(SITE)).headers.get('access-control-allow-origin')).toBeNull()
  })
  it('preflight: 204 for the site with GET/POST and our headers; 403 for anyone or anything else', async () => {
    const pre = (origin: string, method = 'POST', headers = 'authorization, content-type') =>
      fetch(`${base}/api/c/co_a/pause`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers } })
    const ok = await pre(SITE)
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST')
    expect(ok.headers.get('access-control-allow-headers')).toMatch(/authorization/)
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull()
    expect((await pre('https://evil.example.com')).status).toBe(403)
    expect((await pre('https://evil.example.com')).headers.get('access-control-allow-origin')).toBeNull()
    expect((await pre(SITE, 'DELETE')).status).toBe(403)
    expect((await pre(SITE, 'POST', 'authorization, x-evil')).status).toBe(403)
    expect((await pre(SITE, 'GET', 'authorization')).status).toBe(204)
  })
  it('the bearer token is the auth: no CSRF needed, a bad or revoked one is a 401, a cookie never rescues it', async () => {
    const token = await bearer()
    const post = (auth_: string) => fetch(`${base}/api/c/co_a/pause`, { method: 'POST', headers: { origin: SITE, authorization: auth_, 'content-type': 'application/json' }, body: '{"paused":true}' })
    expect((await post(`Bearer ${token}`)).status).toBe(200)
    expect(api.seen.at(-1)?.name).toBe('pause')
    expect((await post('Bearer ' + 'x'.repeat(43))).status).toBe(401)
    expect((await post(`Basic ${token}`)).status).toBe(401)
    expect((await post(token)).status).toBe(401)
    // JSON is still required for every write
    expect((await fetch(`${base}/api/c/co_a/pause`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
    auth.revoke(auth.devices()[0]!.id)
    expect((await post(`Bearer ${token}`)).status).toBe(401)
  })
  it('the cookie path still needs its CSRF value (a bearer does not unlock it)', async () => {
    const r = await pairFrom(null)
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!
    const url = `${base}/api/c/co_a/pause`
    expect((await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { csrf: string }
    expect((await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json', [REMOTE_CSRF_HEADER]: me.csrf }, body: '{}' })).status).toBe(200)
  })
  it('the Host allowlist still applies to hosted calls (DNS rebinding)', async () => {
    const token = await bearer()
    const port = server.address!.port
    const raw = (h: string) =>
      new Promise<number>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET /api/me HTTP/1.1\r\nHost: ${h}\r\nOrigin: ${SITE}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`))
        let buf = ''
        s.on('data', (c) => (buf += c.toString()))
        s.on('end', () => resolve(Number(/HTTP\/1\.1 (\d+)/.exec(buf)?.[1])))
      })
    expect(await raw('evil.example.com')).toBe(421)
    expect(await raw('phone.example.com')).toBe(421)
    expect(await raw(TUNNEL)).toBe(200)
  })

  // ---------- the live socket ----------
  const open = (origin: string, first?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ msgs: string[]; code: number | null; refused: boolean }>((resolve) => {
      const ws = new WebSocket(`ws://${host}/api/live`, { headers: { origin, ...headers } })
      const msgs: string[] = []
      let done = false
      const end = (r: { code: number | null; refused: boolean }) => {
        if (done) return
        done = true
        resolve({ msgs, ...r })
      }
      ws.on('open', () => {
        if (first !== undefined) ws.send(typeof first === 'string' ? first : JSON.stringify(first))
        ws.send(JSON.stringify({ t: 'ping' }))
      })
      ws.on('message', (m) => {
        msgs.push(String(m))
        if (msgs.length >= 2) ws.close()
      })
      ws.on('close', (code) => end({ code, refused: false }))
      ws.on('unexpected-response', () => end({ code: null, refused: true }))
      ws.on('error', () => end({ code: null, refused: true }))
    })

  it('a socket from the site signs in with its first message; then it is live', async () => {
    const token = await bearer()
    const r = await open(SITE, { t: 'auth', token })
    expect(r.msgs.map((m) => JSON.parse(m).t)).toEqual(['hello', 'pong'])
  })
  it('without the auth message (or with junk first) the socket is closed 4401, and nothing is answered', async () => {
    await bearer()
    const none = await open(SITE)
    expect(none.code).toBe(4401)
    expect(none.msgs).toEqual([])
    const junk = await open(SITE, 'not json')
    expect(junk.code).toBe(4401)
    const wrong = await open(SITE, { t: 'auth', token: 'x'.repeat(43) })
    expect(wrong.code).toBe(4401)
    expect(wrong.msgs).toEqual([])
  })
  it('a revoked token is refused on the socket, and Revoke closes a live one', async () => {
    const token = await bearer()
    const id = auth.devices()[0]!.id
    const live = new WebSocket(`ws://${host}/api/live`, { headers: { origin: SITE } })
    const closed = new Promise<number>((resolve) => live.on('close', (c) => resolve(c)))
    await new Promise<void>((resolve) => live.on('open', () => (live.send(JSON.stringify({ t: 'auth', token })), resolve())))
    await new Promise<void>((resolve) => live.once('message', () => resolve()))
    auth.revoke(id)
    server.closeDevice(id)
    expect(await closed).toBe(4401)
    const again = await open(SITE, { t: 'auth', token })
    expect(again.code).toBe(4401)
    expect(again.msgs).toEqual([])
  })
  it('the socket refuses other origins outright, and the token is never read from the URL', async () => {
    const token = await bearer()
    expect((await open('https://evil.example.com', { t: 'auth', token })).refused).toBe(true)
    const viaUrl = await new Promise<number | null>((resolve) => {
      const ws = new WebSocket(`ws://${host}/api/live?token=${token}`, { headers: { origin: SITE } })
      ws.on('message', () => resolve(-1))
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => resolve(null))
    })
    expect(viaUrl).toBe(4401)
  })
  it('a flood of sockets that never sign in cannot shut the phone out (per-caller cap, attempt limit, oldest goes)', async () => {
    const token = await bearer()
    const raw = (): Promise<number> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://${host}/api/live`, { headers: { origin: SITE } })
        ws.on('open', () => resolve(101))
        ws.on('unexpected-response', (_q, res) => (resolve(res.statusCode ?? 0), ws.terminate()))
        ws.on('error', () => resolve(0))
      })
    // one caller: a few waiting sockets at most, then 429
    const statuses: number[] = []
    for (let i = 0; i < PENDING_PER_CALLER + 2; i++) statuses.push(await raw())
    expect(statuses.slice(0, PENDING_PER_CALLER).every((s) => s === 101)).toBe(true)
    expect(statuses.slice(PENDING_PER_CALLER)).toEqual([429, 429])
    // once those time out, the same caller is let in again and signs in
    await new Promise((r) => setTimeout(r, 400))
    const r = await open(SITE, { t: 'auth', token })
    expect(r.msgs.map((m) => JSON.parse(m).t)).toEqual(['hello', 'pong'])
  })
  it('the attempt limit: a caller that keeps opening sockets is refused for the rest of the minute', async () => {
    const token = await bearer()
    let refused = 0
    for (let i = 0; i < UPGRADES_PER_MINUTE + 3; i++) {
      const r = await open(SITE, { t: 'auth', token })
      if (r.refused) refused++
    }
    expect(refused).toBe(3)
  })
  it('a full pool drops its oldest waiting socket, never the newcomer', async () => {
    const token = await bearer()
    // many callers through the tunnel (Cloudflare's edge sets CF-Connecting-IP)
    const opened: WebSocket[] = []
    const closes: Promise<number>[] = []
    for (let i = 0; i < PENDING_MAX; i++) {
      const ws = new WebSocket(`ws://${host}/api/live`, { headers: { origin: SITE, host: TUNNEL, 'cf-connecting-ip': `10.0.${i >> 8}.${i & 255}` } })
      closes.push(new Promise((resolve) => ws.on('close', (c) => resolve(c))))
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      opened.push(ws)
    }
    const phone = await open(SITE, { t: 'auth', token }, { host: TUNNEL, 'cf-connecting-ip': '203.0.113.9' })
    expect(phone.msgs.map((m) => JSON.parse(m).t)).toEqual(['hello', 'pong'])
    expect(await closes[0]).toBe(4401)
    for (const ws of opened) ws.terminate()
  })
  it('never logs the token, the code, or a URL', async () => {
    const token = await bearer()
    const bad = new RemoteServer({ auth, api: { ...api, handle: async () => { throw new Error('boom') } }, bundleDir: null, extraHosts: () => [], allowedOrigins: () => [SITE], log: { warn: (m, meta) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`) } })
    const port = await bad.start()
    await fetch(`http://127.0.0.1:${port}/api/me?x=${token}`, { headers: { origin: SITE, authorization: `Bearer ${token}` } })
    await fetch(`http://127.0.0.1:${port}/api/c/co_a/pause`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    await bad.stop()
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) {
      expect(l).not.toContain(token)
      expect(l).not.toMatch(/\/api\//)
    }
  })
  it('bearerOf reads only a well-formed Bearer value', () => {
    expect(bearerOf('Bearer abcdefghijklmnopqrstu')).toBe('abcdefghijklmnopqrstu')
    expect(bearerOf('bearer abcdefghijklmnopqrstu')).toBe('abcdefghijklmnopqrstu')
    expect(bearerOf('Bearer short')).toBeNull()
    expect(bearerOf('Bearer a b')).toBeNull()
    expect(bearerOf(undefined)).toBeNull()
    expect(bearerOf(['Bearer abcdefghijklmnopqrstu'])).toBeNull()
  })
})

describe('RemoteService, hosted mode (RA6)', () => {
  const host: PhoneHost = { invoke: (async () => []) as unknown as PhoneHost['invoke'], onEvent: () => () => undefined }
  it('the link opens the configured site with the Mac in the fragment; none configured = the Mac’s own page', async () => {
    let site: string | null = SITE
    const svc = new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null }, site: () => site })
    const on = await svc.setEnabled(true)
    const link = svc.pairLink()
    expect(link.site).toBe(SITE)
    expect(link.link).toMatch(new RegExp(`^${SITE}/#mac=${encodeURIComponent(on.localUrl!).replace(/[.]/g, '\\.')}&code=[0-9a-f]{32}$`))
    site = null
    const local = svc.pairLink()
    expect(local.link).toMatch(new RegExp(`^${on.localUrl!.replace(/[.]/g, '\\.')}/#pair=[0-9a-f]{32}$`))
    expect(local.site).toBeNull()
    await svc.setEnabled(false)
  })
  it('the site origin gets a token; Revoke and Sign out all phones sign the bearer out; Turn off does not', async () => {
    const svc = new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null }, site: () => SITE })
    const on = await svc.setEnabled(true)
    const code = new URL(svc.pairLink().link).hash.match(/code=([0-9a-f]{32})/)![1]
    const r = await fetch(`${on.localUrl}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'iPhone' }) })
    const { token, device } = (await r.json()) as { token: string; device: { id: string } }
    const me = () => fetch(`${on.localUrl}/api/sign-out`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
    svc.revoke(device.id)
    expect((await me()).status).toBe(401)
    // pair again, then Turn off: the token survives (RA2); Sign out all phones kills it
    const code2 = new URL(svc.pairLink().link).hash.match(/code=([0-9a-f]{32})/)![1]
    const r2 = await fetch(`${on.localUrl}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: code2, name: 'iPhone' }) })
    const t2 = ((await r2.json()) as { token: string }).token
    await svc.setEnabled(false)
    expect(svc.auth.verify(t2)).not.toBeNull()
    expect(svc.signOutAll().devices).toEqual([])
    expect(svc.auth.verify(t2)).toBeNull()
  })
})

describe('settings: Phone app address (RA6)', () => {
  it('takes an https site address (cut to its origin), loopback http, empty or null; nothing else', async () => {
    const { REQUEST_SCHEMAS } = await import('../ipcSchemas')
    const parse = (v: unknown) => REQUEST_SCHEMAS['settings:update'].safeParse({ phoneSiteUrl: v })
    expect(parse('https://phone.example.com').data).toEqual({ phoneSiteUrl: 'https://phone.example.com' })
    expect(parse('https://phone.example.com/').data).toEqual({ phoneSiteUrl: 'https://phone.example.com' })
    expect(parse('http://127.0.0.1:4318').success).toBe(true)
    expect(parse('').data).toEqual({ phoneSiteUrl: '' })
    expect(parse(null).data).toEqual({ phoneSiteUrl: null })
    for (const bad of ['http://phone.example.com', 'https://phone.example.com/app', 'https://*.example.com', 'javascript:alert(1)', 'https://u:p@phone.example.com', 'phone.example.com']) expect(parse(bad).success).toBe(false)
  })
})
