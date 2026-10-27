/**
 * CONN-QA-01: a key pasted outside a dashboard is checked even before the dashboard's settings are known (PostHog: who
 * the key belongs to, US then EU), and a check of a key the company already has reports its verdict to the connection.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DashboardFetchError, getJson, type HttpFn, type HttpReq } from '../http'
import { DashboardService, type DashboardKeyStore } from '../service'

const NOW = new Date('2026-10-27T12:00:00Z')
const KEY = 'phx_fake_value_for_tests_0002'
let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
})
afterEach(() => db.close())

const keys = (saved: Record<string, string> = {}): DashboardKeyStore => ({ resolve: (names) => Object.fromEntries(names.filter((n) => saved[n]).map((n) => [n, saved[n]!])), lookup: (names) => names.map((name) => ({ name, source: saved[name] ? 'company' : null, masked: null })), save: () => undefined })
const http = (answer: (r: HttpReq) => number, seen: string[] = []): HttpFn => async (r) => {
  seen.push(r.url)
  const status = answer(r)
  if (status === 0) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  return { status, body: status === 200 ? { id: 1 } : { detail: 'Invalid' }, retryAfter: null }
}
const make = (h: HttpFn, k = keys(), verdicts: string[] = []): DashboardService =>
  new DashboardService({ db, keys: k, enabled: () => true, companyExists: () => true, departmentCompany: () => 'co_a', http: h, now: () => NOW, onKeyVerdict: (_c, def, v) => verdicts.push(`${def.id}:${v.ok ? 'ok' : v.code}`) })

describe('PostHog key check without a project', () => {
  it('a key that works in the US cloud is checked and keeps the US host', async () => {
    const seen: string[] = []
    const r = await make(http(() => 200, seen)).checkKeys('posthog', 'co_a', { POSTHOG_PERSONAL_API_KEY: KEY }, {})
    expect(r).toEqual({ checked: 'ok', settings: { host: 'https://us.posthog.com' } })
    expect(seen).toEqual(['https://us.posthog.com/api/users/@me/'])
  })
  it('an EU key: the US cloud turns it down, the EU one takes it, and the EU host is found', async () => {
    const r = await make(http((q) => (q.url.startsWith('https://us.') ? 401 : 200))).checkKeys('posthog', 'co_a', { POSTHOG_PERSONAL_API_KEY: KEY }, {})
    expect(r).toEqual({ checked: 'ok', settings: { host: 'https://eu.posthog.com' } })
  })
  it('a fake key is turned down in both and nothing is saved', async () => {
    await expect(make(http(() => 401)).checkKeys('posthog', 'co_a', { POSTHOG_PERSONAL_API_KEY: KEY }, {})).rejects.toThrow(/rejected the key/)
  })
  it('a vendor that can’t be reached saves the key as not checked', async () => {
    const r = await make(http(() => 503)).checkKeys('posthog', 'co_a', { POSTHOG_PERSONAL_API_KEY: KEY }, {})
    expect(r.checked).toBe('unchecked')
  })
  it('with the project known, the dashboard’s own check runs', async () => {
    const seen: string[] = []
    await make(http(() => 200, seen)).checkKeys('posthog', 'co_a', { POSTHOG_PERSONAL_API_KEY: KEY }, { projectId: '42', host: 'https://eu.posthog.com' })
    expect(seen).toEqual(['https://eu.posthog.com/api/projects/42/'])
  })
})

describe('Add dashboard with the company’s saved key', () => {
  it('a turned-down saved key is reported to the connection; a pasted one is not', async () => {
    const verdicts: string[] = []
    const svc = make(http(() => 401), keys({ POSTHOG_PERSONAL_API_KEY: KEY }), verdicts)
    await expect(svc.install({ companyId: 'co_a', departmentId: null, kind: 'posthog', config: { projectId: '42' }, keys: {} })).rejects.toThrow()
    expect(verdicts).toEqual(['posthog:invalid_key'])
    await expect(svc.install({ companyId: 'co_a', departmentId: null, kind: 'posthog', config: { projectId: '42' }, keys: { POSTHOG_PERSONAL_API_KEY: 'phx_other_fake_0003' } })).rejects.toThrow()
    expect(verdicts).toEqual(['posthog:invalid_key'])
  })
})

describe('a 403 that says the key is invalid is a turned-down key', () => {
  it('PostHog: "Personal API key found in request Authorization header is invalid." → invalid_key', async () => {
    const codeOf = async (detail: string): Promise<string> => {
      const h: HttpFn = async () => ({ status: 403, body: { detail }, retryAfter: null })
      try {
        await getJson(h, { url: 'https://us.posthog.com/api/projects/1/' }, { provider: 'PostHog', secrets: [] })
        return 'ok'
      } catch (e) {
        return e instanceof DashboardFetchError ? e.code : 'other'
      }
    }
    expect(await codeOf('Personal API key found in request Authorization header is invalid.')).toBe('invalid_key')
    expect(await codeOf('You do not have permission to perform this action.')).toBe('forbidden')
  })
})
