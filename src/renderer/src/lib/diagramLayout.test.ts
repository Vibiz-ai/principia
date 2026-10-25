import { describe, expect, it } from 'vitest'
import { parseDiagram, type Diagram } from '@shared/diagram'
import { layoutDiagram, neighbourhood, stepFocus } from './diagramLayout'

const parse = (o: object): Diagram => {
  const r = parseDiagram(JSON.stringify(o))
  if (!r.ok) throw new Error(r.error)
  return r.diagram
}

const flow = parse({
  nodes: [
    { id: 'ui', kind: 'client', label: 'Board' },
    { id: 'api', kind: 'service', label: 'API' },
    { id: 'db', kind: 'database', label: 'DB' },
    { id: 'x', kind: 'note', label: 'Loose' }
  ],
  edges: [
    { from: 'ui', to: 'api' },
    { from: 'api', to: 'db' }
  ]
})

describe('layoutDiagram', () => {
  it('ranks left to right by default and top to bottom when asked', () => {
    const l = layoutDiagram(flow)
    const x = (id: string) => l.nodes.find((n) => n.node.id === id)!
    expect(x('ui').x).toBeLessThan(x('api').x)
    expect(x('api').x).toBeLessThan(x('db').x)
    expect(l.width).toBeGreaterThan(0)
    expect(Math.min(...l.nodes.map((n) => n.x))).toBe(0)
    const down = layoutDiagram({ ...flow, direction: 'down' })
    const y = (id: string) => down.nodes.find((n) => n.node.id === id)!.y
    expect(y('ui')).toBeLessThan(y('api'))
  })

  it('draws groups as frames around their members, frames first', () => {
    const d = parse({
      nodes: [
        { id: 'g', kind: 'group', label: 'Main process' },
        { id: 'a', kind: 'service', label: 'A', group: 'g' },
        { id: 'b', kind: 'database', label: 'B', group: 'g' },
        { id: 'c', kind: 'client', label: 'C' },
        { id: 'empty', kind: 'group', label: 'No members' }
      ],
      edges: [
        { from: 'c', to: 'g' },
        { from: 'a', to: 'b' }
      ]
    })
    const l = layoutDiagram(d)
    expect(l.nodes[0]!.node.id).toBe('g')
    const g = l.nodes.find((n) => n.node.id === 'g')!
    expect(g.frame).toBe(true)
    expect(l.nodes.find((n) => n.node.id === 'empty')!.frame).toBe(false)
    for (const id of ['a', 'b']) {
      const n = l.nodes.find((m) => m.node.id === id)!
      expect(n.x).toBeGreaterThanOrEqual(g.x)
      expect(n.y).toBeGreaterThan(g.y)
      expect(n.x + n.w).toBeLessThanOrEqual(g.x + g.w)
      expect(n.y + n.h).toBeLessThanOrEqual(g.y + g.h)
    }
  })

  it('lays out the largest allowed diagram quickly', () => {
    const nodes = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, kind: 'service', label: `N${i}` }))
    const edges = Array.from({ length: 300 }, (_, i) => ({ from: `n${i % 150}`, to: `n${(i * 7 + 1) % 150}` }))
    const t = performance.now()
    const l = layoutDiagram(parse({ nodes, edges }))
    expect(l.nodes).toHaveLength(150)
    expect(performance.now() - t).toBeLessThan(3000)
  })
})

describe('neighbourhood and stepFocus', () => {
  it('lights a node, its neighbours and their edges', () => {
    const n = neighbourhood(flow, ['api'])
    expect([...n.nodes].sort()).toEqual(['api', 'db', 'ui'])
    expect([...n.edges]).toEqual([0, 1])
    const s = stepFocus(flow, ['ui', 'api'])
    expect([...s.edges]).toEqual([0])
  })

  it('hovering a group lights its members and their neighbours', () => {
    const d = parse({
      nodes: [
        { id: 'g', kind: 'group', label: 'G' },
        { id: 'a', kind: 'service', label: 'A', group: 'g' },
        { id: 'c', kind: 'client', label: 'C' },
        { id: 'x', kind: 'note', label: 'X' }
      ],
      edges: [{ from: 'c', to: 'a' }]
    })
    expect([...neighbourhood(d, ['g']).nodes].sort()).toEqual(['a', 'c', 'g'])
  })
})

describe('layout fixes from QA', () => {
  it('keeps room between ranks for an edge label', async () => {
    const { labelSize } = await import('./diagramLayout')
    const d = parse({
      nodes: [
        { id: 'web', kind: 'client', label: 'Web' },
        { id: 'api', kind: 'service', label: 'API' }
      ],
      edges: [{ from: 'web', to: 'api', label: 'POST /checkout' }]
    })
    const l = layoutDiagram(d)
    const web = l.nodes.find((n) => n.node.id === 'web')!
    const api = l.nodes.find((n) => n.node.id === 'api')!
    const gap = api.x - (web.x + web.w)
    expect(gap).toBeGreaterThanOrEqual(labelSize('POST /checkout').width)
  })

  it('gives back edges a lane outside the cards; forward edges get none', async () => {
    const { backEdgeLanes, LANE_GAP } = await import('./diagramLayout')
    const d = parse({
      nodes: [
        { id: 'a', kind: 'service', label: 'A' },
        { id: 'b', kind: 'function', label: 'B' },
        { id: 'c', kind: 'queue', label: 'C' }
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' }
      ]
    })
    for (const direction of ['right', 'down'] as const) {
      const dd = { ...d, direction }
      const l = layoutDiagram(dd)
      const lanes = backEdgeLanes(dd, l)
      expect(lanes.size).toBe(1)
      const lane = [...lanes.values()][0]!
      const far = Math.max(...l.nodes.map((n) => (direction === 'down' ? n.x + n.w : n.y + n.h)))
      expect(lane).toBeGreaterThanOrEqual(far + LANE_GAP)
    }
    expect(backEdgeLanes(flow, layoutDiagram(flow)).size).toBe(0)
  })
})

describe('stepLit', () => {
  it('an empty focus dims nothing; a focus lights only its nodes', async () => {
    const { stepLit } = await import('./diagramLayout')
    expect(stepLit(flow, [])).toBeNull()
    expect([...stepLit(flow, ['ui', 'api'])!.nodes].sort()).toEqual(['api', 'ui'])
  })
})
