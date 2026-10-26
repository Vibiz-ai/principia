/**
 * ORCHESTRATOR.md §3: the chief of staff. One per company, level-triggered and serialised (like the dispatcher and the
 * plan pilot), between runs, on every harness.
 *
 * Events (a run ended, a task was done or created, an ask was answered, a person posted, the daily tick) are debounced
 * for 2 minutes and handled as one batch per company. Events the coordinator causes itself never retrigger it: while
 * it acts on a company, that company's events are dropped, and the tasks it files carry `orch:` external ids.
 *
 * Gates, in order: the setting is on (and the board), the company is not paused, it is under its monthly cap, and,
 * for the model only, its daily budget has calls left (else rules only, and the batch says so).
 *
 * Rules first (coordinatorRules.ts); the model (coordinatorCall.ts) only for what the rules call ambiguous, in model
 * mode. Every decision, from rules or the model, goes through `apply`, which knows six verbs (pump, wake_task,
 * ask_agent, file_task, suggest, digest_post) and refuses everything else in code. A manual agent's work is only ever
 * suggested. Each batch is one row of orch_decisions, shown in Activity as "Principia (chief of staff)" (and on the
 * tasks it touched). Shadow mode records what it would do.
 */
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { departmentsEnabled, type BoardTask } from '../../shared/company'
import {
  COORDINATOR_LIMITS,
  ORCH_VERBS,
  type OrchDecision,
  type OrchDecisionRecord,
  type OrchDecisionResult,
  type OrchestratorSettings,
  type OrchEvent,
  type OrchEventKind,
  type OrchVerb,
  type RunReport
} from '../../shared/orchestrator'
import type { CompanyStore } from '../company'
import { queueCountsFrom, route } from '../company/router'
import type { ForumService } from '../forum/service'
import type { CoordinatorCallInput, CoordinatorCallResult } from './coordinatorCall'
import { coordinatorRules, type RulesInput, type RulesReport } from './coordinatorRules'
import type { Mailbox } from './mailbox'
import type { Suggestions } from './suggestions'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const OPEN = (t: BoardTask) => t.status !== 'done' && t.status !== 'canceled'
const HOUR = 3_600_000
/** tasks the chief of staff files per company per rolling hour */
export const COORDINATOR_TASKS_PER_HOUR = 5
export const WHO = 'Principia (chief of staff)'

/**
 * Verbs Principia never runs on its own, whoever proposes them, with the plain reason. Anything outside ORCH_VERBS is
 * refused too; these only get a clearer sentence.
 */
const NEVER: [RegExp, string][] = [
  [/spend|pay|buy|purchase|charge|invoice|refund|budget|top.?up/i, 'Principia never spends money without your yes'],
  [/publish|deploy|release|launch|go.?live|merge|push/i, 'Principia never publishes anything without your yes'],
  [/email|send|tweet|sms|slack|message_external|external|outreach|post_external/i, 'Principia never sends messages outside the company'],
  [/delete|remove|archive|drop|wipe|destroy/i, 'Principia never deletes anything'],
  [/approve|close|cancel|done|complete|reject/i, 'Only you approve or close tasks'],
  [/create_company|company|create_department|department|hire|fire/i, 'Only you create companies or departments']
]
export function refusal(verb: string): string | null {
  if ((ORCH_VERBS as readonly string[]).includes(verb)) return null
  for (const [re, why] of NEVER) if (re.test(verb)) return why
  return 'Not something Principia does on its own'
}

export interface CoordinatorDeps {
  db: Database.Database
  company: () => CompanyStore
  /** the setting this company runs with (orchestratorFor) */
  settings: (companyId: string) => OrchestratorSettings
  /** experimental.companies + .departments */
  boardFlags: () => { companies?: boolean; departments?: boolean } | null | undefined
  /** this month's value reached the company's monthly cap */
  overCap: (companyId: string) => boolean
  /** one model call of the company's daily budget (shared with the fallback extractor), or false */
  takeBudget: (companyId: string, perDay: number) => boolean
  /** the model call (coordinatorCall); null = no CLI */
  model?: ((input: CoordinatorCallInput, companyId: string) => Promise<CoordinatorCallResult | null>) | null
  /** Dispatcher.pump */
  pump: (companyId: string) => void
  /** Dispatcher.addWake */
  wakeTask: (taskId: string, reason: string) => void
  mailbox: Pick<Mailbox, 'send'>
  forum: () => ForumService | null
  suggestions: Suggestions
  redact?: (s: string) => string
  /** the model call's tokens (usage source 'orchestrator') */
  usage?: (companyId: string, r: CoordinatorCallResult) => void
  onChange?: (companyId: string) => void
  now?: () => Date
  timers?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

interface Pending { events: OrchEvent[]; first: number; timer: unknown }

export class Coordinator {
  private readonly pending = new Map<string, Pending>()
  private readonly chains = new Map<string, Promise<OrchDecisionRecord | null>>()
  /** companies the coordinator is acting on right now: their events are its own, never a new batch */
  private readonly acting = new Set<string>()
  /** one model call at a time, for the whole app */
  private modelLock: Promise<unknown> = Promise.resolve()
  private readonly runsSeen = new Set<string>()
  private disposed = false

  constructor(private readonly d: CoordinatorDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }
  private timers() {
    return (
      this.d.timers ?? {
        set: (fn: () => void, ms: number) => {
          const t = setTimeout(fn, ms)
          t.unref?.()
          return t
        },
        clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout)
      }
    )
  }
  private on(companyId: string): OrchestratorSettings | null {
    if (!departmentsEnabled(this.d.boardFlags())) return null
    const s = this.d.settings(companyId)
    return s.mode === 'off' || s.coordinator === 'off' ? null : s
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.pending.values()) if (p.timer) this.timers().clear(p.timer)
    this.pending.clear()
  }

  // ---------- events ----------

  /** One event; false when dropped (off, self-caused). Debounced into the company's next batch. */
  event(e: Omit<OrchEvent, 'id' | 'at'>): boolean {
    if (this.disposed || !e.companyId || this.acting.has(e.companyId) || !this.on(e.companyId)) return false
    // a task the chief of staff filed is its own doing
    if (e.kind === 'task_created' && e.taskId) {
      try {
        if ((this.d.company().task(e.taskId).externalId ?? '').startsWith('orch:')) return false
      } catch {
        return false
      }
    }
    const now = this.now().getTime()
    const ev: OrchEvent = { ...e, id: `oev_${randomBytes(5).toString('hex')}`, at: new Date(now).toISOString(), ...(e.text ? { text: clip(flat(e.text), 400) } : {}) }
    const p = this.pending.get(e.companyId) ?? { events: [], first: now, timer: null }
    if (p.events.length < 200) p.events.push(ev)
    if (p.timer) this.timers().clear(p.timer)
    const wait = Math.max(0, Math.min(COORDINATOR_LIMITS.debounceMs, p.first + COORDINATOR_LIMITS.maxWaitMs - now))
    p.timer = this.timers().set(() => void this.flush(e.companyId), wait)
    this.pending.set(e.companyId, p)
    return true
  }

  /** A run hook: once per terminal run of a company (after the applier). */
  runEnded(runId: string): boolean {
    if (this.runsSeen.has(runId)) return false
    let row: { company_id: string | null; task_id: string | null; agent_id: string | null } | undefined
    try {
      row = this.d.db.prepare('SELECT company_id, task_id, agent_id FROM runs WHERE id=?').get(runId) as typeof row
    } catch {
      row = undefined
    }
    if (!row?.company_id || (!row.task_id && !row.agent_id)) return false
    this.runsSeen.add(runId)
    if (this.runsSeen.size > 2000) for (const id of [...this.runsSeen].slice(0, 1000)) this.runsSeen.delete(id)
    return this.event({ kind: 'run_ended', companyId: row.company_id, runId, taskId: row.task_id, agentId: row.agent_id })
  }

  /** The daily tick: every company with the layer on gets one 'tick' event a day. */
  tick(companyIds: string[]): void {
    const day = this.now().toISOString().slice(0, 10)
    for (const id of companyIds) {
      const key = `tick:${id}:${day}`
      if (this.runsSeen.has(key)) continue
      if (this.event({ kind: 'tick', companyId: id })) this.runsSeen.add(key)
    }
  }

  pendingFor(companyId: string): OrchEvent[] {
    return this.pending.get(companyId)?.events ?? []
  }

  // ---------- the batch ----------

  /** Handles the company's pending batch now (serialised per company). */
  flush(companyId: string): Promise<OrchDecisionRecord | null> {
    const prev = this.chains.get(companyId) ?? Promise.resolve(null)
    const next = prev.then(
      () => this.run(companyId),
      () => this.run(companyId)
    )
    this.chains.set(companyId, next)
    void next.finally(() => {
      if (this.chains.get(companyId) === next) this.chains.delete(companyId)
    })
    return next
  }

  private async run(companyId: string): Promise<OrchDecisionRecord | null> {
    const p = this.pending.get(companyId)
    this.pending.delete(companyId)
    if (p?.timer) this.timers().clear(p.timer)
    if (!p?.events.length || this.disposed) return null
    // gates 1-3: the setting, the pause, the monthly cap
    const s = this.on(companyId)
    if (!s) return null
    const c = this.d.company()
    try {
      // a skipped batch leaves a trace in Activity (once every few hours, not one per batch)
      if (c.isPaused(companyId)) return this.skippedBatch(companyId, p.events, 'The company is paused, so Principia did nothing after these events.')
      if (this.d.overCap(companyId)) return this.skippedBatch(companyId, p.events, 'The company reached its monthly spending cap, so Principia did nothing after these events.')
    } catch {
      return null
    }
    let input: RulesInput
    try {
      input = this.snapshot(companyId, p.events)
    } catch (e) {
      this.d.log?.warn('coordinator: snapshot failed', { companyId, error: String(e) })
      return null
    }
    const rules = coordinatorRules(input)
    const decisions: (OrchDecision & { by: 'rules' | 'model' })[] = rules.decisions.map((x) => ({ ...x, by: 'rules' as const }))
    let mode: 'rules' | 'model' = 'rules'
    let note: string | null = null
    let tokens = 0
    // gate 4: the model, only for what the rules could not decide, only in model mode, only with budget left
    if (s.coordinator === 'model' && rules.ambiguous.length) {
      if (!this.d.model) note = 'No Claude or Codex sign-in for the AI step, so Principia followed its rules.'
      else if (!this.d.takeBudget(companyId, s.callsPerDay)) note = `Today's ${s.callsPerDay} AI calls for this company are used up, so Principia followed its rules.`
      else {
        const res = await this.callModel(companyId, input, rules.ambiguous, rules.decisions)
        if (!res) note = 'The AI step did not answer in time, so Principia followed its rules.'
        else {
          mode = 'model'
          tokens = res.usage.tokensIn + res.usage.tokensOut
          try {
            this.d.usage?.(companyId, res)
          } catch {
            /* bookkeeping */
          }
          for (const x of res.decisions) decisions.push({ ...x, by: 'model' })
        }
      }
    }
    if (!decisions.length && !note) return null
    const id = `odc_${randomBytes(6).toString('hex')}`
    const shadow = s.mode === 'shadow'
    const results: OrchDecisionResult[] = []
    this.acting.add(companyId)
    try {
      const seen = new Set<string>()
      const max = COORDINATOR_LIMITS.decisions + 4
      let applied = 0
      for (const [i, x] of decisions.entries()) {
        const key = `${x.verb}:${x.task ?? ''}:${x.kind ?? ''}:${norm(x.title ?? x.text ?? '').slice(0, 60)}`
        if (seen.has(key)) continue
        seen.add(key)
        // one batch acts on at most `max` decisions; the rest are written down, never dropped without a word
        if (applied >= max) {
          results.push({ verb: x.verb, status: 'skipped', detail: `Too much for one batch, left for the next one: ${clip(x.title ?? x.text ?? x.verb, 160)}` })
          continue
        }
        applied++
        results.push(this.apply(companyId, id, i, x, { shadow, by: x.by, autopilot: input.autopilot, runId: p.events.find((e) => e.runId)?.runId ?? null }))
      }
    } finally {
      this.acting.delete(companyId)
    }
    const kinds = [...new Set(p.events.map((e) => e.kind))] as OrchEventKind[]
    const rec: OrchDecisionRecord = { id, companyId, events: kinds, mode, note, results, costTokens: tokens, createdAt: this.now().toISOString() }
    this.d.db
      .prepare('INSERT INTO orch_decisions(id,company_id,event_ids,events_json,mode,note,decisions_json,cost_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, companyId, JSON.stringify(p.events.map((e) => e.id).slice(0, 200)), JSON.stringify(kinds), mode, note, JSON.stringify(results), tokens, rec.createdAt)
    if (results.some((r) => r.status === 'done')) {
      try {
        this.d.onChange?.(companyId)
      } catch {
        /* UI refresh */
      }
    }
    this.d.log?.info('coordinator: batch', { companyId, events: p.events.length, mode, decisions: results.length })
    return rec
  }

  /** One "did nothing, because" row in Activity; the same reason is written at most once in 6 hours. */
  private skippedBatch(companyId: string, events: OrchEvent[], note: string): OrchDecisionRecord | null {
    const now = this.now()
    const since = new Date(now.getTime() - 6 * 3_600_000).toISOString()
    if (this.d.db.prepare('SELECT 1 FROM orch_decisions WHERE company_id=? AND note=? AND created_at>=? LIMIT 1').get(companyId, note, since)) return null
    const id = `odc_${randomBytes(6).toString('hex')}`
    const kinds = [...new Set(events.map((e) => e.kind))] as OrchEventKind[]
    const rec: OrchDecisionRecord = { id, companyId, events: kinds, mode: 'rules', note, results: [], costTokens: 0, createdAt: now.toISOString() }
    this.d.db
      .prepare('INSERT INTO orch_decisions(id,company_id,event_ids,events_json,mode,note,decisions_json,cost_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, companyId, JSON.stringify(events.map((e) => e.id).slice(0, 200)), JSON.stringify(kinds), 'rules', note, '[]', 0, rec.createdAt)
    return rec
  }

  private async callModel(companyId: string, x: RulesInput, ambiguous: string[], decided: OrchDecision[]): Promise<CoordinatorCallResult | null> {
    const c = this.d.company()
    const name = (() => {
      try {
        return c.passport(companyId).name
      } catch {
        return 'the company'
      }
    })()
    const byId = new Map(x.tasks.map((t) => [t.id, t]))
    const agentName = (id: string | null | undefined) => (id ? x.agents.find((a) => a.id === id)?.name ?? 'an agent' : 'someone')
    const red = (s: string) => (this.d.redact ? this.d.redact(s) : s)
    const input: CoordinatorCallInput = {
      companyName: name,
      events: x.events.slice(0, 30).map((e) => red(`${e.kind.replace('_', ' ')}${e.taskId && byId.get(e.taskId) ? ` ${byId.get(e.taskId)!.identifier}` : ''}${e.agentId ? ` (${agentName(e.agentId)})` : ''}${e.text ? `: ${e.text}` : ''}`)),
      ambiguous: ambiguous.map(red),
      board: x.tasks
        .filter((t) => t.status !== 'done' && t.status !== 'canceled')
        .slice(0, 40)
        .map((t) => red(`${t.identifier} · ${t.status}${t.blockReason ? ` (${t.blockReason})` : ''} · ${t.agentId ? `@${x.agents.find((a) => a.id === t.agentId)?.handle ?? '?'}` : 'unassigned'} · ${clip(t.title, 120)}`)),
      agents: x.agents.map((a) => `@${a.handle ?? '?'} · ${a.name} · ${a.paused ? 'paused' : a.auto ? 'starts on its own' : 'starts only when the founder presses Start'}`),
      decided: decided.map((d) => `${d.verb}${d.title ? `: ${d.title}` : ''}${d.why ? ` (${d.why})` : ''}`)
    }
    const run = this.modelLock.then(() => this.d.model!(input, companyId).catch(() => null))
    this.modelLock = run.catch(() => null)
    return run
  }

  /** The company as the rules read it. */
  private snapshot(companyId: string, events: OrchEvent[]): RulesInput {
    const c = this.d.company()
    const forum = this.d.forum()
    const tasks = c.listTasks(companyId)
    const agents = c.departments.listAgents({ companyId })
    const runIds = [...new Set(events.filter((e) => e.runId).map((e) => e.runId!))]
    const reports: RulesReport[] = []
    for (const id of runIds) {
      const r = this.d.db.prepare('SELECT report_json, applied_at, created_at FROM orch_run_reports WHERE run_id=?').get(id) as { report_json: string | null; applied_at: string | null; created_at: string } | undefined
      if (!r?.report_json) continue
      try {
        const ev = events.find((e) => e.runId === id)
        reports.push({ runId: id, taskId: ev?.taskId ?? null, agentId: ev?.agentId ?? null, report: JSON.parse(r.report_json) as RunReport, at: r.applied_at ?? r.created_at })
      } catch {
        /* a broken row reads as no report */
      }
    }
    const since = new Date(this.now().getTime() - 14 * 24 * HOUR).toISOString()
    const routineHistory: RulesInput['routineHistory'] = []
    for (const r of this.d.db.prepare("SELECT report_json, created_at FROM orch_run_reports WHERE company_id=? AND created_at>=? AND report_json LIKE '%routine%' ORDER BY created_at LIMIT 500").all(companyId, since) as { report_json: string; created_at: string }[]) {
      try {
        for (const sg of (JSON.parse(r.report_json) as RunReport).suggestions ?? []) if (sg.kind === 'routine') routineHistory.push({ text: sg.text, ...(sg.cron ? { cron: sg.cron } : {}), at: r.created_at })
      } catch {
        /* skip */
      }
    }
    const lastDigest = this.d.db.prepare("SELECT created_at FROM orch_decisions WHERE company_id=? AND decisions_json LIKE '%\"verb\":\"digest_post\",\"status\":\"done\"%' ORDER BY created_at DESC LIMIT 1").get(companyId) as { created_at: string } | undefined
    return {
      companyId,
      now: this.now().toISOString(),
      events,
      tasks: tasks.map((t) => ({ id: t.id, identifier: t.identifier, title: t.title, status: t.status, blockReason: t.blockReason ?? null, agentId: t.agentId ?? null, dependencyIds: t.dependencyIds ?? [], source: t.source, externalId: t.externalId ?? null, asks: !!t.ask && !t.ask.answer, updatedAt: t.updatedAt })),
      agents: agents.filter((a) => !a.archivedAt).map((a) => ({ id: a.id, name: a.data.persona?.name || a.name, handle: forum?.store.memberForAgent(a.id)?.handle ?? null, auto: a.data.autonomy === 'auto', paused: !!a.pausedAt })),
      autopilot: c.boardSettings(companyId).autopilot,
      reports,
      routineHistory,
      lastDigestAt: lastDigest?.created_at ?? null
    }
  }

  // ---------- the closed set of verbs ----------

  private task(companyId: string, ref: string | undefined): BoardTask | null {
    if (!ref) return null
    const c = this.d.company()
    const all = c.listTasks(companyId)
    const r = ref.trim().replace(/^#/, '')
    return all.find((t) => t.id === r) ?? all.find((t) => t.identifier.toLowerCase() === r.toLowerCase()) ?? null
  }
  private agentOf(companyId: string, ref: string | undefined) {
    if (!ref) return null
    const c = this.d.company()
    const agents = c.departments.listAgents({ companyId }).filter((a) => !a.archivedAt)
    const byId = agents.find((a) => a.id === ref)
    if (byId) return byId
    const h = ref.trim().replace(/^@/, '').toLowerCase()
    const m = this.d.forum()?.store.memberByHandle(companyId, h)
    return (m?.agentId ? agents.find((a) => a.id === m.agentId) : null) ?? null
  }
  private note(taskId: string, text: string, kind: 'woke' | 'updated' = 'updated'): void {
    try {
      this.d.company().activity(taskId, kind, clip(`${WHO}: ${text}`, 2000), 'system')
    } catch {
      /* the activity line is a courtesy */
    }
  }
  private text(s: string | undefined, n: number = COORDINATOR_LIMITS.text): string {
    const t = flat(s ?? '')
    return clip(this.d.redact ? this.d.redact(t) : t, n)
  }

  /** One decision through the closed set of verbs. Never throws. */
  apply(companyId: string, decisionId: string, i: number, x: OrchDecision, o: { shadow: boolean; by: 'rules' | 'model'; autopilot: boolean; runId: string | null }): OrchDecisionResult {
    const no = refusal(x.verb)
    if (no) return { verb: x.verb, status: 'refused', detail: `Refused "${clip(x.verb, 40)}": ${no}` }
    const verb = x.verb as OrchVerb
    const why = x.why ? ` (${this.text(x.why, 200)})` : ''
    try {
      switch (verb) {
        case 'pump': {
          if (o.shadow) return { verb, status: 'shadow', detail: `Would start the tasks that are ready${why}` }
          this.d.pump(companyId)
          return { verb, status: 'done', detail: `Started the tasks that were ready${why}` }
        }
        case 'wake_task': {
          const t = this.task(companyId, x.task)
          if (!t) return { verb, status: 'skipped', detail: `No task ${clip(x.task ?? '?', 40)} in this company` }
          if (!OPEN(t)) return { verb, status: 'skipped', detail: `${t.identifier} is closed` }
          const a = t.agentId ? this.d.company().departments.getAgent(t.agentId) : null
          const text = this.text(x.text || x.why || 'Pick this up again.')
          // a manual agent's work is only ever suggested
          if (!a || a.data.autonomy !== 'auto') return this.suggestTask(companyId, t, a?.name ?? null, text, o, verb)
          if (o.shadow) return { verb, status: 'shadow', detail: `Would give ${t.identifier} a note: ${clip(text, 160)}`, ref: t.identifier }
          this.d.wakeTask(t.id, `${WHO}: ${text}`)
          this.note(t.id, `woke ${t.identifier}: ${clip(text, 300)}`, 'woke')
          return { verb, status: 'done', detail: `Gave ${t.identifier} a note for its next turn: ${clip(text, 160)}`, ref: t.identifier }
        }
        case 'ask_agent': {
          const from = this.agentOf(companyId, x.from)
          if (!from) return { verb, status: 'skipped', detail: `No agent ${clip(x.from ?? '?', 40)} to ask from` }
          if (!x.to || !x.text) return { verb, status: 'skipped', detail: 'A question needs a teammate and the question' }
          if (o.shadow) return { verb, status: 'shadow', detail: `Would have ${from.name} ask ${x.to}: ${clip(this.text(x.text), 160)}` }
          const runId = o.runId ?? `orch:${decisionId}`
          const res = this.d.mailbox.send({ companyId, fromAgentId: from.id, fromRunId: runId, fromTaskId: null, to: x.to, question: this.text(x.text), why: this.text(x.why ?? '', 300), blocking: false, opKey: `orch:${decisionId}:ask:${i}` })
          return { verb, status: res.status === 'sent' ? 'done' : res.status === 'skipped' ? 'skipped' : 'refused', detail: res.status === 'sent' ? `${from.name} ${res.detail}` : `Not asked: ${res.detail}`, ...(res.ref ? { ref: res.ref } : {}) }
        }
        case 'file_task':
          return this.fileTask(companyId, decisionId, i, x, o)
        case 'suggest': {
          const kind = x.kind ?? 'task'
          if (kind === 'task' && x.task) {
            const t = this.task(companyId, x.task)
            if (!t) return { verb, status: 'skipped', detail: `No task ${clip(x.task, 40)} to suggest` }
            const a = t.agentId ? this.d.company().departments.getAgent(t.agentId) : null
            return this.suggestTask(companyId, t, a?.data.persona?.name || a?.name || null, this.text(x.text ?? ''), o, verb, x.title)
          }
          const title = this.text(x.title ?? x.text, 160)
          if (!title) return { verb, status: 'skipped', detail: 'Nothing to suggest' }
          if (kind === 'connection' && !x.connectionId) return { verb, status: 'skipped', detail: 'A connection suggestion needs the connection' }
          if (o.shadow) return { verb, status: 'shadow', detail: `Would suggest to you: ${title}` }
          const agent = kind === 'routine' ? this.agentOf(companyId, x.to) : null
          const res = this.d.suggestions.suggest({ companyId, kind, title, detail: this.text(x.text ?? '', 600), ...(x.cron ? { cron: x.cron } : {}), ...(x.connectionId ? { connectionId: x.connectionId } : {}), ...(agent ? { agentId: agent.id } : {}) })
          return { verb, status: res.status === 'created' ? 'done' : 'skipped', detail: res.status === 'created' ? `Suggested to you in Needs you: ${title}` : `Not suggested (${res.detail}): ${title}` }
        }
        case 'digest_post': {
          const text = this.text(x.text, COORDINATOR_LIMITS.digest)
          if (!text) return { verb, status: 'skipped', detail: 'Nothing to post' }
          const forum = this.d.forum()
          if (!forum || !forum.enabled()) return { verb, status: 'skipped', detail: 'The Forum is off' }
          if (o.shadow) return { verb, status: 'shadow', detail: `Would post in the Team room: ${clip(text, 200)}` }
          // the rules' daily digest: once a day; a post the model decided: once per decision
          const day = this.now().toISOString().slice(0, 10)
          const opKey = o.by === 'rules' ? `orch:digest:${companyId}:${day}` : `orch:${decisionId}:post:${i}`
          const m = forum.postAsPrincipia({ companyId, text, opKey })
          return m ? { verb, status: 'done', detail: `Posted the team's digest in the Team room: ${clip(text, 200)}`, ref: m.ref } : { verb, status: 'failed', detail: 'The digest could not be posted' }
        }
      }
    } catch (e) {
      return { verb: x.verb, status: 'failed', detail: `Could not ${x.verb.replace('_', ' ')}: ${clip(e instanceof Error ? e.message : String(e), 200)}` }
    }
  }

  private suggestTask(companyId: string, t: BoardTask, agentName: string | null, text: string, o: { shadow: boolean }, verb: OrchVerb, title?: string): OrchDecisionResult {
    if (t.status !== 'backlog' && t.status !== 'todo' && !(t.status === 'blocked' && t.blockReason !== 'deps')) return { verb, status: 'skipped', detail: `${t.identifier} is already moving` }
    const head = title ? this.text(title, 160) : `Start ${t.identifier}${agentName ? ` for ${agentName}` : ''}: ${clip(t.title, 100)}`
    if (o.shadow) return { verb, status: 'shadow', detail: `Would suggest to you: ${head}`, ref: t.identifier }
    const res = this.d.suggestions.suggest({ companyId, kind: 'task', title: head, detail: text || `${agentName ?? 'Its agent'} works only when you start it.`, taskId: t.id, taskIdentifier: t.identifier, ...(t.agentId ? { agentId: t.agentId } : {}) })
    if (res.status === 'created') this.note(t.id, `suggested you start ${t.identifier}: ${clip(head, 200)}`)
    return { verb, status: res.status === 'created' ? 'done' : 'skipped', detail: res.status === 'created' ? `Suggested to you in Needs you: ${head}` : `Not suggested (${res.detail}): ${head}`, ref: t.identifier }
  }

  /** A new task: Backlog unless its agent starts on its own and Autopilot is on; a manual agent's is suggested too. */
  private fileTask(companyId: string, decisionId: string, i: number, x: OrchDecision, o: { shadow: boolean; autopilot: boolean }): OrchDecisionResult {
    const verb: OrchVerb = 'file_task'
    const title = this.text(x.title ?? '', 200)
    if (!title) return { verb, status: 'skipped', detail: 'A task needs a title' }
    const c = this.d.company()
    const all = c.listTasks(companyId)
    const same = all.find((t) => OPEN(t) && norm(t.title) === norm(title))
    if (same) return { verb, status: 'skipped', detail: `"${clip(title, 120)}" is already on the board as ${same.identifier}`, ref: same.identifier }
    const hourAgo = new Date(this.now().getTime() - HOUR).toISOString()
    if (all.filter((t) => (t.externalId ?? '').startsWith('orch:') && t.createdAt >= hourAgo).length >= COORDINATOR_TASKS_PER_HOUR) return { verb, status: 'skipped', detail: `Not filed: Principia already filed ${COORDINATOR_TASKS_PER_HOUR} tasks in the last hour (${clip(title, 120)})` }
    const departments = c.departments.list(companyId)
    const agents = c.departments.listAgents({ companyId })
    const named = this.agentOf(companyId, x.to)
    const dep = !named && x.to ? departments.find((d) => d.key === x.to!.replace(/^[@#]/, '').toLowerCase() && !d.archivedAt) ?? null : null
    const draft = { companyId, title, description: '', source: 'agent' as const, sourceUrl: null, status: 'todo' as const, departmentId: named?.departmentId ?? dep?.id ?? null, agentId: named?.id ?? null }
    const r = route(draft, { departments, agents, queueCounts: queueCountsFrom(all), explicitBy: 'rule' })
    const agent = r.agentId ? agents.find((a) => a.id === r.agentId) ?? null : null
    const auto = agent?.data.autonomy === 'auto' && o.autopilot
    if (o.shadow) return { verb, status: 'shadow', detail: `Would file "${clip(title, 120)}" for ${agent?.name ?? 'no agent yet'} (${auto ? 'To do' : 'Backlog'})` }
    const t = c.createTask({
      companyId,
      title,
      description: clip(`${this.text(x.text ?? '', 4000)}\n\nFiled by ${WHO}.`.trim(), 8000),
      repoId: null,
      status: auto ? 'todo' : 'backlog',
      priority: 0,
      source: 'agent',
      sourceUrl: null,
      externalId: `orch:${decisionId}:${i}`,
      assigneeProfileId: null,
      parentId: null,
      dependencyIds: [],
      departmentId: r.departmentId,
      agentId: r.agentId ?? null
    })
    this.note(t.id, `filed ${t.identifier}${x.why ? ` (${this.text(x.why, 200)})` : ''}`)
    if (agent && agent.data.autonomy !== 'auto') this.suggestTask(companyId, t, agent.data.persona?.name || agent.name, '', { shadow: false }, verb)
    return { verb, status: 'done', detail: `Filed ${t.identifier} "${clip(title, 120)}" for ${agent?.name ?? 'no agent yet'}: ${auto ? 'it starts on its own' : agent ? `${agent.name} waits for you, so it is in Backlog` : 'it waits in Backlog for you to assign'}`, ref: t.identifier }
  }

  // ---------- Activity ----------

  /** The latest batches of a company (Activity, Team & autonomy). */
  recent(companyId: string, limit = 20): OrchDecisionRecord[] {
    const rows = this.d.db.prepare('SELECT * FROM orch_decisions WHERE company_id=? ORDER BY created_at DESC LIMIT ?').all(companyId, Math.min(100, Math.max(1, limit))) as {
      id: string
      company_id: string
      events_json: string
      mode: string
      note: string | null
      decisions_json: string
      cost_tokens: number
      created_at: string
    }[]
    return rows.map((r) => {
      let events: OrchEventKind[] = []
      let results: OrchDecisionResult[] = []
      try {
        events = JSON.parse(r.events_json) as OrchEventKind[]
        results = JSON.parse(r.decisions_json) as OrchDecisionResult[]
      } catch {
        /* a broken row reads as empty */
      }
      return { id: r.id, companyId: r.company_id, events, mode: r.mode === 'model' ? 'model' : 'rules', note: r.note, results, costTokens: r.cost_tokens, createdAt: r.created_at }
    })
  }
}
