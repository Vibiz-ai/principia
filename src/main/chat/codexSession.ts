/**
 * AGENT CHAT: one Codex conversation shown as a chat, the Codex twin of ChatSession. To SessionManager it is the
 * session's "pty" (PtyLike): the Session row, live tree, memory grant, reaper and kill path are unchanged. Inside, a
 * long-lived `codex app-server` (JSON-RPC over stdio, verified on codex-cli 0.163.0): one thread per conversation,
 * one `turn/start` per message, streamed items folded by shared/codexReduce.ts into the same chat items as Claude.
 *
 * - The pane's argv (codexAdapter.interactive) is reused: its `-c` overrides (Principia's MCP servers, developer
 *   instructions), `--add-dir`, `-m` and the bypass flag become the app-server's config and the thread's settings.
 * - Approvals (commands, file changes) are the chat's Allow / Deny cards and Needs-you asks.
 * - Resume: the thread id is the conversation (Session.agentSessionId); `thread/resume` brings its history back.
 * - Asleep after 10 idle minutes; the next message starts the server again and resumes the thread.
 * No terminal view yet: a Codex chat stays a chat. No Electron imports (testable with fakes).
 */
import type { Id } from '../../shared/types'
import type { ChatDecision, ChatImage, ChatItem, ChatMeta, ChatMode, ChatOp, ChatQueued, ChatSnapshot, ChatTurn } from '../../shared/chat'
import { CODEX_MODES, EMPTY_CHAT_META } from '../../shared/chat'
import { CODEX_USAGE_COMMAND, CodexReducer, codexSkills, codexUsageMd, isCodexUsage } from '../../shared/codexReduce'
import { ChatModel } from '../../shared/chatReduce'
import { permissionTitle, toolLine } from '../../shared/toolVerbs'
import { HiveError } from '../../shared/errors'
import type { PtyLike } from '../sessions'
import type { ChildSpawn } from './streamProc'
import { RpcProc } from './rpcProc'
import type { ChatAskBridge } from './chatSession'
import { CHAT_IDLE_MS, plainLabel, TURN_END_SETTLE_MS } from './chatSession'

const STOP_SETTLE_MS = 4000

export interface CodexServerSpec {
  /** argv for `codex app-server` (after the binary) */
  args: string[]
  model: string | null
  bypass: boolean
  addDirs: string[]
  developerInstructions: string | null
  /** the pane's positional first message */
  prompt: string | null
}

/**
 * The app-server argv and thread settings from the pane's argv (codexAdapter.interactive). Pure.
 * `-c k=v`, `--enable`, `--disable` carry over (MCP servers, tool timeouts); developer_instructions goes to the
 * thread instead, so a resumed thread gets it too; --no-alt-screen and other TUI-only flags are dropped.
 */
export function codexServerSpec(interactive: readonly string[]): CodexServerSpec {
  const args = ['app-server']
  let model: string | null = null
  let bypass = false
  const addDirs: string[] = []
  let developerInstructions: string | null = null
  let prompt: string | null = null
  for (let i = 0; i < interactive.length; i++) {
    const a = interactive[i]!
    const next = interactive[i + 1]
    if (a === '-c' || a === '--config') {
      if (next === undefined) break
      i++
      const m = /^developer_instructions=([\s\S]*)$/.exec(next)
      if (m) {
        try {
          const v = JSON.parse(m[1]!) as unknown
          developerInstructions = typeof v === 'string' ? v : m[1]!
        } catch {
          developerInstructions = m[1]!
        }
      } else args.push('-c', next)
    } else if (a === '--enable' || a === '--disable') {
      if (next === undefined) break
      i++
      args.push(a, next)
    } else if (a === '-m' || a === '--model') {
      if (next === undefined) break
      i++
      model = next
    } else if (a === '--add-dir') {
      if (next === undefined) break
      i++
      addDirs.push(next)
    } else if (a === '--dangerously-bypass-approvals-and-sandbox' || a === '--yolo') bypass = true
    else if (a.startsWith('-')) {
      // a TUI flag (--no-alt-screen, --search, -p profile…): its value, if it takes one, is not a prompt
      if ((a === '-p' || a === '--profile' || a === '-s' || a === '--sandbox' || a === '-a' || a === '--ask-for-approval' || a === '-C' || a === '--cd' || a === '-i' || a === '--image') && next !== undefined) i++
    } else prompt = a.startsWith(' -') ? a.slice(1) : a
  }
  return { args, model, bypass, addDirs, developerInstructions, prompt }
}

/** The approval policy and sandbox of a chat mode. */
export function codexPolicy(mode: string | null, bypass: boolean): { approvalPolicy: string; sandbox: string } {
  if (bypass) return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  return mode === 'default' ? { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } : { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
}

export interface CodexChatDeps {
  sessionId: Id
  file: string
  interactiveArgs: string[]
  cwd: string
  env: Record<string, string>
  /** the thread this chat continues (Restart, a revived agent chat); null = a new thread */
  resumeId: string | null
  /** AGENT CHAT: the name this chat speaks in (the agent's); null = Codex */
  speaker?(): string | null
  spawnChild: ChildSpawn
  killGroup(pid: number, signal: NodeJS.Signals): boolean
  registerPid?(pid: number): void
  emit(ops: ChatOp[]): void
  asks?: ChatAskBridge
  /** the thread exists (its id is the conversation Restart resumes) */
  onConversation?(id: string): void
  onTitle?(text: string): void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
  idleMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

type ExitCb = (e: { exitCode: number; signal?: number }) => void

export class CodexChatSession implements PtyLike {
  readonly selfKill = true
  readonly mode: ChatMode = 'chat'
  readonly startedAs: ChatMode = 'chat'
  turn: ChatTurn = 'starting'
  activity: string | null = null
  turnStartedAt: number | null = null
  meta: ChatMeta
  queue: ChatQueued[] = []
  note: string | null = null
  private images = new Map<string, ChatImage[]>()
  private reducer: CodexReducer
  private proc: RpcProc | null = null
  private ready = false
  private lastPid = 0
  private exitCbs: ExitCb[] = []
  private ended = false
  private exitFired = false
  private stopping = false
  private holdQueue = false
  private idleTimer: unknown = null
  private stopTimer: unknown = null
  private typed = ''
  private promptPending: string | null
  private threadId: string | null
  private turnId: string | null = null
  private replayed = false
  private titled = false
  private crashes = 0
  private chosenModel: string | null = null
  /** JSON-RPC id of each open approval, by the card's requestId */
  private rpcIds = new Map<string, number | string>()
  /** the skill's SKILL.md, by name: `/name …` attaches it to the turn */
  private skills = new Map<string, string>()
  /** /usage arrived before the server was ready */
  private usageWaiting = false
  private readonly spec: CodexServerSpec
  readonly bypass: boolean

  constructor(private d: CodexChatDeps) {
    this.spec = codexServerSpec(d.interactiveArgs)
    this.bypass = this.spec.bypass
    this.threadId = d.resumeId
    this.promptPending = this.spec.prompt
    this.chosenModel = this.spec.model
    this.meta = { ...EMPTY_CHAT_META, harness: 'codex', modes: CODEX_MODES, bypass: this.bypass, permissionMode: this.bypass ? 'bypassPermissions' : 'acceptEdits', model: this.spec.model ?? 'default', commands: [CODEX_USAGE_COMMAND] }
    this.reducer = new CodexReducer({ now: () => this.now(), who: () => this.who() })
    this.startProc()
  }

  // ---------- PtyLike ----------
  get pid(): number {
    return this.proc?.pid ?? this.lastPid
  }
  onData(): unknown {
    return { dispose: () => undefined }
  }
  onExit(cb: ExitCb): unknown {
    this.exitCbs.push(cb)
    return { dispose: () => (this.exitCbs = this.exitCbs.filter((x) => x !== cb)) }
  }
  /** Hive-typed replies (agents:reply): text, then "\r" sends it. */
  write(data: string): void {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const t = this.typed.trim()
        this.typed = ''
        if (t) void this.send(t).catch(() => undefined)
      } else if (ch >= ' ') this.typed += ch
    }
  }
  resize(): void {
    /* no terminal */
  }
  kill(signal?: string): void {
    if (this.exitFired) return
    this.ended = true
    this.clearIdle()
    const p = this.proc
    if (p && !p.exited) {
      p.end()
      if (!this.d.killGroup(p.pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')) p.child.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')
      return
    }
    this.fireExit(0)
  }
  private fireExit(code: number, signal?: number): void {
    if (this.exitFired) return
    this.exitFired = true
    this.ended = true
    this.clearIdle()
    this.closeOpenAsks()
    this.setTurn('ended', null)
    for (const cb of this.exitCbs) cb({ exitCode: code, signal })
  }

  // ---------- helpers ----------
  private now(): number {
    return this.d.now ? this.d.now() : Date.now()
  }
  private timer(fn: () => void, ms: number): unknown {
    return (this.d.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms)
  }
  private clear(t: unknown): void {
    ;(this.d.clearTimer ?? ((x: unknown) => clearTimeout(x as NodeJS.Timeout)))(t)
  }
  private clearIdle(): void {
    if (this.idleTimer) this.clear(this.idleTimer)
    this.idleTimer = null
  }
  private emit(ops: ChatOp[] | null | undefined): void {
    if (ops?.length) this.d.emit(ops)
  }
  private setTurn(turn: ChatTurn, activity?: string | null): void {
    const t0 = turn === 'working' || turn === 'needs' ? (this.turnStartedAt ?? this.now()) : null
    const changed = turn !== this.turn || (activity !== undefined && activity !== this.activity) || t0 !== this.turnStartedAt
    const began = turn === 'working' && this.turn !== 'working' && this.turn !== 'needs'
    this.turn = turn
    if (activity !== undefined) this.activity = activity
    this.turnStartedAt = t0
    if (changed) this.d.emit([{ op: 'state', turn, activity: this.activity, turnStartedAt: t0, note: this.note }])
    if (began) {
      try {
        this.d.asks?.working?.()
      } catch {
        /* never block the chat on live state */
      }
    }
  }
  private setMeta(p: Partial<ChatMeta>): void {
    const diff: Partial<ChatMeta> = {}
    for (const [k, v] of Object.entries(p) as [keyof ChatMeta, unknown][]) {
      if (JSON.stringify(this.meta[k]) !== JSON.stringify(v)) (diff as Record<string, unknown>)[k] = v
    }
    if (!Object.keys(diff).length) return
    this.meta = { ...this.meta, ...diff }
    this.d.emit([{ op: 'meta', meta: diff }])
  }
  private takeMeta(): void {
    if (Object.keys(this.reducer.meta).length) {
      this.setMeta(this.reducer.meta)
      this.reducer.meta = {}
    }
  }
  private emitQueue(): void {
    this.d.emit([{ op: 'queue', queue: this.queue.map((q) => ({ ...q })) }])
  }

  /** CHAT-UI.md §8: a line from Principia in this chat (a task it filed came back). Not sent to the model. */
  principiaNote(text: string): void {
    this.emit(this.reducer.notice(text, 'info'))
  }

  snapshot(seq: number): Omit<ChatSnapshot, 'sessionId'> {
    return {
      mode: 'chat',
      available: true,
      turn: this.turn,
      activity: this.activity,
      turnStartedAt: this.turnStartedAt,
      items: this.reducer.model.items.slice(),
      queue: this.queue.map((q) => ({ ...q })),
      meta: { ...this.meta },
      seq,
      note: this.note,
      startedAs: 'chat'
    }
  }
  get items(): readonly ChatItem[] {
    return this.reducer.model.items
  }
  get conversationId(): string | null {
    return this.threadId
  }
  openRequests(): string[] {
    return this.reducer.model.items.flatMap((i) => (i.kind === 'permission' && i.state === 'open' ? [i.requestId] : []))
  }

  // ---------- the app-server ----------
  private startProc(): void {
    if (this.ended) return
    this.ready = false
    this.stopping = false
    this.setTurn('starting', 'Starting Codex')
    let child
    try {
      child = this.d.spawnChild(this.d.file, this.spec.args, { cwd: this.d.cwd, env: this.d.env })
    } catch (e) {
      this.emit(this.reducer.notice(`Codex could not start: ${e instanceof Error ? e.message : String(e)}`, 'error'))
      this.setTurn('error', null)
      return
    }
    const proc: RpcProc = new RpcProc(child, {
      onNotification: (m, p) => this.onNotification(proc, m, p),
      onRequest: (id, m, p) => this.onRequest(proc, id, m, p),
      onExit: (code, signal) => this.onProcExit(proc, code, signal),
      setTimer: this.d.setTimer,
      clearTimer: this.d.clearTimer
    })
    this.proc = proc
    this.lastPid = proc.pid || this.lastPid
    if (proc.pid) this.d.registerPid?.(proc.pid)
    void this.handshake(proc).catch((e) => {
      if (this.proc !== proc || proc.exited) return
      this.d.log?.warn('codex chat: start failed', { error: String(e) })
      const msg = e instanceof Error ? e.message : String(e)
      this.emit(this.reducer.notice(/login|auth|api key|credential/i.test(msg) ? 'Codex needs you to sign in. Run codex login in a terminal.' : `Codex did not start: ${msg.slice(0, 200)}`, 'error', 'retry'))
      this.setTurn('error', null)
    })
  }

  private threadParams(): Record<string, unknown> {
    const pol = codexPolicy(this.meta.permissionMode, this.bypass)
    return {
      cwd: this.d.cwd,
      approvalPolicy: pol.approvalPolicy,
      sandbox: pol.sandbox,
      ...(this.chosenModel && this.chosenModel !== 'default' ? { model: this.chosenModel } : {}),
      ...(this.spec.developerInstructions ? { developerInstructions: this.spec.developerInstructions } : {}),
      // the chat's other company folders are writable like its own
      ...(this.spec.addDirs.length && !this.bypass ? { config: { 'sandbox_workspace_write.writable_roots': this.spec.addDirs } } : {})
    }
  }

  private async handshake(proc: RpcProc): Promise<void> {
    await proc.request('initialize', { clientInfo: { name: 'principia', title: 'Principia', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } }, 60_000)
    if (this.proc !== proc) return
    proc.notify('initialized')
    let r: Record<string, unknown>
    let resumed = false
    if (this.threadId) {
      try {
        r = await proc.request('thread/resume', { threadId: this.threadId, ...this.threadParams() }, 60_000)
        resumed = true
      } catch (e) {
        // the thread is gone (deleted, another machine): a new one, said plainly
        this.d.log?.warn('codex chat: resume failed, new thread', { error: String(e) })
        this.emit(this.reducer.notice('Codex could not find the earlier conversation, so this is a new one.', 'warn'))
        this.threadId = null
        r = await proc.request('thread/start', this.threadParams(), 60_000)
      }
    } else r = await proc.request('thread/start', this.threadParams(), 60_000)
    if (this.proc !== proc) return
    const thread = (r.thread ?? {}) as Record<string, unknown>
    const tid = typeof thread.id === 'string' ? thread.id : null
    if (!tid) throw new Error('Codex gave no conversation id')
    this.threadId = tid
    this.reducer.threadId = tid
    this.d.onConversation?.(tid)
    if (resumed && !this.replayed && !this.reducer.model.items.length) {
      const turns = Array.isArray(thread.turns) ? (thread.turns as unknown[]) : []
      const r2 = new CodexReducer({ now: () => this.now(), who: () => this.who(), idPrefix: `r${this.now().toString(36)}_` })
      r2.threadId = tid
      r2.replay(turns)
      if (turns.length) r2.notice('Resumed this conversation')
      this.reducer = new CodexReducer({ now: () => this.now(), who: () => this.who() }, new ChatModel())
      this.reducer.threadId = tid
      this.reducer.model.apply({ op: 'reset', items: r2.model.items.slice() })
      this.emit([{ op: 'reset', items: r2.model.items.slice() }])
      this.maybeTitle()
    }
    this.replayed = true
    this.ready = true
    this.crashes = 0
    this.setMeta({ model: typeof r.model === 'string' ? (this.chosenModel ?? r.model) : this.meta.model, cliVersion: typeof thread.cliVersion === 'string' ? thread.cliVersion : this.meta.cliVersion })
    void this.loadModels(proc)
    void this.loadSkills(proc)
    this.setTurn('idle', null)
    if (this.usageWaiting) void this.showUsage()
    if (this.promptPending) {
      const p = this.promptPending
      this.promptPending = null
      this.startTurn(p, [])
    } else this.flushQueue()
    if (this.turn === 'idle') this.armIdle()
  }

  /** What Codex offers in the chat's folder: its skills are the slash menu here, after /usage. */
  private async loadSkills(proc: RpcProc): Promise<void> {
    try {
      const skills = codexSkills(await proc.request('skills/list', { cwds: [this.d.cwd] }))
      if (this.proc !== proc) return
      this.skills = new Map(skills.map((s) => [s.name, s.path]))
      this.setMeta({ commands: [CODEX_USAGE_COMMAND, ...skills.map((s) => ({ name: s.name, description: s.description, argumentHint: null }))] })
    } catch {
      /* a Codex without skills: /usage alone */
    }
  }

  /** /usage: read from Codex on the spot, whatever the turn is doing. It costs no tokens and never queues. */
  private async showUsage(): Promise<void> {
    const p = this.proc
    if (!p?.alive || !this.ready) {
      this.usageWaiting = true
      if (!this.proc) this.startProc()
      return
    }
    this.usageWaiting = false
    try {
      const r = await p.request('account/rateLimits/read', undefined, 20_000)
      this.emit(this.reducer.localReply(codexUsageMd(r, this.meta.contextPct)))
    } catch (e) {
      this.emit(this.reducer.notice(`Codex did not say what is left: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, 'error'))
    }
  }

  private async loadModels(proc: RpcProc): Promise<void> {
    try {
      const r = await proc.request<{ data?: unknown[] }>('model/list', {})
      const models = (Array.isArray(r.data) ? r.data : [])
        .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
        .filter((m) => m.hidden !== true && typeof m.model === 'string')
        .map((m) => ({ value: String(m.model), label: typeof m.displayName === 'string' ? m.displayName : String(m.model), description: typeof m.description === 'string' ? m.description.slice(0, 200) : null }))
      if (models.length) this.setMeta({ models })
    } catch {
      /* the model chip keeps the current one */
    }
  }

  private onNotification(proc: RpcProc, method: string, params: unknown): void {
    if (this.proc !== proc) return
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
    if (method === 'serverRequest/resolved') {
      const rid = String(p.requestId ?? '')
      if (this.rpcIds.has(rid)) {
        this.rpcIds.delete(rid)
        try {
          this.d.asks?.close(rid, null)
        } catch {
          /* ignore */
        }
      }
      this.emit(this.reducer.resolved(rid))
      if (!this.openRequests().length && this.turn === 'needs') this.setTurn('working', this.currentActivity())
      return
    }
    const mainTurn = typeof p.threadId === 'string' && p.threadId === this.threadId
    if (method === 'turn/started' && mainTurn) {
      const t = (p.turn ?? {}) as Record<string, unknown>
      this.turnId = typeof t.id === 'string' ? t.id : this.turnId
    }
    this.emit(this.reducer.notification(method, params))
    this.takeMeta()
    if (method === 'turn/completed' && mainTurn) {
      this.turnId = null
      this.onTurnEnd()
      return
    }
    if (method.startsWith('item/') && (this.turn === 'working' || this.turn === 'needs')) {
      this.clearIdle()
      if (this.openRequests().length) this.setTurn('needs', 'Waiting for you')
      else this.setTurn('working', this.currentActivity())
    }
  }

  private onRequest(proc: RpcProc, id: number | string, method: string, params: unknown): void {
    if (this.proc !== proc) return
    const rid = String(id)
    const ops = this.reducer.approval(rid, method, params)
    if (!ops) {
      // asks this chat cannot show yet: answered plainly so Codex never waits on a card nobody sees
      if (method === 'item/permissions/requestApproval' || method === 'applyPatchApproval' || method === 'execCommandApproval') proc.respondError(id, 'Not available in Principia chats')
      else if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
        proc.respondError(id, 'Principia cannot show this question yet; ask in the chat instead')
        this.emit(this.reducer.notice('Codex asked a question Principia cannot show as a card yet. It was told to ask in the chat instead.', 'warn'))
      } else proc.respondError(id, 'unsupported in Principia')
      return
    }
    this.rpcIds.set(rid, id)
    this.emit(ops)
    const perm = this.reducer.model.get(`perm:${rid}`)
    if (perm?.kind === 'permission') {
      // a helper agent's ask (its thread nests under the helper card) is named for the helper
      const helper = this.reducer.helperName(perm.parent)
      this.d.asks?.open({
        requestId: rid,
        toolName: perm.tool,
        input: perm.input,
        description: perm.description,
        toolUseId: perm.toolUseId,
        title: permissionTitle(perm.tool, perm.input).replace(/^Claude\b/, helper ? `${this.who()}’s helper “${helper}”` : this.who()),
        options: [
          { id: 'allow', label: 'Allow', kind: 'allow' as const },
          ...perm.suggestions.map((sg, i) => ({ id: `sug_${i}`, label: plainLabel(sg.label), kind: 'allow_step' as const })),
          { id: 'deny', label: 'Deny', kind: 'deny' as const }
        ]
      })
    }
    this.setTurn('needs', 'Waiting for you')
  }

  /** who speaks in this chat: the agent's name in an agent's chat, else Codex */
  private who(): string {
    try {
      return this.d.speaker?.()?.trim() || 'Codex'
    } catch {
      return 'Codex'
    }
  }

  private currentActivity(): string {
    const items = this.reducer.model.items
    for (let i = items.length - 1; i >= 0 && i >= items.length - 30; i--) {
      const it = items[i]!
      if (it.kind === 'tool' && (it.status === 'running' || it.status === 'pending') && it.name !== 'TodoWrite') {
        const l = toolLine(it)
        return `${l.verb}${l.target ? ` ${l.target}` : ''}`
      }
      if (it.kind === 'text' && it.streaming) return 'Writing'
      if (it.kind === 'thinking' && it.streaming) return 'Thinking'
    }
    return 'Working'
  }

  private onTurnEnd(): void {
    this.clearStopTimer()
    this.closeOpenAsks()
    this.setTurn('idle', null)
    if (this.d.asks?.turnEnded) {
      const last = [...this.reducer.model.items].reverse().find((i) => i.kind === 'text' && !i.parent)
      const report = last?.kind === 'text' && last.md.trim() ? last.md : null
      const p = this.proc
      this.timer(() => {
        if (this.proc !== p || (this.turn !== 'idle' && this.turn !== 'sleeping')) return
        try {
          this.d.asks?.turnEnded?.(report)
        } catch {
          /* never block the chat on live state */
        }
      }, TURN_END_SETTLE_MS)
    }
    if (!this.holdQueue) this.flushQueue()
    if (this.turn === 'idle') this.armIdle()
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.ended) return
    this.idleTimer = this.timer(() => {
      this.idleTimer = null
      if (this.turn !== 'idle' || this.queue.length || !this.proc) return
      this.stopping = true
      this.proc.end()
      if (!this.d.killGroup(this.proc.pid, 'SIGTERM')) this.proc.child.kill('SIGTERM')
    }, this.d.idleMs ?? CHAT_IDLE_MS)
  }

  private onProcExit(proc: RpcProc, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = false
    this.clearIdle()
    this.clearStopTimer()
    if (this.ended) {
      this.fireExit(code ?? 0, signal ? 1 : undefined)
      return
    }
    const planned = this.stopping
    this.stopping = false
    const wasTurn = this.turn === 'working' || this.turn === 'needs'
    this.closeOpenAsks()
    this.emit(this.reducer.settle())
    this.turnId = null
    if (planned) {
      this.setTurn('sleeping', null)
      return
    }
    this.crashes++
    if (wasTurn) {
      try {
        this.d.asks?.stopped?.()
      } catch {
        /* ignore */
      }
    }
    const why = proc.stderrTail.trim().split('\n').filter(Boolean).pop() ?? ''
    this.d.log?.warn('codex chat: codex exited', { code, signal, stderr: why.slice(0, 300) })
    this.emit(this.reducer.notice(`Codex stopped unexpectedly${why ? `: ${why.slice(0, 160)}` : ''}. Send a message to pick up where it left off.`, 'error', 'retry'))
    this.setTurn('sleeping', null)
  }

  private closeOpenAsks(): void {
    for (const rid of this.openRequests()) {
      try {
        this.d.asks?.close(rid, null)
      } catch {
        /* never block the chat on live state */
      }
    }
  }

  private maybeTitle(): void {
    if (this.titled || !this.d.onTitle) return
    const first = this.reducer.model.items.find((i) => i.kind === 'user' && i.text.trim() && !i.text.trim().startsWith('/'))
    if (!first || first.kind !== 'user') return
    this.titled = true
    try {
      this.d.onTitle(first.text)
    } catch {
      /* a title never blocks the chat */
    }
  }

  private clearStopTimer(): void {
    if (this.stopTimer) this.clear(this.stopTimer)
    this.stopTimer = null
  }

  // ---------- user actions ----------
  private input(text: string, images: ChatImage[]): unknown[] {
    // `/skill-name …`: the words stay as typed (so Codex's echo matches this message) and the skill comes with them
    const skill = this.skills.get(/^\/([\w:.-]+)/.exec(text)?.[1] ?? '')
    return [...images.map((im) => ({ type: 'image', url: `data:${im.mediaType};base64,${im.data}` })), { type: 'text', text, text_elements: [] }, ...(skill ? [{ type: 'skill', name: text.slice(1).split(/\s/)[0], path: skill }] : [])]
  }

  private startTurn(text: string, images: ChatImage[]): void {
    const p = this.proc
    if (!p?.alive || !this.threadId) return
    const thumbs = images.map((im) => im.thumb).filter((t): t is string => !!t)
    this.emit(this.reducer.userSent(text, images.length, 'sent', thumbs))
    this.maybeTitle()
    this.clearIdle()
    this.setTurn('working', 'Thinking')
    const pol = codexPolicy(this.meta.permissionMode, this.bypass)
    void p
      .request('turn/start', { threadId: this.threadId, input: this.input(text, images), approvalPolicy: pol.approvalPolicy, ...(this.chosenModel && this.chosenModel !== 'default' ? { model: this.chosenModel } : {}) }, 60_000)
      .then(
        (r) => {
          const t = (r.turn ?? {}) as Record<string, unknown>
          if (typeof t.id === 'string') this.turnId ??= t.id
        },
        (e) => {
          if (this.proc !== p) return
          this.emit(this.reducer.settle())
          this.emit(this.reducer.notice(`Codex did not take that message: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, 'error', 'retry'))
          this.setTurn('idle', null)
          this.armIdle()
        }
      )
  }

  private flushQueue(): void {
    if (!this.queue.length || !this.proc?.alive || !this.ready || this.turn !== 'idle') return
    const q = this.queue
    this.queue = []
    const images = q.flatMap((x) => this.images.get(x.id) ?? [])
    for (const x of q) this.images.delete(x.id)
    this.emitQueue()
    this.startTurn(q.map((x) => x.text).join('\n\n'), images)
  }

  async send(text: string, images: ChatImage[] = []): Promise<void> {
    if (this.ended) throw new HiveError('conflict', 'This chat has ended. Restart it to continue.')
    const t = text.trim()
    if (!t && !images.length) return
    if (!images.length && isCodexUsage(t)) {
      this.emit(this.reducer.localCommand(t))
      void this.showUsage()
      return
    }
    // the composer under an open card: the words answer it ("tell Codex what to do instead")
    const open = this.openRequests()
    if (t && !images.length && open.length && this.proc?.alive) return void this.answer(open[open.length - 1]!, { kind: 'deny', message: t })
    this.holdQueue = false
    if (this.ready && this.proc?.alive && this.turn === 'idle' && !this.queue.length) {
      this.startTurn(t, images)
      return
    }
    const id = `q${this.now().toString(36)}${this.queue.length}`
    this.queue.push({ id, text: t, images: images.length })
    if (images.length) this.images.set(id, images)
    this.emitQueue()
    if (!this.proc) this.startProc()
    else this.flushQueue()
  }

  editQueued(queueId: string, text: string | null): void {
    const i = this.queue.findIndex((q) => q.id === queueId)
    if (i < 0) throw new HiveError('not_found', 'That message was already sent')
    if (text === null || !text.trim()) {
      this.queue.splice(i, 1)
      this.images.delete(queueId)
    } else this.queue[i] = { ...this.queue[i]!, text: text.trim() }
    this.emitQueue()
  }

  async interrupt(sendNow = false): Promise<void> {
    this.holdQueue = !sendNow
    const p = this.proc
    if (!p || !this.ready || (this.turn !== 'working' && this.turn !== 'needs')) {
      if (sendNow) this.flushQueue()
      return
    }
    // Needs you first: closeOpenAsks reads the cards still open, so it must run before they are marked Stopped
    this.closeOpenAsks()
    for (const rid of this.openRequests()) {
      const rpc = this.rpcIds.get(rid)
      if (rpc !== undefined) p.respond(rpc, { decision: 'cancel' })
      this.rpcIds.delete(rid)
      const it = this.reducer.model.get(`perm:${rid}`)
      if (it) this.emit(this.reducer.set(it.id, { state: 'denied', outcome: 'Stopped' }))
    }
    this.setTurn('working', 'Stopping')
    if (this.threadId && this.turnId) {
      try {
        await p.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      } catch (e) {
        this.d.log?.warn('codex chat: interrupt failed', { error: String(e) })
      }
    }
    // turn/completed (interrupted) normally ends it; never stay "Stopping…"
    this.clearStopTimer()
    this.stopTimer = this.timer(() => {
      this.stopTimer = null
      if (this.proc !== p || p.exited || (this.turn !== 'working' && this.turn !== 'needs')) return
      this.emit(this.reducer.settle())
      this.emit(this.reducer.notice(`Stopped. ${this.who()} kept everything up to here.`))
      this.d.asks?.stopped?.()
      this.onTurnEnd()
    }, STOP_SETTLE_MS)
  }

  answer(requestId: string, decision: ChatDecision, via: 'chat' | 'needs' = 'chat'): string {
    const item = this.reducer.model.get(`perm:${requestId}`)
    if (!item || item.kind !== 'permission') throw new HiveError('not_found', 'That request is gone')
    if (item.state !== 'open') throw new HiveError('conflict', 'Already answered')
    const p = this.proc
    const rpc = this.rpcIds.get(requestId)
    if (!p?.alive || rpc === undefined) throw new HiveError('conflict', 'Codex is no longer waiting')
    const where = via === 'needs' ? ' from Needs you' : ''
    let summary: string
    let result: unknown
    let set: Partial<ChatItem>
    let steer: string | null = null
    if (decision.kind === 'allow' || decision.kind === 'allowAlways') {
      const sug = decision.kind === 'allowAlways' ? item.suggestions[decision.suggestion] : undefined
      result = { decision: sug ? sug.raw : 'accept' }
      summary = sug ? `${plainLabel(sug.label).replace(/^Always allow/, 'Always allowed').replace(/^Allow /, 'Allowed ')}${where}` : `Allowed${where}`
      set = { state: 'allowed', outcome: summary }
    } else if (decision.kind === 'deny') {
      const msg = decision.message?.trim() || null
      result = { decision: 'decline' }
      summary = msg ? `Denied${where}: ${msg}` : `Denied${where}`
      set = { state: 'denied', outcome: summary }
      steer = msg
    } else throw new HiveError('bad_request', 'Choose Allow or Deny')
    if (!p.respond(rpc, result)) throw new HiveError('conflict', 'Codex is no longer waiting')
    this.rpcIds.delete(requestId)
    this.emit(this.reducer.set(item.id, set))
    if (item.toolUseId && decision.kind === 'deny') {
      const card = this.reducer.model.get(`x:${item.toolUseId}`)
      if (card?.kind === 'tool') this.emit(this.reducer.set(card.id, { status: 'denied' }))
    }
    try {
      this.d.asks?.close(requestId, summary)
    } catch {
      /* ignore */
    }
    // "Tell Codex what to do instead": the words join the running turn (turn/steer), else they wait for the next one
    if (steer && this.threadId) {
      const tid = this.turnId
      const text = steer
      this.emit(this.reducer.userSent(text, 0, 'sent'))
      void (tid ? p.request('turn/steer', { threadId: this.threadId, expectedTurnId: tid, input: this.input(text, []) }) : Promise.reject(new Error('no turn'))).catch(() => {
        this.queue.push({ id: `q${this.now().toString(36)}s`, text, images: 0 })
        this.emitQueue()
      })
    }
    // (the turn may already have ended while the answer was written)
    if (!this.openRequests().length && this.turn === 'needs') this.setTurn('working', this.currentActivity())
    return summary
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (this.bypass) throw new HiveError('bad_request', 'This chat runs without asking (Settings › Permissions)')
    if (!CODEX_MODES.some((m) => m.value === mode)) throw new HiveError('bad_request', 'Codex has no such mode')
    // the next turn carries it (turn/start approvalPolicy)
    this.setMeta({ permissionMode: mode })
  }

  async setModel(model: string): Promise<void> {
    this.chosenModel = model
    this.setMeta({ model })
  }

  async toTerminal(_force = false): Promise<void> {
    void _force
    throw new HiveError('bad_request', 'Codex chats have no terminal view yet')
  }
  async toChat(_force = false): Promise<void> {
    void _force // always a chat
  }
}
