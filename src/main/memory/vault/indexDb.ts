import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { INDEX_DDL_V1, INDEX_PRAGMAS, INDEX_SCHEMA_VERSION } from './indexSchema'

export type IndexDB = Database.Database

export class IndexSchemaMismatch extends Error {
  constructor(public found: number) {
    super(`Passport index schema mismatch (found v${found}, expected v${INDEX_SCHEMA_VERSION}); restart Principia`)
    this.name = 'IndexSchemaMismatch'
  }
}

/** Ordered migrations: index i migrates user_version i -> i+1. */
const MIGRATIONS: ((db: IndexDB) => void)[] = [(db) => db.exec(INDEX_DDL_V1)]

export function indexVersion(db: IndexDB): number {
  return Number(db.pragma('user_version', { simple: true })) || 0
}

/**
 * Opens passport-index.db. Main opens it read-write and migrates. The hivemem MCP child opens it `readonly`
 * (`query_only`, never migrates, IndexSchemaMismatch on a version mismatch): its writes are RPCs to main (§7.1).
 */
export function openIndexDb(file: string, opts: { readonly?: boolean } = {}): IndexDB {
  const db = new Database(file, opts.readonly ? { readonly: true, fileMustExist: true } : {})
  for (const p of INDEX_PRAGMAS) {
    if (opts.readonly && p.startsWith('journal_mode')) continue
    db.pragma(p)
  }
  let v = indexVersion(db)
  if (opts.readonly) {
    db.pragma('query_only = ON')
    if (v !== INDEX_SCHEMA_VERSION) {
      db.close()
      throw new IndexSchemaMismatch(v)
    }
    return db
  }
  if (v > INDEX_SCHEMA_VERSION) {
    db.close()
    throw new Error(`passport-index.db schema v${v} is newer than this Principia (v${INDEX_SCHEMA_VERSION})`)
  }
  while (v < INDEX_SCHEMA_VERSION) {
    const step = MIGRATIONS[v]
    db.transaction(() => {
      step(db)
      db.pragma(`user_version = ${v + 1}`)
    }).immediate()
    v++
  }
  return db
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/** `<prefix>-<10 base36>` (proposals use `sg`, conflicts `cf`). */
export function newRowId(prefix: string): string {
  const bytes = randomBytes(10)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % 36]
  return `${prefix}-${s}`
}

// ---------- operational rows the writer and indexer produce ----------

export interface EventInput {
  ts: string
  companyId: string
  op: string
  targetKind: 'note' | 'fact' | 'relation' | 'alias' | 'property' | 'link' | 'memory'
  targetId: string
  entityId?: string | null
  path?: string | null
  blockId?: string | null
  actor: string
  grantId?: string | null
  runId?: string | null
  opId?: string | null
  baseHash?: string | null
  newHash?: string | null
  before?: unknown
  after?: unknown
}

export function insertEvent(db: IndexDB, e: EventInput): number {
  const r = db
    .prepare(
      `INSERT INTO mem_event (ts, company_id, op, target_kind, target_id, entity_id, path, block_id, actor, grant_id, run_id, op_id,
         base_hash, new_hash, before_json, after_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      e.ts,
      e.companyId,
      e.op,
      e.targetKind,
      e.targetId,
      e.entityId ?? null,
      e.path ?? null,
      e.blockId ?? null,
      e.actor,
      e.grantId ?? null,
      e.runId ?? null,
      e.opId ?? null,
      e.baseHash ?? null,
      e.newHash ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after)
    )
  return Number(r.lastInsertRowid)
}

export interface ProposalInput {
  companyId: string
  kind: string
  payload: unknown
  evidence: unknown
  score: number
  source: string
  fingerprint: string
  baseHashes?: Record<string, string>
  createdAt: string
}

/** Files a proposal unless its fingerprint exists (rejected fingerprints never come back). Returns the id or null. */
export function insertProposal(db: IndexDB, p: ProposalInput): string | null {
  const id = newRowId('sg')
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO mem_proposal (id, company_id, kind, payload_json, evidence_json, score, source, fingerprint, base_hashes_json, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`
    )
    .run(id, p.companyId, p.kind, JSON.stringify(p.payload), JSON.stringify(p.evidence), p.score, p.source, p.fingerprint, JSON.stringify(p.baseHashes ?? {}), p.createdAt)
  return r.changes ? id : null
}

export interface ConflictRow {
  id: string
  company_id: string
  path: string
  op_json: string
  reason: string
  base_hash: string | null
  current_hash: string | null
  created_at: string
  resolved_at: string | null
}

export function insertConflict(
  db: IndexDB,
  c: { companyId: string; path: string; op: unknown; reason: string; baseHash: string | null; currentHash: string | null; createdAt: string }
): ConflictRow {
  const row: ConflictRow = {
    id: newRowId('cf'),
    company_id: c.companyId,
    path: c.path,
    op_json: JSON.stringify(c.op),
    reason: c.reason,
    base_hash: c.baseHash,
    current_hash: c.currentHash,
    created_at: c.createdAt,
    resolved_at: null
  }
  db.prepare(
    `INSERT INTO mem_conflict (id, company_id, path, op_json, reason, base_hash, current_hash, created_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(row.id, row.company_id, row.path, row.op_json, row.reason, row.base_hash, row.current_hash, row.created_at)
  return row
}

export function listConflicts(db: IndexDB, companyId: string, opts: { open?: boolean } = {}): ConflictRow[] {
  return db
    .prepare(`SELECT * FROM mem_conflict WHERE company_id = ? ${opts.open ? 'AND resolved_at IS NULL' : ''} ORDER BY created_at, id`)
    .all(companyId) as ConflictRow[]
}

export function resolveConflict(db: IndexDB, companyId: string, id: string, at: string): boolean {
  return db.prepare('UPDATE mem_conflict SET resolved_at = ? WHERE company_id = ? AND id = ? AND resolved_at IS NULL').run(at, companyId, id).changes > 0
}

// ---------- graph layout (§10: stable positions) ----------

export interface LayoutRow {
  noteId: string
  x: number
  y: number
  pinned: boolean
}

export function getLayout(db: IndexDB, companyId: string): LayoutRow[] {
  return (db.prepare('SELECT note_id, x, y, pinned FROM mem_layout WHERE company_id = ?').all(companyId) as { note_id: string; x: number; y: number; pinned: number }[]).map(
    (r) => ({ noteId: r.note_id, x: r.x, y: r.y, pinned: !!r.pinned })
  )
}

export function saveLayout(db: IndexDB, companyId: string, rows: LayoutRow[]): number {
  const st = db.prepare(
    `INSERT INTO mem_layout (company_id, note_id, x, y, pinned) VALUES (?,?,?,?,?)
     ON CONFLICT(company_id, note_id) DO UPDATE SET x = excluded.x, y = excluded.y, pinned = excluded.pinned`
  )
  db.transaction(() => {
    for (const r of rows) {
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue
      st.run(companyId, r.noteId, r.x, r.y, r.pinned ? 1 : 0)
    }
  })()
  return rows.length
}

// ---------- writer idempotency ----------

export function findOpResult<T>(db: IndexDB, companyId: string, opId: string): T | null {
  const r = db.prepare('SELECT result_json FROM mem_op WHERE company_id = ? AND op_id = ?').get(companyId, opId) as { result_json: string } | undefined
  return r ? (JSON.parse(r.result_json) as T) : null
}

export function saveOpResult(db: IndexDB, companyId: string, opId: string, result: unknown, at: string): void {
  db.prepare('INSERT OR IGNORE INTO mem_op (company_id, op_id, result_json, created_at) VALUES (?,?,?,?)').run(companyId, opId, JSON.stringify(result), at)
}

// ---------- vault rows ----------

export interface VaultRow {
  company_id: string
  root: string
  format_version: number
  parser_version: number
  last_full_scan_at: string | null
  state: string
}

export function vaultRow(db: IndexDB, companyId: string): VaultRow | null {
  return (db.prepare('SELECT * FROM mem_vault WHERE company_id = ?').get(companyId) as VaultRow | undefined) ?? null
}

export function setVaultState(db: IndexDB, companyId: string, state: string): void {
  db.prepare('UPDATE mem_vault SET state = ? WHERE company_id = ?').run(state, companyId)
}
