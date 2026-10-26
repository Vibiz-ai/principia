/**
 * Chats (⌘4): every conversation in this company, as the rows of the switched sidebar (ChatsSidebar) and the source
 * ChatsView picks the open one from. One live source: a row is Live exactly when the status bar counts it working.
 * - an agent row is the agent's own live chat (AGENT CHAT), listed like a bot: bust, name, its last line, a dot when it
 *   answered and you have not looked yet, the shimmer while it works;
 * - a session row is a direct chat with Claude or Codex (repo sessions, department chats);
 * - a run row is live work with no chat (a workflow step, a schedule's prompt).
 */
import { useMemo } from 'react'
import type { CompanyAgent } from '@shared/company'
import type { Id, Session } from '@shared/types'
import type { AgentNode } from '@shared/live'
import { AgentGlyph } from '../agents/AgentBits'
import { Icon } from '../Icon'
import { AgentBust } from '../../shell/DepartmentGroup'
import { agentVisual, saidPreview } from '../../lib/live'
import { inScope } from '../../lib/scope'
import { age } from '../../lib/time'
import { firstLine, sessionEndLabel } from '../../lib/format'
import { lastChatKey, sessionUnread } from '../../lib/agentChatView'
import { useWorking } from '../../state/live'
import { useDeskWho } from '../../state/desk'
import { departmentsOn, loadJson, providerLabel, saveJson, sessionTitle, useStore, type ChatsFilter } from '../../state/store'
import { useAgentStatus } from '../desk/Desk'

export type ChatRowModel =
  | { key: string; kind: 'agent'; agent: CompanyAgent; companyId: Id; live: boolean; at: string; chat: Session | null }
  | { key: string; kind: 'session'; session: Session; companyId: Id; live: boolean; at: string }
  | { key: string; kind: 'run'; agentId: Id; title: string; detail: string | null; companyId: Id; live: true; at: string }

export const CHATS_FILTERS: { value: ChatsFilter; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'all', label: 'All' },
  { value: 'agents', label: 'Agents' },
  { value: 'direct', label: 'Direct' }
]

/** Rows a filter keeps (Live: working now; Agents: agent chats; Direct: chats with no agent). */
export function filterRows(rows: readonly ChatRowModel[], filter: ChatsFilter, query = ''): ChatRowModel[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => (filter === 'live' ? r.live : filter === 'agents' ? r.kind === 'agent' : filter === 'direct' ? r.kind === 'session' : true) && (!q || rowText(r).toLowerCase().includes(q)))
}
function rowText(r: ChatRowModel): string {
  if (r.kind === 'agent') {
    const p = r.agent.data.persona
    return [p?.name, r.agent.name, r.chat?.title].filter(Boolean).join(' ')
  }
  if (r.kind === 'session') return [r.session.title, providerLabel(r.session.adapter)].join(' ')
  return [r.title, r.detail].filter(Boolean).join(' ')
}

/** The conversation Chats opens with no pick: the last one open in this company, else the first row. */
const LAST_KEY = lastChatKey
export function lastChat(scope: Id | undefined): string | null {
  return loadJson<string | null>(LAST_KEY(scope), null)
}
export function rememberChat(scope: Id | undefined, key: string): void {
  if (lastChat(scope) !== key) saveJson(LAST_KEY(scope), key)
}

/** Every conversation of the scope, newest first; Live rows are exactly the one live source's working items. */
export function useChatRows(scope: Id | undefined): ChatRowModel[] {
  const sessions = useStore((s) => s.sessions)
  const agents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const on = useStore((s) => departmentsOn(s))
  const working = useWorking(scope ?? 'all')
  return useMemo(() => {
    const rows: ChatRowModel[] = []
    const liveRuns = new Set<string>()
    const liveSessions = new Set<string>()
    for (const i of working.items) {
      if (i.runId) liveRuns.add(i.runId)
      if (i.sessionId) liveSessions.add(i.sessionId)
    }
    const taskOfRun = new Map<string, (typeof tasks)[number]>()
    for (const t of tasks) if (t.runId && t.status === 'in_progress') taskOfRun.set(t.runId, t)
    const covered = new Set<string>()
    // AGENT CHAT: an agent's own chat sessions belong to its row (never a separate "direct" chat)
    const chatOf = new Map<string, Session[]>()
    for (const s of sessions) if (s.companyAgentId) chatOf.set(s.companyAgentId, [...(chatOf.get(s.companyAgentId) ?? []), s])
    if (on)
      for (const a of agents) {
        if (a.archivedAt || a.kind !== 'profile' || (scope && a.companyId !== scope)) continue
        const mine = tasks.filter((t) => t.agentId === a.id && t.companyId === a.companyId)
        const chats = (chatOf.get(a.id) ?? []).slice().sort((x, y) => Number(y.status === 'running') - Number(x.status === 'running') || (x.startedAt < y.startedAt ? 1 : -1))
        const cur = mine.find((t) => t.status === 'in_progress')
        const live = (!!cur?.runId && (liveRuns.has(cur.runId) || liveSessions.has(cur.runId))) || chats.some((s) => liveSessions.has(s.id))
        if (cur?.runId) covered.add(cur.runId)
        for (const c of chats) covered.add(c.id)
        const at = [...mine.map((t) => t.updatedAt), ...chats.map((s) => s.endedAt ?? s.startedAt), a.createdAt].reduce((m, x) => (x > m ? x : m), '')
        rows.push({ key: `agent:${a.id}`, kind: 'agent', agent: a, companyId: a.companyId, live, at, chat: chats[0] ?? null })
      }
    for (const s of sessions) {
      if (!inScope(s, scope) || s.companyAgentId) continue
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

/** The newest live-graph node of a session (its turn state and what it said last). */
export function useSessionAgent(sessionId: Id | null | undefined): AgentNode | undefined {
  return useStore((s) => {
    if (!sessionId) return undefined
    let best: AgentNode | undefined
    for (const a of Object.values(s.agents)) if (a.kind === 'session' && a.sessionId === sessionId && (!best || a.updatedAt > best.updatedAt)) best = a
    return best
  })
}

export function ChatRow({ row, selected, onPick }: { row: ChatRowModel; selected: boolean; onPick: () => void }): React.JSX.Element {
  if (row.kind === 'agent') return <AgentChatRow row={row} selected={selected} onPick={onPick} />
  if (row.kind === 'session') return <SessionChatRow row={row} selected={selected} onPick={onPick} />
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row is-shimmering ${selected ? 'is-selected' : ''}`} onClick={onPick}>
      <span className="chats5-row__face" aria-hidden>
        <AgentGlyph visual="running" />
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          <span className="chats5-row__name">{row.title}</span>
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        <span className="chats5-row__last shimmer-text">{row.detail ?? 'Working'}</span>
      </span>
    </button>
  )
}

function AgentChatRow({ row, selected, onPick }: { row: Extract<ChatRowModel, { kind: 'agent' }>; selected: boolean; onPick: () => void }): React.JSX.Element {
  const who = useDeskWho(row.agent)
  const status = useAgentStatus(row.agent)
  const node = useSessionAgent(row.chat?.id)
  const seen = useStore((x) => (node ? !!x.seenIdle[node.id] : false))
  const turnWorking = !!node && row.chat?.status === 'running' && node.status === 'working'
  const working = status.kind === 'working' || turnWorking
  const unread = !selected && sessionUnread(node, seen)
  const needs = node?.status === 'needs_you' && node.needs !== 'idle'
  // like a bot list: what it is doing while it works, else the last thing it said, else its status sentence
  const said = node ? saidPreview(node, 160) : null
  const line = turnWorking ? (node?.activity ? firstLine(node.activity, 120) : 'Working…') : needs ? 'Waiting for you to allow something' : said ?? status.text
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row ${selected ? 'is-selected' : ''} ${working ? 'is-shimmering' : ''} ${unread ? 'is-unread' : ''}`} onClick={onPick} title={`${who.name} · ${who.role}`}>
      <span className="chats5-row__face chats5-row__face--bust" aria-hidden>
        <AgentBust agent={row.agent} size={30} />
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          <span className="chats5-row__name">{who.name}</span>
          <span className="chats5-row__role">{who.role}</span>
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        <span className={`chats5-row__last ${working ? 'shimmer-text' : ''} ${needs ? 'is-needs' : ''}`}>{line}</span>
      </span>
      {(unread || needs) && <span className={`chats5-row__dot ${needs ? 'is-needs' : ''}`} aria-label={needs ? 'Needs you' : 'New answer'} />}
    </button>
  )
}

function SessionChatRow({ row, selected, onPick }: { row: Extract<ChatRowModel, { kind: 'session' }>; selected: boolean; onPick: () => void }): React.JSX.Element {
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
  const unread = !selected && s.status === 'running' && sessionUnread(node, seen)
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row ${selected ? 'is-selected' : ''} ${s.status === 'running' ? '' : 'is-dim'} ${working ? 'is-shimmering' : ''} ${unread ? 'is-unread' : ''}`} onClick={onPick}>
      <span className="chats5-row__face" aria-hidden>
        {glyph ? <AgentGlyph visual={glyph} /> : <Icon name={s.repoId ? 'branch' : s.departmentId ? 'department' : 'chat'} size={13} />}
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          <span className="chats5-row__name">{title}</span>
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        <span className={`chats5-row__last ${working ? 'shimmer-text' : ''}`}>
          {s.departmentId && place ? `${place} chat` : providerLabel(s.adapter)}
          {place && s.repoId ? ` · ${place}` : ''} · {word}
        </span>
      </span>
      {unread && <span className="chats5-row__dot" aria-label="New answer" />}
    </button>
  )
}
