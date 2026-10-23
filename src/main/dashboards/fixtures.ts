/**
 * DASHBOARDS.md §7: sample data. A fake `HttpFn` that answers every URL the providers call with deterministic,
 * realistic payloads, and canned GEO engines. The real provider code runs on top of it (pagination, JWT exchange,
 * metric maths), so the marketplace preview, the unit tests and HIVE_DASHBOARD_FIXTURES mode all exercise the same path
 * as a live key. Any Authorization header containing "invalid" answers 401, which is how the invalid-key state is shown.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { DashboardConfig, DashboardKind } from '../../shared/dashboards'
import type { HttpFn, HttpReq, HttpRes } from './http'
import type { StripeCharge, StripeCustomer, StripeSubscription } from './providers/stripe'
import type { GeoEngine } from './providers/types'

/** mulberry32: a tiny seeded PRNG so every run of the fixtures is identical. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY = 86_400
const ok = (body: unknown): HttpRes => ({ status: 200, body, retryAfter: null })
const fail = (status: number, message: string): HttpRes => ({ status, body: { error: { message } }, retryAfter: null })

// ---------- Stripe ----------

const PLANS = [
  { id: 'price_starter', name: 'Starter', unit: 2900, interval: 'month' as const, weight: 0.5 },
  { id: 'price_pro', name: 'Pro', unit: 9900, interval: 'month' as const, weight: 0.32 },
  { id: 'price_pro_year', name: 'Pro (annual)', unit: 99000, interval: 'year' as const, weight: 0.1 },
  { id: 'price_team', name: 'Team', unit: 29900, interval: 'month' as const, weight: 0.08 }
]

/** A growing SaaS: ~2-4 new customers a week over 14 months, 70% subscribe, ~3.5% monthly churn, a few failed charges. */
export function stripeFixture(now: Date): { subscriptions: StripeSubscription[]; customers: StripeCustomer[]; charges: StripeCharge[] } {
  const rnd = prng(42)
  const end = Math.floor(now.getTime() / 1000)
  const start = end - 425 * DAY
  const customers: StripeCustomer[] = []
  const subscriptions: StripeSubscription[] = []
  const charges: StripeCharge[] = []
  let n = 0
  for (let t = start; t < end; t += Math.floor(DAY * (1 + rnd() * 2.2 * (1 - (t - start) / (end - start) * 0.45)))) {
    const id = `cus_${(++n).toString(36).padStart(6, '0')}`
    customers.push({ id, created: t })
    if (rnd() > 0.7) continue
    let pick = rnd()
    const plan = PLANS.find((p) => (pick -= p.weight) < 0) ?? PLANS[0]
    const trial = rnd() < 0.3 ? t + 14 * DAY : null
    // monthly hazard ~3.5%: draw a lifetime in days from an exponential
    const life = -Math.log(1 - rnd()) * (30 / 0.035) * DAY
    const endedAt = t + life < end ? Math.floor(t + life) : null
    const status = endedAt ? 'canceled' : trial && trial > end ? 'trialing' : rnd() < 0.04 ? 'past_due' : 'active'
    subscriptions.push({
      id: `sub_${n.toString(36)}`,
      customer: id,
      status,
      created: t,
      start_date: t,
      trial_end: trial,
      ended_at: endedAt,
      canceled_at: endedAt,
      items: { data: [{ price: { id: plan.id, nickname: plan.name, unit_amount: plan.unit, currency: 'usd', recurring: { interval: plan.interval, interval_count: 1 }, product: { name: plan.name } }, quantity: plan.name === 'Team' ? 1 + Math.floor(rnd() * 3) : 1 }] },
      discount: rnd() < 0.1 ? { coupon: { percent_off: 20 } } : null
    })
    // one charge per billing period from the first paid day, kept for the last 60 days only
    const period = plan.interval === 'year' ? 365 * DAY : 30 * DAY
    for (let c = trial ?? t; c < (endedAt ?? end); c += period) {
      if (c < end - 60 * DAY) continue
      const failed = rnd() < 0.05
      charges.push({
        id: `ch_${n.toString(36)}_${c}`,
        amount: plan.unit,
        amount_refunded: !failed && rnd() < 0.03 ? plan.unit : 0,
        currency: 'usd',
        status: failed ? 'failed' : 'succeeded',
        created: c,
        failure_message: failed ? (rnd() < 0.5 ? 'Your card was declined.' : 'Your card has insufficient funds.') : null,
        billing_details: { email: `founder${n}@example.com` },
        customer: id
      })
    }
  }
  return { subscriptions: subscriptions.reverse(), customers: customers.reverse(), charges: charges.sort((a, b) => b.created - a.created) }
}

function stripeRoute(req: HttpReq, now: Date): HttpRes {
  const u = new URL(req.url)
  const data = stripeFixture(now)
  const list = u.pathname.endsWith('/subscriptions') ? data.subscriptions : u.pathname.endsWith('/customers') ? data.customers : u.pathname.endsWith('/charges') ? data.charges : null
  if (!list) return fail(404, 'Unrecognized request URL')
  const gte = Number(u.searchParams.get('created[gte]') ?? 0)
  const rows = (list as { created: number }[]).filter((r) => r.created >= gte)
  const limit = Number(u.searchParams.get('limit') ?? 10)
  const after = u.searchParams.get('starting_after')
  const from = after ? rows.findIndex((r) => (r as { id?: string }).id === after) + 1 : 0
  const page = rows.slice(from, from + limit)
  return ok({ object: 'list', data: page, has_more: from + limit < rows.length })
}

// ---------- Search Console / PageSpeed ----------

const QUERIES = ['acme invoicing', 'invoice software for freelancers', 'acme', 'best invoicing app', 'send invoice online', 'recurring invoices', 'invoice template', 'acme pricing', 'stripe invoicing alternative', 'quote to invoice']
const PAGES = ['/', '/pricing', '/blog/invoice-template', '/features/recurring', '/blog/get-paid-faster', '/compare/globex', '/signup', '/blog/late-fees', '/integrations/stripe', '/docs']

function gscRoute(req: HttpReq, now: Date): HttpRes {
  const u = new URL(req.url)
  if (u.hostname === 'oauth2.googleapis.com') return ok({ access_token: 'fixture-access-token', expires_in: 3600, token_type: 'Bearer' })
  if (u.hostname === 'www.googleapis.com') return ok({ lighthouseResult: { categories: { performance: { score: 0.82 } }, audits: { 'largest-contentful-paint': { numericValue: 2480 } } } })
  if (!u.pathname.endsWith('/searchAnalytics/query')) return ok({ siteUrl: decodeURIComponent(u.pathname.split('/sites/')[1] ?? ''), permissionLevel: 'siteRestrictedUser' })
  const body = JSON.parse(req.body ?? '{}') as { dimensions?: string[]; startDate: string; endDate: string }
  const rnd = prng(7)
  const dim = body.dimensions?.[0]
  if (dim === 'date') {
    const rows = []
    for (let d = Date.parse(body.startDate); d <= Date.parse(body.endDate); d += DAY * 1000) {
      const age = (now.getTime() - d) / (DAY * 1000)
      const weekday = new Date(d).getUTCDay()
      const base = 420 - age * 2.2 + (weekday === 0 || weekday === 6 ? -90 : 0)
      const impressions = Math.round(base * 24 * (0.9 + rnd() * 0.2))
      const clicks = Math.round(impressions * (0.042 + age * 0.00008 + rnd() * 0.004))
      rows.push({ keys: [new Date(d).toISOString().slice(0, 10)], clicks, impressions, ctr: clicks / impressions, position: 11.5 + age * 0.03 + rnd() })
    }
    return ok({ rows })
  }
  const names = dim === 'query' ? QUERIES : PAGES.map((p) => `https://acme.example${p}`)
  return ok({ rows: names.map((k, i) => { const impressions = Math.round(18000 / (i + 1.4)); const clicks = Math.round(impressions * (0.09 - i * 0.006)); return { keys: [k], clicks, impressions, ctr: clicks / impressions, position: 2.1 + i * 1.3 } }) })
}

// ---------- Plausible / PostHog ----------

function plausibleRoute(req: HttpReq, now: Date): HttpRes {
  const body = JSON.parse(req.body ?? '{}') as { metrics: string[]; date_range: string | [string, string]; dimensions?: string[] }
  const rnd = prng(11)
  const dim = body.dimensions?.[0]
  if (!dim) {
    const prev = Array.isArray(body.date_range) && body.date_range[1] < now.toISOString().slice(0, 10)
    const k = prev ? 0.86 : 1
    const all: Record<string, number> = { visitors: Math.round(18420 * k), pageviews: Math.round(41250 * k), bounce_rate: prev ? 58 : 54, visit_duration: prev ? 71 : 84 }
    return ok({ results: [{ metrics: body.metrics.map((m) => all[m] ?? 0), dimensions: [] }] })
  }
  if (dim === 'time:day') {
    const [from, to] = body.date_range as [string, string]
    const results = []
    for (let d = Date.parse(from); d <= Date.parse(to); d += DAY * 1000) {
      const wd = new Date(d).getUTCDay()
      results.push({ dimensions: [new Date(d).toISOString().slice(0, 10)], metrics: [Math.round((620 + (d - Date.parse(from)) / (DAY * 1000) * 6) * (wd === 0 || wd === 6 ? 0.7 : 1) * (0.9 + rnd() * 0.2))] })
    }
    return ok({ results })
  }
  const names = dim === 'event:page' ? PAGES : ['Google', 'Direct / None', 'ChatGPT', 'Hacker News', 'Twitter', 'LinkedIn', 'Perplexity', 'Bing', 'Product Hunt', 'Newsletter']
  return ok({ results: names.map((n, i) => ({ dimensions: [n], metrics: [Math.round(6400 / (i + 1.2))] })) })
}

function posthogRoute(req: HttpReq, now: Date): HttpRes {
  if (!req.body) return ok({ id: 12345, name: 'Acme' })
  const q = (JSON.parse(req.body) as { query: { query: string } }).query.query
  const rnd = prng(23)
  if (q.includes('countIf')) return ok({ results: [[52310, 9120, 47800, 8030]] })
  if (q.includes('toDate(timestamp)')) {
    const results = []
    for (let i = 27; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY * 1000)
      const u = Math.round((290 + (27 - i) * 3) * (d.getUTCDay() % 6 === 0 ? 0.72 : 1) * (0.9 + rnd() * 0.2))
      results.push([d.toISOString().slice(0, 10), u, Math.round(u * (5.2 + rnd()))])
    }
    return ok({ results })
  }
  if (q.includes('$pathname')) return ok({ results: ['/app', '/app/invoices', '/', '/pricing', '/app/clients', '/app/settings', '/blog/invoice-template', '/signup', '/app/reports', '/docs'].map((p, i) => [p, Math.round(14000 / (i + 1.1))]) })
  return ok({ results: ['$direct', 'www.google.com', 'chatgpt.com', 'news.ycombinator.com', 't.co', 'www.linkedin.com', 'www.perplexity.ai', 'www.bing.com'].map((r, i) => [r, Math.round(9000 / (i + 1.3))]) })
}

// ---------- GitHub ----------

function githubRoute(req: HttpReq, now: Date): HttpRes {
  const u = new URL(req.url)
  const rnd = prng(5)
  if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return ok({ full_name: u.pathname.slice(7), default_branch: 'main' })
  if (u.pathname.endsWith('/actions/runs')) {
    const names = ['CI', 'CI', 'Deploy', 'CI', 'Lint', 'CI']
    return ok({ workflow_runs: Array.from({ length: 50 }, (_, i) => ({ name: names[i % names.length], head_branch: 'main', status: i === 0 ? 'in_progress' : 'completed', conclusion: i === 0 ? null : rnd() < 0.88 ? 'success' : 'failure', created_at: new Date(now.getTime() - i * 5.5 * 3_600_000).toISOString() })) })
  }
  if (u.pathname === '/search/issues') {
    const q = u.searchParams.get('q') ?? ''
    const per = Number(u.searchParams.get('per_page') ?? 1)
    if (q.includes('is:pr is:open') && per > 1) {
      const titles = ['Add recurring invoice reminders', 'Fix PDF export on Safari', 'Stripe tax: EU VAT rates', 'Speed up dashboard query', 'Bump dependencies', 'Onboarding: skip empty steps', 'Dark mode for invoices', 'Retry failed webhooks']
      return ok({ total_count: 14, items: titles.map((title, i) => ({ title, created_at: new Date(now.getTime() - (i * 1.7 + 0.4) * DAY * 1000).toISOString(), closed_at: null, user: { login: ['livia', 'marcus', 'octavia', 'dependabot[bot]'][i % 4] } })) })
    }
    if (q.includes('is:pr is:open')) return ok({ total_count: 14, items: [] })
    if (q.includes('is:merged') && per > 1) {
      const items = Array.from({ length: 64 }, (_, i) => {
        const merged = now.getTime() - (i * 1.3 + rnd()) * DAY * 1000
        return { title: `PR ${i}`, created_at: new Date(merged - (4 + rnd() * 40) * 3_600_000).toISOString(), closed_at: new Date(merged).toISOString(), pull_request: { merged_at: new Date(merged).toISOString() } }
      })
      return ok({ total_count: 64, items })
    }
    if (q.includes('is:merged merged:>=')) return ok({ total_count: 23, items: [] })
    if (q.includes('is:merged')) return ok({ total_count: 19, items: [] })
    if (q.includes('is:issue is:open')) return ok({ total_count: 37, items: [] })
    if (q.includes('closed:>=')) return ok({ total_count: 21, items: [] })
    return ok({ total_count: 16, items: [] })
  }
  return fail(404, 'Not Found')
}

/** The sample transport. `now` pins every generated date. */
export function fixtureHttp(now: () => Date = () => new Date()): HttpFn {
  return async (req) => {
    const auth = req.headers?.Authorization ?? ''
    if (/invalid/i.test(auth) || /[?&]key=[^&]*invalid/i.test(req.url)) return { status: 401, body: { error: { message: 'Invalid API Key provided' } }, retryAfter: null }
    const host = new URL(req.url).hostname
    const t = now()
    if (host === 'api.stripe.com') return stripeRoute(req, t)
    if (host === 'oauth2.googleapis.com' || host === 'searchconsole.googleapis.com' || host === 'www.googleapis.com') return gscRoute(req, t)
    if (req.url.includes('/api/v2/query')) return plausibleRoute(req, t)
    if (req.url.includes('/api/projects/')) return posthogRoute(req, t)
    if (host === 'api.github.com') return githubRoute(req, t)
    if (host === 'api.openai.com' || host === 'api.perplexity.ai') return ok({ data: [], choices: [{ message: { content: 'ok' } }] })
    return fail(404, 'No fixture for this URL')
  }
}

/** Canned answer engines: deterministic per prompt, naming the brand in roughly half of the answers. */
export function fixtureGeoEngines(config: DashboardConfig): GeoEngine[] {
  const brand = typeof config.brand === 'string' && config.brand.trim() ? config.brand.trim() : 'Acme'
  const competitors = (Array.isArray(config.competitors) ? config.competitors : String(config.competitors ?? '').split('\n')).map((s) => s.trim()).filter(Boolean)
  const domain = typeof config.domain === 'string' ? config.domain.trim() : ''
  const others = competitors.length ? competitors : ['Globex', 'Initech']
  const make = (id: GeoEngine['id'], label: string, bias: number): GeoEngine => ({
    id,
    label,
    async ask(prompt) {
      let h = bias
      for (const c of prompt) h = (h * 31 + c.charCodeAt(0)) >>> 0
      const rnd = prng(h)
      // each competitor shows up in about two answers of three; the brand in a bit over half, at a random place
      const names = others.filter(() => rnd() < 0.68)
      const withBrand = rnd() < 0.58
      if (withBrand) names.splice(Math.floor(rnd() * (names.length + 1)), 0, brand)
      const text = `Here are some good options: ${names.map((n, i) => `${i + 1}. ${n}`).join(' ')}. Each fits a different team size.`
      return { text, citations: id === 'perplexity' && withBrand && domain ? [`https://${domain}/pricing`, 'https://www.g2.com/categories/invoicing'] : id === 'perplexity' ? ['https://www.g2.com/categories/invoicing'] : [] }
    }
  })
  return [make('openai', 'ChatGPT', 3), make('perplexity', 'Perplexity', 17), make('claude', 'Claude', 29)]
}

/** Configs and keys for the marketplace preview (no user input yet). */
export const SAMPLE_CONFIG: Record<DashboardKind, DashboardConfig> = {
  gsc: { siteUrl: 'sc-domain:acme.example' },
  geo: { brand: 'Acme', domain: 'acme.example', competitors: ['Globex', 'Initech', 'Umbrella'], prompts: ['What is the best invoicing tool for freelancers?', 'Alternatives to Globex for small teams', 'How do I automate recurring invoices?', 'Best Stripe-based billing tools'] },
  plausible: { siteId: 'acme.example' },
  posthog: { projectId: '12345' },
  stripe: {},
  github: { repo: 'acme/app' }
}

let sampleSa: string | null = null
/** A real (throwaway) service account JSON, so the preview runs the JWT signing path too. Generated once per process. */
export function sampleServiceAccount(): string {
  if (!sampleSa) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    sampleSa = JSON.stringify({ type: 'service_account', client_email: 'dashboards@acme-sample.iam.gserviceaccount.com', private_key: privateKey })
  }
  return sampleSa
}

export const sampleKeys = (kind: DashboardKind): Record<string, string> =>
  kind === 'stripe' ? { STRIPE_RESTRICTED_KEY: 'rk_test_samplesamplesample' } : kind === 'gsc' ? { GSC_SERVICE_ACCOUNT_JSON: sampleServiceAccount() } : kind === 'plausible' ? { PLAUSIBLE_API_KEY: 'sample' } : kind === 'posthog' ? { POSTHOG_PERSONAL_API_KEY: 'phx_sample' } : kind === 'github' ? { GITHUB_TOKEN: 'sample' } : {}
