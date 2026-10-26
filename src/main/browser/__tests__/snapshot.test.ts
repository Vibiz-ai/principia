import { describe, expect, it } from 'vitest'
import { formatSnapshot, RefMap, type AXNode } from '../snapshot'

let id = 0
/** A subtree: [node, ...descendants]. */
function n(role: string, name = '', extra: Partial<AXNode> = {}, children: AXNode[][] = []): AXNode[] {
  const me: AXNode = { nodeId: String(++id), role: { value: role }, name: { value: name }, backendDOMNodeId: 1000 + id, childIds: [], ...extra }
  const out: AXNode[] = [me]
  for (const sub of children) {
    sub[0]!.parentId = me.nodeId
    me.childIds!.push(sub[0]!.nodeId)
    out.push(...sub)
  }
  return out
}
const tree = (...kids: AXNode[][]): AXNode[] => {
  id = 0
  const root: AXNode = { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: [] }
  const all: AXNode[] = [root]
  for (const k of kids) {
    k[0]!.parentId = 'root'
    root.childIds!.push(k[0]!.nodeId)
    all.push(...k)
  }
  return all
}

describe('formatSnapshot', () => {
  it('lists interactive elements first with refs, role, name and value, then the content outline', () => {
    const nodes = tree(
      n('heading', 'Example Domain', { properties: [{ name: 'level', value: { value: 1 } }] }),
      n('paragraph', '', {}, [n('StaticText', 'This domain is for examples.')]),
      n('form', 'Sign up', {}, [n('textbox', 'Email', { value: { value: 'ana@' }, properties: [{ name: 'required', value: { value: true } }] }), n('button', 'Send', { properties: [{ name: 'disabled', value: { value: true } }] })]),
      n('link', 'More information')
    )
    const out = formatSnapshot({ title: 'Example Domain', url: 'https://example.com/', nodes, refs: new RefMap() })
    const lines = out.text.split('\n')
    expect(lines[0]).toBe('Page: Example Domain')
    expect(lines[1]).toBe('URL: https://example.com/')
    expect(lines[2]).toBe('Interactive (3):')
    expect(out.text).toMatch(/- textbox "Email" value="ana@" \[required\] \[ref=e\d+\] \(in form "Sign up"\)/)
    expect(out.text).toMatch(/- button "Send" \[disabled\] \[ref=e\d+\]/)
    expect(out.text).toMatch(/- link "More information" \[ref=e\d+\]/)
    const content = lines.slice(lines.indexOf('Content:'))
    expect(content.join('\n')).toMatch(/- heading "Example Domain" \[level=1\] \[ref=e\d+\]/)
    expect(content.join('\n')).toContain('paragraph: This domain is for examples.')
    expect(content.join('\n')).toContain('form "Sign up":')
    // interactive lines come before the content section
    expect(lines.findIndex((l) => l.includes('textbox'))).toBeLessThan(lines.indexOf('Content:'))
    expect(out.interactive).toBe(3)
  })

  it('keeps the same ref for the same element across snapshots, until the page navigates', () => {
    const refs = new RefMap()
    const nodes = tree(n('button', 'A'), n('button', 'B'))
    const one = formatSnapshot({ title: 't', url: 'u', nodes, refs }).text
    const two = formatSnapshot({ title: 't', url: 'u', nodes: [...nodes].reverse(), refs }).text
    const refOf = (t: string, name: string): string => new RegExp(`"${name}" \\[ref=(e\\d+)\\]`).exec(t)![1]!
    expect(refOf(one, 'A')).toBe(refOf(two, 'A'))
    expect(refOf(one, 'B')).toBe(refOf(two, 'B'))
    expect(refs.get(refOf(one, 'A'))?.name).toBe('A')
    expect(refs.get(`[ref=${refOf(one, 'B')}]`)?.name).toBe('B')
    refs.reset()
    expect(refs.get(refOf(one, 'A'))).toBeNull()
  })

  it('skips ignored and wrapper nodes, merges their children up', () => {
    const nodes = tree(n('generic', '', {}, [n('none', '', {}, [n('button', 'Deep')])]), n('button', 'Hidden', { ignored: true }))
    const out = formatSnapshot({ title: 't', url: 'u', nodes, refs: new RefMap() }).text
    expect(out.match(/- button "Deep" \[ref=e\d+\]$/gm)).toHaveLength(1)
    // an ignored node itself is not listed (its children would be)
    expect(out).not.toContain('Hidden')
  })

  it('notes iframes: content of a readable frame, a note for one in another process', () => {
    const nodes = tree(n('Iframe', 'Payment'), n('Iframe', 'Ads'))
    const pay = nodes.find((x) => x.name?.value === 'Payment')!
    const ads = nodes.find((x) => x.name?.value === 'Ads')!
    const inner = [{ nodeId: 'f1', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['f2'] }, { nodeId: 'f2', parentId: 'f1', role: { value: 'textbox' }, name: { value: 'Card' }, backendDOMNodeId: 7 }] as AXNode[]
    const frames = new Map([
      [pay.backendDOMNodeId!, { frameId: 'F1', url: 'https://pay.example/', nodes: inner }],
      [ads.backendDOMNodeId!, { frameId: '', url: 'https://ads.example/', error: 'another site, in its own process' }]
    ])
    const refs = new RefMap()
    const out = formatSnapshot({ title: 't', url: 'u', nodes, frames, refs }).text
    expect(out).toMatch(/- textbox "Card" \[ref=(e\d+)\] \(in iframe "https:\/\/pay.example\/"\)/)
    const ref = /"Card" \[ref=(e\d+)\]/.exec(out)![1]!
    expect(refs.get(ref)).toMatchObject({ frameId: 'F1', backendNodeId: 7 })
    expect(out).toContain('note: frame https://ads.example/ not readable (another site, in its own process)')
  })

  it('cuts long text in compact mode and keeps it in full mode', () => {
    const long = 'word '.repeat(100).trim()
    const nodes = tree(n('paragraph', '', {}, [n('StaticText', long)]))
    expect(formatSnapshot({ title: 't', url: 'u', nodes, refs: new RefMap() }).text).toContain('…')
    expect(formatSnapshot({ title: 't', url: 'u', nodes, refs: new RefMap(), full: true }).text).toContain(long)
  })

  it('says so when a page has nothing interactive', () => {
    const out = formatSnapshot({ title: '', url: 'about:blank', nodes: tree(), refs: new RefMap() }).text
    expect(out).toContain('Page: (untitled)')
    expect(out).toContain('Interactive (0):\n- (none)')
  })
})
