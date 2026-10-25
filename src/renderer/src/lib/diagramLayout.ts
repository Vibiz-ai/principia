/**
 * DIAGRAMS.md §4: layered layout for a `principia-graph` block. dagre (already used by lib/graph.ts) ranks the nodes
 * left to right or top to bottom; groups are compound nodes one level deep. Pure: diagram in, boxes out, so tests
 * run without a DOM. Agents never write coordinates.
 */
import dagre from '@dagrejs/dagre'
import type { Diagram, DiagramEdge, DiagramNode } from '@shared/diagram'

export const DNODE_W = 148
export const DNODE_H = 76
export const DNOTE_W = 180
/** Room for a group's label above its first row of nodes. */
export const GROUP_HEAD = 26
const GROUP_PAD = 14

export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface LaidNode extends Box {
  node: DiagramNode
  /** a group that holds other nodes (drawn as a frame behind them) */
  frame: boolean
}
export interface DiagramLayout {
  nodes: LaidNode[]
  width: number
  height: number
  direction: 'right' | 'down'
}

/** Room an edge label takes on the canvas (11px text, 4px side padding): dagre keeps that much free between ranks. */
export function labelSize(label: string | undefined): { width: number; height: number } {
  if (!label) return { width: 0, height: 0 }
  return { width: Math.ceil(label.length * 6.6) + 16, height: 18 }
}

const sizeOf = (n: DiagramNode): { w: number; h: number } => (n.kind === 'note' ? { w: DNOTE_W, h: DNODE_H } : { w: DNODE_W, h: DNODE_H })

/** Edges for ranking: an edge that ends on a group frame ranks against that group's first member. */
function layoutEnds(e: DiagramEdge, firstChild: Map<string, string>): [string, string] {
  return [firstChild.get(e.from) ?? e.from, firstChild.get(e.to) ?? e.to]
}

export function layoutDiagram(d: Diagram): DiagramLayout {
  const direction = d.direction ?? 'right'
  const members = new Map<string, DiagramNode[]>()
  for (const n of d.nodes) if (n.group) members.set(n.group, [...(members.get(n.group) ?? []), n])
  const isFrame = (n: DiagramNode): boolean => n.kind === 'group' && (members.get(n.id)?.length ?? 0) > 0
  const firstChild = new Map<string, string>()
  for (const [g, list] of members) firstChild.set(g, list[0]!.id)

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true })
  g.setGraph({ rankdir: direction === 'down' ? 'TB' : 'LR', nodesep: 28, ranksep: 64, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of d.nodes) {
    if (isFrame(n)) g.setNode(n.id, {})
    else {
      const s = sizeOf(n)
      g.setNode(n.id, { width: s.w, height: s.h })
    }
  }
  for (const n of d.nodes) if (n.group && g.hasNode(n.group)) g.setParent(n.id, n.group)
  d.edges.forEach((e, i) => {
    const [a, b] = layoutEnds(e, firstChild)
    if (a === b || !g.hasNode(a) || !g.hasNode(b)) return
    // an edge between a frame member and its own frame says nothing about ranks
    const ls = labelSize(e.label)
    g.setEdge(a, b, ls.width ? { ...ls, labelpos: 'c' } : {}, `e${i}`)
  })
  dagre.layout(g)

  const out: LaidNode[] = []
  let minX = Infinity
  let minY = Infinity
  for (const n of d.nodes) {
    const p = g.node(n.id) as { x: number; y: number; width?: number; height?: number } | undefined
    const frame = isFrame(n)
    const s = sizeOf(n)
    const w = frame ? (p?.width ?? s.w) + GROUP_PAD * 2 : s.w
    const h = frame ? (p?.height ?? s.h) + GROUP_PAD * 2 + GROUP_HEAD : s.h
    const cx = p?.x ?? 0
    const cy = p?.y ?? 0
    const box: LaidNode = { node: n, frame, w, h, x: cx - w / 2, y: frame ? cy - h / 2 - GROUP_HEAD / 2 : cy - h / 2 }
    out.push(box)
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
  }
  let width = 0
  let height = 0
  for (const b of out) {
    b.x -= minX
    b.y -= minY
    width = Math.max(width, b.x + b.w)
    height = Math.max(height, b.y + b.h)
  }
  // frames first so their members draw on top
  out.sort((a, b) => Number(b.frame) - Number(a.frame))
  return { nodes: out, width, height, direction }
}

/** Neighbours of a node (itself included) and the indexes of the edges touching it: hover lights these up. */
export function neighbourhood(d: Diagram, ids: readonly string[]): { nodes: Set<string>; edges: Set<number> } {
  const focus = new Set(ids)
  // a group stands for its members
  for (const n of d.nodes) if (n.group && focus.has(n.group)) focus.add(n.id)
  const nodes = new Set(focus)
  const edges = new Set<number>()
  d.edges.forEach((e, i) => {
    if (focus.has(e.from) || focus.has(e.to)) {
      edges.add(i)
      nodes.add(e.from)
      nodes.add(e.to)
    }
  })
  // a frame stays lit while one of its members is
  for (const n of d.nodes) if (n.group && nodes.has(n.id)) nodes.add(n.group)
  return { nodes, edges }
}

/** Walkthrough focus: only the step's nodes and the edges between them (plus their frames). */
export function stepFocus(d: Diagram, ids: readonly string[]): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set(ids)
  const edges = new Set<number>()
  d.edges.forEach((e, i) => {
    if (nodes.has(e.from) && nodes.has(e.to)) edges.add(i)
  })
  for (const n of d.nodes) if (n.group && nodes.has(n.id)) nodes.add(n.group)
  return { nodes, edges }
}

/** What a walkthrough step lights: its focus, or (empty focus) nothing dimmed, an overview of the whole diagram. */
export const stepLit = (d: Diagram, ids: readonly string[]): { nodes: Set<string>; edges: Set<number> } | null => (ids.length ? stepFocus(d, ids) : null)

/** Gap between a back edge's lane and the cards it runs past, and between two lanes. */
export const LANE_GAP = 22

/**
 * Back edges: those whose target's entry side sits before the source's exit side (cycles, edges into a frame that
 * ranks earlier). Each gets a lane: a y (left to right) or x (top to bottom) just outside every card in the span it
 * crosses, so the loop is drawn in the open instead of folding under a card. Edge index → lane.
 */
export function backEdgeLanes(d: Diagram, l: DiagramLayout): Map<number, number> {
  const box = new Map(l.nodes.map((b) => [b.node.id, b]))
  const down = l.direction === 'down'
  const out = new Map<number, number>()
  let n = 0
  d.edges.forEach((e, i) => {
    const s = box.get(e.from)
    const t = box.get(e.to)
    if (!s || !t) return
    const back = down ? t.y < s.y + s.h + 8 : t.x < s.x + s.w + 8
    if (!back) return
    // the span the loop passes: from the target's entry to the source's exit, along the rank axis
    const lo = down ? Math.min(t.y, s.y) : Math.min(t.x, s.x)
    const hi = down ? Math.max(t.y + t.h, s.y + s.h) : Math.max(t.x + t.w, s.x + s.w)
    let edge = 0
    for (const b of l.nodes) {
      const a0 = down ? b.y : b.x
      const a1 = down ? b.y + b.h : b.x + b.w
      if (a1 < lo || a0 > hi) continue
      edge = Math.max(edge, down ? b.x + b.w : b.y + b.h)
    }
    out.set(i, edge + LANE_GAP + n * 10)
    n++
  })
  return out
}
