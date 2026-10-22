/**
 * DEPARTMENTS.md §9 sidebar. Focused mode: a Departments section (above Repositories) with one row per department
 * (icon, name, amber needs-you count, blue working dot), expanding to its agent seats and, muted, its recurring
 * workflows, schedules and triggers. All mode: per company a Board row, then department rows folded until something
 * needs you. Every count is `laneOf` through lib/departments. Nothing here renders unless experimental.departments.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { DEPARTMENT_PRESETS, type CompanyAgent, type Department, type DepartmentPresetKey } from '@shared/company'
import type { Id, Schedule, Workflow } from '@shared/types'
import type { SlackTrigger } from '@shared/slack'
import { Icon } from '../components/Icon'
import { IconButton } from '../components/ui'
import { Bust } from '../components/roman'
import { displayName, personasOf, resolvePersonas, storedPersona, type DisplayName } from '../lib/personaView'
import { personasOn, usePersonasOn } from '../lib/voice'
import { hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { nextGroupPeek } from '../lib/companyModel'
import { needsYouTasks } from '../lib/board'
import {
  agentsOf,
  boardCounts,
  departmentCounts,
  departmentsOf,
  inCompany,
  laneContext,
  recurringOf,
  seatInitials,
  seatState,
  type LaneContext,
  type LaneCounts,
  type RecurringItem
} from '../lib/departments'
import {
  archiveCompanyAgent,
  attempt,
  createDepartmentPresets,
  departmentContextMenu,
  departmentsOn,
  getState,
  loadJson,
  navigate,
  openAgentSeat,
  openBoard,
  openDepartment,
  refreshDepartments,
  saveJson,
  setAgentPaused,
  toast,
  useStore
} from '../state/store'
import '../styles/departments.css'

/**
 * D10's Needs-you task items (reviews, asks answerable inline, parked with reason, unassigned), picked up when the
 * file exists (the App.tsx lateViews pattern). Contract: renders its own block and returns null when nothing waits.
 */
const lateBoard = import.meta.glob(['../components/board/NeedsYouTasks.tsx'], { eager: true })
const NeedsYouTasks = lateBoard['../components/board/NeedsYouTasks.tsx']?.NeedsYouTasks as ((p: { companyId?: Id; limit?: number; playfulTop?: boolean }) => React.JSX.Element | null) | undefined

/**
 * `heading`: focused mode has no Needs you section of its own, so the task items bring one (with their count).
 * The sidebar sits beside Home and the Portfolio, which carry the screen's one playful "Ave!" (VOICE.md §3.6), so its
 * rows always read plain.
 */
export function NeedsYouTasksSlot({ heading = false, ...props }: { companyId?: Id; limit?: number; heading?: boolean }): React.JSX.Element | null {
  const on = useStore((s) => departmentsOn(s))
  const count = useNeedsYouTaskCount(props.companyId)
  if (!on || !NeedsYouTasks || !count) return null
  return (
    <>
      {heading && (
        <div className="sidebar__section sidebar__section--needs">
          <span>Needs you</span>
          <span className="side-row__badge side-row__badge--needs">⚑ {count}</span>
        </div>
      )}
      <NeedsYouTasks {...props} playfulTop={false} />
    </>
  )
}

/**
 * How many task items the Needs you block lists (the same `needsYouTasks` call, so header and rows agree). Every
 * company (no `companyId`) skips running tasks waiting on a live ask: All mode lists those as live ask rows.
 */
export function useNeedsYouTaskCount(companyId?: Id): number {
  const on = useStore((s) => departmentsOn(s))
  const tasks = useStore((s) => s.tasks)
  const ctx = useLaneContext()
  return useMemo(() => (on ? needsYouTasks(tasks, ctx, companyId, { skipLiveAsks: !companyId }).length : 0), [on, tasks, ctx, companyId])
}

/** Lane context from the store's asks and seats; recomputed only when they change. */
export function useLaneContext(): LaneContext {
  const asks = useStore((s) => s.asks)
  const agents = useStore((s) => s.companyAgents)
  return useMemo(() => laneContext(asks, agents), [asks, agents])
}

/** Per-company Board counts (All-mode Board rows, CompanyGroup auto-expand). Empty while departments are off. */
export function useBoardCounts(): Record<Id, LaneCounts> {
  const on = useStore((s) => departmentsOn(s))
  const tasks = useStore((s) => s.tasks)
  const companies = useStore((s) => s.companies)
  const ctx = useLaneContext()
  return useMemo(() => {
    if (!on) return {}
    return Object.fromEntries(companies.map((c) => [c.id, boardCounts(tasks, c.id, ctx)]))
  }, [on, tasks, companies, ctx])
}

/** Workflows, schedules and Slack triggers (one company, or every company); refetched when they change. */
export function useRecurringSources(companyId: Id | undefined): { workflows: Workflow[]; schedules: Schedule[]; triggers: SlackTrigger[]; reload: () => void } {
  const on = useStore((s) => departmentsOn(s))
  const [src, setSrc] = useState<{ workflows: Workflow[]; schedules: Schedule[]; triggers: SlackTrigger[] }>({ workflows: [], schedules: [], triggers: [] })
  const seq = useRef(0)
  const load = (): void => {
    if (!on) return
    const n = ++seq.current
    const q = companyId ? { companyId } : undefined
    // each source is optional: Slack may not be set up, and a failed list only hides its rows
    void Promise.all([hive.workflows.list(q).catch(() => []), hive.schedules.list(q).catch(() => []), hive.slackTriggers.list(q).catch(() => [])]).then(([workflows, schedules, triggers]) => {
      if (n !== seq.current) return
      // a department only ever attaches its own company's rows, whatever the list returned
      setSrc(companyId ? { workflows: inCompany(workflows, companyId), schedules: inCompany(schedules, companyId), triggers: inCompany(triggers, companyId) } : { workflows, schedules, triggers })
    })
  }
  useEffect(load, [on, companyId])
  useHiveEvent('data:changed', ({ domain }) => {
    if (domain === 'workflows' || domain === 'schedules' || domain === 'departments') load()
  })
  useHiveEvent('schedule:updated', (s) => setSrc((x) => ({ ...x, schedules: x.schedules.map((y) => (y.id === s.id ? s : y)) })))
  return { ...src, reload: load }
}

const EXPANDED_KEY = 'hive.expandedDepartments'
function useExpandedDepartments(): [Record<Id, boolean>, (id: Id, open: boolean) => void] {
  const [expanded, setExpanded] = useState<Record<Id, boolean>>(() => loadJson(EXPANDED_KEY, {}))
  const set = (id: Id, open: boolean): void =>
    setExpanded((m) => {
      const next = { ...m, [id]: open }
      saveJson(EXPANDED_KEY, next)
      return next
    })
  return [expanded, set]
}

/** Focused mode: the Departments section of one company. */
export function DepartmentGroup({ companyId, companyName }: { companyId: Id; companyName: string }): React.JSX.Element | null {
  const on = useStore((s) => departmentsOn(s))
  const allDepartments = useStore((s) => s.departments)
  const allAgents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const view = useStore((s) => s.view)
  const ctx = useLaneContext()
  const recurring = useRecurringSources(on ? companyId : undefined)
  const [expanded, setExpanded] = useExpandedDepartments()
  const [adding, setAdding] = useState(false)
  const departments = useMemo(() => departmentsOf(allDepartments, companyId), [allDepartments, companyId])
  const counts = useMemo(() => departmentCounts(tasks, ctx), [tasks, ctx])
  const companySeats = useMemo(() => agentsOf(allAgents, companyId, null), [allAgents, companyId])
  if (!on) return null
  return (
    <>
      <div className="sidebar__section">
        <span>Departments</span>
        <span className="sidebar__section-actions">
          <IconButton icon="plus" label={`Add a department to ${companyName}`} aria-expanded={adding} onClick={() => setAdding((a) => !a)} />
        </span>
      </div>
      <div className="sidebar__departments">
        {adding && <AddDepartment companyId={companyId} existing={departments} onDone={() => setAdding(false)} />}
        {departments.length === 0 && !adding && (
          <div className="side-row side-row--session is-dim" role="button" tabIndex={0} onClick={() => setAdding(true)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setAdding(true))} title="Group agents by what they do: Development, Marketing, Support…">
            <Icon name="agents" size={14} />
            <span className="side-row__label">Add departments</span>
          </div>
        )}
        {departments.map((d) => (
          <DepartmentRow
            key={d.id}
            department={d}
            counts={counts[d.id]}
            seats={agentsOf(allAgents, companyId, d.id)}
            recurring={recurringOf(d.id, recurring)}
            open={!!expanded[d.id]}
            onToggle={(open) => setExpanded(d.id, open)}
            selected={view.name === 'department' && view.id === d.id}
            selectedSeat={view.name === 'agentSeat' ? view.id : null}
          />
        ))}
        {companySeats.length > 0 && (
          <>
            <div className="dep-sub">Company agents</div>
            {companySeats.map((a) => (
              <SeatRow key={a.id} agent={a} color={null} indent={false} selected={view.name === 'agentSeat' && view.id === a.id} />
            ))}
          </>
        )}
      </div>
    </>
  )
}

/** "+" panel: the six preset chips (one click adds all six), single chips, or a custom name. */
function AddDepartment({ companyId, existing, onDone }: { companyId: Id; existing: Department[]; onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const have = new Set(existing.map((d) => d.key))
  const missing = DEPARTMENT_PRESETS.filter((p) => !have.has(p.key))
  const add = async (keys?: DepartmentPresetKey[]): Promise<void> => {
    if (busy) return
    setBusy(true)
    const res = await createDepartmentPresets(companyId, keys)
    setBusy(false)
    if (res && !keys) onDone()
  }
  const addCustom = async (): Promise<void> => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    const dep = await attempt(() => hive.departments.save({ companyId, name: n }), 'Add department')
    setBusy(false)
    if (!dep) return
    await refreshDepartments()
    toast(`Added ${dep.name}`)
    setName('')
    onDone()
    openDepartment(dep, 'charter')
  }
  return (
    <div className="dep-add" role="group" aria-label="Add departments">
      <div className="dep-add__chips">
        {DEPARTMENT_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`dep-chip ${have.has(p.key) ? 'is-done' : ''}`}
            disabled={busy || have.has(p.key)}
            title={have.has(p.key) ? `${p.name} already exists` : `${p.data.charter.does}\nDoes not: ${p.data.charter.doesNot}`}
            onClick={() => void add([p.key])}
          >
            <span className="dep-chip__dot" style={{ background: p.color }} />
            {p.name}
            {have.has(p.key) && <Icon name="check" size={10} />}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn--primary btn--sm dep-add__all" disabled={busy || missing.length === 0} onClick={() => void add()}>
        {missing.length === DEPARTMENT_PRESETS.length ? 'Add all six' : missing.length === 0 ? 'All presets added' : `Add the other ${missing.length}`}
      </button>
      <form
        className="dep-add__custom"
        onSubmit={(e) => {
          e.preventDefault()
          void addCustom()
        }}
      >
        <input className="input input--sm" placeholder="Or name your own…" aria-label="Department name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} />
        <button type="submit" className="btn btn--secondary btn--sm" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>
      <div className="dep-add__hint">Each comes with a sample charter you can edit. Agents join from the department page.</div>
    </div>
  )
}

/** Needs-you count in amber, else a blue dot while something works. */
function LaneBadge({ counts }: { counts: LaneCounts | undefined }): React.JSX.Element | null {
  if (!counts) return null
  if (counts.needsYou > 0)
    return (
      <span className="side-row__badge side-row__badge--needs" title={`${counts.needsYou} task${counts.needsYou === 1 ? '' : 's'} need${counts.needsYou === 1 ? 's' : ''} you`}>
        ⚑ {counts.needsYou}
      </span>
    )
  if (counts.working > 0)
    return (
      <span className="glyph glyph--running status-dot--running" title={`${counts.working} working`}>
        ●
      </span>
    )
  return null
}

export function DepartmentIcon({ department, size = 14 }: { department: Pick<Department, 'icon' | 'color'>; size?: number }): React.JSX.Element {
  return (
    <span className="dep-icon" style={{ color: department.color ?? 'var(--text-secondary)' }} aria-hidden>
      <Icon name={department.icon || 'agents'} size={size} />
    </span>
  )
}

function DepartmentRow({
  department: d,
  counts,
  seats,
  recurring,
  open,
  onToggle,
  selected,
  selectedSeat,
  inGroup = false
}: {
  department: Department
  counts: LaneCounts | undefined
  seats: CompanyAgent[]
  recurring: RecurringItem[]
  open: boolean
  onToggle: (open: boolean) => void
  selected: boolean
  selectedSeat: Id | null
  /** inside an All-mode company group (deeper indent) */
  inGroup?: boolean
}): React.JSX.Element {
  const hasChildren = seats.length > 0 || recurring.length > 0
  return (
    <div className="dep-row-wrap">
      <div
        className={`side-row dep-row ${inGroup ? 'dep-row--group' : ''} ${selected ? 'is-selected' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={hasChildren ? open : undefined}
        title={`${d.name}${d.data.charter.does ? `\n${d.data.charter.does}` : ''}\nRight-click for Pause, charter, passport, Archive`}
        onClick={() => openDepartment(d)}
        onContextMenu={(e) => {
          e.preventDefault()
          void departmentContextMenu(d)
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openDepartment(d)
          } else if (e.key === 'ArrowRight' && hasChildren) onToggle(true)
          else if (e.key === 'ArrowLeft' && hasChildren) onToggle(false)
        }}
      >
        <button
          type="button"
          className="side-row__twisty"
          tabIndex={-1}
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(!open)
          }}
        >
          {hasChildren && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
        </button>
        <DepartmentIcon department={d} />
        <span className="side-row__label">{d.name}</span>
        <LaneBadge counts={counts} />
      </div>
      {open &&
        seats.map((a) => <SeatRow key={a.id} agent={a} color={d.color} indent selected={selectedSeat === a.id} inGroup={inGroup} />)}
      {open &&
        recurring.map((r) => (
          <div
            key={`${r.kind}:${r.id}`}
            className={`side-row side-row--session side-row--indent dep-recurring ${inGroup ? 'dep-row--group' : ''} ${r.enabled ? '' : 'is-off'}`}
            role="button"
            tabIndex={0}
            title={`${r.kind === 'workflow' ? 'Workflow' : r.kind === 'schedule' ? 'Schedule' : 'Slack trigger'} in ${d.name}${r.enabled ? '' : ' (off)'}`}
            onClick={() => openRecurring(r)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openRecurring(r))}
          >
            <Icon name={r.kind === 'workflow' ? 'workflows' : r.kind === 'schedule' ? 'schedules' : 'slack'} size={12} />
            <span className="side-row__label">{r.name}</span>
          </div>
        ))}
    </div>
  )
}

function openRecurring(r: RecurringItem): void {
  if (r.kind === 'workflow') void navigate({ name: 'editor', workflowId: r.id, nonce: Date.now() })
  else if (r.kind === 'schedule') void navigate({ name: 'schedules', selectedId: r.id, nonce: Date.now() })
  else void navigate({ name: 'schedules', tab: 'slack', nonce: Date.now() })
}

export function SeatAvatar({ name, color, size = 16 }: { name: string; color: string | null; size?: number }): React.JSX.Element {
  return (
    <span className="seat-avatar" style={{ width: size, height: size, background: color ?? 'var(--series-other)', fontSize: Math.max(8, Math.round(size * 0.45)) }} aria-hidden>
      {seatInitials(name)}
    </span>
  )
}

type PersonaAgent = Pick<CompanyAgent, 'id' | 'companyId' | 'departmentId' | 'name' | 'archivedAt' | 'createdAt'> & { data?: unknown }

/**
 * VOICE.md §4.4: who an agent is on screen. With personas on: the persona (stored, else the display-only one
 * resolvePersonas gives legacy agents) and the role label beside it; with them off (Settings → Agent names and busts),
 * just the role label, as before. An agent not in the store yet (a stale prop) still resolves on its own.
 */
export function useAgentName(agent: PersonaAgent | null | undefined): DisplayName {
  const on = usePersonasOn()
  const personas = useStore((s) => personasOf(s))
  const departments = useStore((s) => s.departments)
  return useMemo(() => {
    if (!agent) return { name: '', role: '', persona: null }
    if (!on || personas.has(agent.id)) return displayName(agent, personas, on)
    const own = storedPersona(agent) ?? resolvePersonas([agent], departments).get(agent.id)
    return displayName(agent, own ? new Map([[agent.id, own]]) : personas, on)
  }, [agent, on, personas, departments])
}

/** useAgentName outside render (toasts, menus): the same answer from the current store snapshot. */
export function agentNameNow(agent: PersonaAgent): DisplayName {
  const s = getState()
  const on = personasOn(s.settings)
  const personas = personasOf(s)
  if (!on || personas.has(agent.id)) return displayName(agent, personas, on)
  const own = storedPersona(agent) ?? resolvePersonas([agent], s.departments).get(agent.id)
  return displayName(agent, own ? new Map([[agent.id, own]]) : personas, on)
}

/** "{persona} · {role}" with personas on, the role label alone with them off (tooltips, accessible names). */
export const agentLabel = (n: DisplayName): string => (n.role ? `${n.name} · ${n.role}` : n.name)

/**
 * The agent's face: its Bust with personas on, the department-colour initial (SeatAvatar) with them off. Decorative;
 * the visible name sits next to it. Below 22 px the Bust drops to its mini tier (no face strokes). List avatars
 * (28 px and under: sidebar, board cards, department seats) get the faint --rm-ln-3 ring (VOICE.md §5.4); the agent
 * page's 64 px hero draws without it. `ring` overrides the size rule.
 */
export const LIST_AVATAR_MAX = 28
export function AgentBust({ agent, size = 16, color = null, className, ring }: { agent: PersonaAgent; size?: number; color?: string | null; className?: string; ring?: boolean }): React.JSX.Element {
  const n = useAgentName(agent)
  if (!n.persona) return <SeatAvatar name={agent.name} color={color} size={size} />
  return (
    <span className={['agent-bust', className].filter(Boolean).join(' ')} style={{ width: size, height: size }} aria-hidden>
      <Bust look={n.persona.look} size={size} ring={ring ?? size <= LIST_AVATAR_MAX} />
    </span>
  )
}

function SeatRow({ agent, color, indent, selected, inGroup = false }: { agent: CompanyAgent; color: string | null; indent: boolean; selected: boolean; inGroup?: boolean }): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const st = useMemo(() => seatState(agent, tasks, laneContext(asks, []).openRuns), [agent, tasks, asks])
  const n = useAgentName(agent)
  return (
    <div
      className={`side-row side-row--session seat-row ${indent ? 'side-row--indent' : ''} ${inGroup ? 'dep-row--group' : ''} ${selected ? 'is-selected' : ''} seat-row--${st.kind}`}
      role="button"
      tabIndex={0}
      title={`${agentLabel(n)} · ${st.label}${agent.data.autonomy === 'auto' ? ' · auto' : ''}`}
      aria-label={`${n.role ? `${n.name}, ${n.role}` : n.name}, ${st.label}`}
      onClick={() => openAgentSeat(agent)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openAgentSeat(agent))}
      onContextMenu={(e) => {
        e.preventDefault()
        void seatContextMenu(agent, n.name)
      }}
    >
      <AgentBust agent={agent} color={color} size={16} />
      <span className="side-row__label seat-row__label">
        <span className="seat-row__name">{n.name}</span>
        {n.role && <span className="seat-row__role">{n.role}</span>}
      </span>
      <span className={`seat-row__state seat-row__state--${st.kind}`}>{st.label}</span>
    </div>
  )
}

async function seatContextMenu(agent: CompanyAgent, shown = agent.name): Promise<void> {
  const id = await nativeMenu([
    { id: 'open', label: `Open ${shown}` },
    agent.pausedAt ? { id: 'resume', label: 'Resume' } : { id: 'pause', label: 'Pause' },
    { type: 'separator' },
    { id: 'archive', label: 'Archive…' }
  ])
  if (id === 'open') openAgentSeat(agent)
  if (id === 'pause' || id === 'resume') void setAgentPaused(agent, id === 'pause')
  if (id === 'archive') void archiveCompanyAgent(agent)
}

/** All mode, inside a company group: the Board row, then its departments folded until something needs you. */
export function CompanyDepartments({ companyId, board }: { companyId: Id; board: LaneCounts | undefined }): React.JSX.Element | null {
  const on = useStore((s) => departmentsOn(s))
  const allDepartments = useStore((s) => s.departments)
  const allAgents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const view = useStore((s) => s.view)
  const ctx = useLaneContext()
  const departments = useMemo(() => departmentsOf(allDepartments, companyId), [allDepartments, companyId])
  const counts = useMemo(() => departmentCounts(tasks, ctx), [tasks, ctx])
  if (!on) return null
  return (
    <>
      <div
        className="side-row side-row--session side-row--indent dep-board-row"
        role="button"
        tabIndex={0}
        title="The company’s task board"
        onClick={() => openBoard(companyId)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openBoard(companyId))}
      >
        <Icon name="tasks" size={14} />
        <span className="side-row__label">Board</span>
        <LaneBadge counts={board} />
      </div>
      {departments.map((d) => (
        <GroupDepartmentRow key={d.id} department={d} counts={counts[d.id]} seats={agentsOf(allAgents, companyId, d.id)} selected={view.name === 'department' && view.id === d.id} selectedSeat={view.name === 'agentSeat' ? view.id : null} />
      ))}
    </>
  )
}

/** Folded by default; a new needs-you count opens it, and folding it again holds until the count rises (nextGroupPeek). */
function GroupDepartmentRow({ department, counts, seats, selected, selectedSeat }: { department: Department; counts: LaneCounts | undefined; seats: CompanyAgent[]; selected: boolean; selectedSeat: Id | null }): React.JSX.Element {
  const needs = counts?.needsYou ?? 0
  const [open, setOpen] = useState(needs > 0)
  const prev = useRef(needs)
  useEffect(() => {
    setOpen((o) => nextGroupPeek(o, prev.current, needs))
    prev.current = needs
  }, [needs])
  return <DepartmentRow department={department} counts={counts} seats={seats} recurring={[]} open={open} onToggle={setOpen} selected={selected} selectedSeat={selectedSeat} inGroup />
}
