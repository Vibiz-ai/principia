import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Cipher, Vault } from '../vault'
import { VIBIZ_CONNECTION_ID, VIBIZ_DEFAULT_CONNECTION, type GatewayConnection, type GatewayConnectionInput } from '../../shared/gateway'
import type { McpServerSpec } from '../../shared/engine'
import { OAuthConnection, type OAuthSaved } from './oauth'
import { Upstream } from './client'
import { readPrivateJson, writePrivateJson } from './files'
import { serviceForUrl } from '../../shared/services'
import type { VirtualConnection } from '../connections/resolver'
import { connectLink, connectToolId } from '../../shared/deepLink'
import { adsConnectorOf, type AdsConnector } from '../../shared/autopilotPlaybooks'

/** A call on a connection this spawn was not granted: its message (with the connect link) goes back to the agent. */
class NotGranted extends Error {}
/** AUTOPILOT.md §6: a call the run's autopilot level refuses, before it is made; its message goes back to the agent. */
class Refused extends Error {}
/** The check main runs on a call before it is made (null = allowed). Never throws past here: a throw refuses. */
export type GatewayGuard = (c: { runId: string | null; companyId: string | null; connection: string; tool: string; args: unknown; readOnly?: boolean; connector?: AdsConnector | null }) => string | null

type Saved = { config: GatewayConnection; cipher: string; oauthCipher?: string }
/** A connection a spawn may use: a saved one, or a key-backed one built for its company (CONNECTIONS.md §3.3). */
type Granted = { config: GatewayConnection; saved?: Saved; virtual?: VirtualConnection; companyId?: string | null }
/**
 * COMPANY.md §6: the company module, as the gateway needs it. `forCwd` resolves the company of a folder (scope.ts
 * companyForCwd); `enforced` is experimental.companies (off: a connection outside its companies is still granted, with
 * a warning).
 */
export interface GatewayCompanies { forCwd(cwd: string): string; enforced(): boolean; warn?(message: string, meta: Record<string, unknown>): void }
export class GatewayService {
  private saved: Saved[] = []
  private grants = new Map<string, { dir: string; cwd: string; companyId: string | null; runId: string | null; secretNames: string[] | null; expires: number; busy: Set<string> }>()
  private clients = new Map<string, Upstream>()
  /** AUTOPILOT.md §6: tools a connection's server marks read-only (MCP `annotations.readOnlyHint`), from its last tools/list */
  private readOnly = new Map<string, Set<string>>()
  private timer: NodeJS.Timeout
  private file: string
  private oauth = new Map<string, OAuthConnection>()
  private oauthRedacted = new Set<string>()
  private authState = new Map<string, { authStatus: import('../../shared/gateway').GatewayAuthStatus; authError?: string }>()
  /** `fileOwner` (Principia Cloud, CLOUD.md §7.8): grant folders and answers belong to the agent user, whose bridge reads them; the saved connections stay the service's own. */
  constructor(private opts: { userData: string; mainDir: string; bridgePath?: string; cipher: Cipher; vault: Pick<Vault, 'addRedactions'>; baseEnv(): Record<string, string>; companies?: GatewayCompanies; fileOwner?: { uid: number; gid: number } | null; /** Add the default connections (Vibiz) once per install; the desktop app only. */ seedDefaults?: boolean; /** AUTOPILOT.md §6: checks each call of a run before it is made */ guard?: GatewayGuard
    /** CONNECTIONS.md §3.3: key-backed connections for one company (the resolver; built at call time, never stored) */
    virtuals?: (companyId: string | null) => VirtualConnection[]
    /** a vendor turned down the key a key-backed connection sends (HTTP 401): the service shows Needs attention */
    onVirtualRejected?: (companyId: string, serviceId: string) => void
    /** CONNECTIONS.md §3.6: a company reuses this connection's service from a company it belongs to ("Also use in…") */
    reuses?: (connectionId: string, companyId: string) => boolean
    /** a connection was saved, removed, signed in or out (connections:changed) */
    onChange?: () => void }) {
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
    }, onStatus: (authStatus, authError) => { this.authState.set(id, { authStatus, ...(authError ? { authError } : {}) }); this.changed() } })
    this.oauth.set(id, oauth); return oauth
  }
  async connect(id: string, openBrowser: (url: string) => Promise<void>): Promise<GatewayConnection> { if (!this.opts.cipher.available()) throw new Error('Credential encryption unavailable'); this.reset(id); await this.oauthConnection(id).connect(openBrowser); return this.list().find(c => c.id === id)! }
  disconnect(id: string): GatewayConnection { this.oauthConnection(id).disconnect(); this.reset(id); this.changed(); return this.list().find(c => c.id === id)! }
  private changed(): void { try { this.opts.onChange?.() } catch { /* a listener never fails the gateway */ } }

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
    this.saved = [...this.saved.filter(s => s.config.id !== input.id), { config, cipher, ...(keepOAuth && old?.oauthCipher ? { oauthCipher: old.oauthCipher } : {}) }]; this.persist(); this.reset(input.id); this.changed()
    return config
  }
  remove(id: string): void { this.oauth.get(id)?.close(); this.oauth.delete(id); this.authState.delete(id); this.saved = this.saved.filter(s => s.config.id !== id); this.persist(); this.reset(id); this.changed() }
  private persist(): void { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); writePrivateJson(this.file, this.saved) }
  private reset(id: string): void { this.clients.get(id)?.close(); this.clients.delete(id); this.readOnly.delete(id); /* Keep previous credential redactions for historical logs until app exit. */ }
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
    if (company && this.opts.reuses?.(s.config.id, company)) return true
    if (co.enforced()) return false
    co.warn?.('gateway: company guard (not enforced)', { connection: s.config.id, companyId: company })
    return true
  }
  /**
   * Everything a spawn may use: its saved connections, plus a key-backed connection for each service whose saved key the
   * vendor's MCP server takes as a bearer, when no saved connection here already serves that service.
   */
  private granted(cwd: string, companyId: string | null, secretNames: readonly string[] | null = null): Granted[] {
    const out: Granted[] = this.allowed(cwd, companyId).map(s => ({ config: s.config, saved: s }))
    // SEC-4: a key-backed connection is that key's power: only a spawn whose profile may read the key gets it
    if (!this.opts.virtuals || !secretNames?.length) return out
    let company = companyId
    if (!company) { try { company = this.opts.companies?.forCwd(fs.realpathSync(cwd)) ?? null } catch { company = null } }
    if (!company) return out
    let virtuals: VirtualConnection[] = []
    try { virtuals = this.opts.virtuals(company) } catch { virtuals = [] }
    const served = new Set(out.map(g => (g.config.url && serviceForUrl(g.config.url)?.id) || ''))
    const all = secretNames.includes('*')
    for (const v of virtuals) {
      if (served.has(v.serviceId)) continue
      if (!all && !v.keyNames.some(n => secretNames.includes(n))) continue
      out.push({ companyId: company, virtual: v, config: { id: v.id, name: v.name, transport: 'http', url: v.url, enabled: true, roots: [], scope: 'global', companyIds: [company], authentication: 'none', hasCredentials: true } })
    }
    return out
  }
  /**
   * `companyId`: the spawn's company (session or run stamp); absent = the company of `cwd`. `secretNames`: the keys the
   * spawn's profile may read (['*'] = all); key-backed connections are granted only for those (absent = none).
   */
  attachment(cwd: string, companyId?: string | null, runId?: string | null, secretNames?: readonly string[] | null): McpServerSpec | null {
    const granted = this.granted(cwd, companyId ?? null, secretNames ?? null)
    if (!granted.length) return null
    const id = crypto.randomBytes(24).toString('hex'); const dir = path.join(this.opts.userData, 'scratch', 'mcp-gateway', id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const owner = this.opts.fileOwner
    if (owner) { for (const p of [this.opts.userData, path.join(this.opts.userData, 'scratch'), path.dirname(dir)]) fs.chmodSync(p, 0o711); fs.chownSync(dir, owner.uid, owner.gid) }
    this.grants.set(id, { dir, cwd, companyId: companyId ?? null, runId: runId ?? null, secretNames: secretNames ? [...secretNames] : null, expires: Date.now() + 24 * 3600_000, busy: new Set() })
    // QP-2: the services this spawn reaches through Principia; the founder's own MCP servers of the same name (their
    // Claude config's `posthog`) are kept out of it, so one company's question never reads another account
    const deny = [...new Set(granted.flatMap(g => { const svc = g.virtual?.serviceId ?? (g.config.url ? serviceForUrl(g.config.url)?.id : undefined); return svc ? [`mcp__${svc.replace(/[^a-z0-9_-]/gi, '_')}`] : [] }))]
    return { name: 'principia', command: process.execPath, args: [this.opts.bridgePath ?? path.join(this.opts.mainDir, 'mcp-gateway.js')], env: { ELECTRON_RUN_AS_NODE: '1', PRINCIPIA_GATEWAY_DIR: dir }, ...(deny.length ? { deny } : {}) }
  }
  /**
   * CONNECTIONS.md §4.3 (main only, never over IPC): Principia's own surfaces reading through a saved sign-in, like a
   * PostHog dashboard with no key. `toolNames` lists what the connection offers; `callTool` makes one call. Never used
   * for a spawn (those go through the grant and its guard).
   */
  async toolNames(id: string): Promise<string[]> { const saved = this.saved.find(s => s.config.id === id); if (!saved || !saved.config.enabled) throw new Error('Connection not found'); const r = await this.tools({ config: saved.config, saved }); return r.tools.flatMap(t => { const n = (t as { name?: unknown }).name; return typeof n === 'string' ? [n] : [] }) }
  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> { const saved = this.saved.find(s => s.config.id === id); if (!saved || !saved.config.enabled) throw new Error('Connection not found'); return this.client({ config: saved.config, saved }).request('tools/call', { name: tool, arguments: args }) }
  async test(id: string): Promise<unknown> { const saved = this.saved.find(s => s.config.id === id); if (!saved) throw new Error('Connection not found'); return this.tools({ config: saved.config, saved }) }
  /** CLOUD.md §7.5 (main only, never over IPC): a connection's stored env or headers, for "Run in the cloud…" when the user ticked it. OAuth tokens are never exported. */
  exportCredentials(id: string): Record<string, string> { const saved = this.saved.find(s => s.config.id === id); if (!saved) throw new Error('Connection not found'); if (!this.opts.cipher.available()) throw new Error('Credential encryption unavailable'); const value = JSON.parse(this.opts.cipher.decrypt(Buffer.from(saved.cipher, 'base64'))) as Record<string, unknown>; return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) }
  private async tools(s: Granted): Promise<{ tools: unknown[] }> {
    const tools: unknown[] = []; let cursor: string | undefined
    for (let page = 0; page < 100; page++) { const result = await this.client(s).request('tools/list', cursor ? { cursor } : {}); if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tools list'); tools.push(...result.tools); if (!result.nextCursor) { this.readOnly.set(s.config.id, new Set(tools.flatMap(t => { const x = t as { name?: unknown; annotations?: { readOnlyHint?: unknown } }; return typeof x?.name === 'string' && x.annotations?.readOnlyHint === true ? [x.name] : [] }))); return { tools } }; cursor = result.nextCursor }
    throw new Error('MCP tool pagination exceeded')
  }
  private client(g: Granted): Upstream { if (g.virtual) return this.virtualClient(g); const s = g.saved!; let c = this.clients.get(s.config.id); if (!c) { const credentials = JSON.parse(this.opts.cipher.decrypt(Buffer.from(s.cipher, 'base64'))); for (const [k,v] of Object.entries(credentials)) this.opts.vault.addRedactions('MCP_' + s.config.id + '_' + k + '_' + crypto.randomBytes(8).toString('hex'), String(v)); const oauth = s.config.authentication === 'oauth' ? this.oauthConnection(s.config.id) : undefined; c = new Upstream(s.config, credentials, this.opts.baseEnv(), oauth ? async force => { if (this.saved.find(current => current.config.id === s.config.id) !== s) throw new Error('Connection changed'); const headers = await oauth.headers(force); if (this.saved.find(current => current.config.id === s.config.id) !== s) throw new Error('Connection changed'); return headers } : undefined); this.clients.set(s.config.id, c) } return c }
  /** CONN-QA-01: the vendor answered 401 to a key-backed connection: the key is turned down (never its value). */
  private rejected(g: Granted, e: unknown): void {
    if (!g.virtual || !g.companyId || !/MCP HTTP 401\b/.test(String((e as Error)?.message ?? e))) return
    try { this.opts.onVirtualRejected?.(g.companyId, g.virtual.serviceId) } catch { /* never blocks the answer */ }
  }
  /** A key-backed connection's client: one per company and key (a new key gets a new client; the old one closes). */
  private virtualClient(g: Granted): Upstream {
    const v = g.virtual!; const prefix = `${v.id}@${g.companyId ?? ''}#`; const id = prefix + v.fingerprint
    let c = this.clients.get(id); if (c) return c
    for (const [k, old] of this.clients) if (k.startsWith(prefix)) { old.close(); this.clients.delete(k) }
    c = new Upstream(g.config, {}, this.opts.baseEnv(), async () => v.headers()); this.clients.set(id, c); return c
  }
  private poll(): void {
    for (const [id, grant] of this.grants) {
      if (Date.now() > grant.expires || fs.existsSync(path.join(grant.dir, 'closed'))) { this.grants.delete(id); fs.rmSync(grant.dir, { recursive: true, force: true }); continue }
      let files: string[]; try { files = fs.readdirSync(grant.dir) } catch { continue }
      for (const file of files) if (/^[a-f0-9]{32}\.request$/.test(file) && !grant.busy.has(file)) {
        grant.busy.add(file)
        void (async () => { let result: unknown; try { const p = path.join(grant.dir, file); const req = readPrivateJson(p, 262144) as Record<string, unknown>; const allowed = this.granted(grant.cwd, grant.companyId, grant.secretNames); if (req.method === 'list') { result = []; for (const s of allowed) { try { const tools = await this.tools(s); (result as unknown[]).push({ id: s.config.id, name: s.config.name, ...tools }) } catch (e) { this.rejected(s, e); if (s.saved) this.reset(s.config.id); (result as unknown[]).push({ id: s.config.id, error: `Connection unavailable. The founder can check it in Settings › Connections: ${connectLink(this.toolOf(s.config), grant.companyId)}` }) } } } else if (req.method === 'call') { const s = allowed.find(s => s.config.id === req.connection); if (!s || typeof req.tool !== 'string') throw new NotGranted(this.notGrantedMessage(req.connection, grant.companyId)); const refusal = this.check(grant, s.config, req.tool, req.arguments); if (refusal) throw new Refused(refusal); try { result = await this.client(s).request('tools/call', { name: req.tool, arguments: req.arguments ?? {} }) } catch (e) { this.rejected(s, e); throw e } } else throw new Error('Unknown method'); result = { ok: true, result } } catch (e) { result = { ok: false, error: e instanceof NotGranted ? e.message : e instanceof Refused ? `Refused by Principia: ${e.message}.` : `MCP request failed; check the connection's sign-in and access in Principia: Settings › Connections (${connectLink('mcp', grant.companyId)})` } } try { const answer = path.join(grant.dir, file.replace('.request', '.answer')); writePrivateJson(answer, result, this.opts.fileOwner); fs.unlinkSync(path.join(grant.dir, file)) } catch {} finally { grant.busy.delete(file) } })()
      }
    }
  }
  /** The run's check before a call (a throw refuses: a check that cannot answer never lets the call through). */
  /**
   * Every grant is checked, a chat session's or a run's (one of no playbook passes unless a money playbook runs now:
   * see Playbooks.liveMoneyRun). `connector`: the known ads server it is, from its URL or command, never its name.
   */
  private check(grant: { runId: string | null; companyId: string | null }, config: GatewayConnection, tool: string, args: unknown): string | null {
    if (!this.opts.guard) return null
    try { return this.opts.guard({ runId: grant.runId, companyId: grant.companyId, connection: config.id, tool, args: args ?? {}, readOnly: this.readOnly.get(config.id)?.has(tool) === true, connector: adsConnectorOf({ url: config.url ?? null, command: config.command ?? null, args: config.args ?? null }) }) } catch { return 'Principia could not check this call, so it was not made' }
  }
  /** The Connections card of a saved connection: its catalog tool (stripe, notion, …), else "your own MCP server". */
  private toolOf(c: Pick<GatewayConnection, 'url'>): string { return (c.url && serviceForUrl(c.url)?.id) || 'mcp' }
  /**
   * principia_call_tool on a connection this spawn does not have: say plainly that it is not connected for this company
   * and give the exact principia://connect link (Settings › Connections). Never names another company's connection.
   */
  private notGrantedMessage(connection: unknown, companyId: string | null): string {
    const id = typeof connection === 'string' ? connection.slice(0, 80) : ''
    const saved = this.saved.find(s => s.config.id === id)
    const tool = saved && (!companyId || !saved.config.companyIds?.length || saved.config.companyIds.includes(companyId)) ? this.toolOf(saved.config) : (connectToolId(id.startsWith('svc:') ? id.slice(4) : id) ?? 'mcp')
    return `${id ? `"${id}"` : 'That connection'} is not connected for this company. Tell the founder in plain words; they can connect it in Settings › Connections: ${connectLink(tool, companyId)} (principia_list_tools lists what is connected now).`
  }
  close(): void { clearInterval(this.timer); for (const oauth of this.oauth.values()) oauth.close(); this.oauth.clear(); for (const c of this.clients.values()) c.close(); for (const g of this.grants.values()) fs.rmSync(g.dir, { recursive: true, force: true }); this.grants.clear() }
}
