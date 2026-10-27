import { assignRepoSchema, companyAgentSaveSchema, companyCreateSchema, companyReorderSchema, companyUpdateSchema, departmentPresetsSchema, departmentReorderSchema, departmentSaveSchema, passportInputSchema, taskInputSchema, taskPatchSchema } from './company/schemas'
/**
 * zod request schemas for every invoke channel (CONTRACT §4.2). Main validates every renderer request before the
 * handler runs; failures answer `bad_request` with per-field errors. `satisfies` keeps this map exhaustive.
 */
import { z } from 'zod'
import { EMBLEM_VARIANTS } from '../shared/chatCompany'
import { CLOUD_REQUEST_SCHEMAS } from './cloud/schemas'
import { PLANS_REQUEST_SCHEMAS } from './company/plansSchemas'
import { CHAT_REQUEST_SCHEMAS } from './chat/chatSchemas'
import { REMOTE_REQUEST_SCHEMAS } from './remote/remoteSchemas'
import { BROWSER_REQUEST_SCHEMAS } from './browser/schemas'
import { siteOrigin } from '../shared/remote'
import { ADAPTER_IDS, ARTIFACT_KINDS, SCRIPT_LANGS } from '../shared/types'
import { MEMORY_FACT_KINDS, MEMORY_MODES, MEMORY_SCOPES, MEMORY_STATUSES } from '../shared/memory'
import { PASTED_IMAGE_TYPES, type InvokeChannel } from '../shared/ipc'
import { DASHBOARD_KINDS, type DashboardKind } from '../shared/dashboards'
import { AGENT_STATUSES } from '../shared/live'
import { USAGE_RANGES } from '../shared/usage'
import { ROUTINE_IDS, type RoutineId } from '../shared/routines'
import { PLAYBOOK_IDS } from '../shared/autopilotPlaybooks'
import { PROPOSAL_KINDS, PROPOSAL_STATUSES } from '../shared/passport'
import { BRIEF_MAX, GITHUB_FULL_NAME, LaunchInputSchema, MAX_ONBOARDING_PATHS, MAX_URL_LENGTH, ONBOARDING_KEY_NAMES, PlanInputSchema, SOFT_LAUNCH_STEPS } from '../shared/onboarding'

const id = z.string().min(1).max(64).regex(/^[a-z]+_[0-9a-z]+$/, 'invalid id')
/** AUTOPILOT.md §6 */
const playbookId = z.enum(PLAYBOOK_IDS)
const playbookLimitsInput = z.object({ maxChanges: z.number().int().min(1).max(5).optional(), budgetCapUsd: z.number().min(1).max(100_000).nullable().optional(), targets: z.array(z.string().max(120)).max(50).optional() }).strict()
const routineRecord = z.object({ scheduleId: id, workflowId: id.nullable().optional(), onAt: z.string().max(40) }).strict()
const none = z.unknown().transform(() => undefined)
const adapter = z.enum(ADAPTER_IDS)
const iso = z.string().min(1).max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date')
const absPath = z.string().min(1).max(4096).refine((s) => s.startsWith('/'), 'must be an absolute path')
const ptySize = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }
const optObj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).nullish().transform((v) => v ?? undefined)

const memoryMode = z.enum(MEMORY_MODES)
/** COMPANY.md §7: the optional list filter; absent = all companies. */
const companyId = id.optional()
/** COMPANY.md §4: null = Shared keys; absent = Shared. */
const keySpace = id.nullish()
const marketRef = z.object({ source: z.enum(['builtin', 'remote']), id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) })
const slug = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id must be a lowercase slug').max(64)
const nodeBase = {
  id: slug,
  label: z.string().max(200),
  after: z.array(z.string().max(64)).max(100),
  cwd: z.string().max(4096).nullable(),
  timeoutMin: z.number().int().min(1).max(24 * 60),
  memory: memoryMode.optional(),
  isolate: z.literal('worktree').nullish()
}
const workflowNode = z.discriminatedUnion('type', [
  z.object({ ...nodeBase, type: z.literal('agent'), profileId: z.string().max(64), prompt: z.string().max(200_000) }),
  z.object({
    ...nodeBase,
    type: z.literal('room'),
    participants: z.array(z.object({ profileId: z.string().max(64), label: z.string().max(80) })).max(12),
    topic: z.string().max(200_000),
    rounds: z.number().int().min(1).max(10),
    final: z.enum(['last', 'summary'])
  }),
  z.object({
    ...nodeBase,
    type: z.literal('check'),
    profileId: z.string().max(64).nullable(),
    command: z.string().max(20_000).nullable(),
    target: z.string().max(64),
    criteria: z.string().max(200_000),
    maxRetries: z.number().int().min(0).max(5)
  }),
  z.object({ ...nodeBase, type: z.literal('shell'), command: z.string().max(200_000), lang: z.enum(SCRIPT_LANGS).nullish() }),
  // AUTHORING.md §4
  z.object({
    ...nodeBase,
    type: z.literal('wait'),
    command: z.string().max(20_000),
    until: z.enum(['exit0', 'match']),
    pattern: z.string().max(500).nullable(),
    intervalSec: z.number().int().min(5).max(3600),
    onTimeout: z.enum(['fail', 'continue'])
  }),
  z.object({
    ...nodeBase,
    type: z.literal('notify'),
    title: z.string().max(200),
    message: z.string().max(20_000),
    // SLACK.md §10 (SA3): `slack` replaces iMessage; a legacy `imessage` is accepted and converted by normalizeDraft
    slack: z
      .union([z.object({ kind: z.literal('me') }).strict(), z.object({ kind: z.literal('channel'), channel: z.string().regex(/^[CGD][A-Z0-9]{1,20}$/, 'channel id') }).strict()])
      .nullish(),
    migratedFrom: z.literal('imessage').nullish(),
    imessage: z.boolean().optional()
  })
])
export const workflowDraft = z.object({
  name: z.string().max(200),
  description: z.string().max(10_000).default(''),
  inputs: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'input name must be an identifier').max(64),
        label: z.string().max(200),
        default: z.string().max(100_000).optional(),
        type: z.enum(['text', 'multiline', 'repo', 'boolean']).optional()
      })
    )
    .max(50)
    .default([]),
  nodes: z.array(workflowNode).max(200),
  worktree: z.object({ repo: z.string().min(1).max(4096), base: z.string().max(200).nullish(), pushBranches: z.array(z.string().regex(/^[A-Za-z0-9._/*-]{1,100}$/, 'branch pattern: letters, digits, . _ / - and *')).max(20).nullish() }).nullish(),
  // SLACK.md §9.4: headless claude steps get the slack toolset
  slackTools: z.boolean().optional(),
  slackAgentPermissions: z.enum(['restricted', 'profile']).optional()
})
export const workflowFile = z.object({ hive: z.literal('workflow'), version: z.literal(1), workflow: workflowDraft })

const promptTarget = z.object({
  kind: z.literal('prompt'),
  profileId: z.string().max(64),
  repoId: z.string().max(64).nullable(),
  prompt: z.string().min(1, 'Prompt is empty').max(200_000),
  secretNames: z.array(z.string().max(128)).max(200).optional(),
  memory: memoryMode.optional()
})
const workflowTarget = z.object({
  kind: z.literal('workflow'),
  workflowId: z.string().max(64),
  inputs: z.record(z.string().max(64), z.string().max(200_000))
})
const runTarget = z.discriminatedUnion('kind', [promptTarget, workflowTarget])
/** DEPARTMENTS.md §8: a schedule's target may be in task mode (one standing card assigned to agentId). */
const scheduleMode = { mode: z.enum(['run', 'task']).optional(), agentId: id.nullish() }
const scheduleTarget = z.discriminatedUnion('kind', [promptTarget.extend(scheduleMode), workflowTarget.extend(scheduleMode)])
const when = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), cron: z.string().min(1).max(200), tz: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('at'), at: iso })
])
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const preset = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('weekdays'), time: hhmm }),
    z.object({ kind: z.literal('daily'), time: hhmm }),
    z.object({ kind: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
    z.object({ kind: z.literal('everyNMinutes'), n: z.number().int().min(1).max(1440) }),
    z.object({ kind: z.literal('once'), at: iso }),
    z.object({ kind: z.literal('cron') })
  ])
  .nullable()
const scheduleInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  target: scheduleTarget,
  when,
  preset: preset.optional(),
  enabled: z.boolean().optional(),
  departmentId: id.nullish()
})
const profileFields = {
  name: z.string().trim().min(1).max(100),
  adapter,
  model: z.string().max(200).nullable(),
  extraArgs: z.array(z.string().max(1000)).max(50),
  permissionMode: z.enum(['default', 'bypass']),
  secretNames: z.array(z.string().max(128)).max(500),
  useApiKeyAuth: z.boolean()
}
const autopilotRecord = z
  .object({
    enabledAt: z.string().max(40),
    paused: z.boolean(),
    steps: z.record(z.string().regex(/^[a-z_]{1,32}$/), z.object({ scheduleId: id, workflowId: id.nullable().optional() }).strict()).refine((r) => Object.keys(r).length <= 20, 'Too many steps'),
    publish: z.array(z.enum(['x', 'linkedin', 'instagram', 'tiktok', 'youtube'])).max(5)
  })
  .strict()
const settingsPatch = z
  .object({
    launchAtLogin: z.boolean(),
    notifyOnSuccess: z.enum(['never', 'scheduled', 'always']),
    notifyOnFailure: z.boolean(),
    notificationSound: z.boolean(),
    keepAwake: z.boolean(),
    concurrency: z.number().int().min(1).max(16),
    defaultAdapter: adapter,
    lastRepoId: z.string().max(64).nullable(),
    schedulesPaused: z.boolean(),
    onboardingDone: z.boolean(),
    sidebarCollapsed: z.boolean(),
    terminalFontSize: z.number().int().min(9).max(24),
    interactiveBypass: z.boolean(),
    sessionMemory: memoryMode,
    autoRetryRateLimit: z.boolean(),
    stallMinutes: z.number().int().min(1).max(240),
    claudeHistory: z.boolean(),
    // SLACK.md §7.1 (imessageHandle removed, SA3: a patch carrying it is rejected by .strict())
    slackAlertUserId: z.string().regex(/^[UW][A-Z0-9]{2,20}$/, 'Slack user id').nullable(),
    slackMirrorNeedsYou: z.boolean(),
    notifyNeedsYou: z.boolean(),
    // RELEASING.md §4.1
    betaUpdates: z.boolean(),
    slackBackfillDays: z.number().int().min(0).max(90),
    slackTriggerCatchupMin: z.number().int().min(0).max(120),
    slackAutoPaused: z.boolean(),
    marketplaceUrl: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((u) => u.startsWith('https://'), 'Use an https:// link')
      .nullable(),
    // REMOTE.md RA6: an https origin (or loopback http, for a phone app served on this Mac); '' = none, null = official
    phoneSiteUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((u) => u === '' || siteOrigin(u) === u.replace(/\/+$/, ''), 'Use the site address, like https://phone.example.com')
      .transform((u) => (u === '' ? '' : siteOrigin(u)!))
      .nullable(),
    // REMOTE.md RA8: null = the default (on once a phone is paired)
    phoneAutoStart: z.boolean().nullable(),
    // COMPANY.md §8.6: UI state only (main never reads it to decide anything)
    activeCompanyId: z.union([z.literal('all'), id]),
    expandedCompanies: z.record(id, z.boolean()).refine((r) => Object.keys(r).length <= 1000, 'Too many companies'),
    // COMPANY.md §6: a partial patch, merged into the stored flags
    experimental: z.object({ companies: z.boolean(), vault: z.boolean(), vaultAI: z.boolean(), departments: z.boolean(), plans: z.boolean() }).partial().strict(),
    // VOICE.md §0
    tone: z.enum(['playful', 'plain']),
    personas: z.boolean(),
    // AGENT-COLLAB.md §2: the guards of agents asking agents (ranges = AGENT_COLLAB_RANGES)
    agentCollab: z
      .object({
        enabled: z.boolean(),
        maxHops: z.number().int().min(1).max(6),
        perThread: z.number().int().min(1).max(20),
        perAgentPerHour: z.number().int().min(1).max(60),
        perAskerPerHour: z.number().int().min(1).max(60),
        perCompanyPerDay: z.number().int().min(1).max(500),
        waitDefaultS: z.number().int().min(0).max(600),
        waitMaxS: z.number().int().min(0).max(600)
      })
      .partial()
      .strict(),
    // ORCHESTRATOR.md §6: Principia's own layer between runs (ranges = ORCHESTRATOR_RANGES)
    orchestrator: z
      .object({
        mode: z.enum(['off', 'shadow', 'on']),
        coordinator: z.enum(['off', 'rules', 'model']),
        cli: z.enum(['auto', 'claude', 'codex']),
        callsPerDay: z.number().int().min(0).max(200),
        extractFallback: z.boolean(),
        // This company > Team & autonomy > "Principia runs the team"
        companies: z
          .record(id, z.object({ mode: z.enum(['off', 'on']), coordinator: z.enum(['off', 'rules', 'model']), callsPerDay: z.number().int().min(0).max(200) }).partial().strict())
          .refine((r) => Object.keys(r).length <= 1000, 'Too many companies')
      })
      .partial()
      .strict(),
    // AUTOPILOT.md §4: UI bookkeeping of what each autopilot created
    autopilots: z.record(id, z.object({ marketing: autopilotRecord, company: autopilotRecord }).partial().strict()).refine((r) => Object.keys(r).length <= 1000, 'Too many companies'),
    // Automations › Routines: UI bookkeeping of what each routine's Turn on created
    routines: z
      .record(id, z.object(Object.fromEntries(ROUTINE_IDS.map((r) => [r, routineRecord])) as Record<RoutineId, typeof routineRecord>).partial().strict())
      .refine((r) => Object.keys(r).length <= 1000, 'Too many companies'),
    // Home suggestions dismissed for good, per company (UI state)
    nudges: z
      .record(id, z.record(z.string().regex(/^[a-z][a-z0-9:-]{0,80}$/), z.string().max(40)).refine((r) => Object.keys(r).length <= 100, 'Too many suggestions'))
      .refine((r) => Object.keys(r).length <= 1000, 'Too many companies'),
    // PROACTIVE.md
    proactiveAgents: z.boolean(),
    trackTasks: z.enum(['off', 'auto', 'always']),
    // CHAT-UI.md §4.4
    openChatsAs: z.enum(['auto', 'chat', 'terminal']),
    // Five doors: the sidebar's pins and More visibility per company ('all' = All companies). UI state only.
    sidebarNav: z
      .record(
        z.union([z.literal('all'), id]),
        z
          .object({
            pins: z.array(z.string().regex(/^(dept:)?[A-Za-z0-9_-]{1,64}$/)).max(50),
            visibility: z.record(z.string().regex(/^[a-z]{1,32}$/), z.enum(['always', 'active', 'hidden'])).refine((r) => Object.keys(r).length <= 50, 'Too many items')
          })
          .partial()
          .strict()
      )
      .refine((r) => Object.keys(r).length <= 1000, 'Too many companies'),
    // Five doors step 5: one-time notices the person dismissed ("things-moved" → when). UI state only.
    notices: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), z.string().max(40)).refine((r) => Object.keys(r).length <= 50, 'Too many notices'),
    // Five doors step 5: a company just set up whose first week waits for "Start the first week?" on Home. UI state only.
    firstWeek: z
      .record(id, z.object({ journalId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), scheduleRefs: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,30}$/)).max(8) }).strict())
      .refine((r) => Object.keys(r).length <= 100, 'Too many companies')
  })
  .partial()
  .strict()
const menuItem: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string().max(200).optional(),
    label: z.string().max(500).optional(),
    type: z.enum(['normal', 'separator', 'checkbox']).optional(),
    checked: z.boolean().optional(),
    enabled: z.boolean().optional(),
    accelerator: z.string().max(64).optional(),
    submenu: z.array(menuItem).max(100).optional()
  })
)
const secretName = z.string().min(1).max(128)
const dashboardKind = z.enum(DASHBOARD_KINDS as unknown as [DashboardKind, ...DashboardKind[]])
const dashboardConfig = z.record(z.string().regex(/^[a-zA-Z]{1,40}$/), z.union([z.string().max(2000), z.array(z.string().max(500)).max(20)]))
const dashboardKeys = z.record(secretName.regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(64 * 1024))

// ---------- Passport vault (PASSPORT.md §11; implemented by P3) ----------
/** frontmatter id, or `h:<vault-relative path>` for a note without one (§3.1) */
const noteId = z.union([z.string().regex(/^n-[0-9a-z]{10}$/, 'invalid note id'), z.string().regex(/^h:[^\0]{1,1024}$/, 'invalid note id')])
/** vault-relative markdown path: no leading slash, no `..`, no NUL */
const notePath = z
  .string()
  .min(4)
  .max(1024)
  .refine((p) => !p.startsWith('/') && !p.includes('\0') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '.' || s === ''), 'invalid vault path')
  .refine((p) => p.toLowerCase().endsWith('.md'), 'notes are .md files')
/** `[[Title]]`, title, alias, path or note id */
const noteName = z.string().trim().min(1).max(300)
const blockRef = z.union([z.string().regex(/^[fr]-[0-9a-z]{10}$/, 'invalid block id'), z.string().regex(/^h:[0-9a-f]{40}$/, 'invalid block id')])
const contentHash = z.string().regex(/^[0-9a-f]{40}$/, 'invalid hash')
const proposalId = z.string().regex(/^sg-[0-9a-z]{4,32}$/, 'invalid suggestion id')
const vaultTitle = z.string().trim().min(1).max(200)
const vaultType = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/, 'type is a lowercase word')
const vaultText = z.string().trim().min(1).max(2000)
const vaultTag = z.string().regex(/^[A-Za-z0-9_/-]{1,100}$/, 'invalid tag')
const relType = z.string().trim().min(2).max(60)
const propKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, 'invalid property key')
const propValue = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.string().max(500)).max(100), z.null()])
const properties = z.record(propKey, propValue).refine((r) => Object.keys(r).length <= 50, 'Too many properties')
const folder = z.string().max(300).refine((p) => !p.startsWith('/') && !p.split('/').some((s) => s === '..'), 'invalid folder')
const vaultOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createNote'), title: vaultTitle, type: vaultType, summary: z.string().max(500).optional(), aliases: z.array(vaultTitle).max(20).optional(), properties: properties.optional(), folder: folder.optional() }).strict(),
  z.object({ op: z.literal('observe'), note: noteName, category: z.string().trim().min(1).max(40).regex(/^[^[\]()]+$/, 'category without brackets'), text: vaultText, tags: z.array(vaultTag).max(20).optional() }).strict(),
  z.object({ op: z.literal('relate'), from: noteName, rel: relType, to: noteName, context: z.string().max(300).optional() }).strict(),
  z.object({ op: z.literal('supersede'), blockId: blockRef, text: vaultText }).strict(),
  z.object({ op: z.literal('invalidate'), blockId: blockRef, reason: z.string().trim().min(1).max(200) }).strict(),
  z.object({ op: z.literal('setProperty'), note: noteName, key: propKey, value: propValue }).strict(),
  z.object({ op: z.literal('addAlias'), note: noteName, alias: vaultTitle }).strict(),
  z.object({ op: z.literal('rename'), note: noteName, newTitle: vaultTitle }).strict(),
  z.object({ op: z.literal('archive'), note: noteName }).strict(),
  z.object({ op: z.literal('merge'), from: noteName, into: noteName }).strict(),
  z.object({ op: z.literal('linkMention'), note: noteName, line: z.number().int().min(0).max(1_000_000), span: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).refine((s) => s.end > s.start, 'empty span'), target: noteName, text: z.string().min(1).max(500).optional() }).strict(),
  z.object({ op: z.literal('materializeId'), note: noteName, line: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ op: z.literal('restoreLine'), blockId: blockRef }).strict(),
  z.object({ op: z.literal('reinforce'), blockId: blockRef, example: z.string().max(300).optional() }).strict()
])
const vaultOps = z.array(vaultOp).min(1).max(200)
const graphFilters = z
  .object({
    search: z.string().max(200).optional(),
    tags: z.array(vaultTag).max(50).optional(),
    types: z.array(vaultType).max(30).optional(),
    existingOnly: z.boolean().optional(),
    orphans: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    includeTags: z.boolean().optional()
  })
  .strict()
const passportGraph = z.discriminatedUnion('op', [
  z.object({ op: z.literal('global'), companyId: id, filters: graphFilters.optional() }).strict(),
  z.object({
    op: z.literal('local'),
    companyId: id,
    noteId,
    depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    filters: z.object({ tags: z.boolean().optional(), ghosts: z.boolean().optional(), includeArchived: z.boolean().optional() }).strict().optional()
  }).strict(),
  z.object({
    op: z.literal('layout'),
    companyId: id,
    positions: z.array(z.object({ noteId: z.string().min(1).max(1100), x: z.number().finite(), y: z.number().finite(), pinned: z.boolean().optional() }).strict()).max(10_000)
  }).strict()
])

// ---------- Slack (CONTRACT "Slack.5") ----------
const slackChannelId = z.string().regex(/^[CGD][A-Z0-9]{1,20}$/, 'Slack channel id')
const slackUserId = z.string().regex(/^[UW][A-Z0-9]{1,20}$/, 'Slack user id')
const slackTs = z.string().regex(/^\d{1,12}\.\d{1,6}$/, 'Slack ts')
const slackTriggerInput = z.object({
  name: z.string().max(120),
  workflowId: id,
  enabled: z.boolean().optional(),
  match: z.object({
    on: z.array(z.enum(['mention', 'dm', 'message'])).min(1).max(3),
    channels: z.array(slackChannelId).max(50).default([]),
    keywords: z.array(z.string().min(1).max(100)).max(20).default([]),
    regex: z.string().max(300).nullable().default(null),
    fromUsers: z.array(slackUserId).max(50).default([]),
    fallback: z.boolean().optional()
  }),
  reply: z.object({
    mode: z.enum(['draft', 'auto', 'none']),
    autoChannels: z.array(z.union([slackChannelId, z.literal('dm'), z.literal('*')])).max(20).default([]),
    replyNode: z.string().max(64).nullable().optional()
  }),
  limits: z.object({ debounceSec: z.number().int().min(0).max(600).optional(), maxRunsPerThreadPerHour: z.number().int().min(1).max(30).optional() }).optional(),
  inputs: z.record(z.string().max(64), z.string().max(2000)).optional(),
  // SLACK.md SA2: absent = restricted agents, no vault keys
  access: z
    .object({
      fullPermissions: z.boolean(),
      secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(50),
      // reads beyond the triggering conversation: channels only (never DMs); absent = none
      readChannels: z.array(z.string().regex(/^[CG][A-Z0-9]{1,20}$/, 'Read channels are channel ids (C…/G…), never DMs')).max(50).optional()
    })
    .optional(),
  // DEPARTMENTS.md §8: absent = 'run'
  action: z.enum(['run', 'task']).optional(),
  departmentId: id.nullish()
})


// ---------- onboarding (ONBOARDING.md §4) ----------
/** Opaque handles minted by main (journal, draft, stash, plan request). */
const obHandle = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id')
const obPaths = z.array(absPath).min(1).max(MAX_ONBOARDING_PATHS)
/** A plan ref (`weekly-review`) of a schedule the journal created. */
const obRef = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'invalid ref')

// ---------- memory (CONTRACT §11.5; limits from MEMORY.md §4.2) ----------
const memId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{1,32}$`), 'invalid id')
const entityId = memId('ment')
const factId = memId('mfa')
const relId = memId('mrel')
const memIds = <T extends z.ZodType>(t: T) => z.array(t).min(1).max(1000)
const memScopeSel = z.union([z.literal('all'), z.literal('global'), z.object({ repoId: id })])
const memFilter = {
  scope: memScopeSel,
  kinds: z.array(z.enum(MEMORY_FACT_KINDS)).max(4).optional(),
  adapters: z.array(adapter).max(5).optional(),
  actors: z.array(z.enum(['agent', 'user'])).max(2).optional(),
  statuses: z.array(z.enum(MEMORY_STATUSES)).max(3).optional(),
  unreviewedOnly: z.boolean().optional(),
  runId: id.optional(),
  sessionId: id.optional(),
  companyId
}
const memName = z.string().trim().min(1).max(120)
const memType = z.string().trim().min(1).max(40)
const memRelType = z.string().trim().min(2).max(40)
const memFactText = z.string().trim().min(3).max(1000)
const memAliases = z.array(z.string().trim().min(1).max(120)).max(20)
const memFactOrRel = z.enum(['fact', 'relation'])
const memoryMutation = z.union([
  z.object({
    op: z.literal('create'),
    target: z.literal('entity'),
    input: z.object({ repoId: id.nullable(), name: memName, type: memType.optional(), summary: z.string().max(500).optional(), aliases: memAliases.optional() })
  }),
  z.object({
    op: z.literal('create'),
    target: z.literal('fact'),
    input: z.object({
      entityId,
      text: memFactText,
      kind: z.enum(MEMORY_FACT_KINDS).optional(),
      scope: z.enum(MEMORY_SCOPES),
      repoId: id.nullish(),
      pinned: z.boolean().optional(),
      supersedes: z.array(factId).max(10).optional()
    })
  }),
  z.object({
    op: z.literal('create'),
    target: z.literal('relation'),
    input: z.object({ fromId: entityId, toId: entityId, type: memRelType, scope: z.enum(MEMORY_SCOPES) })
  }),
  z.object({ op: z.literal('edit'), target: z.literal('fact'), id: factId, text: memFactText.optional(), kind: z.enum(MEMORY_FACT_KINDS).optional() }),
  z.object({
    op: z.literal('edit'),
    target: z.literal('entity'),
    id: entityId,
    type: memType.optional(),
    summary: z.string().max(500).optional(),
    aliases: memAliases.optional()
  }),
  z.object({ op: z.literal('edit'), target: z.literal('relation'), id: relId, type: memRelType }),
  z.object({ op: z.literal('rename'), id: entityId, name: memName }),
  z.object({ op: z.enum(['pin', 'unpin']), ids: memIds(factId) }),
  z.object({ op: z.literal('approve'), target: memFactOrRel, ids: memIds(z.string().max(64)) }),
  z.object({ op: z.literal('invalidate'), target: memFactOrRel, ids: memIds(z.string().max(64)), reason: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal('restore'), target: memFactOrRel, ids: memIds(z.string().max(64)) }),
  z.object({ op: z.literal('toGlobal'), ids: memIds(factId) }),
  z.object({ op: z.literal('merge'), sourceIds: z.array(entityId).min(1).max(50), targetId: entityId })
])

/**
 * DEPARTMENTS.md §1.3 fields only main writes (run outcome, wake guard, routing, done note). The renderer changes them
 * through the dedicated task channels (assign, answer, approve, sendBack, unpark), never through create/update.
 */
const TASK_SYSTEM_FIELDS = { blockReason: true, ask: true, report: true, doneNote: true, routing: true, pendingWake: true, agentSessionId: true, autoWakes: true, handoffs: true, work: true, brief: true, proof: true, plan: true } as const
export const REQUEST_SCHEMAS = {
  'gateway:connect': z.object({ id: slug }),
  'gateway:disconnect': z.object({ id: slug }),
  'gateway:list': optObj({ companyId: id.optional() }),
  'gateway:remove': z.object({ id: slug }),
  'gateway:test': z.object({ id: slug }),
  // COMPANY.md §6: companyIds limits a connection to those companies' spawns; absent = all companies
  'gateway:save': z.object({ id: slug, name: z.string().min(1).max(100), transport: z.enum(['stdio', 'http']), authentication: z.enum(['none', 'oauth']).optional(), command: z.string().max(4096).optional(), args: z.array(z.string().max(4096)).max(100).optional(), url: z.string().url().max(4096).optional(), enabled: z.boolean(), roots: z.array(absPath).max(100), scope: z.enum(['projects', 'global']).optional(), credentials: z.record(z.string().min(1).max(100), z.string().max(20000)).optional(), companyIds: z.array(id).max(100).optional() }).strict(),
  'app:info': none,
  'app:status': none,
  'app:home': none,
  'app:canvas': optObj({ companyId }),
  'app:quit': none,
  'app:openExternal': z.object({ url: z.string().url().max(4096) }),
  'app:showItemInFolder': z.object({ path: absPath }),
  'app:hideWindow': none,
  'settings:get': none,
  'settings:update': settingsPatch,
  'providers:list': optObj({ refresh: z.boolean().optional() }),
  'providers:claudeAuth': optObj({ refresh: z.boolean().optional() }),
  'repos:list': optObj({ companyId }),
  'repos:pick': optObj({ companyId }),
  'repos:add': z.object({ paths: z.array(absPath).min(1).max(200), companyId }),
  'repos:update': z.object({ id, name: z.string().trim().min(1).max(200) }),
  'repos:move': z.object({ id, targetId: id, placement: z.enum(['before', 'after']) }),
  'repos:remove': z.object({ id }),
  'repos:siblings': z.object({ id }),
  'profiles:list': none,
  'profiles:create': z.object({
    name: profileFields.name,
    adapter,
    model: profileFields.model.optional(),
    extraArgs: profileFields.extraArgs.optional(),
    permissionMode: profileFields.permissionMode.optional(),
    secretNames: profileFields.secretNames.optional(),
    useApiKeyAuth: profileFields.useApiKeyAuth.optional()
  }),
  'profiles:update': z.object({ id, ...profileFields }).partial().required({ id: true }),
  'profiles:remove': z.object({ id }),
  'sessions:list': optObj({ status: z.enum(['running', 'exited', 'all']).optional(), companyId }),
  'sessions:create': z.object({
    companyId,
    profileId: id.optional(),
    adapter: adapter.optional(),
    repoId: id.nullish(),
    cwd: absPath.optional(),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    title: z.string().max(200).optional(),
    memory: memoryMode.optional(),
    departmentId: id.optional(),
    initialPrompt: z.string().trim().min(1).max(8000).optional()
  }),
  'sessions:attach': z.object({ id }),
  'sessions:kill': z.object({ id }),
  'sessions:remove': z.object({ id }),
  'sessions:rename': z.object({ id, title: z.string().trim().min(1).max(200) }),
  'sessions:restart': z.object({ id }),
  'sessions:handoff': z.object({ id, adapter: z.enum(['claude', 'codex']) }),
  'sessions:saveImage': z.object({
    id,
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength > 0 && d.byteLength <= 20 * 1024 * 1024, 'Image is empty or over 20 MB'),
    type: z.enum(PASTED_IMAGE_TYPES)
  }),
  'workflows:list': optObj({ companyId }),
  'workflows:get': z.object({ id }),
  'workflows:create': workflowDraft.extend({ companyId }),
  'workflows:update': z.object({ id, draft: workflowDraft }),
  'workflows:remove': z.object({ id }),
  'workflows:duplicate': z.object({ id, companyId }),
  'workflows:validate': workflowDraft,
  'workflows:export': z.object({ id }),
  'workflows:import': optObj({ companyId }),
  'company:list': optObj({ includeArchived: z.boolean().optional() }),
  'company:save': z.object({id: id.optional(), passport: passportInputSchema}),
  'company:create': companyCreateSchema,
  'company:update': z.object({ id, patch: companyUpdateSchema }).strict(),
  'company:archive': z.object({ id, archived: z.boolean().optional() }).strict(),
  'company:reorder': z.object({ ids: companyReorderSchema }).strict(),
  'company:assignRepo': assignRepoSchema,
  'company:overview': none,
  'company:pause': z.object({ id, paused: z.boolean() }).strict(),
  'company:logos': none,
  'company:logoCandidates': z.object({ id }).strict(),
  'company:setLogo': z.object({
    id,
    pick: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('candidate'), path: z.string().min(1).max(4096) }).strict(),
      z.object({ kind: z.literal('file') }).strict(),
      z.object({ kind: z.literal('none') }).strict(),
      z.object({ kind: z.literal('auto') }).strict(),
      z.object({ kind: z.literal('emblem'), variant: z.enum(EMBLEM_VARIANTS), keepDetected: z.boolean().optional() }).strict()
    ])
  }).strict(),
  'company:export': z.object({id}),
  'company:previewImport': z.object({json: z.string().max(300_000)}),
  'company:import': z.object({json: z.string().max(300_000),repoIds:z.array(id).max(500)}),
  'company:exportOpenPassport': z.object({id}).strict(),
  'company:previewOpenPassport': optObj({source: z.string().min(1).max(4096).optional()}),
  'company:openPassportSync': z.discriminatedUnion('op', [
    z.object({op: z.literal('get'), companyId: id}).strict(),
    z.object({op: z.literal('set'), companyId: id, url: z.string().url().max(2000), passportId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), token: z.string().max(4000).optional()}).strict(),
    z.object({op: z.literal('clear'), companyId: id}).strict(),
    z.object({op: z.literal('sync'), companyId: id}).strict()
  ]),
  'company:passportConnect': z.discriminatedUnion('op', [
    z.object({op: z.literal('info'), companyId: id}).strict(),
    z.object({op: z.literal('install'), companyId: id, app: z.literal('claude-desktop')}).strict(),
    z.object({op: z.literal('open'), companyId: id, app: z.enum(['cursor','vscode']), hosted: z.boolean().optional()}).strict(),
    z.object({op: z.literal('hostSignIn'), companyId: id}).strict(),
    z.object({op: z.literal('ingest'), companyId: id}).strict()
  ]),
  'company:passportImport': z.object({companyId: id, kind: z.enum(['export','folder','url','text']), source: z.string().min(1).max(4096).optional(), text: z.string().max(200_000).optional(), max: z.number().int().min(1).max(200).optional()}).strict()
    .refine((q)=>q.kind!=='text'||!!q.text?.trim(),'Paste some text to import').refine((q)=>q.kind!=='url'||/^https?:\/\//i.test(q.source??''),'Enter the website address (https://…)'),
  'company:importOpenPassport': z.object({source: z.string().min(1).max(4096), mode: z.enum(['new','merge']), companyId: id.optional(), repoIds: z.array(id).max(500).optional()}).strict().refine((q)=>q.mode==='new'||!!q.companyId,'Choose the company to merge into'),
  'tasks:previewGithub': z.object({url:z.string().url().max(4000)}),
  'tasks:list': optObj({companyId: id.optional()}),
  'tasks:create': z.object({task:taskInputSchema.omit(TASK_SYSTEM_FIELDS)}),
  'tasks:update': z.object({id,patch:taskPatchSchema.omit(TASK_SYSTEM_FIELDS)}),
  'tasks:get': z.object({id}),
  'tasks:start': z.object({id,profileId:id.optional()}),
  'tasks:comment': z.object({id,message:z.string().trim().min(1).max(10_000),
    /** five doors D11: the agent desk's reply, said in the agent's voice; an agent comment never wakes the task */
    by:z.enum(['human','agent']).optional()}),
  // DEPARTMENTS.md §10
  'departments:list': optObj({ companyId, includeArchived: z.boolean().optional() }),
  'departments:save': departmentSaveSchema,
  'departments:archive': z.object({ id, archived: z.boolean().optional() }).strict(),
  'departments:reorder': departmentReorderSchema,
  'departments:createPresets': departmentPresetsSchema,
  'companyAgents:list': optObj({ companyId, departmentId: id.nullable().optional(), includeArchived: z.boolean().optional() }),
  'companyAgents:save': companyAgentSaveSchema,
  'companyAgents:archive': z.object({ id, archived: z.boolean().optional() }).strict(),
  'companyAgents:pause': z.object({ id }).strict(),
  'companyAgents:resume': z.object({ id }).strict(),
  'tasks:assign': z.object({ id, departmentId: id.nullable().optional(), agentId: id.nullable().optional() }).strict()
    .refine((q) => q.departmentId !== undefined || q.agentId !== undefined, 'Choose a department or an agent'),
  'tasks:acceptRoute': z.object({ id }).strict(),
  'tasks:answer': z.object({ id, answer: z.string().trim().min(1, 'Answer is empty').max(10_000) }).strict(),
  'tasks:approve': z.object({ id, doneNote: z.string().trim().min(1, 'A done note is required').max(10_000) }).strict(),
  'tasks:sendBack': z.object({ id, note: z.string().trim().min(1, 'Say what to change').max(10_000) }).strict(),
  'tasks:unpark': z.object({ id }).strict(),
  'tasks:openSession': z.object({ id, ...ptySize }).strict(),
  'tasks:takeover': z.object({ id, ...ptySize }).strict(),
  'tasks:stop': z.object({ id }).strict(),
  'tasks:pause': z.object({ id }).strict(),
  'board:autopilot': z.object({ companyId: id, on: z.boolean(), maxInFlight: z.number().int().min(1).max(20).optional(), confirmed: z.boolean().optional() }).strict(),
  'board:autopilotPreview': z.object({ companyId: id }).strict(),
  'playbooks:list': z.object({ companyId: id }).strict(),
  'playbooks:summary': none,
  'playbooks:overview': z.object({ companyId: id }).strict(),
  'playbooks:turnOn': z.object({ companyId: id, playbookId: playbookId, level: z.number().int().min(1).max(3), raise: z.boolean().optional(), limits: playbookLimitsInput.optional() }).strict(),
  'playbooks:configure': z.object({ companyId: id, playbookId: playbookId, level: z.number().int().min(1).max(3).optional(), raise: z.boolean().optional(), limits: playbookLimitsInput.optional() }).strict(),
  'playbooks:setPaused': z.object({ companyId: id, playbookId: playbookId, paused: z.boolean() }).strict(),
  'playbooks:turnOff': z.object({ companyId: id, playbookId: playbookId }).strict(),
  // WORKTREE.md
  'taskWork:start': z.object({ id, profileId: id.optional() }).strict(),
  'taskWork:merge': z.object({ id }).strict(),
  'taskWork:remove': z.object({ id }).strict(),
  'taskWork:resolveGone': z.object({ id, choice: z.enum(['cancel', 'backlog', 'keep']) }).strict(),
  'taskWork:refresh': optObj({}),
  'taskWork:openEditor': z.object({ id }).strict(),
  // FORUM.md §9 (bounds mirror FORUM_LIMITS; the store re-checks every rule)
  'forum:state': z.object({ companyId: id }).strict(),
  'forum:messages': z.object({ companyId: id, channelId: id, beforeSeq: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  'forum:thread': z.object({ messageId: id }).strict(),
  'forum:post': z.object({
    companyId: id, channelId: id, text: z.string().trim().min(1, 'The message is empty').max(8000), threadId: id.nullish(),
    ask: z.object({ to: z.array(id).min(1).max(8), options: z.array(z.string().trim().min(1).max(120)).min(2).max(6).optional() }).strict().optional(),
    proposal: z.object({
      kind: z.enum(['department', 'agent']), reason: z.string().trim().min(3).max(600),
      department: z.object({ name: z.string().trim().min(1).max(80), key: z.string().trim().max(40).optional(), does: z.string().max(300), doesNot: z.string().max(300) }).strict().optional(),
      agent: z.object({ departmentKey: z.string().max(80).nullable(), role: z.string().trim().min(1).max(80), instructions: z.string().max(4000), capabilities: z.string().max(400), adapter: z.enum(['claude', 'codex', 'gemini', 'cursor']).optional() }).strict().optional()
    }).strict().refine((p) => (p.kind === 'department' ? !!p.department : !!p.agent), 'Fill in the proposal').optional()
  }).strict(),
  'forum:edit': z.object({ messageId: id, text: z.string().max(8000).nullable() }).strict(),
  'forum:react': z.object({ messageId: id, emoji: z.string().min(1).max(16) }).strict(),
  'forum:markRead': z.object({ channelId: id, seq: z.number().int().min(0).optional() }).strict(),
  'forum:createChannel': z.object({ companyId: id, name: z.string().trim().min(2).max(60), kind: z.enum(['public', 'private']), purpose: z.string().max(300).optional(), memberIds: z.array(id).max(50).optional() }).strict(),
  'forum:updateChannel': z.object({ channelId: id, topic: z.string().max(250).optional(), purpose: z.string().max(300).optional(), archived: z.boolean().optional() }).strict(),
  'forum:membership': z.discriminatedUnion('op', [
    z.object({ op: z.enum(['join', 'leave']), channelId: id }).strict(),
    z.object({ op: z.literal('add'), channelId: id, memberIds: z.array(id).min(1).max(50) }).strict(),
    z.object({ op: z.literal('remove'), memberId: id }).strict()
  ]),
  'forum:openDm': z.object({ companyId: id, memberIds: z.array(id).min(1).max(8) }).strict(),
  'forum:search': z.object({ companyId: id, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(100).optional() }).strict(),
  'forum:decide': z.object({
    messageId: id,
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(1000).optional(),
    edits: z.object({
      name: z.string().trim().min(1).max(80).optional(), key: z.string().trim().max(40).optional(), role: z.string().trim().min(1).max(80).optional(),
      departmentKey: z.string().trim().max(80).nullable().optional(), profileId: id.optional(), instructions: z.string().max(4000).optional(),
      capabilities: z.string().max(400).optional(), does: z.string().max(300).optional(), doesNot: z.string().max(300).optional()
    }).strict().optional()
  }).strict(),
  'forum:answer': z.object({ messageId: id, answer: z.string().trim().min(1, 'The answer is empty').max(4000) }).strict(),
  'forum:invite': z.object({ companyId: id, role: z.enum(['admin', 'member', 'guest']), channelIds: z.array(id).max(20).optional(), label: z.string().max(120).optional(), expiresInDays: z.number().int().min(0).max(365).optional(), maxUses: z.number().int().min(1).max(100).optional() }).strict(),
  'forum:invites': z.object({ companyId: id }).strict(),
  'forum:revokeInvite': z.object({ inviteId: id }).strict(),
  'forum:acceptInvite': z.object({ code: z.string().trim().min(8).max(120), name: z.string().trim().min(1).max(60), handle: z.string().trim().max(32).optional() }).strict(),
  'forum:toTask': z.object({ messageId: id, agentId: id.nullish() }).strict(),
  'forum:collab': z.object({ companyId: id }).strict(),
  'forum:runConversation': z.object({ runId: id }).strict(),
  'orchestrator:forRun': z.object({ runId: id }).strict(),
  'orchestrator:suggestions': optObj({ companyId: id.nullish() }),
  'orchestrator:decideSuggestion': z.object({ id, decision: z.enum(['accept', 'dismiss', 'never']), level: z.number().int().min(1).max(3).optional() }).strict(),
  'orchestrator:decisions': z.object({ companyId: id, limit: z.number().int().min(1).max(100).optional() }).strict(),
  'marketplace:list': optObj({ refresh: z.boolean().optional() }),
  'marketplace:preview': marketRef,
  'marketplace:install': marketRef.extend({ overwrite: z.boolean().optional(), companyId }),
  // DASHBOARDS.md §8 (the service re-checks config fields and key names against the catalog)
  'dashboards:list': z.object({ companyId: id, departmentId: id.nullish() }).strict(),
  'dashboards:keys': z.object({ companyId: id, kind: dashboardKind }).strict(),
  'dashboards:install': z.object({ companyId: id, departmentId: id.nullable(), kind: dashboardKind, config: dashboardConfig, keys: dashboardKeys }).strict(),
  'dashboards:update': z.object({ id, config: dashboardConfig.optional(), keys: dashboardKeys.optional() }).strict(),
  'dashboards:refresh': z.object({ id }).strict(),
  'dashboards:remove': z.object({ id }).strict(),
  'dashboards:sample': z.object({ kind: dashboardKind }).strict(),
  // LINEAR.md §6
  'linear:status': z.object({ companyId: id }).strict(),
  'linear:checkKey': z.object({ companyId: id, key: z.string().max(500).optional() }).strict(),
  'linear:preview': z.object({ companyId: id, teamId: z.string().min(1).max(200), key: z.string().max(500).optional() }).strict(),
  'linear:connect': z.object({ companyId: id, key: z.string().max(500).optional(), teamId: z.string().min(1).max(100), autosync: z.boolean(), sendOpen: z.boolean() }).strict(),
  'linear:sync': z.object({ companyId: id }).strict(),
  'linear:setAutosync': z.object({ companyId: id, on: z.boolean() }).strict(),
  'linear:disconnect': z.object({ companyId: id }).strict(),
  'runs:start': z.object({ target: runTarget, companyId }),
  'runs:list': optObj({
    companyId,
    status: z.array(z.enum(['queued', 'running', 'passed', 'failed', 'canceled'])).max(5).optional(),
    workflowId: id.optional(),
    scheduleId: id.optional(),
    since: iso.optional(),
    limit: z.number().int().min(1).max(1000).optional()
  }),
  'runs:get': z.object({ id }),
  'runs:cancel': z.object({ id }),
  'runs:rerun': z.object({ id }),
  'runs:stepLog': z.object({ runId: id, stepId: id, tailBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(), view: z.enum(['raw', 'readable']).optional() }),
  'runs:openAsSession': z.object({ runId: id, stepId: id.optional() }),
  'schedules:list': optObj({ companyId }),
  'schedules:create': scheduleInput.extend({ companyId }),
  'schedules:update': z.object({ id, input: scheduleInput }),
  'schedules:remove': z.object({ id }),
  'schedules:setEnabled': z.object({ id, enabled: z.boolean() }),
  'schedules:runNow': z.object({ id }),
  'schedules:preview': z.object({ when }),
  'schedules:events': z.object({ scheduleId: id, limit: z.number().int().min(1).max(500).optional() }),
  'schedules:pauseAll': z.object({ paused: z.boolean() }),
  'secrets:list': optObj({ companyId: keySpace }),
  'secrets:set': z.object({ name: secretName, value: z.string().min(1, 'Value is empty').max(64 * 1024), label: z.string().max(200).optional(), companyId: keySpace }),
  'secrets:remove': z.object({ name: secretName, companyId: keySpace }),
  'secrets:reveal': z.object({ name: secretName, companyId: keySpace }),
  'secrets:copy': z.object({ name: secretName, companyId: keySpace }),
  'secrets:parseEnv': z.object({ text: z.string().max(1024 * 1024), companyId: keySpace }),
  'secrets:importEnv': z.object({ text: z.string().max(1024 * 1024), names: z.array(secretName).max(1000), companyId: keySpace }),
  'secrets:pickEnvFile': optObj({ companyId: keySpace }),
  'secrets:move': z.object({ name: secretName, from: id.nullable(), to: id.nullable() }).refine((v) => v.from !== v.to, 'Pick a different place'),
  'artifacts:list': optObj({
    companyId,
    runId: id.optional(),
    sessionId: id.optional(),
    kind: z.enum(ARTIFACT_KINDS).optional(),
    limit: z.number().int().min(1).max(5000).optional()
  }),
  'artifacts:thumbnail': z.object({ id, size: z.number().int().min(16).max(1024).optional() }),
  'artifacts:peek': z.object({ id, bytes: z.number().int().min(64).max(16384).optional() }),
  'artifacts:trash': z.object({ id }),
  'artifacts:quickLook': z.object({ id }),
  'artifacts:open': z.object({ id }),
  'artifacts:reveal': z.object({ id }),
  'artifacts:copyPath': z.object({ id }),
  'artifacts:openDir': z
    .object({ runId: id.optional(), sessionId: id.optional() })
    .refine((v) => !!v.runId !== !!v.sessionId, 'pass exactly one of runId or sessionId'),
  'ui:contextMenu': z.object({ items: z.array(menuItem).min(1).max(100) }),
  'ui:confirm': z.object({
    message: z.string().min(1).max(500),
    detail: z.string().max(4000).optional(),
    confirmLabel: z.string().min(1).max(60),
    destructive: z.boolean().optional(),
    suppressKey: z.string().regex(/^[a-zA-Z0-9_.:-]+$/).max(100).optional()
  }),
  'ui:setEdited': z.object({ edited: z.boolean() }),
  'clipboard:writeText': z.object({ text: z.string().max(10 * 1024 * 1024) }),
  'memory:overview': optObj({ companyId }),
  // a request with `op` is a Passport graph op (PASSPORT.md §11); without it, the v1 graph query
  'memory:graph': z.union([
    passportGraph,
    z.object({
      ...memFilter,
      op: z.undefined().optional(),
      centerId: entityId.optional(),
      hops: z.union([z.literal(1), z.literal(2)]).optional(),
      limit: z.number().int().min(1).max(150).optional()
    })
  ]),
  'memory:entity': z.object({ id: entityId, companyId }),
  'memory:search': z.object({
    ...memFilter,
    query: z.string().trim().min(1).max(300),
    includeHistory: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional()
  }),
  'memory:facts': z.object({
    ...memFilter,
    entityId: entityId.optional(),
    text: z.string().max(300).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(1000).optional()
  }),
  'memory:mutate': z.intersection(memoryMutation, z.object({ companyId })),
  'memory:delete': z.object({ kind: z.enum(['entity', 'fact', 'relation']), ids: memIds(z.string().max(64)), companyId }),
  'memory:revertRun': z.object({ runId: id }),
  'memory:grants': z.object({ runId: id.optional(), sessionId: id.optional(), companyId }),
  'memory:setPaused': z.object({ paused: z.boolean() }),
  'memory:export': z.object({ scope: memScopeSel, companyId }),
  // a union, not a discriminated one: get / rename / archive take either a path or an id
  'memory:note': z.union([
    z.object({ op: z.literal('get'), companyId: id, path: notePath }).strict(),
    z.object({ op: z.literal('get'), companyId: id, id: noteId }).strict(),
    z.object({ op: z.literal('save'), companyId: id, path: notePath, baseHash: contentHash, text: z.string().max(2 * 1024 * 1024) }).strict(),
    z.object({ op: z.literal('ops'), companyId: id, ops: vaultOps }).strict(),
    z.object({ op: z.literal('create'), companyId: id, title: vaultTitle, type: vaultType.optional(), folder: folder.optional(), properties: properties.optional(), fromGhost: z.boolean().optional() }).strict(),
    z.object({ op: z.literal('rename'), companyId: id, newTitle: vaultTitle, path: notePath }).strict(),
    z.object({ op: z.literal('rename'), companyId: id, newTitle: vaultTitle, id: noteId }).strict(),
    z.object({ op: z.literal('archive'), companyId: id, archived: z.boolean().optional(), path: notePath }).strict(),
    z.object({ op: z.literal('archive'), companyId: id, archived: z.boolean().optional(), id: noteId }).strict()
  ]),
  'memory:links': z.discriminatedUnion('op', [
    z.object({ op: z.literal('backlinks'), companyId: id, noteId }).strict(),
    z.object({ op: z.literal('unlinked'), companyId: id, noteId, limit: z.number().int().min(1).max(500).optional() }).strict(),
    z.object({ op: z.literal('outgoing'), companyId: id, noteId }).strict(),
    z.object({ op: z.literal('tags'), companyId: id }).strict(),
    z.object({ op: z.literal('ghosts'), companyId: id, limit: z.number().int().min(1).max(5000).optional() }).strict(),
    z.object({ op: z.literal('tree'), companyId: id, includeArchived: z.boolean().optional() }).strict()
  ]),
  'memory:proposals': z.discriminatedUnion('op', [
    z.object({
      op: z.literal('list'),
      companyId: id,
      status: z.array(z.enum(PROPOSAL_STATUSES)).max(4).optional(),
      kinds: z.array(z.enum(PROPOSAL_KINDS)).max(PROPOSAL_KINDS.length).optional(),
      noteId: noteId.optional(),
      limit: z.number().int().min(1).max(500).optional()
    }).strict(),
    z.object({ op: z.literal('accept'), companyId: id, ids: z.array(proposalId).min(1).max(200), addAlias: z.boolean().optional() }).strict(),
    z.object({ op: z.literal('reject'), companyId: id, ids: z.array(proposalId).min(1).max(200) }).strict(),
    z.object({ op: z.literal('edit'), companyId: id, id: proposalId, ops: vaultOps, accept: z.boolean().optional() }).strict(),
    z.object({ op: z.literal('suggestNow'), companyId: id, noteId: noteId.optional() }).strict()
  ]),
  'memory:vault': z.union([
    z.object({ op: z.literal('status'), companyId: id }).strict(),
    z.object({ op: z.literal('reindex'), companyId: id }).strict(),
    z.object({ op: z.literal('openInObsidian'), companyId: id, path: notePath.optional() }).strict(),
    z.object({ op: z.literal('reveal'), companyId: id, path: notePath.optional() }).strict(),
    z.object({ op: z.literal('setPath'), companyId: id, path: absPath.nullable() }).strict(),
    z.object({ op: z.literal('setPath'), companyId: id, pick: z.literal(true) }).strict(),
    z.object({ op: z.literal('migrate'), dryRun: z.boolean() }).strict(),
    z.object({ op: z.literal('aiSettings'), companyId: id }).strict(),
    z.object({ op: z.literal('setAi'), companyId: id, optedIn: z.boolean().optional(), dailyCap: z.number().int().min(0).max(500).optional() }).strict()
  ]),
  // live agents (CONTRACT §12.6): text <= 8 KB, message <= 2 KB, limit <= 1000
  'agents:list': optObj({
    status: z.array(z.enum(AGENT_STATUSES)).max(7).optional(),
    runId: id.optional(),
    sessionId: id.optional(),
    rootsOnly: z.boolean().optional(),
    since: iso.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    companyId
  }),
  'agents:get': z.object({ id, eventsLimit: z.number().int().min(1).max(1000).optional() }),
  'agents:events': z.object({ agentId: id, beforeSeq: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(1000).optional() }),
  'agents:reply': z.object({ agentId: id, text: z.string().min(1).max(8192) }),
  'asks:list': optObj({
    status: z.enum(['open', 'all']).optional(),
    runId: id.optional(),
    sessionId: id.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    companyId
  }),
  'asks:answer': z.object({
    askId: id,
    optionId: z.string().min(1).max(64).optional(),
    text: z.string().max(8192).optional(),
    message: z.string().max(2048).optional()
  }),
  'app:dashboard': optObj({ since: iso.optional(), companyId }),
  'app:markSeen': none,
  'schedules:skipNext': z.object({ id }),
  // CONTRACT §13
  'runs:retryAt': z.object({ id, when: z.enum(['reset', 'cancel']) }),
  'sessions:retry': z.object({ id, when: z.enum(['now', 'reset', 'cancel']) }),
  'processes:leftovers': none,
  'processes:stop': z.object({ pids: z.array(z.number().int().min(2).max(99_999_999)).min(1).max(500) }),
  // authoring (CONTRACT §14.5): note <= 2 KB, draft <= 256 KB
  'author:list': optObj({
    status: z.array(z.enum(['pending', 'approved', 'rejected', 'expired'])).max(4).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    companyId
  }),
  'author:get': z.object({ id }),
  'author:decide': z.object({
    id,
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2048).optional(),
    allowRun: z.boolean().optional(),
    draft: workflowDraft.optional().refine((d) => d === undefined || JSON.stringify(d).length <= 256 * 1024, 'Workflow too large')
  }),
  'author:grants': none,
  'author:revokeRun': z.object({ workflowId: id, ownerKey: z.string().min(1).max(200) }),
  'chatCompany:list': none,
  'chatCompany:decide': z.object({ id, accept: z.boolean(), name: z.string().max(200).optional(), brief: z.string().max(20_000).optional() }).strict(),
  'chatCompany:open': z.object({ sessionId: id.nullish(), name: z.string().max(200).optional(), brief: z.string().max(20_000).optional() }).strict(),
  'worktrees:list': optObj({ status: z.array(z.enum(['creating', 'active', 'kept', 'removed', 'error'])).max(5).optional() }),
  'worktrees:remove': z.object({ id, discardWork: z.boolean().optional() }),
  'worktrees:branches': z.object({ runId: id }),
  'worktrees:deleteBranches': z.object({
    runId: id,
    branches: z
      .array(z.object({ repoPath: z.string().min(1).max(4096).refine((p) => p.startsWith('/'), 'absolute path'), name: z.string().min(1).max(255).refine((n) => !n.startsWith('-'), 'bad branch name') }))
      .min(1)
      .max(200)
  }),
  'history:list': optObj({
    query: z.string().max(200).optional(),
    repoId: id.optional(),
    since: iso.optional(),
    includeInHive: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }),
  'history:get': z.object({ id: z.string().regex(/^[0-9a-zA-Z-]{8,64}$/, 'invalid session id') }),
  'history:resume': z.object({
    id: z.string().regex(/^[0-9a-zA-Z-]{8,64}$/, 'invalid session id'),
    profileId: id.optional(),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    companyId
  }),
  // ---------- Slack (CONTRACT "Slack.5"): tokens <= 300 chars, text <= 3000, regex <= 300, <= 50 ids per list ----------
  'slack:status': none,
  'slack:manifest': optObj({ name: z.string().trim().max(35).optional() }),
  'slack:connect': z.object({ botToken: z.string().trim().min(1).max(300), appToken: z.string().trim().min(1).max(300) }).strict(),
  'slack:test': none,
  'slack:retry': none,
  'slack:disconnect': z.object({ purge: z.boolean() }),
  'slack:channels': optObj({ query: z.string().max(100).optional() }),
  'slack:join': z.object({ channelId: slackChannelId }),
  'slack:joinAll': none,
  'slack:markRead': z.object({ channelId: slackChannelId, ts: slackTs }),
  'slack:users': optObj({ query: z.string().max(100).optional(), includeBots: z.boolean().optional() }),
  'slack:messages': z.object({ channelId: slackChannelId, beforeTs: slackTs.optional(), limit: z.number().int().min(1).max(200).optional() }),
  'slack:thread': z.object({ channelId: slackChannelId, threadTs: slackTs }),
  'slack:search': z.object({
    query: z.string().trim().min(1).max(200),
    channelId: slackChannelId.optional(),
    userId: slackUserId.optional(),
    after: iso.optional(),
    before: iso.optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  'slack:backfill': z.object({ channelId: slackChannelId.optional(), days: z.number().int().min(1).max(365) }),
  'slack:askAgent': z.object({
    channelId: slackChannelId,
    threadTs: slackTs,
    profileId: id.optional(),
    repoId: id.nullish(),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000)
  }),
  'slack:drafts': optObj({
    status: z.array(z.enum(['pending', 'sending', 'sent', 'discarded', 'failed', 'expired'])).max(6).optional(),
    channelId: slackChannelId.optional(),
    threadTs: slackTs.optional(),
    runId: id.optional()
  }),
  'slack:draftGet': z.object({ id }),
  'slack:draftDecide': z.object({ id, decision: z.enum(['send', 'discard']), text: z.string().min(1).max(3000).optional() }),
  'slack:testAlert': none,
  'slack:permalink': z.object({ channelId: slackChannelId, ts: slackTs }),
  'slack:company': none,
  'slack:setCompany': z.object({ companyId: id }).strict(),
  'slackTriggers:list': optObj({ workflowId: id.optional(), companyId }),
  'slackTriggers:create': slackTriggerInput,
  'slackTriggers:update': z.object({ id, input: slackTriggerInput }),
  'slackTriggers:remove': z.object({ id }),
  'slackTriggers:setEnabled': z.object({ id, enabled: z.boolean() }),
  'slackTriggers:test': z.object({
    input: slackTriggerInput,
    sample: z.union([z.object({ permalink: z.string().url().max(500) }), z.object({ channelId: slackChannelId, ts: slackTs })])
  }),
  'slackTriggers:events': z.object({ triggerId: id, limit: z.number().int().min(1).max(500).optional() }),
  // ---------- onboarding (ONBOARDING.md §4): paths <= 8, url <= 2048, key names allowlisted, plan parsed by OnboardingPlan ----------
  'onboarding:status': none,
  'onboarding:pickFolders': none,
  'onboarding:inspectFolders': z.object({ paths: obPaths }).strict(),
  'onboarding:scan': z
    .object({ paths: obPaths.optional(), github: z.object({ fullName: z.string().regex(GITHUB_FULL_NAME, 'owner/repo') }).strict().optional() })
    .strict()
    .refine((q) => !!q.paths || !!q.github, 'Choose a folder or a GitHub repo'),
  'onboarding:fetchSite': z.object({ url: z.string().trim().min(1).max(MAX_URL_LENGTH) }).strict(),
  'onboarding:github': z.discriminatedUnion('op', [z.object({ op: z.literal('list'), query: z.string().max(100).optional() }).strict()]),
  'onboarding:pickCloneDir': none,
  'onboarding:key': z.discriminatedUnion('op', [
    z.object({ op: z.literal('check'), name: z.enum(ONBOARDING_KEY_NAMES), value: z.string().trim().min(1, 'Paste a key').max(4096) }).strict(),
    z.object({ op: z.literal('forget'), stashIds: z.array(obHandle).max(20) }).strict()
  ]),
  'onboarding:plan': z.object({ requestId: obHandle, input: PlanInputSchema, useAgent: z.boolean() }).strict(),
  'onboarding:cancelPlan': z.object({ requestId: obHandle }).strict(),
  // "From a prompt": the brief itself is untrusted free text, capped (main redacts and frames it before the model sees it)
  'onboarding:brief': z.object({ requestId: obHandle, brief: z.string().max(BRIEF_MAX) }).strict(),
  'onboarding:cancelBrief': z.object({ requestId: obHandle }).strict(),
  'onboarding:launch': z.object({ journalId: obHandle.optional(), draftId: obHandle, input: LaunchInputSchema }).strict(),
  'onboarding:skipStep': z.object({ journalId: obHandle, step: z.enum(SOFT_LAUNCH_STEPS) }).strict(),
  'onboarding:discard': z.object({ journalId: obHandle }).strict(),
  'onboarding:start': z.object({ journalId: obHandle, autopilot: z.boolean(), scheduleRefs: z.array(obRef).max(8) }).strict(),
  'onboarding:startPreview': z.object({ journalId: obHandle, scheduleRefs: z.array(obRef).max(8) }).strict(),
  // USAGE.md
  'usage:summary': z.object({ range: z.enum(USAGE_RANGES), companyId }),
  'usage:disk': optObj({ fresh: z.boolean().optional() }),
  'usage:cleanupList': none,
  'usage:cleanup': z.object({ ids: z.array(z.string().regex(/^(wt|tw|log):[a-z]+_[0-9a-z]+$/, 'invalid item')).min(1).max(500) }),
  'activity:open': none,
  'activity:close': none,
  // CLOUD.md §13.1: the cloud:* channels
  ...CLOUD_REQUEST_SCHEMAS,
  // PLANS.md §3: tasks:brief, tasks:proofPreview, plans:*
  ...PLANS_REQUEST_SCHEMAS,
  // CHAT-UI.md §3.2: chat:*
  ...CHAT_REQUEST_SCHEMAS,
  // REMOTE.md: remote:*
  ...REMOTE_REQUEST_SCHEMAS,
  // BROWSER.md: browser:*
  ...BROWSER_REQUEST_SCHEMAS,
  // RELEASING.md §4: updates:*
  'updates:state': none,
  'updates:check': none,
  'updates:restart': none
} satisfies Record<InvokeChannel, z.ZodType>

export const SEND_SCHEMAS = {
  'sessions:write': z.object({ id, data: z.string().max(1024 * 1024), typed: z.boolean().optional() }),
  'sessions:resize': z.object({ id, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
  'artifacts:startDrag': z.object({ id }),
  'ui:ready': none,
  'ui:visibleOwner': z.object({ sessionId: id.nullish(), runId: id.nullish() })
}

/** zod issues -> contract ValidationError[] */
export function zodErrors(e: z.ZodError): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.length ? i.path.join('.') : 'request', message: i.message }))
}
