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

type V = void

/** invoke channels: [request, response]. `void` request = call with no argument. */
export interface InvokeMap {
  'gateway:connect': [{ id: string }, import('./gateway').GatewayConnection]
  'gateway:disconnect': [{ id: string }, import('./gateway').GatewayConnection]
  'gateway:list': [void, import('./gateway').GatewayConnection[]]
  'gateway:save': [import('./gateway').GatewayConnectionInput, import('./gateway').GatewayConnection]
  'gateway:remove': [{ id: string }, void]
  'gateway:test': [{ id: string }, unknown]
  // app
  'app:info': [V, AppInfo]
  'app:status': [V, StatusSnapshot]
  'app:home': [V, HomeData]
  'app:canvas': [V, CanvasSnapshot]
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
  // repos
  'repos:list': [V, Repo[]]
  'repos:pick': [V, Repo[]] // native folder picker (multi), returns newly added
  'repos:add': [{ paths: string[] }, Repo[]] // drag-drop from Finder
  'repos:update': [{ id: Id; name: string }, Repo]
  'repos:remove': [{ id: Id }, V] // DB row only, never touches files
  'repos:siblings': [{ id: Id }, { path: string; name: string }[]] // git dirs next to repo, not yet added
  // profiles
  'profiles:list': [V, AgentProfile[]]
  'profiles:create': [AgentProfileInput, AgentProfile]
  'profiles:update': [{ id: Id } & Partial<AgentProfileInput>, AgentProfile]
  'profiles:remove': [{ id: Id }, V] // conflict if used by workflows/schedules
  // sessions (interactive PTY)
  'sessions:list': [{ status?: SessionStatus | 'all' } | V, Session[]]
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
  'workflows:list': [V, Workflow[]]
  'workflows:get': [{ id: Id }, Workflow]
  'workflows:create': [WorkflowDraft, Workflow] // validation error -> code 'validation'
  'workflows:update': [{ id: Id; draft: WorkflowDraft }, Workflow]
  'workflows:remove': [{ id: Id }, V]
  'workflows:duplicate': [{ id: Id }, Workflow]
  'workflows:validate': [WorkflowDraft, ValidationError[]]
  'workflows:export': [{ id: Id }, { path: string } | null] // native save dialog; null = canceled
  'workflows:import': [V, Workflow | null] // native open dialog
  // marketplace (built-in catalog + Settings.marketplaceUrl)
  'marketplace:list': [{ refresh?: boolean } | V, MarketList]
  'marketplace:preview': [MarketRef, MarketPreview]
  'marketplace:install': [MarketRef & { overwrite?: boolean }, MarketInstallResult]
  // runs
  'runs:start': [{ target: RunTarget }, Run]
  'runs:list': [RunListQuery | V, Run[]]
  'runs:get': [{ id: Id }, RunDetail]
  'runs:cancel': [{ id: Id }, V]
  'runs:rerun': [{ id: Id }, Run]
  'runs:stepLog': [{ runId: Id; stepId: Id; tailBytes?: number; view?: 'raw' | 'readable' }, { text: string; truncated: boolean }]
  'runs:openAsSession': [{ runId: Id; stepId?: Id }, Session]
  // schedules
  'schedules:list': [V, Schedule[]]
  'schedules:create': [ScheduleInput, Schedule]
  'schedules:update': [{ id: Id; input: ScheduleInput }, Schedule]
  'schedules:remove': [{ id: Id }, V]
  'schedules:setEnabled': [{ id: Id; enabled: boolean }, Schedule]
  'schedules:runNow': [{ id: Id }, Run]
  'schedules:preview': [{ when: ScheduleWhen }, SchedulePreview]
  'schedules:events': [{ scheduleId: Id; limit?: number }, ScheduleEvent[]]
  'schedules:pauseAll': [{ paused: boolean }, StatusSnapshot]
  // secrets (vault)
  'secrets:list': [V, SecretMeta[]]
  'secrets:set': [{ name: string; value: string; label?: string }, SecretMeta]
  'secrets:remove': [{ name: string }, V]
  'secrets:reveal': [{ name: string }, { value: string }] // explicit user action only
  'secrets:copy': [{ name: string }, V] // main writes clipboard, plaintext never crosses IPC
  'secrets:parseEnv': [{ text: string }, EnvImportEntry[]] // preview, stores nothing
  'secrets:importEnv': [{ text: string; names: string[] }, SecretMeta[]] // commit selected names
  'secrets:pickEnvFile': [V, { path: string; entries: EnvImportEntry[]; text: string } | null]
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
  // memory (CONTRACT §11.5, PO10: <= 12 channels)
  'memory:overview': [V, MemoryOverview]
  'memory:graph': [MemoryGraphQuery, MemoryGraph] // <= 150 entities ranked by degree + facts + recency
  'memory:entity': [{ id: Id }, MemoryEntityDetail] // not_found if deleted
  'memory:search': [MemorySearchQuery, MemorySearchHit[]] // same ranking as the MCP tools
  'memory:facts': [MemoryFactQuery, { items: MemoryFact[]; total: number }] // newest first
  'memory:mutate': [MemoryMutation, MemoryMutationResult]
  /** Hard delete + event scrub; renderer must ui:confirm first. */
  'memory:delete': [{ kind: MemoryTargetKind; ids: Id[] }, V]
  /** Invalidates the run's live writes and restores what they superseded. One-way; restore single rows from History. */
  'memory:revertRun': [{ runId: Id }, { invalidated: number; restored: number }]
  'memory:grants': [{ runId?: Id; sessionId?: Id }, MemoryGrantInfo[]]
  'memory:setPaused': [{ paused: boolean }, MemoryOverview] // "Pause agent writes"
  /** Native save dialog, JSONL; null = canceled. */
  'memory:export': [{ scope: MemoryScopeFilter['scope'] }, { path: string } | null]
  // live agents (CONTRACT §12.6)
  'agents:list': [AgentListQuery, LiveAgentNode[]]
  'agents:get': [{ id: Id; eventsLimit?: number }, AgentDetail]
  'agents:events': [{ agentId: Id; beforeSeq?: number; limit?: number }, AgentEvent[]]
  /** Live session root with needs='idle': PTY write text + '\r'. Otherwise conflict. */
  'agents:reply': [{ agentId: Id; text: string }, V]
  'asks:list': [{ status?: 'open' | 'all'; runId?: Id; sessionId?: Id; limit?: number } | V, Ask[]]
  /** conflict if not open (or the PTY prompt changed, A9); bad_request for an option not offered. */
  'asks:answer': [AskAnswer, Ask]
  'app:dashboard': [{ since?: string } | V, DashboardData]
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
  'author:list': [{ status?: AuthorDraftStatus[]; limit?: number } | V, AuthorDraft[]]
  'author:get': [{ id: Id }, AuthorDraftDetail]
  /** conflict if not pending; validation if the (edited) draft is invalid (draft stays pending). */
  'author:decide': [AuthorDecideRequest, AuthorDraft]
  'author:grants': [V, AuthorRunGrant[]]
  'author:revokeRun': [{ workflowId: Id; ownerKey: string }, V]
  'worktrees:list': [{ status?: RunWorktree['status'][] } | V, RunWorktree[]]
  'worktrees:remove': [{ id: Id; discardWork?: boolean }, RunWorktree]
  /** Local branches created while the run ran (any repo it touched) that are still there. */
  'worktrees:branches': [{ runId: Id }, RunBranch[]]
  /** Deletes branches the run created (the user confirmed, even with unpushed work). Returns what is left. */
  'worktrees:deleteBranches': [{ runId: Id; branches: { repoPath: string; name: string }[] }, RunBranch[]]
  'history:list': [HistoryListQuery | V, HistoryListResult]
  'history:get': [{ id: string }, ClaudeTranscript]
  'history:resume': [{ id: string; profileId?: Id; cols: number; rows: number }, Session]
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
  'slackTriggers:list': [{ workflowId?: Id } | V, SlackTrigger[]]
  'slackTriggers:create': [SlackTriggerInput, SlackTrigger]
  'slackTriggers:update': [{ id: Id; input: SlackTriggerInput }, SlackTrigger]
  'slackTriggers:remove': [{ id: Id }, V]
  'slackTriggers:setEnabled': [{ id: Id; enabled: boolean }, SlackTrigger]
  'slackTriggers:test': [{ input: SlackTriggerInput; sample: { permalink: string } | { channelId: string; ts: string } }, SlackTriggerTestResult]
  'slackTriggers:events': [{ triggerId: Id; limit?: number }, SlackTriggerEvent[]]
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
export interface EventMap {
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
  'data:changed': { domain: 'repos' | 'profiles' | 'workflows' | 'secrets' | 'schedules' }
  /** Navigation/commands from app menu, tray, notifications, dock. */
  'ui:command': UiCommand
  /** New mem_event rows (any process) or a page write committed. Refetch visible data, debounced. */
  'memory:changed': MemoryChangedEvent
  'agent:updated': LiveAgentNode // coalesced 150 ms
  'agent:events': { agentId: Id; events: AgentEvent[] } // coalesced 100 ms
  'ask:updated': Ask
  /** Leftover processes changed (launch scan, Stop, Stop all). */
  'processes:changed': LeftoverProcess[]
  // authoring (CONTRACT §14.5)
  'author:updated': AuthorDraft
  'worktree:updated': RunWorktree
  'history:changed': { total: number }
  // Slack (CONTRACT "Slack.5")
  'slack:status': SlackStatus
  'slack:channels': SlackChannel[]
  'slack:messages': { channelId: string; messages: SlackMessage[] }
  'slack:draft': SlackDraft
  'slackTrigger:updated': SlackTrigger
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
export type View = 'home' | 'chat' | 'canvas' | 'workflows' | 'schedules' | 'artifacts' | 'keys' | 'settings' | 'memory' | 'agents'

export interface SessionCreateRequest {
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
}
export interface RunListQuery {
  status?: RunStatus[]
  workflowId?: Id
  scheduleId?: Id
  since?: string // ISO
  limit?: number // default 100
}
export interface ArtifactQuery {
  runId?: Id
  sessionId?: Id
  kind?: ArtifactKind
  limit?: number // default 500, newest first
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

/** `window.hive` */
export type HiveApi = { [D in Domains]: DomainApi<D> } & {
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
  'gateway:connect', 'gateway:disconnect', 'gateway:list', 'gateway:save', 'gateway:remove', 'gateway:test',
  'app:info', 'app:status', 'app:home', 'app:canvas', 'app:quit', 'app:openExternal', 'app:showItemInFolder',
  'app:hideWindow',
  'settings:get', 'settings:update',
  'providers:list',
  'repos:list', 'repos:pick', 'repos:add', 'repos:update', 'repos:remove', 'repos:siblings',
  'profiles:list', 'profiles:create', 'profiles:update', 'profiles:remove',
  'sessions:list', 'sessions:create', 'sessions:attach', 'sessions:kill', 'sessions:remove', 'sessions:rename',
  'sessions:restart', 'sessions:handoff', 'sessions:saveImage',
  'workflows:list', 'workflows:get', 'workflows:create', 'workflows:update', 'workflows:remove',
  'workflows:duplicate', 'workflows:validate', 'workflows:export', 'workflows:import',
  'marketplace:list', 'marketplace:preview', 'marketplace:install',
  'runs:start', 'runs:list', 'runs:get', 'runs:cancel', 'runs:rerun', 'runs:stepLog', 'runs:openAsSession',
  'schedules:list', 'schedules:create', 'schedules:update', 'schedules:remove', 'schedules:setEnabled',
  'schedules:runNow', 'schedules:preview', 'schedules:events', 'schedules:pauseAll',
  'secrets:list', 'secrets:set', 'secrets:remove', 'secrets:reveal', 'secrets:copy', 'secrets:parseEnv',
  'secrets:importEnv', 'secrets:pickEnvFile',
  'artifacts:list', 'artifacts:thumbnail', 'artifacts:trash', 'artifacts:quickLook', 'artifacts:open',
  'artifacts:reveal', 'artifacts:copyPath', 'artifacts:openDir', 'artifacts:peek',
  'ui:contextMenu', 'ui:confirm', 'ui:setEdited', 'clipboard:writeText',
  'memory:overview', 'memory:graph', 'memory:entity', 'memory:search', 'memory:facts', 'memory:mutate',
  'memory:delete', 'memory:revertRun', 'memory:grants', 'memory:setPaused', 'memory:export',
  'agents:list', 'agents:get', 'agents:events', 'agents:reply', 'asks:list', 'asks:answer', 'app:dashboard',
  'app:markSeen', 'schedules:skipNext',
  'runs:retryAt', 'sessions:retry', 'processes:leftovers', 'processes:stop',
  'author:list', 'author:get', 'author:decide', 'author:grants', 'author:revokeRun', 'worktrees:list',
  'worktrees:remove', 'worktrees:branches', 'worktrees:deleteBranches', 'history:list', 'history:get', 'history:resume',
  'slack:status', 'slack:manifest', 'slack:connect', 'slack:test', 'slack:retry', 'slack:disconnect', 'slack:channels',
  'slack:join', 'slack:joinAll', 'slack:markRead', 'slack:users', 'slack:messages', 'slack:thread', 'slack:search',
  'slack:backfill', 'slack:askAgent', 'slack:drafts', 'slack:draftGet', 'slack:draftDecide', 'slack:testAlert',
  'slack:permalink', 'slackTriggers:list', 'slackTriggers:create', 'slackTriggers:update', 'slackTriggers:remove',
  'slackTriggers:setEnabled', 'slackTriggers:test', 'slackTriggers:events'
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
  'agent:events', 'ask:updated', 'processes:changed', 'author:updated', 'worktree:updated', 'history:changed',
  'slack:status', 'slack:channels', 'slack:messages', 'slack:draft', 'slackTrigger:updated'
] as const satisfies readonly EventName[]
type _MissingEv = Exclude<EventName, (typeof EVENT_NAMES)[number]>
const _exhaustiveEv: [_MissingEv] extends [never] ? true : _MissingEv = true
void _exhaustiveEv

export const eventChannel = (e: EventName): string => `evt:${e}`
