// Shared fixtures for the vault index/writer tests: a throwaway vault folder plus an index db.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIndexDb, type IndexDB } from '../indexDb'
import { VaultIndexer, type ChangedEvent } from '../indexer'
import { VaultWriter, type WriterOptions } from '../writer'

export let nativeOk = true
try {
  openIndexDb(':memory:').close()
} catch {
  nativeOk = false // better-sqlite3 not loadable in this runtime
}

export interface Kit {
  dir: string
  root: string
  db: IndexDB
  index: VaultIndexer
  writer: VaultWriter
  changed: ChangedEvent[]
  write(rel: string, text: string): void
  read(rel: string): string
  exists(rel: string): boolean
  close(): void
}

export const CO = 'co_acme'

export function makeKit(opts: { companyId?: string; writer?: WriterOptions; now?: () => Date; dir?: string } = {}): Kit {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hive-vault-'))
  const root = path.join(dir, 'Passport')
  fs.mkdirSync(root, { recursive: true })
  const db = openIndexDb(path.join(dir, 'passport-index.db'))
  const changed: ChangedEvent[] = []
  const index = new VaultIndexer(db, { now: opts.now, onChanged: (e) => changed.push(e) })
  index.registerVault(opts.companyId ?? CO, root)
  const writer = new VaultWriter(index, { now: opts.now, ...opts.writer })
  const abs = (rel: string): string => path.join(root, ...rel.split('/'))
  return {
    dir,
    root,
    db,
    index,
    writer,
    changed,
    write(rel, text) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      fs.writeFileSync(abs(rel), text)
    },
    read: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    exists: (rel) => fs.existsSync(abs(rel)),
    close() {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function note(id: string, title: string, body: string, extra = ''): string {
  return `---\nid: ${id}\ntitle: ${title}\ntype: person\n${extra}---\n# ${title}\n${body}`
}
