import { describe, expect, it } from 'vitest'
import { defaultForm, formToWhen, isoToLocalInput, localInputToIso, whenToForm } from './schedule'

const base = defaultForm(new Date('2026-10-15T10:00:00'))

describe('formToWhen', () => {
  it('builds weekday/daily/hourly crons with the given tz', () => {
    expect(formToWhen({ ...base, kind: 'weekdays', time: '9:05' }, 'Europe/Madrid')).toEqual({
      ok: true,
      when: { kind: 'cron', cron: '5 9 * * 1-5', tz: 'Europe/Madrid' },
      preset: { kind: 'weekdays', time: '09:05' }
    })
    const daily = formToWhen({ ...base, kind: 'daily', time: '21:00' }, 'UTC')
    expect(daily.ok && daily.when).toEqual({ kind: 'cron', cron: '0 21 * * *', tz: 'UTC' })
    const hourly = formToWhen({ ...base, kind: 'hourly', minute: 15 }, 'UTC')
    expect(hourly.ok && hourly.when).toEqual({ kind: 'cron', cron: '15 * * * *', tz: 'UTC' })
  })
  it('rejects intervals under 5 minutes (S1) and bad times', () => {
    expect(formToWhen({ ...base, kind: 'everyNMinutes', n: 1 })).toEqual({ ok: false, error: 'Minimum interval is 5 minutes' })
    const ok = formToWhen({ ...base, kind: 'everyNMinutes', n: 15 }, 'UTC')
    expect(ok.ok && ok.when).toEqual({ kind: 'cron', cron: '*/15 * * * *', tz: 'UTC' })
    expect(formToWhen({ ...base, kind: 'daily', time: '25:00' }).ok).toBe(false)
    expect(formToWhen({ ...base, kind: 'cron', cron: '* * *' }).ok).toBe(false)
  })
  it('normalizes custom cron whitespace', () => {
    const r = formToWhen({ ...base, kind: 'cron', cron: '  0   9 * *  1-5 ' }, 'UTC')
    expect(r.ok && r.when).toEqual({ kind: 'cron', cron: '0 9 * * 1-5', tz: 'UTC' })
  })
  it('round-trips a one-off datetime', () => {
    const local = '2026-10-16T09:30'
    const iso = localInputToIso(local)!
    expect(isoToLocalInput(iso)).toBe(local)
    const r = formToWhen({ ...base, kind: 'once', at: local })
    expect(r.ok && r.when).toEqual({ kind: 'at', at: iso })
    expect(formToWhen({ ...base, kind: 'once', at: '' }).ok).toBe(false)
  })
})

describe('whenToForm', () => {
  it('restores the preset used to create the schedule', () => {
    expect(whenToForm({ kind: 'cron', cron: '0 9 * * 1-5', tz: 'UTC' }, { kind: 'weekdays', time: '09:00' }).kind).toBe('weekdays')
    expect(whenToForm({ kind: 'cron', cron: '*/10 * * * *', tz: 'UTC' }, { kind: 'everyNMinutes', n: 10 }).n).toBe(10)
    const raw = whenToForm({ kind: 'cron', cron: '0 0 1 * *', tz: 'UTC' }, null)
    expect(raw.kind).toBe('cron')
    expect(raw.cron).toBe('0 0 1 * *')
    expect(whenToForm({ kind: 'at', at: '2026-10-16T07:30:00.000Z' }, null).kind).toBe('once')
  })
})
