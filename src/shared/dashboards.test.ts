import { describe, expect, it } from 'vitest'
import { DEPARTMENT_PRESET_KEYS } from './company'
import {
  DASHBOARD_CATALOG,
  DASHBOARD_CATEGORIES,
  DASHBOARD_KINDS,
  configList,
  dashboardDef,
  dashboardDepartmentKey,
  deltaRatio,
  deltaTone,
  formatDelta,
  formatMetric,
  recommendedFor,
  searchDashboards
} from './dashboards'

describe('dashboard catalog', () => {
  it('lists every kind exactly once, with unique widget, key and config ids', () => {
    expect(DASHBOARD_CATALOG.map((d) => d.id).sort()).toEqual([...DASHBOARD_KINDS].sort())
    for (const d of DASHBOARD_CATALOG) {
      expect(new Set(d.widgets.map((w) => w.id)).size, d.id).toBe(d.widgets.length)
      expect(new Set(d.keys.map((k) => k.name)).size, d.id).toBe(d.keys.length)
      expect(new Set(d.config.map((c) => c.key)).size, d.id).toBe(d.config.length)
    }
  })

  it('names keys as the Keys page stores them and says where to get each one', () => {
    for (const d of DASHBOARD_CATALOG) {
      for (const k of d.keys) {
        expect(k.name).toMatch(/^[A-Z][A-Z0-9_]*$/)
        expect(k.hint.length).toBeGreaterThan(20)
        expect(k.link).toMatch(/^https:\/\//)
      }
      // a dashboard with no required key must say how it runs without one (or need none, like GEO on Claude)
      if (!d.keys.some((k) => k.required)) expect(d.keylessNote, d.id).toBeTruthy()
    }
  })

  it('recommends only preset departments and known categories', () => {
    for (const d of DASHBOARD_CATALOG) {
      expect(DASHBOARD_CATEGORIES).toContain(d.category)
      expect(d.departments.length).toBeGreaterThan(0)
      for (const dep of d.departments) expect(DEPARTMENT_PRESET_KEYS).toContain(dep)
      expect(d.refreshMinutes).toBeGreaterThanOrEqual(30)
    }
  })

  it('recommends SEO, GEO and analytics to Marketing, Stripe to Finance and Sales, GitHub to Development', () => {
    expect(recommendedFor('marketing').map((d) => d.id)).toEqual(expect.arrayContaining(['gsc', 'geo', 'plausible']))
    expect(recommendedFor('finance').map((d) => d.id)).toEqual(['stripe'])
    expect(recommendedFor('sales').map((d) => d.id)).toContain('stripe')
    expect(recommendedFor('development').map((d) => d.id)).toContain('github')
    expect(recommendedFor(null)).toEqual([])
  })

  it('the Stripe dashboard asks for a restricted key and shows the CFO metrics', () => {
    const s = dashboardDef('stripe')!
    expect(s.keys.map((k) => k.name)).toEqual(['STRIPE_RESTRICTED_KEY'])
    expect(s.widgets.map((w) => w.id)).toEqual(expect.arrayContaining(['mrr', 'newCustomers', 'churned', 'churnRate', 'netRevenue', 'failedPayments', 'arpu', 'mrrTrend']))
  })
})

describe('dashboardDepartmentKey', () => {
  it('uses the preset key first, then the name', () => {
    expect(dashboardDepartmentKey({ key: 'marketing', name: 'Growth & Brand' })).toBe('marketing')
    expect(dashboardDepartmentKey({ key: 'cfo', name: 'CFO' })).toBe('finance')
    expect(dashboardDepartmentKey({ key: 'growth', name: 'Growth' })).toBe('marketing')
    expect(dashboardDepartmentKey({ key: 'engineering', name: 'Engineering' })).toBe('development')
    expect(dashboardDepartmentKey({ key: 'legal', name: 'Legal' })).toBeNull()
  })
})

describe('searchDashboards', () => {
  it('matches every word and filters by department and category', () => {
    expect(searchDashboards('churn').map((d) => d.id)).toEqual(['activation', 'stripe'])
    expect(searchDashboards('search console').map((d) => d.id)).toEqual(['gsc'])
    expect(searchDashboards('', { department: 'marketing', category: 'Web analytics' }).map((d) => d.id)).toEqual(['plausible', 'posthog'])
    expect(searchDashboards('', { department: 'all', category: 'all' })).toHaveLength(DASHBOARD_CATALOG.length)
    expect(searchDashboards('nothing-matches-this')).toEqual([])
  })
})

describe('numbers', () => {
  it('computes deltas and their tone by direction', () => {
    expect(deltaRatio(110, 100)).toBeCloseTo(0.1)
    expect(deltaRatio(5, 0)).toBeNull()
    expect(deltaRatio(0, 0)).toBe(0)
    expect(deltaRatio(null, 1)).toBeNull()
    expect(deltaTone(0.1, 'up')).toBe('good')
    expect(deltaTone(0.1, 'down')).toBe('bad')
    expect(deltaTone(-0.2, 'down')).toBe('good')
    expect(deltaTone(0.001, 'up')).toBe('flat')
    expect(deltaTone(0.5, 'neutral')).toBe('flat')
  })

  it('formats each metric kind', () => {
    expect(formatMetric(1234, 'currency', { currency: 'usd' })).toBe('$1,234')
    expect(formatMetric(48.5, 'currency', { currency: 'EUR' })).toBe('€48.50')
    expect(formatMetric(123456, 'currency', { currency: 'USD' })).toBe('$123.5K')
    expect(formatMetric(0.0425, 'percent')).toBe('4.3%')
    expect(formatMetric(0.25, 'percent')).toBe('25%')
    expect(formatMetric(11.44, 'position')).toBe('11.4')
    expect(formatMetric(84, 'duration')).toBe('1m 24s')
    expect(formatMetric(2.48, 'duration')).toBe('2.5 s')
    expect(formatMetric(7200, 'duration')).toBe('2.0 h')
    expect(formatMetric(18420, 'number')).toBe('18.4K')
    expect(formatMetric(null, 'number')).toBe('—')
    expect(formatDelta(0.042)).toBe('+4.2%')
    expect(formatDelta(-0.25)).toBe('−25%')
    expect(formatDelta(null)).toBe('')
  })

  it('reads list config from arrays or newline text', () => {
    expect(configList(' a \n\n b ')).toEqual(['a', 'b'])
    expect(configList(['x', ' ', 'y'])).toEqual(['x', 'y'])
    expect(configList(undefined)).toEqual([])
  })
})
