/**
 * Runs, asks and the dispatcher (CLOUD.md §9, §10). Every source (POST runs, schedules, answers) becomes a queued
 * cloud_runs row after the pause and quota checks. The dispatcher starts the oldest queued runs while
 * maxConcurrentRuns allows, never two runs on one ChatGPT sign-in (codex_auth_json) at once, builds RunMaterials
 * (decrypted in memory only) and calls runtime.startRun. It also implements ControlPorts for the runtime.
 */
import { z } from 'zod'
import {
  CLOUD_ADAPTERS, CLOUD_LIMITS,
  type CloudAdapter, type CloudAsk, type CloudRunDetail, type CloudRunStatus, type CloudRunStep, type CloudRunSummary, type CloudRunTrigger, type StartRunRequest
} from '../../shared/cloud'
import type { ControlPorts, ProviderMaterial, RuntimeRunRequest } from '../contract'
import { SYSTEM, type Actor, type Ctx } from './context'
import type { Companies } from './companies'
import type { Connections } from './connections'
import { newId } from './db'
import { ADAPTER_ACTION, ADAPTER_LABEL, type WorkflowDeps } from './deps'
import { ApiError, badRequest, notFound } from './http'
import { credentialRow, credentialStatus, type Providers } from './providers'
import { SYNC_PAGE, encodeCursor, type Sync } from './sync'

const DAY_MS = 86_400_000
/** log lines kept per run in control.db (the run sheet shows a tail of 200) */
const RUN_LOG_KEEP = 2_000
const TERMINAL = new Set<CloudRunStatus>(['passed', 'failed', 'canceled', 'needs_input'])

export interface RunRow {
  id: string; company_id: string; kind: string; title: string; status: CloudRunStatus; trigger: CloudRunTrigger; adapters: string; target: string
  untrusted: string; created_at: string; started_at: string | null; ended_at: string | null; summary: string | null; schedule_id: string | null
  slot: string | null; credential_lock: string | null; seq: number
}
interface AskRow { id: string; company_id: string; run_id: string | null; agent_name: string | null; question: string; options: string; created_at: string; status: string; answer: string | null; origin: string; seq: number }

const startSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow'), workflowId: z.string().min(1).max(128), inputs: z.record(z.string().max(64), z.string().max(8000)).refine(r => Object.keys(r).length <= 50).optional() }),
  z.object({ kind: z.literal('prompt'), adapter: z.enum(CLOUD_ADAPTERS), prompt: z.string().min(1).max(CLOUD_LIMITS.promptChars), repoId: z.string().max(128).nullable().optional() })
])

export const runView = (r: RunRow): CloudRunSummary => ({
  id: r.id, companyId: r.company_id, kind: r.kind as 'workflow' | 'prompt', title: r.title, status: r.status, trigger: r.trigger,
  adapters: JSON.parse(r.adapters), createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at, summary: r.summary
})
export const askView = (a: AskRow): CloudAsk => ({
  id: a.id, companyId: a.company_id, runId: a.run_id, agentName: a.agent_name, question: a.question, options: JSON.parse(a.options),
  createdAt: a.created_at, status: a.status as CloudAsk['status'], answer: a.answer
})
const minutes = (r: Pick<RunRow, 'started_at' | 'ended_at'>, now: Date): number =>
  r.started_at ? Math.max(0, ((r.ended_at ? Date.parse(r.ended_at) : now.getTime()) - Date.parse(r.started_at)) / 60_000) : 0

export interface QueueDeps { providers: Providers; companies: Companies; connections: Connections; sync: Sync }

export function createQueue(ctx: Ctx, deps: QueueDeps) {
  const runRow = (id: string) => ctx.db.get<RunRow>('SELECT * FROM cloud_runs WHERE id = ?', id)
  const askRow = (id: string) => ctx.db.get<AskRow>('SELECT * FROM asks WHERE id = ?', id)
  const emitRun = (id: string) => { const r = runRow(id); if (r) ctx.events.emit({ kind: 'run', run: runView(r) }) }
  const emitAsk = (id: string) => { const a = askRow(id); if (a) ctx.events.emit({ kind: 'ask', ask: askView(a) }) }

  // ---------- quotas ----------
  function runsLast24h(cid: string): number {
    return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cloud_runs WHERE company_id = ? AND created_at > ?', cid, new Date(ctx.now().getTime() - DAY_MS).toISOString())!.n
  }
  function minutesLast24h(cid: string): number {
    const now = ctx.now()
    const since = new Date(now.getTime() - DAY_MS).toISOString()
    return ctx.db.all<RunRow>('SELECT started_at, ended_at FROM cloud_runs WHERE company_id = ? AND started_at IS NOT NULL AND (ended_at IS NULL OR ended_at > ?)', cid, since)
      .reduce((sum, r) => sum + minutes({ started_at: r.started_at! < since ? since : r.started_at, ended_at: r.ended_at }, now), 0)
  }
  function monthUsd(cid: string): number {
    const n = ctx.now()
    const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString()
    return ctx.db.all<{ usd: string | null }>('SELECT usd FROM usage WHERE company_id = ? AND at >= ? AND usd IS NOT NULL', cid, start).reduce((s, r) => s + Number(r.usd ?? 0), 0)
  }
  /** API spend cap reached: pause the company, open one ask, and refuse */
  function spendCapHit(cid: string): boolean {
    const cap = ctx.quotas().monthlyApiUsdPerCompany
    if (cap === null || monthUsd(cid) < cap) return false
    const c = deps.companies.row(cid)
    if (c && !c.paused) {
      ctx.db.run('UPDATE companies SET paused = 1, updated_at = ? WHERE id = ?', ctx.now().toISOString(), cid)
      ctx.audit(SYSTEM, 'company.pause.spend_cap', cid, cid, { capUsd: cap })
      void cancelCompanyRuns(cid, 'API spend cap reached')
      insertAsk({ companyId: cid, runId: null, agentName: 'Principia Cloud', question: `${c.name} reached its API spend cap of $${cap} this month, so its cloud agents are paused. Resume works once the cap is raised; until then the next run pauses them again.`, options: ['Resume', 'Keep paused'] }, 'spend_cap')
      ctx.runtime.triggers.reloadSchedules()
    }
    return true
  }

  // ---------- enqueue ----------
  function enqueue(actor: Actor, r: { companyId: string; trigger: CloudRunTrigger; target: StartRunRequest; untrustedInputs?: string[]; scheduleId?: string; slot?: string }): { runId: string | null; refused: string | null; error: ApiError | null } {
    const refuse = (e: ApiError) => {
      ctx.audit(actor, 'run.refused', r.companyId, r.scheduleId ?? null, { trigger: r.trigger, reason: e.message })
      return { runId: null, refused: e.message, error: e }
    }
    const c = deps.companies.row(r.companyId)
    if (!c) return refuse(notFound('No such company in this cloud.'))
    if (ctx.workspace().paused) return refuse(new ApiError('paused', 'The cloud is paused. Resume it to run agents.'))
    if (c.paused) return refuse(new ApiError('paused', `${c.name} is paused in the cloud.`))
    const q = ctx.quotas()
    if (runsLast24h(c.id) >= q.maxRunsPerDay) return refuse(new ApiError('quota_exceeded', `${c.name} reached ${q.maxRunsPerDay} runs in 24 hours.`))
    if (minutesLast24h(c.id) >= q.maxRunMinutesPerDay) return refuse(new ApiError('quota_exceeded', `${c.name} used its ${q.maxRunMinutesPerDay} run minutes for the last 24 hours.`))
    if (spendCapHit(c.id)) return refuse(new ApiError('quota_exceeded', `${c.name} reached its API spend cap for this month.`))
    let title: string
    let adapters: CloudAdapter[]
    const t = r.target
    if (t.kind === 'workflow') {
      const wf = deps.sync.workflowRow(c.id, t.workflowId)
      if (!wf) return refuse(notFound('That workflow is not in the cloud for this company.'))
      title = wf.name
      adapters = (JSON.parse(wf.deps) as WorkflowDeps).adapters
    } else {
      if (t.repoId && !deps.companies.repoMaterials(c.id).some(x => x.id === t.repoId)) return refuse(notFound('That repo is not in the cloud for this company.'))
      title = t.prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
      adapters = [t.adapter]
    }
    if (r.scheduleId && r.slot && !deps.sync.claimSlot(r.scheduleId, r.slot)) return { runId: null, refused: 'This schedule slot already fired.', error: new ApiError('conflict', 'This schedule slot already fired.') }
    const id = newId('crun_')
    ctx.db.run(`INSERT INTO cloud_runs (id, workspace_id, company_id, kind, title, status, trigger, adapters, target, untrusted, created_at, schedule_id, slot, seq)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ctx.workspaceId, c.id, t.kind, ctx.redact(title), r.trigger, JSON.stringify(adapters), JSON.stringify(t), JSON.stringify(r.untrustedInputs ?? []), ctx.now().toISOString(), r.scheduleId ?? null, r.slot ?? null, ctx.db.nextSeq())
    if (r.scheduleId && r.slot) deps.sync.markFired(r.scheduleId, r.slot, id)
    ctx.audit(actor, 'run.queue', c.id, id, { trigger: r.trigger, kind: t.kind })
    emitRun(id)
    kick()
    return { runId: id, refused: null, error: null }
  }

  // ---------- dispatcher ----------
  let dispatching = false
  let again = false
  let stopped = false
  function kick(): void { if (!stopped) void dispatch().catch(e => ctx.log.error('dispatcher failed', { error: (e as Error).message })) }

  async function dispatch(): Promise<void> {
    if (stopped) return
    if (dispatching) { again = true; return }
    dispatching = true
    try {
      do {
        again = false
        if (stopped || ctx.workspace().paused) return
        const cap = ctx.quotas().maxConcurrentRuns
        let running = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cloud_runs WHERE status = 'running'")!.n
        const locks = new Set(ctx.db.all<{ credential_lock: string }>("SELECT credential_lock FROM cloud_runs WHERE status = 'running' AND credential_lock IS NOT NULL").map(r => r.credential_lock))
        const waitingMinutes = new Map<string, boolean>()
        for (const r of ctx.db.all<RunRow>("SELECT * FROM cloud_runs WHERE status = 'queued' ORDER BY created_at, id")) {
          if (stopped || running >= cap) break
          const c = deps.companies.row(r.company_id)
          if (!c || c.paused) continue
          if (!waitingMinutes.has(c.id)) waitingMinutes.set(c.id, minutesLast24h(c.id) >= ctx.quotas().maxRunMinutesPerDay)
          if (waitingMinutes.get(c.id)) continue
          const adapters = JSON.parse(r.adapters) as CloudAdapter[]
          const codex = adapters.includes('codex') ? deps.providers.material('codex', false) : null
          const lock = codex?.kind === 'codex_auth_json' ? codex.credentialId : null
          if (lock && locks.has(lock)) continue
          // reserve the slot synchronously, then build materials
          if (!ctx.db.run("UPDATE cloud_runs SET status = 'running', started_at = ?, credential_lock = ?, seq = ? WHERE id = ? AND status = 'queued'", ctx.now().toISOString(), lock, ctx.db.nextSeq(), r.id)) continue
          running++
          if (lock) locks.add(lock)
          emitRun(r.id)
          await start(r.id, c.name)
        }
      } while (again)
    } finally { dispatching = false }
  }

  async function start(runId: string, companyName: string): Promise<void> {
    const r = runRow(runId)!
    const fail = (summary: string) => ports.runStatus(runId, 'failed', summary)
    try {
      const adapters = JSON.parse(r.adapters) as CloudAdapter[]
      const providers: ProviderMaterial[] = []
      for (const a of adapters) {
        if (credentialStatus(credentialRow(ctx, a), ctx.now()) === 'expired') return fail(`Your ${ADAPTER_LABEL[a]} sign-in expired. ${ADAPTER_ACTION[a]}`)
        const m = deps.providers.material(a)
        if (!m) return fail(`${r.title} uses ${ADAPTER_LABEL[a]}. ${ADAPTER_ACTION[a]}`)
        providers.push(m)
      }
      const target = JSON.parse(r.target) as StartRunRequest
      const wf = target.kind === 'workflow' ? deps.sync.workflowRow(r.company_id, target.workflowId) : null
      if (target.kind === 'workflow' && !wf) return fail('The workflow was removed from the cloud.')
      const conns = await deps.connections.materials(r.company_id)
      for (const id of conns.skipped) ctx.log.warn('connection skipped: needs sign-in', { runId, companyId: r.company_id, connection: id })
      const req: RuntimeRunRequest = {
        runId, workspaceId: ctx.workspaceId, companyId: r.company_id, companyName, trigger: r.trigger, target,
        workflowFile: wf ? JSON.parse(wf.file) : null,
        timeoutMs: ctx.quotas().runTimeoutMinutes * 60_000,
        untrustedInputs: JSON.parse(r.untrusted),
        materials: { providers, repos: deps.companies.repoMaterials(r.company_id), connections: conns.materials, passport: deps.companies.passportMaterial(r.company_id), secrets: deps.companies.secretMaterials(r.company_id) }
      }
      if (stopped || runRow(runId)?.status !== 'running') return // canceled (or shutting down) while materials were built
      ctx.runtime.startRun(req)
      ctx.audit(SYSTEM, 'run.start', r.company_id, runId, { trigger: r.trigger })
    } catch (e) {
      ctx.log.error('run dispatch failed', { runId, error: (e as Error).message })
      fail('The cloud could not start this run.')
    }
  }

  // ---------- cancel and pause ----------
  async function cancel(actor: Actor, runId: string, reason = 'Canceled'): Promise<CloudRunSummary> {
    const r = runRow(runId)
    if (!r) throw notFound('No such run.')
    if (r.status === 'queued') ports.runStatus(runId, 'canceled', reason)
    else if (r.status === 'running') {
      try { await ctx.runtime.cancelRun(runId) } catch (e) { ctx.log.warn('runtime.cancelRun failed', { runId, error: (e as Error).message }) }
      if (runRow(runId)?.status === 'running') ports.runStatus(runId, 'canceled', reason)
    }
    ctx.audit(actor, 'run.cancel', r.company_id, runId, { reason })
    return runView(runRow(runId)!)
  }
  async function cancelWhere(where: string, params: string[], reason: string): Promise<void> {
    for (const r of ctx.db.all<RunRow>(`SELECT * FROM cloud_runs WHERE status IN ('queued', 'running') ${where}`, ...params)) await cancel(SYSTEM, r.id, reason)
  }
  const cancelCompanyRuns = (cid: string, reason: string) => cancelWhere('AND company_id = ?', [cid], reason)

  async function setPaused(actor: Actor, paused: boolean): Promise<void> {
    ctx.db.run('UPDATE workspace SET paused = ? WHERE id = ?', paused ? 1 : 0, ctx.workspaceId)
    ctx.audit(actor, paused ? 'workspace.pause' : 'workspace.resume', null, ctx.workspaceId, {})
    if (paused) await cancelWhere('', [], 'Cloud paused')
    ctx.runtime.triggers.reloadSchedules()
    ctx.events.emit({ kind: 'workspace', workspace: ctx.workspace() })
    if (!paused) kick()
  }

  // ---------- asks ----------
  function insertAsk(a: Omit<CloudAsk, 'id' | 'status' | 'answer' | 'createdAt'>, origin = 'agent'): string {
    const id = newId('cask_')
    const options = (Array.isArray(a.options) ? a.options : []).slice(0, 10).map(o => ctx.redact(String(o)).slice(0, 200))
    ctx.db.run('INSERT INTO asks (id, company_id, run_id, agent_name, question, options, created_at, status, origin, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, a.companyId, a.runId, a.agentName ? a.agentName.slice(0, 120) : null, ctx.redact(a.question).slice(0, 4000), JSON.stringify(options), ctx.now().toISOString(), 'open', origin, ctx.db.nextSeq())
    emitAsk(id)
    return id
  }

  async function answer(actor: Actor, askId: string, body: unknown): Promise<CloudAsk> {
    const text = typeof (body as { answer?: unknown })?.answer === 'string' ? ((body as { answer: string }).answer).trim() : ''
    if (!text || text.length > CLOUD_LIMITS.forumTextChars) throw badRequest('Write an answer (8,000 characters at most).')
    const a = askRow(askId)
    if (!a) throw notFound('No such question.')
    if (a.status !== 'open') throw new ApiError('conflict', 'This question was already answered.')
    if (!ctx.db.run("UPDATE asks SET status = 'answered', answer = ?, answered_at = ?, seq = ? WHERE id = ? AND status = 'open'", text, ctx.now().toISOString(), ctx.db.nextSeq(), askId)) throw new ApiError('conflict', 'This question was already answered.')
    ctx.audit(actor, 'ask.answer', a.company_id, askId, {})
    if (a.origin === 'spend_cap') {
      if (/^resume/i.test(text)) { ctx.db.run('UPDATE companies SET paused = 0 WHERE id = ?', a.company_id); ctx.audit(actor, 'company.resume', a.company_id, a.company_id, {}); ctx.runtime.triggers.reloadSchedules(); kick() }
    } else {
      try { await ctx.runtime.answerAsk(askId, text) } catch (e) {
        ctx.db.run("UPDATE asks SET status = 'open', answer = NULL, answered_at = NULL, seq = ? WHERE id = ?", ctx.db.nextSeq(), askId)
        ctx.log.error('runtime.answerAsk failed', { askId, error: (e as Error).message })
        throw new ApiError('unavailable', 'The agent could not take the answer right now. Try again.')
      }
    }
    emitAsk(askId)
    return askView(askRow(askId)!)
  }

  // ---------- ports ----------
  const ports: ControlPorts = {
    runStatus(runId, status, summary) {
      const r = runRow(runId)
      if (!r || TERMINAL.has(r.status)) return
      const now = ctx.now().toISOString()
      const clean = summary === null ? r.summary : ctx.redact(summary).replace(/\s+/g, ' ').slice(0, 500)
      const ending = TERMINAL.has(status)
      ctx.db.run('UPDATE cloud_runs SET status = ?, summary = ?, started_at = COALESCE(started_at, ?), ended_at = ?, seq = ? WHERE id = ?',
        status, clean, status === 'running' ? now : null, ending ? now : null, ctx.db.nextSeq(), runId)
      if (ending) {
        const done = runRow(runId)!
        const mins = minutes(done, ctx.now())
        if (done.started_at) ctx.billing.record({ workspaceId: ctx.workspaceId, metric: 'run_minutes', quantity: Math.round(mins * 100) / 100, at: now })
        ctx.audit(SYSTEM, `run.${status}`, r.company_id, runId, { minutes: Math.round(mins * 10) / 10 })
      }
      emitRun(runId)
      if (ending) kick()
    },
    runStep(runId, step: CloudRunStep) {
      if (!runRow(runId)) return
      ctx.db.run('INSERT INTO run_steps (run_id, id, snapshot, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (run_id, id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at',
        runId, step.id, ctx.redact(JSON.stringify(step)), ctx.now().toISOString())
      ctx.events.emit({ kind: 'step', runId, step: JSON.parse(ctx.redact(JSON.stringify(step))) })
    },
    runLog(runId, stepId, lines) {
      const clean = lines.slice(-500).map(l => ctx.redact(l))
      ctx.events.emit({ kind: 'log', runId, stepId, lines: clean })
      if (!runRow(runId) || !clean.length) return
      // kept so a finished run shows what it did (CLOUD.md §9): the newest RUN_LOG_KEEP lines per run
      ctx.db.tx(() => {
        let n = ctx.db.get<{ n: number | null }>('SELECT MAX(n) AS n FROM run_logs WHERE run_id = ?', runId)?.n ?? 0
        for (const line of clean) ctx.db.run('INSERT INTO run_logs (run_id, n, step_id, line) VALUES (?, ?, ?, ?)', runId, ++n, String(stepId).slice(0, 128), line.slice(0, 4000))
        ctx.db.run('DELETE FROM run_logs WHERE run_id = ? AND n <= ?', runId, n - RUN_LOG_KEEP)
      })
    },
    usage(e) {
      const usd = typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd >= 0 ? String(e.usd) : null
      const tokens = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0)
      ctx.db.run('INSERT INTO usage (id, run_id, company_id, adapter, input_tokens, output_tokens, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId('use_'), e.runId, e.companyId, e.adapter, tokens(e.inputTokens), tokens(e.outputTokens), usd, ctx.now().toISOString())
      spendCapHit(e.companyId)
    },
    openAsk: a => insertAsk(a),
    requestRun(r) {
      const actor: Actor = r.trigger === 'schedule' ? { kind: 'schedule', id: r.scheduleId ?? null, name: null } : r.trigger === 'webhook' ? { kind: 'webhook', id: null, name: null } : SYSTEM
      const out = enqueue(actor, r)
      return { runId: out.runId, refused: out.refused }
    },
    cloudSchedules: () => deps.sync.cloudSchedules(),
    markScheduleFired: (scheduleId, slot, runId) => deps.sync.markFired(scheduleId, slot, runId),
    saveProviderCredential: c => deps.providers.save(c),
    providerStatus: c => deps.providers.status(c),
    forumEvent: (companyId, channelId, messageId) => ctx.events.emit({ kind: 'forum', companyId, channelId, messageId }),
    audit: (action, companyId, detail) => ctx.audit({ kind: 'system', id: null, name: 'runtime' }, action, companyId, null, detail),
    knownSecrets: () => ctx.vault.knownSecrets(),
    log: { info: (m, meta) => ctx.log.info(m, meta), warn: (m, meta) => ctx.log.warn(m, meta), error: (m, meta) => ctx.log.error(m, meta) }
  }

  return {
    ports,
    kick,
    dispatch,
    /** no more dispatching (shutdown) */
    stop(): void { stopped = true },
    cancel,
    cancelCompanyRuns,
    setPaused,
    answer,
    async startFromApi(actor: Actor, cid: string, body: unknown, trigger: CloudRunTrigger): Promise<CloudRunSummary> {
      deps.companies.must(cid)
      const p = startSchema.safeParse(body)
      if (!p.success) throw badRequest(`Invalid run: ${p.error.issues[0]?.path.join('.') || 'body'} ${p.error.issues[0]?.message ?? ''}`.trim())
      const out = enqueue(actor, { companyId: cid, trigger, target: p.data as StartRunRequest })
      if (out.error) throw out.error
      return runView(runRow(out.runId!)!)
    },
    list(q: { companyId?: string | null; status?: string | null; limit: number }): CloudRunSummary[] {
      const where: string[] = []; const params: string[] = []
      if (q.companyId) { where.push('company_id = ?'); params.push(q.companyId) }
      if (q.status) { where.push('status = ?'); params.push(q.status) }
      return ctx.db.all<RunRow>(`SELECT * FROM cloud_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, q.limit).map(runView)
    },
    detail(id: string): CloudRunDetail {
      const r = runRow(id)
      if (!r) throw notFound('No such run.')
      let extra: ReturnType<typeof ctx.runtime.runDetail> = null
      try { extra = ctx.runtime.runDetail(id) } catch { extra = null }
      const stored = ctx.db.all<{ snapshot: string }>('SELECT snapshot FROM run_steps WHERE run_id = ? ORDER BY updated_at, id', id).map(s => JSON.parse(s.snapshot) as CloudRunStep)
      const detail: CloudRunDetail = { ...runView(r), steps: extra?.steps?.length ? extra.steps : stored, artifacts: extra?.artifacts ?? [], ...(extra?.forumPosts ? { forumPosts: extra.forumPosts } : {}) }
      return JSON.parse(ctx.redact(JSON.stringify(detail))) as CloudRunDetail
    },
    log(id: string, step: string | null, tail: number): { lines: string[] } {
      if (!runRow(id)) throw notFound('No such run.')
      const n = Math.min(Math.max(1, tail), CLOUD_LIMITS.logTailLines)
      let lines: string[] = []
      try { lines = ctx.runtime.runLog(id, step, n) } catch { lines = [] }
      // the runtime keeps no file for this run (or it was swept): what it streamed is still the proof of work
      if (!lines.length) {
        lines = (step
          ? ctx.db.all<{ line: string }>('SELECT line FROM run_logs WHERE run_id = ? AND step_id = ? ORDER BY n DESC LIMIT ?', id, step, n)
          : ctx.db.all<{ line: string }>('SELECT line FROM run_logs WHERE run_id = ? ORDER BY n DESC LIMIT ?', id, n)).map(r => r.line).reverse()
      }
      return { lines: lines.map(l => ctx.redact(l)) }
    },
    asks(status: string | null, companyId: string | null): CloudAsk[] {
      const where: string[] = []; const params: string[] = []
      if (status && status !== 'all') { where.push('status = ?'); params.push(status) }
      if (companyId) { where.push('company_id = ?'); params.push(companyId) }
      return ctx.db.all<AskRow>(`SELECT * FROM asks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`, ...params).map(askView)
    },
    /**
     * GET /v1/sync/changes. Every collection is read up to one shared seq, and each returns at most SYNC_PAGE rows:
     * when one is cut short, the cursor stops at its last row (rows past it in the others come again next time) and
     * `more` says to ask again at once, so no change is ever skipped. A first sync (no cursor) is a snapshot: the
     * latest 100 runs and the open asks, never paged.
     */
    async changes(since: number) {
      await deps.companies.refreshAll()
      let upto = ctx.db.currentSeq()
      let more = false
      const paged = <T>(rows: T[], seq: (r: T) => number): T[] => {
        if (rows.length >= SYNC_PAGE) {
          upto = Math.min(upto, seq(rows[rows.length - 1]))
          more = true
        }
        return rows
      }
      const head = upto
      const runRows = since
        ? paged(ctx.db.all<RunRow>('SELECT * FROM cloud_runs WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?', since, head, SYNC_PAGE), r => r.seq)
        : ctx.db.all<RunRow>('SELECT * FROM cloud_runs WHERE seq <= ? ORDER BY seq DESC LIMIT 100', head)
      const askRows = since
        ? paged(ctx.db.all<AskRow>('SELECT * FROM asks WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?', since, head, SYNC_PAGE), r => r.seq)
        : ctx.db.all<AskRow>("SELECT * FROM asks WHERE seq <= ? AND status = 'open' ORDER BY seq", head)
      const schedules = paged(deps.sync.changedSchedules(since, head, SYNC_PAGE), r => r.seq)
      const upTo = <T extends { seq: number }>(rows: T[]): T[] => (since ? rows.filter(r => r.seq <= upto) : rows)
      return {
        cursor: encodeCursor(upto),
        runs: upTo(runRows).map(runView),
        asks: upTo(askRows).map(askView),
        passports: deps.companies.passportChanges(since, upto),
        schedules: schedules.filter(r => r.seq <= upto).map(r => r.schedule),
        more
      }
    },
    /** at boot: runs the previous process left running cannot be resumed */
    recover(): void {
      for (const r of ctx.db.all<RunRow>("SELECT * FROM cloud_runs WHERE status = 'running'")) ports.runStatus(r.id, 'failed', 'Interrupted by a cloud restart.')
    },
    minutesLast24h,
    runsLast24h
  }
}
export type Queue = ReturnType<typeof createQueue>
