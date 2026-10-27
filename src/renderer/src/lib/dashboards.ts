/**
 * DASHBOARDS.md §9: pure helpers for the department dashboards UI: line-chart geometry, the install form's readiness,
 * and status copy. Formatting lives in @shared/dashboards (main uses it for the agent summary too).
 */
import { serviceMonogram } from './serviceActions'
import type { DashboardConfig, DashboardDef, DashboardKeyLookup, DashboardStatus, Series } from '@shared/dashboards'
import { configList, configText } from '@shared/dashboards'

/** A round upper bound for an axis (1, 2, 2.5, 5 × 10^n), never below `v`. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base
  return 10 * base
}

export interface ChartPoint {
  x: number
  y: number
  t: string
  v: number
}
export interface ChartGeometry {
  /** `max`: the axis top this line is drawn against */
  lines: { label: string; d: string; points: ChartPoint[]; max: number }[]
  /** the series differ by more than INDEPENDENT_RATIO, so each is drawn on its own scale (the axis shows the first) */
  independent: boolean
  /** gridline y positions with their values, bottom to top */
  ticks: { y: number; v: number }[]
  max: number
  /** the shared x labels (first, last) */
  first: string | null
  last: string | null
}

export const INDEPENDENT_RATIO = 5

/**
 * SVG paths for up to a few series on one 0-based y axis (or one per series when their sizes differ by more than
 * INDEPENDENT_RATIO, like clicks against impressions, so the small one is not a flat line on the floor). x spreads each series' points evenly over the width (the
 * series share their dates); a single point sits in the middle.
 */
export function chartGeometry(series: readonly Series[], width: number, height: number, pad = { top: 6, right: 4, bottom: 4, left: 4 }): ChartGeometry {
  const peak = (s: Series): number => Math.max(0, ...s.points.map((p) => p.v).filter((v) => Number.isFinite(v)))
  const peaks = series.map(peak).filter((v) => v > 0)
  const independent = peaks.length > 1 && Math.max(...peaks) / Math.min(...peaks) > INDEPENDENT_RATIO
  const max = niceMax(Math.max(0, ...series.map(peak)))
  const w = Math.max(1, width - pad.left - pad.right)
  const h = Math.max(1, height - pad.top - pad.bottom)
  const yOf = (v: number, top = max): number => pad.top + h - (Math.max(0, v) / top) * h
  const lines = series.map((s, si) => {
    const top = independent ? niceMax(peak(s)) : max
    const n = s.points.length
    const points = s.points.map((p, i) => ({ x: pad.left + (n === 1 ? w / 2 : (i / (n - 1)) * w), y: yOf(p.v, top), t: p.t, v: p.v }))
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
    return { label: s.label, d, points, max: si === 0 || independent ? top : max }
  })
  const axis = independent && lines[0] ? lines[0].max : max
  const longest = series.reduce<Series | null>((a, s) => (!a || s.points.length > a.points.length ? s : a), null)
  return {
    lines,
    ticks: [0, 0.5, 1].map((f) => ({ y: yOf(axis * f, axis), v: axis * f })),
    max: axis,
    independent,
    first: longest?.points[0]?.t ?? null,
    last: longest?.points.at(-1)?.t ?? null
  }
}

/** Index of the point nearest to x (hover), or -1. */
export function nearestIndex(points: readonly ChartPoint[], x: number): number {
  let best = -1
  let dist = Infinity
  points.forEach((p, i) => {
    const d = Math.abs(p.x - x)
    if (d < dist) {
      dist = d
      best = i
    }
  })
  return best
}

/** "2026-10-04" → "Oct 4", "2026-10" → "Oct 2026", anything else as is. */
export function shortDate(t: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t)
  if (!m) return t
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1)))
  return d.toLocaleDateString('en-US', m[3] ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export interface InstallReadiness {
  ok: boolean
  /** labels of required fields still empty */
  missing: string[]
}

/**
 * Whether the install form can be sent: each required key pasted or already saved, each required config field set.
 * `connection`: the company's connection to the dashboard's service already serves it (CONNECTIONS.md §4.3), so no key
 * is asked; `signIn` when it reads through a sign-in, which also makes `def.viaSignIn.config` fields optional.
 */
export function installReadiness(def: DashboardDef, lookups: readonly DashboardKeyLookup[], pasted: Record<string, string>, config: DashboardConfig, connection: 'key' | 'signIn' | null = null): InstallReadiness {
  const missing: string[] = []
  const optional = new Set(connection === 'signIn' ? (def.viaSignIn?.config ?? []) : [])
  for (const k of def.keys) {
    if (!k.required || connection) continue
    const saved = lookups.find((l) => l.name === k.name)?.source
    if (!saved && !(pasted[k.name] ?? '').trim()) missing.push(k.label)
  }
  for (const f of def.config) {
    if (!f.required || optional.has(f.key)) continue
    const has = f.kind === 'list' ? configList(config[f.key]).length > 0 : !!configText(config[f.key])
    if (!has) missing.push(f.label)
  }
  return { ok: missing.length === 0, missing }
}

/** True when every required key of a dashboard already exists in this company (so "Add" can skip straight to config). */
export function keysReady(def: DashboardDef, lookups: readonly DashboardKeyLookup[]): boolean {
  return def.keys.filter((k) => k.required).every((k) => !!lookups.find((l) => l.name === k.name)?.source)
}

export interface StatusCopy {
  tone: 'ok' | 'error' | 'muted'
  title: string
  /** the fix the banner offers */
  action: 'keys' | 'settings' | 'retry' | null
}

/** The banner for a dashboard's last attempt. */
export function statusCopy(status: DashboardStatus, hasSnapshot: boolean): StatusCopy | null {
  if (status.state === 'loading') return hasSnapshot ? null : { tone: 'muted', title: 'Fetching the first numbers…', action: null }
  if (status.state === 'never') return hasSnapshot ? null : { tone: 'muted', title: 'Waiting for the first refresh.', action: 'retry' }
  if (status.state === 'ok') return null
  switch (status.code) {
    case 'invalid_key':
      return { tone: 'error', title: 'The key was rejected', action: 'keys' }
    case 'forbidden':
      return { tone: 'error', title: 'The key is missing a permission', action: 'keys' }
    case 'rate_limited':
      return { tone: 'muted', title: 'Rate limited, will retry later', action: 'retry' }
    case 'no_data':
      return { tone: 'muted', title: 'No data yet', action: 'retry' }
    case 'config':
      return { tone: 'error', title: 'Check the settings', action: 'settings' }
    case 'network':
      return { tone: 'muted', title: 'Offline, will retry', action: 'retry' }
    default:
      return { tone: 'error', title: 'The last refresh failed', action: 'retry' }
  }
}

/** Two letters for a provider's line-art monogram ("Google Search Console" → "GS", "Stripe" → "St"). */
export function monogram(provider: string): string {
  // QA-12: one monogram everywhere (the connection roundel's)
  return serviceMonogram(provider)
}
