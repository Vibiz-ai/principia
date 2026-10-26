import { describe, expect, it } from 'vitest'
import type { CompanyAgent, Department } from './company'
import { buildRoutine, isRoutineId, planRoutine, routineCost, routineDef, routinePrompt, routineSchedule, ROUTINE_IDS, ROUTINE_WORKFLOW_NAME, ROUTINES, routinesFor, setRoutine, type RoutineContext } from './routines'
import { morningBriefDraft } from './morningBrief'
import { seedWorkflows } from '../main/engine/seeds'

const dep = (id: string, key: string): Department =>
  ({ id, companyId: 'co_a', key, name: key[0]!.toUpperCase() + key.slice(1), color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} as Department['data'] }) as Department
const agent = (id: string, departmentId: string | null, refId = 'prof_claude'): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId, kind: 'profile', refId, name: `Agent ${id}`, archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '',
    data: { instructions: '', capabilities: '', autonomy: 'auto', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } } }) as CompanyAgent

const ctx = (p: Partial<RoutineContext> = {}): RoutineContext => ({
  companyId: 'co_a',
  companyName: 'Sunday Bakery',
  departmentsOn: true,
  departments: [dep('dep_m', 'marketing'), dep('dep_o', 'ops'), dep('dep_s', 'support')],
  agents: [agent('agt_m', 'dep_m'), agent('agt_o', 'dep_o'), agent('agt_s', 'dep_s', 'prof_codex')],
  dashboards: [],
  socials: [],
  profiles: [{ id: 'prof_claude', adapter: 'claude', name: 'Claude' }, { id: 'prof_codex', adapter: 'codex', name: 'Codex' }],
  defaultAdapter: 'claude',
  tz: 'Europe/Madrid',
  passport: { mission: 'Bread for the neighbourhood', audience: '', products: 'Sourdough' },
  repoIds: [],
  ...p
})

describe('routines library', () => {
  it('ids, defs and the guard agree', () => {
    expect(ROUTINES.map((r) => r.id)).toEqual([...ROUTINE_IDS])
    expect(isRoutineId('morning-brief')).toBe(true)
    expect(isRoutineId('rm -rf')).toBe(false)
    for (const r of ROUTINES) expect(r.cron.split(' ')).toHaveLength(5)
  })
  it('a shop never sees code routines; a company with a repository does', () => {
    expect(routinesFor(ctx()).map((r) => r.id)).toEqual(['morning-brief', 'weekly-review', 'inbox-triage', 'social-drafts'])
    expect(routinesFor(ctx({ repoIds: ['repo_1'] })).map((r) => r.id)).toContain('repo-health')
    expect(routinesFor(ctx({ repoIds: ['repo_1'] })).map((r) => r.id)).toContain('code-brief')
  })
  it('who does it: the department agent, else the lead (Ops), and the plan it uses', () => {
    expect(planRoutine(routineDef('social-drafts'), ctx()).agent?.id).toBe('agt_m')
    expect(planRoutine(routineDef('morning-brief'), ctx()).agent?.id).toBe('agt_o')
    const triage = planRoutine(routineDef('inbox-triage'), ctx())
    expect(triage.agent?.id).toBe('agt_s')
    expect(routineCost(triage)).toBe('Uses your Codex plan: one short run each weekday. Principia charges nothing extra.')
    // no support department: the lead takes it
    expect(planRoutine(routineDef('inbox-triage'), ctx({ departments: [dep('dep_o', 'ops')], agents: [agent('agt_o', 'dep_o')] })).agent?.id).toBe('agt_o')
  })
  it('without departments: a plain run on the default profile; without any agent CLI: not ready, said plainly', () => {
    const p = planRoutine(routineDef('morning-brief'), ctx({ departmentsOn: false }))
    expect(p).toMatchObject({ ready: true, agent: null, profileId: 'prof_claude', adapter: 'claude' })
    const none = planRoutine(routineDef('morning-brief'), ctx({ departmentsOn: false, profiles: [] }))
    expect(none.ready).toBe(false)
    expect(none.blocker).toMatch(/Install Claude Code/)
  })
  it('Turn on builds one ENABLED task-mode schedule for the agent, in the user tz', () => {
    const b = buildRoutine(planRoutine(routineDef('morning-brief'), ctx()), ctx())
    expect(b.workflow).toBeNull()
    const s = b.schedule(null)
    expect(s).toMatchObject({ name: 'Morning brief', enabled: true, companyId: 'co_a', departmentId: 'dep_o', when: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' } })
    expect(s.target).toMatchObject({ kind: 'prompt', mode: 'task', agentId: 'agt_o', profileId: 'prof_claude', repoId: null })
  })
  it('repo health runs in the company’s first repository', () => {
    const c = ctx({ repoIds: ['repo_1', 'repo_2'], departments: [dep('dep_d', 'development')], agents: [agent('agt_d', 'dep_d')] })
    const s = buildRoutine(planRoutine(routineDef('repo-health'), c), c).schedule(null)
    expect(s.target).toMatchObject({ kind: 'prompt', repoId: 'repo_1', agentId: 'agt_d' })
  })
  it('the code brief creates the seeded Morning brief workflow once, then reuses it', () => {
    const c = ctx({ repoIds: ['repo_1'] })
    const plan = planRoutine(routineDef('code-brief'), c)
    const first = buildRoutine(plan, c, [])
    expect(first.workflow).toMatchObject({ name: ROUTINE_WORKFLOW_NAME, companyId: 'co_a' })
    expect(first.workflow!.nodes.map((n) => n.id)).toEqual(morningBriefDraft('x').nodes.map((n) => n.id))
    expect(first.schedule('wf_1').target).toEqual({ kind: 'workflow', workflowId: 'wf_1', inputs: { root: 'all' } })
    const again = buildRoutine(plan, c, [{ id: 'wf_9', name: ROUTINE_WORKFLOW_NAME, companyId: 'co_a' }, { id: 'wf_x', name: ROUTINE_WORKFLOW_NAME, companyId: 'co_b' }])
    expect(again.workflow).toBeNull()
    expect(again.reuseWorkflowId).toBe('wf_9')
  })
  it('every prompt drafts and reports: no sending, publishing, spending or deleting', () => {
    for (const r of ROUTINES.filter((x) => x.kind === 'task')) {
      const p = routinePrompt(r, ctx(), true)
      expect(p).toContain('Do not send emails or messages, publish, spend money')
      expect(p).toContain('task_report')
      expect(p).toContain('Sunday Bakery')
      expect(routinePrompt(r, ctx(), false)).not.toContain('task_report')
    }
    expect(routinePrompt(routineDef('social-drafts'), ctx(), true)).toContain('Nothing is published')
  })
  it('the seeded Morning brief workflow is the shared draft and points at Routines, not a manual schedule', () => {
    const seed = seedWorkflows({ claude: 'prof_claude', codex: null }).find((s) => s.seedKey === 'morning-brief')!
    expect(seed.draft).toEqual(morningBriefDraft('prof_claude'))
    expect(seed.draft.description).toContain('Automations › Routines')
  })
  it('bookkeeping: the recorded schedule, else one with the routine name in this company', () => {
    const scheds = [{ id: 'sch_1', name: 'Morning brief', companyId: 'co_b' }, { id: 'sch_2', name: 'Morning brief', companyId: 'co_a' }, { id: 'sch_3', name: 'Renamed', companyId: 'co_a' }]
    expect(routineSchedule('morning-brief', 'co_a', undefined, scheds)?.id).toBe('sch_2')
    expect(routineSchedule('morning-brief', 'co_a', { scheduleId: 'sch_3', onAt: '' }, scheds)?.id).toBe('sch_3')
    expect(routineSchedule('weekly-review', 'co_a', undefined, scheds)).toBeNull()
    const all = setRoutine(undefined, 'co_a', 'morning-brief', { scheduleId: 'sch_2', onAt: 'now' })
    expect(all).toEqual({ co_a: { 'morning-brief': { scheduleId: 'sch_2', onAt: 'now' } } })
    expect(setRoutine(all, 'co_a', 'morning-brief', undefined)).toEqual({})
  })
})

describe('routine times in plain words', () => {
  it('reads and writes the cron of every ready-made routine, and the cadence matches its words', async () => {
    const { ROUTINES, routineTimeOf, cronOf, cadenceOf } = await import('./routines')
    for (const r of ROUTINES) {
      const t = routineTimeOf(r.cron)!
      expect(cronOf(t)).toBe(r.cron.replace(/^0 /, '0 ').replace('1-5', '1,2,3,4,5'))
      expect(cadenceOf(t)).toBe(r.cadence)
    }
  })
  it('a founder or an agent link can say "6:30, Tue to Sun"', async () => {
    const { parseDays, parseAt, cronOf, cadenceOf, routineTimeOf } = await import('./routines')
    const days = parseDays('tue-sun')!
    expect(days).toEqual([0, 2, 3, 4, 5, 6])
    expect(parseAt('6:30')).toBe('06:30')
    const cron = cronOf({ time: '06:30', days })!
    expect(cron).toBe('30 6 * * 0,2,3,4,5,6')
    expect(cadenceOf(routineTimeOf(cron)!)).toBe('Tue to Sun at 6:30')
    expect(cadenceOf({ time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day at 7:00')
    expect(cadenceOf({ time: '07:00', days: [6] })).toBe('Saturdays at 7:00')
    expect(parseDays('mon,wed,fri')).toEqual([1, 3, 5])
    expect(parseDays('sun-mon')).toBeNull()
    expect(parseDays('funday')).toBeNull()
    expect(parseAt('25:00')).toBeNull()
    expect(cronOf({ time: '06:30', days: [] })).toBeNull()
    expect(routineTimeOf('*/5 * * * *')).toBeNull()
  })
})
