import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CheckNode, RunStep, WorkflowNode } from '../../../shared/types'
import { addWorkflow, fakeAdapter, fakeCtx, makeEngine, profile, waitRun, type FakeCall } from './fakes'

const agent = (id: string, prompt: string, after: string[] = [], profileId = 'p_claude'): WorkflowNode => ({
  id,
  type: 'agent',
  label: id,
  after,
  cwd: null,
  timeoutMin: 1,
  profileId,
  prompt
})
const check = (id: string, target: string, x: Partial<CheckNode> = {}): CheckNode => ({
  id,
  type: 'check',
  label: id,
  after: [target],
  cwd: null,
  timeoutMin: 1,
  profileId: 'p_claude',
  command: null,
  target,
  criteria: 'be good',
  maxRetries: 2,
  ...x
})
const shell = (id: string, command: string, after: string[] = []): WorkflowNode => ({
  id,
  type: 'shell',
  label: id,
  after,
  cwd: null,
  timeoutMin: 1,
  command
})

function setup() {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
  return ctx
}
const stepsOf = (ctx: ReturnType<typeof setup>, runId: string, nodeId?: string): RunStep[] =>
  ctx.store.stepsOf(runId).filter((s) => !nodeId || s.nodeId === nodeId)

describe('prompt runs', () => {
  it('runs one headless step, parses stream-json, injects env, strips claude auth, redacts', async () => {
    const ctx = setup()
    ctx.secretValues = { ANTHROPIC_API_KEY: 'sk-ant-secret', MY_KEY: 'my-secret-value' }
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, () => ({ output: 'hello', echoEnv: ['ARTIFACTS_DIR', 'MY_KEY', 'ANTHROPIC_API_KEY', 'HIVE_RUN_ID'] }))
      }
    })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'say hello' }, { trigger: 'manual' })
    expect(run.status).toBe('queued')
    expect(existsSync(run.artifactsDir)).toBe(true)
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('passed')
    const [step] = stepsOf(ctx, run.id)
    expect(step.nodeType).toBe('prompt')
    expect(step.agentSessionId).toBe('sess-claude-1')
    expect(step.output).toContain('hello')
    expect(step.output).toContain(`ARTIFACTS_DIR=${run.artifactsDir}`)
    expect(step.output).toContain('MY_KEY=••••MY_KEY') // injected, then redacted
    expect(step.output).toContain('ANTHROPIC_API_KEY=<unset>') // A6: subscription login preserved
    expect(step.output).toContain(`HIVE_RUN_ID=${run.id}`)
    expect(step.cwd).toBe(ctx.paths.scratchDir)
    const log = readFileSync(step.logPath, 'utf8')
    expect(log).not.toContain('my-secret-value')
    const chunks = ctx.events.filter((e) => e.type === 'step.output').map((e) => (e as { chunk: string }).chunk)
    expect(chunks.join('')).toContain('→ Read')
    expect(chunks.join('')).not.toContain('"type"') // human readable, not JSON
  })

  it('useApiKeyAuth keeps ANTHROPIC_API_KEY', async () => {
    const ctx = setup()
    ctx.profiles.set('p_api', profile('p_api', 'claude', { useApiKeyAuth: true }))
    ctx.secretValues = { ANTHROPIC_API_KEY: 'sk-ant-secret' }
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', [], () => ({ echoEnv: ['ANTHROPIC_API_KEY'] })) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_api', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    await waitRun(ctx, run.id)
    expect(stepsOf(ctx, run.id)[0].output).toContain('ANTHROPIC_API_KEY=••••ANTHROPIC_API_KEY')
  })

  it('missing adapter fails the run immediately with the install hint', async () => {
    const ctx = setup()
    // no other agent harness installed: harness fallback (runStep) has nowhere to go
    const engine = await makeEngine(ctx, { available: ['shell'] })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_codex', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('failed')
    expect(done.reason).toContain('npm i -g @openai/codex')
    expect(stepsOf(ctx, run.id)).toHaveLength(0)
  })

  it('agent error result fails the step', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', [], () => ({ output: 'boom', isError: true })) } })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('failed')
    expect(done.reason).toContain('boom')
  })
})

describe('workflows', () => {
  it('templates {{node.output}} into the next prompt and records talk edges', async () => {
    const ctx = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, {
      adapters: { claude: fakeAdapter('claude', calls, (req) => ({ output: req.prompt.startsWith('plan') ? 'PLAN-42' : 'done' })) }
    })
    const wf = addWorkflow(ctx, {
      name: 'chain',
      description: '',
      inputs: [{ name: 'goal', label: 'Goal' }],
      nodes: [agent('plan', 'plan {{inputs.goal}}'), agent('build', 'build from {{plan.output}} into {{ARTIFACTS_DIR}}', ['plan'])]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: { goal: 'ads' } }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(calls[0].prompt).toBe('plan ads')
    expect(calls[1].prompt).toBe(`build from PLAN-42 into ${run.artifactsDir}`)
    const [s1, s2] = stepsOf(ctx, run.id)
    expect(s2.sourceStepIds).toEqual([s1.id])
  })

  it('runs independent branches in parallel', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', [], () => ({ delayMs: 600 })) } })
    const wf = addWorkflow(ctx, {
      name: 'par',
      description: '',
      inputs: [],
      nodes: [agent('a', 'a'), agent('b', 'b'), agent('c', 'c'), agent('join', '{{a.output}} {{b.output}} {{c.output}}')]
    })
    const t0 = Date.now()
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(Date.now() - t0).toBeLessThan(2600) // 3 parallel + 1 serial, not 4 serial
    const join = stepsOf(ctx, run.id, 'join')[0]
    expect(join.sourceStepIds).toHaveLength(3)
  })

  it('W4: agent check FAIL loops maxRetries+1 times, resumes the target conversation with feedback only', async () => {
    const ctx = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, (req) =>
          req.prompt.startsWith('You are reviewing') ? { output: 'Missing tests.\nVERDICT: FAIL' } : { output: 'built it' }
        )
      }
    })
    const wf = addWorkflow(ctx, {
      name: 'loop',
      description: '',
      inputs: [],
      nodes: [agent('build', 'build the thing'), check('review', 'build', { maxRetries: 2 })]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('failed')
    expect(done.reason).toContain('Missing tests')
    const builds = stepsOf(ctx, run.id, 'build')
    const reviews = stepsOf(ctx, run.id, 'review')
    expect(builds.map((s) => s.attempt)).toEqual([1, 2, 3])
    expect(reviews.map((s) => s.attempt)).toEqual([1, 2, 3])
    expect(reviews.every((s) => s.verdict === 'FAIL')).toBe(true)
    // retries resume attempt 1's conversation (same agentSessionId), prompt = feedback only
    expect(new Set(builds.map((s) => s.agentSessionId))).toEqual(new Set([builds[0].agentSessionId]))
    const buildCalls = calls.filter((c) => !c.prompt.startsWith('You are reviewing'))
    expect(buildCalls[0].resumeId).toBeNull()
    expect(buildCalls[1].resumeId).toBe(builds[0].agentSessionId)
    expect(buildCalls[1].prompt).toBe('A reviewer rejected your previous attempt:\nMissing tests.\nVERDICT: FAIL\nFix it.')
    // reviewer sees target output + criteria
    expect(calls.find((c) => c.prompt.startsWith('You are reviewing'))!.prompt).toContain('built it')
  })

  it('non-resumable adapters retry with the original prompt + feedback', async () => {
    const ctx = setup()
    const calls: FakeCall[] = []
    let reviews = 0
    const engine = await makeEngine(ctx, {
      adapters: {
        codex: fakeAdapter('codex', calls, () => ({ output: 'codex built' })),
        claude: fakeAdapter('claude', [], () => ({ output: ++reviews === 1 ? 'nope\nVERDICT: FAIL' : 'VERDICT: PASS' }))
      }
    })
    const wf = addWorkflow(ctx, {
      name: 'x',
      description: '',
      inputs: [],
      nodes: [agent('build', 'do it', [], 'p_codex'), check('review', 'build')]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(calls).toHaveLength(2)
    expect(calls[1].resumeId).toBeNull()
    expect(calls[1].prompt).toBe('do it\n\nA reviewer rejected your previous attempt:\nnope\nVERDICT: FAIL\nFix it.')
  })

  it('W4b: command check (exit 0 = PASS) passes on attempt 2; feedback = command output', async () => {
    const ctx = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, (_req, n) => {
          if (n === 2) writeFileSync(join(ctx.paths.scratchDir, 'done.txt'), 'x')
          return { output: `attempt ${n}` }
        })
      }
    })
    const wf = addWorkflow(ctx, {
      name: 'tests',
      description: '',
      inputs: [],
      nodes: [agent('build', 'make done.txt'), check('tests', 'build', { profileId: null, command: 'echo "no done.txt yet" >&2; test -f done.txt' })]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    const t = stepsOf(ctx, run.id, 'tests')
    expect(t.map((s) => s.verdict)).toEqual(['FAIL', 'PASS'])
    expect(t[0].adapter).toBe('shell')
    expect(calls[1].prompt).toContain('no done.txt yet')
  })

  it('W4c: a node after the target but outside the loop waits for the check, and re-running includes intermediate nodes', async () => {
    const ctx = setup()
    let reviews = 0
    const order: string[] = []
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', [], (req, n) => {
          if (req.prompt.startsWith('You are reviewing')) {
            order.push('review')
            return { output: ++reviews === 1 ? 'VERDICT: FAIL' : 'VERDICT: PASS', delayMs: 100 }
          }
          if (req.prompt.startsWith('ship')) {
            order.push('ship')
            return { output: req.prompt }
          }
          order.push('build')
          return { output: `v${n}` }
        })
      }
    })
    const wf = addWorkflow(ctx, {
      name: 'gate',
      description: '',
      inputs: [],
      nodes: [
        agent('build', 'build'),
        shell('fmt', 'echo "fmt of {{build.output}}"', ['build']),
        check('review', 'build', { criteria: 'check {{fmt.output}}' }),
        agent('ship', 'ship {{build.output}}', ['build'])
      ]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    expect(order).toEqual(['build', 'review', 'build', 'review', 'ship'])
    expect(stepsOf(ctx, run.id, 'fmt').map((s) => s.attempt)).toEqual([1, 2]) // loop body includes fmt
    const ship = stepsOf(ctx, run.id, 'ship')
    expect(ship).toHaveLength(1)
    expect(ship[0].output).toBe('ship v3') // reviewed output, never the rejected one (n counts the 2 reviews in between)
  })

  it('W5: room with labels takes turns A,B,A,B and exposes transcript/output downstream', async () => {
    const ctx = setup()
    const calls: FakeCall[] = []
    let turn = 0
    const engine = await makeEngine(ctx, {
      adapters: {
        claude: fakeAdapter('claude', calls, (req) => ({ output: req.prompt.startsWith('Use:') ? 'final' : `turn-${++turn}` }))
      }
    })
    const wf = addWorkflow(ctx, {
      name: 'room',
      description: '',
      inputs: [],
      nodes: [
        {
          id: 'debate',
          type: 'room',
          label: 'Debate',
          after: [],
          cwd: null,
          timeoutMin: 1,
          participants: [
            { profileId: 'p_claude', label: 'Builder' },
            { profileId: 'p_claude', label: 'Skeptic' }
          ],
          topic: 'Should we ship?',
          rounds: 2,
          final: 'last'
        },
        agent('use', 'Use: {{debate.output}} / {{debate.transcript}}', ['debate'])
      ]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    const turns = stepsOf(ctx, run.id, 'debate')
    expect(turns.map((s) => s.participantLabel)).toEqual(['Builder', 'Skeptic', 'Builder', 'Skeptic'])
    expect(turns.map((s) => s.round)).toEqual([1, 1, 2, 2])
    expect(turns[1].sourceStepIds).toEqual([turns[0].id])
    expect(calls[0].prompt).toContain('You are Builder in a discussion with Skeptic.')
    expect(calls[3].prompt).toContain('### Builder (round 2)\n\nturn-3')
    const use = calls[4].prompt
    expect(use.startsWith('Use: turn-4 / Should we ship?')).toBe(true)
    expect((use.match(/### /g) ?? []).length).toBe(4)
  })

  it('room final=summary adds one turn by participants[0]', async () => {
    const ctx = setup()
    const calls: FakeCall[] = []
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', calls, (_r, n) => ({ output: `r${n}` })) } })
    const wf = addWorkflow(ctx, {
      name: 'room',
      description: '',
      inputs: [],
      nodes: [
        {
          id: 'debate',
          type: 'room',
          label: 'D',
          after: [],
          cwd: null,
          timeoutMin: 1,
          participants: [
            { profileId: 'p_claude', label: 'A' },
            { profileId: 'p_claude', label: 'B' }
          ],
          topic: 't',
          rounds: 1,
          final: 'summary'
        }
      ]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    const turns = stepsOf(ctx, run.id)
    expect(turns.map((s) => s.participantLabel)).toEqual(['A', 'B', 'A'])
    expect(calls[2].prompt).toContain('Summarize the conclusion and decided actions.')
  })

  it('W6: shell exit 1 fails the run and cancels a running sibling', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx)
    const wf = addWorkflow(ctx, {
      name: 'w6',
      description: '',
      inputs: [],
      nodes: [shell('slow', 'sleep 30'), shell('bad', 'sleep 0.3; echo broken >&2; exit 1')]
    })
    const t0 = Date.now()
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    const done = await waitRun(ctx, run.id)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(done.status).toBe('failed')
    expect(done.reason).toContain('broken')
    const slow = stepsOf(ctx, run.id, 'slow')[0]
    expect(slow.status).toBe('canceled')
  })

  it('W7: cancel kills the process tree within 3 s', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx)
    const wf = addWorkflow(ctx, { name: 'w7', description: '', inputs: [], nodes: [shell('long', 'sleep 60 & sleep 60; wait')] })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    while (!stepsOf(ctx, run.id)[0]?.pid) await new Promise((r) => setTimeout(r, 20))
    const pid = stepsOf(ctx, run.id)[0].pid!
    const t0 = Date.now()
    await engine.runs.cancel(run.id)
    expect(Date.now() - t0).toBeLessThan(3500)
    expect(ctx.store.getRun(run.id)!.status).toBe('canceled')
    expect(() => process.kill(-pid, 0)).toThrow() // whole group gone
    expect(engine.runs.active()).toHaveLength(0)
  })

  it('rejects invalid workflows at start and reruns with parentRunId', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { adapters: { claude: fakeAdapter('claude', [], () => ({})) } })
    const bad = addWorkflow(ctx, { name: 'bad', description: '', inputs: [], nodes: [agent('a', '{{nope.output}}')] })
    expect(() => engine.runs.start({ kind: 'workflow', workflowId: bad.id, inputs: {} }, { trigger: 'manual' })).toThrow(/invalid/)
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' }, { trigger: 'manual' })
    await waitRun(ctx, run.id)
    const again = engine.runs.rerun(run.id)
    expect(again.trigger).toBe('rerun')
    expect(again.parentRunId).toBe(run.id)
    await waitRun(ctx, again.id)
  })

  it('init marks interrupted runs and steps failed', async () => {
    const ctx = setup()
    ctx.store.insertRun(
      {
        id: 'r_old',
        kind: 'prompt',
        title: 't',
        target: { kind: 'prompt', profileId: 'p_claude', repoId: null, prompt: 'x' },
        workflowId: null,
        scheduleId: null,
        parentRunId: null,
        trigger: 'manual',
        status: 'running',
        reason: null,
        createdAt: '',
        startedAt: '',
        endedAt: null,
        artifactsDir: '/tmp/x/',
        artifactCount: 0
      },
      null
    )
    const engine = await makeEngine(ctx)
    expect(ctx.store.getRun('r_old')!.status).toBe('failed')
    expect(ctx.store.getRun('r_old')!.reason).toBe('Hive quit during run')
    expect(engine.providers.cached()).toHaveLength(5)
  })
})

describe('interactiveSpawn', () => {
  it('claude: --session-id new uuid, asks permission by default, ARTIFACTS_DIR hint, strips auth; resume uses --resume', () => {
    const ctx = setup()
    return makeEngine(ctx).then((engine) => {
      const p = ctx.profiles.get('p_claude')!
      const spec = engine.providers.interactiveSpawn(p, { artifactsDir: '/A/s_1/' })
      expect(spec.args[0]).toBe('--session-id')
      expect(spec.agentSessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(p.permissionMode).toBe('bypass') // profile bypass governs headless steps only
      expect(spec.args).not.toContain('--dangerously-skip-permissions')
      expect(engine.providers.interactiveSpawn(p, { artifactsDir: '/A/', bypass: true }).args).toContain('--dangerously-skip-permissions')
      expect(spec.args.join(' ')).toContain('$ARTIFACTS_DIR (/A/s_1/)')
      expect(spec.stripEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
      const r = engine.providers.interactiveSpawn(p, { artifactsDir: '/A/', resumeAgentSessionId: 'abc' })
      expect(r.args.slice(0, 2)).toEqual(['--resume', 'abc'])
      expect(r.agentSessionId).toBe('abc')
    })
  })

  it('throws adapter_unavailable with the hint', async () => {
    const ctx = setup()
    const engine = await makeEngine(ctx, { available: ['claude'] })
    expect(() => engine.providers.interactiveSpawn(ctx.profiles.get('p_codex')!, { artifactsDir: '/A/' })).toThrow(/@openai\/codex/)
  })
})
