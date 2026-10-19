/**
 * "Stalled?" detection (LANDSCAPE.md "Elon's cut" #4). A working step or session that shows no output and no hook
 * activity for N minutes is flagged once; any new activity clears it. Never kills anything.
 * Owners that wait on the user (an open ask, an idle session) are not working, so they are never flagged.
 *
 * Pure core: the clock is injected and `sweep()` is called by the owner (tests call it directly). `startTimer()` is a
 * thin interval wrapper for production.
 */
export interface StallEntry {
  /** Called with the ISO time the stall started, or null when activity cleared it. */
  onChange(stalledSince: string | null): void
  /** True while the owner waits on the user (open ask, idle turn). Evaluated at sweep time. */
  waiting?(): boolean
}

interface Tracked {
  entry: StallEntry
  last: number
  stalledAt: number | null
}

export interface StallMonitorOptions {
  /** Threshold in ms (read on every sweep, so a settings change applies at once). <= 0 disables flagging. */
  thresholdMs(): number
  now?(): number
}

export class StallMonitor {
  private items = new Map<string, Tracked>()
  private timer: NodeJS.Timeout | null = null
  constructor(private o: StallMonitorOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now()
  }

  /** Start watching `key` (activity clock starts now). Re-tracking resets it. */
  track(key: string, entry: StallEntry): void {
    this.items.set(key, { entry, last: this.now(), stalledAt: null })
  }

  /** Output or hook activity: resets the clock and clears a stall at once. */
  touch(key: string): void {
    const t = this.items.get(key)
    if (!t) return
    t.last = this.now()
    if (t.stalledAt !== null) {
      t.stalledAt = null
      safe(() => t.entry.onChange(null))
    }
  }

  /** Stop watching. Clears a standing stall (the owner ended or went away). */
  untrack(key: string): void {
    const t = this.items.get(key)
    if (!t) return
    this.items.delete(key)
    if (t.stalledAt !== null) safe(() => t.entry.onChange(null))
  }

  isStalled(key: string): boolean {
    return this.items.get(key)?.stalledAt != null
  }

  size(): number {
    return this.items.size
  }

  /**
   * Flags owners silent for >= threshold (once per stall), and clears flags of owners that now wait on the user.
   * Waiting owners keep their clock moving, so a step that resumes after an answer starts a fresh window.
   * Returns the keys flagged by this sweep.
   */
  sweep(): string[] {
    const limit = this.o.thresholdMs()
    const now = this.now()
    const flagged: string[] = []
    for (const [key, t] of this.items) {
      let waiting = false
      try {
        waiting = !!t.entry.waiting?.()
      } catch {
        waiting = false
      }
      if (waiting) {
        t.last = now
        if (t.stalledAt !== null) {
          t.stalledAt = null
          safe(() => t.entry.onChange(null))
        }
        continue
      }
      if (limit <= 0 || t.stalledAt !== null) continue
      if (now - t.last >= limit) {
        t.stalledAt = now
        flagged.push(key)
        // the stall began when the output stopped, not when the sweep noticed
        safe(() => t.entry.onChange(new Date(t.last).toISOString()))
      }
    }
    return flagged
  }

  /** Sweeps every `everyMs` (unref'd) while anything is tracked. Idempotent. */
  startTimer(everyMs = 15_000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), everyMs)
    this.timer.unref?.()
  }
  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function safe(f: () => void): void {
  try {
    f()
  } catch {
    /* a listener error never breaks the monitor */
  }
}

/** Settings.stallMinutes -> ms (default 10, clamped 1..240). */
export function stallThresholdMs(minutes: unknown): number {
  const n = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 10
  return Math.round(Math.min(240, Math.max(1, n)) * 60_000)
}
