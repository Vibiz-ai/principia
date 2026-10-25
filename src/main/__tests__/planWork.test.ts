/**
 * PLANS.md v2 end to end over real git in temp dirs: the real CompanyStore, WorktreeManager, TaskWorkService and plan
 * pilot, a fake engine and a fake gh. A milestone's worktree is its milestone task's WORKTREE.md binding (no second
 * worktree system); its plan tasks run there; a dependent milestone starts from its dependencies' branches (merged in its
 * own worktree only); a done plan is pushed and opened as a PR, and only Merge… on that PR merges. The founder's
 * checkout is never touched: its HEAD, branch, status and local main stay as they were.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { Dispatcher, HookedCompanyStore } from '../company/dispatcher'
import { PlanStore } from '../company/plans'
import { PlanPilot, type GateVerdict } from '../company/planPilot'
import { taskPlanWork } from '../company/planWork'
import { TaskWorkService } from '../company/taskWork'
import type { GhResult, GhRunner } from '../company/taskWorkGh'
import { WorktreeManager, gitRunner } from '../worktrees'
import type { Plan, PlanAutonomy } from '../../shared/plans'
import type { StartRunOptions } from '../../shared/engine'
import type { Run, RunTarget } from '../../shared/types'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Hive Test', GIT_AUTHOR_EMAIL: 'test@hive.local', GIT_COMMITTER_NAME: 'Hive Test', GIT_COMMITTER_EMAIL: 'test@hive.local',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir()
} as Record<string, string>
let gitOk = true
try { execFileSync('git', ['--version']) } catch { gitOk = false }
const d = gitOk ? describe : describe.skip
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** GitHub stand-in: pr create / view / merge, auth; `missing` = no gh installed. */
class FakeGh {
  missing = false
  prs = new Map<string, { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; reviewDecision: string; mergedAt: string | null; baseRefName: string }>()
  created: string[][] = []
  merges: string[] = []
  private n = 10
  runner: GhRunner = async (args) => {
    const res = (code: number, stdout = '', stderr = ''): GhResult => ({ code, stdout, stderr, missing: false })
    if (this.missing) return { code: 1, stdout: '', stderr: '', missing: true }
    if (args[0] === 'auth') return res(0)
    if (args[0] === 'pr' && args[1] === 'create') {
      this.created.push(args)
      const head = args[args.indexOf('--head') + 1], base = args[args.indexOf('--base') + 1]
      if (this.prs.has(head)) return res(1, '', `a pull request for branch "${head}" into branch "${base}" already exists`)
      const number = ++this.n
      this.prs.set(head, { number, url: `https://github.com/acme/app/pull/${number}`, state: 'OPEN', isDraft: false, reviewDecision: '', mergedAt: null, baseRefName: base })
      return res(0, `https://github.com/acme/app/pull/${number}\n`)
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = [...this.prs.entries()].find(([b, p]) => b === args[2] || p.url === args[2])?.[1]
      return pr ? res(0, JSON.stringify(pr)) : res(1, '', `no pull requests found for branch "${args[2]}"`)
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const pr = [...this.prs.values()].find((p) => p.url === args[2])
      if (!pr) return res(1, '', 'not found')
      pr.state = 'MERGED'; pr.mergedAt = new Date().toISOString(); this.merges.push(args.join(' '))
      return res(0)
    }
    return res(1, '', `unexpected gh ${args.join(' ')}`)
  }
}

let root: string, repo: string, remote: string, userData: string
let db: DB, store: Store, c: HookedCompanyStore, disp: Dispatcher, wm: WorktreeManager, gh: FakeGh, svc: TaskWorkService, plans: PlanStore, pilot: PlanPilot
let started: { target: RunTarget; opts: StartRunOptions; run: Run }[] = []
let seq = 0
let draft = ''
let gatePrompts: string[] = []
let verdict: GateVerdict = { result: 'pass', notes: 'Holds.', evidence: ['test: 3 passed'], fixTasks: [] }

function startRun(target: RunTarget, opts: StartRunOptions): Run {
  const id = `r_w${++seq}`
  const createdAt = new Date(Date.now() + seq).toISOString()
  db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,artifacts_dir,company_id) VALUES(?,'prompt','Task',?,'manual','running',?,?,?)`).run(id, JSON.stringify(target), createdAt, root, opts.companyId ?? null)
  const run: Run = { id, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt, startedAt: createdAt, endedAt: null, artifactsDir: root, artifactCount: 0, companyId: opts.companyId ?? undefined }
  started.push({ target, opts, run })
  return run
}

beforeEach(() => {
  if (!gitOk) return
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-planwork-')))
  remote = path.join(root, 'remote.git'); repo = path.join(root, 'repo'); userData = path.join(root, 'userData')
  fs.mkdirSync(userData)
  git(root, ['init', '-q', '--bare', '-b', 'main', remote])
  git(root, ['init', '-q', '-b', 'main', repo])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'init'])
  git(repo, ['remote', 'add', 'origin', remote]); git(repo, ['push', '-q', '-u', 'origin', 'main']); git(repo, ['remote', 'set-head', 'origin', 'main'])
  // the founder's own uncommitted work must survive everything
  fs.writeFileSync(path.join(repo, 'a.txt'), 'founder edit\n')
  db = openDatabase(path.join(root, 'hive.db'))
  store = new Store(db)
  c = new HookedCompanyStore(store, { companiesRoot: path.join(userData, 'companies') })
  disp = new Dispatcher({ company: c, startRun, cancelRun: async () => undefined, enabled: () => true })
  c.hooks = disp.hooks()
  const g = gitRunner(() => GIT_ENV)
  wm = new WorktreeManager({ db, userData, git: g, repoIdForPath: (p) => store.getRepoByPath(p)?.id ?? null })
  gh = new FakeGh()
  started = []
  svc = new TaskWorkService({ company: () => c, worktrees: () => wm, startRun, cancelRun: async () => undefined, gh: gh.runner })
  plans = new PlanStore({ company: () => c })
  verdict = { result: 'pass', notes: 'Holds.', evidence: ['test: 3 passed'], fixTasks: [] }
  gatePrompts = []
  pilot = new PlanPilot({
    plans, company: () => c, startRun, enabled: () => true,
    work: taskPlanWork({ company: () => c, work: () => svc, git: g, gh: gh.runner }),
    draftCall: () => async () => draft,
    gateCall: () => async (prompt) => { gatePrompts.push(prompt); return JSON.stringify(verdict) }
  })
})
afterEach(() => {
  if (!gitOk) return
  pilot.dispose(); disp.dispose(); svc.dispose(); db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const founder = () => ({ head: git(repo, ['rev-parse', 'HEAD']), branch: git(repo, ['branch', '--show-current']), status: git(repo, ['status', '--porcelain']), main: git(repo, ['rev-parse', 'refs/heads/main']) })
async function settle() { for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 0)); await pilot.pump() } }
function company() {
  const [r] = store.addRepo(repo)
  const co = c.create({ name: 'Acme', repoIds: [r.id] })
  const dev = c.departments.save({ companyId: co.id, name: 'Development', key: 'development' })
  const profile = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  const head = c.departments.saveAgent({ companyId: co.id, departmentId: dev.id, kind: 'profile', refId: profile.id, name: 'Builder', data: { autonomy: 'manual' } })
  c.departments.saveAgent({ companyId: co.id, departmentId: dev.id, kind: 'profile', refId: profile.id, name: 'Tester', data: { autonomy: 'manual' } })
  return { co, head }
}
async function approved(autonomy: PlanAutonomy, json: string): Promise<Plan> {
  const { co } = company()
  draft = json
  const p = plans.create({ companyId: co.id, goal: 'Ship the two parts', autonomy })
  await pilot.draft(p.id)
  pilot.approve(p.id)
  await settle()
  return plans.get(p.id)
}
/** The agent's turn: it works in the folder workdir hands the engine, commits there, reports review; the run passes. */
async function turn(taskId: string, file: string, text = `${file}\n`): Promise<string> {
  const wd = (await svc.workdir(taskId))!
  fs.writeFileSync(path.join(wd.cwd, file), text)
  git(wd.cwd, ['add', '.']); git(wd.cwd, ['commit', '-qm', `add ${file}`])
  const r = started.filter((s) => s.opts.taskId === taskId).at(-1)!.run
  disp.sessionCaptured({ runId: r.id, agentSessionId: `s_${taskId}` })
  c.patchInFlight(taskId, { report: { outcome: 'review', summary: `Added ${file}`, evidence: [], at: new Date().toISOString() } })
  db.prepare('UPDATE runs SET status=? WHERE id=?').run('passed', r.id)
  disp.onRunUpdated({ ...r, status: 'passed' })
  pilot.onRunUpdated({ ...r, status: 'passed' })
  await settle()
  return wd.cwd
}
const linear = JSON.stringify({ summary: 'One then two.', milestones: [
  { key: 'M1', title: 'Part one', passCriteria: ['one.txt exists'], tasks: [{ key: 'T1', title: 'Write one', touches: ['one.txt'] }] },
  { key: 'M2', title: 'Part two', dependsOn: ['M1'], passCriteria: ['two.txt exists'], tasks: [{ key: 'T1', title: 'Write two', touches: ['two.txt'] }] }
] })
const diamond = (conflict = false) => JSON.stringify({ summary: 'Two parts, then the join.', milestones: [
  { key: 'M1', title: 'Part one', passCriteria: ['ok'], tasks: [{ key: 'T1', title: 'One', touches: [conflict ? 'same.txt' : 'one.txt'] }] },
  { key: 'M2', title: 'Part two', passCriteria: ['ok'], agent: 'Tester', tasks: [{ key: 'T1', title: 'Two', touches: [conflict ? 'same2.txt' : 'two.txt'] }] },
  { key: 'M3', title: 'Join', dependsOn: ['M1', 'M2'], passCriteria: ['ok'], tasks: [{ key: 'T1', title: 'Join them', touches: ['join.txt'] }] }
] })

d('PLANS.md v2 over the worktree track', () => {
  it('a 2-milestone Check-ins plan: milestone worktrees are task bindings, M2 starts from M1, the plan ends in a PR, Merge… merges it', async () => {
    const before = founder()
    const plan = await approved('checkins', linear)
    const [m1, m2] = plan.milestones.map((m) => c.task(m.taskId!))
    const [t1, t2] = plan.tasks.map((t) => c.task(t.taskId!))
    // M1's worktree is M1's own WORKTREE.md binding: <userData>/worktrees/task-<ID> on hive/<id>-…, one owner row
    const w1 = c.task(m1.id).work!
    expect(w1.worktreePath).toBe(wm.taskPath(m1.identifier))
    expect(w1.branch).toMatch(/^hive\//)
    expect(w1.baseRef).toBe('origin/main')
    expect(wm.forTask(m1.id)).toMatchObject({ status: 'active', runId: m1.id })
    expect(db.prepare("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 1 })
    // the plan task's turn runs there with the push guard env (never the founder's checkout); a Start of its own is refused
    const wd = (await svc.workdir(t1.id))!
    expect(wd.cwd).toBe(w1.worktreePath)
    expect(wd.env.GIT_CONFIG_VALUE_0).toBe(wm.hooksDir(m1.id))
    expect(svc.sessionCwd(t1.id)).toBe(w1.worktreePath)
    await expect(svc.startTask(t1.id)).rejects.toThrow(/belongs to a plan/)
    expect('cwd' in started[0].target).toBe(false)

    await turn(t1.id, 'one.txt')
    expect(pilot.detail(plan.id).turn.text).toBe('Your turn: pass Milestone 1 or send it back.')
    pilot.pass(plan.id, plan.milestones[0].id)
    await settle()
    // M2: its own binding, started from M1's branch as it was; it has M1's work
    const w2 = c.task(m2.id).work!
    expect(w2.baseRef).toBe(w1.branch)
    expect(fs.readFileSync(path.join(w2.worktreePath, 'one.txt'), 'utf8')).toBe('one.txt\n')
    expect((await svc.workdir(t2.id))!.cwd).toBe(w2.worktreePath)
    await turn(t2.id, 'two.txt')
    pilot.pass(plan.id, plan.milestones[1].id)
    await settle()

    // done: M2's branch holds everything, pushed through the guard, a PR into main (never M1's branch), not merged
    const done = await pilot.refresh(plan.id)
    expect(done.plan.status).toBe('done')
    expect(done.plan.result).toMatchObject({ branch: w2.branch, taskId: m2.id, baseBranch: 'main', pushed: true, pr: { state: 'OPEN' }, mergedAt: null })
    expect(git(remote, ['rev-parse', `refs/heads/${w2.branch}`])).toBe(git(w2.worktreePath, ['rev-parse', 'HEAD']))
    expect(gh.created).toHaveLength(1)
    expect(gh.created[0].slice(0, 6)).toEqual(['pr', 'create', '--head', w2.branch, '--base', 'main'])
    expect(c.task(m2.id).work!.pr).toMatchObject({ state: 'OPEN', base: 'main' })
    expect(done.turn.action).toEqual({ kind: 'merge', taskId: m2.id })
    // nothing merged anywhere: the remote main and the founder's checkout are as they were
    expect(git(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.main)
    expect(founder()).toEqual(before)

    // Merge… (the worktree track: gh pr merge after the native confirm), then the plan says so and cleans up
    const r = await svc.merge(m2.id)
    expect(r.message).toMatch(/^Merged #\d+$/)
    expect(gh.merges).toEqual([`pr merge ${c.task(m2.id).work!.pr!.url} --squash`])
    const after = await pilot.refresh(plan.id)
    expect(after.plan.result?.mergedAt).toBeTruthy()
    expect(after.turn.text).toMatch(/^Done: merged into main \(#\d+\)\.$/)
    expect(fs.existsSync(w1.worktreePath)).toBe(false)
    expect(fs.existsSync(w2.worktreePath)).toBe(false)
    expect(founder()).toEqual(before)
  })

  it('a multi-dependency milestone starts from all its dependency branches, merged in its own worktree only', async () => {
    const before = founder()
    const plan = await approved('autopilot', diamond())
    const [m1, m2, m3] = plan.milestones.map((m) => c.task(m.taskId!))
    await turn(plan.tasks[0].taskId!, 'one.txt')
    await turn(plan.tasks[1].taskId!, 'two.txt')
    const w3 = c.task(m3.id).work!
    expect(w3.baseRef).toBe(c.task(m1.id).work!.branch)
    expect(fs.readFileSync(path.join(w3.worktreePath, 'one.txt'), 'utf8')).toBe('one.txt\n')
    expect(fs.readFileSync(path.join(w3.worktreePath, 'two.txt'), 'utf8')).toBe('two.txt\n')
    expect(git(w3.worktreePath, ['log', '--format=%s', '-1'])).toBe(`Plan M3: start from ${c.task(m2.id).work!.branch}`)
    // the dependencies' own branches are untouched by M3's merge
    expect(git(c.task(m2.id).work!.worktreePath, ['log', '--format=%s', '-1'])).toBe('add two.txt')
    expect(founder()).toEqual(before)
  })

  it('a multi-dependency milestone\'s gate sees only its own work, not the dependencies merged in (QA: bogus "limit the diff" fix task)', async () => {
    const plan = await approved('autopilot', diamond())
    const m3 = c.task(plan.milestones[2].taskId!)
    await turn(plan.tasks[0].taskId!, 'one.txt')
    await turn(plan.tasks[1].taskId!, 'two.txt')
    const w3 = c.task(m3.id).work!
    expect(w3.baseSha).toBe(git(w3.worktreePath, ['rev-parse', 'HEAD']))
    const cwd = await turn(plan.tasks[2].taskId!, 'join.txt')
    const prompt = gatePrompts.find((p) => p.includes(`(branch ${w3.branch})`))!
    expect(prompt).toMatch(/ add join\.txt$/m)
    expect(prompt).not.toMatch(/ add (one|two)\.txt$/m)
    expect(prompt).not.toMatch(/start from/)
    const pw = taskPlanWork({ company: () => c, work: () => svc, git: gitRunner(() => GIT_ENV), gh: gh.runner })
    const diff = await pw.diff(m3.id)
    expect(diff).toContain('join.txt')
    expect(diff).not.toMatch(/one\.txt|two\.txt/)
    expect((await pw.gitState!(m3.id))!.commits).toHaveLength(1)
    expect(cwd).toBe(w3.worktreePath)
  })

  it('a multi-dependency start that conflicts takes M3\'s worktree away again and stops the plan with the files', async () => {
    const plan = await approved('autopilot', diamond(true))
    const [, , m3] = plan.milestones.map((m) => c.task(m.taskId!))
    await turn(plan.tasks[0].taskId!, 'same.txt', 'from one\n')
    await turn(plan.tasks[1].taskId!, 'same.txt', 'from two\n')
    const p = plans.get(plan.id)
    expect(p.halted?.reason).toMatch(/M3 could not start: M3 needs the work of 2 milestones, and merging hive\/\S+ conflicts in same\.txt/)
    expect(c.task(m3.id).work).toBeNull()
    expect(fs.existsSync(wm.taskPath(m3.identifier))).toBe(false)
    expect(git(repo, ['branch', '--list', 'hive/*']).split('\n').map((s) => s.trim().replace(/^[*+] /, '')).filter(Boolean)).toHaveLength(2)
  })

  it('gh missing: the branch is pushed and the page offers Open a PR; no PR, no merge', async () => {
    gh.missing = true
    const plan = await approved('autopilot', linear)
    await turn(plan.tasks[0].taskId!, 'one.txt')
    await turn(plan.tasks[1].taskId!, 'two.txt')
    const done = pilot.detail(plan.id)
    expect(done.plan.status).toBe('done')
    expect(done.plan.result).toMatchObject({ pushed: true, pr: null, gh: 'missing' })
    expect(done.turn.action).toEqual({ kind: 'openPr' })
    expect(git(remote, ['rev-parse', 'refs/heads/main'])).toBe(git(repo, ['rev-parse', 'refs/heads/main']))
    gh.missing = false
    await pilot.publish(plan.id)
    expect(pilot.detail(plan.id).turn.action).toMatchObject({ kind: 'merge' })
  })

  it('the gate is told the milestone branch\'s commits and whether the worktree is clean (QA: "Change is committed")', async () => {
    const plan = await approved('checkins', linear)
    const m1 = c.task(plan.milestones[0].taskId!)
    const cwd = await turn(plan.tasks[0].taskId!, 'one.txt')
    const sha = git(cwd, ['rev-parse', '--short', 'HEAD'])
    expect(gatePrompts).toHaveLength(1)
    expect(gatePrompts[0]).toContain(`Git, read by Principia in the milestone worktree (branch ${c.task(m1.id).work!.branch})`)
    expect(gatePrompts[0]).toMatch(new RegExp(`${sha}\\w* add one\\.txt`))
    expect(gatePrompts[0]).toContain('Working tree: clean')
    expect(gatePrompts[0]).not.toContain('Git: not available')
    // only the milestone's own commits (not the base's 'init'), and what is left uncommitted is named
    expect(gatePrompts[0]).not.toMatch(/ init$/m)
    fs.writeFileSync(path.join(cwd, 'wip.txt'), 'half\n')
    const st = await taskPlanWork({ company: () => c, work: () => svc, git: gitRunner(() => GIT_ENV), gh: gh.runner }).gitState!(m1.id)
    expect(st).toMatchObject({ branch: c.task(m1.id).work!.branch, uncommitted: ['?? wip.txt'] })
    expect(st!.commits).toHaveLength(1)
  })
})
