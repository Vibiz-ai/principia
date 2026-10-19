/** CONTRACT §13: "Stalled?" timing (fake clock): flag once after N silent minutes, clear on activity, never while waiting. */
import { describe, expect, it } from 'vitest'
import { StallMonitor, stallThresholdMs } from '../live/stall'

function setup(minutes = 10) {
  const clock = { t: Date.parse('2026-10-16T09:00:00.000Z') }
  let threshold = stallThresholdMs(minutes)
  const m = new StallMonitor({ thresholdMs: () => threshold, now: () => clock.t })
  const changes: (string | null)[] = []
  let waiting = false
  m.track('st_1', { onChange: (s) => changes.push(s), waiting: () => waiting })
  return {
    m,
    changes,
    advance: (ms: number) => (clock.t += ms),
    setWaiting: (w: boolean) => (waiting = w),
    setMinutes: (n: number) => (threshold = stallThresholdMs(n))
  }
}

describe('StallMonitor', () => {
  it('flags once after N minutes of silence, with the silence start as stalledSince', () => {
    const t = setup(10)
    t.advance(9 * 60_000 + 59_000)
    expect(t.m.sweep()).toEqual([])
    t.advance(1000)
    expect(t.m.sweep()).toEqual(['st_1'])
    expect(t.changes).toEqual(['2026-10-16T09:00:00.000Z'])
    // later sweeps do not notify again
    t.advance(30 * 60_000)
    expect(t.m.sweep()).toEqual([])
    expect(t.changes).toHaveLength(1)
    expect(t.m.isStalled('st_1')).toBe(true)
  })

  it('any activity clears it at once and restarts the window', () => {
    const t = setup(10)
    t.advance(10 * 60_000)
    t.m.sweep()
    t.m.touch('st_1')
    expect(t.changes).toEqual(['2026-10-16T09:00:00.000Z', null])
    t.advance(9 * 60_000)
    expect(t.m.sweep()).toEqual([])
    t.advance(60_000)
    expect(t.m.sweep()).toEqual(['st_1'])
    expect(t.changes[2]).toBe('2026-10-16T09:10:00.000Z')
  })

  it('activity before the threshold keeps it quiet', () => {
    const t = setup(1)
    for (let i = 0; i < 10; i++) {
      t.advance(50_000)
      t.m.touch('st_1')
      expect(t.m.sweep()).toEqual([])
    }
    expect(t.changes).toEqual([])
  })

  it('an owner waiting on the user is never stalled, and a standing stall clears when it starts waiting', () => {
    const t = setup(1)
    t.setWaiting(true)
    t.advance(30 * 60_000)
    expect(t.m.sweep()).toEqual([])
    t.setWaiting(false)
    // the window restarts when it stops waiting
    t.advance(30_000)
    expect(t.m.sweep()).toEqual([])
    t.advance(30_000)
    expect(t.m.sweep()).toEqual(['st_1'])
    t.setWaiting(true)
    t.m.sweep()
    expect(t.changes.at(-1)).toBeNull()
  })

  it('reads the threshold live and clamps it to 1..240 minutes', () => {
    const t = setup(10)
    t.advance(2 * 60_000)
    expect(t.m.sweep()).toEqual([])
    t.setMinutes(1)
    expect(t.m.sweep()).toEqual(['st_1'])
    expect(stallThresholdMs(0)).toBe(60_000)
    expect(stallThresholdMs(9999)).toBe(240 * 60_000)
    expect(stallThresholdMs(undefined)).toBe(10 * 60_000)
  })

  it('untrack clears a standing stall; unknown keys are ignored', () => {
    const t = setup(1)
    t.advance(60_000)
    t.m.sweep()
    t.m.untrack('st_1')
    expect(t.changes).toEqual(['2026-10-16T09:00:00.000Z', null])
    t.m.touch('nope')
    t.m.untrack('nope')
    expect(t.m.size()).toBe(0)
  })
})
