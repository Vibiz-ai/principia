// Line-splice patch ops (PASSPORT.md §6.4 step 3, §6.5). Every op reads text and returns new text in
// which only the intended lines changed: insert under a section (creating the heading if missing),
// move a line to History, set a frontmatter key, rewrite links, wrap a mention, stamp an id.
// Untouched lines keep their exact bytes and terminators. Ops never guess: a block id that is gone
// throws `PatchError('block_not_found')`, which the writer turns into a conflict.

import { type FmValue, FrontmatterError, fmList, setFrontmatterValue } from './frontmatter'
import {
  type Actor,
  type HistoryState,
  type Lines,
  type ObservationInput,
  type Provenance,
  type RelationInput,
  type SectionKey,
  type WikiLink,
  SECTIONS,
  SECTION_ORDER,
  formatHistory,
  formatObservation,
  formatProvenance,
  formatRelation,
  formatTasteText,
  formatWikiLink,
  insertLines,
  joinLines,
  maskInlineCode,
  parseBulletLine,
  parseTasteText,
  removeLines,
  scanLinks,
  splitLines
} from './grammar'
import { isBlockId, isNoteId, newBlockId } from './ids'
import { type ParsedFact, type ParsedNote, type ParsedRelation, findBlock, lineItem, parseNote } from './parse'
import { normName } from './resolve'

export type PatchErrorCode =
  | 'block_not_found'
  | 'already_history'
  | 'not_history'
  | 'not_a_fact'
  | 'bad_line'
  | 'bad_span'
  | 'has_anchor'
  | 'frontmatter'
  | 'empty_text'

export class PatchError extends Error {
  constructor(
    readonly code: PatchErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PatchError'
  }
}

export type ProvInput = Partial<Provenance> & { actor: Actor; date: string }

export interface PatchResult {
  text: string
  /** 0-based line of the written/moved line in the new text, when there is one. */
  line?: number
  blockId?: string
  /** False when the op was a no-op (text unchanged). */
  changed: boolean
}

function result(before: string, l: Lines, extra: Omit<PatchResult, 'text' | 'changed'> = {}): PatchResult {
  const text = joinLines(l)
  return { text, changed: text !== before, ...extra }
}

// --- sections

interface SectionPos {
  heading: number
  /** Exclusive end: next level-1/2 heading or EOF. */
  end: number
}

function findSection(note: ParsedNote, key: SectionKey): SectionPos | null {
  const name = SECTIONS[key].toLowerCase()
  const hs = note.headings
  for (let i = 0; i < hs.length; i++) {
    if (hs[i].level === 2 && hs[i].text.toLowerCase() === name) {
      const next = hs.slice(i + 1).find((h) => h.level <= 2)
      return { heading: hs[i].line, end: next ? next.line : note.lines.lines.length }
    }
  }
  return null
}

/**
 * Inserts `newLine` at the end of a section's content (after its last non-blank line), creating the
 * heading if missing: before the next existing section in canonical order, else at the end of the file.
 * Returns the index of the inserted line.
 */
function insertInSection(l: Lines, note: ParsedNote, key: SectionKey, newLine: string): number {
  const L = l.lines
  const sec = findSection(note, key)
  if (sec) {
    let at = sec.heading + 1
    for (let i = sec.heading + 1; i < sec.end; i++) if (L[i].trim() !== '') at = i + 1
    insertLines(l, at, [newLine])
    return at
  }
  const later = SECTION_ORDER.slice(SECTION_ORDER.indexOf(key) + 1)
    .map((k) => findSection(note, k))
    .filter((s): s is SectionPos => !!s)
    .sort((a, b) => a.heading - b.heading)[0]
  const heading = `## ${SECTIONS[key]}`
  if (later) {
    const at = later.heading
    const block = [heading, newLine, '']
    const needsGap = at > 0 && L[at - 1].trim() !== ''
    if (needsGap) block.unshift('')
    insertLines(l, at, block)
    return at + (needsGap ? 2 : 1)
  }
  const block = [heading, newLine]
  const needsGap = L.length > 0 && L[L.length - 1].trim() !== ''
  if (needsGap) block.unshift('')
  const at = L.length
  insertLines(l, at, block)
  return at + block.length - 1
}

function itemOrThrow(note: ParsedNote, blockId: string): ParsedFact | ParsedRelation {
  const item = findBlock(note, blockId)
  if (!item) throw new PatchError('block_not_found', `^${blockId.replace(/^\^/, '')} is not in this note`)
  return item
}

/** The moved content of a line: fact text, or relation core `rel [[X]] (context)` as written. */
function coreText(line: string, inHistory: boolean): string {
  const b = parseBulletLine(line, inHistory)
  if (!b) return line.trim()
  if (b.kind === 'observation' || b.kind === 'history') return b.text
  const start = b.spans.rel?.start ?? b.link.start
  const end = b.spans.prov?.start ?? b.spans.anchor?.start ?? line.length
  return line.slice(start, end).trim()
}

function isRelationItem(item: ParsedFact | ParsedRelation): item is ParsedRelation {
  return 'link' in item
}

// --- appends

export function appendObservation(text: string, o: ObservationInput): PatchResult {
  if (!o.text.trim()) throw new PatchError('empty_text', 'an observation needs text')
  const blockId = o.blockId ?? newBlockId('f')
  const note = parseNote(text)
  const l = splitLines(text)
  const line = insertInSection(l, note, 'observations', formatObservation({ ...o, blockId }))
  return result(text, l, { line, blockId })
}

export function appendRelation(text: string, r: RelationInput): PatchResult {
  if (!r.target.trim() || !r.rel.trim()) throw new PatchError('empty_text', 'a relation needs a type and a target')
  const blockId = r.blockId ?? newBlockId('r')
  const note = parseNote(text)
  const l = splitLines(text)
  const line = insertInSection(l, note, 'relations', formatRelation({ ...r, blockId }))
  return result(text, l, { line, blockId })
}

/** Appends a raw, already formatted line to a section (harvest and merge use this). */
export function appendLine(text: string, section: SectionKey, line: string): PatchResult {
  const note = parseNote(text)
  const l = splitLines(text)
  const at = insertInSection(l, note, section, line.replace(/\r?\n/g, ' '))
  return result(text, l, { line: at })
}

// --- History moves

export type HistoryMove = { state: 'superseded'; by: string } | { state: 'invalidated'; reason: string }

/** Removes the line carrying `blockId` and appends it under `## History` with the given state. */
export function moveToHistory(text: string, blockId: string, how: HistoryMove, prov?: ProvInput | null): PatchResult {
  const id = blockId.replace(/^\^/, '')
  const note = parseNote(text)
  const item = itemOrThrow(note, id)
  if (item.section === 'history') throw new PatchError('already_history', `^${id} is already in History`)
  const l = splitLines(text)
  const core = coreText(l.lines[item.line], false)
  removeLines(l, item.line, 1)
  const after = parseNote(joinLines(l))
  const histLine = formatHistory({
    state: how.state as HistoryState,
    text: core,
    supersededBy: how.state === 'superseded' ? how.by.replace(/^\^/, '') : null,
    reason: how.state === 'invalidated' ? how.reason : null,
    prov: prov ?? null,
    blockId: id
  })
  const line = insertInSection(l, after, 'history', histLine)
  return result(text, l, { line, blockId: id })
}

export function invalidate(text: string, blockId: string, reason: string, prov?: ProvInput | null): PatchResult {
  return moveToHistory(text, blockId, { state: 'invalidated', reason }, prov)
}

/**
 * Appends the replacement observation with a fresh `^f-` id and moves the old line to History as
 * `[superseded] … (by ^new; prov)`. The category defaults to the old one.
 */
export function supersede(
  text: string,
  blockId: string,
  next: { text: string; category?: string; tags?: string[]; blockId?: string },
  prov: ProvInput
): PatchResult {
  const note = parseNote(text)
  const item = itemOrThrow(note, blockId.replace(/^\^/, ''))
  if (isRelationItem(item)) throw new PatchError('not_a_fact', `^${item.blockId} is a relation`)
  if (item.section === 'history') throw new PatchError('already_history', `^${item.blockId} is already in History`)
  const added = appendObservation(text, {
    category: next.category ?? item.category,
    text: next.text,
    tags: next.tags,
    prov,
    blockId: next.blockId
  })
  const moved = moveToHistory(added.text, item.blockId!, { state: 'superseded', by: added.blockId! }, prov)
  const final = parseNote(moved.text)
  return { text: moved.text, changed: true, blockId: added.blockId, line: findBlock(final, added.blockId!)?.line }
}

/**
 * Reinforces a taste line in place (Open Passport SPEC.md §4.6): `x<count>` + 1 and the example appended (at most 5,
 * no duplicates). The id, category and provenance stay; only the text between them changes.
 */
export function reinforceTaste(text: string, blockId: string, example?: string | null): PatchResult {
  const id = blockId.replace(/^\^/, '')
  const note = parseNote(text)
  const item = itemOrThrow(note, id)
  if (isRelationItem(item)) throw new PatchError('not_a_fact', `^${id} is a relation`)
  if (item.section === 'history') throw new PatchError('already_history', `^${id} is already in History`)
  const l = splitLines(text)
  const raw = l.lines[item.line]
  const parsed = parseBulletLine(raw)
  if (!parsed || parsed.kind !== 'observation') throw new PatchError('bad_line', `^${id} is not an observation`)
  const t = parseTasteText(parsed.text)
  const examples = example && !t.examples.includes(example) ? [...t.examples, example].slice(-5) : t.examples
  const next = formatTasteText({ ...t, examples, count: t.count + 1 })
  l.lines[item.line] = raw.slice(0, parsed.textSpan.start) + next + raw.slice(parsed.textSpan.end)
  return result(text, l, { line: item.line, blockId: id })
}

/** Moves a History line back to Observations (category defaults to `fact`) or Relations. */
export function restoreLine(text: string, blockId: string, opts: { category?: string; prov?: ProvInput | null } = {}): PatchResult {
  const id = blockId.replace(/^\^/, '')
  const note = parseNote(text)
  const item = itemOrThrow(note, id)
  if (item.section !== 'history') throw new PatchError('not_history', `^${id} is not in History`)
  const l = splitLines(text)
  const raw = l.lines[item.line]
  removeLines(l, item.line, 1)
  const after = parseNote(joinLines(l))
  let line: number
  if (isRelationItem(item)) {
    const b = parseBulletLine(raw, true)
    const core = b && b.kind === 'history' ? b.text : coreText(raw, true)
    const prov = opts.prov ? ` ${formatProvenance(opts.prov)}` : ''
    line = insertInSection(l, after, 'relations', `- ${core}${prov} ^${id}`)
  } else {
    line = insertInSection(
      l,
      after,
      'observations',
      formatObservation({ category: opts.category ?? 'fact', text: item.text, prov: opts.prov ?? null, blockId: id })
    )
  }
  return result(text, l, { line, blockId: id })
}

// --- frontmatter

function withFrontmatter(text: string, fn: (l: Lines) => boolean): PatchResult {
  const l = splitLines(text)
  try {
    fn(l)
  } catch (e) {
    if (e instanceof FrontmatterError) throw new PatchError('frontmatter', e.message)
    throw e
  }
  return result(text, l)
}

/** Sets a frontmatter key (`undefined` removes it). Only that entry's lines change. */
export function setProperty(text: string, key: string, value: FmValue | undefined): PatchResult {
  if (!key.trim()) throw new PatchError('frontmatter', 'empty property key')
  return withFrontmatter(text, (l) => setFrontmatterValue(l, key, value))
}

/** Stamps a real note id when the note has none (notes created in Obsidian). Returns the id in use. */
export function ensureNoteId(text: string, id: string): PatchResult & { id: string } {
  const note = parseNote(text)
  if (note.id) return { text, changed: false, id: note.id }
  if (!isNoteId(id)) throw new PatchError('frontmatter', `"${id}" is not a note id`)
  return { ...setProperty(text, 'id', id), id }
}

export function addAlias(text: string, alias: string): PatchResult {
  const a = alias.trim()
  const note = parseNote(text)
  const current = fmList(note.data.aliases)
  if (!a || current.some((x) => normName(x) === normName(a)) || normName(note.title) === normName(a)) {
    return { text, changed: false }
  }
  return setProperty(text, 'aliases', [...current, a])
}

export function removeAlias(text: string, alias: string): PatchResult {
  const note = parseNote(text)
  const current = fmList(note.data.aliases)
  const next = current.filter((x) => normName(x) !== normName(alias))
  if (next.length === current.length) return { text, changed: false }
  return setProperty(text, 'aliases', next)
}

/** Archive replaces delete: `status: archived` (plus `merged_into` on merge). */
export function archive(text: string, mergedInto?: string | null): PatchResult {
  let r = setProperty(text, 'status', 'archived')
  if (mergedInto) {
    const m = setProperty(r.text, 'merged_into', `[[${mergedInto}]]`)
    r = { ...m, changed: r.changed || m.changed }
  }
  return r
}

// --- link rewrites

export type LinkRewrite = (link: WikiLink, ctx: { line: number; frontmatter: boolean }) => { target: string; display?: string | null } | null

/**
 * Writes every pipe of a rendered link as `\|`, for markdown table rows: the target/display separator and any pipe in
 * the display text (one already written `\|` is kept as is). A bare `|` anywhere in the link would split the cell.
 */
export function escapeTablePipes(rendered: string): string {
  return rendered.replace(/(?<!\\)\|/g, '\\|')
}

/**
 * Rewrites wikilinks (body outside code, and quoted frontmatter values). The callback returns the new
 * target (and display) or null to keep the link. Heading, block and embed parts are preserved.
 */
export function rewriteLinks(text: string, fn: LinkRewrite): PatchResult & { count: number } {
  const note = parseNote(text)
  const l = splitLines(text)
  let count = 0
  for (let i = 0; i < l.lines.length; i++) {
    if (note.code[i]) continue
    const inFm = i < note.bodyStart
    if (inFm && (i === 0 || i === note.bodyStart - 1)) continue
    const line = l.lines[i]
    if (!line.includes('[[')) continue
    const links = scanLinks(inFm ? line : maskInlineCode(line), { maskCode: false }).filter((x) => !x.markdown)
    let out = line
    for (const link of [...links].reverse()) {
      const next = fn(link, { line: i, frontmatter: inFm })
      if (!next) continue
      const display = next.display === undefined ? link.display : next.display
      const written = line.slice(link.start, link.end)
      let rendered = formatWikiLink({ target: next.target, heading: link.heading, block: link.block, display, embed: link.embed })
      // inside markdown table rows the display pipe must be written `\|` or it splits the cell
      if (written.includes('\\|') || (!inFm && /^\s*\|/.test(line))) rendered = escapeTablePipes(rendered)
      if (rendered === written) continue
      out = out.slice(0, link.start) + rendered + out.slice(link.end)
      count++
    }
    l.lines[i] = out
  }
  return { ...result(text, l), count }
}

/**
 * Rename and merge rewrites. `matches(target)` decides which links point at the old note (the caller
 * resolves them). Rename: `[[Old]]` -> `[[New]]`, `[[Old|x]]` -> `[[New|x]]`. With `keepOldAsDisplay`
 * (merge B into A): `[[B]]` -> `[[A|B]]`.
 */
export function retargetLinks(
  text: string,
  matches: (target: string) => boolean,
  newTarget: string,
  opts: { keepOldAsDisplay?: boolean } = {}
): PatchResult & { count: number } {
  return rewriteLinks(text, (link) => {
    if (!link.target || !matches(link.target)) return null
    const display = link.display ?? (opts.keepOldAsDisplay ? link.target : null)
    return { target: newTarget, display }
  })
}

/**
 * Wraps a plain-text mention as a link (`linkMention` op). `span` is in the line's own offsets. The
 * span must not overlap code or an existing link. Exact text -> `[[Target]]`, else `[[Target|text]]`.
 */
export function linkMention(text: string, line: number, span: { start: number; end: number }, target: string, expected?: string): PatchResult {
  const note = parseNote(text)
  const l = splitLines(text)
  if (line < note.bodyStart || line >= l.lines.length || note.code[line]) throw new PatchError('bad_line', `line ${line + 1} is not body text`)
  const raw = l.lines[line]
  if (span.start < 0 || span.end > raw.length || span.end <= span.start) throw new PatchError('bad_span', 'span is outside the line')
  const masked = maskInlineCode(raw)
  if (masked.slice(span.start, span.end) !== raw.slice(span.start, span.end)) throw new PatchError('bad_span', 'span is inside code')
  if (scanLinks(masked, { maskCode: false }).some((k) => k.start < span.end && span.start < k.end)) {
    throw new PatchError('bad_span', 'span overlaps a link')
  }
  const mention = raw.slice(span.start, span.end)
  // a stale line/span (the note changed since the suggestion) must never link other words
  if (expected !== undefined && mention.toLowerCase() !== expected.toLowerCase()) throw new PatchError('bad_span', `the text at that position is no longer "${expected}"`)
  let rendered = formatWikiLink({ target, display: mention === target ? null : mention })
  if (/^\s*\|/.test(raw)) rendered = escapeTablePipes(rendered)
  l.lines[line] = raw.slice(0, span.start) + rendered + raw.slice(span.end)
  return result(text, l, { line })
}

/**
 * Stamps a real block id on a hand-written observation/relation (soft key -> `^f-`/`^r-`). A line
 * that already has a Principia id returns it unchanged; a foreign `^anchor` is never replaced.
 */
export function materializeId(text: string, line: number, blockId?: string): PatchResult {
  const note = parseNote(text)
  const item = lineItem(note, line)
  if (!item) throw new PatchError('bad_line', `line ${line + 1} is not an observation or relation`)
  if (item.blockId) return { text, changed: false, line, blockId: item.blockId }
  if (item.anchor) throw new PatchError('has_anchor', `line ${line + 1} already ends with ^${item.anchor}`)
  const id = blockId ?? newBlockId(isRelationItem(item) ? 'r' : 'f')
  if (!isBlockId(id)) throw new PatchError('bad_line', `"${id}" is not a block id`)
  const l = splitLines(text)
  l.lines[line] = `${l.lines[line].replace(/\s+$/, '')} ^${id}`
  return result(text, l, { line, blockId: id })
}

/**
 * Editor saves: observations/relations with Principia block ids that were active in `before` and are
 * gone from `after` are relocated to History as `[invalidated]` instead of being dropped (`moved`).
 * History lines deleted in the editor are put back verbatim (`kept`): facts are never deleted.
 */
export function relocateRemovedFacts(
  before: string,
  after: string,
  prov: ProvInput,
  reason = 'removed in editor'
): { text: string; moved: string[]; kept: string[] } {
  const prev = parseNote(before)
  const next = parseNote(after)
  const present = new Set<string>()
  for (const x of [...next.facts, ...next.relations]) if (x.blockId) present.add(x.blockId)
  const missing = [...prev.facts, ...prev.relations]
    .filter((x) => x.blockId && !present.has(x.blockId))
    .sort((a, b) => a.line - b.line)
  let text = after
  const moved: string[] = []
  const kept: string[] = []
  for (const item of missing) {
    const raw = prev.lines.lines[item.line]
    if (item.section === 'history') {
      text = appendLine(text, 'history', raw).text
      kept.push(item.blockId!)
    } else if (item.status === 'active') {
      const core = coreText(raw, false)
      text = appendLine(text, 'history', formatHistory({ state: 'invalidated', text: core, reason, prov, blockId: item.blockId })).text
      moved.push(item.blockId!)
    }
  }
  return { text, moved, kept }
}
