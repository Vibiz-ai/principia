import { describe, expect, it } from 'vitest'
import { CONNECTION_CATALOG } from './connectionCatalog'
import { CONNECT_TOOL_IDS, connectLink, connectToolId, formatDeepLink, parseDeepLink, type DeepLink } from './deepLink'

const CO = 'co_ca0f4017e8ed37973995'

describe('principia:// deep links', () => {
  it('parses every page the agents hand out', () => {
    expect(parseDeepLink('principia://connect/instagram')).toEqual({ kind: 'connect', tool: 'instagram' })
    expect(parseDeepLink(`principia://connect/stripe?company=${CO}`)).toEqual({ kind: 'connect', tool: 'stripe', companyId: CO })
    expect(parseDeepLink('principia://connect/mcp')).toEqual({ kind: 'connect', tool: 'mcp' })
    expect(parseDeepLink('principia://connect/Custom')).toEqual({ kind: 'connect', tool: 'mcp' })
    expect(parseDeepLink('principia://connect/GH')).toEqual({ kind: 'connect', tool: 'github' })
    expect(parseDeepLink('principia://settings/keys')).toEqual({ kind: 'settings', section: 'keys' })
    // Settings › App › Phone (pair a phone by QR code): what principia_help links to
    expect(parseDeepLink('principia://settings/phone')).toEqual({ kind: 'settings', section: 'phone' })
    expect(parseDeepLink('principia://settings/connections/linear')).toEqual({ kind: 'connect', tool: 'linear' })
    expect(parseDeepLink('principia://settings')).toEqual({ kind: 'settings', section: 'company' })
    expect(parseDeepLink('principia://board')).toEqual({ kind: 'board' })
    expect(parseDeepLink('principia://board?task=NC-12')).toEqual({ kind: 'board', task: 'NC-12' })
    expect(parseDeepLink('principia://board/task_abc123')).toEqual({ kind: 'board', task: 'task_abc123' })
    expect(parseDeepLink('principia://board?new=Order%20more%20beans')).toEqual({ kind: 'board', newTitle: 'Order more beans' })
    expect(parseDeepLink('principia://chats')).toEqual({ kind: 'chats' })
    expect(parseDeepLink('principia://chats/live')).toEqual({ kind: 'chats', filter: 'live' })
    expect(parseDeepLink('principia://chats/session/session_x1')).toEqual({ kind: 'chats', chat: { kind: 'session', id: 'session_x1' } })
    expect(parseDeepLink('principia://agent/agt_42')).toEqual({ kind: 'agent', agentId: 'agt_42' })
    expect(parseDeepLink('principia://automations/routines?add=morning-brief')).toEqual({ kind: 'automations', tab: 'routines', add: 'morning-brief' })
    expect(parseDeepLink('principia://automations')).toEqual({ kind: 'automations' })
    // a suggested time rides along with the routine only (the person still presses Save)
    expect(parseDeepLink('principia://automations/routines?add=morning-brief&at=6:30&days=tue-sun')).toEqual({ kind: 'automations', tab: 'routines', add: 'morning-brief', at: '6:30', days: 'tue-sun' })
    expect(parseDeepLink('principia://automations/routines?at=6:30')).toEqual({ kind: 'automations', tab: 'routines' })
    expect(parseDeepLink('principia://automations/routines?add=morning-brief&at=25:99')).toBeNull()
    expect(parseDeepLink('principia://automations/routines?add=morning-brief&days=<script>')).toBeNull()
    expect(parseDeepLink('principia://knowledge')).toEqual({ kind: 'knowledge' })
    expect(parseDeepLink('principia://knowledge?note=Pricing')).toEqual({ kind: 'knowledge', note: 'Pricing' })
    expect(parseDeepLink('principia://forum/join/abcd1234')).toEqual({ kind: 'forum', joinCode: 'abcd1234' })
    expect(parseDeepLink('principia://home')).toEqual({ kind: 'home' })
    // the scheme and page names are case-insensitive; principia:connect/x (no slashes) works too
    expect(parseDeepLink('PRINCIPIA://Connect/slack')).toEqual({ kind: 'connect', tool: 'slack' })
    expect(parseDeepLink('principia:connect/slack')).toEqual({ kind: 'connect', tool: 'slack' })
  })

  it('refuses unknown or malformed links (never guesses)', () => {
    for (const bad of [
      '',
      'https://principia.app/connect/instagram',
      'javascript:alert(1)',
      'principia://',
      'principia://delete/everything',
      'principia://approve/task_1',
      'principia://connect/',
      'principia://connect/not-a-tool',
      'principia://connect/instagram/extra',
      'principia://settings/../../etc',
      'principia://settings/nope',
      'principia://board?task=../x',
      'principia://agent/',
      'principia://agent/a%2Fb',
      'principia://chats/session/',
      'principia://automations/routines?add=../../x',
      `principia://connect/stripe?company=../${CO}`,
      'principia://connect/stripe?company=not_a_company',
      'principia://connect/%E0%A4%A',
      `principia://board?new=${'x'.repeat(3000)}`
    ])
      expect(parseDeepLink(bad), bad).toBeNull()
    expect(parseDeepLink(42)).toBeNull()
    expect(parseDeepLink(null)).toBeNull()
  })

  it('a new task title is plain text only (a prefill, never filed)', () => {
    const l = parseDeepLink('principia://board?new=Line%0Aone%09two') as Extract<DeepLink, { kind: 'board' }>
    expect(l.newTitle).toBe('Line one two')
    expect((parseDeepLink(`principia://board?new=${'a'.repeat(400)}`) as Extract<DeepLink, { kind: 'board' }>).newTitle).toHaveLength(200)
  })

  it('formats links that parse back to the same thing', () => {
    const all: DeepLink[] = [
      { kind: 'connect', tool: 'notion', companyId: CO },
      { kind: 'settings', section: 'providers' },
      { kind: 'board', task: 'NC-3' },
      { kind: 'board', newTitle: 'Fix the menu & prices' },
      { kind: 'chats', filter: 'agents' },
      { kind: 'chats', chat: { kind: 'agent', id: 'agt_1' } },
      { kind: 'agent', agentId: 'agt_1', companyId: CO },
      { kind: 'automations', tab: 'routines', add: 'morning-brief' },
      { kind: 'automations', tab: 'routines', add: 'morning-brief', at: '6:30', days: 'tue-sun' },
      { kind: 'knowledge', note: 'Our prices' },
      { kind: 'forum', joinCode: 'abcd1234' },
      { kind: 'home' }
    ]
    for (const l of all) expect(parseDeepLink(formatDeepLink(l))).toEqual(l)
  })

  it('names every Connections card, and links an unknown tool to "add your own MCP server"', () => {
    for (const p of CONNECTION_CATALOG) expect(CONNECT_TOOL_IDS).toContain(p.id)
    for (const id of ['instagram', 'github', 'linear', 'slack', 'mcp']) expect(CONNECT_TOOL_IDS).toContain(id)
    expect(connectLink('stripe')).toBe('principia://connect/stripe')
    expect(connectLink('Stripe', CO)).toBe(`principia://connect/stripe?company=${CO}`)
    expect(connectLink('my-crm')).toBe('principia://connect/mcp')
    expect(connectToolId('nope')).toBeNull()
  })
})

describe('principia://automations/autopilots (AUTOPILOT.md §6)', () => {
  it('opens Automations › Autopilots, with an autopilot card to turn on; round-trips', () => {
    expect(parseDeepLink('principia://automations/autopilots')).toEqual({ kind: 'automations', tab: 'autopilots' })
    const l = parseDeepLink('principia://automations/autopilots?add=ads-watch&company=co_abc')
    expect(l).toEqual({ kind: 'automations', tab: 'autopilots', add: 'ads-watch', companyId: 'co_abc' })
    expect(parseDeepLink(formatDeepLink(l!))).toEqual(l)
    expect(parseDeepLink('principia://autopilots?add=site-watch')).toEqual({ kind: 'automations', tab: 'autopilots', add: 'site-watch' })
    expect(parseDeepLink('principia://automations/autopilots?add=Bad Id')).toBeNull()
    expect(parseDeepLink('principia://automations/autopilots/extra')).toBeNull()
  })
})
