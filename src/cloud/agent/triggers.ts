/**
 * Cloud schedules (CLOUD.md §7.7). Every 15 s the runtime reads the schedules the control plane placed in the cloud
 * and asks for a run when a slot came due, with the desktop's cron math (`nextFire`), its 5-minute floor and its
 * catch-up rule: a slot missed while the box was down fires once if it is less than 12 hours old. The slot is part of
 * the request; the control plane keeps `(scheduleId, slot)` unique, and this loop never asks twice for one slot.
 *
 * Webhooks are not in v1 (§14): the contract keeps `triggers.webhook`, which answers 501.
 */
import type { ScheduleRow } from '../contract'
import { CATCHUP_MAX_AGE_MS, MIN_INTERVAL_MS, TICK_MS, minInterval, nextFire } from '../../main/engine/scheduler'

export interface ScheduleLoopDeps {
  schedules(): ScheduleRow[]
  requestRun(r: { scheduleId: string; companyId: string; slot: string; workflowId: string; inputs: Record<string, string> }): { runId: string | null; refused: string | null }
  markFired(scheduleId: string, slot: string, runId: string | null): void
  now(): Date
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void }
}

/**
 * The slot to fire now, or null. Pure. `since` is the last fired slot (or when this runtime first saw the schedule):
 * slots after it and not later than `now` are due; several due slots collapse into the newest one, and only slots
 * younger than 12 hours count.
 */
export function dueSlot(when: ScheduleRow['when'], since: Date, now: Date): Date | null {
  const floor = new Date(Math.max(since.getTime(), now.getTime() - CATCHUP_MAX_AGE_MS))
  let slot = nextFire(when, floor)
  let due: Date | null = null
  for (let i = 0; slot && slot.getTime() <= now.getTime() && i < 10_000; i++) {
    due = slot
    slot = nextFire(when, slot)
  }
  return due
}

/** A schedule's cron fires more often than every 5 minutes (the desktop's floor). Pure. */
export function tooFrequent(when: ScheduleRow['when'], now: Date): boolean {
  try {
    return minInterval(when, now) < MIN_INTERVAL_MS
  } catch {
    return true
  }
}

export class ScheduleLoop {
  private timer: NodeJS.Timeout | null = null
  /** when this process first saw a schedule that never fired (no catch-up before we knew about it) */
  private readonly firstSeen = new Map<string, number>()
  /** slots already asked for, across ticks (the control plane's unique slot covers restarts) */
  private readonly fired = new Set<string>()
  private readonly warned = new Set<string>()

  constructor(private readonly d: ScheduleLoopDeps) {}

  start(periodMs = TICK_MS): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), periodMs)
    this.timer.unref?.()
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  /** The schedule set changed (sync, pause): forget the first-seen marks of removed schedules and evaluate now. */
  reload(): void {
    let rows: ScheduleRow[] = []
    try {
      rows = this.d.schedules()
    } catch {
      /* next tick */
    }
    const ids = new Set(rows.map((r) => r.id))
    for (const id of [...this.firstSeen.keys()]) if (!ids.has(id)) this.firstSeen.delete(id)
    this.tick(rows)
  }

  /** One evaluation. Returns the slots it asked for (tests). */
  tick(rows?: ScheduleRow[]): string[] {
    const now = this.d.now()
    let list: ScheduleRow[]
    try {
      list = rows ?? this.d.schedules()
    } catch (e) {
      this.d.log.warn('triggers: schedules unavailable', { error: String(e) })
      return []
    }
    const asked: string[] = []
    for (const s of list) {
      if (!s.enabled || s.target?.kind !== 'workflow') continue
      if (tooFrequent(s.when, now)) {
        if (!this.warned.has(s.id)) this.d.log.warn('triggers: schedule fires more often than every 5 minutes; skipped', { scheduleId: s.id })
        this.warned.add(s.id)
        continue
      }
      const last = s.lastFireAt ? Date.parse(s.lastFireAt) : NaN
      if (!Number.isFinite(last) && !this.firstSeen.has(s.id)) this.firstSeen.set(s.id, now.getTime())
      const since = new Date(Number.isFinite(last) ? last : this.firstSeen.get(s.id)!)
      const slot = dueSlot(s.when, since, now)
      if (!slot) continue
      const iso = slot.toISOString()
      const key = `${s.id}|${iso}`
      if (this.fired.has(key)) continue
      this.fired.add(key)
      let runId: string | null = null
      try {
        const r = this.d.requestRun({ scheduleId: s.id, companyId: s.companyId, slot: iso, workflowId: s.target.workflowId, inputs: s.target.inputs ?? {} })
        runId = r.runId
        if (r.refused) this.d.log.info('triggers: schedule fire refused', { scheduleId: s.id, slot: iso, reason: r.refused })
      } catch (e) {
        this.d.log.warn('triggers: schedule fire failed', { scheduleId: s.id, slot: iso, error: String(e) })
      }
      try {
        this.d.markFired(s.id, iso, runId)
      } catch (e) {
        this.d.log.warn('triggers: mark fired failed', { scheduleId: s.id, error: String(e) })
      }
      asked.push(key)
    }
    // keep the dedupe set small: slots older than the catch-up window can never be due again
    if (this.fired.size > 5_000) for (const k of [...this.fired]) if (Date.parse(k.split('|')[1]!) < now.getTime() - CATCHUP_MAX_AGE_MS) this.fired.delete(k)
    return asked
  }
}
