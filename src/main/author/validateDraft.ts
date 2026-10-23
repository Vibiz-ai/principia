/**
 * Authoring validation (AUTHORING.md §1.4, §3.3, §4; PO4): normalize -> strict shape (zod, unknown fields are errors)
 * -> engine validation -> authoring checks. Pure apart from the injected engine validator. No Electron imports.
 */
import { z } from 'zod'
import { agentOutputInCommands, authorFlags, checkAfterProblems, freeTextFlagGates, prRefWritesOutsideWorktree, flagLines, normalizeAuthoredDraft, type AuthorFlags, type AuthoringContext } from '../../shared/authoring'
import type { AdapterId, ValidationError, WorkflowDraft } from '../../shared/types'

export const MAX_DRAFT_BYTES = 256 * 1024
export const MAX_NODES = 40
const TEXT = z.string().max(20_000)

const slug = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id must be a lowercase slug').max(64)
const base = {
  id: slug,
  label: z.string().max(200),
  after: z.array(z.string().max(64)).max(100),
  cwd: z.string().max(4096).nullable(),
  timeoutMin: z.number().int().min(1).max(1440),
  memory: z.enum(['off', 'read', 'read-write']).optional(),
  isolate: z.literal('worktree').nullish()
}
const node = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('agent'), profileId: z.string().max(64), prompt: TEXT }),
  z.strictObject({
    ...base,
    type: z.literal('room'),
    participants: z.array(z.strictObject({ profileId: z.string().max(64), label: z.string().max(80) })).max(12),
    topic: TEXT,
    rounds: z.number().int().min(1).max(10),
    final: z.enum(['last', 'summary'])
  }),
  z.strictObject({
    ...base,
    type: z.literal('check'),
    profileId: z.string().max(64).nullable(),
    command: TEXT.nullable(),
    target: z.string().max(64),
    criteria: TEXT,
    maxRetries: z.number().int().min(0).max(5)
  }),
  z.strictObject({ ...base, type: z.literal('shell'), command: TEXT }),
  z.strictObject({
    ...base,
    type: z.literal('wait'),
    command: TEXT,
    until: z.enum(['exit0', 'match']),
    pattern: z.string().max(500).nullable(),
    intervalSec: z.number().int().min(5).max(3600),
    onTimeout: z.enum(['fail', 'continue'])
  }),
  z.strictObject({
    ...base,
    type: z.literal('notify'),
    title: z.string().max(200),
    message: TEXT,
    // SLACK.md §10 (SA3): iMessage was removed
    slack: z.union([z.strictObject({ kind: z.literal('me') }), z.strictObject({ kind: z.literal('channel'), channel: z.string().regex(/^[CG][A-Z0-9]{1,20}$/, 'a channel id (C…/G…); get one with slack_list_channels') })]).nullable(),
    migratedFrom: z.literal('imessage').nullish()
  })
])
export const authoredDraftSchema = z.strictObject({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(10_000),
  inputs: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'input name must be an identifier').max(64),
        label: z.string().max(200),
        default: z.string().max(20_000).optional(),
        type: z.enum(['text', 'multiline', 'repo', 'boolean']).optional()
      })
    )
    .max(50),
  nodes: z.array(node).min(1, 'Add at least one node').max(MAX_NODES, `At most ${MAX_NODES} nodes`),
  worktree: z.strictObject({ repo: z.string().min(1).max(4096), base: z.string().max(200).nullish(), pushBranches: z.array(z.string().regex(/^[A-Za-z0-9._/*-]{1,100}$/, 'branch pattern: letters, digits, . _ / - and *')).max(20).nullish() }).nullish(),
  slackTools: z.boolean().optional(),
  slackAgentPermissions: z.enum(['restricted', 'profile']).optional()
})

const zodToErrors = (e: z.ZodError, draft: WorkflowDraft): ValidationError[] =>
  e.issues.map((i) => {
    const p = i.path
    // nodes.<n>.field -> the node id, so messages name the node like the engine's do
    if (p[0] === 'nodes' && typeof p[1] === 'number') {
      const id = draft.nodes[p[1]]?.id ?? `nodes.${p[1]}`
      const field = p.slice(2).join('.')
      const msg = i.code === 'unrecognized_keys' ? `unknown field(s) ${(i as { keys?: string[] }).keys?.join(', ')}` : i.message
      return { path: id, message: `Node "${id}"${field ? ` ${field}` : ''}: ${msg}` }
    }
    const msg = i.code === 'unrecognized_keys' ? `unknown field(s) ${(i as { keys?: string[] }).keys?.join(', ')}` : i.message
    return { path: p.length ? p.join('.') : 'workflow', message: `${p.length ? `${p.join('.')}: ` : ''}${msg}` }
  })

export interface AuthorValidateDeps extends AuthoringContext {
  /** engine.workflows.validate */
  engineValidate(draft: WorkflowDraft): ValidationError[]
  /** Adapter availability (ProviderInfo.available). */
  available(adapter: AdapterId): boolean
}

export interface AuthorValidation {
  ok: boolean
  errors: ValidationError[]
  warnings: string[]
  normalized: WorkflowDraft
  flags: AuthorFlags
}

/** §3.3: everything hive_workflow_validate / create / update check. `agentAuthored` applies PO4 (always true for tools). */
export function validateAuthoredDraft(raw: unknown, deps: AuthorValidateDeps, opts: { agentAuthored?: boolean; flagCtx?: Parameters<typeof authorFlags>[1] } = {}): AuthorValidation {
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8')
  } catch {
    size = Infinity
  }
  const { draft, errors: normErrors } = normalizeAuthoredDraft(raw, deps)
  const flags = authorFlags(draft, { ...deps, ...(opts.flagCtx ?? {}) })
  if (size > MAX_DRAFT_BYTES) return { ok: false, errors: [{ path: 'workflow', message: 'Workflow too large (max 256 KB)' }], warnings: [], normalized: draft, flags }
  const errors: ValidationError[] = [...normErrors]
  if (opts.agentAuthored && draft.slackAgentPermissions === 'profile') errors.push({ path: 'slackAgentPermissions', message: 'Profile permissions for Slack workflows must be selected by the user in the workflow editor.' })
  const shape = authoredDraftSchema.safeParse(draft)
  if (!shape.success) errors.push(...zodToErrors(shape.error, draft))
  if (shape.success) {
    try {
      errors.push(...deps.engineValidate(draft))
    } catch (e) {
      errors.push({ path: 'workflow', message: `Validation failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  // §4 worktree rules (the engine checks them too once it knows them; duplicates are dropped below)
  const isolated = draft.nodes.filter((n) => n.isolate === 'worktree')
  const inputTypes = new Map(draft.inputs.map((i) => [i.name, i.type ?? 'text']))
  if (isolated.length && !draft.worktree?.repo) {
    for (const n of isolated) errors.push({ path: n.id, message: `Node "${n.id}": isolate needs a workflow worktree repo (set workflow.worktree.repo)` })
  }
  for (const n of draft.nodes) if (n.type === 'notify' && n.isolate) errors.push({ path: n.id, message: `Node "${n.id}": notify nodes cannot be isolated` })
  if (draft.worktree?.repo) {
    const r = draft.worktree.repo
    const tm = r.match(/^\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/)
    if (tm) {
      if (inputTypes.get(tm[1]) !== 'repo') errors.push({ path: 'worktree', message: `worktree.repo: input "${tm[1]}" must exist and have type 'repo'` })
    } else {
      const repo = deps.repos.find((x) => x.id === r)
      if (!repo) errors.push({ path: 'worktree', message: `worktree.repo: unknown repo "${r}". Call hive_repos_list.` })
      else if (repo.isGit === false) errors.push({ path: 'worktree', message: `worktree.repo: ${repo.name} is not a git repository` })
    }
    for (const n of isolated) {
      if (n.cwd && n.cwd !== r) errors.push({ path: n.id, message: `Node "${n.id}": an isolated node's cwd must be empty or the worktree repo (it runs in the worktree)` })
    }
  }
  const loops = checkAfterProblems(draft)
  errors.push(...loops.errors)
  if (opts.agentAuthored !== false) errors.push(...agentOutputInCommands(draft))
  // item 1: a push / PR step gated on a free-text flag is an error (a typo meant a real push)
  errors.push(...freeTextFlagGates(draft))
  // dedupe identical messages
  const seen = new Set<string>()
  const uniq = errors.filter((e) => (seen.has(e.message) ? false : (seen.add(e.message), true)))

  const warnings: string[] = []
  const prof = new Map(deps.profiles.map((p) => [p.id, p]))
  const unavailable = new Set<string>()
  for (const n of draft.nodes) {
    const ids = n.type === 'agent' ? [n.profileId] : n.type === 'room' ? n.participants.map((p) => p.profileId) : n.type === 'check' && n.profileId ? [n.profileId] : []
    for (const id of ids) {
      const p = prof.get(id)
      if (p && !deps.available(p.adapter)) unavailable.add(p.adapter)
    }
    if (n.cwd && n.cwd.startsWith('/')) {
      const inRepo = deps.repos.some((r) => n.cwd === r.path || n.cwd!.startsWith(r.path.replace(/\/+$/, '') + '/'))
      if (!inRepo) warnings.push(`Node "${n.id}": cwd ${n.cwd} is outside every Hive repo`)
    }
  }
  warnings.push(...loops.warnings)
  for (const a of unavailable) warnings.push(`${a} is not installed on this Mac; its nodes will fail until it is`)
  warnings.push(...prRefWritesOutsideWorktree(draft))
  warnings.push(...flagLines(flags))
  return { ok: uniq.length === 0, errors: uniq, warnings, normalized: draft, flags }
}
