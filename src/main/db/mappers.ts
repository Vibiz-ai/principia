/** Row <-> domain type mapping shared by the main store and the EngineStore. */
import type {
  AdapterId,
  AgentProfile,
  Artifact,
  ArtifactKind,
  Run,
  RunStep,
  Schedule,
  ScheduleEvent,
  Session,
  Workflow,
  WorkflowDraft,
  WorkflowNode
} from '../../shared/types'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import { migrateDraftLike, migrateNodes } from './slackMigration'

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
export const bool = (n: number | null | undefined): boolean => !!n
export const int = (b: boolean): number => (b ? 1 : 0)
/** COMPANY.md §1.4: a NULL stamp (row written by an older build) reads as Personal. */
export const stamp = (companyId: string | null | undefined): string => companyId || PERSONAL_COMPANY_ID

export interface ProfileRow {
  id: string
  name: string
  adapter: string
  model: string | null
  extra_args_json: string
  permission_mode: string
  secret_names_json: string
  use_api_key_auth: number
  is_default: number
  created_at: string
  updated_at: string
}
export const profileFromRow = (r: ProfileRow): AgentProfile => ({
  id: r.id,
  name: r.name,
  adapter: r.adapter as AdapterId,
  model: r.model,
  extraArgs: json<string[]>(r.extra_args_json, []),
  permissionMode: r.permission_mode === 'default' ? 'default' : 'bypass',
  secretNames: json<string[]>(r.secret_names_json, ['*']),
  useApiKeyAuth: bool(r.use_api_key_auth),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export interface SessionRow {
  id: string
  title: string
  profile_id: string
  adapter: string
  repo_id: string | null
  cwd: string
  status: string
  pid: number | null
  cols: number
  rows: number
  exit_code: number | null
  started_at: string
  ended_at: string | null
  artifacts_dir: string
  log_path: string
  from_run_id: string | null
  agent_session_id: string | null
  company_id?: string | null
  department_id?: string | null
  company_agent_id?: string | null
}
export const sessionFromRow = (r: SessionRow): Session => ({
  id: r.id,
  title: r.title,
  profileId: r.profile_id,
  adapter: r.adapter as AdapterId,
  repoId: r.repo_id,
  cwd: r.cwd,
  status: r.status === 'running' ? 'running' : 'exited',
  pid: r.pid,
  cols: r.cols,
  rows: r.rows,
  exitCode: r.exit_code,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  artifactsDir: r.artifacts_dir,
  fromRunId: r.from_run_id,
  agentSessionId: r.agent_session_id,
  companyId: stamp(r.company_id),
  ...(r.department_id ? { departmentId: r.department_id } : {}),
  ...(r.company_agent_id ? { companyAgentId: r.company_agent_id } : {})
})

export interface WorkflowRow {
  id: string
  name: string
  description: string
  inputs_json: string
  nodes_json: string
  seed_key: string | null
  created_at: string
  updated_at: string
  origin_json?: string | null
  worktree_json?: string | null
  slack_tools?: number | null
  slack_agent_permissions?: string | null
  company_id?: string | null
}
export const workflowFromRow = (r: WorkflowRow): Workflow => {
  const wf: Workflow = {
    id: r.id,
    name: r.name,
    description: r.description,
    inputs: json(r.inputs_json, []),
    // SLACK.md §10.4: legacy `imessage` reads as `slack` (imports, rows written by an older Hive)
    nodes: migrateNodes(json<WorkflowNode[]>(r.nodes_json, [])).nodes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    companyId: stamp(r.company_id)
  }
  // AUTHORING.md §2.5, §6: only present when set, so older equality checks and exports stay unchanged
  const worktree = json<Workflow['worktree']>(r.worktree_json ?? null, null)
  if (worktree) wf.worktree = worktree
  const origin = json<Workflow['origin']>(r.origin_json ?? null, null)
  if (origin) wf.origin = origin
  if (r.slack_tools) wf.slackTools = true
  if (r.slack_tools && r.slack_agent_permissions === 'profile') wf.slackAgentPermissions = 'profile'
  return wf
}

export interface RunRow {
  id: string
  kind: string
  title: string
  target_json: string
  workflow_id: string | null
  workflow_json: string | null
  schedule_id: string | null
  parent_run_id: string | null
  trigger: string
  status: string
  reason: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
  artifacts_dir: string
  artifact_count?: number
  stop_reason?: string | null
  reset_at?: string | null
  retry_at?: string | null
  retry_run_id?: string | null
  outcome?: string | null
  started_by_json?: string | null
  worktree_obj?: string | null
  trigger_ext?: string | null
  slack_json?: string | null
  company_id?: string | null
  /** DEPARTMENTS.md §1.2: the agent seat a run belongs to (a task run, or a Forum reply run with no task) */
  agent_id?: string | null
}
/** AUTHORING.md §6: the run's newest worktree row as a RunWorktree JSON object. */
const WORKTREE_OBJ = `(SELECT json_object('id', w.id, 'runId', w.run_id, 'repoId', w.repo_id, 'repoPath', w.repo_path, 'path', w.path,
  'branch', w.branch, 'base', w.base, 'status', w.status, 'keptReason', w.kept_reason, 'error', w.error,
  'createdAt', w.created_at, 'removedAt', w.removed_at) FROM worktrees w WHERE w.run_id = runs.id ORDER BY w.created_at DESC LIMIT 1)`
export const RUN_SELECT = `SELECT runs.*, (SELECT COUNT(*) FROM artifacts a WHERE a.run_id = runs.id) AS artifact_count, ${WORKTREE_OBJ} AS worktree_obj FROM runs`
export const runFromRow = (r: RunRow): Run => ({
  id: r.id,
  kind: r.kind as Run['kind'],
  title: r.title,
  target: json(r.target_json, { kind: 'prompt', profileId: '', repoId: null, prompt: '' }),
  workflowId: r.workflow_id,
  scheduleId: r.schedule_id,
  parentRunId: r.parent_run_id,
  // runs.trigger's CHECK predates 'agent': agent runs are stored as 'manual' + started_by_json (AUTHORING.md §10)
  // SLACK.md §7.1: 'slack' is stored as 'manual' + trigger_ext
  trigger: r.trigger_ext === 'slack' ? 'slack' : r.started_by_json ? 'agent' : (r.trigger as Run['trigger']),
  status: r.status as Run['status'],
  reason: r.reason,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  artifactsDir: r.artifacts_dir,
  artifactCount: r.artifact_count ?? 0,
  stopReason: r.stop_reason === 'rate_limited' ? 'rate_limited' : null,
  resetAt: r.reset_at ?? null,
  retryAt: r.retry_at ?? null,
  retryRunId: r.retry_run_id ?? null,
  outcome: r.outcome === 'nothing_to_do' ? 'nothing_to_do' : null,
  worktree: json<Run['worktree']>(r.worktree_obj ?? null, null),
  startedBy: json<Run['startedBy']>(r.started_by_json ?? null, null),
  slack: json<Run['slack']>(r.slack_json ?? null, null),
  companyId: stamp(r.company_id),
  ...(r.agent_id ? { agentId: r.agent_id } : {})
})
/** Snapshots are history and never rewritten; legacy `imessage` reads as `slack` (SLACK.md §7.2.4). */
export const runSnapshot = (r: RunRow): WorkflowDraft | null => migrateDraftLike(json<WorkflowDraft | null>(r.workflow_json, null))

export interface StepRow {
  id: string
  run_id: string
  seq: number
  node_id: string
  node_type: string
  attempt: number
  round: number | null
  profile_id: string | null
  participant_label: string | null
  adapter: string
  cwd: string
  prompt: string
  output: string | null
  verdict: string | null
  exit_code: number | null
  pid: number | null
  status: string
  error: string | null
  source_step_ids_json: string
  agent_session_id: string | null
  log_path: string
  started_at: string | null
  ended_at: string | null
  stop_reason?: string | null
  reset_at?: string | null
  halt?: string | null
  node_type_ext?: string | null
}
export const stepFromRow = (r: StepRow): RunStep => ({
  id: r.id,
  runId: r.run_id,
  seq: r.seq,
  nodeId: r.node_id,
  // run_steps.node_type's CHECK predates wait/notify: those are stored as 'shell' + node_type_ext
  nodeType: (r.node_type_ext || r.node_type) as RunStep['nodeType'],
  attempt: r.attempt,
  round: r.round,
  profileId: r.profile_id,
  participantLabel: r.participant_label,
  adapter: r.adapter as AdapterId,
  cwd: r.cwd,
  prompt: r.prompt,
  output: r.output,
  verdict: r.verdict === 'PASS' || r.verdict === 'FAIL' ? r.verdict : null,
  exitCode: r.exit_code,
  pid: r.pid,
  status: r.status as RunStep['status'],
  error: r.error,
  sourceStepIds: json<string[]>(r.source_step_ids_json, []),
  agentSessionId: r.agent_session_id,
  stopReason: r.stop_reason === 'rate_limited' ? 'rate_limited' : null,
  resetAt: r.reset_at ?? null,
  halt: r.halt ?? null,
  logPath: r.log_path,
  startedAt: r.started_at,
  endedAt: r.ended_at
})

export interface ScheduleRow {
  id: string
  name: string
  target_json: string
  when_json: string
  preset_json: string | null
  enabled: number
  last_fire_at: string | null
  last_run_id: string | null
  next_fire_at: string | null
  created_at: string
  updated_at: string
  last_run_status?: string | null
  skip_slot_at?: string | null
  company_id?: string | null
  department_id?: string | null
}
export const SCHEDULE_SELECT = `SELECT schedules.*, (SELECT status FROM runs WHERE runs.id = schedules.last_run_id) AS last_run_status FROM schedules`
export const scheduleFromRow = (r: ScheduleRow, describe: (w: Schedule['when']) => string): Schedule => {
  const when = json<Schedule['when']>(r.when_json, { kind: 'at', at: r.created_at })
  let sentence = ''
  try {
    sentence = describe(when)
  } catch {
    sentence = when.kind === 'cron' ? `cron ${when.cron}` : `Once at ${when.at}`
  }
  return {
    id: r.id,
    name: r.name,
    target: json(r.target_json, { kind: 'prompt', profileId: '', repoId: null, prompt: '' }),
    when,
    preset: json(r.preset_json, null),
    enabled: bool(r.enabled),
    sentence,
    lastFireAt: r.last_fire_at,
    lastRunId: r.last_run_id,
    lastRunStatus: (r.last_run_status as Schedule['lastRunStatus']) ?? null,
    nextFireAt: r.next_fire_at,
    skipSlotAt: r.skip_slot_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    companyId: stamp(r.company_id),
    // DEPARTMENTS.md §8: schedules.department_id (absent when unset, so older shapes stay unchanged)
    ...(r.department_id ? { departmentId: r.department_id } : {})
  }
}

export interface ScheduleEventRow {
  id: string
  schedule_id: string
  kind: string
  slot_at: string
  run_id: string | null
  message: string | null
  created_at: string
}
export const scheduleEventFromRow = (r: ScheduleEventRow): ScheduleEvent => ({
  id: r.id,
  scheduleId: r.schedule_id,
  kind: r.kind as ScheduleEvent['kind'],
  slotAt: r.slot_at,
  runId: r.run_id,
  message: r.message,
  createdAt: r.created_at
})

export interface ArtifactRow {
  id: string
  run_id: string | null
  session_id: string | null
  path: string
  rel_path: string
  name: string
  kind: string
  mime: string
  bytes: number
  mtime: string
  created_at: string
  company_id?: string | null
}
export const artifactFromRow = (r: ArtifactRow): Artifact => ({
  id: r.id,
  runId: r.run_id,
  sessionId: r.session_id,
  path: r.path,
  relPath: r.rel_path,
  name: r.name,
  kind: r.kind as ArtifactKind,
  mime: r.mime,
  bytes: r.bytes,
  createdAt: r.created_at,
  mtime: r.mtime,
  companyId: stamp(r.company_id)
})

/** camelCase patch -> "col = @col" SET clause for whitelisted columns. JSON columns are stringified. */
export function buildPatch(
  patch: Record<string, unknown>,
  columns: Record<string, { col: string; kind?: 'json' | 'bool' }>
): { set: string; params: Record<string, unknown> } {
  const parts: string[] = []
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const c = columns[k]
    if (!c || v === undefined) continue
    parts.push(`${c.col} = @${c.col}`)
    params[c.col] = c.kind === 'json' ? JSON.stringify(v) : c.kind === 'bool' ? int(!!v) : v
  }
  return { set: parts.join(', '), params }
}
