// `.principia/writer.lock` (PASSPORT.md §6.4 step 1). Exactly one Principia instance writes a vault; a second one
// (another process on this machine, or another machine on a synced folder) falls back to read-only with a banner.
// The lock is released by rewriting it as free (`pid: 0`), never by removing the file.

import fs from 'node:fs'
import os from 'node:os'
import { atomicWrite } from './fsutil'
import { vaultFiles } from './paths'

export interface LockFile {
  pid: number
  host: string
  startedAt: string
  /** Refreshed while held; a lock from another host is stale once this is older than HOST_STALE_MS. */
  heartbeatAt?: string
}

export interface LockState {
  held: boolean
  /** Why the vault is read-only for this process (null when held). */
  reason: string | null
  owner: LockFile | null
}

const HOST_STALE_MS = 10 * 60_000
const HEARTBEAT_MS = 60_000

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readLockFile(root: string): LockFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(vaultFiles(root).writerLock, 'utf8')) as LockFile
    return v && typeof v.pid === 'number' ? v : null
  } catch {
    return null
  }
}

/** True when `lock` belongs to a live instance other than this process. */
export function heldByOther(lock: LockFile | null, now = Date.now()): boolean {
  if (!lock || lock.pid <= 0) return false
  const host = os.hostname()
  if (lock.host === host) return lock.pid !== process.pid && pidAlive(lock.pid)
  const beat = Date.parse(lock.heartbeatAt ?? lock.startedAt)
  return Number.isFinite(beat) && now - beat < HOST_STALE_MS
}

function describe(lock: LockFile): string {
  return lock.host === os.hostname()
    ? `Another Principia (pid ${lock.pid}) is writing this Passport; it is read-only here.`
    : `Principia on ${lock.host} is writing this Passport; it is read-only here.`
}

/** Per-process registry of the vault locks this instance holds. */
export class WriterLocks {
  private held = new Map<string, LockFile>()
  private timer: NodeJS.Timeout | null = null

  constructor(private opts: { now?: () => Date; heartbeat?: boolean } = {}) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  /** Takes the lock when free, stale or already ours. Idempotent. */
  acquire(root: string): LockState {
    const mine = this.held.get(root)
    const current = readLockFile(root)
    if (mine && current && current.pid === process.pid && current.host === mine.host) return { held: true, reason: null, owner: mine }
    if (heldByOther(current, this.now().getTime())) {
      this.held.delete(root)
      return { held: false, reason: describe(current!), owner: current }
    }
    const at = this.now().toISOString()
    const lock: LockFile = { pid: process.pid, host: os.hostname(), startedAt: at, heartbeatAt: at }
    fs.mkdirSync(vaultFiles(root).principia, { recursive: true })
    atomicWrite(vaultFiles(root).writerLock, JSON.stringify(lock))
    // two instances racing: the last rename wins; re-read to see who that was
    const after = readLockFile(root)
    if (!after || after.pid !== process.pid || after.host !== lock.host) {
      return { held: false, reason: after ? describe(after) : 'writer lock unavailable', owner: after }
    }
    this.held.set(root, lock)
    this.startHeartbeat()
    return { held: true, reason: null, owner: lock }
  }

  /** Current state without taking the lock. */
  state(root: string): LockState {
    const current = readLockFile(root)
    if (this.held.has(root) && current?.pid === process.pid) return { held: true, reason: null, owner: current }
    if (heldByOther(current, this.now().getTime())) return { held: false, reason: describe(current!), owner: current }
    return { held: false, reason: null, owner: current }
  }

  isHeld(root: string): boolean {
    if (!this.held.has(root)) return false
    const current = readLockFile(root)
    if (current?.pid === process.pid) return true
    this.held.delete(root) // someone took it over (we were considered stale)
    return false
  }

  release(root: string): void {
    if (!this.held.delete(root)) return
    const current = readLockFile(root)
    if (current?.pid !== process.pid) return
    try {
      atomicWrite(vaultFiles(root).writerLock, JSON.stringify({ pid: 0, host: os.hostname(), startedAt: current.startedAt, releasedAt: this.now().toISOString() }))
    } catch {
      // vault gone
    }
    if (this.held.size === 0) this.stopHeartbeat()
  }

  releaseAll(): void {
    for (const root of [...this.held.keys()]) this.release(root)
    this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.timer || this.opts.heartbeat === false) return
    this.timer = setInterval(() => {
      for (const [root, lock] of this.held) {
        if (readLockFile(root)?.pid !== process.pid) continue
        try {
          atomicWrite(vaultFiles(root).writerLock, JSON.stringify({ ...lock, heartbeatAt: this.now().toISOString() }))
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_MS)
    this.timer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
