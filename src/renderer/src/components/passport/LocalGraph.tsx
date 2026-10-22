/** The open note's neighbourhood (PASSPORT.md §10 right column): depth 1–3, tags and ghosts toggles. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VaultGraph } from '@shared/passport'
import { IconButton, Stepper } from '../ui'
import { buildModel, DEFAULT_DISPLAY, DEFAULT_FORCES, DEFAULT_GROUPS, type GraphModel } from '../../lib/forceGraph'
import { errorMessage, hive } from '../../lib/hive'
import { loadJson, saveJson } from '../../state/store'
import { GraphCanvas } from './GlobalGraph'

const LOCAL_FORCES = { ...DEFAULT_FORCES, linkDistance: 70, repel: 6 }
const LOCAL_DISPLAY = { ...DEFAULT_DISPLAY, textFade: -3 }

interface LocalPrefs {
  depth: 1 | 2 | 3
  tags: boolean
  ghosts: boolean
}

export function LocalGraph({
  companyId,
  noteId,
  pathById,
  reloadKey,
  initialDepth,
  onOpen,
  onCreateGhost,
  onExpand
}: {
  companyId: string
  noteId: string
  pathById: ReadonlyMap<string, string>
  reloadKey: number
  initialDepth?: number
  onOpen: (noteId: string) => void
  onCreateGhost: (title: string) => void
  /** open the global graph */
  onExpand: () => void
}): React.JSX.Element {
  const [prefs, setPrefs] = useState<LocalPrefs>(() => {
    const p = loadJson<LocalPrefs>('hive.passport.local', { depth: 1, tags: false, ghosts: true })
    const d = initialDepth && initialDepth >= 1 && initialDepth <= 3 ? (initialDepth as 1 | 2 | 3) : p.depth
    return { ...p, depth: d }
  })
  const [graph, setGraph] = useState<VaultGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => saveJson('hive.passport.local', prefs), [prefs])

  useEffect(() => {
    let live = true
    hive.memory.graph({ op: 'local', companyId, noteId, depth: prefs.depth, filters: { tags: prefs.tags, ghosts: prefs.ghosts } }).then(
      (g) => {
        if (!live) return
        setGraph(g)
        setError(null)
      },
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [companyId, noteId, prefs.depth, prefs.tags, prefs.ghosts, reloadKey])

  // not persisted, and the global positions are ignored: a small neighbourhood reads better laid out on its own
  // (seeded, so the same note always looks the same); a live reload keeps where the nodes are now
  const prev = useRef<GraphModel | null>(null)
  const model = useMemo(() => {
    if (!graph) return null
    const same = prev.current && graph.centerId && prev.current.byId.has(graph.centerId)
    const saved = new Map(same ? prev.current!.nodes.map((n) => [n.id, { x: n.x, y: n.y }]) : [])
    return buildModel({ ...graph, positions: [] }, { saved })
  }, [graph])
  prev.current = model

  return (
    <div className="plocal">
      <div className="plocal__bar">
        <span className="plocal__label">Depth</span>
        <Stepper value={prefs.depth} min={1} max={3} width={52} label="Local graph depth" onChange={(v) => setPrefs({ ...prefs, depth: Math.min(3, Math.max(1, v)) as 1 | 2 | 3 })} />
        <button type="button" className={`hchip ${prefs.tags ? 'is-on' : ''}`} onClick={() => setPrefs({ ...prefs, tags: !prefs.tags })}>
          Tags
        </button>
        <button type="button" className={`hchip ${prefs.ghosts ? 'is-on' : ''}`} onClick={() => setPrefs({ ...prefs, ghosts: !prefs.ghosts })}>
          Ghosts
        </button>
        <span className="flex1" />
        <IconButton icon="external" label="Open the global graph" onClick={onExpand} />
      </div>
      <div className="plocal__stage">
        {error ? (
          <div className="plocal__empty text-secondary">{error}</div>
        ) : !model ? null : model.nodes.length <= 1 ? (
          <div className="plocal__empty text-tertiary">No links yet.</div>
        ) : (
          <GraphCanvas
            model={model}
            forces={LOCAL_FORCES}
            display={LOCAL_DISPLAY}
            groups={DEFAULT_GROUPS}
            pathById={pathById}
            centerId={graph?.centerId ?? noteId}
            compact
            onOpen={(n) => (n.ghost ? onCreateGhost(n.title) : n.tag || n.id === noteId ? undefined : onOpen(n.id))}
          />
        )}
      </div>
    </div>
  )
}
