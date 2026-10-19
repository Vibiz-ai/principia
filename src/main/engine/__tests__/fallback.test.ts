import { describe, expect, it } from 'vitest'
import { addWorkflow, fakeAdapter, fakeCtx, makeEngine, profile, waitRun, type FakeCall } from './fakes'

describe('automatic harness fallback', () => {
  it.each([false, true])('workflow fallback respects Slack restrictions (%s)', async (restricted) => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const workflow = addWorkflow(ctx, { name: 'Fallback', description: '', inputs: [], slackTools: restricted, nodes: [
      { id: 'work', type: 'agent', label: 'Work', after: [], cwd: null, timeoutMin: 1, profileId: 'p', prompt: 'Do the work', memory: 'off' },
      { id: 'next', type: 'shell', label: 'Next', after: ['work'], cwd: null, timeoutMin: 1, command: 'echo downstream' }
    ] })
    const engine = await makeEngine(ctx, { available: ['claude', 'codex', 'shell'], adapters: {
      claude: fakeAdapter('claude', calls, () => ({ output: 'Usage limit reached', isError: true, exitCode: 1 })),
      codex: fakeAdapter('codex', calls, () => ({ output: 'done' }))
    } })
    try {
      const run = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: workflow.id, inputs: {} }, { trigger: 'manual' }).id)
      expect(run.status).toBe(restricted ? 'failed' : 'passed')
      expect(calls.map((c) => c.adapter)).toEqual(restricted ? ['claude'] : ['claude', 'codex'])
      if (!restricted) expect(ctx.store.stepsOf(run.id).find((s) => s.nodeId === 'next')?.output).toBe('downstream')
    } finally { await engine.shutdown() }
  })

  it('switches Claude to subscription Codex, preserves constraints and records both attempts', async () => {
    const ctx = fakeCtx()
    ctx.settings.concurrency = 1
    ctx.profiles.set('p', profile('p', 'claude', { model: 'opus', extraArgs: ['--claude-only'], secretNames: ['PROJECT_TOKEN'], useApiKeyAuth: true }))
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, {
      available: ['claude', 'codex', 'shell'],
      adapters: {
        claude: fakeAdapter('claude', calls, () => ({ output: 'Usage limit reached', isError: true, exitCode: 1 })),
        codex: fakeAdapter('codex', calls, () => ({ output: 'Finished' }))
      }
    })
    try {
      const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'Fix the bug. Do not push.', memory: 'off' }, { trigger: 'schedule' }).id)
      expect(run.status).toBe('passed')
      expect(run.stopReason ?? null).toBeNull()
      expect(run.retryAt ?? null).toBeNull()
      expect(calls.map((c) => c.adapter)).toEqual(['claude', 'codex'])
      expect(calls[1].prompt).toContain('Fix the bug. Do not push.')
      expect(calls[1].resumeId).toBeNull()
      expect(calls[1].profile).toMatchObject({ adapter: 'codex', model: null, extraArgs: [], useApiKeyAuth: false, permissionMode: 'bypass', secretNames: ['PROJECT_TOKEN'] })
      const steps = ctx.store.stepsOf(run.id)
      expect(steps.map((s) => s.adapter)).toEqual(['claude', 'codex'])
      expect(steps[0].stopReason).toBe('rate_limited')
      expect(steps[1].sourceStepIds).toContain(steps[0].id)
    } finally { await engine.shutdown() }
  })

  it('tries each installed harness once and retains reset retry when all are limited', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const limited = () => ({ output: 'Usage limit reached', isError: true, exitCode: 1 })
    const engine = await makeEngine(ctx, { available: ['claude', 'codex', 'shell'], adapters: {
      claude: fakeAdapter('claude', calls, limited), codex: fakeAdapter('codex', calls, limited)
    } })
    try {
      const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'work', memory: 'off' }, { trigger: 'schedule' }).id)
      expect(calls.map((c) => c.adapter)).toEqual(['claude', 'codex'])
      expect(run.status).toBe('failed')
      expect(run.stopReason).toBe('rate_limited')
      expect(run.retryAt).toBeTruthy()
    } finally { await engine.shutdown() }
  })

  it('does not retry ordinary task failures with another harness', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { available: ['claude', 'codex', 'shell'], adapters: {
      claude: fakeAdapter('claude', calls, () => ({ output: 'Build failed', exitCode: 1 })),
      codex: fakeAdapter('codex', calls, () => ({ output: 'ok' }))
    } })
    try {
      const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'work', memory: 'off' }, { trigger: 'manual' }).id)
      expect(run.status).toBe('failed')
      expect(calls.map((c) => c.adapter)).toEqual(['claude'])
    } finally { await engine.shutdown() }
  })
})
