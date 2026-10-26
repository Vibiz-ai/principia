/** Small shared pieces for live agents: status glyph (accent for Needs you), Needs-you badge, elapsed time. */
import type { AgentNode } from '@shared/live'
import { span } from '../../lib/time'
import { elapsedMs, type AgentVisual } from '../../lib/live'
import { useTick } from '../ui'

const GLYPH: Record<AgentVisual, string> = {
  needs: '◆',
  running: '●',
  queued: '○',
  idle: '○',
  exited: '○',
  passed: '✓',
  failed: '✕',
  canceled: '⊘',
  scheduled: '◷'
}
const TITLE: Record<AgentVisual, string> = {
  needs: 'Needs you',
  running: 'Working',
  queued: 'Starting',
  idle: 'Idle',
  exited: 'Ended',
  passed: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
  scheduled: 'Scheduled'
}

export function AgentGlyph({ visual, title }: { visual: AgentVisual; title?: string }): React.JSX.Element {
  return (
    <span className={`aglyph aglyph--${visual}`} title={title ?? TITLE[visual]} aria-label={title ?? TITLE[visual]}>
      {GLYPH[visual]}
    </span>
  )
}

/** Amber count, e.g. on the sidebar row and canvas nodes. Hidden at 0. */
export function NeedsBadge({ count, title }: { count: number; title?: string }): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <span className="needs-badge" title={title ?? `${count} thing${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`}>
      ◆ {count}
    </span>
  )
}

/** Live elapsed time ("14m"), ticking with the shared clock. */
export function Elapsed({ agent }: { agent: Pick<AgentNode, 'startedAt' | 'endedAt'> }): React.JSX.Element {
  useTick(agent.endedAt ? 60_000 : 5_000)
  return <span className="agent-elapsed">{span(elapsedMs(agent))}</span>
}
