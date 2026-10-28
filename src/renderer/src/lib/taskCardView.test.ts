import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentNode, Ask } from '@shared/live'
import type { ForumMessage } from '@shared/forum'
import type { ForumTaskCard } from '@shared/taskCard'
import { cardsOfMessages, openAskOfRun, parseRunStarts, rootOfRun, runStartsKey, stripTasks, tailLines, taskCardView } from './taskCardView'

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
