/**
 * The chat or its terminal, as one surface for Chats and the agent page (CHAT-UI.md §3.5): the same ChatPane as
 * Claude › Chat, and, when the conversation was handed to the real CLI (Chat | Terminal in the header, ⌃`), that
 * terminal with the bar that brings it back.
 */
import type { Session } from '@shared/types'
import { useChatMode } from '../../state/chat'
import { setState, useStore } from '../../state/store'
import { TerminalPane } from '../TerminalPane'
import { ChatPane, ChatTerminalBar, type ChatWhoProps } from './ChatPane'

export function ChatSurface({ session: s, focused, who }: { session: Session; focused: boolean; who?: ChatWhoProps }): React.JSX.Element | null {
  const mode = useChatMode(s)
  const fontSize = useStore((x) => x.settings?.terminalFontSize ?? 13)
  if (mode === 'chat') return <ChatPane session={s} focused={focused} who={who} />
  if (mode === null) return <div className="chat-pane"><div className="chat-notice">Loading the conversation…</div></div>
  return (
    <div className="chat-surface__term">
      <ChatTerminalBar session={s} />
      <div className="chat-surface__termbody">
        <TerminalPane sessionId={s.id} readOnly={s.status === 'exited'} fontSize={fontSize} focused={focused} onFocus={() => setState({ focusedSession: s.id })} />
      </div>
    </div>
  )
}
