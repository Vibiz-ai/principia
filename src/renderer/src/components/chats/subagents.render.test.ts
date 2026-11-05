/**
 * CHAT-UI.md §8.6 render checks: a conversation with running tasks shows them on its row ("2 tasks working", "1 needs
 * you", "VO-16 finished · unread") in the sidebar's Recent, Chats and LIVE; LIVE lists that conversation, and a task no
 * conversation filed is its own row; an agent's resting chat is not live because its tasks run; Chats › Claude lists a
 * restarted chat once.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, CompanyTask } from '@shared/company'
import type { AgentNode } from '@shared/live'
import type { ForumChannel } from '@shared/forum'
import type { Session } from '@shared/types'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 5 * 60_000).toISOString()
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString()
const co = { id: 'co_a', name: 'Acme', slug: 'acme', color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, repoIds: [], autopilot: true, createdAt: '', updatedAt: '' } as unknown as CompanyPassport
const julia = { id: 'agt_julia', companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p_claude', name: 'Julia', archivedAt: null, pausedAt: null, createdAt: OLD, updatedAt: OLD, data: { autonomy: 'auto', instructions: '', capabilities: '', mode: 'headless', defaultRepoId: null, limits: { autoWakesPerHour: 2 } } } as unknown as CompanyAgent
const task = (id: string, x: Partial<CompanyTask>): CompanyTask => ({ id, identifier: id.toUpperCase(), companyId: 'co_a', title: `Task ${id}`, description: '', status: 'in_progress', priority: 0, source: 'manual', sourceUrl: null, externalId: null, repoId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: null, agentId: 'agt_julia', blockReason: null, ask: null, report: null, doneNote: null, routing: null, pendingWake: null, handoffs: 0, runId: `run_${id}`, createdAt: T, updatedAt: T, ...x }) as unknown as CompanyTask
const session = (id: string, p: Partial<Session> = {}): Session => ({ id, title: 'VO-15 · Check why maria’s posts went out', profileId: 'p_claude', adapter: 'claude', repoId: null, cwd: '/work/acme', status: 'exited', pid: null, cols: 80, rows: 24, exitCode: 0, startedAt: OLD, endedAt: OLD, artifactsDir: '', fromRunId: 'run_old', agentSessionId: 'conv-vo15', companyId: 'co_a', ...p }) as Session
const root = (id: string, runId: string, activity: string): AgentNode => ({ id, kind: 'step', parentId: null, rootId: id, sessionId: null, runId, stepId: `st_${id}`, provider: 'claude', repoId: null, cwd: '/', title: id, agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity, lastTool: null, toolCount: 1, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: T, updatedAt: T, endedAt: null }) as AgentNode
const channel = (id: string, topic: string, x: Partial<ForumChannel> = {}): ForumChannel => ({ id, companyId: 'co_a', kind: 'private', name: `chat-${id}`, topic, purpose: 'Principia brought in Julia (Content Writer).', departmentId: null, system: null, createdBy: 'm_me', createdAt: OLD, archivedAt: null, memberIds: ['m_me', 'm_julia'], lastSeq: 3, lastMessageAt: OLD, joined: true, lastReadSeq: 3, unread: 0, mentions: 0, ...x })

beforeAll(async () => {
  const store = await import('../../state/store')
  store.setState({
    ready: true,
    settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never,
    companies: [co, { ...co, id: 'co_personal', name: 'Personal', system: 'personal' } as CompanyPassport],
    companiesLoaded: true,
    activeCompanyId: 'co_a',
    companyAgents: [julia],
    repos: [{ id: 'r1', companyId: 'co_a', name: 'acme', path: '/x' }] as never,
    profiles: [{ id: 'p_claude', name: 'Claude', adapter: 'claude', model: null }] as never,
    tasks: [
      task('vo-31', { title: 'Draft the launch post' }),
      task('vo-32', { title: 'Make the hero image' }),
      task('vo-16', { status: 'in_review', title: 'Fix the pricing table', report: { outcome: 'review', summary: 'Table fixed', evidence: [], at: T } } as Partial<CompanyTask>),
      // filed by autopilot: no conversation
      task('vo-50', { title: 'Weekly ads check', source: 'schedule' } as Partial<CompanyTask>)
    ],
    sessions: [
      // Julia's own resting chat (an older, unrelated conversation)
      session('sess_julia', { title: 'Julia · Content Writer', companyAgentId: 'agt_julia', fromRunId: null, agentSessionId: 'conv-julia', status: 'running', pid: 1, endedAt: null }),
      // the same Claude chat, restarted once: listed once
      session('sess_a'),
      session('sess_b', { startedAt: T, endedAt: T })
    ],
    agents: {
      n31: root('n31', 'run_vo-31', 'Bash npm test'),
      n32: root('n32', 'run_vo-32', 'Read /x/hero.svg'),
      n50: root('n50', 'run_vo-50', 'mcp__google_ads__get_campaigns'),
      n_julia: { ...root('n_julia', '', ''), kind: 'session', runId: null, sessionId: 'sess_julia', status: 'needs_you', needs: 'idle', activity: null, report: 'Here is the outline you asked for.' } as AgentNode
    }
  })
  const { resetForum } = await import('../../state/forum')
  resetForum({
    byCompany: {
      co_a: {
        state: {
          companyId: 'co_a',
          me: 'm_me',
          members: [{ id: 'm_me', companyId: 'co_a', kind: 'human', role: 'owner', name: 'You', handle: 'you', agentId: null, status: 'active' }, { id: 'm_julia', companyId: 'co_a', kind: 'agent', role: 'member', name: 'Julia', handle: 'julia', agentId: 'agt_julia', status: 'active' }] as never,
          channels: [channel('launch', 'Spring launch'), channel('pricing', 'Pricing page', { lastSeq: 5, lastMessageAt: T, unread: 1, unreadTasks: ['vo-16'] }), channel('newer', 'Newsletter ideas', { lastMessageAt: new Date().toISOString() })],
          presence: [],
          openAsks: 0,
          openProposals: 0,
          taskChannels: { 'vo-31': 'launch', 'vo-32': 'launch', 'vo-16': 'pricing' }
        },
        error: null,
        pages: {},
        threads: {}
      }
    }
  })
})

describe('the sidebar menu: Recent and LIVE', () => {
  it('Recent: newest activity first; the conversation with working tasks says so; an unread result says which', async () => {
    const store = await import('../../state/store')
    store.setState({ view: { name: 'home' } })
    const { Sidebar } = await import('../../shell/Sidebar')
    const html = renderToStaticMarkup(createElement(Sidebar))
    const recent = html.slice(html.indexOf('aria-label="Recent"'), html.indexOf('aria-label="Live"'))
    const order = [...recent.matchAll(/data-title="([^"]+)"/g)].map((m) => m[1])
    expect([...order].sort()).toEqual(['Newsletter ideas', 'Pricing page', 'Spring launch'])
    expect(order[0]).toBe('Newsletter ideas')
    expect(recent).toMatch(/data-title="Spring launch" data-work="2 tasks working"/)
    expect(recent).toMatch(/data-title="Pricing page" data-work="VO-16 finished · unread"/)
    expect(recent).toMatch(/cx-recent__row[^"]*is-unread[^"]*" data-chatux="recent-row" data-title="Pricing page"/)
  })
  it('LIVE: the conversation as one row ("Julia · 2 tasks working · …"), the orphan task as its own row', async () => {
    const { Sidebar } = await import('../../shell/Sidebar')
    const html = renderToStaticMarkup(createElement(Sidebar))
    const live = html.slice(html.indexOf('aria-label="Live"'))
    expect(live).toContain('data-live-conv="launch"')
    expect(live).toMatch(/live-row__name">Spring launch<.*\w+ · 2 tasks working · (Running a command|Reading hero.svg)</)
    // autopilot's task has no conversation: its own row, opening its task chat
    expect(live).toContain('data-live-task="vo-50"')
    // one row per conversation, not per task
    expect(live).not.toContain('data-live-task="vo-31"')
    expect(live).not.toContain('data-live-task="vo-32"')
  })
})

describe('Chats', () => {
  it('rows: the conversation carries its work, the orphan task is a row under Live only, the resting chat is not live, Claude lists a restarted chat once', async () => {
    const store = await import('../../state/store')
    store.setState({ view: { name: 'chats', filter: 'all', chat: 'conv:newer' } })
    const { Sidebar } = await import('../../shell/Sidebar')
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toMatch(/data-title="Spring launch" data-work="2 tasks working"/)
    // PR-103: the state leads, who works on it comes after
    expect(html).toMatch(/chats5-row__last shimmer-text\s*">2 tasks working · \w+</)
    expect(html).toMatch(/data-title="Pricing page" data-work="VO-16 finished · unread"/)
    // tasks stay on the Board: not in Everything, a row under Live only while it works
    expect(html).not.toContain('data-task="VO-50"')
    store.setState({ view: { name: 'chats', filter: 'live', chat: 'conv:newer' } })
    const live = renderToStaticMarkup(createElement(Sidebar))
    expect(live).toMatch(/data-chatux="task-row" data-task="VO-50" data-state="working"/)
    // PR-103: the orphan task's row leads with its state (mark + words), never a bare dot
    expect(live).toMatch(/data-task="VO-50"[\s\S]*?data-chatux="row-state" data-state="working"/)
    store.setState({ view: { name: 'chats', filter: 'all', chat: 'conv:newer' } })
    // Julia's own chat keeps its own last line and is not shimmering
    const rowOf = (text: string): string => {
      const at = html.indexOf(text)
      return html.slice(html.lastIndexOf('<button', at), html.indexOf('</button>', at))
    }
    const agentRow = rowOf('Here is the outline you asked for.')
    expect(agentRow).toContain('Here is the outline you asked for.')
    expect(agentRow).not.toContain('is-shimmering')
    expect(agentRow).not.toMatch(/Working on \d tasks/)
    // CLAUDE: the restarted chat once
    expect(html.match(/VO-15 · Check why/g)?.length).toBe(1)
    // Live only counts the conversation with work and the orphan task (not Julia's resting chat)
    expect(html).toMatch(/Live only<span class="side-chats__n">2</)
  })
  it('a task chat keeps its parent conversation selected; an orphan task its own row', async () => {
    const store = await import('../../state/store')
    store.setState({ view: { name: 'chats', filter: 'live', chat: 'task:vo-31' } })
    const { Sidebar } = await import('../../shell/Sidebar')
    expect(renderToStaticMarkup(createElement(Sidebar))).toMatch(/aria-selected="true" data-chatux="chat-row" data-title="Spring launch"/)
    store.setState({ view: { name: 'chats', filter: 'live', chat: 'task:vo-50' } })
    expect(renderToStaticMarkup(createElement(Sidebar))).toMatch(/aria-selected="true" data-chatux="task-row" data-task="VO-50"/)
  })
})

describe('the status bar', () => {
  it('"3 working" spans a conversation and an orphan task: it opens Chats › Live only', async () => {
    const { StatusBar } = await import('../../shell/StatusBar')
    const html = renderToStaticMarkup(createElement(StatusBar))
    expect(html).toContain('3 working')
    expect(html).toContain('title="Open Chats › Live (⇧⌘A)"')
  })
})

describe('PR-103: one clear state per row', () => {
  it('a week-old question leads with "Question for you · 7d"; a stopped task says why; neither shows the unread dot', async () => {
    const store = await import('../../state/store')
    const old = store.getState().tasks
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString()
    store.setState({
      view: { name: 'chats', filter: 'all' },
      tasks: [
        ...old,
        task('vo-60', { title: 'Retry stapling', source: 'schedule', status: 'blocked', blockReason: 'needs_input', runId: 'run_60', updatedAt: week, ask: { kind: 'question', prompt: 'Which cert?', options: [], answer: null, askedAt: week } } as unknown as Partial<CompanyTask>),
        task('vo-61', { title: 'Nightly build', source: 'schedule', status: 'blocked', blockReason: 'interrupted', runId: 'run_61', updatedAt: new Date().toISOString(), report: { outcome: 'blocked', summary: 'x', evidence: [], at: T } } as unknown as Partial<CompanyTask>)
      ]
    })
    // tasks are not in Everything any more (they stay on the Board): the rows themselves, as Live only or a search shows them
    const { ChatRow } = await import('./ChatList')
    const rowOf = (id: string): string => {
      const t = store.getState().tasks.find((x) => x.identifier === id)!
      return renderToStaticMarkup(createElement(ChatRow, { row: { key: `task:${t.id}`, kind: 'task', task: t, companyId: t.companyId, live: false, at: t.updatedAt, unread: false }, selected: false, onPick: () => {}, onClose: () => {} }))
    }
    expect(rowOf('VO-60')).toMatch(/data-state="question"[\s\S]*Question for you · 7d/)
    expect(rowOf('VO-60')).toContain('chats5-row__dot is-needs')
    expect(rowOf('VO-61')).toMatch(/data-state="failed"[\s\S]*Stopped when the app quit/)
    store.setState({ tasks: old })
  })
})
