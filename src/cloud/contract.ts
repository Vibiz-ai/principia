/**
 * Principia Cloud, in-process contract between the control plane (src/cloud/control, package BE) and the agent
 * runtime (src/cloud/agent, package AI). docs/CLOUD.md §4 and §9.
 *
 * v1 runs both in one Node process (one container). The seams are these two interfaces so the runtime can later move
 * to separate workers (one per workspace, or a microVM per run) behind the same calls over an internal HTTP protocol
 * (CLOUD.md §14). Frozen for the v1 build; after it, additive changes only, owner AI for CloudRuntime and BE for
 * ControlPorts, recorded in CLOUD.md §15. No Electron imports.
 */
import type { AdapterId, Id, ISODate } from '../shared/types'
import type {
  CloudAdapter,
  CloudAsk,
  CloudForumChannel,
  CloudForumMessage,
  CloudRunDetail,
  CloudRunSummary,
  CloudRunStatus,
  CloudRunStep,
  CloudRunTrigger,
  CloudScheduleSpec,
  DeviceLoginStart,
  DeviceLoginStatus,
  ProviderCredentialKind,
  ProviderTestResponse,
  StartRunRequest
} from '../shared/cloud'

// ---------- what the control plane hands the runtime for one run (decrypted, in memory only) ----------

export interface ProviderMaterial {
  credentialId: Id
  adapter: CloudAdapter
  kind: ProviderCredentialKind
  /** the secret: token, key, or file text (auth.json, service account JSON). Never logged, never persisted by the runtime outside the run's 0600 home. */
  value: string
}

export interface RepoMaterial {
  id: Id
  name: string
  url: string
  branch: string | null
  /** short-lived: a GitHub App installation token (1 h) or the PAT; null for public repos. Given to git via GIT_ASKPASS, never env or argv. */
  token: string | null
}

/** A gateway connection with its credentials, exactly what GatewayService.save takes, minus roots (the runtime sets them). */
export interface ConnectionMaterial {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** stdio env / http headers. For OAuth connections the control plane passes a fresh `Authorization: Bearer` header. */
  credentials: Record<string, string>
}

/** Open Passport connected by default (CLOUD.md §7.1). */
export interface PassportMaterial {
  /** internal base URL the runtime reaches (http://passport:8787 in compose) */
  internalUrl: string
  /** public base URL (for links only) */
  publicUrl: string
  passportId: string
  /** a grant for this company's passport: read:all + write:proposals + write:taste; trusted per company setting */
  token: string
}

export interface RunMaterials {
  providers: ProviderMaterial[]
  repos: RepoMaterial[]
  connections: ConnectionMaterial[]
  passport: PassportMaterial | null
  /** company keys (CLOUD.md §7.3): NAME -> value, offered to steps the same way the desktop vault does */
  secrets: Record<string, string>
}

export interface RuntimeRunRequest {
  runId: Id // 'crun_…', created by the control plane
  workspaceId: Id
  companyId: Id
  companyName: string
  trigger: CloudRunTrigger
  target: StartRunRequest
  /** the workflow file (.hive.json object) for kind 'workflow', already validated by the control plane's sync */
  workflowFile: unknown | null
  /** wall-clock cap from quotas */
  timeoutMs: number
  /** text that must be treated as untrusted (webhook payload fields, Forum guests): the runtime wraps it with a note */
  untrustedInputs: string[]
  materials: RunMaterials
}

// ---------- the runtime (package AI implements; control plane calls) ----------

export interface CloudRuntime {
  readonly version: string
  readonly sandbox: 'process' | 'docker' | 'microvm'
  start(): Promise<void>
  /** cancels running runs as 'canceled' with reason 'shutdown', closes gateways and the Forum db */
  close(): Promise<void>
  health(): { status: 'ok' | 'degraded' | 'down'; detail: string | null }

  /** idempotent: company folders under the workspace, the cloud Forum's company (members from seats in the workflow files later) */
  ensureCompany(c: { workspaceId: Id; companyId: Id; name: string; slug: string }): Promise<void>
  /** removes the company's folders and Forum rows (the control plane already removed its records) */
  removeCompany(workspaceId: Id, companyId: Id): Promise<void>

  /** validates a workflow file for the cloud (cwd inside the workspace, profiles prof_claude/prof_codex/prof_gemini, no worktree). [] = runnable. */
  validateWorkflow(companyId: Id, file: unknown): string[]

  /** starts now (the control plane already checked quotas and capacity). Must not throw for run failures: they arrive as events. */
  startRun(req: RuntimeRunRequest): void
  cancelRun(runId: Id): Promise<void>
  /** steps and artifacts from the runtime's own run store */
  runDetail(runId: Id): Omit<CloudRunDetail, keyof CloudRunSummary> | null
  /** redacted log lines of a step, newest last */
  runLog(runId: Id, stepId: Id | null, tail: number): string[]
  /** absolute path of an artifact file, or null (the control plane streams it after its own auth) */
  artifactPath(runId: Id, name: string): string | null
  /** the human answered an ask: wake the parked agent (a new run with trigger 'answer' is requested through ports.requestRun if the original ended) */
  answerAsk(askId: Id, answer: string): Promise<void>

  /** repos: clone or fetch into the company folder */
  syncRepo(companyId: Id, repo: RepoMaterial): Promise<{ ok: boolean; detail: string | null }>

  providers: {
    /** cheap check: CLI present + credential accepted (CLOUD.md §7.2; may spend one tiny request on the user's plan when `live`) */
    test(material: ProviderMaterial, opts: { live: boolean }): Promise<ProviderTestResponse>
    cliVersions(): Promise<Partial<Record<AdapterId, string>>>
    /** Codex ChatGPT device login in a throwaway CODEX_HOME. On success ports.saveProviderCredential receives the auth.json. */
    startDeviceLogin(adapter: 'codex'): Promise<DeviceLoginStart>
    deviceLoginStatus(loginId: Id): DeviceLoginStatus | null
    cancelDeviceLogin(loginId: Id): void
  }

  forum: {
    channels(companyId: Id): CloudForumChannel[]
    messages(companyId: Id, channelId: Id, opts: { before?: Id | null; limit: number }): CloudForumMessage[]
    /** posts as the workspace owner (human member) */
    post(companyId: Id, channelId: Id, text: string, threadId: Id | null): CloudForumMessage
  }

  triggers: {
    /** the control plane's schedule set changed (sync, pause): recompute next fires. Cron math reuses src/main/engine/scheduler.ts. */
    reloadSchedules(): void
    /**
     * A webhook delivery the control plane authenticated route-wise. The runtime verifies the signature (verify
     * 'github'), maps payload -> inputs (untrusted), and asks ports.requestRun. Returns the HTTP status to answer.
     */
    webhook(hook: { id: Id; companyId: Id; workflowId: Id; verify: 'secret' | 'github'; secret: string; inputs: Record<string, string> }, req: { headers: Record<string, string>; rawBody: Buffer }): Promise<{ status: 202 | 400 | 401 | 422 | 501; runId: Id | null; detail: string }>
  }
}

// ---------- the control plane's side (package BE implements; runtime calls) ----------

export interface ScheduleRow extends CloudScheduleSpec {
  id: Id
  companyId: Id
  lastFireAt: ISODate | null
}

export interface ControlPorts {
  /** run lifecycle, persisted by the control plane (cloud_runs) and fanned out on /v1/events */
  runStatus(runId: Id, status: CloudRunStatus, summary: string | null): void
  runStep(runId: Id, step: CloudRunStep): void
  runLog(runId: Id, stepId: Id, lines: string[]): void
  /** usage ledger (CLOUD.md §10); usd null for subscription credentials */
  usage(e: { runId: Id; companyId: Id; adapter: AdapterId; inputTokens: number; outputTokens: number; usd: number | null }): void
  /** an agent asked a human (Needs you). Returns the ask id. */
  openAsk(a: Omit<CloudAsk, 'id' | 'status' | 'answer' | 'createdAt'>): Id
  /** the runtime wants a run (schedule fire, webhook, answer resume). The control plane applies quotas/pause and returns the run id or null with the reason. */
  requestRun(r: { companyId: Id; trigger: CloudRunTrigger; target: StartRunRequest; untrustedInputs?: string[]; scheduleId?: Id; slot?: ISODate }): { runId: Id | null; refused: string | null }
  /** schedules placed in the cloud and enabled, of companies not paused */
  cloudSchedules(): ScheduleRow[]
  markScheduleFired(scheduleId: Id, slot: ISODate, runId: Id | null): void
  /** a file credential changed during a run (codex auth.json token refresh): re-encrypt and store */
  saveProviderCredential(c: { credentialId: Id | null; adapter: CloudAdapter; kind: ProviderCredentialKind; value: string }): void
  /**
   * An account's health as a real run saw it (CLOUD.md §7.2, §7.9; additive). 'expired': the CLI rejected the sign-in
   * (401, signed out) and only a new one fixes it. 'limited': it hit its usage limit (`detail` says when it resets).
   * 'ok': a step on it passed, which clears an earlier 'limited' or 'failing'. Ignored when `credentialId` is no longer
   * the adapter's current credential (the user replaced it during the run). Optional so older runtimes still compile.
   */
  providerStatus?(c: { credentialId: Id; adapter: CloudAdapter; status: 'ok' | 'expired' | 'limited'; detail: string | null }): void
  /** forum activity for /v1/events */
  forumEvent(companyId: Id, channelId: Id, messageId: Id): void
  /** audit trail (never secret material) */
  audit(action: string, companyId: Id | null, detail: Record<string, string | number | boolean | null>): void
  /** every secret value currently known (provider tokens, keys, connection credentials): the runtime adds them to its redactor */
  knownSecrets(): string[]
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void }
}

export interface RuntimeOptions {
  /** /data: runtime state (engine db, forum db, run homes, logs, artifacts) */
  dataDir: string
  /** /workspace: company folders and repo clones (`<workspace>/<companyId>/…`) */
  workspaceDir: string
  ports: ControlPorts
  /** default 'process' (CLOUD.md §7.8) */
  sandbox?: 'process'
  /**
   * CLOUD.md §7.8: every agent process (steps, their tools, git for repos) runs as this uid/gid, never as the control
   * plane's. The control plane's secrets (/secrets, control.db) and the runtime's own dbs stay unreadable to it.
   * Needs a process that may change uid (root with CAP_SETUID/SETGID in the image). Absent = same user (tests, dev).
   */
  agentUser?: { uid: number; gid: number } | null
  /** test seams: replace CLI binaries (fake claude/codex/gemini scripts) and the clock */
  bins?: Partial<Record<AdapterId | 'git', string>>
  now?: () => Date
}

/** Package AI exports this from src/cloud/agent/index.ts. */
export type CreateCloudRuntime = (opts: RuntimeOptions) => CloudRuntime
