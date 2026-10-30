/**
 * DASHBOARDS.md §5.3: activation and churn from a PostHog project. New users and activation come from its events (or a
 * saved view of real signups), paying customers and churn from the Stripe tables synced into PostHog, because billing
 * events overcount: a trial that never paid is not churn. Everything specific to a company (events, exclusions) is its
 * config, and every value is checked before it goes into a query.
 */
import type { DashboardSnapshot, KpiValue, Series, TableRow } from '../../../shared/dashboards'
import { configList, configText } from '../../../shared/dashboards'
import { DashboardFetchError, isoDay } from '../http'
import { hogql, posthogProvider } from './analytics'
import type { DashboardProvider, ProviderCtx } from './types'

const WINDOW = 28
/** A signup counts as activated when it reaches the last step within this many days. */
const ACTIVATION_DAYS = 7
const WEEKS = 8
/** The oldest signup any number here reads: the previous period's cohort, or the first week of the table. */
const SIGNUP_DAYS = Math.max(2 * WINDOW + ACTIVATION_DAYS, WEEKS * 7 + 6)
const MAX_STEPS = 5

const EVENT = /^[\w$.:/ -]{1,120}$/
const VIEW = /^[A-Za-z_]\w*(\.\w+)*$/
const EMAIL_PART = /^[\w.%+@-]{1,120}$/
const SUB_TYPE = /^[\w.-]{1,80}$/

function checked(value: string, shape: RegExp, label: string): string {
  if (!shape.test(value)) throw new DashboardFetchError('config', `${label} “${value.slice(0, 60)}” has characters this dashboard can’t use.`)
  return value
}

interface Setup {
  signupEvent: string
  signupView: string
  steps: string[]
  emails: string[]
  subTypes: string[]
}

/** The company's config, checked. Throws a `config` error for anything that can't go into a query. */
export function activationSetup(ctx: ProviderCtx): Setup {
  const signupEvent = configText(ctx.config.signupEvent)
  const signupView = configText(ctx.config.signupView)
  const steps = configList(ctx.config.steps).slice(0, MAX_STEPS)
  if (!signupEvent && !signupView) throw new DashboardFetchError('config', 'Set the event that marks a new user, or a saved view of signups.')
  if (!steps.length) throw new DashboardFetchError('config', 'Add at least one activation step: the event that means a new user got value.')
  return {
    signupEvent: signupEvent && checked(signupEvent, EVENT, 'The signup event'),
    signupView: signupView && checked(signupView, VIEW, 'The signups view'),
    steps: steps.map((s) => checked(s, EVENT, 'The step')),
    emails: configList(ctx.config.excludeEmails).map((e) => checked(e.toLowerCase(), EMAIL_PART, 'The email')),
    subTypes: configList(ctx.config.excludeSubscriptionTypes).map((t) => checked(t, SUB_TYPE, 'The subscription type'))
  }
}

const quoted = (values: string[]): string => values.map((v) => `'${v}'`).join(', ')
const emailHit = (column: string, parts: string[]): string => parts.map((p) => `position(lower(coalesce(${column}, '')), '${p}') > 0`).join(' OR ')

/** One row per new user (`pid`, `signed_up`): the saved view when set, else each person's first signup event. */
function signupsSql(s: Setup): string {
  if (s.signupView) {
    // a view need not carry emails, so its ids are matched against the people they belong to
    const left = s.emails.length ? ` AND toString(id) NOT IN (SELECT toString(id) FROM persons WHERE ${emailHit('toString(properties.email)', s.emails)})` : ''
    return `SELECT id AS pid, created_at AS signed_up FROM ${s.signupView} WHERE created_at >= now() - INTERVAL ${SIGNUP_DAYS} DAY${left}`
  }
  const skip = s.emails.length ? ` AND NOT (${emailHit('toString(person.properties.email)', s.emails)})` : ''
  return `SELECT person_id AS pid, min(timestamp) AS signed_up FROM events WHERE event = '${s.signupEvent}' AND timestamp >= now() - INTERVAL ${SIGNUP_DAYS} DAY${skip} GROUP BY pid`
}

/**
 * Per signup day: new users, then how many reached each step within the activation window. Events are matched to each
 * person's own signup before they are grouped: something done before signing up is not activation.
 */
export function activationSql(s: Setup): string {
  const signups = signupsSql(s)
  const reached = s.steps.map((_, i) => `countIf(e.step_${i} = 1) AS reached_${i}`).join(', ')
  const hits = s.steps.map((step, i) => `max(ev.event = '${step}') AS step_${i}`).join(', ')
  return `SELECT toDate(u.signed_up) AS day, count() AS users, ${reached} FROM (${signups}) u LEFT JOIN (SELECT s.pid AS pid, ${hits} FROM events ev INNER JOIN (${signups}) s ON ev.person_id = s.pid WHERE ev.event IN (${quoted(s.steps)}) AND ev.timestamp >= now() - INTERVAL ${SIGNUP_DAYS + ACTIVATION_DAYS} DAY AND ev.timestamp >= s.signed_up AND ev.timestamp <= s.signed_up + INTERVAL ${ACTIVATION_DAYS} DAY GROUP BY s.pid) e ON e.pid = u.pid GROUP BY day ORDER BY day`
}

/**
 * One row of customer totals. A customer is whoever paid at least one invoice above zero. `billed`: still being
 * charged, a scheduled cancel included. `staying`: billed with no cancel asked for. Churn counts when the cancel was
 * asked for, so a scheduled cancel is churn from that day, while the customer stays in Paying until it ends.
 */
export function customersSql(s: Setup): string {
  const W = `INTERVAL ${WINDOW} DAY`
  const W2 = `INTERVAL ${2 * WINDOW} DAY`
  const weeks = `INTERVAL ${WEEKS * 7 + 6} DAY`
  const skipTypes = s.subTypes.length ? ` AND coalesce(sub.kind, '') NOT IN (${quoted(s.subTypes)})` : ''
  const skipEmails = s.emails.length ? ` AND sub.cid NOT IN (SELECT id FROM stripe.customer WHERE ${emailHit('email', s.emails)})` : ''
  return [
    // duplicate sync rows differ only in how far the subscription got: the furthest status wins
    `WITH subs AS (SELECT id, any(customer_id) AS cid, argMax(status, multiIf(status IN ('canceled', 'unpaid', 'incomplete_expired'), 5, status = 'past_due', 4, status = 'active', 3, status = 'trialing', 2, 1)) AS st, max(cancel_at_period_end) AS ending, max(coalesce(canceled_at, ended_at)) AS asked_at, max(coalesce(ended_at, canceled_at)) AS ended, any(JSONExtractString(toString(metadata), 'type')) AS kind FROM stripe.subscription WHERE livemode GROUP BY id),`,
    `paid AS (SELECT subscription_id AS sid, min(created_at) AS first_paid FROM stripe.invoice WHERE livemode AND amount_paid > 0 GROUP BY sid),`,
    `customers AS (SELECT sub.cid AS cid, min(p.first_paid) AS first_paid, max(sub.st IN ('active', 'trialing', 'past_due')) AS billed, max(sub.st IN ('active', 'trialing', 'past_due') AND NOT sub.ending) AS staying, max(sub.asked_at) AS asked_at, max(sub.ended) AS ended FROM subs sub INNER JOIN paid p ON p.sid = sub.id WHERE 1 = 1${skipTypes}${skipEmails} GROUP BY sub.cid)`,
    `SELECT countIf(billed = 1) AS paying, countIf(first_paid < now() - ${W} AND (billed = 1 OR ended >= now() - ${W})) AS paying_before,`,
    `countIf(first_paid >= now() - ${W}) AS new_now, countIf(first_paid >= now() - ${W2} AND first_paid < now() - ${W}) AS new_before,`,
    `countIf(staying = 0 AND asked_at >= now() - ${W}) AS churned_now, countIf(staying = 0 AND asked_at >= now() - ${W2} AND asked_at < now() - ${W}) AS churned_before,`,
    `countIf(staying = 1 OR asked_at >= now() - ${W}) AS base_now, countIf(first_paid < now() - ${W} AND (staying = 1 OR asked_at >= now() - ${W2})) AS base_before,`,
    `arrayStringConcat(groupArrayIf(toString(toDate(first_paid)), first_paid >= now() - ${weeks}), ',') AS new_days,`,
    `arrayStringConcat(groupArrayIf(toString(toDate(asked_at)), staying = 0 AND asked_at >= now() - ${weeks}), ',') AS churn_days`,
    `FROM customers`
  ].join(' ')
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const ratio = (part: number, whole: number): number | null => (whole ? part / whole : null)
const kpi = (value: number | null, previous: number | null): KpiValue => ({ value, previous })

/** The Monday (UTC) of a day. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return isoDay(d, (d.getUTCDay() + 6) % 7)
}

const weekLabel = (monday: string): string => new Date(`${monday}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

interface SignupDay {
  day: string
  users: number
  reached: number[]
}

/** Sums the days of [from, to], both inclusive. */
function cohort(days: SignupDay[], from: string, to: string, steps: number): { users: number; reached: number[] } {
  const out = { users: 0, reached: new Array<number>(steps).fill(0) }
  for (const d of days) {
    if (d.day < from || d.day > to) continue
    out.users += d.users
    d.reached.forEach((n, i) => (out.reached[i] += n))
  }
  return out
}

function tally(days: string, into: Map<string, number>): void {
  for (const day of days.split(',').filter(Boolean)) {
    const week = mondayOf(day.slice(0, 10))
    into.set(week, (into.get(week) ?? 0) + 1)
  }
}

export const activationProvider: DashboardProvider = {
  kind: 'activation',
  async validate(ctx) {
    activationSetup(ctx)
    await posthogProvider.validate(ctx)
  },
  checkKey: posthogProvider.checkKey,
  async fetch(ctx) {
    const setup = activationSetup(ctx)
    const steps = setup.steps
    const last = steps.length - 1
    const [dayRows, customers] = await Promise.all([
      hogql(ctx, activationSql(setup)),
      // no Stripe source in this PostHog project: the activation half still stands on its own
      hogql(ctx, customersSql(setup)).catch((e: unknown) => {
        if (e instanceof DashboardFetchError && e.code === 'config') return null
        throw e
      })
    ])
    const days: SignupDay[] = dayRows.map((r) => ({ day: String(r[0]).slice(0, 10), users: num(r[1]), reached: steps.map((_, i) => num(r[2 + i])) }))
    const newUsers = cohort(days, isoDay(ctx.now, WINDOW - 1), isoDay(ctx.now), steps.length).users
    const newUsersBefore = cohort(days, isoDay(ctx.now, 2 * WINDOW - 1), isoDay(ctx.now, WINDOW), steps.length).users
    if (!newUsers && !newUsersBefore) throw new DashboardFetchError('no_data', 'PostHog has no signups in the last 8 weeks. Check the signup event or view.')

    // activation only reads signups that have had their full window, so the newest days never drag the rate down
    const ripe = isoDay(ctx.now, ACTIVATION_DAYS)
    const now = cohort(days, isoDay(ctx.now, WINDOW - 1 + ACTIVATION_DAYS), ripe, steps.length)
    const before = cohort(days, isoDay(ctx.now, 2 * WINDOW - 1 + ACTIVATION_DAYS), isoDay(ctx.now, WINDOW + ACTIVATION_DAYS), steps.length)

    const c = customers?.[0]
    const newPayers = new Map<string, number>()
    const churned = new Map<string, number>()
    if (c) {
      tally(String(c[8] ?? ''), newPayers)
      tally(String(c[9] ?? ''), churned)
    }

    const thisWeek = mondayOf(isoDay(ctx.now))
    const weeks = Array.from({ length: WEEKS }, (_, i) => isoDay(new Date(`${thisWeek}T00:00:00Z`), (WEEKS - 1 - i) * 7))
    const byWeek = weeks.map((week) => {
      const sunday = isoDay(new Date(`${week}T00:00:00Z`), -6)
      const w = cohort(days, week, sunday, steps.length)
      return { week, users: w.users, activated: sunday <= ripe ? w.reached[last] : null, newPaying: c ? (newPayers.get(week) ?? 0) : null, churned: c ? (churned.get(week) ?? 0) : null }
    })
    const ripeWeeks = byWeek.filter((w) => w.activated != null)
    const weekRows: TableRow[] = [...byWeek].reverse().map((w) => ({ week: weekLabel(w.week), users: w.users, activated: w.activated, rate: w.activated == null ? null : ratio(w.activated, w.users), newPaying: w.newPaying, churned: w.churned }))
    const customerSeries: Series[] = c
      ? [
          { label: 'New paying', points: byWeek.map((w) => ({ t: w.week, v: w.newPaying ?? 0 })) },
          { label: 'Churned', points: byWeek.map((w) => ({ t: w.week, v: w.churned ?? 0 })) }
        ]
      : []

    return {
      fetchedAt: ctx.now.toISOString(),
      period: 'Last 28 days vs the 28 before',
      kpis: {
        newUsers: kpi(newUsers, newUsersBefore),
        activation: kpi(ratio(now.reached[last], now.users), ratio(before.reached[last], before.users)),
        newPaying: kpi(c ? num(c[2]) : null, c ? num(c[3]) : null),
        paying: kpi(c ? num(c[0]) : null, c ? num(c[1]) : null),
        churned: kpi(c ? num(c[4]) : null, c ? num(c[5]) : null),
        churnRate: kpi(c ? ratio(num(c[4]), num(c[6])) : null, c ? ratio(num(c[5]), num(c[7])) : null)
      },
      series: {
        signups: [
          { label: 'New users', points: ripeWeeks.map((w) => ({ t: w.week, v: w.users })) },
          { label: 'Activated', points: ripeWeeks.map((w) => ({ t: w.week, v: w.activated ?? 0 })) }
        ],
        customers: customerSeries
      },
      tables: {
        weeks: weekRows,
        steps: [{ step: 'New users', people: now.users, share: now.users ? 1 : null }, ...steps.map((step, i) => ({ step, people: now.reached[i], share: ratio(now.reached[i], now.users) }))]
      },
      warnings: c ? undefined : ['Paying customers and churn need a Stripe source in this PostHog project: Data pipeline → Sources → Stripe.']
    } satisfies DashboardSnapshot
  }
}
