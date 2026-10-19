/**
 * Live state of interactive sessions (docs/LIVE.md §3.2, §3.8, §4, PO amendments A1/A3/A4/A9):
 * - one AgentTracker + LiveApplier per session, fed by hook lines tailed from <liveDir>/events.jsonl;
 * - a quiet-tail PTY detector (300 ms of no output, ANSI-stripped last 4 KB) for trust prompts and the hooks-broken
 *   fallback;
 * - guarded PTY replies (A9): re-detect the prompt right before writing keys, never send keys blind;
 * - idle seen-state (A3): a turn that ends while the pane is visible is never counted as Needs you;
 * - root end closes every open ask at once (A4a).
 * No Electron imports (testable with fakes).
 */
import type { AdapterId, Id, Session } from '../../shared/types'
import type { AgentNode, Ask, AskAnswer } from '../../shared/live'
import type { LiveChannel } from '../../shared/engine'
import { HiveError } from '../../shared/errors'
import { newId } from '../../shared/ids'
import type { LiveStore } from '../db/liveStore'
import { classifyLimitText, classifyStopFailure, createAgentTracker, detectPtyPrompt, normalizeHook, ptyReplyKeys, stripAnsi, type LimitHit, type StallMonitor } from '../engine'
import { LiveApplier, type AgentTracker, type HookEvent, type LiveEmit } from './apply'

export const QUIET_MS = 300
const RAW_TAIL = 16 * 1024
const REPLY_SUBMIT_DELAY_MS = 40

/**
 * Sequences a terminal emulator sends on its own, never typed by the user: focus in/out, mouse reports, cursor-position
 * and device-attribute replies, mode/status reports, window-size reports, OSC color replies, DCS replies (XTVERSION,
 * DECRQSS), kitty keyboard flags, and empty bracketed-paste markers. Mounting, focusing, resizing a pane or replaying
 * its scrollback (which re-runs the agent's old terminal queries) produces only these.
 */
const TERMINAL_REPORT = new RegExp(
  [
    '\\x1b\\[[IO]', // focus in/out (DECSET 1004)
    '\\x1b\\[<\\d+;\\d+;\\d+[mM]', // SGR mouse
    '\\x1b\\[M[\\s\\S]{3}', // X10 mouse
    '\\x1b\\[\\??\\d+(?:;\\d+){1,2}R', // CPR / DECXCPR
    '\\x1b\\[[?>=][\\d;]*c', // DA1 / DA2 / DA3 replies
    '\\x1b\\[\\??\\d+(?:;\\d+)*n', // DSR status reports
    '\\x1b\\[\\??[\\d;]+\\$y', // DECRPM mode reports
    '\\x1b\\[\\?\\d*u', // kitty keyboard flags
    '\\x1b\\[\\d+(?:;\\d+)+t', // window size/position reports
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC replies (colors, palette)
    '\\x1bP[\\s\\S]*?\\x1b\\\\', // DCS replies (XTVERSION, DECRQSS, DA3)
    '\\x1b\\[20[01]~' // bracketed-paste markers (a real paste keeps its text after these are removed)
  ].join('|'),
  'g'
)

/** True when `data` is only terminal-generated reports (LIVE.md A4b: not the user typing). */
export function isTerminalReport(data: string): boolean {
  return data.replace(TERMINAL_REPORT, '').length === 0
}

export interface SessionLiveDeps {
  store: LiveStore
  emit(e: LiveEmit): void
  /** Write to the session's PTY (never counted as user input). */
  writePty(sessionId: Id, data: string): void
  /** Window focused AND this session's pane is the visible owner (ui:visibleOwner). */
  isVisible(sessionId: Id): boolean
  onAsk?(ask: Ask, change: 'opened' | 'resolved'): void
  /** A turn ended while unseen (A3); turnMs = how long the turn ran. */
  onIdle?(root: AgentNode, turnMs: number): void
  /** Needs-you count may have changed (badge, tray). */
  onNeedsChanged?(): void
  /** CONTRACT §13: "Stalled?" for working session roots (no PTY output and no hook line for Settings.stallMinutes). */
  stall?: StallMonitor
  /** CONTRACT §13: the session's CLI said it hit a usage / rate limit (once per episode). */
  onLimit?(root: AgentNode, hit: LimitHit): void
  /** CONTRACT §13: the limit episode ended (the user typed, a new turn started, the pane exited). */
  onLimitCleared?(sessionId: Id): void
  /** CONTRACT §13: a root became stalled (since = ISO) or recovered (null). */
  onStalled?(root: AgentNode, since: string | null): void
  now?: () => Date
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

/** TUI chrome that is never the agent talking: composer, footers, hints, spinners. */
const CHROME = /^(?:>|❯|\$|\?\s*for shortcuts)|Type your message|for shortcuts|esc to (?:interrupt|cancel)|Add a follow-up|Plan, search, build anything|auto-accept edits|bypass permissions|ctrl\+[a-z] to/i

/**
 * What the agent last printed, from the ANSI-stripped PTY tail: the last few lines that are not TUI chrome (box
 * borders, composer, footers). Fallback for the idle row's "what the agent said" when no hook carried the text.
 */
export function screenMessage(raw: string, maxLines = 8, maxChars = 800): string | null {
  const lines = stripAnsi(raw.slice(-8192))
    .split('\n')
    .map((l) => l.replace(/[│╭╮╰╯─━┃┏┓┗┛═║╔╗╚╝▐▛▜▌▝▘█]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l && /[\p{L}\p{N}]/u.test(l) && !CHROME.test(l))
  const out: string[] = []
  for (const l of lines.slice(-maxLines)) if (out[out.length - 1] !== l) out.push(l)
  const text = out.join('\n').replace(/^⏺\s*/gm, '')
  if (!text) return null
  return text.length > maxChars ? `…${text.slice(text.length - maxChars + 1)}` : text
}

/** Index of the last full-screen clear (ED 2/3 or RIS) in a chunk, or -1. */
function lastClear(data: string): number {
  const re = /\x1b\[[23]J|\x1bc/g
  let at = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(data))) at = m.index
  return at
}

/** One interactive session's live wiring. */
export class SessionLive {
  readonly root: AgentNode
  readonly tracker: AgentTracker
  readonly applier: LiveApplier
  private raw = ''
  private quietTimer: unknown = null
  private turnStartedAt: number | null = null
  private ended = false

  constructor(
    private d: SessionLiveDeps,
    readonly session: Pick<Session, 'id' | 'adapter' | 'repoId' | 'cwd' | 'title'>,
    private channel: LiveChannel | null
  ) {
    const now = d.now ?? (() => new Date())
    const ts = now().toISOString()
    const rootId = newId('agent')
    this.root = d.store.insertAgent({
      id: rootId,
      kind: 'session',
      parentId: null,
      rootId,
      sessionId: session.id,
      runId: null,
      stepId: null,
      provider: session.adapter,
      repoId: session.repoId,
      cwd: session.cwd,
      title: session.title,
      agentType: null,
      externalId: null,
      toolUseId: null,
      model: null,
      depth: 0,
      background: false,
      attribution: 'exact',
      status: 'starting',
      needs: null,
      seen: false,
      activity: null,
      lastTool: null,
      toolCount: 0,
      memReads: 0,
      filesTouched: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      modelUsage: null,
      report: null,
      startedAt: ts,
      updatedAt: ts,
      endedAt: null
    })
    this.tracker = createAgentTracker({
      provider: session.adapter,
      root: { kind: 'session', title: session.title, cwd: session.cwd },
      headless: false,
      now
    })
    this.applier = new LiveApplier({
      store: d.store,
      root: this.root,
      emit: d.emit,
      now,
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
      onAsk: (a, c) => {
        d.onAsk?.(a, c)
        d.onNeedsChanged?.()
      },
      beforeRootPatch: (p, cur) => this.rootPatch(p, cur)
    })
    this.applier.apply(this.tracker.begin())
    this.applier.touched(this.root.id)
    channel?.onLine((line) => this.onLine(line))
    // CONTRACT §13: only a root that is working can stall; idle / needs-you sessions wait on the user
    d.stall?.track(session.id, {
      waiting: () => d.store.getAgent(this.root.id)?.status !== 'working',
      onChange: (since) => {
        if (this.ended && since) return
        const r = d.store.updateAgent(this.root.id, { stalledSince: since })
        this.applier.touched(r.id)
        d.onStalled?.(r, since)
      }
    })
  }

  /** Banner of the last cleared limit episode: a later screen redraw of that old line never re-flags the session. */
  private clearedBanner: string | null = null

  /** CONTRACT §13: record a usage-limit hit on the root (no-op when the same episode is already recorded). */
  private limited(hit: LimitHit | null, fromScreen = false): void {
    if (!hit || this.ended) return
    const r = this.d.store.getAgent(this.root.id)
    if (!r) return
    if (fromScreen) {
      // a limit ends the turn: a screen banner while the agent works is old scrollback being redrawn
      if (r.status === 'working') return
      if (this.clearedBanner === `${hit.message}|${hit.resetAt ?? ''}`) return
    }
    this.lastBanner = `${hit.message}|${hit.resetAt ?? ''}`
    if (r.stopReason === 'rate_limited' && (r.resetAt ?? null) === (hit.resetAt ?? r.resetAt ?? null)) return
    const first = r.stopReason !== 'rate_limited'
    const u = this.d.store.updateAgent(r.id, { stopReason: 'rate_limited', resetAt: hit.resetAt ?? r.resetAt ?? null })
    this.applier.touched(u.id)
    if (first) this.d.onLimit?.(u, hit)
  }

  private lastBanner: string | null = null

  /** CONTRACT §13: the limit episode is over (the user typed or a new turn started). */
  private clearLimit(): void {
    const r = this.d.store.getAgent(this.root.id)
    if (!r || (r.stopReason == null && r.retryAt == null)) return
    this.clearedBanner = this.lastBanner
    const u = this.d.store.updateAgent(r.id, { stopReason: null, resetAt: null, retryAt: null })
    this.applier.touched(u.id)
    this.d.onLimitCleared?.(this.session.id)
  }

  /** CONTRACT §13 "Retry at reset" for a session: pending resume time on the root (null = none). */
  setRetryAt(at: string | null): void {
    if (this.ended) return
    const u = this.d.store.updateAgent(this.root.id, { retryAt: at })
    this.applier.touched(u.id)
    this.applier.flush()
  }

  /** The root is (still) limited: the resume may type into the pane. */
  isLimited(): boolean {
    return this.d.store.getAgent(this.root.id)?.stopReason === 'rate_limited'
  }

  /** Resume a limited session: types "continue" and submits (separate writes, like agents:reply). */
  resume(text = 'continue'): void {
    if (this.ended) throw new HiveError('conflict', 'This session has ended')
    this.d.writePty(this.session.id, text)
    this.raw = ''
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    set(() => this.d.writePty(this.session.id, '\r'), REPLY_SUBMIT_DELAY_MS)
    this.clearLimit()
    this.feed({ kind: 'user_input' })
    this.applier.flush()
  }

  get id(): Id {
    return this.session.id
  }
  private nowMs(): number {
    return (this.d.now?.() ?? new Date()).getTime()
  }

  /** A3 + idle notifications: decides `seen` when the root enters/leaves needs='idle'. */
  private rootPatch(p: Partial<AgentNode>, cur: AgentNode): Partial<AgentNode> {
    const out = { ...p }
    if (out.status === 'working' && cur.status !== 'working') {
      this.turnStartedAt = this.nowMs()
      // a new turn: the usage-limit episode (if any) is over
      if (cur.stopReason != null || cur.retryAt != null) {
        this.clearedBanner = this.lastBanner
        out.stopReason = null
        out.resetAt = null
        out.retryAt = null
        queueMicrotask(() => this.d.onLimitCleared?.(this.session.id))
      }
    }
    const enteringIdle = out.needs === 'idle' && cur.needs !== 'idle'
    const leavingIdle = out.needs !== undefined && out.needs !== 'idle' && cur.needs === 'idle'
    // "what the agent said" for the idle row: the hook's last message, else the screen tail; kept while it waits
    if ((out.needs !== undefined ? out.needs : cur.needs) === 'idle' && !out.report) {
      if (enteringIdle) {
        const said = screenMessage(this.raw)
        if (said) out.report = said
      } else if (cur.report) delete out.report
    }
    if (enteringIdle) {
      const visible = this.d.isVisible(this.session.id)
      out.seen = visible
      const turnMs = this.turnStartedAt !== null ? this.nowMs() - this.turnStartedAt : 0
      this.turnStartedAt = null
      if (!visible) queueMicrotask(() => this.d.onIdle?.({ ...cur, ...out } as AgentNode, turnMs))
      queueMicrotask(() => this.d.onNeedsChanged?.())
    } else if (leavingIdle) {
      out.seen = false
      queueMicrotask(() => this.d.onNeedsChanged?.())
    }
    return out
  }

  private feed(ev: HookEvent): void {
    if (this.ended) return
    this.applier.apply(this.tracker.hook(ev))
  }

  onLine(line: unknown): void {
    if (this.ended) return
    this.d.stall?.touch(this.session.id)
    // CONTRACT §13: claude's StopFailure hook carries error "rate_limit" and the CLI's limit line
    const payload = line && typeof line === 'object' ? (line as { payload?: unknown }).payload : null
    if (payload) this.limited(classifyStopFailure(payload, this.d.now?.() ?? new Date()))
    let evs: HookEvent[] = []
    try {
      evs = normalizeHook(this.session.adapter, line)
    } catch (e) {
      this.d.log?.warn('live: hook line not understood', { e: String(e) })
    }
    for (const ev of evs) this.feed(ev)
  }

  /** PTY output (already redacted by SessionManager). Arms the quiet-tail detector. */
  onPtyData(data: string): void {
    if (this.ended) return
    this.d.stall?.touch(this.session.id)
    // Spinner/cursor-blink frames (no more than 2 visible characters) would push a waiting dialog out of the tail
    // within a minute or two, so the A9 guard would refuse a late reply. Keep them out of the tail; they still count as
    // output for the quiet timer.
    // A full clear (ED 2/3, RIS) wipes the screen: anything before it is no longer visible.
    const clearAt = lastClear(data)
    if (clearAt >= 0) {
      this.raw = data.slice(clearAt).slice(-RAW_TAIL)
    } else if (!this.raw || stripAnsi(data).replace(/\s+/g, '').length > 2) this.raw = (this.raw + data).slice(-RAW_TAIL)
    const clear = this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout))
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    if (this.quietTimer) clear(this.quietTimer)
    this.quietTimer = set(() => {
      this.quietTimer = null
      this.feed({ kind: 'pty_prompt', prompt: detectPtyPrompt(this.session.adapter, this.raw) })
      // CONTRACT §13: the CLI's own limit banner at the bottom of the screen (strict shapes only; agents quote 429s)
      if (this.session.adapter !== 'shell') {
        this.limited(classifyLimitText(stripAnsi(this.raw.slice(-4096)), this.d.now?.() ?? new Date(), { tailLines: 12, strict: true }), true)
      }
    }, QUIET_MS)
  }

  /**
   * Input from the pane (sessions:write). Only real keystrokes resolve pty asks as answered in the terminal and end an
   * idle turn (A4b). `typed === false` marks bytes xterm generated on its own (focus reports, query replies while the
   * pane mounts, replays or resizes); those and any pure terminal report never count, whatever the flag says.
   */
  onUserInput(data: string, typed?: boolean): void {
    if (this.ended || !data || typed === false || isTerminalReport(data)) return
    // The user acted on whatever was on screen: only output drawn after this keystroke may open a new screen ask.
    // Otherwise a dialog still sitting in the tail reopens an ask right after it was answered.
    this.raw = ''
    this.clearLimit()
    this.feed({ kind: 'user_input' })
  }

  /** Window focus / visible pane changed: a visible idle root becomes `seen` (A3). */
  visibilityChanged(): void {
    if (this.ended || !this.d.isVisible(this.session.id)) return
    const r = this.d.store.getAgent(this.root.id)
    if (r && r.needs === 'idle' && !r.seen) {
      this.d.store.updateAgent(r.id, { seen: true })
      this.applier.touched(r.id)
      this.d.onNeedsChanged?.()
    }
  }

  /** asks:answer for a session ask (channel pty). A9: re-detect the prompt first; never send keys blind. */
  answer(ask: Ask, a: AskAnswer): Ask {
    if (ask.status !== 'open') throw new HiveError('conflict', 'Already answered in the terminal')
    if (ask.kind === 'approval') throw new HiveError('bad_request', 'Approval cards are decided with author:decide')
    if (ask.kind === 'slack_reply') throw new HiveError('bad_request', 'Slack drafts are decided with slack:draftDecide')
    const opt = a.optionId ? ask.options.find((o) => o.id === a.optionId) : null
    if (a.optionId && !opt) throw new HiveError('bad_request', 'That option is not offered for this request')
    if (!opt || (opt.kind !== 'allow' && opt.kind !== 'deny')) {
      throw new HiveError('bad_request', ask.kind === 'trust' ? 'Answer this in the terminal' : 'Choose Allow or Deny')
    }
    const gateId = this.applier.gateOf(ask.id)
    if (ask.channel !== 'pty' || !gateId) throw new HiveError('bad_request', 'This request is answered in the terminal')
    const decision = opt.kind === 'allow' ? 'allow' : 'deny'
    const keys = ptyReplyKeys(this.session.adapter, ask.kind, decision)
    const onScreen = detectPtyPrompt(this.session.adapter, this.raw)
    const tracked = this.tracker.ask(gateId)
    const fromScreen = !!tracked?.fromScreen
    const matches =
      !!onScreen &&
      onScreen.kind === ask.kind &&
      (fromScreen ? onScreen.title === ask.title : true)
    if (!keys || !matches) {
      // A9: the prompt is gone or changed; the user answered (or must answer) in the terminal.
      this.applier.resolveAsk(ask.id, 'answered', 'terminal')
      this.applier.apply(this.tracker.cancel(gateId))
      throw new HiveError('conflict', 'The prompt changed; open the terminal')
    }
    this.d.writePty(this.session.id, keys)
    // The dialog just answered stays in the byte tail until newer output pushes it out; drop it so the next quiet tail
    // neither reopens it as a fresh ask nor lets a later reply pass the A9 guard on a stale match.
    this.raw = ''
    const answered = this.applier.resolveAsk(ask.id, 'answered', 'hive', { askId: ask.id, optionId: opt.id, ...(a.message ? { message: a.message } : {}) })
    this.applier.apply(this.tracker.answered(gateId, `${opt.label}${a.message ? `: ${a.message}` : ''}`))
    this.applier.flush()
    return answered ?? this.d.store.getAsk(ask.id)!
  }

  /** agents:reply: the root waits for the user (needs='idle'). Types the text, then submits. */
  reply(text: string): void {
    const r = this.d.store.getAgent(this.root.id)
    if (this.ended || !r || r.needs !== 'idle') throw new HiveError('conflict', 'This agent is not waiting for a reply')
    this.d.writePty(this.session.id, text)
    this.raw = ''
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    // separate write: a trailing \r in the same chunk can be read as part of a paste instead of "submit"
    set(() => this.d.writePty(this.session.id, '\r'), REPLY_SUBMIT_DELAY_MS)
    this.feed({ kind: 'user_input' })
    this.applier.flush()
  }

  /** PTY exit (A4a): root done/failed, every open ask closed, live dir removed. */
  exit(exitCode: number | null, byHive: boolean): void {
    if (this.ended) return
    this.d.stall?.untrack(this.session.id)
    const lr = this.d.store.getAgent(this.root.id)
    if (lr?.retryAt) this.d.store.updateAgent(lr.id, { retryAt: null })
    this.d.onLimitCleared?.(this.session.id)
    const status = exitCode === 0 || byHive ? 'done' : 'failed'
    this.applier.apply(this.tracker.end(status, status === 'failed' ? `Exited with code ${exitCode ?? '?'}` : null))
    this.ended = true
    // backstop: anything the tracker did not know about
    // approval cards (AUTHORING.md §2.1) outlive the pane: the draft stays pending
    for (const a of this.d.store.listOpenAsks({ rootId: this.root.id })) if (a.kind !== 'approval' && a.kind !== 'slack_reply') this.applier.resolveAsk(a.id, 'canceled', null)
    const r = this.d.store.getAgent(this.root.id)
    if (r && (r.status === 'starting' || r.status === 'working' || r.status === 'needs_you' || r.status === 'idle')) {
      this.d.store.updateAgent(r.id, { status, needs: null, endedAt: new Date(this.nowMs()).toISOString() })
      this.applier.touched(r.id)
    }
    if (this.quietTimer) (this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(this.quietTimer)
    this.quietTimer = null
    this.applier.flush()
    this.channel?.close()
    this.channel = null
    this.d.onNeedsChanged?.()
  }
}

/** All live sessions. Main owns one. */
export class SessionLiveHub {
  private byId = new Map<Id, SessionLive>()
  constructor(private d: SessionLiveDeps) {}

  open(session: Pick<Session, 'id' | 'adapter' | 'repoId' | 'cwd' | 'title'>, channel: LiveChannel | null): SessionLive | null {
    if (session.adapter === 'shell') {
      channel?.close()
      return null
    }
    const s = new SessionLive(this.d, session, channel)
    this.byId.set(session.id, s)
    return s
  }
  get(sessionId: Id): SessionLive | null {
    return this.byId.get(sessionId) ?? null
  }
  /** The live session owning an agent (root or subagent), if any. */
  byAgent(agentId: Id): SessionLive | null {
    const a = this.d.store.getAgent(agentId)
    if (!a?.sessionId) return null
    return this.byId.get(a.sessionId) ?? null
  }
  exited(sessionId: Id, exitCode: number | null, byHive: boolean): void {
    const s = this.byId.get(sessionId)
    if (!s) return
    this.byId.delete(sessionId)
    s.exit(exitCode, byHive)
  }
  visibilityChanged(): void {
    for (const s of this.byId.values()) s.visibilityChanged()
  }
  answer(ask: Ask, a: AskAnswer): Ask {
    const s = ask.sessionId ? this.byId.get(ask.sessionId) : null
    if (!s) throw new HiveError('conflict', 'This session has ended')
    return s.answer(ask, a)
  }
  /** CONTRACT §13: the live session with this id (retry / resume). */
  live(sessionId: Id): SessionLive | null {
    return this.byId.get(sessionId) ?? null
  }
  reply(agentId: Id, text: string): void {
    const s = this.byAgent(agentId)
    if (!s || s.root.id !== agentId) throw new HiveError('conflict', 'This agent is not waiting for a reply')
    s.reply(text)
  }
  size(): number {
    return this.byId.size
  }
  adapters(): AdapterId[] {
    return [...this.byId.values()].map((s) => s.session.adapter)
  }
}
