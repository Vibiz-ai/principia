/**
 * One Socket Mode connection (SLACK.md §4.2-§4.4, PO-S6). Opens the URL apps.connections.open returned, waits up to
 * 10 s for `hello`, keeps it alive (ping every 30 s, no pong within 10 s = dead, 60 s with no frame at all = dead) and
 * reports exactly one `closed` with a cause. Reconnect policy lives in the connector.
 */
import { envelopeSchema, type WireEnvelope } from './types'
import { maskTokens } from './format'
import type { Clock, Logger, SocketLike, SocketPort } from './ports'

export const HELLO_TIMEOUT_MS = 10_000
export const PING_EVERY_MS = 30_000
export const PONG_TIMEOUT_MS = 10_000
export const SILENCE_MS = 60_000

export type CloseCause = 'remote' | 'hello_timeout' | 'ping_timeout' | 'silence' | 'local' | 'error'

export interface SocketHandlers {
  hello(h: WireEnvelope): void
  envelope(e: WireEnvelope, receivedAt: number): void
  disconnectMsg(reason: string): void
  closed(info: { code: number; reason: string; cause: CloseCause }): void
}

export class SocketConn {
  private ws: SocketLike | null = null
  private helloTimer: unknown = null
  private pingTimer: unknown = null
  private pongTimer: unknown = null
  private silenceTimer: unknown = null
  private done = false
  private cause: CloseCause | null = null
  gotHello = false

  constructor(
    private port: SocketPort,
    private clock: Clock,
    private log: Logger,
    private h: SocketHandlers
  ) {}

  open(url: string): void {
    const ws = this.port.open(url)
    this.ws = ws
    this.helloTimer = this.clock.setTimeout(() => this.kill(4000, 'hello timeout', 'hello_timeout'), HELLO_TIMEOUT_MS)
    this.touch()
    ws.on('message', (text: string) => this.onFrame(text))
    ws.on('ping', () => this.touch())
    ws.on('pong', () => {
      this.touch()
      if (this.pongTimer) this.clock.clearTimeout(this.pongTimer)
      this.pongTimer = null
    })
    ws.on('close', (code: number, reason: string) => this.finish(code, reason, this.cause ?? 'remote'))
    ws.on('error', (e: Error) => {
      this.log.warn('slack socket error', { e: maskTokens(e.message) })
      this.kill(4002, 'socket error', 'error')
    })
  }

  send(text: string): boolean {
    if (!this.ws || this.done) return false
    try {
      this.ws.send(text)
      return true
    } catch (e) {
      this.log.warn('slack socket send failed', { e: String(e) })
      return false
    }
  }

  ack(envelopeId: string): boolean {
    return this.send(JSON.stringify({ envelope_id: envelopeId }))
  }

  /** Close on purpose (1000 = normal). The `closed` callback still fires once, with cause 'local'. */
  close(code = 1000, reason = 'bye'): void {
    this.kill(code, reason, 'local')
  }

  private kill(code: number, reason: string, cause: CloseCause): void {
    if (this.done) return
    this.cause = this.cause ?? cause
    try {
      this.ws?.close(code, reason)
    } catch {
      /* already closed */
    }
    // some transports never emit close after a local close: finish now (idempotent)
    this.finish(code, reason, this.cause)
  }

  private finish(code: number, reason: string, cause: CloseCause): void {
    if (this.done) return
    this.done = true
    for (const t of [this.helloTimer, this.pingTimer, this.pongTimer, this.silenceTimer]) if (t) this.clock.clearTimeout(t)
    this.helloTimer = this.pingTimer = this.pongTimer = this.silenceTimer = null
    this.h.closed({ code, reason, cause })
  }

  private touch(): void {
    if (this.done) return
    if (this.silenceTimer) this.clock.clearTimeout(this.silenceTimer)
    this.silenceTimer = this.clock.setTimeout(() => this.kill(4001, 'no frames for 60 s', 'silence'), SILENCE_MS)
  }

  private schedulePing(): void {
    if (this.done) return
    this.pingTimer = this.clock.setTimeout(() => {
      if (this.done || !this.ws) return
      try {
        this.ws.ping()
      } catch {
        return this.kill(4001, 'ping failed', 'ping_timeout')
      }
      this.pongTimer = this.clock.setTimeout(() => this.kill(4001, 'no pong', 'ping_timeout'), PONG_TIMEOUT_MS)
      this.schedulePing()
    }, PING_EVERY_MS)
  }

  private onFrame(text: string): void {
    const at = this.clock.now()
    this.touch()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      this.log.warn('slack: unparseable frame dropped', { frame: maskTokens(text.slice(0, 2048)) })
      return
    }
    const p = envelopeSchema.safeParse(raw)
    if (!p.success) {
      this.log.warn('slack: invalid envelope dropped', { frame: maskTokens(text.slice(0, 2048)) })
      return
    }
    const env = p.data
    if (env.type === 'hello') {
      if (this.helloTimer) this.clock.clearTimeout(this.helloTimer)
      this.helloTimer = null
      this.gotHello = true
      this.schedulePing()
      this.h.hello(env)
      return
    }
    if (env.type === 'disconnect') {
      this.h.disconnectMsg(env.reason ?? 'unknown')
      return
    }
    this.h.envelope(env, at)
  }
}
