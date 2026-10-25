/**
 * The onboarding launch transaction (docs/ONBOARDING.md §7): preflight, the 11 journaled steps, Retry (resume at the
 * failed step), "Continue without this" (soft steps), Discard (compensations, then archive) and Start (§7.5).
 *
 * Every write goes through the service layer the IPC handlers wrap (CompanyStore, the departments actions, the
 * schedules create path, the marketplace install, addRepoPaths, the key namespaces, the passport writer), injected as
 * `LaunchDeps`, so every guard, company check and approval still applies. Rules kept here:
 *
 * - Company isolation: after step 2 every write carries the journal's companyId, never one from the renderer, and
 *   never Personal.
 * - Idempotent resume: each created item is recorded in the journal right after it is made (in the same db
 *   transaction when the write is a db write), and a step re-run skips what its journal entry already holds.
 * - Keys: the value leaves the stash only inside the keys step and goes straight to the company namespace; the journal,
 *   progress events, errors and logs only ever see its name.
 * - One launch (or skip / discard / start) at a time per draft.
 *
 * No Electron imports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { departmentsEnabled, DEPARTMENT_LIMITS, DEPARTMENT_PRESETS, PERSONAL_COMPANY_ID, type BoardSettings, type BoardTask, type CompanyAgent, type CompanyAgentSaveInput, type CompanyCreateInput, type CompanyPassport, type CompanyTaskInput, type Department, type DepartmentPresetKey, type DepartmentSaveInput } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import {
  BUNDLED_WORKFLOW_IDS,
  CADENCES,
  LAUNCH_STEPS,
  LAUNCH_STEP_LABELS,
  LaunchInputSchema,
  PLAN_ADAPTERS,
  SOFT_LAUNCH_STEPS,
  VIBE_INFO,
  WORKFLOW_KEY_NAMES,
  WORKFLOW_KEYS,
  workflowsForKeys,
  type BundledWorkflowId,
  type CloneProgressEvent,
  type LaunchCreated,
  type LaunchInput,
  type LaunchResult,
  type LaunchStepName,
  type OnboardingAvailable,
  type OnboardingPlan,
  type PlanAdapter,
  type PlanInput,
  type ProgressEvent,
  type SoftLaunchStep,
  type WorkflowKeyName
} from '../../shared/onboarding'
import { briefForPlan } from '../../shared/onboardingBrief'
import { finalizePlan, scheduleCostly, validatePlan, type ScreenFn } from '../../shared/onboardingPlan'
import { personaNamesElsewhere, pickPersona, type AgentPersona } from '../../shared/personas'
import type { AgentProfile, ExperimentalFlags, Repo, Schedule, ScheduleInput, Settings } from '../../shared/types'
import type { CompanyStore } from '../company'
import { ensureDefaultProfile } from '../db/seed'
import type { Store } from '../db/store'
import type { CloneJob, CloneProgress, CloneSource } from './github'
import { journalMeta, JournalStore, stepOf, type StoredJournal } from './journal'
import type { KeyStash } from './keys'
import { seedPassport, type PassportWriter } from './passportSeed'

// ---------- dependencies ----------

export interface LaunchDeps {
  store: Store
  company: CompanyStore
  journal: JournalStore
  stash: KeyStash
  settings(): Settings
  updateSettings(patch: Partial<Settings>): Settings
  /** The passport writer; null when the vault could not be opened. */
  memory(): PassportWriter | null
  /** handlers/company.ts departmentActions (gated, with department notes). */
  departments: {
    createPresets(companyId: string, keys?: DepartmentPresetKey[]): Department[]
    save(input: DepartmentSaveInput): Department
    saveAgent(input: CompanyAgentSaveInput): CompanyAgent
  }
  /** handlers/company.ts createTaskGuarded. */
  createTask(task: CompanyTaskInput): BoardTask
  /** handlers/repos.ts addRepoPaths. */
  addRepoPaths(paths: string[], companyId: string): { all: Repo[]; created: Repo[] }
  /** onboarding/github.ts clone. */
  clone(src: CloneSource, parentDir: string, onProgress: (p: CloneProgress) => void, opts: { createParent: boolean }): CloneJob
  /** `~/Projects`: created on demand when it is the clone folder. */
  defaultCloneDir: string
  keys: {
    /** Saves a company key (KeyNamespaces.set with the company space). */
    set(companyId: string, name: string, value: string): void
    remove(companyId: string, name: string): void
    /** A Shared key with this name exists. */
    sharedHas(name: WorkflowKeyName): boolean
  }
  /** handlers/marketplace.ts installFromMarketplace (bundled source) → the workflow id. */
  installWorkflow(id: BundledWorkflowId, companyId: string): Promise<string>
  /** workflows:remove (assertNotBacking + store + author permissions). */
  removeWorkflow(id: string): void
  /** handlers/schedules.ts createSchedule / removeSchedule / setScheduleEnabled. */
  createSchedule(input: ScheduleInput & { companyId: string }): Schedule
  removeSchedule(id: string): void
  setScheduleEnabled(id: string, enabled: boolean): void
  /** Installed non-shell adapters (providers:list). */
  profileAdapters(): PlanAdapter[]
  /** onboarding:progress / onboarding:cloneProgress. */
  emitProgress(e: ProgressEvent): void
  emitClone(e: CloneProgressEvent): void
  /** data:changed for these domains (and a status refresh). */
  changed(domains: ('company' | 'repos' | 'departments' | 'tasks' | 'schedules' | 'workflows' | 'secrets')[]): void
  /** Wake the board after Start (dispatcher pump). */
  pump?(companyId: string): void
  /** vault.redact: masks stored secret values in user-facing text. */
  redact?(text: string): string
  /** validatePlan's secret screen (default: none beyond the built-in URL/path checks). */
  screen?: ScreenFn
  log?: { warn(message: string, meta?: Record<string, unknown>): void }
  /** Test seam: runs right before a step's body (throw to inject a failure). */
  beforeStep?(step: LaunchStepName, journal: StoredJournal): void | Promise<void>
}

export const ALL_DOMAINS = ['company', 'repos', 'departments', 'tasks', 'schedules', 'workflows', 'secrets'] as const
const HARD_STEPS: readonly LaunchStepName[] = ['flags', 'company', 'departments', 'agents', 'tasks', 'finish']
/** The same 8 cool token hues as defaultCompanyColor (db/companyMigration.ts); a new company takes the first unused one. */
export const COMPANY_PALETTE = ['--accent', '--status-success', '--provider-codex', '--series-5', '--status-scheduled', '--series-2', '--status-running', '--status-idle'].map((t) => `var(${t})`)
export const START_MAX_IN_FLIGHT = 2
const DISCARDED_SUFFIX = ' (discarded)'
const isSoft = (s: LaunchStepName): s is SoftLaunchStep => (SOFT_LAUNCH_STEPS as readonly string[]).includes(s)

// ---------- helpers ----------

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** Workflow ids a task names (templates write "Run Landing hero images (landing-hero-images)"). */
export function workflowsNamed(text: string): BundledWorkflowId[] {
  return BUNDLED_WORKFLOW_IDS.filter((id) => new RegExp(`(^|[^a-z0-9-])${id}($|[^a-z0-9-])`).test(text))
}

/** Tasks in dependency order (plan order kept among ready tasks); dependencies outside the list are ignored. */
export function topoTasks<T extends { ref: string; dependsOn: string[] }>(tasks: T[]): T[] {
  const refs = new Set(tasks.map((t) => t.ref))
  const done = new Set<string>()
  const out: T[] = []
  let left = [...tasks]
  while (left.length) {
    const ready = left.filter((t) => t.dependsOn.every((d) => !refs.has(d) || done.has(d)))
    const batch = ready.length ? ready : [left[0]]
    for (const t of batch) {
      out.push(t)
      done.add(t.ref)
    }
    left = left.filter((t) => !batch.includes(t))
  }
  return out
}

/** The first palette colour no active company uses (else the one after the last used). */
export function nextCompanyColor(companies: Pick<CompanyPassport, 'color' | 'system' | 'archivedAt'>[]): string {
  const used = companies.filter((c) => c.system !== 'personal' && !c.archivedAt).map((c) => c.color)
  return COMPANY_PALETTE.find((c) => !used.includes(c)) ?? COMPANY_PALETTE[used.length % COMPANY_PALETTE.length]
}

/** How much of a founder brief the company profile's context keeps (it rides in every spawn's Passport block). */
export const BRIEF_CONTEXT_CHARS = 1500

/** The company profile fields from the answers, scan, site and brief (§7.2 step 2). */
export function companyProfile(input: LaunchInput): Omit<CompanyCreateInput, 'name' | 'color' | 'repoIds'> {
  const a = input.answers
  const voice = [a.voiceVibe ? `Sounds ${VIBE_INFO[a.voiceVibe].voice}.` : '', a.voiceText.trim(), a.avoid.trim() ? `Avoid: ${a.avoid.trim()}` : ''].filter(Boolean).join('\n')
  const goalLabel: Record<string, string> = { customers: 'Get first customers', website: 'Launch a website', social: 'Post on social', ads: 'Run ads', seo: 'Get found on Google', ship: 'Fix bugs & ship features', support: 'Customer support' }
  const goals = a.goals.map((g) => (g === 'other' ? a.goalOther.trim() : goalLabel[g])).filter(Boolean).map((g) => `- ${g}`).join('\n')
  const context = [
    input.scan?.stack.length ? `Stack: ${input.scan.stack.join(', ')}` : '',
    a.siteUrl.trim() || input.site?.url ? `Website: ${a.siteUrl.trim() || input.site?.url}` : '',
    input.site?.title || input.site?.ogTitle ? `Website title: ${input.site.ogTitle || input.site.title}` : '',
    input.site?.description || input.site?.ogDescription ? `Website says: ${input.site.ogDescription || input.site.description}` : '',
    a.instagram.trim() ? `Instagram: ${a.instagram.trim()}` : '',
    // "From a prompt": the start of the founder's brief (the Passport keeps all of it, as a note)
    input.brief?.trim() ? `Founder brief: ${clipText(input.brief.trim().replace(/\s+/g, ' '), BRIEF_CONTEXT_CHARS)}` : ''
  ].filter(Boolean).join('\n')
  return {
    mission: a.oneLiner.trim(),
    products: a.products.trim(),
    audience: a.audience.trim(),
    brandVoice: voice,
    goals,
    context,
    constraints: 'Never post, send, spend, deploy or sign up for anything without approval.'
  }
}

/** A preset department's charter edited in the plan, clipped to the store's 600-character budget. */
function clipCharter(c: { does: string; doesNot: string }): { does: string; doesNot: string } {
  const max = DEPARTMENT_LIMITS.charter
  if (c.does.length + c.doesNot.length <= max) return c
  const half = Math.floor(max / 2)
  const does = clipText(c.does, Math.max(half, max - Math.min(c.doesNot.length, half)))
  return { does, doesNot: clipText(c.doesNot, max - does.length) }
}

interface Prepared {
  input: LaunchInput
  plan: OnboardingPlan
  available: OnboardingAvailable
}

interface Effective {
  departments: OnboardingPlan['departments']
  agents: OnboardingPlan['agents']
  tasks: OnboardingPlan['tasks']
  schedules: OnboardingPlan['schedules']
}

// ---------- the service ----------

export class LaunchService {
  private readonly locks = new Set<string>()
  private readonly clones = new Map<string, CloneJob>()

  constructor(private readonly d: LaunchDeps) {}

  private redact(s: string): string {
    return this.d.redact ? this.d.redact(s) : s
  }

  /** One launch / skip / discard / start at a time per draft. */
  private async locked<T>(draftId: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(draftId)) throw new HiveError('conflict', 'Setup is already running for this business. Wait for it to finish.')
    this.locks.add(draftId)
    try {
      return await fn()
    } finally {
      this.locks.delete(draftId)
    }
  }

  isLocked(draftId: string): boolean {
    return this.locks.has(draftId)
  }

  private result(j: StoredJournal): LaunchResult {
    const m = journalMeta(j)
    return { journalId: m.id, companyId: m.companyId, status: m.status, steps: m.steps, scheduleRefs: m.scheduleRefs }
  }

  private journalOr404(journalId: string): StoredJournal {
    const j = this.d.journal.get(journalId)
    if (!j) throw new HiveError('not_found', 'That setup no longer exists. Start again from + New company.')
    return j
  }

  /** §7.6: the journal's own company, never Personal and never one from the renderer. */
  private own(j: StoredJournal): string {
    const id = j.companyId
    if (!id || id === PERSONAL_COMPANY_ID) throw new HiveError('forbidden', 'This setup has no company of its own')
    return id
  }

  // ---------- preflight (§7.1) ----------

  /** Re-validates everything before any write. Throws (nothing written) on a refusal. */
  preflight(raw: LaunchInput, j: StoredJournal | null): Prepared {
    const input = LaunchInputSchema.parse(raw)
    if (!input.answers.name.trim()) throw new HiveError('bad_request', 'Give your business a name')

    // local folders: real, folders, and owned by nobody, Personal or (on resume) this very company
    const foreign: string[] = []
    for (const r of input.repos) {
      let real: string
      try {
        real = fs.realpathSync(r.path)
        if (!fs.statSync(real).isDirectory()) throw new Error('not a folder')
      } catch {
        throw new HiveError('bad_request', `Can't find the folder ${path.basename(r.path) || r.path}. Remove it or choose it again.`)
      }
      const existing = this.d.store.getRepoByPath(real)
      if (!existing) continue
      const owner = this.d.company.companyForRepo(existing.id)
      if (owner.system !== 'personal' && owner.id !== j?.companyId) foreign.push(`${existing.name} (${owner.name})`)
    }
    if (foreign.length) throw new HiveError('forbidden', `${foreign.length === 1 ? 'This folder belongs' : 'These folders belong'} to another company: ${foreign.join(', ')}. Remove ${foreign.length === 1 ? 'it' : 'them'} to continue.`)

    // a key checked in this flow must still be in the stash (unless the keys step already saved or skipped it)
    const keysStep = j ? stepOf(j, 'keys') : null
    const keySettled = !!keysStep && (keysStep.status === 'done' || keysStep.status === 'skipped')
    // A fresh launch refuses before any write. On resume (the window was closed or the app quit mid-launch, which wipes
    // the stash) the founder can't paste from the Launch step: the soft keys step fails instead, with "Continue
    // without this", and nothing that needs the key is made.
    if (input.key && !keySettled && !j) {
      const meta = this.d.stash.peek(input.key.stashId)
      if (!meta || meta.name !== input.key.name) throw new HiveError('bad_request', 'Paste your key again. For your safety we don’t keep keys until launch.')
    }

    // main recomputes what is available; the renderer's claims beyond it are ignored (§4)
    const present: Partial<Record<WorkflowKeyName, boolean>> = {}
    for (const k of WORKFLOW_KEY_NAMES) present[k] = this.d.keys.sharedHas(k)
    // a key whose step was skipped ("Continue without this") was never saved: its workflows can't be planned
    if (input.key && keysStep?.status !== 'skipped') present[input.key.name] = true
    const flags = this.d.settings().experimental
    const available: OnboardingAvailable = {
      workflows: workflowsForKeys(present),
      profileAdapters: this.d.profileAdapters().filter((a) => (PLAN_ADAPTERS as readonly string[]).includes(a)),
      hasCode: input.hasCode && (input.repos.length > 0 || !!input.github),
      departmentsOn: input.enableFlags || departmentsEnabled(flags),
      personasElsewhere: [...this.personasElsewhere(null)]
    }
    const planInput: PlanInput = {
      hasCode: available.hasCode,
      answers: input.answers,
      ...(input.scan ? { scan: input.scan } : {}),
      ...(input.site ? { site: input.site } : {}),
      keys: { fal: !!present.FAL_KEY, openai: !!present.OPENAI_API_KEY },
      departmentsOn: available.departmentsOn,
      tz: input.tz,
      ...(briefForPlan(input.brief) ? { brief: briefForPlan(input.brief) } : {})
    }
    const siteUrl = input.answers.siteUrl || input.site?.url || null
    const checked = validatePlan(input.plan, { available, siteUrl, screen: this.d.screen, input: planInput })
    const plan = finalizePlan(checked.plan, { available })
    return { input, plan, available }
  }

  // ---------- launch (§7.2) ----------

  async launch(req: { journalId?: string; draftId: string; input: LaunchInput }): Promise<LaunchResult> {
    return this.locked(req.draftId, async () => {
      let j: StoredJournal | null = null
      if (req.journalId) {
        j = this.journalOr404(req.journalId)
        if (j.draftId !== req.draftId) throw new HiveError('forbidden', 'That setup belongs to another draft')
      } else {
        // a second click (or a lost response) must never make a second company: reuse the draft's journal
        const prev = this.d.journal.forDraft(req.draftId)
        if (prev && prev.status !== 'discarded') j = prev
      }
      if (j?.status === 'done') return this.result(j)
      if (j?.status === 'discarded') throw new HiveError('conflict', 'This setup was discarded. Start again from + New company.')
      const prep = this.preflight(req.input, j)
      if (!j) j = this.d.journal.create({ draftId: req.draftId, mode: prep.input.mode })
      this.d.journal.saveInput(j.id, prep.input)
      return this.run(j, prep)
    })
  }

  /** "Continue without this" on a failed soft step: marks it skipped, then resumes with the saved input. */
  async skipStep(req: { journalId: string; step: SoftLaunchStep }): Promise<LaunchResult> {
    const j0 = this.journalOr404(req.journalId)
    return this.locked(j0.draftId, async () => {
      const j = this.journalOr404(req.journalId)
      if (!isSoft(req.step)) throw new HiveError('bad_request', 'Only Code, Keys, Passport, Workflows and Schedules can be skipped')
      if (j.status !== 'failed') throw new HiveError('conflict', j.status === 'done' ? 'Setup already finished' : 'Nothing to skip right now')
      const s = stepOf(j, req.step)
      if (s.status !== 'failed') throw new HiveError('conflict', `${LAUNCH_STEP_LABELS[req.step]} has not failed`)
      s.status = 'skipped'
      delete s.error
      this.d.journal.save(j)
      this.emit(j, req.step, 'skipped')
      const parsed = LaunchInputSchema.safeParse(this.d.journal.loadInput(j.id))
      if (!parsed.success) return this.result(j)
      let prep: Prepared
      try {
        prep = this.preflight(parsed.data, j)
      } catch (e) {
        // the remaining steps can't run as saved (a key to paste again, a folder gone): the renderer retries with input
        this.d.log?.warn('onboarding: resume after skip refused', { journalId: j.id, error: this.redact(errMessage(e)) })
        return this.result(j)
      }
      return this.run(j, prep)
    })
  }

  private emit(j: StoredJournal, step: LaunchStepName, status: ProgressEvent['status'], extra: { detail?: string; error?: string } = {}): void {
    try {
      this.d.emitProgress({ journalId: j.id, step, status, label: LAUNCH_STEP_LABELS[step], ...extra })
    } catch {
      /* a closed window never fails the launch */
    }
  }

  /** Runs every step not yet done or skipped, in order; the first failure stops the run (status failed). */
  private async run(j: StoredJournal, prep: Prepared): Promise<LaunchResult> {
    j.status = 'running'
    this.d.journal.save(j)
    for (const name of LAUNCH_STEPS) {
      const s = stepOf(j, name)
      if (s.status === 'done' || s.status === 'skipped') continue
      s.status = 'running'
      delete s.error
      this.d.journal.save(j)
      this.emit(j, name, 'running')
      try {
        await this.d.beforeStep?.(name, j)
        const outcome = await this.step(name, j, prep)
        s.status = outcome === 'n/a' ? 'skipped' : 'done'
        if (name === 'finish') j.status = 'done'
        this.d.journal.save(j)
        this.emit(j, name, s.status === 'skipped' ? 'skipped' : 'done')
      } catch (e) {
        const error = clipText(this.redact(errMessage(e)) || 'Something went wrong', 500)
        s.status = 'failed'
        s.error = error
        j.status = 'failed'
        this.d.journal.save(j)
        this.emit(j, name, 'failed', { error })
        this.d.log?.warn('onboarding: launch step failed', { journalId: j.id, step: name, hard: HARD_STEPS.includes(name), error })
        // whatever was created so far is real: let the app show it
        this.d.changed([...ALL_DOMAINS])
        return this.result(j)
      }
    }
    return this.result(j)
  }

  /** Records a created item (and runs its db write) in one transaction, so a crash never loses track of it. */
  private record<T>(j: StoredJournal, step: LaunchStepName, write: () => T, created: (v: T) => LaunchCreated | null, after?: (v: T) => void): T {
    // a rolled-back write must not stay in the in-memory journal either (the failure path saves it). Restored in place:
    // run() holds the step objects.
    const created0 = j.steps.map((st) => st.created.length)
    const refs0 = JSON.stringify(j.refs)
    const sched0 = j.scheduleRefs.length
    const company0 = { id: j.companyId, name: j.companyName }
    try {
      return this.d.store.db.transaction(() => {
        const v = write()
        const c = created(v)
        if (c) stepOf(j, step).created.push(c)
        after?.(v)
        this.d.journal.save(j)
        return v
      })()
    } catch (e) {
      j.steps.forEach((st, i) => void (st.created.length = created0[i]))
      const refs = JSON.parse(refs0) as StoredJournal['refs']
      for (const k of Object.keys(j.refs) as (keyof StoredJournal['refs'])[]) delete j.refs[k]
      Object.assign(j.refs, refs)
      j.scheduleRefs.length = sched0
      j.companyId = company0.id
      if (company0.name === undefined) delete j.companyName
      else j.companyName = company0.name
      throw e
    }
  }

  private departmentsOn(): boolean {
    return departmentsEnabled(this.d.settings().experimental)
  }

  /** The included plan items as they apply now (after a skipped Code step, repo work becomes workspace work). */
  private effective(j: StoredJournal, plan: OnboardingPlan): Effective {
    const noRepo = j.refs.repoIds.length === 0
    const departments = plan.departments.filter((d) => d.include)
    const deptKeys = new Set(departments.map((d) => d.key))
    const agents = plan.agents.filter((a) => a.include)
    const agentRefs = new Set(agents.map((a) => a.ref))
    const tasks = plan.tasks
      .filter((t) => t.include)
      .map((t) => ({ ...t, where: noRepo ? ('workspace' as const) : t.where, agentRef: t.agentRef && agentRefs.has(t.agentRef) ? t.agentRef : null, departmentKey: t.departmentKey && deptKeys.has(t.departmentKey) ? t.departmentKey : null }))
    // a workflow schedule with a repository input needs a repo to run in: without code it goes
    const schedules = plan.schedules.filter((s) => s.include && !(noRepo && s.target.kind === 'workflow' && needsRepo(s.target.workflow)))
    // §7.2 step 3: without code the Development department goes when nothing is left in it
    const used = (k: string) => agents.some((a) => a.departmentKey === k) || tasks.some((t) => t.departmentKey === k) || schedules.some((s) => s.departmentKey === k)
    return { departments: noRepo ? departments.filter((d) => d.key !== 'development' || used('development')) : departments, agents, tasks, schedules }
  }

  private async step(name: LaunchStepName, j: StoredJournal, prep: Prepared): Promise<'ok' | 'n/a'> {
    switch (name) {
      case 'flags':
        return this.stepFlags(j, prep)
      case 'company':
        return this.stepCompany(j, prep)
      case 'code':
        return this.stepCode(j, prep)
      case 'keys':
        return this.stepKeys(j, prep)
      case 'passport':
        return this.stepPassport(j, prep)
      case 'workflows':
        return this.stepWorkflows(j, prep)
      case 'departments':
        return this.stepDepartments(j, prep)
      case 'agents':
        return this.stepAgents(j, prep)
      case 'tasks':
        return this.stepTasks(j, prep)
      case 'schedules':
        return this.stepSchedules(j, prep)
      case 'finish':
        return this.stepFinish(j, prep)
    }
  }

  // 1. flags
  private stepFlags(j: StoredJournal, prep: Prepared): 'ok' | 'n/a' {
    if (!prep.input.enableFlags) return 'n/a'
    const cur: ExperimentalFlags = this.d.settings().experimental ?? {}
    if (cur.companies && cur.departments && cur.vault) return j.prevFlags ? 'ok' : 'n/a'
    if (!j.prevFlags) {
      // recorded before the change, so Discard can always restore them
      // explicit booleans: restoring merges flag by flag, so an absent flag would stay on
      j.prevFlags = { ...cur, companies: !!cur.companies, departments: !!cur.departments, vault: !!cur.vault }
      stepOf(j, 'flags').created.push({ kind: 'flags', id: 'experimental' })
      this.d.journal.save(j)
    }
    this.d.updateSettings({ experimental: { ...cur, companies: true, departments: true, vault: true } as ExperimentalFlags })
    return 'ok'
  }

  // 2. company (hard)
  private stepCompany(j: StoredJournal, prep: Prepared): 'ok' {
    if (j.companyId) {
      this.own(j)
      this.d.company.passport(j.companyId)
      return 'ok'
    }
    const name = prep.input.answers.name.trim()
    const profile = Object.fromEntries(Object.entries(companyProfile(prep.input)).map(([k, v]) => [k, this.redact(v ?? '')]))
    const color = nextCompanyColor(this.d.company.listPassports())
    this.record(
      j,
      'company',
      () => this.d.company.create({ name, color, repoIds: [], ...profile }),
      (p) => ({ kind: 'company', id: p.id }),
      (p) => {
        if (p.id === PERSONAL_COMPANY_ID) throw new HiveError('internal', 'A business can’t be created as Personal')
        j.companyId = p.id
        j.companyName = p.name
        // pm-review E12: the Instagram the founder named during setup is this company's account (drafts only), so
        // Connections shows it connected and the Setup chip counts it
        const ig = prep.input.answers.instagram.trim()
        if (ig) {
          try { this.d.company.update(p.id, { account: { kind: 'instagram', handle: ig.startsWith('@') ? ig : `@${ig}` } }) } catch { /* a handle the schema refuses stays a profile line only */ }
        }
      }
    )
    return 'ok'
  }

  // 3. code (soft)
  private async stepCode(j: StoredJournal, prep: Prepared): Promise<'ok' | 'n/a'> {
    const companyId = this.own(j)
    const { input } = prep
    if (!input.hasCode || (!input.repos.length && !input.github)) return 'n/a'
    const attach = (realPath: string) => {
      const existing = this.d.store.getRepoByPath(realPath)
      if (existing) {
        if (j.refs.repoIds.includes(existing.id)) return
        const owner = this.d.company.companyForRepo(existing.id)
        if (owner.id === companyId) {
          j.refs.repoIds.push(existing.id)
          this.d.journal.save(j)
          return
        }
        if (owner.system !== 'personal') throw new HiveError('forbidden', `${existing.name} belongs to ${owner.name}. Remove it to continue.`)
        this.record(j, 'code', () => this.d.company.assignRepo(existing.id, companyId), () => ({ kind: 'repoMove', id: existing.id }), () => void j.refs.repoIds.push(existing.id))
        return
      }
      this.record(
        j,
        'code',
        () => this.d.addRepoPaths([realPath], companyId),
        (r) => (r.created[0] ? { kind: 'repo', id: r.created[0].id } : null),
        (r) => {
          const repo = r.all[0]
          if (repo && !j.refs.repoIds.includes(repo.id)) j.refs.repoIds.push(repo.id)
        }
      )
    }
    for (const r of input.repos) {
      let real: string
      try {
        real = fs.realpathSync(r.path)
      } catch {
        throw new HiveError('bad_request', `Can't find the folder ${path.basename(r.path)}`)
      }
      attach(real)
    }
    if (input.github) {
      const g = input.github
      const src: CloneSource = g.fullName ? { fullName: g.fullName } : { url: g.url! }
      const label = g.fullName ?? g.url!
      this.emit(j, 'code', 'running', { detail: `Cloning ${label}…` })
      const job = this.d.clone(src, g.parentDir, (p) => {
        try {
          this.d.emitClone({ journalId: j.id, fullName: label, percent: p.percent, line: this.redact(p.line) })
        } catch {
          /* closed window */
        }
      }, { createParent: path.resolve(g.parentDir) === path.resolve(this.d.defaultCloneDir) })
      this.clones.set(j.id, job)
      let res: Awaited<CloneJob['promise']>
      try {
        res = await job.promise
      } finally {
        this.clones.delete(j.id)
      }
      const step = stepOf(j, 'code')
      if (!res.reused && !step.created.some((c) => c.kind === 'clone' && c.id === res.path)) {
        step.created.push({ kind: 'clone', id: res.path })
        this.d.journal.save(j)
      }
      attach(fs.realpathSync(res.path))
    }
    return 'ok'
  }

  // 4. keys (soft): the value goes from the stash straight to the company namespace
  private stepKeys(j: StoredJournal, prep: Prepared): 'ok' | 'n/a' {
    const companyId = this.own(j)
    const want = prep.input.key
    if (!want) return 'n/a'
    if (stepOf(j, 'keys').created.some((c) => c.kind === 'secret' && c.id === want.name)) return 'ok'
    const taken = this.d.stash.take(want.stashId)
    if (!taken || taken.name !== want.name) throw new HiveError('bad_request', `Your ${want.name} was cleared when Principia closed (keys are never kept until launch). Continue without it and add it later under Keys.`)
    try {
      this.record(j, 'keys', () => this.d.keys.set(companyId, taken.name, taken.value), () => ({ kind: 'secret', id: taken.name }))
    } catch {
      // never let a storage error carry the value anywhere
      throw new HiveError('internal', `Couldn't save ${want.name} for this business. Add it later under Keys.`)
    } finally {
      taken.value = ''
    }
    return 'ok'
  }

  // 5. passport (soft; vault on)
  private async stepPassport(j: StoredJournal, prep: Prepared): Promise<'ok' | 'n/a'> {
    const companyId = this.own(j)
    const memory = this.d.memory()
    if (!this.d.settings().experimental?.vault || !memory) return 'n/a'
    const repoNames = j.refs.repoIds.map((id) => this.d.store.getRepo(id)?.name).filter((n): n is string => !!n)
    const res = await seedPassport(memory, companyId, {
      hubTitle: this.d.company.passport(companyId).name,
      answers: prep.input.answers,
      ...(prep.input.scan ? { scan: prep.input.scan } : {}),
      ...(prep.input.site ? { site: prep.input.site } : {}),
      ...(prep.input.brief?.trim() ? { brief: prep.input.brief } : {}),
      repoNames
    })
    const step = stepOf(j, 'passport')
    for (const p of res.created) if (!step.created.some((c) => c.kind === 'note' && c.id === p)) step.created.push({ kind: 'note', id: p })
    this.d.journal.save(j)
    return 'ok'
  }

  // 6. workflows (soft)
  private async stepWorkflows(j: StoredJournal, prep: Prepared): Promise<'ok' | 'n/a'> {
    const companyId = this.own(j)
    const eff = this.effective(j, prep.plan)
    const wanted = new Set<BundledWorkflowId>()
    for (const s of eff.schedules) if (s.target.kind === 'workflow') wanted.add(s.target.workflow)
    for (const t of eff.tasks) for (const w of workflowsNamed(`${t.title}\n${t.description}`)) wanted.add(w)
    const ids = [...wanted].filter((w) => prep.available.workflows.includes(w))
    if (!ids.length) return 'n/a'
    // a bundled workflow's agent nodes are remapped onto this Mac's profiles on import; with no agent CLI installed
    // there is none yet and validation fails ("agent profile ... no longer exists"). Make sure one exists first, the
    // same default the agents step seats (it runs once a CLI is signed in).
    this.profileFor('claude')
    for (const id of ids) {
      if (j.refs.workflows[id] && this.d.store.getWorkflow(j.refs.workflows[id])) continue
      const wfId = await this.d.installWorkflow(id, companyId)
      const wf = this.d.store.getWorkflow(wfId)
      if (!wf || (wf.companyId ?? PERSONAL_COMPANY_ID) !== companyId) throw new HiveError('internal', `${id} was not installed into this business`)
      this.record(j, 'workflows', () => wfId, (v) => ({ kind: 'workflow', id: v }), (v) => void (j.refs.workflows[id] = v))
    }
    return 'ok'
  }

  // 7. departments (hard; departments on)
  private stepDepartments(j: StoredJournal, prep: Prepared): 'ok' | 'n/a' {
    const companyId = this.own(j)
    if (!this.departmentsOn()) return 'n/a'
    const eff = this.effective(j, prep.plan)
    if (!eff.departments.length) return 'n/a'
    const missing = eff.departments.filter((d) => !j.refs.departments[d.key]).map((d) => d.key as DepartmentPresetKey)
    if (missing.length) {
      const before = new Set(this.d.company.departments.list(companyId, { includeArchived: true }).map((d) => d.key))
      this.record(
        j,
        'departments',
        () => this.d.departments.createPresets(companyId, missing),
        () => null,
        (list) => {
          for (const dep of list) {
            if (!missing.includes(dep.key as DepartmentPresetKey) || j.refs.departments[dep.key]) continue
            if (dep.companyId !== companyId) throw new HiveError('internal', 'Department created in another company')
            j.refs.departments[dep.key] = dep.id
            if (!before.has(dep.key)) stepOf(j, 'departments').created.push({ kind: 'department', id: dep.id })
          }
        }
      )
    }
    // renamed names or edited charters (save is idempotent: re-applying the same values changes nothing)
    for (const pd of eff.departments) {
      const id = j.refs.departments[pd.key]
      const preset = DEPARTMENT_PRESETS.find((p) => p.key === pd.key)
      const dep = id ? this.d.company.departments.get(id) : null
      if (!dep || !preset) continue
      const charter = pd.charter ? clipCharter(pd.charter) : null
      const nameChanged = pd.name.trim() && pd.name.trim() !== dep.name
      const charterChanged = charter && (charter.does !== dep.data.charter.does || charter.doesNot !== dep.data.charter.doesNot)
      if (!nameChanged && !charterChanged) continue
      this.d.departments.save({ id: dep.id, companyId, name: nameChanged ? clipText(pd.name.trim(), DEPARTMENT_LIMITS.name) : dep.name, ...(charterChanged ? { data: { charter: charter! } } : {}) })
    }
    return 'ok'
  }

  /** The profile an agent seat uses for an adapter: its default, else the first non-shell profile, else a new default. */
  private profileFor(adapter: PlanAdapter): AgentProfile {
    return this.d.store.defaultProfileFor(adapter) ?? this.d.store.listProfiles().find((p) => p.adapter !== 'shell') ?? ensureDefaultProfile(this.d.store, 'claude')
  }

  // 8. agents (hard; departments on). Created manual; Start raises the auto ones.
  private stepAgents(j: StoredJournal, prep: Prepared): 'ok' | 'n/a' {
    const companyId = this.own(j)
    if (!this.departmentsOn()) return 'n/a'
    const eff = this.effective(j, prep.plan)
    if (!eff.agents.length) return 'n/a'
    const personas = this.launchPersonas(companyId, prep, eff.agents)
    for (const a of eff.agents) {
      if (j.refs.agents[a.ref]) continue
      const profile = this.profileFor(a.adapter)
      const departmentId = j.refs.departments[a.departmentKey] ?? null
      const input: CompanyAgentSaveInput = {
        companyId,
        departmentId,
        kind: 'profile',
        refId: profile.id,
        name: clipText(a.name, 80),
        data: {
          instructions: this.redact(a.instructions),
          capabilities: this.redact(a.capabilities),
          autonomy: 'manual',
          defaultRepoId: a.role === 'developer' ? (j.refs.repoIds[0] ?? null) : null,
          persona: personas.get(a.ref)
        }
      }
      this.record(
        j,
        'agents',
        () => this.d.departments.saveAgent(input),
        (agent) => ({ kind: 'agent', id: agent.id }),
        (agent) => {
          j.refs.agents[a.ref] = agent.id
          if (a.auto && !j.refs.autoAgents.includes(agent.id)) j.refs.autoAgents.push(agent.id)
        }
      )
    }
    return 'ok'
  }

  /**
   * VOICE.md §4: the persona each plan agent launches with. The one the draft carried (what the user saw, renames
   * included) is kept; an agent whose draft had none is picked again with the real seed (companyId + ':' + ref).
   * Deterministic, so a resumed launch gives the same answer; names stay unique across the plan.
   */
  /** Names other companies' agents already have (never this one's): a new agent avoids them while any are free. */
  private personasElsewhere(companyId: string | null): Set<string> {
    try {
      const d = this.d.company.departments
      return personaNamesElsewhere(companyId, d.listAgents(), d.list(undefined, { includeArchived: true }))
    } catch {
      return new Set()
    }
  }
  private launchPersonas(companyId: string, prep: Prepared, agents: OnboardingPlan['agents']): Map<string, AgentPersona> {
    const drafted = new Set(prep.input.plan.agents.filter((a) => a.persona).map((a) => a.ref))
    const keep = (a: OnboardingPlan['agents'][number]) => !!a.persona && drafted.has(a.ref)
    const used = new Set(agents.filter(keep).map((a) => a.persona!.name.trim().toLowerCase()))
    const out = new Map<string, AgentPersona>()
    const avoid = this.personasElsewhere(companyId)
    for (const a of agents) {
      if (keep(a)) {
        out.set(a.ref, a.persona!)
        continue
      }
      const p = pickPersona({ departmentKey: a.departmentKey, role: a.role, used, avoid, seed: `${companyId}:${a.ref}` })
      used.add(p.name.toLowerCase())
      out.set(a.ref, p)
    }
    return out
  }

  // 9. tasks (hard): dependency order, refs mapped to ids, all To do
  private stepTasks(j: StoredJournal, prep: Prepared): 'ok' | 'n/a' {
    const companyId = this.own(j)
    const eff = this.effective(j, prep.plan)
    if (!eff.tasks.length) return 'n/a'
    const board = this.departmentsOn()
    for (const t of topoTasks(eff.tasks)) {
      if (j.refs.tasks[t.ref]) continue
      const agentId = board && t.agentRef ? (j.refs.agents[t.agentRef] ?? null) : null
      // an agent of one department takes only that department's tasks: file it where its agent works
      const agentDept = agentId ? this.d.company.departments.getAgent(agentId)?.departmentId ?? null : null
      const departmentId = board ? (agentDept ?? (t.departmentKey ? (j.refs.departments[t.departmentKey] ?? null) : null)) : null
      const task: CompanyTaskInput = {
        title: clipText(this.redact(t.title), 240),
        description: this.redact(t.description),
        companyId,
        repoId: t.where === 'repo' ? (j.refs.repoIds[0] ?? null) : null,
        status: 'todo',
        priority: t.priority as CompanyTaskInput['priority'],
        source: 'manual',
        sourceUrl: null,
        externalId: null,
        assigneeProfileId: null,
        parentId: null,
        dependencyIds: t.dependsOn.map((r) => j.refs.tasks[r]).filter((x): x is string => !!x),
        ...(board ? { departmentId, agentId } : {})
      }
      // a task that tells you to Run a paid workflow and has no planned agent is yours to press Run on: routing must not
      // hand it to a department's only agent, which Start may raise to auto with the company's image key in its env
      const paidRun = !agentId && paidWorkflowTask(`${t.title}\n${t.description}`)
      this.record(j, 'tasks', () => this.d.createTask(task), (created) => ({ kind: 'task', id: created.id }), (created) => {
        if (created.companyId !== companyId) throw new HiveError('internal', 'Task created in another company')
        j.refs.tasks[t.ref] = created.id
        if (paidRun && board && this.d.company.task(created.id).agentId) {
          this.d.company.assign(created.id, { agentId: null }, 'system', { by: 'rule', reason: 'Uses paid credits: it runs only when you press Run' })
        }
      })
    }
    return 'ok'
  }

  // 10. schedules (soft): all disabled
  private stepSchedules(j: StoredJournal, prep: Prepared): 'ok' | 'n/a' {
    const companyId = this.own(j)
    const eff = this.effective(j, prep.plan)
    if (!eff.schedules.length) return 'n/a'
    const board = this.departmentsOn()
    let made = 0
    for (const s of eff.schedules) {
      if (j.scheduleRefs.some((r) => r.ref === s.ref)) {
        made++
        continue
      }
      const when = { kind: 'cron' as const, cron: CADENCES[s.cadence], tz: prep.input.tz }
      let input: ScheduleInput & { companyId: string }
      if (s.target.kind === 'task') {
        const agentId = board ? j.refs.agents[s.target.agentRef] : undefined
        const agent = agentId ? this.d.company.departments.getAgent(agentId) : null
        if (!agent || agent.companyId !== companyId) continue // its agent was not created (departments off or excluded)
        const departmentId = (s.departmentKey ? j.refs.departments[s.departmentKey] : undefined) ?? agent.departmentId ?? null
        input = {
          name: clipText(s.name, 60),
          target: { kind: 'prompt', profileId: agent.refId, repoId: null, prompt: this.redact(`${s.target.title}\n\n${s.target.description}`), mode: 'task', agentId: agent.id },
          departmentId,
          when,
          enabled: false,
          companyId
        }
      } else {
        const workflowId = j.refs.workflows[s.target.workflow]
        if (!workflowId) continue // Workflows was skipped: its schedules go too
        input = {
          name: clipText(s.name, 60),
          target: { kind: 'workflow', workflowId, inputs: withRepoInput(s.target.workflow, Object.fromEntries(Object.entries(s.target.inputs ?? {}).map(([k, v]) => [k, this.redact(v)])), j.refs.repoIds[0]) },
          departmentId: board && s.departmentKey ? (j.refs.departments[s.departmentKey] ?? null) : null,
          when,
          enabled: false,
          companyId
        }
      }
      const costly = scheduleCostly(s)
      this.record(j, 'schedules', () => this.d.createSchedule(input), (sch) => ({ kind: 'schedule', id: sch.id }), (sch) => {
        if (sch.companyId !== companyId) throw new HiveError('internal', 'Schedule created in another company')
        if (sch.enabled) this.d.store.setScheduleEnabled(sch.id, false)
        j.scheduleRefs.push({ ref: s.ref, id: sch.id, costly })
      })
      made++
    }
    return made ? 'ok' : 'n/a'
  }

  // 11. finish (hard)
  private stepFinish(j: StoredJournal, prep: Prepared): 'ok' {
    this.own(j)
    if (prep.input.mode === 'first' && !this.d.settings().onboardingDone) this.d.updateSettings({ onboardingDone: true })
    this.d.stash.clear()
    this.d.journal.dropInput(j.id)
    this.d.changed([...ALL_DOMAINS])
    return 'ok'
  }

  // ---------- discard (§7.3) ----------

  async discard(req: { journalId: string }): Promise<{ undone: string[] }> {
    const j0 = this.journalOr404(req.journalId)
    return this.locked(j0.draftId, async () => {
      const j = this.journalOr404(req.journalId)
      if (j.status === 'discarded') return { undone: [] }
      if (j.status === 'done') throw new HiveError('conflict', `${j.companyName ?? 'This business'} is already set up. To remove it, right-click it in the company rail and choose Archive.`)
      const undone: string[] = []
      const failed: string[] = []
      const created = (step: LaunchStepName, kind: LaunchCreated['kind']) => stepOf(j, step).created.filter((c) => c.kind === kind).map((c) => c.id)
      const attempt = (label: string, fn: () => boolean | void) => {
        try {
          if (fn() !== false) undone.push(label)
        } catch (e) {
          failed.push(label)
          this.d.log?.warn('onboarding: discard step failed', { journalId: j.id, what: label, error: this.redact(errMessage(e)) })
        }
      }
      const companyId = j.companyId && j.companyId !== PERSONAL_COMPANY_ID ? j.companyId : null
      const inCompany = (cid: string | null | undefined) => !!companyId && (cid ?? PERSONAL_COMPANY_ID) === companyId

      attempt('Schedules', () => {
        const ids = created('schedules', 'schedule')
        for (const id of ids) if (inCompany(this.d.store.getSchedule(id)?.companyId)) this.d.removeSchedule(id)
        return ids.length > 0
      })
      attempt('Tasks', () => {
        const ids = created('tasks', 'task')
        for (const id of [...ids].reverse()) {
          let t: BoardTask
          try {
            t = this.d.company.task(id)
          } catch {
            continue
          }
          if (!inCompany(t.companyId) || t.status === 'canceled' || t.status === 'done') continue
          this.d.company.cancel(id)
        }
        return ids.length > 0
      })
      attempt('Team', () => {
        const ids = created('agents', 'agent')
        for (const id of ids) if (inCompany(this.d.company.departments.getAgent(id)?.companyId)) this.d.company.departments.archiveAgent(id, true)
        return ids.length > 0
      })
      attempt('Departments', () => {
        const ids = created('departments', 'department')
        for (const id of ids) if (inCompany(this.d.company.departments.get(id)?.companyId)) this.d.company.departments.archive(id, true)
        return ids.length > 0
      })
      attempt('Workflows', () => {
        const ids = created('workflows', 'workflow')
        for (const id of ids) {
          const wf = this.d.store.getWorkflow(id)
          if (wf && inCompany(wf.companyId)) this.d.removeWorkflow(id)
        }
        return ids.length > 0
      })
      attempt('Keys', () => {
        const names = created('keys', 'secret')
        if (companyId) for (const name of names) this.d.keys.remove(companyId, name)
        return names.length > 0
      })
      attempt('Code', () => {
        const moved = created('code', 'repoMove')
        const added = created('code', 'repo')
        for (const id of moved) if (this.d.store.getRepo(id) && inCompany(this.d.company.companyForRepo(id).id)) this.d.company.assignRepo(id, PERSONAL_COMPANY_ID)
        // the rows only: folders and clones stay on disk
        for (const id of added) if (this.d.store.getRepo(id) && inCompany(this.d.company.companyForRepo(id).id)) this.d.store.removeRepo(id)
        return moved.length + added.length > 0
      })
      attempt('Company', () => {
        if (!companyId) return false
        const c = this.d.company.passport(companyId)
        this.d.company.setAutopilot(companyId, false)
        if (!c.name.endsWith(DISCARDED_SUFFIX)) this.d.company.update(companyId, { name: clipText(`${c.name}${DISCARDED_SUFFIX}`.slice(0, 160), 160) })
        this.d.company.archive(companyId, true)
      })
      attempt('Beta features', () => {
        if (!j.prevFlags) return false
        this.d.updateSettings({ experimental: { ...j.prevFlags } })
      })
      const input = LaunchInputSchema.safeParse(this.d.journal.loadInput(j.id))
      if (input.success && input.data.key) this.d.stash.forget([input.data.key.stashId])
      j.status = 'discarded'
      this.d.journal.save(j)
      this.d.journal.dropInput(j.id)
      this.d.changed([...ALL_DOMAINS])
      if (failed.length) this.d.log?.warn('onboarding: discard left some items', { journalId: j.id, failed })
      return { undone }
    })
  }

  // ---------- start (§7.5) ----------

  async start(req: { journalId: string; autopilot: boolean; scheduleRefs: string[] }): Promise<BoardSettings | null> {
    const j0 = this.journalOr404(req.journalId)
    return this.locked(j0.draftId, async () => {
      const j = this.journalOr404(req.journalId)
      if (j.status !== 'done') throw new HiveError('forbidden', 'Finish setting up this business first')
      const companyId = this.own(j)
      const company = this.d.company.passport(companyId)
      if (company.system === 'personal') throw new HiveError('forbidden', 'Personal is not a business set up here')
      if (company.archivedAt) throw new HiveError('conflict', `Unarchive ${company.name} first`)
      const board = this.departmentsOn()
      // with no agent CLI installed every run would fail at once and park its task: Autopilot stays off and the
      // tasks wait on the board, as the plan promised ("Tasks will wait on the board"). The auto agents are still
      // raised, so turning Autopilot on once a CLI is installed starts them.
      const canRun = this.d.profileAdapters().length > 0
      if (req.autopilot && board) {
        // only the plan's "works on its own" agents of this journal are raised
        for (const id of j.refs.autoAgents) {
          const a = this.d.company.departments.getAgent(id)
          if (!a || a.companyId !== companyId || a.archivedAt || a.data.autonomy === 'auto') continue
          this.d.departments.saveAgent({ id: a.id, companyId, departmentId: a.departmentId, kind: a.kind, refId: a.refId, name: a.name, data: { autonomy: 'auto' } })
        }
        if (canRun) this.d.company.setAutopilot(companyId, true, START_MAX_IN_FLIGHT)
      }
      const wanted = new Set(req.scheduleRefs)
      for (const r of j.scheduleRefs) {
        if (!wanted.has(r.ref)) continue
        const s = this.d.store.getSchedule(r.id)
        if (!s || (s.companyId ?? PERSONAL_COMPANY_ID) !== companyId) continue
        if (!s.enabled) this.d.setScheduleEnabled(r.id, true)
      }
      j.startedAt = new Date().toISOString()
      this.d.journal.save(j)
      this.d.changed(['company', 'departments', 'schedules'])
      if (req.autopilot && board && canRun) {
        try {
          this.d.pump?.(companyId)
        } catch {
          /* the 60 s tick picks it up */
        }
      }
      return board ? this.d.company.boardSettings(companyId) : null
    })
  }

  // ---------- lifecycle ----------

  /** Stops a clone in flight (quit). The scratch folder is removed by the clone itself. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.clones.values()].map((c) => c.kill().catch(() => undefined)))
    this.clones.clear()
  }
}

/** The text tells you to run a bundled workflow that spends credits (fal, OpenAI images, Firecrawl). */
export function paidWorkflowTask(text: string): boolean {
  return workflowsNamed(text).some((id) => WORKFLOW_KEYS[id].costly)
}

/** The bundled workflow takes a `repo` input (a repository picker: its value is a repo id). */
export function needsRepo(id: BundledWorkflowId): boolean {
  return WORKFLOW_KEYS[id]?.inputs.includes('repo') ?? false
}

/** A schedule's inputs with `repo` filled from the company's first repo when the plan left it empty (the plan never
 * knows repo ids). A repo the plan named stays. */
export function withRepoInput(id: BundledWorkflowId, inputs: Record<string, string>, firstRepoId: string | undefined): Record<string, string> {
  if (!needsRepo(id) || inputs.repo?.trim() || !firstRepoId) return inputs
  return { ...inputs, repo: firstRepoId }
}
