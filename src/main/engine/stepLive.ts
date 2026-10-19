/**
 * One run step's live state (LIVE.md §3, §4.3, §4.4): the root agent + subagent tree (tracker -> sink), the step's
 * LiveChannel (hook lines, ask_user lines, answer files), asks on every channel (stdio / hook_gate / mcp), the
 * allow_step memo, pause/resume of the step timeout while an ask is open, 60-min expiry, cancel, and the
 * close-stdin rule. Owned by the executor; never touches electron or main code.
 */
import type { EngineContext, LiveChannel } from '../../shared/engine'
import { HiveError } from '../../shared/errors'
import type { Ask, AskAnswer, AskOption } from '../../shared/live'
import type { AdapterId, Id } from '../../shared/types'
import { normalizeHook } from './live/hooks'
import {
  allowDecision,
  askUserQuestionAllow,
  claudeControlError,
  claudeControlResponse,
  denyDecision,
  gateDecision
} from './live/claudeControl'
import { createLiveSink, type LiveSink } from './live/sink'
import { ASK_TIMEOUT_MS, createAgentTracker, type AgentTracker } from './live/tracker'
import type { HookEvent, LiveOp } from './live/types'
import type { NormalizedEvent } from './parse'
import type { ProcHandle } from './process'

export interface StepLiveOptions {
  ctx: EngineContext
  provider: AdapterId
  runId: Id
  stepId: Id
  title: string
  cwd: string
  /** Feed parser events to the tracker (false for shell: root only). */
  track: boolean
  /** Open a LiveChannel (hooks / ask_user). */
  channel: boolean
  askTimeoutMs?: number
  geminiAgents?: string[]
  /** Activity line for the root (shell: the command). */
  activity?: string | null
  /** Called on every hook line (stall detection counts hook activity, CONTRACT §13). */
  onActivity?: () => void
}

const repoIdFor = (ctx: EngineContext, cwd: string): Id | null => {
  let best: { id: Id; len: number } | null = null
  try {
    for (const r of ctx.listRepos?.() ?? []) {
      const p = r.path.replace(/\/+$/, '')
      if ((cwd === p || cwd.startsWith(`${p}/`)) && (!best || p.length > best.len)) best = { id: r.id, len: p.length }
    }
  } catch {
    /* no repos */
  }
  return best?.id ?? null
}

export class StepLive {
  readonly tracker: AgentTracker
  readonly sink: LiveSink
  channel: LiveChannel | null = null
  private handle: ProcHandle | null = null
  /** allow_step memo: tool names allowed for the rest of this step (not persisted). */
  private allowed = new Set<string>()
  private timers = new Map<string, NodeJS.Timeout>()
  private paused = false
  private closed = false
  private readonly askTimeoutMs: number

  constructor(private o: StepLiveOptions) {
    this.askTimeoutMs = o.askTimeoutMs ?? ASK_TIMEOUT_MS
    const ctx = o.ctx
    this.tracker = createAgentTracker({
      provider: o.provider,
      root: { kind: 'step', title: o.title, cwd: o.cwd },
      headless: true,
      now: ctx.now,
      askTimeoutMs: this.askTimeoutMs,
      geminiAgents: o.geminiAgents
    })
    this.sink = createLiveSink({
      store: ctx.store,
      emit: (e) => ctx.emit(e),
      redact: (s) => ctx.secrets.redact(s),
      owner: { sessionId: null, runId: o.runId, stepId: o.stepId },
      provider: o.provider,
      cwd: o.cwd,
      repoId: repoIdFor(ctx, o.cwd),
      log: ctx.log
    })
    this.sink.onCloseStdin(() => this.handle?.end())
    const begin = this.tracker.begin()
    if (o.activity) {
      const up = begin.find((x) => x.op === 'agent.upsert')
      if (up && up.op === 'agent.upsert') up.patch.activity = o.activity
    }
    this.sink.apply(begin)
    if (o.channel && ctx.live) {
      try {
        this.channel = ctx.live.open({ stepId: o.stepId, runId: o.runId })
        this.channel.onLine((line) => this.onHookLine(line))
      } catch (e) {
        ctx.log.warn('engine: live channel failed; no hooks/ask_user for this step', { stepId: o.stepId, error: String(e) })
        this.channel = null
      }
    }
  }

  get rootAgentId(): Id {
    return this.sink.rootId
  }

  /** The process is running: stdin control + timeout pausing become possible. */
  attach(handle: ProcHandle): void {
    this.handle = handle
    if (this.tracker.openAsks().length) this.pause()
  }

  /** A parsed stdout event. Returns false when the event was consumed here (not to be shown). */
  stream(ev: NormalizedEvent): void {
    if (this.closed) return
    if (ev.kind === 'control_unknown') {
      this.o.ctx.log.warn('engine: unsupported claude control request', { subtype: ev.subtype })
      this.handle?.write(claudeControlError(ev.requestId))
      return
    }
    if (ev.kind === 'permission_request' && ev.toolName !== 'AskUserQuestion' && this.allowed.has(ev.toolName)) {
      this.handle?.write(claudeControlResponse(ev.requestId, allowDecision(ev.input)))
      return
    }
    if (!this.o.track) return
    this.apply(this.tracker.stream(ev))
  }

  private onHookLine(line: unknown): void {
    if (this.closed) return
    this.o.onActivity?.()
    for (const h of normalizeHook(this.o.provider, line)) this.hook(h)
  }

  hook(h: HookEvent): void {
    if (this.closed) return
    if (h.kind === 'gate' && this.allowed.has(h.name)) {
      this.channel?.writeAnswer(h.gateId, gateDecision(this.o.provider, true))
      return
    }
    this.apply(this.tracker.hook(h))
  }

  private apply(ops: LiveOp[]): void {
    if (!ops.length) return
    this.sink.apply(ops)
    for (const op of ops) {
      if (op.op === 'ask.open') this.armExpiry(op.gateId)
      else if (op.op === 'ask.resolve') this.disarm(op.gateId)
    }
    this.syncPause()
  }

  private syncPause(): void {
    if (this.tracker.openAsks().length) this.pause()
    else this.resume()
  }
  private pause(): void {
    if (this.paused || !this.handle) return
    this.paused = true
    this.handle.pauseTimeout()
  }
  private resume(): void {
    if (!this.paused || !this.handle) return
    this.paused = false
    this.handle.resumeTimeout()
  }

  private armExpiry(gateId: string): void {
    if (this.timers.has(gateId)) return
    const t = setTimeout(() => this.expire(gateId), this.askTimeoutMs)
    t.unref?.()
    this.timers.set(gateId, t)
  }
  private disarm(gateId: string): void {
    const t = this.timers.get(gateId)
    if (t) clearTimeout(t)
    this.timers.delete(gateId)
  }

  /** 60-min expiry: deny on the channel, ask -> expired/timeout (LIVE.md §4.4). */
  private expire(gateId: string): void {
    const a = this.tracker.ask(gateId)
    if (!a) return
    this.closeOnChannel(gateId, 'No answer from the user within 60 min')
    this.apply(this.tracker.expire(gateId))
  }

  /** Writes a "no" to whatever is waiting on this ask (stdio deny, gate deny, mcp null answer). */
  private closeOnChannel(gateId: string, message: string): void {
    const a = this.tracker.ask(gateId)
    if (!a) return
    if (a.channel === 'stdio') this.handle?.write(claudeControlResponse(gateId, denyDecision(message)))
    else if (a.channel === 'hook_gate') this.channel?.writeAnswer(gateId, gateDecision(this.o.provider, false, message))
    else if (a.channel === 'mcp') this.channel?.writeAnswer(gateId, { answer: null, note: 'The user did not answer; continue with your best judgement.' })
  }

  /** Run canceled: deny every open ask first, then the caller kills the tree (LIVE.md §4.4). */
  cancelAsks(message = 'Run canceled'): void {
    for (const a of this.tracker.openAsks()) {
      this.closeOnChannel(a.gateId, message)
      this.apply(this.tracker.cancel(a.gateId))
    }
  }

  owns(askId: Id): boolean {
    return this.sink.gateOf(askId) != null
  }

  /** asks:answer for a run-owned ask (LIVE.md §4.3). */
  answer(askId: Id, a: AskAnswer): Ask {
    const ask = this.sink.ask(askId)
    const gateId = this.sink.gateOf(askId)
    if (!ask || !gateId) throw new HiveError('not_found', `Ask ${askId} not found`)
    const tracked = this.tracker.ask(gateId)
    if (ask.status !== 'open' || !tracked) throw new HiveError('conflict', 'Already answered in the terminal')
    let opt: AskOption | null = null
    if (a.optionId != null) {
      opt = ask.options.find((x) => x.id === a.optionId) ?? null
      if (!opt) throw new HiveError('bad_request', `Option ${a.optionId} was not offered`)
      if (opt.kind === 'focus' || opt.kind === 'allow_always') throw new HiveError('bad_request', `Option ${a.optionId} cannot be answered from Hive`)
    }
    const text = a.text?.trim() || ''
    const message = a.message?.trim() || ''
    let summary: string
    if (ask.kind === 'permission') {
      const kind = opt?.kind ?? (text ? 'deny' : null)
      if (!kind) throw new HiveError('bad_request', 'Choose Allow or Deny')
      const allow = kind === 'allow' || kind === 'allow_step'
      const why = message || text || null
      if (ask.channel === 'stdio') {
        if (!this.write(claudeControlResponse(gateId, allow ? allowDecision(tracked.toolInput) : denyDecision(why)))) throw new HiveError('conflict', 'The step is no longer waiting')
      } else if (ask.channel === 'hook_gate') {
        if (!this.channel) throw new HiveError('conflict', 'The step is no longer waiting')
        this.channel.writeAnswer(gateId, gateDecision(this.o.provider, allow, why))
      } else throw new HiveError('bad_request', 'This ask is answered in the terminal')
      if (kind === 'allow_step' && tracked.toolName) this.allowed.add(tracked.toolName)
      summary = kind === 'allow_step' ? 'Allowed for this step' : allow ? 'Allowed in Hive' : why ? `Denied in Hive: ${why}` : 'Denied in Hive'
    } else if (ask.kind === 'question') {
      const isDeny = opt?.kind === 'deny'
      const answerText = opt?.kind === 'choice' ? opt.label : text
      if (!isDeny && !answerText) throw new HiveError('bad_request', 'The answer is empty')
      if (ask.channel === 'mcp') {
        if (!this.channel) throw new HiveError('conflict', 'The step is no longer waiting')
        this.channel.writeAnswer(gateId, { answer: isDeny ? null : answerText })
      } else if (ask.channel === 'stdio') {
        const d = isDeny ? denyDecision(message || null) : askUserQuestionAllow(tracked.toolInput, answerText)
        if (!this.write(claudeControlResponse(gateId, d))) throw new HiveError('conflict', 'The step is no longer waiting')
      } else throw new HiveError('bad_request', 'This ask is answered in the terminal')
      summary = isDeny ? 'Skipped in Hive' : `Answered: ${answerText}`
    } else throw new HiveError('bad_request', 'Trust prompts are answered in the terminal')
    this.sink.setAnswer(gateId, { ...a, askId })
    this.apply(this.tracker.answered(gateId, summary))
    return this.sink.ask(askId) ?? ask
  }

  /** True while the step waits on the user (an open ask): not stalled, just waiting (CONTRACT §13). */
  waiting(): boolean {
    return !this.closed && this.tracker.openAsks().length > 0
  }

  /** "Stalled?" on the root: ISO start of the silence, or null when activity resumed (CONTRACT §13). */
  setStalled(since: string | null): void {
    if (this.closed && since) return
    this.sink.patchRoot({ stalledSince: since })
    this.sink.flush()
  }

  /** Root activity line set by the executor (wait nodes: "Waiting · try 7 · next in 60 s", AUTHORING.md §7.1). */
  setActivity(activity: string | null): void {
    if (this.closed) return
    this.sink.patchRoot({ activity: activity ? this.o.ctx.secrets.redact(activity) : null })
    this.sink.flush()
  }

  /** The step hit a usage / rate limit (CONTRACT §13). */
  setLimited(resetAt: string | null): void {
    this.sink.patchRoot({ stopReason: 'rate_limited', resetAt })
  }

  private write(s: string): boolean {
    return !!this.handle && this.handle.write(s)
  }

  /** The step ended (process exit or never started). Cancels open asks (A4a), ends the tree, closes the channel. */
  finish(status: 'done' | 'failed' | 'canceled', activity?: string | null): void {
    if (this.closed) return
    this.apply(this.tracker.end(status, activity))
    this.closed = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.sink.flush()
    try {
      this.channel?.close()
    } catch {
      /* best effort; boot sweep removes the dir */
    }
  }
}
