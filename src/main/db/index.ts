import Database from 'better-sqlite3'
import { AUTHORING_ADDED_COLUMNS, COMPANY_ADDED_COLUMNS, DDL_AUTHORING, DDL_COMPANY, DDL_COMPANY_INDEXES, DDL_ORCHESTRATOR, DDL_SLACK, DDL_V1, DDL_V2_SCHEDULE_EVENTS, DDL_V2_TABLES, PRAGMAS, SCHEMA_VERSION, SLACK_ADDED_COLUMNS, V2_ADDED_COLUMNS } from './schema'
import { backupBeforeCompanyMigration, migrateCompanyData } from './companyMigration'
import { migrateSlackData } from './slackMigration'
import { ensureForumSchema } from '../forum/schema'
import { log } from '../log'

export type DB = Database.Database

/**
 * Ordered migrations. Index i migrates schema_version i -> i+1. v1 = the full DDL (idempotent CREATE IF NOT EXISTS).
 * Future versions append here and bump SCHEMA_VERSION in schema.ts.
 */
export const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => db.exec(DDL_V1),
  // v1 -> v2: live agents (docs/LIVE.md §2)
  (db) => {
    db.exec(DDL_V2_TABLES)
    if (!hasColumn(db, 'schedules', 'skip_slot_at')) db.exec('ALTER TABLE schedules ADD COLUMN skip_slot_at TEXT')
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_events'").get() as { sql: string } | undefined)?.sql ?? ''
    if (!sql.includes("'skipped'")) db.exec(DDL_V2_SCHEDULE_EVENTS)
  }
]

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
}

export function currentVersion(db: DB): number {
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()
  if (!hasMeta) return 0
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  return row ? Number(row.value) || 0 : 0
}

export function migrate(db: DB): number {
  let v = currentVersion(db)
  if (v > SCHEMA_VERSION) throw new Error(`hive.db schema v${v} is newer than this Hive (v${SCHEMA_VERSION})`)
  // v1 DDL is idempotent; always run it so a partially created db heals.
  if (v === 0 || v === 1) {
    MIGRATIONS[0](db)
    healColumns(db)
  }
  if (v === 0) v = 1
  // v2 tables are CREATE IF NOT EXISTS too: heal a partially created v2 db
  if (v === SCHEMA_VERSION && SCHEMA_VERSION >= 2) MIGRATIONS[1](db)
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v]
    db.transaction(() => step(db))()
    v++
  }
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'schema_version',
    String(v)
  )
  healV2Columns(db)
  return v
}

/** CONTRACT §13 columns (no version bump: older builds keep opening the db). Idempotent. */
function healV2Columns(db: DB): void {
  for (const [table, column, ddl] of V2_ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS runs_retry ON runs(retry_at) WHERE retry_at IS NOT NULL AND retry_run_id IS NULL')
  // CONTRACT §14.4 (AUTHORING.md §10): authoring tables + columns, still schema v2
  db.exec(DDL_AUTHORING)
  for (const [table, column, ddl] of AUTHORING_ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS asks_draft ON asks(draft_id) WHERE draft_id IS NOT NULL')
  // CONTRACT "Slack.4" (SLACK.md §7): Slack tables + columns, still schema v2; then the one-time iMessage migration
  db.exec(DDL_SLACK)
  for (const [table, column, ddl] of SLACK_ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
  db.exec('CREATE INDEX IF NOT EXISTS asks_slack_draft ON asks(slack_draft_id) WHERE slack_draft_id IS NOT NULL')
  migrateSlackData(db)
  // COMPANY.md §2-§4, §9: company tables + company_id columns, still schema v2; then the one-time backfill.
  // The pre-company copy is taken before any company DDL touches the file.
  try {
    backupBeforeCompanyMigration(db)
  } catch (err) {
    // additive backfill: a failed copy (disk full, read-only dir) must not keep Hive from opening
    log.warn('hive.db backup before the company migration failed', { error: String(err) })
  }
  db.exec(DDL_COMPANY)
  for (const [table, column, ddl] of COMPANY_ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
  db.exec(DDL_COMPANY_INDEXES)
  migrateCompanyData(db)
  // FORUM.md §1: the Forum tables, still schema v2 (older builds ignore them)
  ensureForumSchema(db)
  // ORCHESTRATOR.md: run reports, the mailbox and the call budget, still schema v2
  db.exec(DDL_ORCHESTRATOR)
}

/** Columns added to the v1 DDL during the build. CREATE IF NOT EXISTS won't add them to an older db, so add them here. */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['profiles', 'use_api_key_auth', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'agent_session_id', 'TEXT'],
  ['run_steps', 'agent_session_id', 'TEXT']
]

function healColumns(db: DB): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/** Opens (creating if needed) hive.db and applies migrations. ':memory:' works for tests. */
export function openDatabase(file: string): DB {
  const db = new Database(file)
  for (const p of PRAGMAS) db.pragma(p)
  migrate(db)
  return db
}
