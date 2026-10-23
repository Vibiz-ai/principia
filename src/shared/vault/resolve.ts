// Link resolution within one company vault (PASSPORT.md §5). Case-insensitive after NFKC, trim and
// whitespace collapse:
//   1. strip #heading, ^block and |display
//   2. containing `/`: vault-relative path, with or without `.md` (suffix match like Obsidian)
//   3. unique basename   4. unique frontmatter title   5. unique alias
//   6. otherwise a ghost; several matches at the deciding step make an ambiguous ghost with candidates.
// Fuzzy matches never resolve; they only feed `didYouMean`.

import { parseLinkInner } from './grammar'

export function normName(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Vault-relative path normalized for lookup: forward slashes, no leading `./` or `/`, no `.md`. */
export function normPath(path: string): string {
  return normName(path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\.md$/i, ''))
}

/** `People/Ana Ruiz.md` -> `Ana Ruiz`. */
export function pathStem(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

export interface ResolvableNote {
  id: string
  /** Vault-relative path including `.md`. */
  path: string
  title: string
  aliases?: string[]
  /** Archived notes still resolve (links stay valid). */
  status?: string
}

export type ResolveVia = 'path' | 'basename' | 'title' | 'alias'

export type Resolution =
  | { status: 'resolved'; id: string; via: ResolveVia; norm: string }
  | { status: 'ambiguous'; candidates: string[]; via: ResolveVia; norm: string }
  | { status: 'ghost'; norm: string }

export interface LinkTarget {
  target: string
  heading: string | null
  block: string | null
  display: string | null
}

/** Accepts `[[X#H|d]]`, `![[X]]`, `X#^b` or a bare name. */
export function parseLinkTarget(raw: string): LinkTarget {
  const s = raw.trim()
  const m = /^!?\[\[([^[\]\n]+)\]\]$/.exec(s)
  return parseLinkInner(m ? m[1] : s)
}

export interface Resolver {
  resolve(target: string): Resolution
  /** The note for an id. */
  get(id: string): ResolvableNote | undefined
  notes: ResolvableNote[]
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  if (!key) return
  const list = map.get(key)
  if (!list) map.set(key, [id])
  else if (!list.includes(id)) list.push(id)
}

export function buildResolver(notes: ResolvableNote[]): Resolver {
  const byId = new Map<string, ResolvableNote>()
  const byPath = new Map<string, string[]>()
  const byBase = new Map<string, string[]>()
  const byTitle = new Map<string, string[]>()
  const byAlias = new Map<string, string[]>()
  for (const n of notes) {
    byId.set(n.id, n)
    push(byPath, normPath(n.path), n.id)
    push(byBase, normName(pathStem(n.path)), n.id)
    push(byTitle, normName(n.title), n.id)
    for (const a of n.aliases ?? []) push(byAlias, normName(a), n.id)
  }
  const pathKeys = [...byPath.keys()]

  function decide(ids: string[] | undefined, via: ResolveVia, norm: string): Resolution | null {
    if (!ids || ids.length === 0) return null
    if (ids.length === 1) return { status: 'resolved', id: ids[0], via, norm }
    return { status: 'ambiguous', candidates: [...ids], via, norm }
  }

  function resolve(raw: string): Resolution {
    const { target } = parseLinkTarget(raw)
    const name = target.replace(/\\/g, '/')
    const norm = normName(name.replace(/\.md$/i, ''))
    if (!norm) return { status: 'ghost', norm }
    if (name.includes('/')) {
      const p = normPath(name)
      const exact = decide(byPath.get(p), 'path', norm)
      if (exact) return exact
      const suffix = pathKeys.filter((k) => k.endsWith(`/${p}`)).flatMap((k) => byPath.get(k)!)
      const bySuffix = decide(suffix, 'path', norm)
      if (bySuffix) return bySuffix
    } else {
      const b = decide(byBase.get(norm), 'basename', norm)
      if (b) return b
    }
    return decide(byTitle.get(norm), 'title', norm) ?? decide(byAlias.get(norm), 'alias', norm) ?? { status: 'ghost', norm }
  }

  return { resolve, get: (id) => byId.get(id), notes }
}

/**
 * The link text tools and the UI insert for a note: `[[Title]]`, or `[[Title|alias]]` when the user
 * typed an alias, so files stay correct in real Obsidian (bare aliases do not resolve there).
 */
export function linkTextFor(note: { path: string; title: string }, typed?: string): string {
  const target = pathStem(note.path)
  const display = typed && normName(typed) !== normName(target) ? typed : null
  return display ? `[[${target}|${display}]]` : `[[${target}]]`
}

// --- fuzzy helpers (did-you-mean only; never auto-resolve)

/** Optimal-string-alignment Damerau-Levenshtein distance. Stops early above `max`. */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  let prev2 = new Array<number>(m + 1).fill(0)
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  let cur = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    ;[prev2, prev, cur] = [prev, cur, prev2]
  }
  return prev[m]
}

export function nameTokens(s: string): string[] {
  return normName(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export function tokenJaccard(a: string, b: string): number {
  const A = new Set(nameTokens(a))
  const B = new Set(nameTokens(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** §5 fuzzy rule: token Jaccard >= 0.75, or Damerau-Levenshtein <= 2 on names of 6+ characters. */
export function isFuzzyMatch(a: string, b: string): boolean {
  const x = normName(a)
  const y = normName(b)
  if (x === y) return true
  if (tokenJaccard(x, y) >= 0.75) return true
  return Math.min(x.length, y.length) >= 6 && damerauLevenshtein(x, y, 2) <= 2
}

export interface DidYouMean {
  id: string
  title: string
  /** The title or alias that matched. */
  matched: string
  score: number
}

/** Fuzzy candidates for an unresolved name, best first. */
export function didYouMean(name: string, notes: ResolvableNote[], limit = 3): DidYouMean[] {
  const q = normName(parseLinkTarget(name).target)
  if (!q) return []
  const out: DidYouMean[] = []
  for (const n of notes) {
    let best: DidYouMean | null = null
    for (const cand of [n.title, pathStem(n.path), ...(n.aliases ?? [])]) {
      const c = normName(cand)
      if (!c || c === q) continue
      const jac = tokenJaccard(q, c)
      const dist = Math.min(q.length, c.length) >= 6 ? damerauLevenshtein(q, c, 2) : 3
      const prefix = c.startsWith(q) || q.startsWith(c) ? 0.6 : 0
      const score = Math.max(jac >= 0.75 ? jac : 0, dist <= 2 ? 1 - dist * 0.15 : 0, q.length >= 3 ? prefix : 0)
      if (score > 0 && (!best || score > best.score)) best = { id: n.id, title: n.title, matched: cand, score }
    }
    if (best) out.push(best)
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit)
}
