/**
 * Fuzzy string helpers shared by the renderer (⌘K palette, `[[` popover) and the Passport suggester (PASSPORT.md §12).
 * Pure, no Node or DOM imports.
 */

/** Tiny subsequence scorer for the ⌘K palette. Higher is better; -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length) * 0.1 + (idx === 0 || /[\s\-_/·]/.test(t[idx - 1] ?? '') ? 200 : 0)
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(found - ti, 10)
    ti = found + 1
  }
  return score
}

export function fuzzyFilter<T>(items: T[], query: string, text: (t: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit)
  return items
    .map((it) => ({ it, s: fuzzyScore(query, text(it)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.it)
}

/** NFKC, lowercase, whitespace collapsed (the resolver's name key, PASSPORT.md §5). */
export function foldName(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Character trigrams of a padded, folded name (`"  ab "` style padding so short names still compare). */
export function trigrams(s: string): Set<string> {
  const t = `  ${foldName(s)} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

/** Jaccard of two sets (0 when either is empty). */
export function setJaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Title trigram similarity (Jaccard over trigrams), 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  return setJaccard(trigrams(a), trigrams(b))
}

/** English plural stripping on the last word: `Customers` -> `customer`, `Policies` -> `policy`, `Boxes` -> `box`. */
export function singularName(s: string): string {
  const f = foldName(s)
  const m = /^(.*?)(\p{L}+)$/u.exec(f)
  if (!m) return f
  const [, head, w] = m
  let sing = w
  if (w.length > 4 && w.endsWith('ies')) sing = `${w.slice(0, -3)}y`
  else if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) sing = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) sing = w.slice(0, -1)
  return head + sing
}

/** `Mercury (Customer)` -> `mercury`: the writer's collision suffix stripped (PASSPORT.md §2). */
export function stripTypeSuffix(s: string): string {
  return foldName(s).replace(/\s*\([^()]+\)$/, '').trim()
}
