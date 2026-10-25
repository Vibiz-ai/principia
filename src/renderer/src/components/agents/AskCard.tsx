/**
 * One open ask (LIVE.md §6 "Ask card"): what the agent wants, and buttons that say exactly what happens.
 * ⌘↩ = allow, ⌘⌫ = deny when `hotkeys` is on. `pty` asks type into the visible terminal dialog (A1, A9).
 */
import { useEffect, useRef, useState } from 'react'
import type { Ask, AskOption } from '@shared/live'
import { answerText, optionOf } from '../../lib/live'
import { hotkeyBlocked } from '../../lib/hotkeys'
import { providerLabel, useStore } from '../../state/store'
import { answerAsk, focusAgent } from '../../state/live'
import { openApproval } from '../../state/authoring'
import { Button, Kbd, Popover, RelativeTime } from '../ui'
import { Icon } from '../Icon'
import { ApprovalCard } from '../author/ApprovalCard'
import { SlackDraftCard } from '../slack/SlackDraftCard'
import { loadSlackDrafts, openSlackDraft, useSlack } from '../../state/slack'

const LABEL: Partial<Record<AskOption['kind'], string>> = {
  allow: 'Allow once',
  allow_step: 'Allow for this step',
  deny: 'Deny',
  focus: 'Open terminal'
}

export function AskCard(props: { ask: Ask; hotkeys?: boolean; compact?: boolean; onOpen?: () => void }): React.JSX.Element {
  if (props.ask.kind === 'slack_reply') return <SlackReplyAsk ask={props.ask} hotkeys={props.hotkeys} compact={props.compact} />
  return props.ask.kind === 'approval' ? <ApprovalAsk ask={props.ask} hotkeys={props.hotkeys} compact={props.compact} /> : <PlainAskCard {...props} />
}

/** A `slack_reply` ask (SLACK.md §8.3, §12.4) renders the draft card of its Slack draft. */
function SlackReplyAsk({ ask, hotkeys = false, compact = false }: { ask: Ask; hotkeys?: boolean; compact?: boolean }): React.JSX.Element {
  const draftId = ask.slackDraftId ?? null
  const draft = useSlack((s) => (draftId ? s.drafts[draftId] : undefined))
  useEffect(() => {
    if (draftId && !draft) void loadSlackDrafts()
  }, [draftId, draft])
  if (draft) return <SlackDraftCard draft={draft} hotkeys={hotkeys} compact={compact} />
  return (
    <div className="ask-card ask-card--compact" role="group" aria-label={ask.title}>
      <div className="ask-card__head">
        <span className="aglyph aglyph--needs">◆</span>
        <span className="ask-card__title">{ask.title}</span>
        <span className="ask-card__age">
          <RelativeTime iso={ask.createdAt} />
        </span>
      </div>
      {ask.question && <div className="ask-card__detail selectable">{ask.question}</div>}
      {ask.status === 'open' && draftId && (
        <div className="ask-card__actions">
          <Button size="sm" variant="primary" onClick={() => void openSlackDraft(draftId)}>
            Review
          </Button>
        </div>
      )}
    </div>
  )
}

/** An `approval` ask (AUTHORING.md §2.2) renders the approval card of its draft. */
function ApprovalAsk({ ask, hotkeys = false, compact = false }: { ask: Ask; hotkeys?: boolean; compact?: boolean }): React.JSX.Element {
  const draft = useStore((s) => (ask.draftId ? s.drafts[ask.draftId] : undefined))
  if (draft) return <ApprovalCard draft={draft} hotkeys={hotkeys} compact={compact} />
  return (
    <div className="ask-card ask-card--compact" role="group" aria-label={ask.title}>
      <div className="ask-card__head">
        <span className="aglyph aglyph--needs">◆</span>
        <span className="ask-card__title">{ask.title}</span>
        <span className="ask-card__age">
          <RelativeTime iso={ask.createdAt} />
        </span>
      </div>
      {ask.status === 'open' && ask.draftId && (
        <div className="ask-card__actions">
          <Button size="sm" variant="primary" onClick={() => void openApproval(ask.draftId!)}>
            Review
          </Button>
        </div>
      )}
    </div>
  )
}

function PlainAskCard({ ask, hotkeys = false, compact = false, onOpen }: { ask: Ask; hotkeys?: boolean; compact?: boolean; onOpen?: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [note, setNote] = useState(false)
  const [full, setFull] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const allow = optionOf(ask, 'allow')
  const deny = optionOf(ask, 'deny')
  const choices = ask.options.filter((o) => o.kind === 'choice')
  const isQuestion = ask.kind === 'question'
  const open = ask.status === 'open'

  const send = async (opt: AskOption | null, extra?: { text?: string; message?: string }): Promise<void> => {
    if (!open || busy) return
    setBusy(true)
    await answerAsk({ askId: ask.id, optionId: opt?.id, ...extra })
    setBusy(false)
  }
  const openTerminal = (): void => {
    if (onOpen) onOpen()
    else void focusAgent(ask.agentId, ask.id)
  }
  const choose = (o: AskOption): void => {
    if (o.kind === 'focus') return openTerminal()
    // pty denies are a single key in the terminal dialog: a note could never reach the agent, so none is sent
    if (o.kind === 'deny') return void send(o, text.trim() && !isQuestion && ask.channel !== 'pty' ? { message: text.trim() } : undefined)
    void send(o)
  }

  useEffect(() => {
    if (!hotkeys || !open) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.altKey || e.ctrlKey || hotkeyBlocked(e.target, ref.current)) return
      if (e.key === 'Enter' && allow) {
        e.preventDefault()
        void send(allow)
      } else if (e.key === 'Backspace' && deny && !(e.target instanceof HTMLInputElement && e.target.value)) {
        e.preventDefault()
        void send(deny, text.trim() && ask.channel !== 'pty' ? { message: text.trim() } : undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotkeys, open, allow?.id, deny?.id, text])

  const input = ask.toolInput != null ? JSON.stringify(ask.toolInput, null, 2) : null
  const pty = ask.channel === 'pty'
  // CHAT-UI.md: a Claude chat's ask (stdio, on a session) opens the chat, not a terminal
  const chatAsk = ask.channel === 'stdio' && !!ask.sessionId
  return (
    <div ref={ref} className={`ask-card ${compact ? 'ask-card--compact' : ''} ${open ? '' : 'is-closed'}`} role="group" aria-label={`${providerLabel(ask.provider)} needs you: ${ask.title}`}>
      <div className="ask-card__head">
        <span className="aglyph aglyph--needs">◆</span>
        <span className="ask-card__title">{isQuestion ? (ask.question ?? ask.title) : ask.title}</span>
        <span className="ask-card__age">
          <RelativeTime iso={ask.createdAt} />
        </span>
      </div>
      {ask.detail && !isQuestion && (
        <div className="ask-card__detail mono selectable" title={ask.detail}>
          {ask.detail}
        </div>
      )}
      {input && !isQuestion && (
        <button type="button" className="link-btn ask-card__full" onClick={(e) => setFull(e.currentTarget.getBoundingClientRect())}>
          Show full input
        </button>
      )}
      {full && input && (
        <Popover anchor={full} onClose={() => setFull(null)} width={460}>
          <pre className="ask-card__json selectable">{input}</pre>
        </Popover>
      )}
      {(isQuestion || (note && !pty)) && open && (
        <input
          className="input input--sm ask-card__input"
          autoFocus={note}
          value={text}
          maxLength={isQuestion ? 8000 : 2000}
          placeholder={isQuestion ? 'Type an answer, then Return' : 'Tell the agent why (optional), then Deny'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.metaKey && text.trim()) {
              e.preventDefault()
              if (isQuestion) void send(null, { text: text.trim() })
              else if (deny) void send(deny, { message: text.trim() })
            }
          }}
        />
      )}
      {open ? (
        <div className="ask-card__actions">
          {choices.map((o) => (
            <Button key={o.id} size="sm" disabled={busy} onClick={() => choose(o)}>
              {o.label}
            </Button>
          ))}
          {ask.options
            .filter((o) => o.kind !== 'choice' && o.kind !== 'allow_always' && o.kind !== 'focus')
            .map((o) => (
              <Button key={o.id} size="sm" variant={o.kind === 'allow' ? 'primary' : 'secondary'} disabled={busy} onClick={() => choose(o)} kbd={hotkeys ? (o.kind === 'allow' ? '⌘↩' : o.kind === 'deny' ? '⌘⌫' : undefined) : undefined}>
                {o.label || LABEL[o.kind]}
              </Button>
            ))}
          {deny && !isQuestion && !note && !pty && (
            <Button size="sm" variant="ghost" onClick={() => setNote(true)} title="Deny with a message to the agent">
              Add a note…
            </Button>
          )}
          <span className="flex1" />
          {(pty || ask.kind === 'trust' || ask.sessionId || ask.options.some((o) => o.kind === 'focus')) && (
            <Button size="sm" variant="ghost" icon={chatAsk ? 'chat' : 'terminal'} onClick={openTerminal}>
              {chatAsk ? 'Open chat' : 'Open terminal'}
            </Button>
          )}
        </div>
      ) : (
        <div className="ask-card__resolved text-tertiary">
          <Icon name="check" size={12} /> {answerText(ask) ?? 'Canceled'}
        </div>
      )}
      {pty && open && !compact && <div className="ask-card__hint text-tertiary">Principia types your answer into the terminal dialog. {hotkeys && <><Kbd>⌘↩</Kbd> allow · <Kbd>⌘⌫</Kbd> deny</>}</div>}
    </div>
  )
}
