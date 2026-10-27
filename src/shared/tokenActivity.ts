/**
 * docs/USAGE.md §5: pure helpers for the Token activity section (the stat strip and the year of dots). Day keys are
 * local days (YYYY-MM-DD); weeks start on Monday, like the rest of Usage. No React, no IPC, no Node.
 */
import type { TokenActivityDay, TokenCounts } from './usage'

export type ActivityMode = 'daily' | 'weekly' | 'cumulative'
/** Levels of a dot: 0 = no tokens, 1..LEVELS = dark navy to bright blue. */
export const LEVELS = 4
export const GRID_WEEKS = 53

export const sumCounts = (c: TokenCounts | undefined): number => (c ? c.input + c.output + c.cacheWrite + c.cacheRead : 0)
export const zeroCounts = (): TokenCounts => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
export function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  a.input += b.input
  a.output += b.output
  a.cacheWrite += b.cacheWrite
  a.cacheRead += b.cacheRead
  return a
}
export const dayTotal = (d: TokenActivityDay): number => Object.values(d.byProvider).reduce((n, c) => n + sumCounts(c), 0)

/** YYYY-MM-DD in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Local midnight of a day key. */
export function parseDay(k: string): Date {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}
/** The day after `k` (calendar arithmetic, so a DST change never skips or repeats a day). */
export function nextDay(k: string, n = 1): string {
  const d = parseDay(k)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

export interface ActivityStats {
  lifetime: number
  peak: { date: string; tokens: number } | null
  /** Consecutive days with tokens, ending today (or yesterday while today has none yet: the day is not over). */
  currentStreak: number
  longestStreak: number
  activeDays: number
}

export function activityStats(days: TokenActivityDay[], now: Date): ActivityStats {
  const totals = new Map<string, number>()
  for (const d of days) {
    const t = dayTotal(d)
    if (t > 0) totals.set(d.date, (totals.get(d.date) ?? 0) + t)
  }
  let lifetime = 0
  let peak: ActivityStats['peak'] = null
  for (const [date, tokens] of totals) {
    lifetime += tokens
    if (!peak || tokens > peak.tokens || (tokens === peak.tokens && date > peak.date)) peak = { date, tokens }
  }
  // longest: walk the sorted active days, a run breaks when the next active day is not the calendar next day
  const sorted = [...totals.keys()].sort()
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const k of sorted) {
    run = prev && nextDay(prev) === k ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = k
  }
  const today = dayKey(now)
  let cursor = totals.has(today) ? today : nextDay(today, -1)
  let current = 0
  while (totals.has(cursor)) {
    current++
    cursor = nextDay(cursor, -1)
  }
  return { lifetime, peak, currentStreak: current, longestStreak: longest, activeDays: totals.size }
}

export interface GridCell {
  date: string
  /** Column (week) and row (0 = Monday). */
  col: number
  row: number
  level: number
  /** The value the level was taken from: the day, its week, or the running total. */
  value: number
  future: boolean
}
export interface GridMonth {
  col: number
  label: string
}
export interface ActivityGrid {
  weeks: number
  cells: GridCell[]
  months: GridMonth[]
  /** The biggest value drawn. */
  max: number
}

/** Level 1..LEVELS of `v` among the positive values (quartiles, like a contribution graph); 0 when v is 0. */
export function levelOf(v: number, sortedPositive: number[]): number {
  if (v <= 0 || !sortedPositive.length) return 0
  // the share of active values at or below v, mapped onto 1..LEVELS
  let lo = 0
  let hi = sortedPositive.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedPositive[mid] <= v) lo = mid + 1
    else hi = mid
  }
  return Math.max(1, Math.min(LEVELS, Math.ceil((lo / sortedPositive.length) * LEVELS)))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The year of dots: GRID_WEEKS Monday-first columns ending with this week; days after today are `future` (not drawn).
 * daily = each day's tokens; weekly = every day of a week shows its week's total; cumulative = the running lifetime
 * total (tokens before the grid included), scaled against today's total.
 */
export function activityGrid(days: TokenActivityDay[], now: Date, mode: ActivityMode, weeks = GRID_WEEKS): ActivityGrid {
  const totals = new Map<string, number>()
  for (const d of days) totals.set(d.date, (totals.get(d.date) ?? 0) + dayTotal(d))
  const today = dayKey(now)
  const t0 = parseDay(today)
  const monday = new Date(t0)
  monday.setDate(t0.getDate() - ((t0.getDay() + 6) % 7))
  const start = new Date(monday)
  start.setDate(monday.getDate() - (weeks - 1) * 7)
  const startKey = dayKey(start)

  const cells: GridCell[] = []
  for (let col = 0; col < weeks; col++)
    for (let row = 0; row < 7; row++) {
      const date = nextDay(startKey, col * 7 + row)
      cells.push({ date, col, row, level: 0, value: totals.get(date) ?? 0, future: date > today })
    }
  if (mode === 'weekly') {
    const byWeek = new Map<number, number>()
    for (const c of cells) if (!c.future) byWeek.set(c.col, (byWeek.get(c.col) ?? 0) + c.value)
    for (const c of cells) c.value = byWeek.get(c.col) ?? 0
  } else if (mode === 'cumulative') {
    let run = 0
    for (const [k, v] of totals) if (k < startKey) run += v
    for (const c of cells) {
      if (c.future) continue
      run += c.value
      c.value = run
    }
  }
  const live = cells.filter((c) => !c.future)
  const max = live.reduce((m, c) => Math.max(m, c.value), 0)
  if (mode === 'cumulative') {
    // a running total only grows: its level is the share of today's total, so the year reads dim to bright
    for (const c of live) c.level = c.value <= 0 || max <= 0 ? 0 : Math.max(1, Math.min(LEVELS, Math.ceil((c.value / max) * LEVELS)))
  } else {
    const positive = (mode === 'weekly' ? [...new Map(live.map((c) => [c.col, c.value])).values()] : live.map((c) => c.value)).filter((v) => v > 0).sort((a, b) => a - b)
    for (const c of live) c.level = levelOf(c.value, positive)
  }

  // a month label sits over the first column whose Monday falls in that month; one too close to the left edge is dropped
  const months: GridMonth[] = []
  for (let col = 0; col < weeks; col++) {
    const d = parseDay(nextDay(startKey, col * 7))
    const prev = col === 0 ? null : parseDay(nextDay(startKey, (col - 1) * 7))
    if (prev && prev.getMonth() === d.getMonth()) continue
    if (col === 0 && d.getDate() > 7) continue
    months.push({ col, label: MONTHS[d.getMonth()] })
  }
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift()
  return { weeks, cells, months, max }
}

/** "2.7B", "723.6M", "48.2k", "512". */
export function compactTokens(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  const [d, u] = v < 1e6 ? [1e3, 'k'] : v < 1e9 ? [1e6, 'M'] : v < 1e12 ? [1e9, 'B'] : [1e12, 'T']
  const x = v / d
  return `${x.toFixed(1).replace(/\.0$/, '')}${u}`
}
/** "1h 36m", "42m", "35s", "—". */
export function taskDuration(ms: number): string {
  if (!(ms > 0)) return '—'
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}
export const streakLabel = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`
