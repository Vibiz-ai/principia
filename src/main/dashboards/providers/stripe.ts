/**
 * DASHBOARDS.md §5.4: Stripe revenue. Reads subscriptions (status=all), customers and charges with a restricted
 * read-only key, then computes every metric locally (`computeStripe`, pure, unit-tested on fixtures):
 *
 * - **MRR** at a moment: each subscription that is *paying* then (started, past its trial, not yet ended, not
 *   incomplete) contributes its items' unit_amount × quantity normalised to a month, less a percent-off coupon.
 *   Historical MRR uses today's prices (Stripe keeps no price history on the subscription).
 * - **Paying customers** at a moment: customers with at least one paying subscription then.
 * - **Churned** over a window: paying at its start, paying nothing at its end. **Churn rate** = churned ÷ paying at start.
 * - **New customers**: Stripe customers created in the window.
 * - **Net revenue**: succeeded charges minus refunded amounts in the window. **Failed payments**: failed charges.
 * - **ARPU** = MRR ÷ paying customers.
 * Only the main currency (the one most MRR is in) is summed; other currencies are reported as a warning.
 */
import type { DashboardSnapshot, Series, TableRow } from '../../../shared/dashboards'
import { DashboardFetchError, getJson, type HttpFn } from '../http'
import { secretsOf, type DashboardProvider, type ProviderCtx } from './types'

const API = 'https://api.stripe.com/v1'
/** Pinned so `subscription.discount` keeps its single-object shape. */
const STRIPE_VERSION = '2024-06-20'
const PAGE = 100
/** Up to 2,000 rows per list; beyond that the dashboard says the numbers are capped. */
export const STRIPE_MAX_PAGES = 20
const DAY = 86_400
const WINDOW_DAYS = 30
const MONTHS = 12

export interface StripePrice {
  id?: string
  nickname?: string | null
  unit_amount: number | null
  currency: string
  recurring: { interval: 'day' | 'week' | 'month' | 'year'; interval_count: number } | null
  product?: string | { name?: string } | null
}
export interface StripeSubscription {
  id: string
  customer: string | { id: string }
  status: string
  created: number
  start_date: number
  trial_end?: number | null
  ended_at?: number | null
  canceled_at?: number | null
  items: { data: { price: StripePrice; quantity?: number | null }[] }
  discount?: { coupon?: { percent_off?: number | null } | null } | null
}
export interface StripeCustomer {
  id: string
  created: number
}
export interface StripeCharge {
  id: string
  amount: number
  amount_refunded: number
  currency: string
  status: 'succeeded' | 'pending' | 'failed'
  created: number
  failure_message?: string | null
  billing_details?: { email?: string | null; name?: string | null } | null
  customer?: string | { id: string } | null
}

const custId = (c: string | { id: string } | null | undefined): string | null => (c == null ? null : typeof c === 'string' ? c : c.id)

/** Monthly value of one recurring price × quantity, in the price's minor unit. One-off prices count 0. */
export function monthlyAmount(price: StripePrice, quantity = 1): number {
  if (!price.recurring || price.unit_amount == null) return 0
  const n = Math.max(1, price.recurring.interval_count || 1)
  const per = price.unit_amount * (quantity ?? 1)
  switch (price.recurring.interval) {
    case 'month':
      return per / n
    case 'year':
      return per / (12 * n)
    case 'week':
      return (per * 52) / 12 / n
    case 'day':
      return (per * 365) / 12 / n
  }
}

/** A subscription's MRR contribution (minor units) in its currency, after a percent-off coupon. */
export function subscriptionMrr(sub: StripeSubscription): { amount: number; currency: string | null } {
  let amount = 0
  let currency: string | null = null
  for (const item of sub.items?.data ?? []) {
    amount += monthlyAmount(item.price, item.quantity ?? 1)
    currency ??= item.price.currency
  }
  const pct = sub.discount?.coupon?.percent_off
  if (pct) amount *= 1 - pct / 100
  return { amount, currency }
}

const NEVER_PAID = new Set(['incomplete', 'incomplete_expired'])

/** Paying at `t` (unix seconds): started, past any trial, not ended. `now` decides today's live statuses. */
export function payingAt(sub: StripeSubscription, t: number, now: number): boolean {
  if (NEVER_PAID.has(sub.status)) return false
  const from = Math.max(sub.start_date, sub.trial_end ?? 0)
  if (from > t) return false
  const end = sub.ended_at ?? null
  if (end != null && end <= t) return false
  // a subscription still trialing today was not paying at any earlier moment either (from > t covers that); one that
  // is paused or unpaid today counts as not paying now
  if (t >= now && (sub.status === 'paused' || sub.status === 'trialing' || sub.status === 'unpaid')) return false
  return true
}

export interface StripeInput {
  subscriptions: StripeSubscription[]
  customers: StripeCustomer[]
  charges: StripeCharge[]
  now: Date
  /** a list hit STRIPE_MAX_PAGES */
  capped?: string[]
}

/** The main currency: the one carrying the most current MRR (else the most charges), default usd. */
export function mainCurrency(subs: StripeSubscription[], charges: StripeCharge[], now: number): string {
  const tally = new Map<string, number>()
  for (const s of subs) {
    if (!payingAt(s, now, now)) continue
    const { amount, currency } = subscriptionMrr(s)
    if (currency) tally.set(currency, (tally.get(currency) ?? 0) + amount)
  }
  if (!tally.size) for (const c of charges) tally.set(c.currency, (tally.get(c.currency) ?? 0) + 1)
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'usd'
}

export function mrrAt(subs: StripeSubscription[], t: number, now: number, currency: string): number {
  let total = 0
  for (const s of subs) {
    if (!payingAt(s, t, now)) continue
    const m = subscriptionMrr(s)
    if (m.currency === currency) total += m.amount
  }
  return total
}

export function payingCustomersAt(subs: StripeSubscription[], t: number, now: number): Set<string> {
  const out = new Set<string>()
  for (const s of subs) {
    const id = custId(s.customer)
    if (id && payingAt(s, t, now)) out.add(id)
  }
  return out
}

/** Customers paying at `from` and paying nothing at `to`, and the rate against those paying at `from`. */
export function churnBetween(subs: StripeSubscription[], from: number, to: number, now: number): { churned: number; base: number; rate: number | null } {
  const before = payingCustomersAt(subs, from, now)
  const after = payingCustomersAt(subs, to, now)
  let churned = 0
  for (const c of before) if (!after.has(c)) churned++
  return { churned, base: before.size, rate: before.size ? churned / before.size : null }
}

const inWindow = (t: number, from: number, to: number): boolean => t > from && t <= to

/** Unix seconds of the end of each of the last `n` calendar months (UTC), oldest first; the last one is `now`. */
export function monthEnds(now: Date, n: number): number[] {
  const out: number[] = []
  for (let i = n - 1; i >= 1; i--) out.push(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1) / 1000 - 1)
  out.push(Math.floor(now.getTime() / 1000))
  return out
}
const monthLabel = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7)

/** Everything the Stripe dashboard shows, from raw lists. Amounts are in major units of the main currency. */
export function computeStripe(input: StripeInput): DashboardSnapshot {
  const now = Math.floor(input.now.getTime() / 1000)
  const w0 = now - WINDOW_DAYS * DAY
  const w1 = now - 2 * WINDOW_DAYS * DAY
  const subs = input.subscriptions
  const currency = mainCurrency(subs, input.charges, now)
  const major = (minor: number): number => Math.round(minor) / 100

  const mrrNow = mrrAt(subs, now, now, currency)
  const mrrThen = mrrAt(subs, w0, now, currency)
  const payingNow = payingCustomersAt(subs, now, now).size
  const payingThen = payingCustomersAt(subs, w0, now).size
  const churn = churnBetween(subs, w0, now, now)
  const churnPrev = churnBetween(subs, w1, w0, now)
  const newCustomers = input.customers.filter((c) => inWindow(c.created, w0, now)).length
  const newCustomersPrev = input.customers.filter((c) => inWindow(c.created, w1, w0)).length
  const charges = input.charges.filter((c) => c.currency === currency)
  const net = (from: number, to: number): number =>
    charges.filter((c) => c.status === 'succeeded' && inWindow(c.created, from, to)).reduce((sum, c) => sum + c.amount - (c.amount_refunded ?? 0), 0)
  const failed = (from: number, to: number): StripeCharge[] => input.charges.filter((c) => c.status === 'failed' && inWindow(c.created, from, to))

  // monthly trends: MRR at each month end, new and churned customers inside each month
  const ends = monthEnds(input.now, MONTHS)
  const mrrPoints = ends.map((t) => ({ t: monthLabel(t), v: major(mrrAt(subs, t, now, currency)) }))
  const newPoints: Series['points'] = []
  const churnPoints: Series['points'] = []
  ends.forEach((t, i) => {
    const start = i === 0 ? Date.UTC(new Date(t * 1000).getUTCFullYear(), new Date(t * 1000).getUTCMonth(), 1) / 1000 - 1 : ends[i - 1]
    newPoints.push({ t: monthLabel(t), v: input.customers.filter((c) => inWindow(c.created, start, t)).length })
    churnPoints.push({ t: monthLabel(t), v: churnBetween(subs, start, t, now).churned })
  })

  // MRR by plan (product name, else price nickname, else price id)
  const plans = new Map<string, { subscribers: number; mrr: number }>()
  for (const s of subs) {
    if (!payingAt(s, now, now)) continue
    const m = subscriptionMrr(s)
    if (m.currency !== currency) continue
    const p = s.items.data[0]?.price
    const name = (p && typeof p.product === 'object' && p.product?.name) || p?.nickname || p?.id || 'Plan'
    const row = plans.get(name) ?? { subscribers: 0, mrr: 0 }
    row.subscribers++
    row.mrr += m.amount
    plans.set(name, row)
  }
  const planRows: TableRow[] = [...plans]
    .sort((a, b) => b[1].mrr - a[1].mrr)
    .slice(0, 8)
    .map(([plan, r]) => ({ plan, subscribers: r.subscribers, mrr: major(r.mrr) }))
  const failureRows: TableRow[] = failed(w0, now)
    .sort((a, b) => b.created - a.created)
    .slice(0, 8)
    .map((c) => ({
      when: new Date(c.created * 1000).toISOString().slice(0, 10),
      customer: c.billing_details?.email || c.billing_details?.name || custId(c.customer) || '—',
      amount: c.currency === currency ? major(c.amount) : null,
      reason: c.failure_message || 'Declined'
    }))

  const warnings: string[] = []
  const other = new Set(subs.filter((s) => payingAt(s, now, now)).map((s) => subscriptionMrr(s).currency).filter((c) => c && c !== currency))
  if (other.size) warnings.push(`Only ${currency.toUpperCase()} is summed; subscriptions in ${[...other].map((c) => c!.toUpperCase()).join(', ')} are left out.`)
  for (const what of input.capped ?? []) warnings.push(`Stopped after ${STRIPE_MAX_PAGES * PAGE} ${what}; older ones are not counted.`)

  return {
    fetchedAt: input.now.toISOString(),
    period: 'Last 30 days vs the 30 before',
    currency: currency.toUpperCase(),
    kpis: {
      mrr: { value: major(mrrNow), previous: major(mrrThen) },
      newCustomers: { value: newCustomers, previous: newCustomersPrev },
      churned: { value: churn.churned, previous: churnPrev.churned },
      churnRate: { value: churn.rate, previous: churnPrev.rate },
      netRevenue: { value: major(net(w0, now)), previous: major(net(w1, w0)) },
      failedPayments: { value: failed(w0, now).length, previous: failed(w1, w0).length },
      arpu: { value: payingNow ? major(mrrNow / payingNow) : null, previous: payingThen ? major(mrrThen / payingThen) : null },
      payingCustomers: { value: payingNow, previous: payingThen }
    },
    series: {
      mrrTrend: [{ label: 'MRR', points: mrrPoints }],
      customerFlow: [
        { label: 'New', points: newPoints },
        { label: 'Churned', points: churnPoints }
      ]
    },
    tables: { plans: planRows, failures: failureRows },
    ...(warnings.length ? { warnings } : {})
  }
}

// ---------- fetching ----------

const headers = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION, Accept: 'application/json' })
const HINTS = {
  forbidden: 'Edit the restricted key in Stripe and set Customers, Subscriptions and Charges to Read.',
  invalid_key: 'Paste a restricted key (rk_live_… or rk_test_…).'
}

/** All pages of a Stripe list (cursor pagination), up to STRIPE_MAX_PAGES. */
export async function listAll<T extends { id: string }>(http: HttpFn, key: string, path: string, params: Record<string, string>): Promise<{ data: T[]; capped: boolean }> {
  const out: T[] = []
  let after: string | null = null
  for (let page = 0; page < STRIPE_MAX_PAGES; page++) {
    const q: URLSearchParams = new URLSearchParams({ ...params, limit: String(PAGE), ...(after ? { starting_after: after } : {}) })
    const res: { data: T[]; has_more: boolean } = await getJson<{ data: T[]; has_more: boolean }>(http, { url: `${API}/${path}?${q}`, headers: headers(key) }, { provider: 'Stripe', secrets: [key], hints: HINTS })
    out.push(...(res.data ?? []))
    if (!res.has_more || !res.data?.length) return { data: out, capped: false }
    after = res.data[res.data.length - 1].id
  }
  return { data: out, capped: true }
}

/** A restricted key only: a secret key (sk_) can move money, so this dashboard refuses it. */
export function checkStripeKey(key: string | undefined): string {
  const k = (key ?? '').trim()
  if (/^sk_(live|test)_/.test(k)) throw new DashboardFetchError('config', 'That is a secret key, which can move money. Create a restricted key with Read on Customers, Subscriptions and Charges instead.')
  if (!/^rk_(live|test)_[A-Za-z0-9]{8,}$/.test(k)) throw new DashboardFetchError('invalid_key', 'A restricted key starts with rk_live_ or rk_test_.')
  return k
}

export const stripeProvider: DashboardProvider = {
  kind: 'stripe',
  async validate(ctx: ProviderCtx) {
    const key = checkStripeKey(ctx.keys.STRIPE_RESTRICTED_KEY)
    // one read per resource the dashboard needs, so a missing permission shows now and not on the first refresh
    for (const [path, what] of [['subscriptions', 'Subscriptions'], ['customers', 'Customers'], ['charges', 'Charges']] as const) {
      await getJson(ctx.http, { url: `${API}/${path}?limit=1${path === 'subscriptions' ? '&status=all' : ''}`, headers: headers(key) }, {
        provider: 'Stripe',
        secrets: secretsOf(ctx),
        hints: { ...HINTS, forbidden: `The key cannot read ${what}. ${HINTS.forbidden}` }
      })
    }
  },
  async fetch(ctx: ProviderCtx) {
    const key = checkStripeKey(ctx.keys.STRIPE_RESTRICTED_KEY)
    const now = Math.floor(ctx.now.getTime() / 1000)
    const yearAgo = String(now - 366 * DAY)
    const [subs, customers, charges] = await Promise.all([
      listAll<StripeSubscription>(ctx.http, key, 'subscriptions', { status: 'all', 'expand[]': 'data.items.data.price.product' }),
      listAll<StripeCustomer>(ctx.http, key, 'customers', { 'created[gte]': yearAgo }),
      listAll<StripeCharge>(ctx.http, key, 'charges', { 'created[gte]': String(now - 2 * WINDOW_DAYS * DAY) })
    ])
    const capped = [subs.capped && 'subscriptions', customers.capped && 'customers', charges.capped && 'charges'].filter((x): x is string => !!x)
    if (!subs.data.length && !customers.data.length && !charges.data.length) throw new DashboardFetchError('no_data', 'This Stripe account has no customers, subscriptions or charges yet.')
    return computeStripe({ subscriptions: subs.data, customers: customers.data, charges: charges.data, now: ctx.now, capped })
  }
}
