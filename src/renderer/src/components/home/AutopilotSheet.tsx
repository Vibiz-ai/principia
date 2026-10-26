/**
 * AUTOPILOT.md §4: one autopilot's sheet. Shows what is missing first (each with the checklist fix), then every step
 * with its cadence, agent and what it creates; ready steps are ticked by default, blocked ones cannot be ticked.
 * Turning it on creates ordinary schedules (and the competitor-watch workflow) in the open, then lists them with links
 * to edit; Pause and Remove act on exactly those (Settings.autopilots).
 */
import { useMemo, useState } from 'react'
import { autopilotDef, buildStep, competitorList, contentChannels, missingFor, planAutopilot, setAutopilot, type AutopilotId, type AutopilotRecord, type FixTarget, type MissingRequirement, type StepPlan } from '@shared/autopilot'
import type { SocialId } from '@shared/socials'
import type { Id, Schedule } from '@shared/types'
import { Button, Sheet } from '../ui'
import type { ChecklistAction } from '../../lib/checklist'
import { enableAutopilot, goneSteps, pauseAutopilot, removeAutopilot, withoutSteps, type AutopilotDeps } from '../../lib/autopilotApply'
import { confirmNative, errorMessage, hive } from '../../lib/hive'
import { getState, navigate, requestAutopilot, toast, updateSettings, useStore } from '../../state/store'
import type { CompanySetup } from './useCompanySetup'

const hiveDeps: AutopilotDeps = {
  createWorkflow: (d) => hive.workflows.create(d),
  createSchedule: (s) => hive.schedules.create(s),
  setScheduleEnabled: (id, enabled) => hive.schedules.setEnabled({ id, enabled }),
  removeSchedule: (id) => hive.schedules.remove({ id }),
  removeWorkflow: (id) => hive.workflows.remove({ id }),
  now: () => new Date().toISOString()
}

async function saveRecord(companyId: Id, id: AutopilotId, rec: AutopilotRecord | undefined): Promise<void> {
  // read the latest settings: another sheet (or window) may have written a sibling record meanwhile
  await updateSettings({ autopilots: setAutopilot(getState().settings?.autopilots, companyId, id, rec) })
}

/** A missing requirement as the checklist action that fixes it. */
function fixAction(m: MissingRequirement): ChecklistAction | null {
  const f: FixTarget = m.fix
  switch (f) {
    case 'departments':
      return { kind: 'enableDepartments' }
    case 'agents':
      return m.departmentId ? { kind: 'department', departmentId: m.departmentId, focus: 'agents' } : m.req.kind === 'agent' && m.req.dept !== 'any' ? { kind: 'addDepartments', keys: [m.req.dept] } : { kind: 'addDepartments', keys: ['marketing', 'development', 'finance'] }
    case 'marketingDashboards':
    case 'financeDashboards':
      return m.departmentId ? { kind: 'department', departmentId: m.departmentId, focus: 'dashboards' } : { kind: 'addDepartments', keys: [f === 'financeDashboards' ? 'finance' : 'marketing'] }
    case 'socials':
      return { kind: 'socials' }
    case 'profile':
      return null
  }
}

export function AutopilotSheet({ id, setup, onClose, onFix }: { id: AutopilotId; setup: CompanySetup; onClose: () => void; onFix: (a: ChecklistAction) => void }): React.JSX.Element | null {
  const ctx = setup.ctx!
  const def = autopilotDef(id)
  const company = useStore((s) => s.companies.find((c) => c.id === ctx.companyId))
  const plans = useMemo(() => planAutopilot(id, ctx), [id, ctx])
  const missing = useMemo(() => missingFor(plans), [plans])
  const rec = setup.autopilots?.[id]
  const live = useMemo(() => new Map((setup.schedules ?? []).map((s) => [s.id, s])), [setup.schedules])
  const liveIds = useMemo(() => new Set(live.keys()), [live])
  const gone = useMemo(() => (setup.schedules ? goneSteps(rec, liveIds) : []), [rec, liveIds, setup.schedules])
  const created = (stepId: string): Schedule | null => {
    const s = rec?.steps[stepId]
    return s ? live.get(s.scheduleId) ?? null : null
  }
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(plans.filter((p) => p.ready).map((p) => p.def.id)))
  const [publish, setPublish] = useState<SocialId[]>(rec?.publish ?? [])
  const [competitors, setCompetitors] = useState(() => competitorList(ctx))
  const [letAgentsStart, setLetAgentsStart] = useState(true)
  const [busy, setBusy] = useState(false)

  const toCreate = plans.filter((p) => p.ready && ticked.has(p.def.id) && !created(p.def.id) && (p.def.id !== 'competitors' || competitors.trim()))
  const channels = contentChannels(ctx.socials, publish)
  const contentPlan = plans.find((p) => p.def.id === 'content')
  const publishChanged = !!rec && [...(rec.publish ?? [])].sort().join() !== [...publish].sort().join()
  const taskAgents = [...new Map(plans.filter((p) => p.ready && p.def.kind === 'task' && p.agent).map((p) => [p.agent!.id, p.agent!])).values()]
  // company:list does not report the board switch yet, so `boardOff` can be stale: offer the switch whenever task steps
  // are about to be created (turning it on when it is already on changes nothing)
  const newTaskSteps = toCreate.some((p) => p.def.kind === 'task')
  const manualAgents = taskAgents.filter((a) => a.data.autonomy !== 'auto')
  const boardOff = !company?.autopilot

  const togglePublish = async (sid: SocialId, on: boolean): Promise<void> => {
    if (on) {
      const name = ctx.socials.find((s) => s.id === sid)?.name ?? sid
      const ok = await confirmNative({
        message: `Let the Marketing agent publish to ${name}?`,
        detail: 'It still drafts first, and publishes a post only after you approve it in a comment on its card, at most 3 posts a week. You can turn this off here any time.',
        confirmLabel: 'Allow Publishing'
      })
      if (!ok) return
    }
    setPublish((p) => (on ? [...new Set([...p, sid])] : p.filter((x) => x !== sid)))
  }

  /** The content step's schedule carries its channel rules in the prompt: rewrite only that, keep the user's edits. */
  const updateContentPrompt = async (): Promise<void> => {
    const sched = created('content')
    if (!sched || !contentPlan?.ready || sched.target.kind !== 'prompt') return
    const fresh = buildStep(contentPlan, ctx, { publish }).schedule(null)
    if (fresh.target.kind !== 'prompt') return
    await hive.schedules.update({ id: sched.id, input: { name: sched.name, target: { ...sched.target, prompt: fresh.target.prompt }, departmentId: sched.departmentId ?? null, when: sched.when, preset: sched.preset, enabled: sched.enabled } })
  }

  const turnOn = async (): Promise<void> => {
    setBusy(true)
    try {
      const base = rec && gone.length ? withoutSteps(rec, gone) : rec
      const res = await enableAutopilot(hiveDeps, plans, ctx, base, { steps: toCreate.map((p) => p.def.id), publish, competitors })
      if (res.record) await saveRecord(ctx.companyId, id, res.record)
      if (publishChanged) await updateContentPrompt().catch((e) => toast(`Content step: ${errorMessage(e)}`, 'error'))
      if (letAgentsStart && boardOff && res.created.some((sid) => plans.find((p) => p.def.id === sid)?.def.kind === 'task')) {
        await requestAutopilot({ companyId: ctx.companyId, on: true }).catch((e) => toast(`Auto-start: ${errorMessage(e)}`, 'error'))
      }
      setup.reload()
      if (res.error) toast(res.error, 'error')
      else if (res.created.length) toast(`${def.name}: created ${res.created.length} schedule${res.created.length === 1 ? '' : 's'}. They are listed on the Schedules page.`)
      else if (publishChanged) toast('Publishing settings saved')
      if (!res.error) onClose()
    } finally {
      setBusy(false)
    }
  }
  const pause = async (paused: boolean): Promise<void> => {
    if (!rec) return
    setBusy(true)
    const r = await pauseAutopilot(hiveDeps, rec, paused, liveIds)
    await saveRecord(ctx.companyId, id, r.record)
    setBusy(false)
    setup.reload()
    toast(r.failed ? `${r.failed} schedule${r.failed === 1 ? '' : 's'} could not be ${paused ? 'paused' : 'resumed'}` : `${def.name} ${paused ? 'paused' : 'resumed'}`, r.failed ? 'error' : 'info')
  }
  const remove = async (): Promise<void> => {
    if (!rec) return
    const n = Object.keys(rec.steps).length
    const ok = await confirmNative({ message: `Remove ${def.name}?`, detail: `Deletes the ${n} schedule${n === 1 ? '' : 's'} it created (and the competitor-watch workflow). Tasks and runs it already made stay.`, confirmLabel: 'Remove', destructive: true })
    if (!ok) return
    setBusy(true)
    const r = await removeAutopilot(hiveDeps, rec, liveIds)
    await saveRecord(ctx.companyId, id, r.record)
    setBusy(false)
    setup.reload()
    toast(r.failed.length ? `Some steps could not be removed: ${r.failed.join(', ')}` : `${def.name} removed`, r.failed.length ? 'error' : 'info')
    if (!r.failed.length) onClose()
  }

  const primaryLabel = toCreate.length ? (rec ? `Add ${toCreate.length} step${toCreate.length === 1 ? '' : 's'}` : `Turn on ${toCreate.length} step${toCreate.length === 1 ? '' : 's'}`) : publishChanged ? 'Save' : rec ? 'Done' : 'Turn on'
  return (
    <Sheet
      title={def.name}
      width={680}
      onCancel={onClose}
      onPrimary={() => (toCreate.length || publishChanged ? void turnOn() : onClose())}
      primaryLabel={primaryLabel}
      primaryDisabled={busy || (!rec && !toCreate.length)}
      primaryTitle={!rec && !toCreate.length ? 'No step is ready yet: fix what is missing above' : undefined}
      footerLeft={
        rec ? (
          <span className="ck-sheet__footer-actions">
            <Button size="sm" icon={rec.paused ? 'play' : 'pause'} disabled={busy} onClick={() => void pause(!rec.paused)}>
              {rec.paused ? 'Resume' : 'Pause'}
            </Button>
            <Button size="sm" variant="destructive" icon="trash" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </span>
        ) : undefined
      }
    >
      <p className="ck-sheet__lede">{def.tagline} Each step is an ordinary schedule you can edit, pause or delete on the Schedules page.</p>

      {missing.length > 0 && (
        <div className="ck-missing" role="note">
          <div className="ck-auto__eyebrow">Before every step can run</div>
          <ul>
            {missing.map((m) => {
              const a = fixAction(m)
              return (
                <li key={`${m.fix}:${m.label}`}>
                  <span>{m.label}</span>
                  {a ? (
                    <Button size="sm" variant="ghost" onClick={() => onFix(a)}>
                      Fix →
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'settings', section: 'agents' })}>
                      Settings →
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <ul className="ck-steps">
        {plans.map((p) => (
          <StepRow
            key={p.def.id}
            plan={p}
            schedule={created(p.def.id)}
            gone={gone.includes(p.def.id)}
            ticked={ticked.has(p.def.id)}
            onTick={(on) => setTicked((t) => { const n = new Set(t); if (on) n.add(p.def.id); else n.delete(p.def.id); return n })}
          >
            {p.def.id === 'content' && p.ready && (
              <div className="ck-publish">
                <div className="ck-publish__head">Publishing (off unless you allow it per channel)</div>
                {channels.drafts.map((s) => (
                  <label key={s.id} className="ck-publish__row">
                    <input type="checkbox" checked={publish.includes(s.id)} disabled={!s.canPost} onChange={(e) => void togglePublish(s.id, e.target.checked)} />
                    <span>{s.name}</span>
                    <span className="text-tertiary">{!s.canPost ? 'drafts only: this API cannot post' : publish.includes(s.id) ? 'may publish approved posts' : 'drafts only'}</span>
                  </label>
                ))}
              </div>
            )}
            {p.def.id === 'competitors' && p.ready && !created('competitors') && (
              <label className="ck-competitors">
                <span>Competitors, one per line{competitorList(ctx) ? ' (from your GEO dashboard)' : ''}</span>
                <textarea className="input" rows={3} value={competitors} placeholder={'Globex\ninitech.com'} onChange={(e) => setCompetitors(e.target.value)} />
              </label>
            )}
          </StepRow>
        ))}
      </ul>

      {taskAgents.length > 0 && ((boardOff && newTaskSteps) || manualAgents.length > 0) && (
        <div className="ck-wake">
          {boardOff && newTaskSteps && (
            <label className="ck-publish__row">
              <input type="checkbox" checked={letAgentsStart} onChange={(e) => setLetAgentsStart(e.target.checked)} />
              <span>Let agents start these on their own (turns on Auto-start for {company?.name})</span>
            </label>
          )}
          {manualAgents.length > 0 && (
            <p className="ck-wake__note">
              {manualAgents.map((a) => a.name).join(', ')} {manualAgents.length === 1 ? 'is' : 'are'} set to Manual: each fire adds a comment to the recurring card and waits for you to press Run. Switch to Auto on the agent’s page to let it start by itself.
            </p>
          )}
        </div>
      )}
    </Sheet>
  )
}

function StepRow({ plan, schedule, gone, ticked, onTick, children }: { plan: StepPlan; schedule: Schedule | null; gone: boolean; ticked: boolean; onTick: (on: boolean) => void; children?: React.ReactNode }): React.JSX.Element {
  const d = plan.def
  const who = d.kind === 'task' ? (plan.agent ? `${plan.agent.name}${plan.departmentName ? ` in ${plan.departmentName}` : ''}` : 'no agent yet') : 'your default agent profile'
  return (
    <li className={`ck-step ${plan.ready ? '' : 'is-blocked'} ${schedule ? 'is-on' : ''}`}>
      <div className="ck-step__head">
        {schedule ? (
          <span className="ck-step__state">{schedule.enabled ? 'On' : 'Paused'}</span>
        ) : (
          <input type="checkbox" aria-label={`Include ${d.name}`} checked={plan.ready && ticked} disabled={!plan.ready} onChange={(e) => onTick(e.target.checked)} />
        )}
        <b className="ck-step__name">{d.name}</b>
        <span className="ck-step__meta">{d.cadence} · {d.kind === 'task' ? 'recurring agent task' : 'workflow'} · {who}</span>
        <span className="flex1" />
        {schedule && (
          <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'schedules', selectedId: schedule.id, nonce: Date.now() })}>
            Edit
          </Button>
        )}
      </div>
      <p className="ck-step__summary">{d.summary}</p>
      {gone && <p className="ck-step__missing">Its schedule was deleted. Turn it on again to recreate it.</p>}
      {!plan.ready && <p className="ck-step__missing">Needs: {plan.missing.map((m) => m.label).join(' · ')}</p>}
      {children}
    </li>
  )
}
