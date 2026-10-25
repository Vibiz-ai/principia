/**
 * CHAT-UI.md §4: a Claude session as a chat. The transcript scrolls above, the composer sits at the bottom; tool use,
 * approvals and questions are cards in the conversation. The Terminal toggle hands the same conversation to the real
 * TUI and back.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import type { ChatDecision, ChatImage } from '@shared/chat'
import { buildBlocks, duration } from '@shared/chatView'
import { Icon } from '../Icon'
import { hive, errorCode, errorMessage } from '../../lib/hive'
import { confirmNative } from '../../lib/hive'
import { useChat, reloadChat, peekChat } from '../../state/chat'
import { getState, restartSession, toast, toastError } from '../../state/store'
import { Blocks } from './ChatCards'
import { Composer } from './Composer'
import '../../styles/chat.css'

const SHOW = 300

export function ChatPane({ session: s, focused }: { session: Session; focused: boolean }): React.JSX.Element {
  const v = useChat(s.id)
  const exited = s.status === 'exited'
  const scroller = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)
  const [pill, setPill] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const blocks = useMemo(() => buildBlocks(v.items), [v.items])
  const shown = showAll || blocks.length <= SHOW ? blocks : blocks.slice(-SHOW)
  const live = !exited && (v.turn === 'working' || v.turn === 'needs' || v.turn === 'starting')
  const openReq = useMemo(() => {
    for (let i = v.items.length - 1; i >= 0; i--) {
      const it = v.items[i]!
      if ((it.kind === 'permission' || it.kind === 'question' || it.kind === 'plan') && it.state === 'open') return it.requestId
    }
    return null
  }, [v.items])

  // stick to the bottom unless the user scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stuck.current) el.scrollTop = el.scrollHeight
    else setPill(true)
  }, [v.items, v.queue, v.turn])

  const answer = (requestId: string, d: ChatDecision): void => {
    void hive.chat.answer({ id: s.id, requestId, decision: d }).catch((e) => toastError(e, 'Answer'))
  }

  const send = async (text: string, images: ChatImage[]): Promise<boolean> => {
    stuck.current = true
    try {
      if (exited) {
        // an ended chat picks up the same conversation in a new session row (Restart), then sends
        await restartSession(s.id)
        const next = getState().focusedSession
        if (!next || next === s.id) return false
        await hive.chat.send({ id: next, text, images })
        return true
      }
      await hive.chat.send({ id: s.id, text, images })
      return true
    } catch (e) {
      toastError(e, 'Send')
      return false
    }
  }

  const stop = (): void => {
    void hive.chat.interrupt({ id: s.id }).catch((e) => toastError(e, 'Stop'))
  }

  const toTerminal = async (command?: string): Promise<void> => {
    await switchToTerminal(s.id, v.turn)
    if (command) toast(`Type ${command} in the terminal`)
  }

  const onNotice = (a: 'retry' | 'openTerminal'): void => {
    if (a === 'openTerminal') void toTerminal()
    else void send('continue', [])
  }

  const elapsed = useElapsed(live ? v.turnStartedAt : null)
  const lastText = [...v.items].reverse().find((i) => i.kind === 'text' && !i.streaming)
  return (
    <div className={`chat-pane ${exited ? 'is-exited' : ''}`} data-turn={v.turn}>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          if (stuck.current) setPill(false)
        }}
      >
        <div className="chat-col">
          {!v.loaded && <div className="chat-notice">Loading the conversation…</div>}
          {v.loaded && v.items.length === 0 && !exited && (
            <div className="chat-empty">
              <Icon name="chat" size={20} />
              <div>Ask Claude anything. It can read and change files in this chat’s folders, run commands and use your company’s tools. It asks before anything risky.</div>
            </div>
          )}
          {blocks.length > shown.length && (
            <button type="button" className="chat-notice chat-notice--btn" onClick={() => setShowAll(true)}>
              {blocks.length - shown.length} earlier messages · Show
            </button>
          )}
          <Blocks blocks={shown} live={live} actions={exited ? null : { answer, hotkeyFor: focused ? openReq : null, cwd: s.cwd }} onNotice={exited ? undefined : onNotice} />
          {live && (
            <div className="chat-working">
              <span className="chat-spin" aria-hidden />
              <span className="shimmer-text">{v.turn === 'needs' ? 'Waiting for you' : `${v.activity ?? 'Working'}…`}</span>
              {elapsed && <span className="chat-meta">{elapsed}</span>}
              {v.turn !== 'starting' && <span className="chat-meta">· esc to stop</span>}
            </div>
          )}
          {(v.turn === 'sleeping' || exited) && v.items.length > 0 && <div className="chat-notice">Resting · your next message picks up where you left off</div>}
          <div aria-live="polite" className="sr-only">
            {!live && lastText && lastText.kind === 'text' ? lastText.md.slice(0, 500) : ''}
          </div>
        </div>
      </div>
      {pill && (
        <button
          type="button"
          className="chat-newpill"
          onClick={() => {
            stuck.current = true
            setPill(false)
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          ↓ New activity
        </button>
      )}
      <div className="chat-dock">
        {v.queue.length > 0 && (
          <div className="chat-queue">
            {v.queue.map((q) => (
              <QueuedRow key={q.id} sessionId={s.id} id={q.id} text={q.text} images={q.images} held={v.turn === 'idle' || v.turn === 'sleeping'} />
            ))}
          </div>
        )}
        <Composer
          sessionId={s.id}
          turn={exited ? 'ended' : v.turn}
          meta={v.meta}
          disabled={!exited && v.mode === 'terminal'}
          exited={exited}
          focused={focused}
          onSend={send}
          onStop={stop}
          onTerminal={(c) => void toTerminal(c)}
          onSetMode={(m) => void hive.chat.setPermissionMode({ id: s.id, mode: m as 'default' }).catch((e) => toastError(e, 'Mode'))}
          onSetModel={(m) => void hive.chat.setModel({ id: s.id, model: m }).catch((e) => toastError(e, 'Model'))}
        />
      </div>
    </div>
  )
}

function QueuedRow({ sessionId, id, text, images, held }: { sessionId: string; id: string; text: string; images: number; held: boolean }): React.JSX.Element {
  const [edit, setEdit] = useState<string | null>(null)
  const save = (t: string | null): void => {
    void hive.chat.queueEdit({ id: sessionId, queueId: id, text: t }).catch((e) => toastError(e, 'Queue'))
    setEdit(null)
  }
  return (
    <div className="chat-queued">
      <Icon name="clock" size={12} />
      <span className="chat-meta">Queued:</span>
      {edit === null ? (
        <span className="chat-queued__text">
          {text}
          {images ? ` (+${images} image${images === 1 ? '' : 's'})` : ''}
        </span>
      ) : (
        <input
          className="chat-input chat-queued__text"
          autoFocus
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save(edit)
            if (e.key === 'Escape') setEdit(null)
          }}
        />
      )}
      <span className="chat-meta">{held ? 'held after Stop' : 'sends when Claude finishes'}</span>
      {edit === null && (
        <button type="button" className="chat-link" onClick={() => setEdit(text)}>
          Edit
        </button>
      )}
      <button type="button" className="chat-link" onClick={() => void hive.chat.interrupt({ id: sessionId, sendNow: true }).catch((e) => toastError(e, 'Send now'))}>
        Send now
      </button>
      <button type="button" className="chat-iconbtn" aria-label="Remove" onClick={() => save(null)}>
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

function useElapsed(since: number | null): string | null {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => setN((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [since])
  if (!since) return null
  const ms = Date.now() - since
  return ms >= 2000 ? duration(ms) : null
}

/** Chat -> Terminal: asks first when Claude is working (CHAT-UI.md §3.5). */
export async function switchToTerminal(id: string, turn: string): Promise<void> {
  let force = false
  if (turn === 'working' || turn === 'needs') {
    const ok = await confirmNative({ message: 'Claude is working. Stop it and open the terminal?', detail: 'Everything Claude did so far stays in the conversation. The terminal continues the same conversation.', confirmLabel: 'Stop and Open Terminal' })
    if (!ok) return
    force = true
  }
  try {
    await hive.chat.toTerminal({ id, force })
  } catch (e) {
    toastError(e, 'Open terminal')
  }
}

/** Terminal -> Chat: allowed when the terminal's turn ended; otherwise offers "Interrupt and switch". */
export async function switchToChat(id: string): Promise<void> {
  try {
    await hive.chat.toChat({ id })
  } catch (e) {
    if (errorCode(e) !== 'conflict') return toastError(e, 'Switch to chat')
    const ok = await confirmNative({ message: errorMessage(e), detail: 'Interrupt Claude in the terminal and continue in the chat?', confirmLabel: 'Interrupt and Switch' })
    if (!ok) return
    try {
      await hive.chat.toChat({ id, force: true })
    } catch (e2) {
      toastError(e2, 'Switch to chat')
    }
  }
  reloadChat(id)
}

/** ⌘K: "Show as terminal" / "Show as chat" for the focused Claude chat (null when it has no chat). */
export function chatModeCommand(s: Pick<Session, 'id' | 'adapter' | 'status'> | null | undefined): { label: string; run: () => void } | null {
  if (!s || s.adapter !== 'claude' || s.status !== 'running') return null
  const v = peekChat(s.id)
  if (!v?.available) return null
  return { label: v.mode === 'chat' ? 'Show this chat as Terminal' : 'Show this chat as Chat', run: () => toggleChatMode(s.id, v.mode, v.turn) }
}

/** Flips a chat between Chat and Terminal (the header toggle, ⌃` and ⌘K "Show as terminal / chat"). */
export function toggleChatMode(id: string, mode: 'chat' | 'terminal', turn: string): void {
  if (mode === 'chat') void switchToTerminal(id, turn)
  else void switchToChat(id)
}

/** Chat | Terminal segmented control for the pane header. ⌃` flips the focused pane. */
export function ChatModeToggle({ session: s, focused = false }: { session: Session; focused?: boolean }): React.JSX.Element | null {
  const v = useChat(s.id)
  const on = s.adapter === 'claude' && v.available && s.status === 'running'
  useEffect(() => {
    if (!on || !focused) return
    const key = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
        e.preventDefault()
        e.stopPropagation()
        toggleChatMode(s.id, v.mode, v.turn)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [on, focused, s.id, v.mode, v.turn])
  if (!on) return null
  return (
    <div className="chat-seg" role="group" aria-label="Show this conversation as">
      <button type="button" className={v.mode === 'chat' ? 'is-on' : ''} aria-pressed={v.mode === 'chat'} onClick={() => v.mode !== 'chat' && void switchToChat(s.id)} title="Chat view: tools as cards, approvals as buttons (⌃`)">
        <Icon name="chat" size={12} /> <span className="chat-seg__l">Chat</span>
      </button>
      <button type="button" className={v.mode === 'terminal' ? 'is-on' : ''} aria-pressed={v.mode === 'terminal'} onClick={() => v.mode !== 'terminal' && void switchToTerminal(s.id, v.turn)} title="The real Claude Code terminal, same conversation (⌃`)">
        <Icon name="terminal" size={12} /> <span className="chat-seg__l">Terminal</span>
      </button>
    </div>
  )
}

/** Above the terminal while a chat's conversation is there. */
export function ChatTerminalBar({ session: s }: { session: Session }): React.JSX.Element | null {
  const v = useChat(s.id)
  if (s.adapter !== 'claude' || !v.available || v.mode !== 'terminal' || s.status !== 'running') return null
  const fresh = v.startedAs === 'terminal'
  return (
    <div className="chat-handbar">
      <Icon name="terminal" size={13} />
      <span>
        {fresh
          ? 'Claude Code in the terminal. Switch to Chat to see this conversation with tools as cards and approvals as buttons.'
          : 'This conversation is in the terminal now: same Claude, same history. What you do here shows up in Chat when you switch back.'}
      </span>
      <span className="flex1" />
      <button type="button" className="chat-btn" onClick={() => void switchToChat(s.id)} title="⌃`">
        <Icon name="chat" size={12} /> {fresh ? 'Show as Chat' : 'Back to Chat'}
      </button>
    </div>
  )
}
