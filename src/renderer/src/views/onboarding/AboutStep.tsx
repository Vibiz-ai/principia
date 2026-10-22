/** S2 About (docs/ONBOARDING.md §2): what you sell and to whom, prefilled from the scan / site read with source pills. */
import { useEffect, useMemo } from 'react'
import type { OnboardingAnswers } from '@shared/onboarding'
import { PREFILL_SOURCE_LABEL, prefillWithSources, type PrefillField } from '@shared/onboardingPrefill'
import { useCopy } from '../../lib/voice'
import { onboardingDispatch, useStore } from '../../state/store'
import { Chip, StepTitle } from './bits'
import { useFlowLocal } from './actions'

export function AboutStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const reading = useFlowLocal((s) => s.siteReading)
  const copy = useCopy()
  const scan = d?.hasCode ? d.scan : undefined
  const site = d?.site
  // fill only the empty answers, on arrival and whenever a scan or site read lands
  useEffect(() => {
    onboardingDispatch({ type: 'applyPrefill' })
  }, [scan, site])
  const pre = useMemo(() => prefillWithSources(scan, site), [scan, site])
  if (!d) return null
  const a = d.answers
  const set = (patch: Partial<OnboardingAnswers>): void => onboardingDispatch({ type: 'setAnswers', patch })
  const pill = (f: PrefillField): React.JSX.Element | null => {
    const src = pre.sources[f]
    const v = pre.answers[f]
    return src && v && a[f].trim() === v.trim() ? <Chip tone="accent">{PREFILL_SOURCE_LABEL[src]}</Chip> : null
  }
  const hint = d.hasCode ? copy('ob.about.hint') : site ? "Filled in from your site. Fix anything that's off." : null
  const siteTitle = site?.title || site?.ogTitle || site?.siteName
  // code branch with nothing to prefill the name from: the one required field gets focus first
  const nameMissing = !!d.hasCode && !a.name.trim()
  return (
    <>
      <StepTitle>{copy('ob.about.title')}</StepTitle>
      {hint && <p className="ob-sub">{hint}</p>}
      {(reading || siteTitle) && (
        <div className="ob-pills">
          {reading ? <Chip>Reading your site…</Chip> : <Chip tone="ok">Read “{siteTitle}” ✓</Chip>}
        </div>
      )}
      <div className="ob-two">
        {d.hasCode && (
          <label className="ob-field">
            <span className="ob-field__label">Name {pill('name')}</span>
            <input
              className="input"
              value={a.name}
              maxLength={80}
              aria-required="true"
              data-autofocus={nameMissing ? '' : undefined}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
        )}
        <label className="ob-field">
          <span className="ob-field__label">Website {pill('siteUrl')}</span>
          <input className="input" value={a.siteUrl} placeholder="acme.com" maxLength={2048} spellCheck={false} onChange={(e) => set({ siteUrl: e.target.value })} />
        </label>
      </div>
      <label className="ob-field">
        <span className="ob-field__label">What it is {pill('oneLiner')}</span>
        <input className="input" value={a.oneLiner} placeholder="In one line" maxLength={200} onChange={(e) => set({ oneLiner: e.target.value })} />
      </label>
      <label className="ob-field">
        <span className="ob-field__label">What you sell {pill('products')}</span>
        <input
          className="input"
          value={a.products}
          placeholder="e.g. a weekly sourdough box, €18"
          maxLength={500}
          data-autofocus={nameMissing ? undefined : ''}
          onChange={(e) => set({ products: e.target.value })}
        />
      </label>
      <label className="ob-field">
        <span className="ob-field__label">Who buys it</span>
        <input className="input" value={a.audience} placeholder="e.g. offices of 10–50 people in Lisbon" maxLength={500} onChange={(e) => set({ audience: e.target.value })} />
      </label>
      {d.hasCode && !!d.scan?.stack.length && (
        <div className="ob-pills" aria-label="Stack">
          {d.scan.stack.slice(0, 8).map((s) => (
            <Chip key={s}>{s}</Chip>
          ))}
        </div>
      )}
    </>
  )
}
