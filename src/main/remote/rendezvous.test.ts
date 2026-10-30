// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findMac, sha256Hex } from '../../cloud/phone/mac'
import { openAddress, RDV_ID_RE, RDV_ROUTE, RDV_SEALED_RE, rdvIds, sealAddress } from '../../shared/rendezvous'
import { helloMessage } from '../../shared/remote'
import { Rendezvous } from './rendezvous'
import { RemoteService } from './service'
// @ts-expect-error a plain .mjs: Vercel takes it as it is, with no build
import { GET, LIMITS, PUT } from '../../../phone-site/api/where.mjs'

const SITE = 'https://phone.example.com'
const OLD = 'https://old-words-here.trycloudflare.com'
const NEW = 'https://quiet-tree-forty-two.trycloudflare.com'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz012345'
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const HASH = sha(TOKEN)
const ENV = { KV_REST_API_URL: 'https://redis.example.com', KV_REST_API_TOKEN: 'x' }

/** The Upstash REST API, in memory */
function fakeRedis() {
  const data = new Map<string, string | number>()
  const ttl = new Map<string, number>()
  const seen: unknown[][] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`${ENV.KV_REST_API_URL}/pipeline`)
    const cmds = JSON.parse(String(init?.body)) as (string | number)[][]
    seen.push(...cmds)
    const out = cmds.map(([c, k, v, , t]) => {
      const key = String(k)
      if (c === 'INCR') data.set(key, Number(data.get(key) ?? 0) + 1)
      if (c === 'SET') {
        data.set(key, String(v))
        ttl.set(key, Number(t))
      }
      return { result: c === 'EXPIRE' ? 1 : c === 'SET' ? 'OK' : (data.get(key) ?? null) }
    })
    return new Response(JSON.stringify(out))
  })
  return { data, ttl, seen, f }
}
const put = async (id: string, body: unknown, ip = '1.1.1.1'): Promise<Response> => PUT(new Request(`${SITE}${RDV_ROUTE}?id=${id}`, { method: 'PUT', headers: { 'x-real-ip': ip }, body: JSON.stringify(body) }), ENV)
const get = async (id: string, ip = '1.1.1.1'): Promise<Response> => GET(new Request(`${SITE}${RDV_ROUTE}?id=${id}`, { headers: { 'x-real-ip': ip } }), ENV)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RA8: sealing', () => {
  it('only the same hash opens it, and a changed record never opens', async () => {
    const sealed = await sealAddress(HASH, NEW)
    expect(sealed).toMatch(RDV_SEALED_RE)
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('trycloudflare')
    expect(await openAddress(HASH, sealed)).toBe(NEW)
    expect(await openAddress(sha('another token'), sealed)).toBeNull()
    expect(await openAddress(HASH, `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`)).toBeNull()
    expect(await openAddress(HASH, 'nonsense')).toBeNull()
  })
  it('each seal differs, and the id is random-looking and proves the write', async () => {
    expect(await sealAddress(HASH, NEW)).not.toBe(await sealAddress(HASH, NEW))
    const { id, write } = await rdvIds(HASH)
    expect(id).toMatch(RDV_ID_RE)
    expect(sha(write)).toBe(id)
    expect(id).not.toBe((await rdvIds(sha('another token'))).id)
  })
  it('stays what ios/PrincipiaTests/MacMoveTests.swift pins', async () => {
    const iv = new Uint8Array(12).fill(7)
    expect((await rdvIds(HASH)).id).toBe('29e949a88ac29c7e29795378a94854da4b72edc65fe989048330004d5fa42256')
    expect(await sealAddress(HASH, NEW, iv)).toBe('BwcHBwcHBwcHBwcH1osaN6ItgLji_Gv3wbChRgWLqROeqSIYt7E_JPQnc9MV51B-PePFbZcT5E-3Ai5A-uJpfdIS9D1WTpZR0nk')
  })
  it('an address of the longest kind still fits what the site takes', async () => {
    expect(await sealAddress(HASH, `https://${'a'.repeat(190)}.co`)).toMatch(RDV_SEALED_RE)
  })
})

describe('RA8: the store on the phone site', () => {
  it('keeps a record for 30 days and gives it back', async () => {
    const r = fakeRedis()
    vi.stubGlobal('fetch', r.f)
    const { id, write } = await rdvIds(HASH)
    const sealed = await sealAddress(HASH, NEW)
    expect((await put(id, { write, sealed })).status).toBe(204)
    expect(r.ttl.get(`rdv:${id}`)).toBe(30 * 86_400)
    const res = await get(id)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ sealed })
    expect([...r.data.values()].filter((v) => typeof v === 'string')).toEqual([sealed])
  })
  it('refuses a write without the secret, so knowing an id is not enough', async () => {
    const r = fakeRedis()
    vi.stubGlobal('fetch', r.f)
    const { id } = await rdvIds(HASH)
    const sealed = await sealAddress(HASH, NEW)
    expect((await put(id, { write: 'f'.repeat(64), sealed })).status).toBe(403)
    expect(r.f).not.toHaveBeenCalled()
  })
  it('refuses bad ids, bad records and big bodies', async () => {
    const r = fakeRedis()
    vi.stubGlobal('fetch', r.f)
    const { id, write } = await rdvIds(HASH)
    expect((await get('nope')).status).toBe(400)
    expect((await put('nope', { write, sealed: 'x' })).status).toBe(400)
    expect((await put(id, { write, sealed: '<script>'.repeat(10) })).status).toBe(400)
    expect((await put(id, { write, sealed: 'a'.repeat(2000) })).status).toBe(413)
    expect(r.f).not.toHaveBeenCalled()
  })
  it('is 404 for an unknown id and 503 without a store', async () => {
    vi.stubGlobal('fetch', fakeRedis().f)
    const { id, write } = await rdvIds(HASH)
    expect((await get(id)).status).toBe(404)
    expect((await GET(new Request(`${SITE}${RDV_ROUTE}?id=${id}`), {})).status).toBe(503)
    expect((await PUT(new Request(`${SITE}${RDV_ROUTE}?id=${id}`, { method: 'PUT', body: JSON.stringify({ write, sealed: await sealAddress(HASH, NEW) }) }), {})).status).toBe(503)
  })
  it('limits each caller, and the others are not touched', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 30, 12, 0, 1), toFake: ['Date'] })
    vi.stubGlobal('fetch', fakeRedis().f)
    const { id, write } = await rdvIds(HASH)
    const sealed = await sealAddress(HASH, NEW)
    for (let i = 0; i < LIMITS.writePerHour; i++) expect((await put(id, { write, sealed })).status).toBe(204)
    expect((await put(id, { write, sealed })).status).toBe(429)
    expect((await put(id, { write, sealed }, '2.2.2.2')).status).toBe(204)
    for (let i = 0; i < LIMITS.readPerMinute; i++) expect((await get(id)).status).toBe(200)
    expect((await get(id)).status).toBe(429)
    expect((await get(id, '2.2.2.2')).status).toBe(200)
  })
  it('a caller over its own limit does not use up everyone else\'s', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 30, 12, 0, 1), toFake: ['Date'] })
    vi.stubGlobal('fetch', fakeRedis().f)
    vi.spyOn(LIMITS, 'writesPerHourAll', 'get').mockReturnValue(LIMITS.writePerHour + 1)
    const { id, write } = await rdvIds(HASH)
    const sealed = await sealAddress(HASH, NEW)
    for (let i = 0; i < LIMITS.writePerHour; i++) await put(id, { write, sealed })
    for (let i = 0; i < 5; i++) expect((await put(id, { write, sealed })).status).toBe(429)
    expect((await put(id, { write, sealed }, '2.2.2.2')).status).toBe(204)
  })
  it('a store that fails answers 503, never a crash', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }))
    expect((await get((await rdvIds(HASH)).id)).status).toBe(503)
  })
})

describe('RA8: the Mac leaves its address', () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const puts: { url: string; body: { write: string; sealed: string } }[] = []
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      puts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    })
    return { puts, f, d: { site: () => SITE, hashes: () => [HASH], fetch: f as unknown as typeof fetch, retryMs: [5], ...over } }
  }
  const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('sealed, once per phone, and not again for the same address', async () => {
    const other = sha('another token')
    const { puts, d } = deps({ hashes: () => [HASH, other] })
    const r = new Rendezvous(d)
    r.address(NEW)
    r.address(NEW)
    await tick()
    expect(puts).toHaveLength(2)
    const { id } = await rdvIds(HASH)
    expect(puts[0].url).toBe(`${SITE}${RDV_ROUTE}?id=${id}`)
    expect(await openAddress(HASH, puts[0].body.sealed)).toBe(NEW)
    expect(await openAddress(other, puts[1].body.sealed)).toBe(NEW)
    expect(JSON.stringify(puts)).not.toContain('trycloudflare')
    expect(JSON.stringify(puts)).not.toContain(HASH)
  })
  it('sends nothing with no phone app address, or with no phone', async () => {
    const a = deps({ site: () => null })
    new Rendezvous(a.d).address(NEW)
    const b = deps({ hashes: () => [] })
    new Rendezvous(b.d).address(NEW)
    await tick()
    expect(a.f).not.toHaveBeenCalled()
    expect(b.f).not.toHaveBeenCalled()
  })
  it('tries again after a failure, with the phones of that moment', async () => {
    let n = 0
    const { puts, d } = deps()
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (++n === 1) return new Response(null, { status: 503 })
      if (n === 2) throw new TypeError('offline')
      puts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    })
    new Rendezvous({ ...d, fetch: f as unknown as typeof fetch }).address(NEW)
    await tick(60)
    expect(f).toHaveBeenCalledTimes(3)
    expect(puts).toHaveLength(1)
  })
  it('leaves a site with no lookup alone', async () => {
    const f = vi.fn(async () => new Response(null, { status: 404 }))
    const { d } = deps({ fetch: f })
    new Rendezvous(d).address(NEW)
    await tick()
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('stops trying once the tunnel is off, or the address is another', async () => {
    const f = vi.fn(async () => new Response(null, { status: 503 }))
    const { d } = deps({ fetch: f })
    const r = new Rendezvous(d)
    r.address(NEW)
    await tick(1)
    r.address(null)
    const after = f.mock.calls.length
    await tick()
    expect(f.mock.calls.length).toBe(after)
  })
  it('the service publishes when the tunnel gets its address, and stops on Turn off', async () => {
    const { EventEmitter } = await import('node:events')
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill: () => true, pid: 4242, unref: () => undefined })
    const { puts, f } = deps()
    const s = new RemoteService({ host: { onEvent: () => () => undefined } as never, bundleDir: null, emit: () => undefined, tunnel: { bin: () => '/bin/cloudflared', spawn: () => child as never }, site: () => SITE, rendezvous: { fetch: f as unknown as typeof fetch } })
    const code = s.auth.createCode().code
    const { token } = s.auth.pair(code, 'iPhone')
    await s.setEnabled(true)
    await s.setTunnel(true)
    child.stdout.emit('data', Buffer.from(`Visit it at ${NEW}\n`))
    await tick()
    expect(puts).toHaveLength(1)
    expect(await openAddress(sha(token), puts[0].body.sealed)).toBe(NEW)
    await s.setEnabled(false)
  })
})

describe('RA8: the phone finds the Mac', () => {
  const paired = { mac: OLD, token: TOKEN, device: { id: 'dev_1', name: 'iPhone' } }
  /** the site's lookup and the Mac at NEW */
  async function world(o: { record?: string | null; proofFor?: string; site?: number } = {}) {
    const hash = await sha256Hex(TOKEN)
    const sealed = o.record === undefined ? await sealAddress(hash, NEW) : o.record
    const asked: { url: string; auth: string | null; body: string }[] = []
    const f = (async (url: string, init?: RequestInit) => {
      asked.push({ url, auth: new Headers(init?.headers).get('authorization'), body: String(init?.body ?? '') })
      if (new URL(url).origin === SITE) return sealed ? new Response(JSON.stringify({ sealed }), { status: o.site ?? 200 }) : new Response('{}', { status: 404 })
      const { nonce } = JSON.parse(String(init?.body)) as { nonce: string }
      const { createHmac } = await import('node:crypto')
      return new Response(JSON.stringify({ proof: createHmac('sha256', o.proofFor ?? hash).update(helloMessage(url.replace('/api/hello', ''), nonce)).digest('hex') }))
    }) as unknown as typeof fetch
    return { f, asked }
  }
  it('opens the record, checks the Mac there, and never sends the token', async () => {
    const { f, asked } = await world()
    expect(await findMac(f, SITE, paired)).toBe(NEW)
    expect(asked.map((a) => a.url)).toEqual([`${SITE}${RDV_ROUTE}?id=${(await rdvIds(HASH)).id}`, `${NEW}/api/hello`])
    for (const a of asked) {
      expect(a.auth).toBeNull()
      expect(a.url + a.body).not.toContain(TOKEN)
    }
  })
  it('a Mac that fails the hello check is refused', async () => {
    const { f } = await world({ proofFor: sha('someone else') })
    expect(await findMac(f, SITE, paired)).toBeNull()
  })
  it('a record sealed for someone else, or none, leaves the phone waiting', async () => {
    expect(await findMac((await world({ record: await sealAddress(sha('x'), NEW) })).f, SITE, paired)).toBeNull()
    expect(await findMac((await world({ record: null })).f, SITE, paired)).toBeNull()
    expect(await findMac((await world({ record: 'not sealed!' })).f, SITE, paired)).toBeNull()
    expect(await findMac((await world({ site: 429 })).f, SITE, paired)).toBeNull()
  })
  it('a record with an address that is not https is refused before anything is asked of it', async () => {
    const { f, asked } = await world({ record: await sealAddress(HASH, 'http://evil.example') })
    expect(await findMac(f, SITE, paired)).toBeNull()
    expect(asked).toHaveLength(1)
  })
  it('the same address as before asks nothing more', async () => {
    const { f, asked } = await world()
    expect(await findMac(f, SITE, { ...paired, mac: NEW })).toBeNull()
    expect(asked).toHaveLength(1)
  })
  it('a site that cannot be reached is not an error', async () => {
    expect(await findMac((async () => { throw new TypeError('offline') }) as unknown as typeof fetch, SITE, paired)).toBeNull()
  })
})
