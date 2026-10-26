/**
 * FORUM.md §3, §6: the Forum service in main. Owns the store, the agent API, the per-step tokens and the localhost
 * HTTP server; turns asks into board asks and answers into task wakes; applies approved proposals through the same
 * department/agent paths the UI uses; harvests fenced ```forum blocks at step end. No Electron imports: everything
 * the app provides comes in through ForumServiceDeps (wire.ts), so tests run it on an in-memory db.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { AdapterId } from '../../shared/types'
import type { ForumBridge, ForumSpawn, McpServerSpec } from '../../shared/engine'
import { FORUM_LIMITS, FORUM_PROTOCOL_VERSION, type ForumAsk, type ForumChannel as ForumChannelView, type ForumDecideRequest, type ForumEvent, type ForumMember, type ForumMessage, type ForumPresence, type ForumProposal, type ForumState } from '../../shared/forum'
import { HiveError } from '../../shared/errors'
import { ForumStore, type ForumDirectory } from './store'
import { ForumAgentApi, ForumRefusal, type ForumCaller } from './agentApi'
import { ForumHttpServer } from './http'
import { FORUM_SERVER_NAME, FORUM_TOOLS, FORUM_WRITES, parseForumBlocks, type ForumTool } from './protocol'
import { formatBrief } from './format'
import { stepSummary } from './summary'
import { AgentCollab, type CollabWakeRequest, type CollabWakeResult } from './collab'
import { TeamTools, type TeamTask } from './teamTools'
import { collabSettings, type AgentCollabSettings, type CollabState, type RunConversation } from '../../shared/collab'

const fail = (m: string): never => {
  throw new HiveError('bad_request', m)
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A board task as the Forum needs it. */
export interface ForumTaskView { id: string; companyId: string; identifier: string; status: string; blockReason: string | null; runId: string | null; ask: { prompt: string; answer?: string } | null; report: unknown }

export interface ForumServiceDeps {
  db: Database.Database
  directory: ForumDirectory
  /** experimental.companies + .departments: off = no agent access, IPC refuses */
  enabled: () => boolean
  emit: (e: ForumEvent) => void
  redact?: (s: string) => string
  /** board tasks (CompanyStore); absent = asks never park a task */
  tasks?: {
    get(taskId: string): ForumTaskView | null
    /** CompanyStore.patchInFlight(task, {ask, report:null}) while the run holds the task */
    setAsk(taskId: string, ask: { kind: 'question' | 'choice'; prompt: string; options?: string[] } | null): void
    /** tasks:answer (wakes the same agent) */
    answer(taskId: string, answer: string): void
    create(input: { companyId: string; title: string; description: string; departmentId: string | null; agentId: string | null }): { id: string; identifier: string }
  }
  /** the same paths as departments:save / companyAgents:save (they emit data:changed) */
  company?: {
    saveDepartment(input: { companyId: string; name: string; key?: string; does: string; doesNot: string }): { id: string; key: string; name: string }
    saveAgent(input: { companyId: string; departmentId: string | null; profileId: string; role: string; instructions: string; capabilities: string }): { id: string; name: string }
    departmentByKey(companyId: string, key: string): { id: string; key: string; name: string; archivedAt: string | null } | null
    defaultProfile(adapter: AdapterId): { id: string } | null
    profileExists(id: string): boolean
    companyName(companyId: string): string
    /** "Copywriter, Marketing" for an agent seat */
    seatLabel(agentId: string): string | null
  }
  /** AGENT-COLLAB.md: the board for team_board (CompanyStore.listTasks) */
  board?: (companyId: string) => TeamTask[]
  /** Settings → agentCollab (absent = the defaults) */
  collabSettings?: () => Partial<AgentCollabSettings> | null | undefined
  /** an agent seat: its department, whether it can run a reply; a department's lead (first active profile seat) */
  seats?: {
    departmentOf(agentId: string): string | null
    canAnswer(agentId: string): boolean
    leadOf(companyId: string, departmentId: string): string | null
  }
  /** out/main/forum-cli.js; null = no CLI/MCP (tests) */
  cliScript?: string | null
  execPath?: string
  /** per-step shim folders live here (0700) */
  spawnRoot?: string | null
  now?: () => Date
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

interface TokenEntry { caller: ForumCaller; adapter: AdapterId; hits: number[] }
/** A run started to answer a Forum message (responder.ts): where its fallback reply goes. */
export interface ForumReplyRun { memberId: string; channelId: string; messageId: string }

export { stepSummary }
interface Waiter { resolve: (m: ForumMessage | null) => void; timer: NodeJS.Timeout }

export class ForumService implements ForumBridge {
  readonly store: ForumStore
  readonly api: ForumAgentApi
  readonly http: ForumHttpServer
  private readonly tokens = new Map<string, TokenEntry>()
  private readonly stepTokens = new Map<string, string>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  private readonly presence = new Map<string, ForumPresence>()
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>()
  /** steps that wrote to the Forum themselves (tool, CLI or fenced block): no automatic post for them */
  private readonly stepWrites = new Set<string>()
  /** runs answering a Forum message (the responder registers them) */
  private readonly replyRuns = new Map<string, ForumReplyRun>()
  /** responder.ts: a human posted (set by wire.ts; absent in tests that do not need it) */
  onHumanPost: ((m: ForumMessage) => void) | null = null

  readonly team: TeamTools
  readonly collab: AgentCollab
  /** responder.ts wakeForAgent (set by wire.ts; absent in tests that do not wake) */
  collabWake: ((req: CollabWakeRequest) => CollabWakeResult) | null = null

  constructor(private readonly d: ForumServiceDeps) {
    this.store = new ForumStore(d.db, { directory: d.directory, now: d.now, redact: d.redact, onEvent: (e) => this.onStoreEvent(e) })
    const settings = () => collabSettings(d.collabSettings?.())
    this.team = new TeamTools({
      db: d.db,
      store: () => this.store,
      directory: d.directory,
      board: d.board,
      companyName: (id) => d.company?.companyName(id) ?? '',
      redact: d.redact,
      collabUsage: (companyId) => this.collab.usage(companyId),
      now: d.now
    })
    this.collab = new AgentCollab({
      db: d.db,
      store: () => this.store,
      settings,
      ready: () => !!this.collabWake,
      canAnswer: d.seats ? (agentId) => d.seats!.canAnswer(agentId) : undefined,
      wake: (req) => (this.collabWake ? this.collabWake(req) : { runId: null, queued: false, error: 'agents cannot be woken in this Principia' }),
      cost: (runIds) => this.team.runCost(runIds),
      now: d.now,
      log: d.log
    })
    this.api = new ForumAgentApi({
      collab: this.collab,
      collabSettings: settings,
      team: this.team,
      leadOf: d.seats ? (companyId, depId) => d.seats!.leadOf(companyId, depId) : undefined,
      departmentOf: d.seats ? (agentId) => d.seats!.departmentOf(agentId) : undefined,
      store: () => this.store,
      now: d.now,
      tasks: d.tasks
        ? {
            setAsk: (taskId, runId, ask) => this.setTaskAsk(taskId, runId, ask),
            clearAsk: (taskId, runId) => this.clearTaskAsk(taskId, runId)
          }
        : null,
      waitAnswer: (id, ms, signal) => this.waitAnswer(id, ms, signal),
      presence: (c, state, channelId) => this.setPresence(c.companyId, c.memberId, state, channelId),
      companyName: (id) => d.company?.companyName(id) ?? '',
      answerAsk: (askId, byId, text, replyId) => void this.answer(askId, byId, text, replyId),
      seatLabel: (memberId) => {
        const m = this.store.member(memberId)
        return m?.agentId ? (d.company?.seatLabel(m.agentId) ?? null) : null
      },
      fileTask: d.tasks ? (c, me, from, title) => this.fileFromReply(c.companyId, me, from, title) : undefined
    })
    this.http = new ForumHttpServer({ call: (token, tool, args, signal) => this.httpCall(token, tool, args, signal) })
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }
  enabled(): boolean {
    try {
      return this.d.enabled()
    } catch {
      return false
    }
  }
  assertEnabled(): void {
    if (!this.enabled()) throw new HiveError('forbidden', 'The Forum needs Companies and Departments (Settings → Experimental)')
  }

  private onStoreEvent(e: ForumEvent): void {
    this.d.emit(e)
  }

  // ---------- engine bridge (§3) ----------

  open(req: Parameters<ForumBridge['open']>[0]): ForumSpawn | null {
    try {
      if (!this.enabled() || !req.agentId || !req.companyId || req.adapter === 'shell') return null
      this.store.sync(req.companyId)
      const member = this.store.memberForAgent(req.agentId)
      if (!member || member.companyId !== req.companyId || member.status !== 'active') return null
      const caller: ForumCaller = { companyId: req.companyId, memberId: member.id, runId: req.runId, stepId: req.stepId, taskId: req.taskId }
      const token = randomBytes(32).toString('base64url')
      this.close(req.stepId)
      this.tokens.set(token, { caller, adapter: req.adapter, hits: [] })
      this.stepTokens.set(req.stepId, token)
      const url = this.http.url
      const env: Record<string, string> = { PRINCIPIA_FORUM_ME: `@${member.handle}`, PRINCIPIA_FORUM_PROTOCOL: String(FORUM_PROTOCOL_VERSION) }
      if (url) Object.assign(env, { PRINCIPIA_FORUM_URL: url, PRINCIPIA_FORUM_TOKEN: token })
      const cli = this.d.cliScript && fs.existsSync(this.d.cliScript) ? this.d.cliScript : null
      const exec = this.d.execPath ?? process.execPath
      let binDir: string | null = null
      if (cli && url && this.d.spawnRoot) {
        try {
          binDir = path.join(this.d.spawnRoot, req.stepId)
          fs.mkdirSync(binDir, { recursive: true, mode: 0o700 })
          const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
          fs.writeFileSync(path.join(binDir, 'forum'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(exec)} ${q(cli)} "$@"\n`, { mode: 0o700 })
        } catch (e) {
          this.d.log?.warn('forum: shim failed; no CLI for this step', { stepId: req.stepId, error: String(e) })
          binDir = null
        }
      }
      const mcp = (req.adapter === 'claude' || req.adapter === 'codex') && !!cli && !!url
      const server: McpServerSpec | null = mcp
        ? { name: FORUM_SERVER_NAME, command: exec, args: [cli!, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', PRINCIPIA_FORUM_URL: url!, PRINCIPIA_FORUM_TOKEN: token, PRINCIPIA_FORUM_ME: `@${member.handle}` } }
        : null
      const state = this.api.briefState(member.id)
      const lookup = this.api.lookupFor(caller)
      const prompt = formatBrief(lookup, {
        me: member,
        ...state,
        home: this.homeChannel(req.companyId, member.id)?.name ?? null,
        update: !!req.taskId,
        transport: mcp ? 'mcp' : 'inject',
        ...(mcp ? {} : { digest: this.api.preview(caller, FORUM_LIMITS.injectBriefMax - 500) })
      })
      this.setPresence(req.companyId, member.id, 'working', null)
      return { env, binDir, server, toolNames: mcp ? [...FORUM_TOOLS] : [], prompt }
    } catch (e) {
      this.d.log?.warn('forum: open failed; step runs without the Forum', { stepId: req.stepId, error: String(e) })
      return null
    }
  }

  /** The seat's department channel (the first one it is in), else #general. */
  homeChannel(companyId: string, memberId: string): ForumChannelView | null {
    const all = this.store.channels(companyId, memberId).filter((c) => !c.archivedAt)
    return all.find((c) => c.system === 'department' && c.memberIds.includes(memberId)) ?? all.find((c) => c.system === 'general') ?? null
  }

  /** responder.ts: this run answers `reply`; its final answer is posted there when it does not reply itself. */
  noteReplyRun(runId: string, reply: ForumReplyRun): void {
    this.replyRuns.set(runId, reply)
  }
  replyRunOf(runId: string): ForumReplyRun | null {
    return this.replyRuns.get(runId) ?? null
  }
  forgetRun(runId: string): void {
    this.replyRuns.delete(runId)
  }
  /** A human posted through the app (forum:post): wakes the agents it is for (responder.ts). Never throws. */
  humanPosted(m: ForumMessage): void {
    try {
      this.onHumanPost?.(m)
    } catch (e) {
      this.d.log?.warn('forum: responder failed', { messageId: m.id, error: String(e) })
    }
  }

  close(stepId: string): void {
    const token = this.stepTokens.get(stepId)
    if (!token) return
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    this.stepTokens.delete(stepId)
    if (this.d.spawnRoot) {
      try {
        fs.rmSync(path.join(this.d.spawnRoot, stepId), { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
    if (entry && ![...this.tokens.values()].some((t) => t.caller.memberId === entry.caller.memberId)) this.setPresence(entry.caller.companyId, entry.caller.memberId, 'idle', null)
  }

  /** Active step tokens (tests, diagnostics). */
  tokenCount(): number {
    return this.tokens.size
  }
  callerOf(token: string): ForumCaller | null {
    return this.tokens.get(token)?.caller ?? null
  }

  private httpCall(token: string, tool: ForumTool, args: unknown, signal: AbortSignal): Promise<{ status: number; text: string }> | null {
    const entry = this.tokens.get(token)
    if (!entry) return null
    const t = this.now().getTime()
    entry.hits = entry.hits.filter((x) => t - x < 60_000)
    if (entry.hits.length >= FORUM_LIMITS.httpPerMinute) return Promise.resolve({ status: 429, text: `Too many Forum calls (limit ${FORUM_LIMITS.httpPerMinute} per minute). Wait a minute.` })
    entry.hits.push(t)
    if (!this.enabled()) return Promise.resolve({ status: 403, text: 'The Forum is off in this Principia' })
    return this.api
      .call(entry.caller, tool, args, { signal })
      .then((text) => {
        if (FORUM_WRITES.has(tool) && entry.caller.stepId) this.stepWrites.add(entry.caller.stepId)
        return { status: 200, text }
      })
      .catch((e: unknown) => (e instanceof ForumRefusal ? { status: 400, text: e.message } : { status: 500, text: `Forum error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }))
  }

  /** Starts the localhost server (boot). */
  async start(): Promise<string | null> {
    try {
      return await this.http.start()
    } catch (e) {
      this.d.log?.warn('forum: HTTP server failed; agents get the fenced block only', { error: String(e) })
      return null
    }
  }
  async stop(): Promise<void> {
    for (const set of this.waiters.values()) for (const w of set) (clearTimeout(w.timer), w.resolve(null))
    this.waiters.clear()
    for (const t of this.presenceTimers.values()) clearTimeout(t)
    await this.http.stop()
  }

  // ---------- presence (§8) ----------

  setPresence(companyId: string, memberId: string, state: ForumPresence['state'], channelId: string | null): void {
    const p: ForumPresence = { companyId, memberId, state, channelId, at: this.now().toISOString() }
    const prev = this.presence.get(memberId)
    clearTimeout(this.presenceTimers.get(memberId))
    if (state === 'idle') this.presence.delete(memberId)
    else this.presence.set(memberId, p)
    if (!prev || prev.state !== p.state || prev.channelId !== p.channelId) this.d.emit({ kind: 'presence', companyId, presence: p })
    // reading/composing fade back to working after 90 s
    if (state === 'reading' || state === 'composing') {
      const timer = setTimeout(() => {
        if (this.presence.get(memberId)?.at === p.at) this.setPresence(companyId, memberId, 'working', null)
      }, 90_000)
      timer.unref?.()
      this.presenceTimers.set(memberId, timer)
    }
  }
  presenceOf(companyId: string): ForumPresence[] {
    return [...this.presence.values()].filter((p) => p.companyId === companyId)
  }

  // ---------- asks (§6) ----------

  private waitAnswer(messageId: string, ms: number, signal?: AbortSignal): Promise<ForumMessage | null> {
    return new Promise((resolve) => {
      const cur = this.store.message(messageId)
      if (cur.ask?.status !== 'open') return resolve(cur)
      const set = this.waiters.get(messageId) ?? new Set<Waiter>()
      const done = (m: ForumMessage | null) => {
        clearTimeout(w.timer)
        set.delete(w)
        if (!set.size) this.waiters.delete(messageId)
        resolve(m)
      }
      const w: Waiter = { resolve: done, timer: setTimeout(() => done(null), ms) }
      w.timer.unref?.()
      set.add(w)
      this.waiters.set(messageId, set)
      signal?.addEventListener('abort', () => done(null), { once: true })
    })
  }

  private setTaskAsk(taskId: string, runId: string | null, ask: { prompt: string; options?: string[] }): boolean {
    const t = this.d.tasks?.get(taskId)
    if (!t || t.status !== 'in_progress' || (runId && t.runId !== runId)) return false
    // a report already decides this turn's outcome: the ask stays a Forum ask
    if (t.report) return false
    try {
      this.d.tasks!.setAsk(taskId, { kind: ask.options?.length ? 'choice' : 'question', prompt: clip(ask.prompt, 2000), ...(ask.options?.length ? { options: ask.options } : {}) })
      return true
    } catch (e) {
      this.d.log?.warn('forum: task ask failed', { taskId, error: String(e) })
      return false
    }
  }
  private clearTaskAsk(taskId: string, runId: string | null): void {
    const t = this.d.tasks?.get(taskId)
    if (!t || t.status !== 'in_progress' || (runId && t.runId !== runId)) return
    try {
      this.d.tasks!.setAsk(taskId, null)
    } catch {
      /* the run moved on */
    }
  }

  /**
   * A human (or an asked agent) answers an ask: from an option button, the answer field or a thread reply
   * (`replyId` = that reply, so no second reply is posted). Wakes waiting tools; a parked task gets tasks:answer.
   */
  answer(messageId: string, byId: string, answer: string, replyId?: string): ForumMessage {
    const msg = this.store.message(messageId)
    if (msg.kind !== 'ask' || !msg.ask) fail('That message is not an ask')
    const by = this.store.mustMember(byId)
    if (by.companyId !== msg.companyId) fail('That ask is not in your company')
    const text = answer.trim()
    if (!text) fail('The answer is empty')
    const ask = msg.ask!
    if (ask.status !== 'open') fail('This ask was already answered')
    if (!(by.role === 'owner' || by.role === 'admin' || ask.to.includes(by.id))) fail('This ask is for someone else')
    if (!replyId) this.store.post(by.id, { channelId: msg.channelId, threadId: msg.id, text })
    const next: ForumAsk = { ...ask, status: 'answered', answer: clip(this.d.redact ? this.d.redact(text) : text, 4000), answeredBy: by.id, answeredAt: this.now().toISOString() }
    let updated = this.store.patchPayload(msg.id, { ask: next })
    const hadWaiter = !!this.waiters.get(msg.id)?.size
    for (const w of [...(this.waiters.get(msg.id) ?? [])]) w.resolve(updated)
    // the board: a parked task wakes with the answer; a running one gets it when it parks (unless a tool was waiting)
    if (ask.taskId && this.d.tasks && !hadWaiter) {
      const r = this.applyTaskAnswer(ask.taskId, next.answer!)
      if (r === 'running') updated = this.store.patchPayload(msg.id, { ask: { ...next, pendingTaskAnswer: true } })
    }
    return updated
  }

  /** 'answered' | 'running' (applied later) | 'skip' (the task moved on). */
  private applyTaskAnswer(taskId: string, answer: string): 'answered' | 'running' | 'skip' {
    const t = this.d.tasks?.get(taskId)
    if (!t) return 'skip'
    if (t.status === 'blocked' && t.blockReason === 'needs_input' && t.ask && !t.ask.answer) {
      try {
        this.d.tasks!.answer(taskId, answer)
        return 'answered'
      } catch (e) {
        this.d.log?.warn('forum: task answer failed', { taskId, error: String(e) })
        return 'skip'
      }
    }
    return t.status === 'in_progress' ? 'running' : 'skip'
  }

  /**
   * Lazy reconcile (every state read, every run end): asks answered on the board show their answer; answers held
   * for a running task are applied once it parks.
   */
  reconcileAsks(companyId: string): void {
    if (!this.d.tasks) return
    const rows = this.d.db
      .prepare("SELECT seq FROM forum_messages WHERE company_id=? AND kind='ask' AND json_extract(data,'$.ask.taskId') IS NOT NULL AND (json_extract(data,'$.ask.status')='open' OR json_extract(data,'$.ask.pendingTaskAnswer')=1) ORDER BY seq DESC LIMIT 50")
      .all(companyId) as { seq: number }[]
    for (const { seq } of rows) {
      const m = this.store.message(seq)
      const ask = m.ask!
      const t = this.d.tasks.get(ask.taskId!)
      if (!t) continue
      if (ask.status === 'open' && t.ask?.answer && t.ask.prompt.includes(m.ref)) {
        const owner = this.store.owner(companyId)
        this.store.patchPayload(m.id, { ask: { ...ask, status: 'answered', answer: t.ask.answer, answeredBy: owner.id, answeredAt: this.now().toISOString() } })
        this.store.systemPost(m.channelId, `Answered on the board (${t.identifier}): ${clip(t.ask.answer, 300)}`, m.seq)
      } else if (ask.pendingTaskAnswer && ask.answer) {
        const r = this.applyTaskAnswer(t.id, ask.answer)
        if (r !== 'running') this.store.patchPayload(m.id, { ask: { ...ask, pendingTaskAnswer: false } })
      }
    }
  }

  // ---------- proposals (§6) ----------

  decide(req: ForumDecideRequest, byId: string): ForumMessage {
    const msg = this.store.message(req.messageId)
    const by = this.store.mustMember(byId)
    if (msg.kind !== 'proposal' || !msg.proposal) fail('That message is not a proposal')
    if (by.companyId !== msg.companyId) fail('That proposal is not in your company')
    const p = msg.proposal!
    if (!(by.role === 'owner' || by.role === 'admin')) fail('Only the owner and admins decide proposals')
    if (p.status !== 'open') fail(`This proposal was already ${p.status}`)
    const at = this.now().toISOString()
    const author = this.store.member(msg.authorId)
    if (req.decision === 'reject') {
      const out = this.store.patchPayload(msg.id, { proposal: { ...p, status: 'rejected', decidedBy: by.id, decidedAt: at, note: req.note?.trim() || undefined, error: undefined } })
      this.store.systemPost(msg.channelId, `${by.name} rejected the proposal${req.note?.trim() ? `: ${clip(req.note.trim(), 300)}` : '.'}`, msg.seq)
      return out
    }
    const c = this.d.company ?? fail('Departments are not available')
    const e = req.edits ?? {}
    let result: ForumProposal['result']
    let line: string
    try {
      if (p.kind === 'department') {
        const dep = p.department!
        const saved = c!.saveDepartment({ companyId: msg.companyId, name: (e.name ?? dep.name).trim(), key: e.key?.trim() || dep.key, does: (e.does ?? dep.does).trim(), doesNot: (e.doesNot ?? dep.doesNot).trim() })
        result = { departmentId: saved.id }
        this.store.sync(msg.companyId)
        line = `${by.name} approved ${author?.name ?? 'the'}'s proposal. ${saved.name} is a department now; #${this.store.channels(msg.companyId, by.id).find((x) => x.departmentId === saved.id)?.name ?? saved.key} is open.`
      } else {
        const a = p.agent!
        const depKey = e.departmentKey !== undefined ? e.departmentKey : a.departmentKey
        const dep = depKey ? c!.departmentByKey(msg.companyId, depKey) : null
        if (depKey && (!dep || dep.archivedAt)) fail(`No department "${depKey}" in this company`)
        const profileId = e.profileId ?? c!.defaultProfile((a.adapter ?? 'claude') as AdapterId)?.id
        if (!profileId || !c!.profileExists(profileId)) fail('Pick a profile for the new agent')
        const saved = c!.saveAgent({ companyId: msg.companyId, departmentId: dep?.id ?? null, profileId: profileId!, role: (e.role ?? a.role).trim(), instructions: (e.instructions ?? a.instructions).trim(), capabilities: (e.capabilities ?? a.capabilities).trim() })
        result = { agentId: saved.id }
        this.store.sync(msg.companyId)
        const m = this.store.memberForAgent(saved.id)
        line = `${by.name} approved the hire. ${m?.name ?? saved.name} joined ${dep ? dep.name : 'the company'} as ${saved.name}${m ? ` (@${m.handle})` : ''}.`
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.patchPayload(msg.id, { proposal: { ...p, error: clip(message, 300) } })
      throw err instanceof HiveError ? err : new HiveError('bad_request', message)
    }
    const out = this.store.patchPayload(msg.id, { proposal: { ...p, status: 'approved', decidedBy: by.id, decidedAt: at, note: req.note?.trim() || undefined, result, error: undefined } })
    this.store.systemPost(msg.channelId, line, msg.seq)
    const proposals = this.store.channels(msg.companyId, by.id).find((x) => x.system === 'proposals')
    if (proposals && proposals.id !== msg.channelId) this.store.systemPost(proposals.id, `${line} (${msg.ref})`)
    return out
  }

  // ---------- make task (§6) ----------

  toTask(messageId: string, byId: string, agentId?: string | null): { id: string; identifier: string } {
    const msg = this.store.message(messageId)
    const by = this.store.mustMember(byId)
    if (msg.companyId !== by.companyId) fail('That message is not in your company')
    if (by.kind !== 'human' || !(by.role === 'owner' || by.role === 'admin' || by.role === 'member')) fail('Only people can make tasks')
    const tasks = this.d.tasks ?? fail('The board is not available')
    const ch = this.store.channel(msg.channelId)
    const mentionedSeat = msg.mentions.map((id) => this.store.member(id)).find((m) => m?.kind === 'agent' && m.agentId)?.agentId ?? null
    const first = msg.text.split('\n')[0].replace(/@[a-z0-9._-]+\s*/gi, '').trim() || 'From the Forum'
    const where = ch.name ? `#${ch.name}` : 'a direct message'
    const author = this.store.member(msg.authorId)
    const t = tasks!.create({
      companyId: msg.companyId,
      title: clip(first, 120),
      description: `${msg.text}\n\nFrom the Forum: ${where}, ${author?.name ?? 'someone'} (${msg.ref}).`,
      departmentId: ch.departmentId,
      agentId: agentId ?? mentionedSeat
    })
    this.store.systemPost(msg.channelId, `${by.name} made ${t.identifier} from this message.`, msg.threadId ? this.store.message(msg.threadId).seq : msg.seq)
    return t
  }

  /** messages an agent already filed as a task (forum_reply `task`): one task per message */
  private readonly filed = new Map<string, string>()
  /** forum_reply `task`: the person's message as a Board task for the agent who replied (like Make task). */
  private fileFromReply(companyId: string, me: ForumMember, msg: ForumMessage, title: string): { id: string; identifier: string } | null {
    if (msg.companyId !== companyId || me.companyId !== companyId) fail('That message is not in your company')
    if (this.filed.has(msg.id)) return null
    const tasks = this.d.tasks ?? fail('The board is not available')
    const ch = this.store.channel(msg.channelId)
    const where = ch.name ? `#${ch.name}` : 'a direct message'
    const author = this.store.member(msg.authorId)
    const t = tasks!.create({
      companyId,
      title: clip(title.trim(), 120),
      description: `${msg.text}\n\nFrom the Forum: ${where}, ${author?.name ?? 'someone'} (${msg.ref}). ${me.name} filed it when asked.`,
      departmentId: ch.departmentId,
      agentId: me.agentId ?? null
    })
    this.filed.set(msg.id, t.id)
    if (this.filed.size > 2000) for (const k of [...this.filed.keys()].slice(0, 1000)) this.filed.delete(k)
    this.store.systemPost(msg.channelId, `${me.name} made ${t.identifier} from this message.`, msg.threadId ? this.store.message(msg.threadId).seq : msg.seq)
    return t
  }

  // ---------- fenced harvest (§4.1.4) ----------

  /**
   * EngineContext.onStepOutput: apply the ```forum ops of a passed or failed agent step of a seat run, then, when the
   * step wrote nothing to the Forum, post for it (a reply run answers its message; a task run posts its update in the
   * seat's channel). Never throws.
   */
  async harvest(e: { runId: string; stepId: string; adapter: string; status: string; output: string; companyId: string | null }): Promise<number> {
    try {
      if (!this.enabled() || e.adapter === 'shell' || e.status === 'canceled') return 0
      // read now: the run may end (and be forgotten) while the fenced ops below are applied
      const reply = this.replyRuns.get(e.runId) ?? null
      const row = this.d.db.prepare('SELECT agent_id, task_id, company_id FROM runs WHERE id=?').get(e.runId) as { agent_id: string | null; task_id: string | null; company_id: string | null } | undefined
      if (!row?.agent_id) return 0
      const companyId = row.company_id ?? e.companyId
      if (!companyId) return 0
      this.store.sync(companyId)
      const member = this.store.memberForAgent(row.agent_id)
      if (!member || member.companyId !== companyId || member.status !== 'active') return 0
      const caller: ForumCaller = { companyId, memberId: member.id, runId: e.runId, stepId: e.stepId, taskId: row.task_id }
      let applied = 0
      if (e.output.includes('forum')) {
        const { ops, errors } = parseForumBlocks(e.output)
        for (const [i, op] of ops.entries()) {
          const args = op.tool === 'forum_ask' ? { ...op.args, wait_s: 0 } : op.args
          try {
            await this.api.call(caller, op.tool, args, { origin: `agent:${e.stepId}`, opKey: `${e.stepId}:${i}` })
            applied++
          } catch (err) {
            errors.push(`${op.tool}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (errors.length) this.d.log?.warn('forum: fenced ops refused', { runId: e.runId, stepId: e.stepId, errors: errors.slice(0, 5) })
      }
      const wrote = applied > 0 || this.stepWrites.has(e.stepId)
      this.stepWrites.delete(e.stepId)
      if (!wrote && e.status === 'passed') this.autoPost(e, member, row.task_id, reply)
      return applied
    } catch (err) {
      this.d.log?.warn('forum: harvest failed', { runId: e.runId, error: String(err) })
      return 0
    }
  }

  /** The step's final answer, posted for an agent that did not post itself (the team sees every turn). */
  private autoPost(e: { runId: string; stepId: string; output: string }, member: ForumMember, taskId: string | null, reply: ForumReplyRun | null): void {
    const opKey = `${e.stepId}:auto`
    try {
      if (reply) {
        const text = stepSummary(e.output, FORUM_LIMITS.agentText)
        if (!text) return
        const posted = this.store.post(member.id, { channelId: reply.channelId, threadId: reply.messageId, text, origin: `agent:${e.stepId}`, opKey })
        // AGENT-COLLAB.md: the answer of a woken agent that did not reply itself still answers the ask it was woken for
        const root = this.store.message(posted.threadId ?? reply.messageId)
        this.collab.noteReplied(member.id, root.seq)
        if (root.kind === 'ask' && root.ask?.status === 'open' && root.ask.to.includes(member.id)) {
          try {
            this.answer(root.id, member.id, text, posted.id)
          } catch {
            /* it stays a reply */
          }
        }
        return
      }
      if (!taskId) return
      const home = this.homeChannel(member.companyId, member.id)
      if (!home) return
      const t = this.d.tasks?.get(taskId)
      const head = t ? `${t.identifier}: ` : ''
      const text = stepSummary(e.output, FORUM_LIMITS.agentText - head.length - 1)
      if (!text) return
      this.store.post(member.id, { channelId: home.id, text: `${head}${text}`, origin: `agent:${e.stepId}`, opKey })
    } catch (err) {
      this.d.log?.warn('forum: automatic post failed', { runId: e.runId, stepId: e.stepId, error: String(err) })
    }
  }

  // ---------- renderer state ----------

  /** The owner's view of a company's Forum (sync + lazy reconcile first). */
  state(companyId: string): ForumState {
    this.assertEnabled()
    this.store.sync(companyId)
    this.reconcileAsks(companyId)
    const me = this.store.owner(companyId)
    const channels = this.store.channels(companyId, me.id)
    return {
      companyId,
      me: me.id,
      members: this.store.members(companyId, { includeRemoved: true }),
      channels,
      presence: this.presenceOf(companyId),
      // asks between agents are their conversation (AGENT-COLLAB.md), not something the owner must answer
      openAsks: this.store.openAsks(companyId).filter((m) => m.ask?.to.some((id) => this.store.member(id)?.kind !== 'agent')).length,
      openProposals: this.store.openProposals(companyId).length
    }
  }

  // ---------- agent conversations (AGENT-COLLAB.md §5) ----------

  collabState(companyId: string): CollabState {
    this.assertEnabled()
    this.store.sync(companyId)
    return this.collab.state(companyId)
  }
  runConversation(runId: string): RunConversation {
    this.assertEnabled()
    return this.collab.forRun(runId)
  }

  /** The viewer on this Mac: the company owner. */
  me(companyId: string): ForumMember {
    this.store.sync(companyId)
    return this.store.owner(companyId)
  }
}
