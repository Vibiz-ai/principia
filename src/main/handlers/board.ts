/**
 * DEPARTMENTS.md §10: the board channels (tasks:assign … tasks:stop, board:autopilot). Requests are zod-validated by
 * `handle` (ipcSchemas); every channel is gated on experimental.companies + .departments, and every id is checked
 * against the task's own company (department and agent through DepartmentStore.assertTaskRefs, never a company the
 * renderer names). The state rules live in CompanyStore and taskState.ts; this file only wires them.
 *
 * tasks:openSession / tasks:takeover and session stops belong to the dispatcher (D4), reached through the optional
 * `h.dispatcher`; until it is wired they refuse with "not available".
 */
import { departmentsEnabled, type BoardSettings, type CompanyTask } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import type { ExperimentalFlags, Session } from '../../shared/types'
import type { CompanyStore } from '../company'
import { assertDepartmentsEnabled } from '../company/departments'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { log } from '../log'

type PtySize = { cols: number; rows: number }
type Awaitable<T> = T | Promise<T>
/** What the board needs from the dispatcher (DEPARTMENTS.md §3, §4.4). Every member is optional until D4 lands. */
export interface BoardDispatcher {
  /** level-triggered: called after every board change of the company */
  pump?(companyId?: string): unknown
  openSession?(taskId: string, size: PtySize): Awaitable<{ task: CompanyTask; session: Session }>
  takeover?(taskId: string, size: PtySize): Awaitable<{ task: CompanyTask; session: Session }>
  /** stops a task held by an interactive session (no run to cancel) */
  stop?(taskId: string): Awaitable<unknown>
}
/** The slice of Hive the board uses (tests pass a fake). */
export interface BoardHost {
  company: CompanyStore
  settings(): { experimental?: ExperimentalFlags }
  engine: { runs: { cancel(id: string): Promise<void> } }
  vault?: { redact(text: string): string }
  dispatcher?: BoardDispatcher | null
  /** Open Passport §8.3: a review note becomes a taste proposal (never blocks or fails the review) */
  memory?: { reviewTaste(task: CompanyTask, outcome: 'approved' | 'sent_back', note: string): Promise<unknown> } | null
}

const notAvailable = (): never => { throw new HiveError('not_implemented', 'Opening a task as a session is not available yet') }

/** The channel implementations, without IPC (registerBoardHandlers wires them; tests call them directly). */
export function boardActions(h: BoardHost, onChange: (companyId: string) => void = () => {}) {
  const c = h.company
  const gate = () => assertDepartmentsEnabled(h.settings().experimental)
  /** gate, load the task (404 for an unknown id), act, then tell the board and the dispatcher */
  const act = <T extends { companyId: string } | { task: { companyId: string } }>(id: string, fn: (t: CompanyTask) => T): T => {
    gate()
    const out = fn(c.task(id))
    onChange('task' in out ? out.task.companyId : out.companyId)
    return out
  }
  /** the review note, as the human wrote it, is a taste signal for the task's department (or the company) */
  const review = (t: CompanyTask, outcome: 'approved' | 'sent_back', note: string): CompanyTask => {
    const redacted = h.vault ? h.vault.redact(note) : note
    h.memory?.reviewTaste(t, outcome, redacted).catch((err) => log.warn('board: taste signal skipped', { taskId: t.id, error: String(err) }))
    return t
  }
  const actAsync = async <T extends { companyId: string } | { task: { companyId: string } }>(id: string, fn: (t: CompanyTask) => Promise<T>): Promise<T> => {
    gate()
    const out = await fn(c.task(id))
    onChange('task' in out ? out.task.companyId : out.companyId)
    return out
  }
  return {
    assign: (q: { id: string; departmentId?: string | null; agentId?: string | null }) => act(q.id, t => {
      // checked against the task's stored company before anything is written (cross-company ids are refused)
      c.departments.assertTaskRefs(t.companyId, {
        departmentId: q.departmentId !== undefined ? q.departmentId : t.departmentId ?? null,
        agentId: q.agentId !== undefined ? q.agentId : t.agentId ?? null
      }, t)
      return c.assign(q.id, { departmentId: q.departmentId, agentId: q.agentId }, 'human')
    }),
    acceptRoute: (q: { id: string }) => act(q.id, t => {
      // a suggestion can go stale (department archived, seat moved): checked like a human pick before it is applied
      if (t.routing?.by === 'model') c.departments.assertTaskRefs(t.companyId, { departmentId: t.routing.departmentId ?? null, agentId: t.routing.agentId ?? null }, t)
      return c.acceptRoute(q.id)
    }),
    answer: (q: { id: string; answer: string }) => act(q.id, () => c.answer(q.id, h.vault ? h.vault.redact(q.answer) : q.answer)),
    approve: (q: { id: string; doneNote: string }) => review(act(q.id, () => c.approve(q.id, h.vault ? h.vault.redact(q.doneNote) : q.doneNote, 'human')), 'approved', q.doneNote),
    sendBack: (q: { id: string; note: string }) => review(act(q.id, () => c.sendBack(q.id, h.vault ? h.vault.redact(q.note) : q.note)), 'sent_back', q.note),
    unpark: (q: { id: string }) => act(q.id, () => c.unpark(q.id)),
    /** Cancels the task's run (the run end parks it, §1.4) or, for a session lease, asks the dispatcher. */
    stop: (q: { id: string }) => actAsync(q.id, async t => {
      if (t.status !== 'in_progress') throw new HiveError('bad_request', 'This task is not running')
      const run = t.runId ? c.store.getRun(t.runId) : null
      if (run && (run.status === 'queued' || run.status === 'running')) {
        await h.engine.runs.cancel(run.id)
        // the run hook normally parks it; a run that ended without the hook still syncs here
        const ended = c.store.getRun(run.id)
        if (ended) c.syncRun(ended)
      } else if (h.dispatcher?.stop) await h.dispatcher.stop(t.id)
      else if (!run || ['passed', 'failed', 'canceled'].includes(run.status)) {
        if (run) c.syncRun(run)
        if (c.task(t.id).status === 'in_progress') c.park(t.id, 'no_report', 'Stopped by you; nothing was running')
      }
      return c.task(t.id)
    }),
    openSession: (q: { id: string } & PtySize) => actAsync(q.id, async () => h.dispatcher?.openSession ? h.dispatcher.openSession(q.id, { cols: q.cols, rows: q.rows }) : notAvailable()),
    takeover: (q: { id: string } & PtySize) => actAsync(q.id, async () => h.dispatcher?.takeover ? h.dispatcher.takeover(q.id, { cols: q.cols, rows: q.rows }) : notAvailable()),
    autopilot: (q: { companyId: string; on: boolean; maxInFlight?: number }): BoardSettings => {
      gate()
      const out = c.setAutopilot(q.companyId, q.on, q.maxInFlight)
      onChange(q.companyId)
      return out
    }
  }
}

export function registerBoardHandlers(h: Hive & { dispatcher?: BoardDispatcher | null }): void {
  // §4.2: task prompts are redacted before they reach an adapter
  h.company.setRedactor(text => h.vault.redact(text))
  // §0.8: with departments off, plain tasks keep today's statuses and nothing starts by itself
  h.company.setBoardEnabled(() => departmentsEnabled(h.settings().experimental))
  const onChange = (companyId: string) => {
    emit('data:changed', { domain: 'tasks' })
    try { h.dispatcher?.pump?.(companyId) } catch (err) { log.warn('board: dispatcher pump failed', { companyId, error: String(err) }) }
  }
  const a = boardActions(h, onChange)
  handle('tasks:assign', a.assign)
  handle('tasks:acceptRoute', a.acceptRoute)
  handle('tasks:answer', a.answer)
  handle('tasks:approve', a.approve)
  handle('tasks:sendBack', a.sendBack)
  handle('tasks:unpark', a.unpark)
  handle('tasks:stop', async q => { const t = await a.stop(q); h.statusChanged(); return t })
  handle('tasks:openSession', async q => { const out = await a.openSession(q); h.statusChanged(); return out })
  handle('tasks:takeover', async q => { const out = await a.takeover(q); h.statusChanged(); return out })
  handle('board:autopilot', q => { const out = a.autopilot(q); emit('data:changed', { domain: 'company' }); return out })
}
