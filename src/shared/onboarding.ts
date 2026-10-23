/**
 * Business-first onboarding contracts (docs/ONBOARDING.md §3.1, §4, §6.1). Shared by main and renderer: constants,
 * zod schemas (the plan, the resumable draft, the plan and launch inputs) and the IPC payload types. Pure: zod only.
 */
import { z } from 'zod'
import { DEPARTMENT_PRESET_KEYS } from './company'
import { BUST_BEARDS, BUST_DRAPES, BUST_HAIRS, BUST_MATERIALS, PERSONA_LIMITS, type AgentPersona, type BustLook } from './personas'
import type { AdapterId, ExperimentalFlags } from './types'

// ---------- constants ----------

/** §2 S4 chips, in display order (keys 1–8). */
export const GOALS = ['customers', 'website', 'social', 'ads', 'seo', 'ship', 'support', 'other'] as const
export type GoalKey = (typeof GOALS)[number]
export const GOAL_INFO: Record<GoalKey, { label: string; codeOnly: boolean; content: boolean }> = {
  customers: { label: 'Get first customers', codeOnly: false, content: false },
  website: { label: 'Launch a website', codeOnly: false, content: true },
  social: { label: 'Post on social', codeOnly: false, content: true },
  ads: { label: 'Run ads', codeOnly: false, content: true },
  seo: { label: 'Get found on Google', codeOnly: false, content: true },
  ship: { label: 'Fix bugs & ship features', codeOnly: true, content: false },
  support: { label: 'Customer support', codeOnly: false, content: false },
  other: { label: 'Something else', codeOnly: false, content: false }
}
/** Soft cap: a 4th pick shows a note, it is not refused. */
export const GOAL_SOFT_MAX = 3

/** §2 S3 vibe cards. `sample` is a template: `{name}` is replaced with the business name (see vibeSample). */
export const VIBES = ['friendly', 'expert', 'bold', 'playful', 'premium', 'straight'] as const
export type VibeKey = (typeof VIBES)[number]
export const VIBE_INFO: Record<VibeKey, { label: string; voice: string; sample: string }> = {
  friendly: { label: 'Friendly & warm', voice: 'friendly and warm', sample: 'Hi from {name}! We made this with you in mind.' },
  expert: { label: 'Expert & precise', voice: 'expert and precise', sample: '{name}: carefully made, properly tested, clearly explained.' },
  bold: { label: 'Bold & punchy', voice: 'bold and punchy', sample: '{name}. No fluff. Just results.' },
  playful: { label: 'Playful', voice: 'playful', sample: '{name}, but make it fun.' },
  premium: { label: 'Calm & premium', voice: 'calm and premium', sample: '{name}. Made slowly, for people who notice.' },
  straight: { label: 'Straight-talking', voice: 'straight-talking', sample: '{name}. Does the job. Fair price.' }
}
export const DEFAULT_VIBE: VibeKey = 'friendly'
export function vibeSample(vibe: VibeKey, name: string): string {
  const n = name.trim() || 'Your business'
  return VIBE_INFO[vibe].sample.split('{name}').join(n)
}

/** §6.1 schedule cadences: the plan names a key, launch turns it into a cron in the user's tz. */
export const CADENCES = {
  weekdays9: '0 9 * * 1-5',
  mwf10: '0 10 * * 1,3,5',
  mwf1030: '30 10 * * 1,3,5',
  mon9: '0 9 * * 1',
  fri16: '0 16 * * 5',
  daily9: '0 9 * * *'
} as const
export type CadenceKey = keyof typeof CADENCES
export const CADENCE_KEYS = ['weekdays9', 'mwf10', 'mwf1030', 'mon9', 'fri16', 'daily9'] as const satisfies readonly CadenceKey[]
type _MissingCadence = Exclude<CadenceKey, (typeof CADENCE_KEYS)[number]>
const _cadencesExhaustive: [_MissingCadence] extends [never] ? true : _MissingCadence = true
void _cadencesExhaustive

/** Keys a bundled workflow can need. Only FAL_KEY and OPENAI_API_KEY can be checked and saved in the flow. */
export const WORKFLOW_KEY_NAMES = ['FAL_KEY', 'OPENAI_API_KEY', 'FIRECRAWL_API_KEY'] as const
export type WorkflowKeyName = (typeof WORKFLOW_KEY_NAMES)[number]
export const ONBOARDING_KEY_NAMES = ['FAL_KEY', 'OPENAI_API_KEY'] as const
export type OnboardingKeyName = (typeof ONBOARDING_KEY_NAMES)[number]
export const KEY_PROVIDERS = { fal: 'FAL_KEY', openai: 'OPENAI_API_KEY' } as const satisfies Record<string, OnboardingKeyName>
export type KeyProvider = keyof typeof KEY_PROVIDERS

/** resources/marketplace/workflows/<id>.hive.json (kept honest by onboarding.test.ts). */
export const BUNDLED_WORKFLOW_IDS = [
  'ad-creative-variants',
  'brand-kit-starter',
  'competitor-brief',
  'customer-follow-up',
  'fix-bug-with-tests',
  'generate-image-fal',
  'generate-image-openai',
  'image-edit-upscale',
  'landing-hero-images',
  'local-business-photos',
  'meeting-to-actions',
  'product-photo-studio',
  'scrape-site-firecrawl',
  'second-opinion-review',
  'social-post-carousel',
  'weekly-company-review',
  'youtube-thumbnail'
] as const
export type BundledWorkflowId = (typeof BUNDLED_WORKFLOW_IDS)[number]

export interface WorkflowKeyInfo {
  /** The env var the workflow needs; null = runs on the user's CLI login only. */
  key: WorkflowKeyName | null
  /** Spends the user's credits on a paid API (every keyed workflow). */
  costly: boolean
  /** Declared input names, in file order. A plan's workflow `inputs` must be a subset. */
  inputs: readonly string[]
}
const fal = (inputs: readonly string[]): WorkflowKeyInfo => ({ key: 'FAL_KEY', costly: true, inputs })
const free = (inputs: readonly string[]): WorkflowKeyInfo => ({ key: null, costly: false, inputs })
export const WORKFLOW_KEYS: Record<BundledWorkflowId, WorkflowKeyInfo> = {
  'ad-creative-variants': fal(['offer', 'audience', 'colors', 'vertical', 'text_in_image']),
  'brand-kit-starter': fal(['business', 'vibe', 'avoid']),
  'competitor-brief': { key: 'FIRECRAWL_API_KEY', costly: true, inputs: ['url', 'us'] },
  'customer-follow-up': free(['context']),
  'fix-bug-with-tests': free(['repo', 'bug', 'test']),
  'generate-image-fal': fal(['idea', 'size']),
  'generate-image-openai': { key: 'OPENAI_API_KEY', costly: true, inputs: ['prompt'] },
  'image-edit-upscale': fal(['image_url', 'instruction', 'scale']),
  'landing-hero-images': fal(['source', 'heroCount', 'style']),
  'local-business-photos': fal(['business', 'brand', 'season', 'perShot']),
  'meeting-to-actions': free(['context']),
  'product-photo-studio': fal(['product', 'scenes', 'style', 'remove_bg', 'size']),
  'scrape-site-firecrawl': { key: 'FIRECRAWL_API_KEY', costly: true, inputs: ['url'] },
  'second-opinion-review': free(['repo']),
  'social-post-carousel': fal(['topic', 'voice', 'style', 'cta']),
  'weekly-company-review': free(['context']),
  'youtube-thumbnail': fal(['title', 'image_url', 'notes'])
}
/** Bundled workflows whose key is present (or needs none). */
export function workflowsForKeys(present: Partial<Record<WorkflowKeyName, boolean>>): BundledWorkflowId[] {
  return BUNDLED_WORKFLOW_IDS.filter((id) => {
    const k = WORKFLOW_KEYS[id].key
    return k === null || present[k] === true
  })
}

/** §2 S5: a real waitlist link ships only when there is one. */
export const VIBIZ_WAITLIST_URL: string | null = null
/** §6.2: pass `--json-schema` to the plan call only after a recorded fixture confirms the envelope. */
export const USE_JSON_SCHEMA = false
/** §3.1 draft storage. */
export const DRAFT_STORAGE_KEY = 'principia.onboarding.v1'
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** §4: caps shared by the IPC schemas and the draft. */
export const MAX_ONBOARDING_PATHS = 8
export const MAX_URL_LENGTH = 2048
/**
 * "From a prompt" (§2 S0b): the founder's pasted brief. The draft keeps up to BRIEF_MAX chars; the plan prompt and the
 * extraction call see the first PLAN_BRIEF_MAX (a long brief still fits one small call).
 */
export const BRIEF_MAX = 20_000
export const PLAN_BRIEF_MAX = 8_000
/** §2 S0 for a new company: the three ways to start. `guided` is today's question flow. */
export const START_MODES = ['guided', 'prompt', 'repo'] as const
export type StartMode = (typeof START_MODES)[number]

// ---------- the plan (§6.1, .strict() throughout) ----------

const ref = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'ref: lowercase letters, digits and -')
const text = (n: number) => z.string().trim().min(1).max(n)
const deptKey = z.enum(DEPARTMENT_PRESET_KEYS)
export const PLAN_AGENT_ROLES = ['developer', 'builder', 'content', 'researcher', 'support', 'generalist'] as const
export type PlanAgentRole = (typeof PLAN_AGENT_ROLES)[number]
export const PLAN_ADAPTERS = ['claude', 'codex', 'gemini', 'cursor'] as const satisfies readonly AdapterId[]
export type PlanAdapter = (typeof PLAN_ADAPTERS)[number]
export const PLAN_CAPS = { departments: 4, agents: 6, tasks: 8, schedules: 4, dependsOn: 3, workflowInputs: 10 } as const

// ---------- personas (VOICE.md §4.2) ----------

/**
 * The stored persona shape, shared by `companyAgentDataSchema.persona` (main) and `PlanAgent.persona` (draft and
 * plan). Strict, so a newer or hand-edited persona never smuggles extra keys into `data`.
 */
const oneOf = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]])
export const lookSchema = z
  .object({ material: oneOf(BUST_MATERIALS), hair: oneOf(BUST_HAIRS), beard: oneOf(BUST_BEARDS), laurel: z.boolean(), drape: oneOf(BUST_DRAPES) })
  .strict()
export const personaSchema = z
  .object({
    key: z.string().max(PERSONA_LIMITS.key),
    name: z.string().trim().min(1).max(PERSONA_LIMITS.name),
    personality: z.string().max(PERSONA_LIMITS.personality),
    bio: z.string().max(PERSONA_LIMITS.bio),
    look: lookSchema
  })
  .strict()
// the schema and the shared types must not drift apart
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const PERSONA_SCHEMA_MATCHES: Same<z.infer<typeof lookSchema>, BustLook> & Same<z.infer<typeof personaSchema>, AgentPersona> = true

export const PlanDepartment = z
  .object({
    key: deptKey,
    name: text(40),
    include: z.boolean(),
    charter: z.object({ does: text(400), doesNot: text(400) }).strict().optional()
  })
  .strict()
export type PlanDepartment = z.infer<typeof PlanDepartment>

export const PlanAgent = z
  .object({
    ref,
    departmentKey: deptKey,
    name: text(40),
    role: z.enum(PLAN_AGENT_ROLES),
    adapter: z.enum(PLAN_ADAPTERS).default('claude'),
    instructions: text(2000),
    capabilities: text(400),
    auto: z.boolean(),
    include: z.boolean(),
    /** VOICE.md §4: assigned by finalizePlan when missing; a rename in the draft is kept. Never taken from the model. */
    persona: personaSchema.optional()
  })
  .strict()
export type PlanAgent = z.infer<typeof PlanAgent>

export const PlanTask = z
  .object({
    ref,
    title: text(120),
    description: text(2000),
    departmentKey: deptKey.nullable(),
    agentRef: ref.nullable(),
    priority: z.number().int().min(1).max(4),
    dependsOn: z.array(ref).max(PLAN_CAPS.dependsOn),
    where: z.enum(['repo', 'workspace']),
    include: z.boolean()
  })
  .strict()
export type PlanTask = z.infer<typeof PlanTask>

export const PlanTaskTarget = z.object({ kind: z.literal('task'), agentRef: ref, title: text(120), description: text(1000) }).strict()
export const PlanWorkflowTarget = z
  .object({
    kind: z.literal('workflow'),
    workflow: z.enum(BUNDLED_WORKFLOW_IDS),
    inputs: z
      .record(z.string().max(40), z.string().max(1500))
      .refine((r) => Object.keys(r).length <= PLAN_CAPS.workflowInputs, 'Too many inputs')
      .optional()
  })
  .strict()
export const PlanSchedule = z
  .object({
    ref,
    name: text(60),
    departmentKey: deptKey.nullable(),
    cadence: z.enum(CADENCE_KEYS),
    target: z.discriminatedUnion('kind', [PlanTaskTarget, PlanWorkflowTarget]),
    include: z.boolean()
  })
  .strict()
export type PlanSchedule = z.infer<typeof PlanSchedule>

export const OnboardingPlan = z
  .object({
    version: z.literal(1),
    summary: text(280),
    departments: z.array(PlanDepartment).max(PLAN_CAPS.departments),
    agents: z.array(PlanAgent).max(PLAN_CAPS.agents),
    tasks: z.array(PlanTask).max(PLAN_CAPS.tasks),
    schedules: z.array(PlanSchedule).max(PLAN_CAPS.schedules)
  })
  .strict()
export type OnboardingPlan = z.infer<typeof OnboardingPlan>

export const PLAN_FALLBACK_REASONS = ['no-cli', 'timeout', 'exit', 'is-error', 'not-json', 'schema', 'empty-after-validation', 'canceled'] as const
export type PlanFallbackReason = (typeof PLAN_FALLBACK_REASONS)[number]
export type PlanSource = 'agent' | 'template'
export interface PlanResult {
  plan: OnboardingPlan
  source: PlanSource
  fallbackReason?: PlanFallbackReason
}
/** §4: what main recomputes for plan and launch; the renderer's claims beyond it are ignored. */
export interface OnboardingAvailable {
  /** Bundled workflows whose key is present (Shared or stashed in this flow) or that need none. */
  workflows: BundledWorkflowId[]
  /** Installed non-shell adapters a profile agent can use. */
  profileAdapters: PlanAdapter[]
  hasCode: boolean
  departmentsOn: boolean
}

// ---------- steps ----------

/**
 * §3 state machine. `failed` is the Launch step after a failed launch (Retry / Continue / Discard). `brief` is the
 * "From a prompt" textarea (a sub-step of Start).
 */
export const STEP_KEYS = ['start', 'brief', 'connect', 'name', 'about', 'voice', 'goals', 'content', 'plan', 'launching', 'failed', 'ready'] as const
export type StepKey = (typeof STEP_KEYS)[number]

// ---------- intake summaries (redacted, capped) ----------

const short = (n: number) => z.string().max(n)
const opt = (n: number) => z.string().max(n).optional()
const httpUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((u) => /^https?:\/\//i.test(u), 'http(s) links only')
/** Stash and journal handles minted by main (opaque). */
const handle = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id')

/** §5.1 per-repo scan facts kept in the draft and sent to the plan (no listing). */
export const RepoScanSummarySchema = z
  .object({
    source: z.enum(['local', 'github']),
    /** Folder name, or `owner/repo` for GitHub. */
    label: short(200),
    path: opt(4096),
    fullName: opt(200),
    packageName: opt(214),
    description: opt(500),
    homepage: opt(MAX_URL_LENGTH),
    cname: opt(253),
    readmeHeading: opt(200),
    readmeLine: opt(500),
    readmeExcerpt: opt(2048),
    readmeLink: opt(MAX_URL_LENGTH),
    primaryLanguage: opt(60),
    remote: opt(MAX_URL_LENGTH),
    stack: z.array(short(40)).max(30)
  })
  .strict()
export type RepoScanSummary = z.infer<typeof RepoScanSummarySchema>
export const ScanSummarySchema = z
  .object({
    repos: z.array(RepoScanSummarySchema).max(MAX_ONBOARDING_PATHS),
    /** De-duplicated stack across repos, in detection order. */
    stack: z.array(short(40)).max(30)
  })
  .strict()
export type ScanSummary = z.infer<typeof ScanSummarySchema>
/** onboarding:scan. `listing` is the top-level entries (≤ 60, no dotfiles, no node_modules). */
export interface RepoScan extends RepoScanSummary {
  listing: string[]
}
export interface ScanResult {
  repos: RepoScan[]
  summary: ScanSummary
  /** Per-target problems that did not fail the scan ("Couldn't read acme/web: not found"). */
  warnings: string[]
  /** The 5 s budget ran out before every target was read. */
  partial: boolean
  elapsedMs: number
}

/** §5.3 site read. */
export const SiteSummarySchema = z
  .object({
    /** The final URL after redirects. */
    url: httpUrl,
    title: opt(300),
    description: opt(500),
    ogTitle: opt(300),
    ogDescription: opt(500),
    siteName: opt(200),
    h1: opt(300),
    fetchedAt: short(40)
  })
  .strict()
export type SiteSummary = z.infer<typeof SiteSummarySchema>

// ---------- answers, plan input, draft ----------

export const AnswersSchema = z
  .object({
    /** The only required answer; empty while the flow is in progress. */
    name: short(80),
    oneLiner: short(200),
    products: short(500),
    audience: short(500),
    siteUrl: short(MAX_URL_LENGTH),
    instagram: short(100),
    voiceVibe: z.enum(VIBES).nullable(),
    voiceText: short(600),
    avoid: short(300),
    goals: z.array(z.enum(GOALS)).max(GOALS.length),
    goalOther: short(120)
  })
  .strict()
export type OnboardingAnswers = z.infer<typeof AnswersSchema>
export const EMPTY_ANSWERS: OnboardingAnswers = {
  name: '',
  oneLiner: '',
  products: '',
  audience: '',
  siteUrl: '',
  instagram: '',
  voiceVibe: DEFAULT_VIBE,
  voiceText: '',
  avoid: '',
  goals: [],
  goalOther: ''
}

const tz = z.string().min(1).max(64)
export const PlanInputSchema = z
  .object({
    hasCode: z.boolean(),
    answers: AnswersSchema,
    scan: ScanSummarySchema.optional(),
    site: SiteSummarySchema.optional(),
    keys: z.object({ fal: z.boolean(), openai: z.boolean() }).strict(),
    departmentsOn: z.boolean(),
    tz,
    /** "From a prompt": the founder's brief (capped), so the plan is specific to it. Untrusted text, framed like the rest. */
    brief: z.string().max(PLAN_BRIEF_MAX).optional()
  })
  .strict()
export type PlanInput = z.infer<typeof PlanInputSchema>

const absPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.startsWith('/'), 'must be an absolute path')
export const DraftRepoSchema = z.object({ kind: z.literal('local'), path: absPath, existingRepoId: z.string().min(1).max(64).optional() }).strict()
export type DraftRepo = z.infer<typeof DraftRepoSchema>
/**
 * `owner/repo`. The owner starts with a letter or digit (never `-`, so it can't be read as a CLI option) and the repo
 * is never `.` or `..` (the clone destination is `<cloneDir>/<repo>`, so it must stay inside the chosen folder).
 */
export const GITHUB_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
/** §5.2: the only clone URL forms accepted (no `file://`, `ext::`, or `-`-prefixed option injection). */
export const CLONE_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/i
export const DraftGithubSchema = z
  .object({ fullName: z.string().regex(GITHUB_FULL_NAME, 'owner/repo').optional(), url: short(MAX_URL_LENGTH).optional(), parentDir: absPath })
  .strict()
export type DraftGithub = z.infer<typeof DraftGithubSchema>
/** At launch the clone source must be a real one: a GitHub name or an accepted clone URL. */
export const LaunchGithubSchema = DraftGithubSchema.extend({
  url: short(MAX_URL_LENGTH).regex(CLONE_URL, 'Use an https://, ssh:// or git@ link').optional()
})
  .strict()
  .refine((g) => !!g.fullName || !!g.url, { message: 'Choose a GitHub repo or paste its link', path: ['fullName'] })

export const DraftContentSchema = z
  .object({
    wants: z.boolean(),
    provider: z.enum(['fal', 'openai']).nullable(),
    keySource: z.enum(['shared', 'stash']).nullable(),
    /** Main-memory stash handle; the key itself is never in the draft. */
    stashId: handle.optional(),
    last4: z.string().max(4).optional(),
    vibizInterest: z.boolean()
  })
  .strict()
export type DraftContent = z.infer<typeof DraftContentSchema>

export const DraftPlanSchema = z
  .object({ value: OnboardingPlan, source: z.enum(['agent', 'template']), edited: z.boolean(), inputsHash: short(128) })
  .strict()
export type DraftPlan = z.infer<typeof DraftPlanSchema>

export const DraftSchema = z
  .object({
    v: z.literal(1),
    id: handle,
    mode: z.enum(['first', 'new']),
    step: z.enum(STEP_KEYS),
    history: z.array(z.enum(STEP_KEYS)).max(32),
    hasCode: z.boolean().nullable(),
    repos: z.array(DraftRepoSchema).max(MAX_ONBOARDING_PATHS),
    github: DraftGithubSchema.optional(),
    scan: ScanSummarySchema.optional(),
    site: SiteSummarySchema.optional(),
    answers: AnswersSchema,
    content: DraftContentSchema,
    plan: DraftPlanSchema.optional(),
    enableFlags: z.boolean(),
    journalId: handle.optional(),
    updatedAt: short(40),
    /** §2 S0 (new company): how the founder chose to start; absent = guided (drafts from before the choice). */
    start: z.enum(START_MODES).optional(),
    /** "From a prompt": the pasted brief, kept until launch (it seeds the Passport). */
    brief: z.string().max(BRIEF_MAX).optional()
  })
  .strict()
export type OnboardingDraft = z.infer<typeof DraftSchema>

// ---------- launch (§7) ----------

export const LAUNCH_STEPS = ['flags', 'company', 'code', 'keys', 'passport', 'workflows', 'departments', 'agents', 'tasks', 'schedules', 'finish'] as const
export type LaunchStepName = (typeof LAUNCH_STEPS)[number]
/** "Continue without this" is offered for these only. */
export const SOFT_LAUNCH_STEPS = ['code', 'keys', 'passport', 'workflows', 'schedules'] as const satisfies readonly LaunchStepName[]
export type SoftLaunchStep = (typeof SOFT_LAUNCH_STEPS)[number]
export const LAUNCH_STEP_LABELS: Record<LaunchStepName, string> = {
  flags: 'Beta features',
  company: 'Company',
  code: 'Code',
  keys: 'Keys',
  passport: 'Passport',
  workflows: 'Workflows',
  departments: 'Departments',
  agents: 'Team',
  tasks: 'Tasks',
  schedules: 'Schedules',
  finish: 'Finishing up'
}

export const LaunchInputSchema = z
  .object({
    mode: z.enum(['first', 'new']),
    hasCode: z.boolean(),
    answers: AnswersSchema.refine((a) => a.name.trim().length > 0, { message: 'Give your business a name', path: ['name'] }),
    repos: z.array(DraftRepoSchema).max(MAX_ONBOARDING_PATHS),
    github: LaunchGithubSchema.optional(),
    scan: ScanSummarySchema.optional(),
    site: SiteSummarySchema.optional(),
    /** A key checked in this flow, by stash handle. Shared keys are never copied, so they are not named here. */
    key: z.object({ name: z.enum(ONBOARDING_KEY_NAMES), stashId: handle }).strict().nullable(),
    plan: OnboardingPlan,
    /** §2 S6 consent: turn on companies + departments + vault. */
    enableFlags: z.boolean(),
    tz,
    /** "From a prompt": the founder's brief; its facts are seeded into the Passport (§7.2 step 5). */
    brief: z.string().max(BRIEF_MAX).optional()
  })
  .strict()
export type LaunchInput = z.infer<typeof LaunchInputSchema>

export type JournalStatus = 'running' | 'failed' | 'done' | 'discarded'
export type LaunchStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export interface LaunchCreated {
  kind: 'company' | 'repo' | 'repoMove' | 'clone' | 'secret' | 'note' | 'workflow' | 'department' | 'agent' | 'task' | 'schedule' | 'flags'
  id: string
}
export interface LaunchStepState {
  name: LaunchStepName
  status: LaunchStepStatus
  created: LaunchCreated[]
  /** User-facing, redacted. */
  error?: string
}
export interface JournalScheduleRef {
  ref: string
  id: string
  costly: boolean
}
/** Stored under meta `onboarding.journal.<id>` (§7.3). */
export interface LaunchJournal {
  id: string
  draftId: string
  mode: 'first' | 'new'
  status: JournalStatus
  companyId: string | null
  companyName?: string
  steps: LaunchStepState[]
  prevFlags?: ExperimentalFlags
  scheduleRefs: JournalScheduleRef[]
  createdAt: string
  updatedAt: string
}
/** What onboarding:status tells the renderer about an unfinished or finished launch. */
export type JournalMeta = Pick<LaunchJournal, 'id' | 'draftId' | 'mode' | 'status' | 'companyId' | 'companyName' | 'steps' | 'scheduleRefs' | 'updatedAt'>
export interface LaunchResult {
  journalId: string
  companyId: string | null
  status: JournalStatus
  steps: LaunchStepState[]
  /** Created schedules (all disabled) for the Ready step's "Also turn on schedules". */
  scheduleRefs?: JournalScheduleRef[]
}

// ---------- IPC payloads (§4) ----------

export interface FolderOwner {
  companyId: string
  name: string
  personal: boolean
}
export interface FolderCandidate {
  /** realpath */
  path: string
  name: string
  isGit: boolean
  /** The repo row's company when the folder is already in Principia. */
  ownedBy: FolderOwner | null
  existingRepoId?: string
  /** Set when the folder cannot be added ("Belongs to Acme, can't add", "Not a folder"). */
  blockedReason?: string
}

export interface GithubRepo {
  name: string
  owner: string
  /** owner/name */
  fullName: string
  description: string | null
  url: string
  homepageUrl: string | null
  primaryLanguage: string | null
  isPrivate: boolean
  pushedAt: string | null
}

export type KeyCheckStatus = 'valid' | 'invalid' | 'unknown'
/** onboarding:key check. The value never comes back. */
export interface KeyCheckResult {
  status: KeyCheckStatus
  stashId: string
  last4: string
  detail?: string
}
export type OnboardingKeyRequest =
  | { op: 'check'; name: OnboardingKeyName; value: string }
  | { op: 'forget'; stashIds: string[] }

export type GhStatus = 'missing' | 'signedOut' | 'ok'
export interface OnboardingStatus {
  firstRun: boolean
  journal: JournalMeta | null
  providers: { adapter: AdapterId; installed: boolean }[]
  claudeCli: boolean
  flags: ExperimentalFlags
  sharedKeys: Record<WorkflowKeyName, boolean>
  gh: GhStatus
  ghLogin?: string
  defaultCloneDir: string
  waitlistUrl: string | null
}

/** onboarding:brief (§2 S0b): answers read from the founder's brief by one small Claude call. */
export type BriefFallbackReason = PlanFallbackReason | 'empty'
export interface BriefResult {
  /** Only fields the brief gave; every string within the AnswersSchema limits. */
  answers: Partial<OnboardingAnswers>
  source: PlanSource
  fallbackReason?: BriefFallbackReason
}

export interface ProgressEvent {
  journalId: string
  step: LaunchStepName
  status: 'running' | 'done' | 'failed' | 'skipped'
  label: string
  detail?: string
  error?: string
}
export interface CloneProgressEvent {
  journalId: string
  fullName: string
  percent: number | null
  line: string
}
