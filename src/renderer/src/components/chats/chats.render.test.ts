/**
 * AGENT CHAT part 2 render checks: Chats switches the sidebar (Back, New chat, search, filters, bot-like rows), the
 * main area is only the conversation with its ONE right panel, the chat's time stamps and source chips, and the
 * panel's slot for later tabs (the Browser).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport } from '@shared/company'
import type { ChatItem } from '@shared/chat'
import type { AgentNode } from '@shared/live'
import type { Session } from '@shared/types'
import { buildBlocks } from '@shared/chatView'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 60_000).toISOString()
const co = { id: 'co_a', name: 'Acme', slug: 'acme', color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '' } as unknown as CompanyPassport
const personal = { ...co, id: 'co_personal', name: 'Personal', system: 'personal' } as CompanyPassport
const julia = { id: 'agt_julia', companyId: 'co_a', departmentId: null, kind: 'profile', refId: 'p_claude', name: 'Content Writer', archivedAt: null, pausedAt: null, createdAt: T, updatedAt: T, data: { autonomy: 'manual', instructions: '', capabilities: 'Writes the posts.', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 2 }, persona: { key: 'custom', name: 'Julia', personality: '', bio: 'Writes like a friend.', look: { material: 'marble', hair: 'short', beard: 'none', drape: 'toga' } } } } as unknown as CompanyAgent
const chat = (id: string, p: Partial<Session> = {}): Session => ({ id, title: 'Julia · Content Writer', profileId: 'p_claude', adapter: 'claude', repoId: null, cwd: '/work/acme', status: 'running', pid: 1, cols: 80, rows: 24, exitCode: null, startedAt: T, endedAt: null, artifactsDir: '', fromRunId: null, agentSessionId: null, companyId: 'co_a', ...p }) as Session
const node = (id: string, p: Partial<AgentNode>): AgentNode => ({ id, kind: 'session', parentId: null, rootId: id, sessionId: null, runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/', title: id, agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: T, updatedAt: T, endedAt: null, ...p }) as AgentNode

// the persona name the app shows for Julia's seat (resolved like every surface does)
let NAME = ''
beforeAll(async () => {
  const store = await import('../../state/store')
  store.setState({
    ready: true,
    settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never,
    companies: [co, personal],
    companiesLoaded: true,
    activeCompanyId: 'co_a',
    companyAgents: [julia],
    profiles: [{ id: 'p_claude', name: 'Claude', adapter: 'claude', model: null }, { id: 'p_codex', name: 'Codex', adapter: 'codex', model: null }] as never,
    sessions: [chat('sess_julia', { companyAgentId: 'agt_julia' }), chat('sess_direct', { title: 'Pricing ideas', companyAgentId: null })],
    // Julia answered and waits; nobody looked yet (the list's dot)
    agents: { n_julia: node('n_julia', { sessionId: 'sess_julia', status: 'needs_you', needs: 'idle', report: 'The draft is in drafts/launch.md.' }) }
  })
  NAME = (await import('../../state/desk')).deskAgentOf(julia).name
})

describe('Chats switches the sidebar', () => {
  it('shows the conversations list in the sidebar itself, with Back, New chat, search and the filters, and no menu', async () => {
    const store = await import('../../state/store')
    // the direct chat is open, so Julia's unread answer keeps its dot
    store.setState({ view: { name: 'chats', filter: 'all', chat: 'session:sess_direct' } })
    const { Sidebar } = await import('../../shell/Sidebar')
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('aria-label="Back to the menu"')
    expect(html).toContain('placeholder="Search chats"')
    for (const f of ['Live', 'All', 'Agents', 'Direct']) expect(html).toContain(`>${f}<`)
    expect(html).toContain('New chat in Acme')
    // a bot-like row: bust, name, role, its last line and the unread dot
    expect(html).toContain(`chats5-row__name">${NAME}</span><span class="chats5-row__role">Content Writer<`)
    expect(html).toContain('The draft is in drafts/launch.md.')
    expect(html).toContain('aria-label="New answer"')
    expect(html).toContain('Pricing ideas')
    // the menu is gone while the list is up (no doors, no Search or ask)
    expect(html).not.toContain('Search or ask…')
    expect(html).not.toContain('aria-label="Main"')
  })
  it('anywhere else the sidebar is the menu', async () => {
    const store = await import('../../state/store')
    store.setState({ view: { name: 'home' } })
    const { Sidebar } = await import('../../shell/Sidebar')
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('Search or ask…')
    expect(html).not.toContain('Back to the menu')
  })
})

describe('the main area is only the conversation', () => {
  it('an agent: its header, its chat across the width and ONE right panel (no list column)', async () => {
    const store = await import('../../state/store')
    store.setState({ view: { name: 'chats', chat: 'agent:agt_julia' } })
    const { ChatsView } = await import('../../views/ChatsView')
    const html = renderToStaticMarkup(createElement(ChatsView, { chat: 'agent:agt_julia' }))
    expect(html).not.toContain('chats5-list')
    expect(html).toContain(`convo-title__name">${NAME}</span><span class="convo-title__role">· Content Writer<`)
    expect(html).toContain(`aria-label="Conversation with ${NAME}"`)
    expect(html).toContain(`aria-label="About ${NAME}"`)
    expect(html).toContain('Writes like a friend.')
    // Runs on: Claude or Codex in one click
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Claude</)
    expect(html).toContain('>Codex<')
    expect(html).toContain(`aria-label="Hide ${NAME}’s panel"`)
  })
  it('a direct chat: the same layout with the session’s panel', async () => {
    const { ChatsView } = await import('../../views/ChatsView')
    const html = renderToStaticMarkup(createElement(ChatsView, { chat: 'session:sess_direct' }))
    expect(html).toContain('direct chat, no agent')
    expect(html).toContain('aria-label="About this chat"')
    expect(html).toContain('Where it works')
  })
  it('the panel has a slot for later tabs (the Browser)', async () => {
    const { registerPanelTab } = await import('../desk/AgentPanel')
    const off = registerPanelTab({ key: 'browser', label: 'Browser', render: () => createElement('div', null, 'browser here') })
    const { ChatsView } = await import('../../views/ChatsView')
    const html = renderToStaticMarkup(createElement(ChatsView, { chat: 'agent:agt_julia' }))
    // the header's Browser button is always there; the slot adds a panel tab of that name
    const tab = /role="tab"[^>]*>Browser</
    expect(html).toMatch(tab)
    off()
    expect(renderToStaticMarkup(createElement(ChatsView, { chat: 'agent:agt_julia' }))).not.toMatch(tab)
  })
})

describe('Grok-style reading', () => {
  it('a time line before a new stretch, and bare web addresses as source chips', async () => {
    const { Blocks } = await import('../chat/ChatCards')
    const { stampsFor } = await import('../../lib/agentChatView')
    const at = Date.now() - 3600_000
    const items = [{ id: 'u1', kind: 'user', parent: null, text: 'Find sources', images: 0, state: 'sent', at }, { id: 't1', kind: 'text', parent: null, md: 'See https://www.example.org/post/1 for more.', streaming: false }] as ChatItem[]
    const blocks = buildBlocks(items)
    const html = renderToStaticMarkup(createElement(Blocks, { blocks, live: false, actions: null, stamps: stampsFor(blocks) }))
    expect(html).toMatch(/class="chat-stamp" role="separator"><time[^>]*>Today /)
    expect(html).toContain('class="dgm-md__src"')
    expect(html).toMatch(/title="https:\/\/www.example.org\/post\/1">example.org</)
  })
})
