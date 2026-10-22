/**
 * The onboarding plan: templates, validation/repair and deterministic post-processing (docs/ONBOARDING.md §6.3–§6.5),
 * plus the renderer's plan merge and inputs hash (§3, §9). Shared by main and renderer. Pure: no node or electron
 * imports; the secret screen is injected by the caller (main passes `screenText`/`redactCredentials`).
 */
import { DEPARTMENT_PRESETS, type DepartmentPresetKey } from './company'
import {
  BUNDLED_WORKFLOW_IDS,
  DEFAULT_VIBE,
  GOALS,
  GOAL_INFO,
  PLAN_CAPS,
  VIBE_INFO,
  WORKFLOW_KEYS,
  type BundledWorkflowId,
  type GoalKey,
  type OnboardingAvailable,
  type OnboardingPlan,
  type PlanAdapter,
  type PlanAgent,
  type PlanAgentRole,
  type PlanDepartment,
  type PlanInput,
  type PlanSchedule,
  type PlanTask
} from './onboarding'
import { pickPersona } from './personas'

// ---------- public types and constants ----------

/** Returns a short label when `text` contains a secret (vault fingerprint or credential shape), else null. */
export type ScreenFn = (text: string) => string | null

export interface PlanContext {
  /** Recomputed by main; the only source of truth for workflows, adapters, code and departments. */
  available: OnboardingAvailable
  /** The business's own site (free text: "acme.com", "https://www.acme.com/x"). Its host may appear in plan text. */
  siteUrl?: string | null
  /** Injected secret screen. Without one, only the built-in URL and path checks run. */
  screen?: ScreenFn
  /** The answers the plan was made for: used to refill goals emptied by repair, and as extra own-site sources. */
  input?: PlanInput
}

export type PlanItemKind = 'department' | 'agent' | 'task' | 'schedule' | 'summary'
export interface PlanDrop {
  kind: PlanItemKind
  /** Department key, or the item's ref ("summary" for the summary). */
  ref: string
  reason: string
}
export interface ValidatePlanResult {
  plan: OnboardingPlan
  dropped: PlanDrop[]
  /** False when nothing usable is left (no task and no schedule): fall back to the template entirely. */
  ok: boolean
}

/** §6.5: every task description ends with this (after its "Deliverable: …" line). */
export const TASK_REVIEW_SUFFIX = 'When done, move this task to review. Do not publish, send, spend, deploy or sign up for anything.'
/** §6.5: every content agent's instructions include this. */
export const CONTENT_AGENT_RULE =
  'Never publish or send anything. Save drafts under content/ in your working folder and list the file paths in your task comment.'

/** §6.4: roles whose agents may work on their own once the founder presses Start now. */
export const AUTO_ROLES: readonly PlanAgentRole[] = ['developer', 'builder', 'content']

/** §2 S4 defaults: code → ship + (website when no site was found, else social); no code → website + social. */
export function defaultGoals(hasCode: boolean, hasSite: boolean): GoalKey[] {
  if (hasCode) return ['ship', hasSite ? 'social' : 'website']
  return ['website', 'social']
}

/** Picked goals, de-duplicated, in pick order, without code-only goals when there is no code. Empty → the defaults. */
export function effectiveGoals(goals: readonly GoalKey[], hasCode: boolean, hasSite: boolean): GoalKey[] {
  const out: GoalKey[] = []
  for (const g of goals) if (GOALS.includes(g) && !out.includes(g) && (hasCode || !GOAL_INFO[g].codeOnly)) out.push(g)
  return out.length ? out : defaultGoals(hasCode, hasSite)
}

/** §2 S5 is shown only for these goals. */
export function needsContentStep(goals: readonly GoalKey[]): boolean {
  return goals.some((g) => GOAL_INFO[g]?.content)
}

// ---------- text helpers ----------

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi
/** Absolute (`/a/b`), home (`~/x`, `~user/x`), Windows (`C:\`) paths and file: URLs. Relative paths are fine. */
const PATH_RE = /(?:^|[\s"'`([<{=,;])(?:~[A-Za-z0-9._-]*\/|\/(?:[A-Za-z0-9._@-]+\/)+[A-Za-z0-9._@-]*|[A-Za-z]:\\)|\bfile:\/\/|\$HOME\b/

const PATH_STRIP_RE = /(^|[\s"'`([<{=,;])(?:~[A-Za-z0-9._-]*\/|\/(?:[A-Za-z0-9._@-]+\/)+|[A-Za-z]:\\)\S*/g

/** Host of a free-text site ("acme.com", "https://www.acme.com/a") lowercased, without `www.`; null if not a host. */
export function siteHost(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s || s.startsWith('@')) return null
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#\s]*@)?([^/?#:\s]+)/.exec(s)
  if (!m) return null
  const host = m[1].replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

function urlAllowed(url: string, hosts: readonly string[]): boolean {
  // Userinfo (`user:pw@`) can carry credentials, and `\` or `@` lets a link show one host and open another
  // ("https://evil.com\@acme.com" opens evil.com in a browser).
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim())?.[1] ?? ''
  if (/[@\\]/.test(authority)) return false
  const h = siteHost(url)
  return !!h && hosts.some((own) => h === own || h.endsWith(`.${own}`))
}

function ownHosts(ctx: { siteUrl?: string | null; input?: PlanInput }): string[] {
  const hosts = [ctx.siteUrl, ctx.input?.answers.siteUrl, ctx.input?.site?.url].map(siteHost).filter((h): h is string => !!h)
  return [...new Set(hosts)]
}

/** Why `text` may not appear in a plan, or null. */
function textProblem(text: string, hosts: readonly string[], screen?: ScreenFn): string | null {
  if (screen) {
    const hit = screen(text)
    if (hit) return `secret: ${hit}`
  }
  const urls = text.match(URL_RE) ?? []
  if (urls.some((u) => !urlAllowed(u, hosts))) return 'link to another site'
  if (PATH_RE.test(text.replace(URL_RE, ' '))) return 'file path'
  return null
}

/** Removes foreign links and paths from a user answer and clips it; '' when it carries a secret. */
function cleanAnswer(raw: string, max: number, hosts: readonly string[], screen?: ScreenFn): string {
  let s = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (screen && screen(s)) return ''
  s = s.replace(URL_RE, (u) => (urlAllowed(u, hosts) ? u : ' '))
  s = s.replace(/\bfile:\/\/\S*/gi, ' ').replace(/\$HOME\b\S*/g, ' ')
  for (let i = 0; i < 3 && PATH_RE.test(s.replace(URL_RE, ' ')); i++) s = s.replace(PATH_STRIP_RE, '$1')
  s = clip(s.replace(/\s+/g, ' ').trim(), max)
  return textProblem(s, hosts) ? '' : s
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

/** `body` clipped so that `body + sep + tail` fits `max`; `tail` is never cut. */
function withTail(body: string, tail: string, max: number, sep = ' '): string {
  const b = body.trim()
  return b ? `${clip(b, max - tail.length - sep.length)}${sep}${tail}` : tail
}

function describeTask(body: string, deliverable: string): string {
  return withTail(body, `Deliverable: ${deliverable}. ${TASK_REVIEW_SUFFIX}`, 2000, '\n\n')
}

function describeScheduled(body: string, deliverable: string): string {
  return withTail(body, `Deliverable: ${deliverable}. ${TASK_REVIEW_SUFFIX}`, 1000, '\n\n')
}

/** Appends `rule` unless `text` already carries it (idempotent, so finalized plans stay unchanged). */
function ensureRule(text: string, rule: string, max: number, sep = ' '): string {
  return text.includes(rule) ? text : withTail(text, rule, max, sep)
}

/** Bundled workflow ids named in a text (word-bounded, so `generate-image-fal` never matches inside another id). */
function workflowsIn(text: string): BundledWorkflowId[] {
  return BUNDLED_WORKFLOW_IDS.filter((id) => new RegExp(`(^|[^a-z0-9-])${id}($|[^a-z0-9-])`).test(text))
}

/**
 * Clamps the inputs that decide how many paid images a bundled workflow makes, to the ranges the workflow documents
 * (landing-hero-images heroCount 1-3, local-business-photos perShot 1-2, image-edit-upscale scale 2|4,
 * product-photo-studio at most 4 scenes). A plan (agent or template) can never ask a schedule for more.
 */
export function boundWorkflowInputs(id: BundledWorkflowId, inputs: Record<string, string>): Record<string, string> {
  const out = { ...inputs }
  const int = (v: string | undefined) => (v !== undefined && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN)
  if (id === 'landing-hero-images' && out.heroCount !== undefined) {
    const n = int(out.heroCount)
    out.heroCount = Number.isFinite(n) && n >= 1 ? String(Math.min(n, 3)) : '2'
  }
  if (id === 'local-business-photos' && out.perShot !== undefined) out.perShot = int(out.perShot) === 2 ? '2' : '1'
  if (id === 'image-edit-upscale' && out.scale !== undefined) out.scale = int(out.scale) === 4 ? '4' : '2'
  if (id === 'product-photo-studio' && out.scenes !== undefined) {
    out.scenes = out.scenes.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4).join(', ')
  }
  return out
}

// ---------- plan surgery ----------

function clonePlan(p: OnboardingPlan): OnboardingPlan {
  return {
    version: 1,
    summary: p.summary,
    departments: p.departments.map((d) => ({ ...d, ...(d.charter ? { charter: { ...d.charter } } : {}) })),
    agents: p.agents.map((a) => ({ ...a, ...(a.persona ? { persona: { ...a.persona, look: { ...a.persona.look } } } : {}) })),
    tasks: p.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] })),
    schedules: p.schedules.map((s) => ({
      ...s,
      target: s.target.kind === 'workflow' && s.target.inputs ? { ...s.target, inputs: { ...s.target.inputs } } : { ...s.target }
    }))
  }
}

/**
 * Drops everything that points at something no longer in the plan (agents in a missing department, tasks with a
 * missing agent/department/dependency, schedules with a missing agent/department), until nothing changes.
 */
function cascade(p: OnboardingPlan, dropped: PlanDrop[]): void {
  for (;;) {
    const depts = new Set(p.departments.map((d) => d.key))
    const agents = new Set(p.agents.map((a) => a.ref))
    const tasks = new Set(p.tasks.map((t) => t.ref))
    const before = p.agents.length + p.tasks.length + p.schedules.length
    p.agents = p.agents.filter((a) => {
      if (depts.has(a.departmentKey)) return true
      dropped.push({ kind: 'agent', ref: a.ref, reason: `department ${a.departmentKey} is not in the plan` })
      return false
    })
    p.tasks = p.tasks.filter((t) => {
      const why =
        t.departmentKey !== null && !depts.has(t.departmentKey)
          ? `department ${t.departmentKey} is not in the plan`
          : t.agentRef !== null && !agents.has(t.agentRef)
            ? `agent ${t.agentRef} is not in the plan`
            : t.dependsOn.find((d) => !tasks.has(d))
      if (!why) return true
      dropped.push({ kind: 'task', ref: t.ref, reason: why.includes(' ') ? why : `depends on missing task ${why}` })
      return false
    })
    p.schedules = p.schedules.filter((s) => {
      const why =
        s.departmentKey !== null && !depts.has(s.departmentKey)
          ? `department ${s.departmentKey} is not in the plan`
          : s.target.kind === 'task' && !agents.has(s.target.agentRef)
            ? `agent ${s.target.agentRef} is not in the plan`
            : null
      if (!why) return true
      dropped.push({ kind: 'schedule', ref: s.ref, reason: why })
      return false
    })
    if (p.agents.length + p.tasks.length + p.schedules.length === before) return
  }
}

/** Tasks in, or depending on, a dependency cycle. */
function cyclicTasks(tasks: readonly PlanTask[]): Set<string> {
  const refs = new Set(tasks.map((t) => t.ref))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    const deps = t.dependsOn.filter((d) => refs.has(d))
    indeg.set(t.ref, deps.length)
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), t.ref])
  }
  const queue = [...indeg].filter(([, n]) => n === 0).map(([r]) => r)
  const done = new Set<string>()
  while (queue.length) {
    const r = queue.shift() as string
    done.add(r)
    for (const dep of dependents.get(r) ?? []) {
      const n = (indeg.get(dep) ?? 0) - 1
      indeg.set(dep, n)
      if (n === 0) queue.push(dep)
    }
  }
  return new Set(tasks.map((t) => t.ref).filter((r) => !done.has(r)))
}

const WEEKLY_REVIEW: BundledWorkflowId = 'weekly-company-review'
const isWeeklyReview = (s: PlanSchedule): boolean => s.target.kind === 'workflow' && s.target.workflow === WEEKLY_REVIEW

/** §6.4 caps. Later items go first; the weekly company review keeps its schedule slot. */
function applyCaps(p: OnboardingPlan, dropped: PlanDrop[]): void {
  for (const d of p.departments.slice(PLAN_CAPS.departments)) dropped.push({ kind: 'department', ref: d.key, reason: 'over the cap' })
  p.departments = p.departments.slice(0, PLAN_CAPS.departments)
  cascade(p, dropped)
  for (const a of p.agents.slice(PLAN_CAPS.agents)) dropped.push({ kind: 'agent', ref: a.ref, reason: 'over the cap' })
  p.agents = p.agents.slice(0, PLAN_CAPS.agents)
  cascade(p, dropped)
  for (const t of p.tasks.slice(PLAN_CAPS.tasks)) dropped.push({ kind: 'task', ref: t.ref, reason: 'over the cap' })
  p.tasks = p.tasks.slice(0, PLAN_CAPS.tasks)
  cascade(p, dropped)
  if (p.schedules.length > PLAN_CAPS.schedules) {
    const review = p.schedules.findIndex(isWeeklyReview)
    const keep = new Set<number>(review >= 0 ? [review] : [])
    for (let i = 0; i < p.schedules.length && keep.size < PLAN_CAPS.schedules; i++) keep.add(i)
    p.schedules = p.schedules.filter((s, i) => {
      if (keep.has(i)) return true
      dropped.push({ kind: 'schedule', ref: s.ref, reason: 'over the cap' })
      return false
    })
  }
}

// ---------- finalize (§6.4) ----------

/**
 * Deterministic post-processing applied to both plan sources: autonomy by role, image-key and departments-consent
 * degradation, caps. Schedules are always created disabled at launch (the plan has no enabled flag; `include` only
 * means "create it").
 */
export function finalizePlan(plan: OnboardingPlan, ctx: Pick<PlanContext, 'available'>): OnboardingPlan {
  const p = clonePlan(plan)
  const avail = new Set<string>(ctx.available.workflows)
  const dropped: PlanDrop[] = []

  for (const a of p.agents) {
    a.auto = AUTO_ROLES.includes(a.role)
    // §6.5 for every plan source: content agents never publish, and every task ends in review.
    if (a.role === 'content') a.instructions = ensureRule(a.instructions, CONTENT_AGENT_RULE, 2000)
  }
  for (const t of p.tasks) t.description = ensureRule(t.description, TASK_REVIEW_SUFFIX, 2000, '\n\n')
  for (const s of p.schedules) if (s.target.kind === 'task') s.target = { ...s.target, description: ensureRule(s.target.description, TASK_REVIEW_SUFFIX, 1000, '\n\n') }

  // Paid image workflows: the count inputs are clamped here too, not only by the workflow's own prompt.
  for (const s of p.schedules) if (s.target.kind === 'workflow' && s.target.inputs) s.target = { ...s.target, inputs: boundWorkflowInputs(s.target.workflow, s.target.inputs) }

  // Without the key a workflow needs: its schedules go, and so do tasks that tell you to run it.
  p.schedules = p.schedules.filter((s) => s.target.kind !== 'workflow' || avail.has(s.target.workflow))
  p.tasks = p.tasks.filter((t) => workflowsIn(`${t.title}\n${t.description}`).every((w) => avail.has(w)))

  if (!ctx.available.departmentsOn) {
    p.departments = []
    p.agents = []
    p.schedules = p.schedules.filter((s) => s.target.kind === 'workflow').map((s) => ({ ...s, departmentKey: null }))
    p.tasks = p.tasks.map((t) => ({ ...t, departmentKey: null, agentRef: null }))
  }
  cascade(p, dropped)
  applyCaps(p, dropped)
  assignPersonas(p.agents)
  return p
}

/**
 * VOICE.md §4: every plan agent gets a persona, unique (case-insensitive) within the plan. Kept personas (a rename in
 * the draft) reserve their names first, in plan order; a later duplicate and every agent without one get
 * pickPersona with the plan-local seed (launch keeps the persona, so the face never changes after preview).
 */
function assignPersonas(agents: PlanAgent[]): void {
  const used = new Set<string>()
  const pending: PlanAgent[] = []
  for (const a of agents) {
    const name = a.persona?.name.trim().toLowerCase()
    if (a.persona && name && !used.has(name)) used.add(name)
    else pending.push(a)
  }
  for (const a of pending) {
    a.persona = pickPersona({ departmentKey: a.departmentKey, role: a.role, used, seed: a.ref })
    used.add(a.persona.name.toLowerCase())
  }
}

// ---------- templates (§6.5) ----------

interface Vars {
  name: string
  oneLiner: string
  products: string
  audience: string
  voice: string
  about: string
  context: string
  goalOther: string
  goalLabels: string
}

interface Block {
  goal: GoalKey | null
  departments: PlanDepartment[]
  agents: PlanAgent[]
  tasks: PlanTask[]
  schedules: PlanSchedule[]
}

const presetFor = (key: DepartmentPresetKey) => DEPARTMENT_PRESETS.find((d) => d.key === key)!
function dept(key: DepartmentPresetKey): PlanDepartment {
  const p = presetFor(key)
  return { key, name: p.name, include: true, charter: { does: clip(p.data.charter.does, 400), doesNot: clip(p.data.charter.doesNot, 400) } }
}

function pickAdapter(available: OnboardingAvailable): PlanAdapter {
  return available.profileAdapters.includes('claude') ? 'claude' : (available.profileAdapters[0] ?? 'claude')
}

function makeVars(input: PlanInput, hosts: readonly string[], screen?: ScreenFn): Vars {
  const a = input.answers
  const name = cleanAnswer(a.name, 80, hosts, screen) || 'the business'
  const oneLiner = cleanAnswer(a.oneLiner, 200, hosts, screen)
  const products = cleanAnswer(a.products, 300, hosts, screen)
  const audience = cleanAnswer(a.audience, 300, hosts, screen)
  const vibe = VIBE_INFO[a.voiceVibe ?? DEFAULT_VIBE].voice
  const voiceText = cleanAnswer(a.voiceText, 300, hosts, screen)
  const avoid = cleanAnswer(a.avoid, 200, hosts, screen)
  const voice = clip([vibe, voiceText, avoid ? `avoid: ${avoid}` : ''].filter(Boolean).join('; '), 600)
  const about = oneLiner ? `${name} (${oneLiner})` : name
  const context = [
    `Business: ${about}.`,
    products ? `Sells: ${products}.` : '',
    audience ? `Customers: ${audience}.` : '',
    `Voice: ${voice}.`
  ]
    .filter(Boolean)
    .join(' ')
  const goalOther = cleanAnswer(a.goalOther, 90, hosts, screen)
  const goalLabels = effectiveGoals(a.goals, input.hasCode, hosts.length > 0)
    .map((g) => (g === 'other' && goalOther ? goalOther : GOAL_INFO[g].label))
    .join('; ')
  return { name, oneLiner, products, audience, voice, about, context, goalOther, goalLabels }
}

/** `rules` (the safety lines) always survive in full; only `intro` (which carries the founder's answers) is clipped. */
function agent(ref: string, departmentKey: DepartmentPresetKey, name: string, role: PlanAgentRole, adapter: PlanAdapter, intro: string, rules: string, capabilities: string): PlanAgent {
  return { ref, departmentKey, name, role, adapter, instructions: withTail(intro, rules, 2000), capabilities: clip(capabilities, 400), auto: AUTO_ROLES.includes(role), include: true }
}

function task(
  ref: string,
  title: string,
  body: string,
  deliverable: string,
  departmentKey: DepartmentPresetKey | null,
  agentRef: string | null,
  o: { priority?: number; dependsOn?: string[]; where?: 'repo' | 'workspace' } = {}
): PlanTask {
  return {
    ref,
    title: clip(title, 120),
    description: describeTask(body, deliverable),
    departmentKey,
    agentRef,
    priority: o.priority ?? 2,
    dependsOn: o.dependsOn ?? [],
    where: o.where ?? 'workspace',
    include: true
  }
}

function buildBlocks(available: OnboardingAvailable, v: Vars, goals: readonly GoalKey[]): Block[] {
  const code = available.hasCode
  const adapter = pickAdapter(available)
  const has = (id: BundledWorkflowId) => available.workflows.includes(id)
  const fal = has('landing-hero-images')
  const openaiImages = has('generate-image-openai')
  const blocks: Block[] = []
  const block = (goal: GoalKey | null, b: Partial<Omit<Block, 'goal'>>): void => {
    blocks.push({ goal, departments: b.departments ?? [], agents: b.agents ?? [], tasks: b.tasks ?? [], schedules: b.schedules ?? [] })
  }

  const auditor = agent(
    'repo-auditor',
    'development',
    'Repo auditor',
    'developer',
    adapter,
    `You look after the code for ${v.about}. ${v.context}`,
    'Read the repository, find what matters most for the business and propose small, safe changes. Work on a branch, add tests with every fix and never push to the main branch, deploy or change settings. Put findings and plans in your task comment.',
    'Repository audits, bug fixes with tests, code review, technical SEO and site performance checks.'
  )
  const siteBuilder = agent(
    'site-builder',
    'marketing',
    'Site builder',
    'builder',
    adapter,
    `You build web pages for ${v.about}. ${v.context}`,
    'Work only inside your working folder: write plain HTML and CSS drafts that match the voice and read the passport notes first. Never publish, deploy or buy anything (domains, hosting, tools).',
    'Landing pages, page copy, simple HTML and CSS drafts.'
  )
  const writer = agent(
    'content-writer',
    'marketing',
    'Content writer',
    'content',
    adapter,
    `You write marketing content for ${v.about}. ${v.context} Match the voice in every draft and keep each piece specific to ${v.audience || 'the people it serves'}.`,
    CONTENT_AGENT_RULE,
    'Social posts, content calendars, ad copy, articles and keyword research, written as drafts.'
  )
  const researcher = agent(
    'lead-researcher',
    'sales',
    'Lead researcher',
    'researcher',
    adapter,
    `You find and understand the first customers for ${v.about}. ${v.context}`,
    'Describe who buys and why, and draft outreach for review. Never contact anyone, send messages or sign up for tools.',
    'Customer profiles, lead lists, outreach drafts.'
  )
  const supportDrafter = agent(
    'support-drafter',
    'support',
    'Support drafter',
    'support',
    adapter,
    `You prepare customer support for ${v.about}. ${v.context}`,
    'Draft answers and reply templates in the brand voice. Never reply to customers, issue refunds or change accounts yourself.',
    'FAQs, reply templates, help docs.'
  )
  const generalist = agent(
    'generalist',
    'ops',
    'Generalist',
    'generalist',
    adapter,
    `You help ${v.about} with whatever the founder needs next. ${v.context}`,
    'Propose plans and drafts for review. Never spend money, sign up for anything or contact anyone.',
    'Planning, research and drafts for anything that does not fit another team.'
  )

  if (code) {
    block(null, {
      departments: [dept('development')],
      agents: [auditor],
      tasks: [
        task(
          'audit-repo',
          'Audit the repo and propose the top 5 fixes',
          `Read the connected repository for ${v.about}: structure, tests, open problems and anything that blocks customers. Do not change any code in this task.`,
          'a ranked list of the top 5 fixes, each with the reason and a rough size, in the task comment',
          'development',
          'repo-auditor',
          { priority: 1, where: 'repo' }
        )
      ]
    })
  }

  for (const g of goals) {
    switch (g) {
      case 'ship':
        if (!code) break
        block(g, {
          departments: [dept('development')],
          agents: [auditor],
          tasks: [
            task(
              'fix-top-issue',
              'Fix the top issue from the audit, with tests',
              'Take the first item from the audit ranking and fix it on a branch. Add or update tests that cover the fix and keep the change small.',
              'a branch with the fix and passing tests, summarised in the task comment (no push to main, no deploy)',
              'development',
              'repo-auditor',
              { priority: 2, dependsOn: ['audit-repo'], where: 'repo' }
            )
          ],
          schedules: available.profileAdapters.includes('codex') && has('second-opinion-review')
            ? [{ ref: 'second-opinion', name: 'Weekly second-opinion code review', departmentKey: 'development', cadence: 'mon9', target: { kind: 'workflow', workflow: 'second-opinion-review' }, include: true }]
            : []
        })
        break
      case 'website':
        if (code) {
          block(g, {
            departments: [dept('development')],
            agents: [auditor],
            tasks: [
              task(
                'site-review',
                'Review the site for conversion and propose changes',
                `Review the site in the repository for ${v.about} as a first-time visitor from ${v.audience || 'the target audience'}: copy, speed, broken links and meta tags.`,
                'a prioritised list of proposed changes in the task comment (no code changes)',
                'development',
                'repo-auditor',
                { priority: 2, where: 'repo' }
              )
            ]
          })
        } else {
          const tasks = [
            task(
              'landing-page',
              'Draft a one-page landing page',
              `Write a one-page landing page for ${v.about} from the passport notes: what it sells (${v.products || 'see the passport'}), who it is for, and one clear call to action. Use index.html and styles.css in the business folder.`,
              'index.html and styles.css in the business folder, with the file paths in the task comment',
              'marketing',
              'site-builder',
              { priority: 2 }
            )
          ]
          if (fal || openaiImages) {
            const wf = fal ? 'Landing hero images (landing-hero-images)' : 'Generate image, OpenAI (generate-image-openai)'
            tasks.push(
              task(
                'hero-images',
                'Make 3 hero images',
                `When the landing page draft is ready, click Run on ${wf} from this task to make 3 hero images that fit the voice: ${v.voice}. This uses your image credits, so it only runs when you press Run.`,
                '3 hero images attached to this task',
                'marketing',
                null,
                { priority: 3, dependsOn: ['landing-page'] }
              )
            )
          }
          block(g, { departments: [dept('marketing')], agents: [siteBuilder], tasks })
        }
        break
      case 'social': {
        const tasks = [
          task(
            'content-calendar',
            'Write a 2-week content calendar (6 posts)',
            `Plan 6 social posts for ${v.about} over the next two weeks, written for ${v.audience || 'its customers'} in this voice: ${v.voice}. Each entry has a topic, the post text and an image idea.`,
            'content/calendar.md with 6 dated posts',
            'marketing',
            'content-writer',
            { priority: 2 }
          )
        ]
        if (fal)
          tasks.push(
            task(
              'brand-kit',
              'Create a starter brand kit',
              `Run Brand kit starter (brand-kit-starter) from this task with the business, voice (${v.voice}) and words to avoid. This uses your fal credits, so it only runs when you press Run.`,
              'a starter brand kit (palette, type and sample visuals) attached to this task',
              'marketing',
              null,
              { priority: 3 }
            )
          )
        const schedules: PlanSchedule[] = [
          {
            ref: 'weekly-posts',
            name: "Draft this week's posts",
            departmentKey: 'marketing',
            cadence: 'mon9',
            target: {
              kind: 'task',
              agentRef: 'content-writer',
              title: "Draft this week's 3 posts",
              description: describeScheduled(
                `Draft this week's 3 social posts for ${v.name} from content/calendar.md, in this voice: ${v.voice}.`,
                'the 3 drafts saved under content/ with the file paths in the task comment'
              )
            },
            include: true
          }
        ]
        if (fal)
          schedules.push({
            ref: 'carousel',
            name: 'Social carousel',
            departmentKey: 'marketing',
            cadence: 'mwf1030',
            target: {
              kind: 'workflow',
              workflow: 'social-post-carousel',
              inputs: {
                topic: clip(`The next unposted topic from content/calendar.md, else one useful to ${v.audience || 'the customers of ' + v.name}`, 1500),
                voice: clip(v.voice, 1500)
              }
            },
            include: true
          })
        block(g, { departments: [dept('marketing')], agents: [writer], tasks, schedules })
        break
      }
      case 'ads':
        block(g, {
          departments: [dept('marketing')],
          agents: [writer],
          tasks: [
            task(
              'ad-angles',
              'Draft 3 ad angles with headline and primary text',
              `Write 3 different ad angles for ${v.products || v.about}, aimed at ${v.audience || 'the most likely buyers'}, each with a headline and primary text.${fal ? ' To make image variants, click Run on Ad creative variants (ad-creative-variants) from this task; it uses your fal credits.' : ''}`,
              'content/ads.md with the 3 angles',
              'marketing',
              'content-writer',
              { priority: 2 }
            )
          ]
        })
        break
      case 'seo': {
        const tasks = [
          task(
            'seo-keywords',
            `List 20 target keywords and outline 3 articles`,
            `List 20 search keywords ${v.audience || 'likely customers'} would use to find ${v.about}, then outline 3 articles that answer them.`,
            'content/seo.md with the keywords and 3 outlines',
            'marketing',
            'content-writer',
            { priority: 2 }
          )
        ]
        if (code)
          tasks.push(
            task(
              'seo-technical',
              'Technical SEO audit (sitemap, robots, meta)',
              'Check the site in the repository for a sitemap, robots.txt, page titles, meta descriptions and structured data. Do not change any code in this task.',
              'a list of technical SEO fixes in the task comment',
              'development',
              'repo-auditor',
              { priority: 3, where: 'repo' }
            )
          )
        block(g, {
          departments: code ? [dept('marketing'), dept('development')] : [dept('marketing')],
          agents: code ? [writer, auditor] : [writer],
          tasks,
          schedules: [
            {
              ref: 'weekly-article',
              name: "Draft this week's article",
              departmentKey: 'marketing',
              cadence: 'mon9',
              target: {
                kind: 'task',
                agentRef: 'content-writer',
                title: "Draft this week's article",
                description: describeScheduled(
                  `Draft the next article from content/seo.md for ${v.name}, in this voice: ${v.voice}.`,
                  'the article draft saved under content/ with the file path in the task comment'
                )
              },
              include: true
            }
          ]
        })
        break
      }
      case 'customers':
        block(g, {
          departments: [dept('sales')],
          agents: [researcher],
          tasks: [
            task(
              'customer-profile',
              'Write the ideal customer profile into the Audience note',
              `Describe the ideal first customer for ${v.about}: who they are, what they need, where to find them and what makes them buy. Start from: ${v.audience || 'no audience given yet'}.`,
              'the ideal customer profile, proposed as an update to the Audience passport note in the task comment',
              'sales',
              'lead-researcher',
              { priority: 2 }
            ),
            task(
              'outreach-drafts',
              'Draft 3 outreach messages (not sent)',
              `Using the customer profile, draft 3 short outreach messages for ${v.name} in this voice: ${v.voice}. Do not send them.`,
              '3 message drafts in the task comment',
              'sales',
              'lead-researcher',
              { priority: 3, dependsOn: ['customer-profile'] }
            )
          ]
        })
        break
      case 'support':
        block(g, {
          departments: [dept('support')],
          agents: [supportDrafter],
          tasks: [
            task(
              'support-faq',
              'Draft an FAQ and 5 reply templates',
              `Write an FAQ for ${v.about} covering the questions ${v.audience || 'customers'} ask most, plus 5 reply templates in this voice: ${v.voice}.`,
              'support/faq.md and support/replies.md, with the file paths in the task comment',
              'support',
              'support-drafter',
              { priority: 2 }
            )
          ]
        })
        break
      case 'other':
        block(g, {
          departments: [dept('ops')],
          agents: [generalist],
          tasks: [
            task(
              'other-plan',
              v.goalOther ? `${v.goalOther}: propose a 5-step plan` : 'Propose a 5-step plan for your next priority',
              `The founder of ${v.about} wants to work on: ${v.goalOther || 'their next priority (ask in the task comment if unclear)'}. Propose a practical 5-step plan for the next 30 days.`,
              'a 5-step plan in the task comment',
              'ops',
              'generalist',
              { priority: 2 }
            )
          ]
        })
        break
    }
  }

  block(null, {
    schedules: [
      {
        ref: 'weekly-review',
        name: 'Weekly company review',
        departmentKey: null,
        cadence: 'fri16',
        target: {
          kind: 'workflow',
          workflow: WEEKLY_REVIEW,
          inputs: { context: clip(`Goals for the first 30 days: ${v.goalLabels || 'none set yet'}. ${v.context}`, 1500) }
        },
        include: true
      }
    ]
  })
  return blocks
}

function mergeBlocks(blocks: readonly Block[], summary: string): OnboardingPlan {
  const p: OnboardingPlan = { version: 1, summary, departments: [], agents: [], tasks: [], schedules: [] }
  for (const b of blocks) {
    for (const d of b.departments) if (!p.departments.some((x) => x.key === d.key)) p.departments.push(d)
    for (const a of b.agents) if (!p.agents.some((x) => x.ref === a.ref)) p.agents.push(a)
    for (const t of b.tasks) if (!p.tasks.some((x) => x.ref === t.ref)) p.tasks.push(t)
    for (const s of b.schedules) if (!p.schedules.some((x) => x.ref === s.ref)) p.schedules.push(s)
  }
  return p
}

interface Template {
  plan: OnboardingPlan
  goals: GoalKey[]
  /** Template task refs per goal (the code base block counts for no goal). */
  goalTasks: Map<GoalKey, string[]>
}

function buildTemplate(input: PlanInput, available: OnboardingAvailable, opts: { screen?: ScreenFn; siteUrl?: string | null } = {}): Template {
  const hosts = ownHosts({ siteUrl: opts.siteUrl, input })
  const v = makeVars(input, hosts, opts.screen)
  const goals = effectiveGoals(input.answers.goals, available.hasCode, hosts.length > 0)
  const blocks = buildBlocks(available, v, goals)
  const summary = clip(`A focused first week for ${v.name}: ${goals.map((g) => GOAL_INFO[g].label.toLowerCase()).join(', ')}.`, 280)
  const plan = finalizePlan(mergeBlocks(blocks, summary), { available })
  const kept = new Set(plan.tasks.map((t) => t.ref))
  const goalTasks = new Map<GoalKey, string[]>()
  for (const b of blocks) if (b.goal) goalTasks.set(b.goal, [...(goalTasks.get(b.goal) ?? []), ...b.tasks.map((t) => t.ref).filter((r) => kept.has(r))])
  return { plan, goals, goalTasks }
}

/**
 * §6.5 starter plan for `input`, limited to what main says is `available`. Already finalized (§6.4), so it passes
 * `OnboardingPlan.parse` and `validatePlan` unchanged. Answers are interpolated after removing foreign links, paths
 * and (with `screen`) anything secret.
 */
export function templatePlan(input: PlanInput, available: OnboardingAvailable, opts: { screen?: ScreenFn; siteUrl?: string | null } = {}): OnboardingPlan {
  return buildTemplate(input, available, opts).plan
}

// ---------- validate and repair (§6.3) ----------

const GOAL_DEPT = (g: GoalKey, hasCode: boolean): DepartmentPresetKey => {
  switch (g) {
    case 'ship':
      return 'development'
    case 'website':
      return hasCode ? 'development' : 'marketing'
    case 'customers':
      return 'sales'
    case 'support':
      return 'support'
    case 'other':
      return 'ops'
    default:
      return 'marketing'
  }
}

function goalCovered(p: OnboardingPlan, g: GoalKey, tpl: Template, hasCode: boolean, byDept: boolean): boolean {
  const refs = new Set(tpl.goalTasks.get(g) ?? [])
  return p.tasks.some((t) => refs.has(t.ref) || (byDept && t.departmentKey === GOAL_DEPT(g, hasCode)))
}

/** Adds the template's tasks for `goal` (with their dependencies, agents and departments) when they fit the caps. */
function refillGoal(p: OnboardingPlan, goal: GoalKey, tpl: Template): boolean {
  const want = new Map<string, PlanTask>()
  const visit = (ref: string): void => {
    if (want.has(ref) || p.tasks.some((t) => t.ref === ref)) return
    const t = tpl.plan.tasks.find((x) => x.ref === ref)
    if (!t) return
    want.set(ref, t)
    t.dependsOn.forEach(visit)
  }
  for (const ref of tpl.goalTasks.get(goal) ?? []) visit(ref)
  if (!want.size) return false
  const tasks = [...want.values()]
  if (tasks.some((t) => t.dependsOn.some((d) => !want.has(d) && !p.tasks.some((x) => x.ref === d)))) return false
  const agents = tpl.plan.agents.filter((a) => tasks.some((t) => t.agentRef === a.ref) && !p.agents.some((x) => x.ref === a.ref))
  const depts = tpl.plan.departments.filter(
    (d) => (tasks.some((t) => t.departmentKey === d.key) || agents.some((a) => a.departmentKey === d.key)) && !p.departments.some((x) => x.key === d.key)
  )
  if (p.tasks.length + tasks.length > PLAN_CAPS.tasks || p.agents.length + agents.length > PLAN_CAPS.agents || p.departments.length + depts.length > PLAN_CAPS.departments)
    return false
  p.departments.push(...depts.map((d) => ({ ...d })))
  p.agents.push(...agents.map((a) => ({ ...a })))
  // Dependencies first, so the board order stays topological.
  const ordered: PlanTask[] = []
  const place = (t: PlanTask): void => {
    if (ordered.includes(t)) return
    for (const d of t.dependsOn) if (want.has(d)) place(want.get(d)!)
    ordered.push(t)
  }
  tasks.forEach(place)
  p.tasks.push(...ordered.map((t) => ({ ...t, dependsOn: [...t.dependsOn] })))
  return true
}

/**
 * §6.3: checks a plan (agent or template) against `available` and repairs it: invalid items are dropped along with
 * everything that depends on them, adapters are rewritten to an installed one, and goals the repair left without a
 * task are refilled from the template (when `ctx.input` is given). Run on every plan and again at launch.
 */
export function validatePlan(plan: OnboardingPlan, ctx: PlanContext): ValidatePlanResult {
  const { available } = ctx
  const code = available.hasCode
  const hosts = ownHosts(ctx)
  const avail = new Set<string>(available.workflows.filter((w) => (BUNDLED_WORKFLOW_IDS as readonly string[]).includes(w)))
  const dropped: PlanDrop[] = []
  const original = plan
  const p = clonePlan(plan)
  const bad = (texts: (string | undefined)[]): string | null => {
    for (const t of texts) if (t) {
      const why = textProblem(t, hosts, ctx.screen)
      if (why) return why
    }
    return null
  }

  // Departments: unique keys, Development only with code, clean text.
  const seenDept = new Set<string>()
  p.departments = p.departments.filter((d) => {
    const why = seenDept.has(d.key)
      ? 'duplicate department'
      : d.key === 'development' && !code
        ? 'Development needs code'
        : bad([d.name, d.charter?.does, d.charter?.doesNot])
    seenDept.add(d.key)
    if (why) dropped.push({ kind: 'department', ref: d.key, reason: why })
    return !why
  })

  // Agents: unique refs, clean text, installed adapter.
  const seenAgent = new Set<string>()
  p.agents = p.agents.filter((a) => {
    const why = seenAgent.has(a.ref) ? 'duplicate ref' : bad([a.name, a.instructions, a.capabilities])
    seenAgent.add(a.ref)
    if (why) dropped.push({ kind: 'agent', ref: a.ref, reason: why })
    return !why
  })
  // a persona with a link, path or secret in it is not worth dropping the agent for: finalizePlan picks a new one
  for (const a of p.agents) if (a.persona && bad([a.persona.name, a.persona.personality, a.persona.bio])) delete a.persona
  for (const a of p.agents) {
    if (!available.profileAdapters.includes(a.adapter) && available.profileAdapters.length) a.adapter = available.profileAdapters[0]
  }

  // Tasks: unique refs, no self-dependency, repo work only with code, no unavailable workflow, clean text.
  const seenTask = new Set<string>()
  p.tasks = p.tasks.filter((t) => {
    const missingWf = workflowsIn(`${t.title}\n${t.description}`).find((w) => !avail.has(w))
    const why = seenTask.has(t.ref)
      ? 'duplicate ref'
      : t.dependsOn.includes(t.ref)
        ? 'depends on itself'
        : t.where === 'repo' && !code
          ? 'repo work needs code'
          : missingWf
            ? `workflow ${missingWf} is not available`
            : bad([t.title, t.description])
    seenTask.add(t.ref)
    if (why) dropped.push({ kind: 'task', ref: t.ref, reason: why })
    return !why
  })

  // Schedules: unique refs, available workflows with declared inputs only, clean text.
  const seenSched = new Set<string>()
  p.schedules = p.schedules.filter((s) => {
    let why: string | null = seenSched.has(s.ref) ? 'duplicate ref' : null
    seenSched.add(s.ref)
    if (!why && s.target.kind === 'workflow') {
      const wf = s.target.workflow
      if (!avail.has(wf)) why = `workflow ${wf} is not available`
      else {
        const declared = WORKFLOW_KEYS[wf].inputs
        const extra = Object.keys(s.target.inputs ?? {}).find((k) => !declared.includes(k))
        if (extra) why = `input ${extra} is not declared by ${wf}`
        else why = bad([s.name, ...Object.entries(s.target.inputs ?? {}).flat()])
      }
    } else if (!why && s.target.kind === 'task') {
      why = bad([s.name, s.target.title, s.target.description])
    }
    if (why) dropped.push({ kind: 'schedule', ref: s.ref, reason: why })
    return !why
  })

  // Dangling references, then cycles (and whatever depends on them), then dangling again.
  cascade(p, dropped)
  const cyclic = cyclicTasks(p.tasks)
  if (cyclic.size) {
    p.tasks = p.tasks.filter((t) => {
      if (!cyclic.has(t.ref)) return true
      dropped.push({ kind: 'task', ref: t.ref, reason: 'dependency cycle' })
      return false
    })
    cascade(p, dropped)
  }

  // Refill goals the repair emptied. Coverage counts template refs, and departments when the plan still has them
  // (a finalized plan without departments is judged by refs only, so re-validating it at launch adds nothing).
  if (ctx.input && dropped.length) {
    const tpl = buildTemplate(ctx.input, available, { screen: ctx.screen, siteUrl: ctx.siteUrl })
    const byDept = original.tasks.some((t) => t.departmentKey !== null)
    for (const g of tpl.goals) {
      const before = goalCovered(original, g, tpl, code, byDept)
      if (before && !goalCovered(p, g, tpl, code, byDept)) refillGoal(p, g, tpl)
    }
  }

  const summaryWhy = bad([p.summary])
  if (summaryWhy) {
    dropped.push({ kind: 'summary', ref: 'summary', reason: summaryWhy })
    const name = ctx.input ? cleanAnswer(ctx.input.answers.name, 80, hosts, ctx.screen) : ''
    p.summary = clip(`A focused first week for ${name || 'your business'}.`, 280)
  }

  return { plan: p, dropped, ok: p.tasks.length + p.schedules.length > 0 }
}

// ---------- renderer helpers (§3, §6.2) ----------

export type AgentPlanMerge =
  /** The founder has not edited: swap the agent plan in. */
  | { action: 'swap'; plan: OnboardingPlan }
  /** The founder edited: keep theirs and offer the agent plan ("Use it / Keep mine"). */
  | { action: 'offer'; plan: OnboardingPlan; offered: OnboardingPlan }
  /** Same content as what is shown: nothing to do. */
  | { action: 'same'; plan: OnboardingPlan }

/** §6.2 step 3: decides what a newly arrived agent plan does to the plan on screen. */
export function applyAgentPlan(current: OnboardingPlan | null | undefined, agent: OnboardingPlan, edited: boolean): AgentPlanMerge {
  if (current && stableStringify(current) === stableStringify(agent)) return { action: 'same', plan: current }
  if (!current || !edited) return { action: 'swap', plan: clonePlan(agent) }
  return { action: 'offer', plan: current, offered: clonePlan(agent) }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}

/** cyrb53-style 2×32-bit hash, hex. */
function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** §3: stable hash of everything the plan depends on (key order and undefined fields don't matter). */
export function inputsHash(input: PlanInput): string {
  const s = stableStringify(input)
  return `v1-${hash53(s)}${hash53(s, 0x9e3779b9)}`
}

/** §3: the draft's plan was made for different answers. */
export function isPlanStale(plan: { inputsHash: string } | null | undefined, input: PlanInput): boolean {
  return !plan || plan.inputsHash !== inputsHash(input)
}

/** §2 S8 summary counts (included items only). */
export function planCounts(plan: OnboardingPlan): { departments: number; agents: number; tasks: number; schedules: number } {
  return {
    departments: plan.departments.filter((d) => d.include).length,
    agents: plan.agents.filter((a) => a.include).length,
    tasks: plan.tasks.filter((t) => t.include).length,
    schedules: plan.schedules.filter((s) => s.include).length
  }
}

/** True when the schedule spends credits on a paid API (image schedules on the Ready step start unchecked). */
export function scheduleCostly(s: PlanSchedule): boolean {
  return s.target.kind === 'workflow' && WORKFLOW_KEYS[s.target.workflow].costly
}
