/**
 * PLANS.md §3: the brief and Plans channels, and the run-end hooks (handoff fill, plan pilot). The brief channels and
 * the system handoff are gated on the board (experimental companies + departments); plans:* and the pilot also need
 * experimental.plans (PLANS.md §0). Ids are checked against the stored rows, never a company the renderer names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { departmentsEnabled } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import { briefOf, plansEnabled, PLANS_OFF, proofOf, type BriefOp, type BriefView } from '../../shared/plans'
import { assertDepartmentsEnabled } from '../company/departments'
import { answerQuestion, BriefStore, decide, editSection, isImageRef, removeCriterion, setCriterion } from '../company/brief'
import { PlanStore } from '../company/plans'
import { PlanPilot } from '../company/planPilot'
import { setPlanBoardStarter } from '../company/planBoard'
import { DRAFT_MODEL, GATE_MODEL, planModelCall } from '../company/planPrompt'
import { taskPlanWork } from '../company/planWork'
import { gitRunner } from '../worktrees'
import { baseChildEnv } from '../loginEnv'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { log } from '../log'

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

export interface PlansWiring { plans: PlanStore; pilot: PlanPilot; briefs: BriefStore }

export function registerPlansHandlers(h: Hive): PlansWiring {
  // briefs are part of every board task (the board's two flags); Plans need their own flag too (PLANS.md §0)
  const gate = () => assertDepartmentsEnabled(h.settings().experimental)
  const boardOn = () => departmentsEnabled(h.settings().experimental)
  const enabled = () => plansEnabled(h.settings().experimental)
  const planGate = () => { gate(); if (!enabled()) throw new HiveError('not_implemented', PLANS_OFF) }
  const redact = (s: string) => h.vault.redact(s)
  const changed = () => { emit('data:changed', { domain: 'tasks' }); h.safe(() => h.statusChanged(), undefined) }
  const git = gitRunner(() => baseChildEnv())
  const plans = new PlanStore({ company: () => h.company, redact })
  const briefs = new BriefStore(() => h.company)
  const work = h.taskWork
  const pilot = new PlanPilot({
    plans,
    company: () => h.company,
    startRun: (target, opts) => h.engine.runs.start(target, opts),
    enabled,
    // milestone worktrees are the worktree track's bindings (one owner, one sweep rule): no worktree system here
    work: work ? taskPlanWork({ company: () => h.company, work: () => work, git, gh: work.ghRunner }) : null,
    draftCall: () => h.safe(() => planModelCall({ providers: () => h.engine.providers.cached(), model: DRAFT_MODEL }), null),
    gateCall: () => h.safe(() => planModelCall({ providers: () => h.engine.providers.cached(), model: GATE_MODEL }), null),
    repoFiles: async (repoPath) => {
      const r = await git(['ls-files'], { cwd: repoPath, timeoutMs: 10_000 })
      return r.code === 0 ? r.stdout.split('\n').filter(Boolean).slice(0, 400) : []
    },
    onChange: changed,
    redact,
    log
  })

  // ---------- run end: the handoff from the report (any board task), then the pilot ----------
  h.runHooks.push((run) => {
    if (!['passed', 'failed', 'canceled'].includes(run.status)) return
    // after the board's own run-end hooks (syncRun, session capture) have written the task
    setImmediate(() => {
      if (!boardOn()) return
      // the quiet system handoff: any board task, Plans on or off (briefs are always on)
      try {
        const row = h.db.prepare('SELECT task_id FROM runs WHERE id=?').get(run.id) as { task_id: string | null } | undefined
        if (row?.task_id && briefs.fillHandoff(row.task_id, run.startedAt ?? run.createdAt)) changed()
      } catch (err) { log.warn('plans: handoff fill failed', { runId: run.id, error: String(err) }) }
      if (!enabled()) return
      try { pilot.onRunUpdated(run) } catch (err) { log.warn('plans: pilot run end failed', { runId: run.id, error: String(err) }) }
    })
  })
  pilot.start()
  setPlanBoardStarter(async (taskId) => { planGate(); const t = await pilot.startFromBoard(taskId); changed(); return t })

  // ---------- briefs (a human edits any section, any time) ----------
  handle('tasks:brief', (q: BriefOp): BriefView => {
    gate()
    const t = h.company.task(q.taskId)
    const by = 'human'
    const out = briefs.edit(t.id, (b, at) => {
      switch (q.op) {
        case 'edit': return editSection(b, q.section, 'replace', redact(q.text), by, at)
        case 'addCriterion': return editSection(b, 'criteria', 'append', redact(q.text), by, at)
        case 'criterion': return setCriterion(b, q.id, q.state, q.reason ? redact(q.reason) : undefined, by, at)
        case 'removeCriterion': return removeCriterion(b, q.id, by, at)
        case 'decide': return decide(b, redact(q.text), redact(q.why), by, at)
        case 'ask': return editSection(b, 'questions', 'append', redact(q.text), by, at)
        case 'answer': return answerQuestion(b, q.id, redact(q.answer), by, at)
      }
    })
    changed()
    return { taskId: out.id, brief: briefOf(out), proof: proofOf(out) }
  })
  handle('tasks:proofPreview', (q) => {
    gate()
    const t = h.company.task(q.taskId)
    const p = proofOf(t).find((x) => x.id === q.proofId)
    if (!p || (p.kind !== 'screenshot' && p.kind !== 'file') || !isImageRef(p.ref) || !path.isAbsolute(p.ref)) return null
    try {
      const st = fs.statSync(p.ref)
      if (!st.isFile() || st.size > MAX_PREVIEW_BYTES) return null
      return `data:${MIME[path.extname(p.ref).toLowerCase()] ?? 'image/png'};base64,${fs.readFileSync(p.ref).toString('base64')}`
    } catch {
      return null
    }
  })

  // ---------- plans ----------
  const own = (id: string) => { planGate(); return plans.get(id) }
  handle('plans:list', (q) => { planGate(); const all = plans.list(q?.companyId); return q?.includeArchived ? all : all.filter((p) => p.status !== 'archived') })
  handle('plans:get', async (q) => { own(q.id); return pilot.refresh(q.id) })
  handle('plans:create', (q) => {
    planGate()
    const p = plans.create(q)
    void pilot.draft(p.id)
    changed()
    return plans.get(p.id)
  })
  handle('plans:redraft', (q) => {
    const p = own(q.id)
    if (p.status !== 'draft') throw new HiveError('bad_request', 'Only a draft can be drafted again')
    void pilot.draft(p.id)
    return plans.get(p.id)
  })
  handle('plans:saveDraft', (q) => { own(q.id); const p = plans.saveDraft(q); changed(); return p })
  handle('plans:approve', (q) => { own(q.id); return pilot.approve(q.id) })
  handle('plans:discard', (q) => { own(q.id); pilot.discard(q.id) })
  handle('plans:setAutonomy', (q) => { own(q.id); return pilot.setAutonomy(q.id, q.autonomy) })
  handle('plans:start', async (q) => { own(q.id); const p = await pilot.startNow(q.id, q.taskId); changed(); return p })
  handle('plans:pass', (q) => { own(q.id); return pilot.pass(q.id, q.milestoneId, q.note) })
  handle('plans:sendBack', (q) => { own(q.id); return pilot.sendBack(q.id, q.milestoneId, q.note) })
  handle('plans:resume', (q) => { own(q.id); return pilot.resume(q.id) })
  handle('plans:pause', (q) => { own(q.id); return pilot.pause(q.id) })
  handle('plans:archive', (q) => { own(q.id); return pilot.archive(q.id) })
  handle('plans:publish', async (q) => { own(q.id); const p = await pilot.publish(q.id); changed(); return p })
  return { plans, pilot, briefs }
}
