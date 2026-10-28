import { describe, expect, it } from 'vitest'
import type { CompanyTask } from '@shared/company'
import type { InstalledDashboard } from '@shared/dashboards'
import { dashboardsByDepartment, openTaskCounts, setDepartmentOpen, setTeamOpen, teamNavOf, withTeamNav } from './teamNav'
import type { LaneContext } from './departments'

const ctx: LaneContext = { openRuns: new Set(), agentsById: new Map() }
const task = (id: string, status: string, departmentId: string | null): CompanyTask => ({ id, status, departmentId, agentId: null, companyId: 'co_acme' }) as unknown as CompanyTask
const dash = (id: string, kind: string, departmentId: string | null): InstalledDashboard => ({ id, kind, departmentId, companyId: 'co_acme' }) as unknown as InstalledDashboard

describe('lib/teamNav: Team’s nested list in the sidebar', () => {
  it('reads a closed state for a missing or malformed company entry', () => {
    expect(teamNavOf(null, 'co_acme')).toEqual({ open: false, departments: [] })
    expect(teamNavOf({ co_acme: 'yes' }, 'co_acme')).toEqual({ open: false, departments: [] })
    expect(teamNavOf({ co_acme: { open: true, departments: ['dep_a', 3] } }, 'co_acme')).toEqual({ open: true, departments: ['dep_a'] })
  })

  it('keeps each company’s state apart and drops a fully closed one', () => {
    let all = withTeamNav({}, 'co_acme', setTeamOpen(teamNavOf({}, 'co_acme'), true))
    all = withTeamNav(all, 'co_globex', setDepartmentOpen(teamNavOf(all, 'co_globex'), 'dep_g', true))
    expect(teamNavOf(all, 'co_acme')).toEqual({ open: true, departments: [] })
    expect(teamNavOf(all, 'co_globex')).toEqual({ open: false, departments: ['dep_g'] })
    all = withTeamNav(all, 'co_acme', setTeamOpen(teamNavOf(all, 'co_acme'), false))
    expect(Object.keys(all)).toEqual(['co_globex'])
  })

  it('toggles a department without duplicating it', () => {
    let s = setDepartmentOpen({ open: true, departments: [] }, 'dep_a', true)
    s = setDepartmentOpen(s, 'dep_a', true)
    expect(s.departments).toEqual(['dep_a'])
    expect(setDepartmentOpen(s, 'dep_a', false).departments).toEqual([])
  })

  it('counts open tasks per department, leaving out done and canceled ones', () => {
    const counts = openTaskCounts([task('t1', 'todo', 'dep_a'), task('t2', 'in_progress', 'dep_a'), task('t3', 'done', 'dep_a'), task('t4', 'canceled', 'dep_b'), task('t5', 'in_review', 'dep_b'), task('t6', 'todo', null)], ctx)
    expect(counts).toEqual({ dep_a: 2, dep_b: 1 })
  })

  it('groups installed dashboards by department under their catalog names', () => {
    const rows = dashboardsByDepartment([dash('d1', 'github', 'dep_eng'), dash('d2', 'not-a-kind', 'dep_eng'), dash('d3', 'stripe', null)])
    expect(rows).toEqual({ dep_eng: [{ id: 'd1', name: 'Engineering · GitHub' }] })
  })
})
