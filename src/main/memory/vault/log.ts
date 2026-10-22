// Provenance log (PASSPORT.md §3.2, §6.1). `.principia/log.jsonl` is canonical for history and travels with the
// vault; `mem_event` mirrors it in the index to feed the change feed. Both get the same record, keyed by block id.

import fs from 'node:fs'
import { appendLine } from './fsutil'
import { type EventInput, type IndexDB, insertEvent } from './indexDb'
import { vaultFiles } from './paths'

export type LogRecord = EventInput

/** Appends to `mem_event` and `log.jsonl`. The log line carries the event seq so the two can be joined. */
export function logEvent(db: IndexDB, root: string | null, e: LogRecord): number {
  const seq = insertEvent(db, e)
  if (root) {
    const line: Record<string, unknown> = { seq, ...e }
    for (const k of Object.keys(line)) if (line[k] === undefined || line[k] === null) delete line[k]
    try {
      appendLine(vaultFiles(root).log, JSON.stringify(line))
    } catch {
      // the vault folder vanished (unmounted drive): mem_event still has the record
    }
  }
  return seq
}

/** Parsed `log.jsonl` (bad lines skipped); for tests, revertRun and the migration report. */
export function readLog(root: string): Array<LogRecord & { seq: number }> {
  let text: string
  try {
    text = fs.readFileSync(vaultFiles(root).log, 'utf8')
  } catch {
    return []
  }
  const out: Array<LogRecord & { seq: number }> = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a torn last line after a crash
    }
  }
  return out
}
