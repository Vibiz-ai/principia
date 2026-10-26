/**
 * Business-first onboarding layer (docs/ONBOARDING.md §1, §2, §9). Mounted once in App.tsx next to the overlays.
 * - First run: fills the window on --bg (App hides the sidebar and rail). "+ New company": over the app on --overlay,
 *   with a ✕ that saves and closes.
 * - VOICE.md §5.7 stage: the flat app --bg with the line-art arch (ArchFrame, .14) behind the 600 px column (≥ 1100 px),
 *   tesserae for progress, Cinzel titles; at ≥ 1100 px the Business Passport on the left is drawn live inside a mono
 *   (white/silver) beam (Plan and Ready carry their own, so the rail steps aside there).
 * - A 600 px column (760 on Plan) with the progress row, the step, and the footer (Back left, Skip + primary right).
 * - Start now in playful tone ends in the launch ceremony (Ceremony.tsx) before the flow closes.
 * - Keys: ↵ / ⌘↵ primary, ⌘[ / ⌥← back, Esc save and close (refused on first run and once launching), ⌘O choose
 *   folders on Connect. App-wide chords are held back while the flow is open.
 * - Focus: the step title (announced through a polite live region) on every step change, then [data-autofocus].
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { OnboardingDraft, StepKey } from '@shared/onboarding'
import { isPersonal } from '../../lib/companyModel'
import { t, useCopy } from '../../lib/voice'
import { Button } from '../../components/ui'
import { ArchFrame, PassportTablet, Tesserae } from '../../components/roman'
import BeamBorder from '../../components/ui/border-beam'
import { canContinue, canGoBack, draftGoals, hasProgress, isLaunchStep, stepIndex } from '../../state/onboarding'
import { closeOnboarding, continueOnboarding, getState, onboardingDispatch, useStore } from '../../state/store'
import { AboutStep } from './AboutStep'
import { back, finishCeremony, getLocal, landOnHome, next, setLocal, skipBrief, useFlowLocal } from './actions'
import { BriefStep } from './BriefStep'
import { Ceremony } from './Ceremony'
import { ConnectStep, connectKeys } from './ConnectStep'
import { ContentStep } from './ContentStep'
import { GoalsStep } from './GoalsStep'
import { LaunchStep } from './LaunchStep'
import { blocksAppChord, flowKey, passportMeta, showsProgress } from './model'
import { NameStep } from './NameStep'
import { PlanStep } from './PlanStep'
import { ReadyStep, readyKeys } from './ReadyStep'
import { StartStep } from './StartStep'
import { VoiceStep } from './VoiceStep'

export function OnboardingFlow(): React.JSX.Element | null {
  const o = useStore((s) => s.onboarding)
  const hasDraft = useStore((s) => !!s.onboardingDraft)
  if (!o?.open || !hasDraft) return null
  return <Flow mode={o.mode} resumable={o.resumable} />
}

interface FooterSpec {
  left?: ReactNode
  back: boolean
  skip?: { label: string; run: () => void }
  primary?: { label: string; kbd: string; disabled: boolean; run: () => void }
}

/** The footer for a step (§2 shared chrome). null: no footer (Launching, Ready keep their actions in the body). */
export function footerFor(step: StepKey, d: OnboardingDraft, banner: boolean, reading = false): FooterSpec | null {
  const cont = { label: 'Continue', kbd: '↵', disabled: !canContinue(d), run: next }
  switch (step) {
    case 'start':
      // five doors step 5: no "Agents found" here; the Claude check is plain words on the last step
      return { back: false, primary: banner ? undefined : cont }
    // ⌘↵ only: ↵ is a new line in the brief
    case 'brief':
      return {
        back: canGoBack(d),
        skip: { label: 'Answer questions instead', run: skipBrief },
        primary: { label: reading ? 'Reading…' : 'Build my plan', kbd: '⌘↵', disabled: reading || !canContinue(d), run: next }
      }
    case 'connect':
      return { back: canGoBack(d), skip: { label: 'No code after all', run: () => onboardingDispatch({ type: 'skipConnect' }) }, primary: cont }
    case 'name':
    case 'goals':
      return { back: canGoBack(d), primary: cont }
    case 'about':
    case 'voice':
      return { back: canGoBack(d), skip: { label: 'Skip', run: next }, primary: cont }
    case 'content':
      return {
        back: canGoBack(d),
        skip: {
          label: 'Not now',
          run: () => {
            onboardingDispatch({ type: 'setContentWants', wants: false })
            next()
          }
        },
        primary: cont
      }
    case 'plan':
      return {
        back: canGoBack(d),
        left: (
          <span className="ob-keyhints" aria-hidden>
            <kbd className="ob-kbd">↑↓</kbd> move <kbd className="ob-kbd">space</kbd> toggle <kbd className="ob-kbd">↵</kbd> rename <kbd className="ob-kbd">⌫</kbd> remove
          </span>
        ),
        primary: { label: `Create ${d.answers.name.trim() || 'business'}`, kbd: '⌘↵', disabled: !canContinue(d), run: next }
      }
    default:
      return null
  }
}

/** The step's title for the polite live region: always the plain form (t.sr), never a joke (VOICE.md §2). */
export function stepTitle(step: StepKey, d: OnboardingDraft, mode: 'first' | 'new'): string {
  const name = d.answers.name.trim()
  switch (step) {
    case 'start':
      return t.sr(mode === 'first' ? 'ob.start.title.first' : 'ob.start.title.new')
    case 'brief':
      return t.sr('ob.brief.title')
    case 'connect':
      return t.sr('ob.connect.title')
    case 'name':
      return t.sr('ob.name.title')
    case 'about':
      return t.sr('ob.about.title')
    case 'voice':
      return t.sr('ob.voice.title')
    case 'goals':
      return t.sr('ob.goals.title')
    case 'content':
      return t.sr('ob.content.title')
    case 'plan':
      return t.sr('ob.plan.title')
    case 'launching':
    case 'failed':
      return t.sr('ob.launch.title', { name: name || 'your business' })
    case 'ready':
      return t.sr('ob.ready.title', { name: name || 'Your business' })
  }
}

function StepBody({ step, banner, color }: { step: StepKey; banner: boolean; color: string }): React.JSX.Element | null {
  switch (step) {
    case 'start':
      return <StartStep showBanner={banner} />
    case 'brief':
      return <BriefStep />
    case 'connect':
      return <ConnectStep />
    case 'name':
      return <NameStep />
    case 'about':
      return <AboutStep />
    case 'voice':
      return <VoiceStep />
    case 'goals':
      return <GoalsStep />
    case 'content':
      return <ContentStep />
    case 'plan':
      return <PlanStep color={color} />
    case 'launching':
    case 'failed':
      return <LaunchStep />
    case 'ready':
      return <ReadyStep color={color} />
  }
}

/** Steps that carry their own passport or a wide charter: the rail steps aside (docs/voice.html Plan and Ready). */
const NO_RAIL: readonly StepKey[] = ['plan', 'ready']

function Flow({ mode, resumable }: { mode: 'first' | 'new'; resumable: boolean }): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const copy = useCopy()
  // the next palette colour, fixed when the flow opens (the new company joins the list on launch)
  const [coverColor] = useState(() => `var(--series-${(getState().companies.filter((c) => !isPersonal(c) && !c.archivedAt).length % 5) + 1})`)
  const ref = useRef<HTMLDivElement>(null)
  const banner = !!d && resumable && hasProgress(d)
  const step: StepKey = banner ? 'start' : (d?.step ?? 'start')
  const reading = useFlowLocal((l) => l.briefReading)
  const footer = d ? footerFor(step, d, banner, reading) : null
  /**
   * Esc / ✕. On Ready (new company) the company exists: closing is "I'll review first" (nothing turned on), so it still
   * lands in the new company instead of leaving it unseen behind the overlay. Elsewhere: save and close.
   */
  const closeFlow = (s: StepKey): void => {
    if (s === 'ready') {
      // the company exists: closing opens it on Home, where "Start the first week?" waits (nothing turned on)
      if (mode === 'new') void landOnHome({ scheduleRefs: [] })
      return
    }
    closeOnboarding()
  }
  // latest values for the window listeners (installed once)
  const ceremonyUp = useFlowLocal((l) => l.ceremony) !== null
  // a ceremony belongs to this flow on Ready only: one left over (the flow closed some other way) must never make the
  // next flow inert or swallow its keys
  const ceremony = ceremonyUp && step === 'ready'
  useEffect(
    () => () => {
      if (getLocal().ceremony) setLocal({ ceremony: null })
    },
    []
  )
  const live = useRef({ footer, banner, step, ceremony })
  live.current = { footer, banner, step, ceremony }

  useEffect(() => {
    // capture: hold back app-wide chords (they would navigate behind the flow); ⌘O picks folders on Connect
    const onCapture = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.ctrlKey && e.code === 'KeyO' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        if (live.current.step === 'connect') connectKeys.pick?.()
        return
      }
      if (blocksAppChord(e)) e.stopPropagation()
    }
    // bubble: after the step's own handlers, which claim their keys with preventDefault
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return
      const t = (e.target as HTMLElement | null) ?? document.body
      const k = flowKey(e, {
        tag: t.tagName ?? 'BODY',
        type: (t as HTMLInputElement).type,
        role: t.getAttribute?.('role') ?? null,
        editable: !!t.isContentEditable,
        enterPrimary: !!t.hasAttribute?.('data-enter-primary')
      })
      if (!k) return
      const { footer: f, banner: b, step: s, ceremony: cer } = live.current
      // the ceremony (VOICE.md §8): Esc skips, ↵ enters (a focused button keeps its own ↵), nothing goes back
      if (cer) {
        if (k === 'back') return
        if (k === 'primary' && !e.metaKey && t.tagName === 'BUTTON') return
        e.preventDefault()
        void finishCeremony()
        return
      }
      if (k === 'primary') {
        if (b) {
          e.preventDefault()
          continueOnboarding()
        } else if (s === 'ready') {
          if (!e.metaKey && t.tagName === 'BUTTON') return
          e.preventDefault()
          readyKeys.start?.()
        } else if (f?.primary && !f.primary.disabled) {
          // ⌘↵ only on Plan (a stray ↵ must never create the company) and Brief (↵ is a new line there)
          if ((s === 'plan' || s === 'brief') && !e.metaKey) return
          e.preventDefault()
          f.primary.run()
        }
      } else if (k === 'back') {
        if (f?.back) {
          e.preventDefault()
          back()
        }
      } else if (k === 'close') {
        e.preventDefault()
        closeFlow(s)
      }
    }
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // focus: the title first (screen readers hear the step), then the step's first control
  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelector<HTMLElement>('[data-ob-title]')?.focus({ preventScroll: true })
    const t = setTimeout(() => {
      const body = root.querySelector('.ob-body')
      const el =
        body?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
        body?.querySelector<HTMLElement>('[data-autofocus-within] [aria-checked="true"], [data-autofocus-within] [tabindex="0"]') ??
        body?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([disabled]), textarea:not([disabled])')
      el?.focus({ preventScroll: true })
    }, 40)
    return () => clearTimeout(t)
  }, [step, banner])

  if (!d) return null
  const idx = showsProgress(step) ? stepIndex({ ...d, step }) : null
  const closable = mode === 'new' && d.step !== 'launching' && d.step !== 'failed'
  const meta = passportMeta(d, draftGoals(d))
  const rail = !NO_RAIL.includes(step)
  const wide = step === 'plan'

  return (
    <div className={`ob-layer ob-layer--${mode}`} role="dialog" aria-modal="true" aria-label="Set up your business" ref={ref}>
      {mode === 'first' && <div className="ob-dragband drag" aria-hidden />}
      <div className={`ob-panel ${rail ? '' : 'ob-panel--norail'}`} aria-hidden={ceremony ? true : undefined} inert={ceremony ? true : undefined}>
        {rail && (
          <aside className="ob-rail" aria-hidden>
            {/* a white/silver trace travels the edge while the passport is being drawn (VOICE.md §5.12: mono only) */}
            <BeamBorder size="line" colorVariant="mono" theme="dark" strength={1} beamWidth={2}>
              <PassportTablet name={d.answers.name} oneLiner={d.answers.oneLiner} color={coverColor} meta={meta} sealed={false} layout="portrait" className="rm-pp--beam" />
            </BeamBorder>
            <div className="ob-rail__hint">{copy('ob.rail.hint')}</div>
          </aside>
        )}
        <div className={`ob-flow ${wide ? 'ob-flow--wide' : ''}`}>
          <ArchFrame className="ob-arch" />
          {closable && (
            <button
              type="button"
              className="ob-close"
              aria-label={step === 'ready' ? 'Close' : t.sr('ob.close.sr')}
              title={step === 'ready' ? 'Close (Esc)' : `${t.sr('ob.close.sr')} (Esc)`}
              onClick={() => closeFlow(step)}
            >
              ✕
            </button>
          )}
          <div className="ob-sr" aria-live="polite">
            {stepTitle(step, d, mode)}
          </div>
          {idx && (
            <div className="ob-progress">
              <div className="ob-col ob-progress__in">
                <Tesserae index={idx.index - 1} total={idx.total} />
              </div>
            </div>
          )}
          <div className="ob-body">
            <div className="ob-col">
              <div className="ob-step" key={`${step}${banner ? ':b' : ''}`}>
                <StepBody step={step} banner={banner} color={coverColor} />
              </div>
            </div>
          </div>
          {footer && !isLaunchStep(step) && (
            <div className="ob-foot">
              <div className="ob-col ob-foot__in">
                <div className="ob-foot__left">
                  {footer.back && (
                    <Button variant="ghost" onClick={back} title="Back (⌘[)">
                      ← Back
                    </Button>
                  )}
                  {footer.left}
                </div>
                <div className="ob-foot__right">
                  {footer.skip && (
                    <Button variant="ghost" onClick={footer.skip.run}>
                      {footer.skip.label}
                    </Button>
                  )}
                  {footer.primary && (
                    <Button variant="primary" onClick={footer.primary.run} disabled={footer.primary.disabled} kbd={footer.primary.kbd}>
                      {footer.primary.label}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {ceremony && <Ceremony color={coverColor} />}
    </div>
  )
}
