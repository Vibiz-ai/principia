/** Independent authorization-server integration fixture. No real provider sign-in or consent. */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { OAuthConnection, type OAuthSaved } from '../oauth'

const resource = 'https://mcp.example.com/mcp'
const issuer = 'https://auth.example.com'
function fixture({ issuerParameter = false } = {}) {
  let saved: OAuthSaved | undefined
  let browser: URL | undefined
  let registrationRedirect = ''
  let tokenCalls = 0
  let challenge = ''
  let blockToken = false
  let unblockToken: (() => void) | undefined
  const statuses: string[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.href === resource) return json({ error: 'unauthorized' }, 401)
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource, authorization_servers: [issuer], scopes_supported: ['openid'] })
    if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', registration_endpoint: issuer + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: issuerParameter })
    if (url.pathname === '/register') {
      const metadata = JSON.parse(String(init?.body))
      expect(metadata.token_endpoint_auth_method).toBe('none')
      registrationRedirect = metadata.redirect_uris[0]
      return json({ ...metadata, client_id: 'principia-test-client' }, 201)
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(String(init?.body)); tokenCalls++
      if (params.get('grant_type') === 'authorization_code') {
        expect(params.get('redirect_uri')).toBe(registrationRedirect)
        expect(params.get('code')).toBe('test-authorization-code')
        expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(challenge)
      } else { expect(params.get('grant_type')).toBe('refresh_token'); expect(params.get('refresh_token')).toBe('test-refresh-token') }
      if (blockToken) { blockToken = false; await new Promise<void>(resolve => { unblockToken = resolve }) }
      return json({ access_token: `test-access-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'test-refresh-token', scope: 'openid' })
    }
    throw new Error(`Unexpected OAuth fixture URL ${url.href}`)
  }
  const makeConnection = () => new OAuthConnection({ serverUrl: resource, load: () => saved, save: state => { saved = state }, onStatus: status => statuses.push(status), fetchFn })
  let connection = makeConnection()
  const start = async () => { await connection.connect(async value => { browser = new URL(value); challenge = browser.searchParams.get('code_challenge')! }); expect(browser).toBeDefined(); return browser! }
  return { get connection() { return connection }, restart: () => { connection.close(); connection = makeConnection() }, blockNextToken: () => { blockToken = true }, releaseToken: () => { unblockToken?.() }, start, statuses, saved: () => saved, tokenCalls: () => tokenCalls }
}
async function waitUntil(condition: () => boolean) { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('OAuth callback did not complete') }
function callback(browser: URL, state = browser.searchParams.get('state')!) { const url = new URL(browser.searchParams.get('redirect_uri')!); url.searchParams.set('code', 'test-authorization-code'); url.searchParams.set('state', state); return url }

describe('managed MCP OAuth integration', () => {
  it('uses public DCR + PKCE, completes loopback callback, refreshes and disconnects', async () => {
    const f = fixture()
    try {
      const browser = await f.start()
      expect(browser.origin).toBe(issuer)
      expect(browser.searchParams.get('scope')).toBe('openid')
      expect(browser.searchParams.get('code_challenge_method')).toBe('S256')
      expect(browser.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32)
      expect(new URL(browser.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1')
      const response = await fetch(callback(browser)); expect(response.status).toBe(200)
      await waitUntil(() => f.statuses.includes('connected'))
      expect((await f.connection.headers()).Authorization).toBe('Bearer test-access-1')
      expect((await f.connection.headers(true)).Authorization).toBe('Bearer test-access-2')
      expect(f.tokenCalls()).toBe(2)
      expect(f.saved()).toBeDefined()
      f.connection.disconnect(); expect(f.saved()).toBeUndefined()
    } finally { f.connection.close() }
  })
  it('refreshes persisted tokens after a new process session without opening a browser', async () => {
    const f = fixture()
    try {
      await fetch(callback(await f.start()))
      await waitUntil(() => f.statuses.includes('connected'))
      f.restart()
      expect((await f.connection.headers(true)).Authorization).toBe('Bearer test-access-2')
      expect(f.tokenCalls()).toBe(2)
    } finally { f.connection.close() }
  })
  it('requires and validates issuer when authorization-server metadata advertises it', async () => {
    const f = fixture({ issuerParameter: true })
    try {
      const browser = await f.start()
      expect((await fetch(callback(browser))).status).toBeGreaterThanOrEqual(400)
      expect(f.tokenCalls()).toBe(0)
      const wrong = callback(browser); wrong.searchParams.set('iss', 'https://attacker.example.com')
      expect((await fetch(wrong)).status).toBeGreaterThanOrEqual(400)
      expect(f.tokenCalls()).toBe(0)
      const correct = callback(browser); correct.searchParams.set('iss', issuer)
      expect((await fetch(correct)).status).toBe(200)
      await waitUntil(() => f.statuses.includes('connected'))
    } finally { f.connection.close() }
  })
  it('does not restore tokens or overwrite status after disconnect during token exchange', async () => {
    const f = fixture()
    try {
      f.blockNextToken()
      const request = fetch(callback(await f.start()))
      await waitUntil(() => f.tokenCalls() === 1)
      f.connection.disconnect(); f.releaseToken()
      await request
      expect(f.saved()).toBeUndefined()
      expect(f.statuses.at(-1)).toBe('disconnected')
    } finally { f.releaseToken(); f.connection.close() }
  })
  it('rejects stale in-flight refresh after disconnect without restoring credentials', async () => {
    const f = fixture()
    try {
      await fetch(callback(await f.start()))
      await waitUntil(() => f.statuses.includes('connected'))
      f.blockNextToken()
      const refresh = f.connection.headers(true)
      const rejected = expect(refresh).rejects.toThrow()
      await waitUntil(() => f.tokenCalls() === 2)
      f.connection.disconnect(); f.releaseToken()
      await rejected
      expect(f.saved()).toBeUndefined()
      expect(f.statuses.at(-1)).toBe('disconnected')
    } finally { f.releaseToken(); f.connection.close() }
  })
  it('old callback cannot close or fail a newer sign-in attempt', async () => {
    const f = fixture()
    try {
      f.blockNextToken()
      const oldCallback = fetch(callback(await f.start()))
      await waitUntil(() => f.tokenCalls() === 1)
      const newBrowser = await f.start()
      f.releaseToken(); await oldCallback
      expect(f.statuses.at(-1)).toBe('connecting')
      expect((await fetch(callback(newBrowser))).status).toBe(200)
      await waitUntil(() => f.statuses.at(-1) === 'connected')
    } finally { f.releaseToken(); f.connection.close() }
  })
  it('rejects callback state mismatch without exchanging an authorization code', async () => {
    const f = fixture()
    try {
      const browser = await f.start()
      const response = await fetch(callback(browser, 'attacker-state'))
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(f.tokenCalls()).toBe(0)
      expect(f.statuses).not.toContain('connected')
    } finally { f.connection.close() }
  })
})
