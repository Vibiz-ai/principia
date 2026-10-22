/**
 * Open Passport tiers over the index (open-passport SPEC.md §6): the company card is the L0 render and the department
 * slot the L1 render, built with the vendored reference renderer from index rows (no file reads). Taste lines
 * (`likes`, `dislikes`, `prefers`, `avoid`) rank ahead of facts; ids, tags, provenance and taste evidence stay out, so
 * the card and the slot cost fewer tokens than the line-per-fact card they replace.
 */
import type { IndexDB } from './vault/indexDb'
import { LINKS_TO } from '../../shared/vault/grammar'
import type { PassportDepartment } from '../../shared/passport'
import { formatObservation, formatRelation, parseLine, renderL0, renderL1, slugify, type Department, type Note, type ParsedLine, type PassportModel } from '../openPassport'

interface NoteRow {
  id: string
  path: string
  title: string
  type: string
  summary: string
}

const NOTE_COLS = 'id, path, title, type, summary'

/** One indexed note as an Open Passport note: its live lines rebuilt from the index rows, in file order. */
export function indexNote(db: IndexDB, companyId: string, n: NoteRow): Note {
  const facts = db
    .prepare(`SELECT category, text, block_id, actor, date, line FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'active' AND dup_of IS NULL ORDER BY line`)
    .all(companyId, n.id) as { category: string; text: string; block_id: string | null; actor: string; date: string | null; line: number }[]
  const links = db
    .prepare(
      `SELECT l.norm_rel, l.to_text, l.context, l.block_id, l.line, t.title FROM mem_link l LEFT JOIN mem_note t ON t.company_id = l.company_id AND t.id = l.to_note
       WHERE l.company_id = ? AND l.from_note = ? AND l.status = 'active' AND l.dup_of IS NULL AND l.origin = 'relation' AND l.norm_rel != ? ORDER BY l.line`
    )
    .all(companyId, n.id, LINKS_TO) as { norm_rel: string; to_text: string; context: string | null; block_id: string | null; line: number; title: string | null }[]
  const lines: ParsedLine[] = []
  const prov = (actor: string, date: string | null) => (date ? { actor, via: null, run: null, session: null, date } : null)
  for (const f of facts) {
    const line = parseLine(formatObservation({ category: f.category.toLowerCase(), text: f.text, prov: prov(f.actor, f.date), id: f.block_id }))
    if (line) lines.push({ line, index: f.line, section: 'Observations' })
  }
  for (const l of links) {
    const line = parseLine(formatRelation({ rel: l.norm_rel, target: l.title ?? l.to_text, context: l.context, id: l.block_id }))
    if (line) lines.push({ line, index: l.line, section: 'Relations' })
  }
  lines.sort((a, b) => a.index - b.index)
  return { path: n.path, id: n.id, title: n.title, type: n.type, frontmatter: [], summary: n.summary ?? '', lines, body: [], hasFrontmatter: true }
}

function notesOfType(db: IndexDB, companyId: string, type: string): NoteRow[] {
  return db.prepare(`SELECT ${NOTE_COLS} FROM mem_note WHERE company_id = ? AND type = ? AND removed_at IS NULL AND status = 'active' ORDER BY path`).all(companyId, type) as NoteRow[]
}

/**
 * The model the renders need: the hub (card), the taste note, the department notes and, for `withPeople`, the person
 * notes linked to that department. Never another company's rows.
 */
export function tierModel(db: IndexDB, companyId: string, companyName: string, hub: NoteRow | null, opts: { withPeople?: string | null } = {}): PassportModel {
  const card = hub ? indexNote(db, companyId, hub) : null
  const tasteRow = notesOfType(db, companyId, 'taste')[0] ?? null
  const departments: Department[] = notesOfType(db, companyId, 'department').map((r) => ({ slug: slugify(r.title), name: r.title, note: indexNote(db, companyId, r) }))
  const notes: Note[] = [...(card ? [card] : []), ...departments.map((d) => d.note)]
  if (opts.withPeople) {
    const people = db
      .prepare(
        `SELECT DISTINCT n.id, n.path, n.title, n.type, n.summary FROM mem_note n JOIN mem_link l ON l.company_id = n.company_id AND l.from_note = n.id
         WHERE n.company_id = ? AND n.type = 'person' AND n.removed_at IS NULL AND n.status = 'active' AND l.to_note = ? AND l.status = 'active' ORDER BY n.path`
      )
      .all(companyId, opts.withPeople) as NoteRow[]
    notes.push(...people.map((p) => indexNote(db, companyId, p)))
  }
  const tasteNote = tasteRow ? indexNote(db, companyId, tasteRow) : null
  if (tasteNote) notes.push(tasteNote)
  return { name: companyName, manifest: null, notes, card, tasteNote, departments }
}

/** The L0 body lines (no head) within `maxBytes`, or [] when the card has nothing to say. */
export function companyTierLines(model: PassportModel, maxBytes: number): string[] {
  if (!model.card) return []
  return renderL0(model, { maxBytes }).trimEnd().split('\n').slice(1)
}

/**
 * The L1 body lines (no head) for the run's department, within `maxBytes`. The charter on the department row is the
 * source of truth for does / does-not when the note has no `[does]` lines of its own.
 */
export function departmentTierLines(model: PassportModel, noteId: string, d: PassportDepartment, maxBytes: number): string[] {
  const dep = model.departments.find((x) => x.note.id === noteId)
  if (!dep) return []
  const has = (c: string) => dep.note.lines.some((l) => l.line.kind === 'observation' && l.line.category === c)
  const extra: ParsedLine[] = []
  const add = (category: string, text: string) => {
    const line = text.trim() ? parseLine(formatObservation({ category, text })) : null
    if (line) extra.push({ line, index: -1, section: 'Observations' })
  }
  if (!has('does')) add('does', d.charter.does)
  if (!has('does-not')) add('does-not', d.charter.doesNot)
  const note: Note = { ...dep.note, lines: [...extra, ...dep.note.lines] }
  return renderL1({ ...model, notes: model.notes.map((n) => (n === dep.note ? note : n)) }, { ...dep, note }, { maxBytes }).trimEnd().split('\n').slice(1)
}
