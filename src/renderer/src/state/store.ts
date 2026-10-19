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
import type { AgentNode as LiveAgent, Ask } from '@shared/live'
import type { AuthorDraft } from '@shared/authoring'
import { confirmNative, errorCode, errorMessage, hive, nativeMenu } from '../lib/hive'
import { focusAgent, goNextNeedsYou, loadLive, reportVisibleOwner, wireLiveEvents } from './live'
import { loadDrafts, openApproval, wireAuthorEvents } from './authoring'
import { loadSlack, wireSlackEvents } from './slack'

export interface ScheduleSeed {
  workflowId?: Id
  inputs?: Record<string, string>
  editId?: Id
}

export type ViewState =
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
  | { name: 'memory'; scope?: MemoryPageScope; runId?: Id; sessionId?: Id; entityId?: Id; search?: boolean; nonce?: number }

/** Memory page scope picker: a repo, global rows only, or everything. Absent = the overview's default repo (PO8). */
export type MemoryPageScope = { repoId: Id } | 'global' | 'all'

export type SettingsSection = 'general' | 'agents' | 'connections' | 'notifications' | 'data' | 'about'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export type PaletteMode = 'all' | 'newSession' | 'runWorkflow'

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
  palette: { open: boolean; mode: PaletteMode; nonce: number }
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
  approvalFocus: null
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
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
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

export async function navigate(view: ViewState, opts: { back?: boolean } = {}): Promise<void> {
  if (leaveGuard && state.view.name === 'editor' && !(view.name === 'editor' && view === state.view)) {
    const ok = await leaveGuard()
    if (!ok) return
    leaveGuard = null
  }
  if (!opts.back) {
    backStack.push(state.view)
    if (backStack.length > 30) backStack.shift()
  }
  setState({ view })
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
    hive.settings.get().then((settings) => setState({ settings })),
    refreshProviders(),
    refreshRepos(),
    refreshProfiles(),
    refreshSessions(),
    hive.app.status().then((status) => setState({ status }))
  ])
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  setState({ ready: true, bootError: failed.length ? failed.map((f) => errorMessage(f.reason)).join(' · ') : null })
  hive.send('ui:ready', undefined)
  // memory is optional: a failure here only hides the Review badge (the Memory page shows the real error)
  void refreshMemoryOverview()
  void loadLive()
  void loadDrafts()
  void loadSlack()
  reportVisibleOwner()
}

// ---------- memory ----------
export async function refreshMemoryOverview(): Promise<MemoryOverview | null> {
  try {
    const memory = await hive.memory.overview()
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
  hive.on('settings:changed', (settings) => setState({ settings }))
  hive.on('window:state', (w) => {
    setState({ window: w })
    document.documentElement.classList.toggle('is-inactive', !w.focused)
    document.documentElement.classList.toggle('is-fullscreen', w.fullscreen)
  })
  hive.on('data:changed', ({ domain }) => {
    if (domain === 'repos') void refreshRepos().catch(() => undefined)
    if (domain === 'profiles') void refreshProfiles().catch(() => undefined)
  })
  hive.on('ui:command', runCommand)
  // the page refetches its own data; the shell only keeps the overview (Review badge) fresh
  hive.on('memory:changed', () => scheduleMemoryOverview())
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
      void navigate({ name: 'editor', workflowId: null, nonce: Date.now() })
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

export function openPalette(mode: PaletteMode): void {
  setState((s) => ({ palette: { open: true, mode, nonce: s.palette.nonce + 1 } }))
}
export function closePalette(): void {
  setState((s) => ({ palette: { ...s.palette, open: false } }))
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  if (state.settings) setState({ settings: { ...state.settings, ...patch } })
  const res = await attempt(() => hive.settings.update(patch), 'Settings')
  if (res) setState({ settings: res })
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
export async function addRepos(): Promise<void> {
  const added = await attempt(() => hive.repos.pick(), 'Add repository')
  if (!added || added.length === 0) return
  await refreshRepos().catch(() => undefined)
  toast(addedMessage(added))
  void offerSiblings(added[0]!)
}

export async function addRepoPaths(paths: string[]): Promise<void> {
  if (!paths.length) return
  const added = await attempt(() => hive.repos.add({ paths }), 'Add repository')
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

export async function repoContextMenu(repo: Repo): Promise<void> {
  const index = state.repos.findIndex(r => r.id === repo.id)
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
    { id: 'move-down', label: 'Move Down', enabled: index >= 0 && index < state.repos.length - 1 },
    { type: 'separator' },
    { id: 'remove', label: 'Remove from Principia' }
  ]
  const id = await nativeMenu(items)
  if (!id) return
  if (id.startsWith('new:')) return void startSession({ repoId: repo.id, adapter: id.slice(4) as AdapterId, forceNew: true })
  if (id === 'move-top') return moveRepo(repo.id, state.repos[0].id, 'before')
  if (id === 'move-up' && index > 0) return moveRepo(repo.id, state.repos[index - 1].id, 'before')
  if (id === 'move-down' && index < state.repos.length - 1) return moveRepo(repo.id, state.repos[index + 1].id, 'after')
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
export function newestRunning(repoId: Id | null): Session | undefined {
  return state.sessions
    .filter((s) => s.status === 'running' && s.repoId === repoId)
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
  if (state.view.name !== 'session' || state.view.missing || state.view.missingRepoId) void navigate({ name: 'session' })
}

export interface StartOpts {
  repoId: Id | null
  adapter?: AdapterId
  forceNew?: boolean
  addToGrid?: boolean
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
  if (!o.forceNew) {
    const live = newestRunning(o.repoId)
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

export function openChat(forceNew: boolean): Promise<Session | undefined> {
  return startSession({ repoId: null, forceNew })
}

export function sessionTitle(s: Session): string {
  const repo = s.repoId ? state.repos.find((r) => r.id === s.repoId) : null
  return `${providerLabel(s.adapter)} in ${repo?.name ?? 'Chat'}`
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
  await startSession({ repoId: cur?.repoId ?? null, adapter: cur?.adapter, forceNew: true, addToGrid: true })
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
  const list = state.sessions.filter((s) => s.repoId === cur.repoId).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
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

export { hive }
