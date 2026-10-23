import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SiteSummarySchema } from '../../../shared/onboarding'
import {
  decodeEntities,
  defaultTransport,
  extractSiteFacts,
  fetchSite,
  isBlockedHostname,
  isPublicAddress,
  normalizeSiteUrl,
  SITE_MAX_BYTES,
  SITE_UA,
  type ResolvedAddress,
  type SiteResponse,
  type SiteTransport
} from '../site'

const HTML = path.join(__dirname, 'fixtures', 'html')
const basic = fs.readFileSync(path.join(HTML, 'basic.html'), 'utf8')
const TOKEN = ['sk', '-proj-', 'A1b2C3d4'.repeat(4)].join('')

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 }
function dnsOf(table: Record<string, string[]>) {
  return async (host: string): Promise<ResolvedAddress[]> => {
    const a = table[host]
    if (!a) throw new Error('ENOTFOUND')
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}
/** Fake transport: routes by full URL; records every call. */
function fakeTransport(routes: Record<string, Partial<SiteResponse> & { html?: string }>, calls: { url: string; addr: string; headers: Record<string, string> }[] = []): SiteTransport {
  return async (url, addr, opts) => {
    calls.push({ url: url.toString(), addr: addr.address, headers: opts.headers })
    const r = routes[url.toString()]
    if (!r) return { status: 404, headers: {}, body: Buffer.alloc(0) }
    return { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'text/html; charset=utf-8' }, body: r.body ?? Buffer.from(r.html ?? '') }
  }
}

describe('extraction', () => {
  it('reads title, meta description, og:* and the first h1, entities decoded', () => {
    const f = extractSiteFacts(basic)
    expect(f).toEqual({
      title: 'Sunday Bakery – Fresh sourdough',
      description: 'Sourdough delivered to offices in Lisbon & Porto.',
      ogTitle: 'Sunday Bakery',
      ogDescription: 'Bread, every Sunday — and Mondays too.',
      siteName: 'Sunday Bakery',
      h1: 'Bread that shows up'
    })
  })
  it('minimal page: title only', () => {
    expect(extractSiteFacts(fs.readFileSync(path.join(HTML, 'minimal.html'), 'utf8'))).toEqual({ title: 'Café Lisboa' })
  })
  it('decodeEntities', () => {
    expect(decodeEntities('a &amp; b &#60;3 &#x1F35E; &unknown; &#xD800;')).toBe('a & b <3 🍞 &unknown; &#xD800;')
  })
})

describe('address policy', () => {
  it.each([
    ['127.0.0.1', false], ['10.0.0.1', false], ['172.16.5.4', false], ['192.168.1.1', false], ['169.254.169.254', false],
    ['100.64.1.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false],
    ['::1', false], ['::', false], ['fe80::1', false], ['fd00::1', false], ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false],
    ['::ffff:10.0.0.1', false], ['64:ff9b::a00:1', false], ['64:ff9b:1::a00:1', false], ['2001:db8::1', false],
    ['8.8.8.8', true], ['93.184.216.34', true], ['2606:4700:4700::1111', true], ['::ffff:8.8.8.8', true], ['not-an-ip', false]
  ])('%s public=%s', (ip, ok) => {
    expect(isPublicAddress(ip)).toBe(ok)
  })
  it('blocked host names', () => {
    for (const h of ['localhost', 'app.localhost', 'printer.local', 'db.internal', 'intranet', 'LOCALHOST.']) expect(isBlockedHostname(h)).toBe(true)
    expect(isBlockedHostname('sundaybakery.com')).toBe(false)
  })
  it('normalizes bare domains and refuses other schemes, credentials, odd ports and Instagram', () => {
    expect(normalizeSiteUrl('sundaybakery.com').toString()).toBe('https://sundaybakery.com/')
    expect(normalizeSiteUrl('http://x.com/a#frag').toString()).toBe('http://x.com/a')
    expect(normalizeSiteUrl('https://x.com:443/').toString()).toBe('https://x.com/')
    for (const bad of ['ftp://x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@x.com', 'http://x.com:8080', 'localhost:3000', 'https://instagram.com/sunday', '@sundaybakery', '']) {
      expect(() => normalizeSiteUrl(bad), bad).toThrow()
    }
  })
})

describe('fetchSite (fake transport)', () => {
  const now = () => new Date('2026-10-21T10:00:00Z')

  it('reads a public page; output fits the schema and is redacted', async () => {
    const calls: { url: string; addr: string; headers: Record<string, string> }[] = []
    const html = basic.replace('Fresh sourdough', `Fresh sourdough ${TOKEN} vaultval99`)
    const s = await fetchSite('sundaybakery.com', {
      resolve: dnsOf({ 'sundaybakery.com': [PUBLIC.address] }),
      transport: fakeTransport({ 'https://sundaybakery.com/': { html } }, calls),
      redact: (t) => t.split('vaultval99').join('••••X'),
      now
    })
    expect(s.url).toBe('https://sundaybakery.com/')
    expect(s.title).toBe('Sunday Bakery – Fresh sourdough ••••credential ••••X')
    expect(s.h1).toBe('Bread that shows up')
    expect(s.fetchedAt).toBe('2026-10-21T10:00:00.000Z')
    expect(() => SiteSummarySchema.parse(s)).not.toThrow()
    expect(JSON.stringify(s)).not.toContain(TOKEN)
    expect(calls[0].addr).toBe(PUBLIC.address)
    expect(calls[0].headers['User-Agent']).toBe(SITE_UA)
    expect(Object.keys(calls[0].headers).map((k) => k.toLowerCase())).not.toContain('cookie')
  })

  it.each(['http://127.0.0.1', 'http://10.0.0.1', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://localhost', 'http://nas.local'])('refuses %s without connecting', async (url) => {
    const calls: { url: string; addr: string; headers: Record<string, string> }[] = []
    await expect(fetchSite(url, { resolve: dnsOf({}), transport: fakeTransport({}, calls) })).rejects.toThrow(/public websites/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a host that resolves to a private address (or any private answer)', async () => {
    const calls: { url: string; addr: string; headers: Record<string, string> }[] = []
    const resolve = dnsOf({ 'evil.example': ['10.1.2.3'], 'mixed.example': [PUBLIC.address, '127.0.0.1'] })
    await expect(fetchSite('https://evil.example', { resolve, transport: fakeTransport({}, calls) })).rejects.toThrow(/public websites/)
    await expect(fetchSite('https://mixed.example', { resolve, transport: fakeTransport({}, calls) })).rejects.toThrow(/public websites/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a redirect into a private range, re-checking each hop', async () => {
    const calls: { url: string; addr: string; headers: Record<string, string> }[] = []
    const resolve = dnsOf({ 'a.example': [PUBLIC.address], 'inner.example': ['192.168.0.10'] })
    const t = fakeTransport(
      {
        'https://a.example/': { status: 302, headers: { location: 'http://10.0.0.5/admin' } },
        'https://a.example/two': { status: 301, headers: { location: 'https://inner.example/' } }
      },
      calls
    )
    await expect(fetchSite('https://a.example/', { resolve, transport: t })).rejects.toThrow(/public websites/)
    await expect(fetchSite('https://a.example/two', { resolve, transport: t })).rejects.toThrow(/public websites/)
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/', 'https://a.example/two'])
  })

  it('follows up to 3 redirects (relative too) and reports the final URL; refuses a 4th', async () => {
    const resolve = dnsOf({ 'a.example': [PUBLIC.address], 'b.example': [PUBLIC.address] })
    const routes = {
      'http://a.example/': { status: 301, headers: { location: 'https://a.example/' } },
      'https://a.example/': { status: 302, headers: { location: '/home' } },
      'https://a.example/home': { status: 307, headers: { location: 'https://b.example/' } },
      'https://b.example/': { html: basic }
    }
    const s = await fetchSite('http://a.example/', { resolve, transport: fakeTransport(routes) })
    expect(s.url).toBe('https://b.example/')
    const loop = { 'https://a.example/': { status: 302, headers: { location: '/x' } }, 'https://a.example/x': { status: 302, headers: { location: '/' } } }
    await expect(fetchSite('https://a.example/', { resolve, transport: fakeTransport(loop) })).rejects.toThrow(/too many/)
  })

  it('refuses a redirect to another scheme or with credentials', async () => {
    const resolve = dnsOf({ 'a.example': [PUBLIC.address] })
    await expect(fetchSite('https://a.example/', { resolve, transport: fakeTransport({ 'https://a.example/': { status: 302, headers: { location: 'file:///etc/passwd' } } }) })).rejects.toThrow(/http and https/)
    await expect(fetchSite('https://a.example/', { resolve, transport: fakeTransport({ 'https://a.example/': { status: 302, headers: { location: 'https://u:p@a.example/' } } }) })).rejects.toThrow(/username or password/)
  })

  it('non-2xx, non-HTML and DNS failure are refused with copy', async () => {
    const resolve = dnsOf({ 'a.example': [PUBLIC.address] })
    await expect(fetchSite('https://a.example/missing', { resolve, transport: fakeTransport({}) })).rejects.toThrow(/answered 404/)
    await expect(fetchSite('https://a.example/', { resolve, transport: fakeTransport({ 'https://a.example/': { headers: { 'content-type': 'application/pdf' }, html: '%PDF' } }) })).rejects.toThrow(/isn't a web page/)
    await expect(fetchSite('https://nowhere.example/', { resolve, transport: fakeTransport({}) })).rejects.toThrow(/Couldn't find/)
  })
})

describe('fetchSite (real sockets, local server allowed explicitly)', () => {
  let server: http.Server
  let port = 0
  const seen: http.IncomingHttpHeaders[] = []
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/slow') return // never answers
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('<html><head><title>Big page</title></head><body>')
        const chunk = 'x'.repeat(64 * 1024)
        let n = 0
        const pump = (): void => {
          while (n < 64) {
            n++
            if (!res.write(chunk)) return void res.once('drain', pump)
          }
          res.end('<h1>after the cap</h1></body></html>')
        }
        pump()
        return
      }
      if (req.url === '/gz') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        res.end(zlib.gzipSync(basic))
        return
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/gz', 'set-cookie': 'sid=abc; Path=/' })
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  /** The local server listens on a non-default port: route the public-looking URL to it. */
  const via = (): SiteTransport => (url, _addr, opts) => defaultTransport(new URL(url.pathname, `http://site.test:${port}`), { address: '127.0.0.1', family: 4 }, opts)
  const deps = () => ({ resolve: dnsOf({ 'site.test': ['127.0.0.1'] }), allowAddress: () => true, transport: via() })

  it('times out (5 s budget, shortened here)', async () => {
    const t0 = Date.now()
    await expect(fetchSite('http://site.test/slow', { ...deps(), timeoutMs: 200 })).rejects.toThrow(/too long/)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
  it('caps the body at 512 KB', async () => {
    let size = 0
    const capped: SiteTransport = async (url, addr, opts) => {
      const r = await via()(url, addr, opts)
      size = r.body.length
      return r
    }
    const s = await fetchSite('http://site.test/big', { ...deps(), transport: capped })
    expect(size).toBeLessThanOrEqual(SITE_MAX_BYTES)
    expect(s.title).toBe('Big page')
    expect(s.h1).toBeUndefined()
  })
  it('decompresses gzip, follows a redirect without sending cookies, sends the UA', async () => {
    seen.length = 0
    const s = await fetchSite('http://site.test/redirect', deps())
    expect(s.title).toBe('Sunday Bakery – Fresh sourdough')
    expect(seen).toHaveLength(2)
    expect(seen.every((h) => h.cookie === undefined)).toBe(true)
    expect(seen[0]['user-agent']).toBe(SITE_UA)
  })
})
