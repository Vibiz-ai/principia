/**
 * AGENT-COLLAB.md §2: agents asking agents, with loop safety. Before this, an agent's post never woke another agent
 * (responder.ts only wakes for people), so `forum_ask` to an agent sat unread until that agent's next board task.
 *
 * An agent wakes another agent in two ways: `forum_ask_agent` (an ask card addressed to one agent or a department's
 * lead agent), or an @agent / @department mention in its own post or reply. Each request passes these guards, in
 * order, and every decision is a `forum_agent_wakes` row (visible in the Forum's Agent talk panel and the Run view):
 *
 *  off            Settings → agentCollab.enabled is false
 *  self           an agent never wakes itself
 *  not_agent      the target is not an active agent seat (people use forum_ask)
 *  cannot_answer  the seat cannot run (workflow seat, shell profile, paused, archived)
 *  cycle          the target is already in this chain (A→B→A): its reply reaches the asker anyway
 *  hops           the chain is already `maxHops` deep (A→B = 1, B→C = 2 …)
 *  thread_cap     `perThread` agent wakes in this thread already
 *  target_cap     the target was woken by agents `perAgentPerHour` times in the last hour
 *  asker_cap      the asker woke agents `perAskerPerHour` times in the last hour
 *  company_cap    `perCompanyPerDay` agent wakes in this company in the last 24 h
 *
 * Depth comes from provenance, not from the thread: a run started by a wake carries that wake's depth and chain, so a
 * woken agent that asks a third one is one hop deeper wherever it posts. Counters are read from the table, so they
 * survive a restart. A mention that would be a cycle or a self-wake is skipped silently (it is how agents address
 * each other in a reply); every other refusal is recorded and told to the asking agent in its tool result.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ForumMember, ForumMessage } from '../../shared/forum'
import type { AgentCollabSettings, CollabRefusal, CollabState, CollabThread, CollabWake, CollabWakeStatus, RunConversation } from '../../shared/collab'
import type { ForumStore } from './store'
import type { ForumCaller } from './agentApi'

const HOUR = 3_600_000
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface CollabWakeRequest {
  wakeId: string
  target: ForumMember
  asker: ForumMember
  message: ForumMessage
  depth: number
  maxHops: number
  why: string
}
export interface CollabWakeResult { runId: string | null; queued: boolean; error?: string }

export interface CollabDeps {
  db: Database.Database
  store: () => ForumStore
  settings: () => AgentCollabSettings
  /** false = nothing can wake agents here (no responder: tests, a Principia without the Forum running) */
  ready?: () => boolean
  /** the seat can run a reply (active, profile-backed, not shell). Absent = yes. */
  canAnswer?: (agentId: string) => boolean
  /** starts (or queues) the target's reply run (responder.wakeForAgent). Absent = nothing starts (recorded as start_failed). */
  wake?: (req: CollabWakeRequest) => CollabWakeResult
  /** cost of reply runs (TeamTools.runCost) */
  cost?: (runIds: string[]) => { usd: number | null; estimated: boolean; tokens: number | null }
  now?: () => Date
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

export interface CollabOutcome {
  member: ForumMember
  status: CollabWakeStatus | 'skipped'
  refusal: CollabRefusal | null
  /** the line for the asking agent's tool result */
  note: string
  wakeId: string | null
  runId: string | null
  depth: number
}

export interface WakeRow {
  id: string; company_id: string; thread_seq: number; message_seq: number; channel_id: string; from_member: string; to_member: string
  from_agent: string | null; to_agent: string | null; from_run: string | null; to_run: string | null; depth: number; chain: string; via: string
  why: string; status: string; refusal: string | null; note: string; created_at: string; answered_at: string | null
}

const REFUSAL_TEXT: Record<CollabRefusal, (h: string, s: AgentCollabSettings) => string> = {
  off: () => 'agent-to-agent asks are off in this Principia (the Forum\'s Agent talk settings)',
  self: () => 'you cannot ask yourself',
  not_agent: (h) => `${h} is not an agent; ask people with forum_ask`,
  cannot_answer: (h) => `${h} cannot answer now (paused, archived, a workflow seat or a shell profile)`,
  cycle: (h) => `${h} is already in this conversation; your reply reaches them without waking them again`,
  hops: (_h, s) => `this conversation is already ${s.maxHops} hops deep (limit ${s.maxHops}); answer with what you know or ask a person`,
  thread_cap: (_h, s) => `this thread already woke agents ${s.perThread} times (limit ${s.perThread}); continue without another wake`,
  target_cap: (h, s) => `${h} was asked by agents ${s.perAgentPerHour} times in the last hour (limit ${s.perAgentPerHour}); try later or read team_activity`,
  asker_cap: (_h, s) => `you asked agents ${s.perAskerPerHour} times in the last hour (limit ${s.perAskerPerHour}); put the rest in your report`,
  company_cap: (_h, s) => `this company used its ${s.perCompanyPerDay} agent-to-agent wakes for the last 24 hours; ask a person or continue alone`,
  start_failed: (h) => `${h} could not be started`
}

const LIVE = "status IN ('started','queued','answered')"

export class AgentCollab {
  /**
   * ORCHESTRATOR.md §2: the woken teammate replied in the thread (`text`: its reply). The mailbox picks the asking task
   * back up from a question asked by @mention.
   */
  onReplied?: (e: { rows: WakeRow[]; text: string }) => void

  constructor(private readonly d: CollabDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }
  private s(): ForumStore {
    return this.d.store()
  }

  /**
   * Depth and chain of a new wake asked from `caller`'s run. ORCHESTRATOR.md §2: the mailbox passes the run whose report
   * asked (`originRunId`), so a question sent after the run ended keeps its place in the chain.
   */
  provenance(caller: Pick<ForumCaller, 'runId' | 'memberId'>, originRunId?: string | null): { depth: number; chain: string[] } {
    if (originRunId !== undefined) caller = { ...caller, runId: originRunId }
    if (caller.runId) {
      const row = this.d.db.prepare(`SELECT depth, chain FROM forum_agent_wakes WHERE to_run=? AND ${LIVE} ORDER BY created_at DESC LIMIT 1`).get(caller.runId) as { depth: number; chain: string } | undefined
      if (row) {
        const chain = parse<string[]>(row.chain, [])
        return { depth: row.depth + 1, chain: [...chain.filter((x) => x !== caller.memberId), caller.memberId] }
      }
    }
    return { depth: 1, chain: [caller.memberId] }
  }

  private count(sql: string, ...args: unknown[]): number {
    return (this.d.db.prepare(`SELECT COUNT(*) AS n FROM forum_agent_wakes WHERE ${sql}`).get(...args) as { n: number }).n
  }

  /** The guard verdict for one target (no side effects). */
  check(caller: ForumCaller, target: ForumMember | null, threadSeq: number | null): { refusal: CollabRefusal | null; depth: number; chain: string[] } {
    const st = this.d.settings()
    const prov = this.provenance(caller)
    const r = (refusal: CollabRefusal | null) => ({ refusal, ...prov })
    if (!st.enabled || (this.d.ready && !this.d.ready())) return r('off')
    if (!target) return r('not_agent')
    if (target.id === caller.memberId) return r('self')
    if (target.kind !== 'agent' || !target.agentId || target.status !== 'active' || target.companyId !== caller.companyId) return r('not_agent')
    if (this.d.canAnswer && !this.d.canAnswer(target.agentId)) return r('cannot_answer')
    if (prov.chain.includes(target.id)) return r('cycle')
    if (prov.depth > st.maxHops) return r('hops')
    const t = this.now().getTime()
    if (threadSeq != null && this.count(`thread_seq=? AND ${LIVE}`, threadSeq) >= st.perThread) return r('thread_cap')
    const hourAgo = new Date(t - HOUR).toISOString()
    if (this.count(`to_member=? AND created_at>=? AND ${LIVE}`, target.id, hourAgo) >= st.perAgentPerHour) return r('target_cap')
    if (this.count(`from_member=? AND created_at>=? AND ${LIVE}`, caller.memberId, hourAgo) >= st.perAskerPerHour) return r('asker_cap')
    if (this.count(`company_id=? AND created_at>=? AND ${LIVE}`, caller.companyId, new Date(t - 24 * HOUR).toISOString()) >= st.perCompanyPerDay) return r('company_cap')
    return r(null)
  }

  refusalText(code: CollabRefusal, target: ForumMember | null): string {
    return REFUSAL_TEXT[code](target ? `@${target.handle}` : 'that member', this.d.settings())
  }

  /**
   * An agent's message asks (`ask`) or mentions (`mention`) these agents: check each, record, wake. Never throws.
   * `msg` is the message that asked; its thread root is where the conversation lives.
   */
  request(
    caller: ForumCaller,
    msg: ForumMessage,
    targets: ForumMember[],
    via: 'ask' | 'mention' | 'report',
    why: string,
    /**
     * ORCHESTRATOR.md §2 (the mailbox): deliver this wake another way (into the target's in-flight task) instead of a
     * reply run. Returning null falls back to the responder's wake.
     */
    opts: { deliver?: (req: CollabWakeRequest) => CollabWakeResult | null } = {}
  ): CollabOutcome[] {
    const out: CollabOutcome[] = []
    let asker: ForumMember | null = null
    try {
      asker = this.s().member(caller.memberId)
    } catch {
      asker = null
    }
    if (!asker || asker.kind !== 'agent') return out
    const root = msg.threadId ? safe(() => this.s().message(msg.threadId!)) : msg
    const threadSeq = root?.seq ?? msg.seq
    const seen = new Set<string>()
    for (const target of targets) {
      if (seen.has(target.id)) continue
      seen.add(target.id)
      const v = this.check(caller, target, threadSeq)
      const st = this.d.settings()
      // crediting an agent this run already asked ("based on @livia's answer") is not a new question
      if (via === 'mention' && !v.refusal && caller.runId && this.count(`from_run=? AND to_member=? AND ${LIVE}`, caller.runId, target.id) > 0) {
        out.push({ member: target, status: 'skipped', refusal: 'cycle', note: `@${target.handle} already answered you in this run (not woken again)`, wakeId: null, runId: null, depth: v.depth })
        continue
      }
      if (v.refusal && via === 'mention' && (v.refusal === 'self' || v.refusal === 'cycle' || v.refusal === 'not_agent' || v.refusal === 'off')) {
        out.push({ member: target, status: 'skipped', refusal: v.refusal, note: v.refusal === 'cycle' ? `@${target.handle} is in this conversation (not woken again)` : '', wakeId: null, runId: null, depth: v.depth })
        continue
      }
      const id = `fwk_${randomBytes(6).toString('hex')}`
      const base = {
        id, company_id: caller.companyId, thread_seq: threadSeq, message_seq: msg.seq, channel_id: msg.channelId, from_member: asker.id, to_member: target.id,
        from_agent: asker.agentId, to_agent: target.agentId, from_run: caller.runId, depth: v.depth, chain: JSON.stringify(v.chain), via, why: clip(why.trim(), 300), created_at: this.now().toISOString()
      }
      if (v.refusal) {
        const note = `@${target.handle} not woken: ${this.refusalText(v.refusal, target)}`
        this.insert({ ...base, to_run: null, status: 'refused', refusal: v.refusal, note })
        this.d.log?.warn('agent collab: refused', { companyId: caller.companyId, from: asker.handle, to: target.handle, refusal: v.refusal, depth: v.depth, runId: caller.runId })
        out.push({ member: target, status: 'refused', refusal: v.refusal, note, wakeId: id, runId: null, depth: v.depth })
        continue
      }
      // record first (the counters see it), then start
      this.insert({ ...base, to_run: null, status: 'queued', refusal: null, note: '' })
      let res: CollabWakeResult
      try {
        const req: CollabWakeRequest = { wakeId: id, target, asker, message: msg, depth: v.depth, maxHops: st.maxHops, why: base.why }
        res = opts.deliver?.(req) ?? (this.d.wake ? this.d.wake(req) : { runId: null, queued: false, error: 'no responder' })
      } catch (e) {
        res = { runId: null, queued: false, error: String(e) }
      }
      if (res.runId) {
        const note = `woke @${target.handle} (hop ${v.depth}/${st.maxHops}, run ${res.runId})`
        this.d.db.prepare("UPDATE forum_agent_wakes SET status='started', to_run=?, note=? WHERE id=?").run(res.runId, note, id)
        this.d.log?.info('agent collab: woke', { companyId: caller.companyId, from: asker.handle, to: target.handle, depth: v.depth, runId: res.runId, fromRun: caller.runId, via })
        out.push({ member: target, status: 'started', refusal: null, note, wakeId: id, runId: res.runId, depth: v.depth })
      } else if (res.queued) {
        const note = `@${target.handle} is answering something else; queued (hop ${v.depth}/${st.maxHops})`
        this.d.db.prepare('UPDATE forum_agent_wakes SET note=? WHERE id=?').run(note, id)
        this.d.log?.info('agent collab: queued', { companyId: caller.companyId, from: asker.handle, to: target.handle, depth: v.depth })
        out.push({ member: target, status: 'queued', refusal: null, note, wakeId: id, runId: null, depth: v.depth })
      } else {
        const note = `@${target.handle} not woken: ${res.error ? clip(res.error, 160) : this.refusalText('start_failed', target)}`
        this.d.db.prepare("UPDATE forum_agent_wakes SET status='refused', refusal='start_failed', note=? WHERE id=?").run(note, id)
        this.d.log?.warn('agent collab: start failed', { companyId: caller.companyId, to: target.handle, error: res.error ?? null })
        out.push({ member: target, status: 'refused', refusal: 'start_failed', note, wakeId: id, runId: null, depth: v.depth })
      }
    }
    return out
  }

  /** A record without a wake (forum_ask_agent refused before posting): visible in the panel like any refusal. */
  recordRefusal(caller: ForumCaller, target: ForumMember | null, refusal: CollabRefusal, why: string, channelId: string, via: 'ask' | 'mention' | 'report' = 'ask'): string {
    const v = this.provenance(caller)
    const note = target ? `@${target.handle} not woken: ${this.refusalText(refusal, target)}` : this.refusalText(refusal, null)
    if (!target || refusal === 'self' || refusal === 'not_agent') return note
    this.insert({
      id: `fwk_${randomBytes(6).toString('hex')}`, company_id: caller.companyId, thread_seq: 0, message_seq: 0, channel_id: channelId, from_member: caller.memberId, to_member: target.id,
      from_agent: this.s().member(caller.memberId)?.agentId ?? null, to_agent: target.agentId, from_run: caller.runId, to_run: null, depth: v.depth, chain: JSON.stringify(v.chain),
      via, why: clip(why.trim(), 300), status: 'refused', refusal, note, created_at: this.now().toISOString()
    })
    this.d.log?.warn('agent collab: refused', { companyId: caller.companyId, to: target.handle, refusal, depth: v.depth, runId: caller.runId })
    return note
  }

  private insert(r: Omit<WakeRow, 'answered_at'>): void {
    this.d.db
      .prepare('INSERT INTO forum_agent_wakes(id,company_id,thread_seq,message_seq,channel_id,from_member,to_member,from_agent,to_agent,from_run,to_run,depth,chain,via,why,status,refusal,note,created_at) VALUES (@id,@company_id,@thread_seq,@message_seq,@channel_id,@from_member,@to_member,@from_agent,@to_agent,@from_run,@to_run,@depth,@chain,@via,@why,@status,@refusal,@note,@created_at)')
      .run(r)
  }

  /** responder: a queued wake got its run (or could not start). */
  noteStarted(wakeIds: string[], runId: string): void {
    const st = this.d.db.prepare("UPDATE forum_agent_wakes SET status='started', to_run=? WHERE id=? AND status='queued'")
    for (const id of wakeIds) st.run(runId, id)
  }
  noteFailed(wakeIds: string[], reason: string): void {
    const st = this.d.db.prepare("UPDATE forum_agent_wakes SET status='refused', refusal='start_failed', note=? WHERE id=? AND status IN ('queued','started')")
    for (const id of wakeIds) st.run(clip(reason, 200), id)
  }
  wake(id: string): WakeRow | null {
    return (this.d.db.prepare('SELECT * FROM forum_agent_wakes WHERE id=?').get(id) as WakeRow | undefined) ?? null
  }
  /** Wakes of this message still on their way; `memberId` narrows them to one target. */
  liveWakes(messageSeq: number, memberId?: string): WakeRow[] {
    const rows = this.d.db.prepare("SELECT * FROM forum_agent_wakes WHERE message_seq=? AND status IN ('queued','started')").all(messageSeq) as WakeRow[]
    return memberId ? rows.filter((r) => r.to_member === memberId) : rows
  }

  /** The wakes this run was started for. */
  wakesOfRun(runId: string): WakeRow[] {
    return this.d.db.prepare('SELECT * FROM forum_agent_wakes WHERE to_run=?').all(runId) as WakeRow[]
  }

  /**
   * The target wrote in the thread (reply, answered ask): its wakes there are answered, also one whose run ended
   * without an answer (noteFailed): the asker gave up on it, and hears the late answer.
   */
  noteReplied(memberId: string, threadSeq: number, text?: string): void {
    const unanswered = `(status IN ('started','queued') OR (status='refused' AND refusal='start_failed' AND to_run IS NOT NULL))`
    const rows = this.d.db.prepare(`SELECT * FROM forum_agent_wakes WHERE thread_seq=? AND to_member=? AND ${unanswered}`).all(threadSeq, memberId) as WakeRow[]
    if (!rows.length) return
    this.d.db.prepare(`UPDATE forum_agent_wakes SET status='answered', answered_at=? WHERE thread_seq=? AND to_member=? AND ${unanswered}`).run(this.now().toISOString(), threadSeq, memberId)
    if (text === undefined || !this.onReplied) return
    try {
      this.onReplied({ rows, text })
    } catch {
      /* the wake bookkeeping never fails a reply */
    }
  }

  // ---------- views ----------

  private toWake(r: WakeRow): CollabWake {
    const cost = r.to_run && this.d.cost ? this.d.cost([r.to_run]) : { usd: null, estimated: false, tokens: null }
    let threadId = ''
    let messageId = ''
    try {
      threadId = r.thread_seq ? this.s().message(r.thread_seq).id : ''
      messageId = r.message_seq ? this.s().message(r.message_seq).id : ''
    } catch {
      /* deleted */
    }
    return {
      id: r.id, companyId: r.company_id, threadMessageId: threadId, messageId, channelId: r.channel_id, fromMemberId: r.from_member, toMemberId: r.to_member,
      fromName: this.s().member(r.from_member)?.name ?? 'someone', toName: this.s().member(r.to_member)?.name ?? 'someone',
      fromAgentId: r.from_agent, toAgentId: r.to_agent, fromRunId: r.from_run, toRunId: r.to_run, depth: r.depth, chain: parse<string[]>(r.chain, []),
      via: r.via === 'mention' ? 'mention' : r.via === 'report' ? 'report' : 'ask', why: r.why, status: r.status as CollabWakeStatus, refusal: (r.refusal as CollabRefusal | null) ?? null, note: r.note,
      createdAt: r.created_at, answeredAt: r.answered_at, costUsd: cost.usd, costEstimated: cost.estimated, tokens: cost.tokens
    }
  }

  usage(companyId: string): { wakesToday: number; refusedToday: number; capPerDay: number } {
    const day = new Date(this.now().getTime() - 24 * HOUR).toISOString()
    return {
      wakesToday: this.count(`company_id=? AND created_at>=? AND ${LIVE}`, companyId, day),
      refusedToday: this.count("company_id=? AND created_at>=? AND status='refused'", companyId, day),
      capPerDay: this.d.settings().perCompanyPerDay
    }
  }

  state(companyId: string, limit = 30): CollabState {
    const rows = this.d.db.prepare('SELECT * FROM forum_agent_wakes WHERE company_id=? ORDER BY created_at DESC LIMIT 400').all(companyId) as WakeRow[]
    const byThread = new Map<number, WakeRow[]>()
    const loose: WakeRow[] = []
    for (const r of rows) {
      if (!r.thread_seq) loose.push(r)
      else byThread.set(r.thread_seq, [...(byThread.get(r.thread_seq) ?? []), r])
    }
    const threads: CollabThread[] = []
    for (const [seq, list] of byThread) {
      if (threads.length >= limit) break
      let root: ForumMessage | null = null
      try {
        root = this.s().message(seq)
      } catch {
        continue
      }
      const wakes = list.map((r) => this.toWake(r)).reverse()
      const runs = wakes.map((w) => w.toRunId).filter((x): x is string => !!x)
      const cost = runs.length && this.d.cost ? this.d.cost(runs) : { usd: null, estimated: false }
      threads.push({
        threadMessageId: root.id, channelId: root.channelId, ref: root.ref, text: clip(root.text, 200), startedAt: wakes[0].createdAt, lastAt: wakes[wakes.length - 1].createdAt,
        members: [...new Set(wakes.flatMap((w) => [w.fromMemberId, w.toMemberId]))], wakes, maxDepth: Math.max(...wakes.map((w) => w.depth)), costUsd: cost.usd, costEstimated: cost.estimated
      })
    }
    // refusals that never posted an ask still show, as one-line threads without a root
    for (const r of loose.slice(0, 10)) {
      const w = this.toWake(r)
      threads.push({ threadMessageId: '', channelId: r.channel_id, ref: '', text: w.note, startedAt: w.createdAt, lastAt: w.createdAt, members: [w.fromMemberId, w.toMemberId], wakes: [w], maxDepth: w.depth, costUsd: null, costEstimated: false })
    }
    threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    return { companyId, settings: this.d.settings(), usage: this.usage(companyId), threads: threads.slice(0, limit) }
  }

  /** The Run view: what this run asked, who woke it, and what it said in the Forum. */
  forRun(runId: string): RunConversation {
    const asked = (this.d.db.prepare('SELECT * FROM forum_agent_wakes WHERE from_run=? ORDER BY created_at').all(runId) as WakeRow[]).map((r) => this.toWake(r))
    const a = this.d.db.prepare('SELECT * FROM forum_agent_wakes WHERE to_run=? ORDER BY created_at DESC LIMIT 1').get(runId) as WakeRow | undefined
    const answered = a ? this.toWake(a) : null
    // its own posts (origin agent:<stepId> of this run's steps) and the threads it took part in
    let stepIds: string[] = []
    try {
      stepIds = (this.d.db.prepare('SELECT id FROM run_steps WHERE run_id=?').all(runId) as { id: string }[]).map((x) => x.id)
    } catch {
      stepIds = []
    }
    const seqs = new Set<number>()
    if (stepIds.length) {
      const own = this.d.db.prepare(`SELECT seq, thread_seq FROM forum_messages WHERE origin IN (${stepIds.map(() => '?').join(',')})`).all(...stepIds.map((s) => `agent:${s}`)) as { seq: number; thread_seq: number | null }[]
      for (const m of own) seqs.add(m.thread_seq ?? m.seq)
    }
    for (const w of [...asked, ...(answered ? [answered] : [])]) {
      const row = this.d.db.prepare('SELECT thread_seq FROM forum_agent_wakes WHERE id=?').get(w.id) as { thread_seq: number } | undefined
      if (row?.thread_seq) seqs.add(row.thread_seq)
    }
    const messages: RunConversation['messages'] = []
    for (const seq of [...seqs].sort((x, y) => x - y).slice(0, 8)) {
      let t: { root: ForumMessage; replies: ForumMessage[] }
      try {
        t = this.s().thread(seq)
      } catch {
        continue
      }
      for (const m of [t.root, ...t.replies.slice(-12)]) {
        if (m.deletedAt || m.kind === 'system') continue
        const author = this.s().member(m.authorId)
        let channelName: string | null = null
        try {
          channelName = this.s().channel(m.channelId).name
        } catch {
          channelName = null
        }
        messages.push({ id: m.id, ref: m.ref, channelId: m.channelId, channelName, threadId: m.threadId, authorId: m.authorId, authorName: author?.name ?? 'someone', authorKind: author?.kind ?? 'human', text: clip(m.text, 2000), createdAt: m.createdAt })
      }
    }
    return { runId, asked, answered, messages }
  }
}

function parse<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}
function safe<T>(f: () => T): T | null {
  try {
    return f()
  } catch {
    return null
  }
}
