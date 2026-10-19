/** xyflow wrapper shared by Canvas and the workflow editor preview. Read-only map, no drag-to-connect. */
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStoreApi, type Edge, type NodeHandle, type NodeProps } from '@xyflow/react'
import { NODE_H, NODE_W, cardHeight, type CardNode, type FrameNode, type GraphNode, type NodeRef } from '../lib/graph'
import type { Pill } from '../lib/live'
import { eventGlyph } from '../lib/live'
import type { AgentEvent } from '@shared/live'
import { hive } from '../lib/hive'
import { StatusGlyph } from './ui'
import { AgentGlyph } from './agents/AgentBits'

/** Canvas-only: clicking a subagent pill selects that agent (drawer agent tree). Editor preview leaves it unset. */
export const PillContext = createContext<((nodeId: string, ref: NodeRef, agentId: string) => void) | null>(null)

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }

const CardView = memo(function CardView({ id, data, selected }: NodeProps<CardNode>) {
  const onPill = useContext(PillContext)
  const pills = data.pills ?? []
  const h = cardHeight(data)
  return (
    <div
      className={`gnode gnode--${data.status} ${data.compact ? 'gnode--compact' : ''} ${pills.length ? 'gnode--pills' : ''} ${data.needs || data.waiting ? 'gnode--needs' : ''} ${data.diff ? `gnode--diff-${data.diff}` : ''} ${data.quiet ? 'gnode--quiet' : ''} ${data.history ? 'gnode--history' : ''} ${selected ? 'is-selected' : ''}`}
      style={pills.length || data.morePills ? { height: h } : undefined}
      title={`${data.label}\n${data.sub}\nClick to inspect · double-click to open`}
    >
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hidden} isConnectable={false} />
      <Handle id="loop-in" type="target" position={Position.Bottom} style={hidden} isConnectable={false} />
      <Handle id="loop-out" type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      <div className="gnode__row">
        {data.needs || data.waiting ? <AgentGlyph visual="needs" title="Waiting for you" /> : <StatusGlyph status={data.status} />}
        <div className="gnode__text">
          <div className="gnode__label">
            {data.isolated && (
              <span className="gnode__branch" title="Runs in the run’s git worktree">
                ⎇{' '}
              </span>
            )}
            {data.label}
          </div>
          <div className="gnode__sub">{data.sub}</div>
        </div>
        {data.stalled && (
          <span className="stalled-badge stalled-badge--node" title="No output for a while. Principia never stops it on its own.">
            Stalled?
          </span>
        )}
        {!!data.needs && (
          <button
            type="button"
            className="gnode__needs nodrag"
            title={`${data.needs} thing${data.needs === 1 ? '' : 's'} need${data.needs === 1 ? 's' : ''} you — click to answer`}
            onClick={(e) => {
              e.stopPropagation()
              if (onPill && data.agentId) onPill(id, data.ref, data.agentId)
            }}
          >
            ⚑{data.needs > 1 ? ` ${data.needs}` : ''}
          </button>
        )}
      </div>
      {(pills.length > 0 || !!data.morePills) && (
        <div className="gnode__pills">
          {pills.map((p) => (
            <PillRow key={p.id} pill={p} onClick={onPill ? () => onPill(id, data.ref, p.id) : undefined} />
          ))}
          {!!data.morePills && (
            <div
              className="gpill gpill--more nodrag"
              onClick={(e) => {
                e.stopPropagation()
                if (onPill && data.agentId) onPill(id, data.ref, data.agentId)
              }}
            >
              +{data.morePills} more
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/** One subagent pill: status dot, label, live activity. Hover shows its last 3 events. */
function PillRow({ pill: p, onClick }: { pill: Pill; onClick?: () => void }): React.JSX.Element {
  const [hover, setHover] = useState<DOMRect | null>(null)
  const [events, setEvents] = useState<AgentEvent[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  return (
    <div
      className={`gpill gpill--${p.visual} nodrag`}
      style={{ paddingLeft: 6 + Math.min(p.depth - 1, 3) * 8 }}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        timer.current = setTimeout(() => {
          setHover(r)
          void hive.agents.events({ agentId: p.id, limit: 3 }).then(setEvents, () => setEvents([]))
        }, 350)
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
        setHover(null)
      }}
    >
      <AgentGlyph visual={p.visual} />
      <span className="gpill__label">{p.label}</span>
      <span className="gpill__activity">{p.activity}</span>
      {hover &&
        createPortal(
          <div className="gpill-pop" style={{ left: Math.min(hover.left, window.innerWidth - 300), top: hover.bottom + 4 }}>
            <div className="gpill-pop__title">{p.label}</div>
            {p.note && <div className="gpill-pop__note">{p.note}</div>}
            {events === null ? (
              <div className="gpill-pop__row text-tertiary">Loading…</div>
            ) : events.length === 0 ? (
              <div className="gpill-pop__row text-tertiary">No activity yet.</div>
            ) : (
              events.slice(-3).map((e) => (
                <div key={e.seq} className="gpill-pop__row">
                  <span className="gpill-pop__glyph">{eventGlyph(e)}</span>
                  {e.name && <span className="gpill-pop__name">{e.name}</span>}
                  <span className="gpill-pop__sum">{e.summary}</span>
                </div>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

const FrameView = memo(function FrameView({ data }: NodeProps<FrameNode>) {
  return (
    <div
      className={`gframe ${data.status ? `gframe--${data.status}` : ''} ${data.variant ? `gframe--${data.variant}` : ''}`}
      style={{ width: data.width, height: data.height }}
      title={data.variant === 'ghost' ? `${data.label}\n${data.note ?? ''}` : undefined}
    >
      <Handle type="target" position={Position.Left} style={hidden} isConnectable={false} />
      <div className="gframe__label">
        {data.status && <StatusGlyph status={data.status} />}
        <span className="gframe__text">{data.label}</span>
        {data.meta && <span className="gframe__meta">{data.meta}</span>}
      </div>
      {data.note && <div className="gframe__note">{data.note}</div>}
    </div>
  )
})

const nodeTypes = { card: CardView, frame: FrameView }
const FIT_PADDING = 64
/** Below this the node text is unreadable: stop shrinking and let the canvas scroll instead. */
const MIN_READABLE_ZOOM = 0.75
/** Non-interactive mini graphs fit everything with a small margin (they cannot be scrolled). */
const MINI_FIT_PADDING = 10
const MINI_MIN_ZOOM = 0.05

/**
 * Every node carries its size and handle positions up front. Canvas nodes are rebuilt on every IPC update
 * (new objects, no onNodesChange), and React Flow drops DOM-measured sizes for new objects. Measuring again
 * needs a ResizeObserver callback that never comes when the DOM size did not change or the window was hidden,
 * which left nodes at visibility:hidden. With static sizes nothing depends on measurement.
 */
function withStaticSize(n: GraphNode): GraphNode {
  const width = n.type === 'frame' ? n.data.width : NODE_W
  const height = n.type === 'frame' ? n.data.height : cardHeight(n.data)
  // cards with subagent pills keep their edges on the header row
  const midY = (n.type === 'card' && height > NODE_H ? NODE_H : height) / 2 - 0.5
  const handles: NodeHandle[] =
    n.type === 'frame'
      ? [{ id: null, type: 'target', position: Position.Left, x: 0, y: midY, width: 1, height: 1 }]
      : [
          { id: null, type: 'target', position: Position.Left, x: 0, y: midY, width: 1, height: 1 },
          { id: null, type: 'source', position: Position.Right, x: width - 1, y: midY, width: 1, height: 1 },
          { id: 'loop-in', type: 'target', position: Position.Bottom, x: width / 2 - 0.5, y: height - 1, width: 1, height: 1 },
          { id: 'loop-out', type: 'source', position: Position.Bottom, x: width / 2 - 0.5, y: height - 1, width: 1, height: 1 }
        ]
  return { ...n, width, height, measured: { width, height }, handles } as GraphNode
}

export interface GraphViewProps {
  nodes: GraphNode[]
  edges: Edge[]
  selectedId?: string | null
  onSelect?: (ref: NodeRef, id: string) => void
  onOpen?: (ref: NodeRef) => void
  onContext?: (ref: NodeRef, e: React.MouseEvent) => void
  fitKey?: string
  focusNodeId?: string | null
  interactive?: boolean
  keyboard?: boolean
}

function Inner(props: GraphViewProps): React.JSX.Element {
  const { nodes, edges, selectedId, onSelect, onOpen, onContext, fitKey, focusNodeId, interactive = true, keyboard = false } = props
  const rf = useReactFlow()
  const store = useStoreApi()
  /** Fit everything when it stays readable; otherwise pin the top-left corner at a readable zoom and let the user scroll. */
  const fit = useCallback(
    (duration: number): void => {
      const { width: W, height: H } = store.getState()
      const all = rf.getNodes()
      if (!W || !H || !all.length) return
      // a read-only mini graph (approval card) cannot be scrolled: always show every node, however small
      if (!interactive) {
        void rf.fitView({ padding: `${MINI_FIT_PADDING}px`, minZoom: MINI_MIN_ZOOM, maxZoom: 1.1, duration })
        return
      }
      const b = rf.getNodesBounds(all)
      const zoom = Math.min((W - FIT_PADDING * 2) / Math.max(b.width, 1), (H - FIT_PADDING * 2) / Math.max(b.height, 1), 1.1)
      if (zoom >= MIN_READABLE_ZOOM) {
        void rf.fitView({ padding: `${FIT_PADDING}px`, maxZoom: 1.1, duration })
        return
      }
      const z = MIN_READABLE_ZOOM
      const x = b.width * z < W ? (W - b.width * z) / 2 - b.x * z : FIT_PADDING / 2 - b.x * z
      const y = b.height * z < H ? (H - b.height * z) / 2 - b.y * z : FIT_PADDING / 2 - b.y * z
      void rf.setViewport({ x, y, zoom: z }, { duration })
    },
    [rf, store, interactive]
  )
  /** Set once the user pans/zooms by hand; until then the view follows the content. */
  const userMoved = useRef(false)
  useEffect(() => {
    userMoved.current = false
    const t = setTimeout(() => fit(0), 30)
    return () => clearTimeout(t)
  }, [fitKey, fit])
  // New groups / "earlier runs" chips / grown frames change the layout: re-fit so nothing is clipped,
  // unless the user has taken over the viewport.
  const layoutSig = useMemo(
    () => nodes.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}${n.type === 'frame' ? `/${n.data.width}x${n.data.height}` : ''}`).join('|'),
    [nodes]
  )
  const firstSig = useRef(true)
  useEffect(() => {
    if (firstSig.current) {
      firstSig.current = false
      return
    }
    if (userMoved.current) return
    const t = setTimeout(() => fit(200), 30)
    return () => clearTimeout(t)
  }, [layoutSig, fit])
  useEffect(() => {
    if (!focusNodeId) return
    userMoved.current = true // an explicit focus wins over auto-fit
    const t = setTimeout(() => void rf.fitView({ nodes: [{ id: focusNodeId }], padding: 0.4, maxZoom: 1.1, duration: 200 }), 60)
    return () => clearTimeout(t)
  }, [focusNodeId, rf])
  useEffect(() => {
    if (!keyboard) return
    const onZoom = (e: Event): void => {
      const d = (e as CustomEvent<'in' | 'out' | 'reset'>).detail
      if (d === 'in' || d === 'out') userMoved.current = true
      if (d === 'in') void rf.zoomIn({ duration: 120 })
      if (d === 'out') void rf.zoomOut({ duration: 120 })
      if (d === 'reset') {
        userMoved.current = false
        fit(200)
      }
    }
    window.addEventListener('hive:zoom', onZoom)
    return () => window.removeEventListener('hive:zoom', onZoom)
  }, [keyboard, rf, fit])
  const sized = useMemo(() => nodes.map(withStaticSize), [nodes])
  const shown = useMemo(() => (selectedId ? sized.map((n) => (n.id === selectedId ? { ...n, selected: true } : n)) : sized), [sized, selectedId])
  return (
    <ReactFlow
      nodes={shown}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={interactive}
      panOnScroll
      panOnDrag
      zoomOnPinch
      zoomOnScroll={false}
      zoomActivationKeyCode="Meta"
      minZoom={interactive ? 0.3 : MINI_MIN_ZOOM}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      onlyRenderVisibleElements
      onMoveStart={(e) => {
        // programmatic moves (fit/setViewport) report a null event
        if (e) userMoved.current = true
      }}
      onNodeClick={(_, n) => {
        const ref = (n.data as { ref: NodeRef | null }).ref
        if (ref && onSelect) onSelect(ref, n.id)
      }}
      onNodeDoubleClick={(_, n) => {
        const ref = (n.data as { ref: NodeRef | null }).ref
        if (ref && onOpen) onOpen(ref)
      }}
      onNodeContextMenu={(e, n) => {
        const ref = (n.data as { ref: NodeRef | null }).ref
        if (ref && onContext) {
          e.preventDefault()
          onContext(ref, e)
        }
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(255,255,255,0.08)" />
    </ReactFlow>
  )
}

export function GraphView(props: GraphViewProps): React.JSX.Element {
  return (
    <div className="graph">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
    </div>
  )
}
