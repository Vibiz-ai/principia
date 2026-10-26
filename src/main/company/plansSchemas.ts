/** PLANS.md §3: request schemas of tasks:brief, tasks:proofPreview and plans:* (merged into ipcSchemas REQUEST_SCHEMAS). */
import { z } from 'zod'
import { BRIEF_LIMITS, CRITERION_STATES, PLAN_AUTONOMY, PLAN_LIMITS } from '../../shared/plans'

const id = z.string().min(1).max(64).regex(/^[a-z]+_[0-9a-z]+$/, 'invalid id')
const text = (n: number) => z.string().max(n)
const taskId = id
export const PLANS_REQUEST_SCHEMAS = {
  'tasks:brief': z.discriminatedUnion('op', [
    z.object({ op: z.literal('edit'), taskId, section: z.enum(['goal', 'context', 'handoff']), text: text(BRIEF_LIMITS.context) }).strict(),
    z.object({ op: z.literal('addCriterion'), taskId, text: text(BRIEF_LIMITS.criterion * 10).trim().min(1, 'Write the criterion') }).strict(),
    z.object({ op: z.literal('criterion'), taskId, id: text(40).min(1), state: z.enum(CRITERION_STATES), reason: text(BRIEF_LIMITS.reason).optional() }).strict(),
    z.object({ op: z.literal('removeCriterion'), taskId, id: text(40).min(1) }).strict(),
    z.object({ op: z.literal('decide'), taskId, text: text(BRIEF_LIMITS.decision).trim().min(1, 'Write the decision'), why: text(BRIEF_LIMITS.why).trim().min(1, 'Say why') }).strict(),
    z.object({ op: z.literal('ask'), taskId, text: text(BRIEF_LIMITS.question).trim().min(1, 'Write the question') }).strict(),
    z.object({ op: z.literal('answer'), taskId, id: text(40).min(1), answer: text(BRIEF_LIMITS.answer).trim().min(1, 'Write the answer') }).strict()
  ]),
  'tasks:proofPreview': z.object({ taskId, proofId: text(40).min(1) }).strict(),
  'plans:list': z.object({ companyId: id.optional(), includeArchived: z.boolean().optional() }).strict().optional(),
  'plans:get': z.object({ id }).strict(),
  'plans:create': z.object({ companyId: id, goal: text(PLAN_LIMITS.goal).trim().min(1, 'Write the goal first'), autonomy: z.enum(PLAN_AUTONOMY), repoId: id.nullable().optional(), headAgentId: id.nullable().optional() }).strict(),
  'plans:redraft': z.object({ id }).strict(),
  'plans:saveDraft': z.object({
    id, goal: text(PLAN_LIMITS.goal).optional(), body: text(2000).optional(), autonomy: z.enum(PLAN_AUTONOMY).optional(), repoId: id.nullable().optional(), headAgentId: id.nullable().optional(),
    // shapes are checked by PlanStore.saveDraft (references, cycles, lengths)
    milestones: z.array(z.record(z.string(), z.unknown())).max(PLAN_LIMITS.milestones).optional(),
    tasks: z.array(z.record(z.string(), z.unknown())).max(PLAN_LIMITS.tasks).optional()
  }).strict(),
  'plans:approve': z.object({ id }).strict(),
  'plans:discard': z.object({ id }).strict(),
  'plans:setAutonomy': z.object({ id, autonomy: z.enum(PLAN_AUTONOMY) }).strict(),
  'plans:start': z.object({ id, taskId }).strict(),
  'plans:pass': z.object({ id, milestoneId: id, note: text(4000).optional() }).strict(),
  'plans:sendBack': z.object({ id, milestoneId: id, note: text(4000).trim().min(1, 'Say what to change') }).strict(),
  'plans:resume': z.object({ id }).strict(),
  'plans:pause': z.object({ id }).strict(),
  'plans:archive': z.object({ id }).strict(),
  'plans:publish': z.object({ id }).strict()
}
