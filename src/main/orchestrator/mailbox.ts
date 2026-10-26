/**
 * ORCHESTRATOR.md §2: the mailbox. A question in a run report ("questions": [{to:"@livia", …}]) reaches its teammate on
 * whatever harness that teammate runs, without the asking agent needing any tool:
 *
 * 1. the existing collab guards decide first (hops, cycle, thread, target, asker, company per day), with the asking
 *    run as provenance;
 * 2. Principia posts the ask card in the Forum as the asker ("via Principia"), so the founder sees every message;
 * 3. delivery: a teammate with a task in flight gets the question in that task's pendingWake (its next turn's inbox);
 *    otherwise the responder starts a short reply run for it (responder.wakeForAgent, any adapter: its final answer is
 *    posted for it and answers the ask);
 * 4. when the ask is answered (a reply run, a forum_reply, an `answers` entry in a run report, a person), a blocking
 *    question wakes the asker's task with the answer.
 *
 * Both paths (this and forum_ask_agent over MCP) write `forum_agent_wakes` rows, so the Agent talk panel shows them all;
 * this one with via `report`.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ForumMember, ForumMessage } from '../../shared/forum'
import type { CompanyStore } from '../company'
import type { ForumService } from '../forum/service'
import type { ForumCaller } from '../forum/agentApi'
import type { Teammate } from '../forum/roster'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const HOUR = 3_600_000
/**
 * A task asks the same teammate at most this many questions in 6 hours. Each woken turn of a task is a new run, so the
 * collab chain starts again at hop 1: this, and never repeating a question, is what stops two agents waking each other.
 */
export const ASKS_PER_TASK_TARGET = 2

export interface MailboxDeps {
  db: Database.Database
  forum: () => ForumService | null
  company: () => CompanyStore
  /** Dispatcher.addWake: a system wake on a task (coalesced while in flight; a parked task gets its follow-up turn) */
  wakeTask: (taskId: string, reason: string) => void
  now?: () => Date
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

export interface MailRequest {
  companyId: string
  fromAgentId: string
  fromRunId: string
  fromTaskId: string | null
  /** '@handle' or '@department' */
  to: string
  question: string
  why: string
  blocking: boolean
  /** idempotency key (run id + index) */
  opKey: string
}

export interface MailResult {
  status: 'sent' | 'refused' | 'skipped'
  detail: string
  ref?: string
  delivery?: 'task' | 'seat'
}

export interface InboxItem { kind: 'question' | 'answer'; id: string; ref: string; text: string }

interface MailRow {
  id: string; company_id: string; message_id: string; ref: string; from_agent: string | null; from_run: string | null; from_task: string | null
  to_member: string; to_agent: string | null; question: string; blocking: number; delivery: string; status: string; answer: string | null
  created_at: string; answered_at: string | null; asked_seen_run: string | null; answer_seen_run: string | null
}

export class Mailbox {
  constructor(private readonly d: MailboxDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }

  /** This company's agent teammates (ORCHESTRATOR.md §1.1, the context's roster). */
  roster(companyId: string): Teammate[] {
    const forum = this.d.forum()
    if (!forum) return []
    try {
      forum.store.sync(companyId)
      return forum.store.roster(companyId)
    } catch {
      return []
    }
  }

  /** The agent member `to` names: an agent handle, or a department's first active agent. */
  resolve(companyId: string, to: string): ForumMember | null {
    const forum = this.d.forum()
    if (!forum) return null
    const h = to.trim().replace(/^[@#]/, '').toLowerCase()
    if (!h) return null
    // a handle, else a name or role the agent wrote ("Marcus, Brand Voice Writer"), in this company only
    const m = forum.store.agentByName(companyId, to)
    if (m) return m
    const c = this.d.company()
    const dep = c.departments.byKey(companyId, h)
    if (!dep || dep.archivedAt) return null
    for (const a of c.departments.listAgents({ companyId, departmentId: dep.id })) {
      if (a.archivedAt || a.pausedAt || a.kind !== 'profile') continue
      if (c.store.getProfile(a.refId)?.adapter === 'shell') continue
      const am = forum.store.memberForAgent(a.id)
      if (am && am.status === 'active') return am
    }
    return null
  }

  /** One question from a run report. Never throws. */
  send(req: MailRequest): MailResult {
    try {
      const forum = this.d.forum()
      if (!forum || !forum.enabled()) return { status: 'refused', detail: 'the Forum is off, so teammates cannot be asked' }
      forum.store.sync(req.companyId)
      const asker = forum.store.memberForAgent(req.fromAgentId)
      if (!asker || asker.status !== 'active') return { status: 'refused', detail: 'the asking agent has no Forum seat' }
      const target = this.resolve(req.companyId, req.to)
      if (!target) {
        const mates = forum.store.roster(req.companyId).filter((t) => t.agentId !== req.fromAgentId).slice(0, 8).map((t) => `@${t.handle}`).join(', ')
        return { status: 'refused', detail: `no teammate ${req.to} in this company${mates ? ` (teammates: ${mates})` : ''}` }
      }
      // the agent already asked this teammate itself during the run (forum_ask_agent or a mention): never twice
      const asked = this.d.db.prepare("SELECT 1 FROM forum_agent_wakes WHERE from_run=? AND to_member=? AND via!='report' LIMIT 1").get(req.fromRunId, target.id)
      if (asked) return { status: 'skipped', detail: `already asked @${target.handle} during the run` }
      // one question per teammate per run (the report is applied once; this also covers a second entry for the same teammate)
      const prev = this.d.db.prepare('SELECT ref FROM orch_mailbox WHERE from_run=? AND to_member=? LIMIT 1').get(req.fromRunId, target.id) as { ref: string } | undefined
      if (prev) return { status: 'skipped', detail: `already sent (${prev.ref})`, ref: prev.ref }
      // across the turns of one task: never the same question twice, and only a few to the same teammate
      if (req.fromTaskId) {
        const since = new Date(this.now().getTime() - 6 * HOUR).toISOString()
        const earlier = this.d.db.prepare('SELECT ref, question, status, answer FROM orch_mailbox WHERE from_task=? AND to_member=? AND created_at>=? ORDER BY created_at DESC').all(req.fromTaskId, target.id, since) as { ref: string; question: string; status: string; answer: string | null }[]
        const same = earlier.find((e) => norm(e.question) === norm(req.question))
        if (same) return { status: 'skipped', detail: same.status === 'answered' ? `already asked @${target.handle} that (${same.ref}), and they answered: ${clip(flat(same.answer ?? ''), 200)}` : `already asked @${target.handle} that (${same.ref}); the answer is on its way`, ref: same.ref }
        if (earlier.length >= ASKS_PER_TASK_TARGET) {
          return { status: 'refused', detail: `this task already asked @${target.handle} ${earlier.length} questions in the last 6 hours; the founder can step in` }
        }
      }
      const caller: ForumCaller = { companyId: req.companyId, memberId: asker.id, runId: req.fromRunId, stepId: null, taskId: req.fromTaskId }
      const v = forum.collab.check(caller, target, null)
      const home = forum.homeChannel(req.companyId, asker.id)
      if (v.refusal) {
        const note = forum.collab.recordRefusal(caller, target, v.refusal, req.why || req.question, home?.id ?? '', 'report')
        return { status: 'refused', detail: note }
      }
      const channelId = forum.homeChannel(req.companyId, target.id)?.id ?? home?.id ?? null
      const text = `@${target.handle} ${flat(req.question)}${req.why ? `\n(why: ${flat(req.why)})` : ''}`
      const msg = forum.postAsAgent({ companyId: req.companyId, agentId: req.fromAgentId, runId: req.fromRunId, text, channelId, ask: { status: 'open', to: [target.id], taskId: null, runId: req.fromRunId }, opKey: req.opKey })
      if (!msg) return { status: 'refused', detail: 'the ask could not be posted' }
      // delivery: into the teammate's task in flight, else a short reply run on its own harness
      const inflight = target.agentId ? (this.d.db.prepare("SELECT id, run_id FROM company_tasks WHERE agent_id=? AND status='in_progress' AND run_id IS NOT NULL LIMIT 1").get(target.agentId) as { id: string; run_id: string } | undefined) : undefined
      const reason = `Question from @${asker.handle} (${msg.ref}): ${clip(flat(req.question), 600)}${req.why ? ` (why: ${clip(flat(req.why), 200)})` : ''}. Answer it in your run report's "answers" with ref "${msg.ref}", or reply in the Forum thread.`
      const res = forum.collab.request(caller, msg, [target], 'report', req.why || '', {
        deliver: inflight
          ? () => {
              this.d.wakeTask(inflight.id, reason)
              return { runId: inflight.run_id, queued: false }
            }
          : undefined
      })
      const out = res[0]
      const status = !out || out.status === 'refused' ? 'refused' : 'open'
      this.d.db
        .prepare('INSERT INTO orch_mailbox(id,company_id,message_id,ref,from_agent,from_run,from_task,to_member,to_agent,question,blocking,delivery,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(`omb_${randomBytes(6).toString('hex')}`, req.companyId, msg.id, msg.ref, req.fromAgentId, req.fromRunId, req.fromTaskId, target.id, target.agentId, clip(req.question, 2000), req.blocking ? 1 : 0, inflight ? 'task' : 'seat', status, this.now().toISOString())
      if (status === 'refused') return { status: 'refused', detail: out?.note || `@${target.handle} could not be reached`, ref: msg.ref }
      return { status: 'sent', detail: inflight ? `asked @${target.handle} (${msg.ref}); it reaches their task in flight` : `asked @${target.handle} (${msg.ref}); a short reply run answers it`, ref: msg.ref, delivery: inflight ? 'task' : 'seat' }
    } catch (e) {
      this.d.log?.warn('orchestrator mailbox: send failed', { runId: req.fromRunId, error: String(e) })
      return { status: 'refused', detail: `could not ask ${req.to}: ${clip(String(e instanceof Error ? e.message : e), 160)}` }
    }
  }

  /**
   * ForumService.onAskAnswered: an ask got its answer. A mailbox ask (a run report's question) wakes the asker's task
   * when it was blocking. An ask an agent made with the Forum tool from a task run (forum_ask_agent, or forum_ask to
   * agents) picks that task back up the same way, unless the agent was still waiting for it in the same turn
   * (`waited`: the tool returned the answer). Never throws.
   */
  onAnswered(m: ForumMessage, opts: { waited?: boolean } = {}): void {
    try {
      if (m.kind !== 'ask' || m.ask?.status !== 'answered') return
      const row = this.d.db.prepare("SELECT * FROM orch_mailbox WHERE message_id=? AND status='open'").get(m.id) as MailRow | undefined
      const answer = clip(m.ask.answer ?? '', 2000)
      const by = m.ask.answeredBy ? this.d.forum()?.store.member(m.ask.answeredBy) : null
      const who = `@${by?.handle ?? 'a teammate'}`
      if (row) {
        this.d.db.prepare("UPDATE orch_mailbox SET status='answered', answer=?, answered_at=? WHERE id=? AND status='open'").run(answer, this.now().toISOString(), row.id)
        if (!row.blocking || !row.from_task) return
        this.d.db.prepare('UPDATE orch_mailbox SET answer_seen_run=? WHERE id=?').run('wake', row.id)
        this.resumeAsker(row.from_task, row.ref, who, answer)
        return
      }
      // a Forum-tool ask from a task run (an ask with its own task id is the board's: tasks:answer resumes it)
      if (m.ask.taskId || opts.waited || !m.ask.runId) return
      const taskId = this.askingTask(m.ask.runId, m.authorId)
      if (!taskId || m.ask.answeredBy === m.authorId) return
      this.resumeAsker(taskId, m.ref, who, answer)
    } catch (e) {
      this.d.log?.warn('orchestrator mailbox: answer hook failed', { messageId: m.id, error: String(e) })
    }
  }

  /**
   * AgentCollab.onReplied: a teammate replied in the thread of a question an agent asked by @mentioning it from a task
   * run (forum_post or forum_reply with a question). The asking task picks the reply up like an answer. Asks are
   * handled by onAnswered; report questions by the mailbox rows. Never throws.
   */
  onReplied(e: { rows: { via: string; from_run: string | null; from_member: string; to_member: string; message_seq: number }[]; text: string }): void {
    try {
      const forum = this.d.forum()
      if (!forum) return
      const seen = new Set<string>()
      for (const r of e.rows) {
        if (r.via !== 'mention' || !r.from_run) continue
        let asked: ForumMessage
        try {
          asked = forum.store.message(r.message_seq)
        } catch {
          continue
        }
        // only a question wakes the asker: an FYI mention that got a reply is just conversation
        if (asked.kind === 'ask' || !asked.text.includes('?') || asked.authorId !== r.from_member) continue
        const taskId = this.askingTask(r.from_run, r.from_member)
        if (!taskId || seen.has(taskId)) continue
        seen.add(taskId)
        const who = `@${forum.store.member(r.to_member)?.handle ?? 'a teammate'}`
        this.resumeAsker(taskId, asked.ref, who, clip(e.text, 2000))
      }
    } catch (err) {
      this.d.log?.warn('orchestrator mailbox: reply hook failed', { error: String(err) })
    }
  }

  /** The board task of the run an agent member asked from, or null (a reply run, a chat, another agent's run). */
  private askingTask(runId: string, memberId: string): string | null {
    const run = this.d.db.prepare('SELECT task_id, agent_id FROM runs WHERE id=?').get(runId) as { task_id: string | null; agent_id: string | null } | undefined
    const taskId = run?.task_id ?? (this.d.db.prepare('SELECT id FROM company_tasks WHERE run_id=? LIMIT 1').get(runId) as { id: string } | undefined)?.id ?? null
    if (!taskId) return null
    const member = this.d.forum()?.store.member(memberId)
    if (!member || member.kind !== 'agent' || (run?.agent_id && member.agentId !== run.agent_id)) return null
    return taskId
  }

  /**
   * The answer reaches the asking task once, in its next turn's wake (the context, the Activity line and the Forum
   * brief do not repeat it). The wake starts the follow-up turn (an automatic agent with Autopilot on), or the task
   * waits: then its Activity line says so, and a task its agent parked on this question goes back to To do (a manual
   * agent's waits for Start).
   */
  private resumeAsker(taskId: string, ref: string, who: string, answer: string): void {
    const c = this.d.company()
    const before = c.task(taskId)
    if (before.status === 'done' || before.status === 'canceled') return
    this.d.wakeTask(taskId, `Answer to your question ${ref} from ${who}: ${clip(flat(answer), 1500)}`)
    const t = c.task(taskId)
    if (t.status === 'done' || t.status === 'canceled') return
    const agent = t.agentId ? c.departments.getAgent(t.agentId) : null
    const name = agent?.data.persona?.name || agent?.name || 'The agent'
    if (t.status === 'in_progress') {
      // the wake started the follow-up turn (or reaches the turn in flight): the founder still sees why
      const now = t.runId && t.runId !== before.runId ? 'picks it up now' : 'gets it on its next turn'
      c.activity(t.id, 'woke', clip(`Principia: ${who} answered ${ref} (the answer is in the Forum thread). ${name} ${now}.`, 2000), 'system')
      return
    }
    const manual = agent?.data.autonomy !== 'auto' || !c.boardSettings(t.companyId).autopilot
    const next = t.ask && !t.ask.answer ? 'after you answer its question' : t.status === 'blocked' && t.blockReason === 'limit' ? 'once you Unpark it (it was parked after too many automatic wakes)' : manual ? 'when you press Start' : 'on its next turn'
    c.resumeOnAnswer(t.id, clip(`Principia: ${who} answered ${ref} (the answer is in the Forum thread). ${name} picks it up ${next}.`, 2000))
  }

  /**
   * The agent's inbox for a run's context: open questions to it, and answers to its own questions it has not seen.
   * `delta` (a resumed turn): only what no earlier run of it was shown. Marks what it returns as seen by `runId`.
   */
  inbox(agentId: string, runId: string, delta: boolean, limit = 6): InboxItem[] {
    const handle = (memberId: string | null) => (memberId ? this.d.forum()?.store.member(memberId)?.handle ?? 'a teammate' : 'a teammate')
    const fromHandle = (agentId: string | null) => (agentId ? this.d.forum()?.store.memberForAgent(agentId)?.handle ?? 'a teammate' : 'a teammate')
    const qs = this.d.db
      .prepare(`SELECT * FROM orch_mailbox WHERE to_agent=? AND status='open' ${delta ? 'AND asked_seen_run IS NULL' : ''} ORDER BY created_at LIMIT ?`)
      .all(agentId, limit) as MailRow[]
    const as = this.d.db
      // an answer delivered by a wake is already in the task's prompt: never twice
      .prepare(`SELECT * FROM orch_mailbox WHERE from_agent=? AND status='answered' AND answer_seen_run IS NULL ORDER BY answered_at LIMIT ?`)
      .all(agentId, limit) as MailRow[]
    const out: InboxItem[] = []
    for (const q of qs) out.push({ kind: 'question', id: q.id, ref: q.ref, text: `${q.ref} from @${fromHandle(q.from_agent)}: ${clip(flat(q.question), 500)}` })
    for (const a of as) out.push({ kind: 'answer', id: a.id, ref: a.ref, text: `${a.ref} @${handle(a.to_member)} answered your question "${clip(flat(a.question), 160)}": ${clip(flat(a.answer ?? ''), 600)}` })
    const seenQ = this.d.db.prepare('UPDATE orch_mailbox SET asked_seen_run=COALESCE(asked_seen_run, ?) WHERE id=?')
    const seenA = this.d.db.prepare('UPDATE orch_mailbox SET answer_seen_run=? WHERE id=?')
    for (const q of qs) seenQ.run(runId, q.id)
    for (const a of as) seenA.run(runId, a.id)
    return out
  }
}
