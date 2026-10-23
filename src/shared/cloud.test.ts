import { describe, expect, it } from 'vitest'
import { CLOUD_ADAPTERS, CLOUD_ROUTES, DEFAULT_QUOTAS, NOT_IN_V1_ROUTES, PAIRING_ALPHABET, formatConnectLink, parseConnectLink, PROVIDER_CREDENTIAL_KINDS, SUBSCRIPTION_KINDS, routeMethod, routePath, type CloudRouteName } from './cloud'

describe('cloud contract', () => {
  it('builds paths with encoded params and refuses missing ones', () => {
    expect(routePath('runCancel', { id: 'crun_1' })).toBe('/v1/runs/crun_1/cancel')
    expect(routePath('secretPut', { cid: 'co_a', name: 'A B' })).toBe('/v1/companies/co_a/secrets/A%20B')
    expect(() => routePath('run')).toThrow(/missing :id/)
    expect(routeMethod('workflowPut')).toBe('PUT')
  })

  it('has one unique method+path per route, all versioned or explicitly public', () => {
    const values = Object.values(CLOUD_ROUTES)
    expect(new Set(values).size).toBe(values.length)
    for (const name of Object.keys(CLOUD_ROUTES) as CloudRouteName[]) {
      const [method, path] = CLOUD_ROUTES[name].split(' ')
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(method)
      expect(path!.startsWith('/v1/') || path!.startsWith('/hooks/') || path!.startsWith('/oauth/') || path!.startsWith('/console/')).toBe(true)
    }
  })

  it('maps every cloud adapter to credential kinds, and subscription kinds to real kinds', () => {
    const all = CLOUD_ADAPTERS.flatMap((a) => PROVIDER_CREDENTIAL_KINDS[a])
    expect(new Set(all).size).toBe(all.length)
    for (const k of SUBSCRIPTION_KINDS) expect(all).toContain(k)
  })

  it('pairing alphabet avoids look-alike characters', () => {
    for (const c of '01OI') expect(PAIRING_ALPHABET).not.toContain(c)
    expect(new Set(PAIRING_ALPHABET).size).toBe(PAIRING_ALPHABET.length)
  })

  it('default quotas are conservative', () => {
    expect(DEFAULT_QUOTAS.maxConcurrentRuns).toBeLessThanOrEqual(4)
    expect(DEFAULT_QUOTAS.runTimeoutMinutes).toBeLessThanOrEqual(1440)
  })
})

describe('connect link (CLOUD.md §5)', () => {
  it('formats the url and code into one string', () => {
    expect(formatConnectLink('https://cloud.example.com/', 'k7qm4xwd')).toBe('https://cloud.example.com/pair#K7QM-4XWD')
    expect(formatConnectLink('http://127.0.0.1:8787', 'K7QM-4XWD')).toBe('http://127.0.0.1:8787/pair#K7QM-4XWD')
  })

  it('parses the link back, tolerating whitespace, a missing /pair, lowercase and a missing dash', () => {
    const want = { url: 'https://cloud.example.com', code: 'K7QM-4XWD' }
    expect(parseConnectLink('https://cloud.example.com/pair#K7QM-4XWD')).toEqual(want)
    expect(parseConnectLink('  https://cloud.example.com/pair#K7QM-4XWD\n')).toEqual(want)
    expect(parseConnectLink('https://cloud.example.com#K7QM-4XWD')).toEqual(want)
    expect(parseConnectLink('https://cloud.example.com/pair/#k7qm4xwd')).toEqual(want)
    expect(parseConnectLink('https://cloud.example.com/pair# K7QM 4XWD')).toEqual(want)
    expect(parseConnectLink('https://box.tail.ts.net/principia/pair#K7QM-4XWD')).toEqual({ url: 'https://box.tail.ts.net/principia', code: 'K7QM-4XWD' })
    expect(parseConnectLink(formatConnectLink('http://localhost:8787', '23456789'))).toEqual({ url: 'http://localhost:8787', code: '2345-6789' })
  })

  it('refuses links without a valid code or url', () => {
    expect(parseConnectLink('https://cloud.example.com/pair')).toBeNull()
    expect(parseConnectLink('https://cloud.example.com/pair#K7QM-4XW')).toBeNull()
    expect(parseConnectLink('https://cloud.example.com/pair#K7QM-4XW0')).toBeNull()
    expect(parseConnectLink('cloud.example.com/pair#K7QM-4XWD')).toBeNull()
    expect(parseConnectLink('javascript:alert(1)#K7QM-4XWD')).toBeNull()
    expect(parseConnectLink('')).toBeNull()
  })

  it('lists only real routes as not in v1', () => {
    for (const r of NOT_IN_V1_ROUTES) expect(CLOUD_ROUTES[r]).toBeDefined()
    expect(NOT_IN_V1_ROUTES).toContain('hookIngress')
    expect(NOT_IN_V1_ROUTES).not.toContain('runStart')
  })
})
