import { describe, expect, it } from 'vitest'
import { BLOCK_REASONS, TASK_STATUSES, laneOf, type BlockReason, type CompanyAgent, type CompanyTask, type Department, type TaskActivity, type TaskStatus } from '@shared/company'
import type { Ask } from '@shared/live'
import { agentDrop, autopilotToggle, canApprove, statusChoices, coalesceActivity, dropSeats, filterTasks, inspectorActions, keptDepartmentFilter, laneColumns, laneDrop, learnRunTask, laneText, needsYouTasks, overnight, swimlanes, taskForRun, taskRunLabel } from './board'
import { laneContext } from './departments'
import { taskCounts, taskCountsLine, startOfDay } from './companyModel'

const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id, identifier: `PRN-${id}`, title: `Task ${id}`, description: '', companyId: 'co_a', repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null,
    assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z', ...p }) as CompanyTask
const dep = (id: string, name: string, sortOrder = 0, companyId = 'co_a'): Department =>
  ({ id, companyId, key: id, name, color: 'var(--accent)', icon: null, sortOrder, archivedAt: null, createdAt: '', updatedAt: '', data: {} }) as Department
const seat = (id: string, p: Partial<CompanyAgent> = {}): CompanyAgent =>
  ({ id, companyId: 'co_a', departmentId: 'dep_m', kind: 'profile', refId: 'p1', name: 'Copywriter', archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: {}, ...p }) as CompanyAgent
const ask = (runId: string): Ask => ({ id: `ask_${runId}`, runId, status: 'open', agentId: 'x', rootId: 'x' }) as Ask

const copy = seat('agt_copy')
const paused = seat('agt_paused', { name: 'Paused one', pausedAt: '2026-10-20T00:00:00Z' })
const ctx = laneContext({ a1: ask('run_asking') }, [copy, paused])

describe('board lanes', () => {
  it('puts every status and block reason in the column laneOf names', () => {
    const tasks: CompanyTask[] = []
    for (const status of TASK_STATUSES as readonly TaskStatus[]) {
      const reasons: (BlockReason | null)[] = status === 'blocked' ? [...BLOCK_REASONS, null] : [null]
      for (const blockReason of reasons) {
        for (const agentId of [null, 'agt_copy', 'agt_paused']) {
          for (const departmentId of [null, 'dep_m']) tasks.push(task(`${status}-${blockReason}-${agentId}-${departmentId}`, { status, blockReason, agentId, departmentId }))
        }
      }
    }
    tasks.push(task('asking', { status: 'in_progress', runId: 'run_asking', agentId: 'agt_copy' }))
    const cols = laneColumns(tasks, ctx)
    for (const t of tasks) {
      const expected = laneOf(t, t.runId === 'run_asking', !t.agentId || t.agentId === 'agt_copy')
      expect(cols[expected].map((x) => x.id), `${t.id} → ${expected}`).toContain(t.id)
    }
    expect(Object.values(cols).flat()).toHaveLength(tasks.length)
    expect(cols.needs_you.some((t) => t.id === 'asking')).toBe(true)
  })
  it('sorts by priority (no priority last), Done newest first', () => {
    const cols = laneColumns([task('1', { priority: 0 }), task('2', { priority: 1 }), task('3', { priority: 4 }), task('d1', { status: 'done', updatedAt: '2026-10-19T00:00:00Z' }), task('d2', { status: 'done', updatedAt: '2026-10-20T00:00:00Z' })], ctx)
    expect(cols.queued.map((t) => t.id)).toEqual(['2', '3', '1'])
    expect(cols.done.map((t) => t.id)).toEqual(['d2', 'd1'])
  })
  it('filters by company, department, agent, search and the Backlog toggle', () => {
    const tasks = [task('1', { departmentId: 'dep_m' }), task('2', { status: 'backlog' }), task('3', { companyId: 'co_b', title: 'Logo' }), task('4', { agentId: 'agt_copy' })]
    expect(filterTasks(tasks, { companyId: 'co_a', showBacklog: false }, ctx).map((t) => t.id)).toEqual(['1', '4'])
    // the agent's department counts for a task with none of its own
    expect(filterTasks(tasks, { departmentId: 'dep_m' }, ctx).map((t) => t.id)).toEqual(['1', '4'])
    expect(filterTasks(tasks, { agentId: 'agt_copy' }, ctx).map((t) => t.id)).toEqual(['4'])
    expect(filterTasks(tasks, { search: 'logo' }, ctx).map((t) => t.id)).toEqual(['3'])
  })
  it('swimlanes follow department order and add No department when used', () => {
    const lanes = swimlanes([task('1', { departmentId: 'dep_d' }), task('2')], [dep('dep_m', 'Marketing', 0), dep('dep_d', 'Development', 1)], ctx)
    expect(lanes.map((l) => [l.department?.name ?? null, l.count])).toEqual([['Marketing', 0], ['Development', 1], [null, 1]])
  })
  it('describes the lane and reason for the list view', () => {
    expect(laneText(task('1', { status: 'blocked', blockReason: 'needs_input' }), ctx)).toBe('Needs you · Question')
    expect(laneText(task('2', { status: 'blocked', blockReason: 'deps' }), ctx)).toBe('Queued · Waiting on dependencies')
    expect(laneText(task('3', { status: 'in_progress' }), ctx)).toBe('Working')
  })
})

describe('drag and drop', () => {
  it('never allows a drop into Working, from any lane', () => {
    for (const status of TASK_STATUSES) {
      const r = laneDrop(task('1', { status, blockReason: status === 'blocked' ? 'manual' : null }), 'working', ctx)
      if (status === 'in_progress') expect(r).toEqual({ ok: true, action: null })
      else expect(r.ok).toBe(false)
    }
  })
  it('refuses Needs you and Done (approve needs a note) and snaps running cards back', () => {
    expect(laneDrop(task('1'), 'needs_you', ctx).ok).toBe(false)
    const done = laneDrop(task('1', { status: 'in_review' }), 'done', ctx)
    expect(done.ok).toBe(false)
    expect(!done.ok && done.reason).toMatch(/done note/)
    expect(laneDrop(task('1', { status: 'in_progress' }), 'queued', ctx).ok).toBe(false)
    expect(laneDrop(task('1', { status: 'in_review' }), 'queued', ctx).ok).toBe(false)
  })
  it('maps legal moves to one action', () => {
    expect(laneDrop(task('1', { status: 'triage', departmentId: 'dep_m', agentId: 'agt_copy' }), 'queued', ctx)).toEqual({ ok: true, action: { kind: 'status', status: 'todo' } })
    expect(laneDrop(task('1', { status: 'triage' }), 'queued', ctx).ok).toBe(false)
    expect(laneDrop(task('1', { status: 'blocked', blockReason: 'run_failed' }), 'queued', ctx)).toEqual({ ok: true, action: { kind: 'unpark' } })
    expect(laneDrop(task('1', { status: 'todo' }), 'inbox', ctx)).toEqual({ ok: true, action: { kind: 'status', status: 'triage' } })
    expect(laneDrop(task('1', { status: 'done' }), 'queued', ctx)).toEqual({ ok: true, action: { kind: 'status', status: 'todo' } })
    expect(laneDrop(task('1', { status: 'todo' }), 'queued', ctx)).toEqual({ ok: true, action: null })
    // routed but no eligible agent: only an assignment moves it out of Needs you
    expect(laneDrop(task('1', { status: 'todo', departmentId: 'dep_m' }), 'queued', ctx).ok).toBe(false)
  })
  it('never unparks an open question by drag: it is answered', () => {
    const q = task('1', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'question', prompt: 'Which logo?' } })
    const r = laneDrop(q, 'queued', ctx)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/Answer/)
    expect(laneDrop(q, 'inbox', ctx).ok).toBe(false)
    // a needs_input park without an open question (answered, or an older row) unparks like any other park
    expect(laneDrop(task('2', { status: 'blocked', blockReason: 'needs_input', ask: null }), 'queued', ctx)).toEqual({ ok: true, action: { kind: 'unpark' } })
    expect(laneDrop(task('3', { status: 'blocked', blockReason: null }), 'queued', ctx)).toEqual({ ok: true, action: { kind: 'unpark' } })
  })
  it('a drop on an agent avatar assigns, with the agent’s department', () => {
    expect(agentDrop(task('1'), copy)).toEqual({ ok: true, action: { kind: 'assign', agentId: 'agt_copy', departmentId: 'dep_m' } })
    expect(agentDrop(task('1'), seat('agt_co', { departmentId: null }))).toEqual({ ok: true, action: { kind: 'assign', agentId: 'agt_co' } })
    expect(agentDrop(task('1', { agentId: 'agt_copy' }), copy)).toEqual({ ok: true, action: null })
    expect(agentDrop(task('1', { status: 'in_progress' }), copy).ok).toBe(false)
    expect(agentDrop(task('1', { companyId: 'co_b' }), copy).ok).toBe(false)
    expect(agentDrop(task('1'), seat('agt_x', { archivedAt: '2026-01-01' })).ok).toBe(false)
  })
  it('lists the company’s seats as drop targets, active first', () => {
    const list = dropSeats([paused, copy, seat('agt_b', { companyId: 'co_b' }), seat('agt_arch', { archivedAt: 'x' })], 'co_a')
    expect(list.map((a) => a.id)).toEqual(['agt_copy', 'agt_paused'])
    expect(dropSeats([copy], undefined)).toEqual([])
  })
})

describe('inspector', () => {
  const act = (kind: TaskActivity['kind'], message: string, by: TaskActivity['by'] = 'system'): TaskActivity => ({ id: `${kind}${Math.random()}`, taskId: 't', kind, message, by, createdAt: '2026-10-20T08:00:00Z' })
  it('coalesces repeated wakes into one row with a count', () => {
    const rows = coalesceActivity([act('started', 'Started'), act('coalesced', 'comment'), act('coalesced', 'slack'), act('coalesced', 'comment'), act('comment', 'hi', 'human'), act('comment', 'hi', 'human')])
    expect(rows.map((r) => [r.kind, r.count])).toEqual([['started', 1], ['coalesced', 3], ['comment', 1], ['comment', 1]])
  })
  it('offers the actions of the task’s state', () => {
    expect([...inspectorActions(task('1', { status: 'in_review' }), { hasAgent: true, headlessRun: false })].sort()).toEqual(['approve', 'openSession', 'run', 'sendBack'])
    expect([...inspectorActions(task('1', { status: 'in_progress' }), { hasAgent: true, headlessRun: true })].sort()).toEqual(['stop', 'takeover'])
    expect([...inspectorActions(task('1', { status: 'blocked', blockReason: 'agent' }), { hasAgent: false, headlessRun: false })]).toEqual(['unpark'])
    expect(inspectorActions(task('1', { status: 'blocked', blockReason: 'deps' }), { hasAgent: true, headlessRun: false }).size).toBe(0)
    const asked = task('1', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'question', question: 'Which?', options: [], askedAt: '2026-10-20T08:00:00.000Z', answer: null, answeredAt: null } as unknown as CompanyTask['ask'] })
    expect([...inspectorActions(asked, { hasAgent: true, headlessRun: false })]).toEqual(['unpark'])
  })
  it('offers only the status moves main allows from the task’s status', () => {
    expect(statusChoices({ status: 'blocked' })).toEqual(['blocked:manual', 'todo', 'canceled'])
    expect(statusChoices({ status: 'done' })).not.toContain('blocked:manual')
    expect(statusChoices({ status: 'canceled' })).not.toContain('blocked:manual')
    expect(statusChoices({ status: 'todo' })).toEqual(['triage', 'backlog', 'todo', 'blocked:manual', 'canceled'])
    for (const s of TASK_STATUSES) {
      expect(statusChoices({ status: s })).not.toContain('in_progress')
      expect(statusChoices({ status: s })).not.toContain('done')
    }
  })
  it('disables Approve without a note', () => {
    expect(canApprove({ status: 'in_review' }, '')).toBe(false)
    expect(canApprove({ status: 'in_review' }, '   ')).toBe(false)
    expect(canApprove({ status: 'in_review' }, 'Shipped in v2')).toBe(true)
    expect(canApprove({ status: 'todo' }, 'note')).toBe(false)
  })
})

describe('Needs you and Overnight', () => {
  it('lists asks first, then reviews, parked and unassigned, per company', () => {
    const tasks = [task('r', { status: 'in_review' }), task('q', { status: 'blocked', blockReason: 'needs_input' }), task('p', { status: 'blocked', blockReason: 'run_failed' }), task('u', { departmentId: 'dep_m' }), task('x', { companyId: 'co_b', status: 'in_review' }), task('w', { status: 'in_progress' })]
    expect(needsYouTasks(tasks, ctx, 'co_a').map((i) => [i.task.id, i.group])).toEqual([['q', 'ask'], ['r', 'review'], ['p', 'parked'], ['u', 'unassigned']])
    expect(needsYouTasks(tasks, ctx)).toHaveLength(5)
  })
  it('skips a task waiting on a live ask where the live ask rows are listed too', () => {
    const tasks = [task('a', { status: 'in_progress', runId: 'run_asking' }), task('r', { status: 'in_review' })]
    expect(needsYouTasks(tasks, ctx).map((i) => i.task.id)).toEqual(['a', 'r'])
    expect(needsYouTasks(tasks, ctx, undefined, { skipLiveAsks: true }).map((i) => i.task.id)).toEqual(['r'])
  })
  it('lists changes since last seen, grouped by department', () => {
    const since = '2026-10-20T00:00:00.000Z'
    const tasks = [
      task('1', { status: 'done', departmentId: 'dep_m', updatedAt: '2026-10-20T03:00:00Z' }),
      task('2', { status: 'in_review', agentId: 'agt_copy', updatedAt: '2026-10-20T04:00:00Z' }),
      task('3', { status: 'blocked', blockReason: 'no_report', updatedAt: '2026-10-20T05:00:00Z' }),
      task('4', { status: 'done', departmentId: 'dep_m', updatedAt: '2026-10-19T23:00:00Z' }),
      task('5', { status: 'blocked', blockReason: 'deps', updatedAt: '2026-10-20T05:00:00Z' }),
      task('6', { status: 'done', companyId: 'co_b', updatedAt: '2026-10-20T05:00:00Z' })
    ]
    const groups = overnight(tasks, 'co_a', since, [dep('dep_d', 'Development', 0), dep('dep_m', 'Marketing', 1)], ctx)
    expect(groups.map((g) => [g.name, g.items.map((i) => `${i.task.id}:${i.kind}`)])).toEqual([['Marketing', ['2:review', '1:done']], ['No department', ['3:parked']]])
  })
})

describe('Autopilot switch', () => {
  it('round-trips through board:autopilot and shows what main stored', async () => {
    const calls: { companyId: string; on: boolean }[] = []
    const views: { pending: boolean | null; busy: boolean }[] = []
    let stored = false
    const toggle = autopilotToggle(async (q) => { calls.push(q); stored = q.on; return { companyId: q.companyId, autopilot: stored, maxInFlight: 3 } }, 'co_a', (v) => views.push(v))
    expect(await toggle.flip(true)).toEqual({ companyId: 'co_a', autopilot: true, maxInFlight: 3 })
    expect(calls).toEqual([{ companyId: 'co_a', on: true }])
    expect(views).toEqual([{ pending: true, busy: true }, { pending: true, busy: false }])
    await toggle.flip(false)
    expect(stored).toBe(false)
    expect(views.at(-1)).toEqual({ pending: false, busy: false })
  })
  it('sends one request at a time, shows main’s answer over the click, and reverts on error', async () => {
    let release: (v: { companyId: string; autopilot: boolean; maxInFlight: number }) => void = () => {}
    const views: { pending: boolean | null; busy: boolean }[] = []
    let n = 0
    const toggle = autopilotToggle(() => { n++; return new Promise((r) => { release = r }) }, 'co_a', (v) => views.push(v))
    const first = toggle.flip(true)
    expect(await toggle.flip(false)).toBeNull()
    expect(n).toBe(1)
    // main refused to turn it on (e.g. the flag went off): the switch follows main, not the click
    release({ companyId: 'co_a', autopilot: false, maxInFlight: 3 })
    await first
    expect(views.at(-1)).toEqual({ pending: false, busy: false })
    const failing = autopilotToggle(() => Promise.reject(new Error('departments are off')), 'co_a', (v) => views.push(v))
    await expect(failing.flip(true)).rejects.toThrow('departments are off')
    expect(views.at(-1)).toEqual({ pending: null, busy: false })
  })
})

describe('live hub task labels', () => {
  it('finds a run’s task and labels it PRN-42 · Marketing/Copywriter', () => {
    const t = task('42', { runId: 'run_1', agentId: 'agt_copy' })
    expect(taskForRun([t], { runId: 'run_1' })).toBe(t)
    expect(taskForRun([t], { runId: 'run_old', taskId: '42' })).toBe(t)
    expect(taskForRun([t], { runId: 'run_other' })).toBeUndefined()
    expect(taskRunLabel(t, [dep('dep_m', 'Marketing')], [copy])).toBe('PRN-42 · Marketing/Copywriter')
    expect(taskRunLabel(task('7'), [], [])).toBe('PRN-7')
  })
  it('learns runs.task_id from run:updated without letting a payload with no taskId erase it', () => {
    const cache = new Map<string, string | null>([['run_old', '42'], ['run_plain', null]])
    // the engine emits the in-memory Run (no taskId): the link runs:get answered stays
    expect(learnRunTask(cache, { id: 'run_old' })).toBe(false)
    expect(learnRunTask(cache, { id: 'run_old', taskId: null })).toBe(false)
    expect(cache.get('run_old')).toBe('42')
    // an event before the lookup does not mark the run as "not a task run", so runs:get still asks
    expect(learnRunTask(cache, { id: 'run_new' })).toBe(false)
    expect(cache.has('run_new')).toBe(false)
    expect(learnRunTask(cache, { id: 'run_new', taskId: '43' })).toBe(true)
    expect(learnRunTask(cache, { id: 'run_new', taskId: '43' })).toBe(false)
    expect(cache.get('run_new')).toBe('43')
  })
})

describe('board company switch', () => {
  it('drops a department filter of another company, keeps one of the new company and any in All mode', () => {
    const deps = [dep('dep_m', 'Marketing'), dep('dep_s', 'Sales', 0, 'co_b')]
    expect(keptDepartmentFilter('dep_m', 'co_b', deps)).toBeNull()
    expect(keptDepartmentFilter('dep_s', 'co_b', deps)).toBe('dep_s')
    expect(keptDepartmentFilter('dep_m', undefined, deps)).toBe('dep_m')
    expect(keptDepartmentFilter(null, 'co_a', deps)).toBeNull()
    expect(keptDepartmentFilter('dep_gone', 'co_a', deps)).toBeNull()
  })
})

describe('company board counts', () => {
  it('counts working, need you and done today through laneOf', () => {
    const now = new Date('2026-10-20T15:00:00')
    const today = new Date(new Date(startOfDay(now)).getTime() + 3600e3).toISOString()
    const counts = taskCounts([
      task('1', { status: 'in_progress' }), task('2', { status: 'in_progress', runId: 'run_asking' }), task('3', { status: 'in_review' }),
      task('4', { status: 'done', updatedAt: today }), task('5', { status: 'done', updatedAt: '2026-10-01T00:00:00Z' }), task('6', { companyId: 'co_b', status: 'blocked', blockReason: 'deps' })
    ], ctx, now)
    // liveAsks: the asking run's task, so Portfolio counts it once (the live ask row already lists it)
    expect(counts.co_a).toEqual({ working: 1, needsYou: 2, doneToday: 1, liveAsks: 1 })
    expect(counts.co_b).toEqual({ working: 0, needsYou: 0, doneToday: 0 })
    expect(taskCountsLine(counts.co_a)).toBe('1 working · 2 need you · 1 done today')
    expect(taskCountsLine({ working: 0, needsYou: 1, doneToday: 0 })).toBe('0 working · 1 needs you · 0 done today')
    expect(taskCountsLine(counts.co_b)).toBeNull()
  })
})
