/** PLANS.md v2 in the Plans view: no autonomy control on a finished plan, the Archive wording, the Open a PR fallback. */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Plan } from '@shared/plans'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const plan = (p: Partial<Plan> = {}): Plan => ({
  id: 'plan_1', companyId: 'co_1', repoId: 'repo_1', goal: 'Ship it', autonomy: 'checkins', status: 'done', headAgentId: null, body: '',
  milestones: [{ id: 'm_1', key: 'M1', title: 'One', dependsOn: [], passCriteria: [], agentId: null, taskId: 'task_m1', gate: { result: 'pass', notes: 'ok', at: null, evidence: ['e'], fails: 0 }, passedAt: '2026-10-25T00:00:00Z', worktree: { path: '/u/worktrees/task-PRN-1', branch: 'hive/prn-1-m1-one' }, sessionId: null }],
  tasks: [], drafting: false, draftError: null, halted: null, changes: [], createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', approvedAt: '2026-10-25T00:00:00Z', ...p
})

describe('Plans view', () => {
  it('the autonomy control shows only while there is something left to run', async () => {
    const { showsAutonomy } = await import('./PlansView')
    expect(showsAutonomy({ status: 'running' })).toBe(true)
    expect(showsAutonomy({ status: 'done' })).toBe(false)
    expect(showsAutonomy({ status: 'archived' })).toBe(false)
    expect(showsAutonomy({ status: 'draft' })).toBe(false)
  })

  it('Stop and Archive says the tasks in review leave Needs you', async () => {
    const { archiveText } = await import('./PlansView')
    expect(archiveText(2, 0)).toBe('Cancels 2 open tasks of this plan.')
    expect(archiveText(1, 2)).toBe('Cancels 1 open task and 2 in review of this plan (they leave Needs you).')
    expect(archiveText(0, 1)).toBe('Cancels 1 in review of this plan (they leave Needs you).')
  })

  it('gh missing: the Code block names the branch and gives the Open a PR commands; never a merge command', async () => {
    const { PlanNotes } = await import('./PlansView')
    const html = renderToStaticMarkup(createElement(PlanNotes, { plan: plan({ result: { branch: 'hive/prn-1-m1-one', taskId: 'task_m1', baseBranch: 'main', pushed: true, pr: null, gh: 'missing', mergedAt: null, error: null } }) }))
    expect(html).toContain('hive/prn-1-m1-one')
    expect(html).toContain('pushed, no pull request yet')
    expect(html).toContain('The GitHub CLI is not installed')
    expect(html).toContain('gh pr create --head hive/prn-1-m1-one --base main')
    expect(html).not.toMatch(/git merge|Merge into/)
  })

  it('an open PR shows its chip', async () => {
    const { PlanNotes } = await import('./PlansView')
    const html = renderToStaticMarkup(createElement(PlanNotes, { plan: plan({ result: { branch: 'hive/x', taskId: 'task_m1', baseBranch: 'main', pushed: true, pr: { number: 42, url: 'https://github.com/a/b/pull/42', state: 'OPEN', isDraft: false, reviewDecision: null, mergedAt: null, checkedAt: '2026-10-25T00:00:00Z' }, gh: 'ok', mergedAt: null, error: null } }) }))
    expect(html).toContain('PR #42 into main')
    expect(html).toContain('#42 Open')
    expect(html).not.toContain('gh pr create')
  })
})
