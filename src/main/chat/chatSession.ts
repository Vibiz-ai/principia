/**
 * CHAT-UI.md §3: one Claude conversation shown as a chat. To SessionManager it is just the session's "pty" (PtyLike):
 * the Session row, live tree, memory grant, reaper and kill path are unchanged. Inside, one owner process at a time:
 *  - chat mode: a long-lived `claude -p` stream-json process (asleep after 10 idle minutes, woken by the next send);
 *  - terminal mode: the real TUI in a node-pty, resuming the same conversation id (the Terminal toggle).
 * No Electron imports (testable with fakes).
 */
import type { Id } from '../../shared/types'
import type { ChatDecision, ChatImage, ChatItem, ChatMeta, ChatMode, ChatOp, ChatQueued, ChatSnapshot, ChatTurn } from '../../shared/chat'
import { EMPTY_CHAT_META } from '../../shared/chat'
import { ChatReducer } from '../../shared/chatReduce'
import { permissionTitle, toolLine } from '../../shared/toolVerbs'
import type { AskOption } from '../../shared/live'
import { HiveError } from '../../shared/errors'
import type { PtyLike, PtySpawn } from '../sessions'
import { StreamProc, type ChildSpawn } from './streamProc'
import { toChatArgs, toTerminalArgs, withChoices, withConversation, withoutPrompt } from './chatArgs'

export const CHAT_IDLE_MS = 10 * 60_000
const STOP_WAIT_MS = 2000
/** after an interrupt is acknowledged: a CLI that was not mid-turn sends no result, so the turn ends here */
export const STOP_SETTLE_MS = 2500

export interface ChatAskBridge {
  /** a permission / question / plan request opened: it becomes a Needs-you ask (channel stdio) */
  open(e: { requestId: string; toolName: string; input: unknown; description: string | null; toolUseId: string | null; title?: string; options?: AskOption[] }): void
  /** answered in the chat (summary) or gone (null = canceled) */
  close(requestId: string, summary: string | null): void
  /** the turn was interrupted (the CLI fires no Stop hook then): the live tree goes idle */
  stopped?(): void
  /** a chat turn started (the live tree works even when no UserPromptSubmit hook line comes) */
  working?(): void
  /**
   * a turn ended with its result and the chat is still idle a moment later: the live tree goes idle with this report
   * when the Stop hook did not already do it (a hook can be late, missing or turned off)
   */
  turnEnded?(report: string | null): void
}

/** how long a finished turn waits for the CLI's own Stop hook before the chat settles the live tree itself */
export const TURN_END_SETTLE_MS = 1500

export interface ChatSessionDeps {
  sessionId: Id
  file: string
  /** the terminal pane's argv from engine.providers.interactiveSpawn */
  interactiveArgs: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  mode: ChatMode
  spawnPty: PtySpawn
  spawnChild: ChildSpawn
  killGroup(pid: number, signal: NodeJS.Signals): boolean
  /** the reaper follows the current leader (CONTRACT §13) */
  registerPid?(pid: number): void
  /** item / state ops for the renderer (the hub batches, numbers and redacts them) */
  emit(ops: ChatOp[]): void
  asks?: ChatAskBridge
  /** the live tracker says the terminal's turn is still running (Terminal -> Chat waits for it) */
  terminalWorking?(): boolean
  /** Claude's own transcript records for this conversation (replay on resume and on hand-back) */
  transcript?(conversationId: string): unknown[]
  onModeChanged?(mode: ChatMode): void
  /** the conversation exists now (first message taken): Restart resumes it */
  onConversation?(id: string): void
  /** the chat's first user message (a default session title becomes it: chats can be found again) */
  onTitle?(text: string): void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
  idleMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

type ExitCb = (e: { exitCode: number; signal?: number }) => void

export class ChatSession implements PtyLike {
  /** SessionManager kills it through kill(), never by signalling a (possibly stale) pid group */
  readonly selfKill = true
  mode: ChatMode
  turn: ChatTurn = 'starting'
  activity: string | null = null
  turnStartedAt: number | null = null
  meta: ChatMeta = { ...EMPTY_CHAT_META }
  queue: ChatQueued[] = []
  note: string | null = null
  private images = new Map<string, ChatImage[]>()
  private reducer: ChatReducer
  private proc: StreamProc | null = null
  private ready = false
  private term: PtyLike | null = null
  private lastPid = 0
  private dataCbs: ((d: string) => void)[] = []
  private exitCbs: ExitCb[] = []
  private ended = false
  private exitFired = false
  /** the process is being stopped on purpose (sleep, hand-off): its exit is not a crash */
  private stopping = false
  private holdQueue = false
  private idleTimer: unknown = null
  private typed = ''
  private promptPending: string | null
  private started: boolean
  private convId: string | null
  private pendingMode: string | null = null
  private pendingModel: string | null = null
  private crashes = 0
  /** the model the user picked (carried into the terminal and the next chat process) */
  private chosenModel: string | null = null
  private titled = false
  /** one retry with --session-id / --resume swapped when the CLI disagrees about the conversation existing */
  private argRetry = 0
  private stopTimer: unknown = null
  readonly bypass: boolean
  readonly startedAs: ChatMode

  constructor(private d: ChatSessionDeps) {
    const parsed = toChatArgs(d.interactiveArgs)
    this.convId = parsed.id
    this.started = parsed.resumed
    this.promptPending = parsed.prompt
    this.bypass = d.interactiveArgs.includes('--dangerously-skip-permissions')
    this.meta.bypass = this.bypass
    this.mode = d.mode
    this.startedAs = d.mode
    this.reducer = new ChatReducer({ now: () => this.now(), idPrefix: '' })
    if (this.started && this.convId) this.replayInto(this.convId, 'Resumed this conversation')
    this.maybeTitle()
    if (d.mode === 'terminal') this.startTerminal()
    else this.startChat()
  }

  // ---------- PtyLike ----------
  get pid(): number {
    return this.term?.pid ?? this.proc?.pid ?? this.lastPid
  }
  onData(cb: (d: string) => void): unknown {
    this.dataCbs.push(cb)
    return { dispose: () => (this.dataCbs = this.dataCbs.filter((x) => x !== cb)) }
  }
  onExit(cb: ExitCb): unknown {
    this.exitCbs.push(cb)
    return { dispose: () => (this.exitCbs = this.exitCbs.filter((x) => x !== cb)) }
  }
  /** Terminal: keystrokes. Chat: Hive-typed replies (agents:reply, limit resume) — text, then "\r" submits it. */
  write(data: string): void {
    if (this.mode === 'terminal') {
      this.term?.write(data)
      return
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const t = this.typed.trim()
        this.typed = ''
        if (t) void this.send(t).catch(() => undefined)
      } else if (ch >= ' ') this.typed += ch
    }
  }
  resize(cols: number, rows: number): void {
    this.d.cols = cols
    this.d.rows = rows
    try {
      this.term?.resize(cols, rows)
    } catch {
      /* pty gone */
    }
  }
  /** The session ends (Kill, quit, Cmd+W): stop whatever runs, then report exit once. */
  kill(signal?: string): void {
    if (this.exitFired) return
    this.ended = true
    this.clearIdle()
    const sig = (signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM') as NodeJS.Signals
    let waiting = false
    if (this.proc && !this.proc.exited) {
      waiting = true
      this.proc.end()
      if (!this.d.killGroup(this.proc.pid, sig)) this.proc.child.kill(sig)
    }
    if (this.term) {
      waiting = true
      if (!this.d.killGroup(this.term.pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGHUP')) {
        try {
          this.term.kill('SIGHUP')
        } catch {
          /* gone */
        }
      }
    }
    if (!waiting) this.fireExit(0, undefined)
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
  private emit(ops: ChatOp[]): void {
    if (ops.length) this.d.emit(ops)
  }
  private setTurn(turn: ChatTurn, activity?: string | null): void {
    const t0 = turn === 'working' || turn === 'needs' ? (this.turnStartedAt ?? this.now()) : null
    const changed = turn !== this.turn || (activity !== undefined && activity !== this.activity) || t0 !== this.turnStartedAt
    const began = turn === 'working' && this.turn !== 'working' && this.turn !== 'needs'
    this.turn = turn
    if (activity !== undefined) this.activity = activity
    this.turnStartedAt = t0
    if (changed) this.emit([{ op: 'state', turn, activity: this.activity, turnStartedAt: t0, note: this.note }])
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
    this.emit([{ op: 'meta', meta: diff }])
  }
  private emitQueue(): void {
    this.emit([{ op: 'queue', queue: this.queue.map((q) => ({ ...q })) }])
  }

  snapshot(seq: number): Omit<ChatSnapshot, 'sessionId'> {
    return {
      mode: this.mode,
      available: true,
      turn: this.turn,
      activity: this.activity,
      turnStartedAt: this.turnStartedAt,
      items: this.reducer.model.items.slice(),
      queue: this.queue.map((q) => ({ ...q })),
      meta: { ...this.meta },
      seq,
      note: this.note,
      startedAs: this.startedAs
    }
  }
  get items(): readonly ChatItem[] {
    return this.reducer.model.items
  }
  get conversationId(): string | null {
    return this.convId
  }
  /** open permission / question / plan request ids */
  openRequests(): string[] {
    return this.reducer.model.items.flatMap((i) => ((i.kind === 'permission' || i.kind === 'question' || i.kind === 'plan') && i.state === 'open' ? [i.requestId] : []))
  }

  // ---------- chat process ----------
  private startChat(): void {
    if (this.ended) return
    const base = withChoices(withConversation(withoutPrompt(this.d.interactiveArgs), this.started), this.choices())
    const { args } = toChatArgs(base)
    this.ready = false
    this.stopping = false
    this.setTurn('starting', 'Starting Claude')
    let child
    try {
      child = this.d.spawnChild(this.d.file, args, { cwd: this.d.cwd, env: this.d.env })
    } catch (e) {
      this.emit(this.reducer.notice(`Claude could not start: ${e instanceof Error ? e.message : String(e)}`, 'error', 'openTerminal'))
      this.setTurn('error', null)
      return
    }
    const proc = new StreamProc(child, {
      onLine: (o) => this.onLine(proc, o),
      onExit: (code, signal) => this.onProcExit(proc, code, signal),
      setTimer: this.d.setTimer,
      clearTimer: this.d.clearTimer
    })
    this.proc = proc
    this.lastPid = proc.pid || this.lastPid
    if (proc.pid) this.d.registerPid?.(proc.pid)
    void proc.request('initialize', {}, 60_000).then(
      (r) => this.onInitialized(proc, r),
      (e) => {
        if (this.proc !== proc || proc.exited) return
        this.d.log?.warn('chat: initialize failed', { error: String(e) })
        this.emit(this.reducer.notice('Claude did not answer. Try again, or open it in the terminal.', 'error', 'openTerminal'))
        this.setTurn('error', null)
      }
    )
  }

  private onInitialized(proc: StreamProc, r: Record<string, unknown>): void {
    if (this.proc !== proc || proc.exited) return
    this.ready = true
    this.crashes = 0
    this.argRetry = 0
    const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])
    const s = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    const acct = (r.account ?? {}) as Record<string, unknown>
    this.setMeta({
      commands: arr(r.commands).map((c) => ({ name: s(c.name) ?? '', description: (s(c.description) ?? '').slice(0, 200), argumentHint: s(c.argumentHint) ?? s(c.argument_hint) })).filter((c) => c.name),
      models: arr(r.models).map((m) => ({ value: s(m.value) ?? '', label: s(m.displayName) ?? s(m.value) ?? '', description: s(m.description) })).filter((m) => m.value),
      agents: arr(r.agents).map((a) => s(a.name) ?? '').filter(Boolean),
      permissionMode: this.bypass ? 'bypassPermissions' : (s(r.current_permission_mode) ?? this.meta.permissionMode),
      cliVersion: s(r.claude_code_version),
      // the chip shows the profile's model (or the CLI default) until the first turn names the real one
      model: this.chosenModel ?? this.meta.model ?? argAfter(this.d.interactiveArgs, '--model') ?? 'default',
      // only the plan name: never the account email
      plan: s(acct.subscriptionType)
    })
    if (this.pendingMode) void this.setPermissionMode(this.pendingMode).catch(() => undefined)
    if (this.pendingModel) void this.setModel(this.pendingModel).catch(() => undefined)
    this.setTurn('idle', null)
    if (this.promptPending) {
      const p = this.promptPending
      this.promptPending = null
      this.writeUser(p, [])
    } else this.flushQueue()
    if (this.turn === 'idle') this.armIdle()
    void this.refreshContext()
  }

  private async refreshContext(): Promise<void> {
    const p = this.proc
    if (!p || !this.ready) return
    try {
      const u = await p.request('get_context_usage')
      if (typeof u.percentage === 'number') this.setMeta({ contextPct: Math.round(u.percentage) })
    } catch {
      /* older CLI: no meter */
    }
  }

  private onLine(proc: StreamProc, o: Record<string, unknown>): void {
    if (this.proc !== proc) return
    const type = o.type
    if (type === 'control_cancel_request') {
      // the CLI withdrew a permission prompt (the tool was canceled): its card must not stay clickable
      const rid = typeof o.request_id === 'string' ? o.request_id : null
      const it = rid ? this.openItem(rid) : null
      if (it && rid) {
        this.emit(this.reducer.set(it.id, { state: 'expired' }))
        try {
          this.d.asks?.close(rid, null)
        } catch {
          /* ignore */
        }
        if (!this.openRequests().length && this.turn === 'needs') this.setTurn('working', this.currentActivity())
      }
      return
    }
    if (type === 'control_request') {
      const req = (o.request ?? {}) as Record<string, unknown>
      const rid = typeof o.request_id === 'string' ? o.request_id : null
      if (!rid) return
      if (req.subtype !== 'can_use_tool') {
        proc.respondError(rid, 'unsupported in Principia')
        return
      }
      this.emit(this.reducer.line(o))
      const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'tool'
      const perm = this.reducer.model.items.find((i) => i.kind === 'permission' && i.requestId === rid)
      this.d.asks?.open({
        requestId: rid,
        toolName,
        input: req.input ?? {},
        description: typeof req.description === 'string' ? req.description : null,
        toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : null,
        // Needs you, the Chats list and the status line read like the chat card, never "Write /private/…"
        ...(perm?.kind === 'permission'
          ? {
              title: permissionTitle(toolName, req.input ?? {}),
              options: [
                { id: 'allow', label: 'Allow', kind: 'allow' as const },
                ...perm.suggestions.map((sg, i) => ({ id: `sug_${i}`, label: plainLabel(sg.label), kind: 'allow_step' as const })),
                { id: 'deny', label: 'Deny', kind: 'deny' as const }
              ]
            }
          : {})
      })
      this.setTurn('needs', 'Waiting for you')
      return
    }
    const ops = this.reducer.line(o)
    this.emit(ops)
    if (Object.keys(this.reducer.meta).length) {
      this.setMeta(this.reducer.meta)
      this.reducer.meta = {}
    }
    if (type === 'user' && o.isReplay === true && !this.started && this.convId) {
      this.started = true
      this.d.onConversation?.(this.convId)
    }
    if (type === 'user' && o.isReplay !== true) this.maybeTitle()
    if (type === 'result') {
      if (o.subtype === 'error_during_execution') this.d.asks?.stopped?.()
      this.onTurnEnd()
      if (this.d.asks?.turnEnded) {
        const report = typeof o.result === 'string' && o.result.trim() ? o.result : null
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
      return
    }
    // a replayed user line is not a turn: set_model after a turn replays "<local-command-stdout>Set model…" with no
    // result, which used to leave the chat "Working…" for good. Our own sends set working in writeUser.
    if (type === 'stream_event' || type === 'assistant') {
      this.clearIdle()
      if (this.openRequests().length) this.setTurn('needs', 'Waiting for you')
      else this.setTurn('working', this.currentActivity())
    }
  }

  private currentActivity(): string {
    const items = this.reducer.model.items
    for (let i = items.length - 1; i >= 0 && i >= items.length - 30; i--) {
      const it = items[i]!
      if (it.kind === 'tool' && (it.status === 'running' || it.status === 'pending')) {
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
    this.emit(this.reducer.settle('expired'))
    this.setTurn('idle', null)
    void this.refreshContext()
    if (!this.holdQueue) this.flushQueue()
    if (this.turn === 'idle') this.armIdle()
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.ended || this.mode !== 'chat') return
    this.idleTimer = this.timer(() => {
      this.idleTimer = null
      if (this.turn !== 'idle' || this.queue.length || !this.proc) return
      this.stopping = true
      this.proc.end()
    }, this.d.idleMs ?? CHAT_IDLE_MS)
  }

  private onProcExit(proc: StreamProc, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc !== proc) return
    this.proc = null
    this.ready = false
    this.clearIdle()
    if (this.ended) {
      this.fireExit(code ?? 0, signal ? 1 : undefined)
      return
    }
    const planned = this.stopping
    this.stopping = false
    this.clearStopTimer()
    const wasTurn = this.turn === 'working' || this.turn === 'needs'
    this.closeOpenAsks()
    this.emit(this.reducer.settle(planned ? 'expired' : 'interrupted'))
    if (planned) {
      this.setTurn('sleeping', null)
      return
    }
    const why = proc.stderrTail.trim().split('\n').filter(Boolean).pop() ?? ''
    // the CLI disagrees about the conversation existing (a terminal that never got a message, a TUI that did): swap
    // --resume / --session-id once and start again
    if (!this.ready && this.argRetry < 1 && this.convId) {
      const swap = /no conversation found/i.test(why) ? false : /already in use/i.test(why) ? true : null
      if (swap !== null && swap !== this.started) {
        this.argRetry++
        this.started = swap
        this.d.log?.warn('chat: retrying with the other conversation flag', { started: swap })
        this.startChat()
        return
      }
    }
    // Kill and quit go through kill() (ended above): any other exit, a signal included, is a crash the chat survives
    this.crashes++
    if (wasTurn) {
      try {
        this.d.asks?.stopped?.()
      } catch {
        /* ignore */
      }
    }
    this.d.log?.warn('chat: claude exited', { code, signal, stderr: why.slice(0, 300) })
    this.emit(this.reducer.notice(
      /login|auth|api key|credential/i.test(why)
        ? 'Claude needs you to sign in. Open the terminal and run /login.'
        : `Claude stopped unexpectedly${why ? `: ${why.slice(0, 160)}` : ''}. Send a message to pick up where it left off.`,
      'error',
      /login|auth|api key|credential/i.test(why) || this.crashes >= 3 ? 'openTerminal' : 'retry'
    ))
    this.setTurn('sleeping', null)
  }

  /** Every open request is answered or expired: the Needs-you asks close with it. */
  private closeOpenAsks(): void {
    for (const rid of this.openRequests()) {
      try {
        this.d.asks?.close(rid, null)
      } catch {
        /* never block the chat on live state */
      }
    }
  }

  private openItem(requestId: string): ChatItem | null {
    return this.reducer.model.items.find((i) => (i.kind === 'permission' || i.kind === 'question' || i.kind === 'plan') && i.requestId === requestId && i.state === 'open') ?? null
  }

  /** The first thing the user said becomes the session's title (once). */
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

  private choices(): { model: string | null; permissionMode: string | null } {
    return { model: this.chosenModel, permissionMode: this.bypass ? null : this.meta.permissionMode }
  }

  private clearStopTimer(): void {
    if (this.stopTimer) this.clear(this.stopTimer)
    this.stopTimer = null
  }

  // ---------- user actions ----------
  private writeUser(text: string, images: ChatImage[]): void {
    const p = this.proc
    if (!p || !p.alive) return
    const content = images.length
      ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })), { type: 'text', text }]
      : text
    const thumbs = images.map((im) => im.thumb).filter((t): t is string => !!t)
    this.emit(this.reducer.userSent(text, images.length, 'sent', undefined, thumbs))
    this.maybeTitle()
    p.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
    this.clearIdle()
    this.setTurn('working', 'Thinking')
  }

  private flushQueue(): void {
    if (!this.queue.length || !this.proc?.alive || !this.ready || this.turn !== 'idle') return
    const q = this.queue
    this.queue = []
    const images = q.flatMap((x) => this.images.get(x.id) ?? [])
    for (const x of q) this.images.delete(x.id)
    this.emitQueue()
    this.writeUser(q.map((x) => x.text).join('\n\n'), images)
  }

  async send(text: string, images: ChatImage[] = []): Promise<void> {
    if (this.ended) throw new HiveError('conflict', 'This chat has ended. Restart it to continue.')
    if (this.mode === 'terminal') throw new HiveError('conflict', 'This conversation is open in the terminal')
    const t = text.trim()
    if (!t && !images.length) return
    // the composer under an open card: the words answer it ("Answer above, or tell Claude something else")
    const open = this.openRequests()
    if (t && !images.length && open.length && this.proc?.alive) {
      const it = this.openItem(open[open.length - 1]!)
      if (it?.kind === 'permission') return void this.answer(it.requestId, { kind: 'deny', message: t })
      if (it?.kind === 'question') return void this.answer(it.requestId, { kind: 'answer', answers: { [it.questions[0]?.question ?? 'answer']: t } })
      if (it?.kind === 'plan') return void this.answer(it.requestId, { kind: 'rejectPlan', message: t })
    }
    this.holdQueue = false
    if (this.ready && this.proc?.alive && this.turn === 'idle' && !this.queue.length) {
      this.writeUser(t, images)
      return
    }
    // Principia holds follow-ups while Claude works (editable; sent together when the turn ends)
    const id = this.reducer.newId('q')
    this.queue.push({ id, text: t, images: images.length })
    if (images.length) this.images.set(id, images)
    this.emitQueue()
    if (!this.proc) this.startChat()
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

  /** Stop (Esc): the turn stops, the process stays. sendNow: the queue goes right after. */
  async interrupt(sendNow = false): Promise<void> {
    if (this.mode !== 'chat') return
    this.holdQueue = !sendNow
    const p = this.proc
    if (!p || !this.ready) {
      if (sendNow) this.flushQueue()
      return
    }
    if (this.turn !== 'working' && this.turn !== 'needs') {
      if (sendNow) this.flushQueue()
      return
    }
    const rids = this.openRequests()
    this.closeOpenAsks()
    for (const rid of rids) {
      p.respond(rid, { behavior: 'deny', message: 'Interrupted by the user' })
      // the card closes now (no dead Allow buttons); its tool reads "Didn't …", not "Created …"
      const it = this.openItem(rid)
      if (it) this.emit(this.reducer.set(it.id, it.kind === 'permission' ? { state: 'denied', outcome: 'Stopped' } : it.kind === 'question' ? { state: 'skipped' } : { state: 'rejected' }))
    }
    this.setTurn('working', 'Stopping')
    try {
      await p.request('interrupt')
    } catch (e) {
      this.d.log?.warn('chat: interrupt failed', { error: String(e) })
    }
    // an interrupt the CLI acknowledges while not mid-turn ends nothing: never stay "Stopping…"
    this.clearStopTimer()
    this.stopTimer = this.timer(() => {
      this.stopTimer = null
      if (this.proc !== p || p.exited || (this.turn !== 'working' && this.turn !== 'needs')) return
      this.emit(this.reducer.settle('interrupted'))
      this.emit(this.reducer.notice('Stopped. Claude kept everything up to here.'))
      this.d.asks?.stopped?.()
      this.onTurnEnd()
    }, STOP_SETTLE_MS)
  }

  /** A permission, question or plan card was answered (in the chat, or from Needs you). Returns the summary. */
  answer(requestId: string, decision: ChatDecision, via: 'chat' | 'needs' = 'chat'): string {
    const item = this.reducer.model.items.find((i) => (i.kind === 'permission' || i.kind === 'question' || i.kind === 'plan') && i.requestId === requestId)
    if (!item || (item.kind !== 'permission' && item.kind !== 'question' && item.kind !== 'plan')) throw new HiveError('not_found', 'That request is gone')
    if (item.state !== 'open') throw new HiveError('conflict', 'Already answered')
    const p = this.proc
    if (!p?.alive) throw new HiveError('conflict', 'Claude is no longer waiting')
    const where = via === 'needs' ? ' from Needs you' : ''
    let summary: string
    let response: Record<string, unknown>
    let set: Partial<ChatItem>
    if (item.kind === 'permission') {
      if (decision.kind === 'allow' || decision.kind === 'allowAlways') {
        const sug = decision.kind === 'allowAlways' ? item.suggestions[decision.suggestion] : undefined
        response = { behavior: 'allow', updatedInput: item.input, ...(sug ? { updatedPermissions: [sug.raw] } : {}) }
        summary = sug ? `${plainLabel(sug.label).replace(/^Always allow/, 'Always allowed').replace(/^Allow /, 'Allowed ')}${where}` : `Allowed${where}`
        set = { state: 'allowed', outcome: summary }
      } else if (decision.kind === 'deny') {
        const msg = decision.message?.trim()
        response = { behavior: 'deny', message: msg || 'The user denied this in Principia. Do not retry it; ask what to do instead if unsure.' }
        summary = msg ? `Denied${where}: ${msg}` : `Denied${where}`
        set = { state: 'denied', outcome: summary }
      } else throw new HiveError('bad_request', 'Choose Allow or Deny')
    } else if (item.kind === 'question') {
      if (decision.kind === 'answer') {
        response = { behavior: 'allow', updatedInput: { ...item.input, answers: decision.answers } }
        summary = `Answered${where}: ${Object.values(decision.answers).join(', ')}`
        set = { state: 'answered', answers: decision.answers }
      } else if (decision.kind === 'skip' || decision.kind === 'deny') {
        response = { behavior: 'deny', message: 'The user skipped this question.' }
        summary = `Skipped${where}`
        set = { state: 'skipped' }
      } else throw new HiveError('bad_request', 'Pick an answer')
    } else {
      if (decision.kind === 'approvePlan' || decision.kind === 'allow') {
        response = { behavior: 'allow', updatedInput: item.input }
        summary = `Plan approved${where}`
        set = { state: 'approved' }
      } else if (decision.kind === 'rejectPlan' || decision.kind === 'deny') {
        const msg = 'message' in decision ? decision.message?.trim() : ''
        response = { behavior: 'deny', message: msg || 'Keep planning: the user did not approve this plan yet.' }
        summary = `Kept planning${where}`
        set = { state: 'rejected' }
      } else throw new HiveError('bad_request', 'Approve or keep planning')
    }
    if (!p.respond(requestId, response)) throw new HiveError('conflict', 'Claude is no longer waiting')
    this.emit(this.reducer.set(item.id, set))
    try {
      this.d.asks?.close(requestId, summary)
    } catch {
      /* ignore */
    }
    if (item.kind === 'plan' && decision.kind === 'approvePlan' && decision.acceptEdits) void this.setPermissionMode('acceptEdits').catch(() => undefined)
    if (!this.openRequests().length) this.setTurn('working', this.currentActivity())
    return summary
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (this.bypass) throw new HiveError('bad_request', 'This chat runs without asking (Settings › Permissions)')
    if (!this.proc?.alive || !this.ready) {
      this.pendingMode = mode
      this.setMeta({ permissionMode: mode })
      return
    }
    this.pendingMode = null
    await this.proc.request('set_permission_mode', { mode })
    this.setMeta({ permissionMode: mode })
  }

  async setModel(model: string): Promise<void> {
    if (!this.proc?.alive || !this.ready) {
      this.chosenModel = model
      this.pendingModel = model
      this.setMeta({ model })
      return
    }
    this.pendingModel = null
    this.chosenModel = model
    await this.proc.request('set_model', { model })
    this.setMeta({ model })
  }

  // ---------- Terminal hand-off (CHAT-UI.md §3.5) ----------
  private waitExit(proc: StreamProc): Promise<void> {
    return new Promise((resolve) => {
      if (proc.exited) return resolve()
      const t = this.timer(() => {
        if (!proc.exited) {
          if (!this.d.killGroup(proc.pid, 'SIGTERM')) proc.child.kill('SIGTERM')
        }
        resolve()
      }, STOP_WAIT_MS)
      proc.child.on('exit', () => {
        this.clear(t)
        resolve()
      })
    })
  }

  async toTerminal(force = false): Promise<void> {
    if (this.ended) throw new HiveError('conflict', 'This chat has ended')
    if (this.mode === 'terminal') return
    if ((this.turn === 'working' || this.turn === 'needs') && !force) throw new HiveError('conflict', 'Claude is working. Stop it and open the terminal?')
    this.clearIdle()
    const p = this.proc
    if (p) {
      if (this.turn === 'working' || this.turn === 'needs') await this.interrupt(false)
      this.stopping = true
      p.end()
      await this.waitExit(p)
    }
    this.proc = null
    this.ready = false
    this.closeOpenAsks()
    this.emit(this.reducer.settle('expired'))
    this.mode = 'terminal'
    this.emit([{ op: 'mode', mode: 'terminal' }])
    this.d.onModeChanged?.('terminal')
    this.startTerminal()
  }

  private startTerminal(): void {
    const args = withChoices(toTerminalArgs(this.d.interactiveArgs, this.started), this.choices())
    if (!this.started) this.promptPending = null // the TUI takes the first message itself
    let pty: PtyLike
    try {
      pty = this.d.spawnPty(this.d.file, args, { name: 'xterm-256color', cols: this.d.cols, rows: this.d.rows, cwd: this.d.cwd, env: this.d.env })
    } catch (e) {
      throw new HiveError('internal', `Could not start the terminal: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.term = pty
    this.lastPid = pty.pid
    this.d.registerPid?.(pty.pid)
    // the TUI writes the conversation only from its first message on: Back to Chat checks the transcript
    if (this.convId && !this.started) this.d.onConversation?.(this.convId)
    this.setTurn('terminal', null)
    pty.onData((data) => {
      if (this.term === pty) for (const cb of this.dataCbs) cb(data)
    })
    pty.onExit(({ exitCode, signal }) => {
      if (this.term !== pty) return // switched back to chat on purpose
      this.term = null
      this.fireExit(exitCode, signal)
    })
  }

  async toChat(force = false): Promise<void> {
    if (this.ended) throw new HiveError('conflict', 'This chat has ended')
    if (this.mode === 'chat') return
    if (!force && this.d.terminalWorking?.()) throw new HiveError('conflict', 'Claude is working in the terminal. Switch when it’s done.')
    const pty = this.term
    this.term = null
    if (pty) {
      await new Promise<void>((resolve) => {
        let done = false
        const fin = (): void => {
          if (done) return
          done = true
          resolve()
        }
        pty.onExit(() => fin())
        if (!this.d.killGroup(pty.pid, 'SIGHUP')) {
          try {
            pty.kill('SIGHUP')
          } catch {
            /* gone */
          }
        }
        this.timer(() => {
          this.d.killGroup(pty.pid, 'SIGKILL')
          fin()
        }, STOP_WAIT_MS)
      })
    }
    this.mode = 'chat'
    // a terminal that never got a message wrote no conversation: the chat starts it (--session-id), never --resume
    if (this.convId && !this.started) this.started = this.conversationExists(this.convId)
    // everything done in the terminal is in Claude's transcript: replay it as cards
    if (this.convId && this.started) this.replayInto(this.convId, this.startedAs === 'terminal' ? 'From the terminal' : 'Back from the terminal')
    this.maybeTitle()
    this.emit([{ op: 'mode', mode: 'chat' }])
    this.d.onModeChanged?.('chat')
    this.startChat()
  }

  private conversationExists(convId: string): boolean {
    if (!this.d.transcript) return true
    try {
      return this.d.transcript(convId).length > 0
    } catch {
      return true
    }
  }

  /** Rebuilds the items from Claude's transcript (resume, hand-back). */
  private replayInto(convId: string, notice: string): void {
    let records: unknown[] = []
    try {
      records = this.d.transcript?.(convId) ?? []
    } catch (e) {
      this.d.log?.warn('chat: transcript replay failed', { error: String(e) })
    }
    const r = new ChatReducer({ now: () => this.now(), idPrefix: `r${this.now().toString(36)}_` })
    for (const rec of records) r.line(rec)
    r.settle('expired')
    if (records.length) r.notice(notice)
    this.reducer = new ChatReducer({ now: () => this.now() }, r.model)
    this.emit([{ op: 'reset', items: r.model.items.slice() }])
  }
}

/** "Always allow `git push` here" -> "Always allow “git push” here" (outcome lines and Needs-you buttons are plain text) */
export function plainLabel(label: string): string {
  return label.replace(/`([^`]*)`/g, '“$1”')
}

function argAfter(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('-') ? args[i + 1]! : null
}

/** Items of a finished conversation (an exited chat session's read-only view). */
export function replayItems(records: unknown[]): ChatItem[] {
  const r = new ChatReducer({ idPrefix: 'h' })
  for (const rec of records) r.line(rec)
  r.settle('expired')
  return r.model.items.slice()
}
