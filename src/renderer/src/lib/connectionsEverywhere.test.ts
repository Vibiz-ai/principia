/**
 * CONNECTIONS.md §4: one connection per service, shown the same everywhere. The pure parts the surfaces share:
 * Settings cards built from the resolver's statuses, the slot's actions and lines, the dashboard install form with a
 * connection, and the checklist's analytics row.
 */
import { describe, expect, it } from 'vitest'
import { dashboardDef } from '@shared/dashboards'
import type { GatewayConnection } from '@shared/gateway'
import { serviceById, serviceStatus, type CompanyHoldings, type KeyPresence, type ServiceStatus } from '@shared/services'
import { buildCatalog, cardsFor, type CatalogInput } from './connections'
import { installReadiness } from './dashboards'
import { askPrompt, serviceActions, serviceMonogram, unlockedLine, unlocks, usedByLine, viaWords } from './serviceActions'
import { monogram } from './dashboards'
import { checklistItems, type ChecklistInput } from './checklist'

const CO = 'co_nw'
const hold = (p: Partial<CompanyHoldings> = {}): CompanyHoldings => ({ companyId: CO, keys: [], connections: [], slack: 'none', linear: { connected: false, problem: null }, ...p })
const key = (name: string): KeyPresence => ({ name, source: 'company', masked: '••••ab12' })
const conn = (p: Partial<GatewayConnection>): GatewayConnection => ({ id: 'c1', name: 'X', transport: 'http', enabled: true, roots: [], scope: 'global', companyIds: [CO], authentication: 'oauth', authStatus: 'connected', hasCredentials: false, ...p })
const st = (id: string, h: CompanyHoldings, extra: Partial<ServiceStatus> = {}): ServiceStatus => ({ ...serviceStatus(serviceById(id)!, h), usedBy: [], link: `principia://connect/${id}`, ...extra })
const all = (h: CompanyHoldings, extra: Record<string, Partial<ServiceStatus>> = {}): ServiceStatus[] => ['vibiz', 'posthog', 'stripe', 'notion', 'granola', 'linear', 'github', 'openai', 'plausible'].filter((id) => serviceById(id)).map((id) => st(id, h, extra[id]))
const base = (x: Partial<CatalogInput> = {}): CatalogInput => ({ companyId: CO, companyName: 'Northwind', code: false, writer: null, accounts: undefined, connections: [], gh: { state: 'ok', login: null }, slack: 'none', linear: { connected: false, teamKey: null, problem: null }, instagramKey: false, ...x })

describe('Settings › Connections from one status per service', () => {
  it('a saved PostHog key shows PostHog Connected (the gateway alone has nothing), with what uses it', () => {
    const h = hold({ keys: [key('POSTHOG_PERSONAL_API_KEY')] })
    const cards = buildCatalog(base({ services: all(h, { posthog: { usedBy: [{ kind: 'dashboard', label: 'Marketing dashboard' }, { kind: 'agents', label: '3 agents' }] } }) }))
    const ph = cards.find((c) => c.id === 'posthog')!
    expect(ph).toMatchObject({ state: 'connected', group: 'connected', usedBy: 'Marketing dashboard, 3 agents', action: { kind: 'service', serviceId: 'posthog' }, actionLabel: 'Manage' })
    expect(ph.chip).toBe('Connected · key')
    expect(cards.filter((c) => c.id === 'posthog')).toHaveLength(1)
  })
  it('without services (an older main) the cards are as before', () => {
    expect(buildCatalog(base()).some((c) => c.usedBy || c.purposes)).toBe(false)
  })
  it('a service with no preset gets a card; a key-only service appears once connected', () => {
    const h = hold({ keys: [key('OPENAI_API_KEY')] })
    const cards = buildCatalog(base({ services: all(h) }))
    expect(cards.find((c) => c.id === 'plausible')).toMatchObject({ state: 'notConnected', action: { kind: 'service' } })
    if (serviceById('openai')) expect(cards.find((c) => c.id === 'openai')).toMatchObject({ state: 'connected', group: 'connected' })
  })
  it('a service that takes a key opens the shared sheet instead of the one-click sign-in; not connected shows what it unlocks', () => {
    const cards = buildCatalog(base({ services: all(hold()) }))
    const stripe = cards.find((c) => c.id === 'stripe')!
    expect(stripe.action).toEqual({ kind: 'service', serviceId: 'stripe' })
    expect(stripe.unlocks).toContain('Revenue dashboard')
    // an MCP-only service keeps its one-click sign-in
    expect(cards.find((c) => c.id === 'granola')!.action.kind).toBe('preset')
  })
  it('grouped by need: Dashboards lists the services that can feed one', () => {
    const cards = buildCatalog(base({ services: all(hold()) }))
    const ids = cardsFor(cards, 'dashboard').map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['posthog', 'stripe']))
    expect(ids).not.toContain('granola')
    expect(cardsFor(cards, 'knowledge').map((c) => c.id)).toEqual(expect.arrayContaining(['granola', 'notion']))
  })
})

describe('the slot', () => {
  it('PostHog connected by a key: See sessions in the project, Ask about your data', () => {
    const s = st('posthog', hold({ keys: [key('POSTHOG_PERSONAL_API_KEY')] }), { settings: { projectId: '42', host: 'https://eu.posthog.com' } })
    const acts = serviceActions(s)
    expect(acts.map((a) => a.id)).toEqual(['ask', 'sessions'])
    expect(acts.find((a) => a.id === 'sessions')!.url).toBe('https://eu.posthog.com/project/42/replay/home')
    expect(acts.find((a) => a.id === 'ask')!.prompt).toBe(askPrompt('PostHog'))
    expect(viaWords(s)).toBe('key')
  })
  it('PostHog by sign-in with no project yet: sessions open PostHog’s last project', () => {
    const s = st('posthog', hold({ connections: [conn({ url: 'https://mcp.posthog.com/mcp' })] }))
    expect(serviceActions(s).find((a) => a.id === 'sessions')!.url).toBe('https://us.posthog.com/replay/home')
    expect(viaWords(s)).toBe('sign-in')
  })
  it('not connected: no actions; unlocks lists every capability as not yet', () => {
    const s = st('posthog', hold())
    expect(serviceActions(s)).toEqual([])
    expect(unlocks(s, 'posthog').every((u) => !u.ok)).toBe(true)
    expect(usedByLine(s)).toBe('')
  })
  it('monograms', () => {
    expect(serviceMonogram('PostHog')).toBe('PH')
    expect(serviceMonogram('GitHub')).toBe('GH')
    expect(serviceMonogram('Stripe')).toBe('St')
    expect(serviceMonogram('Google Search Console')).toBe('GS')
  })
})

describe('dashboard install with a connection', () => {
  const ph = dashboardDef('posthog')!
  it('connected by a key: no key asked, the project still is', () => {
    expect(installReadiness(ph, [], {}, {}, 'key')).toEqual({ ok: false, missing: ['Project ID'] })
    expect(installReadiness(ph, [], {}, { projectId: '1' }, 'key').ok).toBe(true)
  })
  it('through a sign-in: neither the key nor the project', () => {
    expect(installReadiness(ph, [], {}, {}, 'signIn').ok).toBe(true)
  })
  it('no connection: as before', () => {
    expect(installReadiness(ph, [], {}, { projectId: '1' }).missing).toEqual(['Personal API key'])
  })
})

describe('checklist: Connect your product analytics', () => {
  const input = (services: ChecklistInput['services']): ChecklistInput => ({ company: { id: CO, name: 'Northwind', mission: '' }, hasLogo: false, repoCount: 0, departmentsOn: false, departments: [], agents: [], dashboards: [], socials: [], vibiz: 'signed-out', slack: 'none', scheduleCount: 0, autopilots: undefined, services })
  it('done by PostHog in any form; offers PostHog otherwise; absent when main has no connections', () => {
    const on = checklistItems(input([{ serviceId: 'posthog', name: 'PostHog', state: 'connected', chip: 'Connected · key' }])).find((x) => x.id === 'analytics')!
    expect(on).toMatchObject({ done: true, actionLabel: 'Manage', action: { kind: 'connect', serviceId: 'posthog' } })
    const off = checklistItems(input([])).find((x) => x.id === 'analytics')!
    // QA-10: the founder picks PostHog, Plausible or Search Console from a small menu
    expect(off).toMatchObject({ done: false, actionLabel: 'Connect…' })
    expect(off.action.kind === 'connect' && off.action.choices?.map((c) => c.serviceId)).toEqual(['posthog', 'plausible', 'google-search-console'])
    // QP-1: a turned-down key is Fix, never Connect
    const hurt = checklistItems(input([{ serviceId: 'posthog', name: 'PostHog', state: 'attention', chip: 'Needs attention' }])).find((x) => x.id === 'analytics')!
    expect(hurt).toMatchObject({ done: false, actionLabel: 'Fix PostHog', action: { kind: 'connect', serviceId: 'posthog' } })
    expect(hurt.detail).toContain('needs attention')
    expect(checklistItems(input(null)).find((x) => x.id === 'analytics')!.pending).toBe(true)
    expect(checklistItems(input(undefined)).some((x) => x.id === 'analytics')).toBe(false)
  })
  it('Vibiz counts when connected by its token too', () => {
    expect(checklistItems(input([{ serviceId: 'vibiz', name: 'Vibiz', state: 'connected', chip: 'Connected · key' }])).find((x) => x.id === 'vibiz')!.done).toBe(true)
  })
})

describe('QA round fixes (CONN-QA, QP)', () => {
  it('QP-1: a key the vendor turned down shows under Needs attention with Fix, never Not connected / Connect', () => {
    const h = hold({ keys: [key('POSTHOG_PERSONAL_API_KEY'), key('STRIPE_RESTRICTED_KEY')], keyProblems: { POSTHOG_PERSONAL_API_KEY: 'PostHog turned down the key on 27 Oct.', STRIPE_RESTRICTED_KEY: 'Stripe turned down the key on 27 Oct.' } })
    const cards = buildCatalog(base({ services: all(h) }))
    for (const id of ['posthog', 'stripe']) {
      const c = cards.find((x) => x.id === id)!
      expect(c, id).toMatchObject({ state: 'attention', group: 'attention', actionLabel: 'Fix', action: { kind: 'service', serviceId: id } })
      expect(c.note).toContain('turned down the key')
    }
  })
  it('QP-9: GitHub connected by a token connection (no gh login) never says it uses the gh login', () => {
    const h = hold({ connections: [conn({ id: 'github-ledger', name: 'github-ledger', url: 'https://api.githubcopilot.com/mcp/', authentication: 'bearer' as never, authStatus: undefined, hasCredentials: true })] })
    const cards = buildCatalog(base({ gh: { state: 'ok', login: 'diego' }, services: all(h) }))
    const gh = cards.find((c) => c.id === 'github')!
    expect(gh.state).toBe('connected')
    expect(gh.chip).toBe('Connected · MCP')
    expect(gh.blurb).not.toContain('gh login')
    expect(gh.note ?? '').not.toContain('Found on this Mac')
    expect(gh.note).toContain('api.githubcopilot.com')
  })
  it('QA-12: one monogram for a service everywhere (cards, dashboards, the sheet)', () => {
    for (const n of ['PostHog', 'Stripe', 'Slack', 'Shopify', 'Supabase', 'Sentry', 'Google Search Console']) expect(monogram(n)).toBe(serviceMonogram(n))
    expect(new Set(['Stripe', 'Slack', 'Shopify', 'Supabase', 'Sentry'].map(serviceMonogram)).size).toBe(5)
  })
  it('QA-03: the toast names what the key actually unlocked (an agent key: no revenue dashboard)', () => {
    const s = st('stripe', hold({ keys: [key('STRIPE_AGENT_API_KEY')] }))
    expect(unlockedLine(s)).toBe('agent tools, ask about revenue, revenue brief autopilot')
    expect(s.purposes.dashboard?.why).toBe('The revenue dashboard needs a read-only restricted key (rk_…). Your agent API key can’t be used for it.')
    expect(s.purposes.dashboard?.fixKey).toBe('STRIPE_RESTRICTED_KEY')
  })
  it('QP-2: "Ask about your data" asks for this company’s connection through Principia, never another server', () => {
    expect(askPrompt('PostHog')).toContain('principia_call_tool')
    expect(askPrompt('PostHog')).toContain('Never another PostHog tool or MCP server')
  })
})
