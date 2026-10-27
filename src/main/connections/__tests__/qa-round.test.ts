/**
 * The connections QA round (CONN-QA, QP, SEC): identity by exact URL only, keys checked and turned down on every
 * surface, reuse that cannot redirect a lent key, and nothing an agent profile may not read.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GatewayConnection } from '../../../shared/gateway'
import { checkSetting, serviceById, type KeyPresence } from '../../../shared/services'
import { ConnectionResolver, type ResolverDeps } from '../resolver'
import { ConnectionStore } from '../store'

const A = 'co_ledger'
const B = 'co_pine'
const ME = 'co_me'
const PH = 'phx_fake_value_for_tests_0001'

let values: Record<string, Record<string, string>>
let gateway: GatewayConnection[]
let db: Database.Database
let store: ConnectionStore
let make: (extra?: Partial<ResolverDeps>) => ConnectionResolver

const presence = (companyId: string): KeyPresence[] => Object.keys(values[companyId] ?? {}).map((n) => ({ name: n, source: 'company', masked: '••••' + values[companyId]![n]!.slice(-4) }))
const conn = (p: Partial<GatewayConnection>): GatewayConnection => ({ id: 'c1', name: 'X', transport: 'http', enabled: true, roots: [], scope: 'global', companyIds: [A], authentication: 'oauth', authStatus: 'connected', hasCredentials: false, ...p })

beforeEach(() => {
  db = new Database(':memory:')
  store = new ConnectionStore(db, () => new Date('2026-10-27T10:00:00Z'))
  values = { [A]: {}, [B]: {}, [ME]: {} }
  gateway = []
  const companies = [{ id: A, name: 'Ledgerline' }, { id: B, name: 'Pinecone Coffee' }, { id: ME, name: 'Personal', personal: true }]
  make = (extra = {}) =>
    new ConnectionResolver({
      store,
      company: (id) => companies.find((c) => c.id === id) ?? null,
      companies: () => companies,
      keyNames: presence,
      keyValues: (names, companyId) => Object.fromEntries(names.flatMap((n) => (values[companyId]?.[n] ? [[n, values[companyId]![n]!]] : []))),
      gateway: () => gateway,
      slack: () => 'none',
      linear: () => ({ connected: false, problem: null }),
      ...extra
    })
})
afterEach(() => db.close())

describe('SEC-1 / SEC-2: a connection is a service only by its exact https URL', () => {
  it('a look-alike named "PostHog insights" at another host connects nothing, is only suggested, and never feeds a dashboard', () => {
    gateway = [conn({ id: 'spoof', name: 'PostHog insights (community)', url: 'https://evil.example/mcp', authentication: 'none', authStatus: undefined })]
    const r = make()
    const st = r.status(A, 'posthog')
    expect(st.state).toBe('notConnected')
    expect(st.suggested).toEqual([{ connectionId: 'spoof', name: 'PostHog insights (community)', host: 'evil.example' }])
    // backfill never links it
    r.backfill([A], [])
    expect(store.get(A, 'posthog')?.mcpConnectionId ?? null).toBeNull()
    // the founder confirms it: agent tools only, never the dashboard or session links, and the sheet names the host
    r.confirmConnection(A, 'posthog', 'spoof')
    const after = r.status(A, 'posthog')
    expect(after.state).toBe('connected')
    expect(after.purposes.agentTools?.ok).toBe(true)
    expect(after.purposes.dashboard?.ok).toBe(false)
    expect(after.purposes.sessionReplay?.ok).toBe(false)
    expect(after.forms[0]).toMatchObject({ exact: false, host: 'evil.example' })
    expect(r.disconnectPlan(A, 'posthog', () => false).connections.map((c) => c.id)).toEqual(['spoof'])
  })
  it('an older link made by name (before exact URLs) no longer counts, and plain http never matches', () => {
    gateway = [conn({ id: 'old', name: 'my posthog', url: 'http://mcp.posthog.com/mcp' })]
    store.patch(A, 'posthog', { mcpConnectionId: 'old' })
    expect(make().status(A, 'posthog').state).toBe('notConnected')
  })
  it('Dropbox or Box is not X: no status, no suggestion, nothing to disconnect', () => {
    gateway = [conn({ id: 'dbx', name: 'Dropbox', url: 'https://mcp.dropbox.com/mcp' }), conn({ id: 'box', name: 'Box', url: 'https://mcp.box.com/' }), conn({ id: 'xm', name: 'my x-mcp thing', url: 'https://tools.example/mcp' })]
    const st = make().status(A, 'x')
    expect(st.state).toBe('notConnected')
    expect(st.suggested).toBeUndefined()
  })
  it('the real PostHog URL counts and is exact', () => {
    gateway = [conn({ id: 'ph', name: 'Anything', url: 'https://mcp.posthog.com/mcp' })]
    expect(make().status(A, 'posthog').forms[0]).toMatchObject({ kind: 'mcp', exact: true, auth: 'oauth', detail: 'Anything (mcp.posthog.com) · connected' })
  })
})

describe('SEC-3: a Stripe secret key is never an agent key', () => {
  it('sk_live_ under STRIPE_AGENT_API_KEY needs attention and builds no MCP connection', () => {
    values[A]!.STRIPE_AGENT_API_KEY = 'sk_live_fake_value_000000000001'
    const r = make()
    const st = r.status(A, 'stripe')
    expect(st.state).toBe('attention')
    expect(st.forms[0]!.problem).toContain('secret key')
    expect(r.virtuals(A)).toEqual([])
  })
})

describe('keys turned down show everywhere (CONN-QA-01, QP-5, QP-7)', () => {
  it('a rejection recorded from an add-dashboard check or an agent call puts the service in Needs attention; a new key clears it', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    r.recordKeyProblem(A, 'posthog', 'POSTHOG_PERSONAL_API_KEY', 'PostHog turned down the key.')
    expect(r.status(A, 'posthog')).toMatchObject({ state: 'attention', chip: 'Needs attention' })
    expect(r.virtuals(A)).toEqual([])
    expect(r.clearKeyProblems(A, 'posthog', ['POSTHOG_PERSONAL_API_KEY'])).toBe(true)
    expect(r.status(A, 'posthog').state).toBe('connected')
  })
  it('QP-7: a problem recorded under the dashboard key name marks a key saved under its older name', () => {
    values[A]!.POSTHOG_API_KEY = PH
    const r = make({ keyProblems: () => ({ POSTHOG_PERSONAL_API_KEY: 'PostHog turned down the key on 27 Oct.' }) })
    expect(r.status(A, 'posthog').state).toBe('attention')
  })
  it('QP-5: a missing dashboard permission marks only the dashboard; agents keep the tools from the key', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make({ scopeProblems: () => ({ POSTHOG_PERSONAL_API_KEY: { dashboard: 'PostHog accepted the key but it can’t read what the dashboard needs.' } }) })
    const st = r.status(A, 'posthog')
    expect(st.state).toBe('connected')
    expect(st.purposes.dashboard).toMatchObject({ ok: false, why: expect.stringContaining('can’t read what the dashboard needs') })
    expect(st.purposes.agentTools?.ok).toBe(true)
    expect(r.virtuals(A).map((v) => v.id)).toEqual(['svc:posthog'])
  })
})

describe('QP-6: PostHog EU', () => {
  it('the key-backed connection uses the EU MCP address when the host is the EU cloud', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    r.settings(A, 'posthog', { host: 'https://eu.posthog.com' })
    expect(r.virtuals(A)[0]!.url).toBe('https://mcp-eu.posthog.com/mcp')
    r.settings(A, 'posthog', { host: 'https://us.posthog.com' })
    expect(r.virtuals(A)[0]!.url).toBe('https://mcp.posthog.com/mcp')
  })
})

describe('SEC-5 / QP-3 / QP-10: older key names', () => {
  it('Disconnect removes a key saved under its older name and names it', () => {
    values[A]!.POSTHOG_API_KEY = PH
    const plan = make().disconnectPlan(A, 'posthog', (n) => !!values[A]![n])
    expect(plan.keys).toEqual(['POSTHOG_API_KEY'])
  })
  it('the virtual connection names the key actually found', () => {
    values[A]!.POSTHOG_API_KEY = PH
    const st = make().status(A, 'posthog')
    expect(st.forms.find((f) => f.virtual)!.detail).toBe('with POSTHOG_API_KEY')
  })
})

describe('reuse ("Also use in…")', () => {
  it('SEC-7: Personal never reads a company connection, and a company with nothing to lend is refused', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    expect(() => r.reuse(ME, 'posthog', A)).toThrow(/Personal/)
    expect(() => r.reuse(A, 'github', B)).toThrow(/no GitHub connection of its own/)
  })
  it('QA-07 / QA-06: the other company is offered as a source; once used, the lender lists it and the plan names it', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    expect(r.sources(B, 'posthog')).toEqual([{ companyId: A, name: 'Ledgerline' }])
    r.reuse(B, 'posthog', A)
    expect(r.status(A, 'posthog').usedBy).toContainEqual({ kind: 'company', label: 'Pinecone Coffee (shared)', id: B })
    expect(r.disconnectPlan(A, 'posthog', () => true).borrowers).toEqual([{ companyId: B, name: 'Pinecone Coffee' }])
  })
  it('QA-05 / QP-8 / SEC-8: the borrower reads it "from Ledgerline", never as its own key or an env var, and has nothing to disconnect', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    r.reuse(B, 'posthog', A)
    const st = r.status(B, 'posthog')
    const k = st.forms.find((f) => f.kind === 'key')!
    expect(k.detail).toBe('POSTHOG_PERSONAL_API_KEY (from Ledgerline)')
    expect(k.reused).toBe(true)
    // agents reach it through the MCP built from the lent key, not their environment
    expect(st.purposes.agentTools).toMatchObject({ ok: true, via: 'mcp' })
    expect(r.contextBlock(B)).not.toContain('env POSTHOG')
    expect(r.disconnectPlan(B, 'posthog', (n) => !!values[B]![n])).toMatchObject({ keys: [], connections: [] })
  })
  it('SEC-6: the borrower uses the lender’s host and project and cannot point the lent key elsewhere', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    r.settings(A, 'posthog', { host: 'https://eu.posthog.com', projectId: '42' })
    r.reuse(B, 'posthog', A)
    expect(() => r.settings(B, 'posthog', { host: 'https://collector.attacker.example' })).toThrow(/Change them in Ledgerline/)
    store.patch(B, 'posthog', { settings: { host: 'https://collector.attacker.example' } })
    expect(r.status(B, 'posthog').settings).toEqual({ host: 'https://eu.posthog.com', projectId: '42' })
  })
  it('SEC-9: archiving the lender ends every reuse of it for good', () => {
    values[A]!.POSTHOG_PERSONAL_API_KEY = PH
    const r = make()
    r.reuse(B, 'posthog', A)
    expect(r.companyArchived(A)).toEqual([B])
    expect(store.get(B, 'posthog')?.sourceCompanyId).toBeNull()
  })
})

describe('SEC-6: settings are checked when saved', () => {
  it('a host must be a public https address', () => {
    const host = serviceById('posthog')!.settings!.find((f) => f.key === 'host')!
    expect(checkSetting(host, 'http://169.254.169.254/latest')).toEqual({ error: expect.stringContaining('https://') })
    expect(checkSetting(host, 'https://169.254.169.254')).toEqual({ error: expect.stringContaining('not an IP address') })
    expect(checkSetting(host, 'https://localhost')).toHaveProperty('error')
    expect(checkSetting(host, 'https://user:pw@eu.posthog.com')).toHaveProperty('error')
    expect(checkSetting(host, 'https://eu.posthog.com/')).toEqual({ value: 'https://eu.posthog.com' })
    expect(checkSetting(host, 'https://posthog.example.com')).toEqual({ value: 'https://posthog.example.com' })
    expect(() => make().settings(A, 'posthog', { host: 'http://169.254.169.254/latest' })).toThrow(/https/)
  })
})

describe('SEC-4: the Linear sync key stays the sync key', () => {
  it('no Linear tools for agents from the key until the founder turns it on', () => {
    values[A]!.LINEAR_API_KEY = 'linear-fake-key-0001'
    const r = make()
    expect(r.virtuals(A)).toEqual([])
    expect(r.status(A, 'linear').keyTools).toBe(false)
    r.chooseKey(A, 'linear', 'agentTools', 'LINEAR_API_KEY')
    expect(r.virtuals(A).map((v) => v.id)).toEqual(['svc:linear'])
    expect(r.status(A, 'linear').keyTools).toBe(true)
    r.unchooseKey(A, 'linear', 'agentTools')
    expect(r.virtuals(A)).toEqual([])
  })
  it('QP-11: the sync line says what to do, not that a key "can’t do that"', () => {
    values[A]!.LINEAR_API_KEY = 'linear-fake-key-0001'
    expect(make().status(A, 'linear').purposes.sync?.why).toContain('Pick a team on Linear’s card to sync the Board')
  })
  it('virtual connections carry their key names, so the gateway can check the spawn’s profile', () => {
    values[A]!.POSTHOG_API_KEY = PH
    expect(make().virtuals(A)[0]!.keyNames).toEqual(['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_API_KEY'])
  })
})
