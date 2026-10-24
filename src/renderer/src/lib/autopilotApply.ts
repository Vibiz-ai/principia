/**
 * AUTOPILOT.md §4: turning an autopilot on, pausing it and removing it, over the ordinary schedules and workflows
 * channels. No store and no React: the sheet passes `hive`-backed deps (tests pass fakes) and saves the returned record
 * into Settings.autopilots.
 *
 * Steps are created one by one. A step that fails stops the run; the steps already created stay (they are real
 * schedules the user can see) and are recorded, and the error says which step failed.
 */
import { buildStep, withStep, type AutopilotContext, type AutopilotRecord, type StepPlan } from '@shared/autopilot'
import type { SocialId } from '@shared/socials'
import type { Id, Schedule, ScheduleInput, Workflow, WorkflowDraft } from '@shared/types'

export interface AutopilotDeps {
  createWorkflow(d: WorkflowDraft & { companyId: Id }): Promise<Pick<Workflow, 'id'>>
  createSchedule(s: ScheduleInput & { companyId: Id }): Promise<Pick<Schedule, 'id'>>
  setScheduleEnabled(id: Id, enabled: boolean): Promise<unknown>
  removeSchedule(id: Id): Promise<unknown>
  removeWorkflow(id: Id): Promise<unknown>
  now(): string
}

export interface EnableOptions {
  /** the step ids the user kept ticked (only ready ones are created) */
  steps: readonly string[]
  publish: readonly SocialId[]
  competitors?: string
}
export interface EnableResult {
  record: AutopilotRecord | undefined
  created: string[]
  /** "Competitor watch: <message>" for the step that failed, if one did */
  error: string | null
}

/**
 * Creates the ticked, ready steps that the record does not already hold (a step whose schedule was deleted elsewhere
 * is recreated: pass `existing` without it). A paused autopilot's new steps start paused too.
 */
export async function enableAutopilot(deps: AutopilotDeps, plans: readonly StepPlan[], ctx: AutopilotContext, existing: AutopilotRecord | undefined, opts: EnableOptions): Promise<EnableResult> {
  let record = existing
  const created: string[] = []
  const paused = existing?.paused ?? false
  for (const plan of plans) {
    if (!plan.ready || !opts.steps.includes(plan.def.id) || existing?.steps[plan.def.id]) continue
    let workflowId: Id | null = null
    try {
      const build = buildStep(plan, ctx, { publish: opts.publish, enabled: !paused, competitors: opts.competitors })
      if (build.workflow) workflowId = (await deps.createWorkflow(build.workflow)).id
      const schedule = await deps.createSchedule(build.schedule(workflowId))
      record = withStep(record, plan.def.id, { scheduleId: schedule.id, workflowId }, deps.now(), opts.publish)
      created.push(plan.def.id)
    } catch (e) {
      // the workflow of a step whose schedule failed would be an orphan: take it back
      if (workflowId) await deps.removeWorkflow(workflowId).catch(() => undefined)
      return { record, created, error: `${plan.def.name}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if (record && existing && record === existing) record = { ...existing, publish: [...opts.publish] }
  return { record, created, error: null }
}

/** Pauses or resumes every schedule the autopilot created (ones deleted elsewhere are skipped). */
export async function pauseAutopilot(deps: AutopilotDeps, rec: AutopilotRecord, paused: boolean, liveScheduleIds: ReadonlySet<Id>): Promise<{ record: AutopilotRecord; failed: number }> {
  let failed = 0
  for (const step of Object.values(rec.steps)) {
    if (!step || !liveScheduleIds.has(step.scheduleId)) continue
    try {
      await deps.setScheduleEnabled(step.scheduleId, !paused)
    } catch {
      failed++
    }
  }
  return { record: { ...rec, paused }, failed }
}

/** Removes the autopilot's schedules, then its workflows. Steps that fail to go stay in the returned record. */
export async function removeAutopilot(deps: AutopilotDeps, rec: AutopilotRecord, liveScheduleIds: ReadonlySet<Id>): Promise<{ record: AutopilotRecord | undefined; failed: string[] }> {
  const left: AutopilotRecord['steps'] = {}
  const failed: string[] = []
  for (const [stepId, step] of Object.entries(rec.steps)) {
    if (!step) continue
    try {
      if (liveScheduleIds.has(step.scheduleId)) await deps.removeSchedule(step.scheduleId)
      if (step.workflowId) await deps.removeWorkflow(step.workflowId).catch((e: unknown) => {
        // a workflow already deleted by hand is fine
        if (!/not.?found/i.test(String((e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? e))) throw e
      })
    } catch {
      left[stepId] = step
      failed.push(stepId)
    }
  }
  return { record: failed.length ? { ...rec, steps: left } : undefined, failed }
}

/** Steps of the record whose schedule no longer exists (deleted on the Schedules page). */
export function goneSteps(rec: AutopilotRecord | undefined, liveScheduleIds: ReadonlySet<Id>): string[] {
  if (!rec) return []
  return Object.entries(rec.steps).filter(([, s]) => !!s && !liveScheduleIds.has(s.scheduleId)).map(([k]) => k)
}

/** The record without the given steps (so enabling again recreates them). */
export function withoutSteps(rec: AutopilotRecord, stepIds: readonly string[]): AutopilotRecord {
  const steps = { ...rec.steps }
  for (const id of stepIds) delete steps[id]
  return { ...rec, steps }
}
