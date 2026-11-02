/**
 * "Create <Name> from this chat?" (shared/chatCompany.ts): the confirmation a chat's principia_propose_company call
 * (or the "New company from chat" button) puts up. Name, brief and logo are editable; nothing is created here:
 * "Set up <Name>" opens the onboarding "From a prompt" with it (views/onboarding/fromChat.ts), where the plan is
 * reviewed before launch. "Not now" tells the chat the founder declined. One card at a time, oldest first.
 */
import { useMemo, useState } from 'react'
import { EMBLEM_VARIANTS, emblemDataUrl, type CompanyProposal, type EmblemVariant } from '@shared/chatCompany'
import { cardDefaults, logoNote, repoLabel, type CardEdits } from '../lib/chatCompany'
import { useStore } from '../state/store'
import { confirmChatCard, declineChatCard } from '../views/onboarding/fromChat'
import { Sheet } from './ui'

const VARIANT_LABEL: Record<EmblemVariant, string> = { arch: 'Arch', ring: 'Ring', tablet: 'Tablet' }

export function ChatCompanyCardHost(): React.JSX.Element | null {
  const first = useStore((s) => s.chatProposals[0] ?? null)
  const onboardingOpen = useStore((s) => !!s.onboarding?.open)
  if (!first || onboardingOpen) return null
  return <ChatCompanyCard key={first.id} p={first} />
}

export function ChatCompanyCard({ p }: { p: CompanyProposal }): React.JSX.Element {
  const [edits, setEdits] = useState<CardEdits>(() => cardDefaults(p))
  const [busy, setBusy] = useState(false)
  const name = edits.name.trim()
  const previewName = name || edits.brief.trim().split('\n')[0] || 'New company'
  const emblems = useMemo(() => EMBLEM_VARIANTS.map((v) => ({ v, url: emblemDataUrl(previewName, v) })), [previewName])
  const repo = repoLabel(p)
  const canGo = !busy && (!!name || edits.brief.trim().length >= 10)
  const go = async (): Promise<void> => {
    if (!canGo) return
    setBusy(true)
    await confirmChatCard(p, edits).finally(() => setBusy(false))
  }
  const title = name ? `Create ${name} from this chat?` : 'Create a new company from this chat?'
  return (
    <Sheet
      title={title}
      width={560}
      onCancel={() => void declineChatCard(p)}
      cancelLabel="Not now"
      onPrimary={() => void go()}
      primaryLabel={busy ? 'Opening…' : name ? `Set up ${name}` : 'Set up company'}
      primaryDisabled={!canGo}
      footerLeft={<span className="text-tertiary chat-co__foot">Nothing is created until you launch the plan.</span>}
    >
      <div className="chat-co">
        <p className="chat-co__lead text-secondary">
          {p.sessionTitle ? (
            <>
              From <b className="chat-co__strong">{p.sessionTitle}</b>.{' '}
            </>
          ) : null}
          Principia plans its departments, agents and first tasks from this brief. You review the plan before anything is set up.
        </p>
        <label className="chat-co__field">
          <span className="chat-co__label">Name</span>
          <input className="input" value={edits.name} maxLength={80} placeholder="e.g. Sunday Bakery" data-autofocus="" onChange={(e) => setEdits({ ...edits, name: e.target.value })} />
        </label>
        <label className="chat-co__field">
          <span className="chat-co__label">Brief</span>
          <textarea className="input chat-co__brief" value={edits.brief} maxLength={6000} placeholder="What it is, for whom, the first goals…" onChange={(e) => setEdits({ ...edits, brief: e.target.value })} />
        </label>
        {repo && (
          <div className="chat-co__row">
            <span className="chat-co__label">Code</span>
            <span className="mono chat-co__repo" title={p.repo?.kind === 'local' ? p.repo.path : p.repo?.url}>
              {repo}
            </span>
          </div>
        )}
        <div className="chat-co__row chat-co__row--top">
          <span className="chat-co__label">Logo</span>
          <div className="chat-co__logos" role="radiogroup" aria-label="Logo">
            {emblems.map(({ v, url }) => {
              const on = edits.logo.kind === 'emblem' && edits.logo.variant === v
              return (
                <button key={v} type="button" role="radio" aria-checked={on} className={`chat-co__logo ${on ? 'is-sel' : ''}`} onClick={() => setEdits({ ...edits, logo: { kind: 'emblem', variant: v } })} title={`${VARIANT_LABEL[v]} emblem`}>
                  <span className="logo-pick__img logo-pick__img--plain">
                    <img src={url} alt="" draggable={false} />
                  </span>
                  <span className="chat-co__logo-name">{VARIANT_LABEL[v]}</span>
                </button>
              )
            })}
            <button type="button" role="radio" aria-checked={edits.logo.kind === 'initials'} className={`chat-co__logo ${edits.logo.kind === 'initials' ? 'is-sel' : ''}`} onClick={() => setEdits({ ...edits, logo: { kind: 'initials' } })} title="The initial on the coin">
              <span className="logo-pick__img chat-co__initial">{previewName.trim().charAt(0).toUpperCase() || 'P'}</span>
              <span className="chat-co__logo-name">Initial</span>
            </button>
          </div>
        </div>
        <div className="chat-co__note text-tertiary">{logoNote(p, edits.logo)}</div>
      </div>
    </Sheet>
  )
}
