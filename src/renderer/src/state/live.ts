/**
 * Live agents slice (LIVE.md §6): every agent and open ask, snapshot once via agents:list + asks:list, then live via
 * agent:updated / agent:events / ask:updated. No polling. Updates are batched per animation frame so a burst of
 * subagent activity re-renders once.
 *
 * Degrades quietly: if main doesn't implement the live channels yet, the lists stay empty and nothing else changes.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AgentEvent, AgentNode, Ask, AskAnswer } from '@shared/live'
import type { Id } from '@shared/types'
import { errorCode, errorMessage, hive } from '../lib/hive'
import { indexAgents, isIdleWaiting, isLive, mergeAgent, mergeAsk, mergeEvents, needsOwners, needsYouCount, nextNeedsYou, slotWaitsWith, type AgentIndex } from '../lib/live'
import { departmentsOn, focusSession, followCompany, getState, loadJson, navigate, openBoard, scopeCompanyId, setState, toast, toastError, useStore, type State } from './store'
import { lastChatKey } from '../lib/agentChatView'
import { needsYouTasks } from '../lib/board'
import { liveTruth, needsIn, workingIn, type LiveScope, type LiveTruth, type NeedsSlice, type WorkingSlice } from '../lib/liveTruth'
import { reposOf, taskCounts, taskNeedsIn } from '../lib/companyModel'
import { laneContext } from '../lib/departments'

const DAY = 24 * 60 * 60_000

// ---------- batching ----------
let pendingAgents: AgentNode[] = []
let pendingAsks: Ask[] = []
let frame: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/**
 * One flush per animation frame, and never later than a short timer: a window that is hidden or behind another one
 * gets no animation frames, and its live state must not stall (a run that started or ended would show seconds late).
 */
function schedule(): void {
  if (frame !== null || timer !== null) return
  const run = (): void => {
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    if (timer !== null) clearTimeout(timer)
    frame = null
    timer = null
    flush()
  }
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run)
  timer = setTimeout(run, 100)
}
function flush(): void {
  const ag = pendingAgents
  const as = pendingAsks
  pendingAgents = []
  pendingAsks = []
  if (!ag.length && !as.length) return
  setState((s) => {
    const agents = ag.length ? { ...s.agents } : s.agents
    for (const a of ag) agents[a.id] = mergeAgent(agents[a.id], a)
    const asks = as.length ? { ...s.asks } : s.asks
    for (const a of as) asks[a.id] = mergeAsk(asks[a.id], a)
    const pruned = prune(agents)
    // A3: a turn that ends while its pane is on screen is seen at once, so it never lights the badge
    return { agents: pruned, asks, seenIdle: withVisibleSeen(reconcileSeen(s.seenIdle, pruned), pruned) }
  })
}

/** Keep the map bounded: ended agents older than 24 h drop out once it grows (the hub shows 24 h). */
function prune(agents: Record<Id, AgentNode>): Record<Id, AgentNode> {
  const ids = Object.keys(agents)
  if (ids.length < 1500) return agents
  const cutoff = Date.now() - DAY
  const out: Record<Id, AgentNode> = {}
  for (const id of ids) {
    const a = agents[id]!
    if (isLive(a) || !a.endedAt || Date.parse(a.endedAt) >= cutoff) out[id] = a
  }
  return out
}

/** A3: a session leaves "seen" as soon as it is no longer waiting for its turn. */
function reconcileSeen(seen: Record<Id, true>, agents: Record<Id, AgentNode>): Record<Id, true> {
  let changed = false
  const out: Record<Id, true> = {}
  for (const id of Object.keys(seen)) {
    const a = agents[id]
    if (a && isIdleWaiting(a)) out[id] = true
    else changed = true
  }
  return changed ? out : seen
}

/** Merge agents that arrived with another snapshot (canvas, dashboard, agents:get). */
export function mergeAgents(list: AgentNode[] | undefined): void {
  if (!list?.length) return
  pendingAgents.push(...list)
  schedule()
}
export function mergeAsks(list: Ask[] | undefined): void {
  if (!list?.length) return
  pendingAsks.push(...list)
  schedule()
}

// ---------- boot ----------
let loaded = false
export async function loadLive(): Promise<void> {
  try {
    const [agents, asks] = await Promise.all([
      hive.agents.list({ status: ['starting', 'working', 'needs_you', 'idle'], since: new Date(Date.now() - DAY).toISOString(), limit: 1000 }),
      hive.asks.list({ status: 'open', limit: 500 })
    ])
    loaded = true
    pendingAgents.push(...agents)
    pendingAsks.push(...asks)
    setState({ liveAvailable: true })
    flush()
    // the runs waiting for a free slot when this window opened; run:updated keeps them from here
    void hive.runs.list({ status: ['running'], limit: 200 }).then((runs) => setState((s) => ({ slotWaits: runs.reduce<Record<Id, string>>(slotWaitsWith, s.slotWaits) })), () => undefined)
  } catch (e) {
    // not implemented yet in main, or memory-less build: the hub stays empty, the rest of the app is unaffected
    setState({ liveAvailable: false })
    if (errorCode(e) !== 'internal') console.warn('[live] load failed:', errorMessage(e))
  }
}
export function liveLoaded(): boolean {
  return loaded
}

export function wireLiveEvents(): void {
  hive.on('agent:updated', (a) => {
    pendingAgents.push(a)
    schedule()
  })
  hive.on('ask:updated', (a) => {
    pendingAsks.push(a)
    schedule()
  })
  // A2: a run or session that ended takes its live agents with it in the same render, even when the agents' own
  // final update is still on its way (or never comes: a killed CLI)
  hive.on('run:updated', (run) => {
    const slotWaits = slotWaitsWith(getState().slotWaits, run)
    if (slotWaits !== getState().slotWaits) setState({ slotWaits })
    if (run.status === 'queued' || run.status === 'running') return
    endOwned((a) => a.runId === run.id && a.kind !== 'session', run.status === 'passed' ? 'done' : run.status === 'failed' ? 'failed' : 'canceled')
  })
  hive.on('pty:exit', ({ sessionId }) => endOwned((a) => a.sessionId === sessionId, 'done'))
  hive.on('agent:events', ({ agentId, events }) => {
    const subs = eventSubs.get(agentId)
    if (subs) for (const f of subs) f(events)
  })
  if (typeof window !== 'undefined') window.addEventListener('focus', () => markVisibleSeen())
}

/** Ends every live agent `owned` matches (run end, pane exit): the same batch as agent updates, so one render. */
function endOwned(owned: (a: AgentNode) => boolean, status: 'done' | 'failed' | 'canceled'): void {
  const now = new Date().toISOString()
  for (const a of Object.values(getState().agents)) {
    if (!owned(a) || !isLive(a)) continue
    pendingAgents.push({ ...a, status, needs: null, endedAt: a.endedAt ?? now, updatedAt: now })
  }
  schedule()
}

// ---------- A2: the one live source ----------
let truthMemo: { deps: unknown[]; truth: LiveTruth } | null = null
/**
 * Every working and needs-you number and list reads this (lib/liveTruth.ts). Memoised on the store slices it reads,
 * so every surface in a render shares one result.
 */
export function truthOf(s: State): LiveTruth {
  const on = departmentsOn(s)
  const deps: unknown[] = [s.agents, s.asks, s.seenIdle, s.sessions, s.tasks, s.companyAgents, s.companies, s.companiesLoaded, s.companyError, on, s.repos, s.suggestionCounts]
  if (truthMemo && truthMemo.deps.every((d, i) => d === deps[i])) return truthMemo.truth
  const paused = new Set(s.companies.filter((c) => c.pausedAt).map((c) => c.id))
  const counts = on ? taskCounts(s.tasks, laneContext(s.asks, s.companyAgents, paused)) : {}
  const taskNeeds: Record<Id, number> = {}
  for (const id of Object.keys(counts)) taskNeeds[id] = taskNeedsIn(counts, id)
  // ORCHESTRATOR.md §3: Principia's open suggestions wait on the founder too
  if (on) for (const [id, n] of Object.entries(s.suggestionCounts ?? {})) taskNeeds[id] = (taskNeeds[id] ?? 0) + n
  // an archived company's asks and agents leave every count with it (the rail lists only the others)
  const listed = s.companiesLoaded && !s.companyError ? new Set(s.companies.map((c) => c.id)) : undefined
  const code = new Set(s.companies.filter((c) => reposOf(s.repos, c.id).length > 0).map((c) => c.id))
  const truth = liveTruth({ agents: Object.values(s.agents), asks: Object.values(s.asks), seen: new Set(Object.keys(s.seenIdle)), sessions: s.sessions, tasks: s.tasks, taskNeeds, listed, code })
  truthMemo = { deps, truth }
  return truth
}
export function useLiveTruth(): LiveTruth {
  return useStore(truthOf)
}
/** Agents working now in a scope (a company id, or 'all' / undefined for every company). */
export function useWorking(scope?: LiveScope): WorkingSlice {
  const t = useLiveTruth()
  return useMemo(() => workingIn(t, scope), [t, scope])
}
/** Everything that needs you in a scope: live asks, finished turns and board tasks waiting on you. */
export function useNeeds(scope?: LiveScope): NeedsSlice {
  const t = useLiveTruth()
  return useMemo(() => needsIn(t, scope), [t, scope])
}
/** The same slices outside React (palette commands, ⌘J). */
export function workingNow(scope?: LiveScope): WorkingSlice {
  return workingIn(truthOf(getState()), scope)
}
export function needsNow(scope?: LiveScope): NeedsSlice {
  return needsIn(truthOf(getState()), scope)
}

// ---------- visible owner + A3 seen ----------
let lastOwner = ''
/** Report what the user is looking at (notification suppression, A3), and mark visible idle sessions seen. */
export function reportVisibleOwner(): void {
  const s = getState()
  const owner = visibleOwner()
  const key = JSON.stringify(owner)
  if (key !== lastOwner) {
    lastOwner = key
    try {
      hive.send('ui:visibleOwner', owner)
    } catch {
      /* preload built without the channel: nothing to tell */
    }
  }
  if (s.window.focused) markVisibleSeen()
}
/**
 * AGENT CHAT: the chat on screen outside a session pane: an agent's chat on its page or in Chats, or a chat open in
 * Chats. Reading an agent's answer there is seeing it (never "your turn" in Needs you while it is on screen).
 */
function shownChatSession(s: ReturnType<typeof getState>): Id | null {
  const agentChat = (agentId: Id): Id | null => s.sessions.find((x) => x.companyAgentId === agentId && x.status === 'running')?.id ?? null
  if (s.view.name === 'agentSeat') return agentChat(s.view.id)
  // Chats with nothing picked shows the last conversation open in this company (ChatsView)
  const open = s.view.name === 'chats' ? (s.view.chat ?? loadJson<string | null>(lastChatKey(scopeCompanyId()), null)) : null
  if (open) {
    const [kind, id] = open.split(':')
    if (kind === 'agent' && id) return agentChat(id)
    if (kind === 'session' && id) return id
  }
  return null
}
function visibleOwner(): { sessionId: Id | null; runId: Id | null; board?: Id | 'all' } {
  const s = getState()
  if (!s.window.focused) return { sessionId: null, runId: null }
  if (s.view.name === 'session') return { sessionId: s.focusedSession, runId: null }
  const shown = shownChatSession(s)
  if (shown) return { sessionId: shown, runId: null }
  if (s.view.name === 'run') return { sessionId: null, runId: s.view.runId }
  // SOUNDS.md: a card moving on the Board you are looking at is seen, not heard
  if (s.view.name === 'tasks' || s.view.name === 'plans' || s.view.name === 'department') return { sessionId: null, runId: null, board: scopeCompanyId(s) ?? 'all' }
  return { sessionId: null, runId: null }
}
/** The session the user is looking at (the same owner main is told about, so the badge and the tray agree). */
function visibleSessions(): Set<Id> {
  const s = getState()
  if (!s.window.focused) return new Set()
  const shown = s.view.name === 'session' ? s.focusedSession : shownChatSession(s)
  return shown ? new Set([shown]) : new Set()
}
function withVisibleSeen(seen: Record<Id, true>, agents: Record<Id, AgentNode>): Record<Id, true> {
  const vis = visibleSessions()
  if (!vis.size) return seen
  let next: Record<Id, true> | null = null
  for (const a of Object.values(agents)) {
    if (a.kind === 'session' && a.sessionId && vis.has(a.sessionId) && isIdleWaiting(a) && !seen[a.id]) {
      next ??= { ...seen }
      next[a.id] = true
    }
  }
  return next ?? seen
}
function markVisibleSeen(): void {
  const s = getState()
  const next = withVisibleSeen(s.seenIdle, s.agents)
  if (next !== s.seenIdle) setState({ seenIdle: next })
}

// ---------- hooks ----------
/**
 * Finished turns that do not wait on you: the ones you saw, and (AGENT CHAT) every answer of an agent in its own chat
 * (its Chats row carries the unread dot instead; what it asks you to allow still waits). Needs you reads this set.
 */
export function needsSeen(seenIdle: Record<Id, true>, agents: Record<Id, AgentNode>, sessions: readonly { id: Id; companyAgentId?: Id | null }[]): Set<Id> {
  const out = new Set(Object.keys(seenIdle))
  const agentChats = new Set(sessions.filter((x) => x.companyAgentId).map((x) => x.id))
  if (agentChats.size) for (const a of Object.values(agents)) if (a.kind === 'session' && a.sessionId && agentChats.has(a.sessionId)) out.add(a.id)
  return out
}
export function useSeenSet(): ReadonlySet<Id> {
  const seen = useStore((s) => s.seenIdle)
  const agents = useStore((s) => s.agents)
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => needsSeen(seen, agents, sessions), [seen, agents, sessions])
}
export function useAgentIndex(): AgentIndex {
  const agents = useStore((s) => s.agents)
  return useMemo(() => indexAgents(Object.values(agents)), [agents])
}
export function useOpenAsks(): Ask[] {
  const asks = useStore((s) => s.asks)
  return useMemo(() => Object.values(asks).filter((a) => a.status === 'open').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)), [asks])
}
export function useNeedsOwners(): { sessions: Set<Id>; runs: Set<Id> } {
  const agents = useStore((s) => s.agents)
  const asks = useOpenAsks()
  const seen = useSeenSet()
  return useMemo(() => needsOwners(Object.values(agents), asks, seen), [agents, asks, seen])
}
export function useNeedsYouCount(): number {
  const agents = useStore((s) => s.agents)
  const asks = useOpenAsks()
  const seen = useSeenSet()
  return useMemo(() => needsYouCount(Object.values(agents), asks, seen), [agents, asks, seen])
}

// event subscriptions: only agents someone is looking at keep their events in memory
const eventSubs = new Map<Id, Set<(e: AgentEvent[]) => void>>()
/** Newest events of one agent (paged from agents:events), kept live from agent:events. */
export function useAgentEvents(agentId: Id | null, limit = 200): { events: AgentEvent[]; loading: boolean; error: string | null; loadOlder: () => void; hasOlder: boolean } {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasOlder, setHasOlder] = useState(false)
  useEffect(() => {
    setEvents([])
    setError(null)
    setHasOlder(false)
    if (!agentId) return
    let live = true
    const sub = (ev: AgentEvent[]): void => setEvents((l) => mergeEvents(l, ev))
    let set = eventSubs.get(agentId)
    if (!set) eventSubs.set(agentId, (set = new Set()))
    set.add(sub)
    setLoading(true)
    hive.agents.events({ agentId, limit }).then(
      (ev) => {
        if (!live) return
        setEvents((l) => mergeEvents(l, ev))
        setHasOlder(ev.length >= limit)
        setLoading(false)
      },
      (e) => {
        if (!live) return
        setError(errorMessage(e))
        setLoading(false)
      }
    )
    return () => {
      live = false
      set!.delete(sub)
      if (!set!.size) eventSubs.delete(agentId)
    }
  }, [agentId, limit])
  const loadOlder = (): void => {
    if (!agentId || !events.length) return
    void hive.agents.events({ agentId, beforeSeq: events[0]!.seq, limit }).then((ev) => {
      setEvents((l) => mergeEvents(ev, l, 2000))
      setHasOlder(ev.length >= limit)
    }, () => undefined)
  }
  return { events, loading, error, loadOlder, hasOlder }
}

// ---------- actions ----------
/** Answer an ask (Allow / Deny / a choice / text). Conflicts ("answered in the terminal") are shown, not thrown. */
export async function answerAsk(a: AskAnswer): Promise<Ask | null> {
  try {
    const res = await hive.asks.answer(a)
    mergeAsks([res])
    return res
  } catch (e) {
    if (errorCode(e) === 'conflict') {
      toast(errorMessage(e) || 'Already answered in the terminal')
      // the ask is no longer open in main: refresh it so the card goes away
      void hive.asks.list({ status: 'all', limit: 200 }).then((l) => mergeAsks(l.filter((x) => x.id === a.askId)), () => undefined)
      return null
    }
    toastError(e, 'Answer')
    return null
  }
}

/** Reply to an idle session root: main writes text + Return into its PTY (agents:reply). */
export async function replyToAgent(agentId: Id, text: string): Promise<boolean> {
  try {
    await hive.agents.reply({ agentId, text })
    return true
  } catch (e) {
    if (errorCode(e) === 'conflict') {
      toast('It’s not waiting for a reply anymore. Open the terminal to type there.')
      return false
    }
    toastError(e, 'Reply')
    return false
  }
}

async function findAgent(agentId: Id): Promise<AgentNode | null> {
  const known = getState().agents[agentId]
  if (known) return known
  try {
    const d = await hive.agents.get({ id: agentId, eventsLimit: 1 })
    mergeAgents([d.agent, ...d.descendants])
    mergeAsks(d.asks)
    return d.agent
  } catch {
    return null
  }
}

/** Jump to an agent: sessions focus their pane, steps and subagents open the run view expanded to it (LIVE.md §6). */
export async function focusAgent(agentId: Id, askId: Id | null = null): Promise<void> {
  const a = await findAgent(agentId)
  if (!a) return void toast('That agent is gone.')
  const root = a.kind === 'subagent' ? (getState().agents[a.rootId] ?? (await findAgent(a.rootId)) ?? a) : a
  setState({ agentFocus: { agentId: a.id, askId, nonce: Date.now() } })
  if (root.sessionId) {
    const sess = getState().sessions.find((s) => s.id === root.sessionId)
    if (sess) return focusSession(sess.id)
  }
  if (root.runId) {
    // COMPANY.md §8.4: opening another company's run follows it (sessions follow through focusSession)
    const stamp = (root as { companyId?: Id }).companyId ?? (a as { companyId?: Id }).companyId
    if (stamp) followCompany(stamp)
    else {
      const run = await hive.runs.get({ id: root.runId }).catch(() => null)
      if (run?.run.companyId) followCompany(run.run.companyId)
    }
    return void navigate({ name: 'run', runId: root.runId, stepId: root.stepId ?? undefined, agentId: a.id })
  }
  void navigate({ name: 'agents' })
}

/**
 * ⌘J: the next thing that needs you, in the company you are in (every company in All mode), the same list Home
 * counts: the oldest open ask or finished turn first, then the board tasks waiting on you (a review opens with Approve
 * on top). "Nothing needs you." only when that list is empty.
 */
export function goNextNeedsYou(): void {
  const s = getState()
  const scope = scopeCompanyId(s)
  const live = needsIn(truthOf(s), scope ?? 'all').items[0]
  if (live) return void focusAgent(live.agentId, live.askId)
  if (departmentsOn(s)) {
    const paused = new Set(s.companies.filter((c) => c.pausedAt).map((c) => c.id))
    const task = needsYouTasks(s.tasks, laneContext(s.asks, s.companyAgents, paused), scope, { skipLiveAsks: true })[0]
    if (task) return void openBoard(task.task.companyId, { taskId: task.task.id })
  }
  // outside any company scope (Personal sessions): the hub's own order
  const next = scope ? null : nextNeedsYou(Object.values(s.agents), Object.values(s.asks), needsSeen(s.seenIdle, s.agents, s.sessions))
  if (!next) return void toast('Nothing needs you.')
  void focusAgent(next.agentId, next.askId)
}
