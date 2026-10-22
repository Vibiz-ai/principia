import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentVersion, openDatabase, type DB } from '../index'
import {
  AUTHORING_ADDED_COLUMNS, COMPANY_ADDED_COLUMNS, DDL_AUTHORING, DDL_COMPANY, DDL_SLACK, DDL_V1, DDL_V2_SCHEDULE_EVENTS, DDL_V2_TABLES, SCHEMA_VERSION,
  SLACK_ADDED_COLUMNS, V2_ADDED_COLUMNS
} from '../schema'
import { healDepartmentsMirrors, migrateCompanyData, migrateDepartmentsData } from '../companyMigration'

let nativeOk = true
try {
  new Database(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk ? describe : describe.skip

const T = '2026-10-01T00:00:00.000Z'

let tmp: string
let file: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-departments-'))
  file = path.join(tmp, 'hive.db')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/**
 * A hive.db as the company build left it: schema v2 + authoring + Slack + the company tables and columns as they were
 * before departments (no company_departments / company_agents, no status / task_id mirrors), company_migrated set.
 */
function companyEraDb(f: string): DB {
  const db = new Database(f)
  db.pragma('foreign_keys = ON')
  db.exec(DDL_V1)
  db.exec(DDL_V2_TABLES)
  db.exec('ALTER TABLE schedules ADD COLUMN skip_slot_at TEXT')
  db.exec(DDL_V2_SCHEDULE_EVENTS)
  db.exec(DDL_AUTHORING)
  db.exec(DDL_SLACK)
  for (const [t, c, ddl] of [...V2_ADDED_COLUMNS, ...AUTHORING_ADDED_COLUMNS, ...SLACK_ADDED_COLUMNS]) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`)
  // the company DDL minus the departments tables
  db.exec(DDL_COMPANY.slice(0, DDL_COMPANY.indexOf('-- DEPARTMENTS.md')))
  for (const [t, c, ddl] of COMPANY_ADDED_COLUMNS.slice(0, COMPANY_ADDED_COLUMNS.findIndex(([t]) => t === 'company_tasks'))) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`)
  }
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?), ('slack_migrated', '1'), ('company_migrated', '1')").run(String(SCHEMA_VERSION))
  return db
}

interface TaskFixture {
  id: string
  status: string
  runId?: string | null
  deps?: string[]
  activity?: string[]
  extra?: Record<string, unknown>
}

/** Live-shaped board: done / review / blocked tasks with and without runs, deps and interruptions, a legacy assignee. */
const TASKS: TaskFixture[] = [
  { id: 'task_done', status: 'done', runId: 'run_done', activity: ['created', 'run_finished'] },
  { id: 'task_open', status: 'todo' },
  { id: 'task_review', status: 'in_review', runId: 'run_review', activity: ['run_finished'], extra: { assigneeProfileId: 'prof_claude' } },
  // blocked by an unmet dependency only
  { id: 'task_deps', status: 'blocked', deps: ['task_open'] },
  // dependency deleted: still unmet
  { id: 'task_deps_gone', status: 'blocked', deps: ['task_missing'] },
  // dependencies all done but still blocked: not a deps block
  { id: 'task_deps_met', status: 'blocked', deps: ['task_done'] },
  // reconcile parked it after a restart (run link cleared)
  { id: 'task_interrupted', status: 'blocked', runId: null, activity: ['started', 'interrupted'] },
  // interrupted, with unmet dependencies added later: the interruption wins
  { id: 'task_interrupted_deps', status: 'blocked', deps: ['task_open'], activity: ['interrupted'] },
  // run failed
  { id: 'task_failed', status: 'blocked', runId: 'run_failed', activity: ['started', 'run_finished'] },
  // run failed and also has unmet deps
  { id: 'task_failed_deps', status: 'blocked', runId: 'run_failed2', deps: ['task_open'], activity: ['run_finished'] },
  // set to blocked by hand
  { id: 'task_manual', status: 'blocked' },
  // already carries a reason (written by a newer build): kept
  { id: 'task_reasoned', status: 'blocked', extra: { blockReason: 'needs_input', departmentId: 'dep_x', agentId: 'agt_y' } }
]

function seedBoard(db: DB): void {
  const passport = (id: string) => JSON.stringify({ id, name: id, mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds: [], createdAt: T, updatedAt: T })
  db.prepare("INSERT INTO company_passports(id, data, slug, color, sort_order) VALUES ('co_acme', ?, 'acme', 'var(--accent)', 0)").run(passport('co_acme'))
  db.prepare("INSERT INTO company_passports(id, data, slug, color, sort_order, system) VALUES ('co_personal', ?, 'personal', 'var(--status-idle)', 1, 'personal')").run(passport('co_personal'))
  const run = db.prepare(
    "INSERT INTO runs(id, kind, title, target_json, trigger, status, created_at, artifacts_dir, company_id) VALUES (?, 'prompt', 't', '{}', 'manual', ?, ?, '/a', 'co_acme')"
  )
  run.run('run_done', 'passed', T)
  run.run('run_review', 'passed', T)
  run.run('run_failed', 'failed', T)
  run.run('run_failed2', 'canceled', T)
  run.run('run_unrelated', 'passed', T)
  const ins = db.prepare('INSERT INTO company_tasks(id, company_id, source_key, run_id, data) VALUES (?, ?, NULL, ?, ?)')
  const act = db.prepare("INSERT INTO company_task_activity(id, task_id, kind, message, created_at) VALUES (?, ?, ?, 'm', ?)")
  let n = 0
  for (const t of TASKS) {
    n++
    const data = {
      title: t.id, description: '', companyId: 'co_acme', repoId: null, status: t.status, priority: 0, source: 'manual', sourceUrl: null,
      externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: t.deps ?? [], id: t.id, identifier: `PRN-${n}`,
      runId: t.runId ?? null, createdAt: T, updatedAt: T, ...t.extra
    }
    ins.run(t.id, 'co_acme', t.runId ?? null, JSON.stringify(data))
    for (const [i, kind] of (t.activity ?? []).entries()) act.run(`${t.id}_a${i}`, t.id, kind, T)
  }
  // a row with broken JSON is left alone
  ins.run('task_broken', 'co_acme', null, 'not json')
}

type TaskRow = { id: string; seq: number; run_id: string | null; status: string | null; department_id: string | null; agent_id: string | null; data: string }
const taskRows = (db: DB) => db.prepare('SELECT * FROM company_tasks ORDER BY seq').all() as TaskRow[]
const cols = (db: DB, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
const indexes = (db: DB) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name)
const meta = (db: DB, key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value

function expectSchema(db: DB): void {
  expect(cols(db, 'company_departments')).toEqual(['id', 'company_id', 'key', 'name', 'color', 'icon', 'sort_order', 'archived_at', 'created_at', 'updated_at', 'data'])
  expect(cols(db, 'company_agents')).toEqual([
    'id', 'company_id', 'department_id', 'kind', 'ref_id', 'name', 'archived_at', 'paused_at', 'created_at', 'updated_at', 'data'
  ])
  for (const c of ['status', 'department_id', 'agent_id']) expect(cols(db, 'company_tasks')).toContain(c)
  for (const c of ['task_id', 'agent_id']) expect(cols(db, 'runs')).toContain(c)
  expect(cols(db, 'sessions')).toContain('task_id')
  for (const t of ['workflows', 'schedules', 'slack_triggers']) expect(cols(db, t)).toContain('department_id')
  expect(cols(db, 'asks')).toContain('task_id')
  expect(indexes(db)).toEqual(expect.arrayContaining(['company_agents_dept', 'company_tasks_status', 'company_tasks_agent', 'runs_task']))
  expect(currentVersion(db)).toBe(SCHEMA_VERSION)
}

d('departments migration (DEPARTMENTS.md §1, §11)', () => {
  it('creates the tables, columns and indexes on a fresh db without a version bump', () => {
    const db = openDatabase(file)
    try {
      expectSchema(db)
      expect(meta(db, 'departments_migrated')).toBe('1')
      // department keys are unique per company, data defaults to '{}'
      db.prepare("INSERT INTO company_departments(id, company_id, key, name) VALUES ('dep_1', 'co_a', 'marketing', 'Marketing')").run()
      db.prepare("INSERT INTO company_departments(id, company_id, key, name) VALUES ('dep_2', 'co_b', 'marketing', 'Marketing')").run()
      expect(() => db.prepare("INSERT INTO company_departments(id, company_id, key, name) VALUES ('dep_3', 'co_a', 'marketing', 'M2')").run()).toThrow(/UNIQUE/)
      db.prepare("INSERT INTO company_agents(id, company_id, kind, ref_id, name) VALUES ('agt_1', 'co_a', 'profile', 'p', 'Copywriter')").run()
      expect(db.prepare("SELECT data, department_id FROM company_agents WHERE id = 'agt_1'").get()).toEqual({ data: '{}', department_id: null })
      expect(db.prepare("SELECT data FROM company_departments WHERE id = 'dep_1'").get()).toEqual({ data: '{}' })
    } finally {
      db.close()
    }
  })

  it('heals a company-era v2 db and backfills the live-shaped board', () => {
    const legacy = companyEraDb(file)
    seedBoard(legacy)
    const before = legacy.prepare('SELECT id, seq, run_id, data FROM company_tasks ORDER BY seq').all() as TaskRow[]
    legacy.close()

    const db = openDatabase(file)
    try {
      expectSchema(db)
      const rows = taskRows(db)
      const byId = new Map(rows.map((r) => [r.id, r]))
      // identity, identifier, status and run link survive
      expect(rows.map((r) => [r.id, r.seq, r.run_id])).toEqual(before.map((r) => [r.id, r.seq, r.run_id]))
      for (const b of before) {
        if (b.id === 'task_broken') continue
        const old = JSON.parse(b.data)
        const now = JSON.parse(byId.get(b.id)!.data)
        expect(now.identifier).toBe(old.identifier)
        expect(now.status).toBe(old.status)
        expect(now.runId).toBe(old.runId)
        expect(byId.get(b.id)!.status).toBe(old.status)
        // apart from blockReason the JSON is unchanged
        const { blockReason: _r, ...rest } = now
        const { blockReason: _o, ...oldRest } = old
        expect(rest).toEqual(oldRest)
      }
      // broken JSON: untouched, no mirrors
      expect(byId.get('task_broken')).toMatchObject({ data: 'not json', status: null, department_id: null, agent_id: null })

      // legacy assigneeProfileId tasks get no agent; JSON department / agent are mirrored
      expect(byId.get('task_review')).toMatchObject({ agent_id: null, department_id: null })
      expect(byId.get('task_reasoned')).toMatchObject({ agent_id: 'agt_y', department_id: 'dep_x' })

      // runs.task_id mirrors the former company_tasks.run_id
      const links = db.prepare('SELECT id, task_id FROM runs ORDER BY id').all() as { id: string; task_id: string | null }[]
      const expected = Object.fromEntries(links.map((l) => [l.id, null as string | null]))
      for (const r of rows) if (r.run_id) expected[r.run_id] = r.id
      expect(Object.fromEntries(links.map((l) => [l.id, l.task_id]))).toEqual(expected)
      expect(expected.run_unrelated).toBeNull()

      // blockReason
      const reason = (id: string) => JSON.parse(byId.get(id)!.data).blockReason
      expect(Object.fromEntries(TASKS.filter((t) => t.status === 'blocked').map((t) => [t.id, reason(t.id)]))).toEqual({
        task_deps: 'deps',
        task_deps_gone: 'deps',
        task_deps_met: 'run_failed',
        task_interrupted: 'interrupted',
        task_interrupted_deps: 'interrupted',
        task_failed: 'run_failed',
        task_failed_deps: 'run_failed',
        task_manual: 'run_failed',
        task_reasoned: 'needs_input'
      })
      for (const t of TASKS.filter((t) => t.status !== 'blocked')) expect(reason(t.id), t.id).toBeUndefined()

      // nothing created, autopilot left unset
      expect(db.prepare('SELECT COUNT(*) AS n FROM company_departments').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM company_agents').get()).toEqual({ n: 0 })
      for (const p of db.prepare('SELECT data FROM company_passports').all() as { data: string }[]) {
        expect(JSON.parse(p.data).autopilot).toBeUndefined()
      }
      expect(meta(db, 'departments_migrated')).toBe('1')
    } finally {
      db.close()
    }
  })

  it('is idempotent: a second open and a direct re-run change nothing', () => {
    const legacy = companyEraDb(file)
    seedBoard(legacy)
    legacy.close()
    const snap = (db: DB) => ({
      tasks: taskRows(db),
      runs: db.prepare('SELECT id, task_id FROM runs ORDER BY id').all(),
      meta: db.prepare("SELECT * FROM meta WHERE key = 'departments_migrated'").all()
    })
    let db = openDatabase(file)
    const first = snap(db)
    expect(first.meta).toHaveLength(1)
    expect(migrateDepartmentsData(db)).toBeNull()
    expect(migrateCompanyData(db)).toBeNull()
    expect(snap(db)).toEqual(first)
    db.close()
    db = openDatabase(file)
    try {
      expect(snap(db)).toEqual(first)
    } finally {
      db.close()
    }
  })

  it('reports what it changed on the first run only', () => {
    const legacy = companyEraDb(file)
    seedBoard(legacy)
    // heal columns by hand so the step can be called directly
    for (const [t, c, ddl] of COMPANY_ADDED_COLUMNS) {
      if (!cols(legacy, t).includes(c)) legacy.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`)
    }
    try {
      const report = migrateDepartmentsData(legacy)
      expect(report).toEqual({ tasks: TASKS.length, runLinks: 4, blockReasons: { deps: 2, interrupted: 2, run_failed: 4 } })
      expect(migrateDepartmentsData(legacy)).toBeNull()
    } finally {
      legacy.close()
    }
  })

  it('re-syncs mirrors and run links an older build left stale after the one-time step', () => {
    const legacy = companyEraDb(file)
    seedBoard(legacy)
    legacy.close()
    let db = openDatabase(file)
    // what an older build does: rewrite data / run_id only (its writeTask knows no mirrors), then start a run
    const old = JSON.parse((db.prepare("SELECT data FROM company_tasks WHERE id = 'task_open'").get() as { data: string }).data)
    db.prepare(
      "INSERT INTO runs(id, kind, title, target_json, trigger, status, created_at, artifacts_dir, company_id) VALUES ('run_old_build', 'prompt', 't', '{}', 'manual', 'running', ?, '/a', 'co_acme')"
    ).run(T)
    db.prepare("UPDATE company_tasks SET run_id = 'run_old_build', data = ? WHERE id = 'task_open'").run(
      JSON.stringify({ ...old, status: 'in_progress', runId: 'run_old_build' })
    )
    // a newer build's department move, then an older build stripping the field it does not know
    db.prepare("UPDATE company_tasks SET department_id = 'dep_x', agent_id = 'agt_y' WHERE id = 'task_done'").run()
    db.prepare("INSERT INTO company_tasks(id, company_id, source_key, data) VALUES ('task_old_broken', 'co_acme', NULL, '{bad')").run()
    expect(db.prepare("SELECT status FROM company_tasks WHERE id = 'task_open'").get()).toEqual({ status: 'todo' })
    db.close()

    db = openDatabase(file)
    try {
      expect(db.prepare("SELECT status FROM company_tasks WHERE id = 'task_open'").get()).toEqual({ status: 'in_progress' })
      expect(db.prepare("SELECT department_id, agent_id FROM company_tasks WHERE id = 'task_done'").get()).toEqual({ department_id: null, agent_id: null })
      expect(db.prepare("SELECT task_id FROM runs WHERE id = 'run_old_build'").get()).toEqual({ task_id: 'task_open' })
      expect(db.prepare("SELECT data, status FROM company_tasks WHERE id = 'task_old_broken'").get()).toEqual({ data: '{bad', status: null })
      // in sync now: nothing left to heal, and the one-time flag was not re-run
      expect(healDepartmentsMirrors(db)).toBe(0)
      expect(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'departments_migrated'").get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('a db opened by the departments build stays readable by the old task queries', () => {
    const legacy = companyEraDb(file)
    seedBoard(legacy)
    legacy.close()
    const db = openDatabase(file)
    try {
      // the queries CompanyStore runs today
      const all = db.prepare('SELECT data FROM company_tasks WHERE company_id = ? ORDER BY seq DESC').all('co_acme') as { data: string }[]
      expect(all).toHaveLength(TASKS.length + 1)
      expect(db.prepare('SELECT data FROM company_tasks WHERE run_id = ?').all('run_failed')).toHaveLength(1)
      // an older build's insert, without the new columns, still works
      db.prepare("INSERT INTO company_tasks(id, company_id, source_key, data) VALUES ('task_old', 'co_acme', NULL, '{}')").run()
      expect(taskRows(db).at(-1)).toMatchObject({ id: 'task_old', status: null, agent_id: null })
    } finally {
      db.close()
    }
  })
})
