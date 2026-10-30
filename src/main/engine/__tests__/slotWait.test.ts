import { describe, expect, it } from 'vitest'
import { createEngineWith } from '../index'
import { Semaphore } from '../util'
import { addWorkflow, fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall, type FakeCtx } from './fakes'
import type { Adapter } from '../adapters'
import type { WorkflowNode } from '../../../shared/types'

async function engineWith(ctx: FakeCtx, claude: Adapter) {
  const engine = createEngineWith(ctx, { adapters: { claude }, detect: fakeProviders(['claude']) })
  await engine.init()
  return engine
}
const agentNode = (id: string, prompt = id, after: string[] = [], profileId = 'p'): WorkflowNode => ({
  id,
  type: 'agent',
  label: id,
  after,
  cwd: null,
  timeoutMin: 1,
  profileId,
  prompt
})
const prompt = (text: string) => ({ kind: 'prompt' as const, profileId: 'p', repoId: null, prompt: text, memory: 'off' as const })
const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('Semaphore.acquire', () => {
  it('tells the caller only when it has to wait', async () => {
    const s = new Semaphore(() => 1)
    let waits = 0
    const first = await s.acquire(() => waits++)
    expect(waits).toBe(0)
    const second = s.acquire(() => waits++)
    expect(waits).toBe(1)
    first()
    ;(await second)()
  })
})

describe('a run waiting for a free slot', () => {
  it('says so while every slot is taken, and clears when its step starts', async () => {
    const ctx = fakeCtx()
    ctx.settings.concurrency = 1
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, (r) => ({ output: 'ok', delayMs: r.prompt.includes('long') ? 700 : 0 })))
    try {
      const first = engine.runs.start(prompt('long'), { trigger: 'manual' })
      const second = engine.runs.start(prompt('next'), { trigger: 'manual' })
      await until(() => !!ctx.store.getRun(second.id)?.slotWaitSince)
      const waiting = ctx.store.getRun(second.id)!
      expect(waiting.status).toBe('running')
      expect(ctx.store.stepsOf(second.id)).toEqual([])
      expect(ctx.store.getRun(first.id)!.slotWaitSince ?? null).toBeNull()

      await until(() => ctx.store.stepsOf(second.id).length > 0)
      await until(() => !ctx.store.getRun(second.id)!.slotWaitSince)
      const done = await waitRun(ctx, second.id)
      expect(done.status).toBe('passed')
      expect(done.slotWaitSince).toBeNull()
      await waitRun(ctx, first.id)
    } finally {
      await engine.shutdown()
    }
  })

  it('does not wait, or say so, with a slot free', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const events: (string | null | undefined)[] = []
    const emit = ctx.emit
    ctx.emit = (e) => {
      if (e.type === 'run.updated') events.push(e.run.slotWaitSince)
      emit(e)
    }
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, () => ({ output: 'ok' })))
    try {
      await waitRun(ctx, engine.runs.start(prompt('hi'), { trigger: 'manual' }).id)
      expect(events.some(Boolean)).toBe(false)
    } finally {
      await engine.shutdown()
    }
  })

  it('canceled while it waits, ends without the mark', async () => {
    const ctx = fakeCtx()
    ctx.settings.concurrency = 1
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, () => ({ output: 'ok', delayMs: 400 })))
    try {
      const first = engine.runs.start(prompt('long'), { trigger: 'manual' })
      const second = engine.runs.start(prompt('next'), { trigger: 'manual' })
      await until(() => !!ctx.store.getRun(second.id)?.slotWaitSince)
      await engine.runs.cancel(second.id)
      const r = ctx.store.getRun(second.id)!
      expect(r.status).toBe('canceled')
      expect(r.slotWaitSince).toBeNull()
      await waitRun(ctx, first.id)
    } finally {
      await engine.shutdown()
    }
  })

  it('a workflow with a parallel step running is working, not waiting', async () => {
    const ctx = fakeCtx()
    ctx.settings.concurrency = 1
    ctx.profiles.set('p', profile('p', 'claude'))
    const wf = addWorkflow(ctx, {
      name: 'Two at once',
      description: '',
      inputs: [],
      nodes: [agentNode('a'), agentNode('b')]
    })
    const seen: (string | null | undefined)[] = []
    const emit = ctx.emit
    ctx.emit = (e) => {
      if (e.type === 'run.updated') seen.push(e.run.slotWaitSince)
      emit(e)
    }
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, () => ({ output: 'ok', delayMs: 100 })))
    try {
      const run = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id)
      expect(run.status).toBe('passed')
      expect(calls.length).toBe(2)
      expect(seen.some(Boolean)).toBe(false)
    } finally {
      await engine.shutdown()
    }
  })
})
