/**
 * USAGE.md §3: disk per company and Clean Up… against real git in temp dirs. A clean finished-run worktree is
 * selectable, a dirty one is listed greyed with its reason; removing frees the shown bytes and `git worktree list`
 * no longer has it. Symlinks are never followed; the founder's checkout is never touched.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../db'
import { WorktreeManager, gitRunner } from '../worktrees'
import { DiskUsageService, sizeOf } from './disk'

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } as Record<string, string>
let gitOk = true
try {
  execFileSync('git', ['--version'])
} catch {
  gitOk = false
}
const d = gitOk ? describe : describe.skip
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let root: string
let repo: string
let userData: string
let db: DB
let wm: WorktreeManager
let svc: DiskUsageService

function run(id: string, company: string, status = 'passed', ended = new Date().toISOString()) {
  db.prepare(`INSERT INTO runs (id, kind, title, target_json, trigger, status, created_at, ended_at, artifacts_dir, company_id) VALUES (?, 'prompt', ?, '{}', 'manual', ?, ?, ?, '/tmp/a', ?)`).run(id, `Run ${id}`, status, ended, ended, company)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-disk-')))
  repo = path.join(root, 'repo')
  userData = path.join(root, 'userData')
  fs.mkdirSync(userData)
  if (gitOk) {
    const remote = path.join(root, 'remote.git')
    git(root, ['init', '-q', '--bare', '-b', 'main', remote])
    git(root, ['init', '-q', '-b', 'main', repo])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'init'])
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '-q', '-u', 'origin', 'main'])
    git(repo, ['remote', 'set-head', 'origin', 'main'])
  }
  db = openDatabase(':memory:')
  wm = new WorktreeManager({ db, userData, git: gitRunner(() => GIT_ENV), repoIdForPath: () => null })
  svc = new DiskUsageService({
    db,
    paths: { userData, artifactsRoot: path.join(userData, 'artifacts'), runLogsDir: path.join(userData, 'logs', 'runs'), sessionLogsDir: path.join(userData, 'logs', 'sessions'), companiesRoot: path.join(userData, 'companies') },
    companySlugs: () => [{ id: 'co_acme', slug: 'acme' }],
    worktrees: wm,
    git: gitRunner(() => GIT_ENV)
  })
})
afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('sizeOf', () => {
  it('counts files and never follows a symlink', async () => {
    const dir = path.join(root, 'big')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'f'), Buffer.alloc(64 * 1024))
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'huge'), Buffer.alloc(512 * 1024))
    fs.symlinkSync(outside, path.join(dir, 'link'))
    const n = await sizeOf(dir)
    expect(n).toBeGreaterThanOrEqual(64 * 1024)
    expect(n).toBeLessThan(512 * 1024)
  })
})

d('disk per company and Clean Up…', () => {
  it('measures what Principia created per company', async () => {
    run('r_0000000001', 'co_acme')
    fs.mkdirSync(path.join(userData, 'artifacts', 'r_0000000001'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'artifacts', 'r_0000000001', 'out.png'), Buffer.alloc(40_000))
    fs.mkdirSync(path.join(userData, 'companies', 'acme', 'workspace'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'companies', 'acme', 'workspace', 'n.md'), Buffer.alloc(10_000))
    await wm.ensure({ runId: 'r_0000000001', workflowName: 'x', repo, base: null })
    const du = await svc.measure(true)
    const acme = du.companies.find((c) => c.companyId === 'co_acme')!
    expect(acme.byKind.worktrees).toBeGreaterThan(0)
    expect(acme.byKind.artifacts).toBeGreaterThanOrEqual(40_000)
    expect(acme.byKind.company).toBeGreaterThanOrEqual(10_000)
    expect(du.partial).toBe(false)
  })

  it('a clean finished worktree is selectable, a dirty one is greyed; removing frees it and git forgets it', async () => {
    run('r_0000000002', 'co_acme', 'failed')
    run('r_0000000003', 'co_acme', 'failed')
    const clean = await wm.ensure({ runId: 'r_0000000002', workflowName: 'clean', repo, base: null })
    const dirty = await wm.ensure({ runId: 'r_0000000003', workflowName: 'dirty', repo, base: null })
    fs.writeFileSync(path.join(dirty.path, 'wip.txt'), 'half done\n')
    await wm.finish('r_0000000002', { status: 'failed', nothingToDo: false })
    await wm.finish('r_0000000003', { status: 'failed', nothingToDo: false })
    const items = await svc.cleanupItems()
    const a = items.find((i) => i.id === `wt:${clean.id}`)!
    const b = items.find((i) => i.id === `wt:${dirty.id}`)!
    expect(a).toMatchObject({ selectable: true, reason: null, companyId: 'co_acme' })
    expect(a.bytes).toBeGreaterThan(0)
    expect(b).toMatchObject({ selectable: false, reason: 'uncommitted changes' })
    // a greyed item is refused even when asked for
    const res = await svc.cleanup([a.id, b.id])
    expect(res.removed).toBe(1)
    expect(res.freedBytes).toBe(a.bytes)
    expect(res.failed).toEqual([{ id: b.id, reason: 'uncommitted changes' }])
    expect(fs.existsSync(clean.path)).toBe(false)
    expect(fs.existsSync(dirty.path)).toBe(true)
    const list = git(repo, ['worktree', 'list'])
    expect(list).not.toContain(clean.path)
    expect(list).toContain(dirty.path)
  })

  it('judges each worktree by its own HEAD and branch, not by other runs\' branches in the same repo', async () => {
    for (const id of ['r_0000000004', 'r_0000000005', 'r_0000000006', 'r_0000000007']) run(id, 'co_acme', 'passed')
    const clean = await wm.ensure({ runId: 'r_0000000004', workflowName: 'clean', repo, base: null })
    const merged = await wm.ensure({ runId: 'r_0000000005', workflowName: 'merged', repo, base: null })
    const open = await wm.ensure({ runId: 'r_0000000006', workflowName: 'open', repo, base: null })
    const local = await wm.ensure({ runId: 'r_0000000007', workflowName: 'local', repo, base: null })
    const commit = (p: string, f: string) => {
      fs.writeFileSync(path.join(p, f), `${f}\n`)
      git(p, ['add', '.'])
      git(p, ['commit', '-qm', f])
    }
    // merged: pushed and fast-forwarded into main on the remote
    commit(merged.path, 'feat.txt')
    git(merged.path, ['push', '-q', 'origin', `HEAD:refs/heads/${merged.branch}`])
    git(repo, ['fetch', '-q', 'origin'])
    git(repo, ['merge', '-q', '--ff-only', `origin/${merged.branch}`])
    git(repo, ['push', '-q', 'origin', 'main'])
    // open: pushed, not in any other remote branch
    commit(open.path, 'open.txt')
    git(open.path, ['push', '-q', 'origin', `HEAD:refs/heads/${open.branch}`])
    git(repo, ['fetch', '-q', 'origin'])
    // local: a commit never pushed; plus a branch the founder made later
    commit(local.path, 'local.txt')
    git(repo, ['branch', 'founder-later', open.branch])
    // release them as kept (the run's own finish may judge differently; Clean Up checks again on its own)
    db.prepare("UPDATE worktrees SET status = 'kept', kept_reason = 'pushed'").run()
    const items = new Map((await svc.cleanupItems()).map((i) => [i.id, i]))
    expect(items.get(`wt:${clean.id}`)).toMatchObject({ selectable: true, reason: null })
    expect(items.get(`wt:${merged.id}`)).toMatchObject({ selectable: true, reason: null })
    expect(items.get(`wt:${open.id}`)).toMatchObject({ selectable: false, reason: 'pushed, not merged' })
    expect(items.get(`wt:${local.id}`)).toMatchObject({ selectable: false, reason: 'unpushed commits' })
    // removing the merged one keeps its pushed branch and forgets the worktree
    const res = await svc.cleanup([`wt:${clean.id}`, `wt:${merged.id}`])
    expect(res.removed).toBe(2)
    const list = git(repo, ['worktree', 'list'])
    expect(list).not.toContain(clean.path)
    expect(list).not.toContain(merged.path)
    expect(git(repo, ['branch', '--list', clean.branch])).toBe('')
    // the founder's later branch and the other runs' branches survive (no run-wide sweep)
    expect(git(repo, ['branch', '--list', 'founder-later'])).toContain('founder-later')
    expect(git(repo, ['branch', '--list', open.branch])).toContain(open.branch)
    expect(git(repo, ['branch', '--list', merged.branch])).toContain(merged.branch)
  })

  it('offers old run logs only, never a running run or a fresh one', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    run('r_00000000aa', 'co_acme', 'passed', old)
    run('r_00000000bb', 'co_acme', 'passed')
    run('r_00000000cc', 'co_acme', 'running', old)
    for (const id of ['r_00000000aa', 'r_00000000bb', 'r_00000000cc', 'r_00000000dd']) {
      fs.mkdirSync(path.join(userData, 'logs', 'runs', id), { recursive: true })
      fs.writeFileSync(path.join(userData, 'logs', 'runs', id, 's.log'), 'log\n')
    }
    fs.mkdirSync(path.join(userData, 'logs', 'runs', 'scripts'), { recursive: true })
    const ids = (await svc.cleanupItems()).filter((i) => i.kind === 'log').map((i) => i.id).sort()
    expect(ids).toEqual(['log:r_00000000aa', 'log:r_00000000dd'])
    const res = await svc.cleanup(['log:r_00000000aa'])
    expect(res.removed).toBe(1)
    expect(fs.existsSync(path.join(userData, 'logs', 'runs', 'r_00000000aa'))).toBe(false)
    expect(fs.existsSync(path.join(userData, 'logs', 'runs', 'r_00000000bb'))).toBe(true)
  })
})
