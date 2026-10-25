/**
 * Five doors A4 "one rule for paused": pause or resume ONE company. Pausing pauses its agents (seats), holds its
 * schedules and its autopilot (every start path checks CompanyStore.isPaused), and checkpoints the work in flight:
 * each running task turn is canceled with a 'paused' stop, so the task returns to To do with a wake saying where it
 * stopped (the provider conversation resumes when it can). Resuming brings back exactly the seats this pause paused
 * and starts the saved work again. Nothing of any other company is read or changed. No Electron imports.
 */
import type { CompanyPauseCheckpoint, CompanyPauseResult } from '../../shared/company'
import type { CompanyStore } from './index'

export interface CompanyPauseDeps {
  company: CompanyStore
  /** h.engine.runs.cancel */
  cancelRun(runId: string): Promise<void>
  /** A human start of a saved task (dispatcher.runNow, else CompanyStore.startTask with the engine starter). */
  startTask(taskId: string): void
  /** This company's enabled schedules (they hold while it is paused). */
  schedules(companyId: string): number
  log?: { warn(m: string, meta?: Record<string, unknown>): void }
}

export async function setCompanyPaused(d: CompanyPauseDeps, companyId: string, paused: boolean): Promise<CompanyPauseResult> {
  const c = d.company
  if (paused) {
    const r = c.pauseCompany(companyId)
    const saved: CompanyPauseCheckpoint[] = []
    for (const cp of r.inFlight) {
      const t = c.task(cp.taskId)
      if (t.status !== 'in_progress' || !t.runId) continue
      c.expectStop(t.id, 'paused')
      try {
        await d.cancelRun(t.runId)
        saved.push(cp)
      } catch (e) {
        d.log?.warn('company pause: could not stop a task turn', { taskId: t.id, runId: t.runId, error: String(e) })
      }
    }
    return { company: c.passport(companyId), paused: true, agents: r.seats.length, schedules: d.schedules(companyId), checkpoints: saved }
  }
  const r = c.resumeCompany(companyId)
  const started: CompanyPauseCheckpoint[] = []
  for (const cp of r.checkpoints) {
    let t
    try {
      t = c.task(cp.taskId)
    } catch {
      continue // deleted while paused
    }
    // only work that is still waiting where the pause left it (a human may have moved it meanwhile)
    if (t.companyId !== companyId || t.status !== 'todo') continue
    try {
      d.startTask(t.id)
      started.push(cp)
    } catch (e) {
      d.log?.warn('company resume: saved work did not start', { taskId: t.id, error: String(e) })
    }
  }
  return { company: c.passport(companyId), paused: false, agents: r.seats.length, schedules: d.schedules(companyId), checkpoints: started }
}
