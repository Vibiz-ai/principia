/** REMOTE.md: the phone app's view models and screens (pure: VNodes, no DOM). */
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSnapshot } from '../../shared/chat'
import { EMPTY_CHAT_META } from '../../shared/chat'
import type { PhoneNeeds, PhoneNow, PhoneRoomMember } from '../../shared/remote'
import { findAll, textOf, type VNode } from '../console/dom'
import { ago, placeMessage, ChatReplica, chatLines, deviceName, headline, insertMention, mentionAt, mentionMatches, pairCode, parseRoute, routeHash } from './model'
import { renderAgent, renderNeeds, renderNow, renderRoom, renderSession, type Actions, type View } from './render'

const T = '2026-10-25T10:00:00.000Z'
const snap = (items: ChatItem[] = [], seq = 1): ChatSnapshot => ({ sessionId: 'se_1', mode: 'chat', available: true, turn: 'idle', activity: null, turnStartedAt: null, items, queue: [], meta: { ...EMPTY_CHAT_META }, seq, note: null })
const tool = (id: string, name: string, input: Record<string, unknown>, status: 'running' | 'ok' | 'error' = 'ok'): ChatItem => ({ id, parent: null, kind: 'tool', toolUseId: `tu_${id}`, name, input, inputPartial: '', status, resultText: '', resultTruncated: false, startedAt: null, ms: null })

describe('routes', () => {
  it('round-trips tabs and an open conversation', () => {
    const r = { companyId: 'co_a', tab: 'chats' as const, open: { kind: 'session' as const, id: 'se_1' } }
    expect(parseRoute(routeHash(r))).toEqual(r)
    expect(parseRoute('#/c/co_a/room')).toEqual({ companyId: 'co_a', tab: 'room', open: null })
    expect(parseRoute('#/c/co_a/bogus')).toEqual({ companyId: 'co_a', tab: 'now', open: null })
    expect(parseRoute('#/')).toEqual({ companyId: null, tab: 'now', open: null })
    expect(parseRoute('#/c/co_a/now/session/se_1').open).toBeNull()
  })
  it('reads the pairing code from the fragment only when it is a code', () => {
    expect(pairCode(`#pair=${'a'.repeat(32)}`)).toBe('a'.repeat(32))
    expect(pairCode('#pair=<script>')).toBeNull()
    expect(pairCode('#/c/co_a/now')).toBeNull()
  })
})

describe('words', () => {
  it('ago, headline, device name', () => {
    const now = Date.parse(T)
    expect(ago(T, now + 10_000)).toBe('now')
    expect(ago(T, now + 4 * 60_000)).toBe('4m')
    expect(ago(T, now + 3 * 3600_000)).toBe('3h')
    expect(headline({ working: 2, needs: 1, paused: false })).toBe('2 working · 1 needs you')
    expect(headline({ working: 0, needs: 0, paused: false })).toBe('Quiet right now')
    expect(headline({ working: 0, needs: 3, paused: true })).toBe('Paused · 3 need you')
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone')
  })
})

describe('chat replica (the Mac’s own ops, resnapshot on a gap)', () => {
  it('applies numbered ops and reports a gap', () => {
    const r = new ChatReplica(snap([], 3))
    expect(r.apply(4, [{ op: 'add', item: { id: 'u1', parent: null, kind: 'user', text: 'hi', images: 0, state: 'sent' } }, { op: 'state', turn: 'working', activity: 'Reading plans.ts' }])).toBe('ok')
    expect(r.items).toHaveLength(1)
    expect(r.busy).toBe(true)
    expect(r.snap.activity).toBe('Reading plans.ts')
    expect(r.apply(4, [])).toBe('old')
    expect(r.apply(6, [])).toBe('gap')
    expect(r.apply(5, [{ op: 'add', item: { id: 't1', parent: null, kind: 'text', md: 'Hel', streaming: true } }, { op: 'append', id: 't1', field: 'md', text: 'lo' }])).toBe('ok')
    expect((r.items[1] as { md: string }).md).toBe('Hello')
  })
})

describe('chat lines (plain words, approvals as buttons)', () => {
  it('tools read as words, reads fold into one line, approvals are cards', () => {
    const lines = chatLines([
      { id: 'u1', parent: null, kind: 'user', text: 'Fix the menu', images: 0, state: 'sent' },
      tool('r1', 'Read', { file_path: '/x/plans.ts' }),
      tool('r2', 'Grep', { pattern: 'menu' }),
      tool('b1', 'Bash', { command: 'npm test' }, 'running'),
      { id: 'p1', parent: null, kind: 'permission', requestId: 'req_1', toolUseId: null, tool: 'Bash', input: { command: 'git push' }, description: null, suggestions: [], blockedPath: null, state: 'open', outcome: null },
      { id: 'e1', parent: null, kind: 'turnEnd', ms: 72_000, files: [{ path: 'a', add: 1, del: 0 }], costUsd: null, error: null }
    ])
    expect(lines.map((l) => l.t)).toEqual(['me', 'tool', 'tool', 'permission', 'end'])
    const [, group, bash, perm, end] = lines
    expect(group).toMatchObject({ text: 'Read 1 file, searched 1 pattern' })
    expect(bash).toMatchObject({ status: 'run' })
    expect((bash as { text: string }).text).not.toMatch(/^Bash/)
    // the command is its own line, never run into the words
    expect(bash).toMatchObject({ code: 'npm test' })
    expect((bash as { text: string }).text).not.toContain('npm test')
    expect(perm).toMatchObject({ title: 'Claude wants to run a command', detail: 'git push', open: true })
    expect(end).toMatchObject({ text: 'Done in 1m 12s · 1 file changed' })
  })
  it('a session screen draws Allow and Deny for an open permission, and agent text stays text', () => {
    const r = new ChatReplica(snap([{ id: 't', parent: null, kind: 'text', md: '<img src=x onerror=alert(1)>', streaming: false }, { id: 'p1', parent: null, kind: 'permission', requestId: 'req_1', toolUseId: null, tool: 'Edit', input: { file_path: '/a/menu.md' }, description: null, suggestions: [], blockedPath: null, state: 'open', outcome: null }]))
    const v = { ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 'Chat', who: null, chat: r.snap, terminal: null }, replica: r } as View
    const tree = renderSession(v, noop)
    const buttons = findAll(tree, (n) => n.tag === 'button').map((b) => textOf(b))
    expect(buttons).toEqual(expect.arrayContaining(['Allow', 'Deny']))
    expect(findAll(tree, (n) => n.tag === 'img')).toHaveLength(0)
    expect(textOf(tree)).toContain('<img src=x onerror=alert(1)>')
    expect(textOf(tree)).toContain('Claude wants to edit menu.md')
  })
})

describe('@mentions', () => {
  const members: PhoneRoomMember[] = [
    { id: 'm1', handle: 'you', name: 'You', kind: 'human', role: null },
    { id: 'm2', handle: 'livia', name: 'Livia', kind: 'agent', role: 'Copywriter' },
    { id: 'm3', handle: 'lucius', name: 'Lucius', kind: 'agent', role: 'Front desk' }
  ]
  it('finds the word at the caret, suggests agents, inserts the handle', () => {
    expect(mentionAt('hi @li', 6)).toEqual({ start: 3, query: 'li' })
    expect(mentionAt('mail@li', 7)).toBeNull()
    expect(mentionMatches(members, 'l', 'm1').map((m) => m.handle)).toEqual(['livia', 'lucius'])
    expect(mentionMatches(members, '', 'm1').map((m) => m.handle)).not.toContain('you')
    expect(insertMention('hi @li please', 3, 6, 'livia')).toEqual({ text: 'hi @livia  please', caret: 10 })
  })
})

// ---------- screens ----------
const noop = new Proxy({}, { get: () => () => undefined }) as Actions
function baseView(): View {
  return { companies: [{ id: 'co_a', name: 'Northwind', personal: false, paused: false, working: 1, needs: 1 }], companyId: 'co_a', tab: 'now', online: true, error: null, toast: null, busy: new Set(), drafts: {}, picks: {}, now: null, needs: null, chats: null, room: null, session: null, replica: null, agent: null, openKind: null }
}
const btns = (t: VNode): string[] => findAll(t, (n) => n.tag === 'button').map((b) => textOf(b))

describe('screens', () => {
  it('Now: who works, with the live sentence, and what finished', () => {
    const now: PhoneNow = { companyId: 'co_a', name: 'Northwind', paused: false, needs: 1, working: [{ key: 'w', who: { name: 'Livia', role: 'Copywriter', bust: 'Livia' }, title: 'Spring menu', activity: 'Checking the menu file', startedAt: T, open: { kind: 'agent', id: 'ag_a' } }], done: [{ key: 'd', title: 'Instagram week', who: null, at: T, status: 'review', summary: 'Seven posts' }] }
    const t = renderNow({ ...baseView(), now }, noop, Date.parse(T))
    const s = textOf(t)
    expect(s).toContain('1 working · 1 needs you')
    expect(s).toContain('Livia · Copywriter')
    expect(s).toContain('Checking the menu file')
    expect(s).toContain('waiting for your OK')
  })
  it('Needs you: the same actions as Home (an ask’s options, Approve and Send back, an answer box)', () => {
    const needs: PhoneNeeds = {
      companyId: 'co_a',
      count: 3,
      asks: [{ id: 'ask_1', title: 'Run npm test', question: null, detail: 'npm test', who: null, options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }], text: false, at: T, open: null }],
      tasks: [
        { taskId: 'ta_1', kind: 'review', title: 'Instagram week', text: 'Seven posts are ready.', who: null, agentId: 'ag_a', at: T, options: [] },
        { taskId: 'ta_2', kind: 'question', title: 'Prices', text: 'Raise the latte price?', who: null, agentId: null, at: T, options: ['Yes', 'No'] }
      ]
    }
    const t = renderNeeds({ ...baseView(), tab: 'needs', needs }, noop)
    expect(btns(t)).toEqual(expect.arrayContaining(['Allow', 'Deny', 'Approve', 'Send back', 'Yes', 'No', 'Send']))
    // every task that waits on you can be turned down (Not needed), as on the Mac
    expect(btns(t).filter((b) => b === 'Not needed')).toHaveLength(2)
    expect(findAll(t, (n) => n.tag === 'textarea')).toHaveLength(1)
    // a short lettered tag, then the task's title in plain type (long titles stay readable)
    expect(findAll(t, (n) => n.attrs.class === 'kicker').map(textOf)).toEqual(['Ready for your OK', 'A question'])
    expect(findAll(t, (n) => n.attrs.class === 'card__t').map(textOf)).toEqual(['Instagram week', 'Prices'])
  })
  it('Send back opens its box (Needs you and the conversation), then sends what you wrote', () => {
    const needs: PhoneNeeds = { companyId: 'co_a', count: 1, asks: [], tasks: [{ taskId: 'ta_1', kind: 'review', title: 'Instagram week', text: 'Seven posts are ready.', who: null, agentId: 'ag_a', at: T, options: [] }] }
    const drafts: Record<string, string> = {}
    const sent: string[] = []
    const a = new Proxy({}, { get: (_t, k) => (k === 'draft' ? (key: string, v: string) => (drafts[key] = v) : k === 'sendBack' ? (id: string) => sent.push(id) : () => undefined) }) as Actions
    const click = (t: VNode, label: string): void => void (findAll(t, (n) => n.tag === 'button' && textOf(n) === label)[0]!.on.click!(new Event("click")))
    click(renderNeeds({ ...baseView(), tab: 'needs', needs, drafts }, a), 'Send back')
    const open = renderNeeds({ ...baseView(), tab: 'needs', needs, drafts }, a)
    expect(findAll(open, (n) => n.tag === 'textarea')).toHaveLength(1)
    expect(btns(open)).toEqual(expect.arrayContaining(['Send back', 'Cancel']))
    drafts['back:ta_1'] = 'Shorter captions'
    click(renderNeeds({ ...baseView(), tab: 'needs', needs, drafts }, a), 'Send back')
    expect(sent).toEqual(['ta_1'])
    // the same box in the agent's conversation, not a jump to another tab
    const agent = { ref: { kind: 'agent' as const, id: 'ag_a' }, who: { name: 'Livia', role: 'Copywriter', bust: null }, status: 'Waiting for your OK', items: [{ kind: 'agent' as const, id: 'i1', at: T, taskId: 'ta_1', text: 'Ready.', card: 'review' as const }] }
    const t = renderAgent({ ...baseView(), agent, drafts: { 'back:ta_1:open': '1' } } as View, a)
    expect(findAll(t, (n) => n.tag === 'textarea')).toHaveLength(1)
  })
  it('the team room lists who is who and who is replying', () => {
    const room = { companyId: 'co_a', enabled: true, message: null, me: 'm1', channelId: 'ch', channels: [{ id: 'ch', label: '#general' }], members: [{ id: 'm1', handle: 'you', name: 'You', kind: 'human' as const, role: null }, { id: 'm2', handle: 'pliny', name: 'Pliny', kind: 'agent' as const, role: 'Ads' }], messages: [], answering: ['Pliny'] }
    const closed = renderRoom({ ...baseView(), tab: 'room', room }, noop)
    expect(textOf(closed)).toContain('Pliny is replying…')
    expect(btns(closed).join(' ')).toContain('1 agent · who')
    const open = renderRoom({ ...baseView(), tab: 'room', room, drafts: { 'room:who:open': '1' } }, noop)
    expect(textOf(open)).toContain('Ads')
    expect(textOf(open)).toContain('@pliny')
    expect(textOf(renderRoom({ ...baseView(), tab: 'room', room: { ...room, members: [room.members[0]!], answering: [] } }, noop))).toContain('No agents in this company yet')
  })
  it('a queued message offers Send now', () => {
    const r = new ChatReplica({ ...snap(), turn: 'working', queue: [{ id: 'q1', text: 'Change of plan', images: 0 }] } as ChatSnapshot)
    const v = { ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 'Chat', who: null, chat: r.snap, terminal: null }, replica: r } as View
    expect(btns(renderSession(v, noop))).toContain('Stop and send now')
  })
  it('Needs you, empty: says so plainly', () => {
    expect(textOf(renderNeeds({ ...baseView(), needs: { companyId: 'co_a', count: 0, asks: [], tasks: [] } }, noop))).toContain('Nothing needs you')
  })
})

describe('team room order', () => {
  it('a thread reply lands after its root and its earlier replies; duplicates are dropped', () => {
    const l = [{ id: 'a', threadId: null }, { id: 'a1', threadId: 'a' }, { id: 'b', threadId: null }]
    expect(placeMessage(l, { id: 'a2', threadId: 'a' }).map((m) => m.id)).toEqual(['a', 'a1', 'a2', 'b'])
    expect(placeMessage(l, { id: 'c', threadId: null }).map((m) => m.id)).toEqual(['a', 'a1', 'b', 'c'])
    expect(placeMessage(l, { id: 'b', threadId: null })).toHaveLength(3)
  })
})
