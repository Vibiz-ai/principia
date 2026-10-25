import { describe, expect, it } from 'vitest'
import type { CompanyAgent, CompanyPassport, CompanyTask } from '@shared/company'
import { brandNewUser, firstWeekRows, showThingsMoved, THINGS_MOVED } from './firstRun'

const co = (p: Partial<CompanyPassport> = {}) => ({ system: null, archivedAt: null, createdAt: '2026-10-01T00:00:00Z', ...p }) as CompanyPassport
const personal = co({ system: 'personal' })
const seat = (id: string, p: Partial<CompanyAgent> = {}): CompanyAgent => ({ id, companyId: 'co_a', departmentId: 'dep', kind: 'profile', refId: 'p', name: id, archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: {}, ...p }) as CompanyAgent
const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask => ({ id, identifier: id, title: id, companyId: 'co_a', status: 'todo', priority: 3, updatedAt: '2026-10-20T00:00:00Z', ...p }) as CompanyTask

describe('five doors step 5: Things moved, once, for people who used the old app', () => {
  const base = { notices: {}, companies: [personal, co()], taskCount: 0, onboardingOpen: false, firstWeekPending: false }
  it('shows for a user with a company or a task', () => {
    expect(showThingsMoved(base)).toBe(true)
    expect(showThingsMoved({ ...base, companies: [personal], taskCount: 3 })).toBe(true)
  })
  it('never for a new user, during onboarding, while the first week waits, or once dismissed', () => {
    expect(showThingsMoved({ ...base, companies: [personal] })).toBe(false)
    expect(showThingsMoved({ ...base, onboardingOpen: true })).toBe(false)
    expect(showThingsMoved({ ...base, firstWeekPending: true })).toBe(false)
    expect(showThingsMoved({ ...base, notices: { [THINGS_MOVED]: '2026-10-25' } })).toBe(false)
    expect(showThingsMoved({ ...base, companies: [personal, co({ archivedAt: '2026-10-02' })] })).toBe(false)
  })
})

describe('five doors step 5: the first week', () => {
  it('lists each active agent with the first task onboarding promised (its oldest To do, as the dispatcher picks); idle agents last', () => {
    const agents = [seat('marcus'), seat('pliny'), seat('cato'), seat('gone', { archivedAt: 'x' }), seat('other', { companyId: 'co_b' })]
    // the plan made SS-1 (Write a 2-week content calendar) before SS-2 (Draft 3 ad angles), even though SS-2 is more urgent
    const tasks = [task('SS-1', { agentId: 'pliny', priority: 3 }), task('SS-2', { agentId: 'pliny', priority: 1 }), task('SS-3', { agentId: 'marcus' }), task('SS-4', { agentId: 'cato', status: 'done' }), task('SS-5', { agentId: 'other', companyId: 'co_b' }), task('SS-0', { agentId: 'marcus', status: 'backlog' })]
    const rows = firstWeekRows('co_a', agents, tasks)
    expect(rows.map((r) => [r.agent.id, r.task?.id ?? null])).toEqual([['marcus', 'SS-3'], ['pliny', 'SS-1'], ['cato', null]])
  })
  it('a brand-new user is someone whose only company is the one just made', () => {
    const fresh = [personal, co({ id: 'co_new' })]
    expect(brandNewUser('co_new', fresh, [{ companyId: 'co_new' }])).toBe(true)
    expect(brandNewUser('co_new', [...fresh, co({ id: 'co_old' })], [])).toBe(false)
    expect(brandNewUser('co_new', fresh, [{ companyId: 'co_personal' }])).toBe(false)
    expect(brandNewUser('co_new', [...fresh, co({ id: 'co_gone', archivedAt: 'x' })], [])).toBe(true)
  })
})
