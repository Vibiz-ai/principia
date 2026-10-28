/**
 * CHAT-UI.md §8: the live task card in a chat. Queued says why it waits and offers Run now; working shows
 * "Working · <clock>", the live tail and Show logs; a finished card keeps its log behind the toggle; the strip says
 * who is working on what.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, CompanyTask } from '@shared/company'
import type { AgentNode } from '@shared/live'
import type { ForumTaskCard } from '@shared/taskCard'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 3 * 60_000).toISOString()
const RUN_START = new Date(Date.now() - 72_000).toISOString()
const co = { id: 'co_a', name: 'Vibiz', slug: 'vibiz', color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, autopilot: false, createdAt: '', updatedAt: '' } as unknown as CompanyPassport
const julia = { id: 'agt_julia', companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p_claude', name: 'Julia', archivedAt: null, pausedAt: null, createdAt: T, updatedAt: T, data: { autonomy: 'auto', instructions: '', capabilities: '', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 2 } } } as unknown as CompanyAgent
const task = (id: string, x: Partial<CompanyTask>): CompanyTask => ({ id, identifier: id.toUpperCase(), companyId: 'co_a', title: `Task ${id}`, description: '', status: 'todo', priority: 0, source: 'manual', sourceUrl: null, externalId: null, repoId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: null, agentId: 'agt_julia', blockReason: null, ask: null, report: null, doneNote: null, routing: null, pendingWake: null, handoffs: 0, runId: null, createdAt: T, updatedAt: T, ...x }) as unknown as CompanyTask
const root = { id: 'n_run', kind: 'step', parentId: null, rootId: 'n_run', sessionId: null, runId: 'run_w', stepId: 'st_1', provider: 'claude', repoId: null, cwd: '/', title: 'VO-15', status: 'working', activity: 'Read src/x.ts', startedAt: RUN_START, updatedAt: RUN_START, endedAt: null } as unknown as AgentNode
const card = (taskId: string, x: Partial<ForumTaskCard> = {}): ForumTaskCard => ({ taskId, identifier: taskId.toUpperCase(), title: `Task ${taskId}`, agentId: 'agt_julia', filedBy: null, state: 'queued', runId: null, startedAt: T, ...x })

beforeAll(async () => {
  const store = await import('../../state/store')
  store.setState({
    ready: true,
    settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never,
    companies: [co],
    companiesLoaded: true,
    companyAgents: [julia],
    tasks: [task('vo-14', { status: 'todo' }), task('vo-15', { status: 'in_progress', runId: 'run_w' }), task('vo-16', { status: 'done', runId: 'run_d', report: { outcome: 'review', summary: 'Rewrote the hero', evidence: [], at: T } } as Partial<CompanyTask>), task('vo-17', { status: 'blocked', blockReason: 'needs_input', runId: 'run_n', ask: { kind: 'question', prompt: "Needs access: Can't read production rows (social_post) to see who created those posts" } } as Partial<CompanyTask>)],
    agents: { n_run: root, n_done: { ...root, id: 'n_done', rootId: 'n_done', runId: 'run_d', status: 'done' } as AgentNode }
  })
})

describe('the task card in a chat', () => {
  it('queued: why it waits, and Run now on the card', async () => {
    const { TaskCardView } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-14') }))
    expect(html).toContain('data-state="queued"')
    expect(html).toContain('Autopilot is off in Vibiz: it waits for you to press Start')
    expect(html).toContain('data-chatux="task-run"')
    expect(html).toContain('Open task')
    // nothing to log before a run exists
    expect(html).not.toContain('data-chatux="task-logs"')
  })
  it('working: "Working · 1m 12s", the live tail, Show logs (collapsed), Watch and Open task as links', async () => {
    const { TaskCardView } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-15') }))
    expect(html).toContain('data-state="working"')
    expect(html).toMatch(/data-chatux="task-activity">Working</)
    expect(html).toMatch(/data-chatux="task-clock">1m 1[12]s</)
    expect(html).toContain('data-chatux="task-tail"')
    expect(html).toContain('Show logs')
    expect(html).not.toContain('data-chatux="task-log"')
    expect(html).not.toContain('data-chatux="task-run"')
    expect(html).toMatch(/data-chatux="task-watch"[^>]*>Watch</)
  })
  it('done: the outcome line, the log still behind the toggle', async () => {
    const { TaskCardView } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-16') }))
    expect(html).toContain('data-state="done"')
    expect(html).toContain('Rewrote the hero')
    expect(html).toContain('Show logs')
    expect(html).not.toContain('data-chatux="task-tail"')
  })
  it('the strip says who is working, with the run clock', async () => {
    const { WorkingStrip } = await import('./TaskCard')
    const one = renderToStaticMarkup(createElement(WorkingStrip, { cards: [card('vo-15')] }))
    // the seat's display (persona) name, the run's clock (1m 12s in), not the 3m since it was filed
    expect(one).toMatch(/>\w+ is working on VO-15 · 1m</)
    const two = renderToStaticMarkup(createElement(WorkingStrip, { cards: [card('vo-15'), card('vo-14')] }))
    expect(two).toContain('2 tasks · 1 working · 1 queued')
  })
  it('needs you: a compact card, no answer box; Answer points at the question in the conversation', async () => {
    const { TaskCardView } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-17', { state: 'needs_you', askMessageId: 'msg_q' }), channelId: 'ch_1' }))
    expect(html).toContain('data-state="needs_you"')
    expect(html).toContain("Needs access: Can&#x27;t read production rows")
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
    expect(html).toContain('data-chatux="task-answer"')
    expect(html).toContain('title="Answer in the conversation"')
    // a chat session's card has no question message: Answer opens the task instead
    const bare = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-17', { state: 'needs_you' }) }))
    expect(bare).toContain('title="Answer on the board"')
  })
  it('the strip’s "needs you" line goes to the question', async () => {
    const { WorkingStrip } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(WorkingStrip, { cards: [card('vo-17', { state: 'needs_you', askMessageId: 'msg_q' })] }))
    expect(html).toMatch(/VO-17 needs you · \w+ is waiting/)
    expect(html).toMatch(/class="cx-strip__line\s+is-link"[^>]*title="Go to the question"/)
    expect(html).not.toMatch(/data-chatux="working-strip-line"[^>]*disabled/)
    const plain = renderToStaticMarkup(createElement(WorkingStrip, { cards: [card('vo-15')] }))
    expect(plain).toMatch(/disabled=""[^>]*data-chatux="working-strip-line"/)
  })
})
