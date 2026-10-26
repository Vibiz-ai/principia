import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })
vi.mock('../../styles/diagrams.css', () => ({}))

const valid = JSON.stringify({
  title: 'Board flow',
  nodes: [
    { id: 'ui', kind: 'client', label: 'Board' },
    { id: 'api', kind: 'service', label: 'API' },
    { id: 'db', kind: 'database', label: 'hive.db' },
    { id: 'q', kind: 'robot', label: 'Queue' }
  ],
  edges: [{ from: 'ui', to: 'api' }]
})

describe('DiagramBlock', () => {
  it('shows a readable path error plus the JSON behind a toggle', async () => {
    const { DiagramBlock } = await import('./DiagramBlock')
    const html = renderToStaticMarkup(createElement(DiagramBlock, { source: valid }))
    expect(html).toContain('This diagram couldn’t be drawn: nodes[3].kind must be one of client, service')
    expect(html).toContain('Show JSON')
    expect(html).toContain('Copy JSON')
  })

  it('shows the too-large message without drawing', async () => {
    const { DiagramBlock } = await import('./DiagramBlock')
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, kind: 'service', label: `N${i}` }))
    const html = renderToStaticMarkup(createElement(DiagramBlock, { source: JSON.stringify({ nodes }) }))
    expect(html).toContain('This diagram is too large to draw: 200 nodes (the limit is 150).')
    expect(html).not.toContain('react-flow')
  })

  it('renders a placeholder with the title until scrolled near', async () => {
    const { DiagramBlock } = await import('./DiagramBlock')
    const ok = valid.replace('"robot"', '"queue"')
    const html = renderToStaticMarkup(createElement(DiagramBlock, { source: ok }))
    expect(html).toContain('Board flow')
    expect(html).toContain('4 nodes')
    expect(html).toContain('dgm--idle')
  })
})

describe('MarkdownLite', () => {
  it('renders bold and shows raw HTML as text', async () => {
    const { MarkdownLite } = await import('./MarkdownLite')
    const html = renderToStaticMarkup(createElement(MarkdownLite, { text: '<script>alert(1)</script> and **bold**' }))
    expect(html).toContain('<strong><span>bold</span></strong>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
})

describe('TextWithDiagrams', () => {
  it('passes plain text through and swaps blocks for diagrams', async () => {
    const { TextWithDiagrams } = await import('./TextWithDiagrams')
    const renderText = (t: string): ReturnType<typeof createElement> => createElement('p', null, t)
    expect(renderToStaticMarkup(createElement(TextWithDiagrams, { text: 'hello', renderText }))).toBe('<p>hello</p>')
    const html = renderToStaticMarkup(createElement(TextWithDiagrams, { text: `Before\n\`\`\`principia-graph\n${valid.replace('"robot"', '"queue"')}\n\`\`\`\nAfter`, renderText }))
    expect(html).toMatch(/^<p>Before<\/p>.*Board flow.*<p>After<\/p>$/s)
  })

  it('parses /visualize in the forum composer', async () => {
    const { parseSlash } = await import('../../lib/forum')
    expect(parseSlash('/visualize @marcus the launch plan')).toEqual({ cmd: 'visualize', handles: ['marcus'], what: 'the launch plan' })
  })
})

describe('QA fixes', () => {
  it('forgives a wrong task status instead of failing the block', async () => {
    const { DiagramBlock } = await import('./DiagramBlock')
    const src = JSON.stringify({ title: 'Launch', nodes: [{ id: 't', kind: 'task', label: 'Ship', status: 'review' }] })
    const html = renderToStaticMarkup(createElement(DiagramBlock, { source: src }))
    expect(html).not.toContain('couldn’t be drawn')
    expect(html).toContain('Launch')
  })

  it('remembers chat diagrams across a reload and caps what it stores', async () => {
    const mem = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) })
    vi.resetModules()
    const block = '```principia-graph\n{"title":"One","nodes":[{"id":"a","kind":"note","label":"A"}]}\n```'
    const first = await import('../../state/diagrams')
    expect(first.noteSessionAnswer('s1', block)).toBe(1)
    vi.resetModules()
    const again = await import('../../state/diagrams')
    expect(again.loadSessionDiagrams().s1?.map((d) => d.title)).toEqual(['One'])
    expect(again.noteSessionAnswer('s1', block)).toBe(0)
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, [{ raw: 'x', title: 't', at: i }]]))
    const kept = Object.keys(again.trimSessionDiagrams(big))
    expect(kept).toHaveLength(24)
    expect(kept[0]).toBe('c39')
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { hive: { on: () => () => {} }, addEventListener: () => {}, removeEventListener: () => {} })
  })

  it('offers Visualize only for live Claude chats', async () => {
    const { canVisualize } = await import('../../state/diagrams')
    expect(canVisualize({ adapter: 'claude', status: 'running' })).toBe(true)
    expect(canVisualize({ adapter: 'codex', status: 'running' })).toBe(false)
    expect(canVisualize({ adapter: 'shell', status: 'running' })).toBe(false)
    expect(canVisualize({ adapter: 'claude', status: 'exited' })).toBe(false)
    expect(canVisualize(undefined)).toBe(false)
  })
})
