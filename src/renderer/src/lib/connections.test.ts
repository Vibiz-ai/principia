import { describe, expect, it } from 'vitest'
import type { GatewayConnection } from '@shared/gateway'
import { buildCatalog, connectionState, instagramAccount, searchCards, type CatalogInput } from './connections'

const base = (x: Partial<CatalogInput> = {}): CatalogInput => ({
  companyId: 'co_nw',
  companyName: 'Northwind Coffee',
  code: false,
  writer: 'Marcus',
  accounts: undefined,
  connections: [],
  gh: { state: 'ok', login: 'diego-ledgerly' },
  slack: 'none',
  linear: { connected: false, teamKey: null, problem: null },
  instagramKey: false,
  ...x
})
const conn = (x: Partial<GatewayConnection>): GatewayConnection => ({ id: 'c1', name: 'Stripe', transport: 'http', url: 'https://mcp.stripe.com', enabled: true, roots: [], hasCredentials: false, authentication: 'oauth', authStatus: 'connected', companyIds: ['co_nw'], ...x })

describe('Connections catalog: one state per card, a connected tool once', () => {
  it('a shop sees consumer tools first, Instagram leading, with one honest state', () => {
    const cards = buildCatalog(base())
    const popular = cards.filter((c) => c.group === 'popular').map((c) => c.id)
    expect(popular.slice(0, 4)).toEqual(['instagram', 'stripe', 'slack', 'notion'])
    const ig = cards.find((c) => c.id === 'instagram')!
    expect(ig.state).toBe('notConnected')
    expect(ig.chip).toBe('Not connected')
    // round 2: no "Drafts only" pill and no "Meta approval" before connecting
    expect(`${ig.chip} ${ig.blurb} ${ig.note ?? ''}`).not.toMatch(/drafts only|meta/i)
    expect(ig.blurb).toContain('Marcus gets each post ready')
    expect(cards.filter((c) => c.state === 'soon').map((c) => c.name)).toEqual(['Shopify', 'Google Business', 'Meta Ads'])
    expect(cards[cards.length - 1]!.id).toBe('custom')
  })
  it('Linear sync failing on the network says Offline, never "Synced", and sits under Needs attention', () => {
    const ok = buildCatalog(base({ linear: { connected: true, teamKey: 'ENG', problem: null } })).find((c) => c.id === 'linear')!
    expect(ok).toMatchObject({ chip: 'Synced · ENG', group: 'connected' })
    const off = buildCatalog(base({ linear: { connected: true, teamKey: 'ENG', problem: null, offline: { kind: 'network', synced: 'Synced 21 min ago' } } })).find((c) => c.id === 'linear')!
    expect(off).toMatchObject({ state: 'attention', chip: 'Offline', group: 'attention' })
    expect(off.note).toContain('Synced 21 min ago')
  })
  it('the Connected section never holds a card that needs a sign-in', () => {
    const cards = buildCatalog(base({ connections: [conn({ authStatus: 'disconnected' })] }))
    const stripe = cards.find((c) => c.id === 'stripe')!
    expect(stripe).toMatchObject({ chip: 'Sign-in needed', group: 'attention' })
    expect(cards.filter((c) => c.group === 'connected').every((c) => c.state === 'connected')).toBe(true)
    expect(cards[0]!.group).toBe('attention')
  })
  it('a code company sees GitHub and Linear first', () => {
    const popular = buildCatalog(base({ code: true })).filter((c) => c.group === 'popular').map((c) => c.id)
    expect(popular.slice(0, 2)).toEqual(['github', 'linear'])
  })
  it('Connected names the account (E12) and the tool is not listed a second time', () => {
    const cards = buildCatalog(base({ accounts: { instagram: { handle: '@northwindcoffee', connectedAt: 'x' }, github: { handle: 'diego-ledgerly', connectedAt: 'x' } }, connections: [conn({})] }))
    for (const id of ['instagram', 'github', 'stripe']) expect(cards.filter((c) => c.id === id)).toHaveLength(1)
    expect(cards.find((c) => c.id === 'instagram')).toMatchObject({ group: 'connected', state: 'connected', chip: 'Connected', account: '@northwindcoffee' })
    expect(cards.find((c) => c.id === 'instagram')!.blurb).toMatch(/^@northwindcoffee is connected\. Marcus gets each post ready/)
    expect(cards.find((c) => c.id === 'github')).toMatchObject({ group: 'connected', chip: 'Connected', account: 'diego-ledgerly' })
    expect(cards.find((c) => c.id === 'github')!.blurb).toMatch(/^Connected as diego-ledgerly\./)
    expect(cards.find((c) => c.id === 'stripe')).toMatchObject({ group: 'connected', chip: 'Connected', note: null })
    // ids are unique: every card renders once
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length)
  })
  it('GitHub offers Use my gh login when gh is signed in, and says when gh went away', () => {
    expect(buildCatalog(base()).find((c) => c.id === 'github')).toMatchObject({ actionLabel: 'Use my gh login', note: 'Found on this Mac: diego-ledgerly' })
    expect(buildCatalog(base({ gh: { state: 'signedOut', login: null } })).find((c) => c.id === 'github')!.actionLabel).toBe('Connect GitHub')
    const lost = buildCatalog(base({ gh: { state: 'signedOut', login: null }, accounts: { github: { handle: 'diego', connectedAt: 'x' } } })).find((c) => c.id === 'github')!
    expect(lost).toMatchObject({ state: 'attention', chip: 'Needs attention' })
  })
  it('a connection saved before companies says it is shared; a sign-in in flight waits; an error needs attention', () => {
    const shared = buildCatalog(base({ connections: [conn({ companyIds: undefined })] })).find((c) => c.id === 'stripe')!
    expect(shared.note).toBe('Shared by every company')
    expect(connectionState(conn({ authStatus: 'connecting' }))).toEqual({ state: 'waiting', chip: 'Waiting for sign-in' })
    expect(connectionState(conn({ authStatus: 'error' }))).toEqual({ state: 'attention', chip: 'Needs attention' })
    expect(connectionState(conn({ enabled: false }))).toEqual({ state: 'off', chip: 'Turned off' })
    // the Vibiz card seeded at install, never signed in: a plain Sign in among the tools, not a problem at the top
    const vibiz = buildCatalog(base({ connections: [conn({ id: 'vibiz', name: 'Vibiz', url: 'https://www.vibiz.ai/api/mcp', authentication: 'oauth', authStatus: 'disconnected' })] })).find((c) => c.id === 'vibiz')!
    expect(vibiz).toMatchObject({ state: 'notConnected', chip: 'Not signed in', actionLabel: 'Sign in' })
    expect(vibiz.group).not.toBe('attention')
  })
  it('Linear is one card for sync and the agent tool', () => {
    const synced = buildCatalog(base({ linear: { connected: true, teamKey: 'LED', problem: null }, connections: [conn({ id: 'lin', name: 'Linear', url: 'https://mcp.linear.app/mcp' })] }))
    expect(synced.filter((c) => c.name === 'Linear')).toHaveLength(1)
    expect(synced.find((c) => c.id === 'linear')).toMatchObject({ chip: 'Synced · LED', group: 'connected' })
    const agentsOnly = buildCatalog(base({ connections: [conn({ id: 'lin', name: 'Linear', url: 'https://mcp.linear.app/mcp' })] })).find((c) => c.id === 'linear')!
    expect(agentsOnly).toMatchObject({ state: 'connected', chip: 'Connected · agents' })
  })
  it('Personal has no account cards; search matches names and keywords', () => {
    expect(buildCatalog(base({ personal: true })).some((c) => c.id === 'instagram' || c.id === 'github')).toBe(false)
    const cards = buildCatalog(base())
    expect(searchCards(cards, 'payments').map((c) => c.id)).toContain('stripe')
    expect(searchCards(cards, 'instagram').map((c) => c.id)).toEqual(['instagram'])
    expect(searchCards(cards, 'zzzz')).toEqual([])
  })
  it('an Instagram account from what people type', () => {
    expect(instagramAccount('northwindcoffee')).toBe('@northwindcoffee')
    expect(instagramAccount(' @NorthwindCoffee ')).toBe('@northwindcoffee')
    expect(instagramAccount('https://www.instagram.com/northwind.coffee/')).toBe('@northwind.coffee')
    expect(instagramAccount('north wind')).toBeNull()
    expect(instagramAccount('.bad')).toBeNull()
    expect(instagramAccount('')).toBeNull()
  })
})
