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
 * - §9 the company tools of a chat (a session holding no task): company_departments reads the departments;
 *   company_file_task files a top-level task into one department (`source:'agent'`, the router's rules pick the agent
 *   unless one is named), stamped `routing.by:'model'` with the chat's reason, under the same hourly cap.
 *
 * Every result is a JSON object marked as data (TASK_NOTE) and fitted under TASK_MAX_OUTPUT chars.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { MAX_HANDOFFS, TASK_ASK_KINDS, TRACK_PREFIX, trackedBy, type BlockReason, type BoardTask, type CompanyAgent, type Department, type PendingWake, type TaskAsk, type TaskReport, type TaskStatus } from '../../shared/company'
import type { LiveOwner, TaskRunBridge, TaskToolset } from '../../shared/engine'
import type { Run } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { assertTransition, type CompanyStore } from './index'
import { queueCountsFrom, route } from './router'
import { ReportHarvester, type HarvestStep } from './reportHarvest'
import { BRIEF_TOOL_LIMITS, COMPANY_LIMITS, isCompanyTool, isSessionTaskTool, TASK_LIMITS, TASK_LIST_MAX, TASK_MAX_OUTPUT, TASK_MUTATIONS, TASK_NOTE, TASK_TOOLS, type BoardTool } from './taskToolDefs'
import { CRITERION_STATES, EDITABLE_SECTIONS, PROOF_KINDS, briefOf, proofOf } from '../../shared/plans'
import { BriefStore, briefReminder, checkProofRef, decide, editSection, setCriterion } from './brief'
export { callTaskTool, isTaskTool, TASK_MAX_OUTPUT, TASK_MUTATIONS, TASK_NOTE, TASK_SERVER_INSTRUCTIONS, TASK_TOOL_DEFS, TASK_TOOLS, type TaskTool } from './taskToolDefs'

/** §6 caps on agent-filed tasks. */
export const TASK_CREATE_CAPS = { perTask: 4, perCompanyPerHour: 10, trackedPerSessionPerHour: 12 } as const
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
  /** §9 company_create_department: departments:save as the UI does it (department note, data:changed). Absent = departments.save. */
  createDepartment?: (input: { companyId: string; name: string; key?: string; does: string; doesNot: string }) => { id: string; key: string; name: string }
  now?: () => Date
  log?: { warn(msg: string, meta?: Record<string, unknown>): void }
  /**
   * PLANS.md §1 task_attach_proof: the folders a proof file may come from (the task's worktree, its run's artifacts).
   * Absent = the caller run's artifacts dir, its worktree row and the cwd Principia gave the run.
   */
  proofRoots?: (task: BoardTask, caller: TaskCaller) => string[]
}

/** A handoff waiting for its run end. */
interface PendingHandoff { holderId: string; departmentId: string | null; agentId: string | null; reason: string; label: string }

// ---------- arguments (strict; the servers only check loosely) ----------
const idArg = z.string().trim().min(1).max(64)
const ARGS = {
  task_get: z.strictObject({ id: idArg.optional() }),
  task_list: z.strictObject({ scope: z.enum(['mine', 'department', 'open']).default('mine'), limit: z.number().int().min(1).max(TASK_LIST_MAX).default(20) }),
  task_comment: z.strictObject({ id: idArg.optional(), text: z.string().trim().min(1).max(TASK_LIMITS.comment) }),
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
    blocksCurrent: z.boolean().default(false),
    parent: idArg.optional(),
    start: z.boolean().default(false)
  }),
  task_update: z.strictObject({
    id: idArg,
    status: z.enum(['in_progress', 'in_review', 'blocked']).optional(),
    note: z.string().trim().min(1).max(TASK_LIMITS.summary).optional(),
    title: z.string().trim().min(1).max(TASK_LIMITS.title).optional(),
    description: z.string().max(TASK_LIMITS.description).optional()
  }).refine(a => a.status !== undefined || a.note !== undefined || a.title !== undefined || a.description !== undefined, { message: 'Nothing to update' })
    .refine(a => a.status !== 'blocked' || !!a.note, { message: "A 'blocked' update needs a note saying why", path: ['note'] }),
  task_handoff: z.strictObject({
    departmentKey: z.string().trim().min(1).max(80).optional(),
    agentId: idArg.optional(),
    reason: z.string().trim().min(1).max(TASK_LIMITS.reason)
  }).refine(a => !!a.departmentKey || !!a.agentId, { message: 'Name a departmentKey or an agentId' }),
  task_brief_edit: z.strictObject({ section: z.enum(EDITABLE_SECTIONS), mode: z.enum(['replace', 'append']).default('replace'), text: z.string().trim().min(1).max(BRIEF_TOOL_LIMITS.text) }),
  task_criterion: z.strictObject({ id: z.string().trim().min(1).max(500), state: z.enum(CRITERION_STATES), reason: z.string().trim().max(500).optional() })
    .refine(a => (a.state !== 'deferred' && a.state !== 'not_done') || !!a.reason, { message: "a 'deferred' or 'not_done' criterion needs a reason (say why)", path: ['reason'] }),
  task_decide: z.strictObject({ text: z.string().trim().min(1).max(1000), why: z.string().trim().min(1, 'say why').max(1000) }),
  task_attach_proof: z.strictObject({ kind: z.enum(PROOF_KINDS), title: z.string().trim().min(1).max(200), ref: z.string().trim().min(1).max(4000) }),
  company_departments: z.strictObject({}),
  company_file_task: z.strictObject({
    title: z.string().trim().min(1).max(TASK_LIMITS.title),
    description: z.string().max(TASK_LIMITS.description).default(''),
    departmentKey: z.string().trim().min(1).max(80).optional(),
    departmentId: idArg.optional(),
    agent: z.string().trim().min(1).max(80).optional(),
    reason: z.string().trim().min(1).max(COMPANY_LIMITS.reason)
  }).refine(a => !!a.departmentKey || !!a.departmentId, { message: 'Name a departmentKey (see company_departments)' }),
  company_create_department: z.strictObject({
    name: z.string().trim().min(1).max(60),
    key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes').optional(),
    does: z.string().trim().min(1).max(300),
    doesNot: z.string().trim().max(300).default(''),
    reason: z.string().trim().min(1).max(COMPANY_LIMITS.reason)
  })
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
  readonly briefs: BriefStore
  private sessionTaskColumn: boolean | null = null

  constructor(private readonly d: TaskToolsDeps) {
    this.harvester = new ReportHarvester({ company: d.company, redact: d.redact, now: d.now })
    this.briefs = new BriefStore(d.company, () => this.now())
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
    // PROACTIVE.md §3: a chat's own tracked task (runId = the chat) never makes the chat a task session
    taskId ??= (this.db.prepare("SELECT id FROM company_tasks WHERE run_id=? AND status='in_progress' AND COALESCE(json_extract(data,'$.externalId'),'') NOT LIKE 'track:%' LIMIT 1").get(owner.sessionId) as { id: string } | undefined)?.id ?? null
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
  authorize(caller: TaskCaller, tool: BoardTool, hints: TaskLineHints = {}): void {
    if (hints.companyId && hints.companyId !== caller.companyId) fail('This task tool server belongs to another company. Restart the session.')
    if (hints.taskId && hints.taskId !== caller.taskId) fail('This task tool server was started for another task')
    // §9: the company tools are a chat's (a session); filing from a task goes through task_create / task_handoff
    if (isCompanyTool(tool)) {
      if (caller.kind !== 'session') fail(`Unknown tool: ${tool}`)
      if (tool === 'company_file_task' && caller.taskId) fail('You are working on a task: use task_create or task_handoff instead')
      return
    }
    // PROACTIVE.md §3: task_update moves a task a chat (a session holding no task) tracks
    if (isSessionTaskTool(tool)) {
      if (caller.kind !== 'session' || caller.taskId) fail('task_update is for chats; report on your task with task_report')
      return
    }
    if (!TASK_MUTATIONS.has(tool)) return
    // task_create from a session that holds no task tracks a task of its company; task_comment {id} notes on one
    if ((tool === 'task_create' || tool === 'task_comment') && caller.kind === 'session' && !caller.taskId) return
    if (!caller.taskId) fail('You are not working on a task')
    if (!caller.holdsTask) fail(`${this.c.task(caller.taskId!).identifier} is no longer yours to change (its run or session ended)`)
  }

  // ---------- calls ----------

  /** One authorized call. Throws HiveError with the message the agent sees. */
  call(caller: TaskCaller, tool: BoardTool, args: unknown, hints: TaskLineHints = {}): Record<string, unknown> {
    this.authorize(caller, tool, hints)
    let out: Record<string, unknown>
    switch (tool) {
      case 'task_get': out = this.get(caller, parseArgs(ARGS.task_get, args).id); break
      case 'task_list': { const a = parseArgs(ARGS.task_list, args); out = this.list(caller, a.scope, a.limit); break }
      case 'task_comment': { const a = parseArgs(ARGS.task_comment, args); out = caller.kind === 'session' && !caller.taskId ? this.chatComment(caller, a.id, a.text) : this.comment(caller, a.text, a.id); break }
      case 'task_update': out = this.update(caller, parseArgs(ARGS.task_update, args)); break
      case 'task_report': out = this.report(caller, parseArgs(ARGS.task_report, args)); break
      case 'task_ask': out = this.ask(caller, parseArgs(ARGS.task_ask, args)); break
      case 'task_create': { const a = parseArgs(ARGS.task_create, args); out = caller.kind === 'session' && !caller.taskId ? this.track(caller, a, hints.callId ?? null) : this.create(caller, a, hints.callId ?? null); break }
      case 'task_handoff': out = this.handoff(caller, parseArgs(ARGS.task_handoff, args)); break
      case 'task_brief_edit': out = this.briefEdit(caller, parseArgs(ARGS.task_brief_edit, args)); break
      case 'task_criterion': out = this.criterion(caller, parseArgs(ARGS.task_criterion, args)); break
      case 'task_decide': out = this.decision(caller, parseArgs(ARGS.task_decide, args)); break
      case 'task_attach_proof': out = this.attachProof(caller, parseArgs(ARGS.task_attach_proof, args)); break
      case 'company_departments': parseArgs(ARGS.company_departments, args); out = this.departmentsOf(caller); break
      case 'company_file_task': out = this.fileTask(caller, parseArgs(ARGS.company_file_task, args), hints.callId ?? null); break
      case 'company_create_department': out = this.createDepartment(caller, parseArgs(ARGS.company_create_department, args)); break
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
        report: t.report, ask: t.ask, ...(t.doneNote ? { doneNote: clip(t.doneNote, 1000) } : {}), handoffs: t.handoffs,
        // PLANS.md §1: the brief (revisions left out: who changed what is for the inspector)
        brief: (({ revisions: _r, ...b }) => ({ ...b, context: clip(b.context, 2000), decisions: b.decisions.slice(-10) }))(briefOf(t)),
        proof: proofOf(t).map(p => ({ id: p.id, kind: p.kind, title: p.title }))
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

  private comment(caller: TaskCaller, text: string, ref?: string): Record<string, unknown> {
    const t = this.own(caller)
    if (ref && this.find(caller.companyId, ref).id !== t.id) fail(`You can only comment on your current task (${t.identifier})`)
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
    const remind = this.reportReminder(t, caller)
    return { ok: true, task: t.identifier, outcome: a.outcome, appliedAt: 'run end', detail: a.outcome === 'review' ? 'A human reviews and approves the task; you cannot mark it done.' : 'The task waits for the human with your reason.', ...(remind ? { brief: remind } : {}) }
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
    if (a.parent || a.start) fail('parent and start are for chats; your subtasks always belong to your current task')
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
    const hour = (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND json_extract(data,'$.source')='agent' AND json_extract(data,'$.createdAt')>=? AND COALESCE(json_extract(data,'$.externalId'),'') NOT LIKE 'track:%'").get(caller.companyId, since) as { n: number }).n
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
  // ---------- PROACTIVE.md §3: the tasks a chat tracks for its own work ----------

  /** A task of the caller's company this chat tracks (task_create from the chat). */
  private tracked(caller: TaskCaller, ref: string): BoardTask {
    const t = this.find(caller.companyId, ref)
    if (trackedBy(t) !== caller.holderId) fail(`${t.identifier} is not tracked by this chat. Comment on tasks you track or filed; file new work with task_create or company_file_task.`)
    return t
  }
  /**
   * task_create from a chat: a task the chat itself works on, never routed to an agent (the dispatcher skips it).
   * `parent` (a task this chat tracks) groups several; `start` moves it to in_progress at once. Replays of the same tool
   * call return the first task; at most trackedPerSessionPerHour per chat.
   */
  private track(caller: TaskCaller, a: z.infer<typeof ARGS.task_create>, callId: string | null): Record<string, unknown> {
    if (a.blocksCurrent) fail('blocksCurrent needs a current task')
    const db = this.db
    const externalId = `${TRACK_PREFIX}${caller.holderId}:${callId ? clip(callId, 120) : randomBytes(8).toString('hex')}`
    const replay = callId ? db.prepare('SELECT id FROM company_tasks WHERE company_id=? AND source_key=?').get(caller.companyId, `agent:external:${externalId}`) as { id: string } | undefined : undefined
    if (replay) return { ok: true, task: this.summary(this.c.task(replay.id)), replayed: true }
    const since = new Date(this.now().getTime() - HOUR_MS).toISOString()
    const n = (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND json_extract(data,'$.externalId') LIKE ? AND json_extract(data,'$.createdAt')>=?").get(caller.companyId, `${TRACK_PREFIX}${caller.holderId}:%`, since) as { n: number }).n
    if (n >= TASK_CREATE_CAPS.trackedPerSessionPerHour) fail(`This chat opened ${n} tasks in the last hour (limit ${TASK_CREATE_CAPS.trackedPerSessionPerHour}). Group the rest under one task.`)
    const parent = a.parent ? this.tracked(caller, a.parent) : null
    if (parent?.parentId) fail(`${parent.identifier} is already a subtask; tasks go one level deep`)
    let dep: Department | null = null
    if (a.departmentKey) {
      dep = this.c.departments.byKey(caller.companyId, a.departmentKey.toLowerCase())
      if (!dep || dep.archivedAt || dep.companyId !== caller.companyId) fail(`No department "${a.departmentKey}" in this company. Known: ${this.c.departments.list(caller.companyId).map(d => d.key).join(', ') || 'none'}`)
    } else {
      // a department chat's tasks belong to its department
      let depId: string | null = null
      try { depId = (db.prepare('SELECT department_id FROM sessions WHERE id=?').get(caller.holderId) as { department_id: string | null } | undefined)?.department_id ?? null } catch { /* older db */ }
      dep = depId ? this.c.departments.get(depId) : parent?.departmentId ? this.c.departments.get(parent.departmentId) : null
      if (dep && (dep.archivedAt || dep.companyId !== caller.companyId)) dep = null
    }
    const created = this.c.createTask({
      companyId: caller.companyId, title: clip(this.redact(a.title), TASK_LIMITS.title), description: this.redact(a.description), repoId: null,
      status: 'todo', priority: 0, source: 'agent', sourceUrl: null, externalId,
      assigneeProfileId: null, parentId: parent?.id ?? null, dependencyIds: [], departmentId: dep?.id ?? null
    })
    let t = this.c.task(created.id)
    if (a.start) t = this.c.moveTracked(t.id, caller.holderId, 'in_progress', null)
    if (parent) this.c.activity(parent.id, 'comment', `Opened ${t.identifier}: ${clip(t.title, 200)}`, 'agent')
    this.changed(caller.companyId)
    return { ok: true, task: this.summary(t), parent: parent?.identifier ?? null, tracked: true,
      detail: `${t.identifier} is yours to work on here: task_update it to in_progress when you start, in_review once built and checked. Only the founder marks it done.` }
  }
  /** task_update: move, retitle or rewrite a task this chat tracks. */
  private update(caller: TaskCaller, a: z.infer<typeof ARGS.task_update>): Record<string, unknown> {
    let t = this.tracked(caller, a.id)
    if (a.title !== undefined || a.description !== undefined) {
      t = this.c.editTracked(t.id, caller.holderId, { ...(a.title !== undefined ? { title: this.redact(a.title) } : {}), ...(a.description !== undefined ? { description: this.redact(a.description) } : {}) })
    }
    const note = a.note ? this.redact(a.note).trim() : null
    if (a.status) t = this.c.moveTracked(t.id, caller.holderId, a.status, note)
    else if (note) this.c.activity(t.id, 'comment', note, 'agent')
    this.changed(caller.companyId)
    return { ok: true, task: this.summary(t), ...(t.status === 'in_review' ? { detail: 'The founder reviews and approves it; you cannot mark it done.' } : {}) }
  }
  /** task_comment from a chat: a note on a task this chat tracks or filed (company_file_task). Never wakes anyone. */
  private chatComment(caller: TaskCaller, ref: string | undefined, text: string): Record<string, unknown> {
    if (!ref) fail('You are not working on a task: pass the id of a task you track or filed')
    const t = this.find(caller.companyId, ref!)
    const mine = trackedBy(t) === caller.holderId || (t.source === 'agent' && !!t.externalId?.startsWith(`${caller.holderId}:`))
    if (!mine) fail(`${t.identifier} was not opened by this chat; comment on tasks you track or filed`)
    const body = this.redact(text).trim()
    if (!body) fail('The comment is empty after redaction')
    this.c.activity(t.id, 'comment', body, 'agent')
    this.changed(t.companyId)
    return { ok: true, task: t.identifier }
  }

  // ---------- §9 the company tools of a chat ----------

  private departmentsOf(caller: TaskCaller): Record<string, unknown> {
    const open = this.c.listTasks(caller.companyId).filter(OPEN)
    const agents = this.c.departments.listAgents({ companyId: caller.companyId })
    return {
      departments: this.c.departments.list(caller.companyId).map(d => ({
        key: d.key, id: d.id, name: d.name,
        does: clip(d.data.charter.does, 400), doesNot: clip(d.data.charter.doesNot, 400),
        agents: agents.filter(a => a.departmentId === d.id).map(a => ({ id: a.id, name: a.data.persona?.name ?? a.name, role: a.name, auto: a.data.autonomy === 'auto', ...(a.pausedAt ? { paused: true } : {}) })),
        openTasks: open.filter(t => t.departmentId === d.id).length
      })),
      unfiled: open.filter(t => !t.departmentId).length
    }
  }

  /**
   * §9 company_create_department: a new department of the chat's company, from a chat the user asked or agreed in (the
   * pane's own permission prompt is the second yes). Same key or name = the existing one (replays, double asks).
   */
  private createDepartment(caller: TaskCaller, a: z.infer<typeof ARGS.company_create_department>): Record<string, unknown> {
    const name = clip(this.redact(a.name), 60)
    const all = this.c.departments.list(caller.companyId, { includeArchived: true })
    const same = all.find(d => (a.key && d.key === a.key) || d.name.toLowerCase() === name.toLowerCase())
    if (same) {
      if (same.archivedAt) fail(`${same.name} exists but is archived. Ask the user to unarchive it in Principia.`)
      return { ok: true, department: { key: same.key, id: same.id, name: same.name }, existed: true, detail: `${same.name} already exists.` }
    }
    const input = { companyId: caller.companyId, name, ...(a.key ? { key: a.key } : {}), does: clip(this.redact(a.does), 300), doesNot: clip(this.redact(a.doesNot), 300) }
    const dep = this.d.createDepartment
      ? this.d.createDepartment(input)
      : this.c.departments.save({ companyId: input.companyId, name: input.name, ...(input.key ? { key: input.key } : {}), data: { charter: { does: input.does, doesNot: input.doesNot } } })
    return { ok: true, department: { key: dep.key, id: dep.id, name: dep.name }, detail: `Created ${dep.name} (${dep.key}). It has no agents yet: the user hires them in Principia (Departments → ${dep.name} → Add agent). Tell the user.` }
  }

  /**
   * §9 company_file_task: a top-level task of the chat's company in one department, routed by §2 rules 1-2 (the named
   * agent, else the department's eligible one) and stamped `routing.by:'model'` with the chat's reason. Replays of the
   * same tool call return the first task; the agent-filed hourly cap applies.
   */
  private fileTask(caller: TaskCaller, a: z.infer<typeof ARGS.company_file_task>, callId: string | null): Record<string, unknown> {
    const db = this.db
    const externalId = `${caller.holderId}:${callId ? clip(callId, 120) : randomBytes(8).toString('hex')}`
    const replay = callId ? db.prepare('SELECT id FROM company_tasks WHERE company_id=? AND source_key=?').get(caller.companyId, `agent:external:${externalId}`) as { id: string } | undefined : undefined
    if (replay) return { ok: true, task: this.summary(this.c.task(replay.id)), replayed: true }
    const since = new Date(this.now().getTime() - HOUR_MS).toISOString()
    const hour = (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND json_extract(data,'$.source')='agent' AND json_extract(data,'$.createdAt')>=? AND COALESCE(json_extract(data,'$.externalId'),'') NOT LIKE 'track:%'").get(caller.companyId, since) as { n: number }).n
    if (hour >= TASK_CREATE_CAPS.perCompanyPerHour) fail(`Agents filed ${hour} tasks in this company in the last hour (limit ${TASK_CREATE_CAPS.perCompanyPerHour}). Ask the user to add it on the Board.`)
    const departments = this.c.departments.list(caller.companyId)
    const known = () => departments.map(d => d.key).join(', ') || 'none'
    const dep = a.departmentId ? departments.find(d => d.id === a.departmentId) : departments.find(d => d.key === a.departmentKey!.toLowerCase())
    if (!dep) fail(`No department "${a.departmentKey ?? a.departmentId}" in this company. Known: ${known()}`)
    const agents = this.c.departments.listAgents({ companyId: caller.companyId })
    let agentId: string | null = null
    if (a.agent) {
      const want = a.agent.toLowerCase()
      const agent = agents.find(x => x.id === a.agent) ?? agents.find(x => x.departmentId === dep!.id && (x.name.toLowerCase() === want || x.data.persona?.name?.toLowerCase() === want))
      if (!agent || agent.archivedAt) fail(`No agent "${a.agent}" in ${dep!.name}`)
      if (agent!.departmentId !== dep!.id) fail(`${agent!.name} is not in ${dep!.name}`)
      agentId = agent!.id
    }
    const reason = clip(this.redact(a.reason).replace(/\s+/g, ' ').trim(), 400)
    const draft = { companyId: caller.companyId, title: clip(this.redact(a.title), TASK_LIMITS.title), description: this.redact(a.description), source: 'agent' as const, sourceUrl: null, status: 'todo' as const, departmentId: dep!.id, agentId }
    // §2 rules 1-2, as the board would route it: the named agent, else the department's only or least-busy auto agent
    const d = route(draft, { departments, agents, queueCounts: queueCountsFrom(this.c.listTasks(caller.companyId)), explicitBy: 'rule' })
    const created = this.c.createTask({
      ...draft, repoId: null, priority: 0, externalId, assigneeProfileId: null, parentId: null, dependencyIds: [],
      departmentId: d.departmentId ?? dep!.id, agentId: d.agentId ?? null,
      routing: { departmentId: d.departmentId ?? dep!.id, agentId: d.agentId ?? null, by: 'model', reason: clip(`Filed from chat: ${reason}`, 500) }
    })
    this.c.activity(created.id, 'routed', clip(`Filed from a chat into ${dep!.name}: ${reason}`, 1000), 'agent')
    const t = this.c.task(created.id)
    this.changed(caller.companyId)
    return { ok: true, task: this.summary(t), detail: `Filed ${t.identifier} in ${dep!.name}${t.agentId ? ` for ${this.agentRow(t.agentId)?.name ?? 'its agent'}` : ' (waiting for you to assign an agent)'}. Tell the user.` }
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

  // ---------- PLANS.md §1: the brief ----------

  /** The author of a brief edit: the task's seat, never what the arguments say. */
  private author(caller: TaskCaller): string { return `agent:${caller.agentId ?? 'agent'}` }
  private briefEdit(caller: TaskCaller, a: z.infer<typeof ARGS.task_brief_edit>): Record<string, unknown> {
    const t = this.own(caller)
    const next = this.briefs.edit(t.id, (b, at) => editSection(b, a.section, a.mode, this.redact(a.text), this.author(caller), at))
    this.changed(t.companyId)
    const b = briefOf(next)
    return { ok: true, task: t.identifier, section: a.section, ...(a.section === 'criteria' ? { criteria: b.criteria } : a.section === 'questions' ? { questions: b.questions } : { length: (b[a.section] as string).length }) }
  }
  private criterion(caller: TaskCaller, a: z.infer<typeof ARGS.task_criterion>): Record<string, unknown> {
    const t = this.own(caller)
    const next = this.briefs.edit(t.id, (b, at) => setCriterion(b, a.id, a.state, a.reason ? this.redact(a.reason) : undefined, this.author(caller), at))
    this.changed(t.companyId)
    const b = briefOf(next)
    return { ok: true, task: t.identifier, open: b.criteria.filter(c => c.state === 'open').map(c => c.id), criteria: b.criteria.length }
  }
  private decision(caller: TaskCaller, a: z.infer<typeof ARGS.task_decide>): Record<string, unknown> {
    const t = this.own(caller)
    const next = this.briefs.edit(t.id, (b, at) => decide(b, this.redact(a.text), this.redact(a.why), this.author(caller), at))
    this.changed(t.companyId)
    return { ok: true, task: t.identifier, decisions: briefOf(next).decisions.length }
  }
  private attachProof(caller: TaskCaller, a: z.infer<typeof ARGS.task_attach_proof>): Record<string, unknown> {
    const t = this.own(caller)
    const ref = checkProofRef(a.kind, a.ref, this.proofRoots(t, caller), s => this.redact(s))
    const out = this.briefs.attach(t.id, { kind: a.kind, title: this.redact(a.title), ref }, this.author(caller))
    this.changed(t.companyId)
    return { ok: true, task: t.identifier, proof: { id: out.proof.id, kind: out.proof.kind, title: out.proof.title }, total: proofOf(out.task).length }
  }
  /** PLANS.md §1: the brief this turn has not written yet, as advice in task_report's result (never an error). */
  private reportReminder(t: BoardTask, caller: TaskCaller): string {
    try {
      const since = caller.kind === 'run' ? ((this.db.prepare('SELECT started_at AS s FROM runs WHERE id=?').get(caller.holderId) as { s: string | null } | undefined)?.s ?? null) : null
      return briefReminder(t, since, this.author(caller))
    } catch { return '' }
  }
  private proofRoots(t: BoardTask, caller: TaskCaller): string[] {
    if (this.d.proofRoots) return this.d.proofRoots(t, caller)
    const roots: string[] = []
    if (caller.kind !== 'run') return roots
    const run = this.db.prepare('SELECT artifacts_dir AS dir, target_json AS target FROM runs WHERE id=?').get(caller.holderId) as { dir: string | null; target: string | null } | undefined
    // where the agent works comes first (a relative proof path is relative to it), the run's artifacts last
    // WORKTREE.md / PLANS.md §2.4: the task's own worktree, or its milestone's (a plan task works in its parent's)
    try {
      const parent = t.plan?.role === 'task' && t.parentId ? this.c.task(t.parentId) : null
      const w = t.work ?? (parent?.plan?.role === 'milestone' ? parent.work : null)
      if (w?.worktreePath && !w.removedAt) roots.push(w.worktreePath)
    } catch { /* no worktree */ }
    try {
      const wt = this.db.prepare("SELECT path FROM worktrees WHERE run_id=? AND status IN ('creating','active','kept') ORDER BY created_at DESC LIMIT 1").get(caller.holderId) as { path: string } | undefined
      if (wt?.path) roots.push(wt.path)
    } catch { /* older db */ }
    if (run?.dir) roots.push(run.dir)
    return roots
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
