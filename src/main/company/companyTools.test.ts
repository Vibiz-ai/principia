/**
 * DEPARTMENTS.md §9: the company tools of a chat (company_departments, company_file_task) through TaskTools and the
 * broker, the `hive` server listing them for chats only, and §2 step 4 wired: a new triage task gets a model
 * suggestion in the background (Dispatcher.suggest), stored without applying it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { AuthorBroker, type BrokerDeps } from '../author/broker'
import { AuthorDrafts } from '../author/drafts'
import { buildAuthorHandlers } from '../author/server/tools'
import { Dispatcher, HookedCompanyStore } from './dispatcher'
import { COMPANY_TOOLS, type BoardTool } from './taskToolDefs'
import { TaskTools, type TaskCaller } from './taskTools'
import type { ModelCall } from './router'
import type { LiveOwner } from '../../shared/engine'
import type { CompanyTaskInput } from '../../shared/company'

let db: DB
let store: Store
let c: HookedCompanyStore
let dir: string
let d: Dispatcher
let tools: TaskTools
let model: ModelCall | null = null
const redact = (s: string) => s.replace(/sk-[a-z0-9]{8,}/gi, '••••')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-cotools-'))
  db = openDatabase(path.join(dir, 'test.db'))
  store = new Store(db)
  c = new HookedCompanyStore(store)
  model = null
  d = new Dispatcher({ company: c, startRun: () => { throw new Error('no runs here') }, cancelRun: async () => undefined, enabled: () => true, modelCall: () => model, redact })
  c.hooks = d.hooks()
  tools = new TaskTools({ company: () => c, redact, enabled: () => true })
})
afterEach(() => {
  d.dispose()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function board() {
  const co = c.create({ name: 'Acme' })
  const marketing = c.departments.save({ companyId: co.id, name: 'Marketing', data: { charter: { does: 'Launch posts, campaigns and the website copy', doesNot: 'Code' } } })
  const dev = c.departments.save({ companyId: co.id, name: 'Development', key: 'development' })
  const profile = store.createProfile({ name: 'Agent', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const writer = c.departments.saveAgent({ companyId: co.id, departmentId: marketing.id, kind: 'profile', refId: profile.id, name: 'Copywriter', data: { autonomy: 'manual' } })
  const designer = c.departments.saveAgent({ companyId: co.id, departmentId: marketing.id, kind: 'profile', refId: profile.id, name: 'Designer', data: { autonomy: 'manual' } })
  const fixer = c.departments.saveAgent({ companyId: co.id, departmentId: dev.id, kind: 'profile', refId: profile.id, name: 'Bug fixer', data: { autonomy: 'manual' } })
  /** A chat session row of the company (no task). */
  const chat = (id = 'session_chat') => {
    db.prepare(`INSERT INTO sessions(id,title,profile_id,adapter,repo_id,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id) VALUES(?,?,?,?,?,?,'running',80,24,?,?,?,?)`).run(id, 'Chat · Claude', profile.id, 'claude', null, dir, new Date().toISOString(), dir, dir, co.id)
    return { sessionId: id } as LiveOwner
  }
  const task = (over: Partial<CompanyTaskInput> = {}) =>
    c.createTask({ title: 'Launch post', description: 'Write it', companyId: co.id, repoId: null, status: 'triage', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: null, agentId: null, ...over })
  return { co, marketing, dev, writer, designer, fixer, chat, task }
}
const call = (owner: LiveOwner, tool: BoardTool, args: Record<string, unknown> = {}, callId: string | null = null) => tools.call(tools.resolveCaller(owner), tool, args, { callId })

describe('company_departments', () => {
  it("lists the company's departments with their charter, agents and open work", () => {
    const b = board()
    b.task({ title: 'Unfiled thing' })
    const r = call(b.chat(), 'company_departments') as { departments: { key: string; does: string; agents: { name: string; role: string }[]; openTasks: number }[]; unfiled: number }
    expect(r.departments.map((x) => x.key)).toEqual(['marketing', 'development'])
    expect(r.departments[0]).toMatchObject({ does: 'Launch posts, campaigns and the website copy', openTasks: 0 })
    // the persona's name, and the role label beside it
    expect(r.departments[0]!.agents.map((a) => a.role).sort()).toEqual(['Copywriter', 'Designer'])
    expect(r.departments[0]!.agents.every((a) => !!a.name)).toBe(true)
    expect(r.unfiled).toBe(1)
  })
})

describe('company_create_department', () => {
  it('adds a department from a chat, returns an existing one as is, and refuses an archived one', () => {
    const b = board()
    const owner = b.chat()
    const r = call(owner, 'company_create_department', { name: 'Support', does: 'Answers customers sk-abcdef123456', reason: 'The user asked for a support team' }) as { ok: boolean; department: { key: string; name: string }; detail: string }
    expect(r).toMatchObject({ ok: true, department: { key: 'support', name: 'Support' } })
    expect(r.detail).toMatch(/no agents yet/)
    const dep = c.departments.list(b.co.id).find((d) => d.key === 'support')!
    expect(dep.data.charter.does).not.toContain('sk-abcdef123456')
    expect(call(owner, 'company_create_department', { name: 'support', does: 'x', reason: 'again' })).toMatchObject({ existed: true, department: { id: dep.id } })
    expect(call(owner, 'company_departments')).toMatchObject({ departments: expect.arrayContaining([expect.objectContaining({ key: 'support' })]) })
    c.departments.archive(dep.id, true)
    expect(() => call(owner, 'company_create_department', { name: 'Support', does: 'x', reason: 'r' })).toThrow(/archived/)
    expect(() => call(owner, 'company_create_department', { name: 'Ops', key: 'Bad Key!', does: 'x', reason: 'r' })).toThrow(/Invalid arguments: key/)
  })
})

describe('company_file_task', () => {
  it('files a top-level task into the department, routed by the rules, stamped by:model with the reason', () => {
    const b = board()
    const r = call(b.chat(), 'company_file_task', { title: 'Fix the login crash', description: 'Users on Safari see a crash. sk-abcdef123456', departmentKey: 'development', reason: 'A bug in the app: Development fixes code' }) as { ok: boolean; task: { identifier: string; department: string; agent: { name: string } | null } }
    expect(r.ok).toBe(true)
    expect(r.task.department).toBe('development')
    // the department's only active agent, as the board's rule 2 picks it
    expect(r.task.agent?.name).toBe('Bug fixer')
    const t = c.listTasks(b.co.id).find((x) => x.identifier === r.task.identifier)!
    expect(t).toMatchObject({ status: 'todo', departmentId: b.dev.id, agentId: b.fixer.id, source: 'agent', parentId: null })
    expect(t.routing).toMatchObject({ by: 'model', departmentId: b.dev.id, agentId: b.fixer.id })
    expect(t.routing!.reason).toContain('Filed from chat: A bug in the app')
    expect(t.description).not.toContain('sk-abcdef123456')
    expect(c.detail(t.id).activity.some((a) => a.kind === 'routed' && a.message.startsWith('Filed from a chat into Development'))).toBe(true)
  })

  it('start:true (the user asked for it now) gives the go-ahead at once and says what holds it; without it the task waits', () => {
    const b = board()
    const went: string[] = []
    tools = new TaskTools({ company: () => c, redact, enabled: () => true, goAhead: (id, why) => (went.push(`${c.task(id).identifier}: ${why}`), { state: 'queued', line: 'Bug fixer is running 3 tasks; it starts when one finishes.' }) })
    const now = call(b.chat(), 'company_file_task', { title: 'Fix the login crash', departmentKey: 'development', reason: 'A bug', start: true }) as { task: { identifier: string }; started: boolean; detail: string }
    expect(went).toEqual([`${now.task.identifier}: you asked for it in the chat`])
    expect(now.started).toBe(false)
    expect(now.detail).toContain('It has not started: Bug fixer is running 3 tasks')
    const later = call(b.chat('session_chat2'), 'company_file_task', { title: 'Fix the signup crash', departmentKey: 'development', reason: 'Another bug' }) as { detail: string; started?: boolean }
    expect(went).toHaveLength(1)
    expect(later.started).toBeUndefined()
  })

  it('takes a named agent of that department, leaves several manual agents to the human, and replays a repeated call', () => {
    const b = board()
    const owner = b.chat()
    const named = call(owner, 'company_file_task', { title: 'Hero image', departmentKey: 'marketing', agent: 'designer', reason: 'Design work' }) as { task: { agent: { name: string } | null } }
    expect(named.task.agent?.name).toBe('Designer')
    const open = call(owner, 'company_file_task', { title: 'Launch post', departmentKey: 'marketing', reason: 'Copy' }, 'toolu_1') as { task: { identifier: string; agent: unknown } }
    expect(open.task.agent).toBeNull()
    const again = call(owner, 'company_file_task', { title: 'Launch post', departmentKey: 'marketing', reason: 'Copy' }, 'toolu_1') as { task: { identifier: string }; replayed: boolean }
    expect(again).toMatchObject({ replayed: true, task: { identifier: open.task.identifier } })
  })

  it('refuses an unknown department or agent, a run caller and a chat holding a task', () => {
    const b = board()
    const owner = b.chat()
    expect(() => call(owner, 'company_file_task', { title: 'X', departmentKey: 'legal', reason: 'r' })).toThrow(/No department "legal".*Known: marketing, development/)
    expect(() => call(owner, 'company_file_task', { title: 'X', departmentKey: 'marketing', agent: 'Bug fixer', reason: 'r' })).toThrow(/No agent "Bug fixer" in Marketing/)
    expect(() => call(owner, 'company_file_task', { title: 'X', reason: 'r' })).toThrow(/departmentKey/)
    const runCaller: TaskCaller = { kind: 'run', holderId: 'r_1', companyId: b.co.id, taskId: 'task_x', agentId: null, holdsTask: true }
    expect(() => tools.call(runCaller, 'company_departments', {})).toThrow(/Unknown tool/)
    const sessionOnTask: TaskCaller = { kind: 'session', holderId: 'session_chat', companyId: b.co.id, taskId: 'task_x', agentId: null, holdsTask: true }
    expect(() => tools.call(sessionOnTask, 'company_file_task', { title: 'X', departmentKey: 'marketing', reason: 'r' })).toThrow(/task_create or task_handoff/)
  })

  it('is served by the broker for a chat session, and unknown to a headless step', async () => {
    const b = board()
    const deps = { drafts: new AuthorDrafts(db), tasks: { resolve: (o: LiveOwner) => tools.resolveCaller(o), call: (caller: unknown, tool: BoardTool, args: Record<string, unknown>, hints: { companyId: string | null; taskId: string | null; callId: string | null }) => tools.call(caller as TaskCaller, tool, args, hints) } }
    const broker = new AuthorBroker(deps as unknown as BrokerDeps)
    const answers: Record<string, unknown>[] = []
    const write = (_id: string, a: unknown) => void answers.push(a as Record<string, unknown>)
    broker.handleCall(b.chat(), { hive: 'author_call', call_id: 'hac_0000000001', tool: 'company_departments', args: {}, company_id: b.co.id }, write)
    broker.handleCall({ runId: 'r_1', stepId: 'st_1' } as LiveOwner, { hive: 'author_call', call_id: 'hac_0000000002', tool: 'company_departments', args: {} }, write)
    await new Promise((r) => setTimeout(r, 0))
    expect(answers[0]).toMatchObject({ ok: true })
    expect(answers[1]).toMatchObject({ ok: false })
  })
})

describe('the hive server lists the company tools for chats only', () => {
  it('HIVE_TOOLSETS company', () => {
    fs.mkdirSync(path.join(dir, 'live'))
    const names = (sets: string) => (buildAuthorHandlers({ HIVE_LIVE_DIR: path.join(dir, 'live'), HIVE_TOOLSETS: sets }).listTools() as { name: string }[]).map((t) => t.name)
    expect(names('author,task,company')).toEqual(expect.arrayContaining([...COMPANY_TOOLS]))
    expect(names('author,task')).not.toContain('company_file_task')
    // PROACTIVE.md §2: filing is the chat's own initiative by default; HIVE_PROACTIVE=0 keeps the passive wording
    const text = (env: Record<string, string>) => { const h = buildAuthorHandlers({ HIVE_LIVE_DIR: path.join(dir, 'live'), HIVE_TOOLSETS: 'author,company', ...env }); return typeof h.instructions === 'function' ? h.instructions() : h.instructions }
    expect(text({})).toContain('File on your own, without asking first')
    expect(text({})).toContain('never file the same thing twice')
    expect(text({ HIVE_PROACTIVE: '0' })).toContain('only after the user agrees')
    // a chat lists task_update; a task session (HIVE_TASK_ID) does not
    expect(names('author,task')).toContain('task_update')
    expect((buildAuthorHandlers({ HIVE_LIVE_DIR: path.join(dir, 'live'), HIVE_TOOLSETS: 'author,task', HIVE_TASK_ID: 'task_x' }).listTools() as { name: string }[]).map((t) => t.name)).not.toContain('task_update')
  })
})

describe('§2 step 4: a new triage task gets a model suggestion', () => {
  const answer = (o: unknown): ModelCall => async () => JSON.stringify(o)
  it('stores a by:model suggestion without applying it, with a routed activity', async () => {
    const b = board()
    model = answer({ departmentKey: 'marketing', agentId: b.writer.id, confidence: 0.8, reason: 'launch copy' })
    const t = b.task({ title: 'Write the launch announcement' })
    await d.suggest(t.id)
    const after = c.task(t.id)
    expect(after).toMatchObject({ status: 'triage', departmentId: null, agentId: null })
    expect(after.routing).toMatchObject({ by: 'model', departmentId: b.marketing.id, agentId: b.writer.id, confidence: 0.8 })
    expect(c.detail(t.id).activity.some((a) => a.kind === 'routed' && a.message.startsWith('Suggested Marketing / Copywriter'))).toBe(true)
    // the existing accept path applies it
    expect(c.acceptRoute(t.id)).toMatchObject({ status: 'todo', departmentId: b.marketing.id, agentId: b.writer.id })
  })

  it('is off without a model call, never asked for a routed task, and never lands on a task that moved on', async () => {
    const b = board()
    const none = b.task()
    await d.suggest(none.id)
    expect(c.task(none.id).routing?.by).not.toBe('model')
    let asked = 0
    let release!: () => void
    model = async () => {
      asked++
      await new Promise<void>((r) => (release = r))
      return JSON.stringify({ departmentKey: 'marketing', agentId: null, confidence: 0.6, reason: 'copy' })
    }
    b.task({ status: 'todo', departmentId: b.dev.id })
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toBe(0)
    const moving = b.task({ title: 'Something' })
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toBe(1)
    c.assign(moving.id, { departmentId: b.dev.id }, 'human')
    release()
    await d.suggest(moving.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(c.task(moving.id)).toMatchObject({ departmentId: b.dev.id, status: 'todo' })
    expect(c.task(moving.id).routing?.by).toBe('human')
  })
})

describe('AGENT CHAT: an agent’s own chat works its own board tasks', () => {
  it('moves a task assigned to its agent (to in review through in progress), never another agent’s, never one a run holds', () => {
    const b = board()
    const owner = b.chat('session_agent')
    db.prepare('UPDATE sessions SET company_agent_id=? WHERE id=?').run(b.writer.id, 'session_agent')
    const mine = b.task({ title: 'Homepage headlines', status: 'todo', departmentId: b.marketing.id, agentId: b.writer.id })
    const theirs = b.task({ title: 'Logo', status: 'todo', departmentId: b.marketing.id, agentId: b.designer.id })
    const update = (args: Record<string, unknown>) => tools.call(tools.resolveCaller(owner), 'task_update' as BoardTool, args, { callId: null }) as { task: { status: string } }
    // the chat is the agent's chat, not a task session, even once it holds the task
    expect(tools.resolveCaller(owner).chatAgentId).toBe(b.writer.id)
    const done = update({ id: mine.identifier, status: 'in_review', note: 'Drafted three headlines in the chat' })
    expect(done.task.status).toBe('in_review')
    const t = c.task(mine.id)
    expect(t.report?.summary).toBe('Drafted three headlines in the chat')
    expect(t.runId).toBeNull()
    expect(() => update({ id: theirs.identifier, status: 'in_progress' })).toThrow('not tracked by this chat')
    expect(() => update({ id: mine.identifier, status: 'done' })).toThrow()
    // a task its agent's run is working on is not the chat's to move
    const running = b.task({ title: 'Blog post', status: 'todo', departmentId: b.marketing.id, agentId: b.writer.id })
    db.prepare("UPDATE company_tasks SET status='in_progress', run_id='run_x', data=json_set(data,'$.status','in_progress','$.runId','run_x') WHERE id=?").run(running.id)
    expect(() => update({ id: running.identifier, status: 'in_review', note: 'x' })).toThrow('being worked on by a run')
    // starting one holds it with the chat; the chat stays a chat (no task session)
    const next = b.task({ title: 'Tagline', status: 'todo', departmentId: b.marketing.id, agentId: b.writer.id })
    expect(update({ id: next.identifier, status: 'in_progress' }).task.status).toBe('in_progress')
    expect(c.task(next.id).runId).toBe('session_agent')
    expect(tools.resolveCaller(owner).taskId).toBeNull()
    // a comment on its own task is fine
    expect(() => tools.call(tools.resolveCaller(owner), 'task_comment' as BoardTool, { id: next.identifier, text: 'Going with option 2' }, { callId: null })).not.toThrow()
  })
})
