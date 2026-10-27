/**
 * S8 Ready (docs/ONBOARDING.md §2, §7.5; VOICE.md §5.3, §8): the Business Passport as a landscape diploma whose
 * line-drawn seal draws itself when the step first appears (instant with reduced motion). Start now (Autopilot on, ticked schedules on,
 * "works on its own" agents raised) or I'll review first (nothing turned on, the Board). Both land in the focused
 * company; Start now in playful tone plays the launch ceremony first.
 */
import { useEffect, useMemo, useState } from 'react'
import { departmentsEnabled } from '@shared/company'
import { Button, Switch } from '../../components/ui'
import { LatinLine, PassportTablet } from '../../components/roman'
import BeamBorder from '../../components/ui/border-beam'
import { useCopy, usePersonasOn } from '../../lib/voice'
import { draftGoals } from '../../state/onboarding'
import { updateSettings, useStore } from '../../state/store'
import { Chip, NextSteps, StepTitle, useReducedMotion, Voiced } from './bits'
import { landOnHome, useFlowLocal } from './actions'
import { ClaudeCheck } from './ClaudeCheck'
import { ConnectedServiceChips, ConnectionSlot } from '../../components/connections/ConnectionSlot'
import { autonomyLine, launchFacts, nextSteps, passportMeta, readySchedules, summaryParts } from './model'

/** ⌘↵ on Ready = Start now (the flow calls it). */
export const readyKeys: { start: (() => void) | null } = { start: null }

export function ReadyStep({ color }: { color?: string } = {}): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const status = useStore((s) => s.onboardingStatus)
  const settings = useStore((s) => s.settings)
  const mode = useStore((s) => s.onboarding?.mode)
  const result = useFlowLocal((s) => s.result)
  const copy = useCopy()
  const personasOn = usePersonasOn()
  const reduced = useReducedMotion()
  // the seal draws once, when the step first appears (a re-render never replays it)
  const [stamp] = useState(() => !reduced)
  const plan = d?.plan?.value
  const journal = status?.journal && status.journal.id === d?.journalId ? status.journal : null
  const refs = result?.scheduleRefs ?? journal?.scheduleRefs ?? []
  // what the launch really made (a skipped step or the beta switch off makes less than the plan)
  const facts = launchFacts(result?.steps ?? journal?.steps)
  const refsKey = JSON.stringify(refs)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const schedules = useMemo(() => (plan ? readySchedules(plan, refs) : []), [plan, refsKey])
  const [checked, setChecked] = useState<Set<string>>(() => new Set(schedules.filter((s) => !s.costly).map((s) => s.id)))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setChecked(new Set(schedules.filter((s) => !s.costly).map((s) => s.id)))
  }, [schedules])
  // five doors step 5 (design §6.7): nothing starts here. The company opens on Home, which asks "Your team is ready.
  // Start the first week?"; the schedules ticked below are turned on with that answer
  const go = (): void => {
    if (busy) return
    setBusy(true)
    void landOnHome({ scheduleRefs: schedules.filter((s) => checked.has(s.id)).map((s) => s.ref) }).finally(() => setBusy(false))
  }
  useEffect(() => {
    readyKeys.start = () => go()
    return () => {
      readyKeys.start = null
    }
  })
  if (!d || !plan) return null
  const name = d.answers.name.trim() || 'Your business'
  const passport = facts ? facts.passport : d.enableFlags || departmentsEnabled(settings?.experimental)
  const agentsCreated = facts ? facts.agents > 0 : true
  const repoNames = d.hasCode ? [...d.repos.map((r) => r.path.split('/').pop() ?? ''), ...(d.github?.fullName ? [d.github.fullName.split('/')[1] ?? ''] : [])].filter(Boolean) : []
  const auto = autonomyLine(plan, agentsCreated, personasOn)
  return (
    <>
      <StepTitle className="ob-title--ready"><Voiced k="ob.ready.title" vars={{ name }} /></StepTitle>
      <div className="ob-pills">
        {summaryParts(plan, refs.length || undefined, facts).map((p) => (
          <Chip key={p} tone={p.includes('(off)') ? 'sched' : 'neutral'}>
            {p}
          </Chip>
        ))}
      </div>
      <div className="ob-diploma">
        {/* the founded passport catches the light: a white/silver beam travels its frame (VOICE.md §5.12: mono only) */}
        <BeamBorder size="md" colorVariant="mono" theme="dark" strength={1} beamWidth={2} duration={3.3}>
          <PassportTablet name={d.answers.name} oneLiner={d.answers.oneLiner} color={color} meta={passportMeta(d, draftGoals(d))} sealed stampOnMount={stamp} layout="landscape" className="rm-pp--beam" />
        </BeamBorder>
      </div>
      <div className="ob-startbox">
        <div className="ob-q ob-q--flush">
          {copy('ob.ready.next')} <LatinLine k="fortes" className="ob-q__latin" />
        </div>
        <div className="ob-row-inline">
          <Button variant="primary" kbd="⌘↵" onClick={go} disabled={busy} data-autofocus="">
            {copy('ob.ready.open', { name })}
          </Button>
        </div>
        {auto && <div className="ob-hint">{auto}</div>}
        <ClaudeCheck />
        {schedules.length > 0 && (
          <>
            <div className="ob-label">Turn on with the first week</div>
            {schedules.map((s) => (
              <label key={s.id} className="ob-prow ob-prow--flush">
                <input
                  type="checkbox"
                  className="ob-cb"
                  checked={checked.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(checked)
                    if (e.target.checked) next.add(s.id)
                    else next.delete(s.id)
                    setChecked(next)
                  }}
                />
                <span className="ob-prow__main">
                  <span className="ob-prow__name">{s.label}</span>
                </span>
                <span className="ob-prow__end">{s.cost ? <Chip tone="warn">{s.cost}</Chip> : <Chip title="Uses your Claude plan. No extra charge from Principia.">on your plan</Chip>}</span>
              </label>
            ))}
          </>
        )}
      </div>
      {/* CONNECTIONS.md §4.3 S16: the keys setup saved (fal, OpenAI, Firecrawl…) are the business's connections from now on */}
      {result?.companyId && (
        <div className="ob-startbox">
          <div className="ob-label">Connected for {name}</div>
          <ConnectedServiceChips companyId={result.companyId} />
          <ConnectionSlot companyId={result.companyId} service={d.hasCode ? 'posthog' : 'stripe'} purpose="agentTools" />
        </div>
      )}
      <NextSteps items={nextSteps({ plan, name, repoNames, passport, agentsCreated, ...(facts?.passport ? { notes: facts.notes } : {}) })} />
      {mode === 'first' && (
        <div className="ob-consent ob-consent--solid">
          <Switch checked={!!settings?.launchAtLogin} onChange={(v) => void updateSettings({ launchAtLogin: v })} label="Launch at Login" />
          <div>
            <div>Launch at Login</div>
            <div className="ob-hint">Open Principia when you log in, so schedules keep firing.</div>
          </div>
        </div>
      )}
    </>
  )
}
