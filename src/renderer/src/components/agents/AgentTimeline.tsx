/**
 * Event timeline of one agent (LIVE.md §11 "Run view"): tool rows (name + summary + state + duration, expand to
 * detail), text rows (first 3 lines, expand), asks and answers. Live from agent:events; follows the tail unless the
 * user scrolled up.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '@shared/live'
import type { Id } from '@shared/types'
import { durationMs } from '../../lib/time'
import { eventDurations, eventGlyph } from '../../lib/live'
import { useAgentEvents } from '../../state/live'
import { Button, EmptyState, Loading } from '../ui'
import { hasDiagram } from '@shared/diagram'
import { TextWithDiagrams } from '../diagrams/TextWithDiagrams'

export function AgentTimeline({ agentId, emptyText = 'No activity yet.', note }: { agentId: Id; emptyText?: string; note?: string | null }): React.JSX.Element {
  const { events, loading, error, loadOlder, hasOlder } = useAgentEvents(agentId)
  const durs = useMemo(() => eventDurations(events), [events])
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events])
  useEffect(() => {
    stick.current = true
  }, [agentId])
  return (
    <div
      className="timeline scroll selectable"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {note && <div className="timeline__note">{note}</div>}
      {hasOlder && (
        <div className="timeline__older">
          <Button size="sm" variant="ghost" onClick={loadOlder}>
            Load earlier activity
          </Button>
        </div>
      )}
      {events.length === 0 ? (
        loading ? <Loading /> : error ? <EmptyState compact text={<span className="text-failed">{error}</span>} /> : <EmptyState compact text={emptyText} />
      ) : (
        events.map((e) => <EventRow key={e.seq} e={e} dur={durs.get(e.seq)} />)
      )}
    </div>
  )
}

function EventRow({ e, dur }: { e: AgentEvent; dur: number | undefined }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = !!e.detail && e.detail !== e.summary
  const state = e.state ?? (e.kind === 'error' ? 'error' : null)
  if (e.kind === 'text' && hasDiagram(e.detail)) {
    // DIAGRAMS.md: an answer with a diagram shows whole, the block drawn in place
    return (
      <div className="tl tl--text">
        <span className="tl__glyph">{eventGlyph(e)}</span>
        <div className="tl__text">
          <TextWithDiagrams text={e.detail!} renderText={(t) => <div>{t}</div>} />
        </div>
      </div>
    )
  }
  if (e.kind === 'text' || e.kind === 'thinking') {
    const lines = (e.detail ?? e.summary).split('\n')
    const long = lines.length > 3
    return (
      <div className={`tl tl--${e.kind}`}>
        <span className="tl__glyph">{eventGlyph(e)}</span>
        <div className="tl__text" onClick={() => long && setOpen(!open)}>
          {(open ? lines : lines.slice(0, 3)).join('\n')}
          {long && !open && <span className="tl__more"> … more</span>}
        </div>
      </div>
    )
  }
  return (
    <div className={`tl tl--${e.kind} ${state ? `tl--${state}` : ''}`}>
      <span className="tl__glyph" title={state ?? e.kind}>
        {eventGlyph(e)}
      </span>
      <div className="tl__body">
        <div className={`tl__head ${expandable ? 'is-expandable' : ''}`} onClick={() => expandable && setOpen(!open)}>
          {e.name && <span className="tl__name">{e.name}</span>}
          <span className="tl__summary">{e.summary}</span>
          {state === 'denied' && <span className="tl__state">denied</span>}
          {dur !== undefined && <span className="tl__dur">{durationMs(dur)}</span>}
        </div>
        {open && e.detail && <pre className="tl__detail">{e.detail}</pre>}
      </div>
    </div>
  )
}
