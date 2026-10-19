/** Managed MCP OAuth. Tokens/client registrations stay in encrypted main-process storage. */
import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { GatewayAuthStatus } from '../../shared/gateway'

export interface OAuthSaved {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
  redirectUrl?: string
  discovery?: OAuthDiscoveryState
}
export interface OAuthOptions {
  serverUrl: string
  load(): OAuthSaved | undefined
  save(state: OAuthSaved | undefined): void
  onStatus(status: GatewayAuthStatus, error?: string): void
  fetchFn?: typeof fetch
  /** Test-only injected transport. Production requires HTTPS metadata/token endpoints. */
  allowInsecureLocalhost?: boolean
}
const TIMEOUT = 5 * 60_000
export class OAuthConnection {
  private closed = false
  private server?: Server
  private timer?: NodeJS.Timeout
  private verifier?: string
  private state?: string
  private callbackUsed = false
  private generation = 0
  private refreshing?: Promise<void>
  private browser?: (url: string) => Promise<void>
  constructor(private opts: OAuthOptions) {}
  private checkedUrl(value: string | URL): URL {
    const url = new URL(value)
    const local = this.opts.allowInsecureLocalhost && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) throw new Error('OAuth endpoints require HTTPS')
    return url
  }
  private fetch: typeof fetch = async (input, init) => {
    const value = typeof input === 'string' || input instanceof URL ? input : input.url
    this.checkedUrl(value)
    return (this.opts.fetchFn ?? fetch)(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  }
  private update(patch: Partial<OAuthSaved>): void { this.opts.save({ ...(this.opts.load() ?? {}), ...patch }) }
  private provider(generation: number): OAuthClientProvider {
    const current = () => { if (generation !== this.generation) throw new Error('OAuth request canceled') }
    return {
      get redirectUrl() { return undefined }, // overridden below so callbacks read current persisted redirect
      clientMetadata: { client_name: 'Principia', redirect_uris: [this.opts.load()?.redirectUrl ?? 'http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      state: () => { current(); if (!this.state) throw new Error('Sign in from Principia settings'); return this.state },
      clientInformation: () => { current(); return this.opts.load()?.client },
      saveClientInformation: client => { current(); this.update({ client }) },
      tokens: () => { current(); return this.opts.load()?.tokens },
      saveTokens: tokens => { current(); this.update({ tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined }); this.opts.onStatus('connected') },
      redirectToAuthorization: async url => { current(); this.checkedUrl(url); if (!this.browser) throw new Error('Sign in again from Principia settings'); await this.browser(url.toString()) },
      saveCodeVerifier: verifier => { current(); this.verifier = verifier },
      codeVerifier: () => { current(); if (!this.verifier) throw new Error('OAuth verifier expired'); return this.verifier },
      saveDiscoveryState: discovery => { current(); this.update({ discovery }) },
      discoveryState: () => { current(); return this.opts.load()?.discovery },
      invalidateCredentials: scope => { current(); const saved = this.opts.load() ?? {}; if (scope === 'all') this.opts.save(undefined); else { if (scope === 'client') delete saved.client; if (scope === 'tokens') { delete saved.tokens; delete saved.expiresAt }; if (scope === 'discovery') delete saved.discovery; if (scope === 'verifier') this.verifier = undefined; this.opts.save(saved) } }
    }
  }
  private authProvider(generation: number): OAuthClientProvider {
    const provider = this.provider(generation)
    Object.defineProperty(provider, 'redirectUrl', { get: () => this.opts.load()?.redirectUrl })
    return provider
  }
  async connect(openBrowser: (url: string) => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('OAuth connection was replaced')
    this.checkedUrl(this.opts.serverUrl)
    this.cleanup(); this.refreshing = undefined; const generation = ++this.generation
    this.opts.onStatus('connecting'); this.browser = openBrowser; this.state = randomBytes(32).toString('hex'); this.callbackUsed = false
    // A new ephemeral callback requires a registration with that exact redirect URI.
    const previous = this.opts.load()
    let priorRedirect: URL | undefined
    try { const candidate = new URL(previous?.redirectUrl ?? ''); if (candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1' && /^\/oauth\/[a-f0-9]{48}$/.test(candidate.pathname) && candidate.port) priorRedirect = candidate } catch {}
    const callbackPath = priorRedirect?.pathname ?? '/oauth/' + randomBytes(24).toString('hex')
    const server = createServer((req, res) => {
      const finish = (status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' }); res.end(text) }
      if (generation !== this.generation || this.callbackUsed) return finish(410, 'This sign-in request has expired.')
      const address = server.address(); if (!address || typeof address === 'string') return finish(400, 'Invalid callback.')
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${address.port}`) return finish(400, 'Invalid callback.')
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${address.port}`)
      if (url.pathname !== callbackPath) return finish(404, 'Not found.')
      const received = Buffer.from(url.searchParams.get('state') ?? ''); const expected = Buffer.from(this.state ?? '')
      if (!expected.length || received.length !== expected.length || !timingSafeEqual(received, expected)) return finish(400, 'Invalid sign-in state. Return to Principia and try again.')
      const discovery = this.opts.load()?.discovery
      const metadata = discovery?.authorizationServerMetadata as Record<string, unknown> | undefined
      const issuer = metadata?.issuer ?? this.opts.load()?.client?.issuer
      const responseIssuer = url.searchParams.get('iss')
      if ((responseIssuer !== null && responseIssuer !== issuer) || (metadata?.authorization_response_iss_parameter_supported === true && !responseIssuer)) return finish(400, 'Invalid authorization server. Return to Principia and try again.')
      this.callbackUsed = true
      if (url.searchParams.has('error') || !url.searchParams.get('code')) { finish(400, 'Sign-in was declined. Return to Principia to try again.'); this.fail('Sign-in was declined. Try connecting again.'); return }
      const code = url.searchParams.get('code')!
      void auth(this.authProvider(generation), { serverUrl: this.opts.serverUrl, authorizationCode: code, fetchFn: this.fetch })
        .then(result => { if (generation !== this.generation) { finish(410, 'This sign-in request has expired.'); return }; if (result !== 'AUTHORIZED') throw new Error('Authorization incomplete'); finish(200, 'Connected to Principia. You can close this tab.'); this.cleanup() })
        .catch(() => { if (generation !== this.generation) { finish(410, 'This sign-in request has expired.'); return }; finish(400, 'Sign-in failed. Return to Principia to try again.'); this.fail('Sign-in failed. Try connecting again.') })
    })
    server.requestTimeout = 10_000; server.headersTimeout = 5_000
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => { if (priorRedirect && error.code === 'EADDRINUSE') { priorRedirect = undefined; server.once('error', reject); server.listen(0, '127.0.0.1', resolve) } else reject(error) }
        server.once('error', onError); server.listen(priorRedirect ? Number(priorRedirect.port) : 0, '127.0.0.1', resolve)
      })
      if (generation !== this.generation) { server.close(); return }
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Callback unavailable')
      if (!priorRedirect) this.opts.save(undefined)
      this.update({ redirectUrl: `http://127.0.0.1:${address.port}${callbackPath}` })
      this.timer = setTimeout(() => { if (generation === this.generation) this.fail('Sign-in expired. Try connecting again.') }, TIMEOUT); this.timer.unref()
      const result = await auth(this.authProvider(generation), { serverUrl: this.opts.serverUrl, fetchFn: this.fetch })
      if (result === 'AUTHORIZED') this.cleanup()
    } catch { if (generation === this.generation) this.fail('Could not start sign-in. Check the server URL and try again.'); throw new Error('Could not start OAuth sign-in') }
  }
  async headers(forceRefresh = false): Promise<Record<string, string>> {
    if (this.closed) throw new Error('OAuth connection was replaced')
    const requestGeneration = this.generation
    const saved = this.opts.load()
    if (!saved?.tokens) throw new Error('Sign in to this connection in Principia settings')
    if (forceRefresh || (saved.expiresAt !== undefined && saved.expiresAt <= Date.now() + 60_000)) {
      if (!this.refreshing) {
        const generation = this.generation
        this.refreshing = (async () => {
          if (!saved.tokens?.refresh_token) throw new Error('Sign in again from Principia settings')
          const result = await auth(this.authProvider(generation), { serverUrl: this.opts.serverUrl, fetchFn: this.fetch })
          if (result !== 'AUTHORIZED') throw new Error('Sign in again from Principia settings')
        })().catch(() => { if (generation === this.generation) this.opts.onStatus('error', 'Your connection needs sign-in again.'); throw new Error('OAuth connection needs sign-in again') }).finally(() => { if (generation === this.generation) this.refreshing = undefined })
      }
      await this.refreshing
    }
    if (this.closed || requestGeneration !== this.generation) throw new Error('OAuth request canceled')
    const tokens = this.opts.load()?.tokens
    if (!tokens?.access_token || !/^Bearer$/i.test(tokens.token_type)) throw new Error('Unsupported OAuth token type')
    return { Authorization: `Bearer ${tokens.access_token}` }
  }
  private fail(message: string): void { this.generation++; this.cleanup(); this.opts.onStatus('error', message) }
  private cleanup(): void { clearTimeout(this.timer); this.timer = undefined; this.server?.close(); this.server?.closeIdleConnections(); this.server = undefined; this.verifier = undefined; this.state = undefined; this.browser = undefined }
  disconnect(): void { this.generation++; this.refreshing = undefined; this.cleanup(); this.opts.save(undefined); this.opts.onStatus('disconnected') }
  close(): void { this.closed = true; this.generation++; this.cleanup() }
}
