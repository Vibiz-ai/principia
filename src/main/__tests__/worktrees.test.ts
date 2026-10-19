/**
 * Worktree per run against real git in temp dirs (AUTHORING.md §6, PO5, PO6): the user's checkout is never touched,
 * keep/remove follows work done in the run, and the push guard blocks main and remote deletes without repo writes.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { WorktreeManager, branchSlug, gitRunner, listHeadsSync, prePushScript, runRepoPaths } from '../worktrees'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Hive Test',
  GIT_AUTHOR_EMAIL: 'test@hive.local',
  GIT_COMMITTER_NAME: 'Hive Test',
  GIT_COMMITTER_EMAIL: 'test@hive.local',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: os.tmpdir()
} as Record<string, string>
let gitOk = true
try {
  execFileSync('git', ['--version'])
} catch {
  gitOk = false
}
const d = gitOk ? describe : describe.skip

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const refExists = (ref: string): boolean => {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}
const gitFails = (cwd: string, args: string[], env: Record<string, string> = {}): string => {
  try {
    git(cwd, args, env)
    return ''
  } catch (e) {
    return String((e as { stderr?: unknown }).stderr ?? e)
  }
}

let root: string
let repo: string
let remote: string
let userData: string
let db: DB
let wm: WorktreeManager

beforeEach(() => {
  if (!gitOk) return
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-wt-')))
  remote = path.join(root, 'remote.git')
  repo = path.join(root, 'repo')
  userData = path.join(root, 'userData')
  fs.mkdirSync(userData)
  git(root, ['init', '-q', '--bare', '-b', 'main', remote])
  git(root, ['init', '-q', '-b', 'main', repo])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'init'])
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  git(repo, ['remote', 'set-head', 'origin', 'main'])
  // a PR branch on the remote (what `gh pr checkout --detach` would land on)
  git(repo, ['checkout', '-qb', 'pr-1'])
  fs.writeFileSync(path.join(repo, 'b.txt'), 'pr\n')
  git(repo, ['add', '.'])
  // an outside contributor's PR commit, made well before the run
  git(repo, ['commit', '-qm', 'pr work'], { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' })
  git(repo, ['push', '-q', 'origin', 'pr-1'])
  git(repo, ['checkout', '-q', 'main'])
  git(repo, ['branch', '-qD', 'pr-1'])
  // the user's own uncommitted work must survive everything
  fs.writeFileSync(path.join(repo, 'a.txt'), 'user edit\n')
  db = openDatabase(':memory:')
  wm = new WorktreeManager({ db, userData, git: gitRunner(() => GIT_ENV), repoIdForPath: () => 'repo_0000000001' })
})
afterEach(() => {
  if (!gitOk) return
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const userState = () => ({ head: git(repo, ['rev-parse', 'HEAD']), branch: git(repo, ['symbolic-ref', '--short', 'HEAD']), status: git(repo, ['status', '--porcelain']) })

d('worktree per run', () => {
  it('creates one shared worktree off origin/main without touching the checkout; clean run -> removed', async () => {
    const before = userState()
    const [a, b] = await Promise.all([
      wm.ensure({ runId: 'r_0000000001', workflowName: 'PR roundup', repo, base: null }),
      wm.ensure({ runId: 'r_0000000001', workflowName: 'PR roundup', repo, base: null })
    ])
    expect(a.id).toBe(b.id)
    expect(a.status).toBe('active')
    expect(a.branch).toBe('hive/pr-roundup-r_0000000001')
    expect(a.base).toMatch(/^origin\/main @ [0-9a-f]{7}$/)
    expect(fs.existsSync(path.join(a.path, 'a.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(a.path, 'a.txt'), 'utf8')).toBe('one\n')
    expect(userState()).toEqual(before)
    const done = await wm.finish('r_0000000001', { status: 'passed', nothingToDo: false })
    expect(done).toMatchObject({ status: 'removed' })
    expect(fs.existsSync(a.path)).toBe(false)
    expect(refExists('refs/heads/hive/pr-roundup-r_0000000001')).toBe(false)
    expect(userState()).toEqual(before)
  })

  it('PO6: a detached PR checkout with no new work is removed (no leaked worktree or branch)', async () => {
    const wt = await wm.ensure({ runId: 'r_0000000002', workflowName: 'x', repo, base: null })
    git(wt.path, ['fetch', '-q', 'origin', 'pr-1'])
    git(wt.path, ['checkout', '-q', '--detach', 'FETCH_HEAD'])
    expect(await wm.finish('r_0000000002', { status: 'passed', nothingToDo: false })).toMatchObject({ status: 'removed' })
    expect(git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).toBe('main')
  })

  it('PO6: new unpushed commits -> kept dirty; failed -> kept failed; Remove cleans up', async () => {
    const wt = await wm.ensure({ runId: 'r_0000000003', workflowName: 'x', repo, base: null })
    fs.writeFileSync(path.join(wt.path, 'c.txt'), 'new\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'agent work'])
    expect(await wm.finish('r_0000000003', { status: 'passed', nothingToDo: false })).toMatchObject({ status: 'kept', keptReason: 'dirty' })
    const wt2 = await wm.ensure({ runId: 'r_0000000004', workflowName: 'x', repo, base: null })
    expect(await wm.finish('r_0000000004', { status: 'failed', nothingToDo: false })).toMatchObject({ status: 'kept', keptReason: 'failed' })
    expect(await wm.remove(wt2.id)).toMatchObject({ status: 'removed' })
    expect(fs.existsSync(wt2.path)).toBe(false)
  })

  it('PO5 + PO6: pushes to a feature branch work and keep the worktree (pushed); main and remote deletes are blocked', async () => {
    // the repo's own pre-push hook must still run (chained)
    const marker = path.join(root, 'repo-hook-ran')
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\n`, { mode: 0o755 })
    const wt = await wm.ensure({ runId: 'r_0000000005', workflowName: 'x', repo, base: null })
    const env = wm.guardEnv('r_0000000005')
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath' })
    fs.writeFileSync(path.join(wt.path, 'd.txt'), 'fix\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'fix'])
    expect(gitFails(wt.path, ['push', 'origin', 'HEAD:refs/heads/main'], env)).toMatch(/Hive push guard: pushing to main is blocked/)
    expect(gitFails(wt.path, ['push', 'origin', ':pr-1'], env)).toMatch(/deleting the remote branch/)
    expect(fs.existsSync(marker)).toBe(false)
    // default policy: only hive/* branches
    expect(gitFails(wt.path, ['push', 'origin', 'HEAD:refs/heads/fix-1'], env)).toMatch(/may push only to: hive\/\*/)
    expect(fs.existsSync(marker)).toBe(false)
    git(wt.path, ['push', '-q', 'origin', 'HEAD:refs/heads/hive/fix-1'], env)
    expect(fs.existsSync(marker)).toBe(true)
    expect(git(remote, ['rev-parse', 'main'])).toBe(git(repo, ['rev-parse', 'main']))
    expect(await wm.finish('r_0000000005', { status: 'passed', nothingToDo: false })).toMatchObject({ status: 'kept', keptReason: 'pushed' })
    // nothing was written into the repo's config
    expect(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')).not.toMatch(/hooksPath/)
  })

  it('boot recovery and helpers', async () => {
    const wt = await wm.ensure({ runId: 'r_0000000006', workflowName: 'x', repo, base: null })
    expect(wm.sourceRepoFor(path.join(wt.path, 'src'))).toBe(path.join(repo, 'src'))
    const r = await wm.bootRecover({ pruneDue: true })
    expect(r.fixed).toBe(1)
    expect(wm.get(wt.id)).toMatchObject({ status: 'kept', keptReason: 'failed' })
    expect(branchSlug('Ünïcode PR / roundup!!')).toBe('unicode-pr-roundup')
    expect(prePushScript(['main'], null)).toContain("protect='main'")
    await expect(wm.ensure({ runId: 'r_0000000007', workflowName: 'x', repo: path.join(root, 'nope'), base: null })).rejects.toThrow(/not found/)
  })

  it('PO5 policy: declared pushBranches, no force-push, no --no-verify, no hooksPath override, no gh pr merge', async () => {
    // a fake gh after the shim on PATH records what got through
    const fakeBin = path.join(root, 'fakebin')
    fs.mkdirSync(fakeBin)
    const ghLog = path.join(root, 'gh.log')
    fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\necho "$@" >> '${ghLog}'\n`, { mode: 0o755 })
    const wm2 = new WorktreeManager({
      db,
      userData,
      git: gitRunner(() => GIT_ENV),
      repoIdForPath: () => 'repo_0000000001',
      pushBranches: () => ['hive/*', 'superlog-roundup-*'],
      basePath: () => `${fakeBin}:${process.env.PATH ?? ''}`
    })
    const wt = await wm2.ensure({ runId: 'r_0000000008', workflowName: 'superlog', repo, base: null })
    const env = wm2.guardEnv('r_0000000008')
    expect(env.PATH?.startsWith(path.join(userData, 'git-hooks', 'r_0000000008', 'bin'))).toBe(true)
    fs.writeFileSync(path.join(wt.path, 'e.txt'), 'one\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'one'])
    git(wt.path, ['push', '-q', 'origin', 'HEAD:refs/heads/superlog-roundup-1'], env)
    expect(gitFails(wt.path, ['push', 'origin', 'HEAD:refs/heads/other'], env)).toMatch(/may push only to/)
    expect(gitFails(wt.path, ['push', 'origin', 'HEAD:refs/tags/v1'], env)).toMatch(/only branches/)
    // rewrite history, then try every force variant
    git(wt.path, ['commit', '-q', '--amend', '-m', 'one (amended)'])
    expect(gitFails(wt.path, ['push', '--force', 'origin', 'HEAD:refs/heads/superlog-roundup-1'], env)).toMatch(/--force is blocked/)
    expect(gitFails(wt.path, ['push', '-f', 'origin', 'HEAD:refs/heads/superlog-roundup-1'], env)).toMatch(/no force/)
    expect(gitFails(wt.path, ['push', 'origin', '+HEAD:refs/heads/superlog-roundup-1'], env)).toMatch(/force refspec/)
    expect(gitFails(wt.path, ['push', '--no-verify', 'origin', 'HEAD:refs/heads/main'], env)).toMatch(/--no-verify is blocked/)
    expect(gitFails(wt.path, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'HEAD:refs/heads/main'], env)).toMatch(/core.hooksPath is blocked/)
    // the environment cannot switch the guard off either: the shim re-exports it
    expect(gitFails(wt.path, ['push', 'origin', 'HEAD:refs/heads/main'], { ...env, GIT_CONFIG_COUNT: '0' })).toMatch(/pushing to main is blocked/)
    // a non-fast-forward without --force (the real git binary, past the shim) is still refused by the hook
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    expect(gitFails(wt.path, ['push', 'origin', 'HEAD:refs/heads/superlog-roundup-1'], env)).toMatch(/non-fast-forward|rejected/)
    let forced = ''
    try {
      execFileSync(realGit, ['push', '--force', 'origin', 'HEAD:refs/heads/superlog-roundup-1'], { cwd: wt.path, env: { ...GIT_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      forced = String((e as { stderr?: unknown }).stderr ?? e)
    }
    expect(forced).toMatch(/non-fast-forward \(force\) push to superlog-roundup-1 is blocked/)
    // gh: merge is refused, everything else passes through
    const gh = (args: string[]): string => {
      try {
        execFileSync('gh', args, { cwd: wt.path, env: { ...GIT_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
        return ''
      } catch (e) {
        return String((e as { stderr?: unknown }).stderr ?? e)
      }
    }
    expect(gh(['pr', 'merge', '12', '--squash'])).toMatch(/gh pr merge is blocked/)
    expect(gh(['api', '-X', 'PUT', 'repos/o/r/pulls/12/merge'])).toMatch(/merging through gh api is blocked/)
    expect(gh(['pr', 'create', '--title', 'x'])).toBe('')
    expect(fs.readFileSync(ghLog, 'utf8').trim()).toBe('pr create --title x')
  })

  it('PO6: branches created during the run (isolated or not) are swept or offered; Remove deletes the confirmed hive/ branch', async () => {
    const runId = 'r_0000000009'
    wm.snapshotRun(runId, [path.join(repo, 'sub', 'dir'), repo])
    // a NON-isolated node fetches PR heads into the user's checkout (`git fetch origin pull/N/head:prN`)
    git(repo, ['fetch', '-q', 'origin', 'pr-1:pr1'])
    const wt = await wm.ensure({ runId, workflowName: 'superlog', repo, base: null })
    // the isolated node makes a branch with unpushed work, and the hive/ branch has unpushed work too
    git(wt.path, ['checkout', '-qb', 'superlog-pr-1'])
    fs.writeFileSync(path.join(wt.path, 'f.txt'), 'combined\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'combine'])
    git(wt.path, ['checkout', '-q', wt.branch])
    fs.writeFileSync(path.join(wt.path, 'g.txt'), 'more\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'more'])
    expect(await wm.finish(runId, { status: 'passed', nothingToDo: false })).toMatchObject({ status: 'kept', keptReason: 'dirty' })
    const before = (await wm.branches(runId)).map((b) => b.name).sort()
    expect(before).toEqual([wt.branch, 'pr1', 'superlog-pr-1'].sort())
    // the sweep (run end) deletes what carries no new unpushed work: the fetched PR head
    const left = await wm.sweepRun(runId)
    expect(left.map((b) => b.name).sort()).toEqual([wt.branch, 'superlog-pr-1'].sort())
    expect(left.find((b) => b.name === wt.branch)).toMatchObject({ hive: true, checkedOut: true, newCommits: 1 })
    expect(refExists('refs/heads/pr1')).toBe(false)
    // Remove on a 'dirty' worktree (the dialog says the work will be lost) deletes the hive/ branch too
    expect(await wm.remove(wt.id)).toMatchObject({ status: 'removed' })
    expect(refExists(`refs/heads/${wt.branch}`)).toBe(false)
    const rest = await wm.branches(runId)
    expect(rest).toEqual([{ repoPath: repo, name: 'superlog-pr-1', newCommits: 1, checkedOut: false, hive: false }])
    // offered on the RunView: the user deletes it explicitly
    expect(await wm.deleteBranches(runId, [{ repoPath: repo, name: 'superlog-pr-1' }])).toEqual([])
    expect(git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).toBe('main')
    expect(listHeadsSync(path.join(repo, '.git'))).toEqual(['main'])
  })

  it('PO6: Remove of a failed run keeps a hive/ branch with unpushed work unless the user discards it', async () => {
    const wt = await wm.ensure({ runId: 'r_0000000010', workflowName: 'x', repo, base: null })
    fs.writeFileSync(path.join(wt.path, 'h.txt'), 'x\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'x'])
    expect(await wm.finish('r_0000000010', { status: 'failed', nothingToDo: false })).toMatchObject({ keptReason: 'failed' })
    await wm.remove(wt.id)
    expect(refExists(`refs/heads/${wt.branch}`)).toBe(true)
    expect(await wm.branches('r_0000000010')).toEqual([{ repoPath: repo, name: wt.branch, newCommits: 1, checkedOut: false, hive: true }])
    const wt2 = await wm.ensure({ runId: 'r_0000000011', workflowName: 'x', repo, base: null })
    fs.writeFileSync(path.join(wt2.path, 'i.txt'), 'x\n')
    git(wt2.path, ['add', '.'])
    git(wt2.path, ['commit', '-qm', 'x'])
    await wm.finish('r_0000000011', { status: 'failed', nothingToDo: false })
    await wm.remove(wt2.id, { discardWork: true })
    expect(refExists(`refs/heads/${wt2.branch}`)).toBe(false)
  })

  it('runRepoPaths: worktree repo + node cwds with inputs resolved; prompt runs use their repo', () => {
    const store = {
      getRepo: (id: string) => (id === 'repo_0000000001' ? ({ id, path: repo } as never) : null),
      getRunDetail: () => null,
      getWorkflow: () =>
        ({
          id: 'wf_0000000001',
          inputs: [{ name: 'repo', label: 'Repo', type: 'repo', default: 'repo_0000000001' }],
          worktree: { repo: '{{inputs.repo}}' },
          nodes: [{ cwd: '{{inputs.repo}}' }, { cwd: null }, { cwd: '/elsewhere/x' }]
        }) as never
    }
    expect(runRepoPaths(store, { id: 'r_1', target: { kind: 'workflow', workflowId: 'wf_0000000001', inputs: {} } }).sort()).toEqual(['/elsewhere/x', repo].sort())
    expect(runRepoPaths(store, { id: 'r_2', target: { kind: 'prompt', profileId: 'p', repoId: 'repo_0000000001', prompt: 'x' } })).toEqual([repo])
  })

  // ---------- item 2: worktree-local pre-push hook, enforced without Hive's env ----------
  const plainEnv = (): Record<string, string> => {
    const e: Record<string, string> = { ...GIT_ENV }
    for (const k of Object.keys(e)) if (k.startsWith('GIT_CONFIG_') && k !== 'GIT_CONFIG_NOSYSTEM') delete e[k]
    delete e.HIVE_DRY_RUN
    return e
  }
  const pushFrom = (cwd: string, ref: string, extra: Record<string, string> = {}): { ok: boolean; err: string } => {
    try {
      execFileSync('git', ['push', 'origin', ref], { cwd, env: { ...plainEnv(), ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, err: '' }
    } catch (e) {
      return { ok: false, err: String((e as { stderr?: unknown }).stderr ?? e) }
    }
  }
  const remoteHas = (b: string): boolean => {
    try {
      git(remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])
      return true
    } catch {
      return false
    }
  }

  it('item 2: the worktree gets its own core.hooksPath (git config --worktree); the main checkout and repo hooks are untouched', async () => {
    const hooksBefore = fs.readdirSync(path.join(repo, '.git', 'hooks')).sort()
    const wt = await wm.ensure({ runId: 'r_0000000020', workflowName: 'x', repo, base: null })
    expect(git(wt.path, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(wm.hooksDir('r_0000000020'))
    expect(git(repo, ['config', '--bool', '--get', 'extensions.worktreeConfig'])).toBe('true')
    // the main checkout sees no hooksPath, and no file was added to the repo's own hooks dir
    let mainHooks: string | null = null
    try {
      mainHooks = git(repo, ['config', '--get', 'core.hooksPath'])
    } catch {
      mainHooks = null // exit 1 = not set
    }
    expect(mainHooks).toBeNull()
    expect(fs.existsSync(path.join(repo, '.git', 'config.worktree'))).toBe(false)
    expect(fs.readdirSync(path.join(repo, '.git', 'hooks')).sort()).toEqual(hooksBefore)
  })

  it('item 2: a plain `git push` from the worktree (no Hive env) to main or a non-hive/ branch is refused; hive/x is allowed', async () => {
    const wt = await wm.ensure({ runId: 'r_0000000021', workflowName: 'x', repo, base: null })
    fs.writeFileSync(path.join(wt.path, 'p.txt'), 'x\n')
    git(wt.path, ['add', '.'])
    git(wt.path, ['commit', '-qm', 'agent work'])
    const toMain = pushFrom(wt.path, 'HEAD:refs/heads/main')
    expect(toMain.ok).toBe(false)
    expect(toMain.err).toMatch(/Hive push guard: pushing to main is blocked/)
    const toFeature = pushFrom(wt.path, 'HEAD:refs/heads/feature-x')
    expect(toFeature.ok).toBe(false)
    expect(toFeature.err).toMatch(/may push only to: hive\/\*/)
    expect(remoteHas('feature-x')).toBe(false)
    const toHive = pushFrom(wt.path, 'HEAD:refs/heads/hive/x')
    expect(toHive.err).toBe('')
    expect(toHive.ok).toBe(true)
    expect(remoteHas('hive/x')).toBe(true)
  })

  it('item 2: dry_run = true refuses every push (marker written at ensure, and $HIVE_DRY_RUN=1 from the steps)', async () => {
    const dry = await wm.ensure({ runId: 'r_0000000022', workflowName: 'x', repo, base: null, dryRun: true })
    fs.writeFileSync(path.join(dry.path, 'q.txt'), 'x\n')
    git(dry.path, ['add', '.'])
    git(dry.path, ['commit', '-qm', 'dry work'])
    for (const ref of ['HEAD:refs/heads/hive/dry', 'HEAD:refs/heads/main', 'HEAD:refs/heads/other']) {
      const r = pushFrom(dry.path, ref)
      expect(r.ok).toBe(false)
      expect(r.err).toMatch(/dry run/)
    }
    expect(remoteHas('hive/dry')).toBe(false)
    // a run that is not a dry run: the env var alone (what the engine sets in every step) refuses too
    const real = await wm.ensure({ runId: 'r_0000000023', workflowName: 'x', repo, base: null })
    git(real.path, ['commit', '-q', '--allow-empty', '-m', 'w'])
    expect(pushFrom(real.path, 'HEAD:refs/heads/hive/env', { HIVE_DRY_RUN: '1' }).err).toMatch(/dry run/)
    expect(pushFrom(real.path, 'HEAD:refs/heads/hive/env', { HIVE_DRY_RUN: '0' }).ok).toBe(true)
    // the guard's git shim refuses it as well
    const env = wm.guardEnv('r_0000000022')
    const shim = path.join(wm.hooksDir('r_0000000022'), 'bin', 'git')
    let shimErr = ''
    try {
      execFileSync(shim, ['push', 'origin', 'HEAD:refs/heads/hive/dry2'], { cwd: dry.path, env: { ...GIT_ENV, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      shimErr = String((e as { stderr?: unknown }).stderr ?? e)
    }
    expect(shimErr).toMatch(/dry run/)
    // the run is over: the marker goes (a kept worktree is the user's again)
    await wm.finish('r_0000000022', { status: 'passed', nothingToDo: false })
    expect(fs.existsSync(path.join(wm.hooksDir('r_0000000022'), 'dry-run'))).toBe(false)
  })

  it('item 5: Remove deletes the hive/ branch Hive created only when it was never pushed', async () => {
    // pushed: kept 'pushed', and Remove leaves the local branch alone
    const a = await wm.ensure({ runId: 'r_0000000024', workflowName: 'x', repo, base: null })
    git(a.path, ['commit', '-q', '--allow-empty', '-m', 'pushed work'])
    expect(pushFrom(a.path, `HEAD:refs/heads/${a.branch}`).ok).toBe(true)
    git(repo, ['fetch', '-q', 'origin'])
    expect(await wm.finish('r_0000000024', { status: 'passed', nothingToDo: false })).toMatchObject({ status: 'kept', keptReason: 'pushed' })
    await wm.remove(a.id)
    expect(fs.existsSync(a.path)).toBe(false)
    expect(refExists(`refs/heads/${a.branch}`)).toBe(true)
    // never pushed, nothing new: Remove deletes the local branch
    const b = await wm.ensure({ runId: 'r_0000000025', workflowName: 'x', repo, base: null })
    expect(await wm.finish('r_0000000025', { status: 'canceled', nothingToDo: false })).toMatchObject({ status: 'kept' })
    await wm.remove(b.id)
    expect(refExists(`refs/heads/${b.branch}`)).toBe(false)
    // a successful run with nothing pushed cleans up by itself (worktree + branch)
    const c = await wm.ensure({ runId: 'r_0000000026', workflowName: 'x', repo, base: null })
    expect(await wm.finish('r_0000000026', { status: 'passed', nothingToDo: false })).toMatchObject({ status: 'removed' })
    expect(refExists(`refs/heads/${c.branch}`)).toBe(false)
    expect(fs.existsSync(c.path)).toBe(false)
  })
})
