/** QA edge cases for the control plane: stale write-backs, revoked devices, retries, isolation, bad input. */
import { describe, expect, it } from 'vitest'
import { isPrivateAddress } from '../connections'
import { startFakeHost, TINY_ZIP } from './fakePassportHost'
import { startHarness, workflowFile } from './harness'

const tick = () => new Promise(r => setTimeout(r, 20))
const bundle = TINY_ZIP.toString('base64')

describe('provider credentials', () => {
  it('a stale codex auth.json write-back never replaces a credential the user saved during the run', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const old = JSON.stringify({ tokens: { refresh_token: 'rt-OLD-0123456789abcdef' } })
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'codex_auth_json', value: old } })
      const oldId = (await h.call('GET', '/v1/providers', { token: dev })).json.find((p: { adapter: string }) => p.adapter === 'codex').credential.id as string
      // the run refreshes the old file: written back in place
      h.app.ports.saveProviderCredential({ credentialId: oldId, adapter: 'codex', kind: 'codex_auth_json', value: JSON.stringify({ tokens: { refresh_token: 'rt-OLD-refreshed-0123456789' } }) })
      expect(h.app.ctx.vault.decrypt('provider', oldId, h.app.ctx.db.get<{ ciphertext: string }>('SELECT ciphertext FROM credentials WHERE id = ?', oldId)!.ciphertext)).toContain('refreshed')
      // the user signs in again on the Mac while a run on the old one is still going
      const fresh = JSON.stringify({ tokens: { refresh_token: 'rt-NEW-0123456789abcdef' } })
      await h.call('PUT', '/v1/providers/codex/credential', { token: dev, body: { kind: 'codex_auth_json', value: fresh } })
      const newId = (await h.call('GET', '/v1/providers', { token: dev })).json.find((p: { adapter: string }) => p.adapter === 'codex').credential.id as string
      expect(newId).not.toBe(oldId)
      // the old run ends and writes back the old (refreshed) file: dropped
      h.app.ports.saveProviderCredential({ credentialId: oldId, adapter: 'codex', kind: 'codex_auth_json', value: JSON.stringify({ tokens: { refresh_token: 'rt-OLD-refreshed-again-0123' } }) })
      const rows = h.app.ctx.db.all<{ id: string; ciphertext: string }>("SELECT id, ciphertext FROM credentials WHERE adapter = 'codex'")
      expect(rows.map(r => r.id)).toEqual([newId])
      expect(h.app.ctx.vault.decrypt('provider', newId, rows[0]!.ciphertext)).toBe(fresh)
    } finally { await h.close() }
  })

  it('a run on an expired sign-in fails with the readiness sentence instead of starting', async () => {
    let now = new Date('2026-01-01T00:00:00Z')
    const h = await startHarness({ now: () => now })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      await h.call('PUT', '/v1/companies/co_a/workflows/w', { token: dev, body: { file: workflowFile('Brief', [{ id: 'm', type: 'agent', profileId: 'prof_claude', prompt: 'x' }]), baseRev: null } })
      await h.call('PUT', '/v1/providers/claude/credential', { token: dev, body: { kind: 'claude_oauth_token', value: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz' } })
      now = new Date('2027-01-02T00:00:00Z')
      expect((await h.call('GET', '/v1/providers', { token: dev })).json.find((p: { adapter: string }) => p.adapter === 'claude').status).toBe('expired')
      const r = await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })
      await tick()
      const run = (await h.call('GET', `/v1/runs/${r.json.id}`, { token: dev })).json
      expect(run.status).toBe('failed')
      expect(run.summary).toMatch(/Claude sign-in expired/)
      expect(h.rt.started).toHaveLength(0)
    } finally { await h.close() }
  })

  it('usage with a non-finite or negative dollar amount is stored without dollars and never trips the spend cap', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      await h.call('PATCH', '/v1/workspace', { token: dev, body: { quotas: { monthlyApiUsdPerCompany: 5 } } })
      h.app.ports.usage({ runId: 'crun_x', companyId: 'co_a', adapter: 'claude', inputTokens: 10, outputTokens: 5, usd: Number.NaN })
      h.app.ports.usage({ runId: 'crun_x', companyId: 'co_a', adapter: 'claude', inputTokens: 10, outputTokens: 5, usd: -100 })
      expect((await h.call('GET', '/v1/companies', { token: dev })).json[0].paused).toBe(false)
      expect(h.app.ctx.db.all<{ usd: string | null }>('SELECT usd FROM usage').map(u => u.usd)).toEqual([null, null])
      expect((await h.call('GET', '/v1/usage', { token: dev })).json.companies[0]).toMatchObject({ apiUsd: 0, inputTokens: 20 })
    } finally { await h.close() }
  })
})

describe('identity', () => {
  it('a console link minted by a device that is later revoked does not open a session', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const other = await h.pair('Other Mac')
      const link = await h.call('POST', '/v1/login-links', { token: dev })
      const devId = (await h.call('GET', '/v1/me', { token: dev })).json.device.id as string
      expect((await h.call('DELETE', `/v1/devices/${devId}`, { token: other })).status).toBe(200)
      const t = new URL(link.json.url).searchParams.get('t')!
      const login = await h.call('GET', `/console/login?t=${t}`)
      expect(login.status).toBe(400)
      expect(login.headers.get('set-cookie')).toBeNull()
      expect(h.app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(0)
    } finally { await h.close() }
  })

  it('malformed percent-encoding in a path is a 4xx, never a 500 with a stack in the logs', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      for (const p of ['/v1/companies/%E0%A4%A', '/v1/runs/%', '/console/%E0%A4%A']) {
        const r = await h.call('GET', p, { token: dev })
        expect([p, r.status >= 400 && r.status < 500]).toEqual([p, true])
      }
      expect(h.logs.some(l => l.includes('request failed'))).toBe(false)
    } finally { await h.close() }
  })

  it('an encoded slash cannot reach another route or company', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      expect((await h.call('GET', '/v1/companies/co_a%2F..%2Fco_b/secrets', { token: dev })).status).toBe(404)
      expect((await h.call('PUT', '/v1/companies/co_a%2Fx', { token: dev, body: { name: 'X', slug: 'x' } })).status).toBe(400)
    } finally { await h.close() }
  })

  it('caps JSON bodies (413) and refuses non-JSON (400)', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const big = await h.call('PUT', '/v1/companies/co_a/secrets/BIG', { token: dev, rawBody: JSON.stringify({ value: 'x'.repeat(2_000_000) }), headers: { 'content-type': 'application/json' } })
      expect(big.status).toBe(413)
      const bad = await h.call('PATCH', '/v1/workspace', { token: dev, rawBody: '{nope', headers: { 'content-type': 'application/json' } })
      expect(bad.status).toBe(400)
    } finally { await h.close() }
  })
})

describe('moving a company: retries and races', () => {
  it('when the runtime cannot prepare the company, nothing is provisioned and the retry returns the desktop key', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      const ensure = h.rt.ensureCompany
      h.rt.ensureCompany = async () => { throw new Error('disk full') }
      const first = await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      expect(first.status).toBe(503)
      expect(host.passports.size).toBe(0)
      expect((await h.call('GET', '/v1/companies', { token: dev })).json).toEqual([])
      h.rt.ensureCompany = ensure
      const retry = await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      expect(retry.status).toBe(200)
      expect(retry.json.desktopPassportGrant.token).toMatch(/^opk_/)
      expect([...host.passports.keys()]).toEqual(['co_a'])
    } finally { await h.close(); await host.close() }
  })

  it('two first-time PUTs of one company at once create one passport; the other is a 409', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      const put = () => h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      const [a, b] = await Promise.all([put(), put()])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      expect(host.passports.size).toBe(1)
      expect(h.logs.some(l => l.includes('request failed'))).toBe(false)
    } finally { await h.close(); await host.close() }
  })
})

describe('isolation between companies', () => {
  it('a schedule id is unique in the workspace, so fire slots never cross companies', async () => {
    const h = await startHarness()
    try {
      const dev = await h.pair()
      const sched = { schedule: { name: 'Daily', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, target: { kind: 'workflow', workflowId: 'w', inputs: {} }, enabled: true }, placement: 'cloud', baseRev: null }
      for (const c of ['co_a', 'co_b']) {
        await h.call('PUT', `/v1/companies/${c}`, { token: dev, body: { name: c, slug: c } })
        await h.call('PUT', `/v1/companies/${c}/workflows/w`, { token: dev, body: { file: workflowFile('W'), baseRev: null } })
      }
      expect((await h.call('PUT', '/v1/companies/co_a/schedules/daily', { token: dev, body: sched })).status).toBe(200)
      const clash = await h.call('PUT', '/v1/companies/co_b/schedules/daily', { token: dev, body: sched })
      expect(clash.status).toBe(409)
      // the owner can still update its own
      expect((await h.call('PUT', '/v1/companies/co_a/schedules/daily', { token: dev, body: { ...sched, baseRev: 1 } })).status).toBe(200)
    } finally { await h.close() }
  })

  it('a run gets only its own company\'s keys, repos and connections', async () => {
    const h = await startHarness({ config: { lookup: async () => ['93.184.216.34'] } })
    try {
      const dev = await h.pair()
      for (const c of ['co_a', 'co_b']) {
        await h.call('PUT', `/v1/companies/${c}`, { token: dev, body: { name: c, slug: c } })
        await h.call('PUT', `/v1/companies/${c}/secrets/KEY_${c.toUpperCase()}`, { token: dev, body: { value: `value-of-${c}-0123456789` } })
        await h.call('PUT', `/v1/companies/${c}/repos/r_${c}`, { token: dev, body: { name: c, url: `https://github.com/acme/${c}`, credential: { kind: 'public' } } })
        await h.call('PUT', `/v1/companies/${c}/connections/conn_${c}`, { token: dev, body: { name: c, transport: 'http', url: `https://${c}.example.com/mcp`, enabled: true, authentication: 'headers', credentials: { 'X-Key': `hdr-${c}-0123456789` } } })
        await h.call('PUT', `/v1/companies/${c}/workflows/w`, { token: dev, body: { file: workflowFile('W', [{ id: 's', type: 'shell', command: 'echo' }]), baseRev: null } })
      }
      await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })
      await tick()
      const m = h.rt.started[0]!.materials
      expect(Object.keys(m.secrets)).toEqual(['KEY_CO_A'])
      expect(m.repos.map(r => r.id)).toEqual(['r_co_a'])
      expect(m.connections.map(c => c.id)).toEqual(['conn_co_a'])
      expect(JSON.stringify(m)).not.toContain('co_b')
    } finally { await h.close() }
  })
})

describe('SSRF guard', () => {
  it('treats IPv4-compatible IPv6 (::a.b.c.d) as private', () => {
    for (const ip of ['::7f00:1', '::a00:1', '::1', '::']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true])
    for (const ip of ['2606:4700::1', '93.184.216.34']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false])
    expect(isPrivateAddress(new URL('https://[::127.0.0.1]/').hostname.replace(/^\[|\]$/g, ''))).toBe(true)
  })
})
