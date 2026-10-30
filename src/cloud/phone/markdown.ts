/**
 * Agent markdown on the phone, as VNodes (never HTML: every piece of text stays a text node, so `<script>` in an agent's
 * reply is just text, and the Trusted Types CSP of the hosted site never sees an HTML sink). A small, forgiving subset
 * that matches what agents write: paragraphs, headings, bullet and numbered lists, block quotes, fenced code, rules,
 * pipe tables (they scroll sideways on a narrow screen), and inline **bold**, *italic*, `code`, ~~strike~~ and
 * [links](https://…). A link is kept only for http(s) and mailto; anything else reads as its words. Half-written
 * markdown (a reply still streaming in) renders as plain text until it closes.
 */
import { h, type VNode } from '../console/dom'
import { isNextStepLabel } from '../../shared/replyStyle'

export type MdInline = VNode | string

/** A link target the phone may open: http(s) or mailto, else null. */
export function safeHref(raw: string): string | null {
  const t = raw.trim()
  if (!t || t.length > 2048 || /[\s<>"]/.test(t)) return null
  try {
    const u = new URL(t)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href
  } catch {
    /* not a URL */
  }
  return null
}

/** Inline markdown -> text nodes and small elements. */
export function inline(src: string): MdInline[] {
  const out: MdInline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf) out.push(buf)
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    // backslash escape
    if (c === '\\' && i + 1 < src.length && /[\\`*_~[\]()#|!-]/.test(src[i + 1]!)) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push(h('code', null, src.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2)
      if (end > i + 2 && src[i + 2] !== ' ') {
        flush()
        out.push(h('strong', null, ...inline(src.slice(i + 2, end))))
        i = end + 2
        continue
      }
    }
    if (c === '~' && src[i + 1] === '~') {
      const end = src.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        out.push(h('s', null, ...inline(src.slice(i + 2, end))))
        i = end + 2
        continue
      }
    }
    if (c === '*' || (c === '_' && (i === 0 || /[\s(]/.test(src[i - 1]!)))) {
      const end = findClose(src, c, i + 1)
      if (end > i + 1 && src[i + 1] !== ' ') {
        flush()
        out.push(h('em', null, ...inline(src.slice(i + 1, end))))
        i = end + 1
        continue
      }
    }
    if (c === '[') {
      const m = /^\[([^\]\n]{1,500})\]\(([^)\s]{1,2048})\)/.exec(src.slice(i))
      if (m) {
        flush()
        const href = safeHref(m[2]!)
        out.push(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, ...inline(m[1]!)) : m[1]!)
        i += m[0].length
        continue
      }
    }
    // a bare https link
    if (c === 'h' && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(src.slice(i))
      const href = m ? safeHref(m[0]) : null
      if (m && href) {
        flush()
        out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, m[0]))
        i += m[0].length
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}
function findClose(src: string, c: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++
      continue
    }
    if (src[j] === c && src[j + 1] !== c && src[j - 1] !== ' ' && (c !== '_' || j + 1 >= src.length || /[\s.,;:!?)]/.test(src[j + 1]!))) return j
  }
  return -1
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (t[i] === '|') {
      out.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  out.push(cur.trim())
  return out
}

/** "**Next step:** …": what the founder has to do, set apart from the reply (shared/replyStyle.ts). */
function isNextStep(line: string): boolean {
  const lead = /^\s*\*\*(.+?)\*\*/.exec(line)
  return !!lead && isNextStepLabel(lead[1]!)
}

/** Markdown -> block VNodes (class `md`). */
export function markdown(src: string): VNode[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: VNode[] = []
  let para: string[] = []
  const endPara = (): void => {
    if (para.length) out.push(h('p', isNextStep(para[0]!) ? { class: 'md-next' } : null, ...joinLines(para)))
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      endPara()
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      endPara()
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]!)) body.push(lines[i++]!)
      i++
      out.push(h('pre', { class: 'md-code' }, h('code', fence[2] ? { 'data-lang': fence[2] } : null, body.join('\n'))))
      continue
    }
    const head = HEADING.exec(line)
    if (head) {
      endPara()
      out.push(h(`h${Math.min(6, head[1]!.length + 2)}`, { class: 'md-h' }, ...inline(head[2]!)))
      i++
      continue
    }
    if (RULE.test(line)) {
      endPara()
      out.push(h('hr', { class: 'md-rule' }))
      i++
      continue
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      endPara()
      const headCells = cells(line)
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(cells(lines[i++]!))
      const cell = (tag: 'th' | 'td', text: string, n: number): VNode => h(tag, align[n] ? { class: `md-${align[n]}` } : null, ...inline(text))
      out.push(
        h(
          'div',
          { class: 'md-table', role: 'region', 'aria-label': 'Table', tabindex: '0' },
          h('table', null, h('thead', null, h('tr', null, ...headCells.map((c, n) => cell('th', c, n)))), h('tbody', null, ...rows.map((r) => h('tr', null, ...headCells.map((_c, n) => cell('td', r[n] ?? '', n))))))
        )
      )
      continue
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      endPara()
      const ordered = !BULLET.test(line)
      const start = ordered ? Number(NUMBERED.exec(line)![2]) : 1
      const items: string[][] = []
      while (i < lines.length) {
        const l = lines[i]!
        const b = ordered ? NUMBERED.exec(l) : BULLET.exec(l)
        if (b) {
          items.push([ordered ? b[3]! : b[2]!])
          i++
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          // a continuation or a nested item: kept as its own line in the item
          items[items.length - 1]!.push(l.trim())
          i++
        } else break
      }
      const li = (parts: string[]): VNode => {
        const [first, ...rest] = parts
        const task = /^\[([ xX])\]\s+(.*)$/.exec(first!)
        const lead = task ? [h('span', { class: `md-check${task[1] !== ' ' ? ' is-done' : ''}`, 'aria-hidden': 'true' }, task[1] !== ' ' ? '✓' : ''), ...inline(task[2]!)] : inline(first!)
        return h('li', null, ...lead, ...rest.flatMap((r) => ['\n', ...inline(r.replace(/^[-*+]\s+/, '• '))]))
      }
      out.push(h(ordered ? 'ol' : 'ul', { class: 'md-list', ...(ordered && start !== 1 ? { start: String(start) } : {}) }, ...items.map(li)))
      continue
    }
    if (/^\s*>/.test(line)) {
      endPara()
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push(h('blockquote', { class: 'md-quote' }, ...markdown(q.join('\n'))))
      continue
    }
    para.push(line)
    i++
  }
  endPara()
  return out
}
function joinLines(ls: string[]): MdInline[] {
  const out: MdInline[] = []
  ls.forEach((l, n) => {
    if (n) out.push('\n')
    out.push(...inline(l.trim()))
  })
  return out
}

/** The markdown block for one message. */
export function md(text: string): VNode {
  return h('div', { class: 'md' }, ...markdown(text))
}
