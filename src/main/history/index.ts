/**
 * Claude history (AUTHORING.md §8; PO9): a read-only index of the user's Claude Code transcripts in
 * `$CLAUDE_CONFIG_DIR/projects` and `~/.claude/projects` (tests/smoke: HIVE_CLAUDE_DIRS, colon-separated roots).
 * - Hive opens files O_RDONLY and never creates, renames, locks or writes anything under those roots; symlinks are
 *   never followed (lstat), so nothing outside a root is read.
 * - The index lives in hive.db (`claude_history`), keyed by path, invalidated by (size, mtimeMs). A refresh is a stat
 *   pass plus a lazy queue processed in slices (<= 25 files or 50 ms per tick); no background loop (PO9): it runs when
 *   Home or the Canvas History layer asks (history:list) and on window focus.
 * No Electron imports.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeHistorySession, HistoryListQuery, HistoryListResult } from '../../shared/authoring'
import type { Id } from '../../shared/types'
import type { DB } from '../db'

export const HEAD_BYTES = 64 * 1024
export const TAIL_BYTES = 64 * 1024
export const FULL_SCAN_MAX = 64 * 1024 * 1024
const SLICE_FILES = 25
const SLICE_MS = 50
const SESSION_FILE = /^([0-9a-zA-Z-]{8,64})\.jsonl$/

/** Roots to read: HIVE_CLAUDE_DIRS overrides everything (tests); else $CLAUDE_CONFIG_DIR/projects and ~/.claude/projects. */
export function historyRoots(env: Record<string, string | undefined>, home = os.homedir()): string[] {
  const raw = env.HIVE_CLAUDE_DIRS
    ? env.HIVE_CLAUDE_DIRS.split(':').filter(Boolean)
    : [env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'projects') : '', path.join(home, '.claude', 'projects')].filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    let real = r
    try {
      real = fs.realpathSync(r)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    out.push(real)
  }
  return out
}

interface Row {
  path: string
  root: string
  project_dir: string
  session_id: string
  size: number
  mtime_ms: number
  cwd: string | null
  git_branch: string | null
  title: string
  title_source: string
  first_prompt: string | null
  started_at: string | null
  ended_at: string | null
  turns: number | null
  subagents: number
  model: string | null
  version: string | null
  entrypoint: string | null
  indexed_at: string
  error: string | null
}

export interface Indexed {
  cwd: string | null
  gitBranch: string | null
  title: string
  titleSource: 'custom' | 'ai' | 'prompt'
  firstPrompt: string | null
  startedAt: string | null
  endedAt: string | null
  turns: number | null
  subagents: number
  model: string | null
  version: string | null
  entrypoint: string | null
  error: string | null
}

function readRange(file: string, start: number, len: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY)
  try {
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const parse = (l: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(l)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const WRAPPER = /^\s*<(command-|local-command|system-reminder|bash-|user-prompt-submit-hook)/

/** The text a human typed, or null (tool results, command wrappers, meta). */
export function typedPromptText(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true) return null
  const human = rec.promptSource === 'typed' || rec.turnOrigin === 'human' || (rec.promptSource === undefined && rec.turnOrigin === undefined)
  if (!human) return null
  const msg = rec.message as { content?: unknown } | undefined
  const c = msg?.content
  let text: string | null = null
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    if (c.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result')) return null
    const t = c.find((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') as { text?: unknown } | undefined
    text = typeof t?.text === 'string' ? t.text : null
  }
  if (!text || WRAPPER.test(text)) return null
  const s = text.replace(/\s+/g, ' ').trim()
  return s || null
}

const isTypedLine = (l: string): boolean =>
  l.includes('"type":"user"') &&
  (l.includes('"promptSource":"typed"') || l.includes('"turnOrigin":"human"')) &&
  !l.includes('<command-name>') &&
  !l.includes('<local-command')

/** Head + tail + streaming turn count. Never throws (errors land in `error`). */
export function indexFile(file: string, size: number, sessionId: string): Indexed {
  const out: Indexed = {
    cwd: null,
    gitBranch: null,
    title: sessionId,
    titleSource: 'prompt',
    firstPrompt: null,
    startedAt: null,
    endedAt: null,
    turns: null,
    subagents: 0,
    model: null,
    version: null,
    entrypoint: null,
    error: null
  }
  try {
    const head = readRange(file, 0, Math.min(size, HEAD_BYTES))
    const headLines = head.split('\n')
    if (size > HEAD_BYTES) headLines.pop() // partial
    for (const l of headLines) {
      const r = parse(l)
      if (!r) continue
      if (!out.cwd && typeof r.cwd === 'string') {
        out.cwd = r.cwd
        out.gitBranch = typeof r.gitBranch === 'string' && r.gitBranch ? r.gitBranch : null
        out.version = typeof r.version === 'string' ? r.version : null
        out.entrypoint = typeof r.entrypoint === 'string' ? r.entrypoint : null
      }
      if (!out.startedAt && typeof r.timestamp === 'string') out.startedAt = r.timestamp
      if (!out.firstPrompt) {
        const t = typedPromptText(r)
        if (t) out.firstPrompt = t.slice(0, 200)
      }
      if (out.cwd && out.startedAt && out.firstPrompt) break
    }
    const start = Math.max(0, size - TAIL_BYTES)
    const tail = start === 0 && size <= HEAD_BYTES ? head : readRange(file, start, size - start)
    const tailLines = tail.split('\n')
    if (start > 0) tailLines.shift() // partial
    let custom: string | null = null
    let ai: string | null = null
    for (const l of tailLines) {
      if (!l) continue
      const r = parse(l)
      if (!r) continue
      if (r.type === 'custom-title') {
        const v = r.customTitle ?? r.title
        if (typeof v === 'string' && v.trim()) custom = v.trim()
      } else if (r.type === 'ai-title') {
        const v = r.aiTitle ?? r.title
        if (typeof v === 'string' && v.trim()) ai = v.trim()
      }
      if (typeof r.timestamp === 'string') out.endedAt = r.timestamp
      if (r.type === 'assistant') {
        const m = (r.message as { model?: unknown } | undefined)?.model
        if (typeof m === 'string' && m && !m.startsWith('<')) out.model = m
      }
      if (!out.cwd && typeof r.cwd === 'string') out.cwd = r.cwd
    }
    if (custom) {
      out.title = custom.slice(0, 200)
      out.titleSource = 'custom'
    } else if (ai) {
      out.title = ai.slice(0, 200)
      out.titleSource = 'ai'
    } else if (out.firstPrompt) out.title = out.firstPrompt
    out.endedAt ??= out.startedAt
    if (size <= FULL_SCAN_MAX) {
      // substring test per line, no JSON.parse (fast on large files)
      const fd = fs.openSync(file, fs.constants.O_RDONLY)
      try {
        const buf = Buffer.alloc(1024 * 1024)
        let pos = 0
        let rest = ''
        let turns = 0
        for (;;) {
          const n = fs.readSync(fd, buf, 0, buf.length, pos)
          if (n <= 0) break
          pos += n
          const chunk = rest + buf.subarray(0, n).toString('utf8')
          const lines = chunk.split('\n')
          rest = lines.pop() ?? ''
          for (const l of lines) if (isTypedLine(l)) turns++
        }
        if (rest && isTypedLine(rest)) turns++
        out.turns = turns
      } finally {
        fs.closeSync(fd)
      }
    }
    const subDir = path.join(path.dirname(file), sessionId, 'subagents')
    try {
      out.subagents = fs.readdirSync(subDir).filter((f) => /^agent-.*\.jsonl$/.test(f)).length
    } catch {
      out.subagents = 0
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
  }
  return out
}

export interface HistoryDeps {
  db: DB
  roots(): string[]
  enabled(): boolean
  /** Claude conversation ids Hive spawned (sessions + run steps). */
  inHiveIds(): Set<string>
  repoIdForCwd(cwd: string): Id | null
  redact(s: string): string
  emitChanged(total: number): void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
  /** Test hook: run queued work synchronously. */
  schedule?: (fn: () => void) => void
}

export class ClaudeHistory {
  private queue: { path: string; root: string; projectDir: string; sessionId: string; size: number; mtimeMs: number }[] = []
  private working = false
  private changedTimer: NodeJS.Timeout | null = null
  private now: () => Date
  private schedule: (fn: () => void) => void

  constructor(private d: HistoryDeps) {
    this.now = d.now ?? (() => new Date())
    this.schedule = d.schedule ?? ((fn) => setImmediate(fn))
  }

  get indexing(): boolean {
    return this.working || this.queue.length > 0
  }

  /** Stat pass (no reads of unchanged files); queues new/changed files; drops vanished rows. */
  refresh(): { queued: number; total: number } {
    if (!this.d.enabled()) return { queued: 0, total: 0 }
    const known = new Map<string, { size: number; mtime: number }>()
    for (const r of this.d.db.prepare('SELECT path, size, mtime_ms FROM claude_history').all() as { path: string; size: number; mtime_ms: number }[]) {
      known.set(r.path, { size: r.size, mtime: r.mtime_ms })
    }
    const seen = new Set<string>()
    const queued = new Set(this.queue.map((q) => q.path))
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
        let files: fs.Dirent[]
        try {
          files = fs.readdirSync(pdir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const f of files) {
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
          if (!st.isFile()) continue
          seen.add(p)
          const k = known.get(p)
          if (k && k.size === st.size && k.mtime === st.mtimeMs) continue
          if (queued.has(p)) continue
          this.queue.push({ path: p, root, projectDir: dir.name, sessionId: m[1], size: st.size, mtimeMs: st.mtimeMs })
          queued.add(p)
        }
      }
    }
    const del = this.d.db.prepare('DELETE FROM claude_history WHERE path = ?')
    let removed = 0
    for (const p of known.keys()) if (!seen.has(p)) removed += del.run(p).changes
    const queuedNow = this.queue.length
    if (this.queue.length && !this.working) {
      this.working = true
      this.schedule(() => this.drain())
    } else if (removed) this.changed()
    return { queued: queuedNow, total: known.size - removed }
  }

  private drain(): void {
    const t0 = Date.now()
    let n = 0
    const up = this.d.db.prepare(
      `INSERT INTO claude_history(path, root, project_dir, session_id, size, mtime_ms, cwd, git_branch, title, title_source, first_prompt,
         started_at, ended_at, turns, subagents, model, version, entrypoint, indexed_at, error)
       VALUES (@path, @root, @project_dir, @session_id, @size, @mtime_ms, @cwd, @git_branch, @title, @title_source, @first_prompt,
         @started_at, @ended_at, @turns, @subagents, @model, @version, @entrypoint, @indexed_at, @error)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, cwd = excluded.cwd, git_branch = excluded.git_branch,
         title = excluded.title, title_source = excluded.title_source, first_prompt = excluded.first_prompt, started_at = excluded.started_at,
         ended_at = excluded.ended_at, turns = excluded.turns, subagents = excluded.subagents, model = excluded.model,
         version = excluded.version, entrypoint = excluded.entrypoint, indexed_at = excluded.indexed_at, error = excluded.error`
    )
    while (this.queue.length && n < SLICE_FILES && Date.now() - t0 < SLICE_MS) {
      const q = this.queue.shift()!
      n++
      const x = indexFile(q.path, q.size, q.sessionId)
      try {
        up.run({
          path: q.path,
          root: q.root,
          project_dir: q.projectDir,
          session_id: q.sessionId,
          size: q.size,
          mtime_ms: q.mtimeMs,
          cwd: x.cwd,
          git_branch: x.gitBranch,
          title: this.d.redact(x.title).slice(0, 200),
          title_source: x.titleSource,
          first_prompt: x.firstPrompt ? this.d.redact(x.firstPrompt).slice(0, 200) : null,
          started_at: x.startedAt,
          ended_at: x.endedAt,
          turns: x.turns,
          subagents: x.subagents,
          model: x.model,
          version: x.version,
          entrypoint: x.entrypoint,
          indexed_at: this.now().toISOString(),
          error: x.error
        })
      } catch (e) {
        this.d.log?.warn('history: index row failed', { e: String(e) })
      }
    }
    if (this.queue.length) this.schedule(() => this.drain())
    else {
      this.working = false
      this.changed()
    }
  }

  private changed(): void {
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      // the debounce can outlive the db on quit (and in tests)
      if (!this.d.db.open) return
      const total = (this.d.db.prepare('SELECT count(*) AS n FROM claude_history').get() as { n: number }).n
      this.d.emitChanged(total)
    }, 1000)
    this.changedTimer.unref?.()
  }

  private toSession(r: Row, inHive: Set<string>): ClaudeHistorySession {
    return {
      id: r.session_id,
      path: r.path,
      cwd: r.cwd,
      repoId: r.cwd ? this.d.repoIdForCwd(r.cwd) : null,
      gitBranch: r.git_branch,
      title: r.error && r.title === r.session_id ? `${r.session_id}.jsonl` : r.title,
      titleSource: (r.title_source as ClaudeHistorySession['titleSource']) ?? 'prompt',
      startedAt: r.started_at,
      endedAt: r.ended_at,
      turns: r.turns,
      subagents: r.subagents,
      model: r.model,
      inHive: inHive.has(r.session_id)
    }
  }

  /** history:list (default: last 7 days, outside Hive, <= 500). Triggers a refresh (PO9). */
  list(q: HistoryListQuery = {}): HistoryListResult {
    if (!this.d.enabled()) return { items: [], total: 0, indexing: false }
    this.refresh()
    const since = q.since ?? new Date(this.now().getTime() - 7 * 86400_000).toISOString()
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500)
    const rows = this.d.db
      .prepare("SELECT * FROM claude_history WHERE COALESCE(ended_at, started_at, '') >= ? ORDER BY COALESCE(ended_at, started_at) DESC")
      .all(since) as Row[]
    const inHive = this.d.inHiveIds()
    const query = q.query?.toLowerCase().trim() ?? ''
    let items = rows.map((r) => this.toSession(r, inHive))
    if (!q.includeInHive) items = items.filter((s) => !s.inHive)
    if (q.repoId) items = items.filter((s) => s.repoId === q.repoId)
    if (query) items = items.filter((s) => s.title.toLowerCase().includes(query) || (s.cwd ?? '').toLowerCase().includes(query))
    return { items: items.slice(0, limit), total: items.length, indexing: this.indexing }
  }

  /** The indexed row for a claude session id (newest file wins). */
  byId(id: string): ClaudeHistorySession | null {
    const r = this.d.db.prepare('SELECT * FROM claude_history WHERE session_id = ? ORDER BY mtime_ms DESC LIMIT 1').get(id) as Row | undefined
    return r ? this.toSession(r, this.d.inHiveIds()) : null
  }

  /** Path check: only files inside a current root are ever opened (defense in depth for history:get). */
  isInsideRoot(p: string): boolean {
    return this.d.roots().some((r) => p.startsWith(r + path.sep))
  }
}
