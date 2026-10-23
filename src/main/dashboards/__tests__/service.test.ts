import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardKeyLookup } from '../../../shared/dashboards'
import { fixtureHttp } from '../fixtures'
import type { HttpFn } from '../http'
import { DashboardService, type DashboardKeyStore } from '../service'

const NOW = new Date('2026-10-23T12:00:00Z')
const KEY = 'rk_live_abcdefghijklmnop'

/** The key store as wire.ts builds it, over two in-memory namespaces. */
function memoryKeys(): DashboardKeyStore & { company: Map<string, string>; shared: Map<string, string>; saved: string[] } {
  const company = new Map<string, string>()
  const shared = new Map<string, string>()
  const saved: string[] = []
  return {
    company,
    shared,
    saved,
    resolve: (names, companyId) => Object.fromEntries(names.flatMap((n) => { const v = company.get(`${companyId}:${n}`) ?? shared.get(n); return v ? [[n, v]] : [] })),
    lookup: (names, companyId): DashboardKeyLookup[] => names.map((name) => (company.has(`${companyId}:${name}`) ? { name, source: 'company', masked: '••••' } : shared.has(name) ? { name, source: 'shared', masked: '••••' } : { name, source: null, masked: null })),
    save: (companyId, name, value) => {
      company.set(`${companyId}:${name}`, value)
      saved.push(name)
    }
  }
}

let db: Database.Database
let keys: ReturnType<typeof memoryKeys>
let enabled = true
let changes: string[] = []
const make = (http: HttpFn = fixtureHttp(() => NOW), extra: Partial<ConstructorParameters<typeof DashboardService>[0]> = {}) =>
  new DashboardService({
    db,
    keys,
    enabled: () => enabled,
    companyExists: (id) => id === 'co_acme' || id === 'co_other',
    departmentCompany: (id) => (id === 'dep_fin' ? 'co_acme' : id === 'dep_x' ? 'co_other' : null),
    http,
    now: () => NOW,
    onChange: (c) => changes.push(c),
    ...extra
  })

beforeEach(() => {
  db = new Database(':memory:')
  keys = memoryKeys()
  enabled = true
  changes = []
})
afterEach(() => db.close())

describe('DashboardService install', () => {
  it('validates with a real call, then saves the pasted key to the company and fetches', async () => {
    const svc = make()
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: { STRIPE_RESTRICTED_KEY: ` ${KEY}\n` } })
    expect(keys.company.get('co_acme:STRIPE_RESTRICTED_KEY')).toBe(KEY)
    expect(d.keys).toEqual([{ name: 'STRIPE_RESTRICTED_KEY', required: true, source: 'company' }])
    const after = await svc.refresh(d.id)
    expect(after.status.state).toBe('ok')
    expect(after.snapshot?.kpis.mrr.value).toBeGreaterThan(0)
    // nothing returned to the renderer carries the value
    expect(JSON.stringify(svc.list('co_acme'))).not.toContain(KEY)
    expect(changes).toContain('co_acme')
  })

  it('stores nothing when validation fails', async () => {
    const svc = make()
    const err = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: { STRIPE_RESTRICTED_KEY: 'rk_live_invalidinvalid' } }).catch((e) => e)
    expect(err.code).toBe('validation')
    expect(err.message).toMatch(/Stripe rejected the key/)
    expect(err.errors[0].path).toBe('keys')
    expect(keys.saved).toEqual([])
    expect(svc.list('co_acme')).toEqual([])
  })

  it('reuses a saved key (Shared) when none is pasted, and requires one when none exists', async () => {
    const svc = make()
    await expect(svc.install({ companyId: 'co_acme', departmentId: null, kind: 'stripe', config: {}, keys: {} })).rejects.toThrow(/Add your Restricted key/)
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    const d = await svc.install({ companyId: 'co_acme', departmentId: null, kind: 'stripe', config: {}, keys: {} })
    expect(d.keys[0].source).toBe('shared')
    expect(keys.saved).toEqual([])
    expect(svc.lookupKeys('co_acme', 'stripe')).toEqual([{ name: 'STRIPE_RESTRICTED_KEY', source: 'shared', masked: '••••' }])
  })

  it('checks config fields, the company and the department', async () => {
    const svc = make()
    await expect(svc.install({ companyId: 'co_acme', departmentId: null, kind: 'gsc', config: {}, keys: {} })).rejects.toThrow(/Property is required/)
    await expect(svc.install({ companyId: 'co_nope', departmentId: null, kind: 'stripe', config: {}, keys: {} })).rejects.toThrow(/Company not found/)
    await expect(svc.install({ companyId: 'co_acme', departmentId: 'dep_x', kind: 'stripe', config: {}, keys: {} })).rejects.toThrow(/Department not found/)
  })

  it('keeps only declared config fields and caps lists', () => {
    const svc = make()
    const def = { id: 'geo', config: [{ key: 'prompts', label: 'Prompts', required: true, kind: 'list', max: 2 }, { key: 'brand', label: 'Brand', required: true, kind: 'text' }] } as never
    expect(svc.cleanConfig(def, { brand: ' Acme ', prompts: 'a\nb\nc', evil: 'x' })).toEqual({ brand: 'Acme', prompts: ['a', 'b'] })
  })

  it('refuses everything while the departments flags are off', async () => {
    enabled = false
    const svc = make()
    await expect(svc.install({ companyId: 'co_acme', departmentId: null, kind: 'stripe', config: {}, keys: {} })).rejects.toThrow(/Experimental/)
    expect(svc.contextFor('co_acme', 'dep_fin')).toBeNull()
  })
})

describe('DashboardService refresh', () => {
  it('keeps the last good snapshot when a refresh fails, and records the error code', async () => {
    let fail = false
    const real = fixtureHttp(() => NOW)
    const svc = make(async (req) => (fail ? { status: 429, body: null, retryAfter: '60' } : real(req)))
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    const good = await svc.refresh(d.id)
    fail = true
    const bad = await svc.refresh(d.id)
    expect(bad.status).toMatchObject({ state: 'error', code: 'rate_limited' })
    expect(bad.snapshot).toEqual(good.snapshot)
  })

  it('a removed key turns into a config error on the next refresh', async () => {
    const svc = make()
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    await svc.refresh(d.id) // the first fetch install started
    keys.shared.clear()
    const r = await svc.refresh(d.id)
    expect(r.status).toMatchObject({ state: 'error', code: 'config' })
    expect(r.keys[0].source).toBeNull()
  })

  it('joins a refresh that is already running', async () => {
    let calls = 0
    const real = fixtureHttp(() => NOW)
    const svc = make(async (req) => {
      if (new URL(req.url).pathname.endsWith('/subscriptions') && !req.url.includes('limit=1&')) calls++
      return real(req)
    })
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    await Promise.all([svc.refresh(d.id), svc.refresh(d.id)])
    const before = calls
    await Promise.all([svc.refresh(d.id), svc.refresh(d.id)])
    expect(calls - before).toBeLessThanOrEqual(2)
  })

  it('is due on its interval, later after an error', async () => {
    const svc = make()
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    await svc.refresh(d.id)
    const row = svc.store.get(d.id)
    expect(svc.due(row, new Date(NOW.getTime() + 30 * 60_000))).toBe(false)
    expect(svc.due(row, new Date(NOW.getTime() + 61 * 60_000))).toBe(true)
    const errored = { ...row, status: { state: 'error' as const, code: 'invalid_key' as const } }
    expect(svc.due(errored, new Date(NOW.getTime() + 61 * 60_000))).toBe(false)
    expect(svc.due(errored, new Date(NOW.getTime() + 6 * 60 * 60_000 + 1))).toBe(true)
  })

  it('tick refreshes what is due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const svc = make()
      keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
      const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
      await svc.refresh(d.id)
      svc.store.recordFetch(d.id, { state: 'never' })
      db.prepare('UPDATE company_dashboards SET fetched_at = ? WHERE id = ?').run('2026-10-20T00:00:00.000Z', d.id)
      await svc.tick()
      expect(svc.store.get(d.id).fetchedAt).toBe(NOW.toISOString())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DashboardService sample and agent context', () => {
  it('previews every catalog dashboard on sample data', async () => {
    const svc = make(async () => {
      throw new Error('the preview must never call the network')
    })
    for (const kind of ['gsc', 'geo', 'plausible', 'posthog', 'stripe', 'github'] as const) {
      const s = await svc.sample(kind)
      expect(s.sample, kind).toBe(true)
      expect(Object.keys(s.kpis).length, kind).toBeGreaterThan(2)
    }
    expect((await svc.sample('geo')).series.trend[0].points.length).toBeGreaterThan(5)
  })

  it('fixture mode accepts any key but still shows the invalid-key state', async () => {
    const svc = make(async () => {
      throw new Error('no network in fixture mode')
    }, { fixtures: true })
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    expect((await svc.refresh(d.id)).snapshot?.sample).toBe(true)
    await expect(svc.install({ companyId: 'co_acme', departmentId: null, kind: 'plausible', config: { siteId: 'a.com' }, keys: { PLAUSIBLE_API_KEY: 'invalid' } })).rejects.toThrow(/rejected the key/)
  })

  it('summarises the department’s latest numbers for its agents, without keys', async () => {
    const svc = make()
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    expect(svc.contextFor('co_acme', 'dep_fin')).toBeNull()
    await svc.refresh(d.id)
    const text = svc.contextFor('co_acme', 'dep_fin')!
    expect(text).toMatch(/^## Department dashboards/)
    expect(text).toMatch(/Revenue · Stripe/)
    expect(text).toMatch(/MRR \$[\d,.]+K?/)
    expect(text).toMatch(/Churn rate/)
    expect(text).not.toContain(KEY)
    expect(svc.contextFor('co_acme', 'dep_other')).toBeNull()
  })

  it('remove deletes the dashboard but leaves the key', async () => {
    const svc = make()
    const d = await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: { STRIPE_RESTRICTED_KEY: KEY } })
    svc.remove(d.id)
    expect(svc.list('co_acme')).toEqual([])
    expect(keys.company.get('co_acme:STRIPE_RESTRICTED_KEY')).toBe(KEY)
    expect(() => svc.get(d.id)).toThrow(/not found/)
  })

  it('lists by department, company-level only, or all', async () => {
    const svc = make()
    keys.shared.set('STRIPE_RESTRICTED_KEY', KEY)
    await svc.install({ companyId: 'co_acme', departmentId: 'dep_fin', kind: 'stripe', config: {}, keys: {} })
    await svc.install({ companyId: 'co_acme', departmentId: null, kind: 'stripe', config: {}, keys: {} })
    expect(svc.list('co_acme')).toHaveLength(2)
    expect(svc.list('co_acme', 'dep_fin')).toHaveLength(1)
    expect(svc.list('co_acme', null)).toHaveLength(1)
    expect(svc.list('co_other')).toHaveLength(0)
  })
})
