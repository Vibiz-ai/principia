// Last indexed content per note (PASSPORT.md §2, §6.2): `.principia/snapshots/<noteId>.md`. It is the recovery copy
// after an external delete (Restore in the Inbox) and the diff3 base for editor saves whose baseHash is stale.
// Snapshots are only ever overwritten, never removed.

import fs from 'node:fs'
import { atomicWrite, sha1 } from './fsutil'
import { snapshotFile } from './paths'

export function snapshotPath(root: string, noteKey: string): string {
  return snapshotFile(root, noteKey, sha1)
}

export function writeSnapshot(root: string, noteKey: string, text: string): void {
  try {
    atomicWrite(snapshotPath(root, noteKey), text, { fsync: false })
  } catch {
    // best effort: a read-only or vanished vault must not fail indexing
  }
}

export function readSnapshot(root: string, noteKey: string): string | null {
  try {
    return fs.readFileSync(snapshotPath(root, noteKey), 'utf8')
  } catch {
    return null
  }
}

export function hasSnapshot(root: string, noteKey: string): boolean {
  return fs.existsSync(snapshotPath(root, noteKey))
}
