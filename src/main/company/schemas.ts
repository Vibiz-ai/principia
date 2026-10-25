import { z } from 'zod'
import { lookSchema, personaSchema } from '../../shared/onboarding'
import { taskWorkSchema } from './taskWorkSchema'
import { taskBriefShape } from './briefSchemas'
import { AGENT_DATA_DEFAULTS, AGENT_LIMITS, BLOCK_REASONS, DEPARTMENT_DATA_DEFAULTS, DEPARTMENT_LIMITS, DEPARTMENT_PRESET_KEYS, TASK_ASK_KINDS, TASK_SOURCES, TASK_STATUSES } from '../../shared/company'
const id = z.string().min(1).max(64).regex(/^[a-z]+_[0-9a-z]+$/)
const context = z.string().max(30_000)
const name = z.string().trim().min(1).max(160)
/** a design token (`var(--status-success)`) or a hex colour */
export const colorSchema = z.string().max(64).regex(/^(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]+\))$/, 'Use a colour token or a hex colour')
/** absolute, no NUL; null resets to `<userData>/companies/<slug>/Passport` */
const vaultPath = z.string().min(1).max(4096).refine(s=>!s.includes('\0')&&(s.startsWith('/')||/^[A-Za-z]:[\\/]/.test(s)),'Use an absolute folder path').nullable()
export const passportInputSchema = z.object({ name, mission: context, brandVoice: context, audience: context, products: context, goals: context, context, constraints: context, repoIds: z.array(id).max(500), color: colorSchema.optional(), vaultPath: vaultPath.optional() }).strict()
export const passportExportSchema = z.object({format: z.literal('principia-passport'), version: z.literal(1), passport: passportInputSchema.omit({repoIds:true,vaultPath:true})}).strict()
export const companyCreateSchema = z.object({ name, color: colorSchema.optional(), vaultPath: vaultPath.optional(), repoIds: z.array(id).max(500).optional(), mission: context.optional(), brandVoice: context.optional(), audience: context.optional(), products: context.optional(), goals: context.optional(), context: context.optional(), constraints: context.optional() }).strict()
export const companyUpdateSchema = z.object({ name: name.optional(), color: colorSchema.optional(), sortOrder: z.number().int().min(0).max(100_000).optional(), vaultPath: vaultPath.optional() }).strict()
export const companyReorderSchema = z.array(id).max(1000)
export const assignRepoSchema = z.object({ repoId: id, companyId: id }).strict()
const iso = z.string().min(1).max(40).refine(s=>!Number.isNaN(Date.parse(s)),'invalid date')
const short = (max: number) => z.string().max(max)
/** DEPARTMENTS.md §1.3 task fields, without defaults (patches must not reset fields they do not name). */
const taskBoardShape = {
  departmentId: id.nullable(),
  agentId: id.nullable(),
  blockReason: z.enum(BLOCK_REASONS).nullable(),
  ask: z.object({ kind: z.enum(TASK_ASK_KINDS), prompt: short(4000).min(1), options: z.array(short(200).min(1)).max(10).optional(), answer: short(10_000).optional(), answeredAt: iso.optional() }).strict().nullable(),
  report: z.object({ outcome: z.enum(['review','blocked']), summary: short(10_000), evidence: z.array(short(2000)).max(50), at: iso }).strict().nullable(),
  doneNote: short(10_000).nullable(),
  routing: z.object({ departmentId: id.nullable(), agentId: id.nullable(), by: z.enum(['human','rule','model']), reason: short(500), confidence: z.number().min(0).max(1).optional() }).strict().nullable(),
  pendingWake: z.object({ reasons: z.array(short(4000)).max(50), count: z.number().int().min(0).max(10_000) }).strict().nullable(),
  agentSessionId: short(200).nullable(),
  autoWakes: z.object({ windowStart: iso.nullable(), n: z.number().int().min(0).max(10_000), at: z.array(iso).max(20).optional() }).strict(),
  handoffs: z.number().int().min(0).max(100),
  /** WORKTREE.md: written by main only (taskWork.ts); the renderer's task channels omit it */
  work: taskWorkSchema.nullable(),
  /** LINEAR.md §3 */
  labels: z.array(z.string().trim().min(1).max(80)).max(50),
  estimate: z.number().min(0).max(1000).nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date').nullable()
}
const taskBaseShape = {
  title:z.string().trim().min(1).max(240), description:z.string().max(50_000), companyId:id, repoId:id.nullable(), status:z.enum(TASK_STATUSES), priority:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4)]),
  source:z.enum(TASK_SOURCES), sourceUrl:z.string().url().max(4000).refine(s=>/^https?:\/\//.test(s),'Use an HTTP or HTTPS source link').nullable(), externalId:z.string().trim().min(1).max(500).nullable(), assigneeProfileId:id.nullable(), parentId:id.nullable(), dependencyIds:z.array(id).max(100),
  // PLANS.md §1 (optional: older rows parse unchanged)
  ...taskBriefShape
}
/** Strict, and every §1.3 field is optional with a default, so rows written before departments parse unchanged. */
export const taskInputSchema = z.object({
  ...taskBaseShape,
  departmentId: taskBoardShape.departmentId.default(null), agentId: taskBoardShape.agentId.default(null), blockReason: taskBoardShape.blockReason.default(null),
  ask: taskBoardShape.ask.default(null), report: taskBoardShape.report.default(null), doneNote: taskBoardShape.doneNote.default(null), routing: taskBoardShape.routing.default(null),
  pendingWake: taskBoardShape.pendingWake.default(null), agentSessionId: taskBoardShape.agentSessionId.default(null),
  autoWakes: taskBoardShape.autoWakes.default(()=>({windowStart:null,n:0})), handoffs: taskBoardShape.handoffs.default(0), work: taskBoardShape.work.default(null),
  labels: taskBoardShape.labels.default(()=>[]), estimate: taskBoardShape.estimate.default(null), dueDate: taskBoardShape.dueDate.default(null)
}).strict()
/**
 * tasks:update patches. zod 4 applies defaults inside .partial(), so `taskInputSchema.partial()` would reset every
 * omitted §1.3 field to null; this one has no defaults.
 */
export const taskPatchSchema = z.object({ ...taskBaseShape, ...taskBoardShape }).partial().strict()

// ---------- DEPARTMENTS.md §1.1 ----------
const deptKey = z.string().min(1).max(48).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use a lowercase slug')
const icon = z.string().min(1).max(40).regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Use an icon name')
const slackChannelId = z.string().regex(/^[CG][A-Z0-9]{1,20}$/, 'Slack channel id')
const charter = z.object({ does: z.string().max(DEPARTMENT_LIMITS.charter), doesNot: z.string().max(DEPARTMENT_LIMITS.charter) }).strict()
  .refine(c=>c.does.length+c.doesNot.length<=DEPARTMENT_LIMITS.charter, `The charter is limited to ${DEPARTMENT_LIMITS.charter} characters (does and does not together)`)
/** company_departments.data as stored: defaults fill missing keys, unknown keys (a newer build's) are dropped. */
export const departmentDataSchema = z.object({
  charter: charter.default(()=>({...DEPARTMENT_DATA_DEFAULTS.charter})),
  sourceDefaults: z.array(z.enum(TASK_SOURCES)).max(TASK_SOURCES.length).default(()=>[]),
  slackChannels: z.array(slackChannelId).max(DEPARTMENT_LIMITS.slackChannels).default(()=>[]),
  passportNote: z.string().trim().min(1).max(200).nullable().default(null),
  contextFallback: z.string().max(DEPARTMENT_LIMITS.contextFallback).default('')
})
export const departmentSaveSchema = z.object({
  id: id.optional(), companyId: id, key: deptKey.optional(), name: z.string().trim().min(1).max(DEPARTMENT_LIMITS.name),
  color: colorSchema.nullable().optional(), icon: icon.nullable().optional(),
  data: z.object({
    charter: z.object({ does: z.string().max(DEPARTMENT_LIMITS.charter), doesNot: z.string().max(DEPARTMENT_LIMITS.charter) }).partial().strict(),
    sourceDefaults: departmentDataSchema.shape.sourceDefaults.unwrap(), slackChannels: departmentDataSchema.shape.slackChannels.unwrap(),
    passportNote: departmentDataSchema.shape.passportNote.unwrap(), contextFallback: departmentDataSchema.shape.contextFallback.unwrap()
  }).partial().strict().optional()
}).strict()
export const departmentPresetsSchema = z.object({ companyId: id, keys: z.array(z.enum(DEPARTMENT_PRESET_KEYS)).min(1).max(DEPARTMENT_PRESET_KEYS.length).optional() }).strict()
export const departmentReorderSchema = z.object({ companyId: id, ids: z.array(id).max(500) }).strict()

const limits = z.object({
  runMinutes: z.number().int().min(AGENT_LIMITS.runMinutes.min).max(AGENT_LIMITS.runMinutes.max),
  autoWakesPerHour: z.number().int().min(AGENT_LIMITS.autoWakesPerHour.min).max(AGENT_LIMITS.autoWakesPerHour.max)
}).strict()
/** company_agents.data as stored (same rules as departmentDataSchema). */
export const companyAgentDataSchema = z.object({
  instructions: z.string().max(AGENT_LIMITS.instructions).default(''),
  capabilities: z.string().max(AGENT_LIMITS.capabilities).default(''),
  autonomy: z.enum(['manual','auto']).default('manual'),
  mode: z.enum(['headless','session']).default('headless'),
  defaultRepoId: id.nullable().default(null),
  limits: limits.partial().default(()=>({})).transform(l=>({...AGENT_DATA_DEFAULTS.limits, ...l})),
  /** VOICE.md §4.2; readAgentData drops only this field when it fails to parse. */
  persona: personaSchema.optional()
})
/** VOICE.md §4.2 (defined in shared so the onboarding plan uses the same shape). */
export { lookSchema, personaSchema }
export const companyAgentSaveSchema = z.object({
  id: id.optional(), companyId: id, departmentId: id.nullable(), kind: z.enum(['profile','workflow']), refId: id, name: z.string().trim().min(1).max(AGENT_LIMITS.name),
  data: z.object({
    instructions: companyAgentDataSchema.shape.instructions.unwrap(), capabilities: companyAgentDataSchema.shape.capabilities.unwrap(),
    autonomy: z.enum(['manual','auto']), mode: z.enum(['headless','session']), defaultRepoId: id.nullable(), limits: limits.partial(),
    persona: personaSchema
  }).partial().strict().optional()
}).strict()
