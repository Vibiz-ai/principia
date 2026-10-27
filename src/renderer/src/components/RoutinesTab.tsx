/**
 * Automations › Routines, the first tab: ready-made daily and weekly routines (shared/routines.ts) for one company.
 * Each card says what it does, when it runs, what it uses and who does it, with one Turn on (an enabled schedule, and
 * the workflow when it runs one) and Run once now. A principia://automations/routines?add=<id> link (or a Home
 * suggestion) points at one card and focuses its Turn on; nothing is ever turned on without the click.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cadenceOf, cronOf, isRoutineId, planRoutine, routineCost, routineSchedule, routinesFor, routineTimeOf, setRoutine, WEEK_ORDER, type RoutineContext, type RoutineId, type RoutinePlan, type RoutineTime } from '@shared/routines'
import type { Id, Schedule, Workflow } from '@shared/types'
import { Button, EmptyState, RelativeTime } from './ui'
import { useCompanySetup } from './home/useCompanySetup'
import { useAgentDisplay } from './board/NeedsYouTasks'
import { AgentBust } from '../shell/DepartmentGroup'
import { RailMark } from '../shell/CompanyRail'
import { isPersonal } from '../lib/company'
import { reposOf } from '../lib/companyModel'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { changeRoutineTime, runRoutineOnce, turnOffRoutine, turnOnRoutine, type RoutineDeps } from '../lib/routinesApply'
import { suggestedTime } from '../lib/deepLinkNav'
import { enterCompany, getState, navigate, refreshTasks, toast, updateSettings, useStore } from '../state/store'
import { claudeSignedOut } from '../state/claudeAuth'
import { useScope } from './CompanyChip'
import '../styles/automations.css'

export const routineDeps: RoutineDeps = {
  createWorkflow: (d) => hive.workflows.create(d),
  createSchedule: (s) => hive.schedules.create(s),
  setScheduleEnabled: (id, enabled) => hive.schedules.setEnabled({ id, enabled }),
  updateSchedule: (id, input) => hive.schedules.update({ id, input }),
  runSchedule: (id) => hive.schedules.runNow({ id }),
  lastScheduleMessage: async (id) => (await hive.schedules.events({ scheduleId: id, limit: 1 }))[0]?.message ?? null,
  startRun: (target, companyId) => hive.runs.start({ target, companyId }),
  createTask: (task) => hive.tasks.create({ task }),
  startTask: (id) => hive.tasks.start({ id })
}

export function RoutinesTab({ suggest, suggestTime, nonce }: { suggest?: string; suggestTime?: { at?: string; days?: string }; nonce?: number }): React.JSX.Element {
  const { scope } = useScope()
  const companies = useStore((s) => s.companies)
  const real = companies.filter((c) => !isPersonal(c) && !c.archivedAt)
  if (!scope || isPersonal({ id: scope, system: companies.find((c) => c.id === scope)?.system ?? null }))
    return (
      <div className="auto-tab">
        <p className="auto-tab__lede">Routines belong to one company. Pick the company to see its routines.</p>
        {real.length === 0 ? (
          <EmptyState icon="refresh" text="Add a company first: routines run its agents." />
        ) : (
          <div className="auto-tab__pick">
            {real.map((c) => (
              <button key={c.id} type="button" className="auto-tab__co" onClick={() => void enterCompany(c.id, { view: { name: 'schedules', tab: 'routines', ...(suggest ? { addRoutine: suggest } : {}), nonce: Date.now() } })}>
                <RailMark company={c} size={24} />
                <span className="auto-tab__co-name">{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  return <CompanyRoutines key={scope} companyId={scope} suggest={isRoutineId(suggest) ? suggest : undefined} suggestTime={suggestTime} nonce={nonce} />
}

/** The routine context for one company (the autopilot context plus its repositories), and its schedules. */
export function useRoutineContext(companyId: Id): { ctx: RoutineContext | null; schedules: Schedule[] | null; workflows: Workflow[] } {
  const setup = useCompanySetup(companyId)
  const repos = useStore((s) => s.repos)
  const repoIds = useMemo(() => reposOf(repos, companyId).map((r) => r.id), [repos, companyId])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const loadWf = (): void => void hive.workflows.list({ companyId }).then(setWorkflows, () => undefined)
  useEffect(loadWf, [companyId])
  useHiveEvent('data:changed', ({ domain }) => domain === 'workflows' && loadWf())
  const ctx = useMemo<RoutineContext | null>(() => (setup.ctx ? { ...setup.ctx, repoIds } : null), [setup.ctx, repoIds])
  return { ctx, schedules: setup.schedules, workflows }
}

function CompanyRoutines({ companyId, suggest, suggestTime, nonce }: { companyId: Id; suggest?: RoutineId; suggestTime?: { at?: string; days?: string }; nonce?: number }): React.JSX.Element {
  const company = useStore((s) => s.companies.find((c) => c.id === companyId))
  const records = useStore((s) => s.settings?.routines?.[companyId])
  const { ctx, schedules, workflows } = useRoutineContext(companyId)
  const plans = useMemo(() => (ctx ? routinesFor(ctx).map((d) => planRoutine(d, ctx)) : []), [ctx])
  if (!company) return <EmptyState icon="refresh" text="This company is gone." />
  if (!ctx || !schedules) return <div className="auto-tab" />
  const offered = suggest && !plans.some((p) => p.def.id === suggest) ? suggest : null
  return (
    <div className="auto-tab">
      <div>
        <div className="auto-tab__title">Routines for {company.name}</div>
        <p className="auto-tab__lede">Ready-made work your team does on a schedule. Turn one on and it runs at its time, with Autopilot off too; what it makes waits for your OK.</p>
      </div>
      {company.pausedAt && <div className="banner banner--warning">‖ {company.name} is paused. Routines you turn on wait until you resume it.</div>}
      {offered && <div className="banner">That routine is for companies with code. Add a repository to {company.name} to use it.</div>}
      <div className="routine-list">
        {plans.map((p) => (
          <RoutineCard key={p.def.id} plan={p} ctx={ctx} schedule={routineSchedule(p.def.id, companyId, records?.[p.def.id], schedules)} workflows={workflows} suggested={suggest === p.def.id} proposed={suggest === p.def.id && suggestTime ? suggestedTime(p.def.id, suggestTime.at, suggestTime.days) : null} nonce={nonce} />
        ))}
      </div>
      <p className="auto-tab__foot">
        Routines run while Principia is open. Each one is an ordinary schedule you can change in
        <button type="button" className="link-btn" onClick={() => void navigate({ name: 'schedules', tab: 'schedules', nonce: Date.now() })}>
          Schedules
        </button>
      </p>
    </div>
  )
}

function RoutineCard({ plan, ctx, schedule, workflows, suggested, proposed, nonce }: { plan: RoutinePlan; ctx: RoutineContext; schedule: Schedule | null; workflows: Workflow[]; suggested: boolean; proposed: RoutineTime | null; nonce?: number }): React.JSX.Element {
  const { def } = plan
  const who = useAgentDisplay()(plan.agent ?? undefined)
  const color = useStore((s) => s.departments.find((d) => d.id === plan.agent?.departmentId)?.color ?? null)
  const paused = useStore((s) => !!s.companies.find((c) => c.id === ctx.companyId)?.pausedAt)
  const [busy, setBusy] = useState<'on' | 'off' | 'run' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const turnOnRef = useRef<HTMLButtonElement>(null)
  const on = !!schedule?.enabled
  const current = (schedule?.when.kind === 'cron' ? routineTimeOf(schedule.when.cron) : null) ?? routineTimeOf(def.cron)
  // a link (an agent's suggestion) opens the time editor prefilled; nothing changes until Save
  const [editing, setEditing] = useState<RoutineTime | null>(proposed)
  useEffect(() => setEditing(proposed), [proposed?.time, proposed?.days.join(), nonce])
  const code = ctx.repoIds.length > 0
  useEffect(() => {
    if (!suggested) return
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // focus only: the person presses it (a link never turns a routine on)
    const t = setTimeout(() => turnOnRef.current?.focus(), 250)
    return () => clearTimeout(t)
  }, [suggested, nonce])

  const record = async (rec: Parameters<typeof setRoutine>[3]): Promise<void> => {
    await updateSettings({ routines: setRoutine(getState().settings?.routines, ctx.companyId, def.id, rec) })
  }
  const turnOn = async (at?: RoutineTime): Promise<void> => {
    setBusy('on')
    try {
      const cron = at ? cronOf(at) : null
      const { record: rec } = await turnOnRoutine(routineDeps, plan, ctx, workflows, schedule, new Date(), cron ? { cron } : {})
      await record(rec)
      setEditing(null)
      toast(`${def.name} is on. ${at ? cadenceOf(at) : current ? cadenceOf(current) : def.cadence}.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const turnOff = async (): Promise<void> => {
    if (!schedule) return
    setBusy('off')
    try {
      await turnOffRoutine(routineDeps, schedule)
      toast(`${def.name} is off. Its schedule stays under Schedules.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const saveTime = async (at: RoutineTime): Promise<void> => {
    const cron = cronOf(at)
    if (!cron) return void toast('Pick at least one day and a time.', 'error')
    if (!schedule || !on) return turnOn(at)
    setBusy('on')
    try {
      await changeRoutineTime(routineDeps, schedule, cron)
      setEditing(null)
      toast(`${def.name}: ${cadenceOf(at)}.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const runOnce = async (): Promise<void> => {
    if (claudeSignedOut() && plan.adapter === 'claude') return void toast('Sign in to Claude first (Settings › AI providers).', 'error')
    setBusy('run')
    try {
      const r = await runRoutineOnce(routineDeps, plan, ctx, workflows, schedule)
      if (r.kind === 'task') await refreshTasks().catch(() => undefined)
      if (r.waiting) toast(`${def.name} is queued: ${r.waiting}.`)
      else toast(`${def.name} started${who ? ` · ${who.name} is on it` : ''}. The result shows in Needs you.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={ref} className={`routine ${on ? 'is-on' : ''} ${suggested ? 'is-suggested' : ''}`} data-routine={def.id}>
      <div className="routine__head">
        <span className="routine__name">{def.name}</span>
        <span className={`routine__state ${on ? 'is-on' : ''}`}>
          {on ? (
            <>
              On{schedule?.nextFireAt && !paused ? <> · next <RelativeTime iso={schedule.nextFireAt} /></> : paused ? ' · waits while paused' : ''}
            </>
          ) : schedule ? (
            'Off'
          ) : null}
        </span>
      </div>
      <p className="routine__summary">{def.summary}</p>
      <dl className="routine__facts">
        <div>
          <dt>When</dt>
          <dd>{current ? cadenceOf(current) : def.cadence}</dd>
        </div>
        <div>
          <dt>Who</dt>
          <dd className="routine__who">
            {plan.agent && <AgentBust agent={plan.agent} color={color} size={16} />}
            {who ? `${who.name}${who.role ? ` · ${who.role}` : ''}` : plan.profileId ? 'Your default agent' : 'Nobody yet'}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{routineCost(plan)}</dd>
        </div>
      </dl>
      <div className="routine__actions">
        {on ? (
          <Button size="sm" disabled={!!busy} onClick={() => void turnOff()}>
            {busy === 'off' ? 'Turning off…' : 'Turn off'}
          </Button>
        ) : (
          <Button ref={turnOnRef} size="sm" variant="primary" disabled={!!busy || !plan.ready} title={plan.blocker ?? undefined} onClick={() => void turnOn(editing ?? undefined)}>
            {busy === 'on' ? 'Turning on…' : 'Turn on'}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={!!busy || !plan.ready || paused} title={paused ? 'Resume the company to run it' : (plan.blocker ?? undefined)} onClick={() => void runOnce()}>
          {busy === 'run' ? 'Starting…' : 'Run once now'}
        </Button>
        {!plan.ready && plan.blocker && <span className="routine__blocker">{plan.blocker}</span>}
        {!editing && current && (
          <button type="button" className="link-btn routine__edit" onClick={() => setEditing(current)}>
            Change time
          </button>
        )}
        {code && schedule && !editing && (
          <button type="button" className="link-btn" onClick={() => void navigate({ name: 'schedules', tab: 'schedules', selectedId: schedule.id, nonce: Date.now() })}>
            Edit schedule
          </button>
        )}
      </div>
      {editing && <RoutineTimeEditor value={editing} onChange={setEditing} busy={!!busy} saveLabel={on ? 'Save' : 'Turn on at this time'} onSave={() => void saveTime(editing)} onCancel={() => setEditing(null)} suggested={!!proposed} />}
    </div>
  )
}


const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Days of the week and a time of day: when a routine runs, in plain words (never a cron). */
function RoutineTimeEditor({ value, onChange, onSave, onCancel, busy, saveLabel, suggested }: { value: RoutineTime; onChange: (t: RoutineTime) => void; onSave: () => void; onCancel: () => void; busy: boolean; saveLabel: string; suggested: boolean }): React.JSX.Element {
  const set = new Set(value.days)
  const toggle = (d: number): void => onChange({ ...value, days: set.has(d) ? value.days.filter((x) => x !== d) : [...value.days, d].sort((a, b) => a - b) })
  return (
    <div className="routine__time" role="group" aria-label="When it runs">
      {suggested && <p className="routine__time-note">Suggested by your team. Nothing changes until you press {saveLabel}.</p>}
      <div className="routine__days">
        {WEEK_ORDER.map((d) => (
          <button key={d} type="button" className={`routine__day ${set.has(d) ? 'is-on' : ''}`} aria-pressed={set.has(d)} onClick={() => toggle(d)}>
            {DAY_SHORT[d]}
          </button>
        ))}
        <input className="input input--sm routine__clock" type="time" aria-label="Time of day" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
      </div>
      <div className="routine__actions">
        <span className="routine__blocker">{value.days.length ? cadenceOf(value) : 'Pick at least one day'}</span>
        <span className="flex1" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy || !value.days.length || !value.time} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}
