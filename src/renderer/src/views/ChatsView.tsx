/**
 * Chats (five doors, ⌘4). Step 1 mounts what exists under the new name: Live is the old Agents hub (running, waiting
 * and recent agents of this company), All is every conversation in this company: chats, repo sessions and department
 * chats, newest first. The redesigned chat list and agent-first pane land in step 3.
 */
import { useMemo } from 'react'
import type { Session } from '@shared/types'
import type { AgentNode } from '@shared/live'
import { AgentGlyph } from '../components/agents/AgentBits'
import { agentVisual } from '../lib/live'
import { Button, EmptyState, SectionHeader, Segmented, StatusGlyph, Toolbar, useTick } from '../components/ui'
import { Icon } from '../components/Icon'
import { CompanyTagged, useScope } from '../components/CompanyChip'
import { inScope } from '../lib/scope'
import { age, startedHint } from '../lib/time'
import { sessionEndLabel } from '../lib/format'
import { companyName, focusSession, navigate, openChat, sessionTitle, useStore, type ChatsFilter } from '../state/store'
import { AgentsView } from './AgentsView'

export function ChatsView({ filter = 'live' }: { filter?: ChatsFilter }): React.JSX.Element {
  const { scope } = useScope()
  const tabs = (
    <Segmented<ChatsFilter>
      size="sm"
      className="chats-tabs no-drag"
      value={filter}
      items={[
        { value: 'live', label: 'Live' },
        { value: 'all', label: 'All' }
      ]}
      onChange={(v) => void navigate({ name: 'chats', filter: v })}
    />
  )
  const newChat = (
    <Button icon="plus" kbd="⌥⌘N" title={scope ? `A chat in ${companyName(scope)}, not tied to a repository` : 'A chat, not tied to a repository'} onClick={() => void openChat(true, scope)}>
      New chat
    </Button>
  )
  if (filter === 'live') return <AgentsView title="Chats" sub={tabs} actions={newChat} />
  return (
    <div className="view">
      <Toolbar title="Chats" sub={tabs}>
        {newChat}
      </Toolbar>
      <AllChats />
    </div>
  )
}

function AllChats(): React.JSX.Element {
  useTick()
  const { scope, chips, company } = useScope()
  const all = useStore((s) => s.sessions)
  const repos = useStore((s) => s.repos)
  const departments = useStore((s) => s.departments)
  const agents = useStore((s) => s.agents)
  const seen = useStore((s) => s.seenIdle)
  // the same chat reads the same in Live and All: Live's agent title and state word, not the terminal's
  const sessionAgent = useMemo(() => {
    const m = new Map<string, AgentNode>()
    for (const a of Object.values(agents)) if (a.kind === 'session' && a.sessionId) m.set(a.sessionId, a)
    return m
  }, [agents])
  const sessions = useMemo(() => all.filter((s) => inScope(s, scope)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [all, scope])
  const running = sessions.filter((s) => s.status === 'running')
  const earlier = sessions.filter((s) => s.status !== 'running')
  if (!sessions.length)
    return (
      <EmptyState icon="chat" text={company ? `No chats in ${company.name} yet. They are saved here, inside ${company.name}, and nowhere else.` : 'No chats yet.'}>
        <Button variant="primary" icon="plus" onClick={() => void openChat(true, scope)}>
          New chat
        </Button>
      </EmptyState>
    )
  const place = (s: Session): string => {
    if (s.repoId) return repos.find((r) => r.id === s.repoId)?.name ?? 'Repository'
    if (s.departmentId) return departments.find((d) => d.id === s.departmentId)?.name ?? 'Department'
    return 'Chat'
  }
  const row = (s: Session): React.JSX.Element => {
    const node = sessionAgent.get(s.id)
    const a = s.status === 'running' ? node : undefined
    // an ended chat whose agent finished reads Done in both tabs, not "stopped"
    const visual = a ? agentVisual(a, !!seen[a.id]) : node?.status === 'done' ? 'passed' : null
    const custom = !!s.title && !/ · (Claude|Codex|Cursor|Gemini|Shell)$/.test(s.title)
    const title = custom ? s.title : (node?.title ?? sessionTitle(s))
    const word = visual === 'passed' ? 'Done' : visual === 'idle' ? 'Your turn' : visual === 'needs' ? 'Needs you' : null
    return (
    <CompanyTagged key={s.id} companyId={s.companyId} chips={chips}>
      <button type="button" className={`chats-row ${s.status === 'running' ? '' : 'is-dim'}`} onClick={() => focusSession(s.id)}>
        {visual ? <AgentGlyph visual={visual} /> : <StatusGlyph status={s.status === 'running' ? 'running' : 'exited'} />}
        <span className="chats-row__main">
          <span className="chats-row__title">{title}</span>
          <span className="chats-row__place">
            <Icon name={s.repoId ? 'branch' : s.departmentId ? 'department' : 'chat'} size={12} />
            {place(s)} · {startedHint(s.startedAt)}
          </span>
        </span>
        <span className="chats-row__meta">{s.status !== 'running' ? (visual === 'passed' ? 'Done' : sessionEndLabel(s)) : word ? `${word} · ${age(s.startedAt)}` : age(s.startedAt)}</span>
      </button>
    </CompanyTagged>
    )
  }
  return (
    <div className="scroll view__body">
      <div className="chats-list">
        {running.length > 0 && (
          <>
            <SectionHeader title="Running" count={running.length} />
            <div className="group-list">{running.map(row)}</div>
          </>
        )}
        {earlier.length > 0 && (
          <>
            <SectionHeader title="Earlier" count={earlier.length} />
            <div className="group-list">{earlier.slice(0, 200).map(row)}</div>
          </>
        )}
      </div>
    </div>
  )
}
