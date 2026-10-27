/**
 * docs/USAGE.md §5: usage:tokens. Every token the founder's coding agents spent on this Mac, per local day and source:
 * Claude Code transcripts (`<claude root>/<project>/<session>.jsonl` and its subagents), Codex rollouts
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<id>.jsonl`) and Principia's own records in hive.db (agents roots and orch_usage)
 * that left no transcript. "Tokens" = fresh input + output + cache writes + cache reads, what the CLIs report.
 *
 * Read-only toward ~/.claude and ~/.codex, with the history rules (history/index.ts): files are opened
 * O_RDONLY|O_NOFOLLOW, walked with lstat-typed dirents (symlinks are never followed), nothing under a root is written.
 *
 * Cheap after the first time: an incremental cache in Principia's data dir (`<userData>/token-activity.json`) keeps,
 * per file, its size, mtime, inode and the byte offset read so far, plus the tokens per 15-minute bucket and model, so
 * a later scan reads only the bytes appended since. The scan is async: 1 MB reads, one yield per chunk, never more than
 * one at a time. No Electron imports.
 *
 * Not double counted:
 * - Claude: a message streamed over several lines (or copied into a resumed or forked session) repeats its usage; it
 *   counts once per message id + request id, keeping the largest value of each part. Keys are kept DEDUPE_DAYS; older
 *   messages fold into the buckets and a line older than the fold watermark read later is a copy (skipped).
 * - Codex: each token_count event carries the session's running total; the delta from the previous one counts.
 * - Principia: a run or chat whose CLI session id has a Claude or Codex transcript is already in it; codex orch calls
 *   (`codex exec` keeps a rollout) are too. Claude orch calls run with --no-session-persistence, so they count here.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TokenActivity, TokenActivityDay, TokenCounts, TokenSource, TokenSourceId } from '../../shared/usage'
import { dayKey } from '../../shared/tokenActivity'
import type { DB } from '../db'
import { typedPromptText } from '../history'

export const CACHE_VERSION = 1
export const CACHE_FILE = 'token-activity.json'
/** A gap longer than this inside a turn is the agent waiting on the person, not work. */
export const IDLE_GAP_MS = 10 * 60_000
/** Claude message keys are kept this long for dedupe, then folded into buckets. */
export const DEDUPE_DAYS = 7
/** Pending bytes under this: the IPC answer waits for the scan; above: it answers "counting" right away. */
export const SYNC_BYTES = 64 * 1024 * 1024
/** A scan younger than this is reused as is. */
export const FRESH_MS = 15_000
const CHUNK = 1024 * 1024
const MAX_LINE = 64 * 1024 * 1024
const SAVE_EVERY = 256 * 1024 * 1024
const BUCKET_MS = 15 * 60_000
const DAY_MS = 86_400_000

/** [input (uncached), output, cacheWrite, cacheRead] */
type Quad = [number, number, number, number]
/** [timestamp ms, model index, ...Quad] */
type Msg = [number, number, number, number, number, number]
type Buckets = Record<string, Record<string, Quad>>

interface FileBase {
  size: number
  mtimeMs: number
  ino: number
  offset: number
  /** Claude: the session id (file name, or the parent session of a subagent file). Codex: the thread id. */
  session: string | null
  longest: number
}
export interface ClaudeFile extends FileBase {
  k: 'claude'
  /** a session's own transcript (not a subagent's): turns are timed here */
  main: boolean
  /** the open turn: [start, last record, active ms] */
  turn: [number, number, number] | null
}
export interface CodexFile extends FileBase {
  k: 'codex'
  model: string | null
  prev: Quad | null
  q: Buckets
}
export interface TokenCache {
  v: number
  files: Record<string, ClaudeFile | CodexFile>
  models: string[]
  /** Claude messages of the last DEDUPE_DAYS, by message id + request id */
  msgs: Record<string, Msg>
  /** older Claude messages, folded */
  folded: Buckets
  /** a Claude line older than this was folded already */
  watermark: number
}

export const emptyCache = (): TokenCache => ({ v: CACHE_VERSION, files: {}, models: [], msgs: {}, folded: {}, watermark: 0 })

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const parse = (l: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(l)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null // a line we cannot read is skipped
  }
}
const bucketOf = (ms: number): string => String(Math.floor(ms / BUCKET_MS))
function addQuad(b: Buckets, ms: number, model: string, q: Quad): void {
  const k = bucketOf(ms)
  const at = (b[k] ??= {})
  const cur = (at[model] ??= [0, 0, 0, 0])
  for (let i = 0; i < 4; i++) cur[i] += q[i]
}
function modelIndex(c: TokenCache, m: string | null): number {
  const name = m && !m.startsWith('<') ? m : 'unknown'
  let i = c.models.indexOf(name)
  if (i < 0) i = c.models.push(name) - 1
  return i
}

// ---------- Claude ----------
/** One Claude transcript record. Exported for tests. */
export function applyClaude(c: TokenCache, f: ClaudeFile, r: Record<string, unknown>, file: string): void {
  const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  if (!Number.isFinite(ts)) return
  const side = r.isSidechain === true
  if (r.type === 'assistant') {
    const msg = obj(r.message)
    const u = msg.usage && typeof msg.usage === 'object' ? obj(msg.usage) : null
    if (u && ts >= c.watermark) {
      const id = str(msg.id)
      const key = id ? `${id}:${str(r.requestId) ?? str(r.request_id) ?? ''}` : `${file}#${str(r.uuid) ?? ts}`
      const q: Quad = [num(u.input_tokens), num(u.output_tokens), num(u.cache_creation_input_tokens), num(u.cache_read_input_tokens)]
      const prev = c.msgs[key]
      if (prev) for (let i = 0; i < 4; i++) prev[2 + i] = Math.max(prev[2 + i], q[i])
      else if (q.some((x) => x > 0)) c.msgs[key] = [ts, modelIndex(c, str(msg.model)), ...q]
    }
  }
  if (!f.main || side) return
  // turns: a typed prompt opens one; every later record of the session extends it, gaps over IDLE_GAP_MS left out
  if (r.type === 'user' && typedPromptText(r) !== null) {
    f.turn = [ts, ts, 0]
    return
  }
  const t = f.turn
  if (!t) return
  const gap = ts - t[1]
  if (gap > 0) {
    if (gap <= IDLE_GAP_MS) t[2] += gap
    t[1] = ts
    if (t[2] > f.longest) f.longest = t[2]
  }
}

// ---------- Codex ----------
/** One Codex rollout record. Exported for tests. */
export function applyCodex(f: CodexFile, r: Record<string, unknown>): void {
  const p = obj(r.payload)
  if (r.type === 'session_meta') {
    f.session ??= str(p.id)
    return
  }
  if (r.type === 'turn_context') {
    f.model = str(p.model) ?? f.model
    return
  }
  if (r.type !== 'event_msg') return
  if (p.type === 'task_complete') {
    const d = num(p.duration_ms)
    if (d > f.longest) f.longest = d
    return
  }
  if (p.type !== 'token_count') return
  const info = obj(p.info)
  const total = info.total_token_usage ? obj(info.total_token_usage) : null
  const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  if (!total || !Number.isFinite(ts)) return
  // OpenAI counts cached input inside input_tokens: fresh input is the difference
  const quad = (u: Record<string, unknown>): Quad => {
    const cached = num(u.cached_input_tokens)
    return [Math.max(0, num(u.input_tokens) - cached), num(u.output_tokens), num(u.cache_write_input_tokens), cached]
  }
  const cur = quad(total)
  const base = f.prev ?? [0, 0, 0, 0]
  let delta = cur.map((v, i) => v - base[i]) as Quad
  // a running total that went down was reset (a new thread in the same file): this event's own usage counts
  if (delta.some((v) => v < 0)) delta = info.last_token_usage ? quad(obj(info.last_token_usage)) : [0, 0, 0, 0]
  f.prev = cur
  if (delta.some((v) => v > 0)) addQuad(f.q, ts, f.model ?? 'unknown', delta)
}

// ---------- files ----------
export interface Found {
  path: string
  kind: 'claude' | 'codex'
  size: number
  mtimeMs: number
  ino: number
  session: string | null
  main: boolean
}

/** Codex rollout roots: HIVE_CODEX_DIRS (tests) overrides; else $CODEX_HOME and ~/.codex, sessions + archived_sessions. */
export function codexRoots(env: Record<string, string | undefined>, home = os.homedir()): string[] {
  const homes = [env.CODEX_HOME?.trim() || '', path.join(home, '.codex')].filter(Boolean)
  const raw = env.HIVE_CODEX_DIRS ? env.HIVE_CODEX_DIRS.split(':').filter(Boolean) : homes.flatMap((h) => [path.join(h, 'sessions'), path.join(h, 'archived_sessions')])
  const out: string[] = []
  for (const r of raw) {
    try {
      const real = fs.realpathSync(r)
      if (!out.includes(real)) out.push(real)
    } catch {
      /* missing */
    }
  }
  return out
}

const CLAUDE_FILE = /^([0-9a-zA-Z_-]{1,80})\.jsonl$/
const CODEX_FILE = /^rollout-[0-9A-Za-z_.-]+\.jsonl$/
const UUIDISH = /^[0-9a-zA-Z-]{8,64}$/

/** Every transcript under the roots (depth-limited walk, symlinks never followed). */
export async function discover(claudeRoots: string[], codex: string[]): Promise<Found[]> {
  const out: Found[] = []
  const walk = async (root: string, dir: string, depth: number, kind: 'claude' | 'codex'): Promise<void> => {
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 5) await walk(root, p, depth + 1, kind)
        continue
      }
      if (!e.isFile() || !(kind === 'claude' ? CLAUDE_FILE : CODEX_FILE).test(e.name)) continue
      let st: fs.Stats
      try {
        st = await fs.promises.lstat(p)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      let session: string | null = null
      let main = false
      if (kind === 'claude') {
        // <root>/<project>/<session>.jsonl, or <root>/<project>/<session>/subagents/…/agent-x.jsonl
        const rel = path.relative(root, p).split(path.sep)
        if (rel.length === 2) {
          session = e.name.slice(0, -'.jsonl'.length)
          main = UUIDISH.test(session)
        } else if (rel.length > 2 && UUIDISH.test(rel[1])) session = rel[1]
      }
      out.push({ path: p, kind, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, session, main })
    }
  }
  for (const r of claudeRoots) await walk(r, r, 0, 'claude')
  for (const r of codex) await walk(r, r, 0, 'codex')
  return out
}

function freshEntry(f: Found): ClaudeFile | CodexFile {
  const base = { size: 0, mtimeMs: 0, ino: f.ino, offset: 0, session: f.session, longest: 0 }
  return f.kind === 'claude' ? { ...base, k: 'claude', main: f.main, turn: null } : { ...base, k: 'codex', model: null, prev: null, q: {} }
}

/** Matches a found file to its cache entry: a new file, or one rewritten (other inode, or shorter), starts over. */
export function reconcile(c: TokenCache, f: Found): ClaudeFile | CodexFile {
  const e = c.files[f.path]
  if (!e || e.k !== f.kind || e.ino !== f.ino || f.size < e.offset) return (c.files[f.path] = freshEntry(f))
  return e
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Reads a file from its offset to the last complete line, a chunk at a time. Never throws. */
export async function readFile(c: TokenCache, file: string, e: ClaudeFile | CodexFile, size: number, onBytes: (n: number) => void): Promise<void> {
  let fh: fs.promises.FileHandle | null = null
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    let carry: Buffer | null = null
    let pos = e.offset
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos)
      const buf = Buffer.allocUnsafe(len)
      const { bytesRead } = await fh.read(buf, 0, len, pos)
      if (!bytesRead) break
      pos += bytesRead
      onBytes(bytesRead)
      const data: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const nl = data.lastIndexOf(0x0a)
      if (nl < 0) {
        // one line longer than a chunk: keep gathering, but give up on a line past MAX_LINE (skip to its end)
        carry = data.length > MAX_LINE ? null : data
        if (!carry) {
          const rest = await skipLine(fh, pos, size)
          if (rest < 0) break
          pos = rest
          e.offset = pos
        }
        continue
      }
      carry = nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null
      const text = data.toString('utf8', 0, nl)
      for (const l of text.split('\n')) {
        if (!l) continue
        const r = parse(l)
        if (!r) continue
        if (e.k === 'claude') applyClaude(c, e, r, file)
        else applyCodex(e, r)
      }
      e.offset = pos - (carry?.length ?? 0)
      await tick()
    }
  } catch {
    /* vanished or unreadable mid-read: keep what was read */
  } finally {
    await fh?.close().catch(() => undefined)
  }
}
async function skipLine(fh: fs.promises.FileHandle, pos: number, size: number): Promise<number> {
  const buf = Buffer.allocUnsafe(CHUNK)
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos)
    if (!bytesRead) return -1
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a)
    if (nl >= 0) return pos + nl + 1
    pos += bytesRead
  }
  return -1
}

/** Claude messages older than DEDUPE_DAYS move into the folded buckets; the watermark follows. */
export function fold(c: TokenCache, now: number): void {
  const cutoff = now - DEDUPE_DAYS * DAY_MS
  for (const [k, m] of Object.entries(c.msgs)) {
    if (m[0] >= cutoff) continue
    addQuad(c.folded, m[0], c.models[m[1]] ?? 'unknown', [m[2], m[3], m[4], m[5]])
    delete c.msgs[k]
  }
  c.watermark = Math.max(c.watermark, cutoff)
}

export function loadCache(file: string): TokenCache {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as TokenCache
    if (v && v.v === CACHE_VERSION && v.files && v.msgs && v.folded && Array.isArray(v.models)) return v
  } catch {
    /* missing or broken: start over */
  }
  return emptyCache()
}
export async function saveCache(file: string, c: TokenCache): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(tmp, JSON.stringify(c), { mode: 0o600 })
    await fs.promises.rename(tmp, file)
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
  }
}

// ---------- Principia's own records ----------
export interface PrincipiaRow {
  at: string
  provider: string
  model: string | null
  tokensIn: number
  tokensOut: number
  /** the CLI session id (Claude session, Codex thread) when known */
  sessionId: string | null
  orch: boolean
}
const tryAll = <T>(db: DB, sql: string): T[] => {
  try {
    return db.prepare(sql).all() as T[]
  } catch {
    return [] // an older or fresh db without a table/column
  }
}
/** Root agents (their subagents are inside) and Principia's own calls, every day. */
export function principiaRows(db: DB): PrincipiaRow[] {
  type R = { at: string; provider: string; model: string | null; tin: number | null; tout: number | null; sid: string | null }
  const agents = tryAll<R>(
    db,
    `SELECT a.started_at AS at, a.provider, a.model, a.tokens_in AS tin, a.tokens_out AS tout, COALESCE(s.agent_session_id, rs.agent_session_id) AS sid
     FROM agents a LEFT JOIN sessions s ON s.id = a.session_id LEFT JOIN run_steps rs ON rs.id = a.step_id
     WHERE a.parent_id IS NULL AND COALESCE(a.tokens_in, 0) + COALESCE(a.tokens_out, 0) > 0`
  )
  const orch = tryAll<R>(db, 'SELECT at, cli AS provider, model, tokens_in AS tin, tokens_out AS tout, NULL AS sid FROM orch_usage WHERE tokens_in + tokens_out > 0')
  const row = (r: R, o: boolean): PrincipiaRow => ({ at: r.at, provider: r.provider, model: r.model, tokensIn: num(r.tin), tokensOut: num(r.tout), sessionId: r.sid, orch: o })
  return [...agents.map((r) => row(r, false)), ...orch.map((r) => row(r, true))]
}

// ---------- the service ----------
export interface TokenDeps {
  cachePath: string
  claudeRoots(): string[]
  /** Settings › Claude Code history: off = Claude transcripts are not read */
  claudeEnabled(): boolean
  codexRoots(): string[]
  principia(): PrincipiaRow[]
  now?: () => number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const LABEL: Record<TokenSourceId, string> = { claude: 'Claude Code', codex: 'Codex', principia: 'Principia’s own calls' }

export class TokenActivityService {
  private cache: TokenCache | null = null
  private scanning: Promise<void> | null = null
  private progress: TokenActivity['progress'] = null
  private lastScan = 0

  constructor(private d: TokenDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** usage:tokens. Starts a scan when the last one is stale; waits for it only when it is small. */
  async get(): Promise<TokenActivity> {
    this.cache ??= loadCache(this.d.cachePath)
    if (!this.scanning && this.now() - this.lastScan > FRESH_MS) {
      const pending = { bytes: 0 }
      const ready = new Promise<void>((resolve) => {
        this.scanning = this.scan(pending, resolve).finally(() => {
          this.scanning = null
          this.progress = null
          this.lastScan = this.now()
          resolve()
        })
      })
      await ready // resolves once the stat pass knows how much there is to read
      if (this.scanning && pending.bytes <= SYNC_BYTES) await this.scanning
    }
    return this.build(this.scanning ? 'counting' : 'ready')
  }

  /** Waits for a running scan (tests, quit). */
  async idle(): Promise<void> {
    await this.scanning
  }

  private async scan(pending: { bytes: number }, measured: () => void): Promise<void> {
    const c = this.cache!
    let found: Found[] = []
    try {
      found = await discover(this.d.claudeEnabled() ? this.d.claudeRoots() : [], this.d.codexRoots())
    } catch (e) {
      this.d.log?.warn('usage:tokens discover failed', { e: String(e) })
    }
    const todo = found
      .map((f) => ({ f, e: reconcile(c, f) }))
      .filter(({ f, e }) => f.size > e.offset || f.mtimeMs !== e.mtimeMs)
    pending.bytes = todo.reduce((n, { f, e }) => n + Math.max(0, f.size - e.offset), 0)
    this.progress = { bytesDone: 0, bytesTotal: pending.bytes, filesDone: 0, filesTotal: todo.length }
    measured()
    let sinceSave = 0
    for (const { f, e } of todo) {
      await readFile(c, f.path, e, f.size, (n) => {
        this.progress!.bytesDone += n
        sinceSave += n
      })
      e.size = f.size
      e.mtimeMs = f.mtimeMs
      this.progress!.filesDone++
      if (sinceSave > SAVE_EVERY) {
        sinceSave = 0
        await saveCache(this.d.cachePath, c) // a quit mid-scan resumes from here
      }
    }
    fold(c, this.now())
    if (todo.length || !fs.existsSync(this.d.cachePath)) await saveCache(this.d.cachePath, c)
  }

  /** The answer, from the cache (Claude, Codex) and hive.db (Principia), per local day. */
  build(state: TokenActivity['state']): TokenActivity {
    const c = this.cache ?? emptyCache()
    const claudeOn = this.d.claudeEnabled()
    const days = new Map<string, TokenActivityDay>()
    const totals: Record<TokenSourceId, number> = { claude: 0, codex: 0, principia: 0 }
    const add = (src: TokenSourceId, ms: number, model: string, q: Quad): void => {
      const date = dayKey(new Date(ms))
      let d = days.get(date)
      if (!d) days.set(date, (d = { date, byProvider: {}, byModel: {} }))
      const cur: TokenCounts = (d.byProvider[src] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
      cur.input += q[0]
      cur.output += q[1]
      cur.cacheWrite += q[2]
      cur.cacheRead += q[3]
      const n = q[0] + q[1] + q[2] + q[3]
      d.byModel[model] = (d.byModel[model] ?? 0) + n
      totals[src] += n
    }
    const addBuckets = (src: TokenSourceId, b: Buckets): void => {
      for (const [k, models] of Object.entries(b)) for (const [m, q] of Object.entries(models)) add(src, Number(k) * BUCKET_MS, m, q)
    }
    const seen = new Set<string>()
    let longest = 0
    let codexFiles = 0
    let claudeFiles = 0
    if (claudeOn) {
      addBuckets('claude', c.folded)
      for (const m of Object.values(c.msgs)) add('claude', m[0], c.models[m[1]] ?? 'unknown', [m[2], m[3], m[4], m[5]])
    }
    for (const e of Object.values(c.files)) {
      if (e.k === 'codex') {
        codexFiles++
        addBuckets('codex', e.q)
      } else if (!claudeOn) continue
      else claudeFiles++
      if (e.session) seen.add(e.session)
      longest = Math.max(longest, e.longest)
    }
    // Principia's own records that no transcript holds
    let rows: PrincipiaRow[] = []
    try {
      rows = this.d.principia()
    } catch {
      rows = []
    }
    let skipped = 0
    for (const r of rows) {
      const ms = Date.parse(r.at)
      if (!Number.isFinite(ms)) continue
      const inTranscript = (r.sessionId && seen.has(r.sessionId)) || (r.orch && r.provider === 'codex' && codexFiles > 0)
      if (inTranscript) {
        skipped++
        continue
      }
      // hive.db keeps input (cache included) and output only
      add('principia', ms, r.model ?? r.provider, [r.tokensIn, r.tokensOut, 0, 0])
    }
    const sources: TokenSource[] = [
      {
        id: 'claude',
        label: LABEL.claude,
        counted: claudeOn && claudeFiles > 0,
        tokens: totals.claude,
        ...(!claudeOn ? { note: 'Claude Code history is off in Settings' } : !claudeFiles ? { note: 'No transcripts on this Mac' } : {})
      },
      { id: 'codex', label: LABEL.codex, counted: codexFiles > 0, tokens: totals.codex, ...(!codexFiles ? { note: 'No rollouts on this Mac' } : {}) },
      {
        id: 'principia',
        label: LABEL.principia,
        counted: true,
        tokens: totals.principia,
        note: skipped ? `${skipped} runs and chats already counted in their transcripts` : 'Runs and chats without a transcript'
      }
    ]
    return {
      state,
      progress: state === 'counting' ? this.progress : null,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      longestTaskMs: longest,
      sources,
      at: new Date(this.now()).toISOString()
    }
  }
}
