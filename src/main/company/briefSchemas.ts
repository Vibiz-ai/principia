/** PLANS.md §1: the stored shape of a task brief, its proof and its plan link (task JSON fields, all optional). */
import { z } from 'zod'
import { BRIEF_LIMITS, BRIEF_SECTIONS, CRITERION_STATES, PROOF_KINDS } from '../../shared/plans'

const iso = z.string().min(1).max(40)
const author = z.string().min(1).max(80)
export const criterionSchema = z.object({ id: z.string().min(1).max(40), text: z.string().max(BRIEF_LIMITS.criterion), state: z.enum(CRITERION_STATES), reason: z.string().max(BRIEF_LIMITS.reason).optional() }).strict()
export const briefSchema = z.object({
  goal: z.string().max(BRIEF_LIMITS.goal),
  context: z.string().max(50_000),
  criteria: z.array(criterionSchema).max(BRIEF_LIMITS.criteria),
  decisions: z.array(z.object({ text: z.string().max(BRIEF_LIMITS.decision), why: z.string().max(BRIEF_LIMITS.why), by: author, at: iso }).strict()).max(BRIEF_LIMITS.decisions),
  questions: z.array(z.object({ id: z.string().min(1).max(40), text: z.string().max(BRIEF_LIMITS.question), answer: z.string().max(BRIEF_LIMITS.answer).optional() }).strict()).max(BRIEF_LIMITS.questions),
  handoff: z.string().max(BRIEF_LIMITS.handoff),
  revisions: z.array(z.object({ at: iso, by: author, section: z.enum(BRIEF_SECTIONS) }).strict()).max(BRIEF_LIMITS.revisions)
}).strict()
export const proofSchema = z.object({ id: z.string().min(1).max(40), kind: z.enum(PROOF_KINDS), title: z.string().max(BRIEF_LIMITS.proofTitle), ref: z.string().max(BRIEF_LIMITS.proofRef), by: author, at: iso }).strict()
export const planLinkSchema = z.object({ planId: z.string().min(1).max(64), milestoneId: z.string().min(1).max(64), planTaskId: z.string().min(1).max(64).nullable(), role: z.enum(['milestone', 'task']) }).strict()
/** Spread into the task schemas: optional, so every older row parses unchanged. */
export const taskBriefShape = {
  brief: briefSchema.nullable().optional(),
  proof: z.array(proofSchema).max(BRIEF_LIMITS.proof).optional(),
  plan: planLinkSchema.nullable().optional()
}
