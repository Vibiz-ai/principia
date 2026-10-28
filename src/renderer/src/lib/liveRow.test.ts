import { describe, expect, it } from 'vitest'
import { liveRowView, liveTaskKey, liveTaskOf, rowKeyOfLive, taskOfChatKey, workingTasksOf, type LiveTask } from './liveRow'
import type { LiveItem } from './companyModel'
import { liveTruth } from './liveTruth'
import type { AgentNode } from '@shared/live'

const task = (id: string, over: Partial<LiveTask> = {}): LiveTask => ({ id, companyId: 'co', identifier: id.toUpperCase(), title: `Task ${id}`, status: 'in_progress', runId: `run-${id}`, agentId: 'julia', updatedAt: '2026-10-28T10:00:00Z', ...over })
const item = (over: Partial<LiveItem> = {}): LiveItem => ({ key: 'work:a', companyId: 'co', kind: 'working', agentId: 'a', askId: null, title: 'run title', detail: 'Running a SQL query in PostHog', sessionId: null, runId: 'run-vo-15', at: '2026-10-28T10:00:00Z', ...over })
const seats = [{ id: 'julia', companyId: 'co' }]
const nameOf = (): string => 'Julia'

describe('liveRowView: a live row names what is running and opens it', () => {
  const tasks = [task('vo-15', { title: 'Check why maria@example.com’s workspace has posts she didn’t schedule' })]
  it('a task run reads as its agent and its task, with the activity under it', () => {
    const v = liveRowView(item(), { tasks, seats, nameOf, code: true })
    expect(v).toEqual({ name: 'Julia', task: 'VO-15 Check why maria@example.com’s workspace has posts she didn’t schedule', activity: 'Running a SQL query in PostHog', taskId: 'vo-15', companyId: 'co', seatId: 'julia' })
  })
  it('a company with no code never sees the task code (C7)', () => {
    expect(liveRowView(item(), { tasks, seats, nameOf, code: false }).task).toBe('Check why maria@example.com’s workspace has posts she didn’t schedule')
  })
  it('an item that carries its taskId finds the task even before the run is linked', () => {
    const v = liveRowView(item({ runId: null, taskId: 'vo-15', detail: 'Starting' }), { tasks, seats, nameOf, code: true })
    expect(v.taskId).toBe('vo-15')
    expect(v.activity).toBe('Starting')
  })
  it('work that is no task keeps its own title and opens the old way', () => {
    const v = liveRowView(item({ runId: 'other', title: 'VO-3 · Nightly report' }), { tasks, seats, nameOf, code: false })
    expect(v).toMatchObject({ name: 'Nightly report', task: null, taskId: null, seatId: null })
  })
  it('a task with no seat is named by the task', () => {
    const v = liveRowView(item(), { tasks: [task('vo-15', { agentId: null })], seats, nameOf, code: true })
    expect(v).toMatchObject({ name: 'VO-15 Task vo-15', task: null, taskId: 'vo-15' })
  })
})

describe('one row per running task', () => {
  it('an agent on two tasks at once is two live rows, each opening its own task', () => {
    const tasks = [task('vo-15'), task('vo-16')]
    const agent = (id: string, runId: string): AgentNode => ({ id, rootId: id, parentId: null, kind: 'step', runId, stepId: 's', sessionId: null, title: id, status: 'working', needs: null, activity: 'posthog.exec call execute-sql {"query":"SELECT 1"}', startedAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:01:00Z' }) as unknown as AgentNode
    const truth = liveTruth({ agents: [agent('a1', 'run-vo-15'), agent('a2', 'run-vo-16')], asks: [], seen: new Set(), sessions: [], tasks })
    const rows = truth.working.map((i) => liveRowView(i, { tasks, seats, nameOf, code: true }))
    expect(rows.map((r) => r.taskId).sort()).toEqual(['vo-15', 'vo-16'])
    expect(rows.every((r) => r.name === 'Julia' && r.activity === 'Running a SQL query in PostHog')).toBe(true)
  })
  it('workingTasksOf lists every task the agent runs now, and nothing else', () => {
    const tasks = [task('a'), task('b', { updatedAt: '2026-10-28T09:00:00Z' }), task('c', { status: 'todo', runId: null }), task('d', { agentId: 'marcus' })]
    expect(workingTasksOf('julia', 'co', tasks).map((t) => t.id)).toEqual(['b', 'a'])
  })
})

describe('the live view key', () => {
  it('round-trips and maps back to the agent row', () => {
    expect(taskOfChatKey(liveTaskKey('vo-15'))).toBe('vo-15')
    expect(taskOfChatKey('agent:julia')).toBeNull()
    expect(taskOfChatKey(undefined)).toBeNull()
    expect(rowKeyOfLive('task:vo-15', [task('vo-15')])).toBe('agent:julia')
    expect(rowKeyOfLive('task:gone', [task('vo-15')])).toBeNull()
  })
  it('liveTaskOf prefers the item’s own task, else the run’s', () => {
    const tasks = [task('x'), task('y')]
    expect(liveTaskOf({ taskId: 'y', runId: 'run-x', sessionId: null }, tasks)?.id).toBe('y')
    expect(liveTaskOf({ runId: null, sessionId: 'run-x' }, tasks)?.id).toBe('x')
    expect(liveTaskOf({ runId: 'nope', sessionId: null }, tasks)).toBeUndefined()
  })
})
