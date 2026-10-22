/**
 * The Passport graph model and simulation (PASSPORT.md §10 Graph mode): d3-force (Barnes-Hut many-body, links,
 * centering, collide) over the compact `VaultGraph` payload, stepped manually from requestAnimationFrame so the
 * renderer owns the frame budget and tests can tick it synchronously. Seeded randomness (d3's LCG) makes a given
 * graph + seed lay out identically every time; saved positions (mem_layout) are the start, and a graph that opens
 * mostly from saved positions starts cool so the picture does not jump.
 *
 * Also the Obsidian-style display rules shared by the global and local graphs: radius from in-degree, colour by
 * type or by user groups (`path:"People"`, `tag:#x`, `type:person`, or plain text), label fade with zoom, hit testing.
 * Pure: no DOM, no React.
 */
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { GraphPosition, VaultGraph } from '@shared/passport'
import { lcg, seedPositions } from './memoryLayout'

export interface GNode extends SimulationNodeDatum {
  id: string
  title: string
  type: string
  inDegree: number
  /** links in + out inside this graph */
  degree: number
  ghost: boolean
  tag: boolean
  tags: string[]
  r: number
  x: number
  y: number
}
export interface GLink extends SimulationLinkDatum<GNode> {
  source: GNode
  target: GNode
  rel: string
  weight: number
}
export interface GraphModel {
  nodes: GNode[]
  links: GLink[]
  byId: Map<string, GNode>
  neighbors: Map<string, Set<string>>
  /** share of nodes that started from a saved position */
  savedShare: number
}

/** Obsidian's four sliders, in its own units. */
export interface Forces {
  /** 0..1 */
  center: number
  /** 0..20 */
  repel: number
  /** 0..1 */
  linkStrength: number
  /** 30..500 */
  linkDistance: number
}
export const DEFAULT_FORCES: Forces = { center: 0.5, repel: 10, linkStrength: 1, linkDistance: 120 }

export interface Display {
  arrows: boolean
  /** -3..3: labels fade in above this zoom (log2 scale, like Obsidian's text fade threshold) */
  textFade: number
  /** 0.5..3 */
  nodeSize: number
  /** 0.5..3 */
  linkThickness: number
}
export const DEFAULT_DISPLAY: Display = { arrows: false, textFade: 0, nodeSize: 1, linkThickness: 1 }

export function nodeRadius(inDegree: number, mul = 1): number {
  return (3 + Math.sqrt(Math.max(0, inDegree)) * 1.6) * mul
}

/** Builds simulation nodes and links from the IPC payload; positions come from `saved`, then `seedPositions`. */
export function buildModel(g: VaultGraph, opts: { sizeMul?: number; saved?: ReadonlyMap<string, { x: number; y: number }> } = {}): GraphModel {
  const mul = opts.sizeMul ?? 1
  const saved = new Map<string, { x: number; y: number }>(opts.saved ?? [])
  for (const [id, x, y] of g.positions) if (!saved.has(id)) saved.set(id, { x, y })
  const ids = g.nodes.map((n) => n[0])
  const edgeIds = g.edges
    .filter(([s, t]) => g.nodes[s] && g.nodes[t])
    .map(([s, t]) => ({ source: g.nodes[s]![0], target: g.nodes[t]![0] }))
  const seeds = seedPositions(ids, edgeIds, saved)
  let fromSaved = 0
  const nodes: GNode[] = g.nodes.map(([id, title, type, inDegree, ghost, tagIdx]) => {
    const p = seeds.get(id) ?? { x: 0, y: 0 }
    if (saved.has(id)) fromSaved++
    return {
      id,
      title,
      type,
      inDegree,
      degree: 0,
      ghost: ghost === 1,
      tag: type === 'tag' || id.startsWith('tag:'),
      tags: tagIdx.map((i) => g.tags[i]).filter((t): t is string => !!t),
      r: nodeRadius(inDegree, mul),
      x: p.x,
      y: p.y
    }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const neighbors = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]))
  const links: GLink[] = []
  const seen = new Set<string>()
  for (const [s, t, rel, weight] of g.edges) {
    const a = nodes[s]
    const b = nodes[t]
    if (!a || !b || a === b) continue
    const k = `${s}>${t}>${rel}`
    if (seen.has(k)) continue
    seen.add(k)
    links.push({ source: a, target: b, rel: g.rels[rel] ?? 'links_to', weight })
    a.degree++
    b.degree++
    neighbors.get(a.id)!.add(b.id)
    neighbors.get(b.id)!.add(a.id)
  }
  return { nodes, links, byId, neighbors, savedShare: nodes.length ? fromSaved / nodes.length : 0 }
}

/** A stopped simulation: call `tick()` per frame (or `stepUntilCool` in tests and for the local graph). */
export function createSimulation(model: GraphModel, forces: Forces = DEFAULT_FORCES, opts: { seed?: number } = {}): Simulation<GNode, GLink> {
  const sim = forceSimulation<GNode, GLink>(model.nodes)
    .randomSource(lcg(opts.seed ?? 0x5eed))
    .velocityDecay(0.4)
    .alphaDecay(0.0228)
    .stop()
  applyForces(sim, model, forces)
  // mostly saved: start cool so the remembered picture stays put while new nodes settle in
  sim.alpha(model.savedShare >= 0.8 ? 0.12 : model.savedShare >= 0.3 ? 0.4 : 1)
  return sim
}

export function applyForces(sim: Simulation<GNode, GLink>, model: GraphModel, f: Forces): void {
  const big = model.nodes.length > 1500
  sim
    .force(
      'charge',
      forceManyBody<GNode>()
        .strength((n) => -(f.repel * 14) * (n.tag ? 0.5 : 1))
        .theta(big ? 1.1 : 0.9)
        .distanceMax(big ? 900 : 2000)
    )
    .force(
      'link',
      forceLink<GNode, GLink>(model.links)
        .id((n) => n.id)
        .distance(f.linkDistance * 0.5)
        .strength((l) => f.linkStrength * Math.min(1, l.weight) / Math.min(l.source.degree || 1, l.target.degree || 1))
    )
    .force('center', forceCenter<GNode>(0, 0).strength(1))
    .force('x', forceX<GNode>(0).strength(f.center * 0.12))
    .force('y', forceY<GNode>(0).strength(f.center * 0.12))
    .force('collide', big ? null : forceCollide<GNode>((n) => n.r + 2).iterations(1))
}

/** Synchronous ticks until the simulation cools (or `max`); returns the ticks run. */
export function stepUntilCool(sim: Simulation<GNode, GLink>, max = 300): number {
  let n = 0
  while (sim.alpha() > sim.alphaMin() && n < max) {
    sim.tick()
    n++
  }
  return n
}

export function positionsOf(nodes: GNode[]): GraphPosition[] {
  return nodes
    .filter((n) => !n.tag && Number.isFinite(n.x) && Number.isFinite(n.y))
    .map((n) => ({ noteId: n.id, x: Math.round(n.x), y: Math.round(n.y), pinned: n.fx != null }))
}

// ---------- view transform, hit testing, labels ----------
export interface Transform {
  k: number
  x: number
  y: number
}
export const toScreen = (t: Transform, x: number, y: number): [number, number] => [x * t.k + t.x, y * t.k + t.y]
export const toWorld = (t: Transform, sx: number, sy: number): [number, number] => [(sx - t.x) / t.k, (sy - t.y) / t.k]

/** Zoom around a screen point. */
export function zoomAt(t: Transform, sx: number, sy: number, factor: number, min = 0.05, max = 8): Transform {
  const k = Math.min(max, Math.max(min, t.k * factor))
  const [wx, wy] = toWorld(t, sx, sy)
  return { k, x: sx - wx * k, y: sy - wy * k }
}

/** A transform that fits every node in a w×h viewport with a margin. */
export function fitTransform(nodes: { x: number; y: number; r: number }[], w: number, h: number, pad = 40): Transform {
  if (!nodes.length || w <= 0 || h <= 0) return { k: 1, x: w / 2, y: h / 2 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r)
    y0 = Math.min(y0, n.y - n.r)
    x1 = Math.max(x1, n.x + n.r)
    y1 = Math.max(y1, n.y + n.r)
  }
  const k = Math.min(2, Math.max(0.05, Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0))))
  return { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k }
}

/** Topmost node under a world point (drawn last wins); `slop` is in world units. */
export function hitTest(nodes: GNode[], wx: number, wy: number, slop = 3): GNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!
    const r = n.r + slop
    const dx = n.x - wx
    const dy = n.y - wy
    if (dx * dx + dy * dy <= r * r) return n
  }
  return null
}

/** Label opacity at zoom `k`: fades in over one zoom octave above the threshold (log2 units). */
export function labelAlpha(k: number, threshold: number): number {
  const z = Math.log2(Math.max(1e-6, k))
  return Math.min(1, Math.max(0, (z - (threshold - 1)) / 1))
}

/** The node, its neighbours, and the links between them: hover and selection highlight. */
export function neighborhood(model: GraphModel, id: string | null): Set<string> | null {
  if (!id || !model.byId.has(id)) return null
  return new Set([id, ...(model.neighbors.get(id) ?? [])])
}

// ---------- colours and groups ----------
export interface GraphGroup {
  query: string
  /** #rrggbb */
  color: string
}

/** Defaults mirror the seeded `.obsidian/graph.json` (colour groups by folder). */
export const DEFAULT_GROUPS: GraphGroup[] = [
  ['People', '#4f9dde'],
  ['Customers', '#43b581'],
  ['Offers', '#f2a33a'],
  ['Products', '#e8618c'],
  ['Brand', '#b57edc'],
  ['Repos', '#7a8899'],
  ['Decisions', '#e0b93e'],
  ['Conventions', '#5fb3b3'],
  ['Gotchas', '#e5534b'],
  ['Processes', '#8bc34a'],
  ['Meetings', '#9e9e9e'],
  ['Concepts', '#64b5f6'],
  ['Inbox', '#bdbdbd']
].map(([folder, color]) => ({ query: `path:"${folder}"`, color: color! }))

/** Type colours when no group matches (the folder colour of the type's default folder). */
const TYPE_COLOR: Record<string, string> = {
  company: '#6e8cff',
  person: '#4f9dde',
  customer: '#43b581',
  offer: '#f2a33a',
  product: '#e8618c',
  brand: '#b57edc',
  repo: '#7a8899',
  decision: '#e0b93e',
  convention: '#5fb3b3',
  gotcha: '#e5534b',
  process: '#8bc34a',
  meeting: '#9e9e9e',
  concept: '#64b5f6',
  component: '#9085e9',
  file: '#a1a1a9',
  note: '#8b8d96',
  tag: '#3ecf8e'
}
export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? '#8b8d96'
}

export type GroupQuery =
  | { kind: 'path'; value: string }
  | { kind: 'tag'; value: string }
  | { kind: 'type'; value: string }
  | { kind: 'text'; value: string }

/** `path:"People"`, `path:People`, `tag:#x`, `type:person`, `file:x` or plain text (title contains). */
export function parseGroupQuery(q: string): GroupQuery | null {
  const s = q.trim()
  if (!s) return null
  const m = /^(path|tag|type|file|title):\s*(?:"([^"]*)"|(\S.*))$/i.exec(s)
  if (!m) return { kind: 'text', value: s.toLowerCase() }
  const key = m[1]!.toLowerCase()
  const value = (m[2] ?? m[3] ?? '').trim()
  if (!value) return null
  if (key === 'path') return { kind: 'path', value: value.replace(/^\/+|\/+$/g, '').toLowerCase() }
  if (key === 'tag') return { kind: 'tag', value: value.replace(/^#/, '').toLowerCase() }
  if (key === 'type') return { kind: 'type', value: value.toLowerCase() }
  return { kind: 'text', value: value.toLowerCase() }
}

export function matchesGroup(n: Pick<GNode, 'title' | 'type' | 'tags' | 'ghost'>, q: GroupQuery, path: string | undefined): boolean {
  switch (q.kind) {
    case 'path': {
      if (!path) return false
      const p = path.toLowerCase()
      return p === q.value || p.startsWith(`${q.value}/`) || p === `${q.value}.md`
    }
    case 'tag':
      return n.tags.some((t) => {
        const x = t.toLowerCase()
        return x === q.value || x.startsWith(`${q.value}/`)
      })
    case 'type':
      return n.type.toLowerCase() === q.value
    case 'text':
      return n.title.toLowerCase().includes(q.value)
  }
}

/** First matching group wins (Obsidian's order rule); otherwise the type colour; ghosts and tags have their own. */
export function colorFor(n: Pick<GNode, 'title' | 'type' | 'tags' | 'ghost' | 'tag'>, groups: { q: GroupQuery | null; color: string }[], path: string | undefined): string {
  if (n.ghost || n.tag) return n.tag ? TYPE_COLOR.tag! : ''
  for (const g of groups) if (g.q && matchesGroup(n, g.q, path)) return g.color
  return typeColor(n.type)
}
