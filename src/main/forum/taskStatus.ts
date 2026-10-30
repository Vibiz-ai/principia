/**
 * CHAT-UI.md §8: what an agent answering in a conversation knows about the tasks filed there, live: working (since
 * when, its latest step), queued (and why it has not started), needs the person, blocked, in review, done. The reply
 * run's rules carry one line per task (taskStatusLine), so "are you working on it?" gets the real state.
 */
import { startsWithoutAutopilot } from '../../shared/company'
import { queuedReason, taskStatusLine, type TaskStatusInput } from '../../shared/taskCard'
import type { CompanyStore } from '../company'

/** One task's live state, or null (gone). Never throws. */
export function taskStatusOf(c: CompanyStore, taskId: string, who: (agentId: string) => string | null): TaskStatusInput | null {
  try {
    const t = c.task(taskId)
    const db = c.store.db
    const agent = t.agentId ? c.departments.getAgent(t.agentId) : null
    const run = t.status === 'in_progress' && t.runId ? (db.prepare('SELECT started_at, created_at FROM runs WHERE id=?').get(t.runId) as { started_at: string | null; created_at: string } | undefined) : undefined
    const last = db.prepare('SELECT message, created_at FROM company_task_activity WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(t.id) as { message: string; created_at: string } | undefined
    let waiting: string | null = null
    if (['todo', 'triage', 'backlog', 'blocked'].includes(t.status)) {
      const company = c.passport(t.companyId)
      const s = c.boardSettings(t.companyId)
      const inFlight = (db.prepare("SELECT COUNT(*) AS n FROM company_tasks WHERE company_id=? AND status='in_progress' AND run_id IS NOT NULL AND id<>?").get(t.companyId, t.id) as { n: number }).n
      const depsOpen = t.dependencyIds.flatMap((id) => {
        try {
          const d = c.task(id)
          return d.status === 'done' ? [] : [d.identifier]
        } catch {
          return []
        }
      })
      waiting = queuedReason({
        task: t,
        agent: agent ? { name: who(agent.id) ?? agent.name, archivedAt: agent.archivedAt, pausedAt: agent.pausedAt, data: agent.data } : null,
        company: { name: company.name, autopilot: s.autopilot, pausedAt: c.isPaused(t.companyId) ? 'paused' : null, maxInFlight: s.maxInFlight },
        depsOpen,
        inFlight,
        startsAnyway: startsWithoutAutopilot(t),
        runLabel: 'Start'
      }).text
    }
    return {
      identifier: t.identifier,
      title: t.title,
      status: t.status,
      blockReason: t.blockReason,
      ask: t.ask,
      who: t.agentId ? (who(t.agentId) ?? agent?.name ?? null) : null,
      since: run ? (run.started_at ?? run.created_at) : t.updatedAt,
      latest: last ? { at: last.created_at, text: last.message } : null,
      waiting
    }
  } catch {
    return null
  }
}

/** The lines for the tasks of a conversation (newest first). */
export function conversationTaskLines(c: CompanyStore, taskIds: readonly string[], who: (agentId: string) => string | null, now: number = Date.now()): string[] {
  return taskIds.flatMap((id) => {
    const s = taskStatusOf(c, id, who)
    return s ? [taskStatusLine(s, now)] : []
  })
}
