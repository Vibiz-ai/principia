/** REMOTE.md: the phone app's view models and screens (pure: VNodes, no DOM). */
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSnapshot } from '../../shared/chat'
import { EMPTY_CHAT_META } from '../../shared/chat'
import type { PhoneNeeds, PhoneNow, PhoneRoomMember, PhoneTaskCard, PhoneTaskDetail, PhoneTaskRow, PhoneTasks } from '../../shared/remote'
import { findAll, textOf, type VNode } from '../console/dom'
import { ago, placeMessage, ChatLoad, ChatReplica, chatLines, chatMessageAction, terminalComposer, deviceName, headline, insertMention, mentionAt, mentionMatches, pairCode, parseRoute, routeHash } from './model'
import { renderAgent, renderNeeds, renderNow, renderRoom, renderSession, renderTasks, type Actions, type View } from './render'

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
  return { companies: [{ id: 'co_a', name: 'Northwind', personal: false, paused: false, working: 1, needs: 1 }], companyId: 'co_a', tab: 'now', online: true, error: null, toast: null, busy: new Set(), drafts: {}, picks: {}, now: null, needs: null, chats: null, room: null, session: null, replica: null, agent: null, tasks: null, task: null, taskId: null, openKind: null }
}
const btns = (t: VNode): string[] => findAll(t, (n) => n.tag === 'button').map((b) => textOf(b))

describe('the board (read only)', () => {
  it('routes: the list and one task', () => {
    expect(parseRoute('#/c/co_a/tasks')).toEqual({ companyId: 'co_a', tab: 'tasks', open: null })
    expect(parseRoute('#/c/co_a/tasks/ta_1')).toEqual({ companyId: 'co_a', tab: 'tasks', open: null, task: 'ta_1' })
    expect(routeHash({ companyId: 'co_a', tab: 'tasks', open: null, task: 'ta 1' })).toBe('#/c/co_a/tasks/ta%201')
    expect(routeHash({ companyId: 'co_a', tab: 'now', open: null, task: 'ta_1' })).toBe('#/c/co_a/now')
  })
  it('lists Needs you, Working, Planned and Done; a task shows its facts and the actions of its Needs you entry', () => {
    const row = (id: string, column: PhoneTaskRow['column'], x: Partial<PhoneTaskRow> = {}): PhoneTaskRow => ({ id, identifier: id.toUpperCase(), title: `Task ${id}`, status: 'todo', column, who: null, agentId: null, line: null, priority: 0, at: T, ...x })
    const tasks: PhoneTasks = { companyId: 'co_a', planned: [row('p1', 'planned')], working: [row('w1', 'working', { status: 'in_progress', who: { name: 'Livia', role: '', bust: null }, line: 'Editing the menu' })], needs: [row('n1', 'needs', { status: 'in_review', line: 'Ready for your OK' })], done: [row('d1', 'done', { status: 'done' })], more: 2 }
    const s = textOf(renderTasks({ ...baseView(), tab: 'tasks', tasks }, noop, Date.parse(T)))
    for (const w of ['Needs you · 1', 'Working · 1', 'Planned · 1', 'Done this week · 1', 'Editing the menu', 'And 2 more on your Mac', 'Read only']) expect(s).toContain(w)
    const task: PhoneTaskDetail = { ...row('n1', 'needs', { status: 'in_review' }), description: 'Seven posts for spring.', summary: 'All seven are drafted.', doneNote: null, createdAt: T, updatedAt: T, need: { taskId: 'n1', kind: 'review', title: 'Task n1', text: 'All seven are drafted.', who: null, agentId: null, at: T, options: [] } }
    const one = renderTasks({ ...baseView(), tab: 'tasks', task, taskId: 'n1' }, noop, Date.parse(T))
    expect(textOf(one)).toContain('Seven posts for spring.')
    expect(textOf(one)).toContain('Waiting for your OK')
    expect(btns(one)).toEqual(expect.arrayContaining(['Approve', 'Send back', 'Not needed']))
  })
})

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
  it('Now shows the Autopilot switch read-only, and nothing while paused', () => {
    const now: PhoneNow = { companyId: 'co_a', name: 'Northwind', paused: false, autopilot: 'on', needs: 0, working: [], done: [] }
    expect(textOf(renderNow({ ...baseView(), now }, noop, Date.parse(T)))).toContain('Quiet right nowAutopilot on')
    expect(btns(renderNow({ ...baseView(), now }, noop, Date.parse(T)))).not.toContain('Autopilot on')
    expect(textOf(renderNow({ ...baseView(), now: { ...now, paused: true, autopilot: 'held' } }, noop, Date.parse(T)))).not.toContain('Autopilot')
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
  it('a task started in a conversation shows as a compact card with its state (CHAT-UI.md §8)', () => {
    const card = (state: string, label: string, extra: Partial<PhoneTaskCard> = {}): PhoneTaskCard => ({ identifier: 'VO-9', title: 'Lift UGC conversion', state, label, result: null, prUrl: null, startedAt: T, finishedAt: null, ...extra })
    const msg = (task: PhoneTaskCard) => ({ id: 'c1', seq: 2, channelId: 'ch', threadId: 'r', authorId: 'm1', kind: 'system' as const, text: 'Julia started VO-9: Lift UGC conversion', at: T, task })
    const room = { companyId: 'co_a', enabled: true, message: null, me: 'm1', channelId: 'ch', channels: [{ id: 'ch', label: '#chat-ugc' }], members: [], answering: [] }
    const now = Date.parse(T) + 2 * 60_000
    const working = renderRoom({ ...baseView(), tab: 'room', room: { ...room, messages: [msg(card('working', 'Working'))] } }, noop, now)
    const node = findAll(working, (n) => n.attrs?.class === 'tcard is-working')
    expect(node).toHaveLength(1)
    expect(textOf(node[0]!)).toContain('VO-9')
    expect(textOf(node[0]!)).toContain('Working · 2m')
    expect(findAll(working, (n) => n.attrs?.class === 'tes tes--run')).toHaveLength(1)
    const done = renderRoom({ ...baseView(), tab: 'room', room: { ...room, messages: [msg(card('done', 'Done', { result: 'Rewrote the hero', prUrl: 'https://github.com/a/b/pull/7', finishedAt: '2026-10-25T10:05:00.000Z' }))] } }, noop, now + 3_600_000)
    expect(textOf(done)).toContain('Done · 5m')
    expect(textOf(done)).toContain('Rewrote the hero')
    expect(findAll(done, (n) => n.tag === 'a' && n.attrs?.href === 'https://github.com/a/b/pull/7')).toHaveLength(1)
    // the plain line is not repeated next to the card
    expect(textOf(done)).not.toContain('Julia started VO-9')
  })
  it('a queued message offers Send now', () => {
    const r = new ChatReplica({ ...snap(), turn: 'working', queue: [{ id: 'q1', text: 'Change of plan', images: 0 }] } as ChatSnapshot)
    const v = { ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 'Chat', who: null, chat: r.snap, terminal: null }, replica: r } as View
    expect(btns(renderSession(v, noop))).toContain('Stop and send now')
  })
  it('a terminal on the Mac reads as its chat: no dead end, its ask in place, its screen when it has no transcript', () => {
    const items: ChatItem[] = [{ id: 'u1', parent: null, kind: 'user', text: 'Fix the footer', images: 0, state: 'sent' }, tool('b1', 'Bash', { command: 'npm test' }, 'running')]
    const r = new ChatReplica({ ...snap(items), mode: 'terminal', available: false, turn: 'working', activity: 'Running npm test' } as ChatSnapshot)
    const askOne = { id: 'ask_1', title: 'Bash', question: 'Run git push?', detail: 'git push', who: null, options: [{ id: 'allow', label: 'Allow', kind: 'allow' as const }, { id: 'deny', label: 'Deny', kind: 'deny' as const }], text: false, at: T, open: null }
    const term = { activity: 'Running npm test', canReply: false, ended: false, canType: true, held: null, source: 'transcript' as const, screen: null, asks: [askOne], canContinue: false }
    const tree = renderSession({ ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 'shop · Claude', who: null, chat: r.snap, terminal: term }, replica: r } as View, noop)
    const words = textOf(tree)
    expect(words).toContain('Fix the footer')
    expect(words).toContain('Run git push?')
    expect(words).not.toMatch(/You can reply here when it waits/)
    expect(btns(tree)).toEqual(expect.arrayContaining(['Allow', 'Deny']))
    const screenOnly = renderSession({ ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 't', who: null, chat: snap([], 0), terminal: { ...term, source: 'screen' as const, screen: 'Reading footer.html', asks: [] } }, replica: new ChatReplica(snap([], 0)) } as View, noop)
    expect(findAll(screenOnly, (n) => n.tag === 'pre').map((p) => textOf(p))).toEqual(['Reading footer.html'])
  })
  it('an ask inside its own conversation reads as a plain question, with no face and no link to itself (PQ-13)', () => {
    const r = new ChatReplica({ ...snap([]), mode: 'terminal', available: false, turn: 'needs' } as ChatSnapshot)
    const askOne = { id: 'ask_1', title: 'Bash F=/var/tmp/x/scr', heading: 'Run a command?', question: null, detail: 'F=/var/tmp/x/scr ls', who: { name: 'QA term C', role: 'Your chat with Claude', bust: null }, options: [{ id: 'allow', label: 'Allow', kind: 'allow' as const }], text: false, at: T, open: { kind: 'session' as const, id: 'se_1' } }
    const term = { activity: null, canReply: false, ended: false, canType: false, held: 'It is asking you something.', source: 'transcript' as const, screen: null, asks: [askOne], canContinue: false }
    const words = textOf(renderSession({ ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 'QA term C', who: null, chat: r.snap, terminal: term }, replica: r } as View, noop))
    expect(words).toContain('Run a command?')
    expect(words).not.toContain('Bash F=')
    expect(words).not.toContain('Your chat with Claude')
    expect(words).not.toContain('Open the conversation')
  })
  it('a terminal opened before its transcript reloads on the Mac’s empty chat ops; a chat applies them', () => {
    const term = { activity: null, canReply: false, ended: false, canType: true, held: null, source: 'screen' as const, screen: 'Reading', asks: [], canContinue: false }
    const session = { ref: { kind: 'session' as const, id: 'se_1' }, title: 't', who: null, chat: null, terminal: term }
    expect(chatMessageAction({ openId: 'se_1', session, hasReplica: false }, 'se_1')).toBe('reload')
    expect(chatMessageAction({ openId: 'se_1', session, hasReplica: true }, 'se_1')).toBe('apply')
    expect(chatMessageAction({ openId: 'se_2', session, hasReplica: false }, 'se_1')).toBe('ignore')
    expect(chatMessageAction({ openId: 'se_1', session: { ...session, terminal: null }, hasReplica: false }, 'se_1')).toBe('ignore')
  })
  it('the terminal composer: held shows the reason with Send off; ended and a shell have none', () => {
    const t = { activity: null, canReply: false, ended: false, canType: true, held: null }
    expect(terminalComposer(t, 'Claude')).toEqual({ placeholder: 'Message Claude', held: false })
    expect(terminalComposer({ ...t, canType: false, held: 'It is asking you something.' }, 'Claude')).toEqual({ placeholder: 'It is asking you something.', held: true })
    expect(terminalComposer({ ...t, canType: false, canReply: true, held: null }, 'Gemini')).toEqual({ placeholder: 'Message Gemini', held: false })
    expect(terminalComposer({ ...t, canType: false, held: null }, 'Shell')).toBeNull()
    expect(terminalComposer({ ...t, ended: true }, 'Claude')).toBeNull()
  })
  it('an ended terminal shows its history and offers Continue', () => {
    const r = new ChatReplica({ ...snap([{ id: 'u1', parent: null, kind: 'user', text: 'Fix the footer', images: 0, state: 'sent' }]), mode: 'terminal', available: false, turn: 'ended' } as ChatSnapshot)
    const term = { activity: null, canReply: false, ended: true, canType: false, source: 'transcript' as const, canContinue: true }
    const tree = renderSession({ ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 't', who: null, chat: r.snap, terminal: term }, replica: r } as View, noop)
    expect(textOf(tree)).toContain('Fix the footer')
    expect(btns(tree)).toContain('Continue')
    expect(btns(renderSession({ ...baseView(), session: { ref: { kind: 'session', id: 'se_1' }, title: 't', who: null, chat: null, terminal: { ...term, canContinue: false, source: null } }, replica: null } as View, noop))).not.toContain('Continue')
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

describe('opening a chat while it streams (PQ-02, PQ-06)', () => {
  const text = (id: string, md: string): ChatItem => ({ id, parent: null, kind: 'text', md, streaming: false }) as ChatItem
  const later = (): { p: Promise<void>; go: () => void } => {
    let go!: () => void
    const p = new Promise<void>((r) => (go = r))
    return { p, go }
  }
  it('ops that arrive while the snapshot is on the way go on top of it; ones it has are skipped', async () => {
    const load = new ChatLoad()
    const gate = later()
    let r: ChatReplica | null = null
    const done = load.run('se_1', async () => {
      await gate.p
      r = new ChatReplica(snap([text('t1', 'draws its shapes')], 762))
      return r
    })
    expect(load.hold('se_1', 762, [{ op: 'append', id: 't1', field: 'md', text: ' twice' }])).toBe(true)
    expect(load.hold('se_1', 763, [{ op: 'append', id: 't1', field: 'md', text: ' from science' }])).toBe(true)
    expect(load.hold('se_1', 764, [{ op: 'state', turn: 'idle' }])).toBe(true)
    expect(load.hold('se_2', 9, [])).toBe(false)
    gate.go()
    await done
    expect(r!.snap.seq).toBe(764)
    expect((r!.items[0] as { md: string }).md).toBe('draws its shapes from science')
    expect(r!.snap.turn).toBe('idle')
    expect(load.hold('se_1', 765, [])).toBe(false)
  })
  it('an ack ahead of the snapshot fetches once more (the ops fell between the two)', async () => {
    const load = new ChatLoad()
    const seqs = [762, 764]
    let fetches = 0
    const gate = later()
    const done = load.run('se_1', async () => {
      if (fetches === 0) await gate.p
      return new ChatReplica(snap([], seqs[fetches++]))
    })
    expect(load.acked('se_1', 764)).toBe(true)
    gate.go()
    await done
    expect(fetches).toBe(2)
  })
  it('asks while one fetch is out run once more after it, never in parallel, so an older answer never lands last', async () => {
    const load = new ChatLoad()
    let inFlight = 0
    let most = 0
    let fetches = 0
    const gates = [later(), later()]
    const f = async (): Promise<ChatReplica> => {
      inFlight++
      most = Math.max(most, inFlight)
      await gates[fetches]!.p
      fetches++
      inFlight--
      return new ChatReplica(snap([], 10 + fetches))
    }
    const a = load.run('se_1', f)
    const b = load.run('se_1', f)
    const c = load.run('se_1', f)
    expect(a).toBe(b)
    expect(b).toBe(c)
    gates[0]!.go()
    gates[1]!.go()
    await a
    expect(fetches).toBe(2)
    expect(most).toBe(1)
  })
  it('a gap among the held ops fetches again', async () => {
    const load = new ChatLoad()
    let fetches = 0
    const gate = later()
    const done = load.run('se_1', async () => {
      if (fetches++ === 0) await gate.p
      return new ChatReplica(snap([], 5))
    })
    load.hold('se_1', 8, [])
    gate.go()
    await done
    expect(fetches).toBe(2)
  })
})
