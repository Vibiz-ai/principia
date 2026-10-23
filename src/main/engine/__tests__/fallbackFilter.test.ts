import { describe, expect, it } from 'vitest'
import { createEngineWith } from '../index'
import { fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall } from './fakes'

// ExecDeps.harnessFallback (CLOUD.md §7.2): the cloud lets a step fall back only to a harness the run has an account for
describe('harness fallback filter', () => {
  it.each([
    [true, ['claude', 'codex'], 'passed'],
    [false, ['claude'], 'failed']
  ] as const)('allowed=%s', async (allowed, adapters, status) => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const asked: [string, string][] = []
    const engine = createEngineWith(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, () => ({ output: 'Usage limit reached', isError: true, exitCode: 1 })),
        codex: fakeAdapter('codex', calls, () => ({ output: 'done' }))
      },
      detect: fakeProviders(['claude', 'codex', 'shell']),
      harnessFallback: (runId, to) => {
        asked.push([runId, to])
        return allowed
      }
    })
    await engine.init()
    try {
      const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'work', memory: 'off' }, { trigger: 'manual' }).id)
      expect(run.status).toBe(status)
      expect(calls.map((c) => c.adapter)).toEqual(adapters)
      expect(asked[0]).toEqual([run.id, 'codex'])
    } finally {
      await engine.shutdown()
    }
  })
})
