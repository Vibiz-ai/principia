/** WORKTREE.md: builds the task worktree service over Hive (after wireAuthoring made h.worktrees). */
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import { baseChildEnv } from '../loginEnv'
import { TaskWorkService } from './taskWork'
import { ghRunner } from './taskWorkGh'

export function wireTaskWork(h: Hive): TaskWorkService {
  const svc = new TaskWorkService({
    company: () => h.company,
    worktrees: () => h.worktrees,
    startRun: (target, opts) => h.engine.runs.start(target, opts),
    cancelRun: (id) => h.engine.runs.cancel(id),
    gh: ghRunner(() => baseChildEnv()),
    onChange: (companyId) => {
      emit('data:changed', { domain: 'tasks' })
      h.statusChanged()
      try { void h.dispatcher?.pump(companyId) } catch { /* the dispatcher logs its own */ }
    },
    log
  })
  // parallel work: a task whose checkout another run already works in gets its own worktree (CompanyStore.startTask)
  const wm = h.worktrees
  h.company.setWorktreePaths(wm ? (identifier) => wm.taskPath(identifier) : null)
  // after the dispatcher's own hook (registered first): the run end has already moved the task
  h.runHooks.push((run) => svc.onRunUpdated(run))
  return svc
}
