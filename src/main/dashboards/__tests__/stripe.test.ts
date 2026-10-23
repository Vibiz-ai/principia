import { describe, expect, it } from 'vitest'
import type { HttpFn, HttpReq } from '../http'
import { DashboardFetchError } from '../http'
import { fixtureHttp, stripeFixture } from '../fixtures'
import {
  STRIPE_MAX_PAGES,
  checkStripeKey,
  churnBetween,
  computeStripe,
  listAll,
  monthlyAmount,
  mrrAt,
  payingAt,
  stripeProvider,
  subscriptionMrr,
  type StripeCharge,
  type StripeSubscription
} from '../providers/stripe'

const NOW = new Date('2026-10-23T12:00:00Z')
const T = Math.floor(NOW.getTime() / 1000)
const DAY = 86_400
const KEY = 'rk_test_51abcdefghijklmnop'

const price = (unit: number, interval: 'month' | 'year' | 'week' | 'day' = 'month', count = 1) => ({ unit_amount: unit, currency: 'usd', recurring: { interval, interval_count: count }, nickname: interval === 'year' ? 'Annual' : 'Monthly' })
const sub = (id: string, customer: string, startDaysAgo: number, unit: number, extra: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id,
  customer,
  status: 'active',
  created: T - startDaysAgo * DAY,
  start_date: T - startDaysAgo * DAY,
  items: { data: [{ price: price(unit), quantity: 1 }] },
  ...extra
})
const charge = (id: string, daysAgo: number, amount: number, extra: Partial<StripeCharge> = {}): StripeCharge => ({ id, amount, amount_refunded: 0, currency: 'usd', status: 'succeeded', created: T - daysAgo * DAY, ...extra })

describe('Stripe metric maths', () => {
  it('normalises every interval to a month', () => {
    expect(monthlyAmount(price(1000))).toBe(1000)
    expect(monthlyAmount(price(12000, 'year'))).toBe(1000)
    expect(monthlyAmount(price(3000, 'month', 3))).toBe(1000)
    expect(monthlyAmount(price(1200, 'week'))).toBeCloseTo(5200)
    expect(monthlyAmount({ unit_amount: 500, currency: 'usd', recurring: null })).toBe(0)
    expect(monthlyAmount(price(1000), 3)).toBe(3000)
  })

  it('applies a percent-off coupon', () => {
    expect(subscriptionMrr(sub('s', 'c', 10, 10000, { discount: { coupon: { percent_off: 25 } } })).amount).toBe(7500)
  })

  it('counts a subscription as paying only after its trial and before it ended', () => {
    const trial = sub('s', 'c', 20, 1000, { trial_end: T - 6 * DAY })
    expect(payingAt(trial, T - 10 * DAY, T)).toBe(false)
    expect(payingAt(trial, T, T)).toBe(true)
    const ended = sub('s2', 'c', 100, 1000, { status: 'canceled', ended_at: T - 5 * DAY })
    expect(payingAt(ended, T - 10 * DAY, T)).toBe(true)
    expect(payingAt(ended, T, T)).toBe(false)
    expect(payingAt(sub('s3', 'c', 5, 1000, { status: 'incomplete' }), T, T)).toBe(false)
    expect(payingAt(sub('s4', 'c', 50, 1000, { status: 'unpaid' }), T, T)).toBe(false)
  })

  it('computes MRR, churn and churn rate at customer level', () => {
    const subs = [
      sub('a', 'cus_a', 200, 10000),
      sub('b', 'cus_b', 200, 5000, { status: 'canceled', ended_at: T - 10 * DAY }), // churned in the window
      sub('c1', 'cus_c', 200, 2000, { status: 'canceled', ended_at: T - 10 * DAY }), // upgraded, not churned:
      sub('c2', 'cus_c', 10, 4000),
      sub('d', 'cus_d', 5, 2900), // new in the window
      sub('e', 'cus_e', 100, 12000 * 12, { items: { data: [{ price: price(120000, 'year'), quantity: 1 }] } })
    ]
    expect(mrrAt(subs, T, T, 'usd')).toBe(10000 + 4000 + 2900 + 10000)
    expect(mrrAt(subs, T - 30 * DAY, T, 'usd')).toBe(10000 + 5000 + 2000 + 10000)
    const churn = churnBetween(subs, T - 30 * DAY, T, T)
    expect(churn).toEqual({ churned: 1, base: 4, rate: 0.25 })
  })

  it('builds the snapshot: KPIs with previous values, monthly trends, plans and failures', () => {
    const subs = [sub('a', 'cus_a', 200, 10000), sub('b', 'cus_b', 200, 5000, { status: 'canceled', ended_at: T - 10 * DAY }), sub('d', 'cus_d', 5, 2900)]
    const customers = [
      { id: 'cus_a', created: T - 200 * DAY },
      { id: 'cus_b', created: T - 200 * DAY },
      { id: 'cus_d', created: T - 5 * DAY },
      { id: 'cus_x', created: T - 3 * DAY },
      { id: 'cus_y', created: T - 45 * DAY }
    ]
    const charges = [
      charge('ch1', 2, 10000),
      charge('ch2', 3, 2900, { amount_refunded: 2900 }),
      charge('ch3', 4, 5000, { status: 'failed', failure_message: 'Your card was declined.', billing_details: { email: 'b@example.com' } }),
      charge('ch4', 40, 10000),
      charge('ch5', 41, 5000, { status: 'failed' }),
      charge('ch6', 1, 999, { currency: 'eur' })
    ]
    const s = computeStripe({ subscriptions: subs, customers, charges, now: NOW })
    expect(s.currency).toBe('USD')
    expect(s.kpis.mrr).toEqual({ value: 129, previous: 150 })
    expect(s.kpis.newCustomers).toEqual({ value: 2, previous: 1 })
    expect(s.kpis.churned.value).toBe(1)
    expect(s.kpis.churnRate.value).toBe(0.5)
    expect(s.kpis.netRevenue).toEqual({ value: 100, previous: 100 })
    expect(s.kpis.failedPayments).toEqual({ value: 1, previous: 1 })
    expect(s.kpis.payingCustomers).toEqual({ value: 2, previous: 2 })
    expect(s.kpis.arpu.value).toBe(64.5)
    expect(s.series.mrrTrend[0].points).toHaveLength(12)
    expect(s.series.mrrTrend[0].points.at(-1)).toEqual({ t: '2026-10', v: 129 })
    expect(s.series.customerFlow.map((x) => x.label)).toEqual(['New', 'Churned'])
    expect(s.tables.plans[0]).toEqual({ plan: 'Monthly', subscribers: 2, mrr: 129 })
    expect(s.tables.failures).toEqual([{ when: '2026-10-19', customer: 'b@example.com', amount: 50, reason: 'Your card was declined.' }])
  })

  it('warns when subscriptions in another currency are left out', () => {
    const subs = [sub('a', 'cus_a', 50, 10000), { ...sub('b', 'cus_b', 50, 900), items: { data: [{ price: { ...price(900), currency: 'eur' }, quantity: 1 }] } }]
    const s = computeStripe({ subscriptions: subs, customers: [], charges: [], now: NOW })
    expect(s.warnings?.[0]).toMatch(/EUR/)
  })

  it('computes sensible numbers from the sample business', () => {
    const data = stripeFixture(NOW)
    const s = computeStripe({ ...data, now: NOW })
    expect(s.kpis.mrr.value).toBeGreaterThan(1000)
    expect(s.kpis.churnRate.value).toBeGreaterThan(0)
    expect(s.kpis.churnRate.value).toBeLessThan(0.2)
    expect(s.kpis.payingCustomers.value).toBeGreaterThan(20)
  })
})

describe('Stripe key checks and fetching', () => {
  const recorder = (status: number, body: unknown = {}): { http: HttpFn; calls: HttpReq[] } => {
    const calls: HttpReq[] = []
    return { calls, http: async (req) => (calls.push(req), { status, body, retryAfter: null }) }
  }

  it('refuses a secret key before any request and accepts only restricted keys', () => {
    expect(() => checkStripeKey('sk_live_abcdefghijk')).toThrow(/secret key/)
    expect(() => checkStripeKey('pk_live_abcdefghijk')).toThrow(DashboardFetchError)
    expect(checkStripeKey(` ${KEY} `)).toBe(KEY)
  })

  it('validates with one read per resource and maps 401 to invalid_key without quoting the key', async () => {
    const { http, calls } = recorder(401, { error: { message: `Invalid API Key provided: ${KEY}` } })
    const err = await stripeProvider.validate({ http, keys: { STRIPE_RESTRICTED_KEY: KEY }, config: {}, now: NOW, previous: null }).catch((e) => e)
    expect(err).toBeInstanceOf(DashboardFetchError)
    expect(err.code).toBe('invalid_key')
    expect(err.message).not.toContain(KEY)
    expect(err.message).toContain('••••')
    expect(calls).toHaveLength(1)
    expect(calls[0].headers?.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('names the missing permission on 403', async () => {
    let n = 0
    const http: HttpFn = async () => (n++ < 1 ? { status: 200, body: { data: [] }, retryAfter: null } : { status: 403, body: { error: { message: 'The provided key does not have the required permissions' } }, retryAfter: null })
    const err = await stripeProvider.validate({ http, keys: { STRIPE_RESTRICTED_KEY: KEY }, config: {}, now: NOW, previous: null }).catch((e) => e)
    expect(err.code).toBe('forbidden')
    expect(err.message).toMatch(/cannot read Customers/)
  })

  it('maps 429 to rate_limited with the retry hint', async () => {
    const http: HttpFn = async () => ({ status: 429, body: null, retryAfter: '30' })
    const err = await stripeProvider.validate({ http, keys: { STRIPE_RESTRICTED_KEY: KEY }, config: {}, now: NOW, previous: null }).catch((e) => e)
    expect(err.code).toBe('rate_limited')
    expect(err.message).toMatch(/30s/)
  })

  it('follows cursor pagination and stops at the cap', async () => {
    const pages: HttpReq[] = []
    const http: HttpFn = async (req) => {
      pages.push(req)
      const after = new URL(req.url).searchParams.get('starting_after')
      const n = after ? Number(after.slice(3)) : 0
      return { status: 200, body: { data: [{ id: `id_${n + 1}` }], has_more: true }, retryAfter: null }
    }
    const r = await listAll<{ id: string }>(http, KEY, 'customers', {})
    expect(r.capped).toBe(true)
    expect(r.data).toHaveLength(STRIPE_MAX_PAGES)
    expect(new URL(pages[1].url).searchParams.get('starting_after')).toBe('id_1')
  })

  it('fetches the sample account end to end through the fixture transport', async () => {
    const snap = await stripeProvider.fetch({ http: fixtureHttp(() => NOW), keys: { STRIPE_RESTRICTED_KEY: KEY }, config: {}, now: NOW, previous: null })
    expect(snap.kpis.mrr.value).toBe(computeStripe({ ...stripeFixture(NOW), now: NOW }).kpis.mrr.value)
  })

  it('says so when the account is empty', async () => {
    const http: HttpFn = async () => ({ status: 200, body: { data: [], has_more: false }, retryAfter: null })
    const err = await stripeProvider.fetch({ http, keys: { STRIPE_RESTRICTED_KEY: KEY }, config: {}, now: NOW, previous: null }).catch((e) => e)
    expect(err.code).toBe('no_data')
  })
})
