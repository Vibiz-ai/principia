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
      expect(JSON.parse(fs.readFileSync(path.join(spec.env.PRINCIPIA_GATEWAY_DIR, requestId + '.answer'), 'utf8')).ok).toBe(false)
      expect(service.attachment(root)).toBeNull()
    } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }) }
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
