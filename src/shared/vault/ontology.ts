// Relation ontology (PASSPORT.md §4). The vocabulary lives in the vault as `_schema/Relations.md`,
// one line per relation: `- rel_type :: inverse_label :: description`. These are the defaults.
// Each edge is written once in its stated direction; inverses exist only for backlink display.
// Unknown types are accepted and indexed as written after normalization; near misses only produce
// `relation_type` proposals, never silent rewrites.

import { type NoteType, LINKS_TO, NOTE_TYPES, splitLines } from './grammar'
import { damerauLevenshtein } from './resolve'

export interface RelationDef {
  type: string
  /** Display label for the reverse direction; equals `type` when symmetric. */
  inverse: string
  description: string
  group: string
  symmetric: boolean
  /** Type hints; empty = any. Used to guess ghost types and for "missing" hints (warn only). */
  domain: NoteType[]
  range: NoteType[]
}

const SYM = '(symmetric)'

// [group, type, inverse, hint]
const DEFAULTS: Array<[string, string, string, string]> = [
  ['People & orgs', 'works_at', 'employs', 'person → company/customer'],
  ['People & orgs', 'reports_to', 'manages', 'person → person'],
  ['People & orgs', 'owns', 'owned_by', 'person/company → any'],
  ['People & orgs', 'member_of', 'has_member', 'person → company/team'],
  ['Decisions', 'decided', 'decided_by', 'person → decision'],
  ['Decisions', 'decided_by', 'decided', 'decision → person'],
  ['Decisions', 'supersedes', 'superseded_by', 'decision → decision'],
  ['Decisions', 'caused_by', 'caused', 'gotcha → any'],
  ['Commercial', 'sells', 'sold_by', 'company → offer/product'],
  ['Commercial', 'buys', 'bought_by', 'customer → offer/product'],
  ['Commercial', 'customer_of', 'has_customer', 'customer → company'],
  ['Commercial', 'priced_at', 'price_of', 'offer → concept'],
  ['Commercial', 'competes_with', SYM, 'company → company'],
  ['Commercial', 'partner_of', SYM, 'company → company'],
  ['Structure', 'part_of', 'has_part', 'any → any'],
  ['Structure', 'depends_on', 'dependency_of', 'any → any'],
  ['Structure', 'uses', 'used_by', 'any → product/repo'],
  ['Structure', 'implements', 'implemented_by', 'repo → product/process'],
  ['Structure', 'built_in', 'builds', 'product → repo'],
  ['Structure', 'integrates_with', SYM, 'product → product'],
  ['Structure', 'deployed_to', 'hosts', 'repo → concept'],
  ['Knowledge', 'relates_to', SYM, 'any → any'],
  ['Knowledge', 'mentions', 'mentioned_in', 'any → any'],
  ['Knowledge', 'documented_in', 'documents', 'any → any'],
  ['Knowledge', 'blocks', 'blocked_by', 'any → any'],
  ['Implicit', LINKS_TO, 'linked_from', 'prose links, bare bullets']
]

function typesOf(s: string): NoteType[] {
  return s
    .split('/')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is NoteType => (NOTE_TYPES as readonly string[]).includes(t))
}

/** Domain/range from a `domain → range` hint ("any" and unknown words mean no constraint). */
export function parseHint(hint: string): { domain: NoteType[]; range: NoteType[] } {
  const m = /^\s*([^→>]+?)\s*(?:→|->)\s*(.+?)\s*$/.exec(hint)
  return m ? { domain: typesOf(m[1]), range: typesOf(m[2]) } : { domain: [], range: [] }
}

function def(group: string, type: string, inverse: string, description: string): RelationDef {
  const symmetric = inverse === SYM || inverse === type
  return { type, inverse: symmetric ? type : inverse, description, group, symmetric, ...parseHint(description) }
}

export const DEFAULT_RELATIONS: RelationDef[] = DEFAULTS.map(([g, t, i, d]) => def(g, t, i, d))

/** Written forms that mean a vocabulary type (applied after snake_case normalization). */
export const REL_SYNONYMS: Record<string, string> = {
  works_for: 'works_at',
  employed_at: 'works_at',
  employed_by: 'works_at',
  employee_of: 'works_at',
  works_in: 'works_at',
  owner_of: 'owns',
  own: 'owns',
  member: 'member_of',
  belongs_to: 'part_of',
  component_of: 'part_of',
  part: 'part_of',
  depends: 'depends_on',
  depend_on: 'depends_on',
  requires: 'depends_on',
  use: 'uses',
  using: 'uses',
  sell: 'sells',
  buy: 'buys',
  client_of: 'customer_of',
  customer: 'customer_of',
  competitor_of: 'competes_with',
  competitor: 'competes_with',
  competes: 'competes_with',
  partner: 'partner_of',
  partners_with: 'partner_of',
  implement: 'implements',
  built_with: 'built_in',
  built_on: 'built_in',
  integrates: 'integrates_with',
  integrated_with: 'integrates_with',
  deployed_on: 'deployed_to',
  deployed_at: 'deployed_to',
  hosted_on: 'deployed_to',
  related_to: 'relates_to',
  related: 'relates_to',
  relates: 'relates_to',
  relation: 'relates_to',
  mention: 'mentions',
  documented_by: 'documented_in',
  block: 'blocks',
  because_of: 'caused_by',
  link: LINKS_TO,
  links: LINKS_TO,
  linked_to: LINKS_TO,
  link_to: LINKS_TO
}

/** lowercase snake_case (`decidedBy`, `Decided By`, `decided-by` -> `decided_by`), then synonyms. */
export function normalizeRelType(raw: string): string {
  const snake = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  return REL_SYNONYMS[snake] ?? (snake || LINKS_TO)
}

export interface Ontology {
  defs: RelationDef[]
  byType: Map<string, RelationDef>
}

export function buildOntology(defs: RelationDef[] = DEFAULT_RELATIONS): Ontology {
  const byType = new Map<string, RelationDef>()
  for (const d of defs) byType.set(normalizeRelType(d.type), d)
  return { defs, byType }
}

export const DEFAULT_ONTOLOGY = buildOntology()

export function isKnownRelation(rel: string, ont: Ontology = DEFAULT_ONTOLOGY): boolean {
  return ont.byType.has(normalizeRelType(rel))
}

/** Backlink label: the inverse for vocabulary types, `<rel> of` otherwise (property links included). */
export function inverseLabel(rel: string, ont: Ontology = DEFAULT_ONTOLOGY): string {
  const d = ont.byType.get(normalizeRelType(rel))
  if (d) return d.inverse
  return `${normalizeRelType(rel)} of`
}

/** Vocabulary types within Damerau-Levenshtein 2 of an unknown type (or sharing its stem), best first. */
export function relationNearMisses(rel: string, ont: Ontology = DEFAULT_ONTOLOGY, limit = 3): string[] {
  const n = normalizeRelType(rel)
  if (ont.byType.has(n)) return []
  const scored: Array<[string, number]> = []
  for (const type of ont.byType.keys()) {
    const d = damerauLevenshtein(n, type, 2)
    const stem = n.length >= 4 && (type.startsWith(n) || n.startsWith(type.split('_')[0] + '_')) ? 2 : 3
    const score = Math.min(d, stem)
    if (score <= 2) scored.push([type, score])
  }
  return scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([t]) => t)
}

/** A ghost target's likely type: the first type of the relation's range hint (`works_at` -> company). */
export function guessTargetType(rel: string, ont: Ontology = DEFAULT_ONTOLOGY): NoteType | null {
  const d = ont.byType.get(normalizeRelType(rel))
  return d && d.range.length >= 1 ? d.range[0] : null
}

/** Likely type of a note that is the source of `rel` (domain hint). */
export function guessSourceType(rel: string, ont: Ontology = DEFAULT_ONTOLOGY): NoteType | null {
  const d = ont.byType.get(normalizeRelType(rel))
  return d && d.domain.length === 1 ? d.domain[0] : null
}

// --- _schema/Relations.md

const ONTOLOGY_LINE_RE = /^\s*[-*+]\s+`?([^`:]+?)`?\s*::\s*(.*?)\s*::\s*(.*?)\s*$/

/**
 * Parses `_schema/Relations.md`. `## Group` headings set the group. Lines that do not follow the
 * `- type :: inverse :: description` shape are ignored with a warning (code fences included).
 */
export function parseOntology(markdown: string): { defs: RelationDef[]; warnings: string[] } {
  const defs: RelationDef[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let group = 'Custom'
  let fence = false
  const { lines } = splitLines(markdown)
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      group = h[1]
      return
    }
    if (!/^\s*[-*+]\s/.test(line) || !line.includes('::')) return
    const m = ONTOLOGY_LINE_RE.exec(line)
    if (!m) {
      warnings.push(`line ${i + 1}: expected "- rel_type :: inverse_label :: description"`)
      return
    }
    const type = normalizeRelType(m[1])
    if (seen.has(type)) {
      warnings.push(`line ${i + 1}: duplicate relation "${type}"`)
      return
    }
    seen.add(type)
    const inverse = m[2] === '' ? `${type} of` : m[2] === SYM ? SYM : normalizeRelType(m[2])
    defs.push(def(group, type, inverse, m[3]))
  })
  return { defs, warnings }
}

/** The seeded `_schema/Relations.md` body. */
export function renderOntologyNote(defs: RelationDef[] = DEFAULT_RELATIONS, eol = '\n'): string {
  const out: string[] = [
    '# Relations',
    '',
    'Relation vocabulary for this Passport, one per line: `- rel_type :: inverse_label :: description`.',
    'Write each edge once, in its stated direction. Inverses are display labels for backlinks.'
  ]
  let group = ''
  for (const d of defs) {
    if (d.group !== group) {
      group = d.group
      out.push('', `## ${group}`)
    }
    out.push(`- ${d.type} :: ${d.symmetric ? SYM : d.inverse} :: ${d.description}`)
  }
  return out.join(eol) + eol
}
