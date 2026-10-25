import { useEffect, useMemo, useRef, useState } from 'react'
import { LANE_LABELS, TASK_SOURCES, TASK_STATUSES, type CompanyAgent, type CompanyPassport, type CompanyTask, type CompanyTaskInput, type Department, type TaskDetail, type TaskLane, type TaskSource, type TaskStatus } from '@shared/company'
import type { Id } from '@shared/types'
import { Button, IconButton, Loading, Pill, Switch, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { TaskPriority, TaskSourceBadge, TaskStatusIcon } from '../components/TaskBits'
import { TaskCard } from '../components/board/TaskCard'
import { TaskEditor } from '../components/board/TaskEditor'
import { TaskInspector } from '../components/board/TaskInspector'
import { LinearBanner, LinearSheet } from '../components/board/LinearSheet'
import { linearLine, startedInLinear, useLinear } from '../lib/linear'
import { PRIORITIES, SOURCE_LABEL, STATUS_LABEL, useCompanyData, useLaneContext } from '../lib/company'
import { BOARD_LANES, TASK_DRAG_TYPE, agentDrop, autopilotToggle, dropSeats, filterTasks, keptDepartmentFilter, laneColumns, laneDrop, laneText, swimlanes, type AutopilotView, type DropAction, type DropResult } from '../lib/board'
import { departmentsOf, taskDepartment, taskReason, type LaneContext } from '../lib/departments'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { relative } from '../lib/time'
import { departmentsOn, loadJson, navigate, openBoard, openNewCompany, refreshCompanies, saveJson, toast, useStore } from '../state/store'
import { CompanyChip, useScope } from '../components/CompanyChip'
import { AgentBust, agentLabel, agentNameNow, useAgentName } from '../shell/DepartmentGroup'
import { LatinLine, MosaicEmpty } from '../components/roman'
import { latinLine, useCopy, useTone } from '../lib/voice'
import '../styles/board.css'

/**
 * DEPARTMENTS.md §9: the company Board (TasksView re-exports it). With experimental.departments off it renders
 * today's Tasks page unchanged (§0.8). `departmentId` + `embedded`: the department page's board (no toolbar; a card
 * opens on the full Board).
 */
export function BoardView({ departmentId, embedded = false }: { departmentId?: Id; embedded?: boolean } = {}): React.JSX.Element {
  const on = useStore((s) => departmentsOn(s))
  if (!on) return embedded ? <></> : <LegacyTasksView />
  return <Board fixedDepartmentId={departmentId} embedded={embedded} />
}

type Layout = 'kanban' | 'list'
const DONE_SHOWN = 40
/** A board preference remembered across visits (layout, Backlog, Swimlanes). */
function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => loadJson(key, fallback))
  return [v, (next: T) => { setV(next); saveJson(key, next) }]
}

function Board({ fixedDepartmentId, embedded }: { fixedDepartmentId?: Id; embedded: boolean }): React.JSX.Element {
  const { companies, tasks: allTasks, loading, error, reload } = useCompanyData()
  const { scope, chips } = useScope()
  const view = useStore((s) => s.view)
  const allAgents = useStore((s) => s.companyAgents)
  const allDepartments = useStore((s) => s.departments)
  const ctx = useLaneContext()
  const fixedDep = fixedDepartmentId ? allDepartments.find((d) => d.id === fixedDepartmentId) : undefined
  // the department page is its department's company; otherwise the active company (All mode: every company)
  const companyId = fixedDep?.companyId ?? scope
  const company = companyId ? (companies.find((c) => c.id === companyId) ?? null) : null
  const [layout, setLayout] = usePref<Layout>('hive.boardLayout', 'kanban')
  const [showBacklog, setShowBacklog] = usePref('hive.boardBacklog', false)
  const [lanesByDept, setLanesByDept] = usePref('hive.boardSwimlanes', false)
  // the first paint already honours a deep link (no flash of the unfiltered board before the effect below)
  const linked = !embedded && view.name === 'tasks' ? view : null
  const [depFilter, setDepFilter] = useState<Id | null>(fixedDepartmentId ?? linked?.departmentId ?? null)
  const [agentFilter, setAgentFilter] = useState<Id | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(linked?.taskId ?? null)
  const [creating, setCreating] = useState(false)
  const [dragOver, setDragOver] = useState<string | null>(null)
  // LINEAR.md §6: out of sight until wanted (the ⋯ menu); a connected company's cards carry their issue chip
  const linear = useLinear(company?.id ?? null)
  const [linearSheet, setLinearSheet] = useState(false)
  const links = linear.status?.connected ? linear.status.links : null
  // a card or department picked elsewhere (sidebar, Needs you, Home, hub) arrives through the view
  useEffect(() => {
    if (embedded || view.name !== 'tasks') return
    if (view.taskId) setSelected(view.taskId)
    setDepFilter(view.departmentId ?? null)
  }, [view, embedded])
  useEffect(() => { if (fixedDepartmentId) setDepFilter(fixedDepartmentId) }, [fixedDepartmentId])
  const tasks = useMemo(() => (companyId ? allTasks.filter((t) => t.companyId === companyId) : allTasks), [allTasks, companyId])
  // a task or filter of the company we just left no longer applies (a department filter kept on another company
  // would empty the board behind an "All departments" select)
  const lastCompany = useRef(companyId)
  useEffect(() => {
    if (lastCompany.current === companyId) return
    lastCompany.current = companyId
    setSelected((id) => (id && tasks.some((t) => t.id === id) ? id : null)); setAgentFilter(null)
    if (!fixedDepartmentId) setDepFilter((d) => keptDepartmentFilter(d, companyId, allDepartments))
  }, [companyId])
  const filtered = useMemo(() => filterTasks(tasks, { departmentId: depFilter, agentId: agentFilter, search, showBacklog }, ctx), [tasks, depFilter, agentFilter, search, showBacklog, ctx])
  const departments = useMemo(() => (companyId ? departmentsOf(allDepartments, companyId) : allDepartments.filter((d) => !d.archivedAt)), [allDepartments, companyId])
  const seats = useMemo(() => dropSeats(allAgents, companyId, depFilter), [allAgents, companyId, depFilter])
  const depById = useMemo(() => new Map(allDepartments.map((d) => [d.id, d])), [allDepartments])
  // an archived department's board (its page's Board button) keeps its filter visible instead of a blank "All"
  const filterDep = depFilter ? depById.get(depFilter) : undefined
  const agentById = useMemo(() => new Map(allAgents.map((a) => [a.id, a])), [allAgents])
  const open = (t: CompanyTask): void => (embedded ? openBoard(t.companyId, { taskId: t.id }) : setSelected(t.id))

  const perform = async (t: CompanyTask, r: DropResult): Promise<void> => {
    if (!r.ok) { toast(r.reason, 'error'); return }
    if (!r.action) return
    const a: DropAction = r.action
    try {
      if (a.kind === 'assign') { const seat = agentById.get(a.agentId); await hive.tasks.assign({ id: t.id, agentId: a.agentId, ...(a.departmentId ? { departmentId: a.departmentId } : {}) }); toast(`${t.identifier} assigned to ${seat ? agentNameNow(seat).name : 'the agent'}`) }
      else if (a.kind === 'unpark') { await hive.tasks.unpark({ id: t.id }); toast(`Unparked ${t.identifier}`) }
      else await hive.tasks.update({ id: t.id, patch: { status: a.status } })
      reload()
    } catch (e) { toast(errorMessage(e), 'error') } // the card stays where it was: it renders from the store
  }
  const dragged = (e: React.DragEvent): CompanyTask | undefined => tasks.find((t) => t.id === e.dataTransfer.getData(TASK_DRAG_TYPE))
  const dropZone = (key: string, onTask: (t: CompanyTask) => DropResult) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(TASK_DRAG_TYPE)) { e.preventDefault(); if (dragOver !== key) setDragOver(key) } },
    onDragLeave: () => setDragOver((k) => (k === key ? null : k)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragOver(null); const t = dragged(e); if (t) void perform(t, onTask(t)) }
  })
  const card = (t: CompanyTask): React.JSX.Element => {
    const agent = t.agentId ? agentById.get(t.agentId) : undefined
    const depId = taskDepartment(t, ctx)
    return <TaskCard key={t.id} task={t} agent={agent} department={depId ? depById.get(depId) : null} reason={taskReason(t, ctx)} chips={chips && !companyId} selected={selected === t.id} linear={links?.[t.id] ?? null} onOpen={open} />
  }
  const column = (lane: TaskLane, list: CompanyTask[], key: string): React.JSX.Element => {
    const shown = lane === 'done' ? list.slice(0, DONE_SHOWN) : list
    return <section key={key} className={`board-col board-col--${lane} ${dragOver === key ? (lane === 'working' || lane === 'needs_you' ? 'is-refusing' : 'is-over') : ''}`} aria-label={LANE_LABELS[lane]} {...dropZone(key, (t) => laneDrop(t, lane, ctx))}>
      <div className="board-col__head"><h2>{LANE_LABELS[lane]}</h2><span>{list.length}</span></div>
      <div className="board-col__cards">{shown.map(card)}{!list.length && <div className="task-board-empty">{lane === 'working' ? 'Nothing running' : lane === 'needs_you' ? 'Nothing waiting on you' : 'No tasks'}</div>}{list.length > shown.length && <div className="board-muted board-col__more">{list.length - shown.length} older</div>}</div>
    </section>
  }

  // a task in progress only in Linear is not an agent working here
  const counts = useMemo(() => { const c = laneColumns(filtered, ctx); return { working: c.working.filter((t) => !startedInLinear(t, links?.[t.id])).length, needs: c.needs_you.length } }, [filtered, ctx, links])
  // VOICE.md §3.7, §5.8: a board with no tasks at all (the company's, or the department's when embedded) gets the
  // amphora mosaic, one sentence and New task; a filter that hides everything keeps the empty columns
  const nothing = fixedDepartmentId ? !tasks.some((t) => taskDepartment(t, ctx) === fixedDepartmentId) : tasks.length === 0
  const newTask = (): void => (companies.length ? setCreating(true) : openNewCompany())
  // C on the Board opens New task (Linear's key), unless you are typing, a sheet or the palette is open, or a modifier is held
  const newTaskRef = useRef(newTask)
  newTaskRef.current = newTask
  useEffect(() => {
    if (embedded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'c' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.xterm'))) return
      if (document.querySelector('.sheet-layer, .palette-layer, [role=dialog]')) return
      e.preventDefault()
      newTaskRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [embedded])
  // a failed company load shows its error and Retry, not "create your first company" over companies that exist
  const body = loading ? <Loading label="Loading the board…" /> : !companies.length && error ? null : !companies.length ? <CompanyEmpty icon="passport" title="Give your work a company." text="Create a Passport with your business context, then turn ideas, issues and conversations into work your agents can do." action={<Button variant="primary" icon="passport" onClick={openNewCompany}>Create your first company</Button>} /> : nothing ? <BoardEmpty onNew={newTask} /> : layout === 'list' ? <BoardList tasks={filtered} ctx={ctx} depById={depById} agentById={agentById} chips={chips && !companyId} selected={selected} onOpen={open} /> : lanesByDept ? <div className="board-swimlanes">
    {swimlanes(filtered, depFilter ? allDepartments.filter((d) => d.id === depFilter) : departments, ctx).map((s) => <div key={s.department?.id ?? 'none'} className="board-swimlane">
      <div className="board-swimlane__head">{s.department ? <><span className="board-dot" style={{ background: s.department.color ?? 'var(--series-other)' }} />{s.department.name}{chips && !companyId && <CompanyChip companyId={s.department.companyId} />}</> : 'No department'}<span className="board-muted">{s.count}</span></div>
      <div className="board-columns">{BOARD_LANES.map((l) => column(l, s.columns[l], `${s.department?.id ?? 'none'}:${l}`))}</div>
    </div>)}
  </div> : <div className="board-columns">{(() => { const c = laneColumns(filtered, ctx); return BOARD_LANES.map((l) => column(l, c[l], l)) })()}</div>

  const filterBar = <div className="task-filterbar board-filterbar">
    <label className="company-search"><Icon name="search" size={14} /><input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    {!fixedDepartmentId && (departments.length > 0 || !!filterDep) && <select aria-label="Filter by department" value={depFilter ?? ''} onChange={(e) => setDepFilter(e.target.value || null)}><option value="">All departments</option>{departments.map((d) => <option key={d.id} value={d.id}>{!companyId && companies.length > 1 ? `${d.name} · ${companies.find((c) => c.id === d.companyId)?.name ?? ''}` : d.name}</option>)}{filterDep?.archivedAt && <option value={filterDep.id}>{filterDep.name} (archived)</option>}</select>}
    {seats.length > 0 && <div className="board-seats" role="group" aria-label="Agents: click to filter, drop a card to assign">{seats.map((a) => <SeatDrop key={a.id} agent={a} color={a.departmentId ? (depById.get(a.departmentId)?.color ?? null) : null} active={agentFilter === a.id} over={dragOver === `agent:${a.id}`} onClick={() => setAgentFilter((x) => (x === a.id ? null : a.id))} zone={dropZone(`agent:${a.id}`, (t) => agentDrop(t, a))} />)}</div>}
    <span className="flex1" />
    <button type="button" className={`hchip ${showBacklog ? 'is-on' : ''}`} aria-pressed={showBacklog} onClick={() => setShowBacklog(!showBacklog)}>Backlog</button>
    {layout === 'kanban' && <button type="button" className={`hchip ${lanesByDept ? 'is-on' : ''}`} aria-pressed={lanesByDept} onClick={() => setLanesByDept(!lanesByDept)}>Swimlanes</button>}
    <div className="task-layout-toggle" role="group" aria-label="Board layout"><IconButton icon="grid" label="Kanban layout" aria-pressed={layout === 'kanban'} onClick={() => setLayout('kanban')} /><IconButton icon="list" label="List layout" aria-pressed={layout === 'list'} onClick={() => setLayout('list')} /></div>
  </div>

  const linearMenu = async (): Promise<void> => {
    if (!company) return
    const s = linear.status
    const id = await nativeMenu(s?.connected
      ? [
          { id: 'line', label: `${linearLine(s)}${s.team ? ` · ${s.team.key}` : ''}`, enabled: false },
          { id: 'sync', label: 'Sync Now', enabled: !s.syncing },
          { id: 'autosync', label: 'Autosync', type: 'checkbox', checked: s.autosync, enabled: s.state !== 'auth' },
          { type: 'separator' },
          { id: 'reconnect', label: s.state === 'auth' ? 'Reconnect…' : 'Linear Settings…' },
          { id: 'disconnect', label: 'Disconnect…' }
        ]
      : [{ id: 'connect', label: 'Sync with Linear…' }])
    try {
      if (id === 'connect' || id === 'reconnect') setLinearSheet(true)
      else if (id === 'sync') { const r = await hive.linear.sync({ companyId: company.id }); toast(r.state === 'ok' ? `Synced with Linear · ${r.linkedCount} linked` : (r.message ?? 'Linear sync failed'), r.state === 'ok' ? 'info' : 'error'); reload() }
      else if (id === 'autosync') { const r = await hive.linear.setAutosync({ companyId: company.id, on: !s?.autosync }); toast(r.autosync ? 'Autosync on' : 'Autosync off') }
      else if (id === 'disconnect') {
        const ok = await confirmNative({ message: `Disconnect ${company.name} from Linear?`, detail: 'Principia forgets the key and unlinks the tasks. The tasks stay here, and nothing changes in Linear.', confirmLabel: 'Disconnect' }).catch(() => false)
        if (ok) { await hive.linear.disconnect({ companyId: company.id }); toast('Disconnected from Linear') }
      }
    } catch (e) { toast(errorMessage(e), 'error') }
    linear.reload()
  }
  const editor = creating && <TaskEditor board trackerFields={!!links} companies={companies} tasks={tasks} defaultCompanyId={companyId ?? companies[0]?.id} defaultDepartmentId={depFilter} lockCompany={!!companyId} onClose={() => setCreating(false)} onSaved={(task) => { setCreating(false); if (embedded) openBoard(task.companyId, { taskId: task.id }); else { setSelected(task.id); setSearch('') } reload() }} />
  if (embedded) return <div className="board board--embedded">{!nothing && filterBar}{error && <div className="company-error" role="alert">{error}<Button size="sm" onClick={reload}>Retry</Button></div>}<div className="board-main">{body}</div>{editor}</div>
  return <div className="view company-view board">
    <Toolbar title="Board" sub={<span className="company-toolbar-meta">{counts.working} working · {counts.needs} {counts.needs === 1 ? 'needs' : 'need'} you</span>}>
      {company && <AutopilotSwitch key={company.id} company={company} />}
      <Button icon="plus" variant="primary" onClick={newTask}>{companies.length ? 'New task' : 'Create a company'}</Button>
      {company && <IconButton icon="more" label="Board options" title={linear.status?.connected ? linearLine(linear.status) : 'Board options'} onClick={() => void linearMenu()} />}
    </Toolbar>
    <LinearBanner status={linear.status} onReconnect={() => setLinearSheet(true)} />
    {filterBar}
    {error && <div className="company-error" role="alert">{error}<Button size="sm" onClick={reload}>Retry</Button></div>}
    <div className={`task-workspace ${selected ? 'has-detail' : ''}`}>
      <div className="task-main board-main">{body}</div>
      {selected && <TaskInspector key={selected} id={selected} tasks={tasks} companies={companies} linear={links?.[selected] ?? null} onClose={() => setSelected(null)} onSaved={reload} onSelect={setSelected} />}
    </div>
    {editor}
    {linearSheet && company && <LinearSheet companyId={company.id} companyName={company.name} status={linear.status} onClose={() => setLinearSheet(false)} onConnected={() => { linear.reload(); reload() }} />}
  </div>
}

/** VOICE.md §3.7, §5.8: the amphora mosaic, the plain sentence (Latin under it in playful) and one action. */
function BoardEmpty({ onNew }: { onNew: () => void }): React.JSX.Element {
  const copy = useCopy()
  const tone = useTone()
  return <MosaicEmpty motif="amphora" className="board-empty">
    <p className="board-empty__text">{copy('board.empty')}</p>
    <LatinLine pair={latinLine('board.empty', tone)} tone={tone} className="board-empty__latin" />
    <Button variant="primary" icon="plus" onClick={onNew}>{copy('board.empty.cta')}</Button>
  </MosaicEmpty>
}

/** An agent avatar in the filter bar: click filters the board to it, a dropped card is assigned to it. */
function SeatDrop({ agent, color, active, over, onClick, zone }: { agent: CompanyAgent; color: string | null; active: boolean; over: boolean; onClick: () => void; zone: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> }): React.JSX.Element {
  const who = useAgentName(agent)
  return <button type="button" className={`board-seat ${active ? 'is-on' : ''} ${over ? 'is-over' : ''} ${agent.pausedAt ? 'is-paused' : ''}`} aria-pressed={active} aria-label={`${who.role ? `${who.name}, ${who.role}` : who.name}: filter, or drop a card to assign`} title={`${agentLabel(who)}${agent.pausedAt ? ' (paused)' : ''}: click to filter, drop a card to assign`} onClick={onClick} {...zone}>
    <AgentBust agent={agent} color={color} size={22} />
  </button>
}

/** The list view's Agent cell: persona with the role in tertiary, or the role label alone with personas off. */
function AgentCell({ agent }: { agent: CompanyAgent }): React.JSX.Element {
  const who = useAgentName(agent)
  // a long persona or role ellipsizes inside a capped cell (full text on hover) instead of widening the table
  return <span className="board-list__agent" title={who.role ? `${who.name} · ${who.role}` : who.name}><AgentBust agent={agent} size={16} /><span className="board-list__who">{who.name}{who.role && <span className="board-muted"> · {who.role}</span>}</span></span>
}

/**
 * The company's Autopilot switch (default off, §0.6): assignment wakes `auto` agents only with it on. Round-trips
 * through board:autopilot; the pill links to the live hub where the dispatcher's runs show.
 */
function AutopilotSwitch({ company }: { company: CompanyPassport }): React.JSX.Element {
  const [state, setView] = useState<AutopilotView>({ pending: null, busy: false })
  const on = state.pending ?? !!company.autopilot
  const busy = state.busy
  // the company row catches up (data:changed company); drop the optimistic value once it does
  useEffect(() => setView((v) => ({ ...v, pending: null })), [company.autopilot])
  const toggle = useMemo(() => autopilotToggle((q) => hive.board.autopilot(q), company.id, setView), [company.id])
  const flip = (next: boolean): void => {
    void toggle.flip(next).then(
      (s) => { if (!s) return; toast(s.autopilot ? `Autopilot on for ${company.name}: auto agents start assigned work, up to ${s.maxInFlight} at once` : `Autopilot off for ${company.name}`); void refreshCompanies().catch(() => undefined) },
      (e: unknown) => toast(errorMessage(e), 'error')
    )
  }
  // A4: a paused company starts nothing, so its switch reads "Off while paused" and is greyed out (as in the company menu)
  if (company.pausedAt) return <div className="board-autopilot is-held" title={`Resume ${company.name} to turn Autopilot on`}>
    <label className="board-autopilot__label"><span>Autopilot: off while paused</span><Switch checked={false} onChange={() => undefined} disabled label={`Autopilot for ${company.name}: off while paused`} /></label>
  </div>
  return <div className="board-autopilot">
    {on && <button type="button" className="board-autopilot__pill" onClick={() => void navigate({ name: 'agents' })} title="See what the agents are doing"><Pill tone="running">Autopilot on</Pill></button>}
    <label className="board-autopilot__label"><span>Autopilot</span><Switch checked={on} onChange={flip} disabled={busy} label={`Autopilot for ${company.name}`} /></label>
  </div>
}

/** List view: id, title, department, agent, lane/reason, priority, source, updated. */
function BoardList({ tasks, ctx, depById, agentById, chips, selected, onOpen }: { tasks: CompanyTask[]; ctx: LaneContext; depById: Map<Id, Department>; agentById: Map<Id, CompanyAgent>; chips: boolean; selected: string | null; onOpen: (t: CompanyTask) => void }): React.JSX.Element {
  const rows = useMemo(() => { const c = laneColumns(tasks, ctx); return BOARD_LANES.flatMap((l) => c[l]) }, [tasks, ctx])
  if (!rows.length) return <CompanyEmpty icon="tasks" title="No tasks in this view." text="Try another filter or create a new task." />
  return <table className="board-list">
    <thead><tr><th>ID</th><th>Title</th><th>Department</th><th>Agent</th><th>Lane</th><th>Priority</th><th>Source</th><th>Updated</th></tr></thead>
    <tbody>{rows.map((t) => { const depId = taskDepartment(t, ctx); const d = depId ? depById.get(depId) : undefined; const a = t.agentId ? agentById.get(t.agentId) : undefined; return <tr key={t.id} className={selected === t.id ? 'is-selected' : ''} onClick={() => onOpen(t)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(t)} aria-label={`${t.identifier}: ${t.title}`}>
      <td className="task-identifier">{chips && <CompanyChip companyId={t.companyId} avatarOnly size={14} />} {t.identifier}</td>
      <td className="board-list__title">{t.title}</td>
      <td>{d ? <><span className="board-dot" style={{ background: d.color ?? 'var(--series-other)' }} />{d.name}</> : <span className="board-muted">—</span>}</td>
      <td>{a ? <AgentCell agent={a} /> : <span className="board-muted">Unassigned</span>}</td>
      <td>{laneText(t, ctx)}</td>
      <td><TaskPriority priority={t.priority} /></td>
      <td><TaskSourceBadge source={t.source} compact /></td>
      <td className="board-muted">{relative(t.updatedAt)}</td>
    </tr> })}</tbody>
  </table>
}

// ---------- departments off: today's Tasks page, unchanged ----------

type Filter = 'all' | 'active' | 'review' | 'completed'
/**
 * Company tasks, as before departments (§0.8: the flag off renders exactly this). COMPANY.md §8.4: the focused
 * company's tasks only; All mode lists every company's with a chip.
 */
function LegacyTasksView(): React.JSX.Element {
  const { companies, tasks: allTasks, loading, error, reload } = useCompanyData()
  const { scope, chips } = useScope()
  const tasks = useMemo(() => (scope ? allTasks.filter((t) => t.companyId === scope) : allTasks), [allTasks, scope])
  const profiles = useStore((s) => s.profiles)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<TaskSource | ''>('')
  const [filter, setFilter] = useState<Filter>('active')
  const [board, setBoard] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // a task of the company we just left is no longer listed
  useEffect(() => setSelected((id) => (id && tasks.some((t) => t.id === id) ? id : null)), [scope])
  const filtered = useMemo(() => tasks.filter((t) => (!source || t.source === source) && (!search || `${t.identifier} ${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase())) && (filter === 'all' || filter === 'active' && !['done', 'canceled'].includes(t.status) || filter === 'review' && t.status === 'in_review' || filter === 'completed' && ['done', 'canceled'].includes(t.status))), [tasks, source, search, filter])
  const groups = TASK_STATUSES.map((status) => ({ status, items: filtered.filter((t) => t.status === status) })).filter((g) => g.items.length || board && ['todo', 'in_progress', 'in_review', 'done'].includes(g.status))
  const active = tasks.filter((t) => !['done', 'canceled'].includes(t.status)).length
  return <div className="view company-view">
    <Toolbar title="Board" sub={<span className="company-toolbar-meta">{active} open</span>}>
      <Button icon="plus" variant="primary" onClick={() => companies.length ? setCreating(true) : openNewCompany()}>{companies.length ? 'New task' : 'Create a company'}</Button>
    </Toolbar>
    <div className="task-filterbar">
      <div className="company-tabs" role="group" aria-label="Task view">{(['active', 'all', 'review', 'completed'] as Filter[]).map((f) => <button key={f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)} aria-pressed={filter === f}>{f === 'active' ? 'Open' : f === 'all' ? 'All tasks' : f === 'review' ? 'In review' : 'Completed'}{f === 'review' && tasks.some((t) => t.status === 'in_review') && <span>{tasks.filter((t) => t.status === 'in_review').length}</span>}</button>)}</div>
      <label className="company-search"><Icon name="search" size={14} /><input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <select aria-label="Filter by source" value={source} onChange={(e) => setSource(e.target.value as TaskSource | '')}><option value="">All sources</option>{TASK_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select>
      <div className="task-layout-toggle" role="group" aria-label="Task layout"><IconButton icon="list" label="List layout" aria-pressed={!board} onClick={() => setBoard(false)} /><IconButton icon="grid" label="Board layout" aria-pressed={board} onClick={() => setBoard(true)} /></div>
    </div>
    {error && <div className="company-error" role="alert">{error}<Button size="sm" onClick={reload}>Retry</Button></div>}
    <div className={`task-workspace ${selected ? 'has-detail' : ''}`}>
      <div className="task-main">
        {loading ? <Loading label="Loading company work…" /> : !companies.length ? <CompanyEmpty icon="passport" title="Give your work a company." text="Create a Passport with your business context, then turn ideas, issues and conversations into work your agents can do." action={<Button variant="primary" icon="passport" onClick={openNewCompany}>Create your first company</Button>} /> : !filtered.length && !board ? <CompanyEmpty icon="tasks" title={tasks.length ? 'No tasks in this view.' : 'A clear place for every next step.'} text={tasks.length ? 'Try another filter or create a new task.' : 'Create a task or capture a link from GitHub, Slack, Sentry or PostHog. Choose when an agent starts; review its work before calling it done.'} action={<Button icon="plus" onClick={() => setCreating(true)}>New task</Button>} /> : <div className={board ? 'task-board' : 'task-list'}>
          {groups.map(({ status, items }) => <section className="task-group" key={status} aria-label={STATUS_LABEL[status]}>
            <div className="task-group-heading"><TaskStatusIcon status={status} /><h2>{STATUS_LABEL[status]}</h2><span>{items.length}</span></div>
            {items.map((task) => <button key={task.id} className={`task-row ${selected === task.id ? 'is-selected' : ''}`} onClick={() => setSelected(task.id)} aria-label={`${task.identifier}: ${task.title}, ${STATUS_LABEL[task.status]}`}>
              <TaskPriority priority={task.priority} /><span className="task-identifier">{task.identifier}</span><span className="task-row-title">{task.title}</span>
              {chips && <span className="task-row-company"><CompanyChip companyId={task.companyId} /></span>}<TaskSourceBadge source={task.source} />
              <span className="task-assignee" title={profiles.find((p) => p.id === task.assigneeProfileId)?.name ?? 'Unassigned'}>{task.assigneeProfileId ? <Icon name="agents" size={14} /> : <span className="task-unassigned">○</span>}</span>
              <span className="task-row-time">{relative(task.updatedAt)}</span>
            </button>)}
            {board && !items.length && <div className="task-board-empty">No tasks</div>}
          </section>)}
        </div>}
        {!loading && companies.length > 0 && <div className="task-source-note"><Icon name="link" size={12} /> Source links keep the trail. Tasks are captured manually; automatic source syncing is not connected.</div>}
      </div>
      {selected && <LegacyTaskInspector key={selected} id={selected} tasks={tasks} companies={companies} onClose={() => setSelected(null)} onSaved={reload} />}
    </div>
    {creating && <TaskEditor companies={companies} tasks={tasks} defaultCompanyId={scope ?? companies[0]?.id} lockCompany={!!scope} onClose={() => setCreating(false)} onSaved={(task) => { setCreating(false); setSelected(task.id); setFilter('all'); setSource(''); setSearch(''); reload() }} />}
  </div>
}

function CompanyEmpty({ icon, title, text, action }: { icon: string; title: string; text: string; action?: React.ReactNode }): React.JSX.Element {
  return <div className="company-empty"><div className="company-empty-icon"><Icon name={icon} size={25} /></div><h2>{title}</h2><p>{text}</p>{action}</div>
}

function LegacyTaskInspector({ id, tasks, companies, onClose, onSaved }: { id: string; tasks: CompanyTask[]; companies: CompanyPassport[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [editing, setEditing] = useState(false)
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)
  const repos = useStore((s) => s.repos)
  const [profileId, setProfileId] = useState('')
  const version = tasks.find((t) => t.id === id)?.updatedAt
  const request = useRef(0)
  const load = (): void => { const n = ++request.current; void hive.tasks.get({ id }).then((d) => { if (request.current === n) { setDetail(d); setError(null) } }, (e: unknown) => { if (request.current === n) setError(errorMessage(e)) }) }
  useEffect(() => { load(); return () => { request.current++ } }, [id, version])
  useHiveEvent('data:changed', ({ domain }) => { if (domain === 'tasks') load() })
  const mutate = async (fn: () => Promise<unknown>): Promise<void> => { setBusy(true); setError(null); try { await fn(); load(); onSaved() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) } }
  const task = detail?.task
  const activeProfiles = profiles.filter((p) => p.adapter !== 'shell' && providers.some((v) => v.id === p.adapter && v.available))
  const unresolved = task?.dependencyIds.map((dep) => tasks.find((t) => t.id === dep)).filter((t) => t && t.status !== 'done') ?? []
  const runDisabledReason = task?.status === 'in_progress' ? 'This task already has an agent working on it.' : task?.status === 'done' || task?.status === 'canceled' ? 'Move this task to Todo before running it again.' : !task?.repoId ? 'Choose a project in Edit task before starting an agent.' : unresolved.length ? 'Finish this task’s dependencies before starting.' : !activeProfiles.length ? 'Connect an agent harness in Settings → Agents first.' : ''
  return <aside className="task-inspector" aria-label="Task details">
    <header className="task-inspector-top"><span>{task?.identifier ?? 'Task details'}</span><div><IconButton icon="edit" label="Edit task" disabled={!task || busy || task.status === 'in_progress'} title={task?.status === 'in_progress' ? 'Stop the agent run before editing' : 'Edit task'} onClick={() => setEditing(true)} /><IconButton icon="close" label="Close task details" onClick={onClose} /></div></header>
    {error && <div className="company-error" role="alert">{error}</div>}
    {!task ? <Loading label="Loading task…" /> : <div className="task-inspector-scroll">
      <div className="task-detail-company"><Icon name="passport" size={12} />{companies.find((c) => c.id === task.companyId)?.name}</div>
      <h2>{task.title}</h2><p className="task-description selectable">{task.description || 'No description yet. Add the outcome and acceptance criteria in Edit task.'}</p>
      <div className="task-properties">
        <label><span>Status</span><div><TaskStatusIcon status={task.status} /><select aria-label="Task status" disabled={busy || task.status === 'in_progress'} value={task.status} onChange={(e) => void mutate(() => hive.tasks.update({ id, patch: { status: e.target.value as TaskStatus } }))}>{TASK_STATUSES.filter((s) => s !== 'in_progress' || task.status === 'in_progress').map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></div></label>
        <label><span>Priority</span><div><TaskPriority priority={task.priority} /><select aria-label="Task priority" value={task.priority} disabled={busy || task.status === 'in_progress'} onChange={(e) => void mutate(() => hive.tasks.update({ id, patch: { priority: Number(e.target.value) as CompanyTaskInput['priority'] } }))}>{PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></div></label>
        <div><span>Project</span><span>{repos.find((r) => r.id === task.repoId)?.name ?? 'Not assigned'}</span></div>
        <div><span>Source</span>{task.sourceUrl ? <button className="task-source-link" onClick={() => void hive.app.openExternal({ url: task.sourceUrl! }).catch((e) => setError(errorMessage(e)))}><TaskSourceBadge source={task.source} /><Icon name="external" size={12} /></button> : <TaskSourceBadge source={task.source} />}</div>
        {task.externalId && <div><span>Source ID</span><span className="selectable">{task.externalId}</span></div>}
        {task.parentId && <div><span>Parent</span><span>{tasks.find((t) => t.id === task.parentId)?.identifier ?? task.parentId}</span></div>}
      </div>
      {!!task.dependencyIds.length && <section className="task-detail-section"><h3>Depends on</h3>{task.dependencyIds.map((dep) => { const d = tasks.find((t) => t.id === dep); return <div key={dep} className="task-dependency">{d && <TaskStatusIcon status={d.status} />}<span>{d?.identifier}</span><span>{d?.title ?? 'Task unavailable'}</span></div> })}</section>}
      <section className="task-agent-panel"><div className="task-agent-heading"><Icon name="agents" size={16} /><h3>Agent execution</h3>{task.status === 'in_progress' && <span className="task-live-dot" />}</div>
        <p>{task.status === 'in_progress' ? 'An agent is working on this task. Follow its run for output and approvals.' : task.status === 'in_review' ? 'The agent finished its run. Review the result, then mark the task Done.' : 'Start when you’re ready. The agent receives this task and its company Passport.'}</p>
        {task.status !== 'in_progress' && <><select aria-label="Agent for task" value={profileId || task.assigneeProfileId || ''} disabled={busy} onChange={(e) => setProfileId(e.target.value)}><option value="">Default available agent</option>{activeProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><Button icon="play" variant="primary" disabled={busy || !!runDisabledReason} title={runDisabledReason} onClick={() => void mutate(() => hive.tasks.start({ id, profileId: profileId || task.assigneeProfileId || activeProfiles[0]?.id }))}>{busy ? 'Starting…' : task.runId ? 'Run again' : 'Run agent'}</Button>{runDisabledReason && <small>{runDisabledReason}</small>}</>}
        {task.runId && <Button icon="external" onClick={() => void navigate({ name: 'run', runId: task.runId! })}>Open agent run</Button>}
      </section>
      <section className="task-detail-section task-activity"><h3>Activity</h3>{detail.activity.map((a) => <div key={a.id} className="task-activity-item"><span className="task-activity-dot" /><div><p className="selectable">{a.message}</p><time dateTime={a.createdAt}>{relative(a.createdAt)}</time></div></div>)}
        <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void mutate(async () => { await hive.tasks.comment({ id, message: comment.trim() }); setComment('') }) }}><textarea aria-label="Add task comment" placeholder="Add a note or decision…" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={8000} /><Button type="submit" disabled={busy || !comment.trim()}>Add comment</Button></form>
      </section>
    </div>}
    {editing && task && <TaskEditor task={task} companies={companies} tasks={tasks} defaultCompanyId={task.companyId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onSaved() }} />}
  </aside>
}
