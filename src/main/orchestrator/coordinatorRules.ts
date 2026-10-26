/**
 * ORCHESTRATOR.md §3: the chief of staff's rules. Pure: one batch of events and a snapshot of the company in, the
 * decisions out (closed verbs only), plus the reasons a model might help ("ambiguous"). The coordinator runs these
 * first, always; the model call (coordinatorCall.ts) only adds to them, for the ambiguous part, in model mode.
 *
 * | when | then |
 * |---|---|
 * | a task is done and others waited for it | pump (start what is ready) |
 * | a follow-up was filed for an agent who waits to be started | suggest starting it (Needs you) |
 * | a run report suggests the same routine 3 times (14 days) | suggest the routine |
 * | a run needs a connection (blocker or suggestion) | suggest the connection, with its link |
 * | a run report suggests a task | suggest the task |
 * | a run did work that should keep running (ads launched, a site deployed: its tools, words, department, or the
 *   report's `recurring` hint), or the daily tick finds a connection a playbook fits | offer the autopilot (Needs you) |
 * | the daily tick, and something happened | digest post in the Team room |
 * | a person posted, a run made progress with no next step, a done task left an agent with nothing to do | ambiguous |
 */
import type { OrchDecision, OrchEvent, RunReport } from '../../shared/orchestrator'
import { matchPlaybooks, OFFER_MAX_LEVEL, offerDetail, offerTitle, playbookDef, type PlaybookLevel, type PlaybookSignals } from '../../shared/autopilotPlaybooks'

export const ROUTINE_REPEATS = 3
const DAY = 86_400_000
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
export const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface RulesTask {
  id: string
  identifier: string
  title: string
  status: string
  blockReason: string | null
  agentId: string | null
  dependencyIds: string[]
  source: string
  externalId: string | null
  /** an open question to the founder */
  asks: boolean
  updatedAt: string
}
export interface RulesAgent { id: string; name: string; handle: string | null; auto: boolean; paused: boolean }
export interface RulesReport {
  runId: string
  taskId: string | null
  agentId: string | null
  report: RunReport
  at: string
  /** the tools the run called (agent_events), for the autopilot offers */
  tools?: string[]
  /** the department key of the run's task or agent */
  departmentKey?: string | null
}

export interface RulesInput {
  companyId: string
  now: string
  events: OrchEvent[]
  tasks: RulesTask[]
  agents: RulesAgent[]
  autopilot: boolean
  /** the reports of the runs in this batch (run_ended) */
  reports: RulesReport[]
  /** routine suggestions in run reports of the last 14 days, this batch's included */
  routineHistory: { text: string; cron?: string; at: string }[]
  /** the last digest post of this company */
  lastDigestAt: string | null
  /** connections that reach the company (MCP ids, key names, accounts), for the autopilot offers on the tick */
  connections?: string[]
  /** playbooks already on (or paused) for the company: never offered */
  playbooksOn?: string[]
}
export interface RulesOutput { decisions: OrchDecision[]; ambiguous: string[] }

const OPEN = (t: RulesTask) => t.status !== 'done' && t.status !== 'canceled'
/** "shopify" → "Shopify", "google-drive" → "Google Drive" (a connection id as words for the founder). */
export const connectionName = (id: string): string =>
  clip(id.replace(/[._:-]+/g, ' ').trim().replace(/\b[a-z]/g, (c) => c.toUpperCase()) || id, 60)

export function coordinatorRules(x: RulesInput): RulesOutput {
  const decisions: OrchDecision[] = []
  const ambiguous: string[] = []
  const byId = new Map(x.tasks.map((t) => [t.id, t]))
  const agent = (id: string | null) => (id ? x.agents.find((a) => a.id === id) ?? null : null)
  const kinds = new Set(x.events.map((e) => e.kind))

  // done tasks of this batch (a task_done event, or a run end whose task is done now)
  const done = new Set<string>()
  for (const e of x.events) if ((e.kind === 'task_done' || e.kind === 'run_ended') && e.taskId && byId.get(e.taskId)?.status === 'done') done.add(e.taskId)

  // 1. a done task others waited for: start what is ready
  const unblocked = x.tasks.filter((t) => OPEN(t) && t.status !== 'in_progress' && t.dependencyIds.some((d) => done.has(d)) && t.dependencyIds.every((d) => byId.get(d)?.status === 'done'))
  if (unblocked.length) {
    const from = [...done].map((id) => byId.get(id)!.identifier)
    decisions.push({ verb: 'pump', why: `${from.join(', ')} ${from.length === 1 ? 'is' : 'are'} done; ${unblocked.map((t) => t.identifier).join(', ')} waited for ${from.length === 1 ? 'it' : 'them'}` })
  }

  // 2. a follow-up Principia filed for an agent who works only when started (or Autopilot is off): ask the founder
  for (const e of x.events) {
    if (e.kind !== 'task_created' || !e.taskId) continue
    const t = byId.get(e.taskId)
    if (!t || t.status !== 'backlog' || t.source !== 'agent' || !(t.externalId ?? '').startsWith('run:')) continue
    const a = agent(t.agentId)
    if (!a) continue
    if (a.auto && x.autopilot) continue
    const why = !a.auto ? `${a.name} works only when you start it` : 'Autopilot is off'
    decisions.push({ verb: 'suggest', kind: 'task', task: t.id, title: `Start ${t.identifier} for ${a.name}: ${clip(t.title, 100)}`, text: `A teammate filed this follow-up. ${why}, so it waits in Backlog.`, why })
  }

  // 3-5. what the batch's run reports suggest or need
  const seenRoutine = new Set<string>()
  for (const r of x.reports) {
    const who = agent(r.agentId)?.name ?? 'An agent'
    for (const b of r.report.blockers) {
      if (b.needs !== 'connection' || !b.connectionId) continue
      decisions.push({ verb: 'suggest', kind: 'connection', connectionId: b.connectionId, title: `Connect ${connectionName(b.connectionId)}`, text: `${who} needs it: ${clip(flat(b.text), 300)}`, why: 'a run needs a connection' })
    }
    for (const sg of r.report.suggestions) {
      if (sg.kind === 'connection' && sg.connectionId) decisions.push({ verb: 'suggest', kind: 'connection', connectionId: sg.connectionId, title: `Connect ${connectionName(sg.connectionId)}`, text: `${who} suggests it: ${clip(flat(sg.text), 300)}`, why: 'a run report suggested a connection' })
      else if (sg.kind === 'task') decisions.push({ verb: 'suggest', kind: 'task', title: clip(flat(sg.text), 150), text: `${who} suggested this task.`, why: 'a run report suggested a task' })
      else if (sg.kind === 'routine') {
        const key = normText(sg.text)
        if (!key || seenRoutine.has(key)) continue
        seenRoutine.add(key)
        const times = x.routineHistory.filter((h) => normText(h.text) === key && Date.parse(x.now) - Date.parse(h.at) <= 14 * DAY).length
        if (times < ROUTINE_REPEATS) continue
        const cron = sg.cron ?? [...x.routineHistory].reverse().find((h) => normText(h.text) === key && h.cron)?.cron
        decisions.push({ verb: 'suggest', kind: 'routine', title: `Make it a routine: ${clip(flat(sg.text), 120)}`, text: `Your team suggested this ${times} times. One click makes it a schedule.`, ...(cron ? { cron } : {}), ...(r.agentId ? { to: r.agentId } : {}), why: `suggested ${times} times` })
      }
    }
  }

  // 6. "Put it on autopilot?": the best playbook the batch's real work points to (one offer per batch)
  const on = new Set(x.playbooksOn ?? [])
  // `on` also holds the playbooks the founder already answered (open, kept for later, Never, quiet period), so a run
  // whose best match is one of those offers its next best instead
  const offer = (signals: PlaybookSignals, why: string, agentId: string | null, task: string | null): boolean => {
    const m = matchPlaybooks(signals).find((p) => !on.has(p.id))
    if (!m) return false
    const def = playbookDef(m.id)
    const level = Math.min(def.defaultLevel, OFFER_MAX_LEVEL) as PlaybookLevel
    decisions.push({ verb: 'suggest', kind: 'autopilot', playbook: m.id, level, title: offerTitle(def), text: `${m.why} ${offerDetail(def, level)}`, ...(agentId ? { to: agentId } : {}), ...(task ? { task } : {}), ...(m.budgetUsd ? { budgetUsd: m.budgetUsd } : {}), why })
    return true
  }
  let offered = false
  for (const r of x.reports) {
    if (offered) break
    const t = r.taskId ? byId.get(r.taskId) : null
    offered = offer(
      {
        texts: [r.report.summary, ...r.report.evidence, ...(t ? [t.title] : [])],
        tools: r.tools ?? [],
        // a connection a run names in a blocker or an idea is one it lacks: never a sign the work happened
        connections: [],
        departmentKeys: r.departmentKey ? [r.departmentKey] : [],
        hints: r.report.recurring ? [r.report.recurring] : [],
        who: agent(r.agentId)?.name ?? null,
        taskRef: t?.identifier ?? null
      },
      'a run did work that can keep running on autopilot',
      r.agentId,
      t?.identifier ?? null
    )
  }
  if (!offered && kinds.has('tick') && x.connections?.length) offer({ texts: [], tools: [], connections: x.connections, departmentKeys: [], hints: [] }, 'a connection fits an autopilot', null, null)

  // 7. the daily digest in the Team room
  if (kinds.has('tick') && (!x.lastDigestAt || Date.parse(x.now) - Date.parse(x.lastDigestAt) >= 20 * 3_600_000)) {
    const text = digestText(x)
    if (text) decisions.push({ verb: 'digest_post', text, why: 'the daily digest' })
  }

  // 8. what rules cannot decide
  for (const e of x.events) if (e.kind === 'forum_human_post' && e.text?.trim()) ambiguous.push(`You posted in the Forum: "${clip(flat(e.text), 200)}"`)
  for (const r of x.reports) {
    const t = r.taskId ? byId.get(r.taskId) : null
    if (r.report.outcome === 'progress' && !r.report.followUps.length && !r.report.handoff && t && t.status !== 'in_progress') ambiguous.push(`${t.identifier} made progress but named no next step`)
  }
  for (const id of done) {
    const t = byId.get(id)!
    const a = agent(t.agentId)
    if (!a || !a.auto) continue
    const waiting = x.tasks.some((o) => o.agentId === a.id && OPEN(o) && o.id !== t.id)
    if (!waiting && !unblocked.length) ambiguous.push(`${t.identifier} is done and ${a.name} has nothing else to do`)
  }
  return { decisions, ambiguous }
}

/** "Since yesterday: 3 done (NC-3, NC-5, NC-7). 2 wait for you: NC-8 (a question), NC-9 (to review). 1 working." */
export function digestText(x: Pick<RulesInput, 'tasks' | 'now'>): string | null {
  const since = Date.parse(x.now) - DAY
  const done = x.tasks.filter((t) => t.status === 'done' && Date.parse(t.updatedAt) >= since)
  const review = x.tasks.filter((t) => t.status === 'in_review')
  const asks = x.tasks.filter((t) => OPEN(t) && t.asks && t.status !== 'in_review')
  const working = x.tasks.filter((t) => t.status === 'in_progress')
  if (!done.length && !review.length && !asks.length && !working.length) return null
  const ids = (l: RulesTask[]) => l.slice(0, 5).map((t) => t.identifier).join(', ') + (l.length > 5 ? ` and ${l.length - 5} more` : '')
  const parts: string[] = []
  if (done.length) parts.push(`${done.length} done since yesterday (${ids(done)}).`)
  const wait = [...asks.map((t) => `${t.identifier} (a question)`), ...review.map((t) => `${t.identifier} (to review)`)]
  if (wait.length) parts.push(`${wait.length} ${wait.length === 1 ? 'waits' : 'wait'} for you: ${wait.slice(0, 6).join(', ')}${wait.length > 6 ? ' …' : ''}.`)
  if (working.length) parts.push(`${working.length} working now (${ids(working)}).`)
  return parts.join(' ')
}
