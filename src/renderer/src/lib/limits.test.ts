import { describe, expect, it } from 'vitest'
import { isRateLimited, isStalled, limitLine, resetClock, retryAtResetLabel, retryLabel, stalledMinutes } from './live'

const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo, d, h, mi)

describe('usage limit + stalled helpers', () => {
  const now = at(2026, 9, 16, 11, 30)
  it('resetClock: same day -> HH:MM, else weekday', () => {
    expect(resetClock(at(2026, 9, 16, 15, 0).toISOString(), now)).toBe('15:00')
    expect(resetClock(at(2026, 9, 20, 9, 5).toISOString(), now)).toBe('Tue 09:05')
    expect(resetClock('nope', now)).toBe('')
  })
  it('limitLine with and without a reset time', () => {
    expect(limitLine({ resetAt: at(2026, 9, 16, 15, 0).toISOString() }, now)).toBe('Hit usage limit · resets 15:00')
    expect(limitLine({ resetAt: null }, now)).toBe('Hit usage limit')
    expect(limitLine({}, now)).toBe('Hit usage limit')
  })
  it('retry labels', () => {
    expect(retryLabel(at(2026, 9, 16, 15, 1).toISOString(), now)).toBe('Retry scheduled 15:01')
    expect(retryAtResetLabel('x')).toBe('Retry at reset')
    expect(retryAtResetLabel(null)).toBe('Retry in 1 h')
  })
  it('isStalled only for live agents with stalledSince', () => {
    expect(isStalled({ status: 'working', stalledSince: now.toISOString() })).toBe(true)
    expect(isStalled({ status: 'working', stalledSince: null })).toBe(false)
    expect(isStalled({ status: 'failed', stalledSince: now.toISOString() })).toBe(false)
    expect(isStalled(null)).toBe(false)
  })
  it('stalledMinutes counts the threshold plus time since flagged', () => {
    expect(stalledMinutes({ stalledSince: new Date(now.getTime() - 5 * 60_000).toISOString() }, 10, now.getTime())).toBe(15)
    expect(stalledMinutes({ stalledSince: null }, 10)).toBe(10)
  })
  it('isRateLimited', () => {
    expect(isRateLimited({ stopReason: 'rate_limited' })).toBe(true)
    expect(isRateLimited({ stopReason: null })).toBe(false)
    expect(isRateLimited(undefined)).toBe(false)
  })
})
