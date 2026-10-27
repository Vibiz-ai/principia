import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GatewayConnection } from '../../../shared/gateway'
import type { KeyPresence } from '../../../shared/services'
import { ConnectionResolver, type ResolverDeps } from '../resolver'
import { ConnectionStore } from '../store'
import { connectionsReport } from '../../company/connectionsReport'
import { resolveWithAliases } from '../resolveAliases'

const A = 'co_acme'
const B = 'co_beta'
const PH_KEY = 'phx_supersecretvalue_123456'

/** Keys per company as the vault and company_secrets would hold them (values only ever read in main). */
let values: Record<string, Record<string, string>>
let shared: Record<string, string>
let gateway: GatewayConnection[]
let db: Database.Database
let store: ConnectionStore
let make: (extra?: Partial<ResolverDeps>) => ConnectionResolver

const presence = (companyId: string): KeyPresence[] => {
  const out = new Map<string, KeyPresence>()
  for (const n of Object.keys(shared)) out.set(n, { name: n, source: 'shared', masked: '••••' + shared[n].slice(-4) })
  for (const n of Object.keys(values[companyId] ?? {})) out.set(n, { name: n, source: 'company', masked: '••••' + values[companyId][n].slice(-4) })
  return [...out.values()]
}

beforeEach(() => {
  db = new Database(':memory:')
  store = new ConnectionStore(db, () => new Date('2026-10-26T10:00:00Z'))
  values = { [A]: {}, [B]: {} }
  shared = {}
  gateway = []
  make = (extra = {}) =>
    new ConnectionResolver({
      store,
      company: (id) => (id === A ? { id, name: 'Acme' } : id === B ? { id, name: 'Beta' } : id === 'co_me' ? { id, name: 'Personal', personal: true } : null),
      companies: () => [{ id: A, name: 'Acme' }, { id: B, name: 'Beta' }, { id: 'co_me', name: 'Personal', personal: true }],
      keyNames: presence,
      keyValues: (names, companyId) => Object.fromEntries(names.flatMap((n) => { const v = values[companyId]?.[n] ?? shared[n]; return v ? [[n, v]] : [] })),
      gateway: () => gateway,
      slack: () => 'none',
      linear: () => ({ connected: false, problem: null }),
      ...extra
    })
})
afterEach(() => db.close())

describe('ConnectionResolver', () => {
  it('a key saved for one company makes the service connected there, nowhere else, and status never carries the value', () => {
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    const r = make()
    const a = r.status(A, 'posthog')
    expect(a.state).toBe('connected')
    expect(a.link).toBe(`principia://connect/posthog?company=${A}`)
    expect(r.status(B, 'posthog').state).toBe('notConnected')
    expect(JSON.stringify(r.list(A))).not.toContain(PH_KEY)
    expect(r.isConnected(A, 'posthog', 'dashboard')).toBe(true)
    expect(r.isConnected(B, 'posthog')).toBe(false)
  })

  it('contextBlock: chats learn what is connected and how they reach it, by name only', () => {
    const r = make()
    expect(r.contextBlock(A)).toBeNull()
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    const text = r.contextBlock(A)!
    expect(text).toContain('## Connected services')
    expect(text).toContain('PostHog (Principia\'s tools (principia_list_tools, connection svc:posthog); env POSTHOG_PERSONAL_API_KEY')
    expect(text).toContain('Do not ask the founder to connect them again')
    expect(text).not.toContain(PH_KEY)
    expect(r.contextBlock(B)).toBeNull()
  })

  it('checks refuse patterns on the value in main: a PostHog project key needs attention', () => {
    values[A].POSTHOG_PERSONAL_API_KEY = 'phc_projectkeyonly_1234'
    const st = make().status(A, 'posthog')
    expect(st.state).toBe('attention')
    expect(st.forms[0].problem).toContain('project key')
    expect(JSON.stringify(st)).not.toContain('phc_projectkeyonly_1234')
  })

  it('credentialsFor gives the values for a purpose (main only), folding an older key name', () => {
    values[A].POSTHOG_API_KEY = PH_KEY
    store.patch(A, 'posthog', { settings: { projectId: '42', host: 'https://eu.posthog.com' } })
    const r = make()
    expect(r.credentialsFor(A, 'posthog', 'dashboard')).toEqual({ via: 'key', values: { POSTHOG_PERSONAL_API_KEY: PH_KEY }, settings: { projectId: '42', host: 'https://eu.posthog.com' } })
    expect(() => r.credentialsFor(B, 'posthog', 'dashboard')).toThrow(/principia:\/\/connect\/posthog\?purpose=dashboard/)
  })

  it('virtuals: a key the vendor MCP takes as a bearer becomes a key-backed connection, built at call time', () => {
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    const r = make()
    const [v] = r.virtuals(A)
    expect(v).toMatchObject({ id: 'svc:posthog', serviceId: 'posthog', url: 'https://mcp.posthog.com/mcp' })
    expect(v.headers()).toEqual({ Authorization: `Bearer ${PH_KEY}` })
    expect(JSON.stringify(v)).not.toContain(PH_KEY)
    // the key changes: a new fingerprint; it goes: the header refuses
    const before = v.fingerprint
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY + 'x'
    expect(r.virtuals(A)[0].fingerprint).not.toBe(before)
    delete values[A].POSTHOG_PERSONAL_API_KEY
    expect(r.virtuals(A)).toEqual([])
    expect(() => v.headers()).toThrow()
    // a real sign-in to the same service replaces it
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    gateway = [{ id: 'ph', name: 'PostHog', transport: 'http', url: 'https://mcp.posthog.com/mcp', enabled: true, roots: [], scope: 'global', companyIds: [A], authentication: 'oauth', authStatus: 'connected', hasCredentials: false }]
    expect(r.virtuals(A)).toEqual([])
    // no virtual for a service whose MCP is OAuth only (Sentry), nor without a company
    values[A].SENTRY_AUTH_TOKEN = 'sntryu_abcdef'
    expect(r.virtuals(A).map((x) => x.serviceId)).not.toContain('sentry')
    expect(r.virtuals(null)).toEqual([])
  })

  it('reuse ("Also use in…"): reads the source company’s key by reference; stopping it disconnects', () => {
    values[A].PLAUSIBLE_API_KEY = 'plausible-secret-1'
    store.patch(A, 'plausible', { settings: { siteId: 'acme.com' } })
    const r = make()
    expect(r.status(B, 'plausible').state).toBe('notConnected')
    r.reuse(B, 'plausible', A)
    const st = r.status(B, 'plausible')
    expect(st.state).toBe('connected')
    expect(st.sharedFrom).toEqual({ companyId: A, name: 'Acme' })
    expect(st.settings.siteId).toBe('acme.com')
    expect(r.credentialsFor(B, 'plausible', 'dashboard')).toMatchObject({ values: { PLAUSIBLE_API_KEY: 'plausible-secret-1' } })
    // nothing was copied into B's keys
    expect(values[B]).toEqual({})
    expect(() => r.reuse(B, 'plausible', B)).toThrow()
    expect(() => r.reuse(B, 'plausible', 'co_me')).toThrow(/Personal/)
    r.reuse(B, 'plausible', null)
    expect(r.status(B, 'plausible').state).toBe('notConnected')
  })

  it('reuse reaches a gateway connection limited to the source company', () => {
    gateway = [{ id: 'notion-a', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true, roots: [], scope: 'global', companyIds: [A], authentication: 'oauth', authStatus: 'connected', hasCredentials: false }]
    const r = make()
    expect(r.reusedConnectionReaches('notion-a', B)).toBe(false)
    r.reuse(B, 'notion', A)
    expect(r.reusedConnectionReaches('notion-a', B)).toBe(true)
    expect(r.status(B, 'notion').state).toBe('connected')
  })

  it('chooseKey only accepts a key of that service that serves the purpose', () => {
    const r = make()
    r.chooseKey(A, 'stripe', 'agentTools', 'STRIPE_AGENT_API_KEY')
    expect(store.get(A, 'stripe')?.keyChoice).toEqual({ agentTools: 'STRIPE_AGENT_API_KEY' })
    expect(() => r.chooseKey(A, 'stripe', 'dashboard', 'STRIPE_SECRET_KEY')).toThrow()
    expect(() => r.chooseKey(A, 'stripe', 'agentTools', 'POSTHOG_PERSONAL_API_KEY')).toThrow()
  })

  it('usage feeds "Used by" and a failing usage source never breaks status', () => {
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    const r = make({ usage: () => [{ kind: 'dashboard', label: 'Marketing dashboard' }, { kind: 'agents', label: '3 agents' }] })
    expect(r.status(A, 'posthog').usedBy.map((u) => u.label)).toEqual(['Marketing dashboard', '3 agents'])
    expect(r.list(A, { usage: false }).find((s) => s.serviceId === 'posthog')!.usedBy).toEqual([])
    const broken = make({ usage: () => { throw new Error('boom') } })
    expect(broken.status(A, 'posthog').usedBy).toEqual([])
  })

  it('refuses unknown services and companies', () => {
    const r = make()
    expect(() => r.status(A, 'nope')).toThrow(/Unknown service/)
    expect(() => r.status('co_gone', 'posthog')).toThrow(/Company not found/)
  })
})

describe('migration (derive, never move)', () => {
  it('links existing MCP connections and dashboard settings, is idempotent, and changes no key or connection', () => {
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    gateway = [
      { id: 'stripe-a', name: 'Stripe', transport: 'http', url: 'https://mcp.stripe.com', enabled: true, roots: [], scope: 'global', companyIds: [A], authentication: 'oauth', authStatus: 'connected', hasCredentials: false },
      { id: 'notion-all', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true, roots: [], scope: 'global', authentication: 'oauth', authStatus: 'connected', hasCredentials: false },
      { id: 'crm', name: 'Their CRM', transport: 'http', url: 'https://crm.example.com/mcp', enabled: true, roots: [], scope: 'global', companyIds: [A], authentication: 'none', hasCredentials: true }
    ]
    const dashboards: { companyId: string; kind: string; config: Record<string, string> }[] = [{ companyId: A, kind: 'posthog', config: { projectId: '42', host: 'https://us.posthog.com' } }, { companyId: 'co_gone', kind: 'plausible', config: { siteId: 'x.com' } }]
    const before = JSON.stringify({ values, shared, gateway })
    const r = make()
    const first = r.backfill([A, B], dashboards)
    expect(first).toEqual({ companies: 2, links: 3, settings: 1 })
    expect(store.get(A, 'stripe')?.mcpConnectionId).toBe('stripe-a')
    // a connection saved before companies reaches every company, and keeps doing so
    expect(store.get(B, 'notion')?.mcpConnectionId).toBe('notion-all')
    expect(store.get(B, 'stripe')).toBeNull()
    expect(store.get(A, 'posthog')?.settings).toEqual({ projectId: '42', host: 'https://us.posthog.com' })
    // idempotent, and what it read is untouched
    expect(r.backfill([A, B], dashboards)).toEqual({ companies: 2, links: 0, settings: 0 })
    expect(JSON.stringify({ values, shared, gateway })).toBe(before)
    // a setting the founder changed is not overwritten by a later backfill
    store.patch(A, 'posthog', { settings: { projectId: '7' } })
    r.backfill([A], dashboards)
    expect(store.get(A, 'posthog')?.settings.projectId).toBe('7')
  })

  it('an older build’s data keeps working: dashboards read the old key name through the alias', () => {
    const resolve = (names: string[], companyId: string): Record<string, string> => Object.fromEntries(names.flatMap((n) => { const v = values[companyId]?.[n]; return v ? [[n, v]] : [] }))
    values[A].POSTHOG_API_KEY = 'phx_old_name_key'
    expect(resolveWithAliases(resolve, ['POSTHOG_PERSONAL_API_KEY'], A)).toEqual({ POSTHOG_PERSONAL_API_KEY: 'phx_old_name_key' })
    expect(resolveWithAliases(resolve, ['STRIPE_RESTRICTED_KEY'], A)).toEqual({})
  })
})

describe('connections_list on the resolver', () => {
  it('lists a key-only service as connected, with how the agent has it, and offers PostHog when missing', () => {
    values[A].POSTHOG_PERSONAL_API_KEY = PH_KEY
    values[A].STRIPE_SECRET_KEY = 'sk_live_abcdef123456'
    const r = make()
    const report = connectionsReport({ companyId: A, companyName: 'Acme', gateway: [], slack: 'none', linear: false, services: r.list(A, { usage: false }) })
    const ph = report.connected.find((c) => c.tool === 'posthog')!
    expect(ph).toMatchObject({ status: 'connected', env: ['POSTHOG_PERSONAL_API_KEY'] })
    expect(ph.via).toEqual(expect.arrayContaining(['key', 'mcp']))
    expect(ph.note).toContain('svc:posthog')
    // Stripe had a "not connected" card row; its secret key now counts
    expect(report.connected.find((c) => c.tool === 'stripe')).toMatchObject({ status: 'connected', env: ['STRIPE_SECRET_KEY'] })
    expect(report.missing.find((c) => c.tool === 'stripe')).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain(PH_KEY)
    const other = connectionsReport({ companyId: B, companyName: 'Beta', gateway: [], slack: 'none', linear: false, services: r.list(B, { usage: false }) })
    expect(other.missing.find((c) => c.tool === 'posthog')).toMatchObject({ status: 'not_connected', link: `principia://connect/posthog?company=${B}` })
  })
})
