import { describe, expect, it } from 'vitest'
import { BLOCK_REASONS, TASK_STATUSES, type BlockReason, type CompanyAgent, type CompanyTask, type TaskStatus } from '@shared/company'
import type { TaskPr, TaskWork } from '@shared/taskWork'
import { laneColumns } from './board'
import { BOARD_COLUMNS, COLUMN_LABEL, boardColumns, branchFor, cardWorkLine, columnDrop, columnOfLane, followsPr, nextIdentifier, nextWorkStep, quickBranchLine, quickRoute, shortBranch, workSteps } from './boardFlow'
import { laneContext } from './departments'

const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id, identifier: `LA-${id}`, title: `Task ${id}`, description: '', companyId: 'co_a', repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null,
    assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z', ...p }) as CompanyTask
const seat = (id: string): CompanyAgent => ({ id, companyId: 'co_a', departmentId: 'dep_d', kind: 'profile', refId: 'p1', name: 'Builder', archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: {} }) as CompanyAgent
const ctx = laneContext({}, [seat('agt_b')])
const pr = (p: Partial<TaskPr> = {}): TaskPr => ({ number: 14, url: 'https://github.com/x/y/pull/14', state: 'OPEN', isDraft: false, reviewDecision: null, mergedAt: null, checkedAt: '2026-10-25T10:00:00Z', ...p })
const work = (p: Partial<TaskWork> = {}): TaskWork => ({ repoId: 'repo_1', worktreePath: '/tmp/w', branch: 'hive/la-18-fix-rounding', baseSha: 'abc', baseRef: 'origin/main', pr: null, startedAt: '2026-10-25T09:00:00Z', worktreeId: 'wt_1', queuedAt: null, goneAt: null, removedAt: null, gh: 'ok', reviewSeenAt: null, readySeen: null, conflict: false, error: null, ...p })

describe('five doors step 5: four Board columns', () => {
  it('names To do · Working · Needs you · Done, in that order', () => {
    expect(BOARD_COLUMNS.map((c) => COLUMN_LABEL[c])).toEqual(['To do', 'Working', 'Needs you', 'Done'])
    expect(columnOfLane('inbox')).toBe('todo')
    expect(columnOfLane('queued')).toBe('todo')
  })
  it('puts every task in exactly one column, the one its lane maps to (counts agree with the lanes)', () => {
    const tasks: CompanyTask[] = []
    for (const status of TASK_STATUSES as readonly TaskStatus[]) {
      const reasons: (BlockReason | null)[] = status === 'blocked' ? [...BLOCK_REASONS, null] : [null]
      for (const blockReason of reasons) for (const departmentId of [null, 'dep_d']) for (const agentId of [null, 'agt_b']) tasks.push(task(`${status}-${blockReason}-${departmentId}-${agentId}`, { status, blockReason, departmentId, agentId }))
    }
    const cols = boardColumns(tasks, ctx)
    const lanes = laneColumns(tasks, ctx)
    expect(Object.values(cols).flat()).toHaveLength(tasks.length)
    expect(cols.todo.length).toBe(lanes.inbox.length + lanes.queued.length)
    expect(cols.working.length).toBe(lanes.working.length)
    expect(cols.needs_you.length).toBe(lanes.needs_you.length)
    expect(cols.done.length).toBe(lanes.done.length)
  })
  it('a drop on To do of a card already there does nothing; Working and Needs you still refuse', () => {
    const inbox = task('1', { status: 'triage' })
    expect(columnDrop(inbox, 'todo', ctx)).toEqual({ ok: true, action: null })
    expect(columnDrop(task('2', { status: 'done' }), 'todo', ctx)).toEqual({ ok: true, action: { kind: 'status', status: 'todo' } })
    expect(columnDrop(task('3'), 'working', ctx).ok).toBe(false)
    expect(columnDrop(task('4'), 'needs_you', ctx).ok).toBe(false)
  })
})

describe('five doors step 5: the branch before Start', () => {
  it('names the branch git will create, and the next identifier from the company counter', () => {
    expect(branchFor('LA-19', 'Add VAT field to invoice PDF')).toBe('hive/la-19-add-vat-field-to-invoice-pdf')
    expect(nextIdentifier('LA', 19)).toBe('LA-20')
    expect(nextIdentifier('LA', 0)).toBe('LA-1')
    expect(nextIdentifier(undefined, 3)).toBeNull()
    expect(nextIdentifier('LA', undefined)).toBeNull()
    expect(quickBranchLine('LA-20', 'Fix PDF export timeout', 'ledgerly-app')).toBe('Starting creates the branch hive/la-20-fix-pdf-export-timeout in ledgerly-app')
    // no repository or no title: no line (a no-code task never mentions branches)
    expect(quickBranchLine('LA-20', 'Fix', null)).toBeNull()
    expect(quickBranchLine('LA-20', '  ', 'ledgerly-app')).toBeNull()
    expect(shortBranch('hive/la-18-fix-rounding')).toBe('la-18-fix-rounding')
  })
})

describe('five doors step 5: one next step, and status follows the PR (A3)', () => {
  const o = { canStart: false, inFlight: false, liveChat: false, repoName: 'ledgerly-app', branch: 'hive/la-19-add-vat-field', who: 'Livia' }
  it('a task to start leads with Start on a new branch and says which branch, where, and that the checkout is untouched', () => {
    const s = nextWorkStep(task('19', { repoId: 'repo_1' }), { ...o, canStart: true })
    expect(s.kind).toBe('start')
    expect(s.label).toBe('Start on a new branch')
    expect(s.note).toContain('hive/la-19-add-vat-field in ledgerly-app')
    expect(s.note).toContain('checkout is untouched')
  })
  it('a task with a branch never shows Start again: working → Open the chat; no GitHub → Connect GitHub; PR open → the PR', () => {
    expect(nextWorkStep(task('18', { status: 'in_progress', work: work() }), { ...o, canStart: true, inFlight: true, liveChat: true })).toMatchObject({ kind: 'openChat', label: 'Open the chat' })
    expect(nextWorkStep(task('18', { status: 'in_progress', work: work() }), { ...o, inFlight: true })).toMatchObject({ kind: 'openChat', label: 'Watch the work' })
    expect(nextWorkStep(task('18', { status: 'in_review', work: work({ gh: 'signed_out' }) }), o)).toMatchObject({ kind: 'connectGithub', label: 'Connect GitHub' })
    const open = nextWorkStep(task('18', { status: 'in_review', work: work({ pr: pr() }) }), o)
    expect(open).toMatchObject({ kind: 'openPr', label: 'Open the pull request' })
    expect(open.note).toMatch(/moves to Done by itself/)
    expect(nextWorkStep(task('18', { status: 'in_review', work: work({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) }) }), o).note).toMatch(/Changes requested/)
  })
  it('merged or done shows no button, and nothing anywhere says Mark merged', () => {
    const merged = nextWorkStep(task('8', { status: 'done', work: work({ pr: pr({ state: 'MERGED' }) }) }), o)
    expect(merged).toMatchObject({ kind: 'done', label: null })
    for (const s of [merged, nextWorkStep(task('18', { status: 'in_review', work: work({ pr: pr() }) }), o)]) expect(`${s.label} ${s.note}`).not.toMatch(/mark merged/i)
  })
  it('queued and gone say so without a button', () => {
    expect(nextWorkStep(task('1', { work: work({ startedAt: null, queuedAt: '2026-10-25T09:00:00Z' }) }), o)).toMatchObject({ kind: 'queued', label: null })
    expect(nextWorkStep(task('1', { work: work({ goneAt: '2026-10-25T09:00:00Z' }) }), o)).toMatchObject({ kind: 'gone', label: null })
  })
  it('the stepper marks what happened and the first open step, with no commit count', () => {
    expect(workSteps(work()).map((s) => s.state)).toEqual(['done', 'current', 'todo'])
    expect(workSteps(work({ pr: pr() })).map((s) => s.state)).toEqual(['done', 'done', 'current'])
    expect(workSteps(work({ pr: pr({ state: 'MERGED' }) })).map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(workSteps(null).map((s) => s.state)).toEqual(['current', 'todo', 'todo'])
    expect(workSteps(work()).map((s) => s.label).join(' ')).not.toMatch(/commit/i)
  })
  it('a task approved as done with no PR ends the stepper at Done (never "Pull request next")', () => {
    const s = workSteps(work(), 'done')
    expect(s.map((x) => [x.key, x.state])).toEqual([['branch', 'done'], ['done', 'done']])
    expect(s.at(-1)!.label).toBe('Done, no pull request')
    expect(workSteps(work({ pr: pr({ state: 'CLOSED' }) }), 'done').map((x) => x.key)).toEqual(['branch', 'pr', 'done'])
    expect(workSteps(work({ pr: pr({ state: 'MERGED' }) }), 'done').map((x) => x.state)).toEqual(['done', 'done', 'done'])
    expect(workSteps(work(), 'in_review').map((x) => x.state)).toEqual(['done', 'current', 'todo'])
  })
  it('an open PR decides (no Approve as done); cards say where the PR is', () => {
    expect(followsPr(task('1', { work: work({ pr: pr() }) }))).toBe(true)
    expect(followsPr(task('1', { work: work() }))).toBe(false)
    expect(followsPr(task('1', { work: work({ pr: pr({ state: 'MERGED' }) }) }))).toBe(false)
    expect(cardWorkLine(work({ pr: pr() }))).toBe('PR #14 open')
    expect(cardWorkLine(work({ pr: pr({ state: 'MERGED' }) }))).toBe('PR #14 merged')
    expect(cardWorkLine(work({ gh: 'signed_out' }))).toBe('Needs GitHub')
    expect(cardWorkLine(work())).toBeNull()
  })
})

describe('quick create "auto" picks an agent (design §4.5, Diego §9)', () => {
  const seats = [
    { id: 'a_dev', departmentId: 'd_dev', archivedAt: null },
    { id: 'a_qa', departmentId: 'd_dev', archivedAt: null },
    { id: 'a_mkt', departmentId: 'd_mkt', archivedAt: null },
    { id: 'a_old', departmentId: 'd_dev', archivedAt: '2026-01-01T00:00:00Z' }
  ]
  const desk = [
    { id: 'a_mkt', name: 'Livia', role: 'Content Writer', department: 'Marketing' },
    { id: 'a_dev', name: 'Dev Builder', role: 'Developer', department: 'Development' },
    { id: 'a_qa', name: 'Tess', role: 'Test Engineer', department: 'Development' },
    { id: 'a_old', name: 'Old', role: 'Developer', department: 'Development' }
  ]
  it('routes by the words of the title, with its department', () => {
    expect(quickRoute('Write a blog post about VAT', null, seats, desk)).toEqual({ agentId: 'a_mkt', departmentId: 'd_mkt' })
    expect(quickRoute('Fix the flaky test for VAT rounding', null, seats, desk)).toEqual({ agentId: 'a_qa', departmentId: 'd_dev' })
  })
  it('stays inside the chosen department and never picks an archived seat', () => {
    expect(quickRoute('Write a blog post', 'd_dev', seats, desk)?.agentId).toMatch(/^a_(dev|qa)$/)
    expect(quickRoute('Developer things', 'd_dev', seats, desk)?.agentId).not.toBe('a_old')
  })
  it('falls back to the first active agent; null only with no agent at all', () => {
    expect(quickRoute('Add VAT field to invoice form', null, seats, desk)).not.toBeNull()
    expect(quickRoute('Anything', null, [], [])).toBeNull()
  })
})
