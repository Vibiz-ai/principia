/**
 * REMOTE.md RA3 "a terminal on the phone": a session that runs in a terminal on the Mac shows on the phone as a chat,
 * live. Its agent's own transcript (transcript.ts) is tailed (live/tailer.ts) and folded by the chat reducer into the
 * SAME ChatItems and numbered ChatOps a chat session sends, so the phone's chat replica applies them unchanged. With no
 * transcript yet (or a CLI that writes none) the phone gets the terminal's last lines instead, refreshed while it looks.
 * A feed runs only while a phone is subscribed to that session (plus a short grace), read-only on the agent's files,
 * every string redacted as the chat path does. No Electron imports.
 */
import type { AgentNode } from '../../shared/live'
import type { ChatItem, ChatOp, ChatSnapshot, ChatTurn } from '../../shared/chat'
import { EMPTY_CHAT_META } from '../../shared/chat'
import { ChatReducer } from '../../shared/chatReduce'
import type { Id, Session } from '../../shared/types'
import type { PhoneServerMsg } from '../../shared/remote'
import { coalesce, redactDeep } from '../chat/chatHub'
import { JsonlTailer } from '../live/tailer'
import { CodexTranscript, type TranscriptRef } from './transcript'

/** what the phone may read and do in a terminal session (wire.ts gives the desktop's own) */
export interface PhoneTerminalHost {
  /** the session's transcript: the path its hook reported, else found by its conversation id; null = none (yet) */
  transcript(s: Session): TranscriptRef | null
  /** the terminal's last lines, ANSI-stripped (a running session), or null */
  screen(sessionId: Id): string | null
  /** types a message into a running terminal session; throws (plain words) when it is asking something */
  type(sessionId: Id, text: string): void
  /** why a message cannot go in right now (a dialog on its screen), or null */
  held?(sessionId: Id): string | null
  redact(text: string): string
}

/** most of a long transcript is old: the phone gets the last part, like the Mac's own transcript reads */
const BACKLOG = 8 * 1024 * 1024
const FLUSH_MS = 80
const GRACE_MS = 30_000
const TICK_MS = 1000
const SCREEN_MAX = 6000

/** The root of a terminal session as a chat turn (the header's "Working", "Your turn"). */
export function terminalTurn(root: Pick<AgentNode, 'status' | 'needs'> | null | undefined, ended: boolean): ChatTurn {
  if (ended || !root) return ended ? 'ended' : 'idle'
  if (root.status === 'working') return 'working'
  if (root.status === 'starting') return 'starting'
  if (root.status === 'needs_you') return root.needs === 'idle' ? 'idle' : 'needs'
  return root.status === 'done' || root.status === 'failed' ? 'ended' : 'idle'
}

/** The chat items of a transcript, read once (an ended session's history). */
export function transcriptItems(ref: TranscriptRef, redact: (s: string) => string): ChatItem[] {
  const r = new ChatReducer({ idPrefix: 'h' })
  const codex = ref.format === 'codex' ? new CodexTranscript() : null
  const t = new JsonlTailer(ref.file, { backlog: BACKLOG, onLine: (l) => (codex ? codex.records(l) : [l]).forEach((x) => r.line(x)) })
  t.start()
  t.close()
  r.settle('expired')
  return redactDeep(r.model.items.slice(), redact)
}

export function terminalSnapshot(sessionId: Id, o: { items: ChatItem[]; seq: number; turn: ChatTurn; activity: string | null }): ChatSnapshot {
  return { sessionId, mode: 'terminal', available: false, turn: o.turn, activity: o.activity, turnStartedAt: null, items: o.items, queue: [], meta: { ...EMPTY_CHAT_META }, seq: o.seq, note: null, startedAs: 'terminal' }
}

interface Feed {
  session: Session
  seq: number
  reducer: ChatReducer | null
  codex: CodexTranscript | null
  tailer: JsonlTailer | null
  /** the transcript the tailer reads */
  file: string | null
  pending: ChatOp[]
  timer: NodeJS.Timeout | null
  screen: string | null
  turn: ChatTurn
  activity: string | null
  idleSince: number
  /** host.held() when the phones last took a view: the composer (held, canType) is part of that view only */
  held: string | null
}

export interface TerminalFeedsDeps {
  host: PhoneTerminalHost
  /** to the phones subscribed to this session */
  push(sessionId: Id, m: PhoneServerMsg): void
  /** sessions some phone is subscribed to now */
  wanted(): Set<Id>
  now?: () => number
  /** tests: no background tick */
  tickMs?: number | null
  pollMs?: number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

export class TerminalFeeds {
  private feeds = new Map<Id, Feed>()
  private tick: NodeJS.Timeout | null = null

  constructor(private d: TerminalFeedsDeps) {
    const ms = d.tickMs === undefined ? TICK_MS : d.tickMs
    if (ms) {
      this.tick = setInterval(() => this.check(), ms)
      this.tick.unref?.()
    }
  }
  private now(): number {
    return this.d.now ? this.d.now() : Date.now()
  }

  /** The phone's view of a running terminal session: its transcript as a chat (live from here on), else its screen. */
  open(s: Session, turn: ChatTurn, activity: string | null): { chat: ChatSnapshot; source: 'transcript' | 'screen' | null; screen: string | null } {
    let f = this.feeds.get(s.id)
    if (!f) {
      f = { session: s, seq: 0, reducer: null, codex: null, tailer: null, file: null, pending: [], timer: null, screen: null, turn, activity, idleSince: this.now(), held: null }
      this.feeds.set(s.id, f)
    }
    f.session = s
    f.turn = turn
    f.activity = activity
    f.idleSince = this.now()
    f.held = this.heldOf(s.id)
    // a phone already watching gets the new transcript too (else it keeps the old one and the ids collide)
    if (f.reducer && this.retarget(f)) this.refetch(f)
    if (!f.reducer) this.attach(f)
    this.flush(f)
    if (!f.reducer) f.screen = this.screenOf(s.id)
    const items = f.reducer ? redactDeep(f.reducer.model.items.slice(), (x) => this.d.host.redact(x)) : []
    return { chat: terminalSnapshot(s.id, { items, seq: f.seq, turn, activity }), source: f.reducer ? 'transcript' : f.screen ? 'screen' : null, screen: f.reducer ? null : f.screen }
  }

  has(sessionId: Id): boolean {
    return this.feeds.has(sessionId)
  }

  /** The root changed (working, your turn, waiting on you): the phone's header follows. */
  state(sessionId: Id, turn: ChatTurn, activity: string | null): void {
    const f = this.feeds.get(sessionId)
    if (!f || (f.turn === turn && f.activity === activity)) return
    f.turn = turn
    f.activity = activity
    this.queue(f, [{ op: 'state', turn, activity }])
  }

  /** The session ended (or turned into a chat on the Mac): the phone takes a fresh view, and this feed stops. */
  ended(sessionId: Id): void {
    const f = this.feeds.get(sessionId)
    if (!f) return
    this.flush(f)
    this.refetch(f)
    this.close(f)
  }

  /** Something beside the transcript changed (an ask opened or closed): the phones on it take a fresh view. */
  refresh(sessionId: Id): void {
    const f = this.feeds.get(sessionId)
    if (!f) return
    this.flush(f)
    this.refetch(f)
  }

  /** a numbered gap: every phone on this session takes a fresh snapshot (the transcript appeared, the session ended) */
  private refetch(f: Feed): void {
    f.seq += 2
    this.d.push(f.session.id, { t: 'chat', sessionId: f.session.id, seq: f.seq, ops: [] })
  }

  private lookup(f: Feed): TranscriptRef | null {
    try {
      return this.d.host.transcript(f.session)
    } catch (e) {
      this.d.log?.warn('phone: transcript lookup failed', { error: String(e) })
      return null
    }
  }

  /**
   * The session now writes another transcript (Claude's /clear starts a new conversation file): the old tailer stops
   * and the new one is read from its start. True when it moved; the caller has the phones take a fresh view.
   */
  private retarget(f: Feed): boolean {
    const ref = this.lookup(f)
    if (!ref || ref.file === f.file) return false
    this.flush(f)
    f.tailer?.close()
    f.tailer = null
    f.reducer = null
    f.codex = null
    f.file = null
    this.attach(f, ref)
    return true
  }

  private attach(f: Feed, known?: TranscriptRef): void {
    const ref = known ?? this.lookup(f)
    if (!ref) return
    const reducer = new ChatReducer({ idPrefix: 'm' })
    const codex = ref.format === 'codex' ? new CodexTranscript() : null
    let loading = true
    const tailer = new JsonlTailer(ref.file, {
      backlog: BACKLOG,
      ...(this.d.pollMs ? { pollMs: this.d.pollMs } : {}),
      onLine: (l) => {
        for (const rec of codex ? codex.records(l) : [l]) {
          const ops = reducer.line(rec)
          if (!loading) this.queue(f, ops)
        }
      }
    })
    f.reducer = reducer
    f.codex = codex
    f.tailer = tailer
    f.file = ref.file
    tailer.start()
    loading = false
  }

  private queue(f: Feed, ops: ChatOp[]): void {
    if (!ops.length) return
    f.pending.push(...ops)
    if (!f.timer) {
      f.timer = setTimeout(() => this.flush(f), FLUSH_MS)
      f.timer.unref?.()
    }
  }
  private flush(f: Feed): void {
    if (f.timer) clearTimeout(f.timer)
    f.timer = null
    const ops = f.pending
    f.pending = []
    if (!ops.length) return
    f.seq += 1
    this.d.push(f.session.id, { t: 'chat', sessionId: f.session.id, seq: f.seq, ops: redactDeep(coalesce(ops), (x) => this.d.host.redact(x)) })
  }

  private heldOf(sessionId: Id): string | null {
    try {
      return this.d.host.held?.(sessionId) ?? null
    } catch {
      return null
    }
  }

  private screenOf(sessionId: Id): string | null {
    let t: string | null = null
    try {
      t = this.d.host.screen(sessionId)
    } catch {
      t = null
    }
    if (!t) return null
    const clipped = t.length > SCREEN_MAX ? t.slice(t.length - SCREEN_MAX) : t
    return this.d.host.redact(clipped)
  }

  /**
   * Once a second: feeds nobody looks at stop; a screen-only feed picks up its transcript or sends new lines; a
   * change in why a message cannot go in (a Codex trust or approval menu answered on the Mac has no ask to say so)
   * makes the phones take a fresh view, so Send follows.
   */
  check(): void {
    const wanted = this.d.wanted()
    const now = this.now()
    for (const f of [...this.feeds.values()]) {
      if (wanted.has(f.session.id)) f.idleSince = now
      else if (now - f.idleSince >= GRACE_MS) {
        this.close(f)
        continue
      }
      const held = this.heldOf(f.session.id)
      if (held !== f.held) {
        f.held = held
        this.flush(f)
        this.refetch(f)
      }
      if (f.reducer) {
        if (this.retarget(f)) this.refetch(f)
        else f.tailer?.read()
        continue
      }
      this.attach(f)
      if (f.reducer) {
        this.refetch(f)
        continue
      }
      const screen = this.screenOf(f.session.id)
      if (screen !== null && screen !== f.screen) {
        f.screen = screen
        this.d.push(f.session.id, { t: 'screen', sessionId: f.session.id, text: screen })
      }
    }
  }

  private close(f: Feed): void {
    // the tailer's last read may still queue ops: stop it first, then drop them
    f.tailer?.close()
    f.tailer = null
    f.file = null
    if (f.timer) clearTimeout(f.timer)
    f.timer = null
    f.pending = []
    this.feeds.delete(f.session.id)
  }

  size(): number {
    return this.feeds.size
  }

  dispose(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    for (const f of [...this.feeds.values()]) this.close(f)
  }
}
