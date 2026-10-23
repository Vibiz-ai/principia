/**
 * The suggestion queue (PASSPORT.md §6.1 mem_proposal, §12). Candidates become `mem_proposal` rows with a fingerprint
 * derived from their stable key, so `UNIQUE(company_id, fingerprint)` keeps duplicates out and a rejected suggestion
 * never comes back (its row stays `rejected` forever). At most 200 open proposals per company; sources whose acceptance
 * rate fell below 20% after 20 decisions are throttled.
 *
 * Stale handling: when notes change, pending suggestions are re-validated. A `linkMention` whose note changed is
 * re-anchored by text match (same target, first unlinked mention) or marked stale; suggestions whose notes, ghosts or
 * lines are gone, or whose link now exists, are marked stale. Accept itself replays the ops through policy and the
 * writer (PassportRuntime.acceptProposals); nothing here writes a vault file.
 */
import type { ProposalSource, VaultOp } from '../../../../shared/passport'
import { sha1Hex } from '../../../../shared/vault/ids'
import { buildResolver, normName, type Resolver } from '../../../../shared/vault/resolve'
import { insertProposal, type IndexDB } from '../indexDb'
import type { Candidate, VaultView, ViewNote } from './candidates'
import { hasEdge, loadVaultView } from './candidates'
import { linkedFrom, reanchorMention, type NoteText } from './mentions'

export const QUEUE_CAP = 200
export const THROTTLE_MIN_DECISIONS = 20
export const THROTTLE_MIN_RATE = 0.2

/** Sources this pipeline files (writer, indexer and migration proposals are never touched here). */
export const SUGGEST_SOURCES: readonly ProposalSource[] = ['mentions', 'ghosts', 'dupes', 'ontology', 'cooccur', 'similar', 'llm', 'harvest']

/** `sg:<sha1(key)>`: the same suggestion always maps to the same fingerprint. */
export function fingerprintOf(key: string): string {
  return `sg:${sha1Hex(key).slice(0, 32)}`
}

export interface QueueDeps {
  db: IndexDB
  /** current bytes of a vault-relative path in a company vault, or null */
  read(companyId: string, rel: string): NoteText | null
  now?: () => Date
}

export interface FileResult {
  created: string[]
  /** already known (pending, accepted, rejected or stale) */
  known: number
  throttled: number
  /** dropped by the 200 cap */
  capped: number
}

interface PendingRow {
  id: string
  kind: string
  source: string
  payload_json: string
  evidence_json: string
  base_hashes_json: string
}

export class SuggestionQueue {
  constructor(private deps: QueueDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  openCount(companyId: string): number {
    return (this.deps.db.prepare(`SELECT count(*) AS n FROM mem_proposal WHERE company_id = ? AND status = 'pending'`).get(companyId) as { n: number }).n
  }

  /** Acceptance so far for (company, kind, source), as PassportRuntime.decide records it. */
  rate(companyId: string, kind: string, source: string): { accepted: number; rejected: number } {
    const r = this.deps.db.prepare('SELECT value_json FROM mem_settings WHERE company_id = ? AND key = ?').get(companyId, `rate:${kind}:${source}`) as { value_json: string } | undefined
    try {
      const v = r ? (JSON.parse(r.value_json) as { accepted?: number; rejected?: number }) : {}
      return { accepted: Number(v.accepted) || 0, rejected: Number(v.rejected) || 0 }
    } catch {
      return { accepted: 0, rejected: 0 }
    }
  }

  /** §12 throttling: below 20% acceptance after 20 decisions. */
  throttled(companyId: string, kind: string, source: string): boolean {
    const r = this.rate(companyId, kind, source)
    const total = r.accepted + r.rejected
    return total >= THROTTLE_MIN_DECISIONS && r.accepted / total < THROTTLE_MIN_RATE
  }

  /** True when this suggestion was ever filed (any status), so a rejection is never re-offered. */
  known(companyId: string, key: string): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM mem_proposal WHERE company_id = ? AND fingerprint = ?').get(companyId, fingerprintOf(key))
  }

  /** Files candidates best-first under the cap. Nothing is written to the vault. */
  file(companyId: string, candidates: Candidate[]): FileResult {
    const res: FileResult = { created: [], known: 0, throttled: 0, capped: 0 }
    const byKey = new Map<string, Candidate>()
    for (const c of candidates) {
      if (!c.ops.length) continue
      const prev = byKey.get(c.key)
      if (!prev || prev.score < c.score) byKey.set(c.key, c)
    }
    const sorted = [...byKey.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    let open = this.openCount(companyId)
    const gate = new Map<string, boolean>()
    const at = this.now()
    this.deps.db.transaction(() => {
      for (const c of sorted) {
        const g = `${c.kind}:${c.source}`
        if (!gate.has(g)) gate.set(g, this.throttled(companyId, c.kind, c.source))
        if (gate.get(g)) {
          res.throttled++
          continue
        }
        if (this.known(companyId, c.key)) {
          res.known++
          continue
        }
        if (open >= QUEUE_CAP) {
          res.capped++
          continue
        }
        const id = insertProposal(this.deps.db, {
          companyId,
          kind: c.kind,
          payload: c.ops,
          evidence: c.evidence,
          score: c.score,
          source: c.source,
          fingerprint: fingerprintOf(c.key),
          baseHashes: c.baseHashes ?? {},
          createdAt: at
        })
        if (id) {
          res.created.push(id)
          open++
        } else res.known++
      }
    })()
    return res
  }

  private markStale(companyId: string, id: string): void {
    this.deps.db.prepare(`UPDATE mem_proposal SET status = 'stale', decided_at = ? WHERE company_id = ? AND id = ? AND status = 'pending'`).run(this.now(), companyId, id)
  }

  /**
   * Re-validates the company's pending suggestions against the current index and files (§12 stale handling).
   * Returns how many were re-anchored and how many went stale.
   */
  refresh(companyId: string, view: VaultView = loadVaultView(this.deps.db, companyId)): { reanchored: number; stale: number } {
    const rows = this.deps.db
      .prepare(
        `SELECT id, kind, source, payload_json, evidence_json, base_hashes_json FROM mem_proposal
         WHERE company_id = ? AND status = 'pending' AND source IN (${SUGGEST_SOURCES.map(() => '?').join(',')})`
      )
      .all(companyId, ...SUGGEST_SOURCES) as PendingRow[]
    if (!rows.length) return { reanchored: 0, stale: 0 }
    const resolver = buildResolver(view.notes)
    let reanchored = 0
    let stale = 0
    for (const r of rows) {
      const verdict = this.check(companyId, view, resolver, r)
      if (verdict === 'ok') continue
      if (verdict === 'stale') {
        this.markStale(companyId, r.id)
        stale++
        continue
      }
      this.deps.db
        .prepare(`UPDATE mem_proposal SET payload_json = ?, evidence_json = ?, base_hashes_json = ? WHERE company_id = ? AND id = ? AND status = 'pending'`)
        .run(JSON.stringify(verdict.ops), JSON.stringify(verdict.evidence), JSON.stringify(verdict.baseHashes), companyId, r.id)
      reanchored++
    }
    return { reanchored, stale }
  }

  private check(companyId: string, view: VaultView, resolver: Resolver, r: PendingRow): 'ok' | 'stale' | { ops: VaultOp[]; evidence: unknown[]; baseHashes: Record<string, string> } {
    const ops = parseJson<VaultOp[]>(r.payload_json, [])
    if (!Array.isArray(ops) || !ops.length) return 'stale'
    if (r.source === 'harvest') return 'ok' // agent notes: the writer dedups lines at accept time
    const note = (name: string): ViewNote | null => {
      const res = resolver.resolve(name)
      const n = res.status === 'resolved' ? view.byId.get(res.id) : undefined
      return n && n.status !== 'archived' ? n : null
    }
    const first = ops[0]
    switch (first.op) {
      case 'linkMention': {
        const src = note(first.note)
        const target = note(first.target)
        if (!src || !target || src.id === target.id) return 'stale'
        const base = parseJson<Record<string, string>>(r.base_hashes_json, {})
        const linked = linkedFrom(view, src.id)
        if (linked.has(target.id)) return 'stale'
        if (base[src.path] === src.hash && first.note === src.stem && first.target === target.stem) return 'ok'
        const file = this.deps.read(companyId, src.path)
        if (!file) return 'stale'
        const at = reanchorMention(file.text, src, target, linked)
        if (!at) return 'stale'
        const evidence = parseJson<{ path: string | null; line: number | null; quote: string; note: string | null }[]>(r.evidence_json, [])
        const ev0 = evidence[0] ?? { path: src.path, line: at.line, quote: at.quote, note: null }
        return {
          ops: [{ ...first, note: src.stem, target: target.stem, line: at.line, span: at.span, text: at.text }, ...ops.slice(1)],
          evidence: [{ ...ev0, path: src.path, line: at.line, quote: at.quote }, ...evidence.slice(1)],
          baseHashes: { [src.path]: file.hash }
        }
      }
      case 'addAlias': {
        // retarget: the ghost must still be a ghost and the note must still exist
        const target = note(first.note)
        if (!target) return 'stale'
        return view.ghosts.some((g) => g.norm === normName(first.alias)) ? 'ok' : 'stale'
      }
      case 'createNote':
        return resolver.resolve(first.title).status === 'ghost' ? 'ok' : 'stale'
      case 'merge': {
        const from = note(first.from)
        const into = note(first.into)
        return from && into && from.id !== into.id ? 'ok' : 'stale'
      }
      case 'relate': {
        const from = note(first.from)
        if (!from) return 'stale'
        if (r.kind === 'relation_type') {
          const inv = ops.find((o): o is Extract<VaultOp, { op: 'invalidate' }> => o.op === 'invalidate')
          const live = inv
            ? this.deps.db.prepare(`SELECT 1 FROM mem_link WHERE company_id = ? AND block_id = ? AND origin = 'relation' AND status = 'active'`).get(companyId, inv.blockId)
            : null
          return live ? 'ok' : 'stale'
        }
        const to = note(first.to)
        if (!to) return 'stale'
        return hasEdge(view, from.id, to.id) || from.id === to.id ? 'stale' : 'ok'
      }
      default:
        return 'ok'
    }
  }
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}
