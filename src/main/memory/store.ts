/**
 * The one code path for every memory.db read and write (MEMORY.md §2–§4, PO1–PO10).
 * Pure better-sqlite3 + node:crypto. NO Electron imports: main and the hivemem MCP server both import it.
 * Every write is one IMMEDIATE transaction (takes the write lock up front: no busy-upgrade deadlock between processes).
 * Reads never write (PO4).
 */
import type { AdapterId, Id } from '../../shared/types'
import type {
  MemoryActor,
  MemoryEntity,
  MemoryFact,
  MemoryFactKind,
  MemoryGrantInfo,
  MemoryMode,
  MemoryProvenance,
  MemoryRelation,
  MemoryScope,
  MemoryStatus,
  MemoryTransport
} from '../../shared/memory'
import { MEMORY_FACT_KINDS } from '../../shared/memory'
import { newId } from '../../shared/ids'
import type { MemDB } from './db'
import { credentialHit, imperativeHit, normalizeName, normalizeText, secretHit, textHash, type FingerprintFile } from './screen'

// ---------- limits (MEMORY.md §4.2, §9) ----------
export const LIMITS = {
  writesPerGrant: 30,
  nameLen: 120,
  factLen: 1000,
  factsPerCall: 10,
  relationsPerCall: 10,
  aliasesPerCall: 5,
  reasonLen: 200,
  typeLen: 40,
  maxActiveFacts: 50_000
}

/** A refusal shown to the agent / user as a one-line message. */
export class MemoryRefusal extends Error {
  constructor(
    message: string,
    public code: 'refused' | 'not_found' | 'conflict' | 'validation' = 'refused'
  ) {
    super(message)
    this.name = 'MemoryRefusal'
  }
}

// ---------- row types ----------
export interface GrantRow {
  id: string
  mode: 'read' | 'read-write'
  adapter: string
  transport: MemoryTransport
  profile_id: string | null
  profile_name: string | null
  model: string | null
  repo_id: string | null
  repo_name: string | null
  run_id: string | null
  run_title: string | null
  workflow_id: string | null
  step_id: string | null
  node_id: string | null
  node_label: string | null
  session_id: string | null
  writes: number
  created_at: string
  closed_at: string | null
}
export interface EntityRow {
  id: string
  repo_id: string | null
  name: string
  norm_name: string
  type: string
  summary: string
  actor: MemoryActor
  grant_id: string | null
  created_at: string
  updated_at: string
}
export interface FactRow {
  id: string
  entity_id: string
  text: string
  text_hash: string
  kind: MemoryFactKind
  scope: MemoryScope
  repo_id: string | null
  status: MemoryStatus
  reviewed: number
  pinned: number
  invalidated_at: string | null
  invalid_reason: string | null
  superseded_by: string | null
  actor: MemoryActor
  grant_id: string | null
  edited_by_user: number
  created_at: string
  updated_at: string
}
export interface RelationRow {
  id: string
  from_id: string
  to_id: string
  type: string
  norm_type: string
  scope: MemoryScope
  repo_id: string | null
  status: MemoryStatus
  reviewed: number
  invalidated_at: string | null
  invalid_reason: string | null
  superseded_by: string | null
  actor: MemoryActor
  grant_id: string | null
  created_at: string
  updated_at: string
}

/** What a reader can see. repo = that repo's project rows + global rows. */
export type Visibility = { kind: 'all' } | { kind: 'global' } | { kind: 'repo'; repoId: Id }
export const visForGrant = (g: Pick<GrantRow, 'repo_id'>): Visibility =>
  g.repo_id ? { kind: 'repo', repoId: g.repo_id } : { kind: 'global' }

export function scopedSql(v: Visibility, a: string): { sql: string; params: unknown[] } {
  if (v.kind === 'all') return { sql: '1=1', params: [] }
  if (v.kind === 'global') return { sql: `${a}.scope = 'global'`, params: [] }
  return { sql: `((${a}.scope = 'project' AND ${a}.repo_id = ?) OR ${a}.scope = 'global')`, params: [v.repoId] }
}
export function entityVisSql(v: Visibility, a: string): { sql: string; params: unknown[] } {
  const hasGlobal = `EXISTS (SELECT 1 FROM mem_fact gf WHERE gf.entity_id = ${a}.id AND gf.scope = 'global')`
  if (v.kind === 'all') return { sql: '1=1', params: [] }
  if (v.kind === 'global') return { sql: `(${a}.repo_id IS NULL OR ${hasGlobal})`, params: [] }
  return { sql: `(${a}.repo_id = ? OR ${a}.repo_id IS NULL OR ${hasGlobal})`, params: [v.repoId] }
}

export interface GrantInput {
  mode: 'read' | 'read-write'
  adapter: AdapterId
  transport: MemoryTransport
  profileId?: Id | null
  profileName?: string | null
  model?: string | null
  repoId?: Id | null
  repoName?: string | null
  runId?: Id | null
  runTitle?: string | null
  workflowId?: Id | null
  stepId?: Id | null
  nodeId?: string | null
  nodeLabel?: string | null
  sessionId?: Id | null
}

export interface AgentWriteArgs {
  entity: string
  entity_type?: string
  aliases?: string[]
  facts?: { text: string; kind?: MemoryFactKind; supersedes?: string[] }[]
  relations?: { type: string; to: string; supersedes?: string[] }[]
}
export interface AgentWriteResult {
  entity: { id: Id; name: string; created: boolean; possible_duplicates: { id: Id; name: string; scope: MemoryScope }[] }
  facts: {
    id: Id
    result: 'added' | 'duplicate' | 'pending_review' | 'contested'
    superseded?: Id[]
    similar?: { id: Id; text: string; source: string }[]
    why?: string
  }[]
  relations: { id: Id; result: 'added' | 'duplicate' | 'contested'; to_id: Id; created_entity: boolean; superseded?: Id[]; why?: string }[]
  writes_left: number
}
export interface AgentInvalidateResult {
  items: { id: Id; result: 'invalidated' | 'contested' | 'not_found' | 'already_invalid' }[]
  writes_left: number
}

export interface StoreOptions {
  now?: () => Date
  /** Secret fingerprints for write-time screening (§9.1). Called per write; may re-read a file. */
  fingerprints?: () => FingerprintFile | null
}

type Ev = {
  op: string
  kind: 'entity' | 'fact' | 'relation' | 'alias' | 'memory'
  id: string
  entityId?: string | null
  actor: MemoryActor | 'system'
  grant?: GrantRow | null
  runId?: string | null
  before?: unknown
  after?: unknown
}

const CONTESTED_PREFIX = 'contested: supersedes '

export class MemoryStore {
  readonly now: () => Date
  private fp: () => FingerprintFile | null

  constructor(
    readonly db: MemDB,
    opts: StoreOptions = {}
  ) {
    this.now = opts.now ?? (() => new Date())
    this.fp = opts.fingerprints ?? (() => null)
  }

  private ts(): string {
    return this.now().toISOString()
  }
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  // ======================================================================================
  // meta
  // ======================================================================================
  isPaused(): boolean {
    const r = this.db.prepare("SELECT value FROM mem_meta WHERE key = 'agent_writes_paused'").get() as { value: string } | undefined
    return r?.value === '1'
  }
  setPaused(paused: boolean): void {
    this.tx(() => {
      this.db
        .prepare("INSERT INTO mem_meta(key, value) VALUES ('agent_writes_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(paused ? '1' : '0')
      this.event({ op: 'pause', kind: 'memory', id: 'memory', actor: 'user', after: { paused } })
    })
  }
  lastSeq(): number {
    return (this.db.prepare('SELECT ifnull(max(seq), 0) AS s FROM mem_event').get() as { s: number }).s
  }

  // ======================================================================================
  // grants
  // ======================================================================================
  createGrant(g: GrantInput): GrantRow {
    const row: GrantRow = {
      id: newId('memGrant'),
      mode: g.mode,
      adapter: g.adapter,
      transport: g.transport,
      profile_id: g.profileId ?? null,
      profile_name: g.profileName ?? null,
      model: g.model ?? null,
      repo_id: g.repoId ?? null,
      repo_name: g.repoName ?? null,
      run_id: g.runId ?? null,
      run_title: g.runTitle ?? null,
      workflow_id: g.workflowId ?? null,
      step_id: g.stepId ?? null,
      node_id: g.nodeId ?? null,
      node_label: g.nodeLabel ?? null,
      session_id: g.sessionId ?? null,
      writes: 0,
      created_at: this.ts(),
      closed_at: null
    }
    this.tx(() =>
      this.db
        .prepare(
          `INSERT INTO mem_grant (id, mode, adapter, transport, profile_id, profile_name, model, repo_id, repo_name, run_id,
             run_title, workflow_id, step_id, node_id, node_label, session_id, writes, created_at, closed_at)
           VALUES (@id, @mode, @adapter, @transport, @profile_id, @profile_name, @model, @repo_id, @repo_name, @run_id,
             @run_title, @workflow_id, @step_id, @node_id, @node_label, @session_id, @writes, @created_at, @closed_at)`
        )
        .run(row)
    )
    return row
  }
  getGrant(id: string): GrantRow | null {
    return (this.db.prepare('SELECT * FROM mem_grant WHERE id = ?').get(id) as GrantRow | undefined) ?? null
  }
  closeGrant(id: string): void {
    this.tx(() => this.db.prepare('UPDATE mem_grant SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(this.ts(), id))
  }
  /** Boot recovery: every grant left open by a previous Hive process is closed. Returns how many. */
  closeAllOpenGrants(): number {
    return this.tx(() => this.db.prepare('UPDATE mem_grant SET closed_at = ? WHERE closed_at IS NULL').run(this.ts()).changes)
  }
  listGrants(q: { runId?: Id; sessionId?: Id }): MemoryGrantInfo[] {
    const where: string[] = []
    const params: unknown[] = []
    if (q.runId) {
      where.push('g.run_id = ?')
      params.push(q.runId)
    }
    if (q.sessionId) {
      where.push('g.session_id = ?')
      params.push(q.sessionId)
    }
    const rows = this.db
      .prepare(
        `SELECT g.*,
           (SELECT count(*) FROM mem_fact f WHERE f.grant_id = g.id) AS n_facts,
           (SELECT count(*) FROM mem_relation r WHERE r.grant_id = g.id) AS n_rel,
           (SELECT count(*) FROM mem_event e WHERE e.grant_id = g.id AND e.op = 'invalidate') AS n_inv
         FROM mem_grant g ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.created_at`
      )
      .all(...params) as (GrantRow & { n_facts: number; n_rel: number; n_inv: number })[]
    return rows.map((g) => ({
      ...grantProvenance(g),
      mode: g.mode as Exclude<MemoryMode, 'off'>,
      closedAt: g.closed_at,
      wrote: { facts: g.n_facts, relations: g.n_rel, invalidated: g.n_inv }
    }))
  }

  private writableGrant(grantId: string): GrantRow {
    const g = this.getGrant(grantId)
    if (!g) throw new MemoryRefusal('Refused: unknown memory grant')
    if (g.closed_at) throw new MemoryRefusal('Refused: this memory grant is closed (the step or session ended)')
    if (g.mode !== 'read-write') throw new MemoryRefusal('Refused: memory is read-only for this step')
    if (!g.repo_id) throw new MemoryRefusal('Refused: no project here (Chat / scratch); memory is read-only')
    if (this.isPaused()) throw new MemoryRefusal('Refused: the user paused agent memory writes')
    return g
  }
  private takeWrites(g: GrantRow, n: number): number {
    if (g.writes + n > LIMITS.writesPerGrant) {
      throw new MemoryRefusal(
        `Refused: write limit reached (${LIMITS.writesPerGrant} per step; ${LIMITS.writesPerGrant - g.writes} left)`
      )
    }
    this.db.prepare('UPDATE mem_grant SET writes = writes + ? WHERE id = ?').run(n, g.id)
    g.writes += n
    return LIMITS.writesPerGrant - g.writes
  }
  private screenSecrets(texts: string[]): void {
    const fp = this.fp()
    for (const t of texts) {
      const hit = secretHit(fp, t)
      if (hit) throw new MemoryRefusal(`Refused: text contains a stored secret (${hit}). Do not store credentials in memory.`, 'validation')
      const cred = credentialHit(t)
      if (cred) throw new MemoryRefusal(`Refused: text looks like a credential (${cred}). Do not store credentials in memory.`, 'validation')
    }
  }

  // ======================================================================================
  // events + FTS
  // ======================================================================================
  private event(e: Ev): void {
    this.db
      .prepare(
        `INSERT INTO mem_event (ts, op, target_kind, target_id, entity_id, actor, grant_id, run_id, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.ts(),
        e.op,
        e.kind,
        e.id,
        e.entityId ?? null,
        e.actor,
        e.grant?.id ?? null,
        e.runId ?? e.grant?.run_id ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after)
      )
  }
  private ftsDelete(id: string): void {
    this.db.prepare('DELETE FROM mem_fts WHERE target_id = ?').run(id)
  }
  private ftsEntity(id: string): void {
    const e = this.entityRow(id)
    this.ftsDelete(id)
    if (!e) return
    const aliases = this.aliases(id)
    this.db
      .prepare("INSERT INTO mem_fts (target_kind, target_id, entity_id, name, body) VALUES ('entity', ?, ?, ?, ?)")
      .run(id, id, [e.name, ...aliases].join(' '), `${e.summary} ${e.type}`)
  }
  private ftsFact(id: string): void {
    const f = this.factRow(id)
    this.ftsDelete(id)
    if (!f) return
    const e = this.entityRow(f.entity_id)
    this.db
      .prepare("INSERT INTO mem_fts (target_kind, target_id, entity_id, name, body) VALUES ('fact', ?, ?, ?, ?)")
      .run(id, f.entity_id, e?.name ?? '', f.text)
  }
  private reindexEntity(id: string): void {
    this.ftsEntity(id)
    for (const f of this.db.prepare('SELECT id FROM mem_fact WHERE entity_id = ?').all(id) as { id: string }[]) this.ftsFact(f.id)
  }

  // ======================================================================================
  // row access
  // ======================================================================================
  entityRow(id: string): EntityRow | null {
    return (this.db.prepare('SELECT * FROM mem_entity WHERE id = ?').get(id) as EntityRow | undefined) ?? null
  }
  factRow(id: string): FactRow | null {
    return (this.db.prepare('SELECT * FROM mem_fact WHERE id = ?').get(id) as FactRow | undefined) ?? null
  }
  relationRow(id: string): RelationRow | null {
    return (this.db.prepare('SELECT * FROM mem_relation WHERE id = ?').get(id) as RelationRow | undefined) ?? null
  }
  aliases(entityId: string): string[] {
    return (this.db.prepare('SELECT alias FROM mem_alias WHERE entity_id = ? ORDER BY alias').all(entityId) as { alias: string }[]).map(
      (r) => r.alias
    )
  }

  /**
   * Entity lookup for a reader (§4.2 step 4): id, then norm_name in the repo, then global, then aliases in both.
   * repoId null = global only.
   */
  resolveEntity(nameOrId: string, repoId: string | null): EntityRow | null {
    const s = nameOrId.trim()
    if (/^ment_[0-9a-z]+$/.test(s)) {
      const e = this.entityRow(s)
      if (e && (e.repo_id === null || e.repo_id === repoId)) return e
    }
    const norm = normalizeName(s)
    if (!norm) return null
    if (repoId) {
      const e = this.db.prepare('SELECT * FROM mem_entity WHERE repo_id = ? AND norm_name = ?').get(repoId, norm) as EntityRow | undefined
      if (e) return e
    }
    const g = this.db.prepare('SELECT * FROM mem_entity WHERE repo_id IS NULL AND norm_name = ?').get(norm) as EntityRow | undefined
    if (g) return g
    const a = this.db
      .prepare(
        `SELECT e.* FROM mem_alias a JOIN mem_entity e ON e.id = a.entity_id
         WHERE a.norm_alias = ? AND (e.repo_id IS ? OR e.repo_id IS NULL)
         ORDER BY e.repo_id IS NULL, e.created_at LIMIT 1`
      )
      .get(norm, repoId) as EntityRow | undefined
    return a ?? null
  }

  private addAliases(entityId: string, aliases: string[]): string[] {
    const e = this.entityRow(entityId)!
    const added: string[] = []
    const ins = this.db.prepare('INSERT OR IGNORE INTO mem_alias (entity_id, alias, norm_alias) VALUES (?, ?, ?)')
    for (const a of aliases) {
      const alias = a.trim().slice(0, LIMITS.nameLen)
      const norm = normalizeName(alias)
      if (!norm || norm === e.norm_name) continue
      if (ins.run(entityId, alias, norm).changes) added.push(alias)
    }
    return added
  }

  private insertEntity(e: { repoId: string | null; name: string; type?: string; summary?: string; actor: MemoryActor; grant?: GrantRow | null }): EntityRow {
    const ts = this.ts()
    const name = e.name.trim()
    if (!name || name.length > LIMITS.nameLen) throw new MemoryRefusal(`Refused: entity name must be 1..${LIMITS.nameLen} chars`, 'validation')
    const row: EntityRow = {
      id: newId('memEntity'),
      repo_id: e.repoId,
      name,
      norm_name: normalizeName(name),
      type: (e.type?.trim() || inferEntityType(name)).slice(0, LIMITS.typeLen),
      summary: (e.summary ?? '').slice(0, 500),
      actor: e.actor,
      grant_id: e.grant?.id ?? null,
      created_at: ts,
      updated_at: ts
    }
    this.db
      .prepare(
        `INSERT INTO mem_entity (id, repo_id, name, norm_name, type, summary, actor, grant_id, created_at, updated_at)
         VALUES (@id, @repo_id, @name, @norm_name, @type, @summary, @actor, @grant_id, @created_at, @updated_at)`
      )
      .run(row)
    this.event({ op: 'create', kind: 'entity', id: row.id, entityId: row.id, actor: e.actor, grant: e.grant, after: row })
    return row
  }

  private touchEntity(id: string): void {
    this.db.prepare('UPDATE mem_entity SET updated_at = ? WHERE id = ?').run(this.ts(), id)
  }

  private activeFactCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM mem_fact WHERE status = 'active'").get() as { n: number }).n
  }

  /**
   * FTS over an entity's other active facts; top n by bm25 (near-duplicate hints, §4.2 5.5). With `grant`, facts
   * written by that grant or any grant of the same run are left out: an agent's own earlier writes in this run are
   * not "existing memory", and listing them made agents report false duplicates.
   */
  similarFacts(entityId: string, text: string, excludeId: string | null, n = 3, grant?: Pick<GrantRow, 'id' | 'run_id'> | null): FactRow[] {
    const q = ftsQuery(text)
    if (!q) return []
    const sameRun = grant
      ? `AND (mf.grant_id IS NULL OR mf.grant_id NOT IN (SELECT sg.id FROM mem_grant sg WHERE sg.id = ? OR (? IS NOT NULL AND sg.run_id = ?)))`
      : ''
    const sameRunParams = grant ? [grant.id, grant.run_id, grant.run_id] : []
    return this.db
      .prepare(
        `SELECT mf.* FROM (SELECT target_id, bm25(mem_fts, 0, 0, 0, 2.0, 1.0) AS rank FROM mem_fts
                           WHERE mem_fts MATCH ? AND target_kind = 'fact' AND entity_id = ?) x
         JOIN mem_fact mf ON mf.id = x.target_id
         WHERE mf.status = 'active' AND mf.id IS NOT ? ${sameRun} ORDER BY x.rank LIMIT ?`
      )
      .all(q, entityId, excludeId, ...sameRunParams, n) as FactRow[]
  }

  sourceLabel(grantId: string | null, actor: MemoryActor, createdAt: string): string {
    const day = createdAt.slice(0, 10)
    if (actor === 'user') return `user, ${day}`
    const g = grantId ? this.getGrant(grantId) : null
    if (!g) return `agent · ${day}`
    const parts = [g.profile_name || g.adapter]
    if (g.run_title) parts.push(`run "${g.run_title}"`)
    else if (g.session_id) parts.push('session')
    if (g.node_label || g.node_id) parts.push(`step ${g.node_label || g.node_id}`)
    parts.push(day)
    return parts.join(' · ')
  }

  private invalidateFact(f: FactRow, reason: string, actor: MemoryActor | 'system', grant: GrantRow | null, supersededBy: string | null = null, runId?: string): void {
    const ts = this.ts()
    this.db
      .prepare("UPDATE mem_fact SET status = 'invalid', invalidated_at = ?, invalid_reason = ?, superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(ts, reason, supersededBy, ts, f.id)
    this.event({ op: 'invalidate', kind: 'fact', id: f.id, entityId: f.entity_id, actor, grant, runId, before: { status: f.status }, after: { status: 'invalid', reason, supersededBy } })
  }
  private invalidateRelation(r: RelationRow, reason: string, actor: MemoryActor | 'system', grant: GrantRow | null, supersededBy: string | null = null, runId?: string): void {
    const ts = this.ts()
    this.db
      .prepare("UPDATE mem_relation SET status = 'invalid', invalidated_at = ?, invalid_reason = ?, superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(ts, reason, supersededBy, ts, r.id)
    this.event({ op: 'invalidate', kind: 'relation', id: r.id, entityId: r.from_id, actor, grant, runId, before: { status: r.status }, after: { status: 'invalid', reason, supersededBy } })
  }

  // ======================================================================================
  // agent writes (MCP)
  // ======================================================================================
  agentWrite(grantId: string, args: AgentWriteArgs): AgentWriteResult {
    return this.tx(() => {
      const g = this.writableGrant(grantId)
      const repoId = g.repo_id!
      const facts = args.facts ?? []
      const relations = args.relations ?? []
      const aliases = args.aliases ?? []
      // guards
      if (!facts.length && !relations.length) throw new MemoryRefusal('Refused: give at least one fact or relation', 'validation')
      if (facts.length > LIMITS.factsPerCall) throw new MemoryRefusal(`Refused: at most ${LIMITS.factsPerCall} facts per call`, 'validation')
      if (relations.length > LIMITS.relationsPerCall) throw new MemoryRefusal(`Refused: at most ${LIMITS.relationsPerCall} relations per call`, 'validation')
      if (aliases.length > LIMITS.aliasesPerCall) throw new MemoryRefusal(`Refused: at most ${LIMITS.aliasesPerCall} aliases`, 'validation')
      const entityName = args.entity.trim()
      if (!entityName || entityName.length > LIMITS.nameLen) throw new MemoryRefusal(`Refused: entity must be 1..${LIMITS.nameLen} chars`, 'validation')
      for (const f of facts) {
        if (typeof f.text !== 'string' || f.text.trim().length < 3 || f.text.length > LIMITS.factLen)
          throw new MemoryRefusal(`Refused: each fact must be 3..${LIMITS.factLen} chars`, 'validation')
        if (f.kind && !MEMORY_FACT_KINDS.includes(f.kind)) throw new MemoryRefusal(`Refused: unknown kind "${f.kind}"`, 'validation')
      }
      for (const r of relations) {
        if (!r.type || r.type.trim().length < 2 || r.type.length > LIMITS.typeLen) throw new MemoryRefusal(`Refused: relation type must be 2..${LIMITS.typeLen} chars`, 'validation')
        if (!r.to?.trim() || r.to.length > LIMITS.nameLen) throw new MemoryRefusal('Refused: relation "to" must name an entity', 'validation')
      }
      if (facts.length && this.activeFactCount() >= LIMITS.maxActiveFacts)
        throw new MemoryRefusal('Refused: memory full; ask the user to clean up on the Memory page')
      // secret screen: the whole call is rejected (§4.2 step 2)
      this.screenSecrets([entityName, ...aliases, ...facts.map((f) => f.text), ...relations.map((r) => `${r.type} ${r.to}`)])
      const writesLeftAfter = this.takeWrites(g, facts.length + relations.length)

      // entity resolution
      let entity = this.resolveEntity(entityName, repoId)
      let created = false
      if (!entity) {
        entity = this.insertEntity({ repoId, name: entityName, type: args.entity_type, actor: 'agent', grant: g })
        created = true
      }
      const newAliases = this.addAliases(entity.id, aliases)
      if (newAliases.length) this.event({ op: 'create', kind: 'alias', id: entity.id, entityId: entity.id, actor: 'agent', grant: g, after: { aliases: newAliases } })
      if (created || newAliases.length) this.ftsEntity(entity.id)
      const possible = this.possibleDuplicates(entity, repoId)

      const out: AgentWriteResult = {
        entity: { id: entity.id, name: entity.name, created, possible_duplicates: possible },
        facts: [],
        relations: [],
        writes_left: writesLeftAfter
      }

      // facts
      for (const f of facts) {
        const text = f.text.trim()
        const hash = textHash(text)
        const dup = this.db
          .prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status IN ('active','pending')")
          .get(entity.id, hash) as { id: string } | undefined
        if (dup) {
          out.facts.push({ id: dup.id, result: 'duplicate' })
          continue
        }
        // which supersedes are allowed
        const toSupersede: FactRow[] = []
        const contested: string[] = []
        for (const sid of f.supersedes ?? []) {
          const old = this.factRow(sid)
          if (!old || old.entity_id !== entity.id || old.status !== 'active') continue
          if (!(old.scope === 'global' || old.repo_id === repoId)) continue
          if (old.actor === 'user' || old.reviewed) contested.push(old.id)
          else toSupersede.push(old)
        }
        const quarantine = imperativeHit(text)
        let status: MemoryStatus = 'active'
        let reason: string | null = null
        if (quarantine) {
          status = 'pending'
          reason = `quarantined: ${quarantine}`
        } else if (contested.length) {
          status = 'pending'
          reason = CONTESTED_PREFIX + contested.join(',')
        }
        const ts = this.ts()
        const row: FactRow = {
          id: newId('memFact'),
          entity_id: entity.id,
          text,
          text_hash: hash,
          kind: f.kind ?? 'fact',
          scope: 'project',
          repo_id: repoId,
          status,
          reviewed: 0,
          pinned: 0,
          invalidated_at: null,
          invalid_reason: reason,
          superseded_by: null,
          actor: 'agent',
          grant_id: g.id,
          edited_by_user: 0,
          created_at: ts,
          updated_at: ts
        }
        this.insertFactRow(row)
        this.event({ op: 'create', kind: 'fact', id: row.id, entityId: entity.id, actor: 'agent', grant: g, after: row })
        const superseded: string[] = []
        if (status === 'active') {
          for (const old of toSupersede) {
            this.invalidateFact(old, 'superseded', 'agent', g, row.id)
            superseded.push(old.id)
          }
        }
        const similar = this.similarFacts(entity.id, text, row.id, 3, g).filter((s) => !superseded.includes(s.id))
        const item: AgentWriteResult['facts'][number] = {
          id: row.id,
          result: quarantine ? 'pending_review' : contested.length ? 'contested' : 'added'
        }
        if (superseded.length) item.superseded = superseded
        if (similar.length) item.similar = similar.map((s) => ({ id: s.id, text: s.text, source: this.sourceLabel(s.grant_id, s.actor, s.created_at) }))
        if (quarantine) item.why = 'quarantined: looks like an instruction; awaits user review'
        else if (contested.length) item.why = `${contested.join(', ')} ${contested.length > 1 ? 'are' : 'is'} user-approved; your fact awaits review`
        out.facts.push(item)
      }

      // relations (PO3: folded into memory_write; from = this entity)
      for (const r of relations) {
        let to = this.resolveEntity(r.to, repoId)
        let createdTo = false
        if (!to) {
          to = this.insertEntity({ repoId, name: r.to, type: inferEntityType(r.to), actor: 'agent', grant: g })
          this.ftsEntity(to.id)
          createdTo = true
        }
        const normType = normalizeRelType(r.type)
        const dup = this.db
          .prepare("SELECT id FROM mem_relation WHERE from_id = ? AND to_id = ? AND norm_type = ? AND status IN ('active','pending')")
          .get(entity.id, to.id, normType) as { id: string } | undefined
        if (dup) {
          out.relations.push({ id: dup.id, result: 'duplicate', to_id: to.id, created_entity: createdTo })
          continue
        }
        const toSup: RelationRow[] = []
        const contested: string[] = []
        for (const sid of r.supersedes ?? []) {
          const old = this.relationRow(sid)
          if (!old || old.from_id !== entity.id || old.status !== 'active') continue
          if (!(old.scope === 'global' || old.repo_id === repoId)) continue
          if (old.actor === 'user' || old.reviewed) contested.push(old.id)
          else toSup.push(old)
        }
        const ts = this.ts()
        const row: RelationRow = {
          id: newId('memRelation'),
          from_id: entity.id,
          to_id: to.id,
          type: r.type.trim(),
          norm_type: normType,
          scope: 'project',
          repo_id: repoId,
          status: contested.length ? 'pending' : 'active',
          reviewed: 0,
          invalidated_at: null,
          invalid_reason: contested.length ? CONTESTED_PREFIX + contested.join(',') : null,
          superseded_by: null,
          actor: 'agent',
          grant_id: g.id,
          created_at: ts,
          updated_at: ts
        }
        this.insertRelationRow(row)
        this.event({ op: 'create', kind: 'relation', id: row.id, entityId: entity.id, actor: 'agent', grant: g, after: row })
        const superseded: string[] = []
        if (!contested.length) {
          for (const old of toSup) {
            this.invalidateRelation(old, 'superseded', 'agent', g, row.id)
            superseded.push(old.id)
          }
        }
        const item: AgentWriteResult['relations'][number] = {
          id: row.id,
          result: contested.length ? 'contested' : 'added',
          to_id: to.id,
          created_entity: createdTo
        }
        if (superseded.length) item.superseded = superseded
        if (contested.length) item.why = `${contested.join(', ')} is user-approved; your relation awaits review`
        out.relations.push(item)
      }
      this.touchEntity(entity.id)
      return out
    })
  }

  private possibleDuplicates(entity: EntityRow, repoId: string | null): { id: Id; name: string; scope: MemoryScope }[] {
    const q = ftsQuery(entity.name)
    if (!q) return []
    const rows = this.db
      .prepare(
        `SELECT e.id, e.name, e.repo_id FROM (SELECT target_id, bm25(mem_fts, 0, 0, 0, 2.0, 1.0) AS rank FROM mem_fts
                                              WHERE mem_fts MATCH ? AND target_kind = 'entity') x
         JOIN mem_entity e ON e.id = x.target_id
         WHERE e.id != ? AND (e.repo_id IS ? OR e.repo_id IS NULL) ORDER BY x.rank LIMIT 3`
      )
      .all(q, entity.id, repoId) as { id: string; name: string; repo_id: string | null }[]
    return rows.map((r) => ({ id: r.id, name: r.name, scope: r.repo_id ? 'project' : 'global' }))
  }

  private insertFactRow(row: FactRow): void {
    this.db
      .prepare(
        `INSERT INTO mem_fact (id, entity_id, text, text_hash, kind, scope, repo_id, status, reviewed, pinned, invalidated_at,
           invalid_reason, superseded_by, actor, grant_id, edited_by_user, created_at, updated_at)
         VALUES (@id, @entity_id, @text, @text_hash, @kind, @scope, @repo_id, @status, @reviewed, @pinned, @invalidated_at,
           @invalid_reason, @superseded_by, @actor, @grant_id, @edited_by_user, @created_at, @updated_at)`
      )
      .run(row)
    this.ftsFact(row.id)
  }
  private insertRelationRow(row: RelationRow): void {
    this.db
      .prepare(
        `INSERT INTO mem_relation (id, from_id, to_id, type, norm_type, scope, repo_id, status, reviewed, invalidated_at,
           invalid_reason, superseded_by, actor, grant_id, created_at, updated_at)
         VALUES (@id, @from_id, @to_id, @type, @norm_type, @scope, @repo_id, @status, @reviewed, @invalidated_at,
           @invalid_reason, @superseded_by, @actor, @grant_id, @created_at, @updated_at)`
      )
      .run(row)
  }

  agentInvalidate(grantId: string, ids: string[], reason: string): AgentInvalidateResult {
    return this.tx(() => {
      const g = this.writableGrant(grantId)
      const why = reason.trim()
      if (why.length < 3 || why.length > LIMITS.reasonLen) throw new MemoryRefusal(`Refused: reason must be 3..${LIMITS.reasonLen} chars`, 'validation')
      if (!ids.length || ids.length > 10) throw new MemoryRefusal('Refused: give 1..10 ids', 'validation')
      this.screenSecrets([why])
      const left = this.takeWrites(g, ids.length)
      const vis = visForGrant(g)
      const items: AgentInvalidateResult['items'] = []
      for (const id of ids) {
        const row: FactRow | RelationRow | null = id.startsWith('mfa_') ? this.factRow(id) : id.startsWith('mrel_') ? this.relationRow(id) : null
        if (!row || !visible(row, vis)) {
          items.push({ id, result: 'not_found' })
          continue
        }
        if (row.status !== 'active') {
          items.push({ id, result: row.status === 'invalid' ? 'already_invalid' : 'not_found' })
          continue
        }
        if (row.actor === 'user' || row.reviewed) {
          // Agents cannot overrule the user: logged as a proposal for the user to see in the entity history.
          this.event({
            op: 'invalidate',
            kind: id.startsWith('mfa_') ? 'fact' : 'relation',
            id,
            entityId: 'entity_id' in row ? row.entity_id : row.from_id,
            actor: 'agent',
            grant: g,
            after: { proposal: true, reason: why }
          })
          items.push({ id, result: 'contested' })
          continue
        }
        if ('entity_id' in row) this.invalidateFact(row, why, 'agent', g)
        else this.invalidateRelation(row, why, 'agent', g)
        items.push({ id, result: 'invalidated' })
      }
      return { items, writes_left: left }
    })
  }

  // ======================================================================================
  // user writes (page). actor = 'user', reviewed = 1, no grant.
  // ======================================================================================
  userCreateEntity(input: { repoId: string | null; name: string; type?: string; summary?: string; aliases?: string[] }): EntityRow {
    return this.tx(() => {
      this.screenSecrets([input.name, input.summary ?? '', ...(input.aliases ?? [])])
      const norm = normalizeName(input.name)
      const exists = this.db.prepare('SELECT id FROM mem_entity WHERE repo_id IS ? AND norm_name = ?').get(input.repoId, norm)
      if (exists) throw new MemoryRefusal(`An entity named "${input.name.trim()}" already exists here`, 'conflict')
      const e = this.insertEntity({ repoId: input.repoId, name: input.name, type: input.type, summary: input.summary, actor: 'user' })
      if (input.aliases?.length) this.addAliases(e.id, input.aliases)
      this.ftsEntity(e.id)
      return this.entityRow(e.id)!
    })
  }

  userEditEntity(id: string, patch: { type?: string; summary?: string; aliases?: string[] }): EntityRow {
    return this.tx(() => {
      const before = this.entityRow(id)
      if (!before) throw new MemoryRefusal('Entity not found', 'not_found')
      this.screenSecrets([patch.summary ?? '', ...(patch.aliases ?? [])])
      const type = patch.type !== undefined ? patch.type.trim().slice(0, LIMITS.typeLen) || 'concept' : before.type
      const summary = patch.summary !== undefined ? patch.summary.slice(0, 500) : before.summary
      this.db.prepare('UPDATE mem_entity SET type = ?, summary = ?, updated_at = ? WHERE id = ?').run(type, summary, this.ts(), id)
      const beforeAliases = this.aliases(id)
      if (patch.aliases) {
        this.db.prepare('DELETE FROM mem_alias WHERE entity_id = ?').run(id)
        this.addAliases(id, patch.aliases)
      }
      this.ftsEntity(id)
      this.event({
        op: 'update',
        kind: 'entity',
        id,
        entityId: id,
        actor: 'user',
        before: { type: before.type, summary: before.summary, aliases: beforeAliases },
        after: { type, summary, aliases: this.aliases(id) }
      })
      return this.entityRow(id)!
    })
  }

  userRenameEntity(id: string, name: string): EntityRow {
    return this.tx(() => {
      const before = this.entityRow(id)
      if (!before) throw new MemoryRefusal('Entity not found', 'not_found')
      const n = name.trim()
      if (!n || n.length > LIMITS.nameLen) throw new MemoryRefusal(`Name must be 1..${LIMITS.nameLen} chars`, 'validation')
      this.screenSecrets([n])
      const norm = normalizeName(n)
      const clash = this.db.prepare('SELECT id FROM mem_entity WHERE repo_id IS ? AND norm_name = ? AND id != ?').get(before.repo_id, norm, id)
      if (clash) throw new MemoryRefusal(`An entity named "${n}" already exists here; merge them instead`, 'conflict')
      this.db.prepare('UPDATE mem_entity SET name = ?, norm_name = ?, updated_at = ? WHERE id = ?').run(n, norm, this.ts(), id)
      // keep the old name findable
      if (before.norm_name !== norm) this.addAliases(id, [before.name])
      this.reindexEntity(id)
      this.event({ op: 'update', kind: 'entity', id, entityId: id, actor: 'user', before: { name: before.name }, after: { name: n } })
      return this.entityRow(id)!
    })
  }

  userCreateFact(input: { entityId: string; text: string; kind?: MemoryFactKind; scope: MemoryScope; repoId?: string | null; pinned?: boolean; supersedes?: string[] }): FactRow {
    return this.tx(() => {
      const e = this.entityRow(input.entityId)
      if (!e) throw new MemoryRefusal('Entity not found', 'not_found')
      const text = input.text.trim()
      if (text.length < 3 || text.length > LIMITS.factLen) throw new MemoryRefusal(`A fact must be 3..${LIMITS.factLen} chars`, 'validation')
      this.screenSecrets([text])
      if (input.scope !== 'global' && e.repo_id && input.repoId && input.repoId !== e.repo_id)
        throw new MemoryRefusal("A project fact must belong to its entity's repository", 'validation')
      const repoId = input.scope === 'global' ? null : (input.repoId ?? e.repo_id)
      if (input.scope === 'project' && !repoId) throw new MemoryRefusal('A project fact needs a repository; use global for this entity', 'validation')
      const hash = textHash(text)
      const dup = this.db.prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status IN ('active','pending')").get(e.id, hash)
      if (dup) throw new MemoryRefusal('This fact already exists on that entity', 'conflict')
      const ts = this.ts()
      const row: FactRow = {
        id: newId('memFact'),
        entity_id: e.id,
        text,
        text_hash: hash,
        kind: input.kind ?? 'fact',
        scope: input.scope,
        repo_id: repoId,
        status: 'active',
        reviewed: 1,
        pinned: input.pinned ? 1 : 0,
        invalidated_at: null,
        invalid_reason: null,
        superseded_by: null,
        actor: 'user',
        grant_id: null,
        edited_by_user: 0,
        created_at: ts,
        updated_at: ts
      }
      this.insertFactRow(row)
      this.event({ op: 'create', kind: 'fact', id: row.id, entityId: e.id, actor: 'user', after: row })
      for (const sid of input.supersedes ?? []) {
        const old = this.factRow(sid)
        if (old && old.entity_id === e.id && old.status === 'active') this.invalidateFact(old, 'superseded', 'user', null, row.id)
      }
      this.touchEntity(e.id)
      return this.factRow(row.id)!
    })
  }

  userEditFact(id: string, patch: { text?: string; kind?: MemoryFactKind }): FactRow {
    return this.tx(() => {
      const before = this.factRow(id)
      if (!before) throw new MemoryRefusal('Fact not found', 'not_found')
      let text = before.text
      let hash = before.text_hash
      if (patch.text !== undefined) {
        text = patch.text.trim()
        if (text.length < 3 || text.length > LIMITS.factLen) throw new MemoryRefusal(`A fact must be 3..${LIMITS.factLen} chars`, 'validation')
        this.screenSecrets([text])
        hash = textHash(text)
        if (hash !== before.text_hash) {
          const dup = this.db
            .prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status IN ('active','pending') AND id != ?")
            .get(before.entity_id, hash, id)
          if (dup) throw new MemoryRefusal('This fact already exists on that entity', 'conflict')
        }
      }
      const kind = patch.kind ?? before.kind
      this.db
        .prepare('UPDATE mem_fact SET text = ?, text_hash = ?, kind = ?, reviewed = 1, edited_by_user = 1, updated_at = ? WHERE id = ?')
        .run(text, hash, kind, this.ts(), id)
      this.ftsFact(id)
      this.event({ op: 'update', kind: 'fact', id, entityId: before.entity_id, actor: 'user', before: { text: before.text, kind: before.kind }, after: { text, kind } })
      this.touchEntity(before.entity_id)
      return this.factRow(id)!
    })
  }

  userCreateRelation(input: { fromId: string; toId: string; type: string; scope: MemoryScope }): RelationRow {
    return this.tx(() => {
      const from = this.entityRow(input.fromId)
      const to = this.entityRow(input.toId)
      if (!from || !to) throw new MemoryRefusal('Entity not found', 'not_found')
      if (from.id === to.id) throw new MemoryRefusal('A relation needs two different entities', 'validation')
      const type = input.type.trim()
      if (type.length < 2 || type.length > LIMITS.typeLen) throw new MemoryRefusal(`Type must be 2..${LIMITS.typeLen} chars`, 'validation')
      const normType = normalizeRelType(type)
      const dup = this.db
        .prepare("SELECT id FROM mem_relation WHERE from_id = ? AND to_id = ? AND norm_type = ? AND status IN ('active','pending')")
        .get(from.id, to.id, normType)
      if (dup) throw new MemoryRefusal('That relation already exists', 'conflict')
      // Entities belong to one repo (or are global). A relation across two repos would show repo B's entity in
      // repo A (page and MCP), so it is refused. Global <-> repo is fine: it belongs to that repo.
      if (from.repo_id && to.repo_id && from.repo_id !== to.repo_id)
        throw new MemoryRefusal('Relations can only link entities in the same repository (or a global entity)', 'validation')
      const endRepo = from.repo_id ?? to.repo_id
      // A relation touching a repo entity is that repo's, whatever scope was asked: as global it would leak the name.
      const scope: MemoryScope = endRepo ? 'project' : input.scope
      const repoId = scope === 'global' ? null : endRepo
      if (scope === 'project' && !repoId) throw new MemoryRefusal('A project relation needs a repository entity', 'validation')
      const ts = this.ts()
      const row: RelationRow = {
        id: newId('memRelation'),
        from_id: from.id,
        to_id: to.id,
        type,
        norm_type: normType,
        scope,
        repo_id: repoId,
        status: 'active',
        reviewed: 1,
        invalidated_at: null,
        invalid_reason: null,
        superseded_by: null,
        actor: 'user',
        grant_id: null,
        created_at: ts,
        updated_at: ts
      }
      this.insertRelationRow(row)
      this.event({ op: 'create', kind: 'relation', id: row.id, entityId: from.id, actor: 'user', after: row })
      this.touchEntity(from.id)
      return row
    })
  }

  userEditRelation(id: string, type: string): RelationRow {
    return this.tx(() => {
      const before = this.relationRow(id)
      if (!before) throw new MemoryRefusal('Relation not found', 'not_found')
      const t = type.trim()
      if (t.length < 2 || t.length > LIMITS.typeLen) throw new MemoryRefusal(`Type must be 2..${LIMITS.typeLen} chars`, 'validation')
      const norm = normalizeRelType(t)
      const dup = this.db
        .prepare("SELECT id FROM mem_relation WHERE from_id = ? AND to_id = ? AND norm_type = ? AND status IN ('active','pending') AND id != ?")
        .get(before.from_id, before.to_id, norm, id)
      if (dup) throw new MemoryRefusal('That relation already exists', 'conflict')
      this.db.prepare('UPDATE mem_relation SET type = ?, norm_type = ?, reviewed = 1, updated_at = ? WHERE id = ?').run(t, norm, this.ts(), id)
      this.event({ op: 'update', kind: 'relation', id, entityId: before.from_id, actor: 'user', before: { type: before.type }, after: { type: t } })
      return this.relationRow(id)!
    })
  }

  /** pin / unpin facts (user only). */
  userSetPinned(ids: string[], pinned: boolean): number {
    return this.tx(() => {
      let n = 0
      for (const id of ids) {
        const f = this.factRow(id)
        if (!f || f.pinned === (pinned ? 1 : 0)) continue
        this.db.prepare('UPDATE mem_fact SET pinned = ?, reviewed = 1, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, this.ts(), id)
        this.event({ op: pinned ? 'pin' : 'unpin', kind: 'fact', id, entityId: f.entity_id, actor: 'user' })
        n++
      }
      return n
    })
  }

  /** Approve: pending -> active (applying a contested supersede), or mark an agent row reviewed. */
  userApprove(kind: 'fact' | 'relation', ids: string[]): number {
    return this.tx(() => {
      let n = 0
      for (const id of ids) {
        if (kind === 'fact') {
          const f = this.factRow(id)
          if (!f || f.status === 'invalid') continue
          if (f.status === 'pending') {
            const dup = this.db
              .prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status = 'active' AND id != ?")
              .get(f.entity_id, f.text_hash, f.id)
            if (dup) throw new MemoryRefusal('An identical active fact already exists', 'conflict')
            this.db.prepare("UPDATE mem_fact SET status = 'active', reviewed = 1, invalid_reason = NULL, updated_at = ? WHERE id = ?").run(this.ts(), id)
            for (const sid of contestedIds(f.invalid_reason)) {
              const old = this.factRow(sid)
              if (old && old.status === 'active' && old.entity_id === f.entity_id) this.invalidateFact(old, 'superseded', 'user', null, f.id)
            }
          } else if (!f.reviewed) {
            this.db.prepare('UPDATE mem_fact SET reviewed = 1, updated_at = ? WHERE id = ?').run(this.ts(), id)
          } else continue
          this.event({ op: 'approve', kind: 'fact', id, entityId: f.entity_id, actor: 'user', before: { status: f.status } })
          n++
        } else {
          const r = this.relationRow(id)
          if (!r || r.status === 'invalid') continue
          if (r.status === 'pending') {
            this.db.prepare("UPDATE mem_relation SET status = 'active', reviewed = 1, invalid_reason = NULL, updated_at = ? WHERE id = ?").run(this.ts(), id)
            for (const sid of contestedIds(r.invalid_reason)) {
              const old = this.relationRow(sid)
              if (old && old.status === 'active') this.invalidateRelation(old, 'superseded', 'user', null, r.id)
            }
          } else if (!r.reviewed) {
            this.db.prepare('UPDATE mem_relation SET reviewed = 1, updated_at = ? WHERE id = ?').run(this.ts(), id)
          } else continue
          this.event({ op: 'approve', kind: 'relation', id, entityId: r.from_id, actor: 'user', before: { status: r.status } })
          n++
        }
      }
      return n
    })
  }

  userInvalidate(kind: 'fact' | 'relation', ids: string[], reason: string): number {
    return this.tx(() => {
      const why = reason.trim().slice(0, LIMITS.reasonLen) || 'invalidated by user'
      let n = 0
      for (const id of ids) {
        if (kind === 'fact') {
          const f = this.factRow(id)
          if (!f || f.status === 'invalid') continue
          this.invalidateFact(f, why, 'user', null)
        } else {
          const r = this.relationRow(id)
          if (!r || r.status === 'invalid') continue
          this.invalidateRelation(r, why, 'user', null)
        }
        n++
      }
      return n
    })
  }

  userRestore(kind: 'fact' | 'relation', ids: string[]): number {
    return this.tx(() => {
      let n = 0
      for (const id of ids) {
        if (kind === 'fact') {
          const f = this.factRow(id)
          if (!f || f.status !== 'invalid') continue
          const dup = this.db
            .prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status IN ('active','pending')")
            .get(f.entity_id, f.text_hash)
          if (dup) throw new MemoryRefusal('An identical active fact already exists', 'conflict')
          this.db
            .prepare("UPDATE mem_fact SET status = 'active', reviewed = 1, invalidated_at = NULL, invalid_reason = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?")
            .run(this.ts(), id)
          this.event({ op: 'restore', kind: 'fact', id, entityId: f.entity_id, actor: 'user', before: { status: 'invalid', reason: f.invalid_reason } })
        } else {
          const r = this.relationRow(id)
          if (!r || r.status !== 'invalid') continue
          const dup = this.db
            .prepare("SELECT id FROM mem_relation WHERE from_id = ? AND to_id = ? AND norm_type = ? AND status IN ('active','pending')")
            .get(r.from_id, r.to_id, r.norm_type)
          if (dup) throw new MemoryRefusal('That relation already exists', 'conflict')
          this.db
            .prepare("UPDATE mem_relation SET status = 'active', reviewed = 1, invalidated_at = NULL, invalid_reason = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?")
            .run(this.ts(), id)
          this.event({ op: 'restore', kind: 'relation', id, entityId: r.from_id, actor: 'user', before: { status: 'invalid' } })
        }
        n++
      }
      return n
    })
  }

  /** "Move to global": project facts -> global (user only, PO2). */
  userToGlobal(ids: string[]): number {
    return this.tx(() => {
      let n = 0
      for (const id of ids) {
        const f = this.factRow(id)
        if (!f || f.scope === 'global') continue
        this.db.prepare("UPDATE mem_fact SET scope = 'global', repo_id = NULL, reviewed = 1, updated_at = ? WHERE id = ?").run(this.ts(), id)
        this.event({ op: 'to_global', kind: 'fact', id, entityId: f.entity_id, actor: 'user', before: { scope: f.scope, repoId: f.repo_id }, after: { scope: 'global' } })
        n++
      }
      return n
    })
  }

  /** Merge entities into targetId: moves facts, aliases and relations; source names become aliases; sources deleted. */
  userMerge(sourceIds: string[], targetId: string): EntityRow {
    return this.tx(() => {
      const target = this.entityRow(targetId)
      if (!target) throw new MemoryRefusal('Target entity not found', 'not_found')
      for (const sid of sourceIds) {
        if (sid === targetId) continue
        const src = this.entityRow(sid)
        if (!src) continue
        // facts: move; collisions with an identical live fact on the target are invalidated as duplicates
        for (const f of this.db.prepare('SELECT * FROM mem_fact WHERE entity_id = ?').all(sid) as FactRow[]) {
          if (f.status !== 'invalid') {
            const dup = this.db
              .prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status IN ('active','pending')")
              .get(targetId, f.text_hash) as { id: string } | undefined
            if (dup) this.invalidateFact(f, 'merged duplicate', 'user', null, dup.id)
          }
          this.db.prepare('UPDATE mem_fact SET entity_id = ? WHERE id = ?').run(targetId, f.id)
        }
        // relations: re-point both ends; self-loops and duplicates are dropped
        for (const r of this.db.prepare('SELECT * FROM mem_relation WHERE from_id = ? OR to_id = ?').all(sid, sid) as RelationRow[]) {
          const from = r.from_id === sid ? targetId : r.from_id
          const to = r.to_id === sid ? targetId : r.to_id
          const clash =
            from === to ||
            (r.status !== 'invalid' &&
              this.db
                .prepare("SELECT id FROM mem_relation WHERE from_id = ? AND to_id = ? AND norm_type = ? AND status IN ('active','pending') AND id != ?")
                .get(from, to, r.norm_type, r.id))
          if (clash) this.db.prepare('DELETE FROM mem_relation WHERE id = ?').run(r.id)
          else this.db.prepare('UPDATE mem_relation SET from_id = ?, to_id = ? WHERE id = ?').run(from, to, r.id)
        }
        const srcAliases = this.aliases(sid)
        this.addAliases(targetId, [src.name, ...srcAliases])
        this.ftsDelete(sid)
        this.db.prepare('DELETE FROM mem_entity WHERE id = ?').run(sid)
        this.db.prepare('UPDATE mem_event SET entity_id = ? WHERE entity_id = ?').run(targetId, sid)
        this.event({ op: 'merge', kind: 'entity', id: sid, entityId: targetId, actor: 'user', before: { name: src.name }, after: { into: targetId } })
      }
      this.touchEntity(targetId)
      this.reindexEntity(targetId)
      return this.entityRow(targetId)!
    })
  }

  /** Hard delete (user only): removes rows + FTS, scrubs earlier event snapshots of the targets, logs `delete`. */
  userDelete(kind: 'entity' | 'fact' | 'relation', ids: string[]): number {
    return this.tx(() => {
      let n = 0
      const scrub = this.db.prepare(`UPDATE mem_event SET before_json = '{"deleted":true}', after_json = '{"deleted":true}' WHERE target_id = ?`)
      for (const id of ids) {
        if (kind === 'entity') {
          const e = this.entityRow(id)
          if (!e) continue
          const factIds = (this.db.prepare('SELECT id FROM mem_fact WHERE entity_id = ?').all(id) as { id: string }[]).map((r) => r.id)
          const relIds = (this.db.prepare('SELECT id FROM mem_relation WHERE from_id = ? OR to_id = ?').all(id, id) as { id: string }[]).map((r) => r.id)
          for (const t of [id, ...factIds, ...relIds]) {
            this.ftsDelete(t)
            scrub.run(t)
          }
          this.db.prepare("DELETE FROM mem_fts WHERE entity_id = ?").run(id)
          // superseded_by pointers into deleted facts are nulled by the FK
          this.db.prepare('DELETE FROM mem_entity WHERE id = ?').run(id)
          this.event({ op: 'delete', kind: 'entity', id, entityId: id, actor: 'user', after: { deleted: true } })
        } else if (kind === 'fact') {
          const f = this.factRow(id)
          if (!f) continue
          this.ftsDelete(id)
          scrub.run(id)
          this.db.prepare('DELETE FROM mem_fact WHERE id = ?').run(id)
          this.event({ op: 'delete', kind: 'fact', id, entityId: f.entity_id, actor: 'user', after: { deleted: true } })
        } else {
          const r = this.relationRow(id)
          if (!r) continue
          scrub.run(id)
          this.db.prepare('DELETE FROM mem_relation WHERE id = ?').run(id)
          this.db.prepare('UPDATE mem_relation SET superseded_by = NULL WHERE superseded_by = ?').run(id)
          this.event({ op: 'delete', kind: 'relation', id, entityId: r.from_id, actor: 'user', after: { deleted: true } })
        }
        n++
      }
      return n
    })
  }

  /**
   * Revert run (§4.5): invalidates every active fact/relation written by this run's grants (reason 'reverted run') and
   * restores the facts/relations they superseded. One-way: a second call finds nothing live and does nothing. Single
   * rows can be restored from History (userRestore).
   */
  revertRun(runId: string): { invalidated: number; restored: number } {
    return this.tx(() => {
      const facts = this.db
        .prepare("SELECT f.* FROM mem_fact f JOIN mem_grant g ON g.id = f.grant_id WHERE g.run_id = ? AND f.status IN ('active','pending')")
        .all(runId) as FactRow[]
      const rels = this.db
        .prepare("SELECT r.* FROM mem_relation r JOIN mem_grant g ON g.id = r.grant_id WHERE g.run_id = ? AND r.status IN ('active','pending')")
        .all(runId) as RelationRow[]
      if (facts.length || rels.length) {
        const restoredFacts: [string, string][] = []
        const restoredRels: [string, string][] = []
        for (const f of facts) {
          for (const old of this.db.prepare("SELECT * FROM mem_fact WHERE superseded_by = ? AND status = 'invalid'").all(f.id) as FactRow[]) {
            restoredFacts.push([old.id, f.id])
          }
          this.invalidateFact(f, 'reverted run', 'user', null, null, runId)
        }
        for (const r of rels) {
          for (const old of this.db.prepare("SELECT * FROM mem_relation WHERE superseded_by = ? AND status = 'invalid'").all(r.id) as RelationRow[]) {
            restoredRels.push([old.id, r.id])
          }
          this.invalidateRelation(r, 'reverted run', 'user', null, null, runId)
        }
        let restored = 0
        for (const [id] of restoredFacts) {
          const old = this.factRow(id)!
          const dup = this.db.prepare("SELECT id FROM mem_fact WHERE entity_id = ? AND text_hash = ? AND status IN ('active','pending')").get(old.entity_id, old.text_hash)
          if (dup) continue
          this.db
            .prepare("UPDATE mem_fact SET status = 'active', invalidated_at = NULL, invalid_reason = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?")
            .run(this.ts(), id)
          this.event({ op: 'restore', kind: 'fact', id, entityId: old.entity_id, actor: 'user', runId })
          restored++
        }
        for (const [id] of restoredRels) {
          const old = this.relationRow(id)!
          // never bring back a second live copy (same ends + type) of a relation that exists again by now
          const dup = this.db
            .prepare("SELECT id FROM mem_relation WHERE from_id = ? AND to_id = ? AND norm_type = ? AND status IN ('active','pending') AND id != ?")
            .get(old.from_id, old.to_id, old.norm_type, id)
          if (dup) continue
          this.db
            .prepare("UPDATE mem_relation SET status = 'active', invalidated_at = NULL, invalid_reason = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?")
            .run(this.ts(), id)
          this.event({ op: 'restore', kind: 'relation', id, entityId: old.from_id, actor: 'user', runId })
          restored++
        }
        this.event({
          op: 'revert_run',
          kind: 'memory',
          id: runId,
          actor: 'user',
          runId,
          after: { mode: 'revert', facts: facts.map((f) => f.id), relations: rels.map((r) => r.id), restoredFacts, restoredRels }
        })
        return { invalidated: facts.length + rels.length, restored }
      }
      return { invalidated: 0, restored: 0 }
    })
  }

  /** Poller re-screen (§9): a row whose text contains a vault value moves to pending with the text redacted. */
  quarantineSecretFact(id: string, redacted: string, secretName: string): void {
    this.tx(() => {
      const f = this.factRow(id)
      if (!f) return
      this.db
        .prepare("UPDATE mem_fact SET text = ?, text_hash = ?, status = 'pending', invalid_reason = ?, updated_at = ? WHERE id = ?")
        .run(redacted, textHash(redacted + f.id), `quarantined: contained secret ${secretName}`, this.ts(), id)
      this.ftsFact(id)
      this.db.prepare(`UPDATE mem_event SET before_json = '{"redacted":true}', after_json = '{"redacted":true}' WHERE target_id = ?`).run(id)
      this.event({ op: 'update', kind: 'fact', id, entityId: f.entity_id, actor: 'system', after: { quarantined: true, secret: secretName } })
    })
  }

  /** Main: periodic WAL checkpoint after idle. */
  checkpoint(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* busy: next time */
    }
  }
}

// ---------- helpers ----------
export function normalizeRelType(t: string): string {
  return normalizeName(t).replace(/[\s-]+/g, '_')
}

function contestedIds(reason: string | null): string[] {
  if (!reason?.startsWith(CONTESTED_PREFIX)) return []
  return reason.slice(CONTESTED_PREFIX.length).split(',').filter(Boolean)
}

export function visible(row: { scope: MemoryScope; repo_id: string | null }, v: Visibility): boolean {
  if (v.kind === 'all') return true
  if (row.scope === 'global') return true
  return v.kind === 'repo' && row.repo_id === v.repoId
}

const FTS_OPERATORS = new Set(['and', 'or', 'not', 'near'])

/** English stopwords: they match almost every fact, so left in a query they crowd out the words that matter. */
export const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are aren as at be because been before being below between both but by can ' +
    'cannot could couldn did didn do does doesn doing don down during each else etc ever every few for from further get gets got had hadn has ' +
    'hasn have haven having he her here hers herself him himself his how however i if in into is isn it its itself just let lets me might ' +
    'more most much must mustn my myself no nor not now of off on once only or other ought our ours ourselves out over own per please same ' +
    'shall shan she should shouldn so some such than that the their theirs them themselves then there these they this those through to too ' +
    'under until up upon us very via was wasn we were weren what whatever when where whether which while who whom whose why will with within ' +
    'without won would wouldn yes yet you your yours yourself yourselves'
  ).split(/\s+/)
)
/**
 * Request filler in a prompt ("tell me", "answer in one sentence"): describes the ask, not the topic. Dropped only
 * from whole-prompt queries (the brief); agents' own memory_search keywords keep them.
 */
export const PROMPT_FILLER = new Set(
  (
    'answer answers ask asked asking briefly concise describe explain exactly give know knows like look mention need needs one provide ' +
    'question questions recall remember reply respond response return say says sentence short tell think want'
  ).split(/\s+/)
)

/**
 * Query keywords in order of first appearance: tokenized like ftsQuery, lowercased, unique, stopwords (and, for a
 * whole prompt, request filler) dropped.
 */
export function queryKeywords(input: string, opts: { prompt?: boolean } = {}): string[] {
  const toks = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}._\-/]+/u)
    .map((t) => t.replace(/^[._\-/]+|[._\-/]+$/g, '').toLowerCase())
    .filter((t) => t.length >= 2 && !FTS_OPERATORS.has(t))
  const uniq = [...new Set(toks)]
  const kept = uniq.filter((t) => !STOPWORDS.has(t) && !(opts.prompt && PROMPT_FILLER.has(t)))
  // a query made only of stopwords ("how do I") still searches for something
  return kept.length ? kept : uniq
}

/**
 * Sanitized FTS5 query (§6.1): split on whitespace/punctuation other than . _ - / ; drop operators and stopwords;
 * <= maxTokens keywords (12 for agent queries; the brief passes more because it searches the whole prompt); each
 * quoted as a prefix phrase, OR-joined. '' when nothing is left.
 */
export function ftsQuery(input: string, maxTokens = 12, opts: { prompt?: boolean } = {}): string {
  return queryKeywords(input, opts)
    .slice(0, maxTokens)
    .map((t) => `"${t.replace(/"/g, '')}"*`)
    .join(' OR ')
}

/**
 * Relation rows a reader may see, judged by their two ends (alias `a` = mem_relation). Never a relation between
 * entities of two different repositories (those are refused at write time; old rows are filtered here), and under a
 * repo/global view both ends must be entities that view can see, so no other repo's entity name leaks through a
 * global relation.
 */
export function relationEndsSql(v: Visibility, a: string): { sql: string; params: unknown[] } {
  const notCross = `NOT EXISTS (SELECT 1 FROM mem_entity ef, mem_entity et WHERE ef.id = ${a}.from_id AND et.id = ${a}.to_id
    AND ef.repo_id IS NOT NULL AND et.repo_id IS NOT NULL AND ef.repo_id != et.repo_id)`
  if (v.kind === 'all') return { sql: notCross, params: [] }
  const fe = entityVisSql(v, 'rfe')
  const te = entityVisSql(v, 'rte')
  return {
    sql: `(${notCross} AND EXISTS (SELECT 1 FROM mem_entity rfe WHERE rfe.id = ${a}.from_id AND ${fe.sql})
      AND EXISTS (SELECT 1 FROM mem_entity rte WHERE rte.id = ${a}.to_id AND ${te.sql}))`,
    params: [...fe.params, ...te.params]
  }
}

/** Provenance from a grant row. */
export function grantProvenance(g: GrantRow): MemoryProvenance {
  return {
    grantId: g.id,
    adapter: g.adapter as AdapterId,
    transport: g.transport,
    profileId: g.profile_id,
    profileName: g.profile_name,
    model: g.model,
    repoId: g.repo_id,
    repoName: g.repo_name,
    runId: g.run_id,
    runTitle: g.run_title,
    workflowId: g.workflow_id,
    stepId: g.step_id,
    nodeId: g.node_id,
    nodeLabel: g.node_label,
    sessionId: g.session_id,
    createdAt: g.created_at
  }
}

/** Maps rows -> shared types. Caches grants for one read. `text` passes through `redact` (main: vault redaction). */
export class RowMapper {
  private grants = new Map<string, GrantRow | null>()
  constructor(
    private store: MemoryStore,
    private redact: (s: string) => string = (s) => s
  ) {}
  private grant(id: string | null): GrantRow | null {
    if (!id) return null
    if (!this.grants.has(id)) this.grants.set(id, this.store.getGrant(id))
    return this.grants.get(id)!
  }
  private prov(actor: MemoryActor, grantId: string | null): { provenance: MemoryProvenance | null; unattributed: boolean } {
    const g = this.grant(grantId)
    return { provenance: g ? grantProvenance(g) : null, unattributed: actor === 'agent' && !g }
  }

  entities(rows: EntityRow[]): MemoryEntity[] {
    if (!rows.length) return []
    const db = this.store.db
    const ids = rows.map((r) => r.id)
    const ph = ids.map(() => '?').join(',')
    const counts = new Map<string, MemoryEntity['counts'] & { changed: string }>()
    for (const c of db
      .prepare(
        `SELECT entity_id,
           sum(status = 'active') AS active, sum(status = 'pending') AS pending, sum(status = 'invalid') AS invalid,
           sum(status = 'active' AND actor = 'agent' AND reviewed = 0) AS unreviewed, sum(status = 'active' AND pinned = 1) AS pinned,
           max(updated_at) AS changed
         FROM mem_fact WHERE entity_id IN (${ph}) GROUP BY entity_id`
      )
      .all(...ids) as (MemoryEntity['counts'] & { entity_id: string; changed: string })[]) {
      counts.set(c.entity_id, c)
    }
    const degree = new Map<string, { n: number; changed: string }>()
    for (const d of db
      .prepare(
        `SELECT id, count(*) AS n, max(updated_at) AS changed FROM (
           SELECT from_id AS id, updated_at FROM mem_relation WHERE status = 'active' AND from_id IN (${ph})
           UNION ALL SELECT to_id AS id, updated_at FROM mem_relation WHERE status = 'active' AND to_id IN (${ph}))
         GROUP BY id`
      )
      .all(...ids, ...ids) as { id: string; n: number; changed: string }[]) {
      degree.set(d.id, d)
    }
    const aliases = new Map<string, string[]>()
    for (const a of db.prepare(`SELECT entity_id, alias FROM mem_alias WHERE entity_id IN (${ph}) ORDER BY alias`).all(...ids) as {
      entity_id: string
      alias: string
    }[]) {
      if (!aliases.has(a.entity_id)) aliases.set(a.entity_id, [])
      aliases.get(a.entity_id)!.push(this.redact(a.alias))
    }
    return rows.map((r) => {
      const c = counts.get(r.id)
      const d = degree.get(r.id)
      const changedAt = [r.updated_at, c?.changed, d?.changed].filter(Boolean).sort().pop()!
      return {
        id: r.id,
        repoId: r.repo_id,
        name: this.redact(r.name),
        type: r.type,
        summary: this.redact(r.summary),
        aliases: aliases.get(r.id) ?? [],
        actor: r.actor,
        ...this.prov(r.actor, r.grant_id),
        counts: {
          active: c?.active ?? 0,
          pending: c?.pending ?? 0,
          invalid: c?.invalid ?? 0,
          unreviewed: c?.unreviewed ?? 0,
          pinned: c?.pinned ?? 0
        },
        degree: d?.n ?? 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        changedAt
      }
    })
  }

  facts(rows: FactRow[]): MemoryFact[] {
    if (!rows.length) return []
    const db = this.store.db
    const ids = rows.map((r) => r.id)
    const ph = ids.map(() => '?').join(',')
    const sup = new Map<string, string[]>()
    for (const s of db
      .prepare(`SELECT id, superseded_by FROM mem_fact WHERE superseded_by IN (${ph}) ORDER BY created_at`)
      .all(...ids) as { id: string; superseded_by: string }[]) {
      if (!sup.has(s.superseded_by)) sup.set(s.superseded_by, [])
      sup.get(s.superseded_by)!.push(s.id)
    }
    const entIds = [...new Set(rows.map((r) => r.entity_id))]
    const names = new Map<string, string>()
    for (const e of db
      .prepare(`SELECT id, name FROM mem_entity WHERE id IN (${entIds.map(() => '?').join(',')})`)
      .all(...entIds) as { id: string; name: string }[])
      names.set(e.id, e.name)
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      entityName: this.redact(names.get(r.entity_id) ?? ''),
      text: this.redact(r.text),
      kind: r.kind,
      scope: r.scope,
      repoId: r.repo_id,
      status: r.status,
      reviewed: !!r.reviewed,
      pinned: !!r.pinned,
      invalidatedAt: r.invalidated_at,
      invalidReason: r.invalid_reason ? this.redact(r.invalid_reason) : null,
      supersededBy: r.superseded_by,
      supersedes: sup.get(r.id) ?? [],
      actor: r.actor,
      ...this.prov(r.actor, r.grant_id),
      editedByUser: !!r.edited_by_user,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  }

  relations(rows: RelationRow[]): MemoryRelation[] {
    return rows.map((r) => ({
      id: r.id,
      fromId: r.from_id,
      toId: r.to_id,
      type: this.redact(r.type),
      scope: r.scope,
      repoId: r.repo_id,
      status: r.status,
      reviewed: !!r.reviewed,
      invalidatedAt: r.invalidated_at,
      invalidReason: r.invalid_reason ? this.redact(r.invalid_reason) : null,
      supersededBy: r.superseded_by,
      actor: r.actor,
      ...this.prov(r.actor, r.grant_id),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  }
}

export { normalizeName, normalizeText }

/**
 * Type for an entity created without an explicit type (relation targets, the Relate sheet): a best guess from the
 * name's shape and wording; 'concept' only when nothing fits. An existing entity with that name keeps its own type
 * (callers resolve by name first).
 */
export function inferEntityType(name: string): string {
  const n = name.trim()
  const low = n.toLowerCase()
  if (!n) return 'concept'
  // files and paths
  if (!/\s/.test(n)) {
    if (/^(\.{0,2}\/|~\/)?([\w@.-]+\/)+[\w@.-]+$/.test(n) && /\.[A-Za-z0-9]{1,8}$/.test(n)) return 'file'
    if (/^[\w@-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|sql|css|scss|html|yml|yaml|toml|sh|swift|kt|c|h|cpp|lock|env)$/i.test(n)) return 'file'
    if (/^\.[\w.-]+$/.test(n) && n.length > 2) return 'file' // dotfiles: .env, .gitignore, .nvmrc
    if (/^(https?:\/\/|\/api\/|\/v\d+\/)/i.test(n)) return 'api'
    if (/^(\.{0,2}\/|~\/)?[\w@.-]+(\/[\w@.-]+)*\/$/.test(n) || /^(src|lib|app|apps|packages|scripts|docs|test|tests)\/[\w@./-]*$/.test(n)) return 'component'
    if (/^@[\w.-]+\/[\w.-]+$/.test(n)) return 'library' // npm scope
    if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(n)) return 'env' // DATABASE_URL, NODE_ENV
    if (/^@[\w.-]+$/.test(n)) return 'person' // @handle
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(n) || /^#\d+$/.test(n)) return 'task' // HIVE-12, #34
  }
  if (/^(get|post|put|patch|delete|head|options)\s+\//i.test(n)) return 'api'
  const words = low.split(/[\s_-]+/)
  const has = (...ws: string[]) => ws.some((w) => words.includes(w))
  if (has('api', 'apis', 'endpoint', 'endpoints', 'route', 'routes', 'webhook', 'webhooks', 'rest', 'graphql', 'rpc', 'ipc')) return 'api'
  if (has('library', 'lib', 'sdk', 'package', 'framework', 'npm', 'crate', 'gem')) return 'library'
  if (has('env', 'environment', 'staging', 'production', 'prod', 'dev', 'ci', 'variable', 'var', 'config', 'configuration', 'settings')) return 'env'
  if (has('task', 'todo', 'ticket', 'issue', 'bug', 'migration', 'release', 'milestone')) return 'task'
  if (has('team', 'owner', 'maintainer', 'user', 'customer', 'author', 'person')) return 'person'
  if (has('service', 'component', 'module', 'server', 'client', 'worker', 'page', 'view', 'screen', 'store', 'handler', 'controller', 'db', 'database', 'schema', 'table', 'queue', 'cache', 'engine', 'scheduler', 'app', 'cli', 'ui'))
    return 'component'
  return 'concept'
}

// ======================================================================================
// Vault grants (PASSPORT.md §7.5). passport-index.db `mem_grant` rows: the v1 shape plus the company, the vault folder
// and the per-grant spool. Main creates and closes them; the hivemem server only reads its own row (binding, §7.1).
// ======================================================================================
export interface VaultGrantRow extends GrantRow {
  company_id: string
  vault_path: string | null
  spool_dir: string | null
}
export interface VaultGrantInput extends GrantInput {
  companyId: Id
  vaultPath: string | null
  /** Builds the spool dir from the new grant id (`<userData>/mem-rpc/<grantId>`). */
  spoolDir: ((grantId: Id) => string) | null
}

/** Minimal db surface (passport-index.db is opened by memory/vault/indexDb.ts; this file stays free of vault imports). */
type GrantDb = MemDB

export class VaultGrantStore {
  constructor(
    readonly db: GrantDb,
    private now: () => Date = () => new Date()
  ) {}

  create(g: VaultGrantInput): VaultGrantRow {
    const id = newId('memGrant')
    const row: VaultGrantRow = {
      id,
      company_id: g.companyId,
      vault_path: g.vaultPath,
      spool_dir: g.spoolDir ? g.spoolDir(id) : null,
      mode: g.mode,
      adapter: g.adapter,
      transport: g.transport,
      profile_id: g.profileId ?? null,
      profile_name: g.profileName ?? null,
      model: g.model ?? null,
      repo_id: g.repoId ?? null,
      repo_name: g.repoName ?? null,
      run_id: g.runId ?? null,
      run_title: g.runTitle ?? null,
      workflow_id: g.workflowId ?? null,
      step_id: g.stepId ?? null,
      node_id: g.nodeId ?? null,
      node_label: g.nodeLabel ?? null,
      session_id: g.sessionId ?? null,
      writes: 0,
      created_at: this.now().toISOString(),
      closed_at: null
    }
    this.db
      .prepare(
        `INSERT INTO mem_grant (id, company_id, vault_path, spool_dir, mode, adapter, transport, profile_id, profile_name, model, repo_id,
           repo_name, run_id, run_title, workflow_id, step_id, node_id, node_label, session_id, writes, created_at, closed_at)
         VALUES (@id, @company_id, @vault_path, @spool_dir, @mode, @adapter, @transport, @profile_id, @profile_name, @model, @repo_id,
           @repo_name, @run_id, @run_title, @workflow_id, @step_id, @node_id, @node_label, @session_id, @writes, @created_at, @closed_at)`
      )
      .run(row)
    return row
  }
  get(id: string): VaultGrantRow | null {
    return (this.db.prepare('SELECT * FROM mem_grant WHERE id = ?').get(id) as VaultGrantRow | undefined) ?? null
  }
  close(id: string): VaultGrantRow | null {
    this.db.prepare('UPDATE mem_grant SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(this.now().toISOString(), id)
    return this.get(id)
  }
  /** Boot recovery: the grants a previous process left open, now closed (their spool dirs are swept by the caller). */
  closeAllOpen(): VaultGrantRow[] {
    const open = this.db.prepare('SELECT * FROM mem_grant WHERE closed_at IS NULL').all() as VaultGrantRow[]
    if (open.length) this.db.prepare('UPDATE mem_grant SET closed_at = ? WHERE closed_at IS NULL').run(this.now().toISOString())
    return open
  }
  open(): VaultGrantRow[] {
    return this.db.prepare('SELECT * FROM mem_grant WHERE closed_at IS NULL').all() as VaultGrantRow[]
  }
  /** Weighted budget (§7.3): facts 1, links 0.25. Returns what is left after taking `n`; refuses when over. */
  takeWrites(g: VaultGrantRow, n: number): number {
    if (n <= 0) return LIMITS.writesPerGrant - g.writes
    if (g.writes + n > LIMITS.writesPerGrant + 1e-9) {
      throw new MemoryRefusal(`Refused: write limit reached (${LIMITS.writesPerGrant} per step; ${Math.max(0, Math.floor(LIMITS.writesPerGrant - g.writes))} left)`)
    }
    this.db.prepare('UPDATE mem_grant SET writes = writes + ? WHERE id = ?').run(n, g.id)
    g.writes += n
    return writesLeft(g)
  }
  /** Grants with what they wrote (mem_event rows by grant), oldest first. Company-scoped when `companyId` is given. */
  list(q: { runId?: Id; sessionId?: Id; companyId?: Id }): MemoryGrantInfo[] {
    const where: string[] = []
    const params: unknown[] = []
    if (q.runId) where.push('g.run_id = ?'), params.push(q.runId)
    if (q.sessionId) where.push('g.session_id = ?'), params.push(q.sessionId)
    if (q.companyId) where.push('g.company_id = ?'), params.push(q.companyId)
    const rows = this.db
      .prepare(
        `SELECT g.*,
           (SELECT count(*) FROM mem_event e WHERE e.grant_id = g.id AND e.target_kind = 'fact' AND e.op IN ('create','supersede')) AS n_facts,
           (SELECT count(*) FROM mem_event e WHERE e.grant_id = g.id AND e.target_kind = 'relation' AND e.op = 'create') AS n_rel,
           (SELECT count(*) FROM mem_event e WHERE e.grant_id = g.id AND e.op = 'invalidate') AS n_inv
         FROM mem_grant g ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.created_at`
      )
      .all(...params) as (VaultGrantRow & { n_facts: number; n_rel: number; n_inv: number })[]
    return rows.map((g) => ({
      ...grantProvenance(g),
      mode: g.mode as Exclude<MemoryMode, 'off'>,
      closedAt: g.closed_at,
      wrote: { facts: g.n_facts, relations: g.n_rel, invalidated: g.n_inv }
    }))
  }
}

export const writesLeft = (g: Pick<GrantRow, 'writes'>): number => Math.max(0, Math.floor((LIMITS.writesPerGrant - g.writes) * 100) / 100)
