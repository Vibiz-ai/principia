/**
 * Chats (five doors ⌘4, design §4.6): every conversation in this company. Pressing Chats switches the LEFT SIDEBAR
 * into the conversations list (components/chats/ChatsSidebar: filters Live / All / Agents / Direct, search, New chat,
 * "‹ Back" to the menu); this main area is only the open conversation, with its optional right panel.
 * - An agent conversation is the agent's own live chat, the same layout as its page (AgentConversation).
 * - A direct chat (Claude or Codex, repo sessions, department chats) is that chat itself (CHAT-UI.md), with the
 *   session's panel; a session that is not a chat shows who and where, what it is doing, its questions and its last
 *   answer (code companies get a Terminal button, C7: no Terminal elsewhere).
 * - A conversation with the team, or your private one with one agent (CHAT-UI.md §7): the thread itself.
 * - With nothing picked (or "New conversation") a company opens New conversation: To: Principia picks ▾, the line
 *   that says who will answer, and your recent conversations. All companies opens the last chat you had open.
 * - Empty: the company's own empty state ("No chats in Harbor Dental Group yet…").
 * - `task:<id>` (CHAT-UI.md §8.4): a task as a chat (TaskLiveView): its brief, what the agent says, its steps folded, a note box.
 */
import { useEffect, useRef } from 'react'
import type { Session } from '@shared/types'
import { AgentGlyph } from '../components/agents/AgentBits'
import { AgentTimeline } from '../components/agents/AgentTimeline'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { ApprovalCard } from '../components/author/ApprovalCard'
import { useIsCode } from '../components/desk/Desk'
import { AgentConversation, SessionConversation } from '../components/desk/AgentConversation'
import { lastChat, rememberChat, useChatRows, useSessionAgent, type ChatRowModel } from '../components/chats/ChatList'
import { Button, EmptyState, Toolbar, useTick } from '../components/ui'
import { useScope } from '../components/CompanyChip'
import { isIdleWaiting, lastSaid } from '../lib/live'
import { age } from '../lib/time'
import { sessionEndLabel } from '../lib/format'
import { useSessionDrafts } from '../state/authoring'
import { useChat } from '../state/chat'
import { focusAgent, useOpenAsks } from '../state/live'
import { pausedChatsLine } from '../state/desk'
import { focusSession, openNewChat, providerLabel, useStore, type ChatsFilter } from '../state/store'
import { MarkdownLite } from '../components/diagrams/MarkdownLite'
import { ConversationThread, DropHint, openConversation, RecentConversations, TeamComposer, toFromChat } from '../components/conversations/ConversationKit'
import { useFileDrop } from '../lib/dropFiles'
import type { Id } from '@shared/types'
import { TaskLiveView } from '../components/chats/TaskLiveView'
import { taskOfChatKey } from '../lib/liveRow'
import '../styles/diagrams.css'
import '../styles/desk.css'

export function ChatsView({ chat }: { filter?: ChatsFilter; chat?: string }): React.JSX.Element {
  useTick()
  const { scope, company } = useScope()
  const rows = useChatRows(scope)
  const remembered = lastChat(scope)
  // CHAT-UI.md §7: in a company, Chats with nothing picked is New conversation, not the newest row
  const pane = !!scope && (!chat || chat.startsWith('new'))
  const liveTask = taskOfChatKey(chat)
  const cur = pane || liveTask ? null : (chat && rows.find((r) => r.key === chat)) || (remembered && rows.find((r) => r.key === remembered)) || rows[0] || null
  const code = useIsCode(scope)
  const paused = useStore((s) => (scope ? !!s.companies.find((c) => c.id === scope)?.pausedAt : false))
  useEffect(() => {
    if (cur) rememberChat(scope, cur.key)
  }, [scope, cur?.key])
  if (liveTask) return <TaskLiveView key={liveTask} taskId={liveTask} />
  if (pane && scope) return <NewConversationPane companyId={scope} chat={chat} companyName={company?.name ?? ''} />
  if (!cur)
    return (
      <div className="view">
        <Toolbar title="Chats" sub={<span className="company-toolbar-meta">{company?.name ?? 'All companies'}</span>}>
          <Button variant="primary" icon="plus" kbd="⌥⌘N" onClick={() => openNewChat(scope)}>
            New chat
          </Button>
        </Toolbar>
        <div className="scroll view__body">
          <EmptyState icon="chat" text={company ? `No chats in ${company.name} yet. They are saved here, inside ${company.name}, and nowhere else.` : 'No chats yet. Ask Claude or Codex anything.'}>
            <Button variant="primary" icon="plus" onClick={() => openNewChat(scope)}>
              New chat
            </Button>
          </EmptyState>
          {paused && scope && <p className="chats5-paused" style={{ maxWidth: 520, margin: '0 auto' }}>{pausedChatsLine(scope)}</p>}
        </div>
      </div>
    )
  return <Conversation key={cur.key} row={cur} code={code} />
}

function Conversation({ row, code }: { row: ChatRowModel; code: boolean }): React.JSX.Element {
  if (row.kind === 'agent') return <AgentConversation agent={row.agent} />
  if (row.kind === 'session') return <DirectChat session={row.session} code={code} />
  if (row.kind === 'task') return <TaskLiveView taskId={row.task.id} />
  if (row.kind === 'conv')
    return (
      <div className="view convo-view">
        <Toolbar title="Chats" sub={<span className="company-toolbar-meta">{row.conv.private ? 'One-on-one · private' : 'With the team'}</span>} />
        <ConversationThread companyId={row.companyId} channelId={row.conv.id} />
      </div>
    )
  return (
    <div className="view convo-view">
      <Toolbar
        title={
          <span className="convo-title">
            <span className="convo-title__mark" aria-hidden>
              <AgentGlyph visual="running" />
            </span>
            <span className="convo-title__name">{row.title}</span>
          </span>
        }
        sub={<span className="convo-title__sub">Working now · {age(row.at)}</span>}
      >
        <Button size="sm" onClick={() => void focusAgent(row.agentId)}>
          Open
        </Button>
      </Toolbar>
      <div className="chats5-session">
        <AgentTimeline agentId={row.agentId} note={row.detail} />
      </div>
    </div>
  )
}

/** CHAT-UI.md §7: New conversation (the sidebar button, ⌥⌘N, Team › Message): the composer and your recent ones. */
function NewConversationPane({ companyId, chat, companyName }: { companyId: Id; chat: string | undefined; companyName: string }): React.JSX.Element {
  // an image or file dropped anywhere on the page goes into the box, as in a chat
  const dropTo = useRef<((files: FileList | File[]) => void) | null>(null)
  const drop = useFileDrop((files) => dropTo.current?.(files))
  return (
    <div className={`view cx-newpane-view ${drop.dragging ? 'is-dropping' : ''}`} data-chatux="new-pane-view" {...drop.handlers}>
      {drop.dragging && <DropHint />}
      <Toolbar title="Chats" sub={<span className="company-toolbar-meta">{companyName}</span>} />
      <div className="scroll view__body">
        <div className="cx-newpane" data-chatux="new-pane">
          <h2 className="cx-newpane__title">New task</h2>
          <p className="cx-newpane__sub">Say what you need. Principia brings in the right people, or pick someone in To.</p>
          <TeamComposer key={chat ?? 'new'} companyId={companyId} variant="pane" autoFocus initialTo={toFromChat(chat)} onStarted={openConversation} dropRef={dropTo} />
          <div className="cx-newpane__sec">Recent conversations</div>
          <RecentConversations companyId={companyId} limit={8} onOpen={openConversation} empty="Your conversations show here, each with who is in it." />
        </div>
      </div>
    </div>
  )
}

/** A direct chat: the chat itself when it is one (CHAT-UI.md), else what the session is doing. */
function DirectChat({ session: s, code }: { session: Session; code: boolean }): React.JSX.Element {
  const v = useChat(s.id)
  const isChat = (s.adapter === 'claude' || s.adapter === 'codex') && v.available
  return <SessionConversation session={s}>{isChat ? undefined : <SessionSummary session={s} code={code} />}</SessionConversation>
}

function SessionSummary({ session: s, code }: { session: Session; code: boolean }): React.JSX.Element {
  const node = useSessionAgent(s.id)
  const asks = useOpenAsks().filter((a) => a.sessionId === s.id)
  const drafts = useSessionDrafts(s.id)
  const running = s.status === 'running'
  const said = node ? lastSaid(node, 1200) : null
  return (
    <div className="chats5-session">
      {asks.map((a) => (
        <AskCard key={a.id} ask={a} onOpen={() => focusSession(s.id)} />
      ))}
      {drafts.map((d) => (
        <ApprovalCard key={d.id} draft={d} />
      ))}
      {said && (
        <div className="desk-msg">
          <span className="chats5-row__face" aria-hidden>
            ✳
          </span>
          <div className="desk-msg__body">
            <div className="desk-msg__who">
              {providerLabel(s.adapter)} · {age(node?.updatedAt ?? s.startedAt)}
            </div>
            <div className="desk-msg__bubble selectable">
              <MarkdownLite text={said} />
            </div>
          </div>
        </div>
      )}
      {node && running && isIdleWaiting(node) && <ReplyBox agent={node} />}
      {node && code && <AgentTimeline agentId={node.id} emptyText={said ? null : 'Nothing yet.'} />}
      {node && running && !code && !isIdleWaiting(node) && (
        <div className="desk-note desk-note--live">
          <span className="desk-status__glyph desk-status--working" aria-hidden>
            ●
          </span>{' '}
          {providerLabel(s.adapter)} is {said ? 'still working' : 'reading your message'}…
        </div>
      )}
      {!node && !said && (
        <div className="chats5-empty">
          <p>{running ? (code ? 'It runs in its terminal: open it to read and type.' : `${providerLabel(s.adapter)} is starting…`) : `This chat ended ${age(s.endedAt ?? s.startedAt)} ago. ${sessionEndLabel(s)}.`}</p>
          {running && code && (
            <Button size="sm" icon="terminal" onClick={() => focusSession(s.id)}>
              Open the terminal
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
