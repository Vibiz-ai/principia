/**
 * Slack reply draft (SLACK.md §8.3, §12.4): Needs-you card in the Agents hub, inline in the Slack thread pane and in
 * the Run view. Edit, then Send (⌘↩) or Discard (⌘⌫). Failed sends keep the card with the error and Retry.
 */
import { useEffect, useRef, useState } from 'react'
import type { SlackDraft, SlackDraftDetail } from '@shared/slack'
import { Button, RelativeTime } from '../ui'
import { Icon } from '../Icon'
import { SLACK_TEXT_MAX, draftEditState, draftReasonText, draftTitle, userName } from '../../lib/slack'
import { slackCall } from '../../lib/slackApi'
import { decideSlackDraft, useNoteSlackUsers, useSlack } from '../../state/slack'
import { navigate } from '../../state/store'
import { Mrkdwn } from './Mrkdwn'
import { useResolve } from './bits'

function inTerminal(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.('.xterm')
}

export function SlackDraftCard({ draft: d, hotkeys = false, compact = false, inThread = false }: { draft: SlackDraft; hotkeys?: boolean; compact?: boolean; inThread?: boolean }): React.JSX.Element {
  const users = useSlack((s) => s.users)
  const focus = useSlack((s) => s.draftFocus)
  const resolve = useResolve()
  const [text, setText] = useState(d.text)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<SlackDraftDetail | null>(null)
  useNoteSlackUsers(detail ? detail.context.map((m) => (m.fromHive ? null : m.userId)) : [])
  const [ctxOpen, setCtxOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const open = d.status === 'pending' || d.status === 'failed'
  const st = draftEditState(text, d.status, busy)
  const reason = draftReasonText(d.reason, d.channelName)

  // a new version from main (e.g. agent re-drafted) replaces the text only while the user hasn't edited it
  const lastServer = useRef(d.text)
  useEffect(() => {
    if (text === lastServer.current) setText(d.text)
    lastServer.current = d.text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.text])
  useEffect(() => {
    if (!open) return
    slackCall('slack:draftGet', { id: d.id }).then(setDetail, () => setDetail(null))
  }, [d.id, open])
  useEffect(() => {
    if (focus?.draftId !== d.id) return
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    ref.current?.querySelector('textarea')?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  const send = async (): Promise<void> => {
    if (!st.canSend) return
    setBusy(true)
    setError(null)
    const r = await decideSlackDraft(d.id, 'send', text !== d.text ? text : undefined)
    setBusy(false)
    if (!r.ok && r.error) setError(r.error)
  }
  const discard = async (): Promise<void> => {
    if (!open || busy) return
    setBusy(true)
    const r = await decideSlackDraft(d.id, 'discard')
    setBusy(false)
    if (!r.ok && r.error) setError(r.error)
  }

  useEffect(() => {
    if (!hotkeys || !open) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.altKey || e.ctrlKey || inTerminal(e.target)) return
      if (document.querySelector('.sheet-layer')) return
      if (e.key === 'Enter') {
        e.preventDefault()
        void send()
      } else if (e.key === 'Backspace' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        void discard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotkeys, open, text, busy])

  const openThread = (): void => void navigate({ name: 'slack', channelId: d.channelId, threadTs: d.threadTs ?? undefined, nonce: Date.now() })
  const newer = detail?.newSinceDraft ?? 0
  return (
    <div ref={ref} className={`sdraft ${compact ? 'sdraft--compact' : ''} ${open ? '' : 'is-closed'} ${d.status === 'failed' ? 'is-failed' : ''}`} role="group" aria-label={draftTitle(d)}>
      <div className="sdraft__head">
        <span className="aglyph aglyph--needs">⚑</span>
        <span className="sdraft__title">{draftTitle(d)}</span>
        <span className="text-tertiary sdraft__who">
          {d.ownerLabel} · <RelativeTime iso={d.createdAt} />
        </span>
        <span className="flex1" />
        {!inThread && (
          <Button size="sm" variant="ghost" icon="chat" onClick={openThread}>
            Open thread
          </Button>
        )}
      </div>
      {reason && <div className="sdraft__reason">{reason}</div>}
      {d.note && <div className="sdraft__reason text-secondary selectable">{d.note}</div>}
      {!inThread && detail && detail.context.length > 0 && (
        <div className="sdraft__ctx">
          <button type="button" className="disclosure__btn" onClick={() => setCtxOpen(!ctxOpen)} aria-expanded={ctxOpen}>
            <Icon name={ctxOpen ? 'chevronDown' : 'chevronRight'} size={12} /> Last {detail.context.length} message{detail.context.length === 1 ? '' : 's'} in the thread
          </button>
          {ctxOpen &&
            detail.context.map((m) => (
              <div key={m.ts} className="sdraft__ctxmsg">
                <span className="sdraft__ctxname">{m.fromHive ? 'Hive' : userName(users[m.userId ?? ''], m.userId)}</span>
                <Mrkdwn text={m.text} resolve={resolve} />
              </div>
            ))}
        </div>
      )}
      {newer > 0 && open && (
        <div className="sdraft__newer">
          {newer} new message{newer === 1 ? '' : 's'} since this draft{' '}
          {!inThread && (
            <button type="button" className="link-btn" onClick={openThread}>
              Read them
            </button>
          )}
        </div>
      )}
      {open ? (
        <>
          {preview ? (
            <div className="sdraft__preview">
              <Mrkdwn text={text} resolve={resolve} />
            </div>
          ) : (
            <textarea
              className={`input textarea sdraft__text ${st.over ? 'is-invalid' : ''}`}
              value={text}
              rows={compact ? 3 : 5}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && e.metaKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              aria-label="Reply text"
              disabled={busy}
            />
          )}
          {(error || (d.status === 'failed' && d.error)) && <div className="sdraft__error selectable">✕ {error ?? d.error}</div>}
          <div className="sdraft__actions">
            <Button variant="primary" size="sm" disabled={!st.canSend} onClick={() => void send()} kbd={hotkeys ? '⌘↩' : undefined}>
              {busy ? 'Sending…' : d.status === 'failed' ? 'Retry' : 'Send'}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void discard()} kbd={hotkeys ? '⌘⌫' : undefined}>
              Discard
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)} aria-pressed={preview}>
              {preview ? 'Edit' : 'Preview'}
            </Button>
            {text !== d.originalText && !preview && (
              <Button size="sm" variant="ghost" onClick={() => setText(d.originalText)} title="Back to the agent’s text">
                Reset
              </Button>
            )}
            <span className="flex1" />
            <span className={`sdraft__count ${st.over ? 'text-failed' : 'text-tertiary'}`}>
              {st.count.toLocaleString()} / {SLACK_TEXT_MAX.toLocaleString()}
            </span>
          </div>
        </>
      ) : (
        <div className="sdraft__resolved text-tertiary">
          <Icon name={d.status === 'sent' ? 'check' : d.status === 'sending' ? 'refresh' : 'close'} size={12} />{' '}
          {d.status === 'sent' ? `Sent${d.edited ? ' (edited)' : ''}` : d.status === 'sending' ? 'Sending…' : d.status === 'expired' ? 'Expired after 7 days' : 'Discarded'}
          {d.decidedAt && (
            <>
              {' · '}
              <RelativeTime iso={d.decidedAt} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
