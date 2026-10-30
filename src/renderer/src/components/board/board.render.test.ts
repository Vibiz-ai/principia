import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompanyAgent, CompanyPassport, CompanyTask, Department } from '@shared/company'

// server markup needs a server snapshot; the store passes only the client one
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
// the renderer modules read window.hive at import; markup rendering never calls it
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const task = (id: string, p: Partial<CompanyTask> = {}): CompanyTask =>
  ({ id, identifier: `PRN-${id}`, title: `Task ${id}`, description: '', companyId: 'co_a', repoId: null, status: 'todo', blockReason: null, priority: 3, source: 'manual', sourceUrl: null, externalId: null,
    assigneeProfileId: null, parentId: null, dependencyIds: [], runId: null, createdAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-20T08:00:00Z', ...p }) as CompanyTask
const company = (id: string, name: string, p: Partial<CompanyPassport> = {}): CompanyPassport =>
  ({ id, name, slug: id, color: 'var(--series-1)', sortOrder: 0, system: null, archivedAt: null, repoIds: [], createdAt: '', updatedAt: '', mission: '', brandVoice: '', audience: '', products: '', goals: '', context: '', constraints: '', ...p }) as CompanyPassport
const marketing = { id: 'dep_m', companyId: 'co_a', key: 'marketing', name: 'Marketing', color: 'var(--accent)', icon: null, sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '', data: {} } as Department
const copywriter = { id: 'agt_copy', companyId: 'co_a', departmentId: 'dep_m', kind: 'profile', refId: 'p1', name: 'Copywriter', archivedAt: null, pausedAt: null, createdAt: '', updatedAt: '', data: { autonomy: 'auto' } } as CompanyAgent
const asking = task('1', { status: 'blocked', blockReason: 'needs_input', agentId: 'agt_copy', departmentId: 'dep_m', ask: { kind: 'confirm', prompt: 'Publish on Friday?' } })

async function withState(departments: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  const { setState } = await import('../../state/store')
  setState({
    settings: { experimental: { companies: true, departments } } as never,
    companies: [company('co_a', 'Acme', { autopilot: true }), company('co_personal', 'Personal', { system: 'personal' })],
    companiesLoaded: true, activeCompanyId: 'co_a', view: { name: 'tasks' },
    tasks: [asking, task('2', { status: 'in_progress', agentId: 'agt_copy' }), task('3', { status: 'blocked', blockReason: 'deps', dependencyIds: ['2'] }), task('4', { status: 'in_review' })],
    departments: departments ? [marketing] : [], companyAgents: departments ? [copywriter] : [], ...extra
  })
}

describe('AskForm', () => {
  it('renders a choice ask with its options, a confirm as Yes / No, and nothing once answered', async () => {
    const { AskForm } = await import('./AskForm')
    const choice = renderToStaticMarkup(createElement(AskForm, { task: task('1', { status: 'blocked', blockReason: 'needs_input', ask: { kind: 'choice', prompt: 'Which headline?', options: ['A', 'B'] } }) }))
    expect(choice).toContain('Which headline?')
    expect(choice).toMatch(/<span>A<\/span>.*<span>B<\/span>/)
    expect(choice).toContain('textarea')
    const confirm = renderToStaticMarkup(createElement(AskForm, { task: asking }))
    expect(confirm).toMatch(/<span>Yes<\/span>.*<span>No<\/span>/)
    expect(confirm).not.toContain('textarea')
    expect(renderToStaticMarkup(createElement(AskForm, { task: task('1', { ask: { kind: 'question', prompt: 'x', answer: 'y' } }) }))).toBe('')
  })
})

describe('TaskCard', () => {
  it('says a running card waits for a free slot, until its step starts', async () => {
    const { TaskCard } = await import('./TaskCard')
    const { setState } = await import('../../state/store')
    const running = task('4', { status: 'in_progress', runId: 'run1' })
    setState({ slotWaits: { run1: '2026-10-30T10:00:00.000Z' } })
    const waiting = renderToStaticMarkup(createElement(TaskCard, { task: running, onOpen: () => {} }))
    expect(waiting).toContain('Waiting for a slot')
    expect(waiting).not.toContain('task-live-dot')
    setState({ slotWaits: {} })
    const started = renderToStaticMarkup(createElement(TaskCard, { task: running, onOpen: () => {} }))
    expect(started).not.toContain('Waiting for a slot')
    expect(started).toContain('task-live-dot')
  })
  it('shows the lock for a dependency block, the reason chip in Needs you, and never drags a running card', async () => {
    const { TaskCard } = await import('./TaskCard')
    const locked = renderToStaticMarkup(createElement(TaskCard, { task: task('3', { status: 'blocked', blockReason: 'deps' }), onOpen: () => {} }))
    expect(locked).toContain('Waiting on its dependencies')
    expect(locked).toContain('draggable="true"')
    const needs = renderToStaticMarkup(createElement(TaskCard, { task: asking, department: marketing, agent: copywriter, reason: 'needs_input', onOpen: () => {} }))
    expect(needs).toContain('Question')
    expect(needs).toContain('Marketing')
    expect(needs).toContain('background:var(--accent)')
    const running = renderToStaticMarkup(createElement(TaskCard, { task: task('2', { status: 'in_progress' }), onOpen: () => {} }))
    expect(running).toContain('draggable="false"')
  })
})

describe('NeedsYouTasks', () => {
  beforeEach(() => vi.resetModules())
  it('lists the company’s asks, reviews and parked tasks; nothing while departments are off', async () => {
    // a company with code (a repository) shows task codes; pm-review C7: one without code shows titles only
    await withState(true, { repos: [{ id: 'repo_a', companyId: 'co_a' }] })
    const { NeedsYouTasks } = await import('./NeedsYouTasks')
    const html = renderToStaticMarkup(createElement(NeedsYouTasks, { companyId: 'co_a' }))
    expect(html).toContain('PRN-1')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('PRN-4')
    expect(html).not.toContain('PRN-2')
    expect(html).not.toContain('PRN-3')
    await withState(false)
    expect(renderToStaticMarkup(createElement(NeedsYouTasks, { companyId: 'co_a' }))).toBe('')
  })
})

describe('TaskRunChip', () => {
  beforeEach(() => vi.resetModules())
  it('labels a task run PRN-42 · Marketing/Copywriter through runs.task_id; nothing for other runs or with departments off', async () => {
    await withState(true, { tasks: [task('42', { runId: 'run_new', agentId: 'agt_copy', departmentId: 'dep_m' })] })
    const { TaskRunChip } = await import('./TaskRunChip')
    // an older run of the task: the row carries its runs.task_id
    expect(renderToStaticMarkup(createElement(TaskRunChip, { runId: 'run_old', taskId: '42' }))).toContain('PRN-42 · Marketing/Copywriter')
    expect(renderToStaticMarkup(createElement(TaskRunChip, { runId: 'run_new' }))).toContain('PRN-42 · Marketing/Copywriter')
    // not a task run (and the lookup has not answered yet): no chip
    expect(renderToStaticMarkup(createElement(TaskRunChip, { runId: 'run_plain' }))).toBe('')
    await withState(false, { tasks: [task('42', { runId: 'run_new' })] })
    expect(renderToStaticMarkup(createElement(TaskRunChip, { runId: 'run_new' }))).toBe('')
  })
})

describe('BoardView', () => {
  beforeEach(() => vi.resetModules())
  it('renders today’s Tasks page with departments off', async () => {
    await withState(false)
    const { TasksView } = await import('../../views/TasksView')
    const html = renderToStaticMarkup(createElement(TasksView))
    // five doors: the page is Board everywhere (nav, title, palette), departments on or off
    expect(html).toContain('>Board<')
    expect(html).toContain('In review')
    expect(html).not.toContain('Autopilot')
    expect(html).not.toContain('Needs you')
  })
  it('renders pre-departments tasks (no board fields) and All mode without crashing', async () => {
    const legacy = (id: string, status: CompanyTask['status']): CompanyTask => {
      const { blockReason: _b, ...rest } = task(id, { status })
      return rest as CompanyTask
    }
    await withState(true, { activeCompanyId: 'all', tasks: [legacy('8', 'blocked'), legacy('9', 'in_review'), { ...legacy('10', 'todo'), companyId: 'co_personal' }], asks: {} })
    const { TasksView } = await import('../../views/TasksView')
    const html = renderToStaticMarkup(createElement(TasksView))
    for (const title of ['Task 8', 'Task 9', 'Task 10']) expect(html).toContain(title)
    // pm-review C7: companies with no code show titles, never task codes
    for (const id of ['PRN-8', 'PRN-9', 'PRN-10']) expect(html).not.toContain(id)
    // All mode: no single company, so no Autopilot switch
    expect(html).not.toContain('role="switch"')
    const { NeedsYouTasks } = await import('./NeedsYouTasks')
    // no repository: titles, never codes (C7), in the All companies list too
    const all = renderToStaticMarkup(createElement(NeedsYouTasks, {}))
    expect(all).toContain('Task 8')
    expect(all).not.toContain('PRN-8')
  })
  it('renders the four columns, the quick create row and agent drop targets with departments on, and no Autopilot copy', async () => {
    await withState(true)
    const { TasksView } = await import('../../views/TasksView')
    const html = renderToStaticMarkup(createElement(TasksView))
    expect(html).toContain('>Board<')
    for (const lane of ['To do', 'Working', 'Needs you', 'Done']) expect(html).toContain(`aria-label="${lane}"`)
    // design §5 row 10: the switch lives in Automations › Autopilot only; the Board carries no copy of it
    expect(html).not.toContain('role="switch"')
    expect(html).not.toContain('Autopilot on')
    expect(html).toContain('aria-label="New task title"')
    expect(html).toContain('drop a card to assign')
  })
})

describe('Sidebar Needs you task items', () => {
  beforeEach(() => vi.resetModules())
  it('brings its own Needs you header with the task count in focused mode, and renders nothing when nothing waits', async () => {
    await withState(true)
    const { NeedsYouTasksSlot, useNeedsYouTaskCount } = await import('../../shell/DepartmentGroup')
    const html = renderToStaticMarkup(createElement(NeedsYouTasksSlot, { companyId: 'co_a', heading: true }))
    // PRN-1 (question) and PRN-4 (review) wait on you
    expect(html).toContain('Needs you')
    expect(html).toContain('◆ 2')
    expect(html).toContain('Task 1')
    expect(html).not.toContain('PRN-1')
    // All mode keeps the Sidebar's own header: no second one from the slot
    expect(renderToStaticMarkup(createElement(NeedsYouTasksSlot, { limit: 8 }))).not.toContain('sidebar__section')
    let count = -1
    const Probe = (): null => { count = useNeedsYouTaskCount(); return null }
    renderToStaticMarkup(createElement(Probe))
    expect(count).toBe(2)
    await withState(true, { tasks: [task('5', { status: 'done' })] })
    expect(renderToStaticMarkup(createElement(NeedsYouTasksSlot, { companyId: 'co_a', heading: true }))).toBe('')
  })
})

describe('Board department filter', () => {
  beforeEach(() => vi.resetModules())
  it('keeps an archived department’s filter visible (its page’s Board button) instead of a blank “All departments”', async () => {
    const archived = { ...marketing, archivedAt: '2026-10-19T00:00:00Z' }
    await withState(true, { departments: [archived], view: { name: 'tasks', departmentId: 'dep_m' } })
    const { TasksView } = await import('../../views/TasksView')
    const html = renderToStaticMarkup(createElement(TasksView))
    expect(html).toContain('Marketing (archived)')
  })
})

describe('DepartmentView', () => {
  beforeEach(() => vi.resetModules())
  it('counts open tasks where the sidebar does: a task routed only through its seat belongs to the seat’s department', async () => {
    const { DEPARTMENT_DATA_DEFAULTS, AGENT_DATA_DEFAULTS } = await import('@shared/company')
    // main always hands the renderer parsed data with defaults
    await withState(true, {
      tasks: [task('6', { agentId: 'agt_copy' }), task('7', { departmentId: 'dep_m', status: 'done' })], view: { name: 'department', id: 'dep_m' },
      departments: [{ ...marketing, data: DEPARTMENT_DATA_DEFAULTS }], companyAgents: [{ ...copywriter, data: { ...AGENT_DATA_DEFAULTS, autonomy: 'auto' } }]
    })
    const { DepartmentView } = await import('../../views/DepartmentView')
    const html = renderToStaticMarkup(createElement(DepartmentView, { id: 'dep_m' }))
    expect(html).toContain('1 open task<')
  })
})

// ---------- VOICE.md §4.4, §5.6, §5.8: personas, busts, coins, empty states ----------
const PERSONA = { key: 'custom', name: 'Gaius', personality: 'Knows the lead before the lead knows.', bio: 'Digs through sites before every call.', look: { material: 'bronze', hair: 'curls', beard: 'full', laurel: true, drape: 'gold' } }

describe('TaskCard personas', () => {
  beforeEach(() => vi.resetModules())
  it('shows the mini bust with the tooltip “{persona} · {role}”; a legacy marketing agent resolves to Marcus', async () => {
    await withState(true)
    const { TaskCard } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCard, { task: asking, department: marketing, agent: copywriter, reason: 'needs_input', onOpen: () => {} }))
    expect(html).toContain('title="Marcus · Copywriter"')
    expect(html).toContain('rm-bust')
    expect(html).not.toContain('seat-avatar')
  })
  it('uses the stored persona, and keeps “(paused)” in the tooltip', async () => {
    await withState(true, { companyAgents: [{ ...copywriter, pausedAt: '2026-10-20T00:00:00Z', data: { autonomy: 'auto', persona: PERSONA } }] })
    const { TaskCard } = await import('./TaskCard')
    const agent = { ...copywriter, pausedAt: '2026-10-20T00:00:00Z', data: { autonomy: 'auto', persona: PERSONA } } as unknown as CompanyAgent
    const html = renderToStaticMarkup(createElement(TaskCard, { task: asking, department: marketing, agent, onOpen: () => {} }))
    expect(html).toContain('title="Gaius · Copywriter (paused)"')
  })
  it('personas off restores the department-colour initial and the role label', async () => {
    await withState(true, { settings: { experimental: { companies: true, departments: true }, personas: false } })
    const { TaskCard } = await import('./TaskCard')
    const html = renderToStaticMarkup(createElement(TaskCard, { task: asking, department: marketing, agent: copywriter, onOpen: () => {} }))
    expect(html).toContain('title="Copywriter"')
    expect(html).toContain('seat-avatar')
    expect(html).not.toContain('rm-bust')
  })
})

describe('Board empty state', () => {
  beforeEach(() => vi.resetModules())
  it('shows the amphora mosaic, the board.empty sentence, the Latin in playful and a New task action', async () => {
    await withState(true, { tasks: [] })
    const { TasksView } = await import('../../views/TasksView')
    const html = renderToStaticMarkup(createElement(TasksView))
    expect(html).toContain('rm-mosaic--amphora')
    expect(html).toContain('No tasks yet. Add one, or start your agents and they&#x27;ll propose some.')
    expect(html).toContain('lang="la"')
    expect(html).toMatch(/board-empty[\s\S]*New task/)
    // no lanes over an empty board
    expect(html).not.toContain('aria-label="To do"')
  })
  it('drops the Latin in plain and keeps the mosaic', async () => {
    await withState(true, { tasks: [], settings: { experimental: { companies: true, departments: true }, tone: 'plain' } })
    const { TasksView } = await import('../../views/TasksView')
    const html = renderToStaticMarkup(createElement(TasksView))
    expect(html).toContain('rm-mosaic--amphora')
    expect(html).not.toContain('lang="la"')
  })
})

describe('Department and agent pages with personas', () => {
  beforeEach(() => vi.resetModules())
  const withDefaults = async (extra: Record<string, unknown> = {}): Promise<void> => {
    const { DEPARTMENT_DATA_DEFAULTS, AGENT_DATA_DEFAULTS } = await import('@shared/company')
    await withState(true, {
      tasks: [], view: { name: 'department', id: 'dep_m' },
      departments: [{ ...marketing, data: DEPARTMENT_DATA_DEFAULTS }], companyAgents: [{ ...copywriter, data: { ...AGENT_DATA_DEFAULTS, autonomy: 'auto' } }], ...extra
    })
  }
  it('lists agents with Bust 28, “{persona} · {role}” and the personality line', async () => {
    await withDefaults()
    const { DepartmentView } = await import('../../views/DepartmentView')
    const html = renderToStaticMarkup(createElement(DepartmentView, { id: 'dep_m' }))
    expect(html).toContain('dep-seat__name">Marcus<span class="dep-seat__role"> · Copywriter</span>')
    expect(html).toContain('Writes like he&#x27;s late for the Forum.')
    expect(html).toContain('aria-label="Marcus, Copywriter, idle"')
  })
  it('shows the column mosaic and dept.empty.agents with no agents', async () => {
    await withDefaults({ companyAgents: [] })
    const { DepartmentView } = await import('../../views/DepartmentView')
    const html = renderToStaticMarkup(createElement(DepartmentView, { id: 'dep_m' }))
    expect(html).toContain('rm-mosaic--column')
    expect(html).toContain('No agents in Marketing yet.')
  })
  it('agent page = the conversation (AGENT CHAT part 2): the chat across the width, ONE right panel with who, status, action and the tabs; personas off names the role', async () => {
    await withDefaults({ view: { name: 'agentSeat', id: 'agt_copy' } })
    const { AgentSeatView } = await import('../../views/AgentSeatView')
    const html = renderToStaticMarkup(createElement(AgentSeatView, { id: 'agt_copy' }))
    // the header: Team › Marcus · Copywriter (no left identity column any more)
    expect(html).toContain('>Team<')
    expect(html).toMatch(/convo-title__name">Marcus<.*convo-title__role">· Copywriter</)
    expect(html).not.toContain('desk-left')
    // the conversation is Marcus's own live chat; with no chat yet nothing starts from looking: the empty chat and its
    // composer, and the first message starts it
    expect(html).toContain('aria-label="Conversation with Marcus"')
    expect(html).not.toContain('Opening Marcus’s chat…')
    expect(html).toContain('placeholder="Message Marcus…')
    // ONE right panel: the bust, name, role, status sentence, its one action, the tabs
    expect(html).toContain('aria-label="About Marcus"')
    expect(html).toMatch(/convo-panel__name">Marcus</)
    expect(html).toContain('Nothing assigned')
    for (const t of ['Details', 'Queue', 'History', 'Instructions', 'Library', 'Computer']) expect(html).toContain(`>${t}<`)
    // Details: how it works with its switch, Runs on, routines; Pause lives here, never next to Archive (C9)
    expect(html).toContain('Starts its tasks on its own')
    expect(html).toContain('Pause Marcus')
    expect(html).toContain('>Routines<')
    expect(html).not.toContain('Archive')
    await withDefaults({ view: { name: 'agentSeat', id: 'agt_copy' }, settings: { experimental: { companies: true, departments: true }, personas: false } })
    const off = renderToStaticMarkup(createElement(AgentSeatView, { id: 'agt_copy' }))
    expect(off).not.toContain('Marcus')
    expect(off).toContain('Conversation with Copywriter')
  })
  it('sidebar seat rows: Bust 16, the persona and the tertiary role label', async () => {
    await withDefaults({ companyAgents: [{ ...copywriter, departmentId: null }] })
    const { DepartmentGroup } = await import('../../shell/DepartmentGroup')
    const html = renderToStaticMarkup(createElement(DepartmentGroup, { companyId: 'co_a', companyName: 'Acme' }))
    // a company-level legacy agent comes from the no-department pool
    expect(html).toContain('seat-row__name">Junia<')
    expect(html).toContain('seat-row__role">Copywriter<')
    expect(html).toContain('width="16"')
  })
})

describe('Company rail tiles (five doors E14)', () => {
  beforeEach(() => vi.resetModules())
  const healthy = { tasks: [task('2', { status: 'in_progress', agentId: 'agt_copy', departmentId: 'dep_m' })], asks: {} }
  it('a monogram tile per company; health is in the accessible name, never a native tooltip', async () => {
    await withState(true, healthy)
    const { CompanyRail } = await import('../../shell/CompanyRail')
    const html = renderToStaticMarkup(createElement(CompanyRail))
    expect(html).toContain('aria-label="Acme, all agents healthy"')
    expect(html).not.toContain('title="Acme')
    expect(html).toMatch(/class="rail-mark[^"]*"[^>]*>AC</)
    // Personal is the person glyph, never letters
    expect(html).toContain('rail-mark--personal')
  })
  it('keeps the badges: the needs-you pill hides the health line, a failed run shows the red square', async () => {
    await withState(true, { ...healthy, tasks: [...healthy.tasks, task('4', { status: 'in_review', agentId: 'agt_copy' })] })
    let { CompanyRail } = await import('../../shell/CompanyRail')
    let html = renderToStaticMarkup(createElement(CompanyRail))
    expect(html).not.toContain('all agents healthy')
    expect(html).toContain('rail__count')
    vi.resetModules()
    await withState(true, { ...healthy, companyOverview: { co_a: { failed24h: 1 } } })
    ;({ CompanyRail } = await import('../../shell/CompanyRail'))
    html = renderToStaticMarkup(createElement(CompanyRail))
    expect(html).toContain('rail-mark__failed')
    expect(html).toContain('Acme · a run failed in the last 24 h')
  })
  it('the company’s own rail label replaces the initials, and a client says so in its name', async () => {
    await withState(false, healthy)
    const st = await import('../../state/store')
    st.setState((x) => ({ companies: x.companies.map((c) => (c.id === 'co_a' ? { ...c, railLabel: 'AX2', client: true } : c)) }))
    const { CompanyRail } = await import('../../shell/CompanyRail')
    const html = renderToStaticMarkup(createElement(CompanyRail))
    expect(html).toMatch(/class="rail-mark[^"]*"[^>]*>AX2</)
    expect(html).toContain('aria-label="Acme · client"')
  })
})
