/**
 * The desktop engine, headless, for every cloud run (CLOUD.md §4, §7.8, §9). One engine over `<runtime>/engine.db`
 * (better-sqlite3, the desktop's own store). What differs from the desktop is all in the EngineContext:
 * - profiles prof_claude / prof_codex / prof_gemini (and shell), Claude headless in `dontAsk`;
 * - the environment is the sandbox's allowlist; each run's own HOME, CLI config homes and provider variables reach
 *   its processes through the reaper's spawn tag (merged last into every spawn of the run's steps);
 * - company keys from RunMaterials.secrets; the redactor seeded from ports.knownSecrets() plus the run's materials;
 * - the company bridge confines every folder to `<workspace>/<companyId>`;
 * - the gateway (per company, with the built-in passport), the passport card and the Forum.
 * Engine events become ports.runStatus / runStep / runLog (batched every 500 ms) and usage.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import type Database from 'better-sqlite3'
import type { CloudAdapter, CloudRunStatus, CloudRunStep, CloudRunDetail, CloudRunSummary } from '../../shared/cloud'
import { CLOUD_ADAPTERS } from '../../shared/cloud'
import type { CompanyBridge, EngineContext, EngineStore, ProcessReaper } from '../../shared/engine'
import type { AdapterId, AgentProfile, EngineEvent, Repo, Run, RunStep, RunTarget, Settings, Workflow } from '../../shared/types'
import { createEngineWith, type Engine } from '../../main/engine'
import { codexAdapter, geminiAdapter, readableLog, shellAdapter, type Adapter } from '../../main/engine/adapters'
import { cloudClaudeAdapter } from './adapters'
import { resolveBin } from '../../main/engine/providers'
import type { ControlPorts, PassportMaterial, ProviderMaterial, RuntimeRunRequest } from '../contract'
import { CloudForum } from './forum'
import { CompanyGateways } from './gateway'
import { PassportClient, harvestNotes } from './passport'
import { materializeProviders, type Materialized } from './providers/materialize'
import { accountOutcome, runFailureDetail, type Bins } from './providers/test'
import { Redactor } from './redact'
import { ProcessSandbox, isInside, isSafeKeyName, type RunSandbox } from './sandbox'
import { CLOUD_PROFILE_ID, applyUntrusted, cloudProfiles, prepareCloudWorkflow, wrapUntrusted } from './cloudWorkflow'
import { usageFromLogFile, type StepUsage } from './usage'
import { repoFolderName, runAskpass } from './repos'

export const LOG_BATCH_MS = 500

/** The last line of an answer worth a summary: the passport-notes and forum blocks are for machines. */
export function lastLine(output: string): string | null {
  const text = output
    .replace(/<passport-notes>[\s\S]*?<\/passport-notes>/gi, '')
    .replace(/```(?:forum|open-passport-notes)[^\n]*\n[\s\S]*?```/g, '')
  return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? null
}
const TERMINAL = new Set(['passed', 'failed', 'canceled'])
const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS cloud_run_map (cloud_run_id TEXT PRIMARY KEY, engine_run_id TEXT UNIQUE, company_id TEXT NOT NULL, seat_id TEXT, kinds TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_step_usage (step_id TEXT PRIMARY KEY, cloud_run_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, usd REAL);
`

/** A tiny serial lock per key (one Codex ChatGPT sign-in run at a time, CLOUD.md §7.2). */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>()
  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const tail = prev.then(() => mine)
    this.tails.set(key, tail)
    await prev
    return () => {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

interface RunState {
  req: RuntimeRunRequest
  cloudRunId: string
  companyId: string
  engineRunId: string | null
  box: RunSandbox | null
  mat: Materialized | null
  /** HOME, CLI homes and provider variables of this run (merged over baseEnv for each spawn) */
  overlay: Record<string, string>
  seatId: string | null
  /** credential kind per adapter (usage: dollars only for API keys) */
  kinds: Partial<Record<AdapterId, ProviderMaterial['kind']>>
  passportCard: string | null
  timer: NodeJS.Timeout | null
  timedOut: boolean
  shutdown: boolean
  canceled: boolean
  ended: boolean
  release: (() => void) | null
  logs: Map<string, string[]>
  logTimer: NodeJS.Timeout | null
  usage: Map<string, StepUsage | null>
  stepEnded: Set<string>
  partial: Map<string, string>
  done: Promise<void>
  resolveDone: () => void
}

export interface EngineHostOptions {
  runtimeDir: string
  sandbox: ProcessSandbox
  bins: Bins
  ports: ControlPorts
  redactor: Redactor
  gateways: CompanyGateways
  passport: PassportClient
  forum: CloudForum
  db: Database.Database
  store: EngineStore
  settings(): Settings
  now(): Date
}

export class EngineHost {
  readonly engine: Engine
  private readonly runs = new Map<string, RunState>()
  private readonly byEngine = new Map<string, RunState>()
  private readonly stepRun = new Map<string, RunState>()
  private readonly workflows = new Map<string, Workflow>()
  private readonly repos = new Map<string, Repo>()
  private readonly companySecrets = new Map<string, Record<string, string>>()
  private readonly passports = new Map<string, PassportMaterial>()
  private readonly cards = new Map<string, string | null>()
  private readonly profiles = new Map<string, AgentProfile>()
  private readonly locks = new KeyedLock()
  private starting: RunState | null = null
  readonly paths: EngineContext['paths']

  constructor(private readonly o: EngineHostOptions) {
    o.db.exec(DDL)
    for (const p of cloudProfiles()) this.profiles.set(p.id, p)
    this.profiles.set('prof_shell', { ...cloudProfiles()[0]!, id: 'prof_shell', name: 'Shell', adapter: 'shell', extraArgs: [] })
    const root = join(o.runtimeDir, 'engine')
    this.paths = { userData: root, artifactsRoot: join(root, 'artifacts'), runLogsDir: join(root, 'logs'), scratchDir: join(root, 'scratch') }
    for (const p of Object.values(this.paths)) mkdirSync(p, { recursive: true, mode: 0o700 })
    // CLOUD.md §7.8: agents write artifacts and scratch files; the step logs beside them stay the runtime's
    o.sandbox.traverseOnly(root)
    o.sandbox.traverseOnly(this.paths.artifactsRoot)
    o.sandbox.grant(this.paths.scratchDir)
    const store = this.wrapStore(o.store)
    const companies: CompanyBridge = {
      resolve: (q) => q.companyId ?? (q.workflowId ? this.workflows.get(q.workflowId)?.companyId : undefined) ?? (q.repoId ? this.repos.get(q.repoId)?.companyId : undefined) ?? 'co_unknown',
      crossCompany: (companyId, refs) => {
        if (refs.workflowId && this.workflows.get(refs.workflowId)?.companyId !== companyId) return 'That workflow belongs to another company'
        if (refs.repoId && this.repos.get(refs.repoId)?.companyId !== companyId) return 'That repository belongs to another company'
        if (refs.cwd) {
          let real: string
          try {
            real = realpathSync(refs.cwd)
          } catch {
            return 'That folder does not exist'
          }
          if (!isInside(o.sandbox.companyDir(companyId), real)) return 'That folder is outside the company folder'
        }
        return null
      },
      enforced: () => true,
      workspaceDir: (companyId) => o.sandbox.companyDir(companyId),
      repoIds: (companyId) => [...this.repos.values()].filter((r) => r.companyId === companyId).map((r) => r.id)
    }
    const reaper: ProcessReaper = {
      userData: root,
      tag: (spawnId) => ({ HIVE_SPAWN_ID: spawnId, ...(this.stepRun.get(spawnId)?.overlay ?? {}) }),
      register: () => {},
      collect: async () => [],
      // the leader is gone: whatever is left in its process group goes with it (startProcess already group-kills on cancel)
      reap: async (_spawnId, opts) => {
        let n = 0
        for (const pid of opts?.rootPids ?? []) {
          try {
            process.kill(-pid, 'SIGKILL')
            n++
          } catch {
            /* nothing left */
          }
        }
        return n
      },
      reapAllSync: () => 0,
      leftovers: async () => [],
      stopLeftovers: async () => 0
    }
    const ctx: EngineContext = {
      paths: this.paths,
      store,
      baseEnv: () => o.sandbox.baseEnv(),
      secrets: {
        resolve: (names, companyId) => this.resolveSecrets(names, companyId ?? null),
        redact: (text) => o.redactor.redact(text),
        names: (names, companyId) => Object.keys(this.resolveSecrets(names, companyId ?? null))
      },
      getSettings: () => o.settings(),
      getProfile: (id) => this.profiles.get(id) ?? null,
      getRepo: (id) => this.repos.get(id) ?? null,
      listRepos: () => [...this.repos.values()],
      getWorkflow: (id) => this.workflows.get(id) ?? null,
      emit: (e) => this.onEvent(e),
      log: {
        info: (m, meta) => o.ports.log.info(o.redactor.redact(m), meta),
        warn: (m, meta) => o.ports.log.warn(o.redactor.redact(m), meta),
        error: (m, meta) => o.ports.log.error(o.redactor.redact(m), meta)
      },
      now: o.now,
      company: companies,
      reaper,
      gateway: { attachment: (cwd, companyId) => o.gateways.attachment(cwd, companyId ?? null) },
      // the card fetched when the company's latest run started (the engine asks synchronously, per spawn)
      passportContext: (_cwd, companyId) => (companyId ? (this.cards.get(companyId) ?? null) : null),
      onStepOutput: (e) => this.onStepOutput(e),
      forum: o.forum,
      spawnUser: () => o.sandbox.spawnUser()
    }
    const adapters: Partial<Record<AdapterId, Adapter>> = {
      claude: cloudClaudeAdapter(o.bins.claude),
      codex: { ...codexAdapter, bin: o.bins.codex },
      gemini: { ...geminiAdapter, bin: o.bins.gemini },
      shell: shellAdapter
    }
    this.engine = createEngineWith(ctx, {
      adapters,
      // a step falls back (usage limit, expired token) only to a harness this run has an account for: never to a
      // signed-out CLI, and never to a ChatGPT sign-in outside its serialization lock
      harnessFallback: (engineRunId, to) => !!this.byEngine.get(engineRunId)?.mat?.used[to as CloudAdapter],
      detect: async () =>
        (['claude', 'codex', 'cursor', 'gemini', 'shell'] as AdapterId[]).map((id) => {
          const a = adapters[id]
          const binPath = a ? resolveBin(a, o.sandbox.baseEnv()) : null
          return { id, label: a?.label ?? id, available: !!binPath, version: null, binPath, installHint: a?.installHint ?? '', checkedAt: o.now().toISOString() }
        })
    })
  }

  async init(): Promise<void> {
    // a run that was going when the runtime stopped is marked failed by the engine; tell the control plane too
    const interrupted = this.o.store.listActiveRuns()
    await this.engine.init()
    for (const r of interrupted) {
      const row = this.o.db.prepare('SELECT cloud_run_id FROM cloud_run_map WHERE engine_run_id=?').get(r.id) as { cloud_run_id: string } | undefined
      if (row) this.o.ports.runStatus(row.cloud_run_id, 'failed', 'The cloud runtime restarted during this run')
    }
  }

  private wrapStore(inner: EngineStore): EngineStore {
    const self = this
    return new Proxy(inner, {
      get(target, prop, receiver) {
        // the run's artifacts folder (made by runs.start) is the agent's to write, before any step spawns
        if (prop === 'insertRun')
          return (run: Run, ...rest: unknown[]) => {
            const out = (target.insertRun as (r: Run, ...a: unknown[]) => unknown)(run, ...rest)
            self.o.sandbox.grant(run.artifactsDir)
            return out
          }
        if (prop === 'insertStep')
          return (step: RunStep) => {
            const st = self.byEngine.get(step.runId) ?? (self.starting && !self.starting.engineRunId ? self.starting : null)
            if (st) self.stepRun.set(step.id, st)
            return target.insertStep(step)
          }
        const v = Reflect.get(target, prop, receiver) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      }
    })
  }

  private resolveSecrets(names: string[], companyId: string | null): Record<string, string> {
    const all = companyId ? (this.companySecrets.get(companyId) ?? {}) : {}
    const out: Record<string, string> = {}
    const wanted = names.includes('*') ? Object.keys(all) : names
    for (const n of wanted) if (isSafeKeyName(n) && typeof all[n] === 'string') out[n] = all[n]!
    return out
  }

  // ---------- validation ----------

  validateWorkflow(companyId: string, file: unknown): string[] {
    let dir: string
    try {
      dir = this.o.sandbox.companyDir(companyId)
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)]
    }
    return prepareCloudWorkflow(file, dir, { getProfile: (id) => this.profiles.get(id) ?? null, getRepo: (id) => this.repos.get(id) ?? null }).problems
  }

  // ---------- runs ----------

  isActive(cloudRunId: string): boolean {
    const st = this.runs.get(cloudRunId)
    return !!st && !st.ended
  }

  cloudRunOf(engineRunId: string): { cloudRunId: string; companyId: string; active: boolean } | null {
    const st = this.byEngine.get(engineRunId)
    if (st) return { cloudRunId: st.cloudRunId, companyId: st.companyId, active: !st.ended }
    const row = this.o.db.prepare('SELECT cloud_run_id, company_id FROM cloud_run_map WHERE engine_run_id=?').get(engineRunId) as { cloud_run_id: string; company_id: string } | undefined
    return row ? { cloudRunId: row.cloud_run_id, companyId: row.company_id, active: false } : null
  }

  /** Starts a run. Never throws: failures arrive as runStatus. */
  startRun(req: RuntimeRunRequest): void {
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    const st: RunState = {
      req,
      cloudRunId: req.runId,
      companyId: req.companyId,
      engineRunId: null,
      box: null,
      mat: null,
      overlay: {},
      seatId: null,
      kinds: {},
      passportCard: null,
      timer: null,
      timedOut: false,
      shutdown: false,
      canceled: false,
      ended: false,
      release: null,
      logs: new Map(),
      logTimer: null,
      usage: new Map(),
      stepEnded: new Set(),
      partial: new Map(),
      done,
      resolveDone
    }
    if (this.runs.has(req.runId)) {
      this.o.ports.log.warn('runtime: run already started', { runId: req.runId })
      return
    }
    this.runs.set(req.runId, st)
    void this.launch(st).catch((e) => this.failEarly(st, e instanceof Error ? e.message : String(e)))
  }

  private seedRedactor(req: RuntimeRunRequest): void {
    const r = this.o.redactor
    try {
      r.addAll(this.o.ports.knownSecrets())
    } catch {
      /* the port is best effort */
    }
    const m = req.materials
    for (const p of m.providers) r.add(p.value)
    for (const repo of m.repos) r.add(repo.token)
    for (const c of m.connections) for (const v of Object.values(c.credentials ?? {})) r.add(v)
    if (m.passport) r.add(m.passport.token)
    for (const [k, v] of Object.entries(m.secrets ?? {})) r.add(v, k)
  }

  private async launch(st: RunState): Promise<void> {
    const { req } = st
    const o = this.o
    this.seedRedactor(req)
    if (st.canceled) return this.failEarly(st, 'Canceled', 'canceled')
    const companyDir = o.sandbox.companyDir(req.companyId)
    // repos of this company, as the engine sees them (repo folder names under the company folder)
    for (const repo of req.materials.repos) {
      let folder: string
      try {
        folder = repoFolderName(repo)
      } catch {
        continue
      }
      const id = repo.id.startsWith('repo_') ? repo.id : `repo_${repo.id}`
      const path = join(companyDir, folder)
      this.repos.set(id, { id, name: repo.name, path, addedAt: o.now().toISOString(), exists: existsSync(path), isGit: existsSync(join(path, '.git')), liveSessions: 0, companyId: req.companyId })
    }
    // the target
    let target: RunTarget
    let adapters: CloudAdapter[]
    let seatKey: string
    let seatName: string
    if (req.target.kind === 'workflow') {
      const prepared = prepareCloudWorkflow(req.workflowFile, companyDir, { getProfile: (id) => this.profiles.get(id) ?? null, getRepo: (id) => this.repos.get(id) ?? null })
      if (!prepared.draft || prepared.problems.length) return this.failEarly(st, prepared.problems.join(' ') || 'The workflow is not runnable in the cloud')
      const draft = prepared.draft
      const untrusted = applyUntrusted(draft, req.target.inputs ?? {}, req.untrustedInputs ?? [])
      if (untrusted.problem) return this.failEarly(st, untrusted.problem)
      const now = o.now().toISOString()
      this.workflows.set(req.target.workflowId, { ...draft, id: req.target.workflowId, createdAt: this.workflows.get(req.target.workflowId)?.createdAt ?? now, updatedAt: now, companyId: req.companyId })
      target = { kind: 'workflow', workflowId: req.target.workflowId, inputs: untrusted.inputs }
      adapters = prepared.adapters
      seatKey = `workflow:${req.target.workflowId}`
      seatName = draft.name
    } else {
      const t = req.target
      if (!(CLOUD_ADAPTERS as readonly string[]).includes(t.adapter)) return this.failEarly(st, 'That agent is not available in the cloud')
      let repoId: string | null = null
      if (t.repoId) {
        repoId = t.repoId.startsWith('repo_') ? t.repoId : `repo_${t.repoId}`
        const repo = this.repos.get(repoId)
        if (!repo || repo.companyId !== req.companyId) return this.failEarly(st, 'That repository is not in this company')
        if (!existsSync(repo.path)) return this.failEarly(st, `The repository ${repo.name} is not cloned yet. Sync it first.`)
      }
      const untrusted = (req.untrustedInputs ?? []).some((u) => u && t.prompt.includes(u))
      target = { kind: 'prompt', profileId: CLOUD_PROFILE_ID[t.adapter], repoId, prompt: untrusted ? wrapUntrusted(t.prompt) : t.prompt }
      adapters = [t.adapter]
      seatKey = `prompt:${t.adapter}`
      seatName = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[t.adapter]
    }
    // sandbox and accounts
    st.box = o.sandbox.prepare(st.cloudRunId)
    const mat = materializeProviders(st.box, req.materials.providers, adapters, { codex: o.bins.codex })
    st.mat = mat
    if (mat.missing.length) {
      const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
      const name = req.target.kind === 'workflow' ? `${seatName} uses` : 'This run uses'
      return this.failEarly(st, `${name} ${mat.missing.map((a) => label[a]).join(' and ')}, which ${mat.missing.length > 1 ? 'are' : 'is'} not connected to the cloud.`)
    }
    for (const [a, m] of Object.entries(mat.used)) st.kinds[a as AdapterId] = m!.kind
    const codexAuth = mat.used.codex?.kind === 'codex_auth_json' ? mat.used.codex.credentialId : null
    if (codexAuth) st.release = await this.locks.acquire(`codex:${codexAuth}`)
    if (st.canceled) return this.failEarly(st, 'Canceled', 'canceled')
    st.overlay = o.sandbox.runEnv(st.box, mat.env)
    // repo tokens reach git through the run's own askpass (CLOUD.md §7.4), so agents can push their branches
    const repoTokens: { dir: string; token: string }[] = []
    for (const repo of req.materials.repos) {
      if (!repo.token) continue
      try {
        repoTokens.push({ dir: join(companyDir, repoFolderName(repo)), token: repo.token })
      } catch {
        /* no folder name: never cloned */
      }
    }
    if (repoTokens.length) Object.assign(st.overlay, runAskpass(st.box.home, repoTokens))
    this.companySecrets.set(req.companyId, { ...(req.materials.secrets ?? {}) })
    try {
      await mat.before({ ...o.sandbox.baseEnv(), ...st.overlay })
    } catch (e) {
      return this.failEarly(st, e instanceof Error ? e.message : String(e))
    }
    // everything the runtime wrote into the run home (accounts, askpass) now belongs to the agent that runs in it
    o.sandbox.handOver(st.box)
    // connectors, the passport card and the Forum seat
    const problems = o.gateways.sync(req.companyId, req.materials.connections, req.materials.passport)
    if (problems.length) o.ports.log.warn('runtime: some connections were skipped', { runId: st.cloudRunId, problems: problems.map((p) => o.redactor.redact(p)) })
    if (req.materials.passport) {
      this.passports.set(req.companyId, req.materials.passport)
      st.passportCard = await o.passport.card(req.materials.passport)
      this.cards.set(req.companyId, st.passportCard)
    } else this.cards.delete(req.companyId)
    if (!o.forum.hasCompany(req.companyId)) o.forum.ensureCompany({ companyId: req.companyId, name: req.companyName, slug: req.companyId })
    st.seatId = o.forum.seat(req.companyId, seatKey, seatName)
    if (st.canceled) return this.failEarly(st, 'Canceled', 'canceled')
    // the engine run
    let run: Run
    this.starting = st
    try {
      run = this.engine.runs.start(target, { trigger: 'manual', companyId: req.companyId, taskId: st.cloudRunId, agentId: st.seatId })
    } catch (e) {
      this.starting = null
      return this.failEarly(st, e instanceof Error ? e.message : String(e))
    }
    this.starting = null
    this.bindEngineRun(st, run.id)
    o.db
      .prepare('INSERT OR REPLACE INTO cloud_run_map(cloud_run_id, engine_run_id, company_id, seat_id, kinds, created_at) VALUES (?,?,?,?,?,?)')
      .run(st.cloudRunId, run.id, req.companyId, st.seatId, JSON.stringify(st.kinds), o.now().toISOString())
    o.forum.registerRun(run.id, { agentId: st.seatId, cloudRunId: st.cloudRunId, companyId: req.companyId })
    // the layout of CLOUD.md §4.3: runs/<runId>/{logs,artifacts} point at the engine's folders
    for (const [name, dir] of [['logs', join(this.paths.runLogsDir, run.id)], ['artifacts', join(this.paths.artifactsRoot, run.id)]] as const) {
      try {
        if (!existsSync(join(st.box.root, name))) symlinkSync(dir, join(st.box.root, name))
      } catch {
        /* layout only */
      }
    }
    if (req.timeoutMs > 0) {
      st.timer = setTimeout(() => {
        st.timedOut = true
        void this.engine.runs.cancel(run.id).catch(() => {})
      }, req.timeoutMs)
      st.timer.unref?.()
    }
    if (st.canceled) void this.engine.runs.cancel(run.id).catch(() => {})
  }

  private bindEngineRun(st: RunState, engineRunId: string): void {
    st.engineRunId = engineRunId
    this.byEngine.set(engineRunId, st)
  }

  /**
   * A refreshed ChatGPT sign-in goes back before the home is deleted: Codex rotates the refresh token, so losing the
   * new file signs the user out. Runs on every ending (a shutdown that outlives the engine too); a file the CLI never
   * touched writes nothing back.
   */
  private writeBack(st: RunState): void {
    try {
      for (const wb of st.mat?.readback() ?? []) {
        this.o.redactor.add(wb.value)
        this.o.ports.saveProviderCredential(wb)
      }
    } catch (e) {
      this.o.ports.log.warn('runtime: credential readback failed', { runId: st.cloudRunId, error: this.o.redactor.redact(String(e)) })
    }
  }

  /** A run that ended before (or instead of) the engine run. */
  private failEarly(st: RunState, message: string, status: CloudRunStatus = 'failed'): void {
    if (st.ended) return
    st.ended = true
    if (st.timer) clearTimeout(st.timer)
    this.writeBack(st)
    if (st.box) this.o.sandbox.cleanup(st.box)
    st.release?.()
    st.release = null
    this.o.ports.runStatus(st.cloudRunId, status, this.o.redactor.redact(message).slice(0, 500))
    st.resolveDone()
  }

  // ---------- engine events ----------

  private onEvent(e: EngineEvent): void {
    try {
      if (e.type === 'run.updated') {
        let st = this.byEngine.get(e.run.id)
        if (!st && this.starting && !this.starting.engineRunId) {
          st = this.starting
          this.bindEngineRun(st, e.run.id)
        }
        if (!st) return
        if (e.run.status === 'running') this.o.ports.runStatus(st.cloudRunId, 'running', null)
        else if (TERMINAL.has(e.run.status)) void this.finish(st, e.run)
      } else if (e.type === 'step.updated') {
        const st = this.byEngine.get(e.step.runId) ?? this.stepRun.get(e.step.id)
        if (!st) return
        this.stepRun.set(e.step.id, st)
        this.o.ports.runStep(st.cloudRunId, this.cloudStep(st, e.step))
        if (e.step.endedAt && !st.stepEnded.has(e.step.id)) {
          st.stepEnded.add(e.step.id)
          const step = e.step
          setTimeout(() => this.reportUsage(st, step), 300).unref?.()
        }
      } else if (e.type === 'step.output') {
        const st = this.byEngine.get(e.runId)
        if (!st) return
        this.bufferLog(st, e.stepId, e.chunk)
      }
    } catch (err) {
      this.o.ports.log.warn('runtime: event mapping failed', { error: String(err) })
    }
  }

  private bufferLog(st: RunState, stepId: string, chunk: string): void {
    const text = (st.partial.get(stepId) ?? '') + chunk
    const parts = text.split('\n')
    st.partial.set(stepId, parts.pop() ?? '')
    if (!parts.length) return
    const lines = st.logs.get(stepId) ?? []
    lines.push(...parts.map((l) => this.o.redactor.redact(l)))
    st.logs.set(stepId, lines)
    st.logTimer ??= setTimeout(() => this.flushLogs(st), LOG_BATCH_MS)
  }

  private flushLogs(st: RunState, all = false): void {
    if (st.logTimer) clearTimeout(st.logTimer)
    st.logTimer = null
    if (all) for (const [stepId, rest] of st.partial) if (rest) (st.logs.get(stepId) ?? st.logs.set(stepId, []).get(stepId)!).push(this.o.redactor.redact(rest))
    if (all) st.partial.clear()
    for (const [stepId, lines] of st.logs) if (lines.length) this.o.ports.runLog(st.cloudRunId, stepId, lines.splice(0))
    st.logs.clear()
  }

  private stepTitle(st: RunState, s: RunStep): string {
    if (s.nodeType === 'prompt') return 'Prompt'
    const wf = st.req.target.kind === 'workflow' ? this.workflows.get(st.req.target.workflowId) : null
    const label = wf?.nodes.find((n) => n.id === s.nodeId)?.label ?? s.nodeId
    return s.participantLabel ? `${label} · ${s.participantLabel}` : label
  }

  private cloudStep(st: RunState, s: RunStep, usage?: StepUsage | null): CloudRunStep {
    const u = usage ?? st.usage.get(s.id) ?? this.storedUsage(s.id)
    return {
      id: s.id,
      nodeId: s.nodeId === 'prompt' && s.nodeType === 'prompt' ? null : s.nodeId,
      title: this.stepTitle(st, s),
      adapter: s.adapter,
      status: s.status === 'pending' ? 'queued' : (s.status as CloudRunStep['status']),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      usage: u ?? null
    }
  }

  private storedUsage(stepId: string): StepUsage | null {
    const r = this.o.db.prepare('SELECT input_tokens, output_tokens, usd FROM cloud_step_usage WHERE step_id=?').get(stepId) as { input_tokens: number; output_tokens: number; usd: number | null } | undefined
    return r ? { inputTokens: r.input_tokens, outputTokens: r.output_tokens, usd: r.usd } : null
  }

  private reportUsage(st: RunState, s: RunStep): void {
    if (st.usage.has(s.id)) return
    const u = s.adapter === 'shell' ? null : usageFromLogFile(s.adapter, s.logPath, st.kinds[s.adapter] ?? null)
    st.usage.set(s.id, u)
    if (!u) return
    this.o.db.prepare('INSERT OR REPLACE INTO cloud_step_usage(step_id, cloud_run_id, input_tokens, output_tokens, usd) VALUES (?,?,?,?,?)').run(s.id, st.cloudRunId, u.inputTokens, u.outputTokens, u.usd)
    this.o.ports.usage({ runId: st.cloudRunId, companyId: st.companyId, adapter: s.adapter, inputTokens: u.inputTokens, outputTokens: u.outputTokens, usd: u.usd })
    this.o.ports.runStep(st.cloudRunId, this.cloudStep(st, s, u))
  }

  private onStepOutput(e: Parameters<NonNullable<EngineContext['onStepOutput']>>[0]): void {
    const st = this.byEngine.get(e.runId)
    // ```forum blocks (any agent step of a seat run)
    void this.o.forum.harvest(e).catch(() => 0)
    const passport = st ? (st.req.materials.passport ?? null) : e.companyId ? (this.passports.get(e.companyId) ?? null) : null
    if (!passport) return
    const notes = harvestNotes(e)
    if (!notes.length) return
    void this.o.passport.writeNotes(passport, notes).then(
      (statuses) => this.o.ports.audit('passport.notes', e.companyId, { runId: st?.cloudRunId ?? e.runId, notes: notes.length, statuses: statuses.join(',') }),
      () => {}
    )
  }

  private async finish(st: RunState, run: Run): Promise<void> {
    if (st.ended) return
    st.ended = true
    if (st.timer) clearTimeout(st.timer)
    this.flushLogs(st, true)
    // the step logs are flushed by their write streams shortly after the process exits
    await new Promise((r) => setTimeout(r, 350))
    const detail = this.o.store.getRunDetail(run.id)
    for (const s of detail?.steps ?? []) if (s.endedAt) this.reportUsage(st, s)
    this.reportAccounts(st, detail?.steps ?? [])
    this.writeBack(st)
    if (st.box) this.o.sandbox.cleanup(st.box)
    st.release?.()
    st.release = null
    let status: CloudRunStatus = run.status as CloudRunStatus
    let summary: string | null = null
    const asks = this.o.forum.openAsksOf(run.id)
    if (st.shutdown) {
      status = 'canceled'
      summary = 'The cloud runtime shut down during this run.'
    } else if (st.timedOut) {
      status = 'failed'
      const ms = st.req.timeoutMs
      summary = `Stopped at the ${ms < 60_000 ? `${Math.ceil(ms / 1000)}-second` : `${Math.round(ms / 60_000)}-minute`} limit.`
    } else if (asks.length && run.status !== 'canceled') {
      status = 'needs_input'
      summary = `Waiting for your answer: ${asks[0]!.question}`
    } else if (run.status === 'failed') {
      const failed = [...(detail?.steps ?? [])].reverse().find((s) => s.status === 'failed')
      // an expired token or a usage limit reads as the fix ("Claude token expired. Connect Claude again."), not a stack
      const used = failed ? (st.mat?.used[failed.adapter as CloudAdapter] ?? null) : null
      const account = failed ? runFailureDetail(used, failed.adapter, failed.error, this.o.now()) : null
      summary = account ?? run.reason ?? failed?.error ?? 'The run failed.'
    } else if (run.status === 'canceled') summary = run.reason ?? 'Canceled'
    else {
      const last = [...(detail?.steps ?? [])].reverse().find((s) => s.output?.trim())
      summary = last?.output ? lastLine(last.output) : null
    }
    this.o.ports.runStatus(st.cloudRunId, status, summary ? this.o.redactor.redact(summary).slice(0, 500) : null)
    st.resolveDone()
    // ended runs are read back from engine.db; drop the in-memory state once late events are unlikely
    setTimeout(() => this.forget(st), 60_000).unref?.()
  }

  /**
   * CLOUD.md §7.2, §7.9: what this run learned about its accounts goes back to the control plane, so the Accounts row
   * and readiness stop saying OK when a token expired at 09:00. Per adapter, the latest attempt wins: a rejected
   * sign-in is 'expired', a usage limit 'limited', a passed step 'ok' (which clears an earlier limit).
   */
  private reportAccounts(st: RunState, steps: RunStep[]): void {
    const report = this.o.ports.providerStatus?.bind(this.o.ports)
    if (!report || !st.mat) return
    const seen = new Map<CloudAdapter, { status: 'ok' | 'expired' | 'limited'; detail: string | null }>()
    for (const s of steps) {
      const used = st.mat.used[s.adapter as CloudAdapter]
      if (!used) continue
      if (s.status === 'passed') seen.set(used.adapter, { status: 'ok', detail: null })
      else if (s.status === 'failed') {
        const out = accountOutcome(used, s.adapter, s.error, this.o.now())
        if (out) seen.set(used.adapter, out)
      }
    }
    for (const [adapter, v] of seen) {
      const used = st.mat.used[adapter]!
      try {
        report({ credentialId: used.credentialId, adapter, status: v.status, detail: v.detail ? this.o.redactor.redact(v.detail) : null })
      } catch (e) {
        this.o.ports.log.warn('runtime: provider status report failed', { runId: st.cloudRunId, error: this.o.redactor.redact(String(e)) })
      }
    }
  }

  private forget(st: RunState): void {
    if (this.runs.get(st.cloudRunId) === st) this.runs.delete(st.cloudRunId)
    if (st.engineRunId && this.byEngine.get(st.engineRunId) === st) this.byEngine.delete(st.engineRunId)
    for (const [stepId, owner] of this.stepRun) if (owner === st) this.stepRun.delete(stepId)
  }

  async cancelRun(cloudRunId: string): Promise<void> {
    const st = this.runs.get(cloudRunId)
    if (!st || st.ended) return
    st.canceled = true
    if (st.engineRunId) await this.engine.runs.cancel(st.engineRunId).catch(() => {})
  }

  /** Resolves when the run reported its final status (tests, shutdown). */
  async settled(cloudRunId: string): Promise<void> {
    await this.runs.get(cloudRunId)?.done
  }

  // ---------- reads ----------

  private engineRunId(cloudRunId: string): string | null {
    const st = this.runs.get(cloudRunId)
    if (st?.engineRunId) return st.engineRunId
    const row = this.o.db.prepare('SELECT engine_run_id FROM cloud_run_map WHERE cloud_run_id=?').get(cloudRunId) as { engine_run_id: string } | undefined
    return row?.engine_run_id ?? null
  }

  runDetail(cloudRunId: string): Omit<CloudRunDetail, keyof CloudRunSummary> | null {
    const st = this.runs.get(cloudRunId)
    const id = this.engineRunId(cloudRunId)
    if (!id) return st ? { steps: [], artifacts: [], forumPosts: [] } : null
    const detail = this.o.store.getRunDetail(id)
    if (!detail) return null
    const map = this.o.db.prepare('SELECT company_id, seat_id FROM cloud_run_map WHERE cloud_run_id=?').get(cloudRunId) as { company_id: string; seat_id: string | null } | undefined
    const fake: RunState = st ?? ({ req: { target: detail.workflow ? { kind: 'workflow', workflowId: detail.run.workflowId ?? '' } : { kind: 'prompt' } }, usage: new Map() } as unknown as RunState)
    const steps = detail.steps.map((s) => {
      const c = this.cloudStep(fake, s)
      if (!st && detail.workflow) c.title = (s.nodeType === 'prompt' ? 'Prompt' : (detail.workflow.nodes.find((n) => n.id === s.nodeId)?.label ?? s.nodeId)) + (s.participantLabel ? ` · ${s.participantLabel}` : '')
      return c
    })
    const artifacts = this.listArtifacts(cloudRunId, detail.run.artifactsDir)
    const forumPosts = map?.seat_id ? this.o.forum.postsOf(map.company_id, map.seat_id, detail.steps.map((s) => s.id), id) : []
    const out = { steps, artifacts, forumPosts }
    return out
  }

  private listArtifacts(cloudRunId: string, dir: string): CloudRunDetail['artifacts'] {
    const out: CloudRunDetail['artifacts'] = []
    const walk = (d: string, prefix: string, depth: number): void => {
      let names: string[] = []
      try {
        names = readdirSync(d)
      } catch {
        return
      }
      for (const n of names.sort()) {
        const p = join(d, n)
        let s
        try {
          s = statSync(p)
        } catch {
          continue
        }
        const rel = prefix ? `${prefix}/${n}` : n
        if (s.isDirectory() && depth < 3) walk(p, rel, depth + 1)
        else if (s.isFile()) out.push({ name: rel, bytes: s.size, url: `/v1/runs/${encodeURIComponent(cloudRunId)}/artifacts/${rel.split('/').map(encodeURIComponent).join('/')}` })
        if (out.length >= 500) return
      }
    }
    walk(dir, '', 0)
    return out
  }

  runLog(cloudRunId: string, stepId: string | null, tail: number): string[] {
    const id = this.engineRunId(cloudRunId)
    if (!id) return []
    const detail = this.o.store.getRunDetail(id)
    if (!detail) return []
    const steps = stepId ? detail.steps.filter((s) => s.id === stepId) : detail.steps
    const lines: string[] = []
    for (const s of steps) {
      let raw = ''
      try {
        raw = readFileSync(s.logPath, 'utf8')
      } catch {
        continue
      }
      const text = s.adapter === 'shell' ? raw : readableLog(s.adapter, raw)
      if (!stepId && steps.length > 1) lines.push(`── ${s.nodeId} (${s.adapter}) ──`)
      lines.push(...text.split('\n'))
    }
    const n = Math.max(1, Math.min(tail || 200, 2000))
    return lines.slice(-n).map((l) => this.o.redactor.redact(l))
  }

  artifactPath(cloudRunId: string, name: string): string | null {
    const id = this.engineRunId(cloudRunId)
    if (!id || !name || name.includes('\0') || name.split('/').some((p) => p === '..' || p === '.' || !p)) return null
    const run = this.o.store.getRun(id)
    if (!run) return null
    try {
      const root = realpathSync(run.artifactsDir)
      const p = realpathSync(join(root, name))
      if (!(p.startsWith(root + sep) && statSync(p).isFile())) return null
      return p
    } catch {
      return null
    }
  }

  /** Active runs (close() cancels them with reason shutdown). */
  async shutdown(): Promise<void> {
    const active = [...this.runs.values()].filter((st) => !st.ended)
    for (const st of active) st.shutdown = true
    await this.engine.shutdown()
    await Promise.race([Promise.all(active.map((st) => st.done)), new Promise((r) => setTimeout(r, 5000))])
    for (const st of active) if (!st.ended) this.failEarly(st, 'The cloud runtime shut down during this run.', 'canceled')
  }
}
