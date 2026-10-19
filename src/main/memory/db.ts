import Database from 'better-sqlite3'
import { MEMORY_DDL_V1, MEMORY_PRAGMAS, MEMORY_SCHEMA_VERSION } from './schema'

export type MemDB = Database.Database

export class MemorySchemaMismatch extends Error {
  constructor(public found: number) {
    super(`Hive memory schema mismatch (found v${found}, expected v${MEMORY_SCHEMA_VERSION}); restart Hive`)
    this.name = 'MemorySchemaMismatch'
  }
}

/** Ordered migrations: index i migrates user_version i -> i+1. */
const MIGRATIONS: ((db: MemDB) => void)[] = [(db) => db.exec(MEMORY_DDL_V1)]

export function memoryVersion(db: MemDB): number {
  return Number(db.pragma('user_version', { simple: true })) || 0
}

/**
 * Opens memory.db. Main passes migrate: true (creates/upgrades). The MCP server passes migrate: false and gets a
 * MemorySchemaMismatch on a version mismatch (it never migrates).
 */
export function openMemoryDb(file: string, opts: { migrate: boolean; readonly?: boolean } = { migrate: true }): MemDB {
  const db = new Database(file, opts.readonly ? { readonly: true, fileMustExist: true } : {})
  for (const p of MEMORY_PRAGMAS) {
    if (opts.readonly && p.startsWith('journal_mode')) continue
    db.pragma(p)
  }
  let v = memoryVersion(db)
  if (opts.migrate) {
    if (v > MEMORY_SCHEMA_VERSION) {
      db.close()
      throw new Error(`memory.db schema v${v} is newer than this Hive (v${MEMORY_SCHEMA_VERSION})`)
    }
    while (v < MEMORY_SCHEMA_VERSION) {
      const step = MIGRATIONS[v]
      db.transaction(() => {
        step(db)
        db.pragma(`user_version = ${v + 1}`)
      }).immediate()
      v++
    }
  } else if (v !== MEMORY_SCHEMA_VERSION) {
    db.close()
    throw new MemorySchemaMismatch(v)
  }
  return db
}
