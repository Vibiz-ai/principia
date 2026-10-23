// Vendored from open-passport 0.1.0 (packages/js/src/core/note.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Notes (SPEC.md §3): YAML-subset frontmatter, an optional H1, a summary paragraph, sections and lines.
import { parseLine, type Line } from './grammar'

/** One frontmatter entry: the key and its raw lines (key line + indented continuation lines), kept byte for byte. */
export interface FrontmatterEntry {
  key: string
  raw: string[]
  value: string | string[]
}

export interface ParsedLine {
  line: Line
  /** 0-based index in the body lines */
  index: number
  /** the `##` heading the line sits under ('' before the first one) */
  section: string
}

export interface Note {
  path: string
  /** frontmatter `id`, else null */
  id: string | null
  title: string
  type: string
  frontmatter: FrontmatterEntry[]
  /** first prose paragraph after the H1 (or the frontmatter `summary`), one line */
  summary: string
  lines: ParsedLine[]
  /** body lines (after the frontmatter) */
  body: string[]
  /** frontmatter present (`---` block) */
  hasFrontmatter: boolean
}

const unquote = (s: string): string => {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1).replace(/\\"/g, '"')
  return t
}

function parseValue(first: string, rest: string[]): string | string[] {
  const v = first.trim()
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    const out: string[] = []
    let cur = ''
    let q: string | null = null
    for (const ch of inner) {
      if (q) {
        cur += ch
        if (ch === q) q = null
      } else if (ch === '"' || ch === "'") {
        q = ch
        cur += ch
      } else if (ch === ',') {
        out.push(unquote(cur))
        cur = ''
      } else cur += ch
    }
    out.push(unquote(cur))
    return out.filter((x) => x !== '')
  }
  if (!v && rest.length && rest.every((l) => /^\s*-\s/.test(l) || !l.trim())) return rest.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s*-\s/, '')))
  if (!v && rest.length) return rest.map((l) => l.trim()).join(' ')
  return unquote(v)
}

/** Splits `---` frontmatter off a note. Unknown keys and their formatting are preserved in `raw`. */
export function parseFrontmatter(text: string): { entries: FrontmatterEntry[]; body: string; present: boolean } {
  const norm = text.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(norm)
  if (!m) return { entries: [], body: norm, present: false }
  const entries: FrontmatterEntry[] = []
  const lines = m[1].split(/\r?\n/)
  let cur: { key: string; first: string; raw: string[]; rest: string[] } | null = null
  const flush = () => {
    if (cur) entries.push({ key: cur.key, raw: cur.raw, value: parseValue(cur.first, cur.rest) })
    cur = null
  }
  for (const l of lines) {
    const km = /^([A-Za-z0-9_-][A-Za-z0-9_ -]*?):(?:\s(.*)|$)/.exec(l)
    if (km && !/^\s/.test(l)) {
      flush()
      cur = { key: km[1], first: km[2] ?? '', raw: [l], rest: [] }
    } else if (cur) {
      cur.raw.push(l)
      cur.rest.push(l)
    } else entries.push({ key: '', raw: [l], value: '' })
  }
  flush()
  return { entries, body: norm.slice(m[0].length), present: true }
}

export function fmValue(n: Pick<Note, 'frontmatter'>, key: string): string | string[] | undefined {
  return n.frontmatter.find((e) => e.key === key)?.value
}
export function fmString(n: Pick<Note, 'frontmatter'>, key: string): string | null {
  const v = fmValue(n, key)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Renders a scalar for frontmatter: bare when safe, else double-quoted. */
export function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _./@-]*$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s)
}

export function serializeFrontmatter(entries: FrontmatterEntry[]): string {
  if (!entries.length) return ''
  return `---\n${entries.flatMap((e) => e.raw).join('\n')}\n---\n`
}

const stem = (path: string) => path.replace(/^.*\//, '').replace(/\.md$/i, '')

/** Parses one markdown note. `## History` lines become history lines; everything else is detected anywhere. */
export function parseNote(path: string, text: string): Note {
  const fm = parseFrontmatter(text)
  const body = fm.body.split(/\r?\n/)
  if (body.length && body[body.length - 1] === '') body.pop()
  const n: Note = { path, id: null, title: '', type: 'note', frontmatter: fm.entries, summary: '', lines: [], body, hasFrontmatter: fm.present }
  n.id = fmString(n, 'id')
  let h1: string | null = null
  let section = ''
  let fence = false
  const summary: string[] = []
  let summaryDone = false
  for (let i = 0; i < body.length; i++) {
    const l = body[i]
    if (/^ {0,3}(```|~~~)/.test(l)) {
      fence = !fence
      summaryDone = summaryDone || summary.length > 0
      continue
    }
    if (fence) continue
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)
    if (h) {
      if (h[1].length === 1 && h1 === null) h1 = h[2]
      else summaryDone = true
      if (h[1].length === 2) section = h[2].trim()
      continue
    }
    const parsed = parseLine(l, section.toLowerCase() === 'history')
    if (parsed) {
      n.lines.push({ line: parsed, index: i, section })
      summaryDone = true
      continue
    }
    if (!summaryDone && section === '' && !/^\s*[-*+]\s/.test(l) && !/^\s*%%/.test(l)) {
      if (l.trim()) summary.push(l.trim())
      else if (summary.length) summaryDone = true
    }
  }
  n.title = fmString(n, 'title') ?? h1?.trim() ?? stem(path)
  n.type = (fmString(n, 'type') ?? 'note').toLowerCase()
  n.summary = fmString(n, 'summary') ?? summary.join(' ')
  return n
}

/** The note as text again (frontmatter entries + body lines), LF line endings, one trailing newline. */
export function serializeNote(n: Pick<Note, 'frontmatter' | 'body'>): string {
  const body = n.body.join('\n')
  return `${serializeFrontmatter(n.frontmatter)}${body}${body.endsWith('\n') || !body ? '' : '\n'}`
}

/** Lowercase ASCII slug: `Customer Success` -> `customer-success`. */
export function slugify(s: string): string {
  const t = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return t || 'department'
}
