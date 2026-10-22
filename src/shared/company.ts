/** Portable company context and durable work. Credentials never belong in a Passport. */
import type { AgentPersona } from './personas'
export const TASK_STATUSES = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'] as const
export type TaskStatus = typeof TASK_STATUSES[number]
/** DEPARTMENTS.md §1.3: `agent` (task_create from a run) and `schedule` (a task-mode schedule's standing card). */
export const TASK_SOURCES = ['manual', 'github', 'slack', 'sentry', 'posthog', 'agent', 'schedule'] as const
export type TaskSource = typeof TASK_SOURCES[number]
/** COMPANY.md §2.2: the reserved Personal / Unassigned company. Unowned repos, repo-less chats and NULL stamps land here. */
export const PERSONAL_COMPANY_ID = 'co_personal'
export const PERSONAL_SLUG = 'personal'
/** Profile fields: readable for one release, then they live in the vault's company hub note (PASSPORT.md §9). */
export const PROFILE_FIELDS = ['mission', 'brandVoice', 'audience', 'products', 'goals', 'context', 'constraints'] as const
export interface CompanyPassportInput {
  name: string; mission: string; brandVoice: string; audience: string; products: string; goals: string; context: string; constraints: string; repoIds: string[]
  /** avatar colour (`var(--token)` or hex); default from the id hash */
  color?: string
  /** null: `<userData>/companies/<slug>/Passport` */
  vaultPath?: string | null
}
export interface CompanyPassport extends CompanyPassportInput {
  id: string; createdAt: string; updatedAt: string
  /** folder name, fixed at creation, never changed on rename */
  slug: string
  color: string
  /** rail and sidebar order; Personal always sorts last regardless */
  sortOrder: number
  system?: 'personal' | null
  /** archive replaces delete: hidden from the rail and the All sidebar, data kept */
  archivedAt?: string | null
  vaultPath?: string | null
  /** DEPARTMENTS.md §1.1: company-row JSON. Assignment wakes `auto` agents only with this on. Absent = false. */
  autopilot?: boolean
  /** DEPARTMENTS.md §3: tasks in flight at once across the company's agents. Absent = DEFAULT_MAX_IN_FLIGHT. */
  maxInFlight?: number
}
export interface PassportExport { format: 'principia-passport'; version: 1; passport: Omit<CompanyPassportInput, 'repoIds' | 'vaultPath'> }
/** company:create. Profile fields default to empty. */
export type CompanyCreateInput = { name: string; color?: string; vaultPath?: string | null; repoIds?: string[] } & Partial<Record<typeof PROFILE_FIELDS[number], string>>
/** company:update (name, colour, sort, vault path). */
export interface CompanyUpdateInput { name?: string; color?: string; sortOrder?: number; vaultPath?: string | null }
/** company:overview, one per listed company. Memory counts come from the passport index (0 until it exists). */
export interface CompanyOverview {
  companyId: string
  repoCount: number; sessionCount: number
  /** working root agents plus queued/running runs */
  working: number
  /** open asks plus unseen idle session roots */
  needsYou: number
  failed24h: number; runs7d: number
  /** failed runs in the last 7 days (the calmWeek milestone) */
  failed7d: number
  lastActivityAt: string | null
  noteCount: number; ghostCount: number; pendingSuggestions: number
}
export interface CompanyTaskInput extends Partial<TaskBoardFields> {
  title: string; description: string; companyId: string; repoId: string | null; status: TaskStatus; priority: 0 | 1 | 2 | 3 | 4;
  source: TaskSource; sourceUrl: string | null; externalId: string | null; assigneeProfileId: string | null; parentId: string | null; dependencyIds: string[]
}
/** Stored tasks. Rows written before departments lack the TaskBoardFields; read them through withTaskDefaults. */
export interface CompanyTask extends CompanyTaskInput { id: string; identifier: string; runId: string | null; createdAt: string; updatedAt: string }
/** A task with every DEPARTMENTS.md §1.3 field present (what taskInputSchema produces). */
export type BoardTask = CompanyTask & TaskBoardFields
export const TASK_ACTIVITY_KINDS = ['created', 'routed', 'assigned', 'woke', 'coalesced', 'started', 'report', 'asked', 'answered', 'parked', 'healed', 'handoff', 'approved', 'sent_back', 'comment', 'run_finished', 'interrupted',
  /** pre-departments edits ("Status: todo → blocked"); still written for plain field edits */
  'updated'] as const
export type TaskActivityKind = typeof TASK_ACTIVITY_KINDS[number]
export const ACTIVITY_BY = ['human', 'agent', 'system'] as const
export type ActivityBy = typeof ACTIVITY_BY[number]
export interface TaskActivity {
  id: string; taskId: string; kind: TaskActivityKind; message: string; createdAt: string
  /** who caused it; rows written before departments read as 'system' */
  by: ActivityBy
}
export interface TaskDetail { task: CompanyTask; activity: TaskActivity[] }
export interface GithubTaskPreview { title: string; description: string; source: 'github'; sourceUrl: string; externalId: string; truncated: boolean }

// ---------- DEPARTMENTS.md: departments, agents, the company board ----------

/** §0.8: departments need both flags; with either off the Tasks page behaves exactly as before. */
export function departmentsEnabled(flags: { companies?: boolean; departments?: boolean } | null | undefined): boolean {
  return !!flags?.companies && !!flags?.departments
}
export const DEFAULT_MAX_IN_FLIGHT = 3
export const MAX_HANDOFFS = 4

/** §1.3: why a `blocked` task is blocked. Only `deps` heals by itself; everything else waits for the human. */
export const BLOCK_REASONS = ['deps', 'needs_input', 'run_failed', 'interrupted', 'no_report', 'limit', 'agent', 'handoff_cap', 'manual'] as const
export type BlockReason = typeof BLOCK_REASONS[number]
export const TASK_ASK_KINDS = ['question', 'confirm', 'choice'] as const
export type TaskAskKind = typeof TASK_ASK_KINDS[number]
/** §5 board ask: set by task_ask, lives in the task row, no timeout. */
export interface TaskAsk { kind: TaskAskKind; prompt: string; options?: string[]; answer?: string; answeredAt?: string }
export interface TaskReport { outcome: 'review' | 'blocked'; summary: string; evidence: string[]; at: string }
export type RoutingBy = 'human' | 'rule' | 'model'
/** §2: every routing decision, with its reason. A `model` routing is a suggestion until accepted (tasks:acceptRoute). */
export interface TaskRouting { departmentId: string | null; agentId: string | null; by: RoutingBy; reason: string; confidence?: number }
/** §3.5: wakes that arrived while the task was in flight, run as one follow-up turn. */
export interface PendingWake { reasons: string[]; count: number }
/**
 * §3.6: the 4-automatic-wakes-per-hour guard; any human action resets it. `at`: the automatic starts of the last hour
 * (a rolling hour, so no burst straddles a window edge); windowStart is the oldest of them and n their count.
 */
export interface AutoWakes { windowStart: string | null; n: number; at?: string[] }
/** DEPARTMENTS.md §1.3 task fields. Optional on input (old rows and old callers); taskInputSchema fills the defaults. */
export interface TaskBoardFields {
  departmentId: string | null
  /** company_agents.id; assigneeProfileId stays as a legacy alias for one release */
  agentId: string | null
  blockReason: BlockReason | null
  ask: TaskAsk | null
  report: TaskReport | null
  /** required on the transition to done */
  doneNote: string | null
  routing: TaskRouting | null
  pendingWake: PendingWake | null
  /** provider conversation id, for --resume on the next turn */
  agentSessionId: string | null
  autoWakes: AutoWakes
  /** capped at MAX_HANDOFFS */
  handoffs: number
}
export const TASK_BOARD_DEFAULTS: TaskBoardFields = { departmentId: null, agentId: null, blockReason: null, ask: null, report: null, doneNote: null, routing: null, pendingWake: null, agentSessionId: null, autoWakes: { windowStart: null, n: 0 }, handoffs: 0 }
/** Fills the §1.3 fields an older row lacks (no validation; taskInputSchema validates). */
export function withTaskDefaults<T extends CompanyTaskInput>(t: T): T & TaskBoardFields {
  const d = TASK_BOARD_DEFAULTS
  return { ...t, departmentId: t.departmentId ?? null, agentId: t.agentId ?? null, blockReason: t.blockReason ?? null, ask: t.ask ?? null, report: t.report ?? null, doneNote: t.doneNote ?? null,
    routing: t.routing ?? null, pendingWake: t.pendingWake ?? null, agentSessionId: t.agentSessionId ?? null, autoWakes: t.autoWakes ?? { ...d.autoWakes }, handoffs: t.handoffs ?? 0 }
}

/** §1.5 derived lanes. Every surface (board, overview, rail badge, Needs you) uses laneOf. */
export const TASK_LANES = ['inbox', 'queued', 'working', 'needs_you', 'done'] as const
export type TaskLane = typeof TASK_LANES[number]
export const LANE_LABELS: Record<TaskLane, string> = { inbox: 'Inbox', queued: 'Queued', working: 'Working', needs_you: 'Needs you', done: 'Done' }
type LaneTask = Pick<CompanyTaskInput, 'status' | 'departmentId' | 'agentId' | 'assigneeProfileId' | 'blockReason'>
/**
 * A todo/triage task routed to a department that has no eligible agent (§2 step 2): it waits for the human.
 * `agentEligible=false`: the task's agent is paused or archived (the caller knows the agent rows; this stays pure).
 */
export function isUnassignedInDepartment(t: LaneTask, agentEligible = true): boolean {
  return (t.status === 'todo' || t.status === 'triage') && !!t.departmentId && (!(t.agentId || t.assigneeProfileId) || (!!t.agentId && !agentEligible))
}
/**
 * §1.5. `openLiveAsk`: the task's run has an open live ask (permission, question, trust; asks.task_id). `agentEligible`:
 * see isUnassignedInDepartment (default true, so a caller without agent rows sees today's lanes). A blocked task
 * without a reason (written by an older build) reads as Needs you: only `deps` is ever healed automatically.
 */
export function laneOf(t: LaneTask, openLiveAsk = false, agentEligible = true): TaskLane {
  switch (t.status) {
    case 'done': case 'canceled': return 'done'
    case 'in_review': return 'needs_you'
    case 'in_progress': return openLiveAsk ? 'needs_you' : 'working'
    case 'blocked': return t.blockReason === 'deps' ? 'queued' : 'needs_you'
    case 'triage': return isUnassignedInDepartment(t, agentEligible) ? 'needs_you' : 'inbox'
    case 'todo': return isUnassignedInDepartment(t, agentEligible) ? 'needs_you' : 'queued'
    case 'backlog': return 'queued'
  }
}
/** The reason chip of a Needs you card; null outside Needs you. */
export type NeedsYouReason = 'review' | 'live_ask' | 'unassigned' | BlockReason | 'blocked'
export function needsYouReason(t: LaneTask, openLiveAsk = false, agentEligible = true): NeedsYouReason | null {
  if (laneOf(t, openLiveAsk, agentEligible) !== 'needs_you') return null
  if (t.status === 'in_review') return 'review'
  if (t.status === 'in_progress') return 'live_ask'
  if (t.status === 'blocked') return t.blockReason ?? 'blocked'
  return 'unassigned'
}

export const DEPARTMENT_LIMITS = { charter: 600, contextFallback: 600, slackChannels: 50, name: 80 } as const
export interface DepartmentCharter { does: string; doesNot: string }
/** company_departments.data */
export interface DepartmentData {
  /** ≤600 chars together; used for routing */
  charter: DepartmentCharter
  /** sources routed here when nothing else is set, e.g. ['github','sentry'] for Development */
  sourceDefaults: TaskSource[]
  /** Slack channel ids routed here */
  slackChannels: string[]
  /** vault note title once the vault exists */
  passportNote: string | null
  /** ≤600 chars, injected in the department brief slot until the vault ships */
  contextFallback: string
}
export const DEPARTMENT_DATA_DEFAULTS: DepartmentData = { charter: { does: '', doesNot: '' }, sourceDefaults: [], slackChannels: [], passportNote: null, contextFallback: '' }
export interface Department {
  id: string; companyId: string
  /** slug, unique per company, fixed at creation (presets are idempotent by key) */
  key: string
  name: string; color: string | null; icon: string | null; sortOrder: number
  archivedAt: string | null; createdAt: string; updatedAt: string
  data: DepartmentData
}
/** departments:save. No id = create; companyId never changes. key defaults to a slug of the name. */
export interface DepartmentSaveInput {
  id?: string; companyId: string; key?: string; name: string; color?: string | null; icon?: string | null
  data?: Partial<Omit<DepartmentData, 'charter'>> & { charter?: Partial<DepartmentCharter> }
}

export const AGENT_LIMITS = { instructions: 4000, capabilities: 400, name: 80, runMinutes: { min: 1, max: 24 * 60 }, autoWakesPerHour: { min: 1, max: 4 } } as const
export type CompanyAgentKind = 'profile' | 'workflow'
export type AgentAutonomy = 'manual' | 'auto'
export type AgentMode = 'headless' | 'session'
export interface AgentLimits { runMinutes: number; autoWakesPerHour: number }
/** company_agents.data */
export interface CompanyAgentData {
  /** ≤4000, prepended to every task turn */
  instructions: string
  /** ≤400 "does / does not", used for routing */
  capabilities: string
  /** assignment wakes the agent only when 'auto' and the company's autopilot is on */
  autonomy: AgentAutonomy
  mode: AgentMode
  /** null = the task's repo, else the company workspace dir */
  defaultRepoId: string | null
  limits: AgentLimits
  /** VOICE.md §4: presentation only (name stays the role label). Absent on agents created before personas. */
  persona?: AgentPersona
}
export const AGENT_DATA_DEFAULTS: CompanyAgentData = { instructions: '', capabilities: '', autonomy: 'manual', mode: 'headless', defaultRepoId: null, limits: { runMinutes: 30, autoWakesPerHour: 4 } }
/** A company-scoped agent seat over a global profile (adapter, model, keys stay global) or a workflow of the company. */
export interface CompanyAgent {
  id: string; companyId: string
  /** null = company-level agent */
  departmentId: string | null
  kind: CompanyAgentKind
  /** profiles.id | workflows.id */
  refId: string
  name: string
  archivedAt: string | null; pausedAt: string | null; createdAt: string; updatedAt: string
  data: CompanyAgentData
}
/** companyAgents:save. No id = create; companyId never changes. */
export interface CompanyAgentSaveInput {
  id?: string; companyId: string; departmentId: string | null; kind: CompanyAgentKind; refId: string; name: string
  data?: Partial<Omit<CompanyAgentData, 'limits'>> & { limits?: Partial<AgentLimits> }
}
/** An agent can take a task: active (not archived, not paused). Autonomy is a separate gate (§3.2). */
export const agentActive = (a: Pick<CompanyAgent, 'archivedAt' | 'pausedAt'>): boolean => !a.archivedAt && !a.pausedAt

/**
 * Accent colours retired by the cool palette (VOICE.md §5: no orange, amber, brown or ochre accents). Departments and
 * companies saved before it may still store them; read paths map them to their cool replacements at display time, and
 * the next save stores the replacement.
 */
export const RETIRED_ACCENTS: Readonly<Record<string, string>> = {
  'var(--provider-claude)': 'var(--series-5)',
  'var(--status-warning)': 'var(--series-2)'
}
/** A stored accent as it is shown: a retired warm hue maps to its cool replacement; anything else passes through. */
export function coolAccent(color: string): string
export function coolAccent(color: string | null | undefined): string | null | undefined
export function coolAccent(color: string | null | undefined): string | null | undefined {
  if (!color) return color
  return RETIRED_ACCENTS[color.trim().toLowerCase().replace(/\s+/g, '')] ?? color
}

/** §9 "+" chips. Sample charters; every field is editable after creation. */
export const DEPARTMENT_PRESET_KEYS = ['development', 'marketing', 'sales', 'support', 'ops', 'finance'] as const
export type DepartmentPresetKey = typeof DEPARTMENT_PRESET_KEYS[number]
export interface DepartmentPreset { key: DepartmentPresetKey; name: string; color: string; icon: string; data: DepartmentData }
const preset = (key: DepartmentPresetKey, name: string, color: string, icon: string, does: string, doesNot: string, sourceDefaults: TaskSource[] = []): DepartmentPreset =>
  ({ key, name, color, icon, data: { ...DEPARTMENT_DATA_DEFAULTS, charter: { does, doesNot }, sourceDefaults } })
export const DEPARTMENT_PRESETS: readonly DepartmentPreset[] = [
  preset('development', 'Development', 'var(--accent)', 'code', 'Builds and fixes the product: bugs, features, code review, tests, releases, error reports.', 'Marketing copy, sales outreach, pricing or legal decisions.', ['github', 'sentry']),
  preset('marketing', 'Marketing', 'var(--series-5)', 'spark', 'Positioning, website and launch copy, blog posts, social posts, newsletters, campaign analysis.', 'Product code changes, customer support replies, pricing commitments.'),
  preset('sales', 'Sales', 'var(--status-success)', 'agents', 'Lead research, outreach drafts, follow-ups, call prep, proposals and CRM notes.', 'Sending contracts or quotes without approval, product code changes.'),
  preset('support', 'Support', 'var(--status-scheduled)', 'chat', 'Answers customer questions, triages bug reports, drafts replies, updates help docs.', 'Refunds or account changes without approval, shipping code fixes.', ['slack']),
  preset('ops', 'Ops', 'var(--status-idle)', 'settings', 'Internal processes, vendor and tooling admin, checklists, recurring reports, hiring logistics.', 'Product code changes, spending money or signing anything.'),
  preset('finance', 'Finance', 'var(--series-2)', 'coins', 'Bookkeeping prep, invoices to review, expense summaries, runway and metrics reports.', 'Moving money, filing taxes or making payments.')
]

/** board:autopilot */
export interface BoardSettings { companyId: string; autopilot: boolean; maxInFlight: number }
