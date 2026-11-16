/**
 * Cloud chats on the Mac (docs/CLOUD-CHATS.md): a ChildLike whose process runs on the person's cloud. The chat
 * (ChatSession + StreamProc) can't tell it from a local `claude -p`: stdin goes up the attach socket, stdout comes down
 * it. The Mac counts what it has received, so a dropped socket (Wi-Fi, a sleeping laptop, a cloud that restarted
 * its proxy) reconnects and gets exactly the rest. The process keeps running in the cloud while the Mac is away.
 *
 * The argv the chat built is not sent: only the choices in it (the conversation, model, permission mode, bypass, the
 * system prompt). The cloud builds its own argv, so no Mac path or flag reaches it. The project folder becomes its
 * GitHub repository (cloned there); a folder that isn't one starts in an empty folder.
 */
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import type WebSocket from 'ws'
import { cloudChatAttachPath, type CloudChatDown, type CloudChatInfo, type CloudChatStart, type CloudChatUp } from '../../shared/cloud'
import type { ChildLike, ChildSpawn } from '../chat/streamProc'
import type { CloudClient } from './client'

export interface CloudChatDeps {
  /** the linked cloud (throws when this Mac isn't connected to one) */
  client(): CloudClient
  /** the project folder's GitHub repository and a branch GitHub has, or null */
  repoOf?(cwd: string): Promise<{ url: string; branch: string | null } | null>
  log?: { info(m: string, d?: Record<string, unknown>): void; warn(m: string, d?: Record<string, unknown>): void }
  setTimer?: (fn: () => void, ms: number) => unknown
  /** reconnect backoff (tests) */
  backoffMs?: (attempt: number) => number
}

/** The choices in a chat argv (src/main/chat/chatArgs.ts toChatArgs), nothing else. */
export function chatChoices(args: readonly string[]): Omit<CloudChatStart, 'adapter' | 'repoUrl' | 'branch'> {
  const val = (flag: string): string | null => {
    const i = args.indexOf(flag)
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : null
  }
  const resume = args.includes('--resume')
  const conversationId = val(resume ? '--resume' : '--session-id')
  if (!conversationId) throw new Error('This chat has no conversation id')
  return {
    conversationId,
    resume,
    model: val('--model'),
    permissionMode: val('--permission-mode'),
    bypass: args.includes('--dangerously-skip-permissions'),
    systemPrompt: val('--append-system-prompt')
  }
}

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git` -> `https://github.com/o/r`. */
export function githubHttps(remote: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

const git = (cwd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile('git', ['-C', cwd, ...args], { timeout: 10_000 }, (e, out) => resolve(e ? null : String(out).trim())))

/** The folder's `origin` on GitHub, and its branch when GitHub has it (it has an upstream). */
export async function gitRepoOf(cwd: string): Promise<{ url: string; branch: string | null } | null> {
  const remote = await git(cwd, ['remote', 'get-url', 'origin'])
  const url = remote ? githubHttps(remote) : null
  if (!url) return null
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const branch = upstream && upstream.startsWith('origin/') ? upstream.slice('origin/'.length) : null
  return { url, branch }
}

class Pipe extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

class CloudChild extends EventEmitter implements ChildLike {
  readonly pid = 0
  readonly stdout = new Pipe()
  readonly stderr = new Pipe()
  readonly stdin: NonNullable<ChildLike['stdin']>
  private ws: WebSocket | null = null
  private queue: CloudChatUp[] = []
  /** characters of output received: the next attach asks for what comes after */
  private seen = 0
  private exited = false
  private started = false
  private killed: NodeJS.Signals | null = null
  private attempts = 0
  private statusCb: ((t: string) => void) | null = null
  /** it ended in the cloud, but output before that hasn't arrived yet: the exit waits for it */
  private pendingExit: { out: number; code: number | null; signal: NodeJS.Signals | null } | null = null

  constructor(
    private d: CloudChatDeps,
    private id: string,
    private start: CloudChatStart
  ) {
    super()
    this.stdin = {
      write: (data: string) => {
        this.up({ t: 'in', d: data })
        return true
      },
      end: () => this.up({ t: 'end' }),
      on: () => this.stdin
    }
    // next tick: whoever made it subscribes (onStatus, stdout) before the first word
    void Promise.resolve().then(() => this.begin())
  }

  onStatus(cb: (text: string) => void): void {
    this.statusCb = cb
  }
  private status(text: string): void {
    this.statusCb?.(text)
  }

  private up(f: CloudChatUp): void {
    if (this.exited) return
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(f))
    else this.queue.push(f)
  }

  private async begin(): Promise<void> {
    try {
      this.status('Starting in your cloud…')
      // a sleeping managed cloud is woken by the client and the start is sent again (docs/FLEET.md §6)
      const info = await this.d.client().call<CloudChatInfo>('chatStart', { params: { id: this.id }, body: this.start, timeoutMs: 60_000 })
      this.started = true
      if (this.killed) this.up({ t: 'signal', sig: this.killed === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM' })
      this.onState(info)
      this.connect()
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
    }
  }

  private connect(): void {
    if (this.exited) return
    let ws: WebSocket
    try {
      ws = this.d.client().socket(cloudChatAttachPath(this.id, this.seen))
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e))
    }
    this.ws = ws
    ws.on('open', () => {
      this.attempts = 0
      for (const f of this.queue.splice(0)) ws.send(JSON.stringify(f))
    })
    ws.on('message', (raw) => {
      let f: CloudChatDown
      try {
        f = JSON.parse(String(raw)) as CloudChatDown
      } catch {
        return
      }
      if (f.t === 'out') this.onOut(f.d, f.at)
      else if (f.t === 'err') this.stderr.emit('data', f.d)
      else if (f.t === 'state') this.onState(f.info)
    })
    ws.on('error', (e) => this.d.log?.warn('cloud chat: socket error', { id: this.id, error: e.message }))
    ws.on('close', (code) => {
      if (this.ws === ws) this.ws = null
      if (this.exited) return
      // the cloud no longer has this chat (restarted, or deleted): it ended there
      if (code === 4404) return this.ended(null, null)
      this.attempts++
      if (this.attempts === 2) this.status('Reconnecting to your cloud…')
      const wait = this.d.backoffMs?.(this.attempts) ?? Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6))
      const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
      set(() => this.connect(), wait)
    })
  }

  private onOut(d: string, at: number): void {
    // a replay can overlap what arrived before the socket dropped: only the new part
    const end = at + d.length
    if (end <= this.seen) return
    const fresh = at < this.seen ? d.slice(this.seen - at) : d
    this.seen = end
    this.stdout.emit('data', fresh)
    const p = this.pendingExit
    if (p && this.seen >= p.out) this.ended(p.code, p.signal)
  }

  private onState(info: CloudChatInfo): void {
    if (info.state === 'preparing' && info.detail) this.status(info.detail)
    if (info.state === 'exited') {
      if (info.error) this.stderr.emit('data', `${info.error}\n`)
      const signal = (info.signal as NodeJS.Signals | null) ?? null
      // every character it wrote reaches the chat before "it ended" (the answer given while this Mac was away)
      if (info.out > this.seen) {
        this.pendingExit = { out: info.out, code: info.exitCode, signal }
        const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
        set(() => this.ended(info.exitCode, signal), 5000)
        return
      }
      this.ended(info.exitCode, signal)
    }
  }

  private fail(message: string): void {
    if (this.exited) return
    this.d.log?.warn('cloud chat: could not start', { id: this.id, error: message })
    this.stderr.emit('data', `${message}\n`)
    this.ended(1, null)
  }

  private ended(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false
    const sig = signal === 'SIGKILL' ? 'SIGKILL' : signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
    if (!this.started) {
      this.killed = sig
      return true
    }
    this.up({ t: 'signal', sig })
    return true
  }
}

/**
 * The chat's spawner: the CLI runs in the cloud, in the project folder's GitHub repository. The cloud keeps it under
 * the conversation id, so a Restart (a new session resuming the same conversation) finds its history and folder there.
 */
export function cloudChildSpawn(d: CloudChatDeps): ChildSpawn {
  return (_file, args, opts) => {
    const choices = chatChoices(args)
    const lazy = new LazyChild()
    void (d.repoOf ?? gitRepoOf)(opts.cwd)
      .catch(() => null)
      .then((repo) => lazy.attach(new CloudChild(d, choices.conversationId, { adapter: 'claude', ...choices, repoUrl: repo?.url ?? null, branch: repo?.branch ?? null })))
    return lazy
  }
}

/** A ChildLike that forwards to a child made a moment later (after an async lookup). */
class LazyChild extends EventEmitter implements ChildLike {
  readonly pid = 0
  readonly stdout = new Pipe()
  readonly stderr = new Pipe()
  readonly stdin: NonNullable<ChildLike['stdin']>
  private child: CloudChild | null = null
  private early: ({ k: 'write'; d: string } | { k: 'end' } | { k: 'kill'; s: NodeJS.Signals })[] = []
  private statusCb: ((t: string) => void) | null = null
  constructor() {
    super()
    this.stdin = {
      write: (data: string) => (this.child ? this.child.stdin.write(data) : (this.early.push({ k: 'write', d: data }), true)),
      end: () => (this.child ? this.child.stdin.end() : void this.early.push({ k: 'end' })),
      on: () => this.stdin
    }
  }
  attach(c: CloudChild): void {
    this.child = c
    if (this.statusCb) c.onStatus(this.statusCb)
    c.stdout.on('data', (d) => this.stdout.emit('data', d))
    c.stderr.on('data', (d) => this.stderr.emit('data', d))
    c.on('exit', (code, sig) => this.emit('exit', code, sig))
    c.on('error', (e) => this.emit('error', e))
    for (const e of this.early.splice(0)) {
      if (e.k === 'write') c.stdin.write(e.d)
      else if (e.k === 'end') c.stdin.end()
      else c.kill(e.s)
    }
  }
  onStatus(cb: (text: string) => void): void {
    this.statusCb = cb
    this.child?.onStatus(cb)
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.child) return this.child.kill(signal)
    this.early.push({ k: 'kill', s: signal })
    return true
  }
}
