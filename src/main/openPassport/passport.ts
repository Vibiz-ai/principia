// Vendored from open-passport 0.1.0 (packages/js/src/core/passport.ts). Do not edit here: change it upstream and re-run scripts/vendor.mjs.
// The passport model (SPEC.md §3): notes plus the roles a reader needs (card, taste, departments).
import { CARD_CATEGORIES, cpCompare, normText, plainText, type ObservationLine, type Polarity, type RelationLine } from './grammar'
import { fmString, fmValue, parseNote, slugify, type Note } from './note'
import type { Manifest } from './manifest'

/** Text files of a passport keyed by `/`-separated relative path. */
export type Files = Map<string, string>

export interface Department {
  slug: string
  name: string
  note: Note
}

export interface TasteItem {
  polarity: Polarity
  statement: string
  examples: string[]
  count: number
  id: string | null
  date: string | null
  actor: string | null
  /** the user said it themselves (actor `user` and not via a suggestion) */
  stated: boolean
  pinned: boolean
  /** `company`, `department:<slug>` or `person:<title>` */
  scope: string
  path: string
  /** line index in the note body, for stable ordering */
  index: number
}

export interface FactItem {
  category: string
  text: string
  id: string | null
  date: string | null
  pinned: boolean
  index: number
}

export interface PassportModel {
  name: string
  manifest: Manifest | null
  notes: Note[]
  card: Note | null
  tasteNote: Note | null
  departments: Department[]
}

export const NOTE_EXT = /\.md$/i
/** Paths never read as notes: tool folders, templates, precomputed renders. */
export const IGNORED_DIRS = /^(\.|_templates\/|_schema\/|renders\/)|\/\./

export function isNotePath(p: string): boolean {
  return NOTE_EXT.test(p) && !IGNORED_DIRS.test(p)
}

const archived = (n: Note) => (fmString(n, 'status') ?? 'active').toLowerCase() === 'archived'

/** Builds the model from the files of a passport folder (manifest optional: roles fall back to note types). */
export function loadPassport(files: Files): PassportModel {
  let manifest: Manifest | null = null
  const mj = files.get('passport.json')
  if (mj) {
    try {
      manifest = JSON.parse(mj) as Manifest
    } catch {
      manifest = null
    }
  }
  const notes = [...files.keys()]
    .filter(isNotePath)
    .sort(cpCompare)
    .map((p) => parseNote(p, files.get(p)!))
  const byPath = new Map(notes.map((n) => [n.path, n]))
  const live = notes.filter((n) => !archived(n))
  const card =
    (manifest?.card ? byPath.get(manifest.card) : undefined) ??
    live.find((n) => n.type === 'company' && !n.path.includes('/') && (!manifest?.name || n.title.toLowerCase() === manifest.name.toLowerCase())) ??
    live.find((n) => n.type === 'company' && !n.path.includes('/')) ??
    live.find((n) => n.type === 'company') ??
    null
  const tasteNote = (manifest?.taste ? byPath.get(manifest.taste) : undefined) ?? live.find((n) => n.type === 'taste') ?? null
  const departments: Department[] = []
  const seen = new Set<string>()
  const declared = manifest?.departments ?? []
  for (const d of declared) {
    const note = byPath.get(d.path)
    if (!note || seen.has(d.slug)) continue
    seen.add(d.slug)
    departments.push({ slug: d.slug, name: d.name || note.title, note })
  }
  if (!declared.length) {
    for (const note of live.filter((n) => n.type === 'department')) {
      let slug = fmString(note, 'slug') ?? slugify(note.title)
      for (let i = 2; seen.has(slug); i++) slug = `${fmString(note, 'slug') ?? slugify(note.title)}-${i}`
      seen.add(slug)
      departments.push({ slug, name: note.title, note })
    }
  }
  const name = manifest?.name ?? card?.title ?? 'Company'
  return { name, manifest, notes, card, tasteNote, departments }
}

/** Live observations of a note (not under History, not history lines). */
export function liveObservations(n: Note): { obs: ObservationLine; index: number }[] {
  return n.lines.filter((l) => l.line.kind === 'observation' && l.section.toLowerCase() !== 'history').map((l) => ({ obs: l.line as ObservationLine, index: l.index }))
}

export function liveRelations(n: Note): RelationLine[] {
  return n.lines.filter((l) => l.line.kind === 'relation' && l.section.toLowerCase() !== 'history').map((l) => l.line as RelationLine)
}

const pinnedTag = (o: ObservationLine) => o.tags.includes('pin')

/** Taste on one note under a scope. Newest wins between lines with the same normalized statement. */
export function tasteOf(n: Note, scope: string): TasteItem[] {
  const out = new Map<string, TasteItem>()
  for (const { obs, index } of liveObservations(n)) {
    if (!obs.taste) continue
    const item: TasteItem = {
      polarity: obs.taste.polarity,
      statement: obs.taste.statement,
      examples: obs.taste.examples,
      count: obs.taste.count,
      id: obs.id,
      date: obs.prov?.date ?? null,
      actor: obs.prov?.actor ?? null,
      stated: !obs.prov || (obs.prov.actor === 'user' && !obs.prov.via),
      pinned: pinnedTag(obs),
      scope,
      path: n.path,
      index
    }
    const key = normText(item.statement)
    const prev = out.get(key)
    if (!prev || newer(item, prev)) out.set(key, item)
  }
  return [...out.values()]
}

const newer = (a: { date: string | null; index: number }, b: { date: string | null; index: number }) => (a.date ?? '') > (b.date ?? '') || ((a.date ?? '') === (b.date ?? '') && a.index > b.index)

/** SPEC.md §6.2 taste order: pinned, stated by the user, reinforced more, newer, then statement. */
export function rankTaste(items: TasteItem[]): TasteItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.stated) - Number(a.stated) ||
      b.count - a.count ||
      cpCompare(b.date ?? '', a.date ?? '') ||
      cpCompare(normText(a.statement), normText(b.statement)) ||
      a.index - b.index
  )
}

/** Company-wide taste: the taste note plus taste lines on the card, deduped (newest wins). */
export function companyTaste(m: PassportModel): TasteItem[] {
  const all = [...(m.tasteNote ? tasteOf(m.tasteNote, 'company') : []), ...(m.card ? tasteOf(m.card, 'company') : [])]
  return rankTaste(dedupeTaste(all))
}

export function departmentTaste(d: Department): TasteItem[] {
  return rankTaste(tasteOf(d.note, `department:${d.slug}`))
}

function dedupeTaste(items: TasteItem[]): TasteItem[] {
  const out = new Map<string, TasteItem>()
  for (const t of items) {
    const k = normText(t.statement)
    const prev = out.get(k)
    if (!prev || newer(t, prev)) out.set(k, t)
  }
  return [...out.values()]
}

const NON_FACT = new Set<string>(['does', 'does-not', 'does not', 'does_not', 'agent', 'likes', 'dislikes', 'prefers', 'avoid'])

/** Non-taste, non-charter facts of a note, newest wins per normalized text, pinned first then line order. */
export function factsOf(n: Note, opts: { cardOrder?: boolean } = {}): FactItem[] {
  const seen = new Map<string, FactItem>()
  for (const { obs, index } of liveObservations(n)) {
    if (NON_FACT.has(obs.category)) continue
    const f: FactItem = { category: obs.category, text: obs.text, id: obs.id, date: obs.prov?.date ?? null, pinned: pinnedTag(obs), index }
    const k = `${obs.category}\u0000${normText(obs.text)}`
    const prev = seen.get(k)
    if (!prev || newer(f, prev)) seen.set(k, f)
  }
  const rank = (c: string) => {
    const i = (CARD_CATEGORIES as readonly string[]).indexOf(c)
    return opts.cardOrder && i >= 0 ? i : CARD_CATEGORIES.length
  }
  return [...seen.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a.category) - rank(b.category) || a.index - b.index)
}

/** `does` / `does-not` lines of a department note (joined), plus the frontmatter fallbacks. */
export function charterOf(d: Department): { does: string; doesNot: string } {
  const does: string[] = []
  const doesNot: string[] = []
  for (const { obs } of liveObservations(d.note)) {
    if (obs.category === 'does') does.push(obs.text)
    else if (obs.category === 'does-not' || obs.category === 'does not' || obs.category === 'does_not') doesNot.push(obs.text)
  }
  return {
    does: does.join('; ') || (fmString(d.note, 'does') ?? ''),
    doesNot: doesNot.join('; ') || (fmString(d.note, 'does_not') ?? '')
  }
}

/** Relation types that name a department's people (SPEC.md §3.4). */
export const PEOPLE_RELS = ['lead', 'led_by', 'member', 'has_member', 'owner', 'owned_by', 'staffed_by']
/** Relations from a person note into a department. */
export const MEMBER_OF_RELS = ['part_of', 'member_of', 'works_in', 'leads']

export function peopleOf(m: PassportModel, d: Department): string[] {
  const out: string[] = []
  const add = (name: string, role: string | null) => {
    const label = role ? `${name} (${role})` : name
    if (!out.some((x) => x === name || x.startsWith(`${name} (`))) out.push(label)
  }
  for (const r of liveRelations(d.note)) {
    if (!PEOPLE_RELS.includes(r.rel)) continue
    add(plainText(r.target), r.rel === 'lead' || r.rel === 'led_by' ? 'lead' : r.context ? plainText(r.context) : null)
  }
  const keys = new Set([d.note.title.toLowerCase(), d.note.path.replace(/\.md$/i, '').toLowerCase()])
  for (const n of m.notes) {
    if (n.type !== 'person' || archived(n)) continue
    for (const r of liveRelations(n)) {
      if (!MEMBER_OF_RELS.includes(r.rel) || !keys.has(r.target.toLowerCase())) continue
      add(n.title, r.rel === 'leads' ? 'lead' : r.context ? plainText(r.context) : null)
    }
  }
  return out
}

/** `[agent]` lines of a department note: the agents (seats) that work there. */
export function agentsOf(d: Department): string[] {
  return liveObservations(d.note)
    .filter((o) => o.obs.category === 'agent')
    .map((o) => o.obs.text)
}

export function noteByName(m: PassportModel, name: string): Note | null {
  const want = name.replace(/^\[\[|\]\]$/g, '').trim().toLowerCase()
  return (
    m.notes.find((n) => n.title.toLowerCase() === want) ??
    m.notes.find((n) => n.path.replace(/\.md$/i, '').toLowerCase() === want) ??
    m.notes.find((n) => {
      const a = fmValue(n, 'aliases')
      return Array.isArray(a) && a.some((x) => x.toLowerCase() === want)
    }) ??
    null
  )
}
