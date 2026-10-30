import { describe, expect, it } from 'vitest'
import { createEngineWith } from '../index'
import { fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall, type FakeCtx } from './fakes'
import type { Adapter } from '../adapters'

async function engineWith(ctx: FakeCtx, claude: Adapter, over: { replySlots?: number; replyEndGraceMs?: number } = {}) {
  const engine = createEngineWith(ctx, { adapters: { claude }, detect: fakeProviders(['claude']), ...over })
  await engine.init()
  return engine
}
const prompt = (text: string) => ({ kind: 'prompt' as const, profileId: 'p', repoId: null, prompt: text, memory: 'off' as const })

describe('chat replies', () => {
  it('do not wait behind work that holds every slot', async () => {
    const ctx = fakeCtx()
    ctx.settings.concurrency = 1
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, (r) => (r.prompt.includes('long') ? { output: 'work', delayMs: 2500 } : { output: 'hi' })))
    try {
      const work = engine.runs.start(prompt('long task'), { trigger: 'manual' })
      const reply = engine.runs.start(prompt('reply'), { trigger: 'manual', reply: true })
      expect((await waitRun(ctx, reply.id)).status).toBe('passed')
      expect(ctx.store.getRun(work.id)!.status).toBe('running')
      expect((await waitRun(ctx, work.id)).status).toBe('passed')
    } finally {
      await engine.shutdown()
    }
  })

  it('still wait for each other past the reply slots, then run', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, () => ({ output: 'hi', delayMs: 150 })), { replySlots: 1 })
    const ended: string[] = []
    try {
      const runs = ['a', 'b'].map((t) => engine.runs.start(prompt(t), { trigger: 'manual', reply: true }))
      for (const r of runs) {
        expect((await waitRun(ctx, r.id)).status).toBe('passed')
        ended.push(ctx.store.stepsOf(r.id)[0]!.startedAt!, ctx.store.stepsOf(r.id)[0]!.endedAt!)
      }
      expect(ended[2]! >= ended[1]!).toBe(true)
    } finally {
      await engine.shutdown()
    }
  })

  it('end soon after their answer when a background job keeps the process up, and keep the answer', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, () => ({ output: 'The plan is open.', lingerMs: 30_000 })), { replyEndGraceMs: 100 })
    try {
      const run = await waitRun(ctx, engine.runs.start(prompt('reply'), { trigger: 'manual', reply: true }).id, 5000)
      expect(run.status).toBe('passed')
      expect(ctx.store.stepsOf(run.id)[0]!.output).toBe('The plan is open.')
    } finally {
      await engine.shutdown()
    }
  })

  it('other runs keep waiting for a process that stays up after its result', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await engineWith(ctx, fakeAdapter('claude', calls, () => ({ output: 'done', lingerMs: 600 })), { replyEndGraceMs: 50 })
    try {
      const run = engine.runs.start(prompt('task'), { trigger: 'manual' })
      await new Promise((r) => setTimeout(r, 400))
      expect(ctx.store.getRun(run.id)!.status).toBe('running')
      expect((await waitRun(ctx, run.id)).status).toBe('passed')
    } finally {
      await engine.shutdown()
    }
  })
})
