/** The phone's markdown: VNodes only (no HTML), safe links, tables that scroll. */
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../shared/chat'
import { findAll, textOf, type VNode } from '../console/dom'
import { inline, markdown, md, safeHref } from './markdown'
import { chatLines } from './model'

const tags = (v: VNode): string[] => findAll(v, () => true).map((n) => n.tag)
const one = (src: string): VNode => md(src)

describe('markdown', () => {
  it('bold, italic, code and strike become elements, never raw markers', () => {
    const v = one('This is **bold**, *italic*, _also_, `npm test` and ~~gone~~.')
    expect(tags(v)).toEqual(expect.arrayContaining(['strong', 'em', 'code', 's']))
    expect(textOf(v)).toBe('This is bold, italic, also, npm test and gone.')
    expect(textOf(v)).not.toContain('**')
  })
  it('sets a **Next step:** line apart, and only that one', () => {
    const v = one('Done.\n\n**Note:** nothing else changed.\n\n**Next step:** merge PR #110.')
    const next = findAll(v, (n) => n.tag === 'p' && n.attrs.class === 'md-next')
    expect(next.map(textOf)).toEqual(['Next step: merge PR #110.'])
  })
  it('keeps half-written markdown as plain text (a reply still streaming)', () => {
    expect(textOf(one('Working on **the menu'))).toBe('Working on **the menu')
    expect(textOf(one('2 * 3 = 6'))).toBe('2 * 3 = 6')
    expect(textOf(one('snake_case_name stays'))).toBe('snake_case_name stays')
  })
  it('lists, numbered lists, task items, headings, quotes, rules, fenced code', () => {
    const v = one('# Plan\n\n- one\n- **two**\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] open\n\n> quoted\n\n---\n\n```ts\nconst a = 1 < 2\n```')
    const t = tags(v)
    expect(t).toEqual(expect.arrayContaining(['h3', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre']))
    const ol = findAll(v, (n) => n.tag === 'ol')[0]!
    expect(ol.attrs.start).toBe('3')
    expect(findAll(v, (n) => n.tag === 'pre').map(textOf)).toEqual(['const a = 1 < 2'])
    expect(findAll(v, (n) => (n.attrs.class ?? '').includes('md-check')).length).toBe(2)
  })
  it('tables: header, rows, alignment, inside a sideways-scrolling region', () => {
    const v = one('| Dish | Price |\n|:--|--:|\n| **Soup** | 9 |\n| Pie \\| tart | 12 |')
    const wrap = findAll(v, (n) => n.attrs.class === 'md-table')
    expect(wrap.length).toBe(1)
    expect(findAll(v, (n) => n.tag === 'th').map(textOf)).toEqual(['Dish', 'Price'])
    expect(findAll(v, (n) => n.tag === 'td').map(textOf)).toEqual(['Soup', '9', 'Pie | tart', '12'])
    expect(findAll(v, (n) => n.tag === 'td')[1]!.attrs.class).toBe('md-right')
    expect(textOf(v)).not.toContain('|--')
  })
  it('a line of pipes without a separator is a paragraph', () => {
    expect(tags(one('| not | a table |'))).not.toContain('table')
  })
  it('links: only http(s) and mailto; javascript: and data: read as words', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,<b>')).toBeNull()
    const v = one('[docs](https://example.com) and [bad](javascript:alert(1)) and https://example.org/x.')
    const as = findAll(v, (n) => n.tag === 'a')
    expect(as.map((a) => a.attrs.href)).toEqual(['https://example.com/', 'https://example.org/x'])
    expect(as.every((a) => a.attrs.rel?.includes('noopener'))).toBe(true)
    expect(textOf(v)).toContain('bad')
  })
  it('markup in agent text stays text: no element but the allowed ones, no handlers', () => {
    const v = one('<script>alert(1)</script> <img src=x onerror=alert(1)> **<b>x</b>**')
    const allowed = new Set(['div', 'p', 'strong'])
    expect(tags(v).every((t) => allowed.has(t))).toBe(true)
    expect(findAll(v, (n) => Object.keys(n.on).length > 0)).toEqual([])
    expect(textOf(v)).toContain('<script>alert(1)</script>')
  })
  it('backslash escapes', () => {
    expect(inline('\\*not italic\\*')).toEqual(['*not italic*'])
  })
  it('paragraph lines keep their breaks', () => {
    expect(markdown('a\nb').map(textOf)).toEqual(['a\nb'])
  })
})

describe('chat lines on the phone', () => {
  it('drops the Mac replay dividers ("From the terminal") but keeps real notices', () => {
    const n = (id: string, text: string): ChatItem => ({ id, parent: null, kind: 'notice', tone: 'info', text, action: null }) as ChatItem
    const lines = chatLines([n('n1', 'From the terminal'), n('n2', 'Back from the terminal'), n('n3', 'Resumed this conversation'), n('n4', 'Conversation compacted')])
    expect(lines.map((l) => (l.t === 'notice' ? l.text : l.t))).toEqual(['Conversation compacted'])
  })
})
