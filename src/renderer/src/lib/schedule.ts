import type { SchedulePreset, ScheduleWhen } from '@shared/types'

export type PresetKind = SchedulePreset['kind']

export const PRESET_LABELS: Record<PresetKind, string> = {
  weekdays: 'Every weekday at',
  daily: 'Every day at',
  hourly: 'Every hour',
  everyNMinutes: 'Every N minutes',
  once: 'Once at',
  cron: 'Custom cron'
}

/** Editable form state for the When picker. */
export interface WhenForm {
  kind: PresetKind
  time: string // "09:00" for weekdays/daily
  minute: number // for hourly
  n: number // for everyNMinutes
  at: string // datetime-local value "2026-10-16T09:00"
  cron: string
}

export function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** datetime-local string (local time) <-> ISO UTC. */
export function localInputToIso(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type FormResult = { ok: true; when: ScheduleWhen; preset: SchedulePreset } | { ok: false; error: string }

/** Turn the picker form into a ScheduleWhen + preset. Local checks only; main/engine is the final validator. */
export function formToWhen(f: WhenForm, tz: string = localTz()): FormResult {
  switch (f.kind) {
    case 'weekdays':
    case 'daily': {
      const t = parseTime(f.time)
      if (!t) return { ok: false, error: 'Enter a time like 09:00' }
      const dow = f.kind === 'weekdays' ? '1-5' : '*'
      return { ok: true, when: { kind: 'cron', cron: `${t.m} ${t.h} * * ${dow}`, tz }, preset: { kind: f.kind, time: `${pad(t.h)}:${pad(t.m)}` } }
    }
    case 'hourly': {
      const m = Math.trunc(f.minute)
      if (!(m >= 0 && m <= 59)) return { ok: false, error: 'Minute must be 0–59' }
      return { ok: true, when: { kind: 'cron', cron: `${m} * * * *`, tz }, preset: { kind: 'hourly', minute: m } }
    }
    case 'everyNMinutes': {
      const n = Math.trunc(f.n)
      if (!(n >= 5)) return { ok: false, error: 'Minimum interval is 5 minutes' }
      if (n > 59) return { ok: false, error: 'Use “Every hour” or a cron for 60 minutes or more' }
      return { ok: true, when: { kind: 'cron', cron: `*/${n} * * * *`, tz }, preset: { kind: 'everyNMinutes', n } }
    }
    case 'once': {
      const iso = localInputToIso(f.at)
      if (!iso) return { ok: false, error: 'Pick a date and time' }
      return { ok: true, when: { kind: 'at', at: iso }, preset: { kind: 'once', at: iso } }
    }
    case 'cron': {
      const c = f.cron.trim().replace(/\s+/g, ' ')
      if (c.split(' ').length !== 5) return { ok: false, error: 'Cron needs 5 fields: minute hour day month weekday' }
      return { ok: true, when: { kind: 'cron', cron: c, tz }, preset: { kind: 'cron' } }
    }
  }
}

export function defaultForm(now: Date = new Date()): WhenForm {
  const later = new Date(now.getTime() + 60 * 60_000)
  later.setSeconds(0, 0)
  return { kind: 'weekdays', time: '09:00', minute: 0, n: 15, at: isoToLocalInput(later.toISOString()), cron: '0 9 * * 1-5' }
}

/** Rebuild the form from a stored schedule (for editing). */
export function whenToForm(when: ScheduleWhen, preset: SchedulePreset | null, now: Date = new Date()): WhenForm {
  const f = defaultForm(now)
  if (when.kind === 'at') return { ...f, kind: 'once', at: isoToLocalInput(when.at) }
  f.cron = when.cron
  if (!preset) return { ...f, kind: 'cron' }
  switch (preset.kind) {
    case 'weekdays':
    case 'daily':
      return { ...f, kind: preset.kind, time: preset.time }
    case 'hourly':
      return { ...f, kind: 'hourly', minute: preset.minute }
    case 'everyNMinutes':
      return { ...f, kind: 'everyNMinutes', n: preset.n }
    case 'once':
      return { ...f, kind: 'once', at: isoToLocalInput(preset.at) }
    default:
      return { ...f, kind: 'cron' }
  }
}
