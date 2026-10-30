/**
 * AUTOPILOT.md §8: "What is Autopilot doing?" for one company, in plain words. The header chip's panel shows it: who
 * starts work on their own, what they start next and why it waits ("LL-3 starts when you approve LL-1"), which
 * schedules run and when, what is on autopilot (each playbook with its level and limits), the limits (tasks at once,
 * the monthly cap) and what it did lately. Pure: main gathers the rows (playbooks:overview), this words them, so the
 * rules mirror the dispatcher's (company/dispatcher.ts) in one place a test can read.
 */
import { DEFAULT_MAX_IN_FLIGHT, atInFlightLimit, limitHeld, tasksAtOnceLine, type LimitWait } from './company'
import { levelLabel, limitsLine, playbookDef, type PlaybookView } from './autopilotPlaybooks'

export interface OverviewAgent {
  id: string
  name: string
  department: string | null
  /** acts on its own (`autonomy: 'auto'`, headless, active) */
  auto: boolean
  active: boolean
}
export interface OverviewTask {
  id: string
  identifier: string
  title: string
  status: string
  blockReason?: string | null
  agentId: string | null
  dependencyIds: readonly string[]
  priority: number
  /** a plan's task (its pilot starts it, never the dispatcher) */
  plan?: boolean
  /** the founder paused this task (it waits for Start) */
  heldByYou?: boolean
  /** waiting in To do for its restart at the usage limit's reset */
  limitWait?: LimitWait | null
  /** a schedule's standing card */
  scheduleCard?: boolean
}
export interface OverviewSchedule {
  name: string
  enabled: boolean
  sentence: string
  nextFireAt: string | null
  /** the agent it wakes, when it is a task-mode schedule */
  agentName?: string | null
  /** it belongs to a playbook (listed under On autopilot instead) */
  playbook?: boolean
}
export interface OverviewEvent {
  at: string
  line: string
}
export interface OverviewInput {
  companyName: string
  switchOn: boolean
  paused: boolean
  maxInFlight?: number
  monthlyCap?: number | null
  agents: readonly OverviewAgent[]
  tasks: readonly OverviewTask[]
  schedules: readonly OverviewSchedule[]
  playbooks: readonly PlaybookView[]
  lately: readonly OverviewEvent[]
}

export interface AutopilotOverview {
  /** one sentence: what runs by itself right now */
  headline: string
  /** agents that start work on their own ("Marcus (Marketing)"); empty with the switch off */
  starters: string[]
  /** agents that wait for Start */
  manual: string[]
  /** what starts next and why it waits, up to 6 */
  next: { ref: string; title: string; who: string | null; why: string }[]
  /** schedules that run, with when */
  schedules: { name: string; when: string; next: string | null }[]
  /** playbooks on, with their level and limits */
  onAutopilot: { name: string; state: string; level: string; limits: string; cadence: string; lastLine: string | null }[]
  /** "Up to 3 tasks at once · monthly cap $200" */
  limits: string
  /** what it did lately, newest first */
  lately: OverviewEvent[]
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Words for one company's Autopilot. Deterministic for the same rows. */
export function autopilotOverview(i: OverviewInput): AutopilotOverview {
  const max = typeof i.maxInFlight === 'number' && i.maxInFlight >= 1 ? i.maxInFlight : DEFAULT_MAX_IN_FLIGHT
  const limits = `${tasksAtOnceLine(max)} · ${i.monthlyCap ? `monthly cap $${i.monthlyCap}` : 'no monthly cap'}`
  const agentById = new Map(i.agents.map((a) => [a.id, a]))
  const taskById = new Map(i.tasks.map((t) => [t.id, t]))
  const label = (a: OverviewAgent): string => (a.department ? `${a.name} (${a.department})` : a.name)
  const active = i.agents.filter((a) => a.active)
  const autoAgents = active.filter((a) => a.auto)
  const starters = i.switchOn && !i.paused ? autoAgents.map(label) : []
  const manual = active.filter((a) => !a.auto || !i.switchOn).map(label)
  const inFlight = i.tasks.filter((t) => t.status === 'in_progress').length

  // what starts next: To do work of an agent, and work blocked on its dependencies
  const next: AutopilotOverview['next'] = []
  const rank = (p: number): number => (p >= 1 && p <= 4 ? p : 5)
  const waiting = i.tasks
    .filter((t) => !t.plan && t.agentId && (t.status === 'todo' || (t.status === 'blocked' && t.blockReason === 'deps')))
    .sort((a, b) => rank(a.priority) - rank(b.priority))
  const firstOf = new Set<string>()
  for (const t of waiting) {
    if (next.length >= 6) break
    const a = agentById.get(t.agentId!)
    if (!a || !a.active) continue
    const deps = t.dependencyIds.map((d) => taskById.get(d)).filter((d): d is OverviewTask => !!d && d.status !== 'done' && d.status !== 'canceled')
    let why: string
    if (deps.length) {
      const d = deps[0]!
      why = d.status === 'in_review' ? `starts when you approve ${d.identifier}` : d.status === 'in_progress' ? `starts when ${d.identifier} is done` : `waits for ${d.identifier} first`
      if (deps.length > 1) why += ` (and ${plural(deps.length - 1, 'other task')})`
    } else if (t.heldByYou) why = 'you paused it: it waits for your Start'
    else if (i.paused) why = `${i.companyName} is paused: nothing starts until you resume it`
    else if (limitHeld(t)) why = 'waits for the usage limit to reset, then restarts by itself'
    else if (!a.auto && !t.scheduleCard) why = `${a.name} works only when you press Start`
    else if (!i.switchOn && !t.scheduleCard) why = 'Autopilot is off: it waits for your Start'
    else if (firstOf.has(a.id)) why = `next in ${a.name}’s queue`
    else if (atInFlightLimit(inFlight, max)) why = `starts when one of the ${plural(inFlight, 'task')} running finishes (up to ${max} at once)`
    else why = 'starts within a minute'
    if (!deps.length) firstOf.add(a.id)
    next.push({ ref: t.identifier, title: t.title, who: a.name, why })
  }

  const schedules = i.schedules
    .filter((s) => s.enabled && !s.playbook)
    .map((s) => ({ name: s.name, when: s.sentence + (s.agentName ? ` · wakes ${s.agentName}` : ''), next: s.nextFireAt }))

  const onAutopilot = i.playbooks
    .filter((v) => v.on)
    .map((v) => {
      const def = playbookDef(v.id)
      const state = v.waiting ? `Waiting for ${v.waiting.label}` : v.running ? `Runs${v.agentName ? `, by ${v.agentName}` : ''}` : v.pausedWhy ?? 'Paused'
      return { name: def.short, state, level: levelLabel(v.level), limits: limitsLine(def, v.limits, v.level) + (def.money ? ' · its runs reach the ads account only through Principia’s checked connections: no terminal, no web requests, no ads keys' : ''), cadence: def.cadence, lastLine: v.nearMisses?.[0]?.line ?? null }
    })

  const running = onAutopilot.filter((p) => p.state.startsWith('Runs')).length
  const waitingConn = i.playbooks.filter((v) => v.on && v.waiting).length
  const parts: string[] = []
  if (i.paused) parts.push(`${i.companyName} is paused, so nothing starts by itself`)
  else {
    parts.push(starters.length ? `${plural(starters.length, 'agent')} start${starters.length === 1 ? 's' : ''} assigned work on ${starters.length === 1 ? 'its' : 'their'} own` : i.switchOn ? 'No agent is set to work on its own yet' : 'Agents wait for you to press Start')
    if (schedules.length) parts.push(`${plural(schedules.length, 'schedule')} run${schedules.length === 1 ? 's' : ''}`)
    if (running) parts.push(`${plural(running, 'playbook')} on autopilot`)
    if (waitingConn) parts.push(`${waitingConn} waiting for ${waitingConn === 1 ? 'its connection' : 'their connections'}`)
  }
  return {
    headline: `${parts.join(' · ')}.`,
    starters,
    manual,
    next,
    schedules,
    onAutopilot,
    limits,
    lately: [...i.lately].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 6)
  }
}

/** "in 2 h", "tomorrow 9:00", "Mon 8:00": a short when for a next fire. */
export function whenShort(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000)
  if (mins < 0) return 'due now'
  if (mins < 60) return `in ${Math.max(1, mins)} min`
  if (mins < 12 * 60) return `in ${Math.round(mins / 60)} h`
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hm}`
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`
}
