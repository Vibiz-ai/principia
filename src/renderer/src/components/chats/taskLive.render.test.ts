/**
 * CHAT-UI.md §8.4: a task is a chat. The header names who and what with the run clock, Pause, Open task and From: its
 * conversation; the body is a thread (the brief first, bubbles, tool calls folded into words, never the raw call);
 * the composer adds a note that reaches the running agent (tasks:comment, by you), or answers its open question.
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
const calls: { channel: string; req: unknown }[] = []
const tasksApi = {
  comment: async (req: { id: string; message: string; by?: string }) => (calls.push({ channel: 'tasks:comment', req }), { id: 'act_1', taskId: req.id, kind: 'comment', message: req.message, createdAt: new Date().toISOString(), by: req.by ?? 'human' }),
  answer: async (req: unknown) => (calls.push({ channel: 'tasks:answer', req }), {}),
  get: async () => ({ task: null, activity: [] })
}
vi.stubGlobal('window', { hive: { on: () => () => {}, tasks: tasksApi }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 10 * 60_000).toISOString()
const RUN_START = new Date(Date.now() - 4 * 60_000 - 12_000).toISOString()
const co = { id: 'co_a', name: 'Vibiz', slug: 'vibiz', color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, autopilot: false, createdAt: '', updatedAt: '' } as unknown as CompanyPassport
const julia = { id: 'agt_julia', companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p_claude', name: 'Julia', archivedAt: null, pausedAt: null, createdAt: T, updatedAt: T, data: { autonomy: 'auto', instructions: '', capabilities: '', mode: 'headless', defaultRepoId: null, limits: { autoWakesPerHour: 2 } } } as unknown as CompanyAgent
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

describe('a task is a chat', () => {
  it('working: who and what, the run clock, Pause, Open task, From: its conversation, the brief, the activity in words, the composer', async () => {
    const { resetForum } = await import('../../state/forum')
    resetForum({ byCompany: { co_a: { state: { companyId: 'co_a', me: 'm_me', members: [], presence: [], openAsks: 0, openProposals: 0, taskChannels: { 'vo-15': 'ch_launch' }, channels: [{ id: 'ch_launch', companyId: 'co_a', kind: 'private', name: 'chat-launch-x1', topic: 'Spring launch', purpose: '', departmentId: null, system: null, createdBy: null, createdAt: T, archivedAt: null, memberIds: [], lastSeq: 1, lastMessageAt: T, joined: true, lastReadSeq: 1, unread: 0, mentions: 0 }] } as never, error: null, pages: {}, threads: {} } } })
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-15' }))
    expect(html).toContain('data-chatux="task-live"')
    expect(html).toContain('data-state="working"')
    expect(html).not.toContain('convo-title__role')
    expect(html).toMatch(/data-chatux="task-clock">4m 1[23]s</)
    expect(html).toContain('>Pause<')
    expect(html).toContain('>Open task<')
    expect(html).toMatch(/data-chatux="task-chat-from"[^>]*>From: Spring launch</)
    // the thread starts with the brief, and says what it does now in words
    expect(html).toMatch(/chat-user__text">[^<]*Check why maria@example.com/)
    expect(html).toMatch(/data-chatux="task-live-activity"[^>]*>.*Running a SQL query in PostHog/)
    expect(html).not.toContain('execute-sql')
    // the full log is one click away, not the pane
    expect(html).toContain('data-chatux="task-chat-fulllog"')
    expect(html).not.toContain('cx-task__log--fill')
    // the composer
    expect(html).toMatch(/placeholder="Add a note for [^"]+…"/)
    expect(html).toMatch(/data-chatux="task-chat-hint">→ [^<]+ gets it as soon as this turn ends/)
    resetForum()
  })
  it('came back: no Pause, the outcome line, the full log kept', async () => {
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-9' }))
    expect(html).toContain('data-state="in_review"')
    expect(html).toMatch(/data-chatux="task-chat-outcome".*In review · Found the duplicate scheduler/)
    expect(html).not.toContain('>Pause<')
    expect(html).not.toContain('task-chat-from')
    expect(html).toContain('data-chatux="task-chat-fulllog"')
  })
  it('a task that is gone says so', async () => {
    const { TaskLiveView } = await import('./TaskLiveView')
    expect(renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'nope' }))).toContain('not on the board any more')
  })
  it('an open question: the agent asks in the thread with quick answers, and Send answers it', async () => {
    const store = await import('../../state/store')
    const before = store.getState().tasks
    store.setState({ tasks: [...before, task('vo-21', { status: 'blocked', blockReason: 'needs_input', runId: 'run_q', ask: { kind: 'choice', prompt: 'Refund or replacement?', options: ['Refund', 'Replacement'] } } as Partial<CompanyTask>)] })
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-21' }))
    expect(html).toMatch(/data-chatux="task-chat-question".*Refund or replacement\?/)
    expect(html).toContain('>Replacement<')
    expect(html).toMatch(/placeholder="Answer [^"]+…"/)
    expect(html).toMatch(/→ Answers [^<]+ question, and the task goes on/)
    store.setState({ tasks: before })
  })
  it('tool calls read as words in the same rows as a chat; the raw call never shows until a step is opened', async () => {
    const { taskChatItems } = await import('../../lib/taskThread')
    const { buildBlocks } = await import('@shared/chatView')
    const { Blocks } = await import('../chat/ChatCards')
    const ev = (seq: number, name: string, summary: string, description?: string) => ({ seq, agentId: 'n_run', ts: T, kind: 'tool' as const, toolUseId: `t${seq}`, name, summary, detail: null, state: 'ok' as const, description })
    const thread = [
      { kind: 'brief' as const, key: 'b', at: T, text: 'Check the campaign' },
      { kind: 'say' as const, key: 's', at: T, by: 'agent' as const, text: 'Looking now' },
      { kind: 'tools' as const, key: 'ev:1', at: T, events: [ev(1, 'Bash', 'node scripts/check.js', 'Run the unit tests')], label: 'Run the unit tests', running: false },
      { kind: 'note' as const, key: 'n', at: T, text: 'Julia started' }
    ]
    const items = taskChatItems(thread)
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'tool', 'notice'])
    const html = renderToStaticMarkup(createElement(Blocks, { blocks: buildBlocks(items), live: false, actions: null }))
    expect(html).toContain('chat-user')
    expect(html).toContain('chat-text')
    expect(html).toContain('Run the unit tests')
  })
})

describe('PR-100: a task tracked by a chat shows that chat, never "Starting…"', () => {
  // LOL-5: task_create from the chat "Use App Store regional price tiers"; its run id is the chat's session, no run exists
  const chatTask = task('lol-5', { status: 'in_progress', runId: 's_chat1', source: 'agent', externalId: 'track:s_chat1:t1', agentId: null, title: 'Use App Store regional price tiers' } as Partial<CompanyTask>)
  const chatRoot = { ...root, id: 'n_chat', rootId: 'n_chat', kind: 'session', sessionId: 's_chat1', runId: null, stepId: null, title: 'Chat', activity: 'Writing a file', status: 'working' } as unknown as AgentNode
  const render = async (): Promise<string> => {
    const { TaskLiveView } = await import('./TaskLiveView')
    return renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'lol-5' }))
  }
  it("the chat working: its live activity and a link to it, no spinner that waits for a run, no Pause", async () => {
    const store = await import('../../state/store')
    const before = store.getState()
    store.setState({ tasks: [...before.tasks, chatTask], sessions: [{ id: 's_chat1', title: 'Use App Store regional price tiers', status: 'running', repoId: null, companyId: 'co_a' }] as never, agents: { ...before.agents, n_chat: chatRoot } })
    const html = await render()
    expect(html).toContain('data-state="working"')
    expect(html).toMatch(/data-chatux="task-in-chat"[^>]*>Being worked on in chat <button[^>]*data-chatux="task-open-chat"[^>]*>Use App Store regional price tiers</)
    expect(html).toMatch(/data-chatux="task-live-activity"/)
    expect(html).not.toContain('Starting…')
    expect(html).not.toContain('is starting on it')
    expect(html).not.toContain('>Pause<')
    store.setState({ tasks: before.tasks, sessions: before.sessions, agents: before.agents })
  })
  it('the chat not loaded yet: still the link, never "Starting…"', async () => {
    const store = await import('../../state/store')
    const before = store.getState()
    store.setState({ tasks: [...before.tasks, chatTask] })
    const html = await render()
    expect(html).toContain('data-chatux="task-in-chat"')
    expect(html).toContain('data-chatux="task-open-chat"')
    expect(html).not.toContain('Starting…')
    expect(html).not.toContain('is starting on it')
    store.setState({ tasks: before.tasks })
  })
})

describe('the note reaches the agent', () => {
  it('Send posts a task comment by you (the wake path teammates use), or answers the open question', async () => {
    const { sendTaskNote } = await import('./TaskLiveView')
    calls.length = 0
    const a = await sendTaskNote('vo-15', '  Use the blue logo  ', false)
    expect(calls).toEqual([{ channel: 'tasks:comment', req: { id: 'vo-15', message: 'Use the blue logo', by: 'human' } }])
    // the thread shows it at once
    expect(a).toMatchObject({ kind: 'comment', by: 'human', message: 'Use the blue logo' })
    const b = await sendTaskNote('vo-21', 'Replacement', true)
    expect(calls[1]).toEqual({ channel: 'tasks:answer', req: { id: 'vo-21', answer: 'Replacement' } })
    expect(b).toMatchObject({ kind: 'answered', by: 'human', message: 'Replacement' })
  })
})

describe('PR-102: no endless loader', () => {
  it('a run whose agent never showed up stops spinning and says it did not start', async () => {
    const store = await import('../../state/store')
    const old = store.getState().tasks
    store.setState({ tasks: [...old, task('vo-30', { status: 'in_progress', runId: 'run_ghost', updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() })] })
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-30' }))
    expect(html).toMatch(/data-chatux="task-live-activity" data-live="stuck"[^>]*>.*Didn&#x27;t start · no agent after 20m/)
    expect(html).toMatch(/data-chatux="task-live-label" data-live="stuck"[^>]*>Didn&#x27;t start</)
    expect(html).not.toContain('chat-spin')
    expect(html).not.toContain('is starting on it')
    store.setState({ tasks: old })
  })
  it('a silent agent reads as taking longer, then not responding', async () => {
    const store = await import('../../state/store')
    const agents = store.getState().agents
    store.setState({ agents: { ...agents, n_run: { ...root, stalledSince: new Date(Date.now() - 25 * 60_000).toISOString() } as AgentNode } })
    const { TaskLiveView } = await import('./TaskLiveView')
    const html = renderToStaticMarkup(createElement(TaskLiveView, { taskId: 'vo-15' }))
    expect(html).toMatch(/data-live="stuck"[^>]*>.*Not responding · quiet for 35m/)
    expect(html).not.toContain('chat-spin')
    store.setState({ agents })
  })
})
