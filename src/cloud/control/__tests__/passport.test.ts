import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { readFolder, writeZip } from '../../../main/openPassport/fs'
import { proposalSummary } from '../passportHost'
import { startFakeHost, TINY_ZIP } from './fakePassportHost'
import { startHarness } from './harness'

const bundle = TINY_ZIP.toString('base64')

describe('Open Passport connected by default (CLOUD.md §7.1), against a fake host', () => {
  it('creates the passport, mints desktop, runtime and owner grants, and returns the desktop key once', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: 'https://passport.example.com', adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      const r = await h.call('PUT', '/v1/companies/co_vibiz', { token: dev, body: { name: 'Vibiz', slug: 'vibiz', passportBundle: bundle } })
      expect(r.status).toBe(200)
      expect(host.passports.has('co_vibiz')).toBe(true)
      const g = r.json.desktopPassportGrant
      expect(g).toEqual({ url: 'https://passport.example.com', passportId: 'co_vibiz', token: expect.stringMatching(/^opk_/) })
      const byApp = Object.fromEntries(host.grants.map(x => [x.app, x]))
      expect(byApp['principia-desktop']!.scopes).toEqual(['write:all', 'read:all'])
      expect(byApp['principia-desktop']!.token).toBe(g.token)
      expect(byApp['principia-cloud-agents']!.scopes).toEqual(['read:all', 'write:proposals', 'write:taste'])
      expect(byApp['principia-cloud-agents']!.trusted).toBe(false)
      expect(byApp['principia-cloud-owner']!.scopes).toEqual(['owner'])
      expect(r.json.company.passport).toEqual({ hostUrl: 'https://passport.example.com', passportId: 'co_vibiz', mcpUrl: 'https://passport.example.com/v1/passports/co_vibiz/mcp', revision: 1, pendingProposals: 0 })
      expect(r.json.company.cloudAgentWrites).toBe('propose')
      expect(h.rt.calls.some(c => c.method === 'ensureCompany')).toBe(true)

      // a second PUT updates and never returns a key; ?rotateDesktopGrant=1 revokes the old one and mints a new one
      const again = await h.call('PUT', '/v1/companies/co_vibiz', { token: dev, body: { name: 'Vibiz Inc', slug: 'vibiz' } })
      expect(again.json.desktopPassportGrant).toBeNull()
      expect(again.json.company.name).toBe('Vibiz Inc')
      const rot = await h.call('PUT', '/v1/companies/co_vibiz?rotateDesktopGrant=1', { token: dev, body: { name: 'Vibiz Inc', slug: 'vibiz' } })
      expect(rot.json.desktopPassportGrant.token).not.toBe(g.token)
      expect(host.grants.find(x => x.token === g.token)!.revoked).toBe(true)

      // trust toggle follows cloudAgentWrites
      const t = await h.call('PATCH', '/v1/companies/co_vibiz', { token: dev, body: { cloudAgentWrites: 'trusted' } })
      expect(t.json.cloudAgentWrites).toBe('trusted')
      expect(host.grants.find(x => x.app === 'principia-cloud-agents')!.trusted).toBe(true)

      const conns = await h.call('GET', '/v1/companies/co_vibiz/connections', { token: dev })
      expect(conns.json[0]).toEqual({ id: 'passport', name: 'Passport', transport: 'http', url: 'https://passport.example.com/v1/passports/co_vibiz/mcp', enabled: true, authentication: 'headers', authStatus: null, hasCredentials: true, builtIn: true })
      expect((await h.call('PUT', '/v1/companies/co_vibiz/connections/passport', { token: dev, body: { name: 'x', transport: 'http', url: 'https://a.example.com', enabled: true, authentication: 'none' } })).status).toBe(403)
      expect((await h.call('DELETE', '/v1/companies/co_vibiz/connections/passport', { token: dev })).status).toBe(403)
    } finally { await h.close(); await host.close() }
  })

  it('proxies proposals with the owner grant, with a human summary, and caches the revision for 30 s', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      host.passports.get('co_a')!.proposals.push({ id: 'pr1', kind: 'delta', app: 'principia-cloud-agents', created: '2026-10-21T09:00:00Z', status: 'pending', payload: { ops: [{ op: 'add', note: 'departments/marketing.md', line: 'a' }, { op: 'add', note: 'departments/marketing.md', line: 'b' }, { op: 'add', note: 'departments/marketing.md', line: 'c' }] } })
      const list = await h.call('GET', '/v1/companies/co_a/passport/proposals', { token: dev })
      expect(list.json).toEqual([{ id: 'pr1', kind: 'delta', app: 'principia-cloud-agents', created: '2026-10-21T09:00:00Z', summary: '3 new facts for Marketing from principia-cloud-agents' }])
      const owner = host.grants.find(x => x.app === 'principia-cloud-owner')!
      expect(host.requests.filter(x => x.path.endsWith('/proposals')).every(x => x.auth === owner.token)).toBe(true)
      const before = (await h.call('GET', '/v1/companies', { token: dev })).json[0].passport
      expect(before.revision).toBe(1)
      const d = await h.call('POST', '/v1/companies/co_a/passport/proposals/pr1/accept', { token: dev })
      expect(d.json.status).toBe('applied')
      const after = (await h.call('GET', '/v1/companies', { token: dev })).json[0].passport
      expect(after).toMatchObject({ revision: 2, pendingProposals: 0 })
      const changes = await h.call('GET', '/v1/sync/changes', { token: dev })
      expect(changes.json.passports).toEqual([{ companyId: 'co_a', revision: 2 }])
      expect((await h.call('POST', '/v1/companies/co_a/passport/proposals/pr1/maybe', { token: dev })).status).toBe(404)
    } finally { await h.close(); await host.close() }
  })

  it('DELETE revokes every grant, asks the runtime to remove the company and drops its rows', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      await h.call('PUT', '/v1/companies/co_a/secrets/FAL_KEY', { token: dev, body: { value: 'fal-secret-value-123' } })
      expect((await h.call('DELETE', '/v1/companies/co_a', { token: dev })).status).toBe(200)
      expect(host.grants.every(g => g.revoked)).toBe(true)
      expect(h.rt.calls.some(c => c.method === 'removeCompany' && c.args[1] === 'co_a')).toBe(true)
      expect((await h.call('GET', '/v1/companies/co_a/secrets', { token: dev })).status).toBe(404)
      // moving it again gets a fresh passport id (hosts never delete passports)
      const again = await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      expect(again.status).toBe(200)
      expect(again.json.company.passport.passportId).toMatch(/^co_a-/)
    } finally { await h.close(); await host.close() }
  })

  it('refuses a create without a bundle, answers 503 when the host is down, and readiness says so', async () => {
    const host = await startFakeHost()
    const h = await startHarness({ config: { passport: { internalUrl: host.url, publicUrl: host.url, adminToken: host.admin } } })
    try {
      const dev = await h.pair()
      expect((await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })).status).toBe(400)
      expect((await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: Buffer.from('nope').toString('base64') } })).status).toBe(400)
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a', passportBundle: bundle } })
      host.down = true
      ;(h.app.host as unknown as { health(): Promise<boolean> }).health = async () => false
      const down = await h.call('PUT', '/v1/companies/co_b', { token: dev, body: { name: 'B', slug: 'b', passportBundle: bundle } })
      expect([down.status, down.json.error]).toEqual([503, 'unavailable'])
      const list = await h.call('GET', '/v1/companies', { token: dev })
      expect(list.json[0].readiness.fixes).toContainEqual({ kind: 'passport', ref: 'co_a', message: 'The passport host is not answering. Check that the passport container is running.' })
      expect((await h.call('GET', '/v1/summary', { token: dev })).json.passportHost.status).toBe('down')
    } finally { await h.close(); await host.close() }
  })

  it('summarizes proposals in plain words', () => {
    expect(proposalSummary({ id: '1', kind: 'conflict', app: 'x', created: '', payload: { path: 'company.md' } })).toBe('A conflict in Company: the passport kept its line.')
    expect(proposalSummary({ id: '1', kind: 'taste', app: 'ChatGPT', created: '', payload: { polarity: 'prefers', statement: 'short emails' } })).toBe('1 taste from ChatGPT: prefers short emails')
    expect(proposalSummary({ id: '1', kind: 'delta', app: 'x', created: '', payload: { ops: [{ op: 'note', path: 'people/ana-ruiz.md' }] } })).toBe('1 new note for Ana ruiz from x')
  })
})

// ---------- integration with the real reference host (skipped when the sibling repo is absent) ----------

/** what a cloud run receives as materials.passport.token */
async function runtimeGrant(h: Awaited<ReturnType<typeof startHarness>>, cid: string): Promise<string> {
  const row = h.app.ctx.db.get<{ runtime_grant_id: string; runtime_grant_ct: string }>('SELECT runtime_grant_id, runtime_grant_ct FROM companies WHERE id = ?', cid)!
  return h.app.ctx.vault.decrypt('passport-grant', row.runtime_grant_id, row.runtime_grant_ct)
}

const HOST_MAIN = '/Users/example/Documents/vibiz/example-project/open-passport/packages/server/src/main.ts'
const ACME = '/Users/example/Documents/vibiz/example-project/open-passport/examples/acme'
const freePort = () => new Promise<number>(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })

describe.skipIf(!existsSync(HOST_MAIN) || !existsSync(ACME))('Open Passport provisioning against the real reference host', () => {
  it('creates a passport, a working desktop key, and a runtime grant that files proposals', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ophost-'))
    const port = await freePort()
    const admin = 'integration-admin-token-0123456789'
    const proc = spawn(process.execPath, [HOST_MAIN], { env: { ...process.env, OPEN_PASSPORT_ADMIN_TOKEN: admin, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', OPEN_PASSPORT_PUBLIC_URL: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] })
    const url = `http://127.0.0.1:${port}`
    try {
      for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/healthz`)).ok) break } catch { /* starting */ } await new Promise(r => setTimeout(r, 50)) }
      const h = await startHarness({ config: { passport: { internalUrl: url, publicUrl: url, adminToken: admin } } })
      try {
        const dev = await h.pair()
        const zip = Buffer.from(writeZip(readFolder(ACME))).toString('base64')
        const r = await h.call('PUT', '/v1/companies/co_acme', { token: dev, body: { name: 'Acme', slug: 'acme', passportBundle: zip } })
        expect(r.status).toBe(200)
        const g = r.json.desktopPassportGrant
        expect(g.passportId).toBe('co_acme')
        expect(r.json.company.passport.revision).toBeGreaterThanOrEqual(1)
        // the desktop key reads changes and pushes (write:all + read:all)
        const changes = await fetch(`${url}/v1/passports/co_acme/changes?since=0`, { headers: { authorization: `Bearer ${g.token}` } })
        expect(changes.status).toBe(200)
        const rev = await fetch(`${url}/v1/passports/co_acme/revisions`, { headers: { authorization: `Bearer ${g.token}` } })
        expect(rev.status).toBe(200)
        // the runtime grant files a delta as a proposal; the owner sees it through the control plane
        const token = await runtimeGrant(h, 'co_acme')
        const head = (await (await fetch(`${url}/v1/passports/co_acme?format=json`, { headers: { authorization: `Bearer ${token}` } })).json()) as { revision: number }
        const delta = await fetch(`${url}/v1/passports/co_acme/deltas`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ base: { revision: head.revision }, ops: [{ op: 'add', note: 'company.md', line: '- [context] Acme ships the cloud on Thursdays #cloud' }] }) })
        expect(delta.status).toBe(200)
        expect(((await delta.json()) as { status: string }).status).toBe('proposed')
        const props = await h.call('GET', '/v1/companies/co_acme/passport/proposals', { token: dev })
        expect(props.json).toHaveLength(1)
        expect(props.json[0].summary).toMatch(/1 new fact for Company/)
        // the runtime grant cannot push bundles
        const push = await fetch(`${url}/v1/passports/co_acme/revisions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip', 'x-base-revision': String(head.revision) }, body: Buffer.from(zip, 'base64') })
        expect(push.status).toBe(403)
        expect((await h.call('POST', `/v1/companies/co_acme/passport/proposals/${props.json[0].id}/accept`, { token: dev })).status).toBe(200)
        expect((await h.call('DELETE', '/v1/companies/co_acme', { token: dev })).status).toBe(200)
        expect((await fetch(`${url}/v1/passports/co_acme/changes?since=0`, { headers: { authorization: `Bearer ${g.token}` } })).status).toBe(401)
      } finally { await h.close() }
    } finally { proc.kill('SIGTERM'); rmSync(data, { recursive: true, force: true }) }
  }, 30_000)
})
