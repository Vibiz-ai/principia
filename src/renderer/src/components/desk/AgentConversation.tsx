/**
 * AGENT CHAT part 2: one layout for talking to an agent, the same on its page (Team › Julia) and in Chats: the header
 * says who (bust, name · role, what it is doing), the chat takes the full remaining width (the same ChatPane as
 * Claude › Chat), and the ONE right panel (AgentPanel) holds who it is and what it has, collapsible with one click.
 * Direct chats (Claude or Codex, no agent) use the same layout with the session's panel.
 */
import { useRef } from 'react'
import type { CompanyAgent } from '@shared/company'
import type { Session } from '@shared/types'
import { Button, Toolbar } from '../ui'
import { Icon } from '../Icon'
import { ChatModeToggle } from '../chat/ChatPane'
import { ChatSurface } from '../chat/ChatSurface'
import { AgentBust } from '../../shell/DepartmentGroup'
import { taskName } from '../../lib/desk'
import { useAgentChat, useDeskWho } from '../../state/desk'
import { navigate, providerLabel, sessionTitle, setCompanyPaused, useStore } from '../../state/store'
import { useCompanyShortName } from '../../lib/company'
import { AgentChat, useAgentStatus, useIsCode } from './Desk'
import { AgentPanel, PanelToggle, SessionPanel, usePanel } from './AgentPanel'
import { BrowserToggle } from '../browser/BrowserToggle'
import { TaskLiveBanner } from '../chats/TaskLiveView'

export function AgentConversation({ agent, crumb = false, nonce }: { agent: CompanyAgent; crumb?: boolean; nonce?: number }): React.JSX.Element {
  const who = useDeskWho(agent)
  const status = useAgentStatus(agent)
  const code = useIsCode(agent.companyId)
  const chat = useAgentChat(agent)
  const area = useRef<HTMLDivElement>(null)
  const panel = usePanel(area)
  const companyPaused = useStore((s) => s.companies.find((c) => c.id === agent.companyId)?.pausedAt ?? null)
  const short = useCompanyShortName(agent.companyId)
  const cur = status.seat.current
  const doing = status.kind === 'working' && cur && status.seat.working.length < 2 ? `${taskName(cur, code)} · ${status.text}` : status.text
  return (
    <div className="view convo-view">
      <Toolbar
        title={
          <span className="convo-title">
            {crumb && (
              <>
                <button type="button" className="link-btn desk-crumb no-drag" onClick={() => void navigate({ name: 'team' })}>
                  Team
                </button>
                <span className="convo-title__sep" aria-hidden>
                  ›
                </span>
              </>
            )}
            <AgentBust agent={agent} size={24} className="convo-title__face" />
            <span className="convo-title__name">{who.name}</span>
            <span className="convo-title__role">· {who.role}</span>
          </span>
        }
        sub={<span className={`convo-title__sub ${status.kind === 'working' ? 'shimmer-text' : ''}`}>{doing}</span>}
      >
        {companyPaused && !agent.archivedAt && (
          <Button size="sm" icon="play" variant="primary" onClick={() => void setCompanyPaused(agent.companyId, false)} title={`${short} is paused, so ${who.name} is too.`}>
            Resume {short}
          </Button>
        )}
        {chat.session && <ChatModeToggle session={chat.session} focused />}
        {/* BROWSER.md §6: the company's browser opens beside the conversation; agents use it, you watch and take over */}
        <BrowserToggle companyId={agent.companyId} />
        <PanelToggle open={panel.open} onToggle={panel.toggle} label={`${who.name}’s panel`} />
      </Toolbar>
      <div ref={area} className={`convo ${panel.docked ? 'has-panel' : ''}`}>
        <section className="convo__chat" aria-label={`Conversation with ${who.name}`}>
          {/* CHAT-UI.md §8.4: while it works on a task, its resting chat says so and Watch opens the live view */}
          <TaskLiveBanner agent={agent} name={who.name} />
          <AgentChat key={nonce ?? 0} agent={agent} chat={chat} />
        </section>
        {panel.open && <AgentPanel agent={agent} session={chat.session} overlay={!panel.docked} onClose={panel.close} />}
      </div>
    </div>
  )
}

export function SessionConversation({ session: s, children }: { session: Session; children?: React.ReactNode }): React.JSX.Element {
  const area = useRef<HTMLDivElement>(null)
  const panel = usePanel(area)
  const place = useStore((x) => (s.repoId ? (x.repos.find((r) => r.id === s.repoId)?.name ?? null) : s.departmentId ? (x.departments.find((d) => d.id === s.departmentId)?.name ?? null) : null))
  const custom = !!s.title && !/ · (Claude|Codex|Cursor|Gemini|Shell)$/.test(s.title)
  const name = s.departmentId && place ? `${place} chat` : providerLabel(s.adapter)
  return (
    <div className="view convo-view">
      <Toolbar
        title={
          <span className="convo-title">
            <span className="convo-title__mark" aria-hidden>
              <Icon name={s.repoId ? 'branch' : s.departmentId ? 'department' : 'chat'} size={13} />
            </span>
            <span className="convo-title__name">{name}</span>
            <span className="convo-title__role">· {s.departmentId ? 'with the department' : 'direct chat, no agent'}</span>
          </span>
        }
        sub={<span className="convo-title__sub">{custom ? s.title : sessionTitle(s)}{place && s.repoId ? ` · ${place}` : ''}</span>}
      >
        <ChatModeToggle session={s} focused />
        <BrowserToggle companyId={s.companyId} />
        <PanelToggle open={panel.open} onToggle={panel.toggle} label="this chat’s panel" />
      </Toolbar>
      <div ref={area} className={`convo ${panel.docked ? 'has-panel' : ''}`}>
        <section className="convo__chat" aria-label={`Chat with ${name}`}>
          {children ?? (
            <div className="agent-chat">
              <ChatSurface session={s} focused />
            </div>
          )}
        </section>
        {panel.open && <SessionPanel session={s} overlay={!panel.docked} onClose={panel.close} />}
      </div>
    </div>
  )
}
