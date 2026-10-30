/**
 * REMOTE.md RA2, RA8: paired phones survive a restart (hive.db keeps only token hashes), Revoke and Sign out all phones,
 * the 90-day expiry, rotation on resume, "Turn Phone on when Principia starts", and the Mac's new address (a paired
 * phone checks the new address proves it is its Mac before it sends its token there).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, type DB } from '../db'
import { macFromTyped, moveLinkFor, parseMoveHash, phoneAutoStartOn, REMOTE_ROTATE_GRACE_MS, REMOTE_TOKEN_TTL_MS, tunnelWords } from '../../shared/remote'
import { RemoteAuth } from './auth'
import { SqliteDeviceStore } from './devices'
import { RemoteServer, type RemoteApi } from './server'
import { RemoteService } from './service'
import type { KeptTunnel, TunnelKeep } from './tunnel'
import type { PhoneHost } from './api'
import { checkMac, helloProofFor, sha256Hex } from '../../cloud/phone/mac'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const SITE = 'https://phone.example.com'

let dir: string
let file: string
let db: DB
const reopen = (): DB => {
  db.close()
  db = openDatabase(file)
  return db
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-persist-'))
  file = path.join(dir, 'hive.db')
  db = openDatabase(file)
})
afterEach(() => {
  try {
    db.close()
  } catch {
    /* closed */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('paired phones in hive.db (RA2)', () => {
  it('a phone stays paired across a restart; only the hash is stored', () => {
    const a = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    const { token, device } = a.pair(a.createCode().code, 'iPhone')
    reopen()
    const b = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    expect(b.verify(token)?.id).toBe(device.id)
    expect(b.devices().map((d) => d.name)).toEqual(['iPhone'])
    const row = db.prepare('SELECT * FROM phone_devices WHERE id = ?').get(device.id) as Record<string, unknown>
    expect(row.token_hash).toBe(sha(token))
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('the database file never holds a raw token (pairing, rotation, use)', () => {
    const a = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    const one = a.pair(a.createCode().code, 'iPhone')
    const two = a.pair(a.createCode().code, 'iPad')
    const rotated = a.rotate(one.device.id)!
    expect(a.verify(rotated.token)).not.toBeNull()
    expect(a.verify(two.token)).not.toBeNull()
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    const bytes = [file, `${file}-wal`, `${file}-shm`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f).toString('latin1')).join('')
    for (const t of [one.token, two.token, rotated.token]) {
      expect(bytes.includes(t)).toBe(false)
      expect(bytes.includes(Buffer.from(t, 'base64url').toString('latin1'))).toBe(false)
    }
    // the hashes are what is there
    expect(bytes.includes(sha(rotated.token))).toBe(true)
    db = openDatabase(file)
  })

  it('Revoke and Sign out all phones are permanent (a restart does not bring them back)', () => {
    const a = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    const one = a.pair(a.createCode().code, 'one')
    const two = a.pair(a.createCode().code, 'two')
    const three = a.pair(a.createCode().code, 'three')
    expect(a.revoke(one.device.id)).toBe(true)
    reopen()
    const b = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    expect(b.verify(one.token)).toBeNull()
    expect(b.devices().map((d) => d.name)).toEqual(['two', 'three'])
    expect(b.revokeAll().sort()).toEqual([two.device.id, three.device.id].sort())
    reopen()
    const c = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    expect(c.devices()).toEqual([])
    expect(c.verify(two.token)).toBeNull()
    expect(c.verify(three.token)).toBeNull()
    const rows = db.prepare('SELECT token_hash, prev_hash, revoked_at FROM phone_devices').all() as { token_hash: string | null; prev_hash: string | null; revoked_at: string | null }[]
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.token_hash === null && r.prev_hash === null && !!r.revoked_at)).toBe(true)
  })

  it('a token expires 90 days after its last use; each use pushes it out', () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const a = new RemoteAuth({ store: new SqliteDeviceStore(db), now: () => now })
    const { token } = a.pair(a.createCode().code, 'p')
    now += REMOTE_TOKEN_TTL_MS - 60_000
    expect(a.verify(token)).not.toBeNull()
    // used just now: another 89 days are fine, across a restart too
    now += REMOTE_TOKEN_TTL_MS - 60_000
    reopen()
    const b = new RemoteAuth({ store: new SqliteDeviceStore(db), now: () => now })
    expect(b.verify(token)).not.toBeNull()
    // unused for more than 90 days: gone, and gone from disk at the next start
    now += REMOTE_TOKEN_TTL_MS + 1
    reopen()
    const c = new RemoteAuth({ store: new SqliteDeviceStore(db), now: () => now })
    expect(c.devices()).toEqual([])
    expect(c.verify(token)).toBeNull()
    expect((db.prepare('SELECT token_hash FROM phone_devices').get() as { token_hash: string | null }).token_hash).toBeNull()
  })

  it('rotation: the new token works; the old one only for a short grace, and not after the new one is used', () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const a = new RemoteAuth({ store: new SqliteDeviceStore(db), now: () => now })
    const { token: old, device } = a.pair(a.createCode().code, 'p')
    const r = a.rotate(device.id)!
    expect(r.token).not.toBe(old)
    expect(a.verify(old)?.id).toBe(device.id)
    // the grace survives a restart (the answer may have been lost while the Mac restarted)
    reopen()
    const b = new RemoteAuth({ store: new SqliteDeviceStore(db), now: () => now })
    expect(b.verify(old)?.id).toBe(device.id)
    now += REMOTE_ROTATE_GRACE_MS + 1
    expect(b.verify(old)).toBeNull()
    expect(b.verify(r.token)?.id).toBe(device.id)
    // the first use of the new one ends the grace at once
    const r2 = b.rotate(device.id)!
    expect(b.verify(r2.token)).not.toBeNull()
    expect(b.verify(r.token)).toBeNull()
  })
})

describe('Turn Phone on when Principia starts (RA8)', () => {
  const host: PhoneHost = { invoke: (async () => []) as unknown as PhoneHost['invoke'], onEvent: () => () => undefined }
  const svcOf = (setting: boolean | null) => new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null }, site: () => SITE, devices: new SqliteDeviceStore(db), autoStart: () => setting })

  it('default: on once a phone is paired, off otherwise; the setting wins', () => {
    expect(phoneAutoStartOn(null, 0)).toBe(false)
    expect(phoneAutoStartOn(undefined, 1)).toBe(true)
    expect(phoneAutoStartOn(false, 3)).toBe(false)
    expect(phoneAutoStartOn(true, 0)).toBe(true)
  })

  it('after a restart, a paired phone gets back in with its token; Turn off kept it paired', async () => {
    const first = svcOf(null)
    expect(await first.autoStartIfWanted()).toBe(false)
    const on = await first.setEnabled(true)
    const code = new URL(first.pairLink().link).hash.match(/code=([0-9a-f]{32})/)![1]
    const r = await fetch(`${on.localUrl}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'iPhone' }) })
    const { token, device } = (await r.json()) as { token: string; device: { id: string } }
    expect(first.state().autoStart).toBe(true)
    await first.setEnabled(false)
    expect(first.state().devices.map((d) => d.id)).toEqual([device.id])
    await first.stop()
    // the app quits and starts again
    reopen()
    const second = svcOf(null)
    expect(await second.autoStartIfWanted()).toBe(true)
    const st = second.state()
    expect(st.enabled).toBe(true)
    // the tunnel was asked for too (no cloudflared here: never a real tunnel in tests)
    expect(st.tunnel.state).toBe('missing')
    const me = await fetch(`${st.localUrl}/api/me`, { headers: { origin: SITE, authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    await second.stop()
    // the founder turned it off: it stays off
    reopen()
    const third = svcOf(false)
    expect(await third.autoStartIfWanted()).toBe(false)
    expect(third.state().enabled).toBe(false)
    expect(third.state().devices).toHaveLength(1)
  })

  it('the setting is a boolean or null (the default)', async () => {
    const { REQUEST_SCHEMAS } = await import('../ipcSchemas')
    const parse = (v: unknown) => REQUEST_SCHEMAS['settings:update'].safeParse({ phoneAutoStart: v })
    expect(parse(true).success).toBe(true)
    expect(parse(null).success).toBe(true)
    expect(parse('yes').success).toBe(false)
    expect(REQUEST_SCHEMAS['remote:signOutAll'].safeParse(undefined).success).toBe(true)
  })
})

describe('resume and the new address (RA2, RA8)', () => {
  let auth: RemoteAuth
  let server: RemoteServer
  let base: string
  const TUNNEL = 'quiet-tree-forty-two.trycloudflare.com'
  const api: RemoteApi = { handle: async (name) => (name === 'me' ? { device: { id: 'x', name: 'x' }, host: 'mac', companies: [] } : { ok: true }), socket: () => undefined }
  beforeEach(async () => {
    auth = new RemoteAuth({ store: new SqliteDeviceStore(db) })
    server = new RemoteServer({ auth, api, bundleDir: null, extraHosts: () => [TUNNEL], allowedOrigins: () => [SITE] })
    base = `http://127.0.0.1:${await server.start()}`
  })
  afterEach(async () => {
    await server.stop()
  })
  const pair = async (): Promise<{ token: string; device: { id: string; name: string } }> => {
    const r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ code: auth.createCode().code, name: 'iPhone' }) })
    return (await r.json()) as { token: string; device: { id: string; name: string } }
  }

  it('resume gives the hosted app a new token; the old one fades after the grace', async () => {
    const { token } = await pair()
    const r = await fetch(`${base}/api/resume`, { method: 'POST', headers: { origin: SITE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(200)
    const b = (await r.json()) as { token: string; expiresAt: string }
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b.token).not.toBe(token)
    expect(r.headers.get('set-cookie')).toBeNull()
    const me = (t: string) => fetch(`${base}/api/me`, { headers: { origin: SITE, authorization: `Bearer ${t}` } }).then((x) => x.status)
    expect(await me(b.token)).toBe(200)
    // the new one was used: the old one is done
    expect(await me(token)).toBe(401)
  })

  it('the Mac proves it knows the phone at the address the phone called; the token is never sent', async () => {
    const p = await pair()
    const seen: string[] = []
    const f = ((url: string, init: RequestInit) => {
      seen.push(`${url} ${JSON.stringify(init.headers)} ${String(init.body)}`)
      return fetch(url, init)
    }) as typeof fetch
    expect(await checkMac(f, base, p)).toBe('ok')
    expect(seen.join('\n')).not.toContain(p.token)
    // a phone with another token (not this Mac's phone) refuses the proof
    expect(await checkMac(fetch, base, { ...p, token: 'y'.repeat(43) })).toBe('wrong')
    // a look-alike address that relays to the real Mac: the Mac signs its own address, the phone asked another one
    const relay = ((url: string, init: RequestInit) => fetch(url.replace('https://evil-relay.trycloudflare.com', base), init)) as typeof fetch
    expect(await checkMac(relay, 'https://evil-relay.trycloudflare.com', p)).toBe('wrong')
    // nothing there
    expect(await checkMac((() => Promise.reject(new TypeError('offline'))) as typeof fetch, base, p)).toBe('gone')
    // revoked: this Mac does not know the phone any more
    auth.revoke(p.device.id)
    expect(await checkMac(fetch, base, p)).toBe('unknown')
  })

  it('hello through the tunnel host signs the https address; a bad nonce or a foreign page is refused', async () => {
    const p = await pair()
    const nonce = 'n'.repeat(32)
    // fetch cannot set Host: a raw request, as cloudflared forwards it
    const r = await new Promise<{ status: number; cors: unknown; body: string }>((resolve, reject) => {
      const u = new URL(base)
      const req = http.request({ host: u.hostname, port: u.port, path: '/api/hello', method: 'POST', headers: { host: TUNNEL, origin: SITE, 'content-type': 'application/json' } }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cors: res.headers['access-control-allow-origin'], body }))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ device: p.device.id, nonce }))
    })
    expect(r.status).toBe(200)
    expect(r.cors).toBe(SITE)
    expect((JSON.parse(r.body) as { proof: string }).proof).toBe(await helloProofFor(p.token, `https://${TUNNEL}`, nonce))
    // the same proof does not hold for the loopback address (it is bound to the address asked)
    expect((JSON.parse(r.body) as { proof: string }).proof).not.toBe(await helloProofFor(p.token, base, nonce))
    expect(await sha256Hex(p.token)).toBe(sha(p.token))
    const bad = await fetch(`${base}/api/hello`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify({ device: p.device.id, nonce: 'short' }) })
    expect(bad.status).toBe(404)
    const foreign = await fetch(`${base}/api/hello`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ device: p.device.id, nonce }) })
    expect(foreign.status).toBe(403)
  })

  it('the new address: words, a link of this site, or the Mac’s address', () => {
    const mac = `https://${TUNNEL}`
    expect(tunnelWords(mac)).toBe('quiet-tree-forty-two')
    expect(tunnelWords('https://phone.example.com')).toBeNull()
    const link = moveLinkFor({ site: SITE, mac })
    expect(parseMoveHash(new URL(link).hash)).toBe(mac)
    expect(macFromTyped('quiet-tree-forty-two', SITE)).toBe(mac)
    expect(macFromTyped('  Quiet Tree Forty Two ', SITE)).toBe(mac)
    expect(macFromTyped('quiet-tree-forty-two.trycloudflare.com', SITE)).toBe(mac)
    expect(macFromTyped(link, SITE)).toBe(mac)
    expect(macFromTyped(mac, SITE)).toBe(mac)
    // another site's link, plain http, junk
    expect(macFromTyped(moveLinkFor({ site: 'https://evil.example', mac }), SITE)).toBeNull()
    expect(macFromTyped('http://quiet-tree.example.com', SITE)).toBeNull()
    expect(macFromTyped('hello', SITE)).toBeNull()
    expect(macFromTyped('a/b/c', SITE)).toBeNull()
  })
})

describe('the same address after a Quit (RA8)', () => {
  const host: PhoneHost = { invoke: (async () => []) as unknown as PhoneHost['invoke'], onEvent: () => () => undefined }
  const URL_KEPT = 'https://quiet-tree-forty-two.trycloudflare.com'
  const procs = { isOurs: () => true, running: () => true, kill: () => undefined, reapAfter: () => null, endReaper: () => undefined }
  const memoryKeep = (): TunnelKeep => {
    let k: KeptTunnel | null = null
    return { load: () => k, save: (v) => (k = v), logPath: path.join(os.tmpdir(), `pr71-${process.pid}-${Date.now()}.log`) }
  }

  it('the server listens on the port the tunnel still points at, and the tunnel host is allowed', async () => {
    const keep = memoryKeep()
    const first = new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null, keep, procs }, autoStart: () => true })
    const on = await first.setEnabled(true)
    const port = Number(new URL(on.localUrl!).port)
    keep.save({ pid: 42, port, url: URL_KEPT })
    await first.setTunnel(true)
    await first.stop()
    expect(keep.load()?.port).toBe(port)

    const second = new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null, keep, procs }, autoStart: () => true })
    await second.autoStartIfWanted()
    const st = second.state()
    expect(st.localUrl).toBe(`http://127.0.0.1:${port}`)
    expect(st.tunnel).toEqual({ state: 'on', url: URL_KEPT, message: null })
    await second.setEnabled(false)
    expect(keep.load()).toBeNull()
  })

  it('a Quit with Phone not coming back at launch ends the tunnel', async () => {
    const keep = memoryKeep()
    const svc = new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null, keep, procs }, autoStart: () => false })
    const on = await svc.setEnabled(true)
    keep.save({ pid: 42, port: Number(new URL(on.localUrl!).port), url: URL_KEPT })
    await svc.stop()
    expect(keep.load()).toBeNull()
  })

  it('a taken port falls back to a random one', async () => {
    const taken = net.createServer()
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r))
    const port = (taken.address() as net.AddressInfo).port
    const keep = memoryKeep()
    keep.save({ pid: 42, port, url: URL_KEPT })
    const svc = new RemoteService({ host, bundleDir: null, emit: () => undefined, tunnel: { bin: () => null, keep, procs }, autoStart: () => true })
    const on = await svc.setEnabled(true)
    expect(on.enabled).toBe(true)
    expect(Number(new URL(on.localUrl!).port)).not.toBe(port)
    await svc.stop()
    await new Promise((r) => taken.close(r))
  })
})
