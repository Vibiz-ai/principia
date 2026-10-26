/**
 * DEPARTMENTS.md §13 D11 step 1: departments, agents and the company board keep companies apart. Two companies over
 * the real modules (hive.db, HookedCompanyStore + Dispatcher, DepartmentStore, TaskTools behind the AuthorBroker, the
 * LiveBridge mailbox, both MCP servers' handlers, and the IPC handlers registered by handlers/company.ts and
 * handlers/board.ts behind ipc.ts's zod validation). Company A's agent can neither list, claim, comment on nor hand off
 * to company B's tasks:
 *
 * - MCP: every task tool through the hivemem server of a headless step and the hive server of a board session, each
 *   driven through its real `callTool` → events.jsonl → LiveBridge → broker → TaskTools → answer file round trip;
 * - IPC: departments:*, companyAgents:*, tasks:* and board:autopilot, called as the renderer would.
 *
 * Each refusal is checked to change nothing of B's (rows, activity, settings) and to start nothing of B's.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcReply = { ok: boolean; data?: unknown; error?: { code: string; message: string } }
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, raw: unknown) => Promise<IpcReply>>() }))
// the handlers import IPC, dialogs and notifications: no Electron in unit tests; ipcMain records the handlers
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<IpcReply>) => void ipc.handlers.set(channel, fn),
    removeHandler: (channel: string) => void ipc.handlers.delete(channel),
    on: vi.fn(),
    removeAllListeners: vi.fn()
  },
  Notification: { isSupported: () => false }
}))
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { Dispatcher, HookedCompanyStore, type DispatcherSessions } from '../company/dispatcher'
import { TASK_TOOLS, TaskTools, type TaskCaller, type TaskTool } from '../company/taskTools'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { AuthorDrafts } from '../author/drafts'
import { buildAuthorHandlers } from '../author/server/tools'
import { buildHandlers } from '../memory/server/build'
import { createLiveBridge } from '../live/bridge'
import { registerCompanyHandlers } from '../handlers/company'
import { registerBoardHandlers } from '../handlers/board'
import type { Hive } from '../hive'
import type { McpHandlers } from '../memory/server/jsonrpc'
import type { InvokeChannel, InvokeReq, InvokeRes } from '../../shared/ipc'
import type { LiveChannel, LiveOwner, StartRunOptions } from '../../shared/engine'
import { departmentsEnabled, type CompanyAgent, type CompanyTaskInput, type Department } from '../../shared/company'
import type { Run, RunTarget, Session } from '../../shared/types'

let nativeOk = true
try {
  openDatabase(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d_ = nativeOk && !process.versions.electron ? describe : describe.skip

const redact = (s: string) => s.replace(/sk-[a-z0-9]{8,}/gi, '••••')

interface Side {
  co: { id: string; name: string }
  support: Department
  only: Department
  seat: CompanyAgent
  other: CompanyAgent
}
interface World {
  dir: string
  db: DB
  store: Store
  c: HookedCompanyStore
  d: Dispatcher
  tools: TaskTools
  broker: AuthorBroker
  bridge: ReturnType<typeof createLiveBridge>
  channels: LiveChannel[]
  started: { target: RunTarget; opts: StartRunOptions; run: Run }[]
  A: Side
  B: Side
  profileId: string
}
let w: World
let seq = 0

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_iso${++seq}`
  w.db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), new Date().toISOString(), w.dir, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: w.dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
  w.started.push({ target, opts, run })
  return run
}
let sessionN = 0
const sessions: DispatcherSessions = {
  create: req => {
    const id = `session_iso${++sessionN}`
    w.db.prepare(`INSERT INTO sessions(id,title,profile_id,adapter,repo_id,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id) VALUES(?,?,?,?,?,?,'running',80,24,?,?,?,?)`).run(id, req.title, req.profileId, 'claude', null, w.dir, new Date().toISOString(), w.dir, w.dir, req.companyId)
    return { id } as Session
  },
  isLive: () => true,
  kill: async () => undefined
}

function side(c: HookedCompanyStore, name: string, onlyKey: string, profileId: string): Side {
  const co = c.create({ name })
  // both companies have a department keyed `support`: a key always resolves inside the caller's company
  const support = c.departments.save({ companyId: co.id, name: 'Support', key: 'support' })
  const only = c.departments.save({ companyId: co.id, name: `${name} only`, key: onlyKey })
  const seat = c.departments.saveAgent({ companyId: co.id, departmentId: support.id, kind: 'profile', refId: profileId, name: `${name} support agent`, data: { autonomy: 'auto' } })
  const other = c.departments.saveAgent({ companyId: co.id, departmentId: only.id, kind: 'profile', refId: profileId, name: `${name} specialist`, data: { autonomy: 'auto' } })
  return { co, support, only, seat, other }
}

beforeEach(() => {
  ipc.handlers.clear()
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'principia-dept-iso-')))
  const db = openDatabase(path.join(dir, 'test.db'))
  const store = new Store(db)
  store.updateSettings({ experimental: { companies: true, departments: true } })
  const c = new HookedCompanyStore(store, { companiesRoot: path.join(dir, 'companies') })
  const enabled = () => departmentsEnabled(store.getSettings().experimental)
  w = { dir, db, store, c, started: [], channels: [] } as unknown as World
  w.d = new Dispatcher({ company: c, startRun, cancelRun: async id => end(id, 'canceled'), enabled, sessions })
  c.hooks = w.d.hooks()
  w.tools = new TaskTools({ company: () => c, redact, enabled, pump: id => void w.d.pump(id) })
  // as wire.ts does: the pending handoff is applied right before every syncRun
  const sync = c.syncRun.bind(c)
  c.syncRun = run => { w.tools.beforeSyncRun(run); return sync(run) }
  const deps = { drafts: new AuthorDrafts(db), tasks: { resolve: (o: LiveOwner) => w.tools.resolveCaller(o), call: (caller: unknown, tool: TaskTool, args: Record<string, unknown>, hints: { companyId: string | null; taskId: string | null; callId: string | null }) => w.tools.call(caller as TaskCaller, tool, args, hints) } }
  w.broker = new AuthorBroker(deps as unknown as BrokerDeps)
  // main's side of the mailbox: the real LiveBridge hands every author_call line to the broker as the dir's owner
  w.bridge = createLiveBridge({ userData: dir, execPath: process.execPath, hookScript: path.join(dir, 'hook.js'), pollMs: 5, onAuthor: (owner, line, answer) => w.broker.handleCall(owner, line, answer) })
  w.profileId = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false }).id
  w.A = side(c, 'Acme', 'anvils', w.profileId)
  w.B = side(c, 'Beta', 'legal', w.profileId)
  // the IPC surface, as Hive registers it (handlers/index.ts): company + departments channels, then the board channels
  const host = {
    store, db, company: c, dispatcher: w.d, runHooks: [] as ((r: Run) => void)[],
    settings: () => store.getSettings(), vault: { redact }, statusChanged: () => undefined,
    engine: { runs: { start: (t: RunTarget, o: StartRunOptions) => startRun(t, o), cancel: async (id: string) => end(id, 'canceled') } }
  }
  registerCompanyHandlers(host as unknown as Hive)
  registerBoardHandlers(host as unknown as Hive)
})
afterEach(() => {
  for (const ch of w.channels) ch.close()
  w.d.dispose()
  w.db.close()
  fs.rmSync(w.dir, { recursive: true, force: true })
})

function end(runId: string, status: Run['status']) {
  w.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, runId)
  const run = w.started.find(s => s.run.id === runId)!.run
  w.d.onRunUpdated({ ...run, status })
}
const flush = () => new Promise(r => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 5; i++) await flush() }

const task = (s: Side, over: Partial<CompanyTaskInput> = {}) => w.c.createTask({ title: `${s.co.name} task`, description: `${s.co.name} confidential brief`, companyId: s.co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: s.support.id, agentId: s.seat.id, ...over })

/** Everything company B owns on the board, for "A's attempt changed nothing of B". */
const betaState = () => JSON.stringify({
  settings: w.c.boardSettings(w.B.co.id),
  departments: w.c.departments.list(w.B.co.id, { includeArchived: true }),
  agents: w.c.departments.listAgents({ companyId: w.B.co.id, includeArchived: true }),
  tasks: w.c.listTasks(w.B.co.id).map(t => [t, w.c.detail(t.id).activity.map(a => [a.kind, a.by, a.message])]),
  runs: w.db.prepare('SELECT id, status FROM runs WHERE company_id=? ORDER BY id').all(w.B.co.id)
})

/** A renderer call through ipc.ts's registered handler (zod validation, HiveError → {ok:false}). Throws the error. */
async function invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
  const fn = ipc.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  const r = await fn({ sender: {} }, req)
  if (!r.ok) throw Object.assign(new Error(r.error!.message), { code: r.error!.code })
  return r.data as InvokeRes<C>
}

/** A server's live dir, owned like the engine (step) or SessionLive (session) opens it. */
function channel(owner: LiveOwner): LiveChannel {
  const ch = w.bridge.open(owner)
  w.channels.push(ch)
  return ch
}
type ToolOut = { isError: boolean; text: string; json: Record<string, unknown> | null }
/** One MCP tools/call through the server's handler: events.jsonl, the bridge, the broker, the answer file. */
async function mcp(server: McpHandlers, tool: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  const r = await server.callTool(tool, args, { requestId: 1, meta: null, signal: new AbortController().signal })
  const text = (r.content[0] as { text: string }).text
  let json: Record<string, unknown> | null = null
  try { json = JSON.parse(text) } catch { /* an error line */ }
  return { isError: !!r.isError, text, json }
}

/**
 * Company A's two kinds of caller: a headless step of a task run (hivemem, HIVE_TASK_ID + HIVE_TASK_COMPANY_ID) and a
 * board session holding a task (hive, HIVE_TOOLSETS task + HIVE_COMPANY_ID + HIVE_TASK_ID), as executor.ts and
 * author/wire.ts spawn them.
 */
function acmeServers() {
  const mine = task(w.A, { title: 'Acme refund policy' })
  w.d.runNow(mine.id)
  const run = w.started.at(-1)!.run
  const stepOwner: LiveOwner = { runId: run.id, stepId: `st_${run.id.replace(/_/g, '')}` }
  const step = channel(stepOwner)
  const hivemem = buildHandlers({ ...step.mcpEnv, HIVE_TASK_ID: mine.id, HIVE_TASK_COMPANY_ID: w.A.co.id }).handlers
  const held = task(w.A, { title: 'Acme newsletter', departmentId: w.A.only.id, agentId: w.A.other.id })
  const { session } = w.d.openSession(held.id, { cols: 80, rows: 24 })
  const sess = channel({ sessionId: session.id })
  const hive = buildAuthorHandlers({ ...sess.mcpEnv, HIVE_TOOLSETS: 'author,task', HIVE_COMPANY_ID: w.A.co.id, HIVE_TASK_ID: held.id })
  return { mine, held, run, hivemem, hive, servers: [['hivemem (step)', hivemem, mine], ['hive (session)', hive, held]] as const }
}

d_('DEPARTMENTS.md §6 isolation: the hivetask tools (both MCP servers)', () => {
  it('both servers list the task tools; reads see only company A (list, get by id and by identifier)', async () => {
    const bTodo = task(w.B, { title: 'Beta merger plan' })
    const bWorking = task(w.B, { title: 'Beta layoffs memo', departmentId: w.B.only.id, agentId: w.B.other.id })
    w.d.runNow(bWorking.id)
    const a = acmeServers()
    const before = betaState()
    for (const [label, server, own] of a.servers) {
      expect(server.listTools().map(t => t.name), label).toEqual(expect.arrayContaining([...TASK_TOOLS]))
      const got = await mcp(server, 'task_get')
      expect(got.isError, `${label}: ${got.text}`).toBe(false)
      expect(got.json).toMatchObject({ task: { id: own.id } })
      for (const scope of ['mine', 'department', 'open'] as const) {
        const list = await mcp(server, 'task_list', { scope, limit: 50 })
        expect(list.isError, `${label} ${scope}: ${list.text}`).toBe(false)
        const ids = (list.json!.tasks as { id: string }[]).map(t => t.id)
        expect(ids.every(id => w.c.task(id).companyId === w.A.co.id), `${label} ${scope}`).toBe(true)
        expect(list.text).not.toMatch(/Beta|merger|layoffs/)
      }
      for (const t of [bTodo, bWorking]) {
        for (const id of [t.id, t.identifier]) {
          const r = await mcp(server, 'task_get', { id })
          expect(r, `${label} ${id}`).toMatchObject({ isError: true, text: 'Task not found in this company' })
        }
      }
    }
    expect(betaState()).toBe(before)
  })

  it('A can neither comment on, report on, ask on nor claim B\'s tasks; a server forged for B in A\'s dir is refused', async () => {
    const bTask = task(w.B, { title: 'Beta merger plan' })
    w.d.runNow(bTask.id)
    const a = acmeServers()
    const before = betaState()
    // the comment tools take no task id: they write the caller's own task only
    for (const [label, server, own] of a.servers) {
      const r = await mcp(server, 'task_comment', { text: `note from ${label}` })
      expect(r.isError, `${label}: ${r.text}`).toBe(false)
      expect(w.c.detail(own.id).activity.at(-1)).toMatchObject({ kind: 'comment', by: 'agent', message: `note from ${label}` })
    }
    // a server whose env names B's company or B's task, sitting in an A owner's live dir: every line is refused
    const forgedStep = buildHandlers({ HIVE_LIVE_DIR: w.channels[0].dir, HIVE_TASK_ID: bTask.id, HIVE_TASK_COMPANY_ID: w.B.co.id }).handlers
    const forgedSession = buildAuthorHandlers({ HIVE_LIVE_DIR: w.channels[1].dir, HIVE_TOOLSETS: 'task', HIVE_COMPANY_ID: w.B.co.id, HIVE_TASK_ID: bTask.id })
    const forgedTaskOnly = buildHandlers({ HIVE_LIVE_DIR: w.channels[0].dir, HIVE_TASK_ID: bTask.id, HIVE_TASK_COMPANY_ID: w.A.co.id }).handlers
    const writes: [TaskTool, Record<string, unknown>][] = [
      ['task_comment', { text: 'hijack' }],
      ['task_report', { outcome: 'review', summary: 'hijack', evidence: [] }],
      ['task_ask', { kind: 'question', prompt: 'hijack?' }],
      ['task_handoff', { departmentKey: 'support', reason: 'hijack' }],
      ['task_create', { title: 'hijack' }]
    ]
    for (const server of [forgedStep, forgedSession, forgedTaskOnly]) {
      for (const [tool, args] of [['task_get', {}] as [TaskTool, Record<string, unknown>], ['task_list', { scope: 'open' }] as [TaskTool, Record<string, unknown>], ...writes]) {
        const r = await mcp(server, tool, args)
        expect(r.isError, `${tool}: ${r.text}`).toBe(true)
        expect(r.text).toMatch(/another company|another task/)
      }
    }
    expect(betaState()).toBe(before)
    // B's task is still B's run's: A got no write access to it at any point
    expect(w.c.task(bTask.id)).toMatchObject({ status: 'in_progress', runId: w.started.find(s => s.opts.taskId === bTask.id)!.run.id, agentId: w.B.seat.id })
  })

  it('A cannot hand off to B: not to B\'s agent, not to a department key only B has, and a shared key stays in A', async () => {
    const a = acmeServers()
    const before = betaState()
    for (const [label, server] of a.servers) {
      const toAgent = await mcp(server, 'task_handoff', { agentId: w.B.seat.id, reason: 'escalate' })
      expect(toAgent, label).toMatchObject({ isError: true, text: 'No such agent in this company' })
      const toKey = await mcp(server, 'task_handoff', { departmentKey: 'legal', reason: 'escalate' })
      expect(toKey.isError, label).toBe(true)
      expect(toKey.text).toContain('No department "legal"')
      const create = await mcp(server, 'task_create', { title: 'Ask legal', departmentKey: 'legal' })
      expect(create.isError, label).toBe(true)
      expect(create.text).toContain('No department "legal"')
    }
    // the step hands off to `support`: A's Support (its own seat already), never B's department with the same key
    const toSelf = await mcp(a.hivemem, 'task_handoff', { departmentKey: 'support', reason: 'x' })
    expect(toSelf).toMatchObject({ isError: true })
    expect(toSelf.text).toContain('already yours')
    // the session hands off to `support`: lands on A's support agent
    const viaSession = await mcp(a.hive, 'task_handoff', { departmentKey: 'support', reason: 'Needs support' })
    expect(viaSession.isError, viaSession.text).toBe(false)
    expect(viaSession.json).toMatchObject({ target: { department: 'support', agent: { id: w.A.seat.id } } })
    // a task filed through the tools with a shared key is A's
    const filed = await mcp(a.hivemem, 'task_create', { title: 'Follow up the refund', departmentKey: 'support' })
    expect(filed.isError, filed.text).toBe(false)
    const child = w.c.task((filed.json!.task as { id: string }).id)
    expect(child).toMatchObject({ companyId: w.A.co.id, departmentId: w.A.support.id, parentId: a.mine.id })
    // the session's lease ends: its handoff applies in A only
    w.d.submitSession(a.held.id)
    await settle()
    expect(betaState()).toBe(before)
    expect(w.c.listTasks(w.B.co.id)).toHaveLength(0)
  })

  it('B\'s own step reads only B: the boundary holds in both directions', async () => {
    const mineA = task(w.A, { title: 'Acme pricing secret' })
    const bTask = task(w.B, { title: 'Beta onboarding' })
    w.d.runNow(bTask.id)
    const run = w.started.at(-1)!.run
    const ch = channel({ runId: run.id, stepId: `st_${run.id.replace(/_/g, '')}` })
    const hivemem = buildHandlers({ ...ch.mcpEnv, HIVE_TASK_ID: bTask.id, HIVE_TASK_COMPANY_ID: w.B.co.id }).handlers
    expect(await mcp(hivemem, 'task_get', { id: mineA.identifier })).toMatchObject({ isError: true, text: 'Task not found in this company' })
    const list = await mcp(hivemem, 'task_list', { scope: 'open', limit: 50 })
    expect((list.json!.tasks as { id: string }[]).map(t => t.id)).toEqual([bTask.id])
    expect(list.text).not.toContain('Acme')
  })
})

d_('DEPARTMENTS.md §10 isolation: IPC (departments:*, companyAgents:*, tasks:*, board:autopilot)', () => {
  it('lists are per company: departments, agents and tasks of A never include B', async () => {
    const tB = task(w.B)
    const tA = task(w.A)
    const deps = await invoke('departments:list', { companyId: w.A.co.id })
    expect(deps.map(x => x.id).sort()).toEqual([w.A.support.id, w.A.only.id].sort())
    const agents = await invoke('companyAgents:list', { companyId: w.A.co.id })
    expect(agents.map(x => x.id).sort()).toEqual([w.A.seat.id, w.A.other.id].sort())
    // A's company filter with B's department finds nothing
    expect(await invoke('companyAgents:list', { companyId: w.A.co.id, departmentId: w.B.support.id })).toEqual([])
    expect((await invoke('tasks:list', { companyId: w.A.co.id })).map(t => t.id)).toEqual([tA.id])
    expect((await invoke('tasks:list', { companyId: w.B.co.id })).map(t => t.id)).toEqual([tB.id])
  })

  it('departments and agents never cross: no move, no reorder with B\'s ids, no seat in B\'s department or on B\'s workflow', async () => {
    const before = betaState()
    const refused: [string, () => Promise<unknown>, RegExp][] = [
      ['departments:save moves B\'s department into A', () => invoke('departments:save', { id: w.B.support.id, companyId: w.A.co.id, name: 'Hijacked' }), /cannot move to another company/],
      ['departments:reorder A with B\'s ids', () => invoke('departments:reorder', { companyId: w.A.co.id, ids: [w.B.only.id, w.A.support.id] }), /not found in this company/],
      ['companyAgents:save an A seat in B\'s department', () => invoke('companyAgents:save', { companyId: w.A.co.id, departmentId: w.B.support.id, kind: 'profile', refId: w.profileId, name: 'Mole' }), /same company as its department/],
      ['companyAgents:save moves B\'s seat into A', () => invoke('companyAgents:save', { id: w.B.seat.id, companyId: w.A.co.id, departmentId: w.A.support.id, kind: 'profile', refId: w.profileId, name: 'Turncoat' }), /cannot move to another company/],
      ['companyAgents:save an A seat backed by B\'s workflow', () => {
        const wf = w.store.createWorkflow({ name: 'Beta weekly', description: '', inputs: [], nodes: [] } as never, null, null, w.B.co.id)
        return invoke('companyAgents:save', { companyId: w.A.co.id, departmentId: null, kind: 'workflow', refId: wf.id, name: 'Reporter' })
      }, /belongs to Beta/]
    ]
    for (const [label, call, msg] of refused) {
      await expect(call(), label).rejects.toThrow(msg)
    }
    // the workflow row itself is B's data, not board state: compare the board only
    expect(betaState()).toBe(before)
    // A's own changes leave B alone
    await invoke('departments:createPresets', { companyId: w.A.co.id })
    await invoke('departments:reorder', { companyId: w.A.co.id, ids: [w.A.only.id] })
    await invoke('companyAgents:pause', { id: w.A.seat.id })
    await invoke('companyAgents:archive', { id: w.A.other.id })
    await invoke('departments:save', { id: w.A.support.id, companyId: w.A.co.id, name: 'Customer care', data: { slackChannels: ['C1'] } })
    // the same Slack channel may route to a department in B: the uniqueness rule is per company
    await invoke('departments:save', { id: w.B.support.id, companyId: w.B.co.id, name: 'Support', data: { slackChannels: ['C1'] } })
    const after = JSON.parse(betaState())
    expect(after.agents).toEqual(JSON.parse(before).agents)
    expect(after.departments.map((x: Department) => [x.id, x.sortOrder, x.archivedAt])).toEqual(JSON.parse(before).departments.map((x: Department) => [x.id, x.sortOrder, x.archivedAt]))
  })

  it('tasks never cross: no create, edit, assign or claim with the other company\'s department or agent', async () => {
    const tA = task(w.A, { status: 'backlog' })
    const tB = task(w.B, { status: 'backlog' })
    const before = betaState()
    const base = { title: 'x', description: '', repoId: null, status: 'todo' as const, priority: 3 as const, source: 'manual' as const, sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [] }
    const refused: [string, () => Promise<unknown>, RegExp][] = [
      ['tasks:create in A with B\'s department', () => invoke('tasks:create', { task: { ...base, companyId: w.A.co.id, departmentId: w.B.support.id, agentId: null } }), /belongs to another company/],
      ['tasks:create in A with B\'s agent', () => invoke('tasks:create', { task: { ...base, companyId: w.A.co.id, departmentId: null, agentId: w.B.seat.id } }), /belongs to another company/],
      ['tasks:update A\'s task onto B\'s agent', () => invoke('tasks:update', { id: tA.id, patch: { agentId: w.B.seat.id, departmentId: null } }), /belongs to another company/],
      ['tasks:update moves A\'s task into B', () => invoke('tasks:update', { id: tA.id, patch: { companyId: w.B.co.id } }), /Company cannot change/],
      ['tasks:assign hands A\'s task to B\'s agent', () => invoke('tasks:assign', { id: tA.id, agentId: w.B.seat.id }), /belongs to another company/],
      ['tasks:assign hands A\'s task to B\'s department', () => invoke('tasks:assign', { id: tA.id, departmentId: w.B.support.id, agentId: null }), /belongs to another company/],
      ['tasks:assign claims B\'s task for A\'s agent', () => invoke('tasks:assign', { id: tB.id, agentId: w.A.seat.id }), /belongs to another company/],
      ['tasks:assign claims B\'s task for A\'s department', () => invoke('tasks:assign', { id: tB.id, departmentId: w.A.only.id, agentId: null }), /belongs to another company/]
    ]
    for (const [label, call, msg] of refused) {
      await expect(call(), label).rejects.toThrow(msg)
    }
    expect(betaState()).toBe(before)
    expect(w.c.task(tA.id)).toMatchObject({ companyId: w.A.co.id, departmentId: w.A.support.id, agentId: w.A.seat.id })
    expect(w.started).toHaveLength(0)
  })

  it('board:autopilot is one company\'s switch: A on starts only A\'s work; B\'s auto seat and todo stay idle', async () => {
    const tA = task(w.A)
    const tB = task(w.B)
    expect(w.c.boardSettings(w.B.co.id).autopilot).toBe(false)
    const before = betaState()
    const out = await invoke('board:autopilot', { companyId: w.A.co.id, on: true, maxInFlight: 1 })
    expect(out).toEqual({ companyId: w.A.co.id, autopilot: true, maxInFlight: 1 })
    await settle()
    for (let i = 0; i < 3; i++) await w.d.tick()
    expect(w.started.map(s => s.opts.taskId)).toEqual([tA.id])
    expect(w.started[0].opts.companyId).toBe(w.A.co.id)
    expect(w.c.task(tB.id).status).toBe('todo')
    expect(betaState()).toBe(before)
    // A's in-flight cap never limits B, and B's switch never starts A's queue
    const tA2 = task(w.A, { title: 'Second', departmentId: w.A.only.id, agentId: w.A.other.id })
    await invoke('board:autopilot', { companyId: w.B.co.id, on: true })
    await settle()
    expect(w.c.task(tB.id).status).toBe('in_progress')
    expect(w.c.task(tA2.id).status).toBe('todo')
    expect(w.started.map(s => s.opts.companyId)).toEqual([w.A.co.id, w.B.co.id])
  })

  it('human board actions on B\'s task never reach A: a comment wakes only B\'s seat, answer/approve/unpark stay in B', async () => {
    const tA = task(w.A, { title: 'Acme report' })
    w.d.runNow(tA.id)
    const tB = task(w.B, { title: 'Beta report' })
    w.d.runNow(tB.id)
    const runA = w.started[0].run, runB = w.started[1].run
    const acme = () => JSON.stringify([w.c.task(tA.id), w.c.detail(tA.id).activity.map(a => a.kind)])
    const before = acme()
    await invoke('tasks:comment', { id: tB.id, message: 'Beta: use the new logo' })
    expect(w.c.task(tB.id).pendingWake?.count).toBe(1)
    expect(acme()).toBe(before)
    // B's run asks, the human answers, approves: A's in-flight task is untouched throughout
    w.c.patchInFlight(tB.id, { ask: { kind: 'question', prompt: 'Which logo?' } })
    end(runB.id, 'passed')
    await settle()
    await invoke('tasks:answer', { id: tB.id, answer: 'The blue one' })
    await settle()
    expect(acme()).toBe(before)
    expect(w.c.task(tA.id)).toMatchObject({ status: 'in_progress', runId: runA.id })
    // B's Autopilot is off, but the answer is the human's go-ahead: B's agent resumes (and nothing of A starts)
    expect(w.c.task(tB.id)).toMatchObject({ status: 'in_progress' })
    expect(w.started).toHaveLength(3)
    expect(w.started[2].opts.taskId).toBe(tB.id)
    // stopping B's task cancels B's run only
    const runB2 = w.started.at(-1)!.run
    expect(w.c.task(tB.id).runId).toBe(runB2.id)
    await invoke('tasks:stop', { id: tB.id })
    expect(w.store.getRun(runA.id)?.status).toBe('running')
    expect(w.c.task(tB.id)).toMatchObject({ status: 'blocked', blockReason: 'no_report' })
    await invoke('tasks:unpark', { id: tB.id })
    expect(acme()).toBe(before)
  })

  it('every §10 channel refuses with departments off, both MCP servers refuse the task tools, and nothing changes', async () => {
    const a = acmeServers()
    const tA = task(w.A, { status: 'backlog' })
    const tB = task(w.B, { status: 'backlog' })
    w.store.updateSettings({ experimental: { companies: true, departments: false } })
    const snapshot = () => JSON.stringify([betaState(), w.c.listTasks(w.A.co.id).map(t => [t, w.c.detail(t.id).activity.length]), w.c.boardSettings(w.A.co.id), w.c.departments.list(w.A.co.id, { includeArchived: true }), w.c.departments.listAgents({ companyId: w.A.co.id, includeArchived: true })])
    const before = snapshot()
    const startedBefore = w.started.length
    const pty = { cols: 80, rows: 24 }
    // all 20 channels of §10 (departments:*, companyAgents:*, the new tasks:*, board:autopilot), on A's and B's ids
    const calls: [string, () => Promise<unknown>][] = [
      ['departments:list', () => invoke('departments:list', { companyId: w.A.co.id })],
      ['departments:save', () => invoke('departments:save', { companyId: w.A.co.id, name: 'New' })],
      ['departments:archive', () => invoke('departments:archive', { id: w.A.only.id })],
      ['departments:reorder', () => invoke('departments:reorder', { companyId: w.A.co.id, ids: [w.A.only.id, w.A.support.id] })],
      ['departments:createPresets', () => invoke('departments:createPresets', { companyId: w.A.co.id })],
      ['companyAgents:list', () => invoke('companyAgents:list', { companyId: w.A.co.id })],
      ['companyAgents:save', () => invoke('companyAgents:save', { companyId: w.A.co.id, departmentId: w.A.support.id, kind: 'profile', refId: w.profileId, name: 'New seat' })],
      ['companyAgents:archive', () => invoke('companyAgents:archive', { id: w.A.other.id })],
      ['companyAgents:pause', () => invoke('companyAgents:pause', { id: w.A.seat.id })],
      ['companyAgents:resume', () => invoke('companyAgents:resume', { id: w.A.seat.id })],
      ['tasks:assign', () => invoke('tasks:assign', { id: tA.id, agentId: w.A.other.id })],
      ['tasks:acceptRoute', () => invoke('tasks:acceptRoute', { id: tA.id })],
      ['tasks:answer', () => invoke('tasks:answer', { id: tB.id, answer: 'x' })],
      ['tasks:approve', () => invoke('tasks:approve', { id: a.mine.id, doneNote: 'x' })],
      ['tasks:sendBack', () => invoke('tasks:sendBack', { id: a.mine.id, note: 'x' })],
      ['tasks:unpark', () => invoke('tasks:unpark', { id: tA.id })],
      ['tasks:openSession', () => invoke('tasks:openSession', { id: tA.id, ...pty })],
      ['tasks:takeover', () => invoke('tasks:takeover', { id: a.mine.id, ...pty })],
      ['tasks:stop', () => invoke('tasks:stop', { id: a.mine.id })],
      ['board:autopilot', () => invoke('board:autopilot', { companyId: w.A.co.id, on: true })],
      // the existing tasks:* channels keep working, but refuse board fields
      ['tasks:create with a department', () => invoke('tasks:create', { task: { title: 'x', description: '', companyId: w.A.co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: w.A.support.id, agentId: null } })],
      ['tasks:update onto an agent', () => invoke('tasks:update', { id: tA.id, patch: { agentId: w.A.other.id } })]
    ]
    for (const [label, call] of calls) await expect(call(), label).rejects.toMatchObject({ code: 'forbidden' })
    // MCP: the step and the session that held tasks a moment ago get nothing from any task tool
    for (const [label, server] of a.servers) {
      for (const tool of TASK_TOOLS) {
        const r = await mcp(server, tool, tool === 'task_comment' ? { text: 'x' } : tool === 'task_create' ? { title: 'x' } : {})
        expect(r.isError, `${label} ${tool}: ${r.text}`).toBe(true)
        expect(r.text, `${label} ${tool}`).toMatch(/board is off/)
      }
    }
    for (let i = 0; i < 3; i++) await w.d.tick()
    await settle()
    expect(snapshot()).toBe(before)
    expect(w.started).toHaveLength(startedBefore)
  })
})
