/**
 * CHAT-UI.md §3: all chat sessions. SessionManager spawns every Claude pane through `spawn` (its PtySpawn with the
 * host info); the hub decides chat or terminal, keeps the registry, batches ops to the renderer (redacted, numbered)
 * and remembers each session's mode (Restart keeps it; an exited chat still reads as a chat).
 * No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Id, AdapterId } from '../../shared/types'
import type { ChatDecision, ChatImage, ChatMode, ChatOp, ChatSnapshot, OpenChatsAs } from '../../shared/chat'
import { EMPTY_CHAT_META } from '../../shared/chat'
import { HiveError } from '../../shared/errors'
import type { PtyLike, PtySpawn } from '../sessions'
import { ChatSession, replayItems, type ChatAskBridge } from './chatSession'
import { CodexChatSession } from './codexSession'
import { defaultChildSpawn, type ChildSpawn } from './streamProc'
import { versionAtLeast } from './chatArgs'

/** AGENT CHAT: codex app-server's thread protocol is verified on this version and newer. */
export const CODEX_CHAT_MIN_VERSION = '0.163.0'

/** What the hub needs of a chat, Claude's (ChatSession) or Codex's (CodexChatSession). */
export type ChatLike = ChatSession | CodexChatSession

const FLUSH_MS = 16

/** What SessionManager tells the spawner about the pane it starts. */
export interface PtyHostInfo {
  sessionId: Id
  adapter: AdapterId
  /** a repo or worktree session (code work): Auto opens it as a terminal */
  codeWork: boolean
  /** the user picked a mode for this session (sessions:create mode) */
  mode?: ChatMode | null
  /** the conversation this spawn resumes (Restart): its last mode wins */
  resumeId?: string | null
}

export interface ChatHubDeps {
  userData: string
  emit(sessionId: Id, seq: number, ops: ChatOp[]): void
  redact(text: string): string
  openChatsAs(): OpenChatsAs
  claudeVersion(): string | null
  /** AGENT CHAT: the installed codex version (Codex agent chats need the app-server protocol) */
  codexVersion?(): string | null
  /** AGENT CHAT: the conversation id of a session is known (a new Codex thread): Restart resumes it */
  onConversation?(sessionId: Id, conv: string): void
  killGroup(pid: number, signal: NodeJS.Signals): boolean
  registerPid?(sessionId: Id, pid: number): void
  asks?(sessionId: Id): ChatAskBridge | null
  /** AGENT CHAT: the name a chat speaks in (an agent's chat: the agent's name); null = the AI tool's own */
  speakerOf?(sessionId: Id): string | null
  terminalWorking?(sessionId: Id): boolean
  /** the chat's first user message: a default session title becomes it */
  onTitle?(sessionId: Id, text: string): void
  /** ~/.claude (CLAUDE_CONFIG_DIR aware) */
  claudeDir(): string
  spawnChild?: ChildSpawn
  log?: { warn(m: string, meta?: Record<string, unknown>): void; info?(m: string, meta?: Record<string, unknown>): void }
  idleMs?: number
}

interface IndexRow {
  mode: ChatMode
  conv: string | null
  cwd: string
  at: string
}

export function resolveChatMode(pref: OpenChatsAs, host: Pick<PtyHostInfo, 'codeWork'>): ChatMode {
  if (pref === 'chat' || pref === 'terminal') return pref
  return host.codeWork ? 'terminal' : 'chat'
}

/** Deep-redacts every string in a value (ops, snapshots). */
export function redactDeep<T>(v: T, redact: (s: string) => string): T {
  if (typeof v === 'string') return redact(v) as unknown as T
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, redact)) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x, redact)
    return out as T
  }
  return v
}

export class ChatHub {
  private sessions = new Map<Id, ChatLike>()
  private seq = new Map<Id, number>()
  private pending = new Map<Id, ChatOp[]>()
  private timers = new Map<Id, NodeJS.Timeout>()
  private index: Record<Id, IndexRow> = {}
  private indexPath: string

  constructor(private d: ChatHubDeps) {
    this.indexPath = path.join(d.userData, 'chats', 'index.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown
      if (raw && typeof raw === 'object') this.index = raw as Record<Id, IndexRow>
    } catch {
      this.index = {}
    }
  }

  /** CHAT-UI.md §3.7: Claude chats need a verified CLI; anything else stays a terminal. */
  supported(): boolean {
    return versionAtLeast(this.d.claudeVersion())
  }
  /** AGENT CHAT: Codex chats (asked for explicitly: agent chats) need codex app-server. */
  codexSupported(): boolean {
    return versionAtLeast(this.d.codexVersion?.() ?? null, CODEX_CHAT_MIN_VERSION)
  }

  private saveIndex(): void {
    try {
      // keep the newest 2000 rows
      const rows = Object.entries(this.index).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 2000)
      this.index = Object.fromEntries(rows)
      fs.mkdirSync(path.dirname(this.indexPath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index), { mode: 0o600 })
    } catch (e) {
      this.d.log?.warn('chat: could not save index', { error: String(e) })
    }
  }
  private remember(id: Id, row: Partial<IndexRow>): void {
    const cur = this.index[id]
    this.index[id] = { mode: row.mode ?? cur?.mode ?? 'terminal', conv: row.conv !== undefined ? row.conv : (cur?.conv ?? null), cwd: row.cwd ?? cur?.cwd ?? '', at: new Date().toISOString() }
    this.saveIndex()
  }
  /** The last mode used for a conversation (Restart resumes it as it was). */
  private modeOfConversation(conv: string): ChatMode | null {
    let best: IndexRow | null = null
    for (const r of Object.values(this.index)) if (r.conv === conv && (!best || r.at > best.at)) best = r
    return best?.mode ?? null
  }

  /**
   * SessionManager's spawner. Claude panes become a ChatSession (chat or terminal inside); everything else is the
   * plain node-pty, untouched.
   */
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }, host: PtyHostInfo | undefined, spawnPty: PtySpawn): PtyLike {
    if (host?.adapter === 'codex' && host.mode === 'chat' && this.codexSupported()) return this.spawnCodex(file, args, opts, host)
    if (!host || host.adapter !== 'claude' || !this.supported()) return spawnPty(file, args, opts)
    const id = host.sessionId
    const mode = host.mode ?? (host.resumeId ? this.modeOfConversation(host.resumeId) : null) ?? resolveChatMode(this.d.openChatsAs(), host)
    const s = new ChatSession({
      sessionId: id,
      file,
      interactiveArgs: args,
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.cols,
      rows: opts.rows,
      mode,
      spawnPty,
      spawnChild: this.d.spawnChild ?? defaultChildSpawn,
      killGroup: this.d.killGroup,
      registerPid: (pid) => this.d.registerPid?.(id, pid),
      emit: (ops) => this.queueOps(id, ops),
      asks: {
        open: (e) => this.d.asks?.(id)?.open(e),
        close: (rid, summary) => this.d.asks?.(id)?.close(rid, summary),
        stopped: () => this.d.asks?.(id)?.stopped?.(),
        working: () => this.d.asks?.(id)?.working?.(),
        turnEnded: (report) => this.d.asks?.(id)?.turnEnded?.(report)
      },
      terminalWorking: () => this.d.terminalWorking?.(id) ?? false,
      speaker: () => this.d.speakerOf?.(id) ?? null,
      transcript: (conv) => this.transcript(conv),
      onModeChanged: (m) => this.remember(id, { mode: m }),
      onConversation: (conv) => {
        this.remember(id, { conv })
        this.d.onConversation?.(id, conv)
      },
      // the session row is stored after its pane spawns: title it on the next tick
      onTitle: (text) => void setTimeout(() => this.d.onTitle?.(id, text), 0),
      log: this.d.log,
      ...(this.d.idleMs ? { idleMs: this.d.idleMs } : {})
    })
    this.sessions.set(id, s)
    this.remember(id, { mode, conv: s.conversationId, cwd: opts.cwd })
    s.onExit(() => {
      this.flush(id)
      this.sessions.delete(id)
    })
    return s
  }

  /** AGENT CHAT: a Codex chat (codex app-server), resuming its thread when the spawn resumes one. */
  private spawnCodex(file: string, args: string[], opts: { cwd: string; env: Record<string, string> }, host: PtyHostInfo): PtyLike {
    const id = host.sessionId
    const s = new CodexChatSession({
      sessionId: id,
      file,
      interactiveArgs: args,
      cwd: opts.cwd,
      env: opts.env,
      resumeId: host.resumeId ?? null,
      speaker: () => this.d.speakerOf?.(id) ?? null,
      spawnChild: this.d.spawnChild ?? defaultChildSpawn,
      killGroup: this.d.killGroup,
      registerPid: (pid) => this.d.registerPid?.(id, pid),
      emit: (ops) => this.queueOps(id, ops),
      asks: {
        open: (e) => this.d.asks?.(id)?.open(e),
        close: (rid, summary) => this.d.asks?.(id)?.close(rid, summary),
        stopped: () => this.d.asks?.(id)?.stopped?.(),
        working: () => this.d.asks?.(id)?.working?.(),
        turnEnded: (report) => this.d.asks?.(id)?.turnEnded?.(report)
      },
      onConversation: (conv) => {
        this.remember(id, { conv })
        this.d.onConversation?.(id, conv)
      },
      onTitle: (text) => void setTimeout(() => this.d.onTitle?.(id, text), 0),
      log: this.d.log,
      ...(this.d.idleMs ? { idleMs: this.d.idleMs } : {})
    })
    this.sessions.set(id, s)
    this.remember(id, { mode: 'chat', conv: host.resumeId ?? null, cwd: opts.cwd })
    s.onExit(() => {
      this.flush(id)
      this.sessions.delete(id)
    })
    return s
  }

  get(id: Id): ChatLike | null {
    return this.sessions.get(id) ?? null
  }
  private need(id: Id): ChatLike {
    const s = this.sessions.get(id)
    if (!s) throw new HiveError('conflict', 'This chat is not running. Restart it to continue.')
    return s
  }
  /** Mode of a session, live or remembered (an exited chat still opens as a chat). */
  modeOf(id: Id): ChatMode | null {
    return this.sessions.get(id)?.mode ?? this.index[id]?.mode ?? null
  }
  /** Hook permission lines are not asks while the chat owns the conversation (the stream does). */
  ownsAsks(id: Id): boolean {
    return this.sessions.get(id)?.mode === 'chat'
  }

  private queueOps(id: Id, ops: ChatOp[]): void {
    if (!ops.length) return
    const p = this.pending.get(id) ?? []
    p.push(...ops)
    this.pending.set(id, p)
    if (!this.timers.has(id)) this.timers.set(id, setTimeout(() => this.flush(id), FLUSH_MS))
  }
  flush(id: Id): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    const ops = this.pending.get(id)
    this.pending.delete(id)
    if (!ops?.length) return
    const seq = (this.seq.get(id) ?? 0) + 1
    this.seq.set(id, seq)
    this.d.emit(id, seq, redactDeep(coalesce(ops), (s) => this.d.redact(s)))
  }

  /** chat:snapshot. Exited (or never chat) sessions are read from Claude's transcript. */
  snapshot(id: Id, session?: { agentSessionId: string | null; adapter: AdapterId; status: string } | null): ChatSnapshot {
    this.flush(id)
    const seq = this.seq.get(id) ?? 0
    const live = this.sessions.get(id)
    if (live) return redactDeep({ sessionId: id, ...live.snapshot(seq) }, (s) => this.d.redact(s))
    const row = this.index[id]
    const conv = session?.agentSessionId ?? row?.conv ?? null
    const isChat = (session?.adapter === 'claude' || session?.adapter === 'codex') && row?.mode === 'chat'
    // an ended Codex chat reads nothing here: its history comes back when the chat is opened again (thread/resume)
    const items = isChat && conv && session?.adapter === 'claude' ? replayItems(this.transcript(conv)) : []
    return redactDeep(
      {
        sessionId: id,
        mode: isChat ? 'chat' : 'terminal',
        // only a live ChatSession can switch; an ended chat just reads
        available: false,
        turn: 'ended',
        activity: null,
        turnStartedAt: null,
        items,
        queue: [],
        meta: { ...EMPTY_CHAT_META },
        seq,
        note: null
      },
      (s) => this.d.redact(s)
    )
  }

  /** CHAT-UI.md §8: a notice in a live chat; false when it is not running. */
  note(id: Id, text: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    s.principiaNote(text)
    return true
  }
  send(id: Id, text: string, images?: ChatImage[]): Promise<void> {
    return this.need(id).send(text, images ?? [])
  }
  queueEdit(id: Id, queueId: string, text: string | null): void {
    this.need(id).editQueued(queueId, text)
  }
  interrupt(id: Id, sendNow?: boolean): Promise<void> {
    return this.need(id).interrupt(!!sendNow)
  }
  answer(id: Id, requestId: string, decision: ChatDecision, via: 'chat' | 'needs' = 'chat'): string {
    return this.need(id).answer(requestId, decision, via)
  }
  setPermissionMode(id: Id, mode: string): Promise<void> {
    return this.need(id).setPermissionMode(mode)
  }
  setModel(id: Id, model: string): Promise<void> {
    return this.need(id).setModel(model)
  }
  toTerminal(id: Id, force?: boolean): Promise<void> {
    return this.need(id).toTerminal(!!force)
  }
  toChat(id: Id, force?: boolean): Promise<void> {
    return this.need(id).toChat(!!force)
  }

  /** Where Claude keeps a conversation's transcript (~/.claude/projects/<slug>/<id>.jsonl), or null. */
  transcriptFile(conv: string): string | null {
    if (!/^[A-Za-z0-9-]+$/.test(conv)) return null
    const projects = path.join(this.d.claudeDir(), 'projects')
    try {
      for (const dir of fs.readdirSync(projects)) {
        const f = path.join(projects, dir, `${conv}.jsonl`)
        if (fs.existsSync(f)) return f
      }
    } catch {
      return null
    }
    return null
  }

  /** Claude's transcript for a conversation id (read-only; ~/.claude/projects/<slug>/<id>.jsonl). */
  transcript(conv: string): unknown[] {
    const file = this.transcriptFile(conv)
    if (!file) return []
    try {
      const st = fs.statSync(file)
      const max = 24 * 1024 * 1024
      const fd = fs.openSync(file, 'r')
      try {
        const start = Math.max(0, st.size - max)
        const buf = Buffer.alloc(st.size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        const lines = buf.toString('utf8').split('\n')
        if (start > 0) lines.shift()
        const out: unknown[] = []
        for (const l of lines) {
          if (!l.trim()) continue
          try {
            out.push(JSON.parse(l))
          } catch {
            /* a partial last line while Claude writes */
          }
        }
        return out
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return []
    }
  }

  /** @ mentions: tracked files (git), else a shallow walk; fuzzy-ish contains match, max 50. */
  async files(cwd: string, query: string): Promise<string[]> {
    const all = await listFiles(cwd)
    const q = query.toLowerCase()
    const hits = q ? all.filter((f) => f.toLowerCase().includes(q)) : all
    return hits.sort((a, b) => score(a, q) - score(b, q)).slice(0, 50)
  }
}

function score(f: string, q: string): number {
  const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
  return (base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 1000 + f.length
}

const fileCache = new Map<string, { at: number; files: string[] }>()
function listFiles(cwd: string): Promise<string[]> {
  const hit = fileCache.get(cwd)
  if (hit && Date.now() - hit.at < 15_000) return Promise.resolve(hit.files)
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 4000 }, (err, stdout) => {
      let files: string[]
      if (!err && stdout) files = stdout.split('\n').filter(Boolean).slice(0, 5000)
      else files = walk(cwd, 5000)
      fileCache.set(cwd, { at: Date.now(), files })
      resolve(files)
    })
  })
}
function walk(root: string, cap: number): string[] {
  const out: string[] = []
  const stack: [string, number][] = [['', 0]]
  while (stack.length && out.length < cap) {
    const [rel, depth] = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth < 4) stack.push([r, depth + 1])
      } else out.push(r)
      if (out.length >= cap) break
    }
  }
  return out
}

/** Merges consecutive appends to the same field (token streaming) into one op. */
export function coalesce(ops: ChatOp[]): ChatOp[] {
  const out: ChatOp[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (op.op === 'append' && last?.op === 'append' && last.id === op.id && last.field === op.field) {
      out[out.length - 1] = { ...last, text: last.text + op.text }
    } else out.push(op)
  }
  return out
}
