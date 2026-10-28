/**
 * Pure helpers for the onboarding screens (docs/ONBOARDING.md §2, §9): copy built from the plan, keyboard decisions,
 * plan edits. No React, no store, no IPC, so they are unit-tested (model.test.ts).
 */
import { CLAUDE_PLAN_PRICES, claudePlanLabel, onPlan, type ClaudeAuthStatus } from '@shared/providerAuth'
import { DEPARTMENT_PRESETS, type DepartmentPresetKey } from '@shared/company'
import {
  GOAL_INFO,
  LAUNCH_STEP_LABELS,
  VIBE_INFO,
  WORKFLOW_KEYS,
  type CadenceKey,
  type JournalScheduleRef,
  type LaunchStepName,
  type LaunchStepState,
  type OnboardingDraft,
  type OnboardingPlan,
  type PlanAgent,
  type PlanSchedule,
  type PlanTask,
  type ProgressEvent,
  type StepKey
} from '@shared/onboarding'
import { planCounts, siteHost } from '@shared/onboardingPlan'
import { PERSONA_LIMITS } from '@shared/personas'
import { t } from '../../lib/voice/core'

// ---------- schedules (§2 S6, S8) ----------

const CADENCE_SENTENCE: Record<CadenceKey, string> = {
  weekdays9: 'Weekdays at 9:00',
  mwf10: 'Mon, Wed, Fri at 10:00',
  mwf1030: 'Mon, Wed, Fri at 10:30',
  mon9: 'Mondays at 9:00',
  fri16: 'Fridays at 16:00',
  daily9: 'Every day at 9:00'
}
const CADENCE_SHORT: Record<CadenceKey, string> = {
  weekdays9: 'Mon–Fri 9:00',
  mwf10: 'Mon/Wed/Fri 10:00',
  mwf1030: 'Mon/Wed/Fri',
  mon9: 'Mon 9:00',
  fri16: 'Fri 16:00',
  daily9: 'Daily 9:00'
}
const RUNS_PER_WEEK: Record<CadenceKey, number> = { weekdays9: 5, mwf10: 3, mwf1030: 3, mon9: 1, fri16: 1, daily9: 7 }
/** §2 S6: an image run makes about this many images. */
export const IMAGES_PER_RUN = 5

/** "Mon, Wed, Fri at 10:00". */
export function cadenceSentence(c: CadenceKey): string {
  return CADENCE_SENTENCE[c]
}
export function cadenceShort(c: CadenceKey): string {
  return CADENCE_SHORT[c]
}
export function runsPerWeek(c: CadenceKey): number {
  return RUNS_PER_WEEK[c]
}

/** Whose credits a paid schedule spends ("fal", "OpenAI", "Firecrawl"), or null when it is free. */
export function scheduleCredits(s: PlanSchedule): string | null {
  if (s.target.kind !== 'workflow') return null
  const info = WORKFLOW_KEYS[s.target.workflow]
  if (!info.costly || !info.key) return null
  return info.key === 'FAL_KEY' ? 'fal' : info.key === 'OPENAI_API_KEY' ? 'OpenAI' : 'Firecrawl'
}

/** True for image workflows (the "≈ N images" cost lines). */
export function isImageSchedule(s: PlanSchedule): boolean {
  if (s.target.kind !== 'workflow') return false
  const k = WORKFLOW_KEYS[s.target.workflow].key
  return k === 'FAL_KEY' || k === 'OPENAI_API_KEY'
}

/** §2 S6 cost line: "≈ 5 images per run · uses your fal credits". null for free schedules. */
export function planCostLine(s: PlanSchedule): string | null {
  const who = scheduleCredits(s)
  if (!who) return null
  return isImageSchedule(s) ? `≈ ${IMAGES_PER_RUN} images per run · uses your ${who} credits` : `Uses your ${who} credits`
}

/** §2 S8 cost line: "≈ 15 images a week on your fal credits". null for free schedules. */
export function weeklyCostLine(s: PlanSchedule): string | null {
  const who = scheduleCredits(s)
  if (!who) return null
  if (!isImageSchedule(s)) return `${runsPerWeek(s.cadence)} runs a week on your ${who} credits`
  return `≈ ${IMAGES_PER_RUN * runsPerWeek(s.cadence)} images a week on your ${who} credits`
}

// ---------- plan structure (§2 S6) ----------

export interface PlanGroup {
  /** null = the company-level card ("Company · No department"). */
  key: DepartmentPresetKey | null
  agents: PlanAgent[]
  tasks: PlanTask[]
  schedules: PlanSchedule[]
}

/** One card per department in plan order, then the company-level card when anything has no department. */
export function groupPlan(plan: OnboardingPlan): PlanGroup[] {
  const groups: PlanGroup[] = plan.departments.map((d) => ({ key: d.key, agents: [], tasks: [], schedules: [] }))
  const company: PlanGroup = { key: null, agents: [], tasks: [], schedules: [] }
  const find = (k: DepartmentPresetKey | null): PlanGroup => (k && groups.find((g) => g.key === k)) || company
  for (const a of plan.agents) find(a.departmentKey).agents.push(a)
  for (const t of plan.tasks) find(t.departmentKey).tasks.push(t)
  for (const s of plan.schedules) find(s.departmentKey).schedules.push(s)
  if (company.agents.length || company.tasks.length || company.schedules.length) groups.push(company)
  return groups
}

export function presetFor(key: DepartmentPresetKey): (typeof DEPARTMENT_PRESETS)[number] | undefined {
  return DEPARTMENT_PRESETS.find((p) => p.key === key)
}

/** "#2" for a task's position among included tasks, used by "after #1" hints. */
export function taskNumbers(plan: OnboardingPlan): Map<string, number> {
  const m = new Map<string, number>()
  let n = 0
  for (const t of plan.tasks) if (t.include) m.set(t.ref, ++n)
  return m
}

/** "after #1" / "after #1, #3" for an included task's included dependencies; null when none. */
export function dependencyHint(plan: OnboardingPlan, t: PlanTask): string | null {
  const nums = taskNumbers(plan)
  const deps = t.dependsOn.map((r) => nums.get(r)).filter((n): n is number => typeof n === 'number')
  return deps.length ? `after ${deps.map((n) => `#${n}`).join(', ')}` : null
}

export type PlanRowKind = 'department' | 'agent' | 'task' | 'schedule'
export interface PlanRowId {
  kind: PlanRowKind
  /** Department key or item ref. */
  ref: string
}
export const rowKey = (r: PlanRowId): string => `${r.kind}:${r.ref}`

/** Rows in display order (↑/↓ move through these). */
export function planRows(plan: OnboardingPlan): PlanRowId[] {
  const out: PlanRowId[] = []
  for (const g of groupPlan(plan)) {
    if (g.key) out.push({ kind: 'department', ref: g.key })
    for (const a of g.agents) out.push({ kind: 'agent', ref: a.ref })
    for (const t of g.tasks) out.push({ kind: 'task', ref: t.ref })
    for (const s of g.schedules) out.push({ kind: 'schedule', ref: s.ref })
  }
  return out
}

function clone(plan: OnboardingPlan): OnboardingPlan {
  return JSON.parse(JSON.stringify(plan)) as OnboardingPlan
}

/** Space: flips `include` on a row. */
export function toggleInclude(plan: OnboardingPlan, row: PlanRowId): OnboardingPlan {
  const p = clone(plan)
  const list = row.kind === 'department' ? p.departments.map((d) => ({ id: d.key as string, it: d })) : itemsOf(p, row.kind).map((it) => ({ id: it.ref, it }))
  const hit = list.find((x) => x.id === row.ref)
  if (hit) hit.it.include = !hit.it.include
  return p
}

function itemsOf(p: OnboardingPlan, kind: Exclude<PlanRowKind, 'department'>): (PlanAgent | PlanTask | PlanSchedule)[] {
  return kind === 'agent' ? p.agents : kind === 'task' ? p.tasks : p.schedules
}

/** ↵ rename: a blank or unchanged name returns the plan unchanged. Names are capped to the schema limits. */
export function renameRow(plan: OnboardingPlan, row: PlanRowId, raw: string): OnboardingPlan {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return plan
  const p = clone(plan)
  if (row.kind === 'department') {
    const d = p.departments.find((x) => x.key === row.ref)
    if (!d || d.name === name) return plan
    d.name = name.slice(0, 40)
  } else if (row.kind === 'agent') {
    const a = p.agents.find((x) => x.ref === row.ref)
    if (!a || a.name === name) return plan
    a.name = name.slice(0, 40)
  } else if (row.kind === 'task') {
    const t = p.tasks.find((x) => x.ref === row.ref)
    if (!t || t.title === name) return plan
    t.title = name.slice(0, 120)
  } else {
    const s = p.schedules.find((x) => x.ref === row.ref)
    if (!s || s.name === name) return plan
    s.name = name.slice(0, 60)
  }
  return p
}

/** The text a row's rename field starts with. */
export function rowName(plan: OnboardingPlan, row: PlanRowId): string {
  if (row.kind === 'department') return plan.departments.find((d) => d.key === row.ref)?.name ?? ''
  if (row.kind === 'task') return plan.tasks.find((t) => t.ref === row.ref)?.title ?? ''
  if (row.kind === 'agent') return plan.agents.find((a) => a.ref === row.ref)?.name ?? ''
  return plan.schedules.find((s) => s.ref === row.ref)?.name ?? ''
}

/**
 * ⌫ / ×: tasks and schedules are removed (a removed task leaves the `dependsOn` of others); departments and agents
 * are switched off instead, because other items point at them.
 */
export function removeRow(plan: OnboardingPlan, row: PlanRowId): OnboardingPlan {
  const p = clone(plan)
  if (row.kind === 'task') {
    if (!p.tasks.some((t) => t.ref === row.ref)) return plan
    p.tasks = p.tasks.filter((t) => t.ref !== row.ref).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== row.ref) }))
    return p
  }
  if (row.kind === 'schedule') {
    if (!p.schedules.some((s) => s.ref === row.ref)) return plan
    p.schedules = p.schedules.filter((s) => s.ref !== row.ref)
    return p
  }
  const cur = row.kind === 'department' ? p.departments.find((d) => d.key === row.ref) : p.agents.find((a) => a.ref === row.ref)
  if (!cur || !cur.include) return plan
  cur.include = false
  return p
}

export function isRemovable(row: PlanRowId): boolean {
  return row.kind === 'task' || row.kind === 'schedule'
}

// ---------- the team (VOICE.md §4.4, §5.7 "Meet your team") ----------

/**
 * Rename an agent's persona (the plinth's Rename): whitespace collapsed, capped at 24, and refused (plan unchanged)
 * when blank, unchanged, or already another plan agent's persona name (case-insensitive), since finalizePlan would
 * otherwise quietly re-pick it at launch. The role label (`agent.name`) is never touched.
 */
export function renamePersona(plan: OnboardingPlan, ref: string, raw: string): OnboardingPlan {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, PERSONA_LIMITS.name).trim()
  const a = plan.agents.find((x) => x.ref === ref)
  if (!name || !a?.persona || a.persona.name === name) return plan
  const lower = name.toLowerCase()
  if (plan.agents.some((x) => x.ref !== ref && x.persona?.name.trim().toLowerCase() === lower)) return plan
  const p = clone(plan)
  const hit = p.agents.find((x) => x.ref === ref)!
  hit.persona = { ...hit.persona!, name }
  return p
}

/** The first included task assigned to an agent (the plinth's "First task: …"), or null. */
export function firstTaskFor(plan: OnboardingPlan, agentRef: string): PlanTask | null {
  return plan.tasks.find((t) => t.include && t.agentRef === agentRef) ?? null
}

/** The department's display name for an agent ("Marketing"), or null for company-level agents. */
export function departmentNameOf(plan: OnboardingPlan, key: DepartmentPresetKey | null): string | null {
  if (!key) return null
  return plan.departments.find((d) => d.key === key)?.name ?? presetFor(key)?.name ?? null
}

export interface TeamMember {
  ref: string
  /** the persona name with personas on (and a persona present), else the role label */
  name: string
  /** the role label ("Copywriter") */
  role: string
  /** "Copywriter · Marketing" */
  roleLine: string
  department: string | null
  persona: PlanAgent['persona'] | null
  personality: string | null
  firstTask: string | null
  include: boolean
  auto: boolean
}

/** The plan's agents as people (plan order). `includedOnly` for the ceremony, which shows only who was created. */
export function teamOf(plan: OnboardingPlan, personasOn: boolean, includedOnly = false): TeamMember[] {
  return plan.agents
    .filter((a) => !includedOnly || a.include)
    .map((a) => {
      const department = departmentNameOf(plan, a.departmentKey)
      const persona = personasOn && a.persona ? a.persona : null
      return {
        ref: a.ref,
        name: persona?.name ?? a.name,
        role: a.name,
        roleLine: department ? `${a.name} · ${department}` : a.name,
        department,
        persona,
        personality: persona?.personality || null,
        firstTask: firstTaskFor(plan, a.ref)?.title ?? null,
        include: a.include,
        auto: a.auto
      }
    })
}

/**
 * VOICE.md §8: who the ceremony presents: the included agents, but nobody when the launch made no agents (the beta
 * switch off, or the team step skipped), so the plinths and the autopilot line never show a team that doesn't exist.
 * `facts` null (no launch record to hand) trusts the plan.
 */
export function ceremonyTeam(plan: OnboardingPlan, personasOn: boolean, facts: Pick<LaunchFacts, 'agents'> | null): TeamMember[] {
  if (facts && facts.agents === 0) return []
  return teamOf(plan, personasOn, true)
}

/**
 * VOICE.md §8: what the ceremony's polite live region reads, always plain (t.sr): the title, then one line per agent.
 * No Latin, no jokes.
 */
export function ceremonyLines(team: readonly TeamMember[], name?: string): string[] {
  // no agents were created: "Acme is set up." rather than announcing a team that isn't there
  const title = !team.length && name ? t.sr('cer.title.none', { name }) : t.sr('cer.title')
  return [
    title,
    ...team.map((m) => {
      // with personas off the name already is the role: "Copywriter, Copywriter" would read as a stutter
      const persona = m.persona ? m.name : m.role
      const role = m.persona ? m.role : (m.department ?? m.role)
      return m.firstTask ? t.sr('cer.agent', { persona, role, task: m.firstTask }) : t.sr('cer.agent.none', { persona, role })
    })
  ]
}

/** VOICE.md §8: the ceremony follows Start now (autopilot) in playful tone only; plain and I'll review first skip it. */
export function wantsCeremony(autopilot: boolean, tone: 'playful' | 'plain'): boolean {
  return autopilot && tone === 'playful'
}

/**
 * The ceremony's dialog label: "Your team is set up" (cer.title without the full stop), or "Acme is set up" when
 * the launch created no agents and a name is given.
 */
export function ceremonyLabel(name?: string, empty = false): string {
  return (empty && name ? t.sr('cer.title.none', { name }) : t.sr('cer.title')).replace(/[.\s]+$/, '')
}

// ---------- passport tablet meta (rail and Ready) ----------

/** "Launch a website" → "Website" (the tablet's short goal list). */
export function shortGoal(label: string): string {
  const short = label.replace(/^(Get first |Launch a |Post on |Run |Get found on |Fix bugs & |Customer )/, '').replace(/…$/, '')
  return short.charAt(0).toUpperCase() + short.slice(1)
}

/** The tablet's meta rows as the answers come in: Stack, Site (or Instagram), then Voice and Goals once past Voice. */
export function passportMeta(d: OnboardingDraft, goals: readonly (keyof typeof GOAL_INFO)[]): { label: string; value: string }[] {
  const meta: { label: string; value: string }[] = []
  if (d.hasCode && d.scan?.stack.length) meta.push({ label: 'Stack', value: d.scan.stack.slice(0, 2).join(' · ') })
  const host = siteHost(d.answers.siteUrl)
  if (host) meta.push({ label: 'Site', value: host })
  else if (d.answers.instagram) meta.push({ label: 'Instagram', value: d.answers.instagram })
  const pastVoice = ['goals', 'content', 'plan', 'launching', 'failed', 'ready'].includes(d.step)
  if (pastVoice && d.answers.voiceVibe) meta.push({ label: 'Voice', value: VIBE_INFO[d.answers.voiceVibe].label })
  if (pastVoice && goals.length) meta.push({ label: 'Goals', value: goals.slice(0, 3).map((g) => shortGoal(GOAL_INFO[g].label)).join(' · ') })
  return meta
}

// ---------- Ready step (§2 S8) ----------

/**
 * What the launch actually made, counted from the journal's created items (a skipped or degraded step makes less
 * than the plan: no departments without the beta switch, no schedules when that step was skipped). null: unknown.
 */
export interface LaunchFacts {
  departments: number
  agents: number
  tasks: number
  schedules: number
  notes: number
  /** The passport step ran (vault on, not skipped). */
  passport: boolean
}
export function launchFacts(steps: readonly LaunchStepState[] | undefined | null): LaunchFacts | null {
  if (!steps?.length) return null
  const count = (name: LaunchStepName, kind: string): number => steps.find((s) => s.name === name)?.created.filter((c) => c.kind === kind).length ?? 0
  const passportStep = steps.find((s) => s.name === 'passport')
  return {
    departments: count('departments', 'department'),
    agents: count('agents', 'agent'),
    tasks: count('tasks', 'task'),
    schedules: count('schedules', 'schedule'),
    notes: count('passport', 'note'),
    passport: passportStep?.status === 'done' && passportStep.created.some((c) => c.kind === 'note')
  }
}

/** "3 departments · 4 agents · 6 tasks · 2 schedules (off)". With launch facts, what was really created. */
export function summaryParts(plan: OnboardingPlan, scheduleCount?: number, facts?: LaunchFacts | null): string[] {
  const c = facts ?? planCounts(plan)
  const n = (v: number, one: string, many: string): string => `${v} ${v === 1 ? one : many}`
  const schedules = facts ? facts.schedules : (scheduleCount ?? c.schedules)
  const out: string[] = []
  if (c.departments) out.push(n(c.departments, 'department', 'departments'))
  if (c.agents) out.push(n(c.agents, 'agent', 'agents'))
  out.push(n(c.tasks, 'task', 'tasks'))
  if (schedules) out.push(`${n(schedules, 'schedule', 'schedules')} (off)`)
  return out
}

/**
 * "Will start on their own: Marcus (Copywriter). Ask first: Aurelia (Lead researcher)." With personas off (or an agent
 * without one) just the role label. null when no agent was made (`agentsCreated` false).
 */
export function autonomyLine(plan: OnboardingPlan, agentsCreated = true, personasOn = true): string | null {
  if (!agentsCreated) return null
  const agents = plan.agents.filter((a) => a.include)
  if (!agents.length) return null
  const label = (a: PlanAgent): string => (personasOn && a.persona?.name ? `${a.persona.name} (${a.name})` : a.name)
  const auto = agents.filter((a) => a.auto).map(label)
  const ask = agents.filter((a) => !a.auto).map(label)
  const parts: string[] = []
  if (auto.length) parts.push(`Will start on their own: ${auto.join(', ')}.`)
  if (ask.length) parts.push(`Ask first: ${ask.join(', ')}.`)
  return parts.join(' ')
}

export interface ReadySchedule {
  id: string
  ref: string
  label: string
  /** Free schedules start checked; paid ones unchecked with a cost line. */
  costly: boolean
  cost: string | null
}

/** The created schedules (journal refs) with their plan names: "Weekly company review · Fri 16:00". */
export function readySchedules(plan: OnboardingPlan, refs: readonly JournalScheduleRef[]): ReadySchedule[] {
  const out: ReadySchedule[] = []
  for (const r of refs) {
    const s = plan.schedules.find((x) => x.ref === r.ref)
    if (!s) continue
    out.push({ id: r.id, ref: r.ref, label: `${s.name} · ${cadenceShort(s.cadence)}`, costly: r.costly || !!scheduleCredits(s), cost: weeklyCostLine(s) })
  }
  return out
}

/**
 * §2 S8 "What happens next": three bullets built from the plan. Only promises what was made: no agent line when no
 * agent was created (`agentsCreated` false), "starts" only for agents that work on their own once you start, and the
 * passport line only when its notes were written (`notes`, else the settings line).
 */
export function nextSteps(opts: { plan: OnboardingPlan; name: string; repoNames: string[]; passport: boolean; agentsCreated?: boolean; notes?: number }): string[] {
  const { plan, name } = opts
  const out: string[] = []
  const tasks = plan.tasks.filter((t) => t.include)
  const agents = new Map(opts.agentsCreated === false ? [] : plan.agents.filter((a) => a.include).map((a) => [a.ref, a]))
  const withAgent = (auto: boolean): PlanTask | undefined => tasks.find((t) => t.agentRef && agents.get(t.agentRef)?.auto === auto)
  const first = withAgent(true) ?? withAgent(false) ?? tasks[0]
  if (first) {
    const agent = first.agentRef ? agents.get(first.agentRef) : undefined
    const where = first.where === 'repo' && opts.repoNames[0] ? ` in ${opts.repoNames[0]}` : ''
    const title = `“${trimTitle(first.title)}”${where}`
    out.push(
      !agent
        ? `“${trimTitle(first.title)}” is waiting on the board. Assign it when you're ready.`
        : agent.auto
          ? `Once you start, the ${agent.name} works on ${title}. You'll see the result in Needs you.`
          : `${title} is assigned to the ${agent.name}, who asks you before starting.`
    )
  } else {
    out.push('Your board is empty for now. Add a task when you are ready.')
  }
  out.push('Everything agents make lands in review. Nothing is posted, sent or paid without you.')
  const notes = opts.notes ?? 5 + opts.repoNames.length
  if (opts.passport && notes > 0) {
    out.push(`Knowledge has ${notes} ${notes === 1 ? 'note' : 'notes'} about ${name || 'your business'}. Agents read them before every task. Edit them under Knowledge.`)
  } else {
    out.push(`Your answers are saved in ${name || 'the company'}'s settings. Edit them any time under Company Settings.`)
  }
  return out
}

function trimTitle(t: string): string {
  return t.length > 80 ? `${t.slice(0, 79)}…` : t
}

// ---------- launch list (§2 S7) ----------

export interface LaunchRow {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  detail?: string
  error?: string
  /** The journal step a Retry / Continue without this acts on. */
  step: LaunchStepName
}

const ROW_STEPS: { key: string; label: string; steps: LaunchStepName[] }[] = [
  { key: 'flags', label: LAUNCH_STEP_LABELS.flags, steps: ['flags'] },
  { key: 'company', label: 'Company', steps: ['company'] },
  { key: 'code', label: 'Code', steps: ['code'] },
  { key: 'keys', label: 'Keys', steps: ['keys'] },
  { key: 'passport', label: 'Passport', steps: ['passport'] },
  { key: 'workflows', label: 'Workflows', steps: ['workflows'] },
  { key: 'team', label: 'Team', steps: ['departments', 'agents'] },
  { key: 'tasks', label: 'Tasks', steps: ['tasks'] },
  { key: 'schedules', label: 'Schedules', steps: ['schedules'] },
  { key: 'finish', label: LAUNCH_STEP_LABELS.finish, steps: ['finish'] }
]

/**
 * The live list: Company · Code · Keys · Passport · Workflows · Team · Tasks · Schedules. Code shows only with code,
 * Keys only with a key to save, Passport and Team only with the beta switch on; "Beta features" and "Finishing up"
 * appear only when they have something to say (running long or failed).
 */
export function launchRows(
  events: Partial<Record<LaunchStepName, ProgressEvent>>,
  opts: { hasCode: boolean; hasKey: boolean; departments: boolean }
): LaunchRow[] {
  const rows: LaunchRow[] = []
  for (const r of ROW_STEPS) {
    const evs = r.steps.map((s) => events[s]).filter((e): e is ProgressEvent => !!e)
    const visible =
      r.key === 'flags' || r.key === 'finish'
        ? evs.some((e) => e.status === 'failed')
        : r.key === 'code'
          ? opts.hasCode || evs.length > 0
          : r.key === 'keys'
            ? opts.hasKey || evs.length > 0
            : r.key === 'passport' || r.key === 'team'
              ? opts.departments || evs.some((e) => e.status !== 'skipped')
              : true
    if (!visible) continue
    const failed = evs.find((e) => e.status === 'failed')
    const running = evs.find((e) => e.status === 'running')
    const allDone = evs.length === r.steps.length && evs.every((e) => e.status === 'done' || e.status === 'skipped')
    const status: LaunchRow['status'] = failed
      ? 'failed'
      : running
        ? 'running'
        : allDone
          ? evs.every((e) => e.status === 'skipped')
            ? 'skipped'
            : 'done'
          : evs.length
            ? 'running'
            : 'pending'
    const last = failed ?? running ?? evs[evs.length - 1]
    rows.push({
      key: r.key,
      label: r.label,
      status,
      step: (failed ?? running)?.step ?? r.steps[r.steps.length - 1]!,
      ...(last?.detail ? { detail: last.detail } : {}),
      ...(failed?.error ? { error: failed.error } : {})
    })
  }
  return rows
}

/** "Couldn't create the schedules: <reason>". */
export function failureLine(row: LaunchRow): string {
  const what: Record<string, string> = {
    flags: 'turn on the beta features',
    company: 'create the company',
    code: 'connect the code',
    keys: 'save the key',
    passport: 'write the passport',
    workflows: 'install the workflows',
    team: 'create the team',
    tasks: 'create the tasks',
    schedules: 'create the schedules',
    finish: 'finish the setup'
  }
  return `Couldn't ${what[row.key] ?? 'finish this step'}${row.error ? `: ${row.error}` : '.'}`
}

// ---------- Name step, Connect step ----------

/** "@sundaybakery", "instagram.com/sundaybakery" → an Instagram handle (saved as a link, never fetched). */
export function instagramHandle(raw: string): string | null {
  const s = raw.trim()
  const at = /^@([A-Za-z0-9._]{1,30})$/.exec(s)
  if (at) return `@${at[1]}`
  const url = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i.exec(s)
  return url ? `@${url[1]}` : null
}

/** A typed website as a fetchable http(s) URL ("sundaybakery.com" → "https://sundaybakery.com"), or null. */
export function siteFetchUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s || instagramHandle(s)) return null
  if (!siteHost(s)) return null
  if (/^https?:\/\//i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null
  return `https://${s}`
}

/** "/Users/me/Projects/a/very/long/path/acme-web" → "~/Projects/…/path/acme-web" style middle truncation. */
export function middleTruncate(s: string, max = 48): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

// ---------- keyboard (§2, §9) ----------

export type FlowKey = 'primary' | 'back' | 'close' | null

/**
 * The flow-wide meaning of a keydown (handled in the bubble phase, after the step's own handlers, which claim keys
 * with preventDefault):
 * - ⌘↵ anywhere, ↵ in a single-line field or on a non-control target → primary;
 * - ⌘[ anywhere, ⌥← outside text fields → back;
 * - Esc → close (save and close; the store refuses on first run and while launching).
 */
export function flowKey(e: { key: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }, target: { tag: string; type?: string; role?: string | null; editable?: boolean; enterPrimary?: boolean }): FlowKey {
  const tag = target.tag.toLowerCase()
  const textField = tag === 'textarea' || target.editable === true || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit'].includes((target.type ?? 'text').toLowerCase()))
  if (e.key === 'Enter') {
    if (e.ctrlKey || e.altKey || e.shiftKey) return null
    if (e.metaKey) return 'primary'
    if (tag === 'textarea' || target.editable) return null
    if (tag === 'input') return textField ? 'primary' : null
    // a choice / vibe card continues: arrows and digits already picked it
    if (target.enterPrimary) return 'primary'
    if (tag === 'button' || tag === 'a' || tag === 'select' || target.role === 'switch' || target.role === 'checkbox' || target.role === 'option') return null
    return 'primary'
  }
  if (e.key === '[' && e.metaKey && !e.altKey && !e.ctrlKey) return 'back'
  if (e.key === 'ArrowLeft' && e.altKey && !e.metaKey && !e.ctrlKey && !textField) return 'back'
  if (e.key === 'Escape' && !e.metaKey && !e.altKey && !e.ctrlKey) return 'close'
  return null
}

/** App-wide ⌘/⌃ chords (shell/keyboard.ts) that must not reach the app while the flow is open. */
export function blocksAppChord(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  if (e.ctrlKey && !e.metaKey && /^Digit[0-9]$/.test(e.code)) return true
  if (!e.metaKey || e.ctrlKey) return false
  if (/^Digit[0-9]$/.test(e.code)) return true
  // ⌘⇧A Agents, ⌘⇧L Slack (plain ⌘A / ⌘L stay native: select all, etc.)
  if (e.code === 'KeyA' || e.code === 'KeyL') return e.shiftKey && !e.altKey
  return ['KeyJ', 'KeyK', 'KeyN', 'KeyO', 'KeyB', 'KeyW', 'Comma', 'Equal', 'Minus'].includes(e.code)
}

/** A digit key 1–9 with no modifier → its number, else null (chip / vibe hotkeys). */
export function digitKey(e: { key: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean }): number | null {
  if (e.metaKey || e.altKey || e.ctrlKey) return null
  return /^[1-9]$/.test(e.key) ? Number(e.key) : null
}

/** Roving focus in a grid of `count` cells, `cols` wide: the next index for an arrow key, or null. */
export function gridMove(index: number, key: string, count: number, cols: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, index + 1)
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'ArrowDown':
      return index + cols < count ? index + cols : index
    case 'ArrowUp':
      return index - cols >= 0 ? index - cols : index
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * Whether the step shows the progress row and counts toward "Step n of 6". The opening question ("Where does your
 * business live today?") shows none: Step 1 is the page it leads to (name, connect or brief), so Continue never lands
 * on a page that still says "Step 1 of 6".
 */
export function showsProgress(step: StepKey): boolean {
  return step !== 'start' && step !== 'launching' && step !== 'failed' && step !== 'ready'
}

const AGENT_LOGIN: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }
/** Whose login the agents run on: Claude Code when installed (the plan's default), else the first installed agent. */
export function agentLogin(adapters: readonly string[]): string {
  const id = adapters.includes('claude') ? 'claude' : adapters.find((a) => a in AGENT_LOGIN)
  return id ? AGENT_LOGIN[id] : 'Claude Code'
}

/** Five doors step 5 (E12): the Claude check's line on the last setup steps (ClaudeCheck.tsx). */
export function claudeCheckLine(auth: Pick<ClaudeAuthStatus, 'state' | 'method' | 'plan'> | null): { ok: boolean | null; text: string } {
  if (!auth) return { ok: null, text: 'Checking Claude on this Mac…' }
  if (auth.state === 'ok') {
    const plan = claudePlanLabel(auth.plan)
    if (onPlan(auth) === false) return { ok: true, text: 'Claude is signed in on this Mac with an API key: Anthropic bills each use. Principia adds nothing.' }
    return { ok: true, text: `Runs on your Claude ${plan ?? 'plan'}. No extra charge from Principia. Claude is signed in on this Mac.` }
  }
  if (auth.state === 'signedOut') return { ok: false, text: `Sign in to Claude, or get a plan: Claude Code isn’t signed in on this Mac, so your team can’t start yet. A Claude app sign-in doesn’t carry over: click Sign in to Claude and approve in your browser. ${CLAUDE_PLAN_PRICES}` }
  if (auth.state === 'missing') return { ok: false, text: `Claude Code isn’t installed on this Mac, so your team can’t start yet. Install it and sign in with a Claude plan. ${CLAUDE_PLAN_PRICES}` }
  return { ok: null, text: 'Runs on your Claude plan. No extra charge from Principia. This Claude Code can’t tell us whether you’re signed in.' }
}
