import { describe, expect, it } from 'vitest'
import { CLOUD_ROUTES, CSRF_HEADER, NOT_IN_V1_ROUTES, routePath, type CloudRouteName } from '../../../shared/cloud'
import { dumpText } from '../db'
import { routePolicy } from '../server'
import { ADMIN, consoleSession, startHarness } from './harness'

describe('pairing (CLOUD.md §5)', () => {
  it('codes are single use', async () => {
    const h = await startHarness()
    try {
      const s = await h.call('POST', '/v1/pair/start', { token: ADMIN })
      expect(s.status).toBe(201)
      expect(s.json.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
      expect(s.json.link).toBe(`${h.url}/pair#${s.json.code}`)
      const body = { code: s.json.code.toLowerCase().replace('-', ''), deviceName: 'Mac', platform: 'darwin-arm64' }
      const ok = await h.call('POST', '/v1/pair/complete', { body })
      expect(ok.status).toBe(201)
      expect(ok.json.deviceToken).toMatch(/^pdt_[A-Za-z0-9_-]{43}$/)
      expect(ok.json.workspace.name).toBe('Test cloud')
      expect((await h.call('POST', '/v1/pair/complete', { body })).status).toBe(401)
    } finally { await h.close() }
  })

  it('codes expire after 10 minutes', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const h = await startHarness({ now: () => new Date(t) })
    try {
      const s = await h.call('POST', '/v1/pair/start', { token: ADMIN })
      t += 10 * 60_000 + 1
      const r = await h.call('POST', '/v1/pair/complete', { body: { code: s.json.code, deviceName: 'Mac', platform: 'darwin-arm64' } })
      expect(r.status).toBe(401)
      expect(r.json).toEqual({ error: 'unauthorized', message: expect.stringContaining('expired') })
    } finally { await h.close() }
  })

  it('10 failed attempts per IP in 10 minutes return 429, even for a valid code', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const h = await startHarness({ now: () => new Date(t) })
    try {
      for (let i = 0; i < 10; i++) expect((await h.call('POST', '/v1/pair/complete', { body: { code: 'AAAA-AAAA', deviceName: 'x', platform: 'y' } })).status).toBe(401)
      const s = await h.call('POST', '/v1/pair/start', { token: ADMIN })
      const blocked = await h.call('POST', '/v1/pair/complete', { body: { code: s.json.code, deviceName: 'Mac', platform: 'p' } })
      expect(blocked.status).toBe(429)
      expect(blocked.json.error).toBe('rate_limited')
      t += 10 * 60_000 + 1
      const s2 = await h.call('POST', '/v1/pair/start', { token: ADMIN })
      expect((await h.call('POST', '/v1/pair/complete', { body: { code: s2.json.code, deviceName: 'Mac', platform: 'p' } })).status).toBe(201)
    } finally { await h.close() }
  })

  it('the admin token pairs only; without PRINCIPIA_ADMIN_TOKEN pair/start is 403 and a device can still mint codes', async () => {
    const h = await startHarness()
    try {
      expect((await h.call('GET', '/v1/companies', { token: ADMIN })).status).toBe(401)
      expect((await h.call('GET', '/v1/me', { token: ADMIN })).status).toBe(401)
      expect((await h.call('POST', '/v1/pair/start', { token: 'wrong-admin-token-0123456789-0123456789' })).status).toBe(401)
      const dev = await h.pair()
      h.app.ctx.config.adminToken = null
      const off = await h.call('POST', '/v1/pair/start', { token: ADMIN })
      expect(off.status).toBe(403)
      expect(off.json.message).toMatch(/principia-cloud pair/)
      expect((await h.call('POST', '/v1/pair/start')).status).toBe(403)
      expect((await h.call('POST', '/v1/pair/start', { token: dev })).status).toBe(201)
    } finally { await h.close() }
  })
})

describe('device tokens', () => {
  it('are stored only as SHA-256, can be revoked, and lastSeenAt is throttled to a minute', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const h = await startHarness({ now: () => new Date(t) })
    try {
      const dev = await h.pair()
      expect(dumpText(h.app.ctx.db)).not.toContain(dev)
      const me = await h.call('GET', '/v1/me', { token: dev })
      expect(me.status).toBe(200)
      expect(me.json.device.current).toBe(true)
      expect(me.json.csrf).toBeNull()
      const seen1 = me.json.device.lastSeenAt
      t += 30_000
      expect((await h.call('GET', '/v1/me', { token: dev })).json.device.lastSeenAt).toBe(seen1)
      t += 31_000
      expect((await h.call('GET', '/v1/me', { token: dev })).json.device.lastSeenAt).not.toBe(seen1)
      const other = await h.pair('Other Mac')
      const list = await h.call('GET', '/v1/devices', { token: dev })
      expect(list.json).toHaveLength(2)
      const otherId = list.json.find((d: { name: string }) => d.name === 'Other Mac').id
      expect((await h.call('DELETE', `/v1/devices/${otherId}`, { token: dev })).status).toBe(200)
      expect((await h.call('GET', '/v1/me', { token: other })).status).toBe(401)
      expect((await h.call('DELETE', `/v1/devices/${otherId}`, { token: dev })).status).toBe(404)
      expect((await h.call('GET', '/v1/me', { token: 'pdt_' + 'x'.repeat(43) })).status).toBe(401)
    } finally { await h.close() }
  })
})

describe('console sessions and CSRF', () => {
  it('session writes need the CSRF header; device-only routes refuse sessions; logout ends the session', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const s = await consoleSession(h, dev)
      expect((await h.call('GET', '/v1/workspace', { headers: { cookie: s.cookie } })).status).toBe(200)
      const noCsrf = await h.call('PATCH', '/v1/workspace', { headers: { cookie: s.cookie }, body: { paused: true } })
      expect(noCsrf.status).toBe(403)
      const bad = await h.call('PATCH', '/v1/workspace', { headers: { cookie: s.cookie, [CSRF_HEADER]: 'nope' }, body: { paused: true } })
      expect(bad.status).toBe(403)
      const good = await h.call('PATCH', '/v1/workspace', { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: { paused: true } })
      expect(good.status).toBe(200)
      expect(good.json.paused).toBe(true)
      const quotas = await h.call('PATCH', '/v1/workspace', { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: { quotas: { maxConcurrentRuns: 9 } } })
      expect(quotas.status).toBe(403)
      expect((await h.call('PUT', '/v1/providers/claude/credential', { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: { kind: 'anthropic_api_key', value: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx' } })).status).toBe(403)
      expect((await h.call('POST', '/v1/login-links', { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf } })).status).toBe(403)
      expect((await h.call('POST', '/v1/logout', { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf } })).status).toBe(200)
      expect((await h.call('GET', '/v1/workspace', { headers: { cookie: s.cookie } })).status).toBe(401)
      // revoking the device ends the sessions it opened
      const s2 = await consoleSession(h, dev)
      const devId = (await h.call('GET', '/v1/me', { token: dev })).json.device.id
      const other = await h.pair('Other')
      await h.call('DELETE', `/v1/devices/${devId}`, { token: other })
      expect((await h.call('GET', '/v1/workspace', { headers: { cookie: s2.cookie } })).status).toBe(401)
    } finally { await h.close() }
  })

  it('sessions expire after 12 hours', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const h = await startHarness({ now: () => new Date(t) })
    try {
      const s = await consoleSession(h, await h.pair())
      t += 12 * 3600_000 + 1
      expect((await h.call('GET', '/v1/me', { headers: { cookie: s.cookie } })).status).toBe(401)
    } finally { await h.close() }
  })
})

describe('auth matrix: every route in CLOUD_ROUTES', () => {
  const sample: Record<string, string> = { id: 'x1', cid: 'co_x', pid: 'p1', decision: 'accept', adapter: 'claude', loginId: 'l1', name: 'KEY', rid: 'r1', wid: 'w1', sid: 's1', hid: 'h1', secret: 's', chid: 'c1' }
  const names = Object.keys(CLOUD_ROUTES) as CloudRouteName[]

  it('routes cut from v1 answer 501 not_in_v1, whoever asks', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      for (const n of NOT_IN_V1_ROUTES) {
        const [method] = CLOUD_ROUTES[n].split(' ')
        for (const token of [null, dev]) {
          const r = await h.call(method!, routePath(n, sample), { token, body: method === 'GET' || method === 'DELETE' ? undefined : {} })
          expect([n, r.status, r.json?.error]).toEqual([n, 501, 'not_in_v1'])
        }
      }
      await h.call('PUT', '/v1/companies/co_x', { token: dev, body: { name: 'X', slug: 'x' } })
      const at = await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'codex_access_token', value: 'x'.repeat(40) } })
      expect([at.status, at.json.error]).toEqual([501, 'not_in_v1'])
      const app = await h.call('PUT', '/v1/companies/co_x/repos/r1', { token: dev, body: { name: 'q', url: 'https://github.com/a/q', credential: { kind: 'github_app', installationId: 1 } } })
      expect([app.status, app.json.error]).toEqual([501, 'not_in_v1'])
    } finally { await h.close() }
  })

  it('no credentials: 401 everywhere except open routes; a session on a device-only route: 403', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const s = await consoleSession(h, dev)
      for (const n of names) {
        if (NOT_IN_V1_ROUTES.includes(n)) continue
        const [method] = CLOUD_ROUTES[n].split(' ')
        const path = routePath(n, sample)
        const policy = routePolicy(n)
        const anon = await h.call(method!, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} })
        if (policy === 'open') expect([n, anon.status]).not.toEqual([n, 401])
        else if (policy === 'pair') expect([n, anon.status]).toEqual([n, 401])
        else expect([n, anon.status, anon.json?.error]).toEqual([n, 401, 'unauthorized'])
        if (policy === 'device' || policy === 'pair') {
          const viaSession = await h.call(method!, path, { headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf }, body: method === 'GET' || method === 'DELETE' ? undefined : {} })
          if (policy === 'device') expect([n, viaSession.status]).toEqual([n, 403])
        }
        if (policy === 'any' && method !== 'GET') {
          const noCsrf = await h.call(method!, path, { headers: { cookie: s.cookie }, body: {} })
          expect([n, noCsrf.status]).toEqual([n, 403])
        }
      }
      expect((await h.call('GET', '/v1/health')).status).toBe(200)
      expect((await h.call('GET', '/v1/nope', { token: dev })).status).toBe(404)
    } finally { await h.close() }
  })

  it('the console can do its two jobs: answer and glance (and pause)', () => {
    for (const n of ['me', 'runs', 'run', 'runLog', 'runCancel', 'asks', 'askAnswer', 'events', 'summary', 'workspacePatch', 'passportProposals', 'passportDecide'] as CloudRouteName[]) expect(routePolicy(n)).toBe('any')
    for (const n of ['providerPut', 'secretPut', 'repoPut', 'connectionPut', 'workflowPut', 'schedulePut', 'companyPut', 'loginLink', 'devices', 'deviceRevoke', 'audit', 'syncChanges'] as CloudRouteName[]) expect(routePolicy(n)).toBe('device')
  })
})
