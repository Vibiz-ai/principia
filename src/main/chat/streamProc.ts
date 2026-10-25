/**
 * CHAT-UI.md §3.1: one `claude -p` stream-json process. Splits stdout into JSON lines, numbers our control requests and
 * resolves their responses, and reports exit. No Electron imports; the child is injectable for tests.
 */
import { spawn as nodeSpawn } from 'node:child_process'

/** The slice of a ChildProcess this module uses. */
export interface ChildLike {
  pid?: number | undefined
  stdin: { write(d: string): boolean; end(): void; on?(ev: 'error', cb: (e: Error) => void): unknown } | null
  stdout: { on(ev: 'data', cb: (d: Buffer | string) => void): unknown; setEncoding?(e: string): unknown } | null
  stderr: { on(ev: 'data', cb: (d: Buffer | string) => void): unknown } | null
  on(ev: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(ev: 'error', cb: (e: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type ChildSpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildLike

export const defaultChildSpawn: ChildSpawn = (file, args, opts) =>
  // own process group: Kill reaches the CLI and its MCP children together
  nodeSpawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }) as unknown as ChildLike

const MAX_LINE = 32 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export interface StreamProcOptions {
  onLine(o: Record<string, unknown>): void
  onExit(code: number | null, signal: NodeJS.Signals | null): void
  /** stderr text (diagnostics; redacted by the caller) */
  onStderr?(text: string): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export class StreamProc {
  readonly pid: number
  private buf = ''
  private nextId = 0
  private pending = new Map<string, { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: unknown }>()
  exited = false
  private stdinOpen = true
  stderrTail = ''

  constructor(
    readonly child: ChildLike,
    private o: StreamProcOptions
  ) {
    this.pid = child.pid ?? 0
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (d) => this.onData(typeof d === 'string' ? d : d.toString('utf8')))
    child.stderr?.on('data', (d) => {
      const t = typeof d === 'string' ? d : d.toString('utf8')
      this.stderrTail = (this.stderrTail + t).slice(-4000)
      o.onStderr?.(t)
    })
    child.stdin?.on?.('error', () => {
      this.stdinOpen = false
    })
    child.on('error', () => this.finish(null, null))
    child.on('exit', (code, signal) => this.finish(code, signal))
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    if (this.buf.trim()) this.handle(this.buf)
    this.buf = ''
    this.exited = true
    this.stdinOpen = false
    for (const [, p] of this.pending) {
      ;(this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(p.timer)
      p.reject(new Error('Claude stopped'))
    }
    this.pending.clear()
    this.o.onExit(code, signal)
  }

  private onData(d: string): void {
    this.buf += d
    if (this.buf.length > MAX_LINE) this.buf = this.buf.slice(-MAX_LINE)
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const l = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.handle(l)
    }
  }

  private handle(l: string): void {
    if (!l.trim()) return
    let o: Record<string, unknown>
    try {
      const v = JSON.parse(l) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) return
      o = v as Record<string, unknown>
    } catch {
      return // the CLI prints only JSON in this mode; anything else is noise
    }
    if (o.type === 'control_response') {
      const r = (o.response ?? {}) as Record<string, unknown>
      const id = typeof r.request_id === 'string' ? r.request_id : null
      const p = id ? this.pending.get(id) : undefined
      if (p && id) {
        this.pending.delete(id)
        ;(this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(p.timer)
        if (r.subtype === 'error') p.reject(new Error(typeof r.error === 'string' ? r.error : 'Claude refused the request'))
        else p.resolve((r.response ?? {}) as Record<string, unknown>)
        return
      }
    }
    this.o.onLine(o)
  }

  get alive(): boolean {
    return !this.exited && this.stdinOpen
  }

  /** One stdin line. False when the process can no longer take input. */
  write(o: unknown): boolean {
    if (!this.alive || !this.child.stdin) return false
    try {
      return this.child.stdin.write(`${JSON.stringify(o)}\n`) !== undefined
    } catch {
      this.stdinOpen = false
      return false
    }
  }

  /** A control request of ours (initialize, interrupt, set_model, …); resolves with its response body. */
  request(subtype: string, extra: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const id = `hive_${++this.nextId}`
    return new Promise((resolve, reject) => {
      const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
      const timer = set(() => {
        if (this.pending.delete(id)) reject(new Error(`${subtype} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.write({ type: 'control_request', request_id: id, request: { subtype, ...extra } })) {
        this.pending.delete(id)
        ;(this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(timer)
        reject(new Error('Claude is not running'))
      }
    })
  }

  /** Answer a request the CLI made (can_use_tool). */
  respond(requestId: string, response: unknown): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  }
  respondError(requestId: string, error: string): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
  }

  /** Close stdin: the CLI finishes and exits. */
  end(): void {
    if (!this.stdinOpen) return
    this.stdinOpen = false
    try {
      this.child.stdin?.end()
    } catch {
      /* already closed */
    }
  }
}
