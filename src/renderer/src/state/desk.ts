/**
 * Five doors step 3: the agent desk's actions and data. A message to an agent (Home's Ask box, the desk composer, a
 * Chats agent thread, ⌘K "Ask Marcus: …") becomes work the agent really does:
 * - it repeats open work (findDuplicate): your words join that task as a comment, which wakes it (D11 "merge");
 * - else a new task assigned to that agent, which starts at once when the agent is free and the company runs, and
 *   otherwise waits in the agent's Queue.
 * Either way the agent's reply (deskReply: the request restated in a full sentence) is stored on the task as the
 * agent's comment, so the conversation reads the same on the agent page, in Chats and after a restart.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyAgent, CompanyTask, TaskDetail } from '@shared/company'
import type { Id } from '@shared/types'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { autonomyPhrase, deskReply, DESK_PREFIX, findDuplicate, taskOrigin, taskTitleFor, waitsOnOther, type DeskAgent } from '../lib/desk'
import { deskTasks, deskThread, type ThreadItem } from '../lib/deskThread'
import { displayName, personasOf } from '../lib/personaView'
import { personasOn } from '../lib/voice'
import { companyName, getState, openAgentSeat, refreshTasks, toast, useStore, type State } from './store'

/** Who an agent is on the desk: persona name, role label, department name (personas on or off). */
export function deskAgentOf(a: CompanyAgent, s: State = getState()): DeskAgent {
  const on = personasOn(s.settings)
  const who = displayName(a, personasOf(s), on)
  return { id: a.id, name: who.name, role: who.role || a.name, department: s.departments.find((d) => d.id === a.departmentId)?.name ?? null, paused: !!a.pausedAt }
}
/** deskAgentOf as a hook: memoised on the slices it reads (a selector returning a new object would loop). */
export function useDeskWho(a: CompanyAgent): DeskAgent {
  const agents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const on = useStore((s) => personasOn(s.settings))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => deskAgentOf(a, getState()), [a, agents, departments, on])
}
/** Active agents of a company, as the Ask box routes over them. */
export function deskAgents(companyId: Id, s: State = getState()): DeskAgent[] {
  return s.companyAgents.filter((a) => a.companyId === companyId && !a.archivedAt).map((a) => deskAgentOf(a, s))
}
export function useDeskAgents(companyId: Id | null | undefined): DeskAgent[] {
  const agents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const personas = useStore((s) => personasOn(s.settings))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (companyId ? deskAgents(companyId) : []), [companyId, agents, departments, personas])
}
/** The one autonomy phrase of a seat (Team card, agent page, onboarding). */
export function agentAutonomy(a: CompanyAgent, s: State = getState()): string {
  const dep = s.departments.find((d) => d.id === a.departmentId)
  return autonomyPhrase({ auto: a.data.autonomy === 'auto', role: a.name, department: dep?.name })
}

export interface SendResult {
  taskId: Id
  merged: boolean
  started: boolean
}
let sending = false
/**
 * Sends a request to one agent of its company. Returns null when nothing was sent (empty, gone, or an error, which is
 * the toast). `open`: go to the agent's page afterwards (Home's Ask box, ⌘K).
 */
export async function sendToAgent(agentId: Id, text: string, opts: { open?: boolean } = {}): Promise<SendResult | null> {
  const request = text.trim()
  if (!request || sending) return null
  const s = getState()
  const agent = s.companyAgents.find((a) => a.id === agentId && !a.archivedAt)
  if (!agent) {
    toast('That agent is no longer on the team', 'error')
    return null
  }
  const company = s.companies.find((c) => c.id === agent.companyId)
  const pausedCompany = company?.pausedAt ? company.name : null
  const autonomy = agentAutonomy(agent, s)
  const mine = s.tasks.filter((t) => t.agentId === agent.id && t.companyId === agent.companyId)
  const busy = mine.find((t) => t.status === 'in_progress') ?? null
  // the agent picks up its next task by itself only when it acts on its own and Autopilot is on
  const startsNext = agent.data.autonomy === 'auto' && !!company?.autopilot
  sending = true
  try {
    const dup = findDuplicate(request, mine)
    if (dup) {
      // your words go on the task as yours: a human comment wakes it, so the agent reads them on its next turn
      await hive.tasks.comment({ id: dup.id, message: request })
      const reply = deskReply({ request, autonomy, merged: { title: dup.title, origin: taskOrigin(dup, company?.createdAt), status: dup.status, waitingOnOther: waitsOnOther(dup, s.tasks) }, startsNext, pausedCompany, agentPaused: !!agent.pausedAt })
      await hive.tasks.comment({ id: dup.id, message: reply, by: 'agent' })
      await refreshTasks()
      if (opts.open) openAgentSeat(agent)
      return { taskId: dup.id, merged: true, started: false }
    }
    const task = await hive.tasks.create({
      task: {
        title: taskTitleFor(request),
        description: request,
        companyId: agent.companyId,
        repoId: agent.data.defaultRepoId ?? null,
        status: 'todo',
        priority: 0,
        source: 'manual',
        sourceUrl: null,
        externalId: `${DESK_PREFIX}${agent.id}:${Date.now()}`,
        assigneeProfileId: null,
        parentId: null,
        dependencyIds: [],
        departmentId: agent.departmentId,
        agentId: agent.id
      }
    })
    const canStart = !pausedCompany && !agent.pausedAt && !busy
    const reply = deskReply({ request, autonomy, busyWith: canStart ? null : (busy?.title ?? null), startsNext, pausedCompany, agentPaused: !!agent.pausedAt })
    await hive.tasks.comment({ id: task.id, message: reply, by: 'agent' })
    let started = false
    if (canStart) {
      try {
        await hive.tasks.start({ id: task.id })
        started = true
      } catch (e) {
        // it stays in the Queue with its Start button; say why it did not start
        toast(`${taskTitleFor(request)} is in the queue: ${errorMessage(e)}`, 'error')
      }
    }
    await refreshTasks()
    if (opts.open) openAgentSeat(agent)
    return { taskId: task.id, merged: false, started }
  } catch (e) {
    toast(errorMessage(e), 'error')
    return null
  } finally {
    sending = false
  }
}

/**
 * The conversation with one agent: its latest tasks' activity, live. Reloads when the agent's tasks change (a new
 * request, a report, an approval); a slower answer for the agent we just left never lands on this one.
 */
export function useDeskThread(agent: CompanyAgent | undefined): { items: ThreadItem[] | null; tasks: CompanyTask[]; error: string | null } {
  const all = useStore((s) => s.tasks)
  const companyCreatedAt = useStore((s) => s.companies.find((c) => c.id === agent?.companyId)?.createdAt ?? null)
  const name = useStore((s) => (agent ? deskAgentOf(agent, s).name : ''))
  const tasks = useMemo(() => (agent ? deskTasks(all, agent.id, agent.companyId) : []), [all, agent?.id, agent?.companyId])
  const key = tasks.map((t) => `${t.id}@${t.updatedAt}`).join()
  const [details, setDetails] = useState<{ agentId: Id; list: TaskDetail[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const load = (): void => {
    if (!agent) return
    const n = ++seq.current
    const forAgent = agent.id
    Promise.all(tasks.map((t) => hive.tasks.get({ id: t.id }).catch(() => ({ task: t, activity: [] }) as TaskDetail))).then(
      (list) => {
        if (n !== seq.current) return
        setDetails({ agentId: forAgent, list })
        setError(null)
      },
      (e) => n === seq.current && setError(errorMessage(e))
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [agent?.id, key])
  useHiveEvent('data:changed', ({ domain }) => domain === 'tasks' && load())
  const items = useMemo(() => (details && details.agentId === agent?.id ? deskThread(details.list, { companyCreatedAt, agentName: name }) : null), [details, agent?.id, companyCreatedAt, name])
  return { items, tasks, error }
}

/** "Paused companies still allow chats you start yourself" (step 2 carry-over): the line under a paused company. */
export function pausedChatsLine(companyId: Id): string {
  return `${companyName(companyId)} is paused: agents start nothing. Chats you open yourself still work.`
}
