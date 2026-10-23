import { describe, expect, it } from 'vitest'
import { dashboardDef } from '@shared/dashboards'
import { chartGeometry, installReadiness, keysReady, monogram, nearestIndex, niceMax, shortDate, statusCopy } from './dashboards'

describe('chart geometry', () => {
  it('rounds the axis up to a nice number', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(180)).toBe(200)
    expect(niceMax(2100)).toBe(2500)
    expect(niceMax(0.34)).toBe(0.5)
  })

  it('maps points onto the box with a 0-based y axis', () => {
    const g = chartGeometry([{ label: 'a', points: [{ t: '2026-10-01', v: 0 }, { t: '2026-10-02', v: 5 }, { t: '2026-10-03', v: 10 }] }], 100, 50, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(g.max).toBe(10)
    expect(g.lines[0].points.map((p) => [p.x, p.y])).toEqual([[0, 50], [50, 25], [100, 0]])
    expect(g.lines[0].d).toBe('M0.0 50.0 L50.0 25.0 L100.0 0.0')
    expect(g.ticks.map((t) => t.v)).toEqual([0, 5, 10])
    expect([g.first, g.last]).toEqual(['2026-10-01', '2026-10-03'])
    expect(nearestIndex(g.lines[0].points, 60)).toBe(1)
  })

  it('gives series of very different sizes their own scale', () => {
    const g = chartGeometry([{ label: 'clicks', points: [{ t: 'a', v: 10 }, { t: 'b', v: 20 }] }, { label: 'impressions', points: [{ t: 'a', v: 1000 }, { t: 'b', v: 2000 }] }], 100, 50, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(g.independent).toBe(true)
    expect(g.max).toBe(20)
    expect(g.lines[0].points[1].y).toBe(0)
    expect(g.lines[1].points[1].y).toBe(0)
    expect(g.lines[1].max).toBe(2000)
    const same = chartGeometry([{ label: 'a', points: [{ t: 'a', v: 10 }] }, { label: 'b', points: [{ t: 'a', v: 30 }] }], 100, 50)
    expect(same.independent).toBe(false)
  })

  it('centres a single point and survives empty series', () => {
    const one = chartGeometry([{ label: 'a', points: [{ t: 'x', v: 3 }] }], 100, 50, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(one.lines[0].points[0].x).toBe(50)
    const none = chartGeometry([], 100, 50)
    expect(none.lines).toEqual([])
    expect(none.first).toBeNull()
  })

  it('shortens dates', () => {
    expect(shortDate('2026-10-04')).toBe('Oct 4')
    expect(shortDate('2026-10')).toBe('Oct 2026')
    expect(shortDate('week 3')).toBe('week 3')
  })
})

describe('install readiness', () => {
  const stripe = dashboardDef('stripe')!
  const gsc = dashboardDef('gsc')!
  it('needs every required key pasted or saved', () => {
    expect(installReadiness(stripe, [], {}, {})).toEqual({ ok: false, missing: ['Restricted key (read-only)'] })
    expect(installReadiness(stripe, [], { STRIPE_RESTRICTED_KEY: 'rk_test_x' }, {}).ok).toBe(true)
    expect(installReadiness(stripe, [{ name: 'STRIPE_RESTRICTED_KEY', source: 'shared', masked: '••••' }], {}, {}).ok).toBe(true)
    expect(keysReady(stripe, [{ name: 'STRIPE_RESTRICTED_KEY', source: 'company', masked: '••••' }])).toBe(true)
    expect(keysReady(stripe, [{ name: 'STRIPE_RESTRICTED_KEY', source: null, masked: null }])).toBe(false)
  })
  it('needs required config fields, not optional keys', () => {
    expect(installReadiness(gsc, [], { GSC_SERVICE_ACCOUNT_JSON: '{}' }, {}).missing).toEqual(['Property'])
    expect(installReadiness(gsc, [], { GSC_SERVICE_ACCOUNT_JSON: '{}' }, { siteUrl: 'sc-domain:a.com' }).ok).toBe(true)
    const geo = dashboardDef('geo')!
    expect(installReadiness(geo, [], {}, { brand: 'Acme', prompts: '\n' }).missing).toEqual(['Tracked prompts'])
  })
})

describe('status copy', () => {
  it('offers the right fix per error', () => {
    expect(statusCopy({ state: 'ok' }, true)).toBeNull()
    expect(statusCopy({ state: 'loading' }, true)).toBeNull()
    expect(statusCopy({ state: 'loading' }, false)?.title).toMatch(/first numbers/)
    expect(statusCopy({ state: 'error', code: 'invalid_key' }, true)).toMatchObject({ tone: 'error', action: 'keys' })
    expect(statusCopy({ state: 'error', code: 'forbidden' }, true)?.action).toBe('keys')
    expect(statusCopy({ state: 'error', code: 'config' }, false)?.action).toBe('settings')
    expect(statusCopy({ state: 'error', code: 'rate_limited' }, true)).toMatchObject({ tone: 'muted', action: 'retry' })
  })
  it('makes monograms', () => {
    expect(monogram('Google Search Console')).toBe('GS')
    expect(monogram('Stripe')).toBe('St')
    expect(monogram('AI answer engines')).toBe('AA')
  })
})
