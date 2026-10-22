import { describe, expect, it } from 'vitest'
import type { VaultGraph, VaultGraphEdge, VaultGraphNode } from '@shared/passport'
import {
  DEFAULT_GROUPS,
  buildModel,
  colorFor,
  createSimulation,
  fitTransform,
  hitTest,
  labelAlpha,
  matchesGroup,
  neighborhood,
  parseGroupQuery,
  positionsOf,
  stepUntilCool,
  toScreen,
  toWorld,
  zoomAt
} from './forceGraph'
import { lcg } from './memoryLayout'

function synth(n: number, perNode = 2, seed = 7): VaultGraph {
  const rand = lcg(seed)
  const nodes: VaultGraphNode[] = Array.from({ length: n }, (_, i) => [`n-${String(i).padStart(10, '0')}`, `Note ${i}`, i % 5 ? 'note' : 'person', 0, i % 17 === 0 ? 1 : 0, i % 3 ? [] : [0]])
  const edges: VaultGraphEdge[] = []
  for (let i = 1; i < n; i++) for (let k = 0; k < perNode; k++) edges.push([i, Math.floor(rand() * i), 0, 1])
  for (const [, t] of edges) nodes[t]![3]++
  return { companyId: 'co_a', nodes, edges, rels: ['links_to'], tags: ['team'], positions: [], centerId: null, total: n, truncated: false }
}

describe('forceGraph', () => {
  it('is deterministic for a given graph and seed', () => {
    const run = (): string => {
      const m = buildModel(synth(120))
      const sim = createSimulation(m, undefined, { seed: 42 })
      for (let i = 0; i < 80; i++) sim.tick()
      return JSON.stringify(m.nodes.map((n) => [n.id, n.x.toFixed(6), n.y.toFixed(6)]))
    }
    expect(run()).toBe(run())
  })

  it('a different seed gives a different (but valid) picture', () => {
    const a = buildModel(synth(60))
    const b = buildModel(synth(60))
    const sa = createSimulation(a, undefined, { seed: 1 })
    const sb = createSimulation(b, undefined, { seed: 2 })
    stepUntilCool(sa)
    stepUntilCool(sb)
    expect(a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
    expect(a.nodes.map((n) => n.x)).not.toEqual(b.nodes.map((n) => n.x))
  })

  it('keeps positions across opens: a saved layout starts cool and barely moves', () => {
    const g = synth(200)
    const first = buildModel(g)
    stepUntilCool(createSimulation(first, undefined, { seed: 3 }))
    const saved = positionsOf(first.nodes)
    expect(saved).toHaveLength(200)
    const again = buildModel({ ...g, positions: saved.map((p) => [p.noteId, p.x, p.y, 0]) })
    expect(again.savedShare).toBe(1)
    for (const n of again.nodes) expect([n.x, n.y]).toEqual([saved.find((p) => p.noteId === n.id)!.x, saved.find((p) => p.noteId === n.id)!.y])
    const sim = createSimulation(again, undefined, { seed: 3 })
    expect(sim.alpha()).toBeLessThan(0.2)
    stepUntilCool(sim)
    const drift = again.nodes.map((n) => {
      const p = saved.find((s) => s.noteId === n.id)!
      return Math.hypot(n.x - p.x, n.y - p.y)
    })
    const median = [...drift].sort((a, b) => a - b)[Math.floor(drift.length / 2)]!
    expect(median).toBeLessThan(25)
  })

  it('builds neighbours, degrees and ghost/tag flags', () => {
    const m = buildModel(synth(20))
    expect(m.nodes[0]!.ghost).toBe(true)
    expect(m.nodes[0]!.tags).toEqual(['team'])
    const hood = neighborhood(m, m.nodes[0]!.id)!
    expect(hood.has(m.nodes[0]!.id)).toBe(true)
    expect(hood.size).toBe(m.neighbors.get(m.nodes[0]!.id)!.size + 1)
    expect(neighborhood(m, 'missing')).toBeNull()
    expect(m.nodes[0]!.r).toBeGreaterThan(m.nodes[19]!.r)
  })

  it('ticks 2k nodes fast enough for ~60 fps', () => {
    const m = buildModel(synth(2000, 2))
    const sim = createSimulation(m, undefined, { seed: 9 })
    sim.tick() // warm up the JIT
    const t0 = performance.now()
    for (let i = 0; i < 30; i++) sim.tick()
    const perTick = (performance.now() - t0) / 30
    // the frame budget is 16.7 ms including drawing; leave headroom for slow CI machines
    expect(perTick).toBeLessThan(25)
  })
})

describe('transform and hit testing', () => {
  it('round-trips screen and world coordinates and zooms around the cursor', () => {
    const t = { k: 2, x: 100, y: 50 }
    const [sx, sy] = toScreen(t, 10, 20)
    expect(toWorld(t, sx, sy)).toEqual([10, 20])
    const z = zoomAt(t, sx, sy, 1.5)
    expect(toScreen(z, 10, 20)).toEqual([sx, sy])
  })

  it('fits nodes into the viewport and finds the topmost node', () => {
    const nodes = [
      { x: -100, y: 0, r: 5 },
      { x: 100, y: 0, r: 5 }
    ]
    const f = fitTransform(nodes, 400, 200)
    const [lx] = toScreen(f, -105, 0)
    const [rx] = toScreen(f, 105, 0)
    expect(lx).toBeGreaterThanOrEqual(39)
    expect(rx).toBeLessThanOrEqual(361)
    const m = buildModel(synth(3))
    m.nodes[1]!.x = 0
    m.nodes[1]!.y = 0
    m.nodes[2]!.x = 1
    m.nodes[2]!.y = 0
    expect(hitTest(m.nodes, 0.5, 0)?.id).toBe(m.nodes[2]!.id)
    expect(hitTest(m.nodes, 500, 500)).toBeNull()
  })

  it('fades labels in above the threshold', () => {
    expect(labelAlpha(0.25, 0)).toBe(0)
    expect(labelAlpha(1, 0)).toBe(1)
    expect(labelAlpha(Math.SQRT1_2, 0)).toBeCloseTo(0.5, 5)
  })
})

describe('groups', () => {
  it('parses Obsidian-style queries', () => {
    expect(parseGroupQuery('path:"People"')).toEqual({ kind: 'path', value: 'people' })
    expect(parseGroupQuery('tag:#Team/Founding')).toEqual({ kind: 'tag', value: 'team/founding' })
    expect(parseGroupQuery('type:person')).toEqual({ kind: 'type', value: 'person' })
    expect(parseGroupQuery('Pricing')).toEqual({ kind: 'text', value: 'pricing' })
    expect(parseGroupQuery('  ')).toBeNull()
  })

  it('first matching group wins, then the type colour; ghosts are uncoloured', () => {
    const groups = [{ q: parseGroupQuery('tag:#vip'), color: '#111111' }, ...DEFAULT_GROUPS.map((g) => ({ q: parseGroupQuery(g.query), color: g.color }))]
    const ana = { title: 'Ana', type: 'person', tags: ['vip/gold'], ghost: false, tag: false }
    expect(colorFor(ana, groups, 'People/Ana.md')).toBe('#111111')
    expect(colorFor({ ...ana, tags: [] }, groups, 'People/Ana.md')).toBe('#4f9dde')
    expect(colorFor({ ...ana, tags: [] }, groups, 'Elsewhere/Ana.md')).toBe('#4f9dde') // type colour
    expect(colorFor({ ...ana, ghost: true }, groups, undefined)).toBe('')
    expect(matchesGroup(ana, { kind: 'path', value: 'people' }, 'Peoplex/Ana.md')).toBe(false)
  })
})
