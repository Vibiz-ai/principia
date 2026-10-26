/**
 * Test world for ORCHESTRATOR.md: the real board (hive.db, HookedCompanyStore, Dispatcher, TaskTools behind the
 * AuthorBroker), the real Forum (ForumService + ForumResponder) and Principia's layer (Mailbox + RunApplier), wired the
 * way main wires them, over a fake engine. Each seat's script plays one step on its harness and returns the step's
 * final answer (and may write its report file); the world then runs the step hooks and the run end in Hive's order:
 * stepOutputHooks (Forum harvest, then the applier), then runHooks (the board's syncRun, wrapped by the handoff and the
 * applier's beforeSync; the dispatcher; the responder; the applier's afterRun).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, type DB } from '../../db'
import { Store } from '../../db/store'
import { AuthorBroker, type BrokerDeps } from '../../author/broker'
import { AuthorDrafts } from '../../author/drafts'
import { Dispatcher, HookedCompanyStore } from '../../company/dispatcher'
import { TaskTools, type TaskCaller, type TaskTool } from '../../company/taskTools'
import { ForumService } from '../../forum/service'
import { ForumResponder } from '../../forum/responder'
import { resolvePersonas } from '../../../shared/personas'
import type { BoardTask, CompanyAgent, CompanyTaskInput, Department } from '../../../shared/company'
import type { LiveOwner, StartRunOptions, StepOutputEvent } from '../../../shared/engine'
import type { AdapterId, Run, RunTarget } from '../../../shared/types'
import type { OrchestratorSettings, RunReport } from '../../../shared/orchestrator'
import type { AgentCollabSettings } from '../../../shared/collab'
import { runReportPath } from '../../engine/env'
import { Mailbox } from '../mailbox'
import { RunApplier, type ApplyDeps } from '../apply'
import { ContextReader, buildRunContext } from '../context'
import { Coordinator, type CoordinatorDeps } from '../coordinator'
import { Suggestions } from '../suggestions'

export const flush = () => new Promise((r) => setTimeout(r, 0))
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await flush()
}

export interface Turn {
  run: Run
  kind: 'task' | 'reply'
  agentId: string
  taskId: string | null
  prompt: string
  /** the Principia block the engine would have appended (stepContext) */
  context: string | null
  owner: { runId: string; stepId: string }
}
export interface StepResult {
  output: string
  status?: 'passed' | 'failed' | 'canceled'
  /** the step writes this to its $PRINCIPIA_RUN_REPORT file */
  file?: unknown
}
export type Script = (t: Turn, w: OrchWorld) => Promise<StepResult> | StepResult

export const report = (r: Partial<RunReport> & Pick<RunReport, 'outcome' | 'summary'>) => `Done.\n\n\`\`\`principia-run-report\n${JSON.stringify({ v: 1, ...r })}\n\`\`\`\n`

export class OrchWorld {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'principia-orch-'))
  readonly runLogs = path.join(this.dir, 'run-logs')
  readonly db: DB = openDatabase(path.join(this.dir, 'test.db'))
  readonly store = new Store(this.db)
  readonly c = new HookedCompanyStore(this.store, { companiesRoot: path.join(this.dir, 'companies') })
  clock = new Date('2026-10-20T18:00:00.000Z')
  settings: Partial<OrchestratorSettings> = { mode: 'on', extractFallback: false }
  collab: Partial<AgentCollabSettings> = {}
  readonly d: Dispatcher
  readonly tools: TaskTools
  readonly broker: AuthorBroker
  readonly forum: ForumService
  readonly responder: ForumResponder
  readonly mailbox: Mailbox
  readonly applier: RunApplier
  readonly reader: ContextReader
  readonly turns: Turn[] = []
  readonly live: Turn[] = []
  readonly scripts = new Map<string, Script>()
  readonly adapters = new Map<string, AdapterId>()
  facts: { companyId: string; facts: RunReport['facts'] }[] = []
  extract: ApplyDeps['extract'] = null
  /** the chief of staff, once attachCoordinator ran */
  coord: Coordinator | null = null
  suggestions: Suggestions | null = null
  /** the debounce timers the coordinator set (tests flush by hand) */
  readonly timers: { fn: () => void; ms: number }[] = []
  pumps: string[] = []
  private seq = 0

  constructor() {
    fs.mkdirSync(this.runLogs, { recursive: true })
    this.d = new Dispatcher({ company: this.c, startRun: (t, o) => this.startTaskRun(t, o), cancelRun: async (id) => this.finish(id, 'canceled'), enabled: () => true, now: () => this.clock })
    this.c.hooks = this.d.hooks()
    this.tools = new TaskTools({
      company: () => this.c,
      enabled: () => true,
      now: () => this.clock,
      pump: (id) => void this.d.pump(id),
      teammate: (companyId, raw) => {
        const m = this.forum.store.agentByName(companyId, raw)
        return m?.agentId && m.companyId === companyId ? { agentId: m.agentId } : { teammates: this.forum.store.roster(companyId).map((t) => `@${t.handle}`) }
      }
    })
    const deps = { drafts: new AuthorDrafts(this.db), tasks: { resolve: (o: LiveOwner) => this.tools.resolveCaller(o), call: (caller: unknown, tool: TaskTool, args: Record<string, unknown>, hints: { companyId: string | null; taskId: string | null; callId: string | null }) => this.tools.call(caller as TaskCaller, tool, args, hints) } }
    this.broker = new AuthorBroker({ ...deps, now: () => this.clock.getTime() } as unknown as BrokerDeps)
    const c = () => this.c
    this.forum = new ForumService({
      db: this.db,
      enabled: () => true,
      emit: () => undefined,
      now: () => this.clock,
      collabSettings: () => this.collab,
      directory: {
        departments: (companyId) => c().departments.list(companyId, { includeArchived: true }).map((d) => ({ id: d.id, key: d.key, name: d.name, archivedAt: d.archivedAt })),
        agents: (companyId) => {
          const agents = c().departments.listAgents({ companyId, includeArchived: true })
          const personas = resolvePersonas(agents, c().departments.list(companyId, { includeArchived: true }))
          return agents.map((a) => ({ id: a.id, departmentId: a.departmentId, name: a.name, archivedAt: a.archivedAt, personaName: personas.get(a.id)?.name ?? null }))
        },
        ownerName: () => 'Owner',
        hasCompany: (id) => !!c().scope.get(id)
      },
      tasks: {
        get: (id) => {
          try {
            const t = c().task(id)
            return { id: t.id, companyId: t.companyId, identifier: t.identifier, status: t.status, blockReason: t.blockReason, runId: t.runId, ask: t.ask, report: t.report }
          } catch {
            return null
          }
        },
        setAsk: (taskId, ask) => void c().patchInFlight(taskId, ask ? { ask, report: null } : { ask: null }),
        answer: (taskId, answer) => void c().answer(taskId, answer),
        create: (input) => {
          const t = c().createTask({ companyId: input.companyId, title: input.title, description: input.description, repoId: null, status: input.departmentId || input.agentId ? 'todo' : 'triage', priority: 0, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], departmentId: input.departmentId, agentId: input.agentId })
          return { id: t.id, identifier: t.identifier }
        }
      },
      board: (companyId) => c().listTasks(companyId).map((t) => ({ identifier: t.identifier, title: t.title, status: t.status, blockReason: t.blockReason ?? null, agentId: t.agentId ?? null, departmentId: t.departmentId ?? null, priority: t.priority, updatedAt: t.updatedAt })),
      seats: {
        departmentOf: (agentId) => c().departments.getAgent(agentId)?.departmentId ?? null,
        canAnswer: (agentId) => {
          const a = c().departments.getAgent(agentId)
          return !!a && !a.archivedAt && !a.pausedAt && a.kind === 'profile'
        },
        leadOf: (companyId, departmentId) => c().departments.listAgents({ companyId, departmentId }).find((a) => !a.archivedAt && !a.pausedAt)?.id ?? null
      }
    })
    this.responder = new ForumResponder({
      store: () => this.forum.store,
      enabled: () => true,
      seat: (agentId) => {
        const a = c().departments.getAgent(agentId)
        return a ? { id: a.id, companyId: a.companyId, departmentId: a.departmentId, name: a.name, instructions: '', profileId: a.refId, repoId: null, active: !a.archivedAt && !a.pausedAt } : null
      },
      departmentName: (id) => c().departments.get(id)?.name ?? null,
      seats: (companyId, departmentId) => c().departments.listAgents({ companyId, ...(departmentId ? { departmentId } : {}) }).filter((a) => !a.archivedAt && !a.pausedAt).map((a) => a.id),
      start: (input) => this.startReplyRun(input),
      onWakeStarted: (ids, runId) => this.forum.collab.noteStarted(ids, runId),
      onWakeFailed: (ids, reason) => this.forum.collab.noteFailed(ids, reason),
      now: () => this.clock
    })
    this.forum.collabWake = (req) => this.responder.wakeForAgent(req.target, req.message.companyId, req.message.id, { handle: req.asker.handle, label: null, depth: req.depth, maxHops: req.maxHops, why: req.why }, req.wakeId)
    this.mailbox = new Mailbox({ db: this.db, forum: () => this.forum, company: c, wakeTask: (id, reason) => void this.d.addWake(id, reason), now: () => this.clock })
    this.applier = new RunApplier({
      db: this.db,
      company: c,
      settings: () => this.settings,
      boardFlags: () => ({ companies: true, departments: true }),
      forum: () => this.forum,
      mailbox: this.mailbox,
      runLogsDir: this.runLogs,
      facts: (companyId, _run, facts) => {
        this.facts.push({ companyId, facts })
        return { created: facts.map((_, i) => `prop_${i}`) }
      },
      handoff: (owner, args) => this.broker.taskCall({ runId: owner.runId, stepId: owner.stepId }, 'task_handoff', args, {}),
      extract: (input, companyId) => (this.extract ? this.extract(input, companyId) : Promise.resolve(null)),
      redact: (t) => t.replace(/sk-test-[a-z0-9]+/g, '••••KEY'),
      now: () => this.clock
    })
    this.reader = new ContextReader({ company: c, mailbox: this.mailbox, now: () => this.clock })
    // as wire.ts / author wire.ts do: handoff applied right before syncRun, Principia's beforeSync before that
    const sync = this.c.syncRun.bind(this.c)
    this.c.syncRun = (run) => {
      this.tools.beforeSyncRun(run)
      return sync(run)
    }
    const sync2 = this.c.syncRun.bind(this.c)
    this.c.syncRun = (run) => {
      this.applier.beforeSync(run)
      return sync2(run)
    }
    this.forum.deferAutoPost = (e) => this.applier.willPost(e)
    this.forum.onAskAnswered = (m, o) => this.mailbox.onAnswered(m, o)
    this.forum.collab.onReplied = (e) => this.mailbox.onReplied(e)
  }

  dispose(): void {
    this.coord?.dispose()
    this.d.dispose()
    void this.forum.stop()
    this.db.close()
    fs.rmSync(this.dir, { recursive: true, force: true })
  }

  // ---------- the company ----------

  profile(adapter: AdapterId = 'claude', name: string = adapter) {
    return this.store.createProfile({ name, adapter, permissionMode: 'default', secretNames: [], useApiKeyAuth: false })
  }
  company(name = 'Acme') {
    const co = this.c.create({ name })
    this.c.setAutopilot(co.id, true)
    return co
  }
  department(companyId: string, name: string, key: string): Department {
    return this.c.departments.save({ companyId, name, key })
  }
  seat(companyId: string, dep: Department | null, name: string, adapter: AdapterId, autonomy: 'auto' | 'manual', script?: Script): CompanyAgent {
    const p = this.profile(adapter, `${adapter} ${name}`)
    const a = this.c.departments.saveAgent({ companyId, departmentId: dep?.id ?? null, kind: 'profile', refId: p.id, name, data: { autonomy } })
    this.adapters.set(a.id, adapter)
    if (script) this.scripts.set(a.id, script)
    this.forum.store.sync(companyId)
    return a
  }
  task(over: Partial<CompanyTaskInput> & { companyId: string }): BoardTask {
    return this.c.createTask({ title: 'Task', description: '', repoId: null, status: 'todo', priority: 3, source: 'manual', sourceUrl: null, externalId: null, assigneeProfileId: null, parentId: null, dependencyIds: [], ...over })
  }
  handle(agentId: string): string {
    return this.forum.store.memberForAgent(agentId)!.handle
  }

  // ---------- the fake engine ----------

  private insertRun(target: RunTarget, companyId: string | null, agentId: string | null, taskId: string | null): Run {
    const id = `r_orch${++this.seq}`
    const now = this.clock.toISOString()
    this.db.prepare(`INSERT INTO runs(id,kind,title,target_json,trigger,status,created_at,started_at,artifacts_dir,company_id,agent_id,task_id) VALUES(?,'prompt','Run',?,'manual','running',?,?,?,?,?,?)`).run(id, JSON.stringify(target), now, now, this.dir, companyId, agentId, taskId)
    return { id, kind: 'prompt', title: 'Run', target, workflowId: null, scheduleId: null, parentRunId: null, trigger: 'manual', status: 'running', reason: null, createdAt: now, startedAt: now, endedAt: null, artifactsDir: this.dir, artifactCount: 0, companyId: companyId ?? undefined } as Run
  }
  private queue(run: Run, kind: Turn['kind'], agentId: string, taskId: string | null, prompt: string): void {
    const owner = { runId: run.id, stepId: `st_${run.id}` }
    const companyId = run.companyId!
    // what the executor's withPrincipia appends (the context reads the board and the mailbox at step start)
    const context = this.applier.active() ? buildRunContext(this.reader.input({ companyId, taskId, agentId, runId: run.id, resumed: false, reportPath: runReportPath(this.runLogs, run.id, owner.stepId) })) : null
    const t: Turn = { run, kind, agentId, taskId, prompt, context, owner }
    this.turns.push(t)
    this.live.push(t)
  }
  private startTaskRun(target: RunTarget, opts: StartRunOptions): Run {
    const run = this.insertRun(target, opts.companyId ?? null, opts.agentId ?? null, opts.taskId ?? null)
    // the task's row points at the run once startTask returns: queue the turn after that
    queueMicrotask(() => this.queue(run, 'task', opts.agentId!, opts.taskId ?? null, target.kind === 'prompt' ? target.prompt : ''))
    return run
  }
  private startReplyRun(input: { companyId: string; agentId: string; prompt: string; reply: { memberId: string; channelId: string; messageId: string } }): string {
    const run = this.insertRun({ kind: 'prompt', profileId: 'x', repoId: null, prompt: input.prompt }, input.companyId, input.agentId, null)
    this.forum.noteReplyRun(run.id, input.reply)
    queueMicrotask(() => this.queue(run, 'reply', input.agentId, null, input.prompt))
    return run.id
  }

  /** Plays one turn: the script (one step), the step hooks, then the run end in Hive's order. */
  async play(t: Turn): Promise<void> {
    const i = this.live.indexOf(t)
    if (i < 0) return
    this.live.splice(i, 1)
    const script: Script = this.scripts.get(t.agentId) ?? (() => ({ output: report({ outcome: 'review', summary: 'Done' }) }))
    const res = await script(t, this)
    const status = res.status ?? 'passed'
    const adapter = this.adapters.get(t.agentId) ?? 'claude'
    if (res.file !== undefined) {
      const f = runReportPath(this.runLogs, t.run.id, t.owner.stepId)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, typeof res.file === 'string' ? res.file : JSON.stringify(res.file))
    }
    this.db
      .prepare(`INSERT INTO run_steps(id,run_id,seq,node_id,node_type,adapter,cwd,prompt,output,status,log_path,started_at,ended_at) VALUES(?,?,1,'agent','prompt',?,?,?,?,?,?,?,?)`)
      .run(t.owner.stepId, t.run.id, adapter, this.dir, t.prompt, res.output, status, path.join(this.runLogs, `${t.owner.stepId}.log`), this.clock.toISOString(), this.clock.toISOString())
    const e: StepOutputEvent = { runId: t.run.id, stepId: t.owner.stepId, nodeId: 'agent', adapter, companyId: t.run.companyId ?? null, memory: 'read', transport: null, status, output: res.output }
    // stepOutputHooks in boot order: the task report harvest, the Forum's, then Principia's
    this.tools.harvest(e)
    await this.forum.harvest(e)
    this.applier.onStepOutput(e)
    await this.finish(t.run.id, status)
  }
  async finish(runId: string, status: 'passed' | 'failed' | 'canceled'): Promise<void> {
    this.db.prepare('UPDATE runs SET status=?, ended_at=? WHERE id=?').run(status, this.clock.toISOString(), runId)
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as { company_id: string | null }
    const run = { id: runId, status, companyId: row.company_id ?? undefined } as Run
    // runHooks in boot order: the board's syncRun, the dispatcher, the Forum responder, Principia's afterRun
    this.c.syncRun(run)
    this.d.onRunUpdated(run)
    this.responder.onRunEnded(runId)
    await this.applier.afterRun(run)
    this.coord?.runEnded(runId)
    await settle()
  }

  /**
   * The chief of staff wired the way wire.ts wires it: board hooks (created, done), approve, run ends. Timers are
   * recorded, never fired: a test flushes the batch itself.
   */
  attachCoordinator(over: Partial<CoordinatorDeps> = {}): Coordinator {
    const c = () => this.c
    this.suggestions = new Suggestions({ db: this.db, now: () => this.clock })
    const coord = new Coordinator({
      db: this.db,
      company: c,
      settings: (companyId) => this.applier.settingsFor(companyId),
      boardFlags: () => ({ companies: true, departments: true }),
      overCap: () => false,
      takeBudget: (companyId, perDay) => this.applier.takeBudget(companyId, perDay),
      model: null,
      pump: (companyId) => {
        this.pumps.push(companyId)
        void this.d.pump(companyId)
      },
      wakeTask: (id, reason) => void this.d.addWake(id, reason),
      mailbox: this.mailbox,
      forum: () => this.forum,
      suggestions: this.suggestions,
      now: () => this.clock,
      timers: { set: (fn, ms) => this.timers.push({ fn, ms }), clear: () => undefined },
      ...over
    })
    this.coord = coord
    const inner = this.c.hooks
    this.c.hooks = {
      created: (t) => {
        inner?.created(t)
        coord.event({ kind: 'task_created', companyId: t.companyId, taskId: t.id, agentId: t.agentId ?? null })
      },
      updated: (prev, next) => {
        inner?.updated(prev, next)
        if (next.status === 'done' && prev.status !== 'done') coord.event({ kind: 'task_done', companyId: next.companyId, taskId: next.id, agentId: next.agentId ?? null })
      },
      commented: (taskId, message, by) => inner?.commented(taskId, message, by)
    }
    const approve = this.c.approve.bind(this.c)
    this.c.approve = (...args) => {
      const t = approve(...args)
      coord.event({ kind: 'task_done', companyId: t.companyId, taskId: t.id, agentId: t.agentId ?? null })
      return t
    }
    return coord
  }
  async drain(max = 30): Promise<void> {
    await settle()
    for (let i = 0; this.live.length; i++) {
      if (i >= max) throw new Error(`still ${this.live.length} runs after ${max} turns: a loop`)
      await this.play(this.live[0])
      await settle()
    }
  }
  /** Starts a task now (Run now), the way a human click does. */
  async runNow(taskId: string): Promise<void> {
    await settle()
    // an auto seat with autopilot on may already have picked it up
    if (this.c.task(taskId).status !== 'in_progress') this.d.runNow(taskId)
    await settle()
  }
  posts(companyId: string) {
    return (this.db.prepare("SELECT seq FROM forum_messages WHERE company_id=? AND kind!='system' ORDER BY seq").all(companyId) as { seq: number }[]).map((r) => this.forum.store.message(r.seq))
  }
  orch(runId: string) {
    return this.applier.forRun(runId)
  }
}
