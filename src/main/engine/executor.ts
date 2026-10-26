/**
 * Headless run execution: prompt runs and workflow DAGs (agent / room / check / shell / wait / notify).
 * SPEC 7.3 + A3 (resume on retry), A4 (check loop body + gating), A5 (rooms), A7 (ARTIFACTS_DIR), A8 (headless).
 * AUTHORING.md §5 (stop-if), §6 (worktree per run + PO5 push guard), §7 (wait, notify).
 */
import { attachGateway, GATEWAY_TOOLS } from '../gateway/attach'
import { attachForum } from '../forum/attach'
import { principiaOps } from '../company/principiaOps'
import { isHarnessAuthFailure } from './harnessFailure'
import { createWriteStream, existsSync, mkdirSync, rmdirSync, writeFileSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { TASK_WRAP_UP_MS, TASK_WRAP_UP_TEXT, type EngineContext, type ForumSpawn, type McpServerSpec, type MemoryGrant, type RunTaskLink, type TaskToolset } from '../../shared/engine'
import type { NotifyResult } from '../../shared/authoring'
import type { Ask, AskAnswer } from '../../shared/live'
import type { MemoryMode } from '../../shared/memory'
import { newId } from '../../shared/ids'
import type {
  AdapterId,
  AgentNode,
  ShellNode,
  AgentProfile,
  CheckNode,
  NotifyNode,
  ProviderInfo,
  RoomNode,
  Run,
  RunStep,
  RunWorktree,
  StepNodeType,
  WaitNode,
  WorkflowDraft,
  WorkflowNode
} from '../../shared/types'
import { HALT_NODE_TYPES, detectHalt } from './authoring'
import { booleanValue, isDryRun } from '../../shared/inputs'
import { baseBranch, installPushGuard, pushGuardEnv } from './pushGuard'
import { geminiAgentNames, unroutedAsksNotice, usesGate, type Adapter } from './adapters'
import { buildChildEnv, childKeyNames, runReportPath } from './env'
import { RUN_REPORT_ENV } from '../../shared/orchestrator'
import { effectiveDeps, loopBody, topoOrder, descendants, type DepMap } from './graph'
import { eventToChunk, parseVerdict } from './parse'
import {
  MCP_TOOL_TIMEOUT_MS,
  MCP_VERIFIED,
  agentBrief,
  claudeSessionMcpAttach,
  codexToolsAttach,
  isMemoryMode,
  memoryTransport,
  nodeMemoryMode,
  removeMcpFiles,
  withBrief,
  writeMcpFiles,
  type McpAttachment
} from './memory'
import { startProcess, type ProcHandle, type ProcResult } from './process'
import { StepLive } from './stepLive'
import { classifyLimitText, classifyStreamLine, laterReset, type LimitHit } from './live/limits'
import { claudeUserMessage } from './live/claudeControl'
import type { StallMonitor } from './live/stall'
import { parseRefs, render, type RenderScope, type TriggerVars } from './templates'
import { TRIGGER_IN_COMMAND, hiveOutVar, slackCommandHint } from './validate'
import { SLACK_TOOLS, SLACK_WORK_TOOLS, slackAccessOf, type NotifySlackTarget, type SlackAgentAccess } from '../../shared/slack'
import { UNTRUSTED_SLACK_NOTE, triggerVars } from './slackTriggers'
import { FEEDBACK_TAIL, LineBuffer, OUTPUT_CAP, Semaphore, cap, isDir, tail } from './util'

export interface ExecDeps {
  ctx: EngineContext
  adapters: Record<AdapterId, Adapter>
  provider(id: AdapterId): ProviderInfo
  semaphore: Semaphore
  now(): Date
  /** Ask expiry (default 60 min; tests shorten it). */
  askTimeoutMs?: number
  /** "Stalled?" detection for running steps (CONTRACT §13). Absent = off. */
  stall?: StallMonitor
  /** Length of one wait-node "second" (interval, per-try cap, timeoutMin budget). Default 1000; tests shrink it. */
  waitSecondMs?: number
  /** Length of one task-run cap "minute" (TaskRun.runMinutes). Default 60 000; tests shrink it. */
  taskMinuteMs?: number
  /**
   * May a step of this run fall back to another harness (usage limit, auth failure)? Absent = yes, whenever it is
   * installed (desktop). The cloud allows only harnesses the run has an account for (CLOUD.md §7.2).
   */
  harnessFallback?: (runId: string, to: AdapterId) => boolean
}

/** DEPARTMENTS.md §3.6, §4.3: what a board task run adds to an execution (StartRunOptions.taskId…). */
export interface TaskRun extends RunTaskLink {
  /** a resumed Claude turn: `--resume` this conversation (prompt runs) */
  resumeSessionId: string | null
  /** the time cap; warned in-band ~2 min before, then the run is canceled. null = no cap */
  runMinutes: number | null
}

/** Step error for the other steps of a run that a HIVE_STOP ended (AUTHORING.md §5). */
export const HALT_SKIP_ERROR = 'Run ended early: nothing to do'

/** Auto retry when the reset time is unknown (CONTRACT §13). */
export const RETRY_FALLBACK_MS = 60 * 60_000
/** Retry a little after the reset so the window has really reopened. */
export const RETRY_AFTER_RESET_MS = 60_000

/** When a "Retry at reset" should fire: reset + 1 min, never in the past; unknown reset = in 1 h. */
export function retryTime(resetAt: string | null | undefined, now: Date): string {
  const r = resetAt ? Date.parse(resetAt) : NaN
  const at = Number.isFinite(r) ? Math.max(r + RETRY_AFTER_RESET_MS, now.getTime() + RETRY_AFTER_RESET_MS) : now.getTime() + RETRY_FALLBACK_MS
  return new Date(at).toISOString()
}

export const retryPrompt = (feedback: string, guard: string | null = null): string =>
  `A reviewer rejected your previous attempt:\n${feedback}\nFix it.${guard ? `\n\n${guard}` : ''}`

/** Lines of an agent's original prompt that constrain pushing in a dry run; a fix round must carry them too. */
const GUARD_LINE = /dry[\s_-]?run|HIVE_DRY_RUN|\bdo not push\b|\bdon['’]?t push\b|\bnever push\b/i
export const DRY_RUN_GUARD =
  'DRY RUN (dry_run = true): do not push, do not open, update or merge PRs, and do not post comments. Hive refuses every git push in this run; report what you would have done instead.'

/**
 * The dry-run guard of an agent step (item: fix rounds keep the original step's guard): the original prompt's lines
 * about dry runs / not pushing, plus Hive's own sentence when the run is a dry run. null = nothing to carry.
 */
export function fixRoundGuard(originalPrompt: string, dryRun: boolean): string | null {
  const lines = originalPrompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && GUARD_LINE.test(l))
  const parts = [...(dryRun ? [DRY_RUN_GUARD] : []), ...(lines.length ? ['Same rules as before:', ...lines] : [])]
  if (!parts.length) return null
  const text = parts.join('\n')
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text
}

export const reviewerPrompt = (criteria: string, targetLabel: string, targetOutput: string): string =>
  [
    `You are reviewing the work of another agent ("${targetLabel}").`,
    '',
    'Criteria:',
    criteria,
    '',
    `Output of "${targetLabel}":`,
    targetOutput || '(no output)',
    '',
    'Inspect the files in the working directory if that helps. Explain concrete problems so they can be fixed.',
    'End with exactly one line: VERDICT: PASS or VERDICT: FAIL'
  ].join('\n')

export const roomTurnPrompt = (label: string, others: string[], transcript: string, summary: boolean): string =>
  [
    `You are ${label} in a discussion with ${others.join(', ')}.`,
    '',
    transcript,
    '',
    summary ? 'Summarize the conclusion and decided actions.' : 'Reply with your next contribution.'
  ].join('\n')

interface StepSpec {
  nodeId: string
  nodeType: StepNodeType
  attempt: number
  round: number | null
  participantLabel: string | null
  profile: AgentProfile | null
  adapterId: AdapterId
  cwd: string
  prompt: string
  resumeId: string | null
  sourceStepIds: string[]
  timeoutMin: number
  /** Memory gate for this spawn (already clamped for the node type). Absent = off. */
  memory?: MemoryMode
  /** Text the memory brief's relevance search runs on (original prompt / room topic / criteria). */
  briefQuery?: string
  /** Node label, denormalized onto the memory grant for provenance. */
  nodeLabel?: string | null
  /** Merged last into the child env (isolated nodes: HIVE_WORKTREE*, PO5 push guard). */
  extraEnv?: Record<string, string>
  /** Decide final status/verdict from the process outcome (check nodes). */
  finalize?(o: StepOutcome): { status: 'passed' | 'failed'; verdict: 'PASS' | 'FAIL' | null; error: string | null }
}
export interface StepOutcome {
  /** Internal: this attempt ended on a provider usage limit. */
  limitHit?: LimitHit
  /** Provider unavailable or unable to authenticate; ordinary task errors never set this. */
  harnessUnavailable?: boolean
  status: 'passed' | 'failed' | 'canceled'
  stepId: string | null
  output: string
  /** stdout+stderr, for command reviewers' feedback. */
  combined: string
  error: string | null
  exitCode: number | null
  timedOut: boolean
  agentSessionId: string | null
  verdict: 'PASS' | 'FAIL' | null
}

interface NodeResult {
  output: string
  transcript: string
  stepId: string | null
  agentSessionId: string | null
  cwd: string
}
interface NodeState {
  status: 'pending' | 'running' | 'passed' | 'failed'
  gen: number
  attempt: number
}

export class Execution {
  /** 'halted' = a step emitted HIVE_STOP: the run ends passed · nothing to do (AUTHORING.md §5). */
  private stopped: 'canceled' | 'failed' | 'halted' | null = null
  private halted: { label: string; reason: string } | null = null
  /** The run's worktree (AUTHORING.md §6): created lazily by the first isolated node, shared by all. */
  private worktreeP: Promise<RunWorktree> | null = null
  private worktree: RunWorktree | null = null
  private guard: Record<string, string> | null = null
  /** Cancelable sleeps (wait nodes): woken by killAll. */
  private sleepers = new Set<() => void>()
  private closing: Promise<void> | null = null
  private stopReason: string | null = null
  private procs = new Map<string, Set<ProcHandle>>()
  private seq = 0
  private tasks = new Set<Promise<void>>()
  /** Live state of running steps (agent tree + asks), by step id. */
  private lives = new Map<string, StepLive>()
  /** A step failed on a usage / rate limit (CONTRACT §13): the run's stop reason + latest reset. */
  private limit: { resetAt: string | null } | null = null
  readonly done: Promise<void>
  private resolveDone!: () => void
  /** The run's boolean dry_run input is true: $HIVE_DRY_RUN=1 in every step and the worktree hook refuses every push. */
  readonly dryRun: boolean

  constructor(
    private d: ExecDeps,
    public run: Run,
    private workflow: WorkflowDraft | null,
    private task: TaskRun | null = null,
    /** FORUM.md §3: a seat run without a board task (a Forum reply): the step still gets that seat's Forum access */
    private seatAgentId: string | null = null
  ) {
    this.done = new Promise((r) => (this.resolveDone = r))
    const t = run.target
    this.dryRun = !!workflow && t.kind === 'workflow' && isDryRun(workflow.inputs ?? [], t.inputs ?? {})
  }

  /** Env every step of a workflow run gets on top of the Hive vars. */
  private runVars(): Record<string, string> {
    const sl = this.run.slack
    return {
      ...(this.run.target.kind === 'workflow' ? { HIVE_DRY_RUN: this.dryRun ? '1' : '0' } : {}),
      // SLACK.md §9.4: ids only (never text, never a token) for shell steps that want to log them
      ...(sl ? { HIVE_SLACK_CHANNEL: sl.channelId, HIVE_SLACK_THREAD_TS: sl.threadTs, HIVE_SLACK_PERMALINK: sl.permalink } : {})
    }
  }

  /** SLACK.md §9.6: images people shared in the triggering thread, downloaded into the run's artifacts at run start. */
  private slackImages: string[] = []
  private async loadSlackImages(): Promise<void> {
    const sl = this.run.slack
    const fetch = this.ctx.slack?.downloadThreadImages
    if (!sl || !fetch) return
    try {
      const paths = await fetch.call(this.ctx.slack, { channelId: sl.channelId, threadTs: sl.threadTs, destDir: join(this.run.artifactsDir, 'slack-images') })
      this.slackImages = (paths ?? []).filter((p) => typeof p === 'string' && p.length > 0).slice(0, 5)
    } catch (e) {
      // best effort: the run goes on without images
      this.ctx.log.warn('engine: slack thread images failed', { runId: this.run.id, error: String(e) })
    }
  }
  /** The prompt block that points a Slack-triggered agent at the thread's images ('' when none or already listed). */
  private slackImagesNote(prompt: string): string {
    if (!this.run.slack || !this.slackImages.length || this.slackImages.every((p) => prompt.includes(p))) return ''
    return `Images shared in this Slack thread (open them with your Read tool before answering):\n${this.slackImages.join('\n')}`
  }

  /** SLACK.md §9.2: `{{trigger.*}}` values, computed once at run start (thread transcript from main's mirror). */
  private triggerScope: TriggerVars | null | undefined = undefined
  private triggerValues(): TriggerVars | null {
    if (this.triggerScope !== undefined) return this.triggerScope
    const sl = this.run.slack
    if (!sl) return (this.triggerScope = null)
    let thread = ''
    try {
      thread = this.ctx.slack?.threadTranscript({ channelId: sl.channelId, threadTs: sl.threadTs }) ?? ''
    } catch (e) {
      this.ctx.log.warn('engine: slack thread transcript failed', { runId: this.run.id, error: String(e) })
    }
    const v = triggerVars(sl, thread, this.slackImages)
    const red = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.redact(x)])) as TriggerVars
    return (this.triggerScope = red)
  }

  /**
   * SLACK.md SA2: the agent access of this run, or null when nothing in it comes from Slack. A Slack-triggered run uses
   * its trigger's access (absent = restricted, no keys). A slackTools workflow reads Slack through its tools, so its
   * agent steps are restricted too (it has no trigger to widen that) but keep their profile's keys.
   */
  slackAccess(): (SlackAgentAccess & { keys: 'trigger' | 'profile' }) | null {
    if (this.run.slack) return { ...slackAccessOf(this.run.slack.access), keys: 'trigger' }
    if (this.workflow?.slackTools) return { fullPermissions: this.workflow.slackAgentPermissions === 'profile', secretNames: [], keys: 'profile' }
    return null
  }

  /** SLACK.md §9.4: headless claude steps of a Slack-triggered run (or a slackTools workflow) get the slack toolset. */
  private slackToolsWanted(): boolean {
    if (!this.run.slack && !this.workflow?.slackTools) return false
    try {
      return !!this.ctx.slack?.connected()
    } catch {
      return false
    }
  }

  /** Review fix: anything in this run may carry Slack text (a Slack trigger started it, or its agents read Slack). */
  private slackDriven(): boolean {
    return !!this.run.slack || !!this.workflow?.slackTools
  }

  /**
   * A node's folder when it names none. Slack-driven runs get their own folder (<scratch>/slack-runs/<runId>), never
   * the shared scratch dir: there an agent could read other Slack sessions' thread transcripts (scratch/slack) and
   * would share Claude's per-folder conversation store with every Chat session.
   */
  private defaultCwd(): string {
    // COMPANY.md §3: a company's repo-less nodes run in its workspace, never in a folder shared with other companies
    if (!this.slackDriven()) return this.companyWorkspace() ?? this.ctx.paths.scratchDir
    const dir = join(this.ctx.paths.scratchDir, 'slack-runs', this.run.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  /** The per-run folder is removed at the end when nothing was left in it (restricted agents cannot write). */
  private cleanupRunDir(): void {
    if (!this.slackDriven()) return
    try {
      rmdirSync(join(this.ctx.paths.scratchDir, 'slack-runs', this.run.id))
    } catch {
      /* absent, or not empty (kept) */
    }
  }

  /** Scripts (lang python / node): the rendered code goes to a file under the run logs; the step runs the interpreter on it. */
  private scriptCommand(n: ShellNode, attempt: number, code: string): string {
    if (!n.lang || n.lang === 'sh') return code
    const dir = join(this.ctx.paths.runLogsDir, 'scripts')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${this.run.id}-${n.id}-${attempt}.${n.lang === 'python' ? 'py' : 'mjs'}`)
    writeFileSync(file, code, { mode: 0o600 })
    return `${n.lang === 'python' ? 'python3' : 'node'} '${file.replace(/'/g, `'\\''`)}'`
  }

  /** Workflow inputs as HIVE_INPUT_<NAME> for shell steps (scripts read data from the env, not templated code). Not in Slack-driven runs. */
  private inputEnv(scope: RenderScope): Record<string, string> {
    if (this.slackDriven()) return {}
    return Object.fromEntries(Object.entries(scope.inputs).map(([k, v]) => [`HIVE_INPUT_${k.toUpperCase()}`, v]))
  }

  /**
   * A shell / wait / check command, rendered. In a Slack-driven run step output and {{trigger.*}} never reach a shell:
   * the command is refused here even if validation was bypassed (an older stored workflow, a trigger added later).
   */
  private commandText(command: string, scope: RenderScope): string {
    if (this.slackDriven()) {
      const bad = parseRefs(command).find((r) => r.kind === 'node' || r.kind === 'trigger')
      if (bad) throw new StepError(`${bad.raw} in a command: ${bad.kind === 'node' ? slackCommandHint(bad.nodeId) : TRIGGER_IN_COMMAND}`)
    }
    return render(command, scope)
  }

  /** $HIVE_OUT_<NODE> files: each finished node's output, so commands read it as data instead of templating it. */
  private outFiles = new Map<string, string>()
  private writeOut(nodeId: string, output: string): void {
    try {
      const dir = join(this.ctx.paths.runLogsDir, this.run.id, 'out')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `${nodeId}.txt`)
      writeFileSync(file, output, { mode: 0o600 })
      this.outFiles.set(nodeId, file)
    } catch (e) {
      this.ctx.log.warn('engine: could not write a node output file', { runId: this.run.id, nodeId, error: String(e) })
    }
  }
  /** Env for a command step: $HIVE_OUT_<NODE> for every node that has passed (in its current loop round). */
  private outEnv(results: Map<string, NodeResult>): Record<string, string> {
    const env: Record<string, string> = {}
    for (const id of results.keys()) {
      const f = this.outFiles.get(id)
      if (f) env[hiveOutVar(id)] = f
    }
    return env
  }

  private get ctx(): EngineContext {
    return this.d.ctx
  }
  private iso(): string {
    return this.d.now().toISOString()
  }
  private redact(s: string): string {
    return this.ctx.secrets.redact(s)
  }

  private updateRun(patch: Partial<Omit<Run, 'id'>>): void {
    this.run = this.ctx.store.updateRun(this.run.id, patch)
    this.ctx.emit({ type: 'run.updated', run: this.run })
  }

  /** Entry point; never throws. */
  async execute(): Promise<void> {
    if (this.stopped) return this.close('canceled', this.stopReason ?? 'Canceled')
    try {
      const missing = this.missingAdapter()
      if (missing) return this.close('failed', missing)
      this.updateRun({ status: 'running', startedAt: this.iso() })
      this.startTaskCap()
      await this.loadSlackImages()
      if (this.run.target.kind === 'prompt') await this.executePrompt()
      else await this.executeWorkflow()
    } catch (e) {
      this.ctx.log.error('engine: run crashed', { runId: this.run.id, error: String(e) })
      if (!this.stopped) this.stopped = 'failed'
      this.stopReason ??= `Internal error: ${e instanceof Error ? e.message : String(e)}`
      await this.killAll()
    }
    const stopped = this.stopped as 'canceled' | 'failed' | 'halted' | null
    if (this.run.status === 'queued' || this.run.status === 'running') {
      if (stopped === 'canceled') await this.close('canceled', this.stopReason ?? 'Canceled')
      else if (stopped === 'failed') await this.close('failed', this.stopReason ?? 'Failed')
      else if (stopped === 'halted' && this.halted) await this.close('passed', `${this.halted.label}: ${this.halted.reason}`, true)
      else await this.close('passed', null)
    }
  }

  /**
   * Ends the run once: settles the worktree first (AUTHORING.md §6.4, PO6: main applies the keep/remove rules), then one
   * final run write carrying status, reason, outcome and the worktree, so main notifies once.
   */
  private close(status: 'passed' | 'failed' | 'canceled', reason: string | null, nothingToDo = false): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      let worktree: RunWorktree | null = null
      const bridge = this.ctx.worktrees
      if (this.worktreeP && bridge) {
        try {
          await this.worktreeP
        } catch {
          /* ensure failed; finish still runs so main can record / clean up */
        }
        try {
          worktree = await withTimeout(bridge.finish(this.run.id, { status, nothingToDo }), 120_000)
        } catch (e) {
          this.ctx.log.warn('engine: worktree finish failed', { runId: this.run.id, error: String(e) })
        }
      }
      this.finish(status, reason, {
        ...(nothingToDo ? { outcome: 'nothing_to_do' as const } : {}),
        ...(worktree ? { worktree } : {})
      })
    })()
    return this.closing
  }

  private finish(status: 'passed' | 'failed' | 'canceled', reason: string | null, more: Partial<Run> = {}): void {
    if (this.run.status !== 'queued' && this.run.status !== 'running') return
    // CONTRACT §13: one write carries the stop reason (and an automatic retry), so main notifies once
    const limited = status === 'failed' && this.limit ? this.limit : null
    const extra: Partial<Run> = limited ? { stopReason: 'rate_limited', resetAt: limited.resetAt, ...this.autoRetry(limited.resetAt) } : {}
    this.updateRun({ status, reason: reason ? this.redact(cap(reason, 4000)) : null, endedAt: this.iso(), ...extra, ...more })
    for (const t of this.capTimers) clearTimeout(t)
    this.capTimers = []
    this.cleanupRunDir()
    this.resolveDone()
  }

  /** Scheduled runs that hit the limit retry exactly once at the reset (Settings.autoRetryRateLimit, default on). */
  private autoRetry(resetAt: string | null): Partial<Run> {
    if (this.run.trigger !== 'schedule' && this.run.trigger !== 'catchup') return {}
    let on = true
    try {
      on = this.ctx.getSettings().autoRetryRateLimit !== false
    } catch {
      on = true
    }
    return on ? { retryAt: retryTime(resetAt, this.d.now()) } : {}
  }

  /** Step ids running right now (their tagged processes are not leftovers). */
  runningStepIds(): string[] {
    return [...this.lives.keys()]
  }

  // ---------- board task runs (DEPARTMENTS.md §3.6, §4.3, §6) ----------

  private capTimers: NodeJS.Timeout[] = []
  /** Running claude steps with stream-json stdin open: the in-band channel of the wrap-up warning. */
  private inband = new Map<string, ProcHandle>()
  /** §3.6: limits.runMinutes as a run-wide timer: the in-band warning ~2 min before, then cancel (the task parks limit). */
  private startTaskCap(): void {
    const minutes = this.task?.runMinutes
    if (!minutes) return
    const unit = this.d.taskMinuteMs ?? 60_000
    const total = minutes * unit
    const lead = Math.min((TASK_WRAP_UP_MS / 60_000) * unit, total / 2)
    const warn = setTimeout(() => this.warnWrapUp(), Math.max(0, total - lead))
    const stop = setTimeout(() => void this.hitTimeLimit(minutes), total)
    warn.unref?.()
    stop.unref?.()
    this.capTimers.push(warn, stop)
  }
  /** Claude reads it as a user message on its open stdin; every running step also shows it as a notice in its tree. */
  private warnWrapUp(): void {
    if (this.run.status !== 'running' || this.stopped) return
    for (const [stepId, live] of this.lives) {
      live.hook({ kind: 'notice', text: TASK_WRAP_UP_TEXT })
      const h = this.inband.get(stepId)
      if (h && !h.write(claudeUserMessage(TASK_WRAP_UP_TEXT))) this.ctx.log.info('engine: wrap-up warning not delivered in-band', { runId: this.run.id, stepId })
    }
  }
  private async hitTimeLimit(minutes: number): Promise<void> {
    if ((this.run.status !== 'queued' && this.run.status !== 'running') || !this.task) return
    try {
      this.ctx.company?.tasks?.timeLimit?.({ runId: this.run.id, taskId: this.task.taskId, minutes })
    } catch (e) {
      this.ctx.log.warn('engine: task time limit hook failed', { runId: this.run.id, error: String(e) })
    }
    await this.cancel(`Time limit reached (${minutes} min)`)
  }
  /** §4.3: the provider conversation id of a claude step of a task run, once per value (task.agentSessionId). */
  private lastTaskSession: string | null = null
  private noteTaskSession(adapter: AdapterId, agentSessionId: string | null): void {
    if (!this.task || adapter !== 'claude' || !agentSessionId || agentSessionId === this.lastTaskSession) return
    this.lastTaskSession = agentSessionId
    try {
      this.ctx.company?.tasks?.sessionCaptured?.({ runId: this.run.id, taskId: this.task.taskId, adapter, agentSessionId })
    } catch (e) {
      this.ctx.log.warn('engine: task session capture failed', { runId: this.run.id, error: String(e) })
    }
  }
  /**
   * §6: the hivetask toolset rides on the step's hivemem server (env + allowed tool names), for claude steps of a task
   * run. Main's factory decides the tools; null or a failure = the step runs without them (fenced report fallback).
   */
  /**
   * DEPARTMENTS.md §6: the hivetask toolset on the step's hivemem server, for every CLI whose MCP attach is verified
   * (claude, codex 0.163: MCP_VERIFIED). The live dir rides along: it is the broker's mailbox and the caller's identity.
   */
  private withTaskTools(grant: MemoryGrant, s: StepSpec, stepId: string, channel: StepLive['channel'] = null): MemoryGrant {
    if (!this.task || !MCP_VERIFIED[s.adapterId] || !this.d.adapters[s.adapterId]?.mcpAttach) return grant
    let tools: TaskToolset | null = null
    try {
      tools = this.ctx.company?.tasks?.toolset?.({ runId: this.run.id, taskId: this.task.taskId, agentId: this.task.agentId, stepId, adapter: s.adapterId, companyId: this.run.companyId ?? null }) ?? null
    } catch (e) {
      this.ctx.log.warn('engine: task toolset failed; step runs without it', { runId: this.run.id, stepId, error: String(e) })
    }
    if (!tools?.toolNames.length) return grant
    // the live dir is the mailbox (hivemem lists the task tools only with one; the fenced report stays the fallback)
    return { ...grant, server: { ...grant.server, env: { ...grant.server.env, ...(channel?.mcpEnv ?? {}), ...tools.env } }, toolNames: [...new Set([...grant.toolNames, ...tools.toolNames])] }
  }

  /** FORUM.md §3: Forum access for a step of a run with an agent seat; none, or a failure, = no Forum. */
  private openForum(s: StepSpec, stepId: string): ForumSpawn | null {
    const agentId = this.task?.agentId ?? this.seatAgentId
    if (!this.ctx.forum || !agentId) return null
    try {
      return this.ctx.forum.open({ runId: this.run.id, stepId, taskId: this.task?.taskId ?? null, agentId, adapter: s.adapterId, companyId: this.run.companyId ?? null })
    } catch (e) {
      this.ctx.log.warn('engine: forum open failed; step runs without it', { runId: this.run.id, stepId, error: String(e) })
      return null
    }
  }

  /** COMPANY.md §5: the run's company Passport (cwd only without a company); DEPARTMENTS.md §7: a task run's adds its department. */
  private passportFor(cwd: string): string | null | undefined {
    const tasks = this.ctx.company?.tasks
    if (this.task && this.run.companyId && tasks?.passportContext) {
      try {
        return tasks.passportContext({ taskId: this.task.taskId, companyId: this.run.companyId })
      } catch (e) {
        this.ctx.log.warn('engine: task passport failed; company passport used', { runId: this.run.id, error: String(e) })
      }
    }
    return this.run.companyId ? this.ctx.passportContext?.(cwd, this.run.companyId) : this.ctx.passportContext?.(cwd)
  }

  /** Cancel from outside: kill the tree, mark canceled. Resolves when the run ended. */
  async cancel(reason = 'Canceled'): Promise<void> {
    if (this.run.status !== 'queued' && this.run.status !== 'running') return
    if (!this.stopped) {
      this.stopped = 'canceled'
      this.stopReason = reason
    }
    // LIVE.md §4.4: deny every open ask first (stdio deny, gate files), then kill the tree
    for (const l of this.lives.values()) l.cancelAsks(reason === 'Canceled' ? 'Run canceled' : reason)
    await this.killAll()
    await Promise.race([this.done, new Promise((r) => setTimeout(r, 4000))])
    await this.close('canceled', reason)
  }

  /**
   * AUTHORING.md §5: a passed agent/shell/wait step said HIVE_STOP. Other running steps are killed (-> skipped, their
   * open asks canceled), no new node starts, and the run ends passed · nothing to do.
   */
  private async halt(label: string, reason: string): Promise<void> {
    if (this.stopped) return
    this.stopped = 'halted'
    this.halted = { label, reason }
    for (const l of this.lives.values()) l.cancelAsks(HALT_SKIP_ERROR)
    await this.killAll()
  }

  private async fail(reason: string): Promise<void> {
    if (this.stopped) return
    this.stopped = 'failed'
    this.stopReason = reason
    await this.killAll()
  }

  private async killAll(): Promise<void> {
    for (const wake of [...this.sleepers]) wake()
    const all = [...this.procs.values()].flatMap((s) => [...s])
    await Promise.all(all.map((p) => p.kill()))
  }

  private async killNode(nodeId: string): Promise<void> {
    await Promise.all([...(this.procs.get(nodeId) ?? [])].map((p) => p.kill()))
  }

  /** Answers a run-owned ask if one of this run's steps owns it; null otherwise (LIVE.md §4.3). */
  answerAsk(askId: string, a: AskAnswer): Ask | null {
    for (const l of this.lives.values()) if (l.owns(askId)) return l.answer(askId, a)
    return null
  }

  // ---------- config helpers ----------

  private nodesUsed(): { profileId: string | null; adapter?: AdapterId }[] {
    const t = this.run.target
    if (t.kind === 'prompt') return [{ profileId: t.profileId }]
    const out: { profileId: string | null; adapter?: AdapterId }[] = []
    for (const n of this.workflow?.nodes ?? []) {
      if (n.type === 'agent') out.push({ profileId: n.profileId })
      else if (n.type === 'room') for (const p of n.participants) out.push({ profileId: p.profileId })
      else if (n.type === 'check') out.push(n.profileId ? { profileId: n.profileId } : { profileId: null, adapter: 'shell' })
      else if (n.type === 'notify') continue // no process (NotifyBridge)
      else out.push({ profileId: null, adapter: 'shell' })
    }
    return out
  }

  /** W8: a node on a missing adapter fails the run immediately with the hint. */
  private missingAdapter(): string | null {
    for (const u of this.nodesUsed()) {
      let adapter = u.adapter
      if (u.profileId) {
        const p = this.ctx.getProfile(u.profileId)
        if (!p) return `Agent profile ${u.profileId} no longer exists`
        adapter = p.adapter
      }
      const info = this.d.provider(adapter!)
      if (!info.available && (!u.profileId || !this.nextHarness(new Set([adapter!])))) return `${info.label} not installed: ${info.installHint}`
    }
    return null
  }

  /**
   * Paths of the repositories added to Hive, one per line (HIVE_REPOS). COMPANY.md §6: with company guards enforced,
   * only the run's company's repos (another company's paths are never handed to its agents).
   */
  private repoPaths(): string {
    try {
      let repos = this.ctx.listRepos?.() ?? []
      const co = this.ctx.company
      if (co && this.run.companyId && co.enforced()) {
        const own = new Set(co.repoIds(this.run.companyId))
        repos = repos.filter((r) => own.has(r.id))
      }
      return repos.map((r) => r.path).join('\n')
    } catch {
      return ''
    }
  }

  // ---------- companies (COMPANY.md §6) ----------

  /**
   * Every step's repo target and folder must belong to the run's company. Enforced (experimental.companies): the step
   * fails with the guard's message. Otherwise the mismatch is logged and the step goes ahead.
   */
  private checkCompany(refs: { repoId?: string | null; cwd?: string | null }): void {
    const co = this.ctx.company
    const companyId = this.run.companyId
    if (!co || !companyId) return
    let problem: string | null
    try {
      problem = co.crossCompany(companyId, refs)
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e)
    }
    if (!problem) return
    if (co.enforced()) throw new StepError(problem)
    this.ctx.log.warn('engine: company guard (not enforced)', { runId: this.run.id, companyId, problem })
  }

  /** The company's workspace folder (repo-less nodes), or null without companies. */
  private companyWorkspace(): string | null {
    const co = this.ctx.company
    if (!co || !this.run.companyId) return null
    try {
      return co.workspaceDir(this.run.companyId)
    } catch (e) {
      this.ctx.log.warn('engine: company workspace unavailable; using the scratch folder', { runId: this.run.id, error: String(e) })
      return null
    }
  }

  private resolveCwd(raw: string | null, scope: RenderScope | null): string {
    if (!raw) return this.defaultCwd()
    let v = scope ? render(raw, scope).trim() : raw.trim()
    if (!v) return this.defaultCwd()
    if (v.startsWith('repo_')) {
      const r = this.ctx.getRepo(v)
      if (!r) throw new StepError(`Repository ${v} not found`)
      v = r.path
    }
    if (v === '~' || v.startsWith('~/')) v = join(homedir(), v.slice(1))
    if (!isAbsolute(v)) throw new StepError(`Folder must be absolute: ${v}`)
    if (!isDir(v)) throw new StepError(`Folder not found: ${v}`)
    // realpath match: a template, a symlink or a path inside another company's repo is caught here too
    this.checkCompany({ cwd: v })
    return v
  }

  // ---------- single step ----------

  /** Fallback never widens Slack restrictions or chooses a harness without the required MCP transport. */
  private nextHarness(tried: Set<AdapterId>): AdapterId | undefined {
    const access = this.slackAccess()
    return (['codex', 'claude', 'gemini', 'cursor'] as const).find((id) => {
      const info = this.d.provider(id)
      return !tried.has(id) && info.available && !!info.binPath && (this.d.harnessFallback?.(this.run.id, id) ?? true) &&
        (!access || access.fullPermissions || id === 'claude') &&
        (!this.slackToolsWanted() || id === 'claude' || id === 'codex')
    })
  }

  private async runStep(s: StepSpec): Promise<StepOutcome> {
    let spec = s
    const tried = new Set<AdapterId>([s.adapterId])
    const attempts: string[] = []
    let resetAt: string | null = null
    let limited = false
    for (;;) {
      const outcome = await this.runStepAttempt(spec)
      if (outcome.stepId) attempts.push(outcome.stepId)
      if (outcome.limitHit) {
        limited = true
        resetAt = laterReset(resetAt, outcome.limitHit.resetAt)
      }
      if ((!outcome.limitHit && !outcome.harnessUnavailable) || this.stopped) {
        // Session identifiers belong to a harness; never resume one with the original provider.
        return spec.adapterId === s.adapterId ? outcome : { ...outcome, agentSessionId: null }
      }
      const next = this.nextHarness(tried)
      if (!next || !s.profile) {
        if (limited) this.limit = { resetAt: laterReset(this.limit?.resetAt, resetAt) }
        const restriction = this.slackAccess()
        const explanation = restriction && !restriction.fullPermissions
          ? ' Automatic fallback is blocked because this workflow requires restricted Slack permissions; other harnesses do not yet support the same restrictions.'
          : ' No other compatible installed harness is available.'
        return { ...outcome, error: `${outcome.error ?? 'Harness unavailable'}.${explanation}` }
      }
      tried.add(next)
      this.ctx.log.info('Switching workflow harness', { runId: this.run.id, nodeId: s.nodeId, from: spec.adapterId, to: next,
        reason: outcome.limitHit ? 'usage limit' : 'unavailable or authentication failed' })
      spec = {
        ...s,
        adapterId: next,
        profile: { ...s.profile, adapter: next, model: null, extraArgs: [], useApiKeyAuth: false },
        resumeId: null,
        prompt: [s.resumeId ? this.originalPrompt.get(s.nodeId) : null, s.prompt,
          'A previous harness became unavailable. Inspect the current files and existing external actions before continuing; some work may already be complete. Do not duplicate completed actions.'].filter(Boolean).join('\n\n'),
        sourceStepIds: [...new Set([...s.sourceStepIds, ...attempts])]
      }
    }
  }

  private async runStepAttempt(s: StepSpec): Promise<StepOutcome> {
    const canceled: StepOutcome = {
      status: 'canceled',
      stepId: null,
      output: '',
      combined: '',
      error: null,
      exitCode: null,
      timedOut: false,
      agentSessionId: null,
      verdict: null
    }
    const release = await this.d.semaphore.acquire()
    let mem: OpenMemory | null = null
    let live: StepLive | null = null
    let liveStatus: 'done' | 'failed' | 'canceled' = 'failed'
    let liveFiles: McpAttachment['files'] = []
    let liveStepId: string | null = null
    let slackMcp: McpAttachment | null = null
    let forum: ForumSpawn | null = null
    try {
      if (this.stopped) return canceled
      const adapter = this.d.adapters[s.adapterId]
      const info = this.d.provider(s.adapterId)
      const stepId = newId('step')
      // codex: a live dir when it gets Hive tools through it (Slack, or a board task's task tools: the broker's mailbox)
      const hasLive = s.adapterId === 'claude' || s.adapterId === 'gemini' || s.adapterId === 'cursor' || (s.adapterId === 'codex' && (this.slackToolsWanted() || (!!this.task && MCP_VERIFIED.codex)))
      const runnable = info.available && !!info.binPath
      // F1: the step's root agent (and, for agent CLIs, its live channel for hooks / ask_user)
      live = new StepLive({
        ctx: this.ctx,
        provider: s.adapterId,
        runId: this.run.id,
        companyId: this.run.companyId ?? null,
        stepId,
        title: this.stepTitle(s),
        cwd: s.cwd,
        track: s.adapterId !== 'shell',
        channel: hasLive && runnable,
        askTimeoutMs: this.d.askTimeoutMs,
        geminiAgents: s.adapterId === 'gemini' ? geminiAgentNames(s.cwd) : undefined,
        activity: s.adapterId === 'shell' ? `$ ${s.prompt.split('\n')[0]}` : null,
        onActivity: () => this.d.stall?.touch(stepId)
      })
      liveStepId = stepId
      this.lives.set(stepId, live)
      mem = runnable ? this.openMemory(s, stepId, adapter, live) : null
      // SLACK.md §9.2: Slack text is untrusted. claude gets it in --append-system-prompt, the other CLIs as a prefix.
      const slackNote = this.slackDriven() && s.adapterId !== 'shell' ? UNTRUSTED_SLACK_NOTE : null
      const notedPrompt = slackNote && s.adapterId !== 'claude' && !s.resumeId ? `${slackNote}\n\n${s.prompt}` : s.prompt
      const imagesNote = s.adapterId !== 'shell' && !s.resumeId ? this.slackImagesNote(notedPrompt) : ''
      const basePrompt = imagesNote ? `${notedPrompt}\n\n${imagesNote}` : notedPrompt
      // An isolated checkout still belongs to its original company's repository.
      const contextCwd = this.worktree?.path === s.cwd ? this.worktree.repoPath : s.cwd
      // COMPANY.md §5: the run's company decides the Passport (cwd only without a company bridge)
      const passport = s.adapterId !== 'shell' && !s.resumeId ? this.passportFor(contextCwd) : null
      // Task launches already carry their exact company Passport. Do not duplicate it.
      const companyPrompt = passport && !basePrompt.includes(passport) ? `${this.redact(passport)}\n\n${basePrompt}` : basePrompt
      // Brief prefixed once (MEMORY.md 6.3); a claude --resume retry only sends the feedback, as today.
      // FORUM.md §3, §5: a seat's step gets the Forum (token, `forum` CLI, MCP for claude/codex) and its brief block
      forum = runnable && s.adapterId !== 'shell' ? this.openForum(s, stepId) : null
      const forumPrompt = forum?.prompt && !s.resumeId ? `${forum.prompt}\n\n${companyPrompt}` : companyPrompt
      const briefed = mem && !s.resumeId ? withBrief(agentBrief(mem.grant, !!mem.attachment), forumPrompt) : forumPrompt
      // SLACK.md §9.4 / SA2: the `hive` server with only the slack toolset, in ONE --mcp-config next to hivemem
      if (runnable && (s.adapterId === 'claude' || s.adapterId === 'codex') && this.slackToolsWanted()) {
        slackMcp = this.attachSlackTools(s.adapterId, stepId, mem, live)
      }
      let gatewayOn = false
      if (runnable && (!this.slackAccess() || this.slackAccess()?.fullPermissions) && (s.adapterId === 'claude' || s.adapterId === 'codex')) {
        const gateway = this.run.companyId ? this.ctx.gateway?.attachment(s.cwd, this.run.companyId) : this.ctx.gateway?.attachment(s.cwd)
        if (gateway) { slackMcp = attachGateway(s.adapterId, gateway, slackMcp ?? mem?.attachment ?? null, gateway.env.PRINCIPIA_GATEWAY_DIR); if (slackMcp) { writeMcpFiles(slackMcp.files); gatewayOn = true } }
      }
      if (forum?.server && (s.adapterId === 'claude' || s.adapterId === 'codex')) {
        try {
          const dir = live?.channel?.dir ?? mem?.grant.spawnDir ?? join(this.ctx.paths.runLogsDir, this.run.id)
          const att = attachForum(s.adapterId, forum.server, forum.toolNames, slackMcp ?? mem?.attachment ?? null, join(dir, `${stepId}.forum.mcp.json`))
          if (att) {
            writeMcpFiles(att.files)
            slackMcp = att
          }
        } catch (e) {
          this.ctx.log.warn('engine: forum MCP attach failed; the step keeps the CLI and the fenced block', { stepId, error: String(e) })
        }
      }
      // PROACTIVE.md §1: a board task turn ends with the "Use Principia" section, from the tools this step really has;
      // a resumed turn (its conversation already holds the section) gets a one-line reminder. ORCHESTRATOR.md §1.1: then
      // Principia's own context and the run report contract, on every harness
      const principia = this.withPrincipia(s, stepId, briefed, [
        ...(mem?.attachment ? (mem.servers ?? []).flatMap((x) => x.toolNames) : []),
        ...(forum?.server ? forum.toolNames : []),
        ...(gatewayOn ? GATEWAY_TOOLS : [])
      ])
      const prompt = principia.prompt
      const logDir = join(this.ctx.paths.runLogsDir, this.run.id)
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, `${stepId}.log`)
      const step: RunStep = {
        id: stepId,
        runId: this.run.id,
        seq: ++this.seq,
        nodeId: s.nodeId,
        nodeType: s.nodeType,
        attempt: s.attempt,
        round: s.round,
        profileId: s.profile?.id ?? null,
        participantLabel: s.participantLabel,
        adapter: s.adapterId,
        cwd: s.cwd,
        prompt: this.redact(prompt),
        output: null,
        verdict: null,
        exitCode: null,
        pid: null,
        status: 'running',
        error: null,
        sourceStepIds: s.sourceStepIds,
        agentSessionId: null,
        logPath,
        startedAt: this.iso(),
        endedAt: null
      }
      let limitHit: LimitHit | null = null
      const end = (o: Omit<StepOutcome, 'stepId'>): StepOutcome => {
        // CONTRACT §13: a failed agent step whose CLI said it hit a usage / rate limit
        const hit =
          o.status === 'failed' && s.adapterId !== 'shell' ? (limitHit ?? (o.error ? classifyLimitText(o.error, this.d.now()) : null)) : null
        if (hit) {
          live?.setLimited(hit.resetAt)
        }
        const skip = o.status === 'canceled' && this.stopped === 'halted'
        const updated = this.ctx.store.updateStep(stepId, {
          status: skip ? 'skipped' : o.status,
          output: this.redact(cap(o.output, OUTPUT_CAP)),
          exitCode: o.exitCode,
          error: skip ? HALT_SKIP_ERROR : o.error ? this.redact(cap(o.error, 8000)) : null,
          verdict: o.verdict,
          agentSessionId: o.agentSessionId,
          endedAt: this.iso(),
          ...(hit ? { stopReason: 'rate_limited' as const, resetAt: hit.resetAt } : {})
        })
        this.ctx.emit({ type: 'step.updated', step: updated })
        if (s.adapterId !== 'shell') this.stepOutput(s, stepId, skip ? 'canceled' : o.status, updated.output ?? '', mem)
        this.noteTaskSession(s.adapterId, o.agentSessionId)
        return { ...o, stepId, ...(hit ? { limitHit: hit } : {}) }
      }

      this.ctx.store.insertStep(step)
      this.ctx.emit({ type: 'step.updated', step })

      if (!info.available || !info.binPath) {
        return end({ ...canceled, status: 'failed', error: `${info.label} not installed: ${info.installHint}`, harnessUnavailable: true })
      }
      if (s.adapterId !== 'shell' && this.workflow?.slackTools && (!this.slackToolsWanted() || !slackMcp)) {
        return end({ ...canceled, status: 'failed', error: 'Required Slack connection is unavailable. Connect Slack in Settings → Connections before running this workflow.' })
      }
      // SA2: Slack text is untrusted. Only claude has a verified restricted mode; other agents need full permissions.
      const access = this.slackAccess()
      const restricted = !!access && !access.fullPermissions && s.adapterId !== 'shell'
      if (restricted && s.adapterId !== 'claude') {
        return end({
          ...canceled,
          status: 'failed',
          error: `${info.label} can't run in a Slack-driven workflow: Hive restricts agents that read Slack text and only Claude Code supports that mode. Use a Claude profile${this.run.slack ? ", or turn on 'unsafe: full agent permissions' on the Slack trigger" : ''}.`
        })
      }
      // per-spawn hooks (gemini: system settings via env; cursor: --plugin-dir). claude headless needs none.
      const gated = usesGate(s.adapterId, s.profile)
      const unrouted = unroutedAsksNotice(s.adapterId, s.profile)
      if (unrouted) live?.hook({ kind: 'notice', text: unrouted })
      let hookArgs: string[] = []
      const hookEnv: Record<string, string> = {}
      if (live.channel && adapter.hooksAttach && s.adapterId !== 'claude') {
        try {
          // gemini: ONE system settings file carries hooks and hivemem (supersedes geminiMcpAttach's file)
          const gm = s.adapterId === 'gemini' && mem?.attachment ? { server: mem.grant.server, toolNames: mem.grant.toolNames } : null
          const h = adapter.hooksAttach({ dir: live.channel.dir, hookCommand: live.channel.hookCommand }, { headless: true, gate: gated, mcp: gm })
          if (gm && h.files.length && mem?.attachment) mem.attachment = { ...mem.attachment, env: {} }
          if (h.warning) this.ctx.log.warn(`engine: ${h.warning}`, { stepId })
          writeMcpFiles(h.files)
          liveFiles = h.files
          hookArgs = h.args
          Object.assign(hookEnv, h.env)
        } catch (e) {
          this.ctx.log.warn('engine: live hooks attach failed; step runs without hooks', { stepId, error: String(e) })
        }
      }

      const inv = adapter.headless({
        profile: s.profile,
        prompt,
        artifactsDir: this.run.artifactsDir,
        keyNames: childKeyNames(this.ctx, adapter, s.profile, this.secretOverride(), this.run.companyId),
        resumeId: s.resumeId,
        shell: info.binPath,
        ...(slackMcp ? { mcpArgs: slackMcp.args } : mem?.attachment ? { mcpArgs: mem.attachment.args } : {}),
        ...(mem?.askUser ? { askUser: true } : {}),
        ...(hookArgs.length ? { hookArgs } : {}),
        ...(gated && liveFiles.length ? { gated: true } : {}),
        ...(slackNote && s.adapterId === 'claude' ? { systemNote: slackNote } : {}),
        ...(restricted ? { restricted: true } : {}),
        ...(this.run.slack && this.slackImages.length && s.adapterId !== 'shell' ? { images: this.slackImages } : {})
      })
      const env = buildChildEnv(this.ctx, adapter, s.profile, {
        ARTIFACTS_DIR: this.run.artifactsDir,
        HIVE_RUN_ID: this.run.id,
        HIVE_NODE_ID: s.nodeId,
        HIVE_STEP_ID: stepId,
        HIVE_USER_DATA: this.ctx.paths.userData,
        HIVE_REPOS: this.repoPaths(),
        ...this.runVars(),
        // CONTRACT §13: HIVE_SPAWN_ID=<step id> (+ HIVE_USER_DATA) on the whole tree, so the reaper finds escapees
        ...(this.ctx.reaper?.tag(stepId) ?? {})
      }, this.secretOverride(), this.run.companyId)
      if (s.extraEnv) Object.assign(env, s.extraEnv)
      // ORCHESTRATOR.md §1.2: the step's report file, for agents that write files more reliably than they format
      if (principia.reportPath) env[RUN_REPORT_ENV] = principia.reportPath
      if (mem?.attachment) Object.assign(env, mem.attachment.env)
      // FORUM.md §4.1: PRINCIPIA_FORUM_* and the `forum` CLI on PATH, for any harness
      if (forum) {
        Object.assign(env, forum.env)
        if (forum.binDir) env.PATH = `${forum.binDir}:${env.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`
      }
      // older gemini memory file vs the merged live settings file: the live one carries hooks (and hivemem when verified)
      Object.assign(env, hookEnv)
      // A5: claude's MCP client must outlive an ask_user wait (per spawn, never global config)
      if (s.adapterId === 'claude' && inv.stdin) env.MCP_TOOL_TIMEOUT = MCP_TOOL_TIMEOUT_MS

      const log: WriteStream = createWriteStream(logPath, { flags: 'a' })
      log.on('error', () => {})
      log.write(this.redact(`$ ${info.binPath} ${inv.args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)).join(' ')}\n# cwd: ${s.cwd}\n\n`))

      const parser = adapter.createParser({ cwd: s.cwd })
      const outBuf = new LineBuffer()
      const errBuf = new LineBuffer()
      let raw = ''
      let combined = ''
      let agentSessionId = inv.agentSessionId
      const MAX_RAW = 4 * 1024 * 1024
      const emitChunk = (text: string | null): void => {
        if (!text) return
        this.ctx.emit({ type: 'step.output', runId: this.run.id, stepId, chunk: this.redact(text) })
      }
      const noteLimit = (hit: LimitHit | null): void => {
        if (!hit) return
        // the first known reset wins: claude's rate_limit_event (exact epoch) comes before its minute-rounded banner
        limitHit = { message: hit.message, resetAt: limitHit?.resetAt ?? hit.resetAt ?? null }
      }
      const classify = s.adapterId !== 'shell'
      const onOutLine = (line: string): void => {
        log.write(`${this.redact(line)}\n`)
        if (classify) noteLimit(classifyStreamLine(s.adapterId, line, this.d.now()))
        for (const ev of parser.line(line)) {
          if (ev.kind === 'session' && !agentSessionId) {
            agentSessionId = ev.id
            this.noteTaskSession(s.adapterId, agentSessionId)
          }
          live?.stream(ev)
          emitChunk(eventToChunk(ev))
        }
      }
      const onErrLine = (line: string): void => {
        log.write(`${this.redact(line)}\n`)
        if (classify) noteLimit(classifyLimitText(line, this.d.now()))
        if (line.trim()) emitChunk(`${line}\n`)
      }

      let handle: ProcHandle
      try {
        handle = startProcess({
          file: info.binPath,
          args: inv.args,
          cwd: s.cwd,
          env,
          stdin: inv.stdin ? 'pipe' : 'ignore',
          timeoutMs: Math.max(1, s.timeoutMin) * 60_000,
          ...(this.ctx.reaper ? { reap: { spawnId: stepId, reaper: this.ctx.reaper } } : {}),
          user: this.ctx.spawnUser?.() ?? null,
          onStdout: (c) => {
            this.d.stall?.touch(stepId)
            if (raw.length < MAX_RAW) raw += c
            combined = tail(combined + c, FEEDBACK_TAIL * 4)
            outBuf.push(c).forEach(onOutLine)
          },
          onStderr: (c) => {
            this.d.stall?.touch(stepId)
            combined = tail(combined + c, FEEDBACK_TAIL * 4)
            errBuf.push(c).forEach(onErrLine)
          }
        })
      } catch (e) {
        log.end()
        return end({ ...canceled, status: 'failed', error: `Could not start ${info.label}: ${String(e)}`, harnessUnavailable: s.adapterId !== 'shell' })
      }
      live.attach(handle)
      // CONTRACT §13: "Stalled?" after Settings.stallMinutes with no output and no hook line (never while an ask waits)
      const stepLive = live
      this.d.stall?.track(stepId, { onChange: (since) => stepLive.setStalled(since), waiting: () => stepLive.waiting() })
      // claude stream-json input: initialize, then the prompt; stdin stays open for control responses
      for (const l of inv.stdin?.lines ?? []) handle.write(l)
      const set = this.procs.get(s.nodeId) ?? new Set()
      set.add(handle)
      this.procs.set(s.nodeId, set)
      if (handle.pid) {
        const u = this.ctx.store.updateStep(stepId, { pid: handle.pid, agentSessionId })
        this.ctx.emit({ type: 'step.updated', step: u })
      }
      this.noteTaskSession(s.adapterId, agentSessionId)
      if (inv.stdin && this.task) this.inband.set(stepId, handle)
      if (this.stopped) void handle.kill()

      const r = await handle.done
      set.delete(handle)
      const restOut = outBuf.flush()
      if (restOut) onOutLine(restOut)
      const restErr = errBuf.flush()
      if (restErr) onErrLine(restErr)
      log.end()

      const output = s.adapterId === 'shell' ? raw.trim() : parser.finalOutput(raw)
      const base = {
        output,
        combined: tail(combined, FEEDBACK_TAIL),
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        agentSessionId,
        verdict: null as 'PASS' | 'FAIL' | null
      }
      if (r.killed && !r.timedOut) {
        liveStatus = 'canceled'
        return end({ ...base, status: 'canceled', error: 'Canceled' })
      }

      let error: string | null = null
      const result = parser.result()
      // CONTRACT §12.4: a denied tool is just a denied tool (the old "set bypass" failure is gone); end = process exit
      if (r.spawnError) error = `Could not start ${info.label}: ${r.spawnError}`
      else if (r.timedOut) error = `Timed out after ${s.timeoutMin} min`
      else if (r.exitCode !== 0) {
        const why = result?.isError && result.text ? result.text : tail(combined.trim(), 2000)
        error = `Exited with code ${r.exitCode ?? r.signal}${why ? `: ${why}` : ''}`
      } else if (result?.isError) error = result.text || `Agent error (${result.subtype ?? 'unknown'})`
      else if (parser.incomplete?.()) error = parser.incomplete!()

      const harnessUnavailable = s.adapterId !== 'shell' && (!!r.spawnError || (!!result?.isError && isHarnessAuthFailure(s.adapterId, result.text ?? '')))
      const o: StepOutcome = { ...base, stepId, status: error ? 'failed' : 'passed', error, harnessUnavailable }
      if (s.finalize && !r.spawnError) {
        const f = s.finalize(o)
        liveStatus = f.status === 'passed' ? 'done' : 'failed'
        return end({ ...base, status: f.status, verdict: f.verdict, error: f.error, harnessUnavailable })
      }
      liveStatus = o.status === 'passed' ? 'done' : 'failed'
      return end({ ...base, status: o.status, error, harnessUnavailable })
    } finally {
      if (liveStepId) this.d.stall?.untrack(liveStepId)
      if (liveStepId) this.inband.delete(liveStepId)
      if (live) {
        if (this.stopped === 'canceled' && liveStatus === 'failed') liveStatus = 'canceled'
        live.finish(liveStatus)
        if (liveStepId) this.lives.delete(liveStepId)
      }
      if (liveFiles.length) removeMcpFiles(liveFiles)
      if (slackMcp) removeMcpFiles(slackMcp.files)
      if (mem) this.closeMemory(mem)
      if (forum && liveStepId) {
        try {
          this.ctx.forum?.close(liveStepId)
        } catch {
          /* the token expires with the process anyway */
        }
      }
      release()
    }
  }

  /** Root agent title: the run title for prompt runs, else the node label (+ room speaker). */
  private stepTitle(s: StepSpec): string {
    if (s.nodeType === 'prompt') return this.run.title
    const base = s.nodeLabel || s.nodeId
    return s.participantLabel ? `${base} · ${s.participantLabel}` : base
  }

  // ---------- memory (MEMORY.md 3.4, CONTRACT 11.4) ----------

  /**
   * One grant per spawned agent process. No bridge, mode off, shell, or a bridge failure = no memory (the step
   * runs exactly as before). Adapters without verified MCP get the brief only, as a read grant.
   */
  /** The memory mode a step gets. Review fix: a restricted Slack-driven agent reads memory but never writes it (untrusted text could plant facts). */
  private memoryMode(s: StepSpec): MemoryMode {
    const asked = isMemoryMode(s.memory) ? s.memory : 'off'
    const access = this.slackAccess()
    return asked === 'read-write' && access && !access.fullPermissions ? 'read' : asked
  }

  /** PASSPORT.md §7.6: the harvester's hook. Never breaks a step. */
  private stepOutput(s: StepSpec, stepId: string, status: 'passed' | 'failed' | 'canceled', output: string, mem: OpenMemory | null): void {
    if (!this.ctx.onStepOutput) return
    try {
      this.ctx.onStepOutput({
        runId: this.run.id,
        stepId,
        nodeId: s.nodeId,
        adapter: s.adapterId,
        companyId: this.run.companyId ?? null,
        memory: this.memoryMode(s),
        transport: !mem || mem.askOnly ? null : mem.attachment ? 'mcp' : 'inject',
        status,
        output
      })
    } catch (e) {
      this.ctx.log.warn('engine: onStepOutput failed', { runId: this.run.id, stepId, error: String(e) })
    }
  }

  /** PROACTIVE.md §1: the Principia operating section of a board task step (claude/codex with board, team or memory tools). */
  private withOps(s: StepSpec, prompt: string, tools: string[]): string {
    if (!this.task || s.adapterId === 'shell' || this.ctx.getSettings().proactiveAgents === false) return prompt
    const ops = principiaOps({ tools, kind: 'task' })
    if (!ops) return prompt
    return s.resumeId ? `${prompt}\n\nKeep following the "Use Principia" rules from the start of this conversation.` : `${prompt}\n\n${ops}`
  }

  /**
   * ORCHESTRATOR.md §1.1: withOps, then Principia's own block (inbox, related tasks, teammates' work) and the run report
   * contract, for every non-shell step of a company run that has an agent (a task run or a seat run), on every adapter.
   * The report file path goes to the env as $PRINCIPIA_RUN_REPORT. A failing bridge never fails the step.
   */
  private withPrincipia(s: StepSpec, stepId: string, prompt: string, tools: string[]): { prompt: string; reportPath: string | null } {
    const withOps = this.withOps(s, prompt, tools)
    const bridge = this.ctx.orchestrator
    const agentId = this.task?.agentId ?? this.seatAgentId ?? null
    const companyId = this.run.companyId ?? null
    if (!bridge || s.adapterId === 'shell' || !companyId || (!this.task && !agentId)) return { prompt: withOps, reportPath: null }
    const reportPath = runReportPath(this.ctx.paths.runLogsDir, this.run.id, stepId)
    let block: string | null = null
    try {
      block = bridge.stepContext({ runId: this.run.id, stepId, companyId, taskId: this.task?.taskId ?? null, agentId, adapter: s.adapterId, resumed: !!s.resumeId, reportPath })
    } catch (e) {
      this.ctx.log.warn('engine: orchestrator context failed; step runs without it', { runId: this.run.id, stepId, error: String(e) })
    }
    if (!block) return { prompt: withOps, reportPath: null }
    return { prompt: `${withOps}\n\n${this.redact(block)}`, reportPath }
  }

  private openMemory(s: StepSpec, stepId: string, adapter: Adapter, live: StepLive | null): OpenMemory | null {
    const bridge = this.ctx.memory
    const mode = this.memoryMode(s)
    // LIVE.md §4.2 / A2: hivemem's ask_user goes to every headless claude step that has a live channel
    const channel = live?.channel ?? null
    const askUser = s.adapterId === 'claude' && !!channel && MCP_VERIFIED.claude && !!adapter.mcpAttach
    if (!bridge) return null
    // a task step of a CLI without ask_user (codex) still gets its task tools on an empty-memory hivemem
    const taskOnly = !askUser && !!channel && !!this.task && MCP_VERIFIED[s.adapterId] && !!adapter.mcpAttach
    if (mode === 'off') return askUser || taskOnly ? this.openAskOnly(s, stepId, adapter, channel!, { askUser }) : null
    const transport = memoryTransport(s.adapterId)
    if (!transport) return null
    const useMcp = transport === 'mcp' && !!adapter.mcpAttach
    let grant: MemoryGrant | null = null
    try {
      grant = bridge.grant({
        // inject keeps the asked mode: a read-write vault grant then carries the harvest rules (PASSPORT.md §7.6);
        // the v1 store clamps inject grants to read itself
        mode,
        adapter: s.adapterId,
        transport: useMcp ? 'mcp' : 'inject',
        profile: s.profile,
        cwd: s.cwd,
        // PASSPORT.md §7.5: the grant is bound to the run's company, never to whatever the cwd suggests
        ...(this.run.companyId ? { companyId: this.run.companyId } : {}),
        runId: this.run.id,
        runTitle: this.run.title,
        workflowId: this.run.workflowId,
        stepId,
        nodeId: s.nodeId,
        nodeLabel: s.participantLabel ? `${s.nodeLabel ?? s.nodeId} · ${s.participantLabel}` : s.nodeLabel ?? s.nodeId,
        sessionId: null,
        briefQuery: s.briefQuery ?? s.prompt
      })
    } catch (e) {
      this.ctx.log.warn('engine: memory grant failed', { runId: this.run.id, nodeId: s.nodeId, error: String(e) })
      return null
    }
    if (!grant) return askUser || taskOnly ? this.openAskOnly(s, stepId, adapter, channel!, { askUser }) : null
    // CONTRACT §13: the hivemem child the CLI starts carries the step's spawn tag too
    grant = { ...grant, server: { ...grant.server, env: { ...grant.server.env, ...(this.ctx.reaper?.tag(stepId) ?? {}) } } }
    grant = this.withTaskTools(grant, s, stepId, channel)
    let attachment: McpAttachment | null = null
    let servers: OpenMemory['servers'] = []
    const withAsk = askUser && useMcp
    if (useMcp && (grant.toolNames.length || withAsk)) {
      try {
        const g = withAsk ? { ...grant, server: { ...grant.server, env: { ...grant.server.env, ...channel!.mcpEnv } } } : grant
        attachment = adapter.mcpAttach!(g, { askUser: withAsk })
        writeMcpFiles(attachment.files)
        servers = [{ server: g.server, toolNames: withAsk && !g.toolNames.includes('ask_user') ? [...g.toolNames, 'ask_user'] : [...g.toolNames] }]
      } catch (e) {
        this.ctx.log.warn('engine: memory MCP attach failed; brief only', { runId: this.run.id, error: String(e) })
        if (attachment) removeMcpFiles(attachment.files)
        attachment = null
      }
    }
    return { grant, attachment, askUser: withAsk && !!attachment, askOnly: false, servers: attachment ? servers : [] }
  }

  /**
   * Memory off: hivemem with an empty grant, listing only ask_user (LIVE.md §4.2) and, on a task step, the task tools.
   * `askUser: false` (codex): the task tools only; nothing to attach without them. No mem_grant row.
   */
  private openAskOnly(s: StepSpec, stepId: string, adapter: Adapter, channel: NonNullable<StepLive['channel']>, o: { askUser: boolean } = { askUser: true }): OpenMemory | null {
    const server = (() => {
      try {
        return this.ctx.memory?.askOnlyServer?.() ?? null
      } catch (e) {
        this.ctx.log.warn('engine: askOnlyServer failed', { error: String(e) })
        return null
      }
    })()
    if (!server) return null
    // the hivetask toolset (§6) rides on this server too when memory is off
    const grant: MemoryGrant = this.withTaskTools({
      grantId: `ask-${stepId}`,
      server: { ...server, env: { ...server.env, ...channel.mcpEnv, ...(this.ctx.reaper?.tag(stepId) ?? {}) } },
      toolNames: [],
      spawnDir: channel.dir,
      brief: ''
    }, s, stepId, channel)
    if (!o.askUser && !grant.toolNames.length) return null
    try {
      const attachment = adapter.mcpAttach!(grant, { askUser: o.askUser })
      writeMcpFiles(attachment.files)
      return { grant, attachment, askUser: o.askUser, askOnly: true, servers: [{ server: grant.server, toolNames: o.askUser ? [...grant.toolNames, 'ask_user'] : [...grant.toolNames] }] }
    } catch (e) {
      this.ctx.log.warn('engine: ask_user attach failed', { stepId, error: String(e) })
      return null
    }
  }

  /**
   * SLACK.md §9.4: ONE per-spawn --mcp-config holding hivemem (when attached) and `hive` (slack toolset only, SA2);
   * the 5 mcp__hive__slack_* tools are pre-allowed. Main decides the toolset from the owner, never from this env.
   * null = not available (the step runs without Slack tools and relies on replyNode).
   */
  private attachSlackTools(adapter: 'claude' | 'codex', stepId: string, mem: OpenMemory | null, live: StepLive | null): McpAttachment | null {
    let spec: McpServerSpec | null = null
    try {
      spec = this.ctx.slack?.toolServer({ stepId, runId: this.run.id }) ?? null
    } catch (e) {
      this.ctx.log.warn('engine: slack toolServer failed', { stepId, error: String(e) })
    }
    if (!spec) return null
    const dir = live?.channel?.dir ?? mem?.grant.spawnDir ?? null
    if (!dir) {
      this.ctx.log.warn('engine: slack tools need a live dir; not attached', { stepId })
      return null
    }
    const server: McpServerSpec = {
      ...spec,
      env: { ...(live?.channel?.mcpEnv ?? {}), ...spec.env, ...(this.ctx.reaper?.tag(stepId) ?? {}) }
    }
    // SLACK.md §11.4: main lists the `work` toolset (principia_*) for Slack-triggered runs; pre-allow those names too
    const toolNames: string[] = [...SLACK_TOOLS, ...((server.env?.HIVE_TOOLSETS ?? '').split(',').includes('work') ? SLACK_WORK_TOOLS : [])]
    try {
      const att = adapter === 'codex' ? codexToolsAttach(server, toolNames, mem?.attachment ?? null) : claudeSessionMcpAttach(join(dir, `${stepId}.hive.mcp.json`), [
        ...(mem?.attachment ? (mem.servers ?? []) : []),
        { server, toolNames }
      ])
      writeMcpFiles(att.files)
      return att
    } catch (e) {
      this.ctx.log.warn('engine: slack tools attach failed', { stepId, error: String(e) })
      return null
    }
  }

  private closeMemory(m: OpenMemory): void {
    if (m.attachment) removeMcpFiles(m.attachment.files)
    if (m.askOnly) return
    try {
      this.ctx.memory?.release(m.grant.grantId)
    } catch (e) {
      this.ctx.log.warn('engine: memory release failed', { grantId: m.grant.grantId, error: String(e) })
    }
  }

  // ---------- prompt runs ----------

  private async executePrompt(): Promise<void> {
    const t = this.run.target
    if (t.kind !== 'prompt') return
    const profile = this.ctx.getProfile(t.profileId)!
    let cwd: string
    let extraEnv: Record<string, string> | undefined
    try {
      // WORKTREE.md: a Started task's turns run in its own worktree (never the founder's checkout)
      const wd = this.task ? await this.ctx.company?.tasks?.workdir?.({ taskId: this.task.taskId, runId: this.run.id }) : null
      if (wd) {
        if (!isDir(wd.cwd)) throw new StepError(`The task's worktree is gone: ${wd.cwd}`)
        this.checkCompany({ cwd: wd.cwd })
        cwd = wd.cwd
        extraEnv = wd.env
      } else cwd = this.resolveCwd(t.repoId, null)
    } catch (e) {
      return void (await this.fail(e instanceof Error ? e.message : String(e)))
    }
    const prompt = t.prompt.replace(/\{\{\s*ARTIFACTS_DIR\s*\}\}/g, this.run.artifactsDir)
    const o = await this.runStep({
      nodeId: 'prompt',
      nodeType: 'prompt',
      attempt: 1,
      round: null,
      participantLabel: null,
      profile,
      adapterId: profile.adapter,
      cwd,
      prompt,
      // DEPARTMENTS.md §4.2: a resumed Claude task turn continues its conversation (the prompt is only wake + rules)
      resumeId: profile.adapter === 'claude' ? (this.task?.resumeSessionId ?? null) : null,
      sourceStepIds: [],
      timeoutMin: 60,
      // LIVE.md §7 / F4: prompt runs default to read-write like new steps (writes stay within the repo; no repo =
      // read-only global, see MemoryService.grant). An explicit 'off' is kept.
      memory: isMemoryMode(t.memory) ? t.memory : 'read-write',
      briefQuery: prompt,
      nodeLabel: 'Prompt',
      ...(extraEnv ? { extraEnv } : {})
    })
    if (o.status === 'failed') await this.fail(o.error ?? 'Step failed')
  }

  // ---------- workflow runs ----------

  private async executeWorkflow(): Promise<void> {
    const wf = this.workflow!
    const nodes = wf.nodes
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const deps: DepMap = effectiveDeps(nodes)
    const order = topoOrder(deps).order
    const checks = nodes.filter((n): n is CheckNode => n.type === 'check')
    const bodies = new Map(checks.map((c) => [c.id, loopBody(deps, c)]))
    const state = new Map<string, NodeState>(nodes.map((n) => [n.id, { status: 'pending', gen: 0, attempt: 0 }]))
    const results = new Map<string, NodeResult>()
    const feedback = new Map<string, string>()
    const checkFails = new Map<string, number>()

    const t = this.run.target
    const rawInputs = t.kind === 'workflow' ? t.inputs ?? {} : {}
    const inputs: Record<string, string> = {}
    for (const i of wf.inputs) {
      if (i.type === 'boolean') {
        // typed checkbox: templated as exactly 'true' / 'false' (startRun refused anything else)
        inputs[i.name] = booleanValue(i, rawInputs[i.name]) ?? 'false'
        continue
      }
      let v = rawInputs[i.name] ?? i.default ?? ''
      if (v.startsWith('repo_')) v = this.ctx.getRepo(v)?.path ?? v
      inputs[i.name] = v
    }
    const scope: RenderScope = {
      inputs,
      nodeOutput: (id) => results.get(id)?.output ?? null,
      nodeTranscript: (id) => results.get(id)?.transcript ?? null,
      artifactsDir: this.run.artifactsDir,
      worktree: () => (this.worktree ? { dir: this.worktree.path, branch: this.worktree.branch } : null),
      trigger: () => this.triggerValues()
    }
    const sourcesOf = (n: WorkflowNode): string[] =>
      [...(deps.get(n.id) ?? [])].map((d) => results.get(d)?.stepId).filter((x): x is string => !!x)

    const gatedOk = (n: WorkflowNode): boolean => {
      for (const dep of deps.get(n.id) ?? []) {
        for (const c of checks) {
          const body = bodies.get(c.id)!
          if (body.has(dep) && !body.has(n.id) && n.id !== c.id && state.get(c.id)!.status !== 'passed') return false
        }
      }
      return true
    }
    const ready = (n: WorkflowNode): boolean =>
      state.get(n.id)!.status === 'pending' &&
      [...(deps.get(n.id) ?? [])].every((d) => state.get(d)!.status === 'passed') &&
      gatedOk(n)

    let wake: () => void = () => {}
    const reset = async (ids: Set<string>): Promise<void> => {
      for (const id of ids) {
        const st = state.get(id)!
        const wasRunning = st.status === 'running'
        st.gen++
        st.status = 'pending'
        results.delete(id)
        if (wasRunning) void this.killNode(id)
      }
    }

    const onDone = async (n: WorkflowNode, gen: number, r: NodeOutcome): Promise<void> => {
      const st = state.get(n.id)!
      if (st.gen !== gen || this.stopped) return
      if (r.kind === 'failed') {
        st.status = 'failed'
        return void (await this.fail(`Node "${n.label || n.id}" failed: ${r.error}`))
      }
      if (r.kind === 'canceled') {
        st.status = 'failed'
        return void (await this.fail(`Node "${n.label || n.id}" was stopped`))
      }
      if (n.type === 'check' && r.verdict === 'FAIL') {
        const fails = (checkFails.get(n.id) ?? 0) + 1
        checkFails.set(n.id, fails)
        if (fails > n.maxRetries) {
          st.status = 'failed'
          return void (await this.fail(
            `Check "${n.label || n.id}" failed after ${fails} attempt${fails === 1 ? '' : 's'}: ${tail(r.feedback, 2000)}`
          ))
        }
        feedback.set(n.target, r.feedback)
        const body = bodies.get(n.id)!
        const toReset = new Set<string>([...body, n.id])
        for (const b of body)
          for (const x of descendants(deps, b)) if (state.get(x)!.status !== 'pending') toReset.add(x)
        await reset(toReset)
        return
      }
      st.status = 'passed'
      results.set(n.id, r.result)
      this.writeOut(n.id, r.result.output)
      // AUTHORING.md §5: stop-if output contract (agent, shell, wait; never rooms, checks, notify)
      const halt = HALT_NODE_TYPES.includes(n.type) ? detectHalt(r.result.output) : null
      if (halt) {
        const reason = this.redact(cap(halt, 500))
        if (r.result.stepId) {
          const u = this.ctx.store.updateStep(r.result.stepId, { halt: reason })
          this.ctx.emit({ type: 'step.updated', step: u })
        }
        await this.halt(n.label || n.id, reason)
      }
    }

    const start = (n: WorkflowNode): void => {
      const st = state.get(n.id)!
      st.status = 'running'
      st.attempt++
      const gen = st.gen
      const p = this.runNode(n, st.attempt, scope, sourcesOf(n), byId, results, feedback)
        .catch((e): NodeOutcome => ({ kind: 'failed', error: e instanceof Error ? e.message : String(e) }))
        .then((r) => onDone(n, gen, r))
        .finally(() => {
          this.tasks.delete(p)
          wake()
        })
      this.tasks.add(p)
    }

    for (;;) {
      if (this.stopped) break
      for (const id of order) {
        const n = byId.get(id)!
        if (ready(n)) start(n)
      }
      if (this.tasks.size === 0) {
        const notPassed = nodes.filter((n) => state.get(n.id)!.status !== 'passed')
        if (notPassed.length && !this.stopped)
          await this.fail(`Workflow stalled: ${notPassed.map((n) => n.id).join(', ')} never became ready`)
        break
      }
      await new Promise<void>((r) => (wake = r))
    }
    await Promise.allSettled([...this.tasks])
  }

  private async runNode(
    n: WorkflowNode,
    attempt: number,
    scope: RenderScope,
    sources: string[],
    byId: Map<string, WorkflowNode>,
    results: Map<string, NodeResult>,
    feedback: Map<string, string>
  ): Promise<NodeOutcome> {
    switch (n.type) {
      case 'agent':
        return this.runAgent(n, attempt, scope, sources, feedback)
      case 'wait':
        return this.runWait(n, attempt, scope, sources, results)
      case 'notify':
        return this.runNotify(n, attempt, scope, sources)
      case 'shell': {
        const { cwd, env: extraEnv } = await this.nodeCwd(n, scope)
        if (this.stopped) return { kind: 'canceled' }
        const o = await this.runStep({
          nodeId: n.id,
          nodeType: 'shell',
          attempt,
          round: null,
          participantLabel: null,
          profile: null,
          adapterId: 'shell',
          cwd,
          prompt: this.scriptCommand(n, attempt, this.commandText(n.command, scope)),
          resumeId: null,
          sourceStepIds: sources,
          timeoutMin: n.timeoutMin,
          nodeLabel: n.label || n.id,
          extraEnv: { ...this.inputEnv(scope), ...this.outEnv(results), ...(extraEnv ?? {}) }
        })
        return toOutcome(o, cwd)
      }
      case 'room':
        return this.runRoom(n, attempt, scope, sources)
      case 'check':
        return this.runCheck(n, attempt, scope, sources, byId, results)
    }
  }

  /** Agent node; a pending reviewer feedback turns this into a retry (resume when the adapter can). */
  private lastSession = new Map<string, string | null>()
  private originalPrompt = new Map<string, string>()
  private async runAgent(
    n: AgentNode,
    attempt: number,
    scope: RenderScope,
    sources: string[],
    feedback: Map<string, string>
  ): Promise<NodeOutcome> {
    const profile = this.ctx.getProfile(n.profileId)
    if (!profile) return { kind: 'failed', error: `Agent profile ${n.profileId} no longer exists` }
    const adapter = this.d.adapters[profile.adapter]
    const { cwd, env: extraEnv } = await this.nodeCwd(n, scope)
    if (this.stopped) return { kind: 'canceled' }
    const fb = feedback.get(n.id)
    feedback.delete(n.id)
    let prompt = render(n.prompt, scope)
    let resumeId: string | null = null
    if (fb !== undefined) {
      const prev = this.lastSession.get(n.id) ?? null
      // the fix round keeps the original step's dry-run guard (a resumed session only sees this new message)
      const guard = fixRoundGuard(this.originalPrompt.get(n.id) ?? prompt, this.dryRun)
      if (adapter.canResume && prev) {
        prompt = retryPrompt(fb, guard)
        resumeId = prev
      } else prompt = `${this.originalPrompt.get(n.id) ?? prompt}\n\n${retryPrompt(fb, this.dryRun ? DRY_RUN_GUARD : null)}`
    } else this.originalPrompt.set(n.id, prompt)
    const o = await this.runStep({
      nodeId: n.id,
      nodeType: 'agent',
      attempt,
      round: null,
      participantLabel: null,
      profile,
      adapterId: profile.adapter,
      cwd,
      prompt,
      resumeId,
      sourceStepIds: sources,
      timeoutMin: n.timeoutMin,
      memory: nodeMemoryMode(n),
      briefQuery: this.originalPrompt.get(n.id) ?? prompt,
      nodeLabel: n.label || n.id,
      extraEnv
    })
    if (o.agentSessionId) this.lastSession.set(n.id, o.agentSessionId)
    return toOutcome(o, cwd)
  }

  private async runRoom(n: RoomNode, attempt: number, scope: RenderScope, sources: string[]): Promise<NodeOutcome> {
    const { cwd, env: extraEnv } = await this.nodeCwd(n, scope)
    if (this.stopped) return { kind: 'canceled' }
    let transcript = render(n.topic, scope)
    // Every turn gets the same mode and the brief for the room topic (one query, same brief per turn).
    const memory = nodeMemoryMode(n)
    const briefQuery = transcript
    let last: StepOutcome | null = null
    let prevSources = sources
    const labels = n.participants.map((p) => p.label)
    const turn = async (idx: number, round: number | null, summary: boolean): Promise<StepOutcome> => {
      const part = n.participants[idx]
      const profile = this.ctx.getProfile(part.profileId)
      if (!profile) throw new StepError(`Agent profile ${part.profileId} no longer exists`)
      const o = await this.runStep({
        nodeId: n.id,
        nodeType: 'room',
        attempt,
        round,
        participantLabel: part.label,
        profile,
        adapterId: profile.adapter,
        cwd,
        prompt: roomTurnPrompt(part.label, labels.filter((_, i) => i !== idx), transcript, summary),
        resumeId: null,
        sourceStepIds: prevSources,
        timeoutMin: n.timeoutMin,
        memory,
        briefQuery,
        nodeLabel: n.label || n.id,
        extraEnv
      })
      if (o.stepId) prevSources = [o.stepId]
      return o
    }
    for (let r = 1; r <= n.rounds; r++) {
      for (let i = 0; i < n.participants.length; i++) {
        const o = await turn(i, r, false)
        if (o.status !== 'passed') return toOutcome(o, cwd)
        transcript += `\n\n### ${n.participants[i].label} (round ${r})\n\n${o.output}`
        last = o
      }
    }
    let output = last?.output ?? ''
    if (n.final === 'summary') {
      const o = await turn(0, null, true)
      if (o.status !== 'passed') return toOutcome(o, cwd)
      transcript += `\n\n### ${n.participants[0].label} (summary)\n\n${o.output}`
      output = o.output
      last = o
    }
    return {
      kind: 'passed',
      verdict: null,
      feedback: '',
      result: {
        output: cap(output),
        transcript: cap(transcript, OUTPUT_CAP * 4),
        stepId: last?.stepId ?? null,
        agentSessionId: null,
        cwd
      }
    }
  }

  private async runCheck(
    n: CheckNode,
    attempt: number,
    scope: RenderScope,
    sources: string[],
    byId: Map<string, WorkflowNode>,
    results: Map<string, NodeResult>
  ): Promise<NodeOutcome> {
    const target = results.get(n.target)
    let cwd: string
    let extraEnv: Record<string, string> | undefined
    if (n.isolate === 'worktree' || n.cwd) ({ cwd, env: extraEnv } = await this.nodeCwd(n, scope))
    else {
      cwd = target?.cwd ?? this.defaultCwd()
      // reviewing an isolated target in its worktree: same env (and push guard) as the target
      if (this.worktree && cwd === this.worktree.path) extraEnv = await this.isolatedEnv(this.worktree)
    }
    if (this.stopped) return { kind: 'canceled' }
    const srcs = [...new Set([...(target?.stepId ? [target.stepId] : []), ...sources])]
    if (n.command?.trim()) {
      const o = await this.runStep({
        nodeId: n.id,
        nodeType: 'check',
        attempt,
        round: null,
        participantLabel: null,
        profile: null,
        adapterId: 'shell',
        cwd,
        prompt: this.commandText(n.command, scope),
        resumeId: null,
        sourceStepIds: srcs,
        timeoutMin: n.timeoutMin,
        nodeLabel: n.label || n.id,
        extraEnv: { ...this.outEnv(results), ...(extraEnv ?? {}) },
        finalize: (o) =>
          o.exitCode === 0 && !o.timedOut
            ? { status: 'passed', verdict: 'PASS', error: null }
            : {
                status: 'failed',
                verdict: 'FAIL',
                error: o.timedOut ? `Timed out after ${n.timeoutMin} min` : `Exited with code ${o.exitCode}`
              }
      })
      if (o.status === 'canceled') return { kind: 'canceled' }
      if (o.verdict === null) return { kind: 'failed', error: o.error ?? 'Check failed to run' }
      const fb = o.timedOut ? `Command timed out after ${n.timeoutMin} min.\n${o.combined}` : o.combined
      return checkOutcome(o, fb || `Command exited with code ${o.exitCode}`, cwd)
    }
    const profile = this.ctx.getProfile(n.profileId!)
    if (!profile) return { kind: 'failed', error: `Agent profile ${n.profileId} no longer exists` }
    const targetNode = byId.get(n.target)
    const o = await this.runStep({
      nodeId: n.id,
      nodeType: 'check',
      attempt,
      round: null,
      participantLabel: null,
      profile,
      adapterId: profile.adapter,
      cwd,
      prompt: reviewerPrompt(render(n.criteria, scope), targetNode?.label || n.target, target?.output ?? ''),
      resumeId: null,
      sourceStepIds: srcs,
      timeoutMin: n.timeoutMin,
      memory: nodeMemoryMode(n),
      briefQuery: render(n.criteria, scope),
      nodeLabel: n.label || n.id,
      extraEnv,
      finalize: (o) => {
        if (o.status !== 'passed') return { status: 'failed', verdict: null, error: o.error }
        const v = parseVerdict(o.output)
        return { status: v === 'PASS' ? 'passed' : 'failed', verdict: v, error: v === 'PASS' ? null : 'Reviewer: FAIL' }
      }
    })
    if (o.status === 'canceled') return { kind: 'canceled' }
    if (o.verdict === null) return { kind: 'failed', error: o.error ?? 'Reviewer failed to run' }
    return checkOutcome(o, o.output, cwd)
  }

  // ---------- worktree per run (AUTHORING.md §6) ----------

  /** cwd (+ env) of a node: the run's worktree when isolated, else its own folder. */
  private async nodeCwd(n: WorkflowNode, scope: RenderScope): Promise<{ cwd: string; env?: Record<string, string> }> {
    if (n.isolate !== 'worktree') return { cwd: this.resolveCwd(n.type === 'notify' ? null : n.cwd, scope) }
    const wt = await this.ensureWorktree(scope)
    if (!isDir(wt.path)) throw new StepError(`Worktree folder not found: ${wt.path}`)
    return { cwd: wt.path, env: await this.isolatedEnv(wt) }
  }

  /** One worktree per run: the first isolated node creates it, concurrent ones await the same promise. */
  private ensureWorktree(scope: RenderScope): Promise<RunWorktree> {
    if (this.worktreeP) return this.worktreeP
    const bridge = this.ctx.worktrees
    const spec = this.workflow?.worktree ?? null
    this.worktreeP = (async () => {
      if (!bridge) throw new StepError('Worktrees are not available in this build')
      if (!spec?.repo?.trim()) throw new StepError('This workflow has no worktree repository')
      let repo = render(spec.repo, scope).trim()
      if (repo.startsWith('repo_')) {
        const r = this.ctx.getRepo(repo)
        if (!r) throw new StepError(`Repository ${repo} not found`)
        repo = r.path
      }
      if (!isAbsolute(repo)) throw new StepError(`Worktree repository must be a repository: ${repo || '(empty)'}`)
      this.checkCompany({ cwd: repo })
      let wt: RunWorktree
      try {
        wt = await bridge.ensure({ runId: this.run.id, workflowName: this.run.title, repo, base: spec.base?.trim() || null, dryRun: this.dryRun })
      } catch (e) {
        throw new StepError(`Could not create the worktree: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (wt.status === 'error') throw new StepError(`Could not create the worktree: ${wt.error ?? 'unknown error'}`)
      this.worktree = wt
      this.updateRun({ worktree: wt })
      return wt
    })()
    this.worktreeP.catch(() => {}) // observed by every awaiting node; never an unhandled rejection
    return this.worktreeP
  }

  /** HIVE_WORKTREE*, plus the PO5 push guard (main's env when it provides one, else the engine's own hooks dir). */
  private async isolatedEnv(wt: RunWorktree): Promise<Record<string, string>> {
    if (!this.guard) {
      let g: Record<string, string> | null = null
      try {
        g = this.ctx.worktrees?.guardEnv?.(this.run.id) ?? null
      } catch (e) {
        this.ctx.log.warn('engine: guardEnv failed; using the engine push guard', { runId: this.run.id, error: String(e) })
      }
      if (!g || !g.GIT_CONFIG_COUNT) {
        try {
          const dir = installPushGuard(join(this.ctx.paths.userData, 'git-hooks'))
          g = { ...pushGuardEnv(dir, [baseBranch(wt.base) ?? ''], this.ctx.baseEnv()), ...(g ?? {}) }
        } catch (e) {
          // PO5: never run an isolated node without the guard
          throw new StepError(`Could not install Hive's git push guard: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      this.guard = g
    }
    return { HIVE_WORKTREE: wt.path, HIVE_WORKTREE_BRANCH: wt.branch, ...this.guard }
  }

  /** Env of a Hive-run shell process (wait tries): baseEnv + all secrets + Hive vars + spawn tag. */
  private shellEnv(stepId: string, nodeId: string): Record<string, string> {
    return buildChildEnv(this.ctx, this.d.adapters.shell, null, {
      ARTIFACTS_DIR: this.run.artifactsDir,
      HIVE_RUN_ID: this.run.id,
      HIVE_NODE_ID: nodeId,
      HIVE_STEP_ID: stepId,
      HIVE_USER_DATA: this.ctx.paths.userData,
      HIVE_REPOS: this.repoPaths(),
      ...this.runVars(),
      ...(this.ctx.reaper?.tag(stepId) ?? {})
    }, this.secretOverride(), this.run.companyId)
  }

  /** SA2: a Slack-triggered run gets only the vault keys its trigger allow-lists (default none), shell steps included. */
  private secretOverride(): string[] | undefined {
    const a = this.slackAccess()
    return a?.keys === 'trigger' ? a.secretNames : undefined
  }

  /** Sleep that killAll (cancel, halt, failure) cuts short. Resolves true when it slept the full time. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(t)
        this.sleepers.delete(wake)
        resolve(false)
      }
      const t = setTimeout(() => {
        this.sleepers.delete(wake)
        resolve(true)
      }, Math.max(0, ms))
      this.sleepers.add(wake)
    })
  }

  // ---------- wait node (AUTHORING.md §7.1) ----------

  private async runWait(n: WaitNode, attempt: number, scope: RenderScope, sources: string[], results: Map<string, NodeResult>): Promise<NodeOutcome> {
    const { cwd, env: extraEnv } = await this.nodeCwd(n, scope)
    if (this.stopped) return { kind: 'canceled' }
    const info = this.d.provider('shell')
    if (!info.available || !info.binPath) return { kind: 'failed', error: `${info.label} not installed: ${info.installHint}` }
    const sec = this.d.waitSecondMs ?? 1000
    const command = this.commandText(n.command, scope)
    const re = n.until === 'match' ? new RegExp(n.pattern ?? '', 'm') : null
    const stepId = newId('step')
    const logDir = join(this.ctx.paths.runLogsDir, this.run.id)
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, `${stepId}.log`)
    const step: RunStep = {
      id: stepId,
      runId: this.run.id,
      seq: ++this.seq,
      nodeId: n.id,
      nodeType: 'wait',
      attempt,
      round: null,
      profileId: null,
      participantLabel: null,
      adapter: 'shell',
      cwd,
      prompt: this.redact(command),
      output: null,
      verdict: null,
      exitCode: null,
      pid: null,
      status: 'running',
      error: null,
      sourceStepIds: sources,
      agentSessionId: null,
      logPath,
      startedAt: this.iso(),
      endedAt: null
    }
    this.ctx.store.insertStep(step)
    this.ctx.emit({ type: 'step.updated', step })
    const first = command.split('\n')[0] ?? ''
    const live = new StepLive({
      ctx: this.ctx,
      provider: 'shell',
      runId: this.run.id,
      companyId: this.run.companyId ?? null,
      stepId,
      title: n.label || n.id,
      cwd,
      track: false,
      channel: false,
      activity: `Waiting · $ ${first}`
    })
    this.lives.set(stepId, live)
    const log: WriteStream = createWriteStream(logPath, { flags: 'a' })
    log.on('error', () => {})
    log.write(this.redact(`$ ${command}\n# cwd: ${cwd}\n# until ${n.until === 'match' ? `/${n.pattern}/` : 'exit 0'}, every ${n.intervalSec} s, for ${n.timeoutMin} min\n\n`))
    const env = { ...this.shellEnv(stepId, n.id), ...this.outEnv(results), ...(extraEnv ?? {}) }
    const budget = Math.max(1, n.timeoutMin) * 60 * sec
    const t0 = Date.now()
    let tries = 0
    let lastOut = ''
    let lastExit: number | null = null
    let res: { status: 'passed' | 'failed' | 'canceled'; error: string | null; activity: string | null }
    const set = this.procs.get(n.id) ?? new Set<ProcHandle>()
    this.procs.set(n.id, set)
    try {
      for (;;) {
        if (this.stopped) {
          res = { status: 'canceled', error: 'Canceled', activity: null }
          break
        }
        tries++
        const remaining = budget - (Date.now() - t0)
        const timeoutMs = Math.max(sec, Math.min((Math.min(n.intervalSec, 300) + 30) * sec, remaining + 30 * sec))
        let out = ''
        let errText = ''
        let r: ProcResult
        const release = await this.d.semaphore.acquire()
        try {
          if (this.stopped) {
            res = { status: 'canceled', error: 'Canceled', activity: null }
            break
          }
          const handle = startProcess({
            file: info.binPath,
            args: ['-lc', command],
            cwd,
            env,
            timeoutMs,
            ...(this.ctx.reaper ? { reap: { spawnId: stepId, reaper: this.ctx.reaper } } : {}),
            user: this.ctx.spawnUser?.() ?? null,
            onStdout: (c) => {
              if (out.length < OUTPUT_CAP * 4) out += c
            },
            onStderr: (c) => {
              errText = tail(errText + c, FEEDBACK_TAIL)
            }
          })
          set.add(handle)
          if (handle.pid && tries === 1) {
            const u = this.ctx.store.updateStep(stepId, { pid: handle.pid })
            this.ctx.emit({ type: 'step.updated', step: u })
          }
          if (this.stopped) void handle.kill()
          r = await handle.done
          set.delete(handle)
        } finally {
          release()
        }
        if (r.killed && !r.timedOut) {
          res = { status: 'canceled', error: 'Canceled', activity: null }
          break
        }
        lastOut = out.trim()
        lastExit = r.exitCode
        const at = this.d.now().toTimeString().slice(0, 8)
        const header = `# try ${tries} at ${at} (${r.timedOut ? 'timed out' : r.spawnError ? `error ${r.spawnError}` : `exit ${r.exitCode ?? r.signal}`})`
        log.write(this.redact(`${header}\n${out}${out.endsWith('\n') || !out ? '' : '\n'}${errText ? `${errText.trimEnd()}\n` : ''}`))
        const last3 = lastOut.split('\n').slice(-3).join('\n')
        this.ctx.emit({ type: 'step.output', runId: this.run.id, stepId, chunk: this.redact(`${header}\n${last3 ? `${last3}\n` : ''}`) })
        const done = re ? re.test(out) : r.exitCode === 0 && !r.timedOut && !r.spawnError
        if (done) {
          res = { status: 'passed', error: null, activity: null }
          break
        }
        if (Date.now() - t0 + n.intervalSec * sec >= budget) {
          res =
            n.onTimeout === 'continue'
              ? { status: 'passed', error: null, activity: 'gave up waiting, continuing' }
              : {
                  status: 'failed',
                  error: `Timed out after ${n.timeoutMin} min waiting (${tries} ${tries === 1 ? 'try' : 'tries'}); last output: ${tail(lastOut || errText.trim() || '(none)', 1000)}`,
                  activity: null
                }
          if (n.onTimeout === 'continue') log.write(`# gave up waiting after ${tries} tries, continuing\n`)
          break
        }
        live.setActivity(`Waiting · try ${tries} · next in ${n.intervalSec} s`)
        if (!(await this.sleep(n.intervalSec * sec))) {
          res = { status: 'canceled', error: 'Canceled', activity: null }
          break
        }
      }
    } finally {
      log.end()
    }
    const skip = res.status === 'canceled' && this.stopped === 'halted'
    const u = this.ctx.store.updateStep(stepId, {
      status: skip ? 'skipped' : res.status,
      output: this.redact(cap(lastOut, OUTPUT_CAP)),
      exitCode: lastExit,
      error: skip ? HALT_SKIP_ERROR : res.error ? this.redact(cap(res.error, 8000)) : null,
      endedAt: this.iso()
    })
    this.ctx.emit({ type: 'step.updated', step: u })
    live.finish(res.status === 'passed' ? 'done' : res.status === 'canceled' ? 'canceled' : 'failed', res.activity)
    this.lives.delete(stepId)
    if (res.status === 'canceled') return { kind: 'canceled' }
    if (res.status === 'failed') return { kind: 'failed', error: res.error ?? 'Wait failed' }
    return {
      kind: 'passed',
      verdict: null,
      feedback: '',
      result: { output: cap(lastOut), transcript: cap(lastOut), stepId, agentSessionId: null, cwd }
    }
  }

  // ---------- notify node (AUTHORING.md §7.2) ----------

  private async runNotify(n: NotifyNode, attempt: number, scope: RenderScope, sources: string[]): Promise<NodeOutcome> {
    if (this.stopped) return { kind: 'canceled' }
    const title = this.redact(clip(render(n.title ?? '', scope).trim() || n.label || 'Hive', 120))
    const message = this.redact(clip(render(n.message, scope).trim(), 2000))
    const cwd = this.defaultCwd()
    const stepId = newId('step')
    const logDir = join(this.ctx.paths.runLogsDir, this.run.id)
    mkdirSync(logDir, { recursive: true })
    const step: RunStep = {
      id: stepId,
      runId: this.run.id,
      seq: ++this.seq,
      nodeId: n.id,
      nodeType: 'notify',
      attempt,
      round: null,
      profileId: null,
      participantLabel: null,
      adapter: 'shell',
      cwd,
      prompt: message,
      output: null,
      verdict: null,
      exitCode: null,
      pid: null,
      status: 'running',
      error: null,
      sourceStepIds: sources,
      agentSessionId: null,
      logPath: join(logDir, `${stepId}.log`),
      startedAt: this.iso(),
      endedAt: null
    }
    this.ctx.store.insertStep(step)
    this.ctx.emit({ type: 'step.updated', step })
    // SLACK.md §10: Slack replaces iMessage. A legacy `imessage: true` (old snapshot / import) reads as a DM to "me".
    const target: NotifySlackTarget | null = notifyTarget(n)
    const requested = target ? 'skipped' : 'not_requested'
    let res: NotifyResult
    if (!this.ctx.notifier) res = { notified: false, slack: requested, note: 'Notifications are not available in this build' }
    else {
      try {
        res = await withTimeout(this.ctx.notifier.send({ runId: this.run.id, stepId, title, message, slack: target }), 60_000)
      } catch (e) {
        res = { notified: false, slack: target ? 'failed' : 'not_requested', note: `Could not notify: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    const slack = res.slack ?? requested
    // an older main that does not know Slack yet: say so instead of pretending
    const rawNote = res.note ?? (target && res.slack === undefined ? 'Slack alerts are not available in this build; sent a Mac notification only.' : null)
    // a missed alert must not fail a run that did the work: the step passes with the note
    const note = rawNote ? this.redact(rawNote) : null
    const output = note ? `${message}\n\n(${note})` : message
    try {
      writeFileSync(step.logPath, `# notify: ${title}\n${output}\n# notified=${res.notified} slack=${slack}\n`)
    } catch {
      /* log is best effort */
    }
    this.ctx.emit({ type: 'step.output', runId: this.run.id, stepId, chunk: `${output}\n` })
    const u = this.ctx.store.updateStep(stepId, { status: 'passed', output: cap(output, OUTPUT_CAP), exitCode: 0, endedAt: this.iso() })
    this.ctx.emit({ type: 'step.updated', step: u })
    return { kind: 'passed', verdict: null, feedback: '', result: { output, transcript: output, stepId, agentSessionId: null, cwd } }
  }
}

class StepError extends Error {}

interface OpenMemory {
  grant: MemoryGrant
  attachment: McpAttachment | null
  /** hivemem's ask_user is reachable from this spawn. */
  askUser: boolean
  /** Ask-only pseudo grant (memory off): nothing to release in the memory store. */
  askOnly: boolean
  /** What `attachment` holds (claude), so the slack toolset can share its one --mcp-config. */
  servers?: { server: McpServerSpec; toolNames: string[] }[]
}

type NodeOutcome =
  | { kind: 'passed'; result: NodeResult; verdict: 'PASS' | 'FAIL' | null; feedback: string }
  | { kind: 'failed'; error: string }
  | { kind: 'canceled' }

/** SLACK.md §10.1 / §10.4: the node's Slack target; legacy `imessage: true` = DM to the alert user. */
export function notifyTarget(n: NotifyNode): NotifySlackTarget | null {
  if (n.slack && (n.slack.kind === 'me' || (n.slack.kind === 'channel' && typeof n.slack.channel === 'string' && n.slack.channel))) return n.slack
  if (n.slack === undefined && (n as { imessage?: unknown }).imessage === true) return { kind: 'me' }
  return null
}

/** First `max` chars with an ellipsis (rendered notify title/message). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Rejects after `ms` (a bridge call must never hang a run's end). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

function toOutcome(o: StepOutcome, cwd: string): NodeOutcome {
  if (o.status === 'canceled') return { kind: 'canceled' }
  if (o.status === 'failed') return { kind: 'failed', error: o.error ?? 'failed' }
  return {
    kind: 'passed',
    verdict: null,
    feedback: '',
    result: { output: cap(o.output), transcript: cap(o.output), stepId: o.stepId, agentSessionId: o.agentSessionId, cwd }
  }
}

function checkOutcome(o: StepOutcome, feedback: string, cwd: string): NodeOutcome {
  return {
    kind: 'passed',
    verdict: o.verdict,
    feedback: feedback.trim(),
    result: { output: cap(o.output), transcript: cap(o.output), stepId: o.stepId, agentSessionId: null, cwd }
  }
}

/** Creates <artifactsRoot>/<runId>/ ; returns the absolute dir with trailing slash. */
export function ensureRunDirs(ctx: EngineContext, runId: string): string {
  const dir = join(ctx.paths.artifactsRoot, runId)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(ctx.paths.runLogsDir, runId), { recursive: true })
  if (!existsSync(ctx.paths.scratchDir)) mkdirSync(ctx.paths.scratchDir, { recursive: true })
  return `${dir}/`
}
