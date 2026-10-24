/**
 * AUTOPILOT.md: ready-made bundles of schedules, workflows and recurring agent tasks ("autopilots") for a company.
 *
 * Pure: the renderer passes in what it knows (departments, agents, installed dashboards, social channels, profiles) and
 * gets back, per step, whether it can be enabled, what is missing, and the exact schedule (and workflow) it would create.
 * Nothing here talks to main. An autopilot only ever creates ordinary schedules and workflows, so every step stays
 * visible and editable on the Schedules page, the department's Recurring card and the workflow editor.
 *
 * Honesty rules:
 * - a step is enabled only when everything it reads exists (its agent, its dashboards, its channels);
 * - the content step drafts for review; it may publish to a channel only after the user turned that channel on
 *   (AutopilotRecord.publish), and never to a channel whose API cannot post;
 * - every prompt says what not to do (no sending, no spending, no deleting).
 */
import type { CompanyAgent, Department, DepartmentPresetKey } from './company'
import { agentActive } from './company'
import type { DashboardKind } from './dashboards'
import { dashboardDef, dashboardDepartmentKey } from './dashboards'
import type { SocialId, SocialStatus } from './socials'
import type { AgentProfile, AdapterId, Id, ScheduleInput, WorkflowDraft } from './types'

export type AutopilotId = 'marketing' | 'company'
export const AUTOPILOT_IDS: readonly AutopilotId[] = ['marketing', 'company']

/** One created step: the schedule it owns, and the workflow when the step runs one. */
export interface AutopilotStepRecord {
  scheduleId: Id
  workflowId?: Id | null
}
/** Settings.autopilots[companyId][autopilotId]: what enabling created. Removing the autopilot removes exactly these. */
export interface AutopilotRecord {
  enabledAt: string
  paused: boolean
  steps: Partial<Record<string, AutopilotStepRecord>>
  /** Channels the user explicitly allowed the content step to publish to. Empty = drafts only. */
  publish: SocialId[]
}
export type CompanyAutopilots = Partial<Record<AutopilotId, AutopilotRecord>>

// ---------- requirements ----------

/** What a step needs. Each maps to one setup-checklist item (`fix`), so the sheet can link straight to it. */
export type Requirement =
  | { kind: 'departments' }
  | { kind: 'agent'; dept: DepartmentPresetKey | 'any' }
  | { kind: 'dashboard'; dept: DepartmentPresetKey; kinds: DashboardKind[] }
  | { kind: 'social' }
  | { kind: 'profile' }

/** Setup-checklist item ids a missing requirement points at (lib/checklist.ts). */
export type FixTarget = 'departments' | 'agents' | 'marketingDashboards' | 'financeDashboards' | 'socials' | 'profile'

export interface MissingRequirement {
  req: Requirement
  label: string
  fix: FixTarget
  /** the department the fix opens, when there is one */
  departmentId?: Id | null
}

export type StepKind = 'task' | 'workflow'
export interface AutopilotStepDef {
  id: string
  autopilot: AutopilotId
  kind: StepKind
  name: string
  /** one line for the sheet */
  summary: string
  /** 5-field cron in the user's tz, and its plain reading */
  cron: string
  cadence: string
  /** department the step belongs to; `lead` = the company's lead agent (Ops, else a company-level agent, else any) */
  dept: DepartmentPresetKey | 'lead'
  requires: Requirement[]
}

const MARKETING_DASHBOARDS: DashboardKind[] = ['gsc', 'geo', 'plausible', 'posthog']

export const AUTOPILOT_STEPS: readonly AutopilotStepDef[] = [
  {
    id: 'seo_report', autopilot: 'marketing', kind: 'task', name: 'Weekly SEO and AI-visibility report', dept: 'marketing',
    summary: 'Reads the Marketing dashboards and writes what moved, why, and three things to do next.',
    cron: '0 9 * * 1', cadence: 'Mondays at 9:00',
    requires: [{ kind: 'departments' }, { kind: 'agent', dept: 'marketing' }, { kind: 'dashboard', dept: 'marketing', kinds: MARKETING_DASHBOARDS }]
  },
  {
    id: 'content', autopilot: 'marketing', kind: 'task', name: 'Content calendar and drafts', dept: 'marketing',
    summary: 'Plans the week’s posts for your connected channels and drafts them for your review.',
    cron: '0 10 * * 1', cadence: 'Mondays at 10:00',
    requires: [{ kind: 'departments' }, { kind: 'agent', dept: 'marketing' }, { kind: 'social' }]
  },
  {
    id: 'competitors', autopilot: 'marketing', kind: 'workflow', name: 'Competitor watch', dept: 'marketing',
    summary: 'A workflow that checks your competitors’ sites and news and sends you a short brief.',
    cron: '0 9 * * 4', cadence: 'Thursdays at 9:00',
    requires: [{ kind: 'profile' }]
  },
  {
    id: 'review', autopilot: 'company', kind: 'task', name: 'Weekly company review', dept: 'lead',
    summary: 'Reads the whole board: what got done per department, what is stuck, and next week’s priorities.',
    cron: '0 8 * * 1', cadence: 'Mondays at 8:00',
    requires: [{ kind: 'departments' }, { kind: 'agent', dept: 'any' }]
  },
  {
    id: 'finance', autopilot: 'company', kind: 'task', name: 'Finance digest', dept: 'finance',
    summary: 'Turns the Stripe dashboard into a weekly digest: MRR, new and churned customers, failed payments.',
    cron: '30 8 * * 1', cadence: 'Mondays at 8:30',
    requires: [{ kind: 'departments' }, { kind: 'agent', dept: 'finance' }, { kind: 'dashboard', dept: 'finance', kinds: ['stripe'] }]
  },
  {
    id: 'triage', autopilot: 'company', kind: 'task', name: 'Board triage', dept: 'lead',
    summary: 'Every weekday: sorts new and unassigned tasks, flags what has been stuck for days.',
    cron: '0 9 * * 1-5', cadence: 'Weekdays at 9:00',
    requires: [{ kind: 'departments' }, { kind: 'agent', dept: 'any' }]
  }
]

export interface AutopilotDef {
  id: AutopilotId
  name: string
  tagline: string
}
export const AUTOPILOTS: readonly AutopilotDef[] = [
  { id: 'marketing', name: 'Marketing autopilot', tagline: 'A weekly SEO and AI-visibility report, a content calendar with drafts for your channels, and a competitor watch.' },
  { id: 'company', name: 'Company autopilot', tagline: 'A weekly review across departments, a finance digest from Stripe, and a daily triage of the board.' }
]
export const autopilotDef = (id: AutopilotId): AutopilotDef => AUTOPILOTS.find((a) => a.id === id)!
export const stepsOf = (id: AutopilotId): AutopilotStepDef[] => AUTOPILOT_STEPS.filter((s) => s.autopilot === id)

// ---------- planning ----------

export interface AutopilotContext {
  companyId: Id
  companyName: string
  /** experimental.companies + departments */
  departmentsOn: boolean
  departments: readonly Pick<Department, 'id' | 'companyId' | 'key' | 'name' | 'archivedAt'>[]
  agents: readonly CompanyAgent[]
  /** this company's installed dashboards (kind, department, and the GEO competitors when configured) */
  dashboards: readonly { kind: DashboardKind; departmentId: Id | null; competitors?: string[] }[]
  socials: readonly SocialStatus[]
  profiles: readonly Pick<AgentProfile, 'id' | 'adapter' | 'name'>[]
  defaultAdapter: AdapterId
  /** IANA tz of this Mac */
  tz: string
  /** passport lines the prompts quote (empty = left out) */
  passport?: { mission?: string; audience?: string; products?: string }
}

export interface StepPlan {
  def: AutopilotStepDef
  ready: boolean
  missing: MissingRequirement[]
  departmentId: Id | null
  departmentName: string | null
  agent: CompanyAgent | null
  profileId: Id | null
}

const PRESET_NAME: Record<DepartmentPresetKey, string> = { development: 'Development', marketing: 'Marketing', sales: 'Sales', support: 'Support', ops: 'Ops', finance: 'Finance' }

/** The company's active department that behaves like `key` (preset key first, then a name match like "Growth"). */
export function departmentFor(ctx: Pick<AutopilotContext, 'companyId' | 'departments'>, key: DepartmentPresetKey): AutopilotContext['departments'][number] | null {
  const live = ctx.departments.filter((d) => d.companyId === ctx.companyId && !d.archivedAt)
  return live.find((d) => d.key === key) ?? live.find((d) => dashboardDepartmentKey(d) === key) ?? null
}

/** Profile-backed, active seats of the company (workflow-backed seats run their workflow, not a prompt). */
function seats(ctx: AutopilotContext): CompanyAgent[] {
  return ctx.agents.filter((a) => a.companyId === ctx.companyId && agentActive(a) && a.kind === 'profile')
}

/** The agent a step of `dept` goes to: the department's first seat; `lead` = Ops, else company-level, else the first. */
export function agentFor(ctx: AutopilotContext, dept: DepartmentPresetKey | 'lead'): CompanyAgent | null {
  const all = seats(ctx)
  if (dept !== 'lead') {
    const d = departmentFor(ctx, dept)
    return d ? all.find((a) => a.departmentId === d.id) ?? null : null
  }
  const ops = departmentFor(ctx, 'ops')
  return (ops && all.find((a) => a.departmentId === ops.id)) || all.find((a) => !a.departmentId) || all[0] || null
}

export function defaultProfile(ctx: Pick<AutopilotContext, 'profiles' | 'defaultAdapter'>): Pick<AgentProfile, 'id' | 'adapter' | 'name'> | null {
  const usable = ctx.profiles.filter((p) => p.adapter !== 'shell')
  return usable.find((p) => p.adapter === ctx.defaultAdapter) ?? usable[0] ?? null
}

/** Whether each step can be created now, and what is missing when it cannot. */
export function planStep(def: AutopilotStepDef, ctx: AutopilotContext): StepPlan {
  const missing: MissingRequirement[] = []
  const agent = ctx.departmentsOn ? agentFor(ctx, def.dept) : null
  const dep = def.dept === 'lead' ? (agent?.departmentId ? ctx.departments.find((d) => d.id === agent.departmentId) ?? null : null) : departmentFor(ctx, def.dept)
  for (const r of def.requires) {
    switch (r.kind) {
      case 'departments':
        if (!ctx.departmentsOn) missing.push({ req: r, label: 'Turn on departments', fix: 'departments' })
        break
      case 'agent': {
        if (!ctx.departmentsOn) break // reported once, as departments
        if (agent) break
        if (r.dept === 'any') missing.push({ req: r, label: 'Add an agent to any department', fix: 'agents' })
        else {
          const d = departmentFor(ctx, r.dept)
          missing.push({ req: r, label: d ? `Add an agent to ${d.name}` : `Add a ${PRESET_NAME[r.dept]} department with an agent`, fix: 'agents', departmentId: d?.id ?? null })
        }
        break
      }
      case 'dashboard': {
        if (!ctx.departmentsOn) break
        const d = departmentFor(ctx, r.dept)
        const has = ctx.dashboards.some((x) => r.kinds.includes(x.kind) && (!d || x.departmentId === d.id || x.departmentId === null))
        if (!has) {
          // "Search Console, GEO, Plausible or PostHog": the part of each catalog name after "SEO · "
          const names = r.kinds.map((k) => (dashboardDef(k)?.name ?? k).split(' · ').pop()!)
          const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
          missing.push({ req: r, label: `Add ${names.length === 1 ? `the ${list}` : `a ${list}`} dashboard${d ? ` in ${d.name}` : ''}`, fix: r.dept === 'finance' ? 'financeDashboards' : 'marketingDashboards', departmentId: d?.id ?? null })
        }
        break
      }
      case 'social':
        if (!ctx.socials.some((s) => s.ready)) missing.push({ req: r, label: 'Connect at least one social channel', fix: 'socials' })
        break
      case 'profile':
        if (!defaultProfile(ctx)) missing.push({ req: r, label: 'Add an agent profile (Claude, Codex…)', fix: 'profile' })
        break
    }
  }
  const departmentsUsable = ctx.departmentsOn
  return {
    def,
    ready: missing.length === 0,
    missing,
    departmentId: departmentsUsable ? (dep?.id ?? null) : null,
    departmentName: dep?.name ?? null,
    agent,
    profileId: agent?.refId ?? defaultProfile(ctx)?.id ?? null
  }
}

export function planAutopilot(id: AutopilotId, ctx: AutopilotContext): StepPlan[] {
  return stepsOf(id).map((d) => planStep(d, ctx))
}

/** Every missing requirement of an autopilot, each fix listed once (the sheet's "Before you turn it on"). */
export function missingFor(plans: readonly StepPlan[]): MissingRequirement[] {
  const seen = new Set<string>()
  const out: MissingRequirement[] = []
  for (const p of plans)
    for (const m of p.missing) {
      const key = `${m.fix}:${m.label}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
  return out
}

// ---------- what a step creates ----------

const NO_SIDE_EFFECTS = 'Do not send emails or messages, spend money, change billing, delete anything, or contact anyone outside the company.'

function passportLines(ctx: AutopilotContext): string {
  const p = ctx.passport ?? {}
  const lines = [p.mission && `Mission: ${p.mission}`, p.audience && `Audience: ${p.audience}`, p.products && `Products: ${p.products}`].filter(Boolean)
  return lines.length ? `\n\nAbout ${ctx.companyName}:\n${lines.map((l) => `- ${clip(String(l), 300)}`).join('\n')}` : ''
}
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The channels the content step may name, and which of them it may publish to. */
export function contentChannels(socials: readonly SocialStatus[], publish: readonly SocialId[]): { drafts: SocialStatus[]; publish: SocialStatus[] } {
  const drafts = socials.filter((s) => s.ready)
  return { drafts, publish: drafts.filter((s) => s.canPost && publish.includes(s.id)) }
}

/** The prompt (standing-card body) of a task step, or the agent node prompt of a workflow step. */
export function stepPrompt(def: AutopilotStepDef, ctx: AutopilotContext, publish: readonly SocialId[] = []): string {
  const about = passportLines(ctx)
  switch (def.id) {
    case 'seo_report': {
      const d = departmentFor(ctx, 'marketing')
      const kinds = [...new Set(ctx.dashboards.filter((x) => MARKETING_DASHBOARDS.includes(x.kind) && (!d || x.departmentId === d.id || x.departmentId === null)).map((x) => dashboardDef(x.kind)?.name ?? x.kind))]
      return [
        `Write this week's SEO and AI-visibility report for ${ctx.companyName}.`,
        `Use the dashboard numbers in your department context (${kinds.join(', ') || 'the Marketing dashboards'}). Quote the numbers you use and the period they cover; if a dashboard shows an error or no data, say so instead of guessing.`,
        'Structure: 1) what moved since last week and the likely reason, 2) the queries, pages or prompts that matter most, 3) three concrete actions for next week, each small enough for one task.',
        'Finish with task_report for review. Do not change the website or publish anything. ' + NO_SIDE_EFFECTS
      ].join('\n\n') + about
    }
    case 'content': {
      const { drafts, publish: pub } = contentChannels(ctx.socials, publish)
      const rules = drafts.map((s) =>
        pub.some((p) => p.id === s.id)
          ? `- ${s.name}: publishing is on. Publish a draft only after the human approves it in a comment on this card, at most 3 posts a week, using the ${s.state === 'mcp' ? `${s.connection} connection` : 'API key in your environment'}. List every published post's link in your report.`
          : `- ${s.name}: drafts only. Do not publish.`
      )
      return [
        `Plan next week's social content for ${ctx.companyName} and draft the posts.`,
        `Channels:\n${rules.join('\n') || '- none connected: write drafts only.'}`,
        'Make a short calendar (day, channel, topic, goal), then the full text of each post in the channel’s format and length. Match the brand voice in the passport. Mark anything that needs an image or a fact check.',
        'Finish with task_report for review: the human approves before anything goes out. ' + NO_SIDE_EFFECTS
      ].join('\n\n') + about
    }
    case 'competitors':
      return [
        `You are the competitor watch for ${ctx.companyName}.`,
        'Competitors (one per line):\n{{inputs.competitors}}',
        'For each competitor, look at their website, blog, changelog, pricing page and recent news from the last 7 days. Report only real changes you found, each with its link and date: new features, pricing changes, launches, notable content. If nothing changed, say "No changes" for that competitor. Never invent a change.',
        'End with up to three things we could do in response. ' + NO_SIDE_EFFECTS
      ].join('\n\n') + about
    case 'review':
      return [
        `Write the weekly company review for ${ctx.companyName}.`,
        'Use task_list to read the board across every department. Cover: what got done this week per department, what is blocked or waiting on the human and for how long, and the top three priorities for next week per department.',
        'Keep it to one screen. Name tasks by their identifier. Do not move, close or reassign tasks; this is a report.',
        'Finish with task_report for review. ' + NO_SIDE_EFFECTS
      ].join('\n\n') + about
    case 'finance':
      return [
        `Write the weekly finance digest for ${ctx.companyName}.`,
        'Use the Stripe dashboard numbers in your department context: MRR, new and churned customers, churn rate, net revenue, failed payments. Quote each number with its period and the change against the previous period. If the dashboard shows an error or no data, say so.',
        'Flag anything unusual (a churn spike, failed payments rising) with what to check. Do not contact customers, retry payments, issue refunds or change anything in Stripe.',
        'Finish with task_report for review. ' + NO_SIDE_EFFECTS
      ].join('\n\n')
    case 'triage':
      return [
        `Triage the ${ctx.companyName} board.`,
        'Use task_list. For each new or unassigned task, comment with the department and agent it fits and why (task_comment). List tasks that have been blocked or waiting on the human for more than 3 days, oldest first.',
        'Do not close, cancel, delete or reassign tasks yourself. If nothing needs triage, say so in one line.',
        'Finish with task_report. ' + NO_SIDE_EFFECTS
      ].join('\n\n')
  }
  return def.summary
}

export interface StepBuild {
  /** created first when the step runs a workflow; the schedule then targets it */
  workflow: (WorkflowDraft & { companyId: Id }) | null
  schedule: (workflowId: Id | null) => ScheduleInput & { companyId: Id }
}

/** Competitors for the watch: the GEO dashboard's list when configured, else empty (the sheet asks for them). */
export function competitorList(ctx: Pick<AutopilotContext, 'dashboards'>): string {
  return [...new Set(ctx.dashboards.flatMap((d) => d.competitors ?? []).map((c) => c.trim()))].filter(Boolean).slice(0, 10).join('\n')
}

/**
 * The schedule (and workflow) a ready step creates. Task steps are task-mode schedules: one standing "Recurring:" card
 * on the board, assigned to the step's agent, commented and woken on each fire. The workflow step is an agent node
 * plus a Mac notification. Everything is created enabled unless `enabled` is false.
 */
export function buildStep(plan: StepPlan, ctx: AutopilotContext, opts: { publish?: readonly SocialId[]; enabled?: boolean; competitors?: string } = {}): StepBuild {
  const { def } = plan
  if (!plan.ready || !plan.profileId) throw new Error(`${def.name} is not ready: ${plan.missing.map((m) => m.label).join(', ') || 'no agent profile'}`)
  const when = { kind: 'cron' as const, cron: def.cron, tz: ctx.tz }
  const enabled = opts.enabled ?? true
  const name = `${def.name}`
  if (def.kind === 'task') {
    const agent = plan.agent!
    return {
      workflow: null,
      schedule: () => ({
        name,
        target: { kind: 'prompt', profileId: agent.refId, repoId: null, prompt: stepPrompt(def, ctx, opts.publish), mode: 'task', agentId: agent.id },
        departmentId: plan.departmentId ?? agent.departmentId ?? null,
        when,
        preset: { kind: 'cron' },
        enabled,
        companyId: ctx.companyId
      })
    }
  }
  const competitors = (opts.competitors ?? competitorList(ctx)).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20).join('\n')
  if (!competitors) throw new Error(`${def.name}: list at least one competitor`)
  const workflow: WorkflowDraft & { companyId: Id } = {
    name: `${def.name} · ${ctx.companyName}`.slice(0, 80),
    description: `${autopilotDef(def.autopilot).name}: ${def.summary}`,
    inputs: [{ name: 'competitors', label: 'Competitors (one per line)', type: 'multiline', default: competitors }],
    nodes: [
      { id: 'research', type: 'agent', label: 'Research competitors', after: [], cwd: null, timeoutMin: 30, profileId: plan.profileId, prompt: stepPrompt(def, ctx) },
      { id: 'tell', type: 'notify', label: 'Send me the brief', after: ['research'], cwd: null, timeoutMin: 1, title: `Competitor watch · ${ctx.companyName}`.slice(0, 120), message: '{{research.output}}', slack: null }
    ],
    companyId: ctx.companyId
  }
  return {
    workflow,
    schedule: (workflowId) => ({
      name,
      target: { kind: 'workflow', workflowId: workflowId!, inputs: { competitors } },
      departmentId: plan.departmentId,
      when,
      preset: { kind: 'cron' },
      enabled,
      companyId: ctx.companyId
    })
  }
}

/** The record after a step was (re)created. */
export function withStep(rec: AutopilotRecord | undefined, stepId: string, step: AutopilotStepRecord, now: string, publish: readonly SocialId[]): AutopilotRecord {
  return { enabledAt: rec?.enabledAt ?? now, paused: rec?.paused ?? false, publish: [...publish], steps: { ...(rec?.steps ?? {}), [stepId]: step } }
}

/** Settings.autopilots with one company's autopilot replaced (undefined removes it; an emptied company is dropped). */
export function setAutopilot(all: Readonly<Record<Id, CompanyAutopilots>> | undefined, companyId: Id, id: AutopilotId, rec: AutopilotRecord | undefined): Record<Id, CompanyAutopilots> {
  const next: Record<Id, CompanyAutopilots> = { ...(all ?? {}) }
  const co: CompanyAutopilots = { ...(next[companyId] ?? {}) }
  if (rec) co[id] = rec
  else delete co[id]
  if (Object.keys(co).length) next[companyId] = co
  else delete next[companyId]
  return next
}
