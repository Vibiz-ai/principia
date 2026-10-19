/**
 * One-line reply to an idle session (LIVE.md §4.3): Return writes the text + Return into its terminal. Above it, what
 * the agent last said (its turn's final message, or the cleaned screen tail), so the reply has context.
 */
import { useState } from 'react'
import type { AgentNode } from '@shared/live'
import { lastSaid } from '../../lib/live'
import { replyToAgent } from '../../state/live'
import { Button } from '../ui'

export function ReplyBox({ agent, onOpen, autoFocus = false }: { agent: AgentNode; onOpen?: () => void; autoFocus?: boolean }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    const ok = await replyToAgent(agent.id, t)
    setBusy(false)
    if (ok) setText('')
  }
  const said = lastSaid(agent)
  return (
    <div className="reply-box" onClick={(e) => e.stopPropagation()}>
      {said && (
        <div className="reply-box__said selectable" title={agent.report ?? undefined} aria-label={`${agent.title} said`}>
          {said}
        </div>
      )}
      <div className="reply-box__row">
        <input
          className="input input--sm reply-box__input"
          value={text}
          autoFocus={autoFocus}
          disabled={busy}
          maxLength={8000}
          placeholder="Reply…  Return to send"
          aria-label={`Reply to ${agent.title}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {onOpen && (
          <Button size="sm" variant="ghost" icon="terminal" onClick={onOpen}>
            Open terminal
          </Button>
        )}
      </div>
    </div>
  )
}
