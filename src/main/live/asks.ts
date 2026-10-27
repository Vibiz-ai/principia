/**
 * Needs-you notifications (docs/LIVE.md §4.5, PO amendment A7). Pure policy + injected I/O so it is unit-testable:
 * - a new permission/question/trust ask notifies unless the window is focused AND its owner (session pane / run view)
 *   is the visible owner;
 * - 3 s grace: an ask resolved within 3 s (answered in the terminal) never notifies;
 * - at most one notification per root per 30 s; several asks opened in a burst become "n things need you";
 * - expired / auto-denied asks are grouped into one notification per run;
 * - idle ("your turn") notifies only while the window is unfocused and the turn took >= 20 s, <= 1 per session per 60 s.
 * SOUNDS.md: a batched ask carries the Needs you sound, a long turn the Done sound; a long turn that ends while the
 * window is focused on something else gets the sound alone (no notification), never while its chat is on screen.
 */
import type { Id } from '../../shared/types'
import type { Ask } from '../../shared/live'
import type { ChimeEvent } from '../chime'

export const GRACE_MS = 3000
export const ROOT_COOLDOWN_MS = 30_000
export const IDLE_MIN_TURN_MS = 20_000
export const IDLE_COOLDOWN_MS = 60_000
export const EXPIRED_GROUP_MS = 2000

export interface NotifyRequest {
  title: string
  body: string
  /** Click target. */
  agentId: Id
  /** SOUNDS.md: the sound this notification stands for (absent = the plain notification sound setting). */
  chime?: ChimeEvent
}

export interface NeedsYouNotifierDeps {
  notify(n: NotifyRequest): void
  /** SOUNDS.md: a sound with no notification (a long turn ended while the window is focused elsewhere). */
  chime?(e: ChimeEvent): void
  /** Whether the window is focused right now. */
  focused(): boolean
  /** What the renderer reports as visible (ui:visibleOwner). */
  visible(): { sessionId: Id | null; runId: Id | null }
  /** Display title of a root ("example-project · Claude", "<run title> › <node>"). */
  rootTitle(rootId: Id): string
  /** Whether the ask is still open (re-read at fire time). */
  isOpen(askId: Id): boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

interface RootBatch {
  asks: Ask[]
  timer: unknown | null
}

export class NeedsYouNotifier {
  private batches = new Map<Id, RootBatch>()
  private lastRootNotify = new Map<Id, number>()
  private lastIdleNotify = new Map<Id, number>()
  private expired = new Map<string, { asks: Ask[]; timer: unknown }>()
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => unknown
  private clearTimer: (t: unknown) => void

  constructor(private d: NeedsYouNotifierDeps) {
    this.now = d.now ?? (() => Date.now())
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout))
  }

  /** The owner of this ask is what the user is looking at, in a focused window. */
  private ownerVisible(a: { sessionId: Id | null; runId: Id | null }): boolean {
    if (!this.d.focused()) return false
    const v = this.d.visible()
    return (!!a.sessionId && v.sessionId === a.sessionId) || (!!a.runId && v.runId === a.runId)
  }

  askOpened(ask: Ask): void {
    if (ask.status !== 'open') return
    const b = this.batches.get(ask.rootId) ?? { asks: [], timer: null }
    b.asks.push(ask)
    this.batches.set(ask.rootId, b)
    if (!b.timer) this.schedule(ask.rootId, b)
  }

  private schedule(rootId: Id, b: RootBatch): void {
    const last = this.lastRootNotify.get(rootId) ?? -Infinity
    const wait = Math.max(GRACE_MS, last + ROOT_COOLDOWN_MS - this.now())
    b.timer = this.setTimer(() => this.fire(rootId), wait)
  }

  private fire(rootId: Id): void {
    const b = this.batches.get(rootId)
    if (!b) return
    b.timer = null
    const open = b.asks.filter((a) => this.d.isOpen(a.id) && !this.ownerVisible(a))
    this.batches.delete(rootId)
    if (!open.length) return
    this.lastRootNotify.set(rootId, this.now())
    const title = `${this.d.rootTitle(rootId)} needs you`
    const body = open.length === 1 ? open[0].title : `${open.length} things need you`
    this.d.notify({ title, body, agentId: open[0].agentId, chime: { kind: 'needs', key: `ask:${open[0].id}` } })
  }

  /** Called on every ask update; expired / auto-denied asks are grouped per run (or root). */
  askResolved(ask: Ask): void {
    if (ask.status === 'expired' || (ask.answeredVia === 'timeout' && ask.status !== 'canceled')) {
      const key = ask.runId ?? ask.rootId
      const g = this.expired.get(key)
      if (g) g.asks.push(ask)
      else
        this.expired.set(key, {
          asks: [ask],
          timer: this.setTimer(() => this.fireExpired(key), EXPIRED_GROUP_MS)
        })
    }
  }

  private fireExpired(key: string): void {
    const g = this.expired.get(key)
    this.expired.delete(key)
    if (!g || !g.asks.length) return
    const first = g.asks[0]
    const n = g.asks.length
    this.d.notify({
      title: `${this.d.rootTitle(first.rootId)}: no answer`,
      body: n === 1 ? `Hive denied "${first.title}" after 60 min` : `Hive denied ${n} requests after 60 min`,
      agentId: first.agentId
    })
  }

  /** Idle "your turn" for a session root. turnMs = how long the turn ran. */
  idle(root: { id: Id; sessionId: Id | null; title: string }, turnMs: number): void {
    const focused = this.d.focused()
    // a focused window only ever gets the sound, and only when the chat is not the one on screen
    if (focused && (!this.d.chime || this.ownerVisible({ sessionId: root.sessionId, runId: null }))) return
    if (turnMs < IDLE_MIN_TURN_MS) return
    const key = root.sessionId ?? root.id
    const last = this.lastIdleNotify.get(key) ?? -Infinity
    if (this.now() - last < IDLE_COOLDOWN_MS) return
    this.lastIdleNotify.set(key, this.now())
    const chime: ChimeEvent = { kind: 'done', key: `turn:${key}:${this.now()}` }
    if (focused) this.d.chime?.(chime)
    else this.d.notify({ title: `${root.title} needs you`, body: 'Your turn', agentId: root.id, chime })
  }

  dispose(): void {
    for (const b of this.batches.values()) if (b.timer) this.clearTimer(b.timer)
    for (const g of this.expired.values()) this.clearTimer(g.timer)
    this.batches.clear()
    this.expired.clear()
  }
}
