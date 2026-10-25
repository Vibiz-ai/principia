import type { CompanyAgent, CompanyTask, Department, NeedsYouReason } from '@shared/company'
import { useIsCode } from '../desk/Desk'
import { Icon } from '../Icon'
import { TaskPriority } from '../TaskBits'
import { CompanyChip } from '../CompanyChip'
import { REASON_LABEL, TASK_DRAG_TYPE } from '../../lib/board'
import { AgentBust, agentLabel, useAgentName } from '../../shell/DepartmentGroup'
import { BranchGlyph, WorkCardBadge } from './TaskWork'
import { cardWorkLine, shortBranch } from '../../lib/boardFlow'
import { workStarted } from '@shared/taskWork'
import { LinearChip } from './LinearSheet'
import { linearWorkLabel, startedInLinear } from '../../lib/linear'

/**
 * DEPARTMENTS.md §9 kanban card: id, title, department colour bar, agent avatar, a lock for a dependency block and the
 * reason chip in Needs you. The avatar is the agent's mini bust with the tooltip "{persona} · {role}" (VOICE.md §4.4),
 * or the old initial and role label with personas off. Draggable onto a column or an agent avatar (the board decides what a drop means); a
 * running card does not drag at all.
 */
export function TaskCard({ task, department, agent, reason, chips = false, selected = false, linear = null, onOpen }: { task: CompanyTask; department?: Department | null; agent?: CompanyAgent | null; reason?: NeedsYouReason | null; chips?: boolean; selected?: boolean; linear?: { key: string; url: string; status?: string } | null; onOpen: (t: CompanyTask) => void }): React.JSX.Element {
  // LINEAR.md: in progress in Linear with no run here (someone there is on it)
  const elsewhere = startedInLinear(task, linear)
  const locked = task.status === 'blocked' && task.blockReason === 'deps'
  const draggable = task.status !== 'in_progress'
  const noReport = task.status === 'in_review' && !task.report && !linear
  const who = useAgentName(agent)
  // pm-review C7: a company with no code never sees task codes, only titles
  const code = useIsCode(task.companyId)
  return <button
    type="button"
    className={`board-card ${selected ? 'is-selected' : ''} ${reason ? 'is-needs' : ''}`}
    draggable={draggable}
    onDragStart={(e) => { e.dataTransfer.setData(TASK_DRAG_TYPE, task.id); e.dataTransfer.effectAllowed = 'move' }}
    onClick={() => onOpen(task)}
    aria-label={`${code ? `${task.identifier}: ` : ''}${task.title}${reason ? `, ${REASON_LABEL[reason]}` : ''}`}
  >
    <span className="board-card__bar" style={{ background: department?.color ?? 'transparent' }} aria-hidden />
    <span className="board-card__top">
      <TaskPriority priority={task.priority} />
      {code && <span className="task-identifier">{task.identifier}</span>}
      {linear && <LinearChip issueKey={linear.key} url={linear.url} />}
      {locked && <span className="board-card__lock" title="Waiting on its dependencies"><Icon name="lock" size={11} /></span>}
      {!(code && task.work && (workStarted(task.work) || task.work.pr)) && <WorkCardBadge task={task} />}
      {chips && <CompanyChip companyId={task.companyId} avatarOnly size={14} />}
      <span className={`board-card__agent ${agent?.pausedAt ? 'is-paused' : ''}`} title={agent ? `${agentLabel(who)}${agent.pausedAt ? ' (paused)' : ''}` : 'Unassigned'}>{agent ? <AgentBust agent={agent} color={department?.color ?? null} size={18} /> : <span className="task-unassigned">○</span>}</span>
    </span>
    <span className="board-card__title">{task.title}</span>
    {(reason || department || task.status === 'in_progress') && <span className="board-card__meta">
      {department && <span className="board-card__dep">{department.name}</span>}
      {task.status === 'in_progress' && !reason && (elsewhere ? <span className="board-muted">{linearWorkLabel(linear)}</span> : <span className="board-card__working"><span className="task-live-dot" /> working</span>)}
      {reason && <span className={`board-reason board-reason--${reason}`}>{REASON_LABEL[reason]}{noReport && reason === 'review' ? ' · no report' : ''}</span>}
    </span>}
    {/* design §4.5: a code task's card shows its branch and where its pull request is */}
    {code && task.work && (workStarted(task.work) || task.work.pr) && <span className="board-card__meta">
      <span className="board-card__branch" title={task.work.branch}><BranchGlyph size={10} /> {shortBranch(task.work.branch)}</span>
      {cardWorkLine(task.work) && <span className={`board-card__pr ${task.work.pr?.state === 'MERGED' ? 'is-merged' : ''}`}>{cardWorkLine(task.work)}</span>}
    </span>}
  </button>
}
