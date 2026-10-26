/**
 * S5 Content (docs/ONBOARDING.md §2): "Want to start posting already?" Only what works today is selectable: image
 * workflows with the founder's own fal / OpenAI key. Social posting, email and the Vibiz key are "Coming soon".
 * The key value lives only inside KeyField; the draft keeps the stash handle and last 4 characters.
 */
import { useEffect, useState } from 'react'
import { KEY_PROVIDERS, type KeyProvider } from '@shared/onboarding'
import { Button, Segmented } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { draftKeys } from '../../state/onboarding'
import { useCopy } from '../../lib/voice'
import { onboardingDispatch, onboardingPlanContext, useStore } from '../../state/store'
import { Chip, KeyField, StepTitle, Voiced } from './bits'
import { openLink } from './actions'

/** Stash handles minted in this window session; a draft holding any other one survived a restart (stash is gone). */
const sessionStashes = new Set<string>()
export function rememberStash(id: string): void {
  sessionStashes.add(id)
}

export function ContentStep(): React.JSX.Element | null {
  const d = useStore((s) => s.onboardingDraft)
  const status = useStore((s) => s.onboardingStatus)
  const copy = useCopy()
  const [restarted] = useState(() => !!d?.content.stashId && !sessionStashes.has(d.content.stashId))
  const shared = status?.sharedKeys
  const sharedName = shared?.FAL_KEY ? 'FAL_KEY' : shared?.OPENAI_API_KEY ? 'OPENAI_API_KEY' : null
  const wants = !!d?.content.wants
  const keySource = d?.content.keySource ?? null

  // a stash from before a restart is gone in main: drop the handle, ask for the key again
  useEffect(() => {
    if (restarted) onboardingDispatch({ type: 'keyForget' })
  }, [restarted])
  // a Shared key exists: this business uses it, nothing is copied
  useEffect(() => {
    if (wants && sharedName && keySource === null) onboardingDispatch({ type: 'useSharedKey', provider: sharedName === 'FAL_KEY' ? 'fal' : 'openai' })
  }, [wants, sharedName, keySource])

  if (!d) return null
  const keys = draftKeys(d, onboardingPlanContext())
  const ready = keys.fal || keys.openai
  const c = d.content
  const provider: KeyProvider = c.provider ?? 'fal'
  const waitlist = status?.waitlistUrl ?? null
  return (
    <>
      <StepTitle>{copy('ob.content.title')}</StepTitle>
      <p className="ob-sub"><Voiced k="ob.content.sub" /></p>
      <div>
        <Segmented<'yes' | 'no'>
          className="ob-seg"
          items={[
            { value: 'yes', label: 'Yes, set it up' },
            { value: 'no', label: 'Not now' }
          ]}
          value={wants ? 'yes' : 'no'}
          onChange={(v) => onboardingDispatch({ type: 'setContentWants', wants: v === 'yes' })}
        />
      </div>
      {!wants ? (
        <p className="ob-hint">Image workflows stay off. Turn them on any time in Settings › Keys & secrets.</p>
      ) : (
        <>
          <div className="ob-rows">
            <div className="ob-cap">
              <span className="ob-cap__ic">
                <Icon name="artifacts" size={14} />
              </span>
              <div className="ob-cap__tx">
                <div className="ob-row__name">Images</div>
                <div className="ob-cap__d">Carousels, product photos, ad creatives, thumbnails · 10 ready-made image workflows</div>
              </div>
              {ready ? <Chip tone="ok">Ready</Chip> : <Chip tone="warn">Add a key below</Chip>}
            </div>
            <div className="ob-cap is-dis" aria-disabled="true">
              <span className="ob-cap__ic">
                <Icon name="spark" size={14} />
              </span>
              <div className="ob-cap__tx">
                <div className="ob-row__name">Social posting</div>
                <div className="ob-cap__d">Coming soon. For now, posts are saved as ready-to-copy drafts and land in review.</div>
              </div>
              <Chip>Coming soon</Chip>
            </div>
            <div className="ob-cap is-dis" aria-disabled="true">
              <span className="ob-cap__ic">
                <Icon name="chat" size={14} />
              </span>
              <div className="ob-cap__tx">
                <div className="ob-row__name">Email</div>
                <div className="ob-cap__d">Coming soon.</div>
              </div>
              <Chip>Coming soon</Chip>
            </div>
          </div>
          <div className="ob-keys">
            <div className="ob-kcard ob-kcard--soon">
              <div className="ob-kcard__h">
                Vibiz key <Chip tone="accent">Recommended</Chip>
                <Chip>Coming soon</Chip>
              </div>
              <div className="ob-kcard__d">One key for images, email, scraping and more, billed in one place. Not available yet.</div>
              <div className="ob-row-inline">
                <Button size="sm" disabled={c.vibizInterest} onClick={() => onboardingDispatch({ type: 'setVibizInterest', on: true })}>
                  {c.vibizInterest ? 'Noted' : 'Notify me'}
                </Button>
                {waitlist && (
                  <button type="button" className="link-btn" onClick={() => openLink(waitlist)}>
                    Join the waitlist ↗
                  </button>
                )}
              </div>
            </div>
            <div className="ob-kcard">
              <div className="ob-kcard__h">Use my own key</div>
              {sharedName ? (
                <div className="ob-kcard__d">
                  <span className="ob-check" aria-hidden>
                    ✓
                  </span>{' '}
                  You already have {sharedName} in Shared keys. This business will use it.
                </div>
              ) : (
                <KeyField
                  provider={provider}
                  onProvider={(p) => onboardingDispatch({ type: 'setProvider', provider: p })}
                  onChecked={(p, res) => {
                    if (res.stashId) rememberStash(res.stashId)
                    onboardingDispatch({ type: 'keyChecked', provider: p, result: res })
                  }}
                  kept={{
                    last4: c.provider === provider ? c.last4 : undefined,
                    inUse: c.provider === provider && c.keySource === 'stash' && !!c.stashId,
                    pendingUnknown: c.provider === provider && !!c.stashId && c.keySource === null,
                    restarted: restarted && !c.stashId
                  }}
                  onUseAnyway={() => onboardingDispatch({ type: 'keyUseAnyway' })}
                  onDismiss={() => onboardingDispatch({ type: 'keyForget' })}
                />
              )}
            </div>
          </div>
          {!sharedName && c.keySource === 'stash' && <p className="ob-hint">{KEY_PROVIDERS[provider]} will be saved for this business only when you launch.</p>}
        </>
      )}
    </>
  )
}
