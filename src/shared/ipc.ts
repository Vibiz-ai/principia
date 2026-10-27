import type { ActivitySnapshot, CleanupItem, CleanupResult, DiskUsage, TokenActivity, UsageRange, UsageSummary } from './usage'
import type { AuthorizeConnectionResponse, CloudAdapter, CloudAsk, CloudCompany, CloudDevice, CloudRunDetail, CloudRunSummary, CloudWorkspace, LoginLinkResponse, PassportProposal, ProviderAccount, ProviderCredentialKind, ProviderTestResponse, WorkspaceSummary } from './cloud'
import type { CloudDesktopEvent, CloudLinkState, CloudLoginStatus, CloudMoveChoices, CloudMovePlan, CloudMoveResult } from './types'
import type { CollabState, RunConversation } from './collab'
import type { ForumChannel, ForumCreateChannelRequest, ForumDecideRequest, ForumEvent, ForumInvite, ForumInviteRequest, ForumMember, ForumMessage, ForumPostRequest, ForumState } from './forum'
import type { CompanyProposal, ProposalDecision } from './chatCompany'
import { PLANS_CHANNELS, type PlansInvokeMap } from './plans'
import { CHAT_CHANNELS, CHAT_EVENTS, type ChatEventMap, type ChatInvokeMap } from './chat'
import { REMOTE_CHANNELS, REMOTE_EVENTS, type RemoteEventMap, type RemoteInvokeMap } from './remote'
import { BROWSER_CHANNELS, BROWSER_EVENTS, type BrowserEventMap, type BrowserInvokeMap } from './browser'
import { UPDATES_CHANNELS, UPDATES_EVENTS, type UpdatesEventMap, type UpdatesInvokeMap } from './updates'
import type { GithubTaskPreview, BoardSettings, CompanyAgent, CompanyAgentSaveInput, CompanyCreateInput, CompanyLogo, CompanyOverview, CompanyPauseResult, LogoCandidate, LogoPick, CompanyPassport, CompanyPassportInput, CompanyTask, CompanyTaskInput, CompanyUpdateInput, Department, DepartmentPresetKey, DepartmentSaveInput, PassportExport, TaskActivity, TaskDetail } from './company'
/**
 * Typed IPC contract between main and renderer. The ONLY bridge is `window.hive` (src/preload).
 * Channel naming: invoke `<domain>:<verb>`, fire-and-forget send `<domain>:<verb>`, events `evt:<name>`.
 * Normative companion of docs/CONTRACT.md section 4.
 */
import type {
  AgentProfile,
  AgentProfileInput,
  AppInfo,
  Artifact,
  ArtifactKind,
  CanvasSnapshot,
  CompanyFilter,
  CompanyStamped,
  EnvImportEntry,
  HiveErrorShape,
  HomeData,
  Id,
  ProviderInfo,
  Repo,
  Run,
  RunDetail,
  RunStatus,
  RunStep,
  RunTarget,
  Schedule,
  ScheduleEvent,
  ScheduleInput,
  SchedulePreview,
  ScheduleWhen,
  SecretMeta,
  Session,
  SessionStatus,
  Settings,
  StatusSnapshot,
  ValidationError,
  Workflow,
  WorkflowDraft,
  AdapterId,
  LeftoverProcess
} from './types'
import type {
  MemoryChangedEvent,
  MemoryEntityDetail,
  MemoryFact,
  MemoryFactQuery,
  MemoryGrantInfo,
  MemoryGraph,
  MemoryGraphQuery,
  MemoryMode,
  MemoryMutation,
  MemoryMutationResult,
  MemoryOverview,
  MemoryScopeFilter,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryTargetKind
} from './memory'
import type { AgentDetail, AgentEvent, AgentListQuery, AgentNode as LiveAgentNode, Ask, AskAnswer, DashboardData } from './live'
import type {
  OpenPassportExportResult,
  OpenPassportImportResult,
  OpenPassportPreview,
  OpenPassportSyncRequest,
  OpenPassportSyncResult,
  OpResult,
  PassportConnectRequest,
  PassportConnectResult,
  PassportImportRequest,
  PassportImportResult,
  PassportChangedFields,
  PassportGraphRequest,
  PassportGraphResults,
  PassportLinksRequest,
  PassportLinksResults,
  PassportNoteRequest,
  PassportNoteResults,
  PassportProposalsRequest,
  PassportProposalsResults,
  PassportVaultRequest,
  PassportVaultResults
} from './passport'
import type {
  AuthorDecideRequest,
  AuthorDraft,
  AuthorDraftDetail,
  AuthorDraftStatus,
  AuthorRunGrant,
  ClaudeTranscript,
  HistoryListQuery,
  HistoryListResult,
  NotifyResult
} from './authoring'
import type { RunBranch, RunWorktree } from './types'
import type { MarketInstallResult, MarketList, MarketPreview, MarketRef } from './marketplace'
import type { DashboardConfig, DashboardInstallInput, DashboardKeyLookup, DashboardKind, DashboardSnapshot, InstalledDashboard } from './dashboards'
import type { LinearConnectInput, LinearKeyCheck, LinearStatusView } from './linear'
import type {
  SlackChannel,
  SlackDraft,
  SlackDraftDetail,
  SlackDraftStatus,
  SlackMessage,
  SlackMessagePage,
  SlackSearchHit,
  SlackSearchQuery,
  SlackStatus,
  SlackTestResult,
  SlackThread,
  SlackTrigger,
  SlackTriggerEvent,
  SlackTriggerInput,
  SlackTriggerTestResult,
  SlackUser
} from './slack'
import type {
  CloneProgressEvent,
  BriefResult,
  FolderCandidate,
  GithubRepo,
  KeyCheckResult,
  LaunchInput,
  LaunchResult,
  OnboardingKeyRequest,
  OnboardingStatus,
  PlanInput,
  PlanResult,
  ProgressEvent,
  ScanResult,
  SiteSummary,
  SoftLaunchStep
} from './onboarding'

type V = void
/** COMPANY.md §7: live agents and asks carry their company (denormalized for badges). */
export type CompanyAgentNode = LiveAgentNode & CompanyStamped
export type CompanyAsk = Ask & CompanyStamped
/** COMPANY.md §4: null = Shared keys; absent = Shared (pre-company callers). */
type KeySpace = { companyId?: Id | null }

/** invoke channels: [request, response]. `void` request = call with no argument. */
/** PLANS.md: tasks:brief, tasks:proofPreview and the plans:* channels live in shared/plans.ts. */
export interface InvokeMap extends PlansInvokeMap, ChatInvokeMap, RemoteInvokeMap, BrowserInvokeMap, UpdatesInvokeMap {
  /** Rail order, Personal last; archived companies only with includeArchived (Settings → Companies). */
  'company:list': [{ includeArchived?: boolean } | V, CompanyPassport[]]
  'company:save': [{id?: string; passport: CompanyPassportInput}, CompanyPassport]
  // COMPANY.md §7: the company is renderer state; main keeps no "current company", so there is no company:switch
  'company:create': [CompanyCreateInput, CompanyPassport]
  'company:update': [{ id: Id; patch: CompanyUpdateInput }, CompanyPassport] // name, colour, sort, vault path
  /** Archive replaces delete (data kept); archived: false restores. Personal cannot be archived. */
  'company:archive': [{ id: Id; archived?: boolean }, CompanyPassport]
  'company:reorder': [{ ids: Id[] }, CompanyPassport[]]
  /** Future runs and sessions only. Refused with open tasks or anything live on the repo. companyId co_personal = unassign. */
  'company:assignRepo': [{ repoId: Id; companyId: Id }, CompanyPassport]
  'company:overview': [V, CompanyOverview[]]
  /** Five doors A4: pause or resume ONE company (agents, schedules, autopilot; work in flight is saved) */
  'company:pause': [{ id: Id; paused: boolean }, CompanyPauseResult]
  /** Rail coin / chip logos of the listed companies (auto logos re-detect when their repositories changed). */
  'company:logos': [V, CompanyLogo[]]
  /** The picker grid: logo-like images found in the company's repositories, best first. */
  'company:logoCandidates': [{ id: Id }, LogoCandidate[]]
  /** Copies the pick into the company's app data. `file` opens the native dialog; null = the dialog was canceled. */
  'company:setLogo': [{ id: Id; pick: LogoPick }, CompanyLogo | null]
  'company:export': [{id: string}, PassportExport]
  'company:previewImport': [{json: string}, PassportExport]
  'company:import': [{json: string; repoIds: string[]}, CompanyPassport]
  /** Open Passport (open-passport SPEC.md): main asks where to save the `.passport.zip`; null when cancelled */
  'company:exportOpenPassport': [{id: Id}, OpenPassportExportResult | null]
  /** reads a passport folder or `.passport.zip` (main shows the picker when `source` is absent); null when cancelled */
  'company:previewOpenPassport': [{source?: string} | V, OpenPassportPreview | null]
  /** `new` creates a company (and its departments) from the passport; `merge` merges it into `companyId` */
  'company:importOpenPassport': [{source: string; mode: 'new' | 'merge'; companyId?: Id; repoIds?: Id[]}, OpenPassportImportResult]
  /** Publish / sync with an Open Passport host (SPEC.md §11.4): get / set / clear the company's host, or sync now */
  'company:openPassportSync': [OpenPassportSyncRequest, OpenPassportSyncResult]
  /** "Use this Passport in other apps": configs, one-click installs (only on click), host sign-in, queued writes → Inbox */
  'company:passportConnect': [PassportConnectRequest, PassportConnectResult]
  /** "Import into Passport": a ChatGPT / Claude export, a folder, a website or text → Inbox proposals; null when the picker is cancelled */
  'company:passportImport': [PassportImportRequest, PassportImportResult | null]
  'tasks:previewGithub': [{url: string}, GithubTaskPreview]
  'tasks:list': [{companyId?: string} | V, CompanyTask[]]
  'tasks:create': [{task: CompanyTaskInput}, CompanyTask]
  'tasks:update': [{id: string; patch: Partial<CompanyTaskInput>}, CompanyTask]
  'tasks:get': [{id: string}, TaskDetail]
  'tasks:start': [{id: string; profileId?: string}, CompanyTask]
  'tasks:comment': [{id: string; message: string; by?: 'human' | 'agent'}, TaskActivity]
  // DEPARTMENTS.md §10. Every channel below refuses (forbidden) unless experimental.companies and .departments are on.
  /** companyId absent = every company. Sidebar order; archived only with includeArchived. */
  'departments:list': [{ companyId?: Id; includeArchived?: boolean } | V, Department[]]
  /** No id = create. The key is fixed at creation; companyId never changes. */
  'departments:save': [DepartmentSaveInput, Department]
  /** Refused (conflict) while the department has open tasks; the message names them. archived=false restores. */
  'departments:archive': [{ id: Id; archived?: boolean }, Department]
  'departments:reorder': [{ companyId: Id; ids: Id[] }, Department[]]
  /** §9 preset chips: all six (or `keys`) in one call, idempotent by key. Returns the company's departments. */
  'departments:createPresets': [{ companyId: Id; keys?: DepartmentPresetKey[] }, Department[]]
  /** Named apart from the live hub's agents:*. departmentId null = company-level agents only. */
  'companyAgents:list': [{ companyId?: Id; departmentId?: Id | null; includeArchived?: boolean } | V, CompanyAgent[]]
  'companyAgents:save': [CompanyAgentSaveInput, CompanyAgent]
  /** Refused (conflict) while the agent has a task in flight. archived=false restores. */
  'companyAgents:archive': [{ id: Id; archived?: boolean }, CompanyAgent]
  'companyAgents:pause': [{ id: Id }, CompanyAgent]
  'companyAgents:resume': [{ id: Id }, CompanyAgent]
  /** Sets department and/or agent (absent = unchanged, null = clear); routing.by 'human'. Refused while in flight. */
  'tasks:assign': [{ id: Id; departmentId?: Id | null; agentId?: Id | null }, CompanyTask]
  /** Applies the task's model routing suggestion (§2 step 4). */
  'tasks:acceptRoute': [{ id: Id }, CompanyTask]
  /** Answers the board ask of a blocked(needs_input) task: back to todo and the same agent resumes. */
  'tasks:answer': [{ id: Id; answer: string }, CompanyTask]
  /** in_review -> done, human only; the note is required. */
  'tasks:approve': [{ id: Id; doneNote: string }, CompanyTask]
  /** in_review -> todo + wake; the note becomes the next turn's prompt. */
  'tasks:sendBack': [{ id: Id; note: string }, CompanyTask]
  /** blocked (any reason but deps) -> todo; resets the wake counter. */
  'tasks:unpark': [{ id: Id }, CompanyTask]
  /** Starts the task as an interactive PTY session (sessions.task_id) holding the lease. */
  'tasks:openSession': [{ id: Id; cols: number; rows: number }, { task: CompanyTask; session: Session }]
  /** Cancels the in-flight headless run and opens a session resuming agentSessionId. */
  'tasks:takeover': [{ id: Id; cols: number; rows: number }, { task: CompanyTask; session: Session }]
  /** Cancels the task's run or session; the task parks per §1.4. */
  'tasks:stop': [{ id: Id }, CompanyTask]
  /** Five doors C9: "Pause this task". The run ends; the task goes back to To do with its work kept, held until Start. */
  'tasks:pause': [{ id: Id }, CompanyTask]
  /** The company's Autopilot switch (default off); maxInFlight optional (default 3). */
  'board:autopilot': [{ companyId: Id; on: boolean; maxInFlight?: number; confirmed?: boolean }, BoardSettings]
  /** AUTOPILOT.md §7: the To do tasks turning Autopilot on would start ("N tasks will start") */
  'board:autopilotPreview': [{ companyId: Id }, import('./company').AutopilotPreview]
  /** AUTOPILOT.md §6: autopilot playbooks of one company (every playbook, on or off) */
  'playbooks:list': [{ companyId: Id }, import('./autopilotPlaybooks').PlaybookView[]]
  /** the playbooks on in every company (the header chip, Home, the rail, All companies) */
  'playbooks:summary': [undefined, import('./autopilotPlaybooks').PlaybookSummary]
  'playbooks:overview': [{ companyId: Id }, import('./autopilotOverview').AutopilotOverview]
  /** the founder's yes: creates the playbook's schedule; a money playbook above Level 2 needs raise: true */
  'playbooks:turnOn': [{ companyId: Id; playbookId: string; level: number; raise?: boolean; limits?: { maxChanges?: number; budgetCapUsd?: number | null; targets?: string[] } }, import('./autopilotPlaybooks').PlaybookView]
  'playbooks:configure': [{ companyId: Id; playbookId: string; level?: number; raise?: boolean; limits?: { maxChanges?: number; budgetCapUsd?: number | null; targets?: string[] } }, import('./autopilotPlaybooks').PlaybookView]
  'playbooks:setPaused': [{ companyId: Id; playbookId: string; paused: boolean }, import('./autopilotPlaybooks').PlaybookView]
  'playbooks:turnOff': [{ companyId: Id; playbookId: string }, void]
  // WORKTREE.md: a code task's own worktree, branch and PR
  /** Start: a new worktree + branch and the agent on it (in_progress), or queued beyond maxInFlight. */
  'taskWork:start': [{ id: Id; profileId?: Id }, { task: CompanyTask; queued: boolean; message: string }]
  /** Merge…: a native confirm in main, then gh pr merge --squash. null = the founder said no. */
  'taskWork:merge': [{ id: Id }, { task: CompanyTask; message: string } | null]
  /** Remove Worktree…: a native confirm listing what would be lost, then the removal. null = the founder said no. */
  'taskWork:remove': [{ id: Id }, CompanyTask | null]
  /** The gone-worktree banner: Cancel Task · Back to Backlog · Keep As Is. */
  'taskWork:resolveGone': [{ id: Id; choice: 'cancel' | 'backlog' | 'keep' }, CompanyTask]
  /** Window focus: check the worktrees and open PRs now (at most every 10 s). */
  'taskWork:refresh': [V, { ok: true }]
  /** Open in Editor: Cursor, VS Code or Zed when installed, else Finder. */
  'taskWork:openEditor': [{ id: Id }, { opened: 'editor' | 'finder' }]
  // FORUM.md §9: the company Forum. Refused (forbidden) unless experimental.companies and .departments are on.
  'forum:state': [{ companyId: Id }, ForumState]
  'forum:messages': [{ companyId: Id; channelId: Id; beforeSeq?: number; limit?: number }, { messages: ForumMessage[]; hasMore: boolean }]
  'forum:thread': [{ messageId: Id }, { root: ForumMessage; replies: ForumMessage[] }]
  'forum:post': [ForumPostRequest, ForumMessage]
  /** text null = delete */
  'forum:edit': [{ messageId: Id; text: string | null }, ForumMessage]
  'forum:react': [{ messageId: Id; emoji: string }, ForumMessage]
  'forum:markRead': [{ channelId: Id; seq?: number }, void]
  'forum:createChannel': [ForumCreateChannelRequest, ForumChannel]
  'forum:updateChannel': [{ channelId: Id; topic?: string; purpose?: string; archived?: boolean }, ForumChannel]
  'forum:membership': [{ op: 'join' | 'leave'; channelId: Id } | { op: 'add'; channelId: Id; memberIds: Id[] } | { op: 'remove'; memberId: Id }, void]
  'forum:openDm': [{ companyId: Id; memberIds: Id[] }, ForumChannel]
  'forum:search': [{ companyId: Id; query: string; limit?: number }, ForumMessage[]]
  'forum:decide': [ForumDecideRequest, ForumMessage]
  'forum:answer': [{ messageId: Id; answer: string }, ForumMessage]
  'forum:invite': [ForumInviteRequest, ForumInvite]
  'forum:invites': [{ companyId: Id }, ForumInvite[]]
  'forum:revokeInvite': [{ inviteId: Id }, ForumInvite]
  'forum:acceptInvite': [{ code: string; name: string; handle?: string }, ForumMember]
  'forum:toTask': [{ messageId: Id; agentId?: Id | null }, { id: Id; identifier: string }]
  /** AGENT-COLLAB.md §5: agent conversations of a company (Agent talk panel) and the Forum conversation of one run */
  'forum:collab': [{ companyId: Id }, CollabState]
  'forum:runConversation': [{ runId: Id }, RunConversation | null]
  /** ORCHESTRATOR.md §5: what Principia did after one run (the Run view's "Principia after this run") */
  'orchestrator:forRun': [{ runId: Id }, import('./orchestrator').RunOrchestration | null]
  /** ORCHESTRATOR.md §3: what Principia suggests to the founder (Needs you), and the founder's yes or no */
  'orchestrator:suggestions': [{ companyId?: Id | null } | undefined, import('./orchestrator').OrchSuggestion[]]
  /** 'never': an autopilot offer that never comes back; `level`: the level an autopilot offer is turned on at */
  'orchestrator:decideSuggestion': [{ id: Id; decision: 'accept' | 'dismiss' | 'never'; level?: number }, { suggestion: import('./orchestrator').OrchSuggestion; detail: string }]
  /** ORCHESTRATOR.md §5: the chief of staff's latest batches (Activity) */
  'orchestrator:decisions': [{ companyId: Id; limit?: number }, import('./orchestrator').OrchDecisionRecord[]]

  'gateway:connect': [{ id: string }, import('./gateway').GatewayConnection]
  'gateway:disconnect': [{ id: string }, import('./gateway').GatewayConnection]
  /** five doors A1: with companyId, only what that company's agents get (shared + its own) */
  'gateway:list': [{ companyId?: Id } | void, import('./gateway').GatewayConnection[]]
  'gateway:save': [import('./gateway').GatewayConnectionInput, import('./gateway').GatewayConnection]
  'gateway:remove': [{ id: string }, void]
  'gateway:test': [{ id: string }, unknown]
  // app
  'app:info': [V, AppInfo]
  'app:status': [V, StatusSnapshot]
  'app:home': [V, HomeData]
  'app:canvas': [CompanyFilter | V, CanvasSnapshot] // companyId: that company's runs, schedules, sessions
  'app:quit': [V, V] // goes through the Cmd+Q confirm
  'app:openExternal': [{ url: string }, V] // http(s) web links only
  'app:showItemInFolder': [{ path: string }, V] // path confined to repos / userData
  /** Hide the main window (Cmd+W with no focused session, Cmd+Shift+W). App keeps running in the tray. */
  'app:hideWindow': [V, V]
  // settings
  'settings:get': [V, Settings]
  'settings:update': [Partial<Settings>, Settings]
  // providers
  'providers:list': [{ refresh?: boolean } | V, ProviderInfo[]]
  /** Five doors E12: is Claude Code signed in, and on which plan (`claude auth status`). Never a guess. */
  'providers:claudeAuth': [{ refresh?: boolean } | V, import('./providerAuth').ClaudeAuthStatus]
  // repos
  'repos:list': [CompanyFilter | V, Repo[]] // with companyId: that company's repos in its repo_order:<companyId>
  /** Native folder picker (multi), returns newly added. companyId: new repos are assigned to that company (§3). */
  'repos:pick': [CompanyFilter | V, Repo[]]
  'repos:add': [{ paths: string[]; companyId?: Id }, Repo[]] // drag-drop from Finder
  'repos:update': [{ id: Id; name: string }, Repo]
  /** Within the moved repo's company (both must share one; cross-company moves go through company:assignRepo). Returns all repos. */
  'repos:move': [{ id: Id; targetId: Id; placement: 'before' | 'after' }, Repo[]]
  'repos:remove': [{ id: Id }, V] // DB row only, never touches files
  'repos:siblings': [{ id: Id }, { path: string; name: string }[]] // git dirs next to repo, not yet added
  // profiles
  'profiles:list': [V, AgentProfile[]]
  'profiles:create': [AgentProfileInput, AgentProfile]
  'profiles:update': [{ id: Id } & Partial<AgentProfileInput>, AgentProfile]
  'profiles:remove': [{ id: Id }, V] // conflict if used by workflows/schedules
  // sessions (interactive PTY)
  'sessions:list': [{ status?: SessionStatus | 'all'; companyId?: Id } | V, Session[]]
  'sessions:create': [SessionCreateRequest, Session]
  'sessions:attach': [{ id: Id }, { session: Session; scrollback: string }]
  'sessions:kill': [{ id: Id }, Session] // resolves once exited (<= 2 s)
  'sessions:remove': [{ id: Id }, V] // exited only
  'sessions:rename': [{ id: Id; title: string }, Session]
  /** Exited session -> new running session, same profile + cwd; resumes agentSessionId when the adapter supports it. */
  'sessions:restart': [{ id: Id }, Session]
  'sessions:handoff': [{ id: Id; adapter: 'claude' | 'codex' }, Session]
  /** Image pasted or dropped without a file path (clipboard, browser drag) -> saved under userData/pastes; its path. */
  'sessions:saveImage': [{ id: Id; data: Uint8Array; type: PastedImageType }, { path: string }]
  // workflows
  'workflows:list': [CompanyFilter | V, Workflow[]]
  'workflows:get': [{ id: Id }, Workflow]
  'workflows:create': [WorkflowDraft & CompanyFilter, Workflow] // validation error -> code 'validation'; no companyId = Personal
  'workflows:update': [{ id: Id; draft: WorkflowDraft }, Workflow]
  'workflows:remove': [{ id: Id }, V]
  /** companyId: "Duplicate to company…" (new row, no seed key); absent = the source's company. */
  'workflows:duplicate': [{ id: Id; companyId?: Id }, Workflow]
  'workflows:validate': [WorkflowDraft, ValidationError[]]
  'workflows:export': [{ id: Id }, { path: string } | null] // native save dialog; null = canceled
  'workflows:import': [CompanyFilter | V, Workflow | null] // native open dialog; installs into companyId (else Personal)
  // marketplace (built-in catalog + Settings.marketplaceUrl)
  'marketplace:list': [{ refresh?: boolean } | V, MarketList]
  'marketplace:preview': [MarketRef, MarketPreview]
  'marketplace:install': [MarketRef & { overwrite?: boolean; companyId?: Id }, MarketInstallResult] // workflows go to companyId (else Personal)
  // DASHBOARDS.md §8: department dashboards. Refused (forbidden) unless experimental.companies and .departments are on.
  /** departmentId absent = every dashboard of the company; null = company-level ones only. */
  'dashboards:list': [{ companyId: Id; departmentId?: Id | null }, InstalledDashboard[]]
  /** Which of a kind's keys this company already has, and where (masked). Never a value. */
  'dashboards:keys': [{ companyId: Id; kind: DashboardKind }, DashboardKeyLookup[]]
  /** Checks the keys with a real read-only call first; nothing is saved when that fails. Keys never come back. */
  'dashboards:install': [DashboardInstallInput, InstalledDashboard]
  'dashboards:update': [{ id: Id; config?: DashboardConfig; keys?: Record<string, string> }, InstalledDashboard]
  /** Fetches now and resolves with the result (a failure is in `status`, not thrown). */
  'dashboards:refresh': [{ id: Id }, InstalledDashboard]
  /** The keys stay in the company's keys. */
  'dashboards:remove': [{ id: Id }, V]
  /** The marketplace preview: the dashboard on sample data. */
  'dashboards:sample': [{ kind: DashboardKind }, DashboardSnapshot]
  // LINEAR.md §6: optional Linear sync per company. A key goes in (checkKey, connect), never comes back out.
  'linear:status': [{ companyId: Id }, LinearStatusView]
  'linear:checkKey': [{ companyId: Id; key?: string }, LinearKeyCheck]
  /** Five doors E13: how many issues connecting would bring in (the first pull), before connecting. */
  'linear:preview': [{ companyId: Id; teamId: string; key?: string }, import('./linear').LinearPreview]
  'linear:connect': [LinearConnectInput, LinearStatusView]
  'linear:sync': [{ companyId: Id }, LinearStatusView]
  'linear:setAutosync': [{ companyId: Id; on: boolean }, LinearStatusView]
  /** Forgets the key and unlinks the tasks; Linear is not touched. */
  'linear:disconnect': [{ companyId: Id }, LinearStatusView]
  // runs
  /** companyId: the explicit stamp, last in the inheritance chain (workflow, then target repo, then this, §3). */
  'runs:start': [{ target: RunTarget; companyId?: Id }, Run]
  'runs:list': [RunListQuery | V, Run[]]
  'runs:get': [{ id: Id }, RunDetail]
  'runs:cancel': [{ id: Id }, V]
  'runs:rerun': [{ id: Id }, Run]
  'runs:stepLog': [{ runId: Id; stepId: Id; tailBytes?: number; view?: 'raw' | 'readable' }, { text: string; truncated: boolean }]
  'runs:openAsSession': [{ runId: Id; stepId?: Id }, Session]
  // schedules
  'schedules:list': [CompanyFilter | V, Schedule[]]
  /** Stamped from its workflow (or the prompt's repo, then companyId, then Personal); cross-company targets are guarded. */
  'schedules:create': [ScheduleInput & CompanyFilter, Schedule]
  'schedules:update': [{ id: Id; input: ScheduleInput }, Schedule]
  'schedules:remove': [{ id: Id }, V]
  'schedules:setEnabled': [{ id: Id; enabled: boolean }, Schedule]
  /** null: a task-mode schedule posted to its standing board card instead (DEPARTMENTS.md §8) */
  'schedules:runNow': [{ id: Id }, Run | null]
  'schedules:preview': [{ when: ScheduleWhen }, SchedulePreview]
  'schedules:events': [{ scheduleId: Id; limit?: number }, ScheduleEvent[]]
  'schedules:pauseAll': [{ paused: boolean }, StatusSnapshot]
  // secrets (vault). COMPANY.md §4: companyId null/absent = Shared, else that company's keys (override a shared name)
  /** absent: every key (shared + all companies); null: shared only; an id: that company's keys + shared. */
  'secrets:list': [KeySpace | V, SecretMeta[]]
  'secrets:set': [{ name: string; value: string; label?: string } & KeySpace, SecretMeta]
  'secrets:remove': [{ name: string } & KeySpace, V]
  'secrets:reveal': [{ name: string } & KeySpace, { value: string }] // explicit user action only
  'secrets:copy': [{ name: string } & KeySpace, V] // main writes clipboard, plaintext never crosses IPC
  'secrets:parseEnv': [{ text: string } & KeySpace, EnvImportEntry[]] // preview, stores nothing; `exists` within that space
  'secrets:importEnv': [{ text: string; names: string[] } & KeySpace, SecretMeta[]] // commit selected names
  'secrets:pickEnvFile': [KeySpace | V, { path: string; entries: EnvImportEntry[]; text: string } | null]
  /** "Move to company…" / "Make shared" (to: null). conflict when the target already has that name. Plaintext stays in main. */
  'secrets:move': [{ name: string; from: Id | null; to: Id | null }, SecretMeta]
  // artifacts
  'artifacts:list': [ArtifactQuery | V, Artifact[]]
  /** PNG data URL from the macOS Quick Look thumbnailer (nativeImage.createThumbnailFromPath), cached in
   *  <userData>/thumbs/; falls back to app.getFileIcon. */
  'artifacts:thumbnail': [{ id: Id; size?: number }, { dataUrl: string }]
  'artifacts:trash': [{ id: Id }, V] // shell.trashItem after renderer got ui:confirm
  'artifacts:quickLook': [{ id: Id }, V] // BrowserWindow.previewFile
  'artifacts:open': [{ id: Id }, V] // shell.openPath
  'artifacts:reveal': [{ id: Id }, V] // shell.showItemInFolder
  'artifacts:copyPath': [{ id: Id }, V]
  'artifacts:openDir': [{ runId?: Id; sessionId?: Id }, V] // opens ARTIFACTS_DIR in Finder
  /** First bytes of a text-like artifact (markdown/html/code), UTF-8, for the app's own text tiles. */
  'artifacts:peek': [{ id: Id; bytes?: number }, { text: string }]
  // native UI helpers (renderer never draws its own context menus or destructive confirms)
  'ui:contextMenu': [{ items: NativeMenuItem[] }, string | null] // Menu.popup; resolves clicked id, null = dismissed
  'ui:confirm': [ConfirmRequest, boolean] // dialog.showMessageBox; true = confirm button
  'ui:setEdited': [{ edited: boolean }, V] // win.setDocumentEdited
  'clipboard:writeText': [{ text: string }, V]
  // memory (CONTRACT §11.5; PO10 amended to 17 channels by PASSPORT.md §11). Every request may name its company.
  'memory:overview': [CompanyFilter | V, MemoryOverview]
  /** v1 query (no `op`): <= 150 entities ranked by degree + facts + recency. Passport ops: global, local, layout. */
  'memory:graph': [(MemoryGraphQuery & CompanyFilter) | PassportGraphRequest, MemoryGraph | PassportGraphResults[keyof PassportGraphResults]]
  'memory:entity': [{ id: Id } & CompanyFilter, MemoryEntityDetail] // not_found if deleted
  'memory:search': [MemorySearchQuery & CompanyFilter, MemorySearchHit[]] // same ranking as the MCP tools
  'memory:facts': [MemoryFactQuery & CompanyFilter, { items: MemoryFact[]; total: number }] // newest first
  'memory:mutate': [MemoryMutation & CompanyFilter, MemoryMutationResult]
  /** Hard delete + event scrub; renderer must ui:confirm first. (Vault mode: archive, never a deletion.) */
  'memory:delete': [{ kind: MemoryTargetKind; ids: Id[] } & CompanyFilter, V]
  /** Invalidates the run's live writes and restores what they superseded. One-way; restore single rows from History. */
  'memory:revertRun': [{ runId: Id }, { invalidated: number; restored: number }]
  'memory:grants': [{ runId?: Id; sessionId?: Id } & CompanyFilter, MemoryGrantInfo[]]
  'memory:setPaused': [{ paused: boolean }, MemoryOverview] // "Pause agent writes"
  /** Native save dialog, JSONL; null = canceled. */
  'memory:export': [{ scope: MemoryScopeFilter['scope'] } & CompanyFilter, { path: string } | null]
  // Passport vault (PASSPORT.md §11): op-multiplexed; window.hive.memory.<channel>(req) is typed per op (see HiveApi)
  'memory:note': [PassportNoteRequest, PassportNoteResults[keyof PassportNoteResults]]
  'memory:links': [PassportLinksRequest, PassportLinksResults[keyof PassportLinksResults]]
  'memory:proposals': [PassportProposalsRequest, PassportProposalsResults[keyof PassportProposalsResults]]
  'memory:vault': [PassportVaultRequest, PassportVaultResults[keyof PassportVaultResults]]
  // live agents (CONTRACT §12.6)
  'agents:list': [AgentListQuery & CompanyFilter, CompanyAgentNode[]]
  'agents:get': [{ id: Id; eventsLimit?: number }, AgentDetail]
  'agents:events': [{ agentId: Id; beforeSeq?: number; limit?: number }, AgentEvent[]]
  /** Live session root with needs='idle': PTY write text + '\r'. Otherwise conflict. */
  'agents:reply': [{ agentId: Id; text: string }, V]
  'asks:list': [{ status?: 'open' | 'all'; runId?: Id; sessionId?: Id; limit?: number; companyId?: Id } | V, CompanyAsk[]]
  /** conflict if not open (or the PTY prompt changed, A9); bad_request for an option not offered. */
  'asks:answer': [AskAnswer, Ask]
  'app:dashboard': [({ since?: string } & CompanyFilter) | V, DashboardData] // companyId: done, learned, activity of that company
  'app:markSeen': [V, V]
  'schedules:skipNext': [{ id: Id }, Schedule]
  // usage limits + leftover processes (CONTRACT §13)
  /** 'reset': one-off retry (rerun) at run.resetAt + 1 min, or in 1 h when the reset is unknown; 'cancel' drops it. */
  'runs:retryAt': [{ id: Id; when: 'reset' | 'cancel' }, Run]
  /** Rate-limited live session: 'now' types "continue" into the pane, 'reset' does that at the reset time, 'cancel' drops it. */
  'sessions:retry': [{ id: Id; when: 'now' | 'reset' | 'cancel' }, V]
  /** Tagged processes left over from an earlier Hive run (owner gone). Never killed automatically. */
  'processes:leftovers': [V, LeftoverProcess[]]
  /** Stops those leftovers (and their process trees). Only pids that are still leftovers are touched. */
  'processes:stop': [{ pids: number[] }, { stopped: number }]
  // authoring (CONTRACT §14.5, AUTHORING.md)
  'author:list': [({ status?: AuthorDraftStatus[]; limit?: number } & CompanyFilter) | V, AuthorDraft[]] // COMPANY.md §7
  'author:get': [{ id: Id }, AuthorDraftDetail]
  /** conflict if not pending; validation if the (edited) draft is invalid (draft stays pending). */
  'author:decide': [AuthorDecideRequest, AuthorDraft]
  'author:grants': [V, AuthorRunGrant[]]
  'author:revokeRun': [{ workflowId: Id; ownerKey: string }, V]
  /** shared/chatCompany.ts: the open "start a company from this chat" cards. */
  'chatCompany:list': [V, CompanyProposal[]]
  /** Confirm (opens the onboarding in the renderer) or decline a card; the chat's waiting tool call gets the outcome. */
  'chatCompany:decide': [ProposalDecision, CompanyProposal]
  /** "New company from chat" (codex panes, or by hand): a card with nobody waiting on it. */
  'chatCompany:open': [{ sessionId?: Id | null; name?: string; brief?: string }, CompanyProposal]
  'worktrees:list': [{ status?: RunWorktree['status'][] } | V, RunWorktree[]]
  'worktrees:remove': [{ id: Id; discardWork?: boolean }, RunWorktree]
  /** Local branches created while the run ran (any repo it touched) that are still there. */
  'worktrees:branches': [{ runId: Id }, RunBranch[]]
  /** Deletes branches the run created (the user confirmed, even with unpushed work). Returns what is left. */
  'worktrees:deleteBranches': [{ runId: Id; branches: { repoPath: string; name: string }[] }, RunBranch[]]
  'history:list': [HistoryListQuery | V, HistoryListResult]
  'history:get': [{ id: string }, ClaudeTranscript]
  'history:resume': [{ id: string; profileId?: Id; cols: number; rows: number } & CompanyFilter, Session] // companyId: for a folder no repo owns
  // USAGE.md: the Usage page and the portfolio Activity canvas
  'usage:summary': [{ range: UsageRange; companyId?: Id }, UsageSummary]
  'usage:disk': [{ fresh?: boolean } | V, DiskUsage]
  'usage:cleanupList': [V, CleanupItem[]]
  'usage:cleanup': [{ ids: string[] }, CleanupResult]
  'usage:tokens': [V, TokenActivity]
  /** Starts (or renews, every minute) the read-only watcher of outside Claude sessions; returns the snapshot. */
  'activity:open': [V, ActivitySnapshot]
  'activity:close': [V, V]
  // Slack (CONTRACT "Slack.5", SLACK.md §0.3 PO-S1/PO-S2). The renderer never receives a token value.
  'slack:status': [V, SlackStatus]
  'slack:manifest': [{ name?: string } | V, { json: string; yaml: string; createUrl: string }]
  /** PO-S1: the one Connect button (validate both tokens, store, start). Plaintext tokens cross IPC only here. */
  'slack:connect': [{ botToken: string; appToken: string }, SlackStatus]
  /** Re-runs the checklist on the stored tokens. */
  'slack:test': [V, SlackTestResult]
  'slack:retry': [V, SlackStatus]
  'slack:disconnect': [{ purge: boolean }, SlackStatus]
  'slack:channels': [{ query?: string } | V, SlackChannel[]]
  /** PO-S2: explicit click only (conversations.join). */
  'slack:join': [{ channelId: string }, SlackChannel]
  'slack:joinAll': [V, { joined: number; failed: number }]
  'slack:markRead': [{ channelId: string; ts: string }, V]
  'slack:users': [{ query?: string; includeBots?: boolean } | V, SlackUser[]]
  'slack:messages': [{ channelId: string; beforeTs?: string; limit?: number }, SlackMessagePage]
  'slack:thread': [{ channelId: string; threadTs: string }, SlackThread]
  'slack:search': [SlackSearchQuery, SlackSearchHit[]]
  'slack:backfill': [{ channelId?: string; days: number }, SlackStatus]
  'slack:askAgent': [{ channelId: string; threadTs: string; profileId?: Id; repoId?: Id | null; cols: number; rows: number }, Session]
  'slack:drafts': [{ status?: SlackDraftStatus[]; channelId?: string; threadTs?: string; runId?: Id } | V, SlackDraft[]]
  'slack:draftGet': [{ id: Id }, SlackDraftDetail]
  'slack:draftDecide': [{ id: Id; decision: 'send' | 'discard'; text?: string }, SlackDraft]
  'slack:testAlert': [V, NotifyResult]
  'slack:permalink': [{ channelId: string; ts: string }, { url: string }]
  /** COMPANY.md §3: the connected workspace's company (Personal after the migration); null = not connected. */
  'slack:company': [V, { teamId: string; companyId: Id } | null]
  /** Re-homes the connected workspace. Triggers whose workflow is in another company stop firing (the C4 guard). */
  'slack:setCompany': [{ companyId: Id }, { teamId: string; companyId: Id }]
  /** companyId: triggers whose workflow belongs to that company. Every trigger carries its workflow's company. */
  'slackTriggers:list': [{ workflowId?: Id; companyId?: Id } | V, (SlackTrigger & CompanyStamped)[]]
  'slackTriggers:create': [SlackTriggerInput, SlackTrigger]
  'slackTriggers:update': [{ id: Id; input: SlackTriggerInput }, SlackTrigger]
  'slackTriggers:remove': [{ id: Id }, V]
  'slackTriggers:setEnabled': [{ id: Id; enabled: boolean }, SlackTrigger]
  'slackTriggers:test': [{ input: SlackTriggerInput; sample: { permalink: string } | { channelId: string; ts: string } }, SlackTriggerTestResult]
  'slackTriggers:events': [{ triggerId: Id; limit?: number }, SlackTriggerEvent[]]
  // Business-first onboarding (ONBOARDING.md §4). Metadata and read-only intake until launch; keys cross IPC only in `key`.
  'onboarding:status': [V, OnboardingStatus]
  /** Native multi-folder dialog. Adds nothing: repos are attached at launch. */
  'onboarding:pickFolders': [V, FolderCandidate[]]
  /** Same checks as pickFolders, for drag-drop (≤ 8 paths). */
  'onboarding:inspectFolders': [{ paths: string[] }, FolderCandidate[]]
  /** Read-only, byte-capped, redacted, 5 s budget. */
  'onboarding:scan': [{ paths?: string[]; github?: { fullName: string } }, ScanResult]
  'onboarding:fetchSite': [{ url: string }, SiteSummary]
  'onboarding:github': [{ op: 'list'; query?: string }, GithubRepo[]]
  'onboarding:pickCloneDir': [V, string | null]
  /** check → KeyCheckResult (the value never comes back); forget → void. Typed per op on window.hive.onboarding.key. */
  'onboarding:key': [OnboardingKeyRequest, KeyCheckResult | V]
  /** Main recomputes what is available; the renderer cannot claim workflows or adapters. */
  'onboarding:plan': [{ requestId: string; input: PlanInput; useAgent: boolean }, PlanResult]
  'onboarding:cancelPlan': [{ requestId: string }, V]
  /** "From a prompt": About answers read from the brief (Claude when installed, else the deterministic fallback). */
  'onboarding:brief': [{ requestId: string; brief: string }, BriefResult]
  'onboarding:cancelBrief': [{ requestId: string }, V]
  /** A given journalId resumes. Emits onboarding:progress. One launch at a time per draft. */
  'onboarding:launch': [{ journalId?: string; draftId: string; input: LaunchInput }, LaunchResult]
  'onboarding:skipStep': [{ journalId: string; step: SoftLaunchStep }, LaunchResult]
  'onboarding:discard': [{ journalId: string }, { undone: string[] }]
  /** Only for the journal's own company; scheduleRefs are plan refs of schedules this journal created. */
  'onboarding:start': [{ journalId: string; autopilot: boolean; scheduleRefs: string[] }, BoardSettings | null]
  'onboarding:startPreview': [{ journalId: string; scheduleRefs: string[] }, OnboardingStartPreview]
  // Principia Cloud (CLOUD.md §13.1): the desktop link. No response carries a token, key or credential.
  'cloud:state': [V, CloudLinkState]
  /** the connect link (`<url>/pair#XXXX-XXXX`), or url + code from the hidden fallback */
  'cloud:pair': [{ link?: string; url?: string; code?: string }, CloudLinkState]
  'cloud:unlink': [V, CloudLinkState]
  'cloud:summary': [V, WorkspaceSummary]
  'cloud:providers': [V, ProviderAccount[]]
  /** a pasted key or token: write-only, crosses IPC only here */
  'cloud:providerPut': [{ adapter: CloudAdapter; kind: ProviderCredentialKind; value: string }, ProviderAccount[]]
  'cloud:providerDelete': [{ adapter: CloudAdapter }, ProviderAccount[]]
  'cloud:providerTest': [{ adapter: CloudAdapter; live?: boolean }, ProviderTestResponse]
  /** CLOUD.md §7.2: Connect Claude / Sign in with ChatGPT run on this Mac; progress arrives as evt:cloud state.login */
  'cloud:loginClaude': [V, CloudLoginStatus]
  'cloud:loginCodex': [V, CloudLoginStatus]
  'cloud:loginCancel': [V, V]
  'cloud:movePlan': [{ companyId: Id }, CloudMovePlan]
  'cloud:move': [CloudMoveChoices, CloudMoveResult]
  'cloud:runOnce': [{ companyId: Id; workflowId?: Id }, CloudRunSummary]
  /** schedules back to this Mac, then the company is deleted from the cloud (the renderer confirms first) */
  'cloud:bringBack': [{ companyId: Id }, CloudLinkState]
  'cloud:runs': [{ companyId?: Id; limit?: number } | V, CloudRunSummary[]]
  'cloud:run': [{ id: Id }, CloudRunDetail]
  'cloud:runLog': [{ id: Id; stepId?: Id; tail?: number }, { lines: string[] }]
  'cloud:runCancel': [{ id: Id }, V]
  'cloud:asks': [V, CloudAsk[]]
  'cloud:answer': [{ id: Id; answer: string }, CloudAsk]
  'cloud:proposals': [{ companyId: Id }, PassportProposal[]]
  'cloud:decideProposal': [{ companyId: Id; proposalId: string; decision: 'accept' | 'reject' }, V]
  'cloud:devices': [V, CloudDevice[]]
  'cloud:revokeDevice': [{ id: Id }, CloudDevice[]]
  /** a fresh one-time console login link (open: also opens it in the browser) */
  'cloud:loginLink': [{ open?: boolean } | V, LoginLinkResponse]
  'cloud:pause': [{ paused: boolean }, CloudWorkspace]
  'cloud:pauseCompany': [{ companyId: Id; paused: boolean }, CloudCompany]
  /** opens the provider's consent page in the browser; it calls back to the cloud */
  'cloud:connectionAuthorize': [{ companyId: Id; connectionId: string }, AuthorizeConnectionResponse]
}

export interface NativeMenuItem {
  id?: string // returned when clicked
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  accelerator?: string // display only
  submenu?: NativeMenuItem[]
}
export interface ConfirmRequest {
  message: string // "Kill Claude in example-project?"
  detail?: string
  confirmLabel: string // verb: "Kill Session", "Delete Key"
  destructive?: boolean
  /** When set, main shows a "Don't ask again" checkbox; once checked, later confirms with the same key
   *  resolve true without showing a dialog (persisted by main). */
  suppressKey?: string
}

/** fire-and-forget renderer -> main (ipcRenderer.send). */
export interface SendMap {
  /** typed: false = xterm generated these bytes (query replies, focus reports), not a user keystroke (LIVE.md A4b) */
  'sessions:write': { id: Id; data: string; typed?: boolean }
  'sessions:resize': { id: Id; cols: number; rows: number }
  'artifacts:startDrag': { id: Id } // call from dragstart; main calls webContents.startDrag
  'ui:ready': void // renderer mounted; main flushes pending ui:command (e.g. notification click)
  /** What the user is looking at: suppresses notifications for it and marks idle sessions seen (LIVE.md A3). */
  'ui:visibleOwner': { sessionId?: Id | null; runId?: Id | null }
}

/** main -> renderer events. Subscribe with window.hive.on(name, cb). */
export interface EventMap extends ChatEventMap, RemoteEventMap, BrowserEventMap, UpdatesEventMap {
  'pty:data': { sessionId: Id; data: string } // batched ~16 ms, redacted
  'pty:exit': { sessionId: Id; exitCode: number | null; signal: number | null }
  'session:updated': Session
  'run:updated': Run
  'run:step': RunStep
  'run:output': { runId: Id; stepId: Id; chunk: string } // live headless output, redacted
  'artifact:added': Artifact
  'artifact:removed': { id: Id }
  'schedule:updated': Schedule
  'schedule:fired': { event: ScheduleEvent; scheduleName: string }
  'status:changed': StatusSnapshot // drives status bar; same data as tray
  'providers:changed': ProviderInfo[]
  'settings:changed': Settings
  /** Window focus / fullscreen, drives .is-inactive / .is-fullscreen on <html>. */
  'window:state': { focused: boolean; fullscreen: boolean }
  /** Coarse invalidation for lists without dedicated events. */
  'data:changed': { domain: 'company' | 'tasks' | 'departments' | 'repos' | 'profiles' | 'workflows' | 'secrets' | 'schedules' | 'dashboards' }
  /** Navigation/commands from app menu, tray, notifications, dock. */
  'ui:command': UiCommand
  /** New mem_event rows (any process) or a page write committed. Refetch visible data, debounced. */
  'memory:changed': MemoryChangedEvent & PassportChangedFields
  'agent:updated': CompanyAgentNode // coalesced 150 ms
  'agent:events': { agentId: Id; events: AgentEvent[] } // coalesced 100 ms
  'ask:updated': CompanyAsk
  /** Leftover processes changed (launch scan, Stop, Stop all). */
  'processes:changed': LeftoverProcess[]
  // authoring (CONTRACT §14.5)
  'author:updated': AuthorDraft
  'chatCompany:updated': CompanyProposal
  'worktree:updated': RunWorktree
  'history:changed': { total: number }
  'activity:changed': ActivitySnapshot // USAGE.md §4, at most every 2 s while the Activity layer is open
  // Slack (CONTRACT "Slack.5")
  'slack:status': SlackStatus
  'slack:channels': SlackChannel[]
  'slack:messages': { channelId: string; messages: SlackMessage[] }
  'slack:draft': SlackDraft
  'slackTrigger:updated': SlackTrigger
  // ONBOARDING.md §4
  'onboarding:progress': ProgressEvent
  'onboarding:cloneProgress': CloneProgressEvent
  // FORUM.md §9
  'forum:event': ForumEvent
  // CLOUD.md §13.1: the desktop link's state, server changes and SSE events (evt:cloud)
  cloud: CloudDesktopEvent
}

export type UiCommand =
  | { kind: 'navigate'; view: View }
  | { kind: 'openRun'; runId: Id }
  | { kind: 'openSession'; sessionId: Id }
  | { kind: 'newSession'; repoId?: Id | null } // Cmd+N / tray "New session…"
  | { kind: 'newWorkflow' } // Cmd+Shift+N
  | { kind: 'addRepo' } // Cmd+O (main already showed picker? no: renderer calls repos:pick)
  | { kind: 'toggleSidebar' } // Cmd+B
  | { kind: 'commandPalette' } // Cmd+K
  | { kind: 'openSettings' } // Cmd+,
  | { kind: 'newChat' } // Alt+Cmd+N
  | { kind: 'closeSession' } // Cmd+W: close focused session (kill, confirm) or hide window if none
  | { kind: 'zoom'; dir: 'in' | 'out' | 'reset' } // Cmd+= / Cmd+- / Cmd+0 (canvas zoom or terminal font)
  | { kind: 'focusAgent'; agentId: Id } // notification / tray "Needs you" row
  | { kind: 'nextNeedsYou' } // Cmd+J
  | { kind: 'openApproval'; draftId: Id } // approval notification click (AUTHORING.md §2.2)
  | { kind: 'openSlack'; channelId?: string; threadTs?: string } // SLACK.md §12.2
  | { kind: 'openSlackDraft'; draftId: Id } // Slack draft notification click (SLACK.md §8.3)
  | { kind: 'openLink'; url: string } // a principia:// link from the OS (shared/deepLink.ts; checked by main, navigates only)
/** The app menu's View items. team, board, chats and knowledge are the five doors (⌘2-⌘5); the rest stay as aliases. */
export type View = 'home' | 'team' | 'board' | 'chats' | 'knowledge' | 'chat' | 'canvas' | 'workflows' | 'schedules' | 'artifacts' | 'keys' | 'settings' | 'memory' | 'agents'

export interface SessionCreateRequest {
  /**
   * COMPANY.md §6: the launching company ("+" in a company group). Absent = the repo's company, else Personal. Decides
   * keys, Passport, memory and the repo-less chat dir; a cwd inside another company's repo is refused.
   */
  companyId?: Id
  /** One of profileId | adapter. adapter -> the seeded default profile for that adapter. */
  profileId?: Id
  adapter?: AdapterId
  repoId?: Id | null // null/undefined + no cwd = Chat (scratch dir)
  cwd?: string
  cols: number
  rows: number
  title?: string
  /** Overrides Settings.sessionMemory for this session (CONTRACT §11.3). */
  memory?: MemoryMode
  /**
   * DEPARTMENTS.md §9: "New Chat in <Department>". A chat (repoId and cwd are ignored) of the department's company, with
   * the department's context; its cwd is the department's repo, else the company's single repo, else the workspace.
   */
  departmentId?: Id  /** Five doors C7: "New chat" with a first message (a company with no code reads the chat as a conversation). */
  initialPrompt?: string
}
export interface RunListQuery {
  status?: RunStatus[]
  workflowId?: Id
  scheduleId?: Id
  since?: string // ISO
  limit?: number // default 100
  companyId?: Id
}
export interface ArtifactQuery {
  runId?: Id
  sessionId?: Id
  kind?: ArtifactKind
  limit?: number // default 500, newest first
  companyId?: Id
}

// ---------- helpers that build the renderer-facing API type ----------
export type InvokeChannel = keyof InvokeMap
export type InvokeReq<C extends InvokeChannel> = InvokeMap[C][0]
export type InvokeRes<C extends InvokeChannel> = InvokeMap[C][1]
export type SendChannel = keyof SendMap
export type EventName = keyof EventMap

/** Wire envelope returned by every ipcMain.handle (preload unwraps; errors become HiveError). */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: HiveErrorShape }

type Split<S extends string> = S extends `${infer D}:${infer M}` ? [D, M] : never
type Domains = Split<InvokeChannel>[0]
type Fn<C extends InvokeChannel> = [InvokeReq<C>] extends [void]
  ? () => Promise<InvokeRes<C>>
  : undefined extends InvokeReq<C>
    ? (req?: Exclude<InvokeReq<C>, void>) => Promise<InvokeRes<C>>
    : void extends InvokeReq<C>
      ? (req?: Exclude<InvokeReq<C>, void>) => Promise<InvokeRes<C>>
      : (req: InvokeReq<C>) => Promise<InvokeRes<C>>
type DomainApi<D extends string> = {
  [C in InvokeChannel as C extends `${D}:${infer M}` ? M : never]: Fn<C>
}

export const PASTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type PastedImageType = (typeof PASTED_IMAGE_TYPES)[number]

/** PASSPORT.md §11 op channels: the result type follows the request's `op`. */
type OpFn<Req extends { op: string }, Results> = <R extends Req>(req: R) => Promise<OpResult<Results, R>>
type MemoryApi = Omit<DomainApi<'memory'>, 'note' | 'graph' | 'links' | 'proposals' | 'vault'> & {
  note: OpFn<PassportNoteRequest, PassportNoteResults>
  /** v1 query (no op) -> MemoryGraph; { op: 'global' | 'local' | 'layout' } -> the Passport graph results. */
  graph: <R extends (MemoryGraphQuery & CompanyFilter) | PassportGraphRequest>(
    req: R
  ) => Promise<R extends { op: string } ? OpResult<PassportGraphResults, R> : MemoryGraph>
  links: OpFn<PassportLinksRequest, PassportLinksResults>
  proposals: OpFn<PassportProposalsRequest, PassportProposalsResults>
  vault: OpFn<PassportVaultRequest, PassportVaultResults>
}

/** ONBOARDING.md §4: `key` is op-multiplexed; check returns the result, forget returns nothing. */
type OnboardingApi = Omit<DomainApi<'onboarding'>, 'key'> & {
  key: <R extends OnboardingKeyRequest>(req: R) => Promise<R extends { op: 'check' } ? KeyCheckResult : void>
}

/** `window.hive` */
export type HiveApi = { [D in Exclude<Domains, 'memory' | 'onboarding'>]: DomainApi<D> } & { memory: MemoryApi; onboarding: OnboardingApi } & {
  /** Fire-and-forget. */
  send<C extends SendChannel>(channel: C, payload: SendMap[C]): void
  /** Subscribe; returns unsubscribe. */
  on<E extends EventName>(event: E, cb: (payload: EventMap[E]) => void): () => void
  /** Absolute path of a File dropped from Finder (webUtils.getPathForFile). */
  pathForFile(file: File): string
  platform: 'darwin'
}

/** Runtime list of invoke channels (preload builds the facade from this; main asserts every one is handled). */
export const INVOKE_CHANNELS = [
  'company:list', 'company:save', 'company:export', 'company:previewImport', 'company:import',
  'company:exportOpenPassport', 'company:previewOpenPassport', 'company:importOpenPassport', 'company:openPassportSync',
  'company:passportConnect', 'company:passportImport',
  'company:create', 'company:update', 'company:archive', 'company:reorder', 'company:assignRepo', 'company:overview', 'company:pause', 'company:logos', 'company:logoCandidates', 'company:setLogo',
  'tasks:previewGithub', 'tasks:list', 'tasks:create', 'tasks:update', 'tasks:get', 'tasks:start', 'tasks:comment',
  'departments:list', 'departments:save', 'departments:archive', 'departments:reorder', 'departments:createPresets',
  'companyAgents:list', 'companyAgents:save', 'companyAgents:archive', 'companyAgents:pause', 'companyAgents:resume',
  'tasks:assign', 'tasks:acceptRoute', 'tasks:answer', 'tasks:approve', 'tasks:sendBack', 'tasks:unpark', 'tasks:openSession', 'tasks:takeover', 'tasks:stop', 'tasks:pause',
  'board:autopilot', 'board:autopilotPreview',
  'playbooks:list', 'playbooks:summary', 'playbooks:overview', 'playbooks:turnOn', 'playbooks:configure', 'playbooks:setPaused', 'playbooks:turnOff',
  'taskWork:start', 'taskWork:merge', 'taskWork:remove', 'taskWork:resolveGone', 'taskWork:refresh', 'taskWork:openEditor',
  'forum:state', 'forum:messages', 'forum:thread', 'forum:post', 'forum:edit', 'forum:react', 'forum:markRead', 'forum:createChannel',
  'forum:updateChannel', 'forum:membership', 'forum:openDm', 'forum:search', 'forum:decide', 'forum:answer', 'forum:invite', 'forum:invites',
  'forum:revokeInvite', 'forum:acceptInvite', 'forum:toTask', 'forum:collab', 'forum:runConversation',
  'orchestrator:forRun', 'orchestrator:suggestions', 'orchestrator:decideSuggestion', 'orchestrator:decisions',
  'gateway:connect', 'gateway:disconnect', 'gateway:list', 'gateway:save', 'gateway:remove', 'gateway:test',
  'app:info', 'app:status', 'app:home', 'app:canvas', 'app:quit', 'app:openExternal', 'app:showItemInFolder',
  'app:hideWindow',
  'settings:get', 'settings:update',
  'providers:list', 'providers:claudeAuth',
  'repos:list', 'repos:pick', 'repos:add', 'repos:update', 'repos:move', 'repos:remove', 'repos:siblings',
  'profiles:list', 'profiles:create', 'profiles:update', 'profiles:remove',
  'sessions:list', 'sessions:create', 'sessions:attach', 'sessions:kill', 'sessions:remove', 'sessions:rename',
  'sessions:restart', 'sessions:handoff', 'sessions:saveImage',
  'workflows:list', 'workflows:get', 'workflows:create', 'workflows:update', 'workflows:remove',
  'workflows:duplicate', 'workflows:validate', 'workflows:export', 'workflows:import',
  'marketplace:list', 'marketplace:preview', 'marketplace:install',
  'dashboards:list', 'dashboards:keys', 'dashboards:install', 'dashboards:update', 'dashboards:refresh', 'dashboards:remove', 'dashboards:sample',
  'linear:status', 'linear:checkKey', 'linear:preview', 'linear:connect', 'linear:sync', 'linear:setAutosync', 'linear:disconnect',
  'runs:start', 'runs:list', 'runs:get', 'runs:cancel', 'runs:rerun', 'runs:stepLog', 'runs:openAsSession',
  'schedules:list', 'schedules:create', 'schedules:update', 'schedules:remove', 'schedules:setEnabled',
  'schedules:runNow', 'schedules:preview', 'schedules:events', 'schedules:pauseAll',
  'secrets:list', 'secrets:set', 'secrets:remove', 'secrets:reveal', 'secrets:copy', 'secrets:parseEnv',
  'secrets:importEnv', 'secrets:pickEnvFile', 'secrets:move',
  'artifacts:list', 'artifacts:thumbnail', 'artifacts:trash', 'artifacts:quickLook', 'artifacts:open',
  'artifacts:reveal', 'artifacts:copyPath', 'artifacts:openDir', 'artifacts:peek',
  'ui:contextMenu', 'ui:confirm', 'ui:setEdited', 'clipboard:writeText',
  'memory:overview', 'memory:graph', 'memory:entity', 'memory:search', 'memory:facts', 'memory:mutate',
  'memory:delete', 'memory:revertRun', 'memory:grants', 'memory:setPaused', 'memory:export',
  'memory:note', 'memory:links', 'memory:proposals', 'memory:vault',
  'agents:list', 'agents:get', 'agents:events', 'agents:reply', 'asks:list', 'asks:answer', 'app:dashboard',
  'app:markSeen', 'schedules:skipNext',
  'runs:retryAt', 'sessions:retry', 'processes:leftovers', 'processes:stop',
  'author:list', 'author:get', 'author:decide', 'author:grants', 'author:revokeRun', 'chatCompany:list', 'chatCompany:decide', 'chatCompany:open', 'worktrees:list',
  'worktrees:remove', 'worktrees:branches', 'worktrees:deleteBranches', 'history:list', 'history:get', 'history:resume',
  'usage:summary', 'usage:disk', 'usage:cleanupList', 'usage:cleanup', 'usage:tokens', 'activity:open', 'activity:close',
  'slack:status', 'slack:manifest', 'slack:connect', 'slack:test', 'slack:retry', 'slack:disconnect', 'slack:channels',
  'slack:join', 'slack:joinAll', 'slack:markRead', 'slack:users', 'slack:messages', 'slack:thread', 'slack:search',
  'slack:backfill', 'slack:askAgent', 'slack:drafts', 'slack:draftGet', 'slack:draftDecide', 'slack:testAlert',
  'slack:permalink', 'slack:company', 'slack:setCompany', 'slackTriggers:list', 'slackTriggers:create', 'slackTriggers:update', 'slackTriggers:remove',
  'slackTriggers:setEnabled', 'slackTriggers:test', 'slackTriggers:events',
  'onboarding:status', 'onboarding:pickFolders', 'onboarding:inspectFolders', 'onboarding:scan', 'onboarding:fetchSite',
  'onboarding:github', 'onboarding:pickCloneDir', 'onboarding:key', 'onboarding:plan', 'onboarding:cancelPlan',
  'onboarding:brief', 'onboarding:cancelBrief', 'onboarding:launch', 'onboarding:skipStep', 'onboarding:discard', 'onboarding:start', 'onboarding:startPreview',
  'cloud:state', 'cloud:pair', 'cloud:unlink', 'cloud:summary', 'cloud:providers', 'cloud:providerPut', 'cloud:providerDelete',
  'cloud:providerTest', 'cloud:loginClaude', 'cloud:loginCodex', 'cloud:loginCancel', 'cloud:movePlan', 'cloud:move', 'cloud:runOnce',
  'cloud:bringBack', 'cloud:runs', 'cloud:run', 'cloud:runLog', 'cloud:runCancel', 'cloud:asks', 'cloud:answer', 'cloud:proposals',
  'cloud:decideProposal', 'cloud:devices', 'cloud:revokeDevice', 'cloud:loginLink', 'cloud:pause', 'cloud:pauseCompany', 'cloud:connectionAuthorize',
  ...PLANS_CHANNELS,
  // CHAT-UI.md §3.2
  ...CHAT_CHANNELS,
  // REMOTE.md
  ...REMOTE_CHANNELS,
  // BROWSER.md
  ...BROWSER_CHANNELS,
  // RELEASING.md §4
  ...UPDATES_CHANNELS
] as const satisfies readonly InvokeChannel[]

// compile-time check: INVOKE_CHANNELS covers InvokeMap exactly
type _Missing = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
const _exhaustive: [_Missing] extends [never] ? true : _Missing = true
void _exhaustive

export const SEND_CHANNELS = ['sessions:write', 'sessions:resize', 'artifacts:startDrag', 'ui:ready', 'ui:visibleOwner'] as const satisfies readonly SendChannel[]
export const EVENT_NAMES = [
  'pty:data', 'pty:exit', 'session:updated', 'run:updated', 'run:step', 'run:output', 'artifact:added',
  'artifact:removed', 'schedule:updated', 'schedule:fired', 'status:changed', 'providers:changed',
  'settings:changed', 'window:state', 'data:changed', 'ui:command', 'memory:changed', 'agent:updated',
  'agent:events', 'ask:updated', 'processes:changed', 'author:updated', 'chatCompany:updated', 'worktree:updated', 'history:changed',
  'activity:changed',
  'slack:status', 'slack:channels', 'slack:messages', 'slack:draft', 'slackTrigger:updated',
  'onboarding:progress', 'onboarding:cloneProgress', 'forum:event', 'cloud',
  ...CHAT_EVENTS,
  ...REMOTE_EVENTS,
  ...BROWSER_EVENTS,
  ...UPDATES_EVENTS
] as const satisfies readonly EventName[]
type _MissingEv = Exclude<EventName, (typeof EVENT_NAMES)[number]>
const _exhaustiveEv: [_MissingEv] extends [never] ? true : _MissingEv = true
void _exhaustiveEv

export const eventChannel = (e: EventName): string => `evt:${e}`

/** AUTOPILOT.md §7: what Start the first week turns on, shown before it is pressed. */
export interface OnboardingStartPreview {
  /** Autopilot (Auto-start) goes on; false with departments off or no agent CLI installed */
  autopilot: boolean
  noAgentCli: boolean
  /** tasks at once once it starts */
  maxInFlight: number
  /** agents that will start work on their own ("Marcus (Marketing)") */
  agents: string[]
  /** schedules that will start running, with when */
  schedules: { name: string; when: string }[]
}
