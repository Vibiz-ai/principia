/**
 * One-line reply to an idle session (LIVE.md §4.3): Return writes the text + Return into its terminal. Above it, what
 * the agent last said (its turn's final message, or the cleaned screen tail), so the reply has context.
 */
import { useState } from 'react'
import type { AgentNode } from '@shared/live'
import { lastSaid } from '../../lib/live'
import { replyToAgent } from '../../state/live'
import { Button } from '../ui'
import { peekChat } from '../../state/chat'

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
  // CHAT-UI.md: a Claude chat opens as the chat, not a terminal
  const chat = !!agent.sessionId && peekChat(agent.sessionId)?.mode === 'chat'
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
          <Button size="sm" variant="ghost" icon={chat ? 'chat' : 'terminal'} onClick={onOpen}>
            {chat ? 'Open chat' : 'Open terminal'}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Home's "answered" row: what the agent said, and one way on, into the full chat (or its terminal), where you see
 * the whole conversation you are replying to. No reply box here: a one-line input under a clipped answer is too
 * small to answer well.
 */
export function AnsweredCard({ agent, onOpen }: { agent: AgentNode; onOpen: () => void }): React.JSX.Element {
  const said = lastSaid(agent)
  const chat = !!agent.sessionId && peekChat(agent.sessionId)?.mode === 'chat'
  const label = chat ? 'Open chat to reply' : 'Open terminal to reply'
  return (
    <div className="reply-box reply-box--answered" data-home="answered" onClick={(e) => e.stopPropagation()}>
      {said && (
        <button type="button" className="reply-box__said reply-box__said--open selectable" title={label} aria-label={`${agent.title} said: ${said}. ${label}`} onClick={onOpen}>
          {said}
        </button>
      )}
      <div className="reply-box__row">
        <Button size="sm" variant="primary" icon={chat ? 'chat' : 'terminal'} onClick={onOpen} data-home="open-chat">
          {label}
        </Button>
      </div>
    </div>
  )
}
