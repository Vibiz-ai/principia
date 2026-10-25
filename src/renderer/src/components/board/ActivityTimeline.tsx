import { useMemo } from 'react'
import type { TaskActivity } from '@shared/company'
import { ACTIVITY_LABEL, coalesceActivity } from '../../lib/board'
import { relative } from '../../lib/time'

const BY_LABEL = { human: 'You', agent: 'Agent', system: 'Principia' } as const

/**
 * DEPARTMENTS.md §9: the typed task activity, oldest first. Each row names its kind and who caused it; repeated
 * coalesced wakes fold into one row ("Coalesced ×3").
 */
/** `plain` (a company with no code, C7): no run ids or task codes in the lines. */
export function ActivityTimeline({ activity, plain = false }: { activity: TaskActivity[]; plain?: boolean }): React.JSX.Element {
  const rows = useMemo(() => coalesceActivity(activity), [activity])
  if (!rows.length) return <p className="board-muted">No activity yet.</p>
  return <ol className="activity-timeline">
    {rows.map((a) => <li key={a.id} className={`task-activity-item activity--${a.kind} activity--by-${a.by}`}>
      <span className="task-activity-dot" />
      <div>
        <div className="activity-timeline__head"><span className="activity-timeline__kind">{ACTIVITY_LABEL[a.kind] ?? a.kind}{a.count > 1 && <span className="activity-timeline__count"> ×{a.count}</span>}</span><span className="activity-timeline__by">{BY_LABEL[a.by] ?? a.by}</span></div>
        <p className="selectable">{plain ? plainActivityLine(a.message) : a.message}</p>
        <time dateTime={a.createdAt}>{relative(a.createdAt)}</time>
      </div>
    </li>)}
  </ol>
}

/** "Pliny started run r_abc123" -> "Pliny started"; "NC-7 was canceled" -> "A task was canceled"; Unpark -> Try again. */
export function plainActivityLine(m: string): string {
  return m
    .replace(/\s+(?:run|session)\s+r?_?[A-Za-z0-9_-]{6,}/g, '')
    .replace(/\b[A-Z]{2,5}-\d+\b/g, 'a task')
    .replace(/\bUnpark\b/g, 'Try again')
    .replace(/^a task/, 'A task')
}
