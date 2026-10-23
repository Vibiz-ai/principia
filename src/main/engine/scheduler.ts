/**
 * Hive's own scheduler (SPEC 8, A13). 15 s tick against schedules.next_fire_at; croner for cron math;
 * catch-up on launch / wake; no overlapping runs per schedule; one-offs disable themselves after firing.
 *
 * DEPARTMENTS.md §8: a schedule with target.mode 'task' starts no run. It owns one standing board card
 * "Recurring: <name>" (SchedulerDeps.board, implemented by main over the company board); each fire comments on it and
 * wakes its agent, and a fire while the agent is busy coalesces into the card's pendingWake (never skipped_overlap,
 * which stays for 'run' mode). Its catch-up is skip_missed: a slot that passed while Hive was quit or the Mac slept is
 * logged 'missed', never fired late.
 */
import { Cron } from 'croner'
import type { EngineStore, StartRunOptions } from '../../shared/engine'
import { HiveError } from '../../shared/errors'
import type {
  EngineEvent,
  Id,
  NextFire,
  Run,
  RunTarget,
  Schedule,
  ScheduleEventKind,
  SchedulePreview,
  ScheduleWhen
} from '../../shared/types'

/** What one task-mode fire did to the schedule's standing card. */
export interface ScheduleCardResult {
  taskId: Id
  identifier: string
  /** the card did not exist yet (first fire, or the card was deleted) */
  created: boolean
  /** the agent was busy on the card: the fire joined its pendingWake */
  coalesced: boolean
  /** the card waits for the human (in review, parked) or is closed: the wake is queued, nothing starts now */
  waiting: string | null
}
/** DEPARTMENTS.md §8: the board side of task-mode schedules. Implemented by main (company/recurring.ts). */
export interface ScheduleBoard {
  /** experimental.companies + .departments; off, a task-mode fire is an 'error' event */
  enabled(): boolean
  /**
   * Finds the schedule's standing card by its source key (creates it on the first fire, assigned to target.agentId in
   * schedule.departmentId), adds one comment for this fire and wakes the agent once (the dispatcher coalesces it when
   * the card is in flight). Throws when the card cannot be written.
   */
  fire(s: Schedule, f: { slotAt: string; trigger: 'schedule' | 'catchup' | 'manual'; label: string }): ScheduleCardResult
}
/** Scheduler.fireNow: a run ('run' mode) or the standing card it woke ('task' mode). */
export type ScheduleFireResult = { run: Run; card: null } | { run: null; card: ScheduleCardResult }

export const isTaskMode = (s: Pick<Schedule, 'target'>): boolean => s.target?.mode === 'task'
/** The schedule event message of a task-mode fire. Pure. */
export function cardMessage(r: ScheduleCardResult): string {
  const verb = r.created ? `Created ${r.identifier}` : r.coalesced ? `Coalesced into ${r.identifier} (agent busy)` : `Commented on ${r.identifier}`
  return `${verb}${r.waiting ? `; ${r.waiting}` : ''}`
}

export const TICK_MS = 15_000
export const MIN_INTERVAL_MS = 5 * 60_000
export const CATCHUP_MIN_INTERVAL_MS = 60 * 60_000
export const CATCHUP_MAX_AGE_MS = 12 * 60 * 60_000
/** A slot found this late by a tick is treated as missed (Mac slept without a resume event, etc). */
export const LATE_MS = 2 * 60_000

export interface SchedulerDeps {
  store: EngineStore
  startRun(target: RunTarget, opts: StartRunOptions): Run
  /** CONTRACT §13 "Retry at reset": rerun a run (trigger 'rerun', parentRunId = it). Absent = retries off. */
  rerun?(r: Run): Run
  isScheduleActive(scheduleId: Id): boolean
  /** DEPARTMENTS.md §8: task-mode schedules. Absent = a task-mode fire is an 'error' event. */
  board?: ScheduleBoard | null
  emit(e: EngineEvent): void
  log: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now(): Date
  paused: boolean
}

// ---------- pure helpers ----------

const systemTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function cronOf(when: Extract<ScheduleWhen, { kind: 'cron' }>): Cron {
  return new Cron(when.cron.trim(), { timezone: when.tz, paused: true })
}

/** Next fire strictly after `from`, or null. */
export function nextFire(when: ScheduleWhen, from: Date): Date | null {
  if (when.kind === 'at') {
    const t = new Date(when.at)
    return Number.isFinite(t.getTime()) && t.getTime() > from.getTime() ? t : null
  }
  try {
    return cronOf(when).nextRun(from)
  } catch {
    return null
  }
}

/** Smallest gap between upcoming fires (ms); Infinity for one-offs. */
export function minInterval(when: ScheduleWhen, from: Date, samples = 40): number {
  if (when.kind === 'at') return Infinity
  const runs = cronOf(when).nextRuns(samples, from)
  let min = Infinity
  for (let i = 1; i < runs.length; i++) min = Math.min(min, runs[i].getTime() - runs[i - 1].getTime())
  return min
}

const pad = (n: number): string => String(n).padStart(2, '0')
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Pure: slot time in the schedule's tz, "09:00" if same local day as `now`, else "Mon 09:00". */
export function slotLabel(slot: Date, when: ScheduleWhen, now: Date): string {
  const tz = when.kind === 'cron' && validTz(when.tz) ? when.tz : systemTz()
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(slot)
  const day = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  if (day(slot) === day(now)) return hm
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(slot)
  return `${wd} ${hm}`
}

/** Human sentence for a when-spec, e.g. "Every weekday at 9:00 (Europe/Madrid)". Pure. */
export function describeWhen(when: ScheduleWhen): string {
  if (when.kind === 'at') {
    const d = new Date(when.at)
    if (!Number.isFinite(d.getTime())) return 'Once (invalid date)'
    const tz = systemTz()
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(d)
    return `Once on ${s} (${tz})`
  }
  const tz = ` (${when.tz})`
  const f = when.cron.trim().split(/\s+/)
  if (f.length !== 5) return `Cron "${when.cron.trim()}"${tz}`
  const [mi, h, dom, mon, dow] = f
  const isNum = (x: string): boolean => /^\d+$/.test(x)
  const time = isNum(mi) && isNum(h) ? `${Number(h)}:${pad(Number(mi))}` : null
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${time}${tz}`
    if (dow === '1-5' || dow === 'MON-FRI' || dow === 'mon-fri') return `Every weekday at ${time}${tz}`
    if (dow === '0,6' || dow === '6,0') return `Every weekend day at ${time}${tz}`
    if (isNum(dow) && Number(dow) <= 7) return `Every ${DAYS[Number(dow) % 7]} at ${time}${tz}`
  }
  if (time && isNum(dom) && mon === '*' && dow === '*') return `Monthly on day ${Number(dom)} at ${time}${tz}`
  if (isNum(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*')
    return Number(mi) === 0 ? `Every hour${tz}` : `Every hour at :${pad(Number(mi))}${tz}`
  const every = mi.match(/^(?:\*|0)\/(\d+)$/)
  if (every && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${Number(every[1])} minutes${tz}`
  const everyH = h.match(/^(?:\*|0)\/(\d+)$/)
  if (isNum(mi) && everyH && dom === '*' && mon === '*' && dow === '*')
    return `Every ${Number(everyH[1])} hours at :${pad(Number(mi))}${tz}`
  return `Cron "${f.join(' ')}"${tz}`
}

export function previewWhen(when: ScheduleWhen, now: Date): SchedulePreview {
  const bad = (error: string): SchedulePreview => ({ ok: false, sentence: '', next: [], error })
  if (!when || typeof when !== 'object') return bad('Pick when it should run')
  if (when.kind === 'at') {
    const t = new Date(when.at)
    if (!Number.isFinite(t.getTime())) return bad('Pick a valid date and time')
    if (t.getTime() <= now.getTime()) return bad('That time is in the past')
    return { ok: true, sentence: describeWhen(when), next: [t.toISOString()], error: null }
  }
  if (when.kind !== 'cron') return bad('Unknown schedule kind')
  const fields = (when.cron ?? '').trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) return bad('Cron must have 5 fields: minute hour day-of-month month day-of-week')
  if (!when.tz || !validTz(when.tz)) return bad(`Unknown time zone "${when.tz ?? ''}"`)
  let next: Date[]
  try {
    next = cronOf(when).nextRuns(3, now)
  } catch (e) {
    return bad(`Invalid cron: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!next.length) return bad('This cron never fires')
  if (minInterval(when, now) < MIN_INTERVAL_MS) return bad('Minimum interval is 5 minutes')
  return { ok: true, sentence: describeWhen(when), next: next.map((d) => d.toISOString()), error: null }
}

// ---------- stateful scheduler ----------

export interface Scheduler {
  start(): void
  stop(): void
  tick(): void
  /** CONTRACT §13: fire due one-off retries now (also part of every tick). */
  fireRetries(): void
  upsert(id: Id): Schedule
  remove(id: Id): void
  /** 'run' mode only; a task-mode schedule refuses (use fireNow). */
  runNow(id: Id): Run
  /** "Run now" for either mode: starts the run, or comments on and wakes the standing card. */
  fireNow(id: Id): ScheduleFireResult
  nextRuns(limit: number): NextFire[]
  setPaused(paused: boolean): void
  isPaused(): boolean
  catchUp(reason: 'launch' | 'resume'): void
  /** LIVE.md §8: skip the next slot (never fired by tick or catch-up), log 'skipped'. */
  skipNext(id: Id): Schedule
}

/** True when `slot` is the schedule's skipped slot. */
const isSkipped = (s: Schedule, slot: Date | null): boolean =>
  !!slot && !!s.skipSlotAt && Date.parse(s.skipSlotAt) === slot.getTime()

/** Next fire strictly after `from`, stepping over the skipped slot. */
export function nextAllowed(s: Schedule, from: Date): Date | null {
  const n = nextFire(s.when, from)
  return isSkipped(s, n) ? nextFire(s.when, n!) : n
}

export function createScheduler(d: SchedulerDeps): Scheduler {
  let paused = d.paused
  let timer: NodeJS.Timeout | null = null
  const removed = new Set<Id>()

  const setState = (id: Id, patch: Parameters<EngineStore['setScheduleFireState']>[1]): Schedule => {
    const s = d.store.setScheduleFireState(id, patch)
    d.emit({ type: 'schedule.updated', schedule: s })
    return s
  }
  const event = (s: Schedule, kind: ScheduleEventKind, slotAt: Date, runId: Id | null, message: string | null): void => {
    const e = d.store.insertScheduleEvent({ scheduleId: s.id, kind, slotAt: slotAt.toISOString(), runId, message })
    d.emit({ type: 'schedule.event', event: e, scheduleName: s.name })
  }

  /** The standing card of a task-mode schedule, through the board. Throws when the board is off or the write fails. */
  const fireCard = (s: Schedule, slot: Date, trigger: 'schedule' | 'catchup' | 'manual'): ScheduleCardResult => {
    const board = d.board
    if (!board || !board.enabled())
      throw new HiveError('conflict', `"${s.name}" posts to the company board: turn on Companies and Departments under Settings → Experimental`)
    return board.fire(s, { slotAt: slot.toISOString(), trigger, label: slotLabel(slot, s.when, d.now()) })
  }

  /** Starts a run for a slot unless the previous one is still active. Persists fire-state + event. */
  const fire = (s: Schedule, slot: Date, trigger: 'schedule' | 'catchup', kind: 'fired' | 'caught_up'): void => {
    const now = d.now()
    const oneOff = s.when.kind === 'at'
    const after = { nextFireAt: oneOff ? null : nextAllowed(s, now)?.toISOString() ?? null, ...(oneOff ? { enabled: false } : {}) }
    if (isTaskMode(s)) {
      // no overlap check: a busy agent coalesces the fire into its card (DEPARTMENTS.md §8)
      try {
        const r = fireCard(s, slot, trigger)
        setState(s.id, { ...after, lastFireAt: slot.toISOString() })
        event(s, kind, slot, null, cardMessage(r))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        d.log.warn('scheduler: card fire failed', { scheduleId: s.id, error: msg })
        event(s, 'error', slot, null, msg)
        setState(s.id, { ...after, lastFireAt: slot.toISOString() })
      }
      return
    }
    if (d.isScheduleActive(s.id)) {
      event(s, 'skipped_overlap', slot, null, 'Previous run still active')
      setState(s.id, after)
      return
    }
    try {
      const run = d.startRun(s.target, { trigger, scheduleId: s.id })
      setState(s.id, { ...after, lastFireAt: slot.toISOString(), lastRunId: run.id })
      const msg = kind === 'caught_up' ? `Running missed "${s.name}" from ${slotLabel(slot, s.when, now)}` : null
      event(s, kind, slot, run.id, msg)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      d.log.warn('scheduler: fire failed', { scheduleId: s.id, error: msg })
      event(s, 'error', slot, null, msg)
      setState(s.id, { ...after, lastFireAt: slot.toISOString() })
    }
  }

  /** DEPARTMENTS.md §8: a task-mode schedule never fires a missed slot late (skip_missed): log it, move on. */
  const skipMissed = (s: Schedule, now: Date): void => {
    const first = new Date(s.nextFireAt!)
    if (s.when.kind === 'at') {
      event(s, 'missed', first, null, 'Missed while the Mac was asleep or Hive was not running; recurring tasks skip missed slots')
      setState(s.id, { nextFireAt: null, enabled: false })
      return
    }
    let newest = first
    let count = 1
    for (let cur = nextFire(s.when, first); cur && cur.getTime() <= now.getTime() && count < 100_000; cur = nextFire(s.when, cur)) {
      newest = cur
      count++
    }
    event(s, 'missed', newest, null, `${count === 1 ? 'Slot' : `${count} slots`} missed; recurring tasks skip missed slots`)
    setState(s.id, { nextFireAt: nextAllowed(s, now)?.toISOString() ?? null })
  }

  /** SPEC 8.2 / A13 for one schedule whose nextFireAt is in the past. */
  const handleMissed = (s: Schedule, now: Date): void => {
    if (isTaskMode(s)) return skipMissed(s, now)
    const first = new Date(s.nextFireAt!)
    if (s.when.kind === 'at') {
      if (now.getTime() - first.getTime() < CATCHUP_MAX_AGE_MS) return fire(s, first, 'catchup', 'caught_up')
      event(s, 'missed', first, null, 'Missed while the Mac was asleep or Hive was not running')
      setState(s.id, { nextFireAt: null, enabled: false })
      return
    }
    // enumerate missed slots (bounded)
    let newest = first
    let count = 1
    for (let cur = nextFire(s.when, first); cur && cur.getTime() <= now.getTime() && count < 100_000; cur = nextFire(s.when, cur)) {
      newest = cur
      count++
    }
    const interval = minInterval(s.when, first, 10)
    const age = now.getTime() - newest.getTime()
    if (interval >= CATCHUP_MIN_INTERVAL_MS && age < CATCHUP_MAX_AGE_MS) return fire(s, newest, 'catchup', 'caught_up')
    const msg =
      interval < CATCHUP_MIN_INTERVAL_MS
        ? `${count} slot${count === 1 ? '' : 's'} missed while asleep`
        : `${count === 1 ? 'Slot' : `${count} slots`} missed; newest is more than 12 h old`
    event(s, 'missed', newest, null, msg)
    setState(s.id, { nextFireAt: nextAllowed(s, now)?.toISOString() ?? null })
  }

  /** A skipped slot that somehow became due is never fired: move past it. */
  const passSkipped = (s: Schedule, slot: Date, now: Date): boolean => {
    if (!isSkipped(s, slot)) return false
    setState(s.id, { nextFireAt: s.when.kind === 'at' ? null : nextAllowed(s, now)?.toISOString() ?? null })
    return true
  }

  /**
   * CONTRACT §13: one-off retries ("Retry at reset", automatic retry of a rate-limited scheduled run). Fired by the
   * same tick; honours the pause; a retry found more than 12 h late (Hive was not running) is dropped, not fired.
   * Each run retries at most once: retryRunId is set when it fires.
   */
  const fireRetries = (now: Date): void => {
    if (!d.rerun || !d.store.listRetries) return
    let due: Run[] = []
    try {
      due = d.store.listRetries().filter((r) => r.retryAt && Date.parse(r.retryAt) <= now.getTime())
    } catch (e) {
      d.log.warn('scheduler: listRetries failed', { error: String(e) })
      return
    }
    for (const r of due) {
      if (r.status === 'queued' || r.status === 'running') continue
      try {
        if (now.getTime() - Date.parse(r.retryAt!) > CATCHUP_MAX_AGE_MS) {
          d.log.info('scheduler: retry dropped (more than 12 h late)', { runId: r.id, retryAt: r.retryAt })
          d.emit({ type: 'run.updated', run: d.store.updateRun(r.id, { retryAt: null }) })
          continue
        }
        const next = d.rerun(r)
        d.emit({ type: 'run.updated', run: d.store.updateRun(r.id, { retryRunId: next.id }) })
        d.log.info('scheduler: retry fired', { runId: r.id, retryRunId: next.id })
      } catch (e) {
        d.log.warn('scheduler: retry failed', { runId: r.id, error: String(e) })
        // never loop on a broken retry: drop it
        try {
          d.emit({ type: 'run.updated', run: d.store.updateRun(r.id, { retryAt: null }) })
        } catch {
          /* ignore */
        }
      }
    }
  }

  const tick = (): void => {
    if (paused) return
    const now = d.now()
    fireRetries(now)
    for (const s of d.store.listSchedules()) {
      if (!s.enabled || removed.has(s.id)) continue
      if (!s.nextFireAt) {
        // enabled but never computed (created while the engine was down)
        const n = nextAllowed(s, now)
        if (n || s.when.kind === 'cron') setState(s.id, { nextFireAt: n?.toISOString() ?? null })
        continue
      }
      const slot = new Date(s.nextFireAt)
      if (slot.getTime() > now.getTime()) continue
      if (passSkipped(s, slot, now)) continue
      try {
        if (now.getTime() - slot.getTime() > LATE_MS) handleMissed(s, now)
        else fire(s, slot, 'schedule', 'fired')
      } catch (e) {
        d.log.warn('scheduler: tick error', { scheduleId: s.id, error: String(e) })
      }
    }
  }

  const catchUp = (reason: 'launch' | 'resume'): void => {
    d.log.info('scheduler: catch-up', { reason, paused })
    if (paused) return
    const now = d.now()
    for (const s of d.store.listSchedules()) {
      if (!s.enabled || removed.has(s.id) || !s.nextFireAt) continue
      const slot = new Date(s.nextFireAt)
      if (slot.getTime() > now.getTime()) continue
      if (passSkipped(s, slot, now)) continue
      try {
        // Any slot already in the past at launch/resume passed while Hive was quit or the Mac slept: it is a
        // catch-up even when only seconds late, never a regular "fired".
        if (now.getTime() - slot.getTime() <= LATE_MS && !isTaskMode(s)) fire(s, slot, 'catchup', 'caught_up')
        else handleMissed(s, now)
      } catch (e) {
        d.log.warn('scheduler: catch-up error', { scheduleId: s.id, error: String(e) })
      }
    }
    tick()
  }

  /** After unpausing: skip everything that passed while paused (no catch-up for a deliberate pause). */
  const recomputeAll = (): void => {
    const now = d.now()
    for (const s of d.store.listSchedules()) {
      if (!s.enabled) continue
      const n = nextAllowed(s, now)
      if (s.when.kind === 'at' && !n) {
        if (s.nextFireAt) event(s, 'missed', new Date(s.when.at), null, 'Skipped while schedules were paused')
        setState(s.id, { nextFireAt: null, enabled: false })
      } else if ((n?.toISOString() ?? null) !== s.nextFireAt) setState(s.id, { nextFireAt: n?.toISOString() ?? null })
    }
  }

  const runNow = (id: Id): Run => {
    const s = d.store.getSchedule(id)
    if (!s) throw new HiveError('not_found', `Schedule ${id} not found`)
    if (isTaskMode(s)) throw new HiveError('conflict', `"${s.name}" posts to its board card instead of starting a run`)
    if (d.isScheduleActive(id)) throw new HiveError('conflict', `"${s.name}" is still running`)
    const now = d.now()
    const run = d.startRun(s.target, { trigger: 'manual', scheduleId: id })
    setState(id, { lastRunId: run.id })
    event(s, 'fired', now, run.id, 'Run now')
    return run
  }

  return {
    start() {
      if (process.env.HIVE_NO_SCHEDULER === '1' || timer) return
      catchUp('launch')
      timer = setInterval(tick, TICK_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    fireRetries: () => {
      if (!paused) fireRetries(d.now())
    },
    upsert(id) {
      removed.delete(id)
      const s = d.store.getSchedule(id)
      if (!s) throw new HiveError('not_found', `Schedule ${id} not found`)
      const n = s.enabled ? nextAllowed(s, d.now()) : null
      return setState(id, { nextFireAt: n?.toISOString() ?? null })
    },
    remove(id) {
      removed.add(id)
    },
    runNow,
    fireNow(id) {
      const s = d.store.getSchedule(id)
      if (!s) throw new HiveError('not_found', `Schedule ${id} not found`)
      if (!isTaskMode(s)) return { run: runNow(id), card: null }
      const now = d.now()
      const card = fireCard(s, now, 'manual')
      setState(id, { lastFireAt: now.toISOString() })
      event(s, 'fired', now, null, `Run now: ${cardMessage(card)}`)
      return { run: null, card }
    },
    nextRuns(limit) {
      if (paused) return []
      return d.store
        .listSchedules()
        .filter((s) => s.enabled && s.nextFireAt && !removed.has(s.id))
        .sort((a, b) => a.nextFireAt!.localeCompare(b.nextFireAt!))
        .slice(0, Math.max(0, limit))
        .map((s) => ({ scheduleId: s.id, name: s.name, at: s.nextFireAt! }))
    },
    setPaused(p) {
      if (paused === p) return
      paused = p
      if (!p) recomputeAll()
    },
    isPaused: () => paused,
    catchUp,
    skipNext(id) {
      const s = d.store.getSchedule(id)
      if (!s) throw new HiveError('not_found', `Schedule ${id} not found`)
      if (!s.enabled || !s.nextFireAt) throw new HiveError('conflict', `"${s.name}" has no upcoming run to skip`)
      const slot = new Date(s.nextFireAt)
      // already skipped this slot (or a later one): nothing to do
      if (s.skipSlotAt && Date.parse(s.skipSlotAt) >= slot.getTime()) return s
      const skipped: Schedule = { ...s, skipSlotAt: slot.toISOString() }
      const next = s.when.kind === 'at' ? null : nextAllowed(skipped, slot)
      const u = setState(id, {
        skipSlotAt: slot.toISOString(),
        nextFireAt: next?.toISOString() ?? null,
        ...(s.when.kind === 'at' ? { enabled: false } : {})
      })
      event(u, 'skipped', slot, null, 'Skipped by you')
      return u
    }
  }
}
