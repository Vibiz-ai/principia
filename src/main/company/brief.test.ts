import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { buildAuthorHandlers } from '../author/server/tools'
import { Dispatcher, HookedCompanyStore } from './dispatcher'
import { TaskTools, type TaskCaller } from './taskTools'
import { BriefStore, briefPromptBlock, checkProofRef, decide, editSection, setCriterion, BRIEF_HABITS } from './brief'
import { buildTaskPrompt, TASK_RULES_FOOTER } from './taskPrompt'
import { briefOf, EMPTY_BRIEF, lastRevision, type TaskBrief } from '../../shared/plans'
import type { StartRunOptions } from '../../shared/engine'
import type { CompanyTaskInput } from '../../shared/company'
import type { Run, RunTarget } from '../../shared/types'

let db: DB; let store: Store; let c: HookedCompanyStore; let dir: string; let d: Dispatcher; let tools: TaskTools; let briefs: BriefStore
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let seq = 0
const clock = new Date('2026-10-20T10:00:00.000Z')
const redact = (s: string) => s.replace(/sk-[a-z0-9]{8,}/gi, '••••')

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_b${++seq}`
  const artifacts = path.join(dir, 'artifacts', id)
  fs.mkdirSync(artifacts, { recursive: true })
  const createdAt = new Date().toISOString()
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), createdAt, artifacts, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt, startedAt: createdAt, endedAt: null, artifactsDir: artifacts, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'principia-brief-')))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new HookedCompanyStore(store)
  started = []
  d = new Dispatcher({ company: c, startRun, cancelRun: async () => undefined, enabled: () => true })
  c.hooks = d.hooks()
  tools = new TaskTools({ company: () => c, redact, enabled: () => true })
  briefs = new BriefStore(() => c)
})
afterEach(() => { d.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

function board() {
  const co = c.create({ name: 'Acme' })
  const dep = c.departments.save({ companyId: co.id, name: 'Development', key: 'development' })
  const profile = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const agent = c.departments.saveAgent({ companyId: co.id, departmentId: dep.id, kind: 'profile', refId: profile.id, name: 'Builder', data: { autonomy: 'manual' } })
  const task = (over: Partial<CompanyTaskInput> = {}) => c.createTask({ title: 'Fix login', description: 'Login fails on Safari.\n\nSee the Sentry issue.', companyId: co.id, repoId: null, status: 'todo', priority: 2, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: dep.id, agentId: agent.id, ...over })
  const run = (taskId: string) => {
    d.runNow(taskId)
    const r = started[started.length - 1].run
    const caller: TaskCaller = tools.resolveCaller({ runId: r.id, stepId: 'st_1' })
    return { run: r, caller }
  }
  return { co, agent, task, run }
}
function end(run: Run, status: Run['status'] = 'passed') {
  db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id)
  d.onRunUpdated({ ...run, status })
  const row = db.prepare('SELECT task_id FROM runs WHERE id=?').get(run.id) as { task_id: string }
  briefs.fillHandoff(row.task_id, run.startedAt ?? run.createdAt)
}

describe('PLANS.md §1 briefs: old rows lose nothing', () => {
  it('an old task without a brief reads its description as the Context, and nothing is written until an edit', () => {
    const { task } = board()
    const t = task()
    expect(t.brief).toBeUndefined()
    const b = briefOf(c.task(t.id))
    expect(b.context).toBe('Login fails on Safari.\n\nSee the Sentry issue.')
    expect(b.goal).toBe('')
    expect(JSON.parse((db.prepare('SELECT data FROM company_tasks WHERE id=?').get(t.id) as { data: string }).data).brief).toBeUndefined()
    // a plain human edit (tasks:update) keeps working on a row that has a brief
    briefs.edit(t.id, (x, at) => editSection(x, 'goal', 'replace', 'Safari users can sign in', 'human', at))
    const u = c.updateTask(t.id, { priority: 1 })
    expect(briefOf(u).goal).toBe('Safari users can sign in')
    expect(briefOf(u).context).toContain('Sentry issue')
  })
  it('saving a section unchanged (an empty goal, the same goal) writes no revision (QA)', () => {
    const { task } = board()
    const t = task()
    const n = () => briefOf(c.task(t.id)).revisions.length
    const before = n()
    briefs.edit(t.id, (x, at) => editSection(x, 'goal', 'replace', '   ', 'human', at))
    expect(n()).toBe(before)
    briefs.edit(t.id, (x, at) => editSection(x, 'goal', 'replace', 'Safari users can sign in', 'human', at))
    expect(n()).toBe(before + 1)
    briefs.edit(t.id, (x, at) => editSection(x, 'goal', 'replace', 'Safari users can sign in ', 'human', at))
    expect(n()).toBe(before + 1)
  })
})

describe('PLANS.md §1 brief tools', () => {
  it('an agent turn ticks a criterion, records a decision with why and rewrites the handoff, each marked with the agent and the time', () => {
    const { task, run, agent } = board()
    const t = task()
    briefs.edit(t.id, (b, at) => editSection(b, 'criteria', 'append', '- Login works on Safari 17\n- A regression test covers it', 'human', at))
    const { run: r, caller } = run(t.id)
    tools.call(caller, 'task_criterion', { id: 'c1', state: 'done' })
    tools.call(caller, 'task_decide', { text: 'Use the SameSite=Lax cookie', why: 'Safari drops SameSite=None without Secure' })
    tools.call(caller, 'task_brief_edit', { section: 'handoff', mode: 'replace', text: 'Cookie fixed in auth.ts; the test is in auth.test.ts.' })
    tools.call(caller, 'task_report', { outcome: 'review', summary: 'Fixed the cookie', evidence: [] })
    end(r)
    const b = briefOf(c.task(t.id))
    expect(b.criteria[0]).toMatchObject({ id: 'c1', state: 'done' })
    expect(b.decisions[0]).toMatchObject({ text: 'Use the SameSite=Lax cookie', why: 'Safari drops SameSite=None without Secure', by: `agent:${agent.id}` })
    // the agent's own handoff wins: the report did not overwrite it
    expect(b.handoff).toBe('Cookie fixed in auth.ts; the test is in auth.test.ts.')
    for (const s of ['criteria', 'decisions', 'handoff'] as const) expect(lastRevision(b, s)).toMatchObject({ by: `agent:${agent.id}` })
    expect(lastRevision(b, 'handoff')!.at).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(c.task(t.id).status).toBe('in_review')
  })
  it('a turn that never calls the brief tools gets its handoff from the report, by system: no error, no re-wake', () => {
    const { task, run } = board()
    const t = task()
    const { run: r, caller } = run(t.id)
    tools.call(caller, 'task_report', { outcome: 'review', summary: 'Patched the Safari cookie and added a test.', evidence: ['auth.test.ts'] })
    end(r)
    const after = c.task(t.id)
    expect(after.status).toBe('in_review')
    const b = briefOf(after)
    expect(b.handoff).toContain('Patched the Safari cookie')
    expect(lastRevision(b, 'handoff')!.by).toBe('system')
    // no follow-up turn, no new run
    expect(started).toHaveLength(1)
    expect(after.pendingWake).toBeNull()
  })
  it("task_criterion 'deferred' without a reason returns a readable validation error", () => {
    const { task, run } = board()
    const t = task()
    briefs.edit(t.id, (b, at) => editSection(b, 'criteria', 'append', 'Works on iOS', 'human', at))
    const { caller } = run(t.id)
    expect(() => tools.call(caller, 'task_criterion', { id: 'c1', state: 'deferred' })).toThrow(/reason.*needs a reason/i)
    expect(() => tools.call(caller, 'task_criterion', { id: 'c9', state: 'done' })).toThrow(/No criterion "c9"/)
    const ok = tools.call(caller, 'task_criterion', { id: 'c1', state: 'deferred', reason: 'iOS is out of scope this week' })
    expect(ok).toMatchObject({ ok: true })
    expect(briefOf(c.task(t.id)).criteria[0]).toMatchObject({ state: 'deferred', reason: 'iOS is out of scope this week' })
  })
  it('proof files come only from the worktree or the artifacts, never secrets; refs are redacted', () => {
    const { task, run } = board()
    const t = task()
    const { run: r, caller } = run(t.id)
    const outside = path.join(dir, 'outside.png'); fs.writeFileSync(outside, 'x')
    expect(() => tools.call(caller, 'task_attach_proof', { kind: 'screenshot', title: 'Login', ref: outside })).toThrow("worktree or its run's artifacts")
    expect(() => tools.call(caller, 'task_attach_proof', { kind: 'file', title: 'Up', ref: '../../outside.png' })).toThrow(/worktree|No such file/)
    const shot = path.join(r.artifactsDir, 'login.png'); fs.writeFileSync(shot, 'png')
    expect(tools.call(caller, 'task_attach_proof', { kind: 'screenshot', title: 'Login on Safari', ref: shot })).toMatchObject({ ok: true, total: 1 })
    // a relative ref resolves against the first root (the artifacts dir here)
    fs.writeFileSync(path.join(r.artifactsDir, 'report.txt'), 'ok')
    expect(tools.call(caller, 'task_attach_proof', { kind: 'file', title: 'Report', ref: 'report.txt' })).toMatchObject({ total: 2 })
    fs.writeFileSync(path.join(r.artifactsDir, '.env'), 'KEY=1')
    expect(() => tools.call(caller, 'task_attach_proof', { kind: 'file', title: 'env', ref: '.env' })).toThrow('looks like a secret')
    expect(() => tools.call(caller, 'task_attach_proof', { kind: 'link', title: 'x', ref: 'file:///etc/passwd' })).toThrow('http(s)')
    tools.call(caller, 'task_attach_proof', { kind: 'test', title: 'vitest', ref: 'npx vitest run auth: 12 passed (token sk-abcdefghijk)' })
    const proof = c.task(t.id).proof!
    expect(proof.map(p => p.kind)).toEqual(['screenshot', 'file', 'test'])
    expect(proof[2].ref).toContain('••••')
    expect(proof[2].ref).not.toContain('sk-abcdefghijk')
  })
  it('a task the caller no longer holds cannot be edited', () => {
    const { task, run } = board()
    const t = task()
    const { run: r, caller } = run(t.id)
    tools.call(caller, 'task_report', { outcome: 'review', summary: 'done', evidence: [] })
    end(r)
    expect(() => tools.call(caller, 'task_decide', { text: 'x', why: 'y' })).toThrow('no longer yours')
  })
})

describe('PLANS.md §1 the prompt carries the brief, capped', () => {
  it('the brief replaces the description; only open criteria, the last 5 decisions and the handoff ride along; the footer keeps its rule', () => {
    const { task } = board()
    const t = task()
    let b: TaskBrief = { ...EMPTY_BRIEF, goal: 'Safari users can sign in', context: 'Login fails on Safari.' }
    b = editSection(b, 'criteria', 'append', 'One\nTwo\nThree', 'human', clock.toISOString())
    b = setCriterion(b, 'c2', 'done', undefined, 'human', clock.toISOString())
    for (let i = 1; i <= 8; i++) b = decide(b, `Decision ${i}`, `because ${i}`, 'human', clock.toISOString())
    b = editSection(b, 'handoff', 'replace', 'Start from auth.ts', 'human', clock.toISOString())
    briefs.write(t.id, { brief: b })
    const block = briefPromptBlock(c.task(t.id))
    expect(block).toContain('Goal: Safari users can sign in')
    expect(block).toContain('[c1] One')
    expect(block).not.toContain('[c2]')
    expect(block).toContain('(1 already settled)')
    expect(block).not.toContain('Decision 3 ')
    expect(block).toContain('Decision 4')
    expect(block).toContain('Decision 8')
    expect(block).toContain('Start from auth.ts')
    expect(block).toContain(BRIEF_HABITS)
    const prompt = buildTaskPrompt({ task: c.task(t.id), companyId: t.companyId, department: null, agent: null, deps: [], activity: [], wake: ['Go'], brief: block })
    expect(prompt).toContain('Brief:')
    expect(prompt).not.toContain('Description:')
    expect(prompt).toContain(TASK_RULES_FOOTER)
    expect(TASK_RULES_FOOTER).toContain('You cannot mark tasks done')
  })
  it('a full brief stays small in the prompt (risk 1: token budget)', () => {
    let b: TaskBrief = { ...EMPTY_BRIEF, goal: 'g'.repeat(1000), context: 'x'.repeat(20_000), handoff: 'h'.repeat(6000) }
    b = editSection(b, 'criteria', 'append', Array.from({ length: 40 }, (_, i) => `criterion ${i} ${'y'.repeat(400)}`).join('\n'), 'human', clock.toISOString())
    for (let i = 0; i < 100; i++) b = decide(b, `d${i} ${'z'.repeat(900)}`, 'w'.repeat(900), 'human', clock.toISOString())
    b = editSection(b, 'questions', 'append', Array.from({ length: 30 }, (_, i) => `q${i} ${'q'.repeat(500)}`).join('\n'), 'human', clock.toISOString())
    for (let i = 0; i < 40; i++) b = setCriterion(b, `c${i + 1}`, i < 35 ? 'done' : 'open', undefined, 'human', clock.toISOString())
    const block = briefPromptBlock({ description: '', brief: b })
    // goal 600 + context 2000 + 5 open criteria + 5 decisions + 5 questions + handoff 1500 + habits: about 2k tokens at worst
    expect(block.length).toBeLessThan(9_000)
    const small = briefPromptBlock({ description: 'Write the launch post' })
    expect(small.length).toBeLessThan(BRIEF_HABITS.length + 80)
  })
  it('task prompts of a started task carry the brief (CompanyStore.taskPrompt)', () => {
    const { task } = board()
    const t = task()
    briefs.edit(t.id, (b, at) => editSection(b, 'goal', 'replace', 'Safari users can sign in', 'human', at))
    d.runNow(t.id)
    const target = started[0].target as Extract<RunTarget, { kind: 'prompt' }>
    expect(target.prompt).toContain('Goal: Safari users can sign in')
    expect(target.prompt).toContain('Context:\nLogin fails on Safari.')
  })
})

describe('PLANS.md §1 chats get no brief tools', () => {
  it('a session that holds no task lists no brief tools and no brief instructions; a task session does', () => {
    const live = fs.mkdtempSync(path.join(dir, 'live-'))
    const chat = buildAuthorHandlers({ HIVE_LIVE_DIR: live, HIVE_TOOLSETS: 'author,task' } as NodeJS.ProcessEnv)
    const names = chat.listTools().map(t => t.name)
    expect(names).toContain('task_create')
    for (const n of ['task_brief_edit', 'task_criterion', 'task_decide', 'task_attach_proof']) expect(names).not.toContain(n)
    expect(chat.instructions()).not.toContain('task brief')
    const held = buildAuthorHandlers({ HIVE_LIVE_DIR: live, HIVE_TOOLSETS: 'author,task', HIVE_TASK_ID: 'task_x' } as NodeJS.ProcessEnv)
    expect(held.listTools().map(t => t.name)).toContain('task_decide')
    expect(held.instructions()).toContain('task brief')
  })
  it('proof refs: links, text results and files are each checked', () => {
    const root = fs.mkdtempSync(path.join(dir, 'wt-'))
    fs.writeFileSync(path.join(root, 'a.png'), 'x')
    expect(checkProofRef('screenshot', 'a.png', [root], s => s)).toBe(fs.realpathSync(path.join(root, 'a.png')))
    expect(() => checkProofRef('screenshot', path.join(root, 'nope.txt'), [root], s => s)).toThrow('No such file')
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
    expect(() => checkProofRef('screenshot', 'notes.txt', [root], s => s)).toThrow('.png')
    expect(() => checkProofRef('file', 'a.png', [], s => s)).toThrow('no worktree or artifacts')
    expect(checkProofRef('graph', 'graph TD; A-->B', [], s => s)).toBe('graph TD; A-->B')
  })
})

describe('PLANS.md QA fixes on briefs', () => {
  it('editing the Description after the task has a brief moves the Context too, so the inspector and the agent see the edit', () => {
    const { task, run } = board()
    const t = task()
    briefs.edit(t.id, (b, at) => editSection(b, 'criteria', 'append', 'Works on Safari', 'human', at))
    const u = c.updateTask(t.id, { description: 'NEW description edited by founder' })
    expect(briefOf(u).context).toBe('NEW description edited by founder')
    expect(lastRevision(briefOf(u), 'context')).toMatchObject({ by: 'human' })
    // an unrelated edit writes no context revision
    const n = briefOf(u).revisions.length
    expect(briefOf(c.updateTask(t.id, { priority: 1 })).revisions).toHaveLength(n)
    const { run: r } = run(t.id)
    expect((r.target as Extract<RunTarget, { kind: 'prompt' }>).prompt).toContain('NEW description edited by founder')
    expect((r.target as Extract<RunTarget, { kind: 'prompt' }>).prompt).not.toContain('Sentry issue')
  })
  it('editing the Context in the brief keeps the description the same text (one source of truth)', () => {
    const { task } = board()
    const t = task()
    briefs.edit(t.id, (b, at) => editSection(b, 'context', 'replace', 'Only Safari 17 fails.', 'human', at))
    expect(c.task(t.id).description).toBe('Only Safari 17 fails.')
    // a goal edit leaves the description alone
    briefs.edit(t.id, (b, at) => editSection(b, 'goal', 'replace', 'Safari users sign in', 'human', at))
    expect(c.task(t.id).description).toBe('Only Safari 17 fails.')
  })
  it('task_report reminds the agent of the handoff and decisions it has not written this turn (advice, never an error)', () => {
    const { task, run } = board()
    const t = task()
    const { caller } = run(t.id)
    const out = tools.call(caller, 'task_report', { outcome: 'review', summary: 'Done', evidence: [] }) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.brief).toMatch(/^Before you end the turn: rewrite the handoff with task_brief_edit .*; and record each choice you made with task_decide/)
    tools.call(caller, 'task_brief_edit', { section: 'handoff', mode: 'replace', text: 'Cookie fixed.' })
    tools.call(caller, 'task_decide', { text: 'Lax cookie', why: 'Safari' })
    const again = tools.call(caller, 'task_report', { outcome: 'review', summary: 'Done', evidence: [] }) as Record<string, unknown>
    expect(again.brief).toBeUndefined()
    expect(BRIEF_HABITS).toContain('Before task_report, rewrite the handoff')
  })
  it('a relative proof path resolves against the folder the agent works in first, then the artifacts', () => {
    const { task, run } = board()
    const t = task()
    const { run: r, caller } = run(t.id)
    const wt = path.join(dir, 'wt-m1'); fs.mkdirSync(path.join(wt, 'shots'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'shots', 'x.png'), 'png')
    // the task works in its own worktree (its WORKTREE.md binding; a plan task, in its milestone task's)
    const work = { repoId: 'repo_x', worktreePath: wt, branch: 'hive/x', baseSha: null, baseRef: null, pr: null, startedAt: '2026-10-25T00:00:00Z', worktreeId: null, queuedAt: null, goneAt: null, removedAt: null, gh: null, reviewSeenAt: null, readySeen: null, conflict: false, error: null }
    db.prepare("UPDATE company_tasks SET data=json_set(data,'$.work',json(?)) WHERE id=?").run(JSON.stringify(work), t.id)
    const out = tools.call(caller, 'task_attach_proof', { kind: 'screenshot', title: 'The view', ref: 'shots/x.png' }) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(c.task(t.id).proof![0].ref).toBe(path.join(wt, 'shots', 'x.png'))
    // a file only in the artifacts folder still resolves
    fs.writeFileSync(path.join(r.artifactsDir!, 'report.txt'), 'ok')
    expect(checkProofRef('file', 'report.txt', [wt, r.artifactsDir!], s => s)).toBe(path.join(r.artifactsDir!, 'report.txt'))
  })
})
