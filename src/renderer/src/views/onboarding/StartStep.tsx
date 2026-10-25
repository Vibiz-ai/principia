/**
 * S0 Start (docs/ONBOARDING.md §2): code or idea, the resume banner, agent detection and the explore / quick links.
 * A new company first picks how to start: Guided (the code question below, then today's questions), From a prompt
 * (the Brief step) or From a repo (Connect, then straight to the plan).
 */
import { Fragment } from 'react'
import type { Lives } from '@shared/onboarding'
import type { AdapterId } from '@shared/types'
import { Button } from '../../components/ui'
import { attempt, continueOnboarding, onboardingDispatch, openQuickCompany, refreshOnboardingStatus, refreshProviders, skipOnboarding, startOverOnboarding, useStore } from '../../state/store'
import { isLaunchStep, stepIndex } from '../../state/onboarding'
import { t, useCopy } from '../../lib/voice'
import { ChoiceGroup, StepTitle } from './bits'
import { openLink } from './actions'

export const INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup'

export function StartStep({ showBanner }: { showBanner: boolean }): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const mode = useStore((s) => s.onboarding?.mode ?? 'new')
  const userName = useStore((s) => s.info?.userName ?? null)
  const copy = useCopy()
  if (!d) return null
  // five doors step 5 (design §6.1, §6.8): one question with three answers, no key hints, no "Agents found" line
  const lives: Lives | null = d.lives ?? (d.hasCode === true ? 'code' : null)
  const first = userName?.trim().split(/\s+/)[0]
  return (
    <>
      {showBanner && <ResumeBanner />}
      <StepTitle welcome={mode === 'first'}>{mode === 'first' && first ? `${copy('ob.start.title.first')}, ${first}` : copy(mode === 'first' ? 'ob.start.title.first' : 'ob.start.title.new')}</StepTitle>
      <p className="ob-sub">{copy('ob.start.sub')}</p>
      <div className="ob-q" id="ob-q-where">
        {copy('ob.start.where')}
      </div>
      <ChoiceGroup<Lives>
        className="ob-choices--3"
        label={t.sr('ob.start.where')}
        value={lives}
        onChange={(v) => onboardingDispatch({ type: 'chooseLives', lives: v })}
        choices={[
          { value: 'running', title: copy('ob.lives.running'), desc: copy('ob.lives.running.desc') },
          { value: 'code', title: copy('ob.lives.code'), desc: copy('ob.lives.code.desc') },
          { value: 'idea', title: copy('ob.lives.idea'), desc: copy('ob.lives.idea.desc') }
        ]}
      />
      <div className="ob-links">
        {mode === 'first' ? (
          <button type="button" className="link-btn" onClick={() => void skipOnboarding()}>
            {copy('ob.start.explore')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                onboardingDispatch({ type: 'chooseStart', start: 'prompt' })
                onboardingDispatch({ type: 'next' })
              }}
            >
              {copy('ob.start.prompt.link')}
            </button>
            <span aria-hidden> · </span>
            <button type="button" className="link-btn" onClick={openQuickCompany}>
              {copy('ob.start.quick')}
            </button>
          </>
        )}
      </div>
    </>
  )
}

function ResumeBanner(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const copy = useCopy()
  if (!d) return null
  const idx = stepIndex(d)
  const name = d.answers.name.trim() || 'Your business'
  const midLaunch = !!d.journalId && isLaunchStep(d.step)
  return (
    <div className="ob-banner" role="region" aria-label="Saved setup">
      <span>
        {idx ? (
          <>
            {/* screen readers hear the plain sentence (VOICE.md §9); the visible one may be playful */}
            <span aria-hidden="true">
              <Bolded text={copy('ob.resume', { name: NAME_MARK, n: idx.index, total: idx.total })} bold={name} />
            </span>
            <span className="ob-sr">{t.sr('ob.resume', { name, n: idx.index, total: idx.total })}</span>
          </>
        ) : (
          <>
            Pick up where you left off? <b>{name}</b> · setting up
          </>
        )}
      </span>
      <span className="ob-banner__acts">
        <Button size="sm" variant="primary" onClick={continueOnboarding} data-autofocus="">
          Continue
        </Button>
        {!midLaunch && (
          <Button size="sm" variant="ghost" onClick={startOverOnboarding}>
            Start over
          </Button>
        )}
      </span>
    </div>
  )
}

/** A sentinel for the name inside a copy string, so the name can be bold without splitting the copy entry. */
const NAME_MARK = '\u0000'
function Bolded({ text, bold }: { text: string; bold: string }): React.JSX.Element {
  const parts = text.split(NAME_MARK)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <b>{bold}</b>}
          {p}
        </Fragment>
      ))}
    </>
  )
}

const DOT: Partial<Record<AdapterId, string>> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }

/** Footer left on Start: "Agents found: ● Claude ● Codex · Recheck", or the no-CLI note. */
export function AgentsFound(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const status = useStore((s) => s.onboardingStatus)
  const found: AdapterId[] = status?.providers?.length
    ? status.providers.filter((p) => p.installed && p.adapter !== 'shell').map((p) => p.adapter)
    : providers.filter((p) => p.available && p.id !== 'shell').map((p) => p.id)
  const recheck = (): void => {
    void attempt(async () => {
      await refreshProviders(true)
      await refreshOnboardingStatus()
    }, 'Recheck')
  }
  const known = providers.length > 0 || !!status
  if (known && found.length === 0)
    return (
      <span className="ob-agents">
        No agent CLI found. You can finish setup, but agents need Claude Code, Codex, Cursor or Gemini to work.{' '}
        <button type="button" className="link-btn" onClick={() => openLink(INSTALL_URL)}>
          How to install ↗
        </button>{' '}
        ·{' '}
        <button type="button" className="link-btn" onClick={recheck}>
          Recheck
        </button>
      </span>
    )
  return (
    <span className="ob-agents">
      Agents found:{' '}
      {!known
        ? 'checking…'
        : found.map((a) => (
            <span key={a} className="ob-agents__one">
              <span className="provider-dot" style={{ background: `var(--provider-${a})` }} />
              {DOT[a] ?? a}
            </span>
          ))}{' '}
      ·{' '}
      <button type="button" className="link-btn" onClick={recheck}>
        Recheck
      </button>
    </span>
  )
}
