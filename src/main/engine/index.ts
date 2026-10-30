/**
 * Hive engine — OWNED BY THE AI ENGINEER. Contract: docs/CONTRACT.md section 5, types in src/shared/engine.ts.
 * src/main imports `createEngine` (and `seedWorkflows`) from this file. No electron imports anywhere in engine/.
 */
import type { CreateEngine, Engine, EngineContext, StartRunOptions } from '../../shared/engine'
import { HiveError } from '../../shared/errors'
import { inputValueErrors } from '../../shared/inputs'
import { newId } from '../../shared/ids'
import { paneScope } from '../../shared/browser'
import type { AdapterId, ProviderInfo, Run, RunTarget, WorkflowDraft } from '../../shared/types'
import { ADAPTER_IDS } from '../../shared/types'
import { DEFAULT_ADAPTERS, type Adapter } from './adapters'
import { Execution, ensureRunDirs } from './executor'
import { StallMonitor, stallThresholdMs } from './live/stall'
import { attachGateway, GATEWAY_TOOLS } from '../gateway/attach'
import { attachForum } from '../forum/attach'
import { MCP_TOOL_TIMEOUT_MS, agentBrief, claudeSessionMcpAttach, codexSessionMcpAttach, memoryTransport, writeMcpFiles, type McpAttachment } from './memory'
import { AUTHOR_TOOLS, CODEX_AUTHOR_HINT, authorAttachable } from './authoring'
import { CHAT_COMPANY_CODEX_HINT, CHAT_COMPANY_HINT, CHAT_COMPANY_TOOL } from '../../shared/chatCompany'
import { join } from 'node:path'
import { LIVE_HOOKS } from './live/attach'
import { listedHiveTools } from '../author/server/tools'
import { principiaOps, principiaOpsReminder } from '../company/principiaOps'
import { liveProcs } from './process'
import { detectProviders, resolveBin, sameProviders } from './providers'
import { createScheduler, describeWhen, previewWhen } from './scheduler'
import { concurrencyLimit, Semaphore } from './util'
import { validateWorkflow } from './validate'
import { channelLabel, createSlackTriggers, type SlackTriggers } from './slackTriggers'

export type { Engine, EngineContext } from '../../shared/engine'
export { seedWorkflows, type SeedProfiles, type SeedWorkflow } from './seeds'

// ---------- live agents: pure helpers main uses for interactive sessions (CONTRACT §12.3) ----------
export { createAgentTracker, ASK_TIMEOUT_MS, isTerminal, type AgentTracker, type TrackerOptions } from './live/tracker'
export { normalizeHook } from './live/hooks'
export { detectPtyPrompt, ptyReplyKeys, samePrompt, stripAnsi } from './live/pty'
export { summarizeTool, isMemoryRead, editedFiles } from './live/summary'
export { HOOKS_VERIFIED, LIVE_HOOKS } from './live/attach'
export { gateDecision } from './live/claudeControl'
export { createLiveSink, type LiveSink } from './live/sink'
// ---------- usage limits, Stalled?, spawn tagging + reaper (CONTRACT §13) ----------
export { classifyLimitText, classifyStopFailure, classifyStreamLine, parseResetTime, type LimitHit } from './live/limits'
export { StallMonitor, stallThresholdMs, type StallEntry } from './live/stall'
export { Reaper, SPAWN_ENV, collectTree, findLeftovers, parsePs, attachEnv, systemProcessTable, type ProcessTable, type ProcRow } from './reaper'
export { retryTime, HALT_SKIP_ERROR } from './executor'
// ---------- authoring (AUTHORING.md, CONTRACT §14) ----------
export {
  AUTHOR_HINT,
  AUTHOR_SERVER_NAME,
  AUTHOR_TOOLS,
  AUTHORING_CONTRACTS,
  AUTHORING_NODE_DOCS,
  AUTHORING_TEMPLATING,
  PR_ROUNDUP_EXAMPLE,
  authorAttachable,
  authoringErrors,
  commandInputs,
  detectHalt,
  inputsNeedingApproval
} from './authoring'
export { CHAINED_HOOKS, baseBranch, installPushGuard, pushGuardEnv } from './pushGuard'
export { validateWorkflow, NODE_TYPES, type ValidateDeps } from './validate'
export { parseRefs, nodeTexts, isCommandField, TRIGGER_FIELDS, type TemplateRef, type TriggerVars } from './templates'
// ---------- Slack (SLACK.md §9, §10; CONTRACT Slack.3) ----------
export {
  validateSlackTrigger,
  regexProbe,
  notifySlackError,
  TRIGGER_IN_COMMAND,
  SLACK_CHANNEL_ID,
  SLACK_USER_ID,
  type SlackTriggerValidateDeps
} from './validate'
export {
  normalizeSlackTriggerInput,
  describeSlackTrigger,
  matchSlackTrigger,
  lastAgentNode,
  threadKeyOf,
  triggerVars,
  renderTriggerInputs,
  replyText,
  UNTRUSTED_SLACK_NOTE,
  type SentenceNames
} from './slackTriggers'
export { AUTHORING_SLACK, SLACK_TRIGGER_EXAMPLES } from './authoring'
export { ROOT_KEY, type HookEvent, type LiveOp, type PtyPrompt, type TrackedAsk, type AgentPatch } from './live/types'

/** Chat replies at once, across companies, on top of Settings.concurrency: short, and someone is waiting on each. */
export const REPLY_SLOTS = 4

export interface EngineOverrides {
  /** Reply lane size and how long a reply may linger after its result (tests). */
  replySlots?: number
  replyEndGraceMs?: number
  /** Replace adapters (tests use a fake claude). */
  adapters?: Partial<Record<AdapterId, Adapter>>
  /** Replace provider detection (tests). */
  detect?: () => Promise<ProviderInfo[]>
  /** Ask expiry (tests). Default ASK_TIMEOUT_MS (60 min). */
  askTimeoutMs?: number
  /** Stall sweep period (tests). Default 15 s. */
  stallSweepMs?: number
  /** Stall threshold (tests). Default Settings.stallMinutes. */
  stallThresholdMs?: number
  /** Wait-node time unit (tests). Default 1000 ms. */
  waitSecondMs?: number
  /** Harness fallback filter (ExecDeps.harnessFallback). Absent = the desktop's rule. */
  harnessFallback?: (runId: string, to: AdapterId) => boolean
}

/**
 * A prompt run's title source. A framed prompt (a board task turn, a Forum reply: `<principia-role …>` first, or after
 * one plain line) is named by
 * its task's Title line, else by the first text outside the frames, never by the frame itself.
 */
export function framedPromptTitle(prompt: string): string {
  const text = prompt.trim()
  // a Forum reply starts with one plain line ("Forum reply in #general") before its frames: framed all the same
  if (!/^<principia-[a-z]/i.test(text) && !/^[^\n]*\n\s*<principia-[a-z]/i.test(text)) return text
  const title = /<principia-task\b[^>]*>\s*Title:[ \t]*([^\n]*)/i.exec(text)?.[1]?.trim()
  if (title) return title
  const rest = text.replace(/<principia-([a-z-]+)\b[^>]*>[\s\S]*?<\/principia-\1>/gi, '').trim()
  return rest.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Task turn'
}

export function createEngineWith(ctx: EngineContext, overrides: EngineOverrides = {}): Engine {
  const now = (): Date => (ctx.now ? ctx.now() : new Date())
  const adapters: Record<AdapterId, Adapter> = { ...DEFAULT_ADAPTERS, ...overrides.adapters }
  let providers: ProviderInfo[] = []
  const executions = new Map<string, Execution>()
  // CONTRACT §13: one stall monitor for every running step (threshold read live from Settings.stallMinutes)
  const stall = new StallMonitor({
    thresholdMs: () => {
      if (overrides.stallThresholdMs) return overrides.stallThresholdMs
      try {
        return stallThresholdMs(ctx.getSettings().stallMinutes)
      } catch {
        return stallThresholdMs(10)
      }
    }
  })
  const semaphore = new Semaphore(() => concurrencyLimit(ctx.getSettings().concurrency))
  const replySemaphore = new Semaphore(() => overrides.replySlots ?? REPLY_SLOTS)

  /** Cached detection, falling back to a sync PATH lookup before the first detect finished. */
  const provider = (id: AdapterId): ProviderInfo => {
    const p = providers.find((x) => x.id === id)
    if (p) return p
    const a = adapters[id]
    const binPath = resolveBin(a, ctx.baseEnv())
    return {
      id,
      label: a.label,
      available: !!binPath,
      version: null,
      binPath,
      installHint: a.installHint,
      checkedAt: now().toISOString(),
      ...(memoryTransport(id) ? { memory: memoryTransport(id)! } : {})
    }
  }

  const detect = async (): Promise<ProviderInfo[]> =>
    overrides.detect ? overrides.detect() : detectProviders(adapters, ctx.baseEnv(), now())

  const refreshProviders = async (): Promise<ProviderInfo[]> => {
    const next = await detect()
    const changed = !sameProviders(providers, next)
    providers = next
    if (changed) ctx.emit({ type: 'providers.updated', providers })
    return providers
  }

  const validate = (draft: WorkflowDraft, opts: { slackTriggered?: boolean } = {}) =>
    validateWorkflow(draft, { getProfile: (id) => ctx.getProfile(id), getRepo: (id) => ctx.getRepo(id), slackTriggered: !!opts.slackTriggered })

  /**
   * COMPANY.md §3, §6: the run's company by inheritance (workflow, then schedule, then repo, then the explicit id;
   * Personal otherwise), and the cross-company guards: with experimental.companies on a mismatch throws, off it is
   * logged and the run is still stamped. null = no company bridge (tests, older main).
   */
  const runCompany = (target: RunTarget, opts: StartRunOptions): string | null => {
    const co = ctx.company
    if (!co) return null
    const problems: (string | null)[] = []
    let companyId: string
    // DEPARTMENTS.md §4.3: a task run belongs to its task's company, first in the stamping order; its repo or workflow
    // must be that company's, and a conflicting explicit id is a cross-company launch
    const fromTask = opts.taskId ? safeTaskCompany(opts.taskId) : null
    if (fromTask) {
      companyId = fromTask
      problems.push(co.crossCompany(companyId, target.kind === 'workflow' ? { workflowId: target.workflowId } : { repoId: target.repoId ?? null }))
      if (opts.companyId && opts.companyId !== companyId) problems.push('That task belongs to another company')
    } else if (target.kind === 'workflow') {
      companyId = co.resolve({ workflowId: target.workflowId })
      if (opts.companyId) problems.push(co.crossCompany(opts.companyId, { workflowId: target.workflowId }))
    } else {
      const fromSchedule = opts.scheduleId && ctx.store.getSchedule(opts.scheduleId) ? co.resolve({ scheduleId: opts.scheduleId }) : null
      companyId = fromSchedule ?? (target.repoId ? co.resolve({ repoId: target.repoId }) : co.resolve({ companyId: opts.companyId ?? null }))
      if (target.repoId) problems.push(co.crossCompany(companyId, { repoId: target.repoId }))
      if (opts.companyId && opts.companyId !== companyId) problems.push(co.crossCompany(opts.companyId, { repoId: target.repoId ?? null }) ?? 'That run belongs to another company')
    }
    // a schedule fires its target in its own company (schedules:save checks it; the workflow may have moved since)
    if (opts.scheduleId && target.kind === 'workflow' && ctx.store.getSchedule(opts.scheduleId)) {
      const sc = co.resolve({ scheduleId: opts.scheduleId })
      problems.push(co.crossCompany(sc, { workflowId: target.workflowId }))
    }
    const problem = problems.find(Boolean)
    if (problem) {
      if (co.enforced()) throw new HiveError('bad_request', problem)
      ctx.log.warn('engine: company guard (not enforced)', { companyId, problem })
    }
    // five doors A4: a paused company starts nothing, whatever started it (schedule, retry, task, a click)
    const paused = co.pausedName?.(companyId) ?? null
    if (paused) throw new HiveError('conflict', `${paused} is paused. Resume it to start work.`)
    return companyId
  }

  /** The task's company through the board bridge; a failing bridge never blocks a run (it falls back to inheritance). */
  const safeTaskCompany = (taskId: string): string | null => {
    try {
      return ctx.company?.tasks?.companyOf(taskId) ?? null
    } catch (e) {
      ctx.log.warn('engine: task company lookup failed', { taskId, error: String(e) })
      return null
    }
  }

  const startRun = (target: RunTarget, opts: StartRunOptions): Run => {
    if (!target || typeof target !== 'object') throw new HiveError('bad_request', 'Missing run target')
    let title: string
    let snapshot: WorkflowDraft | null = null
    let workflowId: string | null = null
    if (target.kind === 'prompt') {
      if (!target.prompt?.trim()) throw new HiveError('validation', 'Prompt is empty', [{ path: 'prompt', message: 'Prompt is empty' }])
      if (!ctx.getProfile(target.profileId)) throw new HiveError('not_found', `Agent profile ${target.profileId} not found`)
      if (target.repoId && !ctx.getRepo(target.repoId)) throw new HiveError('not_found', `Repository ${target.repoId} not found`)
      const oneLine = (opts.title?.trim() || framedPromptTitle(target.prompt)).replace(/\s+/g, ' ')
      title = oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine
    } else if (target.kind === 'workflow') {
      const wf = ctx.getWorkflow(target.workflowId)
      if (!wf) throw new HiveError('not_found', `Workflow ${target.workflowId} not found`)
      // a Slack-triggered run also gets the Slack-driven rules (no step output in a command)
      const errors = validate(wf, { slackTriggered: !!opts.slack })
      if (errors.length) throw new HiveError('validation', `Workflow "${wf.name}" is invalid`, errors)
      // typed inputs: a checkbox (boolean) input runs only with exactly 'true' / 'false', never a guess
      const bad = inputValueErrors(wf.inputs, target.inputs)
      if (bad.length) throw new HiveError('validation', bad.map((e) => e.message).join('; '), bad)
      snapshot = {
        name: wf.name,
        description: wf.description,
        inputs: wf.inputs,
        nodes: wf.nodes,
        ...(wf.worktree ? { worktree: wf.worktree } : {}),
        ...(wf.slackTools ? { slackTools: true, ...(wf.slackAgentPermissions === 'profile' ? { slackAgentPermissions: 'profile' as const } : {}) } : {})
      }
      workflowId = wf.id
      // SLACK.md §9.3: "<workflow> · #support"
      title = opts.slack ? `${wf.name} · ${channelLabel(opts.slack.channelKind, opts.slack.channelName, opts.slack.userName)}` : wf.name
    } else throw new HiveError('bad_request', 'Unknown run target')

    const companyId = runCompany(target, opts)
    const id = newId('run')
    const artifactsDir = ensureRunDirs(ctx, id)
    const run: Run = {
      id,
      kind: target.kind,
      title: ctx.secrets.redact(title),
      target,
      workflowId,
      scheduleId: opts.scheduleId ?? null,
      parentRunId: opts.parentRunId ?? null,
      // 'task' is stored as 'manual' + trigger_ext (engineStore) and reads back as 'task'
      trigger: opts.trigger as Run['trigger'],
      status: 'queued',
      reason: null,
      createdAt: now().toISOString(),
      startedAt: null,
      endedAt: null,
      artifactsDir,
      artifactCount: 0,
      ...(companyId ? { companyId } : {}),
      ...(opts.startedBy ? { startedBy: { ...opts.startedBy, ownerLabel: ctx.secrets.redact(opts.startedBy.ownerLabel) } } : {}),
      ...(opts.slack ? { slack: opts.slack } : {})
    }
    const task = opts.taskId ? { taskId: opts.taskId, agentId: opts.agentId ?? null } : null
    ctx.store.insertRun(run, snapshot, task)
    ctx.emit({ type: 'run.updated', run })
    const exec = new Execution(
      { ctx, adapters, provider, semaphore, replySemaphore, replyEndGraceMs: overrides.replyEndGraceMs, now, askTimeoutMs: overrides.askTimeoutMs, stall, waitSecondMs: overrides.waitSecondMs, harnessFallback: overrides.harnessFallback },
      run,
      snapshot,
      task ? { ...task, resumeSessionId: opts.resumeSessionId ?? null } : null,
      task ? null : (opts.agentId ?? null),
      !!opts.reply && !task
    )
    stall.startTimer(overrides.stallSweepMs ?? 15_000)
    executions.set(id, exec)
    setImmediate(() => {
      void exec.execute().finally(() => {
        executions.delete(id)
        // SLACK.md §9.3 step 7: one active run per trigger + thread; reply binding
        if (slackTriggers && exec.run.trigger === 'slack')
          void slackTriggers.runEnded(exec.run).catch((e) => ctx.log.warn('engine: slack run end failed', { runId: id, error: String(e) }))
      })
    })
    return run
  }

  /** A rerun of a prompt run stays in the source run's company; a workflow run takes its workflow's (it may have moved). */
  const rerunCompany = (r: Run): Pick<StartRunOptions, 'companyId'> =>
    r.target.kind === 'prompt' && r.companyId && ctx.company ? { companyId: r.companyId } : {}

  const active = (): Run[] => {
    const mem = [...executions.values()].map((e) => e.run).filter((r) => r.status === 'queued' || r.status === 'running')
    const ids = new Set(mem.map((r) => r.id))
    let stored: Run[] = []
    try {
      stored = ctx.store.listActiveRuns().filter((r) => !ids.has(r.id))
    } catch {
      /* store optional in edge cases */
    }
    return [...mem, ...stored]
  }

  // SLACK.md §9.3: Slack triggers exist only when main gave the engine a SlackBridge
  let slackTriggers: SlackTriggers | null = null
  const scheduler = createScheduler({
    store: ctx.store,
    startRun,
    rerun: (r) => startRun(r.target, { trigger: 'rerun', parentRunId: r.id, scheduleId: r.scheduleId, ...rerunCompany(r) }),
    isScheduleActive: (sid) => active().some((r) => r.scheduleId === sid),
    emit: (e) => ctx.emit(e),
    log: ctx.log,
    now,
    board: ctx.company?.boards?.schedules ?? null,
    // five doors A4: one paused company's schedules hold (logged as skipped); every other company's keep their time
    companyPaused: (sch) => {
      const co = ctx.company
      if (!co?.pausedName) return null
      try {
        return co.pausedName(co.resolve({ scheduleId: sch.id }))
      } catch {
        return null
      }
    },
    runCompanyPaused: (r) => {
      const co = ctx.company
      return co?.pausedName && r.companyId ? co.pausedName(r.companyId) : null
    },
    paused: (() => {
      try {
        return !!ctx.getSettings().schedulesPaused
      } catch {
        return false
      }
    })()
  })

  if (ctx.slack) {
    slackTriggers = createSlackTriggers({
      store: ctx.store,
      slack: ctx.slack,
      getWorkflow: (id) => ctx.getWorkflow(id),
      getSettings: () => ctx.getSettings(),
      startRun,
      getRun: (id) => executions.get(id)?.run ?? ctx.store.getRun(id),
      activeRuns: active,
      emit: (e) => ctx.emit(e),
      log: ctx.log,
      now,
      board: ctx.company?.boards?.slack ?? null
    })
  }

  return {
    async init() {
      for (const r of ctx.store.listActiveRuns()) {
        const detail = ctx.store.getRunDetail(r.id)
        for (const s of detail?.steps ?? []) {
          if (s.status === 'pending' || s.status === 'running') {
            const u = ctx.store.updateStep(s.id, { status: 'failed', error: 'Hive quit during run', endedAt: now().toISOString() })
            ctx.emit({ type: 'step.updated', step: u })
          }
        }
        const u = ctx.store.updateRun(r.id, { status: 'failed', reason: 'Hive quit during run', endedAt: now().toISOString() })
        ctx.emit({ type: 'run.updated', run: u })
      }
      await refreshProviders()
    },

    async shutdown() {
      scheduler.stop()
      slackTriggers?.stop()
      stall.stopTimer()
      await Promise.all([...executions.values()].map((e) => e.cancel('Hive quit during run')))
      await Promise.all([...liveProcs].map((p) => p.kill()))
    },

    providers: {
      list: async (opts) => (opts?.refresh || !providers.length ? refreshProviders() : providers),
      cached: () => providers,
      interactiveSpawn(profile, opts) {
        const info = provider(profile.adapter)
        if (!info.available || !info.binPath)
          throw new HiveError('adapter_unavailable', `${info.label} not installed: ${info.installHint}`)
        const a = adapters[profile.adapter]
        // Memory (CONTRACT 11.4): main obtained the grant and releases it (which deletes the config file).
        // CONTRACT §13: the session's hivemem child carries the session's spawn tag
        const grant = opts.memory && opts.spawnTag ? { ...opts.memory, server: { ...opts.memory.server, env: { ...opts.memory.server.env, ...opts.spawnTag } } } : (opts.memory ?? null)
        let mcp: McpAttachment | null = null
        const memOk = !!grant && memoryTransport(profile.adapter) === 'mcp' && !!a.mcpAttach && grant.toolNames.length > 0
        // AUTHORING.md §1.1 (PO1, PO7): the `hive` server, interactive claude and codex panes, with hivemem (claude: ONE
        // per-spawn config; codex: -c overrides)
        const author = opts.author && authorAttachable(profile.adapter, 'interactive') ? opts.author : null
        const authorSpec = author ? { ...author, env: { ...author.env, ...(opts.spawnTag ?? {}) } } : null
        const authorDir = opts.authorSpawnDir ?? opts.live?.dir ?? null
        let authored = false
        let memAttached = false
        // codex lists only the hive tools it may call without a prompt (claude prompts in the pane for the rest)
        let codexHiveTools: string[] | null = null
        if (authorSpec && profile.adapter === 'codex') {
          try {
            const allowed = new Set<string>(opts.authorTools?.length ? opts.authorTools : AUTHOR_TOOLS)
            // "start a company from this chat" stays the codex button (CHAT_COMPANY_CODEX_HINT)
            codexHiveTools = listedHiveTools(authorSpec.env ?? {}).filter((t) => allowed.has(t) && t !== CHAT_COMPANY_TOOL)
            mcp = codexSessionMcpAttach([
              ...(memOk ? [{ server: grant!.server, toolNames: grant!.toolNames }] : []),
              // an authoring write waits for the founder's click on the card (up to 3300 s)
              { server: authorSpec, toolNames: codexHiveTools, toolTimeoutSec: Math.ceil(Number(MCP_TOOL_TIMEOUT_MS) / 1000) }
            ])
            authored = codexHiveTools.length > 0
            memAttached = memOk
          } catch (e) {
            ctx.log.warn('engine: codex session hive MCP attach failed; memory only', { error: String(e) })
            mcp = null
            codexHiveTools = null
          }
        } else if (authorSpec && authorDir) {
          try {
            const path = memOk ? join(grant!.spawnDir, `${grant!.grantId}.mcp.json`) : join(authorDir, 'hive.mcp.json')
            const tools = opts.authorTools?.length ? opts.authorTools : AUTHOR_TOOLS
            mcp = claudeSessionMcpAttach(path, [
              ...(memOk ? [{ server: grant!.server, toolNames: grant!.toolNames }] : []),
              { server: authorSpec, toolNames: tools }
            ])
            writeMcpFiles(mcp.files)
            authored = true
            memAttached = memOk
          } catch (e) {
            ctx.log.warn('engine: session hive MCP attach failed; memory only', { error: String(e) })
            mcp = null
          }
        } else if (authorSpec) ctx.log.warn('engine: hive server needs a spawn dir (live dir); not attached')
        if (!mcp && memOk) {
          try {
            mcp = a.mcpAttach!(grant!)
            writeMcpFiles(mcp.files)
            memAttached = true
          } catch (e) {
            ctx.log.warn('engine: session memory MCP attach failed', { grantId: grant!.grantId, error: String(e) })
            mcp = null
          }
        }
        let gatewayOn = false
        if (profile.adapter === 'claude' || profile.adapter === 'codex') {
          const gwCwd = opts.cwd ?? ctx.paths.scratchDir
          // SEC-4: key-backed connections only for the keys this profile may read
          const gateway = opts.companyId ? ctx.gateway?.attachment(gwCwd, opts.companyId, null, profile.secretNames) : ctx.gateway?.attachment(gwCwd, null, null, profile.secretNames)
          if (gateway) { mcp = attachGateway(profile.adapter, gateway, mcp, gateway.env.PRINCIPIA_GATEWAY_DIR); if (mcp) { writeMcpFiles(mcp.files); gatewayOn = true } }
        }
        // BROWSER.md §3: the company browser for company panes (claude, codex), its own token and this chat's own tabs
        let browserTools: string[] = []
        if (opts.companyId && ctx.browser && (profile.adapter === 'claude' || profile.adapter === 'codex')) {
          try {
            const spec = ctx.browser.attachment({ companyId: opts.companyId, agent: profile.adapter === 'codex' ? 'Codex' : 'Claude', sessionKey: paneScope(opts.spawnTag?.HIVE_SPAWN_ID ?? opts.freshAgentSessionId ?? opts.resumeAgentSessionId ?? Date.now().toString(36)) })
            const dir = opts.live?.dir ?? authorDir ?? (grant ? grant.spawnDir : null) ?? join(ctx.paths.scratchDir, 'mcp-browser')
            if (spec) {
              const att = attachForum(profile.adapter, spec, ctx.browser.toolNames(), mcp, join(dir, 'browser.mcp.json'))
              if (att) {
                writeMcpFiles(att.files)
                mcp = att
                browserTools = ctx.browser.toolNames()
              }
            }
          } catch (e) {
            ctx.log.warn('engine: session browser MCP attach failed; no browser for this pane', { error: String(e) })
          }
        }
        // PROACTIVE.md §1: the "Use Principia" section, from the tools this pane really has (company panes only)
        const proactive = !!opts.companyId && ctx.getSettings().proactiveAgents !== false && (profile.adapter === 'claude' || profile.adapter === 'codex')
        const paneTools = [...(memAttached && grant ? grant.toolNames : []), ...(authored && authorSpec ? codexHiveTools ?? listedHiveTools(authorSpec.env ?? {}) : []), ...(gatewayOn ? GATEWAY_TOOLS : []), ...browserTools]
        // Settings → "Track work as tasks" (absent = when it helps)
        const track = ctx.getSettings().trackTasks ?? 'auto'
        const ops = proactive ? principiaOps({ tools: paneTools, kind: authorSpec?.env?.HIVE_TASK_ID ? 'task' : opts.chatBrief?.trim() ? 'chat' : 'session', track }) : ''
        const memoryBrief = ctx.secrets.redact([
          // nobody harvests an interactive pane's output (PASSPORT.md §7.6 is headless steps only)
          grant ? agentBrief(grant, !!mcp && memOk, { harvest: false }) : '',
          // COMPANY.md §5: the session's company decides the Passport (cwd only for older callers without one); a
          // department chat or task session adds the department slot (DEPARTMENTS.md §7)
          opts.companyId ? ctx.passportContext?.(opts.cwd ?? '', opts.companyId, opts.departmentId ?? null) ?? '' : opts.cwd ? ctx.passportContext?.(opts.cwd) ?? '' : '',
          // DEPARTMENTS.md §9: what this chat is told about the company's repos, departments, agents and tasks
          opts.chatBrief?.trim() ?? '',
          // shared/chatCompany.ts: "start a new company from this chat" (claude: the tool; codex: the button)
          profile.adapter === 'codex' ? CHAT_COMPANY_CODEX_HINT : authored && (authorSpec?.env?.HIVE_TOOLSETS ?? '').split(',').includes('newco') ? CHAT_COMPANY_HINT : '',
          // claude gets AUTHOR_HINT in --append-system-prompt; codex reads it here (developer_instructions)
          profile.adapter === 'codex' && codexHiveTools?.some((t) => t.startsWith('hive_workflow')) ? CODEX_AUTHOR_HINT : '',
          ops
        ].filter(Boolean).join('\n\n'))
        // Live hooks (LIVE.md §3.2, §3.5): observational only for interactive panes (A1: no gate). No ask_user (A2).
        let hookArgs: string[] = []
        const env: Record<string, string> = { ...(mcp?.env ?? {}) }
        // A5 for panes: an authoring write waits for the user's click (up to 3300 s); per spawn only (codex: tool_timeout_sec)
        if (authored && profile.adapter === 'claude') env.MCP_TOOL_TIMEOUT = MCP_TOOL_TIMEOUT_MS
        if (opts.live && a.hooksAttach && LIVE_HOOKS[profile.adapter]) {
          try {
            const gm = profile.adapter === 'gemini' && mcp && memOk && grant ? { server: grant.server, toolNames: grant.toolNames } : null
            // PROACTIVE.md §4: claude re-reads the rules on resume / compact; under "Always" only, a one-time gentle
            // reminder at the end of an untracked multi-step turn (never under the default: the founder may just want to work)
            const boardTools = track === 'always' && paneTools.some((t) => t === 'task_create' || t === 'company_file_task')
            const h = a.hooksAttach(
              { dir: opts.live.dir, hookCommand: opts.live.hookCommand },
              { headless: false, gate: false, mcp: gm, ...(ops ? { context: ctx.secrets.redact(principiaOpsReminder(ops)) } : {}), ...(ops && boardTools ? { nudge: true } : {}) }
            )
            if (h.warning) ctx.log.warn(`engine: ${h.warning}`)
            writeMcpFiles(h.files)
            hookArgs = h.args
            Object.assign(env, h.env)
          } catch (e) {
            ctx.log.warn('engine: session live hooks attach failed; no live tree for this session', { error: String(e) })
          }
        }
        const inv = a.interactive({
          profile,
          artifactsDir: opts.artifactsDir,
          ...(opts.keyNames?.length ? { keyNames: opts.keyNames } : {}),
          resumeId: opts.resumeAgentSessionId ?? null,
          sessionId: opts.freshAgentSessionId ?? null,
          bypass: opts.bypass === true,
          ...(mcp ? { mcpArgs: mcp.args } : {}),
          ...(memoryBrief ? { memoryBrief } : {}),
          ...(hookArgs.length ? { hookArgs } : {}),
          ...(authored && profile.adapter === 'claude' ? { authorHint: true } : {}),
          ...(opts.initialPrompt?.trim() ? { initialPrompt: opts.initialPrompt } : {}),
          ...(opts.addDirs?.length ? { addDirs: opts.addDirs } : {})
        })
        return {
          file: info.binPath,
          args: inv.args,
          ...(Object.keys(env).length ? { env } : {}),
          stripEnv: profile.useApiKeyAuth ? [] : [...a.authEnv],
          agentSessionId: inv.agentSessionId
        }
      }
    },

    workflows: { validate },

    asks: {
      /** Run-owned asks (LIVE.md §4.3): stdio control_response, hook gate file, or mcp answer file. */
      answer(id, a) {
        for (const e of executions.values()) {
          const r = e.answerAsk(id, a)
          if (r) return r
        }
        throw new HiveError('conflict', 'Already answered in the terminal')
      }
    },

    runs: {
      start: startRun,
      async cancel(id) {
        const e = executions.get(id)
        if (e) return e.cancel()
        const r = ctx.store.getRun(id)
        if (!r) throw new HiveError('not_found', `Run ${id} not found`)
        if (r.status === 'queued' || r.status === 'running') {
          // orphaned row (no live execution): close it
          const u = ctx.store.updateRun(id, { status: 'canceled', reason: 'Canceled', endedAt: now().toISOString() })
          ctx.emit({ type: 'run.updated', run: u })
        }
      },
      rerun(id) {
        const r = ctx.store.getRun(id)
        if (!r) throw new HiveError('not_found', `Run ${id} not found`)
        return startRun(r.target, { trigger: 'rerun', parentRunId: id, scheduleId: null, ...rerunCompany(r) })
      },
      retryAt(id, at) {
        const r = ctx.store.getRun(id)
        if (!r) throw new HiveError('not_found', `Run ${id} not found`)
        if (r.status === 'queued' || r.status === 'running') throw new HiveError('conflict', 'The run is still going')
        if (r.retryRunId) throw new HiveError('conflict', 'This run was already retried')
        if (at !== null && !Number.isFinite(Date.parse(at))) throw new HiveError('bad_request', 'Invalid retry time')
        const u = ctx.store.updateRun(id, { retryAt: at })
        ctx.emit({ type: 'run.updated', run: u })
        return u
      },
      liveSpawnIds: () => [...executions.values()].flatMap((e) => e.runningStepIds()),
      active
    },

    scheduler: {
      start: () => scheduler.start(),
      stop: () => scheduler.stop(),
      upsert: (id) => scheduler.upsert(id),
      remove: (id) => scheduler.remove(id),
      runNow: (id) => scheduler.runNow(id),
      fireNow: (id) => scheduler.fireNow(id),
      preview: (when) => previewWhen(when, now()),
      describe: (when) => describeWhen(when),
      nextRuns: (limit) => scheduler.nextRuns(limit),
      setPaused: (p) => scheduler.setPaused(p),
      catchUp: (reason) => scheduler.catchUp(reason),
      skipNext: (id) => scheduler.skipNext(id)
    },

    ...(slackTriggers
      ? {
          slackTriggers: {
            start: () => {
              if (process.env.HIVE_NO_SCHEDULER === '1') return
              slackTriggers!.start()
            },
            stop: () => slackTriggers!.stop(),
            reload: () => slackTriggers!.reload(),
            test: (t, sample) => slackTriggers!.test(t, sample)
          }
        }
      : {})
  }
}

export const createEngine: CreateEngine = (ctx) => createEngineWith(ctx)

/** All adapter ids, re-exported for main's seeding (one default profile per available adapter). */
export const ENGINE_ADAPTERS = ADAPTER_IDS
