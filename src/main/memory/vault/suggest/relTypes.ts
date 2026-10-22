/**
 * Stage 0 `relation_type` suggestions (PASSPORT.md §4, §12): a relation whose type, after normalization, is not in the
 * ontology but is a near miss of one that is (`work_at` -> `works_at`). Nothing is rewritten silently: accepting writes
 * the retyped relation and moves the old line to History ("retyped as …"). Only lines with a block id are offered; a
 * hand-written line without one has no op that could target it without guessing.
 */
import { damerauLevenshtein } from '../../../../shared/vault/resolve'
import { isKnownRelation, normalizeRelType, relationNearMisses, type Ontology, DEFAULT_ONTOLOGY } from '../../../../shared/vault/ontology'
import type { IndexDB } from '../indexDb'
import type { Candidate, VaultView } from './candidates'

export function relationTypeCandidates(db: IndexDB, view: VaultView, noteIds?: string[] | null, ont: Ontology = DEFAULT_ONTOLOGY): Candidate[] {
  const focus = noteIds ? new Set(noteIds) : null
  const rows = db
    .prepare(
      `SELECT from_note, rel, norm_rel, to_note, to_text, context, block_id, line FROM mem_link
       WHERE company_id = ? AND origin = 'relation' AND status = 'active' AND block_id IS NOT NULL`
    )
    .all(view.companyId) as { from_note: string; rel: string; norm_rel: string; to_note: string | null; to_text: string; context: string | null; block_id: string; line: number }[]
  const out: Candidate[] = []
  for (const r of rows) {
    if (focus && !focus.has(r.from_note)) continue
    const from = view.byId.get(r.from_note)
    if (!from || from.status === 'archived') continue
    const norm = r.norm_rel || normalizeRelType(r.rel)
    if (isKnownRelation(norm, ont)) continue
    const best = relationNearMisses(norm, ont, 1)[0]
    if (!best) continue
    // distance 2 only between long names: `mentors` is a custom type, not a typo of `mentions`
    const d = damerauLevenshtein(norm, best, 2)
    if (d > 2 || (d === 2 && Math.min(norm.length, best.length) < 9)) continue
    const to = r.to_note ? view.byId.get(r.to_note) : null
    out.push({
      kind: 'relation_type',
      source: 'ontology',
      ops: [
        { op: 'relate', from: from.stem, rel: best, to: to ? to.stem : r.to_text, ...(r.context ? { context: r.context } : {}) },
        { op: 'invalidate', blockId: r.block_id, reason: `retyped as ${best}` }
      ],
      evidence: [{ path: from.path, line: r.line, quote: `${r.rel} [[${to ? to.stem : r.to_text}]]`, note: `"${r.rel}" is not in the relation vocabulary; did you mean ${best}?` }],
      score: d <= 1 ? 0.75 : 0.6,
      key: `reltype:${r.from_note}:${r.block_id}:${best}`,
      baseHashes: { [from.path]: from.hash }
    })
  }
  return out
}
