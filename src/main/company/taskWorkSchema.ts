/** WORKTREE.md: the stored shape of a task's `work` field (shared/taskWork.ts TaskWork). */
import { z } from 'zod'
import { PR_STATES, REVIEW_DECISIONS } from '../../shared/taskWork'

const iso = z.string().min(1).max(40)
const id = z.string().min(1).max(64).regex(/^[a-z]+_[0-9a-z]+$/)
export const taskPrSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().max(2000),
  state: z.enum(PR_STATES),
  isDraft: z.boolean(),
  reviewDecision: z.enum(REVIEW_DECISIONS).nullable(),
  mergedAt: iso.nullable(),
  checkedAt: iso,
  base: z.string().max(250).nullable().optional(),
  head: z.string().max(250).nullable().optional()
}).strict()
/** Lenient on the optional bookkeeping (every key defaults), strict on unknown keys like the rest of the task. */
export const taskWorkSchema = z.object({
  repoId: id,
  worktreePath: z.string().min(1).max(4096),
  branch: z.string().min(1).max(250),
  baseSha: z.string().max(64).nullable().default(null),
  baseRef: z.string().max(250).nullable().default(null),
  pr: taskPrSchema.nullable().default(null),
  startedAt: iso.nullable().default(null),
  worktreeId: z.string().max(64).nullable().default(null),
  queuedAt: iso.nullable().default(null),
  goneAt: iso.nullable().default(null),
  removedAt: iso.nullable().default(null),
  gh: z.enum(['ok', 'missing', 'signed_out', 'error']).nullable().default(null),
  reviewSeenAt: iso.nullable().default(null),
  readySeen: z.number().int().nullable().default(null),
  conflict: z.boolean().default(false),
  error: z.string().max(500).nullable().default(null)
}).strict()
