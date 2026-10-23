/**
 * Stage 1 text similarity (PASSPORT.md §12): TF-IDF over the FTS index's own terms (an `fts5vocab` instance table over
 * mem_fts, joined to mem_fts_map so only this company's note-body rows are read), cosine top-k per note. Pairs above
 * 0.35 with no path of length <= 2 between them yield a `links_to` relation; orphans surface with their top 3 similar
 * notes above a lower floor. No embeddings, no new packages.
 */
import type { IndexDB } from '../indexDb'
import type { Candidate, VaultView, ViewNote } from './candidates'
import { pairKey, within2 } from './candidates'

export const SIMILAR_MIN = 0.35
export const ORPHAN_MIN = 0.15
const TOP_K = 3
const VOCAB = 'mem_fts_vocab'

/** Porter stems of grammar words, provenance actors and common English that carry no topic. */
const STOP = new Set([
  'observ', 'relat', 'histori', 'supersed', 'invalid', 'reason', 'user', 'claud', 'codex', 'gemini', 'cursor', 'migrat',
  'suggest', 'run', 'session', 'via', 'links_to', 'the', 'and', 'for', 'with', 'that', 'thi', 'from', 'are', 'wa', 'ha',
  'have', 'not', 'but', 'all', 'ani', 'can', 'will', 'into', 'about', 'our', 'your', 'their', 'been', 'were', 'which',
  'when', 'what', 'who', 'how', 'also', 'more', 'than', 'then', 'there', 'these', 'those', 'such', 'onli', 'other',
  'some', 'each', 'use', 'note', 'fact', 'decis', 'convent', 'gotcha'
])

/** The temp fts5vocab table over mem_fts (per connection, created once). */
export function ensureVocab(db: IndexDB): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${VOCAB} USING fts5vocab(main, mem_fts, instance)`)
}

export interface TermVectors {
  /** noteId -> term -> normalized weight */
  vectors: Map<string, Map<string, number>>
  df: Map<string, number>
  docs: number
}

/** TF-IDF unit vectors of the company's note bodies. */
export function termVectors(db: IndexDB, view: VaultView): TermVectors {
  ensureVocab(db)
  const rows = db
    .prepare(
      `SELECT v.term AS term, m.note_id AS note_id, count(*) AS tf
       FROM temp.${VOCAB} v JOIN mem_fts_map m ON m.rowid = v.doc JOIN mem_fts f ON f.rowid = v.doc
       WHERE m.company_id = ? AND v.col = 'body' AND f.ref_kind = 'note'
       GROUP BY v.term, m.note_id`
    )
    .all(view.companyId) as { term: string; note_id: string; tf: number }[]
  const tfs = new Map<string, Map<string, number>>()
  const df = new Map<string, number>()
  for (const r of rows) {
    const n = view.byId.get(r.note_id)
    if (!n || n.status === 'archived') continue
    if (r.term.length < 3 || /^[\d_]+$/.test(r.term) || STOP.has(r.term)) continue
    let m = tfs.get(r.note_id)
    if (!m) tfs.set(r.note_id, (m = new Map()))
    m.set(r.term, r.tf)
    df.set(r.term, (df.get(r.term) ?? 0) + 1)
  }
  const docs = tfs.size
  const vectors = new Map<string, Map<string, number>>()
  for (const [id, m] of tfs) {
    const v = new Map<string, number>()
    let norm = 0
    for (const [t, tf] of m) {
      const d = df.get(t)!
      // a term in one note cannot make two notes similar; one in most notes is noise
      if (d < 2 || d > Math.max(2, docs * 0.5)) continue
      const w = (1 + Math.log(tf)) * Math.log(docs / d)
      if (w <= 0) continue
      v.set(t, w)
      norm += w * w
    }
    if (!norm) continue
    const len = Math.sqrt(norm)
    for (const [t, w] of v) v.set(t, w / len)
    vectors.set(id, v)
  }
  return { vectors, df, docs }
}

/** Cosine similarity of every pair sharing a term: pairKey -> score. */
export function pairSimilarities(tv: TermVectors): Map<string, number> {
  const posting = new Map<string, [string, number][]>()
  for (const [id, v] of tv.vectors) for (const [t, w] of v) posting.set(t, [...(posting.get(t) ?? []), [id, w]])
  const sims = new Map<string, number>()
  for (const list of posting.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = pairKey(list[i][0], list[j][0])
        sims.set(k, (sims.get(k) ?? 0) + list[i][1] * list[j][1])
      }
    }
  }
  return sims
}

function sharedTerms(tv: TermVectors, a: string, b: string, n = 4): string[] {
  const va = tv.vectors.get(a)
  const vb = tv.vectors.get(b)
  if (!va || !vb) return []
  return [...va.entries()]
    .filter(([t]) => vb.has(t))
    .map(([t, w]) => [t, w * vb.get(t)!] as const)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([t]) => t)
}

export function similarCandidates(db: IndexDB, view: VaultView, noteIds?: string[] | null): Candidate[] {
  if (view.notes.length < 3) return []
  const tv = termVectors(db, view)
  if (tv.docs < 3) return []
  const sims = pairSimilarities(tv)
  const byNote = new Map<string, [string, number][]>()
  for (const [k, s] of sims) {
    const [a, b] = k.split('|')
    byNote.set(a, [...(byNote.get(a) ?? []), [b, s]])
    byNote.set(b, [...(byNote.get(b) ?? []), [a, s]])
  }
  const focus = noteIds ? new Set(noteIds) : null
  const picked = new Map<string, { from: ViewNote; to: ViewNote; score: number; orphan: boolean }>()
  for (const [id, list] of byNote) {
    if (focus && !focus.has(id)) continue
    const self = view.byId.get(id)
    if (!self) continue
    const orphan = !(view.adj.get(id)?.size ?? 0)
    const floor = orphan ? ORPHAN_MIN : SIMILAR_MIN
    const top = list
      .filter(([other, s]) => s >= floor && !within2(view, id, other))
      .sort((x, y) => y[1] - x[1])
      .slice(0, TOP_K)
    for (const [otherId, s] of top) {
      const other = view.byId.get(otherId)
      if (!other) continue
      const k = pairKey(id, otherId)
      if (picked.has(k)) continue
      // the less-linked note gets the link (an orphan links out to its neighbour)
      const [from, to] = (view.adj.get(id)?.size ?? 0) <= (view.adj.get(otherId)?.size ?? 0) ? [self, other] : [other, self]
      picked.set(k, { from, to, score: s, orphan })
    }
  }
  const out: Candidate[] = []
  for (const [k, p] of picked) {
    const terms = sharedTerms(tv, p.from.id, p.to.id)
    out.push({
      kind: 'relation',
      source: 'similar',
      ops: [{ op: 'relate', from: p.from.stem, rel: 'links_to', to: p.to.stem }],
      evidence: [{ path: p.from.path, line: null, quote: '', note: `${Math.round(p.score * 100)}% similar text${terms.length ? ` (${terms.join(', ')})` : ''}${p.orphan ? '; an orphan note' : ''}` }],
      score: Math.round(Math.min(0.8, p.score) * 1000) / 1000,
      key: `pair:${k}`
    })
  }
  return out
}
