import type { TaskSource, TaskStatus } from '@shared/company'
import { PRIORITIES, SOURCE_LABEL, STATUS_LABEL } from '../lib/company'
import { Icon } from './Icon'
import github from '../assets/connections/github.svg'
import sentry from '../assets/connections/sentry.svg'

export function TaskStatusIcon({ status }: { status: TaskStatus }): React.JSX.Element {
  return <span className={`task-status task-status--${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]}>{status === 'done' ? <Icon name="check" size={10} /> : status === 'blocked' ? '!' : status === 'canceled' ? '−' : null}</span>
}
export function TaskSourceBadge({ source, compact = false }: { source: TaskSource; compact?: boolean }): React.JSX.Element {
  return <span className={`task-source task-source--${source}`} title={SOURCE_LABEL[source]}>
    {source === 'github' || source === 'sentry' ? <img src={source === 'github' ? github : sentry} alt="" /> : source === 'slack' ? <span className="task-slack" aria-hidden>#</span> : source === 'posthog' ? <span className="task-posthog" aria-hidden>▥</span> : <Icon name="tasks" size={13} />}
    {!compact && SOURCE_LABEL[source]}
  </span>
}
export function TaskPriority({ priority }: { priority: 0 | 1 | 2 | 3 | 4 }): React.JSX.Element {
  return <span className={`task-priority task-priority--${priority}`} title={PRIORITIES[priority]} aria-label={PRIORITIES[priority]}>{priority === 1 ? '!' : priority === 0 ? '—' : <>{[0, 1, 2].map((i) => <i key={i} style={{ height: 4 + i * 3, opacity: i <= 4 - priority ? 1 : 0.2 }} />)}</>}</span>
}
