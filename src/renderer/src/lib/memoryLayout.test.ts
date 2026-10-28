import { describe, expect, it } from 'vitest'
import { hash32, layoutMemoryGraph, layoutMemoryGroups, lcg, seedPositions, type LayoutEdge, type LayoutFrame, type LayoutNode } from './memoryLayout'
import { expectFast } from '../../../test/perf'

function synth(n: number, edgeEvery = 1): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const rand = lcg(42)
  const nodes: LayoutNode[] = Array.from({ length: n }, (_, i) => ({
    id: `ment_${String(i).padStart(10, '0')}`,
    width: 100 + Math.floor(rand() * 80),
    height: 32,
    weight: Math.floor(rand() * 9),
    label: `entity ${i}`
  }))
  const edges: LayoutEdge[] = []
  for (let i = 1; i < n; i += edgeEvery) edges.push({ source: nodes[i]!.id, target: nodes[Math.floor(rand() * i)]!.id })
  return { nodes, edges }
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe('layoutMemoryGraph', () => {
  it('is deterministic: same data gives the same picture, whatever the input order', () => {
    const { nodes, edges } = synth(60)
    const a = layoutMemoryGraph(nodes, edges)
    const b = layoutMemoryGraph([...nodes].reverse(), [...edges].reverse().map((e, i) => (i % 2 ? { source: e.target, target: e.source } : e)))
    expect(b.positions).toEqual(a.positions)
    expect(b.band).toEqual(a.band)
  })

  it('places every node, with finite integer-ish coordinates', () => {
    const { nodes, edges } = synth(40)
    const { positions } = layoutMemoryGraph(nodes, edges)
    expect(Object.keys(positions).sort()).toEqual(nodes.map((n) => n.id).sort())
    for (const p of Object.values(positions)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
  })

  it('puts entities without relations in a grid band below the force layout, heaviest first', () => {
    const connected: LayoutNode[] = ['a', 'b', 'c'].map((id) => ({ id, width: 120, height: 32, weight: 1, label: id }))
    const orphans: LayoutNode[] = [
      { id: 'o1', width: 100, height: 32, weight: 1, label: 'zeta' },
      { id: 'o2', width: 100, height: 32, weight: 7, label: 'alpha' },
      { id: 'o3', width: 100, height: 32, weight: 1, label: 'beta' }
    ]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' }
    ]
    const { positions, band } = layoutMemoryGraph([...connected, ...orphans], edges)
    expect(band?.count).toBe(3)
    const lowestConnected = Math.max(...connected.map((n) => positions[n.id]!.y + n.height))
    for (const o of orphans) expect(positions[o.id]!.y).toBeGreaterThan(lowestConnected)
    // same row, ordered by weight desc then label asc: o2 (7), o3 (beta), o1 (zeta)
    expect(positions.o2!.x).toBeLessThan(positions.o3!.x)
    expect(positions.o3!.x).toBeLessThan(positions.o1!.x)
    expect(positions.o2!.y).toBe(positions.o1!.y)
  })

  it('ignores self-loops, duplicate and dangling edges', () => {
    const nodes: LayoutNode[] = ['a', 'b'].map((id) => ({ id, width: 100, height: 32, weight: 0, label: id }))
    const r = layoutMemoryGraph(nodes, [
      { source: 'a', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'a', target: 'ghost' }
    ])
    expect(r.band).toBeNull()
    expect(Object.keys(r.positions)).toHaveLength(2)
  })

  it('handles empty and single-node graphs', () => {
    expect(layoutMemoryGraph([], [])).toEqual({ positions: {}, band: null })
    const one = layoutMemoryGraph([{ id: 'x', width: 100, height: 30, weight: 2, label: 'x' }], [])
    expect(one.band?.count).toBe(1)
    expect(one.positions.x).toBeDefined()
  })

  it('keeps connected nodes from overlapping', () => {
    const { nodes, edges } = synth(30)
    const { positions } = layoutMemoryGraph(nodes, edges)
    const boxes = nodes.map((n) => ({ ...positions[n.id]!, w: n.width, h: n.height }))
    let overlaps = 0
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i]!, boxes[j]!)) overlaps++
    expect(overlaps).toBe(0)
  })

  it('lays out the 150-node cap in under 100 ms', () => {
    const { nodes, edges } = synth(150)
    layoutMemoryGraph(nodes, edges) // warm the JIT
    const t = performance.now()
    layoutMemoryGraph(nodes, edges)
    expectFast(performance.now() - t, 100, 'laying out 150 nodes')
  })
})

describe('seeded helpers', () => {
  it('hash32 and lcg are stable', () => {
    expect(hash32('ment_abc')).toBe(hash32('ment_abc'))
    expect(hash32('a')).not.toBe(hash32('b'))
    const a = lcg(1)
    const b = lcg(1)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('layoutMemoryGroups', () => {
  const n = (id: string): LayoutNode => ({ id, width: 110, height: 34, weight: 1, label: id })
  it('is exactly layoutMemoryGraph with one group (no frames)', () => {
    const nodes = ['a', 'b', 'c'].map(n)
    const edges = [{ source: 'a', target: 'b' }]
    const g = layoutMemoryGroups([{ key: 'r', label: 'repo', nodes }], edges)
    const single = layoutMemoryGraph(nodes, edges)
    expect(g.positions).toEqual(single.positions)
    expect(g.frames).toEqual([])
    expect(g.bands).toEqual(single.band ? [single.band] : [])
  })
  it('frames each group, keeps every node inside its own frame, and frames never overlap', () => {
    const repo = ['a', 'b', 'c', 'd'].map(n)
    const glob = ['g1', 'g2', 'g3'].map(n)
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'g1', target: 'g2' },
      { source: 'a', target: 'g1' } // across groups: drawn, not laid out
    ]
    const r = layoutMemoryGroups(
      [
        { key: 'repo', label: 'hive', nodes: repo },
        { key: 'global', label: 'Global', nodes: glob }
      ],
      edges
    )
    expect(r.frames.map((f) => f.key)).toEqual(['repo', 'global'])
    const inside = (id: string, f: LayoutFrame): boolean => {
      const p = r.positions[id]!
      return p.x >= f.x && p.y >= f.y && p.x + 110 <= f.x + f.width && p.y + 34 <= f.y + f.height
    }
    for (const id of ['a', 'b', 'c', 'd']) expect(inside(id, r.frames[0]!)).toBe(true)
    for (const id of ['g1', 'g2', 'g3']) expect(inside(id, r.frames[1]!)).toBe(true)
    const [f0, f1] = r.frames as [LayoutFrame, LayoutFrame]
    expect(overlap({ x: f0.x, y: f0.y, w: f0.width, h: f0.height }, { x: f1.x, y: f1.y, w: f1.width, h: f1.height })).toBe(false)
    // orphans (d, g3) get one band per group
    expect(r.bands).toHaveLength(2)
  })
  it('is deterministic', () => {
    const groups = [
      { key: 'x', label: 'x', nodes: ['a', 'b'].map(n) },
      { key: 'y', label: 'y', nodes: ['c', 'd'].map(n) }
    ]
    const e = [{ source: 'a', target: 'b' }]
    expect(layoutMemoryGroups(groups, e)).toEqual(layoutMemoryGroups(groups, e))
  })
})

describe('seedPositions (Passport graph first paint)', () => {
  it('keeps saved positions exactly', () => {
    const saved = new Map([
      ['a', { x: 10, y: -20 }],
      ['b', { x: 300, y: 40 }]
    ])
    const out = seedPositions(['a', 'b'], [{ source: 'a', target: 'b' }], saved)
    expect(out.get('a')).toEqual({ x: 10, y: -20 })
    expect(out.get('b')).toEqual({ x: 300, y: 40 })
  })

  it('puts a new node next to its placed neighbours, then their neighbours', () => {
    const saved = new Map([
      ['a', { x: 1000, y: 1000 }],
      ['b', { x: 1100, y: 1000 }]
    ])
    const edges = [
      { source: 'new', target: 'a' },
      { source: 'new', target: 'b' },
      { source: 'leaf', target: 'new' }
    ]
    const out = seedPositions(['a', 'b', 'new', 'leaf'], edges, saved)
    const n = out.get('new')!
    expect(Math.hypot(n.x - 1050, n.y - 1000)).toBeLessThan(45)
    const l = out.get('leaf')!
    expect(Math.hypot(l.x - n.x, l.y - n.y)).toBeLessThan(45)
  })

  it('spirals unconnected nodes outside the placed picture, deterministically and order-independently', () => {
    const saved = new Map([['a', { x: 0, y: 0 }]])
    const ids = ['a', 'x', 'y', 'z']
    const one = seedPositions(ids, [], saved)
    const two = seedPositions([...ids].reverse(), [], saved)
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort())
    for (const id of ['x', 'y', 'z']) expect(Math.hypot(one.get(id)!.x, one.get(id)!.y)).toBeGreaterThanOrEqual(40)
    expect(new Set(['x', 'y', 'z'].map((id) => `${one.get(id)!.x},${one.get(id)!.y}`)).size).toBe(3)
  })

  it('seeds everything on a spiral when nothing is saved, and ignores edges to unknown ids', () => {
    const out = seedPositions(['p', 'q'], [{ source: 'p', target: 'ghost:gone' }], new Map())
    expect(out.size).toBe(2)
    for (const p of out.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })
})

describe('seedPositions with a hub note', () => {
  it('seeds a 3k-link hub quickly and deterministically', () => {
    const ids = Array.from({ length: 3000 }, (_, i) => `n-${i}`)
    const edges = ids.slice(1).map((id) => ({ source: 'n-0', target: id }))
    const saved = new Map([['n-0', { x: 0, y: 0 }]])
    const t0 = performance.now()
    const a = seedPositions(ids, edges, saved)
    expectFast(performance.now() - t0, 500, 'seeding a 3k-link hub')
    expect(a.size).toBe(3000)
    expect(a.get('n-0')).toEqual({ x: 0, y: 0 })
    expect(JSON.stringify([...seedPositions(ids, edges, saved)])).toBe(JSON.stringify([...a]))
  })
})
