/**
 * SOUNDS.md: the one place that decides whether a sound plays. Pure policy + injected I/O (no Electron), so the rules
 * are unit-tested:
 * - three kinds only: done (real work finished), needs (an agent asks or wants approval), problem (failed, stalled,
 *   limit, cap). Each kind has its own switch; "Sounds" (notificationSound) turns all of them off;
 * - never before the renderer is up plus ARM_DELAY_MS (boot recovery, catch-up, resumed sessions replaying history);
 * - never while the user looks right at the thing that changed (the caller passes `visible`);
 * - the same event key never plays twice;
 * - a burst within COALESCE_MS is one sound (the most urgent kind wins); at most one sound per GLOBAL_GAP_MS, and
 *   each kind keeps its own longer gap;
 * - the renderer plays it (chime:play, WebAudio); with no window to play in, the Mac notification for the same event
 *   keeps its own sound instead ('fallback'). Every other outcome means that notification stays silent.
 */
import type { ChimeKind, Settings } from '../shared/types'
import type { BoardTask, TaskStatus } from '../shared/company'
import { milestoneComplete, type Plan } from '../shared/plans'

export type { ChimeKind }
export const ARM_DELAY_MS = 15_000
export const COALESCE_MS = 600
export const GLOBAL_GAP_MS = 8000
export const KIND_GAP_MS: Record<ChimeKind, number> = { done: 20_000, needs: 15_000, problem: 30_000 }
export const DEFAULT_VOLUME = 0.5
const KEYS_MAX = 500
/** The most urgent kind wins a coalesced burst. */
const RANK: Record<ChimeKind, number> = { done: 0, problem: 1, needs: 2 }

export interface ChimeEvent {
  kind: ChimeKind
  /** One per real-world event ("review:<task>:<updatedAt>"): the same key never plays twice. */
  key: string
  /** The user is looking right at the thing that changed, in a focused window. */
  visible?: boolean
}
/** 'chime': the renderer plays it (or it joined one about to play); 'fallback': the notification keeps its sound; 'quiet': no sound. */
export type ChimeOutcome = 'chime' | 'fallback' | 'quiet'

export interface ChimeSettings {
  enabled: boolean
  kinds: Record<ChimeKind, boolean>
  volume: number
}
/** Settings › Notifications › Sounds. Absent per-kind switches are on; the volume defaults to a modest 0.5. */
export function chimeSettings(s: Pick<Settings, 'notificationSound' | 'soundDone' | 'soundNeedsYou' | 'soundProblem' | 'soundVolume'>): ChimeSettings {
  const v = typeof s.soundVolume === 'number' && Number.isFinite(s.soundVolume) ? Math.min(1, Math.max(0, s.soundVolume)) : DEFAULT_VOLUME
  return {
    enabled: s.notificationSound !== false,
    kinds: { done: s.soundDone !== false, needs: s.soundNeedsYou !== false, problem: s.soundProblem !== false },
    volume: v
  }
}

export interface ChimeDeps {
  settings(): ChimeSettings
  /** A window with a mounted renderer exists to play the sound in. */
  canPlay(): boolean
  play(kind: ChimeKind, volume: number): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
}

export class Chimes {
  private armAt = Infinity
  private keys = new Set<string>()
  private lastPlay = -Infinity
  private lastKind: Record<ChimeKind, number> = { done: -Infinity, needs: -Infinity, problem: -Infinity }
  private pending: { kind: ChimeKind } | null = null
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => unknown

  constructor(private d: ChimeDeps) {
    this.now = d.now ?? (() => Date.now())
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** The renderer said ui:ready. Sounds start ARM_DELAY_MS later; a renderer reload never pushes that back. */
  arm(): void {
    if (this.armAt === Infinity) this.armAt = this.now() + ARM_DELAY_MS
  }

  request(e: ChimeEvent): ChimeOutcome {
    const s = this.d.settings()
    if (!s.enabled || !s.kinds[e.kind]) return 'quiet'
    if (this.now() < this.armAt) return 'quiet'
    if (this.keys.has(e.key)) return 'quiet'
    this.remember(e.key)
    if (e.visible) return 'quiet'
    const p = this.pending
    if (p) {
      // the burst is one sound: a more urgent kind takes it over unless that kind is still in its own gap
      if (RANK[e.kind] > RANK[p.kind] && this.now() - this.lastKind[e.kind] >= KIND_GAP_MS[e.kind]) p.kind = e.kind
      return 'chime'
    }
    if (this.now() - this.lastPlay < GLOBAL_GAP_MS) return 'quiet'
    if (this.now() - this.lastKind[e.kind] < KIND_GAP_MS[e.kind]) return 'quiet'
    if (!this.d.canPlay()) {
      // no window: the notification's own sound stands in, and counts as the sound for the gaps
      this.played(e.kind)
      return 'fallback'
    }
    this.pending = { kind: e.kind }
    this.setTimer(() => this.fire(), COALESCE_MS)
    return 'chime'
  }

  /** request(), for a caller that also posts a Mac notification: whether that notification keeps its own sound. */
  notificationSound(e: ChimeEvent): boolean {
    return this.request(e) === 'fallback'
  }

  private fire(): void {
    const p = this.pending
    this.pending = null
    if (!p || !this.d.canPlay()) return
    this.played(p.kind)
    this.d.play(p.kind, this.d.settings().volume)
  }

  private played(kind: ChimeKind): void {
    this.lastPlay = this.now()
    this.lastKind[kind] = this.now()
  }

  private remember(key: string): void {
    this.keys.add(key)
    if (this.keys.size > KEYS_MAX) this.keys = new Set([...this.keys].slice(-Math.floor(KEYS_MAX / 2)))
  }
}

/**
 * Done: an agent finished a task's work, in progress → in review (its run ended, or the chat tracking it moved it).
 * A human move (approve, send back, an edit) never is: the founder made it. Returns the event key, or null.
 */
export function taskChimeKey(t: Pick<BoardTask, 'id' | 'status' | 'updatedAt'>, prev: { status: TaskStatus } | null): string | null {
  return prev?.status === 'in_progress' && t.status === 'in_review' ? `review:${t.id}:${t.updatedAt}` : null
}

/** Done: a milestone newly complete (gate passed, and passed by you outside Autopilot), or the whole plan done. */
export function planChimeKeys(prev: Plan | null, next: Plan): string[] {
  if (!prev) return []
  const keys: string[] = []
  if (prev.status !== 'done' && next.status === 'done') keys.push(`plan:${next.id}`)
  for (const m of next.milestones) {
    const was = prev.milestones.find((x) => x.id === m.id)
    if (was && !milestoneComplete(prev, was) && milestoneComplete(next, m)) keys.push(`milestone:${m.id}`)
  }
  return keys
}
