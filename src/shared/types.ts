/**
 * Hive shared domain types. Imported by src/main, src/main/engine, src/preload and src/renderer.
 * TYPE-ONLY module except for small `as const` lists. No Node or DOM imports allowed here.
 * Normative companion of docs/CONTRACT.md. Change both in the same commit.
 */

import type { MemoryMode, MemoryTransport } from './memory'
import type { AgentEvent, AgentNode as LiveAgentNode, Ask } from './live'
import type { NotifySlackTarget, SlackRunContext, SlackTrigger } from './slack'

// ---------- primitives ----------
/** ISO-8601 UTC timestamp, e.g. "2026-10-15T09:00:00.000Z". */
export type ISODate = string
/** Prefixed random ids: `<prefix>_<10 chars [0-9a-z]>`. See ID_PREFIX. */
export type Id = string

export const ID_PREFIX = {
  repo: 'repo',
  profile: 'prof',
  session: 's',
  workflow: 'wf',
  run: 'r',
  step: 'st',
  schedule: 'sch',
  scheduleEvent: 'sev',
  artifact: 'art',
  memEntity: 'ment',
  memFact: 'mfa',
  memRelation: 'mrel',
  memGrant: 'mgr',
  agent: 'ag',
  ask: 'ask',
  // AUTHORING.md §4 / CONTRACT §14 (add-only)
  authorDraft: 'adr',
  worktree: 'wt',
  authorCall: 'hac',
  // SLACK.md §7.1 (add-only)
  slackDraft: 'sdr',
  slackTrigger: 'stg',
  slackOutbox: 'sob',
  slackTriggerEvent: 'ste'
} as const

export const ADAPTER_IDS = ['claude', 'codex', 'cursor', 'gemini', 'shell'] as const
export type AdapterId = (typeof ADAPTER_IDS)[number]
/** Adapters shown in the top-right provider switcher (shell is not a provider). */
export const SWITCHER_ADAPTERS = ['claude', 'codex', 'cursor', 'gemini'] as const

/**
 * Why a run, step or live agent stopped (or is stuck), beyond its status (LANDSCAPE.md "Elon's cut" #4).
 * Only 'rate_limited' is recorded today: the CLI hit a usage / rate limit. Absent or null = nothing special.
 */
export const STOP_REASONS = ['rate_limited'] as const
export type StopReason = (typeof STOP_REASONS)[number]

export const ARTIFACT_KINDS = ['image', 'video', 'audio', 'html', 'markdown', 'pdf', 'code', 'other'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/**
 * COMPANY.md §1.4, §3: every row read from hive.db carries the company it belongs to, with NULL and dangling stamps
 * read as Personal (`co_personal`, see shared/company.ts). Optional on the types only so literal fixtures compile.
 */
export interface CompanyStamped {
  companyId?: Id
}
/** COMPANY.md §7: the optional list filter. Absent = all companies (exactly the pre-company behaviour). */
export interface CompanyFilter {
  companyId?: Id
}

// ---------- providers ----------
export interface ProviderInfo {
  id: AdapterId
  label: string // "Claude Code", "Codex", "Cursor Agent", "Gemini CLI", "Shell"
  available: boolean
  version: string | null
  binPath: string | null
  installHint: string // e.g. "npm i -g @openai/codex"
  checkedAt: ISODate
  /** Memory (CONTRACT 11): 'mcp' when Hive attaches hivemem to this CLI, 'inject' = brief only. Absent = no memory (shell). */
  memory?: MemoryTransport
  /**
   * LIVE.md F2: permission prompts of headless steps reach Hive as Needs you (claude: stdio; gemini/cursor: only once
   * their hooks are verified). false = such a step's approvals never show up in Hive; the UI should say so.
   */
  headlessAsks?: boolean
}

// ---------- repos ----------
export interface Repo extends CompanyStamped {
  id: Id
  name: string // basename by default
  path: string // absolute
  addedAt: ISODate
  exists: boolean // false -> greyed "folder not found"
  isGit: boolean
  liveSessions: number // running sessions with this repoId
  /** COMPANY.md §2.3: position in its company's `repo_order:<companyId>` (the sidebar group order); 0-based. */
  companyOrder?: number
}

// ---------- agent profiles ----------
export type PermissionMode = 'default' | 'bypass'
export interface AgentProfile {
  id: Id
  name: string
  adapter: AdapterId
  model: string | null
  extraArgs: string[]
  permissionMode: PermissionMode
  /** ENV var names from the vault. ['*'] = all secrets (default for seeded profiles). Profile level ONLY. */
  secretNames: string[]
  /**
   * false (default): the adapter's own auth vars are stripped from the child env even if in the vault
   * (claude: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN; codex: OPENAI_API_KEY) so subscription logins keep working.
   */
  useApiKeyAuth: boolean
  createdAt: ISODate
  updatedAt: ISODate
}
export type AgentProfileInput = Pick<AgentProfile, 'name' | 'adapter'> &
  Partial<Pick<AgentProfile, 'model' | 'extraArgs' | 'permissionMode' | 'secretNames' | 'useApiKeyAuth'>>

// ---------- sessions (interactive PTY) ----------
export type SessionStatus = 'running' | 'exited'
export interface Session extends CompanyStamped {
  id: Id
  title: string // "<repo name> · Claude" or "Chat · Claude"
  profileId: Id
  adapter: AdapterId
  repoId: Id | null // null = Chat (cwd = <userData>/scratch)
  cwd: string
  status: SessionStatus
  pid: number | null
  cols: number
  rows: number
  exitCode: number | null
  startedAt: ISODate
  endedAt: ISODate | null
  artifactsDir: string // <userData>/artifacts/<sessionId>/
  /** Set when created via runs.openAsSession. */
  fromRunId: Id | null
  /** Agent-side conversation id (claude: the uuid Hive passed via --session-id). Restart resumes it. null = not resumable. */
  agentSessionId: string | null
}

// ---------- workflows ----------
export interface WorkflowInput {
  name: string // [a-zA-Z_][a-zA-Z0-9_]*  -> {{inputs.name}}
  label: string
  default?: string
  /**
   * 'repo' renders a repo picker; value is a repoId. 'boolean' renders a checkbox; value is exactly 'true' or 'false'
   * (templated as that text; anything else is refused at run start). A boolean input named dry_run also blocks every
   * git push of the run (Hive's pre-push hook + $HIVE_DRY_RUN=1 in every step).
   */
  type?: 'text' | 'multiline' | 'repo' | 'boolean'
}

export type NodeType = 'agent' | 'room' | 'check' | 'shell' | 'wait' | 'notify'
interface NodeBase {
  id: string // slug [a-z][a-z0-9_-]*, unique in workflow
  type: NodeType
  label: string
  after: string[] // node ids that must pass first
  /** repoId, absolute path, or a template like "{{inputs.repo}}". null = <userData>/scratch */
  cwd: string | null
  timeoutMin: number // default 30
  /** Memory (CONTRACT 11). Absent = 'off'. shell + command checks: 'off' only; agent-reviewer checks: 'off' | 'read'. */
  memory?: MemoryMode
  /** AUTHORING.md §4: run in the run's git worktree. Requires WorkflowDraft.worktree. Not allowed on notify. */
  isolate?: 'worktree' | null
}
export interface AgentNode extends NodeBase {
  type: 'agent'
  profileId: Id
  prompt: string
}
export interface RoomParticipant {
  profileId: Id // any non-shell adapter; the same profile may appear twice
  label: string // unique in the room, e.g. "Builder", "Skeptic"
}
export interface RoomNode extends NodeBase {
  type: 'room'
  participants: RoomParticipant[] // >= 2
  topic: string
  rounds: number // 1..10
  final: 'last' | 'summary' // 'summary' = one extra turn by participants[0]
}
/**
 * Exactly one of profileId (agent reviewer, VERDICT line) or command (shell reviewer: exit 0 = PASS,
 * stdout+stderr tail = feedback). `after` defaults to [target]; it may also name nodes downstream of target, which
 * puts them in the loop body (e.g. combine -> wait_codex -> check(target=combine, after=[wait_codex])); naming any
 * other node is a validation error (shared/authoring checkAfterProblems), never a silent rewrite.
 * On FAIL the loop body (target + every node on a path target -> check) re-runs in order.
 * Nodes that depend on `target` but are outside the loop body wait until all checks on target pass.
 */
export interface CheckNode extends NodeBase {
  type: 'check'
  profileId: Id | null
  command: string | null
  target: string // node id of an agent node
  criteria: string // ignored for command reviewers
  maxRetries: number // 0..5
}
/** Script language of a shell node: 'sh' (default) runs `command` with $SHELL -lc; python / node run it as a file. */
export const SCRIPT_LANGS = ['sh', 'python', 'node'] as const
export type ScriptLang = (typeof SCRIPT_LANGS)[number]
export interface ShellNode extends NodeBase {
  type: 'shell'
  /** The command, or the whole script when lang is python / node. Inputs are also in the env as HIVE_INPUT_<NAME>. */
  command: string
  /** Absent / null = 'sh'. */
  lang?: ScriptLang | null
}
/** AUTHORING.md §7.1: re-runs `command` every intervalSec until exit 0 / stdout matches, within timeoutMin. */
export interface WaitNode extends NodeBase {
  type: 'wait'
  command: string // templated, $SHELL -lc in cwd (worktree when isolated)
  until: 'exit0' | 'match'
  pattern: string | null // JS regex source, required when until = 'match', <= 500 chars
  intervalSec: number // 5..3600
  onTimeout: 'fail' | 'continue' // total budget = timeoutMin
}
/** SLACK.md §10 (replaces AUTHORING.md §7.2 iMessage): macOS notification + optional Slack DM (`me`) or channel. */
export interface NotifyNode extends NodeBase {
  type: 'notify'
  title: string // templated, rendered <= 120 chars
  message: string // templated, rendered <= 2,000 chars
  /** SLACK.md §10.1 (replaces the removed iMessage, SA3): null = Mac notification only. */
  slack?: NotifySlackTarget | null
  /** Set by the one-time iMessage migration; the editor shows a dismissible note. */
  migratedFrom?: 'imessage' | null
}
export type WorkflowNode = AgentNode | RoomNode | CheckNode | ShellNode | WaitNode | NotifyNode

/** AUTHORING.md §6: one git worktree per run, shared by every isolate:'worktree' node. */
export interface WorkflowWorktree {
  repo: string // repo id or a template ("{{inputs.repo}}"); must resolve to a git repo
  base?: string | null // branch; null = the repo's default branch (origin/HEAD)
  /**
   * PO5: branch globs isolated nodes may push to, enforced by Hive's pre-push (`*` matches anything). Absent = ['hive/*'].
   * The default branch and `base` are never pushable; force pushes, remote deletes and `gh pr merge` are always blocked.
   */
  pushBranches?: string[] | null
}

export interface WorkflowDraft {
  name: string
  description: string
  inputs: WorkflowInput[]
  nodes: WorkflowNode[]
  worktree?: WorkflowWorktree | null
  /** SLACK.md §9.4: headless claude steps get the `hive` server's slack toolset (when Slack is connected). */
  slackTools?: boolean
  /** Explicit opt-in to profile permissions for Slack-reading coding workflows. Slack send policy still applies. */
  slackAgentPermissions?: 'restricted' | 'profile'
}
/** AUTHORING.md §2.5: who authored a workflow through the `hive` tools. Not exported in WorkflowFile. */
export interface WorkflowOrigin {
  kind: 'agent'
  adapter: AdapterId
  ownerLabel: string // "example-project · Claude"
  ownerKey: string
  sessionId: Id | null
  runId: Id | null
  stepId: Id | null
  draftId: Id
  approvedAt: ISODate
  edited: boolean // the user changed it before approving
  updatedBy?: { draftId: Id; ownerLabel: string; at: ISODate }[]
}
export interface Workflow extends WorkflowDraft, CompanyStamped {
  id: Id
  createdAt: ISODate
  updatedAt: ISODate
  origin?: WorkflowOrigin | null
  /** DEPARTMENTS.md §8: the department it shows under as a recurring agent (workflows.department_id). Absent = none. */
  departmentId?: Id | null
}
/** `.hive.json` export format. */
export interface WorkflowFile {
  hive: 'workflow'
  version: 1
  workflow: WorkflowDraft
}

export interface ValidationError {
  /** node id, or 'name' | 'inputs' | 'when' | 'target' | field name */
  path: string
  message: string // e.g. 'Node "review": {{nope.output}} references unknown node "nope"'
}

// ---------- runs ----------
export type RunKind = 'prompt' | 'workflow'
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'canceled'
export type RunTrigger = 'manual' | 'schedule' | 'catchup' | 'rerun' | 'agent' | 'slack' | 'task'

export interface PromptTarget {
  kind: 'prompt'
  profileId: Id
  repoId: Id | null
  prompt: string
  secretNames?: string[]
  /** Memory (CONTRACT 11). Default 'read-write' (LIVE.md §7); writes go to the repo's project memory. */
  memory?: MemoryMode
}
export interface WorkflowTarget {
  kind: 'workflow'
  workflowId: Id
  inputs: Record<string, string>
}
export type RunTarget = PromptTarget | WorkflowTarget

export interface Run extends CompanyStamped {
  id: Id
  kind: RunKind
  title: string // workflow name or first 60 chars of prompt
  target: RunTarget
  workflowId: Id | null
  scheduleId: Id | null
  parentRunId: Id | null // rerun source
  trigger: RunTrigger
  status: RunStatus
  reason: string | null // failure/cancel reason, redacted
  createdAt: ISODate
  startedAt: ISODate | null
  endedAt: ISODate | null
  artifactsDir: string // <userData>/artifacts/<runId>/
  artifactCount: number
  /** 'rate_limited' when the run failed because a step hit a usage / rate limit. */
  stopReason?: StopReason | null
  /** When that limit resets, if known (the latest reset among the run's limited steps). */
  resetAt?: ISODate | null
  /** A one-off retry ("Retry at reset") Hive's scheduler fires at this time. null = none pending. */
  retryAt?: ISODate | null
  /** The run that retry started (set once it fired). A run gets at most one retry from this. */
  retryRunId?: Id | null
  /** 'nothing_to_do' when a step emitted HIVE_STOP (status is 'passed'). AUTHORING.md §5. */
  outcome?: 'nothing_to_do' | null
  worktree?: RunWorktree | null
  startedBy?: { ownerLabel: string; ownerKey: string; draftId: Id | null } | null
  /** SLACK.md §9.4: the Slack message(s) that started this run (trigger 'slack'). */
  slack?: SlackRunContext | null
  /** DEPARTMENTS.md §1.2: the board task (and agent seat) this run works, from runs.task_id / agent_id. */
  taskId?: Id | null
  agentId?: Id | null
}

/** AUTHORING.md §6. */
export interface RunWorktree {
  id: Id // 'wt_…'
  runId: Id
  repoId: Id | null
  repoPath: string
  path: string // <userData>/worktrees/<runId>
  branch: string // hive/<workflow-slug>-<runId>
  base: string // e.g. origin/main @ <sha7>
  status: 'creating' | 'active' | 'kept' | 'removed' | 'error'
  keptReason: 'pushed' | 'failed' | 'dirty' | 'canceled' | null
  error: string | null
  createdAt: ISODate
  removedAt: ISODate | null
}

/** A local branch created in a repo while a run ran (isolated or not). newCommits = commits made during the run that are on no remote. */
export interface RunBranch {
  repoPath: string
  name: string
  newCommits: number
  /** Checked out in the user's checkout or a worktree: git will not delete it. */
  checkedOut: boolean
  /** The run's own hive/<workflow>-<runId> branch. */
  hive: boolean
}

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'canceled' | 'skipped'
export type StepNodeType = NodeType | 'prompt'
export interface RunStep {
  id: Id
  runId: Id
  seq: number // creation order within run
  nodeId: string // workflow node id; 'prompt' for prompt runs
  nodeType: StepNodeType
  attempt: number // 1-based (check retries bump the target's attempt)
  round: number | null // room round
  profileId: Id | null
  participantLabel: string | null // room speaker label
  adapter: AdapterId
  cwd: string
  prompt: string // fully resolved, redacted
  output: string | null // final text, redacted, capped 50 KB
  verdict: 'PASS' | 'FAIL' | null // check steps
  exitCode: number | null
  pid: number | null
  status: StepStatus
  error: string | null
  /** Steps whose output was templated into this prompt -> canvas "talk" edges. */
  sourceStepIds: Id[]
  /** claude --session-id uuid of this step; retries resume it, runs:openAsSession resumes it interactively. */
  agentSessionId: string | null
  /** 'rate_limited' when the step failed on a usage / rate limit (classified from the CLI's own output). */
  stopReason?: StopReason | null
  /** When the limit resets, if the CLI said so. */
  resetAt?: ISODate | null
  /** The HIVE_STOP reason this step emitted (AUTHORING.md §5). */
  halt?: string | null
  logPath: string // <userData>/logs/runs/<runId>/<stepId>.log
  startedAt: ISODate | null
  endedAt: ISODate | null
}
export interface RunDetail {
  run: Run
  steps: RunStep[]
  workflow: WorkflowDraft | null // snapshot taken at start
}

// ---------- schedules ----------
export type ScheduleWhen =
  | { kind: 'cron'; cron: string; tz: string } // 5-field cron, IANA tz
  | { kind: 'at'; at: ISODate }
/** UI preset that produced `when` (for re-editing). Purely cosmetic. */
export type SchedulePreset =
  | { kind: 'weekdays'; time: string } // "09:00"
  | { kind: 'daily'; time: string }
  | { kind: 'hourly'; minute: number }
  | { kind: 'everyNMinutes'; n: number } // n >= 5
  | { kind: 'once'; at: ISODate }
  | { kind: 'cron' }

/**
 * DEPARTMENTS.md §8: 'run' (default, today's behaviour) starts the target on every fire; 'task' keeps one standing card
 * "Recurring: <name>" on the board, assigned to `agentId`, and each fire comments on it and wakes the agent.
 */
export type ScheduleMode = 'run' | 'task'
export type ScheduleTarget = RunTarget & { mode?: ScheduleMode; agentId?: Id | null }
export interface Schedule extends CompanyStamped {
  id: Id
  name: string
  target: ScheduleTarget
  /** DEPARTMENTS.md §8: schedules.department_id. Absent = none. */
  departmentId?: Id | null
  when: ScheduleWhen
  preset: SchedulePreset | null
  enabled: boolean
  sentence: string // "Every weekday at 9:00 (Europe/Madrid)"
  lastFireAt: ISODate | null
  lastRunId: Id | null
  lastRunStatus: RunStatus | null
  nextFireAt: ISODate | null
  /** LIVE.md §8: the slot skipped by "Skip next" (never fired). */
  skipSlotAt?: ISODate | null
  createdAt: ISODate
  updatedAt: ISODate
}
export interface ScheduleInput {
  name: string
  target: ScheduleTarget
  departmentId?: Id | null
  when: ScheduleWhen
  preset?: SchedulePreset | null
  enabled?: boolean
}
export type ScheduleEventKind = 'fired' | 'skipped_overlap' | 'missed' | 'caught_up' | 'error' | 'skipped'
export interface ScheduleEvent {
  id: Id
  scheduleId: Id
  kind: ScheduleEventKind
  slotAt: ISODate // the cron slot this event is about
  runId: Id | null
  message: string | null
  createdAt: ISODate
}
export interface SchedulePreview {
  ok: boolean
  sentence: string
  next: ISODate[] // next 3 fires
  error: string | null // "Minimum interval is 5 minutes"
}
export interface NextFire {
  scheduleId: Id
  name: string
  at: ISODate
}

// ---------- secrets ----------
export interface SecretMeta {
  name: string // ^[A-Z_][A-Z0-9_]*$
  /** COMPANY.md §4: null = Shared (the `secrets` table); else the company_secrets owner. Absent on older callers = Shared. */
  companyId?: Id | null
  label: string
  masked: string // "sk-…a1b2"
  createdAt: ISODate
  updatedAt: ISODate
  lastUsedAt: ISODate | null
}
export interface SecretPreset {
  id: string
  label: string
  envName: string
}
export const SECRET_PRESETS: SecretPreset[] = [
  { id: 'openai', label: 'OpenAI', envName: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', envName: 'ANTHROPIC_API_KEY' },
  { id: 'gemini', label: 'Gemini', envName: 'GEMINI_API_KEY' },
  { id: 'replicate', label: 'Replicate', envName: 'REPLICATE_API_TOKEN' },
  { id: 'fal', label: 'fal', envName: 'FAL_KEY' },
  { id: 'elevenlabs', label: 'ElevenLabs', envName: 'ELEVENLABS_API_KEY' },
  { id: 'stripe', label: 'Stripe', envName: 'STRIPE_SECRET_KEY' }
]
export interface EnvImportEntry {
  name: string
  masked: string
  valid: boolean
  exists: boolean // will overwrite
  error: string | null
}

// ---------- artifacts ----------
export interface Artifact extends CompanyStamped {
  id: Id
  runId: Id | null
  sessionId: Id | null
  path: string // absolute
  relPath: string // relative to artifacts root: "<runId|sessionId>/sub/file.png"
  name: string
  kind: ArtifactKind
  mime: string
  bytes: number
  createdAt: ISODate
  mtime: ISODate
}

// ---------- settings ----------
export interface Settings {
  launchAtLogin: boolean // default false (mirrors app.getLoginItemSettings)
  notifyOnSuccess: 'never' | 'scheduled' | 'always' // default 'scheduled'
  notifyOnFailure: boolean // default true
  notificationSound: boolean // default true
  keepAwake: boolean // default true
  concurrency: number // default 4, 1..16 (engine node cap)
  defaultAdapter: AdapterId // provider switcher, default 'claude'
  lastRepoId: Id | null
  schedulesPaused: boolean // default false
  onboardingDone: boolean // default false
  sidebarCollapsed: boolean // default false
  terminalFontSize: number // default 13, 9..24 (Cmd+= / Cmd+-)
  /** Interactive terminal sessions skip the CLI's permission prompts. Default false: a pane can ask. Headless workflow steps use profile.permissionMode. */
  interactiveBypass: boolean
  /** Memory mode for new interactive sessions (MEMORY.md §3.3). Default 'read-write' (store default); absent = 'off'. */
  sessionMemory?: MemoryMode
  /** A scheduled run that hits a usage limit schedules exactly one retry at the reset time. Default true. */
  autoRetryRateLimit: boolean
  /** A working step or session with no output and no hook activity for this many minutes is badged "Stalled?". Default 10, 1..240. */
  stallMinutes: number
  /** AUTHORING.md §8: read ~/.claude/projects for Home / Canvas History. Absent = true. */
  claudeHistory?: boolean
  /** SLACK.md §10.3: "Send my alerts to" (Slack user id). Default null. Only the user sets it. */
  slackAlertUserId?: string | null
  /** SLACK.md §10.3: mirror Needs-you alerts to the alert user's Slack DM. Default false. */
  slackMirrorNeedsYou?: boolean
  /** SLACK.md §6.2: backfill window in days. Default 7, 0..90. */
  slackBackfillDays?: number
  /** SLACK.md §6.3: gap-filled messages newer than this still trigger. Default 10, 0..120. */
  slackTriggerCatchupMin?: number
  /** PO-S3e: "Pause auto-replies": every auto decision becomes a draft. Default false. */
  slackAutoPaused?: boolean
  /** Marketplace: https link to a remote index.json, listed next to the built-in catalog. Default null. */
  marketplaceUrl?: string | null
  /** COMPANY.md §1.3, §8.6: the renderer's active company (UI state only; main never reads it). Default 'all'. */
  activeCompanyId?: Id | 'all'
  /** COMPANY.md §8.3: All-mode sidebar groups, companyId -> expanded. Missing = default (expanded). */
  expandedCompanies?: Record<Id, boolean>
  /**
   * COMPANY.md §6, PASSPORT.md §9/§12: development flags, removed at GA. settings:update merges a partial value into
   * the stored one; settings:get always returns all three. Absent = off.
   */
  experimental?: ExperimentalFlags
  /** VOICE.md §0: Settings → General → Tone. 'plain' drops the wit, Latin and ceremony (materials stay). Absent = 'playful'. */
  tone?: 'playful' | 'plain'
  /** VOICE.md §0: "Agent names and busts". Off shows the role label and the department-colour initial. Absent = true. */
  personas?: boolean
}
export interface ExperimentalFlags {
  /** company guards throw (on) or warn and still stamp (off) */
  companies?: boolean
  /** the Passport vault replaces the v1 memory.db path */
  vault?: boolean
  /** stage-2 LLM suggestions (also opt-in per company) */
  vaultAI?: boolean
  /** DEPARTMENTS.md §0.8: departments, agents and the company board. Only takes effect with `companies` on. */
  departments?: boolean
}

/**
 * A process Hive tagged (HIVE_SPAWN_ID in its env) whose owner session or step no longer exists: a leftover from an
 * earlier Hive run (dev servers, watchers). Listed in Settings and on Home; Hive never kills these on its own.
 */
export interface LeftoverProcess {
  pid: number
  /** The HIVE_SPAWN_ID it carries: the session (s_…) or step (st_…) that started it. */
  spawnId: string
  /** Command line, redacted, capped at 300 chars. */
  command: string
  /** Working directory, null when it could not be read. */
  cwd: string | null
  startedAt: ISODate
  ageMs: number
}

// ---------- app / status ----------
export interface AppInfo {
  name: 'Hive' | 'Principia'
  version: string
  electron: string
  node: string
  platform: string
  arch: string
  isPackaged: boolean
  userDataDir: string
  artifactsDir: string
  scratchDir: string
  logsDir: string
  dbPath: string
  safeStorageAvailable: boolean
  loginShellPath: string | null // resolved $PATH, null if resolution failed
}
export interface StatusSnapshot {
  runningSessions: number
  runningRuns: number
  queuedRuns: number
  schedulesPaused: boolean
  nextFire: NextFire | null
  last24h: { passed: number; failed: number }
  /** Failed runs that ended after the window was last focused (tray shows ✕). Reset on window focus. */
  unseenFailures: number
  /** LIVE.md §4.5: open asks + unseen idle live session roots (A3). Absent until main implements it. */
  needsYou?: number
}
export interface HomeData {
  status: StatusSnapshot
  runningSessions: Session[]
  activeRuns: Run[] // queued + running
  recentRuns: Run[] // ended in last 24h, newest first, <= 50
  nextFires: NextFire[] // <= 5
}
export interface CanvasSnapshot {
  sessions: Session[] // running + exited in last 24h
  runs: RunDetail[] // active + ended in last 24h, <= 40
  schedules: Schedule[] // enabled
  workflows: Workflow[] // referenced by runs/schedules
  profiles: AgentProfile[]
  repos: Repo[]
  /** LIVE.md §10: live roots + descendants, plus roots of included runs/sessions with their subagents (<= 400). */
  agents?: LiveAgentNode[]
}

// ---------- engine events (also forwarded to the renderer) ----------
export type EngineEvent =
  | { type: 'run.updated'; run: Run }
  | { type: 'step.updated'; step: RunStep }
  | { type: 'step.output'; runId: Id; stepId: Id; chunk: string } // redacted live text
  | { type: 'schedule.updated'; schedule: Schedule }
  | { type: 'schedule.event'; event: ScheduleEvent; scheduleName: string }
  | { type: 'providers.updated'; providers: ProviderInfo[] }
  | { type: 'agent.updated'; agent: LiveAgentNode }
  | { type: 'agent.events'; agentId: Id; events: AgentEvent[] }
  | { type: 'ask.updated'; ask: Ask }
  | { type: 'slackTrigger.updated'; trigger: SlackTrigger } // CONTRACT Slack.3: after fire state changes

// ---------- errors ----------
export type HiveErrorCode =
  | 'bad_request'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'adapter_unavailable'
  | 'vault_unavailable'
  | 'forbidden'
  | 'canceled'
  | 'internal'
  /** a declared channel whose implementation has not shipped yet (PASSPORT.md §11 stubs) */
  | 'not_implemented'
export interface HiveErrorShape {
  code: HiveErrorCode
  message: string
  errors?: ValidationError[]
}

// ---------- Principia Cloud: the desktop link (docs/CLOUD.md §8, §13.1; package FE) ----------
// The HTTP types are in ./cloud. These are what main tells the renderer about its link. Never a token or key value.

/** What the Cloud pane, the sidebar badge and Home's Needs you read. */
export interface CloudLinkState {
  linked: boolean
  /** control plane base URL, e.g. https://cloud.example.com */
  url: string | null
  workspace: { id: Id; name: string } | null
  deviceId: Id | null
  /** safeStorage is available: without it the device token is never stored */
  encryption: boolean
  /** the last request to the cloud succeeded */
  online: boolean
  offlineSince: ISODate | null
  lastSyncAt: ISODate | null
  /** plain sentence, e.g. "This Mac was disconnected from the cloud." */
  error: string | null
  /** companies run in the cloud from this Mac */
  cloudCompanyIds: Id[]
  /** schedules placed in the cloud: the local scheduler never fires these */
  cloudScheduleIds: Id[]
  /** open cloud asks (the Needs-you count), from the last sync */
  openAsks: number
  /** the account linking in progress on this Mac (CLOUD.md §7.2), or its last outcome */
  login: CloudLoginStatus | null
}

export type CloudLoginAdapter = 'claude' | 'codex'
export interface CloudLoginStatus {
  adapter: CloudLoginAdapter
  phase: 'starting' | 'waiting' | 'uploading' | 'testing' | 'done' | 'failed' | 'canceled'
  /** plain copy for the row; never contains a token */
  message: string | null
  reason: 'missing_cli' | 'port_busy' | 'timeout' | 'no_token' | 'cli_failed' | 'upload_failed' | null
  /** shown when the CLI is missing ("npm install -g @anthropic-ai/claude-code") */
  installHint: string | null
  /** the sign-in page the CLI opened, for "Open the page again" (an OAuth URL, not a credential) */
  browserUrl: string | null
}

/** cloud:movePlan: what "Run in the cloud…" can send, with plain reasons for what it cannot (CLOUD.md §3 step 5). */
export interface CloudMovePlan {
  companyId: Id
  companyName: string
  inCloud: boolean
  workflows: { id: Id; name: string; ok: boolean; reason: string | null; adapters: AdapterId[] }[]
  /** workflow-target schedules only; `placement` is where it fires today */
  schedules: { id: Id; name: string; sentence: string; workflowId: Id | null; ok: boolean; reason: string | null; placement: 'local' | 'cloud' }[]
  repos: { id: Id; name: string; url: string | null; ownerRepo: string | null; ok: boolean; reason: string | null; tokenUrl: string }[]
  /** only what the selected workflows use: keys by name, header connections; never a value */
  needs: {
    keys: { name: string; usedBy: Id[] }[]
    connections: { id: string; name: string; hasCredentials: boolean; usedBy: Id[] }[]
  }
  /** OAuth connections: each authorizes in the cloud with its own sign-in */
  oauth: { id: string; name: string; usedBy: Id[] }[]
  /**
   * CLOUD.md §7.1 (additive): the passport is created from this Mac's Passport vault on a first move. `ready: false`
   * (the vault is off) shows a "Turn on Passport" fix in the checklist before Run in the cloud can be pressed.
   */
  passport?: { ready: boolean; reason: string | null }
}

/** cloud:move. Everything absent is never sent: unticked keys, connections and repos stay on this Mac. */
export interface CloudMoveChoices {
  companyId: Id
  workflows: Id[]
  schedules: Id[]
  /** token: a fine-grained GitHub token typed in the checklist (write-only); null = a public repo */
  repos: { id: Id; token: string | null }[]
  keys: string[]
  connections: string[]
  /** workflows whose "changed in the cloud" conflict the user chose to overwrite */
  overwrite?: Id[]
}
export interface CloudMoveItem {
  kind: 'passport' | 'company' | 'workflow' | 'schedule' | 'repo' | 'key' | 'connection'
  id: string
  name: string
  status: 'done' | 'skipped' | 'conflict' | 'failed'
  message: string | null
}
export interface CloudMoveResult {
  items: CloudMoveItem[]
  /** the company as the cloud sees it now (readiness included), null when the create failed */
  company: import('./cloud').CloudCompany | null
}

/** evt:cloud. `changes`: runs, asks or passports moved on the server (refetch); `event`: one SSE event, as is. */
export type CloudDesktopEvent =
  | { kind: 'state'; state: CloudLinkState }
  | { kind: 'changes'; runs: number; asks: number }
  | { kind: 'event'; event: import('./cloud').CloudEvent }
