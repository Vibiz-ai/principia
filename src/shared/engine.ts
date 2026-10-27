/**
 * Engine boundary: what src/main gives the engine (EngineContext) and what src/main/engine/index.ts
 * exports (Engine). TYPE-ONLY. Main-process code only (renderer must not import this file).
 * Normative companion of docs/CONTRACT.md section 5.
 */
import type {
  AdapterId,
  AgentProfile,
  EngineEvent,
  ISODate,
  Id,
  NextFire,
  ProviderInfo,
  Repo,
  Run,
  RunDetail,
  RunStep,
  RunTarget,
  RunTrigger,
  Schedule,
  ScheduleEvent,
  SchedulePreview,
  ScheduleWhen,
  Settings,
  ValidationError,
  Workflow,
  WorkflowDraft
} from './types'
import type { MemoryTransport } from './memory'
import type { AgentEvent, AgentNode as LiveAgentNode, Ask, AskAnswer } from './live'
import type { NotifyResult } from './authoring'
import type { NotifySlackTarget, SlackInboundMessage, SlackRunContext, SlackTrigger, SlackTriggerEvent, SlackTriggerInput, SlackTriggerTestResult } from './slack'
import type { RunStatus, RunWorktree } from './types'
import type { ScheduleBoard, ScheduleFireResult } from '../main/engine/scheduler'
import type { SlackTaskBoard } from '../main/engine/slackTriggers'

export interface EnginePaths {
  userData: string // app.getPath('userData') or $HIVE_USER_DATA
  artifactsRoot: string // <userData>/artifacts
  runLogsDir: string // <userData>/logs/runs   (engine writes <runId>/<stepId>.log)
  scratchDir: string // <userData>/scratch    (cwd when node.cwd is null)
}

/** Persistence for engine-owned tables. Implemented by main (src/main/db/engineStore.ts). Synchronous (better-sqlite3). */
export interface EngineStore {
  /** `task`: DEPARTMENTS.md §1.2 runs.task_id / runs.agent_id of a task run (absent for every other run). */
  insertRun(run: Run, workflowSnapshot: WorkflowDraft | null, task?: RunTaskLink | null): void
  updateRun(id: Id, patch: Partial<Omit<Run, 'id'>>): Run
  getRun(id: Id): Run | null
  getRunDetail(id: Id): RunDetail | null
  /** Runs with status queued|running. */
  listActiveRuns(): Run[]
  /** CONTRACT §13: runs with a pending one-off retry (retryAt set, retryRunId null), soonest first. */
  listRetries?(): Run[]
  insertStep(step: RunStep): void
  updateStep(id: Id, patch: Partial<Omit<RunStep, 'id' | 'runId'>>): RunStep

  listSchedules(): Schedule[]
  getSchedule(id: Id): Schedule | null
  /** Engine-owned columns only. */
  setScheduleFireState(
    id: Id,
    patch: { lastFireAt?: ISODate | null; lastRunId?: Id | null; nextFireAt?: ISODate | null; enabled?: boolean; skipSlotAt?: ISODate | null }
  ): Schedule
  insertScheduleEvent(e: Omit<ScheduleEvent, 'id' | 'createdAt'>): ScheduleEvent

  // ---------- live agents (CONTRACT §12.3, LIVE.md §9.2). Text fields are redacted + capped by the store. ----------
  insertAgent?(a: LiveAgentNode): void
  updateAgent?(id: Id, patch: Partial<Omit<LiveAgentNode, 'id'>>): LiveAgentNode
  appendAgentEvents?(agentId: Id, events: Omit<AgentEvent, 'seq' | 'agentId'>[]): AgentEvent[]
  /** Updates the newest 'tool' event with that toolUseId (tool result). null if none. */
  updateAgentEvent?(agentId: Id, toolUseId: string, patch: Pick<AgentEvent, 'state' | 'detail'>): AgentEvent | null
  /** `gateId`: stdio request_id / hook gate id / mcp ask id (persisted, not part of the Ask shape). */
  insertAsk?(a: Ask & { gateId?: string | null }): void
  updateAsk?(id: Id, patch: Partial<Omit<Ask, 'id'>>): Ask
  listOpenAsks?(q: { runId?: Id; stepId?: Id }): Ask[]

  // ---------- Slack triggers (SLACK.md §9.3, CONTRACT Slack.3). Config is main's; the engine reads it and owns state/events. ----------
  /** Every trigger (enabled or not), with the computed fields. */
  listSlackTriggers?(): SlackTrigger[]
  getSlackTriggerState?(triggerId: Id, channelId: string, threadKey: string): SlackTriggerState | null
  /** Upsert; a state with no pending, no window, no active run and no fires in the last hour may be deleted. */
  putSlackTriggerState?(s: SlackTriggerState): void
  listSlackTriggerStates?(): SlackTriggerState[]
  insertSlackTriggerEvent?(e: Omit<SlackTriggerEvent, 'id' | 'createdAt'>): SlackTriggerEvent
}

/** slack_trigger_state row (SLACK.md §7.1). threadKey = thread_ts ?? ts in channels; 'dm:<channel_id>' in DMs (PO-S4). */
export interface SlackTriggerState {
  triggerId: Id
  channelId: string
  threadKey: string
  /** Batched message ts's waiting for the window (oldest first). */
  pending: string[]
  windowEndsAt: ISODate | null
  activeRunId: Id | null
  /** Fire times in the last 60 min (per-thread hourly cap). */
  firedAt: ISODate[]
}

export interface EngineLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

export interface EngineContext {
  /**
   * ORCHESTRATOR.md §1.1: Principia's context block and report contract for one non-shell step of a company run (a task
   * run or a seat run), on every harness. null = nothing to add (the layer is off, or the run is no agent's).
   */
  orchestrator?: { stepContext(req: OrchestratorStepRequest): string | null }
  /** COMPANY.md §6: `companyId` (the run's / session's company) limits the connections to that company's. */
  gateway?: { attachment(cwd: string, companyId?: Id | null, runId?: Id | null, secretNames?: readonly string[] | null): McpServerSpec | null }
  /** AUTOPILOT.md §6: a money autopilot's run loads only Principia's own MCP servers (outside calls go through the gateway). */
  autopilot?: { strictMcp(runId: Id): boolean }
  /**
   * BROWSER.md §3: the principia-browser MCP server for one claude / codex spawn of a company (its own token, bound to
   * that company's browser). null = no company, or the browser is off.
   */
  browser?: { attachment(req: { companyId: Id; agent: string; sessionKey: string }): McpServerSpec | null; toolNames(): string[] }
  /**
   * Company context for one spawn; never global chat context. COMPANY.md §5: with `companyId` it is that company's
   * Passport (passportContextFor); without it, the company of the working directory (older callers).
   */
  passportContext?(cwd: string, companyId?: Id | null, departmentId?: Id | null): string | null
  /** COMPANY.md §5, §6: company resolution and guards. Absent = no companies (tests, older main): nothing is stamped or checked. */
  company?: CompanyBridge
  /**
   * PASSPORT.md §7.6: called once when an agent step ends (any status), after the step row is persisted. The
   * harvester parses `<passport-notes>` from `output`. Must not throw or block; errors are logged and ignored.
   */
  onStepOutput?(e: StepOutputEvent): void
  paths: EnginePaths
  store: EngineStore
  /** Login-shell environment (resolved PATH, HOME, LANG...). No secrets. Fresh copy per call. */
  baseEnv(): Record<string, string>
  secrets: {
    /**
     * Decrypts the named secrets (['*'] = all) -> { NAME: value }. Unknown names are skipped. Marks lastUsedAt.
     * COMPANY.md §4: `companyId` overlays that company's keys on the shared ones ('*' = every shared key plus this
     * company's, never another company's). Absent = shared keys only.
     */
    resolve(names: string[], companyId?: Id | null): Record<string, string>
    /** Replaces every known secret value (len >= 4) with `••••NAME`. Apply to ALL persisted/streamed text. Global over every company. */
    redact(text: string): string
    /** Names (no values, no decryption) of the vault secrets a selection covers (['*'] = all). For the agent's keys hint. */
    names?(names: string[], companyId?: Id | null): string[]
  }
  getSettings(): Settings
  getProfile(id: Id): AgentProfile | null
  getRepo(id: Id): Repo | null
  /** Every repository added to Hive (exported to steps as HIVE_REPOS, newline-separated paths). */
  listRepos?(): Repo[]
  getWorkflow(id: Id): Workflow | null
  /** Main forwards to renderer (EventMap), tray, notifications. Call AFTER persisting. */
  emit(event: EngineEvent): void
  log: EngineLogger
  /** Injectable clock (tests). Defaults to () => new Date(). */
  now?: () => Date
  /** Shared memory (CONTRACT 11). Absent = memory disabled (tests / older main). */
  memory?: MemoryBridge
  /** Live agents I/O (LIVE.md §5): per-owner live dir, events.jsonl tailing, answer files. Absent = no live dirs. */
  live?: LiveBridge
  /**
   * Spawn tagging + reaper (CONTRACT §13): every step spawn carries reaper.tag(stepId) in its env, and its whole
   * process tree is killed when the step ends, is canceled or times out. Absent = group kill only (tests, older main).
   */
  reaper?: ProcessReaper
  /** AUTHORING.md §6 (CONTRACT §14.3): git worktree per run. Absent = isolated nodes fail "Worktrees are not available". */
  worktrees?: WorktreeBridge
  /** AUTHORING.md §7.2: notify nodes. Absent = notify nodes pass with note "Notifications are not available". */
  notifier?: NotifyBridge
  /** SLACK.md §9 (CONTRACT Slack.3): Slack triggers, reply binding, the slack toolset for headless claude. Absent = no Slack. */
  slack?: SlackBridge
  /** FORUM.md §3: Forum access for steps of runs with an agent seat. Absent = no Forum (tests, older main). */
  forum?: ForumBridge
  /**
   * CLOUD.md §7.8 (Principia Cloud): the user every step process starts as, so agents cannot read the control plane's
   * secrets. Absent or null = the engine's own user (the desktop).
   */
  spawnUser?(): { uid: number; gid: number } | null
}

// ---------- the Forum (FORUM.md §3, §4). The engine never imports src/main/forum/**. ----------

/** One step's Forum access: env (URL, token), the `forum` CLI dir for PATH, the MCP server and the brief block. */
export interface ForumSpawn {
  env: Record<string, string>
  /** folder holding the `forum` shim; prepended to PATH. null = no CLI */
  binDir: string | null
  /** the principia-forum stdio MCP server (claude, codex); null = none */
  server: McpServerSpec | null
  /** unprefixed tool names to pre-allow (forum_read…) */
  toolNames: string[]
  /** the <principia-forum> brief block, prefixed to the step prompt (not on a resumed turn) */
  prompt: string
}
/** Implemented by main (forum/service.ts). Members must not throw. */
export interface ForumBridge {
  open(req: { runId: Id; stepId: Id; taskId: Id | null; agentId: Id | null; adapter: AdapterId; companyId: Id | null }): ForumSpawn | null
  /** the step ended: the token expires, the shim folder goes */
  close(stepId: Id): void
}

// ---------- companies (COMPANY.md §5, §6). The engine never imports src/main/company/**. ----------

/** Implemented by main over CompanyStore (hive.ts companyBridge). */
export interface CompanyBridge {
  /**
   * The company of an owning entity, explicit id first, then run, session, workflow, schedule, repo, cwd; Personal
   * otherwise. not_found for an unknown explicit id or entity.
   */
  resolve(q: { companyId?: Id | null; runId?: Id | null; sessionId?: Id | null; workflowId?: Id | null; scheduleId?: Id | null; repoId?: Id | null; cwd?: string | null }): Id
  /** The refusal message when a repo, workflow or cwd belongs to a company other than `companyId`, else null. */
  crossCompany(companyId: Id, refs: { repoId?: Id | null; workflowId?: Id | null; cwd?: string | null }): string | null
  /** settings.experimental.companies: guards throw (true) or log a warning and still stamp (false). */
  enforced(): boolean
  /** `<userData>/companies/<slug>/workspace`, created if missing: the cwd of repo-less spawns. null = no company folders. */
  workspaceDir(companyId: Id): string | null
  /** Ids of the repos this company owns (Personal: every unowned repo). */
  repoIds(companyId: Id): Id[]
  /**
   * Five doors A4: the company's name while it is paused (a paused company starts nothing: no run, no schedule, no
   * retry), else null. Absent = no company pause (older main). Must not throw.
   */
  pausedName?(companyId: Id): string | null
  /** DEPARTMENTS.md §4.3: the board's view of task runs. Absent = no board (tests, older main). */
  tasks?: TaskRunBridge
  /** DEPARTMENTS.md §8: the board side of task-mode schedules and Slack triggers (company/recurring.ts). Absent = no board. */
  boards?: { schedules: ScheduleBoard; slack: SlackTaskBoard } | null
}

// ---------- the company board (DEPARTMENTS.md §3, §4, §6). The engine never imports src/main/company/**. ----------

/** A run started for a board task (StartRunOptions.taskId / agentId), persisted in runs.task_id / runs.agent_id. */
export interface RunTaskLink {
  taskId: Id
  agentId: Id | null
}
/** The hivetask toolset of one headless step: merged into the step's hivemem server (env) and its allowed tools. */
export interface TaskToolset {
  env: Record<string, string>
  /** unprefixed, like MemoryGrant.toolNames (task_get, task_report…) */
  toolNames: string[]
}
/** Implemented by main over CompanyStore and the dispatcher (hive.ts companyBridge). Every member must not throw. */
export interface TaskRunBridge {
  /** The task's company: a task run inherits it first (COMPANY.md §3 stamping order). null = unknown task. */
  companyOf(taskId: Id): Id | null
  /** The seat's limits.runMinutes, when StartRunOptions.runMinutes is absent. null = no cap. */
  runMinutes?(agentId: Id): number | null
  /** §6: the hivetask toolset for one step of a task run (claude only for now); null = none. */
  toolset?(req: { runId: Id; taskId: Id; agentId: Id | null; stepId: Id; adapter: AdapterId; companyId: Id | null }): TaskToolset | null
  /** §4.3: the provider conversation id of a task run's step, as soon as it is known (task.agentSessionId). */
  sessionCaptured?(e: { runId: Id; taskId: Id; adapter: AdapterId; agentSessionId: string }): void
  /** §3.6: the run hit limits.runMinutes and is about to be canceled; the task then parks with blocked(limit). */
  timeLimit?(e: { runId: Id; taskId: Id; minutes: number }): void
  /**
   * §7: the Passport block of a task run's spawn, with the task's department slot (redacted). When present it replaces
   * EngineContext.passportContext for task runs; null = nothing to say.
   */
  passportContext?(e: { taskId: Id; companyId: Id }): string | null
  /**
   * WORKTREE.md: a task Started into its own worktree runs every prompt turn there, with the push guard env. null = the
   * task has no worktree (the repo, as before). Rejects when the worktree cannot be made: the turn fails, it never
   * falls back to the founder's checkout.
   */
  workdir?(e: { taskId: Id; runId: Id }): Promise<{ cwd: string; env: Record<string, string> } | null>
}
/** §3.6: the in-band warning, about 2 minutes before a task run's time cap. */
export const TASK_WRAP_UP_MS = 2 * 60_000
export const TASK_WRAP_UP_TEXT =
  'Principia: about 2 minutes are left before this task run is stopped. Wrap up now: save your work and call task_report (or task_ask if you need the human).'

/** ORCHESTRATOR.md §1.1: one step asking for its Principia context. */
export interface OrchestratorStepRequest {
  runId: Id
  stepId: Id
  companyId: Id
  taskId: Id | null
  agentId: Id | null
  adapter: AdapterId
  /** a resumed conversation (it already holds the full block): only the inbox delta and the footer */
  resumed: boolean
  /** the step's $PRINCIPIA_RUN_REPORT file */
  reportPath: string
}

/** EngineContext.onStepOutput (PASSPORT.md §7.6). `output` is the step's final answer, already redacted. */
export interface StepOutputEvent {
  runId: Id
  stepId: Id
  nodeId: string
  adapter: AdapterId
  companyId: Id | null
  /** The memory mode the step asked for (after the Slack restriction); the harvester acts on 'read-write' only. */
  memory: 'off' | 'read' | 'read-write'
  /** How memory reached the agent: 'mcp' (it writes itself), 'inject' (brief only: harvest), null (no memory). */
  transport: MemoryTransport | null
  status: 'passed' | 'failed' | 'canceled'
  output: string
}

// ---------- Slack (SLACK.md §9, CONTRACT Slack.3). The engine never imports src/main/connectors/**. ----------

/** Implemented by main (connectors/slack/service.ts). */
export interface SlackBridge {
  connected(): boolean
  /** Live inbound messages (never backfill). Returns unsubscribe. */
  onMessage(cb: (m: SlackInboundMessage) => void): () => void
  /** `{{trigger.thread}}` text from the local mirror (≤ 50 msgs, 20,000 chars). DMs: the recent DM conversation. */
  threadTranscript(q: { channelId: string; threadTs: string }): string
  /**
   * (add-only, SLACK.md §9.6) Download the images people shared in the thread (DMs: the recent conversation) into
   * `destDir`; returns the local paths (≤ 5, newest first). Best effort: [] on any failure. Absent = no images.
   */
  downloadThreadImages?(q: { channelId: string; threadTs: string; destDir: string }): Promise<string[]>
  permalink(channelId: string, ts: string): Promise<string>
  resolveUserName(userId: string): string
  /** Post-run reply (replyNode). Main applies SLACK.md §8.2 using the run's SlackRunContext. threadTs null = top-level (DMs, PO-S4). */
  reply(req: { runId: Id; stepId: Id | null; channelId: string; threadTs: string | null; text: string; origin: 'reply_node' }): Promise<{
    status: 'posted' | 'drafted' | 'refused'
    draftId?: Id
    ts?: string
    reason?: string
  }>
  /** Slack drafts/posts the run already made through tools (reply binding skips when > 0). */
  repliesForRun(runId: Id): number
  /** `hive` server with HIVE_TOOLSETS=slack for a headless claude step, or null (not connected / not allowed). */
  toolServer(owner: { stepId: Id; runId: Id }): McpServerSpec | null
  /**
   * (add-only, AI) One local-mirror message, for `{{trigger.text}}` of a window that outlived a restart. Absent / null =
   * the text of messages received before the restart is unknown and left out.
   */
  message?(q: { channelId: string; ts: string }): { userId: string | null; userName: string | null; plain: string } | null
  /**
   * (add-only, AI) A Mac notification about a trigger (limit hit, start error). The engine already throttles it to one per
   * trigger per hour per kind. Absent = logged only.
   */
  alert?(a: { triggerId: Id; title: string; message: string }): void
}

// ---------- authoring (AUTHORING.md §6, §7.2; CONTRACT §14.3) ----------

/** Implemented by main (src/main/worktrees.ts). Git runs in main; the engine never imports it. */
export interface WorktreeBridge {
  /**
   * Creates (or returns the existing) worktree for this run. Rejects with a readable message on failure.
   * `dryRun`: the run's boolean dry_run input is true; the worktree's pre-push hook then refuses every push.
   */
  ensure(req: { runId: Id; workflowName: string; repo: string /* resolved absolute path */; base: string | null; dryRun?: boolean }): Promise<RunWorktree>
  /** Run ended: apply the keep/remove rules (PO6). Never throws. */
  finish(runId: Id, outcome: { status: RunStatus; nothingToDo: boolean }): Promise<RunWorktree | null>
  /**
   * PO5 push guard: env for every process of an isolated node (GIT_CONFIG_COUNT/KEY_0/VALUE_0 -> Hive's hooks dir,
   * plus HIVE_WORKTREE_* the hook reads). Merge last into the step env. Optional for older main.
   */
  guardEnv?(runId: Id): Record<string, string>
}
/** Implemented by main (src/main/notifyNode.ts). */
export interface NotifyBridge {
  /**
   * SLACK.md §10.1: `slack` is the target (null = Mac only). iMessage was removed (SA3).
   */
  send(req: { runId: Id; stepId: Id; title: string; message: string; slack: NotifySlackTarget | null }): Promise<NotifyResult>
}

// ---------- spawn tagging + reaper (CONTRACT §13) ----------

/** One row of the process table (ps). `env` = the raw env text `ps -E` showed, null when hidden or not captured. */
export interface ReaperRow {
  pid: number
  ppid: number
  pgid: number
  etimeMs: number
  command: string
  env: string | null
}
export interface ReaperLeftover {
  pid: number
  spawnId: string
  command: string
  cwd: string | null
  etimeMs: number
}
/** Implemented by src/main/engine/reaper.ts (Reaper); main creates one and shares it with the engine. */
export interface ProcessReaper {
  readonly userData: string
  /** { HIVE_SPAWN_ID: spawnId, HIVE_USER_DATA: userData }, merged last into every spawn's env (and hivemem's). */
  tag(spawnId: string): Record<string, string>
  /** An owner's leader started (descendants are sampled while it runs). */
  register(spawnId: string, rootPid: number | null | undefined): void
  /** The owner's tree right now; call before killing the leader. */
  collect(spawnId: string, rootPids?: number[]): Promise<ReaperRow[]>
  /** Kill the owner's whole tree (group + descendants + env-tagged), SIGTERM then SIGKILL. Never throws. */
  reap(spawnId: string, opts?: { rootPids?: number[]; pre?: ReaperRow[] }): Promise<number>
  /** Quit: SIGKILL every tagged process of this userData (sync). */
  reapAllSync(): number
  /** Tagged processes of this userData whose owner is not in `live` (and not Hive's own children). */
  leftovers(live: ReadonlySet<string>): Promise<ReaperLeftover[]>
  /** Stop those leftovers (re-verified first) and their trees. */
  stopLeftovers(pids: number[], live: ReadonlySet<string>): Promise<number>
}

// ---------- live agents (LIVE.md §5, PO amendments A1-A10) ----------

/** Owner of a live dir: a run step (engine) or an interactive session (main). */
export type LiveOwner = { stepId: Id; runId: Id } | { sessionId: Id }
export interface LiveChannel {
  /** <userData>/live/<ownerId>, created 0700. Holds events.jsonl, answers/, and the rendered per-spawn config. */
  dir: string
  /** Quoted base hook command (`ELECTRON_RUN_AS_NODE=1 '<exec>' '<hive-hook.js>' --events '<f>' --dir '<d>'`); the adapter appends `--provider <id>` and, for verified headless gates only, `--gate`. */
  hookCommand: string
  /** Env for the hivemem server process: { HIVE_LIVE_DIR: dir } (enables ask_user). */
  mcpEnv: Record<string, string>
  /** Parsed JSON lines appended to events.jsonl (hook lines `{v:1,provider,received_at,gate_id?,payload}` and hivemem `{hive:'ask_user'|'ask_user_cancelled'|'gate_closed',...}`). */
  onLine(cb: (line: unknown) => void): void
  /** Atomic write of answers/<gateId>.json (tmp + rename). */
  writeAnswer(gateId: string, payload: unknown): void
  /** Stop tailing and delete the dir. Idempotent. */
  close(): void
}
export interface LiveBridge {
  open(owner: LiveOwner): LiveChannel
}

// ---------- memory (CONTRACT 11.4, PO amendments 2026-10-16) ----------

/** The hivemem stdio MCP server, as each agent CLI must spawn it. */
export interface McpServerSpec {
  /** 'hive' = the authoring server (AUTHORING.md §1.1), interactive claude sessions only (PO1, PO7). */
  name: 'hivemem' | 'hive' | 'principia' | 'principia-forum' | 'principia-browser'
  command: string // process.execPath
  args: string[] // [<abs>/out/main/mcp-memory.js]
  /** ELECTRON_RUN_AS_NODE=1, HIVE_MEM_DB, HIVE_MEM_GRANT, HIVE_MEM_FP. Goes into the MCP config, never the agent env. */
  env: Record<string, string>
  /**
   * principia (CONNECTIONS.md QP-2): claude tool rules kept out of the spawn (`mcp__posthog`): the founder's own MCP
   * servers for services this spawn already reaches through Principia, which may be another company's account.
   */
  deny?: string[]
}
export interface MemoryGrantRequest {
  mode: 'read' | 'read-write'
  adapter: AdapterId
  /** The engine decides from the adapter's verified MCP support. */
  transport: MemoryTransport
  profile: AgentProfile | null
  /** Main resolves repoId = longest repo path prefix; no repo = read-only on global (PO2). */
  cwd: string
  /** COMPANY.md §6, PASSPORT.md §7.5: the spawn's company (session or run stamp). Absent = resolved from cwd. */
  companyId?: Id | null
  runId?: Id | null
  runTitle?: string | null
  workflowId?: Id | null
  stepId?: Id | null
  nodeId?: string | null
  nodeLabel?: string | null
  sessionId?: Id | null
  /** Text the brief's relevance search runs on (the rendered prompt / room topic). '' = pinned only. */
  briefQuery: string
}
export interface MemoryGrant {
  grantId: Id
  server: McpServerSpec
  /** Tool names for this grant, unprefixed (memory_search...). Adapters prefix them (claude: mcp__hivemem__). */
  toolNames: string[]
  /** Directory for per-grant config files (<userData>/memory/spawn), created 0700. */
  spawnDir: string
  /** Rendered <hive-memory> block (MEMORY.md 6.3), '' when empty. Already redacted. */
  brief: string
}
export interface MemoryBridge {
  /** Inserts mem_grant and builds the brief. Never throws for memory reasons: on failure returns null and logs. */
  grant(req: MemoryGrantRequest): MemoryGrant | null
  /** Sets closed_at; deletes <spawnDir>/<grantId>.*. Idempotent. Call in finally. */
  release(grantId: Id): void
  /** hivemem with an empty grant (only ask_user listed): attached to headless claude steps with memory off (LIVE.md §4.2). */
  askOnlyServer?(): McpServerSpec
}

/** What main passes to node-pty for an interactive session. */
export interface SpawnSpec {
  file: string // absolute binary path (resolved via login PATH)
  args: string[]
  /** Extra env the adapter needs (merged over baseEnv + secrets). */
  env?: Record<string, string>
  /** Env names main must delete AFTER merging secrets (adapter auth vars unless profile.useApiKeyAuth). */
  stripEnv?: string[]
  /** Conversation id to store on the Session (claude: the uuid passed via --session-id / --resume). */
  agentSessionId?: string | null
}
export interface InteractiveSpawnOptions {
  cwd?: string
  /** COMPANY.md §6: the session's company. Decides the Passport context and the gateway connections. */
  companyId?: Id | null
  /** Resume this agent conversation instead of starting fresh (Restart, runs:openAsSession). */
  resumeAgentSessionId?: string | null
  /** Start a new conversation under this id (claude --session-id) — Restart when no conversation was recorded yet. */
  freshAgentSessionId?: string | null
  /** Absolute ARTIFACTS_DIR, used in the claude --append-system-prompt hint. */
  artifactsDir: string
  /** Vault key names in this session's env, named in the same hint so the agent uses $NAME instead of hunting for keys. */
  keyNames?: string[]
  /** Pass the CLI's skip-permissions flag. Default false: interactive panes use the CLI's normal permission prompts (Settings › Agents). */
  bypass?: boolean
  /** Memory (CONTRACT 11): main obtained the grant (sessions); the adapter attaches it. Main releases it. */
  memory?: MemoryGrant | null
  /** Live hooks (LIVE.md §3.2/§3.5): the session's live dir. claude adds `--settings <dir>/claude-settings.json`. */
  live?: { dir: string; hookCommand: string; mcpEnv: Record<string, string> } | null
  /** Spawn tag (CONTRACT §13) for the hivemem MCP child this session's CLI starts: HIVE_SPAWN_ID + HIVE_USER_DATA. */
  spawnTag?: Record<string, string> | null
  /**
   * AUTHORING.md §1.1 (PO1, PO7): the `hive` authoring MCP server for this interactive claude session. The adapter adds
   * it to the session's per-spawn --mcp-config (next to hivemem), pre-allows `mcp__hive__<tool>` for every name in
   * `authorTools`, sets MCP_TOOL_TIMEOUT for the spawn and appends the authoring hint. Ignored by other adapters.
   */
  author?: McpServerSpec | null
  /** Unprefixed tool names of the `hive` server (hive_workflow_schema, …). */
  authorTools?: string[]
  /** Directory for the per-spawn config file (0700). */
  authorSpawnDir?: string
  /** SLACK.md §12.3 "Ask an agent about this thread": claude starts with this as its first user message (positional prompt). */
  initialPrompt?: string | null
  /**
   * DEPARTMENTS.md §7, §9: the department of a department chat or of the task an interactive task session works on.
   * The Passport block gains that department's slot (charter, passport note), as for headless task runs.
   */
  departmentId?: Id | null
  /** DEPARTMENTS.md §9: the chat brief (repos, departments or the department's agents and tasks, routing rules), appended to the Passport block. */
  chatBrief?: string | null
  /** DEPARTMENTS.md §9: the company's other repo folders the chat may read and edit (claude and codex `--add-dir`). Absolute paths. */
  addDirs?: string[]
}

export interface StartRunOptions {
  /** 'task': a board task run (DEPARTMENTS.md §3.4); stored as 'manual' + trigger_ext until RunTrigger lists it. */
  trigger: RunTrigger | 'task'
  scheduleId?: Id | null
  parentRunId?: Id | null
  /** AUTHORING.md §2.4: runs an agent started (trigger 'agent'). Persisted on the Run. */
  startedBy?: { ownerLabel: string; ownerKey: string; draftId: Id | null } | null
  /** SLACK.md §9.4: with trigger 'slack'. Persisted on the Run. */
  slack?: SlackRunContext | null
  /**
   * COMPANY.md §3: the explicit company, the last link of the run's inheritance (workflow, schedule, repo come first).
   * A conflicting explicit id is a cross-company launch (guarded).
   */
  companyId?: Id | null
  /** DEPARTMENTS.md §4.3: the board task this run works on (runs.task_id); its company is inherited first. */
  taskId?: Id | null
  /** The task's agent seat (runs.agent_id). Without taskId: a seat run with no board task (a Forum reply, FORUM.md §3). */
  agentId?: Id | null
  /** A resumed Claude task turn: `--resume` this provider conversation (prompt runs only). */
  resumeSessionId?: string | null
  /** Prompt runs: the title to show instead of one cut from the prompt (a board task turn: its key and title). */
  title?: string | null
  /** §3.6 task runs: the time cap in minutes (warned ~2 min before, then canceled). Absent = the seat's limits.runMinutes. */
  runMinutes?: number | null
}

export interface Engine {
  /** Detect providers, mark interrupted runs/steps failed ("Hive quit during run"). Call once after DB open. */
  init(): Promise<void>
  /** Cancel all runs, kill all child process groups (SIGTERM, SIGKILL after 3 s). Resolves when done. */
  shutdown(): Promise<void>

  providers: {
    /** All 5 adapters; refresh=true re-runs detect(). Emits providers.updated when changed. */
    list(opts?: { refresh?: boolean }): Promise<ProviderInfo[]>
    /** Cached result of the last detect (sync; may be [] before init). */
    cached(): ProviderInfo[]
    /** argv for an interactive PTY session of this profile. Throws HiveError('adapter_unavailable', hint). */
    interactiveSpawn(profile: AgentProfile, opts: InteractiveSpawnOptions): SpawnSpec
  }

  workflows: {
    /** Save-time validation: ids, after/target exist, no cycles, templates resolve, room >= 2, ranges. [] = valid. */
    /** opts.slackTriggered: the workflow has a Slack trigger (or the run comes from one): Slack-driven rules apply. */
    validate(draft: WorkflowDraft, opts?: { slackTriggered?: boolean }): ValidationError[]
  }

  /** Run-owned asks (LIVE.md §4.3). conflict if not open; bad_request for an option not offered. */
  asks?: {
    answer(id: Id, a: AskAnswer): Ask
  }

  runs: {
    /**
     * Persists a queued Run (insertRun), creates <artifactsRoot>/<runId>/, returns immediately and
     * executes asynchronously. Missing adapter -> run ends 'failed' with the install hint (never hangs).
     * Throws HiveError('validation') if the workflow is invalid, ('not_found') for unknown ids.
     */
    start(target: RunTarget, opts: StartRunOptions): Run
    /** Kills the process tree within 3 s; run -> 'canceled'. No-op on ended runs. */
    cancel(id: Id): Promise<void>
    /**
     * CONTRACT §13 "Retry at reset": sets (at = ISO) or clears (null) the run's one-off retry. The scheduler reruns it
     * at that time (trigger 'rerun', parentRunId = id) and records retryRunId. conflict once the retry fired or while
     * the run is active.
     */
    retryAt?(id: Id, at: ISODate | null): Run
    /** Step ids running right now (leftover detection: their tagged processes are not leftovers). */
    liveSpawnIds?(): string[]
    /** New run with the same target (trigger 'rerun', parentRunId = id). */
    rerun(id: Id): Run
    /** queued + running. */
    active(): Run[]
  }

  scheduler: {
    /** Starts the 15 s tick + runs catch-up for 'launch'. No-op if HIVE_NO_SCHEDULER=1. */
    start(): void
    stop(): void
    /** Called by main after it inserted/updated a schedule's config columns. Recomputes nextFireAt, emits schedule.updated. */
    upsert(id: Id): Schedule
    /** Called by main before deleting the row. Forgets timers/state. */
    remove(id: Id): void
    /** Fire now regardless of time/enabled/paused (overlap still skips -> throws HiveError('conflict')). */
    runNow(id: Id): Run
    /** DEPARTMENTS.md §8: "Run now" for any mode: a run ('run' mode) or the standing card it woke ('task' mode). */
    fireNow?(id: Id): ScheduleFireResult
    /** Validates + describes a when-spec; next 3 fires. Enforces >= 5 min interval. */
    preview(when: ScheduleWhen): SchedulePreview
    /** Human sentence, e.g. "Every weekday at 9:00 (Europe/Madrid)". Pure. */
    describe(when: ScheduleWhen): string
    /** Next fires across enabled schedules, ascending. Empty while paused. */
    nextRuns(limit: number): NextFire[]
    setPaused(paused: boolean): void
    /** powerMonitor 'resume' / launch: missed-fire rule (SPEC 8.2). */
    catchUp(reason: 'launch' | 'resume'): void
    /** LIVE.md §8: skip the next slot (logs 'skipped', emits schedule.updated). */
    skipNext?(id: Id): Schedule
  }

  /**
   * SLACK.md §9.3: Slack trigger matching. start() is called with scheduler.start() (honors HIVE_NO_SCHEDULER=1; reads
   * Settings.schedulesPaused live). Main calls reload() after any slackTriggers:* write. Absent without ctx.slack.
   */
  slackTriggers?: {
    start(): void
    stop(): void
    reload(): void
    /** Never starts a run. */
    test(t: SlackTriggerInput, sample: SlackInboundMessage): SlackTriggerTestResult
  }
}

export type CreateEngine = (ctx: EngineContext) => Engine
