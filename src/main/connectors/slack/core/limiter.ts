/**
 * Web API rate limiter (SLACK.md §5.2, PO-S7). One sliding 60 s window per (method) sized to Hive's budget (about
 * 80 % of the documented tier minimum), chat.postMessage additionally 1/s per channel and 20/min overall.
 * Two lanes: `interactive` (UI clicks, MCP tool calls, sends) always beats `background`; inside background, gap-fill
 * beats unknown-id lookups beats backfill (FIFO within each). A 429 blocks that method until Retry-After and the call
 * is requeued at the front of its lane. No tier guessing: Retry-After is the only feedback Hive honours.
 */
import type { Clock } from './ports'

export type Lane = 'interactive' | 'gapfill' | 'live' | 'backfill'
const LANE_ORDER: Record<Lane, number> = { interactive: 0, gapfill: 1, live: 2, backfill: 3 }

/** Hive's budget per minute (SLACK.md §5.1). */
export const BUDGETS: Record<string, number> = {
  'auth.test': 10,
  'apps.connections.open': 3,
  'conversations.list': 16,
  'conversations.info': 40,
  'conversations.history': 40,
  'conversations.replies': 40,
  'conversations.open': 40,
  'conversations.join': 40,
  'users.list': 16,
  'users.info': 80,
  'chat.postMessage': 20,
  'chat.getPermalink': 80
}
const DEFAULT_BUDGET = 16
const WINDOW_MS = 60_000

interface Window {
  limit: number
  windowMs: number
  hits: number[]
}
interface Waiter {
  keys: string[]
  lane: number
  front: boolean
  seq: number
  resolve: () => void
  reject: (e: Error) => void
}

export function keysFor(method: string, channel?: string | null): string[] {
  return method === 'chat.postMessage' && channel ? [method, `${method}@${channel}`] : [method]
}

export class Limiter {
  private windows = new Map<string, Window>()
  private blocked = new Map<string, number>()
  private waiters: Waiter[] = []
  private seq = 0
  private timer: unknown = null
  private timerAt = Infinity

  constructor(private clock: Clock) {}

  private win(key: string): Window {
    let w = this.windows.get(key)
    if (!w) {
      const perChannel = key.includes('@')
      w = perChannel ? { limit: 1, windowMs: 1000, hits: [] } : { limit: BUDGETS[key] ?? DEFAULT_BUDGET, windowMs: WINDOW_MS, hits: [] }
      this.windows.set(key, w)
    }
    return w
  }

  /** Earliest time `key` has room (0 = now). */
  private readyAt(key: string, now: number): number {
    const method = key.split('@')[0]
    const b = this.blocked.get(method) ?? 0
    const w = this.win(key)
    w.hits = w.hits.filter((t) => now - t < w.windowMs)
    const room = w.hits.length < w.limit ? now : w.hits[0] + w.windowMs
    return Math.max(b, room)
  }

  /** Wait for a slot on every key, then take it. */
  acquire(keys: string[], lane: Lane, opts: { front?: boolean } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ keys, lane: LANE_ORDER[lane], front: !!opts.front, seq: this.seq++, resolve, reject })
      this.pump()
    })
  }

  /** HTTP 429 / `ratelimited`: no call to `method` until untilMs. */
  block(method: string, untilMs: number): void {
    this.blocked.set(method, Math.max(this.blocked.get(method) ?? 0, untilMs))
    this.pump()
  }

  /** Latest active block (status: "Slack asked Hive to slow down (history) · resumes 14:02:10"). */
  rateLimited(): { method: string; until: number } | null {
    const now = this.clock.now()
    let best: { method: string; until: number } | null = null
    for (const [method, until] of this.blocked) if (until > now && (!best || until > best.until)) best = { method, until }
    return best
  }

  pending(): number {
    return this.waiters.length
  }

  private pump(): void {
    const now = this.clock.now()
    this.waiters.sort((a, b) => a.lane - b.lane || Number(b.front) - Number(a.front) || a.seq - b.seq)
    const reserved = new Set<string>()
    let wake = Infinity
    const left: Waiter[] = []
    for (const w of this.waiters) {
      if (w.keys.some((k) => reserved.has(k))) {
        left.push(w)
        continue
      }
      const at = Math.max(...w.keys.map((k) => this.readyAt(k, now)))
      if (at <= now) {
        for (const k of w.keys) this.win(k).hits.push(now)
        w.resolve()
      } else {
        for (const k of w.keys) reserved.add(k)
        wake = Math.min(wake, at)
        left.push(w)
      }
    }
    this.waiters = left
    if (wake < Infinity && wake < this.timerAt) {
      if (this.timer) this.clock.clearTimeout(this.timer)
      this.timerAt = wake
      this.timer = this.clock.setTimeout(() => {
        this.timer = null
        this.timerAt = Infinity
        this.pump()
      }, Math.max(1, wake - now))
    }
  }

  /** Reject every waiter (stop/disconnect). */
  reset(reason = 'Slack connector stopped'): void {
    const w = this.waiters
    this.waiters = []
    for (const x of w) x.reject(new Error(reason))
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.timerAt = Infinity
  }
}
