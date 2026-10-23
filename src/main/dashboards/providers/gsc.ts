/**
 * DASHBOARDS.md §5.1: SEO from Google Search Console, plus a PageSpeed score.
 *
 * Auth is a service account: main signs a JWT (RS256, node:crypto) with the account's private key, exchanges it for a
 * one-hour `webmasters.readonly` token, and queries the Search Analytics API. The private key never leaves main; the
 * token is kept in memory only for the duration of one fetch. Search data lags by about two days, so the window ends
 * two days ago: the last 28 days against the 28 before.
 */
import { createSign } from 'node:crypto'
import type { DashboardSnapshot, TableRow } from '../../../shared/dashboards'
import { configText } from '../../../shared/dashboards'
import { DashboardFetchError, getJson, isoDay, type HttpFn } from '../http'
import { secretsOf, type DashboardProvider, type ProviderCtx } from './types'

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://searchconsole.googleapis.com/webmasters/v3'
const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
const LAG_DAYS = 2
const WINDOW = 28

export interface ServiceAccount {
  client_email: string
  private_key: string
  token_uri?: string
}

/** Parses the pasted JSON key file. Throws a config error naming what is missing (never quoting the key). */
export function parseServiceAccount(raw: string | undefined): ServiceAccount {
  let v: unknown
  try {
    v = JSON.parse(raw ?? '')
  } catch {
    throw new DashboardFetchError('invalid_key', 'The service account key is not valid JSON. Paste the whole downloaded .json file.')
  }
  const o = (v ?? {}) as Partial<ServiceAccount> & { type?: string }
  if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY')) {
    throw new DashboardFetchError('invalid_key', 'This JSON is not a service account key (it needs client_email and private_key).')
  }
  return { client_email: o.client_email, private_key: o.private_key, token_uri: typeof o.token_uri === 'string' ? o.token_uri : undefined }
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url')

/** The signed JWT assertion for the token exchange (RFC 7523). */
export function serviceAccountJwt(sa: ServiceAccount, now: Date, scope = GSC_SCOPE): string {
  const iat = Math.floor(now.getTime() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }))
  let sig: string
  try {
    sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url')
  } catch {
    throw new DashboardFetchError('invalid_key', 'The service account’s private key could not be read. Download a fresh JSON key.')
  }
  return `${head}.${claims}.${sig}`
}

/** Exchanges the JWT for an access token. 400/401 from Google here means the key itself is bad or disabled. */
export async function googleAccessToken(http: HttpFn, sa: ServiceAccount, now: Date): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(sa, now) }).toString()
  const res = await http({ url: TOKEN_URL, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  const token = (res.body as { access_token?: unknown } | null)?.access_token
  if (res.status === 200 && typeof token === 'string') return token
  if (res.status === 429) throw new DashboardFetchError('rate_limited', 'Google is rate limiting sign-ins. The dashboard will try again later.')
  if (res.status >= 500) throw new DashboardFetchError('unavailable', `Google sign-in answered HTTP ${res.status}. Try again later.`)
  throw new DashboardFetchError('invalid_key', 'Google refused this service account key. It may be deleted or disabled; download a new JSON key.')
}

interface GscRow {
  keys?: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Totals over date rows: clicks, impressions, CTR and the impression-weighted average position. */
export function gscTotals(rows: GscRow[]): { clicks: number; impressions: number; ctr: number | null; position: number | null } {
  let clicks = 0
  let impressions = 0
  let weighted = 0
  for (const r of rows) {
    clicks += r.clicks
    impressions += r.impressions
    weighted += r.position * r.impressions
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? weighted / impressions : null }
}

/** "sc-domain:example.com" → https://example.com/; a URL-prefix property stays as it is. */
export function homeUrl(siteUrl: string): string | null {
  if (siteUrl.startsWith('sc-domain:')) return `https://${siteUrl.slice('sc-domain:'.length)}/`
  return /^https?:\/\//.test(siteUrl) ? siteUrl : null
}

const siteOf = (ctx: ProviderCtx): string => {
  const site = configText(ctx.config.siteUrl)
  if (!site) throw new DashboardFetchError('config', 'Set the Search Console property (sc-domain:example.com or https://example.com/).')
  return site
}
const hints = (sa: ServiceAccount) => ({
  forbidden: `Add ${sa.client_email} as a user of this property in Search Console (Settings → Users and permissions).`,
  config: 'Check the property: a domain property is written sc-domain:example.com, a URL-prefix one with its full https:// URL and trailing slash.'
})

async function query(http: HttpFn, token: string, site: string, body: object, secrets: string[], sa: ServiceAccount): Promise<GscRow[]> {
  const res = await getJson<{ rows?: GscRow[] }>(
    http,
    { url: `${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { provider: 'Search Console', secrets, hints: hints(sa) }
  )
  return res.rows ?? []
}

/** PageSpeed mobile performance (0-100) and LCP (s). Optional: any failure becomes a warning. */
async function pageSpeed(ctx: ProviderCtx, url: string): Promise<{ score: number | null; lcp: number | null; warning?: string }> {
  const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance' })
  if (ctx.keys.PAGESPEED_API_KEY) q.set('key', ctx.keys.PAGESPEED_API_KEY)
  try {
    const res = await getJson<{ lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, { numericValue?: number }> } }>(
      ctx.http,
      { url: `${PSI}?${q}`, timeoutMs: 60_000 },
      { provider: 'PageSpeed', secrets: secretsOf(ctx) }
    )
    const score = res.lighthouseResult?.categories?.performance?.score
    const lcp = res.lighthouseResult?.audits?.['largest-contentful-paint']?.numericValue
    return { score: typeof score === 'number' ? Math.round(score * 100) : null, lcp: typeof lcp === 'number' ? lcp / 1000 : null }
  } catch (e) {
    return { score: null, lcp: null, warning: e instanceof DashboardFetchError ? `PageSpeed: ${e.message}` : 'PageSpeed did not answer.' }
  }
}

export const gscProvider: DashboardProvider = {
  kind: 'gsc',
  async validate(ctx) {
    const sa = parseServiceAccount(ctx.keys.GSC_SERVICE_ACCOUNT_JSON)
    const site = siteOf(ctx)
    const token = await googleAccessToken(ctx.http, sa, ctx.now)
    await getJson(ctx.http, { url: `${API}/sites/${encodeURIComponent(site)}`, headers: { Authorization: `Bearer ${token}` } }, { provider: 'Search Console', secrets: secretsOf(ctx), hints: hints(sa) })
    if (ctx.keys.PAGESPEED_API_KEY) {
      // a cheap authenticated call: a bad key answers 400 "API key not valid" before any analysis runs
      const q = new URLSearchParams({ url: 'https://example.com/', key: ctx.keys.PAGESPEED_API_KEY, category: 'performance' })
      const res = await ctx.http({ url: `${PSI}?${q}`, timeoutMs: 60_000 })
      if (res.status === 400 || res.status === 403) throw new DashboardFetchError('invalid_key', 'Google rejected the PageSpeed API key. Leave it empty to run without one.')
    }
  },
  async fetch(ctx) {
    const sa = parseServiceAccount(ctx.keys.GSC_SERVICE_ACCOUNT_JSON)
    const site = siteOf(ctx)
    const secrets = secretsOf(ctx)
    const token = await googleAccessToken(ctx.http, sa, ctx.now)
    const end = isoDay(ctx.now, LAG_DAYS)
    const start = isoDay(ctx.now, LAG_DAYS + WINDOW - 1)
    const prevEnd = isoDay(ctx.now, LAG_DAYS + WINDOW)
    const prevStart = isoDay(ctx.now, LAG_DAYS + 2 * WINDOW - 1)
    const psUrl = configText(ctx.config.pageSpeedUrl) || homeUrl(site)
    const [daily, queries, pages, speed] = await Promise.all([
      query(ctx.http, token, site, { startDate: prevStart, endDate: end, dimensions: ['date'], rowLimit: 200 }, secrets, sa),
      query(ctx.http, token, site, { startDate: start, endDate: end, dimensions: ['query'], rowLimit: 10 }, secrets, sa),
      query(ctx.http, token, site, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 10 }, secrets, sa),
      psUrl ? pageSpeed(ctx, psUrl) : Promise.resolve({ score: null, lcp: null })
    ])
    if (!daily.length) throw new DashboardFetchError('no_data', 'Search Console has no data for this property in the last 8 weeks. New properties take a few days to fill.')
    const cur = gscTotals(daily.filter((r) => (r.keys?.[0] ?? '') >= start))
    const prev = gscTotals(daily.filter((r) => (r.keys?.[0] ?? '') >= prevStart && (r.keys?.[0] ?? '') <= prevEnd))
    const days = daily.filter((r) => (r.keys?.[0] ?? '') >= start).sort((a, b) => (a.keys![0] < b.keys![0] ? -1 : 1))
    const row = (r: GscRow, key: string): TableRow => ({ [key]: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })
    const snap: DashboardSnapshot = {
      fetchedAt: ctx.now.toISOString(),
      period: `${start} – ${end} vs the 28 days before`,
      kpis: {
        clicks: { value: cur.clicks, previous: prev.clicks },
        impressions: { value: cur.impressions, previous: prev.impressions },
        ctr: { value: cur.ctr, previous: prev.ctr },
        position: { value: cur.position, previous: prev.position },
        pagespeed: { value: speed.score, previous: null },
        lcp: { value: speed.lcp, previous: null }
      },
      series: {
        daily: [
          { label: 'Clicks', points: days.map((r) => ({ t: r.keys![0], v: r.clicks })) },
          { label: 'Impressions', points: days.map((r) => ({ t: r.keys![0], v: r.impressions })) }
        ]
      },
      tables: { queries: queries.map((r) => row(r, 'query')), pages: pages.map((r) => row(r, 'page')) }
    }
    if ('warning' in speed && speed.warning) snap.warnings = [speed.warning]
    return snap
  }
}
