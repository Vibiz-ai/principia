/**
 * COMPANY.md §5: the one code path for "which company is this?". Main keeps no current company (§1.3): every caller
 * passes an explicit id or an owning entity, and executor, sessions, scheduler, Slack, gateway, the memory grant and
 * the authoring grant all resolve through here. Reads COALESCE a NULL stamp, and a stamp naming a company that no
 * longer exists, to Personal, so nothing written by an older build disappears.
 */
import fs from 'node:fs'
import path from 'node:path'
import { PERSONAL_COMPANY_ID, PERSONAL_SLUG, PROFILE_FIELDS, type CompanyPassport } from '../../shared/company'
import type { PassportDepartment } from '../../shared/passport'
import type { Repo } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { defaultCompanyColor } from '../db/companyMigration'
import { departmentFallbackLines } from '../memory/departmentSlot'
import type { Store } from '../db/store'

/**
 * Renders the Passport block injected into a spawn. The memory service swaps in the vault's company card (PASSPORT.md
 * §8.3). `department` is the run's department (DEPARTMENTS.md §7): its slot follows the company card; null = no slot.
 */
export type PassportRenderer = (company: CompanyPassport, department?: PassportDepartment | null) => string | null
export interface PassportContextOptions { departmentId?: string | null }
/** Exactly one owning entity. */
export type CompanyRef = { sessionId: string } | { runId: string } | { workflowId: string } | { scheduleId: string } | { teamId: string } | { taskId: string }
export interface ResolveQuery { companyId?: string | null; taskId?: string | null; runId?: string | null; sessionId?: string | null; workflowId?: string | null; scheduleId?: string | null; teamId?: string | null; repoId?: string | null; cwd?: string | null }
export interface Resolved { company: CompanyPassport; repo: Repo | null }
/** What a cwd matched: a registered repo, a company folder (`companies/<slug>/…` or a custom vault path), or nothing. */
export interface Located { company: CompanyPassport; repo: Repo | null; via: 'repo' | 'folder' | 'none' }
export interface SameCompanyRefs { repoId?: string | null; workflowId?: string | null; cwd?: string | null }

type Row = { rowid: number; id: string; data: string; slug: string | null; color: string | null; sort_order: number | null; system: string | null; archived_at: string | null; vault_path: string | null }
type DeptRow = { id: string; company_id: string; name: string; data: string }
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const OWNER_SQL = 'SELECT cr.repo_id, cr.company_id FROM company_repos cr JOIN company_passports cp ON cp.id = cr.company_id'

const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const notFound = (message: string): never => { throw new HiveError('not_found', message) }
/**
 * realpath; for a path not created yet, the realpath of its nearest existing ancestor plus the rest (so `/var` →
 * `/private/var` still applies). The native realpath also canonicalizes letter case on a case-insensitive disk (macOS
 * default), so `~/code/betaapp` cannot dodge the owner of `~/Code/BetaApp`; the JS realpath keeps the case as typed.
 */
function real(p: string): string {
  const abs = path.resolve(p)
  try { return fs.realpathSync.native(abs) } catch {
    const parent = path.dirname(abs)
    return parent === abs ? abs : path.join(real(parent), path.basename(abs))
  }
}
function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/** Lenient read of company_departments.data (a corrupt row still renders its name). */
function toPassportDepartment(r: DeptRow): PassportDepartment {
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(r.data) ?? {} } catch { /* corrupt row: defaults */ }
  const text = (v: unknown) => typeof v === 'string' ? v : ''
  const charter = (data.charter && typeof data.charter === 'object' ? data.charter : {}) as Record<string, unknown>
  return {
    id: r.id, companyId: r.company_id, name: r.name,
    passportNote: text(data.passportNote) || null,
    contextFallback: text(data.contextFallback),
    charter: { does: text(charter.does), doesNot: text(charter.doesNot) }
  }
}

export function buildPassportContext(passport: CompanyPassport): string {
  return `Company Passport: ${passport.name}\nCompany ID: ${passport.id}\nThis is company context, not an authorization to perform unrelated actions.\n` +
    PROFILE_FIELDS.filter(k=>passport[k].trim()).map(k=>`${k}:\n${passport[k]}`).join('\n\n')
}
/** Static profile renderer. An empty Personal profile renders nothing, so unassigned repos get no Passport block. */
export function staticPassportRenderer(company: CompanyPassport, department?: PassportDepartment | null): string | null {
  const card = company.system === 'personal' && !PROFILE_FIELDS.some(k=>company[k]?.trim()) ? null : buildPassportContext(company)
  const slot = department ? departmentFallbackLines(department) : []
  if (!slot.length) return card
  return [card, slot.join('\n')].filter(Boolean).join('\n\n')
}

export class CompanyScope {
  private renderer: PassportRenderer = staticPassportRenderer
  /** `companiesRoot` is `<userData>/companies`; null (in-memory db) disables company folders. */
  constructor(readonly store: Store, readonly companiesRoot: string | null) {}

  // ---------- rows ----------
  /** Listing order: sort_order, then creation; Personal always last. Archived rows only on request; Personal never is. */
  list(opts: { includeArchived?: boolean } = {}): CompanyPassport[] {
    const rows = this.store.db.prepare('SELECT rowid, id, data, slug, color, sort_order, system, archived_at, vault_path FROM company_passports').all() as Row[]
    const owners = this.store.db.prepare(OWNER_SQL).all() as { repo_id: string; company_id: string }[]
    const owned = new Set(owners.map(o=>o.repo_id))
    const unowned = (this.store.db.prepare('SELECT id FROM repos ORDER BY rowid').all() as { id: string }[]).map(r=>r.id).filter(id=>!owned.has(id))
    const out = rows.map(r=>this.fromRow(r, r.id === PERSONAL_COMPANY_ID ? unowned : owners.filter(o=>o.company_id === r.id).map(o=>o.repo_id)))
      .filter(c=>opts.includeArchived || !c.archivedAt)
    const rowid = new Map(rows.map(r=>[r.id, r.rowid]))
    return out.sort((a, b)=>Number(a.system === 'personal') - Number(b.system === 'personal') || a.sortOrder - b.sortOrder || rowid.get(a.id)! - rowid.get(b.id)!)
  }
  /** Any company, archived included (their data still resolves). */
  get(id: string): CompanyPassport | null { return this.list({ includeArchived: true }).find(c=>c.id === id) ?? null }
  require(id: string): CompanyPassport { return this.get(id) ?? notFound('Company not found') }
  personal(): CompanyPassport { return this.require(PERSONAL_COMPANY_ID) }
  bySlug(slug: string): CompanyPassport | null { return this.list({ includeArchived: true }).find(c=>c.slug === slug) ?? null }
  private fromRow(r: Row, repoIds: string[]): CompanyPassport {
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(r.data) ?? {} } catch { /* corrupt row: still listed, with an empty profile */ }
    const personal = r.id === PERSONAL_COMPANY_ID || r.system === 'personal'
    const text = (k: string) => typeof data[k] === 'string' ? data[k] as string : ''
    return {
      id: r.id, name: text('name') || (personal ? 'Personal' : r.id),
      mission: text('mission'), brandVoice: text('brandVoice'), audience: text('audience'), products: text('products'), goals: text('goals'), context: text('context'), constraints: text('constraints'),
      repoIds, createdAt: text('createdAt'), updatedAt: text('updatedAt'),
      // a slug that is not folder-safe (hand-edited row) falls back to the id, so it can never escape companiesRoot
      slug: r.slug && SAFE_SLUG.test(r.slug) ? r.slug : personal ? PERSONAL_SLUG : r.id.replace(/_/g, '-'),
      color: r.color ?? defaultCompanyColor(r.id),
      sortOrder: r.sort_order ?? Number.MAX_SAFE_INTEGER,
      system: personal ? 'personal' : null,
      archivedAt: personal ? null : r.archived_at,
      vaultPath: r.vault_path
    }
  }

  // ---------- resolution ----------
  /** The owning company, or Personal for an unowned (or unknown) repo. */
  companyForRepo(repoId: string): CompanyPassport {
    const owner = this.store.db.prepare(`${OWNER_SQL} WHERE cr.repo_id = ?`).get(repoId) as { company_id: string } | undefined
    return owner ? this.require(owner.company_id) : this.personal()
  }
  /** Longest realpath repo match, then a company folder, then Personal. */
  locate(cwd: string): Located {
    const target = real(cwd)
    const repos = (this.store.db.prepare('SELECT id, path FROM repos').all() as { id: string; path: string }[])
      .map(r=>({ id: r.id, path: real(r.path) })).filter(r=>inside(target, r.path)).sort((a, b)=>b.path.length - a.path.length)
    if (repos.length) return { company: this.companyForRepo(repos[0].id), repo: this.store.getRepo(repos[0].id), via: 'repo' }
    // a live run worktree (`<userData>/worktrees/…`) is a checkout of its repo outside it: the repo's owner, else the run's
    const wt = this.worktreeAt(target)
    if (wt) return { company: wt, repo: null, via: 'folder' }
    // most specific folder wins, so a custom vault can never swallow another company's `companies/<slug>` dir
    const folder = this.folders().filter(f=>inside(target, f.root)).sort((a, b)=>b.root.length - a.root.length)[0]
    if (folder) return { company: folder.company, repo: null, via: 'folder' }
    return { company: this.personal(), repo: null, via: 'none' }
  }
  /** The company of the not-removed worktree containing `target` (realpath), or null. Older dbs without the table: null. */
  private worktreeAt(target: string): CompanyPassport | null {
    let rows: { path: string; repo_id: string | null; run_id: string }[]
    try {
      rows = this.store.db.prepare('SELECT path, repo_id, run_id FROM worktrees WHERE removed_at IS NULL').all() as typeof rows
    } catch { return null }
    const hit = rows.map(r=>({ ...r, root: real(r.path) })).filter(r=>inside(target, r.root)).sort((a, b)=>b.root.length - a.root.length)[0]
    if (!hit) return null
    if (hit.repo_id && this.store.getRepo(hit.repo_id)) return this.companyForRepo(hit.repo_id)
    try { return this.companyOf({ runId: hit.run_id }) } catch { return this.personal() }
  }
  /** Company folders (realpath): `companies/<slug>` for every company plus custom vault paths. */
  private folders(): { company: CompanyPassport; root: string }[] {
    const companies = this.list({ includeArchived: true })
    const root = this.companiesRoot ? real(this.companiesRoot) : null
    return [
      ...(root ? companies.map(c=>({ company: c, root: path.join(root, c.slug) })) : []),
      ...companies.filter(c=>c.vaultPath).map(c=>({ company: c, root: real(c.vaultPath!) }))
    ]
  }
  /**
   * Refuses a custom vault path that would make cwds of other companies (or of no company) resolve to `companyId`:
   * the filesystem root, the home dir, an ancestor of `companies/`, another company's folder, or a folder that
   * overlaps another company's vault.
   */
  checkVaultPath(companyId: string, vaultPath: string): void {
    const target = real(vaultPath)
    if (path.dirname(target) === target) fail('Choose a dedicated folder for the Passport vault, not the disk root')
    const home = process.env.HOME ? real(process.env.HOME) : null
    if (home && inside(home, target)) fail('Choose a dedicated folder for the Passport vault, not your home folder')
    if (this.companiesRoot && inside(real(this.companiesRoot), target)) fail('Choose a folder outside Principia\'s data folder for the Passport vault')
    for (const f of this.folders()) {
      if (f.company.id === companyId) continue
      if (inside(target, f.root) || inside(f.root, target)) fail(`That folder overlaps ${f.company.name}'s folders; choose another one`)
    }
  }
  companyForCwd(cwd: string): CompanyPassport { return this.locate(cwd).company }
  /** The stamp of an owning entity (COALESCE to Personal); not_found when the entity does not exist. */
  companyOf(ref: CompanyRef): CompanyPassport {
    const [key, value] = Object.entries(ref)[0] as [string, string]
    const q: Record<string, [string, string]> = {
      sessionId: ['SELECT company_id FROM sessions WHERE id = ?', 'Session not found'],
      runId: ['SELECT company_id FROM runs WHERE id = ?', 'Run not found'],
      workflowId: ['SELECT company_id FROM workflows WHERE id = ?', 'Workflow not found'],
      scheduleId: ['SELECT company_id FROM schedules WHERE id = ?', 'Schedule not found'],
      teamId: ['SELECT company_id FROM slack_workspaces WHERE team_id = ?', 'Slack workspace not found'],
      taskId: ['SELECT company_id FROM company_tasks WHERE id = ?', 'Task not found']
    }
    if (!q[key]) return fail('Unknown company reference')
    const row = this.store.db.prepare(q[key][0]).get(value) as { company_id: string | null } | undefined
    if (!row) return notFound(q[key][1])
    return (row.company_id && this.get(row.company_id)) || this.personal()
  }
  /**
   * Explicit id first, then the owning entity (task, run, session, workflow, schedule, Slack team), then the repo, then
   * the cwd, else Personal. `repo` comes from repoId, else the cwd's longest repo match. Does not check that the parts
   * agree: callers that take a repo or cwd alongside a company call assertSameCompany.
   */
  resolveCompany(q: ResolveQuery): Resolved {
    const repo = q.repoId ? this.store.getRepo(q.repoId) ?? notFound('Repository not found') : null
    const located = q.cwd ? this.locate(q.cwd) : null
    const owner: CompanyRef | null = q.taskId ? { taskId: q.taskId } : q.runId ? { runId: q.runId } : q.sessionId ? { sessionId: q.sessionId }
      : q.workflowId ? { workflowId: q.workflowId } : q.scheduleId ? { scheduleId: q.scheduleId } : q.teamId ? { teamId: q.teamId } : null
    const company = q.companyId ? this.require(q.companyId)
      : owner ? this.companyOf(owner)
      : repo ? this.companyForRepo(repo.id)
      : located ? located.company
      : this.personal()
    return { company, repo: repo ?? located?.repo ?? null }
  }
  /**
   * The refusal message when a repo, workflow or cwd belongs to a company other than `companyId`, else null. A cwd
   * outside every repo and company folder belongs to nobody and passes. Lets callers warn instead of throw while
   * `experimental.companies` is off (§6).
   */
  crossCompany(companyId: string, refs: SameCompanyRefs): string | null {
    this.require(companyId)
    const other = (kind: string, c: CompanyPassport) => c.id === companyId ? null : `That ${kind} belongs to ${c.name}; open it from ${c.name}`
    if (refs.repoId) {
      if (!this.store.getRepo(refs.repoId)) return notFound('Repository not found')
      const m = other('repository', this.companyForRepo(refs.repoId))
      if (m) return m
    }
    if (refs.workflowId) {
      const m = other('workflow', this.companyOf({ workflowId: refs.workflowId }))
      if (m) return m
    }
    if (refs.cwd) {
      const l = this.locate(refs.cwd)
      if (l.via !== 'none') return other(l.via === 'repo' ? 'repository' : 'folder', l.company)
    }
    return null
  }
  assertSameCompany(companyId: string, refs: SameCompanyRefs): void {
    const m = this.crossCompany(companyId, refs)
    if (m) throw new HiveError('bad_request', m)
  }

  // ---------- folders ----------
  /** `<userData>/companies/<slug>` */
  companyDir(companyId: string): string {
    if (!this.companiesRoot) throw new HiveError('internal', 'Company folders are unavailable for this database')
    return path.join(this.companiesRoot, this.require(companyId).slug)
  }
  /** The cwd of repo-less chats (§3): never the shared scratch dir. */
  workspaceDir(companyId: string): string { return path.join(this.companyDir(companyId), 'workspace') }
  /** Creates the workspace dir if missing and returns it. */
  ensureWorkspace(companyId: string): string {
    const dir = this.workspaceDir(companyId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }
  /** A custom vault_path, else `<userData>/companies/<slug>/Passport`. */
  vaultPathFor(companyId: string): string { return this.require(companyId).vaultPath ?? path.join(this.companyDir(companyId), 'Passport') }

  // ---------- passport context ----------
  /** Registered by the memory service once the vault exists; null restores the static profile renderer. */
  setPassportRenderer(fn: PassportRenderer | null): void { this.renderer = fn ?? staticPassportRenderer }
  /**
   * The Passport block for a spawn of `companyId`; null for an unknown company or nothing to say. A failing renderer
   * falls back to the static profile. `departmentId` adds the department slot (DEPARTMENTS.md §7); a department of
   * another company, or one that does not exist, adds nothing.
   */
  passportContextFor(companyId: string, opts: PassportContextOptions = {}): string | null {
    const company = this.get(companyId)
    if (!company) return null
    const department = opts.departmentId ? this.passportDepartment(companyId, opts.departmentId) : null
    try { return this.renderer(company, department) } catch { return staticPassportRenderer(company, department) }
  }

  // ---------- departments (DEPARTMENTS.md §7) ----------
  /** The slot view of a department of `companyId`, or null (missing, another company's, or an older db without the table). */
  passportDepartment(companyId: string, departmentId: string): PassportDepartment | null {
    let row: DeptRow | undefined
    try {
      row = this.store.db.prepare('SELECT id, company_id, name, data FROM company_departments WHERE id = ? AND company_id = ?').get(departmentId, companyId) as DeptRow | undefined
    } catch { return null }
    return row ? toPassportDepartment(row) : null
  }
  /** Active departments of a company (their notes are seeded with the vault). [] on an older db. */
  passportDepartments(companyId: string): PassportDepartment[] {
    try {
      return (this.store.db.prepare('SELECT id, company_id, name, data FROM company_departments WHERE company_id = ? AND archived_at IS NULL ORDER BY COALESCE(sort_order, 1e9), created_at, id').all(companyId) as DeptRow[]).map(toPassportDepartment)
    } catch { return [] }
  }
  /** The department of the task a run or session works on (`runs.task_id` / `sessions.task_id`), or null. */
  departmentOf(ref: { runId?: string | null; sessionId?: string | null }): PassportDepartment | null {
    const table = ref.runId ? 'runs' : ref.sessionId ? 'sessions' : null
    if (!table) return null
    try {
      const row = this.store.db.prepare(`SELECT t.company_id, CASE WHEN json_valid(t.data) THEN json_extract(t.data, '$.departmentId') END AS department_id
        FROM ${table} x JOIN company_tasks t ON t.id = x.task_id WHERE x.id = ?`).get(ref.runId ?? ref.sessionId) as { company_id: string | null; department_id: string | null } | undefined
      return row?.company_id && row.department_id ? this.passportDepartment(row.company_id, row.department_id) : null
    } catch { return null }
  }
}
