/**
 * DIAGRAMS.md §5: one ```principia-graph block, drawn. Inline it is a calm bordered panel (title, Fit, Open Full
 * Window, Copy JSON; Walk Through when the block has steps). React Flow with our own node cards, a layered dagre
 * layout (lib/diagramLayout.ts), hover to light a node's neighbours, click for details. Mounted only once scrolled
 * near the viewport, so a long chat with many diagrams stays light. An invalid block shows why, plus its JSON.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BaseEdge, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStoreApi, type Edge, type EdgeProps, type Node, type NodeHandle, type NodeProps } from '@xyflow/react'
import { parseDiagram, type Diagram, type DiagramEdgeKind, type DiagramNode } from '@shared/diagram'
import { backEdgeLanes, layoutDiagram, neighbourhood, stepLit, type DiagramLayout, type LaidNode } from '../../lib/diagramLayout'
import { hive } from '../../lib/hive'
import { toast } from '../../state/store'
import { openDiagramWindow } from '../../state/diagrams'
import { KIND_LABEL, KindIcon, STATUS_LABEL, ToolIcon, type DiagramTool } from './DiagramIcons'
import { MarkdownLite } from './MarkdownLite'
import '../../styles/diagrams.css'

type Mode = 'inline' | 'window'
interface CardData extends Record<string, unknown> {
  node: DiagramNode
  dim: boolean
  lit: boolean
  selected: boolean
  w: number
  h: number
}
type CardNode = Node<CardData, 'dnode'>
type FrameNode = Node<CardData, 'dframe'>

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }

function Handles({ down }: { down: boolean }): React.JSX.Element {
  return (
    <>
      <Handle type="target" position={down ? Position.Top : Position.Left} style={hidden} isConnectable={false} />
      <Handle type="source" position={down ? Position.Bottom : Position.Right} style={hidden} isConnectable={false} />
    </>
  )
}

const cls = (d: CardData): string => `${d.dim ? 'is-dim' : ''} ${d.lit ? 'is-lit' : ''} ${d.selected ? 'is-selected' : ''}`

const NodeCard = memo(function NodeCard({ data }: NodeProps<CardNode>) {
  const n = data.node
  const down = !!(data as { down?: boolean }).down
  return (
    <div
      className={`dnode dnode--${n.kind} ${n.kind === 'task' && n.status ? `dnode--${n.status}` : ''} ${cls(data)}`}
      style={{ width: data.w, height: data.h }}
      title={`${n.label}\n${KIND_LABEL[n.kind]}${n.status ? ` · ${STATUS_LABEL[n.status]}` : ''}${n.detail ? '\nClick for details' : ''}`}
    >
      <Handles down={down} />
      <span className="dnode__icon">
        <KindIcon kind={n.kind} status={n.status} />
      </span>
      <span className="dnode__label">{n.label}</span>
      {n.kind === 'task' && n.status && <span className="dnode__status">{STATUS_LABEL[n.status]}</span>}
    </div>
  )
})

const FrameCard = memo(function FrameCard({ data }: NodeProps<FrameNode>) {
  const down = !!(data as { down?: boolean }).down
  return (
    <div className={`dframe ${cls(data)}`} style={{ width: data.w, height: data.h }}>
      <Handles down={down} />
      <span className="dframe__label">
        <KindIcon kind="group" size={13} />
        {data.node.label}
      </span>
    </div>
  )
})

/** An empty point at the far side of the outermost back-edge lane, so Fit and the minimap include the loops. */
const Spacer = (): React.JSX.Element => <div style={{ width: 1, height: 1 }} />
const SPACER = '__dgm_lanes'

const nodeTypes = { dnode: NodeCard, dframe: FrameCard, dspace: Spacer }

/** Rounded orthogonal path through points (corner radius r). */
function roundedPath(pts: readonly [number, number][], r = 8): string {
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!
    const [x, y] = pts[i]!
    const [nx, ny] = pts[i + 1]!
    const a = Math.min(r, Math.hypot(x - px, y - py) / 2)
    const b = Math.min(r, Math.hypot(nx - x, ny - y) / 2)
    const ux = Math.sign(x - px)
    const uy = Math.sign(y - py)
    const vx = Math.sign(nx - x)
    const vy = Math.sign(ny - y)
    d += ` L ${x - ux * a} ${y - uy * a} Q ${x} ${y} ${x + vx * b} ${y + vy * b}`
  }
  const last = pts[pts.length - 1]!
  return `${d} L ${last[0]} ${last[1]}`
}

interface LoopData extends Record<string, unknown> {
  lane: number
  down: boolean
}
/**
 * An edge that points backwards (a cycle, or into a frame that sits before it): a bezier would fold into a hook
 * under the card, so it leaves forward, runs along a lane outside the cards it passes, and comes back in.
 */
const LoopEdge = memo(function LoopEdge(p: EdgeProps<Edge<LoopData>>) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = p
  const lane = p.data?.lane ?? 0
  const o = 18
  const pts: [number, number][] = p.data?.down
    ? [[sx, sy], [sx, sy + o], [lane, sy + o], [lane, ty - o], [tx, ty - o], [tx, ty]]
    : [[sx, sy], [sx + o, sy], [sx + o, lane], [tx - o, lane], [tx - o, ty], [tx, ty]]
  const [lx, ly] = p.data?.down ? [lane, (sy + ty) / 2] : [(sx + tx) / 2, lane]
  return (
    <BaseEdge
      id={p.id}
      path={roundedPath(pts)}
      markerEnd={p.markerEnd}
      style={p.style}
      label={p.label}
      labelX={lx}
      labelY={ly}
      labelStyle={p.labelStyle}
      labelShowBg={p.labelShowBg}
      labelBgStyle={p.labelBgStyle}
      labelBgPadding={p.labelBgPadding}
      labelBgBorderRadius={p.labelBgBorderRadius}
    />
  )
})

const edgeTypes = { dloop: LoopEdge }

/** Greys for meaning-free edges, the problem red for `blocks` (--status-failed). */
const EDGE_COLOR: Record<DiagramEdgeKind, string> = {
  flow: 'rgba(230, 230, 233, 0.6)',
  call: 'rgba(230, 230, 233, 0.6)',
  data: 'rgba(230, 230, 233, 0.5)',
  async: 'rgba(230, 230, 233, 0.55)',
  depends: 'rgba(230, 230, 233, 0.38)',
  blocks: '#f25c5c'
}
const EDGE_DASH: Partial<Record<DiagramEdgeKind, string>> = { data: '1.5 4', depends: '6 5', async: '5 5' }

function handlesFor(b: LaidNode, down: boolean): NodeHandle[] {
  return down
    ? [
        { id: null, type: 'target', position: Position.Top, x: b.w / 2, y: 0, width: 1, height: 1 },
        { id: null, type: 'source', position: Position.Bottom, x: b.w / 2, y: b.h - 1, width: 1, height: 1 }
      ]
    : [
        { id: null, type: 'target', position: Position.Left, x: 0, y: b.h / 2, width: 1, height: 1 },
        { id: null, type: 'source', position: Position.Right, x: b.w - 1, y: b.h / 2, width: 1, height: 1 }
      ]
}

function buildNodes(l: DiagramLayout, lit: { nodes: Set<string> } | null, selected: string | null): Node<CardData>[] {
  const down = l.direction === 'down'
  return l.nodes.map((b) => {
    const data = {
      node: b.node,
      w: b.w,
      h: b.h,
      dim: !!lit && !lit.nodes.has(b.node.id),
      lit: !!lit && lit.nodes.has(b.node.id),
      selected: selected === b.node.id,
      down
    }
    return {
      id: b.node.id,
      type: b.frame ? 'dframe' : 'dnode',
      position: { x: b.x, y: b.y },
      data,
      width: b.w,
      height: b.h,
      measured: { width: b.w, height: b.h },
      handles: handlesFor(b, down),
      zIndex: b.frame ? 0 : 1,
      draggable: false,
      selectable: false,
      connectable: false
    } as Node<CardData>
  })
}

function buildEdges(d: Diagram, l: DiagramLayout, lanes: Map<number, number>, lit: { edges: Set<number> } | null): Edge[] {
  return d.edges.map((e, i) => {
    const lane = lanes.get(i)
    const kind = e.kind ?? 'flow'
    const color = EDGE_COLOR[kind]
    const dim = !!lit && !lit.edges.has(i)
    return {
      id: `e${i}`,
      source: e.from,
      target: e.to,
      type: lane === undefined ? 'default' : 'dloop',
      ...(lane === undefined ? {} : { data: { lane, down: l.direction === 'down' } }),
      className: `dedge dedge--${kind} ${dim ? 'is-dim' : ''} ${lit && !dim ? 'is-lit' : ''}`,
      label: e.label,
      labelStyle: { fill: kind === 'blocks' ? color : 'var(--text-secondary)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--surface-1)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: kind === 'blocks' ? 1.6 : 1.3, ...(EDGE_DASH[kind] ? { strokeDasharray: EDGE_DASH[kind] } : {}) },
      zIndex: 0,
      selectable: false,
      focusable: false
    }
  })
}

async function copyJson(raw: string): Promise<void> {
  try {
    await hive.clipboard.writeText({ text: raw })
    toast('JSON copied')
  } catch {
    toast('Couldn’t copy the JSON', 'error')
  }
}

function ToolButton({ icon, label, onClick }: { icon: DiagramTool; label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="dgm__tool" title={label} aria-label={label} onClick={onClick}>
      <ToolIcon name={icon} />
    </button>
  )
}

const INLINE_MIN = 170
const INLINE_MAX = 440
/** Inline canvas height for a container width: the layout's height at the zoom Fit will pick, clamped. */
/** Below this zoom labels are unreadable: an inline diagram opens at this zoom and pans sideways; Fit still frames all. */
export const READABLE_ZOOM = 0.6
export function inlineHeight(l: Pick<DiagramLayout, 'width' | 'height'>, width: number): number {
  const zoom = Math.min(1.1, Math.max(READABLE_ZOOM, (width - 48) / Math.max(l.width, 1)))
  return Math.round(Math.min(INLINE_MAX, Math.max(INLINE_MIN, l.height * zoom + 56)))
}

// ---------- the drawn diagram (inline or full window) ----------

function Viewer({ diagram, raw, mode, warnings = [], onClose }: { diagram: Diagram; raw: string; mode: Mode; warnings?: string[]; onClose?: () => void }): React.JSX.Element {
  const rf = useReactFlow()
  const layout = useMemo(() => layoutDiagram(diagram), [diagram])
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [step, setStep] = useState<number | null>(null)
  const [width, setWidth] = useState(640)
  const panel = useRef<HTMLDivElement>(null)
  const steps = diagram.steps ?? []
  const cur = step !== null ? steps[step] : undefined

  // a step with an empty focus is an overview: everything stays lit
  const lit = useMemo(() => (cur ? stepLit(diagram, cur.focus) : hover ? neighbourhood(diagram, [hover]) : null), [cur, hover, diagram])
  const lanes = useMemo(() => backEdgeLanes(diagram, layout), [diagram, layout])
  /** The layout with room for the loops: the lanes run outside the cards. */
  const extent = useMemo(() => {
    const far = Math.max(0, ...lanes.values()) + 12
    return layout.direction === 'down' ? { width: Math.max(layout.width, far), height: layout.height } : { width: layout.width, height: Math.max(layout.height, far) }
  }, [lanes, layout])
  const nodes = useMemo(() => {
    const list = buildNodes(layout, lit, selected)
    if (!lanes.size) return list
    const spacer = { id: SPACER, type: 'dspace', position: { x: extent.width - 1, y: extent.height - 1 }, data: {}, width: 1, height: 1, measured: { width: 1, height: 1 }, draggable: false, selectable: false, connectable: false }
    return [...list, spacer as unknown as Node<CardData>]
  }, [layout, lit, selected, lanes, extent])
  const edges = useMemo(() => buildEdges(diagram, layout, lanes, lit), [diagram, layout, lanes, lit])

  const store = useStoreApi()
  const fit = useCallback((duration = 200) => void rf.fitView({ padding: 0.12, maxZoom: 1.1, duration }), [rf])
  /** First view: everything when it stays readable, else the start of the diagram at a readable zoom. */
  const frame = useCallback((tries = 0): void => {
    const { width: W, height: H } = store.getState()
    // not measured yet (first paint, hidden window): look again shortly
    if (!W || !H) return void (tries < 20 && setTimeout(() => frame(tries + 1), 100))
    const z = Math.min(1.1, (W - 48) / Math.max(extent.width, 1), (H - 32) / Math.max(extent.height, 1))
    if (mode === 'window' || z >= READABLE_ZOOM) return fit(0)
    const zoom = READABLE_ZOOM
    void rf.setViewport({ x: 24, y: Math.max(16, (H - extent.height * zoom) / 2), zoom })
  }, [store, rf, extent, mode, fit])
  useEffect(() => {
    const el = panel.current
    if (!el || mode !== 'inline') return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [mode])
  // the canvas changes size (first measure, window resize): frame everything again
  useEffect(() => {
    const t = setTimeout(() => (cur ? undefined : frame()), 40)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, frame])
  useEffect(() => {
    if (!cur) return
    const t = setTimeout(
      () => void (cur.focus.length ? rf.fitView({ nodes: cur.focus.map((id) => ({ id })), padding: 0.35, maxZoom: 1.1, duration: 250 }) : fit(250)),
      20
    )
    return () => clearTimeout(t)
  }, [cur, rf, fit])

  const startWalk = (): void => {
    setSelected(null)
    setStep(0)
    panel.current?.focus()
  }
  const endWalk = (): void => {
    setStep(null)
    fit()
  }
  const go = (delta: number): void => {
    if (step === null) return
    const next = step + delta
    if (next >= steps.length) endWalk()
    else setStep(Math.max(0, next))
  }

  const sel = selected ? diagram.nodes.find((n) => n.id === selected) : undefined
  const selLinks = sel
    ? diagram.edges.filter((e) => e.from === sel.id || e.to === sel.id).map((e) => (e.from === sel.id ? `→ ${label(diagram, e.to)}` : `← ${label(diagram, e.from)}`))
    : []
  const height = mode === 'inline' ? inlineHeight(extent, width) : undefined

  return (
    <div
      ref={panel}
      tabIndex={-1}
      className={`dgm dgm--${mode} ${step !== null ? 'is-walking' : ''}`}
      onKeyDown={(e) => {
        if (step !== null) {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            endWalk()
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            go(1)
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            go(-1)
          }
        } else if (e.key === 'Escape' && sel) {
          e.preventDefault()
          e.stopPropagation()
          setSelected(null)
        }
      }}
    >
      <div className="dgm__head">
        <span className="dgm__title" title={diagram.title}>
          {diagram.title || 'Diagram'}
        </span>
        <span className="dgm__count">
          {diagram.nodes.length} node{diagram.nodes.length === 1 ? '' : 's'}
        </span>
        {warnings.length > 0 && (
          <span className="dgm__fixed" title={warnings.join('\n')}>
            {warnings.length} fixed
          </span>
        )}
        <span className="flex1" />
        {steps.length > 0 && step === null && (
          <button type="button" className="dgm__walk" onClick={startWalk}>
            Walk Through
          </button>
        )}
        <ToolButton icon="fit" label="Fit" onClick={() => fit()} />
        {mode === 'inline' && <ToolButton icon="expand" label="Open Full Window" onClick={() => openDiagramWindow(raw)} />}
        <ToolButton icon="copy" label="Copy JSON" onClick={() => void copyJson(raw)} />
        {onClose && <ToolButton icon="close" label="Close" onClick={onClose} />}
      </div>
      <div className="dgm__canvas" style={height ? { height } : undefined}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          panOnDrag
          panOnScroll={mode === 'window'}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          zoomActivationKeyCode="Meta"
          preventScrolling={mode === 'window'}
          minZoom={0.15}
          maxZoom={2}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          proOptions={{ hideAttribution: true }}
          onInit={() => frame()}
          onNodeMouseEnter={(_, n) => n.id !== SPACER && setHover(n.id)}
          onNodeMouseLeave={() => setHover(null)}
          onNodeClick={(_, n) => step === null && n.id !== SPACER && setSelected((s) => (s === n.id ? null : n.id))}
          onPaneClick={() => setSelected(null)}
        >
          {mode === 'window' && (
            <MiniMap
              pannable
              zoomable
              className="dgm__minimap"
              maskColor="rgba(0, 0, 0, 0.45)"
              nodeColor={(n) => (n.id === SPACER || (n.data as CardData).node.kind === 'group' ? 'transparent' : 'rgba(230, 230, 233, 0.35)')}
              nodeStrokeColor={(n) => (n.id !== SPACER && (n.data as CardData).node.kind === 'group' ? 'rgba(230, 230, 233, 0.25)' : 'transparent')}
            />
          )}
        </ReactFlow>
        {sel && (
          <aside className="dgm__pop" aria-label={`${sel.label} details`}>
            <div className="dgm__pop-head">
              <span className="dgm__pop-icon">
                <KindIcon kind={sel.kind} status={sel.status} size={16} />
              </span>
              <span className="dgm__pop-title">{sel.label}</span>
              <button type="button" className="dgm__tool" aria-label="Close details" onClick={() => setSelected(null)}>
                <ToolIcon name="close" size={12} />
              </button>
            </div>
            <div className="dgm__pop-kind">
              {KIND_LABEL[sel.kind]}
              {sel.status ? ` · ${STATUS_LABEL[sel.status]}` : ''}
              {sel.group ? ` · in ${label(diagram, sel.group)}` : ''}
            </div>
            {sel.detail ? <MarkdownLite text={sel.detail} /> : <p className="dgm__pop-empty">No details.</p>}
            {selLinks.length > 0 && (
              <div className="dgm__pop-links">
                {selLinks.slice(0, 8).map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
                {selLinks.length > 8 && <div>+{selLinks.length - 8} more</div>}
              </div>
            )}
          </aside>
        )}
      </div>
      {cur && step !== null && (
        <div className="dgm__caption" role="status">
          <div className="dgm__caption-nav">
            <button type="button" className="dgm__step-btn" disabled={step === 0} onClick={() => go(-1)}>
              Back
            </button>
            <span className="dgm__step-count">
              {step + 1} of {steps.length}
            </span>
            <button type="button" className="dgm__step-btn" onClick={() => go(1)}>
              {step === steps.length - 1 ? 'Done' : 'Next'}
            </button>
            <span className="flex1" />
            <button type="button" className="dgm__step-btn dgm__step-btn--quiet" onClick={endWalk} title="Esc">
              Exit
            </button>
          </div>
          <div className="dgm__caption-title">{cur.title}</div>
          {cur.text && <MarkdownLite text={cur.text} />}
        </div>
      )}
    </div>
  )
}

const label = (d: Diagram, id: string): string => d.nodes.find((n) => n.id === id)?.label ?? id

// ---------- errors ----------

const RAW_SHOWN = 64 * 1024

export function DiagramError({ error, raw, tooLarge }: { error: string; raw: string; tooLarge?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="dgm dgm--error" role="group" aria-label="Diagram error">
      <div className="dgm-err__head">
        <ToolIcon name="warning" />
        <span className="selectable">{tooLarge ? error : `This diagram couldn’t be drawn: ${error}`}</span>
      </div>
      <div className="dgm-err__row">
        <button type="button" className="dgm__walk" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide JSON' : 'Show JSON'}
        </button>
        <ToolButton icon="copy" label="Copy JSON" onClick={() => void copyJson(raw)} />
      </div>
      {open && (
        <pre className="dgm-err__raw mono selectable">
          {raw.length > RAW_SHOWN ? `${raw.slice(0, RAW_SHOWN)}\n… (${Math.round(raw.length / 1024)} KB in all; Copy JSON copies everything)` : raw}
        </pre>
      )}
    </div>
  )
}

// ---------- the block ----------

/** Shown until the block scrolls near the viewport: same frame, no React Flow yet. */
function Placeholder({ diagram, height }: { diagram: Diagram; height: number }): React.JSX.Element {
  return (
    <div className="dgm dgm--inline dgm--idle">
      <div className="dgm__head">
        <span className="dgm__title">{diagram.title || 'Diagram'}</span>
        <span className="dgm__count">
          {diagram.nodes.length} node{diagram.nodes.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="dgm__canvas dgm__canvas--idle" style={{ height }} />
    </div>
  )
}

/** The fenced block's body (the JSON). Renders the diagram, or the readable error with the JSON. */
export function DiagramBlock({ source }: { source: string }): React.JSX.Element {
  const parsed = useMemo(() => parseDiagram(source), [source])
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (near || !parsed.ok) return
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined') return setNear(true)
    // already on screen: draw now (IntersectionObserver waits for a rendered frame, which a hidden window never makes)
    const r = el.getBoundingClientRect()
    if (r.top < window.innerHeight + 240 && r.bottom > -240) return setNear(true)
    const io = new IntersectionObserver((list) => list.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '240px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [near, parsed.ok])
  if (!parsed.ok) return <DiagramError error={parsed.error} raw={parsed.raw} tooLarge={parsed.tooLarge} />
  return (
    <div className="dgm-wrap" ref={box}>
      {near ? (
        <ReactFlowProvider>
          <Viewer diagram={parsed.diagram} raw={parsed.raw} warnings={parsed.warnings} mode="inline" />
        </ReactFlowProvider>
      ) : (
        <Placeholder diagram={parsed.diagram} height={INLINE_MIN + 60} />
      )}
    </div>
  )
}

/** Full Window body (shell/DiagramOverlays): same viewer, a minimap, no Open button. */
export function DiagramFull({ source, onClose }: { source: string; onClose: () => void }): React.JSX.Element {
  const parsed = useMemo(() => parseDiagram(source), [source])
  if (!parsed.ok) return <DiagramError error={parsed.error} raw={parsed.raw} tooLarge={parsed.tooLarge} />
  return (
    <ReactFlowProvider>
      <Viewer diagram={parsed.diagram} raw={parsed.raw} warnings={parsed.warnings} mode="window" onClose={onClose} />
    </ReactFlowProvider>
  )
}
