/**
 * COMPANY.md §9: one-time backfill that stamps every existing row with a company. Runs after healV2Columns (the
 * company tables and columns exist by then), in one transaction, guarded by meta.company_migrated = 1. Pure SQL plus
 * JSON parsing; nothing is deleted. Rows written later by an older build keep company_id NULL and read as Personal
 * through COALESCE(company_id, 'co_personal').
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './index'

/** The reserved Personal / Unassigned company (COMPANY.md §2.2). */
export const PERSONAL_COMPANY_ID = 'co_personal'
export const PERSONAL_SLUG = 'personal'

/** Avatar colours: 8 cool token hues (no orange/amber: VOICE.md §5 bans warm accents), picked by a stable hash. */
const COMPANY_HUES = ['--accent', '--status-success', '--provider-codex', '--series-5', '--status-scheduled', '--series-2', '--status-running', '--status-idle'] as const
export function defaultCompanyColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return `var(${COMPANY_HUES[h % COMPANY_HUES.length]})`
}

/** Folder-safe slug, unique against `taken` (which it extends). 'personal' is reserved for the system row. */
export function companySlug(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'company'
  let slug = base
  for (let n = 2; taken.has(slug) || slug === PERSONAL_SLUG; n++) slug = `${base}-${n}`
  taken.add(slug)
  return slug
}

export type CompanyDomain = 'sessions' | 'workflows' | 'schedules' | 'runs' | 'agents' | 'asks' | 'artifacts' | 'author_drafts' | 'slack_workspaces'
const DOMAINS: CompanyDomain[] = ['sessions', 'workflows', 'schedules', 'runs', 'agents', 'asks', 'artifacts', 'author_drafts', 'slack_workspaces']

export interface FlaggedWorkflow {
  id: string
  name: string
  /** 'mixed': node targets span several companies; 'no_repo': no repo target at all. Both went to Personal. */
  reason: 'mixed' | 'no_repo'
  companyIds: string[]
}

/** Stored as JSON in meta.company_migration_report; the UI shows it once as a banner. */
export interface CompanyMigrationReport {
  version: 1
  migratedAt: string
  /** rows stamped by this migration, per domain */
  stamped: Record<CompanyDomain, number>
  /** rows per domain per company after the migration */
  byCompany: Record<CompanyDomain, Record<string, number>>
  flagged: { workflows: FlaggedWorkflow[] }
  /** meta repo_order:<companyId> keys written from the legacy repo_order */
  repoOrderSplit: string[]
}

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
function parse(s: string | null | undefined): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Personal row plus slug / colour / sort order for any company that lacks them (e.g. created by an older build).
 * Idempotent and cheap, so it runs on every open; touches only NULL columns. Returns the number of rows changed.
 */
export function ensureCompanyRows(db: DB, now = new Date().toISOString()): number {
  let changed = 0
  const personal = db.prepare('SELECT id FROM company_passports WHERE id = ?').get(PERSONAL_COMPANY_ID)
  if (!personal) {
    // the data JSON keeps the shape older builds' CompanyStore.listPassports parses
    const data = {
      id: PERSONAL_COMPANY_ID, name: 'Personal',
      mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '',
      repoIds: [], createdAt: now, updatedAt: now
    }
    db.prepare("INSERT INTO company_passports(id, data, slug, color, system) VALUES (?, ?, ?, ?, 'personal')").run(
      PERSONAL_COMPANY_ID, JSON.stringify(data), PERSONAL_SLUG, 'var(--status-idle)'
    )
    changed++
  }
  const rows = db.prepare('SELECT rowid, id, data, slug, color, sort_order, system FROM company_passports ORDER BY rowid').all() as {
    rowid: number; id: string; data: string; slug: string | null; color: string | null; sort_order: number | null; system: string | null
  }[]
  const taken = new Set(rows.flatMap((r) => (r.slug ? [r.slug] : [])))
  let next = Math.max(-1, ...rows.filter((r) => r.id !== PERSONAL_COMPANY_ID && r.sort_order !== null).map((r) => r.sort_order as number)) + 1
  const up = db.prepare('UPDATE company_passports SET slug = ?, color = ?, sort_order = ?, system = ? WHERE id = ?')
  const isPersonal = (r: (typeof rows)[number]) => r.id === PERSONAL_COMPANY_ID
  // real companies first, Personal last (it always sorts last)
  for (const r of [...rows.filter((r) => !isPersonal(r)), ...rows.filter(isPersonal)]) {
    if (r.slug && r.color && r.sort_order !== null && (!isPersonal(r) || r.system === 'personal')) continue
    const name = isObj(parse(r.data)) ? String((parse(r.data) as Raw).name ?? '') : ''
    const slug = r.slug ?? (isPersonal(r) ? PERSONAL_SLUG : companySlug(name, taken))
    const color = r.color ?? defaultCompanyColor(r.id)
    const sort = r.sort_order ?? next++
    up.run(slug, color, sort, isPersonal(r) ? 'personal' : r.system, r.id)
    changed++
  }
  return changed
}

/**
 * One-time backfill (meta.company_migrated = 1), inside one transaction. Returns null when already done. Then the
 * departments step (its own flag), so every open through healV2Columns runs both.
 */
export function migrateCompanyData(db: DB): CompanyMigrationReport | null {
  const report = migrateCompanies(db)
  migrateDepartmentsData(db)
  return report
}

function migrateCompanies(db: DB): CompanyMigrationReport | null {
  if (isCompanyMigrated(db)) {
    ensureCompanyRows(db)
    return null
  }
  // IMMEDIATE + re-check inside: a second opener racing this one waits, then sees the flag instead of re-running and
  // overwriting the report with an empty one
  return db.transaction((): CompanyMigrationReport | null => {
    if (isCompanyMigrated(db)) {
      ensureCompanyRows(db)
      return null
    }
    const now = new Date().toISOString()
    // 1. Personal + slug / colour / sort for existing passports
    ensureCompanyRows(db, now)

    const P = PERSONAL_COMPANY_ID
    const before = Object.fromEntries(DOMAINS.map((t) => [t, nullCount(db, t)])) as Record<CompanyDomain, number>
    const owner = new Map(
      (db.prepare('SELECT cr.repo_id, cr.company_id FROM company_repos cr JOIN company_passports cp ON cp.id = cr.company_id').all() as {
        repo_id: string; company_id: string
      }[]).map((r) => [r.repo_id, r.company_id])
    )
    const repos = db.prepare('SELECT id, path FROM repos').all() as { id: string; path: string }[]
    const repoIds = new Set(repos.map((r) => r.id))
    const companyOfRepo = (id: string) => owner.get(id) ?? P

    // 2. sessions: the repo's company, else Personal
    db.prepare(
      `UPDATE sessions SET company_id = COALESCE((SELECT cr.company_id FROM company_repos cr JOIN company_passports cp ON cp.id = cr.company_id
         WHERE cr.repo_id = sessions.repo_id), ?) WHERE company_id IS NULL`
    ).run(P)

    // 3. workflows: unanimous repo company, else Personal and flagged
    const flagged: FlaggedWorkflow[] = []
    const wfCompany = new Map<string, string>()
    const upWf = db.prepare('UPDATE workflows SET company_id = ? WHERE id = ?')
    const wfs = db.prepare('SELECT id, name, inputs_json, nodes_json, worktree_json, company_id FROM workflows').all() as {
      id: string; name: string; inputs_json: string; nodes_json: string; worktree_json: string | null; company_id: string | null
    }[]
    for (const w of wfs) {
      if (w.company_id) {
        wfCompany.set(w.id, w.company_id)
        continue
      }
      const refs = workflowRepoRefs(w, repos)
      const companies = [...new Set([...refs].map(companyOfRepo))].sort()
      const company = companies.length === 1 ? companies[0] : P
      if (companies.length !== 1) flagged.push({ id: w.id, name: w.name, reason: companies.length ? 'mixed' : 'no_repo', companyIds: companies })
      upWf.run(company, w.id)
      wfCompany.set(w.id, company)
    }

    // 4. schedules: prompt target -> the repo's company; workflow target -> the workflow's company
    const schedCompany = new Map<string, string>()
    const upSched = db.prepare('UPDATE schedules SET company_id = ? WHERE id = ?')
    for (const s of db.prepare('SELECT id, target_json, company_id FROM schedules').all() as { id: string; target_json: string; company_id: string | null }[]) {
      if (s.company_id) {
        schedCompany.set(s.id, s.company_id)
        continue
      }
      const t = parse(s.target_json)
      let company = P
      if (isObj(t) && t.kind === 'prompt' && typeof t.repoId === 'string') company = companyOfRepo(t.repoId)
      else if (isObj(t) && t.kind === 'workflow' && typeof t.workflowId === 'string') company = wfCompany.get(t.workflowId) ?? P
      upSched.run(company, s.id)
      schedCompany.set(s.id, company)
    }

    // 5. runs: company task, then target repo, then workflow, then schedule, then Personal
    // only tasks of a company that still exists (a dangling id would hide the run from every company, Personal included)
    const taskCompany = new Map(
      (db.prepare(
        'SELECT t.run_id, t.company_id FROM company_tasks t JOIN company_passports cp ON cp.id = t.company_id WHERE t.run_id IS NOT NULL ORDER BY t.seq'
      ).all() as { run_id: string; company_id: string }[]).map((r) => [r.run_id, r.company_id])
    )
    const upRun = db.prepare('UPDATE runs SET company_id = ? WHERE id = ?')
    const runs = db.prepare('SELECT id, target_json, workflow_id, schedule_id FROM runs WHERE company_id IS NULL').all() as {
      id: string; target_json: string; workflow_id: string | null; schedule_id: string | null
    }[]
    for (const r of runs) {
      const t = parse(r.target_json)
      const targetRepo = isObj(t) && t.kind === 'prompt' && typeof t.repoId === 'string' ? t.repoId : null
      const workflowId = r.workflow_id ?? (isObj(t) && t.kind === 'workflow' && typeof t.workflowId === 'string' ? t.workflowId : null)
      const company =
        taskCompany.get(r.id) ??
        (targetRepo && (owner.has(targetRepo) || repoIds.has(targetRepo)) ? companyOfRepo(targetRepo) : undefined) ??
        (workflowId ? wfCompany.get(workflowId) : undefined) ??
        (r.schedule_id ? schedCompany.get(r.schedule_id) : undefined) ??
        P
      upRun.run(company, r.id)
    }

    // 6. agents: roots from run or session; subagents inherit from their root; asks from their agent
    db.prepare(
      `UPDATE agents SET company_id = COALESCE((SELECT company_id FROM runs WHERE id = agents.run_id),
         (SELECT company_id FROM sessions WHERE id = agents.session_id)) WHERE company_id IS NULL AND id = root_id`
    ).run()
    db.prepare(
      `UPDATE agents SET company_id = COALESCE((SELECT r.company_id FROM agents r WHERE r.id = agents.root_id),
         (SELECT company_id FROM runs WHERE id = agents.run_id), (SELECT company_id FROM sessions WHERE id = agents.session_id))
       WHERE company_id IS NULL AND id <> root_id`
    ).run()
    db.prepare('UPDATE agents SET company_id = ? WHERE company_id IS NULL').run(P)
    db.prepare(
      `UPDATE asks SET company_id = COALESCE((SELECT company_id FROM agents WHERE id = asks.agent_id),
         (SELECT company_id FROM runs WHERE id = asks.run_id), (SELECT company_id FROM sessions WHERE id = asks.session_id), ?)
       WHERE company_id IS NULL`
    ).run(P)

    // 7. artifacts: from run, else session, else Personal
    db.prepare(
      `UPDATE artifacts SET company_id = COALESCE((SELECT company_id FROM runs WHERE id = artifacts.run_id),
         (SELECT company_id FROM sessions WHERE id = artifacts.session_id), ?) WHERE company_id IS NULL`
    ).run(P)

    // 8. author_drafts (no repo column): the authoring session, else the target workflow, else the run, else Personal
    db.prepare(
      `UPDATE author_drafts SET company_id = COALESCE((SELECT company_id FROM sessions WHERE id = author_drafts.session_id),
         (SELECT company_id FROM workflows WHERE id = author_drafts.workflow_id), (SELECT company_id FROM runs WHERE id = author_drafts.run_id), ?)
       WHERE company_id IS NULL`
    ).run(P)

    // 9. slack_workspaces: Personal (the user re-homes a workspace). 10. secrets stay shared.
    db.prepare('UPDATE slack_workspaces SET company_id = ? WHERE company_id IS NULL').run(P)

    // 11. split the legacy repo_order per company; the legacy key stays for older builds
    const repoOrderSplit = splitRepoOrder(db, companyOfRepo)

    // 12. report
    const stamped = Object.fromEntries(DOMAINS.map((t) => [t, before[t] - nullCount(db, t)])) as Record<CompanyDomain, number>
    const byCompany = Object.fromEntries(
      DOMAINS.map((t) => [
        t,
        Object.fromEntries(
          (db.prepare(`SELECT COALESCE(company_id, ?) AS c, COUNT(*) AS n FROM ${t} GROUP BY 1 ORDER BY 1`).all(P) as { c: string; n: number }[]).map((r) => [r.c, r.n])
        )
      ])
    ) as Record<CompanyDomain, Record<string, number>>
    const report: CompanyMigrationReport = { version: 1, migratedAt: now, stamped, byCompany, flagged: { workflows: flagged }, repoOrderSplit }
    const setMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    setMeta.run('company_migration_report', JSON.stringify(report))
    setMeta.run('company_migrated', '1')
    return report
  }).immediate()
}

/**
 * COMPANY.md §9: copy hive.db to <dir>/Hive-backups/hive.pre-company.<ts>.db before the one-time backfill. Only for a
 * file db that holds user data and is not migrated yet. VACUUM INTO gives a consistent single-file copy even in WAL
 * mode. Best effort: the backfill is additive, so a failed copy is logged by the caller and never blocks opening.
 * Returns the backup path, or null when none was needed.
 */
export function backupBeforeCompanyMigration(db: DB, now = new Date()): string | null {
  if (db.memory || !db.name || isCompanyMigrated(db)) return null
  const tables = ['repos', 'sessions', 'runs', 'workflows', 'schedules', 'company_passports']
  const hasData = tables.some((t) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) return false
    return !!db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()
  })
  if (!hasData) return null
  const dir = path.join(path.dirname(path.resolve(db.name)), 'Hive-backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `hive.pre-company.${now.toISOString().replace(/[:.]/g, '-')}.db`)
  if (fs.existsSync(file)) return file
  db.prepare('VACUUM INTO ?').run(file)
  return file
}

export type MigratedBlockReason = 'deps' | 'interrupted' | 'run_failed'

/** What the departments step changed; null from migrateDepartmentsData when it already ran. */
export interface DepartmentsMigrationReport {
  /** company_tasks rows whose status / department_id / agent_id mirrors were written */
  tasks: number
  /** runs whose task_id was set from company_tasks.run_id */
  runLinks: number
  /** blocked tasks that received a blockReason, per reason */
  blockReasons: Record<MigratedBlockReason, number>
}

/**
 * DEPARTMENTS.md §11: one-time step guarded by meta.departments_migrated, inside one IMMEDIATE transaction. Backfills
 * the company_tasks query mirrors from the task JSON (agent_id stays NULL for legacy assigneeProfileId tasks), links
 * runs.task_id from company_tasks.run_id, and gives every blocked task without one a blockReason: 'deps' when only
 * unmet dependencies block it, else 'interrupted' when it has an interrupted activity, else 'run_failed'. Creates no
 * departments or agents and leaves autopilot unset (off). Rows with unparseable JSON keep their data untouched.
 */
export function migrateDepartmentsData(db: DB): DepartmentsMigrationReport | null {
  if (isDepartmentsMigrated(db)) {
    healDepartmentsMirrors(db)
    return null
  }
  return db.transaction((): DepartmentsMigrationReport | null => {
    if (isDepartmentsMigrated(db)) {
      healDepartmentsMirrors(db)
      return null
    }
    const report: DepartmentsMigrationReport = { tasks: 0, runLinks: 0, blockReasons: { deps: 0, interrupted: 0, run_failed: 0 } }
    const rows = db.prepare('SELECT id, run_id, data FROM company_tasks ORDER BY seq').all() as { id: string; run_id: string | null; data: string }[]
    const tasks = new Map<string, Raw>()
    for (const r of rows) {
      const t = parse(r.data)
      if (isObj(t)) tasks.set(r.id, t)
    }
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
    const interrupted = new Set(
      (db.prepare("SELECT DISTINCT task_id FROM company_task_activity WHERE kind = 'interrupted'").all() as { task_id: string }[]).map((r) => r.task_id)
    )
    // another cause than dependencies: an interruption, a finished run (passed runs move to in_review, so a blocked
    // task with one was failed or canceled), or a still-linked run
    const finished = new Set(
      (db.prepare("SELECT DISTINCT task_id FROM company_task_activity WHERE kind = 'run_finished'").all() as { task_id: string }[]).map((r) => r.task_id)
    )
    const up = db.prepare('UPDATE company_tasks SET status = ?, department_id = ?, agent_id = ?, data = ? WHERE id = ?')
    for (const r of rows) {
      const t = tasks.get(r.id)
      if (!t) continue
      const status = str(t.status)
      let data = r.data
      if (status === 'blocked' && !str(t.blockReason)) {
        const deps = Array.isArray(t.dependencyIds) ? t.dependencyIds.filter((d): d is string => typeof d === 'string') : []
        // a dependency that no longer exists can never be done, so it still blocks
        const unmet = deps.some((d) => tasks.get(d)?.status !== 'done')
        const otherCause = interrupted.has(r.id) || finished.has(r.id) || !!r.run_id
        const reason: MigratedBlockReason = unmet && !otherCause ? 'deps' : interrupted.has(r.id) ? 'interrupted' : 'run_failed'
        t.blockReason = reason
        data = JSON.stringify(t)
        report.blockReasons[reason]++
      }
      up.run(status, str(t.departmentId), str(t.agentId), data, r.id)
      report.tasks++
    }
    // runs.task_id replaces the one-way company_tasks.run_id link; the newest task wins if two ever shared a run
    report.runLinks = db
      .prepare(
        `UPDATE runs SET task_id = (SELECT t.id FROM company_tasks t WHERE t.run_id = runs.id ORDER BY t.seq DESC LIMIT 1)
         WHERE task_id IS NULL AND id IN (SELECT run_id FROM company_tasks WHERE run_id IS NOT NULL)`
      )
      .run().changes
    db.prepare("INSERT INTO meta(key, value) VALUES ('departments_migrated', '1') ON CONFLICT(key) DO NOTHING").run()
    return report
  }).immediate()
}

/**
 * Runs on every open after the one-time step: an older build keeps writing company_tasks.data (and run_id) without the
 * status / department_id / agent_id mirrors or runs.task_id, so a stale mirror would let a board or dispatcher query
 * see a running task as todo. Re-derives only rows that differ; invalid JSON is skipped (CASE keeps json_* from
 * throwing). A blocked task an older build wrote without a blockReason keeps it null, which reads as Needs you and is
 * never healed automatically. Returns the number of rows changed.
 */
export function healDepartmentsMirrors(db: DB): number {
  const field = (key: string) =>
    `(CASE WHEN json_valid(data) AND json_type(data, '$.${key}') = 'text' THEN NULLIF(json_extract(data, '$.${key}'), '') END)`
  const tasks = db
    .prepare(
      `UPDATE company_tasks SET status = ${field('status')}, department_id = ${field('departmentId')}, agent_id = ${field('agentId')}
       WHERE json_valid(data) AND (status IS NOT ${field('status')} OR department_id IS NOT ${field('departmentId')} OR agent_id IS NOT ${field('agentId')})`
    )
    .run().changes
  const links = db
    .prepare(
      `UPDATE runs SET task_id = (SELECT t.id FROM company_tasks t WHERE t.run_id = runs.id ORDER BY t.seq DESC LIMIT 1)
       WHERE task_id IS NULL AND id IN (SELECT run_id FROM company_tasks WHERE run_id IS NOT NULL)`
    )
    .run().changes
  return tasks + links
}

/** True once the departments backfill has committed (meta.departments_migrated). */
export function isDepartmentsMigrated(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM meta WHERE key = 'departments_migrated'").get()
}

/** True once the one-time backfill has committed (meta.company_migrated). */
export function isCompanyMigrated(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM meta WHERE key = 'company_migrated'").get()
}

function nullCount(db: DB, table: CompanyDomain): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id IS NULL`).get() as { n: number }).n
}

/**
 * Repo ids a workflow targets: node cwd and worktree.repo as a repo id, an absolute path inside a repo (longest match),
 * or exactly "{{inputs.X}}" whose input default is one of those. Other templates and null (scratch) add nothing.
 */
export function workflowRepoRefs(
  w: { inputs_json: string; nodes_json: string; worktree_json?: string | null },
  repos: { id: string; path: string }[]
): Set<string> {
  const ids = new Set(repos.map((r) => r.id))
  const byPath = [...repos].sort((a, b) => b.path.length - a.path.length)
  const inputs = parse(w.inputs_json)
  const defaults = new Map<string, string>()
  if (Array.isArray(inputs)) for (const i of inputs) if (isObj(i) && typeof i.name === 'string' && typeof i.default === 'string') defaults.set(i.name, i.default)
  const refs = new Set<string>()
  const add = (value: unknown, depth = 0): void => {
    if (typeof value !== 'string' || !value.trim()) return
    const v = value.trim()
    const tpl = /^\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(v)
    if (tpl) {
      if (depth === 0) add(defaults.get(tpl[1]), 1)
      return
    }
    if (ids.has(v)) {
      refs.add(v)
      return
    }
    if (!path.isAbsolute(v)) return
    const norm = path.normalize(v).replace(/[\\/]+$/, '')
    const hit = byPath.find((r) => {
      const root = path.normalize(r.path).replace(/[\\/]+$/, '')
      return norm === root || norm.startsWith(root + path.sep)
    })
    if (hit) refs.add(hit.id)
  }
  const nodes = parse(w.nodes_json)
  if (Array.isArray(nodes)) for (const n of nodes) if (isObj(n)) add(n.cwd)
  const wt = parse(w.worktree_json)
  if (isObj(wt)) add(wt.repo)
  return refs
}

/** meta repo_order -> repo_order:<companyId> (only keys not already present). Returns the keys written. */
function splitRepoOrder(db: DB, companyOfRepo: (id: string) => string): string[] {
  const legacy = db.prepare("SELECT value FROM meta WHERE key = 'repo_order'").get() as { value: string } | undefined
  const order = parse(legacy?.value)
  if (!Array.isArray(order)) return []
  const per = new Map<string, string[]>()
  for (const id of order) {
    if (typeof id !== 'string') continue
    const c = companyOfRepo(id)
    per.set(c, [...(per.get(c) ?? []), id])
  }
  const written: string[] = []
  const ins = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
  for (const [company, ids] of per) {
    const key = `repo_order:${company}`
    if (ins.run(key, JSON.stringify(ids)).changes) written.push(key)
  }
  return written.sort()
}
