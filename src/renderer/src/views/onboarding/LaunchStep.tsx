/**
 * S7 Launching (docs/ONBOARDING.md §2, §7): the live list fed by onboarding:progress, clone progress, and on failure
 * Retry (resume at the failed step), Continue without this (soft steps) and Discard (confirmed). No Back, no Esc.
 */
import { Button } from '../../components/ui'
import { departmentsEnabled } from '@shared/company'
import { LatinLine } from '../../components/roman'
import { fnv1a } from '@shared/roman'
import { loadingLine, useCopy, useTone } from '../../lib/voice'
import { useStore } from '../../state/store'
import { canRetry, discard, isSoftStep, launch, skipStep, useFlowLocal } from './actions'
import { StepTitle, useAfter } from './bits'
import { failureLine, launchRows, type LaunchRow } from './model'

const GLYPH: Record<LaunchRow['status'], string> = { done: '✓', running: '', failed: '✕', pending: '·', skipped: '–' }

export function LaunchStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const progress = useStore((s) => s.onboardingProgress)
  const settings = useStore((s) => s.settings)
  const launchError = useFlowLocal((s) => s.launchError)
  const copy = useCopy()
  const tone = useTone()
  const failed = d?.step === 'failed'
  // VOICE.md §3.9: the Latin joins the plain line only once the wait passes 2 s, and never on a failure
  const long = useAfter(2000, !!d && !failed)
  if (!d) return null
  const name = d.answers.name.trim() || 'your business'
  const line = loadingLine('launch', fnv1a(name), tone, { name })
  const events = !d.journalId || progress.journalId === d.journalId || progress.journalId === null ? progress.steps : {}
  const rows = launchRows(events, {
    hasCode: !!d.hasCode && (d.repos.length > 0 || !!d.github),
    hasKey: d.content.wants && d.content.keySource === 'stash',
    departments: d.enableFlags || departmentsEnabled(settings?.experimental)
  })
  const failedRow = rows.find((r) => r.status === 'failed')
  const clone = progress.clone && (!d.journalId || progress.clone.journalId === d.journalId) ? progress.clone : null
  const retryable = canRetry(d)
  return (
    <>
      <StepTitle>{copy('ob.launch.title', { name })}</StepTitle>
      <p className="ob-sub ob-sub--latin">{long && line.latin ? <LatinLine pair={line.latin} /> : null}</p>
      <div className="ob-steps" role="list" aria-label="Setup progress">
        {rows.map((r) => {
          const cloning = r.key === 'code' && r.status === 'running' && clone
          return (
            <div key={r.key} role="listitem" className={`ob-st ob-st--${r.status}`}>
              <span className="ob-st__g" aria-hidden>
                {r.status === 'running' ? <span className="spinner" /> : GLYPH[r.status]}
              </span>
              <span className="ob-st__label">{cloning ? `Cloning ${clone.fullName}…` : r.label}</span>
              <span className="ob-st__r">
                {cloning ? (
                  <span className="ob-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clone.percent ?? undefined} aria-label={clone.line}>
                    <i style={{ width: `${clone.percent ?? 15}%` }} className={clone.percent === null ? 'is-indeterminate' : ''} />
                  </span>
                ) : r.status === 'skipped' ? (
                  'skipped'
                ) : (
                  r.detail
                )}
              </span>
            </div>
          )
        })}
      </div>
      {failed && (
        <div className="ob-err" role="alert">
          <div>{failedRow ? failureLine(failedRow) : launchError ? `Couldn't finish the setup: ${launchError}` : 'Setup was interrupted.'}</div>
          {!retryable && <div className="ob-hint">The answers for this setup aren't on this Mac any more. Discard it and start again.</div>}
          <div className="ob-err__acts">
            {retryable && (
              <Button variant="primary" onClick={() => void launch()} data-autofocus="">
                Retry
              </Button>
            )}
            {failedRow && isSoftStep(failedRow.step) && d.journalId && <Button onClick={() => void skipStep(failedRow.step)}>Continue without this</Button>}
            <Button variant="ghost" onClick={() => void discard()} data-autofocus={retryable ? undefined : ''}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
