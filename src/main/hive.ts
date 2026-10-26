/**
 * Hive main-process core: owns store, vault, engine, sessions, indexer, window, tray and the status snapshot.
 * IPC handlers (src/main/handlers) and the bootstrap (index.ts) operate on this object.
 */
import os from 'node:os'
import { app, dialog, powerSaveBlocker } from 'electron'
import type { CompanyStore } from './company'
import { createCompanyBridge } from './companyBridge'
import { Dispatcher, HookedCompanyStore, pauseAllAgents, taskRunBridge } from './company/dispatcher'
import { recurringBoards } from './company/recurring'
import { departmentsEnabled, PERSONAL_COMPANY_ID } from '../shared/company'
import { activeByCompany } from './statusCounts'
import { chatPlacement, type ChatPlacement } from './company/chatContext'
import { routeModelCall } from './company/routeCall'
import type { CompanyBridge, Engine, ProcessReaper, StepOutputEvent, TaskRunBridge, TaskToolset } from '../shared/engine'
import type { AdapterId, EngineEvent, Id, LeftoverProcess, NextFire, Run, Settings, StatusSnapshot } from '../shared/types'
import { HiveError } from '../shared/errors'
import type { UiCommand } from '../shared/ipc'
import type { DB } from './db'
import type { Store } from './db/store'
import { seedProfiles, seedWorkflows } from './db/seed'
import { seedWorkflows as seedDrafts } from './engine'
import type { HivePaths } from './paths'
import type { Vault } from './vault'
import type { SessionManager } from './sessions'
import type { ArtifactIndexer } from './artifacts'
import type { WindowManager } from './windowManager'
import type { HiveTray } from './tray'
import type { MemoryService } from './memory/service'
import type { TrayAction, TrayInput, TrayRunning } from './trayModel'
import { emit } from './ipc'
import { log } from './log'
import { notify, shouldNotifyRun } from './notify'
import type { LiveStore } from './db/liveStore'
import type { SessionLiveHub } from './live/sessionLive'
import type { LiveEmit } from './live/apply'
import { NeedsYouNotifier } from './live/asks'
import type { AgentNode, Ask } from '../shared/live'
import { retryTime, type LimitHit } from './engine'
import type { AuthorBroker } from './author/broker'
import type { WorktreeManager } from './worktrees'
import type { NotifyNode } from './notifyNode'
import type { ClaudeHistory } from './history'
import type { SlackService } from './connectors/slack/service'
import type { ForumService } from './forum/service'
import type { DashboardService } from './dashboards/service'
import { createCloud, type CloudWiring } from './cloud/wire'

/** "15:00" today, else "Tue 15:00" (notification copy). */
export function clockLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`
}

const TERMINAL = new Set(['passed', 'failed', 'canceled'])
const OUTPUT_COALESCE_MS = 50

export class Hive {
  private companyStore: HookedCompanyStore | null = null
  /** DEPARTMENTS.md §3: the store tells the dispatcher about every task write (routing on create, wakes on comments). */
  get company(): CompanyStore {
    return (this.companyStore ??= new HookedCompanyStore(this.store, this.paths?.companiesRoot ? { companiesRoot: this.paths.companiesRoot } : {}))
  }
  /**
   * DEPARTMENTS.md §3: the board's dispatcher (null until startDispatcher, which runs after CompanyStore.reconcile).
   * The board handlers reach openSession / takeover / stop / pump through it.
   */
  dispatcher: Dispatcher | null = null
  /** §6: the hivetask toolset factory for headless task steps (set by the hivetask wiring; null = no tools, fenced report only). */
  taskToolset: ((req: Parameters<NonNullable<TaskRunBridge['toolset']>>[0]) => TaskToolset | null) | null = null
  engine!: Engine
  sessions!: SessionManager
  indexer!: ArtifactIndexer
  windows!: WindowManager
  tray: HiveTray | null = null
  private memoryService: MemoryService | null = null
  /**
   * Shared memory (memory.db); null if it could not be opened. COMPANY.md C4 / PASSPORT.md §7.5: setting it injects
   * the CompanyStore, so grants resolve and bind their company through the one resolver (scope.ts).
   */
  get memory(): MemoryService | null {
    return this.memoryService
  }
  set memory(m: MemoryService | null) {
    this.memoryService = m
    const inject = (m as { setCompanies?: (c: CompanyStore) => void } | null)?.setCompanies
    if (m && inject) this.safe(() => inject.call(m, this.company), undefined)
  }
  /** PASSPORT.md §7.6: called when an agent step ends (the harvester registers here). Must not throw or block. */
  stepOutputHooks: ((e: StepOutputEvent) => void)[] = []
  rebuildMenu: () => void = () => {}
  /** Live agents (LIVE.md): agents/asks repository, session wiring, notifications. */
  live!: LiveStore
  sessionLive!: SessionLiveHub
  /** CHAT-UI.md §3: Claude sessions shown as a chat (absent in tests and before boot) */
  chats?: import('./chat/chatHub').ChatHub
  notifier!: NeedsYouNotifier
  /** What the renderer shows (ui:visibleOwner): suppresses notifications, marks idle sessions seen (A3). */
  visibleOwner: { sessionId: Id | null; runId: Id | null } = { sessionId: null, runId: null }
  private lastBadge = ''
  /** Spawn tagging + reaper (CONTRACT §13), shared with the engine. */
  reaper: ProcessReaper | null = null
  /** CONTRACT §13: pending session resumes ("Retry at reset"), by session id. */
  private sessionRetries = new Map<Id, NodeJS.Timeout>()
  /** CONTRACT §13: one "Stalled?" notification per stall episode (root id + start). */
  private stallNotified = new Set<string>()
  /** CONTRACT §13: one usage-limit notification per session episode. */
  private limitNotified = new Set<Id>()
  private leftoverCache: LeftoverProcess[] = []
  /** AUTHORING.md: `hive` tool broker, worktree per run, notify nodes, Claude history (null until wired / on failure). */
  author: AuthorBroker | null = null
  /** shared/chatCompany.ts: the "start a company from this chat" cards (author/wire.ts). */
  chatProposals: import('./company/chatProposals').ChatProposals | null = null
  worktrees: WorktreeManager | null = null
  /** WORKTREE.md: a task's own worktree, branch and PR (company/taskWork.ts; null until wired) */
  taskWork: import('./company/taskWork').TaskWorkService | null = null
  notifyNode: NotifyNode | null = null
  history: ClaudeHistory | null = null
  /** SLACK.md: the Slack connector service (null until wired / on failure). */
  gateway: import('./gateway/service').GatewayService | null = null
  slack: SlackService | null = null
  /** FORUM.md: the company Forum (null until wired / on failure). */
  forum: ForumService | null = null
  /** DASHBOARDS.md: department dashboards (null until wired / on failure). */
  dashboards: DashboardService | null = null
  /** LINEAR.md: optional Linear sync per company (null until wired / on failure). */
  linear: import('./company/sync/service').LinearSyncService | null = null
  /** REMOTE.md: Phone (off at every launch; null until wired / on failure). */
  remote: import('./remote/service').RemoteService | null = null
  private cloudWiring: CloudWiring | null = null
  /** CLOUD.md §4.1: this Mac's link to a Principia Cloud workspace (built on first use; idle until paired). */
  get cloud(): CloudWiring {
    return (this.cloudWiring ??= createCloud(this))
  }
  /** The `hive` server spec factory for interactive claude sessions (author/wire.ts). */
  authorAttach: { server(sessionId: Id, liveDir: string, companyId?: Id | null): import('../shared/engine').McpServerSpec | null; tools: string[]; spawnDir: string } | null = null
  /** Called on every run.updated (raw engine run), before the renderer hears about it. Must not throw or block. */
  runHooks: ((run: Run) => void)[] = []
  private approvalNotified = new Set<Id>()

  private unseenFailures = 0
  private lastFailure: { runId: Id; title: string; endedAt: string } | null = null
  private notifiedRuns = new Set<Id>()
  private statusTimer: NodeJS.Timeout | null = null
  private blockerId: number | null = null
  private outBuf = new Map<string, { runId: Id; stepId: Id; chunk: string; timer: NodeJS.Timeout }>()
  private shuttingDown = false
  shutdownDone = false
  forceQuit = false

  constructor(
    readonly db: DB,
    readonly store: Store,
    readonly vault: Vault,
    readonly paths: HivePaths
  ) {}

  // ---------- safe engine access (engine is built in parallel; never let a stub crash the shell) ----------
  safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  settings(): Settings {
    return this.store.getSettings()
  }

  // ---------- companies (COMPANY.md §5, §6) ----------
  /** The engine's and sessions' view of the company module: one resolver, one guard switch (experimental.companies). */
  companyBridge(): CompanyBridge {
    return {
      ...createCompanyBridge(this.company, this.store),
      // DEPARTMENTS.md §4.3: task runs inherit the task's company, take the seat's time cap and report their session id
      tasks: taskRunBridge({
        company: () => this.company,
        dispatcher: () => this.dispatcher,
        toolset: () => this.taskToolset,
        passport: (companyId, departmentId) => this.passportContext('', companyId, departmentId),
        workdir: (e) => this.taskWork?.workdir(e.taskId) ?? Promise.resolve(null)
      }),
      // §8: task-mode schedules and Slack triggers comment on their card and wake through the dispatcher (queued until it exists)
      boards: recurringBoards({
        company: () => this.company,
        dispatcher: () => this.dispatcher,
        enabled: () => departmentsEnabled(this.settings().experimental)
      })
    }
  }

  // ---------- the company board (DEPARTMENTS.md §3, §4.4) ----------
  /**
   * Builds the dispatcher once: hooks the company store, listens to run ends, starts the 60 s tick and pumps every
   * company (the boot trigger). Call after CompanyStore.reconcile() (registerCompanyHandlers) so interrupted tasks are
   * parked before the first pump; they are never rerun.
   */
  startDispatcher(): Dispatcher {
    if (this.dispatcher) return this.dispatcher
    const company = this.company as HookedCompanyStore
    const d = new Dispatcher({
      company,
      startRun: (target, opts) => this.engine.runs.start(target, opts),
      cancelRun: (id) => this.engine.runs.cancel(id),
      enabled: () => departmentsEnabled(this.settings().experimental),
      sessions: {
        // WORKTREE.md: a Started task opens as a session in its own worktree, never the founder's checkout
        create: ({ taskId, ...req }) => {
          const cwd = taskId ? this.taskWork?.sessionCwd(taskId) : null
          return this.sessions.create(cwd ? { ...req, repoId: null, cwd } : req)
        },
        isLive: (id) => this.sessions.isLive(id),
        kill: (id) => this.sessions.kill(id)
      },
      onChange: () => {
        emit('data:changed', { domain: 'tasks' })
        this.statusChanged()
      },
      // §2 step 4: triage suggestions through the installed Claude CLI (off without one)
      modelCall: () => this.safe(() => routeModelCall({ providers: () => this.engine.providers.cached() }), null),
      redact: (t) => this.vault.redact(t),
      log
    })
    this.dispatcher = d
    company.hooks = d.hooks()
    this.runHooks.push((run) => d.onRunUpdated(run))
    void d.start().catch((e) => log.warn('dispatcher boot pump failed', { e: String(e) }))
    return d
  }

  /** Rail "Pause all agents" (§3): autopilot off for every company. Works before the dispatcher exists. */
  pauseAllAgents(): string[] {
    if (this.dispatcher) return this.dispatcher.pauseAll()
    const ids = pauseAllAgents(this.company)
    if (ids.length) emit('data:changed', { domain: 'company' })
    return ids
  }

  /**
   * The Passport block of one spawn, redacted: the company's when known, else the cwd's company (older callers).
   * DEPARTMENTS.md §7: a task run passes its task's department, which adds the department slot.
   */
  passportContext(cwd: string, companyId?: Id | null, departmentId?: Id | null): string | null {
    const passport = companyId
      ? this.company.passportContextFor(companyId, departmentId ? { departmentId } : undefined)
      : cwd
        ? this.company.contextForDirectory(cwd)
        : null
    // DASHBOARDS.md §6: a department's runs and chats also read its dashboards' latest numbers (cached, read-only)
    const metrics = companyId && departmentId ? this.safe(() => this.dashboards?.contextFor(companyId, departmentId) ?? null, null) : null
    const text = [passport, metrics].filter(Boolean).join('\n\n')
    return text ? this.vault.redact(text) : null
  }
  /**
   * DEPARTMENTS.md §9 (SessionDeps.chat): where a company or department chat runs, the company repo folders it may
   * reach and its brief. Personal keeps its chats in its workspace (its repos are every unowned folder on this Mac).
   * null = the department is not this company's, or the board is off.
   */
  chatContext(req: { companyId: Id; departmentId: Id | null; adapter: AdapterId }): ChatPlacement | null {
    const c = this.company
    let company: ReturnType<CompanyStore['passport']>
    try {
      company = c.passport(req.companyId)
    } catch {
      return null
    }
    const boardOn = departmentsEnabled(this.settings().experimental)
    if (req.departmentId && !boardOn) return null
    const personal = company.id === PERSONAL_COMPANY_ID || company.system === 'personal'
    const repos = personal
      ? []
      : company.repoIds.flatMap((id) => {
          const r = this.store.getRepo(id)
          return r ? [{ id: r.id, name: r.name, path: r.path, exists: r.exists }] : []
        })
    const placed = chatPlacement({
      company: { id: company.id, name: company.name },
      repos,
      departments: boardOn ? c.departments.list(company.id) : [],
      agents: boardOn ? c.departments.listAgents({ companyId: company.id }) : [],
      tasks: boardOn && req.departmentId ? c.listTasks(company.id) : [],
      departmentId: req.departmentId,
      // the `hive` server (claude panes) lists company_file_task while the board is on
      fileTool: boardOn && req.adapter === 'claude',
      // PROACTIVE.md §2
      proactive: this.settings().proactiveAgents !== false
    })
    if (req.departmentId && !placed.department) return null
    return placed
  }

  /** EngineContext.onStepOutput: fans out to stepOutputHooks; one failing hook never affects the others or the run. */
  onStepOutput(e: StepOutputEvent): void {
    for (const fn of this.stepOutputHooks) {
      try {
        fn(e)
      } catch (err) {
        log.warn('step output hook failed', { runId: e.runId, stepId: e.stepId, e: String(err) })
      }
    }
  }

  // ---------- status ----------
  status(): StatusSnapshot {
    const active = this.store.listRuns({ status: ['queued', 'running'], limit: 1000 })
    const s = this.settings()
    // five doors: "Next" is per company, and a paused company has none (its schedules hold until it resumes)
    const byCompany: Record<Id, NextFire> = {}
    let next: NextFire | null = null
    if (!s.schedulesPaused) {
      const companyOf = new Map(this.safe(() => this.store.listSchedules(), []).map((x) => [x.id, (x as { companyId?: Id | null }).companyId || PERSONAL_COMPANY_ID]))
      for (const n of this.safe(() => this.engine.scheduler.nextRuns(500), [])) {
        const co = companyOf.get(n.scheduleId) ?? PERSONAL_COMPANY_ID
        if (this.safe(() => this.company.isPaused(co), false)) continue
        next ??= n
        byCompany[co] ??= n
      }
    }
    return {
      runningSessions: this.sessions.runningCount(),
      runningRuns: active.filter((r) => r.status === 'running').length,
      queuedRuns: active.filter((r) => r.status === 'queued').length,
      schedulesPaused: s.schedulesPaused,
      nextFire: next,
      nextFireByCompany: byCompany,
      last24h: this.store.countEndedSince(new Date(Date.now() - 86400_000).toISOString()),
      last24hByCompany: this.safe(() => this.store.countEndedSinceByCompany(new Date(Date.now() - 86400_000).toISOString()), {}),
      activeByCompany: this.safe(() => activeByCompany(active, this.sessions.liveCountByCompany()), {}),
      unseenFailures: this.unseenFailures,
      needsYou: this.live ? this.safe(() => this.live.needsYouCount(), 0) : 0
    }
  }

  // ---------- live agents (LIVE.md §4.5, §9.4) ----------
  initLive(): void {
    this.notifier = new NeedsYouNotifier({
      notify: (n) =>
        // Settings › Notifications › "Tell me when something needs me" (Needs you still lists it either way)
        this.settings().notifyNeedsYou !== false &&
        notify({
          title: n.title,
          body: n.body,
          sound: this.settings().notificationSound,
          onClick: () => this.windows.command({ kind: 'focusAgent', agentId: n.agentId })
        }),
      focused: () => this.safe(() => this.windows.isFocused(), false),
      visible: () => this.visibleOwner,
      rootTitle: (rootId) => this.rootTitle(rootId),
      isOpen: (askId) => this.live.getAsk(askId)?.status === 'open'
    })
  }

  /** "<session title>" or "<run title> › <node>". */
  rootTitle(rootId: Id): string {
    const a = this.live.getAgent(rootId)
    if (!a) return 'An agent'
    if (a.runId) {
      const run = this.store.getRun(a.runId)
      return run ? `${run.title} › ${a.title}` : a.title
    }
    return a.title
  }

  /** Window focus or the visible owner changed. */
  setVisibleOwner(v: { sessionId?: Id | null; runId?: Id | null } | null): void {
    if (v) this.visibleOwner = { sessionId: v.sessionId ?? null, runId: v.runId ?? null }
    this.safe(() => this.sessionLive.visibilityChanged(), undefined)
  }

  /** Session pane visible AND window focused (A3). */
  sessionVisible(sessionId: Id): boolean {
    return this.visibleOwner.sessionId === sessionId && this.safe(() => this.windows.isFocused(), false)
  }

  /** Live events from the engine (run steps) or SessionLive (sessions): renderer, notifications, badge. */
  onLiveEvent(e: LiveEmit): void {
    switch (e.type) {
      case 'agent.updated':
        emit('agent:updated', e.agent)
        if (e.agent.parentId === null) {
          this.statusChanged()
          this.onRootStall(e.agent)
          // SLACK.md §11.4: a Slack-started session finished its turn -> report in its thread
          if (e.agent.sessionId) this.safe(() => this.slack?.onAgentUpdated(e.agent), undefined)
        }
        return
      case 'agent.events':
        emit('agent:events', { agentId: e.agentId, events: e.events })
        return
      case 'ask.updated':
        emit('ask:updated', e.ask)
        this.onAskChanged(e.ask)
        this.statusChanged()
        return
    }
  }

  // ---------- CONTRACT §13: Stalled?, usage limits, retry at reset, leftovers ----------

  /** One notification per stall episode. Never kills anything. */
  private onRootStall(a: AgentNode): void {
    if (!a.stalledSince) return
    if (a.status !== 'working' && a.status !== 'starting') return
    const key = `${a.id}|${a.stalledSince}`
    if (this.stallNotified.has(key)) return
    this.stallNotified.add(key)
    if (this.stallNotified.size > 500) this.stallNotified = new Set([...this.stallNotified].slice(-200))
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(a.stalledSince)) / 60_000))
    notify({
      title: `${this.rootTitle(a.id)} may be stalled`,
      body: `No output for ${mins} min. Hive won't stop it; open it to check.`,
      sound: this.settings().notificationSound,
      onClick: () => this.windows.command({ kind: 'focusAgent', agentId: a.id })
    })
  }

  /** A session's CLI hit a usage limit: one notification per episode. */
  onSessionLimit(root: AgentNode, hit: LimitHit): void {
    if (!root.sessionId || this.limitNotified.has(root.sessionId)) return
    this.limitNotified.add(root.sessionId)
    notify({
      title: `${root.title} hit the usage limit`,
      body: hit.resetAt ? `Resets ${clockLabel(hit.resetAt)}. Retry at reset from Hive.` : hit.message,
      sound: this.settings().notificationSound,
      onClick: () => this.windows.command({ kind: 'focusAgent', agentId: root.id })
    })
  }

  /** The episode ended (user typed, new turn, pane exited): drop a pending resume and allow the next notification. */
  onSessionLimitCleared(sessionId: Id): void {
    this.limitNotified.delete(sessionId)
    const t = this.sessionRetries.get(sessionId)
    if (t) clearTimeout(t)
    this.sessionRetries.delete(sessionId)
  }

  /** sessions:retry (CONTRACT §13): 'now' types "continue"; 'reset' does that at the reset time; 'cancel' drops it. */
  sessionRetry(sessionId: Id, when: 'now' | 'reset' | 'cancel'): void {
    const s = this.sessionLive.live(sessionId)
    if (!s || !this.sessions.isLive(sessionId)) throw new HiveError('conflict', 'This session has ended')
    const pending = this.sessionRetries.get(sessionId)
    if (pending) clearTimeout(pending)
    this.sessionRetries.delete(sessionId)
    if (when === 'cancel') return s.setRetryAt(null)
    if (when === 'now') return s.resume()
    if (!s.isLimited()) throw new HiveError('conflict', 'This session is not waiting on a usage limit')
    const at = retryTime(this.live.getAgent(s.root.id)?.resetAt ?? null, new Date())
    s.setRetryAt(at)
    // setTimeout caps at ~24.8 days; a reset is hours away
    const ms = Math.min(2_147_000_000, Math.max(0, Date.parse(at) - Date.now()))
    const t = setTimeout(() => {
      this.sessionRetries.delete(sessionId)
      const live = this.sessionLive.live(sessionId)
      if (!live || !this.sessions.isLive(sessionId) || !live.isLimited()) return
      try {
        live.resume()
        log.info('session resumed at usage-limit reset', { sessionId })
      } catch (e) {
        log.warn('session resume failed', { sessionId, e: String(e) })
      }
    }, ms)
    t.unref?.()
    this.sessionRetries.set(sessionId, t)
  }

  /** runs:retryAt (CONTRACT §13). */
  runRetry(runId: Id, when: 'reset' | 'cancel'): Run {
    const run = this.store.getRun(runId)
    if (!run) throw new HiveError('not_found', 'Run not found')
    if (!this.engine.runs.retryAt) throw new HiveError('internal', 'Retry at reset is not available yet')
    const at = when === 'cancel' ? null : retryTime(run.resetAt ?? null, new Date())
    return this.engine.runs.retryAt(runId, at)
  }

  /** Step roots of a rate-limited run show its pending retry (mirror of run.retryAt until it fires). */
  private mirrorRunRetry(run: Run): void {
    if (run.stopReason !== 'rate_limited' || !this.live) return
    const want = run.retryRunId ? null : (run.retryAt ?? null)
    for (const a of this.safe(() => this.live.listAgents({ runId: run.id, rootsOnly: true, limit: 200 }), [])) {
      if (a.stopReason !== 'rate_limited' || (a.retryAt ?? null) === want) continue
      const u = this.safe(() => this.live.updateAgent(a.id, { retryAt: want }), null)
      if (u) emit('agent:updated', u)
    }
  }

  /** Owners whose tagged processes are not leftovers: live sessions and running steps. */
  private liveSpawnIds(): Set<string> {
    return new Set([...this.sessions.liveIds(), ...this.safe(() => this.engine.runs.liveSpawnIds?.() ?? [], [])])
  }

  /** processes:leftovers (CONTRACT §13). Listed only; Hive never kills these on its own. */
  async leftovers(): Promise<LeftoverProcess[]> {
    if (!this.reaper) return []
    const now = Date.now()
    const rows = await this.reaper.leftovers(this.liveSpawnIds())
    this.leftoverCache = rows.map((r) => ({
      pid: r.pid,
      spawnId: r.spawnId,
      command: this.vault.redact(r.command).slice(0, 300),
      cwd: r.cwd,
      ageMs: r.etimeMs,
      startedAt: new Date(now - r.etimeMs).toISOString()
    }))
    return this.leftoverCache
  }

  /** processes:stop: re-verified leftovers only, whole trees; then the fresh list goes out. */
  async stopLeftovers(pids: number[]): Promise<number> {
    if (!this.reaper) return 0
    const n = await this.reaper.stopLeftovers(pids, this.liveSpawnIds())
    log.info('stopped leftover processes', { requested: pids.length, signalled: n })
    emit('processes:changed', await this.leftovers())
    return n
  }

  /** Launch: list (never kill) what an earlier Hive run left behind. */
  async scanLeftovers(): Promise<void> {
    try {
      const l = await this.leftovers()
      if (l.length) log.info('leftover processes from an earlier Hive run', { count: l.length, pids: l.map((x) => x.pid) })
      emit('processes:changed', l)
    } catch (e) {
      log.warn('leftover scan failed', { e: String(e) })
    }
  }

  private onAskChanged(a: Ask): void {
    if (a.kind === 'approval') return this.onApprovalAsk(a)
    if (a.kind === 'slack_reply') return this.onSlackDraftAsk(a)
    if (a.status === 'open') this.slack?.mirrorAsk(a, this.rootTitle(a.rootId))
    if (!this.notifier) return
    if (a.status === 'open') this.notifier.askOpened(a)
    else this.notifier.askResolved(a)
  }

  /**
   * AUTHORING.md §2.2 / CONTRACT §14.6: one notification per approval card, suppressed while the user looks at the pane
   * that asked (the card is pinned there). Click -> openApproval.
   */
  private onApprovalAsk(a: Ask): void {
    if (a.status !== 'open' || !a.draftId || this.approvalNotified.has(a.id)) return
    this.approvalNotified.add(a.id)
    if (this.approvalNotified.size > 500) this.approvalNotified = new Set([...this.approvalNotified].slice(-200))
    if (a.sessionId && this.sessionVisible(a.sessionId)) return
    const draftId = a.draftId
    notify({
      title: a.title.startsWith('Run') ? 'Claude wants to run a workflow' : a.title.startsWith('Update') ? 'Claude wants to update a workflow' : 'Claude wants to create a workflow',
      body: (a.question ?? a.title).slice(0, 200),
      sound: this.settings().notificationSound,
      onClick: () => this.windows.command({ kind: 'openApproval', draftId })
    })
  }

  /** SLACK.md §8.3: one notification per Slack draft card (suppressed while the user looks at its pane); mirrored to Slack DM when on. */
  private slackNotified = new Set<Id>()
  private onSlackDraftAsk(a: Ask): void {
    if (a.status !== 'open' || !a.slackDraftId || this.slackNotified.has(a.id)) return
    this.slackNotified.add(a.id)
    if (this.slackNotified.size > 500) this.slackNotified = new Set([...this.slackNotified].slice(-200))
    this.slack?.mirrorAsk(a, this.rootTitle(a.rootId))
    if (a.sessionId && this.sessionVisible(a.sessionId)) return
    const draftId = a.slackDraftId
    notify({
      title: a.title,
      body: (a.question ?? '').slice(0, 200),
      sound: this.settings().notificationSound,
      onClick: () => this.windows.command({ kind: 'openSlackDraft', draftId })
    })
  }

  private updateBadge(s: StatusSnapshot): void {
    const k = s.needsYou ?? 0
    const badge = k > 0 ? String(k) : ''
    if (badge === this.lastBadge) return
    this.lastBadge = badge
    this.safe(() => app.dock?.setBadge(badge), undefined)
  }

  /** Coalesced: emits status:changed, refreshes tray and the keep-awake blocker. */
  statusChanged(): void {
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      // §4.4: a session that closed while holding a task parks it (no_report); session changes land here
      this.safe(() => this.dispatcher?.checkSessions(), undefined)
      const s = this.status()
      emit('status:changed', s)
      this.tray?.update()
      this.updateKeepAwake(s)
      this.updateBadge(s)
    }, 100)
  }

  private updateKeepAwake(s: StatusSnapshot): void {
    const active = s.runningSessions + s.runningRuns + s.queuedRuns > 0
    const want = active && this.settings().keepAwake
    if (want && this.blockerId === null) this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
    else if (!want && this.blockerId !== null) {
      powerSaveBlocker.stop(this.blockerId)
      this.blockerId = null
    }
  }

  clearUnseen(): void {
    if (this.unseenFailures === 0) return
    this.unseenFailures = 0
    this.lastFailure = null
    this.statusChanged()
  }

  trayInput(): TrayInput {
    const running: TrayRunning[] = []
    for (const s of this.store.listSessions('running')) {
      if (!this.sessions.isLive(s.id)) continue
      running.push({ kind: 'session', id: s.id, label: s.title, startedAt: s.startedAt })
    }
    for (const r of this.store.listRuns({ status: ['running', 'queued'], limit: 20 })) {
      const d = this.store.getRunDetail(r.id)
      const step = d?.steps.filter((x) => x.status === 'running').pop()
      const where = step ? ` · ${step.nodeId}${step.attempt > 1 ? ` #${step.attempt}` : ''}` : r.status === 'queued' ? ' · queued' : ''
      running.push({ kind: 'run', id: r.id, label: `${r.title}${where}`, startedAt: r.startedAt })
    }
    const needsYou: { agentId: Id; label: string }[] = []
    if (this.live) {
      for (const a of this.safe(() => this.live.listOpenAsks(), [])) needsYou.push({ agentId: a.agentId, label: `${this.rootTitle(a.rootId)}: ${a.title}`.slice(0, 80) })
      for (const r of this.safe(() => this.live.unseenIdleRoots(), [])) needsYou.push({ agentId: r.id, label: `${r.title}: your turn`.slice(0, 80) })
    }
    return {
      status: this.status(),
      running,
      lastFailure: this.lastFailure,
      recentRepos: this.store.recentRepos(5).map((r) => ({ id: r.id, name: r.name })),
      now: new Date(),
      needsYou,
      slackAutoPaused: this.slack?.connector.isConfigured() ? !!this.settings().slackAutoPaused : null
    }
  }

  onTrayAction(a: TrayAction): void {
    switch (a.kind) {
      case 'open':
        this.windows.show()
        break
      case 'openSession':
        this.windows.command({ kind: 'openSession', sessionId: a.id })
        break
      case 'openRun':
        this.windows.command({ kind: 'openRun', runId: a.id })
        break
      case 'newSession':
        this.windows.command(a.repoId ? { kind: 'newSession', repoId: a.repoId } : { kind: 'newChat' })
        break
      case 'togglePause':
        this.updateSettings({ schedulesPaused: !this.settings().schedulesPaused })
        break
      case 'toggleSlackAutoPause':
        this.updateSettings({ slackAutoPaused: !this.settings().slackAutoPaused })
        break
      case 'quit':
        app.quit()
        break
      case 'focusAgent':
        this.windows.command({ kind: 'focusAgent', agentId: a.agentId })
        break
    }
  }

  ui(cmd: UiCommand): void {
    this.windows.command(cmd)
  }

  // ---------- settings (single write path with side effects) ----------
  readSettings(): Settings {
    const s = this.settings()
    const actual = this.safe(() => app.getLoginItemSettings().openAtLogin, s.launchAtLogin)
    if (actual !== s.launchAtLogin) return this.store.updateSettings({ launchAtLogin: actual })
    return s
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const before = this.settings()
    const after = this.store.updateSettings(patch)
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      try {
        app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin })
      } catch (e) {
        log.warn('setLoginItemSettings failed', { e: String(e) })
      }
    }
    if (patch.schedulesPaused !== undefined) {
      this.safe(() => this.engine.scheduler.setPaused(after.schedulesPaused), undefined)
      for (const sch of this.store.listSchedules()) emit('schedule:updated', sch)
      this.rebuildMenu()
    }
    // SLACK.md §10.3 / PO-S1: picking the alert user clears the suggestion; PO-S3e pause shows in the status
    if (patch.slackAlertUserId !== undefined || patch.slackAutoPaused !== undefined) this.slack?.connector.alertUserChanged()
    if (patch.slackAutoPaused !== undefined) this.tray?.update()
    emit('settings:changed', after)
    this.statusChanged()
    return after
  }

  // ---------- engine events -> renderer, tray, notifications, artifacts ----------
  onEngineEvent(e: EngineEvent): void {
    try {
      switch (e.type) {
        case 'run.updated':
          return this.onRunUpdated(e.run)
        case 'step.updated':
          emit('run:step', e.step)
          this.statusChanged()
          return
        case 'step.output':
          return this.bufferOutput(e.runId, e.stepId, e.chunk)
        case 'schedule.updated':
          emit('schedule:updated', this.store.getSchedule(e.schedule.id) ?? e.schedule)
          this.statusChanged()
          return
        case 'schedule.event':
          emit('schedule:fired', { event: e.event, scheduleName: e.scheduleName })
          this.onScheduleEvent(e.event.kind, e.scheduleName, e.event.slotAt, e.event.runId, e.event.message)
          this.statusChanged()
          return
        case 'providers.updated':
          emit('providers:changed', e.providers)
          this.ensureSeeds()
          return
        case 'agent.updated':
        case 'agent.events':
        case 'ask.updated':
          return this.onLiveEvent(e)
      }
    } catch (err) {
      log.error('engine event handling failed', { type: e.type, err: String(err) })
    }
  }

  private bufferOutput(runId: Id, stepId: Id, chunk: string): void {
    const cur = this.outBuf.get(stepId)
    if (cur) {
      cur.chunk += chunk
      return
    }
    const entry = {
      runId,
      stepId,
      chunk,
      timer: setTimeout(() => {
        this.outBuf.delete(stepId)
        emit('run:output', { runId, stepId, chunk: this.vault.redact(entry.chunk) })
      }, OUTPUT_COALESCE_MS)
    }
    this.outBuf.set(stepId, entry)
  }

  /** Window focused; false while no window exists yet (boot recovery runs before the window is created). */
  windowFocused(): boolean {
    return !!this.windows && this.safe(() => this.windows.isFocused(), false)
  }

  private onRunUpdated(raw: Run): void {
    for (const hook of this.runHooks) this.safe(() => hook(raw), undefined)
    // flush buffered output first so the renderer sees the last chunk before the final status
    for (const [stepId, b] of this.outBuf) {
      if (b.runId !== raw.id) continue
      clearTimeout(b.timer)
      this.outBuf.delete(stepId)
      emit('run:output', { runId: b.runId, stepId, chunk: this.vault.redact(b.chunk) })
    }
    if (TERMINAL.has(raw.status)) this.safe(() => this.indexer.rescan(raw.artifactsDir.replace(/\/$/, '')), undefined)
    const run = this.store.getRun(raw.id) ?? raw
    emit('run:updated', run)
    this.mirrorRunRetry(run)
    if (TERMINAL.has(run.status) && !this.notifiedRuns.has(run.id) && run.stopReason === 'rate_limited') {
      // CONTRACT §13: one notification for the whole run (parallel steps may all hit the limit), never a stream
      this.notifiedRuns.add(run.id)
      const s = this.settings()
      if (!this.windowFocused()) {
        this.unseenFailures++
        this.lastFailure = { runId: run.id, title: run.title, endedAt: run.endedAt ?? new Date().toISOString() }
      }
      if (s.notifyOnFailure) {
        const reset = run.resetAt ? `Resets ${clockLabel(run.resetAt)}` : 'Reset time unknown'
        notify({
          title: `${run.title} hit the usage limit`,
          body: run.retryAt ? `${reset} · retry scheduled ${clockLabel(run.retryAt)}` : `${reset}. Retry at reset from Hive.`,
          sound: s.notificationSound,
          onClick: () => this.windows.command({ kind: 'openRun', runId: run.id })
        })
      }
    }
    if (TERMINAL.has(run.status) && !this.notifiedRuns.has(run.id)) {
      this.notifiedRuns.add(run.id)
      if (run.status === 'failed') {
        // boot recovery fails interrupted runs before any window exists: treat "no window" as unfocused
        if (!this.windowFocused()) {
          this.unseenFailures++
          this.lastFailure = { runId: run.id, title: run.title, endedAt: run.endedAt ?? new Date().toISOString() }
        }
      }
      const s = this.settings()
      if (shouldNotifyRun(run, s)) {
        notify({
          title: run.status === 'failed' ? `${run.title} failed` : `${run.title} passed`,
          body:
            run.status === 'failed'
              ? (run.reason ?? 'The run failed.').slice(0, 200)
              : `${run.artifactCount ? `${run.artifactCount} artifact${run.artifactCount === 1 ? '' : 's'} · ` : ''}Finished ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          sound: s.notificationSound,
          onClick: () => this.windows.command({ kind: 'openRun', runId: run.id })
        })
      }
    }
    this.statusChanged()
  }

  private onScheduleEvent(kind: string, name: string, slotAt: string, runId: Id | null, message: string | null): void {
    if (kind !== 'missed' && kind !== 'caught_up' && kind !== 'skipped_overlap') return
    const s = this.settings()
    const time = new Date(slotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const title =
      kind === 'caught_up'
        ? `Running missed "${name}" from ${time}`
        : kind === 'missed'
          ? `"${name}" missed`
          : `"${name}" skipped`
    const body =
      kind === 'caught_up'
        ? 'Hive was not running or the Mac was asleep at that time.'
        : message ?? (kind === 'skipped_overlap' ? 'The previous run was still going.' : 'Hive was not running or the Mac was asleep.')
    notify({
      title,
      body,
      sound: s.notificationSound,
      onClick: () => this.windows.command(runId ? { kind: 'openRun', runId } : { kind: 'navigate', view: 'schedules' })
    })
  }

  /** Default profiles for newly available adapters + seed workflows once a builder profile exists. */
  ensureSeeds(): void {
    const providers = this.safe(() => this.engine.providers.cached(), [])
    const created = seedProfiles(this.store, providers)
    if (created.length) emit('data:changed', { domain: 'profiles' })
    const wfs = seedWorkflows(this.store, seedDrafts)
    if (wfs.length) emit('data:changed', { domain: 'workflows' })
  }

  // ---------- quit (Cmd+Q, tray Quit, app:quit) ----------
  /** before-quit: confirm if anything is running, then stop sessions + engine, then really quit. */
  async requestQuit(): Promise<void> {
    if (this.shuttingDown || this.shutdownDone) return
    const nS = this.sessions.runningCount()
    const nR = this.store.listRuns({ status: ['queued', 'running'], limit: 1000 }).length
    if (nS + nR > 0 && !this.forceQuit && process.env.HIVE_SMOKE !== '1') {
      const parts = [
        nS ? `${nS} session${nS === 1 ? '' : 's'}` : '',
        nR ? `${nR} run${nR === 1 ? '' : 's'}` : ''
      ].filter(Boolean)
      const win = this.windows.get()
      const opts = {
        type: 'warning' as const,
        message: `${parts.join(' and ')} will be stopped. Quit?`,
        detail: 'Exited Claude sessions can be resumed later with Restart.',
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      }
      const { response } = win && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response !== 0) return
    }
    this.shuttingDown = true
    this.windows.quitting = true
    // DEPARTMENTS.md §3: before the engine cancels its runs, so their run ends start nothing new during the quit
    this.dispatcher?.dispose()
    this.taskWork?.dispose()
    const timeout = new Promise<void>((r) => setTimeout(r, 6000))
    await Promise.race([
      Promise.all([
        this.sessions.shutdown().catch(() => undefined),
        this.safe(() => this.engine.shutdown(), Promise.resolve()).catch(() => undefined)
      ]),
      timeout
    ])
    this.safe(() => this.engine.scheduler.stop(), undefined)
    this.safe(() => this.engine.slackTriggers?.stop(), undefined)
    this.dispatcher?.dispose()
    // SLACK.md §2.3: close the socket with 1000, no retries
    await this.slack?.stop().catch(() => undefined)
    // REMOTE.md RA1: quitting is Turn off (tunnel, server, every phone signed out)
    await this.remote?.stop().catch(() => undefined)
    for (const t of this.sessionRetries.values()) clearTimeout(t)
    this.sessionRetries.clear()
    // CONTRACT §13: nothing tagged by this Hive outlives it (dev servers, watchers, leftovers nobody stopped)
    const reaped = this.safe(() => this.reaper?.reapAllSync() ?? 0, 0)
    if (reaped) log.info('reaped tagged processes on quit', { count: reaped })
    await this.indexer.stop().catch(() => undefined)
    this.tray?.destroy()
    if (this.blockerId !== null) powerSaveBlocker.stop(this.blockerId)
    this.memory?.stop()
    this.safe(() => (this.cloudWiring?.logins.cancel(), this.cloudWiring?.link.stop()), undefined)
    this.shutdownDone = true
    // Deferred: when requestQuit ran synchronously inside the first before-quit (nothing running, e.g. SIGTERM or
    // tray Quit), a nested app.quit() is overwritten by the outer, prevented quit and the app just hides instead of
    // exiting. A fresh task makes this a clean second quit. Hard exit if something still blocks it.
    setImmediate(() => app.quit())
    setTimeout(() => {
      log.warn('quit did not complete; forcing exit')
      app.exit(0)
    }, 3000)
  }

  /** SPEC A13: login launch starts hidden. */
  launchedAtLogin(): boolean {
    const li = this.safe(() => app.getLoginItemSettings(), null)
    if (li?.wasOpenedAtLogin) return true
    return this.settings().launchAtLogin && os.uptime() < 180
  }
}

