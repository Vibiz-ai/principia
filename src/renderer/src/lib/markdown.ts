/**
 * In-house markdown subset for the Passport reading mode (PASSPORT.md §10): headings, paragraphs, lists, emphasis,
 * code, tables, quotes and links, plus the vault grammar on top (wikilinks, tags, observation and relation bullets,
 * provenance tails and block ids, a collapsed History). Pure: text in, a small block tree out; NoteReader renders it.
 *
 * It never executes or injects HTML (raw tags render as text), and it reads lines with the shared grammar
 * (`@shared/vault`), so what the reader shows is exactly what the indexer understood.
 */
import { fencedCodeLines, parseBulletLine, parseHeading, parseLinkInner, sectionOfHeading, type Provenance, type Span } from '@shared/vault/grammar'
import { findFrontmatterClose } from '@shared/vault/frontmatter'

export interface ResolvedLink {
  noteId: string
  title: string
}
/** Resolves a wikilink target (title, alias or path) inside the open vault; null = ghost. */
export type LinkResolver = (target: string) => ResolvedLink | null

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'tag'; tag: string }
  | { t: 'url'; href: string; c: Inline[] }
  | { t: 'wikilink'; target: string; heading: string | null; block: string | null; label: string; embed: boolean; resolved: ResolvedLink | null }

export interface ListItem {
  line: number
  depth: number
  /** null = not a task; true/false = checkbox state */
  task: boolean | null
  ordered: boolean
  /** an ordered item's own number ("3." -> 3): a list split by a paragraph keeps counting */
  num?: number
  c: Inline[]
  /** `^anchor` at the end of the line (hidden in reading mode, used by "Copy block link") */
  blockId: string | null
  obs: { category: string; prov: Provenance | null } | null
  rel: { rel: string; prov: Provenance | null } | null
  history: { state: string; reason: string | null; by: string | null; prov: Provenance | null } | null
}

export type Block =
  | { t: 'heading'; level: number; c: Inline[]; text: string; line: number; blockId: string | null }
  | { t: 'para'; c: Inline[]; line: number; blockId: string | null }
  | { t: 'list'; items: ListItem[]; line: number }
  | { t: 'code'; lang: string; text: string; line: number }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right' | null)[]; line: number }
  | { t: 'quote'; c: Block[]; line: number }
  | { t: 'hr'; line: number }
  /** `## History`: collapsed by default; superseded and invalidated lines */
  | { t: 'history'; items: ListItem[]; line: number }

export interface RenderOptions {
  resolve?: LinkResolver
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const TASK_RE = /^\[([ xX])\][ \t]+/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/
const TABLE_SEP_RE = /^(?=.*\|)\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const ANCHOR_RE = /\s\^([A-Za-z0-9-]+)\s*$/

/** Splits on \r?\n; frontmatter is skipped (Properties shows it). */
export function renderMarkdown(text: string, opts: RenderOptions = {}): Block[] {
  const lines = text.split(/\r?\n/)
  const close = findFrontmatterClose(lines)
  const start = close >= 0 ? close + 1 : 0
  return parseBlocks(lines, start, lines.length, opts, true)
}

function parseBlocks(lines: string[], from: number, to: number, opts: RenderOptions, top: boolean): Block[] {
  const code = fencedCodeLines(lines.slice(0, to), from)
  const out: Block[] = []
  let i = from
  let history: Extract<Block, { t: 'history' }> | null = null
  const push = (b: Block): void => {
    if (history && b.t === 'list') history.items.push(...b.items)
    else if (history && b.t === 'para') history.items.push(paraAsItem(b))
    else out.push(b)
  }
  while (i < to) {
    const line = lines[i]!
    if (code[i]) {
      // a fence: collect until the closing fence (fencedCodeLines marks open, body and close)
      const m = FENCE_RE.exec(line)
      const body: string[] = []
      const at = i
      i++
      while (i < to && code[i] && !(isFenceClose(lines[i]!, m?.[1] ?? '```'))) body.push(lines[i++]!)
      if (i < to && code[i]) i++
      push({ t: 'code', lang: m?.[2] ?? '', text: body.join('\n'), line: at })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const h = parseHeading(line)
    if (h) {
      const section = top ? sectionOfHeading(h) : null
      if (section === 'history') {
        history = { t: 'history', items: [], line: i }
        out.push(history)
        i++
        continue
      }
      // any other heading of the same or higher level ends History
      if (history && h.level <= 2) history = null
      const { body, anchor } = splitAnchor(h.text)
      push({ t: 'heading', level: h.level, c: parseInline(body, opts), text: body, line: i, blockId: anchor })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      push({ t: 'hr', line: i })
      i++
      continue
    }
    if (/^ {0,3}>/.test(line)) {
      const at = i
      const inner: string[] = []
      while (i < to && !code[i] && /^ {0,3}>/.test(lines[i]!)) inner.push(lines[i++]!.replace(/^ {0,3}> ?/, ''))
      push({ t: 'quote', c: parseBlocks(inner, 0, inner.length, opts, false), line: at })
      continue
    }
    if (line.includes('|') && i + 1 < to && TABLE_SEP_RE.test(lines[i + 1]!) && !code[i + 1]) {
      const at = i
      const head = splitRow(line).map((c) => parseInline(c, opts))
      const align = splitRow(lines[i + 1]!).map((c) => {
        const s = c.trim()
        return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null
      })
      i += 2
      const rows: Inline[][][] = []
      while (i < to && !code[i] && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(splitRow(lines[i++]!).map((c) => parseInline(c, opts)))
      push({ t: 'table', head, rows, align, line: at })
      continue
    }
    if (LIST_RE.test(line)) {
      const at = i
      const items: ListItem[] = []
      while (i < to && !code[i] && LIST_RE.test(lines[i]!)) {
        items.push(listItem(lines[i]!, i, opts, !!history))
        i++
      }
      push({ t: 'list', items, line: at })
      continue
    }
    // paragraph: consecutive prose lines, kept as line breaks (Obsidian's default)
    const at = i
    const parts: string[] = []
    while (i < to && !code[i] && lines[i]!.trim() && !isBlockStart(lines, i, to)) parts.push(lines[i++]!)
    if (!parts.length) parts.push(lines[i++]!)
    const last = splitAnchor(parts[parts.length - 1]!)
    parts[parts.length - 1] = last.body
    const c: Inline[] = []
    parts.forEach((p, k) => {
      if (k) c.push({ t: 'br' })
      c.push(...parseInline(p.trim(), opts))
    })
    push({ t: 'para', c, line: at, blockId: last.anchor })
  }
  return out
}

function isFenceClose(line: string, open: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
  return !!m && m[1]![0] === open[0] && m[1]!.length >= open.length
}

function isBlockStart(lines: string[], i: number, to: number): boolean {
  const line = lines[i]!
  if (parseHeading(line) || HR_RE.test(line) || LIST_RE.test(line) || /^ {0,3}>/.test(line) || FENCE_RE.test(line)) return true
  return line.includes('|') && i + 1 < to && TABLE_SEP_RE.test(lines[i + 1]!)
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  // `\|` inside a cell (wikilink aliases in tables) is not a separator
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function splitAnchor(s: string): { body: string; anchor: string | null } {
  const m = ANCHOR_RE.exec(s)
  return m ? { body: s.slice(0, m.index), anchor: m[1]! } : { body: s, anchor: null }
}

function paraAsItem(b: Extract<Block, { t: 'para' }>): ListItem {
  return { line: b.line, depth: 0, task: null, ordered: false, c: b.c, blockId: b.blockId, obs: null, rel: null, history: null }
}

/** Removes `spans` from `s` (sorted, non-overlapping) and collapses the whitespace they leave. */
function cut(s: string, spans: (Span | undefined)[]): string {
  const list = spans.filter((x): x is Span => !!x).sort((a, b) => b.start - a.start)
  let out = s
  for (const sp of list) out = out.slice(0, sp.start) + out.slice(sp.end)
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

function listItem(line: string, lineNo: number, opts: RenderOptions, inHistory: boolean): ListItem {
  const m = LIST_RE.exec(line)!
  const indent = m[1]!.replace(/\t/g, '  ').length
  const ordered = /\d/.test(m[2]!)
  const base: ListItem = { line: lineNo, depth: Math.floor(indent / 2), task: null, ordered, c: [], blockId: null, obs: null, rel: null, history: null }
  if (ordered) base.num = parseInt(m[2]!, 10)
  let rest = m[3]!
  const task = TASK_RE.exec(rest)
  if (task && !ordered) {
    base.task = task[1] !== ' '
    rest = rest.slice(task[0].length)
  }
  const bullet = ordered || base.task !== null ? null : parseBulletLine(line, inHistory)
  if (!bullet) {
    const { body, anchor } = splitAnchor(rest)
    return { ...base, c: parseInline(body, opts), blockId: anchor }
  }
  const s = bullet.spans
  base.blockId = bullet.anchor
  switch (bullet.kind) {
    case 'observation':
      base.obs = { category: bullet.category, prov: bullet.prov }
      base.c = parseInline(cut(line, [s.marker, s.category, s.prov, s.anchor]), opts)
      break
    case 'relation':
      base.rel = { rel: bullet.rel, prov: bullet.prov }
      base.c = parseInline(cut(line, [s.marker, s.rel, s.prov, s.anchor]), opts)
      break
    case 'history':
      base.history = { state: bullet.state, reason: bullet.reason, by: bullet.supersededBy, prov: bullet.prov }
      base.c = parseInline(cut(line, [s.marker, s.category, s.prov, s.detail, s.anchor]), opts)
      break
    case 'bare_link':
      base.c = parseInline(cut(line, [s.marker, s.prov, s.anchor]), opts)
      break
  }
  return base
}

// ---------- inline ----------

/**
 * One alternation, tried left to right: code spans first (nothing inside them is markup), then wikilinks/embeds,
 * markdown links, bare URLs, emphasis and tags. Unmatched markup stays literal text.
 */
const INLINE_RE = new RegExp(
  [
    '(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)', // 1,2 code
    '(!?)\\[\\[([^[\\]\\n]+?)\\]\\]', // 3,4 wikilink
    '!?\\[([^\\]\\n]*)\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+"[^"]*")?\\s*\\)', // 5,6 md link
    '(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?\'"])', // 7 url
    '\\*\\*(?=\\S)([^*\\n]*?\\S)\\*\\*', // 8 strong
    '(?<![A-Za-z0-9_])__(?=\\S)([^_\\n]*?\\S)__(?![A-Za-z0-9_])', // 9 strong
    '~~(?=\\S)([^~\\n]*?\\S)~~', // 10 del
    '\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*', // 11 em
    '(?<![A-Za-z0-9_])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?![A-Za-z0-9_])', // 12 em
    '(?<=^|[\\s(,;])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)' // 13 tag
  ].join('|'),
  'g'
)

export function parseInline(s: string, opts: RenderOptions = {}): Inline[] {
  const out: Inline[] = []
  let last = 0
  const text = (v: string): void => {
    if (!v) return
    const prev = out[out.length - 1]
    if (prev && prev.t === 'text') prev.v += v
    else out.push({ t: 'text', v })
  }
  const re = new RegExp(INLINE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    text(s.slice(last, m.index))
    last = m.index + m[0].length
    if (m[2] !== undefined) out.push({ t: 'code', v: m[2].trim() === '' ? m[2] : m[2].replace(/^ (.*) $/, '$1') })
    else if (m[4] !== undefined) out.push(wikilink(m[4], m[3] === '!', opts))
    else if (m[6] !== undefined) {
      const href = m[6]
      if (/\.md(#.*)?$/i.test(href) && !/^[a-z]+:/i.test(href)) {
        // a markdown link to a note counts as a wikilink (§3.2)
        let target = href
        try {
          target = decodeURI(href)
        } catch {
          /* keep raw */
        }
        const [path, hash] = target.split('#')
        const l = wikilink(`${path!.replace(/\.md$/i, '')}${hash ? `#${hash}` : ''}`, false, opts)
        out.push({ ...l, label: m[5] || l.label })
      } else if (/^(https?|mailto|obsidian):/i.test(href)) out.push({ t: 'url', href, c: parseInline(m[5] || href, opts) })
      else text(m[0])
    } else if (m[7] !== undefined) out.push({ t: 'url', href: m[7], c: [{ t: 'text', v: m[7] }] })
    else if (m[8] !== undefined || m[9] !== undefined) out.push({ t: 'strong', c: parseInline((m[8] ?? m[9])!, opts) })
    else if (m[10] !== undefined) out.push({ t: 'del', c: parseInline(m[10], opts) })
    else if (m[11] !== undefined || m[12] !== undefined) out.push({ t: 'em', c: parseInline((m[11] ?? m[12])!, opts) })
    else if (m[13] !== undefined) out.push({ t: 'tag', tag: m[13].replace(/\/+$/, '') })
  }
  text(s.slice(last))
  return out
}

function wikilink(inner: string, embed: boolean, opts: RenderOptions): Extract<Inline, { t: 'wikilink' }> {
  const p = parseLinkInner(inner)
  const target = p.target
  const label = p.display || (target ? target.split('/').pop()! : '') + (p.heading ? ` › ${p.heading}` : '') || p.heading || inner
  const resolved = target ? (opts.resolve?.(target) ?? null) : null
  return { t: 'wikilink', target, heading: p.heading, block: p.block, label, embed, resolved }
}

/** Plain text of inline nodes (titles, search, tests). */
export function inlineText(c: Inline[]): string {
  return c
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v
        case 'br':
          return '\n'
        case 'tag':
          return `#${n.tag}`
        case 'wikilink':
          return n.label
        default:
          return inlineText(n.c)
      }
    })
    .join('')
}
