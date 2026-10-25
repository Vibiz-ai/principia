/** S1b Name (docs/ONBOARDING.md §2): the business name (the only required answer), one line, website or Instagram. */
import { useCopy } from '../../lib/voice'
import { onboardingDispatch, useStore } from '../../state/store'
import { StepTitle, Voiced } from './bits'
import { instagramHandle } from './model'

export function NameStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const copy = useCopy()
  if (!d) return null
  const a = d.answers
  const web = a.siteUrl || a.instagram
  const insta = !!instagramHandle(web)
  // five doors step 5: step 1 shapes this one. A business running is asked where it sells; an idea has no link yet
  const running = d.lives === 'running'
  const idea = d.lives === 'idea'
  return (
    <>
      <StepTitle><Voiced k="ob.name.title" /></StepTitle>
      <p className="ob-sub">{copy('ob.name.sub')}</p>
      <label className="ob-field">
        <span className="ob-field__label">Name</span>
        <input
          className="input"
          placeholder="e.g. Sunday Bakery"
          value={a.name}
          maxLength={80}
          data-autofocus=""
          aria-required="true"
          onChange={(e) => onboardingDispatch({ type: 'setAnswers', patch: { name: e.target.value } })}
        />
      </label>
      <label className="ob-field">
        <span className="ob-field__label">In one line, what is it?</span>
        <input
          className="input"
          placeholder="Sourdough delivered to offices in Lisbon"
          value={a.oneLiner}
          maxLength={200}
          onChange={(e) => onboardingDispatch({ type: 'setAnswers', patch: { oneLiner: e.target.value } })}
        />
      </label>
      {!idea && <label className="ob-field">
        <span className="ob-field__label">
          {running ? 'Where do you sell? Your website, shop or Instagram' : 'Got a website or Instagram?'} <span className="ob-optional">(optional)</span>
        </span>
        <input
          className="input"
          placeholder="sundaybakery.com or @sundaybakery"
          value={web}
          maxLength={2048}
          spellCheck={false}
          onChange={(e) => onboardingDispatch({ type: 'setAnswers', patch: { siteUrl: e.target.value, instagram: '' } })}
        />
        <span className="ob-hint">
          {insta ? 'Saved as a link. You can connect Instagram at the end.' : "We'll read your site's title and description to fill in the next step."}
        </span>
      </label>}
    </>
  )
}
