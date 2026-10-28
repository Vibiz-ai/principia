/**
 * The Passport vault IPC contract (PASSPORT.md §11), declared up front by COMPANY.md C3 and implemented by P3.
 * Five op-multiplexed channels: memory:note, memory:graph (its v1 query keeps working), memory:links,
 * memory:proposals and memory:vault. Every request names its company; nothing is resolved from a "current company".
 * TYPE-ONLY except small `as const` lists and one type guard. No Node or DOM imports.
 */
import type { ISODate, Id } from './types'

/**
 * Note identity inside one vault: frontmatter `id` (`n-<10 base36>`), or `h:<vault-relative path>` for a note written
 * in Obsidian without one (PASSPORT.md §3.1).
 */
export type NoteId = string
/** Vault-relative path with `.md`, `/`-separated, e.g. `People/Ana Ruiz.md`. */
export type NotePath = string
/** A note named the way agents and the UI name it: `[[Title]]`, a title, an alias, a path or a note id (§5). */
export type NoteName = string
/** `f-…` / `r-…` block id, or a soft `h:<sha1>` key for a hand-written line (§3.2). */
export type BlockRef = string
export type NoteRef = { path: NotePath } | { id: NoteId }
/** sha1 hex of the file bytes: the writer's and the editor's compare-and-swap base (§6.4). */
export type ContentHash = string

export const NOTE_STATUSES = ['active', 'archived'] as const
export type NoteStatus = (typeof NOTE_STATUSES)[number]
export const VAULT_FACT_STATUSES = ['active', 'pending', 'superseded', 'invalid', 'removed_external'] as const
export type VaultFactStatus = (typeof VAULT_FACT_STATUSES)[number]
export type VaultFactKind = 'fact' | 'decision' | 'convention' | 'gotcha' | 'other'
export const LINK_ORIGINS = ['body', 'relation', 'property', 'bullet', 'fact'] as const
export type LinkOrigin = (typeof LINK_ORIGINS)[number]
/** Frontmatter values the UI and ops read and write (unknown YAML stays untouched in the file). */
export type VaultPropertyValue = string | number | boolean | string[] | null

// ---------- writer ops (§6.4: semantic, never whole-file) ----------
export type VaultOp =
  | { op: 'createNote'; title: string; type: string; summary?: string; aliases?: string[]; properties?: Record<string, VaultPropertyValue>; folder?: string }
  | { op: 'observe'; note: NoteName; category: string; text: string; tags?: string[] }
  | { op: 'relate'; from: NoteName; rel: string; to: NoteName; context?: string }
  | { op: 'supersede'; blockId: BlockRef; text: string }
  | { op: 'invalidate'; blockId: BlockRef; reason: string }
  | { op: 'setProperty'; note: NoteName; key: string; value: VaultPropertyValue }
  | { op: 'addAlias'; note: NoteName; alias: string }
  | { op: 'rename'; note: NoteName; newTitle: string }
  | { op: 'archive'; note: NoteName }
  | { op: 'merge'; from: NoteName; into: NoteName }
  | { op: 'linkMention'; note: NoteName; line: number; span: { start: number; end: number }; target: NoteName; /** the mention's text; refused (stale) when the span holds other words */ text?: string }
  | { op: 'materializeId'; note: NoteName; line: number }
  | { op: 'restoreLine'; blockId: BlockRef }
  /** a taste line seen again: `x<count>` + 1 and the example added, in place (Open Passport SPEC.md §4.6) */
  | { op: 'reinforce'; blockId: BlockRef; example?: string }
export type VaultOpKind = VaultOp['op']
export const VAULT_OP_KINDS = [
  'createNote', 'observe', 'relate', 'supersede', 'invalidate', 'setProperty', 'addAlias', 'rename', 'archive', 'merge',
  'linkMention', 'materializeId', 'restoreLine', 'reinforce'
] as const satisfies readonly VaultOpKind[]

export interface VaultOpResult {
  /** index into the request's ops */
  index: number
  /** noop = already true (dedup, idempotent replay); conflict = the target line or base changed (§6.4, never guessed) */
  status: 'ok' | 'noop' | 'conflict' | 'error'
  path: NotePath | null
  noteId: NoteId | null
  /** the line written or moved, when the op targets one */
  blockId: string | null
  hash: ContentHash | null
  reason: string | null
}
export interface VaultConflict {
  id: Id
  companyId: Id
  path: NotePath
  op: VaultOp
  reason: string
  baseHash: ContentHash | null
  currentHash: ContentHash | null
  createdAt: ISODate
  resolvedAt: ISODate | null
}
export interface VaultApplyResult {
  results: VaultOpResult[]
  conflicts: VaultConflict[]
}

// ---------- notes ----------
export interface VaultNoteSummary {
  id: NoteId
  companyId: Id
  path: NotePath
  title: string
  type: string
  status: NoteStatus
  pinned: boolean
  summary: string
  aliases: string[]
  tags: string[]
  created: string | null // YYYY-MM-DD from frontmatter
  modified: string | null
  /** inbound resolved links (graph node size) */
  inDegree: number
  outDegree: number
}
export interface VaultFact {
  /** `mfa_<x>` (v1-compatible) or `h:<sha1>` soft key */
  id: string
  blockId: string | null
  line: number // 0-based line in the file
  section: 'obs' | 'history'
  category: string
  kind: VaultFactKind
  text: string // redacted
  tags: string[]
  status: VaultFactStatus
  supersededBy: string | null
  pinned: boolean
  reviewed: boolean
  actor: string // user | claude | codex | gemini | cursor | migration | suggestion
  runId: Id | null
  sessionId: Id | null
  date: string | null
  repoId: Id | null
}
export interface VaultLink {
  id: string
  fromNote: NoteId
  fromTitle: string
  /** the observation the link sits in (`links_to` from a fact) */
  fromFact: string | null
  line: number
  /** relation type as written after normalization (`links_to`, `works_at`, a property key, …) */
  rel: string
  /** inverse display label for backlinks ("decided_by"), from the ontology */
  inverse: string
  origin: LinkOrigin
  /** null = ghost (no note yet) or ambiguous */
  toNote: NoteId | null
  toTitle: string | null
  toText: string
  heading: string | null
  block: string | null
  display: string | null
  embed: boolean
  ambiguous: boolean
  /** ambiguous candidates (note titles) */
  candidates: string[]
  context: string | null
  blockId: string | null
  status: 'active' | 'pending' | 'invalid'
}
export interface VaultNoteDetail {
  note: VaultNoteSummary
  properties: Record<string, VaultPropertyValue>
  facts: VaultFact[]
  relations: VaultLink[]
  /** every outgoing link (prose, bullets, relations, properties), ghosts marked by toNote = null */
  outgoing: VaultLink[]
  /** the note failed to parse cleanly and is indexed as prose (never rewritten, §13) */
  parseWarnings: string[]
  /** a newer file is on disk than the index saw (watcher catching up) */
  stale: boolean
}
export interface VaultNoteText {
  text: string
  hash: ContentHash
  detail: VaultNoteDetail
}
/** §6.4 editor save: a stale baseHash merges with diff3; removed block-id facts move to History, never dropped. */
export type VaultSaveResult =
  | { status: 'saved'; hash: ContentHash; detail: VaultNoteDetail; movedToHistory: number }
  | { status: 'conflict'; base: string; ours: string; theirs: string; theirsHash: ContentHash; merged: string | null; clean: boolean }

export type PassportNoteRequest =
  | ({ op: 'get'; companyId: Id } & NoteRef)
  | { op: 'save'; companyId: Id; path: NotePath; baseHash: ContentHash; text: string }
  | { op: 'ops'; companyId: Id; ops: VaultOp[] }
  | { op: 'create'; companyId: Id; title: string; type?: string; folder?: string; properties?: Record<string, VaultPropertyValue>; fromGhost?: boolean }
  | ({ op: 'rename'; companyId: Id; newTitle: string } & NoteRef)
  /** archive replaces delete (§1.5); archived = false restores */
  | ({ op: 'archive'; companyId: Id; archived?: boolean } & NoteRef)
export interface PassportNoteResults {
  get: VaultNoteText
  save: VaultSaveResult
  ops: VaultApplyResult
  create: VaultNoteSummary
  rename: { note: VaultNoteSummary; linksRewritten: number }
  archive: VaultNoteSummary
}

// ---------- graph (§8.1, §10 Graph mode) ----------
/** [id, title, type, inDegree, ghost (1 = no note yet), tag indexes into VaultGraph.tags] */
export type VaultGraphNode = [id: string, title: string, type: string, inDegree: number, ghost: 0 | 1, tags: number[]]
/** [source node index, target node index, relation index into VaultGraph.rels, weight] */
export type VaultGraphEdge = [source: number, target: number, rel: number, weight: number]
/** Compact payload: up to 5000 nodes (global) or 300 (local). Ghost node ids are `ghost:<to_norm>`, tag nodes `tag:<tag>`. */
export interface VaultGraph {
  companyId: Id
  nodes: VaultGraphNode[]
  edges: VaultGraphEdge[]
  rels: string[]
  tags: string[]
  /** persisted positions from mem_layout: [nodeId, x, y, pinned] */
  positions: [id: string, x: number, y: number, pinned: 0 | 1][]
  /** local graph center */
  centerId: string | null
  /** nodes before the cap */
  total: number
  truncated: boolean
}
export interface GlobalGraphFilters {
  search?: string
  tags?: string[]
  types?: string[]
  /** hide ghosts */
  existingOnly?: boolean
  orphans?: boolean
  includeArchived?: boolean
  /** tags as nodes */
  includeTags?: boolean
}
export interface LocalGraphFilters {
  tags?: boolean
  ghosts?: boolean
  includeArchived?: boolean
}
export interface GraphPosition {
  noteId: string
  x: number
  y: number
  pinned?: boolean
}
export type PassportGraphRequest =
  | { op: 'global'; companyId: Id; filters?: GlobalGraphFilters }
  | { op: 'local'; companyId: Id; noteId: NoteId; depth: 1 | 2 | 3; filters?: LocalGraphFilters }
  | { op: 'layout'; companyId: Id; positions: GraphPosition[] }
export interface PassportGraphResults {
  global: VaultGraph
  local: VaultGraph
  layout: { saved: number }
}

// ---------- links, tags, ghosts, tree ----------
export interface BacklinkGroup {
  /** inverse label shown in the panel ("decided_by", "linked_from") */
  label: string
  rel: string
  items: { fromNote: NoteId; fromTitle: string; fromPath: NotePath; line: number; context: string; factId: string | null }[]
}
export interface UnlinkedMention {
  noteId: NoteId
  title: string
  path: NotePath
  line: number
  text: string
  /** the matched title or alias inside `text` */
  span: { start: number; end: number }
  matched: string
}
export interface VaultTagCount {
  tag: string // normalized, nested with `/`
  display: string
  count: number
}
export interface VaultGhost {
  text: string
  norm: string
  inbound: number
  /** distinct linking notes */
  sources: number
  ambiguous: boolean
  candidates: string[]
  /** a guessed type from relation ranges (§4) */
  guessedType: string | null
}
export interface VaultTreeEntry {
  id: NoteId
  path: NotePath
  title: string
  type: string
  status: NoteStatus
  pinned: boolean
  modified: string | null
  /** no links in or out */
  orphan: boolean
  /** frontmatter aliases (editor `[[` completion); absent from older mains */
  aliases?: string[]
}
export type PassportLinksRequest =
  | { op: 'backlinks'; companyId: Id; noteId: NoteId }
  | { op: 'unlinked'; companyId: Id; noteId: NoteId; limit?: number }
  | { op: 'outgoing'; companyId: Id; noteId: NoteId }
  | { op: 'tags'; companyId: Id }
  | { op: 'ghosts'; companyId: Id; limit?: number }
  | { op: 'tree'; companyId: Id; includeArchived?: boolean }
export interface PassportLinksResults {
  backlinks: BacklinkGroup[]
  unlinked: UnlinkedMention[]
  outgoing: VaultLink[]
  tags: VaultTagCount[]
  ghosts: VaultGhost[]
  tree: VaultTreeEntry[]
}

// ---------- proposals (§12) ----------
export const PROPOSAL_KINDS = [
  'link', 'retarget', 'entity', 'merge', 'relation', 'relation_type', 'disambiguate', 'alias_rewrite', 'rename_links',
  'fact_supersede', 'harvest', 'conflict', 'external_removal', 'assign_company',
  /** a taste inferred from a signal (approve, send back, an agent's memory_taste); accept writes or reinforces it */
  'taste',
  /** an Open Passport import merge that kept our line; accept applies theirs */
  'import_conflict'
] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]
/** Inbox "Needs decision": the only kinds that count for the sidebar badge (§10). */
export const NEEDS_DECISION_KINDS = ['fact_supersede', 'conflict', 'external_removal', 'import_conflict'] as const satisfies readonly ProposalKind[]
export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'stale'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
/**
 * stage 0 (mentions, ghosts, dupes, ontology), stage 1 (cooccur, similar), stage 2 (llm), harvest, the writer itself,
 * taste signals (`agent` = memory_taste, `board` = a task approved or sent back) and Open Passport `import` merges
 */
export type ProposalSource = 'mentions' | 'ghosts' | 'dupes' | 'ontology' | 'cooccur' | 'similar' | 'llm' | 'harvest' | 'writer' | 'indexer' | 'migration' | 'agent' | 'board' | 'import' | 'run-report'
export interface ProposalEvidence {
  path: NotePath | null
  line: number | null
  quote: string
  note: string | null
}
export interface ProposalPreview {
  path: NotePath
  /** unified-diff-like lines of the exact markdown change */
  before: string
  after: string
}
export interface VaultProposal {
  /** `sg-<base36>`, cited in provenance as "user via suggestion sg-…" */
  id: string
  companyId: Id
  kind: ProposalKind
  title: string
  ops: VaultOp[]
  evidence: ProposalEvidence[]
  preview: ProposalPreview[]
  score: number
  source: ProposalSource
  status: ProposalStatus
  needsDecision: boolean
  createdAt: ISODate
  decidedAt: ISODate | null
  decidedBy: string | null
}
export type PassportProposalsRequest =
  | { op: 'list'; companyId: Id; status?: ProposalStatus[]; kinds?: ProposalKind[]; noteId?: NoteId; limit?: number }
  | { op: 'accept'; companyId: Id; ids: string[]; addAlias?: boolean }
  | { op: 'reject'; companyId: Id; ids: string[] }
  /** E: replace the proposal's ops (the user's edit); accept = apply right away */
  | { op: 'edit'; companyId: Id; id: string; ops: VaultOp[]; accept?: boolean }
  | { op: 'suggestNow'; companyId: Id; noteId?: NoteId }
export interface PassportProposalsResults {
  list: { items: VaultProposal[]; total: number; needsDecision: number }
  accept: { accepted: number; stale: number; results: VaultApplyResult }
  reject: { rejected: number }
  edit: VaultProposal
  suggestNow: { queued: boolean; created: number }
}

// ---------- vault (§2, §6.2, §9) ----------
export type VaultState = 'missing' | 'seeding' | 'indexing' | 'ready' | 'readonly' | 'error'
export interface VaultStatus {
  companyId: Id
  /** absolute vault folder */
  root: string
  /** company_passports.vault_path is set ("Use existing folder…") */
  customPath: boolean
  exists: boolean
  state: VaultState
  /** another Principia instance holds `.principia/writer.lock` */
  readOnlyReason: string | null
  /** the folder is on iCloud Drive (watcher may lag, §6.3) */
  onICloud: boolean
  noteCount: number
  ghostCount: number
  pendingSuggestions: number
  needsDecision: number
  lastFullScanAt: ISODate | null
  formatVersion: number | null
  error: string | null
}
export interface VaultMigrationReport {
  dryRun: boolean
  /** a previous run already migrated; nothing (more) to write */
  alreadyMigrated: boolean
  backupPath: string | null
  companies: { companyId: Id; name: string; hubNote: boolean; repoNotes: number; entityNotes: number; observations: number; historyLines: number; proposals: number }[]
  totals: { entityNotes: number; observations: number; historyLines: number; proposals: number; events: number }
  warnings: string[]
}
export type PassportVaultRequest =
  | { op: 'status'; companyId: Id }
  | { op: 'reindex'; companyId: Id }
  /** obsidian://open?path=…; falls back to opening the folder with a one-time "Open folder as vault" hint */
  | { op: 'openInObsidian'; companyId: Id; path?: NotePath }
  | { op: 'reveal'; companyId: Id; path?: NotePath }
  /** path null = back to `<userData>/companies/<slug>/Passport`; pick = native folder picker (null result = canceled) */
  | { op: 'setPath'; companyId: Id; path: string | null }
  | { op: 'setPath'; companyId: Id; pick: true }
  /** every company at once (§9); dryRun shows the report without writing */
  | { op: 'migrate'; dryRun: boolean }
  /** §12 Settings → Passport → "Suggest with AI" and Suggestion activity (per company) */
  | { op: 'aiSettings'; companyId: Id }
  | { op: 'setAi'; companyId: Id; optedIn?: boolean; dailyCap?: number }
export interface PassportVaultResults {
  status: VaultStatus
  reindex: VaultStatus
  openInObsidian: { opened: 'obsidian' | 'folder'; hint: string | null }
  reveal: void
  setPath: VaultStatus | null
  migrate: VaultMigrationReport
  aiSettings: PassportAiSettings
  setAi: PassportAiSettings
}
/** §12: the opt-in AI suggestion tier of one company. `enabled` is the app-wide `experimental.vaultAI` flag. */
export interface PassportAiSettings {
  enabled: boolean
  optedIn: boolean
  dailyCap: number
  callsToday: number
  /** the last calls, newest first */
  activity: { at: string; cli: string | null; trigger: string; ok: boolean; proposals: number; dropped: number; ms: number; error: string | null }[]
}

// ---------- departments (DEPARTMENTS.md §7) ----------
/**
 * A department's passport section: one `type: department` note at `Departments/<Name>.md`, `part_of [[Company]]`, with
 * the sections Observations / Processes / Relations. A relation, not a separate vault: writes keep company scope.
 */
export const DEPARTMENT_NOTE_TYPE = 'department'
export const DEPARTMENT_NOTE_FOLDER = 'Departments'
export const DEPARTMENT_NOTE_SECTIONS = ['Observations', 'Processes', 'Relations'] as const
/** Frontmatter key that ties the note to its `company_departments` row, so a renamed department keeps its note. */
export const DEPARTMENT_ID_KEY = 'department_id'
/** What the brief's department slot needs from a run's department (a narrow view of `Department`). */
export interface PassportDepartment {
  id: Id
  companyId: Id
  name: string
  /** vault note title once the note exists (DepartmentData.passportNote) */
  passportNote: string | null
  /** injected in the slot when the vault is off or the note has nothing to say */
  contextFallback: string
  charter: { does: string; doesNot: string }
}

// ---------- events ----------
/** PASSPORT.md §6.2 / §11: memory:changed gains the company and the touched notes. */
export interface PassportChangedFields {
  companyId?: Id
  paths?: NotePath[]
  noteIds?: NoteId[]
}

/** memory:graph carries both the v1 query (no `op`) and the Passport graph ops. */
export const isPassportGraphRequest = <T extends object>(q: T | PassportGraphRequest): q is PassportGraphRequest =>
  typeof (q as { op?: unknown }).op === 'string'

/** Result of an op-multiplexed channel for a given request: `PassportNoteResults[R['op']]`, etc. */
export type OpResult<Results, R extends { op: string }> = R['op'] extends keyof Results ? Results[R['op']] : never

// ---------- Open Passport export / import (open-passport SPEC.md) ----------
/** company:previewOpenPassport: what a passport folder or `.passport.zip` would bring in, before anything is written. */
export interface OpenPassportPreview {
  /** the chosen folder or zip */
  source: string
  name: string
  /** the passport's stable id and content revision (null for a plain vault without passport.json) */
  id: string | null
  revision: number | null
  digest: string | null
  /** the L0 card (~300 tokens) as any harness would load it */
  card: string
  departments: { slug: string; name: string; does: string }[]
  notes: number
  taste: number
  /** refusing problems (secrets, scripts, unsafe paths); import is refused while any is listed */
  errors: string[]
  warnings: string[]
}
export interface OpenPassportExportResult {
  path: string
  revision: number
  digest: string
  /** estimated tokens of the L0 card and the largest L1 department slot */
  tokens: { l0: number; l1Max: number }
}
export interface OpenPassportImportResult {
  companyId: Id
  mode: 'new' | 'merge'
  /** new: notes written; merge: notes updated and created */
  notes: number
  departmentsCreated: number
  /** merge: conflicts kept as ours and filed as import_conflict proposals in the Inbox */
  conflicts: number
  /** merge: whether a copy we exported or imported earlier was the common base (a true three-way merge) */
  based: boolean
}
/** company:openPassportSync: a company's Open Passport host (off until configured; the token never comes back). */
export interface OpenPassportSyncView {
  url: string
  passportId: string
  hasToken: boolean
  /** the host revision last pulled or pushed */
  base: number | null
  lastSync: string | null
}
export type OpenPassportSyncRequest =
  | { op: 'get'; companyId: Id }
  | { op: 'set'; companyId: Id; url: string; passportId: string; token?: string }
  | { op: 'clear'; companyId: Id }
  | { op: 'sync'; companyId: Id }
export interface OpenPassportSyncResult {
  config: OpenPassportSyncView | null
  /** set after op 'sync' */
  sync?: { pulled: { from: number | null; to: number; notes: number; conflicts: number } | null; pushed: { revision: number; conflicts: number } | null; revision: number }
}

// ---------- Use this Passport in other apps / Import into Passport (open-passport docs/connect.md) ----------
export type PassportConnectApp = 'claude-desktop' | 'cursor' | 'vscode' | 'codex' | 'claude-code' | 'windsurf' | 'gemini' | 'chatgpt' | 'claude-ai'
export interface PassportConnectSnippet {
  app: PassportConnectApp
  label: string
  /** where it goes (a config file, a settings path, the terminal) */
  where: string
  text: string
  /** a one-click action Principia offers for it (only ever on the user's click): write the config, or open the app's install link */
  action: 'install' | 'open' | null
}
/** 'dmg': running from the mounted disk image; 'translocated': macOS App Translocation. Both paths go away. */
export type AppLocationProblem = 'dmg' | 'translocated'
export interface PassportConnectInfo {
  /** the server name other apps show, `<slug>-passport` */
  serverName: string
  vault: string
  /** stdio configs: Principia's runtime serving the live vault, writes queued for the Inbox */
  local: PassportConnectSnippet[]
  /** with Cloud sync on: the host's MCP URL, for ChatGPT and Claude.ai */
  hosted: { mcpUrl: string; snippets: PassportConnectSnippet[] } | null
  claudeDesktop: { configPath: string; installed: boolean }
  /** Principia runs from the DMG or translocated (main/appLocation.ts): the local configs would break, installs are off */
  location: AppLocationProblem | null
  /** writes other apps queued that are not in the Inbox yet */
  queued: number
}
export type PassportConnectRequest =
  | { op: 'info'; companyId: Id }
  | { op: 'install'; companyId: Id; app: 'claude-desktop' }
  | { op: 'open'; companyId: Id; app: 'cursor' | 'vscode'; hosted?: boolean }
  | { op: 'hostSignIn'; companyId: Id }
  | { op: 'ingest'; companyId: Id }
export interface PassportConnectResult {
  info?: PassportConnectInfo
  installed?: { path: string; replaced: boolean; backup: string | null }
  ingested?: { filed: number; known: number; skipped: number }
  opened?: boolean
}

/** `export`: a ChatGPT or Claude data export (zip or unzipped folder, detected); `folder`: Notion, Obsidian, markdown. */
export type PassportImportKind = 'export' | 'folder' | 'url' | 'text'
export interface PassportImportRequest {
  companyId: Id
  kind: PassportImportKind
  /** a path (export, folder) or an https URL; main shows a picker when a path is needed and absent */
  source?: string
  text?: string
  /** most candidates (default 40) */
  max?: number
}
export interface PassportImportResult {
  kind: 'chatgpt' | 'claude' | 'folder' | 'url' | 'text'
  candidates: number
  /** new Inbox proposals */
  filed: number
  /** already in the Inbox, decided before, or already true */
  known: number
  skipped: number
  documents: number
  /** candidates over the budget */
  dropped: number
  preview: { kind: 'fact' | 'taste'; note: string; text: string; from: string }[]
}
