/**
 * Desktop to cloud sync (CLOUD.md §8): workflows and schedules pushed with `baseRev` (409 with the current rev when
 * stale), schedule placement and the 5-minute floor (the desktop scheduler's own pure helpers), and the opaque
 * `/v1/sync/changes` cursor over runs, asks, passport revisions and changed schedules.
 */
import { z } from 'zod'
import type { CloudSchedule, CloudScheduleSpec, CloudWorkflow, Placement } from '../../shared/cloud'
import { MIN_INTERVAL_MS, minInterval, nextFire } from '../../main/engine/scheduler'
import type { ScheduleRow } from '../contract'
import type { Actor, Ctx } from './context'
import { CHILD_ID } from './companies'
import { workflowDeps, workflowName } from './deps'
import { ApiError, badRequest, notFound } from './http'

interface WorkflowRow { company_id: string; id: string; name: string; rev: number; file: string; problems: string; deps: string; updated_at: string }
interface ScheduleDbRow { company_id: string; id: string; spec: string; placement: string; rev: number; last_fire_at: string | null; last_run_id: string | null; seq: number; updated_at: string }

const specSchema = z.object({
  name: z.string().trim().min(1).max(200),
  when: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('cron'), cron: z.string().trim().min(1).max(200), tz: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('at'), at: z.string().min(1).max(40) })
  ]),
  target: z.object({ kind: z.literal('workflow'), workflowId: z.string().regex(CHILD_ID), inputs: z.record(z.string().max(64), z.string().max(8000)).refine(r => Object.keys(r).length <= 50) }),
  enabled: z.boolean()
})
const scheduleBody = z.object({ schedule: specSchema, placement: z.enum(['local', 'cloud']), baseRev: z.number().int().nonnegative().nullable() })
const workflowBody = z.object({ file: z.unknown(), baseRev: z.number().int().nonnegative().nullable(), keys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/)).max(100).optional() })

const validTz = (tz: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }

/** null when acceptable, else the plain reason (the desktop's floor and grammar) */
export function scheduleProblem(when: CloudScheduleSpec['when'], now: Date): string | null {
  if (when.kind === 'at') return Number.isFinite(Date.parse(when.at)) ? null : 'That date is not valid.'
  if (!validTz(when.tz)) return `Unknown time zone ${when.tz}.`
  if (!nextFire(when, now)) return 'That schedule never fires. Check the cron expression.'
  let gap: number
  try { gap = minInterval(when, now) } catch { return 'That cron expression is not valid.' }
  if (gap < MIN_INTERVAL_MS) return 'Schedules can fire at most every 5 minutes.'
  return null
}

function stale(prevRev: number | null, baseRev: number | null): boolean {
  return prevRev === null ? baseRev !== null : baseRev !== prevRev
}

export function createSync(ctx: Ctx) {
  const wfRow = (cid: string, wid: string) => ctx.db.get<WorkflowRow>('SELECT * FROM workflows WHERE company_id = ? AND id = ?', cid, wid)
  const wfView = (r: WorkflowRow): CloudWorkflow => ({ id: r.id, companyId: r.company_id, name: r.name, rev: r.rev, updatedAt: r.updated_at, problems: JSON.parse(r.problems) })
  const schRow = (cid: string, sid: string) => ctx.db.get<ScheduleDbRow>('SELECT * FROM schedules WHERE company_id = ? AND id = ?', cid, sid)
  function schView(r: ScheduleDbRow): CloudSchedule {
    const spec = JSON.parse(r.spec) as CloudScheduleSpec
    const next = r.placement === 'cloud' && spec.enabled ? nextFire(spec.when, ctx.now()) : null
    return { ...spec, id: r.id, companyId: r.company_id, placement: r.placement as Placement, rev: r.rev, nextFireAt: next ? next.toISOString() : null, lastFireAt: r.last_fire_at, lastRunId: r.last_run_id }
  }

  return {
    workflowRow: wfRow,
    workflows: (cid: string): CloudWorkflow[] => ctx.db.all<WorkflowRow>('SELECT * FROM workflows WHERE company_id = ? ORDER BY name, id', cid).map(wfView),
    putWorkflow(actor: Actor, cid: string, wid: string, body: unknown): CloudWorkflow {
      if (!CHILD_ID.test(wid)) throw badRequest('Workflow ids use letters, digits, ., _ and -.')
      const p = workflowBody.safeParse(body)
      if (!p.success) throw badRequest('Send {file, baseRev, keys?}.')
      const file = p.data.file as { hive?: unknown; workflow?: unknown } | null
      if (!file || typeof file !== 'object' || file.hive !== 'workflow' || !file.workflow || typeof file.workflow !== 'object') throw badRequest('file must be a .hive.json workflow export.')
      const prev = wfRow(cid, wid)
      if (stale(prev?.rev ?? null, p.data.baseRev)) throw new ApiError('conflict', 'The cloud has a newer version of this workflow. Pull it first.', prev?.rev ?? 0)
      let problems: string[]
      try { problems = ctx.runtime.validateWorkflow(cid, file).map(x => String(x).slice(0, 500)) } catch (e) { problems = [(e as Error).message.slice(0, 500)] }
      const rev = (prev?.rev ?? 0) + 1
      const now = ctx.now().toISOString()
      ctx.db.run(`INSERT INTO workflows (company_id, id, name, rev, file, problems, deps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (company_id, id) DO UPDATE SET name = excluded.name, rev = excluded.rev, file = excluded.file, problems = excluded.problems, deps = excluded.deps, updated_at = excluded.updated_at`,
        cid, wid, workflowName(file), rev, JSON.stringify(file), JSON.stringify(problems), JSON.stringify(workflowDeps(file, p.data.keys ?? [])), now)
      ctx.audit(actor, prev ? 'workflow.update' : 'workflow.create', cid, wid, { rev, problems: problems.length })
      return wfView(wfRow(cid, wid)!)
    },
    removeWorkflow(actor: Actor, cid: string, wid: string): void {
      if (!ctx.db.run('DELETE FROM workflows WHERE company_id = ? AND id = ?', cid, wid)) throw notFound('No such workflow.')
      ctx.audit(actor, 'workflow.delete', cid, wid, {})
    },

    schedules: (cid: string): CloudSchedule[] => ctx.db.all<ScheduleDbRow>('SELECT * FROM schedules WHERE company_id = ? ORDER BY id', cid).map(schView),
    putSchedule(actor: Actor, cid: string, sid: string, body: unknown): CloudSchedule {
      if (!CHILD_ID.test(sid)) throw badRequest('Schedule ids use letters, digits, ., _ and -.')
      const p = scheduleBody.safeParse(body)
      if (!p.success) throw badRequest(`Invalid schedule: ${p.error.issues[0]?.path.join('.') || 'body'} ${p.error.issues[0]?.message ?? ''}`.trim())
      const { schedule, placement, baseRev } = p.data
      // fire slots (schedule_fires) and markScheduleFired are keyed by schedule id alone, so ids are unique in the workspace
      if (ctx.db.get('SELECT id FROM schedules WHERE id = ? AND company_id <> ?', sid, cid)) throw new ApiError('conflict', 'Another company in this cloud already has a schedule with this id.')
      if (!wfRow(cid, schedule.target.workflowId)) throw notFound('The schedule\'s workflow is not in the cloud yet. Move the workflow first.')
      const problem = scheduleProblem(schedule.when, ctx.now())
      if (problem) throw badRequest(problem)
      const prev = schRow(cid, sid)
      if (stale(prev?.rev ?? null, baseRev)) throw new ApiError('conflict', 'The cloud has a newer version of this schedule. Pull it first.', prev?.rev ?? 0)
      const rev = (prev?.rev ?? 0) + 1
      const now = ctx.now().toISOString()
      ctx.db.run(`INSERT INTO schedules (company_id, id, spec, placement, rev, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (company_id, id) DO UPDATE SET spec = excluded.spec, placement = excluded.placement, rev = excluded.rev, seq = excluded.seq, updated_at = excluded.updated_at`,
        cid, sid, JSON.stringify(schedule), placement, rev, ctx.db.nextSeq(), now)
      ctx.audit(actor, prev ? 'schedule.update' : 'schedule.create', cid, sid, { placement, rev, enabled: schedule.enabled })
      ctx.runtime.triggers.reloadSchedules()
      return schView(schRow(cid, sid)!)
    },
    removeSchedule(actor: Actor, cid: string, sid: string): void {
      if (!ctx.db.run('DELETE FROM schedules WHERE company_id = ? AND id = ?', cid, sid)) throw notFound('No such schedule.')
      ctx.audit(actor, 'schedule.delete', cid, sid, {})
      ctx.runtime.triggers.reloadSchedules()
    },
    /** ports.cloudSchedules: placed in the cloud, enabled, company and workspace not paused */
    cloudSchedules(): ScheduleRow[] {
      if (ctx.workspace().paused) return []
      return ctx.db.all<ScheduleDbRow>("SELECT s.* FROM schedules s JOIN companies c ON c.id = s.company_id WHERE s.placement = 'cloud' AND c.paused = 0 ORDER BY s.id")
        .map(r => ({ r, spec: JSON.parse(r.spec) as CloudScheduleSpec }))
        .filter(x => x.spec.enabled)
        .map(({ r, spec }) => ({ ...spec, id: r.id, companyId: r.company_id, lastFireAt: r.last_fire_at }))
    },
    /** ports.markScheduleFired: one row per (scheduleId, slot) */
    markFired(scheduleId: string, slot: string, runId: string | null): void {
      ctx.db.tx(() => {
        ctx.db.run('INSERT INTO schedule_fires (schedule_id, slot, run_id, at) VALUES (?, ?, ?, ?) ON CONFLICT (schedule_id, slot) DO UPDATE SET run_id = COALESCE(excluded.run_id, schedule_fires.run_id)', scheduleId, slot, runId, ctx.now().toISOString())
        ctx.db.run('UPDATE schedules SET last_fire_at = ?, last_run_id = COALESCE(?, last_run_id), seq = ? WHERE id = ?', slot, runId, ctx.db.nextSeq(), scheduleId)
      })
    },
    /** true the first time a slot is claimed */
    claimSlot(scheduleId: string, slot: string): boolean {
      return ctx.db.run('INSERT INTO schedule_fires (schedule_id, slot, run_id, at) VALUES (?, ?, NULL, ?) ON CONFLICT (schedule_id, slot) DO NOTHING', scheduleId, slot, ctx.now().toISOString()) > 0
    },
    /** schedules changed in (sinceSeq, uptoSeq], oldest first, at most `limit` (GET /v1/sync/changes pages them) */
    changedSchedules: (sinceSeq: number, uptoSeq: number, limit = SYNC_PAGE): { seq: number; schedule: CloudSchedule }[] =>
      ctx.db.all<ScheduleDbRow>('SELECT * FROM schedules WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?', sinceSeq, uptoSeq, limit).map(r => ({ seq: r.seq, schedule: schView(r) }))
  }
}
export type Sync = ReturnType<typeof createSync>

/** rows per collection in one GET /v1/sync/changes; a fuller collection sets `more` and the cursor stops at its last row */
export const SYNC_PAGE = 500

export const encodeCursor = (seq: number): string => Buffer.from(JSON.stringify({ v: 1, s: seq })).toString('base64url')
export function decodeCursor(c: string | null): number {
  if (!c) return 0
  try { const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { v?: number; s?: number }; if (v.v === 1 && Number.isInteger(v.s) && v.s! >= 0) return v.s! } catch { /* fall through */ }
  throw badRequest('That sync cursor is not valid. Start over without since.')
}
