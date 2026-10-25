/**
 * Five doors A1 release gate, renderer half: three companies in one store (live agents, asks, chats, tasks, seats,
 * repositories), and the shell rendered inside each one: sidebar (doors, badges, LIVE, repositories, pins), status
 * bar, company header, the ⌘K palette, Chats (Live and All), Team and the Board. A company's markup must not carry
 * another company's marker word, name or id. The live counts are checked to agree on every surface (A2).
 * The main half (every list behind Knowledge, Spend, Forum, Automations, Files, Connections, Keys, composer hints and
 * the terminal) is src/main/__tests__/companyLeak.test.ts.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, CompanyTask, Department } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { Repo, Session } from '@shared/types'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const T = new Date(Date.now() - 60_000).toISOString()
const CO = [
  { id: 'co_nw', name: 'Northwind Coffee', marker: 'espresso' },
  { id: 'co_la', name: 'Ledgerly App', marker: 'ledgerline' },
  { id: 'co_hd', name: 'Harbor Dental Group', marker: 'molarcare' }
]
const company = (c: (typeof CO)[number], i: number): CompanyPassport =>
  ({ id: c.id, name: c.name, slug: c.id, color: 'var(--series-1)', sortOrder: i, system: null, archivedAt: null, repoIds: [`repo_${c.marker}`], createdAt: '', updatedAt: '', mission: `${c.marker} mission`, brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', autopilot: false, pausedAt: null, taskPrefix: c.marker.slice(0, 2).toUpperCase() }) as CompanyPassport
const personal = { ...company({ id: 'co_personal', name: 'Personal', marker: 'x' }, 9), system: 'personal', repoIds: [], mission: '' } as CompanyPassport
const agent = (id: string, x: Partial<AgentNode & { companyId: string }>): AgentNode =>
  ({ id, kind: 'step', parentId: null, rootId: id, sessionId: null, runId: null, stepId: null, provider: 'claude', repoId: null, cwd: '/', title: id, agentType: null, externalId: null, toolUseId: null, model: null, depth: 0, background: false, attribution: 'exact', status: 'working', needs: null, activity: null, lastTool: null, toolCount: 0, memReads: 0, filesTouched: [], tokensIn: null, tokensOut: null, costUsd: null, modelUsage: null, report: null, startedAt: T, updatedAt: T, endedAt: null, ...x }) as AgentNode

function world() {
  const agents: Record<string, AgentNode> = {}
  const asks: Record<string, Ask> = {}
  const sessions: Session[] = []
  const tasks: CompanyTask[] = []
  const departments: Department[] = []
  const companyAgents: CompanyAgent[] = []
  const repos: Repo[] = []
  CO.forEach((c, i) => {
    const m = c.marker
    repos.push({ id: `repo_${m}`, name: `${m}-app`, path: `/work/${m}-app`, addedAt: T, exists: true, isGit: true, liveSessions: 1, companyId: c.id, companyOrder: 0 } as Repo)
    sessions.push({ id: `sess_${m}`, title: `${m} chat`, profileId: 'p', adapter: 'claude', repoId: `repo_${m}`, cwd: `/work/${m}-app`, status: 'running', pid: 1, cols: 80, rows: 24, exitCode: null, startedAt: T, endedAt: null, companyId: c.id } as unknown as Session)
    // a working task run whose agent carries no stamp: it resolves through its task (the Personal bug)
    agents[`step_${m}`] = agent(`step_${m}`, { title: `${m} research`, activity: `reading ${m} notes`, runId: `run_${m}` })
    // a chat that asks for permission
    agents[`chat_${m}`] = agent(`chat_${m}`, { kind: 'session', sessionId: `sess_${m}`, title: `${m} pricing chat`, status: 'needs_you', needs: 'permission', companyId: c.id } as never)
    asks[`ask_${m}`] = { id: `ask_${m}`, agentId: `chat_${m}`, rootId: `chat_${m}`, sessionId: `sess_${m}`, runId: null, stepId: null, provider: 'claude', kind: 'permission', channel: 'stdio', title: `Edit ${m} prices?`, detail: null, toolName: null, toolInput: null, question: null, options: [], status: 'open', answer: null, answeredVia: null, createdAt: T, answeredAt: null, expiresAt: null, companyId: c.id } as unknown as Ask
    departments.push({ id: `dep_${m}`, companyId: c.id, key: m, name: `${m} desk`, color: null, icon: null, sortOrder: i, archivedAt: null, createdAt: '', updatedAt: '', data: { charter: { does: '', doesNot: '' }, sourceDefaults: [], slackChannels: [], passportNote: null, contextFallback: '' } } as Department)
    companyAgents.push({ id: `agt_${m}`, companyId: c.id, departmentId: `dep_${m}`, kind: 'profile', refId: 'p', name: `${m} writer`, archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: { autonomy: 'auto', instructions: '', capabilities: '', mode: 'headless', defaultRepoId: null, limits: {} } } as unknown as CompanyAgent)
    tasks.push({ id: `task_${m}`, identifier: `${m.slice(0, 2).toUpperCase()}-1`, title: `${m} launch plan`, description: '', companyId: c.id, repoId: null, status: 'in_progress', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], runId: `run_${m}`, departmentId: `dep_${m}`, agentId: `agt_${m}`, blockReason: null, createdAt: T, updatedAt: T } as unknown as CompanyTask)
    tasks.push({ id: `review_${m}`, identifier: `${m.slice(0, 2).toUpperCase()}-2`, title: `${m} homepage copy`, description: '', companyId: c.id, repoId: null, status: 'in_review', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, departmentId: `dep_${m}`, agentId: `agt_${m}`, blockReason: null, createdAt: T, updatedAt: T } as unknown as CompanyTask)
  })
  return { agents, asks, sessions, tasks, departments, companyAgents, repos }
}

function leaks(html: string, mine: (typeof CO)[number]): string[] {
  const low = html.toLowerCase()
  const out: string[] = []
  for (const o of CO) {
    if (o.id === mine.id) continue
    if (low.includes(o.marker)) out.push(`${o.name}: "${o.marker}"`)
    if (html.includes(o.id)) out.push(`${o.name}: ${o.id}`)
  }
  return out
}

type Surface = [string, () => Promise<React.JSX.Element>]
let surfaces: Surface[] = []

beforeAll(async () => {
  const store = await import('../state/store')
  store.setState({
    ready: true,
    settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never,
    companies: [...CO.map(company), personal],
    companiesLoaded: true,
    ...world()
  })
  const el = <P,>(c: ComponentType<P>, p: P) => createElement(c as ComponentType<object>, p as object)
  surfaces = [
    ['Sidebar', async () => el((await import('./Sidebar')).Sidebar, {})],
    ['Status bar', async () => el((await import('./StatusBar')).StatusBar, {})],
    ['Company header', async () => el((await import('./CompanyHeader')).CompanyHeader, { company: store.getState().companies.find((c) => c.id === store.getState().activeCompanyId) ?? null })],
    ['Palette (⌘K)', async () => (store.setState({ palette: { open: true, mode: 'all', nonce: 1 } }), el((await import('./CommandPalette')).CommandPalette, {}))],
    ['Chats › Live', async () => el((await import('../views/ChatsView')).ChatsView, { filter: 'live' })],
    ['Chats › All', async () => el((await import('../views/ChatsView')).ChatsView, { filter: 'all' })],
    ['Team', async () => el((await import('../views/TeamView')).TeamView, {})],
    ['Board', async () => el((await import('../views/BoardView')).BoardView, {})]
  ]
})

describe('A1: inside one company, the shell renders nothing of another', () => {
  for (const c of CO) {
    it(`${c.name}`, async () => {
      const store = await import('../state/store')
      store.setState({ activeCompanyId: c.id, view: { name: 'home' }, palette: { open: false, mode: 'all', nonce: 0 } })
      for (const [name, make] of surfaces) {
        const html = renderToStaticMarkup(await make())
        expect(leaks(html, c), `${name} in ${c.name}`).toEqual([])
      }
    })
  }
  it('the Sidebar, status bar and palette do show the company’s own live rows (not a vacuous pass)', async () => {
    const store = await import('../state/store')
    store.setState({ activeCompanyId: 'co_la', view: { name: 'home' } })
    const side = renderToStaticMarkup(await surfaces[0]![1]())
    expect(side).toContain('ledgerline research')
    const palette = renderToStaticMarkup(await surfaces[3]![1]())
    expect(palette.toLowerCase()).toContain('ledgerline')
  })
})

describe('A2: every count agrees', () => {
  it('rail badge = sidebar Home badge = status bar = useNeeds; Team dot = LIVE = status bar working', async () => {
    const store = await import('../state/store')
    const { truthOf } = await import('../state/live')
    const { needsIn, workingIn } = await import('../lib/liveTruth')
    const { badgesFromTruth } = await import('../lib/companyModel')
    for (const c of CO) {
      store.setState({ activeCompanyId: c.id })
      const t = truthOf(store.getState())
      const needs = needsIn(t, c.id).count
      const working = workingIn(t, c.id).count
      // one ask + one board task in review; one working task run (resolved through its task, never Personal)
      expect(needs).toBe(2)
      expect(working).toBe(1)
      expect(badgesFromTruth(t, store.getState().companies).byCompany[c.id]).toMatchObject({ needsYou: needs, working })
      const bar = renderToStaticMarkup(await surfaces[1]![1]())
      expect(bar).toContain(`${working} working`)
      expect(bar).toContain(`${needs} need you`)
      const side = renderToStaticMarkup(await surfaces[0]![1]())
      expect(side).toContain(`aria-label="${needs} need you"`)
      expect(side).toContain(`aria-label="${working} working"`)
    }
    expect(workingIn(truthOf(store.getState()), 'co_personal').count).toBe(0)
  })
})
