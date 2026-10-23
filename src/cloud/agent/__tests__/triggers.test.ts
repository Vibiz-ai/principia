import { describe, expect, it } from 'vitest'
import type { ScheduleRow } from '../../contract'
import { ScheduleLoop, dueSlot, tooFrequent } from '../triggers'
import { fakePorts } from './fakes'

const daily9: ScheduleRow['when'] = { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }
const row = (o: Partial<ScheduleRow> = {}): ScheduleRow => ({ id: 'sch_brief', companyId: 'co_acme', name: 'Morning brief', when: daily9, target: { kind: 'workflow', workflowId: 'wf_brief', inputs: { tone: 'short' } }, enabled: true, lastFireAt: null, ...o })

function loop(rows: () => ScheduleRow[], clock: { now: Date }) {
  const ports = fakePorts()
  const l = new ScheduleLoop({
    schedules: rows,
    requestRun: (r) => ports.requestRun({ companyId: r.companyId, trigger: 'schedule', target: { kind: 'workflow', workflowId: r.workflowId, inputs: r.inputs }, scheduleId: r.scheduleId, slot: r.slot }),
    markFired: (id, slot, runId) => ports.markScheduleFired(id, slot, runId),
    now: () => clock.now,
    log: ports.log
  })
  return { l, ports }
}

describe('cloud schedules', () => {
  it('dueSlot: newest due slot after `since`, only within 12 hours', () => {
    expect(dueSlot(daily9, new Date('2026-10-21T08:00:00Z'), new Date('2026-10-21T08:59:59Z'))).toBeNull()
    expect(dueSlot(daily9, new Date('2026-10-21T08:00:00Z'), new Date('2026-10-21T09:00:10Z'))!.toISOString()).toBe('2026-10-21T09:00:00.000Z')
    // three missed days collapse into the newest slot
    expect(dueSlot(daily9, new Date('2026-10-18T10:00:00Z'), new Date('2026-10-21T10:00:00Z'))!.toISOString()).toBe('2026-10-21T09:00:00.000Z')
    // a slot older than 12 hours is not caught up
    expect(dueSlot(daily9, new Date('2026-10-21T08:00:00Z'), new Date('2026-10-21T21:30:00Z'))).toBeNull()
  })

  it('fires a due slot once, with schedule trigger, slot and inputs; never twice across ticks', () => {
    const clock = { now: new Date('2026-10-21T08:59:00Z') }
    let rows = [row()]
    const { l, ports } = loop(() => rows, clock)
    expect(l.tick()).toEqual([])
    clock.now = new Date('2026-10-21T09:00:05Z')
    expect(l.tick()).toEqual(['sch_brief|2026-10-21T09:00:00.000Z'])
    expect(ports.rec.requests).toEqual([{ companyId: 'co_acme', trigger: 'schedule', target: { kind: 'workflow', workflowId: 'wf_brief', inputs: { tone: 'short' } }, scheduleId: 'sch_brief', slot: '2026-10-21T09:00:00.000Z' }])
    expect(ports.rec.fired).toEqual([{ scheduleId: 'sch_brief', slot: '2026-10-21T09:00:00.000Z', runId: 'crun_req1' }])
    // the control plane has not stored lastFireAt yet: still no second request
    clock.now = new Date('2026-10-21T09:00:20Z')
    expect(l.tick()).toEqual([])
    rows = [row({ lastFireAt: '2026-10-21T09:00:00.000Z' })]
    expect(l.tick()).toEqual([])
    expect(ports.rec.requests).toHaveLength(1)
  })

  it('after a restart: the stored lastFireAt prevents a double fire, and a missed slot under 12 h fires once', () => {
    const clock = { now: new Date('2026-10-22T09:05:00Z') }
    const fresh = loop(() => [row({ lastFireAt: '2026-10-22T09:00:00.000Z' })], clock)
    expect(fresh.l.tick()).toEqual([])
    // down from 08:00 to 11:00: the 09:00 slot fires once at boot
    const clock2 = { now: new Date('2026-10-23T11:00:00Z') }
    const boot = loop(() => [row({ lastFireAt: '2026-10-22T09:00:00.000Z' })], clock2)
    expect(boot.l.tick()).toEqual(['sch_brief|2026-10-23T09:00:00.000Z'])
    expect(boot.l.tick()).toEqual([])
  })

  it('a schedule never fired is not caught up before the runtime first saw it', () => {
    const clock = { now: new Date('2026-10-21T10:00:00Z') }
    const { l } = loop(() => [row()], clock)
    expect(l.tick()).toEqual([])
    clock.now = new Date('2026-10-22T09:00:01Z')
    expect(l.tick()).toEqual(['sch_brief|2026-10-22T09:00:00.000Z'])
  })

  it('honours the 5-minute floor, disabled schedules and one-offs', () => {
    expect(tooFrequent({ kind: 'cron', cron: '* * * * *', tz: 'UTC' }, new Date())).toBe(true)
    expect(tooFrequent({ kind: 'cron', cron: '*/5 * * * *', tz: 'UTC' }, new Date())).toBe(false)
    const clock = { now: new Date('2026-10-21T08:00:00Z') }
    const rows = [row({ id: 'fast', when: { kind: 'cron', cron: '* * * * *', tz: 'UTC' } }), row({ id: 'off', enabled: false }), row({ id: 'once', when: { kind: 'at', at: '2026-10-21T08:30:00Z' } })]
    const { l, ports } = loop(() => rows, clock)
    l.tick()
    clock.now = new Date('2026-10-21T09:10:00Z')
    expect(l.tick()).toEqual(['once|2026-10-21T08:30:00.000Z'])
    expect(ports.rec.logs.some((x) => x.msg.includes('5 minutes'))).toBe(true)
    expect(l.tick()).toEqual([])
  })

  it('a refused request is still marked, so the slot is never retried', () => {
    const clock = { now: new Date('2026-10-21T08:59:00Z') }
    const ports = fakePorts({ refuse: 'paused' })
    const l = new ScheduleLoop({ schedules: () => [row()], requestRun: () => ports.requestRun({ companyId: 'co_acme', trigger: 'schedule', target: { kind: 'workflow', workflowId: 'wf_brief' } }), markFired: (id, slot, runId) => ports.markScheduleFired(id, slot, runId), now: () => clock.now, log: ports.log })
    l.tick()
    clock.now = new Date('2026-10-21T09:00:01Z')
    l.tick()
    l.tick()
    expect(ports.rec.fired).toEqual([{ scheduleId: 'sch_brief', slot: '2026-10-21T09:00:00.000Z', runId: null }])
  })
})
