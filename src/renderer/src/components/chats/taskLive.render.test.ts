/**
 * CHAT-UI.md §8.4: a task at work, watched in Chats. The header names who and what with the run clock, Pause and Open
 * task; the line under it is the activity in words (never the raw tool call); the run's log fills the pane. An
 * agent's resting chat carries "Julia is working on VO-15 now · Watch".
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, CompanyTask } from '@shared/company'
import type { AgentNode } from '@shared/live'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 10 * 60_000).toISOString()
const RUN_START = new Date(Date.now() - 4 * 60_000 - 12_000).toISOString()
const co = { id: 'co_a', name: 'Vibiz', slug: 'vibiz', color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, autopilot: false, createdAt: '', updatedAt: '' } as unknown as CompanyPassport
const julia = { id: 'agt_julia', companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p_claude', name: 'Julia', archivedAt: null, pausedAt: null, createdAt: T, updatedAt: T, data: { autonomy: 'auto', instructions: '', capabilities: '', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 2 } } } as unknown as CompanyAgent
const task = (id: string, x: Partial<CompanyTask>): CompanyTask => ({ id, identifier: id.toUpperCase(), companyId: 'co_a', title: `Task ${id}`, description: '', status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, repoId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: null, agentId: 'agt_julia', blockReason: null, ask: null, report: null, doneNote: null, routing: null, pendingWake: null, handoffs: 0, runId: null, createdAt: T, updatedAt: T, ...x }) as unknown as CompanyTask
const RAW = 'posthog.exec call execute-sql {"query": "SELECT distinct_id FROM events"}'
const root = { id: 'n_run', kind: 'step', parentId: null, rootId: 'n_run', sessionId: null, runId: 'run_w', stepId: 'st_1', provider: 'claude', repoId: null, cwd: '/', title: 'VO-15', status: 'working', activity: RAW, startedAt: RUN_START, updatedAt: RUN_START, endedAt: null } as unknown as AgentNode

beforeAll(async () => {
  const store = await import('../../state/store')
  store.setState({
    ready: true,
    settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never,
    companies: [co],
    companiesLoaded: true,
    companyAgents: [julia],
    repos: [{ id: 'r1', companyId: 'co_a', name: 'vibiz', path: '/x' }] as never,
    tasks: [task('vo-15', { status: 'in_progress', runId: 'run_w', title: 'Check why maria@example.com’s workspace has posts she didn’t schedule' }), task('vo-9', { status: 'in_review', runId: 'run_d', report: { outcome: 'review', summary: 'Found the duplicate scheduler', evidence: [], at: T } } as Partial<CompanyTask>)],
    agents: { n_run: root, n_done: { ...root, id: 'n_done', rootId: 'n_done', runId: 'run_d', status: 'done' } as AgentNode }
  })
})

describe('a task at work, watched in Chats', () => {
  it('working: who and what, the run clock, Pause and Open task, the activity in words, the log in the pane', async () => {
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-15' }))
    expect(html).toContain('data-chatux="task-live"')
    expect(html).toContain('data-state="working"')
    expect(html).toContain('VO-15 Check why maria@example.com’s workspace')
    expect(html).toMatch(/data-chatux="task-clock">4m 1[23]s</)
    expect(html).toContain('>Pause<')
    expect(html).toContain('>Open task<')
    expect(html).toMatch(/data-chatux="task-live-activity"[^>]*>.*Running a SQL query in PostHog/)
    expect(html).not.toContain('execute-sql')
    expect(html).toContain('data-chatux="task-log"')
    expect(html).toContain('cx-task__log--fill')
  })
  it('came back: no Pause, the result line, the log kept', async () => {
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-9' }))
    expect(html).toContain('data-state="in_review"')
    expect(html).toContain('Found the duplicate scheduler')
    expect(html).not.toContain('>Pause<')
    expect(html).toContain('data-chatux="task-log"')
  })
  it('a task that is gone says so', async () => {
    const { TaskLiveView } = await import('./TaskLiveView')
    expect(renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'nope' }))).toContain('not on the board any more')
  })
  it('the resting chat’s banner: "Julia is working on VO-15 now · Watch"', async () => {
    const { TaskLiveBanner } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveBanner, { agent: julia, name: 'Julia' }))
    expect(html).toContain('data-chatux="live-banner"')
    expect(html).toContain('Julia is working on VO-15 now')
    expect(html).toContain('>Watch<')
    const idle = { ...julia, id: 'agt_other' } as CompanyAgent
    expect(renderToStaticMarkup(createElement(TaskLiveBanner, { agent: idle, name: 'Marcus' }))).toBe('')
  })
})
