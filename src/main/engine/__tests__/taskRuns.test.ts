/** DEPARTMENTS.md §3.6, §4.3, §6: task runs in the engine (company from the task, task link, resume, time cap, toolset). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TASK_WRAP_UP_TEXT, type CompanyBridge, type MemoryGrant, type RunTaskLink, type TaskRunBridge } from '../../../shared/engine'
import type { Run, WorkflowDraft } from '../../../shared/types'
import { createEngineWith } from '../index'
import { fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall, type FakeCtx } from './fakes'

interface Seen { links: (RunTaskLink | null | undefined)[]; sessions: string[]; limits: { taskId: string; minutes: number }[] }
function setup(o: { taskCompany?: string | null; runMinutes?: number | null; toolset?: TaskRunBridge['toolset'] } = {}) {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
  const seen: Seen = { links: [], sessions: [], limits: [] }
  const insert = ctx.store.insertRun.bind(ctx.store)
  ctx.store.insertRun = (run: Run, snap: WorkflowDraft | null, link?: RunTaskLink | null) => { seen.links.push(link); insert(run, snap) }
  const tasks: TaskRunBridge = {
    companyOf: id => (id === 'task_1' ? (o.taskCompany === undefined ? 'co_acme' : o.taskCompany) : null),
    runMinutes: () => o.runMinutes ?? null,
    toolset: o.toolset,
    sessionCaptured: e => void seen.sessions.push(`${e.taskId}:${e.agentSessionId}`),
    timeLimit: e => void seen.limits.push({ taskId: e.taskId, minutes: e.minutes }),
    passportContext: e => `<passport company="${e.companyId}" department="Marketing" task="${e.taskId}">`
  }
  const company: CompanyBridge = {
    resolve: q => q.companyId ?? 'co_personal',
    crossCompany: () => null,
    enforced: () => true,
    workspaceDir: () => null,
    repoIds: () => [],
    tasks
  }
  ctx.company = company
  ctx.passportContext = (_cwd, companyId) => `<passport company="${companyId}">`
  return { ctx, seen }
}
async function engineFor(ctx: FakeCtx, calls: FakeCall[], reply: Parameters<typeof fakeAdapter>[2], o: { taskMinuteMs?: number } = {}) {
  const engine = createEngineWith(ctx, { adapters: { claude: fakeAdapter('claude', calls, reply), codex: fakeAdapter('codex', calls, reply) }, detect: fakeProviders(), taskMinuteMs: o.taskMinuteMs })
  await engine.init()
  return engine
}
const prompt = (profileId = 'p_claude') => ({ kind: 'prompt' as const, profileId, repoId: null, prompt: 'Work on PRN-1' })

describe('engine: board task runs', () => {
  it('a task run gets the task passport (department slot) once; other runs keep the company passport', async () => {
    const { ctx } = setup()
    const calls: FakeCall[] = []
    const engine = await engineFor(ctx, calls, () => ({ output: 'done' }))
    await waitRun(ctx, engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' }).id)
    expect(calls[0].prompt.match(/<passport /g)).toHaveLength(1)
    expect(calls[0].prompt).toContain('department="Marketing" task="task_1"')
    await waitRun(ctx, engine.runs.start(prompt(), { trigger: 'manual', companyId: 'co_acme' }).id)
    expect(calls[1].prompt).toContain('<passport company="co_acme">')
    expect(calls[1].prompt).not.toContain('department=')
  })
  it('inherits the task company first, persists the task link and reads back trigger task', async () => {
    const { ctx, seen } = setup()
    const calls: FakeCall[] = []
    const engine = await engineFor(ctx, calls, () => ({ output: 'done' }))
    const run = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' })
    expect(run.companyId).toBe('co_acme')
    expect(run.trigger).toBe('task')
    expect(seen.links).toEqual([{ taskId: 'task_1', agentId: 'agt_1' }])
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    // a conflicting explicit company is a cross-company launch
    expect(() => engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1', companyId: 'co_other' })).toThrow('another company')
    // other runs carry no link
    const plain = engine.runs.start(prompt(), { trigger: 'manual' })
    expect(seen.links.at(-1)).toBeNull()
    await waitRun(ctx, plain.id)
  })
  it('an unknown task falls back to the usual inheritance', async () => {
    const { ctx } = setup({ taskCompany: null })
    const engine = await engineFor(ctx, [], () => ({ output: 'done' }))
    const run = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: null, companyId: 'co_beta' })
    expect(run.companyId).toBe('co_beta')
    await waitRun(ctx, run.id)
  })
  it('a resumed Claude turn passes --resume and reports the conversation id; codex never resumes', async () => {
    const { ctx, seen } = setup()
    const calls: FakeCall[] = []
    const engine = await engineFor(ctx, calls, () => ({ output: 'done' }))
    const run = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1', resumeSessionId: 'conv-1' })
    await waitRun(ctx, run.id)
    expect(calls[0].resumeId).toBe('conv-1')
    expect(seen.sessions).toEqual(['task_1:conv-1'])
    const fresh = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' })
    await waitRun(ctx, fresh.id)
    expect(calls[1].resumeId).toBeNull()
    expect(seen.sessions).toEqual(['task_1:conv-1', 'task_1:sess-claude-2'])
    const codex = engine.runs.start(prompt('p_codex'), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1', resumeSessionId: 'conv-1' })
    await waitRun(ctx, codex.id)
    expect(calls[2].resumeId).toBeNull()
    expect(seen.sessions).toHaveLength(2)
  })
  it('the time cap warns in-band, then cancels the run and tells main to park the task with limit', async () => {
    const { ctx, seen } = setup({ runMinutes: 1 })
    const calls: FakeCall[] = []
    // one "minute" = 600 ms: the warning comes at the half (the 2-minute lead is longer than half the cap)
    const engine = await engineFor(ctx, calls, () => ({ output: 'still going', delayMs: 10_000 }), { taskMinuteMs: 600 })
    const run = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' })
    const ended = await waitRun(ctx, run.id)
    expect(ended.status).toBe('canceled')
    expect(ended.reason).toBe('Time limit reached (1 min)')
    expect(seen.limits).toEqual([{ taskId: 'task_1', minutes: 1 }])
    expect(JSON.stringify(ctx.events)).toContain(TASK_WRAP_UP_TEXT.slice(0, 40))
  })
  it('an explicit runMinutes wins over the seat; runs without a task have no cap', async () => {
    const { ctx, seen } = setup({ runMinutes: 1 })
    const engine = await engineFor(ctx, [], () => ({ output: 'ok', delayMs: 900 }), { taskMinuteMs: 300 })
    const run = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1', runMinutes: 10 })
    expect((await waitRun(ctx, run.id)).status).toBe('passed')
    const plain = engine.runs.start(prompt(), { trigger: 'manual' })
    expect((await waitRun(ctx, plain.id)).status).toBe('passed')
    expect(seen.limits).toEqual([])
  })
  it('the task toolset rides on the step hivemem server (env + allowed tools), claude task runs only', async () => {
    const { ctx } = setup({ toolset: req => ({ env: { HIVE_TASK_ID: req.taskId, HIVE_TASK_RUN: req.runId }, toolNames: ['task_get', 'task_report'] }) })
    let n = 0
    ctx.memory = {
      grant: () => ({ grantId: `mgr_${++n}`, server: { name: 'hivemem', command: '/bin/hive', args: ['/x/mcp-memory.js'], env: { HIVE_MEM_GRANT: `mgr_${n}` } }, toolNames: ['memory_search'], spawnDir: join(ctx.root, 'memory', 'spawn'), brief: '' }) as MemoryGrant,
      release: () => {}
    }
    const calls: FakeCall[] = []
    let cfg: { mcpServers: { hivemem: { env: Record<string, string> } } } | null = null
    const engine = await engineFor(ctx, calls, req => {
      if (req.mcpArgs && !cfg) cfg = JSON.parse(readFileSync(req.mcpArgs[1], 'utf8'))
      return { output: 'ok' }
    })
    const run = engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' })
    await waitRun(ctx, run.id)
    expect(calls[0].mcpArgs![3]).toBe('mcp__hivemem__memory_search,mcp__hivemem__task_get,mcp__hivemem__task_report')
    expect(cfg!.mcpServers.hivemem.env).toMatchObject({ HIVE_MEM_GRANT: 'mgr_1', HIVE_TASK_ID: 'task_1', HIVE_TASK_RUN: run.id })
    // not a task run: no task tools
    const plain = engine.runs.start(prompt(), { trigger: 'manual' })
    await waitRun(ctx, plain.id)
    expect(calls[1].mcpArgs![3]).toBe('mcp__hivemem__memory_search')
  })
  it('task-mode schedules go to the company bridge board (§8): a fire wakes the card and starts no run', async () => {
    const { ctx } = setup()
    const fired: string[] = []
    ctx.company!.boards = {
      schedules: { enabled: () => true, fire: (sch, f) => { fired.push(`${sch.id}:${f.trigger}`); return { taskId: 'task_1', identifier: 'PRN-1', created: true, coalesced: false, waiting: null } } },
      slack: { enabled: () => true, message: () => { throw new Error('unused') } }
    }
    ctx.store.schedules.set('sch_1', {
      id: 'sch_1', name: 'Digest', target: { ...prompt(), mode: 'task', agentId: 'agt_1' }, when: { kind: 'interval', minutes: 60 }, preset: null, enabled: true,
      sentence: 'Every hour', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
    } as never)
    const calls: FakeCall[] = []
    const engine = await engineFor(ctx, calls, () => ({ output: 'done' }))
    const r = engine.scheduler.fireNow!('sch_1')
    expect(r.run).toBeNull()
    expect(r.card?.identifier).toBe('PRN-1')
    expect(fired).toEqual(['sch_1:manual'])
    expect(calls).toHaveLength(0)
  })
})
