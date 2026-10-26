import { describe, expect, it } from 'vitest'
import { inlineText, parseInline, renderMarkdown, type Block, type Inline, type LinkResolver } from './markdown'

const notes: Record<string, { noteId: string; title: string }> = {
  acme: { noteId: 'n-acme000000', title: 'Acme' },
  'ana ruiz': { noteId: 'n-ana0000000', title: 'Ana Ruiz' },
  'people/ana ruiz': { noteId: 'n-ana0000000', title: 'Ana Ruiz' }
}
const resolve: LinkResolver = (t) => notes[t.toLowerCase()] ?? null
const links = (c: Inline[]): Extract<Inline, { t: 'wikilink' }>[] => c.filter((n): n is Extract<Inline, { t: 'wikilink' }> => n.t === 'wikilink')

const NOTE = [
  '---',
  'id: n-ana0000000',
  'title: Ana Ruiz',
  'company: "[[Acme]]"',
  '---',
  '# Ana Ruiz',
  'Head of growth at [[Acme]]. Owns pricing with [[Lautaro]]. ^p-intro',
  '',
  '## Observations',
  '- [role] Head of growth #growth (user, 2026-10-01) ^f-7k2a9q1c0b',
  '- [decision] Price [[Pro Plan]] at $49/mo #pricing (claude run#183, 2026-10-12) ^f-9q1c3m8d2e',
  '',
  '## Relations',
  '- works_at [[Acme]] ^r-3m8d0a1b2c',
  '',
  '```ts',
  'const x = "[[Not A Link]]" // #nottag',
  '```',
  '',
  '## History',
  '- [superseded] Price [[Pro Plan]] at $39/mo (by ^f-9q1c3m8d2e; claude run#183, 2026-10-12) ^f-0p1o2i3u4y',
  '- [invalidated] works_at [[Globex]] (reason: left company; user, 2026-10-02) ^r-5t6y7u8i9o'
].join('\n')

describe('renderMarkdown', () => {
  const blocks = renderMarkdown(NOTE, { resolve })
  const byType = <T extends Block['t']>(t: T): Extract<Block, { t: T }>[] => blocks.filter((b): b is Extract<Block, { t: T }> => b.t === t)

  it('skips frontmatter and renders the H1', () => {
    expect(blocks[0]).toMatchObject({ t: 'heading', level: 1, text: 'Ana Ruiz' })
    expect(JSON.stringify(blocks)).not.toContain('n-ana0000000"') // id only appears as a resolved note id
    expect(blocks.some((b) => b.t === 'para' && inlineText(b.c).includes('id:'))).toBe(false)
  })

  it('marks resolved links and ghosts', () => {
    const para = byType('para')[0]!
    const [acme, lautaro] = links(para.c)
    expect(acme).toMatchObject({ target: 'Acme', resolved: { noteId: 'n-acme000000' } })
    expect(lautaro).toMatchObject({ target: 'Lautaro', resolved: null })
  })

  it('hides block ids but keeps them for Copy block link', () => {
    const para = byType('para')[0]!
    expect(inlineText(para.c)).not.toContain('^p-intro')
    expect(para.blockId).toBe('p-intro')
    const obs = byType('list')[0]!.items
    expect(obs.map((i) => i.blockId)).toEqual(['f-7k2a9q1c0b', 'f-9q1c3m8d2e'])
    for (const i of obs) expect(inlineText(i.c)).not.toMatch(/\^f-/)
  })

  it('splits observations into a category pill, text and provenance', () => {
    const [role, decision] = byType('list')[0]!.items
    expect(role!.obs).toMatchObject({ category: 'role', prov: { actor: 'user', date: '2026-10-01' } })
    expect(inlineText(role!.c)).toBe('Head of growth #growth')
    expect(decision!.obs?.prov).toMatchObject({ actor: 'claude', runId: '183' })
    expect(inlineText(decision!.c)).toBe('Price Pro Plan at $49/mo #pricing')
    expect(links(decision!.c)[0]).toMatchObject({ target: 'Pro Plan', resolved: null })
  })

  it('renders relations with their type', () => {
    const rel = byType('list')[1]!.items[0]!
    expect(rel.rel?.rel).toBe('works_at')
    expect(links(rel.c)[0]?.resolved?.title).toBe('Acme')
  })

  it('never reads links or tags inside code fences', () => {
    const code = byType('code')[0]!
    expect(code).toMatchObject({ lang: 'ts', text: 'const x = "[[Not A Link]]" // #nottag' })
    expect(JSON.stringify(blocks.filter((b) => b.t !== 'code'))).not.toContain('Not A Link')
  })

  it('collects History into one collapsed block', () => {
    const h = byType('history')
    expect(h).toHaveLength(1)
    expect(h[0]!.items.map((i) => i.history?.state)).toEqual(['superseded', 'invalidated'])
    expect(h[0]!.items[0]!.history?.by).toBe('f-9q1c3m8d2e')
    expect(h[0]!.items[1]!.history?.reason).toBe('left company')
    expect(blocks.some((b) => b.t === 'heading' && b.text === 'History')).toBe(false)
  })

  it('handles CRLF and a missing frontmatter', () => {
    const b = renderMarkdown('# T\r\n\r\nhello [[Acme]]\r\n', { resolve })
    expect(b.map((x) => x.t)).toEqual(['heading', 'para'])
  })

  it('renders tables, quotes, rules, tasks and ordered lists', () => {
    const b = renderMarkdown(['| a | b |', '|---|:-:|', '| [[Acme\\|A]] | 2 |', '', '> quoted *x*', '', '---', '- [ ] todo', '- [x] done', '1. one'].join('\n'), { resolve })
    const table = b[0] as Extract<Block, { t: 'table' }>
    expect(table.align).toEqual([null, 'center'])
    expect(links(table.rows[0]![0]!)[0]).toMatchObject({ target: 'Acme', label: 'A' })
    expect(b[1]!.t).toBe('quote')
    expect(b[2]!.t).toBe('hr')
    const list = b[3] as Extract<Block, { t: 'list' }>
    expect(list.items.map((i) => i.task)).toEqual([false, true, null])
    expect(list.items[2]!.ordered).toBe(true)
    expect(list.items[0]!.obs).toBeNull()
  })
})

describe('parseInline', () => {
  it('reads emphasis, code, urls, tags and md links to notes', () => {
    const c = parseInline('**bold** _em_ `[[x]]` snake_case_word https://x.dev/a. #tag/sub [Ana](People/Ana%20Ruiz.md)', { resolve })
    expect(c.map((n) => n.t)).toEqual(['strong', 'text', 'em', 'text', 'code', 'text', 'url', 'text', 'tag', 'text', 'wikilink'])
    expect((c[4] as { v: string }).v).toBe('[[x]]')
    expect((c[6] as { href: string }).href).toBe('https://x.dev/a')
    expect((c[8] as { tag: string }).tag).toBe('tag/sub')
    expect(c[10]).toMatchObject({ target: 'People/Ana Ruiz', label: 'Ana', resolved: { title: 'Ana Ruiz' } })
  })

  it('keeps heading and block link parts and embeds', () => {
    const [h, , e] = parseInline('[[Acme#^f-0000000000]] ![[Ana Ruiz]]', { resolve })
    expect(h).toMatchObject({ t: 'wikilink', block: 'f-0000000000', resolved: { title: 'Acme' } })
    expect(e).toMatchObject({ t: 'wikilink', embed: true })
  })

  it('leaves raw html and a lone # as text', () => {
    expect(parseInline('<b>x</b> # 12 #123')).toEqual([{ t: 'text', v: '<b>x</b> # 12 #123' }])
  })
})

describe('renderMarkdown on empty and legacy notes', () => {
  it('renders nothing for empty or frontmatter-only text', () => {
    expect(renderMarkdown('')).toEqual([])
    expect(renderMarkdown('---\nid: n-x\n---\n')).toEqual([])
  })

  it('reads an unclosed frontmatter or CRLF file as prose without throwing', () => {
    const open = renderMarkdown('---\ntitle: x\n# Not closed')
    expect(open.length).toBeGreaterThan(0)
    const crlf = renderMarkdown('# A\r\n- [fact] one ^f-abc\r\n')
    expect(crlf.map((b) => b.t)).toEqual(['heading', 'list'])
    expect(crlf[1]!.t === 'list' && crlf[1]!.items[0]!.line).toBe(1)
  })

  it('keeps an unclosed code fence as code to the end', () => {
    const b = renderMarkdown('intro\n```\n[[Not A Link]]\n')
    expect(b.some((x) => x.t === 'code' && x.text.includes('[[Not A Link]]'))).toBe(true)
  })
})

describe('ordered list numbers (CHAT-UI.md QA: "1. 1. 1.")', () => {
  it('an ordered item keeps its own number when paragraphs split the list', () => {
    const blocks = renderMarkdown('1. First caption\n\n#coffee #ethiopia\n\n2. Second caption\n\n#roast\n\n3. Third')
    const nums = blocks.flatMap((b) => (b.t === 'list' ? b.items.map((i) => i.num) : []))
    expect(nums).toEqual([1, 2, 3])
  })
})
