import { describe, expect, it } from 'vitest'
import type { CompanyAgent, Department } from '@shared/company'
import { socialStatuses } from '@shared/socials'
import { checklistItems, checklistProgress, nextItem, parseChecklistPrefs, type ChecklistInput, type ChecklistItemId } from './checklist'

const dep = (id: string, key: string, name: string, p: Partial<Department> = {}): Department =>
  ({ id, companyId: 'co_a', key, name, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} as Department['data'], ...p }) as Department
const agent = (id: string, departmentId: string | null, p: Partial<CompanyAgent> = {}): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId, kind: 'profile', refId: 'prof_1', name: id, archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '',
    data: { instructions: '', capabilities: '', autonomy: 'auto', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } }, ...p }) as CompanyAgent

const fresh = (p: Partial<ChecklistInput> = {}): ChecklistInput => ({
  company: { id: 'co_a', name: 'Sunday Bakery', mission: '' },
  hasLogo: false,
  repoCount: 0,
  departmentsOn: true,
  departments: [],
  agents: [],
  dashboards: [],
  socials: socialStatuses('co_a', new Set(), []),
  vibiz: 'signed-out',
  slack: 'none',
  scheduleCount: 0,
  autopilots: undefined,
  ...p
})
const item = (i: ChecklistInput, id: ChecklistItemId) => checklistItems(i).find((x) => x.id === id)!
const doneIds = (i: ChecklistInput) => checklistItems(i).filter((x) => x.done).map((x) => x.id)

const marketing = dep('dep_m', 'marketing', 'Marketing')
const finance = dep('dep_f', 'finance', 'Finance')

describe('checklistItems: every item checks itself from real state', () => {
  it('a fresh company has nothing done; 12 items', () => {
    const items = checklistItems(fresh())
    expect(items).toHaveLength(12)
    expect(checklistProgress(items)).toEqual({ done: 0, total: 12 })
    expect(nextItem(items)?.id).toBe('logo')
  })

  it('everything set up: 12 of 12', () => {
    const all = fresh({
      company: { id: 'co_a', name: 'Sunday Bakery', mission: 'Bread' },
      hasLogo: true,
      repoCount: 1,
      departments: [marketing, finance],
      agents: [agent('a1', 'dep_m'), agent('a2', 'dep_f')],
      dashboards: [{ kind: 'geo', departmentId: 'dep_m' }, { kind: 'stripe', departmentId: 'dep_f' }],
      socials: socialStatuses('co_a', new Set(['LINKEDIN_ACCESS_TOKEN']), []),
      vibiz: 'connected',
      slack: 'connected',
      scheduleCount: 2,
      autopilots: { marketing: { enabledAt: 'T', paused: false, steps: {}, publish: [] } }
    })
    expect(checklistProgress(checklistItems(all))).toEqual({ done: 12, total: 12 })
    expect(nextItem(checklistItems(all))).toBeNull()
  })

  it('logo, mission, repo', () => {
    expect(doneIds(fresh({ hasLogo: true }))).toEqual(['logo'])
    expect(doneIds(fresh({ company: { id: 'co_a', name: 'X', mission: '   ' } }))).toEqual([])
    expect(doneIds(fresh({ company: { id: 'co_a', name: 'X', mission: 'Bread for all' } }))).toEqual(['passport'])
    expect(doneIds(fresh({ repoCount: 2 }))).toEqual(['repo'])
    expect(item(fresh(), 'logo').action).toEqual({ kind: 'logo' })
  })

  it('departments off: the departments item turns them on, and agent/dashboard items point there too', () => {
    const i = fresh({ departmentsOn: false, departments: [marketing], agents: [agent('a1', 'dep_m')] })
    expect(item(i, 'departments')).toMatchObject({ title: 'Turn on departments', done: false, action: { kind: 'enableDepartments' } })
    expect(item(i, 'agents')).toMatchObject({ done: false, action: { kind: 'enableDepartments' } })
    expect(item(i, 'marketingDashboards').action).toEqual({ kind: 'enableDepartments' })
  })

  it('agents: progress per staffed department; the action opens the first empty one', () => {
    const i = fresh({ departments: [marketing, finance], agents: [agent('a1', 'dep_m'), agent('a2', 'dep_f', { pausedAt: 'x' })] })
    expect(item(i, 'agents')).toMatchObject({ done: false, progress: { n: 1, of: 2 }, action: { kind: 'department', departmentId: 'dep_f', focus: 'agents' }, actionLabel: 'Add agent to Finance' })
    expect(item(fresh({ departments: [marketing], agents: [agent('a1', 'dep_m')] }), 'agents').done).toBe(true)
    // an archived department does not count
    expect(item(fresh({ departments: [marketing, dep('dep_x', 'sales', 'Sales', { archivedAt: 'x' })], agents: [agent('a1', 'dep_m')] }), 'agents').done).toBe(true)
    // another company's agent never staffs this one
    expect(item(fresh({ departments: [marketing], agents: [agent('a1', 'dep_m', { companyId: 'co_b' })] }), 'agents').done).toBe(false)
  })

  it('dashboards: Search Console or GEO in Marketing, Stripe in Finance; missing department offers to add it', () => {
    const noDeps = fresh()
    expect(item(noDeps, 'marketingDashboards').action).toEqual({ kind: 'addDepartments', keys: ['marketing'] })
    expect(item(noDeps, 'financeDashboards').action).toEqual({ kind: 'addDepartments', keys: ['finance'] })
    const withDeps = fresh({ departments: [marketing, finance], dashboards: [{ kind: 'plausible', departmentId: 'dep_m' }, { kind: 'stripe', departmentId: 'dep_m' }] })
    expect(item(withDeps, 'marketingDashboards')).toMatchObject({ done: false, action: { kind: 'department', departmentId: 'dep_m', focus: 'dashboards' } })
    expect(item(withDeps, 'financeDashboards').done).toBe(false) // Stripe sits in Marketing, not Finance
    const good = fresh({ departments: [marketing, finance], dashboards: [{ kind: 'gsc', departmentId: 'dep_m' }, { kind: 'stripe', departmentId: 'dep_f' }] })
    expect(item(good, 'marketingDashboards').done).toBe(true)
    expect(item(good, 'financeDashboards').done).toBe(true)
  })

  it('loading inputs are never done and are marked pending', () => {
    const i = fresh({ departments: [marketing], dashboards: null, socials: null, vibiz: null, slack: null, scheduleCount: null })
    for (const id of ['marketingDashboards', 'socials', 'vibiz', 'slack', 'schedule'] as const) expect(item(i, id)).toMatchObject({ done: false, pending: true })
    // the "Next" pick skips pending rows
    expect(nextItem(checklistItems({ ...i, hasLogo: true, company: { id: 'co_a', name: 'X', mission: 'm' }, repoCount: 1, agents: [agent('a1', 'dep_m')] }))?.id).toBe('financeDashboards')
  })

  it('socials: done with one ready channel, progress over all five', () => {
    const one = fresh({ socials: socialStatuses('co_a', new Set(['TIKTOK_ACCESS_TOKEN']), []) })
    expect(item(one, 'socials')).toMatchObject({ done: true, progress: { n: 1, of: 5 } })
    expect(item(one, 'socials').detail).toContain('TikTok ready')
    const partial = fresh({ socials: socialStatuses('co_a', new Set(['X_API_KEY']), []) })
    expect(item(partial, 'socials').done).toBe(false)
  })

  it('Vibiz: connected only when signed in; a removed connection offers to add it', () => {
    expect(item(fresh({ vibiz: 'connected' }), 'vibiz').done).toBe(true)
    expect(item(fresh({ vibiz: 'connecting' }), 'vibiz').done).toBe(false)
    expect(item(fresh({ vibiz: 'missing' }), 'vibiz')).toMatchObject({ action: { kind: 'vibiz', present: false }, actionLabel: 'Add connection' })
    expect(item(fresh({ vibiz: 'signed-out' }), 'vibiz').action).toEqual({ kind: 'vibiz', present: true })
  })

  it('Slack, schedules, autopilot', () => {
    expect(item(fresh({ slack: 'set-up' }), 'slack').done).toBe(false)
    expect(item(fresh({ slack: 'connected' }), 'slack').done).toBe(true)
    expect(item(fresh({ scheduleCount: 1 }), 'schedule').done).toBe(true)
    expect(item(fresh(), 'autopilot')).toMatchObject({ done: false, action: { kind: 'autopilot', id: 'marketing' } })
    const companyOnly = fresh({ autopilots: { company: { enabledAt: 'T', paused: true, steps: {}, publish: [] } } })
    expect(item(companyOnly, 'autopilot')).toMatchObject({ done: true, action: { kind: 'autopilot', id: 'company' } })
  })
})

describe('parseChecklistPrefs', () => {
  it('keeps known fields, drops junk', () => {
    expect(parseChecklistPrefs(null)).toEqual({})
    expect(parseChecklistPrefs([1])).toEqual({})
    expect(parseChecklistPrefs({ co_a: { collapsed: true, dismissedAt: 'T', x: 1 }, co_b: 'nope', co_c: { collapsed: 'yes' } })).toEqual({ co_a: { collapsed: true, dismissedAt: 'T' }, co_c: {} })
  })
})
