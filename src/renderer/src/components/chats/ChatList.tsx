/**
 * Chats (⌘4): every conversation in this company, as the rows of the switched sidebar (ChatsSidebar) and the source
 * ChatsView picks the open one from. One live source: a row is Live exactly when the status bar counts it working.
 * - a conversation row (CHAT-UI.md §7) is a conversation with the team, or your private one with one agent: its title,
 *   who is in it, "answering…" only while someone answers IN it;
 * - an agent row is the agent's own live chat (AGENT CHAT), listed like a bot: bust, name, its last line, a dot when it
 *   answered and you have not looked yet, the shimmer while it works;
 * - a session row is a direct chat with Claude or Codex (repo sessions, department chats);
 * - a task row is a task nobody filed from a conversation (autopilot, Run now, a routine): working, needing you, or
 *   with a result you have not read; it opens the task's chat (CHAT-UI.md §8.4);
 * - a run row is live work with no chat (a workflow step, a schedule's prompt).
 * CHAT-UI.md §8.6: a task filed from a conversation is that conversation's subagent: its row says "2 tasks working",
 * "1 needs you" or "VO-16 finished · unread" and sorts first; an agent's own chat is live only while it answers there.
 */
import { useMemo, useState } from 'react'
import type { CompanyAgent, CompanyTask } from '@shared/company'
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
import { liveTaskKey } from '../../lib/liveRow'
import { byWork, isOrphanTask, orphanUnread, workLine, workOf, workRank, workState, type ConvWork } from '../../lib/convWork'
import { dedupeSessions } from '../../lib/sessionRows'
import { taskName } from '../../lib/desk'
import { plainActivity } from '../../lib/plainActivity'
import { useWorking } from '../../state/live'
import { useDeskWho } from '../../state/desk'
import { isClosed, type ClosedChats } from '../../lib/closedChats'
import { departmentsOn, getState, loadJson, providerLabel, reopenChat, saveJson, sessionTitle, TASK_SEEN_SINCE, useStore, type ChatsFilter } from '../../state/store'
import { useAgentStatus, useIsCode } from '../desk/Desk'
import { useAgentDisplay } from '../board/NeedsYouTasks'
import { conversationText, renameConversation, useConversations, useTaskChannels, whoLine, type ConversationRow } from '../../state/conversations'
import { nativeMenu } from '../../lib/hive'
import { useForum } from '../../state/forum'
import { MemberAvatar, useMemberDisplay } from '../forum/Avatar'

export type ChatRowModel =
  | { key: string; kind: 'agent'; agent: CompanyAgent; companyId: Id; live: boolean; at: string; chat: Session | null }
  | { key: string; kind: 'session'; session: Session; companyId: Id; live: boolean; at: string }
  | { key: string; kind: 'run'; agentId: Id; title: string; detail: string | null; companyId: Id; live: true; at: string }
  /** CHAT-UI.md §7: a conversation with the team (Principia brought them in), or your private one with one agent */
  | { key: string; kind: 'conv'; conv: ConversationRow; companyId: Id; live: boolean; at: string; work?: ConvWork<CompanyTask> }
  /** CHAT-UI.md §8.6: a task with no conversation (autopilot, Run now, a routine); opens its task chat */
  | { key: string; kind: 'task'; task: CompanyTask; companyId: Id; live: boolean; at: string; unread: boolean }

/** Chats shows Everything or Live only; the groups say what each row is (older links' Agents / Direct read as Everything). */
export const CHATS_FILTERS: { value: ChatsFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'live', label: 'Live only' }
]

/** Rows a filter keeps (Live: working now), and a search over titles, who is in them and what they are about. */
export function filterRows(rows: readonly ChatRowModel[], filter: ChatsFilter, query = ''): ChatRowModel[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => (filter === 'live' ? r.live : true) && (!q || rowText(r).toLowerCase().includes(q)))
}

export type ChatGroup = 'team' | 'private' | 'tasks' | 'agent' | 'claude' | 'working'
export const CHAT_GROUP_LABEL: Record<ChatGroup, string> = { team: 'With the team', private: 'One-on-one', tasks: 'Tasks', agent: 'Agent sessions', claude: 'Claude', working: 'Working' }
/** Which group a row is listed under: With the team, One-on-one (private), Tasks, Agent sessions, Claude, Working. */
export function chatGroup(r: ChatRowModel): ChatGroup {
  if (r.kind === 'conv') return r.conv.private ? 'private' : 'team'
  if (r.kind === 'task') return 'tasks'
  if (r.kind === 'agent') return 'agent'
  if (r.kind === 'session') return 'claude'
  return 'working'
}
/** The rows in their groups, in the fixed order above; empty groups are left out. */
export function groupRows(rows: readonly ChatRowModel[]): { group: ChatGroup; label: string; rows: ChatRowModel[] }[] {
  return (Object.keys(CHAT_GROUP_LABEL) as ChatGroup[]).map((g) => ({ group: g, label: CHAT_GROUP_LABEL[g], rows: rows.filter((r) => chatGroup(r) === g) })).filter((g) => g.rows.length > 0)
}
/**
 * PR-47 (founder: "too much for the user's head, you lose focus"): how many rows a group shows before "Show N more".
 * Rows come sorted (needs you, live, unread first), so the cut only hides what waits on nobody.
 */
export const GROUP_LIMIT: Record<ChatGroup, number> = { team: 6, private: 6, tasks: 4, agent: 4, claude: 4, working: 4 }
/** The rows a group shows: the first GROUP_LIMIT (all when expanded), plus the open one if the cut hid it. */
export function visibleRows(group: ChatGroup, rows: readonly ChatRowModel[], o: { expanded: boolean; selected: string | null }): { rows: ChatRowModel[]; hidden: number } {
  const n = GROUP_LIMIT[group]
  if (o.expanded || rows.length <= n) return { rows: [...rows], hidden: 0 }
  const head = rows.slice(0, n)
  const picked = o.selected ? rows.slice(n).find((r) => r.key === o.selected) : undefined
  const out = picked ? [...head, picked] : head
  return { rows: out, hidden: rows.length - out.length }
}
function rowText(r: ChatRowModel): string {
  if (r.kind === 'agent') {
    const p = r.agent.data.persona
    return [p?.name, r.agent.name, r.chat?.title].filter(Boolean).join(' ')
  }
  if (r.kind === 'session') return [r.session.title, providerLabel(r.session.adapter)].join(' ')
  if (r.kind === 'conv') return conversationText(r.conv)
  if (r.kind === 'task') return [r.task.identifier, r.task.title].join(' ')
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
  // CHAT-UI.md §7: conversations are rows, and an agent is listed only once you worked with it (never a roster)
  const convs = useConversations(on ? scope : null)
  const taskChannels = useTaskChannels(on ? scope : null)
  const seen = useStore((s) => s.taskSeen)
  return useMemo(() => {
    const rows: ChatRowModel[] = []
    // CHAT-UI.md §8.6: a conversation's tasks are its subagents: their work is on its row
    for (const c of convs) {
      const work = workOf(c.id, tasks, taskChannels, c.unreadTasks)
      rows.push({ key: `conv:${c.id}`, kind: 'conv', conv: c, companyId: c.companyId, live: c.working || work.working.length > 0, at: c.lastAt, work })
    }
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
        // CHAT-UI.md §8.6: the agent's own chat is live only while it answers THERE; its task runs show on the
        // conversations that filed them (or as task rows), never as this resting chat
        const runs = mine.filter((t) => t.status === 'in_progress' && t.runId).map((t) => t.runId!)
        const live = chats.some((s) => liveSessions.has(s.id))
        for (const r of runs) covered.add(r)
        for (const c of chats) covered.add(c.id)
        const at = [...chats.map((s) => s.endedAt ?? s.startedAt), a.createdAt].reduce((m, x) => (x > m ? x : m), '')
        if (!chats.length) continue
        rows.push({ key: `agent:${a.id}`, kind: 'agent', agent: a, companyId: a.companyId, live, at, chat: chats[0] ?? null })
      }
    // CHAT-UI.md §8.6: a task nobody filed from a conversation is a row of its own while it works, needs you, or came
    // back unread; one filed from a conversation never is (its conversation's row carries it)
    if (on)
      for (const t of tasks) {
        if ((scope && t.companyId !== scope) || !isOrphanTask(t, taskChannels)) continue
        const st = workState(t)
        const live = st === 'working' && !!t.runId
        const unread = orphanUnread(t, seen, TASK_SEEN_SINCE)
        if (!live && st !== 'needs_you' && !unread) continue
        if (t.runId) covered.add(t.runId)
        rows.push({ key: liveTaskKey(t.id), kind: 'task', task: t, companyId: t.companyId, live, at: t.updatedAt, unread })
      }
    // one row per conversation with Claude: a restart or hand-off continues the same chat (sessionRows.ts)
    for (const s of dedupeSessions(sessions)) {
      if (!inScope(s, scope) || s.companyAgentId) continue
      // a session that is a board task's run belongs to that task (its own row, or its conversation)
      if (s.taskId && tasks.some((t) => t.id === s.taskId && (!isOrphanTask(t, taskChannels) || rows.some((r) => r.key === liveTaskKey(t.id))))) continue
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
      // CHAT-UI.md §7: an agent answering in a conversation shows on the conversation's row, not as a run of its own
      if (/#chat-|(^|\s)replying in “/i.test(i.title)) continue
      rows.push({ key: `run:${i.agentId}`, kind: 'run', agentId: i.agentId, title: i.title, detail: i.detail, companyId: i.companyId, live: true, at: i.at })
    }
    return byWork(rows.map((r) => ({ r, rank: rowRank(r), at: r.at }))).map((x) => x.r)
  }, [sessions, agents, tasks, on, working, scope, convs, taskChannels, seen])
}

/**
 * PR-59: the rows of the list and the ones closed from it. The chat you have open stays listed, so what you picked from
 * search or the closed list keeps its selected row; a run row is live work, nothing to close.
 */
export function splitClosed(rows: readonly ChatRowModel[], closed: ClosedChats, picked?: string | null): { open: ChatRowModel[]; closed: ChatRowModel[] } {
  const out = { open: [] as ChatRowModel[], closed: [] as ChatRowModel[] }
  for (const r of rows) (r.key !== picked && r.kind !== 'run' && isClosed(r, rowRank(r), closed) ? out.closed : out.open).push(r)
  return out
}

/** Where a row sorts (convWork.workRank): needs you, then live, then unread news, then the rest. */
export function rowRank(r: ChatRowModel): number {
  if (r.kind === 'conv') return Math.max(workRank(r.work ?? { working: [], needs: [], queued: [], unread: [] }, r.conv.working), r.conv.unread > 0 ? 1 : 0)
  if (r.kind === 'task') return workState(r.task) === 'needs_you' ? 3 : r.live ? 2 : r.unread ? 1 : 0
  return r.live ? 2 : 0
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

/** Right-click a row: Close takes it off the list (Reopen brings it back), and only that: the chat keeps running. */
async function rowMenu(e: React.MouseEvent, row: ChatRowModel, onClose: () => void, rename?: () => void): Promise<void> {
  e.preventDefault()
  const closed = isClosed(row, rowRank(row), getState().closedChats)
  const id = await nativeMenu([...(rename ? [{ id: 'rename', label: 'Rename…' }] : []), closed ? { id: 'reopen', label: 'Reopen' } : { id: 'close', label: 'Close' }])
  if (id === 'rename') rename?.()
  if (id === 'reopen') reopenChat(row.key)
  if (id === 'close') onClose()
}

/** `onPick(key)`: a row may open something other than its own key (a working agent's row opens its task's live view). */
export function ChatRow({ row, selected, onPick, onClose }: { row: ChatRowModel; selected: boolean; onPick: (key?: string) => void; onClose: () => void }): React.JSX.Element {
  if (row.kind === 'agent') return <AgentChatRow row={row} selected={selected} onPick={onPick} onClose={onClose} />
  if (row.kind === 'session') return <SessionChatRow row={row} selected={selected} onPick={onPick} onClose={onClose} />
  if (row.kind === 'conv') return <ConvChatRow row={row} selected={selected} onPick={onPick} onClose={onClose} />
  if (row.kind === 'task') return <TaskChatRow row={row} selected={selected} onPick={onPick} onClose={onClose} />
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row is-shimmering ${selected ? 'is-selected' : ''}`} onClick={() => onPick()}>
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

function AgentChatRow({ row, selected, onPick, onClose }: { row: Extract<ChatRowModel, { kind: 'agent' }>; selected: boolean; onPick: (key?: string) => void; onClose: () => void }): React.JSX.Element {
  const who = useDeskWho(row.agent)
  const status = useAgentStatus(row.agent)
  const node = useSessionAgent(row.chat?.id)
  const seen = useStore((x) => (node ? !!x.seenIdle[node.id] : false))
  // CHAT-UI.md §8.6: live only while it answers in THIS chat; its tasks show on the conversations that filed them
  const turnWorking = !!node && row.chat?.status === 'running' && node.status === 'working'
  const working = turnWorking
  const unread = !selected && sessionUnread(node, seen)
  const needs = node?.status === 'needs_you' && node.needs !== 'idle'
  // like a bot list: what it is doing while it answers here, else the last thing it said here
  const said = node ? saidPreview(node, 160) : null
  const resting = status.kind === 'working' ? `${who.role} · open the chat` : status.text
  const line = turnWorking ? (node?.activity ? (plainActivity(node.activity) ?? firstLine(node.activity, 120)) : 'Working…') : needs ? 'Waiting for you to allow something' : (said ?? resting)
  return (
    <button type="button" role="option" aria-selected={selected} className={`chats5-row ${selected ? 'is-selected' : ''} ${working ? 'is-shimmering' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => onPick()} onContextMenu={(e) => void rowMenu(e, row, onClose)} title={`${who.name} · ${who.role}`}>
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

function SessionChatRow({ row, selected, onPick, onClose }: { row: Extract<ChatRowModel, { kind: 'session' }>; selected: boolean; onPick: (key?: string) => void; onClose: () => void }): React.JSX.Element {
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
    <button type="button" role="option" aria-selected={selected} className={`chats5-row ${selected ? 'is-selected' : ''} ${s.status === 'running' ? '' : 'is-dim'} ${working ? 'is-shimmering' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => onPick()} onContextMenu={(e) => void rowMenu(e, row, onClose)}>
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

/**
 * A conversation: its title (CHAT-UI.md §7.1: Principia names it; right-click › Rename… to name it yourself, kept for
 * good), who is in it ("Private · Seneca"), a shimmer while one of them answers IN it.
 */
function ConvChatRow({ row, selected, onPick, onClose }: { row: Extract<ChatRowModel, { kind: 'conv' }>; selected: boolean; onPick: (key?: string) => void; onClose: () => void }): React.JSX.Element {
  const c = row.conv
  const state = useForum((s) => s.byCompany[c.companyId]?.state ?? null)
  const display = useMemberDisplay(state?.members ?? [])
  const [renaming, setRenaming] = useState<string | null>(null)
  const who = whoLine(c)
  const answering = c.agentMemberIds.filter((id) => c.workingIds.includes(id)).map((id) => display(id)?.name).filter(Boolean).join(', ')
  const first = c.agentMemberIds[0]
  const unread = !selected && c.unread > 0
  const code = useIsCode(c.companyId)
  const names = useStore((s) => s.companyAgents)
  const nameOf = (agentId: string | null): string | null => (agentId ? (display(state?.members.find((m) => m.agentId === agentId)?.id ?? '')?.name ?? names.find((a) => a.id === agentId)?.name ?? null) : null)
  // CHAT-UI.md §8.6: the tasks it filed are its subagents: "2 tasks working", "1 needs you", "VO-16 finished · unread"
  const work = row.work
  const needs = !!work?.needs.length
  const taskLine = work ? workLine(selected ? { ...work, unread: [] } : work, { code }) : null
  const workers = work ? [...new Set(work.working.map((t) => nameOf(t.agentId ?? null)).filter(Boolean))].join(', ') : ''
  if (renaming !== null)
    return (
      <div className={`chats5-row ${selected ? 'is-selected' : ''}`} data-chatux="chat-row-rename">
        <input
          className="input input--sm chats5-row__rename"
          autoFocus
          value={renaming}
          maxLength={80}
          aria-label="Conversation title"
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={() => {
            void renameConversation(c.companyId, c.id, renaming)
            setRenaming(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              e.preventDefault()
              setRenaming(null)
            }
          }}
        />
      </div>
    )
  return (
    <button type="button" role="option" aria-selected={selected} data-chatux="chat-row" data-title={c.title} data-work={taskLine ?? undefined} className={`chats5-row ${selected ? 'is-selected' : ''} ${row.live || c.picking ? 'is-shimmering' : ''} ${unread || needs ? 'is-unread' : ''}`} onClick={() => onPick()} onContextMenu={(e) => void rowMenu(e, row, onClose, () => setRenaming(c.title))} onKeyDown={(e) => e.key === 'F2' && (e.preventDefault(), setRenaming(c.title))} title={`${c.title} · ${who}${taskLine ? ` · ${taskLine}` : ''} · right-click to rename or close`}>
      <span className="chats5-row__face chats5-row__face--bust" aria-hidden>
        {first ? <MemberAvatar display={display(first)} size={30} working={row.live} /> : <Icon name="chat" size={13} />}
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          <span className="chats5-row__name">{c.title}</span>
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        <span className={`chats5-row__last ${row.live || c.picking ? 'shimmer-text' : ''} ${needs ? 'is-needs' : ''}`}>
          {taskLine ? `${work!.working.length && workers ? `${workers} · ` : ''}${taskLine}` : row.live ? `${answering || who} · answering…` : c.picking && !c.who.length ? who : c.private ? who : `With ${who}`}
        </span>
      </span>
      {(unread || needs) && <span className={`chats5-row__dot ${needs ? 'is-needs' : ''}`} aria-label={needs ? 'Needs you' : 'Unread'} />}
    </button>
  )
}

/** CHAT-UI.md §8.6: a task with no conversation: who is on it, what it is doing now (or that it came back), its chat. */
function TaskChatRow({ row, selected, onPick, onClose }: { row: Extract<ChatRowModel, { kind: 'task' }>; selected: boolean; onPick: (key?: string) => void; onClose: () => void }): React.JSX.Element {
  const t = row.task
  const code = useIsCode(t.companyId)
  const seat = useStore((s) => (t.agentId ? s.companyAgents.find((a) => a.id === t.agentId) : undefined))
  const who = { name: useAgentDisplay()(seat)?.name ?? seat?.name ?? '' }
  const activity = useStore((s) => {
    if (!t.runId) return null
    let best: AgentNode | undefined
    for (const a of Object.values(s.agents)) if (a.runId === t.runId && a.parentId === null && (!best || a.updatedAt > best.updatedAt)) best = a
    return best?.activity ?? null
  })
  const st = workState(t)
  const needs = st === 'needs_you'
  const unread = !selected && row.unread
  const line = needs ? 'Needs you' : row.live ? (plainActivity(activity, { code }) ?? 'Working…') : st === 'failed' ? 'Stopped · unread' : 'Finished · unread'
  return (
    <button type="button" role="option" aria-selected={selected} data-chatux="task-row" data-task={t.identifier} className={`chats5-row ${selected ? 'is-selected' : ''} ${row.live ? 'is-shimmering' : ''} ${unread || needs ? 'is-unread' : ''}`} onClick={() => onPick()} onContextMenu={(e) => void rowMenu(e, row, onClose)} title={`${seat ? `${who.name} · ` : ''}${taskName(t, code)}`}>
      <span className="chats5-row__face chats5-row__face--bust" aria-hidden>
        {seat ? <AgentBust agent={seat} size={30} /> : <AgentGlyph visual={row.live ? 'running' : 'idle'} />}
      </span>
      <span className="chats5-row__body">
        <span className="chats5-row__top">
          <span className="chats5-row__name">{taskName(t, code)}</span>
          <span className="chats5-row__age">{age(row.at)}</span>
        </span>
        <span className={`chats5-row__last ${row.live ? 'shimmer-text' : ''} ${needs ? 'is-needs' : ''}`}>
          {seat ? `${who.name} · ` : ''}
          {line}
        </span>
      </span>
      {(unread || needs) && <span className={`chats5-row__dot ${needs ? 'is-needs' : ''}`} aria-label={needs ? 'Needs you' : 'Unread'} />}
    </button>
  )
}
