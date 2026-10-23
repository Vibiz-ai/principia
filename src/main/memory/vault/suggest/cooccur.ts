/**
 * Stage 1 co-occurrence (PASSPORT.md §12): note pairs written together by 3+ grants (from mem_event) or linked from the
 * same fact line, with no edge between them yet. Kind `relation`: `relates_to`, or the typed relation that dominates
 * existing edges between notes of the same two types. The pair key is shared with similar.ts and the LLM tier, so a
 * rejected pair never comes back from any source.
 */
import type { IndexDB } from '../indexDb'
import type { Candidate, VaultView, ViewNote } from './candidates'
import { dominantRelation, hasEdge, pairKey } from './candidates'

export const COOCCUR_MIN_GRANTS = 3
/** a grant that touched more notes than this (a migration, a bulk edit) says nothing about pairs */
const GRANT_NOTE_CAP = 15

interface PairStat {
  grants: number
  fact: { text: string; path: string | null; line: number } | null
}

export function pairRelation(view: VaultView, a: ViewNote, b: ViewNote): { from: ViewNote; to: ViewNote; rel: string } {
  const ab = dominantRelation(view, a.type, b.type)
  if (ab) return { from: a, to: b, rel: ab }
  const ba = dominantRelation(view, b.type, a.type)
  if (ba) return { from: b, to: a, rel: ba }
  return { from: a, to: b, rel: 'relates_to' }
}

export function cooccurCandidates(db: IndexDB, view: VaultView): Candidate[] {
  const stats = new Map<string, PairStat>()
  const stat = (a: string, b: string) => {
    const k = pairKey(a, b)
    let s = stats.get(k)
    if (!s) stats.set(k, (s = { grants: 0, fact: null }))
    return s
  }

  // notes written together by one grant
  const touched = new Map<string, Set<string>>()
  for (const r of db
    .prepare(`SELECT DISTINCT grant_id, entity_id FROM mem_event WHERE company_id = ? AND grant_id IS NOT NULL AND entity_id IS NOT NULL`)
    .all(view.companyId) as { grant_id: string; entity_id: string }[]) {
    if (!view.byId.has(r.entity_id)) continue
    let s = touched.get(r.grant_id)
    if (!s) touched.set(r.grant_id, (s = new Set()))
    s.add(r.entity_id)
  }
  for (const set of touched.values()) {
    if (set.size < 2 || set.size > GRANT_NOTE_CAP) continue
    const ids = [...set]
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) stat(ids[i], ids[j]).grants++
  }

  // notes linked from the same fact line
  const byFact = new Map<string, { notes: Set<string>; from: string; line: number }>()
  for (const r of db
    .prepare(`SELECT from_note, from_fact, to_note, line FROM mem_link WHERE company_id = ? AND from_fact IS NOT NULL AND to_note IS NOT NULL AND status = 'active'`)
    .all(view.companyId) as { from_note: string; from_fact: string; to_note: string; line: number }[]) {
    const k = `${r.from_note}\u0000${r.from_fact}`
    let f = byFact.get(k)
    if (!f) byFact.set(k, (f = { notes: new Set(), from: r.from_note, line: r.line }))
    f.notes.add(r.to_note)
  }
  const factText = db.prepare('SELECT text FROM mem_fact WHERE company_id = ? AND id = ?')
  for (const [k, f] of byFact) {
    const ids = [...f.notes].filter((id) => view.byId.has(id))
    if (ids.length < 2 || ids.length > 6) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const s = stat(ids[i], ids[j])
        if (s.fact) continue
        const text = (factText.get(view.companyId, k.split('\u0000')[1]) as { text: string } | undefined)?.text ?? ''
        s.fact = { text, path: view.byId.get(f.from)?.path ?? null, line: f.line }
      }
    }
  }

  const out: Candidate[] = []
  for (const [k, s] of stats) {
    if (s.grants < COOCCUR_MIN_GRANTS && !s.fact) continue
    const [ia, ib] = k.split('|')
    const a = view.byId.get(ia)
    const b = view.byId.get(ib)
    if (!a || !b || a.status === 'archived' || b.status === 'archived' || hasEdge(view, a.id, b.id)) continue
    const { from, to, rel } = pairRelation(view, a, b)
    const grantScore = s.grants >= COOCCUR_MIN_GRANTS ? Math.min(0.75, 0.45 + (s.grants - COOCCUR_MIN_GRANTS) * 0.05) : 0
    const score = Math.min(0.85, Math.max(grantScore, s.fact ? 0.55 : 0) + (grantScore && s.fact ? 0.1 : 0))
    const evidence: Candidate['evidence'] = []
    if (s.fact) evidence.push({ path: s.fact.path, line: s.fact.line, quote: s.fact.text.slice(0, 300), note: `[[${a.stem}]] and [[${b.stem}]] appear in the same fact` })
    if (s.grants >= COOCCUR_MIN_GRANTS) evidence.push({ path: null, line: null, quote: '', note: `written together in ${s.grants} agent sessions` })
    out.push({
      kind: 'relation',
      source: 'cooccur',
      ops: [{ op: 'relate', from: from.stem, rel, to: to.stem }],
      evidence,
      score: Math.round(score * 1000) / 1000,
      key: `pair:${k}`
    })
  }
  return out
}
