import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Cipher, Vault } from '../vault'
import { VIBIZ_CONNECTION_ID, VIBIZ_DEFAULT_CONNECTION, type GatewayConnection, type GatewayConnectionInput } from '../../shared/gateway'
import type { McpServerSpec } from '../../shared/engine'
import { OAuthConnection, type OAuthSaved } from './oauth'
import { Upstream } from './client'
import { readPrivateJson, writePrivateJson } from './files'

type Saved = { config: GatewayConnection; cipher: string; oauthCipher?: string }
/**
 * COMPANY.md §6: the company module, as the gateway needs it. `forCwd` resolves the company of a folder (scope.ts
 * companyForCwd); `enforced` is experimental.companies (off: a connection outside its companies is still granted, with
 * a warning).
 */
export interface GatewayCompanies { forCwd(cwd: string): string; enforced(): boolean; warn?(message: string, meta: Record<string, unknown>): void }
export class GatewayService {
  private saved: Saved[] = []
  private grants = new Map<string, { dir: string; cwd: string; companyId: string | null; expires: number; busy: Set<string> }>()
  private clients = new Map<string, Upstream>()
  private timer: NodeJS.Timeout
  private file: string
  private oauth = new Map<string, OAuthConnection>()
  private oauthRedacted = new Set<string>()
  private authState = new Map<string, { authStatus: import('../../shared/gateway').GatewayAuthStatus; authError?: string }>()
  /** `fileOwner` (Principia Cloud, CLOUD.md §7.8): grant folders and answers belong to the agent user, whose bridge reads them; the saved connections stay the service's own. */
  constructor(private opts: { userData: string; mainDir: string; bridgePath?: string; cipher: Cipher; vault: Pick<Vault, 'addRedactions'>; baseEnv(): Record<string, string>; companies?: GatewayCompanies; fileOwner?: { uid: number; gid: number } | null; /** Add the default connections (Vibiz) once per install; the desktop app only. */ seedDefaults?: boolean }) {
    this.file = path.join(opts.userData, 'mcp-connections.json')
    try { this.saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!Array.isArray(this.saved)) this.saved = [] } catch {}
    if (opts.seedDefaults) this.seedDefaults()
    this.timer = setInterval(() => this.poll(), 100); this.timer.unref()
  }
  /**
   * Vibiz is a default company connection: added once (enabled for every project and company, not signed in), recorded
   * in mcp-defaults.json so a user who removes it does not get it back. Skipped if the endpoint is already saved.
   */
  private seedDefaults(): void {
    const marker = path.join(this.opts.userData, 'mcp-defaults.json')
    let seeded: string[] = []
    try { const value = JSON.parse(fs.readFileSync(marker, 'utf8')) as { seeded?: unknown }; if (Array.isArray(value.seeded)) seeded = value.seeded.filter((id): id is string => typeof id === 'string') } catch {}
    if (seeded.includes(VIBIZ_CONNECTION_ID)) return
    try {
      if (!this.opts.cipher.available()) return
      const endpoint = (url?: string): string => { try { const u = new URL(url ?? ''); return u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') } catch { return '' } }
      const present = this.saved.some(s => s.config.id === VIBIZ_CONNECTION_ID || (s.config.transport === 'http' && endpoint(s.config.url) === endpoint(VIBIZ_DEFAULT_CONNECTION.url)))
      if (!present) { this.saved = [{ config: { ...VIBIZ_DEFAULT_CONNECTION, roots: [], hasCredentials: false }, cipher: this.opts.cipher.encrypt('{}').toString('base64') }, ...this.saved]; this.persist() }
      writePrivateJson(marker, { seeded: [...seeded, VIBIZ_CONNECTION_ID] })
    } catch {}
  }
  list(): GatewayConnection[] { return this.saved.map(s => {
    if (s.config.authentication !== 'oauth') return { ...s.config }
    let connected = false
    try { connected = !!this.readOAuth(s)?.tokens?.access_token } catch {}
    return { ...s.config, authStatus: connected ? 'connected' as const : 'disconnected' as const, ...(this.authState.get(s.config.id) ?? {}) }
  }) }
  private redactOAuth(id: string, value: OAuthSaved): void {
    for (const [key, secret] of Object.entries({ access_token: value.tokens?.access_token, refresh_token: value.tokens?.refresh_token, client_secret: value.client?.client_secret })) if (typeof secret === 'string' && !this.oauthRedacted.has(secret)) { this.oauthRedacted.add(secret); this.opts.vault.addRedactions('MCP_OAUTH_' + id + '_' + key + '_' + crypto.randomBytes(8).toString('hex'), secret) }
  }
  private readOAuth(s: Saved): OAuthSaved | undefined { if (!s.oauthCipher) return undefined; const value = JSON.parse(this.opts.cipher.decrypt(Buffer.from(s.oauthCipher, 'base64'))) as OAuthSaved; this.redactOAuth(s.config.id, value); return value }
  private oauthConnection(id: string): OAuthConnection {
    let oauth = this.oauth.get(id); if (oauth) return oauth
    const saved = this.saved.find(s => s.config.id === id)
    if (!saved || saved.config.transport !== 'http' || saved.config.authentication !== 'oauth') throw new Error('This HTTP connection does not use OAuth')
    oauth = new OAuthConnection({ serverUrl: saved.config.url!, load: () => { const s = this.saved.find(s => s.config.id === id); return s ? this.readOAuth(s) : undefined }, save: value => {
      const s = this.saved.find(s => s.config.id === id); if (!s) return
      if (value) { if (!this.opts.cipher.available()) throw new Error('Credential encryption unavailable'); this.redactOAuth(id, value); s.oauthCipher = this.opts.cipher.encrypt(JSON.stringify(value)).toString('base64') } else delete s.oauthCipher
      this.persist()
    }, onStatus: (authStatus, authError) => this.authState.set(id, { authStatus, ...(authError ? { authError } : {}) }) })
    this.oauth.set(id, oauth); return oauth
  }
  async connect(id: string, openBrowser: (url: string) => Promise<void>): Promise<GatewayConnection> { if (!this.opts.cipher.available()) throw new Error('Credential encryption unavailable'); this.reset(id); await this.oauthConnection(id).connect(openBrowser); return this.list().find(c => c.id === id)! }
  disconnect(id: string): GatewayConnection { this.oauthConnection(id).disconnect(); this.reset(id); return this.list().find(c => c.id === id)! }

  save(input: GatewayConnectionInput): GatewayConnection {
    if (!this.opts.cipher.available()) throw new Error('Credential encryption is unavailable')
    if (input.transport === 'http') { const u = new URL(input.url!); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Remote MCP servers require HTTPS'); if (u.username || u.password) throw new Error('Put authentication in headers, not the URL') }
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('A command is required')
    const old = this.saved.find(s => s.config.id === input.id)
    const { credentials, ...rest } = input
    if (rest.authentication === 'oauth' && rest.transport !== 'http') throw new Error('OAuth requires an HTTP server')
    const keepOAuth = old?.config.url === rest.url && old?.config.authentication === rest.authentication
    if (!keepOAuth) { this.oauth.get(input.id)?.close(); this.oauth.delete(input.id); this.authState.delete(input.id) }
    const cipher = credentials === undefined && old ? old.cipher : this.opts.cipher.encrypt(JSON.stringify(credentials ?? {})).toString('base64')
    const companyIds = rest.companyIds ? [...new Set(rest.companyIds)] : undefined
    const config = { ...rest, roots: rest.roots.map(r => fs.realpathSync(r)), ...(companyIds ? { companyIds } : {}), hasCredentials: credentials === undefined ? old?.config.hasCredentials ?? false : Object.keys(credentials).length > 0 }
    this.saved = [...this.saved.filter(s => s.config.id !== input.id), { config, cipher, ...(keepOAuth && old?.oauthCipher ? { oauthCipher: old.oauthCipher } : {}) }]; this.persist(); this.reset(input.id)
    return config
  }
  remove(id: string): void { this.oauth.get(id)?.close(); this.oauth.delete(id); this.authState.delete(id); this.saved = this.saved.filter(s => s.config.id !== id); this.persist(); this.reset(id) }
  private persist(): void { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); writePrivateJson(this.file, this.saved) }
  private reset(id: string): void { this.clients.get(id)?.close(); this.clients.delete(id); /* Keep previous credential redactions for historical logs until app exit. */ }
  private allowed(cwd: string, companyId: string | null = null): Saved[] {
    let real: string; try { real = fs.realpathSync(cwd) } catch { return [] }
    // an OAuth connection nobody signed in to has no tools to offer (e.g. the default Vibiz): not granted until sign-in
    return this.saved.filter(s => s.config.enabled && (s.config.authentication !== 'oauth' || !!s.oauthCipher) && (s.config.scope === 'global' || s.config.roots.some(root => real === root || real.startsWith(root + path.sep))) && this.companyAllowed(s, real, companyId))
  }
  /** COMPANY.md §6: a connection limited to some companies reaches only their spawns (the spawn's company, else its folder's). */
  private companyAllowed(s: Saved, cwd: string, companyId: string | null): boolean {
    const ids = s.config.companyIds
    const co = this.opts.companies
    if (!ids || !co) return true
    let company: string | null = companyId
    try { company ??= co.forCwd(cwd) } catch { company = null }
    if (company && ids.includes(company)) return true
    if (co.enforced()) return false
    co.warn?.('gateway: company guard (not enforced)', { connection: s.config.id, companyId: company })
    return true
  }
  /** `companyId`: the spawn's company (session or run stamp); absent = the company of `cwd`. */
  attachment(cwd: string, companyId?: string | null): McpServerSpec | null {
    if (!this.allowed(cwd, companyId ?? null).length) return null
    const id = crypto.randomBytes(24).toString('hex'); const dir = path.join(this.opts.userData, 'scratch', 'mcp-gateway', id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const owner = this.opts.fileOwner
    if (owner) { for (const p of [this.opts.userData, path.join(this.opts.userData, 'scratch'), path.dirname(dir)]) fs.chmodSync(p, 0o711); fs.chownSync(dir, owner.uid, owner.gid) }
    this.grants.set(id, { dir, cwd, companyId: companyId ?? null, expires: Date.now() + 24 * 3600_000, busy: new Set() })
    return { name: 'principia', command: process.execPath, args: [this.opts.bridgePath ?? path.join(this.opts.mainDir, 'mcp-gateway.js')], env: { ELECTRON_RUN_AS_NODE: '1', PRINCIPIA_GATEWAY_DIR: dir } }
  }
  async test(id: string): Promise<unknown> { const saved = this.saved.find(s => s.config.id === id); if (!saved) throw new Error('Connection not found'); return this.tools(saved) }
  /** CLOUD.md §7.5 (main only, never over IPC): a connection's stored env or headers, for "Run in the cloud…" when the user ticked it. OAuth tokens are never exported. */
  exportCredentials(id: string): Record<string, string> { const saved = this.saved.find(s => s.config.id === id); if (!saved) throw new Error('Connection not found'); if (!this.opts.cipher.available()) throw new Error('Credential encryption unavailable'); const value = JSON.parse(this.opts.cipher.decrypt(Buffer.from(saved.cipher, 'base64'))) as Record<string, unknown>; return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) }
  private async tools(s: Saved): Promise<{ tools: unknown[] }> {
    const tools: unknown[] = []; let cursor: string | undefined
    for (let page = 0; page < 100; page++) { const result = await this.client(s).request('tools/list', cursor ? { cursor } : {}); if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tools list'); tools.push(...result.tools); if (!result.nextCursor) return { tools }; cursor = result.nextCursor }
    throw new Error('MCP tool pagination exceeded')
  }
  private client(s: Saved): Upstream { let c = this.clients.get(s.config.id); if (!c) { const credentials = JSON.parse(this.opts.cipher.decrypt(Buffer.from(s.cipher, 'base64'))); for (const [k,v] of Object.entries(credentials)) this.opts.vault.addRedactions('MCP_' + s.config.id + '_' + k + '_' + crypto.randomBytes(8).toString('hex'), String(v)); const oauth = s.config.authentication === 'oauth' ? this.oauthConnection(s.config.id) : undefined; c = new Upstream(s.config, credentials, this.opts.baseEnv(), oauth ? async force => { if (this.saved.find(current => current.config.id === s.config.id) !== s) throw new Error('Connection changed'); const headers = await oauth.headers(force); if (this.saved.find(current => current.config.id === s.config.id) !== s) throw new Error('Connection changed'); return headers } : undefined); this.clients.set(s.config.id, c) } return c }
  private poll(): void {
    for (const [id, grant] of this.grants) {
      if (Date.now() > grant.expires || fs.existsSync(path.join(grant.dir, 'closed'))) { this.grants.delete(id); fs.rmSync(grant.dir, { recursive: true, force: true }); continue }
      let files: string[]; try { files = fs.readdirSync(grant.dir) } catch { continue }
      for (const file of files) if (/^[a-f0-9]{32}\.request$/.test(file) && !grant.busy.has(file)) {
        grant.busy.add(file)
        void (async () => { let result: unknown; try { const p = path.join(grant.dir, file); const req = readPrivateJson(p, 262144) as Record<string, unknown>; const allowed = this.allowed(grant.cwd, grant.companyId); if (req.method === 'list') { result = []; for (const s of allowed) { try { const tools = await this.tools(s); (result as unknown[]).push({ id: s.config.id, name: s.config.name, ...tools }) } catch { this.reset(s.config.id); (result as unknown[]).push({ id: s.config.id, error: 'Connection unavailable; check Principia settings' }) } } } else if (req.method === 'call') { const s = allowed.find(s => s.config.id === req.connection); if (!s || typeof req.tool !== 'string') throw new Error('Connection not granted'); result = await this.client(s).request('tools/call', { name: req.tool, arguments: req.arguments ?? {} }) } else throw new Error('Unknown method'); result = { ok: true, result } } catch { result = { ok: false, error: 'MCP request failed; check connection authentication and project access in Principia settings' } } try { const answer = path.join(grant.dir, file.replace('.request', '.answer')); writePrivateJson(answer, result, this.opts.fileOwner); fs.unlinkSync(path.join(grant.dir, file)) } catch {} finally { grant.busy.delete(file) } })()
      }
    }
  }
  close(): void { clearInterval(this.timer); for (const oauth of this.oauth.values()) oauth.close(); this.oauth.clear(); for (const c of this.clients.values()) c.close(); for (const g of this.grants.values()) fs.rmSync(g.dir, { recursive: true, force: true }); this.grants.clear() }
}
