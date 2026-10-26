/**
 * PLANS.md §2.4: the Board's Run now for a task of a plan goes through the plan pilot (milestone worktree, milestone
 * note, milestone conversation), never a run in the founder's checkout. The plans handlers register the pilot here;
 * tasks:start calls it for any task with a plan link. CompanyStore.startTask refuses a plan task that did not come
 * through the pilot, so a path that misses this hook fails readably instead of running in the checkout.
 */
import type { BoardTask } from '../../shared/company'
import { HiveError } from '../../shared/errors'

type Starter = (taskId: string) => Promise<BoardTask>
let starter: Starter | null = null

export function setPlanBoardStarter(fn: Starter | null): void { starter = fn }
export function planBoardStart(taskId: string): Promise<BoardTask> {
  if (!starter) throw new HiveError('bad_request', 'Plans are off. Turn them on in Settings › Experimental.')
  return starter(taskId)
}
