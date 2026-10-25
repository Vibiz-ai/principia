/** USAGE.md: money / byte labels and the Activity canvas grouping (frames per company, Elsewhere last). */
import { describe, expect, it } from 'vitest'
import type { AgentNode } from '@shared/live'
import type { ActivitySession } from '@shared/usage'
import { ELSEWHERE, bytesLabel, cardTimer, frameMeta, layoutActivity, moneyLabel, outsideItems, principiaItems, removeLabel, unpricedDay } from './usage'

const b = (usd: number | null, o: { estimated?: boolean; unpriced?: boolean; tokens?: number } = {}) => ({ usd, estimated: !!o.estimated, unpriced: !!o.unpriced, tokensIn: o.tokens ?? 0, tokensOut: 0 })

describe('labels', () => {
  it('money: reported, estimated, unpriced, nothing', () => {
    expect(moneyLabel(b(1.2))).toBe('$1.20')
    expect(moneyLabel(b(1.2, { estimated: true }))).toBe('~$1.20')
    expect(moneyLabel(b(null, { tokens: 500 }))).toBe('—')
    expect(moneyLabel(b(null))).toBe('$0')
    expect(moneyLabel(b(0.004))).toBe('$<0.01')
    expect(moneyLabel(b(2, { unpriced: true }))).toBe('$2.00+')
  })
  it('bytes and the clean-up button', () => {
    expect(bytesLabel(512)).toBe('512 B')
    expect(bytesLabel(1.2 * 1024 ** 3)).toBe('1.2 GB')
    expect(removeLabel(3, 1.2 * 1024 ** 3)).toBe('Remove 3 items (1.2 GB)')
    expect(removeLabel(1, 2048)).toBe('Remove 1 item (2.0 KB)')
  })
})

const agent = (o: Partial<AgentNode> & { id: string }): AgentNode =>
  ({ kind: 'step', parentId: null, rootId: o.id, sessionId: null, runId: 'r_1', stepId: 'st_1', provider: 'claude', repoId: null, cwd: '/x', title: 'Agent', agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: 'Bash npm test', lastTool: 'Bash', toolCount: 1, memReads: 0, filesTouched: [], tokensIn: 10, tokensOut: 5, costUsd: null, modelUsage: null, report: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null, ...o }) as AgentNode
const outside = (id: string, companyId: string | null): ActivitySession => ({ id, path: `/p/${id}.jsonl`, cwd: '/w', companyId, title: id, state: 'working', doing: 'Read a.ts', model: null, gitBranch: null, startedAt: null, turnStartedAt: null, lastAt: new Date().toISOString(), tokensIn: 1, tokensOut: 1, tokensPartial: false })

describe('activity items and frames', () => {
  it('keeps live roots and background subagents, drops finished ones and foreground subagents', () => {
    const now = Date.now()
    const items = principiaItems(
      [
        agent({ id: 'a1' }),
        agent({ id: 'a2', status: 'done' }),
        agent({ id: 'a3', kind: 'subagent', parentId: 'a1', rootId: 'a1', background: true }),
        agent({ id: 'a4', kind: 'subagent', parentId: 'a1', rootId: 'a1' }),
        agent({ id: 'a5', status: 'idle', updatedAt: new Date(now - 3600_000).toISOString() })
      ],
      () => 'co_acme',
      now
    )
    expect(items.map((i) => i.key)).toEqual(['p:a1', 'p:a3'])
    expect(items[1]!.open).toEqual({ kind: 'run', runId: 'r_1', stepId: 'st_1' })
    expect(items[0]!.tokens).toBe(15)
  })
  it('one frame per company in rail order, Elsewhere last', () => {
    const items = [...outsideItems([outside('x', null), outside('y', 'co_b'), outside('z', 'co_a')]), ...principiaItems([agent({ id: 'a1' })], () => 'co_b', Date.now())]
    const frames = layoutActivity(items, ['co_a', 'co_b'])
    expect(frames.map((f) => f.key)).toEqual(['co_a', 'co_b', ELSEWHERE])
    expect(frames[1]!.items.map((i) => i.source)).toEqual(['principia', 'outside'])
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.x >= frames[i - 1]!.x + frames[i - 1]!.width || frames[i]!.y > frames[i - 1]!.y).toBe(true)
  })
  it('a working session with an unknown turn start shows no timer, never the session age', () => {
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const [it] = outsideItems([{ ...outside('big', null), startedAt: week, turnStartedAt: null, tokensPartial: true }])
    expect(it!.since).toBeNull()
    expect(cardTimer(it!)).toBeNull()
    const now = Date.now()
    expect(cardTimer({ state: 'working', since: new Date(now - 65_000).toISOString() }, now)).toBe('1m05s')
    expect(cardTimer({ state: 'idle', since: new Date(now - 3 * 60_000).toISOString() }, now)).toBe('idle 3m00s')
  })
  it('frame meta counts agents, not sessions', () => {
    expect(frameMeta(3, 2)).toBe('3 agents · 2 working')
    expect(frameMeta(1, 0)).toBe('1 agent')
  })
})

describe('chart', () => {
  it('marks days with unpriced tokens', () => {
    const day = (o: Partial<{ usd: number | null; unpriced: boolean; tokensIn: number }>) => ({ date: '2026-10-22', usd: null, estimated: false, unpriced: false, tokensIn: 0, tokensOut: 0, agents: 1, ...o })
    expect(unpricedDay(day({ tokensIn: 500 }))).toBe(true)
    expect(unpricedDay(day({ usd: 2, unpriced: true, tokensIn: 5 }))).toBe(true)
    expect(unpricedDay(day({ usd: 2, tokensIn: 5 }))).toBe(false)
    expect(unpricedDay(day({}))).toBe(false)
  })
})
