/** S3 Voice (docs/ONBOARDING.md §2): six vibe cards (3×2, arrows, 1–6), or describe it, plus words to avoid. */
import { useEffect } from 'react'
import { DEFAULT_VIBE, VIBES, VIBE_INFO, vibeSample } from '@shared/onboarding'
import { AutoTextarea } from '../../components/ui'
import { useCopy } from '../../lib/voice'
import { onboardingDispatch, useStore } from '../../state/store'
import { StepTitle, VibeGrid, Voiced } from './bits'
import { digitKey } from './model'

export function VoiceStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const copy = useCopy()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const n = digitKey(e)
      if (n === null || n > VIBES.length) return
      e.preventDefault()
      onboardingDispatch({ type: 'setAnswers', patch: { voiceVibe: VIBES[n - 1] } })
      ;(document.querySelectorAll<HTMLElement>('.ob-vibe')[n - 1] ?? null)?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!d) return null
  const a = d.answers
  const name = a.name
  return (
    <>
      <StepTitle>{copy('ob.voice.title')}</StepTitle>
      <p className="ob-sub"><Voiced k="ob.voice.sub" /></p>
      <VibeGrid
        items={VIBES.map((v) => ({ value: v, label: VIBE_INFO[v].label, sample: vibeSample(v, name) }))}
        value={a.voiceVibe ?? DEFAULT_VIBE}
        onChange={(v) => onboardingDispatch({ type: 'setAnswers', patch: { voiceVibe: v } })}
      />
      <div className="ob-two ob-two--gap">
        <label className="ob-field">
          <span className="ob-field__label">Or describe it</span>
          <AutoTextarea
            minRows={2}
            maxRows={5}
            value={a.voiceText}
            maxLength={600}
            placeholder="Warm, a little nerdy about fermentation…"
            onChange={(e) => onboardingDispatch({ type: 'setAnswers', patch: { voiceText: e.target.value } })}
          />
        </label>
        <label className="ob-field">
          <span className="ob-field__label">
            Words to avoid <span className="ob-optional">(optional)</span>
          </span>
          <AutoTextarea
            minRows={2}
            maxRows={5}
            value={a.avoid}
            maxLength={300}
            placeholder="cheap, artisanal, hustle"
            onChange={(e) => onboardingDispatch({ type: 'setAnswers', patch: { avoid: e.target.value } })}
          />
        </label>
      </div>
    </>
  )
}
