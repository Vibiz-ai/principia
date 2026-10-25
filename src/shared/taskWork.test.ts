import { describe, expect, it } from 'vitest'
import { canStartWork, nextMove, prChip, taskBranchName, taskWorktreeDir, workBrief, workGone, workQueued, workStarted, type TaskPr, type TaskWork } from './taskWork'

const pr = (o: Partial<TaskPr> = {}): TaskPr => ({ number: 42, url: 'https://github.com/a/b/pull/42', state: 'OPEN', isDraft: false, reviewDecision: null, mergedAt: null, checkedAt: '2026-10-25T00:00:00.000Z', ...o })
const work = (o: Partial<TaskWork> = {}): TaskWork => ({
  repoId: 'repo_1', worktreePath: '/u/worktrees/task-PRN-12', branch: 'hive/prn-12-fix', baseSha: 'a'.repeat(40), baseRef: 'origin/main', pr: null,
  startedAt: '2026-10-25T00:00:00.000Z', worktreeId: 'worktree_1', queuedAt: null, goneAt: null, removedAt: null, gh: null, reviewSeenAt: null, readySeen: null, conflict: false, error: null, ...o
})

describe('WORKTREE.md names', () => {
  it('branch stays inside hive/* and is named after the task', () => {
    expect(taskBranchName('PRN-12', 'Fix the login redirect!')).toBe('hive/prn-12-fix-the-login-redirect')
    expect(taskBranchName('PRN-7', '¿Qué pasó?')).toBe('hive/prn-7-que-paso')
    expect(taskBranchName('PRN-7', '!!!')).toBe('hive/prn-7')
    expect(taskBranchName('PRN-7', 'x'.repeat(200)).length).toBeLessThanOrEqual(5 + 6 + 1 + 40)
  })
  it('the worktree folder is task-<identifier> and cannot escape the worktrees root', () => {
    expect(taskWorktreeDir('PRN-12')).toBe('task-PRN-12')
    expect(taskWorktreeDir('../../etc')).toBe('task-etc')
  })
  it('the brief tells the agent where it works and what it may push', () => {
    const b = workBrief(work())
    expect(b).toContain('/u/worktrees/task-PRN-12')
    expect(b).toContain('hive/prn-12-fix')
    expect(b).toMatch(/not a draft/)
    expect(b).toMatch(/merging is the founder's/)
  })
})

describe('Start is offered only on a code task of the company', () => {
  const t = (o: Record<string, unknown> = {}) => ({ repoId: 'repo_1', status: 'todo', work: null, ...o }) as { repoId: string | null; status: string; work: TaskWork | null }
  it('needs a repo the company owns, an open task and no binding', () => {
    expect(canStartWork(t(), ['repo_1'])).toBe(true)
    expect(canStartWork(t({ repoId: null }), ['repo_1'])).toBe(false)
    expect(canStartWork(t(), ['repo_2'])).toBe(false)
    for (const status of ['done', 'canceled', 'in_progress']) expect(canStartWork(t({ status }), ['repo_1'])).toBe(false)
    expect(canStartWork(t({ work: work() }), ['repo_1'])).toBe(false)
    expect(canStartWork(t({ work: work({ startedAt: null, queuedAt: '2026-10-25T00:00:00.000Z' }) }), ['repo_1'])).toBe(false)
    // removed (Keep As Is, or Remove Worktree…): it can be Started again
    expect(canStartWork(t({ work: work({ removedAt: '2026-10-25T00:00:00.000Z' }) }), ['repo_1'])).toBe(true)
  })
  it('started / queued / gone', () => {
    expect(workStarted(work())).toBe(true)
    expect(workStarted(work({ removedAt: 'x' }))).toBe(false)
    expect(workQueued(work({ queuedAt: 'x' }))).toBe(true)
    expect(workGone(work({ goneAt: 'x' }))).toBe(true)
    expect(workGone(work({ goneAt: 'x', removedAt: 'y' }))).toBe(false)
  })
})

describe('the PR chip', () => {
  it('says what GitHub says, with cool colours only', () => {
    expect(prChip(null)).toBeNull()
    expect(prChip(pr())).toEqual({ label: '#42 Open', tone: 'running' })
    expect(prChip(pr({ isDraft: true }))?.label).toBe('#42 Draft')
    expect(prChip(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toEqual({ label: '#42 Changes requested', tone: 'failed' })
    expect(prChip(pr({ reviewDecision: 'APPROVED' }))?.label).toBe('#42 Approved')
    expect(prChip(pr({ state: 'MERGED' }))).toEqual({ label: '#42 Merged', tone: 'passed' })
    expect(prChip(pr({ state: 'CLOSED' }))?.label).toBe('#42 Closed')
  })
})

describe('nextMove: the task follows its PR', () => {
  const w = work()
  it('merged → done with the note; never while a run holds the task', () => {
    expect(nextMove({ status: 'in_review' }, pr({ state: 'MERGED' }), w, null)).toEqual({ kind: 'done', note: 'Merged #42' })
    expect(nextMove({ status: 'blocked' }, pr({ state: 'MERGED' }), w, null).kind).toBe('done')
    expect(nextMove({ status: 'in_progress' }, pr({ state: 'MERGED' }), w, null).kind).toBe('none')
    expect(nextMove({ status: 'done' }, pr({ state: 'MERGED' }), w, null).kind).toBe('none')
  })
  it('open and ready → in_review once per PR (a send back is not undone)', () => {
    expect(nextMove({ status: 'blocked' }, pr(), w, null).kind).toBe('review')
    expect(nextMove({ status: 'todo' }, pr(), work({ readySeen: 42 }), null).kind).toBe('none')
    expect(nextMove({ status: 'in_review' }, pr(), w, null).kind).toBe('none')
    expect(nextMove({ status: 'blocked' }, pr({ isDraft: true }), w, null).kind).toBe('none')
    expect(nextMove({ status: 'in_progress' }, pr(), w, null).kind).toBe('none')
  })
  it('changes requested on a task in review → back to work, once per review', () => {
    const cr = pr({ reviewDecision: 'CHANGES_REQUESTED' })
    expect(nextMove({ status: 'in_review' }, cr, w, '2026-10-25T01:00:00Z')).toEqual({ kind: 'changes', reviewAt: '2026-10-25T01:00:00Z' })
    expect(nextMove({ status: 'in_review' }, cr, work({ reviewSeenAt: '2026-10-25T01:00:00Z' }), '2026-10-25T01:00:00Z').kind).toBe('none')
    expect(nextMove({ status: 'in_review' }, cr, work({ reviewSeenAt: '2026-10-25T01:00:00Z' }), '2026-10-25T02:00:00Z').kind).toBe('changes')
    expect(nextMove({ status: 'blocked' }, cr, w, null).kind).toBe('none')
  })
  it('A3: approved by a reviewer → done on a task in review, never while a run holds it or after a send back', () => {
    const ap = pr({ reviewDecision: 'APPROVED' })
    expect(nextMove({ status: 'in_review' }, ap, w, null)).toEqual({ kind: 'done', note: 'Approved #42', approved: true })
    expect(nextMove({ status: 'in_progress' }, ap, w, null).kind).toBe('none')
    expect(nextMove({ status: 'todo' }, ap, work({ readySeen: 42 }), null).kind).toBe('none')
    expect(nextMove({ status: 'in_review' }, pr({ reviewDecision: 'APPROVED', isDraft: true }), w, null).kind).toBe('none')
  })
  it('a closed PR moves nothing', () => {
    expect(nextMove({ status: 'in_review' }, pr({ state: 'CLOSED' }), w, null).kind).toBe('none')
  })
})
