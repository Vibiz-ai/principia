/**
 * Chats (five doors ⌘4, design §4.6): every conversation in this company, a list beside the open one.
 * - Filters: Live (what works now: the one live source, so its count is the status bar's "N working"), All, Agents
 *   (each agent's desk thread) and Direct (chats with Claude or Codex, repo sessions, department chats).
 * - An agent conversation is the same thread as the agent's page (agent-first header, "Marcus's page" back to it).
 * - A direct chat shows who and where, what it is doing, its questions and its last answer; the chat itself runs in
 *   its own pane: code companies get a Terminal button, other companies "Open the chat" (C7: no Terminal there).
 * - Empty: the company's own empty state ("No chats in Harbor Dental Group yet…").
 * This replaces the old Agents hub (Live) and the CHAT sidebar section. All companies mode lists every company's rows,
 * each tagged with its company.
 */
import { useMemo } from 'react'
import type { CompanyAgent } from '@shared/company'
import type { Id, Session } from '@shared/types'
import type { AgentNode } from '@shared/live'
import { AgentGlyph } from '../components/agents/AgentBits'
import { AgentTimeline } from '../components/agents/AgentTimeline'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { ApprovalCard } from '../components/author/ApprovalCard'
import { AgentHeader, DeskComposer, DeskThread, pauseTask, StatusLine, useAgentStatus, useIsCode } from '../components/desk/Desk'
import { Button, EmptyState, Loading, Segmented, Toolbar, useTick } from '../components/ui'
import { Icon } from '../components/Icon'
import { CompanyTagged, useScope } from '../components/CompanyChip'
import { AgentBust } from '../shell/DepartmentGroup'
import { agentVisual, isIdleWaiting, lastSaid } from '../lib/live'
import { inScope } from '../lib/scope'
import { age } from '../lib/time'
import { sessionEndLabel } from '../lib/format'
import { taskName } from '../lib/desk'
import { ChatPane as ChatSurface } from '../components/chat/ChatPane'
import { useSessionDrafts } from '../state/authoring'
import { useChatMode } from '../state/chat'
import { focusAgent, useOpenAsks, useWorking } from '../state/live'
import { useDeskWho, pausedChatsLine, useDeskThread } from '../state/desk'
import { closeSession, departmentsOn, focusSession, navigate, openNewChat, providerLabel, sessionTitle, useStore, type ChatsFilter } from '../state/store'
import { MarkdownLite } from '../components/diagrams/MarkdownLite'
import '../styles/diagrams.css'
import '../styles/desk.css'

type Row =
  | { key: string; kind: 'agent'; agent: CompanyAgent; companyId: Id; live: boolean; at: string }
  | { key: string; kind: 'session'; session: Session; companyId: Id; live: boolean; at: string }
  | { key: string; kind: 'run'; agentId: Id; title: string; detail: string | null; companyId: Id; live: true; at: string }

export function ChatsView({ filter = 'all', chat }: { filter?: ChatsFilter; chat?: string }): React.JSX.Element {
  useTick()
  const { scope, company, chips } = useScope()
  const rows = useChatRows(scope)
  const counts = { live: rows.filter((r) => r.live).length, all: rows.length, agents: rows.filter((r) => r.kind === 'agent').length, direct: rows.filter((r) => r.kind === 'session').length }
  const shown = rows.filter((r) => (filter === 'live' ? r.live : filter === 'agents' ? r.kind === 'agent' : filter === 'direct' ? r.kind === 'session' : true))
  const cur = (chat && rows.find((r) => r.key === chat)) || shown[0] || null
  const code = useIsCode(scope)
  const paused = useStore((s) => (scope ? !!s.companies.find((c) => c.id === scope)?.pausedAt : false))
  const sub = scope ? (code ? 'Chats with your agents, and every Claude Code session' : `Every conversation in ${company?.name ?? 'Personal'}`) : 'All companies'
  const newChat = (
    <Button variant="primary" icon="plus" kbd="⌥⌘N" title={company ? `A chat in ${company.name}: with one of your agents, or with Claude directly` : 'A chat with Claude'} onClick={() => openNewChat(scope)}>
      New chat
    </Button>
  )
  const go = (f: ChatsFilter, c?: string): void => void navigate({ name: 'chats', filter: f, ...(c ? { chat: c } : {}) })
  if (!rows.length)
    return (
      <div className="view">
        <Toolbar title="Chats" sub={<span className="company-toolbar-meta">{sub}</span>}>
          {newChat}
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
  return (
    <div className="view">
      <Toolbar title="Chats" sub={<span className="company-toolbar-meta">{sub}</span>}>
        {newChat}
      </Toolbar>
      <div className="chats5">
        <div className="chats5-list">
          <div className="chats5-list__filters">
            <Segmented<ChatsFilter>
              size="sm"
              className="chats-tabs no-drag"
              value={filter}
              items={[
                { value: 'live', label: `Live ${counts.live}` },
                { value: 'all', label: `All ${counts.all}` },
                { value: 'agents', label: 'Agents' },
                { value: 'direct', label: 'Direct' }
              ]}
              onChange={(v) => go(v)}
            />
          </div>
          {paused && scope && <div className="chats5-paused">{pausedChatsLine(scope)}</div>}
          <div className="chats5-list__rows" role="listbox" aria-label="Conversations">
            {shown.length === 0 && (
              <div className="desk-empty" style={{ padding: 16 }}>
                {filter === 'live'
                  ? `Nothing is live in ${company?.name ?? 'any company'} right now. Every conversation is under All.`
                  : filter === 'direct'
                    ? `No direct chats in ${company?.name ?? 'any company'} yet. New chat › Claude directly starts one; it stays inside ${company?.name ?? 'its company'}.`
                    : filter === 'agents'
                      ? `No agent conversations in ${company?.name ?? 'any company'} yet. Message someone from Team.`
                      : `No chats in ${company?.name ?? 'any company'} yet.`}
              </div>
            )}
            {shown.map((r) => (
              <CompanyTagged key={r.key} companyId={r.companyId} chips={chips}>
                <ChatRow row={r} selected={cur?.key === r.key} code={code} onPick={() => go(filter, r.key)} />
              </CompanyTagged>
            ))}
          </div>
        </div>
        <div className="chats5-pane">{cur ? <ChatPane row={cur} code={code} /> : <div className="chats5-empty"><p>{shown.length ? 'Pick a conversation.' : `Conversations in ${company?.name ?? 'this company'} are saved here, inside ${company?.name ?? 'it'}, and nowhere else.`}</p></div>}</div>
      </div>
    </div>
  )
}

/** Every conversation of the scope, newest first; Live rows are exactly the one live source's working items. */
function useChatRows(scope: Id | undefined): Row[] {
  const sessions = useStore((s) => s.sessions)
  const agents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const on = useStore((s) => departmentsOn(s))
  const working = useWorking(scope ?? 'all')
  return useMemo(() => {
    const rows: Row[] = []
    const liveRuns = new Set<string>()
    const liveSessions = new Set<string>()
    for (const i of working.items) {
      if (i.runId) liveRuns.add(i.runId)
      if (i.sessionId) liveSessions.add(i.sessionId)
    }
    const taskOfRun = new Map<string, (typeof tasks)[number]>()
    for (const t of tasks) if (t.runId && t.status === 'in_progress') taskOfRun.set(t.runId, t)
    const covered = new Set<string>()
    if (on)
      for (const a of agents) {
        if (a.archivedAt || (scope && a.companyId !== scope)) continue
        const mine = tasks.filter((t) => t.agentId === a.id && t.companyId === a.companyId)
        if (!mine.length) continue
        const cur = mine.find((t) => t.status === 'in_progress')
        const live = !!cur?.runId && (liveRuns.has(cur.runId) || liveSessions.has(cur.runId))
        if (cur?.runId) covered.add(cur.runId)
        const at = mine.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), mine[0]!.createdAt)
        rows.push({ key: `agent:${a.id}`, kind: 'agent', agent: a, companyId: a.companyId, live, at })
      }
    for (const s of sessions) {
      if (!inScope(s, scope)) continue
      // a session that is a board task's run belongs to that agent's thread
      if (covered.has(s.id)) continue
      rows.push({ key: `session:${s.id}`, kind: 'session', session: s, companyId: s.companyId ?? '', live: liveSessions.has(s.id), at: s.endedAt ?? s.startedAt })
      covered.add(s.id)
    }
    // working items with no thread or chat (a workflow step, a schedule's prompt): still live, still listed
    for (const i of working.items) {
      if ((i.runId && covered.has(i.runId)) || (i.sessionId && covered.has(i.sessionId))) continue
      const t = i.runId ? taskOfRun.get(i.runId) : undefined
      if (t) continue
      rows.push({ key: `run:${i.agentId}`, kind: 'run', agentId: i.agentId, title: i.title, detail: i.detail, companyId: i.companyId, live: true, at: i.at })
    }
    return rows.sort((a, b) => Number(b.live) - Number(a.live) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }, [sessions, agents, tasks, on, working, scope])
}

function ChatRow({ row, selected, code, onPick }: { row: Row; selected: boolean; code: boolean; onPick: () => void }): React.JSX.Element {
  if (row.kind === 'agent') return <AgentChatRow row={row} selected={selected} code={code} onPick={onPick} />
  if (row.kind === 'run')
    return (
      <button type="button" role="option" aria-selected={selected} className={`chats5-row is-shimmering ${selected ? 'is-selected' : ''}`} onClick={onPick}>
        <span className="chats5-row__face" aria-hidden>
          <AgentGlyph visual="running" />
        </span>
        <span className="chats5-row__body">
          <span className="chats5-row__top">
            {row.title}
            <span className="chats5-row__age">{age(row.at)}</span>
          </span>
          <span className="chats5-row__last shimmer-text">{row.detail ?? 'Working'}</span>
        </span>
      </button>
    )
  return <SessionChatRow row={row} selected={selected} onPick={onPick} />
}

function AgentChatRow({ row, selected, code, onPick }: { row: Extract<Row, { kind: 'agent' }>; selected: boolean; code: boolean; onPick: () => void }): React.JSX.Element {
  const who = useDeskWho(row.agent)
  const status = useAgentStatus(row.agent)
  const latest = useStore((s) => s.tasks.filter((t) => t.agentId === row.agent.id && t.companyId === row.agent.companyId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0])
  // an agent working right now catches the shimmer (tokens.css), like its LIVE row
  const working = status.kind === 'working'
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row ${selected ? 'is-selected' : ''} ${working ? 'is-shimmering' : ''}`} onClick={onPick}>
      <span className="chats5-row__face" aria-hidden>
        <AgentBust agent={row.agent} size={28} />
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          {who.name}
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        {latest && <span className="chats5-row__title">{taskName(status.seat.current ?? latest, code)}</span>}
        <span className={`chats5-row__last ${working ? 'shimmer-text' : ''}`}>
          <StatusLine status={status} />
        </span>
      </span>
    </button>
  )
}

function SessionChatRow({ row, selected, onPick }: { row: Extract<Row, { kind: 'session' }>; selected: boolean; onPick: () => void }): React.JSX.Element {
  const s = row.session
  const node = useSessionAgent(s.id)
  const seen = useStore((x) => (node ? !!x.seenIdle[node.id] : false))
  const place = useStore((x) => (s.repoId ? (x.repos.find((r) => r.id === s.repoId)?.name ?? 'Repository') : s.departmentId ? (x.departments.find((d) => d.id === s.departmentId)?.name ?? 'Department') : null))
  const visual = s.status === 'running' && node ? agentVisual(node, seen) : node?.status === 'done' ? 'passed' : null
  const custom = !!s.title && !/ · (Claude|Codex|Cursor|Gemini|Shell)$/.test(s.title)
  const title = custom ? s.title : (node?.title ?? sessionTitle(s))
  // the glyph and the word say the same thing: live (the one live source) is "Working" with the running glyph
  const word = s.status !== 'running' ? (visual === 'passed' ? 'Done' : sessionEndLabel(s)) : visual === 'idle' ? 'Your turn' : visual === 'needs' ? 'Needs you' : row.live ? 'Working' : 'Open, waiting for you'
  const glyph = s.status === 'running' && row.live && visual !== 'needs' && visual !== 'idle' ? 'running' : visual
  const working = glyph === 'running' || glyph === 'queued'
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row ${selected ? 'is-selected' : ''} ${s.status === 'running' ? '' : 'is-dim'} ${working ? 'is-shimmering' : ''}`} onClick={onPick}>
      <span className="chats5-row__face" aria-hidden>
        {glyph ? <AgentGlyph visual={glyph} /> : <Icon name={s.repoId ? 'branch' : s.departmentId ? 'department' : 'chat'} size={13} />}
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          {s.departmentId && place ? `${place} chat` : providerLabel(s.adapter)}
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        <span className={`chats5-row__title ${working ? 'shimmer-text' : ''}`}>{title}</span>
        <span className="chats5-row__last">
          {place && s.repoId ? `${place} · ` : ''}
          {word}
        </span>
      </span>
    </button>
  )
}

function useSessionAgent(sessionId: Id): AgentNode | undefined {
  return useStore((s) => {
    let best: AgentNode | undefined
    for (const a of Object.values(s.agents)) if (a.kind === 'session' && a.sessionId === sessionId && (!best || a.updatedAt > best.updatedAt)) best = a
    return best
  })
}

function ChatPane({ row, code }: { row: Row; code: boolean }): React.JSX.Element {
  if (row.kind === 'agent') return <AgentPane key={row.agent.id} agent={row.agent} code={code} />
  if (row.kind === 'session') return <SessionPane key={row.session.id} session={row.session} code={code} />
  return (
    <>
      <div className="desk-head">
        <span className="chats5-row__face" aria-hidden>
          <AgentGlyph visual="running" />
        </span>
        <div className="desk-head__id">
          <div className="desk-head__name">{row.title}</div>
          <div className="desk-head__sub">Working now · {age(row.at)}</div>
        </div>
        <span className="flex1" />
        <Button size="sm" onClick={() => void focusAgent(row.agentId)}>
          Open
        </Button>
      </div>
      <div className="chats5-session">
        <AgentTimeline agentId={row.agentId} note={row.detail} />
      </div>
    </>
  )
}

function AgentPane({ agent, code }: { agent: CompanyAgent; code: boolean }): React.JSX.Element {
  const status = useAgentStatus(agent)
  const thread = useDeskThread(agent)
  const cur = status.seat.current
  return (
    <>
      <AgentHeader agent={agent} sub={cur ? taskName(cur, code) : status.text}>
        {cur && status.kind === 'working' && (
          <Button size="sm" variant="ghost" icon="pause" onClick={() => void pauseTask(cur)}>
            Pause this task
          </Button>
        )}
      </AgentHeader>
      {thread.items ? <DeskThread agent={agent} items={thread.items} tasks={thread.tasks} code={code} /> : <Loading />}
      <DeskComposer agent={agent} />
    </>
  )
}

function SessionPane({ session: s, code }: { session: Session; code: boolean }): React.JSX.Element {
  const node = useSessionAgent(s.id)
  const asks = useOpenAsks().filter((a) => a.sessionId === s.id)
  const drafts = useSessionDrafts(s.id)
  const place = useStore((x) => (s.repoId ? (x.repos.find((r) => r.id === s.repoId)?.name ?? null) : s.departmentId ? (x.departments.find((d) => d.id === s.departmentId)?.name ?? null) : null))
  const running = s.status === 'running'
  const said = node ? lastSaid(node, 1200) : null
  const title = s.title || node?.title || sessionTitle(s)
  // design §4.6: code companies say what it is ("Claude Code session in ledgerly-app"); others only the chat's title
  const generic = !s.title || / · (Claude|Codex|Cursor|Gemini|Shell)$/.test(s.title)
  const sub = code && s.repoId && place ? (generic ? `${providerLabel(s.adapter)} Code session in ${place}`.replace('Claude Code Code', 'Claude Code') : `${title} · Claude Code session in ${place}`) : title
  // CHAT-UI.md: a Claude session open as a chat is the chat itself here (tools, approvals, the composer), not a summary
  const chatMode = useChatMode(s)
  return (
    <>
      <div className="desk-head">
        <span className="chats5-row__face" aria-hidden>
          <Icon name={s.repoId ? 'branch' : s.departmentId ? 'department' : 'chat'} size={13} />
        </span>
        <div className="desk-head__id">
          <div className="desk-head__name">
            {s.departmentId && place ? `${place} chat` : providerLabel(s.adapter)} <span className="desk-head__role">· {s.departmentId ? 'with the department' : 'direct chat, no agent'}</span>
          </div>
          <div className="desk-head__sub">{sub}</div>
        </div>
        <span className="flex1" />
        {/* C7: a company with no code has no Terminal or Technical view; its chat is this conversation */}
        {code && (
          <Button size="sm" icon="terminal" onClick={() => focusSession(s.id)} title="The terminal behind this chat (⌥⌘T)">
            Terminal
          </Button>
        )}
        {running && (
          <Button size="sm" variant="ghost" onClick={() => void closeSession(s.id)}>
            Stop
          </Button>
        )}
      </div>
      {chatMode === 'chat' ? (
        <div className="chats5-chat">
          <ChatSurface session={s} focused />
        </div>
      ) : (
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
            <p>{running ? (code ? 'Open the Terminal to read and type.' : `${providerLabel(s.adapter)} is starting…`) : `This chat ended ${age(s.endedAt ?? s.startedAt)} ago. ${sessionEndLabel(s)}.`}</p>
          </div>
        )}
      </div>
      )}
    </>
  )
}
