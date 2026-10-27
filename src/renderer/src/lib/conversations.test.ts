import { describe, expect, it } from 'vitest'
import { clipWords, conversationOfRunTitle, conversationRows, conversationSlug, conversationTitle, handoffLine, mentionAtCaret, mentionedAll, mentionOptions, privateWith, routeLine, routeTeam, whoLine } from './conversations'
import { routeAsk, type DeskAgent } from './desk'
import { CHANNEL_NAME_RE, type ForumChannel, type ForumMember, type ForumPresence } from '@shared/forum'

// Pinecone Coffee as the demo seeds it (src/main/demo/seedDemo.ts): what each seat does is part of routing
const team: DeskAgent[] = [
  { id: 'a1', name: 'Marcus', role: 'Content Writer', department: 'Marketing', about: 'Writes posts, captions and the newsletter. Does not publish without approval.' },
  { id: 'a2', name: 'Cato', role: 'Support Lead', department: 'Support', about: 'Drafts replies to reviews and emails. Escalates refunds.' },
  { id: 'a3', name: 'Seneca', role: 'Operations', department: 'Ops', about: 'Supplier orders, opening checklists, the weekly numbers.' },
  { id: 'a4', name: 'Vitruvius', role: 'Designer', department: 'Marketing', paused: true }
]

describe('routeTeam (CHAT-UI.md §7)', () => {
  it('brings in everyone the words point at, best first, at most three', () => {
    const r = routeTeam('we need a launch post for Friday and replies to the customer reviews', team)!
    expect(r.by).toBe('words')
    expect(r.agents.map((a) => a.name).sort()).toEqual(['Cato', 'Marcus'])
    expect(r.why.a1).toContain('post')
  })
  it('an @name is exactly that person, several @names are all of them', () => {
    expect(routeTeam('@Seneca check the oat milk', team)!.agents.map((a) => a.name)).toEqual(['Seneca'])
    const r = routeTeam('@Cato @Seneca are we ready for saturday', team)!
    expect(r.by).toBe('mention')
    expect(r.agents.map((a) => a.name)).toEqual(['Cato', 'Seneca'])
  })
  it('nobody fits: the first active agent, said honestly; an unknown @name is reported', () => {
    const r = routeTeam('whats a good name for my dog', team)!
    expect(r.by).toBe('lead')
    expect(r.agents.map((a) => a.name)).toEqual(['Marcus'])
    expect(routeLine('whats a good name for my dog', r)).toMatch(/No clear fit · Principia starts with Marcus \(first on the team\)/)
    expect(routeTeam('@Livia look at this', team)!.unknown).toBe('Livia')
  })
  it('left-out agents never come back by words', () => {
    expect(routeTeam('a post and replies to reviews', team, { exclude: ['a2'] })!.agents.map((a) => a.name)).toEqual(['Marcus'])
  })
  it('the synthetic users’ misroutes: what each seat does wins over a stray word', () => {
    const pick = (t: string): string[] => routeTeam(t, team)!.agents.map((a) => a.name)
    // "customers" says who it is for, not that it is support work (solo founder: "why is the support guy writing it?")
    expect(pick('write this week’s newsletter for our customers')).toEqual(['Marcus'])
    // pricing and margins are the numbers person's (returning user: "why is Marcus answering my pricing question?")
    expect(pick('compare 250g at $14 vs $16, what margin do we keep?')).toEqual(['Seneca'])
    // ordering from a supplier is operations, not support (power user)
    expect(pick('find a cheaper oat milk supplier and order for next week')).toEqual(['Seneca'])
    expect(pick('we are short staffed for the Saturday queue')[0]).toBe('Seneca')
    // a request that really is two people's still brings both
    expect(pick('reply to the angry review and draft a post about the new hours').sort()).toEqual(['Cato', 'Marcus'])
  })
  it('@all, @team, @everyone (or To: Everyone): the whole active team', () => {
    const r = routeTeam('@all stand-up: what are you on today?', team)!
    expect(r.by).toBe('everyone')
    expect(r.agents.map((a) => a.name)).toEqual(['Marcus', 'Cato', 'Seneca'])
    expect(routeLine('@all stand-up', r)).toBe('→ Everyone: Marcus, Cato and Seneca')
    expect(routeTeam('hello', team, { everyone: true })!.by).toBe('everyone')
    expect(handoffLine(r)).toMatch(/^You asked everyone on the team: Marcus \(Content Writer\)/)
  })
  it('one @name is a private conversation, and the handoff says so', () => {
    const r = routeTeam('@Cato table 4 wants a refund', team)!
    expect(handoffLine(r)).toBe('A private conversation with Cato (Support Lead). Nobody else on the team sees it.')
  })
  it('routeAsk keeps its single pick (the agent page and older callers)', () => {
    expect(routeAsk('the customer replies', team)).toMatchObject({ agent: { name: 'Cato' }, by: 'words' })
    expect(routeAsk('nothing relevant here', team)).toMatchObject({ agent: { name: 'Marcus' }, by: 'default' })
  })
  it('no team: null (a chat with Claude)', () => {
    expect(routeTeam('hi', [])).toBeNull()
    expect(routeLine('hi', null)).toBe('→ A new chat with Claude')
  })
})

describe('conversation words', () => {
  it('route line before typing says what sending does', () => {
    expect(routeLine('', routeTeam('', team))).toBe('→ Principia brings in the right people · type @ to pick someone')
  })
  it('handoff line names who and why, and who you left out', () => {
    const r = routeTeam('a launch post', team)!
    expect(handoffLine(r)).toBe('Principia brought in Marcus (Content Writer): the request mentions “post”.')
    expect(handoffLine(r, [team[1]!])).toMatch(/You left out Cato\.$/)
  })
  it('titles are short, slugs are valid channel names', () => {
    expect(conversationTitle('Can you please draft three captions for the maple latte launch next week')).toBe('Draft three captions for the maple latte launch…')
    // the topic comes first, never the last sentence (returning user: "Draft a short note for cus…, that's my price rise?")
    expect(conversationTitle('We are raising the 250g bag from $14 to $16. Draft a short note for customers.')).toBe('We are raising the 250g bag from $14 to $16')
    expect(conversationTitle('Write a post announcing the loyalty card. Keep this between us.')).toBe('Write a post announcing the loyalty card')
    expect(conversationTitle('Hey! Can you check the oat milk stock for the weekend')).toBe('Check the oat milk stock for the weekend')
    // never cut mid-word
    expect(clipWords('Customers keep complaining about the Saturday queue at the counter', 48)).toBe('Customers keep complaining about the Saturday…')
    expect(conversationTitle('')).toBe('New conversation')
    const slug = conversationSlug('Draft three captions for the maple…', 'Zq9x')
    expect(slug.startsWith('chat-')).toBe(true)
    expect(CHANNEL_NAME_RE.test(slug)).toBe(true)
    expect(CHANNEL_NAME_RE.test(conversationSlug('¿¡!!', 'ab12'))).toBe(true)
  })
  it('mentionedAll finds every teammate once', () => {
    expect(mentionedAll('@marcus and @Marcus and @cato', team).found.map((a) => a.name)).toEqual(['Marcus', 'Cato'])
  })
})

describe('the @ picker', () => {
  it('finds the @word at the caret, and offers names and roles', () => {
    expect(mentionAtCaret('ask @ma', 7)).toEqual({ query: 'ma', start: 4 })
    expect(mentionAtCaret('@', 1)).toEqual({ query: '', start: 0 })
    expect(mentionAtCaret('mail@ma', 7)).toBeNull()
    expect(mentionAtCaret('ask @marcus now', 15)).toBeNull()
    expect(mentionOptions('', team).length).toBe(4)
    expect(mentionOptions('sup', team).map((a) => a.name)).toEqual(['Cato'])
    // starts-with first, then contains
    expect(mentionOptions('ca', team).map((a) => a.name)).toEqual(['Cato', 'Seneca'])
  })
})

describe('conversation rows (Recent, Chats, ⌘K)', () => {
  const T = '2026-10-27T10:00:00.000Z'
  const member = (id: string, name: string, agentId: string | null): ForumMember => ({ id, companyId: 'co', kind: agentId ? 'agent' : 'human', role: 'member', agentId, handle: name.toLowerCase(), name, status: 'active', createdAt: T, data: {} }) as ForumMember
  const channel = (id: string, name: string, topic: string, purpose: string, memberIds: string[], at: string): ForumChannel => ({ id, companyId: 'co', kind: 'private', name, topic, purpose, departmentId: null, system: null, createdBy: 'me', createdAt: T, archivedAt: null, memberIds, lastSeq: 1, lastMessageAt: at, joined: true, lastReadSeq: 1, unread: 0, mentions: 0 })
  const members = [member('me', 'Lautaro', null), member('m1', 'Marcus', 'a1'), member('m2', 'Cato', 'a2')]
  const channels = [
    channel('c1', 'chat-newsletter-ab12', 'Write this week’s newsletter', 'Principia brought in Marcus (Content Writer) and Cato (Support Lead).', ['me', 'm1', 'm2'], '2026-10-27T10:05:00.000Z'),
    channel('c2', 'chat-loyalty-cd34', 'Loyalty card post', 'Principia brought in Marcus (Content Writer).', ['me', 'm1'], '2026-10-27T10:10:00.000Z'),
    channel('c3', 'chat-refund-ef56', 'Refund for table 4', 'A private conversation with Cato (Support Lead). Nobody else on the team sees it.', ['me', 'm2'], '2026-10-27T10:01:00.000Z'),
    channel('c4', 'marketing-plans', 'Not a conversation', '', ['me', 'm1'], '2026-10-27T10:20:00.000Z')
  ]
  it('only conversations, newest first, with who is in each and which are private', () => {
    const rows = conversationRows({ members, channels, presence: [] }, 'co')
    expect(rows.map((r) => r.id)).toEqual(['c2', 'c1', 'c3'])
    expect(rows.map((r) => whoLine(r))).toEqual(['Marcus', 'Marcus, Cato', 'Private · Cato'])
    // one agent Principia picked is not private; one you picked is
    expect(rows.find((r) => r.id === 'c2')!.private).toBe(false)
    expect(privateWith(rows, 'a2')?.id).toBe('c3')
    expect(privateWith(rows, 'a1')).toBeNull()
  })
  it('"answering…" belongs to the conversation the run answers in, not to every conversation with that agent', () => {
    const presence: ForumPresence[] = [{ companyId: 'co', memberId: 'm1', state: 'working', channelId: 'c2', at: T }]
    const rows = conversationRows({ members, channels, presence }, 'co')
    expect(rows.filter((r) => r.working).map((r) => r.id)).toEqual(['c2'])
    // presence with no channel (a board task run) makes no conversation answer
    expect(conversationRows({ members, channels, presence: [{ ...presence[0]!, channelId: null }] }, 'co').some((r) => r.working)).toBe(false)
  })
  it('a reply run’s title leads to its conversation and names the agent', () => {
    const rows = conversationRows({ members, channels, presence: [] }, 'co')
    expect(conversationOfRunTitle('Marcus replying in “Loyalty card post”', rows)).toEqual({ conv: rows[0], who: 'Marcus' })
    // a title clipped by the run list still finds it
    expect(conversationOfRunTitle('Cato replying in “Refund for tab…', rows)?.conv?.id).toBe('c3')
    // the older title had no name
    expect(conversationOfRunTitle('Replying in “Loyalty card post”', rows)).toEqual({ conv: rows[0], who: null })
    expect(conversationOfRunTitle('NC-12 · Fix the menu', rows)).toBeNull()
  })
})
