/**
 * WORKTREE.md end to end over real git in temp dirs, the real CompanyStore and WorktreeManager, a fake engine and a
 * fake gh: Start makes the task's own worktree (the founder's checkout untouched), the push guard and the gh shim
 * hold, the task follows its PR (ready, changes requested, merged, Merge… here), a local merge, a worktree deleted by
 * hand, the maxInFlight queue and a signed-out gh.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { Store } from '../db/store'
import { CompanyStore } from '../company'
import { TaskWorkService } from '../company/taskWork'
import type { GhResult, GhRunner } from '../company/taskWorkGh'
import { WorktreeManager, gitRunner } from '../worktrees'
import type { CompanyTaskInput } from '../../shared/company'
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
const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A GitHub stand-in: PRs by head branch, reviews, auth, merge. */
class FakeGh {
  auth: 'ok' | 'signed_out' = 'ok'
  prs = new Map<string, { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; reviewDecision: string; mergedAt: string | null; reviews: unknown[] }>()
  merges: string[] = []
  mergeConflict = false
  private n = 40
  open(branch: string, o: { draft?: boolean } = {}) {
    const number = ++this.n
    this.prs.set(branch, { number, url: `https://github.com/acme/app/pull/${number}`, state: 'OPEN', isDraft: !!o.draft, reviewDecision: '', mergedAt: null, reviews: [] })
    return number
  }
  of(branch: string) { return this.prs.get(branch)! }
  runner: GhRunner = async (args) => {
    const res = (code: number, stdout = '', stderr = ''): GhResult => ({ code, stdout, stderr, missing: false })
    if (args[0] === 'auth') return this.auth === 'ok' ? res(0) : res(1, '', 'You are not logged into any GitHub hosts.')
    if (args[0] === 'pr' && args[1] === 'view') {
      const key = args[2]
      const pr = [...this.prs.entries()].find(([b, p]) => b === key || p.url === key)?.[1]
      if (!pr) return res(1, '', `no pull requests found for branch "${key}"`)
      if (args[4] === 'reviews') return res(0, JSON.stringify({ reviews: pr.reviews }))
      const { reviews: _r, ...rest } = pr
      return res(0, JSON.stringify(rest))
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (this.mergeConflict) return res(1, '', 'Pull request is not mergeable: the merge commit cannot be cleanly created.')
      const pr = [...this.prs.values()].find((p) => p.url === args[2])
      if (!pr) return res(1, '', 'not found')
      pr.state = 'MERGED'; pr.mergedAt = new Date().toISOString()
      this.merges.push(args.join(' '))
      return res(0)
    }
    return res(1, '', `unexpected gh ${args.join(' ')}`)
  }
}

let root: string, repo: string, remote: string, userData: string
let db: DB, store: Store, c: CompanyStore, wm: WorktreeManager, gh: FakeGh, svc: TaskWorkService
let runs: { run: Run; target: RunTarget; opts: StartRunOptions }[]
let profileId: string

beforeEach(() => {
  if (!gitOk) return
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-taskwork-')))
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
  c = new CompanyStore(store, { companiesRoot: path.join(userData, 'companies') })
  wm = new WorktreeManager({ db, userData, git: gitRunner(() => GIT_ENV), repoIdForPath: (p) => store.getRepoByPath(p)?.id ?? null })
  gh = new FakeGh()
  runs = []
  let seq = 0
  svc = new TaskWorkService({
    company: () => c,
    worktrees: () => wm,
    startRun: (target, opts) => {
      const run: Run = { id: `run_${(++seq).toString().padStart(6, '0')}`, kind: 'prompt', title: 'Task', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'queued', reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: root, artifactCount: 0 }
      runs.push({ run, target, opts })
      return run
    },
    cancelRun: async () => undefined,
    gh: gh.runner
  })
  profileId = store.createProfile({ name: 'Claude', adapter: 'claude', permissionMode: 'bypass', secretNames: [], useApiKeyAuth: false }).id
})
afterEach(() => {
  if (!gitOk) return
  svc.dispose()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const founder = () => ({ head: git(repo, ['rev-parse', 'HEAD']), branch: git(repo, ['branch', '--show-current']), status: git(repo, ['status', '--porcelain']) })
function company(): { companyId: string; repoId: string } {
  const [r] = store.addRepo(repo)
  const p = c.create({ name: 'Acme', repoIds: [r.id] })
  return { companyId: p.id, repoId: r.id }
}
function task(o: Partial<CompanyTaskInput> & { companyId: string }) {
  return c.createTask({ title: 'Fix the login redirect', description: 'Make it work', repoId: null, status: 'todo', priority: 2, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: profileId, parentId: null, dependencyIds: [], ...o })
}
const lastRun = () => runs[runs.length - 1]!
const promptOf = (t: RunTarget): string => (t.kind === 'prompt' ? t.prompt : '')
const end = (status: Run['status']) => c.syncRun({ ...lastRun().run, status })
const activity = (id: string) => c.detail(id).activity.map((a) => `${a.kind}:${a.by}:${a.message}`)
const commitIn = (dir: string, file: string) => { fs.writeFileSync(path.join(dir, file), `${file}\n`); git(dir, ['add', '.']); git(dir, ['commit', '-qm', `add ${file}`]) }

d('Start: a task into its own worktree', () => {
  it('creates <userData>/worktrees/task-<ID> on hive/<id>-<slug>, In Progress, the founder checkout untouched', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    const before = founder()
    const r = await svc.startTask(t.id)
    expect(r.queued).toBe(false)
    const after = c.task(t.id)
    expect(after.status).toBe('in_progress')
    expect(after.work).toMatchObject({ repoId, worktreePath: path.join(userData, 'worktrees', `task-${t.identifier}`), branch: `hive/${t.identifier.toLowerCase()}-fix-the-login-redirect`, startedAt: expect.any(String), pr: null })
    expect(after.work!.baseSha).toBe(git(repo, ['rev-parse', 'origin/main']))
    expect(fs.existsSync(path.join(after.work!.worktreePath, 'a.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(after.work!.worktreePath, 'a.txt'), 'utf8')).toBe('one\n')
    expect(founder()).toEqual(before)
    expect(activity(t.id).some((a) => a.startsWith(`work:system:Worktree created on hive/${t.identifier.toLowerCase()}`))).toBe(true)
    // the agent's turn got the brief, and every turn runs in the worktree with the guard env
    expect(promptOf(lastRun().target)).toContain(after.work!.worktreePath)
    expect(lastRun().opts).toMatchObject({ trigger: 'task', taskId: t.id })
    const wd = await svc.workdir(t.id)
    expect(wd!.cwd).toBe(after.work!.worktreePath)
    expect(wd!.env.GIT_CONFIG_VALUE_0).toBe(path.join(userData, 'git-hooks', t.id))
    expect(wd!.env.PATH?.startsWith(path.join(userData, 'git-hooks', t.id, 'bin'))).toBe(true)
    // a task row survives a reboot of the app (only run rows are settled)
    await wm.bootRecover({ pruneDue: false })
    expect(wm.forTask(t.id)?.status).toBe('active')
    expect(wm.sourceRepoFor(path.join(after.work!.worktreePath, 'src'))).toBe(path.join(repo, 'src'))
  })

  it('no repo, no Start; a Personal task with a repo can Start', async () => {
    const { companyId } = company()
    const t = task({ companyId })
    await expect(svc.startTask(t.id)).rejects.toThrow('Choose a repository')
    // a second repo, unowned: Personal's
    const other = path.join(root, 'other'); git(root, ['init', '-q', '-b', 'main', other]); commitIn(other, 'x.txt')
    const [r2] = store.addRepo(other)
    const personal = c.passport('co_personal')
    expect(personal.repoIds).toContain(r2.id)
    const p = task({ companyId: 'co_personal', repoId: r2.id })
    expect((await svc.startTask(p.id)).task.status).toBe('in_progress')
    expect(c.task(p.id).work!.baseRef).toBe('main')
  })

  it('push guard: HEAD:main is rejected by the pre-push hook, its own hive/* branch goes; the gh shim refuses gh pr merge', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    // no env at all: the worktree-local core.hooksPath guards a push from a plain terminal
    const toMain = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: w.worktreePath, env: GIT_ENV, encoding: 'utf8' })
    expect(toMain.status).not.toBe(0)
    expect(toMain.stderr).toMatch(/Hive push guard: pushing to main is blocked/)
    const own = spawnSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: w.worktreePath, env: GIT_ENV, encoding: 'utf8' })
    expect(own.status).toBe(0)
    expect(git(remote, ['branch', '--list', w.branch])).toContain(w.branch)
    // gh shim: a stand-in gh after the shim dir on PATH; merge is refused before it runs
    const fake = path.join(root, 'fakebin'); fs.mkdirSync(fake)
    fs.writeFileSync(path.join(fake, 'gh'), '#!/bin/sh\necho REAL GH "$@"\n', { mode: 0o755 })
    const env = (await svc.workdir(t.id))!.env
    const shim = spawnSync('gh', ['pr', 'merge', '1', '--squash'], { cwd: w.worktreePath, env: { ...GIT_ENV, ...env, PATH: `${env.PATH!.split(':')[0]}:${fake}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(shim.status).not.toBe(0)
    expect(shim.stderr).toMatch(/gh pr merge is blocked/)
    const view = spawnSync('gh', ['pr', 'view'], { cwd: w.worktreePath, env: { ...GIT_ENV, ...env, PATH: `${env.PATH!.split(':')[0]}:${fake}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(view.stdout).toContain('REAL GH pr view')
    // the one shared-config key, set once
    expect(git(repo, ['config', '--get-all', 'extensions.worktreeConfig'])).toBe('true')
  })
})

d('the task follows its PR', () => {
  it('ready → In Review, changes requested → back to work with the note, merged on GitHub → Done "Merged #N", worktree cleaned', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    expect(spawnSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: w.worktreePath, env: GIT_ENV }).status).toBe(0)
    const n = gh.open(w.branch)
    // PR opened while the run holds the task: recorded, status untouched
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_progress')
    expect(c.task(t.id).work!.pr).toMatchObject({ number: n, state: 'OPEN' })
    // the run is canceled before it reported: parked; the open PR then moves it to review
    end('canceled')
    expect(c.task(t.id).status).toBe('blocked')
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_review')
    expect(activity(t.id)).toContain(`work:system:Pull request #${n} is open: In Review`)
    // changes requested on GitHub
    gh.of(w.branch).reviewDecision = 'CHANGES_REQUESTED'
    gh.of(w.branch).reviews = [{ author: { login: 'ana' }, state: 'CHANGES_REQUESTED', body: 'Rename the flag', submittedAt: '2026-10-25T01:00:00Z' }]
    const before = runs.length
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_progress')
    expect(runs.length).toBe(before + 1)
    expect(promptOf(lastRun().target)).toContain('Rename the flag')
    expect(activity(t.id).some((a) => a === `work:system:Changes requested on #${n} by @ana: Rename the flag`)).toBe(true)
    expect(c.detail(t.id).activity.find((a) => a.kind === 'started' && a.message.includes(lastRun().run.id))?.by).toBe('system')
    // the same review never restarts it twice
    end('passed')
    expect(c.task(t.id).status).toBe('in_review')
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_review')
    // merged on GitHub
    gh.of(w.branch).state = 'MERGED'
    gh.of(w.branch).mergedAt = '2026-10-25T02:00:00Z'
    await svc.checkTask(t.id)
    const done = c.task(t.id)
    expect(done.status).toBe('done')
    expect(done.doneNote).toBe(`Merged #${n}`)
    expect(activity(t.id)).toContain(`work:system:Merged #${n}: Done`)
    // nothing to lose (the commit is on the remote): the worktree is gone, the founder's checkout still is not touched
    expect(fs.existsSync(w.worktreePath)).toBe(false)
    expect(done.work!.removedAt).toBeTruthy()
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('founder edit\n')
  })

  it('Merge… from Principia: gh pr merge --squash, then Done; a conflict stops at "Merge conflict, open in editor"', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    end('passed')
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    spawnSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: w.worktreePath, env: GIT_ENV })
    const n = gh.open(w.branch)
    await svc.checkTask(t.id)
    gh.mergeConflict = true
    const r1 = await svc.merge(t.id)
    expect(r1.message).toBe('Merge conflict, open in editor')
    expect(c.task(t.id).work!.conflict).toBe(true)
    expect(c.task(t.id).status).toBe('in_review')
    gh.mergeConflict = false
    const r2 = await svc.merge(t.id)
    expect(gh.merges).toEqual([`pr merge https://github.com/acme/app/pull/${n} --squash`])
    expect(r2.task.status).toBe('done')
    expect(r2.task.doneNote).toBe(`Merged #${n}`)
  })

  it('a local merge of the branch into main completes the task (ancestry, not a rebase)', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    end('passed')
    const w = c.task(t.id).work!
    // nothing new on the branch yet: not "merged"
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_review')
    commitIn(w.worktreePath, 'fix.txt')
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_review')
    // the founder merges locally (a test repo: here the checkout is theirs to move)
    git(repo, ['stash', '-q'])
    git(repo, ['merge', '-q', '--ff-only', w.branch])
    git(repo, ['stash', 'pop', '-q'])
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('done')
    expect(c.task(t.id).doneNote).toMatch(/^Merged hive\/.* into main locally$/)
  })

  it('gh signed out: the task says so and nothing moves', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    end('canceled')
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    spawnSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: w.worktreePath, env: GIT_ENV })
    gh.open(w.branch)
    gh.auth = 'signed_out'
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('blocked')
    expect(c.task(t.id).work!.gh).toBe('signed_out')
    await expect(svc.merge(t.id)).rejects.toThrow('There is no open pull request')
  })
})

d('the worktree goes away by hand', () => {
  it('banner: Keep As Is, Back to Backlog, Cancel Task each do what they say', async () => {
    const { companyId, repoId } = company()
    const ids: string[] = []
    for (const title of ['One', 'Two', 'Three']) {
      const t = task({ companyId, repoId, title })
      await svc.startTask(t.id)
      end('passed')
      ids.push(t.id)
    }
    for (const id of ids) fs.rmSync(c.task(id).work!.worktreePath, { recursive: true, force: true })
    for (const id of ids) await svc.checkTask(id)
    for (const id of ids) expect(c.task(id).work!.goneAt).toBeTruthy()
    expect(activity(ids[0]!).some((a) => a.includes(`The worktree for ${c.task(ids[0]!).identifier} is gone`))).toBe(true)
    const keep = await svc.resolveGone(ids[0]!, 'keep')
    expect(keep.status).toBe('in_review')
    expect(keep.work!.removedAt).toBeTruthy()
    const backlog = await svc.resolveGone(ids[1]!, 'backlog')
    expect(backlog.status).toBe('backlog')
    expect(backlog.work).toBeNull()
    const cancel = await svc.resolveGone(ids[2]!, 'cancel')
    expect(cancel.status).toBe('canceled')
    for (const id of ids) expect(wm.forTask(id)?.status).toBe('removed')
    // Back to Backlog: Start again checks the kept branch out in a new worktree
    c.updateTask(ids[1]!, { status: 'todo' })
    const again = await svc.startTask(ids[1]!)
    expect(again.task.status).toBe('in_progress')
    expect(fs.existsSync(again.task.work!.worktreePath)).toBe(true)
  })

  it('Remove Worktree… refuses to drop work silently and lists it', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    end('passed')
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    fs.writeFileSync(path.join(w.worktreePath, 'wip.txt'), 'wip\n')
    const loss = await svc.loss(t.id)
    expect(loss.dirty).toEqual(['?? wip.txt'])
    expect(loss.unpushed).toHaveLength(1)
    expect(loss.unpushed[0]).toMatch(/add fix\.txt$/)
    await expect(wm.removeTask(t.id)).rejects.toThrow('1 uncommitted change and 1 unpushed commit')
    expect(fs.existsSync(w.worktreePath)).toBe(true)
    const out = await svc.removeWorktree(t.id, true)
    expect(out.work!.removedAt).toBeTruthy()
    expect(fs.existsSync(w.worktreePath)).toBe(false)
    expect(activity(t.id).some((a) => a.startsWith('work:human:Worktree removed (discarded 1 uncommitted, 1 unpushed)'))).toBe(true)
  })
})

d('several tasks at once, capped by maxInFlight', () => {
  it('Start 4 with maxInFlight=3: three run, the fourth is queued and starts when one finishes', async () => {
    const { companyId, repoId } = company()
    c.setAutopilot(companyId, false, 3)
    const ts = ['A', 'B', 'C', 'D'].map((title) => task({ companyId, repoId, title }))
    const results = []
    for (const t of ts) results.push(await svc.startTask(t.id))
    expect(results.map((r) => r.queued)).toEqual([false, false, false, true])
    expect(results[3]!.message).toBe('Queued: 3 already running')
    expect(c.task(ts[3]!.id).status).toBe('todo')
    expect(fs.existsSync(path.join(userData, 'worktrees', `task-${ts[3]!.identifier}`))).toBe(false)
    expect(new Set(ts.slice(0, 3).map((t) => c.task(t.id).work!.worktreePath)).size).toBe(3)
    c.syncRun({ ...runs[0]!.run, status: 'passed' })
    await svc.drain(companyId)
    expect(c.task(ts[3]!.id).status).toBe('in_progress')
    expect(c.task(ts[3]!.id).work!.queuedAt).toBeNull()
    expect(fs.existsSync(c.task(ts[3]!.id).work!.worktreePath)).toBe(true)
  })

  it('a queued task the dispatcher claims gets its worktree with the turn (never the founder checkout)', async () => {
    const { companyId, repoId } = company()
    c.setAutopilot(companyId, false, 1)
    const a = task({ companyId, repoId, title: 'A' }), b = task({ companyId, repoId, title: 'B' })
    await svc.startTask(a.id)
    expect((await svc.startTask(b.id)).queued).toBe(true)
    const wd = await svc.workdir(b.id)
    expect(wd!.cwd).toBe(path.join(userData, 'worktrees', `task-${b.identifier}`))
    expect(fs.existsSync(wd!.cwd)).toBe(true)
    expect(c.task(b.id).work!.queuedAt).toBeNull()
  })
})

d('QA fixes', () => {
  it('a PR merged while the run holds the task becomes Done when the run ends (not stuck In Review)', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    spawnSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: w.worktreePath, env: GIT_ENV })
    const n = gh.open(w.branch)
    gh.of(w.branch).state = 'MERGED'
    gh.of(w.branch).mergedAt = '2026-10-25T02:00:00Z'
    // seen while the agent still works: recorded only
    await svc.checkTask(t.id)
    expect(c.task(t.id).status).toBe('in_progress')
    expect(c.task(t.id).work!.pr!.state).toBe('MERGED')
    end('passed')
    expect(c.task(t.id).status).toBe('in_review')
    await svc.checkTask(t.id)
    const done = c.task(t.id)
    expect(done.status).toBe('done')
    expect(done.doneNote).toBe(`Merged #${n}`)
    expect(done.work!.removedAt).toBeTruthy()
    expect(fs.existsSync(w.worktreePath)).toBe(false)
    // the next pass leaves it alone
    await svc.poll({ force: true })
    expect(c.task(t.id).status).toBe('done')
  })

  it('after Keep As Is (or Remove Worktree…) the next turn gets its worktree back on its branch, never the founder checkout', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    const w = c.task(t.id).work!
    commitIn(w.worktreePath, 'fix.txt')
    fs.rmSync(w.worktreePath, { recursive: true, force: true })
    await svc.checkTask(t.id)
    await svc.resolveGone(t.id, 'keep')
    end('passed')
    expect(c.task(t.id).work!.removedAt).toBeTruthy()
    // the branch kept its commit
    expect(git(repo, ['log', '--format=%s', '-1', w.branch])).toBe('add fix.txt')
    const wd = await svc.workdir(t.id)
    expect(wd!.cwd).toBe(w.worktreePath)
    expect(wd!.cwd).not.toBe(repo)
    expect(fs.existsSync(path.join(wd!.cwd, 'fix.txt'))).toBe(true)
    const again = c.task(t.id).work!
    expect(again.branch).toBe(w.branch)
    expect(again.removedAt).toBeNull()
    expect(wm.forTask(t.id)?.status).toBe('active')
    // Remove Worktree… then a turn: same story
    await svc.removeWorktree(t.id, true)
    expect(fs.existsSync(w.worktreePath)).toBe(false)
    const wd2 = await svc.workdir(t.id)
    expect(wd2!.cwd).toBe(w.worktreePath)
    expect(fs.existsSync(wd2!.cwd)).toBe(true)
    expect(founder().branch).toBe('main')
  })

  it('two Starts of one task at once: one wins, its worktree and binding survive the loser', async () => {
    const { companyId, repoId } = company()
    const t = task({ companyId, repoId })
    const [a, b] = await Promise.allSettled([svc.startTask(t.id), svc.startTask(t.id)])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    const lost = (a.status === 'rejected' ? a : b) as PromiseRejectedResult
    expect(String(lost.reason)).toMatch(/starting already/)
    const cur = c.task(t.id)
    expect(cur.status).toBe('in_progress')
    expect(cur.work?.startedAt).toBeTruthy()
    expect(fs.existsSync(cur.work!.worktreePath)).toBe(true)
    expect(runs).toHaveLength(1)
    // a dispatcher turn racing the queue's start shares the one worktree
    const [w1, w2] = await Promise.all([svc.workdir(t.id), svc.workdir(t.id)])
    expect(w1!.cwd).toBe(w2!.cwd)
  })

  it("a run's branch sweep never deletes a task's branch (made while that run ran)", async () => {
    const { companyId, repoId } = company()
    wm.snapshotRun('run_other1', [repo])
    const t = task({ companyId, repoId })
    await svc.startTask(t.id)
    const w = c.task(t.id).work!
    fs.rmSync(w.worktreePath, { recursive: true, force: true })
    await svc.checkTask(t.id)
    await svc.resolveGone(t.id, 'backlog')
    expect(await wm.branches('run_other1')).toEqual([])
    await wm.sweepRun('run_other1')
    expect(git(repo, ['branch', '--list', w.branch])).toContain(w.branch)
  })
})
