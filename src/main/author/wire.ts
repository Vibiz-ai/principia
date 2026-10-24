/**
 * Wires the authoring services into the running app (AUTHORING.md §1, §2, §6-§8): the broker behind the `hive` tools,
 * worktrees, notify nodes and Claude history. Effects go through the same store/engine paths the IPC handlers use.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerSpec, ProcessReaper } from '../../shared/engine'
import { AUTHOR_SERVER_NAME, AUTHOR_TOOLS, approveLabel, type AuthoringContext } from '../../shared/authoring'
import { SLACK_TOOLS } from '../../shared/slack'
import type { Ask } from '../../shared/live'
import type { AdapterId, Id, Run, SchedulePreview } from '../../shared/types'
import { departmentsEnabled, PERSONAL_COMPANY_ID } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import { newId } from '../../shared/ids'
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import { departmentActions } from '../handlers/company'
import { notify } from '../notify'
import { baseChildEnv } from '../loginEnv'
import { normalizeDraft, validateDraft } from '../handlers/workflows'
import { checkTarget } from '../handlers/runs'
import { guardSameCompany, guardWorkflowTargets, workflowRepoRefs } from '../handlers/companyScope'
import { repoForCwd } from '../memory/service'
import { AuthorBroker } from './broker'
import { ChatProposals } from '../company/chatProposals'
import { CHAT_COMPANY_TOOL } from '../../shared/chatCompany'
import { TASK_TOOLS, TaskTools, type TaskCaller } from '../company/taskTools'
import { AuthorDrafts, type DraftOwner, type DraftRecord } from './drafts'
import { WorktreeManager, gitRunner, runRepoPaths } from '../worktrees'
import { NotifyNode } from '../notifyNode'
import { ClaudeHistory, historyRoots } from '../history'

/** out/main/mcp-hive.js next to the main bundle. */
export function resolveAuthorScript(mainDir: string): string {
  return path.join(mainDir, 'mcp-hive.js')
}

const DAY = 86400_000
const TERMINAL_RUN = new Set(['passed', 'failed', 'canceled'])


export function ownerKeyFor(s: { id: Id; adapter: AdapterId; agentSessionId: string | null }): string {
  // claude: the conversation id survives Restart (it resumes the same conversation)
  return s.agentSessionId ? `${s.adapter}:${s.agentSessionId}` : `session:${s.id}`
}

/**
 * COMPANY.md §6: the company of the authoring call being served (the caller's session), carried across the broker's
 * awaits. Unset = a renderer-side read (lists everything, as the UI does).
 */
const authorCompany = new AsyncLocalStorage<Id>()

export function wireAuthoring(h: Hive, opts: { mainDir: string; reaper: ProcessReaper | null }): void {
  const git = gitRunner(() => baseChildEnv())
  const redact = (t: string) => h.vault.redact(t)

  // ---------- companies (COMPANY.md §3, §6): list, read, draft and push only the caller's company ----------
  const sessionCompany = (sessionId: Id | null | undefined): Id => (sessionId ? h.store.getSession(sessionId)?.companyId : null) || PERSONAL_COMPANY_ID
  /** Visible to the call being served: always with guards off (they warn, never hide) or outside a call. */
  const visible = (companyId: Id | null | undefined): boolean => {
    const scope = authorCompany.getStore()
    return !scope || !h.store.companyGuardsEnforced() || (companyId || PERSONAL_COMPANY_ID) === scope
  }
  const workflowCompany = (id: Id): Id => h.store.getWorkflow(id)?.companyId || PERSONAL_COMPANY_ID

  // ---------- worktrees (§6) ----------
  h.worktrees = new WorktreeManager({
    db: h.db,
    userData: h.paths.userData,
    git,
    repoIdForPath: (p) => h.store.getRepoByPath(p)?.id ?? null,
    pushBranches: (runId) => {
      // the workflow as it was when the run started (edits after start do not widen a running policy)
      const d = h.store.getRunDetail(runId)
      const t = d?.run.target
      const wf = d?.workflow ?? (t?.kind === 'workflow' ? h.store.getWorkflow(t.workflowId) : null)
      return wf?.worktree?.pushBranches ?? null
    },
    basePath: () => baseChildEnv().PATH ?? process.env.PATH ?? '/usr/bin:/bin',
    emit: (wt) => {
      emit('worktree:updated', wt)
      const run = h.store.getRun(wt.runId)
      if (run) emit('run:updated', run)
    },
    log
  })

  // branches created during a run (isolated or not): snapshot refs/heads of every repo the run may touch before any
  // node starts, sweep the ones with no new unpushed work when it ends (the rest are listed on the RunView)
  const snapped = new Set<Id>()
  const swept = new Set<Id>()
  h.runHooks.push((run) => {
    const wm = h.worktrees
    if (!wm) return
    if (!snapped.has(run.id) && !TERMINAL_RUN.has(run.status)) {
      snapped.add(run.id)
      wm.snapshotRun(run.id, runRepoPaths(h.store, run))
    }
    if (TERMINAL_RUN.has(run.status) && snapped.has(run.id) && !swept.has(run.id)) {
      swept.add(run.id)
      void wm.sweepRun(run.id).catch((e) => log.warn('run branch sweep failed', { runId: run.id, e: String(e) }))
    }
  })

  // ---------- notify nodes (§7.2) ----------
  h.notifyNode = new NotifyNode({
    post: (n) =>
      notify({
        title: n.title,
        body: n.body,
        sound: h.settings().notificationSound,
        onClick: n.runId ? () => h.windows.command({ kind: 'openRun', runId: n.runId! }) : undefined
      }),
    redact,
    // SLACK.md §10: the Slack half (h.slack is wired right after authoring)
    slack: () => h.slack?.alertPort() ?? null,
    log
  })

  // ---------- Claude history (§8, PO9: refresh on demand + window focus, no loop) ----------
  h.history = new ClaudeHistory({
    db: h.db,
    roots: () => historyRoots({ ...baseChildEnv(), HIVE_CLAUDE_DIRS: process.env.HIVE_CLAUDE_DIRS }),
    enabled: () => h.settings().claudeHistory !== false,
    inHiveIds: () => {
      const rows = h.db
        .prepare(
          'SELECT agent_session_id AS id FROM sessions WHERE agent_session_id IS NOT NULL UNION SELECT agent_session_id FROM run_steps WHERE agent_session_id IS NOT NULL'
        )
        .all() as { id: string }[]
      return new Set(rows.map((r) => r.id))
    },
    repoIdForCwd: (cwd) => repoForCwd(h.store.listRepos(), cwd)?.id ?? null,
    redact,
    emitChanged: (total) => emit('history:changed', { total }),
    log
  })

  // ---------- broker (§1.2, §2) ----------
  const ctx = (): AuthoringContext => {
    const profiles = h.store.listProfiles()
    const defaults: AuthoringContext['defaults'] = {}
    for (const a of ['claude', 'codex', 'gemini', 'cursor', 'shell'] as AdapterId[]) defaults[a] = h.store.defaultProfileFor(a)?.id ?? null
    return {
      profiles: profiles.map((p) => ({ id: p.id, name: p.name, adapter: p.adapter, permissionMode: p.permissionMode, model: p.model })),
      defaults,
      repos: h.store.listRepos().filter((r) => visible(r.companyId)).map((r) => ({ id: r.id, name: r.name, path: r.path, isGit: r.isGit, exists: r.exists }))
    }
  }
  const startRun = (workflowId: Id, inputs: Record<string, string>, startedBy: { ownerLabel: string; ownerKey: string; draftId: Id | null }): Run => {
    const target = { kind: 'workflow' as const, workflowId, inputs }
    checkTarget(h, target)
    // the caller's company is the explicit stamp: the engine guards a workflow of another company
    const scope = authorCompany.getStore()
    const run = h.engine.runs.start(target, { trigger: 'agent', startedBy, ...(scope ? { companyId: scope } : {}) })
    // persisted here too, so provenance holds even if the engine ignores startedBy
    h.db.prepare('UPDATE runs SET started_by_json = ? WHERE id = ?').run(JSON.stringify(startedBy), run.id)
    const fresh = h.store.getRun(run.id) ?? run
    emit('run:updated', fresh)
    h.statusChanged()
    return fresh
  }
  // ---------- the hivetask toolset (DEPARTMENTS.md §6): served by the broker, offered to task runs and sessions ----------
  const boardOn = () => departmentsEnabled(h.settings().experimental)
  const tasks = new TaskTools({
    company: () => h.company,
    redact,
    enabled: boardOn,
    onChange: () => {
      emit('data:changed', { domain: 'tasks' })
      h.statusChanged()
    },
    // a handed-off task wakes its auto target now (null until startDispatcher; the tick covers it then)
    pump: (companyId) => void h.dispatcher?.pump(companyId),
    // §9 company_create_department: the UI's departments:save path (department note), then the sidebar refreshes
    createDepartment: (input) => {
      const dep = departmentActions(h).save({ companyId: input.companyId, name: input.name, ...(input.key ? { key: input.key } : {}), data: { charter: { does: input.does, doesNot: input.doesNot } } })
      emit('data:changed', { domain: 'departments' })
      return { id: dep.id, key: dep.key, name: dep.name }
    },
    log
  })
  // headless claude steps of a task run list the tools on their hivemem server (executor withTaskTools)
  h.taskToolset = (req) => tasks.toolset(req)
  // §4.5: the fenced report of inject adapters, written before the run ends (step output precedes the run end)
  h.stepOutputHooks?.push((e) => void tasks.harvest(e))
  // §6: a handoff is applied at run end, before syncRun computes the outcome (every syncRun caller: run hooks,
  // reconcile, session leases)
  const company = h.company as Hive['company'] | undefined
  if (company) {
    const syncRun = company.syncRun.bind(company)
    company.syncRun = (run) => {
      tasks.beforeSyncRun(run)
      return syncRun(run)
    }
  }

  const drafts = new AuthorDrafts(h.db, redact)
  const proposals = new ChatProposals({
    emit: (p) => emit('chatCompany:updated', p),
    sessionTitle: (id) => h.store.getSession(id)?.title ?? null,
    home: os.homedir(),
    // the founder said yes in the chat, so they are usually looking at it; a notification only when Principia is behind
    attention: (p) => {
      try {
        if (h.windows.isFocused()) return
        notify({ title: p.name ? `Create ${p.name}?` : 'Create a new company?', body: 'A chat suggests setting this up as a new Principia company.', sound: h.settings().notificationSound, onClick: () => h.windows.show() })
      } catch {
        /* best effort */
      }
    }
  })
  h.chatProposals = proposals
  h.author = new AuthorBroker({
    drafts,
    owner: (sessionId): DraftOwner | null => {
      const s = h.store.getSession(sessionId)
      if (!s) return null
      return {
        kind: 'session',
        sessionId,
        agentId: h.live?.rootOfSession(sessionId)?.id ?? null,
        ownerKey: ownerKeyFor(s),
        ownerLabel: s.title,
        adapter: s.adapter
      }
    },
    ctx,
    providers: () => h.safe(() => h.engine.providers.cached(), []),
    engineValidate: (d) => {
      const errors = h.engine.workflows.validate(normalizeDraft(d))
      // COMPANY.md §3: with guards enforced, a proposal naming another company's repo is invalid right away (the
      // agent can fix it) instead of an approval card that can never be approved
      const scope = authorCompany.getStore()
      if (scope && h.store.companyGuardsEnforced()) {
        for (const ref of workflowRepoRefs(h, d)) {
          const problem = h.safe(() => h.company.crossCompany(scope, ref), null)
          if (problem) {
            errors.push({ path: 'nodes', message: problem })
            break
          }
        }
      }
      return errors
    },
    defaultBranch: async (repoPath) => {
      const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
      if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim().replace(/^origin\//, '')
      for (const b of ['main', 'master']) if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: repoPath })).code === 0) return b
      return null
    },
    listWorkflows: () => h.store.listWorkflows().filter((w) => visible(w.companyId)),
    getWorkflow: (id) => {
      const w = h.store.getWorkflow(id)
      return w && visible(w.companyId) ? w : null
    },
    listSchedules: () => h.store.listSchedules().filter((s) => visible(s.companyId)),
    lastRun: (workflowId) => {
      const r = h.store.listRuns({ workflowId, limit: 1 })[0]
      return r && visible(r.companyId) ? r : null
    },
    getRunDetail: (id) => {
      const d = h.store.getRunDetail(id)
      return d && visible(d.run.companyId) ? d : null
    },
    activeAgentRuns: (ownerKey) =>
      (
        h.db
          .prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running') AND json_extract(started_by_json, '$.ownerKey') = ?")
          .get(ownerKey) as { n: number }
      ).n,
    previewSchedule: (when): SchedulePreview =>
      h.safe(() => h.engine.scheduler.preview(when), { ok: false, sentence: '', next: [], error: 'Schedules are not available' }),
    // stamped with the authoring session's company; its repo targets must be that company's
    saveWorkflow: (draft, origin) => {
      const d = normalizeDraft(draft)
      validateDraft(h, d)
      const companyId = authorCompany.getStore() ?? sessionCompany(origin.sessionId)
      guardWorkflowTargets(h, companyId, d)
      return h.store.createWorkflow(d, null, origin, companyId)
    },
    updateWorkflow: (id, draft) => {
      const d = normalizeDraft(draft)
      validateDraft(h, d, id)
      const scope = authorCompany.getStore()
      if (scope) guardSameCompany(h, scope, { workflowId: id }, 'authoring')
      guardWorkflowTargets(h, workflowCompany(id), d)
      return h.store.updateWorkflow(id, d)
    },
    setOrigin: (id, origin) => h.store.setWorkflowOrigin(id, origin),
    createSchedule: (input) => {
      const scheduleInput = { name: input.name, target: { kind: 'workflow' as const, workflowId: input.workflowId, inputs: input.inputs }, when: input.when, preset: input.preset, enabled: input.enabled !== false }
      const p = h.engine.scheduler.preview(input.when)
      if (!p.ok) throw new HiveError('validation', p.error ?? 'Invalid schedule')
      checkTarget(h, scheduleInput.target)
      // a schedule lives in its workflow's company (COMPANY.md §3)
      const scope = authorCompany.getStore()
      if (scope) guardSameCompany(h, scope, { workflowId: input.workflowId }, 'authoring')
      const id = h.store.insertSchedule(scheduleInput, workflowCompany(input.workflowId))
      h.safe(() => h.engine.scheduler.upsert(id), null)
      const fresh = h.store.getSchedule(id)!
      emit('schedule:updated', fresh)
      h.statusChanged()
      return fresh
    },
    startRun,
    openAsk: (rec: DraftRecord): Ask | null => {
      if (!h.live || !rec.sessionId) return null
      const root = h.live.rootOfSession(rec.sessionId)
      if (!root) return null
      const verb = rec.kind === 'create' ? 'Create workflow' : rec.kind === 'update' ? 'Update workflow' : 'Run workflow'
      const now = new Date()
      const ask: Ask = {
        id: newId('ask'),
        agentId: root.id,
        rootId: root.id,
        sessionId: rec.sessionId,
        runId: null,
        stepId: null,
        provider: rec.adapter,
        kind: 'approval',
        channel: 'author',
        title: `${verb} "${rec.workflowName}"`.slice(0, 200),
        detail: rec.summary.slice(0, 300),
        toolName: null,
        toolInput: null,
        question: rec.summary.slice(0, 2000),
        options: [
          { id: 'approve', label: approveLabel({ kind: rec.kind, hasSchedule: !!rec.scheduleRequest, runNow: !!rec.runNowRequest, schedulePaused: rec.scheduleRequest?.enabled === false }), kind: 'allow' },
          { id: 'reject', label: 'Reject', kind: 'deny' }
        ],
        status: 'open',
        answer: null,
        answeredVia: null,
        createdAt: now.toISOString(),
        answeredAt: null,
        expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(),
        draftId: rec.id
      }
      const stored = h.live.insertAsk(ask)
      h.onLiveEvent({ type: 'ask.updated', ask: stored })
      return stored
    },
    closeAsk: (askId, how) => {
      if (!h.live) return
      const a = h.live.getAsk(askId)
      if (!a || a.status !== 'open') return
      const u = h.live.updateAsk(askId, {
        status: how.status,
        answer: how.optionId ? { askId, optionId: how.optionId, ...(how.message ? { message: how.message } : {}) } : null,
        answeredVia: how.status === 'expired' ? 'timeout' : 'hive',
        answeredAt: new Date().toISOString()
      })
      h.onLiveEvent({ type: 'ask.updated', ask: u })
    },
    emitDraft: (d) => {
      // COMPANY.md §3: author_drafts.company_id comes from the authoring session (set once)
      try {
        h.db.prepare('UPDATE author_drafts SET company_id = ? WHERE id = ? AND company_id IS NULL').run(authorCompany.getStore() ?? sessionCompany(drafts.get(d.id)?.sessionId), d.id)
      } catch {
        /* older db without the column */
      }
      emit('author:updated', d)
      h.statusChanged()
    },
    changed: (domain) => emit('data:changed', { domain }),
    tz: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // SLACK.md §9.5: slack_trigger on create/update (resolved and checked by the Slack service)
    slackTriggers: {
      prepare: (raw, wf) => (h.slack ? h.slack.prepareAuthored(raw, wf) : { errors: [{ path: 'slack_trigger', message: 'Slack is not available in this Hive' }] }),
      save: (input, workflowId, origin) => h.slack?.saveAuthored(input, workflowId, origin),
      connected: () => !!h.slack?.connector.isConfigured(),
      alertUserId: () => h.settings().slackAlertUserId ?? null,
      channelName: (id) => h.slack?.connector.names.channel(id) ?? id
    },
    // shared/chatCompany.ts: the confirmation card behind principia_propose_company
    proposals: { propose: (sessionId, args, signal) => proposals.propose(sessionId, args, signal) },
    tasks: {
      resolve: (owner) => tasks.resolveCaller(owner),
      call: (caller, tool, args, hints) => tasks.call(caller as TaskCaller, tool, args, hints)
    },
    // SLACK.md §11: slack_* tools (sessions, and steps of Slack runs); the service decides from the owner
    slack: {
      call: (owner, tool, args) => {
        if (!h.slack) return Promise.reject(new Error(`Unknown tool: ${tool}`))
        return h.slack.toolCall(owner, tool, args)
      }
    },
    log
  })
  // every call runs in its session's company (filters above, stamps); a line naming another company is refused while
  // guards are enforced (a server started for one company never serves another)
  const broker = h.author
  const handleCall = broker.handleCall.bind(broker)
  broker.handleCall = (owner, line, writeAnswer) => {
    if (!('sessionId' in owner)) return handleCall(owner, line, writeAnswer)
    const companyId = sessionCompany(owner.sessionId)
    const l = (line && typeof line === 'object' ? line : {}) as { call_id?: unknown; company_id?: unknown }
    if (typeof l.company_id === 'string' && l.company_id !== companyId && h.store.companyGuardsEnforced()) {
      return writeAnswer(String(l.call_id ?? ''), { ok: false, error: 'This Hive tool server belongs to another company. Restart the session.' })
    }
    return authorCompany.run(companyId, () => handleCall(owner, line, writeAnswer))
  }
  // approving a card saves into the draft's company, whoever clicks (hub, tray, the card). The stamp wins over the
  // session's: the session may have been removed since (it would otherwise read as Personal)
  const draftCompany = (id: Id): Id => {
    try {
      const row = h.db.prepare('SELECT company_id FROM author_drafts WHERE id = ?').get(id) as { company_id: string | null } | undefined
      if (row?.company_id) return row.company_id
    } catch {
      /* older db without the column */
    }
    return sessionCompany(drafts.get(id)?.sessionId)
  }
  const decide = broker.decide.bind(broker)
  broker.decide = (req) => authorCompany.run(draftCompany(req.id), () => decide(req))

  // ---------- session attach (§1.1, PO1/PO7: interactive claude panes only) ----------
  const spawnDir = path.join(h.paths.userData, 'author', 'spawn')
  try {
    fs.mkdirSync(spawnDir, { recursive: true, mode: 0o700 })
  } catch {
    /* best effort */
  }
  const script = resolveAuthorScript(opts.mainDir)
  h.authorAttach = {
    server: (sessionId: Id, liveDir: string, companyId?: Id | null, o?: { chat?: boolean }): McpServerSpec | null => {
      if (!fs.existsSync(script)) return null
      // DEPARTMENTS.md §6: board sessions list task_*; a session opened for a task names it (cross-check only: the
      // broker resolves the task from the session at call time, so a lease stamped after spawn still works)
      const board = boardOn()
      let taskId: Id | null = null
      if (board) {
        try {
          taskId = (h.db.prepare("SELECT id FROM company_tasks WHERE run_id = ? AND status = 'in_progress' LIMIT 1").get(sessionId) as { id: Id } | undefined)?.id ?? null
        } catch {
          /* older db */
        }
      }
      return {
        name: AUTHOR_SERVER_NAME,
        command: process.execPath,
        args: [script],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          HIVE_LIVE_DIR: liveDir,
          // SLACK.md §11.1: what the server LISTS; main enforces every call by owner
          // DEPARTMENTS.md §9: a chat (no task) also lists the company tools (company_departments, company_file_task)
          // shared/chatCompany.ts: every session holding no task may offer to start a new company from the chat
          HIVE_TOOLSETS: `${h.slack?.sessionToolsets() ?? 'author'}${board ? ',task' : ''}${board && o?.chat && !taskId ? ',company' : ''}${taskId ? '' : ',newco'}`,
          ...(taskId ? { HIVE_TASK_ID: taskId } : {}),
          // COMPANY.md §6: the session's company (main still scopes every call by the session itself)
          ...(companyId ? { HIVE_COMPANY_ID: companyId } : {}),
          ...(opts.reaper?.tag(sessionId) ?? { HIVE_SPAWN_ID: sessionId, HIVE_USER_DATA: h.paths.userData })
        }
      }
    },
    // pre-allowed mcp__hive__* names for the pane: the slack group joins once Slack is connected
    get tools() {
      // company_departments reads; company_file_task is left to the pane's own permission prompt (a second yes)
      // principia_propose_company only opens a card in Principia (the founder confirms there): pre-allowed
      return [...AUTHOR_TOOLS, CHAT_COMPANY_TOOL, ...(h.slack?.connector.isConfigured() ? SLACK_TOOLS : []), ...(boardOn() ? [...TASK_TOOLS, 'company_departments'] : [])]
    },
    spawnDir
  }
}

/** Boot: worktree recovery (+ prune at most daily), draft expiry; then a 6 h expiry sweep. */
export function bootAuthoring(h: Hive): void {
  const last = Date.parse(h.store.getMeta('worktree_prune_at') ?? '') || 0
  const pruneDue = Date.now() - last > DAY
  void h.worktrees
    ?.bootRecover({ pruneDue })
    .then((r) => {
      if (pruneDue) h.store.setMeta('worktree_prune_at', new Date().toISOString())
      if (r.fixed || r.pruned) log.info('worktrees boot recovery', r)
    })
    .catch((e) => log.warn('worktrees boot recovery failed', { e: String(e) }))
  const sweep = () => {
    try {
      const n = h.author?.sweep() ?? 0
      if (n) log.info('expired author drafts', { count: n })
    } catch (e) {
      log.warn('author sweep failed', { e: String(e) })
    }
  }
  sweep()
  setInterval(sweep, 6 * 3600_000).unref?.()
}
