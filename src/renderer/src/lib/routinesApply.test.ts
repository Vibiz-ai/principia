import { describe, expect, it } from 'vitest'
import type { CompanyAgent } from '@shared/company'
import { planRoutine, routineDef, type RoutineContext } from '@shared/routines'
import type { Schedule } from '@shared/types'
import { changeRoutineTime, runRoutineOnce, scheduleWaitingOf, turnOffRoutine, turnOnRoutine, type RoutineDeps } from './routinesApply'

const agent = { id: 'agt_o', companyId: 'co_a', departmentId: 'dep_o', kind: 'profile', refId: 'prof_claude', name: 'Ops', archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: {} } as unknown as CompanyAgent
const ctx = (p: Partial<RoutineContext> = {}): RoutineContext => ({
  companyId: 'co_a', companyName: 'Sunday Bakery', departmentsOn: true,
  departments: [{ id: 'dep_o', companyId: 'co_a', key: 'ops', name: 'Ops', archivedAt: null }],
  agents: [agent], dashboards: [], socials: [], profiles: [{ id: 'prof_claude', adapter: 'claude', name: 'Claude' }],
  defaultAdapter: 'claude', tz: 'UTC', repoIds: [], ...p
})
const sched = (p: Partial<Schedule> = {}): Schedule => ({ id: 'sch_1', name: 'Morning brief', companyId: 'co_a', enabled: true, target: { kind: 'prompt', profileId: 'prof_claude', repoId: null, prompt: 'x' }, when: { kind: 'cron', cron: '0 9 * * 1-5' }, preset: null, sentence: '', lastFireAt: null, lastRunId: null, lastRunStatus: null, nextFireAt: null, createdAt: '', updatedAt: '', ...p }) as Schedule

function fakeDeps(): RoutineDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    createWorkflow: async (d) => (calls.push(`wf:${d.name}`), { id: 'wf_new', ...d }) as never,
    createSchedule: async (s) => (calls.push(`sch:${s.name}:${s.enabled}`), sched({ id: 'sch_new', name: s.name, enabled: !!s.enabled, target: s.target })),
    setScheduleEnabled: async (id, enabled) => (calls.push(`enable:${id}:${enabled}`), sched({ id, enabled })),
    updateSchedule: async (id, input) => (calls.push(`when:${id}:${input.when.kind === 'cron' ? input.when.cron : ''}`), sched({ id, when: input.when, enabled: input.enabled ?? true })),
    runSchedule: async (id) => void calls.push(`fire:${id}`),
    startRun: async (t) => (calls.push(`run:${t.kind}`), { id: 'run_1' }) as never,
    createTask: async (t) => (calls.push(`task:${t.title}:${t.agentId}`), { id: 'tsk_1', ...t }) as never,
    startTask: async (id) => (calls.push(`start:${id}`), { id }) as never
  }
}

describe('routines apply', () => {
  it('Turn on creates one enabled schedule and records it', async () => {
    const d = fakeDeps()
    const r = await turnOnRoutine(d, planRoutine(routineDef('morning-brief'), ctx()), ctx(), [], null, new Date('2026-10-26T09:00:00Z'))
    expect(d.calls).toEqual(['sch:Morning brief:true'])
    expect(r.record).toEqual({ scheduleId: 'sch_new', workflowId: null, onAt: '2026-10-26T09:00:00.000Z' })
  })
  it('Turn on after Turn off re-enables the same schedule instead of making a second one', async () => {
    const d = fakeDeps()
    await turnOnRoutine(d, planRoutine(routineDef('morning-brief'), ctx()), ctx(), [], sched({ enabled: false }))
    expect(d.calls).toEqual(['enable:sch_1:true'])
  })
  it('Change time: only the schedule’s time changes; Turn on at a chosen time creates it at that time', async () => {
    const d = fakeDeps()
    await changeRoutineTime(d, sched({ when: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Madrid' } }), '30 6 * * 0,2,3,4,5,6')
    expect(d.calls).toEqual(['when:sch_1:30 6 * * 0,2,3,4,5,6'])
    await changeRoutineTime(d, sched({ when: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'UTC' } }), '0 9 * * 1-5')
    expect(d.calls).toHaveLength(1)
    let made: string | null = null
    const d2 = { ...fakeDeps(), createSchedule: async (s: Parameters<RoutineDeps['createSchedule']>[0]) => ((made = s.when.kind === 'cron' ? s.when.cron : null), sched({ id: 'sch_new' })) }
    await turnOnRoutine(d2, planRoutine(routineDef('morning-brief'), ctx()), ctx(), [], null, new Date(), { cron: '30 6 * * 0,2,3,4,5,6' })
    expect(made).toBe('30 6 * * 0,2,3,4,5,6')
  })
  it('Turn off only disables (the schedule stays under Schedules)', async () => {
    const d = fakeDeps()
    await turnOffRoutine(d, sched())
    await turnOffRoutine(d, sched({ enabled: false }))
    expect(d.calls).toEqual(['enable:sch_1:false'])
  })
  it('the code brief creates its workflow, then the schedule on it', async () => {
    const d = fakeDeps()
    const c = ctx({ repoIds: ['repo_1'] })
    const r = await turnOnRoutine(d, planRoutine(routineDef('code-brief'), c), c, [], null)
    expect(d.calls).toEqual(['wf:Code activity brief', 'sch:Code activity brief:true'])
    expect(r.record.workflowId).toBe('wf_new')
  })
  it('Run once now: fires the schedule when on; else a started task for the agent; never a schedule', async () => {
    const d = fakeDeps()
    const plan = planRoutine(routineDef('morning-brief'), ctx())
    expect(await runRoutineOnce(d, plan, ctx(), [], sched())).toEqual({ kind: 'schedule', id: 'sch_1', waiting: null })
    expect(await runRoutineOnce(d, plan, ctx(), [], null)).toEqual({ kind: 'task', id: 'tsk_1' })
    expect(d.calls).toEqual(['fire:sch_1', 'task:Morning brief:agt_o', 'start:tsk_1'])
  })
  it('Run once now says when the fire waits (busy, paused), from the schedule event', async () => {
    const d = { ...fakeDeps(), lastScheduleMessage: async () => 'Commented on PC-4; Seneca is busy on PC-2; it starts right after' }
    const plan = planRoutine(routineDef('morning-brief'), ctx())
    expect(await runRoutineOnce(d, plan, ctx(), [], sched())).toEqual({ kind: 'schedule', id: 'sch_1', waiting: 'Seneca is busy on PC-2; it starts right after' })
    expect(scheduleWaitingOf('Created PC-4')).toBeNull()
    expect(scheduleWaitingOf(null)).toBeNull()
  })
  it('Run once now without departments: a plain run', async () => {
    const d = fakeDeps()
    const c = ctx({ departmentsOn: false })
    expect(await runRoutineOnce(d, planRoutine(routineDef('weekly-review'), c), c, [], null)).toEqual({ kind: 'run', id: 'run_1' })
    expect(d.calls).toEqual(['run:prompt'])
  })
})
