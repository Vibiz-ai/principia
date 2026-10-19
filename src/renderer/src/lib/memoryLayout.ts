/**
 * Seeded, deterministic force layout for the Memory graph (MEMORY.md §10.3, PO8).
 *
 * Same data in, same picture out: positions are never saved, so the layout must not depend on input order,
 * Math.random or wall time. A small velocity-Verlet simulation in the shape of d3-force (link, many-body,
 * collide, x/y centering; 300 synchronous ticks, alpha decaying to 0.001), run off-screen with a seeded LCG.
 * Entities with no relations are not simulated: they sit in a compact grid band under the force layout,
 * sorted by fact count, so they read as a list instead of drifting as noise.
 *
 * Pure: no DOM, no React. At the 150-node cap the O(n²) many-body pass is ~3.4M pair visits, well under 100 ms.
 */

export interface LayoutNode {
  id: string
  /** Rendered box size (px). Collision uses the half-diagonal so pills never overlap. */
  width: number
  height: number
  /** Orphan band sort key (desc): active facts. */
  weight: number
  /** Orphan band tie-break (asc). */
  label: string
}
export interface LayoutEdge {
  source: string
  target: string
}
export interface LayoutResult {
  /** Top-left positions, ready for xyflow `position`. */
  positions: Record<string, { x: number; y: number }>
  /** Orphan band frame (for the band label); null when there are no orphans. */
  band: { x: number; y: number; width: number; height: number; count: number } | null
}

export const LAYOUT = {
  linkDistance: 120,
  charge: -300,
  collidePad: 14,
  center: 0.05,
  ticks: 300,
  velocityDecay: 0.6,
  bandGapY: 72,
  bandCellPadX: 16,
  bandCellPadY: 14
} as const

/** FNV-1a 32-bit. Stable across runs/platforms. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Numerical Recipes LCG, the same generator d3-force uses for its own `randomSource`. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

export function layoutMemoryGraph(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutResult {
  // order-independent: everything below iterates in id order
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const byId = new Map(sorted.map((n) => [n.id, n]))
  const links = dedupeEdges(edges).filter((e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target))
  const degree = new Map<string, number>()
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
  }
  const connected = sorted.filter((n) => (degree.get(n.id) ?? 0) > 0)
  const orphans = sorted.filter((n) => !degree.get(n.id))

  const positions: Record<string, { x: number; y: number }> = {}
  const sim = simulate(connected, links, degree)
  for (const s of sim) {
    const n = byId.get(s.id)!
    positions[s.id] = { x: s.x - n.width / 2, y: s.y - n.height / 2 }
  }

  let band: LayoutResult['band'] = null
  if (orphans.length) {
    const bounds = boundsOf(connected.map((n) => ({ ...positions[n.id]!, width: n.width, height: n.height })))
    const order = [...orphans].sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1))
    const cellW = Math.max(...order.map((n) => n.width)) + LAYOUT.bandCellPadX
    const cellH = Math.max(...order.map((n) => n.height)) + LAYOUT.bandCellPadY
    // as wide as the force layout (at least 4 columns), so the band reads as a footer of the same picture
    // (all orphans: a roughly 2:1 block instead)
    const fit = bounds ? Math.floor((bounds.width + LAYOUT.bandCellPadX) / cellW) : Math.ceil(Math.sqrt(order.length * 2))
    const cols = Math.max(1, Math.min(order.length, Math.max(4, Math.min(8, fit))))
    const rows = Math.ceil(order.length / cols)
    const width = cols * cellW - LAYOUT.bandCellPadX
    const x0 = bounds ? bounds.x + bounds.width / 2 - width / 2 : -width / 2
    const y0 = bounds ? bounds.y + bounds.height + LAYOUT.bandGapY : 0
    order.forEach((n, i) => {
      const c = i % cols
      const r = Math.floor(i / cols)
      positions[n.id] = { x: x0 + c * cellW + (cellW - LAYOUT.bandCellPadX - n.width) / 2, y: y0 + r * cellH }
    })
    band = { x: x0, y: y0, width, height: rows * cellH - LAYOUT.bandCellPadY, count: order.length }
  }
  return { positions, band }
}

function dedupeEdges(edges: LayoutEdge[]): LayoutEdge[] {
  const seen = new Set<string>()
  const out: LayoutEdge[] = []
  for (const e of edges) {
    const [a, b] = e.source < e.target ? [e.source, e.target] : [e.target, e.source]
    const k = `${a}\u0000${b}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ source: a, target: b })
  }
  return out.sort((x, y) => (x.source + '\u0000' + x.target < y.source + '\u0000' + y.target ? -1 : 1))
}

function simulate(nodes: LayoutNode[], links: LayoutEdge[], degree: Map<string, number>): SimNode[] {
  const n = nodes.length
  if (n === 0) return []
  const seed = nodes.reduce((h, x) => (Math.imul(h, 31) + hash32(x.id)) >>> 0, 7)
  const rand = lcg(seed)
  // phyllotaxis start (d3's default) rotated per node by its id hash: deterministic and well spread
  const sim: SimNode[] = nodes.map((nd, i) => {
    const radius = 10 * Math.sqrt(0.5 + i)
    const angle = i * Math.PI * (3 - Math.sqrt(5)) + (hash32(nd.id) % 360) * (Math.PI / 180) * 0.1
    return { id: nd.id, x: radius * Math.cos(angle), y: radius * Math.sin(angle), vx: 0, vy: 0, r: Math.hypot(nd.width, nd.height) / 2 + LAYOUT.collidePad / 2 }
  })
  if (n === 1) {
    sim[0]!.x = 0
    sim[0]!.y = 0
    return sim
  }
  const idx = new Map(sim.map((s, i) => [s.id, i]))
  const L = links.map((l) => {
    const s = idx.get(l.source)!
    const t = idx.get(l.target)!
    const ds = degree.get(l.source) ?? 1
    const dt = degree.get(l.target) ?? 1
    return { s, t, strength: 1 / Math.min(ds, dt), bias: ds / (ds + dt) }
  })
  const jiggle = (): number => (rand() - 0.5) * 1e-6

  let alpha = 1
  const alphaMin = 0.001
  const alphaDecay = 1 - Math.pow(alphaMin, 1 / LAYOUT.ticks)
  for (let tick = 0; tick < LAYOUT.ticks; tick++) {
    alpha += (0 - alpha) * alphaDecay
    // links (spring toward linkDistance)
    for (const l of L) {
      const a = sim[l.s]!
      const b = sim[l.t]!
      let dx = b.x + b.vx - a.x - a.vx || jiggle()
      let dy = b.y + b.vy - a.y - a.vy || jiggle()
      let d = Math.sqrt(dx * dx + dy * dy)
      d = ((d - LAYOUT.linkDistance) / d) * alpha * l.strength
      dx *= d
      dy *= d
      b.vx -= dx * l.bias
      b.vy -= dy * l.bias
      a.vx += dx * (1 - l.bias)
      a.vy += dy * (1 - l.bias)
    }
    // many-body repulsion, exact O(n²) (n <= 150)
    for (let i = 0; i < n; i++) {
      const a = sim[i]!
      for (let j = i + 1; j < n; j++) {
        const b = sim[j]!
        let dx = b.x - a.x
        let dy = b.y - a.y
        if (dx === 0) dx = jiggle()
        if (dy === 0) dy = jiggle()
        let l2 = dx * dx + dy * dy
        if (l2 < 1) l2 = Math.sqrt(l2)
        const w = (LAYOUT.charge * alpha) / l2
        a.vx += dx * w
        a.vy += dy * w
        b.vx -= dx * w
        b.vy -= dy * w
      }
    }
    // gentle centering
    for (const s of sim) {
      s.vx += (0 - s.x) * LAYOUT.center * alpha
      s.vy += (0 - s.y) * LAYOUT.center * alpha
    }
    // collide (one iteration, strength 0.7 like d3's default)
    for (let i = 0; i < n; i++) {
      const a = sim[i]!
      for (let j = i + 1; j < n; j++) {
        const b = sim[j]!
        let dx = a.x + a.vx - b.x - b.vx
        let dy = a.y + a.vy - b.y - b.vy
        const rr = a.r + b.r
        let l2 = dx * dx + dy * dy
        if (l2 >= rr * rr) continue
        if (dx === 0) dx = jiggle()
        if (dy === 0) dy = jiggle()
        l2 = dx * dx + dy * dy
        const l = Math.sqrt(l2)
        const k = ((rr - l) / l) * 0.7 * 0.5
        a.vx += dx * k
        a.vy += dy * k
        b.vx -= dx * k
        b.vy -= dy * k
      }
    }
    for (const s of sim) {
      s.vx *= LAYOUT.velocityDecay
      s.vy *= LAYOUT.velocityDecay
      s.x += s.vx
      s.y += s.vy
    }
  }
  // round to whole pixels: crisp text, and the determinism test compares exact numbers
  for (const s of sim) {
    s.x = Math.round(s.x)
    s.y = Math.round(s.y)
  }
  return sim
}

function boundsOf(rects: { x: number; y: number; width: number; height: number }[]): { x: number; y: number; width: number; height: number } | null {
  if (!rects.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// ---------- groups (one frame per repository, plus a Global lane) ----------
export interface LayoutGroup {
  key: string
  label: string
  nodes: LayoutNode[]
}
export interface LayoutFrame {
  key: string
  label: string
  count: number
  x: number
  y: number
  width: number
  height: number
}
export interface GroupedLayoutResult {
  positions: Record<string, { x: number; y: number }>
  bands: NonNullable<LayoutResult['band']>[]
  /** Empty with a single group: then the picture is exactly layoutMemoryGraph's. */
  frames: LayoutFrame[]
}

export const FRAME = { padX: 28, padTop: 44, padBottom: 24, gap: 72 } as const

/**
 * Lays out each group on its own (relations inside the group drive it; relations across groups are drawn but
 * don't pull), frames it, and packs the frames in rows, in the given group order. Deterministic like the rest.
 */
export function layoutMemoryGroups(groups: LayoutGroup[], edges: LayoutEdge[]): GroupedLayoutResult {
  const live = groups.filter((g) => g.nodes.length > 0)
  if (live.length <= 1) {
    const r = layoutMemoryGraph(live[0]?.nodes ?? [], edges)
    return { positions: r.positions, bands: r.band ? [r.band] : [], frames: [] }
  }
  const boxes = live.map((g) => {
    const ids = new Set(g.nodes.map((n) => n.id))
    const r = layoutMemoryGraph(
      g.nodes,
      edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    )
    const rects = g.nodes.map((n) => ({ ...r.positions[n.id]!, width: n.width, height: n.height }))
    if (r.band) rects.push({ x: r.band.x - 16, y: r.band.y - 30, width: r.band.width + 32, height: r.band.height + 46 })
    const b = boundsOf(rects)!
    return { g, r, b, w: b.width + FRAME.padX * 2, h: b.height + FRAME.padTop + FRAME.padBottom }
  })
  const area = boxes.reduce((s, x) => s + x.w * x.h, 0)
  const rowMax = Math.max(...boxes.map((x) => x.w), Math.sqrt(area) * 1.6)
  const positions: GroupedLayoutResult['positions'] = {}
  const bands: GroupedLayoutResult['bands'] = []
  const frames: LayoutFrame[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const bx of boxes) {
    if (x > 0 && x + bx.w > rowMax) {
      x = 0
      y += rowH + FRAME.gap
      rowH = 0
    }
    // translate the group so its content box starts inside the frame padding
    const dx = x + FRAME.padX - bx.b.x
    const dy = y + FRAME.padTop - bx.b.y
    for (const n of bx.g.nodes) {
      const p = bx.r.positions[n.id]!
      positions[n.id] = { x: p.x + dx, y: p.y + dy }
    }
    if (bx.r.band) bands.push({ ...bx.r.band, x: bx.r.band.x + dx, y: bx.r.band.y + dy })
    frames.push({ key: bx.g.key, label: bx.g.label, count: bx.g.nodes.length, x, y, width: bx.w, height: bx.h })
    x += bx.w + FRAME.gap
    rowH = Math.max(rowH, bx.h)
  }
  return { positions, bands, frames }
}
