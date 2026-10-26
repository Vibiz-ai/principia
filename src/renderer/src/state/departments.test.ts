/**
 * DEPARTMENTS.md §9 renderer state: the departments and companyAgents slices load only with both flags on and refresh
 * on data:changed 'departments'; presets create all six in one call; "Pause all agents" turns autopilot off everywhere.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanyPassport, Department } from '@shared/company'
import type { Settings } from '@shared/types'

const co = (id: string, name: string, sortOrder: number, extra: Partial<CompanyPassport> = {}): CompanyPassport =>
  ({ id, name, sortOrder, slug: id, color: 'var(--series-1)', system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', ...extra }) as CompanyPassport
const COMPANIES = [co('co_personal', 'Personal', 0, { system: 'personal' }), co('co_a', 'Acme', 1, { autopilot: true }), co('co_b', 'Beta', 2)]
/** Archived, autopilot left on: only listed with includeArchived. */
const ARCHIVED = co('co_old', 'Oldco', 3, { archivedAt: '2026-10-01', autopilot: true })
let refuse: string | null = null
const dep = (id: string, key: string, companyId = 'co_a'): Department =>
  ({ id, companyId, key, name: key, color: null, icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: { charter: { does: '', doesNot: '' }, sourceDefaults: [], slackChannels: [], passportNote: null, contextFallback: '' } }) as Department

let departments: Department[] = []
const listeners: Record<string, (p: unknown) => void> = {}
const autopilotCalls: { companyId: string; on: boolean }[] = []
const fakeHive = {
  company: { list: vi.fn(async (q?: { includeArchived?: boolean }) => (q?.includeArchived ? [...COMPANIES, ARCHIVED] : COMPANIES).map((c) => ({ ...c }))), overview: vi.fn(async () => []) },
  tasks: { list: vi.fn(async () => []) },
  settings: { update: vi.fn(async (p: Record<string, unknown>) => p) },
  memory: { overview: vi.fn(async () => null) },
  departments: {
    list: vi.fn(async () => departments),
    createPresets: vi.fn(async ({ companyId, keys }: { companyId: string; keys?: string[] }) => {
      const want = keys ?? ['development', 'marketing', 'sales', 'support', 'ops', 'finance']
      for (const k of want) if (!departments.some((d) => d.companyId === companyId && d.key === k)) departments.push(dep(`dep_${k}`, k, companyId))
      return departments.filter((d) => d.companyId === companyId)
    })
  },
  companyAgents: { list: vi.fn(async () => []) },
  board: {
    autopilot: vi.fn(async (q: { companyId: string; on: boolean }) => {
      autopilotCalls.push(q)
      if (q.companyId === 'co_personal' || q.companyId === refuse) throw Object.assign(new Error('Personal has no board'), { code: 'forbidden' })
      const c = [...COMPANIES, ARCHIVED].find((x) => x.id === q.companyId)
      if (c) c.autopilot = q.on
      return { companyId: q.companyId, autopilot: q.on, maxInFlight: 3 }
    })
  },
  ui: { contextMenu: vi.fn(async () => null), confirm: vi.fn(async () => true) },
  on: (name: string, cb: (p: unknown) => void) => {
    listeners[name] = cb
    return () => undefined
  },
  send: () => undefined
}

type Store = typeof import('./store')
let m: Store
const flags = (companies: boolean, deps: boolean): Settings => ({ experimental: { companies, departments: deps } }) as Settings
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { hive: fakeHive, addEventListener: () => undefined, dispatchEvent: () => true }
  ;(globalThis as unknown as { document: unknown }).document = { documentElement: { classList: { toggle: () => undefined } } }
  m = await import('./store')
})
beforeEach(async () => {
  departments = [dep('dep_dev', 'development')]
  autopilotCalls.length = 0
  COMPANIES[1]!.autopilot = true
  ARCHIVED.autopilot = true
  refuse = null
  vi.clearAllMocks()
  m.setState({ settings: null, departments: [], companyAgents: [], view: { name: 'home' }, activeCompanyId: 'all' })
  await m.refreshCompanies()
})

describe('departments slices', () => {
  it('stay empty and never call main while the flag is off', async () => {
    m.setState({ settings: flags(true, false) })
    await m.refreshDepartments()
    expect(fakeHive.departments.list).not.toHaveBeenCalled()
    expect(m.getState().departments).toEqual([])
    // departments alone is not enough: it needs companies too (§0.8)
    m.setState({ settings: flags(false, true) })
    await m.refreshDepartments()
    expect(fakeHive.departments.list).not.toHaveBeenCalled()
    expect(m.departmentsOn()).toBe(false)
  })

  it('load every company’s departments and seats, archived included, with both flags on', async () => {
    m.setState({ settings: flags(true, true) })
    await m.refreshDepartments()
    expect(fakeHive.departments.list).toHaveBeenCalledWith({ includeArchived: true })
    expect(fakeHive.companyAgents.list).toHaveBeenCalledWith({ includeArchived: true })
    expect(m.getState().departments.map((d) => d.id)).toEqual(['dep_dev'])
  })

  it('drop the slices when the flag turns off', async () => {
    m.setState({ settings: flags(true, true) })
    await m.refreshDepartments()
    m.setState({ settings: flags(true, false) })
    await m.refreshDepartments()
    expect(m.getState().departments).toEqual([])
  })

  it('refresh on data:changed departments', async () => {
    m.boot().catch(() => undefined)
    await tick()
    m.setState({ settings: flags(true, true) })
    departments.push(dep('dep_m', 'marketing'))
    listeners['data:changed']!({ domain: 'departments' })
    await tick()
    expect(m.getState().departments.map((d) => d.key)).toEqual(['development', 'marketing'])
  })
})

describe('presets', () => {
  it('one click creates all six (idempotent by key) in one call', async () => {
    m.setState({ settings: flags(true, true) })
    await m.refreshDepartments()
    await m.createDepartmentPresets('co_a')
    expect(fakeHive.departments.createPresets).toHaveBeenCalledTimes(1)
    expect(fakeHive.departments.createPresets).toHaveBeenCalledWith({ companyId: 'co_a' })
    expect(m.getState().departments.filter((d) => d.companyId === 'co_a').map((d) => d.key).sort()).toEqual(['development', 'finance', 'marketing', 'ops', 'sales', 'support'])
  })
})

describe('Pause all agents', () => {
  it('turns autopilot off in every company and tolerates a company without a board', async () => {
    m.setState({ settings: flags(true, true) })
    await m.pauseAllAgents()
    expect(autopilotCalls.map((c) => c.companyId).sort()).toEqual(['co_a', 'co_b', 'co_old', 'co_personal'])
    expect(autopilotCalls.every((c) => c.on === false)).toBe(true)
    const s = m.getState()
    expect(s.companies.find((c) => c.id === 'co_a')?.autopilot).toBe(false)
    expect(s.toasts.at(-1)?.kind).toBe('info')
  })

  it('reaches an archived company that still has autopilot on', async () => {
    m.setState({ settings: flags(true, true) })
    await m.pauseAllAgents()
    expect(autopilotCalls.some((c) => c.companyId === 'co_old' && c.on === false)).toBe(true)
    expect(ARCHIVED.autopilot).toBe(false)
  })

  it('reports a company whose autopilot is still on, even when the renderer thought it was off', async () => {
    m.setState({ settings: flags(true, true) })
    // stale renderer row: Acme reads as off, main still has it on and refuses
    m.setState((s) => ({ companies: s.companies.map((c) => (c.id === 'co_a' ? { ...c, autopilot: false } : c)) }))
    refuse = 'co_a'
    await m.pauseAllAgents()
    const last = m.getState().toasts.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.text).toContain('Acme')
    expect(m.getState().companies.find((c) => c.id === 'co_a')?.autopilot).toBe(true)
  })

  it('a company tile pauses that company only (A4), with departments on; never every company', async () => {
    const menu = fakeHive.ui.contextMenu as unknown as { mock: { calls: [{ items: { id?: string; label?: string }[] }][] } }
    m.setState({ settings: flags(true, false) })
    await m.companyContextMenu(COMPANIES[1]!)
    expect(menu.mock.calls.at(-1)![0].items.some((i) => i.id === 'pause')).toBe(false)
    m.setState({ settings: flags(true, true) })
    await m.companyContextMenu(COMPANIES[1]!)
    const items = menu.mock.calls.at(-1)![0].items
    expect(items.find((i) => i.id === 'pause')?.label).toBe('Pause Acme')
    expect(items.some((i) => i.id === 'pauseAgents')).toBe(false)
  })
})

describe('department views', () => {
  it('open inside their company', async () => {
    m.setState({ settings: flags(true, true) })
    m.openDepartment({ id: 'dep_dev', companyId: 'co_a' })
    await tick()
    expect(m.getState().activeCompanyId).toBe('co_a')
    expect(m.getState().view).toMatchObject({ name: 'department', id: 'dep_dev' })
    m.openAgentSeat({ id: 'agt_1', companyId: 'co_a' })
    await tick()
    expect(m.getState().view).toEqual({ name: 'agentSeat', id: 'agt_1' })
  })
})
