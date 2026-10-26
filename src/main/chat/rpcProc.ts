/**
 * AGENT CHAT: one `codex app-server` process (JSON-RPC 2.0 without the "jsonrpc" field, one JSON object per line on
 * stdio). Numbers our requests and resolves their responses, hands server requests (approvals) and notifications to
 * the session, and reports exit. No Electron imports; the child is injectable for tests.
 */
import type { ChildLike } from './streamProc'

const MAX_LINE = 32 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

export interface RpcProcOptions {
  onNotification(method: string, params: unknown): void
  /** a request from the server (an approval); answer it with respond / respondError */
  onRequest(id: number | string, method: string, params: unknown): void
  onExit(code: number | null, signal: NodeJS.Signals | null): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null
  ) {
    super(message)
  }
}

export class RpcProc {
  readonly pid: number
  private buf = ''
  private nextId = 0
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: unknown }>()
  exited = false
  private stdinOpen = true
  stderrTail = ''

  constructor(
    readonly child: ChildLike,
    private o: RpcProcOptions
  ) {
    this.pid = child.pid ?? 0
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (d) => this.onData(typeof d === 'string' ? d : d.toString('utf8')))
    child.stderr?.on('data', (d) => {
      this.stderrTail = (this.stderrTail + (typeof d === 'string' ? d : d.toString('utf8'))).slice(-4000)
    })
    child.stdin?.on?.('error', () => {
      this.stdinOpen = false
    })
    child.on('error', () => this.finish(null, null))
    child.on('exit', (code, signal) => this.finish(code, signal))
  }

  private clear(t: unknown): void {
    ;(this.o.clearTimer ?? ((x: unknown) => clearTimeout(x as NodeJS.Timeout)))(t)
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    if (this.buf.trim()) this.handle(this.buf)
    this.buf = ''
    this.exited = true
    this.stdinOpen = false
    for (const [, p] of this.pending) {
      this.clear(p.timer)
      p.reject(new RpcError('Codex stopped', null))
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
      return
    }
    const method = typeof o.method === 'string' ? o.method : null
    const id = typeof o.id === 'number' || typeof o.id === 'string' ? o.id : null
    if (method && id !== null) return this.o.onRequest(id, method, o.params)
    if (method) return this.o.onNotification(method, o.params)
    if (typeof id !== 'number') return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    this.clear(p.timer)
    const err = o.error as { message?: unknown; code?: unknown } | undefined
    if (err) p.reject(new RpcError(typeof err.message === 'string' ? err.message : 'Codex refused the request', typeof err.code === 'number' ? err.code : null))
    else p.resolve(o.result)
  }

  get alive(): boolean {
    return !this.exited && this.stdinOpen
  }

  private write(o: unknown): boolean {
    if (!this.alive || !this.child.stdin) return false
    try {
      return this.child.stdin.write(`${JSON.stringify(o)}\n`) !== undefined
    } catch {
      this.stdinOpen = false
      return false
    }
  }

  request<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
      const timer = set(() => {
        if (this.pending.delete(id)) reject(new RpcError(`${method} timed out`, null))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      if (!this.write({ id, method, params })) {
        this.pending.delete(id)
        this.clear(timer)
        reject(new RpcError('Codex is not running', null))
      }
    })
  }

  notify(method: string, params?: unknown): boolean {
    return this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: number | string, result: unknown): boolean {
    return this.write({ id, result })
  }
  respondError(id: number | string, message: string): boolean {
    return this.write({ id, error: { code: -32000, message } })
  }

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
