// Byte-preserving YAML subset for note frontmatter (PASSPORT.md §3.1).
//
// Supported: top-level `key: value` with plain / single- / double-quoted scalars, booleans, null,
// numbers, flow lists `[a, "b"]`, block lists (`key:` + `- item` lines), block scalars (`|`, `>`),
// comments and blank lines. Anything else (nested maps, flow maps, anchors) is kept as `{ raw }` and
// never rewritten. Parsing never re-renders: the file keeps its own lines, and a set only replaces the
// lines of the one entry it touches. Unknown keys, key order, comments, CRLF/LF and the trailing
// newline survive byte for byte.

import { type Lines, eolOfLines, insertLines, removeLines, splitLines } from './grammar'

export type FmScalar = string | number | boolean | null
export type FmValue = FmScalar | string[] | { raw: string }

export interface FmEntry {
  key: string
  value: FmValue
  /** File line range [start, end) covering the key line and its continuation lines. */
  start: number
  end: number
  style: 'scalar' | 'flow' | 'block' | 'blockScalar' | 'raw'
  /** Indentation of block list items (`  ` in `  - a`). */
  itemIndent?: string
  /** Trailing ` # comment` on a single-line entry, kept when the value is replaced. */
  comment?: string
}

export interface Frontmatter {
  /** Line index of the closing `---` (the opening one is always line 0). */
  close: number
  entries: FmEntry[]
  /** False when a line could not be parsed; the writer must not rewrite such a note. */
  ok: boolean
  warnings: string[]
}

const BOM = '\uFEFF'

/** Index of the closing fence when line 0 opens a frontmatter block, else -1. */
export function findFrontmatterClose(lines: string[]): number {
  if (lines.length < 2) return -1
  if (lines[0].replace(BOM, '').trimEnd() !== '---') return -1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trimEnd()
    if (t === '---' || t === '...') return i
  }
  return -1
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:[\]{},][^:]*?|-[^\s:][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/
const LIST_ITEM_RE = /^([ \t]*)-(?:[ \t]+(.*?))?[ \t]*$/

function unquoteKey(k: string): string {
  if (k.startsWith('"')) return parseDoubleQuoted(k) ?? k
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'")
  return k
}

function parseDoubleQuoted(s: string): string | null {
  try {
    const v = JSON.parse(s.replace(/\\'/g, "'").replace(/\t/g, '\\t'))
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** Splits a trailing comment off a single-line value; returns null when quotes are unbalanced. */
function splitComment(v: string): { value: string; comment: string } | null {
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0]
    let i = 1
    while (i < v.length) {
      if (q === '"' && v[i] === '\\') i += 2
      else if (v[i] === q) {
        if (q === "'" && v[i + 1] === "'") i += 2
        else break
      } else i++
    }
    if (i >= v.length) return null
    const rest = v.slice(i + 1)
    if (rest.trim() === '') return { value: v.slice(0, i + 1), comment: rest }
    const c = /^([ \t]+#.*)$/.exec(rest)
    return c ? { value: v.slice(0, i + 1), comment: c[1] } : null
  }
  const c = /[ \t]+#/.exec(v)
  if (c && !v.startsWith('[') && !v.startsWith('{')) return { value: v.slice(0, c.index), comment: v.slice(c.index) }
  if (c && (v.startsWith('[') || v.startsWith('{'))) {
    const close = v.lastIndexOf(v.startsWith('[') ? ']' : '}')
    if (close >= 0 && close < c.index) return { value: v.slice(0, c.index), comment: v.slice(c.index) }
  }
  return { value: v, comment: '' }
}

/** Parses one scalar (plain or quoted). Returns undefined when malformed. */
export function parseScalar(raw: string): FmScalar | undefined {
  const s = raw.trim()
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) return undefined
    const v = parseDoubleQuoted(s)
    return v === null ? undefined : v
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) return undefined
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s === '' || s === '~' || /^null$/i.test(s)) return null
  if (/^true$/i.test(s)) return true
  if (/^false$/i.test(s)) return false
  if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(s) || /^[-+]?\.\d+$/.test(s)) return Number(s)
  return s
}

/** Splits a flow list body on top-level commas, respecting quotes and `[[…]]`. */
function splitFlow(body: string): string[] | null {
  const items: string[] = []
  let cur = ''
  let depth = 0
  let q: string | null = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (q) {
      cur += ch
      if (q === '"' && ch === '\\') cur += body[++i] ?? ''
      else if (ch === q) {
        if (q === "'" && body[i + 1] === "'") cur += body[++i]
        else q = null
      }
      continue
    }
    if ((ch === '"' || ch === "'") && cur.trim() === '') q = ch
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (depth < 0) return null
    if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (q || depth !== 0) return null
  if (cur.trim() !== '' || items.length > 0) items.push(cur)
  return items.map((s) => s.trim()).filter((s, i, a) => !(s === '' && i === a.length - 1))
}

function scalarItemToString(raw: string): string | undefined {
  const s = raw.trim()
  // Lenient: an unquoted [[Link]] item (YAML would read a nested list).
  if (/^\[\[[^[\]]+\]\]$/.test(s)) return s
  const v = parseScalar(s)
  if (v === undefined) return undefined
  return v === null ? '' : String(v)
}

function parseFlowList(v: string): string[] | undefined {
  if (!v.startsWith('[') || !v.endsWith(']')) return undefined
  const parts = splitFlow(v.slice(1, -1))
  if (!parts) return undefined
  const out: string[] = []
  for (const p of parts) {
    const s = scalarItemToString(p)
    if (s === undefined) return undefined
    out.push(s)
  }
  return out
}

/** Parses the YAML lines between the fences. */
export function parseFrontmatterLines(lines: string[], close: number): Frontmatter {
  const entries: FmEntry[] = []
  const warnings: string[] = []
  let ok = true
  let i = 1
  const isTrivia = (l: string): boolean => l.trim() === '' || /^\s*#/.test(l)
  while (i < close) {
    const line = lines[i]
    if (isTrivia(line)) {
      i++
      continue
    }
    const m = KEY_RE.exec(line)
    if (!m || /^\s/.test(line)) {
      ok = false
      warnings.push(`frontmatter line ${i + 1} is not a top-level key`)
      i++
      continue
    }
    const key = unquoteKey(m[1])
    const start = i
    i++
    // continuation: indented lines, or `- item` lines directly under an empty value
    const rawValue = m[2] ?? ''
    while (i < close) {
      const l = lines[i]
      if (l.trim() === '') break
      if (/^\s/.test(l) || (rawValue === '' && /^-(\s|$)/.test(l))) i++
      else break
    }
    const end = i
    const cont = lines.slice(start + 1, end)
    const entry = parseEntryValue(key, rawValue, cont, start, end)
    if (!entry) {
      ok = false
      warnings.push(`frontmatter key "${key}" has a malformed value`)
      entries.push({ key, value: { raw: lines.slice(start, end).join('\n') }, start, end, style: 'raw' })
      continue
    }
    if (entries.some((e) => e.key === key)) warnings.push(`duplicate frontmatter key "${key}"`)
    entries.push(entry)
  }
  return { close, entries, ok, warnings }
}

function parseEntryValue(key: string, rawValue: string, cont: string[], start: number, end: number): FmEntry | null {
  const base = { key, start, end }
  if (rawValue === '') {
    if (cont.length === 0) return { ...base, value: null, style: 'scalar', comment: '' }
    const items: string[] = []
    let itemIndent: string | undefined
    for (const l of cont) {
      if (/^\s*#/.test(l)) continue
      const im = LIST_ITEM_RE.exec(l)
      if (!im) return { ...base, value: { raw: cont.join('\n') }, style: 'raw' }
      itemIndent ??= im[1]
      const body = im[2] ?? ''
      const sc = splitComment(body)
      const s = sc ? scalarItemToString(sc.value) : undefined
      if (s === undefined) return { ...base, value: { raw: cont.join('\n') }, style: 'raw' }
      items.push(s)
    }
    return { ...base, value: items, style: 'block', itemIndent: itemIndent ?? '  ' }
  }
  if (/^[|>][-+]?\d*$/.test(rawValue)) {
    const indent = Math.min(...cont.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)![0].length))
    const body = cont.map((l) => l.slice(indent))
    const folded = rawValue.startsWith('>')
    let text = folded ? body.join(' ') : body.join('\n')
    if (!rawValue.includes('-')) text += '\n'
    return { ...base, value: text, style: 'blockScalar' }
  }
  if (cont.length > 0) {
    // multi-line plain, quoted or flow value: keep raw (never rewritten), but reject unterminated ones
    const joined = [rawValue, ...cont.map((l) => l.trim())].join(' ')
    if ((joined.startsWith('"') || joined.startsWith("'")) && !splitComment(joined)) return null
    if (joined.startsWith('[') && !/\]\s*(#.*)?$/.test(joined)) return null
    if (joined.startsWith('{') && !/\}\s*(#.*)?$/.test(joined)) return null
    return { ...base, value: { raw: [rawValue, ...cont].join('\n') }, style: 'raw' }
  }
  const sc = splitComment(rawValue)
  if (!sc) return null
  const v = sc.value.trim()
  if (v.startsWith('{') || v.startsWith('&') || v.startsWith('*') || v.startsWith('!')) {
    return { ...base, value: { raw: rawValue }, style: 'raw' }
  }
  if (v.startsWith('[')) {
    if (/^\[\[[^[\]]+\]\]$/.test(v)) return { ...base, value: v, style: 'scalar', comment: sc.comment }
    const list = parseFlowList(v)
    if (list === undefined) return null
    return { ...base, value: list, style: 'flow', comment: sc.comment }
  }
  const s = parseScalar(v)
  if (s === undefined) return null
  return { ...base, value: s, style: 'scalar', comment: sc.comment }
}

/** Frontmatter of a whole note text (null when the note has none). */
export function parseFrontmatter(text: string): Frontmatter | null {
  const { lines } = splitLines(text)
  const close = findFrontmatterClose(lines)
  return close < 0 ? null : parseFrontmatterLines(lines, close)
}

/** Key -> value (first occurrence wins, like Obsidian). */
export function frontmatterData(fm: Frontmatter | null): Record<string, FmValue> {
  const out: Record<string, FmValue> = {}
  if (!fm) return out
  for (const e of fm.entries) if (!(e.key in out)) out[e.key] = e.value
  return out
}

export function getEntry(fm: Frontmatter | null, key: string): FmEntry | undefined {
  return fm?.entries.find((e) => e.key === key)
}

// --- value helpers

export function fmString(v: FmValue | undefined): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return null
}

export function fmBool(v: FmValue | undefined): boolean {
  return v === true || (typeof v === 'string' && /^(true|yes)$/i.test(v))
}

/** List values; a single string becomes one item (`split` splits tags-style `a, b c`). */
export function fmList(v: FmValue | undefined, split = false): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean)
  const s = fmString(v)
  if (s === null || s.trim() === '') return []
  return split ? s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : [s.trim()]
}

/** `[[…]]` targets inside a property value (raw inner text, e.g. `Acme|the company`). */
export function linksInValue(v: FmValue | undefined): string[] {
  const parts: string[] = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  const out: string[] = []
  for (const p of parts) for (const m of p.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) out.push(m[1])
  return out
}

export function valuesEqual(a: FmValue | undefined, b: FmValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') return a.raw === b.raw
  return a === b
}

// --- formatting

const RESERVED_RE = /^(?:true|false|yes|no|on|off|null|~|y|n)$/i
const NUMBER_LIKE_RE = /^[-+]?(?:\d[\d_]*)?(?:\.\d+)?(?:[eE][-+]?\d+)?$|^0[xob]|^[-+]?\.(?:inf|nan)$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Formats a string scalar, quoting only when YAML (or Obsidian) would misread it. */
export function formatYamlString(s: string, flow = false): string {
  const needs =
    s === '' ||
    /^\s|\s$/.test(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:(\s|$)|\s#/.test(s) ||
    /[\r\n\t\\]/.test(s) ||
    s.includes('[[') ||
    RESERVED_RE.test(s) ||
    (NUMBER_LIKE_RE.test(s) && !DATE_RE.test(s) && /\d/.test(s)) ||
    (flow && /[,[\]{}]/.test(s))
  return needs ? JSON.stringify(s) : s
}

export function formatYamlKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/.test(key) && !/\s$/.test(key) ? key : JSON.stringify(key)
}

/** Inline rendering of a value (`[a, "[[b]]"]` for lists). Raw values render as written. */
export function formatYamlValue(v: FmValue): string {
  if (v === null) return ''
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') return formatYamlString(v)
  if (Array.isArray(v)) return `[${v.map((s) => formatYamlString(s, true)).join(', ')}]`
  return v.raw
}

/** Lines for one entry (without terminators). */
export function formatEntryLines(key: string, v: FmValue, opts: { block?: boolean; itemIndent?: string; comment?: string } = {}): string[] {
  const k = formatYamlKey(key)
  if (Array.isArray(v) && opts.block && v.length > 0) {
    const ind = opts.itemIndent ?? '  '
    return [`${k}:`, ...v.map((s) => `${ind}- ${formatYamlString(s)}`)]
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return `${k}:${v.raw.includes('\n') ? '' : ' '}${v.raw}`.split('\n')
  const val = formatYamlValue(v)
  return [`${k}:${val === '' ? '' : ` ${val}`}${opts.comment ?? ''}`]
}

// --- edits on a line model (used by patch.ts)

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

/**
 * Sets (or with `undefined`, removes) a top-level key in place. Returns false when nothing changed.
 * Only the entry's own lines are replaced; a missing key is appended before the closing fence; a note
 * without frontmatter gets one at the top. Throws on unparseable frontmatter (never rewritten).
 */
export function setFrontmatterValue(l: Lines, key: string, value: FmValue | undefined): boolean {
  const eol = eolOfLines(l)
  let close = findFrontmatterClose(l.lines)
  if (close < 0) {
    if (value === undefined) return false
    const head = ['---', ...formatEntryLines(key, value), '---']
    // a BOM must stay the first byte of the file, or the new `---` would not open frontmatter
    if (l.lines[0]?.startsWith(BOM)) {
      l.lines[0] = l.lines[0].slice(1)
      head[0] = BOM + head[0]
    }
    if (l.lines.length === 0) {
      l.lines.push(...head)
      l.eols.push(...head.map(() => eol))
    } else insertLines(l, 0, head, eol)
    return true
  }
  const fm = parseFrontmatterLines(l.lines, close)
  if (!fm.ok) throw new FrontmatterError(`frontmatter is not editable: ${fm.warnings.join('; ')}`)
  const entry = getEntry(fm, key)
  if (value === undefined) {
    if (!entry) return false
    removeLines(l, entry.start, entry.end - entry.start)
    return true
  }
  if (entry) {
    if (entry.style !== 'raw' && valuesEqual(entry.value, value)) return false
    const lines = formatEntryLines(key, value, {
      block: entry.style === 'block',
      itemIndent: entry.itemIndent,
      comment: entry.style === 'scalar' || entry.style === 'flow' ? entry.comment : undefined
    })
    if (entry.style === 'block' && Array.isArray(entry.value) && Array.isArray(value)) {
      // keep the original bytes of items whose value did not change (quoting, comments)
      const oldItems = l.lines.slice(entry.start + 1, entry.end).filter((x) => !/^\s*#/.test(x))
      const pool = new Map<string, string[]>()
      entry.value.forEach((v, i) => pool.set(v, [...(pool.get(v) ?? []), oldItems[i]]))
      for (let i = 1; i < lines.length; i++) {
        const reuse = pool.get(value[i - 1])?.shift()
        if (reuse !== undefined) lines[i] = reuse
      }
      lines[0] = l.lines[entry.start]
    }
    const keepEols = l.eols.slice(entry.start, entry.end)
    l.lines.splice(entry.start, entry.end - entry.start, ...lines)
    l.eols.splice(entry.start, entry.end - entry.start, ...lines.map((_, i) => keepEols[i] ?? keepEols[0] ?? eol))
    return true
  }
  // append after the last entry (before trailing blank lines/comments directly above the fence)
  let at = close
  while (at - 1 > 0 && l.lines[at - 1].trim() === '') at--
  if (fm.entries.length > 0) at = Math.max(at, fm.entries[fm.entries.length - 1].end)
  insertLines(l, at, formatEntryLines(key, value), eol)
  close = findFrontmatterClose(l.lines)
  return close > 0
}

/** Convenience over a whole text. */
export function setFrontmatterInText(text: string, key: string, value: FmValue | undefined): string {
  const l = splitLines(text)
  if (!setFrontmatterValue(l, key, value)) return text
  return l.lines.map((s, i) => s + l.eols[i]).join('')
}
