import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { createEngineStore, runTaskLink } from '../db/engineStore'
import { LiveStore } from '../db/liveStore'
import { Dispatcher, HookedCompanyStore, pauseAllAgents, taskRunBridge, type DispatcherSessions } from './dispatcher'
import type { StartRunOptions } from '../../shared/engine'
import type { CompanyTaskInput } from '../../shared/company'
import type { Run, RunTarget, Session } from '../../shared/types'

let db: DB; let store: Store; let c: HookedCompanyStore; let dir: string; let d: Dispatcher
let enabled = true
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let canceled: string[] = []
let seq = 0
let clock = new Date('2026-10-20T10:00:00.000Z')

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_d${++seq}`
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','queued',?,?,?)`).run(id, JSON.stringify(target), new Date().toISOString(), dir, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'queued', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}
function dispatcher(o: { sessions?: DispatcherSessions } = {}) {
  return new Dispatcher({ company: c, startRun, cancelRun: async id => { canceled.push(id); end(id, 'canceled', 'Canceled') }, enabled: () => enabled, sessions: o.sessions ?? null, now: () => clock })
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-dispatch-'))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new HookedCompanyStore(store)
  enabled = true; started = []; canceled = []; clock = new Date('2026-10-20T10:00:00.000Z')
  d = dispatcher(); c.hooks = d.hooks()
})
afterEach(() => { d.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

/** Ends a run the way the engine does (row status, then run.updated through runHooks). */
function end(runId: string, status: Run['status'], reason: string | null = null) {
  db.prepare('UPDATE runs SET status=?, reason=? WHERE id=?').run(status, reason, runId)
  const run = started.find(s => s.run.id === runId)!.run
  d.onRunUpdated({ ...run, status, reason })
}
/** The agent reported review (task_report through D5's tools / harvest), then its run passed. */
function report(taskId: string, outcome: 'review' | 'blocked' = 'review') {
  c.patchInFlight(taskId, { report: { outcome, summary: 'Draft is ready', evidence: [], at: new Date().toISOString() } })
}
const flush = () => new Promise(r => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 5; i++) await flush() }

function board(o: { autopilot?: boolean; autonomy?: 'auto' | 'manual'; adapter?: 'claude' | 'codex'; maxInFlight?: number; name?: string } = {}) {
  const co = c.create({ name: o.name ?? 'Acme' })
  const dep = c.departments.save({ companyId: co.id, name: 'Marketing' })
  const profile = store.createProfile({ name: 'Claude', adapter: o.adapter ?? 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const seat = (name: string, autonomy = o.autonomy ?? 'auto') => c.departments.saveAgent({ companyId: co.id, departmentId: dep.id, kind: 'profile', refId: profile.id, name, data: { autonomy } })
  const agent = seat('Copywriter')
  if (o.autopilot ?? true) c.setAutopilot(co.id, true, o.maxInFlight)
  const task = (over: Partial<CompanyTaskInput> = {}) => c.createTask({ title: 'Launch post', description: 'Write the launch post', companyId: co.id, repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: dep.id, agentId: agent.id, ...over })
  return { co, dep, profile, agent, seat, task }
}
const runsOf = (taskId: string) => started.filter(s => s.opts.taskId === taskId)
const kinds = (id: string) => c.detail(id).activity.map(a => a.kind)

describe('DEPARTMENTS.md §3 dispatcher: assignment is the wake', () => {
  it('with autopilot on and an auto agent, assignment starts exactly one run (trigger task, task and seat linked)', async () => {
    const { co, dep, agent, task } = board()
    const t = task({ agentId: null, status: 'triage' })
    await settle()
    // the only agent in Marketing is routed by rule on create and woken at once
    expect(c.task(t.id)).toMatchObject({ status: 'in_progress', agentId: agent.id, departmentId: dep.id })
    expect(started).toHaveLength(1)
    expect(started[0].opts).toMatchObject({ trigger: 'task', taskId: t.id, agentId: agent.id, companyId: co.id, runMinutes: 30 })
    expect(db.prepare('SELECT task_id AS taskId, agent_id AS agentId FROM runs WHERE id=?').get(started[0].run.id)).toEqual({ taskId: t.id, agentId: agent.id })
    expect(kinds(t.id)).toEqual(expect.arrayContaining(['created', 'assigned', 'routed', 'woke', 'started']))
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(1)
    expect(c.task(t.id).autoWakes.n).toBe(1)
  })
  it('with autopilot off (the default) nothing starts unless a human clicks Run', async () => {
    const { co, task } = board({ autopilot: false })
    const t = task()
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(0)
    expect(c.task(t.id).status).toBe('todo')
    // a manual seat with autopilot on does not start either
    const manual = board({ name: 'Beta', autonomy: 'manual' })
    const m = manual.task()
    await d.pump(manual.co.id)
    expect(c.task(m.id).status).toBe('todo')
    expect(d.runNow(t.id).status).toBe('in_progress')
    expect(started.map(s => s.opts.taskId)).toEqual([t.id])
    expect(started[0].opts.trigger).toBe('task')
    expect(c.boardSettings(co.id).autopilot).toBe(false)
  })
  it('with departments off the dispatcher does nothing', async () => {
    enabled = false
    const { task } = board()
    const t = task()
    await d.tick()
    expect(started).toHaveLength(0)
    expect(c.task(t.id).status).toBe('todo')
  })
  it('two todo tasks for one agent run sequentially, highest priority first, oldest first', async () => {
    const { co, task } = board({ autopilot: false })
    const low = task({ title: 'Low', priority: 4 }), urgent = task({ title: 'Urgent', priority: 1 }), urgent2 = task({ title: 'Urgent later', priority: 1 })
    c.setAutopilot(co.id, true)
    await d.pump(co.id)
    expect(started.map(s => s.opts.taskId)).toEqual([urgent.id])
    expect(c.task(urgent2.id).status).toBe('todo')
    end(started[0].run.id, 'passed')
    await settle()
    expect(started.map(s => s.opts.taskId)).toEqual([urgent.id, urgent2.id])
    end(started[1].run.id, 'passed')
    await settle()
    expect(started.map(s => s.opts.taskId)).toEqual([urgent.id, urgent2.id, low.id])
    expect(c.task(urgent.id).status).toBe('in_review')
  })
  it('maxInFlight holds per company and never limits another company', async () => {
    const a = board({ autopilot: false })
    const seats = [a.agent, a.seat('Editor'), a.seat('Designer')]
    const tasks = seats.map(s => a.task({ agentId: s.id }))
    c.setAutopilot(a.co.id, true, 2)
    const b = board({ name: 'Beta', maxInFlight: 1 })
    const bt = b.task()
    await d.pump()
    expect(tasks.filter(t => c.task(t.id).status === 'in_progress')).toHaveLength(2)
    expect(c.task(bt.id).status).toBe('in_progress')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(tasks.filter(t => c.task(t.id).status === 'in_progress')).toHaveLength(2)
    // one finishes: the waiting seat gets its turn
    const waiting = tasks.find(t => c.task(t.id).status === 'todo')!
    const first = started.find(s => tasks.some(t => t.id === s.opts.taskId))!
    end(first.run.id, 'passed')
    await settle()
    expect(tasks.filter(t => c.task(t.id).status === 'in_progress')).toHaveLength(2)
    expect(c.task(waiting.id).status).toBe('in_progress')
  })
  it('concurrent pump calls never double-claim', async () => {
    const { co, seat, task } = board({ autopilot: false })
    const editor = seat('Editor')
    task(); task(); task({ agentId: editor.id }); task({ agentId: editor.id })
    c.setAutopilot(co.id, true)
    await Promise.all([d.pump(co.id), d.pump(), d.pump(co.id), d.tick(), d.pump(co.id)])
    expect(started).toHaveLength(2)
    expect(new Set(started.map(s => s.opts.agentId)).size).toBe(2)
    expect((db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE status='in_progress'").get() as { n: number }).n).toBe(2)
  })
  it('a manual Run racing a tick: the agent takes both tasks at once, a busy agent never refuses a click, the same task never starts twice', async () => {
    const { co, task } = board({ autopilot: false })
    const t1 = task({ title: 'First' }), t2 = task({ title: 'Second' })
    c.setAutopilot(co.id, true)
    // the click lands while the tick is queued: the click starts t2, the tick starts t1 beside it
    const tick = d.tick()
    expect(d.runNow(t2.id).status).toBe('in_progress')
    await tick
    expect(started.map(s => s.opts.taskId)).toEqual([t2.id, t1.id])
    expect(c.task(t1.id).status).toBe('in_progress')
    // a third task: the agent is on two already, the click starts it anyway (past the company's cap too)
    const t3 = task({ title: 'Third' })
    expect(d.runNow(t3.id).status).toBe('in_progress')
    expect(started).toHaveLength(3)
    // the CAS / transaction still holds per task
    expect(() => d.runNow(t1.id)).toThrow('An agent already owns this task')
    await d.pump(co.id)
    expect(started).toHaveLength(3)
    // the human click reset the wake guard of the task it started
    expect(c.task(t2.id).autoWakes).toEqual({ windowStart: null, n: 0 })
  })
  it('PR-69: with no limit set, one agent takes every task it has, past the old caps of 3', async () => {
    const { co, task } = board({ autopilot: false })
    const ts = [1, 2, 3, 4, 5, 6].map(n => task({ title: `Task ${n}` }))
    c.setAutopilot(co.id, true)
    expect(c.boardSettings(co.id).maxInFlight).toBe(0)
    for (let i = 0; i < ts.length; i++) await d.pump(co.id)
    expect(started).toHaveLength(ts.length)
    expect(ts.every(t => c.task(t.id).status === 'in_progress')).toBe(true)
  })
  it('PR-69: a limit the founder sets still holds; 0 takes it off again', async () => {
    const { co, task } = board({ autopilot: false })
    const ts = [1, 2, 3].map(n => task({ title: `Task ${n}` }))
    c.setAutopilot(co.id, true, 1)
    for (let i = 0; i < 3; i++) await d.pump(co.id)
    expect(started).toHaveLength(1)
    c.setAutopilot(co.id, true, 0)
    for (let i = 0; i < 3; i++) await d.pump(co.id)
    expect(started).toHaveLength(ts.length)
  })
})

describe('DEPARTMENTS.md §3.5-3.6: coalesced wakes, follow-ups, guards', () => {
  it('5 comments during a run give exactly one follow-up turn that resumes the Claude conversation', async () => {
    const { task } = board()
    const t = task()
    await settle()
    expect(started).toHaveLength(1)
    // the executor reports the provider conversation id (TaskRunBridge.sessionCaptured)
    const bridge = taskRunBridge({ company: () => c, dispatcher: () => d, toolset: () => null })
    bridge.sessionCaptured!({ runId: started[0].run.id, taskId: t.id, adapter: 'claude', agentSessionId: 'conv-1' })
    for (let i = 1; i <= 5; i++) c.activity(t.id, 'comment', `Note ${i}`, 'human')
    await settle()
    expect(started).toHaveLength(1)
    expect(c.task(t.id).pendingWake?.count).toBe(5)
    expect(kinds(t.id).filter(k => k === 'coalesced')).toHaveLength(5)
    report(t.id)
    end(started[0].run.id, 'passed')
    await settle()
    expect(started).toHaveLength(2)
    const follow = started[1]
    expect(follow.opts).toMatchObject({ trigger: 'task', taskId: t.id, resumeSessionId: 'conv-1' })
    const prompt = follow.target.kind === 'prompt' ? follow.target.prompt : ''
    for (let i = 1; i <= 5; i++) expect(prompt).toContain(`Note ${i}`)
    expect(c.task(t.id)).toMatchObject({ status: 'in_progress', pendingWake: null })
    // the follow-up ends with no new wakes: no further turn
    report(t.id)
    end(follow.run.id, 'passed')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(2)
    expect(c.task(t.id).status).toBe('in_review')
  })
  it('a run that ends on a question never follows up; agent comments never wake anyone', async () => {
    const { task } = board()
    const t = task()
    await settle()
    c.activity(t.id, 'comment', 'I will look into the copy deck', 'agent')
    expect(c.task(t.id).pendingWake).toBeNull()
    expect(kinds(t.id)).not.toContain('coalesced')
    c.activity(t.id, 'comment', 'Use the new logo', 'human')
    c.patchInFlight(t.id, { ask: { kind: 'question', prompt: 'Which headline?' } })
    end(started[0].run.id, 'passed')
    await settle()
    expect(started).toHaveLength(1)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    // the answer resumes it, with the comment and the answer as the wake
    c.answer(t.id, 'The second one')
    await d.pump(t.companyId)
    expect(started).toHaveLength(2)
    const prompt = started[1].target.kind === 'prompt' ? started[1].target.prompt : ''
    expect(prompt).toContain('Use the new logo')
    expect(prompt).toContain('Answer: The second one')
  })
  it('autopilot off and a manual seat: the founder answering a question is their go-ahead, so the same agent resumes', async () => {
    const { task } = board({ autopilot: false, autonomy: 'manual' })
    const t = task()
    d.runNow(t.id)
    c.patchInFlight(t.id, { ask: { kind: 'question', prompt: 'Which headline?' } })
    end(started[0].run.id, 'passed')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    // a plain todo task of the same seat still waits for a Start
    const other = task({ title: 'Other' })
    c.answer(t.id, 'The second one')
    await settle()
    expect(c.task(t.id).status).toBe('in_progress')
    expect(runsOf(t.id)).toHaveLength(2)
    expect(c.task(other.id).status).toBe('todo')
  })
  it('an unclosed stop parks and is not re-woken after 10 ticks', async () => {
    const { task } = board()
    const passed = task({ title: 'Passed silently' })
    await settle()
    end(started[0].run.id, 'passed')
    await settle()
    const canceledTask = task({ title: 'Canceled' })
    await settle()
    end(started[1].run.id, 'canceled', 'Canceled')
    await settle()
    const failed = task({ title: 'Failed' })
    await settle()
    end(started[2].run.id, 'failed', 'exit 1')
    for (let i = 0; i < 10; i++) await d.tick()
    expect(started).toHaveLength(3)
    expect(c.task(passed.id).status).toBe('in_review')
    expect(c.task(canceledTask.id)).toMatchObject({ status: 'blocked', blockReason: 'no_report' })
    expect(c.task(failed.id)).toMatchObject({ status: 'blocked', blockReason: 'run_failed' })
  })
  it('the 5th automatic wake within an hour parks blocked(limit); a human action resets the count', async () => {
    const { task } = board()
    const t = task()
    await settle()
    // wakes 2-4: a comment during each run, a review report, a follow-up turn
    for (let i = 0; i < 4; i++) {
      c.activity(t.id, 'comment', `Round ${i}`, 'system')
      report(t.id)
      end(started.at(-1)!.run.id, 'passed')
      await settle()
    }
    expect(started).toHaveLength(4)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'limit' })
    expect(c.detail(t.id).activity.at(-1)?.message).toContain('4 automatic wakes within an hour')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(4)
    // the human unparks it: the counter resets and it runs again
    c.unpark(t.id)
    await d.pump(t.companyId)
    expect(started).toHaveLength(5)
    expect(c.task(t.id).autoWakes.n).toBe(1)
  })
  it('the guard window is one hour: wakes an hour apart never park', async () => {
    const { task } = board()
    const t = task()
    await settle()
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 61 * 60_000)
      c.activity(t.id, 'comment', `Hour ${i}`, 'system')
      report(t.id)
      end(started.at(-1)!.run.id, 'passed')
      await settle()
    }
    expect(started).toHaveLength(6)
    expect(c.task(t.id).status).toBe('in_progress')
  })
  it('finishing PRN-1 heals and wakes the dependent PRN-2', async () => {
    const { seat, task } = board()
    const first = task({ title: 'Brief' })
    await settle()
    const second = task({ title: 'Post', agentId: seat('Editor').id, dependencyIds: [first.id] })
    await settle()
    expect(c.task(second.id)).toMatchObject({ status: 'blocked', blockReason: 'deps' })
    report(first.id)
    end(started[0].run.id, 'passed')
    await settle()
    expect(started).toHaveLength(1)
    c.approve(first.id, 'Approved the brief')
    await d.pump(first.companyId)
    expect(c.task(second.id).status).toBe('in_progress')
    expect(runsOf(second.id)).toHaveLength(1)
    const prompt = runsOf(second.id)[0].target.kind === 'prompt' ? (runsOf(second.id)[0].target as { prompt: string }).prompt : ''
    expect(prompt).toContain('Unblocked: every dependency is done.')
    expect(kinds(second.id)).toEqual(expect.arrayContaining(['healed', 'woke', 'started']))
  })
  it('a restart never reruns interrupted tasks', async () => {
    const { task } = board()
    const t = task()
    await settle()
    expect(started).toHaveLength(1)
    // restart: a new store over the same db reconciles before the dispatcher boots
    d.dispose()
    c = new HookedCompanyStore(new Store(db))
    c.reconcile()
    d = dispatcher(); c.hooks = d.hooks()
    await d.start(60_000)
    for (let i = 0; i < 10; i++) await d.tick()
    expect(started).toHaveLength(1)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'interrupted' })
  })
  it('an automatic start that fails parks the task (run_failed) instead of retrying every tick', async () => {
    const { profile, task } = board()
    db.prepare("UPDATE profiles SET adapter='shell' WHERE id=?").run(profile.id)
    const t = task()
    await settle()
    expect(started).toHaveLength(0)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'run_failed' })
    expect(c.detail(t.id).activity.at(-1)?.message).toContain('Could not start automatically')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(0)
  })
  it('a todo task saved while departments were off and still waiting on a dependency is locked, never parked run_failed', async () => {
    const { task } = board()
    enabled = false; c.setBoardEnabled(() => false)
    const dep = task({ title: 'Brief', status: 'backlog' })
    const t = task({ title: 'Post', dependencyIds: [dep.id] })
    expect(c.task(t.id).status).toBe('todo')
    enabled = true; c.setBoardEnabled(() => true)
    await d.pump(t.companyId)
    expect(started).toHaveLength(0)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'deps' })
  })
  it('a write that fails after the run started rolls back and cancels that run', async () => {
    const { task } = board({ autopilot: false })
    const t = task()
    const spy = vi.spyOn(c, 'patchInFlight').mockImplementationOnce(() => { throw new Error('disk full') })
    c.setAutopilot(t.companyId, true)
    await d.pump(t.companyId)
    spy.mockRestore()
    expect(started).toHaveLength(1)
    await settle()
    expect(canceled).toEqual([started[0].run.id])
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'run_failed', runId: null })
  })
  it('a failed turn drops the Claude conversation, so the next turn is a fresh full prompt rather than a dead --resume', async () => {
    const { task } = board()
    const t = task()
    await settle()
    d.sessionCaptured({ runId: started[0].run.id, agentSessionId: 'conv-gone' })
    expect(c.task(t.id).agentSessionId).toBe('conv-gone')
    end(started[0].run.id, 'failed', 'No conversation found')
    await settle()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'run_failed', agentSessionId: null })
    c.unpark(t.id)
    await d.pump(t.companyId)
    expect(started[1].opts.resumeSessionId).toBeNull()
    expect(started[1].target.kind === 'prompt' && started[1].target.prompt).toContain('Write the launch post')
  })
  it('with departments off a run end records no conversation to resume (plain tasks keep fresh prompts)', async () => {
    const { task } = board({ autopilot: false })
    const t = task()
    d.runNow(t.id)
    enabled = false
    d.sessionCaptured({ runId: started[0].run.id, agentSessionId: 'conv-1' })
    end(started[0].run.id, 'passed')
    expect(c.task(t.id).agentSessionId).toBeNull()
  })
  it('Pause all agents turns autopilot off for every company', async () => {
    const a = board(), b = board({ name: 'Beta' })
    expect(pauseAllAgents(c).sort()).toEqual([a.co.id, b.co.id].sort())
    const t = a.task()
    await d.tick()
    expect(c.task(t.id).status).toBe('todo')
    expect(d.pauseAll()).toEqual([])
  })
  it('at quit (dispose) the runs the engine cancels start nothing: no next task, no follow-up turn, no tick', async () => {
    const { task } = board()
    const t = task(), next = task({ title: 'Next' })
    await settle()
    expect(started.map(s => s.opts.taskId)).toEqual([t.id])
    c.activity(t.id, 'comment', 'One more thing', 'human')
    report(t.id)
    d.dispose()
    end(started[0].run.id, 'passed')
    await settle()
    await d.tick()
    await d.pump()
    expect(started).toHaveLength(1)
    expect(c.task(t.id)).toMatchObject({ status: 'in_review' })
    expect(c.task(t.id).pendingWake?.count).toBe(1)
    expect(c.task(next.id).status).toBe('todo')
  })
})

describe('autopilot safety audit', () => {
  it('a human Stop never turns into a follow-up turn, even when the agent had already reported and wakes are queued', async () => {
    const { task } = board()
    const t = task()
    await settle()
    c.activity(t.id, 'comment', 'Also add a CTA', 'human')
    report(t.id)
    // tasks:stop cancels the run; the agent's earlier report puts it in review
    end(started[0].run.id, 'canceled', 'Canceled by you')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(1)
    expect(c.task(t.id).status).toBe('in_review')
    expect(c.task(t.id).pendingWake?.count).toBe(1)
  })
  it('a failed or time-capped run never continues by itself, whatever the agent reported before it ended', async () => {
    const { task, seat } = board()
    const t = task()
    await settle()
    c.activity(t.id, 'comment', 'Ping', 'system')
    report(t.id, 'blocked')
    end(started[0].run.id, 'failed', 'exit 1')
    await settle()
    expect(started).toHaveLength(1)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'agent' })
    // the time cap: timeLimit marks the stop, then the engine cancels the run
    const other = seat('Editor')
    const u = task({ title: 'Capped', agentId: other.id })
    await settle()
    const run = runsOf(u.id)[0].run
    c.activity(u.id, 'comment', 'Ping', 'system')
    report(u.id)
    taskRunBridge({ company: () => c, dispatcher: () => d, toolset: () => null }).timeLimit!({ runId: run.id, taskId: u.id, minutes: 30 })
    end(run.id, 'canceled', 'Time limit reached (30 min)')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(runsOf(u.id)).toHaveLength(1)
  })
  it('the wake guard is a rolling hour: 5 automatic wakes within any 60 minutes park the task, across the window edge too', async () => {
    const { task } = board()
    const t = task()
    await settle()
    // wake 1 at 10:00; wakes 2-4 at 10:56-10:58, all inside the first hour
    for (const at of ['10:56', '10:57', '10:58', '11:01', '11:02']) {
      clock = new Date(`2026-10-20T${at}:00.000Z`)
      c.activity(t.id, 'comment', `At ${at}`, 'system')
      report(t.id)
      end(started.at(-1)!.run.id, 'passed')
      await settle()
    }
    // 10:56, 10:57, 10:58, 11:01 started (11:01 is only the 4th within the hour before it); 11:02 would be the 5th
    expect(started).toHaveLength(5)
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'limit' })
  })
  it('Pause all agents and pausing a seat stop follow-up turns of runs already in flight', async () => {
    const a = board(), b = board({ name: 'Beta' })
    const ta = a.task(), tb = b.task()
    await settle()
    expect(started).toHaveLength(2)
    c.activity(ta.id, 'comment', 'More', 'human'); c.activity(tb.id, 'comment', 'More', 'human')
    report(ta.id); report(tb.id)
    d.pauseAll()
    c.departments.pauseAgent(b.agent.id); c.setAutopilot(b.co.id, true)
    end(runsOf(ta.id)[0].run.id, 'passed'); end(runsOf(tb.id)[0].run.id, 'passed')
    for (let i = 0; i < 3; i++) await d.tick()
    expect(started).toHaveLength(2)
    expect([c.task(ta.id).status, c.task(tb.id).status]).toEqual(['in_review', 'in_review'])
  })
  it('maxInFlight holds when follow-ups and queued tasks compete at the same run end', async () => {
    const a = board({ autopilot: false })
    const seats = [a.agent, a.seat('Editor'), a.seat('Designer'), a.seat('Analyst')]
    const tasks = seats.flatMap(s => [a.task({ agentId: s.id }), a.task({ agentId: s.id, title: 'Second' })])
    c.setAutopilot(a.co.id, true, 2)
    await d.pump(a.co.id)
    const inFlight = () => (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND status='in_progress'").get(a.co.id) as { n: number }).n
    for (let round = 0; round < 12; round++) {
      const live = started.filter(s => c.task(s.opts.taskId!).status === 'in_progress' && c.task(s.opts.taskId!).runId === s.run.id)
      for (const s of live) { c.activity(s.opts.taskId!, 'comment', `Round ${round}`, 'system'); report(s.opts.taskId!) }
      for (const s of live) end(s.run.id, 'passed')
      await Promise.all([d.pump(), d.tick(), d.pump(a.co.id)])
      expect(inFlight()).toBeLessThanOrEqual(2)
    }
    expect(tasks.every(t => c.task(t.id).status !== 'done')).toBe(true)
  })
})

describe('DEPARTMENTS.md §4.4 interactive leases', () => {
  function fakeSessions() {
    const live = new Set<string>(); const created: Parameters<DispatcherSessions['create']>[0][] = []; let n = 0
    const sessions: DispatcherSessions = {
      create: req => {
        const id = `session_${++n}`
        db.prepare(`INSERT INTO sessions(id,title,profile_id,adapter,repo_id,cwd,status,cols,rows,started_at,artifacts_dir,log_path,company_id) VALUES(?,?,?,?,?,?,'running',80,24,?,?,?,?)`).run(id, req.title, req.profileId, 'claude', null, dir, new Date().toISOString(), dir, dir, req.companyId)
        live.add(id); created.push(req)
        return { id } as Session
      },
      isLive: id => live.has(id),
      kill: async id => { live.delete(id) }
    }
    return { sessions, live, created }
  }
  it('Open as session holds the lease, stamps sessions.task_id, prefills the prompt; closing without submit parks no_report', async () => {
    const f = fakeSessions(); d.dispose(); d = dispatcher({ sessions: f.sessions }); c.hooks = d.hooks()
    const { agent, task } = board({ autopilot: false })
    const t = task(), other = task({ title: 'Other' })
    const { task: held, session } = d.openSession(t.id, { cols: 100, rows: 30 })
    expect(held.status).toBe('in_progress')
    expect(f.created[0]).toMatchObject({ cols: 100, rows: 30, resumeAgentSessionId: null })
    expect(f.created[0].initialPrompt).toContain('Write the launch post')
    expect(db.prepare('SELECT task_id AS taskId FROM sessions WHERE id=?').get(session.id)).toEqual({ taskId: t.id })
    expect(d.leaseOf(t.id)).toBe(session.id)
    // the agent works on another task beside the session (a headless run of its own)
    expect(d.runNow(other.id)).toMatchObject({ status: 'in_progress', agentId: agent.id })
    d.checkSessions()
    expect(c.task(t.id).status).toBe('in_progress')
    f.live.delete(session.id)
    d.checkSessions()
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'no_report' })
  })
  it('Submit for review ends the lease in review; Park and Stop park it', async () => {
    const f = fakeSessions(); d.dispose(); d = dispatcher({ sessions: f.sessions }); c.hooks = d.hooks()
    const { task } = board({ autopilot: false })
    const a = task(), b = task({ title: 'B' }), s = task({ title: 'S' })
    d.openSession(a.id, { cols: 80, rows: 24 })
    expect(d.submitSession(a.id).status).toBe('in_review')
    d.openSession(b.id, { cols: 80, rows: 24 })
    expect(d.parkSession(b.id)).toMatchObject({ status: 'blocked', blockReason: 'no_report' })
    const { session } = d.openSession(s.id, { cols: 80, rows: 24 })
    expect(await d.stop(s.id)).toMatchObject({ status: 'blocked', blockReason: 'no_report' })
    expect(f.live.has(session.id)).toBe(false)
    expect(() => d.submitSession(a.id)).toThrow('not open as a session')
  })
  it('Take over keeps the seat: the canceled run end never hands the agent its next queued task', async () => {
    const f = fakeSessions(); d.dispose()
    d = new Dispatcher({ company: c, startRun, cancelRun: async id => { canceled.push(id); end(id, 'canceled', 'Canceled'); await settle() }, enabled: () => enabled, sessions: f.sessions, now: () => clock })
    c.hooks = d.hooks()
    const { task } = board()
    const t = task(), next = task({ title: 'Next' })
    await settle()
    expect(started).toHaveLength(1)
    const { task: held } = await d.takeover(t.id, { cols: 80, rows: 24 })
    expect(held.status).toBe('in_progress')
    expect(c.task(next.id).status).toBe('todo')
    expect(started).toHaveLength(1)
  })
  it('Take over is refused before canceling when no session can open', async () => {
    const { task } = board()
    const t = task()
    await settle()
    await expect(d.takeover(t.id, { cols: 80, rows: 24 })).rejects.toThrow('not available')
    expect(canceled).toEqual([])
    expect(c.task(t.id).status).toBe('in_progress')
  })
  it('Take over cancels the headless run without a follow-up and opens a session resuming its conversation', async () => {
    const f = fakeSessions(); d.dispose(); d = dispatcher({ sessions: f.sessions }); c.hooks = d.hooks()
    const { task } = board()
    const t = task()
    await settle()
    d.sessionCaptured({ runId: started[0].run.id, agentSessionId: 'conv-9' })
    c.activity(t.id, 'comment', 'Shorter please', 'human')
    report(t.id)
    const { task: held, session } = await d.takeover(t.id, { cols: 80, rows: 24 })
    expect(canceled).toEqual([started[0].run.id])
    expect(started).toHaveLength(1)
    expect(held.status).toBe('in_progress')
    expect(d.leaseOf(t.id)).toBe(session.id)
    expect(f.created[0].resumeAgentSessionId).toBe('conv-9')
    expect(f.created[0].initialPrompt).toContain('Taken over')
    expect(f.created[0].initialPrompt).toContain('Shorter please')
  })
})

describe('DEPARTMENTS.md §1.2, §5: runs.task_id / agent_id and asks.task_id', () => {
  it('the engine store persists the task link and reads a task run back with trigger task; live asks get asks.task_id', () => {
    const { agent, task } = board({ autopilot: false })
    const t = task()
    const es = createEngineStore(db, { describe: () => () => '' })
    const run: Run = { id: 'run_link1', kind: 'prompt', title: 'Task', target: { kind: 'prompt', profileId: agent.refId, repoId: null, prompt: 'x' }, workflowId: null, scheduleId: null, parentRunId: null,
      trigger: 'task' as Run['trigger'], status: 'queued', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: dir, artifactCount: 0 }
    es.insertRun(run, null, { taskId: t.id, agentId: agent.id })
    expect(db.prepare('SELECT trigger, trigger_ext AS ext, task_id AS taskId, agent_id AS agentId FROM runs WHERE id=?').get(run.id)).toEqual({ trigger: 'manual', ext: 'task', taskId: t.id, agentId: agent.id })
    const back = es.getRun(run.id)!
    expect(back.trigger).toBe('task')
    expect(runTaskLink(back)).toEqual({ taskId: t.id, agentId: agent.id })
    expect(es.updateRun(run.id, { status: 'running' }).trigger).toBe('task')
    // a run without a task keeps no link
    es.insertRun({ ...run, id: 'run_plain', trigger: 'manual' }, null)
    expect(runTaskLink(es.getRun('run_plain')!)).toBeNull()
    const live = new LiveStore(db)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO agents(id,kind,root_id,run_id,provider,cwd,title,status,started_at,updated_at) VALUES('ag_1','step','ag_1',?,'claude',?,'Task','working',?,?)`).run(run.id, dir, now, now)
    const ask = live.insertAsk({ id: 'ask_1', agentId: 'ag_1', rootId: 'ag_1', sessionId: null, runId: run.id, stepId: null, provider: 'claude', kind: 'permission', channel: 'stdio', title: 'Bash', detail: null, toolName: 'Bash', toolInput: null, question: null, options: [], status: 'open', answer: null, answeredVia: null, createdAt: now, answeredAt: null, expiresAt: null })
    expect(db.prepare('SELECT task_id AS taskId FROM asks WHERE id=?').get('ask_1')).toEqual({ taskId: t.id })
    expect((ask as { taskId?: string }).taskId).toBe(t.id)
  })
  it('the task run bridge resolves the company, the seat time cap and parks a capped run with limit', () => {
    const { co, agent, task } = board({ autopilot: false })
    const t = task()
    const bridge = taskRunBridge({ company: () => c, dispatcher: () => null, toolset: () => req => ({ env: { HIVE_TASK_ID: req.taskId }, toolNames: ['task_report'] }), passport: (companyId, departmentId) => `${companyId}/${departmentId}` })
    expect(bridge.companyOf(t.id)).toBe(co.id)
    expect(bridge.passportContext!({ taskId: t.id, companyId: co.id })).toBe(`${co.id}/${t.departmentId}`)
    expect(bridge.companyOf('task_missing')).toBeNull()
    expect(bridge.runMinutes!(agent.id)).toBe(30)
    expect(bridge.toolset!({ runId: 'r', taskId: t.id, agentId: agent.id, stepId: 's', adapter: 'claude', companyId: co.id })).toEqual({ env: { HIVE_TASK_ID: t.id }, toolNames: ['task_report'] })
    d.runNow(t.id)
    bridge.sessionCaptured!({ runId: started[0].run.id, taskId: t.id, adapter: 'claude', agentSessionId: 'conv-x' })
    expect(c.task(t.id).agentSessionId).toBe('conv-x')
    bridge.timeLimit!({ runId: started[0].run.id, taskId: t.id, minutes: 30 })
    end(started[0].run.id, 'canceled', 'Time limit reached (30 min)')
    expect(c.task(t.id)).toMatchObject({ status: 'blocked', blockReason: 'limit' })
  })
})

describe('integration follow-ups', () => {
  it('the claim checks the task JSON too: a row an older build moved (JSON only) is never started again', async () => {
    const { co, task } = board({ autopilot: false })
    const t = task()
    // an older build started it: data says in_progress, the status mirror still says todo (§11)
    db.prepare("UPDATE company_tasks SET data=json_set(data,'$.status','in_progress') WHERE id=?").run(t.id)
    c.setAutopilot(co.id, true)
    await d.pump(co.id)
    expect(started).toHaveLength(0)
  })
  it('an unrouted triage task edited again gets one "Not routed" line per reason', async () => {
    const { co } = board({ autopilot: false })
    // a second department makes rule 2 ambiguous, so the task stays in triage
    c.departments.save({ companyId: co.id, name: 'Support' })
    const t = c.createTask({ title: 'Hmm', description: '', companyId: co.id, repoId: null, status: 'triage', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: null, agentId: null })
    await settle()
    const notRouted = () => c.detail(t.id).activity.filter(a => a.message.startsWith('Not routed')).length
    expect(notRouted()).toBe(1)
    c.updateTask(t.id, { title: 'Hmm, again' })
    c.updateTask(t.id, { description: 'still unclear' })
    await settle()
    expect(notRouted()).toBe(1)
  })
  it('a profile or workflow backing an active seat cannot be deleted out from under it', () => {
    const { agent, profile } = board({ autopilot: false })
    expect(() => c.departments.assertNotBacking('profile', profile.id)).toThrow(/backs the agent Copywriter/)
    c.departments.archiveAgent(agent.id)
    expect(() => c.departments.assertNotBacking('profile', profile.id)).not.toThrow()
  })
})
