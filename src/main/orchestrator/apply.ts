/**
 * ORCHESTRATOR.md §1.3: after a run, Principia acts on the agent's run report itself, on any harness. Once per run
 * (`orch_run_reports`), every action or skip written down for the founder (the Run view's "Principia after this run").
 *
 * Two moments:
 * - before the board syncs the run (`beforeSync`, wrapped around CompanyStore.syncRun outside the handoff wrapper, so
 *   the task is still in flight): the handoff through the existing task_handoff path, follow-ups that block the
 *   current task (its dependency), and founder questions and blockers as the task's ask (so it lands in Needs you);
 * - after the run ended and the board outcome is final (`afterRun`, a run hook registered after the board's): the update
 *   post, the other follow-ups, questions to teammates (the mailbox), answers to teammates, facts as memory proposals.
 *
 * What the agent already did over MCP in this run is skipped: its own Forum posts, the teammates it already asked,
 * tasks already on the board (by normalised title), its own task ask. A report the fallback extractor made only
 * proposes: no todo tasks, no wakes, no asks. Shadow mode records what would happen and does nothing.
 */
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { departmentsEnabled, type BoardTask } from '../../shared/company'
import { waitsForAnswer } from '../../shared/taskCard'
import type { StepOutputEvent } from '../../shared/engine'
import { orchestratorFor, orchestratorSettings, type OrchAction, type OrchestratorSettings, type RunFollowUp, type RunOrchestration, type RunReport, type RunReportSource } from '../../shared/orchestrator'
import type { Run } from '../../shared/types'
import { connectLink } from '../../shared/deepLink'
import type { CompanyStore } from '../company'
import { queueCountsFrom, route } from '../company/router'
import { runReportPath } from '../engine/env'
import type { ForumService } from '../forum/service'
import { scrubSecrets } from '../forum/teamTools'
import type { Mailbox } from './mailbox'
import { boardOutcome, parseRunReport, readRunReportFile } from './runReport'

const TERMINAL = new Set(['passed', 'failed', 'canceled'])
const HOUR = 3_600_000
/** follow-ups Principia files per company per rolling hour (the same order as task_create's cap) */
export const FOLLOW_UP_CAP_PER_HOUR = 10
const OUTPUT_TAIL = 16 * 1024
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const OPEN = (t: BoardTask) => t.status !== 'done' && t.status !== 'canceled'
/** "Fix the Login bug!" and "fix the login bug" are the same task. */
export const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The open task a follow-up repeats, or null: one with the same title, one this run already filed itself (task_create
 * gives it an externalId starting with the run id) whose title fits, or the task an "NC-8: …" prefix names.
 */
export function sameWork(all: readonly BoardTask[], title: string, runId: string): BoardTask | null {
  const prefix = /^\s*\[?([A-Za-z][A-Za-z0-9]{0,9}-\d+)\]?\s*[:\-–—]\s*/.exec(title)
  const bare = normTitle(prefix ? title.slice(prefix[0].length) : title)
  const open = all.filter(OPEN)
  if (prefix) {
    const named = open.find((t) => t.identifier.toLowerCase() === prefix[1]!.toLowerCase())
    // only a task this run filed, or one of the same work ("NC-7: …" may just name the task it came from)
    if (named && ((named.externalId ?? '').startsWith(`${runId}:`) || normTitle(named.title) === bare)) return named
  }
  const exact = open.find((t) => normTitle(t.title) === bare || normTitle(t.title) === normTitle(title))
  if (exact) return exact
  if (bare.length < 8) return null
  return open.find((t) => (t.externalId ?? '').startsWith(`${runId}:`) && (normTitle(t.title).includes(bare) || bare.includes(normTitle(t.title)))) ?? null
}
const FOUNDER = new Set(['founder', 'owner', 'human', 'you', 'me', 'boss', 'ceo'])
const NEEDS: Record<string, string> = { decision: 'Needs your decision', access: 'Needs access', money: 'Needs money (nothing is spent without your yes)', connection: 'Needs a connection' }
/** a sentence ends with a stop before the next one is appended */
const stop = (s: string) => (/[.!?…)]$/.test(s) ? s : `${s}.`)
/** One blocker as a line for the founder: "Needs a connection: … . Set it up: principia://connect/…" */
export const blockerLine = (b: RunReport['blockers'][number]): string =>
  `${NEEDS[b.needs]}: ${b.needs === 'connection' && b.connectionId ? `${stop(flat(b.text))} Set it up: ${connectLink(b.connectionId)}` : flat(b.text)}`
/** A secret Principia scrubbed out of report text: a fact holding one is never kept. */
const REDACTED = /\[redacted\]|••••/

export interface ApplyDeps {
  db: Database.Database
  company: () => CompanyStore
  /** Settings → orchestrator (raw; filled here) */
  settings: () => Partial<OrchestratorSettings> | null | undefined
  /** experimental.companies + .departments */
  boardFlags: () => { companies?: boolean; departments?: boolean } | null | undefined
  forum: () => ForumService | null
  mailbox: Mailbox
  /** <userData>/run-logs (the report files live there); null = no files */
  runLogsDir: string | null
  /** facts → memory proposals (SuggestionPipeline.fileRunFacts); null = no vault runtime */
  facts?: (companyId: string, run: { runId: string; stepId: string; adapter: StepOutputEvent['adapter'] }, facts: RunReport['facts']) => { created: string[] } | null
  /** the existing task_handoff path, as the run's own step (AuthorBroker.taskCall). Rejects with the refusal. */
  handoff?: (owner: { runId: string; stepId: string }, args: { departmentKey?: string; agentId?: string; reason: string }) => Promise<unknown>
  /** the fallback extractor (extract.ts), null = none installed */
  extract?: ((input: { finalAnswer: string; transcriptTail: string }, companyId: string) => Promise<RunReport | null>) | null
  /** h.vault.redact: every report text (a report file never went through the step output's redaction) */
  redact?: (s: string) => string
  /** after Principia changed tasks (data:changed tasks) */
  onChange?: (companyId: string) => void
  now?: () => Date
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

interface StepCapture { stepId: string; adapter: StepOutputEvent['adapter']; output: string; report: RunReport | null; source: RunReportSource }
interface RunInfo { companyId: string; taskId: string | null; agentId: string | null }

export class RunApplier {
  /** the last passed agent step of each run in flight */
  private readonly steps = new Map<string, StepCapture>()
  /** what beforeSync did, merged into the run's row by afterRun */
  private readonly pre = new Map<string, { actions: OrchAction[]; pending: Promise<unknown>[]; held: RunReport['blockers']; asked: Set<number> }>()
  /** runs being applied (afterRun is async: an extraction may take a while) */
  private readonly applying = new Map<string, Promise<void>>()

  constructor(private readonly d: ApplyDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date()
  }
  settings(): OrchestratorSettings {
    return orchestratorSettings(this.d.settings())
  }
  /** The setting one company runs with (its own "Principia runs the team" switches over the app-wide one). */
  settingsFor(companyId: string | null | undefined): OrchestratorSettings {
    return orchestratorFor(this.d.settings(), companyId)
  }
  /** shadow or on, with the board flags on (for one company when given: its own switch can turn it off) */
  active(companyId?: string | null): 'shadow' | 'on' | null {
    const s = companyId ? this.settingsFor(companyId) : this.settings()
    if (s.mode === 'off' || !departmentsEnabled(this.d.boardFlags())) return null
    return s.mode
  }
  private companyOfRun(runId: string): string | null {
    try {
      return (this.d.db.prepare('SELECT company_id FROM runs WHERE id=?').get(runId) as { company_id: string | null } | undefined)?.company_id ?? null
    } catch {
      return null
    }
  }

  // ---------- capture ----------

  private reportOf(runId: string, stepId: string, output: string): { report: RunReport | null; source: RunReportSource } {
    const fenced = parseRunReport(output)
    if (fenced) return { report: this.clean(fenced), source: 'fence' }
    const file = this.d.runLogsDir ? readRunReportFile(runReportPath(this.d.runLogsDir, runId, stepId)) : null
    return file ? { report: this.clean(file), source: 'file' } : { report: null, source: 'none' }
  }
  /**
   * Every string of a report through the vault's redaction, then the secret shapes a vault cannot know (a key pasted
   * into the report: sk-ant-…, ghp_…, a bearer header). Report text reaches the Forum, the board and teammates' prompts.
   */
  private clean(r: RunReport): RunReport {
    const redact = this.d.redact
    const one = (v: string) => scrubSecrets(redact ? redact(v) : v)
    const deep = (v: unknown): unknown => (typeof v === 'string' ? one(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v)
    return deep(r) as RunReport
  }

  /** EngineContext.onStepOutput (hive.stepOutputHooks): remember the run's last passed agent step and its report. */
  onStepOutput(e: StepOutputEvent): void {
    if (e.adapter === 'shell' || e.status !== 'passed' || !e.companyId || !this.active(e.companyId)) return
    const r = this.reportOf(e.runId, e.stepId, e.output)
    this.steps.set(e.runId, { stepId: e.stepId, adapter: e.adapter, output: e.output.slice(-OUTPUT_TAIL), ...r })
    if (this.steps.size > 500) for (const k of [...this.steps.keys()].slice(0, 250)) this.steps.delete(k)
  }

  /** ForumService.deferAutoPost: Principia posts this task step's update from its report (mode on only). */
  willPost(e: { runId: string; stepId: string; output: string }): boolean {
    const co = this.companyOfRun(e.runId)
    if ((co ? this.active(co) : this.active()) !== 'on') return false
    return !!this.reportOf(e.runId, e.stepId, e.output).report
  }

  /** The run's capture, else its last passed agent step from the db (a restart lost the memory). */
  private capture(runId: string): StepCapture | null {
    const c = this.steps.get(runId)
    if (c) return c
    try {
      const row = this.d.db.prepare("SELECT id, adapter, output FROM run_steps WHERE run_id=? AND status='passed' AND adapter!='shell' ORDER BY seq DESC LIMIT 1").get(runId) as { id: string; adapter: StepOutputEvent['adapter']; output: string | null } | undefined
      if (!row) return null
      const output = (row.output ?? '').slice(-OUTPUT_TAIL)
      return { stepId: row.id, adapter: row.adapter, output, ...this.reportOf(runId, row.id, output) }
    } catch {
      return null
    }
  }

  private info(runId: string): RunInfo | null {
    let row: { company_id: string | null; task_id: string | null; agent_id: string | null } | undefined
    try {
      row = this.d.db.prepare('SELECT company_id, task_id, agent_id FROM runs WHERE id=?').get(runId) as typeof row
    } catch {
      row = undefined
    }
    const taskId = row?.task_id ?? (this.d.db.prepare('SELECT id FROM company_tasks WHERE run_id=? LIMIT 1').get(runId) as { id: string } | undefined)?.id ?? null
    let task: BoardTask | null = null
    try {
      task = taskId ? this.d.company().task(taskId) : null
    } catch {
      task = null
    }
    const companyId = row?.company_id ?? task?.companyId ?? null
    if (!companyId) return null
    return { companyId, taskId: task?.id ?? null, agentId: row?.agent_id ?? task?.agentId ?? null }
  }

  private isFounder(companyId: string, to: string): boolean {
    const h = to.trim().replace(/^[@#]/, '').toLowerCase()
    if (FOUNDER.has(h)) return true
    try {
      return this.d.forum()?.store.owner(companyId).handle === h
    } catch {
      return false
    }
  }

  // ---------- before the board syncs the run ----------

  /** Wrapped around CompanyStore.syncRun (outside the handoff wrapper). Never throws. */
  beforeSync(run: Pick<Run, 'id' | 'status'>): void {
    try {
      if (run.status !== 'passed' || this.pre.has(run.id)) return
      const row = this.d.db.prepare("SELECT id, company_id FROM company_tasks WHERE run_id=? AND status='in_progress' LIMIT 1").get(run.id) as { id: string; company_id: string } | undefined
      if (!row) return
      const mode = this.active(row.company_id)
      if (!mode) return
      const cap = this.capture(run.id)
      if (!cap?.report) return
      const c = this.d.company()
      const task = c.task(row.id)
      const r = cap.report
      const shadow = mode === 'shadow'
      const actions: OrchAction[] = []
      const pending: Promise<unknown>[] = []
      const held: RunReport['blockers'] = []
      const asked = new Set<number>()
      this.pre.set(run.id, { actions, pending, held, asked })
      // the board contract: a report file counts like the fenced block the harvest reads (never over an MCP report or ask)
      if (cap.source === 'file' && !task.report && !(task.ask && !task.ask.answer)) {
        c.patchInFlight(task.id, { report: { ...boardOutcome(r), at: this.now().toISOString() } })
      }
      // 1. follow-ups the current task waits for: filed now, so the run end leaves it blocked until they are done
      r.followUps.forEach((f, i) => {
        if (!f.blocksCurrent) return
        const a = this.followUp(run.id, task.companyId, task, task.agentId, f, i, { shadow, extracted: false, blocks: true })
        actions.push(a)
      })
      // 2. the handoff, through the existing task_handoff path (applied right after this, before syncRun)
      if (r.handoff) {
        const agentId = r.handoff.agentHandle ? safe(() => this.d.forum()?.store.agentByName(task.companyId, r.handoff!.agentHandle!)?.agentId ?? undefined, undefined) : undefined
        const target = r.handoff.agentHandle ? `@${r.handoff.agentHandle.replace(/^@/, '')}` : r.handoff.departmentKey!
        if (r.handoff.agentHandle && !agentId && !r.handoff.departmentKey) actions.push({ kind: 'handoff', status: 'failed', detail: `No agent ${target} to hand ${task.identifier} to` })
        else if (shadow) actions.push({ kind: 'handoff', status: 'shadow', detail: `Would hand ${task.identifier} to ${target}: ${clip(r.handoff.why, 200)}` })
        else if (!this.d.handoff) actions.push({ kind: 'handoff', status: 'failed', detail: 'Handoffs are not available in this Principia' })
        else {
          const a: OrchAction = { kind: 'handoff', status: 'done', detail: `Handed ${task.identifier} to ${target}: ${clip(r.handoff.why, 200)}`, ref: task.identifier }
          actions.push(a)
          const args = { ...(r.handoff.departmentKey ? { departmentKey: r.handoff.departmentKey } : {}), ...(agentId ? { agentId } : {}), reason: r.handoff.why }
          pending.push(
            this.d.handoff({ runId: run.id, stepId: cap.stepId }, args).catch((e: unknown) => {
              a.status = 'failed'
              a.detail = `Could not hand ${task.identifier} to ${target}: ${clip(e instanceof Error ? e.message : String(e), 200)}`
            })
          )
        }
      }
      // 3. founder questions and blockers become the task's ask: the run end parks it in Needs you. A decision the
      // agent waits for from a teammate (a blocking question in the same report) is that teammate's, not the founder's:
      // the question is sent now (the mailbox), the decision stays out of Needs you, and the answer resumes the task
      // (mailbox.onAnswered). A teammate who cannot be asked sends it to the founder as the task's own ask, so the
      // founder's answer resumes the task the usual way (tasks:answer).
      const founderQs = r.questions.filter((q) => this.isFounder(task.companyId, q.to))
      const unasked: { to: string; detail: string }[] = []
      let waiting: string[] = []
      if (!r.handoff && !shadow && task.agentId) {
        r.questions.forEach((q, i) => {
          if (!q.blocking || this.isFounder(task.companyId, q.to)) return
          asked.add(i)
          const res = this.d.mailbox.send({ companyId: task.companyId, fromAgentId: task.agentId!, fromRunId: run.id, fromTaskId: task.id, to: q.to, question: q.question, why: q.why, blocking: true, opKey: `orch:${run.id}:q:${i}` })
          actions.push(questionAction(q, res))
          if (res.status === 'refused') unasked.push({ to: q.to, detail: res.detail })
          else waiting.push(q.to.startsWith('@') ? q.to : `@${q.to}`)
        })
      } else if (!r.handoff && shadow) waiting = r.questions.filter((q) => q.blocking && !this.isFounder(task.companyId, q.to)).map((q) => q.to)
      // a teammate this run asked with the Forum tools (forum_ask_agent, or an @mention question) and the agent ended
      // its turn: the answer resumes the task (mailbox.onAnswered / onReplied), so that wait is not the founder's either
      if (!r.handoff) for (const h of this.openAgentAsks(run.id, task)) if (!waiting.includes(h)) waiting.push(h)
      const blockers = waiting.length && !unasked.length ? r.blockers.filter((b) => b.needs !== 'decision') : r.blockers
      if (blockers.length < r.blockers.length) {
        held.push(...r.blockers.filter((b) => !blockers.includes(b)))
        const n = held.length
        actions.push({ kind: 'blocker', status: 'skipped', ref: task.identifier, detail: `Kept ${n === 1 ? 'a decision' : `${n} decisions`} out of Needs you: ${task.identifier} waits for ${waiting.join(', ')}, not for you. The answer picks the task back up` })
      }
      const why = unasked.length ? stop(`Principia: ${unasked.map((u) => `${u.to} could not be asked (${clip(flat(u.detail), 160)})`).join('; ')}, so this comes to you`) : null
      // a teammate who could not be asked: the question itself comes to the founder when no decision says it already
      const orphan = unasked.length && !r.blockers.some((b) => b.needs === 'decision') ? r.questions.filter((q, i) => asked.has(i) && unasked.some((u) => u.to === q.to)) : []
      const lines = [...[...founderQs, ...orphan].map((q) => `${flat(q.question)}${q.why ? ` (why: ${flat(q.why)})` : ''}`), ...blockers.map(blockerLine), ...(why && (founderQs.length || orphan.length || blockers.length) ? [why] : [])]
      if (lines.length) {
        const nq = founderQs.length + orphan.length
        const what = `${nq ? `${nq} question${nq === 1 ? '' : 's'}` : ''}${nq && blockers.length ? ' and ' : ''}${blockers.length ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}` : ''}` || 'a question'
        const links = blockers.filter((b) => b.needs === 'connection' && b.connectionId).map((b) => connectLink(b.connectionId!))
        const base = { kind: (founderQs.length || orphan.length ? 'founder_question' : 'blocker') as OrchAction['kind'], ref: task.identifier, ...(links[0] ? { link: links[0] } : {}) }
        if (r.handoff) actions.push({ ...base, status: 'skipped', detail: `Kept ${what} out of Needs you: the task was handed on` })
        else if (task.ask && !task.ask.answer) actions.push({ ...base, status: 'skipped', detail: `${task.identifier} already asks you something (the agent asked over its tools)` })
        else if (shadow) actions.push({ ...base, status: 'shadow', detail: `Would put ${what} from ${task.identifier} in Needs you` })
        else {
          c.patchInFlight(task.id, { ask: { kind: 'question', prompt: clip(lines.join('\n'), 2000) } })
          actions.push({ ...base, status: 'done', detail: why ? `Asked you instead, in Needs you (${task.identifier}): ${clip(why.replace(/^Principia: /, ''), 300)}` : `Put ${what} from ${task.identifier} in Needs you` })
        }
      }
    } catch (e) {
      this.d.log?.warn('orchestrator: before-sync failed', { runId: run.id, error: String(e) })
    }
  }

  // ---------- after the run ----------

  /** A run hook, registered after the board's (its outcome is final). Once per run; async (an extraction may run). */
  afterRun(run: Pick<Run, 'id' | 'status'>): Promise<void> | null {
    if (!TERMINAL.has(run.status)) return null
    const live = this.applying.get(run.id)
    if (live) return live
    const info = this.info(run.id)
    const mode = info ? this.active(info.companyId) : null
    if (!info || !mode || (!info.taskId && !info.agentId)) {
      this.steps.delete(run.id)
      this.pre.delete(run.id)
      return null
    }
    // the claim: the first run.updated of a terminal run wins, a restart never applies twice
    const claimed = this.d.db.prepare("INSERT OR IGNORE INTO orch_run_reports(run_id, company_id, mode, source, created_at) VALUES (?,?,?,'pending',?)").run(run.id, info.companyId, mode, this.now().toISOString()).changes === 1
    if (!claimed) return null
    const p = this.apply(run, info, mode)
      .catch((e) => this.d.log?.warn('orchestrator: apply failed', { runId: run.id, error: String(e) }))
      .finally(() => {
        this.applying.delete(run.id)
        this.steps.delete(run.id)
        this.pre.delete(run.id)
      })
    this.applying.set(run.id, p)
    return p
  }

  private async apply(run: Pick<Run, 'id' | 'status'>, info: RunInfo, mode: 'shadow' | 'on'): Promise<void> {
    // only a run that ended by itself is acted on (a failed or stopped run's report may be half done)
    const cap = run.status === 'passed' ? this.capture(run.id) : null
    let report = cap?.report ?? null
    let source: RunReportSource = cap?.source ?? 'none'
    const s = this.settingsFor(info.companyId)
    // the fallback extractor reads task runs only: a reply run's answer is already its post, and a run that used
    // Principia's tools did its team work itself (neither is worth a call from the company's daily budget)
    const extractable = !!info.taskId && !!cap && !this.didMcp(run.id)
    if (!report && run.status === 'passed' && cap && extractable && s.extractFallback && this.d.extract && this.takeBudget(info.companyId, s.callsPerDay)) {
      try {
        report = await this.d.extract({ finalAnswer: cap.output, transcriptTail: this.logTail(run.id, cap.stepId) }, info.companyId)
        if (report) {
          report = this.clean(report)
          source = 'extracted'
        }
      } catch (e) {
        this.d.log?.warn('orchestrator: extraction failed', { runId: run.id, error: String(e) })
      }
    }
    const pre = this.pre.get(run.id)
    if (pre?.pending.length) await Promise.allSettled(pre.pending)
    const actions: OrchAction[] = [...(pre?.actions ?? [])]
    if (report) {
      const ctx: ActCtx = { runId: run.id, companyId: info.companyId, taskId: info.taskId, agentId: info.agentId, stepId: cap!.stepId, adapter: cap!.adapter, shadow: mode === 'shadow', extracted: source === 'extracted', preRan: !!pre, waits: !!pre?.actions.some((a) => a.kind === 'question' && (a.status === 'done' || a.status === 'skipped')), report }
      for (const a of this.act(ctx, pre?.asked ?? new Set())) actions.push(a)
    } else if (this.didMcp(run.id)) source = 'mcp'
    if (mode === 'on' && info.taskId) this.noteOnTask(info.taskId, actions)
    this.d.db
      .prepare('UPDATE orch_run_reports SET source=?, report_json=?, actions_json=?, applied_at=? WHERE run_id=?')
      .run(source, report ? JSON.stringify(report) : null, JSON.stringify(actions), this.now().toISOString(), run.id)
    if (actions.some((a) => a.status === 'done' || a.status === 'proposed')) {
      try {
        this.d.onChange?.(info.companyId)
      } catch {
        /* the UI refresh never fails an apply */
      }
    }
    this.d.log?.info('orchestrator: run applied', { runId: run.id, mode, source, actions: actions.length })
  }

  /** One Activity line on the task for what Principia did after its run (the Run view lists every action). */
  private noteOnTask(taskId: string, actions: OrchAction[]): void {
    const did = actions.filter((a) => a.status === 'done' || (a.status === 'proposed' && a.kind === 'follow_up'))
    if (!did.length) return
    try {
      this.d.company().activity(taskId, 'updated', clip(`Principia after this run: ${did.map((a) => a.detail.replace(/\.$/, '')).join('; ')}.`, 2000), 'system')
    } catch {
      /* the activity line is a courtesy */
    }
  }

  /**
   * The teammates this run asked over the Forum tools whose answer is still to come, or already sits in the task's
   * wake for its next turn. An answer the tool waited for (returned in the same turn) is not counted.
   */
  private openAgentAsks(runId: string, task: BoardTask): string[] {
    try {
      const forum = this.d.forum()
      if (!forum) return []
      const rows = this.d.db
        .prepare("SELECT to_member, message_seq, via, status FROM forum_agent_wakes WHERE from_run=? AND company_id=? AND to_agent IS NOT NULL AND via IN ('ask','mention') AND status IN ('queued','started','answered')")
        .all(runId, task.companyId) as { to_member: string; message_seq: number; via: string; status: string }[]
      const wake = (task.pendingWake?.reasons ?? []).join('\n')
      const out: string[] = []
      for (const row of rows) {
        let m: ReturnType<typeof forum.store.message>
        try {
          m = forum.store.message(row.message_seq)
        } catch {
          continue
        }
        if (m.companyId !== task.companyId) continue
        if (row.via === 'mention' && (m.kind === 'ask' || !m.text.includes('?'))) continue
        if (row.via === 'ask' && (m.kind !== 'ask' || m.ask?.taskId)) continue
        if (row.status === 'answered' && !wake.includes(`question ${m.ref} `)) continue
        const h = forum.store.member(row.to_member)?.handle
        if (h && !out.includes(`@${h}`)) out.push(`@${h}`)
      }
      return out
    } catch {
      return []
    }
  }

  /** The agent used Principia's tools itself in this run (a Forum post, a wake, a task report over MCP). */
  private didMcp(runId: string): boolean {
    try {
      if (this.d.forum()?.postsOfRun(runId, { own: true }).length) return true
      return !!this.d.db.prepare('SELECT 1 FROM forum_agent_wakes WHERE from_run=? LIMIT 1').get(runId)
    } catch {
      return false
    }
  }

  private act(x: ActCtx, preAsked: Set<number> = new Set()): OrchAction[] {
    const out: OrchAction[] = []
    const c = this.d.company()
    const forum = this.d.forum()
    let task: BoardTask | null = null
    try {
      task = x.taskId ? c.task(x.taskId) : null
    } catch {
      task = null
    }
    const r = x.report
    // the agent's own posts (the Forum's automatic post of the step's answer is not the agent's: shadow mode keeps it)
    const own = forum ? safe(() => forum.postsOfRun(x.runId, { own: true }), []) : []
    // 1. the update post (task runs; a reply run's answer is its own post)
    if (task && x.agentId) {
      if (x.extracted) out.push({ kind: 'post', status: 'skipped', detail: 'The step\'s answer was already posted for the team' })
      else if (own.some((m) => !m.threadId)) out.push({ kind: 'post', status: 'skipped', detail: 'The agent already posted its update in the Forum' })
      else if (!forum || !forum.enabled()) out.push({ kind: 'post', status: 'skipped', detail: 'The Forum is off' })
      // the only news is the wait: the question card in the Forum already says it (the board keeps the report)
      else if (r.outcome === 'blocked' && x.waits && !r.followUps.length && !r.answers.length) out.push({ kind: 'post', status: 'skipped', detail: `No update posted: ${task.identifier} only waits for the answer, and the question is already in the Forum` })
      else if (x.shadow) out.push({ kind: 'post', status: 'shadow', detail: `Would post ${task.identifier}'s update to the team` })
      // CHAT-UI.md §8: a task from a conversation that stopped for the founder: its agent asks there instead (one
      // message with what it found and the whole question, ForumService.followAsk), not an update and then a question
      else if (r.outcome === 'blocked' && waitsForAnswer(task) && safe(() => forum.conversationOfTask(task.id), null)) out.push({ kind: 'post', status: 'skipped', detail: `No update posted: ${task.identifier} waits for your answer, and its question goes to the conversation it came from` })
      // CHAT-UI.md §8: a task started from a conversation reports back there (the card's result already came back: skip)
      else if (safe(() => forum.resultPosted(task.id, x.runId), false)) out.push({ kind: 'post', status: 'skipped', detail: `${task.identifier}'s result is already in the conversation it came from` })
      else {
        const conv = safe(() => forum.conversationOfTask(task.id), null)
        const ev = r.evidence.slice(0, 3)
        // agents often name the task in their summary themselves: then it is not put in front again
        const named = new RegExp(`(^|[^A-Za-z0-9])${task.identifier.replace(/[-]/g, '\\-')}([^A-Za-z0-9]|$)`, 'i').test(r.summary)
        // in the conversation it reads as the agent talking to the person who asked; in a room, as a team update
        const head = conv && r.outcome === 'review' ? `${named ? 'Ready for your review' : `${task.identifier} is ready for your review`}. ${r.summary}` : named ? r.summary : `${task.identifier}: ${r.summary}`
        const text = `${head}${ev.length ? `\n${conv ? 'What I checked' : 'Evidence'}: ${ev.join('; ')}` : ''}`
        const m = safe(() => forum.postAsAgent({ companyId: x.companyId, agentId: x.agentId!, runId: x.runId, text, ...(conv ? { channelId: conv } : {}), opKey: `orch:${x.runId}:post` }), null)
        out.push(m ? { kind: 'post', status: 'done', detail: conv ? `Posted ${task.identifier}'s result in the conversation it came from` : `Posted ${task.identifier}'s update to the team`, ref: m.ref } : { kind: 'post', status: 'failed', detail: 'The update could not be posted' })
      }
    }
    // 2. follow-ups (the ones blocking the current task were filed before the sync)
    // a reply run (a person wrote to the agent in the Forum): its follow-up is that person's request, for this agent,
    // filed once per message (the agent may already have filed it with forum_reply's task field)
    const reply = !task && forum ? safe(() => forum.replyRunOf(x.runId), null) : null
    const filedFor = reply ? safe(() => forum!.taskFiledFor(reply.messageId), null) : null
    r.followUps.forEach((f, i) => {
      if (f.blocksCurrent && x.preRan) return
      if (filedFor) return void out.push({ kind: 'follow_up', status: 'skipped', detail: `"${clip(f.title, 120)}": the agent already filed the request as a task` })
      const a = this.followUp(x.runId, x.companyId, task, x.agentId, { ...f, blocksCurrent: false }, i, { shadow: x.shadow, extracted: x.extracted, blocks: false, reply })
      out.push(a)
      if (reply && a.status === 'done' && a.ref && forum) {
        const t = safe(() => this.d.company().listTasks(x.companyId).find((y) => y.identifier === a.ref) ?? null, null)
        const who = x.agentId ? safe(() => forum.store.memberForAgent(x.agentId!)?.name ?? 'The agent', 'The agent') : 'The agent'
        if (t) forum.noteFiledFromReply(reply.messageId, t, who)
      }
    })
    // 3. questions to teammates (founder questions went to the task's ask before the sync)
    r.questions.forEach((q, i) => {
      // founder questions: the task's ask (beforeSync), else an ask card for the founder (below); a blocking question
      // to a teammate went out before the sync
      if (this.isFounder(x.companyId, q.to) || preAsked.has(i)) return
      if (x.extracted) return void out.push({ kind: 'question', status: 'proposed', detail: `Maybe ask ${q.to}: ${clip(flat(q.question), 200)} (read from the run's answer, not sent)` })
      if (!x.agentId) return void out.push({ kind: 'question', status: 'skipped', detail: `No agent seat to ask ${q.to} from` })
      if (x.shadow) return void out.push({ kind: 'question', status: 'shadow', detail: `Would ask ${q.to}${q.blocking ? ' (waiting for the answer)' : ''}: ${clip(flat(q.question), 200)}` })
      const res = this.d.mailbox.send({ companyId: x.companyId, fromAgentId: x.agentId, fromRunId: x.runId, fromTaskId: task?.id ?? null, to: q.to, question: q.question, why: q.why, blocking: q.blocking, opKey: `orch:${x.runId}:q:${i}` })
      out.push(questionAction(q, res))
    })
    // 4. answers to teammates' questions
    for (const [i, a] of r.answers.entries()) out.push(this.answer(x, a, i, own))
    // 5. facts: proposals for the founder, never written
    if (r.facts.length) {
      if (x.shadow) out.push({ kind: 'fact', status: 'shadow', detail: `Would send ${r.facts.length} fact${r.facts.length === 1 ? '' : 's'} to you for review` })
      else {
        // a fact that held a password or key (scrubbed above) is never kept, not even as a proposal
        const secret = r.facts.filter((f) => REDACTED.test(f.text))
        const facts = r.facts.filter((f) => !secret.includes(f))
        if (secret.length) out.push({ kind: 'fact', status: 'skipped', detail: `Did not keep ${secret.length === 1 ? 'a fact' : `${secret.length} facts`} that held a password or key` })
        const res = !facts.length ? undefined : this.d.facts ? safe(() => this.d.facts!(x.companyId, { runId: x.runId, stepId: x.stepId, adapter: x.adapter }, facts), null) : null
        if (res === undefined) {
          /* nothing left to send */
        } else if (!res) out.push({ kind: 'fact', status: 'skipped', detail: 'Company memory is not on, so facts were not kept' })
        else if (!res.created.length) out.push({ kind: 'fact', status: 'skipped', detail: 'Those facts were already known or already suggested' })
        else out.push({ kind: 'fact', status: 'proposed', detail: `Sent ${res.created.length} fact${res.created.length === 1 ? '' : 's'} to you for review in Knowledge` })
      }
    }
    // 6. founder questions and blockers that did not become the task's ask (a reply run, an extracted report)
    if (!task || !x.preRan) for (const a of this.forFounder(x, task)) out.push(a)
    // 7. suggestions: kept for the chief of staff
    for (const sg of r.suggestions) out.push({ kind: 'suggestion', status: 'proposed', detail: `Idea: ${clip(flat(sg.text), 300)}`, ...(sg.kind === 'connection' && sg.connectionId ? { link: connectLink(sg.connectionId) } : {}) })
    // AUTOPILOT.md §6: the chief of staff turns it into a "Put … on autopilot?" offer (never turned on without a yes)
    if (r.recurring) out.push({ kind: 'suggestion', status: 'proposed', detail: `Keep it on autopilot${r.recurring.playbook ? ` (${clip(r.recurring.playbook, 40)})` : ''}: ${clip(flat(r.recurring.why), 300)}` })
    return out
  }

  /**
   * Founder questions and blockers of a run whose task did not take them as its ask: one ask card for the founder in the
   * Forum (posted for the agent, via Principia, in the thread it answered or its home channel), so it shows with the
   * founder's open asks. An extracted report's are only listed.
   */
  private forFounder(x: ActCtx, task: BoardTask | null): OrchAction[] {
    const r = x.report
    const qs = r.questions.filter((q) => this.isFounder(x.companyId, q.to))
    if (!qs.length && !r.blockers.length) return []
    const links = r.blockers.filter((b) => b.needs === 'connection' && b.connectionId).map((b) => connectLink(b.connectionId!))
    const lines = [
      ...qs.map((q) => `${flat(q.question)}${q.why ? ` (why: ${flat(q.why)})` : ''}`),
      ...r.blockers.map(blockerLine)
    ]
    const kind: OrchAction['kind'] = qs.length ? 'founder_question' : 'blocker'
    const list = (): OrchAction[] => [
      ...qs.map((q) => ({ kind: 'founder_question' as const, status: 'proposed' as const, detail: `Question for you: ${clip(flat(q.question), 300)}` })),
      ...r.blockers.map((b) => ({ kind: 'blocker' as const, status: 'proposed' as const, detail: `${NEEDS[b.needs]}: ${clip(flat(b.text), 300)}`, ...(b.needs === 'connection' && b.connectionId ? { link: connectLink(b.connectionId) } : {}) }))
    ]
    const forum = this.d.forum()
    if (x.extracted || !x.agentId || !forum || !forum.enabled()) return list()
    if (x.shadow) return [{ kind, status: 'shadow', detail: `Would ask you ${lines.length === 1 ? 'one thing' : `${lines.length} things`} in the Forum` }]
    try {
      const owner = forum.store.owner(x.companyId)
      const reply = forum.replyRunOf(x.runId)
      const text = `@${owner.handle} ${lines.join('\n')}${task ? `\n(${task.identifier})` : ''}`
      const m = forum.postAsAgent({ companyId: x.companyId, agentId: x.agentId, runId: x.runId, text, ...(reply ? { channelId: reply.channelId, threadId: reply.messageId } : {}), ask: { status: 'open', to: [owner.id], taskId: null, runId: x.runId }, opKey: `orch:${x.runId}:founder` })
      if (!m) return list()
      return [{ kind, status: 'done', detail: `Asked you ${lines.length === 1 ? 'one thing' : `${lines.length} things`} in the Forum (${m.ref})`, ref: m.ref, ...(links[0] ? { link: links[0] } : {}) }]
    } catch {
      return list()
    }
  }

  /** One follow-up task: backlog unless its agent is automatic and the company's autopilot is on (never from an extracted report). */
  private followUp(runId: string, companyId: string, task: BoardTask | null, fromAgentId: string | null, f: RunFollowUp, i: number, o: { shadow: boolean; extracted: boolean; blocks: boolean; reply?: { channelId: string; messageId: string } | null }): OrchAction {
    try {
      const c = this.d.company()
      const all = c.listTasks(companyId)
      const same = sameWork(all, f.title, runId)
      if (same) return { kind: 'follow_up', status: 'skipped', detail: `"${clip(f.title, 120)}" is already on the board as ${same.identifier}`, ref: same.identifier }
      // an extracted follow-up is a guess: its own id, so the chief of staff never pushes it as "Start …"
      const externalId = `${o.extracted ? 'xrun' : 'run'}:${runId}:${i}`
      const filed = all.find((t) => t.externalId === externalId)
      if (filed) return { kind: 'follow_up', status: 'skipped', detail: `Already filed as ${filed.identifier}`, ref: filed.identifier }
      const hourAgo = new Date(this.now().getTime() - HOUR).toISOString()
      const recent = all.filter((t) => t.source === 'agent' && /^x?run:/.test(t.externalId ?? '') && t.createdAt >= hourAgo).length
      if (recent >= FOLLOW_UP_CAP_PER_HOUR) return { kind: 'follow_up', status: 'skipped', detail: `Not filed: Principia already filed ${FOLLOW_UP_CAP_PER_HOUR} follow-ups in the last hour (${clip(f.title, 120)})` }
      const departments = c.departments.list(companyId)
      const agents = c.departments.listAgents({ companyId })
      // a teammate named by handle takes it (in its own department), when it is an active agent of this company
      const h = f.agentHandle?.replace(/^@/, '').toLowerCase()
      const member = h ? safe(() => this.d.forum()?.store.agentByName(companyId, f.agentHandle!) ?? null, null) : null
      // a person asked this agent in the Forum (a reply run): the work is the agent's own unless it named someone
      const self = o.reply && !h && !f.departmentKey && fromAgentId ? agents.find((a) => a.id === fromAgentId && !a.archivedAt) ?? null : null
      const mate = (member?.agentId ? agents.find((a) => a.id === member.agentId && !a.archivedAt) ?? null : null) ?? self
      const named = f.departmentKey ? departments.find((d) => d.key === f.departmentKey && !d.archivedAt) ?? null : null
      const seatDep = fromAgentId ? agents.find((a) => a.id === fromAgentId)?.departmentId ?? null : null
      const departmentId = mate?.departmentId ?? named?.id ?? task?.departmentId ?? seatDep ?? null
      const draft = { companyId, title: clip(f.title, 200), description: '', source: 'agent' as const, sourceUrl: null, status: 'todo' as const, departmentId, agentId: null }
      // a teammate named who is not in this company: routed by the board, never back to the agent who wanted someone else
      const missed = h && !member ? f.agentHandle!.trim() : null
      const pool = missed && fromAgentId ? agents.filter((a) => a.id !== fromAgentId) : agents
      const d = mate ? { departmentId: mate.departmentId, agentId: mate.id } : route(draft, { departments, agents: pool, queueCounts: queueCountsFrom(all), explicitBy: 'rule' })
      const agent = d.agentId ? agents.find((a) => a.id === d.agentId) ?? null : null
      const auto = !o.extracted && agent?.data.autonomy === 'auto' && c.boardSettings(companyId).autopilot
      // a person asked for it in the Forum: it is their yes, so it goes to To do (a manual agent's waits for Start there)
      const asked = !o.extracted && !!o.reply
      const status = auto || asked ? 'todo' : 'backlog'
      const where = `${agent ? agent.name : 'no agent yet'}${d.departmentId ? ` in ${departments.find((x) => x.id === d.departmentId)?.name ?? 'a department'}` : ''}`
      const why = auto ? 'it starts on its own' : asked ? `you asked for it in the Forum, so it waits in To do${agent ? ` for you to press Start` : ''}` : o.extracted ? 'read from the run\'s answer, so it waits in Backlog for you' : agent ? `${agent.name} works only when you start it, or Autopilot is off, so it waits in Backlog` : 'it waits in Backlog for you to assign'
      if (o.shadow) return { kind: 'follow_up', status: 'shadow', detail: `Would file "${clip(f.title, 120)}" for ${where} (${status === 'todo' ? 'To do' : 'Backlog'})` }
      const request = o.reply ? safe(() => this.d.forum()?.store.message(o.reply!.messageId) ?? null, null) : null
      const from = task ? `${task.identifier}'s run report` : request ? `a request in the Forum (${request.ref}): "${clip(flat(request.text), 600)}"` : 'a run report'
      const created = c.createTask({
        companyId,
        title: draft.title,
        description: clip(`${f.goal ? `${f.goal}\n\n` : ''}Filed by Principia from ${from}.`, 8000),
        repoId: task?.repoId ?? null,
        status,
        priority: 0,
        source: 'agent',
        sourceUrl: null,
        externalId,
        assigneeProfileId: null,
        parentId: task && !task.parentId && !task.plan ? task.id : null,
        dependencyIds: [],
        departmentId: d.departmentId,
        agentId: d.agentId ?? null
      })
      // the board's create routing may still pick the asker itself: the work was meant for someone else, so it waits
      // unassigned in its department for the founder to choose
      if (missed && fromAgentId && c.task(created.id).agentId === fromAgentId) {
        safe(() => c.assign(created.id, { agentId: null }, 'system', { by: 'rule', reason: `No teammate "${clip(missed, 60)}" in this company; waiting for you to assign` }), null)
      }
      if (o.blocks && task) this.addDependency(task, created.id)
      const note = missed ? ` (no teammate "${clip(missed, 60)}" in this company)` : ''
      return { kind: 'follow_up', status: o.extracted ? 'proposed' : 'done', detail: `Filed ${created.identifier} "${clip(f.title, 120)}" for ${where}${note}: ${why}${o.blocks && task ? `; ${task.identifier} waits for it` : ''}`, ref: created.identifier }
    } catch (e) {
      return { kind: 'follow_up', status: 'failed', detail: `Could not file "${clip(f.title, 120)}": ${clip(e instanceof Error ? e.message : String(e), 200)}` }
    }
  }

  /** The in-flight task gains a dependency (as task_create's blocksCurrent does; no CompanyStore method writes in flight). */
  private addDependency(t: BoardTask, depId: string): void {
    if (t.dependencyIds.includes(depId) || t.dependencyIds.length >= 100) return
    this.d.db
      .prepare("UPDATE company_tasks SET data=json_set(data,'$.dependencyIds',json(?),'$.updatedAt',?) WHERE id=? AND status='in_progress'")
      .run(JSON.stringify([...t.dependencyIds, depId]), this.now().toISOString(), t.id)
  }

  private answer(x: ActCtx, a: RunReport['answers'][number], i: number, own: { threadId: string | null }[]): OrchAction {
    const forum = this.d.forum()
    if (x.extracted || !x.agentId) return { kind: 'answer', status: 'skipped', detail: `Answer to ${a.ref} not sent` }
    if (!forum || !forum.enabled()) return { kind: 'answer', status: 'skipped', detail: 'The Forum is off' }
    try {
      const seq = parseInt(a.ref.slice(1), 36)
      const msg = forum.store.message(seq)
      const me = forum.store.memberForAgent(x.agentId)
      if (!me || msg.companyId !== x.companyId) return { kind: 'answer', status: 'failed', detail: `No question ${a.ref} for this agent` }
      if (own.some((m) => m.threadId === msg.id)) return { kind: 'answer', status: 'skipped', detail: `The agent already replied to ${a.ref} itself` }
      if (msg.kind !== 'ask' || !msg.ask) return { kind: 'answer', status: 'failed', detail: `${a.ref} is not a question` }
      if (msg.ask.status !== 'open') return { kind: 'answer', status: 'skipped', detail: `${a.ref} was already answered` }
      if (!msg.ask.to.includes(me.id)) return { kind: 'answer', status: 'failed', detail: `${a.ref} was asked to someone else` }
      if (x.shadow) return { kind: 'answer', status: 'shadow', detail: `Would answer ${a.ref}: ${clip(flat(a.text), 160)}` }
      const reply = forum.postAsAgent({ companyId: x.companyId, agentId: x.agentId, runId: x.runId, text: a.text, channelId: msg.channelId, threadId: msg.id, opKey: `orch:${x.runId}:a:${i}` })
      if (!reply) return { kind: 'answer', status: 'failed', detail: `Could not answer ${a.ref}` }
      forum.answer(msg.id, me.id, a.text, reply.id)
      return { kind: 'answer', status: 'done', detail: `Answered ${a.ref}: ${clip(flat(a.text), 160)}`, ref: reply.ref }
    } catch (e) {
      return { kind: 'answer', status: 'failed', detail: `Could not answer ${a.ref}: ${clip(e instanceof Error ? e.message : String(e), 160)}` }
    }
  }

  // ---------- budget, logs, views ----------

  /** One cheap model call of the company's daily budget (callsPerDay), or false when it is used up. */
  takeBudget(companyId: string, perDay: number): boolean {
    if (perDay <= 0) return false
    const day = this.now().toISOString().slice(0, 10)
    return this.d.db.transaction(() => {
      const row = this.d.db.prepare('SELECT calls FROM orch_budget WHERE company_id=? AND day=?').get(companyId, day) as { calls: number } | undefined
      if ((row?.calls ?? 0) >= perDay) return false
      this.d.db.prepare('INSERT INTO orch_budget(company_id, day, calls) VALUES (?,?,1) ON CONFLICT(company_id, day) DO UPDATE SET calls=calls+1').run(companyId, day)
      return true
    })()
  }

  /** The end of a step's (redacted) log, for the extractor. */
  private logTail(runId: string, stepId: string): string {
    try {
      const row = this.d.db.prepare('SELECT log_path FROM run_steps WHERE id=? AND run_id=?').get(stepId, runId) as { log_path: string | null } | undefined
      if (!row?.log_path) return ''
      const st = fs.statSync(row.log_path)
      const fd = fs.openSync(row.log_path, 'r')
      try {
        const len = Math.min(st.size, OUTPUT_TAIL)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, st.size - len)
        return buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return ''
    }
  }

  /** The Run view's "Principia after this run", or null (nothing recorded for this run). */
  forRun(runId: string): RunOrchestration | null {
    const row = this.d.db.prepare('SELECT * FROM orch_run_reports WHERE run_id=?').get(runId) as
      | { run_id: string; company_id: string; mode: string; source: string; report_json: string | null; actions_json: string; created_at: string; applied_at: string | null }
      | undefined
    if (!row) return null
    let report: RunReport | null = null
    let actions: OrchAction[] = []
    try {
      report = row.report_json ? (JSON.parse(row.report_json) as RunReport) : null
      actions = JSON.parse(row.actions_json) as OrchAction[]
    } catch {
      /* a broken row shows as empty */
    }
    return {
      runId: row.run_id,
      companyId: row.company_id,
      mode: row.mode === 'shadow' ? 'shadow' : 'on',
      source: (row.source === 'pending' ? 'none' : row.source) as RunReportSource,
      summary: report?.summary ?? null,
      actions,
      createdAt: row.created_at,
      appliedAt: row.applied_at
    }
  }
}

interface ActCtx {
  runId: string
  companyId: string
  taskId: string | null
  agentId: string | null
  stepId: string
  adapter: StepOutputEvent['adapter']
  shadow: boolean
  extracted: boolean
  /** beforeSync handled the blocking follow-ups, the handoff and the founder's questions */
  preRan: boolean
  /** a blocking question to a teammate went out (or was already out) before the sync */
  waits: boolean
  report: RunReport
}

/** What became of one question to a teammate, for the Run view. */
function questionAction(q: RunReport['questions'][number], res: { status: 'sent' | 'refused' | 'skipped'; detail: string; ref?: string }): OrchAction {
  return { kind: 'question', status: res.status === 'sent' ? 'done' : res.status === 'skipped' ? 'skipped' : 'failed', detail: res.status === 'sent' ? `${q.blocking ? 'Asked (waiting for the answer)' : 'Asked'}: ${res.detail}` : `Not asked: ${res.detail}`, ...(res.ref ? { ref: res.ref } : {}) }
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f()
  } catch {
    return fallback
  }
}
