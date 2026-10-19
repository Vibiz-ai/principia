import { describe, expect, it } from 'vitest'
import { bytes, dayLabel, duration, relative, span } from './time'

const now = new Date('2026-10-15T12:00:00Z').getTime()

describe('time', () => {
  it('formats relative times under 24 h, absolute otherwise', () => {
    expect(relative(new Date(now + 41 * 60_000).toISOString(), now)).toBe('in 41m')
    expect(relative(new Date(now - 14 * 60_000).toISOString(), now)).toBe('14m ago')
    expect(relative(new Date(now - 10_000).toISOString(), now)).toBe('just now')
    expect(relative(null, now)).toBe('—')
    expect(relative(new Date(now - 3 * 86_400_000).toISOString(), now)).toMatch(/^Oct 12 \d\d:\d\d$/)
  })
  it('formats spans and durations', () => {
    expect(span(45_000)).toBe('45s')
    expect(span(3 * 3_600_000)).toBe('3h')
    expect(duration('2026-10-15T12:00:00Z', '2026-10-15T12:02:10Z')).toBe('2m10s')
    expect(duration('2026-10-15T12:00:00Z', '2026-10-15T13:04:00Z')).toBe('1h04m')
    expect(duration(null, null)).toBe('—')
    expect(duration('2026-10-15T12:00:00Z', '2026-10-15T12:00:00.400Z')).toBe('<1s')
    expect(duration('2026-10-15T12:00:00Z', '2026-10-15T12:00:12Z')).toBe('12s')
    expect(duration('2026-10-15T12:00:00Z', '2026-10-15T12:04:02Z')).toBe('4m02s')
  })
  it('groups by day and formats bytes', () => {
    const today = new Date('2026-10-15T15:00:00')
    expect(dayLabel(new Date('2026-10-15T08:00:00').toISOString(), today)).toBe('Today')
    expect(dayLabel(new Date('2026-10-14T08:00:00').toISOString(), today)).toBe('Yesterday')
    expect(dayLabel(new Date('2026-10-12T08:00:00').toISOString(), today)).toBe('Oct 12')
    expect(bytes(512)).toBe('512 B')
    expect(bytes(2048)).toBe('2.0 KB')
    expect(bytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
