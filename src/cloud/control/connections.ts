/**
 * Connectors in the cloud (CLOUD.md §7.5): per company MCP connections, credentials write-only and encrypted, the
 * built-in read-only `passport` entry, an SSRF guard on every URL, and OAuth through MCP SDK auth() with the redirect
 * `<publicUrl>/oauth/connectors/callback`. State is bound to workspace, connection and actor, single use, 10 minutes.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { z } from 'zod'
import type { CloudConnection } from '../../shared/cloud'
import type { ConnectionMaterial } from '../contract'
import type { Actor, Ctx } from './context'
import { ApiError, badRequest, notFound } from './http'
import { sha256 } from './auth'

const STATE_TTL_MS = 10 * 60_000
export const CALLBACK_PATH = '/oauth/connectors/callback'

// ---------- SSRF guard ----------

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}
/** private, loopback, link-local, CGNAT, unspecified, multicast and reserved ranges (IPv4, IPv6, IPv4-mapped) */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return v4Private(ip)
  if (kind !== 6) return true
  const s = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (mapped) return v4Private(mapped[1]!)
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) {
    const [hi, lo] = s.slice(7).split(':').map(h => parseInt(h, 16)) as [number, number]
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  // ::/96 (IPv4-compatible, deprecated: ::7f00:1 is ::127.0.0.1), which also covers :: and ::1
  if (/^::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)?$/.test(s)) return true
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8')
}

export type Lookup = (host: string) => Promise<string[]>
export const defaultLookup: Lookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(a => a.address)

/** https only; hosts resolving to private addresses are refused unless allowlisted (then http is allowed too). */
export async function guardUrl(raw: string, allow: string[], lookup: Lookup = defaultLookup): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw badRequest('That is not a valid URL.') }
  if (url.username || url.password) throw badRequest('Connection URLs cannot carry a user name or password. Use credentials instead.')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const allowed = allow.map(h => h.toLowerCase()).includes(host)
  if (url.protocol !== 'https:' && !(allowed && url.protocol === 'http:')) throw badRequest('Connection URLs must use https.')
  if (allowed) return url
  let addrs: string[]
  try { addrs = isIP(host) ? [host] : await lookup(host) } catch { throw badRequest(`Could not resolve ${host}.`) }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw badRequest(`${host} points at a private network address. Add it to PRINCIPIA_CONNECTOR_ALLOW_PRIVATE if you mean it.`)
  return url
}

// ---------- rows ----------

interface ConnRow {
  company_id: string; id: string; name: string; transport: string; command: string | null; args: string | null; url: string | null
  enabled: number; authentication: string; auth_status: string | null; auth_detail: string | null; credentials_ct: string | null; oauth_ct: string | null
}
interface OAuthSaved { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; expiresAt?: number; discovery?: OAuthDiscoveryState }

const putSchema = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).max(500).regex(/^[^\n\r\0]+$/).optional(),
  args: z.array(z.string().max(2000)).max(50).optional(),
  url: z.string().max(2000).optional(),
  enabled: z.boolean(),
  authentication: z.enum(['none', 'headers', 'oauth']),
  credentials: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), z.string().max(8192)).refine(r => Object.keys(r).length <= 50).optional()
})
export const CONNECTION_ID = /^[a-zA-Z0-9_-]{1,64}$/

const credKey = (cid: string, id: string) => `${cid}/${id}`

export function createConnections(ctx: Ctx) {
  const lookup = ctx.config.lookup ?? defaultLookup
  const fetchImpl = ctx.config.fetch ?? fetch
  const redirectUrl = () => `${ctx.config.publicUrl}${CALLBACK_PATH}`
  const guardedFetch: typeof fetch = async (input, init) => {
    const u = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    await guardUrl(u, ctx.config.connectorAllowPrivate, lookup)
    return fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  }

  const row = (cid: string, id: string) => ctx.db.get<ConnRow>('SELECT * FROM connections WHERE company_id = ? AND id = ?', cid, id)
  const loadOAuth = (r: ConnRow): OAuthSaved => (r.oauth_ct ? JSON.parse(ctx.vault.decrypt('connection-oauth', credKey(r.company_id, r.id), r.oauth_ct)) : {})
  const oauthSecrets = (s: OAuthSaved): string[] => [s.tokens?.access_token, s.tokens?.refresh_token, s.tokens?.id_token, (s.client as { client_secret?: string } | undefined)?.client_secret].filter((x): x is string => typeof x === 'string')
  const saveOAuth = (cid: string, id: string, s: OAuthSaved | undefined) =>
    ctx.db.run('UPDATE connections SET oauth_ct = ?, updated_at = ? WHERE company_id = ? AND id = ?', s ? ctx.vault.encrypt('connection-oauth', credKey(cid, id), JSON.stringify(s), oauthSecrets(s)) : null, ctx.now().toISOString(), cid, id)
  const setStatus = (cid: string, id: string, status: CloudConnection['authStatus'], detail: string | null = null) =>
    ctx.db.run('UPDATE connections SET auth_status = ?, auth_detail = ? WHERE company_id = ? AND id = ?', status, detail, cid, id)

  function view(r: ConnRow): CloudConnection {
    const oauth = r.authentication === 'oauth'
    return {
      id: r.id, name: r.name, transport: r.transport as 'stdio' | 'http',
      ...(r.command ? { command: r.command } : {}), ...(r.args ? { args: JSON.parse(r.args) as string[] } : {}), ...(r.url ? { url: r.url } : {}),
      enabled: !!r.enabled, authentication: r.authentication as CloudConnection['authentication'],
      authStatus: oauth ? ((r.auth_status as CloudConnection['authStatus']) ?? 'disconnected') : null,
      hasCredentials: !!r.credentials_ct || (oauth && r.auth_status === 'connected'),
      builtIn: false
    }
  }

  /** the OAuth client provider over the vault; `flow` collects the redirect and the PKCE verifier */
  function provider(cid: string, id: string, flow: { state?: string; verifier?: string; redirect?: URL }): OAuthClientProvider {
    const current = () => { const r = row(cid, id); if (!r) throw new Error('connection removed'); return r }
    const update = (patch: Partial<OAuthSaved>): void => { saveOAuth(cid, id, { ...loadOAuth(current()), ...patch }) }
    return {
      get redirectUrl() { return redirectUrl() },
      clientMetadata: { client_name: 'Principia Cloud', redirect_uris: [redirectUrl()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      state: () => { if (!flow.state) throw new Error('no state'); return flow.state },
      clientInformation: () => loadOAuth(current()).client,
      saveClientInformation: client => update({ client }),
      tokens: () => loadOAuth(current()).tokens,
      saveTokens: tokens => update({ tokens, expiresAt: tokens.expires_in !== undefined ? ctx.now().getTime() + tokens.expires_in * 1000 : undefined }),
      redirectToAuthorization: url => { if (flow.state === undefined) throw new Error('needs sign-in'); flow.redirect = url },
      saveCodeVerifier: v => { flow.verifier = v },
      codeVerifier: () => { if (!flow.verifier) throw new Error('verifier expired'); return flow.verifier },
      saveDiscoveryState: discovery => update({ discovery }),
      discoveryState: () => loadOAuth(current()).discovery,
      invalidateCredentials: scope => {
        const s = loadOAuth(current())
        if (scope === 'all') { saveOAuth(cid, id, undefined); return }
        if (scope === 'client') delete s.client
        if (scope === 'tokens') { delete s.tokens; delete s.expiresAt }
        if (scope === 'discovery') delete s.discovery
        if (scope === 'verifier') flow.verifier = undefined
        saveOAuth(cid, id, s)
      }
    }
  }

  async function bearer(cid: string, id: string): Promise<string> {
    const r = row(cid, id)
    if (!r?.url) throw new Error('no connection')
    let saved = loadOAuth(r)
    if (!saved.tokens) throw new Error('not signed in')
    if (saved.expiresAt !== undefined && saved.expiresAt <= ctx.now().getTime() + 60_000) {
      try {
        if (!saved.tokens.refresh_token) throw new Error('no refresh token')
        const result = await auth(provider(cid, id, {}), { serverUrl: r.url, fetchFn: guardedFetch })
        if (result !== 'AUTHORIZED') throw new Error('refresh failed')
      } catch (e) {
        setStatus(cid, id, 'error', 'Needs sign-in again.')
        throw e
      }
      saved = loadOAuth(row(cid, id)!)
    }
    if (!saved.tokens?.access_token || !/^Bearer$/i.test(saved.tokens.token_type)) throw new Error('unsupported token type')
    return `Bearer ${saved.tokens.access_token}`
  }

  return {
    list(cid: string, passportUrl: string | null): CloudConnection[] {
      const out = ctx.db.all<ConnRow>('SELECT * FROM connections WHERE company_id = ? ORDER BY id', cid).map(view)
      if (passportUrl) out.unshift({ id: 'passport', name: 'Passport', transport: 'http', url: passportUrl, enabled: true, authentication: 'headers', authStatus: null, hasCredentials: true, builtIn: true })
      return out
    },
    rows: (cid: string) => ctx.db.all<ConnRow>('SELECT * FROM connections WHERE company_id = ? ORDER BY id', cid).map(view),
    async put(actor: Actor, cid: string, id: string, body: unknown): Promise<CloudConnection> {
      if (id === 'passport') throw new ApiError('forbidden', 'The passport connection is built in. It cannot be changed.')
      if (!CONNECTION_ID.test(id)) throw badRequest('Connection ids use letters, digits, _ and - (64 at most).')
      const p = putSchema.safeParse(body)
      if (!p.success) throw badRequest(`Invalid connection: ${p.error.issues[0]?.path.join('.') || 'body'} ${p.error.issues[0]?.message ?? ''}`.trim())
      const b = p.data
      if (b.transport === 'stdio' && !b.command) throw badRequest('A stdio connection needs a command.')
      if (b.transport === 'http' && !b.url) throw badRequest('An http connection needs a url.')
      if (b.transport === 'stdio' && b.authentication === 'oauth') throw badRequest('OAuth needs an http connection.')
      const url = b.transport === 'http' ? (await guardUrl(b.url!, ctx.config.connectorAllowPrivate, lookup)).toString() : null
      const now = ctx.now().toISOString()
      const prev = row(cid, id)
      for (const v of Object.values(b.credentials ?? {})) ctx.vault.remember(v)
      // stored headers belong to the address they were given for: a new URL or command without them resent drops them,
      // so an old Authorization header never goes to a different host
      const sameTarget = !!prev && prev.transport === b.transport && prev.url === url && prev.command === (b.transport === 'stdio' ? b.command! : null)
      const creds = b.credentials !== undefined ? (Object.keys(b.credentials).length ? ctx.vault.encrypt('connection-credentials', credKey(cid, id), JSON.stringify(b.credentials)) : null) : (sameTarget ? (prev?.credentials_ct ?? null) : null)
      const resetOAuth = !prev || prev.url !== url || b.authentication !== 'oauth' || prev.authentication !== 'oauth'
      ctx.db.run(`INSERT INTO connections (company_id, id, name, transport, command, args, url, enabled, authentication, auth_status, credentials_ct, oauth_ct, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT (company_id, id) DO UPDATE SET name = excluded.name, transport = excluded.transport, command = excluded.command, args = excluded.args,
          url = excluded.url, enabled = excluded.enabled, authentication = excluded.authentication, credentials_ct = excluded.credentials_ct, updated_at = excluded.updated_at`,
        cid, id, b.name, b.transport, b.transport === 'stdio' ? b.command! : null, b.transport === 'stdio' && b.args ? JSON.stringify(b.args) : null, url,
        b.enabled ? 1 : 0, b.authentication, b.authentication === 'oauth' ? 'disconnected' : null, creds, now, now)
      if (prev && resetOAuth) { saveOAuth(cid, id, undefined); setStatus(cid, id, b.authentication === 'oauth' ? 'disconnected' : null) }
      ctx.audit(actor, prev ? 'connection.update' : 'connection.create', cid, id, { transport: b.transport, authentication: b.authentication, credentials: b.credentials !== undefined })
      return view(row(cid, id)!)
    },
    remove(actor: Actor, cid: string, id: string): void {
      if (id === 'passport') throw new ApiError('forbidden', 'The passport connection is built in. It cannot be removed.')
      if (!ctx.db.run('DELETE FROM connections WHERE company_id = ? AND id = ?', cid, id)) throw notFound('No such connection.')
      ctx.audit(actor, 'connection.delete', cid, id, {})
    },
    async authorize(actor: Actor, cid: string, id: string): Promise<{ authorizeUrl: string }> {
      if (id === 'passport') throw badRequest('The passport connection needs no sign-in.')
      const r = row(cid, id)
      if (!r) throw notFound('No such connection.')
      if (r.authentication !== 'oauth' || !r.url) throw badRequest('This connection does not use OAuth.')
      await guardUrl(r.url, ctx.config.connectorAllowPrivate, lookup)
      const saved = loadOAuth(r)
      saveOAuth(cid, id, { client: saved.client, discovery: saved.discovery })
      const state = randomBytes(32).toString('base64url')
      const flow: { state?: string; verifier?: string; redirect?: URL } = { state }
      let result: string
      try { result = await auth(provider(cid, id, flow), { serverUrl: r.url, fetchFn: guardedFetch }) } catch (e) {
        setStatus(cid, id, 'error', 'Could not start sign-in.')
        ctx.log.warn('connector oauth start failed', { companyId: cid, connection: id, error: (e as Error).message })
        throw new ApiError('unavailable', 'Could not start sign-in with this connection. Check its URL.')
      }
      if (result !== 'REDIRECT' || !flow.redirect || !flow.verifier) throw new ApiError('unavailable', 'The connection did not ask for a sign-in.')
      const now = ctx.now()
      const stateHash = sha256(state)
      ctx.db.run('INSERT INTO oauth_state (state_hash, workspace_id, company_id, connection_id, actor_kind, actor_id, verifier_ct, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        stateHash, ctx.workspaceId, cid, id, actor.kind, actor.id, ctx.vault.encrypt('oauth-verifier', stateHash, flow.verifier), now.toISOString(), new Date(now.getTime() + STATE_TTL_MS).toISOString())
      setStatus(cid, id, 'connecting')
      ctx.audit(actor, 'connection.authorize', cid, id, {})
      return { authorizeUrl: flow.redirect.toString() }
    },
    /** GET /oauth/connectors/callback: returns the status and a plain sentence for the browser tab */
    async callback(q: URLSearchParams): Promise<{ status: number; text: string }> {
      const state = q.get('state') ?? ''
      const stateHash = sha256(state)
      const now = ctx.now().toISOString()
      const s = state ? ctx.db.get<{ workspace_id: string; company_id: string; connection_id: string; actor_kind: string; actor_id: string | null; verifier_ct: string }>(
        'SELECT * FROM oauth_state WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?', stateHash, now) : undefined
      if (!s || s.workspace_id !== ctx.workspaceId || !ctx.db.run('UPDATE oauth_state SET used_at = ? WHERE state_hash = ? AND used_at IS NULL', now, stateHash)) return { status: 400, text: 'This sign-in link has expired. Go back to Principia and press Authorize again.' }
      const actorAlive = s.actor_kind === 'device'
        ? !!ctx.db.get('SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL', s.actor_id)
        : s.actor_kind === 'session' ? !!ctx.db.get('SELECT id FROM sessions WHERE id = ? AND revoked_at IS NULL', s.actor_id) : false
      const r = row(s.company_id, s.connection_id)
      if (!actorAlive || !r || !r.url) return { status: 400, text: 'This sign-in is no longer valid. Go back to Principia and press Authorize again.' }
      const actor: Actor = { kind: s.actor_kind as Actor['kind'], id: s.actor_id, name: null }
      const saved = loadOAuth(r)
      const meta = saved.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined
      const iss = q.get('iss')
      if ((iss !== null && meta?.issuer !== undefined && iss !== meta.issuer) || (meta?.authorization_response_iss_parameter_supported === true && !iss)) {
        setStatus(s.company_id, s.connection_id, 'error', 'Wrong authorization server.')
        return { status: 400, text: 'The sign-in came from the wrong server. Go back to Principia and try again.' }
      }
      const code = q.get('code')
      if (q.has('error') || !code) {
        setStatus(s.company_id, s.connection_id, 'error', 'Sign-in was declined.')
        ctx.audit(actor, 'connection.authorize.declined', s.company_id, s.connection_id, {})
        return { status: 400, text: 'Sign-in was declined. Go back to Principia to try again.' }
      }
      const flow = { verifier: ctx.vault.decrypt('oauth-verifier', stateHash, s.verifier_ct) }
      try {
        const result = await auth(provider(s.company_id, s.connection_id, flow), { serverUrl: r.url, authorizationCode: code, fetchFn: guardedFetch })
        if (result !== 'AUTHORIZED') throw new Error('incomplete')
      } catch (e) {
        setStatus(s.company_id, s.connection_id, 'error', 'Sign-in failed.')
        ctx.log.warn('connector oauth callback failed', { companyId: s.company_id, connection: s.connection_id, error: (e as Error).message })
        return { status: 400, text: 'Sign-in failed. Go back to Principia to try again.' }
      }
      setStatus(s.company_id, s.connection_id, 'connected')
      ctx.audit(actor, 'connection.authorize.done', s.company_id, s.connection_id, {})
      return { status: 200, text: `${r.name} is connected to Principia Cloud. You can close this tab.` }
    },
    /** decrypted connections for a run; OAuth ones refreshed near expiry and given an Authorization header */
    async materials(cid: string): Promise<{ materials: ConnectionMaterial[]; skipped: string[] }> {
      const out: ConnectionMaterial[] = []
      const skipped: string[] = []
      for (const r of ctx.db.all<ConnRow>('SELECT * FROM connections WHERE company_id = ? AND enabled = 1 ORDER BY id', cid)) {
        const credentials: Record<string, string> = r.credentials_ct ? JSON.parse(ctx.vault.decrypt('connection-credentials', credKey(cid, r.id), r.credentials_ct)) : {}
        if (r.authentication === 'oauth') {
          try { credentials.Authorization = await bearer(cid, r.id) } catch { skipped.push(r.id); continue }
        }
        out.push({ id: r.id, name: r.name, transport: r.transport as 'stdio' | 'http', ...(r.command ? { command: r.command } : {}), ...(r.args ? { args: JSON.parse(r.args) } : {}), ...(r.url ? { url: r.url } : {}), credentials })
      }
      return { materials: out, skipped }
    },
    bearer,
    /** every credential value, for redaction at boot */
    primeSecrets(): void {
      for (const r of ctx.db.all<ConnRow>('SELECT * FROM connections')) {
        try { if (r.credentials_ct) for (const v of Object.values(JSON.parse(ctx.vault.decrypt('connection-credentials', credKey(r.company_id, r.id), r.credentials_ct)) as Record<string, string>)) ctx.vault.remember(v) } catch { /* unreadable row: skipped */ }
        try { if (r.oauth_ct) { const s = loadOAuth(r); for (const v of [s.tokens?.access_token, s.tokens?.refresh_token]) if (v) ctx.vault.remember(v) } } catch { /* skipped */ }
      }
    }
  }
}
export type Connections = ReturnType<typeof createConnections>
