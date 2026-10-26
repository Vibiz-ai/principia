/**
 * Automations › Routines: ready-made daily and weekly routines a company turns on with one click.
 *
 * Pure, like shared/autopilot.ts (whose context and agent picking it reuses): the renderer passes what it knows and
 * gets back, per routine, whether it fits this company, who would do it, when, and the exact schedule (and workflow)
 * "Turn on" creates. A routine only ever creates one ordinary schedule (plus the workflow when it runs one), so it stays
 * visible and editable under Schedules.
 *
 * Honesty rules (the same as the autopilots):
 * - "Turn on" creates an ENABLED schedule because the person pressed it; nothing here turns anything on by itself;
 * - every prompt drafts and reports; it never sends, publishes, spends or deletes (NO_SIDE_EFFECTS);
 * - code routines are offered only to a company with a repository.
 */
import type { DepartmentPresetKey } from './company'
import { agentFor, defaultProfile, departmentFor, type AutopilotContext } from './autopilot'
import type { CompanyAgent } from './company'
import { morningBriefDraft } from './morningBrief'
import type { AdapterId, Id, ScheduleInput, WorkflowDraft } from './types'

export const ROUTINE_IDS = ['morning-brief', 'weekly-review', 'inbox-triage', 'social-drafts', 'repo-health', 'code-brief'] as const
export type RoutineId = (typeof ROUTINE_IDS)[number]
export const isRoutineId = (v: unknown): v is RoutineId => typeof v === 'string' && (ROUTINE_IDS as readonly string[]).includes(v)

/** Settings.routines[companyId][routineId]: what "Turn on" created, so Turn off removes exactly that. UI bookkeeping. */
export interface RoutineRecord {
  scheduleId: Id
  workflowId?: Id | null
  onAt: string
}
export type CompanyRoutines = Partial<Record<RoutineId, RoutineRecord>>

export interface RoutineDef {
  id: RoutineId
  name: string
  /** one sentence: what it does */
  summary: string
  /** 5-field cron in the user's tz, and its plain reading */
  cron: string
  cadence: string
  /** what one run costs, in plain words (the agent's plan is named by routineCost) */
  runs: string
  /** the department whose agent does it; `lead` = the company's lead agent (autopilot.agentFor) */
  dept: DepartmentPresetKey | 'lead'
  /** offered only to a company with a repository */
  codeOnly?: boolean
  /** 'task': a recurring card on the board for the agent (or a plain prompt run without departments); 'workflow': the seeded workflow */
  kind: 'task' | 'workflow'
}

export const ROUTINES: readonly RoutineDef[] = [
  {
    id: 'morning-brief', name: 'Morning brief', kind: 'task', dept: 'lead',
    summary: 'What got done yesterday, what is stuck or waiting on you, and the three things to look at first.',
    cron: '0 9 * * 1-5', cadence: 'Weekdays at 9:00', runs: 'one short run each weekday'
  },
  {
    id: 'weekly-review', name: 'Weekly company review', kind: 'task', dept: 'lead',
    summary: 'What the team finished this week, what is waiting on you, and next week’s priorities, on one screen.',
    cron: '0 16 * * 5', cadence: 'Fridays at 16:00', runs: 'one run a week'
  },
  {
    id: 'inbox-triage', name: 'Support inbox triage', kind: 'task', dept: 'support',
    summary: 'Sorts new customer questions and support tasks, drafts replies for your OK, and flags anything urgent.',
    cron: '0 10 * * 1-5', cadence: 'Weekdays at 10:00', runs: 'one short run each weekday'
  },
  {
    id: 'social-drafts', name: 'Social post drafts for your OK', kind: 'task', dept: 'marketing',
    summary: 'Drafts posts in your brand voice for the week. Nothing is published: each draft waits for your OK.',
    cron: '0 10 * * 1,3,5', cadence: 'Mon, Wed and Fri at 10:00', runs: 'one run three times a week'
  },
  {
    id: 'repo-health', name: 'Open pull requests digest', kind: 'task', dept: 'development', codeOnly: true,
    summary: 'Open pull requests, failing checks and stale branches, with what to merge or fix first.',
    cron: '30 9 * * 1-5', cadence: 'Weekdays at 9:30', runs: 'one short run each weekday'
  },
  {
    id: 'code-brief', name: 'Code activity brief', kind: 'workflow', dept: 'development', codeOnly: true,
    summary: 'Collects the last day of commits and unfinished work across your repositories and writes a short brief.',
    cron: '45 8 * * 1-5', cadence: 'Weekdays at 8:45', runs: 'one short run each weekday'
  }
]
export const routineDef = (id: RoutineId): RoutineDef => ROUTINES.find((r) => r.id === id)!

export interface RoutineContext extends AutopilotContext {
  /** the company has a repository: code routines fit, and repo-health runs in the first one */
  repoIds: readonly Id[]
}

/** The routines that fit this company, in display order: no code routines for a company without a repository. */
export function routinesFor(ctx: Pick<RoutineContext, 'repoIds'>): RoutineDef[] {
  const code = ctx.repoIds.length > 0
  return ROUTINES.filter((r) => !r.codeOnly || code)
}

export interface RoutinePlan {
  def: RoutineDef
  /** false = nobody can run it on this Mac (no agent profile) */
  ready: boolean
  /** why it can't be turned on yet, in plain words */
  blocker: string | null
  /** the agent seat that does it (departments on), else null: a plain run on `profileId` */
  agent: CompanyAgent | null
  departmentId: Id | null
  profileId: Id | null
  adapter: AdapterId | null
}

/** Who does a routine: its department's agent, else the lead agent; without departments, the default profile. */
export function planRoutine(def: RoutineDef, ctx: RoutineContext): RoutinePlan {
  const agent = ctx.departmentsOn ? (def.dept === 'lead' ? agentFor(ctx, 'lead') : (agentFor(ctx, def.dept) ?? agentFor(ctx, 'lead'))) : null
  const dep = def.dept !== 'lead' ? departmentFor(ctx, def.dept) : null
  const fallback = defaultProfile(ctx)
  const profileId = agent?.refId ?? fallback?.id ?? null
  const adapter = (agent ? ctx.profiles.find((p) => p.id === agent.refId)?.adapter : fallback?.adapter) ?? null
  const blocker = !profileId ? 'Install Claude Code (or another agent CLI) first' : def.codeOnly && !ctx.repoIds.length ? 'Add a repository first' : null
  return { def, ready: !blocker, blocker, agent, departmentId: agent?.departmentId ?? dep?.id ?? null, profileId, adapter }
}

const PLAN_NAME: Partial<Record<AdapterId, string>> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor' }
/** "Uses your Claude plan: one short run each weekday. Principia charges nothing extra." */
export function routineCost(plan: Pick<RoutinePlan, 'def' | 'adapter'>): string {
  const who = plan.adapter ? PLAN_NAME[plan.adapter] : null
  return `Uses your ${who ? `${who} plan` : 'agent plan'}: ${plan.def.runs}. Principia charges nothing extra.`
}

const NO_SIDE_EFFECTS = 'Do not send emails or messages, publish, spend money, change billing, delete anything, or contact anyone outside the company.'

/** The prompt one fire hands the agent. `board`: the agent has the board tools (task-mode card). */
export function routinePrompt(def: RoutineDef, ctx: Pick<RoutineContext, 'companyName' | 'passport'>, board: boolean): string {
  const about = aboutLines(ctx)
  const finish = board ? 'Finish with task_report for review.' : 'Reply with the result.'
  const read = board ? 'Use task_list to read the board' : 'Read what you can see of the company (its board and notes)'
  switch (def.id) {
    case 'morning-brief':
      return [
        `Write today's morning brief for ${ctx.companyName}.`,
        `${read}: what got done since yesterday, what is in progress, and what is stuck or waiting on the founder (oldest first).`,
        'End with the three things the founder should look at first, each in one line. Keep it to one screen. Name tasks by their identifier.',
        `${finish} ${NO_SIDE_EFFECTS}`
      ].join('\n\n') + about
    case 'weekly-review':
      return [
        `Write this week's company review for ${ctx.companyName}.`,
        `${read} across every department. Cover what got done this week, what is blocked or waiting on the founder and for how long, and the top three priorities for next week.`,
        'One screen. Name tasks by their identifier. Do not move, close or reassign tasks: this is a report.',
        `${finish} ${NO_SIDE_EFFECTS}`
      ].join('\n\n') + about
    case 'inbox-triage':
      return [
        `Triage ${ctx.companyName}'s support inbox.`,
        'Look at new customer questions: support tasks on the board and, when an inbox or help desk is connected (principia_list_tools), its newest unanswered conversations. If none is connected, say so and give the founder the connect link from connections_list.',
        'For each one: what the customer wants, how urgent it is, and a short draft reply in the brand voice. Flag anything urgent (an outage, a refund, an angry customer) at the top.',
        `Drafts only: the founder sends them. ${finish} ${NO_SIDE_EFFECTS}`
      ].join('\n\n') + about
    case 'social-drafts':
      return [
        `Draft the next social posts for ${ctx.companyName}.`,
        'Two or three posts for the connected channels (or for Instagram and LinkedIn when none is connected): a short calendar (day, channel, topic), then each post in full in the channel’s format and length. Match the brand voice in the company notes, and mark anything that needs a picture or a fact check.',
        `Nothing is published: the founder approves each draft. ${finish} ${NO_SIDE_EFFECTS}`
      ].join('\n\n') + about
    case 'repo-health':
      return [
        `Write the open pull requests digest for ${ctx.companyName}'s repository.`,
        'Use git and, when it is installed and signed in, the gh CLI (read-only: gh pr list, gh pr checks, gh run list). Cover open pull requests (age, author, review state, checks), failing checks on the default branch, and branches with no commits for 30 days.',
        'End with what to merge, review or fix first. Do not push, merge, close, comment on or delete anything.',
        `${finish} ${NO_SIDE_EFFECTS}`
      ].join('\n\n') + about
    case 'code-brief':
      return def.summary
  }
}

function aboutLines(ctx: Pick<RoutineContext, 'companyName' | 'passport'>): string {
  const p = ctx.passport ?? {}
  const lines = [p.mission && `Mission: ${p.mission}`, p.audience && `Audience: ${p.audience}`, p.products && `Products: ${p.products}`].filter(Boolean) as string[]
  return lines.length ? `\n\nAbout ${ctx.companyName}:\n${lines.map((l) => `- ${l.length > 300 ? `${l.slice(0, 299)}…` : l}`).join('\n')}` : ''
}

export interface RoutineBuild {
  /** created first when the routine runs a workflow and the company has none to reuse */
  workflow: (WorkflowDraft & { companyId: Id }) | null
  /** the workflow id to reuse, when the company already has the seeded one */
  reuseWorkflowId: Id | null
  schedule: (workflowId: Id | null) => ScheduleInput & { companyId: Id }
}

/**
 * What "Turn on" creates. A task routine with an agent is a task-mode schedule: one standing "Recurring:" card on the
 * board for that agent, woken on each fire (engine/scheduler + company/recurring). Without departments it is a plain
 * prompt run on the default profile. The workflow routine reuses the company's "Code activity brief" workflow, else
 * creates it from the seeded Morning brief. Always enabled: the person pressed Turn on.
 */
export function buildRoutine(plan: RoutinePlan, ctx: RoutineContext, workflows: readonly { id: Id; name: string; companyId?: Id | null }[] = []): RoutineBuild {
  const { def } = plan
  if (!plan.ready || !plan.profileId) throw new Error(`${def.name} can’t be turned on yet: ${plan.blocker ?? 'no agent'}`)
  const when = { kind: 'cron' as const, cron: def.cron, tz: ctx.tz }
  const base = { name: def.name, when, preset: { kind: 'cron' as const }, enabled: true, companyId: ctx.companyId }
  const repoId = def.id === 'repo-health' ? (ctx.repoIds[0] ?? null) : null
  if (def.kind === 'task') {
    const agent = plan.agent
    return {
      workflow: null,
      reuseWorkflowId: null,
      schedule: () => ({
        ...base,
        target: agent
          ? { kind: 'prompt', profileId: agent.refId, repoId, prompt: routinePrompt(def, ctx, true), mode: 'task', agentId: agent.id }
          : { kind: 'prompt', profileId: plan.profileId!, repoId, prompt: routinePrompt(def, ctx, false) },
        departmentId: agent ? (agent.departmentId ?? plan.departmentId) : null
      })
    }
  }
  const own = workflows.find((w) => (w.companyId ?? null) === ctx.companyId && w.name === ROUTINE_WORKFLOW_NAME)
  return {
    workflow: own ? null : { ...morningBriefDraft(plan.profileId), name: ROUTINE_WORKFLOW_NAME, companyId: ctx.companyId },
    reuseWorkflowId: own?.id ?? null,
    schedule: (workflowId) => ({ ...base, target: { kind: 'workflow', workflowId: workflowId!, inputs: { root: 'all' } }, departmentId: plan.departmentId })
  }
}
/** The name the Code activity brief's workflow gets in a company (found again by it). */
export const ROUTINE_WORKFLOW_NAME = 'Code activity brief'

/** Settings.routines with one company's routine replaced (undefined removes it; an emptied company is dropped). */
export function setRoutine(all: Readonly<Record<Id, CompanyRoutines>> | undefined, companyId: Id, id: RoutineId, rec: RoutineRecord | undefined): Record<Id, CompanyRoutines> {
  const next: Record<Id, CompanyRoutines> = { ...(all ?? {}) }
  const co: CompanyRoutines = { ...(next[companyId] ?? {}) }
  if (rec) co[id] = rec
  else delete co[id]
  if (Object.keys(co).length) next[companyId] = co
  else delete next[companyId]
  return next
}

/**
 * Which schedule is this routine's: the recorded one when it still exists, else a schedule of this company with the
 * routine's name (turned on before the record, or by an agent's proposal). Null = off.
 */
export function routineSchedule<S extends { id: Id; name: string; companyId?: Id | null }>(id: RoutineId, companyId: Id, rec: RoutineRecord | undefined, schedules: readonly S[]): S | null {
  const own = schedules.filter((s) => (s.companyId ?? null) === companyId)
  return (rec && own.find((s) => s.id === rec.scheduleId)) || own.find((s) => s.name === routineDef(id).name) || null
}

// ---------- when a routine runs, in plain words (no cron for the person) ----------

/** cron day numbers (0 = Sunday) → the short names links and people use */
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PLURAL_DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
/** Monday first, the order people read a week in */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

/** When a routine runs: a time of day (HH:MM, 24 h) on some days of the week (cron numbers, 0 = Sunday). */
export interface RoutineTime {
  time: string
  days: number[]
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** "0 9 * * 1-5" → { time: '09:00', days: [1..5] }; null when the cron is not a daily time on some weekdays. */
export function routineTimeOf(cron: string): RoutineTime | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*') return null
  const [mi, h] = [Number(f[0]), Number(f[1])]
  if (!/^\d+$/.test(f[0]!) || !/^\d+$/.test(f[1]!) || mi > 59 || h > 23) return null
  const days = new Set<number>()
  if (f[4] === '*') for (let d = 0; d < 7; d++) days.add(d)
  else
    for (const part of f[4]!.split(',')) {
      const m = /^(\d)(?:-(\d))?$/.exec(part)
      if (!m) return null
      const a = Number(m[1]) % 7
      const b = m[2] !== undefined ? Number(m[2]) % 7 : a
      if (Number(m[1]) > 7 || Number(m[2] ?? 0) > 7) return null
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d)
        if (d === b) break
      }
    }
  return { time: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, days: [...days].sort((x, y) => x - y) }
}

/** { time: '06:30', days: [0,2,3,4,5,6] } → "30 6 * * 0,2,3,4,5,6"; null for a bad time or no day. */
export function cronOf(t: RoutineTime): string | null {
  const m = TIME.exec(t.time)
  const days = [...new Set(t.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y)
  if (!m || !days.length) return null
  return `${Number(m[2])} ${Number(m[1])} * * ${days.length === 7 ? '*' : days.join(',')}`
}

/** "Weekdays at 9:00", "Every day at 6:30", "Tue to Sun at 6:30", "Mon, Wed and Fri at 10:00". */
export function cadenceOf(t: RoutineTime): string {
  const m = TIME.exec(t.time)
  const at = m ? `${Number(m[1])}:${m[2]}` : t.time
  const set = new Set(t.days)
  const ordered = WEEK_ORDER.filter((d) => set.has(d))
  const is = (xs: number[]): boolean => xs.length === set.size && xs.every((d) => set.has(d))
  let days: string
  if (set.size === 7) days = 'Every day'
  else if (is([1, 2, 3, 4, 5])) days = 'Weekdays'
  else if (is([0, 6])) days = 'Weekends'
  else if (ordered.length === 1) days = PLURAL_DAYS[ordered[0]!]!
  else {
    // a run of consecutive days in week order reads "Tue to Sun"
    const idx = ordered.map((d) => WEEK_ORDER.indexOf(d as (typeof WEEK_ORDER)[number]))
    const run = ordered.length >= 3 && idx.every((x, i) => i === 0 || x === idx[i - 1]! + 1)
    const names = ordered.map((d) => DAY_NAMES[d]!)
    days = run ? `${names[0]} to ${names.at(-1)}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  }
  return `${days} at ${at}`
}

/** A link's `days` ("tue-sun", "mon,wed,fri", "weekdays", "daily", "weekends") → cron day numbers; null when unreadable. */
export function parseDays(s: string): number[] | null {
  const v = s.trim().toLowerCase()
  if (!v || v.length > 40) return null
  if (v === 'daily' || v === 'every-day' || v === 'everyday') return [0, 1, 2, 3, 4, 5, 6]
  if (v === 'weekdays') return [1, 2, 3, 4, 5]
  if (v === 'weekends') return [0, 6]
  const key = (k: string): number => DAY_KEYS.indexOf(k as (typeof DAY_KEYS)[number])
  const out = new Set<number>()
  for (const part of v.split(',')) {
    const m = /^([a-z]{3})(?:-([a-z]{3}))?$/.exec(part)
    if (!m) return null
    const a = key(m[1]!)
    const b = m[2] ? key(m[2]) : a
    if (a < 0 || b < 0) return null
    // ranges follow the week from Monday: tue-sun is Tue..Sun
    const ia = WEEK_ORDER.indexOf(a as (typeof WEEK_ORDER)[number])
    const ib = WEEK_ORDER.indexOf(b as (typeof WEEK_ORDER)[number])
    if (ib < ia) return null
    for (let i = ia; i <= ib; i++) out.add(WEEK_ORDER[i]!)
  }
  return [...out].sort((x, y) => x - y)
}

/** A link's `at` ("6:30", "06:30") → "06:30"; null when it is not a time of day. */
export function parseAt(s: string): string | null {
  const m = TIME.exec(s.trim())
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null
}
