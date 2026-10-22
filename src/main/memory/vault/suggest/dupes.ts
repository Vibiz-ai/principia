/**
 * Stage 0 `merge` suggestions (PASSPORT.md §12): two live notes that look like one thing. Signals, strongest first:
 * equal normalized names (after plural and " (Type)" stripping), a title or alias of one is an alias of the other, or a
 * title trigram similarity >= 0.75 together with neighbour Jaccard >= 0.3. The company hub note is never merged away;
 * otherwise the better-linked note survives. Different types lower the score (the human decides).
 */
import { setJaccard, singularName, stripTypeSuffix, trigrams, trigramSimilarity } from '../../../../shared/fuzzy'
import { normName } from '../../../../shared/vault/resolve'
import type { Candidate, VaultView, ViewNote } from './candidates'
import { liveNotes, pairKey } from './candidates'

export const TRIGRAM_MIN = 0.75
export const NEIGHBOUR_MIN = 0.3
/** trigrams shared by more notes than this are too common to seed candidate pairs */
const POSTING_CAP = 200

function nameKeys(n: ViewNote): string[] {
  const keys = new Set<string>()
  for (const name of [n.title, n.stem]) {
    keys.add(normName(name))
    keys.add(stripTypeSuffix(name))
    keys.add(singularName(stripTypeSuffix(name)))
  }
  keys.delete('')
  return [...keys]
}

function aliasKeys(n: ViewNote): Set<string> {
  return new Set(n.aliases.map((a) => normName(a)).filter(Boolean))
}

/** Which note survives a merge of a and b: the hub, else the better-linked, else the shorter path. */
export function mergeDirection(view: VaultView, a: ViewNote, b: ViewNote): { from: ViewNote; into: ViewNote } {
  if (a.type === 'company' && b.type !== 'company') return { from: b, into: a }
  if (b.type === 'company' && a.type !== 'company') return { from: a, into: b }
  const da = view.adj.get(a.id)?.size ?? 0
  const db = view.adj.get(b.id)?.size ?? 0
  if (da !== db) return da > db ? { from: b, into: a } : { from: a, into: b }
  return a.path.length < b.path.length || (a.path.length === b.path.length && a.path < b.path) ? { from: b, into: a } : { from: a, into: b }
}

export function dupeCandidates(view: VaultView, noteIds?: string[] | null): Candidate[] {
  const live = liveNotes(view)
  const focus = noteIds ? new Set(noteIds) : null
  const found = new Map<string, { a: ViewNote; b: ViewNote; score: number; why: string }>()
  const consider = (a: ViewNote, b: ViewNote, score: number, why: string) => {
    if (a.id === b.id) return
    if (focus && !focus.has(a.id) && !focus.has(b.id)) return
    if (a.type === 'company' && b.type === 'company') return
    const k = pairKey(a.id, b.id)
    const prev = found.get(k)
    if (!prev || prev.score < score) found.set(k, { a, b, score, why })
  }

  // 1. equal normalized names
  const byName = new Map<string, ViewNote[]>()
  for (const n of live) for (const k of nameKeys(n)) byName.set(k, [...(byName.get(k) ?? []), n])
  for (const [k, list] of byName) {
    if (list.length < 2 || list.length > 5) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]]
        // same name, different types: the writer's deliberate collision suffix (`Mercury (Customer).md`, §2)
        if (a.type !== b.type) continue
        consider(a, b, 0.9, `same name "${k}"`)
      }
    }
  }

  // 2. alias overlap: a title/alias of one note is an alias of another
  const byAlias = new Map<string, ViewNote[]>()
  for (const n of live) for (const k of aliasKeys(n)) byAlias.set(k, [...(byAlias.get(k) ?? []), n])
  for (const n of live) {
    for (const k of new Set([normName(n.title), ...aliasKeys(n)])) {
      for (const other of byAlias.get(k) ?? []) if (other.id !== n.id) consider(n, other, 0.85, `shared name or alias "${k}"`)
    }
  }

  // 3. title trigram similarity + neighbour overlap
  const posting = new Map<string, ViewNote[]>()
  const grams = new Map<string, Set<string>>()
  for (const n of live) {
    const g = trigrams(n.title)
    grams.set(n.id, g)
    for (const t of g) posting.set(t, [...(posting.get(t) ?? []), n])
  }
  const seen = new Set<string>()
  for (const list of posting.values()) {
    if (list.length < 2 || list.length > POSTING_CAP) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const k = pairKey(a.id, b.id)
        if (seen.has(k)) continue
        seen.add(k)
        if (setJaccard(grams.get(a.id)!, grams.get(b.id)!) < TRIGRAM_MIN && trigramSimilarity(a.stem, b.stem) < TRIGRAM_MIN) continue
        const na = new Set(view.adj.get(a.id) ?? [])
        const nb = new Set(view.adj.get(b.id) ?? [])
        na.delete(b.id)
        nb.delete(a.id)
        const nj = setJaccard(na, nb)
        if (nj < NEIGHBOUR_MIN) continue
        consider(a, b, Math.min(0.85, 0.6 + 0.3 * nj), `similar titles, ${Math.round(nj * 100)}% shared links`)
      }
    }
  }

  const out: Candidate[] = []
  for (const [k, f] of found) {
    const { from, into } = mergeDirection(view, f.a, f.b)
    out.push({
      kind: 'merge',
      source: 'dupes',
      ops: [{ op: 'merge', from: from.stem, into: into.stem }],
      evidence: [
        { path: from.path, line: null, quote: from.summary.slice(0, 200) || from.title, note: f.why },
        { path: into.path, line: null, quote: into.summary.slice(0, 200) || into.title, note: null }
      ],
      score: Math.round(f.score * (from.type === into.type ? 1 : 0.8) * 1000) / 1000,
      key: `merge:${k}`
    })
  }
  return out
}
