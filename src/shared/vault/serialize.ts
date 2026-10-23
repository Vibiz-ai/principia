// Serialization. Existing notes are never re-rendered: `serializeNote` joins the parser's exact line
// model, so a no-op parse + serialize is byte-identical. `renderNote` produces the canonical §3 layout
// for notes Principia creates; everything after creation is a line patch (patch.ts).

import { type FmValue, formatEntryLines } from './frontmatter'
import {
  type Eol,
  type HistoryInput,
  type NoteType,
  type ObservationInput,
  type RelationInput,
  SECTIONS,
  formatHistory,
  formatObservation,
  formatRelation,
  joinLines
} from './grammar'
import type { ParsedNote } from './parse'

export function serializeNote(note: ParsedNote): string {
  return joinLines(note.lines)
}

/** `YYYY-MM-DD` in local time (what the user sees in Obsidian). */
export function isoDate(at: Date | number = Date.now()): string {
  const d = typeof at === 'number' ? new Date(at) : at
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `"[[Title]]"` value for link-valued properties (always quoted when rendered). */
export function linkValue(title: string): string {
  return `[[${title}]]`
}

export interface NewNoteSpec {
  id: string
  title: string
  type: NoteType
  aliases?: string[]
  tags?: string[]
  status?: 'active' | 'archived'
  /** Extra keys in order, rendered between `status` and `created` (company, repos, repo_id, pinned…). */
  properties?: Array<[string, FmValue]>
  created: string
  modified?: string
  source?: string | null
  summary?: string | null
  observations?: ObservationInput[]
  relations?: RelationInput[]
  history?: HistoryInput[]
  eol?: Eol
}

/** Canonical new-note text (PASSPORT.md §3). Empty sections are omitted; the writer adds them on demand. */
export function renderNote(spec: NewNoteSpec): string {
  const eol = spec.eol ?? '\n'
  const fm: string[] = ['---']
  const entry = (k: string, v: FmValue): void => void fm.push(...formatEntryLines(k, v))
  entry('id', spec.id)
  entry('title', spec.title)
  entry('type', spec.type)
  if (spec.aliases?.length) entry('aliases', spec.aliases)
  if (spec.tags?.length) entry('tags', spec.tags.map((t) => t.replace(/^#/, '')))
  entry('status', spec.status ?? 'active')
  for (const [k, v] of spec.properties ?? []) entry(k, v)
  entry('created', spec.created)
  entry('modified', spec.modified ?? spec.created)
  if (spec.source) entry('source', spec.source)
  fm.push('---')

  const body: string[] = [`# ${spec.title}`]
  const summary = spec.summary?.replace(/\s+/g, ' ').trim()
  if (summary) body.push(summary)
  const section = (name: string, lines: string[]): void => {
    if (lines.length === 0) return
    body.push('', `## ${name}`, ...lines)
  }
  section(SECTIONS.observations, (spec.observations ?? []).map(formatObservation))
  section(SECTIONS.relations, (spec.relations ?? []).map(formatRelation))
  section(SECTIONS.history, (spec.history ?? []).map(formatHistory))
  return [...fm, ...body].join(eol) + eol
}

/** `_templates/<Type>.md` for Obsidian's Templates plugin (`{{title}}`, `{{date}}` are its variables). */
export function renderTemplate(type: NoteType, eol: Eol = '\n'): string {
  return [
    '---',
    `type: ${type}`,
    'status: active',
    'created: {{date:YYYY-MM-DD}}',
    'modified: {{date:YYYY-MM-DD}}',
    'source: user',
    '---',
    '# {{title}}',
    '',
    `## ${SECTIONS.observations}`,
    '',
    `## ${SECTIONS.relations}`,
    ''
  ].join(eol)
}
