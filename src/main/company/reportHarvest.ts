/**
 * DEPARTMENTS.md §4.5: the report of an inject adapter (Codex, Gemini, Cursor, or a Claude step without the hivetask
 * tools) is the fenced `principia-task-report` JSON block at the end of its output, parsed with zod. ORCHESTRATOR.md
 * §1.2: a trailing `principia-run-report` block (the run report contract, on every harness) counts too; its outcome,
 * summary and evidence map onto the same task report, so the board contract does not change. A malformed or
 * non-trailing block is no report: the run end then follows §1.4 (passed → in_review flagged "no report"), never a loop.
 * The harvest only writes `task.report` while the run still owns the task; CompanyStore.syncRun turns it into the
 * outcome at run end. A report set through task_report / task_ask (MCP) is never overwritten.
 */
import { z } from 'zod'
import type { BoardTask, TaskReport } from '../../shared/company'
import type { CompanyStore } from './index'
import { TASK_LIMITS } from './taskToolDefs'
import { RUN_REPORT_FENCE } from '../../shared/orchestrator'
import { boardOutcome, toRunReport, trailingFence } from '../orchestrator/runReport'
import { scrubSecrets } from '../forum/teamTools'

export const REPORT_FENCE = 'principia-task-report'
const reportSchema = z.object({
  outcome: z.enum(['review', 'blocked']),
  summary: z.string().trim().min(1).max(20_000),
  evidence: z.array(z.string().max(20_000)).max(200).default([])
})
export type HarvestedReport = Omit<TaskReport, 'at'>

const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s

/**
 * The trailing fenced report of an agent's output (a task report or a run report), or null (missing, not at the end,
 * not JSON, wrong shape). Only whitespace may follow the closing fence. Summary and evidence are clipped to the
 * task_report limits.
 */
export function parseTaskReport(output: string | null | undefined): HarvestedReport | null {
  const f = trailingFence(output, [REPORT_FENCE, RUN_REPORT_FENCE])
  if (!f) return null
  let json: unknown
  try {
    json = JSON.parse(f.body)
  } catch {
    return null
  }
  let data: { outcome: 'review' | 'blocked'; summary: string; evidence: string[] }
  if (f.name === RUN_REPORT_FENCE) {
    const run = toRunReport(json)
    if (!run) return null
    data = boardOutcome(run)
  } else {
    const r = reportSchema.safeParse(json)
    if (!r.success) return null
    data = r.data
  }
  const evidence = data.evidence.map(e => e.trim()).filter(Boolean).slice(0, TASK_LIMITS.evidence).map(e => clip(e, TASK_LIMITS.evidenceItem))
  return { outcome: data.outcome, summary: clip(data.summary, TASK_LIMITS.summary), evidence }
}

/** What the harvester needs from a finished step (EngineContext.onStepOutput's StepOutputEvent). */
export interface HarvestStep {
  runId: string
  stepId: string
  adapter: string
  status: 'passed' | 'failed' | 'canceled'
  /** the step's final answer, already redacted */
  output: string
}

/**
 * Harvests fenced reports into the task of the run (§4.5). Remembers which reports it wrote, so a later step of the same
 * run (a workflow agent) may replace its own harvest but never a report the agent set through MCP.
 */
export class ReportHarvester {
  private readonly harvested = new Map<string, string>()
  constructor(private readonly d: { company: () => CompanyStore; redact?: (s: string) => string; now?: () => Date }) {}

  /** The task this run still owns (in flight on it), or null. */
  private taskOf(runId: string): BoardTask | null {
    const row = this.d.company().store.db.prepare("SELECT id FROM company_tasks WHERE run_id=? AND status='in_progress' LIMIT 1").get(runId) as { id: string } | undefined
    return row ? this.d.company().task(row.id) : null
  }
  /** Returns the report written, or null (no task, not passed, no or malformed block, or an MCP report/ask already set). */
  harvest(e: HarvestStep): TaskReport | null {
    if (e.adapter === 'shell' || e.status !== 'passed') return null
    const t = this.taskOf(e.runId)
    if (!t) return null
    const mine = this.harvested.get(t.id) === e.runId
    if (!mine && (t.report || (t.ask && !t.ask.answer))) return null
    const parsed = parseTaskReport(e.output)
    if (!parsed) return null
    // the vault's own values, then the secret shapes it cannot know (a key pasted into the report)
    const redact = (s: string) => scrubSecrets(this.d.redact ? this.d.redact(s) : s)
    const report: TaskReport = { outcome: parsed.outcome, summary: redact(parsed.summary), evidence: parsed.evidence.map(redact), at: (this.d.now?.() ?? new Date()).toISOString() }
    this.d.company().patchInFlight(t.id, { report })
    this.harvested.set(t.id, e.runId)
    if (this.harvested.size > 1000) for (const k of [...this.harvested.keys()].slice(0, 500)) this.harvested.delete(k)
    return report
  }
  /** task_report / task_ask through MCP took over: a later fenced block of this run no longer replaces it. */
  forget(taskId: string): void { this.harvested.delete(taskId) }
}
