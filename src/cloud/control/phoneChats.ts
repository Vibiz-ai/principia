/**
 * Chats the cloud owns (docs/CLOUD-PHONE.md): the phone talks to this machine directly, with no Mac in between, so
 * the chat itself (src/main/chat/chatSession.ts, the same one the Mac runs) lives here. Its `claude -p` process is
 * the runtime's (src/cloud/agent/chats.ts: the clone, the sign-in, the agent user); this side keeps the chat model
 * (items, turn, asks) and hands its numbered ops to whoever follows the chat.
 *
 * A chat's id is its conversation id. Its row (title, repository, last line) is kept in control.db, so the list
 * survives a restart and an ended chat opens from Claude's own transcript; a message to an ended chat resumes it.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChatDecision, ChatImage, ChatOp, ChatSnapshot } from '../../shared/chat'
import { EMPTY_CHAT_META } from '../../shared/chat'
import { ChatSession, replayItems } from '../../main/chat/chatSession'
import type { ChildLike, ChildSpawn } from '../../main/chat/streamProc'
import type { ChatProcInfo, ChatProcSpec, CloudChats, ProviderMaterial } from '../contract'

/** what a chat in the cloud is told about where it runs (it has none of the Mac's tools) */
export const CLOUD_CHAT_PROMPT = [
  'You are running on the user\'s own cloud machine (Linux), started from their phone. Nothing runs on their Mac.',
  'GitHub is signed in: git push and the gh CLI work. The repository, when there is one, is cloned in the current folder.',
  'You can install packages and run servers here. The user reads your answers on a phone: keep them short, and say what you changed.',
  'When you finish a change, commit it to a new branch, push it, and open a pull request with gh unless the user asked otherwise.'
].join('\n')

const FLUSH_MS = 16
/** owner/name as GitHub allows them: no dot-only names (never a path) */
const GITHUB_REPO = /^(?!\.{1,2}\/)[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/
export const CLOUD_CHAT_MODES = ['auto', 'acceptEdits', 'default', 'plan'] as const
export type CloudChatMode = (typeof CLOUD_CHAT_MODES)[number]

export interface PhoneChatRecord {
  id: string
  title: string
  /** owner/name on GitHub, or null: an empty folder */
  repo: string | null
  branch: string | null
  mode: CloudChatMode
  createdAt: string
  updatedAt: string
  /** what was said last (a preview for the list) */
  lastLine: string | null
  /** the conversation exists on this machine (a message resumes it) */
  started: boolean
}

export interface PhoneChatRow extends PhoneChatRecord {
  live: boolean
  /** working / needs / idle / starting / ended… */
  turn: string
  activity: string | null
}

interface Store {
  all(): PhoneChatRecord[]
  get(id: string): PhoneChatRecord | null
  put(r: PhoneChatRecord): void
  remove(id: string): void
}

export interface PhoneChatsDeps {
  chats: CloudChats
  store: Store
  /** the Claude sign-in, the GitHub token and the shared keys, read at each start (never from a request) */
  material(): { provider: ProviderMaterial | null; githubToken: string | null; secrets: Record<string, string> }
  redact(s: string): string
  /** numbered ops of one chat, for the sockets that follow it */
  emit(id: string, seq: number, ops: ChatOp[]): void
  /** the list changed (a new chat, a turn that started or ended, a title) */
  changed(): void
  paused(): boolean
  log: { info(m: string, d?: Record<string, unknown>): void; warn(m: string, d?: Record<string, unknown>): void }
  now?: () => Date
  /** tests */
  idleMs?: number
}

class Pipe extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

/**
 * A ChildLike whose process is the runtime's chat process on this machine: the chat can't tell it from a local
 * `claude -p`. stdin goes to runtime.chats.write, stdout comes from its attach.
 */
export class RuntimeChild extends EventEmitter implements ChildLike {
  readonly pid = 0
  readonly stdout = new Pipe()
  readonly stderr = new Pipe()
  readonly stdin: NonNullable<ChildLike['stdin']>
  private detach: (() => void) | null = null
  private exited = false
  private statusCb: ((t: string) => void) | null = null
  private started = false
  private killed: NodeJS.Signals | null = null
  /** stdin written before the process exists (the chat's initialize goes out at once): sent once it does */
  private queue: string[] = []
  private ending = false

  constructor(
    private chats: CloudChats,
    private spec: ChatProcSpec,
    private log: PhoneChatsDeps['log']
  ) {
    super()
    this.stdin = {
      write: (d: string) => {
        if (this.exited) return false
        if (!this.started) {
          this.queue.push(d)
          return true
        }
        return this.chats.write(this.spec.id, d)
      },
      end: () => {
        if (this.started) this.chats.end(this.spec.id)
        else this.ending = true
      },
      on: () => this.stdin
    }
    void Promise.resolve().then(() => this.begin())
  }

  onStatus(cb: (text: string) => void): void {
    this.statusCb = cb
  }

  private async begin(): Promise<void> {
    try {
      const info = await this.chats.start(this.spec)
      this.started = true
      this.onState(info)
      this.detach = this.chats.attach(this.spec.id, 0, {
        out: (d) => this.stdout.emit('data', d),
        err: (d) => this.stderr.emit('data', d),
        state: (i) => this.onState(i)
      })
      if (!this.detach) return this.finish(1, null, 'The chat could not start.')
      // it ended while attaching (a failed start): don't stay subscribed to it
      if (this.exited) {
        this.detach()
        this.detach = null
        return
      }
      if (this.killed) return void this.chats.signal(this.spec.id, this.killed)
      for (const d of this.queue.splice(0)) this.chats.write(this.spec.id, d)
      if (this.ending) this.chats.end(this.spec.id)
    } catch (e) {
      this.finish(1, null, e instanceof Error ? e.message : String(e))
    }
  }

  private onState(i: ChatProcInfo): void {
    if (i.state === 'preparing' && i.detail) this.statusCb?.(i.detail)
    if (i.state === 'exited') this.finish(i.exitCode, (i.signal as NodeJS.Signals | null) ?? null, i.error)
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    if (this.exited) return
    this.exited = true
    if (error) this.stderr.emit('data', `${error}\n`)
    this.detach?.()
    this.detach = null
    // the chat reads stdout to the end before it hears the exit (the runtime sends output before 'exited')
    setImmediate(() => this.emit('exit', code, signal))
  }

  kill(signal?: NodeJS.Signals): boolean {
    const sig = signal ?? 'SIGTERM'
    if (this.exited) return false
    if (!this.started) {
      this.killed = sig
      return true
    }
    if (!this.chats.signal(this.spec.id, sig)) this.log.warn('cloud phone chat: signal not delivered', { id: this.spec.id })
    return true
  }
}

export function dbStore(db: { all<T>(sql: string, ...p: (string | number | null)[]): T[]; get<T>(sql: string, ...p: (string | number | null)[]): T | undefined; run(sql: string, ...p: (string | number | null)[]): number }): Store {
  interface Row { id: string; title: string; repo: string | null; branch: string | null; mode: string; created_at: string; updated_at: string; last_line: string | null; started: number }
  const of = (r: Row): PhoneChatRecord => ({ id: r.id, title: r.title, repo: r.repo, branch: r.branch, mode: (CLOUD_CHAT_MODES as readonly string[]).includes(r.mode) ? (r.mode as CloudChatMode) : 'auto', createdAt: r.created_at, updatedAt: r.updated_at, lastLine: r.last_line, started: !!r.started })
  return {
    all: () => db.all<Row>('SELECT * FROM phone_chats ORDER BY updated_at DESC LIMIT 500').map(of),
    get: (id) => {
      const r = db.get<Row>('SELECT * FROM phone_chats WHERE id = ?', id)
      return r ? of(r) : null
    },
    put: (r) =>
      void db.run(
        'INSERT INTO phone_chats (id, title, repo, branch, mode, created_at, updated_at, last_line, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, repo = excluded.repo, branch = excluded.branch, mode = excluded.mode, updated_at = excluded.updated_at, last_line = excluded.last_line, started = excluded.started',
        r.id, r.title, r.repo, r.branch, r.mode, r.createdAt, r.updatedAt, r.lastLine, r.started ? 1 : 0
      ),
    remove: (id) => void db.run('DELETE FROM phone_chats WHERE id = ?', id)
  }
}

/** "Fix the login page on mobile" from the first message: one line, at most 80 characters. */
export function titleOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return 'New chat'
  return line.length > 80 ? `${line.slice(0, 79).replace(/\s+\S*$/, '')}…` : line
}

/** working on something (or about to): the machine stays awake for it */
const busy = (t: string): boolean => t === 'starting' || t === 'working' || t === 'needs'

function redactDeep<T>(v: T, redact: (s: string) => string): T {
  if (typeof v === 'string') return redact(v) as unknown as T
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, redact)) as unknown as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x, redact)
    return out as T
  }
  return v
}

export class PhoneChats {
  private sessions = new Map<string, ChatSession>()
  private seq = new Map<string, number>()
  private pending = new Map<string, ChatOp[]>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private d: PhoneChatsDeps) {}

  private now(): string {
    return (this.d.now?.() ?? new Date()).toISOString()
  }

  list(): PhoneChatRow[] {
    return this.d.store.all().map((r) => {
      const s = this.sessions.get(r.id)
      return { ...r, live: !!s && busy(s.turn), turn: s?.turn ?? 'ended', activity: s?.activity ?? null }
    })
  }

  get(id: string): PhoneChatRecord | null {
    return this.d.store.get(id)
  }

  /** chats with a live process or one starting (keeps a managed machine awake through the runtime's own count) */
  live(): number {
    return [...this.sessions.values()].filter((s) => busy(s.turn)).length
  }

  /** New chat: its row, its chat, and the first message. */
  async create(o: { text: string; images?: ChatImage[]; repo?: string | null; branch?: string | null; mode?: string | null }): Promise<PhoneChatRecord> {
    if (this.d.paused()) throw Object.assign(new Error('Your cloud is paused. Resume it on the Cloud page to run chats there.'), { status: 409 })
    const repo = o.repo ? o.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '') : null
    if (repo && !GITHUB_REPO.test(repo)) throw Object.assign(new Error('Pick a repository as owner/name.'), { status: 400 })
    const branch = o.branch ? o.branch.trim() : null
    if (branch && !BRANCH.test(branch)) throw Object.assign(new Error('That branch name is not valid.'), { status: 400 })
    const mode = (CLOUD_CHAT_MODES as readonly string[]).includes(o.mode ?? '') ? (o.mode as CloudChatMode) : 'auto'
    if (!this.d.material().provider) throw Object.assign(new Error('Claude is not signed in on your cloud. On your Mac, open Cloud and sign Claude in once.'), { status: 409 })
    const at = this.now()
    const r: PhoneChatRecord = { id: randomUUID(), title: titleOf(o.text), repo, branch, mode, createdAt: at, updatedAt: at, lastLine: null, started: false }
    this.d.store.put(r)
    this.open(r)
    await this.send(r.id, o.text, o.images)
    this.d.changed()
    return r
  }

  /** The live chat, started (or resumed) when it isn't running. */
  private open(r: PhoneChatRecord): ChatSession {
    const cur = this.sessions.get(r.id)
    if (cur && cur.turn !== 'ended') return cur
    const id = r.id
    const args = [r.started ? '--resume' : '--session-id', id, '--permission-mode', r.mode === 'auto' ? 'auto' : r.mode, '--append-system-prompt', CLOUD_CHAT_PROMPT]
    const spawnChild: ChildSpawn = (_file, argv) => {
      const m = this.d.material()
      const val = (flag: string): string | null => {
        const i = argv.indexOf(flag)
        return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null
      }
      const resume = argv.includes('--resume')
      const spec: ChatProcSpec = {
        id,
        conversationId: id,
        resume,
        model: val('--model'),
        permissionMode: val('--permission-mode'),
        bypass: argv.includes('--dangerously-skip-permissions'),
        systemPrompt: val('--append-system-prompt'),
        repo: r.repo ? { id: 'chat', name: r.repo.split('/')[1]!, url: `https://github.com/${r.repo}`, branch: r.branch, token: m.githubToken } : null,
        provider: m.provider,
        secrets: m.secrets,
        githubToken: m.githubToken
      }
      return new RuntimeChild(this.d.chats, spec, this.d.log)
    }
    const s = new ChatSession({
      sessionId: id,
      file: 'claude',
      interactiveArgs: args,
      cwd: '/',
      env: {},
      cols: 80,
      rows: 24,
      mode: 'chat',
      spawnPty: () => {
        throw new Error('There is no terminal for a cloud chat.')
      },
      spawnChild,
      killGroup: () => false,
      cloud: true,
      emit: (ops) => this.queueOps(id, ops),
      asks: {
        open: () => this.d.changed(),
        close: () => this.d.changed(),
        working: () => this.d.changed(),
        turnEnded: (report) => {
          const row = this.d.store.get(id)
          if (row) this.d.store.put({ ...row, updatedAt: this.now(), lastLine: report ? this.d.redact(report).replace(/\s+/g, ' ').slice(0, 200) : row.lastLine })
          this.d.changed()
        }
      },
      transcript: () => this.records(id),
      onConversation: () => {
        const row = this.d.store.get(id)
        if (row && !row.started) this.d.store.put({ ...row, started: true })
      },
      log: this.d.log,
      ...(this.d.idleMs ? { idleMs: this.d.idleMs } : {})
    })
    this.sessions.set(id, s)
    s.onExit(() => {
      this.flush(id)
      if (this.sessions.get(id) === s) this.sessions.delete(id)
      this.d.changed()
    })
    return s
  }

  /** Claude's transcript records of this chat (replayed into an ended chat's view). */
  private records(id: string): unknown[] {
    const text = this.d.chats.transcript(id)
    if (!text) return []
    const out: unknown[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* a torn last line */
      }
    }
    return out
  }

  private must(id: string): PhoneChatRecord {
    const r = this.d.store.get(id)
    if (!r) throw Object.assign(new Error('That chat is not on your cloud.'), { status: 404 })
    return r
  }

  snapshot(id: string): ChatSnapshot {
    const r = this.must(id)
    this.flush(id)
    const seq = this.seq.get(id) ?? 0
    const live = this.sessions.get(id)
    const redact = <T>(v: T): T => redactDeep(v, this.d.redact)
    if (live) return redact({ sessionId: id, ...live.snapshot(seq) })
    // ended: read from the transcript, and say a message continues it
    return redact({
      sessionId: id,
      mode: 'chat',
      // the phone's composer sends to it: a message resumes the conversation
      available: true,
      turn: 'ended',
      activity: null,
      turnStartedAt: null,
      items: r.started ? replayItems(this.records(id)) : [],
      queue: [],
      meta: { ...EMPTY_CHAT_META },
      seq,
      note: null
    } satisfies ChatSnapshot)
  }

  async send(id: string, text: string, images?: ChatImage[]): Promise<void> {
    const r = this.must(id)
    if (this.d.paused()) throw Object.assign(new Error('Your cloud is paused.'), { status: 409 })
    const s = this.open(r)
    this.d.store.put({ ...r, updatedAt: this.now(), lastLine: text.replace(/\s+/g, ' ').slice(0, 200) })
    await s.send(text, images ?? [])
  }

  async interrupt(id: string, sendNow?: boolean): Promise<void> {
    this.must(id)
    const s = this.sessions.get(id)
    if (s) await s.interrupt(sendNow)
  }

  answer(id: string, requestId: string, decision: ChatDecision): string {
    this.must(id)
    const s = this.sessions.get(id)
    if (!s) throw Object.assign(new Error('Already answered'), { status: 409 })
    return s.answer(requestId, decision, 'chat')
  }

  /** open permission / question / plan cards of every live chat */
  asks(): { chat: PhoneChatRecord; item: Extract<ChatSnapshot['items'][number], { requestId: string }> }[] {
    const out: { chat: PhoneChatRecord; item: Extract<ChatSnapshot['items'][number], { requestId: string }> }[] = []
    for (const [id, s] of this.sessions) {
      const chat = this.d.store.get(id)
      if (!chat) continue
      for (const it of s.items) if ((it.kind === 'permission' || it.kind === 'question' || it.kind === 'plan') && it.state === 'open') out.push({ chat, item: it })
    }
    return out
  }

  async remove(id: string): Promise<void> {
    this.must(id)
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    s?.kill('SIGTERM')
    await this.d.chats.remove(id)
    this.d.store.remove(id)
    this.seq.delete(id)
    this.d.changed()
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) s.kill('SIGTERM')
    this.sessions.clear()
  }

  private queueOps(id: string, ops: ChatOp[]): void {
    if (!ops.length) return
    const p = this.pending.get(id) ?? []
    p.push(...ops)
    this.pending.set(id, p)
    if (!this.timers.has(id)) this.timers.set(id, setTimeout(() => this.flush(id), FLUSH_MS))
    if (ops.some((o) => o.op === 'state')) this.d.changed()
  }

  private flush(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
    const ops = this.pending.get(id)
    this.pending.delete(id)
    if (!ops?.length) return
    const seq = (this.seq.get(id) ?? 0) + 1
    this.seq.set(id, seq)
    this.d.emit(id, seq, redactDeep(ops, this.d.redact))
  }
}
