import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanyGateways, PASSPORT_CONNECTION_ID } from '../gateway'
import { ProcessSandbox } from '../sandbox'
import { Redactor } from '../redact'
import { fakePassportHost, tmp, waitFor, type FakeHost } from './fakes'

let host: FakeHost | null = null
let gw: CompanyGateways | null = null
afterEach(async () => {
  await gw?.close()
  await host?.close()
  gw = null
  host = null
})

async function setup() {
  const root = tmp()
  const sandbox = new ProcessSandbox({ runtimeDir: join(root, 'runtime'), workspaceDir: join(root, 'workspace'), hostEnv: { PATH: process.env.PATH, PRINCIPIA_SECRET: 'host-secret-value' } })
  const redactor = new Redactor()
  gw = new CompanyGateways({ dir: join(root, 'runtime', 'gateway'), bundleDir: join(root, 'bundle'), baseEnv: () => sandbox.baseEnv(), companyDir: (id) => sandbox.companyDir(id), addSecret: (v) => redactor.add(v) })
  await gw.start()
  return { root, sandbox, redactor, gw }
}

const NOTION = { id: 'notion', name: 'Notion', transport: 'http' as const, url: 'https://mcp.notion.com/mcp', credentials: { Authorization: 'Bearer notion-secret-token-0123' } }
const STDIO = { id: 'crm', name: 'CRM', transport: 'stdio' as const, command: process.execPath, args: ['crm.js'], credentials: { CRM_API_KEY: 'crm-secret-key-0123' } }

describe('company gateway', () => {
  it('holds the company connections and the built-in passport; the agent gets a bridge, never a credential', async () => {
    const { sandbox, redactor, gw: g, root } = await setup()
    const passport = { internalUrl: 'http://passport:8787', publicUrl: 'https://passport.example.com', passportId: 'pp_acme', token: 'opk_runtime_grant_secret_0123' }
    expect(g.sync('co_acme', [NOTION, STDIO, { ...NOTION, id: PASSPORT_CONNECTION_ID, name: 'Impostor' }], passport)).toEqual([])
    const list = g.list('co_acme')
    expect(list.map((c) => c.id).sort()).toEqual(['crm', 'notion', 'passport'])
    const pp = list.find((c) => c.id === PASSPORT_CONNECTION_ID)!
    expect(pp.name).toBe('Open Passport')
    expect(pp.transport).toBe('http')
    // a compose-network host goes through the loopback relay; the gateway's https rule stays as it is
    expect(pp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_-]+\/v1\/passports\/pp_acme\/mcp$/)
    expect(pp.roots).toEqual([sandbox.companyDir('co_acme')])
    expect(pp.hasCredentials).toBe(true)
    const spec = g.attachment(sandbox.companyDir('co_acme'), 'co_acme')!
    expect(spec).not.toBeNull()
    expect(Object.keys(spec.env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'PRINCIPIA_GATEWAY_DIR'])
    const everything = JSON.stringify({ spec, list })
    for (const secret of ['notion-secret-token-0123', 'crm-secret-key-0123', 'opk_runtime_grant_secret_0123', 'host-secret-value']) expect(everything).not.toContain(secret)
    // at rest: ciphertext only
    const saved = readFileSync(join(root, 'runtime', 'gateway', 'co_acme', 'mcp-connections.json'), 'utf8')
    for (const secret of ['notion-secret-token-0123', 'crm-secret-key-0123', 'opk_runtime_grant_secret_0123']) expect(saved).not.toContain(secret)
    // every credential is redacted in logs
    expect(redactor.redact('x opk_runtime_grant_secret_0123 notion-secret-token-0123 crm-secret-key-0123')).not.toMatch(/secret/)
    // outside the company folder, or for another company: nothing
    expect(g.attachment(root, 'co_acme')).toBeNull()
    expect(g.attachment(sandbox.companyDir('co_acme'), 'co_other')).toBeNull()
    expect(g.attachment(sandbox.companyDir('co_acme'), null)).toBeNull()
    // the next run's materials replace the set
    g.sync('co_acme', [NOTION], null)
    expect(g.list('co_acme').map((c) => c.id)).toEqual(['notion'])
  })

  it('a https or loopback passport host is used directly', async () => {
    const { gw: g } = await setup()
    expect(g.passportConnection({ internalUrl: 'https://passport.example.com/', publicUrl: '', passportId: 'pp_1', token: 't' }).url).toBe('https://passport.example.com/v1/passports/pp_1/mcp')
    expect(g.passportConnection({ internalUrl: 'http://127.0.0.1:8787', publicUrl: '', passportId: 'pp_1', token: 't' }).url).toBe('http://127.0.0.1:8787/v1/passports/pp_1/mcp')
  })

  it('end to end: a bridge request lists the passport tools, with the grant as a header the agent never sees', async () => {
    host = await fakePassportHost()
    const { sandbox, gw: g } = await setup()
    const material = { internalUrl: host.url, publicUrl: '', passportId: 'pp_acme', token: host.token }
    g.sync('co_acme', [], material)
    const spec = g.attachment(sandbox.companyDir('co_acme'), 'co_acme')!
    const dir = spec.env.PRINCIPIA_GATEWAY_DIR!
    const id = 'a'.repeat(32)
    writeFileSync(join(dir, `${id}.request`), JSON.stringify({ method: 'list' }), { mode: 0o600 })
    await waitFor(() => existsSync(join(dir, `${id}.answer`)), 10_000)
    const answer = JSON.parse(readFileSync(join(dir, `${id}.answer`), 'utf8'))
    expect(answer.ok).toBe(true)
    expect(JSON.stringify(answer.result)).toContain('passport_search')
    expect(host.requests.filter((r) => r.path.endsWith('/mcp')).every((r) => r.auth === `Bearer ${host!.token}`)).toBe(true)
  })

  it('the relay itself forwards to a registered host', async () => {
    host = await fakePassportHost()
    const { gw: g } = await setup()
    const url = g.relay.url(host.url, 'pp_acme')
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 7, result: { tools: [{ name: 'passport_search' }] } })
    const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(401)
    expect((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(404)
  })
})
