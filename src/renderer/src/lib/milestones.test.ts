import { describe, expect, it } from 'vitest'
import type { CompanyAgent, CompanyTask, Department } from '@shared/company'
import { earned, featuredMilestone, FEATURE_MS, markSeen, MILESTONE_KEYS, MILESTONES_KEY, newlyEarned, parseSeen, shownEarned, type MilestoneState } from './milestones'

const NOW = new Date('2026-10-21T12:00:00Z')
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 864e5).toISOString()

const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id, identifier: `PRN-${id}`, title: `Task ${id}`, description: '', companyId: 'co_a', repoId: null, status: 'todo', blockReason: null, priority: 3, source: 'manual', sourceUrl: null,
    externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, agentId: null, createdAt: daysAgo(1), updatedAt: daysAgo(1), ...p }) as CompanyTask
const agent = (id: string, p: Partial<CompanyAgent> = {}): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p1', name: 'Developer', archivedAt: null, pausedAt: null, createdAt: daysAgo(10), updatedAt: daysAgo(10),
    data: { instructions: '', capabilities: '', autonomy: 'auto', mode: 'headless', defaultRepoId: null, limits: { autoWakesPerHour: 4 } }, ...p }) as CompanyAgent
const dept = (id: string, key: string): Department => ({ id, companyId: 'co_a', key, name: key, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} }) as unknown as Department

const state = (p: Partial<MilestoneState> = {}): MilestoneState => ({
  companies: [{ id: 'co_a', createdAt: daysAgo(2) }, { id: 'co_b', createdAt: daysAgo(30) }],
  tasks: [],
  companyAgents: [],
  departments: [],
  ...p
})
const has = (s: MilestoneState, key: string, companyId = 'co_a'): boolean => earned(companyId, s, NOW).includes(key as never)

describe('earned: VOICE.md §7 rules', () => {
  it('nothing for a fresh company', () => {
    expect(earned('co_a', state(), NOW)).toEqual([])
  })

  it('launched: the onboarding journal finished for this company only', () => {
    expect(has(state({ onboardingStatus: { journal: { status: 'done', companyId: 'co_a' } } }), 'launched')).toBe(true)
    expect(has(state({ onboardingStatus: { journal: { status: 'running', companyId: 'co_a' } } }), 'launched')).toBe(false)
    expect(has(state({ onboardingStatus: { journal: { status: 'failed', companyId: 'co_a' } } }), 'launched')).toBe(false)
    expect(has(state({ onboardingStatus: { journal: { status: 'done', companyId: 'co_b' } } }), 'launched')).toBe(false)
    expect(has(state({ onboardingStatus: { journal: null } }), 'launched')).toBe(false)
    expect(has(state({ onboardingStatus: null }), 'launched')).toBe(false)
  })

  it('firstTask: a task in done, of this company', () => {
    expect(has(state({ tasks: [task('1', { status: 'in_review' })] }), 'firstTask')).toBe(false)
    expect(has(state({ tasks: [task('1', { status: 'done' })] }), 'firstTask')).toBe(true)
    expect(has(state({ tasks: [task('1', { status: 'done', companyId: 'co_b' })] }), 'firstTask')).toBe(false)
  })

  it('firstPost: a done task by a Marketing agent or a content-role persona', () => {
    const departments = [dept('dep_m', 'marketing'), dept('dep_d', 'development')]
    const marketer = agent('agt_m', { departmentId: 'dep_m', name: 'Copywriter' })
    const dev = agent('agt_d', { departmentId: 'dep_d' })
    expect(has(state({ departments, companyAgents: [marketer, dev], tasks: [task('1', { status: 'done', agentId: 'agt_d' })] }), 'firstPost')).toBe(false)
    expect(has(state({ departments, companyAgents: [marketer, dev], tasks: [task('1', { status: 'in_review', agentId: 'agt_m' })] }), 'firstPost')).toBe(false)
    expect(has(state({ departments, companyAgents: [marketer, dev], tasks: [task('1', { status: 'done', agentId: 'agt_m' })] }), 'firstPost')).toBe(true)
    // a stored content persona outside Marketing (Hortensia in Support) counts too
    const look = { material: 'marble', hair: 'nodus', beard: 'none', laurel: false, drape: 'purple' } as const
    const writer = agent('agt_w', { departmentId: null, data: { ...dev.data, persona: { key: 'hortensia', name: 'Hortensia', personality: '', bio: '', look } } })
    expect(has(state({ companyAgents: [writer], tasks: [task('1', { status: 'done', agentId: 'agt_w' })] }), 'firstPost')).toBe(true)
    // an agent of another company never counts
    expect(has(state({ departments, companyAgents: [{ ...marketer, companyId: 'co_b' }], tasks: [task('1', { status: 'done', agentId: 'agt_m' })] }), 'firstPost')).toBe(false)
  })

  it('firstAnswer: an ask on a task answered by you', () => {
    expect(has(state({ tasks: [task('1', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'question', prompt: 'Which?' } })] }), 'firstAnswer')).toBe(false)
    expect(has(state({ tasks: [task('1', { ask: { kind: 'question', prompt: 'Which?', answer: '  ' } })] }), 'firstAnswer')).toBe(false)
    expect(has(state({ tasks: [task('1', { status: 'todo', ask: { kind: 'confirm', prompt: 'Ship?', answer: 'Yes', answeredAt: daysAgo(0) } })] }), 'firstAnswer')).toBe(true)
  })

  it('firstWeek: at least 7 days old and at least 3 tasks done', () => {
    const three = [task('1', { status: 'done' }), task('2', { status: 'done' }), task('3', { status: 'done' })]
    expect(has(state({ companies: [{ id: 'co_a', createdAt: daysAgo(8) }], tasks: three.slice(0, 2) }), 'firstWeek')).toBe(false)
    expect(has(state({ companies: [{ id: 'co_a', createdAt: daysAgo(6) }], tasks: three }), 'firstWeek')).toBe(false)
    expect(has(state({ companies: [{ id: 'co_a', createdAt: daysAgo(7) }], tasks: three }), 'firstWeek')).toBe(true)
  })

  it('fullTeam: every active agent has finished a task (paused and archived ones are not on the team)', () => {
    const a = agent('agt_1')
    const b = agent('agt_2')
    expect(has(state({ companyAgents: [], tasks: [task('1', { status: 'done' })] }), 'fullTeam')).toBe(false)
    expect(has(state({ companyAgents: [a, b], tasks: [task('1', { status: 'done', agentId: 'agt_1' })] }), 'fullTeam')).toBe(false)
    expect(has(state({ companyAgents: [a, b], tasks: [task('1', { status: 'done', agentId: 'agt_1' }), task('2', { status: 'done', agentId: 'agt_2' })] }), 'fullTeam')).toBe(true)
    expect(has(state({ companyAgents: [a, { ...b, archivedAt: daysAgo(1) }], tasks: [task('1', { status: 'done', agentId: 'agt_1' })] }), 'fullTeam')).toBe(true)
    expect(has(state({ companyAgents: [a, { ...b, pausedAt: daysAgo(1) }], tasks: [task('1', { status: 'done', agentId: 'agt_1' })] }), 'fullTeam')).toBe(true)
    // a review is not finished
    expect(has(state({ companyAgents: [a], tasks: [task('1', { status: 'in_review', agentId: 'agt_1' })] }), 'fullTeam')).toBe(false)
  })

  it('calmWeek: a week old, a task done in the last 7 days, no failed run in them', () => {
    const old = [{ id: 'co_a', createdAt: daysAgo(10) }]
    const doneRecent = task('1', { status: 'done', updatedAt: daysAgo(2) })
    expect(has(state({ companies: old, tasks: [doneRecent] }), 'calmWeek')).toBe(true)
    // too young
    expect(has(state({ companies: [{ id: 'co_a', createdAt: daysAgo(3) }], tasks: [doneRecent] }), 'calmWeek')).toBe(false)
    // the only done task is older than the week
    expect(has(state({ companies: old, tasks: [task('1', { status: 'done', updatedAt: daysAgo(9) })] }), 'calmWeek')).toBe(false)
    // a run failed in the last 24 h
    expect(has(state({ companies: old, tasks: [doneRecent], companyOverview: { co_a: { failed24h: 1 } } }), 'calmWeek')).toBe(false)
    expect(has(state({ companies: old, tasks: [doneRecent], companyOverview: { co_b: { failed24h: 2 } } }), 'calmWeek')).toBe(true)
    // a run that failed 3 days ago (outside 24 h, no parked task) still breaks the week, via failed7d
    expect(has(state({ companies: old, tasks: [doneRecent], companyOverview: { co_a: { failed24h: 0, failed7d: 1 } } }), 'calmWeek')).toBe(false)
    expect(has(state({ companies: old, tasks: [doneRecent], companyOverview: { co_a: { failed24h: 0, failed7d: 0 } } }), 'calmWeek')).toBe(true)
    // a task parked by a failed run this week
    expect(has(state({ companies: old, tasks: [doneRecent, task('2', { status: 'blocked', blockReason: 'run_failed', updatedAt: daysAgo(3) })] }), 'calmWeek')).toBe(false)
    // parked for another reason, or a failure before the week: still calm
    expect(has(state({ companies: old, tasks: [doneRecent, task('2', { status: 'blocked', blockReason: 'needs_input', updatedAt: daysAgo(3) })] }), 'calmWeek')).toBe(true)
    expect(has(state({ companies: old, tasks: [doneRecent, task('2', { status: 'blocked', blockReason: 'run_failed', updatedAt: daysAgo(8) })] }), 'calmWeek')).toBe(true)
  })

  it('hundred: 100 tasks done', () => {
    const many = (n: number): CompanyTask[] => Array.from({ length: n }, (_, i) => task(String(i), { status: 'done' }))
    expect(has(state({ tasks: many(99) }), 'hundred')).toBe(false)
    expect(has(state({ tasks: many(100) }), 'hundred')).toBe(true)
  })

  it('returns keys in strip order and tolerates an unknown company', () => {
    const s = state({ onboardingStatus: { journal: { status: 'done', companyId: 'co_a' } }, tasks: [task('1', { status: 'done' })] })
    expect(earned('co_a', s, NOW)).toEqual(['launched', 'firstTask'])
    expect(earned('co_missing', s, NOW)).toEqual([])
    expect(MILESTONE_KEYS).toHaveLength(8)
  })
})

describe('seen state', () => {
  it('uses the v1 storage key', () => {
    expect(MILESTONES_KEY).toBe('principia.milestones.v1')
  })
  it('newlyEarned: once per company per milestone', () => {
    let seen = parseSeen(null)
    expect(newlyEarned('co_a', ['launched', 'firstTask'], seen)).toEqual(['launched', 'firstTask'])
    seen = markSeen(seen, 'co_a', ['launched', 'firstTask'], '2026-10-21T12:00:00.000Z')
    expect(newlyEarned('co_a', ['launched', 'firstTask'], seen)).toEqual([])
    expect(newlyEarned('co_a', ['launched', 'firstTask', 'firstPost'], seen)).toEqual(['firstPost'])
    // another company earns its own
    expect(newlyEarned('co_b', ['launched'], seen)).toEqual(['launched'])
  })
  it('markSeen keeps the first stamp and returns the same object when nothing changes', () => {
    const a = markSeen({}, 'co_a', ['launched'], 'T1')
    const b = markSeen(a, 'co_a', ['launched'], 'T2')
    expect(b).toBe(a)
    expect(markSeen(a, 'co_a', ['launched', 'firstTask'], 'T3').co_a).toEqual({ launched: 'T1', firstTask: 'T3' })
  })
  it('parseSeen drops garbage', () => {
    expect(parseSeen('x')).toEqual({})
    expect(parseSeen([1])).toEqual({})
    expect(parseSeen({ co_a: { launched: 'T', bogus: 'T', firstTask: 3 }, co_b: 'nope', co_c: null })).toEqual({ co_a: { launched: 'T' } })
  })
  it('shownEarned: a seen milestone stays earned after its rule stops holding', () => {
    const seen = markSeen({}, 'co_a', ['calmWeek'], 'T')
    expect([...shownEarned('co_a', ['firstTask'], seen)]).toEqual(['firstTask', 'calmWeek'])
    expect([...shownEarned('co_b', [], seen)]).toEqual([])
  })
})

describe('featuredMilestone: one playful badge on the strip (VOICE.md §1)', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString()
  it('is the most recently earned milestone, and only within a week', () => {
    const seen = { c1: { launched: ago(3 * 86_400_000), firstTask: ago(86_400_000) } }
    const got = new Set(['launched', 'firstTask'] as const)
    expect(featuredMilestone('c1', got, seen, now)).toBe('firstTask')
    expect(featuredMilestone('c1', got, { c1: { launched: ago(FEATURE_MS + 1), firstTask: ago(FEATURE_MS + 1) } }, now)).toBeNull()
  })
  it('ties go to the later milestone; unstamped or garbled stamps count as now; nothing earned is null', () => {
    const at = ago(1000)
    expect(featuredMilestone('c1', new Set(['launched', 'firstTask'] as const), { c1: { launched: at, firstTask: at } }, now)).toBe('firstTask')
    expect(featuredMilestone('c1', new Set(['launched', 'hundred'] as const), { c1: { launched: at } }, now)).toBe('hundred')
    expect(featuredMilestone('c1', new Set(['launched'] as const), { c1: { launched: 'nope' } }, now)).toBe('launched')
    expect(featuredMilestone('c1', new Set(), {}, now)).toBeNull()
    expect(featuredMilestone('other', new Set(['launched'] as const), {}, now)).toBe('launched')
  })
})
