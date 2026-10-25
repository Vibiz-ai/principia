/**
 * Five doors step 2 (one truth): a run's live agents and asks carry the run's company from their first event. Before
 * this, the engine's sink emitted nodes without a stamp and the renderer filed a Ledgerly run under Personal, so
 * "1 working" showed on Personal too.
 */
import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../../../shared/types'
import { createLiveSink } from '../live/sink'
import { createAgentTracker } from '../live/tracker'
import { ROOT_KEY } from '../live/types'

const sinkFor = (companyId: string | null) => {
  const events: EngineEvent[] = []
  const sink = createLiveSink({
    store: {},
    emit: (e) => events.push(e),
    redact: (s) => s,
    owner: { sessionId: null, runId: 'run_1', stepId: 'step_1' },
    provider: 'claude',
    cwd: '/tmp',
    repoId: null,
    companyId,
    sync: true
  })
  return { sink, events }
}

describe('live sink company stamp', () => {
  it('every emitted node and ask carries the owner company', () => {
    const { sink, events } = sinkFor('co_ledgerly')
    const tracker = createAgentTracker({ provider: 'claude', root: { kind: 'step', title: 'LA-3 · Fix rounding', cwd: '/tmp' }, headless: true })
    sink.apply(tracker.begin())
    sink.apply([{ op: 'ask.open', key: ROOT_KEY, gateId: 'g1', ask: { provider: 'claude', kind: 'question', channel: 'stdio', title: 'Which?', detail: null, toolName: null, toolInput: null, question: 'Which?', options: [], createdAt: new Date().toISOString(), expiresAt: null } }] as never)
    const agents = events.filter((e) => e.type === 'agent.updated').map((e) => (e as { agent: { companyId?: string } }).agent)
    const asks = events.filter((e) => e.type === 'ask.updated').map((e) => (e as { ask: { companyId?: string } }).ask)
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((a) => a.companyId === 'co_ledgerly')).toBe(true)
    expect(asks.length).toBe(1)
    expect(asks[0]!.companyId).toBe('co_ledgerly')
  })

  it('no owner company: no stamp (main fills it from the run row)', () => {
    const { sink, events } = sinkFor(null)
    const tracker = createAgentTracker({ provider: 'claude', root: { kind: 'step', title: 'x', cwd: '/tmp' }, headless: true })
    sink.apply(tracker.begin())
    const a = events.find((e) => e.type === 'agent.updated') as unknown as { agent: Record<string, unknown> }
    expect('companyId' in a.agent).toBe(false)
  })
})
