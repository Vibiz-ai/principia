/** WORKTREE.md QA fixes in the inspector: Start for a repo added a moment ago, and the branch line after Keep As Is. */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyPassport, CompanyTask } from '@shared/company'
import type { TaskWork } from '@shared/taskWork'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const personal = { id: 'co_personal', name: 'Personal', system: 'personal', repoIds: [] } as unknown as CompanyPassport
const task = (p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id: 'task_1', identifier: 'PRN-1', title: 'Fix it', companyId: 'co_personal', repoId: 'repo_new', status: 'todo', dependencyIds: [], ...p }) as CompanyTask
const work = (p: Partial<TaskWork> = {}): TaskWork => ({ repoId: 'repo_new', worktreePath: '/u/worktrees/task-PRN-1', branch: 'hive/prn-1-fix-it', baseSha: 'abc', baseRef: 'origin/main', pr: null, startedAt: '2026-10-25T00:00:00Z', worktreeId: 'worktree_1', queuedAt: null, goneAt: null, removedAt: null, gh: null, reviewSeenAt: null, readySeen: null, conflict: false, error: null, ...p })

describe('TaskWork', () => {
  it('Start shows for a Personal task on a repo the company rows do not list yet (the live repo list has it)', async () => {
    const { setState } = await import('../../state/store')
    const { WorkStart, companyRepoIds } = await import('./TaskWork')
    setState({ repos: [] })
    expect(renderToStaticMarkup(createElement(WorkStart, { task: task(), company: personal, busy: false, onDone: () => {} }))).toBe('')
    setState({ repos: [{ id: 'repo_new', name: 'new', path: '/r/new', companyId: null } as never] })
    expect(companyRepoIds(personal, [{ id: 'repo_new', companyId: null } as never])).toEqual(['repo_new'])
    expect(renderToStaticMarkup(createElement(WorkStart, { task: task(), company: personal, busy: false, onDone: () => {} }))).toContain('Start')
  })

  it('after Keep As Is the Work section keeps the branch and says Start checks it out again', async () => {
    const { WorkSection, WorkStart } = await import('./TaskWork')
    const t = task({ status: 'in_review', work: work({ removedAt: '2026-10-25T01:00:00Z' }) })
    const html = renderToStaticMarkup(createElement(WorkSection, { task: t, onDone: () => {} }))
    expect(html).toContain('hive/prn-1-fix-it')
    expect(html).toContain('Worktree removed. Start (or Run now) checks out hive/prn-1-fix-it again.')
    expect(html).not.toContain('Remove Worktree')
    const { setState } = await import('../../state/store')
    setState({ repos: [{ id: 'repo_new', name: 'new', path: '/r/new', companyId: null } as never] })
    expect(renderToStaticMarkup(createElement(WorkStart, { task: t, company: personal, busy: false, onDone: () => {} }))).toContain('Checks out hive/prn-1-fix-it in a new worktree.')
  })
})
