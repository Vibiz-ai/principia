import { useMemo } from 'react'
import type { TaskActivity } from '@shared/company'
import { ACTIVITY_LABEL, coalesceActivity } from '../../lib/board'
import { relative } from '../../lib/time'

const BY_LABEL = { human: 'You', agent: 'Agent', system: 'Principia' } as const

/**
 * DEPARTMENTS.md §9: the typed task activity, oldest first. Each row names its kind and who caused it; repeated
 * coalesced wakes fold into one row ("Coalesced ×3").
 */
export function ActivityTimeline({ activity }: { activity: TaskActivity[] }): React.JSX.Element {
  const rows = useMemo(() => coalesceActivity(activity), [activity])
  if (!rows.length) return <p className="board-muted">No activity yet.</p>
  return <ol className="activity-timeline">
    {rows.map((a) => <li key={a.id} className={`task-activity-item activity--${a.kind} activity--by-${a.by}`}>
      <span className="task-activity-dot" />
      <div>
        <div className="activity-timeline__head"><span className="activity-timeline__kind">{ACTIVITY_LABEL[a.kind] ?? a.kind}{a.count > 1 && <span className="activity-timeline__count"> ×{a.count}</span>}</span><span className="activity-timeline__by">{BY_LABEL[a.by] ?? a.by}</span></div>
        <p className="selectable">{a.message}</p>
        <time dateTime={a.createdAt}>{relative(a.createdAt)}</time>
      </div>
    </li>)}
  </ol>
}
