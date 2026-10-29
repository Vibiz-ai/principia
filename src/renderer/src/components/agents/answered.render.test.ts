/**
 * PR-11 render checks: Home's "agent answered" row opens the full chat instead of a one-line reply box, and New
 * conversation takes dropped images (the box, and the whole page around it).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentNode } from '@shared/live'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 60_000).toISOString()
const node = (p: Partial<AgentNode>): AgentNode => ({ id: 'n_julia', kind: 'session', parentId: null, rootId: 'n_julia', sessionId: 'sess_julia', runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/', title: 'Julia · Content Writer', agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'needs_you', needs: 'idle', activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: 'The draft is in drafts/launch.md. Want a shorter one too?', startedAt: T, updatedAt: T, endedAt: null, ...p }) as AgentNode

beforeAll(async () => {
  const store = await import('../../state/store')
  store.setState({ ready: true, settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never })
})

describe("Home: an agent's answer opens the chat", () => {
  it('shows what the agent said and an Open … to reply button, with no inline reply input', async () => {
    const { AnsweredCard } = await import('./ReplyBox')
    const html = renderToStaticMarkup(createElement(AnsweredCard, { agent: node({}), onOpen: () => {} }))
    expect(html).toContain('The draft is in drafts/launch.md. Want a shorter one too?')
    expect(html).toContain('data-home="open-chat"')
    expect(html).toMatch(/Open (chat|terminal) to reply/)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('Reply…')
  })
  it('with nothing said yet it is still one click into the chat', async () => {
    const { AnsweredCard } = await import('./ReplyBox')
    const html = renderToStaticMarkup(createElement(AnsweredCard, { agent: node({ report: null }), onOpen: () => {} }))
    expect(html).toContain('data-home="open-chat"')
    expect(html).not.toContain('reply-box__said')
  })
  it('Home uses it, not the inline ReplyBox', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../views/HomeView.tsx', import.meta.url), 'utf8')
    expect(src).toContain('<AnsweredCard agent={root}')
    expect(src).not.toContain('<ReplyBox')
  })
})

describe('New conversation takes dropped images', () => {
  it('the box is a drop target and says what a drop does while files are over it', async () => {
    const { DropHint, TeamComposer } = await import('../conversations/ConversationKit')
    const hint = renderToStaticMarkup(createElement(DropHint))
    expect(hint).toContain('Drop to attach')
    const html = renderToStaticMarkup(createElement(TeamComposer, { companyId: 'co_a', onStarted: () => {}, variant: 'pane' }))
    expect(html).toContain('aria-label="New task"')
    // not dragging: no overlay
    expect(html).not.toContain('data-chatux="drop-hint"')
  })
})
