import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GatewayService } from '../service'
import type { Vault } from '../../vault'
import type { VirtualConnection } from '../../connections/resolver'

/** CONNECTIONS.md §3.3: a saved key the vendor's MCP takes as a bearer gives the company's agents its tools. */
const KEY = 'phx_stub_key_value_0001'
let server: Server
let url: string
let seen: string[]
let dir: string
let service: GatewayService
let virtuals: VirtualConnection[]

const cipher = (() => {
  const key = crypto.randomBytes(32)
  return {
    available: () => true,
    encrypt: (s: string) => { const nonce = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, c.update(s), c.final(), c.getAuthTag()]) },
    decrypt: (b: Buffer) => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString() }
  }
})()

const virtual = (value: string): VirtualConnection => ({ id: 'svc:posthog', serviceId: 'posthog', name: 'PostHog', url, keyNames: ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_API_KEY'], fingerprint: value.slice(-4), headers: () => ({ Authorization: `Bearer ${value}` }) })

async function ask(grantDir: string, body: unknown): Promise<{ ok: boolean; result?: any; error?: string }> {
  const id = crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(path.join(grantDir, id + '.request'), JSON.stringify(body))
  for (let i = 0; i < 80; i++) {
    try { return JSON.parse(fs.readFileSync(path.join(grantDir, id + '.answer'), 'utf8')) } catch { await new Promise((r) => setTimeout(r, 50)) }
  }
  throw new Error('no answer')
}

beforeEach(async () => {
  seen = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(String(req.headers.authorization ?? ''))
      const m = JSON.parse(body) as { id?: number; method: string }
      if (m.id === undefined) { res.writeHead(202); res.end(); return }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'insights-list', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: 'ok' }] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-virtual-'))
  virtuals = [virtual(KEY)]
  service = new GatewayService({ userData: dir, mainDir: dir, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({}), virtuals: (companyId) => (companyId === 'co_a' ? virtuals : []) })
})
afterEach(async () => {
  service.close()
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('gateway: key-backed connections', () => {
  it('grants the company’s key-backed connection, sends the key as a bearer at call time, and never stores it', async () => {
    // only the company with the key gets a gateway at all
    expect(service.attachment(dir, 'co_b', null, ['*'])).toBeNull()
    const spec = service.attachment(dir, 'co_a', null, ['*'])!
    const grant = spec.env.PRINCIPIA_GATEWAY_DIR
    const list = await ask(grant, { method: 'list' })
    expect(list.ok).toBe(true)
    expect(list.result).toEqual([{ id: 'svc:posthog', name: 'PostHog', tools: [expect.objectContaining({ name: 'insights-list' })] }])
    const call = await ask(grant, { method: 'call', connection: 'svc:posthog', tool: 'insights-list', arguments: {} })
    expect(call).toMatchObject({ ok: true })
    expect(seen.every((h) => h === `Bearer ${KEY}`)).toBe(true)
    // never written to the saved connections or the grant folder
    expect(fs.existsSync(path.join(dir, 'mcp-connections.json')) ? fs.readFileSync(path.join(dir, 'mcp-connections.json'), 'utf8') : '').not.toContain(KEY)
    for (const f of fs.readdirSync(grant)) expect(fs.readFileSync(path.join(grant, f), 'utf8')).not.toContain(KEY)
    expect(service.list()).toEqual([])
  })

  it('a new key gets a new client; a removed key drops the connection with its connect link', async () => {
    const grant = service.attachment(dir, 'co_a', null, ['*'])!.env.PRINCIPIA_GATEWAY_DIR
    await ask(grant, { method: 'list' })
    virtuals = [virtual(KEY + 'B')]
    seen = []
    await ask(grant, { method: 'call', connection: 'svc:posthog', tool: 'insights-list', arguments: {} })
    expect(seen.at(-1)).toBe(`Bearer ${KEY}B`)
    virtuals = []
    const gone = await ask(grant, { method: 'call', connection: 'svc:posthog', tool: 'insights-list', arguments: {} })
    expect(gone.ok).toBe(false)
    expect(gone.error).toContain('principia://connect/posthog?company=co_a')
  })

  it('a saved connection to the same service wins over the key-backed one', async () => {
    service.save({ id: 'ph-real', name: 'PostHog', transport: 'http', url: 'https://mcp.posthog.com/mcp', authentication: 'none', enabled: true, roots: [], scope: 'global', companyIds: ['co_a'], credentials: {} })
    const grant = service.attachment(dir, 'co_a', null, ['*'])!.env.PRINCIPIA_GATEWAY_DIR
    const call = await ask(grant, { method: 'call', connection: 'svc:posthog', tool: 'insights-list', arguments: {} })
    expect(call.ok).toBe(false)
    expect(call.error).toContain('is not connected for this company')
    expect(seen).toEqual([])
  })

  it('SEC-4: only a spawn whose profile may read the key gets its connection (none without a profile list)', async () => {
    expect(service.attachment(dir, 'co_a')).toBeNull()
    expect(service.attachment(dir, 'co_a', null, [])).toBeNull()
    expect(service.attachment(dir, 'co_a', null, ['GITHUB_TOKEN'])).toBeNull()
    // an older name of the key counts
    expect(service.attachment(dir, 'co_a', null, ['POSTHOG_API_KEY'])).not.toBeNull()
  })

  it('QP-2: the spawn keeps the founder’s own server for a service Principia already serves out of it', () => {
    const spec = service.attachment(dir, 'co_a', null, ['*'])!
    expect(spec.deny).toEqual(['mcp__posthog'])
  })

  it('CONN-QA-01: a vendor that answers 401 to the key marks it turned down', async () => {
    const hit: string[] = []
    service.close()
    const rejecting = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(401)
        res.end()
      })
    })
    await new Promise<void>((r) => rejecting.listen(0, '127.0.0.1', r))
    const bad = `http://127.0.0.1:${(rejecting.address() as AddressInfo).port}/mcp`
    service = new GatewayService({ userData: dir, mainDir: dir, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({}), virtuals: () => [{ ...virtual(KEY), url: bad }], onVirtualRejected: (c, s) => hit.push(`${c}:${s}`) })
    const grant = service.attachment(dir, 'co_a', null, ['*'])!.env.PRINCIPIA_GATEWAY_DIR
    const call = await ask(grant, { method: 'call', connection: 'svc:posthog', tool: 'insights-list', arguments: {} })
    expect(call.ok).toBe(false)
    expect(hit).toContain('co_a:posthog')
    await new Promise((r) => rejecting.close(r))
  })
})
