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
import type { ForumTaskCard, StripTask } from '@shared/taskCard'
import type { ForumMessage } from '@shared/forum'

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

describe('the dock above the composer (CHAT-UI.md §8.5)', () => {
  const st = (id: string, state: StripTask['state']): StripTask => ({ taskId: id, identifier: id.toUpperCase(), who: 'Julia', state, startedAt: T })
  const cards = [card('vo-14'), card('vo-15'), card('vo-16', { state: 'done' }), card('vo-17', { state: 'needs_you', askMessageId: 'msg_q' })]
  it('docks the queued, working and needs-you tasks, not the one that came back', async () => {
    const { TaskDock } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskDock, { items: [st('vo-14', 'queued'), st('vo-15', 'working'), st('vo-16', 'done'), st('vo-17', 'needs_you')], cards, companyId: 'co_a', channelId: 'ch_1' }))
    expect(html).toContain('data-chatux="task-dock"')
    expect(html).toContain('data-dock-task="VO-14"')
    expect(html).toContain('data-dock-task="VO-15"')
    expect(html).toContain('data-dock-task="VO-17"')
    expect(html).not.toContain('data-dock-task="VO-16"')
    expect(html).not.toContain('task-dock-more')
    // nothing open: no dock at all
    expect(renderToStaticMarkup(createElement(TaskDock, { items: [st('vo-16', 'done')], cards, companyId: 'co_a', channelId: 'ch_1' }))).toBe('')
  })
  it('more than three: the newest three and "+N more"', async () => {
    const { TaskDock } = await import('./TaskCard')
    const many = ['vo-14', 'vo-15', 'vo-17', 'vo-18', 'vo-19'].map((id) => card(id))
    const html = renderToStaticMarkup(createElement(TaskDock, { items: many.map((c) => st(c.taskId, 'queued')), cards: many, companyId: 'co_a', channelId: 'ch_1' }))
    expect(html.match(/data-chatux="task-dock-card"/g)).toHaveLength(3)
    expect(html).toContain('+2 more')
  })
  it('the docked working card is compact: state and clock on one line, two tail lines, Show logs, Watch, Open task', async () => {
    const { TaskCardView } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-15'), dock: true }))
    expect(html).toContain('data-chatux="task-dock-card"')
    expect(html).toContain('data-state="working"')
    expect(html).toMatch(/data-chatux="task-clock">1m 1\d+s</)
    expect(html).toContain('data-chatux="task-tail"')
    expect(html).toContain('Show logs')
    expect(html).toMatch(/data-chatux="task-watch"[^>]*>Watch</)
    expect(html).toContain('Open task')
    expect(html).not.toContain('data-chatux="task-log"')
  })
  it('the docked needs-you card keeps Answer pointing at the question', async () => {
    const { TaskCardView } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCardView, { card: card('vo-17', { state: 'needs_you', askMessageId: 'msg_q' }), channelId: 'ch_1', dock: true }))
    expect(html).toContain('data-chatux="task-answer"')
    expect(html).toContain('title="Answer in the conversation"')
  })
  it('the history card becomes a one-line reference while docked, the full card once it came back', async () => {
    const { MessageBubble } = await import('./ConversationKit')
    const sys = (c: ForumTaskCard): ForumMessage => ({ id: `m_${c.taskId}`, companyId: 'co_a', channelId: 'ch_1', authorId: 'mem_p', kind: 'system', text: `Julia started ${c.identifier}`, mentions: [], createdAt: T, origin: 'local', task: c }) as unknown as ForumMessage
    const display = (() => ({ name: 'Julia', role: 'Analyst', kind: 'agent' })) as never
    const ref = renderToStaticMarkup(createElement(MessageBubble, { m: sys(card('vo-15')), mine: false, head: true, display, docked: 'working' }))
    expect(ref).toContain('data-chatux="task-card-ref"')
    expect(ref).toContain('VO-15 · working · see below')
    expect(ref).not.toContain('data-chatux="task-card"')
    const full = renderToStaticMarkup(createElement(MessageBubble, { m: sys(card('vo-16', { state: 'done' })), mine: false, head: true, display, docked: null }))
    expect(full).toContain('data-chatux="task-card"')
    expect(full).toContain('Rewrote the hero')
  })
  it('a task question with options: quick-answer buttons under it, no "Options:" line in the bubble', async () => {
    const { MessageBubble } = await import('./ConversationKit')
    const opts = ['Cancel both', 'Cancel only Oct 28', "Leave them, I'll ask her first"]
    const q = (status: 'open' | 'answered', answer?: string): ForumMessage =>
      ({ id: 'msg_q', companyId: 'co_a', channelId: 'ch_1', authorId: 'mem_julia', kind: 'ask', text: "VO-17 is stuck and needs you.\nShould I cancel them?\nOptions: Cancel both, Cancel only Oct 28 or Leave them, I'll ask her first.\nReply here and I'll pass it on to VO-17.", mentions: [], createdAt: T, origin: 'principia:ask:run_n', ask: { status, to: ['mem_p'], taskId: 'vo-17', runId: 'run_n', options: opts, ...(answer ? { answer } : {}) } }) as unknown as ForumMessage
    const display = (() => ({ name: 'Julia', role: 'Analyst', kind: 'agent' })) as never
    const open = renderToStaticMarkup(createElement(MessageBubble, { m: q('open'), mine: false, head: true, display, onReply: () => {} }))
    expect(open.match(/data-chatux="task-question-option"/g)).toHaveLength(3)
    expect(open).toMatch(/Cancel only Oct 28<\/span><\/button>/)
    expect(open).not.toContain('Options:')
    expect(open).toContain('Should I cancel them?')
    expect(open).toContain('data-chatux="task-question-reply"')
    // answered: the options stay as a record, the picked one marked, no buttons
    const done = renderToStaticMarkup(createElement(MessageBubble, { m: q('answered', 'Cancel both'), mine: false, head: true, display }))
    expect(done).not.toContain('data-chatux="task-question-option"')
    expect(done).toMatch(/cx-question__opt is-picked"[^>]*>Cancel both</)
  })
  it('a question from the agent who just said "Got it" starts its own message', async () => {
    const { startsGroup } = await import('./ConversationKit')
    const msgs = [
      { authorId: 'mem_p', kind: 'message' },
      { authorId: 'mem_julia', kind: 'message' },
      { authorId: 'mem_julia', kind: 'message' },
      { authorId: 'mem_julia', kind: 'ask', ask: { status: 'open', to: [], taskId: 'vo-17' } }
    ] as unknown as ForumMessage[]
    expect([0, 1, 2, 3].map((i) => startsGroup(msgs, i))).toEqual([true, true, false, true])
  })
  it('the strip of a conversation with a dock points at the docked card', async () => {
    const { WorkingStrip } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(WorkingStrip, { cards: [card('vo-15')], dock: true }))
    expect(html).toMatch(/class="cx-strip__line shimmer-text is-link"[^>]*title="Show it above the reply box"/)
    expect(html).not.toMatch(/disabled=""[^>]*data-chatux="working-strip-line"/)
  })
})
