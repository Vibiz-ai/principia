/**
 * DIAGRAMS.md §5, §6: the Full Window sheet (same controls plus a minimap; Esc closes) and the Visualize sheet
 * (⌘K "Visualize…", the chat pane menu). Mounted once in App next to the other overlays.
 */
import { useEffect, useState } from 'react'
import { visualizePrompt } from '@shared/diagram'
import { Sheet } from '../ui'
import { closeDiagramWindow, closeVisualize, sendVisualize, useDiagramState } from '../../state/diagrams'
import { sessionTitle, useStore } from '../../state/store'
import { DiagramFull } from './DiagramBlock'

function DiagramWindow({ raw }: { raw: string }): React.JSX.Element {
  useEffect(() => {
    // bubble phase: an open walkthrough or details popover handles Esc first and stops it
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeDiagramWindow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="sheet-layer dgm-layer" onMouseDown={(e) => e.target === e.currentTarget && closeDiagramWindow()}>
      <div className="dgm-sheet" role="dialog" aria-label="Diagram">
        <DiagramFull source={raw} onClose={closeDiagramWindow} />
      </div>
    </div>
  )
}

function VisualizeSheet({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [what, setWhat] = useState('')
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const ok = what.trim().length > 1
  const send = (): void => {
    if (ok) sendVisualize(sessionId, what)
  }
  return (
    <Sheet title="Visualize" onCancel={closeVisualize} onPrimary={send} primaryLabel="Ask the Agent" primaryDisabled={!ok}>
      <p className="sheet__desc text-secondary">The agent draws it as a diagram in its answer. Good for architecture, flows, dependencies and plans.</p>
      <input
        className="input"
        value={what}
        maxLength={300}
        placeholder="the board flow"
        aria-label="What should the agent draw?"
        onChange={(e) => setWhat(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="sheet__note text-tertiary">
        Sends “{visualizePrompt(what.trim() || '…')}” to {session ? sessionTitle(session) : 'the chat'}.
      </div>
    </Sheet>
  )
}

export function DiagramOverlays(): React.JSX.Element | null {
  const win = useDiagramState((s) => s.window)
  const vis = useDiagramState((s) => s.visualize)
  return (
    <>
      {win && <DiagramWindow key={win.raw} raw={win.raw} />}
      {vis && <VisualizeSheet sessionId={vis.sessionId} />}
    </>
  )
}
