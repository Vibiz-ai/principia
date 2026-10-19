/** Time formatting rules from DESIGN §9.7: relative under 24 h, absolute local 24 h clock otherwise. */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const pad = (n: number): string => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Oct 14 06:00" */
export function absolute(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock(d)}`
}

/** "Thu Oct 16 09:00" */
export function absoluteWithDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return `${WEEKDAYS[d.getDay()]} ${absolute(d)}`
}

/** When something started, compact: "21:05" today-ish (<24 h), else "Oct 14 06:00". Disambiguates same-named rows. */
export function startedHint(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  return now - d.getTime() < DAY ? clock(d) : absolute(d)
}

/** Compact span: "45s", "14m", "3h", "2d". */
export function span(ms: number): string {
  const a = Math.abs(ms)
  if (a < MIN) return `${Math.max(0, Math.floor(a / 1000))}s`
  if (a < HOUR) return `${Math.floor(a / MIN)}m`
  if (a < DAY) return `${Math.floor(a / HOUR)}h`
  return `${Math.floor(a / DAY)}d`
}

/** Past: "14m ago" (<24h) else absolute. Future: "in 41m" (<24h) else absolute. */
export function relative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  const diff = t - now
  if (Math.abs(diff) >= DAY) return absolute(iso)
  if (diff > 0) return diff < MIN ? 'in <1m' : `in ${span(diff)}`
  return -diff < MIN ? 'just now' : `${span(diff)} ago`
}

/** Elapsed since a moment, no suffix: "14m". */
export function age(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  return span(now - new Date(iso).getTime())
}

/** Duration "<1s", "12s", "4m02s", "1h04m". */
export function durationMs(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h${pad(m)}m`
  return `${m}m${pad(s % 60)}s`
}

export function duration(startIso: string | null, endIso: string | null, now: number = Date.now()): string {
  if (!startIso) return '—'
  return durationMs((endIso ? new Date(endIso).getTime() : now) - new Date(startIso).getTime())
}

export function tooltipTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${absoluteWithDay(d)}:${pad(d.getSeconds())} (${tz})`
}

/** "Today" / "Yesterday" / "Oct 12" grouping label for galleries. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(now) - start(d)) / DAY)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ''}`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
