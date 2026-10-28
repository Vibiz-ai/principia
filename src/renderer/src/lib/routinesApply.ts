/**
 * Automations › Routines: Turn on, Turn off and Run once now, over injected hive calls (testable without IPC). Turn on
 * re-enables the routine's schedule when it exists, else creates the workflow (when the routine runs one and the
 * company has none) and one enabled schedule. Turn off only disables the schedule: it stays under Schedules, and Turn
 * on brings it back. Run once now never creates a schedule.
 */
import type { CompanyTask, CompanyTaskInput } from '@shared/company'
import { buildRoutine, routinePrompt, type RoutineContext, type RoutinePlan, type RoutineRecord } from '@shared/routines'
import type { Id, Run, RunTarget, Schedule, ScheduleInput, Workflow, WorkflowDraft } from '@shared/types'

export interface RoutineDeps {
  createWorkflow(d: WorkflowDraft & { companyId: Id }): Promise<Workflow>
  createSchedule(s: ScheduleInput & { companyId: Id }): Promise<Schedule>
  setScheduleEnabled(id: Id, enabled: boolean): Promise<Schedule>
  updateSchedule?(id: Id, input: ScheduleInput): Promise<Schedule>
  runSchedule(id: Id): Promise<unknown>
  /** the schedule's latest event message ("Created NC-4; Seneca is running 3 tasks; NC-4 starts when one finishes") */
  lastScheduleMessage?(id: Id): Promise<string | null>
  startRun(target: RunTarget, companyId: Id): Promise<Run>
  createTask(task: CompanyTaskInput): Promise<CompanyTask>
  startTask(id: Id): Promise<CompanyTask>
}

type Wf = Pick<Workflow, 'id' | 'name'> & { companyId?: Id | null }

/** Turn on: the record to keep in Settings.routines and the (enabled) schedule. */
export async function turnOnRoutine(deps: RoutineDeps, plan: RoutinePlan, ctx: RoutineContext, workflows: readonly Wf[], existing: Schedule | null, now = new Date(), opts: { cron?: string } = {}): Promise<{ record: RoutineRecord; schedule: Schedule }> {
  if (existing) {
    let schedule = existing.enabled ? existing : await deps.setScheduleEnabled(existing.id, true)
    if (opts.cron) schedule = await changeRoutineTime(deps, schedule, opts.cron)
    const workflowId = existing.target.kind === 'workflow' ? existing.target.workflowId : null
    return { record: { scheduleId: schedule.id, workflowId, onAt: now.toISOString() }, schedule }
  }
  const b = buildRoutine(plan, ctx, workflows)
  const workflowId = b.workflow ? (await deps.createWorkflow(b.workflow)).id : b.reuseWorkflowId
  const input = b.schedule(workflowId)
  const schedule = await deps.createSchedule(opts.cron && input.when.kind === 'cron' ? { ...input, when: { ...input.when, cron: opts.cron } } : input)
  return { record: { scheduleId: schedule.id, workflowId, onAt: now.toISOString() }, schedule }
}

export async function turnOffRoutine(deps: RoutineDeps, schedule: Schedule): Promise<Schedule> {
  return schedule.enabled ? deps.setScheduleEnabled(schedule.id, false) : schedule
}

/**
 * Run once now: the routine's schedule fires now when it has one (its recurring card wakes); otherwise a one-off: a
 * task for the routine's agent, started (departments on), or a plain run (the workflow, or the prompt).
 */
export async function runRoutineOnce(deps: RoutineDeps, plan: RoutinePlan, ctx: RoutineContext, workflows: readonly Wf[], existing: Schedule | null): Promise<{ kind: 'schedule' | 'task' | 'run'; id: Id | null; waiting?: string | null }> {
  if (existing) {
    await deps.runSchedule(existing.id)
    const msg = deps.lastScheduleMessage ? await deps.lastScheduleMessage(existing.id).catch(() => null) : null
    return { kind: 'schedule', id: existing.id, waiting: scheduleWaitingOf(msg) }
  }
  const b = buildRoutine(plan, ctx, workflows)
  if (plan.def.kind === 'workflow') {
    const workflowId = b.workflow ? (await deps.createWorkflow(b.workflow)).id : b.reuseWorkflowId!
    const run = await deps.startRun({ kind: 'workflow', workflowId, inputs: { root: 'all' } }, ctx.companyId)
    return { kind: 'run', id: run.id }
  }
  if (plan.agent) {
    const a = plan.agent
    const task = await deps.createTask({
      title: plan.def.name,
      description: routinePrompt(plan.def, ctx, true),
      companyId: ctx.companyId,
      repoId: plan.def.id === 'repo-health' ? (ctx.repoIds[0] ?? null) : null,
      status: 'todo',
      priority: 0,
      source: 'manual',
      sourceUrl: null,
      externalId: null,
      assigneeProfileId: null,
      parentId: null,
      dependencyIds: [],
      departmentId: a.departmentId ?? plan.departmentId,
      agentId: a.id
    })
    await deps.startTask(task.id)
    return { kind: 'task', id: task.id }
  }
  const target = b.schedule(null).target
  const run = await deps.startRun({ kind: 'prompt', profileId: plan.profileId!, repoId: target.kind === 'prompt' ? target.repoId : null, prompt: routinePrompt(plan.def, ctx, false) }, ctx.companyId)
  return { kind: 'run', id: run.id }
}

/** What keeps a fire from starting, from its schedule event ("Created NC-4; <why>"), or null when it started. */
export function scheduleWaitingOf(message: string | null | undefined): string | null {
  if (!message) return null
  const cut = message.indexOf('; ')
  return cut < 0 ? null : message.slice(cut + 2).trim() || null
}

/** Change when a routine runs (its schedule's cron, same time zone); nothing else about it changes. */
export async function changeRoutineTime(deps: RoutineDeps, schedule: Schedule, cron: string): Promise<Schedule> {
  if (!deps.updateSchedule) throw new Error('Changing the time is not available here')
  if (schedule.when.kind === 'cron' && schedule.when.cron === cron) return schedule
  const tz = schedule.when.kind === 'cron' ? schedule.when.tz : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return deps.updateSchedule(schedule.id, { name: schedule.name, target: schedule.target, departmentId: schedule.departmentId ?? null, when: { kind: 'cron', cron, tz }, preset: { kind: 'cron' }, enabled: schedule.enabled })
}
