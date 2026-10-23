/**
 * S0b Brief (docs/ONBOARDING.md §2, "From a prompt"): one large textarea for the founder's description, brief or pitch.
 * "Build my plan" (the footer primary, ⌘↵) asks main to read the answers out of it; read by Claude, the flow jumps to
 * the Plan step, else to Name with what could be read. The brief stays in the draft either way and seeds the Passport.
 */
import { BRIEF_MAX } from '@shared/onboarding'
import { useCopy } from '../../lib/voice'
import { onboardingDispatch, useStore } from '../../state/store'
import { StepTitle } from './bits'
import { useFlowLocal } from './actions'

export function BriefStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const reading = useFlowLocal((l) => l.briefReading)
  const copy = useCopy()
  if (!d) return null
  const brief = d.brief ?? ''
  return (
    <>
      <StepTitle>{copy('ob.brief.title')}</StepTitle>
      <p className="ob-sub">{copy('ob.brief.sub')}</p>
      <label className="ob-field">
        <span className="ob-field__label ob-sr">Your brief</span>
        <textarea
          className="input ob-brief"
          placeholder={'Sunday Bakery\nSourdough and pastries delivered to offices in Lisbon, ordered by Thursday for Friday mornings.\nWe want our first 20 office customers, a simple site and weekly posts on Instagram…'}
          value={brief}
          maxLength={BRIEF_MAX}
          data-autofocus=""
          disabled={reading}
          aria-busy={reading || undefined}
          onChange={(e) => onboardingDispatch({ type: 'setBrief', brief: e.target.value })}
        />
      </label>
      <div className="ob-brief__meta">
        <span className="ob-hint" role="status" aria-live="polite">
          {reading ? <span className="ob-shimmer">{copy('ob.brief.reading')}</span> : 'Read once by Claude to fill in your answers and plan. You review everything before anything is created.'}
        </span>
        <span className="ob-hint">{brief.length > BRIEF_MAX * 0.8 ? `${brief.length.toLocaleString()} / ${BRIEF_MAX.toLocaleString()}` : ''}</span>
      </div>
    </>
  )
}
