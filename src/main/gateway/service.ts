import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Cipher, Vault } from '../vault'
import type { GatewayConnection, GatewayConnectionInput } from '../../shared/gateway'
import type { McpServerSpec } from '../../shared/engine'
import { Upstream } from './client'
import { readPrivateJson, writePrivateJson } from './files'

type Saved = { config: GatewayConnection; cipher: string }
export class GatewayService {
  private saved: Saved[] = []
  private grants = new Map<string, { dir: string; cwd: string; expires: number; busy: Set<string> }>()
  private clients = new Map<string, Upstream>()
  private timer: NodeJS.Timeout
  private file: string
  constructor(private opts: { userData: string; mainDir: string; bridgePath?: string; cipher: Cipher; vault: Pick<Vault, 'addRedactions'>; baseEnv(): Record<string, string> }) {
    this.file = path.join(opts.userData, 'mcp-connections.json')
    try { this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!Array.isArray(this.saved)) this.saved = [] } catch {}
    this.timer = setInterval(() => this.poll(), 100); this.timer.unref()
  }
  list(): GatewayConnection[] { return this.saved.map(s => ({ ...s.config })) }
  save(input: GatewayConnectionInput): GatewayConnection {
    if (!this.opts.cipher.available()) throw new Error('Credential encryption is unavailable')
    if (input.transport === 'http') { const u = new URL(input.url!); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Remote MCP servers require HTTPS'); if (u.username || u.password) throw new Error('Put authentication in headers, not the URL') }
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('A command is required')
    const old = this.saved.find(s => s.config.id === input.id)
    const { credentials, ...rest } = input
    const cipher = credentials === undefined && old ? old.cipher : this.opts.cipher.encrypt(JSON.stringify(credentials ?? {})).toString('base64')
    const config = { ...rest, roots: rest.roots.map(r => fs.realpathSync(r)), hasCredentials: credentials === undefined ? old?.config.hasCredentials ?? false : Object.keys(credentials).length > 0 }
    this.saved = [...this.saved.filter(s => s.config.id !== input.id), { config, cipher }]; this.persist(); this.reset(input.id)
    return config
  }
  remove(id: string): void { this.saved = this.saved.filter(s => s.config.id !== id); this.persist(); this.reset(id) }
  private persist(): void { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); writePrivateJson(this.file, this.saved) }
  private reset(id: string): void { this.clients.get(id)?.close(); this.clients.delete(id); /* Keep previous credential redactions for historical logs until app exit. */ }
  private allowed(cwd: string): Saved[] { let real: string; try { real = fs.realpathSync(cwd) } catch { return [] }; return this.saved.filter(s => s.config.enabled && s.config.roots.some(root => real === root || real.startsWith(root + path.sep))) }
  attachment(cwd: string): McpServerSpec | null {
    if (!this.allowed(cwd).length) return null
    const id = crypto.randomBytes(24).toString('hex'); const dir = path.join(this.opts.userData, 'scratch', 'mcp-gateway', id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.grants.set(id, { dir, cwd, expires: Date.now() + 24 * 3600_000, busy: new Set() })
    return { name: 'principia', command: process.execPath, args: [this.opts.bridgePath ?? path.join(this.opts.mainDir, 'mcp-gateway.js')], env: { ELECTRON_RUN_AS_NODE: '1', PRINCIPIA_GATEWAY_DIR: dir } }
  }
  async test(id: string): Promise<unknown> { const saved = this.saved.find(s => s.config.id === id); if (!saved) throw new Error('Connection not found'); return this.tools(saved) }
  private async tools(s: Saved): Promise<{ tools: unknown[] }> {
    const tools: unknown[] = []; let cursor: string | undefined
    for (let page = 0; page < 100; page++) { const result = await this.client(s).request('tools/list', cursor ? { cursor } : {}); if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tools list'); tools.push(...result.tools); if (!result.nextCursor) return { tools }; cursor = result.nextCursor }
    throw new Error('MCP tool pagination exceeded')
  }
  private client(s: Saved): Upstream { let c = this.clients.get(s.config.id); if (!c) { const credentials = JSON.parse(this.opts.cipher.decrypt(Buffer.from(s.cipher, 'base64'))); for (const [k,v] of Object.entries(credentials)) this.opts.vault.addRedactions('MCP_' + s.config.id + '_' + k + '_' + crypto.randomBytes(8).toString('hex'), String(v)); c = new Upstream(s.config, credentials, this.opts.baseEnv()); this.clients.set(s.config.id, c) } return c }
  private poll(): void {
    for (const [id, grant] of this.grants) {
      if (Date.now() > grant.expires || fs.existsSync(path.join(grant.dir, 'closed'))) { this.grants.delete(id); fs.rmSync(grant.dir, { recursive: true, force: true }); continue }
      let files: string[]; try { files = fs.readdirSync(grant.dir) } catch { continue }
      for (const file of files) if (/^[a-f0-9]{32}\.request$/.test(file) && !grant.busy.has(file)) {
        grant.busy.add(file)
        void (async () => { let result: unknown; try { const p = path.join(grant.dir, file); const req = readPrivateJson(p, 262144) as Record<string, unknown>; const allowed = this.allowed(grant.cwd); if (req.method === 'list') { result = []; for (const s of allowed) { try { const tools = await this.tools(s); (result as unknown[]).push({ id: s.config.id, name: s.config.name, ...tools }) } catch { this.reset(s.config.id); (result as unknown[]).push({ id: s.config.id, error: 'Connection unavailable; check Principia settings' }) } } } else if (req.method === 'call') { const s = allowed.find(s => s.config.id === req.connection); if (!s || typeof req.tool !== 'string') throw new Error('Connection not granted'); result = await this.client(s).request('tools/call', { name: req.tool, arguments: req.arguments ?? {} }) } else throw new Error('Unknown method'); result = { ok: true, result } } catch { result = { ok: false, error: 'MCP request failed; check connection authentication and project access in Principia settings' } } try { const answer = path.join(grant.dir, file.replace('.request', '.answer')); writePrivateJson(answer, result); fs.unlinkSync(path.join(grant.dir, file)) } catch {} finally { grant.busy.delete(file) } })()
      }
    }
  }
  close(): void { clearInterval(this.timer); for (const c of this.clients.values()) c.close(); for (const g of this.grants.values()) fs.rmSync(g.dir, { recursive: true, force: true }); this.grants.clear() }
}
