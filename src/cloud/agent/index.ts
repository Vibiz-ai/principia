/**
 * Principia Cloud agent runtime (package AI): implements `CloudRuntime` (src/cloud/contract.ts) over the desktop's own
 * engine, run headless. CLOUD.md §4, §7, §9. The control plane creates it with `createCloudRuntime` and talks to it
 * only through the contract; the runtime talks back only through ControlPorts. No Electron imports.
 */
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { AdapterId } from '../../shared/types'
import type { CloudRuntime, ControlPorts, CreateCloudRuntime, RuntimeOptions } from '../contract'
import { openDatabase } from '../../main/db'
import { Store } from '../../main/db/store'
import { createEngineStore } from '../../main/db/engineStore'
import { EngineHost } from './engineHost'
import { CloudForum } from './forum'
import { CompanyGateways } from './gateway'
import { CloudRuntimeError, notInV1 } from './errors'
import { PassportClient } from './passport'
import { cliVersions, testProvider, type Bins, CLI_LABEL } from './providers/test'
import { Redactor } from './redact'
import { syncRepo } from './repos'
import { ProcessSandbox } from './sandbox'
import { ScheduleLoop } from './triggers'

export { CLOUD_AGENT_ENTRIES } from './entries'
export const CLOUD_RUNTIME_VERSION = '1.0.0'
const VERSIONS_TTL_MS = 10 * 60_000

/** Where the bundle's sibling scripts live (out-cloud/mcp-gateway.mjs, forum-cli.mjs). */
function bundleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

interface Started {
  db: Database.Database
  sandbox: ProcessSandbox
  forum: CloudForum
  gateways: CompanyGateways
  host: EngineHost
  loop: ScheduleLoop
}

class Runtime implements CloudRuntime {
  readonly version = CLOUD_RUNTIME_VERSION
  readonly sandbox = 'process' as const
  private s: Started | null = null
  private failed: string | null = null
  private readonly ports: ControlPorts
  private readonly redactor = new Redactor()
  private readonly passport: PassportClient
  private readonly bins: Bins
  private readonly now: () => Date
  private readonly runtimeDir: string
  private versions: { at: number; value: Partial<Record<AdapterId, string>> } | null = null

  constructor(private readonly opts: RuntimeOptions) {
    this.ports = opts.ports
    this.now = opts.now ?? (() => new Date())
    // `/data` per the contract; a caller that already passes `/data/runtime` gets the same layout, not runtime/runtime
    this.runtimeDir = basename(opts.dataDir) === 'runtime' ? opts.dataDir : join(opts.dataDir, 'runtime')
    this.bins = { claude: opts.bins?.claude ?? 'claude', codex: opts.bins?.codex ?? 'codex', gemini: opts.bins?.gemini ?? 'gemini', git: opts.bins?.git ?? 'git' }
    this.passport = new PassportClient({ log: this.ports.log })
  }

  private get started(): Started {
    if (!this.s) throw new CloudRuntimeError('unavailable', this.failed ?? 'The agent runtime is not running')
    return this.s
  }

  async start(): Promise<void> {
    if (this.s) return
    try {
      mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 })
      const agentUser = this.opts.agentUser ?? null
      const sandbox = new ProcessSandbox({ runtimeDir: this.runtimeDir, workspaceDir: this.opts.workspaceDir, agentUser })
      const db = openDatabase(join(this.runtimeDir, 'engine.db'))
      const redact = (s: string) => this.redactor.redact(s)
      const store = createEngineStore(db, { describe: () => () => '', redact, now: this.now })
      const settingsStore = new Store(db)
      const dir = bundleDir()
      let host: EngineHost | null = null
      const forum = new CloudForum({
        dbPath: join(this.runtimeDir, 'forum.db'),
        spawnRoot: join(this.runtimeDir, 'forum-shims'),
        agentUser,
        cliScript: join(dir, 'forum-cli.mjs'),
        redact,
        now: this.now,
        ports: this.ports,
        cloudRun: (engineRunId) => host?.cloudRunOf(engineRunId) ?? null
      })
      const gateways = new CompanyGateways({
        dir: join(this.runtimeDir, 'gateway'),
        bundleDir: dir,
        baseEnv: () => sandbox.baseEnv(),
        companyDir: (id) => sandbox.companyDir(id),
        addSecret: (v) => this.redactor.add(v),
        agentUser
      })
      host = new EngineHost({
        runtimeDir: this.runtimeDir,
        sandbox,
        bins: this.bins,
        ports: this.ports,
        redactor: this.redactor,
        gateways,
        passport: this.passport,
        forum,
        db,
        store,
        // the control plane owns concurrency and schedules; the engine never fires its own
        settings: () => ({ ...settingsStore.getSettings(), concurrency: 16, schedulesPaused: true }),
        now: this.now
      })
      await forum.start()
      await gateways.start()
      await host.init()
      const loop = new ScheduleLoop({
        schedules: () => this.ports.cloudSchedules(),
        requestRun: (r) => this.ports.requestRun({ companyId: r.companyId, trigger: 'schedule', target: { kind: 'workflow', workflowId: r.workflowId, inputs: r.inputs }, scheduleId: r.scheduleId, slot: r.slot }),
        markFired: (id, slot, runId) => this.ports.markScheduleFired(id, slot, runId),
        now: this.now,
        log: this.ports.log
      })
      this.s = { db, sandbox, forum, gateways, host, loop }
      this.failed = null
      loop.start()
      void this.cliVersionsCached().catch(() => {})
    } catch (e) {
      this.failed = `The agent runtime could not start: ${e instanceof Error ? e.message : String(e)}`
      this.ports.log.error(this.redactor.redact(this.failed))
      throw e
    }
  }

  async close(): Promise<void> {
    const s = this.s
    if (!s) return
    this.s = null
    this.failed = 'The agent runtime is stopped'
    s.loop.stop()
    await s.host.shutdown()
    await s.gateways.close()
    await s.forum.shutdown()
    s.db.close()
  }

  health(): { status: 'ok' | 'degraded' | 'down'; detail: string | null } {
    if (!this.s) return { status: 'down', detail: this.failed ?? 'Starting' }
    const v = this.versions?.value
    if (v) {
      const missing = (['claude', 'codex', 'gemini'] as const).filter((a) => !v[a])
      if (missing.length === 3) return { status: 'degraded', detail: 'No agent CLI is installed in this cloud' }
      if (missing.length) return { status: 'degraded', detail: `${missing.map((a) => CLI_LABEL[a]).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed in this cloud` }
    }
    return { status: 'ok', detail: null }
  }

  async ensureCompany(c: { workspaceId: string; companyId: string; name: string; slug: string }): Promise<void> {
    const s = this.started
    s.sandbox.companyDir(c.companyId)
    s.forum.ensureCompany({ companyId: c.companyId, name: c.name, slug: c.slug })
  }

  async removeCompany(_workspaceId: string, companyId: string): Promise<void> {
    const s = this.started
    s.gateways.remove(companyId)
    s.forum.removeCompany(companyId)
    s.sandbox.removeCompanyDir(companyId)
  }

  validateWorkflow(companyId: string, file: unknown): string[] {
    return this.started.host.validateWorkflow(companyId, file)
  }

  startRun(req: Parameters<CloudRuntime['startRun']>[0]): void {
    if (!this.s) {
      this.ports.runStatus(req.runId, 'failed', this.failed ?? 'The agent runtime is not running')
      return
    }
    this.s.host.startRun(req)
  }

  cancelRun(runId: string): Promise<void> {
    return this.started.host.cancelRun(runId)
  }

  runDetail(runId: string) {
    return this.started.host.runDetail(runId)
  }

  runLog(runId: string, stepId: string | null, tail: number): string[] {
    return this.started.host.runLog(runId, stepId, tail)
  }

  artifactPath(runId: string, name: string): string | null {
    return this.started.host.artifactPath(runId, name)
  }

  async answerAsk(askId: string, answer: string): Promise<void> {
    const r = this.started.forum.answer(askId, answer)
    if (r.refused) this.ports.log.info('runtime: resume after an answer was refused', { askId, reason: r.refused })
  }

  async syncRepo(companyId: string, repo: Parameters<CloudRuntime['syncRepo']>[1]): Promise<{ ok: boolean; detail: string | null }> {
    const s = this.started
    this.redactor.add(repo.token)
    try {
      return await syncRepo(
        {
          git: this.bins.git,
          baseEnv: () => s.sandbox.baseEnv(),
          companyDir: (id) => s.sandbox.companyDir(id),
          tmpDir: join(this.runtimeDir, 'tmp'),
          hooksDir: join(this.runtimeDir, 'push-guard'),
          redact: (t) => this.redactor.redact(t),
          user: s.sandbox.spawnUser()
        },
        companyId,
        repo
      )
    } catch (e) {
      return { ok: false, detail: this.redactor.redact(e instanceof Error ? e.message : String(e)) }
    }
  }

  private async cliVersionsCached(): Promise<Partial<Record<AdapterId, string>>> {
    if (this.versions && Date.now() - this.versions.at < VERSIONS_TTL_MS) return this.versions.value
    const value = await cliVersions({ sandbox: this.started.sandbox, bins: this.bins })
    this.versions = { at: Date.now(), value }
    return value
  }

  providers: CloudRuntime['providers'] = {
    test: (material, opts) => {
      this.redactor.add(material.value)
      return testProvider(material, opts, { sandbox: this.started.sandbox, bins: this.bins, now: this.now, redactor: this.redactor })
    },
    cliVersions: () => this.cliVersionsCached(),
    // server-side device login is not in v1 (CLOUD.md §14): Codex signs in on the Mac
    startDeviceLogin: async () => {
      throw notInV1('Server-side device login')
    },
    deviceLoginStatus: () => null,
    cancelDeviceLogin: () => {}
  }

  // v1 has no Forum client in the cloud (CLOUD.md §7.6): a run's posts are in its run detail
  forum: CloudRuntime['forum'] = {
    channels: () => {
      throw notInV1('The cloud Forum')
    },
    messages: () => {
      throw notInV1('The cloud Forum')
    },
    post: () => {
      throw notInV1('The cloud Forum')
    }
  }

  triggers: CloudRuntime['triggers'] = {
    reloadSchedules: () => this.s?.loop.reload(),
    // webhooks are not in v1 (CLOUD.md §7.7, §14)
    webhook: async () => ({ status: 501, runId: null, detail: 'Webhooks are not in Principia Cloud v1' })
  }
}

export const createCloudRuntime: CreateCloudRuntime = (opts) => new Runtime(opts)
