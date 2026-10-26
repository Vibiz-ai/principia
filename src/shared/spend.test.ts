import { describe, expect, it } from 'vitest'
import type { UsageRow } from './usage'
import { capError, capLine, capReached, companySpend, dollars, heroCount, isMoneyAction, isMoneyAnswer, mixedListLabel, shortCompanyName, parseCap, rowsCsv, runsLine, spendCsv, withTotal } from './spend'
import { claudePlanLabel, onPlan, parseClaudeAuth } from './providerAuth'

const row = (key: string, usd: number | null, agents = 1, x: Partial<UsageRow> = {}): UsageRow => ({ key, label: key, companyId: key, usd, estimated: false, unpriced: false, tokensIn: 100, tokensOut: 10, agents, ...x })

describe('Spend: one number per person (pm-review B5)', () => {
  it('the total row is the sum of the rows shown, Personal included', () => {
    const rows = [row('co_nw', 18.6, 7), row('co_la', 31.4, 4), row('co_personal', 0.5, 1, { estimated: true })]
    const { total } = withTotal(rows)
    expect(total.usd).toBeCloseTo(50.5)
    expect(total.agents).toBe(12)
    expect(total.estimated).toBe(true)
    expect(dollars(total)).toBe('~$50.50')
    expect(withTotal([]).total).toMatchObject({ usd: null, agents: 0 })
  })
  it('money labels never invent a number', () => {
    expect(dollars(null)).toBe('$0')
    expect(dollars({ usd: null, estimated: false, unpriced: true })).toBe('$0+')
    expect(dollars({ usd: 0.004, estimated: false, unpriced: false })).toBe('$<0.01')
    expect(dollars({ usd: 4.2, estimated: false, unpriced: false })).toBe('$4.20')
    expect(dollars({ usd: 1234.5, estimated: false, unpriced: false })).toBe('$1,235')
  })
  it('the hero counts chats you had yourself, in plain words', () => {
    expect(heroCount(23, 4)).toEqual({ n: '23', of: 'runs, incl. 4 chats of your own' })
    expect(heroCount(5, 1).of).toBe('runs, incl. 1 chat of your own')
    expect(heroCount(5, 0).of).toBe('agent runs')
    expect(heroCount(1, 1)).toEqual({ n: '1', of: 'chat of your own' })
    expect(heroCount(0, 0).n).toBe('0')
    expect(runsLine(23, 4)).toBe('23 runs, incl. 4 chats of your own')
    // a chat of your own is never called an agent run (the week tile and the month tile say the same)
    expect(runsLine(1, 1)).toBe('1 chat of your own')
    expect(runsLine(0, 0)).toBe('No agent work yet')
  })
  it('a cap that cannot be set says why (never a silently disabled Set)', () => {
    expect(capError('')).toBeNull()
    expect(capError('60')).toBeNull()
    expect(capError('0.01')).toBe('The smallest cap is $1.')
    expect(capError('abc')).toBe('Type an amount in dollars, like 60.')
    expect(capError('60.505')).toBe('Use at most two decimals, like 60.50.')
    expect(capError('200000')).toBe('The largest cap is $100,000.')
  })
  it('a monthly cap: the line, the parse, and when it trips', () => {
    expect(capLine(15.6, 30)).toEqual({ text: 'Cap $30/month · 52% used', pct: 52 })
    expect(capLine(5, null)).toEqual({ text: 'No monthly cap', pct: null })
    expect(parseCap('$60')).toBe(60)
    expect(parseCap('1,200.50')).toBe(1200.5)
    expect(parseCap('0')).toBeNull()
    expect(parseCap('sixty')).toBeNull()
    expect(capReached(60, 60)).toBe(true)
    expect(capReached(59.99, 60)).toBe(false)
    expect(capReached(null, 60)).toBe(false)
    expect(capReached(100, null)).toBe(false)
  })
})

describe('All companies: every client, $0 included, and Export CSV', () => {
  const cos = [
    { id: 'co_personal', name: 'Personal', system: 'personal' },
    { id: 'co_nw', name: 'Northwind Coffee', monthlyCap: 60 },
    { id: 'co_hd', name: 'Harbor Dental Group', pausedAt: '2026-10-24T00:00:00Z' }
  ]
  it('lists every company (Personal last), $0 when it had no runs', () => {
    const s = companySpend(cos, [row('co_nw', 18.6, 7)], [row('co_nw', 4.2, 2)])
    expect(s.map((x) => x.name)).toEqual(['Northwind Coffee', 'Harbor Dental Group', 'Personal'])
    expect(s[1]).toMatchObject({ paused: true, month: { usd: 0, agents: 0 }, week: { usd: 0 } })
    expect(s[0]).toMatchObject({ cap: 60, month: { usd: 18.6 } })
    expect(companySpend(cos, null, null)[0]!.month).toBeNull()
  })
  it('the CSV has one row per company and a total that equals the rows; formulas are defused', () => {
    const s = companySpend([...cos, { id: 'co_x', name: '=HYPERLINK("x")' }], [row('co_nw', 18.6, 7), row('co_hd', 6.1, 2)], [row('co_nw', 4.2, 2)])
    const lines = spendCsv(s, 'October').trim().split('\n')
    expect(lines[0]).toBe('Company,State,October pay-as-you-go value (USD),This week (USD),Runs this month (incl. your own chats),Monthly cap (USD)')
    expect(lines).toContain('Northwind Coffee,Running,18.60,4.20,7,60.00')
    expect(lines).toContain('Harbor Dental Group,Paused,6.10,0.00,2,')
    expect(lines).toContain('Personal,Personal,0.00,0.00,0,')
    expect(lines[lines.length - 1]).toBe('Total,,24.70,4.20,9,')
    expect(lines.some((l) => l.startsWith('"\'=HYPERLINK'))).toBe(true)
    const one = rowsCsv([row('Marcus · Writer', 1.85, 2), row('Your own chats', 0.75)], 'Agent').trim().split('\n')
    expect(one[one.length - 1]).toBe('Total,3,220,2.60')
  })
})

describe('pm-review B6: no one-click money in a list that mixes companies', () => {
  it('a money answer names the client; anything else is unchanged', () => {
    expect(isMoneyAction('Refund $24')).toBe(true)
    expect(isMoneyAction('Pay the invoice')).toBe(true)
    expect(isMoneyAction('Send a new box for free')).toBe(false)
    expect(isMoneyAction('Yes')).toBe(false)
    expect(mixedListLabel('Refund $24', 'Northwind Coffee')).toBe('Refund $24 · Northwind')
    expect(mixedListLabel('Approve', 'Northwind Coffee')).toBe('Approve')
    expect(mixedListLabel('Refund $24', null)).toBe('Review')
  })

  it('a Yes to a money question is money too: it names the amount and the client (a confirm ask)', () => {
    const q = 'A subscriber (Ana) got a damaged bag. Refund $24 to her card?'
    expect(isMoneyAnswer('Yes', q)).toBe(true)
    expect(isMoneyAnswer('No', q)).toBe(false)
    expect(isMoneyAnswer('Yes', 'Post the Friday story?')).toBe(false)
    expect(mixedListLabel('Yes', 'Northwind Coffee', { prompt: q })).toBe('Yes, $24 · Northwind')
    expect(mixedListLabel('No', 'Northwind Coffee', { prompt: q })).toBe('No')
    expect(mixedListLabel('Approve', 'Northwind Coffee', { prompt: 'Issue the refund to Ana?' })).toBe('Approve · Northwind')
    expect(mixedListLabel('Yes', null, { prompt: q })).toBe('Review')
    expect(mixedListLabel('Yes', 'Northwind Coffee', { prompt: 'Post the Friday story?' })).toBe('Yes')
  })

  it('two clients that share a first word are told apart by as many words as it takes', () => {
    const all = ['Harbor Dental Group', 'Harbor Dental Kids', 'Northwind Coffee']
    expect(shortCompanyName('Northwind Coffee', all)).toBe('Northwind')
    expect(shortCompanyName('Harbor Dental Kids', all)).toBe('Harbor Dental Kids')
    expect(shortCompanyName('Harbor Dental Group', ['Harbor Dental Group', 'Northwind Coffee'])).toBe('Harbor')
    expect(shortCompanyName('Harbor Dental', ['Harbor Dental', 'Harbor Health'])).toBe('Harbor Dental')
    expect(shortCompanyName('', all)).toBe('')
    expect(mixedListLabel('Refund $40', 'Harbor Dental Kids', { others: all })).toBe('Refund $40 · Harbor Dental Kids')
  })
})

describe('E12: the Claude check is real', () => {
  it('reads claude auth status --json', () => {
    const ok = parseClaudeAuth({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'x@y' }) })
    expect(ok).toMatchObject({ state: 'ok', method: 'claude.ai', plan: 'max' })
    expect(claudePlanLabel(ok.plan)).toBe('Max plan')
    expect(onPlan(ok)).toBe(true)
    expect(onPlan(parseClaudeAuth({ code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key"}' }))).toBe(false)
    expect(parseClaudeAuth({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' })).toMatchObject({ state: 'signedOut', method: null, plan: null })
    // an older Claude Code without the command: unknown, never "signed out"
    expect(parseClaudeAuth({ code: 1, stdout: "error: unknown command 'auth'" }).state).toBe('unknown')
    expect(parseClaudeAuth({ code: null, stdout: '', missing: true }).state).toBe('missing')
    expect(onPlan(null)).toBeNull()
  })
})

describe('E12: an Instagram named in Connections or at setup counts as connected (drafts only)', () => {
  it('ready for the checklist, never able to post', async () => {
    const { socialStatuses } = await import('./socials')
    const ig = socialStatuses('co_nw', new Set(), [], { instagram: { handle: '@northwindcoffee' } }).find((s) => s.id === 'instagram')!
    expect(ig).toMatchObject({ state: 'account', ready: true, canPost: false, connection: '@northwindcoffee' })
    expect(socialStatuses('co_nw', new Set(), []).find((s) => s.id === 'instagram')!.ready).toBe(false)
    // a key wins over the account (agents can post through the founder's own Meta app)
    expect(socialStatuses('co_nw', new Set(['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID']), [], { instagram: { handle: '@x' } }).find((s) => s.id === 'instagram')!.state).toBe('key')
  })
})
