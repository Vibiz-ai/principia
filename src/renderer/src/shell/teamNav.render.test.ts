/**
 * Team in the sidebar unfolds into departments and their dashboards (TeamNav). Rendered statically, the way the shell's
 * other render tests do it: the Sidebar with the remembered state in localStorage, and the list itself with dashboards.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyPassport, CompanyTask, Department } from '@shared/company'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
const stored: Record<string, string> = {}
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {}, innerHeight: 900, innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) })
vi.stubGlobal('localStorage', { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => void (stored[k] = v), removeItem: (k: string) => void delete stored[k] })

const company = (id: string, name: string, i: number): CompanyPassport =>
  ({ id, name, slug: id, color: 'var(--series-1)', sortOrder: i, system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', autopilot: false, pausedAt: null, taskPrefix: 'AC', accounts: {}, monthlyCap: 40 }) as unknown as CompanyPassport
const dep = (id: string, companyId: string, name: string, i: number): Department =>
  ({ id, companyId, key: id, name, color: 'var(--series-2)', icon: null, sortOrder: i, archivedAt: null, createdAt: '', updatedAt: '', data: { charter: { does: '', doesNot: '' }, sourceDefaults: [], slackChannels: [], passportNote: null, contextFallback: '' } }) as unknown as Department
const task = (id: string, departmentId: string, status: string): CompanyTask =>
  ({ id, identifier: id, title: id, description: '', companyId: 'co_acme', repoId: null, status, priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, departmentId, agentId: null, blockReason: null, createdAt: '', updatedAt: '' }) as unknown as CompanyTask

const DEPS = [dep('dep_eng', 'co_acme', 'Engineering', 0), dep('dep_mkt', 'co_acme', 'Marketing', 1), dep('dep_other', 'co_globex', 'Globex Sales', 0)]

let store: typeof import('../state/store')
const el = <P,>(c: ComponentType<P>, p: P) => createElement(c as ComponentType<object>, p as object)
const sidebar = async (): Promise<string> => renderToStaticMarkup(el((await import('./Sidebar')).Sidebar, {}))
const remember = (v: unknown): void => void (stored['principia.teamNav'] = JSON.stringify(v))

beforeAll(async () => {
  store = await import('../state/store')
})
beforeEach(() => {
  for (const k of Object.keys(stored)) delete stored[k]
  store.setState({
    ready: true,
    settings: { experimental: { companies: true, departments: true }, sidebarNav: {} } as never,
    companies: [company('co_acme', 'Acme Robotics', 0), company('co_globex', 'Globex', 1)],
    companiesLoaded: true,
    activeCompanyId: 'co_acme',
    view: { name: 'team' },
    departments: DEPS,
    companyAgents: [],
    tasks: [task('t1', 'dep_eng', 'todo'), task('t2', 'dep_eng', 'in_progress'), task('t3', 'dep_eng', 'done'), task('t4', 'dep_mkt', 'canceled')]
  })
})

describe('Team unfolds into departments in the sidebar', () => {
  it('Team carries a chevron and stays a link to the Team page', async () => {
    const html = await sidebar()
    expect(html).toMatch(/role="link" aria-expanded="false"[^>]*title="Team:/)
    expect(html).toContain('aria-label="Show departments"')
    expect(html).not.toContain('Engineering')
  })

  it('remembered open: one row per department of this company, with its open tasks', async () => {
    remember({ co_acme: { open: true, departments: [] } })
    const html = await sidebar()
    expect(html).toMatch(/aria-expanded="true"[^>]*title="Team:/)
    expect(html).toContain('Engineering')
    expect(html).toContain('Marketing')
    // only open tasks count; Marketing has none open, so it shows no number
    expect(html).toContain('aria-label="2 open tasks"')
    expect(html).not.toContain('Globex Sales')
  })

  it('the state is per company: another company opens closed', async () => {
    remember({ co_acme: { open: true, departments: [] } })
    store.setState({ activeCompanyId: 'co_globex' })
    expect(await sidebar()).not.toContain('Globex Sales')
  })

  it('departments off: the list is one row that turns them on', async () => {
    remember({ co_acme: { open: true, departments: [] } })
    store.setState({ settings: { experimental: {}, sidebarNav: {} } as never })
    const html = await sidebar()
    expect(html).toContain('Turn on departments')
    expect(html).not.toContain('Engineering')
  })

  it('All companies: Team is a plain door, no chevron', async () => {
    remember({ all: { open: true, departments: [] } })
    store.setState({ activeCompanyId: 'all' })
    const html = await sidebar()
    expect(html).not.toContain('Show departments')
    expect(html).not.toContain('Hide departments')
  })
})

describe('a department unfolds into its dashboards', () => {
  const list = async (props: Partial<Parameters<typeof import('./TeamNav').TeamNavList>[0]>): Promise<string> => {
    const { TeamNavList } = await import('./TeamNav')
    return renderToStaticMarkup(el(TeamNavList, { companyId: 'co_acme', departments: DEPS.slice(0, 2), counts: { dep_eng: 2 }, dashboards: { dep_eng: [{ id: 'dsh_1', name: 'Engineering · GitHub' }] }, open: ['dep_eng', 'dep_mkt'], view: { name: 'team' }, onToggle: () => {}, ...props }))
  }

  it('lists installed dashboards by name, and "Add a dashboard" where there are none', async () => {
    const html = await list({})
    expect(html).toContain('Engineering · GitHub')
    expect(html.match(/Add a dashboard/g)).toHaveLength(1)
    expect(html).toMatch(/aria-expanded="true"[^>]*title="Engineering · 2 open tasks"/)
  })

  it('a collapsed department hides its dashboards', async () => {
    const html = await list({ open: [] })
    expect(html).not.toContain('Engineering · GitHub')
    expect(html).not.toContain('Add a dashboard')
  })

  it('the dashboard open on the department page is the selected row', async () => {
    const html = await list({ view: { name: 'department', id: 'dep_eng', focus: 'dashboards', dashboard: 'dsh_1' } })
    expect(html).toMatch(/is-selected" role="link" tabindex="0" aria-current="page" title="Engineering · GitHub on the Engineering page"/)
  })

  it('no departments yet: one row to add one', async () => {
    const html = await list({ departments: [] })
    expect(html).toContain('Add a department')
  })
})
