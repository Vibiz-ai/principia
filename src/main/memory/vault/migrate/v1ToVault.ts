// v1 memory.db -> company vaults (PASSPORT.md §9 steps 1, 4, 5). memory.db is opened read-only and never written;
// the plan below is pure over a snapshot of its rows plus a VaultView per company, so a dry run, a real run and a
// re-run agree on what is new:
//
// - each entity becomes `<TypeFolder>/<sanitized name>.md` in the vault of its repo's company (else Personal), with
//   `id: n-<v1 suffix>`, aliases, `repos: ["[[<repo>]]"]`, `source: migration` and created/modified from the row
// - active facts become `- [kind] text (actor run#N, date) ^f-<v1 suffix>` (`#pin` when pinned); invalid ones go to
//   History as `[superseded] … (by ^f-…)` or `[invalidated] … (reason: …)`; relations become `^r-<suffix>` bullets
// - pending facts and relations become proposals (contested -> fact_supersede, quarantined -> harvest); global-scope
//   facts go to a Personal note with an "assign to company" proposal each
// - mem_event rows are mapped to the company, note path and block id they touched

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { VaultOp } from '../../../../shared/passport'
import { ACTORS, type Actor, type HistoryInput, type ObservationInput, type RelationInput, normalizeNoteType } from '../../../../shared/vault/grammar'
import { sha1Hex, v1EntityToNoteId, v1ToBlockId } from '../../../../shared/vault/ids'
import { normName, pathStem } from '../../../../shared/vault/resolve'
import { isoDate, renderNote } from '../../../../shared/vault/serialize'
import { pathForNewNote } from '../../../../shared/vault/slug'
import type { EventInput } from '../indexDb'
import { noteLinkTarget, type NoteCreate, type VaultView } from './passportToVault'

// ---------- v1 rows ----------

export interface V1Grant {
  id: string
  adapter: string
  run_id: string | null
  session_id: string | null
  repo_id: string | null
}
export interface V1Entity {
  id: string
  repo_id: string | null
  name: string
  type: string
  summary: string
  created_at: string
  updated_at: string
}
export interface V1Fact {
  id: string
  entity_id: string
  text: string
  kind: string
  scope: 'project' | 'global'
  repo_id: string | null
  status: 'active' | 'pending' | 'invalid'
  pinned: number
  invalidated_at: string | null
  invalid_reason: string | null
  superseded_by: string | null
  actor: 'agent' | 'user'
  grant_id: string | null
  created_at: string
  updated_at: string
}
export interface V1Relation {
  id: string
  from_id: string
  to_id: string
  type: string
  scope: 'project' | 'global'
  repo_id: string | null
  status: 'active' | 'pending' | 'invalid'
  invalidated_at: string | null
  invalid_reason: string | null
  actor: 'agent' | 'user'
  grant_id: string | null
  created_at: string
  updated_at: string
}
export interface V1Event {
  seq: number
  ts: string
  op: string
  target_kind: string
  target_id: string
  entity_id: string | null
  actor: string
  grant_id: string | null
  run_id: string | null
  before_json: string | null
  after_json: string | null
}
export interface V1Snapshot {
  entities: V1Entity[]
  aliases: Map<string, string[]>
  facts: V1Fact[]
  relations: V1Relation[]
  events: V1Event[]
  grants: Map<string, V1Grant>
}

export function emptyV1(): V1Snapshot {
  return { entities: [], aliases: new Map(), facts: [], relations: [], events: [], grants: new Map() }
}

/** memory.db opened read-only (a read-only connection never checkpoints or rewrites the file); null when absent. */
export function openV1ReadOnly(file: string): Database.Database | null {
  if (!fs.existsSync(file)) return null
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  return db
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** One consistent snapshot of every row the migration reads (a single read transaction). */
export function readV1(db: Database.Database): V1Snapshot {
  return db.transaction(() => {
    const out = emptyV1()
    if (!hasTable(db, 'mem_entity')) return out
    out.entities = db.prepare('SELECT id, repo_id, name, type, summary, created_at, updated_at FROM mem_entity ORDER BY created_at, id').all() as V1Entity[]
    if (hasTable(db, 'mem_alias')) {
      for (const r of db.prepare('SELECT entity_id, alias FROM mem_alias ORDER BY rowid').all() as { entity_id: string; alias: string }[]) {
        out.aliases.set(r.entity_id, [...(out.aliases.get(r.entity_id) ?? []), r.alias])
      }
    }
    if (hasTable(db, 'mem_fact')) {
      out.facts = db
        .prepare(
          `SELECT id, entity_id, text, kind, scope, repo_id, status, pinned, invalidated_at, invalid_reason, superseded_by, actor, grant_id,
             created_at, updated_at FROM mem_fact ORDER BY created_at, id`
        )
        .all() as V1Fact[]
    }
    if (hasTable(db, 'mem_relation')) {
      out.relations = db
        .prepare(
          `SELECT id, from_id, to_id, type, scope, repo_id, status, invalidated_at, invalid_reason, actor, grant_id, created_at, updated_at
           FROM mem_relation ORDER BY created_at, id`
        )
        .all() as V1Relation[]
    }
    if (hasTable(db, 'mem_event')) {
      out.events = db.prepare('SELECT seq, ts, op, target_kind, target_id, entity_id, actor, grant_id, run_id, before_json, after_json FROM mem_event ORDER BY seq').all() as V1Event[]
    }
    if (hasTable(db, 'mem_grant')) {
      const used = new Set<string>()
      for (const r of [...out.facts, ...out.relations, ...out.events]) if (r.grant_id) used.add(r.grant_id)
      const st = db.prepare('SELECT id, adapter, run_id, session_id, repo_id FROM mem_grant WHERE id = ?')
      for (const id of used) {
        const g = st.get(id) as V1Grant | undefined
        if (g) out.grants.set(id, g)
      }
    }
    return out
  })()
}

/** §9 step 1: `<dir of memory.db>/Hive-backups/memory.v1.<ts>.db`. VACUUM INTO reads the source; it never writes it. */
export function backupV1(db: Database.Database, dbPath: string, now: Date): string {
  const dir = path.join(path.dirname(path.resolve(dbPath)), 'Hive-backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `memory.v1.${now.toISOString().replace(/[:.]/g, '-')}.db`)
  if (!fs.existsSync(file)) db.prepare('VACUUM INTO ?').run(file)
  return file
}

// ---------- plan ----------

export interface V1Context {
  personalId: string
  /** company that owns a repo (Personal for unowned or unknown repos) */
  companyOfRepo(repoId: string): string
  views: Map<string, VaultView>
  /** company -> repo id -> link target of its repo note */
  repoStems: Map<string, Map<string, string>>
  now: Date
  /**
   * company -> v1 id -> status, from an earlier run's migration.json. A line or note written then and missing from the
   * vault now was removed by a human (in Obsidian): it is not added back.
   */
  migrated?: Map<string, Record<string, { status: MapEntry['status'] }>>
}

export type MigratedStatus = 'active' | 'superseded' | 'invalid' | 'proposal'

export interface MapEntry {
  v1Id: string
  companyId: string
  /** `n-…` for entities, `[[Stem#^f-…]]` for lines, `sg-…`/fingerprint for proposals */
  ref: string
  noteId: string
  path: string
  status: MigratedStatus | 'note'
}

export interface NoteAppend {
  companyId: string
  path: string
  noteId: string
  observations: ObservationInput[]
  history: HistoryInput[]
  relations: RelationInput[]
}

export interface ProposalPlan {
  companyId: string
  v1Id: string
  kind: 'fact_supersede' | 'harvest' | 'relation' | 'assign_company'
  ops: VaultOp[]
  quote: string
  why: string
  noteId: string
  path: string
  fingerprint: string
}

export interface PlannedLines {
  notes: Set<string>
  active: Set<string>
  history: Set<string>
}

export interface V1Plan {
  creates: NoteCreate[]
  appends: NoteAppend[]
  proposals: ProposalPlan[]
  map: MapEntry[]
  /** what this run writes, per company: verified against the index after the reindex */
  written: Map<string, PlannedLines>
  /** v1 entity id -> its primary note */
  notesOf: Map<string, { companyId: string; noteId: string; path: string }>
  warnings: string[]
}

const AGENT_ACTORS = new Set<string>(ACTORS.filter((a) => a !== 'user' && a !== 'migration' && a !== 'suggestion'))
const CONTESTED_PREFIX = 'contested: supersedes '

/** `YYYY-MM-DD` of a v1 timestamp (local time, as Obsidian shows it). */
function dateOf(at: string | null | undefined, fallback: Date): string {
  const d = at ? new Date(at) : null
  return isoDate(d && !Number.isNaN(d.getTime()) ? d : fallback)
}

/** Provenance of a v1 row: the grant's adapter and run (or session), `user` for user rows. */
export function v1Prov(actor: string, grant: V1Grant | undefined, at: string | null, now: Date): { actor: Actor; runId: string | null; sessionId: string | null; date: string } {
  const a: Actor = actor === 'user' ? 'user' : grant && AGENT_ACTORS.has(grant.adapter) ? (grant.adapter as Actor) : 'migration'
  const runId = grant?.run_id && /^[A-Za-z0-9_-]+$/.test(grant.run_id) ? grant.run_id : null
  const sessionId = !runId && grant?.session_id && /^[A-Za-z0-9_-]+$/.test(grant.session_id) ? grant.session_id : null
  return { actor: a, runId, sessionId, date: dateOf(at, now) }
}

/** Deterministic note id for an entity's second note (its global facts in Personal), so re-runs find it again. */
export function derivedNoteId(v1Id: string, companyId: string): string {
  return `n-${sha1Hex(`v1:${companyId}:${v1Id}`).slice(0, 10)}`
}

/**
 * Block id of a v1 fact or relation: `f-<suffix>` for standard ids, else derived from the v1 id (deterministic, so a
 * re-run recognises the line instead of appending it again under a fresh id).
 */
export function v1LineBlockId(v1Id: string, kind: 'f' | 'r'): string {
  return v1ToBlockId(v1Id) ?? `${kind}-${sha1Hex(`v1:${v1Id}`).slice(0, 10)}`
}

interface Bucket {
  entity: V1Entity
  companyId: string
  primary: boolean
  facts: V1Fact[]
  relations: V1Relation[]
}

export function planV1(v1: V1Snapshot, ctx: V1Context): V1Plan {
  const plan: V1Plan = { creates: [], appends: [], proposals: [], map: [], written: new Map(), notesOf: new Map(), warnings: [] }
  const entityById = new Map(v1.entities.map((e) => [e.id, e]))
  // a line lives where it was written: global scope in Personal, project scope in its repo's company. v1 lets an agent
  // write project facts onto a global entity (repo_id NULL), so the entity's own repo is only the fallback
  const companyOfLine = (e: V1Entity, l: { scope: string; repo_id: string | null }): string =>
    l.scope === 'global' ? ctx.personalId : l.repo_id ? ctx.companyOfRepo(l.repo_id) : e.repo_id ? ctx.companyOfRepo(e.repo_id) : ctx.personalId
  // the primary note (v1 id): the entity's repo's company; a global entity whose project lines all come from one
  // company lives there, else in Personal
  const primaryOf = new Map<string, string>()
  for (const e of v1.entities) {
    if (e.repo_id) {
      primaryOf.set(e.id, ctx.companyOfRepo(e.repo_id))
      continue
    }
    const homes = new Set<string>()
    for (const f of v1.facts) if (f.entity_id === e.id && f.scope !== 'global') homes.add(companyOfLine(e, f))
    for (const r of v1.relations) if (r.from_id === e.id && r.scope !== 'global') homes.add(companyOfLine(e, r))
    primaryOf.set(e.id, homes.size === 1 ? [...homes][0] : ctx.personalId)
  }
  const companyOfEntity = (e: V1Entity): string => primaryOf.get(e.id) ?? ctx.personalId
  // who invalidated a line (the v1 event), for the History provenance
  const invalidatedBy = new Map<string, V1Event>()
  for (const ev of v1.events) if (ev.op === 'invalidate' && (ev.target_kind === 'fact' || ev.target_kind === 'relation')) invalidatedBy.set(ev.target_id, ev)
  const factById = new Map(v1.facts.map((f) => [f.id, f]))

  // entity x company buckets: the primary note always exists; global-scope facts go to a Personal note
  const buckets = new Map<string, Bucket>()
  const bucket = (e: V1Entity, companyId: string): Bucket => {
    const key = `${e.id}|${companyId}`
    let b = buckets.get(key)
    if (!b) {
      b = { entity: e, companyId, primary: companyId === companyOfEntity(e), facts: [], relations: [] }
      buckets.set(key, b)
    }
    return b
  }
  for (const e of v1.entities) bucket(e, companyOfEntity(e))
  // fact id -> company of the note it lands in (a contested supersede only targets a line in its own vault)
  const factCompany = new Map<string, string>()
  for (const f of v1.facts) {
    const e = entityById.get(f.entity_id)
    if (!e) {
      plan.warnings.push(`v1 fact ${f.id} belongs to a missing entity; not migrated`)
      continue
    }
    const companyId = companyOfLine(e, f)
    factCompany.set(f.id, companyId)
    bucket(e, companyId).facts.push(f)
  }
  for (const r of v1.relations) {
    const e = entityById.get(r.from_id)
    if (!e) {
      plan.warnings.push(`v1 relation ${r.id} starts at a missing entity; not migrated`)
      continue
    }
    bucket(e, companyOfLine(e, r)).relations.push(r)
  }

  // pass 1: note id and path per bucket (paths reserve basenames, so link targets are known before rendering)
  const placed = new Map<string, { noteId: string; path: string; exists: boolean; stem: string }>()
  for (const [key, b] of buckets) {
    const view = ctx.views.get(b.companyId)
    if (!view) {
      plan.warnings.push(`v1 entity ${b.entity.id}: company ${b.companyId} has no vault; ${b.facts.length} facts and ${b.relations.length} relations not migrated`)
      continue
    }
    let noteId = b.primary ? v1EntityToNoteId(b.entity.id) : null
    if (!noteId) {
      if (b.primary) plan.warnings.push(`v1 entity ${b.entity.id} has a non-standard id; its note gets a derived id`)
      noteId = derivedNoteId(b.entity.id, b.companyId)
    }
    const existing = view.byId.get(noteId)
    if (existing) {
      placed.set(key, { noteId, path: existing.path, exists: true, stem: noteLinkTarget(pathStem(existing.path)) })
      continue
    }
    const type = normalizeNoteType(b.entity.type)
    const rel = pathForNewNote({ title: b.entity.name, type }, (k) => view.taken.has(k))
    view.taken.add(normName(pathStem(rel)))
    placed.set(key, { noteId, path: rel, exists: false, stem: noteLinkTarget(pathStem(rel)) })
  }
  const linkTo = (companyId: string, entityId: string): string | null => {
    const p = placed.get(`${entityId}|${companyId}`)
    return p ? p.stem : null
  }

  // pass 2: lines, notes, proposals
  const removed = new Map<string, { lines: number; notes: number }>()
  const removedIn = (companyId: string) => {
    const r = removed.get(companyId) ?? { lines: 0, notes: 0 }
    removed.set(companyId, r)
    return r
  }
  for (const [key, b] of buckets) {
    const view = ctx.views.get(b.companyId)
    const at = placed.get(key)
    if (!view || !at) continue
    if (b.primary) plan.notesOf.set(b.entity.id, { companyId: b.companyId, noteId: at.noteId, path: at.path })
    const written = plan.written.get(b.companyId) ?? { notes: new Set<string>(), active: new Set<string>(), history: new Set<string>() }
    plan.written.set(b.companyId, written)
    const observations: ObservationInput[] = []
    const history: HistoryInput[] = []
    const relations: RelationInput[] = []
    const ref = (blockId: string) => `[[${at.stem}#^${blockId}]]`
    const prior = ctx.migrated?.get(b.companyId)
    const wasLine = (v1Id: string) => ['active', 'superseded', 'invalid'].includes(prior?.[v1Id]?.status ?? '')
    // new to the vault: not there now, and not written by an earlier run (then a human removed it)
    const fresh = (blockId: string, v1Id: string) => {
      if (view.blockIds.has(blockId)) return false
      if (!wasLine(v1Id)) return true
      removedIn(b.companyId).lines++
      return false
    }

    for (const f of b.facts) {
      if (!v1ToBlockId(f.id)) plan.warnings.push(`v1 fact ${f.id} has a non-standard id; its block id is derived from it`)
      const blockId = v1LineBlockId(f.id, 'f')
      const prov = v1Prov(f.actor, f.grant_id ? v1.grants.get(f.grant_id) : undefined, f.created_at, ctx.now)
      if (f.status === 'pending') {
        plan.proposals.push(pendingFactProposal(f, b.companyId, at, factById, factCompany))
        plan.map.push({ v1Id: f.id, companyId: b.companyId, ref: `migration:${f.id}`, noteId: at.noteId, path: at.path, status: 'proposal' })
        continue
      }
      if (f.status === 'active') {
        if (fresh(blockId, f.id)) {
          observations.push({ category: f.kind || 'fact', text: f.text, pinned: !!f.pinned, prov, blockId })
          written.active.add(blockId)
        }
        plan.map.push({ v1Id: f.id, companyId: b.companyId, ref: ref(blockId), noteId: at.noteId, path: at.path, status: 'active' })
      } else {
        const superseded = f.invalid_reason === 'superseded' || !!f.superseded_by
        const by = f.superseded_by ? factById.get(f.superseded_by) : undefined
        const ev = invalidatedBy.get(f.id)
        const histProv = by
          ? v1Prov(by.actor, by.grant_id ? v1.grants.get(by.grant_id) : undefined, f.invalidated_at ?? by.created_at, ctx.now)
          : v1Prov(ev?.actor === 'user' || !ev ? 'user' : 'agent', ev?.grant_id ? v1.grants.get(ev.grant_id) : undefined, f.invalidated_at ?? f.updated_at, ctx.now)
        if (fresh(blockId, f.id)) {
          history.push(
            superseded
              ? { state: 'superseded', text: f.text, supersededBy: f.superseded_by ? v1LineBlockId(f.superseded_by, 'f') : null, prov: histProv, blockId }
              : { state: 'invalidated', text: f.text, reason: f.invalid_reason || 'invalidated', prov: histProv, blockId }
          )
          written.history.add(blockId)
        }
        plan.map.push({ v1Id: f.id, companyId: b.companyId, ref: ref(blockId), noteId: at.noteId, path: at.path, status: superseded ? 'superseded' : 'invalid' })
      }
      if (f.scope === 'global') {
        plan.proposals.push({
          companyId: b.companyId,
          v1Id: f.id,
          kind: 'assign_company',
          ops: [],
          quote: f.text,
          why: `A global v1 fact about [[${at.stem}]]; assign it to the company it belongs to`,
          noteId: at.noteId,
          path: at.path,
          fingerprint: `migration:assign:${f.id}`
        })
      }
    }

    for (const r of b.relations) {
      if (!v1ToBlockId(r.id)) plan.warnings.push(`v1 relation ${r.id} has a non-standard id; its block id is derived from it`)
      const blockId = v1LineBlockId(r.id, 'r')
      const target = entityById.get(r.to_id)
      if (!target) continue
      const stem = linkTo(b.companyId, target.id)
      if (!stem) plan.warnings.push(`relation ${r.id}: [[${target.name}]] lives in another company's vault; written as a ghost link`)
      const to = stem ?? target.name.replace(/[[\]|#^]/g, '-')
      const prov = v1Prov(r.actor, r.grant_id ? v1.grants.get(r.grant_id) : undefined, r.created_at, ctx.now)
      if (r.status === 'pending') {
        plan.proposals.push({
          companyId: b.companyId,
          v1Id: r.id,
          kind: 'relation',
          ops: [{ op: 'relate', from: at.noteId, rel: r.type, to }],
          quote: `${r.type} [[${to}]]`,
          why: r.invalid_reason ?? 'pending review in v1 memory',
          noteId: at.noteId,
          path: at.path,
          fingerprint: `migration:${r.id}`
        })
        plan.map.push({ v1Id: r.id, companyId: b.companyId, ref: `migration:${r.id}`, noteId: at.noteId, path: at.path, status: 'proposal' })
        continue
      }
      if (r.status === 'active') {
        if (fresh(blockId, r.id)) {
          relations.push({ rel: r.type, target: to, prov, blockId })
          written.active.add(blockId)
        }
      } else if (fresh(blockId, r.id)) {
        const ev = invalidatedBy.get(r.id)
        history.push({
          state: 'invalidated',
          text: `${/^[A-Za-z][A-Za-z0-9_-]*$/.test(r.type) ? r.type : `"${r.type}"`} [[${to}]]`,
          reason: r.invalid_reason || 'invalidated',
          prov: v1Prov(ev?.actor === 'user' || !ev ? 'user' : 'agent', ev?.grant_id ? v1.grants.get(ev.grant_id) : undefined, r.invalidated_at ?? r.updated_at, ctx.now),
          blockId
        })
        written.history.add(blockId)
      }
      plan.map.push({ v1Id: r.id, companyId: b.companyId, ref: ref(blockId), noteId: at.noteId, path: at.path, status: r.status === 'active' ? 'active' : 'invalid' })
    }

    const noteEntry: MapEntry = { v1Id: b.entity.id, companyId: b.companyId, ref: at.noteId, noteId: at.noteId, path: at.path, status: 'note' }
    if (at.exists) {
      plan.map.push(noteEntry)
      if (observations.length || history.length || relations.length) plan.appends.push({ companyId: b.companyId, path: at.path, noteId: at.noteId, observations, history, relations })
      continue
    }
    // a Personal note for global facts only exists when there is something to put in it
    if (!b.primary && !b.facts.length && !b.relations.length) continue
    // an earlier run wrote this note and a human removed it: only lines new since then bring it back
    if (prior?.[b.entity.id]?.status === 'note' && !observations.length && !history.length && !relations.length) {
      removedIn(b.companyId).notes++
      continue
    }
    plan.map.push(noteEntry)
    written.notes.add(at.noteId)
    plan.creates.push(renderEntityNote(b, at, ctx, v1.aliases.get(b.entity.id) ?? [], { observations, history, relations }))
  }
  for (const [companyId, r] of removed) {
    const what = [r.notes ? `${r.notes} notes` : '', r.lines ? `${r.lines} lines` : ''].filter(Boolean).join(' and ')
    plan.warnings.push(`${companyId}: ${what} an earlier migration wrote were removed from the vault since; not added back`)
  }
  return plan
}

function renderEntityNote(
  b: Bucket,
  at: { noteId: string; path: string },
  ctx: V1Context,
  aliases: string[],
  lines: { observations: ObservationInput[]; history: HistoryInput[]; relations: RelationInput[] }
): NoteCreate {
  const e = b.entity
  const type = normalizeNoteType(e.type)
  const stems = ctx.repoStems.get(b.companyId)
  const repoIds = e.repo_id ? [e.repo_id] : [...new Set([...b.facts, ...b.relations].map((l) => (l.scope === 'global' ? null : l.repo_id)).filter((id): id is string => !!id))]
  const repoLinks = repoIds.map((id) => stems?.get(id)).filter((s): s is string => !!s).map((s) => `[[${s}]]`)
  const seen = new Set([normName(e.name)])
  const cleanAliases: string[] = []
  for (const a of aliases) {
    const k = normName(a)
    if (!a.trim() || seen.has(k)) continue
    seen.add(k)
    cleanAliases.push(a.trim())
  }
  const text = renderNote({
    id: at.noteId,
    title: e.name,
    type,
    aliases: cleanAliases,
    properties: repoLinks.length ? [['repos', repoLinks]] : [],
    created: dateOf(e.created_at, ctx.now),
    modified: dateOf(e.updated_at, ctx.now),
    source: 'migration',
    summary: e.summary || null,
    observations: lines.observations,
    relations: lines.relations,
    history: lines.history
  })
  return {
    companyId: b.companyId,
    path: at.path,
    noteId: at.noteId,
    title: e.name,
    type,
    text,
    v1Id: e.id,
    observations: lines.observations.length,
    historyLines: lines.history.length,
    relations: lines.relations.length
  }
}

/** A pending v1 fact: a contested supersede replays as `supersede`, a quarantined fact as an `observe` to review. */
function pendingFactProposal(
  f: V1Fact,
  companyId: string,
  at: { noteId: string; path: string; stem: string },
  facts: Map<string, V1Fact>,
  factCompany: Map<string, string>
): ProposalPlan {
  const reason = f.invalid_reason ?? ''
  // only lines in this vault: a supersede of a global fact (now in Personal) would conflict on accept
  const targets = reason.startsWith(CONTESTED_PREFIX)
    ? reason
        .slice(CONTESTED_PREFIX.length)
        .split(',')
        .map((s) => s.trim())
        .filter((id) => facts.get(id)?.status === 'active' && factCompany.get(id) === companyId)
    : []
  const blockId = targets.length ? v1LineBlockId(targets[0], 'f') : null
  const ops: VaultOp[] = blockId
    ? [{ op: 'supersede', blockId, text: f.text }]
    : [{ op: 'observe', note: at.noteId, category: f.kind || 'fact', text: f.text }]
  for (const t of targets.slice(1)) ops.push({ op: 'invalidate', blockId: v1LineBlockId(t, 'f'), reason: 'superseded' })
  return {
    companyId,
    v1Id: f.id,
    kind: blockId ? 'fact_supersede' : 'harvest',
    ops,
    quote: blockId ? (facts.get(targets[0])?.text ?? f.text) : f.text,
    why: reason || 'pending review in v1 memory',
    noteId: at.noteId,
    path: at.path,
    fingerprint: `migration:${f.id}`
  }
}

// ---------- events ----------

export interface EventPlan {
  companyId: string
  seq: number
  /** idempotency key on mem_event.op_id */
  opId: string
  record: EventInput
}

const KIND_MAP: Record<string, EventInput['targetKind']> = { entity: 'note', fact: 'fact', relation: 'relation', alias: 'alias', memory: 'memory' }

function parseJson(s: string | null): unknown {
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** §9 step 5: every mem_event row, bound to the company, note path and block id it touched. */
export function planEvents(v1: V1Snapshot, plan: Pick<V1Plan, 'notesOf' | 'map'>, ctx: Pick<V1Context, 'personalId' | 'companyOfRepo'>): EventPlan[] {
  const factEntity = new Map(v1.facts.map((f) => [f.id, f]))
  const relEntity = new Map(v1.relations.map((r) => [r.id, r]))
  const lineAt = new Map<string, MapEntry>()
  for (const m of plan.map) if (m.status !== 'note') lineAt.set(m.v1Id, m)
  return v1.events.map((ev) => {
    const before = parseJson(ev.before_json)
    const after = parseJson(ev.after_json)
    const fact = ev.target_kind === 'fact' ? factEntity.get(ev.target_id) : undefined
    const rel = ev.target_kind === 'relation' ? relEntity.get(ev.target_id) : undefined
    const entityId = ev.entity_id ?? (ev.target_kind === 'entity' ? ev.target_id : (fact?.entity_id ?? rel?.from_id ?? null))
    // a fact or relation event goes where the line lives; other events follow the entity's primary note
    const line = fact || rel ? lineAt.get(ev.target_id) : undefined
    const note = line ? { companyId: line.companyId, noteId: line.noteId, path: line.path } : entityId ? plan.notesOf.get(entityId) : undefined
    // a global line lives in Personal; a deleted entity falls back to the repo the row named, else Personal
    const repoOf = (v: unknown): string | null => (v && typeof v === 'object' && typeof (v as { repo_id?: unknown }).repo_id === 'string' ? (v as { repo_id: string }).repo_id : null)
    let companyId = note?.companyId ?? null
    if (fact?.scope === 'global' || rel?.scope === 'global') companyId = ctx.personalId
    if (!companyId) {
      const repo = repoOf(after) ?? repoOf(before)
      companyId = repo ? ctx.companyOfRepo(repo) : ctx.personalId
    }
    const samePlace = note && note.companyId === companyId
    const targetId = ev.target_kind === 'entity' ? (v1EntityToNoteId(ev.target_id) ?? ev.target_id) : ev.target_id
    const opId = `v1:${ev.seq}`
    return {
      companyId,
      seq: ev.seq,
      opId,
      record: {
        ts: ev.ts,
        companyId,
        op: ev.op,
        targetKind: KIND_MAP[ev.target_kind] ?? 'memory',
        targetId,
        entityId: samePlace ? note.noteId : entityId ? (v1EntityToNoteId(entityId) ?? entityId) : null,
        path: samePlace ? note.path : null,
        blockId: ev.target_kind === 'fact' || ev.target_kind === 'relation' ? (line?.status === 'proposal' ? null : v1LineBlockId(ev.target_id, ev.target_kind === 'fact' ? 'f' : 'r')) : null,
        actor: ev.actor === 'agent' ? (v1.grants.get(ev.grant_id ?? '')?.adapter ?? 'agent') : ev.actor,
        grantId: ev.grant_id,
        runId: ev.run_id,
        opId,
        before,
        after: after === undefined ? { migratedFrom: `memory.db#${ev.seq}` } : after
      }
    }
  })
}
