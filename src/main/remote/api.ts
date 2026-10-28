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
import { TASK_CARD_LABEL } from '../../shared/taskCard'
import type { ChatImage, ChatItem, ChatSnapshot } from '../../shared/chat'
import { CHAT_IMAGE_TYPES } from '../../shared/chat'
import type { AgentNode } from '../../shared/live'
import type { PhoneAgent, PhoneClientMsg, PhoneImage, PhoneLiveView, PhoneMe, PhoneRoom, PhoneRoomMessage, PhoneServerMsg, PhoneSession, PhoneTerminal, RemoteRouteName } from '../../shared/remote'
import { REMOTE_LIMITS } from '../../shared/remote'
import { firstLine } from '../../renderer/src/lib/format'
import { taskTitleFor } from '../../renderer/src/lib/desk'
import { isIdleWaiting } from '../../renderer/src/lib/live'
import { plainActivity } from '../../renderer/src/lib/plainActivity'
import { reposOf } from '../../renderer/src/lib/companyModel'
import { HttpError, type RemoteApi } from './server'
import type { StoredDevice } from './auth'
import { TerminalFeeds, terminalSnapshot, terminalTurn, transcriptItems, type PhoneTerminalHost } from './terminalFeed'
import { agentStatus, askCompany, deskHistory, phoneAgent, phoneAgentTasks, phoneAnswerable, phoneChats, phoneCompanies, phoneNeeds, phoneNow, phoneOptions, phoneTaskDetail, phoneTasks, providerName, whoResolver, type PhoneData } from './views'

/**
 * RA3: every desktop channel the Phone may reach. Nothing else is callable from here: no settings writes, keys,
 * terminals (pty), repos, workflows, deletes, spending. settings:get is read in main for the personas and Departments
 * flags and never returned to the phone. A message typed into a running terminal goes through PhoneHost.terminal
 * (guarded: never into a dialog), not a pty channel.
 */
export const PHONE_CHANNELS = [
  'company:list', 'agents:list', 'asks:list', 'sessions:list', 'tasks:list', 'tasks:get', 'companyAgents:list',
  'departments:list', 'repos:list', 'runs:list', 'settings:get', 'chat:snapshot', 'forum:state', 'forum:messages', 'forum:thread', 'app:dashboard',
  'asks:answer', 'tasks:approve', 'tasks:sendBack', 'tasks:answer',
  // Not needed only: the handler sends { status: 'canceled' } and nothing else
  'tasks:update', 'company:pause', 'chat:send', 'chat:interrupt',
  'chat:answer', 'agents:reply', 'tasks:comment', 'chat:sendAgent', 'forum:post', 'forum:markRead',
  // read only: Principia's open suggestions count in Needs you (deciding one stays on the Mac)
  'orchestrator:suggestions',
  // read only: the autopilots on per company (the Now header names them; changing one stays on the Mac)
  'playbooks:summary',
  // Continue: an ended terminal session opens again on the Mac in the same conversation (the Mac's Restart)
  'sessions:restart'
] as const
export type PhoneChannel = (typeof PHONE_CHANNELS)[number]

export interface PhoneHost {
  invoke<C extends PhoneChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>>
  /** every desktop event (ipc onEmit); returns unsubscribe */
  onEvent(fn: <E extends EventName>(event: E, payload: EventMap[E]) => void): () => void
  /** a terminal session as a chat: its transcript or screen, and messages typed into it (absent: the old card) */
  terminal?: PhoneTerminalHost
  /**
   * New chat with Claude directly: the desktop's sessions:create with a fixed request (this company, no folder, Claude,
   * the first message), so the phone never picks a folder, profile or pty of its own. Absent: Claude needs the Mac.
   */
  newChat?(req: { companyId: Id; text: string; title: string }): Promise<Session>
  /** masks the vault's secrets in text the phone reads (task titles, descriptions, reports); absent: the terminal's */
  redact?(text: string): string
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

const DAY = 86_400_000
const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`)
const text = (max: number = REMOTE_LIMITS.text) => z.string().trim().min(1, 'Write something first').max(max)
const image = z
  .object({
    mime: z.string().max(100),
    data: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'An image did not come through. Try again.'),
    thumb: z.string().max(60_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'An image did not come through. Try again.').optional()
  })
  .strict()
const BODIES = {
  pause: z.object({ paused: z.boolean() }).strict(),
  answerAsk: z.object({ optionId: z.string().min(1).max(64).optional(), text: z.string().max(REMOTE_LIMITS.answer).optional() }).strict(),
  sendBack: z.object({ text: text(REMOTE_LIMITS.answer) }).strict(),
  answerTask: z.object({ text: text(REMOTE_LIMITS.answer) }).strict(),
  text: z.object({ text: text() }).strict(),
  newChat: z.object({ text: text(), agentId: z.string().min(1).max(64).optional() }).strict(),
  /** a chat message: words, images, or both (phoneImages checks the images as the Mac's composer does) */
  send: z.object({ text: z.string().trim().max(REMOTE_LIMITS.text).default(''), images: z.array(image).max(100).default([]) }).strict(),
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

/** A chat message from the phone: its words and its images, checked like the Mac's composer (count, type, size). */
export function phoneMessage(raw: unknown): { words: string; images: ChatImage[] } {
  const b = body('send', raw)
  const images = phoneImages(b.images)
  if (!b.text && !images.length) throw new HttpError(400, 'Write something first')
  return { words: b.text, images }
}
export function phoneImages(list: PhoneImage[]): ChatImage[] {
  const max = REMOTE_LIMITS.images
  if (list.length > max) throw new HttpError(400, `Up to ${max} images per message`)
  return list.map((im) => {
    const mediaType = CHAT_IMAGE_TYPES.find((t) => t === im.mime)
    if (!mediaType) throw new HttpError(400, 'Use a PNG, JPEG, GIF or WebP image')
    const bytes = Math.floor((im.data.length * 3) / 4) - (im.data.endsWith('==') ? 2 : im.data.endsWith('=') ? 1 : 0)
    if (bytes > REMOTE_LIMITS.imageBytes) throw new HttpError(413, `An image is too large: each must be under ${REMOTE_LIMITS.imageBytes / 1024 / 1024} MB`)
    return { mediaType, data: im.data, ...(im.thumb ? { thumb: im.thumb } : {}) }
  })
}

interface Sub {
  device: string
  companyId: Id | null
  sessionId: Id | null
  channelId: Id | null
  pending: Set<PhoneLiveView>
  pendingCo: Id | null | undefined
  timer: NodeJS.Timeout | null
  /** this socket (the subscription's ack) */
  send?: (m: PhoneServerMsg) => void
  /** the newest sub message: an older one that finishes its checks later never overwrites it */
  gen?: number
}

export class PhoneApi implements RemoteApi {
  /** idle session roots looked at from a phone (A3: they leave Needs you, as on the Mac when the pane is seen) */
  readonly seen = new Set<Id>()
  private subs = new Map<WebSocket, Sub>()
  private off: (() => void) | null = null
  private sending = false
  /** live terminal sessions shown as chats (only while a phone looks at one) */
  readonly feeds: TerminalFeeds | null
  /** each chat's last op number seen here (the subscription's ack says it, so a phone can tell it missed some) */
  private chatSeq = new Map<Id, number>()
  /** AGENT CHAT: the desk thread shown above each agent chat a phone read (withDesk) */
  private desk = new Map<Id, ChatItem[]>()
  /** when each session's current turn began (Now's "working for"), from its chat state ops or its root going to work */
  private turnSince = new Map<Id, string>()

  constructor(private readonly h: PhoneHost, o: { feedTickMs?: number | null } = {}) {
    this.off = h.onEvent((e, p) => this.onEvent(e, p))
    this.feeds = h.terminal
      ? new TerminalFeeds({
          host: h.terminal,
          push: (sid, m) => this.push((s) => s.sessionId === sid, m),
          wanted: () => new Set([...this.subs.values()].map((s) => s.sessionId).filter((x): x is Id => !!x)),
          ...(o.feedTickMs !== undefined ? { tickMs: o.feedTickMs } : {}),
          log: h.log
        })
      : null
  }
  dispose(): void {
    this.off?.()
    this.off = null
    this.feeds?.dispose()
    for (const s of this.subs.values()) if (s.timer) clearTimeout(s.timer)
    this.subs.clear()
  }

  // ---------- data ----------

  /** RA3: the vault's secrets never reach the phone in board text */
  private readonly redact = (s: string): string => (this.h.redact ? this.h.redact(s) : this.h.terminal ? this.h.terminal.redact(s) : s)

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
    const [companies, agents, asks, sessions, tasks, companyAgents, departments, repos, suggestions, playbooks] = await Promise.all([
      h.invoke('company:list', undefined),
      this.safe(() => h.invoke('agents:list', { status: ['starting', 'working', 'needs_you', 'idle'], since: new Date(Date.now() - DAY).toISOString(), limit: 1000 }), []),
      this.safe(() => h.invoke('asks:list', { status: 'open', limit: 500 }), []),
      this.safe(() => h.invoke('sessions:list', undefined), []),
      this.safe(() => h.invoke('tasks:list', undefined), []),
      on ? this.safe(() => h.invoke('companyAgents:list', undefined), []) : Promise.resolve([]),
      on ? this.safe(() => h.invoke('departments:list', undefined), []) : Promise.resolve([]),
      this.safe(() => h.invoke('repos:list', undefined), []),
      on ? this.safe(() => h.invoke('orchestrator:suggestions', {}), []) : Promise.resolve([]),
      on ? this.safe(() => h.invoke('playbooks:summary', undefined), {}) : Promise.resolve({})
    ])
    return { companies: companies.filter((c) => !c.archivedAt), agents, asks, sessions, tasks, companyAgents, departments, repos, personas: settings.personas !== false, departmentsOn: on, seen: this.seen, suggestions: Array.isArray(suggestions) ? suggestions : [], playbooks: playbooks ?? {} }
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
      case 'tasks':
        return phoneTasks(d, companyId, this.redact)
      case 'task': {
        const v = phoneTaskDetail(d, companyId, this.task(d, companyId, params.taskId), this.redact)
        if (!v) throw notFound('Task')
        return v
      }
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
      case 'cancelTask': {
        // Not needed (the Mac's Needs you): only a task that waits on you, and only to canceled; it can be reopened
        const t = this.task(d, companyId, params.taskId)
        if (!phoneNeeds(d, companyId).tasks.some((x) => x.taskId === t.id && x.kind !== 'idea')) throw new HttpError(409, 'It is not waiting for you anymore')
        await this.h.invoke('tasks:update', { id: t.id, patch: { status: 'canceled' } })
        return phoneNeeds(await this.load(), companyId)
      }
      case 'chats':
        return phoneChats(d, companyId)
      case 'newChat': {
        const b = body('newChat', raw)
        if (b.agentId) return { sessionId: (await this.sendToAgent(d, this.agent(d, companyId, b.agentId), b.text)).sessionId }
        return { sessionId: await this.startChat(companyId, b.text) }
      }
      case 'session':
        return this.sessionView(d, companyId, params.sessionId)
      case 'sessionSend': {
        const s = this.session(d, companyId, params.sessionId)
        const { words, images } = phoneMessage(raw)
        // AGENT CHAT: a message to an agent's chat goes through the agent (chat:sendAgent), which reopens its chat when
        // it ended (an app restart) and resumes the same conversation; the phone follows the session it lands in
        const agent = s.companyAgentId ? d.companyAgents.find((a) => a.id === s.companyAgentId && a.companyId === companyId && !a.archivedAt) : undefined
        if (agent) {
          const r = await this.sendToAgent(d, agent, words, images)
          return { ok: true, sessionId: r.sessionId }
        }
        const snap = await this.chatOf(s)
        if (!snap?.available) {
          // a terminal takes typed words only
          if (images.length) throw new HttpError(409, 'Images go into a chat. This one is a terminal: send words, or open it on your Mac.')
          await this.typeInto(d, s, words)
          return { ok: true }
        }
        await this.h.invoke('chat:send', { id: s.id, text: words, ...(images.length ? { images } : {}) })
        return { ok: true }
      }
      case 'sessionContinue': {
        const s = this.session(d, companyId, params.sessionId)
        if (!this.canContinue(s)) throw new HttpError(409, s.status === 'running' ? 'It is still running' : 'This one cannot be continued from the phone. Open it on your Mac.')
        // tapped twice, or continued on the Mac already: the one running in this conversation
        const running = d.sessions.find((x) => x.status === 'running' && x.agentSessionId === s.agentSessionId && x.adapter === s.adapter)
        if (running) return { ok: true, sessionId: running.id }
        const next = await this.h.invoke('sessions:restart', { id: s.id })
        return { ok: true, sessionId: next.id }
      }
      case 'sessionStop': {
        const s = this.session(d, companyId, params.sessionId)
        const b = body('stop', raw)
        if (!(await this.chatOf(s))?.available) throw new HttpError(409, 'Stop it on your Mac')
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
        const { words, images } = phoneMessage(raw)
        const r = await this.sendToAgent(d, a, words, images)
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
    return phoneNow(d, companyId, done, seats, this.turnSince)
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

  /**
   * The chat view of a session (Claude or Codex, stream-json). An ended chat reads too when it is an agent's chat
   * (sending to it reopens it); any other ended or terminal session has none.
   */
  private async chatOf(s: Session): Promise<ChatSnapshot | null> {
    if (s.adapter !== 'claude' && s.adapter !== 'codex') return null
    const snap = await this.safe(() => this.h.invoke('chat:snapshot', { id: s.id }), null)
    if (!snap || snap.mode !== 'chat') return null
    return snap.available || s.companyAgentId ? snap : null
  }

  private async sessionView(d: PhoneData, companyId: Id, id: string | undefined): Promise<PhoneSession> {
    const s = this.session(d, companyId, id)
    const chat = await this.chatOf(s)
    const root = d.agents.find((a) => a.kind === 'session' && a.sessionId === s.id && a.parentId === null)
    // looking at it from the phone is looking at it (A3): a finished turn leaves Needs you
    if (root && isIdleWaiting(root)) this.seen.add(root.id)
    const code = reposOf(d.repos, companyId).length > 0
    // an agent's chat speaks in the agent's name and face, not the AI tool's
    const agent = s.companyAgentId ? d.companyAgents.find((a) => a.id === s.companyAgentId && a.companyId === companyId) : undefined
    const view = { ref: { kind: 'session' as const, id: s.id }, title: s.title, who: (agent ? whoResolver(d)(agent) : null) ?? { name: providerName(s.adapter), role: '', bust: null } }
    if (chat) return { ...view, chat: await this.withDesk(d, s, agent, chat), terminal: null }
    const activity = root ? plainActivity(root.activity, { code }) : null
    const ended = s.status === 'exited'
    const terminal: PhoneTerminal = { activity, canReply: !ended && s.adapter !== 'shell' && !!root && isIdleWaiting(root), ended }
    if (!this.h.terminal || !this.feeds) return { ...view, chat: null, terminal }
    if (ended) {
      // its history, read once; Continue opens it again on the Mac
      const host = this.h.terminal
      const items = this.safeItems(() => {
        const ref = host.transcript(s)
        return ref ? transcriptItems(ref, (x) => host.redact(x)) : []
      })
      return { ...view, chat: items.length ? terminalSnapshot(s.id, { items, seq: 0, turn: 'ended', activity: null }) : null, terminal: { ...terminal, source: items.length ? 'transcript' : null, canType: false, canContinue: this.canContinue(s) } }
    }
    const asks = phoneNeeds(d, companyId).asks.filter((a) => a.open?.kind === 'session' && a.open.id === s.id)
    const feed = this.feeds.open(s, terminalTurn(root, false), activity)
    // a shell is no agent: no composer (canType false, nothing held)
    if (s.adapter === 'shell') return { ...view, chat: feed.chat, terminal: { ...terminal, canType: false, held: null, source: feed.source, screen: feed.screen, asks, canContinue: false } }
    let held: string | null = asks.length ? 'It is asking you something. Answer it here first, then send your message.' : null
    if (!held && !pastes(s)) held = terminal.canReply ? null : 'It takes a message when it waits at its prompt.'
    try {
      held ??= this.h.terminal.held?.(s.id) ?? null
    } catch {
      /* the composer stays; sending re-checks */
    }
    return { ...view, chat: feed.chat, terminal: { ...terminal, canType: pastes(s) && !held, held, source: feed.source, screen: feed.screen, asks, canContinue: false } }
  }

  /**
   * AGENT CHAT: an agent's chat reads under the desk thread its screen showed before the chat began (deskHistory), so
   * the first message from that screen keeps the conversation. Kept per chat: a reset op (the chat rebuilt from its
   * transcript) gets it in front again.
   */
  private async withDesk(d: PhoneData, s: Session, agent: CompanyAgent | undefined, chat: ChatSnapshot): Promise<ChatSnapshot> {
    if (!agent) return chat
    const start = d.sessions.filter((x) => x.companyAgentId === agent.id).reduce((m, x) => (x.startedAt < m ? x.startedAt : m), s.startedAt)
    const before = deskHistory(phoneAgent(d, agent, await this.details(d, agent)).items, start)
    if (!before.length) {
      this.desk.delete(s.id)
      return chat
    }
    this.desk.set(s.id, before)
    return { ...chat, items: [...before, ...chat.items] }
  }

  private safeItems<T>(f: () => T[]): T[] {
    try {
      return f()
    } catch (e) {
      this.h.log?.warn('phone: transcript read failed', { error: String(e) })
      return []
    }
  }

  /** Continue (the Mac's Restart): a Claude terminal session that ended, resumed in the same conversation. */
  private canContinue(s: Session): boolean {
    return s.status === 'exited' && !s.companyAgentId && s.adapter === 'claude' && !!s.agentSessionId
  }

  /**
   * A message into a terminal session. It waits at its prompt: the guarded reply (agents:reply, re-checked there).
   * It works: typed in as a paste, which the CLI queues (PhoneHost.terminal refuses while it asks something).
   */
  private async typeInto(d: PhoneData, s: Session, words: string): Promise<void> {
    if (s.status !== 'running') throw new HttpError(409, this.canContinue(s) ? 'This one ended. Continue it first.' : 'This one ended')
    if (s.adapter === 'shell') throw new HttpError(409, 'This is a shell. Type in it on your Mac.')
    const root = d.agents.find((a) => a.kind === 'session' && a.sessionId === s.id && a.parentId === null)
    if (root && isIdleWaiting(root)) {
      await this.h.invoke('agents:reply', { agentId: root.id, text: terminalReply(words) })
      return
    }
    if (!pastes(s)) throw new HttpError(409, 'It takes a message when it waits at its prompt.')
    if (!this.h.terminal) throw new HttpError(409, 'It is not waiting for a reply right now')
    try {
      this.h.terminal.type(s.id, terminalMessage(words))
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(409, e instanceof Error ? e.message : 'It cannot take a message right now')
    }
  }

  private async details(d: PhoneData, a: CompanyAgent): Promise<TaskDetail[]> {
    return Promise.all(phoneAgentTasks(d, a).map((t) => this.safe(() => this.h.invoke('tasks:get', { id: t.id }), { task: t, activity: [] } as TaskDetail)))
  }
  private async agentView(d: PhoneData, a: CompanyAgent): Promise<PhoneAgent> {
    return phoneAgent(d, a, await this.details(d, a))
  }

  /**
   * AGENT CHAT: a message to an agent goes straight into the agent's own chat (chat:sendAgent), as on the Mac. The
   * agent answers there and files board tasks itself when the work needs one. Returns the chat's session, which the
   * phone opens like any chat.
   */
  async sendToAgent(_d: PhoneData, agent: CompanyAgent, text: string, images: ChatImage[] = []): Promise<{ sessionId: Id; merged: false; started: true }> {
    void _d
    const request = text.trim()
    if (!request && !images.length) throw new HttpError(400, 'Write something first')
    if (this.sending) throw new HttpError(409, 'Still sending the last one')
    this.sending = true
    try {
      const s = await this.h.invoke('chat:sendAgent', { agentId: agent.id, text: request, ...(images.length ? { images } : {}) })
      return { sessionId: s.id, merged: false, started: true }
    } finally {
      this.sending = false
    }
  }

  /** New chat with Claude directly, as the Mac's New conversation does it (To: Claude directly). */
  private async startChat(companyId: Id, text: string): Promise<Id> {
    if (!this.h.newChat) throw new HttpError(409, 'Start this one on your Mac')
    if (this.sending) throw new HttpError(409, 'Still sending the last one')
    this.sending = true
    try {
      return (await this.h.newChat({ companyId, text, title: taskTitleFor(text).slice(0, 80) })).id
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
      messages: await this.withReplies(page.messages.filter((m) => !m.deletedAt && !m.threadId), await this.cardActivity(companyId, page.messages))
    }
  }

  /** CHAT-UI.md §8: what each working card's run is doing now (its root agent's activity, in plain words), by task. */
  private async cardActivity(companyId: Id, msgs: readonly ForumMessage[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const working = msgs.filter((m) => !m.deletedAt && m.task?.state === 'working' && m.task.runId)
    if (!working.length) return out
    const repos = await this.safe(() => this.h.invoke('repos:list', undefined), [])
    const code = reposOf(repos, companyId).length > 0
    await Promise.all(
      working.map(async (m) => {
        const roots = await this.safe(() => this.h.invoke('agents:list', { runId: m.task!.runId!, rootsOnly: true, limit: 10 }), [] as AgentNode[])
        const root = cardActivityRoot(roots)
        const line = root ? plainActivity(root.activity, { code }) : null
        if (line) out.set(m.task!.taskId, this.redact(line))
      })
    )
    return out
  }

  /** Agents answer in a thread under your message (the Forum responder): replies follow their root, in order. */
  private async withReplies(roots: ForumMessage[], activity: ReadonlyMap<string, string> = new Map()): Promise<PhoneRoomMessage[]> {
    const out: PhoneRoomMessage[] = []
    const recent = new Set(roots.slice(-20).map((m) => m.id))
    for (const m of roots) {
      out.push(roomMessage(m, m.task ? activity.get(m.task.taskId) : undefined))
      if (!m.replyCount || !recent.has(m.id)) continue
      const t = await this.safe(() => this.h.invoke('forum:thread', { messageId: m.id }), null)
      for (const r of t?.replies ?? []) if (!r.deletedAt && r.companyId === m.companyId) out.push(roomMessage(r))
    }
    return out
  }

  // ---------- live ----------

  socket(ws: WebSocket, device: StoredDevice): void {
    const send = (m: PhoneServerMsg): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }
    const sub: Sub = { device: device.id, companyId: null, sessionId: null, channelId: null, pending: new Set(), pendingCo: undefined, timer: null, send, gen: 0 }
    this.subs.set(ws, sub)
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
    const gen = (sub.gen = (sub.gen ?? 0) + 1)
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
      // a newer sub came while this one was checked: that one wins
      if (gen !== sub.gen) return
      sub.companyId = companyId
      sub.sessionId = sessionId
      sub.channelId = channelId
      // in the same tick as the switch: every op after this number reaches this socket
      sub.send?.({ t: 'subbed', sessionId, seq: sessionId ? this.seqOf(sessionId) : 0 })
    } catch {
      if (gen !== sub.gen) return
      sub.companyId = null
      sub.sessionId = null
      sub.channelId = null
    }
  }

  private turnStarted(sessionId: Id, at: number | null): void {
    if (at === null) this.turnSince.delete(sessionId)
    else this.turnSince.set(sessionId, new Date(at).toISOString())
  }

  /** the last op number a chat sent (a terminal shown as a chat numbers its own) */
  private seqOf(sessionId: Id): number {
    return this.feeds?.has(sessionId) ? this.feeds.seqOf(sessionId) : (this.chatSeq.get(sessionId) ?? 0)
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
        // a terminal shown from its transcript numbers its own ops; the Mac taking it back as a chat ends that view
        if (this.feeds?.has(p.sessionId)) {
          if (p.ops.some((o) => o.op === 'mode' && o.mode === 'chat')) this.feeds.ended(p.sessionId)
          return
        }
        this.chatSeq.set(p.sessionId, p.seq)
        for (const o of p.ops) if (o.op === 'state' && o.turnStartedAt !== undefined) this.turnStarted(p.sessionId, o.turnStartedAt)
        const desk = this.desk.get(p.sessionId)
        const ops = desk ? p.ops.map((o) => (o.op === 'reset' ? { ...o, items: [...desk, ...o.items] } : o)) : p.ops
        this.push((s) => s.sessionId === p.sessionId, { t: 'chat', sessionId: p.sessionId, seq: p.seq, ops })
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
        if (event === 'agent:updated') this.rootChanged(payload as AgentNode)
        // an ask opened or closed on a terminal shown as a chat: its card and the composer follow
        if (event === 'ask:updated') this.terminalAsk((payload as { sessionId?: Id | null }).sessionId ?? null)
        return this.changed(co, ['now', 'needs', 'chats', 'companies'])
      }
      case 'session:updated': {
        const s = payload as Session
        if (s.status === 'exited') this.feeds?.ended(s.id)
        return this.changed(s.companyId || PERSONAL_COMPANY_ID, ['now', 'needs', 'chats', 'companies'])
      }
      case 'run:updated':
        return this.changed((payload as { companyId?: Id | null }).companyId || null, ['now', 'needs', 'chats', 'companies', 'room'])
      case 'pty:exit':
        this.feeds?.ended((payload as EventMap['pty:exit']).sessionId)
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

  /** A terminal session's root changed: its chat header follows (working, your turn, waiting on you). */
  private rootChanged(a: AgentNode): void {
    if (a.kind === 'session' && a.parentId === null && a.sessionId) {
      // a terminal's turn: from the moment its root went to work (a chat's own state op says it exactly)
      if (a.status === 'working' || a.status === 'starting') {
        if (!this.turnSince.has(a.sessionId)) this.turnSince.set(a.sessionId, a.updatedAt)
      } else this.turnSince.delete(a.sessionId)
    }
    if (!this.feeds || a.kind !== 'session' || a.parentId !== null || !a.sessionId || !this.feeds.has(a.sessionId)) return
    this.feeds.state(a.sessionId, terminalTurn(a, false), plainActivity(a.activity, { code: !!a.repoId }))
  }
  /** an ask on a terminal shown as a chat: the phones on it take a fresh view (the card, the composer) */
  private terminalAsk(sessionId: Id | null): void {
    if (sessionId && this.feeds?.has(sessionId)) this.feeds.refresh(sessionId)
  }

  /** Turn off / revoke: tell the phones, then the server closes the sockets. */
  bye(reason: 'off' | 'revoked', device?: string): void {
    const text = JSON.stringify({ t: 'bye', reason } satisfies PhoneServerMsg)
    for (const [ws, s] of this.subs) if ((!device || s.device === device) && ws.readyState === ws.OPEN) ws.send(text)
  }
}

/**
 * A message typed while it works goes in as a bracketed paste, which only Claude Code and Codex are known to take (and
 * queue). Any other CLI may not have turned paste mode on, and then the paste's leading ESC would interrupt it.
 */
function pastes(s: Session): boolean {
  return s.adapter === 'claude' || s.adapter === 'codex'
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

/**
 * A message typed into a working terminal (a bracketed paste). Line breaks stay (the paste keeps them in one message);
 * escape sequences and other control characters are dropped, so the text can never end the paste early or press keys.
 * Like a reply, commands (`!`, `/`, `#`) stay on the Mac.
 */
export function terminalMessage(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[\s\S]?|\u009b[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) throw new HttpError(400, 'Write something first')
  if (/^[!/#]/.test(text)) throw new HttpError(400, 'Plain words only from the phone: commands starting with !, / or # stay on your Mac.')
  return text
}

/** `activity`: what a working card's run is doing now (the phone's working line); only a working card carries it. */
export function roomMessage(m: ForumMessage, activity?: string | null): PhoneRoomMessage {
  const t = m.task
  const doing = t?.state === 'working' && activity ? activity : null
  return {
    id: m.id, seq: m.seq, channelId: m.channelId, threadId: m.threadId, authorId: m.authorId, kind: m.kind, text: m.text, at: m.createdAt,
    ...(t ? { task: { identifier: t.identifier, title: t.title, state: t.state, label: TASK_CARD_LABEL[t.state] ?? t.state, result: t.result ?? null, prUrl: t.prUrl ?? null, startedAt: t.startedAt, finishedAt: t.finishedAt ?? null, ...(doing ? { activity: doing } : {}) } } : {})
  }
}

/** The run's live root (a step root), newest first; only one that is still working has an activity worth showing. */
export function cardActivityRoot(roots: readonly AgentNode[]): AgentNode | null {
  let best: AgentNode | null = null
  for (const a of roots) if (a.parentId === null && (!best || a.updatedAt > best.updatedAt)) best = a
  return best && (best.status === 'working' || best.status === 'starting') ? best : null
}

export { agentStatus, whoResolver }
