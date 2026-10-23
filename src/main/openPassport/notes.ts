// Vendored from open-passport 0.1.0 (packages/js/src/core/notes.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// Write paths (SPEC.md §8, §9.6): the fenced `open-passport-notes` block for harnesses without tools, taste
// feedback, and appending lines to notes.
import { cleanText, formatObservation, formatRelation, formatTasteText, isPolarity, normText, parseLine, quoteExample, type Line, type Polarity, type Provenance } from './grammar'
import { parseNote, slugify, yamlScalar } from './note'
import { credentialHit, executableHit, imperativeHit } from './screen'
import type { Files, PassportModel } from './passport'

export interface NotesBlockNote {
  title: string
  type: string | null
  lines: Line[]
}
export interface NotesBlockDrop {
  text: string
  reason: string
}

export const NOTES_FENCE = 'open-passport-notes'
const BLOCK_RE = /```open-passport-notes[^\n]*\n([\s\S]*?)\n```/g
const LEGACY_RE = /<passport-notes>([\s\S]*?)<\/passport-notes>/g
export const NOTES_LIMITS = { notes: 10, linesPerNote: 10, textLen: 500, blockLen: 20_000 }

/** The last complete write-back block of an answer (```open-passport-notes or <passport-notes>), or null. */
export function extractNotesBlock(output: string): string | null {
  let last: { at: number; body: string } | null = null
  for (const re of [BLOCK_RE, LEGACY_RE]) for (const m of output.matchAll(re)) if (!last || m.index! > last.at) last = { at: m.index!, body: m[1] }
  return last && last.body.length <= NOTES_LIMITS.blockLen ? last.body : null
}

/**
 * Parses a block: `### [[Title]] (type)` headings, then observation / taste / relation lines. Lines are screened
 * (credentials, executable content, injection) and anything else is dropped with a reason.
 */
export function parseNotesBlock(block: string): { notes: NotesBlockNote[]; dropped: NotesBlockDrop[] } {
  const notes: NotesBlockNote[] = []
  const dropped: NotesBlockDrop[] = []
  let cur: NotesBlockNote | null = null
  for (const raw of block.split(/\r?\n/)) {
    const l = raw.trimEnd()
    if (!l.trim()) continue
    const h = /^\s{0,3}#{2,4}\s+(?:\[\[)?([^[\]\n]+?)(?:\]\])?(?:\s+\(([a-z-]+)\))?\s*$/.exec(l)
    if (h) {
      if (notes.length >= NOTES_LIMITS.notes) {
        cur = null
        dropped.push({ text: l, reason: 'too many notes' })
        continue
      }
      cur = notes.find((n) => n.title.toLowerCase() === h[1].trim().toLowerCase()) ?? null
      if (!cur) {
        cur = { title: h[1].trim(), type: h[2] ?? null, lines: [] }
        notes.push(cur)
      }
      continue
    }
    const line = parseLine(l)
    if (!line || !cur) {
      dropped.push({ text: l, reason: cur ? 'not an observation or relation line' : 'line before any note heading' })
      continue
    }
    const why = (l.length > NOTES_LIMITS.textLen && 'too long') || credentialHit(l) || executableHit(l) || imperativeHit(l)
    if (why) {
      dropped.push({ text: l, reason: why })
      continue
    }
    if (cur.lines.length >= NOTES_LIMITS.linesPerNote) {
      dropped.push({ text: l, reason: 'too many lines for one note' })
      continue
    }
    cur.lines.push(line)
  }
  return { notes: notes.filter((n) => n.lines.length), dropped }
}

// ---------- taste feedback (SPEC.md §8.3) ----------

export interface TasteFeedback {
  /** `company` or `department:<slug>` */
  scope: string
  polarity: Polarity
  text: string
  /** `[[Note]]` or a quote of what showed the taste */
  example: string
}

/** The taste line for a feedback (example quoted unless it is a `[[link]]`). */
export function tasteLine(f: TasteFeedback, prov: Provenance | null, id: string | null): string {
  const ex = /^\[\[[^[\]]+\]\]$/.test(f.example.trim()) ? f.example.trim() : quoteExample(f.example)
  return formatObservation({ category: f.polarity, text: formatTasteText({ statement: f.text, examples: [ex], count: 1 }), prov, id })
}

export function validTasteFeedback(f: Partial<TasteFeedback>): string | null {
  if (!f.polarity || !isPolarity(f.polarity)) return 'polarity must be likes, dislikes, prefers or avoid'
  if (!f.text || cleanText(f.text).length < 3) return 'text is required'
  if (!f.example || !f.example.trim()) return 'example is required (a [[Note]] or a quote)'
  if (!f.scope || !/^(company|department:[a-z0-9][a-z0-9-]*)$/.test(f.scope)) return 'scope must be company or department:<slug>'
  return null
}

/** The note a feedback lands on: the taste note (company) or the department note; null for an unknown department. */
export function tasteTarget(m: PassportModel, scope: string): { path: string; create: string | null } | null {
  if (scope === 'company') return m.tasteNote ? { path: m.tasteNote.path, create: null } : { path: 'taste.md', create: '---\ntype: taste\n---\n# Taste\n\n## Observations\n' }
  const slug = scope.slice('department:'.length)
  const d = m.departments.find((x) => x.slug === slug)
  return d ? { path: d.note.path, create: null } : null
}

/**
 * Applies a feedback to the files: an existing line with the same polarity and statement is reinforced (count + 1,
 * example added); otherwise a new line is appended under `## Observations`. Returns the changed path.
 */
export function applyTaste(files: Files, m: PassportModel, f: TasteFeedback, prov: Provenance | null, newId: () => string): { path: string; reinforced: boolean } {
  const target = tasteTarget(m, f.scope)
  if (!target) throw new Error(`unknown scope ${f.scope}`)
  const text = files.get(target.path) ?? target.create ?? ''
  const note = parseNote(target.path, text)
  const lines = note.body.slice()
  const ex = /^\[\[[^[\]]+\]\]$/.test(f.example.trim()) ? f.example.trim() : quoteExample(f.example)
  const hit = note.lines.find((l) => l.line.kind === 'observation' && l.line.taste && l.line.category === f.polarity && l.section.toLowerCase() !== 'history' && normText(l.line.taste.statement) === normText(f.text))
  let reinforced = false
  if (hit && hit.line.kind === 'observation' && hit.line.taste) {
    const t = hit.line.taste
    const examples = t.examples.includes(ex) ? t.examples : [...t.examples, ex].slice(-5)
    lines[hit.index] = formatObservation({ category: f.polarity, text: formatTasteText({ statement: t.statement, examples, count: t.count + 1 }), prov: hit.line.prov, id: hit.line.id })
    reinforced = true
    const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/)?.[0] ?? ''
    files.set(target.path, `${fm}${lines.join('\n')}\n`)
  } else files.set(target.path, appendToSection(text, 'Observations', [tasteLine(f, prov, newId())]))
  return { path: target.path, reinforced }
}

/** Appends a block's notes to the files (new notes under `<type folder>/<Title>.md`). Lines already present are skipped. */
export function applyNotesBlock(files: Files, m: PassportModel, notes: NotesBlockNote[], prov: Provenance | null, newId: (k: 'f' | 'r') => string): { written: number; created: string[] } {
  let written = 0
  const created: string[] = []
  for (const bn of notes) {
    const existing = m.notes.find((n) => n.title.toLowerCase() === bn.title.toLowerCase())
    const path = existing?.path ?? `${bn.type ? `${bn.type === 'person' ? 'people' : `${bn.type}s`}/` : 'inbox/'}${bn.title.replace(/[\\/:*?"<>|#^[\]]/g, '-')}.md`
    let text = files.get(path)
    if (text === undefined) {
      text = `---\ntitle: ${yamlScalar(bn.title)}\ntype: ${bn.type ?? 'note'}\n---\n# ${bn.title}\n\n## Observations\n`
      created.push(path)
    }
    const have = new Set(parseNote(path, text).lines.map((l) => normText(l.line.kind === 'relation' ? `${l.line.rel} ${l.line.target}` : l.line.text)))
    const add: string[] = []
    for (const l of bn.lines) {
      const key = normText(l.kind === 'relation' ? `${l.rel} ${l.target}` : l.text)
      if (have.has(key) || l.kind === 'history') continue
      have.add(key)
      add.push(l.kind === 'relation' ? formatRelation({ rel: l.rel, target: l.target, context: l.context, prov, id: newId('r') }) : formatObservation({ category: l.category, text: l.text, prov, id: newId('f') }))
    }
    if (!add.length) continue
    const obs = add.filter((l) => /^- \[/.test(l))
    const rels = add.filter((l) => !/^- \[/.test(l))
    if (obs.length) text = appendToSection(text, 'Observations', obs)
    if (rels.length) text = appendToSection(text, 'Relations', rels)
    files.set(path, text)
    written += add.length
  }
  return { written, created }
}

/**
 * Appends lines at the end of a `## <section>` (after its last non-blank line). A missing section is created before
 * `## History`, which stays last.
 */
export function appendToSection(text: string, section: string, add: string[]): string {
  const lines = text.replace(/\n*$/, '').split('\n')
  const want = section.toLowerCase()
  const head = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === want)
  if (head >= 0) {
    let at = head + 1
    for (let i = head + 1; i < lines.length && !/^##?\s/.test(lines[i]); i++) if (lines[i].trim()) at = i + 1
    lines.splice(at, 0, ...add)
  } else {
    const hist = lines.findIndex((l) => /^##\s+history\s*$/i.test(l))
    const block = [`## ${section}`, ...add, '']
    if (hist >= 0) lines.splice(hist, 0, ...block)
    else lines.push('', ...block.slice(0, -1))
  }
  return `${lines.join('\n')}\n`
}

export { slugify }
