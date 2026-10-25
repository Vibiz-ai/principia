/**
 * docs/USAGE.md §3: disk per company and Clean Up…. Only what Principia created is measured or removed:
 * <userData>/worktrees/<runId>, <userData>/artifacts/<runId|sessionId>, <userData>/logs/runs/<runId>,
 * <userData>/logs/sessions/<sessionId>.log and <userData>/companies/<slug>. Never the founder's repos, never ~/.claude.
 *
 * The walk uses lstat and never follows a symlink (a link counts as itself), and stops after MAX_ENTRIES entries
 * (partial = true). Sizes are allocated blocks (what removing frees), falling back to the byte size.
 * Clean-up removes worktrees through WorktreeManager.remove (the PO6 rules: only Principia's own unpushed-free branch
 * goes with it) and run log folders by path, after checking the path is a direct child of the run logs dir.
 * No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Id } from '../../shared/types'
import type { CleanupItem, CleanupResult, DiskCompany, DiskKind, DiskUsage } from '../../shared/usage'
import type { DB } from '../db'
import type { GitRunner, WorktreeManager } from '../worktrees'

export const MAX_ENTRIES = 400_000
/** Run logs of runs that ended longer ago than this are offered in Clean Up…. */
export const OLD_LOG_DAYS = 30
const DONE_TASK = new Set(['done', 'canceled'])

export interface DiskPaths {
  userData: string
  artifactsRoot: string
  runLogsDir: string
  sessionLogsDir: string
  companiesRoot: string
}

/** Bytes under `p` (lstat only, symlinks never followed). */
export async function sizeOf(p: string, budget: { left: number } = { left: MAX_ENTRIES }): Promise<number> {
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(p)
  } catch {
    return 0
  }
  budget.left--
  const own = st.blocks != null && st.blocks > 0 ? st.blocks * 512 : st.size
  if (!st.isDirectory()) return own
  let names: string[]
  try {
    names = await fs.promises.readdir(p)
  } catch {
    return own
  }
  let total = own
  // a few at a time: wide enough to be quick, narrow enough not to exhaust file descriptors
  for (let i = 0; i < names.length; i += 16) {
    if (budget.left <= 0) break
    const parts = await Promise.all(names.slice(i, i + 16).map((n) => sizeOf(path.join(p, n), budget)))
    for (const n of parts) total += n
  }
  return total
}

const tryAll = <T>(db: DB, sql: string, args: unknown[] = []): T[] => {
  try {
    return db.prepare(sql).all(...args) as T[]
  } catch {
    return []
  }
}
const children = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Clean Up's own check of one kept worktree: only its own HEAD and its own recorded branch count, never the other
 * branches made in the same repo since (later runs' hive/* branches, the founder's). Returns why it cannot be removed,
 * or null when nothing would be lost: no uncommitted change and every own commit is on a remote. A pushed branch that
 * is not yet in any other remote branch reads "pushed, not merged" (checked, not assumed); once another remote branch
 * contains it (merged), it is removable. Removing keeps a pushed branch (WorktreeManager.remove), so only the folder goes.
 */
export async function worktreeVerdict(git: GitRunner, w: { path: string; repo_path: string; branch: string; base_sha: string | null }): Promise<string | null> {
  const st = await git(['status', '--porcelain'], { cwd: w.path })
  if (st.code !== 0) return 'could not check'
  if (st.stdout.trim()) return 'uncommitted changes'
  const tips = ['HEAD']
  if (w.branch) {
    const has = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`], { cwd: w.path })
    if (has.code === 0) tips.push(`refs/heads/${w.branch}`)
  }
  const base = w.base_sha ? [w.base_sha] : []
  const lines = async (args: string[]): Promise<string[] | null> => {
    const r = await git(['rev-list', ...args], { cwd: w.path })
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null
  }
  const own = await lines([...tips, '--not', ...base])
  if (own === null) return 'could not check'
  if (!own.length) return null
  const unpushed = await lines([...tips, '--not', ...base, '--remotes'])
  if (unpushed === null) return 'could not check'
  if (unpushed.length) return 'unpushed commits'
  // --exclude matches the short remote name (origin/<branch>) for --remotes
  const outside = await lines([...tips, '--not', ...base, ...(w.branch ? [`--exclude=*/${w.branch}`] : []), '--remotes'])
  if (outside === null) return 'could not check'
  return outside.length ? 'pushed, not merged' : null
}

export interface DiskDeps {
  db: DB
  paths: DiskPaths
  /** slug -> company id, for `companies/<slug>`. */
  companySlugs(): { id: Id; slug: string }[]
  worktrees: WorktreeManager | null
  /** git for Clean Up's own check (worktreeVerdict). */
  git: GitRunner
  now?: () => Date
}

export class DiskUsageService {
  private cache: { at: number; value: DiskUsage } | null = null
  private inflight: Promise<DiskUsage> | null = null
  constructor(private d: DiskDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date()
  }
  private companyOfRun(): Map<string, string> {
    return new Map(tryAll<{ id: string; c: string | null }>(this.d.db, 'SELECT id, company_id AS c FROM runs').map((r) => [r.id, r.c || PERSONAL_COMPANY_ID]))
  }
  private companyOfSession(): Map<string, string> {
    return new Map(tryAll<{ id: string; c: string | null }>(this.d.db, 'SELECT id, company_id AS c FROM sessions').map((r) => [r.id, r.c || PERSONAL_COMPANY_ID]))
  }

  /** usage:disk. Cached for 30 s; `fresh` measures again (after a clean-up). */
  measure(fresh = false): Promise<DiskUsage> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 30_000) return Promise.resolve(this.cache.value)
    if (this.inflight) return this.inflight
    this.inflight = this.walk()
      .then((v) => {
        this.cache = { at: Date.now(), value: v }
        return v
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  private async walk(): Promise<DiskUsage> {
    const p = this.d.paths
    const runs = this.companyOfRun()
    const sessions = this.companyOfSession()
    const slugs = new Map(this.d.companySlugs().map((c) => [c.slug, c.id]))
    const byCo = new Map<string, DiskCompany>()
    const bucket = (id: string | null): DiskCompany => {
      const k = id ?? ''
      let x = byCo.get(k)
      if (!x) byCo.set(k, (x = { companyId: id, bytes: 0, byKind: { worktrees: 0, artifacts: 0, logs: 0, company: 0 } }))
      return x
    }
    const budget = { left: MAX_ENTRIES }
    const jobs: { file: string; companyId: string | null; kind: DiskKind }[] = []
    for (const e of children(path.join(p.userData, 'worktrees'))) jobs.push({ file: path.join(p.userData, 'worktrees', e.name), companyId: runs.get(e.name) ?? null, kind: 'worktrees' })
    for (const e of children(p.artifactsRoot)) jobs.push({ file: path.join(p.artifactsRoot, e.name), companyId: runs.get(e.name) ?? sessions.get(e.name) ?? null, kind: 'artifacts' })
    for (const e of children(p.runLogsDir)) jobs.push({ file: path.join(p.runLogsDir, e.name), companyId: runs.get(e.name) ?? null, kind: 'logs' })
    for (const e of children(p.sessionLogsDir)) jobs.push({ file: path.join(p.sessionLogsDir, e.name), companyId: sessions.get(e.name.replace(/\.log$/, '')) ?? null, kind: 'logs' })
    for (const e of children(p.companiesRoot)) jobs.push({ file: path.join(p.companiesRoot, e.name), companyId: slugs.get(e.name) ?? null, kind: 'company' })
    for (const j of jobs) {
      if (budget.left <= 0) break
      const n = await sizeOf(j.file, budget)
      const b = bucket(j.companyId)
      b.bytes += n
      b.byKind[j.kind] += n
    }
    const companies = [...byCo.values()].filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    return { measuredAt: this.now().toISOString(), total: companies.reduce((s, c) => s + c.bytes, 0), companies, partial: budget.left <= 0 }
  }

  /** Clean Up… items: kept worktrees (selectable only when there is nothing to lose) and old run logs. */
  async cleanupItems(): Promise<CleanupItem[]> {
    const out: CleanupItem[] = []
    type W = { id: string; run_id: string; path: string; repo_path: string; branch: string; base_sha: string | null; status: string; kept_reason: string | null; created_at: string; run_status: string | null; company_id: string | null; title: string | null; task_status: string | null }
    const wts = tryAll<W>(
      this.d.db,
      `SELECT w.*, r.status AS run_status, r.company_id, r.title,
         (SELECT t.status FROM company_tasks t WHERE t.id = r.task_id) AS task_status
       FROM worktrees w LEFT JOIN runs r ON r.id = w.run_id
       WHERE w.status NOT IN ('removed', 'creating', 'active') AND w.removed_at IS NULL ORDER BY w.created_at`
    )
    const root = path.join(this.d.paths.userData, 'worktrees') + path.sep
    for (const w of wts) {
      if (!w.path.startsWith(root) || !fs.existsSync(w.path)) continue
      const bytes = await sizeOf(w.path)
      let reason: string | null = null
      if (w.run_status === 'running' || w.run_status === 'queued') reason = 'still running'
      else if (w.task_status && !DONE_TASK.has(w.task_status)) reason = 'task still open'
      else if (!this.d.worktrees) reason = 'worktrees are unavailable'
      else {
        try {
          reason = await worktreeVerdict(this.d.git, w)
        } catch {
          reason = 'could not check'
        }
      }
      out.push({
        id: `wt:${w.id}`,
        kind: 'worktree',
        companyId: w.company_id || (w.run_status ? PERSONAL_COMPANY_ID : null),
        title: w.title ?? w.run_id,
        path: w.path,
        bytes,
        selectable: reason === null,
        reason,
        at: w.created_at
      })
    }
    const cutoff = this.now().getTime() - OLD_LOG_DAYS * 86_400_000
    const runs = new Map(
      tryAll<{ id: string; status: string; ended_at: string | null; created_at: string; company_id: string | null; title: string }>(this.d.db, 'SELECT id, status, ended_at, created_at, company_id, title FROM runs').map((r) => [r.id, r])
    )
    for (const e of children(this.d.paths.runLogsDir)) {
      if (!e.isDirectory() || !/^r_[0-9a-z]+$/.test(e.name)) continue // scripts/ and anything not a run's own folder stay
      const r = runs.get(e.name)
      const ended = r?.ended_at ? Date.parse(r.ended_at) : null
      if (r && (r.status === 'running' || r.status === 'queued')) continue
      if (r && (ended == null || ended > cutoff)) continue
      const file = path.join(this.d.paths.runLogsDir, e.name)
      out.push({
        id: `log:${e.name}`,
        kind: 'log',
        companyId: r ? r.company_id || PERSONAL_COMPANY_ID : null,
        title: r ? `Logs of ${r.title}` : `Logs of a deleted run (${e.name})`,
        path: file,
        bytes: await sizeOf(file),
        selectable: true,
        reason: null,
        at: r?.ended_at ?? null
      })
    }
    return out
  }

  /** Removes the selected items after checking each one again. */
  async cleanup(ids: string[]): Promise<CleanupResult> {
    const items = new Map((await this.cleanupItems()).map((i) => [i.id, i]))
    const res: CleanupResult = { removed: 0, freedBytes: 0, failed: [] }
    for (const id of ids) {
      const it = items.get(id)
      if (!it) {
        res.failed.push({ id, reason: 'no longer listed' })
        continue
      }
      if (!it.selectable) {
        res.failed.push({ id, reason: it.reason ?? 'not removable' })
        continue
      }
      try {
        if (it.kind === 'worktree') {
          if (!this.d.worktrees) throw new Error('worktrees are unavailable')
          // no run-wide sweep: long after the run, "branches created during the run" would include later runs' and the
          // founder's branches; only this worktree and its own never-pushed branch go
          await this.d.worktrees.remove(id.slice(3), { sweep: false })
        } else {
          const dir = path.resolve(it.path)
          if (path.dirname(dir) !== path.resolve(this.d.paths.runLogsDir)) throw new Error('outside the run logs folder')
          const st = fs.lstatSync(dir)
          if (!st.isDirectory()) throw new Error('not a folder')
          fs.rmSync(dir, { recursive: true, force: true })
        }
        res.removed++
        res.freedBytes += it.bytes
      } catch (e) {
        res.failed.push({ id, reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) })
      }
    }
    this.cache = null
    return res
  }
}
