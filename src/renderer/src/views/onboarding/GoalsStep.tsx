/** S4 Goals (docs/ONBOARDING.md §2): up to 3 chips (keys 1–8), "Something else" opens a one-line field. */
import { useEffect, useRef } from 'react'
import { GOALS, GOAL_INFO, GOAL_SOFT_MAX } from '@shared/onboarding'
import { useCopy } from '../../lib/voice'
import { onboardingDispatch, useStore } from '../../state/store'
import { ChipGroup, StepTitle, Voiced } from './bits'
import { digitKey } from './model'

export function GoalsStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const copy = useCopy()
  const hasCode = !!d?.hasCode
  const other = useRef<HTMLInputElement>(null)
  const otherOn = !!d?.answers.goals.includes('other')
  const wasOther = useRef(otherOn)
  useEffect(() => {
    if (otherOn && !wasOther.current) other.current?.focus()
    wasOther.current = otherOn
  }, [otherOn])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const n = digitKey(e)
      if (n === null || n > GOALS.length) return
      const g = GOALS[n - 1]!
      if (GOAL_INFO[g].codeOnly && !hasCode) return
      e.preventDefault()
      onboardingDispatch({ type: 'toggleGoal', goal: g })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasCode])
  if (!d) return null
  const goals = d.answers.goals
  return (
    <>
      <StepTitle>{copy('ob.goals.title')}</StepTitle>
      <p className="ob-sub"><Voiced k="ob.goals.sub" /></p>
      <ChipGroup
        label="Goals for the next 30 days"
        selected={goals}
        onToggle={(g) => onboardingDispatch({ type: 'toggleGoal', goal: g })}
        items={GOALS.map((g) => ({
          value: g,
          label: g === 'other' ? 'Something else…' : GOAL_INFO[g].label,
          disabled: GOAL_INFO[g].codeOnly && !hasCode,
          title: GOAL_INFO[g].codeOnly && !hasCode ? 'Appears when you connect code' : undefined
        }))}
      />
      {otherOn && (
        <label className="ob-field ob-field--top">
          <span className="ob-field__label">Something else</span>
          <input
            ref={other}
            className="input"
            placeholder="e.g. Find a bakery space to rent"
            value={d.answers.goalOther}
            maxLength={120}
            onChange={(e) => onboardingDispatch({ type: 'setAnswers', patch: { goalOther: e.target.value } })}
          />
        </label>
      )}
      <div className="ob-hint ob-hint--top" role="status" aria-live="polite">
        {goals.length > GOAL_SOFT_MAX ? copy('ob.goals.four') : !hasCode ? '“Fix bugs & ship features” appears when you connect code.' : null}
      </div>
    </>
  )
}
