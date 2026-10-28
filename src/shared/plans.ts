/**
 * PLANS.md: task briefs and Plans, shared by main and the renderer. Pure: no Node, no Electron, no zod.
 *
 * A brief is the living definition of one board task (goal, context, acceptance criteria, decisions, open questions,
 * notes for the next agent) plus its proof. A Plan turns one goal into milestones and tasks that a head agent runs at the
 * pace the founder picks (Step by Step, Check-ins, Autopilot).
 */
import type { CompanyTask, TaskStatus } from './company'
import type { GhState, TaskPr } from './taskWork'

/**
 * PLANS.md §0: Plans ship behind their own experimental flag (Settings › Experimental), on top of the board's two.
 * Task briefs are not behind it: they are part of every board task.
 */
export function plansEnabled(flags: { companies?: boolean; departments?: boolean; plans?: boolean } | null | undefined): boolean {
  return !!flags?.companies && !!flags?.departments && !!flags?.plans
}
export const PLANS_OFF = 'Plans are off. Turn them on in Settings › Experimental.'

// ---------- briefs ----------

export const CRITERION_STATES = ['open', 'done', 'deferred', 'not_done'] as const
export type CriterionState = (typeof CRITERION_STATES)[number]
/** 'human', 'system' (Principia wrote it, e.g. the handoff from a report) or 'agent:<company agent id | agent>'. */
export type BriefAuthor = string
export interface BriefCriterion { id: string; text: string; state: CriterionState; reason?: string }
export interface BriefDecision { text: string; why: string; by: BriefAuthor; at: string }
export interface BriefQuestion { id: string; text: string; answer?: string }
export const BRIEF_SECTIONS = ['goal', 'context', 'criteria', 'decisions', 'questions', 'handoff', 'proof'] as const
export type BriefSection = (typeof BRIEF_SECTIONS)[number]
/** Sections task_brief_edit writes (decisions go through task_decide, proof through task_attach_proof). */
export const EDITABLE_SECTIONS = ['goal', 'context', 'criteria', 'questions', 'handoff'] as const
export type EditableSection = (typeof EDITABLE_SECTIONS)[number]
export interface BriefRevision { at: string; by: BriefAuthor; section: BriefSection }
export interface TaskBrief {
  goal: string
  context: string
  criteria: BriefCriterion[]
  decisions: BriefDecision[]
  questions: BriefQuestion[]
  /** notes for the next agent */
  handoff: string
  /** newest last, capped at BRIEF_LIMITS.revisions */
  revisions: BriefRevision[]
}
export const PROOF_KINDS = ['screenshot', 'test', 'link', 'file', 'graph'] as const
export type ProofKind = (typeof PROOF_KINDS)[number]
export interface TaskProof { id: string; kind: ProofKind; title: string; ref: string; by: BriefAuthor; at: string }
/** The plan a board task belongs to (written at approval; never edited by hand). */
export interface TaskPlanLink { planId: string; milestoneId: string; planTaskId: string | null; role: 'milestone' | 'task' }

export const BRIEF_LIMITS = {
  goal: 1000, context: 20_000, handoff: 6000, criterion: 500, criteria: 40, decision: 1000, why: 1000, decisions: 100,
  question: 1000, answer: 2000, questions: 40, reason: 500, revisions: 200, proof: 40, proofTitle: 200, proofRef: 4000
} as const
/** What the task prompt carries of a brief (the token budget): open criteria, the last 5 decisions, the handoff. */
export const BRIEF_PROMPT_LIMITS = { decisions: 5, goal: 600, context: 2000, criterion: 240, decision: 180, handoff: 1500, questions: 5 } as const

export const EMPTY_BRIEF: TaskBrief = { goal: '', context: '', criteria: [], decisions: [], questions: [], handoff: '', revisions: [] }

/**
 * The brief of any task. An old row has none: its description becomes the Context, so nothing is lost, and nothing
 * is written until someone edits the brief.
 */
export function briefOf(t: Pick<CompanyTask, 'description'> & { brief?: TaskBrief | null }): TaskBrief {
  if (t.brief) return { ...EMPTY_BRIEF, ...t.brief }
  return { ...EMPTY_BRIEF, context: t.description ?? '' }
}
export const proofOf = (t: { proof?: TaskProof[] | null }): TaskProof[] => t.proof ?? []
/** The last revision of a section, or null. */
export function lastRevision(b: TaskBrief, section: BriefSection): BriefRevision | null {
  for (let i = b.revisions.length - 1; i >= 0; i--) if (b.revisions[i].section === section) return b.revisions[i]
  return null
}
/** 'agent:ag_x' -> the agent id; 'human' / 'system' -> null. */
export const authorAgentId = (by: BriefAuthor): string | null => by.startsWith('agent:') ? by.slice(6) || null : null

/**
 * A blocker inside one plan is met once it is in review: its milestone agent finished it, and the milestone gate reviews
 * the work together (a task outside the plan still needs its dependencies done).
 */
export function planBlockerMet(t: { plan?: TaskPlanLink | null }, dep: { status: TaskStatus; plan?: TaskPlanLink | null }): boolean {
  return !!t.plan && !!dep.plan && t.plan.planId === dep.plan.planId && t.plan.role === 'task' && dep.status === 'in_review'
}

// ---------- plans ----------

export const PLAN_AUTONOMY = ['step', 'checkins', 'autopilot'] as const
export type PlanAutonomy = (typeof PLAN_AUTONOMY)[number]
export const AUTONOMY_LABEL: Record<PlanAutonomy, { title: string; text: string }> = {
  step: { title: 'Step by Step', text: 'you start each task' },
  checkins: { title: 'Check-ins', text: 'runs, waits for you at each milestone' },
  autopilot: { title: 'Autopilot', text: 'runs to the end, stops if something fails' }
}
/** archived: done or abandoned, out of the list (its open tasks were canceled) */
export const PLAN_STATUSES = ['draft', 'approved', 'running', 'done', 'archived'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
export type GateResult = 'pass' | 'fail'
export interface MilestoneGate {
  result: GateResult | null
  notes: string
  at: string | null
  /** proof ids and test lines the check cited; a pass with none is recorded as a fail */
  evidence: string[]
  /** how many checks failed (fix rounds) */
  fails: number
}
export interface Milestone {
  id: string
  /** M1, M2… (display) */
  key: string
  title: string
  /** milestone ids */
  dependsOn: string[]
  passCriteria: string[]
  /** the company agent that does this milestone's tasks (one agent, one session) */
  agentId: string | null
  /** the board task that holds this milestone's tasks (parentId), set at approval */
  taskId: string | null
  gate: MilestoneGate
  /** the founder passed the gate (Check-ins / Step by Step); Autopilot moves on a passing check */
  passedAt: string | null
  /**
   * One worktree per milestone, shown on the page: the milestone task's own `work` binding (WORKTREE.md) is the truth;
   * this is the copy written when it was made. null for a plan without a repository, or before the first start.
   */
  worktree: { path: string; branch: string } | null
  /** the milestone agent's provider conversation (--resume across its tasks) */
  sessionId: string | null
}
export interface PlanTaskSeed { goal: string; context: string; criteria: string[] }
export interface PlanTask {
  id: string
  milestoneId: string
  title: string
  briefSeed: PlanTaskSeed
  /** plan task ids this one waits for */
  blockers: string[]
  /** files it changes (globs) */
  touches: string[]
  /** the board task, once approved */
  taskId: string | null
  /** added by a failing gate check */
  fix?: boolean
}
/** After approval only fix tasks are added; each lands here. */
export interface PlanChange { at: string; by: BriefAuthor; text: string }
export interface Plan {
  id: string
  companyId: string
  repoId: string | null
  goal: string
  autonomy: PlanAutonomy
  status: PlanStatus
  /** the head agent writes the draft (company agent; the department head by default) */
  headAgentId: string | null
  /** the head agent's one-paragraph summary of the plan */
  body: string
  milestones: Milestone[]
  tasks: PlanTask[]
  /** the head agent is writing the draft */
  drafting: boolean
  draftError: string | null
  /** why the pilot stopped (a failing gate, a start that failed); null = running normally */
  halted: { reason: string; at: string; milestoneId: string | null } | null
  /** the founder paused it: nothing new starts (read right before every start); Resume clears it */
  pausedAt?: string | null
  changes: PlanChange[]
  /** PLANS.md §2.6: where the finished work is (one branch), its pull request, and whether the founder merged it */
  result?: PlanResultState | null
  archivedAt?: string | null
  createdAt: string
  updatedAt: string
  approvedAt: string | null
}
/**
 * PLANS.md §2.6: a done plan's work is on one hive/ branch (the first leaf milestone's, with the other leaves merged in
 * its worktree), pushed and opened as a pull request. Nothing is merged locally: the founder merges the PR (Merge…).
 */
export interface PlanResultState {
  /** the branch that holds the whole plan (null while it is being made, or when it could not be) */
  branch: string | null
  /** the milestone task whose worktree and binding hold it (its `work.pr` is the PR the worktree track follows) */
  taskId: string | null
  /** the branch the plan's first milestone started from, the PR's base (main) */
  baseBranch: string | null
  /** the branch is on origin */
  pushed: boolean
  /** the PR as last read (kept in step with the binding by the pilot) */
  pr: TaskPr | null
  /** the GitHub CLI on the last try: 'missing' / 'signed_out' show the Open a PR instructions */
  gh: GhState | null
  mergedAt: string | null
  /** why the branch could not be made, pushed or opened as a PR */
  error: string | null
}
export const PLAN_LIMITS = { goal: 4000, milestones: 12, tasks: 60, tasksPerMilestone: 12, title: 200, touches: 20, touch: 300, passCriteria: 10, criteria: 12 } as const

/** A milestone is complete when its check passed and, below Autopilot, the founder passed it too. */
export function milestoneComplete(p: Pick<Plan, 'autonomy'>, m: Milestone): boolean {
  return m.gate.result === 'pass' && (p.autonomy === 'autopilot' || !!m.passedAt)
}
/** Every milestone it depends on is complete. */
export function milestoneReady(p: Pick<Plan, 'autonomy' | 'milestones'>, m: Milestone): boolean {
  return m.dependsOn.every(id => { const d = p.milestones.find(x => x.id === id); return !d || milestoneComplete(p, d) })
}

/** A minimal glob overlap: `src/**`, `src/a/*.ts`, exact paths. Two patterns overlap when either could match a path of the other. */
export function touchesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) for (const y of b) if (globsMeet(x, y)) return true
  return false
}
function stem(g: string): string {
  const i = g.search(/[*?[{]/)
  return (i < 0 ? g : g.slice(0, i)).replace(/^\.\//, '')
}
function globsMeet(a: string, b: string): boolean {
  const x = a.trim().replace(/^\.\//, ''), y = b.trim().replace(/^\.\//, '')
  if (!x || !y) return false
  if (x === y) return true
  const sx = stem(x), sy = stem(y)
  const wx = sx !== x, wy = sy !== y
  if (!wx && !wy) return false
  if (wx && wy) return sx.startsWith(sy) || sy.startsWith(sx)
  return wx ? y.startsWith(sx) && globMatch(x, y) : x.startsWith(sy) && globMatch(y, x)
}
/** `**` any path, `*` within one segment, `?` one char. */
export function globMatch(glob: string, p: string): boolean {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(p)
}

// ---------- whose turn ----------

export interface TurnTask { id: string; identifier: string; status: TaskStatus; agentId: string | null }
export type TurnAction =
  | { kind: 'approve' }
  | { kind: 'pass'; milestoneId: string }
  | { kind: 'start'; taskId: string }
  | { kind: 'resume' }
  | { kind: 'review'; taskId: string }
  /** the plan's PR is open: Merge… (the worktree track's, on the result task) */
  | { kind: 'merge'; taskId: string }
  /** the branch is there but no PR yet (gh missing or signed out, or it failed): Open a PR (tries again) */
  | { kind: 'openPr' }
  | null
export interface Turn {
  /** one sentence: whose turn it is */
  text: string
  who: 'you' | 'agent' | 'nobody'
  /** the one contextual button */
  action: TurnAction
}
/** A done plan says where its code is and which PR holds it, until the founder merged it. Never a local merge. */
function doneTurn(p: Plan): Turn {
  const r = p.result
  const base = r?.baseBranch ?? 'the base branch'
  const pr = r?.pr
  if (p.status === 'archived') {
    if (r?.mergedAt) return { text: `Archived: merged into ${base}${pr ? ` (#${pr.number})` : ''}.`, who: 'nobody', action: null }
    if (pr?.state === 'OPEN') return { text: `Archived: the work is in PR #${pr.number} (${r!.branch}), not merged.`, who: 'nobody', action: null }
    return { text: r?.branch ? `Archived: the work is on ${r.branch}, not merged.` : 'Archived.', who: 'nobody', action: null }
  }
  if (!r) return { text: p.repoId ? 'Done: every milestone passed. Putting the work on one branch and opening a pull request.' : 'Done: every milestone passed.', who: 'nobody', action: null }
  if (r.mergedAt) return { text: `Done: merged into ${base}${pr ? ` (#${pr.number})` : ''}.`, who: 'nobody', action: null }
  if (r.error && !r.branch) return { text: `Done, but the work is not on one branch yet: ${r.error}`, who: 'you', action: null }
  if (pr?.state === 'OPEN' && r.taskId) return { text: `Your turn: review PR #${pr.number} (${r.branch}) and merge it into ${base}.`, who: 'you', action: { kind: 'merge', taskId: r.taskId } }
  if (pr?.state === 'CLOSED') return { text: `PR #${pr.number} was closed without merging. The work is still on ${r.branch}.`, who: 'you', action: { kind: 'openPr' } }
  if (r.branch && !r.pushed) return { text: `Your turn: the work is on ${r.branch}, not pushed yet${r.error ? ` (${r.error})` : ''}.`, who: 'you', action: { kind: 'openPr' } }
  if (r.branch) return { text: `Your turn: the work is on ${r.branch}. Open a pull request into ${base}.`, who: 'you', action: { kind: 'openPr' } }
  return { text: 'Done: every milestone passed.', who: 'nobody', action: null }
}
/** The Open a PR instructions when gh cannot do it (missing, signed out): the commands, never a local merge. */
export function openPrInstructions(r: Pick<PlanResultState, 'branch' | 'baseBranch' | 'pushed' | 'gh'>): string[] {
  if (!r.branch) return []
  const base = r.baseBranch ?? 'main'
  const lines: string[] = []
  if (!r.pushed) lines.push(`git push -u origin ${r.branch}`)
  lines.push(`gh pr create --head ${r.branch} --base ${base}`)
  return lines
}
const mLabel = (m: Milestone) => `Milestone ${m.key.replace(/^M/, '')}`

/**
 * The top line of a plan page. `tasks`: the board rows of the plan's tasks; `agentName`: the display name of a company
 * agent; `checking`: a milestone whose gate check is running now.
 */
export function whoseTurn(p: Plan, tasks: readonly TurnTask[], agentName: (id: string | null) => string, checking: string | null = null): Turn {
  if (p.status === 'draft') {
    if (p.drafting) return { text: `${agentName(p.headAgentId)} is drafting the plan.`, who: 'agent', action: null }
    if (p.draftError) return { text: `Your turn: the draft failed (${p.draftError}). Draft it again.`, who: 'you', action: null }
    return { text: 'Your turn: read the draft and approve it, or discard it.', who: 'you', action: { kind: 'approve' } }
  }
  if (p.status === 'done' || p.status === 'archived') return doneTurn(p)
  const byId = new Map(tasks.map(t => [t.id, t]))
  const rowsOf = (m: Milestone) => p.tasks.filter(t => t.milestoneId === m.id).map(t => (t.taskId ? byId.get(t.taskId) : undefined)).filter((t): t is TurnTask => !!t)
  // an agent at work comes first: it is what is happening right now
  for (const m of p.milestones) {
    const live = rowsOf(m).find(t => t.status === 'in_progress')
    if (live) return { text: `${m.key} agent (${agentName(live.agentId ?? m.agentId)}) is working on ${live.identifier}.${p.pausedAt ? ' Paused: nothing new starts after it.' : ''}`, who: 'agent', action: null }
  }
  if (checking) {
    const m = p.milestones.find(x => x.id === checking)
    if (m) return { text: `${agentName(p.headAgentId)} is checking ${mLabel(m)} against its pass criteria.`, who: 'agent', action: null }
  }
  if (p.halted) return { text: `Your turn: ${p.halted.reason}`, who: 'you', action: { kind: 'resume' } }
  if (p.pausedAt) return { text: 'Paused: nothing new starts. Resume it to go on.', who: 'you', action: { kind: 'resume' } }
  for (const m of p.milestones) {
    if (milestoneComplete(p, m)) continue
    if (!milestoneReady(p, m)) continue
    const rows = rowsOf(m)
    const parked = rows.find(t => t.status === 'blocked')
    const open = rows.filter(t => t.status !== 'done' && t.status !== 'canceled' && t.status !== 'in_review')
    if (!open.length && m.gate.result === 'pass') return { text: `Your turn: pass ${mLabel(m)} or send it back.`, who: 'you', action: { kind: 'pass', milestoneId: m.id } }
    if (!open.length && m.gate.result === null) return { text: `${agentName(p.headAgentId)} checks ${mLabel(m)} next.`, who: 'agent', action: null }
    if (parked) return { text: `Your turn: ${parked.identifier} is blocked. Open it to see why.`, who: 'you', action: { kind: 'review', taskId: parked.id } }
    const next = open.find(t => t.status === 'backlog' || t.status === 'todo')
    if (next && p.autonomy === 'step') return { text: `Your turn: start ${next.identifier}.`, who: 'you', action: { kind: 'start', taskId: next.id } }
    if (next) return { text: `${m.key} agent (${agentName(m.agentId)}) starts ${next.identifier} next.`, who: 'agent', action: null }
  }
  return { text: 'Waiting for the next milestone to become ready.', who: 'nobody', action: null }
}

// ---------- IPC (merged into shared/ipc.ts InvokeMap) ----------

export type BriefOp =
  | { op: 'edit'; taskId: string; section: Exclude<EditableSection, 'criteria' | 'questions'>; text: string }
  | { op: 'addCriterion'; taskId: string; text: string }
  | { op: 'criterion'; taskId: string; id: string; state: CriterionState; reason?: string }
  | { op: 'removeCriterion'; taskId: string; id: string }
  | { op: 'decide'; taskId: string; text: string; why: string }
  | { op: 'ask'; taskId: string; text: string }
  | { op: 'answer'; taskId: string; id: string; answer: string }
export interface BriefView { taskId: string; brief: TaskBrief; proof: TaskProof[] }
export interface PlanCreateInput { companyId: string; goal: string; autonomy: PlanAutonomy; repoId?: string | null; headAgentId?: string | null }
/** The founder's edit of a draft: the whole milestones/tasks lists (validated in main). */
export interface PlanDraftEdit { id: string; goal?: string; body?: string; milestones?: Milestone[]; tasks?: PlanTask[]; autonomy?: PlanAutonomy; repoId?: string | null; headAgentId?: string | null }
export interface PlanDetail {
  plan: Plan
  tasks: CompanyTask[]
  /** the milestone whose gate check is running */
  checking: string | null
  /** the top line: whose turn it is */
  turn: Turn
  /** why a running plan waits (another plan touches the same files) */
  waiting: string | null
  /** why a ready milestone has not started yet, by milestone id ("waits: Livia is running 3 tasks; PRN-17 starts when one finishes") */
  waits?: Record<string, string>
}

export interface PlansInvokeMap {
  /** PLANS.md §1: a human edit of a task brief (any section, any time) */
  'tasks:brief': [BriefOp, BriefView]
  /** a screenshot proof as a data: URL (images only, ≤ 4 MB); null when it cannot be shown */
  'tasks:proofPreview': [{ taskId: string; proofId: string }, string | null]
  /** archived plans only with includeArchived */
  'plans:list': [{ companyId?: string; includeArchived?: boolean } | void, Plan[]]
  'plans:get': [{ id: string }, PlanDetail]
  /** writes the draft row and starts the head agent's draft (never touches the Board) */
  'plans:create': [PlanCreateInput, Plan]
  'plans:redraft': [{ id: string }, Plan]
  'plans:saveDraft': [PlanDraftEdit, Plan]
  /** puts the tasks on the Board with their briefs, parents and blockers; then the pilot runs it */
  'plans:approve': [{ id: string }, Plan]
  'plans:discard': [{ id: string }, void]
  'plans:setAutonomy': [{ id: string; autonomy: PlanAutonomy }, Plan]
  /** Step by Step "Start ENG-31" (any autonomy: a human start) */
  'plans:start': [{ id: string; taskId: string }, Plan]
  /** the founder passes a milestone (approves its tasks in review) */
  'plans:pass': [{ id: string; milestoneId: string; note?: string }, Plan]
  /** the founder sends a milestone back: a fix task with the note */
  'plans:sendBack': [{ id: string; milestoneId: string; note: string }, Plan]
  /** clears a stop (failed gate, failed start) and lets the pilot continue */
  'plans:resume': [{ id: string }, Plan]
  /** stops starting new tasks (a running turn finishes); Resume goes on */
  'plans:pause': [{ id: string }, Plan]
  /**
   * out of the list; an unfinished plan's open tasks are canceled, its In review ones too (they leave Needs you), with
   * the plan named. Refused while a task is in progress
   */
  'plans:archive': [{ id: string }, Plan]
  /**
   * a done plan: push its branch (hive/* only, the guarded push) and open the pull request with gh. Never merges: the
   * founder merges the PR with Merge… (taskWork:merge on result.taskId)
   */
  'plans:publish': [{ id: string }, Plan]
}
export const PLANS_CHANNELS = ['tasks:brief', 'tasks:proofPreview', 'plans:list', 'plans:get', 'plans:create', 'plans:redraft', 'plans:saveDraft', 'plans:approve', 'plans:discard', 'plans:setAutonomy', 'plans:start', 'plans:pass', 'plans:sendBack', 'plans:resume', 'plans:pause', 'plans:archive', 'plans:publish'] as const satisfies readonly (keyof PlansInvokeMap)[]
