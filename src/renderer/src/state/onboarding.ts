/**
 * Business-first onboarding: the renderer's pure state (docs/ONBOARDING.md §3, §3.1, §9).
 *
 * - `reduceOnboarding` is the §3 state machine over `OnboardingDraft` (history stack, connect → name skip, Content
 *   skipped without a content goal, no Back once launching). Pure: no store, no IPC, no timers.
 * - §2 S0 for a new company: Guided (the questions), From a prompt (Start → Brief → Plan, or Name when the brief could
 *   not be read) and From a repo (Start → Connect → Plan, asking the name only when the scan found none).
 * - `loadDraft` / `createDraftSaver` persist the draft under `principia.onboarding.v1`, zod-validated, discarded after
 *   14 days. Storage is injected (store.ts passes `loadJson` / `saveJson`), so this module never imports the store.
 * - Selectors, `planInput(draft)`, stale-plan detection (`inputsHash`) and the §2 S4 goal defaults.
 *
 * Keys never enter the draft: the key actions take the check result and keep only `stashId` and `last4` (§3.1).
 */
import {
  BRIEF_MAX,
  CLONE_URL,
  DRAFT_MAX_AGE_MS,
  DRAFT_STORAGE_KEY,
  DraftSchema,
  EMPTY_ANSWERS,
  GITHUB_FULL_NAME,
  GOALS,
  GOAL_INFO,
  KEY_PROVIDERS,
  LaunchInputSchema,
  MAX_ONBOARDING_PATHS,
  OnboardingPlan as OnboardingPlanSchema,
  PLAN_ADAPTERS,
  VIBES,
  workflowsForKeys,
  type DraftGithub,
  type DraftRepo,
  type GoalKey,
  type JournalMeta,
  type KeyCheckResult,
  type KeyProvider,
  type LaunchInput,
  type OnboardingAnswers,
  type OnboardingAvailable,
  type OnboardingDraft,
  type OnboardingPlan,
  type PlanAdapter,
  type PlanInput,
  type ScanSummary,
  type SiteSummary,
  type StartMode,
  type StepKey,
  type WorkflowKeyName
} from '@shared/onboarding'
import { applyAgentPlan, defaultGoals, effectiveGoals, inputsHash, needsContentStep, siteHost } from '@shared/onboardingPlan'
import { prefill } from '@shared/onboardingPrefill'
import { briefForPlan } from '@shared/onboardingBrief'

export type OnboardingMode = OnboardingDraft['mode']

// ---------- draft creation ----------

const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const raw = c?.randomUUID ? c.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `ob_${raw.slice(0, 24)}`
}

/** A fresh draft at the Start step. Departments consent is on by default (§2 S6). */
export function newDraft(mode: OnboardingMode, opts: { id?: string; now?: Date } = {}): OnboardingDraft {
  return {
    v: 1,
    id: opts.id && HANDLE_RE.test(opts.id) ? opts.id : randomId(),
    mode,
    step: 'start',
    history: [],
    hasCode: null,
    repos: [],
    answers: { ...EMPTY_ANSWERS, goals: [] },
    content: { wants: false, provider: null, keySource: null, vibizInterest: false },
    enableFlags: true,
    updatedAt: (opts.now ?? new Date()).toISOString()
  }
}

/** True when the draft holds something worth resuming ("Pick up where you left off?"). */
export function hasProgress(d: OnboardingDraft | null | undefined): boolean {
  if (!d) return false
  return d.step !== 'start' || d.hasCode !== null || d.answers.name.trim().length > 0 || !!d.journalId || !!d.brief?.trim()
}

// ---------- persistence (§3.1) ----------

export type LoadJsonFn = <T>(key: string, fallback: T) => T
export type SaveJsonFn = (key: string, v: unknown) => void

/**
 * Re-parses a stored draft. null on version mismatch, shape failure, a bad or missing `updatedAt`, or age over 14 days.
 * A draft dated in the future (clock change) is accepted.
 */
export function parseDraft(raw: unknown, now: Date = new Date()): OnboardingDraft | null {
  if (!raw || typeof raw !== 'object') return null
  if ((raw as { v?: unknown }).v !== 1) return null
  const parsed = DraftSchema.safeParse(raw)
  if (!parsed.success) return null
  const at = Date.parse(parsed.data.updatedAt)
  if (!Number.isFinite(at)) return null
  if (now.getTime() - at > DRAFT_MAX_AGE_MS) return null
  return parsed.data
}

/** The draft as stored: re-validated (strict, so nothing extra can ride along) or null when it doesn't parse. */
export function serializeDraft(d: OnboardingDraft): string | null {
  const parsed = DraftSchema.safeParse(d)
  return parsed.success ? JSON.stringify(parsed.data) : null
}

export function loadDraft(load: LoadJsonFn, now: Date = new Date()): OnboardingDraft | null {
  return parseDraft(load<unknown>(DRAFT_STORAGE_KEY, null), now)
}

/** Immediate write (stamps `updatedAt`). A draft that fails the schema is not written; returns false then. */
export function writeDraft(save: SaveJsonFn, d: OnboardingDraft, now: Date = new Date()): boolean {
  const json = serializeDraft({ ...d, updatedAt: now.toISOString() })
  if (json === null) return false
  save(DRAFT_STORAGE_KEY, JSON.parse(json))
  return true
}

export function clearStoredDraft(save: SaveJsonFn): void {
  save(DRAFT_STORAGE_KEY, null)
}

export interface DraftSaver {
  /** Debounced: the last draft given within `delayMs` is written. */
  save(d: OnboardingDraft): void
  /** Write the pending draft now (close, launch, unload). */
  flush(): void
  /** Drop the pending write (discard, start over). */
  cancel(): void
  pending(): boolean
}

export const DRAFT_SAVE_DELAY_MS = 300

export function createDraftSaver(save: SaveJsonFn, delayMs = DRAFT_SAVE_DELAY_MS, now: () => Date = () => new Date()): DraftSaver {
  let timer: ReturnType<typeof setTimeout> | null = null
  let next: OnboardingDraft | null = null
  const run = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    const d = next
    next = null
    if (d) writeDraft(save, d, now())
  }
  return {
    save(d) {
      next = d
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, delayMs)
    },
    flush: run,
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      next = null
    },
    pending: () => next !== null
  }
}

// ---------- context the renderer knows (onboarding:status, settings) ----------

export interface PlanInputContext {
  /** onboarding:status `sharedKeys` (Shared namespace only). */
  sharedKeys?: Partial<Record<WorkflowKeyName, boolean>>
  /** Departments + companies already on in settings (consent is then not needed). */
  flagsOn?: boolean
  /** IANA zone for schedules. */
  tz?: string
}

function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// ---------- selectors ----------

/** The draft's site counts as "found" (§2 S4 defaults) when a host was typed or prefilled, or a site was read. */
export function hasSite(d: OnboardingDraft): boolean {
  return !!siteHost(d.answers.siteUrl) || !!d.site
}

/** The goals the plan is built from (picked, else the §2 S4 defaults). */
export function draftGoals(d: OnboardingDraft): GoalKey[] {
  return effectiveGoals(d.answers.goals, !!d.hasCode, hasSite(d))
}

/** §2 S4 defaults for this draft. */
export function goalDefaults(d: OnboardingDraft): GoalKey[] {
  return defaultGoals(!!d.hasCode, hasSite(d))
}

/** §2 S5: the Content step is shown only when the goals include a content goal. */
export function needsContent(d: OnboardingDraft): boolean {
  return needsContentStep(draftGoals(d))
}

/** The GitHub pick (or pasted link) is usable for launch. */
export function githubReady(g: DraftGithub | undefined): boolean {
  if (!g) return false
  return (!!g.fullName && GITHUB_FULL_NAME.test(g.fullName)) || (!!g.url && CLONE_URL.test(g.url))
}

export const QUESTION_STEPS = ['start', 'about', 'voice', 'goals', 'content', 'plan'] as const

/**
 * "Step n of N" (§2): Connect and Name are sub-steps of Start; Content counts only when shown. null for the launch
 * steps (no progress row there).
 */
export function stepIndex(d: OnboardingDraft): { index: number; total: number } | null {
  const total = needsContent(d) ? 6 : 5
  const at = (s: StepKey): number | null => {
    switch (s) {
      case 'start':
      case 'brief':
      case 'connect':
      case 'name':
        return 1
      case 'about':
        return 2
      case 'voice':
        return 3
      case 'goals':
        return 4
      case 'content':
        return 5
      case 'plan':
        return total
      default:
        return null
    }
  }
  const index = at(d.step)
  return index === null ? null : { index, total }
}

/** Whether the primary button is enabled on the current step. */
export function canContinue(d: OnboardingDraft): boolean {
  switch (d.step) {
    case 'start':
      return d.start === 'prompt' || d.start === 'repo' || d.hasCode !== null
    case 'brief':
      return !!d.brief?.trim()
    case 'connect':
      return d.repos.length > 0 || githubReady(d.github)
    case 'name':
    case 'about':
      return d.answers.name.trim().length > 0
    case 'voice':
    case 'goals':
    case 'content':
      return true
    case 'plan':
      return d.answers.name.trim().length > 0 && !!d.plan && (d.plan.value.tasks.some((t) => t.include) || d.plan.value.schedules.some((s) => s.include))
    default:
      return false
  }
}

/** §3: Back exists on every step before `launching`, when there is somewhere to go back to. */
export function canGoBack(d: OnboardingDraft): boolean {
  return !isLaunchStep(d.step) && d.history.length > 0
}

export function isLaunchStep(s: StepKey): boolean {
  return s === 'launching' || s === 'failed' || s === 'ready'
}

/** The step `next` leads to from the current one, or null when it can't move. */
export function nextStep(d: OnboardingDraft): StepKey | null {
  if (!canContinue(d)) return null
  switch (d.step) {
    case 'start':
      if (d.start === 'prompt') return 'brief'
      if (d.start === 'repo') return 'connect'
      return d.hasCode ? 'connect' : 'name'
    // the brief's own primary reads it first (briefRead); a plain next is the no-model path: the questions, prefilled
    case 'brief':
      return 'name'
    // From a repo: the scan answers the questions; only a missing name is asked
    case 'connect':
      if (d.start === 'repo') return d.answers.name.trim() ? 'plan' : 'name'
      return 'about'
    case 'name':
      return d.start === 'repo' ? 'plan' : 'about'
    case 'about':
      return 'voice'
    case 'voice':
      return 'goals'
    case 'goals':
      return needsContent(d) ? 'content' : 'plan'
    case 'content':
      return 'plan'
    case 'plan':
      return 'launching'
    default:
      return null
  }
}

// ---------- plan input and stale plans (§3, §4) ----------

/** Keys the plan may count on: a Shared key or one stashed in this flow, and only when the founder wants content. */
export function draftKeys(d: OnboardingDraft, ctx: PlanInputContext = {}): { fal: boolean; openai: boolean } {
  const on = needsContent(d) && d.content.wants
  const stashed = (p: KeyProvider): boolean => d.content.provider === p && d.content.keySource === 'stash' && !!d.content.stashId
  return {
    fal: on && (!!ctx.sharedKeys?.FAL_KEY || stashed('fal')),
    openai: on && (!!ctx.sharedKeys?.OPENAI_API_KEY || stashed('openai'))
  }
}

/** §4 `PlanInput` for this draft. Scan facts ride along only on the code branch. */
export function planInput(d: OnboardingDraft, ctx: PlanInputContext = {}): PlanInput {
  const input: PlanInput = {
    hasCode: !!d.hasCode,
    answers: { ...d.answers, goals: [...d.answers.goals] },
    keys: draftKeys(d, ctx),
    departmentsOn: !!ctx.flagsOn || d.enableFlags,
    tz: ctx.tz || localTz()
  }
  if (d.hasCode && d.scan) input.scan = d.scan
  if (d.site) input.site = d.site
  const brief = briefForPlan(d.brief)
  if (brief) input.brief = brief
  return input
}

export function draftInputsHash(d: OnboardingDraft, ctx: PlanInputContext = {}): string {
  return inputsHash(planInput(d, ctx))
}

/** What the renderer can say is available for the starter plan; main recomputes the real one. */
export function availableFor(input: PlanInput, installed: readonly string[], sharedKeys: Partial<Record<WorkflowKeyName, boolean>> = {}): OnboardingAvailable {
  const profileAdapters = PLAN_ADAPTERS.filter((a) => installed.includes(a)) as PlanAdapter[]
  return {
    workflows: workflowsForKeys({ FAL_KEY: input.keys.fal, OPENAI_API_KEY: input.keys.openai, FIRECRAWL_API_KEY: !!sharedKeys.FIRECRAWL_API_KEY }),
    profileAdapters: profileAdapters.length ? profileAdapters : ['claude'],
    hasCode: input.hasCode,
    departmentsOn: input.departmentsOn
  }
}

/**
 * §3 stale-plan handling:
 * - `none`: no plan yet (render the template);
 * - `fresh`: made for these answers;
 * - `stale`: unedited, answers changed: re-render from the template (and re-request an agent plan if it was one);
 * - `staleEdited`: the founder edited it: "Your answers changed · [Rebuild plan] [Keep]".
 */
export type PlanFreshness = 'none' | 'fresh' | 'stale' | 'staleEdited'
export function planFreshness(d: OnboardingDraft, ctx: PlanInputContext = {}): PlanFreshness {
  if (!d.plan) return 'none'
  if (d.plan.inputsHash === draftInputsHash(d, ctx)) return 'fresh'
  return d.plan.edited ? 'staleEdited' : 'stale'
}

/** An unedited agent plan whose answers changed is asked for again (§3). */
export function shouldRerequestAgentPlan(d: OnboardingDraft, ctx: PlanInputContext = {}): boolean {
  return !!d.plan && d.plan.source === 'agent' && planFreshness(d, ctx) === 'stale'
}

/**
 * §4 `LaunchInput` for this draft, or null when it can't launch (no name, no plan, or it fails the schema).
 * Code facts (repos, GitHub, scan) only on the code branch; the stashed key only when the founder said yes to content
 * and it is in use (`keySource: 'stash'`). Shared keys are never named (they are not copied).
 */
export function launchInput(d: OnboardingDraft, ctx: PlanInputContext = {}): LaunchInput | null {
  if (!d.plan) return null
  const p = planInput(d, ctx)
  const c = d.content
  const useKey = needsContent(d) && c.wants && c.keySource === 'stash' && !!c.provider && !!c.stashId
  const input: LaunchInput = {
    mode: d.mode,
    hasCode: p.hasCode,
    answers: p.answers,
    repos: d.hasCode ? d.repos.map((r) => ({ ...r })) : [],
    key: useKey ? { name: KEY_PROVIDERS[c.provider!], stashId: c.stashId! } : null,
    plan: d.plan.value,
    enableFlags: d.enableFlags,
    tz: p.tz
  }
  if (d.hasCode && d.github && githubReady(d.github)) input.github = { ...d.github }
  if (p.scan) input.scan = p.scan
  if (p.site) input.site = p.site
  if (d.brief?.trim()) input.brief = d.brief.trim().slice(0, BRIEF_MAX)
  const parsed = LaunchInputSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}

/**
 * A saved draft on a Launch step, checked against what main reports (`onboarding:status.journal`), so a resume never
 * gets stuck on a live list with no Back and no Esc:
 * - its journal is running / failed → that Launch step;
 * - its journal is done (the company exists) → null: nothing left to resume;
 * - its journal was discarded, or main knows no journal for it → back to Plan (no company was made, or it was undone).
 * Not on a Launch step → unchanged. `ready` → null.
 */
export function reconcileLaunchDraft(d: OnboardingDraft, journal: JournalMeta | null): OnboardingDraft | null {
  if (d.step === 'ready') return null
  if (!isLaunchStep(d.step)) return d
  const j = journal && ((!!d.journalId && journal.id === d.journalId) || journal.draftId === d.id) ? journal : null
  if (j?.status === 'running' || j?.status === 'failed') {
    const step = j.status === 'running' ? 'launching' : 'failed'
    return d.step === step && d.journalId === j.id ? d : { ...d, step, journalId: j.id }
  }
  if (j?.status === 'done') return null
  const history = d.history.filter((s) => !isLaunchStep(s) && s !== 'plan')
  const back: OnboardingDraft = { ...d, step: 'plan', history }
  if (j?.status === 'discarded') delete back.journalId
  return back
}

// ---------- actions ----------

export type OnboardingAction =
  /** Start (new company): Guided / From a prompt / From a repo. */
  | { type: 'chooseStart'; start: StartMode }
  /** Start: "Yes, connect it" / "Not yet, it's an idea". */
  | { type: 'chooseCode'; hasCode: boolean }
  /** Brief: the textarea. */
  | { type: 'setBrief'; brief: string }
  /**
   * Brief: what onboarding:brief read from it. The answers it gave replace the draft's; read by Claude with a name →
   * Plan, else (fallback, no name) → Name with the rest prefilled, so the guided questions fill the gaps.
   */
  | { type: 'briefRead'; answers: Partial<OnboardingAnswers>; source: 'agent' | 'template' }
  | { type: 'next' }
  | { type: 'back' }
  /** Connect: "No code after all" → Name, keeping nothing from Connect. */
  | { type: 'skipConnect' }
  | { type: 'setAnswers'; patch: Partial<OnboardingAnswers> }
  /** Fills only the empty answers from the scan / site read (§5.1 prefill). */
  | { type: 'applyPrefill' }
  | { type: 'toggleGoal'; goal: GoalKey }
  | { type: 'setRepos'; repos: DraftRepo[] }
  | { type: 'setGithub'; github: DraftGithub | undefined }
  | { type: 'setScan'; scan: ScanSummary | undefined }
  | { type: 'setSite'; site: SiteSummary | undefined }
  | { type: 'setContentWants'; wants: boolean }
  | { type: 'setProvider'; provider: KeyProvider | null }
  /** A Shared key for the chosen provider exists: use it, copy nothing. */
  | { type: 'useSharedKey'; provider: KeyProvider }
  /** onboarding:key check result. Only `stashId` and `last4` are kept; `valid` is used at once, `unknown` waits for "Use anyway". */
  | { type: 'keyChecked'; provider: KeyProvider; result: KeyCheckResult }
  | { type: 'keyUseAnyway' }
  /** The stash was forgotten (dismissed, expired, restarted): drop the handle. */
  | { type: 'keyForget' }
  | { type: 'setVibizInterest'; on: boolean }
  | { type: 'setEnableFlags'; on: boolean }
  /** The starter plan for `inputsHash`. Replaces a missing plan or an unedited stale one; never an edited one. */
  | { type: 'templatePlan'; plan: OnboardingPlan; inputsHash: string }
  /** The founder edited the plan on screen. */
  | { type: 'editPlan'; plan: OnboardingPlan }
  /** "Use it" on the offered agent plan. */
  | { type: 'useOfferedPlan'; plan: OnboardingPlan; inputsHash: string }
  /** "Rebuild plan" after answers changed: the template replaces the edited plan. */
  | { type: 'rebuildPlan'; plan: OnboardingPlan; inputsHash: string }
  /** "Keep" after answers changed: keep the edited plan for the new answers. */
  | { type: 'keepPlan'; inputsHash: string }
  | { type: 'launchStarted'; journalId: string }
  | { type: 'launchFailed'; journalId?: string }
  | { type: 'launchDone'; journalId?: string }
  /** Retry / "Continue without this": back to the live list. */
  | { type: 'launchResumed' }
  /** Opened from a failed or running journal on boot (§7.4). */
  | { type: 'resumeJournal'; journalId: string; status: 'failed' | 'running'; name?: string }
  | { type: 'setMode'; mode: OnboardingMode }

const MAX_HISTORY = 32

function forward(d: OnboardingDraft, to: StepKey): OnboardingDraft {
  const history = [...d.history, d.step].slice(-MAX_HISTORY)
  let next: OnboardingDraft = { ...d, step: to, history }
  // §2 S4: arriving on Goals with nothing picked fills the defaults
  if (to === 'goals' && next.answers.goals.length === 0) next = { ...next, answers: { ...next.answers, goals: goalDefaults(next) } }
  return next
}

function cleanLast4(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/[^A-Za-z0-9]/g, '').slice(-4)
  return s || undefined
}

function cleanStash(v: unknown): string | undefined {
  return typeof v === 'string' && HANDLE_RE.test(v) ? v : undefined
}

const ANSWER_LIMITS: Record<Exclude<keyof OnboardingAnswers, 'voiceVibe' | 'goals'>, number> = {
  name: 80,
  oneLiner: 200,
  products: 500,
  audience: 500,
  siteUrl: 2048,
  instagram: 100,
  voiceText: 600,
  avoid: 300,
  goalOther: 120
}

/** Only known answer fields, capped to the schema limits, so a patch can never make the draft unsaveable. */
function mergeAnswers(a: OnboardingAnswers, patch: Partial<OnboardingAnswers>, hasCode: boolean): OnboardingAnswers {
  const out: OnboardingAnswers = { ...a }
  for (const k of Object.keys(ANSWER_LIMITS) as (keyof typeof ANSWER_LIMITS)[]) {
    const v = patch[k]
    if (typeof v === 'string') out[k] = v.slice(0, ANSWER_LIMITS[k])
  }
  if (patch.voiceVibe === null) out.voiceVibe = null
  else if (patch.voiceVibe && VIBES.includes(patch.voiceVibe)) out.voiceVibe = patch.voiceVibe
  if (Array.isArray(patch.goals)) out.goals = cleanGoals(patch.goals, hasCode)
  return out
}

function cleanGoals(goals: readonly GoalKey[], hasCode: boolean): GoalKey[] {
  const out: GoalKey[] = []
  for (const g of goals) if (GOALS.includes(g) && !out.includes(g) && (hasCode || !GOAL_INFO[g].codeOnly)) out.push(g)
  return out
}

function withPlan(d: OnboardingDraft, plan: OnboardingPlan, source: 'agent' | 'template', edited: boolean, hash: string): OnboardingDraft {
  return { ...d, plan: { value: plan, source, edited, inputsHash: hash } }
}

/** The §3 state machine. Pure; returns the same object when nothing changes. */
export function reduceOnboarding(d: OnboardingDraft, a: OnboardingAction): OnboardingDraft {
  const launching = isLaunchStep(d.step)
  switch (a.type) {
    case 'chooseStart': {
      if (d.step !== 'start' || d.start === a.start) return d
      if (a.start === 'repo') return { ...d, start: 'repo', hasCode: true }
      if (a.start === 'guided') return { ...d, start: 'guided' }
      // From a prompt: no code picked in this flow (Connect is not on its path), nothing from Connect rides along
      const { github: _g, scan: _s, ...rest } = d
      void _g
      void _s
      return { ...rest, start: 'prompt', hasCode: false, repos: [], answers: { ...d.answers, goals: cleanGoals(d.answers.goals, false) } }
    }
    case 'setBrief':
      if (launching) return d
      return { ...d, brief: a.brief.slice(0, BRIEF_MAX) }
    case 'briefRead': {
      if (d.step !== 'brief') return d
      const answers = mergeAnswers(d.answers, a.answers, !!d.hasCode)
      const next = { ...d, answers }
      return forward(next, a.source === 'agent' && answers.name.trim() ? 'plan' : 'name')
    }
    case 'chooseCode': {
      if (d.step !== 'start') return d
      if (a.hasCode) return d.hasCode === true ? d : { ...d, hasCode: true }
      // "Not yet, it's an idea" after visiting Connect: nothing picked there may ride along to launch (§2 S1a)
      const { github: _g, scan: _s, ...rest } = d
      void _g
      void _s
      return { ...rest, hasCode: false, repos: [], answers: { ...d.answers, goals: cleanGoals(d.answers.goals, false) } }
    }
    case 'next': {
      const to = nextStep(d)
      return to ? forward(d, to) : d
    }
    case 'back': {
      if (!canGoBack(d)) return d
      const history = d.history.slice(0, -1)
      return { ...d, step: d.history[d.history.length - 1]!, history }
    }
    case 'skipConnect': {
      if (d.step !== 'connect') return d
      // keeps nothing from Connect; Back from Name returns to Start (Connect no longer applies)
      const { github: _g, scan: _s, ...rest } = d
      void _g
      void _s
      return {
        ...rest,
        hasCode: false,
        repos: [],
        step: 'name',
        // "No code after all" on the repo path: the guided questions take over
        ...(d.start === 'repo' ? { start: 'guided' as const } : {}),
        history: d.history.filter((s) => s !== 'connect'),
        answers: { ...d.answers, goals: cleanGoals(d.answers.goals, false) }
      }
    }
    case 'setAnswers':
      if (launching) return d
      return { ...d, answers: mergeAnswers(d.answers, a.patch, !!d.hasCode) }
    case 'applyPrefill': {
      if (launching) return d
      const p = prefill(d.hasCode ? d.scan : undefined, d.site)
      const patch: Partial<OnboardingAnswers> = {}
      for (const k of ['name', 'oneLiner', 'products', 'siteUrl'] as const) {
        const v = p[k]
        if (typeof v === 'string' && v && !d.answers[k].trim()) patch[k] = v
      }
      return Object.keys(patch).length ? { ...d, answers: mergeAnswers(d.answers, patch, !!d.hasCode) } : d
    }
    case 'toggleGoal': {
      if (launching || !GOALS.includes(a.goal)) return d
      if (GOAL_INFO[a.goal].codeOnly && !d.hasCode) return d
      const has = d.answers.goals.includes(a.goal)
      const goals = has ? d.answers.goals.filter((g) => g !== a.goal) : [...d.answers.goals, a.goal]
      return { ...d, answers: { ...d.answers, goals } }
    }
    case 'setRepos': {
      if (launching) return d
      const seen = new Set<string>()
      const repos = a.repos.filter((r) => r.kind === 'local' && r.path.startsWith('/') && !seen.has(r.path) && (seen.add(r.path), true)).slice(0, MAX_ONBOARDING_PATHS)
      return { ...d, repos: repos.map((r) => (r.existingRepoId ? { kind: 'local', path: r.path, existingRepoId: r.existingRepoId } : { kind: 'local', path: r.path })) }
    }
    case 'setGithub': {
      if (launching) return d
      if (!a.github) {
        const { github: _g, ...rest } = d
        void _g
        return rest
      }
      const g: DraftGithub = { parentDir: a.github.parentDir }
      if (a.github.fullName) g.fullName = a.github.fullName
      if (a.github.url) g.url = withoutUserinfo(a.github.url)
      return { ...d, github: g }
    }
    case 'setScan': {
      if (launching) return d
      if (!a.scan) {
        const { scan: _s, ...rest } = d
        void _s
        return rest
      }
      return { ...d, scan: a.scan }
    }
    case 'setSite': {
      if (launching) return d
      if (!a.site) {
        const { site: _s, ...rest } = d
        void _s
        return rest
      }
      return { ...d, site: a.site }
    }
    case 'setContentWants':
      if (launching) return d
      return { ...d, content: { ...d.content, wants: a.wants } }
    case 'setProvider': {
      if (launching || d.content.provider === a.provider) return d
      // a stash belongs to one provider's key: switching provider drops the handle (the caller forgets it in main)
      return { ...d, content: { wants: d.content.wants, provider: a.provider, keySource: null, vibizInterest: d.content.vibizInterest } }
    }
    case 'useSharedKey':
      if (launching) return d
      return { ...d, content: { wants: d.content.wants, provider: a.provider, keySource: 'shared', vibizInterest: d.content.vibizInterest } }
    case 'keyChecked': {
      if (launching) return d
      const base = { wants: d.content.wants, provider: a.provider, vibizInterest: d.content.vibizInterest }
      const stashId = cleanStash(a.result.stashId)
      const last4 = cleanLast4(a.result.last4)
      if (a.result.status === 'invalid' || !stashId) return { ...d, content: { ...base, keySource: null } }
      const kept = { ...base, stashId, ...(last4 ? { last4 } : {}) }
      return { ...d, content: { ...kept, keySource: a.result.status === 'valid' ? 'stash' : null } }
    }
    case 'keyUseAnyway':
      if (launching || !d.content.stashId) return d
      return { ...d, content: { ...d.content, keySource: 'stash' } }
    case 'keyForget': {
      if (launching) return d
      const { stashId: _id, last4: _l, ...rest } = d.content
      void _id
      void _l
      return { ...d, content: { ...rest, keySource: rest.keySource === 'stash' ? null : rest.keySource } }
    }
    case 'setVibizInterest':
      return { ...d, content: { ...d.content, vibizInterest: a.on } }
    case 'setEnableFlags':
      if (launching) return d
      return { ...d, enableFlags: a.on }
    case 'templatePlan': {
      if (launching || !OnboardingPlanSchema.safeParse(a.plan).success) return d
      if (!d.plan) return withPlan(d, a.plan, 'template', false, a.inputsHash)
      if (d.plan.inputsHash === a.inputsHash || d.plan.edited) return d
      return withPlan(d, a.plan, 'template', false, a.inputsHash)
    }
    case 'editPlan': {
      if (launching || !d.plan || !OnboardingPlanSchema.safeParse(a.plan).success) return d
      return { ...d, plan: { ...d.plan, value: a.plan, edited: true } }
    }
    case 'useOfferedPlan':
    case 'rebuildPlan': {
      if (launching || !OnboardingPlanSchema.safeParse(a.plan).success) return d
      return withPlan(d, a.plan, a.type === 'useOfferedPlan' ? 'agent' : 'template', false, a.inputsHash)
    }
    case 'keepPlan':
      if (launching || !d.plan) return d
      return { ...d, plan: { ...d.plan, inputsHash: a.inputsHash } }
    case 'launchStarted': {
      if (!HANDLE_RE.test(a.journalId)) return d
      if (d.step === 'plan') return { ...forward(d, 'launching'), journalId: a.journalId }
      if (d.step === 'launching' || d.step === 'failed') return { ...d, step: 'launching', journalId: a.journalId }
      return d
    }
    case 'launchFailed':
      if (d.step !== 'launching' && d.step !== 'failed') return d
      return { ...d, step: 'failed', ...(a.journalId && HANDLE_RE.test(a.journalId) ? { journalId: a.journalId } : {}) }
    case 'launchDone':
      if (d.step !== 'launching' && d.step !== 'failed') return d
      return { ...d, step: 'ready', ...(a.journalId && HANDLE_RE.test(a.journalId) ? { journalId: a.journalId } : {}) }
    case 'launchResumed':
      return d.step === 'failed' ? { ...d, step: 'launching' } : d
    case 'resumeJournal': {
      if (!HANDLE_RE.test(a.journalId)) return d
      const name = d.answers.name.trim() ? d.answers.name : (a.name ?? '').slice(0, 80)
      return { ...d, journalId: a.journalId, step: a.status === 'running' ? 'launching' : 'failed', answers: { ...d.answers, name } }
    }
    case 'setMode':
      return d.mode === a.mode ? d : { ...d, mode: a.mode }
  }
}

// ---------- the agent plan (§6.2 step 3) ----------

export interface AgentPlanArrival {
  draft: OnboardingDraft
  /** Set when the founder already edited: show "Claude tailored a plan for you · [Use it] [Keep mine]". */
  offer: OnboardingPlan | null
  /** The plan was made for answers that have since changed: ignored. */
  stale: boolean
}

/**
 * A tailored plan arrived for `requestHash`. If the answers changed since the request it is ignored; otherwise it
 * replaces an unedited plan (`swap`), or is offered next to an edited one.
 */
export function receiveAgentPlan(d: OnboardingDraft, plan: OnboardingPlan, requestHash: string, ctx: PlanInputContext = {}): AgentPlanArrival {
  if (isLaunchStep(d.step) || requestHash !== draftInputsHash(d, ctx) || !OnboardingPlanSchema.safeParse(plan).success) return { draft: d, offer: null, stale: true }
  const edited = !!d.plan?.edited
  const merge = applyAgentPlan(d.plan?.value, plan, edited)
  if (merge.action === 'offer') return { draft: d, offer: merge.offered, stale: false }
  if (merge.action === 'same') return { draft: d.plan ? { ...d, plan: { ...d.plan, source: 'agent', inputsHash: requestHash } } : d, offer: null, stale: false }
  return { draft: withPlan(d, merge.plan, 'agent', false, requestHash), offer: null, stale: false }
}

/**
 * A typed clone link without its `user:token@` part: the draft lives in localStorage, so a pasted credential must
 * never land there (`https://me:ghp_x@github.com/a/b` → `https://github.com/a/b`; `git@github.com:a/b` keeps its user).
 */
export function withoutUserinfo(url: string): string {
  // http(s): no user part is ever needed; other schemes (ssh://git@…) keep the user and lose only a password
  if (/^https?:\/\//i.test(url)) return url.replace(/^(https?:\/\/)[^/?#@]*@/i, '$1')
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#@:]*):[^/?#@]*@/, '$1$2@')
}
