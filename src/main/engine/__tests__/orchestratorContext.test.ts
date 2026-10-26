/** ORCHESTRATOR.md §1.1: every non-shell step of a company run with an agent gets Principia's block and its report file. */
import { describe, expect, it } from 'vitest'
import type { CompanyBridge, OrchestratorStepRequest } from '../../../shared/engine'
import { createEngineWith } from '../index'
import { fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall } from './fakes'

function setup(block: string | null = '<principia-context>\nInbox: nothing\n</principia-context>') {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
  const company: CompanyBridge = { resolve: (q) => q.companyId ?? 'co_personal', crossCompany: () => null, enforced: () => true, workspaceDir: () => null, repoIds: () => [], tasks: { companyOf: () => 'co_acme' } }
  ctx.company = company
  const asked: OrchestratorStepRequest[] = []
  ctx.orchestrator = { stepContext: (req) => (asked.push(req), block) }
  return { ctx, asked }
}

describe('engine: Principia context on every harness (ORCHESTRATOR.md §1.1)', () => {
  it('a codex task step gets the block at the end of its prompt and $PRINCIPIA_RUN_REPORT', async () => {
    const { ctx, asked } = setup()
    const calls: FakeCall[] = []
    const engine = createEngineWith(ctx, { adapters: { codex: fakeAdapter('codex', calls, () => ({ output: 'done', echoEnv: ['PRINCIPIA_RUN_REPORT'] })) }, detect: fakeProviders() })
    await engine.init()
    const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'Work on PRN-1' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_marcus' }).id)
    expect(run.status).toBe('passed')
    expect(asked[0]).toMatchObject({ runId: run.id, companyId: 'co_acme', taskId: 'task_1', agentId: 'agt_marcus', adapter: 'codex', resumed: false })
    expect(calls[0].prompt.trimEnd().endsWith('</principia-context>')).toBe(true)
    const step = ctx.store.getRunDetail(run.id)!.steps[0]
    expect(asked[0].reportPath.endsWith(`${run.id}/${step.id}.report.json`)).toBe(true)
    expect(step.output).toContain(`PRINCIPIA_RUN_REPORT=${asked[0].reportPath}`)
  })

  it('a seat reply run (no task) is asked too; a run with no agent, or a null block, adds nothing', async () => {
    const { ctx, asked } = setup()
    const calls: FakeCall[] = []
    const engine = createEngineWith(ctx, { adapters: { claude: fakeAdapter('claude', calls, () => ({ output: 'ok', echoEnv: ['PRINCIPIA_RUN_REPORT'] })) }, detect: fakeProviders() })
    await engine.init()
    await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'Forum reply' }, { trigger: 'manual', companyId: 'co_acme', agentId: 'agt_marcus' }).id)
    expect(asked[0]).toMatchObject({ taskId: null, agentId: 'agt_marcus', adapter: 'claude' })
    const plain = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'hi' }, { trigger: 'manual', companyId: 'co_acme' }).id)
    expect(asked).toHaveLength(1)
    expect(calls[1].prompt).not.toContain('principia-context')
    expect(ctx.store.getRunDetail(plain.id)!.steps[0].output).toContain('PRINCIPIA_RUN_REPORT=<unset>')

    const off = setup(null)
    const calls2: FakeCall[] = []
    const engine2 = createEngineWith(off.ctx, { adapters: { codex: fakeAdapter('codex', calls2, () => ({ output: 'done', echoEnv: ['PRINCIPIA_RUN_REPORT'] })) }, detect: fakeProviders() })
    await engine2.init()
    const r2 = await waitRun(off.ctx, engine2.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'Work' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_marcus' }).id)
    expect(calls2[0].prompt).not.toContain('principia-context')
    expect(off.ctx.store.getRunDetail(r2.id)!.steps[0].output).toContain('PRINCIPIA_RUN_REPORT=<unset>')
  })

  it('a failing bridge never fails the step', async () => {
    const { ctx } = setup()
    ctx.orchestrator = { stepContext: () => { throw new Error('boom') } }
    const calls: FakeCall[] = []
    const engine = createEngineWith(ctx, { adapters: { codex: fakeAdapter('codex', calls, () => ({ output: 'done' })) }, detect: fakeProviders() })
    await engine.init()
    const run = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'Work' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_marcus' }).id)
    expect(run.status).toBe('passed')
  })
})
