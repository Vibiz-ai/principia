/**
 * DIAGRAMS.md §6: a chat pane is a terminal, which can't draw. When the agent's answer holds a principia-graph block,
 * the pane shows it right above the terminal: a thin strip with the diagram's title, opened when a new one arrives,
 * folded with one click. The chat's earlier diagrams stay in the strip for this app session.
 */
import { useEffect, useState } from 'react'
import type { Id } from '@shared/types'
import { noteSessionAnswer, openDiagramWindow, useSessionDiagrams } from '../../state/diagrams'
import { DiagramBlock } from './DiagramBlock'
import { KindIcon } from './DiagramIcons'

export function SessionDiagrams({ sessionId, answer }: { sessionId: Id; answer: string | null | undefined }): React.JSX.Element | null {
  const list = useSessionDiagrams(sessionId)
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  useEffect(() => {
    if (noteSessionAnswer(sessionId, answer) > 0) {
      setPick(null)
      setOpen(true)
    }
  }, [sessionId, answer])
  if (!list.length) return null
  const idx = pick ?? list.length - 1
  const cur = list[Math.min(idx, list.length - 1)]!
  return (
    <div className={`pane-dgm ${open ? 'is-open' : ''}`}>
      <div className="pane-dgm__bar">
        <button type="button" className="pane-dgm__toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Fold the diagram' : 'Show the diagram'}>
          <KindIcon kind="group" size={13} />
          <span className="pane-dgm__title">{cur.title}</span>
          <span className="pane-dgm__hint">{open ? 'Hide' : 'Show'}</span>
        </button>
        {list.length > 1 && (
          <span className="pane-dgm__picks">
            {list.map((d, i) => (
              <button key={d.at + i} type="button" className={`pane-dgm__pick ${i === idx ? 'is-on' : ''}`} title={d.title} onClick={() => (setPick(i), setOpen(true))}>
                {i + 1}
              </button>
            ))}
          </span>
        )}
        <span className="flex1" />
        <button type="button" className="pane-dgm__open" onClick={() => openDiagramWindow(cur.raw)}>
          Open Full Window
        </button>
      </div>
      {open && (
        <div className="pane-dgm__body">
          <DiagramBlock key={cur.raw} source={cur.raw} />
        </div>
      )}
    </div>
  )
}
