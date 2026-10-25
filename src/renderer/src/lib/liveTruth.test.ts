/** Five doors A2: the one live source every working / needs-you count reads. */
import { describe, expect, it } from 'vitest'
import type { AgentNode, Ask } from '@shared/live'
import type { Session } from '@shared/types'
import { liveTruth, needsIn, workingIn } from './liveTruth'
import { badgesFromTruth, itemsFromTruth } from './companyModel'
import { paletteSources } from './paletteScope'

const T = '2026-10-25T10:00:00.000Z'
const agent = (id: string, x: Partial<AgentNode & { companyId?: string }> = {}): AgentNode & { companyId?: string } =>
  ({ id, kind: 'step', parentId: null, rootId: id, sessionId: null, runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/', title: id, agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: T, updatedAt: T, endedAt: null, ...x }) as AgentNode & { companyId?: string }
const ask = (id: string, x: Partial<Ask & { companyId?: string }> = {}): Ask => ({ id, agentId: 'a', rootId: 'a', sessionId: null, runId: null, stepId: null, provider: 'claude', kind: 'permission', channel: 'stdio', title: id, detail: null, toolName: null, toolInput: null, question: null, options: [], status: 'open', answer: null, answeredVia: null, createdAt: T, answeredAt: null, expiresAt: null, ...x }) as Ask
const sess = (id: string, companyId: string): Session => ({ id, companyId, status: 'running' }) as unknown as Session

describe('liveTruth', () => {
  it('an archived company leaves every count: its asks, agents and board tasks drop out, so the badges add up', () => {
    const input = {
      agents: [agent('h', { companyId: 'co_hd', status: 'working' }), agent('n', { companyId: 'co_nw' })],
      asks: [ask('qh', { agentId: 'h', rootId: 'h', companyId: 'co_hd' }), ask('qn', { agentId: 'n', rootId: 'n', companyId: 'co_nw' })],
      seen: new Set<string>(),
      sessions: [],
      taskNeeds: { co_hd: 2, co_nw: 1 }
    }
    const before = needsIn(liveTruth(input), 'all')
    expect(before.count).toBe(5)
    const after = liveTruth({ ...input, listed: new Set(['co_nw', 'co_personal']) })
    const all = needsIn(after, 'all')
    expect(all.count).toBe(2)
    expect(Object.values(all.byCompany).reduce((a, b) => a + b, 0)).toBe(all.count)
    expect(all.items.map((i) => i.key)).toEqual(['ask:qn'])
    expect(workingIn(after, 'all').count).toBe(0)
    // before the company list has loaded nothing is dropped
    expect(needsIn(liveTruth({ ...input, listed: new Set() }), 'all').count).toBe(5)
  })

  it('a task run with no stamp counts for its task’s company, never for Personal (the "1 working on Personal" bug)', () => {
    const t = liveTruth({ agents: [agent('step', { runId: 'run_la' })], asks: [], seen: new Set(), sessions: [], tasks: [{ companyId: 'co_la', runId: 'run_la' }] })
    expect(workingIn(t, 'co_la').count).toBe(1)
    expect(workingIn(t, 'co_personal').count).toBe(0)
    expect(workingIn(t, 'all').byCompany).toEqual({ co_la: 1 })
  })

  it('subagents fold into their root; a root with an open ask needs you instead of working', () => {
    const t = liveTruth({
      agents: [agent('r1', { companyId: 'co_a' }), agent('kid', { kind: 'subagent', rootId: 'r1', parentId: 'r1', companyId: 'co_a' }), agent('r2', { companyId: 'co_a' })],
      asks: [ask('q', { agentId: 'r2', rootId: 'r2' })],
      seen: new Set(),
      sessions: []
    })
    expect(workingIn(t, 'co_a').items.map((i) => i.agentId)).toEqual(['r1'])
    expect(needsIn(t, 'co_a').items.map((i) => i.key)).toEqual(['ask:q'])
  })

  it('a finished run drops out of every surface in the same computation', () => {
    const running = liveTruth({ agents: [agent('s', { companyId: 'co_a' })], asks: [], seen: new Set(), sessions: [] })
    const ended = liveTruth({ agents: [agent('s', { companyId: 'co_a', status: 'done', endedAt: T })], asks: [], seen: new Set(), sessions: [] })
    expect(workingIn(running, 'co_a').count).toBe(1)
    expect(workingIn(ended, 'co_a').count).toBe(0)
    expect(badgesFromTruth(ended, [{ id: 'co_a' }]).byCompany.co_a!.working).toBe(0)
    expect(itemsFromTruth(ended, { working: true, companyId: 'co_a' })).toEqual([])
  })

  it('every surface reads the same numbers: rail badge = sidebar = status bar = All companies', () => {
    const t = liveTruth({
      agents: [
        agent('w_a', { companyId: 'co_a' }),
        agent('idle_b', { kind: 'session', sessionId: 's_b', status: 'needs_you', needs: 'idle' }),
        agent('w_c', { companyId: 'co_c' })
      ],
      asks: [ask('q_c', { agentId: 'x', rootId: 'x', companyId: 'co_c' } as never)],
      seen: new Set(),
      sessions: [sess('s_b', 'co_b')],
      taskNeeds: { co_a: 2 }
    })
    const badges = badgesFromTruth(t, [{ id: 'co_a' }, { id: 'co_b' }, { id: 'co_c' }]).byCompany
    for (const co of ['co_a', 'co_b', 'co_c']) {
      expect(badges[co]!.needsYou).toBe(needsIn(t, co).count)
      expect(badges[co]!.working).toBe(workingIn(t, co).count)
    }
    expect(needsIn(t, 'co_a')).toMatchObject({ count: 2, tasks: 2, items: [] })
    expect(needsIn(t, 'all').count).toBe(4)
    expect(workingIn(t, 'all').count).toBe(2)
  })

  it('the palette lists only the focused company’s asks, working agents and sessions', () => {
    const t = liveTruth({ agents: [agent('w_a', { companyId: 'co_a' }), agent('w_b', { companyId: 'co_b' })], asks: [], seen: new Set(), sessions: [] })
    const asks = [ask('qa', { agentId: 'w_a', rootId: 'w_a', companyId: 'co_a' } as never), ask('qb', { agentId: 'w_b', rootId: 'w_b', companyId: 'co_b' } as never)]
    const p = paletteSources({ asks, drafts: [], sessions: [sess('s_a', 'co_a'), sess('s_b', 'co_b')], truth: liveTruth({ agents: [agent('w_a', { companyId: 'co_a' }), agent('w_b', { companyId: 'co_b' })], asks, seen: new Set(), sessions: [] }) }, 'co_a')
    expect(p.asks.map((x) => x.ask.id)).toEqual(['qa'])
    expect(p.sessions.map((s) => s.id)).toEqual(['s_a'])
    expect(paletteSources({ asks: [], drafts: [], sessions: [], truth: t }, 'co_a').working.map((i) => i.agentId)).toEqual(['w_a'])
    expect(paletteSources({ asks: [], drafts: [], sessions: [], truth: t }, undefined).working).toHaveLength(2)
  })
})

describe('liveTruth: tasks keep the live counts true (step 3 QA)', () => {
  it('a paused task drops its run from working at once, even while the run still reports in', () => {
    const t = liveTruth({ agents: [agent('step', { runId: 'run_la', companyId: 'co_la' })], asks: [], seen: new Set(), sessions: [], tasks: [{ id: 't1', companyId: 'co_la', runId: 'run_la', status: 'todo', agentId: 'livia', title: 'Rank flows', updatedAt: T }] })
    expect(workingIn(t, 'co_la').count).toBe(0)
  })
  it('a task that just started is working before its agent shows up, with its start time', () => {
    const t = liveTruth({ agents: [], asks: [], seen: new Set(), sessions: [], tasks: [{ id: 't1', companyId: 'co_la', runId: 'run_new', status: 'in_progress', agentId: 'livia', title: 'Rank flows', updatedAt: T }] })
    const w = workingIn(t, 'co_la')
    expect(w).toMatchObject({ count: 1, agents: 1, chats: 0 })
    expect(w.items[0]).toMatchObject({ taskId: 't1', startedAt: T, detail: 'Starting' })
    // once the agent reports, it is one item, not two
    const t2 = liveTruth({ agents: [agent('step', { runId: 'run_new', companyId: 'co_la', startedAt: '2026-10-25T09:59:50.000Z' })], asks: [], seen: new Set(), sessions: [], tasks: [{ id: 't1', companyId: 'co_la', runId: 'run_new', status: 'in_progress', agentId: 'livia', title: 'Rank flows', updatedAt: T }] })
    expect(workingIn(t2, 'co_la').items.map((i) => [i.taskId, i.startedAt])).toEqual([['t1', '2026-10-25T09:59:50.000Z']])
  })
  it('your own chat is live, but it is not an agent of the team', () => {
    const t = liveTruth({ agents: [agent('chat', { kind: 'session', sessionId: 's1' })], asks: [], seen: new Set(), sessions: [sess('s1', 'co_la')], tasks: [] })
    expect(workingIn(t, 'co_la')).toMatchObject({ count: 1, agents: 0, chats: 1 })
  })
})
