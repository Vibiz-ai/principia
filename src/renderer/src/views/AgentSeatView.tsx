/**
 * Five doors step 3: the agent page is the agent's desk (AgentSeatView below). The rest is DEPARTMENTS.md §9's:
 * DEPARTMENTS.md §9 agent page: one seat's current task, queue, what waits for you, run history with outcomes, the
 * instructions editor (plus capabilities, autonomy, mode, limits), a link to the backing profile or workflow, Pause.
 * VOICE.md §4.4: with personas on it opens with the agent's bust, persona name (renamed inline), role label,
 * personality and an editable About; with them off, the old avatar and the role label as the name.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_LIMITS, type AgentAutonomy, type AgentMode, type CompanyAgent, type CompanyTask } from '@shared/company'
import { LANE_WORD } from '../lib/board'
import type { Id, Run } from '@shared/types'
import { Button, Disclosure, EmptyState, ErrorState, Loading, Pill, RelativeTime, Segmented, Stepper, Switch, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { taskLane, taskReason } from '../lib/departments'
import { AgentBust, useAgentName, useLaneContext } from '../shell/DepartmentGroup'
import { Plinth } from '../components/roman'
import { AgentAction, DeskComposer, DeskThread, StatusLine, startTask, useAgentStatus, useIsCode } from '../components/desk/Desk'
import { agentAutonomy, useDeskWho, useDeskThread } from '../state/desk'
import { autonomyPhrase } from '../lib/desk'
import { personasOf } from '../lib/personaView'
import { editedPersona, personaNameError, personasToFreeze } from '../lib/personaRename'
import { useCopy, usePersonasOn } from '../lib/voice'
import { PERSONA_LIMITS, type AgentPersona } from '@shared/personas'
import { archiveCompanyAgent, attempt, companyAgentById, departmentById, getState, navigate, openBoard, openDepartment, refreshDepartments, setAgentPaused, setCompanyPaused, toast, useStore } from '../state/store'
import { useCompanyShortName } from '../lib/company'
import '../styles/departments.css'
import '../styles/desk.css'

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

type DeskTab = 'queue' | 'history' | 'instructions'

/**
 * Five doors step 3 (design §4.3): the agent page is the agent's desk, the ONE place to talk to it. Left: the bust on
 * its plinth, role and department, the status sentence, the one next action and "How {name} works" with the agent's
 * autonomy phrase as a switch. Centre: the conversation (your requests, its replies, its drafts with Approve) and a
 * composer; Message on a Team card focuses it. Right: Queue (with Start), History (runs) and Instructions (persona,
 * instructions, how it runs, and Archive, which never sits next to Pause: C9).
 */
export function AgentSeatView({ id, focus = false, nonce }: { id: Id; focus?: boolean; nonce?: number }): React.JSX.Element {
  const agent = useStore((s) => companyAgentById(id, s))
  const dep = useStore((s) => departmentById(agent?.departmentId, s))
  const [tab, setTab] = useState<DeskTab>('queue')
  if (!agent)
    return (
      <div className="view">
        <Toolbar title="Agent" />
        <EmptyState icon="agents" text="This agent is gone or still loading." />
      </div>
    )
  return <Desk key={agent.id} agent={agent} dep={dep} tab={tab} setTab={setTab} focus={focus} nonce={nonce} />
}

function Desk({ agent, dep, tab, setTab, focus, nonce }: { agent: CompanyAgent; dep: ReturnType<typeof departmentById>; tab: DeskTab; setTab: (t: DeskTab) => void; focus: boolean; nonce?: number }): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const who = useDeskWho(agent)
  const autonomy = useStore((s) => agentAutonomy(agent, s))
  const n = useAgentName(agent)
  const status = useAgentStatus(agent)
  const code = useIsCode(agent.companyId)
  const thread = useDeskThread(agent)
  const ctx = useLaneContext()
  const st = status.seat
  const mine = useMemo(() => tasks.filter((t) => t.agentId === agent.id && t.companyId === agent.companyId), [tasks, agent.id, agent.companyId])
  const done = useMemo(() => mine.filter((t) => t.status === 'done').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 5), [mine])
  const queueRows = [...(st.current ? [st.current] : []), ...st.review, ...st.parked, ...st.queue]
  const waiting = useMemo(() => new Set(st.queue.filter((t) => t.waiting).map((t) => t.id)), [st.queue])
  const paused = status.kind === 'paused'
  const autopilot = useStore((s) => !!s.companies.find((x) => x.id === agent.companyId)?.autopilot)
  const companyShort = useCompanyShortName(agent.companyId, 'this company')
  const companyPaused = useStore((s) => {
    const c = s.companies.find((x) => x.id === agent.companyId)
    return c?.pausedAt ? c.name : null
  })
  // what you added to a queued task from the conversation (a merged request): shown on its Queue row
  const notes = useMemo(() => {
    const m = new Map<string, string>()
    const seen = new Set<string>()
    for (const it of thread.items ?? []) {
      if (it.kind !== 'me') continue
      const desk = !!thread.tasks.find((t) => t.id === it.taskId)?.externalId?.startsWith('desk:')
      // a desk task's first "me" is the request that made it; anything after it is what you added
      if (desk && !seen.has(it.taskId)) {
        seen.add(it.taskId)
        continue
      }
      m.set(it.taskId, it.text)
    }
    return m
  }, [thread.items, thread.tasks])
  const setAuto = async (auto: boolean): Promise<void> => {
    const ok = await attempt(() => hive.companyAgents.save({ id: agent.id, companyId: agent.companyId, departmentId: agent.departmentId, kind: agent.kind, refId: agent.refId, name: agent.name, data: { autonomy: auto ? 'auto' : 'manual' } }), 'Autonomy')
    if (ok) {
      await refreshDepartments()
      toast(`${who.name} now: ${autonomyPhrase({ auto, role: agent.name, department: dep?.name })}. Same words on the Team card.`)
    }
  }
  return (
    <div className="view">
      <Toolbar
        title={
          <span className="dep-title">
            <button type="button" className="link-btn desk-crumb" onClick={() => void navigate({ name: 'team' })}>
              Team ›
            </button>{' '}
            {who.name}
          </span>
        }
        sub={<span className="company-toolbar-meta">{[who.role, dep?.name ?? 'company-wide'].join(' · ')}{agent.archivedAt ? ' · archived' : ''}</span>}
      >
        {!agent.archivedAt && companyPaused && (
          <Button icon="play" variant="primary" onClick={() => void setCompanyPaused(agent.companyId, false)} title={`${companyPaused} is paused, so ${who.name} is too. Resume the company to let ${who.name} take tasks again.`}>
            Resume {companyShort}
          </Button>
        )}
        {!agent.archivedAt && !companyPaused && (
          <Button icon={agent.pausedAt ? 'play' : 'pause'} variant={agent.pausedAt ? 'primary' : 'secondary'} onClick={() => void setAgentPaused(agent, !agent.pausedAt)} title={agent.pausedAt ? `Let ${who.name} take tasks again` : `${who.name} takes no new task until you resume; the current one keeps its work`}>
            {agent.pausedAt ? `Resume ${who.name}` : `Pause ${who.name}`}
          </Button>
        )}
      </Toolbar>
      <div className="desk-page">
        <aside className="desk-left">
          {/* plain lettering (MARCUS, not MARCVS: design §2.7) */}
          <Plinth persona={n.persona} role={who.role} size={110} tone="plain" className="desk-left__plinth" />
          <div className="desk-left__role">{dep?.name ?? 'Company-wide'}</div>
          <div className={`desk-left__status ${status.kind === 'needs' ? 'is-needs' : ''}`}>
            <StatusLine status={status} />
          </div>
          <AgentAction agent={agent} status={status} size="md" wide />
          <div className="desk-left__how">
            <h3>How {who.name} works</h3>
            <div className="desk-opt desk-opt--muted">{autonomy}</div>
            {/* QA round 4: the switch says exactly what it changes (when tasks start), so turning it off never reads as
                "replies without asking"; it never changes what waits for your OK */}
            <label className="desk-opt">
              <span className="desk-opt__label">Starts its tasks on its own</span>
              <Switch checked={agent.data.autonomy === 'auto'} disabled={!!agent.archivedAt} onChange={(v) => void setAuto(v)} label="Starts its tasks on its own" />
            </label>
            <div className="desk-opt desk-opt--muted">{agent.data.autonomy !== 'auto' ? 'Off: it waits for you to press Start on each task.' : autopilot ? 'On: it picks up its next task when one is ready.' : `On, once Autopilot is on for ${companyShort} (Settings › Team & autonomy). Until then it waits for you.`}</div>
            <div className="desk-opt desk-opt--muted">One task at a time · up to {agent.data.limits.runMinutes} min each</div>
          </div>
        </aside>
        <section className="desk-center" aria-label={`Conversation with ${who.name}`}>
          <header className="desk-center__head">
            <div className="desk-center__title">Conversation with {who.name}</div>
            <div className="desk-center__sub">Everything you and {who.name} say. It is also listed in Chats.</div>
          </header>
          {thread.error ? <ErrorState error={thread.error} /> : thread.items ? <DeskThread agent={agent} items={thread.items} tasks={thread.tasks} code={code} /> : <Loading />}
          <DeskComposer key={nonce ?? 0} agent={agent} autoFocus={focus} />
        </section>
        <aside className="desk-right">
          <div className="desk-tabs" role="tablist">
            {(['queue', 'history', 'instructions'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`desk-tab ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>
                {k === 'queue' ? 'Queue' : k === 'history' ? 'History' : 'Instructions'}
                {k === 'queue' && <span className="desk-tab__n">{queueRows.length}</span>}
              </button>
            ))}
          </div>
          <div className="desk-right__body">
            {tab === 'queue' && (
              <>
                {queueRows.length === 0 && <div className="desk-empty">Nothing queued for {who.name}. Ask in the conversation and it lands here.</div>}
                {queueRows.map((t) => {
                  const lane = taskLane(t, ctx)
                  const g = lane === 'working' ? '●' : lane === 'needs_you' ? '◆' : '○'
                  return (
                    <div key={t.id} className="desk-q" role="button" tabIndex={0} onClick={() => openBoard(t.companyId, { taskId: t.id })} onKeyDown={(e) => e.key === 'Enter' && openBoard(t.companyId, { taskId: t.id })}>
                      <span className={`desk-q__glyph ${lane === 'working' ? 'is-working' : lane === 'needs_you' ? 'is-needs' : ''}`} aria-hidden>
                        {g}
                      </span>
                      <div className="desk-q__body">
                        <div>{t.title}</div>
                        <div className="desk-q__meta">
                          {code ? `${t.identifier} · ` : ''}
                          {waiting.has(t.id) ? 'Waiting on another task' : LANE_WORDS[lane]}
                        </div>
                        {notes.get(t.id) && <div className="desk-q__note">Includes your note: “{notes.get(t.id)!.length > 90 ? `${notes.get(t.id)!.slice(0, 90).replace(/\s+\S*$/, '')}…` : notes.get(t.id)}”</div>}
                      </div>
                      {lane === 'queued' && t.status === 'todo' && !waiting.has(t.id) && !paused && !st.current && (
                        <Button size="sm" onClick={(e) => (e.stopPropagation(), void startTask(t))}>
                          Start
                        </Button>
                      )}
                    </div>
                  )
                })}
                {done.length > 0 && <div className="desk-q__meta" style={{ margin: '14px 6px 2px' }}>Done recently</div>}
                {done.map((t) => (
                  <div key={t.id} className="desk-q" role="button" tabIndex={0} onClick={() => openBoard(t.companyId, { taskId: t.id })} onKeyDown={(e) => e.key === 'Enter' && openBoard(t.companyId, { taskId: t.id })}>
                    <span className="desk-q__glyph is-done" aria-hidden>
                      ✓
                    </span>
                    <div className="desk-q__body">
                      <div>{t.title}</div>
                      {code && <div className="desk-q__meta">{t.identifier}</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
            {tab === 'history' && <RunHistory agent={agent} tasks={tasks} code={code} />}
            {tab === 'instructions' && <Instructions agent={agent} dep={dep} />}
          </div>
        </aside>
      </div>
    </div>
  )
}

const LANE_WORDS: Record<string, string> = { inbox: 'To do', queued: 'To do', working: 'Working', needs_you: 'Needs you', done: 'Done' }

/** Instructions tab: who it is (persona, About), what it is told, how it runs (Advanced), where it runs, Archive. */
function Instructions({ agent, dep }: { agent: CompanyAgent; dep: ReturnType<typeof departmentById> }): React.JSX.Element {
  const who = useAgentName(agent)
  const profiles = useStore((s) => s.profiles)
  const profile = agent.kind === 'profile' ? profiles.find((p) => p.id === agent.refId) : undefined
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
          <span>{agent.kind === 'profile' ? (profile ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}` : 'Profile removed: pick another in a new seat') : 'Workflow'}</span>
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
function RunHistory({ agent, tasks, code = true }: { agent: CompanyAgent; tasks: CompanyTask[]; code?: boolean }): React.JSX.Element {
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
