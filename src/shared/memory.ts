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
/**
 * PASSPORT.md §7.2: vault grants add memory_link (cheap relation-only writes) and memory_taste (Open Passport taste,
 * filed for review). The v1 grants keep MEMORY_WRITE_TOOLS.
 */
export const VAULT_WRITE_TOOLS = ['memory_write', 'memory_link', 'memory_invalidate', 'memory_taste'] as const
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

// ======================================================================================
// Passport vault agent interface (PASSPORT.md §7). Main and the hivemem server share these shapes: the server reads
// passport-index.db read-only and sends every write to main through the per-grant spool (§7.1).

/** memory_write (§7.2). `entity` is the legacy name of `note`. */
export interface VaultWriteArgs {
  note: string
  entity?: string
  type?: string
  aliases?: string[]
  tags?: string[]
  summary?: string
  /** `kind` is the observation category (fact, decision, convention, gotcha or any extended category). */
  facts?: { text: string; kind?: string; supersedes?: string | string[] }[]
  relations?: { type: string; to: string; context?: string }[]
  /** Create `Inbox/` stubs for ghost targets; otherwise ghosts stay ghosts (legal). */
  create_missing?: boolean
}
export interface VaultUnresolved {
  to: string
  status: 'ghost' | 'ambiguous'
  did_you_mean: string[]
}
/** Lines that were not written: contested supersedes and instruction-looking text wait in the Passport Inbox. */
export interface VaultPendingLine {
  text: string
  why: string
  proposal: string | null
}
export interface VaultWriteResult {
  note: string // "[[Title]]"
  created: boolean
  path: string | null
  written: { ref: string; text: string }[]
  duplicates: { ref: string; text: string }[]
  similar: { ref: string; text: string }[]
  linked: { to: string; via: string; type: string }[]
  autolinked: string[]
  unresolved: VaultUnresolved[]
  pending: VaultPendingLine[]
  conflicts: string[]
  hints: { unlinked: string[] }
  next: string | null
  writes_left: number
}
/** memory_link (§7.2): relation-only writes; `type` defaults to relates_to. */
export interface VaultLinkArgs {
  links: { from: string; type?: string; to: string; context?: string }[]
}
export interface VaultLinkResult {
  linked: { from: string; type: string; to: string; ref: string | null; result: 'added' | 'duplicate' | 'error'; why?: string }[]
  unresolved: VaultUnresolved[]
  writes_left: number
}
/** memory_invalidate (§7.2): moves lines to History; soft ids are materialized first. */
export interface VaultInvalidateArgs {
  refs: string[]
  reason: string
  replaced_by?: string
}
export interface VaultInvalidateResult {
  items: { ref: string; result: 'invalidated' | 'contested' | 'not_found' | 'already_invalid' | 'conflict'; why?: string }[]
  writes_left: number
}

// ---------- the write spool (§7.1) ----------
/**
 * One request file per call in `HIVE_MEM_SPOOL` (`<userData>/mem-rpc/<grantId>/`): the server writes `<id>.request`
 * (0600, tmp + rename), main answers `<id>.answer` and drops the request; the server reads and drops the answer.
 * `hit` reports notes fetched with memory_get after they appeared in the brief (§8.3 brief_hits).
 */
export const MEM_RPC = {
  version: 1,
  requestSuffix: '.request',
  answerSuffix: '.answer',
  /** a request main has claimed (renamed from .request) and is applying */
  takingSuffix: '.taking',
  /** request and answer cap (the gateway's private-json pattern) */
  maxBytes: 256 * 1024,
  /** client poll backoff 5 -> 100 ms, then "Principia is not running; memory is read-only" */
  pollMinMs: 5,
  pollMaxMs: 100,
  timeoutMs: 10_000,
  idPattern: /^[a-z0-9]{8,64}$/
} as const
export const MEM_RPC_METHODS = ['write', 'link', 'invalidate', 'hit', 'taste'] as const
export type MemRpcMethod = (typeof MEM_RPC_METHODS)[number]
export interface MemRpcArgs {
  write: VaultWriteArgs
  link: VaultLinkArgs
  invalidate: VaultInvalidateArgs
  hit: { notes: string[] }
  taste: VaultTasteArgs
}
/**
 * memory_taste (Open Passport `passport_taste_feedback`): `scope` is `company`, `department` (the run's own) or
 * `department:<name>`. Filed as a proposal unless `stated_by_user` (the person said it; quote them in `example`).
 */
export interface VaultTasteArgs {
  scope: string
  polarity: 'likes' | 'dislikes' | 'prefers' | 'avoid'
  text: string
  example: string
  stated_by_user?: boolean
}
export interface VaultTasteResult {
  /** written = on the note now; proposed = waiting in the Inbox; known = this exact signal was filed before */
  status: 'written' | 'proposed' | 'known'
  note: string
  reinforced: boolean
  proposal?: string
}
export interface MemRpcResults {
  write: VaultWriteResult
  link: VaultLinkResult
  invalidate: VaultInvalidateResult
  hit: { counted: number }
  taste: VaultTasteResult
}
export interface MemRpcRequest<M extends MemRpcMethod = MemRpcMethod> {
  v: 1
  grantId: Id
  /** HIVE_COMPANY_ID; the bridge refuses a request whose grant belongs to another company */
  companyId: Id
  method: M
  args: MemRpcArgs[M]
  /** MCP call id: opId = grantId + callId, so a replayed call returns the first result */
  callId?: string
}
export type MemRpcErrorCode = 'refused' | 'validation' | 'not_found' | 'conflict' | 'company' | 'internal'
export type MemRpcAnswer<M extends MemRpcMethod = MemRpcMethod> = { ok: true; result: MemRpcResults[M] } | { ok: false; code: MemRpcErrorCode; error: string }
export const MEM_UNREACHABLE = 'Principia is not running; memory is read-only'

/** Env of a vault-mode hivemem spawn (§7.1). HIVE_VAULT is for messages only. */
export const VAULT_MEM_ENV = ['HIVE_MEM_INDEX', 'HIVE_MEM_GRANT', 'HIVE_MEM_FP', 'HIVE_MEM_SPOOL', 'HIVE_COMPANY_ID', 'HIVE_VAULT'] as const
