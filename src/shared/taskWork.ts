/**
 * WORKTREE.md: a code task's own git worktree, branch and pull request ("the task follows the work"). Stored as the
 * optional `work` field of a board task; rows written before it read as null. Pure: shared by main and the renderer.
 */

export const PR_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const
export type PrState = typeof PR_STATES[number]
export const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const
export type ReviewDecision = typeof REVIEW_DECISIONS[number]

/** The task's pull request as `gh pr view --json state,isDraft,reviewDecision,mergedAt,url,number` last saw it. */
export interface TaskPr {
  number: number
  url: string
  state: PrState
  isDraft: boolean
  reviewDecision: ReviewDecision | null
  mergedAt: string | null
  checkedAt: string
  /** the branch it merges into (gh's baseRefName); absent on rows read before it was asked for */
  base?: string | null
}

/** What the GitHub CLI said on the last check: null = not checked yet. */
export type GhState = 'ok' | 'missing' | 'signed_out' | 'error'

export interface TaskWork {
  repoId: string
  /** `<userData>/worktrees/task-<identifier>` */
  worktreePath: string
  /** `hive/<identifier-lower>-<slug of the title>`, inside the default pushBranches `hive/*` */
  branch: string
  /** the commit the branch started from; null while queued */
  baseSha: string | null
  /** the branch it started from ("origin/main"); its tip is what a local merge is checked against */
  baseRef: string | null
  pr: TaskPr | null
  /** when the worktree was created; null while queued */
  startedAt: string | null
  /** worktrees.id of the owner row (the task owns it, never a run) */
  worktreeId: string | null
  /** Start was pressed while the company was at maxInFlight: starts when a seat frees up */
  queuedAt: string | null
  /** the worktree folder was found missing while the task was not done (the banner shows until a choice) */
  goneAt: string | null
  /** the founder chose Keep As Is, or the worktree was removed on purpose: no banner */
  removedAt: string | null
  gh: GhState | null
  /** the last changes-requested review already handled (gh's submittedAt), so one review restarts the agent once */
  reviewSeenAt: string | null
  /** the PR number already seen open and ready while the task was not in flight (moved to review once per PR) */
  readySeen: number | null
  /** a merge from Principia failed because of conflicts */
  conflict: boolean
  /** one line about the last failure (gh, git), shown on the task */
  error: string | null
}

/** Directory name of a task's worktree under `<userData>/worktrees`. */
export function taskWorktreeDir(identifier: string): string {
  return `task-${identifier.replace(/[^A-Za-z0-9-]/g, '')}`
}

/** Lowercase slug, same rules as the run branches (worktrees.ts branchSlug). */
export function slugify(name: string, max = 40): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s
}

/** `hive/prn-12-fix-the-login-redirect`: always inside `hive/*`, so the run push guard's default covers it. */
export function taskBranchName(identifier: string, title: string): string {
  const id = slugify(identifier, 24) || 'task'
  const t = slugify(title, 40)
  return `hive/${t ? `${id}-${t}` : id}`
}

/** The task has a live binding: a worktree was created and not removed (it may still be gone from disk). */
export const workStarted = (w: TaskWork | null | undefined): boolean => !!w && !!w.startedAt && !w.removedAt
/** Start was pressed (or a review asked for changes) while no seat was free: it starts when one is. */
export const workQueued = (w: TaskWork | null | undefined): boolean => !!w && !!w.queuedAt
/** The worktree went away while the task was open and the founder has not chosen yet. */
export const workGone = (w: TaskWork | null | undefined): boolean => !!w && !!w.goneAt && !w.removedAt

/**
 * A task can be Started into a worktree: it has a repository its company owns (Personal included: its repos are the
 * unowned ones), it is not closed, and it has no live or queued binding.
 */
export function canStartWork(t: { repoId: string | null; status: string; work?: TaskWork | null; plan?: unknown }, companyRepoIds: readonly string[]): boolean {
  // PLANS.md: a plan's tasks work in their milestone's worktree; they start from the plan, never into one of their own
  if (t.plan) return false
  if (!t.repoId || !companyRepoIds.includes(t.repoId)) return false
  if (t.status === 'done' || t.status === 'canceled' || t.status === 'in_progress') return false
  return !workStarted(t.work) && !workQueued(t.work)
}

export type PrTone = 'running' | 'passed' | 'idle' | 'failed'
/** The PR chip: "#42 Open", "#42 Draft", "#42 Changes requested", "#42 Approved", "#42 Merged", "#42 Closed". */
export function prChip(pr: TaskPr | null | undefined): { label: string; tone: PrTone } | null {
  if (!pr) return null
  const n = `#${pr.number}`
  if (pr.state === 'MERGED') return { label: `${n} Merged`, tone: 'passed' }
  if (pr.state === 'CLOSED') return { label: `${n} Closed`, tone: 'idle' }
  if (pr.isDraft) return { label: `${n} Draft`, tone: 'idle' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: `${n} Changes requested`, tone: 'failed' }
  if (pr.reviewDecision === 'APPROVED') return { label: `${n} Approved`, tone: 'passed' }
  return { label: `${n} Open`, tone: 'running' }
}

export const GH_TEXT: Record<Exclude<GhState, 'ok'>, string> = {
  missing: 'GitHub CLI not installed',
  signed_out: 'GitHub CLI not signed in',
  error: 'GitHub did not answer; trying again later'
}

/**
 * What the task should do after a PR check. Pure, so every rule is tested once:
 * - merged → done ('Merged #N'); never while a run holds the task (the run end comes first)
 * - open and ready (not a draft) for the first time (readySeen), and the task is not in flight or in review → in_review.
 *   Edge-triggered: a task the founder sent back while its PR stays open is not bounced back to review.
 * - changes requested (a review not handled yet) on a task in review → back to work with the reviewer's note
 */
export type WorkMove =
  | { kind: 'done'; note: string }
  | { kind: 'review' }
  | { kind: 'changes'; reviewAt: string | null }
  | { kind: 'none' }
export function nextMove(task: { status: string }, pr: TaskPr, w: Pick<TaskWork, 'reviewSeenAt' | 'readySeen'>, latestChangesAt: string | null): WorkMove {
  if (task.status === 'done' || task.status === 'canceled' || task.status === 'in_progress') return { kind: 'none' }
  if (pr.state === 'MERGED') return { kind: 'done', note: `Merged #${pr.number}` }
  if (pr.state !== 'OPEN' || pr.isDraft) return { kind: 'none' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    if (task.status !== 'in_review') return { kind: 'none' }
    const fresh = !w.reviewSeenAt || (!!latestChangesAt && latestChangesAt > w.reviewSeenAt)
    return fresh ? { kind: 'changes', reviewAt: latestChangesAt } : { kind: 'none' }
  }
  if (w.readySeen !== pr.number && task.status !== 'in_review') return { kind: 'review' }
  return { kind: 'none' }
}

/** The short instructions a worktree turn gets as its wake (the prompt modules stay untouched). */
export function workBrief(w: Pick<TaskWork, 'worktreePath' | 'branch' | 'baseRef'>): string {
  return [
    `You work in your own git worktree at ${w.worktreePath} on branch ${w.branch}${w.baseRef ? ` (from ${w.baseRef})` : ''}. The founder's checkout is not yours: stay in this folder.`,
    `Commit here, push only this branch (git push -u origin HEAD), and open a pull request with gh pr create (not a draft) when it is ready for review. Never push to the default branch, never force push; merging is the founder's.`,
    'Do not share dependency folders with other worktrees: install them here if you need them.'
  ].join(' ')
}
