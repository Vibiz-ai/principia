/**
 * REMOTE.md RA6: the phone app on its own site. The link format, the bearer client (the token in a header, never in a
 * URL, no cookies, no CSRF), the remembered Mac, the socket's first-message auth, the screens, and the site's headers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairLinkFor, parsePairHash, phoneSiteOrigin, siteOrigin, REMOTE_CSRF_HEADER } from '../../shared/remote'
import { textOf } from '../console/dom'
import { ApiError, MacGone, NotPaired, createApi } from './api'
import { forgetMac, liveUrl, loadMac, MAC_KEY, macHost, pastedPairHash, saveMac, type StorageLike } from './mac'
import { renderPair, renderSignedOut, type Actions } from './render'

const CODE = 'ab'.repeat(16)
const TOKEN = 'tok_' + 'x'.repeat(40)
const MAC = 'https://quiet-tree-42.trycloudflare.com'
const SITE = 'https://phone.example.com'

describe('the pairing link', () => {
  it('hosted: <site>/#mac=<the Mac>&code=<code>; same-origin: <mac>/#pair=<code>', () => {
    const hosted = pairLinkFor({ site: SITE, mac: MAC, code: CODE })
    expect(hosted).toBe(`${SITE}/#mac=${encodeURIComponent(MAC)}&code=${CODE}`)
    expect(pairLinkFor({ site: null, mac: `${MAC}/`, code: CODE })).toBe(`${MAC}/#pair=${CODE}`)
    // the code and the Mac's address are only in the fragment: nothing reaches the site's server
    const u = new URL(hosted)
    expect(u.pathname).toBe('/')
    expect(u.search).toBe('')
    expect(parsePairHash(u.hash)).toEqual({ code: CODE, mac: MAC })
  })
  it('reads only a real code and an https (or loopback) Mac', () => {
    expect(parsePairHash(`#pair=${CODE}`)).toEqual({ code: CODE, mac: null })
    expect(parsePairHash(`#mac=${encodeURIComponent('http://127.0.0.1:5123')}&code=${CODE}`)).toEqual({ code: CODE, mac: 'http://127.0.0.1:5123' })
    expect(parsePairHash(`#mac=${encodeURIComponent('http://evil.example.com')}&code=${CODE}`)).toBeNull()
    expect(parsePairHash(`#mac=${encodeURIComponent('javascript:alert(1)')}&code=${CODE}`)).toBeNull()
    expect(parsePairHash(`#mac=${encodeURIComponent(MAC)}&code=<script>`)).toBeNull()
    expect(parsePairHash(`#mac=${encodeURIComponent(MAC)}`)).toBeNull()
    expect(parsePairHash('#/c/co_a/now')).toBeNull()
  })
  it('the setting: absent = the official address, empty = none, a path is cut to the origin', () => {
    expect(siteOrigin('https://phone.example.com/some/path?x=1')).toBe(SITE)
    expect(siteOrigin('https://user:pw@phone.example.com')).toBeNull()
    expect(siteOrigin('http://phone.example.com')).toBeNull()
    expect(siteOrigin('https://*.example.com')).toBeNull()
    expect(siteOrigin('http://localhost:4318')).toBe('http://localhost:4318')
    expect(phoneSiteOrigin(null, SITE)).toBe(SITE)
    expect(phoneSiteOrigin(undefined, SITE)).toBe(SITE)
    expect(phoneSiteOrigin('', SITE)).toBeNull()
    expect(phoneSiteOrigin('https://other.example.org', SITE)).toBe('https://other.example.org')
    expect(phoneSiteOrigin(null, null)).toBeNull()
  })
})

type Call = { url: string; init: RequestInit }
function fakeFetch(answer: (url: string) => { status: number; body: unknown } | Error) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const a = answer(url)
    if (a instanceof Error) throw a
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('the hosted API client (bearer, no cookies, no CSRF)', () => {
  it('sends the token as a bearer header only, never in a URL, and no cookie', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }))
    const api = createApi(f, { base: () => MAC, token: () => TOKEN })
    await api.call('now', { params: { companyId: 'co_a' } })
    await api.call('roomPost', { params: { companyId: 'co_a' }, body: { channelId: 'ch_1', text: 'hi' } })
    for (const c of calls) {
      expect(c.url.startsWith(`${MAC}/api/`)).toBe(true)
      expect(c.url).not.toContain(TOKEN)
      expect(c.init.credentials).toBe('omit')
      expect(c.init.mode).toBe('cors')
      const h = c.init.headers as Record<string, string>
      expect(h.authorization).toBe(`Bearer ${TOKEN}`)
      expect(h[REMOTE_CSRF_HEADER]).toBeUndefined()
      expect(h.cookie).toBeUndefined()
    }
    // a write goes straight out: no /api/me round trip for a CSRF value
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/c/co_a/now', '/api/c/co_a/room/post'])
  })
  it('pairs without a token, at the Mac named by the link', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { device: { id: 'dev_1', name: 'iPhone' }, token: TOKEN } }))
    const api = createApi(f, { base: () => MAC, token: () => null })
    const out = await api.call<{ token: string }>('pair', { body: { code: CODE, name: 'iPhone' } })
    expect(out.token).toBe(TOKEN)
    expect(calls[0]!.url).toBe(`${MAC}/api/pair`)
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined()
  })
  it('401 = not paired; no answer at all = the Mac is gone; an edge error page = gone too', async () => {
    await expect(createApi(fakeFetch(() => ({ status: 401, body: { message: 'x' } })).f, { base: () => MAC, token: () => TOKEN }).me()).rejects.toBeInstanceOf(NotPaired)
    await expect(createApi(fakeFetch(() => new TypeError('Load failed')).f, { base: () => MAC, token: () => TOKEN }).me()).rejects.toBeInstanceOf(MacGone)
    await expect(createApi(fakeFetch(() => ({ status: 530, body: '<html>Argo Tunnel error</html>' })).f, { base: () => MAC, token: () => TOKEN }).me()).rejects.toBeInstanceOf(MacGone)
    await expect(createApi(fakeFetch(() => ({ status: 404, body: { message: 'Not found' } })).f, { base: () => MAC, token: () => TOKEN }).me()).rejects.toBeInstanceOf(ApiError)
  })
  it('same-origin is unchanged: the cookie, and the CSRF header from /api/me on writes', async () => {
    const { f, calls } = fakeFetch((u) => ({ status: 200, body: u.endsWith('/api/me') ? { csrf: 'c1', companies: [] } : { ok: true } }))
    const api = createApi(f)
    await api.call('pause', { params: { companyId: 'co_a' }, body: { paused: true } })
    expect(calls.map((c) => c.url)).toEqual(['/api/me', '/api/c/co_a/pause'])
    expect(calls[1]!.init.credentials).toBe('same-origin')
    expect((calls[1]!.init.headers as Record<string, string>)[REMOTE_CSRF_HEADER]).toBe('c1')
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBeUndefined()
  })
})

describe('the remembered Mac', () => {
  const mem = (): StorageLike & { m: Map<string, string> } => {
    const m = new Map<string, string>()
    return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
  }
  it('keeps the address and the token, refuses junk, forgets on sign-out', () => {
    const s = mem()
    expect(loadMac(s)).toBeNull()
    saveMac(s, { mac: MAC, token: TOKEN, device: { id: 'dev_1', name: 'iPhone' }, pairedAt: '2026-10-26T00:00:00Z' })
    expect(loadMac(s)?.mac).toBe(MAC)
    s.m.set(MAC_KEY, JSON.stringify({ mac: 'http://evil.example.com', token: TOKEN }))
    expect(loadMac(s)).toBeNull()
    s.m.set(MAC_KEY, '{not json')
    expect(loadMac(s)).toBeNull()
    forgetMac(s)
    expect(s.m.size).toBe(0)
    expect(loadMac(null)).toBeNull()
    expect(macHost(MAC)).toBe('quiet-tree-42.trycloudflare.com')
  })
  it('the socket address never carries the token', () => {
    expect(liveUrl(MAC, { protocol: 'https:', host: 'phone.example.com' })).toBe('wss://quiet-tree-42.trycloudflare.com/api/live')
    expect(liveUrl('', { protocol: 'https:', host: 'x.trycloudflare.com' })).toBe('wss://x.trycloudflare.com/api/live')
    expect(liveUrl('http://127.0.0.1:5000', { protocol: 'http:', host: '127.0.0.1:4318' })).toBe('ws://127.0.0.1:5000/api/live')
  })
})

describe('the live socket (hosted): the token is the first message', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('opens the plain address, sends auth first, then the subscription; 4401 with no bye signs out', async () => {
    const socks: { url: string; sent: string[]; onopen?: () => void; onclose?: (e: { code: number }) => void; onmessage?: unknown; onerror?: unknown; readyState: number; send(x: string): void; close(): void }[] = []
    class FakeWs {
      readyState = 1
      sent: string[] = []
      constructor(public url: string) {
        socks.push(this as never)
      }
      send(x: string): void {
        this.sent.push(x)
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWs)
    vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'visible' })
    vi.stubGlobal('window', { addEventListener: () => undefined })
    const { openLive } = await import('./live')
    let out = 0
    const live = openLive({ url: 'wss://quiet-tree-42.trycloudflare.com/api/live', token: () => TOKEN, onMessage: () => undefined, onState: () => undefined, onReconnect: () => undefined, onUnauthorized: () => out++ })
    live.send({ t: 'sub', companyId: 'co_a' })
    const s = socks[0]!
    expect(s.url).not.toContain(TOKEN)
    s.onopen!()
    expect(JSON.parse(s.sent[0]!)).toEqual({ t: 'auth', token: TOKEN })
    expect(JSON.parse(s.sent[1]!)).toEqual({ t: 'sub', companyId: 'co_a' })
    s.onclose!({ code: 4401 })
    expect(out).toBe(1)
    live.close()
  })
})

const noop = new Proxy({}, { get: () => () => undefined }) as Actions

describe('pairing and signed-out screens (the landing look)', () => {
  it('pairing: "Principia" over the arch, one sentence, the code status and the Mac it names', () => {
    const v = renderPair({ name: 'iPhone', error: null, busy: false, mac: 'quiet-tree-42.trycloudflare.com' }, noop)
    const t = textOf(v)
    expect(t).toContain('Principia')
    expect(t).toContain('One-time code')
    // nothing has checked the code yet, so the screen does not call it ready
    expect(t).not.toMatch(/ready/i)
    expect(t).toContain('quiet-tree-42.trycloudflare.com')
    expect(JSON.stringify(v)).toContain('/art/arch.webp')
    expect(textOf(renderPair({ name: 'iPhone', error: 'This link expired.', busy: false, mac: null }, noop))).toContain('Code not accepted')
  })
  it('the Mac is gone: still paired, it asks for the new address (words), with its last address and Forget', () => {
    const t = textOf(renderSignedOut({ reason: 'gone', hosted: true, mac: 'quiet-tree-42.trycloudflare.com', error: null }, noop))
    expect(t).toContain('Waiting for your Mac')
    expect(t).toContain('still paired')
    expect(t).toContain('The new address from your Mac')
    expect(t).toContain('Connect')
    expect(t).toContain('quiet-tree-42.trycloudflare.com')
    expect(t).toContain('Forget this Mac')
    expect(t).toContain('keeps nothing but the key')
    expect(textOf(renderSignedOut({ reason: 'revoked', hosted: true, mac: null, error: null }, noop))).toContain('removed on your Mac')
  })
  it('a link naming another Mac than the one kept says so, and the button says it replaces it', () => {
    const t = textOf(renderPair({ name: 'iPhone', error: null, busy: false, mac: 'evil-1.trycloudflare.com', replaces: 'quiet-tree-42.trycloudflare.com' }, noop))
    expect(t).toContain('paired with another Mac (quiet-tree-42.trycloudflare.com)')
    expect(t).toContain('Replace and pair')
    expect(textOf(renderPair({ name: 'iPhone', error: null, busy: false, mac: MAC, replaces: null }, noop))).toContain('Pair this phone')
  })
  it('a Home Screen app (iOS keeps its own storage) offers to paste the pairing link; the browser says where pairing lives', () => {
    const t = textOf(renderSignedOut({ reason: 'unpaired', hosted: true, mac: null, error: null, standalone: true }, noop))
    expect(t).toContain('Paste the pairing link')
    expect(t).toContain('Open the link')
    expect(t).toContain('Copy Link')
    expect(textOf(renderSignedOut({ reason: 'unpaired', hosted: true, mac: null, error: null, standalone: false }, noop))).toContain('Or paste the pairing link')
    expect(textOf(renderSignedOut({ reason: 'unpaired', hosted: false, mac: null, error: null }, noop))).not.toContain('paste')
    expect(textOf(renderSignedOut({ reason: 'unpaired', hosted: true, mac: null, error: null, pasteError: 'That is not a pairing link for this app.' }, noop))).toContain('not a pairing link')
    expect(textOf(renderPair({ name: 'iPhone', error: null, busy: false, mac: MAC, browserTab: true }, noop))).toContain('Home Screen')
  })
})

describe('a pasted pairing link', () => {
  const frag = `#mac=${encodeURIComponent(MAC)}&code=${CODE}`
  it('takes the whole link of this site, or just its fragment', () => {
    expect(pastedPairHash(`${SITE}/${frag}`, SITE)).toBe(frag)
    expect(pastedPairHash(`  ${SITE}/${frag}\n`, SITE)).toBe(frag)
    expect(pastedPairHash(frag, SITE)).toBe(frag)
  })
  it('refuses a link for another site, a same-origin #pair link, junk, or a bad code or Mac', () => {
    expect(pastedPairHash(`https://evil.example.com/${frag}`, SITE)).toBeNull()
    expect(pastedPairHash(`${MAC}/#pair=${CODE}`, SITE)).toBeNull()
    expect(pastedPairHash('hello', SITE)).toBeNull()
    expect(pastedPairHash('', SITE)).toBeNull()
    expect(pastedPairHash(`#mac=${encodeURIComponent('http://evil.example.com')}&code=${CODE}`, SITE)).toBeNull()
    expect(pastedPairHash(`#mac=${encodeURIComponent(MAC)}&code=zz`, SITE)).toBeNull()
    expect(pastedPairHash(`${SITE}/${frag}${'x'.repeat(3000)}`, SITE)).toBeNull()
  })
})

describe('the site (vercel.json)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../phone-site/vercel.json'), 'utf8')) as { rewrites: { source: string; destination: string }[]; headers: { source: string; headers: { key: string; value: string }[] }[] }
  const all = Object.fromEntries(v.headers.find((r) => r.source === '/(.*)')!.headers.map((h) => [h.key.toLowerCase(), h.value]))
  it('has a strict CSP: scripts and styles from itself, connections only to quick tunnels, no framing', () => {
    const csp = all['content-security-policy']!
    const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map(([k, ...r]) => [k, r]))
    expect(d['default-src']).toEqual(["'none'"])
    expect(d['script-src']).toEqual(["'self'"])
    expect(d['style-src']).toEqual(["'self'"])
    expect(d['connect-src']).toEqual(['https://*.trycloudflare.com', 'wss://*.trycloudflare.com'])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'none'"])
    // the app never writes HTML: any sink that would is refused outright
    expect(d['require-trusted-types-for']).toEqual(["'script'"])
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*\s|https:\s|wss:\s|data:[^;]*script/)
    expect(all['x-frame-options']).toBe('DENY')
    expect(all['x-content-type-options']).toBe('nosniff')
    expect(all['referrer-policy']).toBe('no-referrer')
  })
  it('rewrites app routes to the SPA, never /api', () => {
    expect(v.rewrites).toHaveLength(1)
    expect(v.rewrites[0]!.destination).toBe('/index.html')
    const re = new RegExp(`^${v.rewrites[0]!.source}$`)
    expect(re.test('/c/co_a/now')).toBe(true)
    expect(re.test('/api/me')).toBe(false)
  })
  it('the app loads no third-party script, style or font', () => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    const css = fs.readFileSync(path.join(__dirname, 'phone.css'), 'utf8')
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(css).not.toMatch(/url\((['"])?(https?:)?\/\//)
    expect(css).not.toMatch(/@import/)
  })
})
