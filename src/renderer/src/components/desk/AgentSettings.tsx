/**
 * The agent's settings and records, shown in its right panel (AgentPanel): Instructions (persona, About, what it is
 * told, how it runs, where it runs, Archive), Run history, and the AI tool it works with (Runs on).
 * Moved out of the agent page when the page became the shared agent conversation (AGENT CHAT part 2).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_LIMITS, type AgentAutonomy, type AgentMode, type CompanyAgent, type CompanyTask } from '@shared/company'
import { LANE_WORD } from '../../lib/board'
import type { Id, Run } from '@shared/types'
import { Button, Disclosure, Pill, RelativeTime, Segmented, Stepper } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { taskLane, taskReason } from '../../lib/departments'
import { AgentBust, useAgentName, useLaneContext } from '../../shell/DepartmentGroup'
import { autonomyPhrase } from '../../lib/desk'
import { personasOf } from '../../lib/personaView'
import { editedPersona, personaNameError, personasToFreeze } from '../../lib/personaRename'
import { useCopy, usePersonasOn } from '../../lib/voice'
import { PERSONA_LIMITS, type AgentPersona } from '@shared/personas'
import { archiveCompanyAgent, attempt, departmentById, getState, navigate, openDepartment, refreshDepartments, toast, useStore } from '../../state/store'
import '../../styles/departments.css'

/** Chip text for a Needs-you task (§1.5 reasons). */
const REASON_LABEL: Record<string, string> = {
  review: 'review',
  live_ask: 'asking',
  unassigned: 'unassigned',
  deps: 'waiting on deps',
  needs_input: 'question for you',
  run_failed: 'run failed',
  interrupted: 'interrupted',
  no_report: 'no report',
  limit: 'hit a limit',
  agent: 'agent blocked',
  handoff_cap: 'handoff cap',
  manual: 'parked',
  blocked: 'blocked'
}

const RUN_TONE: Record<string, 'passed' | 'failed' | 'running' | 'canceled' | 'idle'> = { passed: 'passed', failed: 'failed', running: 'running', queued: 'idle', canceled: 'canceled' }

/**
 * Which AI tool this agent works with (Claude, Codex, …): switching keeps its role, instructions, persona and history;
 * only the next turn runs on the new tool. Tools that are not installed are listed but cannot be picked.
 */
export function RunsOnPicker({ agent }: { agent: CompanyAgent }): React.JSX.Element {
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)
  const [busy, setBusy] = useState(false)
  const choices = profiles.filter((p) => p.adapter !== 'shell')
  const current = choices.find((p) => p.id === agent.refId)
  const installed = (adapter: string): boolean => providers.find((x) => x.id === adapter)?.available !== false
  const pick = async (refId: string): Promise<void> => {
    const next = choices.find((p) => p.id === refId)
    if (!next || refId === agent.refId) return
    setBusy(true)
    const ok = await attempt(() => hive.companyAgents.save({ id: agent.id, companyId: agent.companyId, departmentId: agent.departmentId, kind: agent.kind, refId, name: agent.name, data: {} }), 'Change AI tool')
    setBusy(false)
    if (ok) {
      await refreshDepartments()
      toast(`${agent.name} now works with ${next.name}. Its role, instructions and history stay.`)
    }
  }
  return (
    <select className="input input--sm" aria-label="AI tool this agent works with" value={current?.id ?? ''} disabled={busy} onChange={(e) => void pick(e.target.value)}>
      {!current && <option value="">Pick an AI tool</option>}
      {choices.map((p) => (
        <option key={p.id} value={p.id} disabled={!installed(p.adapter)}>
          {p.name}
          {p.model ? ` · ${p.model}` : ''}
          {installed(p.adapter) ? '' : ' (not installed)'}
        </option>
      ))}
    </select>
  )
}

export const LANE_WORDS: Record<string, string> = { inbox: 'To do', queued: 'To do', working: 'Working', needs_you: 'Needs you', done: 'Done' }

/** Instructions tab: who it is (persona, About), what it is told, how it runs (Advanced), where it runs, Archive. */
export function Instructions({ agent, dep }: { agent: CompanyAgent; dep: ReturnType<typeof departmentById> }): React.JSX.Element {
  const who = useAgentName(agent)
  return (
    <div className="desk-instructions">
      {who.persona && <PersonaHeader key={`${agent.id}:${who.persona.name}:${who.persona.bio}`} agent={agent} persona={who.persona} color={dep?.color ?? null} />}
      {/* reset only when the saved settings change: Pause/Resume also bumps updatedAt and must not drop unsaved edits */}
      <SeatSettings key={`${agent.id}:${JSON.stringify([agent.name, { ...agent.data, persona: undefined }])}`} agent={agent} department={dep?.name ?? null} />
      <section className="dep-card" aria-label="Runs on">
        <header className="dep-card__head">
          <h2>Runs on</h2>
        </header>
        <div className="dep-passport">
          <Icon name={agent.kind === 'profile' ? 'agents' : 'workflows'} size={14} />
          {agent.kind === 'profile' ? <RunsOnPicker agent={agent} /> : <span>Workflow</span>}
          <span className="flex1" />
          {agent.kind === 'profile' ? (
            <Button size="sm" icon="external" onClick={() => void navigate({ name: 'settings', section: 'agents' })}>
              AI providers
            </Button>
          ) : (
            <Button size="sm" icon="external" onClick={() => void navigate({ name: 'editor', workflowId: agent.refId, nonce: Date.now() })}>
              Open workflow
            </Button>
          )}
        </div>
      </section>
      {!agent.archivedAt && (
        <section className="dep-card" aria-label="Archive">
          <header className="dep-card__head">
            <h2>Archive</h2>
          </header>
          <p className="dep-card__empty">Archiving takes {who.name} off the team. Finished tasks and history stay; queued tasks wait for another agent.</p>
          <div className="dep-form__foot">
            <span className="flex1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void archiveCompanyAgent(agent).then((ok) => {
                  if (!ok) return
                  if (dep) openDepartment(dep)
                  else void navigate({ name: 'team' })
                })
              }
            >
              Archive {who.name}…
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

/** Runs of the seat's tasks, newest first. Outcome = the run's status plus where it left the task. */
export function RunHistory({ agent, tasks, code = true }: { agent: CompanyAgent; tasks: CompanyTask[]; code?: boolean }): React.JSX.Element {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ctx = useLaneContext()
  const byRun = useMemo(() => {
    const m = new Map<Id, CompanyTask>()
    for (const t of tasks) if (t.agentId === agent.id && t.runId) m.set(t.runId, t)
    return m
  }, [tasks, agent.id])
  // a slower answer for the seat we just left never lands on this one
  const seq = useRef(0)
  const load = (): void => {
    const n = ++seq.current
    void hive.runs.list({ companyId: agent.companyId, limit: 200 }).then(
      (list) => {
        if (n !== seq.current) return
        // runs.agent_id (D4) when main sends it, else the seat's tasks' run links
        setRuns(list.filter((r) => r.agentId === agent.id || byRun.has(r.id)))
        setError(null)
      },
      (e: unknown) => n === seq.current && setError(errorMessage(e))
    )
  }
  // another seat starts from "Loading…", not from the previous seat's history
  useEffect(() => {
    setRuns(null)
    setError(null)
  }, [agent.id])
  // refetch when the seat's set of runs changes, not on every task refresh
  const runKey = useMemo(() => [...byRun.keys()].sort().join(), [byRun])
  useEffect(load, [agent.id, agent.companyId, runKey])
  useHiveEvent('run:updated', (r) => {
    if (byRun.has(r.id) || r.agentId === agent.id) setRuns((list) => (list ? (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list]) : list))
  })
  return (
    <section className="dep-card" aria-label="Run history">
      <header className="dep-card__head">
        <h2>Run history</h2>
        {runs && <span className="dep-card__count">{runs.length}</span>}
      </header>
      {error ? (
        <p className="dep-card__empty">{error}</p>
      ) : !runs ? (
        <p className="dep-card__empty">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="dep-card__empty">No runs yet.</p>
      ) : (
        <div className="dep-list">
          {runs.slice(0, 30).map((r) => {
            const t = byRun.get(r.id)
            const reason = t ? taskReason(t, ctx) : null
            return (
              <button key={r.id} type="button" className="dep-list__row dep-task" onClick={() => void navigate({ name: 'run', runId: r.id })}>
                {code && <span className="dep-task__id">{t?.identifier ?? '—'}</span>}
                <span className="dep-list__name">{t?.title ?? r.title}</span>
                <Pill tone={RUN_TONE[r.status] ?? 'idle'}>{r.status}</Pill>
                {t && <span className="dep-list__meta">{reason ? (REASON_LABEL[reason] ?? reason) : LANE_WORD[taskLane(t, ctx)]}</span>}
                <span className="dep-list__meta">
                  <RelativeTime iso={r.startedAt ?? r.createdAt} />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SeatSettings({ agent, department = null }: { agent: CompanyAgent; department?: string | null }): React.JSX.Element {
  const [name, setName] = useState(agent.name)
  const [instructions, setInstructions] = useState(agent.data.instructions)
  const [capabilities, setCapabilities] = useState(agent.data.capabilities)
  const [autonomy, setAutonomy] = useState<AgentAutonomy>(agent.data.autonomy)
  const [mode, setMode] = useState<AgentMode>(agent.data.mode)
  const [runMinutes, setRunMinutes] = useState(agent.data.limits.runMinutes)
  const [wakes, setWakes] = useState(agent.data.limits.autoWakesPerHour)
  const [busy, setBusy] = useState(false)
  const personas = usePersonasOn()
  const d = agent.data
  const dirty = name.trim() !== agent.name || instructions !== d.instructions || capabilities !== d.capabilities || autonomy !== d.autonomy || mode !== d.mode || runMinutes !== d.limits.runMinutes || wakes !== d.limits.autoWakesPerHour
  const valid = !!name.trim() && instructions.length <= AGENT_LIMITS.instructions && capabilities.length <= AGENT_LIMITS.capabilities
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await hive.companyAgents.save({ id: agent.id, companyId: agent.companyId, departmentId: agent.departmentId, kind: agent.kind, refId: agent.refId, name: name.trim(), data: { instructions, capabilities, autonomy, mode, limits: { runMinutes, autoWakesPerHour: wakes } } })
      await refreshDepartments()
      toast(`${name.trim()} saved`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="dep-card" aria-label="Instructions">
      <header className="dep-card__head">
        <h2>Instructions</h2>
        <span className="dep-card__hint">Prepended to every task turn. Changes apply from the next turn.</span>
      </header>
      <div className="dep-form">
        <label className="dep-field">
          <span>{personas ? 'Role' : 'Name'}</span>
          <input className="input" maxLength={AGENT_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="dep-field dep-field--top">
          <span>Instructions</span>
          <span className="dep-field__col">
            <textarea className="input dep-textarea" rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            <span className={`dep-counter ${instructions.length > AGENT_LIMITS.instructions ? 'is-over' : ''}`}>
              {instructions.length}/{AGENT_LIMITS.instructions}
            </span>
          </span>
        </label>
        <label className="dep-field dep-field--top">
          <span>Capabilities</span>
          <span className="dep-field__col">
            <textarea className="input dep-textarea" rows={2} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />
            <span className={`dep-counter ${capabilities.length > AGENT_LIMITS.capabilities ? 'is-over' : ''}`}>
              {capabilities.length}/{AGENT_LIMITS.capabilities}
            </span>
          </span>
        </label>
        <div className="dep-field">
          <span>Autonomy</span>
          <span className="dep-field__col">
            <Segmented size="sm" items={[{ value: 'manual', label: autonomyPhrase({ auto: false, role: agent.name, department }) }, { value: 'auto', label: autonomyPhrase({ auto: true }) }]} value={autonomy} onChange={setAutonomy} />
            <span className="dep-field__hint">{autonomy === 'auto' ? 'Starts on assignment, but only while the company’s Autopilot is on.' : 'Waits for you to click Run on each task.'}</span>
          </span>
        </div>
        {/* design §4.3: how it runs is Advanced */}
        <Disclosure label="Advanced: how it runs">
        <div className="dep-field">
          <span>Runs as</span>
          <Segmented size="sm" items={[{ value: 'headless', label: 'Headless' }, { value: 'session', label: 'Session' }]} value={mode} onChange={setMode} />
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
        </Disclosure>
        <div className="dep-form__foot">
          <span className="flex1" />
          <Button size="sm" variant="primary" disabled={busy || !dirty || !valid || !!agent.archivedAt} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </section>
  )
}

const putPersona = (agent: CompanyAgent, persona: AgentPersona): Promise<unknown> =>
  hive.companyAgents.save({ id: agent.id, companyId: agent.companyId, departmentId: agent.departmentId, kind: agent.kind, refId: agent.refId, name: agent.name, data: { persona } })

/**
 * Saves only `data.persona` (main keeps every other field); the name sent is the unchanged role label. Legacy agents
 * whose display-only persona would shift because of this edit are stored first with the one they are shown with.
 */
async function savePersona(agent: CompanyAgent, persona: AgentPersona): Promise<boolean> {
  try {
    const s = getState()
    for (const f of personasToFreeze(agent.id, persona, s.companyAgents, s.departments)) await putPersona(f.agent, f.persona)
    await putPersona(agent, persona)
    await refreshDepartments()
    return true
  } catch (e) {
    toast(errorMessage(e), 'error')
    void refreshDepartments() // a freeze may have landed before the failure
    return false
  }
}

/**
 * VOICE.md §4.4 agent header: Bust 64, the persona name with inline rename (1 to 24 characters, unique among the
 * company's active agents, the error inline), the role label, the personality line and an editable About. A legacy
 * agent's display-only persona is stored on its first edit, so the face it was shown with stays.
 */
function PersonaHeader({ agent, persona, color }: { agent: CompanyAgent; persona: AgentPersona; color: string | null }): React.JSX.Element {
  const copy = useCopy()
  const agents = useStore((s) => s.companyAgents)
  const personas = useStore((s) => personasOf(s))
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(persona.name)
  const [editingBio, setEditingBio] = useState(false)
  const [bio, setBio] = useState(persona.bio)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const error = renaming ? personaNameError(name, agent, agents, personas) : null
  const changed = name.trim() !== persona.name
  const archived = !!agent.archivedAt
  useEffect(() => {
    if (renaming) nameRef.current?.select()
  }, [renaming])

  const commitName = async (): Promise<void> => {
    if (busy) return
    if (!changed) return setRenaming(false)
    if (error) return
    setBusy(true)
    const ok = await savePersona(agent, editedPersona(persona, { name }))
    setBusy(false)
    if (ok) {
      setRenaming(false)
      toast(`Renamed to ${name.trim()}`)
    }
  }
  const cancelName = (): void => {
    setName(persona.name)
    setRenaming(false)
  }
  const commitBio = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const ok = await savePersona(agent, editedPersona(persona, { bio }))
    setBusy(false)
    if (ok) setEditingBio(false)
  }

  return (
    <section className="dep-card agent-hero" aria-label={`${persona.name}, ${agent.name}`}>
      <div className="agent-hero__top">
        <AgentBust agent={agent} color={color} size={64} className="agent-hero__bust" />
        <div className="agent-hero__id">
          {renaming ? (
            <form
              className="agent-hero__rename"
              onSubmit={(e) => {
                e.preventDefault()
                void commitName()
              }}
            >
              <input
                ref={nameRef}
                className={`input agent-hero__input ${error ? 'is-invalid' : ''}`}
                aria-label={`Rename ${persona.name}`}
                aria-invalid={!!error}
                aria-describedby={error ? `agent-rename-err-${agent.id}` : undefined}
                maxLength={PERSONA_LIMITS.name + 8}
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    cancelName()
                  }
                }}
              />
              <Button size="sm" variant="primary" type="submit" disabled={busy || !!error}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelName} disabled={busy}>
                Cancel
              </Button>
            </form>
          ) : (
            <h1 className="agent-hero__name">
              <span className="agent-hero__name-text">{persona.name}</span>
              {!archived && (
                <button type="button" className="agent-hero__edit" aria-label={`Rename ${persona.name}`} title={copy('agent.rename')} onClick={() => setRenaming(true)}>
                  <Icon name="edit" size={12} />
                </button>
              )}
            </h1>
          )}
          {error && (
            <span className="agent-hero__error" id={`agent-rename-err-${agent.id}`} role="alert">
              {error}
            </span>
          )}
          <span className="agent-hero__role">{agent.name}</span>
          {persona.personality && <span className="agent-hero__personality">{persona.personality}</span>}
        </div>
      </div>
      <div className="agent-hero__about">
        <header className="dep-card__head">
          <h2>{copy('agent.bio.label')}</h2>
          <span className="flex1" />
          {!editingBio && !archived && (
            <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditingBio(true)}>
              Edit
            </Button>
          )}
        </header>
        {editingBio ? (
          <div className="dep-form">
            <textarea className="input dep-textarea" rows={3} aria-label={`About ${persona.name}`} value={bio} disabled={busy} onChange={(e) => setBio(e.target.value)} />
            <div className="dep-form__foot">
              <span className={`dep-counter ${bio.length > PERSONA_LIMITS.bio ? 'is-over' : ''}`}>
                {bio.length}/{PERSONA_LIMITS.bio}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBio(persona.bio)
                  setEditingBio(false)
                }}
              >
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={busy || bio.length > PERSONA_LIMITS.bio || bio.trim() === persona.bio} onClick={() => void commitBio()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className={persona.bio ? 'agent-hero__bio' : 'dep-card__empty'}>{persona.bio || 'No bio yet.'}</p>
        )}
      </div>
    </section>
  )
}
