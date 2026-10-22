/**
 * DEPARTMENTS.md §9 sidebar badges: department, Board and seat states all come from laneOf (§1.5) with the renderer's
 * live inputs (open asks on a task's run, the agent's eligibility).
 */
import { describe, expect, it } from 'vitest'
import { laneOf, needsYouReason, type CompanyAgent, type CompanyTask, type Department } from '@shared/company'
import type { Ask } from '@shared/live'
import type { Schedule, Workflow } from '@shared/types'
import type { SlackTrigger } from '@shared/slack'
import { agentsOf, boardCounts, mergeBoardBadge, charterLength, departmentCounts, departmentNotePath, departmentsOf, inCompany, laneContext, openAskRuns, recurringOf, seatInitials, seatState, taskDepartment, taskLane, taskReason } from './departments'

let n = 0
const task = (p: Partial<CompanyTask>): CompanyTask =>
  ({ id: `t_${++n}`, identifier: `PRN-${n}`, title: 'x', description: '', companyId: 'co_a', repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, createdAt: `2026-10-${String(10 + (n % 10)).padStart(2, '0')}`, updatedAt: '', departmentId: null, agentId: null, blockReason: null, ...p }) as CompanyTask
const agent = (p: Partial<CompanyAgent>): CompanyAgent =>
  ({ id: 'agt_1', companyId: 'co_a', departmentId: 'dep_m', kind: 'profile', refId: 'p_1', name: 'Copywriter', archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: { instructions: '', capabilities: '', autonomy: 'manual', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } }, ...p }) as CompanyAgent
const dep = (p: Partial<Department>): Department =>
  ({ id: 'dep_m', companyId: 'co_a', key: 'marketing', name: 'Marketing', color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: { charter: { does: '', doesNot: '' }, sourceDefaults: [], slackChannels: [], passportNote: null, contextFallback: '' }, ...p }) as Department
const ask = (p: Partial<Ask>): Ask => ({ id: 'ask_1', status: 'open', runId: 'run_1', ...p }) as Ask

describe('openAskRuns', () => {
  it('collects runs with an open ask only', () => {
    const asks = { a: ask({ id: 'a', runId: 'run_1' }), b: ask({ id: 'b', runId: 'run_2', status: 'answered' }), c: ask({ id: 'c', runId: null }) }
    expect([...openAskRuns(asks)]).toEqual(['run_1'])
    expect([...openAskRuns([ask({ runId: 'run_9' })])]).toEqual(['run_9'])
  })
})

describe('taskLane matches laneOf', () => {
  const seat = agent({})
  const ctx = laneContext({ a: ask({ runId: 'run_live' }) }, [seat, agent({ id: 'agt_paused', pausedAt: '2026-10-20' })])
  it('in_progress with an open live ask on its run needs you; without, it works', () => {
    expect(taskLane(task({ status: 'in_progress', runId: 'run_live', agentId: 'agt_1' }), ctx)).toBe('needs_you')
    expect(taskLane(task({ status: 'in_progress', runId: 'run_other', agentId: 'agt_1' }), ctx)).toBe('working')
  })
  it('a todo task whose agent is paused or gone has no eligible agent', () => {
    expect(taskLane(task({ departmentId: 'dep_m', agentId: 'agt_paused' }), ctx)).toBe('needs_you')
    expect(taskLane(task({ departmentId: 'dep_m', agentId: 'agt_missing' }), ctx)).toBe('needs_you')
    expect(taskLane(task({ departmentId: 'dep_m', agentId: 'agt_1' }), ctx)).toBe('queued')
  })
  it('every status agrees with laneOf for an eligible agent and no ask', () => {
    for (const status of ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'] as const) {
      for (const blockReason of [null, 'deps', 'run_failed'] as const) {
        const t = task({ status, blockReason, departmentId: 'dep_m', agentId: 'agt_1' })
        expect(taskLane(t, ctx)).toBe(laneOf(t, false, true))
      }
    }
  })
})

describe('company boundary (§0.3)', () => {
  // a seat of company B never counts a company-A task, even if a bad row points at it
  const foreign = agent({ id: 'agt_b', companyId: 'co_b', departmentId: 'dep_b' })
  const ctx = laneContext({}, [foreign])
  it('a foreign seat neither lends its department nor counts as eligible', () => {
    const t = task({ status: 'todo', departmentId: 'dep_m', agentId: 'agt_b' })
    expect(taskDepartment(task({ agentId: 'agt_b', status: 'in_progress' }), ctx)).toBeNull()
    expect(departmentCounts([task({ agentId: 'agt_b', status: 'in_review' })], ctx)).toEqual({})
    expect(taskLane(t, ctx)).toBe('needs_you')
  })
  it('seatState ignores tasks of another company', () => {
    const st = seatState(foreign, [task({ agentId: 'agt_b', status: 'in_progress', identifier: 'PRN-9' })], new Set())
    expect(st).toMatchObject({ kind: 'idle', current: null })
  })
  it('inCompany drops rows stamped with another company', () => {
    const rows = [{ id: 1, companyId: 'co_a' }, { id: 2, companyId: 'co_b' }, { id: 3 }]
    expect(inCompany(rows, 'co_a').map((r) => r.id)).toEqual([1, 3])
  })
})

describe('taskReason agrees with taskLane', () => {
  const ctx = laneContext({ a: ask({ runId: 'run_live' }) }, [agent({}), agent({ id: 'agt_paused', pausedAt: 'x' })])
  it('a live ask reads as asking, a paused seat as unassigned', () => {
    expect(taskReason(task({ status: 'in_progress', runId: 'run_live', agentId: 'agt_1' }), ctx)).toBe('live_ask')
    expect(taskReason(task({ status: 'todo', departmentId: 'dep_m', agentId: 'agt_paused' }), ctx)).toBe('unassigned')
    expect(taskReason(task({ status: 'in_progress', runId: 'run_x', agentId: 'agt_1' }), ctx)).toBeNull()
    const t = task({ status: 'blocked', blockReason: 'needs_input', agentId: 'agt_1' })
    expect(taskReason(t, ctx)).toBe(needsYouReason(t, false, true))
  })
})

describe('department and board counts', () => {
  const ctx = laneContext({ a: ask({ runId: 'run_ask' }) }, [agent({}), agent({ id: 'agt_dev', departmentId: 'dep_d' })])
  const tasks = [
    task({ departmentId: 'dep_m', status: 'in_review' }),
    task({ departmentId: 'dep_m', status: 'in_progress', runId: 'run_x', agentId: 'agt_1' }),
    task({ departmentId: 'dep_m', status: 'blocked', blockReason: 'deps' }),
    task({ departmentId: 'dep_m', status: 'done' }),
    // company-level task handed to a Development seat counts under Development
    task({ departmentId: null, status: 'in_progress', runId: 'run_ask', agentId: 'agt_dev' }),
    task({ departmentId: null, status: 'in_review' }),
    task({ companyId: 'co_b', departmentId: null, status: 'in_review' })
  ]
  it('counts needs-you and working per department, through the agent when the task has none', () => {
    expect(taskDepartment(tasks[4]!, ctx)).toBe('dep_d')
    expect(departmentCounts(tasks, ctx)).toEqual({ dep_m: { needsYou: 1, working: 1 }, dep_d: { needsYou: 1, working: 0 } })
  })
  it('the Board row counts the whole company, department or not', () => {
    expect(boardCounts(tasks, 'co_a', ctx)).toEqual({ needsYou: 3, working: 1, liveAsks: 1 })
    expect(boardCounts(tasks, 'co_b', ctx)).toEqual({ needsYou: 1, working: 0, liveAsks: 0 })
  })
  it('the company header never counts a live ask twice (once as the ask, once as its task)', () => {
    // the live badge already holds the open ask on run_ask and two running agents
    const badge = { needsYou: 1, working: 2, failed: false }
    const merged = mergeBoardBadge(badge, boardCounts(tasks, 'co_a', ctx))
    expect(merged).toEqual({ needsYou: 3, working: 2, failed: false })
    // with no board work the header is exactly the live badge
    expect(mergeBoardBadge(badge, boardCounts([], 'co_a', ctx))).toEqual(badge)
  })
})

describe('seatState', () => {
  const a = agent({})
  it('working shows the task identifier', () => {
    const t = task({ agentId: 'agt_1', status: 'in_progress', runId: 'run_1', identifier: 'PRN-12' })
    expect(seatState(a, [t], new Set()).label).toBe('PRN-12 · working')
    expect(seatState(a, [t], new Set(['run_1']))).toMatchObject({ kind: 'needs', label: 'PRN-12 · needs you' })
  })
  it('parked count when idle with parked tasks; idle otherwise; queue sorted by priority', () => {
    const parked = [task({ agentId: 'agt_1', status: 'blocked', blockReason: 'run_failed' }), task({ agentId: 'agt_1', status: 'blocked', blockReason: 'no_report' })]
    expect(seatState(a, parked, new Set())).toMatchObject({ kind: 'parked', label: '2 parked' })
    const asked = task({ agentId: 'agt_1', status: 'blocked', blockReason: 'needs_input' })
    expect(seatState(a, [asked], new Set())).toMatchObject({ kind: 'parked', label: '1 question' })
    expect(seatState(a, [...parked, asked], new Set())).toMatchObject({ kind: 'parked', label: '3 parked' })
    const low = task({ agentId: 'agt_1', status: 'todo', priority: 4 })
    const urgent = task({ agentId: 'agt_1', status: 'todo', priority: 1 })
    const none = task({ agentId: 'agt_1', status: 'backlog', priority: 0 })
    const deps = task({ agentId: 'agt_1', status: 'blocked', blockReason: 'deps', priority: 2 })
    const st = seatState(a, [low, none, urgent, deps, task({ agentId: 'agt_2' })], new Set())
    expect(st.kind).toBe('idle')
    expect(st.label).toBe('idle · 4 queued')
    expect(st.queue.map((t) => t.id)).toEqual([urgent.id, deps.id, low.id, none.id])
    expect(seatState(a, [], new Set()).label).toBe('idle')
  })
  it('paused and archived win over work', () => {
    const t = task({ agentId: 'agt_1', status: 'in_progress', identifier: 'PRN-3' })
    expect(seatState(agent({ pausedAt: 'x' }), [t], new Set())).toMatchObject({ kind: 'paused', label: 'PRN-3 · paused' })
    expect(seatState(agent({ pausedAt: 'x' }), [], new Set()).label).toBe('paused')
    expect(seatState(agent({ archivedAt: 'x' }), [t], new Set()).kind).toBe('archived')
  })
})

describe('lists and labels', () => {
  it('departmentsOf keeps the company’s active departments in order', () => {
    const list = [dep({ id: 'd2', sortOrder: 2, name: 'Sales' }), dep({ id: 'd1', sortOrder: 1 }), dep({ id: 'dx', archivedAt: 'x' }), dep({ id: 'db', companyId: 'co_b' })]
    expect(departmentsOf(list, 'co_a').map((d) => d.id)).toEqual(['d1', 'd2'])
  })
  it('agentsOf splits department seats from company-level ones and drops archived', () => {
    const list = [agent({ id: 'a1', name: 'B' }), agent({ id: 'a2', name: 'A' }), agent({ id: 'a3', departmentId: null }), agent({ id: 'a4', archivedAt: 'x' })]
    expect(agentsOf(list, 'co_a', 'dep_m').map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(agentsOf(list, 'co_a', null).map((a) => a.id)).toEqual(['a3'])
  })
  it('recurringOf lists workflows, schedules and triggers of the department', () => {
    const items = recurringOf('dep_m', {
      workflows: [{ id: 'w1', name: 'Weekly post', departmentId: 'dep_m' } as Workflow, { id: 'w2', name: 'Other' } as Workflow],
      schedules: [{ id: 's1', name: 'Mondays', departmentId: 'dep_m', enabled: false } as Schedule],
      triggers: [{ id: 'tr1', name: '#support', departmentId: 'dep_m', enabled: true } as SlackTrigger, { id: 'tr2', name: 'x', departmentId: 'dep_d', enabled: true } as SlackTrigger]
    })
    expect(items).toEqual([
      { kind: 'workflow', id: 'w1', name: 'Weekly post', enabled: true },
      { kind: 'schedule', id: 's1', name: 'Mondays', enabled: false },
      { kind: 'trigger', id: 'tr1', name: '#support', enabled: true }
    ])
  })
  it('initials, charter budget and passport path', () => {
    expect(seatInitials('Bug fixer')).toBe('BF')
    expect(seatInitials('copywriter')).toBe('CO')
    expect(seatInitials('  ')).toBe('?')
    expect(charterLength({ does: 'abc', doesNot: 'de' })).toBe(5)
    expect(departmentNotePath(dep({}))).toBe('Departments/Marketing.md')
    expect(departmentNotePath(dep({ data: { ...dep({}).data, passportNote: 'Growth' } }))).toBe('Departments/Growth.md')
  })
})
