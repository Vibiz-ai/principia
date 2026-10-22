import { useEffect, useState } from 'react'
import type { Id } from '@shared/types'
import { learnRunTask, taskForRun, taskRunLabel } from '../../lib/board'
import { hive, useHiveEvent } from '../../lib/hive'
import { departmentsOn, openBoard, useStore } from '../../state/store'
import { Icon } from '../Icon'
import '../../styles/board.css'

/** runs.task_id per run id, learned from runs:get or run:updated (null = not a task run). Shared by every chip. */
const runTask = new Map<Id, Id | null>()
const pending = new Set<Id>()

/**
 * A run's runs.task_id when the caller has only the run id (hub rows carry the run, not its task). Fetched once per
 * run and kept; `skip` when the task is already known (its latest run, or a session's task).
 */
function useRunTaskId(runId: Id | null | undefined, skip: boolean): Id | null {
  const [, bump] = useState(0)
  useHiveEvent('run:updated', (r) => { if (learnRunTask(runTask, r as { id: Id; taskId?: Id | null }) && r.id === runId) bump((n) => n + 1) })
  useEffect(() => {
    if (!runId || skip || runTask.has(runId) || pending.has(runId)) return
    let live = true
    pending.add(runId)
    void hive.runs.get({ id: runId }).then(
      (d) => { runTask.set(runId, (d.run as { taskId?: Id | null }).taskId ?? null) },
      () => { runTask.set(runId, null) }
    ).finally(() => { pending.delete(runId); if (live) bump((n) => n + 1) })
    return () => { live = false }
  }, [runId, skip])
  return runId ? (runTask.get(runId) ?? null) : null
}

/**
 * DEPARTMENTS.md §9 live hub: "PRN-42 · Marketing/Copywriter" on a task run's row (Agents, Canvas), through the run's
 * runs.task_id (`taskId` when the row carries it, else looked up once per run) or the task whose latest run it is. A
 * click opens the card on the Board. Renders nothing while departments are off or when the run is not a task run.
 */
export function TaskRunChip({ runId, taskId, sessionId }: { runId?: Id | null; taskId?: Id | null; sessionId?: Id | null }): React.JSX.Element | null {
  const on = useStore((s) => departmentsOn(s))
  const tasks = useStore((s) => s.tasks)
  const departments = useStore((s) => s.departments)
  const agents = useStore((s) => s.companyAgents)
  // a task opened as a session carries sessions.task_id
  const sessionTaskId = useStore((s) => (sessionId ? ((s.sessions.find((x) => x.id === sessionId) as { taskId?: Id | null } | undefined)?.taskId ?? null) : null))
  const direct = on ? taskForRun(tasks, { runId, taskId, sessionTaskId }) : undefined
  // an older run of a task is no longer its latest runId: ask main for that run's task link
  const linked = useRunTaskId(on ? runId : null, !!direct || !!taskId || !!sessionTaskId)
  if (!on) return null
  const task = direct ?? (linked ? tasks.find((t) => t.id === linked) : undefined)
  if (!task) return null
  const label = taskRunLabel(task, departments, agents)
  return <button type="button" className="task-run-chip" title={`${task.title}: open the card`} onClick={(e) => { e.stopPropagation(); openBoard(task.companyId, { taskId: task.id }) }}>
    <Icon name="tasks" size={11} />{label}
  </button>
}
