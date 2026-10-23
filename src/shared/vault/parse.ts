// Note parser (PASSPORT.md §3). Produces everything the indexer stores (note, aliases, facts, links,
// tags) plus line positions for the writer and editor. It never re-renders: `lines` keeps the exact
// bytes, so `serializeNote(parseNote(t)) === t` for every input. Pure, never throws.

import {
  type Eol,
  type FactKind,
  type HistoryState,
  type Lines,
  type NoteType,
  type Provenance,
  type Span,
  type WikiLink,
  LINKS_TO,
  PIN_TAG,
  type SectionKey,
  categoryKind,
  defaultProvenance,
  detectEol,
  fencedCodeLines,
  isValidTag,
  maskInlineCode,
  normalizeNoteType,
  normalizeTag,
  parseBulletLine,
  parseHeading,
  scanLinks,
  scanTags,
  sectionOfHeading,
  splitLines
} from './grammar'
import {
  type FmValue,
  type Frontmatter,
  findFrontmatterClose,
  fmBool,
  fmList,
  fmString,
  frontmatterData,
  linksInValue,
  parseFrontmatterLines
} from './frontmatter'
import { isNoteId, lineRowId, pathNoteKey } from './ids'
import { normalizeRelType } from './ontology'
import { pathStem } from './resolve'

export type FactStatus = 'active' | 'superseded' | 'invalid'
export type LinkOrigin = 'body' | 'relation' | 'property' | 'bullet' | 'fact'

export interface ParsedFact {
  /** 0-based file line. */
  line: number
  /** mem_fact id: `mfa_<x>` for Principia block ids, soft key `h:<sha1>` otherwise. */
  id: string
  blockId: string | null
  anchor: string | null
  section: 'obs' | 'history'
  status: FactStatus
  category: string
  kind: FactKind
  /** Fact text with tags, without category, provenance and block id. */
  text: string
  tags: string[]
  pinned: boolean
  prov: Provenance
  /** False when the line had no provenance tail (defaults applied). */
  provExplicit: boolean
  implicitCategory: boolean
  supersededBy: string | null
  reason: string | null
}

export interface ParsedRelation {
  line: number
  /** `mrel_<x>` or soft key. */
  id: string
  blockId: string | null
  anchor: string | null
  section: 'obs' | 'history'
  status: FactStatus
  /** As written (quotes removed). */
  rel: string
  normRel: string
  link: WikiLink
  context: string | null
  prov: Provenance
  provExplicit: boolean
  supersededBy: string | null
  reason: string | null
}

export interface ParsedLink {
  /** File line (frontmatter entry start line for property links). */
  line: number
  start: number
  end: number
  origin: LinkOrigin
  /** Normalized relation (`links_to` for prose, bullets and fact links; the key for properties). */
  rel: string
  target: string
  heading: string | null
  block: string | null
  display: string | null
  embed: boolean
  attachment: boolean
  markdown: boolean
  /** Fact or relation row id carrying this link. */
  factId: string | null
  relationId: string | null
  /** Frontmatter key for property links. */
  key: string | null
  /** Links on History lines are `invalid`. */
  status: 'active' | 'invalid'
}

export interface ParsedTag {
  tag: string
  norm: string
  origin: 'frontmatter' | 'body'
  line: number | null
  factId: string | null
}

export interface ParsedHeading {
  line: number
  level: number
  text: string
}

export interface ParsedNote {
  path: string
  eol: Eol
  /** Exact bytes as a line model. */
  lines: Lines
  frontmatter: Frontmatter | null
  data: Record<string, FmValue>
  /** First body line (after the closing fence). */
  bodyStart: number
  /** Frontmatter id when it is a valid `n-…` id. */
  id: string | null
  /** Index key: id, else `h:<path>`. */
  key: string
  title: string
  type: NoteType
  aliases: string[]
  status: 'active' | 'archived'
  pinned: boolean
  created: string | null
  modified: string | null
  source: string | null
  repoId: string | null
  h1: string | null
  summary: string
  headings: ParsedHeading[]
  /** Section of each line (`null` outside Observations/Relations/History or in frontmatter). */
  sections: Array<SectionKey | null>
  /** True for fenced-code lines. */
  code: boolean[]
  facts: ParsedFact[]
  relations: ParsedRelation[]
  links: ParsedLink[]
  tags: ParsedTag[]
  warnings: string[]
}

export interface ParseOptions {
  /** Vault-relative path with `.md`; feeds the title fallback and soft keys. */
  path?: string
  /** Date for lines without a provenance tail (the indexer passes the file mtime date). */
  defaultDate?: string | null
}

/** Keys that are never link-valued edges even when they contain `[[…]]`. */
const NON_EDGE_KEYS = new Set(['id', 'title', 'type', 'aliases', 'alias', 'tags', 'tag', 'status', 'created', 'modified', 'source', 'pinned', 'repo_id', 'cssclasses'])

const HISTORY_STATUS: Record<HistoryState, FactStatus> = { superseded: 'superseded', invalidated: 'invalid' }

export function parseNote(text: string, opts: ParseOptions = {}): ParsedNote {
  const path = opts.path ?? ''
  const lines = splitLines(text)
  const L = lines.lines
  const warnings: string[] = []
  const close = findFrontmatterClose(L)
  const frontmatter = close > 0 ? parseFrontmatterLines(L, close) : null
  if (frontmatter) warnings.push(...frontmatter.warnings)
  else if (L.length > 0 && L[0].replace('\uFEFF', '').trimEnd() === '---') warnings.push('frontmatter is not closed')
  const data = frontmatterData(frontmatter)
  const bodyStart = frontmatter ? frontmatter.close + 1 : 0

  const fmId = fmString(data.id)
  const id = fmId && isNoteId(fmId) ? fmId : null
  if (fmId && !id) warnings.push(`frontmatter id "${fmId}" is not a note id`)
  const aliases = [...fmList(data.aliases), ...fmList(data.alias)]
  const fmTags = [...fmList(data.tags, true), ...fmList(data.tag, true)].map((t) => t.replace(/^#/, ''))

  const code = fencedCodeLines(L, bodyStart)
  for (let i = 0; i < bodyStart; i++) code[i] = false
  if (code.length > 0 && code[code.length - 1] && !/^ {0,3}(`{3,}|~{3,})\s*$/.test(L[L.length - 1] ?? '')) {
    warnings.push('unclosed code fence')
  }

  const sections: Array<SectionKey | null> = new Array(L.length).fill(null)
  const headings: ParsedHeading[] = []
  const facts: ParsedFact[] = []
  const relations: ParsedRelation[] = []
  const links: ParsedLink[] = []
  const tags: ParsedTag[] = []
  const seenBlocks = new Set<string>()
  const defaultProv = defaultProvenance(opts.defaultDate ?? null)
  // Identical hand-written lines share a soft key; the nth repeat gets `:n` so row ids are unique.
  const rowIds = new Map<string, number>()
  const uniqueRowId = (rowId: string): string => {
    const n = (rowIds.get(rowId) ?? 0) + 1
    rowIds.set(rowId, n)
    return n === 1 ? rowId : `${rowId}:${n}`
  }

  for (const t of fmTags) {
    if (!isValidTag(t)) continue
    tags.push({ tag: t, norm: normalizeTag(t), origin: 'frontmatter', line: null, factId: null })
  }
  if (frontmatter) {
    for (const e of frontmatter.entries) {
      if (NON_EDGE_KEYS.has(e.key.toLowerCase())) continue
      for (const inner of linksInValue(e.value)) {
        const parsed = scanLinks(`[[${inner}]]`)[0]
        if (!parsed || !parsed.target) continue
        links.push({
          ...linkFields(parsed),
          line: e.start,
          start: 0,
          end: 0,
          origin: 'property',
          rel: normalizeRelType(e.key),
          factId: null,
          relationId: null,
          key: e.key,
          status: 'active'
        })
      }
    }
  }

  let section: SectionKey | null = null
  for (let i = bodyStart; i < L.length; i++) {
    if (code[i]) {
      sections[i] = section
      continue
    }
    const line = L[i]
    const heading = parseHeading(line)
    if (heading) {
      headings.push({ line: i, level: heading.level, text: heading.text })
      if (heading.level <= 2) section = sectionOfHeading(heading)
    }
    sections[i] = section
    const masked = maskInlineCode(line)
    const lineLinks = masked.includes('[') ? scanLinks(masked, { maskCode: false }) : []
    const lineTags = masked.includes('#') ? scanTags(masked, { maskCode: false }) : []
    const inHistory = section === 'history'
    const bullet = heading ? null : parseBulletLine(line, inHistory)
    const claimed = new Set<WikiLink>()
    let factId: string | null = null
    let factSpan: Span | null = null
    let linkStatus: 'active' | 'invalid' = 'active'

    if (bullet?.blockId) {
      // A copy-pasted line repeats its block id: the first occurrence owns it, later ones are keyed like
      // hand-written lines (anchor kept), so row ids stay unique and ops never target the copy.
      if (seenBlocks.has(bullet.blockId)) {
        warnings.push(`duplicate block id ^${bullet.blockId} on line ${i + 1}`)
        bullet.blockId = null
      } else seenBlocks.add(bullet.blockId)
    }

    const prov = bullet?.prov ?? defaultProv
    const provExplicit = !!bullet?.prov
    const histSection: 'obs' | 'history' = inHistory ? 'history' : 'obs'

    if (bullet?.kind === 'observation' || (bullet?.kind === 'history' && !bullet.relation)) {
      const rowId = uniqueRowId(lineRowId(bullet.blockId, path, line))
      const status: FactStatus = bullet.kind === 'history' ? HISTORY_STATUS[bullet.state] : inHistory ? 'superseded' : 'active'
      const span = bullet.textSpan
      const factTags = lineTags.filter((t) => t.start >= span.start && t.end <= span.end)
      const category = bullet.kind === 'history' ? bullet.state : bullet.category
      facts.push({
        line: i,
        id: rowId,
        blockId: bullet.blockId,
        anchor: bullet.anchor,
        section: histSection,
        status,
        category,
        kind: bullet.kind === 'history' ? 'other' : categoryKind(bullet.category),
        text: bullet.text,
        tags: factTags.map((t) => t.norm),
        pinned: status === 'active' && factTags.some((t) => t.norm === PIN_TAG),
        prov,
        provExplicit,
        implicitCategory: bullet.kind === 'observation' && bullet.implicitCategory,
        supersededBy: bullet.kind === 'history' ? bullet.supersededBy : null,
        reason: bullet.kind === 'history' ? bullet.reason : null
      })
      factId = rowId
      factSpan = span
      if (status !== 'active') linkStatus = 'invalid'
    } else if (bullet?.kind === 'relation' || (bullet?.kind === 'history' && bullet.relation)) {
      const rowId = uniqueRowId(lineRowId(bullet.blockId, path, line))
      const rel = bullet.kind === 'relation' ? bullet : bullet.relation!
      const status: FactStatus = bullet.kind === 'history' ? HISTORY_STATUS[bullet.state] : inHistory ? 'superseded' : 'active'
      relations.push({
        line: i,
        id: rowId,
        blockId: bullet.blockId,
        anchor: bullet.anchor,
        section: histSection,
        status,
        rel: rel.rel,
        normRel: normalizeRelType(rel.rel),
        link: rel.link,
        context: rel.context,
        prov,
        provExplicit,
        supersededBy: bullet.kind === 'history' ? bullet.supersededBy : null,
        reason: bullet.kind === 'history' ? bullet.reason : null
      })
      const own = lineLinks.find((l) => l.start === rel.link.start)
      if (own) claimed.add(own)
      if (rel.link.target) {
        links.push({
          ...linkFields(rel.link),
          line: i,
          origin: 'relation',
          rel: normalizeRelType(rel.rel),
          factId: null,
          relationId: rowId,
          key: null,
          status: status === 'active' ? 'active' : 'invalid'
        })
      }
      if (status !== 'active') linkStatus = 'invalid'
    } else if (bullet?.kind === 'bare_link') {
      const own = lineLinks.find((l) => l.start === bullet.link.start)
      if (own) claimed.add(own)
      if (bullet.link.target) {
        links.push({
          ...linkFields(bullet.link),
          line: i,
          origin: 'bullet',
          rel: LINKS_TO,
          factId: null,
          relationId: null,
          key: null,
          status: inHistory ? 'invalid' : 'active'
        })
      }
    }
    if (inHistory) linkStatus = 'invalid'

    for (const l of lineLinks) {
      if (claimed.has(l) || !l.target) continue
      const inFact = factSpan && l.start >= factSpan.start && l.end <= factSpan.end
      links.push({
        ...linkFields(l),
        line: i,
        origin: inFact ? 'fact' : 'body',
        rel: LINKS_TO,
        factId: inFact ? factId : null,
        relationId: null,
        key: null,
        status: linkStatus
      })
    }
    for (const t of lineTags) {
      const inFact = factSpan && t.start >= factSpan.start && t.end <= factSpan.end
      tags.push({ tag: t.tag, norm: t.norm, origin: 'body', line: i, factId: inFact ? factId : null })
    }
  }

  const h1 = headings.find((h) => h.level === 1)?.text ?? null
  const fmTitle = fmString(data.title)?.trim()
  const title = fmTitle || (path ? pathStem(path) : '') || h1 || ''
  const fmStatus = fmString(data.status)?.trim().toLowerCase()

  return {
    path,
    eol: detectEol(text),
    lines,
    frontmatter,
    data,
    bodyStart,
    id,
    key: id ?? pathNoteKey(path),
    title,
    type: normalizeNoteType(fmString(data.type)),
    aliases: [...new Set(aliases)],
    status: fmStatus === 'archived' ? 'archived' : 'active',
    pinned: fmBool(data.pinned),
    created: fmString(data.created),
    modified: fmString(data.modified),
    source: fmString(data.source),
    repoId: fmString(data.repo_id),
    h1,
    summary: summaryOf(L, code, bodyStart),
    headings,
    sections,
    code,
    facts,
    relations,
    links,
    tags,
    warnings
  }
}

function linkFields(l: WikiLink): Pick<ParsedLink, 'start' | 'end' | 'target' | 'heading' | 'block' | 'display' | 'embed' | 'attachment' | 'markdown'> {
  return {
    start: l.start,
    end: l.end,
    target: l.target,
    heading: l.heading,
    block: l.block,
    display: l.display,
    embed: l.embed,
    attachment: l.attachment,
    markdown: l.markdown
  }
}

/** First prose paragraph after the H1 (or at the top of the body); '' when it is a list or heading. */
function summaryOf(L: string[], code: boolean[], bodyStart: number): string {
  let i = bodyStart
  while (i < L.length && L[i].trim() === '') i++
  if (i < L.length && !code[i] && parseHeading(L[i])?.level === 1) {
    i++
    while (i < L.length && L[i].trim() === '') i++
  }
  const out: string[] = []
  for (; i < L.length; i++) {
    const line = L[i]
    if (line.trim() === '' || code[i] || parseHeading(line)) break
    if (/^\s*([-*+]|\d+\.)\s|^\s*>|^\s*\|/.test(line)) break
    out.push(line.trim())
  }
  return out.join(' ')
}

// --- lookups the writer and tools share

export function findBlock(note: ParsedNote, blockId: string): ParsedFact | ParsedRelation | undefined {
  const id = blockId.replace(/^\^/, '')
  return note.facts.find((f) => f.blockId === id) ?? note.relations.find((r) => r.blockId === id)
}

export function lineItem(note: ParsedNote, line: number): ParsedFact | ParsedRelation | undefined {
  return note.facts.find((f) => f.line === line) ?? note.relations.find((r) => r.line === line)
}

/** Fact or relation by row id (`mfa_x`, `mrel_x` or a soft key). */
export function findRow(note: ParsedNote, rowId: string): ParsedFact | ParsedRelation | undefined {
  return note.facts.find((f) => f.id === rowId) ?? note.relations.find((r) => r.id === rowId)
}

// --- editor highlighting

export type HighlightKind = 'frontmatter' | 'code' | 'heading' | 'link' | 'embed' | 'tag' | 'category' | 'rel' | 'prov' | 'block' | 'history'

export interface HighlightToken {
  line: number
  start: number
  end: number
  kind: HighlightKind
}

/** Tokens for the source-mode tint, from the same grammar the indexer uses. */
export function highlightNote(text: string): HighlightToken[] {
  const note = parseNote(text)
  const L = note.lines.lines
  const out: HighlightToken[] = []
  for (let i = 0; i < note.bodyStart; i++) out.push({ line: i, start: 0, end: L[i].length, kind: 'frontmatter' })
  for (let i = note.bodyStart; i < L.length; i++) {
    const line = L[i]
    if (note.code[i]) {
      out.push({ line: i, start: 0, end: line.length, kind: 'code' })
      continue
    }
    const masked = maskInlineCode(line)
    for (let j = 0; j < line.length; ) {
      if (masked[j] !== line[j]) {
        let k = j
        while (k < line.length && masked[k] !== line[k]) k++
        out.push({ line: i, start: j, end: k, kind: 'code' })
        j = k
      } else j++
    }
    if (parseHeading(line)) out.push({ line: i, start: 0, end: line.length, kind: 'heading' })
    const bullet = parseBulletLine(line, note.sections[i] === 'history')
    if (bullet) {
      const s = bullet.spans
      if (s.category) out.push({ line: i, start: s.category.start, end: s.category.end, kind: bullet.kind === 'history' ? 'history' : 'category' })
      if (s.rel) out.push({ line: i, start: s.rel.start, end: s.rel.end, kind: 'rel' })
      if (s.prov) out.push({ line: i, start: s.prov.start, end: s.prov.end, kind: 'prov' })
      if (s.detail) out.push({ line: i, start: s.detail.start, end: s.detail.end, kind: 'prov' })
      if (s.anchor) out.push({ line: i, start: s.anchor.start, end: s.anchor.end, kind: 'block' })
    }
    for (const l of scanLinks(masked, { maskCode: false })) out.push({ line: i, start: l.start, end: l.end, kind: l.embed ? 'embed' : 'link' })
    for (const t of scanTags(masked, { maskCode: false })) out.push({ line: i, start: t.start, end: t.end, kind: 'tag' })
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start)
}
