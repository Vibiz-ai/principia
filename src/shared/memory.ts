/**
 * Hive shared memory: domain types (docs/MEMORY.md, CONTRACT.md §11, with the PO1–PO10 amendments).
 * TYPE-ONLY except small `as const` lists. No Node or DOM imports.
 */
import type { AdapterId, ISODate, Id } from './types'

export const MEMORY_MODES = ['off', 'read', 'read-write'] as const
export type MemoryMode = (typeof MEMORY_MODES)[number]
/** PO1: two scopes. Agents write `project` only (PO2); `global` is user-written. */
export const MEMORY_SCOPES = ['project', 'global'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]
/** PO6 */
export const MEMORY_FACT_KINDS = ['fact', 'decision', 'convention', 'gotcha'] as const
export type MemoryFactKind = (typeof MEMORY_FACT_KINDS)[number]
/** pending = awaiting the user (quarantined, contested); never served to agents. PO6: no 'archived'. */
export const MEMORY_STATUSES = ['active', 'pending', 'invalid'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]
export type MemoryActor = 'agent' | 'user'
export type MemoryTransport = 'mcp' | 'inject'
export type MemoryTargetKind = 'entity' | 'fact' | 'relation'

/** MCP tool names (PO3), unprefixed. Claude exposes them as mcp__hivemem__<name>. */
export const MEMORY_READ_TOOLS = ['memory_search', 'memory_get'] as const
export const MEMORY_WRITE_TOOLS = ['memory_write', 'memory_invalidate'] as const
export const MEMORY_SERVER_NAME = 'hivemem'

/** Denormalized from mem_grant. Null for user-authored rows. */
export interface MemoryProvenance {
  grantId: Id
  adapter: AdapterId
  transport: MemoryTransport
  profileId: Id | null
  profileName: string | null
  model: string | null
  repoId: Id | null
  repoName: string | null
  runId: Id | null
  runTitle: string | null
  workflowId: Id | null
  stepId: Id | null
  nodeId: string | null
  nodeLabel: string | null
  sessionId: Id | null
  createdAt: ISODate
}

export interface MemoryEntity {
  id: Id
  repoId: Id | null // null = global entity
  name: string
  type: string
  summary: string
  aliases: string[]
  actor: MemoryActor
  provenance: MemoryProvenance | null
  /** true when actor = 'agent' and the grant id no longer resolves (MEMORY.md §1 threat model). */
  unattributed: boolean
  /** Counts over this entity's facts, for badges. `unreviewed` = active agent facts the user hasn't touched. */
  counts: { active: number; pending: number; invalid: number; unreviewed: number; pinned: number }
  /** Active relations touching this entity (degree). */
  degree: number
  createdAt: ISODate
  updatedAt: ISODate
  /** max(updated_at) over the entity, its facts and relations: drives the "changed in the last 7 days" ring (PO8). */
  changedAt: ISODate
}

export interface MemoryFact {
  id: Id
  entityId: Id
  entityName: string
  text: string // redacted
  kind: MemoryFactKind
  scope: MemoryScope
  repoId: Id | null
  status: MemoryStatus
  reviewed: boolean
  pinned: boolean
  invalidatedAt: ISODate | null
  invalidReason: string | null
  supersededBy: Id | null
  /** Ids this fact superseded (inverse of supersededBy), oldest first. */
  supersedes: Id[]
  actor: MemoryActor
  provenance: MemoryProvenance | null
  unattributed: boolean
  editedByUser: boolean
  createdAt: ISODate
  updatedAt: ISODate
}

export interface MemoryRelation {
  id: Id
  fromId: Id
  toId: Id
  type: string
  scope: MemoryScope
  repoId: Id | null
  status: MemoryStatus
  reviewed: boolean
  invalidatedAt: ISODate | null
  invalidReason: string | null
  supersededBy: Id | null
  actor: MemoryActor
  provenance: MemoryProvenance | null
  unattributed: boolean
  createdAt: ISODate
  updatedAt: ISODate
}

/** Which slice of memory a page query targets. */
export interface MemoryScopeFilter {
  /** 'all' = everything; 'global' = global rows only; { repoId } = that repo's project rows + global rows. */
  scope: 'all' | 'global' | { repoId: Id }
  kinds?: MemoryFactKind[]
  adapters?: AdapterId[]
  actors?: MemoryActor[]
  /** Default ['active','pending']. Add 'invalid' for "history". */
  statuses?: MemoryStatus[]
  unreviewedOnly?: boolean
  /** Run filter (PO8/PO9): rows written or invalidated by grants of this run. Graph: dims, Facts: filters. */
  runId?: Id
  /** LIVE.md §7: rows written by grants of this interactive session. */
  sessionId?: Id
}

export interface MemoryGraphQuery extends MemoryScopeFilter {
  /** Neighborhood mode: center entity + hops (1..2). Omit for the ranked overview. */
  centerId?: Id
  hops?: 1 | 2
  limit?: number // default 150, max 150 (PO8)
}
export interface MemoryGraph {
  entities: MemoryEntity[]
  relations: MemoryRelation[] // only between returned entities
  /** With `runId`: ids of returned entities that run wrote to or invalidated on (everything else is dimmed). */
  runTouched: Id[] | null
  total: number // entities matching the filter before the cap
  truncated: boolean
}

export interface MemorySearchQuery extends MemoryScopeFilter {
  query: string // 1..300 chars
  includeHistory?: boolean
  limit?: number // default 20, max 50
}
/** Per-factor breakdown of the top fact's score (PO5), shown in the page so a human can see why it ranked. */
export interface MemoryScoreWhy {
  /** true = exact entity name/alias match (ranked ahead of FTS). */
  exact: boolean
  bm25: number // normalized 0..1
  scope: number // project 1.0, global 0.8
  trust: number // pinned 1.3, user/reviewed 1.15, agent 1.0
  recency: number // max(0.5, 0.5^(ageDays/180))
}
export interface MemorySearchHit {
  entity: MemoryEntity
  facts: MemoryFact[] // <= 5, best first
  relations: MemoryRelation[]
  score: number
  why: MemoryScoreWhy
}

export interface MemoryEntityDetail {
  entity: MemoryEntity
  /** All statuses (History = supersede chains + invalid facts), grouped client-side. */
  facts: MemoryFact[]
  relations: { out: MemoryRelation[]; in: MemoryRelation[] }
  neighbors: MemoryEntity[] // the other ends of relations
}

export interface MemoryFactQuery extends MemoryScopeFilter {
  entityId?: Id
  text?: string // FTS filter
  offset?: number
  limit?: number // default 200, max 1000; always newest first (PO9)
}

export interface MemoryGrantInfo extends MemoryProvenance {
  mode: Exclude<MemoryMode, 'off'>
  closedAt: ISODate | null
  /** Counts of rows created / invalidated by this grant. */
  wrote: { facts: number; relations: number; invalidated: number }
  /** LIVE.md §7: memory_search/memory_get calls by the grant's step/session agents (hive.db). */
  reads?: number
}

export interface MemoryOverview {
  agentWritesPaused: boolean
  counts: { entities: number; facts: number; relations: number; pending: number; unreviewed: number }
  /** Repos that have memory, most recently changed first (scope picker). */
  repos: { repoId: Id; repoName: string; facts: number; changedAt: ISODate }[]
  /** Repo the page opens on (PO8): most recently used repo with memory, else Settings.lastRepoId. */
  defaultRepoId: Id | null
  lastSeq: number
  dbPath: string
  dbBytes: number
}

/** Inputs for user-authored writes (page). Actor is always 'user', reviewed = true. */
export interface MemoryEntityInput {
  repoId: Id | null
  name: string // 1..120
  type?: string
  summary?: string
  aliases?: string[]
}
export interface MemoryFactInput {
  entityId: Id
  text: string // 3..1000
  kind?: MemoryFactKind
  /** 'project' requires the entity's repo (or repoId); 'global' is allowed for the user only. */
  scope: MemoryScope
  repoId?: Id | null
  pinned?: boolean
  /** "Replace with…": the new fact supersedes these active facts of the same entity. */
  supersedes?: Id[]
}
export interface MemoryRelationInput {
  fromId: Id
  toId: Id
  type: string // 2..40
  scope: MemoryScope
}

/** PO10: one channel for most edits. */
export type MemoryMutation =
  | { op: 'create'; target: 'entity'; input: MemoryEntityInput }
  | { op: 'create'; target: 'fact'; input: MemoryFactInput }
  | { op: 'create'; target: 'relation'; input: MemoryRelationInput }
  /** Fact: in-place text/kind edit (editedByUser). Entity: type/summary/aliases. Relation: type. */
  | { op: 'edit'; target: 'fact'; id: Id; text?: string; kind?: MemoryFactKind }
  | { op: 'edit'; target: 'entity'; id: Id; type?: string; summary?: string; aliases?: string[] }
  | { op: 'edit'; target: 'relation'; id: Id; type: string }
  /** Entity rename; re-indexes its facts. `conflict` if the normalized name exists in that repo/global. */
  | { op: 'rename'; id: Id; name: string }
  | { op: 'pin' | 'unpin'; ids: Id[] } // facts only
  | { op: 'approve'; target: 'fact' | 'relation'; ids: Id[] }
  | { op: 'invalidate'; target: 'fact' | 'relation'; ids: Id[]; reason: string }
  | { op: 'restore'; target: 'fact' | 'relation'; ids: Id[] }
  | { op: 'toGlobal'; ids: Id[] } // project facts -> global (user only)
  | { op: 'merge'; sourceIds: Id[]; targetId: Id }
export type MemoryMutationOp = MemoryMutation['op']
export interface MemoryMutationResult {
  /** Rows changed. */
  affected: number
  entity?: MemoryEntity
  fact?: MemoryFact
  relation?: MemoryRelation
}

export interface MemoryChangedEvent {
  seq: number
  runIds: Id[]
  entityIds: Id[]
  /** True when the pending (Review) count may have changed. */
  pendingDelta: boolean
}
