/**
 * DASHBOARDS.md §5.3: web analytics. Plausible through its Stats API v2 (`POST /api/v2/query`), PostHog through a
 * HogQL query (`POST /api/projects/:id/query/`). Both compare the last 28 days with the 28 before.
 */
import type { DashboardSnapshot } from '../../../shared/dashboards'
import { configText } from '../../../shared/dashboards'
import { DashboardFetchError, getJson, isoDay, type HttpFn } from '../http'
import { secretsOf, type DashboardProvider, type ProviderCtx } from './types'

const WINDOW = 28

/** A configured host: https only (http for localhost), no path, no credentials. Falls back to `def`. */
export function hostOf(raw: string | string[] | undefined, def: string): string {
  const v = configText(raw)
  if (!v) return def
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw new DashboardFetchError('config', `The host “${v.slice(0, 80)}” is not a URL.`)
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if ((u.protocol !== 'https:' && !(local && u.protocol === 'http:')) || u.username || u.password) {
    throw new DashboardFetchError('config', 'The host must be an https:// URL.')
  }
  return u.origin
}

// ---------- Plausible ----------

interface PlausibleResult {
  results?: { metrics: number[]; dimensions: string[] }[]
}

async function plausible(http: HttpFn, ctx: ProviderCtx, body: object): Promise<PlausibleResult> {
  const host = hostOf(ctx.config.host, 'https://plausible.io')
  return getJson<PlausibleResult>(
    http,
    { url: `${host}/api/v2/query`, method: 'POST', headers: { Authorization: `Bearer ${ctx.keys.PLAUSIBLE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { provider: 'Plausible', secrets: secretsOf(ctx), hints: { config: 'Check the site domain: it must match the site in Plausible exactly, without https://.', forbidden: 'Use a Stats API key that can read this site.' } }
  )
}

const siteId = (ctx: ProviderCtx): string => {
  const s = configText(ctx.config.siteId).replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!s) throw new DashboardFetchError('config', 'Set the site domain as it is listed in Plausible.')
  return s
}

const PLAUSIBLE_METRICS = ['visitors', 'pageviews', 'bounce_rate', 'visit_duration'] as const

export const plausibleProvider: DashboardProvider = {
  kind: 'plausible',
  async validate(ctx) {
    await plausible(ctx.http, ctx, { site_id: siteId(ctx), metrics: ['visitors'], date_range: 'day' })
  },
  async fetch(ctx) {
    const site = siteId(ctx)
    const end = isoDay(ctx.now, 0)
    const start = isoDay(ctx.now, WINDOW - 1)
    const prevEnd = isoDay(ctx.now, WINDOW)
    const prevStart = isoDay(ctx.now, 2 * WINDOW - 1)
    const [cur, prev, daily, pages, sources] = await Promise.all([
      plausible(ctx.http, ctx, { site_id: site, metrics: PLAUSIBLE_METRICS, date_range: [start, end] }),
      plausible(ctx.http, ctx, { site_id: site, metrics: PLAUSIBLE_METRICS, date_range: [prevStart, prevEnd] }),
      plausible(ctx.http, ctx, { site_id: site, metrics: ['visitors'], date_range: [start, end], dimensions: ['time:day'] }),
      plausible(ctx.http, ctx, { site_id: site, metrics: ['visitors'], date_range: [start, end], dimensions: ['event:page'], order_by: [['visitors', 'desc']], pagination: { limit: 10 } }),
      plausible(ctx.http, ctx, { site_id: site, metrics: ['visitors'], date_range: [start, end], dimensions: ['visit:source'], order_by: [['visitors', 'desc']], pagination: { limit: 10 } })
    ])
    const m = (r: PlausibleResult, i: number): number | null => r.results?.[0]?.metrics?.[i] ?? null
    if (!m(cur, 0) && !m(prev, 0)) throw new DashboardFetchError('no_data', `Plausible has no visits for ${site} in the last 8 weeks. Check that the script is installed.`)
    return {
      fetchedAt: ctx.now.toISOString(),
      period: 'Last 28 days vs the 28 before',
      kpis: {
        visitors: { value: m(cur, 0), previous: m(prev, 0) },
        pageviews: { value: m(cur, 1), previous: m(prev, 1) },
        // Plausible reports bounce rate in percent (42 = 42%)
        bounceRate: { value: m(cur, 2) == null ? null : m(cur, 2)! / 100, previous: m(prev, 2) == null ? null : m(prev, 2)! / 100 },
        visitDuration: { value: m(cur, 3), previous: m(prev, 3) }
      },
      series: { daily: [{ label: 'Visitors', points: (daily.results ?? []).map((r) => ({ t: r.dimensions[0], v: r.metrics[0] })).sort((a, b) => (a.t < b.t ? -1 : 1)) }] },
      tables: {
        pages: (pages.results ?? []).map((r) => ({ page: r.dimensions[0], visitors: r.metrics[0] })),
        sources: (sources.results ?? []).map((r) => ({ source: r.dimensions[0] || 'Direct / none', visitors: r.metrics[0] }))
      }
    } satisfies DashboardSnapshot
  }
}

// ---------- PostHog ----------

const projectOf = (ctx: ProviderCtx): string => {
  const id = configText(ctx.config.projectId)
  if (!/^\d{1,12}$/.test(id)) throw new DashboardFetchError('config', 'Set the PostHog project ID (a number, under Settings → Project).')
  return id
}
const posthogHints = { forbidden: 'Give the personal API key the Query Read and Project Read scopes for this project.', config: 'Check the project ID and the host (us.posthog.com or eu.posthog.com).' }

/** One HogQL query; rows as arrays in column order. */
export async function hogql(ctx: ProviderCtx, query: string): Promise<unknown[][]> {
  const host = hostOf(ctx.config.host, 'https://us.posthog.com')
  const res = await getJson<{ results?: unknown[][] }>(
    ctx.http,
    { url: `${host}/api/projects/${projectOf(ctx)}/query/`, method: 'POST', headers: { Authorization: `Bearer ${ctx.keys.POSTHOG_PERSONAL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }), timeoutMs: 45_000 },
    { provider: 'PostHog', secrets: secretsOf(ctx), hints: posthogHints }
  )
  return res.results ?? []
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

export const posthogProvider: DashboardProvider = {
  kind: 'posthog',
  async validate(ctx) {
    const host = hostOf(ctx.config.host, 'https://us.posthog.com')
    await getJson(ctx.http, { url: `${host}/api/projects/${projectOf(ctx)}/`, headers: { Authorization: `Bearer ${ctx.keys.POSTHOG_PERSONAL_API_KEY}` } }, { provider: 'PostHog', secrets: secretsOf(ctx), hints: posthogHints })
  },
  async fetch(ctx) {
    const W = `INTERVAL ${WINDOW} DAY`
    const [totals, daily, pages, refs] = await Promise.all([
      hogql(
        ctx,
        `SELECT countIf(timestamp >= now() - ${W}) AS views, uniqIf(person_id, timestamp >= now() - ${W}) AS users, countIf(timestamp < now() - ${W}) AS prev_views, uniqIf(person_id, timestamp < now() - ${W}) AS prev_users FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL ${2 * WINDOW} DAY`
      ),
      hogql(ctx, `SELECT toDate(timestamp) AS day, uniq(person_id) AS users, count() AS views FROM events WHERE event = '$pageview' AND timestamp >= now() - ${W} GROUP BY day ORDER BY day`),
      hogql(ctx, `SELECT properties.$pathname AS page, count() AS views FROM events WHERE event = '$pageview' AND timestamp >= now() - ${W} GROUP BY page ORDER BY views DESC LIMIT 10`),
      hogql(ctx, `SELECT properties.$referring_domain AS referrer, count() AS views FROM events WHERE event = '$pageview' AND timestamp >= now() - ${W} GROUP BY referrer ORDER BY views DESC LIMIT 10`)
    ])
    const [views, users, prevViews, prevUsers] = (totals[0] ?? [0, 0, 0, 0]).map(num)
    if (!views && !prevViews) throw new DashboardFetchError('no_data', 'PostHog has no pageviews in the last 8 weeks for this project.')
    return {
      fetchedAt: ctx.now.toISOString(),
      period: 'Last 28 days vs the 28 before',
      kpis: {
        users: { value: users, previous: prevUsers },
        pageviews: { value: views, previous: prevViews },
        viewsPerUser: { value: users ? views / users : null, previous: prevUsers ? prevViews / prevUsers : null }
      },
      series: {
        daily: [
          { label: 'Users', points: daily.map((r) => ({ t: String(r[0]).slice(0, 10), v: num(r[1]) })) },
          { label: 'Pageviews', points: daily.map((r) => ({ t: String(r[0]).slice(0, 10), v: num(r[2]) })) }
        ]
      },
      tables: {
        pages: pages.map((r) => ({ page: r[0] == null || r[0] === '' ? '(unknown)' : String(r[0]), views: num(r[1]) })),
        referrers: refs.map((r) => ({ referrer: r[0] == null || r[0] === '' || r[0] === '$direct' ? 'Direct' : String(r[0]), views: num(r[1]) }))
      }
    } satisfies DashboardSnapshot
  }
}
