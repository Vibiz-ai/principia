import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentVersion, openDatabase, type DB } from '../index'
import {
  AUTHORING_ADDED_COLUMNS, DDL_AUTHORING, DDL_SLACK, DDL_V1, DDL_V2_SCHEDULE_EVENTS, DDL_V2_TABLES, SCHEMA_VERSION, SLACK_ADDED_COLUMNS, V2_ADDED_COLUMNS
} from '../schema'
import { PERSONAL_COMPANY_ID as P, companySlug, migrateCompanyData, workflowRepoRefs, type CompanyMigrationReport } from '../companyMigration'

let nativeOk = true
try {
  new Database(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 built for Electron only: covered by `npm run smoke`
}
const d = nativeOk ? describe : describe.skip

const T = '2026-10-01T00:00:00.000Z'
const DOMAINS = ['sessions', 'workflows', 'schedules', 'runs', 'agents', 'asks', 'artifacts', 'author_drafts', 'slack_workspaces'] as const

let tmp: string
let file: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-company-'))
  file = path.join(tmp, 'hive.db')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A hive.db as the build before companies left it: schema v2 + authoring + Slack, company tables created lazily. */
function legacyDb(f: string, companyTables = true): DB {
  const db = new Database(f)
  db.pragma('foreign_keys = ON')
  db.exec(DDL_V1)
  db.exec(DDL_V2_TABLES)
  db.exec('ALTER TABLE schedules ADD COLUMN skip_slot_at TEXT')
  db.exec(DDL_V2_SCHEDULE_EVENTS)
  db.exec(DDL_AUTHORING)
  db.exec(DDL_SLACK)
  for (const [t, c, ddl] of [...V2_ADDED_COLUMNS, ...AUTHORING_ADDED_COLUMNS, ...SLACK_ADDED_COLUMNS]) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`)
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?), ('slack_migrated', '1')").run(String(SCHEMA_VERSION))
  if (!companyTables) return db // the live db: CompanyStore never ran, so no company_* tables at all
  // the old CompanyStore's lazy CREATE (company/index.ts)
  db.exec(`CREATE TABLE IF NOT EXISTS company_passports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_repos (repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, company_id TEXT NOT NULL REFERENCES company_passports(id));
    CREATE TABLE IF NOT EXISTS company_tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, company_id TEXT NOT NULL REFERENCES company_passports(id), source_key TEXT, run_id TEXT, data TEXT NOT NULL);`)
  return db
}

const passportData = (id: string, name: string, repoIds: string[]) =>
  JSON.stringify({ id, name, mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', repoIds, createdAt: T, updatedAt: T })

/** Live-shaped fixture: owned and unowned repos, repo-less sessions, mixed workflows, runs via task/schedule/workflow/nothing. */
function seedFixture(db: DB): void {
  const repo = db.prepare('INSERT INTO repos(id, name, path, added_at) VALUES (?, ?, ?, ?)')
  for (const r of ['rA', 'rA2', 'rB', 'rU']) repo.run(r, r, path.join('/work', r), T)
  db.prepare('INSERT INTO company_passports(id, data) VALUES (?, ?)').run('co_acme', passportData('co_acme', 'Acme Inc.', ['rA', 'rA2']))
  db.prepare('INSERT INTO company_passports(id, data) VALUES (?, ?)').run('co_beta', passportData('co_beta', 'Beta', ['rB']))
  db.prepare('INSERT INTO company_repos(repo_id, company_id) VALUES (?, ?), (?, ?), (?, ?)').run('rA', 'co_acme', 'rA2', 'co_acme', 'rB', 'co_beta')
  db.prepare("INSERT INTO meta(key, value) VALUES ('repo_order', ?)").run(JSON.stringify(['rU', 'rB', 'rA2', 'gone', 'rA']))

  const session = db.prepare(
    "INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, cols, rows, started_at, artifacts_dir, log_path) VALUES (?, 't', 'p', 'claude', ?, '/x', 'exited', 80, 24, ?, '/a', '/l')"
  )
  session.run('s1', 'rA', T)
  session.run('s2', 'rU', T)
  session.run('s3', null, T)
  session.run('s4', 'rB', T)

  const wf = db.prepare('INSERT INTO workflows(id, name, inputs_json, nodes_json, worktree_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const node = (cwd: string | null) => ({ id: 'n', type: 'agent', label: 'n', after: [], cwd, timeoutMin: 30, profileId: 'p', prompt: '' })
  wf.run('wA', 'Acme only', '[]', JSON.stringify([node('rA'), node('/work/rA2/sub/dir')]), null, T, T)
  wf.run('wMix', 'Mixed', '[]', JSON.stringify([node('rA'), node('rB')]), null, T, T)
  wf.run('wNone', 'Scratch', '[]', JSON.stringify([node(null), node('{{inputs.other}}')]), null, T, T)
  wf.run('wTpl', 'Template', JSON.stringify([{ name: 'repo', label: 'Repo', type: 'repo', default: 'rB' }]), JSON.stringify([node('{{inputs.repo}}')]), null, T, T)
  wf.run('wWt', 'Worktree', '[]', JSON.stringify([node(null)]), JSON.stringify({ repo: 'rB' }), T, T)
  wf.run('wBad', 'Broken json', '[]', 'not json', null, T, T)

  const sched = db.prepare("INSERT INTO schedules(id, name, target_json, when_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)")
  sched.run('schA', 'a', JSON.stringify({ kind: 'workflow', workflowId: 'wA', inputs: {} }), T, T)
  sched.run('schB', 'b', JSON.stringify({ kind: 'prompt', profileId: 'p', repoId: 'rB', prompt: 'x' }), T, T)
  sched.run('schMix', 'm', JSON.stringify({ kind: 'workflow', workflowId: 'wMix', inputs: {} }), T, T)

  const run = db.prepare(
    "INSERT INTO runs(id, kind, title, target_json, workflow_id, schedule_id, trigger, status, created_at, artifacts_dir) VALUES (?, ?, 't', ?, ?, ?, 'manual', 'passed', ?, '/a')"
  )
  const prompt = (repoId: string | null) => JSON.stringify({ kind: 'prompt', profileId: 'p', repoId, prompt: 'x' })
  const wfTarget = (workflowId: string) => JSON.stringify({ kind: 'workflow', workflowId, inputs: {} })
  run.run('runTask', 'prompt', prompt('rA'), null, null, T) // the task's company (Beta) wins over the repo's
  run.run('runPromptB', 'prompt', prompt('rB'), null, null, T)
  run.run('runPromptU', 'prompt', prompt('rU'), null, null, T)
  run.run('runWf', 'workflow', wfTarget('wA'), 'wA', null, T)
  run.run('runWfTarget', 'workflow', wfTarget('wTpl'), null, null, T)
  run.run('runSched', 'workflow', wfTarget('deleted'), 'deleted', 'schB', T)
  run.run('runNothing', 'prompt', prompt(null), null, null, T)
  run.run('runDeletedRepo', 'prompt', prompt('gone'), null, null, T)
  db.prepare("INSERT INTO company_tasks(id, company_id, run_id, data) VALUES ('task_1', 'co_beta', 'runTask', '{}')").run()

  const agent = db.prepare(
    "INSERT INTO agents(id, kind, parent_id, root_id, session_id, run_id, provider, cwd, title, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'claude', '/x', 't', 'done', ?, ?)"
  )
  agent.run('ag1', 'session', null, 'ag1', 's1', null, T, T)
  agent.run('ag1s', 'subagent', 'ag1', 'ag1', null, null, T, T)
  agent.run('ag2', 'step', null, 'ag2', null, 'runWf', T, T)
  agent.run('ag2s', 'subagent', 'ag2', 'ag2', null, null, T, T)
  agent.run('ag3', 'subagent', null, 'missing', null, null, T, T)
  const ask = db.prepare("INSERT INTO asks(id, agent_id, root_id, provider, kind, channel, title, status, created_at) VALUES (?, ?, ?, 'claude', 'permission', 'stdio', 't', 'open', ?)")
  ask.run('ask1', 'ag2s', 'ag2', T)
  ask.run('ask2', 'ag3', 'missing', T)

  const art = db.prepare("INSERT INTO artifacts(id, run_id, session_id, path, rel_path, name, kind, mime, bytes, mtime, created_at) VALUES (?, ?, ?, ?, 'r', 'n', 'file', 'text/plain', 1, ?, ?)")
  art.run('art1', 'runPromptB', null, '/art/1', T, T)
  art.run('art2', null, 's4', '/art/2', T, T)
  art.run('art3', null, null, '/art/3', T, T)

  const draft = db.prepare(
    "INSERT INTO author_drafts(id, kind, status, owner_kind, session_id, workflow_id, owner_key, owner_label, adapter, payload_json, content_hash, created_at) VALUES (?, 'create', 'pending', 'session', ?, ?, 'k', 'l', 'claude', '{}', 'h', ?)"
  )
  draft.run('d1', 's1', null, T)
  draft.run('d2', null, 'wTpl', T)
  draft.run('d3', null, null, T)

  db.prepare("INSERT INTO slack_workspaces(team_id, team_name, bot_user_id, bot_id, connected_at, updated_at) VALUES ('T1', 'Team', 'U', 'B', ?, ?)").run(T, T)
  db.prepare("INSERT INTO secrets(name, label, cipher, masked, created_at, updated_at) VALUES ('OPENAI_API_KEY', '', x'00', 'sk-…', ?, ?)").run(T, T)
}

const companyOf = (db: DB, table: string, id: string, key = 'id') =>
  (db.prepare(`SELECT company_id FROM ${table} WHERE ${key} = ?`).get(id) as { company_id: string | null }).company_id

/** Everything the migration may write, for idempotency checks. */
function snapshot(db: DB): unknown {
  const out: Record<string, unknown> = {}
  for (const t of [...DOMAINS, 'company_passports', 'company_repos', 'company_tasks', 'secrets']) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
  out.meta = db.prepare('SELECT * FROM meta ORDER BY key').all()
  return out
}

d('company migration (COMPANY.md §9)', () => {
  it('stamps every row of the live-shaped fixture with a company', () => {
    const legacy = legacyDb(file)
    seedFixture(legacy)
    legacy.close()
    const db = openDatabase(file)
    try {
      for (const t of DOMAINS) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id IS NULL`).get() as { n: number }).n, t).toBe(0)

      expect(['s1', 's2', 's3', 's4'].map((id) => companyOf(db, 'sessions', id))).toEqual(['co_acme', P, P, 'co_beta'])
      expect(['wA', 'wMix', 'wNone', 'wTpl', 'wWt', 'wBad'].map((id) => companyOf(db, 'workflows', id))).toEqual(['co_acme', P, P, 'co_beta', 'co_beta', P])
      expect(['schA', 'schB', 'schMix'].map((id) => companyOf(db, 'schedules', id))).toEqual(['co_acme', 'co_beta', P])
      expect(
        ['runTask', 'runPromptB', 'runPromptU', 'runWf', 'runWfTarget', 'runSched', 'runNothing', 'runDeletedRepo'].map((id) => companyOf(db, 'runs', id))
      ).toEqual(['co_beta', 'co_beta', P, 'co_acme', 'co_beta', 'co_beta', P, P])
      expect(['ag1', 'ag1s', 'ag2', 'ag2s', 'ag3'].map((id) => companyOf(db, 'agents', id))).toEqual(['co_acme', 'co_acme', 'co_acme', 'co_acme', P])
      expect(['ask1', 'ask2'].map((id) => companyOf(db, 'asks', id))).toEqual(['co_acme', P])
      expect(['art1', 'art2', 'art3'].map((id) => companyOf(db, 'artifacts', id))).toEqual(['co_beta', 'co_beta', P])
      expect(['d1', 'd2', 'd3'].map((id) => companyOf(db, 'author_drafts', id))).toEqual(['co_acme', 'co_beta', P])
      expect(companyOf(db, 'slack_workspaces', 'T1', 'team_id')).toBe(P)

      // Personal row + slug / colour / sort order for existing passports (Personal last)
      const cos = db.prepare('SELECT id, slug, color, sort_order, system FROM company_passports ORDER BY sort_order').all() as {
        id: string; slug: string; color: string; sort_order: number; system: string | null
      }[]
      expect(cos.map((c) => [c.id, c.slug, c.sort_order, c.system])).toEqual([
        ['co_acme', 'acme-inc', 0, null],
        ['co_beta', 'beta', 1, null],
        [P, 'personal', 2, 'personal']
      ])
      for (const c of cos) expect(c.color).toMatch(/^var\(--/)
      const personal = JSON.parse((db.prepare('SELECT data FROM company_passports WHERE id = ?').get(P) as { data: string }).data)
      expect(personal).toMatchObject({ id: P, name: 'Personal', repoIds: [] })

      // repo order split per company; legacy key kept for older builds
      const meta = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value
      expect(JSON.parse(meta('repo_order:co_acme')!)).toEqual(['rA2', 'rA'])
      expect(JSON.parse(meta('repo_order:co_beta')!)).toEqual(['rB'])
      expect(JSON.parse(meta(`repo_order:${P}`)!)).toEqual(['rU', 'gone'])
      expect(JSON.parse(meta('repo_order')!)).toEqual(['rU', 'rB', 'rA2', 'gone', 'rA'])

      // secrets untouched (shared); no company keys invented
      expect(db.prepare('SELECT name FROM secrets').all()).toEqual([{ name: 'OPENAI_API_KEY' }])
      expect(db.prepare('SELECT COUNT(*) AS n FROM company_secrets').get()).toEqual({ n: 0 })

      expect(meta('company_migrated')).toBe('1')
      const report = JSON.parse(meta('company_migration_report')!) as CompanyMigrationReport
      expect(report.version).toBe(1)
      expect(report.stamped).toMatchObject({ sessions: 4, workflows: 6, schedules: 3, runs: 8, agents: 5, asks: 2, artifacts: 3, author_drafts: 3, slack_workspaces: 1 })
      expect(report.byCompany.sessions).toEqual({ co_acme: 1, co_beta: 1, [P]: 2 })
      expect(report.flagged.workflows).toEqual([
        { id: 'wMix', name: 'Mixed', reason: 'mixed', companyIds: ['co_acme', 'co_beta'] },
        { id: 'wNone', name: 'Scratch', reason: 'no_repo', companyIds: [] },
        { id: 'wBad', name: 'Broken json', reason: 'no_repo', companyIds: [] }
      ])
      expect(report.repoOrderSplit).toEqual(['repo_order:co_acme', 'repo_order:co_beta', `repo_order:${P}`])
    } finally {
      db.close()
    }
  })

  it('a second open changes nothing', () => {
    const legacy = legacyDb(file)
    seedFixture(legacy)
    legacy.close()
    const first = openDatabase(file)
    const before = snapshot(first)
    expect(migrateCompanyData(first)).toBeNull()
    expect(snapshot(first)).toEqual(before)
    first.close()
    const second = openDatabase(file)
    try {
      expect(snapshot(second)).toEqual(before)
    } finally {
      second.close()
    }
  })

  it('a live db with no company tables yet: everything lands in Personal, nothing is lost', () => {
    const legacy = legacyDb(file, false)
    legacy.prepare('INSERT INTO repos(id, name, path, added_at) VALUES (?, ?, ?, ?)').run('r1', 'r1', '/work/r1', T)
    legacy
      .prepare(
        "INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, cols, rows, started_at, artifacts_dir, log_path) VALUES ('s1', 't', 'p', 'claude', 'r1', '/x', 'exited', 80, 24, ?, '/a', '/l')"
      )
      .run(T)
    legacy
      .prepare("INSERT INTO workflows(id, name, inputs_json, nodes_json, created_at, updated_at) VALUES ('w1', 'w', '[]', ?, ?, ?)")
      .run(JSON.stringify([{ id: 'n', cwd: 'r1' }]), T, T)
    legacy
      .prepare("INSERT INTO runs(id, kind, title, target_json, workflow_id, trigger, status, created_at, artifacts_dir) VALUES ('run1', 'workflow', 't', ?, 'w1', 'manual', 'passed', ?, '/a')")
      .run(JSON.stringify({ kind: 'workflow', workflowId: 'w1', inputs: {} }), T)
    legacy.prepare("INSERT INTO meta(key, value) VALUES ('repo_order', ?)").run(JSON.stringify(['r1']))
    legacy.close()
    const db = openDatabase(file)
    try {
      for (const t of DOMAINS) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id IS NOT NULL AND company_id <> ?`).get(P) as { n: number }).n, t).toBe(0)
      expect([companyOf(db, 'sessions', 's1'), companyOf(db, 'workflows', 'w1'), companyOf(db, 'runs', 'run1')]).toEqual([P, P, P])
      expect(db.prepare('SELECT id FROM company_passports').all()).toEqual([{ id: P }])
      expect(db.prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 1 })
      const meta = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string }).value
      expect(JSON.parse(meta(`repo_order:${P}`))).toEqual(['r1'])
      // an unowned repo is Personal, not "mixed": no banner
      const report = JSON.parse(meta('company_migration_report')) as CompanyMigrationReport
      expect(report.flagged.workflows.filter((w) => w.reason === 'mixed')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('copies hive.db to Hive-backups before migrating user data, once', () => {
    const legacy = legacyDb(file)
    seedFixture(legacy)
    legacy.close()
    const backups = () => (fs.existsSync(path.join(tmp, 'Hive-backups')) ? fs.readdirSync(path.join(tmp, 'Hive-backups')) : [])
    openDatabase(file).close()
    expect(backups()).toHaveLength(1)
    expect(backups()[0]).toMatch(/^hive\.pre-company\..+\.db$/)
    // the copy is the pre-migration db: same rows, no company columns yet
    const copy = new Database(path.join(tmp, 'Hive-backups', backups()[0]), { readonly: true })
    try {
      expect(copy.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 8 })
      expect((copy.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some((c) => c.name === 'company_id')).toBe(false)
      expect(copy.prepare("SELECT 1 FROM meta WHERE key = 'company_migrated'").get()).toBeUndefined()
    } finally {
      copy.close()
    }
    openDatabase(file).close()
    expect(backups()).toHaveLength(1)
  })

  it('a fresh db needs no backup', () => {
    openDatabase(file).close()
    expect(fs.existsSync(path.join(tmp, 'Hive-backups'))).toBe(false)
  })

  it('a task pointing at a missing company does not strand its run', () => {
    const legacy = legacyDb(file)
    seedFixture(legacy)
    legacy.pragma('foreign_keys = OFF')
    legacy.prepare("UPDATE company_tasks SET company_id = 'co_deleted' WHERE id = 'task_1'").run()
    legacy.close()
    const db = openDatabase(file)
    try {
      // falls through to the target repo (rA, Acme)
      expect(companyOf(db, 'runs', 'runTask')).toBe('co_acme')
    } finally {
      db.close()
    }
  })

  it('a fresh db gets Personal, the company columns and indexes', () => {
    const db = openDatabase(':memory:')
    try {
      expect(db.prepare('SELECT id, slug, system FROM company_passports').all()).toEqual([{ id: P, slug: 'personal', system: 'personal' }])
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name)
      expect(idx).toEqual(expect.arrayContaining(['runs_company', 'sessions_company', 'agents_company', 'asks_company', 'company_passports_slug']))
      expect(currentVersion(db)).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('rows written after the migration with no company read as Personal through COALESCE', () => {
    const db = openDatabase(file)
    try {
      db.prepare(
        "INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, cols, rows, started_at, artifacts_dir, log_path) VALUES ('late', 't', 'p', 'claude', NULL, '/x', 'exited', 80, 24, ?, '/a', '/l')"
      ).run(T)
      expect(db.prepare("SELECT COALESCE(company_id, 'co_personal') AS c FROM sessions WHERE id = 'late'").get()).toEqual({ c: P })
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(company_id, 'co_personal') = ?").get(P)).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('older builds keep working against the migrated db', () => {
    openDatabase(file).close()
    // older code: no company columns read or written, lazy CREATE, ON CONFLICT(name) on secrets, passports as JSON
    const old = new Database(file)
    old.pragma('foreign_keys = ON')
    expect(Number((old.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value)).toBe(SCHEMA_VERSION)
    old.exec('CREATE TABLE IF NOT EXISTS company_passports (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    old.prepare("INSERT INTO company_passports(id, data) VALUES ('co_old', ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(passportData('co_old', 'Acme', []))
    old.prepare("INSERT INTO secrets(name, label, cipher, masked, created_at, updated_at) VALUES ('K', '', x'00', 'm', ?, ?) ON CONFLICT(name) DO UPDATE SET masked = excluded.masked").run(T, T)
    old.prepare(
      "INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, cols, rows, started_at, artifacts_dir, log_path) VALUES ('old', 't', 'p', 'claude', NULL, '/x', 'exited', 80, 24, ?, '/a', '/l')"
    ).run(T)
    for (const r of old.prepare('SELECT data FROM company_passports ORDER BY rowid').all() as { data: string }[]) expect(JSON.parse(r.data).repoIds).toEqual([])
    old.close()

    // back on the new build: the old company gets a slug (no clash), the old session stays NULL (reads as Personal)
    const db = openDatabase(file)
    try {
      expect(db.prepare("SELECT slug, sort_order FROM company_passports WHERE id = 'co_old'").get()).toEqual({ slug: 'acme', sort_order: 0 })
      expect(companyOf(db, 'sessions', 'old')).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe('company migration helpers', () => {
  it('slugs are folder-safe, unique and never "personal"', () => {
    const taken = new Set<string>()
    expect(companySlug('Acme Inc.', taken)).toBe('acme-inc')
    expect(companySlug('ACME inc', taken)).toBe('acme-inc-2')
    expect(companySlug('Café Società', taken)).toBe('cafe-societa')
    expect(companySlug('Personal', taken)).toBe('personal-2')
    expect(companySlug('!!!', taken)).toBe('company')
    expect(companySlug('x'.repeat(80), taken)).toHaveLength(48)
  })

  it('workflow repo refs: ids, paths inside repos, input-default templates, worktree', () => {
    const repos = [
      { id: 'r1', path: '/w/app' },
      { id: 'r2', path: '/w/app/packages/ui' },
      { id: 'r3', path: '/w/other' }
    ]
    const nodes = (...cwds: (string | null)[]) => JSON.stringify(cwds.map((cwd) => ({ cwd })))
    const refs = (w: { inputs_json?: string; nodes_json: string; worktree_json?: string | null }) =>
      [...workflowRepoRefs({ inputs_json: '[]', ...w }, repos)].sort()
    expect(refs({ nodes_json: nodes('r1', null, '/w/app/packages/ui/src') })).toEqual(['r1', 'r2'])
    expect(refs({ nodes_json: nodes('/w/application', 'relative/path', '{{inputs.x}}') })).toEqual([])
    expect(refs({ inputs_json: JSON.stringify([{ name: 'x', default: '/w/other/' }]), nodes_json: nodes('{{ inputs.x }}') })).toEqual(['r3'])
    expect(refs({ nodes_json: '[]', worktree_json: JSON.stringify({ repo: 'r3' }) })).toEqual(['r3'])
    expect(refs({ nodes_json: '{bad' })).toEqual([])
  })
})

// A copy of a real hive.db (HIVE_MIGRATE_LIVE_HIVE_DB=/path/to/copy/hive.db; it is copied again, never opened in place):
// it opens, every row gets a company, nothing is lost, the backup holds the original rows, a re-open changes nothing.
const liveHiveDb = process.env.HIVE_MIGRATE_LIVE_HIVE_DB
const live = nativeOk && liveHiveDb && fs.existsSync(liveHiveDb) ? describe : describe.skip
live('live hive.db copy', () => {
  it('opens, stamps every row, loses nothing and re-opens unchanged', () => {
    for (const ext of ['', '-wal']) if (fs.existsSync(`${liveHiveDb}${ext}`)) fs.copyFileSync(`${liveHiveDb}${ext}`, `${file}${ext}`)
    const src = new Database(file, { readonly: true })
    const tables = (src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name)
    const count = (db: DB, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
    const before = Object.fromEntries(tables.map((t) => [t, count(src, t)]))
    src.close()
    const db = openDatabase(file)
    try {
      // meta gains company_migrated, the report and repo_order:<company>; no other table gains or loses a row
      const data = tables.filter((t) => t !== 'meta')
      expect(Object.fromEntries(data.map((t) => [t, count(db, t)]))).toEqual(Object.fromEntries(data.map((t) => [t, before[t]])))
      expect(count(db, 'meta')).toBeGreaterThan(before.meta)
      for (const t of DOMAINS) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id IS NULL`).get() as { n: number }).n, t).toBe(0)
      const report = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'company_migration_report'").get() as { value: string }).value) as CompanyMigrationReport
      for (const t of DOMAINS) expect(Object.values(report.byCompany[t]).reduce((a, b) => a + b, 0), t).toBe(count(db, t))
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      const snap = snapshot(db)
      db.close()
      const again = openDatabase(file)
      try {
        expect(snapshot(again)).toEqual(snap)
      } finally {
        again.close()
      }
      const backups = fs.readdirSync(path.join(tmp, 'Hive-backups'))
      expect(backups).toHaveLength(1)
      const copy = new Database(path.join(tmp, 'Hive-backups', backups[0]), { readonly: true })
      try {
        expect(Object.fromEntries(tables.map((t) => [t, count(copy, t)]))).toEqual(before)
      } finally {
        copy.close()
      }
    } finally {
      if (db.open) db.close()
    }
  })
})
