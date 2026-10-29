import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentNode, Ask } from '@shared/live'
import type { ForumMessage } from '@shared/forum'
import type { ForumTaskCard, StripTask } from '@shared/taskCard'
import { cardsOfMessages, connectToolsIn, dockedTasks, dockMark, dockRefLine, dockRows, dockSummary, openDocked, parseDockPrefs, questionText, isOpenTaskQuestion, openAskOfRun, parseRunStarts, rootOfRun, runStartsKey, stripTasks, tailLines, taskCardView } from './taskCardView'

const T0 = '2026-10-27T10:00:00.000Z'
const NOW = Date.parse(T0) + 125_000
const card = (over: Partial<ForumTaskCard> = {}): ForumTaskCard => ({ taskId: 't9', identifier: 'VO-9', title: 'Lift UGC conversion', agentId: 'agt_julia', filedBy: 'fm_julia', state: 'queued', runId: null, startedAt: T0, ...over })
const node = (over: Partial<AgentNode>): AgentNode => ({ id: 'ag1', kind: 'step', parentId: null, rootId: 'ag1', runId: 'r1', status: 'working', activity: 'Read docs/funnel.md', updatedAt: T0, ...over }) as AgentNode

describe('taskCardView: the live card (CHAT-UI.md §8)', () => {
  it('without the live task, shows the stored state', () => {
    const v = taskCardView(card({ state: 'working', runId: 'r1' }), null, { now: NOW })
    expect(v).toMatchObject({ state: 'working', label: 'Working', runId: 'r1', onBoard: false, elapsed: '2m' })
  })
  it('working: the run root\'s activity line, in plain words for a company without code', () => {
    const t = { status: 'in_progress' as const, runId: 'r1', updatedAt: T0 }
    expect(taskCardView(card(), t, { root: node({}), now: NOW })).toMatchObject({ state: 'working', activity: expect.stringContaining('funnel.md'), runId: 'r1' })
    expect(taskCardView(card(), t, { root: node({ activity: 'Bash npm test' }), code: false, now: NOW }).activity).toBe('Working on it')
    // a root that ended does not keep talking
    expect(taskCardView(card(), t, { root: node({ status: 'done' }), now: NOW }).activity).toBeNull()
  })
  it('needs you: a live ask jumps to the run; a board ask is answered in the card', () => {
    const t = { status: 'in_progress' as const, runId: 'r1', updatedAt: T0 }
    const ask = { id: 'a1', status: 'open', runId: 'r1', title: 'Allow Bash curl posthog.com?' } as Ask
    expect(taskCardView(card(), t, { ask, now: NOW })).toMatchObject({ state: 'needs_you', label: 'Needs you', needs: { prompt: 'Allow Bash curl posthog.com?', live: true } })
    const asked = { ...t, ask: { kind: 'choice' as const, prompt: 'Which page first?', options: ['Landing', 'Pricing'] } }
    expect(taskCardView(card(), asked, { now: NOW }).needs).toEqual({ prompt: 'Which page first?', options: ['Landing', 'Pricing'], live: false })
  })
  it('done: the one-line result, the PR, and a clock that stopped', () => {
    const t = { status: 'done' as const, runId: 'r1', updatedAt: '2026-10-27T10:04:00.000Z', report: { outcome: 'review' as const, summary: 'Rewrote the hero\nmore', evidence: [], at: T0 }, work: { pr: { url: 'https://github.com/a/b/pull/7' } } as never }
    const v = taskCardView(card(), t, { now: NOW + 3_600_000 })
    expect(v).toMatchObject({ state: 'done', label: 'Done', result: 'Rewrote the hero', prUrl: 'https://github.com/a/b/pull/7', elapsed: '4m', activity: null, needs: null })
  })
  it('in review and failed', () => {
    expect(taskCardView(card(), { status: 'in_review', runId: 'r1', updatedAt: T0, doneNote: null, report: null }, { now: NOW }).label).toBe('In review')
    expect(taskCardView(card(), { status: 'blocked', blockReason: 'run_failed', runId: 'r1', updatedAt: T0 }, { now: NOW }).label).toBe('Failed')
  })
})

describe('live sources', () => {
  it('the run root is the newest top-level agent of the run; open asks by run', () => {
    const agents = [node({ id: 'sub', parentId: 'ag1' }), node({ id: 'old', updatedAt: '2026-10-27T09:00:00.000Z' }), node({ id: 'new', updatedAt: '2026-10-27T10:05:00.000Z' }), node({ id: 'other', runId: 'r2' })]
    expect(rootOfRun(agents, 'r1')!.id).toBe('new')
    expect(rootOfRun(agents, null)).toBeNull()
    const asks = [{ id: 'x', status: 'answered', runId: 'r1' }, { id: 'y', status: 'open', runId: 'r1' }] as Ask[]
    expect(openAskOfRun(asks, 'r1')!.id).toBe('y')
    expect(openAskOfRun(asks, 'r2')).toBeNull()
  })
  it('the strip reads every task a conversation started, once, with the live state', () => {
    const msg = (task: ForumTaskCard | undefined, id: string): ForumMessage => ({ id, task } as ForumMessage)
    const msgs = [msg(undefined, 'm1'), msg(card(), 'm2'), msg(card({ taskId: 't8', identifier: 'VO-8', agentId: 'agt_junia' }), 'm3'), msg(card({ state: 'working' }), 'm4')]
    const tasks = [{ id: 't9', status: 'in_progress' as const, runId: 'r1', updatedAt: T0, agentId: 'agt_julia' }, { id: 't8', status: 'done' as const, runId: null, updatedAt: T0, agentId: 'agt_junia' }]
    const names: Record<string, string> = { agt_julia: 'Julia', agt_junia: 'Junia' }
    const items = stripTasks(cardsOfMessages(msgs), tasks, (id) => (id ? names[id]! : null), new Set(['r1']))
    expect(items.map((i) => [i.identifier, i.who, i.state])).toEqual([['VO-9', 'Julia', 'needs_you'], ['VO-8', 'Junia', 'done']])
  })
  it('the strip clock of a working task is its run start (a primitive key, so agent churn does not re-render it)', () => {
    const agents = [node({ id: 'a', runId: 'r1', startedAt: '2026-10-27T10:01:00.000Z' } as Partial<AgentNode>), node({ id: 'sub', runId: 'r1', parentId: 'a' }), node({ id: 'b', runId: 'r9' })]
    const key = runStartsKey(agents, new Set(['r1']))
    expect(key).toBe('r1=2026-10-27T10:01:00.000Z')
    expect(runStartsKey(agents, new Set())).toBe('')
    const starts = parseRunStarts(key)
    const tasks = [{ id: 't9', status: 'in_progress' as const, runId: 'r1', updatedAt: T0, agentId: 'agt_julia' }]
    const [it9] = stripTasks([card()], tasks, () => 'Julia', new Set(), (r) => starts.get(r) ?? null)
    expect(it9).toMatchObject({ state: 'working', since: '2026-10-27T10:01:00.000Z' })
    // queued: no run clock
    expect(stripTasks([card()], [{ ...tasks[0]!, status: 'todo' as const, runId: null }], () => 'Julia')[0]!.since).toBeNull()
  })
})

describe('the live tail and the working clock', () => {
  const ev = (seq: number, over: Partial<AgentEvent>): AgentEvent => ({ seq, agentId: 'ag1', ts: T0, kind: 'tool', toolUseId: null, name: null, summary: '', detail: null, state: 'ok', ...over })
  it('tool calls in words, the latest message, last N in order; thinking and answers left out', () => {
    const events = [
      ev(1, { name: 'Read', summary: 'Read /repo/src/old.ts' }),
      ev(2, { name: 'Read', summary: 'Read /repo/src/shared/taskCard.ts' }),
      ev(3, { kind: 'thinking', summary: 'hmm', state: null }),
      ev(4, { name: 'Bash', summary: 'Bash npm test -- taskCard', state: 'running' }),
      ev(5, { kind: 'answer', summary: 'Allowed', state: null }),
      ev(6, { kind: 'text', summary: 'Found it.', detail: '\nFound it: the strip\nsecond line', state: null }),
      ev(7, { name: 'Edit', summary: 'Edit /repo/src/x.ts' })
    ]
    const lines = tailLines(events, { n: 4 })
    expect(lines.map((l) => l.text)).toEqual(['Reading taskCard.ts', 'Running npm test -- taskCard', 'Found it: the strip', 'Editing x.ts'])
    expect(lines.map((l) => l.key)).toEqual([2, 4, 6, 7])
    expect(lines[1]!.state).toBe('running')
    // a company without code never reads "Running npm test"
    expect(tailLines(events, { n: 4, code: false })[1]!.text).toBe('Working on it')
    expect(tailLines([], { n: 4 })).toEqual([])
    expect(tailLines([ev(1, { kind: 'error', summary: 'x'.repeat(300), state: null })])[0]!.text.length).toBe(140)
  })
  it('working: the clock counts from the run root start; a stale root of another run does not count', () => {
    const t = { status: 'in_progress' as const, runId: 'r1', updatedAt: T0 }
    const rootStart = '2026-10-27T10:01:00.000Z'
    expect(taskCardView(card(), t, { root: node({ startedAt: rootStart } as Partial<AgentNode>), now: NOW })).toMatchObject({ since: rootStart, elapsed: '1m' })
    expect(taskCardView(card(), t, { root: node({ runId: 'r0', startedAt: rootStart } as Partial<AgentNode>), now: NOW }).since).toBe(T0)
    expect(taskCardView(card(), { ...t, status: 'todo' as const, runId: null }, { now: NOW }).since).toBe(T0)
  })
  it('needs you after a run stopped to ask: the report it stopped with is the outcome line', () => {
    const t = { status: 'blocked' as const, blockReason: 'needs_input' as const, runId: 'r1', updatedAt: T0, report: { outcome: 'needs_input' as const, summary: 'Which funnel step first?', evidence: [], at: T0 } }
    expect(taskCardView(card(), t as never, { now: NOW })).toMatchObject({ state: 'needs_you', result: 'Which funnel step first?' })
    // working tasks carry no result line
    expect(taskCardView(card(), { status: 'in_progress', runId: 'r1', updatedAt: T0 }, { now: NOW }).result).toBeNull()
  })
})

describe("a task's question in the conversation", () => {
  it('names the services to connect from its principia://connect links', () => {
    expect(connectToolsIn('I need a connection: Set it up: principia://connect/posthog. And principia://connect/posthog?purpose=dashboard')).toEqual(['posthog'])
    expect(connectToolsIn('No links here')).toEqual([])
  })
  it('is open while its ask is', () => {
    expect(isOpenTaskQuestion({ kind: 'ask', ask: { status: 'open', to: [], taskId: 't1' } })).toBe(true)
    expect(isOpenTaskQuestion({ kind: 'ask', ask: { status: 'answered', to: [], taskId: 't1' } })).toBe(false)
    expect(isOpenTaskQuestion({ kind: 'ask', ask: { status: 'open', to: [] } })).toBe(false)
  })
})

describe('the dock above the composer (CHAT-UI.md §8.5)', () => {
  const T = '2026-10-28T10:00:00Z'
  const st = (id: string, state: StripTask['state'], at: string): StripTask => ({ taskId: id, identifier: id.toUpperCase(), who: 'Julia', state, startedAt: at })
  it('docks queued, working and needs-you tasks; in review, done and failed leave it', () => {
    const items = [st('vo-1', 'done', '2026-10-28T10:00:00Z'), st('vo-2', 'working', '2026-10-28T10:05:00Z'), st('vo-3', 'needs_you', '2026-10-28T10:01:00Z'), st('vo-4', 'in_review', '2026-10-28T10:02:00Z'), st('vo-5', 'queued', '2026-10-28T10:09:00Z'), st('vo-6', 'failed', '2026-10-28T10:03:00Z')]
    // oldest first: the newest sits right above the composer
    expect(dockedTasks(items).map((t) => t.identifier)).toEqual(['VO-3', 'VO-2', 'VO-5'])
    expect(dockedTasks([st('vo-1', 'done', '2026-10-28T10:00:00Z')])).toEqual([])
  })
  it('shows at most two, the newest, then "+N more"; all once expanded', () => {
    const five = [1, 2, 3, 4, 5]
    expect(dockRows(five, false)).toEqual({ shown: [4, 5], more: 3 })
    expect(dockRows(five, true)).toEqual({ shown: five, more: 0 })
    expect(dockRows([1, 2], false)).toEqual({ shown: [1, 2], more: 0 })
  })
  it('sums the dock up in one line, needs you first', () => {
    expect(dockSummary([st('a', 'needs_you', T), st('b', 'needs_you', T), st('c', 'needs_you', T)])).toBe('3 need you')
    expect(dockSummary([st('a', 'queued', T), st('b', 'working', T), st('c', 'needs_you', T)])).toBe('1 needs you · 1 working · 1 queued')
    expect(dockSummary([])).toBe('')
  })
  it('a card closed with × stays hidden until the task moves on (a new question, back to work)', () => {
    const a = st('a', 'needs_you', T)
    const b = st('b', 'working', T)
    const asks: Record<string, string> = { a: 'm1' }
    const mark = (t: StripTask): string => dockMark(t, asks[t.taskId])
    const closed = { a: mark(a) }
    expect(openDocked([a, b], closed, mark)).toEqual({ shown: [b], hidden: [a] })
    // the same task asks something new: it comes back
    asks.a = 'm2'
    expect(openDocked([a, b], closed, mark).shown).toEqual([a, b])
    // it was answered and works again: it comes back
    expect(openDocked([{ ...a, state: 'working' as const }], { a: 'needs_you:m1' }, mark).hidden).toEqual([])
    expect(openDocked([a], undefined, mark).shown).toEqual([a])
  })
  it('reads the dock prefs from localStorage, dropping what it cannot use', () => {
    expect(parseDockPrefs({ ch1: { collapsed: true, closed: { t1: 'needs_you:m1', t2: 4 } }, ch2: 'x', ch3: { collapsed: 'yes' } })).toEqual({ ch1: { collapsed: true, closed: { t1: 'needs_you:m1' } }, ch3: {} })
    expect(parseDockPrefs(null)).toEqual({})
    expect(parseDockPrefs([1])).toEqual({})
  })
  it('the history keeps a one-line reference while docked', () => {
    expect(dockRefLine('VO-15', 'working')).toBe('VO-15 · working · see below')
    expect(dockRefLine('VO-15', 'needs_you')).toBe('VO-15 · needs you · see below')
    expect(dockRefLine('VO-15', 'queued')).toBe('VO-15 · queued · see below')
  })
  it('a question with options drops its "Options:" line (the buttons say it); without options the text stays', () => {
    const text = "VO-15 is stuck and needs you.\nShould I cancel the Oct 28 posts?\nOptions: Cancel both, Cancel only Oct 28 or Leave them, I'll ask her first.\nReply here and I'll pass it on to VO-15."
    const out = questionText(text, ['Cancel both', 'Cancel only Oct 28', "Leave them, I'll ask her first"])
    expect(out).not.toContain('Options:')
    expect(out).toContain('Should I cancel the Oct 28 posts?')
    expect(out).toContain("Reply here and I'll pass it on to VO-15.")
    expect(questionText(text, [])).toBe(text)
    expect(questionText(text, undefined)).toBe(text)
  })
})
