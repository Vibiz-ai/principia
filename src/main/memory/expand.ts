/**
 * Graph expansion (PASSPORT.md §8.2): personalized PageRank over one company's link graph, in pure TypeScript.
 *
 * - Seeds: prompt bm25 hits, `[[links]]` or titles in the prompt or task, the cwd's repo note, pinned notes and lines,
 *   and the task note when started from a company task.
 * - Edge weights: typed relation 1.0, property link 0.8, body link 0.6, ghost 0.3, shared tag 0.15 (tags with more
 *   than 20 members are ignored). Edges are walked in both directions (a backlink is as relevant as a link).
 * - 15 iterations with damping 0.5. memory_get(depth) and the brief's "Nearby" ring use the same expansion, so tool
 *   reads and the brief agree.
 */
import type { LinkOrigin } from '../../shared/passport'
import type { IndexDB } from './vault/indexDb'
import { EDGE_WEIGHT, TAG_EDGE_MAX_MEMBERS, vaultSearch } from './search'

export const PPR = { iterations: 15, damping: 0.5 }

export interface LinkGraph {
  ids: string[]
  index: Map<string, number>
  /** undirected weighted adjacency; parallel edges add up */
  adj: Map<number, number>[]
}

const ghostKey = (norm: string) => `ghost:${norm}`

/** The company's link graph: live notes (archived only on request), ghost nodes, link and shared-tag edges. */
export function loadLinkGraph(db: IndexDB, companyId: string, opts: { includeArchived?: boolean } = {}): LinkGraph {
  const ids: string[] = []
  const index = new Map<string, number>()
  const adj: Map<number, number>[] = []
  const node = (id: string): number => {
    let i = index.get(id)
    if (i === undefined) {
      i = ids.push(id) - 1
      index.set(id, i)
      adj.push(new Map())
    }
    return i
  }
  const add = (a: number, b: number, w: number) => {
    if (a === b) return
    adj[a].set(b, (adj[a].get(b) ?? 0) + w)
    adj[b].set(a, (adj[b].get(a) ?? 0) + w)
  }
  const live = new Set(
    (db.prepare(`SELECT id FROM mem_note WHERE company_id = ? AND removed_at IS NULL ${opts.includeArchived ? '' : "AND status = 'active'"}`).all(companyId) as { id: string }[]).map(
      (r) => r.id
    )
  )
  for (const id of live) node(id)
  const links = db
    .prepare(`SELECT from_note, to_note, to_norm, origin FROM mem_link WHERE company_id = ? AND status = 'active' AND dup_of IS NULL AND to_norm != ''`)
    .all(companyId) as { from_note: string; to_note: string | null; to_norm: string; origin: LinkOrigin }[]
  for (const l of links) {
    if (!live.has(l.from_note)) continue
    if (l.to_note) {
      if (!live.has(l.to_note)) continue
      add(index.get(l.from_note)!, index.get(l.to_note)!, EDGE_WEIGHT[l.origin] ?? EDGE_WEIGHT.body)
    } else add(index.get(l.from_note)!, node(ghostKey(l.to_norm)), EDGE_WEIGHT.ghost)
  }
  const members = new Map<string, string[]>()
  for (const t of db.prepare('SELECT DISTINCT note_id, tag_norm FROM mem_tag WHERE company_id = ?').all(companyId) as { note_id: string; tag_norm: string }[]) {
    if (!live.has(t.note_id)) continue
    members.set(t.tag_norm, [...(members.get(t.tag_norm) ?? []), t.note_id])
  }
  for (const list of members.values()) {
    if (list.length < 2 || list.length > TAG_EDGE_MAX_MEMBERS) continue
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(index.get(list[i])!, index.get(list[j])!, EDGE_WEIGHT.tag)
  }
  return { ids, index, adj }
}

/**
 * Personalized PageRank: r = (1 - d)·s + d·Wᵀr with W row-normalized by weighted degree. Mass on dangling nodes goes
 * back to the seeds, so the scores always sum to 1 over a connected seed set.
 */
export function personalizedPageRank(g: LinkGraph, seeds: Map<string, number>, opts: { iterations?: number; damping?: number } = {}): Map<string, number> {
  const n = g.ids.length
  const out = new Map<string, number>()
  if (!n) return out
  const d = opts.damping ?? PPR.damping
  const iters = opts.iterations ?? PPR.iterations
  const s = new Float64Array(n)
  let total = 0
  for (const [id, w] of seeds) {
    const i = g.index.get(id)
    if (i === undefined || !(w > 0)) continue
    s[i] += w
    total += w
  }
  if (total <= 0) return out
  for (let i = 0; i < n; i++) s[i] /= total
  const deg = new Float64Array(n)
  for (let i = 0; i < n; i++) for (const w of g.adj[i].values()) deg[i] += w
  let r = Float64Array.from(s)
  let next = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    next.fill(0)
    let dangling = 0
    for (let i = 0; i < n; i++) {
      const ri = r[i]
      if (!ri) continue
      if (!deg[i]) {
        dangling += ri
        continue
      }
      for (const [j, w] of g.adj[i]) next[j] += (d * ri * w) / deg[i]
    }
    for (let i = 0; i < n; i++) next[i] += (1 - d + d * dangling) * s[i]
    ;[r, next] = [next, r]
  }
  for (let i = 0; i < n; i++) if (r[i] > 0) out.set(g.ids[i], r[i])
  return out
}

export interface SeedInput {
  /** prompt or task text */
  query?: string
  /** the cwd's repo: its repo note seeds */
  repoId?: string | null
  /** started from a company task: its note */
  taskNoteId?: string | null
  /** pinned notes and notes holding pinned lines (default true) */
  pinned?: boolean
  /** interactive sessions without a prompt: recently touched notes (§8.3) */
  recent?: number
}

/** Seed weights (§8.2): exact prompt mentions 1.0, bm25 hits by score, repo note 0.8, task note 1.0, pinned 0.5, recent 0.3. */
export const SEED_WEIGHT = { mention: 1.0, repo: 0.8, task: 1.0, pinned: 0.5, recent: 0.3 }

export function seedsFor(db: IndexDB, companyId: string, input: SeedInput): Map<string, number> {
  const seeds = new Map<string, number>()
  const put = (id: string, w: number) => seeds.set(id, Math.max(seeds.get(id) ?? 0, w))
  const query = input.query?.trim() ?? ''
  if (query) {
    const hits = vaultSearch(db, { companyId, repoId: input.repoId }, query.slice(0, 8000), { limit: 12, prompt: true, factsPerNote: 0 })
    const top = Math.max(1e-9, ...hits.map((h) => h.score))
    for (const h of hits) put(h.note.id, h.exact ? SEED_WEIGHT.mention : 0.9 * (h.score / top))
  }
  if (input.repoId) {
    for (const r of db.prepare('SELECT id FROM mem_note WHERE company_id = ? AND repo_id = ? AND removed_at IS NULL').all(companyId, input.repoId) as { id: string }[])
      put(r.id, SEED_WEIGHT.repo)
  }
  if (input.taskNoteId) put(input.taskNoteId, SEED_WEIGHT.task)
  if (input.pinned !== false) {
    for (const r of db
      .prepare(
        `SELECT id FROM mem_note WHERE company_id = ? AND removed_at IS NULL AND status = 'active' AND pinned = 1
         UNION SELECT note_id FROM mem_fact WHERE company_id = ? AND pinned = 1 AND status = 'active'`
      )
      .all(companyId, companyId) as { id: string }[])
      put(r.id, SEED_WEIGHT.pinned)
  }
  if (input.recent) {
    for (const r of db
      .prepare(
        `SELECT e.entity_id AS id FROM mem_event e JOIN mem_note n ON n.company_id = e.company_id AND n.id = e.entity_id AND n.removed_at IS NULL
         WHERE e.company_id = ? AND e.entity_id IS NOT NULL GROUP BY e.entity_id ORDER BY max(e.seq) DESC LIMIT ?`
      )
      .all(companyId, input.recent) as { id: string }[])
      put(r.id, SEED_WEIGHT.recent)
  }
  return seeds
}

export interface Expanded {
  id: string
  score: number
  ghost: boolean
}

/** Ranked expansion from seeds, minus `exclude`; ghosts are kept but flagged. */
export function expand(g: LinkGraph, seeds: Map<string, number>, opts: { limit?: number; exclude?: Iterable<string>; includeSeeds?: boolean } = {}): Expanded[] {
  const ranks = personalizedPageRank(g, seeds)
  const ex = new Set(opts.exclude ?? [])
  if (!opts.includeSeeds) for (const id of seeds.keys()) ex.add(id)
  return [...ranks.entries()]
    .filter(([id]) => !ex.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opts.limit ?? 20)
    .map(([id, score]) => ({ id, score, ghost: id.startsWith('ghost:') }))
}

/** Hop distance from a set of notes (BFS over the same graph), up to maxHops. */
export function hopsFrom(g: LinkGraph, from: string[], maxHops: number): Map<string, number> {
  const dist = new Map<string, number>()
  let frontier = from.filter((id) => g.index.has(id))
  for (const id of frontier) dist.set(id, 0)
  for (let h = 1; h <= maxHops && frontier.length; h++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const j of g.adj[g.index.get(id)!].keys()) {
        const other = g.ids[j]
        if (dist.has(other)) continue
        dist.set(other, h)
        next.push(other)
      }
    }
    frontier = next
  }
  return dist
}

/** memory_get(depth): neighbours of `noteIds` within `depth` hops, ordered by PPR from those notes (§8.2). */
export function neighbours(db: IndexDB, companyId: string, noteIds: string[], depth: 1 | 2, opts: { limit?: number; graph?: LinkGraph } = {}): Expanded[] {
  if (!noteIds.length) return []
  const g = opts.graph ?? loadLinkGraph(db, companyId)
  const within = hopsFrom(g, noteIds, depth)
  const seeds = new Map(noteIds.map((id) => [id, 1]))
  const ranks = personalizedPageRank(g, seeds)
  return [...within.keys()]
    .filter((id) => !seeds.has(id))
    .map((id) => ({ id, score: ranks.get(id) ?? 0, ghost: id.startsWith('ghost:') }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? 12)
}
