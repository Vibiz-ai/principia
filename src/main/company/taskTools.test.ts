import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { AuthorDrafts } from '../author/drafts'
import { buildAuthorHandlers } from '../author/server/tools'
import { buildHandlers } from '../memory/server/build'
import { withTaskTools } from '../memory/server/tools'
import { Dispatcher, HookedCompanyStore, type DispatcherSessions } from './dispatcher'
import { parseTaskReport } from './reportHarvest'
import { callTaskTool, taskResultFromAnswer, TASK_MAX_OUTPUT, TASK_NOTE, TASK_TOOLS, type TaskTool } from './taskToolDefs'
import { TASK_CREATE_CAPS, TaskTools, type TaskCaller } from './taskTools'
import type { LiveOwner, StartRunOptions } from '../../shared/engine'
import type { CompanyTaskInput } from '../../shared/company'
import type { Run, RunTarget, Session } from '../../shared/types'

let db: DB; let store: Store; let c: HookedCompanyStore; let dir: string; let d: Dispatcher; let tools: TaskTools
let enabled = true
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let seq = 0
let clock = new Date('2026-10-20T10:00:00.000Z')
const redact = (s: string) => s.replace(/sk-[a-z0-9]{8,}/gi, '••••')

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_t${++seq}`
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), new Date().toISOString(), dir, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}
let sessionN = 0
const sessions: DispatcherSessions = {
  create: req => {
    const id = `session_${++sessionN}`
    db.prepare(`INSERT INTO sessions(id,title,profile_id,adapter,repo_id,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id) VALUES(?,?,?,?,?,?,'running',80,24,?,?,?,?)`).run(id, req.title, req.profileId, 'claude', null, dir, new Date().toISOString(), dir, dir, req.companyId)
    return { id } as Session
  },
  isLive: () => true,
  kill: async () => undefined
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-tasktools-'))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new HookedCompanyStore(store)
  enabled = true; started = []; clock = new Date('2026-10-20T10:00:00.000Z')
  d = new Dispatcher({ company: c, startRun, cancelRun: async id => end(id, 'canceled', 'Canceled'), enabled: () => enabled, sessions, now: () => clock })
  c.hooks = d.hooks()
  tools = new TaskTools({ company: () => c, redact, enabled: () => enabled, now: () => clock, pump: id => void d.pump(id) })
  // as wire.ts does: the pending handoff is applied right before every syncRun
  const sync = c.syncRun.bind(c)
  c.syncRun = run => { tools.beforeSyncRun(run); return sync(run) }
})
afterEach(() => { d.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

function end(runId: string, status: Run['status'], reason: string | null = null) {
  db.prepare('UPDATE runs SET status=?, reason=? WHERE id=?').run(status, reason, runId)
  const run = started.find(s => s.run.id === runId)!.run
  d.onRunUpdated({ ...run, status, reason })
}
const flush = () => new Promise(r => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 5; i++) await flush() }

function board(o: { name?: string; adapter?: 'claude' | 'codex' } = {}) {
  const co = c.create({ name: o.name ?? 'Acme' })
  const marketing = c.departments.save({ companyId: co.id, name: 'Marketing' })
  const dev = c.departments.save({ companyId: co.id, name: 'Development', key: 'development' })
  const profile = store.createProfile({ name: 'Agent', adapter: o.adapter ?? 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const writer = c.departments.saveAgent({ companyId: co.id, departmentId: marketing.id, kind: 'profile', refId: profile.id, name: 'Copywriter', data: { autonomy: 'manual' } })
  const fixer = c.departments.saveAgent({ companyId: co.id, departmentId: dev.id, kind: 'profile', refId: profile.id, name: 'Bug fixer', data: { autonomy: 'manual' } })
  const task = (over: Partial<CompanyTaskInput> = {}) => c.createTask({ title: 'Launch post', description: 'Write the launch post', companyId: co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: marketing.id, agentId: writer.id, ...over })
  /** Run now on a task: its run and the live owner of its headless step. */
  const run = (taskId: string) => {
    d.runNow(taskId)
    const r = started[started.length - 1].run
    return { run: r, owner: { runId: r.id, stepId: `st_${r.id.replace(/_/g, '')}` } as LiveOwner }
  }
  return { co, marketing, dev, profile, writer, fixer, task, run }
}
/** A call as the broker would serve it (the caller always from the owner). */
const call = (owner: LiveOwner, tool: TaskTool, args: Record<string, unknown> = {}) => tools.call(tools.resolveCaller(owner), tool, args)
const kinds = (id: string) => c.detail(id).activity.map(a => a.kind)

/** The broker with only what the task path uses. */
function broker(): AuthorBroker {
  const deps = { drafts: new AuthorDrafts(db), tasks: { resolve: (o: LiveOwner) => tools.resolveCaller(o), call: (caller: unknown, tool: TaskTool, args: Record<string, unknown>, hints: { companyId: string | null; taskId: string | null; callId: string | null }) => tools.call(caller as TaskCaller, tool, args, hints) } }
  return new AuthorBroker(deps as unknown as BrokerDeps)
}
let callN = 0
/** One line through the broker, like the live bridge delivers it. */
function viaBroker(b: AuthorBroker, owner: LiveOwner, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  return new Promise(resolve => b.handleCall(owner, { hive: 'author_call', call_id: `hac_${String(++callN).padStart(10, '0')}`, tool, args, ...extra }, (_id, payload) => resolve(payload as never)))
}

describe('DEPARTMENTS.md §4.5 report harvest: the fenced principia-task-report block', () => {
  const fence = (body: string, after = '') => `Done. Here is what I did.\n\n\`\`\`principia-task-report\n${body}\n\`\`\`${after}`
  it('parses a trailing block (backticks or tildes) and clips to the task_report limits', () => {
    expect(parseTaskReport(fence('{"outcome":"review","summary":"Post drafted","evidence":["docs/post.md"]}', '\n  \n'))).toEqual({ outcome: 'review', summary: 'Post drafted', evidence: ['docs/post.md'] })
    expect(parseTaskReport('x\n~~~~ principia-task-report\n{"outcome":"blocked","summary":"No access"}\n~~~~')).toEqual({ outcome: 'blocked', summary: 'No access', evidence: [] })
    const long = parseTaskReport(fence(JSON.stringify({ outcome: 'review', summary: 'y'.repeat(9000), evidence: Array.from({ length: 40 }, () => 'z'.repeat(900)) })))!
    expect(long.summary.length).toBeLessThanOrEqual(4000)
    expect(long.evidence).toHaveLength(20)
    expect(long.evidence[0].length).toBeLessThanOrEqual(500)
    // the last block wins
    expect(parseTaskReport(`${fence('{"outcome":"blocked","summary":"first"}')}\nmore\n${fence('{"outcome":"review","summary":"second"}')}`)?.summary).toBe('second')
  })
  it('a malformed, non-trailing or wrong-shape block is no report', () => {
    expect(parseTaskReport(fence('{"outcome":"review", summary: oops}'))).toBeNull()
    expect(parseTaskReport(fence('{"outcome":"done","summary":"I finished"}'))).toBeNull()
    expect(parseTaskReport(fence('{"outcome":"review"}'))).toBeNull()
    expect(parseTaskReport(fence('{"outcome":"review","summary":"ok"}', '\nOne more thing after the block.'))).toBeNull()
    expect(parseTaskReport('```principia-task-report\n{"outcome":"review","summary":"never closed"}')).toBeNull()
    expect(parseTaskReport('```json\n{"outcome":"review","summary":"wrong fence"}\n```')).toBeNull()
    expect(parseTaskReport('')).toBeNull()
  })
  it('a Codex fenced report moves the task to the reported outcome at run end', async () => {
    const b = board({ adapter: 'codex' })
    const t = b.task(), u = b.task({ title: 'Second' })
    const { run } = b.run(t.id)
    // Codex gets no tools: the step's toolset is null, the footer asks for the fence
    expect(tools.toolset({ runId: run.id, taskId: t.id, agentId: b.writer.id, stepId: 'st_1', adapter: 'codex', companyId: b.co.id })).toBeNull()
    expect((started[0].target as { prompt: string }).prompt).toContain('principia-task-report')
    expect(tools.harvest({ runId: run.id, stepId: 'st_1', adapter: 'codex', status: 'passed', output: fence('{"outcome":"blocked","summary":"Need the brand guide sk-abcdefghij1234","evidence":[]}') })).toMatchObject({ outcome: 'blocked' })
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'agent', report: { outcome: 'blocked', summary: 'Need the brand guide ••••' } })
    // review moves it to in_review with the report (not flagged "no report")
    const second = b.run(u.id).run
    tools.harvest({ runId: second.id, stepId: 'st_2', adapter: 'codex', status: 'passed', output: fence('{"outcome":"review","summary":"Second draft ready","evidence":["post.md"]}') })
    end(second.id, 'passed')
    await settle()
    expect(c.task(u.id)).toMatchObject({ status: 'in_review', report: { outcome: 'review', summary: 'Second draft ready', evidence: ['post.md'] } })
    expect(c.detail(u.id).activity.at(-1)).toMatchObject({ kind: 'report', by: 'agent' })
  })
  it('a malformed fence counts as no report: passed goes to in_review flagged, never parked or rerun', async () => {
    const b = board({ adapter: 'codex' })
    const t = b.task()
    const { run } = b.run(t.id)
    expect(tools.harvest({ runId: run.id, stepId: 'st_1', adapter: 'codex', status: 'passed', output: fence('{"outcome":"review","summary":') })).toBeNull()
    end(run.id, 'passed')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(c.task(t.id)).toMatchObject({ status: 'in_review', report: null })
    expect(c.detail(t.id).activity.at(-1)?.message).toContain('no report')
    expect(started).toHaveLength(1)
  })
  it('never overwrites a report set through task_report, and ignores failed steps', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    call(owner, 'task_report', { outcome: 'review', summary: 'Via MCP', evidence: [] })
    expect(tools.harvest({ runId: run.id, stepId: 's', adapter: 'claude', status: 'passed', output: fence('{"outcome":"blocked","summary":"fence"}') })).toBeNull()
    expect(c.task(t.id).report?.summary).toBe('Via MCP')
    const u = b.task({ title: 'Other', agentId: b.fixer.id, departmentId: b.dev.id })
    const r2 = b.run(u.id).run
    expect(tools.harvest({ runId: r2.id, stepId: 's', adapter: 'codex', status: 'failed', output: fence('{"outcome":"review","summary":"x"}') })).toBeNull()
  })
})

describe('DEPARTMENTS.md §6 hivetask: scope', () => {
  it('reads are scoped to the caller company; another company task reads as not found (by id and identifier)', () => {
    const a = board(), z = board({ name: 'Zeta' })
    const mine = a.task(), theirs = z.task({ title: 'Zeta secret plan' })
    const { owner } = a.run(mine.id)
    expect(call(owner, 'task_get')).toMatchObject({ current: true, task: { identifier: mine.identifier, description: 'Write the launch post' }, note: TASK_NOTE })
    expect(() => call(owner, 'task_get', { id: theirs.id })).toThrow('Task not found in this company')
    expect(() => call(owner, 'task_get', { id: theirs.identifier })).toThrow('Task not found in this company')
    const open = call(owner, 'task_list', { scope: 'open', limit: 50 }) as { tasks: { id: string }[] }
    expect(open.tasks.map(t => t.id)).toEqual([mine.id])
    expect(JSON.stringify(call(owner, 'task_list', { scope: 'open' }))).not.toContain('Zeta')
  })
  it('cross-company ids and lines are rejected through the broker (step and session owners)', async () => {
    const a = board(), z = board({ name: 'Zeta' })
    const mine = a.task(), theirs = z.task()
    const { owner } = a.run(mine.id)
    const b = broker()
    expect(await viaBroker(b, owner, 'task_get', { id: theirs.id })).toEqual({ ok: false, error: 'Task not found in this company' })
    expect((await viaBroker(b, owner, 'task_get', {}, { company_id: z.co.id })).error).toContain('another company')
    expect((await viaBroker(b, owner, 'task_report', { outcome: 'review', summary: 'x' }, { task_id: theirs.id })).error).toContain('another task')
    const ok = await viaBroker(b, owner, 'task_get', {}, { company_id: a.co.id, task_id: mine.id })
    expect(ok.ok).toBe(true)
    // a Zeta session holding no task: Zeta's board only, and no writes on any task
    const s = sessions.create({ companyId: z.co.id, profileId: a.profile.id, repoId: null, cols: 80, rows: 24, title: 'Zeta chat', initialPrompt: '', resumeAgentSessionId: null })
    const so: LiveOwner = { sessionId: s.id }
    expect((await viaBroker(b, so, 'task_get', { id: mine.id })).error).toBe('Task not found in this company')
    expect((await viaBroker(b, so, 'task_comment', { text: 'hi' })).error).toBe('You are not working on a task')
    expect((await viaBroker(b, so, 'task_list', { scope: 'open' })).result?.tasks).toEqual([expect.objectContaining({ id: theirs.id })])
    // a run with no task gets no task tools at all
    expect((await viaBroker(b, { runId: 'r_none', stepId: 'st_none' }, 'task_get', {})).error).toContain('only available to runs started for a board task')
  })
  it('the same refusals hold through both MCP servers (hivemem for steps, hive for sessions)', async () => {
    const a = board(), z = board({ name: 'Zeta' })
    const mine = a.task(), theirs = z.task()
    const { owner } = a.run(mine.id)
    const b = broker()
    const liveDir = path.join(dir, 'live'); fs.mkdirSync(path.join(liveDir, 'answers'), { recursive: true }); fs.writeFileSync(path.join(liveDir, 'events.jsonl'), '')
    // main's side of the mailbox: read the last line, hand it to the broker as the owner's
    const serve = (o: LiveOwner) => async () => {
      const lines = fs.readFileSync(path.join(liveDir, 'events.jsonl'), 'utf8').trim().split('\n')
      const line = JSON.parse(lines[lines.length - 1])
      return new Promise<unknown>(resolve => b.handleCall(o, line, (_id, p) => resolve(p)))
    }
    const hivemem = withTaskTools(buildHandlers({}).handlers, { HIVE_TASK_ID: mine.id, HIVE_TASK_COMPANY_ID: a.co.id, HIVE_LIVE_DIR: liveDir })
    expect(hivemem.listTools().map(t => t.name)).toEqual(expect.arrayContaining([...TASK_TOOLS]))
    const own = await callTaskTool(liveDir, 'task_get', {}, {}, { companyId: a.co.id, taskId: mine.id }, serve(owner))
    expect(own.isError).toBeFalsy()
    const cross = await callTaskTool(liveDir, 'task_get', { id: theirs.id }, {}, { companyId: a.co.id, taskId: mine.id }, serve(owner))
    expect(cross).toMatchObject({ isError: true, content: [{ text: 'Task not found in this company' }] })
    // a server spawned for Zeta but sitting in Acme's step is refused
    const forged = await callTaskTool(liveDir, 'task_comment', { text: 'x' }, {}, { companyId: z.co.id, taskId: mine.id }, serve(owner))
    expect(forged.isError).toBe(true)
    // the hive server of a board session lists task_* and sends HIVE_COMPANY_ID + HIVE_TASK_ID on every line
    const hive = buildAuthorHandlers({ HIVE_LIVE_DIR: liveDir, HIVE_TOOLSETS: 'author,task', HIVE_COMPANY_ID: z.co.id, HIVE_TASK_ID: theirs.id })
    expect(hive.listTools().map(t => t.name)).toEqual(expect.arrayContaining([...TASK_TOOLS]))
    expect(buildAuthorHandlers({ HIVE_LIVE_DIR: liveDir, HIVE_TOOLSETS: 'author' }).listTools().map(t => t.name)).not.toContain('task_get')
    const s = sessions.create({ companyId: z.co.id, profileId: a.profile.id, repoId: null, cols: 80, rows: 24, title: 'Zeta chat', initialPrompt: '', resumeAgentSessionId: null })
    const res = await callTaskTool(liveDir, 'task_get', { id: mine.identifier }, {}, { companyId: z.co.id }, serve({ sessionId: s.id }))
    expect(res).toMatchObject({ isError: true, content: [{ text: 'Task not found in this company' }] })
  })
  it('hivemem lists the task tools only for a task run step with a live dir', () => {
    const base = buildHandlers({}).handlers
    expect(withTaskTools(base, {}).listTools().map(t => t.name)).not.toContain('task_get')
    expect(withTaskTools(base, { HIVE_TASK_ID: 'task_x' }).listTools().map(t => t.name)).not.toContain('task_get')
    expect(buildHandlers({ HIVE_TASK_ID: 'task_x', HIVE_LIVE_DIR: dir }).handlers.listTools().map(t => t.name)).toEqual(expect.arrayContaining(['ask_user', 'task_report']))
  })
  it('the toolset is offered to claude steps of a task run only, and not with departments off', () => {
    const b = board()
    const t = b.task()
    const req = { runId: 'r_1', taskId: t.id, agentId: b.writer.id, stepId: 's', adapter: 'claude' as const, companyId: b.co.id }
    expect(tools.toolset(req)).toEqual({ env: { HIVE_TASK_ID: t.id, HIVE_TASK_COMPANY_ID: b.co.id }, toolNames: [...TASK_TOOLS] })
    expect(tools.toolset({ ...req, adapter: 'gemini' })).toBeNull()
    expect(tools.toolset({ ...req, companyId: 'co_other' })).toBeNull()
    enabled = false
    expect(tools.toolset(req)).toBeNull()
  })
  it('writes only on the caller own task, and only while its run holds it', async () => {
    const b = board()
    const t = b.task(), other = b.task({ title: 'Other', agentId: b.fixer.id, departmentId: b.dev.id })
    const { run, owner } = b.run(t.id)
    const o2 = b.run(other.id)
    // another agent's in-flight task: who has it, nothing more
    const peek = call(owner, 'task_get', { id: other.id })
    expect(peek).toMatchObject({ inFlight: true, task: { identifier: other.identifier, agent: { name: 'Bug fixer' } } })
    expect(JSON.stringify(peek)).not.toContain('Write the launch post')
    call(owner, 'task_comment', { text: 'Progress' })
    expect(c.detail(other.id).activity.some(a => a.kind === 'comment')).toBe(false)
    end(run.id, 'passed')
    await settle()
    for (const [tool, args] of [['task_comment', { text: 'late' }], ['task_report', { outcome: 'review', summary: 'late' }], ['task_ask', { kind: 'question', prompt: 'late?' }], ['task_handoff', { departmentKey: 'development', reason: 'late' }], ['task_create', { title: 'late' }]] as const) {
      expect(() => call(owner, tool, args)).toThrow('no longer yours')
    }
    // reads still work for the finished step
    expect(call(owner, 'task_get')).toMatchObject({ task: { status: 'in_review' } })
    expect(c.task(other.id)).toMatchObject({ status: 'in_progress', runId: o2.run.id })
  })
})

describe('DEPARTMENTS.md §6 hivetask: tools', () => {
  it('task_comment is redacted and never wakes anyone', async () => {
    const b = board()
    const t = b.task()
    const { owner } = b.run(t.id)
    call(owner, 'task_comment', { text: 'Using key sk-abcdefghij1234 for the API' })
    const last = c.detail(t.id).activity.at(-1)!
    expect(last).toMatchObject({ kind: 'comment', by: 'agent', message: 'Using key •••• for the API' })
    expect(c.task(t.id).pendingWake).toBeNull()
    expect(kinds(t.id)).not.toContain('coalesced')
  })
  it('task_ask parks needs_input at run end; a choice needs options; the last closing call wins', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    expect(() => call(owner, 'task_ask', { kind: 'choice', prompt: 'Which tone?' })).toThrow("needs at least 2 options")
    call(owner, 'task_report', { outcome: 'review', summary: 'draft' })
    call(owner, 'task_ask', { kind: 'choice', prompt: 'Which tone?', options: ['Playful', 'Formal'] })
    expect(c.task(t.id).report).toBeNull()
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input', ask: { kind: 'choice', options: ['Playful', 'Formal'] } })
  })
  it('no path sets done: outcome done is refused, a review report goes to in_review for the human', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    expect(() => call(owner, 'task_report', { outcome: 'done', summary: 'shipped' })).toThrow('Invalid arguments')
    expect(() => call(owner, 'task_report', { outcome: 'review', summary: 'x', status: 'done' })).toThrow('Invalid arguments')
    call(owner, 'task_report', { outcome: 'review', summary: 'Ready', evidence: ['post.md'] })
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id).status).toBe('in_review')
    // no tool exists for done, config edits or run cancel
    expect(TASK_TOOLS.some(n => /done|approve|cancel|config|agent_save|department_save/.test(n))).toBe(false)
  })
  it('task_create: child of the current task, source agent, routed; caps 4 per task and depth 1', async () => {
    const b = board()
    const t = b.task()
    const { owner } = b.run(t.id)
    const r = call(owner, 'task_create', { title: 'Fix the signup bug', description: 'Seen while writing', departmentKey: 'development' }) as { task: { id: string; identifier: string } }
    const child = c.task(r.task.id)
    // the only agent in Development is assigned by the router on create
    expect(child).toMatchObject({ parentId: t.id, source: 'agent', status: 'todo', departmentId: b.dev.id, agentId: b.fixer.id, companyId: b.co.id })
    expect(kinds(child.id)).toEqual(expect.arrayContaining(['created', 'routed']))
    expect(c.detail(child.id).activity[0].by).toBe('agent')
    expect(() => call(owner, 'task_create', { title: 'x', departmentKey: 'nope' })).toThrow('No department "nope"')
    for (let i = 2; i <= TASK_CREATE_CAPS.perTask; i++) call(owner, 'task_create', { title: `Follow-up ${i}` })
    expect(() => call(owner, 'task_create', { title: 'One too many' })).toThrow(`limit ${TASK_CREATE_CAPS.perTask}`)
    // the subtask's own run cannot file sub-subtasks
    const sub = b.run(child.id)
    expect(() => call(sub.owner, 'task_create', { title: 'Deeper' })).toThrow('one level deep')
  })
  it('task_create: at most 10 per company per hour, across tasks; another company is not counted', async () => {
    // task rows stamp createdAt with the wall clock: move it with the test clock
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(clock)
    try {
      const b = board(), z = board({ name: 'Zeta' })
      let filed = 0
      for (let i = 0; i < 3; i++) {
        const { run, owner } = b.run(b.task({ title: `Parent ${i}` }).id)
        for (let k = 0; k < 4 && filed < TASK_CREATE_CAPS.perCompanyPerHour; k++, filed++) call(owner, 'task_create', { title: `Child ${i}.${k}` })
        if (filed >= TASK_CREATE_CAPS.perCompanyPerHour) {
          expect(() => call(owner, 'task_create', { title: 'Eleventh' })).toThrow('limit 10')
          // another company has its own budget
          const zo = b.run(z.task().id).owner
          expect(() => call(zo, 'task_create', { title: 'Zeta follow-up' })).not.toThrow()
          // the window rolls
          clock = new Date(clock.getTime() + 61 * 60_000)
          vi.setSystemTime(clock)
          expect(() => call(owner, 'task_create', { title: 'Next hour' })).not.toThrow()
        }
        end(run.id, 'passed')
        await settle()
      }
      expect(filed).toBe(TASK_CREATE_CAPS.perCompanyPerHour)
    } finally {
      vi.useRealTimers()
    }
  })
  it('task_create blocksCurrent: the current task goes blocked(deps) at run end and heals when the child is done', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    const r = call(owner, 'task_create', { title: 'Get the logo', departmentKey: 'development', blocksCurrent: true }) as { task: { id: string } }
    expect(c.task(t.id).dependencyIds).toEqual([r.task.id])
    call(owner, 'task_report', { outcome: 'review', summary: 'Waiting on the logo' })
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'deps' })
    const child = b.run(r.task.id)
    call(child.owner, 'task_report', { outcome: 'review', summary: 'Logo attached' })
    end(child.run.id, 'passed')
    await settle()
    c.approve(r.task.id, 'Logo is fine')
    expect(c.task(t.id).status).toBe('todo')
    expect(kinds(t.id)).toContain('healed')
  })
  it('task_handoff: todo with the target at run end, handoff activity, no resume of the old conversation', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    c.patchInFlight(t.id, { agentSessionId: 'conv-1' })
    const r = call(owner, 'task_handoff', { departmentKey: 'development', reason: 'This is a code bug' })
    expect(r).toMatchObject({ target: { department: 'development', agent: { name: 'Bug fixer' } }, appliedAt: 'run end' })
    expect(c.task(t.id).status).toBe('in_progress')
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'todo', agentId: b.fixer.id, departmentId: b.dev.id, handoffs: 1, agentSessionId: null, report: null })
    expect(c.task(t.id).pendingWake?.reasons.at(-1)).toContain('This is a code bug')
    expect(c.detail(t.id).activity.find(a => a.kind === 'handoff')).toMatchObject({ by: 'agent' })
    // to an agent of another company: refused
    const z = board({ name: 'Zeta' })
    const second = b.run(t.id)
    expect(() => call(second.owner, 'task_handoff', { agentId: z.writer.id, reason: 'x' })).toThrow('No such agent in this company')
    expect(() => call(second.owner, 'task_handoff', { departmentKey: 'development', reason: 'x' })).toThrow('already yours')
  })
  it('task_handoff: a failed run drops it; after 4 handoffs the task parks with handoff_cap', async () => {
    const b = board()
    const t = b.task()
    let r = b.run(t.id)
    call(r.owner, 'task_handoff', { departmentKey: 'development', reason: 'bug' })
    end(r.run.id, 'failed', 'crashed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'run_failed', agentId: b.writer.id, handoffs: 0 })
    c.unpark(t.id)
    for (let i = 0; i < 4; i++) {
      r = b.run(t.id)
      call(r.owner, 'task_handoff', { departmentKey: i % 2 ? 'marketing' : 'development', reason: `round ${i}` })
      end(r.run.id, 'passed')
      await settle()
      expect(c.task(t.id)).toMatchObject({ status: 'todo', handoffs: i + 1 })
    }
    r = b.run(t.id)
    const fifth = call(r.owner, 'task_handoff', { departmentKey: 'development', reason: 'again' })
    expect(String(fifth.detail)).toContain('handoff_cap')
    end(r.run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'handoff_cap', handoffs: 4 })
    for (let i = 0; i < 3; i++) await d.tick()
    expect(c.task(t.id).status).toBe('blocked')
  })
  it('task_handoff: the next seat never gets the old conversation, whatever order the run hooks fire in; an auto target wakes', async () => {
    const b = board()
    c.departments.saveAgent({ id: b.fixer.id, companyId: b.co.id, departmentId: b.dev.id, kind: 'profile', refId: b.profile.id, name: 'Bug fixer', data: { autonomy: 'auto' } })
    c.setAutopilot(b.co.id, true)
    const t = b.task()
    const { run, owner } = b.run(t.id)
    call(owner, 'task_handoff', { departmentKey: 'development', reason: 'Code bug' })
    // the company run hook (handlers/company.ts) is registered before the dispatcher's: syncRun first, then the
    // dispatcher captures the ended run's claude conversation
    db.prepare("UPDATE runs SET status='passed' WHERE id=?").run(run.id)
    c.syncRun({ ...run, status: 'passed' })
    d.sessionCaptured({ runId: run.id, agentSessionId: 'conv-copywriter' })
    d.onRunUpdated({ ...run, status: 'passed' })
    await settle()
    const now = c.task(t.id)
    expect(now).toMatchObject({ agentId: b.fixer.id, handoffs: 1, agentSessionId: null })
    // the auto Bug fixer was woken by the handoff's pump, with a fresh prompt (no --resume of the Copywriter's turn)
    expect(now.status).toBe('in_progress')
    expect(started).toHaveLength(2)
    expect(started[1].opts).toMatchObject({ taskId: t.id, agentId: b.fixer.id })
    expect((started[1].target as { prompt: string }).prompt).toContain('Code bug')
  })
  it('task_handoff after blocksCurrent: the next seat waits blocked(deps) and gets the task when the child is done', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    const child = call(owner, 'task_create', { title: 'Get the logo', departmentKey: 'marketing', blocksCurrent: true }) as { task: { id: string } }
    call(owner, 'task_handoff', { departmentKey: 'development', reason: 'Code part next' })
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'deps', agentId: b.fixer.id, handoffs: 1, runId: null })
    expect(kinds(t.id)).toEqual(expect.arrayContaining(['handoff', 'parked']))
    const cr = b.run(child.task.id)
    call(cr.owner, 'task_report', { outcome: 'review', summary: 'Logo attached' })
    end(cr.run.id, 'passed')
    await settle()
    c.approve(child.task.id, 'Logo is fine')
    expect(c.task(t.id)).toMatchObject({ status: 'todo', agentId: b.fixer.id })
  })
  it('task_handoff: a session parked from its row never applies its handoff, and the pending entry is dropped', async () => {
    const b = board()
    const t = b.task(), u = b.task({ title: 'Other' })
    const { session } = d.openSession(t.id, { cols: 80, rows: 24 })
    call({ sessionId: session.id }, 'task_handoff', { departmentKey: 'development', reason: 'bug' })
    d.parkSession(t.id)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'no_report', agentId: b.writer.id, handoffs: 0 })
    const pending = (tools as unknown as { handoffs: Map<string, unknown> }).handoffs
    expect(pending.has(t.id)).toBe(true)
    const r = b.run(u.id)
    call(r.owner, 'task_handoff', { departmentKey: 'development', reason: 'bug too' })
    expect([...pending.keys()]).toEqual([u.id])
  })
  it('task_create: a replayed call (same tool-use id) returns the first task, even at the cap', () => {
    const b = board()
    const t = b.task()
    const { owner } = b.run(t.id)
    const caller = tools.resolveCaller(owner)
    const first = tools.call(caller, 'task_create', { title: 'Once' }, { callId: 'toolu_1' }) as { task: { id: string } }
    for (let i = 2; i <= TASK_CREATE_CAPS.perTask; i++) tools.call(caller, 'task_create', { title: `More ${i}` }, { callId: `toolu_${i}` })
    const again = tools.call(caller, 'task_create', { title: 'Once' }, { callId: 'toolu_1' }) as { task: { id: string }; replayed?: boolean }
    expect(again).toMatchObject({ replayed: true, task: { id: first.task.id } })
    expect(c.listTasks(b.co.id).filter(x => x.parentId === t.id)).toHaveLength(TASK_CREATE_CAPS.perTask)
    expect(() => tools.call(caller, 'task_create', { title: 'New' }, { callId: 'toolu_new' })).toThrow(`limit ${TASK_CREATE_CAPS.perTask}`)
  })
  it('task_handoff: a target gone by run end leaves the turn to syncRun and tells the human', async () => {
    const b = board()
    const t = b.task()
    const { run, owner } = b.run(t.id)
    call(owner, 'task_handoff', { agentId: b.fixer.id, reason: 'bug' })
    c.departments.archiveAgent(b.fixer.id)
    end(run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'in_review', agentId: b.writer.id, handoffs: 0 })
    // a 'handoff' row, not a comment: a comment would wake the task into a retry loop
    expect(c.detail(t.id).activity.some(a => a.kind === 'handoff' && a.message.startsWith('Handoff to Bug fixer'))).toBe(true)
    expect(c.detail(t.id).activity.some(a => a.kind === 'comment' && a.message.startsWith('Handoff to'))).toBe(false)
  })
  it('a session holding its task may write; the lease ending revokes it', async () => {
    const b = board()
    const t = b.task()
    const { session } = d.openSession(t.id, { cols: 80, rows: 24 })
    const so: LiveOwner = { sessionId: session.id }
    expect(tools.resolveCaller(so)).toMatchObject({ kind: 'session', taskId: t.id, holdsTask: true, companyId: b.co.id })
    call(so, 'task_report', { outcome: 'review', summary: 'Done in the session' })
    d.submitSession(t.id)
    expect(c.task(t.id)).toMatchObject({ status: 'in_review', report: { summary: 'Done in the session' } })
    expect(() => call(so, 'task_comment', { text: 'late' })).toThrow('no longer yours')
  })
  it('tool output never exceeds 8000 chars and is marked as data', () => {
    const b = board()
    const t = b.task({ description: 'd'.repeat(50_000) })
    for (let i = 0; i < 60; i++) b.task({ title: `Task ${i} ${'t'.repeat(230)}`, agentId: null })
    const { owner } = b.run(t.id)
    for (let i = 0; i < 12; i++) call(owner, 'task_comment', { text: 'c'.repeat(4000) })
    const get = call(owner, 'task_get')
    const list = call(owner, 'task_list', { scope: 'open', limit: 50 })
    for (const out of [get, list]) {
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(TASK_MAX_OUTPUT)
      expect(out.note).toBe(TASK_NOTE)
    }
    // the servers cap whatever main answers
    const huge = taskResultFromAnswer({ ok: true, result: { text: 'x'.repeat(20_000) } })
    expect((huge.content[0] as { text: string }).text.length).toBeLessThanOrEqual(TASK_MAX_OUTPUT)
    expect((taskResultFromAnswer({ ok: false, error: 'e'.repeat(20_000) }).content[0] as { text: string }).text.length).toBeLessThanOrEqual(TASK_MAX_OUTPUT)
  })
  it('every call is refused with departments off', () => {
    const b = board()
    const t = b.task()
    const { owner } = b.run(t.id)
    enabled = false
    expect(() => tools.resolveCaller(owner)).toThrow('board is off')
  })
})
