/**
 * DASHBOARDS.md §4: the one HTTP path every dashboard provider uses. Providers get an `HttpFn` (real fetch in the app,
 * a fixture router in tests and in HIVE_DASHBOARD_FIXTURES mode), and `getJson` maps HTTP statuses to the fixed
 * dashboard error codes. Error messages are built from the status and the provider name only, and anything quoted from
 * a provider body is scrubbed of the request's secrets first: a key never reaches a status, a log or the renderer.
 * No Electron imports.
 */
import type { DashboardErrorCode } from '../../shared/dashboards'

export const DASHBOARD_HTTP_TIMEOUT_MS = 20_000

export interface HttpReq {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}
export interface HttpRes {
  status: number
  /** parsed JSON, or the raw text when the body is not JSON, or null when empty */
  body: unknown
  retryAfter: string | null
}
export type HttpFn = (req: HttpReq) => Promise<HttpRes>

/** A provider failure with a fixed code. `message` is safe to show and store. */
export class DashboardFetchError extends Error {
  constructor(
    readonly code: DashboardErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DashboardFetchError'
  }
}

/** The real transport: fetch with a hard timeout, no redirects followed, no caching. Never throws for an HTTP status. */
export function realHttp(fetchImpl: typeof fetch = fetch): HttpFn {
  return async (req) => {
    const signal = AbortSignal.timeout(req.timeoutMs ?? DASHBOARD_HTTP_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetchImpl(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, redirect: 'manual', cache: 'no-store', signal })
    } catch {
      // DNS, TLS, timeout or offline. The error is dropped on purpose: it can quote the request.
      throw new DashboardFetchError('network', 'Could not reach the service. Check your connection and try again.')
    }
    const text = await res.text().catch(() => '')
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
  }
}

/** Every secret value replaced by •••• (longest first), then token shapes (Bearer …, sk_/rk_/pplx-/phx_/ghp_ …) too. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of [...secrets].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('••••')
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ••••')
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_••••')
    .replace(/\b(sk-|pplx-|phx_|ghp_|gho_|github_pat_)[A-Za-z0-9_-]+/g, '$1••••')
}

/** The provider's own error text, when it has one (Stripe, Google, GitHub and Plausible shapes), scrubbed and capped. */
export function providerMessage(body: unknown, secrets: readonly string[]): string | null {
  let m: unknown = null
  if (typeof body === 'string') m = body
  else if (body && typeof body === 'object') {
    const o = body as { error?: unknown; message?: unknown; detail?: unknown; error_description?: unknown }
    if (typeof o.error === 'string') m = o.error_description ?? o.error
    else if (o.error && typeof o.error === 'object') m = (o.error as { message?: unknown }).message
    m ??= o.message ?? o.detail
  }
  if (typeof m !== 'string' || !m.trim()) return null
  const s = scrub(m.trim().replace(/\s+/g, ' '), secrets)
  return s.length > 200 ? `${s.slice(0, 199)}…` : s
}

/** Status → fixed code. 400/404/422 are configuration problems (wrong site, wrong project), not key problems. */
export function codeForStatus(status: number): DashboardErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (status === 401) return 'invalid_key'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 404 || status === 422) return 'config'
  return 'unavailable'
}

export interface GetJsonOpts {
  /** "Stripe", "Search Console" … for the message */
  provider: string
  /** values to scrub from any quoted provider text */
  secrets: readonly string[]
  /** extra wording per code ("Give the key Read on Charges") */
  hints?: Partial<Record<DashboardErrorCode, string>>
}

/** One request; a non-2xx status throws a DashboardFetchError with a safe message. */
export async function getJson<T = unknown>(http: HttpFn, req: HttpReq, opts: GetJsonOpts): Promise<T> {
  const res = await http(req)
  let code = codeForStatus(res.status)
  if (!code) return res.body as T
  const quoted = providerMessage(res.body, opts.secrets)
  // a 403 that says the key itself is no good (PostHog: "Personal API key … is invalid") is a turned-down key, not a
  // missing permission: the key is off for everything, not only for this dashboard
  if (code === 'forbidden' && quoted && /\b(key|token)\b[^.]{0,80}\b(invalid|not valid|revoked|expired)\b|\b(invalid|revoked|expired)\b[^.]{0,20}\b(key|token)\b/i.test(quoted)) code = 'invalid_key'
  const base: Record<DashboardErrorCode, string> = {
    invalid_key: `${opts.provider} rejected the key. Check that it was copied whole and has not been revoked.`,
    forbidden: `${opts.provider} accepted the key but it is missing a permission.`,
    rate_limited: `${opts.provider} is rate limiting requests${res.retryAfter ? ` (retry in ${res.retryAfter}s)` : ''}. The dashboard will try again later.`,
    config: `${opts.provider} could not find what this dashboard asked for.`,
    unavailable: `${opts.provider} answered with an error (HTTP ${res.status}). Try again later.`,
    network: 'Could not reach the service.',
    no_data: 'No data yet.'
  }
  const hint = opts.hints?.[code]
  throw new DashboardFetchError(code, [base[code], hint, quoted ? `${opts.provider} said: “${quoted}”` : null].filter(Boolean).join(' '))
}

/** ISO date (YYYY-MM-DD, UTC) `days` before `now`. */
export function isoDay(now: Date, days = 0): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}
