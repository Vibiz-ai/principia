/**
 * Memory graph (MEMORY.md §10.3 + PO8): xyflow renderer, seeded deterministic layout (lib/memoryLayout),
 * custom entity pills and curved relation edges. Read-only map: no drag, no connect, no minimap, nothing saved.
 *
 * Readability at real sizes:
 * - one framed group per repository plus a Global lane, so repos don't mix and global entities don't sit with
 *   project orphans;
 * - semantic zoom: zoomed out, nodes become dots and only landmark labels stay (counter-scaled to stay legible);
 *   the type line shows only when zoomed in;
 * - the initial fit never goes below a readable zoom: if everything doesn't fit, it fits the densest cluster;
 * - it refits when the canvas resizes (window, inspector, filter rail) unless the user has panned or zoomed;
 * - each node shows what kinds of knowledge it holds, and hovering shows the top facts with their provenance.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import type { MemoryEntity, MemoryFact, MemoryFactKind, MemoryGraph as Graph, MemoryRelation } from '@shared/memory'
import { KIND_GLYPH, KIND_SINGULAR, entityHue, entityNodeSize, isRecent, kindMarks, landmarkIds, nameTwins, sourceLabel, topFacts } from '../../lib/memory'
import { layoutMemoryGroups, type LayoutGroup } from '../../lib/memoryLayout'
import { relative } from '../../lib/time'

/** Below this zoom the names are under ~7px: nodes turn into dots and only landmarks keep a label. */
export const FAR_ZOOM = 0.6
/** At and above this zoom the small-caps type line is legible (~9.5px). */
export const NEAR_ZOOM = 1
/** The initial fit doesn't go below this; if everything doesn't fit, it fits the densest cluster instead. */
const MIN_FIT_ZOOM = FAR_ZOOM
const MAX_FIT_ZOOM = 1.15
const HOVER_DELAY = 400

interface EntityData extends Record<string, unknown> {
  entity: MemoryEntity
  scopeLabel: string
  recent: boolean
  dim: boolean
  faded: boolean
  pulse: boolean
  related: boolean
  hover: boolean
  landmark: boolean
  marks: MemoryFactKind[]
}
interface BandData extends Record<string, unknown> {
  width: number
  height: number
  count: number
}
interface FrameData extends Record<string, unknown> {
  width: number
  height: number
  label: string
  count: number
  global: boolean
}
type EntityNode = Node<EntityData, 'memEntity'>
type BandNode = Node<BandData, 'memBand'>
type FrameNode = Node<FrameData, 'memFrame'>
type MemNode = EntityNode | BandNode | FrameNode

interface Box {
  x: number
  y: number
  w: number
  h: number
}
interface RelData extends Record<string, unknown> {
  rel: MemoryRelation
  from: Box
  to: Box
  dim: boolean
  emphasize: boolean
  /** The opposite direction exists too: bend further and push the label off the other one. */
  paired: boolean
}
interface TwinData extends Record<string, unknown> {
  from: Box
  to: Box
  dim: boolean
}
type RelEdge = Edge<RelData, 'memRelation'>
type TwinEdge = Edge<TwinData, 'memTwin'>
type MemEdge = RelEdge | TwinEdge

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }

const EntityView = memo(function EntityView({ data, selected }: NodeProps<EntityNode>) {
  const e = data.entity
  const c = e.counts
  const aria = `${e.name}, ${e.type}, ${c.active} active memor${c.active === 1 ? 'y' : 'ies'}${data.marks.length ? `, has ${data.marks.map((k) => KIND_SINGULAR[k] + 's').join(', ')}` : ''}${c.pending ? `, ${c.pending} to review` : ''}`
  return (
    <div
      className={[
        'mnode',
        e.repoId ? 'mnode--project' : 'mnode--global',
        data.recent ? 'is-recent' : '',
        selected ? 'is-selected' : '',
        data.dim ? 'is-dim' : '',
        data.faded ? 'is-faded' : '',
        data.related ? 'is-related' : '',
        data.hover ? 'is-hover' : '',
        data.landmark ? 'is-landmark' : '',
        data.pulse ? 'is-pulse' : '',
        data.marks.includes('gotcha') ? 'has-gotcha' : '',
        c.active === 0 && c.pending === 0 ? 'is-empty' : ''
      ].join(' ')}
      style={{ ['--mnode-hue' as string]: entityHue(e.type) }}
      aria-label={aria}
    >
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      <span className="mnode__dot" />
      <span className="mnode__text">
        <span className="mnode__name">{e.name}</span>
        <span className="mnode__type">{e.type}</span>
      </span>
      {data.marks.length > 0 && (
        <span className="mnode__kinds" aria-hidden>
          {data.marks.map((k) => (
            <span key={k} className={`mnode__kind mnode__kind--${k}`}>
              {KIND_GLYPH[k]}
            </span>
          ))}
        </span>
      )}
      {c.pinned > 0 && <span className="mnode__glyph" aria-label="has pinned facts">⌖</span>}
      {(c.pending > 0 || e.unattributed) && (
        <span className="mnode__glyph mnode__glyph--warn" aria-label={e.unattributed ? 'unattributed' : 'pending review'}>
          ⚠
        </span>
      )}
      {c.active > 0 && <span className="mnode__count">{c.active}</span>}
      {data.recent && <span className="mnode__new" aria-label="changed in the last 7 days" />}
    </div>
  )
})

const BandView = memo(function BandView({ data }: NodeProps<BandNode>) {
  return (
    <div className="mband" style={{ width: data.width, height: data.height }}>
      <span className="mband__label">No relations · {data.count}</span>
    </div>
  )
})

const FrameView = memo(function FrameView({ data }: NodeProps<FrameNode>) {
  return (
    <div className={`mframe ${data.global ? 'mframe--global' : ''}`} style={{ width: data.width, height: data.height }}>
      <span className="mframe__label">
        {data.label} <span className="mframe__count">{data.count}</span>
      </span>
    </div>
  )
})

/** Point where the segment from the box centre toward (px, py) leaves the box. */
function exitPoint(b: Box, px: number, py: number, pad = 3): { x: number; y: number } {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = px - cx
  const dy = py - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const tx = dx === 0 ? Infinity : (b.w / 2 + pad) / Math.abs(dx)
  const ty = dy === 0 ? Infinity : (b.h / 2 + pad) / Math.abs(dy)
  const t = Math.min(tx, ty, 1)
  return { x: cx + dx * t, y: cy + dy * t }
}

/** Quadratic curve between two boxes; the normal flips with direction, so reversed pairs bend to opposite sides. */
export function relationGeometry(from: Box, to: Box, paired: boolean): { path: string; label: { x: number; y: number } } {
  const ax = from.x + from.w / 2
  const ay = from.y + from.h / 2
  const bx = to.x + to.w / 2
  const by = to.y + to.h / 2
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const len = Math.hypot(bx - ax, by - ay) || 1
  const nx = -(by - ay) / len
  const ny = (bx - ax) / len
  const bend = paired ? Math.max(30, Math.min(48, len * 0.18)) : Math.min(36, len * 0.12)
  const qx = mx + nx * bend
  const qy = my + ny * bend
  const s = exitPoint(from, qx, qy)
  const t = exitPoint(to, qx, qy, 5)
  // the curve's apex, pushed a little further out for pairs so the two labels never share a line
  const push = paired ? 12 : 0
  return {
    path: `M${s.x},${s.y} Q${qx},${qy} ${t.x},${t.y}`,
    label: { x: 0.25 * s.x + 0.5 * qx + 0.25 * t.x + nx * push, y: 0.25 * s.y + 0.5 * qy + 0.25 * t.y + ny * push }
  }
}

const RelationView = memo(function RelationView({ id, data, selected }: EdgeProps<RelEdge>) {
  if (!data) return null
  const { rel } = data
  const g = relationGeometry(data.from, data.to, data.paired)
  const cls = ['medge', `medge--${rel.status}`, data.dim ? 'is-dim' : '', data.emphasize || selected ? 'is-emph' : ''].join(' ')
  return (
    <g className={cls}>
      <path id={id} className="medge__hit" d={g.path} />
      <path className="medge__path" d={g.path} markerEnd="url(#mem-arrow)" />
      {(data.emphasize || selected) && (
        <foreignObject x={g.label.x - 80} y={g.label.y - 10} width={160} height={20} className="medge__label-wrap">
          <div className="medge__label">{rel.type.replace(/_/g, ' ')}</div>
        </foreignObject>
      )}
    </g>
  )
})

/** Implicit hint between a project entity and a global entity with the same name (not a stored relation). */
const TwinView = memo(function TwinView({ data }: EdgeProps<TwinEdge>) {
  if (!data) return null
  const a = { x: data.from.x + data.from.w / 2, y: data.from.y + data.from.h / 2 }
  const b = { x: data.to.x + data.to.w / 2, y: data.to.y + data.to.h / 2 }
  const s = exitPoint(data.from, b.x, b.y)
  const t = exitPoint(data.to, a.x, a.y)
  return (
    <g className={`medge medge--twin ${data.dim ? 'is-dim' : ''}`}>
      <path className="medge__path" d={`M${s.x},${s.y} L${t.x},${t.y}`} />
      <title>Same name: probably the same thing (not a stored relation)</title>
    </g>
  )
})

const nodeTypes = { memEntity: EntityView, memBand: BandView, memFrame: FrameView }
const edgeTypes = { memRelation: RelationView, memTwin: TwinView }

export interface MemoryGraphProps {
  graph: Graph
  repoNames: Record<string, string>
  /** Live facts per entity (from the page's facts query): hover card and kind marks. */
  facts: Map<string, MemoryFact[]>
  selectedId: string | null
  /** Entity to center + pulse (search pick, deep link). */
  focusId: string | null
  /** With a run filter: entities that run touched; everything else is faded. null = no run filter. */
  runTouched: Set<string> | null
  onSelect: (id: string | null) => void
  onExpand: (id: string) => void
  onContext?: (id: string, e: React.MouseEvent) => void
  /** Bottom-left overlay (type legend). */
  children?: React.ReactNode
}

/** Groups: one per repository (largest first), then Global. A single group means no frames. */
function groupsOf(entities: MemoryEntity[], repoNames: Record<string, string>, sizes: Map<string, { width: number; height: number }>): LayoutGroup[] {
  const by = new Map<string, MemoryEntity[]>()
  for (const e of entities) {
    const k = e.repoId ?? '__global'
    const list = by.get(k)
    if (list) list.push(e)
    else by.set(k, [e])
  }
  const keys = [...by.keys()].sort((a, b) => {
    if (a === '__global') return 1
    if (b === '__global') return -1
    return by.get(b)!.length - by.get(a)!.length || (repoNames[a] ?? a).localeCompare(repoNames[b] ?? b)
  })
  return keys.map((k) => ({
    key: k,
    label: k === '__global' ? 'Global · every repository' : (repoNames[k] ?? 'Repository'),
    nodes: by.get(k)!.map((e) => ({ id: e.id, ...sizes.get(e.id)!, weight: e.counts.active, label: e.name }))
  }))
}

interface Card {
  id: string
  left: number
  top: number
  side: 'right' | 'left'
}

function Inner({ graph, repoNames, facts, selectedId, focusId, runTouched, onSelect, onExpand, onContext, containerRef, children }: MemoryGraphProps & { containerRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const rf = useReactFlow()
  const zoom = useFlowStore((s) => s.transform[2])
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [pulseId, setPulseId] = useState<string | null>(null)
  const [card, setCard] = useState<Card | null>(null)
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The user panned or zoomed since the last automatic fit: resizes then keep their view. */
  const userMoved = useRef(false)
  /** Until this time, view changes are ours (fit, center): they don't count as the user moving the view. */
  const autoUntil = useRef(0)
  const auto = (duration: number): void => {
    autoUntil.current = Date.now() + duration + 150
  }
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId

  const marksById = useMemo(() => {
    const m = new Map<string, MemoryFactKind[]>()
    for (const e of graph.entities) m.set(e.id, kindMarks(facts.get(e.id)))
    return m
  }, [graph.entities, facts])

  const layout = useMemo(() => {
    const sizes = new Map(graph.entities.map((e) => [e.id, entityNodeSize(e, marksById.get(e.id)?.length ?? 0)]))
    const res = layoutMemoryGroups(
      groupsOf(graph.entities, repoNames, sizes),
      graph.relations.map((r) => ({ source: r.fromId, target: r.toId }))
    )
    return { ...res, sizes }
  }, [graph, repoNames, marksById])

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const r of graph.relations) {
      if (!m.has(r.fromId)) m.set(r.fromId, new Set())
      if (!m.has(r.toId)) m.set(r.toId, new Set())
      m.get(r.fromId)!.add(r.toId)
      m.get(r.toId)!.add(r.fromId)
    }
    return m
  }, [graph.relations])
  const landmarks = useMemo(() => landmarkIds(graph.entities, graph.entities.length > 60 ? 16 : 12), [graph.entities])
  const twins = useMemo(() => nameTwins(graph.entities), [graph.entities])

  // hover wins over selection for the 1-hop highlight
  const lit = hoverId ?? null
  const litSet = useMemo(() => (lit ? new Set([lit, ...(neighbors.get(lit) ?? []), ...(twins.has(lit) ? [twins.get(lit)!] : [])]) : null), [lit, neighbors, twins])
  const selNeighbors = useMemo(() => (selectedId ? (neighbors.get(selectedId) ?? new Set<string>()) : new Set<string>()), [selectedId, neighbors])

  const now = Date.now()
  const nodes = useMemo<MemNode[]>(() => {
    const out: MemNode[] = []
    for (const f of layout.frames) {
      out.push({
        id: `__frame_${f.key}`,
        type: 'memFrame',
        position: { x: f.x, y: f.y },
        data: { width: f.width, height: f.height, label: f.label, count: f.count, global: f.key === '__global' },
        width: f.width,
        height: f.height,
        selectable: false,
        focusable: false,
        // decoration only: clicks and drags go through to the pane (deselect, pan)
        style: { pointerEvents: 'none' },
        zIndex: -2
      })
    }
    layout.bands.forEach((b, i) => {
      out.push({
        id: `__band${i}`,
        type: 'memBand',
        position: { x: b.x - 16, y: b.y - 30 },
        data: { width: b.width + 32, height: b.height + 46, count: b.count },
        width: b.width + 32,
        height: b.height + 46,
        selectable: false,
        focusable: false,
        style: { pointerEvents: 'none' },
        zIndex: -1
      })
    })
    for (const e of graph.entities) {
      const size = layout.sizes.get(e.id)!
      const pos = layout.positions[e.id] ?? { x: 0, y: 0 }
      const mid = size.width / 2
      out.push({
        id: e.id,
        type: 'memEntity',
        position: pos,
        width: size.width,
        height: size.height,
        measured: { width: size.width, height: size.height },
        handles: [
          { id: null, type: 'target', position: Position.Top, x: mid, y: size.height / 2, width: 1, height: 1 },
          { id: null, type: 'source', position: Position.Bottom, x: mid, y: size.height / 2, width: 1, height: 1 }
        ],
        selected: e.id === selectedId,
        data: {
          entity: e,
          scopeLabel: e.repoId ? `Project · ${repoNames[e.repoId] ?? 'repository'}` : 'Global',
          recent: isRecent(e.changedAt, now),
          dim: !!litSet && !litSet.has(e.id),
          faded: !!runTouched && !runTouched.has(e.id),
          related: selNeighbors.has(e.id) || (!!litSet && litSet.has(e.id) && e.id !== lit),
          hover: e.id === lit,
          landmark: landmarks.has(e.id),
          marks: marksById.get(e.id) ?? [],
          pulse: e.id === pulseId
        }
      })
    }
    return out
    // `now` only matters at 7-day granularity: recomputing with the data is enough
  }, [graph.entities, layout, selectedId, litSet, lit, runTouched, selNeighbors, pulseId, repoNames, landmarks, marksById])

  const box = useCallback(
    (id: string): Box => {
      const p = layout.positions[id] ?? { x: 0, y: 0 }
      const s = layout.sizes.get(id) ?? { width: 100, height: 34 }
      return { x: p.x, y: p.y, w: s.width, h: s.height }
    },
    [layout]
  )

  const edges = useMemo<MemEdge[]>(() => {
    const dirs = new Set(graph.relations.map((r) => `${r.fromId}>${r.toId}`))
    const rels: MemEdge[] = graph.relations
      .filter((r) => r.fromId !== r.toId && layout.sizes.has(r.fromId) && layout.sizes.has(r.toId))
      .map((r) => {
        const touchesLit = !!lit && (r.fromId === lit || r.toId === lit)
        const touchesSel = !!selectedId && (r.fromId === selectedId || r.toId === selectedId)
        const faded = !!runTouched && !(runTouched.has(r.fromId) && runTouched.has(r.toId))
        return {
          id: r.id,
          type: 'memRelation' as const,
          source: r.fromId,
          target: r.toId,
          selectable: false,
          focusable: false,
          data: {
            rel: r,
            from: box(r.fromId),
            to: box(r.toId),
            dim: (!!lit && !touchesLit) || (!lit && !!selectedId && !touchesSel) || faded,
            emphasize: touchesLit || touchesSel,
            paired: dirs.has(`${r.toId}>${r.fromId}`)
          }
        }
      })
    for (const [a, b] of twins) {
      // once per pair, project -> global
      const ea = graph.entities.find((e) => e.id === a)
      if (!ea?.repoId || !layout.sizes.has(a) || !layout.sizes.has(b)) continue
      rels.push({
        id: `__twin_${a}`,
        type: 'memTwin',
        source: a,
        target: b,
        selectable: false,
        focusable: false,
        data: { from: box(a), to: box(b), dim: !!lit && lit !== a && lit !== b }
      })
    }
    return rels
  }, [graph.relations, graph.entities, layout, lit, selectedId, runTouched, twins, box])

  // ---- fitting ----
  const viewSize = (): { w: number; h: number } | null => {
    const el = containerRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null
  }
  /** Fit everything if that stays readable; otherwise fit the densest cluster at a readable zoom. */
  const fit = useCallback(
    (duration = 0): void => {
      userMoved.current = false
      auto(duration)
      const size = viewSize()
      const ids = graph.entities.map((e) => e.id)
      if (!size || !ids.length) return
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const id of ids) {
        const b = box(id)
        x0 = Math.min(x0, b.x)
        y0 = Math.min(y0, b.y)
        x1 = Math.max(x1, b.x + b.w)
        y1 = Math.max(y1, b.y + b.h)
      }
      for (const f of layout.frames) {
        x0 = Math.min(x0, f.x)
        y0 = Math.min(y0, f.y)
        x1 = Math.max(x1, f.x + f.width)
        y1 = Math.max(y1, f.y + f.height)
      }
      const z = Math.min(size.w / ((x1 - x0) * 1.24), size.h / ((y1 - y0) * 1.24))
      if (z >= MIN_FIT_ZOOM) {
        void rf.fitView({ padding: 0.12, maxZoom: MAX_FIT_ZOOM, duration })
        return
      }
      // densest cluster: the best-connected entity and its neighbors (or the landmarks when it is small)
      const hub = [...graph.entities].sort((a, b) => b.degree - a.degree || b.counts.active - a.counts.active || a.name.localeCompare(b.name))[0]!
      let core = [hub.id, ...(neighbors.get(hub.id) ?? [])]
      if (core.length < 5) core = [...new Set([...core, ...landmarks])]
      void rf.fitView({ nodes: core.map((id) => ({ id })), padding: 0.18, minZoom: MIN_FIT_ZOOM, maxZoom: MAX_FIT_ZOOM, duration })
    },
    // viewSize reads a ref
    [graph.entities, layout, box, neighbors, landmarks, rf]
  )
  const fitRef = useRef(fit)
  fitRef.current = fit

  /** Pan (never zoom) so a node is on screen, e.g. after the inspector narrowed the canvas. */
  const ensureVisible = useCallback(
    (id: string, duration = 220): void => {
      const n = rf.getNode(id)
      const size = viewSize()
      if (!n || !size) return
      const { x, y, zoom: z } = rf.getViewport()
      const w = n.width ?? 120
      const h = n.height ?? 34
      const sx = n.position.x * z + x
      const sy = n.position.y * z + y
      const pad = 24
      if (sx < pad || sy < pad || sx + w * z > size.w - pad || sy + h * z > size.h - pad) {
        auto(duration)
        void rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: z, duration })
      }
    },
    // viewSize reads a ref
    [rf]
  )

  // fit whenever the data (not the highlight) changes
  const dataKey = useMemo(() => `${graph.entities.map((e) => e.id).join(',')}|${graph.relations.length}`, [graph])
  useEffect(() => {
    const t = setTimeout(() => fitRef.current(0), 20)
    return () => clearTimeout(t)
  }, [dataKey])

  // refit when the canvas changes size (window, inspector, filter rail), unless the user moved the view
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let t: ReturnType<typeof setTimeout> | null = null
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false // the initial observation: the data effect already fits
        return
      }
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        if (!userMoved.current) fitRef.current(180)
        const sel = selectedRef.current
        if (sel) setTimeout(() => ensureVisible(sel), userMoved.current ? 0 : 200)
      }, 150)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (t) clearTimeout(t)
    }
  }, [containerRef, ensureVisible])

  useEffect(() => {
    if (!focusId) return
    const t = setTimeout(() => {
      auto(250)
      void rf.fitView({ nodes: [{ id: focusId }], padding: 0.9, maxZoom: 1.2, duration: 250 })
      setPulseId(focusId)
    }, 60)
    const t2 = setTimeout(() => setPulseId(null), 1700)
    return () => {
      clearTimeout(t)
      clearTimeout(t2)
    }
  }, [focusId, rf, dataKey])

  // the inspector opening narrows the canvas: keep the selected node on screen (after any resize refit)
  useEffect(() => {
    if (!selectedId) return
    const t = setTimeout(() => ensureVisible(selectedId), 420)
    return () => clearTimeout(t)
  }, [selectedId, ensureVisible])

  useEffect(() => {
    const onZoom = (e: Event): void => {
      const d = (e as CustomEvent<'in' | 'out' | 'reset'>).detail
      if (d === 'in') {
        userMoved.current = true
        void rf.zoomIn({ duration: 120 })
      }
      if (d === 'out') {
        userMoved.current = true
        void rf.zoomOut({ duration: 120 })
      }
      if (d === 'reset') fitRef.current(200)
    }
    window.addEventListener('hive:zoom', onZoom)
    return () => window.removeEventListener('hive:zoom', onZoom)
  }, [rf])

  // ---- hover card ----
  const hideCard = (): void => {
    if (cardTimer.current) clearTimeout(cardTimer.current)
    cardTimer.current = null
    setCard(null)
  }
  useEffect(() => () => void (cardTimer.current && clearTimeout(cardTimer.current)), [])
  const scheduleCard = (id: string, target: EventTarget): void => {
    if (cardTimer.current) clearTimeout(cardTimer.current)
    const el = (target as HTMLElement).closest?.('.react-flow__node')
    cardTimer.current = setTimeout(() => {
      cardTimer.current = null
      const c = containerRef.current
      if (!el || !c || !el.isConnected) return
      const r = el.getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      const cardW = 300
      const right = r.right - cr.left + 10
      const side = right + cardW > cr.width - 8 ? 'left' : 'right'
      const left = side === 'right' ? right : Math.max(8, r.left - cr.left - 10 - cardW)
      const top = Math.max(8, Math.min(r.top - cr.top - 6, cr.height - 230))
      setCard({ id, left, top, side })
    }, HOVER_DELAY)
  }

  const isEntity = useCallback((n: Node): n is EntityNode => n.type === 'memEntity', [])
  const tier = zoom < FAR_ZOOM ? 'far' : zoom < NEAR_ZOOM ? 'mid' : 'near'
  const cardEntity = card ? graph.entities.find((e) => e.id === card.id) : undefined

  return (
    <>
      <ReactFlow<MemNode, MemEdge>
        className={['mflow', `mflow--${tier}`, graph.relations.length > 60 ? 'mflow--dense' : '', selectedId || lit ? 'mflow--focus' : ''].join(' ')}
        style={{ ['--mz' as string]: String(zoom) }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        panOnDrag
        zoomOnPinch
        zoomOnScroll={false}
        zoomActivationKeyCode="Meta"
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        onMoveStart={(ev) => {
          // programmatic moves (fit, center) pass no event
          if (ev && Date.now() > autoUntil.current) userMoved.current = true
          hideCard()
        }}
        onNodeClick={(_, n) => {
          if (!isEntity(n)) return
          hideCard()
          onSelect(n.id)
        }}
        onNodeDoubleClick={(_, n) => isEntity(n) && onExpand(n.id)}
        onNodeMouseEnter={(ev, n) => {
          if (!isEntity(n)) return
          setHoverId(n.id)
          scheduleCard(n.id, ev.target)
        }}
        onNodeMouseLeave={() => {
          setHoverId(null)
          hideCard()
        }}
        onNodeContextMenu={(e, n) => {
          if (!isEntity(n) || !onContext) return
          e.preventDefault()
          hideCard()
          onContext(n.id, e)
        }}
        onPaneClick={() => onSelect(null)}
      >
        <svg className="medge__defs" aria-hidden>
          <defs>
            <marker id="mem-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill="context-stroke" />
            </marker>
          </defs>
        </svg>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(255,255,255,0.06)" />
        <Controls
          showInteractive={false}
          showFitView={false}
          position="bottom-right"
          className="mem-controls"
          onZoomIn={() => (userMoved.current = true)}
          onZoomOut={() => (userMoved.current = true)}
        >
          <ControlButton onClick={() => fitRef.current(200)} title="Fit view" aria-label="Fit view">
            <svg viewBox="0 0 32 30" aria-hidden>
              <path d="M3.7 11.1V3.7h7.4V0H0v11.1h3.7zM20.9 0v3.7h7.4v7.4H32V0H20.9zM28.3 26.3h-7.4V30H32V18.9h-3.7v7.4zM3.7 18.9H0V30h11.1v-3.7H3.7v-7.4z" />
            </svg>
          </ControlButton>
        </Controls>
      </ReactFlow>
      {children}
      {card && cardEntity && <HoverCard entity={cardEntity} facts={facts.get(cardEntity.id) ?? []} twin={twins.has(cardEntity.id)} repoNames={repoNames} left={card.left} top={card.top} />}
    </>
  )
}

/** What an entity holds, without a click: top facts with kind and provenance (≈400 ms after hovering). */
function HoverCard({ entity: e, facts, twin, repoNames, left, top }: { entity: MemoryEntity; facts: MemoryFact[]; twin: boolean; repoNames: Record<string, string>; left: number; top: number }): React.JSX.Element {
  const top3 = topFacts(facts, 3)
  const live = facts.filter((f) => f.status !== 'invalid').length
  const more = Math.max(0, Math.max(live, e.counts.active + e.counts.pending) - top3.length)
  return (
    <div className="mcard popover" style={{ left, top }} role="tooltip">
      <div className="mcard__head">
        <span className="mnode__dot" style={{ ['--mnode-hue' as string]: entityHue(e.type) }} />
        <span className="mcard__name">{e.name}</span>
        <span className="mcard__type">{e.type}</span>
        <span className="flex1" />
        <span className={`mscope ${e.repoId ? '' : 'mscope--global'}`}>{e.repoId ? (repoNames[e.repoId] ?? 'project') : 'global'}</span>
      </div>
      {e.summary && <div className="mcard__summary">{e.summary}</div>}
      {top3.length === 0 ? (
        <div className="mcard__empty">{e.counts.active + e.counts.pending > 0 ? 'Memories hidden by the current filters.' : 'No live memories yet.'}</div>
      ) : (
        <ul className="mcard__facts">
          {top3.map((f) => (
            <li key={f.id} className={`mcard__fact mcard__fact--${f.kind}`}>
              <span className={`mcard__kind mnode__kind--${f.kind}`} title={KIND_SINGULAR[f.kind]}>
                {KIND_GLYPH[f.kind]}
              </span>
              <span className="mcard__body">
                <span className="mcard__text">{f.text}</span>
                <span className="mcard__meta">
                  {f.pinned && <span className="mbadge mbadge--pin">pinned</span>}
                  {f.status === 'pending' && <span className="mbadge mbadge--warn">to review</span>}
                  <span>
                    {KIND_SINGULAR[f.kind]} · {sourceLabel(f.provenance, { unattributed: f.unattributed })} · {relative(f.createdAt)}
                  </span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mcard__foot">
        {more > 0 ? `${more} more · ` : ''}click to open{e.degree > 0 ? ` · ${e.degree} relation${e.degree === 1 ? '' : 's'}` : ''}
        {twin && <div className="mcard__twin">{e.repoId ? 'A global entity has the same name.' : 'A project entity has the same name.'} Merge them from the inspector if they are the same thing.</div>}
      </div>
    </div>
  )
}

export function MemoryGraph(props: MemoryGraphProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div className="graph mgraph" ref={ref}>
      <ReactFlowProvider>
        <Inner {...props} containerRef={ref} />
      </ReactFlowProvider>
    </div>
  )
}
