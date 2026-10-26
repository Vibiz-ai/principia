/**
 * docs/USAGE.md §4: the portfolio Activity canvas, outside half. Every Claude Code session on this Mac whose transcript
 * (`<root>/<project>/<session>.jsonl`, the Claude history roots) changed in the last WINDOW_MIN minutes.
 *
 * Read-only toward ~/.claude: files are opened O_RDONLY, stat'ed with lstat (symlinks are never followed or read), and
 * nothing under a root is ever created, renamed, locked or written. Matching a cwd to a company uses realpath on our side
 * (the cwd is a folder of the founder's, not a path under ~/.claude).
 *
 * Cheap: each file is read once from the start (up to FULL_SCAN_MAX, else its tail only, and tokens are flagged
 * partial), then only the bytes appended since. There is no background loop (PO9): the file watcher and the
 * 30 s age-out timer exist only while the Activity layer is open (`open()` leases it for LEASE_MS; the canvas renews
 * the lease, `close()` or an expired lease stops everything). Updates are throttled to one per THROTTLE_MS.
 * No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Id } from '../../shared/types'
import type { ActivitySession, ActivitySnapshot } from '../../shared/usage'
import { FULL_SCAN_MAX, HEAD_BYTES, TAIL_BYTES, typedPromptText } from '../history'
import { clip, summarizeTool } from '../engine/live/summary'

export const WINDOW_MIN = 15
export const THROTTLE_MS = 2000
export const LEASE_MS = 90_000
/** A "working" session whose file has not moved for this long reads as idle. */
export const STALE_WORKING_MS = 10 * 60_000
const SESSION_FILE = /^([0-9a-zA-Z-]{8,64})\.jsonl$/
const CHUNK = 1024 * 1024

interface FileState {
  path: string
  sessionId: string
  size: number
  mtimeMs: number
  offset: number
  rest: string
  partial: boolean
  cwd: string | null
  gitBranch: string | null
  custom: string | null
  ai: string | null
  firstPrompt: string | null
  startedAt: string | null
  lastAt: string | null
  turnStartedAt: string | null
  model: string | null
  state: 'working' | 'idle'
  doing: string | null
  usage: Map<string, { i: number; o: number }>
  tokensIn: number
  tokensOut: number
}

const parse = (l: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(l)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null // Claude's format can change: a line we cannot read is skipped
  }
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function readRange(file: string, start: number, len: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY)
  try {
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, start)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

/** Applies one transcript record to a file's state. Exported for tests. */
export function applyRecord(s: FileState, r: Record<string, unknown>, redact: (t: string) => string): void {
  const ts = typeof r.timestamp === 'string' ? r.timestamp : null
  if (ts) {
    s.startedAt ??= ts
    if (!s.lastAt || ts > s.lastAt) s.lastAt = ts
  }
  if (!s.cwd && typeof r.cwd === 'string' && r.cwd) s.cwd = r.cwd
  if (typeof r.gitBranch === 'string' && r.gitBranch) s.gitBranch = r.gitBranch
  const type = r.type
  if (type === 'custom-title') {
    const v = r.customTitle ?? r.title
    if (typeof v === 'string' && v.trim()) s.custom = redact(v.trim()).slice(0, 200)
    return
  }
  if (type === 'ai-title') {
    const v = r.aiTitle ?? r.title
    if (typeof v === 'string' && v.trim()) s.ai = redact(v.trim()).slice(0, 200)
    return
  }
  const side = r.isSidechain === true
  const msg = (r.message && typeof r.message === 'object' ? r.message : {}) as { id?: unknown; model?: unknown; content?: unknown; usage?: unknown; stop_reason?: unknown }
  if (type === 'assistant') {
    // usage: a message streamed over several lines repeats its usage; keep the largest per message id
    const u = (msg.usage && typeof msg.usage === 'object' ? msg.usage : null) as Record<string, unknown> | null
    if (u) {
      const key = typeof msg.id === 'string' ? msg.id : `line:${s.usage.size}`
      const i = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
      const o = num(u.output_tokens)
      const prev = s.usage.get(key)
      const ni = Math.max(prev?.i ?? 0, i)
      const no = Math.max(prev?.o ?? 0, o)
      s.tokensIn += ni - (prev?.i ?? 0)
      s.tokensOut += no - (prev?.o ?? 0)
      s.usage.set(key, { i: ni, o: no })
    }
    if (side) return
    if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<')) s.model = msg.model
    const content = Array.isArray(msg.content) ? msg.content : []
    let tool: string | null = null
    let text: string | null = null
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const blk = b as { type?: unknown; name?: unknown; input?: unknown; text?: unknown }
      if (blk.type === 'tool_use' && typeof blk.name === 'string') {
        try {
          tool = summarizeTool('claude', blk.name, blk.input).line
        } catch {
          tool = blk.name
        }
      } else if (blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) text = blk.text
    }
    if (tool) {
      s.doing = redact(tool)
      s.state = 'working'
    } else if (text) {
      s.doing = clip(redact(text), 120)
      s.state = msg.stop_reason === 'end_turn' ? 'idle' : 'working'
    } else s.state = msg.stop_reason === 'end_turn' ? 'idle' : 'working'
    return
  }
  if (side) return
  if (type === 'user') {
    const typed = typedPromptText(r)
    if (typed) {
      s.firstPrompt ??= redact(typed).slice(0, 200)
      if (ts) s.turnStartedAt = ts
      s.state = 'working'
      s.doing = null
    } else s.state = 'working' // a tool result: the agent goes on
    return
  }
  if (type === 'system' && (r.subtype === 'turn_duration' || r.subtype === 'stop_hook_summary')) s.state = 'idle'
}

export function newFileState(file: string, sessionId: string): FileState {
  return {
    path: file,
    sessionId,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    rest: '',
    partial: false,
    cwd: null,
    gitBranch: null,
    custom: null,
    ai: null,
    firstPrompt: null,
    startedAt: null,
    lastAt: null,
    turnStartedAt: null,
    model: null,
    state: 'idle',
    doing: null,
    usage: new Map(),
    tokensIn: 0,
    tokensOut: 0
  }
}

/** Reads what was appended since the last read (or the whole file / its tail the first time). Never throws. */
export function advance(s: FileState, st: { size: number; mtimeMs: number }, redact: (t: string) => string): void {
  try {
    if (st.size < s.offset) Object.assign(s, newFileState(s.path, s.sessionId)) // rewritten: start over
    if (s.offset === 0 && st.size > FULL_SCAN_MAX) {
      // too large to scan: the head for where and what, then the tail only
      const head = readRange(s.path, 0, HEAD_BYTES).toString('utf8').split('\n')
      head.pop()
      for (const l of head) {
        const r = l ? parse(l) : null
        if (r) applyRecord(s, r, redact)
      }
      s.usage.clear()
      s.tokensIn = 0
      s.tokensOut = 0
      s.partial = true
      s.offset = Math.max(0, st.size - TAIL_BYTES)
      s.rest = ''
      const first = readRange(s.path, s.offset, Math.min(CHUNK, st.size - s.offset)).indexOf(0x0a)
      if (first >= 0) s.offset += first + 1
    }
    while (s.offset < st.size) {
      const buf = readRange(s.path, s.offset, Math.min(CHUNK, st.size - s.offset))
      if (!buf.length) break
      s.offset += buf.length
      const lines = (s.rest + buf.toString('utf8')).split('\n')
      s.rest = lines.pop() ?? ''
      for (const l of lines) {
        if (!l) continue
        const r = parse(l)
        if (r) applyRecord(s, r, redact)
      }
    }
    s.size = st.size
    s.mtimeMs = st.mtimeMs
  } catch {
    /* vanished or unreadable mid-read: keep what we have */
  }
}

export interface Watcher {
  close(): unknown
}
export interface ActivityDeps {
  roots(): string[]
  enabled(): boolean
  /** Claude session ids Principia spawned: they show once, as Principia agents. */
  inHiveIds(): Set<string>
  /** Company whose repo, worktree or company folder holds the cwd; null = Elsewhere. */
  companyForCwd(cwd: string): Id | null
  redact(s: string): string
  emit(snap: ActivitySnapshot): void
  /** A session file the index has not seen yet appeared (so history:get can open it). */
  onNewSession?(): void
  /** nativeWatch by default; tests pass a fake. */
  watch?(roots: string[], onChange: (file: string) => void): Watcher
  now?: () => number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

/**
 * The watcher: one native recursive fs.watch per root (a single FSEvents stream on macOS). chokidar was tried first, but
 * without fsevents it opens one handle per transcript (740 on a busy Mac); this keeps it to one per root. Events only
 * name a path: nothing is opened until `changed()` checks it is `<root>/<project>/<session>.jsonl` and lstat says it is a
 * plain file (symlinks are never followed).
 */
export async function nativeWatch(roots: string[], onChange: (file: string) => void): Promise<Watcher> {
  await Promise.resolve()
  const ws: fs.FSWatcher[] = []
  for (const root of roots) {
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => {
        if (typeof name === 'string' && name.endsWith('.jsonl')) onChange(path.join(root, name))
      })
      w.on('error', () => undefined)
      ws.push(w)
    } catch {
      /* a root that vanished */
    }
  }
  return { close: () => ws.forEach((w) => w.close()) }
}

/** The later of a record timestamp and a file mtime, as ISO. */
export function latestIso(lastAt: string | null, mtimeMs: number): string {
  const t = lastAt ? Date.parse(lastAt) : NaN
  return !Number.isFinite(t) || mtimeMs > t ? new Date(mtimeMs).toISOString() : lastAt!
}

export class OutsideActivity {
  private files = new Map<string, FileState>()
  private watcher: Watcher | null = null
  private watcherPending: Promise<void> | null = null
  private dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private ageTimer: NodeJS.Timeout | null = null
  private lastEmit = 0
  private leaseUntil = 0
  private companyCache = new Map<string, Id | null>()

  constructor(private d: ActivityDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }
  get watching(): boolean {
    return !!this.watcher || !!this.watcherPending
  }

  /** activity:open. Starts (or renews) the lease and the watcher; returns the current snapshot. */
  open(): ActivitySnapshot {
    this.leaseUntil = this.now() + LEASE_MS
    if (!this.d.enabled()) {
      this.close()
      return this.build()
    }
    this.companyCache.clear()
    this.scan()
    if (!this.watcher && !this.watcherPending) this.startWatcher()
    if (!this.ageTimer) {
      this.ageTimer = setInterval(() => this.age(), 30_000)
      this.ageTimer.unref?.()
    }
    return this.build()
  }

  /** activity:close (and an expired lease). Nothing keeps running afterwards. */
  close(): void {
    this.leaseUntil = 0
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.ageTimer) clearInterval(this.ageTimer)
    this.ageTimer = null
    this.dirty.clear()
    const w = this.watcher
    this.watcher = null
    try {
      void w?.close()
    } catch {
      /* already closed */
    }
    // the per-file state is small; drop it so a closed layer holds nothing
    this.files.clear()
  }

  private startWatcher(): void {
    const roots = this.d.roots()
    if (!roots.length) return
    const onChange = (file: string): void => this.changed(file)
    if (this.d.watch) {
      this.watcher = this.d.watch(roots, onChange)
      return
    }
    this.watcherPending = nativeWatch(roots, onChange).then(
      (w) => {
        this.watcherPending = null
        if (this.leaseUntil === 0) void w.close() // closed while starting
        else this.watcher = w
      },
      (e) => {
        this.watcherPending = null
        this.d.log?.warn('activity: watcher failed', { e: String(e) })
      }
    )
  }

  /** Is `file` a session transcript directly inside a project folder of a root? */
  private sessionOf(file: string): string | null {
    const m = SESSION_FILE.exec(path.basename(file))
    if (!m) return null
    const project = path.dirname(file)
    if (!this.d.roots().includes(path.dirname(project))) return null
    return m[1]
  }

  /** Watcher callback: queue the file, flush at most once per THROTTLE_MS. */
  changed(file: string): void {
    if (this.leaseUntil === 0) return
    if (!this.sessionOf(file)) return
    this.dirty.add(file)
    if (this.flushTimer) return
    const wait = Math.max(50, THROTTLE_MS - (this.now() - this.lastEmit))
    this.flushTimer = setTimeout(() => this.flush(), wait)
    this.flushTimer.unref?.()
  }

  /** Reads the queued files and emits one snapshot. Exported for tests through `flushNow`. */
  private flush(): void {
    this.flushTimer = null
    if (this.leaseUntil === 0) return
    if (this.now() > this.leaseUntil) {
      this.close()
      return
    }
    let fresh = false
    for (const f of this.dirty) {
      const id = this.sessionOf(f)
      if (!id) continue
      let st: fs.Stats
      try {
        st = fs.lstatSync(f)
      } catch {
        this.files.delete(f)
        continue
      }
      if (!st.isFile()) continue
      let s = this.files.get(f)
      if (!s) {
        s = newFileState(f, id)
        this.files.set(f, s)
        fresh = true
      }
      advance(s, st, this.d.redact)
    }
    this.dirty.clear()
    if (fresh) this.d.onNewSession?.()
    this.emitNow()
  }
  flushNow(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flush()
  }

  private age(): void {
    if (this.now() > this.leaseUntil) {
      this.close()
      return
    }
    this.emitNow()
  }

  private emitNow(): void {
    this.lastEmit = this.now()
    try {
      this.d.emit(this.build())
    } catch {
      /* a closed window */
    }
  }

  /** Stat pass over every root: files inside the window are read (incrementally); older ones are dropped. */
  private scan(): void {
    const cutoff = this.now() - WINDOW_MIN * 60_000
    const seen = new Set<string>()
    for (const root of this.d.roots()) {
      let dirs: fs.Dirent[]
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue // symlinks are never followed
        const pdir = path.join(root, dir.name)
        let names: fs.Dirent[]
        try {
          names = fs.readdirSync(pdir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const f of names) {
          if (!f.isFile()) continue
          const m = SESSION_FILE.exec(f.name)
          if (!m) continue
          const p = path.join(pdir, f.name)
          let st: fs.Stats
          try {
            st = fs.lstatSync(p)
          } catch {
            continue
          }
          if (!st.isFile() || st.mtimeMs < cutoff) continue
          seen.add(p)
          let s = this.files.get(p)
          if (!s) this.files.set(p, (s = newFileState(p, m[1])))
          if (s.size !== st.size || s.mtimeMs !== st.mtimeMs) advance(s, st, this.d.redact)
        }
      }
    }
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p)
  }

  private companyFor(cwd: string | null): Id | null {
    if (!cwd) return null
    if (this.companyCache.has(cwd)) return this.companyCache.get(cwd)!
    let id: Id | null = null
    try {
      id = this.d.companyForCwd(cwd)
    } catch {
      id = null
    }
    this.companyCache.set(cwd, id)
    return id
  }

    /** The snapshot the canvas draws. */
  build(): ActivitySnapshot {
    const now = this.now()
    const disabled = !this.d.enabled()
    const cutoff = now - WINDOW_MIN * 60_000
    const inHive = disabled ? new Set<string>() : this.d.inHiveIds()
    const sessions: ActivitySession[] = []
    if (!disabled)
      for (const s of this.files.values()) {
        if (s.mtimeMs < cutoff || inHive.has(s.sessionId)) continue
        const stale = now - s.mtimeMs > STALE_WORKING_MS
        sessions.push({
          id: s.sessionId,
          path: s.path,
          cwd: s.cwd,
          companyId: this.companyFor(s.cwd),
          title: s.custom ?? s.ai ?? s.firstPrompt ?? (s.cwd ? path.basename(s.cwd) : 'Claude session'),
          state: s.state === 'working' && !stale ? 'working' : 'idle',
          doing: s.doing,
          model: s.model,
          gitBranch: s.gitBranch,
          startedAt: s.startedAt,
          turnStartedAt: s.turnStartedAt,
          // the file's mtime counts too: a record without a timestamp (or a tool still writing) is activity
          lastAt: latestIso(s.lastAt, s.mtimeMs),
          tokensIn: s.tokensIn,
          tokensOut: s.tokensOut,
          tokensPartial: s.partial
        })
      }
    sessions.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
    for (const s of this.files.values()) if (s.mtimeMs < cutoff) this.files.delete(s.path)
    return { at: new Date(now).toISOString(), windowMin: WINDOW_MIN, sessions, disabled }
  }
}
