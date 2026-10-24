/**
 * DEPARTMENTS.md §9 department page: dashboards (DASHBOARDS.md §9), charter (does / does not), passport section (open the vault note, or edit the
 * fallback until the vault ships), agent seats with "Add agent", recurring agents (attach schedules and Slack
 * triggers), routing defaults (sources, Slack channels) and the board filtered to this department.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  AGENT_DATA_DEFAULTS,
  AGENT_LIMITS,
  DEPARTMENT_LIMITS,
  LANE_LABELS,
  TASK_LANES,
  type AgentAutonomy,
  type CompanyAgentKind,
  type Department,
  type TaskSource
} from '@shared/company'
import type { Id } from '@shared/types'
import type { SlackChannel } from '@shared/slack'
import { Button, EmptyState, IconButton, Pill, Segmented, Sheet, Stepper, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { errorMessage, hive } from '../lib/hive'
import { agentsOf, charterLength, departmentNotePath, recurringOf, seatState, taskDepartment, taskLane, type RecurringItem } from '../lib/departments'
import { SOURCE_LABEL } from '../lib/company'
import { AgentBust, DepartmentIcon, agentNameNow, useAgentName, useLaneContext, useRecurringSources } from '../shell/DepartmentGroup'
import { MosaicEmpty } from '../components/roman'
import { DepartmentDashboards } from '../components/dashboards/DepartmentDashboards'
import { t, toneOf, useCopy, usePersonasOn } from '../lib/voice'
import {
  attempt,
  companyName,
  departmentById,
  departmentContextMenu,
  getState,
  navigate,
  openAgentSeat,
  openBoard,
  openDepartmentPassport,
  refreshDepartments,
  setDepartmentPaused,
  toast,
  useStore
} from '../state/store'
import '../styles/departments.css'

/** D10's board, embedded filtered to this department when it exists (the App.tsx lateViews pattern). */
const lateBoard = import.meta.glob(['./BoardView.tsx'], { eager: true })
const BoardView = lateBoard['./BoardView.tsx']?.BoardView as ((p: { departmentId?: Id; embedded?: boolean }) => React.JSX.Element) | undefined

/** Sources a department can claim by default (§2 step 3); manual, agent and schedule tasks never route by source. */
const ROUTABLE_SOURCES: TaskSource[] = ['github', 'sentry', 'posthog', 'slack']
/** cool accents only (VOICE.md §5: no orange, amber or brown) */
const COLORS = ['var(--accent)', 'var(--series-2)', 'var(--status-success)', 'var(--status-scheduled)', 'var(--status-idle)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']

export function DepartmentView({ id, focus, nonce }: { id: Id; focus?: 'charter' | 'agents' | 'dashboards'; nonce?: number }): React.JSX.Element {
  const dep = useStore((s) => departmentById(id, s))
  const allAgents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const ctx = useLaneContext()
  const [adding, setAdding] = useState(false)
  const copy = useCopy()
  useEffect(() => {
    if (!focus) return
    // deep link from the sidebar menu ("Edit charter…"): bring the section into view
    requestAnimationFrame(() => document.getElementById(`dep-${focus}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }, [focus, nonce])
  if (!dep)
    return (
      <div className="view">
        <Toolbar title="Department" />
        <EmptyState icon="agents" text="This department is gone or still loading." />
      </div>
    )
  const seats = agentsOf(allAgents, dep.companyId, dep.id)
  const allPaused = seats.length > 0 && seats.every((a) => !!a.pausedAt)
  // a task counts where the sidebar counts it: its department, else its seat's (taskDepartment)
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled' && taskDepartment(t, ctx) === dep.id).length
  return (
    <div className="view dep-view">
      <Toolbar
        title={
          <span className="dep-title">
            <DepartmentIcon department={dep} size={16} />
            {dep.name}
            {dep.archivedAt && <Pill tone="warning">archived</Pill>}
          </span>
        }
        sub={<span className="company-toolbar-meta">{companyName(dep.companyId)} · {open} open task{open === 1 ? '' : 's'}</span>}
      >
        <Button icon="tasks" onClick={() => openBoard(dep.companyId, { departmentId: dep.id })}>
          Board
        </Button>
        <Button icon={allPaused ? 'play' : 'pause'} disabled={!seats.length} onClick={() => void setDepartmentPaused(dep.id, !allPaused)}>
          {allPaused ? 'Resume agents' : 'Pause agents'}
        </Button>
        <IconButton icon="more" label="More" onClick={() => void departmentContextMenu(dep)} />
      </Toolbar>
      <div className="dep-page">
        {/* DASHBOARDS.md §9: installed and recommended dashboards first, the numbers this department watches */}
        <DepartmentDashboards key={`d:${dep.id}`} dep={dep} />
        {/* each editor resets only when its own saved fields change, so saving one card never drops edits in another */}
        <CharterCard key={`c:${dep.id}:${JSON.stringify([dep.name, dep.color, dep.data.charter])}`} dep={dep} />
        <PassportCard key={`p:${dep.id}:${dep.data.contextFallback}`} dep={dep} />
        <section className="dep-card" id="dep-agents" aria-label="Agents">
          <header className="dep-card__head">
            <h2>Agents</h2>
            <span className="dep-card__count">{seats.length}</span>
            <span className="flex1" />
            <Button size="sm" icon="plus" variant="primary" disabled={!!dep.archivedAt} onClick={() => setAdding(true)}>
              Add agent
            </Button>
          </header>
          {seats.length === 0 ? (
            <MosaicEmpty motif="column" width={112} className="dep-empty">
              <p className="dep-empty__text">{copy('dept.empty.agents', { dept: dep.name })}</p>
              <p className="dep-card__empty">Add one from a profile (Claude, Codex…) or a workflow. Tasks routed here wait in Needs you until an agent can take them.</p>
              {!dep.archivedAt && (
                <Button size="sm" icon="plus" variant="primary" onClick={() => setAdding(true)}>
                  {copy('dept.add.cta')}
                </Button>
              )}
            </MosaicEmpty>
          ) : (
            <div className="dep-seats">
              {seats.map((a) => (
                <SeatCard key={a.id} agentId={a.id} color={dep.color} />
              ))}
            </div>
          )}
        </section>
        <RecurringCard dep={dep} />
        <RoutingCard key={`r:${dep.id}:${JSON.stringify([dep.data.sourceDefaults, dep.data.slackChannels])}`} dep={dep} />
        <section className="dep-card dep-card--board" aria-label="Board">
          <header className="dep-card__head">
            <h2>Board</h2>
            <span className="flex1" />
            <Button size="sm" icon="external" onClick={() => openBoard(dep.companyId, { departmentId: dep.id })}>
              Open board
            </Button>
          </header>
          {BoardView ? <BoardView departmentId={dep.id} embedded /> : <DepartmentTasks dep={dep} />}
        </section>
      </div>
      {adding && <AddAgentSheet dep={dep} onClose={() => setAdding(false)} />}
    </div>
  )
}

/** Shared save path: departments:save with only the named fields (main keeps the rest). */
async function saveDepartment(dep: Department, patch: { name?: string; color?: string | null; data?: Parameters<typeof hive.departments.save>[0]['data'] }, what: string): Promise<boolean> {
  const res = await attempt(() => hive.departments.save({ id: dep.id, companyId: dep.companyId, name: patch.name ?? dep.name, ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.data ? { data: patch.data } : {}) }), what)
  if (!res) return false
  await refreshDepartments()
  toast(`${what}: saved`)
  return true
}

function CharterCard({ dep }: { dep: Department }): React.JSX.Element {
  const [name, setName] = useState(dep.name)
  const [color, setColor] = useState(dep.color)
  const [does, setDoes] = useState(dep.data.charter.does)
  const [doesNot, setDoesNot] = useState(dep.data.charter.doesNot)
  const [busy, setBusy] = useState(false)
  const used = charterLength({ does, doesNot })
  const over = used > DEPARTMENT_LIMITS.charter
  const dirty = name.trim() !== dep.name || color !== dep.color || does !== dep.data.charter.does || doesNot !== dep.data.charter.doesNot
  const save = async (): Promise<void> => {
    setBusy(true)
    await saveDepartment(dep, { name: name.trim(), color, data: { charter: { does, doesNot } } }, 'Charter')
    setBusy(false)
  }
  return (
    <section className="dep-card" id="dep-charter" aria-label="Charter">
      <header className="dep-card__head">
        <h2>Charter</h2>
        <span className="dep-card__hint">Routing reads this to decide which tasks belong here.</span>
      </header>
      <div className="dep-form">
        <label className="dep-field">
          <span>Name</span>
          <input className="input" value={name} maxLength={DEPARTMENT_LIMITS.name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="dep-field">
          <span>Colour</span>
          <div className="dep-swatches" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} className={`dep-swatch ${c === color ? 'is-sel' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <label className="dep-field dep-field--top">
          <span>Does</span>
          <textarea className="input dep-textarea" rows={3} value={does} placeholder="What this department takes on" onChange={(e) => setDoes(e.target.value)} />
        </label>
        <label className="dep-field dep-field--top">
          <span>Does not</span>
          <textarea className="input dep-textarea" rows={2} value={doesNot} placeholder="What it never does without you" onChange={(e) => setDoesNot(e.target.value)} />
        </label>
        <div className="dep-form__foot">
          <span className={`dep-counter ${over ? 'is-over' : ''}`}>
            {used}/{DEPARTMENT_LIMITS.charter}
          </span>
          <Button size="sm" variant="primary" disabled={busy || !dirty || over || !name.trim()} onClick={() => void save()}>
            Save charter
          </Button>
        </div>
      </div>
    </section>
  )
}

function PassportCard({ dep }: { dep: Department }): React.JSX.Element {
  const vault = useStore((s) => !!s.settings?.experimental?.vault)
  const [text, setText] = useState(dep.data.contextFallback)
  const [busy, setBusy] = useState(false)
  const over = text.length > DEPARTMENT_LIMITS.contextFallback
  return (
    <section className="dep-card" aria-label="Passport section">
      <header className="dep-card__head">
        <h2>Passport section</h2>
        <span className="dep-card__hint">Every run in {dep.name} gets this after the company card. Agents still read the whole company passport.</span>
      </header>
      {vault ? (
        <div className="dep-passport">
          <Icon name="passport" size={14} />
          <span className="dep-passport__path selectable">{departmentNotePath(dep)}</span>
          <span className="flex1" />
          <Button size="sm" icon="external" onClick={() => openDepartmentPassport(dep)}>
            Open note
          </Button>
        </div>
      ) : (
        <div className="dep-form">
          <textarea className="input dep-textarea" rows={4} value={text} placeholder={`Context every ${dep.name} agent should know: tone, tools, accounts, recurring decisions…`} onChange={(e) => setText(e.target.value)} />
          <div className="dep-form__foot">
            <span className={`dep-counter ${over ? 'is-over' : ''}`}>
              {text.length}/{DEPARTMENT_LIMITS.contextFallback}
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || over || text === dep.data.contextFallback}
              onClick={() => {
                setBusy(true)
                void saveDepartment(dep, { data: { contextFallback: text } }, 'Passport section').finally(() => setBusy(false))
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function SeatCard({ agentId, color }: { agentId: Id; color: string | null }): React.JSX.Element | null {
  const agent = useStore((s) => s.companyAgents.find((a) => a.id === agentId))
  const tasks = useStore((s) => s.tasks)
  const profiles = useStore((s) => s.profiles)
  const ctx = useLaneContext()
  const who = useAgentName(agent)
  if (!agent) return null
  const st = seatState(agent, tasks, ctx.openRuns)
  const backing = agent.kind === 'profile' ? (profiles.find((p) => p.id === agent.refId)?.name ?? 'Profile removed') : 'Workflow'
  return (
    <button type="button" className={`dep-seat seat-row--${st.kind}`} onClick={() => openAgentSeat(agent)} aria-label={`${who.role ? `${who.name}, ${who.role}` : who.name}, ${st.label}`}>
      <AgentBust agent={agent} color={color} size={28} />
      <span className="dep-seat__main">
        <span className="dep-seat__name">
          {who.name}
          {who.role && <span className="dep-seat__role"> · {who.role}</span>}
        </span>
        {who.persona?.personality && <span className="dep-seat__personality">{who.persona.personality}</span>}
        <span className="dep-seat__meta">
          {backing}
          {agent.data.capabilities ? ` · ${agent.data.capabilities}` : ''}
        </span>
      </span>
      {agent.data.autonomy === 'auto' && <Pill tone="accent" title="Assignment wakes this agent when the company's Autopilot is on">auto</Pill>}
      <span className={`seat-row__state seat-row__state--${st.kind}`}>{st.label}</span>
    </button>
  )
}

/** §8: schedules and Slack triggers join here; workflows show where their department was set. */
function RecurringCard({ dep }: { dep: Department }): React.JSX.Element {
  const src = useRecurringSources(dep.companyId)
  const items = recurringOf(dep.id, src)
  const [busy, setBusy] = useState(false)
  const attachable = [
    // only rows stamped with this company: an unstamped (legacy) schedule must never join another company's department
    ...src.schedules.filter((s) => s.companyId === dep.companyId && s.departmentId !== dep.id).map((s) => ({ key: `schedule:${s.id}`, label: `Schedule · ${s.name}` })),
    ...src.triggers.filter((t) => t.departmentId !== dep.id).map((t) => ({ key: `trigger:${t.id}`, label: `Slack trigger · ${t.name}` }))
  ]
  /** departmentId null detaches. Updates send the full input back with only the department changed. */
  const setDepartment = async (kind: 'schedule' | 'trigger', itemId: Id, departmentId: Id | null): Promise<void> => {
    setBusy(true)
    try {
      if (kind === 'schedule') {
        const s = src.schedules.find((x) => x.id === itemId)
        if (!s) return
        await hive.schedules.update({ id: s.id, input: { name: s.name, target: s.target, when: s.when, preset: s.preset, enabled: s.enabled, departmentId } })
      } else {
        const t = src.triggers.find((x) => x.id === itemId)
        if (!t) return
        await hive.slackTriggers.update({ id: t.id, input: { name: t.name, workflowId: t.workflowId, enabled: t.enabled, match: t.match, reply: t.reply, limits: t.limits, inputs: t.inputs, access: t.access, action: t.action, departmentId } })
      }
      src.reload()
      toast(departmentId ? `Attached to ${dep.name}` : `Detached from ${dep.name}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const open = (r: RecurringItem): void => {
    if (r.kind === 'workflow') void navigate({ name: 'editor', workflowId: r.id, nonce: Date.now() })
    else if (r.kind === 'schedule') void navigate({ name: 'schedules', selectedId: r.id, nonce: Date.now() })
    else void navigate({ name: 'schedules', tab: 'slack', nonce: Date.now() })
  }
  return (
    <section className="dep-card" aria-label="Recurring agents">
      <header className="dep-card__head">
        <h2>Recurring agents</h2>
        <span className="dep-card__hint">Schedules and Slack triggers here feed this department’s board.</span>
        <span className="flex1" />
        {attachable.length > 0 && (
          <select
            className="input input--sm dep-attach"
            aria-label="Attach a schedule or Slack trigger"
            value=""
            disabled={busy}
            onChange={(e) => {
              const [kind, itemId] = e.target.value.split(':') as ['schedule' | 'trigger', Id]
              if (itemId) void setDepartment(kind, itemId, dep.id)
            }}
          >
            <option value="">Attach…</option>
            {attachable.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </header>
      {items.length === 0 ? (
        <p className="dep-card__empty">Nothing recurring yet. Attach a schedule or a Slack trigger so its work lands on this board.</p>
      ) : (
        <div className="dep-list">
          {items.map((r) => (
            <div key={`${r.kind}:${r.id}`} className={`dep-list__row ${r.enabled ? '' : 'is-off'}`}>
              <Icon name={r.kind === 'workflow' ? 'workflows' : r.kind === 'schedule' ? 'schedules' : 'slack'} size={14} />
              <button type="button" className="dep-list__name" onClick={() => open(r)}>
                {r.name}
              </button>
              <span className="dep-list__meta">{r.kind === 'workflow' ? 'workflow' : r.kind === 'schedule' ? 'schedule' : 'Slack trigger'}{r.enabled ? '' : ' · off'}</span>
              {r.kind !== 'workflow' && <IconButton icon="close" label={`Detach ${r.name}`} disabled={busy} onClick={() => void setDepartment(r.kind as 'schedule' | 'trigger', r.id, null)} />}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function RoutingCard({ dep }: { dep: Department }): React.JSX.Element {
  const [sources, setSources] = useState<TaskSource[]>(dep.data.sourceDefaults)
  const [channels, setChannels] = useState<string[]>(dep.data.slackChannels)
  const [known, setKnown] = useState<SlackChannel[] | null>(null)
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    // Slack is optional: without it, channels are typed as ids
    void hive.slack.channels().then((l) => setKnown(l.filter((c) => (c.kind === 'channel' || c.kind === 'private') && !c.isArchived)), () => setKnown(null))
  }, [])
  const label = (cid: string): string => {
    const c = known?.find((x) => x.id === cid)
    return c ? `#${c.name}` : cid
  }
  const addChannel = (cid: string): void => {
    const v = cid.trim()
    if (!v || channels.includes(v) || channels.length >= DEPARTMENT_LIMITS.slackChannels) return
    setChannels([...channels, v])
  }
  const dirty = sources.join() !== dep.data.sourceDefaults.join() || channels.join() !== dep.data.slackChannels.join()
  return (
    <section className="dep-card" aria-label="Routing defaults">
      <header className="dep-card__head">
        <h2>Routing defaults</h2>
        <span className="dep-card__hint">A task with no department lands here when it comes from one of these.</span>
      </header>
      <div className="dep-form">
        <div className="dep-field">
          <span>Sources</span>
          <div className="dep-checks">
            {ROUTABLE_SOURCES.map((s) => (
              <label key={s} className="dep-check">
                <input type="checkbox" checked={sources.includes(s)} onChange={(e) => setSources(e.target.checked ? [...sources, s] : sources.filter((x) => x !== s))} />
                {SOURCE_LABEL[s] ?? s}
              </label>
            ))}
          </div>
        </div>
        <div className="dep-field dep-field--top">
          <span>Slack channels</span>
          <div className="dep-channels">
            {channels.map((c) => (
              <span key={c} className="dep-chip is-static">
                {label(c)}
                <button type="button" className="dep-chip__x" aria-label={`Remove ${label(c)}`} onClick={() => setChannels(channels.filter((x) => x !== c))}>
                  <Icon name="close" size={8} />
                </button>
              </span>
            ))}
            {known ? (
              <select className="input input--sm dep-attach" aria-label="Add a Slack channel" value="" onChange={(e) => addChannel(e.target.value)}>
                <option value="">Add channel…</option>
                {known
                  .filter((c) => !channels.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
              </select>
            ) : (
              <form
                className="dep-add__custom"
                onSubmit={(e) => {
                  e.preventDefault()
                  addChannel(manual)
                  setManual('')
                }}
              >
                <input className="input input--sm" placeholder="Channel id (C…)" aria-label="Slack channel id" value={manual} onChange={(e) => setManual(e.target.value)} />
                <button type="submit" className="btn btn--secondary btn--sm" disabled={!manual.trim()}>
                  Add
                </button>
              </form>
            )}
          </div>
        </div>
        <div className="dep-form__foot">
          <span className="flex1" />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !dirty}
            onClick={() => {
              setBusy(true)
              void saveDepartment(dep, { data: { sourceDefaults: sources, slackChannels: channels } }, 'Routing').finally(() => setBusy(false))
            }}
          >
            Save routing
          </Button>
        </div>
      </div>
    </section>
  )
}

/** Fallback until BoardView lands: this department's open tasks by lane; a click opens the card on the Board. */
function DepartmentTasks({ dep }: { dep: Department }): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const ctx = useLaneContext()
  const mine = useMemo(() => tasks.filter((t) => taskDepartment(t, ctx) === dep.id), [tasks, ctx, dep.id])
  if (!mine.length) return <p className="dep-card__empty">No tasks in {dep.name} yet.</p>
  return (
    <div className="dep-lanes">
      {TASK_LANES.filter((l) => l !== 'done').map((lane) => {
        const items = mine.filter((t) => taskLane(t, ctx) === lane)
        if (!items.length) return null
        return (
          <div key={lane} className={`dep-lane dep-lane--${lane}`}>
            <div className="dep-lane__head">
              {LANE_LABELS[lane]} <span>{items.length}</span>
            </div>
            {items.map((t) => (
              <button key={t.id} type="button" className="dep-list__row dep-task" onClick={() => openBoard(t.companyId, { taskId: t.id, departmentId: dep.id })}>
                <span className="dep-task__id">{t.identifier}</span>
                <span className="dep-list__name">{t.title}</span>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** "Add agent": a profile or a workflow behind it, then name, instructions, capabilities, autonomy and limits. */
function AddAgentSheet({ dep, onClose }: { dep: Department; onClose: () => void }): React.JSX.Element {
  const allProfiles = useStore((s) => s.profiles)
  const profiles = useMemo(() => allProfiles.filter((p) => p.adapter !== 'shell'), [allProfiles])
  const { workflows } = useRecurringSources(dep.companyId)
  const [kind, setKind] = useState<CompanyAgentKind>('profile')
  const [refId, setRefId] = useState('')
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [autonomy, setAutonomy] = useState<AgentAutonomy>(AGENT_DATA_DEFAULTS.autonomy)
  const [runMinutes, setRunMinutes] = useState(AGENT_DATA_DEFAULTS.limits.runMinutes)
  const [wakes, setWakes] = useState(AGENT_DATA_DEFAULTS.limits.autoWakesPerHour)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const personas = usePersonasOn()
  const refs = kind === 'profile' ? profiles.map((p) => ({ id: p.id, name: p.name })) : workflows.map((w) => ({ id: w.id, name: w.name }))
  const valid = !!refId && !!name.trim() && instructions.length <= AGENT_LIMITS.instructions && capabilities.length <= AGENT_LIMITS.capabilities
  const save = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const a = await hive.companyAgents.save({ companyId: dep.companyId, departmentId: dep.id, kind, refId, name: name.trim(), data: { instructions, capabilities, autonomy, limits: { runMinutes, autoWakesPerHour: wakes } } })
      await refreshDepartments()
      // VOICE.md §3.7: main assigned the persona (WP2); with personas off the role label is the name
      const who = agentNameNow(a)
      toast(who.persona ? t('dept.add.joined', { persona: who.name, dept: dep.name, role: a.name }, toneOf(getState().settings)) : `Added ${a.name} to ${dep.name}`)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={`Add an agent to ${dep.name}`} onCancel={() => !busy && onClose()} onPrimary={() => void save()} primaryLabel={busy ? 'Adding…' : 'Add agent'} primaryDisabled={!valid || busy} width={560}>
      <div className="dep-form">
        {error && (
          <div className="company-error" role="alert">
            {error}
          </div>
        )}
        <div className="dep-field">
          <span>Runs on</span>
          <Segmented
            size="sm"
            items={[
              { value: 'profile', label: 'Profile' },
              { value: 'workflow', label: 'Workflow' }
            ]}
            value={kind}
            onChange={(k) => {
              setKind(k)
              setRefId('')
            }}
          />
        </div>
        <label className="dep-field">
          <span>{kind === 'profile' ? 'Profile' : 'Workflow'}</span>
          <select
            className="input"
            value={refId}
            onChange={(e) => {
              setRefId(e.target.value)
              if (!name.trim()) setName(refs.find((r) => r.id === e.target.value)?.name ?? '')
            }}
          >
            <option value="">{refs.length ? 'Choose…' : kind === 'profile' ? 'No profiles yet (Settings › Agents)' : 'No workflows in this company'}</option>
            {refs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="dep-field">
          <span>{personas ? 'Role' : 'Name'}</span>
          <span className="dep-field__col">
            <input className="input" placeholder="Copywriter, Bug fixer…" maxLength={AGENT_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
            {personas && <span className="dep-field__hint">They also get a name and a bust, which you can change on their page.</span>}
          </span>
        </label>
        <label className="dep-field dep-field--top">
          <span>Instructions</span>
          <span className="dep-field__col">
            <textarea className="input dep-textarea" rows={5} placeholder="Prepended to every task this agent takes." value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            <span className={`dep-counter ${instructions.length > AGENT_LIMITS.instructions ? 'is-over' : ''}`}>
              {instructions.length}/{AGENT_LIMITS.instructions}
            </span>
          </span>
        </label>
        <label className="dep-field dep-field--top">
          <span>Capabilities</span>
          <span className="dep-field__col">
            <textarea className="input dep-textarea" rows={2} placeholder="Does / does not, in a sentence. Routing reads this." value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />
            <span className={`dep-counter ${capabilities.length > AGENT_LIMITS.capabilities ? 'is-over' : ''}`}>
              {capabilities.length}/{AGENT_LIMITS.capabilities}
            </span>
          </span>
        </label>
        <div className="dep-field">
          <span>Autonomy</span>
          <span className="dep-field__col">
            <Segmented
              size="sm"
              items={[
                { value: 'manual', label: 'Manual' },
                { value: 'auto', label: 'Auto' }
              ]}
              value={autonomy}
              onChange={setAutonomy}
            />
            <span className="dep-field__hint">{autonomy === 'auto' ? 'Starts on assignment, but only while the company’s Autopilot is on.' : 'Waits for you to click Run on each task.'}</span>
          </span>
        </div>
        <div className="dep-field">
          <span>Limits</span>
          <span className="dep-limits">
            <Stepper value={runMinutes} min={AGENT_LIMITS.runMinutes.min} max={AGENT_LIMITS.runMinutes.max} onChange={setRunMinutes} label="Minutes per run" />
            <span>min per run</span>
            <Stepper value={wakes} min={AGENT_LIMITS.autoWakesPerHour.min} max={AGENT_LIMITS.autoWakesPerHour.max} onChange={setWakes} width={52} label="Automatic wakes per hour" />
            <span>auto wakes / hour</span>
          </span>
        </div>
      </div>
    </Sheet>
  )
}
