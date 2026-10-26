import type { Id } from '@shared/types'
import { TaskStatusIcon } from '../TaskBits'
import { openBoard, useStore } from '../../state/store'
import { BranchGlyph, PrChip } from './TaskWork'
import '../../styles/taskWork.css'

/**
 * WORKTREE.md: one line above an agent's chat (RunView, SessionView) saying which task it is doing: status glyph,
 * identifier, title, branch and PR, and Open task. Nothing when the run or session works on no task.
 */
export function TaskStrip({ taskId, ownerId }: { taskId: Id | null | undefined; ownerId?: Id | null }): React.JSX.Element | null {
  // the run or session row may not carry its task id: the task whose current run (or session lease) it is
  const task = useStore((s) => (taskId ? s.tasks.find((t) => t.id === taskId) : ownerId ? s.tasks.find((t) => t.runId === ownerId) : undefined))
  if (!task) return null
  const w = task.work
  return <button type="button" className="task-strip" onClick={() => openBoard(task.companyId, { taskId: task.id })} title="Open task">
    <TaskStatusIcon status={task.status} />
    <span className="task-strip__id">{task.identifier}</span>
    <span className="task-strip__title">{task.title}</span>
    {w?.branch && w.startedAt && <span className="task-strip__branch"><BranchGlyph size={11} />{w.branch}</span>}
    <PrChip task={task} />
    <span className="task-strip__open">Open task</span>
  </button>
}
