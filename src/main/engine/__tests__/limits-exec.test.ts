/**
 * CONTRACT §13 through the real executor: a step whose CLI hits a usage limit gets stopReason 'rate_limited' + the
 * reset; a scheduled run retries exactly once at the reset through the scheduler; Stalled? on silent steps; the
 * reaper kills a step's whole tree on cancel and on a natural end.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentNode } from '../../../shared/live'
import type { AdapterId, EngineEvent } from '../../../shared/types'
import { DEFAULT_ADAPTERS, type Adapter } from '../adapters'
import { createEngineWith } from '../index'
import { createClaudeParser } from '../parse'
import { Reaper, spawnIdOf, systemProcessTable } from '../reaper'
import { addWorkflow, fakeCtx, fakeProviders, profile, waitRun, type FakeCtx } from './fakes'

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'limits', 'claude-rate-limit.stream.jsonl'), 'utf8')
const NOW = new Date('2026-10-16T09:00:00.000Z')

/** A fake claude that replays the limit fixture on stdout and exits 1 (like the real CLI on a limit). */
function limitClaude(): Adapter {
  const script = `process.stdout.write(process.argv[1]); setTimeout(() => process.exit(1), 20)`
  return {
    ...DEFAULT_ADAPTERS.claude,
    headless: () => ({ args: ['-e', script, FIXTURE], agentSessionId: 'sess-1' }),
    createParser: createClaudeParser
  }
}

async function engineFor(ctx: FakeCtx, adapters: Partial<Record<AdapterId, Adapter>> = {}, extra: { stallThresholdMs?: number; stallSweepMs?: number } = {}) {
  const e = createEngineWith(ctx, { adapters, detect: fakeProviders(['claude', 'shell']), ...extra })
  await e.init()
  return e
}
const rootUpdates = (events: EngineEvent[]): AgentNode[] =>
  events.flatMap((e) => (e.type === 'agent.updated' && e.agent.parentId === null ? [e.agent] : []))

describe('usage limit -> stop reason -> retry at reset', () => {
  it('a scheduled run that hits the limit records the reason and schedules exactly one retry', async () => {
    const ctx = fakeCtx()
    ctx.clock.now = NOW
    ctx.profiles.set('p', profile('p', 'claude'))
    const engine = await engineFor(ctx, { claude: limitClaude() })
    const run = engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'work' }, { trigger: 'schedule', scheduleId: null })
    const done = await waitRun(ctx, run.id)
    expect(done.status).toBe('failed')
    expect(done.stopReason).toBe('rate_limited')
    expect(done.resetAt).toBe('2026-10-16T13:00:00.000Z')
    expect(done.retryAt).toBe('2026-10-16T13:01:00.000Z')
    const step = ctx.store.stepsOf(run.id)[0]!
    expect(step.stopReason).toBe('rate_limited')
    expect(step.resetAt).toBe('2026-10-16T13:00:00.000Z')
    // the step root says so too (hub row)
    const root = rootUpdates(ctx.events).filter((a) => a.stepId === step.id).at(-1)!
    expect(root.stopReason).toBe('rate_limited')
    expect(root.resetAt).toBe('2026-10-16T13:00:00.000Z')
    // a single run.updated carried the terminal status together with the stop reason (main notifies once)
    const terminal = ctx.events.filter((e) => e.type === 'run.updated' && e.run.id === run.id && e.run.status === 'failed')
    expect(terminal[0]?.type === 'run.updated' && terminal[0].run.stopReason).toBe('rate_limited')

    // not due yet: nothing fires
    ctx.clock.now = new Date('2026-10-16T13:00:30.000Z')
    engine.scheduler.catchUp('resume')
    expect(ctx.store.getRun(run.id)!.retryRunId ?? null).toBeNull()
    // due: the scheduler reruns it once
    ctx.clock.now = new Date('2026-10-16T13:01:05.000Z')
    engine.scheduler.catchUp('resume')
    const retryId = ctx.store.getRun(run.id)!.retryRunId!
    expect(retryId).toBeTruthy()
    const retry = await waitRun(ctx, retryId)
    expect(retry.trigger).toBe('rerun')
    expect(retry.parentRunId).toBe(run.id)
    // the retry hit the limit again: it is a rerun, so it never schedules another retry
    expect(retry.stopReason).toBe('rate_limited')
    expect(retry.retryAt ?? null).toBeNull()
    engine.scheduler.catchUp('resume')
    expect([...ctx.store.runs.values()].filter((r) => r.parentRunId === run.id)).toHaveLength(1)
    await engine.shutdown()
  })

  it('manual runs and the setting turned off only record the reason; Retry at reset is explicit', async () => {
    const ctx = fakeCtx()
    ctx.clock.now = NOW
    ctx.profiles.set('p', profile('p', 'claude'))
    const engine = await engineFor(ctx, { claude: limitClaude() })
    const manual = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'manual' }).id)
    expect(manual.stopReason).toBe('rate_limited')
    expect(manual.retryAt ?? null).toBeNull()
    ctx.settings.autoRetryRateLimit = false
    const sched = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'schedule' }).id)
    expect(sched.retryAt ?? null).toBeNull()
    // explicit Retry at reset, then cancel
    const set = engine.runs.retryAt!(manual.id, '2026-10-16T13:01:00.000Z')
    expect(set.retryAt).toBe('2026-10-16T13:01:00.000Z')
    expect(engine.runs.retryAt!(manual.id, null).retryAt).toBeNull()
    await engine.shutdown()
  })

  it('an ordinary failure has no stop reason', async () => {
    const ctx = fakeCtx()
    ctx.profiles.set('p', profile('p', 'claude'))
    const boom: Adapter = { ...DEFAULT_ADAPTERS.claude, headless: () => ({ args: ['-e', 'console.error("ENOENT: no such file"); process.exit(2)'], agentSessionId: null }), createParser: createClaudeParser }
    const engine = await engineFor(ctx, { claude: boom })
    const r = await waitRun(ctx, engine.runs.start({ kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }, { trigger: 'schedule' }).id)
    expect(r.status).toBe('failed')
    expect(r.stopReason ?? null).toBeNull()
    expect(r.retryAt ?? null).toBeNull()
    await engine.shutdown()
  })
})

describe('Stalled? on steps', () => {
  it('a silent step is flagged and cleared when it ends; a chatty one never is', async () => {
    const ctx = fakeCtx()
    const engine = await engineFor(ctx, {}, { stallThresholdMs: 400, stallSweepMs: 50 })
    const wf = addWorkflow(ctx, {
      name: 'stall',
      description: '',
      inputs: [],
      nodes: [
        { id: 'quiet', type: 'shell', label: 'quiet', after: [], cwd: null, timeoutMin: 1, command: 'sleep 1.2; echo done' },
        { id: 'chatty', type: 'shell', label: 'chatty', after: [], cwd: null, timeoutMin: 1, command: 'for i in 1 2 3 4 5 6; do echo $i; sleep 0.2; done' }
      ]
    })
    const run = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id)
    expect(run.status).toBe('passed')
    await new Promise((r) => setTimeout(r, 250))
    const steps = ctx.store.stepsOf(run.id)
    const quiet = steps.find((s) => s.nodeId === 'quiet')!
    const chatty = steps.find((s) => s.nodeId === 'chatty')!
    const q = rootUpdates(ctx.events).filter((a) => a.stepId === quiet.id)
    expect(q.some((a) => !!a.stalledSince)).toBe(true)
    expect(q.at(-1)!.stalledSince ?? null).toBeNull()
    expect(rootUpdates(ctx.events).filter((a) => a.stepId === chatty.id).some((a) => !!a.stalledSince)).toBe(false)
    await engine.shutdown()
  })
})

// ---------- reaper through the executor (real processes; macOS) ----------

const userDatas: string[] = []
afterAll(() => {
  // belt and braces: nothing tagged by these tests may survive
  const rows = systemProcessTable.snapshotSync(true)
  for (const r of rows) {
    if (!spawnIdOf(r.env)) continue
    if (!userDatas.some((ud) => r.env!.includes(` HIVE_USER_DATA=${ud} `))) continue
    try {
      process.kill(r.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
})
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleepPids = (marker: string): number[] => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

describe.runIf(process.platform === 'darwin')('reaper through the executor', () => {
  const ESCAPE = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)//hive-escapee'], { detached: true, stdio: 'ignore' }).unref()`

  it('cancel kills the shell step, its background sleep and a detached escapee', async () => {
    const ctx = fakeCtx()
    userDatas.push(ctx.root)
    ctx.reaper = new Reaper({ userData: ctx.root, graceMs: 800, sampleMs: 0 })
    const engine = await engineFor(ctx)
    const marker = `${Math.floor(Math.random() * 1e6) + 600}`
    const wf = addWorkflow(ctx, {
      name: 'bg',
      description: '',
      inputs: [],
      nodes: [{ id: 'bg', type: 'shell', label: 'bg', after: [], cwd: null, timeoutMin: 5, command: `sleep ${marker} & "${process.execPath}" -e "${ESCAPE.replace(/"/g, '\\"')}"; echo started; sleep ${marker}` }]
    })
    const run = engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' })
    // wait until both sleeps and the escapee exist
    const t0 = Date.now()
    let escapees: number[] = []
    while (Date.now() - t0 < 8000) {
      escapees = systemProcessTable.snapshotSync(true).filter((r) => r.env?.includes(` HIVE_USER_DATA=${ctx.root} `) && r.command.includes('hive-escapee')).map((r) => r.pid)
      if (sleepPids(`sleep ${marker}`).length >= 2 && escapees.length) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(sleepPids(`sleep ${marker}`).length).toBeGreaterThanOrEqual(2)
    expect(escapees.length).toBe(1)
    await engine.runs.cancel(run.id)
    expect(ctx.store.getRun(run.id)!.status).toBe('canceled')
    expect(sleepPids(`sleep ${marker}`)).toEqual([])
    expect(escapees.filter(alive)).toEqual([])
    await engine.shutdown()
  }, 30_000)

  it('a step that ends on its own takes its leftovers with it, even one holding its stdout', async () => {
    const ctx = fakeCtx()
    userDatas.push(ctx.root)
    ctx.reaper = new Reaper({ userData: ctx.root, graceMs: 500, sampleMs: 0 })
    const engine = await engineFor(ctx)
    const marker = `${Math.floor(Math.random() * 1e6) + 700}`
    const wf = addWorkflow(ctx, {
      name: 'leak',
      description: '',
      inputs: [],
      // the background sleep keeps the step's stdout open: without the reaper this step would hang for `marker` s
      nodes: [{ id: 'leak', type: 'shell', label: 'leak', after: [], cwd: null, timeoutMin: 5, command: `sleep ${marker} & echo spawned` }]
    })
    const t0 = Date.now()
    const run = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id, 15000)
    expect(run.status).toBe('passed')
    expect(Date.now() - t0).toBeLessThan(10_000)
    const t1 = Date.now()
    while (sleepPids(`sleep ${marker}`).length && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100))
    expect(sleepPids(`sleep ${marker}`)).toEqual([])
    expect(ctx.store.stepsOf(run.id)[0]!.output).toContain('spawned')
    await engine.shutdown()
  }, 30_000)

  it('every step spawn carries HIVE_SPAWN_ID=<step id> and this HIVE_USER_DATA', async () => {
    const ctx = fakeCtx()
    ctx.reaper = new Reaper({ userData: ctx.root, sampleMs: 0 })
    const engine = await engineFor(ctx)
    const wf = addWorkflow(ctx, { name: 'env', description: '', inputs: [], nodes: [{ id: 'env', type: 'shell', label: 'env', after: [], cwd: null, timeoutMin: 1, command: 'echo "id=$HIVE_SPAWN_ID ud=$HIVE_USER_DATA"' }] })
    const run = await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id)
    const step = ctx.store.stepsOf(run.id)[0]!
    expect(step.output).toBe(`id=${step.id} ud=${ctx.root}`)
    await engine.shutdown()
  })
})
