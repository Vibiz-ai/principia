/**
 * Shared shapes and the per-company view every suggestion stage reads (PASSPORT.md §12). A `Candidate` is a proposal
 * before it is queued: writer ops plus evidence, a score and a stable key the queue turns into the fingerprint.
 * `loadVaultView` reads exactly one company's rows from passport-index.db (notes, aliases, resolved edges, ghosts).
 * `llmCandidates` picks the up-to-150 notes the stage-2 prompt may name.
 */
import type { ProposalEvidence, ProposalKind, ProposalSource, VaultOp } from '../../../../shared/passport'
import { normName, pathStem } from '../../../../shared/vault/resolve'
import type { IndexDB } from '../indexDb'

export interface Candidate {
  kind: ProposalKind
  source: ProposalSource
  ops: VaultOp[]
  evidence: ProposalEvidence[]
  /** 0..1 */
  score: number
  /** Stable identity (note ids, norms): the same suggestion always yields the same key, so a rejection sticks. */
  key: string
  /** vault-relative path -> content hash the ops were computed from (stale handling) */
  baseHashes?: Record<string, string>
}

export interface ViewNote {
  id: string
  path: string
  title: string
  /** unique basename: the link target written for this note */
  stem: string
  norm: string
  type: string
  status: string
  hash: string
  summary: string
  aliases: string[]
}

export interface ViewEdge {
  from: string
  to: string
  rel: string
  origin: string
}

export interface ViewGhost {
  norm: string
  /** most common written form */
  text: string
  inbound: number
  sources: number
  ambiguous: boolean
  candidates: string[]
  /** relation types pointing at the ghost (range hints guess its type) */
  rels: string[]
  embed: boolean
  /** a few linking lines (evidence, summary draft) */
  samples: { from: string; line: number; context: string }[]
}

export interface VaultView {
  companyId: string
  notes: ViewNote[]
  byId: Map<string, ViewNote>
  edges: ViewEdge[]
  /** undirected resolved adjacency (active links only) */
  adj: Map<string, Set<string>>
  ghosts: ViewGhost[]
}

/** One company's notes, aliases, resolved edges and ghosts. Removed notes are left out; archived ones are kept, marked. */
export function loadVaultView(db: IndexDB, companyId: string): VaultView {
  const rows = db
    .prepare(`SELECT id, path, title, norm_title, type, status, hash, summary FROM mem_note WHERE company_id = ? AND removed_at IS NULL ORDER BY path`)
    .all(companyId) as { id: string; path: string; title: string; norm_title: string; type: string; status: string; hash: string; summary: string }[]
  const aliases = new Map<string, string[]>()
  for (const a of db.prepare('SELECT note_id, alias FROM mem_alias WHERE company_id = ?').all(companyId) as { note_id: string; alias: string }[]) {
    const list = aliases.get(a.note_id) ?? []
    list.push(a.alias)
    aliases.set(a.note_id, list)
  }
  const notes: ViewNote[] = rows.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    stem: pathStem(r.path),
    norm: r.norm_title || normName(r.title),
    type: r.type,
    status: r.status,
    hash: r.hash,
    summary: r.summary,
    aliases: aliases.get(r.id) ?? []
  }))
  const byId = new Map(notes.map((n) => [n.id, n]))
  const edges = (
    db
      .prepare(`SELECT from_note, to_note, norm_rel, origin FROM mem_link WHERE company_id = ? AND to_note IS NOT NULL AND status = 'active'`)
      .all(companyId) as { from_note: string; to_note: string; norm_rel: string; origin: string }[]
  )
    .filter((e) => byId.has(e.from_note) && byId.has(e.to_note) && e.from_note !== e.to_note)
    .map((e) => ({ from: e.from_note, to: e.to_note, rel: e.norm_rel, origin: e.origin }))
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    let s = adj.get(a)
    if (!s) adj.set(a, (s = new Set()))
    s.add(b)
  }
  for (const e of edges) {
    link(e.from, e.to)
    link(e.to, e.from)
  }
  return { companyId, notes, byId, edges, adj, ghosts: loadGhosts(db, companyId) }
}

function loadGhosts(db: IndexDB, companyId: string): ViewGhost[] {
  const rows = db
    .prepare(
      `SELECT to_norm, to_text, from_note, line, context, norm_rel, origin, ambiguous, candidates_json, embed FROM mem_link
       WHERE company_id = ? AND to_note IS NULL AND status = 'active' AND to_norm != '' ORDER BY from_note, line`
    )
    .all(companyId) as {
    to_norm: string
    to_text: string
    from_note: string
    line: number
    context: string | null
    norm_rel: string
    origin: string
    ambiguous: number
    candidates_json: string | null
    embed: number
  }[]
  type Acc = { texts: Map<string, number>; inbound: number; sources: Set<string>; ambiguous: boolean; candidates: Set<string>; rels: string[]; embed: boolean; samples: ViewGhost['samples'] }
  const by = new Map<string, Acc>()
  for (const r of rows) {
    let g = by.get(r.to_norm)
    if (!g) by.set(r.to_norm, (g = { texts: new Map(), inbound: 0, sources: new Set(), ambiguous: false, candidates: new Set(), rels: [], embed: false, samples: [] }))
    if (g.samples.length < 3 && !g.sources.has(r.from_note)) g.samples.push({ from: r.from_note, line: r.line, context: r.context ?? '' })
    const text = r.to_text.replace(/\.md$/i, '').split('/').pop() ?? r.to_text
    g.texts.set(text, (g.texts.get(text) ?? 0) + 1)
    g.inbound++
    g.sources.add(r.from_note)
    if (r.ambiguous) g.ambiguous = true
    for (const c of parseList(r.candidates_json)) g.candidates.add(c)
    if (r.origin === 'relation' || r.origin === 'property') g.rels.push(r.norm_rel)
    if (r.embed) g.embed = true
  }
  return [...by.entries()].map(([norm, g]) => ({
    norm,
    text: [...g.texts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    inbound: g.inbound,
    sources: g.sources.size,
    ambiguous: g.ambiguous,
    candidates: [...g.candidates],
    rels: g.rels,
    embed: g.embed,
    samples: g.samples
  }))
}

function parseList(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Live (not archived) notes: the only targets a suggestion links to. */
export function liveNotes(view: VaultView): ViewNote[] {
  return view.notes.filter((n) => n.status !== 'archived')
}

/** True when a and b are linked in either direction. */
export function hasEdge(view: VaultView, a: string, b: string): boolean {
  return view.adj.get(a)?.has(b) ?? false
}

/** True when a path of length <= 2 (undirected) joins a and b. */
export function within2(view: VaultView, a: string, b: string): boolean {
  const na = view.adj.get(a)
  if (!na) return false
  if (na.has(b)) return true
  const nb = view.adj.get(b)
  if (!nb) return false
  const [small, big] = na.size <= nb.size ? [na, nb] : [nb, na]
  for (const x of small) if (big.has(x)) return true
  return false
}

/** Unordered pair key. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** A typed relation that dominates existing edges between notes of these two types (>= 60% of >= 3), else null. */
export function dominantRelation(view: VaultView, fromType: string, toType: string): string | null {
  const counts = new Map<string, number>()
  let total = 0
  for (const e of view.edges) {
    if (e.origin !== 'relation') continue
    if (view.byId.get(e.from)?.type !== fromType || view.byId.get(e.to)?.type !== toType) continue
    counts.set(e.rel, (counts.get(e.rel) ?? 0) + 1)
    total++
  }
  if (total < 3) return null
  const [rel, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return n / total >= 0.6 && rel !== 'links_to' ? rel : null
}

/**
 * The stage-2 candidate list (§12: up to 150): the focus notes' neighbours first, then stage 0/1 pair endpoints, then
 * notes by degree. Titles, types and aliases only.
 */
export function llmCandidates(view: VaultView, focus: string[], pairs: string[][], limit = 150): ViewNote[] {
  const picked = new Map<string, ViewNote>()
  const add = (id: string) => {
    const n = view.byId.get(id)
    if (n && n.status !== 'archived' && picked.size < limit) picked.set(id, n)
  }
  for (const id of focus) add(id)
  for (const id of focus) for (const nb of view.adj.get(id) ?? []) add(nb)
  for (const p of pairs) p.forEach(add)
  const byDegree = liveNotes(view).sort((a, b) => (view.adj.get(b.id)?.size ?? 0) - (view.adj.get(a.id)?.size ?? 0) || a.title.localeCompare(b.title))
  for (const n of byDegree) add(n.id)
  return [...picked.values()]
}
