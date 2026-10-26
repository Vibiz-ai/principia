/**
 * PLANS.md §2: the plan pilot. Level-triggered like the dispatcher: approve, a run end, a founder click and the 60 s tick
 * call pump(), serialized. Per running plan, milestone by milestone (in dependency order):
 *
 * - Step by Step: nothing starts by itself; ready tasks show Start (plans:start).
 * - Check-ins (default): a ready milestone gets its agent; it does the milestone's tasks one after another; when every
 *   task is in review the head agent checks the gate, then the founder passes it (Pass Milestone N) or sends it back.
 * - Autopilot: a passing gate moves on by itself; a failing one stops the plan and adds fix tasks.
 *
 * One agent, one worktree and one conversation per milestone: the worktree is the milestone task's own WORKTREE.md
 * binding (planWork.ts; no second worktree system), each task turn of a milestone runs in it (TaskWorkService.workdir
 * follows the milestone task) and resumes the milestone's agentSessionId (--resume), so the agent does not relearn the
 * repo per task; a failed turn drops the session (a dead or compacted conversation) and the next task starts fresh
 * from the briefs. Tests are sized to the task; the full suite runs on the milestone's last task, before its gate.
 *
 * Parallel awareness: a milestone agent's note lists what runs beside it and the files those tasks touch. Milestones
 * (and plans) whose touches overlap never run side by side: the later one waits.
 *
 * Plan tasks sit in Backlog with their milestone agent, so the board's dispatcher (which only picks To do) and its
 * router never take them; the pilot starts them as a human start: the founder's autonomy choice is the consent.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { BoardTask, CompanyAgent } from '../../shared/company'
import type { StartRunOptions } from '../../shared/engine'
import { HiveError } from '../../shared/errors'
import { briefOf, milestoneComplete, milestoneReady, proofOf, touchesOverlap, whoseTurn, type Milestone, type Plan, type PlanAutonomy, type PlanDetail, type PlanResultState, type PlanTask } from '../../shared/plans'
import type { TaskPr } from '../../shared/taskWork'
import type { Run, RunTarget } from '../../shared/types'
import { briefPromptBlock } from './brief'
import type { CompanyStore, TaskRunLink } from './index'
import { draftFromJson, extractJson, PlanStore, topoMilestones } from './plans'
import { draftInput, gateInput, milestoneNote, PLAN_CALL_TIMEOUT_MS, type BesideNote, type PlanCall } from './planPrompt'
import type { PlanWork } from './planWork'

const fail = (message: string): never => { throw new HiveError('bad_request', message) }
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s
export const PILOT_TICK_MS = 60_000

export interface GateVerdict { result: 'pass' | 'fail'; notes: string; evidence: string[]; fixTasks: { title: string; goal: string; criteria: string[]; touches: string[] }[] }
const verdictSchema = z.object({
  result: z.enum(['pass', 'fail']),
  notes: z.string().max(4000).default(''),
  evidence: z.array(z.string().max(600)).max(40).default([]),
  fixTasks: z.array(z.object({ title: z.string().min(1).max(200), goal: z.string().max(1000).default(''), criteria: z.array(z.string().min(1).max(400)).max(8).default([]), touches: z.array(z.string().min(1).max(300)).max(20).default([]) })).max(5).default([])
})

export interface PilotDeps {
  plans: PlanStore
  company: () => CompanyStore
  /** h.engine.runs.start */
  startRun(target: RunTarget, opts: StartRunOptions): Run
  /** experimental companies + departments + plans (PLANS.md §0) */
  enabled(): boolean
  /** git and gh over the worktree track (planWork.ts); null = no worktrees (the run uses the company workspace) */
  work?: PlanWork | null
  /** the head agent's one-shot calls; null = no Claude CLI */
  draftCall?: () => PlanCall | null
  gateCall?: () => PlanCall | null
  /** the repo's tracked files, for the draft (best effort) */
  repoFiles?: (repoPath: string) => Promise<string[]>
  onChange?(companyId: string): void
  redact?(s: string): string
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?(): Date
}

export class PlanPilot {
  private chain: Promise<void> = Promise.resolve()
  private queued: Promise<void> | null = null
  private readonly checking = new Set<string>()
  private readonly drafting = new Map<string, AbortController>()
  private readonly waiting = new Map<string, string>()
  /** per plan: why a ready milestone has not started (its agent is busy, the cap, overlapping files), by milestone id */
  private readonly milestoneWaits = new Map<string, Map<string, string>>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly d: PilotDeps) {}
  private get c(): CompanyStore { return this.d.company() }
  private get plans(): PlanStore { return this.d.plans }
  private now(): string { return (this.d.now ? this.d.now() : new Date()).toISOString() }
  private redact(s: string): string { return this.d.redact ? this.d.redact(s) : s }
  private changed(companyId: string): void { try { this.d.onChange?.(companyId) } catch { /* never fails the pilot */ } }

  start(tickMs = PILOT_TICK_MS): void {
    if (this.timer || this.disposed) return
    this.clearStaleDrafts()
    this.timer = setInterval(() => void this.pump(), tickMs)
    this.timer.unref?.()
    void this.pump()
  }
  /** A draft cut off by a quit or a crash (drafting stays true in the row): say so, so Draft Again is offered. */
  clearStaleDrafts(): void {
    try {
      for (const p of this.plans.list().filter(x => x.status === 'draft' && x.drafting && !this.drafting.has(x.id))) {
        this.plans.update(p.id, x => ({ ...x, drafting: false, draftError: 'Principia closed while the head agent was drafting' }))
      }
    } catch (err) { this.d.log?.warn('plans: clearing stale drafts failed', { error: String(err) }) }
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const a of this.drafting.values()) a.abort()
  }

  // ---------- the page ----------

  detail(id: string): PlanDetail {
    const plan = this.plans.get(id)
    const tasks = this.tasksOf(plan)
    const checking = plan.milestones.find(m => this.checking.has(`${plan.id}:${m.id}`))?.id ?? null
    const agents = this.c.departments.listAgents({ companyId: plan.companyId, includeArchived: true })
    const name = (aid: string | null) => { const a = agents.find(x => x.id === aid); return a ? (a.data.persona?.name ?? a.name) : 'The head agent' }
    const waiting = this.waiting.get(plan.id) ?? null
    let turn = whoseTurn(plan, tasks, name, checking)
    if (waiting && plan.status === 'running' && !plan.halted && !tasks.some(t => t.status === 'in_progress')) turn = { text: `Waiting: ${waiting}`, who: 'nobody', action: null }
    const waits = Object.fromEntries(plan.status === 'running' ? (this.milestoneWaits.get(plan.id) ?? []) : [])
    return { plan, tasks, checking, turn, waiting, waits }
  }
  /** The page right after a Merge… elsewhere: a done plan reads its PR from the binding first. */
  async refresh(id: string): Promise<PlanDetail> {
    const p = this.plans.get(id)
    if (p.status === 'done' && p.result) await this.followResult(p).catch((err) => this.d.log?.warn('plans: follow PR failed', { planId: id, error: String(err) }))
    return this.detail(id)
  }
  private tasksOf(p: Plan): BoardTask[] {
    const ids = [...p.milestones.map(m => m.taskId), ...p.tasks.map(t => t.taskId)].filter((x): x is string => !!x)
    return ids.map(id => { try { return this.c.task(id) } catch { return null } }).filter((x): x is BoardTask => !!x)
  }

  // ---------- drafting ----------

  /** Starts the head agent's draft in the background; the row says drafting until it lands (or fails). */
  draft(id: string): Promise<void> {
    const plan = this.plans.update(id, p => ({ ...p, drafting: true, draftError: null }))
    this.changed(plan.companyId)
    this.drafting.get(id)?.abort()
    const ac = new AbortController()
    this.drafting.set(id, ac)
    const run = (async () => {
      try {
        const call = this.d.draftCall?.() ?? null
        if (!call) fail('No Claude CLI is installed for the head agent to draft with. Install Claude Code, or write the draft by hand.')
        const prompt = await this.draftPrompt(plan)
        const answer = await call!(this.redact(prompt), { timeoutMs: PLAN_CALL_TIMEOUT_MS, signal: ac.signal })
        if (ac.signal.aborted) { if (this.disposed) fail('closed'); return }
        const agents = this.c.departments.listAgents({ companyId: plan.companyId })
        const draft = draftFromJson(extractJson(answer), agents, plan.headAgentId)
        const redactDeep = <T>(v: T): T => JSON.parse(JSON.stringify(v), (_k, x) => typeof x === 'string' ? this.redact(x) : x)
        this.plans.update(id, p => p.status !== 'draft' ? p : ({ ...p, drafting: false, draftError: null, body: this.redact(draft.body), milestones: redactDeep(draft.milestones), tasks: redactDeep(draft.tasks) }))
      } catch (err) {
        if (ac.signal.aborted && !this.disposed) return
        const msg = this.disposed ? 'Principia closed while the head agent was drafting' : err instanceof Error ? err.message : String(err)
        this.d.log?.warn('plans: draft failed', { planId: id, error: msg })
        try { this.plans.update(id, p => ({ ...p, drafting: false, draftError: clip(msg, 300) })) } catch { /* discarded meanwhile */ }
      } finally {
        if (this.drafting.get(id) === ac) this.drafting.delete(id)
        this.changed(plan.companyId)
      }
    })()
    return run
  }
  /** Drops a draft (and its running draft call). */
  discard(id: string): void {
    this.drafting.get(id)?.abort()
    this.drafting.delete(id)
    const p = this.plans.get(id)
    this.plans.remove(id)
    this.changed(p.companyId)
  }
  private async draftPrompt(p: Plan): Promise<string> {
    const company = this.c.passport(p.companyId)
    const deps = this.c.departments.list(p.companyId)
    const agents = this.c.departments.listAgents({ companyId: p.companyId }).filter(a => !a.archivedAt)
    const head = agents.find(a => a.id === p.headAgentId)
    const repo = p.repoId ? this.c.store.getRepo(p.repoId) : null
    let files: string[] = []
    if (repo && this.d.repoFiles) { try { files = await this.d.repoFiles(repo.path) } catch { files = [] } }
    return draftInput({
      goal: p.goal, company: company.name,
      departments: deps.map(d => ({ key: d.key, name: d.name, does: d.data.charter.does })),
      agents: agents.map(a => ({ name: a.data.persona?.name ?? a.name, department: deps.find(d => d.id === a.departmentId)?.name ?? null, capabilities: a.data.capabilities })),
      head: { name: head?.name ?? 'Head agent', instructions: head?.data.instructions ?? '' },
      repo: repo ? { name: repo.name, files } : null
    })
  }

  // ---------- founder actions ----------

  approve(id: string): Plan {
    if (this.drafting.has(id)) fail('The head agent is still drafting')
    const approved = this.plans.approve(id)
    const p = this.plans.update(id, x => ({ ...x, status: 'running' }))
    this.changed(approved.companyId)
    void this.pump()
    return p
  }
  /** Step by Step / Check-ins / Autopilot. A finished plan has no pace left to change. */
  setAutonomy(id: string, autonomy: PlanAutonomy): Plan {
    const p0 = this.plans.get(id)
    if (p0.status === 'done' || p0.status === 'archived') fail(`This plan is ${p0.status}: there is nothing left to run`)
    const p = this.plans.update(id, x => ({ ...x, autonomy, changes: [...x.changes, { at: this.now(), by: 'human', text: `Autonomy: ${autonomy}` }] }))
    this.changed(p.companyId)
    void this.pump()
    return p
  }
  /** Start one task now (Step by Step's Start, or any level: a human start). */
  async startNow(id: string, taskId: string): Promise<Plan> {
    const p = this.plans.get(id)
    if (p.status !== 'running') fail('Approve the plan first')
    const pt = p.tasks.find(t => t.taskId === taskId) ?? fail('That task is not part of this plan')
    const m = p.milestones.find(x => x.id === pt.milestoneId)!
    if (!milestoneReady(p, m)) fail(`${m.key} waits for the milestones before it`)
    const t = this.c.task(taskId)
    if (['in_progress', 'done', 'canceled'].includes(t.status)) fail(`${t.identifier} is ${t.status.replace('_', ' ')}`)
    await this.startTask(p, m, pt, 'human')
    return this.plans.get(id)
  }
  /**
   * Run now / Start on the Board for a task of a plan: the same start as the plan page's (milestone worktree, milestone
   * note, milestone conversation), never a run in the founder's checkout.
   */
  async startFromBoard(taskId: string): Promise<BoardTask> {
    const t = this.c.task(taskId)
    const link = t.plan ?? fail(`${t.identifier} is not part of a plan`)
    if (link.role === 'milestone') fail(`${t.identifier} holds a milestone of a plan; start one of its tasks instead`)
    const p = this.plans.get(link.planId)
    if (p.status === 'done' || p.status === 'archived') fail(`The plan of ${t.identifier} is ${p.status}. Create a new task for more work.`)
    await this.startNow(p.id, taskId)
    return this.c.task(taskId)
  }
  /** Pause: nothing new starts (a running turn finishes); Resume goes on. Read right before every pilot start. */
  pause(id: string): Plan {
    const p0 = this.plans.get(id)
    if (p0.status !== 'running') fail('Only a running plan can be paused')
    if (p0.pausedAt) return p0
    const at = this.now()
    const p = this.plans.update(id, x => ({ ...x, pausedAt: at, changes: [...x.changes, { at, by: 'human', text: 'Paused' }] }))
    this.changed(p.companyId)
    return p
  }
  /** The pilot may start a task of this plan right now (running, not paused, not stopped): read live, from the row. */
  private mayStart(planId: string): boolean {
    try { const p = this.plans.get(planId); return p.status === 'running' && !p.pausedAt && !p.halted } catch { return false }
  }
  /**
   * Archive: out of the list. An unfinished plan is abandoned: its open tasks are canceled, and so are the ones In
   * review (they would sit in Needs you for a plan nobody runs any more); each says so in its activity. Refused while
   * one of its tasks is in progress (stop that run first), and for a draft (Discard it). A done plan's tasks are done
   * already, except when its PR was not merged: then what still waits in review (Autopilot leaves it there until the
   * merge) is released the same way. Its PR, if open, stays open on GitHub.
   */
  archive(id: string): Plan {
    const p = this.plans.get(id)
    if (p.status === 'draft') fail('Discard a draft instead')
    if (p.status === 'archived') return p
    const rows = this.tasksOf(p)
    const live = rows.filter(t => t.status === 'in_progress')
    if (live.length) fail(`${live.map(t => t.identifier).join(', ')} ${live.length === 1 ? 'is' : 'are'} in progress. Stop ${live.length === 1 ? 'that run' : 'those runs'} first, then archive.`)
    let canceled = 0, released = 0
    // a done plan whose PR was never merged still has Autopilot's passed tasks in review: they leave Needs you too
    const unmerged = p.status === 'done' && !p.result?.mergedAt
    if (p.status !== 'done' || unmerged) {
      for (const t of rows) {
        if (!(unmerged ? ['in_review'] : ['triage', 'backlog', 'todo', 'blocked', 'in_review']).includes(t.status)) continue
        try {
          this.c.cancel(t.id)
          this.c.activity(t.id, 'updated', `Its plan was archived ("${clip(p.goal, 80)}")${unmerged ? ' without merging its pull request' : ''}${t.status === 'in_review' ? ': no longer waiting for your review' : ''}`, 'human')
          if (t.status === 'in_review') released++
          else canceled++
        } catch (err) { this.d.log?.warn('plans: cancel on archive failed', { taskId: t.id, error: String(err) }) }
      }
    }
    const at = this.now()
    const parts = [canceled ? `${canceled} open task${canceled === 1 ? '' : 's'} canceled` : '', released ? `${released} in review released from Needs you` : ''].filter(Boolean)
    const out = this.plans.update(id, x => ({ ...x, status: 'archived', archivedAt: at, halted: null, pausedAt: null, changes: [...x.changes, { at, by: 'human', text: parts.length ? `Archived; ${parts.join(', ')}` : 'Archived' }] }))
    this.changed(p.companyId)
    return out
  }
  /**
   * Open a PR (PLANS.md §2.6): push the plan's branch (hive/* only, the worktree's guarded push) and open the pull
   * request with gh. Never a merge: Merge… on the PR is the founder's (the worktree track, after a native confirm).
   * Also the retry when gh was missing or signed out.
   */
  async publish(id: string): Promise<Plan> {
    const p = this.plans.get(id)
    if (p.status !== 'done') fail('A plan opens its pull request once every milestone has passed')
    if (!p.result?.branch || !p.result.taskId) { await this.collectResult(p, true); return this.plans.get(id) }
    if (p.result.mergedAt) return p
    if (p.result.pr?.state === 'OPEN') return p
    await this.publishResult(p)
    return this.plans.get(id)
  }
  /** The milestones nothing depends on: together they hold the plan's work. */
  private leaves(p: Plan): Milestone[] { return p.milestones.filter(m => !p.milestones.some(o => o.dependsOn.includes(m.id))) }
  /** The branch the plan started from (its first milestone's base, origin/ dropped): the PR's base. */
  private baseOf(p: Plan): string | null {
    for (const m of topoMilestones(p.milestones)) {
      if (m.dependsOn.length || !m.taskId) continue
      try { const ref = this.c.task(m.taskId).work?.baseRef; if (ref && ref !== 'HEAD') return ref.replace(/^origin\//, '') } catch { /* gone */ }
    }
    return null
  }
  /**
   * A done plan with a repository: its work on one branch (the first leaf's, the other leaves merged into its worktree),
   * then the PR. Once; a failure is shown and Open a PR tries again (`force`).
   */
  private async collectResult(p: Plan, force = false): Promise<void> {
    if (p.status !== 'done' || (p.result && !force) || !p.repoId || !this.d.work) return
    const leaves = this.leaves(p).map(m => m.taskId).filter((x): x is string => !!x)
    let result: PlanResultState
    try {
      const r = await this.d.work.collect(leaves, `plan ${clip(p.goal, 60)}`)
      result = { branch: r.branch, taskId: r.taskId, baseBranch: this.baseOf(p), pushed: false, pr: null, gh: null, mergedAt: null, error: null }
    } catch (err) {
      result = { branch: null, taskId: null, baseBranch: this.baseOf(p), pushed: false, pr: null, gh: null, mergedAt: null, error: clip(err instanceof Error ? err.message : String(err), 300) }
    }
    const out = this.plans.update(p.id, x => ({ ...x, result, changes: [...x.changes, { at: this.now(), by: 'system', text: result.branch ? `The work is on ${result.branch}` : `Could not put the work on one branch: ${result.error}` }] }))
    this.changed(p.companyId)
    if (result.branch) await this.publishResult(out)
  }
  private async publishResult(p: Plan): Promise<void> {
    const r = p.result
    if (!r?.branch || !r.taskId || !this.d.work) return
    const base = r.baseBranch ?? 'main'
    const title = clip(`Plan: ${p.goal.split('\n')[0]}`, 120)
    const body = this.redact([
      `${p.body || p.goal}`.trim(),
      '',
      ...p.milestones.map(m => `- ${m.key} · ${m.title}${m.gate.notes ? `: ${clip(m.gate.notes.replace(/\s+/g, ' '), 200)}` : ''}`),
      '',
      'Opened by Principia when every milestone of the plan passed. Merging is yours.'
    ].join('\n'))
    let out: Awaited<ReturnType<PlanWork['publish']>>
    try { out = await this.d.work.publish(r.taskId, { base, title, body }) } catch (err) { out = { pushed: r.pushed, pr: null, gh: r.gh, error: clip(err instanceof Error ? err.message : String(err), 300) } }
    const text = out.pr ? `Opened PR #${out.pr.number} for ${r.branch} into ${base}` : out.error ? `Could not open the PR: ${out.error}` : out.gh && out.gh !== 'ok' ? `Pushed ${r.branch}; ${out.gh === 'missing' ? 'the GitHub CLI is not installed' : 'the GitHub CLI is not signed in'}, so open the PR yourself` : `Pushed ${r.branch}`
    this.plans.update(p.id, x => ({ ...x, result: { ...x.result!, pushed: out.pushed || x.result!.pushed, pr: out.pr ?? x.result!.pr, gh: out.gh, error: out.error }, changes: [...x.changes, { at: this.now(), by: 'system', text }] }))
    this.changed(p.companyId)
  }
  /**
   * The PR as the worktree track follows it (the result task's `work.pr`): kept in step on the plan, and once it is
   * merged (on GitHub, or Merge…) the plan says so and the milestone worktrees go when nothing would be lost.
   */
  private async followResult(p: Plan): Promise<void> {
    const r = p.result
    if (!r?.taskId || r.mergedAt) return
    let pr: TaskPr | null = null
    try { pr = this.c.task(r.taskId).work?.pr ?? null } catch { return }
    if (!pr) return
    const same = r.pr && r.pr.number === pr.number && r.pr.state === pr.state && r.pr.isDraft === pr.isDraft && r.pr.reviewDecision === pr.reviewDecision
    if (same && pr.state !== 'MERGED') return
    const at = this.now()
    const merged = pr.state === 'MERGED'
    this.plans.update(p.id, x => ({ ...x, result: { ...x.result!, pr, ...(merged ? { mergedAt: pr!.mergedAt ?? at } : {}) }, changes: merged ? [...x.changes, { at, by: 'human', text: `Merged PR #${pr!.number} into ${r.baseBranch ?? 'the base branch'}` }] : x.changes }))
    if (merged) {
      // the founder merged the plan's PR: that is their approval of what still waits in review (Autopilot leaves its
      // tasks there), so they leave Needs you as done, tasks before the milestone task that holds them
      const note = this.redact(`Merged #${pr.number}`)
      for (const t of topoRows(this.tasksOf(p)).sort((a, b) => Number(a.plan?.role === 'milestone') - Number(b.plan?.role === 'milestone'))) {
        try { if (this.c.task(t.id).status === 'in_review') this.c.approve(t.id, note, 'human') } catch (err) { this.d.log?.warn('plans: approve on merge failed', { taskId: t.id, error: String(err) }) }
      }
      for (const m of p.milestones) if (m.taskId) await this.d.work?.cleanup?.(m.taskId).catch(() => undefined)
    }
    this.changed(p.companyId)
  }
  /** Pass Milestone N: the founder approves its tasks in review (and the milestone task) with one note. */
  pass(id: string, milestoneId: string, note?: string): Plan {
    const p = this.plans.get(id)
    const m = p.milestones.find(x => x.id === milestoneId) ?? fail('No such milestone')
    // passing anyway skips the fix tasks nobody started yet
    for (const pt of p.tasks.filter(t => t.milestoneId === m.id && t.fix && t.taskId)) {
      const t = this.c.task(pt.taskId!)
      if (t.status === 'backlog' || t.status === 'todo') this.c.cancel(t.id)
    }
    const rows = this.milestoneRows(p, m)
    const open = rows.filter(t => !['in_review', 'done', 'canceled'].includes(t.status))
    if (open.length) fail(`${open.map(t => t.identifier).join(', ')} ${open.length === 1 ? 'is' : 'are'} not ready for review yet`)
    // passing over a failed check says so: the gate notes alone read as if the check had passed
    const overrode = m.gate.result === 'fail'
    const text = (note?.trim() || `${overrode ? `Passed by you over a failed check (${m.key})` : `Passed with ${m.key}`}${m.gate.notes ? `: ${clip(m.gate.notes, 300)}` : ''}`)
    const doneNote = this.redact(text)
    for (const t of topoRows(rows)) if (this.c.task(t.id).status === 'in_review') this.c.approve(t.id, doneNote, 'human')
    if (m.taskId) {
      const mt = this.c.task(m.taskId)
      if (mt.status === 'backlog' || mt.status === 'todo') this.toReview(mt)
      if (this.c.task(m.taskId).status === 'in_review') this.c.approve(m.taskId, doneNote, 'human')
    }
    const at = this.now()
    const out = this.plans.update(id, x => {
      const ms = x.milestones.map(y => y.id !== m.id ? y : { ...y, passedAt: at, gate: { ...y.gate, result: 'pass' as const, notes: y.gate.result === 'pass' ? y.gate.notes : `Passed by you${note?.trim() ? `: ${clip(doneNote, 300)}` : ''}`, at: y.gate.at ?? at } })
      const next: Plan = { ...x, milestones: ms, halted: x.halted?.milestoneId === m.id ? null : x.halted, changes: [...x.changes, { at, by: 'human', text: `Passed ${m.key}` }] }
      return { ...next, status: next.milestones.every(y => milestoneComplete(next, y)) ? 'done' : next.status }
    })
    this.changed(p.companyId)
    void this.pump()
    return out
  }
  /** Send Back: one fix task with the founder's note under the milestone; its gate is checked again after it. */
  sendBack(id: string, milestoneId: string, note: string): Plan {
    const text = this.redact(note.trim())
    if (!text) fail('Say what to change')
    const p = this.plans.get(id)
    const m = p.milestones.find(x => x.id === milestoneId) ?? fail('No such milestone')
    const out = this.addFixTasks(p, m, [{ title: clip(`Fix ${m.key}: ${text}`, 200), goal: text, criteria: [], touches: [] }], 'human', `Sent back ${m.key}: ${clip(text, 300)}`)
    void this.pump()
    return out
  }
  /** Clears a pause or a stop (failed gate, failed start) and lets the pilot continue. */
  resume(id: string): Plan {
    const p0 = this.plans.get(id)
    if (p0.status !== 'running') fail(`This plan is ${p0.status}`)
    const p = this.plans.update(id, x => ({ ...x, halted: null, pausedAt: null, milestones: x.milestones.map(m => m.gate.result === 'fail' ? { ...m, gate: { ...m.gate, result: null } } : m), changes: [...x.changes, { at: this.now(), by: 'human', text: 'Resumed' }] }))
    this.changed(p.companyId)
    void this.pump()
    return p
  }

  // ---------- run ends ----------

  /** runHooks, after the board synced the run: capture the milestone session, then pump. */
  onRunUpdated(run: Run): void {
    if (!['passed', 'failed', 'canceled'].includes(run.status)) return
    const taskId = (() => { try { return (this.c.store.db.prepare('SELECT task_id FROM runs WHERE id=?').get(run.id) as { task_id: string | null } | undefined)?.task_id ?? null } catch { return null } })()
    if (!taskId) return
    let t: BoardTask
    try { t = this.c.task(taskId) } catch { return }
    if (!t.plan || t.plan.role !== 'task') return
    try {
      this.plans.update(t.plan.planId, p => ({
        ...p,
        milestones: p.milestones.map(m => {
          if (m.id !== t.plan!.milestoneId) return m
          // a failed turn may be a dead or compacted conversation: the next task starts fresh from the briefs
          if (run.status === 'failed') return { ...m, sessionId: null }
          return t.agentSessionId ? { ...m, sessionId: t.agentSessionId } : m
        })
      }))
    } catch (err) { this.d.log?.warn('plans: session capture failed', { taskId, error: String(err) }) }
    this.changed(t.companyId)
    void this.pump()
  }

  // ---------- the pump ----------

  pump(): Promise<void> {
    if (this.disposed || !this.d.enabled()) return Promise.resolve()
    if (this.queued) return this.queued
    const next = this.chain.catch(() => undefined).then(async () => {
      this.queued = null
      try { await this.pumpNow() } catch (err) { this.d.log?.warn('plans: pump failed', { error: String(err) }) }
    })
    this.queued = next
    this.chain = next
    return next
  }
  private async pumpNow(): Promise<void> {
    if (this.disposed || !this.d.enabled()) return
    for (const p of this.plans.list().filter(x => x.status === 'done' && x.repoId)) {
      try {
        if (!p.result) await this.collectResult(p)
        else await this.followResult(p)
      } catch (err) { this.d.log?.warn('plans: result failed', { planId: p.id, error: String(err) }) }
    }
    const running = this.plans.list().filter(p => p.status === 'running').sort((a, b) => (a.approvedAt ?? '').localeCompare(b.approvedAt ?? ''))
    for (const p0 of running) {
      let p = this.plans.get(p0.id)
      this.waiting.delete(p.id)
      const waits = new Map<string, string>()
      this.milestoneWaits.set(p.id, waits)
      // plans whose touches overlap run one after the other: the earlier approved one goes first
      const blocker = running.find(o => o.id !== p.id && (o.approvedAt ?? '') < (p.approvedAt ?? '') && this.plans.get(o.id).status === 'running' && o.companyId === p.companyId && touchesOverlap(allTouches(o), allTouches(p)))
      if (blocker) { this.waiting.set(p.id, `another plan edits the same files ("${clip(blocker.goal, 80)}"). This one starts when it is done.`); continue }
      if (p.halted) continue
      for (const m of topoMilestones(p.milestones)) {
        p = this.plans.get(p.id)
        if (p.halted || p.status !== 'running') break
        // paused: no new start, but a milestone whose tasks are all in review still gets its check
        const paused = !!p.pausedAt
        const cur = p.milestones.find(x => x.id === m.id)!
        if (milestoneComplete(p, cur) || !milestoneReady(p, cur)) continue
        const rows = this.milestoneRows(p, cur)
        const live = rows.some(t => t.status === 'in_progress')
        const settled = rows.length > 0 && rows.every(t => ['in_review', 'done', 'canceled'].includes(t.status))
        if (settled) {
          if (cur.gate.result === null && !this.checking.has(`${p.id}:${cur.id}`)) await this.checkGate(p.id, cur.id)
          continue
        }
        if (live || paused || p.autonomy === 'step') continue
        // a parked task waits for the founder (Needs you); the milestone does not skip past it
        if (rows.some(t => t.status === 'blocked')) continue
        const next = this.nextTask(p, cur)
        if (!next) continue
        const beside = this.inFlightBeside(p, cur)
        const overlap = beside.find(b => touchesOverlap(b.touches, milestoneTouches(p, cur)))
        if (overlap) { waits.set(cur.id, `waits: ${overlap.label} edits the same files (${overlap.identifier})`); continue }
        // the company's Tasks in flight cap holds for plans too (QA: M1 and M2 ran beside a capped Board start)
        const cap = this.atCap(p.companyId)
        if (cap) { this.waiting.set(p.id, cap); waits.set(cur.id, 'waits for a free seat (Tasks in flight)'); continue }
        try { await this.startTask(p, cur, next, 'pilot') } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // a busy seat is a wait, not a stop (the same agent finishes its other milestone first); the plan says why
          if (/is busy on/.test(msg)) { waits.set(cur.id, `waits: ${msg}`); continue }
          this.halt(p.id, cur.id, `${cur.key} could not start: ${clip(msg, 200)}`)
        }
      }
      const after = this.plans.get(p.id)
      if (after.status === 'running' && after.milestones.length && after.milestones.every(m => milestoneComplete(after, m))) {
        const done = this.plans.update(p.id, x => ({ ...x, status: 'done', changes: [...x.changes, { at: this.now(), by: 'system', text: 'Every milestone passed' }] }))
        this.changed(p.companyId)
        try { await this.collectResult(done) } catch (err) { this.d.log?.warn('plans: result failed', { planId: p.id, error: String(err) }) }
      }
    }
  }
  /** The wait line when the company already has maxInFlight tasks in progress, else null. */
  private atCap(companyId: string): string | null {
    const max = this.c.boardSettings(companyId).maxInFlight
    const n = (this.c.store.db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND status='in_progress'").get(companyId) as { n: number }).n
    return n >= max ? `${n} ${n === 1 ? 'task is' : 'tasks are'} already running (the limit is ${max}). The next one starts when a seat frees up.` : null
  }
  private milestoneRows(p: Plan, m: Milestone): BoardTask[] {
    return p.tasks.filter(t => t.milestoneId === m.id && t.taskId).map(t => { try { return this.c.task(t.taskId!) } catch { return null } }).filter((x): x is BoardTask => !!x)
  }
  /** The milestone's next task whose blockers are met (in review or done), in plan order. */
  private nextTask(p: Plan, m: Milestone): PlanTask | null {
    for (const pt of p.tasks.filter(t => t.milestoneId === m.id && t.taskId)) {
      const t = this.c.task(pt.taskId!)
      if (t.status !== 'backlog' && t.status !== 'todo') continue
      const met = pt.blockers.every(b => { const x = p.tasks.find(y => y.id === b); if (!x?.taskId) return true; const s = this.c.task(x.taskId).status; return s === 'in_review' || s === 'done' })
      if (met) return pt
    }
    return null
  }
  /** Other milestones (this plan and the company's other running plans) with a task in flight now. */
  private inFlightBeside(p: Plan, m: Milestone): (BesideNote & { milestoneId: string })[] {
    const out: (BesideNote & { milestoneId: string })[] = []
    const agents = this.c.departments.listAgents({ companyId: p.companyId, includeArchived: true })
    const name = (id: string | null) => { const a = agents.find(x => x.id === id); return a ? (a.data.persona?.name ?? a.name) : 'an agent' }
    for (const plan of this.plans.list(p.companyId).filter(x => x.status === 'running')) {
      for (const om of plan.milestones) {
        if (plan.id === p.id && om.id === m.id) continue
        for (const pt of plan.tasks.filter(t => t.milestoneId === om.id && t.taskId)) {
          let t: BoardTask
          try { t = this.c.task(pt.taskId!) } catch { continue }
          if (t.status !== 'in_progress') continue
          out.push({ milestoneId: om.id, label: `${plan.id === p.id ? '' : 'Another plan\'s '}${om.key} agent (${name(t.agentId)})`, identifier: t.identifier, touches: pt.touches })
        }
      }
    }
    return out
  }
  /** Ready milestones of this plan that may run beside m (no dependency between them), for the note. */
  private parallelReady(p: Plan, m: Milestone): (BesideNote & { milestoneId: string })[] {
    const agents = this.c.departments.listAgents({ companyId: p.companyId, includeArchived: true })
    const name = (id: string | null) => { const a = agents.find(x => x.id === id); return a ? (a.data.persona?.name ?? a.name) : 'an agent' }
    return p.milestones.filter(o => o.id !== m.id && !milestoneComplete(p, o) && milestoneReady(p, o) && !o.dependsOn.includes(m.id) && !m.dependsOn.includes(o.id))
      .map(o => ({ milestoneId: o.id, label: `${o.key} agent (${name(o.agentId)})`, identifier: null, touches: milestoneTouches(p, o) }))
  }

  /**
   * One task turn of a milestone: the worktree (created on first use), the milestone note in the wake, the milestone's
   * conversation to resume, then a human-equivalent start (the founder's autonomy choice is the consent).
   */
  private async startTask(p: Plan, m: Milestone, pt: PlanTask, by: 'human' | 'pilot'): Promise<void> {
    const c = this.c
    const t = c.task(pt.taskId!)
    const agent = (t.agentId ? c.departments.getAgent(t.agentId) : null) ?? fail(`${t.identifier} has no agent`)
    if (agent.pausedAt && by === 'pilot') fail(`${agent.name} is paused`)
    const busy = c.store.db.prepare("SELECT data FROM company_tasks WHERE agent_id=? AND status='in_progress' AND id<>? LIMIT 1").get(agent.id, t.id) as { data: string } | undefined
    if (busy) fail(`${agent.data.persona?.name ?? agent.name} is busy on ${JSON.parse(busy.data).identifier}`)
    // Pause is read live: right before the (slow) worktree work and again right before the start
    if (by === 'pilot' && !this.mayStart(p.id)) return
    let wt = m.worktree
    const repo = p.repoId ? c.store.getRepo(p.repoId) : null
    if (repo && this.d.work && m.taskId) {
      // the milestone task's own worktree (WORKTREE.md binding). A milestone that depends on others starts from all of
      // their work: their leftovers are committed, the first one's branch is the start point and the others are merged
      // in, in the new worktree only (a conflict takes it away again and stops the plan with the files)
      const from = m.dependsOn.map(id => p.milestones.find(x => x.id === id)?.taskId).filter((x): x is string => !!x)
      const tree = await this.d.work.ensure(m.taskId, from, m.key)
      if (tree && (wt?.path !== tree.path || wt?.branch !== tree.branch)) this.plans.update(p.id, x => ({ ...x, milestones: x.milestones.map(y => y.id === m.id ? { ...y, worktree: tree } : y) }))
      wt = tree
    }
    if (by === 'pilot' && !this.mayStart(p.id)) return
    if (by === 'pilot' && this.atCap(p.companyId)) return
    const fresh = this.plans.get(p.id)
    const cur = fresh.milestones.find(x => x.id === m.id)!
    const own = fresh.tasks.filter(x => x.milestoneId === m.id)
    const index = own.findIndex(x => x.id === pt.id) + 1
    const remaining = own.filter(x => x.id !== pt.id && x.taskId && ['backlog', 'todo'].includes(c.task(x.taskId).status)).length
    const resume = !!cur.sessionId && agent.kind === 'profile' && t.assigneeProfileId === agent.refId
    const live = this.inFlightBeside(fresh, cur)
    const beside = [...live, ...this.parallelReady(fresh, cur).filter(b => !live.some(l => l.milestoneId === b.milestoneId))]
    const note = milestoneNote({
      plan: fresh, milestone: cur, task: { identifier: t.identifier, title: t.title, touches: pt.touches }, index, total: own.length,
      resumed: resume, brief: resume ? briefPromptBlock(t) : null, beside, cwd: wt?.path ?? null, branch: wt?.branch ?? null, last: remaining === 0
    })
    // the milestone note first, then whatever woke it (an answer, a comment)
    const earlier = (t.pendingWake?.reasons ?? []).filter(r => !r.startsWith('Plan ')).slice(-4)
    c.patchInFlight(t.id, { agentSessionId: resume ? cur.sessionId : null, pendingWake: { reasons: [note, ...earlier], count: 1 + earlier.length } })
    c.activity(t.id, 'woke', by === 'human' ? `You started it from the plan (${cur.key})` : `The plan pilot started ${agent.name} on it (${cur.key}, ${fresh.autonomy === 'autopilot' ? 'Autopilot' : 'Check-ins'})${resume ? ', resuming the milestone conversation' : ''}`, by === 'human' ? 'human' : 'system')
    // the run's cwd and push guard come from TaskWorkService.workdir (the milestone task's worktree), like any task turn
    c.startTask(t.id, undefined, (target: RunTarget, companyId: string, link: TaskRunLink): Run => this.d.startRun(
      target,
      { trigger: 'task', companyId, taskId: link.taskId, agentId: link.agentId, resumeSessionId: link.resumeSessionId, title: link.title ?? null, runMinutes: agent.data.limits?.runMinutes ?? null }
    ), { actor: 'human', plan: true })
    this.changed(p.companyId)
  }

  // ---------- the gate ----------

  /** The head agent checks a milestone whose tasks are all in review: pass or fail, with notes and evidence. */
  async checkGate(planId: string, milestoneId: string): Promise<void> {
    const key = `${planId}:${milestoneId}`
    if (this.checking.has(key)) return
    this.checking.add(key)
    const p = this.plans.get(planId)
    this.changed(p.companyId)
    try {
      const m = p.milestones.find(x => x.id === milestoneId)!
      const rows = this.milestoneRows(p, m)
      const diff = this.d.work && m.taskId ? await this.d.work.diff(m.taskId).catch(() => '') : ''
      // the gate has no tools: the commits and the working-tree status go in the prompt (QA: 'Change is committed')
      const git = this.d.work?.gitState && m.taskId ? await this.d.work.gitState(m.taskId).catch(() => null) : null
      const call = this.d.gateCall?.() ?? null
      let v: GateVerdict
      if (!call) v = { result: 'fail', notes: 'No Claude CLI is installed for the head agent to check this milestone. Pass it yourself after a look.', evidence: [], fixTasks: [] }
      else {
        const prompt = gateInput({ plan: p, milestone: m, tasks: rows.map(t => ({ identifier: t.identifier, title: t.title, status: t.status, brief: briefOf(t), proof: proofOf(t), reportSummary: t.report?.summary ?? null })), diff, git })
        try {
          const raw = await call(this.redact(prompt), { timeoutMs: PLAN_CALL_TIMEOUT_MS })
          v = verdictSchema.parse(extractJson(raw))
        } catch (err) {
          v = { result: 'fail', notes: `The check did not finish: ${clip(err instanceof Error ? err.message : String(err), 200)}`, evidence: [], fixTasks: [] }
        }
      }
      // a pass must cite evidence (PLANS.md risk 3): no rubber stamps
      if (v.result === 'pass' && !v.evidence.length) v = { ...v, result: 'fail', notes: `${v.notes} The check cited no evidence (proof or test output), so it is recorded as a fail.`.trim() }
      this.recordGate(planId, milestoneId, v)
    } finally {
      this.checking.delete(key)
      this.changed(p.companyId)
    }
  }
  /** Writes the verdict; a fail adds fix tasks under the milestone and stops the plan (every level: it waits for you). */
  recordGate(planId: string, milestoneId: string, v: GateVerdict): Plan {
    const at = this.now()
    const notes = clip(this.redact(v.notes), 2000)
    let p = this.plans.update(planId, x => ({
      ...x,
      milestones: x.milestones.map(m => m.id !== milestoneId ? m : { ...m, gate: { result: v.result, notes, at, evidence: v.evidence.map(e => clip(this.redact(e), 600)), fails: m.gate.fails + (v.result === 'fail' ? 1 : 0) } }),
      changes: [...x.changes, { at, by: 'system', text: `${x.milestones.find(m => m.id === milestoneId)?.key} gate: ${v.result}${notes ? ` (${clip(notes, 200)})` : ''}` }]
    }))
    const m = p.milestones.find(x => x.id === milestoneId)!
    if (m.taskId) {
      const mt = this.c.task(m.taskId)
      if (mt.status === 'backlog' || mt.status === 'todo') this.toReview(mt)
      this.c.activity(m.taskId, 'report', `Gate ${v.result === 'pass' ? 'passed' : 'failed'}: ${clip(notes, 600)}${v.evidence.length ? ` · evidence: ${v.evidence.slice(0, 6).join(', ')}` : ''}`, 'agent')
    }
    if (v.result === 'fail') {
      const fixes = v.fixTasks.length ? v.fixTasks : [{ title: `Fix ${m.key}: ${clip(notes || 'the gate check failed', 150)}`, goal: notes || 'Make the milestone pass its criteria.', criteria: m.passCriteria, touches: [] }]
      p = this.addFixTasks(p, m, fixes, 'system', `${m.key} failed its check: ${clip(notes, 300)}`)
      p = this.halt(planId, milestoneId, stopLine(m.key, notes, v.fixTasks[0]?.title))
    } else if (p.autonomy === 'autopilot') {
      p = this.plans.update(planId, x => ({ ...x, status: x.milestones.every(y => milestoneComplete(x, y)) ? 'done' : x.status }))
    }
    this.changed(p.companyId)
    void this.pump()
    return p
  }
  private addFixTasks(p: Plan, m: Milestone, fixes: GateVerdict['fixTasks'], by: 'human' | 'system', why: string): Plan {
    const at = this.now()
    const agentId = m.agentId ?? p.headAgentId
    const agent: CompanyAgent = (agentId ? this.c.departments.getAgent(agentId) : null) ?? fail(`${m.key} has no agent`)
    return this.c.store.db.transaction(() => {
      const cur = this.plans.get(p.id)
      const tasks = cur.tasks.map(t => ({ ...t }))
      const mm = cur.milestones.find(x => x.id === m.id)!
      // the fix comes after the milestone's tasks: it waits for nothing but them (they are all in review already)
      const added: PlanTask[] = fixes.slice(0, 5).map(f => ({ id: `pt_${randomBytes(8).toString('hex')}`, milestoneId: m.id, title: clip(this.redact(f.title), 200), briefSeed: { goal: this.redact(f.goal || f.title), context: why, criteria: f.criteria.map(s => this.redact(s)) }, blockers: [], touches: f.touches, taskId: null, fix: true }))
      for (const t of added) { tasks.push(t); this.plans.createPlanTask(cur, mm, t, tasks, agent, at) }
      return this.plans.save({ ...cur, tasks, milestones: cur.milestones.map(x => x.id === m.id ? { ...x, passedAt: null, gate: { ...x.gate, result: by === 'human' ? null : x.gate.result } } : x),
        changes: [...cur.changes, { at, by, text: `${why}. Added ${added.length} fix task${added.length === 1 ? '' : 's'}: ${added.map(t => t.title).join('; ')}` }] })
    })()
  }
  private halt(planId: string, milestoneId: string | null, reason: string): Plan {
    const p = this.plans.update(planId, x => ({ ...x, halted: { reason: clip(reason, 400), at: this.now(), milestoneId } }))
    this.changed(p.companyId)
    return p
  }
  /** The milestone task waits for the founder's pass: Backlog → In review (no run holds it; compare-and-set). */
  private toReview(t: BoardTask): void {
    this.c.store.db.prepare("UPDATE company_tasks SET status='in_review', data=json_set(data,'$.status','in_review','$.blockReason',json('null'),'$.updatedAt',?) WHERE id=? AND status IN ('backlog','todo')").run(this.now(), t.id)
  }
}

/**
 * The top line after a failed gate: one short sentence (the full notes are under Gates). The first clause of the notes,
 * cut at a word under ~70 characters.
 */
export function stopLine(key: string, notes: string, fixTitle?: string): string {
  // notes often walk every criterion ("the first criterion holds. The second does not…"): quote the part that failed
  const sentences = notes.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean)
  const fix = fixTitle?.replace(/^Fix\s+M\d+:\s*/i, '')
  const failing = sentences.find(x => FAILING.test(x)) ?? (sentences.length > 1 && fix ? fix : sentences[0]) ?? ''
  let why = (failing.split(/(?<=[;:])\s|\s[(—–-]\s?/)[0] ?? '').replace(/[.!?;:,]+$/, '').trim()
  if (why.length > 70) { why = why.slice(0, 70); why = why.slice(0, Math.max(why.lastIndexOf(' '), 40)).replace(/[,;:]+$/, '') + '…' }
  return why ? `${key} failed its check: ${why[0].toLowerCase()}${why.slice(1)}.` : `${key} failed its check.`
}
const FAILING = /\b(not|no|never|none|fails?|failed|failing|missing|lacks?|lacking|broken|errors?|cannot|can't|doesn't|isn't|aren't|wasn't|won't|wrong|without|absent|unmet)\b/i
function milestoneTouches(p: Plan, m: Milestone): string[] { return [...new Set(p.tasks.filter(t => t.milestoneId === m.id).flatMap(t => t.touches))] }
function allTouches(p: Plan): string[] { return [...new Set(p.tasks.flatMap(t => t.touches))] }
/** Rows in an order where a dependency comes before the task that waits for it. */
function topoRows(rows: BoardTask[]): BoardTask[] {
  const out: BoardTask[] = []; const seen = new Set<string>()
  const visit = (t: BoardTask) => { if (seen.has(t.id)) return; seen.add(t.id); for (const d of t.dependencyIds) { const x = rows.find(y => y.id === d); if (x) visit(x) } out.push(t) }
  rows.forEach(visit)
  return out
}
