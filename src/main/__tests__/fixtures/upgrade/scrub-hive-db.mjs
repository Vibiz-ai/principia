#!/usr/bin/env node
/**
 * COMPANY.md §11 C7: builds `hive-scrubbed.db`, the pre-company snapshot that upgrade.test.ts opens with the current
 * build. Usage: node scrub-hive-db.mjs <copy-of-hive.db> <out.db>
 *
 * Takes a copy (sqlite3 hive.db ".backup /tmp/x.db", or a Hive-backups/hive.pre-company.*.db), never the live file, and
 * refuses a db the company backfill already ran on (it is no longer a pre-company snapshot). Keeps every row of every company domain and
 * every id, foreign key, timestamp, enum and schedule rule, so the backfill and the scheduler see the real shape.
 * Replaces free text (titles, prompts, outputs, messages) with placeholders, ciphers with a dummy, and every path segment
 * after the home dir with a salted hash (a fresh salt per scrub, never stored), which keeps nesting and repo prefixes
 * intact. Tables that are pure content and never company-stamped (agent events, Claude history, Slack messages, users,
 * channels, logs) are emptied.
 */
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [src, out] = process.argv.slice(2)
if (!src || !out) {
  console.error('usage: node scrub-hive-db.mjs <copy-of-hive.db> <out.db>')
  process.exit(2)
}
const real = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
// the app's data folder holds the live file (and its -wal): never read it directly, never write next to it
if (/\/Application Support\/(Hive|Principia)\/[^/]+$/.test(real(src)) || /\/Application Support\/(Hive|Principia)\//.test(real(out))) {
  console.error('refusing the live data folder: back hive.db up first (sqlite3 hive.db ".backup /tmp/x.db") and scrub the copy')
  process.exit(2)
}
if (real(src) === real(out)) {
  console.error('<out.db> must differ from the source')
  process.exit(2)
}
// the online backup API reads a consistent copy, including pages still in a -wal file next to the source
const source = new Database(src, { readonly: true, fileMustExist: true })
try {
  const migrated = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() && source.prepare("SELECT 1 FROM meta WHERE key = 'company_migrated'").get()
  if (migrated) {
    console.error('this db was already upgraded to companies: scrub a backup from before, e.g. Hive-backups/hive.pre-company.*.db')
    process.exit(2)
  }
  fs.rmSync(out, { force: true })
  await source.backup(out)
} finally {
  source.close()
}
const db = new Database(out)
db.pragma('journal_mode = DELETE')
const salt = crypto.randomBytes(16).toString('hex')
const hash = (s) => crypto.createHash('sha256').update(salt + s).digest('hex').slice(0, 8)

const EMPTY = [
  'agent_events', 'claude_history', 'run_refs', 'connector_secrets', 'slack_users', 'slack_channels', 'slack_messages',
  'slack_sync_state', 'slack_thread_sync', 'slack_event_log', 'slack_inbound_log', 'slack_outbox', 'slack_drafts'
]
/** Hive ids only (src/shared/ids.ts newId: `<prefix>_<10 [0-9a-z]>`; company/index.ts uid: `<prefix>_<20 hex>`), so a folder like `acme_backend` is not kept as an "id". */
const ID = /^(?:(?:repo|prof|s|wf|r|st|sch|sev|art|ment|mfa|mrel|mgr|ag|ask|adr|wt|hac|sdr|stg|sob|ste)_[0-9a-z]{10}|(?:co|ta|task)_[0-9a-f]{20}|co_personal)$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const TEMPLATE = /^\{\{\s*[\w.]+\s*\}\}$/
const HOME = /^\/Users\/[^/]+/
/** Folder names that say nothing about the founder's projects (userData layout). */
const KEEP_SEGMENTS = new Set(['Library', 'Application Support', 'Hive', 'artifacts', 'scratch', 'logs', 'runs', 'sessions', 'worktrees', 'live', 'handoffs', 'companies', 'workspace', 'thumbs'])
/** Keys and columns whose short string values are structure, not content. */
const ENUM_KEYS = new Set([
  'id', 'type', 'kind', 'cwd', 'after', 'profileId', 'workflowId', 'repoId', 'repo', 'scheduleId', 'runId', 'sessionId', 'cron', 'tz', 'time',
  'memory', 'isolate', 'name', 'every', 'days', 'day', 'unit', 'status', 'adapter', 'mode', 'on', 'trigger', 'provider', 'permissionMode'
])
/** Columns kept as they are (besides ids, foreign keys and timestamps). */
const ENUM_COLS = new Set([
  'status', 'kind', 'trigger', 'adapter', 'provider', 'node_type', 'node_type_ext', 'trigger_ext', 'seed_key', 'permission_mode', 'channel', 'needs',
  'attribution', 'verdict', 'stop_reason', 'mime', 'agent_type', 'model', 'owner_kind', 'answered_via', 'halt', 'outcome', 'key', 'connector'
])
const SHORT = /^[\w:.*/,+ -]{0,40}$/

function scrubPath(p) {
  if (!HOME.test(p)) return p
  const rest = p.replace(HOME, '').split('/').filter(Boolean)
  return ['/Users/founder', ...rest.map((s) => (KEEP_SEGMENTS.has(s) || ID.test(s) ? s : `d${hash(s)}`))].join('/')
}
function scrubString(s, key) {
  // a home path (spaces allowed: "Application Support") keeps its shape, segment by segment; prose naming one goes
  if (s.includes('/Users/')) return HOME.test(s) && !/\n/.test(s) ? scrubPath(s) : 'redacted'
  if (s === '*' || ID.test(s) || ISO.test(s) || TEMPLATE.test(s)) return s
  if (key && ENUM_KEYS.has(key) && SHORT.test(s)) return s
  return 'redacted'
}
function scrubJson(v, key) {
  if (typeof v === 'string') return scrubString(v, key)
  if (Array.isArray(v)) return v.map((x) => scrubJson(x, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubJson(x, k)]))
  return v
}
function scrubColumn(table, col, value) {
  if (value === null || typeof value === 'number' || typeof value === 'bigint') return value
  if (Buffer.isBuffer(value)) return Buffer.from(`enc:${Buffer.from('redacted-secret').toString('base64')}`)
  if (col === 'id' || col.endsWith('_id') || col.endsWith('_at') || col === 'mtime' || ENUM_COLS.has(col)) return value
  if (['path', 'cwd', 'repo_path', 'artifacts_dir', 'log_path'].includes(col)) return scrubPath(value)
  if (col === 'rel_path') return value.split('/').map((s) => (ID.test(s) ? s : `f${hash(s)}`)).join('/')
  if (col === 'masked') return '••••'
  if (col.endsWith('_json') || col === 'value' || col === 'data') {
    try {
      const v = scrubJson(JSON.parse(value))
      // company names are client names: keep a placeholder per company (the `name` key is kept elsewhere, e.g. inputs)
      if (table === 'company_passports' && v && typeof v === 'object' && typeof v.name === 'string') v.name = `Company ${hash(v.name)}`
      return JSON.stringify(v)
    } catch {
      return ISO.test(value) || /^\d+$/.test(value) ? value : 'redacted'
    }
  }
  // a placeholder per value, so UNIQUE and PRIMARY KEY columns (secrets.name) stay distinct
  return `${col}-${hash(value)}`
}

const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
try {
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const t of EMPTY) if (has(t)) db.prepare(`DELETE FROM ${t}`).run()
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'slack_messages_fts'").get()) db.prepare("INSERT INTO slack_messages_fts(slack_messages_fts) VALUES('delete-all')").run()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'slack_messages_fts%'").all().map((r) => r.name)
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
      const rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${t}`).all()
      const set = db.prepare(`UPDATE ${t} SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE rowid = ?`)
      for (const r of rows) set.run(...cols.map((c) => scrubColumn(t, c, r[c])), r.__rowid)
    }
    // the window position and Slack team identity are not needed by any test (older dbs may lack either table)
    if (has('meta')) db.prepare("DELETE FROM meta WHERE key = 'window_bounds'").run()
    if (has('slack_workspaces')) db.prepare("UPDATE slack_workspaces SET team_name = 'Workspace', domain = 'workspace', url = 'https://workspace.slack.com/'").run()
  })()
  // rebuilds the file, so no unscrubbed page survives in the free list
  db.exec('VACUUM')
  db.close()
} catch (e) {
  // never leave an unscrubbed copy behind
  db.close()
  fs.rmSync(out, { force: true })
  throw e
}
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`)
