/**
 * WORKTREE.md: the GitHub CLI calls of a task's PR, the execFile pattern of github.ts. Read-only except `merge`, which
 * only main runs after the founder confirmed (the agent shims refuse gh pr merge). gh missing or signed out is a state,
 * never an error dialog. No Electron imports.
 */
import { execFile } from 'node:child_process'
import { z } from 'zod'
import { PR_STATES, REVIEW_DECISIONS, type GhState, type TaskPr } from '../../shared/taskWork'

export interface GhResult { code: number; stdout: string; stderr: string; missing: boolean }
export type GhRunner = (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<GhResult>

/** The gh binary: `gh` on the login PATH. HIVE_GH_BIN points a dev or test instance at a stand-in. */
export const ghBin = (): string => process.env.HIVE_GH_BIN?.trim() || 'gh'

export function ghRunner(env: () => Record<string, string>): GhRunner {
  return (args, opts) => new Promise((resolve) => {
    execFile(ghBin(), args, {
      cwd: opts.cwd,
      env: { ...env(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
      timeout: opts.timeoutMs ?? 20_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null
      const missing = e?.code === 'ENOENT'
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing })
    })
  })
}

export const PR_FIELDS = 'number,url,state,isDraft,reviewDecision,mergedAt,baseRefName,headRefName'
const prSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(PR_STATES),
  isDraft: z.boolean().optional().default(false),
  // gh prints "" when no review is required
  reviewDecision: z.union([z.enum(REVIEW_DECISIONS), z.literal(''), z.null()]).optional(),
  mergedAt: z.string().nullable().optional(),
  baseRefName: z.string().max(250).optional(),
  headRefName: z.string().max(250).optional()
})

/** `gh pr view --json <PR_FIELDS>` → TaskPr, or null when it is not one. */
export function parsePr(stdout: string, now: Date): TaskPr | null {
  let raw: unknown
  try { raw = JSON.parse(stdout) } catch { return null }
  const r = prSchema.safeParse(raw)
  if (!r.success) return null
  const d = r.data
  const merged = d.mergedAt && !d.mergedAt.startsWith('0001-') ? d.mergedAt : null
  return { number: d.number, url: d.url, state: d.state, isDraft: !!d.isDraft, reviewDecision: d.reviewDecision ? d.reviewDecision : null, mergedAt: merged, checkedAt: now.toISOString(), ...(d.baseRefName ? { base: d.baseRefName } : {}), ...(d.headRefName ? { head: d.headRefName } : {}) }
}

export type CreatePr = { kind: 'created'; url: string } | { kind: 'exists' } | { kind: 'missing' } | { kind: 'error'; message: string }
/**
 * PLANS.md §2.6: opens the plan's pull request (`gh pr create --head <hive/…> --base <main>`). Main only, after the
 * branch was pushed through the guarded push; never a draft, never a merge.
 */
export async function createPr(gh: GhRunner, cwd: string, q: { head: string; base: string; title: string; body: string }): Promise<CreatePr> {
  const r = await gh(['pr', 'create', '--head', q.head, '--base', q.base, '--title', q.title, '--body', q.body], { cwd, timeoutMs: 60_000 })
  if (r.missing) return { kind: 'missing' }
  const text = `${r.stdout}\n${r.stderr}`
  if (r.code === 0) {
    const url = text.match(/https?:\/\/\S+\/pull\/\d+/)?.[0]
    return url ? { kind: 'created', url } : { kind: 'error', message: 'gh did not print the pull request URL' }
  }
  if (/already exists/i.test(text)) return { kind: 'exists' }
  return { kind: 'error', message: text.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) || `gh exited ${r.code}` }
}

/** The newest review asking for changes, from `gh pr view --json reviews`. */
export function parseChangesReview(stdout: string): { at: string; author: string; body: string } | null {
  let raw: unknown
  try { raw = JSON.parse(stdout) } catch { return null }
  const reviews = (raw as { reviews?: unknown })?.reviews
  if (!Array.isArray(reviews)) return null
  let best: { at: string; author: string; body: string } | null = null
  for (const r of reviews as { state?: unknown; submittedAt?: unknown; body?: unknown; author?: { login?: unknown } }[]) {
    if (r?.state !== 'CHANGES_REQUESTED' || typeof r.submittedAt !== 'string') continue
    if (best && best.at >= r.submittedAt) continue
    best = { at: r.submittedAt, author: typeof r.author?.login === 'string' ? r.author.login : 'a reviewer', body: typeof r.body === 'string' ? r.body : '' }
  }
  return best
}

/** gh's sign-in state. A non-zero `gh auth status` is "not signed in" (gh prints why on stderr). */
export async function ghAuth(gh: GhRunner, cwd: string): Promise<GhState> {
  const r = await gh(['auth', 'status', '--hostname', 'github.com'], { cwd, timeoutMs: 10_000 })
  if (r.missing) return 'missing'
  return r.code === 0 ? 'ok' : 'signed_out'
}

export type PrLookup = { kind: 'pr'; pr: TaskPr } | { kind: 'none' } | { kind: 'error'; message: string }
/** The task's PR: by URL once known, else the PR whose head is the branch (cwd = the worktree, or the repo). */
export async function lookupPr(gh: GhRunner, q: { cwd: string; url: string | null; branch: string }, now: Date): Promise<PrLookup> {
  const r = await gh(['pr', 'view', q.url ?? q.branch, '--json', PR_FIELDS], { cwd: q.cwd })
  if (r.missing) return { kind: 'error', message: 'gh not found' }
  if (r.code !== 0) {
    if (/no pull requests? found|could not find any pull requests/i.test(r.stderr)) return { kind: 'none' }
    return { kind: 'error', message: r.stderr.trim().split('\n').pop()?.slice(0, 300) || `gh exited ${r.code}` }
  }
  const pr = parsePr(r.stdout, now)
  return pr ? { kind: 'pr', pr } : { kind: 'error', message: 'gh returned an unreadable pull request' }
}

/** The GitHub pull request links in a task's report (summary and evidence), deduped, at most five. */
export function prUrlsIn(texts: readonly string[]): string[] {
  const out: string[] = []
  for (const t of texts) for (const m of String(t ?? '').matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) if (!out.includes(m[0])) out.push(m[0])
  return out.slice(0, 5)
}

export async function latestChanges(gh: GhRunner, cwd: string, url: string): Promise<{ at: string; author: string; body: string } | null> {
  const r = await gh(['pr', 'view', url, '--json', 'reviews'], { cwd })
  return r.code === 0 ? parseChangesReview(r.stdout) : null
}

export type MergeResult = { kind: 'merged' } | { kind: 'conflict' } | { kind: 'error'; message: string }
/** Squash-merges the PR by URL (never --delete-branch: the founder's checkout is never switched). */
export async function mergePr(gh: GhRunner, cwd: string, url: string): Promise<MergeResult> {
  const r = await gh(['pr', 'merge', url, '--squash'], { cwd, timeoutMs: 60_000 })
  if (r.missing) return { kind: 'error', message: 'GitHub CLI not installed' }
  if (r.code === 0) return { kind: 'merged' }
  const text = `${r.stderr}\n${r.stdout}`
  if (/conflict|not mergeable|is not mergeable|dirty/i.test(text)) return { kind: 'conflict' }
  return { kind: 'error', message: text.trim().split('\n').filter(Boolean).pop()?.slice(0, 300) || `gh exited ${r.code}` }
}
