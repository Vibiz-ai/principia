import type { CompanyAgent, CompanyTask, Department, NeedsYouReason } from '@shared/company'
import { Icon } from '../Icon'
import { TaskPriority } from '../TaskBits'
import { CompanyChip } from '../CompanyChip'
import { REASON_LABEL, TASK_DRAG_TYPE } from '../../lib/board'
import { AgentBust, agentLabel, useAgentName } from '../../shell/DepartmentGroup'

/**
 * DEPARTMENTS.md §9 kanban card: id, title, department colour bar, agent avatar, a lock for a dependency block and the
 * reason chip in Needs you. The avatar is the agent's mini bust with the tooltip "{persona} · {role}" (VOICE.md §4.4),
 * or the old initial and role label with personas off. Draggable onto a column or an agent avatar (the board decides what a drop means); a
 * running card does not drag at all.
 */
export function TaskCard({ task, department, agent, reason, chips = false, selected = false, onOpen }: { task: CompanyTask; department?: Department | null; agent?: CompanyAgent | null; reason?: NeedsYouReason | null; chips?: boolean; selected?: boolean; onOpen: (t: CompanyTask) => void }): React.JSX.Element {
  const locked = task.status === 'blocked' && task.blockReason === 'deps'
  const draggable = task.status !== 'in_progress'
  const noReport = task.status === 'in_review' && !task.report
  const who = useAgentName(agent)
  return <button
    type="button"
    className={`board-card ${selected ? 'is-selected' : ''} ${reason ? 'is-needs' : ''}`}
    draggable={draggable}
    onDragStart={(e) => { e.dataTransfer.setData(TASK_DRAG_TYPE, task.id); e.dataTransfer.effectAllowed = 'move' }}
    onClick={() => onOpen(task)}
    aria-label={`${task.identifier}: ${task.title}${reason ? `, ${REASON_LABEL[reason]}` : ''}`}
  >
    <span className="board-card__bar" style={{ background: department?.color ?? 'transparent' }} aria-hidden />
    <span className="board-card__top">
      <TaskPriority priority={task.priority} />
      <span className="task-identifier">{task.identifier}</span>
      {locked && <span className="board-card__lock" title="Waiting on its dependencies"><Icon name="lock" size={11} /></span>}
      {chips && <CompanyChip companyId={task.companyId} avatarOnly size={14} />}
      <span className={`board-card__agent ${agent?.pausedAt ? 'is-paused' : ''}`} title={agent ? `${agentLabel(who)}${agent.pausedAt ? ' (paused)' : ''}` : 'Unassigned'}>{agent ? <AgentBust agent={agent} color={department?.color ?? null} size={18} /> : <span className="task-unassigned">○</span>}</span>
    </span>
    <span className="board-card__title">{task.title}</span>
    {(reason || department || task.status === 'in_progress') && <span className="board-card__meta">
      {department && <span className="board-card__dep">{department.name}</span>}
      {task.status === 'in_progress' && !reason && <span className="board-card__working"><span className="task-live-dot" /> working</span>}
      {reason && <span className={`board-reason board-reason--${reason}`}>{REASON_LABEL[reason]}{noReport && reason === 'review' ? ' · no report' : ''}</span>}
    </span>}
  </button>
}
