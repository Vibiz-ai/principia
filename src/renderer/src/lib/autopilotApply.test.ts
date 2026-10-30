import { describe, expect, it } from 'vitest'
import type { CompanyAgent, Department } from '@shared/company'
import { planAutopilot, type AutopilotContext, type AutopilotRecord } from '@shared/autopilot'
import { socialStatuses } from '@shared/socials'
import type { ScheduleInput, WorkflowDraft } from '@shared/types'
import { enableAutopilot, goneSteps, pauseAutopilot, removeAutopilot, withoutSteps, type AutopilotDeps } from './autopilotApply'

const dep = (id: string, key: string, name: string): Department =>
  ({ id, companyId: 'co_a', key, name, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} as Department['data'] }) as Department
const agent = (id: string, departmentId: string): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId, kind: 'profile', refId: 'prof_c', name: id, archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '',
    data: { instructions: '', capabilities: '', autonomy: 'auto', mode: 'headless', defaultRepoId: null, limits: { autoWakesPerHour: 4 } } }) as CompanyAgent

const ctx = (p: Partial<AutopilotContext> = {}): AutopilotContext => ({
  companyId: 'co_a', companyName: 'Acme', departmentsOn: true,
  departments: [dep('dep_m', 'marketing', 'Marketing')],
  agents: [agent('agt_m', 'dep_m')],
  dashboards: [{ kind: 'gsc', departmentId: 'dep_m' }],
  socials: socialStatuses('co_a', new Set(['LINKEDIN_ACCESS_TOKEN']), []),
  profiles: [{ id: 'prof_c', adapter: 'claude', name: 'Claude' }], defaultAdapter: 'claude', tz: 'UTC',
  ...p
})

/** In-memory schedules and workflows, recording every call. */
function fakeDeps(opts: { failSchedule?: string } = {}) {
  let n = 0
  const schedules = new Map<string, ScheduleInput & { companyId: string }>()
  const workflows = new Map<string, WorkflowDraft>()
  const calls: string[] = []
  const deps: AutopilotDeps = {
    async createWorkflow(d) {
      const id = `wf_${++n}`
      workflows.set(id, d)
      calls.push(`wf+ ${d.name}`)
      return { id }
    },
    async createSchedule(s) {
      if (opts.failSchedule && s.name === opts.failSchedule) throw new Error('Invalid schedule')
      const id = `sch_${++n}`
      schedules.set(id, s)
      calls.push(`sch+ ${s.name}`)
      return { id }
    },
    async setScheduleEnabled(id, enabled) {
      const s = schedules.get(id)
      if (!s) throw new Error('not_found')
      s.enabled = enabled
      calls.push(`sch${enabled ? '▶' : '⏸'} ${id}`)
    },
    async removeSchedule(id) {
      schedules.delete(id)
      calls.push(`sch- ${id}`)
    },
    async removeWorkflow(id) {
      if (!workflows.delete(id)) throw Object.assign(new Error('Workflow not found'), { code: 'not_found' })
      calls.push(`wf- ${id}`)
    },
    now: () => '2026-10-24T09:00:00Z'
  }
  return { deps, schedules, workflows, calls, live: () => new Set(schedules.keys()) }
}

const ALL = ['seo_report', 'content', 'competitors']

describe('enableAutopilot', () => {
  it('creates the ticked ready steps in the open: one schedule each, plus the watch workflow', async () => {
    const f = fakeDeps()
    const c = ctx()
    const res = await enableAutopilot(f.deps, planAutopilot('marketing', c), c, undefined, { steps: ALL, publish: [], competitors: 'Globex' })
    expect(res.error).toBeNull()
    expect(res.created).toEqual(ALL)
    expect(f.calls).toEqual(['sch+ Weekly SEO and AI-visibility report', 'sch+ Content calendar and drafts', 'wf+ Competitor watch · Acme', 'sch+ Competitor watch'])
    expect(res.record).toEqual({
      enabledAt: '2026-10-24T09:00:00Z', paused: false, publish: [],
      steps: { seo_report: { scheduleId: 'sch_1', workflowId: null }, content: { scheduleId: 'sch_2', workflowId: null }, competitors: { scheduleId: 'sch_4', workflowId: 'wf_3' } }
    })
    expect([...f.schedules.values()].every((s) => s.enabled && s.companyId === 'co_a')).toBe(true)
    expect(f.schedules.get('sch_4')!.target).toMatchObject({ kind: 'workflow', workflowId: 'wf_3' })
  })

  it('skips blocked and unticked steps; only creates what exists', async () => {
    const f = fakeDeps()
    const c = ctx({ dashboards: [], socials: socialStatuses('co_a', new Set(), []) }) // SEO and content blocked
    const res = await enableAutopilot(f.deps, planAutopilot('marketing', c), c, undefined, { steps: ['seo_report', 'content'], publish: [], competitors: 'Globex' })
    expect(res.created).toEqual([])
    expect(res.record).toBeUndefined()
    expect(f.calls).toEqual([])
  })

  it('never recreates a step the record holds; a paused autopilot adds paused steps', async () => {
    const f = fakeDeps()
    const c = ctx()
    const existing: AutopilotRecord = { enabledAt: 'T0', paused: true, publish: [], steps: { seo_report: { scheduleId: 'sch_old' } } }
    const res = await enableAutopilot(f.deps, planAutopilot('marketing', c), c, existing, { steps: ['seo_report', 'content'], publish: ['linkedin'] })
    expect(res.created).toEqual(['content'])
    expect(res.record).toMatchObject({ enabledAt: 'T0', paused: true, publish: ['linkedin'], steps: { seo_report: { scheduleId: 'sch_old' }, content: { scheduleId: 'sch_1' } } })
    expect(f.schedules.get('sch_1')!.enabled).toBe(false)
    // the publish opt-in is baked into the content prompt
    const t = f.schedules.get('sch_1')!.target
    expect(t.kind === 'prompt' && t.prompt).toMatch(/LinkedIn: publishing is on/)
  })

  it('a failing step stops the run, keeps what was created, and takes back its own workflow', async () => {
    const f = fakeDeps({ failSchedule: 'Competitor watch' })
    const c = ctx()
    const res = await enableAutopilot(f.deps, planAutopilot('marketing', c), c, undefined, { steps: ALL, publish: [], competitors: 'Globex' })
    expect(res.error).toBe('Competitor watch: Invalid schedule')
    expect(res.created).toEqual(['seo_report', 'content'])
    expect(Object.keys(res.record!.steps)).toEqual(['seo_report', 'content'])
    expect(f.workflows.size).toBe(0) // the orphan workflow was removed
    expect(f.calls.at(-1)).toBe('wf- wf_3')
  })

  it('the company autopilot creates three task-mode schedules', async () => {
    const f = fakeDeps()
    const c = ctx({ departments: [dep('dep_o', 'ops', 'Ops'), dep('dep_f', 'finance', 'Finance')], agents: [agent('agt_o', 'dep_o'), agent('agt_f', 'dep_f')], dashboards: [{ kind: 'stripe', departmentId: 'dep_f' }] })
    const res = await enableAutopilot(f.deps, planAutopilot('company', c), c, undefined, { steps: ['review', 'finance', 'triage'], publish: [] })
    expect(res.created).toEqual(['review', 'finance', 'triage'])
    const targets = [...f.schedules.values()].map((s) => [s.name, s.target.kind === 'prompt' ? s.target.agentId : null, s.departmentId])
    expect(targets).toEqual([['Weekly company review', 'agt_o', 'dep_o'], ['Finance digest', 'agt_f', 'dep_f'], ['Board triage', 'agt_o', 'dep_o']])
  })
})

describe('pause, remove, gone', () => {
  async function enabled() {
    const f = fakeDeps()
    const c = ctx()
    const res = await enableAutopilot(f.deps, planAutopilot('marketing', c), c, undefined, { steps: ALL, publish: [], competitors: 'Globex' })
    return { f, rec: res.record! }
  }
  it('pause disables exactly the autopilot’s live schedules; resume turns them back on', async () => {
    const { f, rec } = await enabled()
    f.schedules.delete('sch_2') // deleted by hand on the Schedules page
    const p = await pauseAutopilot(f.deps, rec, true, f.live())
    expect(p).toEqual({ record: { ...rec, paused: true }, failed: 0 })
    expect([...f.schedules.values()].map((s) => s.enabled)).toEqual([false, false])
    await pauseAutopilot(f.deps, p.record, false, f.live())
    expect([...f.schedules.values()].map((s) => s.enabled)).toEqual([true, true])
  })
  it('remove deletes its schedules and its workflow; a workflow already gone is fine', async () => {
    const { f, rec } = await enabled()
    f.workflows.clear()
    const r = await removeAutopilot(f.deps, rec, f.live())
    expect(r).toEqual({ record: undefined, failed: [] })
    expect(f.schedules.size).toBe(0)
  })
  it('goneSteps finds steps whose schedule was deleted; withoutSteps lets them be recreated', async () => {
    const { f, rec } = await enabled()
    f.schedules.delete('sch_1')
    expect(goneSteps(rec, f.live())).toEqual(['seo_report'])
    expect(Object.keys(withoutSteps(rec, ['seo_report']).steps)).toEqual(['content', 'competitors'])
    expect(goneSteps(undefined, f.live())).toEqual([])
  })
})
