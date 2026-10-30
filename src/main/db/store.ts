/** Main-process repository layer over hive.db (CONTRACT §3). Synchronous; no Electron imports (testable in Node). */
import fs from 'node:fs'
import path from 'node:path'
import type {
  AdapterId,
  ExperimentalFlags,
  AgentProfile,
  AgentProfileInput,
  Artifact,
  Id,
  Repo,
  Run,
  RunDetail,
  Schedule,
  ScheduleEvent,
  ScheduleInput,
  ScheduleWhen,
  Session,
  Settings,
  Workflow,
  WorkflowDraft,
  WorkflowOrigin
} from '../../shared/types'
import type { ArtifactQuery, RunListQuery } from '../../shared/ipc'
import { HiveError } from '../../shared/errors'
import { newId } from '../../shared/ids'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { DB } from './index'
import {
  RUN_SELECT,
  SCHEDULE_SELECT,
  artifactFromRow,
  buildPatch,
  int,
  json,
  profileFromRow,
  runFromRow,
  runSnapshot,
  scheduleEventFromRow,
  scheduleFromRow,
  sessionFromRow,
  stepFromRow,
  workflowFromRow,
  type ArtifactRow,
  type ProfileRow,
  type RunRow,
  type ScheduleEventRow,
  type ScheduleRow,
  type SessionRow,
  type StepRow,
  type WorkflowRow
} from './mappers'

export const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: false,
  notifyOnSuccess: 'scheduled',
  notifyOnFailure: true,
  notificationSound: true,
  keepAwake: true,
  concurrency: 0,
  defaultAdapter: 'claude',
  lastRepoId: null,
  schedulesPaused: false,
  onboardingDone: false,
  sidebarCollapsed: false,
  terminalFontSize: 13,
  interactiveBypass: false,
  // LIVE.md §7 / A10: new sessions read-write within the repo. Settings writes are patch-only, so users who never
  // touched this get the new default and an explicit 'off' survives.
  sessionMemory: 'read-write',
  // CONTRACT §13: a scheduled run that hits a usage limit retries once at the reset; Stalled? after 10 silent minutes
  autoRetryRateLimit: true,
  stallMinutes: 10,
  // AUTHORING.md §8
  claudeHistory: true,
  // SLACK.md §7.1 (imessageHandle was removed, SA3)
  slackAlertUserId: null,
  slackMirrorNeedsYou: false,
  // Settings › Notifications: "Tell me when something needs me" (a Mac notification per ask / finished turn)
  notifyNeedsYou: true,
  // SOUNDS.md: Done, Needs you and Problem sounds on, at a modest volume ("Sounds" itself is notificationSound)
  soundDone: true,
  soundNeedsYou: true,
  soundProblem: true,
  soundVolume: 0.5,
  // RELEASING.md §4.1: stable releases only unless the founder opts in
  betaUpdates: false,
  slackBackfillDays: 7,
  slackTriggerCatchupMin: 10,
  slackAutoPaused: false,
  marketplaceUrl: null,
  // REMOTE.md RA6: null = the official phone app address
  phoneSiteUrl: null,
  // REMOTE.md RA8: null = on once a phone is paired
  phoneAutoStart: null,
  // COMPANY.md §8.6 (UI state) and §6 (guards warn while experimental.companies is off)
  activeCompanyId: 'all',
  expandedCompanies: {},
  experimental: { companies: false, vault: false, vaultAI: false },
  // VOICE.md §0
  tone: 'playful',
  personas: true,
  // AGENT-COLLAB.md §2 (stored as given; collabSettings() clamps and fills the defaults)
  agentCollab: {},
  // ORCHESTRATOR.md §6 (stored as given; orchestratorSettings() clamps and fills the defaults)
  orchestrator: {},
  // AUTOPILOT.md §4 (UI bookkeeping)
  autopilots: {},
  // Automations › Routines and Home suggestions (UI bookkeeping)
  routines: {},
  nudges: {},
  // PROACTIVE.md
  proactiveAgents: true,
  trackTasks: 'auto',
  // Five doors: sidebar pins and More visibility per company (UI state)
  sidebarNav: {},
  // CHAT-UI.md §4.4
  openChatsAs: 'auto',
  // Five doors step 5: dismissed one-time notices, and the first week waiting on Home (UI state)
  notices: {},
  firstWeek: {}
}
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]
// departments and plans stay absent (= off) so settings:get keeps its three-flag shape until the feature is enabled
const DEFAULT_EXPERIMENTAL: Required<Omit<ExperimentalFlags, 'departments' | 'plans'>> = { companies: false, vault: false, vaultAI: false }

/**
 * COMPANY.md §1.4: rows written by an older build (NULL company_id) read as Personal. Every company filter and stamp
 * goes through these, so the rule lives in one place.
 */
export const companyOf = (col: string): string => `COALESCE(${col}, '${PERSONAL_COMPANY_ID}')`
/** A repo's company: its company_repos owner (if that company exists), else Personal (§2.2). */
const REPO_COMPANY = (repoCol: string): string =>
  `COALESCE((SELECT cr.company_id FROM company_repos cr JOIN company_passports cp ON cp.id = cr.company_id WHERE cr.repo_id = ${repoCol}), '${PERSONAL_COMPANY_ID}')`
const REPO_SELECT = `SELECT repos.*, ${REPO_COMPANY('repos.id')} AS company_id FROM repos`

export const ADAPTER_LABELS: Record<AdapterId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor Agent',
  gemini: 'Gemini CLI',
  shell: 'Shell'
}
/** Short label used in session titles ("example-project · Claude"). */
export const ADAPTER_SHORT: Record<AdapterId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  shell: 'Shell'
}

interface RepoRow {
  id: string
  name: string
  path: string
  added_at: string
  company_id?: string | null
}
const orderOf = (raw: string | null | undefined): Map<string, number> => {
  const ids = json<unknown>(raw, [])
  return new Map((Array.isArray(ids) ? ids : []).map((id, index) => [String(id), index]))
}
/** Moves `id` next to `targetId` inside `ids` (both present). */
const placed = (ids: string[], id: string, targetId: string, placement: 'before' | 'after'): string[] => {
  const remaining = ids.filter((item) => item !== id)
  remaining.splice(remaining.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, id)
  return remaining
}

export interface SessionInsert extends Session {
  logPath: string
}

export class Store {
  private describe: (w: ScheduleWhen) => string = () => ''
  constructor(
    readonly db: DB,
    private now: () => Date = () => new Date()
  ) {}

  setDescribe(fn: (w: ScheduleWhen) => string): void {
    this.describe = fn
  }
  private ts(): string {
    return this.now().toISOString()
  }

  // ---------- meta ----------
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return r ? r.value : null
  }
  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else
      this.db
        .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
  }

  // ---------- settings ----------
  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const s: Settings = { ...DEFAULT_SETTINGS }
    for (const r of rows) {
      if ((SETTINGS_KEYS as string[]).includes(r.key)) {
        ;(s as unknown as Record<string, unknown>)[r.key] = json(r.value, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[r.key])
      }
    }
    // flags added later default to off, whatever an older stored object lacks
    s.experimental = { ...DEFAULT_EXPERIMENTAL, ...(s.experimental && typeof s.experimental === 'object' ? s.experimental : {}) }
    // never hand out the shared default object (a caller mutating it would change every later read)
    s.expandedCompanies = s.expandedCompanies && typeof s.expandedCompanies === 'object' && !Array.isArray(s.expandedCompanies) ? { ...s.expandedCompanies } : {}
    s.autopilots = s.autopilots && typeof s.autopilots === 'object' && !Array.isArray(s.autopilots) ? { ...s.autopilots } : {}
    s.routines = s.routines && typeof s.routines === 'object' && !Array.isArray(s.routines) ? { ...s.routines } : {}
    s.nudges = s.nudges && typeof s.nudges === 'object' && !Array.isArray(s.nudges) ? { ...s.nudges } : {}
    s.sidebarNav = s.sidebarNav && typeof s.sidebarNav === 'object' && !Array.isArray(s.sidebarNav) ? { ...s.sidebarNav } : {}
    s.notices = s.notices && typeof s.notices === 'object' && !Array.isArray(s.notices) ? { ...s.notices } : {}
    s.firstWeek = s.firstWeek && typeof s.firstWeek === 'object' && !Array.isArray(s.firstWeek) ? { ...s.firstWeek } : {}
    return s
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    this.db.transaction(() => {
      // experimental is patched flag by flag (settings:update sends only the flags it changes)
      const experimental = patch.experimental ? { ...this.getSettings().experimental, ...patch.experimental } : undefined
      // AGENT-COLLAB.md: the collaboration guards are patched field by field too
      const agentCollab = patch.agentCollab ? { ...(this.getSettings().agentCollab ?? {}), ...patch.agentCollab } : undefined
      // ORCHESTRATOR.md §6: field by field as well
      const prevOrch = this.getSettings().orchestrator ?? {}
      // a company's own switches merge company by company, field by field
      const orchCompanies = patch.orchestrator?.companies
        ? Object.fromEntries(
            [...new Set([...Object.keys(prevOrch.companies ?? {}), ...Object.keys(patch.orchestrator.companies)])].map((k) => [k, { ...(prevOrch.companies?.[k] ?? {}), ...(patch.orchestrator!.companies![k] ?? {}) }])
          )
        : undefined
      const orchestrator = patch.orchestrator ? { ...prevOrch, ...patch.orchestrator, ...(orchCompanies ? { companies: orchCompanies } : {}) } : undefined
      for (const [k, v] of Object.entries({ ...patch, ...(experimental ? { experimental } : {}), ...(agentCollab ? { agentCollab } : {}), ...(orchestrator ? { orchestrator } : {}) })) {
        if (v === undefined || !(SETTINGS_KEYS as string[]).includes(k)) continue
        stmt.run(k, JSON.stringify(v))
      }
    })()
    return this.getSettings()
  }
  /** COMPANY.md §6: guards throw with the flag on, warn and still stamp with it off. */
  companyGuardsEnforced(): boolean {
    return !!this.getSettings().experimental?.companies
  }

  // ---------- repos ----------
  private repoFromRow(r: RepoRow, live: (id: Id) => number): Repo {
    let exists = false
    let isGit = false
    try {
      exists = fs.statSync(r.path).isDirectory()
      isGit = exists && fs.existsSync(path.join(r.path, '.git'))
    } catch {
      /* missing */
    }
    return { id: r.id, name: r.name, path: r.path, addedAt: r.added_at, exists, isGit, liveSessions: live(r.id), companyId: r.company_id ?? PERSONAL_COMPANY_ID }
  }
  /**
   * Without companyId: every repo in the legacy `repo_order` (exactly the pre-company list). With it: that company's
   * repos in `repo_order:<companyId>` (COMPANY.md §2.3). Either way each repo carries its company and its position in
   * that company's order, so the All-mode sidebar can group one list.
   */
  listRepos(live: (id: Id) => number = () => 0, companyId?: Id): Repo[] {
    const rows = this.db.prepare(`${REPO_SELECT} ORDER BY repos.name COLLATE NOCASE, repos.id`).all() as RepoRow[]
    const metas = this.db.prepare("SELECT key, value FROM meta WHERE key = 'repo_order' OR key LIKE 'repo_order:%'").all() as { key: string; value: string }[]
    const legacy = orderOf(metas.find((m) => m.key === 'repo_order')?.value)
    const perCompany = new Map(metas.filter((m) => m.key !== 'repo_order').map((m) => [m.key.slice('repo_order:'.length), orderOf(m.value)]))
    const at = (order: Map<string, number> | undefined, id: string) => order?.get(id) ?? Infinity
    const repos = rows.map((r) => this.repoFromRow(r, live))
    // per-company position: its own key first, then the legacy order (unsplit installs), then by name
    const groups = new Map<string, Repo[]>()
    for (const r of repos) groups.set(r.companyId!, [...(groups.get(r.companyId!) ?? []), r])
    for (const [cid, list] of groups) {
      const own = perCompany.get(cid)
      list
        .slice()
        .sort((a, b) => at(own, a.id) - at(own, b.id) || at(legacy, a.id) - at(legacy, b.id))
        .forEach((r, i) => (r.companyOrder = i))
    }
    if (companyId) return repos.filter((r) => r.companyId === companyId).sort((a, b) => a.companyOrder! - b.companyOrder!)
    return repos.sort((a, b) => at(legacy, a.id) - at(legacy, b.id))
  }
  /**
   * Move one folder against its company's order, preserving concurrent additions. Both repos must share a company
   * (moving to another company is company:assignRepo). The legacy global order gets the same move, so older builds
   * and the unfiltered list follow.
   */
  moveRepo(id: Id, targetId: Id, placement: 'before' | 'after'): void {
    this.db.transaction(() => {
      const all = this.listRepos()
      const repo = all.find((r) => r.id === id)
      const target = all.find((r) => r.id === targetId)
      if (!repo || !target) throw new HiveError('not_found', 'Repository not found')
      if (id === targetId) return
      if (repo.companyId !== target.companyId) throw new HiveError('bad_request', 'That repository belongs to another company. Drop it on the company to move it there.')
      const own = all.filter((r) => r.companyId === repo.companyId).sort((a, b) => a.companyOrder! - b.companyOrder!).map((r) => r.id)
      this.setMeta(`repo_order:${repo.companyId}`, JSON.stringify(placed(own, id, targetId, placement)))
      this.setMeta('repo_order', JSON.stringify(placed(all.map((r) => r.id), id, targetId, placement)))
    })()
  }
  getRepo(id: Id, live: (id: Id) => number = () => 0): Repo | null {
    const r = this.db.prepare(`${REPO_SELECT} WHERE repos.id = ?`).get(id) as RepoRow | undefined
    return r ? this.repoFromRow(r, live) : null
  }
  getRepoByPath(p: string): Repo | null {
    const r = this.db.prepare(`${REPO_SELECT} WHERE repos.path = ?`).get(p) as RepoRow | undefined
    return r ? this.repoFromRow(r, () => 0) : null
  }
  /** Returns [repo, created]. Path must be an absolute, existing directory (caller realpaths it). */
  addRepo(absPath: string): [Repo, boolean] {
    const existing = this.getRepoByPath(absPath)
    if (existing) return [existing, false]
    const id = newId('repo')
    this.db
      .prepare('INSERT INTO repos(id, name, path, added_at) VALUES (?,?,?,?)')
      .run(id, path.basename(absPath) || absPath, absPath, this.ts())
    return [this.getRepo(id)!, true]
  }
  renameRepo(id: Id, name: string): Repo {
    const r = this.db.prepare('UPDATE repos SET name = ? WHERE id = ?').run(name, id)
    if (!r.changes) throw new HiveError('not_found', 'Repository not found')
    return this.getRepo(id)!
  }
  removeRepo(id: Id): void {
    const r = this.db.prepare('DELETE FROM repos WHERE id = ?').run(id)
    if (!r.changes) throw new HiveError('not_found', 'Repository not found')
  }
  /** Repos ordered by most recent session (then newest added). */
  recentRepos(limit: number): Repo[] {
    const rows = this.db
      .prepare(
        `SELECT repos.*, ${REPO_COMPANY('repos.id')} AS company_id FROM repos LEFT JOIN (SELECT repo_id, MAX(started_at) AS last FROM sessions GROUP BY repo_id) s
         ON s.repo_id = repos.id ORDER BY COALESCE(s.last, repos.added_at) DESC LIMIT ?`
      )
      .all(limit) as RepoRow[]
    return rows.map((r) => this.repoFromRow(r, () => 0))
  }

  // ---------- profiles ----------
  listProfiles(): AgentProfile[] {
    return (this.db.prepare('SELECT * FROM profiles ORDER BY is_default DESC, adapter, name').all() as ProfileRow[]).map(
      profileFromRow
    )
  }
  getProfile(id: Id): AgentProfile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined
    return r ? profileFromRow(r) : null
  }
  defaultProfileFor(adapter: AdapterId): AgentProfile | null {
    const r = this.db
      .prepare('SELECT * FROM profiles WHERE adapter = ? ORDER BY is_default DESC, created_at LIMIT 1')
      .get(adapter) as ProfileRow | undefined
    return r ? profileFromRow(r) : null
  }
  createProfile(input: AgentProfileInput, isDefault = false): AgentProfile {
    const id = newId('profile')
    const ts = this.ts()
    this.db
      .prepare(
        `INSERT INTO profiles(id, name, adapter, model, extra_args_json, permission_mode, secret_names_json,
          use_api_key_auth, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.name,
        input.adapter,
        input.model ?? null,
        JSON.stringify(input.extraArgs ?? []),
        input.permissionMode ?? 'bypass',
        JSON.stringify(input.secretNames ?? ['*']),
        int(!!input.useApiKeyAuth),
        int(isDefault),
        ts,
        ts
      )
    return this.getProfile(id)!
  }
  updateProfile(id: Id, patch: Partial<AgentProfileInput>): AgentProfile {
    if (!this.getProfile(id)) throw new HiveError('not_found', 'Profile not found')
    const { set, params } = buildPatch(patch as Record<string, unknown>, {
      name: { col: 'name' },
      adapter: { col: 'adapter' },
      model: { col: 'model' },
      extraArgs: { col: 'extra_args_json', kind: 'json' },
      permissionMode: { col: 'permission_mode' },
      secretNames: { col: 'secret_names_json', kind: 'json' },
      useApiKeyAuth: { col: 'use_api_key_auth', kind: 'bool' }
    })
    if (set)
      this.db
        .prepare(`UPDATE profiles SET ${set}, updated_at = @__ts WHERE id = @__id`)
        .run({ ...params, __ts: this.ts(), __id: id })
    return this.getProfile(id)!
  }
  /** Names of workflows/schedules that reference a profile. */
  profileUsage(id: Id): string[] {
    const used: string[] = []
    for (const wf of this.listWorkflows()) {
      const hit = wf.nodes.some(
        (n) =>
          ((n.type === 'agent' || n.type === 'check') && n.profileId === id) ||
          (n.type === 'room' && n.participants.some((p) => p.profileId === id))
      )
      if (hit) used.push(`workflow "${wf.name}"`)
    }
    for (const s of this.listSchedules()) {
      if (s.target.kind === 'prompt' && s.target.profileId === id) used.push(`schedule "${s.name}"`)
    }
    return used
  }
  removeProfile(id: Id): void {
    if (!this.getProfile(id)) throw new HiveError('not_found', 'Profile not found')
    const used = this.profileUsage(id)
    if (used.length) throw new HiveError('conflict', `Used by: ${used.join(', ')}`)
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
  }

  // ---------- sessions ----------
  /** COMPANY.md §3: stamped with the launcher's companyId, else the repo's company, else Personal. */
  insertSession(s: SessionInsert): void {
    // optional columns only when set (an older schema without them still inserts plain sessions)
    const opt: [col: string, key: 'departmentId' | 'companyAgentId'][] = [['department_id', 'departmentId'], ['company_agent_id', 'companyAgentId']]
    const used = opt.filter(([, k]) => !!s[k])
    this.db
      .prepare(
        `INSERT INTO sessions(id, title, profile_id, adapter, repo_id, cwd, status, pid, cols, rows, exit_code, started_at,
          ended_at, artifacts_dir, log_path, from_run_id, agent_session_id, company_id${used.map(([c]) => `, ${c}`).join('')})
         VALUES (@id, @title, @profileId, @adapter, @repoId, @cwd, @status, @pid, @cols, @rows, @exitCode, @startedAt,
          @endedAt, @artifactsDir, @logPath, @fromRunId, @agentSessionId, COALESCE(@companyId, ${REPO_COMPANY('@repoId')})${used.map(([, k]) => `, @${k}`).join('')})`
      )
      .run((({ departmentId, companyAgentId, ...rest }) => ({ ...rest, companyId: s.companyId ?? null, ...(departmentId ? { departmentId } : {}), ...(companyAgentId ? { companyAgentId } : {}) }))(s))
  }
  updateSession(id: Id, patch: Partial<Omit<Session, 'id'>>): Session {
    const { set, params } = buildPatch(patch as Record<string, unknown>, {
      title: { col: 'title' },
      status: { col: 'status' },
      pid: { col: 'pid' },
      cols: { col: 'cols' },
      rows: { col: 'rows' },
      exitCode: { col: 'exit_code' },
      endedAt: { col: 'ended_at' },
      agentSessionId: { col: 'agent_session_id' }
    })
    if (set) this.db.prepare(`UPDATE sessions SET ${set} WHERE id = @__id`).run({ ...params, __id: id })
    const s = this.getSession(id)
    if (!s) throw new HiveError('not_found', 'Session not found')
    return s
  }
  getSession(id: Id): Session | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r ? sessionFromRow(r) : null
  }
  sessionLogPath(id: Id): string | null {
    const r = this.db.prepare('SELECT log_path FROM sessions WHERE id = ?').get(id) as { log_path: string } | undefined
    return r?.log_path ?? null
  }
  listSessions(status: 'running' | 'exited' | 'all' = 'all', since?: string, companyId?: Id): Session[] {
    const where: string[] = []
    const params: unknown[] = []
    if (companyId) {
      where.push(`${companyOf('company_id')} = ?`)
      params.push(companyId)
    }
    if (status !== 'all') {
      where.push('status = ?')
      params.push(status)
    }
    if (since) {
      where.push("(status = 'running' OR started_at >= ? OR ended_at >= ?)")
      params.push(since, since)
    }
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC`
    return (this.db.prepare(sql).all(...params) as SessionRow[]).map(sessionFromRow)
  }
  deleteSession(id: Id): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }
  /** Boot recovery: running -> exited (exit_code null). Returns ids. */
  recoverSessions(): Id[] {
    const ids = (this.db.prepare("SELECT id FROM sessions WHERE status = 'running'").all() as { id: string }[]).map(
      (r) => r.id
    )
    this.db
      .prepare("UPDATE sessions SET status = 'exited', pid = NULL, exit_code = NULL, ended_at = ? WHERE status = 'running'")
      .run(this.ts())
    return ids
  }
  /** Exited sessions that ended before `before`. */
  staleSessions(before: string): { id: Id; logPath: string; artifactsDir: string }[] {
    return (
      this.db
        .prepare("SELECT id, log_path, artifacts_dir FROM sessions WHERE status = 'exited' AND COALESCE(ended_at, started_at) < ?")
        .all(before) as { id: string; log_path: string; artifacts_dir: string }[]
    ).map((r) => ({ id: r.id, logPath: r.log_path, artifactsDir: r.artifacts_dir }))
  }

  // ---------- workflows ----------
  listWorkflows(companyId?: Id): Workflow[] {
    const rows = companyId
      ? this.db.prepare(`SELECT * FROM workflows WHERE ${companyOf('company_id')} = ? ORDER BY updated_at DESC`).all(companyId)
      : this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all()
    return (rows as WorkflowRow[]).map(workflowFromRow)
  }
  getWorkflow(id: Id): Workflow | null {
    const r = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined
    return r ? workflowFromRow(r) : null
  }
  /** COMPANY.md §3: stamped with the company it is created or installed from; seeds and unscoped callers go to Personal. */
  createWorkflow(draft: WorkflowDraft, seedKey: string | null = null, origin: WorkflowOrigin | null = null, companyId: Id = PERSONAL_COMPANY_ID): Workflow {
    const id = newId('workflow')
    const ts = this.ts()
    this.db
      .prepare(
        'INSERT INTO workflows(id, name, description, inputs_json, nodes_json, seed_key, created_at, updated_at, worktree_json, origin_json, company_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        draft.name,
        draft.description ?? '',
        JSON.stringify(draft.inputs ?? []),
        JSON.stringify(draft.nodes ?? []),
        seedKey,
        ts,
        ts,
        draft.worktree ? JSON.stringify(draft.worktree) : null,
        origin ? JSON.stringify(origin) : null,
        companyId
      )
    // SLACK.md §9.4 (add-only column)
    if (draft.slackTools !== undefined) this.db.prepare('UPDATE workflows SET slack_tools = ? WHERE id = ?').run(draft.slackTools ? 1 : null, id)
    this.db.prepare('UPDATE workflows SET slack_agent_permissions = ? WHERE id = ?').run(draft.slackTools && draft.slackAgentPermissions === 'profile' ? 'profile' : null, id)
    return this.getWorkflow(id)!
  }
  updateWorkflow(id: Id, draft: WorkflowDraft): Workflow {
    const r = this.db
      .prepare('UPDATE workflows SET name = ?, description = ?, inputs_json = ?, nodes_json = ?, worktree_json = ?, updated_at = ? WHERE id = ?')
      .run(
        draft.name,
        draft.description ?? '',
        JSON.stringify(draft.inputs ?? []),
        JSON.stringify(draft.nodes ?? []),
        draft.worktree ? JSON.stringify(draft.worktree) : null,
        this.ts(),
        id
      )
    if (!r.changes) throw new HiveError('not_found', 'Workflow not found')
    this.db.prepare('UPDATE workflows SET slack_tools = ? WHERE id = ?').run(draft.slackTools ? 1 : null, id)
    this.db.prepare('UPDATE workflows SET slack_agent_permissions = ? WHERE id = ?').run(draft.slackTools && draft.slackAgentPermissions === 'profile' ? 'profile' : null, id)
    return this.getWorkflow(id)!
  }
  /** Re-homes a workflow (marketplace installs into the caller's company, "Duplicate to company…" copies). */
  setWorkflowCompany(id: Id, companyId: Id): void {
    const r = this.db.prepare('UPDATE workflows SET company_id = ? WHERE id = ?').run(companyId, id)
    if (!r.changes) throw new HiveError('not_found', 'Workflow not found')
  }
  /** AUTHORING.md §2.5: provenance (agent-created / agent-updated). Human edits never clear it. */
  setWorkflowOrigin(id: Id, origin: WorkflowOrigin | null): void {
    this.db.prepare('UPDATE workflows SET origin_json = ? WHERE id = ?').run(origin ? JSON.stringify(origin) : null, id)
  }
  removeWorkflow(id: Id): void {
    if (!this.getWorkflow(id)) throw new HiveError('not_found', 'Workflow not found')
    const used = this.listSchedules().filter((s) => s.target.kind === 'workflow' && s.target.workflowId === id)
    if (used.length) throw new HiveError('conflict', `Used by: ${used.map((s) => `schedule "${s.name}"`).join(', ')}`)
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
  }
  seedKeyUsed(key: string): boolean {
    return !!this.getMeta(`seeded_wf:${key}`) || !!this.db.prepare('SELECT 1 FROM workflows WHERE seed_key = ?').get(key)
  }

  // ---------- runs (read side; the engine writes through EngineStore) ----------
  listRuns(q: RunListQuery = {}): Run[] {
    const where: string[] = []
    const params: unknown[] = []
    if (q.companyId) {
      where.push(`${companyOf('runs.company_id')} = ?`)
      params.push(q.companyId)
    }
    if (q.status?.length) {
      where.push(`runs.status IN (${q.status.map(() => '?').join(',')})`)
      params.push(...q.status)
    }
    if (q.workflowId) {
      where.push('runs.workflow_id = ?')
      params.push(q.workflowId)
    }
    if (q.scheduleId) {
      where.push('runs.schedule_id = ?')
      params.push(q.scheduleId)
    }
    if (q.since) {
      where.push('runs.created_at >= ?')
      params.push(q.since)
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000)
    const sql = `${RUN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY runs.created_at DESC LIMIT ${limit}`
    return (this.db.prepare(sql).all(...params) as RunRow[]).map(runFromRow)
  }
  getRun(id: Id): Run | null {
    const r = this.db.prepare(`${RUN_SELECT} WHERE runs.id = ?`).get(id) as RunRow | undefined
    return r ? runFromRow(r) : null
  }
  getRunDetail(id: Id): RunDetail | null {
    const r = this.db.prepare(`${RUN_SELECT} WHERE runs.id = ?`).get(id) as RunRow | undefined
    if (!r) return null
    const steps = (this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq').all(id) as StepRow[]).map(
      stepFromRow
    )
    return { run: runFromRow(r), steps, workflow: runSnapshot(r) }
  }
  /** Runs that ended since `since`, newest first. */
  endedRunsSince(since: string, limit: number, companyId?: string): Run[] {
    const co = companyId ? ` AND COALESCE(runs.company_id, 'co_personal') = ?` : ''
    return (
      this.db
        .prepare(`${RUN_SELECT} WHERE runs.ended_at >= ?${co} ORDER BY runs.ended_at DESC LIMIT ?`)
        .all(...(companyId ? [since, companyId, limit] : [since, limit])) as RunRow[]
    ).map(runFromRow)
  }
  countEndedSince(since: string): { passed: number; failed: number } {
    const r = this.db
      .prepare(
        `SELECT SUM(status = 'passed') AS passed, SUM(status = 'failed') AS failed FROM runs WHERE ended_at >= ?`
      )
      .get(since) as { passed: number | null; failed: number | null }
    return { passed: r.passed ?? 0, failed: r.failed ?? 0 }
  }
  /** countEndedSince per company (an unstamped run is Personal's), for the focused company's status bar. */
  countEndedSinceByCompany(since: string): Record<Id, { passed: number; failed: number }> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(company_id, ''), '${PERSONAL_COMPANY_ID}') AS c, SUM(status = 'passed') AS passed, SUM(status = 'failed') AS failed
         FROM runs WHERE ended_at >= ? GROUP BY c`
      )
      .all(since) as { c: string; passed: number | null; failed: number | null }[]
    return Object.fromEntries(rows.map((r) => [r.c, { passed: r.passed ?? 0, failed: r.failed ?? 0 }]))
  }

  // ---------- schedules (config columns; fire-state belongs to the engine) ----------
  listSchedules(companyId?: Id): Schedule[] {
    const rows = companyId
      ? this.db.prepare(`${SCHEDULE_SELECT} WHERE ${companyOf('schedules.company_id')} = ? ORDER BY schedules.created_at`).all(companyId)
      : this.db.prepare(`${SCHEDULE_SELECT} ORDER BY schedules.created_at`).all()
    return (rows as ScheduleRow[]).map((r) => scheduleFromRow(r, this.describe))
  }
  getSchedule(id: Id): Schedule | null {
    const r = this.db.prepare(`${SCHEDULE_SELECT} WHERE schedules.id = ?`).get(id) as ScheduleRow | undefined
    return r ? scheduleFromRow(r, this.describe) : null
  }
  /** COMPANY.md §3: the caller resolves the company from the schedule's workflow (handlers/schedules.ts). */
  insertSchedule(input: ScheduleInput, companyId: Id = PERSONAL_COMPANY_ID): Id {
    const id = newId('schedule')
    const ts = this.ts()
    this.db
      .prepare(
        `INSERT INTO schedules(id, name, target_json, when_json, preset_json, enabled, created_at, updated_at, company_id)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.target),
        JSON.stringify(input.when),
        input.preset ? JSON.stringify(input.preset) : null,
        int(input.enabled ?? true),
        ts,
        ts,
        companyId
      )
    this.writeScheduleDepartment(id, input.departmentId)
    return id
  }
  /** DEPARTMENTS.md §8: schedules.department_id (healed by openDatabase; a bare test db may lack it). undefined = keep. */
  private writeScheduleDepartment(id: Id, departmentId: Id | null | undefined): void {
    if (departmentId === undefined) return
    const cols = this.db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'department_id')) return
    this.db.prepare('UPDATE schedules SET department_id = ? WHERE id = ?').run(departmentId, id)
  }
  /** companyId: re-stamp (the target moved to a workflow of another company). Absent = keep the stamp. */
  updateScheduleConfig(id: Id, input: ScheduleInput, companyId?: Id): void {
    const existing = this.getSchedule(id)
    if (!existing) throw new HiveError('not_found', 'Schedule not found')
    this.db
      .prepare(
        'UPDATE schedules SET name = ?, target_json = ?, when_json = ?, preset_json = ?, enabled = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        input.name,
        JSON.stringify(input.target),
        JSON.stringify(input.when),
        input.preset ? JSON.stringify(input.preset) : null,
        int(input.enabled ?? existing.enabled),
        this.ts(),
        id
      )
    if (companyId) this.db.prepare('UPDATE schedules SET company_id = ? WHERE id = ?').run(companyId, id)
    this.writeScheduleDepartment(id, input.departmentId)
  }
  setScheduleEnabled(id: Id, enabled: boolean): void {
    const r = this.db
      .prepare('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(int(enabled), this.ts(), id)
    if (!r.changes) throw new HiveError('not_found', 'Schedule not found')
  }
  deleteSchedule(id: Id): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
  }
  scheduleEvents(scheduleId: Id, limit = 50): ScheduleEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM schedule_events WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(scheduleId, Math.min(Math.max(limit, 1), 500)) as ScheduleEventRow[]
    ).map(scheduleEventFromRow)
  }

  // ---------- artifacts ----------
  upsertArtifact(a: Omit<Artifact, 'id' | 'createdAt'>): { artifact: Artifact; changed: boolean; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE path = ?').get(a.path) as ArtifactRow | undefined
    if (existing) {
      if (existing.bytes === a.bytes && existing.mtime === a.mtime) {
        return { artifact: artifactFromRow(existing), changed: false, created: false }
      }
      this.db.prepare('UPDATE artifacts SET bytes = ?, mtime = ?, kind = ?, mime = ? WHERE id = ?').run(a.bytes, a.mtime, a.kind, a.mime, existing.id)
      return { artifact: this.getArtifact(existing.id)!, changed: true, created: false }
    }
    const id = newId('artifact')
    // COMPANY.md §3: denormalized from the run, else the session, else Personal
    this.db
      .prepare(
        `INSERT INTO artifacts(id, run_id, session_id, path, rel_path, name, kind, mime, bytes, mtime, created_at, company_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, (SELECT company_id FROM runs WHERE id = ?), (SELECT company_id FROM sessions WHERE id = ?), '${PERSONAL_COMPANY_ID}'))`
      )
      .run(id, a.runId, a.sessionId, a.path, a.relPath, a.name, a.kind, a.mime, a.bytes, a.mtime, this.ts(), a.companyId ?? null, a.runId, a.sessionId)
    return { artifact: this.getArtifact(id)!, changed: true, created: true }
  }
  getArtifact(id: Id): Artifact | null {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    return r ? artifactFromRow(r) : null
  }
  getArtifactByPath(p: string): Artifact | null {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE path = ?').get(p) as ArtifactRow | undefined
    return r ? artifactFromRow(r) : null
  }
  deleteArtifact(id: Id): void {
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id)
  }
  /** Artifacts whose path is under `dir` (absolute, no trailing slash). */
  artifactsUnder(dir: string): Artifact[] {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
    return (
      this.db.prepare("SELECT * FROM artifacts WHERE substr(path, 1, ?) = ?").all(prefix.length, prefix) as ArtifactRow[]
    ).map(artifactFromRow)
  }
  listArtifacts(q: ArtifactQuery = {}): Artifact[] {
    const where: string[] = []
    const params: unknown[] = []
    if (q.companyId) {
      where.push(`${companyOf('company_id')} = ?`)
      params.push(q.companyId)
    }
    if (q.runId) {
      where.push('run_id = ?')
      params.push(q.runId)
    }
    if (q.sessionId) {
      where.push('session_id = ?')
      params.push(q.sessionId)
    }
    if (q.kind) {
      where.push('kind = ?')
      params.push(q.kind)
    }
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000)
    const sql = `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY mtime DESC, created_at DESC LIMIT ${limit}`
    return (this.db.prepare(sql).all(...params) as ArtifactRow[]).map(artifactFromRow)
  }
}
