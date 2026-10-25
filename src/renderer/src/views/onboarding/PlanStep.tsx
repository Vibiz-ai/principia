/**
 * S6 Plan (docs/ONBOARDING.md §2, §6.2; VOICE.md §5.7 "The founding charter"): the starter plan renders at once from
 * the template; a tailored plan from a one-shot Claude call swaps in when the founder hasn't edited, else it is
 * offered ("Use it / Keep mine"). The plan sits on the founding charter, a near-black card with a double rule and corner
 * lozenges: "Meet your team" first (line busts on drawn plinths, with include and rename), a meander divider, then the
 * department cards as charter sections separated by hairlines.
 * Keyboard (department rows, unchanged): ↑/↓ rows, Space include, ↵ rename, ⌫ remove, ⌘↵ launches (the flow's primary).
 */
import { personaNamesElsewhere } from '@shared/personas'
import { useEffect, useMemo, useRef, useState } from 'react'
import { templatePlan } from '@shared/onboardingPlan'
import { Button, Switch } from '../../components/ui'
import { LatinLine } from '../../components/roman'
import { latinLine, t, useCopy, usePersonasOn, useTone } from '../../lib/voice'
import { availableFor, draftKeys, planFreshness, shouldRerequestAgentPlan } from '../../state/onboarding'
import { dismissOnboardingOffer, getState, onboardingDispatch, onboardingPlanContext, useOfferedOnboardingPlan, useStore } from '../../state/store'
import { Chip, Corners, MeanderRule, PersonaRename, PlanDepartmentCard, StepTitle, TeamPlinth, useAfter, Voiced, type PlanRowHandlers } from './bits'
import { currentInputs, hasClaudeCli, installedAdapters, maybeRetailor, tailorPlan } from './actions'
import { agentLogin, groupPlan, isRemovable, planRows, presetFor, removeRow, renamePersona, renameRow, rowKey, teamOf, toggleInclude, type TeamMember } from './model'

export function PlanStep({ color }: { color?: string } = {}): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const status = useStore((s) => s.onboardingStatus)
  const settings = useStore((s) => s.settings)
  const pending = useStore((s) => s.onboardingPlanPending)
  const offer = useStore((s) => s.onboardingOffer)
  const [focused, setFocused] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const copy = useCopy()
  const tone = useTone()
  const personasOn = usePersonasOn()
  // VOICE.md §3.9: Festina lente only once tailoring has taken more than 2 s
  const longTailor = useAfter(2000, pending)
  const ctx = onboardingPlanContext()
  const freshness = d ? planFreshness(d, ctx) : 'none'
  const { hash } = d ? currentInputs(d) : { hash: '' }

  const buildTemplate = (): { plan: ReturnType<typeof templatePlan>; hash: string } | null => {
    // the draft right now (effects run after dispatches in the same tick)
    const cur = getState().onboardingDraft
    if (!cur) return null
    const { input, hash: h } = currentInputs(cur)
    try {
      return { plan: templatePlan(input, availableFor(input, installedAdapters(), onboardingPlanContext().sharedKeys, [...personaNamesElsewhere(null, getState().companyAgents, getState().departments)]), { siteUrl: cur.answers.siteUrl }), hash: h }
    } catch {
      return null
    }
  }

  // no plan, or an unedited plan for older answers: the template for these answers (and re-ask Claude if it was his)
  useEffect(() => {
    if (!d || (freshness !== 'none' && freshness !== 'stale')) return
    const rerequest = shouldRerequestAgentPlan(d, onboardingPlanContext())
    const t = buildTemplate()
    if (t) onboardingDispatch({ type: 'templatePlan', plan: t.plan, inputsHash: t.hash })
    if (rerequest) tailorPlan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshness, hash])
  // answers changed since the request made when leaving Goals (a key added on Content): ask again once
  useEffect(() => {
    maybeRetailor()
  }, [hash])

  const plan = d?.plan?.value
  const rows = useMemo(() => (plan ? planRows(plan) : []), [plan])
  useEffect(() => {
    if (!rows.length) return
    if (!focused || !rows.some((r) => rowKey(r) === focused)) setFocused(rowKey(rows[0]!))
  }, [rows, focused])

  if (!d) return null
  const edit = (next: NonNullable<typeof plan>): void => {
    if (plan && next !== plan) onboardingDispatch({ type: 'editPlan', plan: next })
  }
  const focusRow = (key: string): void => {
    setFocused(key)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`)?.focus())
  }
  const h: PlanRowHandlers = {
    focused,
    editing,
    onFocus: (r) => setFocused(rowKey(r)),
    onToggle: (r) => plan && edit(toggleInclude(plan, r)),
    onRemove: (r) => {
      if (!plan) return
      const i = rows.findIndex((x) => rowKey(x) === rowKey(r))
      edit(removeRow(plan, r))
      const nextRow = rows[i + 1] ?? rows[i - 1]
      if (nextRow && isRemovable(r)) focusRow(rowKey(nextRow))
    },
    onStartRename: (r) => setEditing(rowKey(r)),
    onRename: (r, name) => {
      setEditing(null)
      if (plan) edit(renameRow(plan, r, name))
      focusRow(rowKey(r))
    },
    onCancelRename: () => {
      const k = editing
      setEditing(null)
      if (k) focusRow(k)
    },
    onKeyDown: (e, r) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // a key on a control inside the row (the include Switch, a checkbox, ×) is that control's: only arrows move on
      if (e.target !== e.currentTarget && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const i = rows.findIndex((x) => rowKey(x) === rowKey(r))
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const to = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]
        if (to) focusRow(rowKey(to))
      } else if (e.key === ' ') {
        e.preventDefault()
        h.onToggle(r)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        h.onStartRename(r)
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        h.onRemove(r)
      }
    }
  }
  const flags = status?.flags ?? settings?.experimental ?? {}
  const flagsAllOn = !!flags.companies && !!flags.departments && !!flags.vault
  const claude = hasClaudeCli(status)
  const noCli = installedAdapters(status).length === 0
  const keys = draftKeys(d, ctx)
  const credits = keys.fal ? 'fal' : keys.openai ? 'OpenAI' : null
  const source = d.plan?.source
  const name = d.answers.name.trim()
  const team = plan ? teamOf(plan, personasOn) : []
  const tailorLatin = longTailor ? latinLine('ob.plan.tailoring', tone) : null
  return (
    <>
      <StepTitle kicker={<Voiced k="ob.plan.kicker" />}>
        <Voiced k="ob.plan.title" />
      </StepTitle>
      <div className="ob-src" role="status" aria-live="polite">
        {pending ? (
          <span className="ob-shimmer">{copy('ob.plan.tailoring')}</span>
        ) : source === 'agent' ? (
          <Chip tone="ok">{copy('ob.plan.tailored')}</Chip>
        ) : (
          <>
            <Chip>Starter plan</Chip>
            {claude && (
              <>
                <Button size="sm" onClick={tailorPlan}>
                  Tailor with Claude
                </Button>
                <span className="ob-hint">Uses your Claude login · about 1 small call</span>
              </>
            )}
          </>
        )}
        {!pending && <span className="ob-hint">Rename, switch off or remove anything.</span>}
      </div>
      {tailorLatin && (
        <div className="ob-latin">
          <LatinLine pair={tailorLatin} />
        </div>
      )}
      {offer && (
        <div className="ob-banner">
          <span>Claude tailored a plan for you</span>
          <span className="ob-banner__acts">
            <Button size="sm" variant="primary" onClick={useOfferedOnboardingPlan}>
              Use it
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissOnboardingOffer}>
              Keep mine
            </Button>
          </span>
        </div>
      )}
      {freshness === 'staleEdited' && (
        <div className="ob-banner">
          <span>Your answers changed</span>
          <span className="ob-banner__acts">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const t = buildTemplate()
                if (t) onboardingDispatch({ type: 'rebuildPlan', plan: t.plan, inputsHash: t.hash })
              }}
            >
              Rebuild plan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onboardingDispatch({ type: 'keepPlan', inputsHash: hash })}>
              Keep
            </Button>
          </span>
        </div>
      )}
      {noCli && <div className="ob-warn">Install Claude Code so agents can work. Tasks will wait on the board.</div>}
      <div className="ob-charter">
        <Corners />
        {plan && team.length > 0 && (
          <section className="ob-team" aria-label={t.sr('ob.plan.team.sr', { count: team.filter((m) => m.include).length })}>
            <h2 className="ob-charter__h">{copy('ob.ready.team')}</h2>
            <div className="ob-team__row" style={{ ['--ob-team-cols' as string]: Math.min(3, team.length) }}>
              {team.map((m) => (
                <TeamCard
                  key={m.ref}
                  member={m}
                  color={deptColor(plan, m.ref) ?? color ?? null}
                  renaming={renaming === m.ref}
                  onToggle={() => h.onToggle({ kind: 'agent', ref: m.ref })}
                  onStartRename={() => setRenaming(m.ref)}
                  onRename={(v) => {
                    setRenaming(null)
                    edit(m.persona ? renamePersona(plan, m.ref, v) : renameRow(plan, { kind: 'agent', ref: m.ref }, v))
                  }}
                  onCancelRename={() => setRenaming(null)}
                />
              ))}
            </div>
          </section>
        )}
        {plan && team.length > 0 && <MeanderRule />}
        <div className="ob-plan" ref={listRef} role="grid" aria-label="Your team for the first week" data-autofocus-within="">
          {!plan ? (
            <div className="ob-hint">Building your starter plan…</div>
          ) : (
            groupPlan(plan).map((g) => <PlanDepartmentCard key={g.key ?? 'company'} group={g} plan={plan} h={h} />)
          )}
        </div>
      </div>
      {!flagsAllOn && (
        <div className="ob-consent">
          <Switch checked={d.enableFlags} onChange={(v) => onboardingDispatch({ type: 'setEnableFlags', on: v })} label="Turn on Departments, Board and Passport vault (beta)" />
          <div>
            <div>Turn on Departments, Board and Passport vault (beta)</div>
            {!d.enableFlags && <div className="ob-hint">You'll get the company, tasks and schedules, but no departments, agents or passport notes.</div>}
          </div>
        </div>
      )}
      <p className="ob-fine">
        Costs nothing until you start. Agents use your {agentLogin(installedAdapters(status))} login.{credits ? ` Image runs use your ${credits} credits.` : ''} Nothing is posted, sent or paid without your approval.
      </p>
      {!name && <p className="ob-hint ob-hint--warn">Give your business a name on the About step first.</p>}
    </>
  )
}

/** The department colour of an agent (the initials avatar with personas off). */
function deptColor(plan: NonNullable<ReturnType<typeof templatePlan>>, ref: string): string | null {
  const key = plan.agents.find((a) => a.ref === ref)?.departmentKey
  return key ? (presetFor(key)?.color ?? null) : null
}

/** One plinth in "Meet your team": bust 64, lettered name, role · department, personality, first task, include, rename. */
function TeamCard({
  member: m,
  color,
  renaming,
  onToggle,
  onStartRename,
  onRename,
  onCancelRename
}: {
  member: TeamMember
  color: string | null
  renaming: boolean
  onToggle: () => void
  onStartRename: () => void
  onRename: (v: string) => void
  onCancelRename: () => void
}): React.JSX.Element {
  const renameLabel = t.sr('ob.plan.agent.rename', { persona: m.name })
  return (
    <TeamPlinth member={m} color={color} size={64} className={m.include ? '' : 'is-off'}>
      {m.personality && <div className="rm-plinth__pers">{m.personality}</div>}
      {m.firstTask && (
        <div className="rm-plinth__task" title={m.firstTask}>
          {t('ob.plan.agent.firstTask', { task: m.firstTask })}
        </div>
      )}
      {renaming ? (
        <div className="ob-plinth__rename">
          <PersonaRename initial={m.name} label={renameLabel} onDone={onRename} onCancel={onCancelRename} maxLength={m.persona ? 24 : 40} />
        </div>
      ) : (
        <div className="ob-plinth__acts">
          <Switch checked={m.include} onChange={onToggle} label={`Include ${m.name}`} />
          <button type="button" className="ob-plinth__rename-btn" aria-label={renameLabel} title={renameLabel} onClick={onStartRename}>
            <span aria-hidden>✎</span> Rename
          </button>
        </div>
      )}
    </TeamPlinth>
  )
}
