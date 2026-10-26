import { describe, expect, it } from 'vitest'
import { DIAGRAM_LIMITS, hasDiagram, parseDiagram, splitDiagrams, visualizePrompt } from './diagram'

const sample = {
  title: 'Board flow',
  nodes: [
    { id: 'ui', kind: 'client', label: 'Board' },
    { id: 'api', kind: 'service', label: 'API', detail: '**main** process' },
    { id: 'db', kind: 'database', label: 'hive.db' },
    { id: 'q', kind: 'queue', label: 'Scheduler' }
  ],
  edges: [
    { from: 'ui', to: 'api', kind: 'call' },
    { from: 'api', to: 'db', kind: 'data' },
    { from: 'api', to: 'q', kind: 'async' }
  ]
}

describe('parseDiagram', () => {
  it('accepts a valid block and defaults edges', () => {
    const r = parseDiagram(JSON.stringify(sample))
    expect(r.ok).toBe(true)
    const r2 = parseDiagram(JSON.stringify({ nodes: [{ id: 'a', kind: 'note', label: 'A' }] }))
    expect(r2.ok && r2.diagram.edges).toEqual([])
  })

  it('names the path of a bad enum', () => {
    const bad = structuredClone(sample) as { nodes: { kind: string }[] }
    bad.nodes[3]!.kind = 'robot'
    const r = parseDiagram(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^nodes\[3\]\.kind must be one of client, service, database/)
  })

  it('says a missing field is required', () => {
    const bad = structuredClone(sample) as { nodes: Partial<{ label: string }>[] }
    delete bad.nodes[1]!.label
    const r = parseDiagram(JSON.stringify(bad))
    expect(!r.ok && r.error).toBe('nodes[1].label is required')
  })

  it('reports JSON errors and keeps the raw text', () => {
    const r = parseDiagram('{ nodes: [')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/JSON doesn't parse/)
    expect(r.raw).toBe('{ nodes: [')
  })

  it('flags too-large blocks before the schema', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, kind: 'service', label: `N${i}` }))
    const r = parseDiagram(JSON.stringify({ nodes, edges: [] }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.tooLarge).toBe(true)
    expect(!r.ok && r.error).toMatch(/too large.*200 nodes.*150/)
    const big = parseDiagram(' '.repeat(DIAGRAM_LIMITS.bytes + 1))
    expect(!big.ok && big.tooLarge).toBe(true)
  })

  it('checks references, duplicates and group nesting', () => {
    const e = (over: object): string => (r => (r.ok ? '' : r.error))(parseDiagram(JSON.stringify({ ...sample, ...over })))
    expect(e({ edges: [{ from: 'ui', to: 'nope' }] })).toBe('edges[0].to "nope" is not a node id')
    expect(e({ nodes: [...sample.nodes, { id: 'ui', kind: 'note', label: 'x' }] })).toBe('nodes[4].id "ui" is used twice')
    expect(e({ steps: [{ title: 'S', focus: ['ui', 'zz'], text: '' }] })).toBe('steps[0].focus[1] "zz" is not a node id')
    expect(
      e({
        nodes: [
          { id: 'g', kind: 'group', label: 'G' },
          { id: 'h', kind: 'group', label: 'H', group: 'g' }
        ],
        edges: []
      })
    ).toMatch(/groups nest one level/)
    expect(e({ nodes: [{ id: 'a', kind: 'note', label: 'A', group: 'b' }, { id: 'b', kind: 'note', label: 'B' }], edges: [] })).toMatch(/must point at a node of kind group/)
  })
})

describe('splitDiagrams', () => {
  it('finds principia-graph fences and leaves other code alone', () => {
    const text = ['Here is the flow:', '', '```principia-graph', '{"nodes":[]}', '```', '', '```ts', 'x()', '```', 'Done.'].join('\n')
    const s = splitDiagrams(text)
    expect(s.map((x) => x.t)).toEqual(['text', 'diagram', 'text'])
    expect(s[1]).toEqual({ t: 'diagram', raw: '{"nodes":[]}', closed: true })
    expect(s[2]!.t === 'text' && s[2]!.v).toContain('```ts')
    expect(hasDiagram(text)).toBe(true)
    expect(hasDiagram('mentions principia-graph in prose')).toBe(false)
  })

  it('treats an unclosed fence as running to the end', () => {
    const s = splitDiagrams('a\n~~~principia-graph\n{"x":1')
    expect(s[1]).toEqual({ t: 'diagram', raw: '{"x":1', closed: false })
  })

  it('builds the visualize prompt', () => {
    expect(visualizePrompt('the board flow.  ')).toBe('Draw the board flow as a principia-graph.')
  })
})
