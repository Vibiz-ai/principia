import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Upstream } from '../client'
import { GatewayService } from '../service'
import { attachGateway } from '../attach'
import type { Vault } from '../../vault'

describe('Principia MCP gateway', () => {
  it('encrypts credentials, grants only approved folders and revokes an existing grant', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-test-'))
    const root = path.join(dir, 'project'); fs.mkdirSync(root)
    const sibling = path.join(dir, 'project-other'); fs.mkdirSync(sibling)
    const key = crypto.randomBytes(32)
    const cipher = { available: () => true, encrypt: (s: string) => { const nonce = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, c.update(s), c.final(), c.getAuthTag()]) }, decrypt: (b: Buffer) => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12,-16)), c.final()]).toString() } }
    const service = new GatewayService({ userData: dir, mainDir: dir, bridgePath: path.join(dir, 'cloud-bridge.mjs'), cipher, vault: { addRedactions() {}, removeRedactions() {} } as unknown as Vault, baseEnv: () => ({}) })
    try {
      service.save({ id: 'test', name: 'Test', transport: 'stdio', command: 'unused', enabled: true, roots: [root], credentials: { TOKEN: 'secret-value-test' } })
      expect(fs.readFileSync(path.join(dir, 'mcp-connections.json'), 'utf8')).not.toContain('secret-value-test')
      expect(service.list()[0]).not.toHaveProperty('credentials')
      expect(service.attachment(sibling)).toBeNull()
      service.save({ id: 'test', name: 'Test', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global' })
      expect(service.attachment(sibling)).not.toBeNull()
      const future = path.join(dir, 'future-project'); fs.mkdirSync(future)
      expect(service.attachment(future)).not.toBeNull()
      service.save({ id: 'test', name: 'Test', transport: 'stdio', command: 'unused', enabled: true, roots: [root], scope: 'projects' })
      expect(service.attachment(sibling)).toBeNull()
      const spec = service.attachment(root)!
      expect(spec.args).toEqual([path.join(dir, 'cloud-bridge.mjs')])
      service.remove('test')
      const requestId = 'a'.repeat(32)
      fs.writeFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, requestId + '.request'), JSON.stringify({ method: 'call', connection: 'test', tool: 'delete' }))
      await new Promise(resolve => setTimeout(resolve, 300))
      const refused = JSON.parse(fs.readFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, requestId + '.answer'), 'utf8'))
      expect(refused.ok).toBe(false)
      // a missing connection says where the founder connects it
      expect(refused.error).toContain('is not connected for this company')
      expect(refused.error).toContain('principia://connect/mcp')
      expect(service.attachment(root)).toBeNull()
    } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('principia_call_tool on a tool the company has not connected returns its principia://connect link', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-notgranted-'))
    const key = crypto.randomBytes(32)
    const cipher = { available: () => true, encrypt: (s: string) => { const nonce = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, c.update(s), c.final(), c.getAuthTag()]) }, decrypt: (b: Buffer) => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12,-16)), c.final()]).toString() } }
    const service = new GatewayService({ userData: dir, mainDir: dir, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({}) })
    try {
      service.save({ id: 'own', name: 'Own', transport: 'stdio', command: 'unused', enabled: true, roots: [], scope: 'global', companyIds: ['co_a'] })
      // another company's Notion: never named, never granted
      service.save({ id: 'notion-b', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', authentication: 'none', enabled: true, roots: [], scope: 'global', companyIds: ['co_b'] })
      const spec = service.attachment(dir, 'co_a')!
      const ask = async (connection: string): Promise<{ ok: boolean; error: string }> => {
        const id = crypto.randomBytes(16).toString('hex')
        fs.writeFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, id + '.request'), JSON.stringify({ method: 'call', connection, tool: 'x', arguments: {} }))
        for (let i = 0; i < 40; i++) { try { return JSON.parse(fs.readFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, id + '.answer'), 'utf8')) } catch { await new Promise(r => setTimeout(r, 50)) } }
        throw new Error('no answer')
      }
      expect((await ask('stripe')).error).toContain('principia://connect/stripe?company=co_a')
      const other = await ask('notion-b')
      expect(other.error).toContain('principia://connect/mcp?company=co_a')
      expect(other.error).not.toContain('co_b')
    } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('AUTOPILOT.md §6: a run’s call is checked before it is made, and a refusal goes back to the agent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-guard-'))
    const key = crypto.randomBytes(32)
    const cipher = { available: () => true, encrypt: (s: string) => { const nonce = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, c.update(s), c.final(), c.getAuthTag()]) }, decrypt: (b: Buffer) => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12,-16)), c.final()]).toString() } }
    const seen: unknown[] = []
    const service = new GatewayService({ userData: dir, mainDir: dir, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({}), guard: (c) => (seen.push(c), c.tool === 'pause_ad' ? 'Level 1 only watches and reports' : null) })
    try {
      service.save({ id: 'meta', name: 'Meta', transport: 'stdio', command: 'unused-command-xyz', enabled: true, roots: [], scope: 'global' })
      const spec = service.attachment(dir, 'co_a', 'run_1')!
      const id = crypto.randomBytes(16).toString('hex')
      fs.writeFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, id + '.request'), JSON.stringify({ method: 'call', connection: 'meta', tool: 'pause_ad', arguments: { ad_id: '1' } }))
      let answer: { ok: boolean; error: string } | null = null
      for (let i = 0; i < 40 && !answer; i++) { try { answer = JSON.parse(fs.readFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, id + '.answer'), 'utf8')) } catch { await new Promise(r => setTimeout(r, 50)) } }
      expect(answer).toEqual({ ok: false, error: 'Refused by Principia: Level 1 only watches and reports.' })
      expect(seen).toEqual([{ runId: 'run_1', companyId: 'co_a', connection: 'meta', tool: 'pause_ad', args: { ad_id: '1' }, readOnly: false, connector: null }])
      // a session's grant (no run) is asked too: main lets it through unless a money playbook runs now
      const free = service.attachment(dir, 'co_a')!
      const id2 = crypto.randomBytes(16).toString('hex')
      fs.writeFileSync(path.join(free.env.PRINCIPIA_GATEWAY_DIR, id2 + '.request'), JSON.stringify({ method: 'call', connection: 'meta', tool: 'pause_ad', arguments: {} }))
      for (let i = 0; i < 40 && seen.length < 2; i++) await new Promise(r => setTimeout(r, 50))
      expect(seen[1]).toMatchObject({ runId: null, companyId: 'co_a', tool: 'pause_ad' })
    } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('adds the default Vibiz connection once, keeps a removal, and grants it only after sign-in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-defaults-'))
    const key = crypto.randomBytes(32)
    const cipher = { available: () => true, encrypt: (s: string) => { const nonce = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, c.update(s), c.final(), c.getAuthTag()]) }, decrypt: (b: Buffer) => { const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); c.setAuthTag(b.subarray(-16)); return Buffer.concat([c.update(b.subarray(12,-16)), c.final()]).toString() } }
    const make = (seedDefaults = true): GatewayService => new GatewayService({ userData: dir, mainDir: dir, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({}), seedDefaults })
    const services: GatewayService[] = []
    try {
      const plain = make(false); services.push(plain)
      expect(plain.list()).toEqual([])
      const first = make(); services.push(first)
      expect(first.list()).toEqual([expect.objectContaining({ id: 'vibiz', name: 'Vibiz', url: 'https://www.vibiz.ai/api/mcp', authentication: 'oauth', scope: 'global', enabled: true, hasCredentials: false, authStatus: 'disconnected' })])
      expect(first.attachment(dir)).toBeNull()
      const again = make(); services.push(again)
      expect(again.list().filter(c => c.id === 'vibiz')).toHaveLength(1)
      again.remove('vibiz')
      const afterRemove = make(); services.push(afterRemove)
      expect(afterRemove.list()).toEqual([])
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-defaults-own-'))
      try {
        fs.writeFileSync(path.join(other, 'mcp-connections.json'), JSON.stringify([{ config: { id: 'mine', name: 'My Vibiz', transport: 'http', url: 'https://vibiz.ai/api/mcp/', enabled: true, roots: [], authentication: 'oauth', hasCredentials: false }, cipher: cipher.encrypt('{}').toString('base64') }]))
        const own = new GatewayService({ userData: other, mainDir: other, cipher, vault: { addRedactions() {} } as unknown as Vault, baseEnv: () => ({}), seedDefaults: true }); services.push(own)
        expect(own.list().map(c => c.id)).toEqual(['mine'])
      } finally { fs.rmSync(other, { recursive: true, force: true }) }
    } finally { for (const s of services) s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('initializes and invokes a real stdio MCP server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-upstream-'))
    const script = path.join(dir, 'server.cjs')
    fs.writeFileSync(script, `const r=require('node:readline').createInterface({input:process.stdin}); r.on('line', l=>{ const m=JSON.parse(l); if(!('id' in m))return; let result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.COMPANY_KEY+':'+m.params.arguments.text}]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n') })`)
    const client = new Upstream({ id: 'test', name: 'Test', transport: 'stdio', command: process.execPath, args: [script], enabled: true, roots: [dir], hasCredentials: true }, { COMPANY_KEY: 'available-only-upstream' }, {})
    try {
      expect((await client.request('tools/list')).tools[0].name).toBe('echo')
      expect((await client.request('tools/call', { name: 'echo', arguments: { text: 'hello' } })).content[0].text).toBe('available-only-upstream:hello')
    } finally { client.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('uses Streamable HTTP session ids and bearer headers with SSE tool responses', async () => {
    const calls: { method: string; authorization?: string; session?: string }[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const m = JSON.parse(String(options!.body)); const headers = options!.headers as Record<string, string>
      calls.push({ method: m.method, authorization: headers.Authorization, session: headers['Mcp-Session-Id'] })
      if (m.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }), { headers: { 'Mcp-Session-Id': 'test-session', 'Content-Type': 'application/json' } })
      if (m.method.startsWith('notifications/')) return new Response(null, { status: 202 })
      return new Response('data: ' + JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'remote' }] } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const client = new Upstream({ id: 'http', name: 'HTTP', transport: 'http', url: 'https://example.com/mcp', enabled: true, roots: [], hasCredentials: true }, { Authorization: 'Bearer test-secret' }, {})
    try { expect((await client.request('tools/list')).tools[0].name).toBe('remote'); expect(calls.every(c => c.authorization === 'Bearer test-secret')).toBe(true); expect(calls.find(c => c.method === 'tools/list')?.session).toBe('test-session') } finally { client.close(); fetchMock.mockRestore() }
  })
  it('merges Claude MCP configuration and preserves native permission checks', () => {
    const spec = { name: 'principia' as const, command: 'electron', args: ['bridge.js'], env: { TOKEN: 'opaque-grant' } }
    const previous = { args: ['--mcp-config', '/tmp/original.json', '--allowedTools', 'mcp__hive__read'], env: {}, files: [{ path: '/tmp/original.json', content: JSON.stringify({ mcpServers: { hive: { command: 'existing' } } }) }] }
    const result = attachGateway('claude', spec, previous, '/tmp/grant')!
    expect(JSON.parse(result.files[0].content).mcpServers).toHaveProperty('hive')
    expect(JSON.parse(result.files[0].content).mcpServers).toHaveProperty('principia')
    expect(result.args).toEqual(previous.args)
    expect(attachGateway('codex', spec, null, '/tmp')!.args.join(' ')).not.toContain('approval_mode')
  })
  it('refuses plaintext remote HTTP and unavailable encryption', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-test-'))
    const service = new GatewayService({ userData: dir, mainDir: dir, cipher: { available: () => true, encrypt: s => Buffer.from(s), decrypt: b => b.toString() }, vault: {} as Vault, baseEnv: () => ({}) })
    try { expect(() => service.save({ id: 'x', name: 'X', enabled: true, roots: [], transport: 'http', url: 'http://example.com/mcp' })).toThrow('HTTPS') } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
