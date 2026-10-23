/**
 * Author broker (AUTHORING.md §1.2, §2; PO1-PO4, PO8). Main's single authority for the `hive` tools:
 * - identity comes ONLY from the live dir a call arrived in (LiveOwner), never from the line's content;
 * - PO1: only interactive session owners are served (headless steps never get the server; a step owner is refused);
 *   the exceptions are the slack toolset (SA2) and the task_* toolset of task runs (DEPARTMENTS.md §6);
 * - dispatches exactly AUTHOR_TOOLS; anything else is "Unknown tool";
 * - writes (create/update/run) become drafts + an approval Ask; the call blocks until the user decides (or wait_s);
 * - decide() persists (workflow + origin, schedule, run) and answers every waiting call.
 * Agents can never reach secrets, settings, profiles or repo mutations: no such tool exists and no dep does that.
 * No Electron imports (testable with fakes).
 */
import type { LiveOwner } from '../../shared/engine'
import {
  AUTHORING_SCHEMA,
  AUTHOR_TOOLS,
  approveLabel,
  authorFlags,
  flagLines,
  preAllowedRunBlockers,
  type AuthorDraft,
  type AuthorDraftDetail,
  type AuthorDraftSchedule,
  type AuthorFlags,
  type AuthorRunGrant,
  type AuthorTool,
  type AuthoringContext
} from '../../shared/authoring'
import { inputValueErrors } from '../../shared/inputs'
import type { Ask } from '../../shared/live'
import type {
  AdapterId,
  Id,
  ProviderInfo,
  Run,
  RunDetail,
  Schedule,
  SchedulePreset,
  SchedulePreview,
  ScheduleWhen,
  ValidationError,
  Workflow,
  WorkflowDraft,
  WorkflowOrigin
} from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { SLACK_TOOLS, SLACK_WORK_TOOLS, type SlackTool, type SlackTriggerInput, type SlackWorkTool } from '../../shared/slack'
import { isBoardTool, isCompanyTool, TASK_MUTATIONS, type BoardTool, type TaskTool } from '../company/taskToolDefs'
import { AuthorDrafts, publicDraft, stripWorkflow, workflowHash, type DraftOwner, type DraftRecord, type DraftResult } from './drafts'
import { validateAuthoredDraft } from './validateDraft'

export const RATE_PER_MIN = 60
export const MAX_PENDING_PER_OWNER = 5
export const MAX_AGENT_RUNS_PER_OWNER = 3
export const DEFAULT_WAIT_S = 600
export const MAX_WAIT_S = 3300
const TERMINAL = new Set(['passed', 'failed', 'canceled'])

export interface AuthorCallLine {
  hive: 'author_call'
  call_id: string
  tool: string
  args?: unknown
  agent_hint?: string | null
}

export interface BrokerDeps {
  drafts: AuthorDrafts
  /** Session owner identity (title, adapter, agentSessionId, root agent). null = unknown session. */
  owner(sessionId: Id): DraftOwner | null
  ctx(): AuthoringContext
  providers(): ProviderInfo[]
  engineValidate(d: WorkflowDraft): ValidationError[]
  defaultBranch(repoPath: string): Promise<string | null>
  listWorkflows(): Workflow[]
  getWorkflow(id: Id): Workflow | null
  listSchedules(): Schedule[]
  lastRun(workflowId: Id): Run | null
  getRunDetail(id: Id): RunDetail | null
  /** Active (queued/running) runs started by this owner key. */
  activeAgentRuns(ownerKey: string): number
  previewSchedule(when: ScheduleWhen): SchedulePreview
  // ---- effects (approval only) ----
  saveWorkflow(draft: WorkflowDraft, origin: WorkflowOrigin): Workflow
  updateWorkflow(id: Id, draft: WorkflowDraft): Workflow
  setOrigin(id: Id, origin: WorkflowOrigin | null): void
  createSchedule(input: { name: string; workflowId: Id; inputs: Record<string, string>; when: ScheduleWhen; preset: SchedulePreset | null; enabled?: boolean }): Schedule
  startRun(workflowId: Id, inputs: Record<string, string>, startedBy: { ownerLabel: string; ownerKey: string; draftId: Id | null }): Run
  /** Opens the approval Ask for a draft (Needs you + notification). null when the owner has no live root. */
  openAsk(d: DraftRecord): Ask | null
  /** Resolves the approval Ask. */
  closeAsk(askId: Id, how: { status: 'answered' | 'expired'; optionId: 'approve' | 'reject' | null; message: string | null }): void
  emitDraft(d: AuthorDraft): void
  /** data:changed for workflows / schedules. */
  changed(domain: 'workflows' | 'schedules'): void
  tz(): string
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  /**
   * SLACK.md §11 (SA2): the `slack_*` toolset. Session owners and step owners of Slack runs may call it; the handler
   * decides from the owner (never from args). Absent = Slack tools are unknown.
   */
  slack?: { call(owner: LiveOwner, tool: SlackTool | SlackWorkTool, args: Record<string, unknown>): Promise<Record<string, unknown>> }
  /**
   * DEPARTMENTS.md §6: the `task_*` toolset (hivetask). Step owners of task runs and session owners may call it. The
   * broker resolves the caller from the owner, refuses a line naming another company or task, and lets writes through
   * only while the caller holds its task; the handler checks again. Absent = task tools are unknown.
   */
  tasks?: {
    /** The caller of an owner (its company, its task, whether its run or session still holds it). Throws the refusal. */
    resolve(owner: LiveOwner): TaskCallerRef
    call(caller: TaskCallerRef, tool: BoardTool, args: Record<string, unknown>, hints: { companyId: string | null; taskId: string | null; callId: string | null }): Record<string, unknown> | Promise<Record<string, unknown>>
  }
  /** SLACK.md §9.5: `slack_trigger` on create/update/validate. Absent = the argument is refused. */
  slackTriggers?: {
    /** Resolves #name / @handle from the local mirror and validates (PO-S3c included). */
    prepare(raw: unknown, workflow: WorkflowDraft): { input: SlackTriggerInput; flag: NonNullable<AuthorFlags['slackTrigger']> } | { errors: ValidationError[] }
    /** On approve: create (or update the same-named trigger of this workflow). Disabled with a note when Slack is not connected. */
    save(input: SlackTriggerInput, workflowId: Id, origin: WorkflowOrigin | null): void
    connected(): boolean
    alertUserId(): string | null
    channelName(id: string): string
  }
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** What the broker needs to know about a task tool caller (TaskTools.resolveCaller's TaskCaller). */
export interface TaskCallerRef { kind: 'run' | 'session'; companyId: Id; taskId: Id | null; holdsTask: boolean }

type Waiter = (r: Record<string, unknown>) => void

const ownerId = (o: LiveOwner): string => ('sessionId' in o ? o.sessionId : o.stepId)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clampWait = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 0), MAX_WAIT_S) : def)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** Cron that a Schedules preset can describe (so the editor reopens it nicely). Cosmetic. */
export function presetFor(when: ScheduleWhen): SchedulePreset | null {
  if (when.kind === 'at') return { kind: 'once', at: when.at }
  const f = when.cron.trim().split(/\s+/)
  if (f.length !== 5) return { kind: 'cron' }
  const [m, h, dom, mon, dow] = f
  const num = (s: string) => /^\d+$/.test(s)
  const hhmm = () => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  if (num(m) && num(h) && dom === '*' && mon === '*' && dow === '1-5') return { kind: 'weekdays', time: hhmm() }
  if (num(m) && num(h) && dom === '*' && mon === '*' && dow === '*') return { kind: 'daily', time: hhmm() }
  if (num(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return { kind: 'hourly', minute: Number(m) }
  const ev = m.match(/^\*\/(\d+)$/)
  if (ev && h === '*' && dom === '*' && mon === '*' && dow === '*') return { kind: 'everyNMinutes', n: Number(ev[1]) }
  return { kind: 'cron' }
}

export class AuthorBroker {
  private waiters = new Map<Id, Set<Waiter>>()
  private calls = new Map<string, AbortController>()
  private rate = new Map<string, number[]>()
  private branchCache = new Map<string, { at: number; v: string | null }>()
  private now: () => number
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(private d: BrokerDeps) {
    this.now = d.now ?? (() => Date.now())
    this.sleep = d.sleep ?? defaultSleep
  }

  // ---------- mailbox entry points (LiveBridge) ----------

  /** One `author_call` line from an owner's live dir. Always answers (unless canceled). */
  handleCall(owner: LiveOwner, line: unknown, writeAnswer: (callId: string, payload: unknown) => void): void {
    if (!isObj(line) || typeof line.call_id !== 'string' || !/^hac_[0-9a-z]{10}$/.test(line.call_id)) return
    const callId = line.call_id
    const key = `${ownerId(owner)}:${callId}`
    const answer = (payload: unknown) => {
      this.calls.delete(key)
      try {
        writeAnswer(callId, payload)
      } catch (e) {
        this.d.log?.warn('author: could not write answer', { callId, e: String(e) })
      }
    }
    const tool = typeof line.tool === 'string' ? line.tool : ''
    // DEPARTMENTS.md §6: task tools (steps of task runs and sessions alike), §9 company tools (chat sessions); identity is
    // the owner, checked in taskCall
    if (isBoardTool(tool)) {
      if (!this.d.tasks) return answer({ ok: false, error: `Unknown tool: ${tool}` })
      if (!this.allow(owner)) return answer({ ok: false, error: 'Too many Hive tool calls (limit 60 per minute). Wait a minute.' })
      const args = isObj(line.args) ? line.args : {}
      Promise.resolve()
        .then(() => this.taskCall(owner, tool, args, line))
        .then((result) => answer({ ok: true, result }))
        .catch((e: unknown) => answer({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      return
    }
    // SLACK.md §11.4: the work toolset rides on the same handler (it decides from the owner: Slack-triggered steps only)
    const isSlack = (SLACK_TOOLS as readonly string[]).includes(tool) || (SLACK_WORK_TOOLS as readonly string[]).includes(tool)
    // PO1 / SA2: a step owner may call only the slack toolset; an authoring tool from a step is unknown
    if (!isSlack && !('sessionId' in owner)) return answer({ ok: false, error: `Unknown tool: ${tool}` })
    if (!isSlack && !(AUTHOR_TOOLS as readonly string[]).includes(tool)) return answer({ ok: false, error: `Unknown tool: ${tool}` })
    if (isSlack && !this.d.slack) return answer({ ok: false, error: `Unknown tool: ${tool}` })
    if (!this.allow(owner)) return answer({ ok: false, error: 'Too many Hive tool calls (limit 60 per minute). Wait a minute.' })
    const ac = new AbortController()
    this.calls.set(key, ac)
    const args = isObj(line.args) ? line.args : {}
    const run = isSlack ? this.d.slack!.call(owner, tool as SlackTool | SlackWorkTool, args) : this.dispatch((owner as { sessionId: Id }).sessionId, tool as AuthorTool, args, ac.signal)
    run
      .then((result) => {
        if (!ac.signal.aborted) answer({ ok: true, result })
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        const msg = e instanceof Error ? e.message : String(e)
        answer({ ok: false, error: msg })
      })
  }

  /** RATE_PER_MIN calls per owner per rolling minute; counts this call when allowed. */
  private allow(owner: LiveOwner): boolean {
    const t = this.now()
    const hits = (this.rate.get(ownerId(owner)) ?? []).filter((x) => t - x < 60_000)
    if (hits.length >= RATE_PER_MIN) return false
    hits.push(t)
    this.rate.set(ownerId(owner), hits)
    return true
  }

  /**
   * DEPARTMENTS.md §6: every task tool call. The caller comes from the owner; the line's company_id (the server's
   * HIVE_TASK_COMPANY_ID / HIVE_COMPANY_ID) and task_id (HIVE_TASK_ID) must be the caller's own; a write needs the
   * caller's run or session to still hold its task (task_create from a session holding no task files a top-level one).
   */
  async taskCall(owner: LiveOwner, tool: BoardTool, args: Record<string, unknown>, line: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tasks = this.d.tasks
    if (!tasks) throw new Error(`Unknown tool: ${tool}`)
    const caller = tasks.resolve(owner)
    const companyId = str(line.company_id, 64)
    const taskId = str(line.task_id, 64)
    if (companyId && companyId !== caller.companyId) throw new Error('This task tool server belongs to another company. Restart the session.')
    if (taskId && taskId !== caller.taskId) throw new Error('This task tool server was started for another task')
    // §9: the company tools belong to chats: a session that holds no task
    if (isCompanyTool(tool)) {
      if (caller.kind !== 'session') throw new Error(`Unknown tool: ${tool}`)
      if (tool === 'company_file_task' && caller.taskId) throw new Error('You are working on a task: use task_create or task_handoff instead')
    } else if (TASK_MUTATIONS.has(tool as TaskTool) && !(tool === 'task_create' && caller.kind === 'session' && !caller.taskId)) {
      if (!caller.taskId) throw new Error('You are not working on a task')
      if (!caller.holdsTask) throw new Error('This task is no longer yours to change (its run or session ended)')
    }
    return tasks.call(caller, tool, args, { companyId, taskId, callId: str(line.agent_hint, 120) })
  }

  /** `author_cancelled`: the agent stopped waiting (the draft stays pending). */
  handleCancel(owner: LiveOwner, line: unknown): void {
    if (!isObj(line) || typeof line.call_id !== 'string') return
    const key = `${ownerId(owner)}:${line.call_id}`
    this.calls.get(key)?.abort()
    this.calls.delete(key)
  }

  // ---------- tools ----------

  async dispatch(sessionId: Id, tool: AuthorTool, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    switch (tool) {
      case 'hive_workflow_schema':
        return this.schema(str(args.topic, 20) ?? 'all')
      case 'hive_repos_list':
        return this.repos()
      case 'hive_profiles_list':
        return this.profiles()
      case 'hive_workflow_list':
        return this.workflowList(str(args.query, 120), typeof args.limit === 'number' ? args.limit : 30)
      case 'hive_workflow_get': {
        const wf = this.d.getWorkflow(String(args.id ?? ''))
        if (!wf) throw new Error('Workflow not found. Call hive_workflow_list.')
        return { workflow: wf }
      }
      case 'hive_workflow_validate': {
        const v = this.validate(args.workflow)
        const errors = [...v.errors]
        if (args.slack_trigger !== undefined && args.slack_trigger !== null) {
          const st = this.d.slackTriggers?.prepare(args.slack_trigger, v.normalized) ?? { errors: [{ path: 'slack_trigger', message: 'Slack triggers are not available in this Hive' }] }
          if ('errors' in st) errors.push(...st.errors)
        }
        return { ok: errors.length === 0, errors, warnings: v.warnings, normalized: v.normalized }
      }
      case 'hive_workflow_create':
      case 'hive_workflow_update':
        return this.propose(sessionId, tool === 'hive_workflow_create' ? 'create' : 'update', args, signal)
      case 'hive_workflow_run':
        return this.run(sessionId, args, signal)
      case 'hive_draft_status':
        return this.draftStatus(sessionId, args, signal)
      case 'hive_run_get':
        return this.runGet(args, signal)
    }
  }

  schema(topic: string): Record<string, unknown> {
    const s = AUTHORING_SCHEMA as unknown as Record<string, unknown>
    switch (topic) {
      case 'nodes':
        return { version: 1, workflowFields: s.workflowFields, nodeTypes: s.nodeTypes, validationRules: s.validationRules }
      case 'templating':
        return { version: 1, templating: s.templating }
      case 'contracts':
        return { version: 1, contracts: s.contracts }
      case 'examples':
        return { version: 1, examples: s.examples }
      case 'slack':
        return { version: 1, slack: s.slack, templating: s.templating }
      default:
        return s
    }
  }

  async repos(): Promise<Record<string, unknown>> {
    const out = []
    for (const r of this.d.ctx().repos) {
      const repo = r as AuthoringContext['repos'][number] & { exists?: boolean }
      let defaultBranch: string | null = null
      if (repo.isGit !== false && repo.exists !== false) {
        const c = this.branchCache.get(repo.path)
        if (c && this.now() - c.at < 600_000) defaultBranch = c.v
        else {
          defaultBranch = await this.d.defaultBranch(repo.path).catch(() => null)
          this.branchCache.set(repo.path, { at: this.now(), v: defaultBranch })
        }
      }
      out.push({ id: repo.id, name: repo.name, path: repo.path, exists: repo.exists ?? true, isGit: repo.isGit ?? false, defaultBranch })
    }
    return { repos: out }
  }

  profiles(): Record<string, unknown> {
    const ctx = this.d.ctx()
    const prov = new Map(this.d.providers().map((p) => [p.id, p]))
    const defaults: Record<string, Id | null> = { claude: null, codex: null, gemini: null, cursor: null, shell: null }
    for (const k of Object.keys(defaults)) defaults[k] = ctx.defaults[k as AdapterId] ?? null
    return {
      profiles: ctx.profiles.map((p) => {
        const full = p as AuthoringContext['profiles'][number] & { model?: string | null }
        const info = prov.get(p.adapter)
        return {
          id: p.id,
          name: p.name,
          adapter: p.adapter,
          model: full.model ?? null,
          permissionMode: p.permissionMode ?? 'default',
          available: p.adapter === 'shell' ? true : !!info?.available,
          isDefault: defaults[p.adapter] === p.id,
          memory: info?.memory ?? null,
          headlessAsks: !!info?.headlessAsks
        }
      }),
      defaults
    }
  }

  workflowList(query: string | null, limit: number): Record<string, unknown> {
    const q = query?.toLowerCase().trim() ?? ''
    const schedules = this.d.listSchedules()
    const list = this.d
      .listWorkflows()
      .filter((w) => !q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q))
      .slice(0, Math.min(Math.max(Math.floor(limit) || 30, 1), 100))
    return {
      workflows: list.map((w) => {
        const last = this.d.lastRun(w.id)
        return {
          id: w.id,
          name: w.name,
          description: w.description,
          nodeCount: w.nodes.length,
          nodeTypes: [...new Set(w.nodes.map((n) => n.type))],
          inputs: w.inputs.map((i) => ({ name: i.name, label: i.label, type: i.type ?? 'text', default: i.default ?? null })),
          updatedAt: w.updatedAt,
          origin: w.origin ?? null,
          schedules: schedules
            .filter((s) => s.target.kind === 'workflow' && s.target.workflowId === w.id)
            .map((s) => ({ id: s.id, sentence: s.sentence, enabled: s.enabled, nextFireAt: s.nextFireAt })),
          lastRun: last ? { id: last.id, status: last.status, outcome: last.outcome ?? null, endedAt: last.endedAt } : null
        }
      })
    }
  }

  /** SLACK.md §9.5: what the approval card needs to know about Slack. */
  /** SLACK.md §10.3: recompute "no alert person picked yet" while a card is pending (the user may pick one meanwhile). */
  private alertUserMissing(f: AuthorFlags): Pick<AuthorFlags, 'slackAlertUserMissing'> {
    const s = this.d.slackTriggers
    return { slackAlertUserMissing: !!f.slackAlerts?.includes('your Slack DM') && !(s ? s.alertUserId() : null) }
  }

  private slackFlagCtx(trigger: AuthorFlags['slackTrigger']): Partial<Parameters<typeof authorFlags>[1]> {
    const s = this.d.slackTriggers
    if (!s) return {}
    return { slackConnected: s.connected(), slackAlertUserId: s.alertUserId(), slackTrigger: trigger, channelName: (id) => s.channelName(id) }
  }

  validate(raw: unknown, flagCtx?: Parameters<typeof authorFlags>[1]) {
    const ctx = this.d.ctx()
    const prov = new Map(this.d.providers().map((p) => [p.id, p]))
    return validateAuthoredDraft(
      raw,
      {
        ...ctx,
        engineValidate: (d) => this.d.engineValidate(d),
        available: (a) => a === 'shell' || !!prov.get(a)?.available
      },
      { agentAuthored: true, flagCtx }
    )
  }

  /** PO2: optional schedule riding on create/update. */
  private parseSchedule(raw: unknown, inputs: WorkflowDraft['inputs'], fallbackName: string): { schedule: AuthorDraftSchedule } | { errors: ValidationError[] } {
    if (!isObj(raw)) return { errors: [{ path: 'schedule', message: 'schedule must be an object {when, name?, inputs?, enabled?}' }] }
    if (raw.enabled !== undefined && raw.enabled !== null && typeof raw.enabled !== 'boolean') {
      return { errors: [{ path: 'schedule.enabled', message: 'schedule.enabled must be true or false (false = created paused)' }] }
    }
    const enabled = raw.enabled !== false
    const w = raw.when
    if (!isObj(w) || (w.kind !== 'cron' && w.kind !== 'at')) return { errors: [{ path: 'schedule.when', message: "schedule.when must be {kind:'cron', cron, tz?} or {kind:'at', at}" }] }
    let when: ScheduleWhen
    if (w.kind === 'cron') {
      if (typeof w.cron !== 'string' || !w.cron.trim()) return { errors: [{ path: 'schedule.when', message: 'schedule.when.cron is required' }] }
      when = { kind: 'cron', cron: w.cron.trim().slice(0, 120), tz: typeof w.tz === 'string' && w.tz.trim() ? w.tz.trim().slice(0, 64) : this.d.tz() }
    } else {
      if (typeof w.at !== 'string' || Number.isNaN(Date.parse(w.at))) return { errors: [{ path: 'schedule.when', message: 'schedule.when.at must be an ISO date-time' }] }
      when = { kind: 'at', at: new Date(w.at).toISOString() }
    }
    const p = this.d.previewSchedule(when)
    if (!p.ok) return { errors: [{ path: 'schedule.when', message: p.error ?? 'Invalid schedule' }] }
    const ins = this.parseInputs(raw.inputs, inputs, 'schedule.inputs')
    if ('errors' in ins) return ins
    const name = str(raw.name, 120)?.trim() || fallbackName
    return { schedule: { name, when, inputs: ins.inputs, sentence: p.sentence, next: enabled ? p.next : [], ...(enabled ? {} : { enabled: false }) } }
  }

  private parseInputs(raw: unknown, defs: WorkflowDraft['inputs'], path: string): { inputs: Record<string, string> } | { errors: ValidationError[] } {
    if (raw === undefined || raw === null) return { inputs: {} }
    if (!isObj(raw)) return { errors: [{ path, message: `${path} must be an object of input name -> string` }] }
    const known = new Set(defs.map((i) => i.name))
    const bools = new Set(defs.filter((i) => i.type === 'boolean').map((i) => i.name))
    const out: Record<string, string> = {}
    const errors: ValidationError[] = []
    for (const [k, v] of Object.entries(raw)) {
      if (!known.has(k)) errors.push({ path, message: `${path}: unknown input "${k}" (inputs: ${[...known].join(', ') || 'none'})` })
      else if (bools.has(k) && typeof v === 'boolean') out[k] = v ? 'true' : 'false'
      else if (typeof v !== 'string' || v.length > 20_000) errors.push({ path, message: `${path}: "${k}" must be a string (<= 20,000 chars)` })
      else out[k] = v
    }
    // typed checkbox inputs take exactly true / false; anything else is refused, never guessed
    for (const e of inputValueErrors(defs, out)) errors.push({ path, message: `${path}: ${e.message}` })
    return errors.length ? { errors } : { inputs: out }
  }

  private unattended(workflowId: Id): { sentence: string; nextAt: string | null }[] {
    return this.d
      .listSchedules()
      .filter((s) => s.enabled && s.target.kind === 'workflow' && s.target.workflowId === workflowId)
      .map((s) => ({ sentence: s.sentence, nextAt: s.nextFireAt }))
  }

  private ownerOf(sessionId: Id): DraftOwner {
    const o = this.d.owner(sessionId)
    if (!o) throw new Error('This Hive session is no longer known to Hive.')
    return o
  }

  /** hive_workflow_create / hive_workflow_update. */
  async propose(sessionId: Id, kind: 'create' | 'update', args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const owner = this.ownerOf(sessionId)
    const summary = str(args.summary, 800)?.trim() ?? ''
    if (summary.length < 10) return { status: 'invalid', errors: [{ path: 'summary', message: 'summary is required (10-800 chars): what it does, when, what it touches' }], warnings: [] }
    let target: Workflow | null = null
    if (kind === 'update') {
      target = this.d.getWorkflow(String(args.id ?? ''))
      if (!target) return { status: 'invalid', errors: [{ path: 'id', message: 'Workflow not found. Call hive_workflow_list.' }], warnings: [] }
    }
    const pre = this.validate(args.workflow)
    let schedule: AuthorDraftSchedule | null = null
    const errors = [...pre.errors]
    if (args.schedule !== undefined && args.schedule !== null) {
      const s = this.parseSchedule(args.schedule, pre.normalized.inputs, pre.normalized.name || target?.name || 'Schedule')
      if ('errors' in s) errors.push(...s.errors)
      else schedule = s.schedule
    }
    let runNow: { inputs: Record<string, string> } | null = null
    if (args.run_now !== undefined && args.run_now !== null) {
      const rn = isObj(args.run_now) ? this.parseInputs(args.run_now.inputs, pre.normalized.inputs, 'run_now.inputs') : { errors: [{ path: 'run_now', message: 'run_now must be {inputs?}' }] }
      if ('errors' in rn) errors.push(...rn.errors)
      else runNow = { inputs: rn.inputs }
    }
    let slackTrigger: { input: SlackTriggerInput; flag: NonNullable<AuthorFlags['slackTrigger']> } | null = null
    if (args.slack_trigger !== undefined && args.slack_trigger !== null) {
      if (!this.d.slackTriggers) errors.push({ path: 'slack_trigger', message: 'Slack triggers are not available in this Hive' })
      else {
        const st = this.d.slackTriggers.prepare(args.slack_trigger, pre.normalized)
        if ('errors' in st) errors.push(...st.errors)
        else slackTrigger = st
      }
    }
    if (errors.length) return { status: 'invalid', errors, warnings: pre.warnings }
    const v = this.validate(args.workflow, {
      profiles: this.d.ctx().profiles,
      repos: this.d.ctx().repos,
      ...this.slackFlagCtx(slackTrigger?.flag ?? null),
      scheduleSentence: schedule ? (schedule.enabled === false ? `${schedule.sentence} · created paused (turn it on in Schedules)` : schedule.sentence) : null,
      inputs: runNow?.inputs ?? null,
      unattended: target ? this.unattended(target.id) : null
    })
    const draftIn = {
      kind,
      owner,
      summary,
      workflowId: target?.id ?? null,
      workflowName: v.normalized.name,
      payload: v.normalized,
      base: target ? stripWorkflow(target) : null,
      schedule,
      runNow,
      flags: v.flags,
      warnings: v.warnings,
      slackTrigger: slackTrigger?.input ?? null
    } as const
    const dup = this.d.drafts.findPendingDuplicate(owner.ownerKey, AuthorDrafts.contentHash(draftIn))
    if (!dup && this.d.drafts.pendingCount(owner.ownerKey) >= MAX_PENDING_PER_OWNER) {
      throw new Error(`You already have ${MAX_PENDING_PER_OWNER} drafts waiting for the user. Ask them to decide first.`)
    }
    const rec = dup ?? this.open(this.d.drafts.insert(draftIn))
    return this.waitFor(rec.id, clampWait(args.wait_s, DEFAULT_WAIT_S), signal)
  }

  private open(rec: DraftRecord): DraftRecord {
    let ask: Ask | null = null
    try {
      ask = this.d.openAsk(rec)
    } catch (e) {
      this.d.log?.warn('author: could not open the approval ask', { draftId: rec.id, e: String(e) })
    }
    if (ask) this.d.drafts.setAsk(rec.id, ask.id)
    const fresh = this.d.drafts.get(rec.id) ?? rec
    this.d.emitDraft(publicDraft(fresh))
    this.d.log?.info('author: draft proposed', { draftId: rec.id, kind: rec.kind, owner: rec.ownerLabel })
    return fresh
  }

  /** hive_workflow_run (§2.4, PO3). */
  async run(sessionId: Id, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const owner = this.ownerOf(sessionId)
    const wf = this.d.getWorkflow(String(args.workflow_id ?? ''))
    if (!wf) return { status: 'invalid', errors: [{ path: 'workflow_id', message: 'Workflow not found. Call hive_workflow_list.' }], warnings: [] }
    const ins = this.parseInputs(args.inputs, wf.inputs, 'inputs')
    if ('errors' in ins) return { status: 'invalid', errors: ins.errors, warnings: [] }
    const reason = str(args.reason, 400)
    if (this.d.activeAgentRuns(owner.ownerKey) >= MAX_AGENT_RUNS_PER_OWNER) {
      return { status: 'conflict', note: `You already have ${MAX_AGENT_RUNS_PER_OWNER} runs going. Wait for one to finish (hive_run_get).` }
    }
    // standing permission: only the owner who created it, only while the workflow is exactly what was approved,
    // and only with command-referenced inputs at their defaults (PO3)
    const grant = this.d.drafts.getGrant(wf.id, owner.ownerKey)
    const pinned = !!grant && wf.origin?.ownerKey === owner.ownerKey && grant.contentHash === workflowHash(wf)
    const blockers = pinned ? preAllowedRunBlockers(wf, ins.inputs) : []
    if (pinned && blockers.length === 0) {
      const run = this.d.startRun(wf.id, ins.inputs, { ownerLabel: owner.ownerLabel, ownerKey: owner.ownerKey, draftId: null })
      this.d.log?.info('author: run started on standing permission', { workflowId: wf.id, runId: run.id, owner: owner.ownerLabel })
      return { status: 'started', run_id: run.id, approved_by: 'standing_permission' }
    }
    const flags = authorFlags(wf, { ...this.d.ctx(), ...this.slackFlagCtx(null), inputs: ins.inputs, unattended: null })
    const warnings = flagLines(flags)
    if (blockers.length) warnings.unshift(`Needs approval: ${blockers.map((b) => `input "${b}"`).join(', ')} differs from its default and is executed as shell`)
    const draftIn = {
      kind: 'run' as const,
      owner,
      summary: reason?.trim() || `Run "${wf.name}"`,
      workflowId: wf.id,
      workflowName: wf.name,
      payload: { inputs: ins.inputs, reason },
      base: null,
      schedule: null,
      runNow: null,
      flags,
      warnings
    }
    const dup = this.d.drafts.findPendingDuplicate(owner.ownerKey, AuthorDrafts.contentHash(draftIn))
    if (!dup && this.d.drafts.pendingCount(owner.ownerKey) >= MAX_PENDING_PER_OWNER) {
      throw new Error(`You already have ${MAX_PENDING_PER_OWNER} drafts waiting for the user. Ask them to decide first.`)
    }
    const rec = dup ?? this.open(this.d.drafts.insert(draftIn))
    return this.waitFor(rec.id, clampWait(args.wait_s, DEFAULT_WAIT_S), signal)
  }

  async draftStatus(sessionId: Id, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const owner = this.ownerOf(sessionId)
    const rec = this.d.drafts.get(String(args.draft_id ?? ''))
    if (!rec || rec.ownerKey !== owner.ownerKey) throw new Error('Draft not found (only your own drafts are visible).')
    return this.waitFor(rec.id, clampWait(args.wait_s, 0), signal)
  }

  async runGet(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const id = String(args.run_id ?? '')
    const outChars = typeof args.output_chars === 'number' ? Math.min(Math.max(Math.floor(args.output_chars), 0), 4000) : 1500
    const deadline = this.now() + clampWait(args.wait_s, 0) * 1000
    let det = this.d.getRunDetail(id)
    if (!det) throw new Error('Run not found.')
    while (!TERMINAL.has(det.run.status) && this.now() < deadline && !signal.aborted) {
      await this.sleep(Math.min(1000, Math.max(0, deadline - this.now())), signal)
      det = this.d.getRunDetail(id) ?? det
    }
    const r = det.run
    return {
      run: { id: r.id, title: r.title, status: r.status, outcome: r.outcome ?? null, reason: r.reason, startedAt: r.startedAt, endedAt: r.endedAt, worktree: r.worktree ?? null },
      steps: det.steps.map((s) => ({
        nodeId: s.nodeId,
        nodeType: s.nodeType,
        attempt: s.attempt,
        status: s.status,
        verdict: s.verdict,
        halt: s.halt ?? null,
        error: s.error,
        output: s.output ? s.output.slice(Math.max(0, s.output.length - outChars)) : null
      }))
    }
  }

  // ---------- waiting ----------

  /** The tool result for a draft's current state. */
  resultFor(rec: DraftRecord): Record<string, unknown> {
    const res = rec.result ?? null
    if (rec.status === 'approved') {
      if (rec.kind === 'run') return { status: 'started', draft_id: rec.id, run_id: res?.runId ?? null, approved_by: 'user', note: rec.decisionNote }
      return {
        status: 'approved',
        draft_id: rec.id,
        workflow_id: res?.workflowId ?? rec.workflowId,
        edited: rec.edited,
        run_allowed: rec.runAllowed,
        note: rec.decisionNote,
        ...(res?.scheduleId ? { schedule_id: res.scheduleId, sentence: rec.scheduleRequest?.sentence ?? null, schedule_enabled: rec.scheduleRequest?.enabled !== false } : {}),
        ...(res?.runId ? { run_id: res.runId } : {})
      }
    }
    if (rec.status === 'rejected') return { status: 'rejected', draft_id: rec.id, note: rec.decisionNote }
    if (rec.status === 'expired') return { status: 'expired', draft_id: rec.id, note: 'The user did not decide within 7 days.' }
    return { status: 'pending', draft_id: rec.id, note: 'The user has not decided yet. Do not create a duplicate; call hive_draft_status.' }
  }

  private waitFor(draftId: Id, waitS: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    const rec = this.d.drafts.get(draftId)
    if (!rec) return Promise.reject(new Error('Draft not found'))
    if (rec.status !== 'pending' || waitS === 0 || signal.aborted) return Promise.resolve(this.resultFor(rec))
    return new Promise((resolve) => {
      let done = false
      const set = this.waiters.get(draftId) ?? new Set<Waiter>()
      this.waiters.set(draftId, set)
      const finish = (r: Record<string, unknown>) => {
        if (done) return
        done = true
        clearTimeout(timer)
        set.delete(waiter)
        if (!set.size) this.waiters.delete(draftId)
        resolve(r)
      }
      const waiter: Waiter = (r) => finish(r)
      set.add(waiter)
      const timer = setTimeout(() => finish(this.resultFor(this.d.drafts.get(draftId) ?? rec)), waitS * 1000)
      timer.unref?.()
      signal.addEventListener('abort', () => finish(this.resultFor(this.d.drafts.get(draftId) ?? rec)), { once: true })
    })
  }

  private wake(rec: DraftRecord): void {
    const r = this.resultFor(rec)
    for (const w of [...(this.waiters.get(rec.id) ?? [])]) w(r)
  }

  // ---------- renderer side ----------

  list(q: { status?: AuthorDraft['status'][]; limit?: number } = {}): AuthorDraft[] {
    return this.d.drafts.list(q).map(publicDraft)
  }

  get(id: Id): AuthorDraftDetail {
    const rec = this.d.drafts.get(id)
    if (!rec) throw new HiveError('not_found', 'Draft not found')
    const target = rec.workflowId ? this.d.getWorkflow(rec.workflowId) : null
    const detail = this.d.drafts.detail(rec, target)
    // PO8: recompute "Runs unattended" against today's schedules while pending
    if (rec.status === 'pending' && rec.kind === 'update' && rec.workflowId) {
      const u = this.unattended(rec.workflowId)
      detail.flags = { ...detail.flags, unattended: u.length ? u : null, ...this.alertUserMissing(detail.flags) }
    } else if (rec.status === 'pending') {
      detail.flags = { ...detail.flags, ...this.alertUserMissing(detail.flags) }
    }
    return detail
  }

  /** The card's primary button text (PO2). */
  approveLabel(id: Id): string {
    const rec = this.d.drafts.get(id)
    if (!rec) return 'Approve'
    return approveLabel({ kind: rec.kind, hasSchedule: !!rec.scheduleRequest, runNow: !!rec.runNowRequest, schedulePaused: rec.scheduleRequest?.enabled === false })
  }

  /** author:decide (and asks:answer on an approval ask). One click does everything the card says (PO2). */
  decide(req: { id: Id; decision: 'approve' | 'reject'; note?: string; allowRun?: boolean; draft?: WorkflowDraft }): AuthorDraft {
    const rec = this.d.drafts.get(req.id)
    if (!rec) throw new HiveError('not_found', 'Draft not found')
    if (rec.status !== 'pending') throw new HiveError('conflict', `This draft was already ${rec.status}`)
    const note = req.note?.trim() ? req.note.trim().slice(0, 2000) : null
    if (req.decision === 'reject') {
      const done = this.d.drafts.decide(rec.id, { status: 'rejected', note })
      if (!done) throw new HiveError('conflict', 'This draft was already decided')
      return this.finishDecision(done, 'reject', note)
    }
    const at = new Date(this.now()).toISOString()
    let result: DraftResult = { workflowId: rec.workflowId, scheduleId: null, runId: null }
    let edited = false
    let payload: WorkflowDraft | null = null
    const startedBy = { ownerLabel: rec.ownerLabel, ownerKey: rec.ownerKey, draftId: rec.id }
    if (rec.kind === 'create' || rec.kind === 'update') {
      const proposed = rec.payload as WorkflowDraft
      const draft = req.draft ?? proposed
      edited = !!req.draft && JSON.stringify(req.draft) !== JSON.stringify(proposed)
      if (!edited) {
        // re-check PO4 and the engine at approve time (profiles/repos may have changed since)
        const v = this.validate(draft)
        if (!v.ok) throw new HiveError('validation', v.errors[0].message, v.errors)
      }
      payload = draft
      if (rec.kind === 'create') {
        const origin: WorkflowOrigin = {
          kind: 'agent',
          adapter: rec.adapter,
          ownerLabel: rec.ownerLabel,
          ownerKey: rec.ownerKey,
          sessionId: rec.sessionId,
          runId: null,
          stepId: null,
          draftId: rec.id,
          approvedAt: at,
          edited
        }
        const wf = this.d.saveWorkflow(draft, origin) // throws HiveError('validation') -> draft stays pending
        result.workflowId = wf.id
      } else {
        const id = rec.workflowId!
        const cur = this.d.getWorkflow(id)
        if (!cur) throw new HiveError('not_found', 'The workflow was deleted; reject this draft')
        const wf = this.d.updateWorkflow(id, draft)
        if (cur.origin) {
          const updatedBy = [...(cur.origin.updatedBy ?? []), { draftId: rec.id, ownerLabel: rec.ownerLabel, at }].slice(-20)
          this.d.setOrigin(id, { ...cur.origin, updatedBy })
        }
        result.workflowId = wf.id
      }
      this.d.changed('workflows')
      const saved = this.d.getWorkflow(result.workflowId!)
      // PO3: the box on this card (re)creates the permission pinned to exactly what was saved; any later change voids it
      if (req.allowRun && saved && saved.origin?.ownerKey === rec.ownerKey) {
        this.d.drafts.grant({ workflowId: saved.id, ownerKey: rec.ownerKey, ownerLabel: rec.ownerLabel, contentHash: workflowHash(saved) })
      }
      if (rec.scheduleRequest && saved) {
        try {
          const s = rec.scheduleRequest
          const sch = this.d.createSchedule({ name: s.name ?? saved.name, workflowId: saved.id, inputs: s.inputs, when: s.when, preset: presetFor(s.when), enabled: s.enabled !== false })
          result.scheduleId = sch.id
          this.d.changed('schedules')
        } catch (e) {
          this.d.log?.warn('author: schedule on approval failed', { draftId: rec.id, e: String(e) })
          result = { ...result, sentence: `Schedule failed: ${e instanceof Error ? e.message : String(e)}` }
        }
      }
      if (rec.slackTriggerRequest && saved && this.d.slackTriggers) {
        try {
          const origin = saved.origin ?? null
          this.d.slackTriggers.save({ ...rec.slackTriggerRequest, workflowId: saved.id }, saved.id, origin)
        } catch (e) {
          this.d.log?.warn('author: slack trigger on approval failed', { draftId: rec.id, e: String(e) })
        }
      }
      if (rec.runNowRequest && saved) {
        try {
          result.runId = this.d.startRun(saved.id, rec.runNowRequest.inputs, startedBy).id
        } catch (e) {
          this.d.log?.warn('author: run_now on approval failed', { draftId: rec.id, e: String(e) })
        }
      }
    } else {
      const p = rec.payload as { inputs: Record<string, string>; reason: string | null }
      if (!rec.workflowId || !this.d.getWorkflow(rec.workflowId)) throw new HiveError('not_found', 'The workflow was deleted; reject this request')
      result.runId = this.d.startRun(rec.workflowId, p.inputs, startedBy).id
    }
    const done = this.d.drafts.decide(rec.id, {
      status: 'approved',
      note,
      edited,
      runAllowed: !!req.allowRun && (rec.kind === 'create' || rec.kind === 'update'),
      result,
      payload,
      workflowId: result.workflowId
    })
    if (!done) throw new HiveError('conflict', 'This draft was already decided')
    return this.finishDecision(done, 'approve', note)
  }

  private finishDecision(done: DraftRecord, option: 'approve' | 'reject', note: string | null): AuthorDraft {
    if (done.askId) {
      try {
        this.d.closeAsk(done.askId, { status: 'answered', optionId: option, message: note })
      } catch (e) {
        this.d.log?.warn('author: could not close the approval ask', { e: String(e) })
      }
    }
    this.wake(done)
    const pub = publicDraft(done)
    this.d.emitDraft(pub)
    this.d.log?.info('author: draft decided', { draftId: done.id, status: done.status })
    return pub
  }

  /** Boot + daily: expire pending drafts older than 7 days, drop decided ones older than 90. */
  sweep(): number {
    const { expired } = this.d.drafts.sweep()
    for (const e of expired) {
      if (e.askId) {
        try {
          this.d.closeAsk(e.askId, { status: 'expired', optionId: null, message: null })
        } catch {
          /* ignore */
        }
      }
      this.wake(e)
      this.d.emitDraft(publicDraft(e))
    }
    return expired.length
  }

  grants(): AuthorRunGrant[] {
    return this.d.drafts.grants((id) => this.d.getWorkflow(id))
  }
  revokeRun(workflowId: Id, ownerKey: string): void {
    this.d.drafts.revoke(workflowId, ownerKey)
  }
  onWorkflowRemoved(workflowId: Id): void {
    this.d.drafts.revokeWorkflow(workflowId)
  }
}
