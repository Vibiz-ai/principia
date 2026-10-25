/** S4 Goals (docs/ONBOARDING.md §2): up to 3 chips (keys 1–8), "Something else" opens a one-line field. */
import { useEffect, useRef, useState } from 'react'
import { GOALS, GOAL_INFO, GOAL_MAX, type GoalKey } from '@shared/onboarding'
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
  // design §6.3: a 4th pick is refused; the chips shake once and the line says why
  const [full, setFull] = useState(0)
  const goalsNow = useRef(d?.answers.goals ?? [])
  goalsNow.current = d?.answers.goals ?? []
  const toggle = (g: GoalKey): void => {
    if (!goalsNow.current.includes(g) && goalsNow.current.length >= GOAL_MAX) return setFull((n) => n + 1)
    setFull(0)
    onboardingDispatch({ type: 'toggleGoal', goal: g })
  }
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
      toggle(g)
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
      <div key={full} className={full ? 'ob-shake' : undefined}>
      <ChipGroup
        label="Goals for the next 30 days"
        selected={goals}
        onToggle={toggle}
        items={GOALS.map((g) => ({
          value: g,
          label: g === 'other' ? 'Something else…' : GOAL_INFO[g].label,
          disabled: GOAL_INFO[g].codeOnly && !hasCode,
          title: GOAL_INFO[g].codeOnly && !hasCode ? 'Appears when you connect code' : undefined
        }))}
      />
      </div>
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
        {full ? 'Pick up to 3. Unpick one first.' : goals.length >= GOAL_MAX ? `${GOAL_MAX} of ${GOAL_MAX} picked. ${copy('ob.goals.four')}` : !hasCode ? '“Fix bugs & ship features” appears when you connect code.' : null}
      </div>
    </>
  )
}
