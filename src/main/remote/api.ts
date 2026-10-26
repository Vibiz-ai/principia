/**
 * REMOTE.md RA3: the Phone API. It composes a FIXED list of the desktop's own IPC handlers (PHONE_CHANNELS: the same
 * actions as Home, Chats and the Forum), so the phone answers, approves and sends exactly the way the Mac does. Every
 * route is scoped to one company: each id in it is resolved to its own company and must match, or the answer is 404.
 * The live socket pushes only to subscribers of that company. No Electron imports (tests pass a fake host).
 */
import { z } from 'zod'
import type { WebSocket } from 'ws'
import type { CompanyAgent, CompanyTask, TaskDetail } from '../../shared/company'
import { departmentsEnabled, PERSONAL_COMPANY_ID } from '../../shared/company'
import type { EventMap, EventName, InvokeReq, InvokeRes } from '../../shared/ipc'
import type { Id, Session } from '../../shared/types'
import type { ForumMessage } from '../../shared/forum'
import type { ChatSnapshot } from '../../shared/chat'
import type { PhoneAgent, PhoneClientMsg, PhoneLiveView, PhoneMe, PhoneRoom, PhoneRoomMessage, PhoneServerMsg, PhoneSession, RemoteRouteName } from '../../shared/remote'
import { REMOTE_LIMITS } from '../../shared/remote'
import { autonomyPhrase, deskReply, DESK_PREFIX, findDuplicate, taskOrigin, taskTitleFor, waitsOnOther } from '../../renderer/src/lib/desk'
import { firstLine } from '../../renderer/src/lib/format'
import { isIdleWaiting } from '../../renderer/src/lib/live'
import { plainActivity } from '../../renderer/src/lib/plainActivity'
import { reposOf } from '../../renderer/src/lib/companyModel'
import { HttpError, type RemoteApi } from './server'
import type { StoredDevice } from './auth'
import { agentStatus, askCompany, phoneAgent, phoneAgentTasks, phoneAnswerable, phoneChats, phoneCompanies, phoneNeeds, phoneNow, phoneOptions, providerName, whoResolver, type PhoneData } from './views'

/**
 * RA3: every desktop channel the Phone may reach. Nothing else is callable from here: no settings writes, keys,
 * terminals (pty), repos, workflows, deletes, spending. settings:get is read in main for the personas and Departments
 * flags and never returned to the phone.
 */
export const PHONE_CHANNELS = [
  'company:list', 'agents:list', 'asks:list', 'sessions:list', 'tasks:list', 'tasks:get', 'companyAgents:list',
  'departments:list', 'repos:list', 'runs:list', 'settings:get', 'chat:snapshot', 'forum:state', 'forum:messages', 'forum:thread', 'app:dashboard',
  'asks:answer', 'tasks:approve', 'tasks:sendBack', 'tasks:answer', 'company:pause', 'chat:send', 'chat:interrupt',
  'chat:answer', 'agents:reply', 'tasks:comment', 'tasks:create', 'tasks:start', 'forum:post', 'forum:markRead'
] as const
export type PhoneChannel = (typeof PHONE_CHANNELS)[number]

export interface PhoneHost {
  invoke<C extends PhoneChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>>
  /** every desktop event (ipc onEmit); returns unsubscribe */
  onEvent(fn: <E extends EventName>(event: E, payload: EventMap[E]) => void): () => void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const DAY = 86_400_000
const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`)
const text = (max: number = REMOTE_LIMITS.text) => z.string().trim().min(1, 'Write something first').max(max)
const BODIES = {
  pause: z.object({ paused: z.boolean() }).strict(),
  answerAsk: z.object({ optionId: z.string().min(1).max(64).optional(), text: z.string().max(REMOTE_LIMITS.answer).optional() }).strict(),
  sendBack: z.object({ text: text(REMOTE_LIMITS.answer) }).strict(),
  answerTask: z.object({ text: text(REMOTE_LIMITS.answer) }).strict(),
  text: z.object({ text: text() }).strict(),
  stop: z.object({ sendNow: z.boolean().optional() }).strict(),
  sessionAnswer: z
    .object({
      requestId: z.string().min(1).max(200),
      // RA3: no allowAlways (a rule that outlives this request)
      decision: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('allow') }).strict(),
        z.object({ kind: z.literal('deny'), message: z.string().max(REMOTE_LIMITS.answer).optional() }).strict(),
        z.object({ kind: z.literal('answer'), answers: z.record(z.string().max(2000), z.string().max(REMOTE_LIMITS.answer)).refine((r) => Object.keys(r).length <= 10) }).strict(),
        z.object({ kind: z.literal('skip') }).strict(),
        z.object({ kind: z.literal('approvePlan') }).strict(),
        z.object({ kind: z.literal('rejectPlan'), message: z.string().max(REMOTE_LIMITS.answer).optional() }).strict()
      ])
    })
    .strict(),
  roomPost: z.object({ channelId: z.string().min(1).max(64), text: text() }).strict()
}
function body<K extends keyof typeof BODIES>(k: K, raw: unknown): z.infer<(typeof BODIES)[K]> {
  const r = BODIES[k].safeParse(raw)
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? 'Bad request')
  return r.data as z.infer<(typeof BODIES)[K]>
}

interface Sub {
  device: string
  companyId: Id | null
  sessionId: Id | null
  channelId: Id | null
  pending: Set<PhoneLiveView>
  pendingCo: Id | null | undefined
  timer: NodeJS.Timeout | null
}

export class PhoneApi implements RemoteApi {
  /** idle session roots looked at from a phone (A3: they leave Needs you, as on the Mac when the pane is seen) */
  readonly seen = new Set<Id>()
  private subs = new Map<WebSocket, Sub>()
  private off: (() => void) | null = null
  private sending = false

  constructor(private readonly h: PhoneHost) {
    this.off = h.onEvent((e, p) => this.onEvent(e, p))
  }
  dispose(): void {
    this.off?.()
    this.off = null
    for (const s of this.subs.values()) if (s.timer) clearTimeout(s.timer)
    this.subs.clear()
  }

  // ---------- data ----------

  private async safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await f()
    } catch {
      return fallback
    }
  }
  /** Everything the views read, the same slices the desktop store holds. */
  async load(): Promise<PhoneData> {
    const h = this.h
    const settings = await h.invoke('settings:get', undefined)
    const on = departmentsEnabled(settings.experimental)
    const [companies, agents, asks, sessions, tasks, companyAgents, departments, repos] = await Promise.all([
      h.invoke('company:list', undefined),
      this.safe(() => h.invoke('agents:list', { status: ['starting', 'working', 'needs_you', 'idle'], since: new Date(Date.now() - DAY).toISOString(), limit: 1000 }), []),
      this.safe(() => h.invoke('asks:list', { status: 'open', limit: 500 }), []),
      this.safe(() => h.invoke('sessions:list', undefined), []),
      this.safe(() => h.invoke('tasks:list', undefined), []),
      on ? this.safe(() => h.invoke('companyAgents:list', undefined), []) : Promise.resolve([]),
      on ? this.safe(() => h.invoke('departments:list', undefined), []) : Promise.resolve([]),
      this.safe(() => h.invoke('repos:list', undefined), [])
    ])
    return { companies: companies.filter((c) => !c.archivedAt), agents, asks, sessions, tasks, companyAgents, departments, repos, personas: settings.personas !== false, departmentsOn: on, seen: this.seen }
  }

  private company(d: PhoneData, companyId: string | undefined): Id {
    const c = companyId ? d.companies.find((x) => x.id === companyId) : undefined
    if (!c) throw notFound('Company')
    return c.id
  }
  private session(d: PhoneData, companyId: Id, id: string | undefined): Session {
    const s = id ? d.sessions.find((x) => x.id === id) : undefined
    if (!s || (s.companyId || PERSONAL_COMPANY_ID) !== companyId) throw notFound('Chat')
    return s
  }
  private agent(d: PhoneData, companyId: Id, id: string | undefined): CompanyAgent {
    const a = id ? d.companyAgents.find((x) => x.id === id) : undefined
    if (!a || a.companyId !== companyId || a.archivedAt) throw notFound('Agent')
    return a
  }
  private task(d: PhoneData, companyId: Id, id: string | undefined): CompanyTask {
    const t = id ? d.tasks.find((x) => x.id === id) : undefined
    if (!t || t.companyId !== companyId) throw notFound('Task')
    return t
  }

  // ---------- routes ----------

  async handle(name: RemoteRouteName, params: Record<string, string>, raw: unknown, device: StoredDevice): Promise<unknown> {
    const d = await this.load()
    if (name === 'me') return this.me(d, device)
    const companyId = this.company(d, params.companyId)
    switch (name) {
      case 'now':
        return this.now(d, companyId)
      case 'pause': {
        const b = body('pause', raw)
        if (companyId === PERSONAL_COMPANY_ID) throw new HttpError(400, 'Personal has nothing to pause')
        await this.h.invoke('company:pause', { id: companyId, paused: b.paused })
        return this.now(await this.load(), companyId)
      }
      case 'needs':
        return phoneNeeds(d, companyId)
      case 'answerAsk':
        return this.answerAsk(d, companyId, params.askId, body('answerAsk', raw))
      case 'approveTask': {
        const t = this.task(d, companyId, params.taskId)
        if (t.status !== 'in_review') throw new HttpError(409, 'It is not waiting for your OK anymore')
        await this.h.invoke('tasks:approve', { id: t.id, doneNote: `Approved: ${firstLine(t.report?.summary ?? t.title, 200)}` })
        return phoneNeeds(await this.load(), companyId)
      }
      case 'sendBackTask': {
        const t = this.task(d, companyId, params.taskId)
        if (t.status !== 'in_review') throw new HttpError(409, 'It is not waiting for your OK anymore')
        await this.h.invoke('tasks:sendBack', { id: t.id, note: body('sendBack', raw).text })
        return phoneNeeds(await this.load(), companyId)
      }
      case 'answerTask': {
        const t = this.task(d, companyId, params.taskId)
        if (!t.ask) throw new HttpError(409, 'There is no question to answer on this task')
        if (t.ask.answer) throw new HttpError(409, 'That question was answered already')
        await this.h.invoke('tasks:answer', { id: t.id, answer: body('answerTask', raw).text })
        return phoneNeeds(await this.load(), companyId)
      }
      case 'chats':
        return phoneChats(d, companyId)
      case 'session':
        return this.sessionView(d, companyId, params.sessionId)
      case 'sessionSend': {
        const s = this.session(d, companyId, params.sessionId)
        const snap = await this.chatOf(s)
        if (!snap) throw new HttpError(409, 'This one runs in a terminal. Reply from its card, or on your Mac.')
        await this.h.invoke('chat:send', { id: s.id, text: body('text', raw).text })
        return { ok: true }
      }
      case 'sessionStop': {
        const s = this.session(d, companyId, params.sessionId)
        const b = body('stop', raw)
        if (!(await this.chatOf(s))) throw new HttpError(409, 'Stop it on your Mac')
        // sendNow: the Mac's Send now (the turn stops and the queued messages go right after)
        await this.h.invoke('chat:interrupt', { id: s.id, ...(b.sendNow ? { sendNow: true } : {}) })
        return { ok: true }
      }
      case 'sessionAnswer': {
        const s = this.session(d, companyId, params.sessionId)
        const b = body('sessionAnswer', raw)
        const snap = await this.chatOf(s)
        const card = snap?.items.find((i) => (i.kind === 'permission' || i.kind === 'question' || i.kind === 'plan') && i.requestId === b.requestId)
        if (!card) throw new HttpError(409, 'Already answered')
        await this.h.invoke('chat:answer', { id: s.id, requestId: b.requestId, decision: b.decision })
        return { ok: true }
      }
      case 'sessionReply': {
        const s = this.session(d, companyId, params.sessionId)
        const root = d.agents.find((a) => a.kind === 'session' && a.sessionId === s.id && a.parentId === null)
        if (!root || !isIdleWaiting(root)) throw new HttpError(409, 'It is not waiting for a reply right now')
        // RA3: typed into the CLI's own prompt, so plain words only (no shell, slash commands or memory notes)
        await this.h.invoke('agents:reply', { agentId: root.id, text: terminalReply(body('text', raw).text) })
        return { ok: true }
      }
      case 'agent':
        return this.agentView(d, this.agent(d, companyId, params.agentId))
      case 'agentSend': {
        const a = this.agent(d, companyId, params.agentId)
        const r = await this.sendToAgent(d, a, body('text', raw).text)
        return { ...r, agent: await this.agentView(await this.load(), a) }
      }
      case 'room':
        return this.room(companyId, params.channelId ?? null)
      case 'roomPost': {
        const b = body('roomPost', raw)
        const room = await this.room(companyId, b.channelId)
        if (!room.enabled || room.channelId !== b.channelId) throw notFound('Channel')
        const m = await this.h.invoke('forum:post', { companyId, channelId: b.channelId, text: b.text })
        return roomMessage(m)
      }
      default:
        throw new HttpError(404, 'Not found')
    }
  }

  /** Now, with the seat of each run that has no board task (a Forum reply run is its agent's, not "a run"). */
  private async now(d: PhoneData, companyId: Id): Promise<ReturnType<typeof phoneNow>> {
    const [dash, runs] = await Promise.all([
      this.safe(() => this.h.invoke('app:dashboard', { companyId }), null),
      this.safe(() => this.h.invoke('runs:list', { companyId, status: ['queued', 'running'], limit: 100 }), [])
    ])
    const done = dash?.done ?? []
    const seats = new Map<Id, Id>()
    for (const r of [...runs, ...done.map((c) => c.run)]) if (r.agentId && (r.companyId || PERSONAL_COMPANY_ID) === companyId) seats.set(r.id, r.agentId)
    return phoneNow(d, companyId, done, seats)
  }

  private me(d: PhoneData, device: StoredDevice): Omit<PhoneMe, 'csrf'> {
    return { device: { id: device.id, name: device.name }, host: 'mac', companies: phoneCompanies(d) }
  }

  private async answerAsk(d: PhoneData, companyId: Id, askId: string | undefined, b: z.infer<typeof BODIES.answerAsk>): Promise<unknown> {
    const ask = askId ? d.asks.find((a) => a.id === askId) : undefined
    if (!ask || askCompany(d, ask) !== companyId) throw notFound('Request')
    if (!phoneAnswerable(ask)) throw new HttpError(409, 'Answer this one on your Mac')
    const words = b.text?.trim() ?? ''
    if (b.optionId && !phoneOptions(ask).some((o) => o.id === b.optionId)) throw new HttpError(400, 'That option is not offered here')
    if (!b.optionId && !(ask.kind === 'question' && words)) throw new HttpError(400, 'Choose an answer')
    await this.h.invoke('asks:answer', { askId: ask.id, ...(b.optionId ? { optionId: b.optionId } : {}), ...(words ? (ask.kind === 'question' && !b.optionId ? { text: words } : { message: words }) : {}) })
    return phoneNeeds(await this.load(), companyId)
  }

  private async chatOf(s: Session): Promise<ChatSnapshot | null> {
    if (s.adapter !== 'claude') return null
    const snap = await this.safe(() => this.h.invoke('chat:snapshot', { id: s.id }), null)
    return snap && snap.available && snap.mode === 'chat' ? snap : null
  }

  private async sessionView(d: PhoneData, companyId: Id, id: string | undefined): Promise<PhoneSession> {
    const s = this.session(d, companyId, id)
    const chat = await this.chatOf(s)
    const root = d.agents.find((a) => a.kind === 'session' && a.sessionId === s.id && a.parentId === null)
    // looking at it from the phone is looking at it (A3): a finished turn leaves Needs you
    if (root && isIdleWaiting(root)) this.seen.add(root.id)
    const code = reposOf(d.repos, companyId).length > 0
    return {
      ref: { kind: 'session', id: s.id },
      title: s.title,
      who: { name: providerName(s.adapter), role: '', bust: null },
      chat,
      terminal: chat ? null : { activity: root ? plainActivity(root.activity, { code }) : null, canReply: !!root && isIdleWaiting(root), ended: s.status === 'exited' }
    }
  }

  private async details(d: PhoneData, a: CompanyAgent): Promise<TaskDetail[]> {
    return Promise.all(phoneAgentTasks(d, a).map((t) => this.safe(() => this.h.invoke('tasks:get', { id: t.id }), { task: t, activity: [] } as TaskDetail)))
  }
  private async agentView(d: PhoneData, a: CompanyAgent): Promise<PhoneAgent> {
    return phoneAgent(d, a, await this.details(d, a))
  }

  /**
   * The desk send path (renderer state/desk.ts sendToAgent), the same steps in main: words that repeat open work join
   * that task as your comment (which wakes it), else a new task for this agent that starts at once when the agent is
   * free and the company runs. The agent's reply sentence is stored on the task, so the thread reads the same on the Mac.
   */
  async sendToAgent(d: PhoneData, agent: CompanyAgent, text: string): Promise<{ taskId: Id; merged: boolean; started: boolean }> {
    const request = text.trim()
    if (!request) throw new HttpError(400, 'Write something first')
    if (this.sending) throw new HttpError(409, 'Still sending the last one')
    this.sending = true
    try {
      const company = d.companies.find((c) => c.id === agent.companyId)
      const pausedCompany = company?.pausedAt ? company.name : null
      const dep = d.departments.find((x) => x.id === agent.departmentId)
      const autonomy = autonomyPhrase({ auto: agent.data.autonomy === 'auto', role: agent.name, department: dep?.name })
      const mine = d.tasks.filter((t) => t.agentId === agent.id && t.companyId === agent.companyId)
      const busy = mine.find((t) => t.status === 'in_progress') ?? null
      const startsNext = agent.data.autonomy === 'auto' && !!company?.autopilot
      const dup = findDuplicate(request, mine)
      if (dup) {
        await this.h.invoke('tasks:comment', { id: dup.id, message: request })
        const reply = deskReply({ request, autonomy, merged: { title: dup.title, origin: taskOrigin(dup, company?.createdAt), status: dup.status, waitingOnOther: waitsOnOther(dup, d.tasks) }, startsNext, pausedCompany, agentPaused: !!agent.pausedAt })
        await this.h.invoke('tasks:comment', { id: dup.id, message: reply, by: 'agent' })
        return { taskId: dup.id, merged: true, started: false }
      }
      const task = await this.h.invoke('tasks:create', {
        task: {
          title: taskTitleFor(request),
          description: request,
          companyId: agent.companyId,
          repoId: agent.data.defaultRepoId ?? null,
          status: 'todo',
          priority: 0,
          source: 'manual',
          sourceUrl: null,
          externalId: `${DESK_PREFIX}${agent.id}:${Date.now()}`,
          assigneeProfileId: null,
          parentId: null,
          dependencyIds: [],
          departmentId: agent.departmentId,
          agentId: agent.id
        }
      })
      const canStart = !pausedCompany && !agent.pausedAt && !busy
      const reply = deskReply({ request, autonomy, busyWith: canStart ? null : (busy?.title ?? null), startsNext, pausedCompany, agentPaused: !!agent.pausedAt })
      await this.h.invoke('tasks:comment', { id: task.id, message: reply, by: 'agent' })
      let started = false
      if (canStart) {
        try {
          await this.h.invoke('tasks:start', { id: task.id })
          started = true
        } catch {
          /* it stays in the agent's queue with its Start button on the Mac */
        }
      }
      return { taskId: task.id, merged: false, started }
    } finally {
      this.sending = false
    }
  }

  async room(companyId: Id, channelId: Id | null): Promise<PhoneRoom> {
    let st
    try {
      st = await this.h.invoke('forum:state', { companyId })
    } catch (e) {
      return { companyId, enabled: false, message: e instanceof Error ? e.message : 'The team room is off', me: null, channelId: null, channels: [], members: [], messages: [] }
    }
    const open = st.channels.filter((c) => !c.archivedAt && c.companyId === companyId && (c.kind === 'public' || c.kind === 'private') && c.joined)
    open.sort((a, b) => Number(b.system === 'general') - Number(a.system === 'general') || (a.name ?? '').localeCompare(b.name ?? ''))
    const cur = (channelId ? open.find((c) => c.id === channelId) : undefined) ?? open[0]
    if (channelId && !open.some((c) => c.id === channelId)) throw notFound('Channel')
    const page = cur ? await this.h.invoke('forum:messages', { companyId, channelId: cur.id, limit: 60 }) : { messages: [] as ForumMessage[], hasMore: false }
    if (cur?.lastSeq) await this.safe(() => this.h.invoke('forum:markRead', { channelId: cur.id }), undefined)
    const [seats, runs] = await Promise.all([
      this.safe(() => this.h.invoke('companyAgents:list', { companyId }), [] as CompanyAgent[]),
      cur ? this.safe(() => this.h.invoke('runs:list', { companyId, status: ['queued', 'running'], limit: 100 }), []) : Promise.resolve([])
    ])
    const members = st.members.filter((m) => m.status === 'active' && m.companyId === companyId)
    // a Forum reply run (responder.ts titles it "Forum reply in #channel" / "Agent ask in #channel") is that seat replying
    const label = cur ? `#${cur.name ?? 'channel'}` : ''
    const replyTitle = (t: string): boolean => !!label && (t.startsWith(`Forum reply in ${label}`) || t.startsWith(`Agent ask in ${label}`)) && /^(\s|…|$)/.test(t.slice(t.indexOf(label) + label.length))
    const answering = runs
      .filter((r) => r.agentId && (r.companyId || PERSONAL_COMPANY_ID) === companyId && replyTitle(r.title))
      .map((r) => members.find((m) => m.kind === 'agent' && m.agentId === r.agentId)?.name)
      .filter((n): n is string => !!n)
    return {
      companyId,
      enabled: true,
      message: null,
      me: st.me,
      channelId: cur?.id ?? null,
      channels: open.map((c) => ({ id: c.id, label: `#${c.name ?? 'channel'}` })),
      answering: [...new Set(answering)],
      members: members
        .map((m) => ({ id: m.id, handle: m.handle, name: m.name, kind: m.kind, role: m.agentId ? (seats.find((a) => a.id === m.agentId)?.name ?? null) : null })),
      messages: await this.withReplies(page.messages.filter((m) => !m.deletedAt && !m.threadId))
    }
  }

  /** Agents answer in a thread under your message (the Forum responder): replies follow their root, in order. */
  private async withReplies(roots: ForumMessage[]): Promise<PhoneRoomMessage[]> {
    const out: PhoneRoomMessage[] = []
    const recent = new Set(roots.slice(-20).map((m) => m.id))
    for (const m of roots) {
      out.push(roomMessage(m))
      if (!m.replyCount || !recent.has(m.id)) continue
      const t = await this.safe(() => this.h.invoke('forum:thread', { messageId: m.id }), null)
      for (const r of t?.replies ?? []) if (!r.deletedAt && r.companyId === m.companyId) out.push(roomMessage(r))
    }
    return out
  }

  // ---------- live ----------

  socket(ws: WebSocket, device: StoredDevice): void {
    const sub: Sub = { device: device.id, companyId: null, sessionId: null, channelId: null, pending: new Set(), pendingCo: undefined, timer: null }
    this.subs.set(ws, sub)
    const send = (m: PhoneServerMsg): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }
    send({ t: 'hello' })
    ws.on('message', (raw) => {
      let m: PhoneClientMsg
      try {
        m = JSON.parse(String(raw)) as PhoneClientMsg
      } catch {
        return
      }
      if (m?.t === 'ping') return send({ t: 'pong' })
      if (m?.t === 'sub') void this.subscribe(sub, m)
    })
    ws.on('close', () => {
      if (sub.timer) clearTimeout(sub.timer)
      this.subs.delete(ws)
    })
  }

  /** A subscription names a company and, inside it, at most one chat and one room channel; each is checked. */
  async subscribe(sub: Sub, m: Extract<PhoneClientMsg, { t: 'sub' }>): Promise<void> {
    try {
      const d = await this.load()
      const companyId = this.company(d, typeof m.companyId === 'string' ? m.companyId : undefined)
      let sessionId: Id | null = null
      if (typeof m.sessionId === 'string') sessionId = this.session(d, companyId, m.sessionId).id
      let channelId: Id | null = null
      if (typeof m.channelId === 'string') {
        const room = await this.room(companyId, m.channelId)
        channelId = room.channelId
      }
      sub.companyId = companyId
      sub.sessionId = sessionId
      sub.channelId = channelId
    } catch {
      sub.companyId = null
      sub.sessionId = null
      sub.channelId = null
    }
  }

  /** for tests */
  subscriptions(): Sub[] {
    return [...this.subs.values()]
  }

  private push(pred: (s: Sub) => boolean, m: PhoneServerMsg): void {
    const text = JSON.stringify(m)
    for (const [ws, s] of this.subs) if (s.companyId && pred(s) && ws.readyState === ws.OPEN) ws.send(text)
  }
  private changed(companyId: Id | null, what: PhoneLiveView[]): void {
    for (const [ws, s] of this.subs) {
      if (!s.companyId || (companyId && companyId !== s.companyId)) continue
      for (const w of what) s.pending.add(w)
      // a change for one company refetches that company; one without a company (tasks, companies) is anyone's
      s.pendingCo = s.pendingCo === undefined ? companyId : s.pendingCo === companyId ? companyId : null
      if (s.timer) continue
      s.timer = setTimeout(() => {
        s.timer = null
        const msg: PhoneServerMsg = { t: 'changed', companyId: s.pendingCo ?? null, what: [...s.pending] }
        s.pending.clear()
        s.pendingCo = undefined
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
      }, 500)
      s.timer.unref?.()
    }
  }

  onEvent<E extends EventName>(event: E, payload: EventMap[E]): void {
    switch (event) {
      case 'chat:ops': {
        const p = payload as EventMap['chat:ops']
        this.push((s) => s.sessionId === p.sessionId, { t: 'chat', sessionId: p.sessionId, seq: p.seq, ops: p.ops })
        return
      }
      case 'forum:event': {
        const e = payload as EventMap['forum:event']
        if (e.kind !== 'message') return
        const msg = e.message
        if (msg.deletedAt) return
        this.push((s) => s.companyId === e.companyId && s.channelId === msg.channelId, { t: 'room', message: roomMessage(msg) })
        return
      }
      case 'agent:updated':
      case 'ask:updated': {
        const co = (payload as { companyId?: Id | null }).companyId ?? null
        return this.changed(co, ['now', 'needs', 'chats', 'companies'])
      }
      case 'session:updated':
        return this.changed((payload as Session).companyId || PERSONAL_COMPANY_ID, ['now', 'needs', 'chats', 'companies'])
      case 'run:updated':
        return this.changed((payload as { companyId?: Id | null }).companyId || null, ['now', 'needs', 'chats', 'companies', 'room'])
      case 'pty:exit':
        return this.changed(null, ['now', 'needs', 'chats', 'companies'])
      case 'data:changed': {
        const dom = (payload as EventMap['data:changed']).domain
        if (dom === 'tasks' || dom === 'company' || dom === 'departments') this.changed(null, ['now', 'needs', 'chats', 'companies'])
        return
      }
      default:
        return
    }
  }

  /** Turn off / revoke: tell the phones, then the server closes the sockets. */
  bye(reason: 'off' | 'revoked', device?: string): void {
    const text = JSON.stringify({ t: 'bye', reason } satisfies PhoneServerMsg)
    for (const [ws, s] of this.subs) if ((!device || s.device === device) && ws.readyState === ws.OPEN) ws.send(text)
  }
}

/**
 * RA3: a reply typed into a terminal agent's prompt. The CLI reads `!cmd` as a shell command (no permission prompt),
 * `/…` as a slash command (`/permissions` adds always-allow rules) and `#…` as a memory note, so those are refused.
 * Control characters (ESC sequences, ^C, ^U…) and line breaks (each one would submit early) become spaces.
 */
export function terminalReply(raw: string): string {
  const text = raw
    // whole escape sequences first (ESC [ … final, ESC ] … BEL/ST, ESC + one), then any control character left
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[\s\S]?|\u009b[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  if (!text) throw new HttpError(400, 'Write something first')
  if (/^[!/#]/.test(text)) throw new HttpError(400, 'Plain words only from the phone: commands starting with !, / or # stay on your Mac.')
  return text
}

export function roomMessage(m: ForumMessage): PhoneRoomMessage {
  return { id: m.id, seq: m.seq, channelId: m.channelId, threadId: m.threadId, authorId: m.authorId, kind: m.kind, text: m.text, at: m.createdAt }
}

export { agentStatus, whoResolver }
