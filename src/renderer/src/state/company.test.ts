/**
 * COMPANY.md C5: the renderer's company state. enterCompany clears the back stack and re-scopes; "+" in a company
 * group spawns stamped with that company; a cross-company open switches focus and offers Undo.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanyPassport } from '@shared/company'
import type { Repo, Session } from '@shared/types'

const co = (id: string, name: string, sortOrder: number, extra: Partial<CompanyPassport> = {}): CompanyPassport =>
  ({ id, name, sortOrder, slug: id, color: 'var(--series-1)', system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', ...extra }) as CompanyPassport
const COMPANIES = [co('co_personal', 'Personal', 0, { system: 'personal' }), co('co_a', 'Acme', 1), co('co_b', 'Beta', 2)]
const REPOS = [
  { id: 'r_a', name: 'acme-web', path: '/x/acme-web', exists: true, companyId: 'co_a', companyOrder: 0 },
  { id: 'r_b', name: 'beta-api', path: '/x/beta-api', exists: true, companyId: 'co_b', companyOrder: 0 }
] as Repo[]

let seq = 0
const created: Record<string, unknown>[] = []
const settingsUpdates: Record<string, unknown>[] = []
const fakeHive = {
  company: { list: vi.fn(async () => COMPANIES), overview: vi.fn(async () => []) },
  tasks: { list: vi.fn(async () => []) },
  settings: { update: vi.fn(async (p: Record<string, unknown>) => (settingsUpdates.push(p), p)) },
  memory: { overview: vi.fn(async () => null) },
  sessions: {
    create: vi.fn(async (req: Record<string, unknown>) => {
      created.push(req)
      const companyId = (req.companyId as string | undefined) ?? REPOS.find((r) => r.id === req.repoId)?.companyId ?? 'co_personal'
      return { id: `s_${++seq}`, adapter: req.adapter, repoId: req.repoId ?? null, companyId, cwd: req.repoId ? '/x' : `/ud/companies/${companyId}/workspace`, status: 'running', startedAt: new Date().toISOString(), title: '' } as Session
    })
  },
  on: () => () => undefined,
  send: () => undefined
}

type Store = typeof import('./store')
let m: Store

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { hive: fakeHive, addEventListener: () => undefined, dispatchEvent: () => true }
  m = await import('./store')
})
beforeEach(async () => {
  created.length = 0
  settingsUpdates.length = 0
  m.setState({ view: { name: 'home' }, activeCompanyId: 'all', repos: REPOS, sessions: [], grid: [], focusedSession: null, companyUndo: null, providers: [], settings: null })
  await m.refreshCompanies()
})

describe('company focus', () => {
  it('orders companies with Personal last and turns the rail on', () => {
    const s = m.getState()
    expect(s.companies.map((c) => c.id)).toEqual(['co_a', 'co_b', 'co_personal'])
    expect(m.multiCompany()).toBe(true)
  })

  it('enterCompany sets the scope, persists it, goes Home and clears the back stack', async () => {
    await m.navigate({ name: 'workflows' })
    await m.navigate({ name: 'keys' })
    const before = m.getState().scopeNonce
    expect(await m.enterCompany('co_b')).toBe(true)
    expect(m.getState().activeCompanyId).toBe('co_b')
    expect(m.scopeCompanyId()).toBe('co_b')
    expect(m.getState().view).toEqual({ name: 'home' })
    expect(m.getState().scopeNonce).toBe(before + 1)
    expect(settingsUpdates).toContainEqual({ activeCompanyId: 'co_b' })
    // nothing to go back to from the previous company
    m.goBack({ name: 'agents' })
    await Promise.resolve()
    // five doors: the old Agents route is an alias of Chats on Live
    expect(m.getState().view).toEqual({ name: 'chats', filter: 'live' })
  })

  it('⌃N picks the Nth company in rail order, ⌃0 picks All', async () => {
    m.enterCompanySlot(2)
    await Promise.resolve()
    expect(m.getState().activeCompanyId).toBe('co_b')
    m.enterCompanySlot(0)
    await Promise.resolve()
    expect(m.getState().activeCompanyId).toBe('all')
    expect(m.scopeCompanyId()).toBeUndefined()
  })

  it('a Personal-only user stays in All mode', () => {
    m.setState({ companies: [COMPANIES[0]!], activeCompanyId: 'co_a' })
    expect(m.multiCompany()).toBe(false)
    expect(m.activeCompany()).toBe('all')
    expect(m.scopeCompanyId()).toBeUndefined()
  })
})

describe('spawning from a company', () => {
  it('"+" Chat in company B (All mode) spawns stamped B in B’s workspace', async () => {
    const sess = await m.startSession({ repoId: null, adapter: 'claude', forceNew: true, companyId: 'co_b' })
    expect(created[0]).toMatchObject({ companyId: 'co_b', repoId: null, adapter: 'claude' })
    expect(sess?.companyId).toBe('co_b')
    expect(sess?.cwd).toBe('/ud/companies/co_b/workspace')
    // All mode: no focus switch for a spawn
    expect(m.getState().activeCompanyId).toBe('all')
  })

  it('"+" on B’s repo sends B and the repo', async () => {
    await m.startSession({ repoId: 'r_b', adapter: 'codex', forceNew: true, companyId: 'co_b' })
    expect(created[0]).toMatchObject({ companyId: 'co_b', repoId: 'r_b' })
  })

  it('a chat in focused mode goes to the focused company; a repo session takes the repo’s company', async () => {
    await m.enterCompany('co_a')
    await m.openChat(true)
    expect(created[0]).toMatchObject({ companyId: 'co_a', repoId: null })
    expect(m.launchCompany({ repoId: 'r_b' })).toBe('co_b')
    m.setState({ activeCompanyId: 'all' })
    expect(m.launchCompany({ repoId: null })).toBeUndefined()
  })

  it('clicking a moved repo starts a session in its new company instead of focusing the old company’s', async () => {
    const t = new Date().toISOString()
    // r_b now belongs to Beta; a session started there while it was Acme's is still running
    m.setState({ sessions: [{ id: 's_old', repoId: 'r_b', companyId: 'co_a', status: 'running', startedAt: t } as Session] })
    const sess = await m.startSession({ repoId: 'r_b', adapter: 'claude' })
    expect(sess?.id).not.toBe('s_old')
    expect(created[0]).toMatchObject({ repoId: 'r_b', companyId: 'co_b' })
    // a running session of the repo's own company is reused
    created.length = 0
    expect((await m.startSession({ repoId: 'r_b', adapter: 'claude' }))?.id).toBe(sess?.id)
    expect(created).toHaveLength(0)
  })

  it('reusing a running chat never crosses companies', () => {
    const t = new Date().toISOString()
    m.setState({ sessions: [{ id: 's_pa', repoId: null, companyId: 'co_personal', status: 'running', startedAt: t } as Session] })
    expect(m.newestRunning(null, 'co_b')).toBeUndefined()
    expect(m.newestRunning(null, 'co_personal')?.id).toBe('s_pa')
  })

  it('DEPARTMENTS.md §9: "New Chat in Marketing" sends the department; a department chat is never the Chat row\'s', async () => {
    await m.openDepartmentChat({ id: 'dep_m', companyId: 'co_a' }, 'claude')
    expect(created.at(-1)).toMatchObject({ companyId: 'co_a', departmentId: 'dep_m', adapter: 'claude', repoId: null })
    const t = new Date().toISOString()
    m.setState({ sessions: [{ id: 's_dep', repoId: null, companyId: 'co_a', departmentId: 'dep_m', status: 'running', startedAt: t } as Session] })
    expect(m.newestRunning(null, 'co_a')).toBeUndefined()
    expect(m.newestRunning(null, 'co_a', 'dep_m')?.id).toBe('s_dep')
  })
})

describe('cross-company open', () => {
  it('opening B’s session while focused on A switches to B with Undo', async () => {
    await m.enterCompany('co_a')
    m.setState({ sessions: [{ id: 's_b1', repoId: 'r_b', companyId: 'co_b', status: 'running', startedAt: '2026-10-20T10:00:00Z' } as Session] })
    m.focusSession('s_b1')
    expect(m.getState().activeCompanyId).toBe('co_b')
    expect(m.getState().focusedSession).toBe('s_b1')
    expect(m.getState().companyUndo).toMatchObject({ text: 'Switched to Beta', prev: 'co_a' })
    m.undoCompanySwitch()
    expect(m.getState().activeCompanyId).toBe('co_a')
    expect(m.getState().companyUndo).toBeNull()
    // the opened pane stays open
    expect(m.getState().focusedSession).toBe('s_b1')
  })

  it('no switch in All mode or within the same company', async () => {
    m.setState({ sessions: [{ id: 's_b1', repoId: 'r_b', companyId: 'co_b', status: 'running', startedAt: '2026-10-20T10:00:00Z' } as Session] })
    m.focusSession('s_b1')
    expect(m.getState().activeCompanyId).toBe('all')
    await m.enterCompany('co_b')
    m.focusSession('s_b1')
    expect(m.getState().companyUndo).toBeNull()
  })
})

describe('focus robustness', () => {
  it('a cross-company open of an archived company’s session keeps the focus', async () => {
    await m.enterCompany('co_a')
    m.setState({ sessions: [{ id: 's_x', repoId: null, companyId: 'co_archived', status: 'running', startedAt: '2026-10-20T10:00:00Z' } as Session] })
    m.focusSession('s_x')
    expect(m.getState().activeCompanyId).toBe('co_a')
    expect(m.getState().companyUndo).toBeNull()
    expect(m.getState().focusedSession).toBe('s_x')
  })

  it('a focused company that disappears reads as All everywhere', () => {
    m.setState({ activeCompanyId: 'co_gone' })
    expect(m.activeCompany()).toBe('all')
    expect(m.scopeCompanyId()).toBeUndefined()
    expect(m.launchCompany({ repoId: null })).toBeUndefined()
  })

  it('Undo after a cross-company open returns to where the user was', async () => {
    await m.enterCompany('co_a')
    m.setState({ sessions: [{ id: 's_b2', repoId: 'r_b', companyId: 'co_b', status: 'running', startedAt: '2026-10-20T10:00:00Z' } as Session] })
    m.focusSession('s_b2')
    m.focusSession('s_b2')
    expect(m.getState().companyUndo?.prev).toBe('co_a')
  })
})
