import { describe, expect, it } from 'vitest'
import type { Run, RunTarget, Schedule, ScheduleWhen } from '../../../shared/types'
import { createScheduler, describeWhen, previewWhen } from '../scheduler'
import { MemStore } from './fakes'

const NOW = new Date('2026-10-15T10:00:30.000Z')
const target: RunTarget = { kind: 'prompt', profileId: 'p', repoId: null, prompt: 'x' }

function sched(id: string, when: ScheduleWhen, x: Partial<Schedule> = {}): Schedule {
  return {
    id,
    name: id,
    target,
    when,
    preset: null,
    enabled: true,
    sentence: '',
    lastFireAt: null,
    lastRunId: null,
    lastRunStatus: null,
    nextFireAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...x
  }
}

function setup(paused = false) {
  const store = new MemStore()
  const clock = { now: NOW }
  const started: { target: RunTarget; trigger: string; scheduleId: string | null }[] = []
  const active = new Set<string>()
  let n = 0
  const s = createScheduler({
    store,
    startRun: (t, o) => {
      started.push({ target: t, trigger: o.trigger, scheduleId: o.scheduleId ?? null })
      return { id: `r_${++n}` } as Run
    },
    isScheduleActive: (id) => active.has(id),
    emit: () => {},
    log: { info: () => {}, warn: () => {} },
    now: () => clock.now,
    paused
  })
  return { store, clock, started, active, s }
}

const UTC_CRON = (cron: string): ScheduleWhen => ({ kind: 'cron', cron, tz: 'UTC' })

describe('preview / describe', () => {
  it('validates cron fields, tz and the 5 minute minimum', () => {
    expect(previewWhen(UTC_CRON('*/1 * * * *'), NOW).error).toBe('Minimum interval is 5 minutes')
    expect(previewWhen(UTC_CRON('0,1 9 * * *'), NOW).error).toBe('Minimum interval is 5 minutes')
    expect(previewWhen(UTC_CRON('* * *'), NOW).error).toMatch(/5 fields/)
    expect(previewWhen({ kind: 'cron', cron: '0 9 * * *', tz: 'Mars/Base' }, NOW).error).toMatch(/time zone/)
    expect(previewWhen({ kind: 'at', at: '2026-10-15T09:00:00.000Z' }, NOW).error).toMatch(/past/)
    const ok = previewWhen(UTC_CRON('*/5 * * * *'), NOW)
    expect(ok.ok).toBe(true)
    expect(ok.next).toEqual(['2026-10-15T10:05:00.000Z', '2026-10-15T10:10:00.000Z', '2026-10-15T10:15:00.000Z'])
  })

  it('is timezone aware', () => {
    const p = previewWhen({ kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' }, NOW)
    expect(p.next[0]).toBe('2026-10-16T07:00:00.000Z') // 09:00 CEST = 07:00Z, Friday
    expect(p.next[1]).toBe('2026-10-19T07:00:00.000Z') // skips the weekend
    expect(p.sentence).toBe('Every weekday at 9:00 (Europe/Madrid)')
  })

  it('describes presets in plain words', () => {
    expect(describeWhen(UTC_CRON('30 7 * * *'))).toBe('Every day at 7:30 (UTC)')
    expect(describeWhen(UTC_CRON('0 * * * *'))).toBe('Every hour (UTC)')
    expect(describeWhen(UTC_CRON('15 * * * *'))).toBe('Every hour at :15 (UTC)')
    expect(describeWhen(UTC_CRON('*/10 * * * *'))).toBe('Every 10 minutes (UTC)')
    expect(describeWhen(UTC_CRON('0 18 * * 5'))).toBe('Every Friday at 18:00 (UTC)')
    expect(describeWhen(UTC_CRON('5 4 1 * *'))).toBe('Monthly on day 1 at 4:05 (UTC)')
    expect(describeWhen({ kind: 'at', at: '2026-10-16T09:00:00.000Z' })).toMatch(/^Once on /)
  })
})

describe('scheduler', () => {
  it('upsert computes nextFireAt; disabled -> null', () => {
    const { store, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('0 9 * * *')))
    expect(s.upsert('a').nextFireAt).toBe('2026-10-16T09:00:00.000Z')
    store.schedules.set('a', { ...store.schedules.get('a')!, enabled: false })
    expect(s.upsert('a').nextFireAt).toBeNull()
  })

  it('tick fires a due slot once and advances', () => {
    const { store, clock, started, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('0 10 * * *'), { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    s.tick()
    s.tick()
    expect(started).toHaveLength(1)
    expect(started[0].trigger).toBe('schedule')
    const a = store.schedules.get('a')!
    expect(a.lastFireAt).toBe('2026-10-15T10:00:00.000Z')
    expect(a.lastRunId).toBe('r_1')
    expect(a.nextFireAt).toBe('2026-10-16T10:00:00.000Z')
    expect(store.events.map((e) => e.kind)).toEqual(['fired'])
    clock.now = new Date('2026-10-16T10:00:05.000Z')
    s.tick()
    expect(started).toHaveLength(2)
  })

  it('S5: overlap is skipped, not queued', () => {
    const { store, started, active, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('0 10 * * *'), { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    active.add('a')
    s.tick()
    expect(started).toHaveLength(0)
    expect(store.events[0].kind).toBe('skipped_overlap')
    expect(store.schedules.get('a')!.nextFireAt).toBe('2026-10-16T10:00:00.000Z')
    expect(() => s.runNow('a')).toThrow(/still running/)
  })

  it('S3/S7: disabled and paused schedules do not fire; nextRuns empty while paused', () => {
    const { store, started, s } = setup(true)
    store.schedules.set('a', sched('a', UTC_CRON('0 10 * * *'), { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    store.schedules.set('b', sched('b', UTC_CRON('0 10 * * *'), { enabled: false, nextFireAt: '2026-10-15T10:00:00.000Z' }))
    s.tick()
    s.catchUp('resume')
    expect(started).toHaveLength(0)
    expect(s.nextRuns(5)).toEqual([])
    s.setPaused(false) // deliberate pause: skip what passed, no catch-up
    expect(store.schedules.get('a')!.nextFireAt).toBe('2026-10-16T10:00:00.000Z')
    s.tick()
    expect(started).toHaveLength(0)
    expect(s.nextRuns(5)).toEqual([{ scheduleId: 'a', name: 'a', at: '2026-10-16T10:00:00.000Z' }])
  })

  it('S4: hourly+ schedule missed < 12 h ago catches up exactly once', () => {
    const { store, started, s } = setup()
    // daily 07:00 missed (Mac asleep), now 10:00:30 -> 3 h old
    store.schedules.set('a', sched('a', UTC_CRON('0 7 * * *'), { nextFireAt: '2026-10-15T07:00:00.000Z' }))
    s.catchUp('launch')
    s.catchUp('resume')
    s.tick()
    expect(started).toHaveLength(1)
    expect(started[0].trigger).toBe('catchup')
    expect(store.events.map((e) => e.kind)).toEqual(['caught_up'])
    expect(store.schedules.get('a')!.nextFireAt).toBe('2026-10-16T07:00:00.000Z')
  })

  it('S4: hourly schedule missed many slots runs only the newest', () => {
    const { store, started, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('0 * * * *'), { nextFireAt: '2026-10-15T04:00:00.000Z' }))
    s.catchUp('resume')
    expect(started).toHaveLength(1)
    expect(store.events[0].slotAt).toBe('2026-10-15T10:00:00.000Z')
  })

  it('S4: newest missed slot > 12 h old -> missed event, no run', () => {
    const { store, started, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('0 9 * * 1'), { nextFireAt: '2026-10-12T09:00:00.000Z' }))
    s.catchUp('launch')
    expect(started).toHaveLength(0)
    expect(store.events[0].kind).toBe('missed')
    expect(store.schedules.get('a')!.nextFireAt).toBe('2026-10-19T09:00:00.000Z')
  })

  it('sub-hourly schedules never catch up: one missed event with the slot count', () => {
    const { store, started, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('*/5 * * * *'), { nextFireAt: '2026-10-15T09:00:00.000Z' }))
    s.catchUp('resume')
    expect(started).toHaveLength(0)
    expect(store.events).toHaveLength(1)
    expect(store.events[0].kind).toBe('missed')
    expect(store.events[0].message).toBe('13 slots missed while asleep')
    expect(store.schedules.get('a')!.nextFireAt).toBe('2026-10-15T10:05:00.000Z')
  })

  it('a late tick (sleep without resume event) applies the missed rule too', () => {
    const { store, started, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('*/5 * * * *'), { nextFireAt: '2026-10-15T09:30:00.000Z' }))
    s.tick()
    expect(started).toHaveLength(0)
    expect(store.events[0].kind).toBe('missed')
  })

  it('one-off: fires then disables itself; missed > 12 h -> missed + disabled', () => {
    const { store, started, s } = setup()
    store.schedules.set('a', sched('a', { kind: 'at', at: '2026-10-15T10:00:00.000Z' }, { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    store.schedules.set('b', sched('b', { kind: 'at', at: '2026-10-14T08:00:00.000Z' }, { nextFireAt: '2026-10-14T08:00:00.000Z' }))
    s.catchUp('launch')
    expect(started).toHaveLength(1)
    expect(store.schedules.get('a')).toMatchObject({ enabled: false, nextFireAt: null, lastRunId: 'r_1' })
    // missed while quit (even by seconds) = caught up, not a regular fire
    expect(store.events.find((e) => e.scheduleId === 'a')!.kind).toBe('caught_up')
    expect(started[0].trigger).toBe('catchup')
    expect(store.schedules.get('b')).toMatchObject({ enabled: false, nextFireAt: null })
    expect(store.events.find((e) => e.scheduleId === 'b')!.kind).toBe('missed')
  })

  it('runNow fires regardless of time with trigger manual and logs an event', () => {
    const { store, started, s } = setup(true)
    store.schedules.set('a', sched('a', UTC_CRON('0 9 * * *'), { enabled: false }))
    const r = s.runNow('a')
    expect(r.id).toBe('r_1')
    expect(started[0]).toMatchObject({ trigger: 'manual', scheduleId: 'a' })
    expect(store.events[0].kind).toBe('fired')
  })

  it('a start error is logged as an error event and the schedule moves on', () => {
    const store = new MemStore()
    const s = createScheduler({
      store,
      startRun: () => {
        throw new Error('Workflow wf_x not found')
      },
      isScheduleActive: () => false,
      emit: () => {},
      log: { info: () => {}, warn: () => {} },
      now: () => NOW,
      paused: false
    })
    store.schedules.set('a', sched('a', UTC_CRON('0 10 * * *'), { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    s.tick()
    expect(store.events[0]).toMatchObject({ kind: 'error', message: 'Workflow wf_x not found' })
    expect(store.schedules.get('a')!.nextFireAt).toBe('2026-10-16T10:00:00.000Z')
  })
})

describe('skipNext (LIVE.md §8)', () => {
  it('skips the next slot, logs skipped, never fires it on tick or catch-up, idempotent', () => {
    const { store, clock, started, s } = setup()
    store.schedules.set('a', sched('a', UTC_CRON('0 11 * * *'), { nextFireAt: '2026-10-15T11:00:00.000Z' }))
    const u = s.skipNext('a')
    expect(u.skipSlotAt).toBe('2026-10-15T11:00:00.000Z')
    expect(u.nextFireAt).toBe('2026-10-16T11:00:00.000Z')
    expect(store.events.map((e) => [e.kind, e.message])).toEqual([['skipped', 'Skipped by you']])
    // a recompute (upsert) never brings the skipped slot back
    expect(s.upsert('a').nextFireAt).toBe('2026-10-16T11:00:00.000Z')
    // the skipped slot passes: neither tick nor catch-up fires it
    clock.now = new Date('2026-10-15T11:00:10.000Z')
    s.tick()
    s.catchUp('resume')
    expect(started).toHaveLength(0)
    // a stale row whose nextFireAt still points at the skipped slot is stepped over, not fired
    store.schedules.set('b', sched('b', UTC_CRON('0 11 * * *'), { nextFireAt: '2026-10-15T11:00:00.000Z', skipSlotAt: '2026-10-15T11:00:00.000Z' }))
    s.tick()
    expect(started).toHaveLength(0)
    expect(store.schedules.get('b')!.nextFireAt).toBe('2026-10-16T11:00:00.000Z')
  })
  it('one-off: skipping disables it; nothing to skip -> conflict', () => {
    const { store, s } = setup()
    store.schedules.set('o', sched('o', { kind: 'at', at: '2026-10-15T12:00:00.000Z' }, { nextFireAt: '2026-10-15T12:00:00.000Z' }))
    expect(s.skipNext('o')).toMatchObject({ enabled: false, nextFireAt: null })
    expect(() => s.skipNext('o')).toThrow(/no upcoming run/)
  })
})

describe('five doors A4: one paused company', () => {
  it("a paused company's slot is skipped (logged), another company's fires; Run now refuses", () => {
    const store = new MemStore()
    const started: string[] = []
    const s = createScheduler({
      store,
      startRun: (_t, o) => {
        started.push(o.scheduleId ?? '')
        return { id: `r_${started.length}` } as Run
      },
      isScheduleActive: () => false,
      emit: () => {},
      log: { info: () => {}, warn: () => {} },
      now: () => NOW,
      paused: false,
      companyPaused: (sch) => (sch.id === 'harbor' ? 'Harbor Dental Group' : null)
    })
    store.schedules.set('harbor', sched('harbor', UTC_CRON('0 10 * * *'), { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    store.schedules.set('ledgerly', sched('ledgerly', UTC_CRON('0 10 * * *'), { nextFireAt: '2026-10-15T10:00:00.000Z' }))
    s.tick()
    expect(started).toEqual(['ledgerly'])
    expect(store.events.find((e) => e.scheduleId === 'harbor')).toMatchObject({ kind: 'skipped', message: 'Harbor Dental Group is paused' })
    expect(store.schedules.get('harbor')!.nextFireAt).toBe('2026-10-16T10:00:00.000Z')
    expect(() => s.fireNow('harbor')).toThrow(/Harbor Dental Group is paused/)
  })
})
