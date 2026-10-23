/** Connector OAuth (CLOUD.md §7.5) against an in-process fake authorization server, plus the SSRF guard. */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { guardUrl, isPrivateAddress } from '../connections'
import { startHarness, workflowFile, type Harness } from './harness'

const resource = 'https://mcp.example.com/mcp'
const issuer = 'https://auth.example.com'

function authServer(o: { issParam?: boolean } = {}) {
  const seen = { registrations: 0, tokenCalls: 0, redirect: '', challenge: '', refreshes: 0 }
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.href === resource) return json({ error: 'unauthorized' }, 401)
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource, authorization_servers: [issuer], scopes_supported: ['read'] })
    if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', registration_endpoint: issuer + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: !!o.issParam })
    if (url.pathname === '/register') {
      const m = JSON.parse(String(init?.body))
      seen.registrations++
      seen.redirect = m.redirect_uris[0]
      expect(m.token_endpoint_auth_method).toBe('none')
      return json({ ...m, client_id: 'cloud-client' }, 201)
    }
    if (url.pathname === '/token') {
      const p = new URLSearchParams(String(init?.body))
      seen.tokenCalls++
      if (p.get('grant_type') === 'authorization_code') {
        expect(p.get('redirect_uri')).toBe(seen.redirect)
        expect(p.get('code')).toBe('the-code')
        expect(createHash('sha256').update(p.get('code_verifier')!).digest('base64url')).toBe(seen.challenge)
      } else { seen.refreshes++; expect(p.get('refresh_token')).toBe('oauth-refresh-token-xyz') }
      return json({ access_token: `oauth-access-token-${seen.tokenCalls}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'oauth-refresh-token-xyz' })
    }
    throw new Error(`unexpected ${url.href}`)
  }
  return { fetchFn, seen }
}

async function setup(h: Harness, seen: { challenge: string }) {
  const dev = await h.pair()
  await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
  await h.call('PUT', '/v1/companies/co_a/workflows/w', { token: dev, body: { file: workflowFile('Shell', [{ id: 's', type: 'shell', command: 'true' }]), baseRev: null } })
  const put = await h.call('PUT', '/v1/companies/co_a/connections/linear', { token: dev, body: { name: 'Linear', transport: 'http', url: resource, enabled: true, authentication: 'oauth' } })
  expect(put.json).toMatchObject({ id: 'linear', authentication: 'oauth', authStatus: 'disconnected', hasCredentials: false, builtIn: false })
  const auth = await h.call('POST', '/v1/companies/co_a/connections/linear/authorize', { token: dev })
  expect(auth.status).toBe(200)
  const browser = new URL(auth.json.authorizeUrl)
  seen.challenge = browser.searchParams.get('code_challenge')!
  return { dev, browser }
}

describe('connector OAuth in the cloud', () => {
  it('authorizes with DCR + PKCE through /oauth/connectors/callback, single use, then refreshes before dispatch', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const a = authServer()
    const h = await startHarness({ now: () => new Date(t), config: { fetch: a.fetchFn, lookup: async () => ['93.184.216.34'] } })
    try {
      const { dev, browser } = await setup(h, a.seen)
      expect(browser.origin).toBe(issuer)
      expect(browser.searchParams.get('redirect_uri')).toBe(`${h.url}/oauth/connectors/callback`)
      expect(browser.searchParams.get('code_challenge_method')).toBe('S256')
      const state = browser.searchParams.get('state')!
      expect(state.length).toBeGreaterThanOrEqual(40)
      expect((await h.call('GET', '/v1/companies/co_a/connections', { token: dev })).json[0].authStatus).toBe('connecting')
      const wrong = await h.call('GET', `/oauth/connectors/callback?code=the-code&state=nope`)
      expect(wrong.status).toBe(400)
      const ok = await h.call('GET', `/oauth/connectors/callback?code=the-code&state=${state}`)
      expect(ok.status).toBe(200)
      expect(ok.text).toContain('Linear is connected to Principia Cloud')
      expect(ok.headers.get('content-security-policy')).toMatch(/default-src 'none'/)
      expect((await h.call('GET', `/oauth/connectors/callback?code=the-code&state=${state}`)).status).toBe(400)
      const c = (await h.call('GET', '/v1/companies/co_a/connections', { token: dev })).json[0]
      expect(c).toMatchObject({ authStatus: 'connected', hasCredentials: true })
      // dispatch hands the runtime a fresh Authorization header, never the refresh token
      await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })
      await new Promise(r => setTimeout(r, 15))
      expect(h.rt.started[0]!.materials.connections).toEqual([{ id: 'linear', name: 'Linear', transport: 'http', url: resource, credentials: { Authorization: 'Bearer oauth-access-token-1' } }])
      t += 3600_000
      h.rt.finish(h.rt.started[0]!.runId, 'passed')
      await h.call('POST', '/v1/companies/co_a/runs', { token: dev, body: { kind: 'workflow', workflowId: 'w' } })
      await new Promise(r => setTimeout(r, 15))
      expect(a.seen.refreshes).toBe(1)
      expect(h.rt.started[1]!.materials.connections[0]!.credentials).toEqual({ Authorization: 'Bearer oauth-access-token-2' })
      expect(JSON.stringify(h.rt.started)).not.toContain('oauth-refresh-token-xyz')
      // readiness is happy with an authorized connection
      expect((await h.call('GET', '/v1/companies', { token: dev })).json[0].readiness.fixes.filter((f: { kind: string }) => f.kind === 'connection')).toEqual([])
    } finally { await h.close() }
  })

  it('state expires after 10 minutes, and dies with the device that started it', async () => {
    let t = Date.parse('2026-10-21T09:00:00Z')
    const a = authServer()
    const h = await startHarness({ now: () => new Date(t), config: { fetch: a.fetchFn, lookup: async () => ['93.184.216.34'] } })
    try {
      const { dev, browser } = await setup(h, a.seen)
      t += 10 * 60_000 + 1
      expect((await h.call('GET', `/oauth/connectors/callback?code=the-code&state=${browser.searchParams.get('state')}`)).status).toBe(400)
      t = Date.parse('2026-10-21T10:00:00Z')
      const again = await h.call('POST', '/v1/companies/co_a/connections/linear/authorize', { token: dev })
      const state = new URL(again.json.authorizeUrl).searchParams.get('state')!
      const other = await h.pair('Other')
      const devId = (await h.call('GET', '/v1/me', { token: dev })).json.device.id
      await h.call('DELETE', `/v1/devices/${devId}`, { token: other })
      expect((await h.call('GET', `/oauth/connectors/callback?code=the-code&state=${state}`)).status).toBe(400)
      // a declined sign-in marks the connection as error and readiness asks to sign in again
      const third = await h.call('POST', '/v1/companies/co_a/connections/linear/authorize', { token: other })
      const s3 = new URL(third.json.authorizeUrl).searchParams.get('state')!
      expect((await h.call('GET', `/oauth/connectors/callback?error=access_denied&state=${s3}`)).status).toBe(400)
      const fix = (await h.call('GET', '/v1/companies', { token: other })).json[0].readiness.fixes.find((f: { kind: string }) => f.kind === 'connection')
      expect(fix).toEqual({ kind: 'connection', ref: 'linear', message: 'Linear needs you to sign in again. Press Authorize.' })
    } finally { await h.close() }
  })

  it('checks the iss parameter when the server advertises it', async () => {
    const a = authServer({ issParam: true })
    const h = await startHarness({ config: { fetch: a.fetchFn, lookup: async () => ['93.184.216.34'] } })
    try {
      const { browser } = await setup(h, a.seen)
      const state = browser.searchParams.get('state')!
      expect((await h.call('GET', `/oauth/connectors/callback?code=the-code&state=${state}&iss=${encodeURIComponent('https://evil.example.com')}`)).status).toBe(400)
      const { browser: b2 } = await (async () => { const dev = await h.pair('x'); const r = await h.call('POST', '/v1/companies/co_a/connections/linear/authorize', { token: dev }); a.seen.challenge = new URL(r.json.authorizeUrl).searchParams.get('code_challenge')!; return { browser: new URL(r.json.authorizeUrl) } })()
      expect((await h.call('GET', `/oauth/connectors/callback?code=the-code&state=${b2.searchParams.get('state')}&iss=${encodeURIComponent(issuer)}`)).status).toBe(200)
    } finally { await h.close() }
  })

  it('validates connection bodies and keeps stored credentials when omitted', async () => {
    const h = await startHarness({ config: { lookup: async () => ['93.184.216.34'] } })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      const put = (id: string, body: unknown) => h.call('PUT', `/v1/companies/co_a/connections/${id}`, { token: dev, body })
      expect((await put('bad id', { name: 'x', transport: 'stdio', command: 'x', enabled: true, authentication: 'none' })).status).toBe(400)
      expect((await put('s', { name: 'x', transport: 'stdio', enabled: true, authentication: 'none' })).status).toBe(400)
      expect((await put('s', { name: 'x', transport: 'stdio', command: 'npx', enabled: true, authentication: 'oauth' })).status).toBe(400)
      const s = await put('s', { name: 'Fal', transport: 'stdio', command: 'fal-mcp', args: ['--x'], enabled: true, authentication: 'headers', credentials: { FAL_KEY: 'fal-value-123456' } })
      expect(s.json).toMatchObject({ id: 's', command: 'fal-mcp', args: ['--x'], hasCredentials: true })
      const kept = await put('s', { name: 'Fal 2', transport: 'stdio', command: 'fal-mcp', enabled: true, authentication: 'headers' })
      expect(kept.json.hasCredentials).toBe(true)
      const cleared = await put('s', { name: 'Fal 2', transport: 'stdio', command: 'fal-mcp', enabled: true, authentication: 'headers', credentials: {} })
      expect(cleared.json.hasCredentials).toBe(false)
      expect((await put('h', { name: 'x', transport: 'http', url: 'http://plain.example.com/mcp', enabled: true, authentication: 'none' })).status).toBe(400)
      // a new address without the headers resent drops them: an old Authorization never reaches another host
      const web = await put('w', { name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/sse', enabled: true, authentication: 'headers', credentials: { Authorization: 'Bearer lin-123456789' } })
      expect(web.json.hasCredentials).toBe(true)
      expect((await put('w', { name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/sse', enabled: true, authentication: 'headers' })).json.hasCredentials).toBe(true)
      expect((await put('w', { name: 'Linear', transport: 'http', url: 'https://other.example.com/mcp', enabled: true, authentication: 'headers' })).json.hasCredentials).toBe(false)
      expect((await put('s', { name: 'Fal 3', transport: 'stdio', command: 'other-mcp', enabled: true, authentication: 'headers', credentials: { FAL_KEY: 'fal-value-123456' } })).json.hasCredentials).toBe(true)
      expect((await put('s', { name: 'Fal 3', transport: 'stdio', command: 'evil-mcp', enabled: true, authentication: 'headers' })).json.hasCredentials).toBe(false)
    } finally { await h.close() }
  })
})

describe('SSRF guard', () => {
  it('classifies private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'not-an-ip']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true])
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:93.184.216.34']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false])
  })

  it('requires https and refuses hosts that resolve to private addresses unless allowlisted', async () => {
    const lookup = async (host: string) => (host === 'internal.corp' ? ['10.0.0.5'] : host === 'rebind.example.com' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34'])
    await expect(guardUrl('https://mcp.example.com/mcp', [], lookup)).resolves.toBeInstanceOf(URL)
    await expect(guardUrl('http://mcp.example.com/mcp', [], lookup)).rejects.toThrow(/https/)
    await expect(guardUrl('https://internal.corp/mcp', [], lookup)).rejects.toThrow(/private network/)
    await expect(guardUrl('https://rebind.example.com/mcp', [], lookup)).rejects.toThrow(/private network/)
    await expect(guardUrl('https://127.0.0.1/mcp', [], lookup)).rejects.toThrow(/private network/)
    await expect(guardUrl('https://[::1]/mcp', [], lookup)).rejects.toThrow(/private network/)
    await expect(guardUrl('https://169.254.169.254/latest', [], lookup)).rejects.toThrow(/private network/)
    await expect(guardUrl('https://user:pw@mcp.example.com/', [], lookup)).rejects.toThrow(/user name/)
    await expect(guardUrl('file:///etc/passwd', [], lookup)).rejects.toThrow(/https/)
    await expect(guardUrl('https://internal.corp/mcp', ['internal.corp'], lookup)).resolves.toBeInstanceOf(URL)
    await expect(guardUrl('http://internal.corp/mcp', ['internal.corp'], lookup)).resolves.toBeInstanceOf(URL)
  })

  it('applies to connection PUTs and every OAuth fetch', async () => {
    const h = await startHarness({ config: { lookup: async host => (host === 'evil.example.com' ? ['192.168.0.10'] : ['93.184.216.34']) } })
    try {
      const dev = await h.pair()
      await h.call('PUT', '/v1/companies/co_a', { token: dev, body: { name: 'A', slug: 'a' } })
      const r = await h.call('PUT', '/v1/companies/co_a/connections/x', { token: dev, body: { name: 'X', transport: 'http', url: 'https://evil.example.com/mcp', enabled: true, authentication: 'none' } })
      expect([r.status, r.json.message]).toEqual([400, expect.stringContaining('private network')])
    } finally { await h.close() }
  })
})
