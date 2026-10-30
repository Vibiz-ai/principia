/**
 * DASHBOARDS.md §5.3: web analytics. Plausible through its Stats API v2 (`POST /api/v2/query`), PostHog through a
 * HogQL query (`POST /api/projects/:id/query/`). Both compare the last 28 days with the 28 before.
 */
import type { DashboardSnapshot } from '../../../shared/dashboards'
import { configText } from '../../../shared/dashboards'
import { DashboardFetchError, getJson, isoDay, type HttpFn } from '../http'
import { secretsOf, type DashboardProvider, type McpReader, type ProviderCtx } from './types'

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

/** One HogQL query; rows as arrays in column order. With no key, through the company's PostHog sign-in. */
export async function hogql(ctx: ProviderCtx, query: string): Promise<unknown[][]> {
  if (!ctx.keys.POSTHOG_PERSONAL_API_KEY && ctx.mcp) return signInSql(ctx.mcp, query)
  const host = hostOf(ctx.config.host, 'https://us.posthog.com')
  const res = await getJson<{ results?: unknown[][] }>(
    ctx.http,
    { url: `${host}/api/projects/${projectOf(ctx)}/query/`, method: 'POST', headers: { Authorization: `Bearer ${ctx.keys.POSTHOG_PERSONAL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }), timeoutMs: 45_000 },
    { provider: 'PostHog', secrets: secretsOf(ctx), hints: posthogHints }
  )
  return res.results ?? []
}

// ---------- PostHog through its MCP sign-in (CONNECTIONS.md §4.3) ----------

const NO_SQL = 'PostHog’s sign-in here doesn’t offer SQL queries. Add a personal API key for this dashboard instead.'
const UNREADABLE = 'PostHog answered through the sign-in in a form Principia can’t read. Add a personal API key for this dashboard instead.'
const BUSY = 'PostHog is busy right now. Try again in a minute.'
const BUSY_RETRY_MS = 1500
const toolCache = new WeakMap<McpReader, Promise<string[]>>()

/**
 * The PostHog MCP server's SQL tool, whichever shape it has: `execute-sql` as its own tool, or the single `exec` tool
 * that takes CLI-style commands (`call --json execute-sql {…}`).
 */
export async function signInSql(mcp: McpReader, query: string): Promise<unknown[][]> {
  let tools = toolCache.get(mcp)
  if (!tools) {
    tools = mcp.tools()
    toolCache.set(mcp, tools)
  }
  let names: string[]
  try {
    names = await tools
  } catch {
    toolCache.delete(mcp)
    throw new DashboardFetchError('invalid_key', 'PostHog’s sign-in isn’t working. Sign in to PostHog again in Settings › Connections.')
  }
  const ask = async (): Promise<unknown> => {
    try {
      if (names.includes('execute-sql')) return await mcp.call('execute-sql', { query })
      if (names.includes('exec')) return await mcp.call('exec', { command: `call --json execute-sql ${JSON.stringify({ query })}`, context: 'Reading product analytics numbers for a dashboard.', llm_model: 'unknown' })
    } catch {
      throw new DashboardFetchError('unavailable', 'PostHog didn’t answer through the sign-in. Try again later.')
    }
    throw new DashboardFetchError('unavailable', NO_SQL)
  }
  // a dashboard sends its queries together, and the server asks to retry a busy one once
  let res = await ask()
  if (isBusy(res)) {
    await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS))
    res = await ask()
  }
  return mcpRows(res)
}

const isBusy = (res: unknown): boolean => {
  const r = (res ?? {}) as { isError?: boolean; content?: { text?: string }[] }
  return !!r.isError && (r.content ?? []).some((c) => /MaxToolTransientError/.test(c?.text ?? ''))
}

/**
 * Rows from an MCP tool result: structured content, JSON text with `results` (arrays, objects in column order, or the
 * table text below), or that table text alone.
 */
export function mcpRows(res: unknown): unknown[][] {
  const r = (res ?? {}) as { isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] }
  if (isBusy(res)) throw new DashboardFetchError('unavailable', BUSY)
  if (r.isError) throw new DashboardFetchError('forbidden', 'PostHog turned down the query through the sign-in. Check that the sign-in picked this project and may read its data.')
  const candidates: unknown[] = [r.structuredContent]
  const plain: string[] = []
  for (const c of r.content ?? []) {
    if (c?.type !== 'text' || typeof c.text !== 'string') continue
    const t = c.text.trim()
    try {
      const start = t.search(/[[{]/)
      if (start < 0) throw new Error('not JSON')
      candidates.push(JSON.parse(t.slice(start)))
    } catch {
      plain.push(t)
    }
  }
  for (const c of candidates) {
    const rows = findResults(c, 0)
    if (rows) return rows
  }
  for (const t of plain) {
    // only what starts with a line of column names: anything else is a sentence, not an empty table
    const rows = t.split('\n', 1)[0]!.split('|').every((c) => /^\S+$/.test(c)) ? tableRows(t) : null
    if (rows) return rows
  }
  throw new DashboardFetchError('unavailable', UNREADABLE)
}

/**
 * The table text PostHog's `execute-sql` answers with: a `|`-separated header line, then a line per row. Values are not
 * escaped, so a `|` or a line break inside one looks like a separator; our queries URL-encode their text columns for
 * that. Every cell is text and nulls are `(null)`; `num` reads the numbers. A row with too many cells gives the extra
 * back to its first column, the one text column in every dashboard query. Null when a row stays short.
 */
function tableRows(text: string): unknown[][] | null {
  const [header, ...lines] = text.split('\n')
  const width = header!.split('|').length
  const rows: unknown[][] = []
  let row = ''
  for (const line of lines) {
    row = row ? `${row}\n${line}` : line
    const cells = row.split('|')
    if (cells.length < width) continue
    const extra = cells.length - width
    rows.push([cells.slice(0, extra + 1).join('|'), ...cells.slice(extra + 1)].map((c) => (c === '(null)' ? null : c)))
    row = ''
  }
  return row ? null : rows
}

function findResults(v: unknown, depth: number): unknown[][] | null {
  if (!v || typeof v !== 'object' || depth > 3) return null
  const o = v as Record<string, unknown>
  if (typeof o.results === 'string') return tableRows(o.results)
  const list = Array.isArray(v) ? v : Array.isArray(o.results) ? o.results : null
  if (list) {
    if (list.every((x) => Array.isArray(x))) return list as unknown[][]
    if (list.every((x) => x && typeof x === 'object')) {
      const cols = Array.isArray(o.columns) ? (o.columns as unknown[]).map(String) : null
      return list.map((x) => (cols ? cols.map((c) => (x as Record<string, unknown>)[c]) : Object.values(x as Record<string, unknown>)))
    }
  }
  if (Array.isArray(v)) return null
  for (const k of ['result', 'data', 'response']) {
    const inner = findResults(o[k], depth + 1)
    if (inner) return inner
  }
  return null
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

/** A text column as sent: the queries URL-encode them, so a `|` or a line break in a value can't pass for a separator. */
function plain(v: unknown): string {
  if (v == null) return ''
  try {
    return decodeURIComponent(String(v))
  } catch {
    return String(v)
  }
}

export const posthogProvider: DashboardProvider = {
  kind: 'posthog',
  async validate(ctx) {
    if (!ctx.keys.POSTHOG_PERSONAL_API_KEY && ctx.mcp) {
      await signInSql(ctx.mcp, 'SELECT 1')
      return
    }
    const host = hostOf(ctx.config.host, 'https://us.posthog.com')
    await getJson(ctx.http, { url: `${host}/api/projects/${projectOf(ctx)}/`, headers: { Authorization: `Bearer ${ctx.keys.POSTHOG_PERSONAL_API_KEY}` } }, { provider: 'PostHog', secrets: secretsOf(ctx), hints: posthogHints })
  },
  // whose key is it: /api/users/@me/ on the set host, else the US cloud and then the EU cloud (a personal key works
  // only in its own region), which also tells the EU host
  async checkKey(ctx) {
    const me = (host: string): Promise<unknown> => getJson(ctx.http, { url: `${host}/api/users/@me/`, headers: { Authorization: `Bearer ${ctx.keys.POSTHOG_PERSONAL_API_KEY}` } }, { provider: 'PostHog', secrets: secretsOf(ctx), hints: posthogHints })
    if (configText(ctx.config.host)) {
      await me(hostOf(ctx.config.host, 'https://us.posthog.com'))
      return
    }
    try {
      await me('https://us.posthog.com')
      return { settings: { host: 'https://us.posthog.com' } }
    } catch (e) {
      if (!(e instanceof DashboardFetchError) || e.code !== 'invalid_key') throw e
    }
    await me('https://eu.posthog.com')
    return { settings: { host: 'https://eu.posthog.com' } }
  },
  async fetch(ctx) {
    const W = `INTERVAL ${WINDOW} DAY`
    const [totals, daily, pages, refs] = await Promise.all([
      hogql(
        ctx,
        `SELECT countIf(timestamp >= now() - ${W}) AS views, uniqIf(person_id, timestamp >= now() - ${W}) AS users, countIf(timestamp < now() - ${W}) AS prev_views, uniqIf(person_id, timestamp < now() - ${W}) AS prev_users FROM events WHERE event = '$pageview' AND timestamp >= now() - INTERVAL ${2 * WINDOW} DAY`
      ),
      hogql(ctx, `SELECT toDate(timestamp) AS day, uniq(person_id) AS users, count() AS views FROM events WHERE event = '$pageview' AND timestamp >= now() - ${W} GROUP BY day ORDER BY day`),
      hogql(ctx, `SELECT encodeURLComponent(properties.$pathname) AS page, count() AS views FROM events WHERE event = '$pageview' AND timestamp >= now() - ${W} GROUP BY page ORDER BY views DESC LIMIT 10`),
      hogql(ctx, `SELECT encodeURLComponent(properties.$referring_domain) AS referrer, count() AS views FROM events WHERE event = '$pageview' AND timestamp >= now() - ${W} GROUP BY referrer ORDER BY views DESC LIMIT 10`)
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
        pages: pages.map((r) => ({ page: plain(r[0]) || '(unknown)', views: num(r[1]) })),
        referrers: refs.map((r) => {
          const referrer = plain(r[0])
          return { referrer: !referrer || referrer === '$direct' ? 'Direct' : referrer, views: num(r[1]) }
        })
      }
    } satisfies DashboardSnapshot
  }
}
