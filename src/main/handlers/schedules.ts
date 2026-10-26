import type { Id, Schedule, ScheduleInput } from '../../shared/types'
import { departmentsEnabled } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { guardSameCompany, requireCompany, workflowCompany, type ScopeHost } from './companyScope'
import { checkTarget } from './runs'
import { runScheduleInCloud } from '../cloud/move'

/**
 * COMPANY.md §3: a schedule's company comes from its workflow; a prompt schedule takes its repo's company, else the
 * explicit companyId, else Personal. The workflow and repo target must then belong to it (assertSameCompany, §6).
 */
export function scheduleCompany(h: ScopeHost, input: ScheduleInput, explicit?: Id | null): Id {
  const t = input.target
  const companyId =
    t.kind === 'workflow' ? workflowCompany(h, t.workflowId)
    : t.repoId ? h.company.companyForRepo(t.repoId).id
    : requireCompany(h, explicit)
  // created or kept in another company than its target: refused with the flag on, warned (and stamped from the target) off
  if (explicit && explicit !== companyId) guardSameCompany(h, requireCompany(h, explicit), t.kind === 'workflow' ? { workflowId: t.workflowId } : { repoId: t.repoId }, 'schedule')
  return companyId
}

function validateInput(h: Hive, input: ScheduleInput): void {
  const p = h.engine.scheduler.preview(input.when)
  if (!p.ok) throw new HiveError('validation', p.error ?? 'Invalid schedule', [{ path: 'when', message: p.error ?? 'Invalid schedule' }])
  try {
    checkTarget(h, input.target)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new HiveError('validation', msg, [{ path: 'target', message: msg }])
  }
}

/**
 * DEPARTMENTS.md §8: task mode, an agent and a department exist only with experimental.departments on; the department
 * and agent must be active and belong to the schedule's company (as triggerConfig.ts checks for Slack triggers).
 */
function validateBoard(h: Hive, input: ScheduleInput, companyId: Id): void {
  const t = input.target
  const wantsBoard = t.mode === 'task' || !!t.agentId || !!input.departmentId
  if (!wantsBoard) return
  const bad = (path: string, message: string): never => { throw new HiveError('validation', message, [{ path, message }]) }
  if (!departmentsEnabled(h.settings().experimental)) bad('target.mode', 'Departments are experimental. Turn on Companies and Departments under Settings → Experimental to post schedules to the board.')
  if (input.departmentId) {
    const dep = h.company.departments.get(input.departmentId)
    if (!dep || dep.companyId !== companyId) bad('departmentId', 'Pick a department of this company')
    if (dep!.archivedAt) bad('departmentId', 'That department is archived')
  }
  if (t.agentId) {
    const agent = h.company.departments.getAgent(t.agentId)
    if (!agent || agent.companyId !== companyId) bad('target.agentId', 'Pick an agent of this company')
    if (agent!.archivedAt) bad('target.agentId', `${agent!.name} is archived`)
  }
}

/** Upserts the schedule in the engine, then tells the renderer (shared by create, update, setEnabled). */
function afterScheduleWrite(h: Hive, id: Id): Schedule {
  const s = h.safe(() => h.engine.scheduler.upsert(id), null) ?? h.store.getSchedule(id)
  if (!s) throw new HiveError('not_found', 'Schedule not found')
  const fresh = h.store.getSchedule(id) ?? s
  emit('schedule:updated', fresh)
  emit('data:changed', { domain: 'schedules' })
  h.statusChanged()
  return fresh
}

/**
 * schedules:create (also used by onboarding launch): when, target, company and board checks, then insert and upsert.
 * The same guards apply whichever caller creates it.
 */
export function createSchedule(h: Hive, { companyId, ...input }: ScheduleInput & { companyId?: Id | null }): Schedule {
  validateInput(h, input as ScheduleInput)
  const co = scheduleCompany(h, input as ScheduleInput, companyId)
  validateBoard(h, input as ScheduleInput, co)
  const id = h.store.insertSchedule(input as ScheduleInput, co)
  return afterScheduleWrite(h, id)
}

/** schedules:update. */
export function updateSchedule(h: Hive, id: Id, input: ScheduleInput): Schedule {
  const existing = h.store.getSchedule(id)
  if (!existing) throw new HiveError('not_found', 'Schedule not found')
  validateInput(h, input)
  // a repo-less prompt schedule keeps its company; a workflow or repo target re-stamps from it
  const co = scheduleCompany(h, input, existing.companyId)
  validateBoard(h, input, co)
  h.store.updateScheduleConfig(id, input, co)
  return afterScheduleWrite(h, id)
}

/** schedules:setEnabled. */
export function setScheduleEnabled(h: Hive, id: Id, enabled: boolean): Schedule {
  h.store.setScheduleEnabled(id, enabled)
  return afterScheduleWrite(h, id)
}

/** schedules:remove. */
export function removeSchedule(h: Hive, id: Id): void {
  if (!h.store.getSchedule(id)) throw new HiveError('not_found', 'Schedule not found')
  h.safe(() => h.engine.scheduler.remove(id), undefined)
  h.store.deleteSchedule(id)
  emit('data:changed', { domain: 'schedules' })
  h.statusChanged()
}

export function registerScheduleHandlers(h: Hive): void {
  handle('schedules:list', (q) => h.store.listSchedules(q?.companyId))
  handle('schedules:create', (req) => createSchedule(h, req as ScheduleInput & { companyId?: Id | null }))
  handle('schedules:update', ({ id, input }) => updateSchedule(h, id, input as ScheduleInput))
  handle('schedules:remove', ({ id }) => removeSchedule(h, id))
  handle('schedules:setEnabled', ({ id, enabled }) => setScheduleEnabled(h, id, enabled))
  handle('schedules:runNow', async ({ id }) => {
    const s = h.store.getSchedule(id)
    if (!s) throw new HiveError('not_found', 'Schedule not found')
    // CLOUD.md §8: a schedule placed in the cloud fires there only, and Run now starts it there too (null: no local run)
    if (h.safe(() => h.cloud.link.ownsSchedule(id), false)) {
      await runScheduleInCloud(h.cloud.move, s)
      return null
    }
    // §8: a task-mode schedule comments on and wakes its standing card instead of starting a run (null)
    const sched = h.engine.scheduler
    const { run, card } = sched.fireNow ? sched.fireNow(id) : { run: sched.runNow(id), card: null }
    if (card) emit('data:changed', { domain: 'tasks' })
    h.statusChanged()
    return run
  })
  handle('schedules:preview', ({ when }) => h.engine.scheduler.preview(when))
  // LIVE.md §8 "Skip": the engine records skip_slot_at, logs 'skipped' and emits schedule.updated
  handle('schedules:skipNext', ({ id }) => {
    if (!h.store.getSchedule(id)) throw new HiveError('not_found', 'Schedule not found')
    if (!h.engine.scheduler.skipNext) throw new HiveError('internal', 'Skipping a schedule is not available yet')
    h.engine.scheduler.skipNext(id)
    const fresh = h.store.getSchedule(id)!
    emit('schedule:updated', fresh)
    h.statusChanged()
    return fresh
  })
  handle('schedules:events', ({ scheduleId, limit }) => h.store.scheduleEvents(scheduleId, limit ?? 50))
  handle('schedules:pauseAll', ({ paused }) => {
    h.updateSettings({ schedulesPaused: paused })
    return h.status()
  })
}
