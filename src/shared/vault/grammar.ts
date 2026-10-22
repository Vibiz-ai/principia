// Line grammar of Passport notes (PASSPORT.md §3.2). One source of truth for the parser, the writer,
// tool docs and editor highlighting. Pure TypeScript: no fs, no dependencies.
//
//   observation  - [category] text #tags (provenance) ^f-<id>
//   relation     - rel_type [[Target(|alias)]] (context)? (provenance)? ^r-<id>     ("multi word" quoted)
//   bare link    - [[Target]]                                                         (links_to)
//   history      - [superseded] text (by ^f-<id>; provenance) ^f-<id>
//                - [invalidated] rel [[X]] (reason: why; provenance) ^r-<id>
//   provenance   (actor[ via suggestion sg-x][ run#N| session#S], YYYY-MM-DD)

import { BLOCK_ID_RE } from './ids'

// --- vocabulary

export const NOTE_TYPES = [
  'company',
  'person',
  'customer',
  'offer',
  'product',
  'brand',
  'repo',
  'decision',
  'convention',
  'gotcha',
  'process',
  'meeting',
  'concept',
  'component',
  'file',
  'department',
  'taste',
  'note'
] as const
export type NoteType = (typeof NOTE_TYPES)[number]

/** Default folder per type. Folders are cosmetic; `type:` is authoritative. '' = vault root. */
export const TYPE_FOLDER: Record<NoteType, string> = {
  company: '',
  person: 'People',
  customer: 'Customers',
  offer: 'Offers',
  product: 'Products',
  brand: 'Brand',
  repo: 'Repos',
  decision: 'Decisions',
  convention: 'Conventions',
  gotcha: 'Gotchas',
  process: 'Processes',
  meeting: 'Meetings',
  concept: 'Concepts',
  component: 'Components',
  file: 'Files',
  department: 'Departments',
  taste: '',
  note: 'Inbox'
}

export function isNoteType(s: string): s is NoteType {
  return (NOTE_TYPES as readonly string[]).includes(s)
}

/** Unknown or missing types index as `note`. */
export function normalizeNoteType(s: unknown): NoteType {
  const t = typeof s === 'string' ? s.trim().toLowerCase() : ''
  return isNoteType(t) ? t : 'note'
}

/**
 * Taste (Open Passport SPEC.md §4.6): what the company's people like, with evidence and a reinforcement count, e.g.
 * `- [likes] Plain, short copy (x3; example: [[Launch email v2]]) (user, 2026-10-12) ^f-…`. On the `Taste.md` note
 * (`type: taste`) or the card it is company taste; on a department note, that department's. It ranks first in the
 * company card and the department slot.
 */
export const TASTE_CATEGORIES = ['likes', 'dislikes', 'prefers', 'avoid'] as const
export type TasteCategory = (typeof TASTE_CATEGORIES)[number]
export function isTasteCategory(c: string): c is TasteCategory {
  return (TASTE_CATEGORIES as readonly string[]).includes(c.trim().toLowerCase())
}

export interface TasteText {
  statement: string
  /** `[[Note]]` links and `"quotes"`, as written */
  examples: string[]
  /** reinforcements; 1 when absent */
  count: number
  /** trailing ` #tags`, kept as written */
  tags: string
}

const TASTE_META_RE = /\s\((?:x(\d+)(?:;\s*|$))?(?:example:\s*(.*?))?\)$/

/** Splits a taste line's text: `statement (x3; example: [[A]]; "q") #tags` (Open Passport SPEC.md §4.6). */
export function parseTasteText(text: string): TasteText {
  let core = text
  const tags = /(\s+#[A-Za-z0-9_/-]+)+$/.exec(core)
  if (tags) core = core.slice(0, tags.index)
  let count = 1
  let examples: string[] = []
  const m = TASTE_META_RE.exec(core)
  if (m && (m[1] || m[2] !== undefined)) {
    count = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1
    examples = (m[2] ?? '').split(/;\s*/).map((e) => e.trim()).filter(Boolean)
    core = core.slice(0, m.index)
  }
  return { statement: core.trim(), examples, count, tags: tags ? tags[0] : '' }
}

export function formatTasteText(t: Pick<TasteText, 'statement' | 'examples' | 'count'> & { tags?: string }): string {
  const meta: string[] = []
  if (t.count > 1) meta.push(`x${t.count}`)
  if (t.examples.length) meta.push(`example: ${t.examples.join('; ')}`)
  return `${t.statement.replace(/\s+/g, ' ').trim()}${meta.length ? ` (${meta.join('; ')})` : ''}${t.tags ?? ''}`
}

/** A taste example: a `[[link]]` as is, anything else as a short quote without `"`, `(` or `)`. */
export function tasteExample(example: string): string {
  const e = example.trim()
  if (/^\[\[[^[\]]+\]\]$/.test(e)) return e
  const q = e.replace(/"/g, "'").replace(/[()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `"${q.length > 160 ? `${q.slice(0, 159)}…` : q}"`
}

/** v1 kinds; they drive brief ranking. */
export const FACT_KINDS = ['fact', 'decision', 'convention', 'gotcha'] as const
export type FactKind = (typeof FACT_KINDS)[number] | 'other'
export const EXTENDED_CATEGORIES = [
  'role',
  'price',
  'metric',
  'question',
  'todo',
  'mission',
  'audience',
  'brand',
  'product',
  'goal',
  'context',
  'constraint',
  ...TASTE_CATEGORIES
] as const
/** Category given to a tagged bullet without `[category]`. */
export const DEFAULT_CATEGORY = 'note'

export function categoryKind(category: string): FactKind {
  const c = category.trim().toLowerCase()
  return (FACT_KINDS as readonly string[]).includes(c) ? (c as FactKind) : 'other'
}

export const ACTORS = ['user', 'claude', 'codex', 'gemini', 'cursor', 'migration', 'suggestion'] as const
export type Actor = (typeof ACTORS)[number]

export const SECTIONS = { observations: 'Observations', relations: 'Relations', history: 'History' } as const
export type SectionKey = keyof typeof SECTIONS
/** Canonical order the writer keeps when it creates section headings. */
export const SECTION_ORDER: SectionKey[] = ['observations', 'relations', 'history']

export const HISTORY_STATES = ['superseded', 'invalidated'] as const
export type HistoryState = (typeof HISTORY_STATES)[number]

export const PIN_TAG = 'pin'

/** Implicit relation for prose links and bare bullets. */
export const LINKS_TO = 'links_to'

// --- line model (byte preserving)

export type Eol = '\n' | '\r\n'

/** Lines without their terminators plus the exact terminator of each ('' only on a last line without newline). */
export interface Lines {
  lines: string[]
  eols: string[]
}

export function splitLines(text: string): Lines {
  const lines: string[] = []
  const eols: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) {
      const cr = i > start && text.charCodeAt(i - 1) === 13
      lines.push(text.slice(start, cr ? i - 1 : i))
      eols.push(cr ? '\r\n' : '\n')
      start = i + 1
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start))
    eols.push('')
  }
  return { lines, eols }
}

export function joinLines(l: Lines): string {
  let out = ''
  for (let i = 0; i < l.lines.length; i++) out += l.lines[i] + l.eols[i]
  return out
}

/** Terminator for new lines: the first one in the file, LF when there is none. */
export function eolOfLines(l: Lines): Eol {
  return (l.eols.find((e) => e !== '') as Eol | undefined) ?? '\n'
}

/**
 * Inserts lines before `index` (`index >= length` appends). Appending to a file without a trailing
 * newline keeps it without one: the old last line gains a terminator and the new last line has none.
 */
export function insertLines(l: Lines, index: number, newLines: string[], eol: string = eolOfLines(l)): void {
  if (newLines.length === 0) return
  const atEnd = index >= l.lines.length
  const missingFinal = atEnd && l.lines.length > 0 && l.eols[l.lines.length - 1] === ''
  if (missingFinal) l.eols[l.lines.length - 1] = eol
  l.lines.splice(index, 0, ...newLines)
  l.eols.splice(index, 0, ...newLines.map((_, i) => (missingFinal && i === newLines.length - 1 ? '' : eol)))
}

/** Removes `count` lines at `index`; removing the unterminated last line moves that state up. */
export function removeLines(l: Lines, index: number, count = 1): void {
  const end = Math.min(index + count, l.lines.length)
  if (end <= index) return
  const removedLastUnterminated = end === l.lines.length && l.eols[end - 1] === ''
  l.lines.splice(index, end - index)
  l.eols.splice(index, end - index)
  if (removedLastUnterminated && l.lines.length > 0) l.eols[l.lines.length - 1] = ''
}

/** The file's dominant terminator (first one seen); LF for files without any. */
export function detectEol(text: string): Eol {
  const i = text.indexOf('\n')
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'
}

// --- code masking

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
/** A `%%` line opening an Obsidian comment block (closed by a line ending in `%%`). */
const COMMENT_FENCE_RE = /^\s*%%(?!.*%%)/

/**
 * Per-line "in code" flags for fenced blocks (``` / ~~~, closed by an equal-or-longer fence of the same
 * char; an unclosed fence runs to EOF) and `%%` comment blocks. Fence lines themselves count as code.
 */
export function fencedCodeLines(lines: string[], from = 0): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false)
  let fence: string | null = null
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      flags[i] = true
      if (fence === '%%') {
        if (/%%\s*$/.test(line)) fence = null
        continue
      }
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      continue
    }
    const m = FENCE_OPEN_RE.exec(line)
    if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      fence = m[1]
      flags[i] = true
    } else if (COMMENT_FENCE_RE.test(line)) {
      fence = '%%'
      flags[i] = true
    }
  }
  return flags
}

/**
 * Replaces inline code spans and `%%comments%%` with `fill` (same length), so offsets stay valid for
 * scanning. The default fill is a space; the bullet parser uses a non-space fill so trimming never eats
 * a trailing code span.
 */
export function maskInlineCode(line: string, fill = ' '): string {
  if (!line.includes('`') && !line.includes('%%')) return line
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] === '%' && line[i + 1] === '%') {
      const close = line.indexOf('%%', i + 2)
      if (close >= 0) {
        out += fill.repeat(close + 2 - i)
        i = close + 2
        continue
      }
    }
    if (line[i] !== '`') {
      out += line[i++]
      continue
    }
    let n = 0
    while (line[i + n] === '`') n++
    const run = '`'.repeat(n)
    let j = i + n
    let close = -1
    while (j < line.length) {
      const k = line.indexOf(run, j)
      if (k < 0) break
      if (line[k + n] !== '`' && line[k - 1] !== '`') {
        close = k
        break
      }
      j = k + 1
      while (line[j] === '`') j++
    }
    if (close < 0) {
      out += line.slice(i, i + n)
      i += n
      continue
    }
    out += fill.repeat(close + n - i)
    i = close + n
  }
  return out
}

/** Replaces each `[start, end)` range with spaces. */
export function maskRanges(line: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return line
  const chars = line.split('')
  for (const r of ranges) for (let i = r.start; i < r.end && i < chars.length; i++) chars[i] = ' '
  return chars.join('')
}

// --- wikilinks

export interface WikiLink {
  /** Offsets in the line, covering `![[…]]` / `[[…]]` (or the whole markdown link). */
  start: number
  end: number
  /** Raw target as written (no heading, block or display), trimmed. '' for self links `[[#H]]`. */
  target: string
  heading: string | null
  block: string | null
  display: string | null
  embed: boolean
  /** Target names a non-markdown file (`![[logo.png]]`). */
  attachment: boolean
  /** `[text](Note.md)` rather than `[[…]]`. */
  markdown: boolean
}

const WIKILINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g

/** Splits the inside of `[[…]]` into target / heading / block / display (`\|` in tables counts as `|`). */
export function parseLinkInner(inner: string): Pick<WikiLink, 'target' | 'heading' | 'block' | 'display'> {
  let display: string | null = null
  const pipe = inner.search(/\\?\|/)
  let head = inner
  if (pipe >= 0) {
    const sepLen = inner[pipe] === '\\' ? 2 : 1
    display = inner.slice(pipe + sepLen).trim()
    head = inner.slice(0, pipe)
  }
  let heading: string | null = null
  let block: string | null = null
  const hash = head.indexOf('#')
  let target = head
  if (hash >= 0) {
    target = head.slice(0, hash)
    const frag = head.slice(hash + 1).trim()
    if (frag.startsWith('^')) block = frag.slice(1)
    else heading = frag
  }
  return { target: target.trim(), heading, block, display: display === '' ? null : display }
}

const NOTE_EXT_RE = /\.md$/i
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/

function isAttachmentTarget(target: string): boolean {
  return !NOTE_EXT_RE.test(target) && FILE_EXT_RE.test(target) && !/\s/.test(target.slice(target.lastIndexOf('.')))
}

/**
 * Wikilinks and markdown links to notes in one line. Pass a line already masked for inline code (or set
 * `maskCode`). Markdown links count only for relative `.md` targets.
 */
export function scanLinks(line: string, opts: { maskCode?: boolean } = {}): WikiLink[] {
  const src = opts.maskCode === false ? line : maskInlineCode(line)
  const out: WikiLink[] = []
  for (const m of src.matchAll(WIKILINK_RE)) {
    const parts = parseLinkInner(m[2])
    out.push({
      start: m.index!,
      end: m.index! + m[0].length,
      ...parts,
      embed: m[1] === '!',
      attachment: isAttachmentTarget(parts.target),
      markdown: false
    })
  }
  if (src.includes('](')) {
    const masked = maskRanges(src, out)
    for (const m of masked.matchAll(MD_LINK_RE)) {
      let href = m[3]
      if (href.startsWith('<')) href = href.slice(1, -1)
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue
      let decoded = href
      try {
        decoded = decodeURIComponent(href)
      } catch {
        /* keep raw */
      }
      const hash = decoded.indexOf('#')
      const path = hash >= 0 ? decoded.slice(0, hash) : decoded
      const frag = hash >= 0 ? decoded.slice(hash + 1) : null
      if (!NOTE_EXT_RE.test(path)) continue
      out.push({
        start: m.index!,
        end: m.index! + m[0].length,
        target: path.replace(/^\.\//, '').replace(NOTE_EXT_RE, '').trim(),
        heading: frag && !frag.startsWith('^') ? frag : null,
        block: frag && frag.startsWith('^') ? frag.slice(1) : null,
        display: m[2] || null,
        embed: m[1] === '!',
        attachment: false,
        markdown: true
      })
    }
    out.sort((a, b) => a.start - b.start)
  }
  return out
}

/** Renders a wikilink. */
export function formatWikiLink(
  l: { target: string; heading?: string | null; block?: string | null; display?: string | null; embed?: boolean }
): string {
  let inner = l.target
  if (l.block) inner += `#^${l.block}`
  else if (l.heading) inner += `#${l.heading}`
  if (l.display && l.display !== l.target) inner += `|${l.display}`
  return `${l.embed ? '!' : ''}[[${inner}]]`
}

// --- tags

export interface TagHit {
  start: number
  end: number
  /** As written, without `#`. */
  tag: string
  /** Lowercased. */
  norm: string
}

const TAG_RE = /(^|[\s(,;])#([A-Za-z0-9_/-]+)/g

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').replace(/\/+$/, '').toLowerCase()
}

export function isValidTag(tag: string): boolean {
  return /^[A-Za-z0-9_/-]+$/.test(tag) && /[^0-9]/.test(tag) && !/^[/-]/.test(tag)
}

/** `#tags` in a line; mask code first (or let it). Links are skipped. Heading markers never match. */
export function scanTags(line: string, opts: { maskCode?: boolean } = {}): TagHit[] {
  let src = opts.maskCode === false ? line : maskInlineCode(line)
  if (src.includes('[')) {
    src = maskRanges(src, scanLinks(src, { maskCode: false }))
    if (src.includes('](')) src = src.replace(MD_LINK_RE, (m) => ' '.repeat(m.length))
  }
  if (src.includes('://')) src = src.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (u) => ' '.repeat(u.length))
  const out: TagHit[] = []
  for (const m of src.matchAll(TAG_RE)) {
    const tag = m[2].replace(/\/+$/, '')
    if (!isValidTag(tag)) continue
    const start = m.index! + m[1].length
    out.push({ start, end: start + 1 + tag.length, tag, norm: tag.toLowerCase() })
  }
  return out
}

/** Nested tags match by prefix: `#a` matches `a` and `a/b`. */
export function tagMatches(query: string, tag: string): boolean {
  const q = normalizeTag(query)
  const t = normalizeTag(tag)
  return t === q || t.startsWith(`${q}/`)
}

// --- headings

export interface Heading {
  level: number
  text: string
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/

export function parseHeading(line: string): Heading | null {
  const m = HEADING_RE.exec(line)
  if (!m) return null
  const text = (m[2] ?? '').replace(/[ \t]+#+$/, '').trim()
  return { level: m[1].length, text }
}

/** Which writer section a level-1/2 heading opens, if any. */
export function sectionOfHeading(h: Heading): SectionKey | null {
  if (h.level !== 2) return null
  const t = h.text.toLowerCase()
  for (const key of SECTION_ORDER) if (SECTIONS[key].toLowerCase() === t) return key
  return null
}

// --- provenance

export interface Provenance {
  actor: Actor
  /** Suggestion id for `user via suggestion sg-x`. */
  via: string | null
  runId: string | null
  sessionId: string | null
  date: string | null
}

const ACTOR_ALT = ACTORS.join('|')
const PROV_BODY = `(${ACTOR_ALT})(?: via suggestion ([A-Za-z0-9_-]+))?(?: run#([A-Za-z0-9_-]+))?(?: session#([A-Za-z0-9_-]+))?, (\\d{4}-\\d{2}-\\d{2})`
const PROV_BODY_RE = new RegExp(`^${PROV_BODY}$`)
const PROV_TAIL_RE = new RegExp(`\\s\\(${PROV_BODY}\\)$`)

function provFromMatch(m: RegExpExecArray, at: number): Provenance {
  return {
    actor: m[at] as Actor,
    via: m[at + 1] ?? null,
    runId: m[at + 2] ?? null,
    sessionId: m[at + 3] ?? null,
    date: m[at + 4]
  }
}

/** Parses the inside of a provenance parenthetical, e.g. `claude run#183, 2026-10-12`. */
export function parseProvenance(s: string): Provenance | null {
  const m = PROV_BODY_RE.exec(s.trim())
  return m ? provFromMatch(m, 1) : null
}

export function formatProvenanceBody(p: Partial<Provenance> & { actor: Actor; date: string }): string {
  let s: string = p.actor
  if (p.via) s += ` via suggestion ${p.via}`
  if (p.runId) s += ` run#${p.runId}`
  else if (p.sessionId) s += ` session#${p.sessionId}`
  return `${s}, ${p.date}`
}

export function formatProvenance(p: Partial<Provenance> & { actor: Actor; date: string }): string {
  return `(${formatProvenanceBody(p)})`
}

/** A missing tail defaults to the user; the indexer fills the date from the file mtime. */
export function defaultProvenance(date: string | null = null): Provenance {
  return { actor: 'user', via: null, runId: null, sessionId: null, date }
}

// --- bullet lines

export interface Span {
  start: number
  end: number
}

interface BulletBase {
  /** Principia block id (`f-…`/`r-…`, no caret) or null. */
  blockId: string | null
  /** Any trailing `^anchor` (Principia or not), without caret. */
  anchor: string | null
  /** Parsed tail or null when absent. */
  prov: Provenance | null
  spans: {
    marker: Span
    category?: Span
    rel?: Span
    prov?: Span
    anchor?: Span
    detail?: Span
  }
}

export interface ObservationLine extends BulletBase {
  kind: 'observation'
  category: string
  /** Text between the category and the provenance, tags included. */
  text: string
  textSpan: Span
  /** True when the category was implied (tagged bullet without `[category]`). */
  implicitCategory: boolean
}

export interface RelationLine extends BulletBase {
  kind: 'relation'
  /** As written (quotes removed). */
  rel: string
  link: WikiLink
  context: string | null
}

export interface BareLinkLine extends BulletBase {
  kind: 'bare_link'
  link: WikiLink
}

export interface HistoryLine extends BulletBase {
  kind: 'history'
  state: HistoryState
  /** The moved content: an observation text or a relation core (`rel [[X]] (context)`). */
  text: string
  textSpan: Span
  /** `by ^f-x` on superseded lines. */
  supersededBy: string | null
  reason: string | null
  /** Set when the moved content is a relation. */
  relation: { rel: string; link: WikiLink; context: string | null } | null
}

export type BulletLine = ObservationLine | RelationLine | BareLinkLine | HistoryLine

const BULLET_RE = /^(\s*[-*+][ \t]+)/
/** Mask fill for code inside bullets: not whitespace, not a grammar character. */
const CODE_FILL = '\u0001'
const ANCHOR_TAIL_RE = /\s\^([A-Za-z0-9-]+)\s*$/
const TASK_RE = /^\s*[-*+][ \t]+\[.\](?:\s|$)/
const CATEGORY_RE = /^\[([^[\]()]{2,}?)\](?=[ \t]+\S)/
const REL_TYPE_RE = /^("([^"\n]+)"|[A-Za-z][A-Za-z0-9_-]*)[ \t]+(?=!?\[\[)/
const PAREN_TAIL_RE = /\s\(([^()]*)\)$/
const HISTORY_BY_RE = /^by \^([fr]-[0-9a-z]{10})$/

/**
 * Splits a History detail `by ^f-x[; prov]` / `reason: why[; prov]`. The provenance is the part after
 * the LAST `; ` that parses as one, so a reason may itself contain `; `.
 */
function parseHistoryDetail(
  detail: string
): { supersededBy: string | null; reason: string | null; prov: Provenance | null } | null {
  let head = detail
  let prov: Provenance | null = null
  const cut = detail.lastIndexOf('; ')
  if (cut >= 0) {
    const p = parseProvenance(detail.slice(cut + 2))
    if (p) {
      prov = p
      head = detail.slice(0, cut)
    }
  }
  const by = HISTORY_BY_RE.exec(head)
  if (by) return { supersededBy: by[1], reason: null, prov }
  if (head.startsWith('reason: ')) return { supersededBy: null, reason: head.slice(8).trim(), prov }
  return null
}

/** A task checkbox (`- [ ]`, `- [x]`, any single char), never an observation. */
export function isTaskLine(line: string): boolean {
  return TASK_RE.test(line)
}

function stripTail(
  body: string,
  bodyStart: number
): { core: string; anchor: string | null; anchorSpan?: Span; prov: Provenance | null; provSpan?: Span } {
  let core = body
  let anchor: string | null = null
  let anchorSpan: Span | undefined
  const a = ANCHOR_TAIL_RE.exec(core)
  if (a) {
    anchor = a[1]
    anchorSpan = { start: bodyStart + a.index + 1, end: bodyStart + a.index + 2 + a[1].length }
    core = core.slice(0, a.index)
  }
  core = core.replace(/\s+$/, '')
  let prov: Provenance | null = null
  let provSpan: Span | undefined
  const p = PROV_TAIL_RE.exec(core)
  if (p) {
    prov = provFromMatch(p, 1)
    provSpan = { start: bodyStart + p.index + 1, end: bodyStart + core.length }
    core = core.slice(0, p.index).replace(/\s+$/, '')
  }
  return { core, anchor, anchorSpan, prov, provSpan }
}

function relationOf(
  core: string,
  coreStart: number
): { rel: string; relSpan: Span; link: WikiLink; context: string | null } | null {
  const r = REL_TYPE_RE.exec(core)
  if (!r) return null
  const rest = core.slice(r[0].length)
  const lm = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(rest)
  if (!lm) return null
  const after = rest.slice(lm[0].length)
  let context: string | null = null
  if (after.trim() !== '') {
    const c = /^\s+\(([^()]*)\)\s*$/.exec(after)
    if (!c) return null
    context = c[1].trim()
  }
  const parts = parseLinkInner(lm[2])
  const linkStart = coreStart + r[0].length
  return {
    rel: r[2] ?? r[1],
    relSpan: { start: coreStart, end: coreStart + r[1].length },
    link: {
      start: linkStart,
      end: linkStart + lm[0].length,
      ...parts,
      embed: lm[1] === '!',
      attachment: isAttachmentTarget(parts.target),
      markdown: false
    },
    context
  }
}

/**
 * Classifies one line (already known to be outside code and frontmatter). `inHistory` makes
 * `[superseded]`/`[invalidated]` bullets history lines. Returns null for prose and non-fact bullets.
 */
export function parseBulletLine(line: string, inHistory = false): BulletLine | null {
  const bm = BULLET_RE.exec(line)
  if (!bm || isTaskLine(line)) return null
  const markerSpan: Span = { start: 0, end: bm[1].length }
  const bodyStart = bm[1].length
  const masked = maskInlineCode(line, CODE_FILL)
  const body = masked.slice(bodyStart)
  // `- [text](url)` is a link item, never an observation.
  if (/^!?\[[^\]]*\]\(/.test(body)) return null
  const { core: maskedCore, anchor, anchorSpan, prov, provSpan } = stripTail(body, bodyStart)
  const core = line.slice(bodyStart, bodyStart + maskedCore.length)
  const blockId = anchor && BLOCK_ID_RE.test(anchor) ? anchor : null
  const base = { blockId, anchor, prov }
  const spans: BulletBase['spans'] = { marker: markerSpan }
  if (anchorSpan) spans.anchor = anchorSpan
  if (provSpan) spans.prov = provSpan

  const cat = CATEGORY_RE.exec(maskedCore)
  if (cat) {
    const category = cat[1].trim()
    spans.category = { start: bodyStart, end: bodyStart + cat[0].length }
    const textOffset = cat[0].length + (/^[ \t]+/.exec(maskedCore.slice(cat[0].length))?.[0].length ?? 0)
    const text = core.slice(textOffset)
    const textSpan = { start: bodyStart + textOffset, end: bodyStart + core.length }
    const state = category.toLowerCase()
    if (inHistory && (HISTORY_STATES as readonly string[]).includes(state)) {
      return parseHistoryRest(state as HistoryState, text, textSpan, base, spans)
    }
    return { kind: 'observation', category, text, textSpan, implicitCategory: false, ...base, spans }
  }

  const rel = relationOf(maskedCore, bodyStart)
  if (rel) {
    spans.rel = rel.relSpan
    const context = rel.context === null ? null : coreContext(core)
    return { kind: 'relation', rel: rel.rel, link: rel.link, context, ...base, spans }
  }

  const bare = /^(!?)\[\[([^[\]\n]+?)\]\]$/.exec(maskedCore)
  if (bare) {
    const parts = parseLinkInner(bare[2])
    return {
      kind: 'bare_link',
      link: {
        start: bodyStart,
        end: bodyStart + bare[0].length,
        ...parts,
        embed: bare[1] === '!',
        attachment: isAttachmentTarget(parts.target),
        markdown: false
      },
      ...base,
      spans
    }
  }

  if (scanTags(maskedCore, { maskCode: false }).length > 0) {
    return {
      kind: 'observation',
      category: DEFAULT_CATEGORY,
      text: core,
      textSpan: { start: bodyStart, end: bodyStart + core.length },
      implicitCategory: true,
      ...base,
      spans
    }
  }
  return null
}

/** Unmasked context text (the masked copy blanks inline code). */
function coreContext(core: string): string | null {
  const c = PAREN_TAIL_RE.exec(core)
  return c ? c[1].trim() : null
}

function parseHistoryRest(
  state: HistoryState,
  rest: string,
  restSpan: Span,
  base: { blockId: string | null; anchor: string | null; prov: Provenance | null },
  spans: BulletBase['spans']
): HistoryLine {
  let text = rest
  let prov = base.prov
  let supersededBy: string | null = null
  let reason: string | null = null
  const d = PAREN_TAIL_RE.exec(text)
  if (d) {
    const dm = parseHistoryDetail(d[1])
    if (dm) {
      supersededBy = dm.supersededBy
      reason = dm.reason
      if (dm.prov) prov = dm.prov
      spans.detail = { start: restSpan.start + d.index + 1, end: restSpan.start + text.length }
      text = text.slice(0, d.index).replace(/\s+$/, '')
    }
  }
  const textSpan = { start: restSpan.start, end: restSpan.start + text.length }
  let relation: HistoryLine['relation'] = null
  const r = base.blockId?.startsWith('f-') ? null : relationOf(maskInlineCode(text, CODE_FILL), textSpan.start)
  if (r) relation = { rel: r.rel, link: r.link, context: r.context === null ? null : coreContext(text) }
  return { kind: 'history', state, text, textSpan, supersededBy, reason, relation, ...base, prov, spans }
}

// --- formatting (what the writer emits)

/** Quotes a relation type that is not a single snake/kebab word. */
export function formatRelType(rel: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(rel) ? rel : `"${rel.replace(/"/g, "'")}"`
}

/** Strips characters that would break the observation grammar out of a category. */
export function cleanCategory(category: string): string {
  const c = category.replace(/[[\]()]/g, '').replace(/\s+/g, ' ').trim()
  return c.length >= 2 ? c : DEFAULT_CATEGORY
}

/** Keeps a single line: newlines collapse to spaces, trailing `^anchor`-looking text is escaped. */
export function cleanLineText(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\s+$/, '')
    .replace(/(\s)\^([A-Za-z0-9-]+)$/, '$1\\^$2')
}

export interface ObservationInput {
  category: string
  text: string
  /** Extra tags (without `#`), appended when not already in the text. */
  tags?: string[]
  prov?: (Partial<Provenance> & { actor: Actor; date: string }) | null
  blockId?: string | null
  pinned?: boolean
}

export function formatObservation(o: ObservationInput): string {
  let text = cleanLineText(o.text.trim())
  const present = new Set(scanTags(text).map((t) => t.norm))
  const tags = [...(o.tags ?? []), ...(o.pinned ? [PIN_TAG] : [])]
  for (const t of tags) {
    const tag = t.replace(/^#/, '').trim()
    if (!isValidTag(tag) || present.has(tag.toLowerCase())) continue
    present.add(tag.toLowerCase())
    text += ` #${tag}`
  }
  let line = `- [${cleanCategory(o.category)}] ${text}`
  if (o.prov) line += ` ${formatProvenance(o.prov)}`
  if (o.blockId) line += ` ^${o.blockId}`
  return line
}

export interface RelationInput {
  rel: string
  target: string
  display?: string | null
  context?: string | null
  prov?: (Partial<Provenance> & { actor: Actor; date: string }) | null
  blockId?: string | null
}

export function formatRelationCore(r: { rel: string; target: string; display?: string | null; context?: string | null }): string {
  let line = `${formatRelType(r.rel)} ${formatWikiLink({ target: r.target, display: r.display ?? null })}`
  const ctx = r.context?.replace(/[()]/g, '').replace(/\s+/g, ' ').trim()
  if (ctx) line += ` (${ctx})`
  return line
}

export function formatRelation(r: RelationInput): string {
  let line = `- ${formatRelationCore(r)}`
  if (r.prov) line += ` ${formatProvenance(r.prov)}`
  if (r.blockId) line += ` ^${r.blockId}`
  return line
}

export interface HistoryInput {
  state: HistoryState
  /** Observation text or relation core. */
  text: string
  supersededBy?: string | null
  reason?: string | null
  prov?: (Partial<Provenance> & { actor: Actor; date: string }) | null
  blockId?: string | null
}

export function formatHistory(h: HistoryInput): string {
  const detail: string[] = []
  if (h.state === 'superseded' && h.supersededBy) detail.push(`by ^${h.supersededBy}`)
  if (h.state === 'invalidated' && h.reason) detail.push(`reason: ${h.reason.replace(/[()\r\n]/g, ' ').replace(/\s+/g, ' ').trim()}`)
  let line = `- [${h.state}] ${cleanLineText(h.text.trim())}`
  const provBody = h.prov ? formatProvenanceBody(h.prov) : null
  if (detail.length) line += ` (${detail.join('; ')}${provBody ? `; ${provBody}` : ''})`
  else if (provBody) line += ` (${provBody})`
  if (h.blockId) line += ` ^${h.blockId}`
  return line
}

/** Short grammar summary for tool descriptions and write rules. */
export const GRAMMAR_DOC = [
  'Notes are markdown with YAML frontmatter. Link notes as [[Exact Title]] (or [[Title|alias]]).',
  'Observation: - [category] text #tags (actor, YYYY-MM-DD) ^f-<id>',
  'Relation: - rel_type [[Target]] (context) ^r-<id>   (multi-word types are quoted: - "based on" [[X]])',
  'Cite a fact as [[Note#^f-<id>]]. Superseded and invalidated lines live under ## History.'
].join('\n')
