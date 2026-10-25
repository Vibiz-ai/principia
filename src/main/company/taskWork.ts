/**
 * WORKTREE.md: Start a code task into its own worktree, branch and agent; then the task follows the work.
 *
 * - Start (founder only): a task with a repository its company owns gets `<userData>/worktrees/task-<ID>` on
 *   `hive/<id>-<slug>` (WorktreeManager.ensureTask), its `work` binding, a `work` activity, and its agent's turn
 *   through CompanyStore.startTask → in_progress. Every later turn of that task runs in the same worktree with the push
 *   guard env (TaskRunBridge.workdir). Beyond the company's maxInFlight it is queued and starts when a seat frees up.
 * - The PR (gh, read-only): looked up once the branch is pushed, then polled every 60 s while open and on window focus.
 *   Ready → in_review; changes requested (a review not handled yet) → the agent goes again with the reviewer's note;
 *   merged (on GitHub, or Merge… here) or a local merge into the base → done, doneNote "Merged #N". Errors back off.
 * - The worktree folder gone while the task is open → a banner: Cancel Task · Back to Backlog · Keep As Is.
 *
 * Every status move is a compare-and-set on the task's status with a `work` activity by 'system', checked by
 * taskState.ts. Nothing here pushes, force-pushes, deletes a remote branch or touches the founder's checkout. No
 * Electron imports (confirm dialogs and the editor live in the handlers).
 */
import fs from 'node:fs'
import { HiveError } from '../../shared/errors'
import type { BoardTask, TaskStatus } from '../../shared/company'
import type { StartRunOptions } from '../../shared/engine'
import type { Run, RunTarget } from '../../shared/types'
import { GH_TEXT, canStartWork, taskBranchName, nextMove, workBrief, workGone, workQueued, workStarted, type GhState, type TaskPr, type TaskWork } from '../../shared/taskWork'
import type { WorktreeManager } from '../worktrees'
import type { CompanyStore } from './index'
import { assertTransition, transitionError } from './taskState'
import { taskWorkSchema } from './taskWorkSchema'
import { ghAuth, latestChanges, lookupPr, mergePr, type GhRunner } from './taskWorkGh'

export const WORK_POLL_MS = 60_000
const AUTH_TTL_MS = 60_000
const FOCUS_MIN_MS = 10_000
const BACKOFF_MAX_MS = 15 * 60_000
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface TaskWorkDeps {
  company: () => CompanyStore
  worktrees: () => WorktreeManager | null
  /** h.engine.runs.start */
  startRun(target: RunTarget, opts: StartRunOptions): Run
  cancelRun(runId: string): Promise<void>
  gh: GhRunner
  /** after a task changed (data:changed tasks, the board's pump) */
  onChange?(companyId: string): void
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
}

export type StartResult = { task: BoardTask; queued: boolean; message: string }
export type GoneChoice = 'cancel' | 'backlog' | 'keep'

export class TaskWorkService {
  private timer: NodeJS.Timeout | null = null
  /** tasks between Start and their run (the cap counts them) */
  private readonly starting = new Set<string>()
  /** per task: the worktree being made right now (Start, the queue and a dispatcher turn share one) */
  private readonly ensuring = new Map<string, Promise<boolean>>()
  /** per task: no gh call before this time (errors back off) */
  private readonly backoff = new Map<string, { until: number; ms: number }>()
  private auth: { state: GhState; at: number } | null = null
  private lastFocus = 0
  private polling: Promise<void> | null = null
  private disposed = false

  constructor(private readonly d: TaskWorkDeps) {}
  private get c(): CompanyStore { return this.d.company() }
  private now(): Date { return this.d.now ? this.d.now() : new Date() }
  private wt(): WorktreeManager {
    const w = this.d.worktrees()
    if (!w) throw new HiveError('not_implemented', 'Worktrees are not available')
    return w
  }

  // ---------- lifecycle ----------
  start(ms = WORK_POLL_MS): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => void this.poll(), ms)
    this.timer.unref?.()
    void this.poll()
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ---------- Start ----------
  /** The founder pressed Start. Queues beyond maxInFlight ("Queued: 3 already running"). */
  async startTask(taskId: string, profileId?: string): Promise<StartResult> {
    // one Start per task at a time (two windows, a double call): the second is refused before it touches anything
    if (this.starting.has(taskId) || this.ensuring.has(taskId)) throw new HiveError('conflict', 'This task is starting already')
    const t = this.c.task(taskId)
    const company = this.c.passport(t.companyId)
    if (!canStartWork(t, company.repoIds)) {
      if (!t.repoId) throw new HiveError('bad_request', 'Choose a repository for this task first')
      if (!company.repoIds.includes(t.repoId)) throw new HiveError('bad_request', `That repository does not belong to ${company.name}`)
      if (workStarted(t.work) || workQueued(t.work)) throw new HiveError('conflict', 'This task already has a worktree')
      throw new HiveError('bad_request', t.status === 'in_progress' ? 'An agent already owns this task' : 'Reopen this task before starting it')
    }
    if (!profileId && !t.agentId && !t.assigneeProfileId) throw new HiveError('bad_request', 'Assign an agent first')
    const why = transitionError(t, { status: 'in_progress' }, 'human', { start: true, depsDone: this.depsDone(t) })
    if (why) throw new HiveError('bad_request', why)
    const repo = this.c.store.getRepo(t.repoId!)
    if (!repo) throw new HiveError('not_found', 'Repository no longer exists')
    const running = this.running(t.companyId)
    const max = this.c.boardSettings(t.companyId).maxInFlight
    if (running >= max) {
      const wt = this.wt()
      this.writeWork(t.id, { ...this.blank(t, wt.taskPath(t.identifier)), queuedAt: this.now().toISOString() })
      const message = `Queued: ${running} already running`
      this.c.activity(t.id, 'work', `${message}. It starts when one finishes (limit ${max}).`, 'human')
      this.changed(t.companyId)
      return { task: this.c.task(t.id), queued: true, message }
    }
    const task = await this.begin(t.id, profileId, 'human')
    return { task, queued: false, message: `Started ${task.identifier} on ${task.work?.branch ?? 'its branch'}` }
  }

  /** Worktree, binding, activity, then the agent's turn (in_progress). A failed start leaves no worktree behind. */
  private async begin(taskId: string, profileId: string | undefined, actor: 'human' | 'system', work?: 'changes_requested'): Promise<BoardTask> {
    this.starting.add(taskId)
    const prev = this.c.task(taskId).work ?? null
    let created = false
    try {
      await this.ensureWorktree(taskId).then((c) => { created = c })
      const t = this.c.task(taskId)
      if (t.status === 'in_progress') throw new HiveError('conflict', 'An agent already owns this task')
      const brief = workBrief(t.work!)
      this.c.patchInFlight(taskId, {
        pendingWake: { reasons: [...(t.pendingWake?.reasons ?? []), brief].slice(-50), count: (t.pendingWake?.count ?? 0) + 1 },
        autoWakes: { windowStart: null, n: 0 }
      })
      const out = this.c.startTask(taskId, profileId, (target, companyId, link) => this.d.startRun(target, {
        trigger: 'task', companyId, taskId: link.taskId, agentId: link.agentId, resumeSessionId: link.resumeSessionId,
        runMinutes: link.agentId ? this.c.departments.getAgent(link.agentId)?.data.limits?.runMinutes ?? null : null
      }), { actor, ...(work ? { work } : {}) })
      this.changed(out.companyId)
      return out
    } catch (err) {
      // nothing was done in a worktree made a moment ago: take it away again so a retry starts clean. Not when an
      // agent took the task meanwhile (a dispatcher turn runs in that very worktree)
      let owned = false
      try { owned = this.c.task(taskId).status === 'in_progress' } catch { /* gone */ }
      if (created && !owned) {
        try {
          await this.wt().removeTask(taskId)
          this.writeWork(taskId, prev && prev.startedAt ? { ...prev, removedAt: prev.removedAt ?? this.now().toISOString(), queuedAt: null } : null)
        } catch (e) { this.d.log?.warn('task work: cleanup after a failed start', { taskId, error: String(e) }) }
      }
      throw err
    } finally {
      this.starting.delete(taskId)
    }
  }

  /** Creates the task's worktree when it has none yet; true when it was created now (by this call: a caller that
   *  joins a creation already under way gets false, so only the creator ever cleans it up). */
  private ensureWorktree(taskId: string): Promise<boolean> {
    const cur = this.ensuring.get(taskId)
    if (cur) return cur.then(() => false)
    const job = this.makeWorktree(taskId).finally(() => this.ensuring.delete(taskId))
    this.ensuring.set(taskId, job)
    return job
  }
  private async makeWorktree(taskId: string): Promise<boolean> {
    const t = this.c.task(taskId)
    if (t.work && workStarted(t.work) && t.work.worktreeId && fs.existsSync(t.work.worktreePath)) {
      if (t.work.queuedAt) this.writeWork(taskId, { queuedAt: null })
      return false
    }
    const repo = t.repoId ? this.c.store.getRepo(t.repoId) : null
    if (!repo) throw new HiveError('not_found', 'Repository no longer exists')
    const wm = this.wt()
    // a new worktree means a new folder: the provider conversation (keyed by folder) starts fresh
    if (t.agentSessionId) this.c.patchInFlight(taskId, { agentSessionId: null })
    // a task that had a worktree before (Keep As Is, Remove Worktree…) checks its own branch out again
    const row = await wm.ensureTask({ taskId, identifier: t.identifier, title: t.title, repo: repo.path, branch: t.work?.startedAt ? t.work.branch : null })
    if (row.status !== 'active') throw new HiveError('internal', `Could not create the worktree: ${row.error ?? 'unknown error'}`)
    const base = wm.taskBase(taskId)
    const at = this.now().toISOString()
    this.writeWork(taskId, { ...this.blank(t, row.path), ...(t.work && !t.work.removedAt ? t.work : {}), worktreePath: row.path, branch: row.branch, baseSha: base.baseSha, baseRef: base.baseRef, startedAt: at, worktreeId: row.id, queuedAt: null, goneAt: null, removedAt: null })
    this.c.activity(taskId, 'work', `Worktree created on ${row.branch} (${base.baseRef ?? 'HEAD'} @ ${(base.baseSha ?? '').slice(0, 7)}). Your checkout is not touched.`, 'system')
    return true
  }

  /** TaskRunBridge.workdir: every prompt turn of a Started task runs in its worktree. A queued task claimed by the
   *  dispatcher gets its worktree here, so no turn of a code task in the queue ever lands in the founder's checkout. */
  async workdir(taskId: string): Promise<{ cwd: string; env: Record<string, string> } | null> {
    let t: BoardTask
    try { t = this.c.task(taskId) } catch { return null }
    const w = t.work
    if (!w) return null
    // queued (no worktree yet), or its worktree was removed (Keep As Is, Remove Worktree…): the turn gets the task's own
    // worktree again on its branch. A task that had a worktree never runs in the founder's checkout; when this fails,
    // so does the turn. Gone and not chosen yet: the missing folder fails the turn.
    if (!w.startedAt || w.removedAt) await this.ensureWorktree(taskId)
    const cur = this.c.task(taskId).work!
    const env = this.wt().guardEnv(taskId)
    return { cwd: cur.worktreePath, env: { ...env, HIVE_TASK_ID: t.identifier } }
  }

  /** "Open as session" on a Started task: its worktree (it must exist), else null (the task's repo, as before). */
  sessionCwd(taskId: string): string | null {
    try {
      const w = this.c.task(taskId).work
      if (!w || !workStarted(w)) return null
      if (!fs.existsSync(w.worktreePath)) throw new HiveError('bad_request', `The worktree for this task is gone: ${w.worktreePath}`)
      return w.worktreePath
    } catch (e) {
      if (e instanceof HiveError && e.code === 'bad_request') throw e
      return null
    }
  }

  /** Tasks in flight in the company, plus the ones being started right now. */
  private running(companyId: string): number {
    const n = (this.c.store.db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND status='in_progress'").get(companyId) as { n: number }).n
    let extra = 0
    for (const id of this.starting) { try { const t = this.c.task(id); if (t.companyId === companyId && t.status !== 'in_progress') extra++ } catch { /* gone */ } }
    return n + extra
  }

  /** Queued tasks start oldest first while the company has room. */
  async drain(companyId?: string): Promise<string[]> {
    const started: string[] = []
    const queued = this.c.listTasks(companyId).filter((t) => workQueued(t.work)).sort((a, b) => (a.work!.queuedAt! < b.work!.queuedAt! ? -1 : 1))
    for (const t of queued) {
      if (this.disposed) break
      // claimed meanwhile (the dispatcher, a human Run now): its worktree came with the turn (workdir)
      if (t.status === 'in_progress') { this.writeWork(t.id, { queuedAt: null }); continue }
      if (t.status === 'done' || t.status === 'canceled') { this.writeWork(t.id, workStarted(t.work) ? { queuedAt: null } : null); continue }
      if (this.running(t.companyId) >= this.c.boardSettings(t.companyId).maxInFlight) continue
      try {
        // a review that asked for changes while every seat was busy restarts as that review; a plain Start as the founder's
        const changes = t.status === 'in_review' && workStarted(t.work)
        await this.begin(t.id, undefined, changes ? 'system' : 'human', changes ? 'changes_requested' : undefined)
        started.push(t.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const cur = this.c.task(t.id)
        // claimed while it was being started (a dispatcher turn in this same worktree): that turn is the start
        if (cur.status === 'in_progress') { if (cur.work?.queuedAt) this.writeWork(t.id, { queuedAt: null }); continue }
        this.writeWork(t.id, workStarted(cur.work) || cur.work?.startedAt ? { queuedAt: null } : null)
        this.c.activity(t.id, 'work', `Could not start from the queue: ${clip(msg)}`, 'system')
        this.changed(t.companyId)
      }
    }
    return started
  }

  // ---------- following the work ----------
  /** A run of a task ended: look for its PR (and the queue) right away. */
  onRunUpdated(run: Run): void {
    if (!['passed', 'failed', 'canceled'].includes(run.status) || this.disposed) return
    setImmediate(() => {
      const rows = this.c.store.db.prepare("SELECT data FROM company_tasks WHERE json_extract(data,'$.work') IS NOT NULL AND (run_id=? OR json_extract(data,'$.work.queuedAt') IS NOT NULL)").all(run.id) as { data: string }[]
      const ids = rows.map((r) => (JSON.parse(r.data) as { id: string }).id)
      void (async () => {
        for (const id of ids) { this.backoff.delete(id); await this.checkTask(id).catch((e) => this.d.log?.warn('task work: check failed', { taskId: id, error: String(e) })) }
        await this.drain().catch((e) => this.d.log?.warn('task work: queue failed', { error: String(e) }))
      })()
    })
  }

  /** Window focus: at most every 10 s. */
  focus(): Promise<void> {
    const now = Date.now()
    if (now - this.lastFocus < FOCUS_MIN_MS) return this.polling ?? Promise.resolve()
    this.lastFocus = now
    return this.poll({ force: true })
  }

  /** One pass: every task with a binding (gone check, local merge, PR), then the queue. Serialized. */
  poll(opts: { force?: boolean } = {}): Promise<void> {
    if (this.polling) return this.polling
    // a focus (or a forced pass) asks gh again: a sign-in or sign-out shows at once
    if (opts.force) this.auth = null
    this.polling = (async () => {
      try {
        const tasks = this.c.listTasks().filter((t) => workStarted(t.work) || workQueued(t.work) || (!!t.work?.pr && (t.work.pr.state === 'OPEN' || (t.work.pr.state === 'MERGED' && t.status !== 'done' && t.status !== 'canceled'))))
        for (const t of tasks) {
          if (this.disposed) return
          if (opts.force) this.backoff.delete(t.id)
          await this.checkTask(t.id).catch((e) => this.d.log?.warn('task work: check failed', { taskId: t.id, error: String(e) }))
        }
        await this.drain()
      } finally {
        this.polling = null
      }
    })()
    return this.polling
  }

  /** Gone check, local merge, PR lookup and the move it implies, for one task. */
  async checkTask(taskId: string): Promise<void> {
    let t = this.c.task(taskId)
    const w = t.work
    if (!w || workQueued(w)) return
    const closed = t.status === 'done' || t.status === 'canceled'
    // the folder went away by hand while the task is open: ask (once)
    if (workStarted(w) && !closed && !w.goneAt && !fs.existsSync(w.worktreePath)) {
      this.writeWork(taskId, { goneAt: this.now().toISOString() })
      this.c.activity(taskId, 'work', `The worktree for ${t.identifier} is gone (${w.worktreePath}). Cancel Task, Back to Backlog or Keep As Is.`, 'system')
      this.changed(t.companyId)
      t = this.c.task(taskId)
    }
    if (closed) return
    const wm = this.d.worktrees()
    // a local merge of the branch into its base (ancestry only), unless an open PR still decides
    if (wm && workStarted(w) && !workGone(w) && t.status !== 'in_progress' && w.pr?.state !== 'OPEN' && (await wm.mergedLocally(taskId))) {
      this.complete(t, `Merged ${w.branch} into ${(w.baseRef ?? 'the base').replace(/^origin\//, '')} locally`)
      await this.cleanup(taskId)
      return
    }
    // GitHub: only for a pushed branch or a PR we know of, never more often than the backoff allows
    const b = this.backoff.get(taskId)
    if (b && b.until > Date.now()) return
    const known = w.pr
    // a PR merged while a run held the task (recorded, no move then): the run is over now, so it is done
    if (known?.state === 'MERGED') {
      if (t.status !== 'in_progress') {
        this.complete(t, `Merged #${known.number}`)
        if (this.c.task(taskId).status === 'done') await this.cleanup(taskId)
        this.changed(t.companyId)
      }
      return
    }
    if (!known && !(wm && workStarted(w) && (await wm.taskPushed(taskId)))) return
    if (known && known.state !== 'OPEN') return
    const cwd = fs.existsSync(w.worktreePath) ? w.worktreePath : (this.c.store.getRepo(w.repoId)?.path ?? w.worktreePath)
    const gh = await this.ghState(cwd)
    if (gh !== 'ok') {
      if (w.gh !== gh) { this.writeWork(taskId, { gh }); this.changed(t.companyId) }
      return
    }
    const found = await lookupPr(this.d.gh, { cwd, url: known?.url ?? null, branch: w.branch }, this.now())
    if (found.kind === 'error') {
      const ms = Math.min(BACKOFF_MAX_MS, (b?.ms ?? WORK_POLL_MS / 2) * 2)
      this.backoff.set(taskId, { until: Date.now() + ms, ms })
      if (w.gh !== 'error' || w.error !== found.message) { this.writeWork(taskId, { gh: 'error', error: clip(found.message, 300) }); this.changed(t.companyId) }
      return
    }
    this.backoff.delete(taskId)
    if (found.kind === 'none') {
      if (w.gh !== 'ok' || w.error) { this.writeWork(taskId, { gh: 'ok', error: null }); this.changed(t.companyId) }
      return
    }
    await this.applyPr(taskId, found.pr, cwd)
  }

  /** A fresh PR reading: record it, then the move nextMove decides. */
  private async applyPr(taskId: string, pr: TaskPr, cwd: string): Promise<void> {
    const t = this.c.task(taskId)
    const w = t.work!
    const prev = w.pr
    const same = prev && prev.number === pr.number && prev.state === pr.state && prev.isDraft === pr.isDraft && prev.reviewDecision === pr.reviewDecision
    this.writeWork(taskId, { pr, gh: 'ok', error: null, ...(pr.state === 'MERGED' ? { conflict: false } : {}) })
    if (!prev || prev.number !== pr.number) this.c.activity(taskId, 'work', `Pull request #${pr.number} opened${pr.isDraft ? ' as a draft' : ''}: ${pr.url}`, 'system')
    else if (!same && prev.isDraft && !pr.isDraft && pr.state === 'OPEN') this.c.activity(taskId, 'work', `Pull request #${pr.number} is ready for review`, 'system')
    let changes: { at: string; author: string; body: string } | null = null
    if (pr.state === 'OPEN' && pr.reviewDecision === 'CHANGES_REQUESTED' && t.status === 'in_review') changes = await latestChanges(this.d.gh, cwd, pr.url)
    const move = nextMove(t, pr, w, changes?.at ?? null)
    if (pr.state === 'OPEN' && !pr.isDraft && t.status !== 'in_progress' && w.readySeen !== pr.number) this.writeWork(taskId, { readySeen: pr.number })
    if (move.kind === 'done') {
      this.complete(t, move.note)
      await this.cleanup(taskId)
    } else if (move.kind === 'review') {
      this.moveTo(t, 'in_review', { work: 'pr_ready' }, `Pull request #${pr.number} is open: In Review`)
    } else if (move.kind === 'changes') {
      const who = changes ? `@${changes.author}` : 'a reviewer'
      const note = changes?.body.trim() ? clip(changes.body.trim().replace(/\s+/g, ' '), 600) : 'No summary given.'
      this.writeWork(taskId, { reviewSeenAt: move.reviewAt ?? this.now().toISOString() })
      this.c.activity(taskId, 'work', `Changes requested on #${pr.number} by ${who}: ${note}`, 'system')
      const cur = this.c.task(taskId)
      this.c.patchInFlight(taskId, { pendingWake: { reasons: [...(cur.pendingWake?.reasons ?? []), `Changes requested on PR #${pr.number} by ${who}: ${note} Address the review in this worktree, push the branch, and say what changed.`].slice(-50), count: (cur.pendingWake?.count ?? 0) + 1 } })
      if (this.running(t.companyId) >= this.c.boardSettings(t.companyId).maxInFlight) {
        this.writeWork(taskId, { queuedAt: this.now().toISOString() })
        this.c.activity(taskId, 'work', `Queued: ${this.running(t.companyId)} already running`, 'system')
      } else {
        try { await this.begin(taskId, undefined, 'system', 'changes_requested') } catch (err) {
          this.c.activity(taskId, 'work', `Could not restart the agent: ${clip(err instanceof Error ? err.message : String(err))}`, 'system')
        }
      }
    }
    this.changed(t.companyId)
  }

  /** done with the auto note, by the system on behalf of the human who merged. Heals the tasks waiting on it. */
  private complete(t: BoardTask, note: string): void {
    if (!this.depsDone(t)) {
      if (!t.work?.error?.startsWith('Merged')) {
        this.writeWork(t.id, { error: `${note}, but its dependencies are not done yet` })
        this.c.activity(t.id, 'work', `${note}. Finish its dependencies, then approve it.`, 'system')
      }
      return
    }
    this.moveTo(t, 'done', { work: 'merged', doneNote: note }, `${note}: Done`, { doneNote: note })
    this.c.heal(t.companyId)
  }

  /** After a merge: the worktree goes when nothing would be lost (else it stays, listed on the task). */
  private async cleanup(taskId: string): Promise<void> {
    const wm = this.d.worktrees()
    if (!wm) return
    try {
      const loss = await wm.taskLoss(taskId)
      if (loss.dirty.length || loss.unpushed.length) return
      if (loss.exists) await wm.removeTask(taskId)
      else await wm.forgetTask(taskId)
      this.writeWork(taskId, { removedAt: this.now().toISOString(), goneAt: null })
      this.c.activity(taskId, 'work', 'Worktree removed: everything on it is merged', 'system')
    } catch (e) {
      this.d.log?.warn('task work: cleanup after merge', { taskId, error: String(e) })
    }
  }

  // ---------- founder actions ----------
  /** Merge… (after the native confirm): gh pr merge --squash. A conflict stops at "Merge conflict, open in editor". */
  async merge(taskId: string): Promise<{ task: BoardTask; message: string }> {
    const t = this.c.task(taskId)
    const pr = t.work?.pr
    if (!pr || pr.state !== 'OPEN') throw new HiveError('bad_request', 'There is no open pull request to merge')
    if (pr.isDraft) throw new HiveError('bad_request', 'The pull request is a draft; mark it ready on GitHub first')
    const cwd = t.work && fs.existsSync(t.work.worktreePath) ? t.work.worktreePath : (this.c.store.getRepo(t.work!.repoId)?.path ?? process.cwd())
    const gh = await this.ghState(cwd, true)
    if (gh !== 'ok') throw new HiveError('bad_request', GH_TEXT[gh])
    const r = await mergePr(this.d.gh, cwd, pr.url)
    if (r.kind === 'conflict') {
      this.writeWork(taskId, { conflict: true, error: 'Merge conflict, open in editor' })
      this.c.activity(taskId, 'work', `Merge of #${pr.number} stopped: merge conflict. Open the worktree in your editor.`, 'human')
      this.changed(t.companyId)
      return { task: this.c.task(taskId), message: 'Merge conflict, open in editor' }
    }
    if (r.kind === 'error') throw new HiveError('bad_request', `GitHub refused the merge: ${r.message}`)
    this.c.activity(taskId, 'work', `Merged #${pr.number} from Principia (squash)`, 'human')
    this.backoff.delete(taskId)
    const found = await lookupPr(this.d.gh, { cwd, url: pr.url, branch: t.work!.branch }, this.now())
    await this.applyPr(taskId, found.kind === 'pr' ? found.pr : { ...pr, state: 'MERGED', mergedAt: this.now().toISOString(), checkedAt: this.now().toISOString() }, cwd)
    return { task: this.c.task(taskId), message: `Merged #${pr.number}` }
  }

  /** What Remove Worktree… would lose (the confirm lists it). */
  async loss(taskId: string): Promise<{ exists: boolean; dirty: string[]; unpushed: string[] }> {
    this.c.task(taskId)
    return this.wt().taskLoss(taskId)
  }

  /** Remove Worktree… (after the confirm). Refused while an agent works in it. */
  async removeWorktree(taskId: string, discardWork: boolean): Promise<BoardTask> {
    const t = this.c.task(taskId)
    if (!workStarted(t.work)) throw new HiveError('bad_request', 'This task has no worktree')
    if (t.status === 'in_progress') throw new HiveError('conflict', 'An agent is working in this worktree. Stop it first.')
    const loss = await this.wt().taskLoss(taskId)
    if (loss.exists) await this.wt().removeTask(taskId, { discardWork })
    else await this.wt().forgetTask(taskId)
    this.writeWork(taskId, { removedAt: this.now().toISOString(), goneAt: null })
    const lost = discardWork && (loss.dirty.length || loss.unpushed.length) ? ` (discarded ${[loss.dirty.length ? `${loss.dirty.length} uncommitted` : '', loss.unpushed.length ? `${loss.unpushed.length} unpushed` : ''].filter(Boolean).join(', ')})` : ''
    this.c.activity(taskId, 'work', `Worktree removed${lost}`, 'human')
    this.changed(t.companyId)
    return this.c.task(taskId)
  }

  /** The banner's three answers. */
  async resolveGone(taskId: string, choice: GoneChoice): Promise<BoardTask> {
    const t = this.c.task(taskId)
    if (!workGone(t.work)) throw new HiveError('bad_request', 'The worktree of this task is not gone')
    if (fs.existsSync(t.work!.worktreePath)) {
      this.writeWork(taskId, { goneAt: null })
      this.changed(t.companyId)
      return this.c.task(taskId)
    }
    if (t.status === 'in_progress' && choice !== 'keep') {
      if (t.runId && this.c.store.getRun(t.runId) && ['queued', 'running'].includes(this.c.store.getRun(t.runId)!.status)) await this.d.cancelRun(t.runId)
      const run = t.runId ? this.c.store.getRun(t.runId) : null
      if (run) this.c.syncRun(run)
      if (this.c.task(taskId).status === 'in_progress') this.c.park(taskId, 'interrupted', 'The worktree was removed')
    }
    await this.wt().forgetTask(taskId).catch((e) => this.d.log?.warn('task work: forget', { taskId, error: String(e) }))
    if (choice === 'cancel') {
      this.c.cancel(taskId)
      this.writeWork(taskId, null)
      this.c.activity(taskId, 'work', 'The worktree was gone: task canceled', 'human')
    } else if (choice === 'backlog') {
      const cur = this.c.task(taskId)
      this.moveTo(cur, 'backlog', { worktreeGone: true }, 'The worktree was gone: back to Backlog', {}, 'human')
      this.writeWork(taskId, null)
    } else {
      this.writeWork(taskId, { removedAt: this.now().toISOString() })
      this.c.activity(taskId, 'work', 'The worktree was gone: kept as is', 'human')
    }
    this.changed(t.companyId)
    return this.c.task(taskId)
  }

  // ---------- writes ----------
  private blank(t: BoardTask, worktreePath: string): TaskWork {
    return { repoId: t.repoId!, worktreePath, branch: taskBranchName(t.identifier, t.title), baseSha: null, baseRef: null, pr: null, startedAt: null, worktreeId: null, queuedAt: null, goneAt: null, removedAt: null, gh: null, reviewSeenAt: null, readySeen: null, conflict: false, error: null }
  }

  /** Writes `work` (merged into the stored one; null clears it). Only main writes it. */
  writeWork(taskId: string, patch: Partial<TaskWork> | null): BoardTask {
    const db = this.c.store.db
    return db.transaction(() => {
      const t = this.c.task(taskId)
      let next: TaskWork | null = null
      if (patch) {
        const base = t.work ?? null
        const merged = { ...(base ?? {}), ...patch } as TaskWork
        next = taskWorkSchema.parse(merged) as TaskWork
      }
      db.prepare("UPDATE company_tasks SET data=json_set(data,'$.work',json(?),'$.updatedAt',?) WHERE id=?").run(JSON.stringify(next), this.now().toISOString(), taskId)
      return this.c.task(taskId)
    })()
  }

  /** A compare-and-set status move with its `work` activity (checked by taskState.ts). */
  private moveTo(t: BoardTask, to: TaskStatus, ctx: Parameters<typeof assertTransition>[3], message: string, extra: { doneNote?: string } = {}, by: 'system' | 'human' = 'system'): boolean {
    assertTransition(t, { status: to }, by, ctx)
    const db = this.c.store.db
    const ok = db.transaction(() => {
      const cur = this.c.task(t.id)
      if (cur.status !== t.status) return false
      const next: BoardTask = { ...cur, status: to, blockReason: null, ...(to === 'done' ? { doneNote: extra.doneNote ?? cur.doneNote, pendingWake: null } : {}), updatedAt: this.now().toISOString() }
      const r = db.prepare('UPDATE company_tasks SET status=?, data=? WHERE id=? AND status=?').run(to, JSON.stringify(next), t.id, t.status)
      if (r.changes !== 1) return false
      this.c.activity(t.id, 'work', message, by)
      return true
    })()
    return ok
  }

  private depsDone(t: BoardTask): boolean {
    return t.dependencyIds.every((id) => { try { return this.c.task(id).status === 'done' } catch { return false } })
  }

  private async ghState(cwd: string, fresh = false): Promise<GhState> {
    if (!fresh && this.auth && Date.now() - this.auth.at < AUTH_TTL_MS) return this.auth.state
    const state = await ghAuth(this.d.gh, cwd).catch(() => 'error' as const)
    this.auth = { state, at: Date.now() }
    return state
  }

  private changed(companyId: string): void {
    try { this.d.onChange?.(companyId) } catch { /* the board logs its own */ }
  }
}
