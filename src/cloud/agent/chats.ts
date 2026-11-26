/**
 * Cloud chats (docs/CLOUD-CHATS.md): the Mac's chat (src/main/chat/chatSession.ts) runs its `claude -p` stream-json
 * process here instead of on the Mac. This owns those processes: it prepares the chat's folder (a clone of the
 * project's GitHub repository) and its home (the Claude sign-in, the conversation's history), starts the CLI as the
 * agent user, and keeps every character of its output with a running offset, so a Mac that comes back (a dropped
 * connection, a laptop that slept) asks for "everything after N" and loses nothing.
 *
 * The home stays between processes of the same chat (that is where Claude keeps the conversation, for --resume); the
 * process itself ends when the Mac stops it, when the chat is deleted, or when nobody is attached and nothing happened
 * for IDLE_MS (so a forgotten chat never keeps a managed machine awake).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatProcInfo, ChatProcSpec, ChatSink, ChatWorkspace, RepoMaterial } from '../contract'

export type { ChatProcInfo, ChatProcSpec, ChatSink }
import { materializeProviders } from './providers/materialize'
import { repoFolderName, runAskpass } from './repos'
import { assertSafeId, type ProcessSandbox } from './sandbox'

export interface ChatProcsDeps {
  sandbox: ProcessSandbox
  bin: string
  git: string
  codexBin: string
  /** clones or updates the repository into `companyDir(companyId)/<name>` (runtime.syncRepo) */
  syncRepo(companyId: string, repo: RepoMaterial): Promise<{ ok: boolean; detail: string | null }>
  redact(s: string): string
  addSecret(s: string): void
  log: { info(m: string, d?: Record<string, unknown>): void; warn(m: string, d?: Record<string, unknown>): void }
  now?: () => Date
  /** tests: a smaller window and limits */
  idleMs?: number
  keepChars?: number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
}

/** Output kept for an attach to replay: the newest 8 M characters. */
export const KEEP_CHARS = 8 * 1024 * 1024
/** Nobody attached and no output for this long: the process is stopped (its home stays, the chat resumes later). */
export const IDLE_MS = 20 * 60_000
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto'])

/** The chat's argv, built here from plain choices: never a path or a flag from the Mac. */
export function chatArgv(s: Pick<ChatProcSpec, 'conversationId' | 'resume' | 'model' | 'permissionMode' | 'bypass' | 'systemPrompt'>): string[] {
  const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages']
  a.push(s.resume ? '--resume' : '--session-id', s.conversationId)
  if (s.model && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/.test(s.model) && s.model !== 'default') a.push('--model', s.model)
  if (s.bypass) a.push('--dangerously-skip-permissions')
  else {
    a.push('--permission-mode', s.permissionMode && MODES.has(s.permissionMode) ? s.permissionMode : 'default')
    // permission prompts come back over stdin/stdout to the Mac, which shows them in the chat and on the phone
    a.push('--permission-prompt-tool', 'stdio')
  }
  if (s.systemPrompt) a.push('--append-system-prompt', s.systemPrompt.slice(0, 64 * 1024))
  return a
}

interface Proc {
  info: ChatProcInfo
  child: ChildProcess | null
  /** kept output: buf[0] is offset `base` */
  buf: string
  base: number
  sinks: Set<ChatSink>
  /** stdin written before the process runs */
  pending: string[]
  ended: boolean
  lastAt: number
  idle: NodeJS.Timeout | null
}

export class ChatProcs {
  private procs = new Map<string, Proc>()
  constructor(private d: ChatProcsDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date()
  }

  list(): ChatProcInfo[] {
    return [...this.procs.values()].map((p) => ({ ...p.info }))
  }

  get(id: string): ChatProcInfo | null {
    const p = this.procs.get(id)
    return p ? { ...p.info } : null
  }

  /** Claude's transcript of this chat's conversation (the newest 24 MB), or null. */
  transcript(id: string): string | null {
    assertSafeId('chat', id)
    const claudeDir = join(this.d.sandbox.runDir(`chat_${id}`.slice(0, 96)), 'home', '.claude')
    try {
      const root = join(claudeDir, 'projects')
      for (const d of readdirSync(root)) {
        const f = join(root, d, `${id}.jsonl`)
        if (!existsSync(f)) continue
        const text = readFileSync(f, 'utf8')
        const max = 24 * 1024 * 1024
        return text.length > max ? text.slice(text.indexOf('\n', text.length - max) + 1) : text
      }
    } catch {
      return null
    }
    return null
  }

  /**
   * docs/CLOUD-PHONE.md: the chat's folder, and the environment its processes get (the phone's files and terminal):
   * the same HOME, CLI homes and git askpass the chat has, the workspace keys, never Claude's sign-in.
   */
  workspace(id: string, keys: { secrets: Record<string, string>; githubToken: string | null } = { secrets: {}, githubToken: null }): ChatWorkspace | null {
    assertSafeId('chat', id)
    const { sandbox } = this.d
    const companyId = `chat_${id}`.slice(0, 96)
    if (!existsSync(join(sandbox.workspaceDir, companyId))) return null
    const root = sandbox.companyDir(companyId)
    let cwd = root
    try {
      const repo = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory() && existsSync(join(root, e.name, '.git')))
      if (repo) cwd = join(root, repo.name)
    } catch {
      /* an empty folder */
    }
    const box = sandbox.prepare(companyId)
    if (keys.githubToken) this.d.addSecret(keys.githubToken)
    const overlay = sandbox.runEnv(box, {}, keys.secrets)
    Object.assign(overlay, runAskpass(box.home, keys.githubToken && cwd !== root ? [{ dir: cwd, token: keys.githubToken }] : [], keys.githubToken))
    sandbox.handOver(box)
    return { root, cwd, env: { ...sandbox.baseEnv(), ...overlay }, user: sandbox.spawnUser() }
  }

  /** preparing or running: keeps a managed machine awake (activity.ts) */
  live(): number {
    return [...this.procs.values()].filter((p) => p.info.state !== 'exited').length
  }

  /** Starts the chat's process (stopping an older one of the same chat first). Returns at once; attach to follow it. */
  async start(spec: ChatProcSpec): Promise<ChatProcInfo> {
    assertSafeId('chat', spec.id)
    if (!/^[0-9a-f-]{8,64}$/i.test(spec.conversationId)) throw new Error('Invalid conversation id')
    for (const v of [spec.provider?.value, spec.repo?.token, spec.githubToken, ...Object.values(spec.secrets)]) if (v) this.d.addSecret(v)
    const old = this.procs.get(spec.id)
    if (old) await this.stop(spec.id)
    const p: Proc = {
      info: { id: spec.id, state: 'preparing', detail: 'Getting ready…', startedAt: this.now().toISOString(), endedAt: null, exitCode: null, signal: null, error: null, repo: spec.repo ? ownerName(spec.repo.url) : null, out: 0 },
      child: null,
      buf: '',
      base: 0,
      sinks: old?.sinks ?? new Set(),
      pending: [],
      ended: false,
      lastAt: Date.now(),
      idle: null
    }
    this.procs.set(spec.id, p)
    this.emitState(p)
    void this.launch(p, spec).catch((e) => this.fail(p, e instanceof Error ? e.message : String(e)))
    return { ...p.info }
  }

  private async launch(p: Proc, spec: ChatProcSpec): Promise<void> {
    const { sandbox } = this.d
    const companyId = `chat_${spec.id}`.slice(0, 96)
    let cwd = sandbox.companyDir(companyId)
    if (spec.repo) {
      const dir = join(cwd, repoFolderName(spec.repo))
      // cloned once: later processes of this chat keep its folder as the chat left it (its own commits, a branch
      // that went another way than GitHub's); git fetch and merge are Claude's to do there
      if (!existsSync(join(dir, '.git'))) {
        this.setDetail(p, `Getting ${p.info.repo ?? 'the repository'} from GitHub…`)
        const r = await this.d.syncRepo(companyId, spec.repo)
        if (!r.ok) throw new Error(`The repository could not be cloned: ${r.detail ?? 'unknown error'}`)
        if (!existsSync(dir)) throw new Error('The repository folder is missing after the clone')
      }
      cwd = dir
    }
    // stopped while the repository was cloning: it never starts
    if (this.procs.get(spec.id) !== p || p.ended) return
    this.setDetail(p, 'Signing in…')
    const box = sandbox.prepare(`chat_${spec.id}`.slice(0, 96))
    const mat = materializeProviders(box, spec.provider ? [spec.provider] : [], ['claude'], { codex: this.d.codexBin })
    if (mat.missing.length) throw new Error('Claude is not signed in on your cloud. Connect it on the Cloud page.')
    const overlay = sandbox.runEnv(box, mat.env, spec.secrets)
    Object.assign(overlay, runAskpass(box.home, spec.repo?.token ? [{ dir: cwd, token: spec.repo.token }] : [], spec.githubToken))
    const env = { ...sandbox.baseEnv(), ...overlay }
    await mat.before(env)
    sandbox.handOver(box)
    if (this.procs.get(spec.id) !== p || p.ended) return
    // the conversation's history decides, not the Mac: it resumes what this machine has, and starts what it hasn't
    const resume = hasTranscript(box.claudeDir, spec.conversationId)
    const user = sandbox.spawnUser()
    const child = spawn(this.d.bin, chatArgv({ ...spec, resume }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...(user ? { uid: user.uid, gid: user.gid } : {}) })
    p.child = child
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (d: string) => this.onOut(p, d))
    child.stderr!.on('data', (d: string) => {
      const t = this.d.redact(d)
      for (const s of p.sinks) s.err(t)
    })
    child.stdin!.on('error', () => undefined)
    child.on('error', (e) => this.fail(p, e.message))
    // 'close', not 'exit': every byte of stdout is in before the chat says it ended
    child.on('close', (code, signal) => this.ended(p, code, signal))
    p.info.state = 'running'
    p.info.detail = null
    this.d.log.info('cloud chat: started', { id: spec.id, repo: p.info.repo })
    this.emitState(p)
    for (const w of p.pending.splice(0)) child.stdin!.write(w)
    this.touch(p)
  }

  private setDetail(p: Proc, detail: string): void {
    p.info.detail = detail
    this.emitState(p)
  }

  private onOut(p: Proc, d: string): void {
    const at = p.info.out
    p.buf += d
    p.info.out += d.length
    const keep = this.d.keepChars ?? KEEP_CHARS
    if (p.buf.length > keep) {
      const drop = p.buf.length - keep
      p.buf = p.buf.slice(drop)
      p.base += drop
    }
    for (const s of p.sinks) s.out(d, at)
    this.touch(p)
  }

  private fail(p: Proc, message: string): void {
    if (p.ended) return
    p.info.error = this.d.redact(message).slice(0, 2000)
    this.d.log.warn('cloud chat: failed', { id: p.info.id, error: p.info.error })
    if (p.child && p.child.exitCode === null) this.signal(p.info.id, 'SIGTERM')
    else this.ended(p, null, null)
  }

  private ended(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (p.ended) return
    p.ended = true
    if (p.idle) clearTimeout(p.idle)
    p.info.state = 'exited'
    p.info.detail = null
    p.info.exitCode = code
    p.info.signal = signal
    p.info.endedAt = this.now().toISOString()
    this.emitState(p)
  }

  private emitState(p: Proc): void {
    for (const s of p.sinks) s.state({ ...p.info })
  }

  /** nobody attached and nothing happened for IDLE_MS: stop it (the next message resumes the conversation) */
  private touch(p: Proc): void {
    p.lastAt = Date.now()
    if (p.idle) clearTimeout(p.idle)
    const ms = this.d.idleMs ?? IDLE_MS
    const set = this.d.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t))
    p.idle = set(() => {
      if (p.ended) return
      if (p.sinks.size) return this.touch(p)
      this.d.log.info('cloud chat: idle, stopping', { id: p.info.id })
      this.signal(p.info.id, 'SIGTERM')
    }, ms)
    p.idle.unref?.()
  }

  /**
   * Follows a chat: replays the output after `from` (from the oldest kept character when `from` is older), then live
   * output and state. Returns the detach function, or null for an unknown chat.
   */
  attach(id: string, from: number, sink: ChatSink): (() => void) | null {
    const p = this.procs.get(id)
    if (!p) return null
    // the output first: a chat that ended while the Mac was away still delivers its answer before "exited"
    const start = Math.max(from, p.base)
    if (start < p.info.out) sink.out(p.buf.slice(start - p.base), start)
    sink.state({ ...p.info })
    p.sinks.add(sink)
    this.touch(p)
    return () => {
      p.sinks.delete(sink)
      this.touch(p)
    }
  }

  /** Text for the process's stdin (queued while it prepares). False when it ended. */
  write(id: string, data: string): boolean {
    const p = this.procs.get(id)
    if (!p || p.ended) return false
    this.touch(p)
    if (!p.child) {
      p.pending.push(data)
      return true
    }
    return p.child.stdin!.write(data) || true
  }

  /** Closes stdin (the CLI ends after its turn). */
  end(id: string): void {
    const p = this.procs.get(id)
    if (p?.child && !p.ended) p.child.stdin!.end()
  }

  /** Signals the process group (the CLI and its MCP children). */
  signal(id: string, sig: NodeJS.Signals): boolean {
    const p = this.procs.get(id)
    if (!p || p.ended) return false
    if (!p.child?.pid) {
      // still preparing: it never starts
      this.ended(p, null, sig)
      return true
    }
    try {
      process.kill(-p.child.pid, sig)
    } catch {
      try {
        p.child.kill(sig)
      } catch {
        return false
      }
    }
    return true
  }

  /** Stops it and waits (up to 5 s, then SIGKILL) until it ended. Its home and folder stay. */
  async stop(id: string): Promise<void> {
    const p = this.procs.get(id)
    if (!p || p.ended) return
    this.signal(id, 'SIGTERM')
    const until = Date.now() + 5000
    while (!p.ended && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    if (!p.ended) this.signal(id, 'SIGKILL')
    while (!p.ended && Date.now() < until + 2000) await new Promise((r) => setTimeout(r, 50))
    if (!p.ended) this.ended(p, null, 'SIGKILL')
  }

  /** The chat was deleted on the Mac: stop it and remove its home and folder. */
  async remove(id: string): Promise<void> {
    assertSafeId('chat', id)
    await this.stop(id)
    this.procs.delete(id)
    const { sandbox } = this.d
    try {
      sandbox.removeCompanyDir(`chat_${id}`.slice(0, 96))
    } catch (e) {
      this.d.log.warn('cloud chat: folder not removed', { id, error: (e as Error).message })
    }
    sandbox.cleanup(sandbox.prepare(`chat_${id}`.slice(0, 96)))
  }

  async close(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)))
  }
}

/** Claude keeps a conversation as `<CLAUDE_CONFIG_DIR>/projects/<folder>/<id>.jsonl`. */
export function hasTranscript(claudeDir: string, conversationId: string): boolean {
  try {
    const root = join(claudeDir, 'projects')
    return readdirSync(root).some((d) => existsSync(join(root, d, `${conversationId}.jsonl`)))
  } catch {
    return false
  }
}

function ownerName(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}
