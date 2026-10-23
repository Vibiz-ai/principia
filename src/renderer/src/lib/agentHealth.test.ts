import { describe, expect, it } from 'vitest'
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { Ask } from '@shared/live'
import { companiesHealth, companyHealthy, isParked, type HealthState } from './agentHealth'

const agent = (id: string, p: Partial<CompanyAgent> = {}): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId: 'dep_m', kind: 'profile', refId: 'p1', name: 'Copywriter', archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: {}, ...p }) as CompanyAgent
const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id, identifier: `PRN-${id}`, title: id, companyId: 'co_a', status: 'todo', blockReason: null, priority: 3, agentId: 'agt_1', departmentId: 'dep_m', runId: null, createdAt: '', updatedAt: '', ...p }) as CompanyTask
const ask = (runId: string): Ask => ({ id: `ask_${runId}`, status: 'open', runId, agentId: 'x', rootId: 'x' }) as Ask

const base = (p: Partial<HealthState> = {}): HealthState => ({ companyAgents: [agent('agt_1')], tasks: [task('1')], asks: {}, badges: { co_a: { needsYou: 0, failed: false } }, ...p })

describe('companyHealthy (VOICE.md §5.10)', () => {
  it('is true for a company with an active agent, nothing parked, nothing waiting and no failure', () => {
    expect(companyHealthy('co_a', base())).toBe(true)
    // working counts as healthy: the laurel and the working ring coexist
    expect(companyHealthy('co_a', base({ tasks: [task('1', { status: 'in_progress', runId: 'run_1' })] }))).toBe(true)
    // no badge entry yet (overview not loaded) reads as nothing waiting
    expect(companyHealthy('co_a', base({ badges: undefined }))).toBe(true)
  })

  it('needs at least one active agent of that company', () => {
    expect(companyHealthy('co_a', base({ companyAgents: [] }))).toBe(false)
    expect(companyHealthy('co_a', base({ companyAgents: [agent('agt_1', { archivedAt: '2026-10-01T00:00:00Z' })] }))).toBe(false)
    expect(companyHealthy('co_a', base({ companyAgents: [agent('agt_1', { companyId: 'co_b' })] }))).toBe(false)
  })

  it('is false while any agent is paused (an archived paused one does not count)', () => {
    expect(companyHealthy('co_a', base({ companyAgents: [agent('agt_1'), agent('agt_2', { pausedAt: '2026-10-20T00:00:00Z' })] }))).toBe(false)
    expect(companyHealthy('co_a', base({ companyAgents: [agent('agt_1'), agent('agt_2', { pausedAt: 'x', archivedAt: 'y' })] }))).toBe(true)
  })

  it('is false with a parked task, but a dependency wait is fine', () => {
    expect(companyHealthy('co_a', base({ tasks: [task('1', { status: 'blocked', blockReason: 'run_failed' })] }))).toBe(false)
    expect(companyHealthy('co_a', base({ tasks: [task('1', { status: 'blocked', blockReason: 'needs_input' })] }))).toBe(false)
    expect(companyHealthy('co_a', base({ tasks: [task('1', { status: 'blocked', blockReason: 'deps' })] }))).toBe(true)
    expect(isParked({ status: 'blocked', blockReason: null })).toBe(true)
    expect(isParked({ status: 'todo', blockReason: null })).toBe(false)
  })

  it('is false when anything needs you: the live badge, a review, a live ask on a running task, an unassigned task', () => {
    expect(companyHealthy('co_a', base({ badges: { co_a: { needsYou: 1, failed: false } } }))).toBe(false)
    expect(companyHealthy('co_a', base({ tasks: [task('1', { status: 'in_review' })] }))).toBe(false)
    const running = task('1', { status: 'in_progress', runId: 'run_9' })
    expect(companyHealthy('co_a', base({ tasks: [running], asks: { a: ask('run_9') } }))).toBe(false)
    expect(companyHealthy('co_a', base({ tasks: [running], asks: [ask('run_other')] }))).toBe(true)
    expect(companyHealthy('co_a', base({ tasks: [task('1', { agentId: null })] }))).toBe(false)
  })

  it('is false when a run failed in the last 24 h', () => {
    expect(companyHealthy('co_a', base({ badges: { co_a: { needsYou: 0, failed: true } } }))).toBe(false)
  })

  it('looks only at its own company', () => {
    const state = base({
      companyAgents: [agent('agt_1'), agent('agt_b', { companyId: 'co_b', pausedAt: 'x' })],
      tasks: [task('1'), task('2', { companyId: 'co_b', status: 'in_review', agentId: 'agt_b' })],
      badges: { co_a: { needsYou: 0, failed: false }, co_b: { needsYou: 3, failed: true } }
    })
    expect(companiesHealth(['co_a', 'co_b', 'co_c'], state)).toEqual({ co_a: true, co_b: false, co_c: false })
  })
})
