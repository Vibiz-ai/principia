import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { Dispatcher, HookedCompanyStore } from './dispatcher'
import { BriefStore } from './brief'
import { PlanStore, draftFromJson } from './plans'
import { PlanPilot, stopLine, type GateVerdict } from './planPilot'
import { milestoneNote, NOTE_LIMITS } from './planPrompt'
import type { PlanWork } from './planWork'
import type { TaskPr, TaskWork } from '../../shared/taskWork'
import { briefOf, openPrInstructions, touchesOverlap, type Plan, type PlanAutonomy } from '../../shared/plans'
import type { StartRunOptions } from '../../shared/engine'
import type { Run, RunTarget } from '../../shared/types'

let db: DB; let store: Store; let c: HookedCompanyStore; let dir: string; let d: Dispatcher; let plans: PlanStore; let pilot: PlanPilot; let briefs: BriefStore
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let seq = 0
let draftAnswer = ''
let verdict: GateVerdict = { result: 'pass', notes: 'All criteria hold.', evidence: ['pf_1'], fixTasks: [] }
let gateCalls = 0

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_p${++seq}`
  const createdAt = new Date(Date.now() + seq).toISOString()
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), createdAt, dir, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt, startedAt: createdAt, endedAt: null, artifactsDir: dir, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}
let ensured: { key: string; taskId: string; from: string[] }[] = []
let collected: string[][] = []
let published: { taskId: string; base: string; title: string; body: string }[] = []
let cleaned: string[] = []
let duringEnsure: (() => void) | null = null
const PR = (state: TaskPr['state'] = 'OPEN'): TaskPr => ({ number: 7, url: 'https://github.com/acme/app/pull/7', state, isDraft: false, reviewDecision: null, mergedAt: state === 'MERGED' ? '2026-10-25T03:00:00Z' : null, checkedAt: '2026-10-25T02:00:00Z', base: 'main' })
let publishAnswer: () => Awaited<ReturnType<PlanWork['publish']>> = () => ({ pushed: true, pr: PR(), gh: 'ok', error: null })
/** "M1 · Worktree binding" -> hive/plan-m1 (the fake binding's branch) */
const branchOf = (taskId: string) => `hive/plan-${c.task(taskId).title.split(' ')[0].toLowerCase()}`
/** what TaskWorkService.bind writes on the milestone task (the WORKTREE.md binding), as a stand-in */
function setWork(taskId: string, patch: Partial<TaskWork>): void {
  const cur = c.task(taskId).work
  const w: TaskWork = { repoId: c.task(taskId).repoId!, worktreePath: '', branch: branchOf(taskId), baseSha: 'abc', baseRef: 'origin/main', pr: null, startedAt: '2026-10-25T00:00:00Z', worktreeId: 'worktree_1', queuedAt: null, goneAt: null, removedAt: null, gh: null, reviewSeenAt: null, readySeen: null, conflict: false, error: null, ...(cur ?? {}), ...patch }
  db.prepare("UPDATE company_tasks SET data=json_set(data,'$.work',json(?)) WHERE id=?").run(JSON.stringify(w), taskId)
}
const work: PlanWork = {
  ensure: async (taskId, from, label) => {
    ensured.push({ key: label, taskId, from })
    duringEnsure?.()
    const p = path.join(dir, 'worktrees', label.toLowerCase()); fs.mkdirSync(p, { recursive: true })
    if (!c.task(taskId).work) setWork(taskId, { worktreePath: p, baseRef: from.length ? branchOf(from[0]) : 'origin/main' })
    return { path: p, branch: branchOf(taskId) }
  },
  diff: async () => 'src/a.ts | 2 +-',
  commitLeftovers: async () => false,
  collect: async (leaves) => { collected.push(leaves.map(branchOf)); return { taskId: leaves[0], branch: branchOf(leaves[0]) } },
  publish: async (taskId, q) => { published.push({ taskId, ...q }); const out = publishAnswer(); if (out.pr) setWork(taskId, { pr: out.pr }); return out },
  cleanup: async (taskId) => { cleaned.push(taskId) }
}
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'principia-plans-')))
  db = openDatabase(path.join(dir, 'test.db')); store = new Store(db); c = new HookedCompanyStore(store)
  started = []; gateCalls = 0; ensured = []; collected = []; published = []; cleaned = []; duringEnsure = null
  publishAnswer = () => ({ pushed: true, pr: PR(), gh: 'ok', error: null })
  verdict = { result: 'pass', notes: 'All criteria hold.', evidence: ['pf_1'], fixTasks: [] }
  d = new Dispatcher({ company: c, startRun, cancelRun: async () => undefined, enabled: () => true })
  c.hooks = d.hooks()
  briefs = new BriefStore(() => c)
  plans = new PlanStore({ company: () => c })
  pilot = new PlanPilot({
    plans, company: () => c, startRun, enabled: () => true, work,
    draftCall: () => async () => draftAnswer,
    gateCall: () => async () => { gateCalls++; return JSON.stringify(verdict) }
  })
})
afterEach(() => { pilot.dispose(); d.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const flush = () => new Promise(r => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 12; i++) { await flush(); await pilot.pump() } }

function company() {
  const repoDir = path.join(dir, 'repo'); fs.mkdirSync(repoDir, { recursive: true })
  const [repo] = store.addRepo(repoDir)
  const co = c.create({ name: 'Acme', repoIds: [repo.id] })
  const dev = c.departments.save({ companyId: co.id, name: 'Development', key: 'development' })
  const profile = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const head = c.departments.saveAgent({ companyId: co.id, departmentId: dev.id, kind: 'profile', refId: profile.id, name: 'Builder', data: { autonomy: 'manual' } })
  const second = c.departments.saveAgent({ companyId: co.id, departmentId: dev.id, kind: 'profile', refId: profile.id, name: 'Tester', data: { autonomy: 'manual' } })
  return { co, repo, head, second, profile }
}
const twoMilestones = (o: { parallel?: boolean; touches?: [string, string]; agent2?: string } = {}) => JSON.stringify({
  summary: 'Worktrees first, then the Plans view.',
  milestones: [
    { key: 'M1', title: 'Worktree binding', passCriteria: ['Unit tests pass'], tasks: [
      { key: 'T1', title: 'Bind tasks to worktrees', goal: 'Each task runs in a worktree', criteria: ['A run record names the worktree'], touches: [o.touches?.[0] ?? 'src/main/worktrees.ts'] },
      { key: 'T2', title: 'Clean up worktrees', goal: 'Removed after merge', criteria: ['No leftovers'], blockers: ['T1'], touches: ['src/main/worktrees.ts'] }
    ] },
    { key: 'M2', title: 'Plans view', dependsOn: o.parallel ? [] : ['M1'], passCriteria: ['Screenshot of the view'], agent: o.agent2 ?? null, tasks: [
      { key: 'T3', title: 'Draw the graph', goal: 'Milestones as frames', criteria: ['Blockers are dashed'], touches: [o.touches?.[1] ?? 'src/renderer/src/views/PlansView.tsx'] }
    ] }
  ]
})
async function approved(autonomy: PlanAutonomy, draft = twoMilestones()): Promise<{ plan: Plan; co: ReturnType<typeof company> }> {
  const co = company()
  draftAnswer = draft
  const p = plans.create({ companyId: co.co.id, goal: 'Run tasks in worktrees and show plans', autonomy })
  await pilot.draft(p.id)
  pilot.approve(p.id)
  await settle()
  return { plan: plans.get(p.id), co }
}
const taskOf = (p: Plan, key: string) => c.task(p.tasks[Number(key.slice(1)) - 1].taskId!)
const runsOf = (taskId: string) => started.filter(s => s.opts.taskId === taskId)
/** The agent reports review (and its conversation id is captured), then the run passes. */
function finish(taskId: string, sessionId = 'sess_m1', status: Run['status'] = 'passed') {
  const r = runsOf(taskId).at(-1)!.run
  if (status === 'passed') {
    d.sessionCaptured({ runId: r.id, agentSessionId: sessionId })
    c.patchInFlight(taskId, { report: { outcome: 'review', summary: `Done ${taskId}`, evidence: [], at: new Date().toISOString() } })
  }
  db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, r.id)
  d.onRunUpdated({ ...r, status })
  briefs.fillHandoff(taskId, r.createdAt)
  pilot.onRunUpdated({ ...r, status })
}

describe('PLANS.md §2 drafts and approval', () => {
  it('a new plan gets a draft with milestones and tasks; the Board does not change until Approve', async () => {
    const { co } = { co: company() }
    draftAnswer = '```json\n' + twoMilestones() + '\n```'
    const before = c.listTasks(co.co.id).length
    const p = plans.create({ companyId: co.co.id, goal: 'Run tasks in worktrees', autonomy: 'checkins' })
    expect(p).toMatchObject({ status: 'draft', drafting: true, headAgentId: co.head.id, repoId: co.repo.id })
    await pilot.draft(p.id)
    const draft = plans.get(p.id)
    expect(draft.drafting).toBe(false)
    expect(draft.milestones.map(m => m.key)).toEqual(['M1', 'M2'])
    expect(draft.tasks).toHaveLength(3)
    expect(draft.milestones[1].dependsOn).toEqual([draft.milestones[0].id])
    expect(draft.tasks[1].blockers).toEqual([draft.tasks[0].id])
    expect(c.listTasks(co.co.id).length).toBe(before)
    expect(pilot.detail(p.id).turn.text).toBe('Your turn: read the draft and approve it, or discard it.')

    pilot.approve(p.id)
    const after = plans.get(p.id)
    const board = c.listTasks(co.co.id)
    // 2 milestone tasks + 3 tasks
    expect(board.length).toBe(before + 5)
    const m1 = c.task(after.milestones[0].taskId!)
    const t1 = c.task(after.tasks[0].taskId!), t2 = c.task(after.tasks[1].taskId!)
    expect(m1.title).toBe('M1 · Worktree binding')
    expect(t1).toMatchObject({ parentId: m1.id, source: 'agent', status: 'backlog', agentId: co.head.id, plan: { planId: p.id, role: 'task' } })
    expect(t2.dependencyIds).toEqual([t1.id])
    expect(briefOf(t1)).toMatchObject({ goal: 'Each task runs in a worktree' })
    expect(briefOf(t1).criteria[0]).toMatchObject({ id: 'c1', text: 'A run record names the worktree', state: 'open' })
    expect(briefOf(t1).context).toContain('src/main/worktrees.ts')
  })
  it('a broken draft says why and never touches the Board; a draft can be discarded', async () => {
    const { co } = company() as unknown as { co: ReturnType<typeof company>['co'] }
    draftAnswer = 'Sorry, I cannot.'
    const p = plans.create({ companyId: co.id, goal: 'Do things', autonomy: 'checkins' })
    await pilot.draft(p.id)
    expect(plans.get(p.id)).toMatchObject({ drafting: false, draftError: expect.stringContaining('JSON') })
    expect(() => pilot.approve(p.id)).toThrow('no milestones')
    pilot.discard(p.id)
    expect(plans.list(co.id)).toHaveLength(0)
  })
  it('draft references are checked: cycles are refused', () => {
    const cyc = { milestones: [{ title: 'A', dependsOn: ['M2'], tasks: [{ title: 'x' }] }, { title: 'B', dependsOn: ['M1'], tasks: [{ title: 'y' }] }] }
    expect(() => draftFromJson(cyc, [], null)).toThrow('circle')
    expect(touchesOverlap(['src/main/**'], ['src/main/worktrees.ts'])).toBe(true)
    expect(touchesOverlap(['src/main/a.ts'], ['src/renderer/**'])).toBe(false)
  })
})

describe('PLANS.md §2 the pilot', () => {
  it('Check-ins: the M1 agent starts alone, keeps its worktree and session across tasks, and M2 waits for the founder\'s Pass', async () => {
    const { plan } = await approved('checkins')
    const t1 = taskOf(plan, 'T1'), t2 = taskOf(plan, 'T2'), t3 = taskOf(plan, 'T3')
    expect(started.map(s => s.opts.taskId)).toEqual([t1.id])
    expect(c.task(t3.id).status).toBe('backlog')
    const first = started[0].target as Extract<RunTarget, { kind: 'prompt' }>
    // the milestone's worktree is its milestone task's binding (no worktree of the pilot's own, no cwd on the target)
    expect(ensured).toEqual([{ key: 'M1', taskId: plan.milestones[0].taskId, from: [] }])
    expect(plans.get(plan.id).milestones[0].worktree).toEqual({ path: path.join(dir, 'worktrees', 'm1'), branch: 'hive/plan-m1' })
    expect('cwd' in first).toBe(false)
    expect(first.prompt).toContain('Plan: Run tasks in worktrees')
    expect(first.prompt).toContain('run only the tests that cover the files you change')
    expect(pilot.detail(plan.id).turn.text).toMatch(/^M1 agent \(\w+\) is working on [A-Z][A-Z0-9]{1,4}-\d+\./)

    finish(t1.id)
    await settle()
    // the same milestone agent, the same worktree, resuming the same conversation
    expect(started.map(s => s.opts.taskId)).toEqual([t1.id, t2.id])
    const second = started[1]
    expect(new Set(ensured.filter(e => e.key === 'M1').map(e => e.taskId))).toEqual(new Set([plan.milestones[0].taskId]))
    expect(second.opts.resumeSessionId).toBe('sess_m1')
    const resumed = (second.target as Extract<RunTarget, { kind: 'prompt' }>).prompt
    expect(resumed).toContain(`Next task: ${t2.identifier}`)
    expect(resumed).toContain('Goal: Removed after merge')
    expect(resumed).toContain('this is the last task of M1. Run the full test suite')
    // the run records say it too
    const rows = db.prepare('SELECT target_json FROM runs WHERE task_id IN (?,?) ORDER BY created_at').all(t1.id, t2.id) as { target_json: string }[]
    expect(rows.map(r => JSON.parse(r.target_json).cwd)).toEqual([undefined, undefined])
    // the handoff came from the report, by system
    expect(briefOf(c.task(t1.id)).handoff).toContain('Done')

    finish(t2.id)
    await settle()
    expect(gateCalls).toBe(1)
    const d1 = pilot.detail(plan.id)
    expect(d1.plan.milestones[0].gate).toMatchObject({ result: 'pass', evidence: ['pf_1'] })
    expect(d1.turn.text).toBe('Your turn: pass Milestone 1 or send it back.')
    expect(d1.turn.action).toEqual({ kind: 'pass', milestoneId: plan.milestones[0].id })
    expect(runsOf(t3.id)).toHaveLength(0)
    await settle()
    expect(runsOf(t3.id)).toHaveLength(0)

    pilot.pass(plan.id, plan.milestones[0].id)
    await settle()
    expect(c.task(t1.id).status).toBe('done')
    expect(c.task(t2.id).status).toBe('done')
    expect(c.task(plan.milestones[0].taskId!).status).toBe('done')
    expect(runsOf(t3.id)).toHaveLength(1)
    // M2 has its own worktree and a fresh conversation
    expect(ensured.at(-1)).toEqual({ key: 'M2', taskId: plan.milestones[1].taskId, from: [plan.milestones[0].taskId] })
    expect(plans.get(plan.id).milestones[1].worktree?.path).toMatch(/m2$/)
    expect(runsOf(t3.id)[0].opts.resumeSessionId ?? null).toBeNull()
  })
  it('Step by Step: nothing starts until Start is clicked', async () => {
    const { plan } = await approved('step')
    await settle()
    expect(started).toHaveLength(0)
    const t1 = taskOf(plan, 'T1')
    expect(pilot.detail(plan.id).turn).toMatchObject({ text: `Your turn: start ${t1.identifier}.`, action: { kind: 'start', taskId: t1.id } })
    await expect(pilot.startNow(plan.id, taskOf(plan, 'T3').id)).rejects.toThrow('M2 waits')
    await pilot.startNow(plan.id, t1.id)
    expect(started.map(s => s.opts.taskId)).toEqual([t1.id])
    finish(t1.id)
    await settle()
    expect(started).toHaveLength(1)
  })
  it('Autopilot: a failing gate stops the plan, adds fix tasks under the milestone and says why', async () => {
    verdict = { result: 'fail', notes: 'The cleanup leaves worktrees behind.', evidence: [], fixTasks: [{ title: 'Remove leftover worktrees', goal: 'No worktree stays after merge', criteria: ['git worktree list is clean'], touches: ['src/main/worktrees.ts'] }] }
    const { plan } = await approved('autopilot')
    finish(taskOf(plan, 'T1').id)
    await settle()
    finish(taskOf(plan, 'T2').id)
    await settle()
    const det = pilot.detail(plan.id)
    expect(det.plan.halted?.reason).toBe('M1 failed its check: the cleanup leaves worktrees behind.')
    expect(det.turn.text).toMatch(/^Your turn: M1 failed its check/)
    expect(det.turn.action).toEqual({ kind: 'resume' })
    const fix = det.plan.tasks.find(t => t.fix)!
    const fixRow = c.task(fix.taskId!)
    expect(fixRow).toMatchObject({ title: 'Remove leftover worktrees', parentId: plan.milestones[0].taskId, status: 'backlog' })
    expect(det.plan.changes.at(-1)!.text).toContain('Added 1 fix task')
    // stopped: nothing new starts, M2 neither
    await settle()
    expect(runsOf(fixRow.id)).toHaveLength(0)
    expect(runsOf(taskOf(plan, 'T3').id)).toHaveLength(0)
    // resume runs the fix in the milestone's session; then the gate passes and Autopilot moves on by itself
    verdict = { result: 'pass', notes: 'Clean now.', evidence: ['test: 40 passed'], fixTasks: [] }
    pilot.resume(plan.id)
    await settle()
    expect(runsOf(fixRow.id)).toHaveLength(1)
    expect(runsOf(fixRow.id)[0].opts.resumeSessionId).toBe('sess_m1')
    finish(fixRow.id)
    await settle()
    expect(runsOf(taskOf(plan, 'T3').id)).toHaveLength(1)
    // Autopilot never marks tasks done: they wait in review for the founder
    expect(c.task(taskOf(plan, 'T1').id).status).toBe('in_review')
  })
  it('after a failed gate the founder can pass it anyway: unstarted fix tasks are canceled and the plan moves on', async () => {
    verdict = { result: 'fail', notes: 'Missing screenshot. Rest is fine.', evidence: [], fixTasks: [{ title: 'Add the screenshot', goal: 'Attach it', criteria: [], touches: [] }] }
    const { plan } = await approved('autopilot')
    finish(taskOf(plan, 'T1').id); await settle()
    finish(taskOf(plan, 'T2').id); await settle()
    const fix = plans.get(plan.id).tasks.find(t => t.fix)!
    pilot.pass(plan.id, plan.milestones[0].id, 'Good enough for now')
    await settle()
    expect(c.task(fix.taskId!).status).toBe('canceled')
    expect(plans.get(plan.id).halted).toBeNull()
    expect(c.task(taskOf(plan, 'T1').id)).toMatchObject({ status: 'done', doneNote: 'Good enough for now' })
    expect(runsOf(taskOf(plan, 'T3').id)).toHaveLength(1)
  })
  it('Pass Anyway with no note says the founder overrode the failed check (QA)', async () => {
    verdict = { result: 'fail', notes: 'The first criterion holds. The second criterion does not hold.', evidence: [], fixTasks: [] }
    const { plan } = await approved('autopilot')
    finish(taskOf(plan, 'T1').id); await settle()
    finish(taskOf(plan, 'T2').id); await settle()
    expect(plans.get(plan.id).halted?.reason).toBe('M1 failed its check: the second criterion does not hold.')
    pilot.pass(plan.id, plan.milestones[0].id)
    await settle()
    expect(c.task(taskOf(plan, 'T1').id).doneNote).toMatch(/^Passed by you over a failed check \(M1\): The first criterion holds/)
  })
  it('a pass without evidence is recorded as a fail (no rubber stamps)', async () => {
    verdict = { result: 'pass', notes: 'Looks fine.', evidence: [], fixTasks: [] }
    const { plan } = await approved('checkins')
    finish(taskOf(plan, 'T1').id); await settle()
    finish(taskOf(plan, 'T2').id); await settle()
    const m = plans.get(plan.id).milestones[0]
    expect(m.gate.result).toBe('fail')
    expect(m.gate.notes).toContain('cited no evidence')
  })
  it('a failed turn drops the milestone session (dead or compacted conversation): the next task starts fresh from the briefs', async () => {
    const { plan } = await approved('checkins')
    const t1 = taskOf(plan, 'T1'), t2 = taskOf(plan, 'T2')
    finish(t1.id)
    await settle()
    expect(started[1].opts.resumeSessionId).toBe('sess_m1')
    finish(t2.id, 'sess_m1', 'failed')
    expect(plans.get(plan.id).milestones[0].sessionId).toBeNull()
    // the founder unparks it; the pilot restarts it with the full prompt (brief + previous handoff in the board context)
    c.unpark(t2.id)
    await settle()
    const again = runsOf(t2.id).at(-1)!
    expect(again.opts.resumeSessionId ?? null).toBeNull()
    const prompt = (again.target as Extract<RunTarget, { kind: 'prompt' }>).prompt
    expect(prompt).toContain('<principia-task')
    expect(prompt).toContain('Goal: Removed after merge')
  })
  it('parallel milestones: each agent is told what runs beside it; overlapping touches run one after the other', async () => {
    const { plan, co } = await approved('checkins', twoMilestones({ parallel: true, agent2: 'Tester' }))
    void co
    const t1 = taskOf(plan, 'T1'), t3 = taskOf(plan, 'T3')
    expect(new Set(started.map(s => s.opts.taskId))).toEqual(new Set([t1.id, t3.id]))
    const p1 = (runsOf(t1.id)[0].target as Extract<RunTarget, { kind: 'prompt' }>).prompt
    const p3 = (runsOf(t3.id)[0].target as Extract<RunTarget, { kind: 'prompt' }>).prompt
    // each names the other's files
    expect(p3).toMatch(/M1 agent \(\w+\) is working on [A-Z][A-Z0-9]{1,4}-\d+ and edits src\/main\/worktrees\.ts; avoid those files/)
    expect(p1).toContain('src/renderer/src/views/PlansView.tsx')
  })
  it('parallel milestones whose touches overlap do not run side by side', async () => {
    const { plan } = await approved('checkins', twoMilestones({ parallel: true, agent2: 'Tester', touches: ['src/main/**', 'src/main/plans.ts'] }))
    expect(started.map(s => s.opts.taskId)).toEqual([taskOf(plan, 'T1').id])
    expect(pilot.detail(plan.id).waits).toEqual({ [plan.milestones[1].id]: expect.stringMatching(new RegExp(`^waits: M1 agent \\(\\w+\\) edits the same files \\(${taskOf(plan, 'T1').identifier}\\)$`)) })
  })
  it('an independent milestone whose agent is on another milestone starts beside it, each in its own worktree', async () => {
    const { plan } = await approved('autopilot', twoMilestones({ parallel: true, touches: ['a.ts', 'b.ts'] }))
    const t1 = taskOf(plan, 'T1'), t3 = taskOf(plan, 'T3')
    expect(started.map(s => s.opts.taskId)).toEqual([t1.id, t3.id])
    expect(c.task(t1.id).agentId).toBe(c.task(t3.id).agentId)
    expect(new Set(ensured.map(e => e.key))).toEqual(new Set([plan.milestones[0].key, plan.milestones[1].key]))
    expect(pilot.detail(plan.id).waits?.[plan.milestones[1].id]).toBeUndefined()
  })
  it('two plans whose touches overlap run one after the other', async () => {
    const { plan, co } = await approved('checkins')
    draftAnswer = twoMilestones()
    const other = plans.create({ companyId: co.co.id, goal: 'Another pass at worktrees', autonomy: 'checkins' })
    await pilot.draft(other.id)
    pilot.approve(other.id)
    await settle()
    const det = pilot.detail(other.id)
    expect(det.turn.text).toMatch(/^Waiting: another plan edits the same files/)
    expect(started.every(s => plan.tasks.some(t => t.taskId === s.opts.taskId))).toBe(true)
  })
  it('Send Back adds a fix task with the note; its gate is checked again after it', async () => {
    const { plan } = await approved('checkins')
    finish(taskOf(plan, 'T1').id); await settle()
    finish(taskOf(plan, 'T2').id); await settle()
    pilot.sendBack(plan.id, plan.milestones[0].id, 'Name the branches after the task')
    await settle()
    const p = plans.get(plan.id)
    const fix = p.tasks.find(t => t.fix)!
    expect(c.task(fix.taskId!).title).toBe('Fix M1: Name the branches after the task')
    expect(runsOf(fix.taskId!)).toHaveLength(1)
  })
})

describe('PLANS.md risk 1: the milestone note stays short', () => {
  it('is capped even with a long brief and many neighbours', () => {
    const note = milestoneNote({
      plan: { goal: 'g'.repeat(500) }, milestone: { key: 'M1', title: 't'.repeat(300) }, task: { identifier: 'PRN-1', title: 'x'.repeat(300), touches: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`) },
      index: 1, total: 3, resumed: true, brief: 'b'.repeat(9000), beside: Array.from({ length: 10 }, (_, i) => ({ label: `M${i}`, identifier: `PRN-${i}`, touches: ['a', 'b'] })), cwd: '/tmp/x', branch: 'hive/x', last: false
    })
    expect(note.length).toBeLessThanOrEqual(NOTE_LIMITS.total)
    const plain = milestoneNote({ plan: { goal: 'Ship it' }, milestone: { key: 'M1', title: 'One' }, task: { identifier: 'PRN-1', title: 'A', touches: [] }, index: 1, total: 2, resumed: false, brief: null, beside: [], cwd: null, branch: null, last: false })
    expect(plain.length).toBeLessThan(260)
  })
})

describe('PLANS.md §2 draft keys', () => {
  it('task keys that restart per milestone resolve inside their own milestone', () => {
    const d = draftFromJson({ milestones: [
      { title: 'A', tasks: [{ key: 'T1', title: 'a1' }, { key: 'T2', title: 'a2', blockers: ['T1'] }] },
      { title: 'B', dependsOn: ['M1'], tasks: [{ key: 'T1', title: 'b1' }, { key: 'T2', title: 'b2', blockers: ['T1'] }] }
    ] }, [], null)
    const [a1, a2, b1, b2] = d.tasks
    expect(a2.blockers).toEqual([a1.id])
    expect(b2.blockers).toEqual([b1.id])
  })
})

const threeMilestones = () => JSON.stringify({
  summary: 'Two parts, then the join.',
  milestones: [
    { key: 'M1', title: 'Part one', passCriteria: ['ok'], tasks: [{ key: 'T1', title: 'One', touches: ['one.ts'] }] },
    { key: 'M2', title: 'Part two', passCriteria: ['ok'], agent: 'Tester', tasks: [{ key: 'T1', title: 'Two', touches: ['two.ts'] }] },
    { key: 'M3', title: 'Join', dependsOn: ['M1', 'M2'], passCriteria: ['ok'], tasks: [{ key: 'T1', title: 'Join them', touches: ['join.ts'] }] }
  ]
})

describe('PLANS.md §2.4 QA fixes: a plan task never runs in the founder\'s checkout', () => {
  it('Run now on the Board goes through the pilot: milestone worktree, milestone note; a direct start is refused', async () => {
    const { plan } = await approved('step')
    const t1 = taskOf(plan, 'T1')
    // the Board's Run now path (Dispatcher.runNow → CompanyStore.startTask) refuses a plan task
    expect(() => d.runNow(t1.id)).toThrow(/belongs to a plan\. Start it from the plan/)
    expect(() => d.runNow(plan.milestones[0].taskId!)).toThrow(/holds a plan milestone/)
    expect(started).toHaveLength(0)
    // tasks:start calls this for a plan task
    const out = await pilot.startFromBoard(t1.id)
    expect(out.status).toBe('in_progress')
    const target = started[0].target as Extract<RunTarget, { kind: 'prompt' }>
    expect(plans.get(plan.id).milestones[0].worktree?.path).toMatch(/worktrees\/m1$/)
    expect(target.prompt).toContain('Plan: Run tasks in worktrees')
    expect(plans.get(plan.id).milestones[0].worktree?.branch).toBe('hive/plan-m1')
    await expect(pilot.startFromBoard(plan.milestones[0].taskId!)).rejects.toThrow(/holds a milestone/)
  })
  it('the dispatcher never picks a plan task in To do (an answered ask), even with Autopilot on and an auto seat; the pilot runs it in the worktree with the answer', async () => {
    const { plan, co } = await approved('checkins')
    c.setAutopilot(co.co.id, true)
    c.departments.saveAgent({ id: co.head.id, companyId: co.co.id, departmentId: co.head.departmentId, kind: 'profile', refId: co.profile.id, name: 'Builder', data: { autonomy: 'auto' } })
    const t1 = taskOf(plan, 'T1')
    c.patchInFlight(t1.id, { ask: { kind: 'question', prompt: 'Which folder?' } })
    const r = runsOf(t1.id)[0].run
    db.prepare('UPDATE runs SET status=? WHERE id=?').run('passed', r.id)
    d.onRunUpdated({ ...r, status: 'passed' })
    expect(c.task(t1.id)).toMatchObject({ status: 'blocked', blockReason: 'needs_input' })
    c.answer(t1.id, 'Use src/main')
    expect(c.task(t1.id).status).toBe('todo')
    await d.pump(co.co.id)
    expect(runsOf(t1.id)).toHaveLength(1)
    await settle()
    expect(runsOf(t1.id)).toHaveLength(2)
    const again = runsOf(t1.id)[1].target as Extract<RunTarget, { kind: 'prompt' }>
    expect(ensured.at(-1)?.key).toBe('M1')
    expect(again.prompt).toContain('Answer: Use src/main')
    // a plan task cannot be taken over as a session (that would run in the checkout)
    await expect(d.takeover(t1.id, { cols: 80, rows: 24 })).rejects.toThrow(/belongs to a plan/)
  })
  it('a milestone that depends on two milestones starts from both of their branches (their leftovers committed first)', async () => {
    const { plan } = await approved('autopilot', threeMilestones())
    expect(ensured.map(e => e.key).sort()).toEqual(['M1', 'M2'])
    finish(plan.tasks[0].taskId!, 's1'); await settle()
    finish(plan.tasks[1].taskId!, 's2'); await settle()
    const m3 = ensured.find(e => e.key === 'M3')!
    // from both dependencies, the first one's branch first (planWork merges the rest in M3's own worktree)
    expect(m3.from.map(branchOf)).toEqual(['hive/plan-m1', 'hive/plan-m2'])
  })
  it('a done plan pushes its branch and opens a PR (never a local merge); Merge… on that PR finishes it', async () => {
    const { plan } = await approved('checkins')
    finish(taskOf(plan, 'T1').id); await settle()
    finish(taskOf(plan, 'T2').id); await settle()
    pilot.pass(plan.id, plan.milestones[0].id); await settle()
    finish(taskOf(plan, 'T3').id, 'sess_m2'); await settle()
    expect(pilot.detail(plan.id).plan.autonomy).toBe('checkins')
    pilot.pass(plan.id, plan.milestones[1].id); await settle()
    const done = pilot.detail(plan.id)
    expect(done.plan.status).toBe('done')
    // the one leaf holds everything; its PR goes into the first milestone's base (main), not M1's branch
    expect(collected).toEqual([['hive/plan-m2']])
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ taskId: plan.milestones[1].taskId, base: 'main', title: 'Plan: Run tasks in worktrees and show plans' })
    expect(done.plan.result).toMatchObject({ branch: 'hive/plan-m2', taskId: plan.milestones[1].taskId, baseBranch: 'main', pushed: true, pr: { number: 7, state: 'OPEN' }, mergedAt: null })
    expect(done.turn).toEqual({ text: 'Your turn: review PR #7 (hive/plan-m2) and merge it into main.', who: 'you', action: { kind: 'merge', taskId: plan.milestones[1].taskId } })
    // a finished plan has no pace left to change
    expect(() => pilot.setAutonomy(plan.id, 'autopilot')).toThrow(/done: there is nothing left to run/)
    // Merge… (the worktree track) merged it: the binding's PR says MERGED; the pilot follows it
    setWork(plan.milestones[1].taskId!, { pr: PR('MERGED') })
    await settle()
    expect(pilot.detail(plan.id).turn.text).toBe('Done: merged into main (#7).')
    expect(plans.get(plan.id).result?.mergedAt).toBe('2026-10-25T03:00:00Z')
    expect(cleaned.sort()).toEqual([plan.milestones[0].taskId, plan.milestones[1].taskId].sort())
    expect(published).toHaveLength(1)
  })
  it('gh missing: the branch is pushed, the page says Open a PR with the commands; Open a PR tries again', async () => {
    publishAnswer = () => ({ pushed: true, pr: null, gh: 'missing', error: null })
    const { plan } = await approved('autopilot', threeMilestones())
    for (const t of plan.tasks) { finish(t.taskId!, 's'); await settle() }
    const done = pilot.detail(plan.id)
    expect(done.plan.status).toBe('done')
    // two leaves? only M3 here: it joined M1 and M2
    expect(collected).toEqual([['hive/plan-m3']])
    expect(done.plan.result).toMatchObject({ branch: 'hive/plan-m3', pushed: true, pr: null, gh: 'missing' })
    expect(done.turn).toEqual({ text: 'Your turn: the work is on hive/plan-m3. Open a pull request into main.', who: 'you', action: { kind: 'openPr' } })
    expect(openPrInstructions(done.plan.result!)).toEqual(['gh pr create --head hive/plan-m3 --base main'])
    publishAnswer = () => ({ pushed: true, pr: PR(), gh: 'ok', error: null })
    await pilot.publish(plan.id)
    expect(pilot.detail(plan.id).turn.action).toEqual({ kind: 'merge', taskId: plan.milestones[2].taskId })
    // Autopilot left its tasks in review; the founder's merge of the PR approves them (they leave Needs you)
    expect(c.listTasks(plan.companyId).filter(t => t.plan?.planId === plan.id && t.status === 'in_review').length).toBeGreaterThan(0)
    setWork(plan.milestones[2].taskId!, { pr: PR('MERGED') })
    await settle()
    const rows = c.listTasks(plan.companyId).filter(t => t.plan?.planId === plan.id)
    expect(rows.filter(t => t.status === 'in_review')).toEqual([])
    expect(rows.find(t => t.plan?.role === 'task' && t.status === 'done')?.doneNote).toBe('Merged #7')
  })
  it('two leaves: the other leaf is merged into the first leaf\'s worktree, one branch, one PR', async () => {
    const { plan } = await approved('autopilot', twoMilestones({ parallel: true, touches: ['a.ts', 'b.ts'] }))
    for (const t of plan.tasks) { finish(t.taskId!, 's'); await settle() }
    expect(plans.get(plan.id).status).toBe('done')
    expect(collected).toEqual([['hive/plan-m1', 'hive/plan-m2']])
    expect(plans.get(plan.id).result?.branch).toBe('hive/plan-m1')
  })
  it('archiving a done Autopilot plan whose PR was not merged releases what still waits in review (QA)', async () => {
    const { plan } = await approved('autopilot', twoMilestones({ parallel: true, touches: ['a.ts', 'b.ts'] }))
    for (const t of plan.tasks) { finish(t.taskId!, 's'); await settle() }
    const done = plans.get(plan.id)
    expect(done.status).toBe('done')
    const waiting = () => c.listTasks(done.companyId).filter(t => t.status === 'in_review').map(t => t.id)
    expect(waiting().length).toBeGreaterThan(0)
    const out = pilot.archive(plan.id)
    expect(out.status).toBe('archived')
    expect(waiting()).toEqual([])
    expect(out.changes.at(-1)!.text).toMatch(/in review released from Needs you/)
    const m1 = done.milestones[0].taskId!
    expect(c.detail(m1).activity.at(-1)!.message).toMatch(/archived .*without merging its pull request: no longer waiting for your review/)
  })
})

describe('PLANS.md QA fixes: stop, archive, drafts, the stop line', () => {
  it('parallel milestones respect the company\'s Tasks in flight cap (QA)', async () => {
    const co = company()
    c.setAutopilot(co.co.id, false, 1)
    draftAnswer = twoMilestones({ parallel: true, touches: ['a.ts', 'b.ts'], agent2: 'Tester' })
    const p = plans.create({ companyId: co.co.id, goal: 'Two things side by side', autonomy: 'autopilot' })
    await pilot.draft(p.id)
    pilot.approve(p.id)
    await settle()
    const plan = plans.get(p.id)
    expect(started).toHaveLength(1)
    expect(pilot.detail(plan.id).waiting).toMatch(/1 task is already running \(the limit is 1\)/)
    c.setAutopilot(co.co.id, false, 2)
    await settle()
    expect(started).toHaveLength(2)
    expect(new Set(started.map(s => s.opts.agentId)).size).toBe(2)
  })

  it('Pause stops new starts until Resume; Stop and Archive cancels the open tasks and hides the plan', async () => {
    const { plan } = await approved('checkins')
    const t1 = taskOf(plan, 'T1'), t2 = taskOf(plan, 'T2')
    pilot.pause(plan.id)
    expect(pilot.detail(plan.id).turn.text).toMatch(/is working on [A-Z][A-Z0-9]{1,4}-\d+\. Paused: nothing new starts after it\.$/)
    finish(t1.id); await settle()
    expect(runsOf(t2.id)).toHaveLength(0)
    expect(pilot.detail(plan.id).turn).toMatchObject({ text: 'Paused: nothing new starts. Resume it to go on.', action: { kind: 'resume' } })
    pilot.resume(plan.id); await settle()
    expect(runsOf(t2.id)).toHaveLength(1)
    expect(() => pilot.archive(plan.id)).toThrow(/in progress\. Stop that run first/)
    finish(t2.id); await settle()
    pilot.pause(plan.id)
    expect(c.task(t1.id).status).toBe('in_review')
    const out = pilot.archive(plan.id)
    expect(out.status).toBe('archived')
    expect(c.task(taskOf(plan, 'T3').id).status).toBe('canceled')
    // the tasks in review leave Needs you: canceled, each saying its plan was archived
    expect(c.task(t1.id).status).toBe('canceled')
    expect(c.task(t2.id).status).toBe('canceled')
    expect(c.detail(t1.id).activity.at(-1)!.message).toMatch(/Its plan was archived .*no longer waiting for your review/)
    expect(out.changes.at(-1)!.text).toMatch(/^Archived; \d+ open tasks? canceled, \d+ in review released from Needs you$/)
    expect(c.listTasks(plan.companyId).filter(t => t.plan?.planId === plan.id && t.status === 'in_review')).toEqual([])
    await settle()
    expect(runsOf(taskOf(plan, 'T3').id)).toHaveLength(0)
    expect(() => pilot.archive(plans.list().find(p => p.status === 'draft')?.id ?? 'plan_none')).toThrow()
  })
  it('Pause is read live: a pause while the worktree is being made wins over the start already decided', async () => {
    const co = company()
    draftAnswer = twoMilestones()
    const p = plans.create({ companyId: co.co.id, goal: 'Run tasks in worktrees and show plans', autonomy: 'checkins' })
    await pilot.draft(p.id)
    duringEnsure = () => { duringEnsure = null; pilot.pause(p.id) }
    pilot.approve(p.id)
    await settle()
    expect(ensured.map(e => e.key)).toEqual(['M1'])
    expect(started).toHaveLength(0)
    expect(pilot.detail(p.id).turn.text).toBe('Paused: nothing new starts. Resume it to go on.')
    pilot.resume(p.id); await settle()
    expect(started).toHaveLength(1)
  })
  it('Plans off (the experimental flag): the pilot does nothing', async () => {
    const co = company()
    let on = true
    const off = new PlanPilot({ plans, company: () => c, startRun, enabled: () => on, work, draftCall: () => async () => twoMilestones() })
    const p = plans.create({ companyId: co.co.id, goal: 'Anything', autonomy: 'checkins' })
    await off.draft(p.id)
    on = false
    off.approve(p.id)
    await off.pump()
    expect(started).toHaveLength(0)
    off.dispose()
  })
  it('a draft cut off by a quit or crash says so at the next start', async () => {
    const co = company()
    const p = plans.create({ companyId: co.co.id, goal: 'Anything', autonomy: 'checkins' })
    expect(plans.get(p.id).drafting).toBe(true)
    const next = new PlanPilot({ plans, company: () => c, startRun, enabled: () => true, work })
    next.start(1_000_000)
    next.dispose()
    expect(plans.get(p.id)).toMatchObject({ drafting: false, draftError: 'Principia closed while the head agent was drafting' })
    expect(next.detail(p.id).turn.text).toBe('Your turn: the draft failed (Principia closed while the head agent was drafting). Draft it again.')
  })
  it('the stop line is one short sentence, whatever the gate notes say', () => {
    expect(stopLine('M1', 'The cleanup leaves worktrees behind. Also the tests are slow.')).toBe('M1 failed its check: the cleanup leaves worktrees behind.')
    const long = stopLine('M2', 'Criterion 1 is not met because the task brief says the subtract function must handle negative numbers and floating point values with care')
    expect(long.length).toBeLessThanOrEqual(100)
    expect(long).toMatch(/^M2 failed its check: criterion 1 is not met because .*…\.$/)
    expect(stopLine('M3', '')).toBe('M3 failed its check.')
  })
  it('the stop line quotes the criterion that failed, not the one that held (QA)', () => {
    expect(stopLine('M3', 'The first criterion holds. The second criterion does not hold: search ignores case.')).toBe('M3 failed its check: the second criterion does not hold.')
    expect(stopLine('M2', 'src/search.js exports search(text), as the diff shows. The tests are missing.')).toBe('M2 failed its check: the tests are missing.')
    expect(stopLine('M2', 'src/search.js exports search(text), as the diff shows. The demo page renders.', 'Fix M2: add tests for search')).toBe('M2 failed its check: add tests for search.')
  })
})

