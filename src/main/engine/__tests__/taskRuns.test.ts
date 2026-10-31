/** DEPARTMENTS.md §3.6, §4.3, §6: task runs in the engine (company from the task, task link, resume, toolset). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CompanyBridge, MemoryGrant, RunTaskLink, TaskRunBridge } from '../../../shared/engine'
import type { Run, WorkflowDraft } from '../../../shared/types'
import { createEngineWith } from '../index'
import { addWorkflow, fakeAdapter, fakeCtx, fakeProviders, profile, waitRun, type FakeCall, type FakeCtx } from './fakes'
import { fakeBridge } from './liveFakes'

const processTimeouts = vi.hoisted(() => [] as number[])
vi.mock('../process', async importActual => {
  const actual = await importActual<typeof import('../process')>()
  return { ...actual, startProcess: (o: Parameters<typeof actual.startProcess>[0]) => { processTimeouts.push(o.timeoutMs); return actual.startProcess(o) } }
})

interface Seen { links: (RunTaskLink | null | undefined)[]; sessions: string[] }
function setup(o: { taskCompany?: string | null; toolset?: TaskRunBridge['toolset'] } = {}) {
  const ctx = fakeCtx()
  ctx.profiles.set('p_claude', profile('p_claude', 'claude'))
  ctx.profiles.set('p_codex', profile('p_codex', 'codex'))
  const seen: Seen = { links: [], sessions: [] }
  const insert = ctx.store.insertRun.bind(ctx.store)
  ctx.store.insertRun = (run: Run, snap: WorkflowDraft | null, link?: RunTaskLink | null) => { seen.links.push(link); insert(run, snap) }
  const tasks: TaskRunBridge = {
    companyOf: id => (id === 'task_1' ? (o.taskCompany === undefined ? 'co_acme' : o.taskCompany) : null),
    toolset: o.toolset,
    sessionCaptured: e => void seen.sessions.push(`${e.taskId}:${e.agentSessionId}`),
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
async function engineFor(ctx: FakeCtx, calls: FakeCall[], reply: Parameters<typeof fakeAdapter>[2]) {
  const engine = createEngineWith(ctx, { adapters: { claude: fakeAdapter('claude', calls, reply), codex: fakeAdapter('codex', calls, reply) }, detect: fakeProviders() })
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
  it('a task run has no time limit, and neither has any other run of its own; chat replies and workflow steps keep theirs', async () => {
    const { ctx } = setup()
    const engine = await engineFor(ctx, [], () => ({ output: 'ok' }))
    processTimeouts.length = 0
    await waitRun(ctx, engine.runs.start(prompt(), { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' }).id)
    await waitRun(ctx, engine.runs.start(prompt(), { trigger: 'manual' }).id)
    await waitRun(ctx, engine.runs.start(prompt(), { trigger: 'manual', reply: true }).id)
    const wf = addWorkflow(ctx, { name: 'Draft', description: '', inputs: [], nodes: [{ id: 'draft', type: 'agent', label: 'Draft', after: [], cwd: null, timeoutMin: 45, profileId: 'p_claude', prompt: 'Draft it' }] })
    await waitRun(ctx, engine.runs.start({ kind: 'workflow', workflowId: wf.id, inputs: {} }, { trigger: 'manual' }).id)
    expect(processTimeouts).toEqual([0, 0, 15 * 60_000, 45 * 60_000])
  })
  it('the task toolset rides on the step hivemem server (env + allowed tools), task runs only', async () => {
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
  it('codex task runs get the same task tools (and memory, and the Use Principia rules) through -c overrides', async () => {
    const { ctx } = setup({ toolset: req => ({ env: { HIVE_TASK_ID: req.taskId }, toolNames: ['task_get', 'task_create', 'task_report', 'connections_list'] }) })
    ctx.live = fakeBridge(ctx.root)
    let n = 0
    ctx.memory = {
      grant: () => ({ grantId: `mgr_${++n}`, server: { name: 'hivemem', command: '/bin/hive', args: ['/x/mcp-memory.js'], env: { HIVE_MEM_GRANT: `mgr_${n}` } }, toolNames: ['memory_search', 'memory_write'], spawnDir: join(ctx.root, 'memory', 'spawn'), brief: '' }) as MemoryGrant,
      release: () => {},
      askOnlyServer: () => ({ name: 'hivemem', command: '/bin/hive', args: ['/x/mcp-memory.js'], env: {} })
    }
    const calls: FakeCall[] = []
    const engine = await engineFor(ctx, calls, () => ({ output: 'ok' }))
    const run = engine.runs.start({ ...prompt('p_codex'), memory: 'read-write' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' })
    await waitRun(ctx, run.id)
    const args = calls[0]!.mcpArgs!.join(' ')
    expect(args).toContain('mcp_servers.hivemem.enabled_tools=["memory_search","memory_write","task_get","task_create","task_report","connections_list"]')
    expect(args).toContain('mcp_servers.hivemem.default_tools_approval_mode="approve"')
    expect(args).toContain('mcp_servers.hivemem.env.HIVE_TASK_ID="task_1"')
    // the live dir is the broker's mailbox and the caller's identity
    expect(args).toMatch(/mcp_servers\.hivemem\.env\.HIVE_LIVE_DIR="[^"]+"/)
    expect(args).not.toContain('ask_user')
    expect(calls[0]!.prompt).toContain('## Use Principia')
    expect(calls[0]!.prompt).toContain('task_create')
    expect(calls[0]!.prompt).toContain('principia://connect/stripe')
    // memory off: an empty-memory hivemem with only the task tools
    const off = engine.runs.start({ ...prompt('p_codex'), memory: 'off' }, { trigger: 'task', taskId: 'task_1', agentId: 'agt_1' })
    await waitRun(ctx, off.id)
    const offArgs = calls[1]!.mcpArgs!.join(' ')
    expect(offArgs).toContain('mcp_servers.hivemem.enabled_tools=["task_get","task_create","task_report","connections_list"]')
    expect(offArgs).not.toContain('HIVE_MEM_GRANT')
    // not a task run: memory only, no task tools, no mailbox
    const plain = engine.runs.start({ ...prompt('p_codex'), memory: 'read' }, { trigger: 'manual' })
    await waitRun(ctx, plain.id)
    expect(calls[2]!.mcpArgs!.join(' ')).not.toContain('task_get')
    expect(calls[2]!.mcpArgs!.join(' ')).not.toContain('HIVE_LIVE_DIR')
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
