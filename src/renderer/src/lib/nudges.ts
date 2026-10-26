/**
 * Home suggestions: gentle pushes toward what Principia can do for this company, picked from real state. Never
 * blocking, at most one at a time, and each one dismissible for good (Settings.nudges[companyId][id]). Pure: the card
 * (components/home/NudgeCard.tsx) passes in what the store knows.
 *
 * In order (the first that applies wins):
 * 1. connect:<tool>  an agent asked for a tool this company has not connected (a principia://connect link in a task's
 *                    report, question, note or description from the last two weeks): "Marcus needed Instagram".
 * 2. morning-brief   a day after the company was created, no schedule of it is on: "Get a morning brief every weekday?"
 * 3. week-done       3+ tasks done this week: "See what your team did", with the weekly review offered when it is off.
 * 4. track-tasks     "Track work as tasks" is off, there are chats and no tasks: offer to turn it back on.
 */
import type { CompanyTask } from '@shared/company'
import { connectLink, parseDeepLink } from '@shared/deepLink'
import type { RoutineId } from '@shared/routines'
import type { Id, TrackTasks } from '@shared/types'

export type NudgeAction =
  | { kind: 'routine'; routine: RoutineId; label: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'activity'; label: string }
  | { kind: 'trackTasks'; label: string }

export interface Nudge {
  id: string
  title: string
  body: string
  action: NudgeAction
  /** a second, quieter button */
  secondary?: NudgeAction
  /** the agent it is about (its face on the card) */
  agentId?: Id | null
}

type NudgeTask = Pick<CompanyTask, 'id' | 'status' | 'updatedAt' | 'description'> & { agentId?: Id | null; report?: { summary: string } | null; ask?: { prompt: string } | null; doneNote?: string | null }

export interface NudgeInput {
  now: Date
  companyId: Id
  companyCreatedAt: string | null
  /** dismissed for good, by id */
  dismissed?: Readonly<Record<string, string>>
  tasks: readonly NudgeTask[]
  /** enabled schedules of this company (null = not loaded yet: no routine nudge) */
  schedulesOn: number | null
  /** routines that are on (by id) */
  routinesOn: ReadonlySet<RoutineId>
  /** the morning brief can be turned on here (someone can run it) */
  morningBriefReady: boolean
  /** tool ids this company has connected (null = not loaded yet: no connection nudge) */
  connected: ReadonlySet<string> | null
  agentName: (agentId: Id) => string | null
  toolName: (tool: string) => string
  trackTasks: TrackTasks
  chatCount: number
}

const DAY = 86_400_000
const LINK = /principia:\/\/[^\s)\]>"'`]+/g

/** Tools an agent asked for in a task's text: principia://connect/<tool> links naming this company or none. */
export function connectAsks(tasks: readonly NudgeTask[], companyId: Id, since: number): { tool: string; agentId: Id | null; at: number }[] {
  const out: { tool: string; agentId: Id | null; at: number }[] = []
  for (const t of tasks) {
    const at = Date.parse(t.updatedAt)
    if (!(at >= since)) continue
    const text = [t.report?.summary, t.ask?.prompt, t.doneNote, t.description].filter(Boolean).join('\n')
    for (const m of text.match(LINK) ?? []) {
      const l = parseDeepLink(m.replace(/[.,;:!?]+$/, ''))
      if (!l || l.kind !== 'connect' || l.tool === 'mcp') continue
      if (l.companyId && l.companyId !== companyId) continue
      out.push({ tool: l.tool, agentId: t.agentId ?? null, at })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

export function weekStartMs(now: Date): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

export function pickNudge(i: NudgeInput): Nudge | null {
  const off = (id: string): boolean => !!i.dismissed?.[id]
  const now = i.now.getTime()

  if (i.connected) {
    const ask = connectAsks(i.tasks, i.companyId, now - 14 * DAY).find((a) => !i.connected!.has(a.tool) && !off(`connect:${a.tool}`))
    if (ask) {
      const tool = i.toolName(ask.tool)
      const who = ask.agentId ? i.agentName(ask.agentId) : null
      return {
        id: `connect:${ask.tool}`,
        title: `${who ?? 'Your team'} needed ${tool}`,
        body: `Connect it once and ${who ?? 'your agents'} can use it next time. You sign in on its card; nobody asks for your password.`,
        action: { kind: 'link', href: connectLink(ask.tool, i.companyId), label: `Connect ${tool}` },
        agentId: ask.agentId
      }
    }
  }

  const created = i.companyCreatedAt ? Date.parse(i.companyCreatedAt) : NaN
  if (i.schedulesOn === 0 && i.morningBriefReady && now - created >= DAY && !i.routinesOn.has('morning-brief') && !off('morning-brief'))
    return {
      id: 'morning-brief',
      title: 'Get a morning brief every weekday?',
      body: 'At 9:00 your team reads the board and tells you what moved, what is stuck and the three things to look at first. It uses your plan; nothing is sent anywhere.',
      action: { kind: 'routine', routine: 'morning-brief', label: 'Turn on' },
      secondary: { kind: 'link', href: 'principia://automations/routines', label: 'See all routines' }
    }

  const from = weekStartMs(i.now)
  const done = i.tasks.filter((t) => t.status === 'done' && Date.parse(t.updatedAt) >= from).length
  if (done >= 3 && !off('week-done'))
    return {
      id: 'week-done',
      title: `Your team finished ${done} tasks this week`,
      body: i.routinesOn.has('weekly-review') ? 'See what they did, task by task.' : 'See what they did, or get a short review of the week every Friday afternoon.',
      action: { kind: 'activity', label: 'See what they did' },
      ...(i.routinesOn.has('weekly-review') ? {} : { secondary: { kind: 'routine' as const, routine: 'weekly-review' as const, label: 'Turn on the weekly review' } })
    }

  if (i.trackTasks === 'off' && i.chatCount > 0 && i.tasks.length === 0 && !off('track-tasks'))
    return {
      id: 'track-tasks',
      title: 'Let chats keep track of their work?',
      body: 'When you ask for several things at once, the agent opens a task for each, so you can see where every one stands on the Board.',
      action: { kind: 'trackTasks', label: 'Turn on' }
    }

  return null
}

/** Settings.nudges with one suggestion dismissed for good. */
export function dismissNudge(all: Readonly<Record<Id, Record<string, string>>> | undefined, companyId: Id, id: string, now = new Date()): Record<Id, Record<string, string>> {
  return { ...(all ?? {}), [companyId]: { ...(all?.[companyId] ?? {}), [id]: now.toISOString() } }
}
