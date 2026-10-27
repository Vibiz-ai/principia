import { describe, expect, it } from 'vitest'
import type { AgentNode, Ask } from '@shared/live'
import type { ForumMessage } from '@shared/forum'
import type { ForumTaskCard } from '@shared/taskCard'
import { cardsOfMessages, openAskOfRun, rootOfRun, stripTasks, taskCardView } from './taskCardView'

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
})
