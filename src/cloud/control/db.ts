/**
 * Control plane database (CLOUD.md §4.3): node:sqlite, WAL, foreign keys. Plain SQL a Postgres `ControlDb` adapter can
 * also run (TEXT and INTEGER columns only, ciphertext as base64 TEXT, no AUTOINCREMENT, ON CONFLICT upserts).
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

type Row = Record<string, SQLInputValue>

const MIGRATIONS: string[] = [
  `CREATE TABLE workspace (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
    quotas TEXT NOT NULL, dek TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'self-host'
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), name TEXT NOT NULL, platform TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), token_hash TEXT NOT NULL UNIQUE,
    csrf TEXT NOT NULL, device_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE TABLE pairing_codes (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
  );
  CREATE TABLE login_links (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), token_hash TEXT NOT NULL UNIQUE,
    device_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
  );
  CREATE TABLE companies (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), name TEXT NOT NULL, slug TEXT NOT NULL,
    color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
    cloud_agent_writes TEXT NOT NULL DEFAULT 'propose',
    passport_id TEXT, passport_revision INTEGER, passport_seq INTEGER NOT NULL DEFAULT 0,
    desktop_grant_id TEXT, runtime_grant_id TEXT, runtime_grant_ct TEXT, owner_grant_id TEXT, owner_grant_ct TEXT,
    usd_cap_month TEXT
  );
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), company_id TEXT, adapter TEXT NOT NULL,
    kind TEXT NOT NULL, label TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    expires_at TEXT, last_used_at TEXT, failing INTEGER NOT NULL DEFAULT 0, detail TEXT
  );
  CREATE TABLE company_secrets (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, PRIMARY KEY (company_id, name)
  );
  CREATE TABLE repos (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL,
    url TEXT NOT NULL, branch TEXT, credential_kind TEXT NOT NULL, credential_ct TEXT, synced_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending', detail TEXT, last_sync_ok INTEGER, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (company_id, id)
  );
  CREATE TABLE github_app (
    workspace_id TEXT PRIMARY KEY REFERENCES workspace(id), app_id INTEGER NOT NULL, slug TEXT NOT NULL,
    private_key_ct TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE connections (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL,
    transport TEXT NOT NULL, command TEXT, args TEXT, url TEXT, enabled INTEGER NOT NULL, authentication TEXT NOT NULL,
    auth_status TEXT, auth_detail TEXT, credentials_ct TEXT, oauth_ct TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (company_id, id)
  );
  CREATE TABLE oauth_state (
    state_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, company_id TEXT NOT NULL, connection_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL, actor_id TEXT, verifier_ct TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE workflows (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL,
    rev INTEGER NOT NULL, file TEXT NOT NULL, problems TEXT NOT NULL, deps TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, id)
  );
  CREATE TABLE schedules (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL, spec TEXT NOT NULL,
    placement TEXT NOT NULL, rev INTEGER NOT NULL, last_fire_at TEXT, last_run_id TEXT, seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL, PRIMARY KEY (company_id, id)
  );
  CREATE TABLE schedule_fires (
    schedule_id TEXT NOT NULL, slot TEXT NOT NULL, run_id TEXT, at TEXT NOT NULL, UNIQUE (schedule_id, slot)
  );
  CREATE TABLE hooks (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL,
    workflow_id TEXT NOT NULL, verify TEXT NOT NULL, inputs TEXT NOT NULL, enabled INTEGER NOT NULL,
    secret_hash TEXT NOT NULL, secret_ct TEXT NOT NULL, last_delivery_at TEXT, last_status TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY (company_id, id)
  );
  CREATE TABLE cloud_runs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, company_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL, trigger TEXT NOT NULL, adapters TEXT NOT NULL, target TEXT NOT NULL, untrusted TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, summary TEXT, schedule_id TEXT, slot TEXT,
    credential_lock TEXT, seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX cloud_runs_status ON cloud_runs(status, created_at);
  CREATE INDEX cloud_runs_company ON cloud_runs(company_id, created_at);
  CREATE TABLE run_steps (
    run_id TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, id)
  );
  CREATE TABLE asks (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, run_id TEXT, agent_name TEXT, question TEXT NOT NULL,
    options TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, answered_at TEXT,
    origin TEXT NOT NULL DEFAULT 'agent', seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE usage (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, company_id TEXT NOT NULL, adapter TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, usd TEXT, at TEXT NOT NULL
  );
  CREATE INDEX usage_company ON usage(company_id, at);
  CREATE TABLE audit (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT,
    actor_name TEXT, action TEXT NOT NULL, company_id TEXT, target TEXT, detail TEXT NOT NULL
  );
  CREATE INDEX audit_seq ON audit(seq);`,
  // 2: the redacted log lines the runtime streamed (ports.runLog), so a finished run shows its proof of work even when
  // the runtime keeps no log file of its own (CLOUD.md §9). Capped per run by the queue; swept with run_steps.
  `CREATE TABLE run_logs (
    run_id TEXT NOT NULL, n INTEGER NOT NULL, step_id TEXT NOT NULL, line TEXT NOT NULL, PRIMARY KEY (run_id, n)
  );`
]

export interface ControlDb {
  raw: DatabaseSync
  run(sql: string, ...params: SQLInputValue[]): number
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[]
  tx<T>(fn: () => T): T
  /** monotonic change counter for /v1/sync/changes cursors */
  nextSeq(): number
  currentSeq(): number
  close(): void
}

export const newId = (prefix: string): string => `${prefix}${randomBytes(12).toString('base64url')}`
export const iso = (d: Date): string => d.toISOString()

export function openControlDb(path: string): ControlDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  raw.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set((raw.prepare('SELECT version FROM migrations').all() as { version: number }[]).map(r => r.version))
  MIGRATIONS.forEach((sql, i) => {
    if (applied.has(i + 1)) return
    raw.exec('BEGIN')
    try { raw.exec(sql); raw.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString()); raw.exec('COMMIT') } catch (e) { raw.exec('ROLLBACK'); throw e }
  })
  raw.exec("INSERT INTO meta (key, value) VALUES ('seq', '0') ON CONFLICT (key) DO NOTHING")
  let depth = 0
  const db: ControlDb = {
    raw,
    run: (sql, ...params) => Number(raw.prepare(sql).run(...params).changes),
    get: <T>(sql: string, ...params: SQLInputValue[]) => (raw.prepare(sql).get(...params) as T | undefined) ?? undefined,
    all: <T>(sql: string, ...params: SQLInputValue[]) => raw.prepare(sql).all(...params) as T[],
    tx: fn => {
      if (depth > 0) return fn()
      depth++; raw.exec('BEGIN IMMEDIATE')
      try { const out = fn(); raw.exec('COMMIT'); return out } catch (e) { raw.exec('ROLLBACK'); throw e } finally { depth-- }
    },
    nextSeq: () => Number((raw.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'seq' RETURNING value").get() as { value: string }).value),
    currentSeq: () => Number((raw.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: string }).value),
    close: () => raw.close()
  }
  return db
}

/** Every TEXT column of every table, for the seeded-secret grep test. */
export function dumpText(db: ControlDb): string {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
  return tables.map(t => JSON.stringify(db.all(`SELECT * FROM "${t.name}"`))).join('\n')
}
