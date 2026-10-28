/**
 * DEPARTMENTS.md §3: the dispatcher, owned by Hive. Level-triggered: every trigger (task create / update / comment /
 * answer, a run end, boot after reconcile(), a schedule fire, a Slack trigger, the 60 s tick) calls pump(companyId?),
 * serialized per company. A pump heals dependency blocks, then gives every eligible agent its next task:
 *
 * - eligible = not paused or archived, `autonomy:'auto'`, headless, in a company with autopilot on and fewer than
 *   maxInFlight tasks in flight, and with fewer than AGENT_MAX_PARALLEL tasks in flight of its own (an agent works
 *   on several tasks at once; a code task whose checkout is taken gets its own worktree, CompanyStore.startTask);
 * - the exception (startsWithoutAutopilot): a schedule's standing card with a queued fire (the founder turned the
 *   schedule on) and a task whose question the founder just answered start on any active headless seat with autopilot
 *   off too (still never on a paused company, past maxInFlight or AGENT_MAX_PARALLEL, or past the wake guard);
 * - its next task = its highest-priority `todo` task, oldest first (priority 1 urgent … 4 low, 0 none last);
 * - the claim is a compare-and-set on the status mirror inside one transaction with CompanyStore.startTask, so two
 *   pumps, or a pump and a human Run, can never both start the same task (the loser skips or gets "An agent already
 *   owns this task"), nor take the agent past AGENT_MAX_PARALLEL ("<Agent> is running 3 tasks; <ID> starts when one
 *   finishes").
 *
 * Wakes for a task already in flight coalesce into `pendingWake` (+ a `coalesced` activity); at run end one follow-up
 * turn starts if the outcome is not needs_input and the wake guard allows it. Guard (§0.7): at most
 * limits.autoWakesPerHour (≤4) automatic starts per task per hour; the next one parks blocked(limit). Human actions
 * reset it. Agent comments and @-mentions never wake anyone. Nothing here ever reruns a failed, canceled or
 * interrupted task: only `todo` tasks are picked, and a run end only ever continues with queued wakes.
 *
 * Moves CompanyStore has no method for (todo or in_review → blocked(limit) / blocked(run_failed), in_review →
 * todo for a follow-up) are written here as compare-and-set updates on the status, like the claim.
 */
import { AGENT_LIMITS, AGENT_MAX_PARALLEL, agentActive, agentFullLine, startsWithoutAutopilot, trackedBy, type ActivityBy, type AutoWakes, type BlockReason, type BoardTask, type CompanyAgent, type PendingWake, type TaskStatus } from '../../shared/company'
import type { StartRunOptions, TaskRunBridge, TaskToolset } from '../../shared/engine'
import { HiveError } from '../../shared/errors'
import type { Run, RunTarget, Session } from '../../shared/types'
import { CompanyStore, type TaskRunLink } from './index'
import { needsSuggestion, queueCountsFrom, route, routedActivity, routingInUse, shouldReroute, suggestRoute, type ModelCall, type RouteContext } from './router'

export const DISPATCH_TICK_MS = 60_000

const HOUR_MS = 3_600_000
const TERMINAL = new Set(['passed', 'failed', 'canceled'])
const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const clip = (s: string, n = 200) => s.length > n ? `${s.slice(0, n - 1)}…` : s

type PtySize = { cols: number; rows: number }
/** What the dispatcher needs from the session manager (h.sessions) for "Open as session" and "Take over" (§4.4). */
export interface DispatcherSessions {
  /** `taskDepartmentId`: the task's department, so the pane's Passport block carries its slot (DEPARTMENTS.md §7) */
  create(req: { companyId: string; profileId: string; repoId: string | null; cols: number; rows: number; title: string; initialPrompt: string; resumeAgentSessionId: string | null; task?: boolean; taskDepartmentId?: string | null; taskId?: string }): Session
  isLive(id: string): boolean
  kill(id: string): Promise<unknown>
}
export interface DispatcherLog { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void }
export interface DispatcherDeps {
  company: CompanyStore
  /** h.engine.runs.start */
  startRun(target: RunTarget, opts: StartRunOptions): Run
  /** h.engine.runs.cancel */
  cancelRun(runId: string): Promise<void>
  /** experimental.companies + .departments (§0.8); off, the dispatcher does nothing at all */
  enabled(): boolean
  sessions?: DispatcherSessions | null
  /** after a pump or a dispatcher action changed tasks (data:changed tasks, status) */
  onChange?(companyId: string): void
  log?: DispatcherLog
  now?(): Date
  /**
   * §2 step 4: the model call that suggests a department for a new task rules 1-3 left in triage (routeCall.ts). null
   * (no Claude CLI) or absent = no suggestions. Never awaited by a write: the suggestion lands later, or not at all.
   */
  modelCall?(): ModelCall | null
  /** h.vault.redact, for the task text the model sees */
  redact?(text: string): string
}
/** The CompanyStore writes the dispatcher listens to (HookedCompanyStore fires them after the write). */
export interface BoardHooks {
  created(task: BoardTask): void
  updated(prev: BoardTask, next: BoardTask): void
  commented(taskId: string, message: string, by: ActivityBy): void
}

/** Wake reasons for the next turn, in arrival order (same cap as CompanyStore's). */
function addWake(w: PendingWake | null, reason: string): PendingWake {
  return { reasons: [...(w?.reasons ?? []), reason.slice(0, 4000)].slice(-50), count: (w?.count ?? 0) + 1 }
}
const RESET: AutoWakes = { windowStart: null, n: 0 }
/** Highest priority first: 1 urgent … 4 low, then 0 (no priority). */
const rank = (p: number) => p === 0 ? 5 : p

export class Dispatcher {
  private readonly chains = new Map<string, Promise<string[]>>()
  /** a pump queued but not started yet: later triggers join it instead of queueing another */
  private readonly queued = new Map<string, Promise<string[]>>()
  /** run ids whose end was handled (run.updated fires more than once) */
  private readonly ended = new Set<string>()
  /** task id → session id of an interactive lease (§4.4); also found through sessions.task_id + task.runId */
  private readonly leases = new Map<string, string>()
  /** tasks being taken over → their seat: no follow-up turn at the run end, and no pump hands the seat other work meanwhile */
  private readonly takeovers = new Map<string, string | null>()
  private timer: NodeJS.Timeout | null = null
  /** quit: nothing starts any more (the engine is canceling its runs, and each run end would otherwise pump) */
  private disposed = false
  private readonly sessionTaskCol: boolean
  /** tasks with a model suggestion in flight (one call per task) */
  private readonly suggesting = new Map<string, Promise<void>>()

  constructor(private readonly d: DispatcherDeps) {
    const cols = new Set((this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name))
    this.sessionTaskCol = cols.has('task_id')
  }
  private get c(): CompanyStore { return this.d.company }
  private get db() { return this.d.company.store.db }
  private now(): Date { return this.d.now ? this.d.now() : new Date() }
  private warn(msg: string, meta: Record<string, unknown> = {}): void { this.d.log?.warn(`dispatcher: ${msg}`, meta) }

  // ---------- lifecycle ----------

  /** Boot (after CompanyStore.reconcile parked interrupted tasks) and the 60 s tick. */
  start(tickMs = DISPATCH_TICK_MS): Promise<string[]> {
    if (this.disposed) return Promise.resolve([])
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), tickMs)
      this.timer.unref?.()
    }
    return this.pump()
  }
  /**
   * Quit, before the engine cancels its runs: stops the tick, and no pump, follow-up turn or lease check runs after it.
   * Without it every canceled run's end would pump and hand its seat the next todo task while the app exits (that run
   * would then park as interrupted at the next boot), and every pane the quit closes would park no_report.
   */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  /** One tick: closed sessions park their tasks, then every company is pumped. */
  tick(): Promise<string[]> {
    if (this.disposed || !this.d.enabled()) return Promise.resolve([])
    try { this.checkSessions() } catch (err) { this.warn('session check failed', { error: String(err) }) }
    return this.pump()
  }

  // ---------- pump ----------

  /** Heal, then pick and claim per agent. Serialized per company; resolves with the ids of the tasks it started. */
  pump(companyId?: string): Promise<string[]> {
    if (this.disposed || !this.d.enabled()) return Promise.resolve([])
    const ids = companyId ? [companyId] : this.c.listPassports().map(p => p.id)
    return Promise.all(ids.map(id => this.enqueue(id))).then(xs => xs.flat())
  }
  private enqueue(companyId: string): Promise<string[]> {
    const waiting = this.queued.get(companyId)
    if (waiting) return waiting
    const prev = this.chains.get(companyId) ?? Promise.resolve([])
    const next: Promise<string[]> = prev.catch(() => []).then(() => {
      this.queued.delete(companyId)
      try { return this.pumpNow(companyId) } catch (err) { this.warn('pump failed', { companyId, error: String(err) }); return [] }
    })
    this.queued.set(companyId, next)
    this.chains.set(companyId, next)
    void next.finally(() => { if (this.chains.get(companyId) === next) this.chains.delete(companyId) })
    return next
  }
  /** One synchronous pass over a company (better-sqlite3: nothing interleaves inside it). */
  private pumpNow(companyId: string): string[] {
    if (this.disposed || !this.d.enabled()) return []
    let changed = false
    try { changed = this.c.heal(companyId).length > 0 } catch (err) { this.warn('heal failed', { companyId, error: String(err) }) }
    const started: string[] = []
    if (this.roomFor(companyId, false) > 0) {
      for (const agent of this.c.departments.listAgents({ companyId })) {
        if (this.roomFor(companyId, false) <= 0) break
        if (!agentActive(agent) || agent.data.mode === 'session' || this.full(agent.id) || this.takingOver(agent.id)) continue
        // autopilot picks any todo task of an auto seat; without it, work the founder already said go to still starts:
        // a schedule's queued fire (they turned the schedule on) and the answer they just gave to a question
        const auto = this.seatEligible(agent) && this.autopilotRoom(companyId) > 0
        for (const t of this.queueOf(agent)) {
          if (!auto && !startsWithoutAutopilot(t)) continue
          // five doors C9: a task the founder paused waits for their Start (a comment from them wakes it again)
          if (this.heldByYou(t.id)) continue
          const r = this.claim(t.id, agent, !auto)
          if (r !== 'skipped') changed = true
          if (r === 'started') started.push(t.id)
          // one start (or one failed start) per agent per pump; a parked task lets the next one through
          if (r === 'started' || r === 'failed') break
        }
      }
    }
    if (changed) this.d.onChange?.(companyId)
    return started
  }
  /** Room left under maxInFlight, 0 when autopilot is off or the company is archived. */
  private autopilotRoom(companyId: string): number { return this.roomFor(companyId, true) }
  /** Room left under maxInFlight (0 when archived or paused, and with `autopilot` also when autopilot is off). */
  private roomFor(companyId: string, autopilot: boolean): number {
    const company = this.c.scope.get(companyId)
    if (!company || company.archivedAt) return 0
    // five doors A4: autopilot reads "Off while paused" and starts nothing until the company resumes
    if (this.c.isPaused(companyId)) return 0
    const s = this.c.boardSettings(companyId)
    if (autopilot && !s.autopilot) return 0
    return s.maxInFlight - this.inFlight(companyId)
  }
  private inFlight(companyId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND status='in_progress' AND run_id IS NOT NULL").get(companyId) as { n: number }).n
  }
  /** A Take over between its cancel and its session: the seat is the human's, not free for the next task. */
  private takingOver(agentId: string): boolean {
    for (const a of this.takeovers.values()) if (a === agentId) return true
    return false
  }
  /** The seat already runs AGENT_MAX_PARALLEL tasks: nothing more starts on it by itself (a human Run now still does). */
  private full(agentId: string): boolean {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE agent_id=? AND status='in_progress'").get(agentId) as { n: number }).n >= AGENT_MAX_PARALLEL
  }
  /** §3.2 seat gates (autopilot and room are the company's). Session-mode seats start only from a human click. */
  private seatEligible(a: CompanyAgent): boolean {
    return agentActive(a) && a.data.autonomy === 'auto' && a.data.mode !== 'session'
  }
  /** "Pause this task": the task's latest activity is the founder's pause (Start or a comment of theirs comes after it). */
  private heldByYou(taskId: string): boolean {
    const last = this.db.prepare('SELECT kind, actor FROM company_task_activity WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) as { kind: string; actor: string | null } | undefined
    return last?.kind === 'paused' && last.actor === 'human'
  }
  /** The seat's todo tasks, highest priority first, oldest first. */
  private queueOf(agent: CompanyAgent): BoardTask[] {
    // a plan's tasks are the plan pilot's (PLANS.md §2.4): never picked here, even in To do
    const rows = this.db.prepare("SELECT seq, data FROM company_tasks WHERE company_id=? AND agent_id=? AND status='todo' AND json_extract(data,'$.plan') IS NULL ORDER BY seq").all(agent.companyId, agent.id) as { seq: number; data: string }[]
    return rows.map(r => ({ seq: r.seq, t: this.c.task(JSON.parse(r.data).id as string) }))
      .sort((a, b) => rank(a.t.priority) - rank(b.t.priority) || a.seq - b.seq).map(x => x.t)
  }

  /**
   * §3.3 claim + §3.4 start, in one transaction: the wake guard, the compare-and-set, a `woke` activity, startTask as
   * the system (autopilot gate re-checked there) and the guard count. A lost race changes nothing ('skipped').
   */
  private claim(taskId: string, agent: CompanyAgent, scheduled = false): 'started' | 'parked' | 'skipped' | 'failed' {
    let runId: string | null = null
    try {
      return this.db.transaction(() => {
        const t = this.c.task(taskId)
        if (t.status !== 'todo' || t.agentId !== agent.id) return 'skipped'
        // a todo task saved while departments were off may still wait on its dependencies: lock it (§1.4), never park it
        if (!this.depsDone(t)) return this.moveRaw(t.id, ['todo'], { status: 'blocked', blockReason: 'deps' }, 'parked', 'Waiting for its dependencies') ? 'parked' : 'skipped'
        const guard = this.guard(t, agent)
        if (!guard) return this.parkGuard(t, agent) ? 'parked' : 'skipped'
        if (!this.cas(t.id, agent.id)) return 'skipped'
        const reasons = t.pendingWake?.reasons.length ? t.pendingWake.reasons : ['Assigned: this task is yours.']
        this.c.activity(t.id, 'woke', `Woke ${agent.name}: ${clip(reasons.join(' · '))}`)
        this.c.startTask(t.id, undefined, this.starter(agent, id => { runId = id }), { actor: 'system', consented: scheduled })
        this.c.patchInFlight(t.id, { autoWakes: guard })
        return 'started' as const
      })()
    } catch (err) {
      // a run that started before a later write threw lost its row and its task with the rollback: stop it
      if (runId) void this.d.cancelRun(runId).catch(() => undefined)
      // the transaction rolled back (no claim, no run row): park it so it shows in Needs you instead of retrying every tick
      const message = err instanceof Error ? err.message : String(err)
      this.warn('automatic start failed', { taskId, agentId: agent.id, error: message })
      this.moveRaw(taskId, ['todo'], { status: 'blocked', blockReason: 'run_failed' }, 'parked', `Could not start automatically: ${clip(message, 300)}`)
      return 'failed'
    }
  }
  private depsDone(t: BoardTask): boolean {
    return t.dependencyIds.every(id => { try { return this.c.task(id).status === 'done' } catch { return false } })
  }
  /**
   * UPDATE … WHERE id=? AND status='todo' AND (the agent's other in-flight tasks) < AGENT_MAX_PARALLEL. Only the mirror;
   * startTask writes the row. The JSON status is checked too: an older build sharing the db writes only the JSON (§11).
   */
  private cas(taskId: string, agentId: string): boolean {
    return this.db.prepare(`UPDATE company_tasks SET status='in_progress' WHERE id=? AND status='todo'
      AND json_valid(data) AND json_extract(data,'$.status')='todo'
      AND (SELECT COUNT(*) FROM company_tasks o WHERE o.agent_id=? AND o.status='in_progress' AND o.id<>?) < ?`).run(taskId, agentId, taskId, AGENT_MAX_PARALLEL).changes === 1
  }
  /**
   * §3.6: the next autoWakes, or null when this automatic start would exceed limits.autoWakesPerHour within the last
   * hour (rolling). A row from before `at` counts its n wakes at windowStart, so they expire when its window did.
   */
  private guard(t: BoardTask, agent: CompanyAgent | null): AutoWakes | null {
    const limit = wakeLimit(agent)
    const now = this.now().getTime()
    const w = t.autoWakes ?? RESET
    const start = w.windowStart ? Date.parse(w.windowStart) : NaN
    const past = w.at ?? (Number.isNaN(start) ? [] : Array.from({ length: Math.min(w.n, limit) }, () => w.windowStart!))
    const recent = past.filter(s => { const x = Date.parse(s); return !Number.isNaN(x) && now - x < HOUR_MS })
    if (recent.length >= limit) return null
    const at = [...recent, new Date(now).toISOString()]
    return { windowStart: at[0], n: at.length, at }
  }
  private parkGuard(t: BoardTask, agent: CompanyAgent | null): boolean {
    const limit = wakeLimit(agent)
    return this.moveRaw(t.id, [t.status], { status: 'blocked', blockReason: 'limit' }, 'parked',
      `Parked: ${limit} automatic wakes within an hour. Review it, then Unpark or Run now.`)
  }
  /**
   * A compare-and-set status move with no CompanyStore method (see the module comment). Only from `from`; writes the
   * JSON and the mirror in one statement plus one activity. Returns whether the move happened.
   */
  private moveRaw(taskId: string, from: TaskStatus[], to: { status: TaskStatus; blockReason: BlockReason | null }, kind: 'parked' | 'woke', message: string): boolean {
    const marks = from.map(() => '?').join(',')
    const r = this.db.prepare(`UPDATE company_tasks SET status=?, data=json_set(data,'$.status',?,'$.blockReason',?,'$.updatedAt',?) WHERE id=? AND status IN (${marks})`)
      .run(to.status, to.status, to.blockReason, this.now().toISOString(), taskId, ...from)
    if (r.changes) this.c.activity(taskId, kind, message)
    return r.changes === 1
  }
  /** startTask's engine call: trigger 'task', the run's task and seat, a Claude resume id, the seat's time cap. */
  private starter(agent: CompanyAgent | null, onRun?: (runId: string) => void) {
    return (target: RunTarget, companyId: string, link: TaskRunLink): Run => {
      const run = this.d.startRun(target, {
        trigger: 'task', companyId, taskId: link.taskId, agentId: link.agentId, resumeSessionId: link.resumeSessionId, title: link.title ?? null,
        runMinutes: agent?.data.limits?.runMinutes ?? null
      })
      onRun?.(run.id)
      return run
    }
  }

  // ---------- human starts ----------

  /** "Run now": a human start (no autopilot gate), never held by a busy agent: it works on this task beside the others. */
  runNow(taskId: string, profileId?: string): BoardTask {
    const t = this.c.task(taskId)
    const agent = t.agentId ? this.c.departments.getAgent(t.agentId) : null
    this.c.startTask(taskId, profileId, this.starter(agent), { actor: 'human' })
    const out = this.c.patchInFlight(taskId, { autoWakes: RESET })
    this.d.onChange?.(out.companyId)
    return out
  }

  // ---------- wakes ----------

  /**
   * A schedule fire on its standing card while the last fire's result waits in review or was accepted: back to todo for
   * this fire's turn (like a follow-up turn, §3.5). The report stays in the activity; the founder turned the schedule on.
   */
  reopenForFire(taskId: string, scheduleName: string): boolean {
    return this.moveRaw(taskId, ['in_review', 'done'], { status: 'todo', blockReason: null }, 'woke', `Schedule "${clip(scheduleName, 80)}" fired again: the next turn starts (the last report stays above)`)
  }

  /**
   * A wake for a task (human comment, Slack follow-up, schedule fire on a standing card). Agent wakes are dropped
   * (agent comments never wake anyone). In flight: coalesced into pendingWake (+ `coalesced`). Otherwise the reason is
   * queued for the task's next turn. A human wake resets the guard. Then the company is pumped.
   */
  wake(taskId: string, reason: string, by: ActivityBy): BoardTask | null {
    if (by === 'agent') return null
    const t = this.c.task(taskId)
    if (t.status === 'done' || t.status === 'canceled') return t
    const pendingWake = addWake(t.pendingWake, reason)
    const out = this.c.patchInFlight(taskId, { pendingWake, ...(by === 'human' ? { autoWakes: RESET } : {}) })
    if (t.status === 'in_progress') this.c.activity(taskId, 'coalesced', `Coalesced ×${pendingWake.count}: ${clip(reason.replace(/\s+/g, ' ').trim())}`, by)
    this.d.onChange?.(t.companyId)
    void this.pump(t.companyId)
    return out
  }

  /**
   * ORCHESTRATOR.md §2: Principia's own wake for a task (a teammate's question for its seat, the answer to a question it
   * asked). Like a system wake: coalesced into pendingWake while in flight, queued for the next turn otherwise; and a
   * task its run left in review or blocked by the agent gets its follow-up turn now (same guard, autopilot and seat gates
   * as a run end). Never throws.
   */
  addWake(taskId: string, reason: string): BoardTask | null {
    try {
      const out = this.wake(taskId, reason, 'system')
      if (out && out.status !== 'in_progress') this.followUp(this.c.task(taskId))
      return out
    } catch (err) {
      this.warn('wake failed', { taskId, error: String(err) })
      return null
    }
  }

  /** runHooks: every run.updated. At a task run's end: sync (idempotent), capture the session, follow up, pump. */
  onRunUpdated(run: Run): void {
    if (!TERMINAL.has(run.status) || this.ended.has(run.id)) return
    const ids = (this.db.prepare('SELECT id FROM company_tasks WHERE run_id=?').all(run.id) as { id: string }[]).map(r => r.id)
    if (!ids.length) return
    this.ended.add(run.id)
    if (this.ended.size > 2000) for (const id of [...this.ended].slice(0, 1000)) this.ended.delete(id)
    // §0.8: with departments off a plain task's next Run stays a fresh prompt (no conversation to resume)
    const on = this.d.enabled()
    if (on && run.status !== 'failed') this.captureSession(run.id)
    try { this.c.syncRun(run) } catch (err) { this.warn('run sync failed', { runId: run.id, error: String(err) }) }
    for (const id of ids) {
      let t: BoardTask
      try { t = this.c.task(id) } catch { continue }
      // a failed turn may be a dead --resume (conversation gone): the next turn starts fresh with the full prompt
      // instead of failing the same way on every retry
      if (run.status === 'failed' && t.agentSessionId && t.status !== 'in_progress') {
        try { t = this.c.patchInFlight(id, { agentSessionId: null }) } catch (err) { this.warn('clearing the session failed', { taskId: id, error: String(err) }) }
      }
      // only a turn that ended by itself continues: a human Stop, a failure or a time cap never follows up, whatever
      // the agent reported before it ended
      if (run.status === 'passed' && !this.takeovers.has(id)) this.followUp(t)
      this.d.onChange?.(t.companyId)
      void this.pump(t.companyId)
    }
  }
  /**
   * §3.5: wakes that arrived during the run get one follow-up turn, when the run passed and did not end on a question,
   * the task ended in review or blocked by the agent (a failed, canceled or capped run never continues by itself), the seat
   * may start automatically and the guard allows it (else it parks blocked(limit)).
   */
  private followUp(t: BoardTask): void {
    if (this.disposed || !t.pendingWake?.count || (t.ask && !t.ask.answer) || t.plan) return
    const from = t.status === 'in_review' ? 'in_review' : t.status === 'blocked' && t.blockReason === 'agent' ? 'blocked' : null
    const agent = t.agentId ? this.c.departments.getAgent(t.agentId) : null
    if (!from || !agent || !this.d.enabled() || !this.seatEligible(agent) || this.autopilotRoom(t.companyId) <= 0 || this.full(agent.id)) return
    try {
      this.db.transaction(() => {
        const guard = this.guard(t, agent)
        if (!guard) return void this.parkGuard(t, agent)
        const n = t.pendingWake!.count
        if (!this.moveRaw(t.id, [from], { status: 'todo', blockReason: null }, 'woke', `Follow-up turn for ${agent.name}: ${n} wake${n === 1 ? '' : 's'} arrived during the run`)) return
        if (!this.cas(t.id, agent.id)) fail(agentFullLine(agent.name, AGENT_MAX_PARALLEL, t.identifier))
        this.c.startTask(t.id, undefined, this.starter(agent), { actor: 'system' })
        this.c.patchInFlight(t.id, { autoWakes: guard })
      })()
    } catch (err) {
      // rolled back: the task stays where the run left it, with its pending wakes for the human
      this.warn('follow-up turn failed', { taskId: t.id, error: String(err) })
    }
  }
  /** §4.3 fallback for the executor's capture: the last claude step's conversation id of a run still owning its task. */
  private captureSession(runId: string): void {
    const steps = this.c.store.getRunDetail(runId)?.steps ?? []
    const last = [...steps].reverse().find(s => s.adapter === 'claude' && s.agentSessionId)
    if (last?.agentSessionId) this.sessionCaptured({ runId, agentSessionId: last.agentSessionId })
  }
  /** TaskRunBridge.sessionCaptured: task.agentSessionId of the task this run (still) owns. */
  sessionCaptured(e: { runId: string; agentSessionId: string }): void {
    if (!this.d.enabled()) return
    for (const r of this.db.prepare('SELECT data FROM company_tasks WHERE run_id=?').all(e.runId) as { data: string }[]) {
      const id = JSON.parse(r.data).id as string
      if (this.c.task(id).agentSessionId !== e.agentSessionId) this.c.patchInFlight(id, { agentSessionId: e.agentSessionId })
    }
  }

  // ---------- interactive leases (§4.4) ----------

  /**
   * "Open as session": a human start whose lease is a PTY session (stamped sessions.task_id, the prompt prefilled, a
   * Claude task resumes its conversation). The task's runId holds the session id while the lease lasts. Closing the
   * session without Submit for review or Park parks the task with no_report.
   */
  openSession(taskId: string, size: PtySize): { task: BoardTask; session: Session } {
    const sessions = this.d.sessions ?? fail('Interactive sessions are not available')
    const t = this.c.task(taskId)
    const agent = t.agentId ? this.c.departments.getAgent(t.agentId) : null
    if (agent?.kind === 'workflow') fail(`${agent.name} runs a workflow; it cannot open as a session`)
    let session: Session | null = null
    try {
      this.c.startTask(taskId, undefined, (target, companyId, link) => {
        if (target.kind !== 'prompt') fail('Only an agent profile can open as a session')
        const p = target as Extract<RunTarget, { kind: 'prompt' }>
        session = sessions.create({ companyId, profileId: p.profileId, repoId: p.repoId ?? null, cols: size.cols, rows: size.rows,
          title: clip(`${t.identifier} · ${t.title}`, 80), initialPrompt: p.prompt, resumeAgentSessionId: link.resumeSessionId,
          task: true, taskId: t.id, ...(t.departmentId ? { taskDepartmentId: t.departmentId } : {}) })
        return leaseRun(session.id, 'queued', target, companyId)
      }, { actor: 'human', lease: true })
    } catch (err) {
      if (session) void sessions.kill((session as Session).id).catch(() => undefined)
      throw err
    }
    const s = session as unknown as Session
    if (this.sessionTaskCol) this.db.prepare('UPDATE sessions SET task_id=? WHERE id=?').run(taskId, s.id)
    this.leases.set(taskId, s.id)
    const task = this.c.patchInFlight(taskId, { autoWakes: RESET })
    this.d.onChange?.(task.companyId)
    return { task, session: s }
  }
  /** "Take over": cancel the headless run (no follow-up), then open a session that resumes its conversation. */
  async takeover(taskId: string, size: PtySize): Promise<{ task: BoardTask; session: Session }> {
    const t = this.c.task(taskId)
    // a plan task runs in its milestone's worktree; a session would run in the checkout (PLANS.md §2.4)
    if (t.plan) fail(`${t.identifier} belongs to a plan and runs in its milestone's worktree, so it cannot be taken over as a session. Let the run finish, or stop it.`)
    if (t.status !== 'in_progress') fail('This task is not running')
    if (this.leaseOf(taskId)) fail('This task is already open as a session')
    const run = t.runId ? this.c.store.getRun(t.runId) : null
    if (!run || TERMINAL.has(run.status)) fail('There is no headless run to take over')
    // refuse before the run is canceled: a run that cannot become a session keeps running
    if (!this.d.sessions) fail('Interactive sessions are not available')
    const agent = t.agentId ? this.c.departments.getAgent(t.agentId) : null
    if (agent?.kind === 'workflow' || run!.target.kind !== 'prompt') fail(`${agent?.name ?? 'This agent'} runs a workflow; it cannot open as a session`)
    this.takeovers.set(taskId, t.agentId ?? null)
    try {
      this.captureSession(run!.id)
      await this.d.cancelRun(run!.id)
      const ended = this.c.store.getRun(run!.id)
      if (ended) this.c.syncRun(ended)
      if (this.c.task(taskId).status === 'in_progress') this.c.park(taskId, 'no_report', 'Taken over by you')
      const cur = this.c.task(taskId)
      this.c.patchInFlight(taskId, { pendingWake: addWake(cur.pendingWake, 'Taken over: the human continues this task with you in an interactive session.') })
      return this.openSession(taskId, size)
    } finally {
      this.takeovers.delete(taskId)
    }
  }
  /** The session holding the task, if its lease is still current (task in flight on that session). */
  leaseOf(taskId: string): string | null {
    const t = this.c.task(taskId)
    if (t.status !== 'in_progress' || !t.runId) return null
    if (this.leases.get(taskId) === t.runId) return t.runId
    if (!this.sessionTaskCol) return null
    const row = this.db.prepare('SELECT id FROM sessions WHERE id=? AND task_id=?').get(t.runId, taskId) as { id: string } | undefined
    return row?.id ?? null
  }
  /** "Submit for review" on the session row: the lease ends as a passed turn (report → its outcome, else flagged no report). */
  submitSession(taskId: string): BoardTask { return this.endLease(taskId, 'passed', null) }
  /** "Park" on the session row. */
  parkSession(taskId: string): BoardTask {
    const sid = this.leaseOf(taskId) ?? fail('This task is not open as a session')
    this.leases.delete(taskId)
    const out = this.c.park(taskId, 'no_report', `Parked from session ${sid}`)
    this.d.onChange?.(out.companyId)
    return out
  }
  /** BoardDispatcher.stop: a task held by a session (no run to cancel): close the pane, park no_report. */
  async stop(taskId: string): Promise<BoardTask> {
    const sid = this.leaseOf(taskId) ?? fail('This task is not open as a session')
    try { await this.d.sessions?.kill(sid) } catch (err) { this.warn('session kill failed', { taskId, error: String(err) }) }
    return this.endLease(taskId, 'canceled', 'Stopped by you')
  }
  /** Leases whose session is gone (closed, exited): parked no_report unless the agent reported. Called on ticks and session changes. */
  checkSessions(): void {
    // at quit the panes close with the app: the next boot's reconcile parks their tasks as interrupted
    if (this.disposed || !this.d.sessions) return
    const rows = this.sessionTaskCol
      ? this.db.prepare("SELECT t.id AS taskId, s.id AS sessionId FROM company_tasks t JOIN sessions s ON s.id=t.run_id AND s.task_id=t.id WHERE t.status='in_progress'").all() as { taskId: string; sessionId: string }[]
      : [...this.leases].map(([taskId, sessionId]) => ({ taskId, sessionId }))
    for (const r of rows) {
      if (this.d.sessions.isLive(r.sessionId) || this.leaseOf(r.taskId) !== r.sessionId) continue
      try { this.endLease(r.taskId, 'canceled', 'The session closed before Submit for review or Park') } catch (err) { this.warn('closing a session lease failed', { taskId: r.taskId, error: String(err) }) }
    }
    // PROACTIVE.md §3: a chat closed while it still had tracked work in progress: the task waits for the human. AGENT
    // CHAT: so does an agent's task its chat had moved to in progress
    const tracked = this.db.prepare("SELECT id, run_id FROM company_tasks WHERE status='in_progress' AND run_id IS NOT NULL AND json_extract(data,'$.externalId') LIKE 'track:%'").all() as { id: string; run_id: string }[]
    let agentHeld: { id: string; run_id: string }[] = []
    try { agentHeld = this.db.prepare("SELECT t.id AS id, t.run_id AS run_id FROM company_tasks t JOIN sessions s ON s.id=t.run_id WHERE t.status='in_progress' AND s.company_agent_id IS NOT NULL").all() as { id: string; run_id: string }[] } catch { /* older db */ }
    const chatHeld = new Set(agentHeld.map(r => r.id))
    for (const r of [...tracked, ...agentHeld.filter(r => !tracked.some(x => x.id === r.id))]) {
      if (this.d.sessions.isLive(r.run_id)) continue
      try {
        const t = this.c.task(r.id)
        if (trackedBy(t) !== r.run_id && !(chatHeld.has(r.id) && t.runId === r.run_id)) continue
        const out = this.c.park(r.id, 'no_report', 'The chat closed before it finished this task')
        this.d.onChange?.(out.companyId)
      } catch (err) { this.warn('parking a tracked task failed', { taskId: r.id, error: String(err) }) }
    }
  }
  private endLease(taskId: string, status: 'passed' | 'canceled', reason: string | null): BoardTask {
    const sid = this.leaseOf(taskId) ?? fail('This task is not open as a session')
    const t = this.c.task(taskId)
    this.leases.delete(taskId)
    this.c.syncRun({ ...leaseRun(sid, status, null, t.companyId), reason })
    const out = this.c.task(taskId)
    this.d.onChange?.(out.companyId)
    void this.pump(out.companyId)
    return out
  }

  // ---------- routing on create / text edits (§2) ----------

  /** §2 rules 1-3 (never the model) for a new task, or an edit shouldReroute accepts; then a pump. Never throws. */
  routeTask(taskId: string, prev: BoardTask | null): void {
    if (!this.d.enabled()) return
    try {
      const t = this.c.task(taskId)
      // PROACTIVE.md §3: a chat's own tracked task stays with the chat until a human assigns it
      if (trackedBy(t) && !t.agentId) return
      const ctx = this.routeContext(t.companyId)
      if (!routingInUse(t, ctx) || !shouldReroute(prev, t)) return
      const d = route(t, ctx)
      const a = routedActivity(d, ctx)
      if (d.departmentId || d.agentId) {
        if (d.departmentId !== t.departmentId || d.agentId !== t.agentId || !t.routing) this.c.assign(taskId, { departmentId: d.departmentId, agentId: d.agentId }, 'system', { by: d.by, reason: d.reason, ...(d.confidence !== undefined ? { confidence: d.confidence } : {}) })
      }
      // a new task the rules left in triage: ask the model for a suggestion, in the background (§2 step 4)
      if (!prev && t.status === 'triage' && needsSuggestion(d)) void this.suggest(taskId)
      // an unrouted triage task edited again: one 'Not routed' line per reason, not one per edit
      if (!d.departmentId && !d.agentId) {
        const last = this.db.prepare('SELECT kind, message FROM company_task_activity WHERE task_id=? AND kind=? ORDER BY seq DESC LIMIT 1').get(taskId, a.kind) as { kind: string; message: string } | undefined
        if (last?.message === a.message) return
      }
      this.c.activity(taskId, a.kind, a.message, a.by)
    } catch (err) {
      this.warn('routing failed', { taskId, error: String(err) })
    }
  }
  /**
   * §2 step 4: one model suggestion for an unrouted triage task, stored as `routing.by:'model'` (CompanyStore
   * suggestRouting, which skips a task that moved on meanwhile) with a `routed` activity; the founder accepts it on the
   * task (tasks:acceptRoute). Off without a model call; never throws; resolves when done (tests await it).
   */
  suggest(taskId: string): Promise<void> {
    const call = this.d.modelCall?.() ?? null
    if (!call || this.disposed || !this.d.enabled()) return Promise.resolve()
    const live = this.suggesting.get(taskId)
    if (live) return live
    const run = (async () => {
      try {
        const t = this.c.task(taskId)
        const ctx = this.routeContext(t.companyId)
        const r = await suggestRoute(t, ctx, { call, ...(this.d.redact ? { redact: this.d.redact } : {}) })
        if (!r || this.disposed) return
        const stored = this.c.suggestRouting(taskId, r.routing)
        if (!stored) return
        const a = routedActivity(r.routing, ctx)
        this.c.activity(taskId, a.kind, a.message, a.by)
        this.d.onChange?.(stored.companyId)
      } catch (err) {
        this.warn('routing suggestion failed', { taskId, error: String(err) })
      } finally {
        this.suggesting.delete(taskId)
      }
    })()
    this.suggesting.set(taskId, run)
    return run
  }
  private routeContext(companyId: string): RouteContext {
    const departments = this.c.departments.list(companyId, { includeArchived: true })
    const agents = this.c.departments.listAgents({ companyId, includeArchived: true })
    return { departments, agents, queueCounts: queueCountsFrom(this.c.listTasks(companyId)) }
  }

  /** The hooks HookedCompanyStore fires: route new tasks, pump on edits, turn comments into wakes. */
  hooks(): BoardHooks {
    return {
      created: t => { this.routeTask(t.id, null); void this.pump(t.companyId) },
      updated: (prev, next) => { this.routeTask(next.id, prev); void this.pump(next.companyId) },
      commented: (taskId, message, by) => { if (this.d.enabled()) this.wake(taskId, `Comment: ${message}`, by) }
    }
  }

  /** Rail "Pause all agents" (see pauseAllAgents). */
  pauseAll(): string[] {
    const ids = pauseAllAgents(this.c)
    for (const id of ids) this.d.onChange?.(id)
    return ids
  }

}

/** §0.7: at most 4 automatic wakes per task per hour, whatever an older or hand-edited seat row says. */
function wakeLimit(agent: CompanyAgent | null): number {
  const n = agent?.data.limits?.autoWakesPerHour ?? AGENT_LIMITS.autoWakesPerHour.max
  return Math.min(AGENT_LIMITS.autoWakesPerHour.max, Math.max(AGENT_LIMITS.autoWakesPerHour.min, Number.isFinite(n) ? Math.floor(n) : AGENT_LIMITS.autoWakesPerHour.max))
}

/** Rail "Pause all agents" (§3): autopilot off for every company that has it on, archived ones included. */
export function pauseAllAgents(company: CompanyStore): string[] {
  const ids: string[] = []
  for (const p of company.listPassports({ includeArchived: true })) {
    if (!company.boardSettings(p.id).autopilot) continue
    company.setAutopilot(p.id, false)
    ids.push(p.id)
  }
  return ids
}

/** The Run shape startTask and syncRun expect, for a session lease (its id is the session's). */
function leaseRun(id: string, status: Run['status'], target: RunTarget | null, companyId: string): Run {
  return { id, kind: 'prompt', title: 'Interactive session', target: target ?? { kind: 'prompt', profileId: '', repoId: null, prompt: '' }, workflowId: null, scheduleId: null, parentRunId: null,
    trigger: 'manual', status, reason: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, artifactsDir: '', artifactCount: 0, companyId }
}

/**
 * A CompanyStore that tells the dispatcher about writes made by any caller (IPC, MCP task_create, schedules, Slack):
 * new tasks (routed), edits, and comments (wakes). A failing hook never fails the write.
 */
export class HookedCompanyStore extends CompanyStore {
  hooks: BoardHooks | null = null
  private fire(fn: (h: BoardHooks) => void): void {
    if (!this.hooks) return
    try { fn(this.hooks) } catch { /* the dispatcher logs its own failures */ }
  }
  override createTask(...args: Parameters<CompanyStore['createTask']>): BoardTask {
    const before = (this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM company_tasks').get() as { n: number }).n
    const t = super.createTask(...args)
    // a deduplicated source returns the existing task: that is not a new task
    const seq = (this.store.db.prepare('SELECT seq FROM company_tasks WHERE id=?').get(t.id) as { seq: number } | undefined)?.seq ?? 0
    if (seq > before) this.fire(h => h.created(t))
    return this.task(t.id)
  }
  override updateTask(...args: Parameters<CompanyStore['updateTask']>): BoardTask {
    const prev = this.task(args[0])
    const next = super.updateTask(...args)
    this.fire(h => h.updated(prev, next))
    return this.task(next.id)
  }
  /** LINEAR.md: a tracker's change routes and pumps like an edit */
  override applyRemote(...args: Parameters<CompanyStore['applyRemote']>): BoardTask {
    const prev = this.task(args[0])
    const next = super.applyRemote(...args)
    this.fire(h => h.updated(prev, next))
    return this.task(next.id)
  }
  override activity(...args: Parameters<CompanyStore['activity']>): ReturnType<CompanyStore['activity']> {
    const a = super.activity(...args)
    if (a.kind === 'comment') this.fire(h => h.commented(a.taskId, a.message, a.by))
    return a
  }
}

/** The engine's view of task runs (CompanyBridge.tasks), over the store and the dispatcher once it exists. */
export function taskRunBridge(o: {
  company: () => CompanyStore
  dispatcher: () => Dispatcher | null
  toolset: () => ((req: Parameters<NonNullable<TaskRunBridge['toolset']>>[0]) => TaskToolset | null) | null
  /** the redacted Passport block of a company, with a department slot (hive.passportContext) */
  passport?: (companyId: string, departmentId: string | null) => string | null
  /** WORKTREE.md: the Started task's worktree (taskWork.ts) */
  workdir?: TaskRunBridge['workdir']
}): TaskRunBridge {
  return {
    companyOf: taskId => { try { return o.company().task(taskId).companyId } catch { return null } },
    runMinutes: agentId => o.company().departments.getAgent(agentId)?.data.limits?.runMinutes ?? null,
    toolset: req => o.toolset()?.(req) ?? null,
    sessionCaptured: e => {
      const d = o.dispatcher()
      if (d) return d.sessionCaptured(e)
      const c = o.company()
      const t = c.task(e.taskId)
      if (t.runId === e.runId && t.status === 'in_progress') c.patchInFlight(t.id, { agentSessionId: e.agentSessionId })
    },
    timeLimit: e => o.company().expectStop(e.taskId, 'limit'),
    ...(o.workdir ? { workdir: o.workdir } : {}),
    ...(o.passport ? {
      passportContext: (e: { taskId: string; companyId: string }) => {
        let departmentId: string | null = null
        try { departmentId = o.company().task(e.taskId).departmentId } catch { /* unknown task: no slot */ }
        return o.passport!(e.companyId, departmentId)
      }
    } : {})
  }
}
