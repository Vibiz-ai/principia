/**
 * REMOTE.md RA3: the Phone's view models, built in main from the same data and the same pure functions the desktop
 * uses (the one live source, liveTruth; needsYouTasks; the desk thread; personas), so the phone and the Mac never
 * disagree. Every builder takes one company and returns only that company's rows. Pure: no hive, no Electron.
 */
import type { CompanyAgent, CompanyPassport, CompanyTask, Department, TaskDetail } from '../../shared/company'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Ask, AgentNode, RunCard } from '../../shared/live'
import type { Id, Repo, Session } from '../../shared/types'
import { resolvePersonas } from '../../shared/personas'
import type { PhoneAgent, PhoneAsk, PhoneChatRef, PhoneChatRow, PhoneChats, PhoneCompany, PhoneDone, PhoneNeeds, PhoneNow, PhoneTaskColumn, PhoneTaskDetail, PhoneTaskNeed, PhoneTaskRow, PhoneTasks, PhoneThreadItem, PhoneWho, PhoneWorking } from '../../shared/remote'
import { PHONE_TASKS_DONE, PHONE_TASKS_PLANNED } from '../../shared/remote'
import { liveTruth, needsIn, workingIn, type LiveTruth } from '../../renderer/src/lib/liveTruth'
import { reposOf, taskCounts, taskNeedsIn } from '../../renderer/src/lib/companyModel'
import { suggestionCounts, type OrchSuggestion } from '../../shared/orchestrator'
import { laneContext } from '../../renderer/src/lib/departments'
import { needsYouTasks } from '../../renderer/src/lib/board'
import { isLive, saidPreview } from '../../renderer/src/lib/live'
import { plainActivity } from '../../renderer/src/lib/plainActivity'
import { deskTasks, deskThread } from '../../renderer/src/lib/deskThread'
import { finishedLine, taskOrigin } from '../../renderer/src/lib/desk'
import { BUST_NAMES } from './bustNames'
import { autopilotState } from '../../shared/autopilotState'
import { playbooksOnOf } from '../../shared/autopilotPlaybooks'

type Stamped = { companyId?: Id | null }

export interface PhoneData {
  /** companies the rail lists (not archived) */
  companies: CompanyPassport[]
  agents: (AgentNode & Stamped)[]
  asks: (Ask & Stamped)[]
  sessions: Session[]
  tasks: CompanyTask[]
  companyAgents: CompanyAgent[]
  departments: Department[]
  repos: Repo[]
  personas: boolean
  departmentsOn: boolean
  /** idle session roots looked at from the phone (A3 "seen") */
  seen: ReadonlySet<Id>
  /** ORCHESTRATOR.md §3: Principia's open suggestions (they count in Needs you; decided on the Mac) */
  suggestions?: OrchSuggestion[]
  /** AUTOPILOT.md §7: the autopilots on per company (the Now header names them) */
  playbooks?: import('../../shared/autopilotPlaybooks').PlaybookSummary
}

const PROVIDER: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', shell: 'Terminal' }
export const providerName = (a: string): string => PROVIDER[a] ?? a

const memo = new WeakMap<PhoneData, LiveTruth>()
/** The one live source (five doors A2), exactly as the desktop's state/live.ts truthOf builds it. */
export function truthOf(d: PhoneData): LiveTruth {
  const hit = memo.get(d)
  if (hit) return hit
  const paused = new Set(d.companies.filter((c) => c.pausedAt).map((c) => c.id))
  const asksById: Record<Id, Ask> = {}
  for (const a of d.asks) asksById[a.id] = a
  const counts = d.departmentsOn ? taskCounts(d.tasks, laneContext(asksById, d.companyAgents, paused)) : {}
  const taskNeeds: Record<Id, number> = {}
  for (const id of Object.keys(counts)) taskNeeds[id] = taskNeedsIn(counts, id)
  if (d.departmentsOn) for (const [id, n] of Object.entries(suggestionCounts(d.suggestions ?? []))) taskNeeds[id] = (taskNeeds[id] ?? 0) + n
  const listed = new Set(d.companies.map((c) => c.id))
  const code = new Set(d.companies.filter((c) => reposOf(d.repos, c.id).length > 0).map((c) => c.id))
  const t = liveTruth({ agents: d.agents, asks: d.asks, seen: d.seen, sessions: d.sessions, tasks: d.tasks, taskNeeds, listed, code })
  memo.set(d, t)
  return t
}

/** "Marcus · Copywriter" with personas on, else the role label. */
export function whoResolver(d: Pick<PhoneData, 'companyAgents' | 'departments' | 'personas'>): (a: CompanyAgent | undefined | null) => PhoneWho | null {
  const personas = d.personas ? resolvePersonas(d.companyAgents, d.departments) : new Map()
  return (a) => {
    if (!a) return null
    const p = personas.get(a.id)
    const name = p ? p.name : a.name
    const base = name.replace(/ [IVX]+$/, '')
    return { name, role: p ? a.name : '', bust: p && BUST_NAMES.has(base) ? base : null }
  }
}

export function phoneCompanies(d: PhoneData): PhoneCompany[] {
  const t = truthOf(d)
  const w = workingIn(t, 'all').byCompany
  const n = needsIn(t, 'all').byCompany
  return d.companies.map((c) => ({ id: c.id, name: c.name, personal: c.id === PERSONAL_COMPANY_ID || c.system === 'personal', paused: !!c.pausedAt, working: w[c.id] ?? 0, needs: n[c.id] ?? 0 }))
}

/** The board task a live item works on: its own task, or the in-progress task its run belongs to. */
function taskFor(d: PhoneData, i: { taskId?: Id; runId: Id | null; sessionId: Id | null }): CompanyTask | undefined {
  return (i.taskId ? d.tasks.find((t) => t.id === i.taskId && t.status === 'in_progress') : undefined) ?? d.tasks.find((t) => !!t.runId && (t.runId === i.runId || t.runId === i.sessionId) && t.status === 'in_progress')
}
/** The seat behind a run or session: the task that run belongs to (any status) and its agent. */
function seatForRun(d: PhoneData, runOrSession: (Id | null)[]): CompanyAgent | undefined {
  const ids = runOrSession.filter((x): x is Id => !!x)
  const t = d.tasks.find((x) => !!x.runId && ids.includes(x.runId))
  return t?.agentId ? d.companyAgents.find((a) => a.id === t.agentId && a.companyId === t.companyId) : undefined
}
function chatRefOf(d: PhoneData, companyId: Id, sessionId: Id | null, agent: CompanyAgent | undefined): PhoneChatRef | null {
  if (agent && agent.companyId === companyId) return { kind: 'agent', id: agent.id }
  if (sessionId && d.sessions.some((s) => s.id === sessionId && (s.companyId || PERSONAL_COMPANY_ID) === companyId)) return { kind: 'session', id: sessionId }
  return null
}

/** A chat of yours (no agent seat) as the "who" of a card: its title, and which assistant. */
export const chatWho = (s: Session): PhoneWho => ({ name: oneLine(s.title || 'Your chat', 60), role: `Your chat with ${providerName(s.adapter)}`, bust: null })

/**
 * A run's title as words. Older Forum reply runs were titled with their whole prompt ("Forum reply in #general
 * <principia-role …"): everything from the first frame on is cut.
 */
export function runTitle(title: string): string {
  const cut = title.replace(/<principia-[\s\S]*$/i, '').trim()
  return oneLine(cut || 'A run', 80)
}

/**
 * `runAgents`: run id → the agent seat that run belongs to (runs.agent_id), for runs with no board task, such as a
 * Forum reply run.
 */
export function phoneNow(d: PhoneData, companyId: Id, done: RunCard[] = [], runAgents: ReadonlyMap<Id, Id> = new Map()): PhoneNow {
  const t = truthOf(d)
  const who = whoResolver(d)
  const co = d.companies.find((c) => c.id === companyId)
  const seat = (agentId: Id | null | undefined): CompanyAgent | undefined => (agentId ? d.companyAgents.find((a) => a.id === agentId && a.companyId === companyId) : undefined)
  const working: PhoneWorking[] = workingIn(t, companyId).items.map((i) => {
    const task = taskFor(d, i)
    const agent = (task?.agentId ? d.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined) ?? (i.runId ? seat(runAgents.get(i.runId)) : undefined)
    const session = i.chat && i.sessionId ? d.sessions.find((s) => s.id === i.sessionId) : undefined
    const w = who(agent)
    return {
      key: i.key,
      who: w ?? (session ? chatWho(session) : null),
      title: task ? task.title : session ? oneLine(session.title, 80) : runTitle(i.title),
      activity: i.detail,
      startedAt: i.startedAt ?? i.at,
      open: chatRefOf(d, companyId, i.sessionId, agent)
    }
  })
  const out: PhoneDone[] = []
  const taskRuns = new Set<Id>()
  for (const task of d.tasks) {
    if (task.companyId !== companyId) continue
    if (task.runId) taskRuns.add(task.runId)
    if (task.status !== 'done' && task.status !== 'in_review') continue
    const agent = task.agentId ? d.companyAgents.find((a) => a.id === task.agentId && a.companyId === companyId) : undefined
    out.push({ key: `task:${task.id}`, title: task.title, who: who(agent), at: task.updatedAt, status: task.status === 'done' ? 'done' : 'review', summary: task.report?.summary ? oneLine(task.report.summary, 200) : task.status === 'in_review' ? finishedLine(task.title) : (task.doneNote ? oneLine(task.doneNote, 200) : null) })
  }
  for (const c of done) {
    const r = c.run
    if ((r.companyId || PERSONAL_COMPANY_ID) !== companyId || taskRuns.has(r.id) || !r.endedAt) continue
    out.push({ key: `run:${r.id}`, title: runTitle(r.title), who: who(seat(r.agentId)), at: r.endedAt, status: r.status === 'failed' ? 'failed' : 'done', summary: r.status === 'failed' ? (c.failedStep?.error ? oneLine(c.failedStep.error, 160) : 'It stopped with an error.') : null })
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const personal = !co || co.id === PERSONAL_COMPANY_ID || co.system === 'personal'
  return { companyId, name: co?.name ?? 'Personal', paused: !!co?.pausedAt, ...(personal ? {} : { autopilot: autopilotState(co, playbooksOnOf(d.playbooks, companyId)).mode, autopilotLabel: autopilotState(co, playbooksOnOf(d.playbooks, companyId)).label }), needs: needsIn(t, companyId).count, working, done: out.slice(0, 12) }
}

/** The command, file or address a tool asks to use, for the ask card ("git push origin main"). */
function inputLine(input: unknown): string | null {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const v = [i.command, i.file_path, i.url, i.pattern].find((x) => typeof x === 'string' && x.trim()) as string | undefined
  return v ? oneLine(v, 300) : null
}

const oneLine = (s: string, max: number): string => {
  const l = s.replace(/\s+/g, ' ').trim()
  return l.length > max ? `${l.slice(0, max - 1).trimEnd()}…` : l
}

/** RA3: the options a phone may press. Never "focus" (the terminal) nor a rule that outlives the request. */
export function phoneOptions(ask: Ask): PhoneAsk['options'] {
  const session = !!ask.sessionId && !ask.runId
  return ask.options
    .filter((o) => o.kind !== 'focus' && o.kind !== 'allow_always' && !/^sug_/.test(o.id) && !(session && o.kind === 'allow_step'))
    .map((o) => ({ id: o.id, label: o.label, kind: o.kind as 'allow' | 'allow_step' | 'deny' | 'choice' }))
}
/** An ask the phone may answer at all (approvals of workflow drafts stay on the Mac: RA3 no workflow editing). */
export function phoneAnswerable(ask: Ask): boolean {
  if (ask.status !== 'open' || ask.kind === 'approval') return false
  return phoneOptions(ask).length > 0 || ask.kind === 'question'
}

export function phoneNeeds(d: PhoneData, companyId: Id): PhoneNeeds {
  const t = truthOf(d)
  const who = whoResolver(d)
  const slice = needsIn(t, companyId)
  const byId = new Map(d.asks.map((a) => [a.id, a]))
  const agentsById = new Map(d.agents.map((a) => [a.id, a]))
  const asks: PhoneAsk[] = []
  for (const i of slice.items) {
    const ask = i.askId ? byId.get(i.askId) : undefined
    const node = agentsById.get(i.agentId)
    const root = node ? (agentsById.get(node.rootId) ?? node) : undefined
    const seat = seatForRun(d, [i.runId, i.sessionId, root?.runId ?? null, root?.sessionId ?? null])
    const session = (i.sessionId ?? root?.sessionId) ? d.sessions.find((s) => s.id === (i.sessionId ?? root?.sessionId)) : undefined
    // an agent's own chat speaks as the agent (AGENT CHAT), never as "Your chat with Codex"
    const chatAgent = session?.companyAgentId ? d.companyAgents.find((a) => a.id === session.companyAgentId) : undefined
    const w = who(seat) ?? who(chatAgent) ?? (session ? chatWho(session) : null)
    const open = chatRefOf(d, companyId, i.sessionId ?? root?.sessionId ?? null, seat)
    if (ask) {
      const ok = phoneAnswerable(ask)
      asks.push({
        id: ask.id,
        title: ask.title,
        question: ask.question,
        detail: ask.kind === 'approval' ? 'A workflow change: review it on your Mac.' : ok ? (ask.detail ?? inputLine(ask.toolInput)) : (ask.detail ?? 'Answer this on your Mac.'),
        who: w,
        options: ok ? phoneOptions(ask) : [],
        text: ok && ask.kind === 'question',
        at: ask.createdAt,
        open
      })
    } else {
      asks.push({ id: i.key, title: i.kind === 'idle' ? 'Finished, your turn' : i.title, question: null, detail: i.kind === 'idle' ? (root ? saidPreview(root, 300) : null) ?? i.title : (i.detail ?? 'Waiting for you on the Mac'), who: w, options: [], text: false, at: i.at, open })
    }
  }
  const tasks: PhoneTaskNeed[] = []
  if (d.departmentsOn) {
    const paused = new Set(d.companies.filter((c) => c.pausedAt).map((c) => c.id))
    const asksById: Record<Id, Ask> = {}
    for (const a of d.asks) asksById[a.id] = a
    for (const item of needsYouTasks(d.tasks, laneContext(asksById, d.companyAgents, paused), companyId, { skipLiveAsks: true })) {
      const task = item.task
      if (task.companyId !== companyId) continue
      const agent = task.agentId ? d.companyAgents.find((a) => a.id === task.agentId && a.companyId === companyId) : undefined
      const base = { taskId: task.id, title: task.title, who: who(agent), agentId: agent?.id ?? null, at: task.updatedAt, options: [] as string[] }
      if (item.group === 'review') tasks.push({ ...base, kind: 'review', text: task.report?.summary ? oneLine(task.report.summary, 600) : finishedLine(task.title) })
      else if (item.reason === 'needs_input' && task.ask && !task.ask.answer) tasks.push({ ...base, kind: 'question', text: task.ask.prompt, options: task.ask.options ?? [] })
      else tasks.push({ ...base, kind: 'stuck', text: item.group === 'unassigned' ? `${task.title} has no agent yet. Assign it on your Mac.` : `${task.title} is stopped. Look at it on your Mac.` })
    }
  }
  // Principia's suggestions: shown so the count adds up, decided on the Mac (each one is the founder's own yes there)
  if (d.departmentsOn)
    for (const sg of d.suggestions ?? []) {
      if (sg.companyId !== companyId || sg.status !== 'open') continue
      tasks.push({ taskId: sg.id, kind: 'idea', title: sg.title, text: sg.detail ? `${sg.detail} Decide on your Mac, in Needs you.` : 'Decide on your Mac, in Needs you.', who: null, agentId: null, at: sg.createdAt, options: [] })
    }
  return { companyId, count: slice.count, asks, tasks }
}

export function phoneChats(d: PhoneData, companyId: Id): PhoneChats {
  const t = truthOf(d)
  const who = whoResolver(d)
  const working = workingIn(t, companyId)
  const liveRuns = new Set<Id>()
  const liveSessions = new Set<Id>()
  const activity = new Map<Id, string | null>()
  for (const i of working.items) {
    if (i.runId) liveRuns.add(i.runId)
    if (i.sessionId) liveSessions.add(i.sessionId)
    if (i.sessionId) activity.set(i.sessionId, i.detail)
    if (i.runId) activity.set(i.runId, i.detail)
  }
  const rows: PhoneChatRow[] = []
  const covered = new Set<Id>()
  if (d.departmentsOn)
    for (const a of d.companyAgents) {
      if (a.archivedAt || a.companyId !== companyId) continue
      const mine = d.tasks.filter((x) => x.agentId === a.id && x.companyId === a.companyId)
      // AGENT CHAT: the agent's own chat is its row (its sessions are not listed again as chats of yours)
      const chats = d.sessions.filter((x) => x.companyAgentId === a.id && (x.companyId || PERSONAL_COMPANY_ID) === companyId)
      if (!mine.length && !chats.length) continue
      for (const c of chats) covered.add(c.id)
      const chat = [...chats].sort((x, y) => Number(liveSessions.has(y.id)) - Number(liveSessions.has(x.id)) || (x.startedAt < y.startedAt ? 1 : -1))[0]
      const chatRoot = chat ? d.agents.find((x) => x.kind === 'session' && x.sessionId === chat.id && x.parentId === null) : undefined
      const cur = mine.find((x) => x.status === 'in_progress')
      const chatLive = !!chat && liveSessions.has(chat.id) && !!chatRoot && (chatRoot.status === 'working' || chatRoot.status === 'starting')
      const live = (!!cur?.runId && (liveRuns.has(cur.runId) || liveSessions.has(cur.runId))) || chatLive
      if (cur?.runId) covered.add(cur.runId)
      const latest = [...mine].sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1))[0]
      const chatAt = chatRoot?.updatedAt ?? chat?.startedAt ?? ''
      const at = latest && latest.updatedAt > chatAt ? latest.updatedAt : chatAt
      const said = chatRoot ? saidPreview(chatRoot, 140) : null
      const line = chatLive && chat ? (activity.get(chat.id) ?? 'Working') : live && cur?.runId ? (activity.get(cur.runId) ?? `Working on ${cur.title}`) : said && (!latest || chatAt >= latest.updatedAt) ? said : latest ? (latest.status === 'in_review' ? `Waiting for your OK: ${latest.title}` : latest.title) : said
      rows.push({ key: `agent:${a.id}`, ref: { kind: 'agent', id: a.id }, title: who(a)?.name ?? a.name, who: who(a), live, at, line })
    }
  const agentsBySession = new Map<Id, AgentNode>()
  for (const a of d.agents) if (a.kind === 'session' && a.sessionId && a.parentId === null) agentsBySession.set(a.sessionId, a)
  for (const s of d.sessions) {
    if ((s.companyId || PERSONAL_COMPANY_ID) !== companyId || covered.has(s.id)) continue
    const root = agentsBySession.get(s.id)
    const live = liveSessions.has(s.id)
    rows.push({ key: `session:${s.id}`, ref: { kind: 'session', id: s.id }, title: s.title, who: { name: providerName(s.adapter), role: '', bust: null }, live, at: s.endedAt ?? root?.updatedAt ?? s.startedAt, line: live ? (activity.get(s.id) ?? 'Working') : root ? saidPreview(root, 140) : s.status === 'exited' ? 'Ended' : null })
    covered.add(s.id)
  }
  rows.sort((a, b) => Number(b.live) - Number(a.live) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return { companyId, rows }
}

// ---------- the board (RA3, read only) ----------

const PLANNED = new Set(['triage', 'backlog', 'todo', 'blocked'])
const NEED_LINE: Record<PhoneTaskNeed['kind'], string> = { review: 'Ready for your OK', question: 'A question for you', stuck: 'Stuck: look at it', idea: 'An idea' }
const BLOCKED: Record<string, string> = { deps: 'Waits for another task', limit: 'Waits for a free slot', needs_input: 'Waits for an answer' }

/** What its agent does right now (the desk's live line), or null. */
function liveLine(d: PhoneData, task: CompanyTask): string | null {
  const live = task.runId ? d.agents.find((x) => isLive(x) && x.parentId === null && (x.runId === task.runId || x.sessionId === task.runId)) : undefined
  return live ? plainActivity(live.activity, { code: reposOf(d.repos, task.companyId).length > 0 }) : null
}

interface BoardCtx {
  needs: Map<Id, PhoneTaskNeed>
  who: (a: CompanyAgent | undefined | null) => PhoneWho | null
}
function boardCtx(d: PhoneData, companyId: Id): BoardCtx {
  const needs = new Map<Id, PhoneTaskNeed>()
  for (const n of phoneNeeds(d, companyId).tasks) if (n.kind !== 'idea') needs.set(n.taskId, n)
  return { needs, who: whoResolver(d) }
}
function columnOf(task: CompanyTask, c: BoardCtx): PhoneTaskColumn | null {
  if (c.needs.has(task.id) || task.status === 'in_review') return 'needs'
  if (task.status === 'in_progress') return 'working'
  if (task.status === 'done') return 'done'
  return PLANNED.has(task.status) ? 'planned' : null
}
function taskRow(d: PhoneData, task: CompanyTask, column: PhoneTaskColumn, c: BoardCtx, redact: (s: string) => string): PhoneTaskRow {
  const agent = task.agentId ? d.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined
  const need = c.needs.get(task.id)
  const line =
    column === 'working'
      ? liveLine(d, task)
      : column === 'needs'
        ? (need ? NEED_LINE[need.kind] : 'Ready for your OK')
        : column === 'planned' && task.status === 'blocked'
          ? (BLOCKED[task.blockReason ?? ''] ?? 'Blocked')
          : column === 'done' && task.report?.summary
            ? oneLine(task.report.summary, 160)
            : null
  return {
    id: task.id,
    identifier: task.identifier,
    title: redact(oneLine(task.title, 200)),
    status: task.status,
    column,
    who: c.who(agent),
    agentId: agent?.id ?? null,
    line: line ? redact(line) : null,
    priority: task.priority ?? 0,
    at: task.updatedAt
  }
}

/** The company's board on the phone: Planned, Working, Needs you, Done in the last 7 days. Only this company's tasks. */
export function phoneTasks(d: PhoneData, companyId: Id, redact: (s: string) => string = (s) => s, now = Date.now()): PhoneTasks {
  const c = boardCtx(d, companyId)
  const out: PhoneTasks = { companyId, planned: [], working: [], needs: [], done: [], more: 0 }
  const since = now - 7 * 86_400_000
  for (const task of d.tasks) {
    if (task.companyId !== companyId) continue
    const col = columnOf(task, c)
    if (!col || (col === 'done' && !(Date.parse(task.updatedAt) >= since))) continue
    out[col].push(taskRow(d, task, col, c, redact))
  }
  const newest = (a: PhoneTaskRow, b: PhoneTaskRow): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
  // urgent first (priority 0 is "none": last), then the newest
  const pri = (p: number): number => (p > 0 ? p : 5)
  out.planned.sort((a, b) => Number(a.status === 'blocked') - Number(b.status === 'blocked') || pri(a.priority) - pri(b.priority) || newest(a, b))
  out.working.sort(newest)
  const order = [...c.needs.keys()]
  out.needs.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9) || newest(a, b))
  out.done.sort(newest)
  out.more = Math.max(0, out.planned.length - PHONE_TASKS_PLANNED)
  out.planned = out.planned.slice(0, PHONE_TASKS_PLANNED)
  out.done = out.done.slice(0, PHONE_TASKS_DONE)
  return out
}

/** One task of the board, with its Needs you entry (the actions the phone already has), or null when it is not shown. */
export function phoneTaskDetail(d: PhoneData, companyId: Id, task: CompanyTask, redact: (s: string) => string = (s) => s): PhoneTaskDetail | null {
  if (task.companyId !== companyId) return null
  const c = boardCtx(d, companyId)
  const col = columnOf(task, c)
  if (!col) return null
  const row = taskRow(d, task, col, c, redact)
  const need = c.needs.get(task.id) ?? (task.status === 'in_review' ? { taskId: task.id, kind: 'review' as const, title: task.title, text: task.report?.summary ? oneLine(task.report.summary, 600) : finishedLine(task.title), who: row.who, agentId: row.agentId, at: task.updatedAt, options: [] } : null)
  const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)
  return {
    ...row,
    description: redact(clip(task.description ?? '', 4000)),
    summary: task.report?.summary ? redact(clip(task.report.summary, 2000)) : null,
    doneNote: task.doneNote ? redact(clip(task.doneNote, 1000)) : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    need: need ? { ...need, title: redact(need.title), text: redact(need.text) } : null
  }
}

/** The status line of an agent's desk on the phone. */
export function agentStatus(d: PhoneData, a: CompanyAgent): string {
  const co = d.companies.find((c) => c.id === a.companyId)
  if (co?.pausedAt) return `${co.name} is paused`
  if (a.pausedAt) return 'Paused'
  const cur = d.tasks.find((t) => t.agentId === a.id && t.companyId === a.companyId && t.status === 'in_progress')
  if (cur) {
    const live = cur.runId ? d.agents.find((x) => isLive(x) && x.parentId === null && (x.runId === cur.runId || x.sessionId === cur.runId)) : undefined
    const act = live ? plainActivity(live.activity, { code: reposOf(d.repos, a.companyId).length > 0 }) : null
    return act ? `${cur.title} · ${act}` : `Working on ${cur.title}`
  }
  const review = d.tasks.find((t) => t.agentId === a.id && t.companyId === a.companyId && t.status === 'in_review')
  return review ? `Waiting for your OK: ${review.title}` : 'Not working on anything'
}

/** The agent's conversation (the desk thread) from its tasks' details. */
export function phoneAgent(d: PhoneData, a: CompanyAgent, details: TaskDetail[]): PhoneAgent {
  const who = whoResolver(d)(a)!
  const co = d.companies.find((c) => c.id === a.companyId)
  const items: PhoneThreadItem[] = deskThread(details, { companyCreatedAt: co?.createdAt ?? null, agentName: who.name }).map((i) =>
    i.kind === 'task' ? { kind: 'task', id: i.id, at: i.at, taskId: i.taskId, text: `${details.find((x) => x.task.id === i.taskId)?.task.title ?? 'A task'} (${ORIGIN[i.origin] ?? 'a task'})` } : i
  )
  const chat = d.sessions.filter((s) => s.companyAgentId === a.id).sort((x, y) => Number(y.status === 'running') - Number(x.status === 'running') || (x.startedAt < y.startedAt ? 1 : -1))[0]
  return { ref: { kind: 'agent', id: a.id }, who, status: agentStatus(d, a), items, chatSessionId: chat?.id ?? null }
}
const ORIGIN: Record<string, string> = { setup: 'from setup', you: 'from you', board: 'from the Board', linear: 'from Linear', github: 'from GitHub', schedule: 'from a schedule', agent: 'from another agent' }

/** The tasks an agent's desk loads (newest first). */
export const phoneAgentTasks = (d: PhoneData, a: CompanyAgent): CompanyTask[] => deskTasks(d.tasks, a.id, a.companyId)

/** The company an ask belongs to (the live truth's resolver), for scoping. */
export function askCompany(d: PhoneData, ask: Ask & Stamped): Id {
  if (ask.companyId) return ask.companyId
  const t = truthOf(d)
  const hit = t.needs.find((i) => i.askId === ask.id)
  return hit?.companyId ?? t.companyOf(ask.agentId)
}

export { taskOrigin }
