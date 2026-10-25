/**
 * App state: one small external store (useSyncExternalStore). In-memory view state, no URLs/routes.
 * Snapshot via invoke, then live via events (CONTRACT §4.5). Never polls.
 */
import { useSyncExternalStore } from 'react'
import type { NativeMenuItem, UiCommand, View } from '@shared/ipc'
import type {
  AdapterId,
  AgentProfile,
  AppInfo,
  Id,
  ProviderInfo,
  Repo,
  Session,
  Settings,
  StatusSnapshot
} from '@shared/types'
import type { MemoryOverview } from '@shared/memory'
import type { CompanyAgent, CompanyLogo, CompanyOverview, LogoPick, CompanyPassport, CompanyTask, Department, DepartmentPresetKey } from '@shared/company'
import { PERSONAL_COMPANY_ID, coolAccent, departmentsEnabled } from '@shared/company'
import type { CompanyProposal } from '@shared/chatCompany'
import type { AgentNode as LiveAgent, Ask } from '@shared/live'
import type { AuthorDraft } from '@shared/authoring'
import { LAUNCH_STEP_LABELS, type CloneProgressEvent, type JournalMeta, type LaunchStepName, type OnboardingDraft, type OnboardingPlan, type OnboardingStatus, type ProgressEvent } from '@shared/onboarding'
import { confirmNative, errorCode, errorMessage, hive, nativeMenu } from '../lib/hive'
import { focusAgent, goNextNeedsYou, loadLive, reportVisibleOwner, wireLiveEvents } from './live'
import { loadDrafts, openApproval, wireAuthorEvents } from './authoring'
import { loadSlack, wireSlackEvents } from './slack'
import { departmentNotePath } from '../lib/departments'
import {
  clearStoredDraft,
  createDraftSaver,
  draftInputsHash,
  hasProgress,
  loadDraft,
  newDraft,
  planInput,
  receiveAgentPlan,
  reconcileLaunchDraft,
  reduceOnboarding,
  type ChatSeed,
  type OnboardingAction,
  type OnboardingMode,
  type PlanInputContext
} from './onboarding'
import { companyLabel, companyOf, effectiveCompany, isMultiCompany, isPersonal, reorderIds, reposOf, sortCompanies, switchTarget, withPersonal, workflowsTargetingRepo, type ActiveCompany } from '../lib/companyModel'

export interface ScheduleSeed {
  workflowId?: Id
  inputs?: Record<string, string>
  editId?: Id
}

export type ViewState =
  /** DEPARTMENTS.md §9: the Board once departments are on. `taskId` selects a card, `departmentId` filters (BoardView). */
  | { name: 'tasks'; taskId?: Id; departmentId?: Id }
  /** DEPARTMENTS.md §9: department page (charter, passport section, agents, recurring, routing, filtered board). */
  | { name: 'department'; id: Id; focus?: 'charter' | 'agents' | 'dashboards'; nonce?: number }
  /** DEPARTMENTS.md §9: one agent seat (current task, queue, run history, instructions). */
  | { name: 'agentSeat'; id: Id }
  /** PASSPORT.md §10: the company vault (P7's view; the legacy Memory page until it ships). Always the active company. */
  | { name: 'passport'; notePath?: string; mode?: PassportMode; depth?: number; search?: string; runId?: Id; sessionId?: Id; nonce?: number }
  /** COMPANY.md §8.5: Home in All mode. */
  | { name: 'portfolio' }
  /** COMPANY.md C6: company settings (the old Passport form: name, colour, vault location, repos, export/import). */
  | { name: 'company'; companyId?: Id; create?: boolean; nonce?: number }
  | { name: 'agents' }
  | { name: 'home' }
  | { name: 'session'; missing?: { adapter: AdapterId; repoId: Id | null } | null; missingRepoId?: Id | null }
  | { name: 'canvas'; focusRunId?: Id }
  | { name: 'workflows' }
  | { name: 'marketplace' }
  | { name: 'editor'; workflowId: Id | null; nonce: number; approvalDraftId?: Id; script?: boolean }
  | { name: 'run'; runId: Id; stepId?: Id; agentId?: Id }
  | { name: 'schedules'; selectedId?: Id; seed?: ScheduleSeed; nonce?: number; tab?: 'schedules' | 'slack' }
  | { name: 'artifacts'; runId?: Id; sessionId?: Id }
  | { name: 'keys' }
  | { name: 'settings'; section?: SettingsSection; focus?: 'slackAlerts' | 'grants' | 'worktrees' }
  | { name: 'slack'; channelId?: string; threadTs?: string; search?: boolean; nonce?: number }
  /** FORUM.md §8: the company Forum (companyId absent = the active company) */
  | { name: 'forum'; companyId?: Id; channelId?: Id; threadId?: Id; nonce?: number }
  /** CLOUD.md §13.1: the Principia Cloud pane */
  | { name: 'cloud' }
  /** USAGE.md: tokens and cost per day, company, department and agent; disk and Clean Up… */
  | { name: 'usage' }
  | { name: 'memory'; scope?: MemoryPageScope; runId?: Id; sessionId?: Id; entityId?: Id; search?: boolean; nonce?: number }

/** Memory page scope picker: a repo, global rows only, or everything. Absent = the overview's default repo (PO8). */
export type MemoryPageScope = { repoId: Id } | 'global' | 'all'
export type PassportMode = 'notes' | 'graph' | 'inbox'

export type SettingsSection = 'general' | 'agents' | 'connections' | 'notifications' | 'data' | 'about'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  /** VOICE.md §2: a Latin line shown beside the text (playful only, aria-hidden, with its translation) */
  latin?: { la: string; en: string }
}

/** 'companies': the ⇧⌘O company switcher (COMPANY.md §8.2). */
export type PaletteMode = 'all' | 'newSession' | 'runWorkflow' | 'companies'

export interface State {
  ready: boolean
  bootError: string | null
  view: ViewState
  info: AppInfo | null
  settings: Settings | null
  providers: ProviderInfo[]
  repos: Repo[]
  profiles: AgentProfile[]
  sessions: Session[]
  status: StatusSnapshot | null
  /** Sessions shown in the Session view (1-4 panes), in order. */
  grid: Id[]
  gridDir: 'row' | 'col'
  focusedSession: Id | null
  /** companyId: "New session in X" (newSession mode spawns into that company). */
  palette: { open: boolean; mode: PaletteMode; nonce: number; companyId?: Id }
  toasts: Toast[]
  window: { focused: boolean; fullscreen: boolean }
  expandedRepos: Record<string, boolean>
  lastTermSize: { cols: number; rows: number }
  siblingOffer: { repo: Repo; items: { path: string; name: string }[] } | null
  runInputs: { workflowId: Id } | null
  /** Contextual keyboard hint shown in the status bar (e.g. "Space to preview" for a selected artifact). */
  statusHint: string | null
  /** Memory overview (Review badge, pause state). null until loaded or when memory is unavailable. */
  memory: MemoryOverview | null
  /** Live agents (LIVE.md §6): every known agent node by id (roots + subagents), fed by events. */
  agents: Record<Id, LiveAgent>
  /** Asks by id (open ones, plus any that changed while Principia was open). */
  asks: Record<Id, Ask>
  /** false when main doesn't serve the live channels (hub stays empty, Home falls back). */
  liveAvailable: boolean | null
  /** A3: idle session roots whose pane the user has looked at (window focused). They stop counting as Needs you. */
  seenIdle: Record<Id, true>
  /** Last "jump to this agent" request (hub row, ⌘J, notification): views expand / scroll to it. */
  agentFocus: { agentId: Id; askId: Id | null; nonce: number } | null
  /** AUTHORING.md §2: agent-authored drafts by id (pending ones, plus any decided while Principia was open). */
  drafts: Record<Id, AuthorDraft>
  /** false when main doesn't serve author:* yet (no cards). */
  authorAvailable: boolean | null
  /** Last "show this approval" request (notification click): the card scrolls into view and takes the hotkeys. */
  approvalFocus: { draftId: Id; nonce: number } | null
  /**
   * COMPANY.md §1.3, §8.6: the company the UI is focused on, or 'all'. Renderer state only (persisted as
   * settings.activeCompanyId); every list call and spawn passes it explicitly. Read it through `activeCompany()`.
   */
  activeCompanyId: ActiveCompany
  /** Listed companies in rail order (archived hidden, Personal last). */
  companies: CompanyPassport[]
  companiesLoaded: boolean
  companyError: string | null
  /** company:overview by company id (failed-24h dots, portfolio cards). Live badges come from agents/asks. */
  companyOverview: Record<Id, CompanyOverview>
  /** company:logos by company id: the rail coin and chips show the logo instead of the initial (dataUrl null = initial). */
  companyLogos: Record<Id, CompanyLogo>
  /** shared/chatCompany.ts: open "start a company from this chat" cards (oldest first; the first one is shown). */
  chatProposals: CompanyProposal[]
  /** "Change Logo…" picker sheet: the company it is open for, null = closed. */
  logoPickerFor: Id | null
  /** Company tasks (Tasks page), loaded with the companies. */
  tasks: CompanyTask[]
  /** DEPARTMENTS.md: every company's departments (archived included), loaded with the companies. Empty while the flag is off. */
  departments: Department[]
  /** DEPARTMENTS.md: every company's agent seats (archived included). Empty while the flag is off. */
  companyAgents: CompanyAgent[]
  /** All-mode sidebar groups, companyId -> expanded (persisted as settings.expandedCompanies). Missing = expanded. */
  expandedCompanies: Record<Id, boolean>
  /** Bumped whenever the scope changes: views that load scoped data key their effects on it. */
  scopeNonce: number
  /** "Switched to Acme · Undo" after a cross-company open (§8.4). */
  companyUndo: { nonce: number; text: string; prev: ActiveCompany } | null
  /** Quick create sheet (just a name): the Start step footer link and the palette's "New company (name only)". */
  newCompanyOpen: boolean
  /**
   * ONBOARDING.md §1: the business-first flow. `resumable`: the draft it opened with had progress (resume banner).
   * null = closed.
   */
  onboarding: { open: boolean; mode: OnboardingMode; resumable: boolean } | null
  /** The flow's draft (§3.1). Kept while closed so "+ New company" resumes it. */
  onboardingDraft: OnboardingDraft | null
  /** onboarding:status after boot (and on open). null until loaded or when main has no onboarding. */
  onboardingStatus: OnboardingStatus | null
  /** "Claude tailored a plan for you · [Use it] [Keep mine]" (§2 S6): the agent plan offered next to an edited one. */
  onboardingOffer: OnboardingPlan | null
  /** A tailored plan is being made (onboarding:plan in flight). */
  onboardingPlanPending: boolean
  /** Launch live list (§2 S7), fed by onboarding:progress / onboarding:cloneProgress for the current journal. */
  onboardingProgress: { journalId: string | null; steps: Partial<Record<LaunchStepName, ProgressEvent>>; clone: CloneProgressEvent | null }
}

const initial: State = {
  ready: false,
  bootError: null,
  view: { name: 'home' },
  info: null,
  settings: null,
  providers: [],
  repos: [],
  profiles: [],
  sessions: [],
  status: null,
  grid: [],
  gridDir: 'row',
  focusedSession: null,
  palette: { open: false, mode: 'all', nonce: 0 },
  toasts: [],
  window: { focused: true, fullscreen: false },
  expandedRepos: loadJson('hive.expandedRepos', {}),
  lastTermSize: { cols: 120, rows: 36 },
  siblingOffer: null,
  runInputs: null,
  statusHint: null,
  memory: null,
  agents: {},
  asks: {},
  liveAvailable: null,
  seenIdle: {},
  agentFocus: null,
  drafts: {},
  authorAvailable: null,
  approvalFocus: null,
  activeCompanyId: 'all',
  companies: [],
  companiesLoaded: false,
  companyError: null,
  companyOverview: {},
  companyLogos: {},
  chatProposals: [],
  logoPickerFor: null,
  tasks: [],
  departments: [],
  companyAgents: [],
  expandedCompanies: {},
  scopeNonce: 0,
  companyUndo: null,
  newCompanyOpen: false,
  onboarding: null,
  onboardingDraft: null,
  onboardingStatus: null,
  onboardingOffer: null,
  onboardingPlanPending: false,
  onboardingProgress: { journalId: null, steps: {}, clone: null }
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
export function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* per-viewer convenience only */
  }
}
export { loadJson }

let state: State = initial
const listeners = new Set<() => void>()

export function getState(): State {
  return state
}
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state))
}

// ---------- toasts ----------
let toastSeq = 0
export function toast(text: string, kind: Toast['kind'] = 'info', opts: { latin?: Toast['latin'] } = {}): void {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, ...(opts.latin ? { latin: opts.latin } : {}) }] }))
  // long sentences stay up long enough to read
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), Math.max(kind === 'error' ? 6000 : 2200, text.length * 55))
}
export function toastError(e: unknown, prefix?: string): void {
  toast(prefix ? `${prefix}: ${errorMessage(e)}` : errorMessage(e), 'error')
}
/** Run an async action; show its error as a toast. */
export async function attempt<T>(fn: () => Promise<T>, prefix?: string): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    toastError(e, prefix)
    return undefined
  }
}

// ---------- navigation ----------
type LeaveGuard = () => Promise<boolean>
let leaveGuard: LeaveGuard | null = null
export function setLeaveGuard(g: LeaveGuard | null): void {
  leaveGuard = g
}

/** Asks the editor's unsaved-changes guard before leaving it. false = the user stayed. */
async function passLeaveGuard(view: ViewState): Promise<boolean> {
  if (leaveGuard && state.view.name === 'editor' && !(view.name === 'editor' && view === state.view)) {
    const ok = await leaveGuard()
    if (!ok) return false
    leaveGuard = null
  }
  return true
}

/** Resolves false when the editor's leave guard kept the user where they were. */
export async function navigate(view: ViewState, opts: { back?: boolean } = {}): Promise<boolean> {
  if (!(await passLeaveGuard(view))) return false
  if (!opts.back) {
    backStack.push(state.view)
    if (backStack.length > 30) backStack.shift()
  }
  setState({ view })
  return true
}

const backStack: ViewState[] = []
/** "‹ Back" in nested views (Run, Editor): previous in-memory view, else the fallback. */
export function goBack(fallback: ViewState = { name: 'home' }): void {
  let prev = backStack.pop()
  while (prev && prev.name === state.view.name) prev = backStack.pop()
  void navigate(prev ?? fallback, { back: true })
}

export function goView(v: View): void {
  switch (v) {
    case 'chat':
      void openChat(false)
      return
    case 'workflows':
      void navigate({ name: 'workflows' })
      return
    case 'settings':
      void navigate({ name: 'settings' })
      return
    case 'memory':
      // PASSPORT.md §10: the Passport replaces Memory in the NAV and on ⌘7
      void navigate({ name: 'passport', nonce: Date.now() })
      return
    default:
      void navigate({ name: v } as ViewState)
  }
}

// ---------- data loading ----------
export async function refreshRepos(): Promise<void> {
  const repos = await hive.repos.list()
  setState({ repos })
}
export async function refreshProfiles(): Promise<void> {
  setState({ profiles: await hive.profiles.list() })
}
export async function refreshSessions(): Promise<void> {
  const sessions = await hive.sessions.list({ status: 'all' })
  setState((s) => ({ sessions, grid: s.grid.filter((id) => sessions.some((x) => x.id === id)) }))
}
export async function refreshProviders(refresh = false): Promise<void> {
  setState({ providers: await hive.providers.list({ refresh }) })
}

function upsertSession(sess: Session): void {
  setState((s) => {
    const i = s.sessions.findIndex((x) => x.id === sess.id)
    const sessions = i < 0 ? [sess, ...s.sessions] : s.sessions.map((x) => (x.id === sess.id ? sess : x))
    return { sessions }
  })
}

let booted = false
export async function boot(): Promise<void> {
  if (booted) return
  booted = true
  wireEvents()
  wireLiveEvents()
  wireAuthorEvents()
  wireSlackEvents()
  const results = await Promise.allSettled([
    hive.app.info().then((info) => setState({ info })),
    hive.settings.get().then((settings) => setState({ settings, activeCompanyId: settings.activeCompanyId ?? 'all', expandedCompanies: settings.expandedCompanies ?? {} })),
    // optional: a main without companies keeps the pre-company shell (no rail, flat sidebar)
    refreshCompanies().catch(() => undefined),
    refreshProviders(),
    refreshRepos(),
    refreshProfiles(),
    refreshSessions(),
    hive.app.status().then((status) => setState({ status }))
  ])
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  setState({ ready: true, bootError: failed.length ? failed.map((f) => errorMessage(f.reason)).join(' · ') : null })
  hive.send('ui:ready', undefined)
  reconcileActiveCompany()
  void refreshCompanyOverview()
  void refreshCompanyLogos()
  void refreshTasks()
  void refreshDepartments()
  // memory is optional: a failure here only hides the Review badge (the Memory page shows the real error)
  void refreshMemoryOverview()
  void loadLive()
  void loadDrafts()
  void loadSlack()
  reportVisibleOwner()
  void detectOnboarding()
  void loadChatProposals()
}

// ---------- memory ----------
export async function refreshMemoryOverview(): Promise<MemoryOverview | null> {
  try {
    const companyId = scopeCompanyId()
    const memory = await hive.memory.overview(companyId ? { companyId } : undefined)
    setState({ memory })
    return memory
  } catch {
    return null
  }
}
let memoryOverviewTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMemoryOverview(): void {
  if (memoryOverviewTimer) return
  memoryOverviewTimer = setTimeout(() => {
    memoryOverviewTimer = null
    void refreshMemoryOverview()
  }, 250)
}
export async function setMemoryPaused(paused: boolean): Promise<void> {
  const res = await attempt(() => hive.memory.setPaused({ paused }), paused ? 'Pause agent writes' : 'Resume agent writes')
  if (res) setState({ memory: res })
}
/** Open the Memory page filtered to what one run wrote (RunView chip, MEMORY.md §10.6). */
export function openMemoryForRun(runId: Id, repoId?: Id | null): void {
  void navigate({ name: 'memory', runId, scope: repoId ? { repoId } : undefined, nonce: Date.now() })
}
/** Open the Memory page filtered to what one interactive session wrote (LIVE.md §7). */
export function openMemoryForSession(sessionId: Id, repoId?: Id | null): void {
  void navigate({ name: 'memory', sessionId, scope: repoId ? { repoId } : undefined, nonce: Date.now() })
}

function wireEvents(): void {
  hive.on('session:updated', upsertSession)
  hive.on('pty:exit', ({ sessionId, exitCode }) => {
    setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId && x.status === 'running' ? { ...x, status: 'exited', exitCode, endedAt: new Date().toISOString() } : x))
    }))
  })
  hive.on('status:changed', (status) => setState({ status }))
  hive.on('providers:changed', (providers) => setState({ providers }))
  hive.on('settings:changed', (settings) => {
    const was = departmentsOn()
    setState({ settings, expandedCompanies: settings.expandedCompanies ?? state.expandedCompanies })
    // flipping experimental.departments loads (or drops) the slices without a restart
    if (departmentsOn() !== was) void refreshDepartments()
  })
  hive.on('window:state', (w) => {
    setState({ window: w })
    document.documentElement.classList.toggle('is-inactive', !w.focused)
    document.documentElement.classList.toggle('is-fullscreen', w.fullscreen)
  })
  hive.on('data:changed', ({ domain }) => {
    if (domain === 'repos') void refreshRepos().catch(() => undefined)
    // an auto logo re-detects when its company's repositories change (main compares the repo set)
    if (domain === 'repos' || domain === 'company') scheduleCompanyLogos()
    if (domain === 'profiles') void refreshProfiles().catch(() => undefined)
    if (domain === 'company') {
      void refreshCompanies().then(reconcileActiveCompany, () => undefined)
      scheduleCompanyOverview()
      void refreshDepartments()
    }
    if (domain === 'tasks') void refreshTasks()
    if (domain === 'departments') void refreshDepartments()
  })
  // failed-24h dots and portfolio counts follow run outcomes; tasks show their run's state
  hive.on('run:updated', () => {
    scheduleCompanyOverview()
    scheduleTasks()
  })
  // the rail's working ring takes main's overview (runs + working session roots): keep it in step with root agents
  hive.on('agent:updated', (a) => {
    if (a.kind !== 'subagent') scheduleCompanyOverview()
  })
  hive.on('ui:command', runCommand)
  hive.on('chatCompany:updated', upsertChatProposal)
  // the page refetches its own data; the shell only keeps the overview (Review badge) fresh
  hive.on('memory:changed', () => scheduleMemoryOverview())
  wireOnboardingEvents()
}

// ---------- commands (menu, tray, notifications, keyboard) ----------
let lastCmd = { key: '', at: 0 }
export function runCommand(cmd: UiCommand): void {
  // the same chord can arrive via both the app menu (ui:command) and the renderer keydown; dedupe
  const key = JSON.stringify(cmd)
  const now = performance.now()
  if (key === lastCmd.key && now - lastCmd.at < 250) return
  lastCmd = { key, at: now }
  switch (cmd.kind) {
    case 'navigate':
      goView(cmd.view)
      return
    case 'openRun':
      void navigate({ name: 'run', runId: cmd.runId })
      return
    case 'openSession':
      focusSession(cmd.sessionId)
      return
    case 'newSession':
      if (cmd.repoId) void startSession({ repoId: cmd.repoId, forceNew: true })
      else openPalette('newSession')
      return
    case 'newChat':
      void openChat(true)
      return
    case 'newWorkflow':
      void newWorkflowInCompany()
      return
    case 'addRepo':
      void addRepos()
      return
    case 'toggleSidebar':
      toggleSidebar()
      return
    case 'commandPalette':
      openPalette('all')
      return
    case 'openSettings':
      void navigate({ name: 'settings' })
      return
    case 'closeSession':
      void closeFocused()
      return
    case 'zoom':
      window.dispatchEvent(new CustomEvent('hive:zoom', { detail: cmd.dir }))
      return
    case 'focusAgent':
      void focusAgent(cmd.agentId)
      return
    case 'nextNeedsYou':
      goNextNeedsYou()
      return
    case 'openApproval':
      void openApproval(cmd.draftId)
      return
  }
}

export function openPalette(mode: PaletteMode, companyId?: Id): void {
  setState((s) => ({ palette: { open: true, mode, nonce: s.palette.nonce + 1, companyId } }))
}
export function closePalette(): void {
  setState((s) => ({ palette: { ...s.palette, open: false } }))
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const was = departmentsOn()
  if (state.settings) setState({ settings: { ...state.settings, ...patch } })
  const res = await attempt(() => hive.settings.update(patch), 'Settings')
  if (res) setState({ settings: res })
  if (departmentsOn() !== was) void refreshDepartments()
}

export function toggleSidebar(): void {
  void updateSettings({ sidebarCollapsed: !state.settings?.sidebarCollapsed })
}

export function setProvider(adapter: AdapterId): void {
  const p = state.providers.find((x) => x.id === adapter)
  if (p && !p.available) {
    toast(`${p.label} isn't installed. ${p.installHint}`, 'error')
    return
  }
  void updateSettings({ defaultAdapter: adapter })
}

export function currentAdapter(): AdapterId {
  return state.settings?.defaultAdapter ?? 'claude'
}

// ---------- repos ----------
/** ⌘O. In a focused company the new repos are assigned to it (§8.4); in All mode they land in Personal. */
export async function addRepos(companyId: Id | undefined = scopeCompanyId()): Promise<void> {
  const added = await attempt(() => hive.repos.pick(companyId ? { companyId } : undefined), 'Add repository')
  if (!added || added.length === 0) return
  await refreshRepos().catch(() => undefined)
  toast(addedMessage(added))
  void offerSiblings(added[0]!)
}

export async function addRepoPaths(paths: string[], companyId: Id | undefined = scopeCompanyId()): Promise<void> {
  if (!paths.length) return
  const added = await attempt(() => hive.repos.add(companyId ? { paths, companyId } : { paths }), 'Add repository')
  if (!added?.length) return
  await refreshRepos().catch(() => undefined)
  toast(addedMessage(added))
  void offerSiblings(added[0]!)
}

function addedMessage(added: Repo[]): string {
  const what = added.length === 1 ? `Added ${added[0]!.name}` : `Added ${added.length} repositories`
  // Claude Code shows a one-time "trust this folder?" prompt whose default answer is No
  return currentAdapter() === 'claude' ? `${what}. The first Claude session asks once to trust the folder — pick “Yes”.` : what
}

async function offerSiblings(repo: Repo): Promise<void> {
  // first-run import list: only offered while the user has few repos
  if (state.repos.length > 3) return
  try {
    const items = await hive.repos.siblings({ id: repo.id })
    if (items.length) setState({ siblingOffer: { repo, items } })
  } catch {
    /* optional nicety */
  }
}

export async function moveRepo(id: string, targetId: string, placement: 'before' | 'after'): Promise<void> {
  if (id === targetId) return
  await attempt(() => hive.repos.move({ id, targetId, placement }), 'Move repository')
  await refreshRepos().catch(() => undefined)
}

/** The repos a repo is ordered among: its company's (repo_order:<companyId>), or all of them before companies exist. */
function repoSiblings(repo: Repo): Repo[] {
  return multiCompany() ? reposOf(state.repos, companyOf(repo)) : state.repos
}

export async function repoContextMenu(repo: Repo): Promise<void> {
  const siblings = repoSiblings(repo)
  const index = siblings.findIndex(r => r.id === repo.id)
  const here = companyOf(repo)
  const items: NativeMenuItem[] = [
    {
      label: 'New Session',
      submenu: state.providers
        .filter((p) => p.id !== 'shell')
        .map((p) => ({ id: `new:${p.id}`, label: p.available ? p.label : `${p.label} (not installed)`, enabled: p.available }))
    },
    { type: 'separator' },
    { id: 'reveal', label: 'Reveal in Finder', enabled: repo.exists },
    { id: 'copy', label: 'Copy Path' },
    { id: 'rename', label: 'Rename…' },
    { id: 'move-top', label: 'Move to Top', enabled: index > 0 },
    { id: 'move-up', label: 'Move Up', enabled: index > 0 },
    { id: 'move-down', label: 'Move Down', enabled: index >= 0 && index < siblings.length - 1 },
    ...(multiCompany()
      ? [{ label: 'Move to Company', submenu: state.companies.map((c) => ({ id: `company:${c.id}`, label: companyLabel(c, true), enabled: c.id !== here })) } as NativeMenuItem]
      : []),
    { type: 'separator' },
    { id: 'remove', label: 'Remove from Principia' }
  ]
  const id = await nativeMenu(items)
  if (!id) return
  if (id.startsWith('new:')) return void startSession({ repoId: repo.id, adapter: id.slice(4) as AdapterId, forceNew: true })
  if (id.startsWith('company:')) return void assignRepoToCompany(repo, id.slice(8))
  if (id === 'move-top') return moveRepo(repo.id, siblings[0]!.id, 'before')
  if (id === 'move-up' && index > 0) return moveRepo(repo.id, siblings[index - 1]!.id, 'before')
  if (id === 'move-down' && index < siblings.length - 1) return moveRepo(repo.id, siblings[index + 1]!.id, 'after')
  if (id === 'reveal') return void attempt(() => hive.app.showItemInFolder({ path: repo.path }))
  if (id === 'copy') {
    await attempt(() => hive.clipboard.writeText({ text: repo.path }))
    return toast('Path copied')
  }
  if (id === 'rename') {
    window.dispatchEvent(new CustomEvent('hive:renameRepo', { detail: repo.id }))
    return
  }
  if (id === 'remove') return void removeRepo(repo)
}

export async function removeRepo(repo: Repo): Promise<void> {
  const ok = await confirmNative({
    message: `Remove ${repo.name} from Principia?`,
    detail: 'The folder stays on disk. Running sessions keep running.',
    confirmLabel: 'Remove',
    destructive: true
  }).catch(() => false)
  if (!ok) return
  await attempt(() => hive.repos.remove({ id: repo.id }), 'Remove repository')
  await refreshRepos().catch(() => undefined)
}

export function toggleRepoExpanded(id: string, open?: boolean): void {
  setState((s) => {
    const expandedRepos = { ...s.expandedRepos, [id]: open ?? !s.expandedRepos[id] }
    saveJson('hive.expandedRepos', expandedRepos)
    return { expandedRepos }
  })
}

// ---------- sessions ----------
/** companyId narrows to one company's sessions (a chat in Acme never focuses a Personal chat, nor a repo's pre-move one). */
export function newestRunning(repoId: Id | null, companyId?: Id, departmentId?: Id): Session | undefined {
  // a department chat is its department's: the company's Chat row never focuses one, and the other way round
  return state.sessions
    .filter((s) => s.status === 'running' && s.repoId === repoId && (!companyId || companyOf(s) === companyId) && (s.departmentId ?? undefined) === departmentId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]
}

/** Show a session; `add` = ⌘-click: add to the grid (max 4). */
export function focusSession(id: Id, opts: { add?: boolean } = {}): void {
  setState((s) => {
    let grid: Id[]
    if (opts.add) {
      if (s.grid.includes(id)) grid = s.grid
      else if (s.grid.length >= 4) {
        toast('The grid holds 4 sessions. Close one first.')
        grid = s.grid
      } else grid = [...s.grid, id]
    } else grid = s.grid.includes(id) ? s.grid : s.grid.length > 1 ? s.grid.map((g) => (g === s.focusedSession ? id : g)) : [id]
    const sess = s.sessions.find((x) => x.id === id)
    const expandedRepos = sess?.repoId ? { ...s.expandedRepos, [sess.repoId]: true } : s.expandedRepos
    return { grid, focusedSession: id, expandedRepos }
  })
  // §8.4: opening another company's session (rail popover, palette, Needs you) moves the focus there, with Undo
  const sess = state.sessions.find((x) => x.id === id)
  if (sess) followCompany(companyOf(sess))
  if (state.view.name !== 'session' || state.view.missing || state.view.missingRepoId) void navigate({ name: 'session' })
}

export interface StartOpts {
  repoId: Id | null
  adapter?: AdapterId
  forceNew?: boolean
  addToGrid?: boolean
  /**
   * COMPANY.md §6, §8.3: the launching company ("+" in a company group). Absent: a repo session takes the repo's
   * company in main; a chat takes the focused company (Personal in All mode).
   */
  companyId?: Id
  /** DEPARTMENTS.md §9: "New Chat in <Department>" (a chat; `repoId` must be null). */
  departmentId?: Id
}

/** The company a new session is stamped with (sent to main, which validates it against the repo). */
export function launchCompany(o: Pick<StartOpts, 'repoId' | 'companyId'>, s: State = state): Id | undefined {
  if (o.companyId) return o.companyId
  if (o.repoId) {
    const repo = s.repos.find((r) => r.id === o.repoId)
    return repo?.companyId ?? undefined
  }
  const a = activeCompany(s)
  return a === 'all' ? undefined : a
}

/** Repo row / Chat click: focus the newest running session there, else spawn (SPEC A2). */
export async function startSession(o: StartOpts): Promise<Session | undefined> {
  if (o.repoId) {
    const repo = state.repos.find((r) => r.id === o.repoId)
    if (repo && !repo.exists) {
      void navigate({ name: 'session', missingRepoId: repo.id })
      return undefined
    }
  }
  const companyId = launchCompany(o)
  if (!o.forceNew) {
    // a repo moved to another company may still have a session stamped with the old one: that one runs with the old
    // company's keys and Passport, so clicking the repo in its new company starts a fresh session instead (§8.3)
    const live = newestRunning(o.repoId, companyId ?? PERSONAL_COMPANY_ID, o.departmentId)
    if (live) {
      focusSession(live.id, { add: o.addToGrid })
      return live
    }
  }
  const adapter = o.adapter ?? currentAdapter()
  const prov = state.providers.find((p) => p.id === adapter)
  if (prov && !prov.available) {
    void navigate({ name: 'session', missing: { adapter, repoId: o.repoId } })
    return undefined
  }
  try {
    const sess = await hive.sessions.create({
      ...(companyId ? { companyId } : {}),
      ...(o.departmentId ? { departmentId: o.departmentId } : {}),
      adapter,
      repoId: o.repoId,
      cols: state.lastTermSize.cols,
      rows: state.lastTermSize.rows
    })
    upsertSession(sess)
    if (o.repoId) void updateSettings({ lastRepoId: o.repoId })
    focusSession(sess.id, { add: o.addToGrid })
    return sess
  } catch (e) {
    if (errorCode(e) === 'adapter_unavailable') {
      void navigate({ name: 'session', missing: { adapter, repoId: o.repoId } })
      return undefined
    }
    toastError(e, 'Start session')
    return undefined
  }
}

export function openChat(forceNew: boolean, companyId?: Id): Promise<Session | undefined> {
  return startSession({ repoId: null, forceNew, companyId })
}

/**
 * DEPARTMENTS.md §9 "New Chat in Marketing": a new chat of the department's company, with the department's charter,
 * agents and open tasks in its context. `adapter` absent = the default adapter (the row's "+" on click).
 */
export function openDepartmentChat(d: Pick<Department, 'id' | 'companyId'>, adapter?: AdapterId): Promise<Session | undefined> {
  return startSession({ repoId: null, forceNew: true, companyId: d.companyId, departmentId: d.id, ...(adapter ? { adapter } : {}) })
}

/** The installed agent CLIs for a "New Chat with…" menu (the company "+" pattern), the default one first. */
function chatProviderItems(idPrefix: string): NativeMenuItem[] {
  const def = currentAdapter()
  return state.providers
    .filter((p) => p.id !== 'shell')
    .sort((a, b) => Number(b.id === def) - Number(a.id === def))
    .map<NativeMenuItem>((p) => ({ id: `${idPrefix}${p.id}`, label: p.available ? p.label : `${p.label} (not installed)`, enabled: p.available }))
}

/** ⌥-click on a department's "+": pick the agent CLI for its new chat. */
export async function departmentChatMenu(d: Department): Promise<void> {
  const id = await nativeMenu(chatProviderItems('chat|'))
  if (id?.startsWith('chat|')) void openDepartmentChat(d, id.slice(5) as AdapterId)
}

export function sessionTitle(s: Session): string {
  const repo = s.repoId ? state.repos.find((r) => r.id === s.repoId) : null
  const dep = s.departmentId ? state.departments.find((d) => d.id === s.departmentId) : null
  return `${providerLabel(s.adapter)} in ${repo?.name ?? dep?.name ?? 'Chat'}`
}

export function providerLabel(a: AdapterId): string {
  return { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', shell: 'Shell' }[a]
}

/** Close = kill behind a native confirm with "Don't ask again" (SPEC A2). Exited sessions close silently. */
export async function closeSession(id: Id): Promise<void> {
  const s = state.sessions.find((x) => x.id === id)
  if (!s) return
  if (s.status === 'running') {
    const ok = await confirmNative({
      message: `Kill ${sessionTitle(s)}?`,
      detail: 'The process stops. You can Restart it later to resume the conversation.',
      confirmLabel: 'Kill Session',
      destructive: true,
      suppressKey: 'killSession'
    }).catch((e) => {
      toastError(e)
      return false
    })
    if (!ok) return
    const res = await attempt(() => hive.sessions.kill({ id }), 'Kill session')
    if (res) upsertSession(res)
  }
  removeFromGrid(id)
}

export function removeFromGrid(id: Id): void {
  setState((s) => {
    const grid = s.grid.filter((g) => g !== id)
    const focusedSession = s.focusedSession === id ? (grid[grid.length - 1] ?? null) : s.focusedSession
    return { grid, focusedSession }
  })
  if (state.grid.length === 0 && state.view.name === 'session') void navigate({ name: 'home' })
}

export async function closeFocused(): Promise<void> {
  if (state.view.name === 'session' && state.focusedSession) return closeSession(state.focusedSession)
  await attempt(() => hive.app.hideWindow())
}

export async function restartSession(id: Id): Promise<void> {
  const res = await attempt(() => hive.sessions.restart({ id }), 'Restart')
  if (!res) return
  upsertSession(res)
  // the new session replaces the exited one: same grid slot, and the old row goes away instead of piling up
  setState((s) => ({ grid: s.grid.map((g) => (g === id ? res.id : g)), focusedSession: res.id, sessions: s.sessions.filter((x) => x.id !== id) }))
  void hive.sessions.remove({ id }).catch(() => undefined)
  if (!state.grid.includes(res.id)) focusSession(res.id)
}

export async function handoffSession(id: Id, adapter: 'claude' | 'codex'): Promise<void> {
  const res = await attempt(() => hive.sessions.handoff({ id, adapter }), 'Continue session')
  if (!res) return
  upsertSession(res)
  setState((s) => ({ grid: s.grid.map((g) => g === id ? res.id : g), focusedSession: res.id }))
  if (!state.grid.includes(res.id)) focusSession(res.id)
  toast(`Continuing in ${providerLabel(adapter)} with handoff context`)
}

export async function deleteSession(id: Id): Promise<void> {
  await attempt(() => hive.sessions.remove({ id }), 'Delete session')
  removeFromGrid(id)
  setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }))
}

export async function sessionContextMenu(s: Session): Promise<void> {
  const running = s.status === 'running'
  const id = await nativeMenu([
    { id: 'open', label: 'Open' },
    { id: 'grid', label: 'Add to Grid', enabled: !state.grid.includes(s.id) },
    { type: 'separator' },
    { id: 'rename', label: 'Rename…' },
    { id: 'artifacts', label: 'Show Artifacts' },
    { id: 'dir', label: 'Open ARTIFACTS_DIR' },
    { type: 'separator' },
    running ? { id: 'kill', label: 'Kill Session' } : { id: 'restart', label: 'Restart (resume conversation)' },
    ...(running ? [] : [{ id: 'delete', label: 'Delete' } as NativeMenuItem])
  ])
  if (id === 'open') focusSession(s.id)
  if (id === 'grid') focusSession(s.id, { add: true })
  if (id === 'rename') window.dispatchEvent(new CustomEvent('hive:renameSession', { detail: s.id }))
  if (id === 'artifacts') void navigate({ name: 'artifacts', sessionId: s.id })
  if (id === 'dir') void attempt(() => hive.artifacts.openDir({ sessionId: s.id }))
  if (id === 'kill') void closeSession(s.id)
  if (id === 'restart') void restartSession(s.id)
  if (id === 'delete') void deleteSession(s.id)
}

export async function renameSession(id: Id, title: string): Promise<void> {
  const res = await attempt(() => hive.sessions.rename({ id, title }), 'Rename')
  if (res) upsertSession(res)
}

export function setTermSize(cols: number, rows: number): void {
  const t = state.lastTermSize
  if (t.cols !== cols || t.rows !== rows) state = { ...state, lastTermSize: { cols, rows } } // silent: no re-render needed
}

/** Split right/down: new session in the focused session's folder with the same adapter. */
export async function splitFocused(dir: 'row' | 'col'): Promise<void> {
  const cur = state.sessions.find((s) => s.id === state.focusedSession)
  if (state.grid.length >= 4) return toast('The grid holds 4 sessions.')
  setState({ gridDir: dir })
  await startSession({ repoId: cur?.repoId ?? null, adapter: cur?.adapter, forceNew: true, addToGrid: true, companyId: cur ? companyOf(cur) : undefined })
}

export function moveFocus(dx: number, dy: number): void {
  const g = state.grid
  const i = g.indexOf(state.focusedSession ?? '')
  if (i < 0 || g.length < 2) return
  let j = i
  if (g.length === 2) j = state.gridDir === 'row' ? i + dx : i + dy
  else {
    const col = i % 2
    const row = Math.floor(i / 2)
    j = Math.min(1, Math.max(0, row + dy)) * 2 + Math.min(1, Math.max(0, col + dx))
  }
  if (j >= 0 && j < g.length) setState({ focusedSession: g[j]! })
}

export function cycleRepoSession(delta: 1 | -1): void {
  const cur = state.sessions.find((s) => s.id === state.focusedSession)
  if (!cur) return
  const list = state.sessions.filter((s) => s.repoId === cur.repoId && companyOf(s) === companyOf(cur)).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
  const i = list.findIndex((s) => s.id === cur.id)
  const next = list[(i + delta + list.length) % list.length]
  if (next && next.id !== cur.id) focusSession(next.id)
}

export async function pauseAll(paused: boolean): Promise<void> {
  const res = await attempt(() => hive.schedules.pauseAll({ paused }), 'Pause schedules')
  if (res) setState((s) => ({ status: res, settings: s.settings ? { ...s.settings, schedulesPaused: paused } : s.settings }))
}

export function setStatusHint(statusHint: string | null): void {
  if (state.statusHint !== statusHint) setState({ statusHint })
}

export function openRunInputs(workflowId: Id): void {
  setState({ runInputs: { workflowId } })
}

/** Remember last inputs used per workflow (pre-fills the inputs sheet). */
export function lastInputs(workflowId: Id): Record<string, string> {
  return loadJson<Record<string, Record<string, string>>>('hive.lastInputs', {})[workflowId] ?? {}
}
export function rememberInputs(workflowId: Id, inputs: Record<string, string>): void {
  const all = loadJson<Record<string, Record<string, string>>>('hive.lastInputs', {})
  all[workflowId] = inputs
  saveJson('hive.lastInputs', all)
}

// ---------- companies (COMPANY.md §8) ----------
/** More than Personal alone: the rail, company groups and focused mode exist only then (§8.1). */
export function multiCompany(s: State = state): boolean {
  return isMultiCompany(s.companies)
}
/** The effective focus: always 'all' for a Personal-only user, or while the focused company is gone / archived. */
export function activeCompany(s: State = state): ActiveCompany {
  return effectiveCompany(s.activeCompanyId, s.companies)
}
/** The companyId scoped loaders pass (runs, workflows, schedules, artifacts, keys, Slack, memory); undefined = all. */
export function scopeCompanyId(s: State = state): Id | undefined {
  const a = activeCompany(s)
  return a === 'all' ? undefined : a
}
export function companyById(id: Id | null | undefined, s: State = state): CompanyPassport | undefined {
  return id ? s.companies.find((c) => c.id === id) : undefined
}
export function companyName(id: Id | null | undefined, s: State = state): string {
  const c = companyById(id || PERSONAL_COMPANY_ID, s)
  return c ? companyLabel(c) : 'Personal'
}

export async function refreshCompanies(): Promise<CompanyPassport[]> {
  try {
    const companies = withPersonal(sortCompanies(await hive.company.list()))
    setState({ companies, companiesLoaded: true, companyError: null })
    return companies
  } catch (e) {
    setState({ companiesLoaded: true, companyError: errorMessage(e) })
    throw e
  }
}
/** Company logos (optional: a main without company:logos keeps the initials). */
export async function refreshCompanyLogos(): Promise<void> {
  try {
    const list = await hive.company.logos()
    setState({ companyLogos: Object.fromEntries(list.map((l) => [l.companyId, l])) })
  } catch {
    /* initials */
  }
}
let logosTimer: ReturnType<typeof setTimeout> | null = null
function scheduleCompanyLogos(): void {
  if (logosTimer) clearTimeout(logosTimer)
  logosTimer = setTimeout(() => {
    logosTimer = null
    void refreshCompanyLogos()
  }, 150)
}
export function openLogoPicker(companyId: Id): void {
  setState({ logoPickerFor: companyId })
}
export function closeLogoPicker(): void {
  setState({ logoPickerFor: null })
}
/** Applies a logo pick; returns the new logo, or null (canceled file dialog or an error, already toasted). */
export async function setCompanyLogo(companyId: Id, pick: LogoPick): Promise<CompanyLogo | null> {
  const res = await attempt(() => hive.company.setLogo({ id: companyId, pick }), 'Change logo')
  if (!res) return null
  setState({ companyLogos: { ...state.companyLogos, [companyId]: res } })
  return res
}
export async function refreshTasks(): Promise<void> {
  try {
    setState({ tasks: await hive.tasks.list(), companyError: null })
  } catch (e) {
    setState({ companyError: errorMessage(e) })
  }
}
let tasksTimer: ReturnType<typeof setTimeout> | null = null
function scheduleTasks(): void {
  if (tasksTimer) return
  tasksTimer = setTimeout(() => {
    tasksTimer = null
    void refreshTasks()
  }, 300)
}

// ---------- departments (DEPARTMENTS.md §9) ----------
/** §0.8: departments need experimental.companies and experimental.departments; with either off nothing here shows. */
export function departmentsOn(s: State = state): boolean {
  return departmentsEnabled(s.settings?.experimental)
}
let departmentsSeq = 0
/** Both slices for every company (archived rows included: seats and pages still resolve their names). */
export async function refreshDepartments(): Promise<void> {
  const n = ++departmentsSeq
  if (!departmentsOn()) {
    if (state.departments.length || state.companyAgents.length) setState({ departments: [], companyAgents: [] })
    return
  }
  try {
    const [departments, companyAgents] = await Promise.all([hive.departments.list({ includeArchived: true }), hive.companyAgents.list({ includeArchived: true })])
    // a slower earlier load never overwrites a newer one
    // departments saved before the cool palette may store a retired warm accent: show its cool replacement
    if (n === departmentsSeq) setState({ departments: departments.map((d) => (d.color && coolAccent(d.color) !== d.color ? { ...d, color: coolAccent(d.color) } : d)), companyAgents })
  } catch {
    /* a main without departments keeps the sidebar unchanged */
  }
}
export function departmentById(id: Id | null | undefined, s: State = state): Department | undefined {
  return id ? s.departments.find((d) => d.id === id) : undefined
}
export function companyAgentById(id: Id | null | undefined, s: State = state): CompanyAgent | undefined {
  return id ? s.companyAgents.find((a) => a.id === id) : undefined
}
/** "+" preset chips: all six by default (one call, idempotent by key), or the chosen ones. */
export async function createDepartmentPresets(companyId: Id, keys?: DepartmentPresetKey[]): Promise<Department[] | undefined> {
  const before = new Set(state.departments.filter((d) => d.companyId === companyId && !d.archivedAt).map((d) => d.key))
  const list = await attempt(() => hive.departments.createPresets(keys ? { companyId, keys } : { companyId }), 'Add departments')
  if (!list) return undefined
  await refreshDepartments()
  const added = list.filter((d) => !d.archivedAt && !before.has(d.key))
  toast(added.length === 0 ? 'Those departments already exist' : added.length === 1 ? `Added ${added[0]!.name}` : `Added ${added.length} departments`)
  return list
}
/** Department "Pause": pauses every active seat in it (there is no department-level switch, §1.1). */
export async function setDepartmentPaused(departmentId: Id, paused: boolean): Promise<void> {
  const seats = state.companyAgents.filter((a) => a.departmentId === departmentId && !a.archivedAt && !!a.pausedAt !== paused)
  if (!seats.length) return toast(paused ? 'No running agents in this department' : 'No paused agents in this department')
  const results = await Promise.allSettled(seats.map((a) => (paused ? hive.companyAgents.pause({ id: a.id }) : hive.companyAgents.resume({ id: a.id }))))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  await refreshDepartments()
  if (failed) toastError(failed.reason, paused ? 'Pause agents' : 'Resume agents')
  else toast(`${paused ? 'Paused' : 'Resumed'} ${seats.length} agent${seats.length === 1 ? '' : 's'}`)
}
export async function setAgentPaused(agent: CompanyAgent, paused: boolean): Promise<void> {
  const res = await attempt(() => (paused ? hive.companyAgents.pause({ id: agent.id }) : hive.companyAgents.resume({ id: agent.id })), paused ? 'Pause agent' : 'Resume agent')
  if (res) setState((s) => ({ companyAgents: s.companyAgents.map((a) => (a.id === res.id ? res : a)) }))
}
/** Archive behind a native confirm. Main refuses while work is open and names the tasks; that error is the toast. */
export async function archiveDepartment(d: Department): Promise<boolean> {
  const ok = await confirmNative({
    message: `Archive ${d.name}?`,
    detail: 'It leaves the sidebar and stops taking tasks. Its tasks, agents and passport section stay, and you can bring it back later.',
    confirmLabel: 'Archive'
  }).catch(() => false)
  if (!ok) return false
  const res = await attempt(() => hive.departments.archive({ id: d.id, archived: true }), `Archive ${d.name}`)
  if (!res) return false
  await refreshDepartments()
  if (state.view.name === 'department' && state.view.id === d.id) void navigate({ name: 'tasks' })
  return true
}
export async function archiveCompanyAgent(a: CompanyAgent): Promise<boolean> {
  const ok = await confirmNative({ message: `Archive ${a.name}?`, detail: 'Its finished tasks and run history stay. Tasks still queued for it wait for another agent.', confirmLabel: 'Archive' }).catch(() => false)
  if (!ok) return false
  const res = await attempt(() => hive.companyAgents.archive({ id: a.id, archived: true }), `Archive ${a.name}`)
  if (!res) return false
  await refreshDepartments()
  return true
}
/** The department's passport section: the vault note when the vault is on, else the page's fallback editor. */
export function openDepartmentPassport(d: Department): void {
  if (state.settings?.experimental?.vault) {
    void enterCompany(d.companyId, { view: { name: 'passport', notePath: departmentNotePath(d), mode: 'notes', nonce: Date.now() } })
  } else void openDepartment(d, 'charter')
}
/** Department pages and seats always open inside their company (the Board and passport are the active company's). */
export function openDepartment(d: Pick<Department, 'id' | 'companyId'>, focus?: 'charter' | 'agents'): void {
  const view: ViewState = { name: 'department', id: d.id, focus, nonce: Date.now() }
  if (activeCompany() === d.companyId || !multiCompany()) void navigate(view)
  else void enterCompany(d.companyId, { view })
}
export function openAgentSeat(a: Pick<CompanyAgent, 'id' | 'companyId'>): void {
  const view: ViewState = { name: 'agentSeat', id: a.id }
  if (activeCompany() === a.companyId || !multiCompany()) void navigate(view)
  else void enterCompany(a.companyId, { view })
}
export function openBoard(companyId: Id, opts: { departmentId?: Id; taskId?: Id } = {}): void {
  const view: ViewState = { name: 'tasks', ...opts }
  if (activeCompany() === companyId || !multiCompany()) void navigate(view)
  else void enterCompany(companyId, { view })
}
export async function departmentContextMenu(d: Department): Promise<void> {
  const seats = state.companyAgents.filter((a) => a.departmentId === d.id && !a.archivedAt)
  const allPaused = seats.length > 0 && seats.every((a) => !!a.pausedAt)
  const providers = chatProviderItems('chat|')
  const id = await nativeMenu([
    { id: 'chat', label: `New Chat in ${d.name}` },
    ...(providers.filter((p) => p.enabled !== false).length > 1 ? [{ label: 'New Chat with', submenu: providers }] : []),
    { type: 'separator' },
    { id: 'open', label: `Open ${d.name}` },
    { id: 'board', label: 'Open Board' },
    { type: 'separator' },
    allPaused ? { id: 'resume', label: 'Resume agents' } : { id: 'pause', label: 'Pause', enabled: seats.length > 0 },
    { id: 'charter', label: 'Edit Charter…' },
    { id: 'passport', label: 'Open Passport Section' },
    { type: 'separator' },
    { id: 'archive', label: 'Archive…' }
  ])
  if (!id) return
  if (id === 'chat') return void openDepartmentChat(d)
  if (id.startsWith('chat|')) return void openDepartmentChat(d, id.slice(5) as AdapterId)
  if (id === 'open') return openDepartment(d)
  if (id === 'board') return openBoard(d.companyId, { departmentId: d.id })
  if (id === 'pause' || id === 'resume') return setDepartmentPaused(d.id, id === 'pause')
  if (id === 'charter') return openDepartment(d, 'charter')
  if (id === 'passport') return openDepartmentPassport(d)
  if (id === 'archive') return void archiveDepartment(d)
}
/**
 * Rail "Pause all agents" (§12 kill switch): autopilot off in every company, so assignment stops waking agents.
 * Runs already in flight finish their turn; nothing new starts on its own.
 */
export async function pauseAllAgents(): Promise<void> {
  // archived companies too: archiving keeps the row's autopilot, and turning it off is always allowed
  const listAll = (): Promise<CompanyPassport[]> => hive.company.list({ includeArchived: true })
  const targets = await listAll().catch(() => state.companies)
  const results = await Promise.allSettled(targets.map((c) => hive.board.autopilot({ companyId: c.id, on: false })))
  // read back what main holds: a refusal only matters where autopilot is still on (a stale renderer row never hides one)
  const after = await listAll().catch(() => null)
  const stillOn = after ? after.filter((c) => c.autopilot) : targets.filter((c, i) => results[i]!.status === 'rejected' && c.autopilot !== false)
  const on = new Set(stillOn.map((c) => c.id))
  setState((s) => ({ companies: s.companies.map((c) => ({ ...c, autopilot: on.has(c.id) })) }))
  void refreshCompanies().catch(() => undefined)
  if (stillOn.length) toast(`Couldn’t turn autopilot off in ${stillOn.map((c) => c.name).join(', ')}`, 'error')
  else toast('Autopilot is off in every company. Agents only run when you click Run.')
}

export async function refreshCompanyOverview(): Promise<void> {
  try {
    const list = await hive.company.overview()
    setState({ companyOverview: Object.fromEntries(list.map((o) => [o.companyId, o])) })
  } catch {
    /* optional: only the failed dots and portfolio counts go missing */
  }
}
let overviewTimer: ReturnType<typeof setTimeout> | null = null
function scheduleCompanyOverview(): void {
  if (overviewTimer) return
  overviewTimer = setTimeout(() => {
    overviewTimer = null
    void refreshCompanyOverview()
  }, 500)
}

/** ⌘⇧N / menu: the editor saves into the focused company; All mode asks which company first and enters it (§3). */
async function newWorkflowInCompany(): Promise<void> {
  const view: ViewState = { name: 'editor', workflowId: null, nonce: Date.now() }
  if (!multiCompany() || activeCompany() !== 'all') return void navigate(view)
  const id = await nativeMenu([
    { id: '__title', label: 'New workflow in…', enabled: false },
    { type: 'separator' as const },
    ...state.companies.map((c) => ({ id: c.id, label: c.name }))
  ]).catch(() => null)
  if (id && id !== '__title') void enterCompany(id, { view })
}

/** A persisted focus on a company that is gone or archived falls back to All. */
function reconcileActiveCompany(): void {
  const a = state.activeCompanyId
  if (a !== 'all' && state.companiesLoaded && !state.companyError && !state.companies.some((c) => c.id === a)) setScope('all')
}

/** Re-run the scoped loaders the shell owns; views key their own loads on `scopeNonce` / `activeCompanyId`. */
function reloadScoped(): void {
  void refreshMemoryOverview()
}

function setScope(id: ActiveCompany): void {
  if (state.activeCompanyId === id) return
  backStack.length = 0
  setState((s) => ({ activeCompanyId: id, scopeNonce: s.scopeNonce + 1, settings: s.settings ? { ...s.settings, activeCompanyId: id } : s.settings }))
  void hive.settings.update({ activeCompanyId: id }).catch(() => undefined)
  reloadScoped()
}

/**
 * §8.6 `enterCompany`: focus a company (or All), clear the back stack, re-run scoped loaders and go Home (or `view`).
 * The session grid and focused pane are kept: a pane may belong to any company and shows its chip.
 */
export async function enterCompany(id: ActiveCompany, opts: { view?: ViewState } = {}): Promise<boolean> {
  const view = opts.view ?? { name: 'home' }
  if (!(await passLeaveGuard(view))) return false
  setScope(id)
  setState({ view, companyUndo: null })
  return true
}

let undoSeq = 0
let undoTimer: ReturnType<typeof setTimeout> | null = null
/** Cross-company open (§8.4): focus the target's company without leaving the view being opened; offer Undo. */
export function followCompany(target: Id | null | undefined): void {
  const next = switchTarget(activeCompany(), multiCompany(), target, (id) => !!companyById(id))
  if (!next) return
  const prev = activeCompany()
  setScope(next)
  const nonce = ++undoSeq
  setState({ companyUndo: { nonce, text: `Switched to ${companyName(next)}`, prev } })
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => setState((s) => (s.companyUndo?.nonce === nonce ? { companyUndo: null } : {})), 6000)
}
export function undoCompanySwitch(): void {
  const u = state.companyUndo
  if (!u) return
  setState({ companyUndo: null })
  setScope(u.prev)
}
export function dismissCompanyUndo(): void {
  if (state.companyUndo) setState({ companyUndo: null })
}

/** ⌃1…⌃9 select the Nth company in rail order, ⌃0 selects All. */
export function enterCompanySlot(n: number): void {
  if (!multiCompany()) return
  if (n === 0) return void enterCompany('all')
  const c = state.companies[n - 1]
  if (c) void enterCompany(c.id)
}

/**
 * Open a live row of any company in one click. `enter` (rail popover): focus its company first, no Undo since the
 * user picked the company. Otherwise (Needs you, palette) focus follows a cross-company open with Undo.
 */
export async function openLiveItem(item: { agentId: Id; askId: Id | null; companyId: Id }, opts: { enter?: boolean } = {}): Promise<void> {
  if (opts.enter && multiCompany() && companyById(item.companyId)) setScope(item.companyId)
  const before = state.activeCompanyId
  await focusAgent(item.agentId, item.askId)
  // focusAgent already followed a session's company: a second switch would make Undo return to the wrong one
  if (state.activeCompanyId === before) followCompany(item.companyId)
}

/** Open a company's Passport (enters the company: the vault is always the active company's). */
export function openCompanyPassport(id: Id): void {
  void enterCompany(id, { view: { name: 'passport', nonce: Date.now() } })
}

export function toggleCompanyExpanded(id: Id, open?: boolean): void {
  const expandedCompanies = { ...state.expandedCompanies, [id]: open ?? state.expandedCompanies[id] === false }
  setState((s) => ({ expandedCompanies, settings: s.settings ? { ...s.settings, expandedCompanies } : s.settings }))
  void hive.settings.update({ expandedCompanies }).catch(() => undefined)
}

/** Every "+ New company" entry point (rail, menus, palette, Sidebar, PortfolioView, Board): the onboarding flow (§1). */
export function openNewCompany(): void {
  openOnboarding('new')
}
/** The old name-and-colour sheet ("Quick create"). Closes the flow first, keeping its draft. */
export function openQuickCompany(): void {
  if (state.onboarding?.open) {
    draftSaver.flush()
    setState({ onboarding: null, onboardingOffer: null })
  }
  setState({ newCompanyOpen: true })
}
export function closeNewCompany(): void {
  setState({ newCompanyOpen: false })
}
export async function createCompany(name: string, color?: string): Promise<CompanyPassport | undefined> {
  const created = await attempt(() => hive.company.create({ name: name.trim(), ...(color ? { color } : {}) }), 'New company')
  if (!created) return undefined
  setState({ newCompanyOpen: false })
  await refreshCompanies().catch(() => undefined)
  void refreshCompanyOverview()
  toast(`Created ${created.name}`)
  void enterCompany(created.id)
  return created
}

export async function updateCompany(id: Id, patch: { name?: string; color?: string }): Promise<void> {
  const res = await attempt(() => hive.company.update({ id, patch }), 'Update company')
  if (res) setState((s) => ({ companies: sortCompanies(s.companies.map((c) => (c.id === id ? res : c))) }))
}

export async function archiveCompany(c: CompanyPassport): Promise<void> {
  if (isPersonal(c)) return toast('Personal / Unassigned can’t be archived.')
  const ok = await confirmNative({
    message: `Archive ${c.name}?`,
    detail: 'It leaves the rail and the sidebar. Its repositories, sessions, runs, keys and Passport stay, and you can unarchive it in Settings › Companies.',
    confirmLabel: 'Archive'
  }).catch(() => false)
  if (!ok) return
  if (!(await attempt(() => hive.company.archive({ id: c.id, archived: true }), 'Archive company'))) return
  if (state.activeCompanyId === c.id) await enterCompany('all')
  await refreshCompanies().catch(() => undefined)
}

/** Rail drag: persists the new order (Personal stays last however it is dropped). */
export async function reorderCompanies(id: Id, targetId: Id, placement: 'before' | 'after'): Promise<void> {
  const current = state.companies.map((c) => c.id)
  const ids = reorderIds(current, id, targetId, placement)
  if (ids === current) return
  // optimistic: the rail reflows at once
  setState((s) => ({ companies: sortCompanies(ids.map((x, i) => ({ ...s.companies.find((c) => c.id === x)!, sortOrder: i }))) }))
  const res = await attempt(() => hive.company.reorder({ ids }), 'Reorder companies')
  if (res) setState({ companies: sortCompanies(res) })
  else void refreshCompanies().catch(() => undefined)
}

const COMPANY_COLORS: { label: string; value: string }[] = [
  { label: 'Blue', value: 'var(--series-1)' },
  { label: 'Cyan', value: 'var(--series-2)' },
  { label: 'Green', value: 'var(--series-3)' },
  { label: 'Purple', value: 'var(--series-4)' },
  { label: 'Pink', value: 'var(--series-5)' },
  { label: 'Grey', value: 'var(--series-other)' }
]

/** Rail right-click (§8.2): native menu, the repoContextMenu pattern. */
export async function companyContextMenu(c: CompanyPassport): Promise<void> {
  const personal = isPersonal(c)
  const id = await nativeMenu([
    { id: 'enter', label: `Enter ${c.name}` },
    { id: 'new', label: 'New Session…' },
    { type: 'separator' },
    { id: 'rename', label: 'Rename…' },
    ...(personal ? [] : ([{ id: 'logo', label: 'Change Logo…' }] as NativeMenuItem[])),
    { label: 'Colour', submenu: COMPANY_COLORS.map((x) => ({ id: `color:${x.value}`, label: x.label, enabled: x.value !== c.color })) },
    { id: 'settings', label: 'Company Settings…' },
    { type: 'separator' },
    { id: 'passport', label: 'Open Passport' },
    { id: 'reveal', label: 'Open Vault in Finder' },
    { id: 'obsidian', label: 'Open Vault in Obsidian' },
    ...(departmentsOn() ? ([{ type: 'separator' }, { id: 'pauseAgents', label: 'Pause all agents' }] as NativeMenuItem[]) : []),
    { type: 'separator' },
    { id: 'archive', label: personal ? 'Archive (Personal can’t be archived)' : 'Archive…', enabled: !personal }
  ])
  if (!id) return
  if (id === 'pauseAgents') return pauseAllAgents()
  if (id === 'enter') return void enterCompany(c.id)
  if (id === 'new') return void newSessionMenu(c.id)
  if (id === 'rename') return void window.dispatchEvent(new CustomEvent('hive:renameCompany', { detail: c.id }))
  if (id === 'logo') return openLogoPicker(c.id)
  if (id.startsWith('color:')) return updateCompany(c.id, { color: id.slice(6) })
  if (id === 'settings') return void enterCompany(c.id, { view: { name: 'company', companyId: c.id, nonce: Date.now() } })
  if (id === 'passport') return openCompanyPassport(c.id)
  if (id === 'reveal') return void attempt(() => hive.memory.vault({ op: 'reveal', companyId: c.id }), 'Open vault')
  if (id === 'obsidian') {
    const res = (await attempt(() => hive.memory.vault({ op: 'openInObsidian', companyId: c.id }), 'Open in Obsidian')) as { hint?: string | null } | undefined
    if (res?.hint) toast(res.hint)
    return
  }
  if (id === 'archive') return archiveCompany(c)
}

/** Group "+" (§8.3): adapters, then "Chat (no repo)" or one of that company's repos. Spawns stamped with the company. */
export async function newSessionMenu(companyId: Id): Promise<void> {
  const repos = reposOf(state.repos, companyId).filter((r) => r.exists)
  const id = await nativeMenu(
    state.providers
      .filter((p) => p.id !== 'shell')
      .map<NativeMenuItem>((p) => ({
        label: p.available ? p.label : `${p.label} (not installed)`,
        enabled: p.available,
        submenu: [{ id: `${p.id}|chat`, label: 'Chat (no repo)' }, ...(repos.length ? [{ type: 'separator' } as NativeMenuItem] : []), ...repos.map((r) => ({ id: `${p.id}|repo|${r.id}`, label: r.name }))]
      }))
  )
  if (!id) return
  const [adapter, kind, repoId] = id.split('|') as [AdapterId, string, string | undefined]
  void startSession({ repoId: kind === 'repo' ? (repoId ?? null) : null, adapter, forceNew: true, companyId })
}

/**
 * Move a repo to another company (sidebar drag onto a company header, or "Move to Company"). Confirm first (§8.3):
 * future runs and sessions only; past runs keep their stamp; memory stays in the old company's Passport.
 */
export async function assignRepoToCompany(repo: Repo, companyId: Id): Promise<boolean> {
  const from = companyOf(repo)
  if (from === companyId) return false
  const target = companyName(companyId)
  const workflows = await hive.workflows.list().then((l) => workflowsTargetingRepo(l, repo.id), () => [])
  const wfLine = workflows.length
    ? `\n\nWorkflows that target it: ${workflows.slice(0, 6).map((w) => w.name).join(', ')}${workflows.length > 6 ? ` and ${workflows.length - 6} more` : ''}. They stay in their company; runs of them that use this repo will be refused.`
    : ''
  const ok = await confirmNative({
    message: `Move ${repo.name} to ${target}?`,
    detail: `Only future runs and sessions use ${target}’s keys and Passport. Past runs keep their company, and what agents remembered stays in ${companyName(from)}’s Passport.${wfLine}`,
    confirmLabel: 'Move'
  }).catch(() => false)
  if (!ok) return false
  const res = await attempt(() => hive.company.assignRepo({ repoId: repo.id, companyId }), 'Move repository')
  if (!res) return false
  await Promise.allSettled([refreshRepos(), refreshCompanies()])
  scheduleCompanyOverview()
  toast(`Moved ${repo.name} to ${target}`)
  return true
}

// ---------- onboarding (ONBOARDING.md §1, §3, §9) ----------
const draftSaver = createDraftSaver(saveJson)
/** The first-run flow opens on its own at most once per session (§1). */
let firstRunOffered = false

/** Departments already on: the plan may use them without the consent switch. */
function onboardingFlagsOn(s: State = state): boolean {
  return departmentsEnabled(s.settings?.experimental)
}

/** What planInput needs from the app: Shared keys (onboarding:status), flags already on, the local zone. */
export function onboardingPlanContext(s: State = state): PlanInputContext {
  return { sharedKeys: s.onboardingStatus?.sharedKeys, flagsOn: onboardingFlagsOn(s) }
}

/** Replace the draft (and save it, debounced). */
function setDraft(d: OnboardingDraft | null): void {
  if (d === state.onboardingDraft) return
  setState({ onboardingDraft: d })
  if (d) draftSaver.save(d)
}

/** Run one §3 transition on the open draft. */
export function onboardingDispatch(action: OnboardingAction): void {
  const d = state.onboardingDraft
  if (!d) return
  const next = reduceOnboarding(d, action)
  if (next === d) return
  setDraft(next)
  // a stash handle the draft no longer holds (provider switch, invalid re-check, Shared key, forget) is wiped in main
  const oldStash = d.content.stashId
  if (oldStash && next.content.stashId !== oldStash) forgetStash(oldStash)
  // a plan request must not land on a plan the founder has moved away from (Back out of S6, launch)
  if (d.step === 'plan' && next.step !== 'plan') cancelOnboardingPlan()
  // an offered agent plan was made for the old answers: drop it once they change
  if (state.onboardingOffer) {
    const ctx = onboardingPlanContext()
    if (draftInputsHash(d, ctx) !== draftInputsHash(next, ctx)) setState({ onboardingOffer: null })
  }
}

export async function refreshOnboardingStatus(): Promise<OnboardingStatus | null> {
  try {
    const status = (await hive.onboarding?.status?.()) ?? null
    setState({ onboardingStatus: status })
    return status
  } catch {
    return null
  }
}

/**
 * The open draft sits on a Launch step: check it against main's journal so it can't be stuck on a live list with no
 * Back or Esc (journal done → the company exists, close; discarded or unknown → back to Plan). Needs a loaded status.
 */
function reconcileOpenDraft(status: OnboardingStatus | null): void {
  const d = state.onboardingDraft
  if (!status || !d || !state.onboarding?.open || d.step === 'ready') return
  const next = reconcileLaunchDraft(d, status.journal)
  if (next === d) return
  if (next) {
    setDraft(next)
    return
  }
  clearOnboardingDraft()
  setState({ onboarding: null })
  toast(`${status.journal?.companyName || 'Your business'} is already set up.`)
}

// ---------- "start a company from this chat" (shared/chatCompany.ts) ----------

export async function loadChatProposals(): Promise<void> {
  try {
    const list = (await hive.chatCompany?.list?.()) ?? []
    setState({ chatProposals: list.filter((p) => p.status === 'pending') })
  } catch {
    /* an older main: no cards */
  }
}
/** chatCompany:updated: a pending card is shown (or refreshed); a decided one leaves. */
export function upsertChatProposal(p: CompanyProposal): void {
  setState((s) => {
    const rest = s.chatProposals.filter((x) => x.id !== p.id)
    return { chatProposals: p.status === 'pending' ? [...rest, p].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : rest }
  })
}

/**
 * Why a confirmed chat card cannot open the onboarding now, or null. The flow is open, or a launch was started
 * (a journal exists: Retry / Discard decide it first).
 */
export function chatSeedBlocker(): string | null {
  if (state.onboarding?.open) return 'Finish or close the company setup that is open first.'
  const saved = state.onboardingDraft ?? loadDraft(loadJson)
  if (saved?.journalId && saved.step !== 'ready') return 'A company launch is waiting for Retry or Discard. Open + New company to finish it first.'
  return null
}
/** A saved draft with answers would be replaced by the chat's (the card asks first). */
export function hasSavedOnboarding(): boolean {
  const saved = state.onboardingDraft ?? loadDraft(loadJson)
  return !!saved && saved.step !== 'ready' && hasProgress(saved)
}
/** Opens the onboarding on a fresh "From a prompt" draft seeded from a confirmed chat card. false when blocked. */
export function openOnboardingFromChat(seed: ChatSeed): boolean {
  if (chatSeedBlocker()) return false
  forgetDraftStash(state.onboardingDraft ?? loadDraft(loadJson))
  cancelOnboardingPlan()
  draftSaver.cancel()
  const draft = reduceOnboarding(newDraft('new'), { type: 'seedFromChat', seed })
  setState({
    onboarding: { open: true, mode: 'new', resumable: false },
    onboardingDraft: draft,
    onboardingOffer: null,
    newCompanyOpen: false,
    onboardingProgress: { journalId: null, steps: {}, clone: null }
  })
  draftSaver.save(draft)
  void refreshOnboardingStatus()
  return true
}

/** Open the flow: resume the saved draft (its mode follows the entry point), else start a fresh one. */
export function openOnboarding(mode: OnboardingMode): void {
  if (state.onboarding?.open) return
  let saved = state.onboardingDraft ?? loadDraft(loadJson)
  // a draft whose company was already made has nothing left to resume
  if (saved?.step === 'ready') {
    clearOnboardingDraft()
    saved = null
  }
  const draft = saved ? reduceOnboarding(saved, { type: 'setMode', mode }) : newDraft(mode)
  setState({ onboarding: { open: true, mode, resumable: hasProgress(saved) }, onboardingDraft: draft, onboardingOffer: null, newCompanyOpen: false })
  if (saved && draft !== saved) draftSaver.save(draft)
  void refreshOnboardingStatus().then(reconcileOpenDraft)
}

/** "Continue" on the resume banner. */
export function continueOnboarding(): void {
  if (state.onboarding) setState({ onboarding: { ...state.onboarding, resumable: false } })
}

/** "Start over" on the resume banner: a fresh draft; a key stashed by the old one is forgotten in main. */
export function startOverOnboarding(): void {
  const o = state.onboarding
  if (!o) return
  forgetDraftStash(state.onboardingDraft)
  cancelOnboardingPlan()
  draftSaver.cancel()
  const draft = newDraft(o.mode)
  setState({ onboarding: { ...o, resumable: false }, onboardingDraft: draft, onboardingOffer: null, onboardingProgress: { journalId: null, steps: {}, clone: null } })
  draftSaver.save(draft)
}

function forgetDraftStash(d: OnboardingDraft | null | undefined): void {
  const id = d?.content.stashId
  if (id) forgetStash(id)
}
function forgetStash(id: string): void {
  try {
    void hive.onboarding?.key?.({ op: 'forget', stashIds: [id] })?.catch?.(() => undefined)
  } catch {
    // main without onboarding: nothing stashed there
  }
}

/**
 * Esc / ✕ during the question steps (§2): save and close with a toast. Refused (false) on first run, which has
 * "I'll explore on my own" instead, and while a launch is running or failed (Retry / Discard decide).
 */
export function closeOnboarding(): boolean {
  const o = state.onboarding
  if (!o) return false
  const step = state.onboardingDraft?.step
  if (o.mode === 'first' || step === 'launching' || step === 'failed') return false
  cancelOnboardingPlan()
  if (step === 'ready') {
    // the company exists: nothing left to resume; land on its Board so it never ends up out of sight
    const journalId = state.onboardingDraft?.journalId ?? state.onboardingProgress.journalId
    clearOnboardingDraft()
    setState({ onboarding: null, onboardingOffer: null })
    if (journalId) void landOnFinishedLaunch(journalId)
    return true
  }
  draftSaver.flush()
  setState({ onboarding: null, onboardingOffer: null })
  toast('Saved. Pick up where you left off from + New company.')
  return true
}

/** The Board of the company a finished launch made (nothing turned on), when main confirms it. */
async function landOnFinishedLaunch(journalId: string): Promise<void> {
  try {
    const j = (await refreshOnboardingStatus())?.journal
    if (!j || j.id !== journalId || j.status !== 'done' || !j.companyId) return
    await refreshCompanies().catch(() => undefined)
    await enterCompany(j.companyId, { view: { name: 'tasks' } })
  } catch {
    /* stays where it is; the company is in the rail */
  }
}

function clearOnboardingDraft(): void {
  draftSaver.cancel()
  clearStoredDraft(saveJson)
  setState({ onboardingDraft: null, onboardingOffer: null, onboardingProgress: { journalId: null, steps: {}, clone: null } })
}

/** First run "I'll explore on my own": onboardingDone, no draft, Home. */
export async function skipOnboarding(): Promise<void> {
  forgetDraftStash(state.onboardingDraft)
  cancelOnboardingPlan()
  clearOnboardingDraft()
  setState({ onboarding: null })
  void navigate({ name: 'home' })
  await updateSettings({ onboardingDone: true })
}

/** Discard after a failed launch (main has undone it): close and forget the draft. */
export function discardOnboarding(): void {
  forgetDraftStash(state.onboardingDraft)
  cancelOnboardingPlan()
  clearOnboardingDraft()
  setState({ onboarding: null })
}

/**
 * Ready step (§2 S8): both buttons land in the new company. Start now → its Home; "I'll review first" → its Board.
 * The draft is done with: cleared.
 */
export async function finishOnboarding(companyId: Id, landing: 'home' | 'board'): Promise<void> {
  const first = state.onboarding?.mode === 'first' || state.onboardingDraft?.mode === 'first'
  cancelOnboardingPlan()
  clearOnboardingDraft()
  // main sets onboardingDone at launch finish on first run; keep the local copy in step so the flow doesn't reopen
  if (first && state.settings && !state.settings.onboardingDone) setState({ settings: { ...state.settings, onboardingDone: true } })
  setState({ onboarding: null })
  await refreshCompanies().catch(() => undefined)
  void refreshCompanyOverview()
  void refreshTasks()
  void refreshDepartments()
  // the finished launch journal is what the `launched` milestone reads (VOICE.md §7): fetch it now, not next boot
  void refreshOnboardingStatus()
  await enterCompany(companyId, { view: landing === 'board' ? { name: 'tasks' } : { name: 'home' } })
}

/**
 * After boot (§1, §7.4): a failed/running launch journal reopens the flow at the Launch step; otherwise a first run
 * (Personal only, onboarding not done, no repos yet) opens it in 'first' mode, once per session.
 */
export async function detectOnboarding(): Promise<void> {
  const status = await refreshOnboardingStatus()
  if (state.onboarding?.open) return
  const j = status?.journal
  if (j && (j.status === 'failed' || j.status === 'running')) {
    const saved = state.onboardingDraft ?? loadDraft(loadJson)
    // a fresh draft keeps the journal's draft id, so Retry / Discard address the same launch (mutex per draft)
    const base = saved && (saved.journalId === j.id || saved.id === j.draftId) ? saved : newDraft(j.mode, { id: j.draftId })
    const draft = reduceOnboarding(reduceOnboarding(base, { type: 'setMode', mode: j.mode }), { type: 'resumeJournal', journalId: j.id, status: j.status, name: j.companyName })
    setState({
      onboarding: { open: true, mode: j.mode, resumable: false },
      onboardingDraft: draft,
      onboardingProgress: { journalId: j.id, steps: journalSteps(j), clone: null }
    })
    draftSaver.save(draft)
    return
  }
  if (isFirstRun() && !firstRunOffered) {
    firstRunOffered = true
    openOnboarding('first')
  }
}

/** The journal's recorded steps as the live list's events (pending steps are not shown yet). */
function journalSteps(j: JournalMeta): Partial<Record<LaunchStepName, ProgressEvent>> {
  const out: Partial<Record<LaunchStepName, ProgressEvent>> = {}
  for (const st of j.steps) {
    if (st.status === 'pending') continue
    out[st.name] = { journalId: j.id, step: st.name, status: st.status, label: LAUNCH_STEP_LABELS[st.name], ...(st.error ? { error: st.error } : {}) }
  }
  return out
}

/**
 * §1 first run: settings loaded, Personal only, onboarding not done, and main confirms a new install (onboarding:status
 * `firstRun`: no repos, sessions, runs, own workflows, schedules, tasks or keys). Users who already have data are never
 * interrupted; an unknown status (main unreachable) counts as not a first run.
 */
export function isFirstRun(s: State = state): boolean {
  return s.ready && !!s.settings && !s.settings.onboardingDone && !multiCompany(s) && s.repos.length === 0 && s.onboardingStatus?.firstRun === true
}

let onboardingWired = false
/** onboarding:progress / onboarding:cloneProgress → the Launch step's live list (wired once, from boot). */
export function wireOnboardingEvents(): void {
  if (onboardingWired) return
  onboardingWired = true
  // a reload or quit inside the 300 ms debounce still keeps the last answer
  window.addEventListener?.('beforeunload', () => draftSaver.flush())
  hive.on('onboarding:progress', (e) => {
    setState((s) => {
      const p = s.onboardingProgress
      const same = p.journalId === e.journalId
      return { onboardingProgress: { journalId: e.journalId, steps: { ...(same ? p.steps : {}), [e.step]: e }, clone: same ? p.clone : null } }
    })
    const d = state.onboardingDraft
    if (d && e.status === 'failed' && (!d.journalId || d.journalId === e.journalId)) onboardingDispatch({ type: 'launchFailed', journalId: e.journalId })
  })
  hive.on('onboarding:cloneProgress', (e) => {
    setState((s) => {
      const p = s.onboardingProgress
      return { onboardingProgress: { journalId: e.journalId, steps: p.journalId === e.journalId ? p.steps : {}, clone: e } }
    })
  })
}

// ---------- the tailored plan (§6.2) ----------
let planSeq = 0
let planRequestId: string | null = null

/** Back out of S6, close, Start over, launch: the in-flight agent call is killed. */
export function cancelOnboardingPlan(): void {
  const id = planRequestId
  planRequestId = null
  if (state.onboardingPlanPending) setState({ onboardingPlanPending: false })
  if (id) void hive.onboarding?.cancelPlan?.({ requestId: id })?.catch?.(() => undefined)
}

/**
 * Ask main for a tailored plan for the current answers (a newer request replaces an older one). The result is merged
 * with `receiveAgentPlan`: swapped in when unedited, offered when edited, ignored when the answers moved on.
 * Resolves with what happened.
 */
export async function requestOnboardingPlan(useAgent = true): Promise<'swap' | 'offer' | 'stale' | 'template' | 'error'> {
  const d = state.onboardingDraft
  if (!d) return 'error'
  cancelOnboardingPlan()
  const ctx = onboardingPlanContext()
  const input = planInput(d, ctx)
  const hash = draftInputsHash(d, ctx)
  const requestId = `${d.id}-p${++planSeq}`
  planRequestId = requestId
  setState({ onboardingPlanPending: useAgent })
  try {
    const res = await hive.onboarding.plan({ requestId, input, useAgent })
    if (planRequestId !== requestId) return 'stale'
    planRequestId = null
    setState({ onboardingPlanPending: false })
    const cur = state.onboardingDraft
    if (!cur) return 'stale'
    if (res.source !== 'agent') {
      // made for answers that have since changed: the renderer's own template for the new answers stands
      if (draftInputsHash(cur, ctx) !== hash) return 'stale'
      onboardingDispatch({ type: 'templatePlan', plan: res.plan, inputsHash: hash })
      return 'template'
    }
    const r = receiveAgentPlan(cur, res.plan, hash, ctx)
    if (r.stale) return 'stale'
    setDraft(r.draft)
    if (r.offer) {
      setState({ onboardingOffer: r.offer })
      return 'offer'
    }
    return 'swap'
  } catch {
    if (planRequestId === requestId) {
      planRequestId = null
      setState({ onboardingPlanPending: false })
    }
    return 'error'
  }
}

/** Banner "Use it": the offered agent plan replaces the edited one. */
export function useOfferedOnboardingPlan(): void {
  const offer = state.onboardingOffer
  const d = state.onboardingDraft
  if (!offer || !d) return
  onboardingDispatch({ type: 'useOfferedPlan', plan: offer, inputsHash: draftInputsHash(d, onboardingPlanContext()) })
  setState({ onboardingOffer: null })
}
/** Banner "Keep mine". */
export function dismissOnboardingOffer(): void {
  if (state.onboardingOffer) setState({ onboardingOffer: null })
}

/** Write the pending draft now (window unload). */
export function flushOnboardingDraft(): void {
  draftSaver.flush()
}

export { hive }
