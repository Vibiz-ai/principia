import { describe, expect, it } from 'vitest'
import type { CompanyPassport } from '@shared/company'
import type { AgentNode, Ask } from '@shared/live'
import type { Repo, Session, Workflow } from '@shared/types'
import {
  companyAtSlot,
  companyBadges,
  companyInitials,
  companyLabel,
  companyOf,
  effectiveCompany,
  isMultiCompany,
  liveItems,
  nextGroupPeek,
  reorderIds,
  reposOf,
  sortCompanies,
  switchTarget,
  windowTitle,
  withPersonal,
  workflowsTargetingRepo
} from './companyModel'

const co = (id: string, name: string, sortOrder: number, extra: Partial<CompanyPassport> = {}): CompanyPassport =>
  ({ id, name, sortOrder, slug: id, color: 'var(--series-1)', system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', ...extra }) as CompanyPassport
const personal = co('co_personal', 'Personal', 0, { system: 'personal' })
const acme = co('co_a', 'Acme', 2)
const beta = co('co_b', 'Beta Labs', 1)
const gamma = co('co_c', 'Gamma', 3)

const agent = (id: string, p: Partial<AgentNode & { companyId?: string }> = {}): AgentNode & { companyId?: string } =>
  ({ id, kind: 'session', rootId: id, parentId: null, sessionId: null, runId: null, status: 'working', needs: null, title: id, updatedAt: '2026-10-20T10:00:00Z', ...p }) as AgentNode & { companyId?: string }
const ask = (id: string, p: Partial<Ask & { companyId?: string }> = {}): Ask & { companyId?: string } =>
  ({ id, agentId: 'x', rootId: 'x', sessionId: null, runId: null, kind: 'permission', status: 'open', title: `ask ${id}`, question: null, createdAt: '2026-10-20T09:00:00Z', ...p }) as Ask & { companyId?: string }
const session = (id: string, companyId?: string): Session => ({ id, companyId, repoId: null, status: 'running' }) as Session

describe('company ordering', () => {
  it('sorts by sortOrder, hides archived and keeps Personal last', () => {
    const list = sortCompanies([personal, acme, co('co_x', 'Old', 0, { archivedAt: '2026-01-01' }), beta])
    expect(list.map((c) => c.id)).toEqual(['co_b', 'co_a', 'co_personal'])
  })
  it('needs Personal plus one before the rail shows', () => {
    expect(isMultiCompany([personal])).toBe(false)
    expect(isMultiCompany([acme, personal])).toBe(true)
  })
  it('maps ⌃N to the Nth company in rail order', () => {
    const list = sortCompanies([personal, acme, beta])
    expect(companyAtSlot(list, 1)?.id).toBe('co_b')
    expect(companyAtSlot(list, 3)?.id).toBe('co_personal')
    expect(companyAtSlot(list, 4)).toBeUndefined()
    expect(companyAtSlot(list, 0)).toBeUndefined()
  })
  it('reorders ids and ignores no-ops', () => {
    const ids = ['a', 'b', 'c']
    expect(reorderIds(ids, 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(reorderIds(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(reorderIds(ids, 'a', 'a', 'after')).toBe(ids)
    expect(reorderIds(ids, 'z', 'a', 'after')).toBe(ids)
  })
  it('labels, initials and NULL stamps', () => {
    expect(companyLabel(personal, true)).toBe('Personal / Unassigned')
    expect(companyLabel(acme, true)).toBe('Acme')
    expect(companyInitials('Beta Labs')).toBe('BL')
    expect(companyInitials('acme')).toBe('AC')
    expect(companyOf({ companyId: null })).toBe('co_personal')
    expect(companyOf(undefined)).toBe('co_personal')
  })
  it('lists one company’s repos in its own order', () => {
    const repos = [
      { id: 'r1', companyId: 'co_a', companyOrder: 1 },
      { id: 'r2', companyId: 'co_b', companyOrder: 0 },
      { id: 'r3', companyId: 'co_a', companyOrder: 0 },
      { id: 'r4' }
    ] as Repo[]
    expect(reposOf(repos, 'co_a').map((r) => r.id)).toEqual(['r3', 'r1'])
    expect(reposOf(repos, 'co_personal').map((r) => r.id)).toEqual(['r4'])
  })
  it('finds workflows that target a repo', () => {
    const wfs = [
      { id: 'w1', nodes: [{ cwd: 'r1' }] },
      { id: 'w2', nodes: [{ cwd: null }], worktree: { repo: 'r1' } },
      { id: 'w3', nodes: [{ cwd: 'r2' }] }
    ] as unknown as Workflow[]
    expect(workflowsTargetingRepo(wfs, 'r1').map((w) => w.id)).toEqual(['w1', 'w2'])
  })
  it('window title names the company only once there are companies', () => {
    expect(windowTitle('Home', 'all', false)).toBe('Principia — Home')
    expect(windowTitle('Portfolio', 'all', true)).toBe('Principia — All companies — Portfolio')
    expect(windowTitle('Keys', acme, true)).toBe('Principia — Acme — Keys')
  })
  it('only switches focus for a cross-company open in focused mode', () => {
    expect(switchTarget('all', true, 'co_a')).toBeNull()
    expect(switchTarget('co_a', true, 'co_a')).toBeNull()
    expect(switchTarget('co_a', false, 'co_b')).toBeNull()
    expect(switchTarget('co_a', true, 'co_b')).toBe('co_b')
  })
})

describe('companyBadges with three companies', () => {
  const companies = [acme, beta, gamma, personal]
  const sessions = [session('s_a', 'co_a'), session('s_b', 'co_b'), session('s_old')]
  const agents = [
    agent('ag_a', { companyId: 'co_a', sessionId: 's_a', status: 'working' }),
    // no stamp (older main): resolved through its session
    agent('ag_b', { sessionId: 's_b', status: 'needs_you', needs: 'idle' }),
    agent('ag_b_seen', { companyId: 'co_b', sessionId: 's_b', status: 'needs_you', needs: 'idle' }),
    // subagents never count on their own
    agent('sub', { kind: 'subagent', rootId: 'ag_a', status: 'working' }),
    agent('step_c', { kind: 'step', companyId: 'co_c', runId: 'run_c', status: 'starting' }),
    agent('done_c', { kind: 'step', companyId: 'co_c', status: 'done' })
  ]
  const asks = [
    ask('k1', { companyId: 'co_a', agentId: 'ag_a', rootId: 'ag_a' }),
    ask('k2', { agentId: 'step_c', rootId: 'step_c' }), // unstamped: from its agent
    ask('k3', { companyId: 'co_a', status: 'answered' }),
    ask('k4', { agentId: 'unknown', rootId: 'unknown' }) // nothing known: Personal
  ]
  const { byCompany, total } = companyBadges({ companies, agents, asks, seen: new Set(['ag_b_seen']), sessions, overview: { co_c: { failed24h: 2 } } })

  it('counts needs-you per company (open asks + unseen idle roots)', () => {
    expect(byCompany.co_a!.needsYou).toBe(1)
    expect(byCompany.co_b!.needsYou).toBe(1)
    expect(byCompany.co_c!.needsYou).toBe(1)
    expect(byCompany.co_personal!.needsYou).toBe(1)
    expect(total.needsYou).toBe(4)
  })
  it('counts working roots and failed runs per company', () => {
    expect(byCompany.co_a!.working).toBe(1)
    expect(byCompany.co_b!.working).toBe(0)
    expect(byCompany.co_c!.working).toBe(1)
    expect(byCompany.co_c!.failed).toBe(true)
    expect(byCompany.co_a!.failed).toBe(false)
    expect(total.working).toBe(2)
    expect(total.failed).toBe(true)
  })
  it('subagents inherit the root’s company', () => {
    const r = companyBadges({ companies, agents: [agent('root', { companyId: 'co_b' }), agent('kid', { kind: 'subagent', rootId: 'root' })], asks: [ask('q', { agentId: 'kid', rootId: 'root' })], seen: new Set(), sessions: [] })
    expect(r.byCompany.co_b!.needsYou).toBe(1)
  })
  it('lists Needs you oldest first, filtered per company, working rows last', () => {
    const items = liveItems({ agents, asks, seen: new Set(['ag_b_seen']), sessions, working: true })
    expect(items.filter((i) => i.kind !== 'working').map((i) => i.key)).toEqual(['ask:k1', 'ask:k2', 'ask:k4', 'idle:ag_b'])
    expect(items.find((i) => i.key === 'idle:ag_b')!.companyId).toBe('co_b')
    // roots with an open ask are listed once, as the ask
    expect(items.some((i) => i.key === 'work:ag_a')).toBe(false)
    expect(items.some((i) => i.kind === 'working')).toBe(false)
    const more = liveItems({ agents: [...agents, agent('w_b', { companyId: 'co_b' })], asks, seen: new Set(['ag_b_seen']), sessions, working: true })
    expect(more.at(-1)).toMatchObject({ key: 'work:w_b', companyId: 'co_b', kind: 'working' })
    expect(liveItems({ agents, asks, seen: new Set(), sessions, companyId: 'co_c' }).map((i) => i.key)).toEqual(['ask:k2'])
  })
})

describe('company review fixes', () => {
  it('never switches focus to an archived or unknown company', () => {
    const known = (id: string): boolean => id === 'co_a' || id === 'co_b'
    expect(switchTarget('co_a', true, 'co_b', known)).toBe('co_b')
    expect(switchTarget('co_a', true, 'co_gone', known)).toBeNull()
  })
  it('falls back to All when the focused company is gone or archived', () => {
    const list = sortCompanies([personal, acme, beta])
    expect(effectiveCompany('co_a', list)).toBe('co_a')
    expect(effectiveCompany('co_gone', list)).toBe('all')
    expect(effectiveCompany('co_a', [personal])).toBe('all')
    expect(effectiveCompany('co_a', [])).toBe('all')
  })
  it('adds a Personal group when main lists companies without it, so unstamped rows keep a home', () => {
    expect(withPersonal([]).length).toBe(0)
    expect(withPersonal([acme, personal])).toEqual([acme, personal])
    const list = withPersonal([acme])
    expect(list.map((c) => c.id)).toEqual(['co_a', 'co_personal'])
    expect(isMultiCompany(list)).toBe(true)
  })
  it('an ask whose agent is not loaded counts for its session’s company', () => {
    const { byCompany } = companyBadges({
      companies: [acme, beta, gamma, personal],
      agents: [],
      asks: [ask('q1', { agentId: 'missing', rootId: 'missing', sessionId: 's_c' })],
      seen: new Set(),
      sessions: [session('s_c', 'co_c')]
    })
    expect(byCompany.co_c?.needsYou).toBe(1)
    expect(byCompany.co_personal?.needsYou).toBe(0)
    const items = liveItems({ agents: [], asks: [ask('q1', { agentId: 'missing', rootId: 'missing', sessionId: 's_c' })], seen: new Set(), sessions: [session('s_c', 'co_c')] })
    expect(items[0]?.companyId).toBe('co_c')
  })
})

describe('All-mode group auto-expand', () => {
  it('a folded group peeks open again when a second item needs you, not only the first', () => {
    // first item: opens
    let peek = nextGroupPeek(true, 0, 1)
    expect(peek).toBe(true)
    // the user folds it while it peeks
    peek = false
    // the count stays: the fold holds
    expect(nextGroupPeek(peek, 1, 1)).toBe(false)
    // one answered: still folded
    expect(nextGroupPeek(peek, 2, 1)).toBe(false)
    // something new needs you while one is still open: it opens again
    expect(nextGroupPeek(peek, 1, 2)).toBe(true)
  })
})
