// Vault watcher (PASSPORT.md §6.3). One recursive fs.watch per company vault (FSEvents on macOS), a 300 ms per-path
// debounce, rename pairs coalesced into one indexer batch (so a move keeping the frontmatter id stays the same note),
// a 60 s rescan plus on-demand rescans (window focus) as the safety net for iCloud and network folders, and
// suppression of Principia's own writes through an expected-hash map.

import fs from 'node:fs'
import path from 'node:path'
import { readFileState } from './fsutil'
import type { IndexNoteResult, VaultIndexer } from './indexer'
import { isNotePath, PRINCIPIA_DIR } from './paths'

/** `abs path -> hash Principia just wrote`; the watcher skips events whose file still has that hash. */
export class ExpectedWrites {
  private map = new Map<string, { hash: string; at: number }>()

  register(abs: string, hash: string): void {
    this.map.set(abs, { hash, at: Date.now() })
    if (this.map.size > 2000) this.prune(60_000)
  }

  /** True when `hash` is what Principia wrote at `abs`. The entry stays until the file changes or ages out. */
  matches(abs: string, hash: string): boolean {
    const e = this.map.get(abs)
    if (!e) return false
    if (e.hash === hash) return true
    this.map.delete(abs)
    return false
  }

  prune(olderThanMs: number): void {
    const cut = Date.now() - olderThanMs
    for (const [k, v] of this.map) if (v.at < cut) this.map.delete(k)
  }
}

export interface WatcherOptions {
  debounceMs?: number
  /** 0 disables the periodic rescan. */
  rescanMs?: number
  expected?: ExpectedWrites
  onBatch?: (results: IndexNoteResult[]) => void
  onError?: (e: unknown) => void
}

export class VaultWatcher {
  private watcher: fs.FSWatcher | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private ready = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private rescanSoon: NodeJS.Timeout | null = null
  private stopped = false
  readonly root: string

  constructor(
    private indexer: VaultIndexer,
    readonly companyId: string,
    private opts: WatcherOptions = {}
  ) {
    this.root = indexer.root(companyId)
  }

  private get debounceMs(): number {
    return this.opts.debounceMs ?? 300
  }

  /** Starts watching. False when fs.watch is unavailable here (the periodic rescan still runs). */
  start(): boolean {
    this.stopped = false
    const every = this.opts.rescanMs ?? 60_000
    if (every > 0 && !this.rescanTimer) {
      this.rescanTimer = setInterval(() => this.rescanNow(), every)
      this.rescanTimer.unref?.()
    }
    if (this.watcher) return true
    try {
      this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_type, filename) => this.onEvent(filename ? String(filename) : null))
      this.watcher.on('error', (e) => {
        this.opts.onError?.(e)
        this.watcher?.close()
        this.watcher = null
      })
      return true
    } catch (e) {
      this.opts.onError?.(e)
      this.watcher = null
      return false
    }
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.ready.clear()
    for (const t of [this.flushTimer, this.rescanSoon]) if (t) clearTimeout(t)
    if (this.rescanTimer) clearInterval(this.rescanTimer)
    this.flushTimer = this.rescanSoon = this.rescanTimer = null
  }

  /** Full (mtime, size) rescan; window focus calls this. */
  rescanNow(): IndexNoteResult[] {
    if (this.stopped) return []
    try {
      const results = this.indexer.scan(this.companyId)
      if (results.length) this.opts.onBatch?.(results)
      return results
    } catch (e) {
      this.opts.onError?.(e)
      return []
    }
  }

  /** Processes every debounced path now (tests, shutdown). */
  flush(): IndexNoteResult[] {
    for (const [rel, t] of this.timers) {
      clearTimeout(t)
      this.ready.add(rel)
    }
    this.timers.clear()
    return this.processReady()
  }

  /** Raw event entry point (also used by tests to inject events). */
  onEvent(filename: string | null): void {
    if (this.stopped) return
    if (!filename) return this.scheduleRescan()
    const rel = filename.split(path.sep).join('/')
    const first = rel.split('/')[0]
    if (first === PRINCIPIA_DIR || rel.split('/').some((s) => s.startsWith('.'))) return
    if (!isNotePath(rel)) {
      // a folder renamed or deleted (or an attachment): let the rescan find moved and missing notes
      if (!/\.[A-Za-z0-9]{1,8}$/.test(rel)) this.scheduleRescan()
      return
    }
    const prev = this.timers.get(rel)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.timers.delete(rel)
      this.ready.add(rel)
      // a short coalescing window: both halves of a rename land in one batch
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null
          this.processReady()
        }, 25)
        this.flushTimer.unref?.()
      }
    }, this.debounceMs)
    t.unref?.()
    this.timers.set(rel, t)
  }

  private scheduleRescan(): void {
    if (this.rescanSoon) clearTimeout(this.rescanSoon)
    this.rescanSoon = setTimeout(() => {
      this.rescanSoon = null
      this.rescanNow()
    }, this.debounceMs)
    this.rescanSoon.unref?.()
  }

  private processReady(): IndexNoteResult[] {
    if (this.stopped || this.ready.size === 0) return []
    const batch = [...this.ready]
    this.ready.clear()
    const todo: string[] = []
    for (const rel of batch) {
      const abs = path.join(this.root, ...rel.split('/'))
      const st = readFileState(abs)
      // our own write, already indexed synchronously by the writer
      if (st && this.opts.expected?.matches(abs, st.hash) && this.indexer.noteByPath(this.companyId, rel)?.hash === st.hash) continue
      todo.push(rel)
    }
    if (todo.length === 0) return []
    try {
      const results = this.indexer.indexPaths(this.companyId, todo)
      this.opts.onBatch?.(results)
      return results
    } catch (e) {
      this.opts.onError?.(e)
      return []
    }
  }
}
