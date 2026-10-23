/**
 * Principia Cloud: the HTTP contract between the control plane (src/cloud/control, package BE), the desktop Cloud pane
 * (src/main/cloud + renderer, package FE) and the web console (src/cloud/console, package FE). docs/CLOUD.md §6.
 *
 * Frozen for the v1 build. Owner after the build: BE. Changes are additive only (new optional fields, new routes) and
 * are recorded in docs/CLOUD.md §15. Types only plus a few constants: no Node, no Electron, no DOM imports.
 */
import type { AdapterId, Id, ISODate, ScheduleWhen } from './types'

export const CLOUD_API_VERSION = 1

// ---------- tokens and ids (CLOUD.md §5) ----------

/** Prefixes. Tokens are 32 random bytes base64url after the prefix; the server stores only their SHA-256. */
export const CLOUD_TOKEN_PREFIX = {
  /** desktop device token: `Authorization: Bearer pdt_…` */
  device: 'pdt_',
  /** one-time console login link token (10 minutes) */
  loginLink: 'pll_',
  /** console session cookie value (`principia_session`, HttpOnly, SameSite=Strict, Secure behind HTTPS) */
  session: 'pss_',
  /** webhook ingress secret (in the URL path, or the HMAC key for `verify: 'github'`) */
  webhook: 'whk_',
  /** per-run token the runtime gives a run's tools (Forum HTTP, artifacts); never leaves the box */
  run: 'prt_'
} as const

/** Pairing codes: 8 characters from this alphabet (no 0/O/1/I), shown as XXXX-XXXX, single use, 10 minutes. */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const PAIRING_TTL_MS = 10 * 60_000
export const LOGIN_LINK_TTL_MS = 10 * 60_000
export const SESSION_TTL_MS = 12 * 60 * 60_000
/** Console write requests carry this header with the value from GET /v1/me (double-submit CSRF). */
export const CSRF_HEADER = 'x-principia-csrf'

// ---------- errors ----------

export type CloudErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict' // stale baseRev, duplicate
  | 'quota_exceeded'
  | 'paused' // workspace or company paused
  | 'payload_too_large'
  | 'rate_limited'
  | 'unavailable' // passport host or runtime down
  | 'internal'
  | 'not_in_v1' // 501: the route is in the contract but ships later (CLOUD.md §14)

/** Every non-2xx response body. `message` never contains secret material. */
export interface CloudError {
  error: CloudErrorCode
  message: string
  /** 409 on sync: the server's current revision */
  rev?: number
}

// ---------- identity (CLOUD.md §5) ----------

export interface CloudWorkspace {
  id: Id // 'ws_…'
  name: string
  createdAt: ISODate
  /** kill switch: no new runs, triggers parked, running runs canceled when it was set */
  paused: boolean
  quotas: CloudQuotas
  /** public origin the control plane believes it serves (PRINCIPIA_PUBLIC_URL), for links and OAuth callbacks */
  publicUrl: string
  /** self-host or managed; managed-only fields stay absent on self-host */
  mode: 'self-host' | 'managed'
}

export interface CloudDevice {
  id: Id // 'dev_…'
  name: string // "Lautaro's MacBook Pro"
  platform: string // 'darwin-arm64'
  createdAt: ISODate
  lastSeenAt: ISODate | null
  current?: boolean
}

export interface PairStartResponse {
  /** XXXX-XXXX */
  code: string
  expiresAt: ISODate
}
export interface PairCompleteRequest {
  code: string
  deviceName: string
  platform: string
}
export interface PairCompleteResponse {
  /** shown once; the desktop stores it encrypted (safeStorage), never in a synced folder */
  deviceToken: string
  device: CloudDevice
  workspace: CloudWorkspace
}

export interface MeResponse {
  workspace: CloudWorkspace
  /** exactly one of device / session is set */
  device: CloudDevice | null
  session: { id: Id; expiresAt: ISODate } | null
  /** console only: echo in CSRF_HEADER on writes */
  csrf: string | null
}

export interface LoginLinkResponse {
  /** `<publicUrl>/console/login?t=pll_…` */
  url: string
  expiresAt: ISODate
}

// ---------- quotas, usage, audit (CLOUD.md §10) ----------

export interface CloudQuotas {
  /** runs executing at once in the workspace (default 2, max 16) */
  maxConcurrentRuns: number
  /** per company, rolling 24 h (default 200) */
  maxRunsPerDay: number
  /** per company, rolling 24 h of run wall-clock minutes (default 600) */
  maxRunMinutesPerDay: number
  /** hard cap per run (default 60, max 1440) */
  runTimeoutMinutes: number
  /** per webhook, per minute (default 30) */
  webhookPerMinute: number
  /** optional spend cap for API-key providers, from harness-reported cost (USD, per company, calendar month) */
  monthlyApiUsdPerCompany: number | null
}

export const DEFAULT_QUOTAS: CloudQuotas = {
  maxConcurrentRuns: 2,
  maxRunsPerDay: 200,
  maxRunMinutesPerDay: 600,
  runTimeoutMinutes: 60,
  webhookPerMinute: 30,
  monthlyApiUsdPerCompany: null
}

export interface UsageSummary {
  from: ISODate
  to: ISODate
  companies: {
    companyId: Id
    runs: number
    runMinutes: number
    /** harness-reported, API-key runs only; subscription runs report tokens but no dollars */
    apiUsd: number
    inputTokens: number
    outputTokens: number
  }[]
}

export interface AuditEntry {
  at: ISODate
  actor: { kind: 'device' | 'session' | 'webhook' | 'schedule' | 'system'; id: Id | null; name: string | null }
  action: string // 'provider.credential.set', 'run.start', 'company.create', …
  companyId: Id | null
  target: string | null
  /** never secret material */
  detail: Record<string, string | number | boolean | null>
}

// ---------- companies and the Passport (CLOUD.md §7.1) ----------

export interface CloudCompany {
  /** the desktop company id, kept as is: one id across desktop, cloud and Forum */
  id: Id
  name: string
  slug: string
  color: string | null
  createdAt: ISODate
  paused: boolean
  passport: CloudPassportLink | null
  /** counts for the pane header */
  counts: { workflows: number; schedules: number; repos: number; connections: number; openAsks: number; running: number }
  /** CLOUD.md §7.9: computed by the control plane from stored data only (never by running an agent) */
  readiness?: { ready: boolean; fixes: CloudFix[] }
  /** CLOUD.md §7.1: whether cloud agents' passport writes wait for review ('propose', default) or apply ('trusted'). Set with PATCH. */
  cloudAgentWrites?: 'propose' | 'trusted'
}

/** One thing to fix before a cloud company can run unattended. The desktop maps `kind` to its one-click action. */
export interface CloudFix {
  kind: 'account' | 'key' | 'connection' | 'repo' | 'passport' | 'workflow'
  /** adapter, secret name, connection id, repo id, passport id or workflow id */
  ref: string
  /** a plain founder sentence: "Morning brief uses Codex. Sign in with ChatGPT." */
  message: string
  /** additive: 'wait' = nothing to click (an account at its usage limit resets on its own) */
  action?: 'wait'
}

/** Open Passport connected by default: every cloud company has one passport on the workspace's host. */
export interface CloudPassportLink {
  /** public base URL of the Open Passport host (desktop, ChatGPT, Claude.ai reach this) */
  hostUrl: string
  passportId: string
  /** `<hostUrl>/v1/passports/<id>/mcp`: the remote MCP URL to paste into other apps */
  mcpUrl: string
  revision: number | null
  pendingProposals: number
}

export interface PutCompanyRequest {
  name: string
  slug: string
  color?: string | null
  /** base64 of the company's `.passport.zip` (exportOpenPassport). Required on first create; ignored after. */
  passportBundle?: string
  /** first create only; later changes go through PATCH (default 'propose') */
  cloudAgentWrites?: 'propose' | 'trusted'
}

/** PATCH /v1/companies/:cid. The console may only send `paused`. */
export interface PatchCompanyRequest {
  paused?: boolean
  cloudAgentWrites?: 'propose' | 'trusted'
}
export interface PutCompanyResponse {
  company: CloudCompany
  /**
   * Present only when the passport was just created (or `?rotateDesktopGrant=1`): a `write:all` Open Passport key for
   * this desktop. The desktop writes it into its PassportSync config (src/main/memory/openPassportSync.ts) and syncs.
   */
  desktopPassportGrant: { url: string; passportId: string; token: string } | null
}

export interface PassportProposal {
  id: string
  kind: 'delta' | 'taste' | 'conflict'
  app: string
  created: ISODate
  /** human summary built by the control plane from the payload ("3 facts for Marketing") */
  summary: string
}

// ---------- model accounts: Claude, Codex, Gemini (CLOUD.md §7.2) ----------

/** The adapters the cloud runs in v1. Cursor is later (CLOUD.md §14). Shell is always available. */
export const CLOUD_ADAPTERS = ['claude', 'codex', 'gemini'] as const satisfies readonly AdapterId[]
export type CloudAdapter = (typeof CLOUD_ADAPTERS)[number]

export type ProviderCredentialKind =
  /** `claude setup-token` output (1 year, Pro/Max/Team/Enterprise subscription, inference only) -> CLAUDE_CODE_OAUTH_TOKEN */
  | 'claude_oauth_token'
  /** Claude Console API key -> ANTHROPIC_API_KEY (API billing) */
  | 'anthropic_api_key'
  /** OpenAI API key -> `codex login --with-api-key` into the run's CODEX_HOME (API billing; OpenAI's recommended automation path) */
  | 'openai_api_key'
  /** ChatGPT sign-in cache (`~/.codex/auth.json`), from device login on the server or an upload; refreshed and written back after each run */
  | 'codex_auth_json'
  /** Enterprise Codex access token -> `codex login --with-access-token` */
  | 'codex_access_token'
  /** Gemini API key (AI Studio) -> GEMINI_API_KEY */
  | 'gemini_api_key'
  /** Vertex service account JSON -> GOOGLE_APPLICATION_CREDENTIALS file + GOOGLE_GENAI_USE_VERTEXAI */
  | 'google_service_account'

export const PROVIDER_CREDENTIAL_KINDS: Record<CloudAdapter, readonly ProviderCredentialKind[]> = {
  claude: ['claude_oauth_token', 'anthropic_api_key'],
  codex: ['openai_api_key', 'codex_auth_json', 'codex_access_token'],
  gemini: ['gemini_api_key', 'google_service_account']
}

/** Subscription credentials bill the user's own plan; API credentials bill per token. Shown next to every account. */
export const SUBSCRIPTION_KINDS: readonly ProviderCredentialKind[] = ['claude_oauth_token', 'codex_auth_json', 'codex_access_token']

export type ProviderStatus = 'missing' | 'ok' | 'expiring' | 'expired' | 'failing'

export interface ProviderAccount {
  adapter: CloudAdapter
  credential: {
    id: Id // 'cred_…'
    kind: ProviderCredentialKind
    /** user label, or derived: "Claude subscription (token)", "OpenAI API key …a1b2" is NOT allowed: no key fragments */
    label: string
    createdAt: ISODate
    lastUsedAt: ISODate | null
    /** claude_oauth_token: createdAt + 365 d; codex_auth_json: unknown (refreshes) */
    expiresAt: ISODate | null
  } | null
  status: ProviderStatus
  /** last failure, redacted ("401 from Anthropic: token rejected") */
  detail: string | null
  /** CLI version installed in the runtime image */
  cliVersion: string | null
}

export interface PutProviderCredentialRequest {
  kind: ProviderCredentialKind
  /** the token, key or file content (JSON text). Write-only: never returned by any route. Max 64 KB. */
  value: string
  label?: string
}

/** Codex ChatGPT device login run on the server (`codex login --device-auth` in a throwaway CODEX_HOME). */
export interface DeviceLoginStart {
  loginId: Id // 'lgn_…'
  verificationUrl: string
  userCode: string
  expiresAt: ISODate
}
export interface DeviceLoginStatus {
  loginId: Id
  status: 'waiting' | 'succeeded' | 'failed' | 'expired' | 'canceled'
  detail: string | null
}

export interface ProviderTestResponse {
  ok: boolean
  /** "claude 2.1.290 · subscription token accepted" or the redacted failure */
  detail: string
}

// ---------- company keys, repos, connectors (CLOUD.md §7.3-7.5) ----------

export interface CloudSecretMeta {
  name: string // ENV_NAME
  createdAt: ISODate
  updatedAt: ISODate
  lastUsedAt: ISODate | null
}

export type RepoCredential =
  | { kind: 'github_pat'; value: string } // fine-grained PAT, write-only
  | { kind: 'github_app'; installationId: number } // the workspace's GitHub App (PUT /v1/github/app)
  | { kind: 'public' }

export interface CloudRepo {
  id: Id // desktop repo id when moved from the desktop, else 'repo_…'
  name: string
  /** https://github.com/owner/name(.git) only in v1 */
  url: string
  branch: string | null
  credentialKind: RepoCredential['kind']
  /** last clone/fetch */
  syncedAt: ISODate | null
  status: 'pending' | 'ready' | 'failed'
  detail: string | null
}
export interface PutRepoRequest {
  name: string
  url: string
  branch?: string | null
  credential: RepoCredential
}

export interface GithubAppConfigRequest {
  appId: number
  slug: string
  /** PEM, write-only */
  privateKey: string
}
export interface GithubAppStatus {
  configured: boolean
  appId: number | null
  slug: string | null
  /** https://github.com/apps/<slug>/installations/new */
  installUrl: string | null
}

export interface CloudConnection {
  id: string // [a-zA-Z0-9_-]{1,64}; 'passport' is reserved for the built-in Open Passport connection
  name: string
  transport: 'stdio' | 'http'
  /** stdio: a command installed in the runtime image; http: https URL (no private addresses) */
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  authentication: 'none' | 'headers' | 'oauth'
  /** oauth only */
  authStatus: 'disconnected' | 'connecting' | 'connected' | 'error' | null
  hasCredentials: boolean
  /** the built-in passport connection: not editable, not deletable */
  builtIn: boolean
}
export interface PutConnectionRequest {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  authentication: 'none' | 'headers' | 'oauth'
  /** stdio env or http headers; write-only; omit to keep the stored ones */
  credentials?: Record<string, string>
}
export interface AuthorizeConnectionResponse {
  /** open in a browser; the provider redirects to `<publicUrl>/oauth/connectors/callback` */
  authorizeUrl: string
}

// ---------- sync: workflows and schedules (CLOUD.md §8) ----------

export type Placement = 'local' | 'cloud'

export interface PutWorkflowRequest {
  /** the desktop's `.hive.json` export object ({ hive: 'workflow', version: 1, workflow }) */
  file: unknown
  /** the cloud rev this edit was based on; null = create. Stale -> 409 with the current rev. */
  baseRev: number | null
  /**
   * Key names the desktop knows this workflow uses (its vault names found in the steps, CLOUD.md §7.9). Readiness
   * flags any of them the company has not sent, next to the names the cloud detects in the steps itself. Additive.
   */
  keys?: string[]
}
export interface CloudWorkflow {
  id: Id // the desktop workflow id
  companyId: Id
  name: string
  rev: number
  updatedAt: ISODate
  /** validation against the cloud workspace (cwd, profiles, worktree): empty = runnable */
  problems: string[]
}

export interface CloudScheduleSpec {
  name: string
  when: ScheduleWhen
  /** v1: workflow targets only */
  target: { kind: 'workflow'; workflowId: Id; inputs: Record<string, string> }
  enabled: boolean
}
export interface PutScheduleRequest {
  schedule: CloudScheduleSpec
  placement: Placement
  baseRev: number | null
}
export interface CloudSchedule extends CloudScheduleSpec {
  id: Id // the desktop schedule id
  companyId: Id
  placement: Placement
  rev: number
  nextFireAt: ISODate | null
  lastFireAt: ISODate | null
  lastRunId: Id | null
}

/** GET /v1/sync/changes?since=<cursor>: what the desktop polls (every 30 s while linked, or on evt from SSE). */
export interface SyncChanges {
  cursor: string
  runs: CloudRunSummary[]
  asks: CloudAsk[]
  /** passport revision per company, so the desktop knows to run PassportSync */
  passports: { companyId: Id; revision: number }[]
  /** schedules whose rev changed on the server (fired, edited in the console later) */
  schedules: CloudSchedule[]
  /** a collection had more changes than one answer carries: ask again at once from `cursor` */
  more?: boolean
}

// ---------- runs, asks, events (CLOUD.md §9) ----------

export type CloudRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'canceled' | 'needs_input'
export type CloudRunTrigger = 'manual' | 'schedule' | 'webhook' | 'desktop' | 'console' | 'answer'

export type StartRunRequest =
  | { kind: 'workflow'; workflowId: Id; inputs?: Record<string, string> }
  | { kind: 'prompt'; adapter: CloudAdapter; prompt: string; repoId?: Id | null }

export interface CloudRunSummary {
  id: Id // 'crun_…'
  companyId: Id
  kind: 'workflow' | 'prompt'
  title: string
  status: CloudRunStatus
  trigger: CloudRunTrigger
  adapters: CloudAdapter[]
  createdAt: ISODate
  startedAt: ISODate | null
  endedAt: ISODate | null
  /** one redacted line: the failure, the ask, or the last output line */
  summary: string | null
}
export interface CloudRunStep {
  id: Id
  nodeId: string | null
  title: string
  adapter: AdapterId
  status: 'queued' | 'running' | 'passed' | 'failed' | 'canceled' | 'skipped' | 'needs_input'
  startedAt: ISODate | null
  endedAt: ISODate | null
  usage: { inputTokens: number; outputTokens: number; usd: number | null } | null
}
export interface CloudRunDetail extends CloudRunSummary {
  steps: CloudRunStep[]
  artifacts: { name: string; bytes: number; url: string }[]
  /** the Forum messages this run posted (v1 has no cloud Forum client, CLOUD.md §7.6) */
  forumPosts?: CloudForumMessage[]
}

/** Needs you: an agent asked a human (forum_ask parked, or a step needs input). Answering resumes the agent. */
export interface CloudAsk {
  id: Id // 'cask_…'
  companyId: Id
  runId: Id | null
  agentName: string | null // persona "Marcus · Copywriter"
  question: string
  options: string[]
  createdAt: ISODate
  status: 'open' | 'answered' | 'expired'
  answer: string | null
}

/** GET /v1/events (SSE, `event: <kind>`, `data: <json>`). One stream for desktop and console. */
export type CloudEvent =
  | { kind: 'run'; run: CloudRunSummary }
  | { kind: 'step'; runId: Id; step: CloudRunStep }
  | { kind: 'log'; runId: Id; stepId: Id; lines: string[] } // redacted, only to subscribers of ?runId=
  | { kind: 'ask'; ask: CloudAsk }
  | { kind: 'forum'; companyId: Id; channelId: Id; messageId: Id }
  | { kind: 'provider'; account: ProviderAccount }
  | { kind: 'workspace'; workspace: CloudWorkspace }

// ---------- Forum in the cloud (CLOUD.md §7.6) ----------

export interface CloudForumChannel {
  id: Id
  name: string | null
  kind: 'public' | 'private' | 'dm' | 'group'
  unread: number
}
export interface CloudForumMessage {
  id: Id
  channelId: Id
  threadId: Id | null
  author: { kind: 'human' | 'agent' | 'guest'; name: string; role: string | null }
  kind: 'text' | 'ask' | 'proposal' | 'system'
  text: string
  createdAt: ISODate
  replies: number
}
export interface ForumPostRequest {
  text: string
  /** reply in this thread (root message id) */
  threadId?: Id | null
}

// ---------- webhooks (CLOUD.md §7.7) ----------

export interface PutHookRequest {
  name: string
  workflowId: Id
  /** 'secret': the secret is the last path segment; 'github': HMAC-SHA256 X-Hub-Signature-256 with the secret */
  verify: 'secret' | 'github'
  /** workflow input name -> dotted path into the JSON payload ("pull_request.html_url"); values are untrusted text */
  inputs: Record<string, string>
  enabled: boolean
}
export interface CloudHook extends Omit<PutHookRequest, 'inputs'> {
  id: Id // 'hook_…'
  companyId: Id
  inputs: Record<string, string>
  /** `<publicUrl>/hooks/<id>` (verify 'github') or `<publicUrl>/hooks/<id>/<secret>` (shown once, at create) */
  url: string
  lastDeliveryAt: ISODate | null
  lastStatus: 'accepted' | 'rejected' | 'rate_limited' | null
}
export interface PutHookResponse {
  hook: CloudHook
  /** only on create or `?rotateSecret=1` */
  secret: string | null
}

// ---------- the workspace summary the Cloud pane opens on ----------

export interface WorkspaceSummary {
  workspace: CloudWorkspace
  companies: CloudCompany[]
  providers: ProviderAccount[]
  runtime: { status: 'ok' | 'degraded' | 'down'; version: string; sandbox: 'process' | 'docker' | 'microvm'; detail: string | null }
  passportHost: { status: 'ok' | 'down'; url: string }
  usage24h: { runs: number; runMinutes: number }
}

// ---------- routes (CLOUD.md §6). `:x` are path params. ----------

export const CLOUD_ROUTES = {
  health: 'GET /v1/health',
  pairStart: 'POST /v1/pair/start',
  pairComplete: 'POST /v1/pair/complete',
  me: 'GET /v1/me',
  loginLink: 'POST /v1/login-links',
  consoleLogin: 'GET /console/login',
  logout: 'POST /v1/logout',
  devices: 'GET /v1/devices',
  deviceRevoke: 'DELETE /v1/devices/:id',
  workspace: 'GET /v1/workspace',
  workspacePatch: 'PATCH /v1/workspace',
  companies: 'GET /v1/companies',
  companyPut: 'PUT /v1/companies/:cid',
  companyDelete: 'DELETE /v1/companies/:cid',
  companyPatch: 'PATCH /v1/companies/:cid',
  passportProposals: 'GET /v1/companies/:cid/passport/proposals',
  passportDecide: 'POST /v1/companies/:cid/passport/proposals/:pid/:decision',
  providers: 'GET /v1/providers',
  providerPut: 'PUT /v1/providers/:adapter/credential',
  providerDelete: 'DELETE /v1/providers/:adapter/credential',
  providerTest: 'POST /v1/providers/:adapter/test',
  deviceLoginStart: 'POST /v1/providers/:adapter/device-login',
  deviceLoginStatus: 'GET /v1/providers/logins/:loginId',
  deviceLoginCancel: 'DELETE /v1/providers/logins/:loginId',
  secrets: 'GET /v1/companies/:cid/secrets',
  secretPut: 'PUT /v1/companies/:cid/secrets/:name',
  secretDelete: 'DELETE /v1/companies/:cid/secrets/:name',
  githubApp: 'GET /v1/github/app',
  githubAppPut: 'PUT /v1/github/app',
  repos: 'GET /v1/companies/:cid/repos',
  repoPut: 'PUT /v1/companies/:cid/repos/:rid',
  repoSync: 'POST /v1/companies/:cid/repos/:rid/sync',
  repoDelete: 'DELETE /v1/companies/:cid/repos/:rid',
  connections: 'GET /v1/companies/:cid/connections',
  connectionPut: 'PUT /v1/companies/:cid/connections/:id',
  connectionDelete: 'DELETE /v1/companies/:cid/connections/:id',
  connectionAuthorize: 'POST /v1/companies/:cid/connections/:id/authorize',
  connectorCallback: 'GET /oauth/connectors/callback',
  workflows: 'GET /v1/companies/:cid/workflows',
  workflowPut: 'PUT /v1/companies/:cid/workflows/:wid',
  workflowDelete: 'DELETE /v1/companies/:cid/workflows/:wid',
  schedules: 'GET /v1/companies/:cid/schedules',
  schedulePut: 'PUT /v1/companies/:cid/schedules/:sid',
  scheduleDelete: 'DELETE /v1/companies/:cid/schedules/:sid',
  hooks: 'GET /v1/companies/:cid/hooks',
  hookPut: 'PUT /v1/companies/:cid/hooks/:hid',
  hookDelete: 'DELETE /v1/companies/:cid/hooks/:hid',
  hookIngress: 'POST /hooks/:hid',
  hookIngressSecret: 'POST /hooks/:hid/:secret',
  syncChanges: 'GET /v1/sync/changes',
  runStart: 'POST /v1/companies/:cid/runs',
  runs: 'GET /v1/runs',
  run: 'GET /v1/runs/:id',
  runLog: 'GET /v1/runs/:id/log',
  runCancel: 'POST /v1/runs/:id/cancel',
  asks: 'GET /v1/asks',
  askAnswer: 'POST /v1/asks/:id/answer',
  forumChannels: 'GET /v1/companies/:cid/forum/channels',
  forumMessages: 'GET /v1/companies/:cid/forum/channels/:chid/messages',
  forumPost: 'POST /v1/companies/:cid/forum/channels/:chid/messages',
  events: 'GET /v1/events',
  usage: 'GET /v1/usage',
  audit: 'GET /v1/audit',
  summary: 'GET /v1/summary'
} as const
export type CloudRouteName = keyof typeof CLOUD_ROUTES

/** `routePath('runCancel', { id: 'crun_1' })` -> '/v1/runs/crun_1/cancel'. Params are URI-encoded. */
export function routePath(name: CloudRouteName, params: Record<string, string> = {}): string {
  const path = CLOUD_ROUTES[name].split(' ')[1]!
  return path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
    const v = params[key]
    if (v === undefined) throw new Error(`routePath(${name}): missing :${key}`)
    return encodeURIComponent(v)
  })
}
export function routeMethod(name: CloudRouteName): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' {
  return CLOUD_ROUTES[name].split(' ')[0] as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
}

/** Routes kept in the contract that answer 501 `{error: 'not_in_v1'}` in v1 (CLOUD.md §14). PUT of `codex_access_token` too. */
export const NOT_IN_V1_ROUTES: readonly CloudRouteName[] = [
  'hooks', 'hookPut', 'hookDelete', 'hookIngress', 'hookIngressSecret',
  'githubApp', 'githubAppPut',
  'deviceLoginStart', 'deviceLoginStatus', 'deviceLoginCancel',
  'forumChannels', 'forumMessages', 'forumPost'
]
export const NOT_IN_V1_CREDENTIAL_KINDS: readonly ProviderCredentialKind[] = ['codex_access_token']

// ---------- connect link (CLOUD.md §5) ----------

/** `formatConnectLink('https://cloud.example.com', 'K7QM4XWD')` -> 'https://cloud.example.com/pair#K7QM-4XWD'. */
export function formatConnectLink(url: string, code: string): string {
  const c = code.replace(/[^0-9a-z]/gi, '').toUpperCase()
  return `${url.trim().replace(/\/+$/, '').replace(/\/pair$/, '')}/pair#${c.slice(0, 4)}-${c.slice(4)}`
}

/**
 * The one string a person pastes. Tolerates surrounding whitespace, a missing `/pair`, a lowercase code and a missing
 * dash. Returns the base URL (no trailing slash, no /pair) and the code as XXXX-XXXX, or null.
 */
export function parseConnectLink(text: string): { url: string; code: string } | null {
  const t = text.replace(/\s+/g, '')
  const hash = t.indexOf('#')
  if (hash < 0) return null
  const raw = t.slice(hash + 1).replace(/-/g, '').toUpperCase()
  if (raw.length !== 8 || [...raw].some((ch) => !PAIRING_ALPHABET.includes(ch))) return null
  let base: URL
  try { base = new URL(t.slice(0, hash)) } catch { return null }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null
  const path = base.pathname.replace(/\/+$/, '').replace(/\/pair$/, '')
  return { url: `${base.origin}${path}`, code: `${raw.slice(0, 4)}-${raw.slice(4)}` }
}

/** Limits every implementation enforces (tests assert them). */
export const CLOUD_LIMITS = {
  jsonBodyBytes: 1_000_000,
  /** company create with a passport bundle */
  bundleBodyBytes: 20_000_000,
  credentialBytes: 64 * 1024,
  promptChars: 32_000,
  forumTextChars: 8_000,
  logTailLines: 2_000,
  /** failed pairing attempts per IP per 10 minutes before 429 */
  pairAttempts: 10
} as const

// ---------- reachability (CLOUD.md §12.1) ----------

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\[f[cd][0-9a-f:]*\]|\[fe80:[0-9a-f:]*\])$/i

/** A loopback or private-network origin: it only works on the machine (or network) that runs the cloud. */
export function isLocalOnlyUrl(url: string): boolean {
  try {
    return PRIVATE_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A loopback origin (127.0.0.1, localhost, ::1): it only works on the machine that runs the cloud. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** ChatGPT and Claude.ai connect only to a public https origin (Open Passport SPEC §11.3.1). */
export function isPublicHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:' && !isLocalOnlyUrl(url)
  } catch {
    return false
  }
}

// ---------- key names in plain words (CLOUD.md §3 step 5, §7.9) ----------

const KNOWN_KEYS: Record<string, string> = {
  FAL_KEY: 'fal.ai key',
  FAL_API_KEY: 'fal.ai key',
  FIRECRAWL_API_KEY: 'Firecrawl key',
  OPENAI_API_KEY: 'OpenAI key',
  ANTHROPIC_API_KEY: 'Anthropic key',
  GEMINI_API_KEY: 'Gemini key',
  GOOGLE_API_KEY: 'Google key',
  REPLICATE_API_TOKEN: 'Replicate token',
  ELEVENLABS_API_KEY: 'ElevenLabs key',
  RESEND_API_KEY: 'Resend key',
  SENDGRID_API_KEY: 'SendGrid key',
  STRIPE_SECRET_KEY: 'Stripe secret key',
  STRIPE_API_KEY: 'Stripe key',
  GITHUB_TOKEN: 'GitHub token',
  SLACK_BOT_TOKEN: 'Slack bot token',
  NOTION_API_KEY: 'Notion key',
  NOTION_TOKEN: 'Notion token',
  LINEAR_API_KEY: 'Linear key',
  APIFY_API_TOKEN: 'Apify token',
  APIFY_TOKEN: 'Apify token',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service key',
  POSTHOG_API_KEY: 'PostHog key',
  SENTRY_AUTH_TOKEN: 'Sentry token',
  SERPAPI_API_KEY: 'SerpApi key',
  PERPLEXITY_API_KEY: 'Perplexity key',
  BROWSERBASE_API_KEY: 'Browserbase key',
  TWILIO_AUTH_TOKEN: 'Twilio token',
  HUBSPOT_ACCESS_TOKEN: 'HubSpot token',
  SHOPIFY_ACCESS_TOKEN: 'Shopify token',
  AIRTABLE_API_KEY: 'Airtable key',
  CLOUDFLARE_API_TOKEN: 'Cloudflare token',
  VERCEL_TOKEN: 'Vercel token'
}

/** "fal.ai key" for FAL_KEY; null when the name is not a well-known one (the UI then shows the name alone). */
export function knownKey(name: string): string | null {
  return KNOWN_KEYS[name] ?? null
}
