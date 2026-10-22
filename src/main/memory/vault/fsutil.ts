// File helpers shared by the writer, indexer, snapshots and seed. Nothing here removes files: a write is
// tmp + fsync + rename(), and the tmp name is fixed per target (`.<name>.principia-tmp` in the same
// directory), so a write abandoned by a CAS retry is overwritten and consumed by the next attempt
// instead of being unlinked (PASSPORT.md §1.5, §6.4).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PRINCIPIA_DIR, isNotePath } from './paths'

export const TMP_SUFFIX = '.principia-tmp'

/** sha1 hex of the text (UTF-8); equals `contentHash` in shared/vault/ids.ts, just faster. */
export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

export function tmpPathFor(abs: string): string {
  return path.join(path.dirname(abs), `.${path.basename(abs)}${TMP_SUFFIX}`)
}

export interface FileState {
  text: string
  hash: string
  mtimeMs: number
  size: number
}

/** Reads a note; null when it does not exist (or is not a regular file). */
export function readFileState(abs: string): FileState | null {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return null
    const text = fs.readFileSync(abs, 'utf8')
    return { text, hash: sha1(text), mtimeMs: Math.floor(st.mtimeMs), size: st.size }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw e
  }
}

export function statFile(abs: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(abs)
    return st.isFile() ? { mtimeMs: Math.floor(st.mtimeMs), size: st.size } : null
  } catch {
    return null
  }
}

/** Writes (and by default fsyncs) the tmp file next to `abs`; returns its path. */
export function writeTmp(abs: string, text: string, opts: { fsync?: boolean } = {}): string {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = tmpPathFor(abs)
  const fd = fs.openSync(tmp, 'w', 0o644)
  try {
    fs.writeFileSync(fd, text, 'utf8')
    if (opts.fsync !== false) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return tmp
}

/**
 * tmp + rename, no CAS (seed, the indexer's duplicate-id stamp, snapshots). Snapshots pass `fsync: false`: they are
 * a rebuildable cache of files that are themselves durable, and 5k fsyncs would dominate a rebuild.
 */
export function atomicWrite(abs: string, text: string, opts: { fsync?: boolean } = {}): void {
  const tmp = writeTmp(abs, text, opts)
  fs.renameSync(tmp, abs)
}

/** Appends one line; creates the parent folder. */
export function appendLine(abs: string, line: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.appendFileSync(abs, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
}

export interface WalkedNote {
  rel: string
  abs: string
  mtimeMs: number
  size: number
}

/** Every indexable note under `root`, sorted by path; skips dot-folders (`.obsidian`, `.principia`, `.trash`). */
export function walkNotes(root: string): WalkedNote[] {
  const out: WalkedNote[] = []
  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === PRINCIPIA_DIR) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) visit(abs, rel)
      else if (e.isFile() && isNotePath(rel)) {
        const st = statFile(abs)
        if (st) out.push({ rel, abs, ...st })
      }
    }
  }
  visit(root, '')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}
