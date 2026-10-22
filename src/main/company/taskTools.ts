/**
 * DEPARTMENTS.md §6: the `hivetask` toolset, main's side. The tool definitions and the stdio client live in
 * taskToolDefs.ts (bundled into the MCP servers); calls arrive through the author broker (src/main/author/broker.ts),
 * which resolves the caller from the live dir the line came in (a headless step of a task run, or an interactive
 * session) and refuses a line naming another company or task. Here every handler checks again:
 *
 * - every read is scoped to the caller's company; an id of another company reads as "not found";
 * - every write is on the caller's own task, while the caller's run or session still holds it (in flight on it);
 * - no path sets `done`, edits department or agent config, cancels runs, or touches another agent's in-flight task;
 * - task_comment is redacted and written `by:'agent'`, which never wakes anyone (Dispatcher.wake drops agent wakes);
 * - task_report / task_ask set the task's report / ask; CompanyStore.syncRun turns them into the outcome at run end;
 * - task_create files a child of the current task (`source:'agent'`, routed by the dispatcher's router on create):
 *   at most 4 per task, one level deep, 10 per company per hour; blocksCurrent adds it to the current task's
 *   dependencies, so the run end leaves the task blocked(deps) until it heals;
 * - task_handoff is applied at run end (beforeSyncRun): the task goes to `todo` with the target and a `handoff`
 *   activity; a task already handed off MAX_HANDOFFS times parks blocked(handoff_cap) instead.
 *
 * Every result is a JSON object marked as data (TASK_NOTE) and fitted under TASK_MAX_OUTPUT chars.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { MAX_HANDOFFS, TASK_ASK_KINDS, type BlockReason, type BoardTask, type CompanyAgent, type Department, type PendingWake, type TaskAsk, type TaskReport, type TaskStatus } from '../../shared/company'
import type { LiveOwner, TaskRunBridge, TaskToolset } from '../../shared/engine'
import type { Run } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { assertTransition, type CompanyStore } from './index'
import { queueCountsFrom, route } from './router'
import { ReportHarvester, type HarvestStep } from './reportHarvest'
import { TASK_LIMITS, TASK_LIST_MAX, TASK_MAX_OUTPUT, TASK_MUTATIONS, TASK_NOTE, TASK_TOOLS, type TaskTool } from './taskToolDefs'
export { callTaskTool, isTaskTool, TASK_MAX_OUTPUT, TASK_MUTATIONS, TASK_NOTE, TASK_SERVER_INSTRUCTIONS, TASK_TOOL_DEFS, TASK_TOOLS, type TaskTool } from './taskToolDefs'

/** §6 caps on agent-filed tasks. */
export const TASK_CREATE_CAPS = { perTask: 4, perCompanyPerHour: 10 } as const
const HOUR_MS = 3_600_000
const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s
const OPEN = (t: BoardTask) => t.status !== 'done' && t.status !== 'canceled'
const rank = (p: number) => p === 0 ? 5 : p

/** Who is calling, resolved from the live dir owner (never from the line's content). */
export interface TaskCaller {
  kind: 'run' | 'session'
  /** the run id (headless step) or the session id */
  holderId: string
  companyId: string
  /** the task this caller works on; null for a session that holds no task */
  taskId: string | null
  /** the task's seat */
  agentId: string | null
  /** the caller's run or session still holds its task (in flight on it): writes are allowed */
  holdsTask: boolean
}
/** Line fields the server adds (HIVE_TASK_COMPANY_ID / HIVE_COMPANY_ID, HIVE_TASK_ID), as cross-checks only. */
export interface TaskLineHints { companyId?: string | null; taskId?: string | null; callId?: string | null }

export interface TaskToolsDeps {
  company: () => CompanyStore
  /** h.vault.redact: everything an agent writes, and every read it gets */
  redact?: (s: string) => string
  /** experimental.companies + .departments (§0.8); off, the toolset is not offered and every call is refused */
  enabled: () => boolean
  /** after a write (data:changed tasks) */
  onChange?: (companyId: string) => void
  /**
   * After a handoff moved a task to `todo`: pump the company (Dispatcher.pump), so an auto target wakes now. The task no
   * longer points at the ended run, so the dispatcher's run-end pump may not see it.
   */
  pump?: (companyId: string) => void
  now?: () => Date
  log?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

/** A handoff waiting for its run end. */
interface PendingHandoff { holderId: string; departmentId: string | null; agentId: string | null; reason: string; label: string }

// ---------- arguments (strict; the servers only check loosely) ----------
const idArg = z.string().trim().min(1).max(64)
const ARGS = {
  task_get: z.strictObject({ id: idArg.optional() }),
  task_list: z.strictObject({ scope: z.enum(['mine', 'department', 'open']).default('mine'), limit: z.number().int().min(1).max(TASK_LIST_MAX).default(20) }),
  task_comment: z.strictObject({ text: z.string().trim().min(1).max(TASK_LIMITS.comment) }),
  task_report: z.strictObject({
    outcome: z.enum(['review', 'blocked']),
    summary: z.string().trim().min(1).max(TASK_LIMITS.summary),
    evidence: z.array(z.string().max(TASK_LIMITS.evidenceItem)).max(TASK_LIMITS.evidence).default([])
  }),
  task_ask: z.strictObject({
    kind: z.enum(TASK_ASK_KINDS),
    prompt: z.string().trim().min(1).max(TASK_LIMITS.prompt),
    options: z.array(z.string().trim().min(1).max(TASK_LIMITS.option)).min(2).max(TASK_LIMITS.options).optional()
  }).refine(a => a.kind !== 'choice' || !!a.options?.length, { message: "A 'choice' ask needs at least 2 options", path: ['options'] }),
  task_create: z.strictObject({
    title: z.string().trim().min(1).max(TASK_LIMITS.title),
    description: z.string().max(TASK_LIMITS.description).default(''),
    departmentKey: z.string().trim().min(1).max(80).optional(),
    blocksCurrent: z.boolean().default(false)
  }),
  task_handoff: z.strictObject({
    departmentKey: z.string().trim().min(1).max(80).optional(),
    agentId: idArg.optional(),
    reason: z.string().trim().min(1).max(TASK_LIMITS.reason)
  }).refine(a => !!a.departmentKey || !!a.agentId, { message: 'Name a departmentKey or an agentId' })
}
function parseArgs<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw ?? {})
  if (r.success) return r.data
  const i = r.error.issues[0]
  return fail(`Invalid arguments: ${i.path.join('.') || '(root)'}: ${i.message}`)
}

/** Strings clipped to `maxStr`, arrays to `maxArr`, recursively. */
function shrink(v: unknown, maxStr: number, maxArr: number): unknown {
  if (typeof v === 'string') return clip(v, maxStr)
  if (Array.isArray(v)) return v.slice(0, maxArr).map(x => shrink(x, maxStr, maxArr))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, maxStr, maxArr)]))
  return v
}
/** §6: the result marked as data and never above TASK_MAX_OUTPUT chars of JSON (long text and lists shrink first). */
export function fitTaskOutput(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { note: TASK_NOTE, ...obj }
  if (JSON.stringify(out).length <= TASK_MAX_OUTPUT) return out
  for (const [s, a] of [[2000, 50], [1000, 30], [500, 20], [240, 10], [120, 5], [60, 3]] as const) {
    const fit = { ...(shrink(out, s, a) as Record<string, unknown>), note: TASK_NOTE, truncated: true }
    if (JSON.stringify(fit).length <= TASK_MAX_OUTPUT) return fit
  }
  return { note: TASK_NOTE, truncated: true, error: 'The result was too large to return. Narrow the request.' }
}
function redactDeep(v: unknown, redact: (s: string) => string): unknown {
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map(x => redactDeep(x, redact))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, redact)]))
  return v
}
function addWake(w: PendingWake | null, reason: string): PendingWake {
  return { reasons: [...(w?.reasons ?? []), reason.slice(0, 4000)].slice(-50), count: (w?.count ?? 0) + 1 }
}

export class TaskTools {
  private readonly handoffs = new Map<string, PendingHandoff>()
  readonly harvester: ReportHarvester
  private sessionTaskColumn: boolean | null = null

  constructor(private readonly d: TaskToolsDeps) {
    this.harvester = new ReportHarvester({ company: d.company, redact: d.redact, now: d.now })
  }
  /** sessions.task_id exists (healed by openDatabase); read on first use, so building the toolset touches no db */
  private get sessionTaskCol(): boolean {
    this.sessionTaskColumn ??= (this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(c => c.name === 'task_id')
    return this.sessionTaskColumn
  }
  private get c(): CompanyStore { return this.d.company() }
  private get db() { return this.d.company().store.db }
  private now(): Date { return this.d.now ? this.d.now() : new Date() }
  private redact(s: string): string { return this.d.redact ? this.d.redact(s) : s }

  // ---------- engine side (TaskRunBridge.toolset, onStepOutput) ----------

  /**
   * §6: the toolset of one headless step of a task run (claude only: Codex, Gemini and Cursor get the prompt and the
   * fenced report). The env only decides what hivemem lists; the broker resolves every call from the step's live dir.
   */
  toolset(req: Parameters<NonNullable<TaskRunBridge['toolset']>>[0]): TaskToolset | null {
    if (req.adapter !== 'claude' || !this.d.enabled()) return null
    let t: BoardTask
    try { t = this.c.task(req.taskId) } catch { return null }
    if (req.companyId && req.companyId !== t.companyId) return null
    return { env: { HIVE_TASK_ID: t.id, HIVE_TASK_COMPANY_ID: t.companyId }, toolNames: [...TASK_TOOLS] }
  }
  /** EngineContext.onStepOutput (hive.stepOutputHooks): the fenced report of a passed step (§4.5). */
  harvest(e: HarvestStep): TaskReport | null {
    if (!this.d.enabled()) return null
    try {
      const r = this.harvester.harvest(e)
      const row = r ? this.db.prepare('SELECT company_id FROM company_tasks WHERE run_id=? LIMIT 1').get(e.runId) as { company_id: string } | undefined : undefined
      if (row) this.changed(row.company_id)
      return r
    } catch (err) {
      this.d.log?.warn('task report harvest failed', { runId: e.runId, error: String(err) })
      return null
    }
  }

  // ---------- caller ----------

  /**
   * The caller of a line, from its live dir owner. A headless step: the task of its run (runs.task_id, else the task
   * holding the run). A session: its company, and the task it holds (sessions.task_id, else the task whose lease is it).
   */
  resolveCaller(owner: LiveOwner): TaskCaller {
    if (!this.d.enabled()) fail('The company board is off in this Principia')
    if ('runId' in owner) {
      let taskId: string | null = null
      try { taskId = (this.db.prepare('SELECT task_id FROM runs WHERE id=?').get(owner.runId) as { task_id: string | null } | undefined)?.task_id ?? null } catch { /* older db */ }
      taskId ??= (this.db.prepare('SELECT id FROM company_tasks WHERE run_id=? LIMIT 1').get(owner.runId) as { id: string } | undefined)?.id ?? null
      if (!taskId) fail('Task tools are only available to runs started for a board task')
      const t = this.c.task(taskId!)
      return { kind: 'run', holderId: owner.runId, companyId: t.companyId, taskId: t.id, agentId: t.agentId, holdsTask: t.status === 'in_progress' && t.runId === owner.runId }
    }
    const row = this.db.prepare(`SELECT company_id${this.sessionTaskCol ? ', task_id' : ''} FROM sessions WHERE id=?`).get(owner.sessionId) as { company_id: string | null; task_id?: string | null } | undefined
    if (!row) fail('Unknown session')
    let taskId = row!.task_id ?? null
    taskId ??= (this.db.prepare("SELECT id FROM company_tasks WHERE run_id=? AND status='in_progress' LIMIT 1").get(owner.sessionId) as { id: string } | undefined)?.id ?? null
    const t = taskId ? this.c.task(taskId) : null
    const companyId = t?.companyId ?? this.c.companyOf({ sessionId: owner.sessionId }).id
    // a session row of one company never holds another company's task
    if (t && row!.company_id && row!.company_id !== t.companyId) fail('This session belongs to another company')
    return { kind: 'session', holderId: owner.sessionId, companyId, taskId: t?.id ?? null, agentId: t?.agentId ?? null, holdsTask: !!t && t.status === 'in_progress' && t.runId === owner.sessionId }
  }
  /**
   * The broker's checks (§6) on top of resolveCaller: the line's company and task must be the caller's, and a write
   * needs the caller to hold its task. Throws the refusal.
   */
  authorize(caller: TaskCaller, tool: TaskTool, hints: TaskLineHints = {}): void {
    if (hints.companyId && hints.companyId !== caller.companyId) fail('This task tool server belongs to another company. Restart the session.')
    if (hints.taskId && hints.taskId !== caller.taskId) fail('This task tool server was started for another task')
    if (!TASK_MUTATIONS.has(tool)) return
    // task_create from a session that holds no task files a top-level task of its company
    if (tool === 'task_create' && caller.kind === 'session' && !caller.taskId) return
    if (!caller.taskId) fail('You are not working on a task')
    if (!caller.holdsTask) fail(`${this.c.task(caller.taskId!).identifier} is no longer yours to change (its run or session ended)`)
  }

  // ---------- calls ----------

  /** One authorized call. Throws HiveError with the message the agent sees. */
  call(caller: TaskCaller, tool: TaskTool, args: unknown, hints: TaskLineHints = {}): Record<string, unknown> {
    this.authorize(caller, tool, hints)
    let out: Record<string, unknown>
    switch (tool) {
      case 'task_get': out = this.get(caller, parseArgs(ARGS.task_get, args).id); break
      case 'task_list': { const a = parseArgs(ARGS.task_list, args); out = this.list(caller, a.scope, a.limit); break }
      case 'task_comment': out = this.comment(caller, parseArgs(ARGS.task_comment, args).text); break
      case 'task_report': out = this.report(caller, parseArgs(ARGS.task_report, args)); break
      case 'task_ask': out = this.ask(caller, parseArgs(ARGS.task_ask, args)); break
      case 'task_create': out = this.create(caller, parseArgs(ARGS.task_create, args), hints.callId ?? null); break
      case 'task_handoff': out = this.handoff(caller, parseArgs(ARGS.task_handoff, args)); break
      default: return fail(`Unknown tool: ${String(tool)}`)
    }
    return fitTaskOutput(redactDeep(out, s => this.redact(s)) as Record<string, unknown>)
  }

  /** A task of the caller's company by id or identifier; another company's reads as not found. */
  private find(companyId: string, ref: string): BoardTask {
    const byId = this.db.prepare('SELECT id FROM company_tasks WHERE id=? AND company_id=?').get(ref, companyId) as { id: string } | undefined
    if (byId) return this.c.task(byId.id)
    const m = /^PRN-(\d+)$/i.exec(ref)
    const bySeq = m ? this.db.prepare('SELECT id FROM company_tasks WHERE seq=? AND company_id=?').get(Number(m[1]), companyId) as { id: string } | undefined : undefined
    return bySeq ? this.c.task(bySeq.id) : fail('Task not found in this company')
  }
  private own(caller: TaskCaller): BoardTask {
    const t = this.c.task(caller.taskId ?? fail('You are not working on a task'))
    // re-checked against the row: the run or session must still hold it
    if (t.companyId !== caller.companyId || t.status !== 'in_progress' || t.runId !== caller.holderId) fail(`${t.identifier} is no longer yours to change`)
    return t
  }
  private deptName(id: string | null): Department | null { return id ? this.c.departments.get(id) : null }
  private agentRow(id: string | null): CompanyAgent | null { return id ? this.c.departments.getAgent(id) : null }
  private summary(t: BoardTask): Record<string, unknown> {
    const dep = this.deptName(t.departmentId), agent = this.agentRow(t.agentId)
    return { id: t.id, identifier: t.identifier, title: clip(t.title, 200), status: t.status, ...(t.blockReason ? { blockReason: t.blockReason } : {}),
      department: dep ? dep.key : null, agent: agent ? { id: agent.id, name: agent.name } : null, priority: t.priority, source: t.source, updatedAt: t.updatedAt }
  }
  /** Another agent's in-flight task: who has it, nothing more. */
  private foreignInFlight(caller: TaskCaller, t: BoardTask): boolean {
    return t.status === 'in_progress' && t.id !== caller.taskId && (!caller.agentId || t.agentId !== caller.agentId)
  }

  private get(caller: TaskCaller, ref: string | undefined): Record<string, unknown> {
    const t = ref ? this.find(caller.companyId, ref) : this.c.task(caller.taskId ?? fail('You are not working on a task; pass an id'))
    if (t.companyId !== caller.companyId) fail('Task not found in this company')
    if (this.foreignInFlight(caller, t)) return { task: this.summary(t), inFlight: true, detail: 'Another agent is working on this task; its details are not shared until it ends.' }
    const deps = t.dependencyIds.map(id => { try { return this.c.task(id) } catch { return null } }).filter((x): x is BoardTask => !!x && x.companyId === caller.companyId)
    const children = (this.db.prepare('SELECT id FROM company_tasks WHERE company_id=? AND json_extract(data,\'$.parentId\')=? ORDER BY seq').all(caller.companyId, t.id) as { id: string }[]).map(r => this.c.task(r.id))
    const activity = this.c.detail(t.id).activity.slice(-10).map(a => ({ at: a.createdAt, kind: a.kind, by: a.by, message: clip(a.message.replace(/\s+/g, ' ').trim(), 400) }))
    return {
      current: t.id === caller.taskId,
      task: {
        ...this.summary(t),
        description: clip(t.description, 4000), sourceUrl: t.sourceUrl, parent: t.parentId,
        dependencies: deps.map(x => ({ identifier: x.identifier, title: clip(x.title, 120), status: x.status, ...(x.doneNote ? { doneNote: clip(x.doneNote, 500) } : {}) })),
        subtasks: children.map(x => ({ identifier: x.identifier, title: clip(x.title, 120), status: x.status })),
        report: t.report, ask: t.ask, ...(t.doneNote ? { doneNote: clip(t.doneNote, 1000) } : {}), handoffs: t.handoffs
      },
      activity
    }
  }

  private list(caller: TaskCaller, scope: 'mine' | 'department' | 'open', limit: number): Record<string, unknown> {
    const all = this.c.listTasks(caller.companyId).filter(OPEN)
    let rows: BoardTask[]
    if (scope === 'mine') rows = all.filter(t => (caller.agentId && t.agentId === caller.agentId) || (caller.taskId && (t.id === caller.taskId || t.parentId === caller.taskId)))
    else if (scope === 'department') {
      const own = caller.taskId ? this.c.task(caller.taskId) : null
      const dep = own?.departmentId ?? this.agentRow(caller.agentId)?.departmentId ?? null
      if (!dep) fail("Your task has no department; use scope 'open'")
      rows = all.filter(t => t.departmentId === dep)
    } else rows = all
    rows.sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress') || rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt))
    return { scope, total: rows.length, tasks: rows.slice(0, limit).map(t => this.summary(t)) }
  }

  private comment(caller: TaskCaller, text: string): Record<string, unknown> {
    const t = this.own(caller)
    const body = this.redact(text).trim()
    if (!body) fail('The comment is empty after redaction')
    // by 'agent': an agent comment never wakes anyone (§0.7)
    this.c.activity(t.id, 'comment', body, 'agent')
    this.changed(t.companyId)
    return { ok: true, task: t.identifier }
  }

  private report(caller: TaskCaller, a: z.infer<typeof ARGS.task_report>): Record<string, unknown> {
    const t = this.own(caller)
    const report: TaskReport = { outcome: a.outcome, summary: this.redact(a.summary), evidence: a.evidence.map(e => this.redact(e.trim())).filter(Boolean), at: this.now().toISOString() }
    // exactly one closing call counts: the latest replaces an earlier ask or handoff of this turn
    this.c.patchInFlight(t.id, { report, ask: null })
    this.handoffs.delete(t.id)
    this.harvester.forget(t.id)
    this.changed(t.companyId)
    return { ok: true, task: t.identifier, outcome: a.outcome, appliedAt: 'run end', detail: a.outcome === 'review' ? 'A human reviews and approves the task; you cannot mark it done.' : 'The task waits for the human with your reason.' }
  }

  private ask(caller: TaskCaller, a: z.infer<typeof ARGS.task_ask>): Record<string, unknown> {
    const t = this.own(caller)
    const ask: TaskAsk = { kind: a.kind, prompt: this.redact(a.prompt), ...(a.options ? { options: a.options.map(o => this.redact(o)) } : {}) }
    this.c.patchInFlight(t.id, { ask, report: null })
    this.handoffs.delete(t.id)
    this.harvester.forget(t.id)
    this.changed(t.companyId)
    return { ok: true, task: t.identifier, appliedAt: 'run end', detail: 'End your turn now. The task waits for the human; you resume with the answer in a later turn.' }
  }

  private create(caller: TaskCaller, a: z.infer<typeof ARGS.task_create>, callId: string | null): Record<string, unknown> {
    const parent = caller.taskId ? this.own(caller) : null
    if (a.blocksCurrent && !parent) fail('blocksCurrent needs a current task')
    // one level deep: a subtask never files subtasks of its own
    if (parent?.parentId) fail(`${parent.identifier} is already a subtask; agents file subtasks one level deep. Report or hand off instead.`)
    const db = this.db
    // a stable source key: a replayed call (same tool-use id) returns the first task instead of filing a second (and
    // is answered before the caps, which that first task already counts toward)
    const externalId = `${caller.holderId}:${callId ? clip(callId, 120) : randomBytes(8).toString('hex')}`
    const replay = callId ? db.prepare('SELECT id FROM company_tasks WHERE company_id=? AND source_key=?').get(caller.companyId, `agent:external:${externalId}`) as { id: string } | undefined : undefined
    if (replay) {
      const t = this.c.task(replay.id)
      return { ok: true, task: this.summary(t), parent: parent?.identifier ?? null, blocksCurrent: !!parent && parent.dependencyIds.includes(t.id), replayed: true }
    }
    if (parent) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND json_extract(data,'$.parentId')=? AND json_extract(data,'$.source')='agent'").get(caller.companyId, parent.id) as { n: number }).n
      if (n >= TASK_CREATE_CAPS.perTask) fail(`${parent.identifier} already has ${n} agent-filed subtasks (limit ${TASK_CREATE_CAPS.perTask})`)
    }
    const since = new Date(this.now().getTime() - HOUR_MS).toISOString()
    const hour = (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND json_extract(data,'$.source')='agent' AND json_extract(data,'$.createdAt')>=?").get(caller.companyId, since) as { n: number }).n
    if (hour >= TASK_CREATE_CAPS.perCompanyPerHour) fail(`Agents filed ${hour} tasks in this company in the last hour (limit ${TASK_CREATE_CAPS.perCompanyPerHour}). Mention the follow-up in your report instead.`)
    let dep: Department | null = null
    if (a.departmentKey) {
      dep = this.c.departments.byKey(caller.companyId, a.departmentKey.toLowerCase())
      if (!dep || dep.archivedAt || dep.companyId !== caller.companyId) fail(`No department "${a.departmentKey}" in this company. Known: ${this.c.departments.list(caller.companyId).map(d => d.key).join(', ') || 'none'}`)
    }
    const company = this.c.passport(caller.companyId)
    const repoId = parent?.repoId && company.repoIds.includes(parent.repoId) ? parent.repoId : null
    const created = db.transaction(() => {
      const t = this.c.createTask({
        companyId: caller.companyId, title: clip(this.redact(a.title), TASK_LIMITS.title), description: this.redact(a.description), repoId,
        status: dep ? 'todo' : 'triage', priority: parent?.priority ?? 0, source: 'agent', sourceUrl: null, externalId,
        assigneeProfileId: null, parentId: parent?.id ?? null, dependencyIds: [], departmentId: dep?.id ?? null
      })
      if (a.blocksCurrent && parent) this.addDependency(parent, t.id)
      return t
    })()
    // the create hook routed it (§2); read it back
    const t = this.c.task(created.id)
    if (parent) this.c.activity(parent.id, 'comment', `Filed ${t.identifier}: ${clip(t.title, 200)}${a.blocksCurrent ? ' (this task waits for it)' : ''}`, 'agent')
    this.changed(caller.companyId)
    return { ok: true, task: this.summary(t), parent: parent?.identifier ?? null, blocksCurrent: !!(a.blocksCurrent && parent),
      ...(a.blocksCurrent && parent ? { detail: `${parent.identifier} waits for ${t.identifier} after this turn and resumes once it is done.` } : {}) }
  }
  /** blocksCurrent: the in-flight task gains a dependency (no CompanyStore method writes a task in flight). */
  private addDependency(t: BoardTask, depId: string): void {
    if (t.dependencyIds.includes(depId)) return
    if (t.dependencyIds.length >= 100) fail(`${t.identifier} has too many dependencies`)
    const r = this.db.prepare("UPDATE company_tasks SET data=json_set(data,'$.dependencyIds',json(?),'$.updatedAt',?) WHERE id=? AND status='in_progress' AND run_id IS ?")
      .run(JSON.stringify([...t.dependencyIds, depId]), this.now().toISOString(), t.id, t.runId)
    if (r.changes !== 1) fail(`${t.identifier} is no longer yours to change`)
  }

  private handoff(caller: TaskCaller, a: z.infer<typeof ARGS.task_handoff>): Record<string, unknown> {
    const t = this.own(caller)
    const departments = this.c.departments.list(t.companyId)
    const agents = this.c.departments.listAgents({ companyId: t.companyId })
    let departmentId: string | null = null
    if (a.departmentKey) {
      const dep = departments.find(d => d.key === a.departmentKey!.toLowerCase() && !d.archivedAt)
      if (!dep) fail(`No department "${a.departmentKey}" in this company. Known: ${departments.filter(d => !d.archivedAt).map(d => d.key).join(', ') || 'none'}`)
      departmentId = dep!.id
    }
    let agentId: string | null = null
    if (a.agentId) {
      const agent = agents.find(x => x.id === a.agentId && x.companyId === t.companyId && !x.archivedAt)
      if (!agent) fail('No such agent in this company')
      if (departmentId && agent!.departmentId && agent!.departmentId !== departmentId) fail(`${agent!.name} is not in ${a.departmentKey}`)
      // refused up front, so the agent gets an error rather than a target the router re-routes (§2 rule 1)
      const home = agent!.departmentId ? this.c.departments.get(agent!.departmentId) : null
      if (home?.archivedAt) fail(`${agent!.name}'s department is archived`)
      agentId = agent!.id
    }
    // §2 rules 1-2 pick the target the same way the board does (a department alone gets its eligible agent, if any)
    const d = route({ ...t, departmentId: departmentId ?? t.departmentId, agentId }, { departments, agents, queueCounts: queueCountsFrom(this.c.listTasks(t.companyId)), explicitBy: 'rule' })
    const target = { departmentId: d.departmentId, agentId: d.agentId ?? null }
    if (target.agentId && target.agentId === t.agentId && target.departmentId === t.departmentId) fail('The task is already yours; report instead')
    const depRow = this.deptName(target.departmentId), agentRow = this.agentRow(target.agentId)
    const label = `${agentRow ? agentRow.name : 'unassigned'}${depRow ? ` in ${depRow.name}` : ''}`
    // drop handoffs whose holder let go without a run end (a session parked from its row never reaches syncRun)
    for (const [id, p] of this.handoffs) {
      if (id !== t.id && !this.db.prepare("SELECT 1 FROM company_tasks WHERE id=? AND run_id=? AND status='in_progress'").get(id, p.holderId)) this.handoffs.delete(id)
    }
    this.handoffs.set(t.id, { holderId: caller.holderId, departmentId: target.departmentId, agentId: target.agentId, reason: this.redact(a.reason), label })
    // the handoff replaces an earlier report or ask of this turn
    this.c.patchInFlight(t.id, { report: null, ask: null })
    this.harvester.forget(t.id)
    const capped = t.handoffs >= MAX_HANDOFFS
    return { ok: true, task: t.identifier, target: { department: depRow?.key ?? null, agent: agentRow ? { id: agentRow.id, name: agentRow.name } : null }, appliedAt: 'run end',
      handoffsLeft: Math.max(0, MAX_HANDOFFS - t.handoffs - 1),
      detail: capped ? `${t.identifier} was already handed off ${MAX_HANDOFFS} times: at run end it waits for the human (handoff_cap).` : `End your turn now. ${label} takes the task when your run ends.` }
  }

  // ---------- run end ----------

  /**
   * Called right before CompanyStore.syncRun (wire.ts wraps it): applies the pending handoff of a task whose run
   * passed. A failed or canceled run drops it (syncRun parks the task as usual). Never throws.
   */
  beforeSyncRun(run: Pick<Run, 'id' | 'status'>): void {
    if (!['passed', 'failed', 'canceled'].includes(run.status)) return
    for (const [taskId, h] of [...this.handoffs]) {
      if (h.holderId !== run.id) continue
      this.handoffs.delete(taskId)
      if (run.status !== 'passed') continue
      try { this.applyHandoff(taskId, h) } catch (err) {
        // rolled back: syncRun ends the turn as usual (no report → in_review flagged); the human sees why
        this.d.log?.warn('task handoff failed', { taskId, error: String(err) })
        // not a comment: a comment wakes the task, and a failing handoff must not loop the agent through follow-up turns
        try { this.c.activity(taskId, 'handoff', `Handoff to ${h.label} failed: ${clip(err instanceof Error ? err.message : String(err), 300)}`) } catch { /* the task is gone */ }
      }
    }
  }
  private applyHandoff(taskId: string, h: PendingHandoff): void {
    const c = this.c
    const t = c.task(taskId)
    if (t.status !== 'in_progress' || t.runId !== h.holderId) return
    this.db.transaction(() => {
      if (t.handoffs >= MAX_HANDOFFS) {
        assertTransition(t, { status: 'blocked', blockReason: 'handoff_cap' }, 'system')
        this.moveRaw(t, 'blocked', 'handoff_cap')
        c.activity(t.id, 'parked', `Parked: handed off ${MAX_HANDOFFS} times (handoff_cap). The agent asked for ${h.label}: ${clip(h.reason, 300)}. Assign it yourself, then Unpark.`)
        return
      }
      assertTransition(t, { status: 'todo' }, 'system')
      this.moveRaw(t, 'todo', null)
      // assign locks open dependencies (blocksCurrent): the next seat gets it blocked(deps), healing to todo
      c.assign(t.id, { departmentId: h.departmentId, agentId: h.agentId }, 'agent', { by: 'rule', reason: `Handed off: ${clip(h.reason, 400)}` })
      const cur = c.task(t.id)
      // another seat never resumes the previous agent's conversation
      c.patchInFlight(t.id, { handoffs: t.handoffs + 1, agentSessionId: null, report: null, ask: null, pendingWake: addWake(cur.pendingWake, `Handed off to you: ${h.reason}`) })
      c.activity(t.id, 'handoff', `Handed off to ${h.label}: ${clip(h.reason, 400)}`, 'agent')
    })()
    this.changed(t.companyId)
    try { this.d.pump?.(t.companyId) } catch { /* the 60 s tick pumps anyway */ }
  }
  /**
   * A run-end status move (in_progress → todo / blocked) as a compare-and-set on the status mirror, like the dispatcher's.
   * The task lets go of the ended run (like CompanyStore.park; runs.task_id keeps the history): a run-end session capture
   * that fires after this (Dispatcher.onRunUpdated runs after the company run hook) must not hand the previous seat's
   * conversation to the next agent.
   */
  private moveRaw(t: BoardTask, status: TaskStatus, blockReason: BlockReason | null): void {
    const r = this.db.prepare("UPDATE company_tasks SET status=?, run_id=NULL, data=json_set(data,'$.status',?,'$.blockReason',?,'$.runId',json('null'),'$.updatedAt',?) WHERE id=? AND status='in_progress'")
      .run(status, status, blockReason, this.now().toISOString(), t.id)
    if (r.changes !== 1) fail(`${t.identifier} is no longer in flight`)
  }
  private changed(companyId: string): void {
    try { this.d.onChange?.(companyId) } catch { /* the UI refresh never fails a call */ }
  }
}
