import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, Department } from '@shared/company'
import type { ForumChannel, ForumMember, ForumMessage, ForumState } from '@shared/forum'

// server markup needs a server snapshot; the stores pass only the client one
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
const forumCalls: string[] = []
const forumApi = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (forumCalls.push(k), void a, Promise.resolve(k === 'messages' ? { messages: [], hasMore: false } : null)) })
vi.stubGlobal('window', { hive: { forum: forumApi, on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('document', { hasFocus: () => true, getElementById: () => null, querySelector: () => null })

const CO = 'co_a'
const company = { id: CO, name: 'Acme', slug: 'acme', color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '' } as unknown as CompanyPassport
const marketing = { id: 'dep_m', companyId: CO, key: 'marketing', name: 'Marketing', color: 'var(--accent)', icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} } as Department
const copywriter = { id: 'agt_copy', companyId: CO, departmentId: 'dep_m', kind: 'profile', refId: 'p1', name: 'Copywriter', archivedAt: null, pausedAt: null, createdAt: '2026-10-20T00:00:00Z', updatedAt: '', data: { persona: { key: 'marcus', name: 'Marcus', personality: '', bio: '', look: { material: 'marble', hair: 'crop', beard: 'none', laurel: true, drape: 'purple' } } } } as unknown as CompanyAgent

const member = (id: string, p: Partial<ForumMember>): ForumMember => ({ id, companyId: CO, kind: 'human', role: 'member', agentId: null, handle: id, name: id, status: 'active', createdAt: '', data: {}, ...p })
const owner = member('fmb_owner', { role: 'owner', handle: 'lautaro', name: 'Lautaro' })
const marcus = member('fmb_marcus', { kind: 'agent', role: 'agent', agentId: 'agt_copy', handle: 'marcus', name: 'Marcus' })
const channel = (id: string, p: Partial<ForumChannel>): ForumChannel => ({ id, companyId: CO, kind: 'public', name: id, topic: '', purpose: '', departmentId: null, system: null, createdBy: null, createdAt: '2026-10-21T08:00:00Z', archivedAt: null, memberIds: [owner.id, marcus.id], lastSeq: 0, lastMessageAt: null, joined: true, lastReadSeq: 0, unread: 0, mentions: 0, ...p })
const msg = (seq: number, p: Partial<ForumMessage>): ForumMessage => ({ id: `fmsg_${seq}`, seq, ref: `m${seq.toString(36)}`, companyId: CO, channelId: 'fch_mkt', threadId: null, authorId: owner.id, kind: 'text', text: '', createdAt: `2026-10-21T09:0${seq % 10}:00Z`, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null, repliers: [], mentions: [], mentionDepartments: [], refs: [], reactions: {}, origin: 'local', ...p })

async function setup(messages: ForumMessage[], over: Partial<ForumState> = {}): Promise<void> {
  const { setState } = await import('../../state/store')
  setState({
    settings: { experimental: { companies: true, departments: true } } as never,
    companies: [company], companiesLoaded: true, activeCompanyId: CO, view: { name: 'forum' },
    departments: [marketing], companyAgents: [copywriter], tasks: [], profiles: []
  })
  const { resetForum } = await import('../../state/forum')
  const state: ForumState = {
    companyId: CO, me: owner.id, members: [owner, marcus],
    channels: [
      channel('fch_gen', { name: 'general', system: 'general' }),
      channel('fch_mkt', { name: 'marketing', system: 'department', departmentId: 'dep_m', purpose: 'Marketing: the department room.', unread: 2, mentions: 1 }),
      channel('fch_dm', { name: null, kind: 'dm', unread: 1 })
    ],
    presence: [{ companyId: CO, memberId: marcus.id, state: 'reading', channelId: 'fch_mkt', at: '' }],
    openAsks: 1, openProposals: 1, ...over
  }
  resetForum({ byCompany: { [CO]: { state, error: null, pages: { fch_mkt: { list: messages, hasMore: false, loading: false } }, threads: {} } } })
}

describe('lib/forum', () => {
  it('groups by author within 5 minutes, adds day and unread dividers', async () => {
    const { groupMessages } = await import('../../lib/forum')
    const a = msg(1, { createdAt: '2026-10-21T09:00:00Z' })
    const b = msg(2, { createdAt: '2026-10-21T09:02:00Z' })
    const c = msg(3, { createdAt: '2026-10-21T09:20:00Z' })
    const d = msg(4, { createdAt: '2026-10-21T09:21:00Z', authorId: marcus.id })
    const items = groupMessages([a, b, c, d], { lastReadSeq: 3, me: owner.id, now: new Date('2026-10-21T12:00:00Z') })
    expect(items.map((i) => (i.kind === 'msg' ? `${i.message.seq}${i.head ? 'H' : ''}` : i.kind))).toEqual(['day', '1H', '2', '3H', 'unread', '4H'])
  })
  it('tokenizes mentions, channels, tasks, notes, urls, code and message refs', async () => {
    const { tokenize } = await import('../../lib/forum')
    const t = tokenize('Hi @marcus see #marketing PRN-42 [[Stripe]] `x` https://a.dev m3fk\nok')
    expect(t.map((x) => x.t).filter((k) => k !== 'text')).toEqual(['mention', 'channel', 'task', 'note', 'code', 'url', 'msgref', 'br'])
  })
  it('finds the autocomplete trigger and ranks suggestions, working agents first', async () => {
    const { activeTrigger, suggest } = await import('../../lib/forum')
    expect(activeTrigger('hello @ma', 9)).toEqual({ trigger: '@', query: 'ma', start: 6 })
    expect(activeTrigger('/inv', 4)).toEqual({ trigger: '/', query: 'inv', start: 0 })
    expect(activeTrigger('mail a@b', 8)).toBeNull()
    const s = suggest('@', 'm', { members: [owner, { ...marcus, working: true }, member('fmb_m2', { kind: 'agent', role: 'agent', handle: 'maia', name: 'Maia' })], departments: [{ key: 'marketing', name: 'Marketing', agents: 1 }], channels: [], me: owner.id })
    expect(s.map((x) => x.label)).toEqual(['Marcus', 'Maia', 'Marketing'])
    expect(suggest('/', 'pro', { members: [], departments: [], channels: [], me: '' })[0].label).toBe('/propose')
  })
  it('parses slash commands', async () => {
    const { parseSlash } = await import('../../lib/forum')
    expect(parseSlash('/ask @ana @marcus Which tone? [playful | plain]')).toEqual({ cmd: 'ask', handles: ['ana', 'marcus'], question: 'Which tone?', options: ['playful', 'plain'] })
    expect(parseSlash('/invite @livia')).toEqual({ cmd: 'invite', handles: ['livia'] })
    expect(parseSlash('/propose hire')).toEqual({ cmd: 'propose', kind: 'agent' })
    expect(parseSlash('hello')).toBeNull()
  })
  it('sorts channels and counts mentions plus unread DMs', async () => {
    const { sortChannels, unreadTotals, presenceLine } = await import('../../lib/forum')
    const list = [channel('b', { name: 'zeta' }), channel('a', { name: 'general', system: 'general' }), channel('p', { name: 'proposals', system: 'proposals' }), channel('d', { name: null, kind: 'dm', unread: 2 })]
    expect(sortChannels(list).channels.map((c) => c.name)).toEqual(['general', 'zeta', 'proposals'])
    expect(unreadTotals([...list, channel('m', { mentions: 3 })]).mentions).toBe(5)
    expect(presenceLine([{ companyId: CO, memberId: marcus.id, state: 'reading', channelId: 'fch_mkt', at: '' }], channel('fch_mkt', { name: 'marketing' }), () => 'Marcus')).toBe('Marcus is reading #marketing')
  })
})

describe('ForumView', () => {
  it('renders the channel list with badges, grouped messages, ask and proposal cards, and presence', async () => {
    const messages = [
      msg(1, { authorId: marcus.id, text: 'Launch is Friday. @lautaro can I draft PRN-42?', mentions: [owner.id], refs: [{ kind: 'task', id: 'PRN-42', label: 'PRN-42' }] }),
      msg(2, { authorId: marcus.id, text: 'First draft is in.', replyCount: 2, repliers: [owner.id], lastReplyAt: '2026-10-21T09:10:00Z', reactions: { '👍': [owner.id] } }),
      msg(3, { authorId: marcus.id, kind: 'ask', text: '@lautaro Which tone?', ask: { status: 'open', to: [owner.id], options: ['Playful', 'Plain'], taskId: 'task_1' } }),
      msg(4, { authorId: marcus.id, kind: 'proposal', text: 'We need help', proposal: { kind: 'agent', status: 'open', reason: 'Organic traffic', agent: { departmentKey: 'marketing', role: 'Long-form writer', instructions: 'Write articles', capabilities: 'SEO' } } }),
      msg(5, { kind: 'system', text: 'Junia joined #marketing' })
    ]
    await setup(messages)
    const { ForumView } = await import('../../views/ForumView')
    const html = renderToStaticMarkup(createElement(ForumView, { companyId: CO, channelId: 'fch_mkt' }))
    expect(html).toContain('FORUM')
    expect(html).toMatch(/fm-nav__row is-selected is-unread[^>]*>.*?marketing.*?fm-badge--mention">1</)
    expect(html).toContain('1 ask')
    expect(html).toContain('1 proposal')
    expect(html).toContain('Copywriter')
    expect(html).toContain('fm-msg is-head is-mention')
    expect(html).toContain('2 replies')
    expect(html).toContain('Needs you · ask')
    expect(html).toMatch(/<button[^>]*>Playful<\/button>/)
    expect(html).toContain('parks its task until answered')
    expect(html).toContain('Proposal · new agent')
    expect(html).toContain('Long-form writer')
    expect(html).toContain('Approve…')
    expect(html).toMatch(/Junia joined <span class="fm-mention fm-mention--channel">#marketing</)
    expect(html).toContain('Marcus is reading #marketing')
    expect(html).toContain('Message #marketing')
    // agents show their bust (line art), humans an engraved coin
    expect(html).toContain('fm-coin')
    expect(html).toMatch(/class="[^"]*rm-bust|agent-face/)
  })

  it('shows the mosaic empty state in a new channel and the company picker in All mode', async () => {
    await setup([])
    const { ForumView } = await import('../../views/ForumView')
    const html = renderToStaticMarkup(createElement(ForumView, { companyId: CO, channelId: 'fch_mkt' }))
    expect(html).toContain('This is the very beginning of #marketing.')
    expect(html).toContain('rm-mosaic--forum')
    const { setState } = await import('../../state/store')
    setState({ activeCompanyId: 'all' })
    expect(renderToStaticMarkup(createElement(ForumView, {}))).toContain('Every company has its own Forum')
  })

  it('explains itself when departments are off', async () => {
    await setup([])
    const { setState } = await import('../../state/store')
    setState({ settings: { experimental: { companies: true, departments: false } } as never })
    const { ForumView } = await import('../../views/ForumView')
    expect(renderToStaticMarkup(createElement(ForumView, { companyId: CO }))).toContain('The Forum needs Companies and Departments')
  })
})

describe('forum mosaic', () => {
  it('uses only palette tiles on the 14 × 11 board with a purple border', async () => {
    const { forumTiles } = await import('./ForumMosaic')
    const tiles = forumTiles()
    expect(tiles).toHaveLength(154)
    expect(new Set(tiles.filter((t) => t.x < 1 || t.y < 1).map((t) => t.key))).toEqual(new Set(['p', 'P']))
    expect(tiles.every((t) => /^(var\(--rm-px|#)/.test(t.fill))).toBe(true)
  })
})
