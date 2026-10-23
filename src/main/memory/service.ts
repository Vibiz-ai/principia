/**
 * Main-process memory service (MEMORY.md §1, §3.4, §9, §10.7; PASSPORT.md §6-§8, §11): implements the engine's
 * MemoryBridge (grants + brief), writes the secret fingerprint file, sweeps spawn files and polls for changes.
 *
 * Two backends behind one bridge. While `settings.experimental.vault` is off it is the v1 memory.db path, unchanged.
 * With the flag on (and the CompanyStore injected by hive.ts) grants, briefs and writes go to the company Passport
 * vaults: one passport-index.db, one indexer + watcher + writer lock per company vault, the per-grant write spool
 * (vault/rpc.ts), policy.ts then sink.ts for every write, and the company card registered through
 * setPassportRenderer. memory.db is never written in vault mode (it stays the v1 archive).
 * No Electron imports (handlers/memory.ts does dialogs and the shell), so it is unit-testable.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AdapterId, Id, Repo } from '../../shared/types'
import type { MemoryBridge, MemoryGrant, MemoryGrantRequest } from '../../shared/engine'
import {
  MEMORY_READ_TOOLS,
  MEMORY_SERVER_NAME,
  MEMORY_WRITE_TOOLS,
  VAULT_WRITE_TOOLS,
  type MemoryChangedEvent,
  type MemoryFact,
  type MemoryFactKind,
  type MemRpcRequest,
  type VaultInvalidateArgs,
  type VaultLinkArgs,
  type VaultTasteArgs,
  type VaultTasteResult,
  type VaultWriteArgs
} from '../../shared/memory'
import type { NotePath, PassportChangedFields, PassportDepartment, ProposalKind, ProposalSource, ProposalStatus, VaultApplyResult, VaultMigrationReport, VaultOp, VaultProposal, VaultStatus } from '../../shared/passport'
import { DEPARTMENT_ID_KEY, DEPARTMENT_NOTE_TYPE, NEEDS_DECISION_KINDS } from '../../shared/passport'
import type { CompanyPassport } from '../../shared/company'
import type { CompanyStore } from '../company'
import { staticPassportRenderer, type CompanyScope } from '../company/scope'
import { openMemoryDb, type MemDB } from './db'
import { MemoryRefusal, MemoryStore, RowMapper, VaultGrantStore, type FactRow, type GrantRow, type VaultGrantRow } from './store'
import type { LearnedFact } from '../../shared/live'
import { buildFingerprints, credentialHit, readFingerprintFile, redactCredentials, writeFingerprintFile, type FingerprintFile } from './screen'
import { buildBrief, fenceSafe } from './search'
import { categoryKind } from '../../shared/vault/grammar'
import { diffLines, splitKeepEol } from '../../shared/vault/diff3'
import * as patch from '../../shared/vault/patch'
import { isoDate, renderNote } from '../../shared/vault/serialize'
import { pathStem } from '../../shared/vault/resolve'
import { openIndexDb, setVaultState, vaultRow, resolveConflict, type IndexDB } from './vault/indexDb'
import { VaultIndexer, type ChangedEvent } from './vault/indexer'
import { VaultWriter, type WriteContext } from './vault/writer'
import { WriterLocks } from './vault/lock'
import { ExpectedWrites, VaultWatcher } from './vault/watcher'
import { indexDbPath, isOnICloud, toVaultAbs } from './vault/paths'
import { readVaultJson, seedDepartmentNote, seedVault, writeVaultJson } from './vault/seed'
import { logEvent } from './vault/log'
import { readFileState, sha1 } from './vault/fsutil'
import { MemRpcBridge } from './vault/rpc'
import { checkOps, planInvalidate, planLinks, planWrite, type PolicyDeps, type WriteSource } from './policy'
import { sinkInvalidate, sinkLinks, sinkWrite, type SinkDeps } from './sink'
import { buildPassportBrief, departmentCardLines, departmentNote, hubNote, renderCompanyCard } from './brief'
import { planTaste, reviewSignal, tasteTitle, type TasteInput } from './taste'
import { alignIncoming, exportOpenPassport, mergeIntoVault, writeNewVault, type ExportDepartment, type ExportResult, type IncomingPassport, type MergeImportResult, type OpenPassportHost } from './openPassportIo'
import { insertProposal } from './vault/indexDb'
import { fingerprintOf } from './vault/suggest/queue'
import { isTasteCategory } from '../../shared/vault/grammar'
import { screenText } from './screen'

export interface MemoryServiceDeps {
  userData: string
  /** Absolute path to out/main/mcp-memory.js (unpacked when packaged). */
  serverScript: string
  /** The Hive binary (process.execPath); run with ELECTRON_RUN_AS_NODE=1. */
  execPath: string
  listRepos(): Repo[]
  /** AUTHORING.md §6.3: maps a cwd inside a Hive worktree to the same path in its source repo (null = unchanged). */
  mapCwd?(cwd: string): string | null
  redact(text: string): string
  /** Vault values for the fingerprint file (main only; never written in plaintext). */
  secretValues(): { name: string; value: string }[]
  emit(e: MemoryChangedEvent & PassportChangedFields): void
  log: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
  /** Vault mode switch; default `settings.experimental.vault` read through the injected CompanyStore. */
  vaultEnabled?: () => boolean
  /** fs.watch + periodic rescans per vault (default true; tests turn it off). */
  watchVaults?: boolean
}

/** What the memory service needs from the company module (COMPANY.md §5); CompanyStore satisfies it. */
export type MemoryCompanies = Pick<
  CompanyStore,
  'listPassports' | 'passport' | 'resolveCompany' | 'companyForRepo' | 'vaultPathFor' | 'setPassportRenderer' | 'setMemoryCounter' | 'update'
> & {
  store: { getSettings(): { experimental?: { vault?: boolean } } }
  /** DEPARTMENTS.md §7: department lookups for the brief's slot and note seeding (absent = no departments). */
  scope?: Pick<CompanyScope, 'passportDepartment' | 'passportDepartments' | 'departmentOf'>
}

export function memoryPaths(userData: string) {
  const dir = path.join(userData, 'memory')
  return { dbPath: path.join(userData, 'memory.db'), dir, spawnDir: path.join(dir, 'spawn'), fpPath: path.join(dir, 'fp.json') }
}

/** Repo whose path is the longest prefix of cwd (PO2: none = read-only global). */
export function repoForCwd(repos: Repo[], cwd: string): Repo | null {
  const norm = (p: string) => p.replace(/\/+$/, '')
  const c = norm(cwd)
  let best: Repo | null = null
  for (const r of repos) {
    const rp = norm(r.path)
    if ((c === rp || c.startsWith(rp + '/')) && (!best || rp.length > norm(best.path).length)) best = r
  }
  return best
}

// ======================================================================================
// Passport vault runtime (PASSPORT.md §2, §6, §7.5, §11)
// ======================================================================================

/** `<userData>/mem-rpc`: per-grant write spools (§7.1). */
export const memRpcRoot = (userData: string) => path.join(userData, 'mem-rpc')
const PAUSED_KEY = 'agent_writes_paused'
const ACTOR_OF_ADAPTER = new Set(['claude', 'codex', 'gemini', 'cursor'])

export interface ProposalQuery {
  status?: ProposalStatus[]
  kinds?: ProposalKind[]
  noteId?: string
  limit?: number
}
interface ProposalRow {
  id: string
  company_id: string
  kind: string
  payload_json: string
  evidence_json: string
  score: number
  source: string
  fingerprint: string
  base_hashes_json: string
  status: ProposalStatus
  created_at: string
  decided_at: string | null
  decided_by: string | null
}
/** P6 plugs its suggestion pipeline in here (stage 0-2 for one company, optionally one note). */
export type Suggester = (companyId: string, noteId?: string) => Promise<{ queued: boolean; created: number }> | { queued: boolean; created: number }
/** P5 plugs the v1 / profile migration in here (§9). */
export type Migrator = (opts: { dryRun: boolean }) => Promise<VaultMigrationReport> | VaultMigrationReport

export interface PassportRuntimeDeps {
  userData: string
  companies: MemoryCompanies
  fingerprints(): FingerprintFile | null
  redact(text: string): string
  emit(e: MemoryChangedEvent & PassportChangedFields): void
  log: MemoryServiceDeps['log']
  now?: () => Date
  watch?: boolean
}

/**
 * Owns passport-index.db and every company vault: seeding, the writer lock, the indexer (rebuild or startup scan), the
 * watcher, the write spool bridge, and the Passport operations the IPC handlers call. One instance per main process.
 */
export class PassportRuntime {
  readonly db: IndexDB
  readonly index: VaultIndexer
  readonly writer: VaultWriter
  readonly locks: WriterLocks
  readonly grants: VaultGrantStore
  readonly bridge: MemRpcBridge
  readonly expected = new ExpectedWrites()
  private watchers = new Map<string, VaultWatcher>()
  private roots = new Map<string, string>()
  private errors = new Map<string, string>()
  private lastSeq = 0
  /** notes each grant's brief showed (brief_hits, §8.3) */
  private briefNotes = new Map<string, Set<string>>()
  private changeListeners: ((e: ChangedEvent) => void)[] = []
  private running = false
  suggester: Suggester | null = null
  migrator: Migrator | null = null

  constructor(private deps: PassportRuntimeDeps) {
    this.db = openIndexDb(indexDbPath(deps.userData))
    this.locks = new WriterLocks({ now: deps.now })
    this.index = new VaultIndexer(this.db, { now: deps.now, onChanged: (e) => this.changed(e), canWrite: (_c, root) => this.locks.isHeld(root) })
    this.writer = new VaultWriter(this.index, { locks: this.locks, expected: this.expected, now: deps.now })
    this.grants = new VaultGrantStore(this.db, deps.now)
    this.lastSeq = this.maxSeq()
    this.bridge = new MemRpcBridge({
      grant: (id) => this.grants.get(id),
      hasVault: (companyId) => {
        try {
          this.ensure(companyId)
          return true
        } catch {
          return false
        }
      },
      handle: (grant, req) => this.handleRpc(grant, req),
      discard: (file) => discardSpoolFile(deps.userData, file),
      log: deps.log
    })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** True once start() ran (the bridge serves spools only after it). */
  isRunning(): boolean {
    return this.running
  }

  /** The vault secret fingerprints (editor saves screen with them too, §7.3). */
  fingerprints(): FingerprintFile | null {
    return this.deps.fingerprints()
  }

  /**
   * Boot: close grants a previous process left open, sweep their spools, start the bridge, open every vault. Runs once
   * per runtime, before its first grant (MemoryService.passport), so it never closes a grant of this runtime.
   */
  start(opts: { bridge?: boolean } = {}): void {
    if (this.running) return
    const closed = this.grants.closeAllOpen()
    for (const g of closed) removeSpoolDir(this.deps.userData, g.spool_dir)
    if (closed.length) this.deps.log.info('passport: closed grants left open by a previous run', { count: closed.length })
    if (opts.bridge !== false) this.bridge.start()
    for (const c of this.deps.companies.listPassports({ includeArchived: true })) {
      try {
        this.ensure(c.id)
      } catch (e) {
        this.deps.log.warn('passport: vault unavailable', { companyId: c.id, e: String(e) })
      }
    }
    this.running = true
  }

  stop(): void {
    this.running = false
    this.bridge.stop()
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
    this.locks.releaseAll()
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  onChanged(fn: (e: ChangedEvent) => void): () => void {
    this.changeListeners.push(fn)
    return () => {
      this.changeListeners = this.changeListeners.filter((f) => f !== fn)
    }
  }

  private maxSeq(): number {
    return (this.db.prepare('SELECT ifnull(max(seq), 0) AS s FROM mem_event').get() as { s: number }).s
  }

  /** indexer -> memory:changed { companyId, paths, noteIds } plus the runs whose writes landed since the last event. */
  private changed(e: ChangedEvent): void {
    const seq = this.maxSeq()
    const runIds = (this.db.prepare('SELECT DISTINCT run_id FROM mem_event WHERE seq > ? AND company_id = ? AND run_id IS NOT NULL').all(this.lastSeq, e.companyId) as { run_id: string }[]).map(
      (r) => r.run_id
    )
    this.lastSeq = seq
    try {
      this.deps.emit({ seq, runIds, entityIds: e.noteIds, pendingDelta: true, companyId: e.companyId, paths: e.paths, noteIds: e.noteIds })
    } catch {
      // listeners never break indexing
    }
    for (const fn of this.changeListeners) {
      try {
        fn(e)
      } catch (err) {
        this.deps.log.warn('passport: change listener failed', { e: String(err) })
      }
    }
  }

  // ---------- vaults ----------

  company(companyId: string): CompanyPassport {
    try {
      return this.deps.companies.passport(companyId)
    } catch {
      throw new MemoryRefusal('Company not found', 'not_found')
    }
  }

  /**
   * The company's vault, ready: seeded (never overwriting), writer lock taken (or read-only), registered and indexed
   * (full rebuild for a new root or parser bump, else the startup (mtime, size) scan), watched. Returns the root.
   */
  ensure(companyId: string, opts: { create?: boolean } = {}): string {
    const company = this.company(companyId)
    const root = this.deps.companies.vaultPathFor(companyId)
    if (this.roots.get(companyId) === root && this.index.hasVault(companyId)) return root
    this.watchers.get(companyId)?.stop()
    this.watchers.delete(companyId)
    // a custom folder that vanished (unmounted drive, moved in Finder) is reported, never re-created empty in its place
    if (company.vaultPath && !opts.create && !fs.existsSync(root)) {
      const msg = `The Passport folder ${root} is missing (unmounted or moved?)`
      this.errors.set(companyId, msg)
      throw new MemoryRefusal(msg, 'not_found')
    }
    try {
      seedVault(root, { companyId, companyName: company.name, summary: company.mission?.trim() || null, now: this.now() })
      const vj = readVaultJson(root)
      if (vj && vj.companyId !== companyId) writeVaultJson(root, companyId, this.now())
      const held = this.locks.acquire(root).held
      if (this.index.registerVault(companyId, root)) this.index.rebuild(companyId)
      else this.index.scan(companyId, { emit: false })
      setVaultState(this.db, companyId, held ? 'ready' : 'readonly')
      this.roots.set(companyId, root)
      this.errors.delete(companyId)
      if (this.deps.watch !== false) {
        const w = new VaultWatcher(this.index, companyId, { expected: this.expected, onError: (e) => this.deps.log.warn('passport: watcher error', { companyId, e: String(e) }) })
        w.start()
        this.watchers.set(companyId, w)
      }
      // departments made before the vault existed (or while it was off) get their notes now
      for (const d of this.deps.companies.scope?.passportDepartments(companyId) ?? []) this.ensureDepartmentNote(companyId, d)
      return root
    } catch (e) {
      this.errors.set(companyId, e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /**
   * DEPARTMENTS.md §7: the department's note, `Departments/<Name>.md` (`type: department`, `part_of [[Company]]`),
   * created once: a note already carrying its `department_id` (or titled like it), archived included, is a no-op. Null
   * when the vault is read-only here or the department is another company's. Never throws for a department reason.
   */
  ensureDepartmentNote(companyId: string, d: PassportDepartment): NotePath | null {
    if (d.companyId !== companyId) return null
    try {
      const root = this.ensure(companyId)
      const found = departmentNote(this.db, companyId, d, { anyStatus: true })
      if (found) return found.path
      // a note the user deleted (kept as a removed row, with its Inbox removal proposal) is never re-seeded behind
      // their back on the next spawn or vault open; the slot falls back to contextFallback
      const removed = this.db
        .prepare(
          `SELECT 1 FROM mem_note WHERE company_id = ? AND type = ? AND removed_at IS NOT NULL
             AND json_valid(frontmatter_json) AND json_extract(frontmatter_json, '$.${DEPARTMENT_ID_KEY}') = ? LIMIT 1`
        )
        .get(companyId, DEPARTMENT_NOTE_TYPE, d.id)
      if (removed) return null
      if (!this.locks.isHeld(root)) return null
      const company = this.company(companyId)
      const hub = hubNote(this.db, companyId, company.name)
      const taken = this.db.prepare('SELECT 1 FROM mem_note WHERE company_id = ? AND basename_norm = ? AND removed_at IS NULL')
      const res = seedDepartmentNote(root, {
        departmentId: d.id,
        name: d.name,
        companyLink: hub ? pathStem(hub.path) : company.name,
        summary: d.charter.does.trim() ? this.deps.redact(d.charter.does) : null,
        context: d.contextFallback.trim() ? this.deps.redact(d.contextFallback) : null,
        isTaken: (key) => !!taken.get(companyId, key),
        now: this.now()
      })
      if (res.created && res.text) this.expected.register(toVaultAbs(root, res.path), sha1(res.text))
      this.index.indexNote(companyId, res.path, { own: res.created })
      return res.path
    } catch (e) {
      this.deps.log.warn('passport: department note could not be created', { companyId, departmentId: d.id, e: String(e) })
      return null
    }
  }

  /** Window focus (§6.3): rescan every watched vault. */
  rescanAll(): void {
    for (const w of this.watchers.values()) w.rescanNow()
  }

  status(companyId: string): VaultStatus {
    const company = this.company(companyId)
    let root = this.deps.companies.vaultPathFor(companyId)
    let error: string | null = null
    try {
      root = this.ensure(companyId)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const row = vaultRow(this.db, companyId)
    const lock = this.locks.state(root)
    const counts = this.counts(companyId)
    return {
      companyId,
      root,
      customPath: !!company.vaultPath,
      exists: fs.existsSync(root),
      state: (error ? 'error' : (row?.state ?? 'missing')) as VaultStatus['state'],
      readOnlyReason: lock.held ? null : lock.reason,
      onICloud: isOnICloud(root),
      noteCount: counts.noteCount,
      ghostCount: counts.ghostCount,
      pendingSuggestions: counts.pendingSuggestions,
      needsDecision: counts.needsDecision,
      lastFullScanAt: row?.last_full_scan_at ?? null,
      formatVersion: readVaultJson(root)?.formatVersion ?? null,
      error: error ?? this.errors.get(companyId) ?? null
    }
  }

  /** Portfolio counts (company:overview) straight from the index. */
  counts(companyId: string): { noteCount: number; ghostCount: number; pendingSuggestions: number; needsDecision: number } {
    const q = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as { n: number }).n
    return {
      noteCount: q(`SELECT count(*) AS n FROM mem_note WHERE company_id = ? AND removed_at IS NULL AND status = 'active'`, companyId),
      ghostCount: q(`SELECT count(DISTINCT to_norm) AS n FROM mem_link WHERE company_id = ? AND to_note IS NULL AND status = 'active' AND to_norm != ''`, companyId),
      pendingSuggestions: q(`SELECT count(*) AS n FROM mem_proposal WHERE company_id = ? AND status = 'pending'`, companyId),
      needsDecision: q(`SELECT count(*) AS n FROM mem_proposal WHERE company_id = ? AND status = 'pending' AND kind IN (${NEEDS_DECISION_KINDS.map(() => '?').join(',')})`, companyId, ...NEEDS_DECISION_KINDS)
    }
  }

  reindex(companyId: string): VaultStatus {
    this.ensure(companyId)
    this.index.rebuild(companyId)
    const held = this.locks.acquire(this.index.root(companyId)).held
    setVaultState(this.db, companyId, held ? 'ready' : 'readonly')
    return this.status(companyId)
  }

  /** "Use existing folder…" / back to the default: the company row changes (with C2's overlap check), then re-register. */
  setPath(companyId: string, vaultPath: string | null): VaultStatus {
    const before = this.roots.get(companyId)
    this.deps.companies.update(companyId, { vaultPath })
    if (before) this.locks.release(before)
    this.roots.delete(companyId)
    this.ensure(companyId, { create: true })
    return this.status(companyId)
  }

  // ---------- pause ----------

  isPaused(): boolean {
    const r = this.db.prepare('SELECT value FROM mem_meta WHERE key = ?').get(PAUSED_KEY) as { value: string } | undefined
    return r?.value === '1'
  }
  setPaused(paused: boolean): void {
    this.db.prepare('INSERT INTO mem_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(PAUSED_KEY, paused ? '1' : '0')
  }

  // ---------- policy + writer ----------

  policyDeps(): PolicyDeps {
    return { index: this.index, grants: this.grants, fingerprints: () => this.deps.fingerprints(), paused: () => this.isPaused() }
  }
  sinkDeps(): SinkDeps {
    return { index: this.index, writer: this.writer, now: this.deps.now }
  }

  /** The spool bridge's handler: the grant's company (never the arguments) picks the vault (§7.1). */
  async handleRpc(grant: VaultGrantRow, req: MemRpcRequest): Promise<unknown> {
    const companyId = grant.company_id
    this.ensure(companyId)
    const source: WriteSource = { kind: 'agent', grant, callId: req.callId ?? null }
    switch (req.method) {
      case 'write':
        return sinkWrite(this.sinkDeps(), planWrite(this.policyDeps(), companyId, source, req.args as VaultWriteArgs))
      case 'link':
        return sinkLinks(this.sinkDeps(), planLinks(this.policyDeps(), companyId, source, req.args as VaultLinkArgs))
      case 'invalidate':
        return sinkInvalidate(this.sinkDeps(), planInvalidate(this.policyDeps(), companyId, source, req.args as VaultInvalidateArgs))
      case 'hit':
        return { counted: this.countBriefHits(grant, (req.args as { notes?: unknown }).notes) }
      case 'taste':
        return this.agentTaste(grant, req.args as VaultTasteArgs, source)
    }
  }

  /** Ops from the UI or an accepted suggestion: policy, then the writer. */
  async applyOps(companyId: string, ops: VaultOp[], source: WriteSource = { kind: 'user' }): Promise<VaultApplyResult> {
    this.ensure(companyId)
    const checked = checkOps(this.policyDeps(), companyId, source, ops)
    return this.writer.apply(companyId, checked, this.contextOf(source))
  }

  contextOf(source: WriteSource): WriteContext {
    if (source.kind === 'agent') return { actor: ACTOR_OF_ADAPTER.has(source.grant.adapter) ? (source.grant.adapter as WriteContext['actor']) : 'claude', grantId: source.grant.id, runId: source.grant.run_id, sessionId: source.grant.session_id }
    if (source.kind === 'migration') return { actor: 'migration' }
    return { actor: 'user', via: source.via ?? null }
  }

  // ---------- brief_hits (§8.3) ----------

  rememberBrief(grantId: string, noteIds: string[]): void {
    if (noteIds.length) this.briefNotes.set(grantId, new Set(noteIds))
  }
  forgetBrief(grantId: string): void {
    this.briefNotes.delete(grantId)
  }
  private countBriefHits(grant: VaultGrantRow, notes: unknown): number {
    const shown = this.briefNotes.get(grant.id)
    if (!shown || !Array.isArray(notes)) return 0
    let n = 0
    const st = this.db.prepare(
      `INSERT INTO mem_settings (company_id, key, value_json, updated_at) VALUES (?, ?, '1', ?)
       ON CONFLICT(company_id, key) DO UPDATE SET value_json = CAST(value_json AS INTEGER) + 1, updated_at = excluded.updated_at`
    )
    for (const id of new Set(notes.filter((x): x is string => typeof x === 'string').slice(0, 10))) {
      if (!shown.has(id)) continue
      st.run(grant.company_id, `brief_hits:${id}`, this.now().toISOString())
      shown.delete(id)
      n++
    }
    return n
  }

  // ---------- proposals (§12, Inbox) ----------

  private proposalRow(companyId: string, id: string): ProposalRow | null {
    return (this.db.prepare('SELECT * FROM mem_proposal WHERE company_id = ? AND id = ?').get(companyId, id) as ProposalRow | undefined) ?? null
  }

  listProposals(companyId: string, q: ProposalQuery = {}): { items: VaultProposal[]; total: number; needsDecision: number } {
    const status = q.status?.length ? q.status : (['pending'] as ProposalStatus[])
    const where = [`company_id = ?`, `status IN (${status.map(() => '?').join(',')})`]
    const args: unknown[] = [companyId, ...status]
    if (q.kinds?.length) {
      where.push(`kind IN (${q.kinds.map(() => '?').join(',')})`)
      args.push(...q.kinds)
    }
    let rows = this.db.prepare(`SELECT * FROM mem_proposal WHERE ${where.join(' AND ')} ORDER BY score DESC, created_at DESC`).all(...args) as ProposalRow[]
    if (q.noteId) {
      const note = this.index.noteById(companyId, q.noteId)
      const keys = [q.noteId, note?.path].filter((x): x is string => !!x)
      rows = rows.filter((r) => keys.some((k) => r.payload_json.includes(JSON.stringify(k).slice(1, -1)) || r.evidence_json.includes(JSON.stringify(k).slice(1, -1))))
    }
    const total = rows.length
    const items = rows.slice(0, q.limit ?? 200).map((r) => this.toProposal(r))
    return { items, total, needsDecision: this.counts(companyId).needsDecision }
  }

  private toProposal(r: ProposalRow): VaultProposal {
    const payload = parseJsonSafe<unknown>(r.payload_json, [])
    const ops = Array.isArray(payload) ? (payload as VaultOp[]) : []
    const evidence = parseJsonSafe<VaultProposal['evidence']>(r.evidence_json, []).map((e) => ({ ...e, quote: this.deps.redact(e.quote ?? '') }))
    return {
      id: r.id,
      companyId: r.company_id,
      kind: r.kind as ProposalKind,
      title: proposalTitle(r.kind, ops, evidence),
      ops,
      evidence,
      preview: r.status === 'pending' ? this.previewOps(r.company_id, ops) : [],
      score: r.score,
      source: r.source as ProposalSource,
      status: r.status,
      needsDecision: (NEEDS_DECISION_KINDS as readonly string[]).includes(r.kind),
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by
    }
  }

  /** The exact markdown change of an op list, computed with the shared patch functions on the current bytes (no write). */
  previewOps(companyId: string, ops: VaultOp[]): VaultProposal['preview'] {
    const out: VaultProposal['preview'] = []
    const texts = new Map<string, { before: string; after: string }>()
    const date = isoDate(this.now())
    const prov = { actor: 'user' as const, date }
    const noteOf = (name: string) => {
      const id = /^n-[0-9a-z]{10}$/.test(name) || name.startsWith('h:') ? name : this.index.resolve(companyId, name).toNote
      return id ? this.index.noteById(companyId, id) : null
    }
    const blockNote = (ref: string) => {
      const hit = this.index.findBlock(companyId, ref.replace(/^.*#\^/, '').replace(/\]\]$/, '').replace(/^\^/, ''))
      return hit ? { note: this.index.noteById(companyId, hit.noteId), blockId: ref.replace(/^.*#\^/, '').replace(/\]\]$/, '').replace(/^\^/, '') } : null
    }
    const textOf = (rel: string): string | null => {
      const hit = texts.get(rel)
      if (hit) return hit.after
      try {
        const t = readFileState(toVaultAbs(this.index.root(companyId), rel))?.text ?? null
        if (t !== null) texts.set(rel, { before: t, after: t })
        return t
      } catch {
        return null
      }
    }
    const put = (rel: string, fn: (t: string) => string) => {
      const t = textOf(rel)
      if (t === null) return
      try {
        texts.get(rel)!.after = fn(t)
      } catch {
        // the op would conflict; no preview
      }
    }
    for (const op of ops) {
      try {
        switch (op.op) {
          case 'createNote':
            out.push({ path: `${op.folder ?? ''}${op.folder ? '/' : ''}${op.title}.md`, before: '', after: renderNote({ id: 'n-xxxxxxxxxx', title: op.title, type: op.type as never, created: date, source: 'suggestion', summary: op.summary ?? null }) })
            break
          case 'observe': {
            const n = noteOf(op.note)
            if (n) put(n.path, (t) => patch.appendObservation(t, { category: op.category, text: op.text, tags: op.tags, prov }).text)
            break
          }
          case 'relate': {
            const n = noteOf(op.from)
            const target = noteOf(op.to)
            if (n) put(n.path, (t) => patch.appendRelation(t, { rel: op.rel, target: target ? pathStem(target.path) : op.to, context: op.context ?? null, prov }).text)
            break
          }
          case 'supersede':
          case 'invalidate':
          case 'reinforce':
          case 'restoreLine': {
            const b = blockNote(op.blockId)
            if (!b?.note) break
            if (op.op === 'supersede') put(b.note.path, (t) => patch.supersede(t, b.blockId, { text: op.text }, prov).text)
            else if (op.op === 'reinforce') put(b.note.path, (t) => patch.reinforceTaste(t, b.blockId, op.example ?? null).text)
            else if (op.op === 'invalidate') put(b.note.path, (t) => patch.invalidate(t, b.blockId, op.reason, prov).text)
            else put(b.note.path, (t) => patch.restoreLine(t, b.blockId, { prov }).text)
            break
          }
          case 'setProperty': {
            const n = noteOf(op.note)
            if (n) put(n.path, (t) => patch.setProperty(t, op.key, Array.isArray(op.value) ? op.value.map(String) : (op.value ?? undefined)).text)
            break
          }
          case 'addAlias': {
            const n = noteOf(op.note)
            if (n) put(n.path, (t) => patch.addAlias(t, op.alias).text)
            break
          }
          case 'archive': {
            const n = noteOf(op.note)
            if (n) put(n.path, (t) => patch.archive(t).text)
            break
          }
          case 'linkMention': {
            const n = noteOf(op.note)
            const target = noteOf(op.target)
            if (n) put(n.path, (t) => patch.linkMention(t, op.line, op.span, target ? pathStem(target.path) : op.target).text)
            break
          }
          default:
            break
        }
      } catch {
        // no preview for this op
      }
    }
    for (const [rel, t] of texts) {
      if (t.before === t.after) continue
      const d = diffLines(splitKeepEol(t.before), splitKeepEol(t.after))
      const before = d.filter((x) => x.op === 'delete').flatMap((x) => x.lines).join('')
      const after = d.filter((x) => x.op === 'insert').flatMap((x) => x.lines).join('')
      out.push({ path: rel, before: this.deps.redact(before), after: this.deps.redact(after) })
    }
    return out
  }

  private decide(companyId: string, id: string, status: ProposalStatus): void {
    this.db.prepare(`UPDATE mem_proposal SET status = ?, decided_at = ?, decided_by = 'user' WHERE company_id = ? AND id = ?`).run(status, this.now().toISOString(), companyId, id)
    if (status === 'accepted' || status === 'rejected') {
      const r = this.proposalRow(companyId, id)
      if (r) this.bumpRate(companyId, r.kind, r.source, status)
    }
  }

  /** Acceptance rate per (company, kind, source) in mem_settings: P6 throttles sources below 20% (§12). */
  private bumpRate(companyId: string, kind: string, source: string, status: 'accepted' | 'rejected'): void {
    const key = `rate:${kind}:${source}`
    const cur = this.db.prepare('SELECT value_json FROM mem_settings WHERE company_id = ? AND key = ?').get(companyId, key) as { value_json: string } | undefined
    const v = parseJsonSafe<{ accepted: number; rejected: number }>(cur?.value_json ?? '', { accepted: 0, rejected: 0 })
    v[status]++
    this.db
      .prepare('INSERT INTO mem_settings (company_id, key, value_json, updated_at) VALUES (?,?,?,?) ON CONFLICT(company_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(companyId, key, JSON.stringify(v), this.now().toISOString())
  }

  /**
   * Accept replays the proposal's ops through policy and the writer as `user via suggestion sg-…`. An op that no longer
   * applies (its line or note changed) marks the proposal stale. `external_removal`: accept = accept the removal.
   * `conflict`: accept = retry the op. `addAlias = false` drops the optional alias op of a retarget.
   */
  async acceptProposals(companyId: string, ids: string[], opts: { addAlias?: boolean } = {}): Promise<{ accepted: number; stale: number; results: VaultApplyResult }> {
    this.ensure(companyId)
    const all: VaultApplyResult = { results: [], conflicts: [] }
    let accepted = 0
    let stale = 0
    for (const id of ids) {
      const r = this.proposalRow(companyId, id)
      if (!r || r.status !== 'pending') continue
      if (r.kind === 'external_removal') {
        this.acceptRemoval(companyId, r)
        this.decide(companyId, id, 'accepted')
        accepted++
        continue
      }
      let ops = parseJsonSafe<VaultOp[]>(r.payload_json, [])
      // §9 migration: "assign this global v1 fact to its company" carries no ops; accepting keeps the line where it is
      // (moving it is a manual cut and paste into the other company's vault)
      // an import conflict with nothing to apply (prose, a relation): accepting acknowledges that ours stays
      if ((r.kind === 'assign_company' || r.kind === 'import_conflict') && (!Array.isArray(ops) || !ops.length)) {
        this.decide(companyId, id, 'accepted')
        accepted++
        continue
      }
      if (!Array.isArray(ops) || !ops.length) {
        this.decide(companyId, id, 'stale')
        stale++
        continue
      }
      if (r.kind === 'retarget' && opts.addAlias === false) ops = ops.filter((o) => o.op !== 'addAlias')
      let res: VaultApplyResult
      try {
        res = await this.applyOps(companyId, ops, { kind: 'user', via: id })
      } catch (e) {
        res = { results: [{ index: 0, status: 'error', path: null, noteId: null, blockId: null, hash: null, reason: e instanceof Error ? e.message : String(e) }], conflicts: [] }
      }
      all.results.push(...res.results.map((x) => ({ ...x, index: all.results.length + x.index })))
      all.conflicts.push(...res.conflicts)
      const ok = res.results.every((x) => x.status === 'ok' || x.status === 'noop')
      this.decide(companyId, id, ok ? 'accepted' : 'stale')
      if (ok && r.kind === 'conflict') {
        const cf = /^conflict:(.+)$/.exec(r.fingerprint)?.[1]
        if (cf) resolveConflict(this.db, companyId, cf, this.now().toISOString())
      }
      if (ok) accepted++
      else stale++
    }
    return { accepted, stale, results: all }
  }

  /** Reject stores the fingerprint for good. `external_removal`: reject = restore the content; `conflict`: dismiss. */
  async rejectProposals(companyId: string, ids: string[]): Promise<{ rejected: number }> {
    let rejected = 0
    for (const id of ids) {
      const r = this.proposalRow(companyId, id)
      if (!r || r.status !== 'pending') continue
      if (r.kind === 'external_removal') {
        this.ensure(companyId)
        const p = parseJsonSafe<{ noteId?: string; wholeNote?: boolean; blockIds?: string[] }>(r.payload_json, {})
        if (p.noteId) {
          if (p.wholeNote) await this.writer.restoreRemoved(companyId, p.noteId, { actor: 'user' })
          else await this.writer.restoreRemovedLines(companyId, p.noteId, this.tombstones(companyId, p.noteId, p.blockIds ?? []), { actor: 'user' })
        }
      }
      if (r.kind === 'conflict') {
        const cf = /^conflict:(.+)$/.exec(r.fingerprint)?.[1]
        if (cf) resolveConflict(this.db, companyId, cf, this.now().toISOString())
      }
      this.decide(companyId, id, 'rejected')
      rejected++
    }
    return { rejected }
  }

  async editProposal(companyId: string, id: string, ops: VaultOp[], accept = false): Promise<VaultProposal> {
    const r = this.proposalRow(companyId, id)
    if (!r) throw new MemoryRefusal('Suggestion not found', 'not_found')
    if (r.status !== 'pending') throw new MemoryRefusal('This suggestion was already decided', 'conflict')
    checkOps(this.policyDeps(), companyId, { kind: 'user', via: id }, ops)
    this.db.prepare('UPDATE mem_proposal SET payload_json = ? WHERE company_id = ? AND id = ?').run(JSON.stringify(ops), companyId, id)
    if (accept) await this.acceptProposals(companyId, [id])
    return this.toProposal(this.proposalRow(companyId, id)!)
  }

  async suggestNow(companyId: string, noteId?: string): Promise<{ queued: boolean; created: number }> {
    this.ensure(companyId)
    if (!this.suggester) return { queued: false, created: 0 }
    return this.suggester(companyId, noteId)
  }

  private tombstones(companyId: string, noteId: string, blockIds: string[]): string[] {
    const rows = this.db.prepare(`SELECT id, block_id FROM mem_fact WHERE company_id = ? AND note_id = ? AND status = 'removed_external'`).all(companyId, noteId) as { id: string; block_id: string | null }[]
    return rows.filter((r) => !blockIds.length || (r.block_id && blockIds.includes(r.block_id))).map((r) => r.id)
  }

  private acceptRemoval(companyId: string, r: ProposalRow): void {
    const p = parseJsonSafe<{ noteId?: string; wholeNote?: boolean; blockIds?: string[]; path?: string }>(r.payload_json, {})
    if (!p.noteId) return
    if (p.wholeNote) {
      this.index.acceptRemoval(companyId, p.noteId)
      return
    }
    const n = this.index.acceptRemovedFacts(companyId, this.tombstones(companyId, p.noteId, p.blockIds ?? []))
    logEvent(this.db, this.index.root(companyId), {
      ts: this.now().toISOString(),
      companyId,
      op: 'accept_removal',
      targetKind: 'fact',
      targetId: p.noteId,
      entityId: p.noteId,
      path: p.path ?? null,
      actor: 'user',
      after: { lines: n, blockIds: p.blockIds ?? [] }
    })
  }

  // ---------- Open Passport export / import (openPassportIo.ts) ----------

  openPassportHost(): OpenPassportHost {
    return {
      db: this.db,
      ensure: (c) => this.ensure(c),
      reindex: (c) => this.reindex(c),
      expected: this.expected,
      writer: this.writer,
      redact: (t) => this.deps.redact(t),
      now: () => this.now()
    }
  }

  exportOpenPassport(companyId: string, departments: ExportDepartment[]): ExportResult {
    return exportOpenPassport(this.openPassportHost(), companyId, this.company(companyId), departments)
  }

  /** A new company's vault from a passport; `departmentIds` maps passport slugs to the departments just created. */
  importOpenPassport(companyId: string, inc: IncomingPassport, departmentIds: Map<string, string>): number {
    const host = this.openPassportHost()
    host.ensure(companyId)
    return writeNewVault(host, companyId, alignIncoming(this.db, companyId, this.company(companyId).name, inc, departmentIds), inc)
  }

  mergeOpenPassport(companyId: string, inc: IncomingPassport, departmentIds: Map<string, string>, opts: { baseDigest?: string | null } = {}): Promise<MergeImportResult> {
    return mergeIntoVault(this.openPassportHost(), companyId, this.company(companyId).name, inc, departmentIds, opts)
  }

  // ---------- taste (Open Passport SPEC.md §4.6, §8.3) ----------

  /**
   * One taste signal. `stated` (the person said it) writes it now, through policy and the writer; anything inferred is
   * filed as a `taste` proposal (its fingerprint keeps a rejected or repeated signal from coming back). A statement the
   * note already holds is reinforced (`x<count>` + 1) instead of duplicated.
   */
  async taste(companyId: string, input: TasteInput, opts: { stated: boolean; source: WriteSource; proposalSource: ProposalSource }): Promise<VaultTasteResult> {
    this.ensure(companyId)
    if (input.scope !== 'company') this.ensureDepartmentNote(companyId, input.scope.department)
    const hit = screenText(this.deps.fingerprints(), `${input.text}\n${input.example}`, { agent: opts.source.kind === 'agent' })
    if (hit) throw new MemoryRefusal(`Refused: the taste looks like ${hit.kind === 'imperative' ? 'an instruction' : 'a secret'} (${hit.label})`, 'refused')
    const plan = planTaste(this.db, companyId, input)
    if (!plan) throw new MemoryRefusal(input.scope === 'company' ? 'Say the taste in a few words' : 'That department has no Passport note yet', 'validation')
    if (opts.stated) {
      const res = await this.applyOps(companyId, plan.ops, opts.source)
      const failed = res.results.find((r) => r.status === 'error' || r.status === 'conflict')
      if (failed) throw new MemoryRefusal(failed.reason ?? 'The taste could not be written', 'conflict')
      return { status: 'written', note: `[[${plan.note}]]`, reinforced: !!plan.reinforces }
    }
    const id = insertProposal(this.db, {
      companyId,
      kind: 'taste',
      payload: plan.ops,
      evidence: plan.evidence,
      score: plan.reinforces ? 0.7 : 0.6,
      source: opts.proposalSource,
      fingerprint: fingerprintOf(plan.key),
      baseHashes: {},
      createdAt: this.now().toISOString()
    })
    // the Inbox badge reads the pending count on memory:changed
    if (id) this.deps.emit({ seq: this.maxSeq(), runIds: [], entityIds: [], pendingDelta: true, companyId })
    return id ? { status: 'proposed', note: `[[${plan.note}]]`, reinforced: !!plan.reinforces, proposal: id } : { status: 'known', note: `[[${plan.note}]]`, reinforced: !!plan.reinforces }
  }

  /** memory_taste from an agent: `department` means the run's own department (its task or session). */
  private async agentTaste(grant: VaultGrantRow, a: VaultTasteArgs, source: WriteSource): Promise<VaultTasteResult> {
    if (!isTasteCategory(a.polarity)) throw new MemoryRefusal('polarity must be likes, dislikes, prefers or avoid', 'validation')
    const companyId = grant.company_id
    let scope: TasteInput['scope'] = 'company'
    if (a.scope !== 'company') {
      const sc = this.deps.companies.scope
      const name = a.scope.startsWith('department:') ? a.scope.slice('department:'.length).trim().toLowerCase() : null
      const dep = name
        ? (sc?.passportDepartments(companyId) ?? []).find((d) => d.name.toLowerCase() === name || d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === name)
        : sc?.departmentOf({ runId: grant.run_id, sessionId: grant.session_id })
      if (!dep || dep.companyId !== companyId) throw new MemoryRefusal(name ? `Unknown department "${name}"` : 'This run has no department; use scope "company" or "department:<name>"', 'not_found')
      scope = { department: dep }
    }
    return this.taste(companyId, { scope, polarity: a.polarity, text: a.text, example: a.example }, { stated: a.stated_by_user === true, source, proposalSource: 'agent' })
  }

  // ---------- revertRun (§6.5): invalidate / restore, never removals ----------

  async revertRun(runId: string): Promise<{ invalidated: number; restored: number }> {
    const events = this.db
      .prepare(
        `SELECT e.company_id, e.op, e.target_kind, e.block_id, e.after_json FROM mem_event e
         WHERE e.run_id = ? AND e.block_id IS NOT NULL AND e.target_kind IN ('fact','relation') AND e.op IN ('create','supersede','invalidate')
         ORDER BY e.seq DESC`
      )
      .all(runId) as { company_id: string; op: string; target_kind: string; block_id: string; after_json: string | null }[]
    let invalidated = 0
    let restored = 0
    const reason = `reverted run ${runId}`
    for (const e of events) {
      const companyId = e.company_id
      try {
        this.ensure(companyId)
      } catch {
        continue
      }
      const live = (b: string) => this.index.findBlock(companyId, b)
      const ops: VaultOp[] = []
      if (e.op === 'create' || e.op === 'supersede') {
        const hit = live(e.block_id)
        if (hit?.status === 'active') ops.push({ op: 'invalidate', blockId: e.block_id, reason })
        const old = e.op === 'supersede' ? parseJsonSafe<{ blockId?: string }>(e.after_json ?? '', {}).blockId?.replace(/^\^/, '') : undefined
        if (old && live(old)?.status === 'superseded') ops.push({ op: 'restoreLine', blockId: old })
      } else if (e.op === 'invalidate' && live(e.block_id)?.status === 'invalid') ops.push({ op: 'restoreLine', blockId: e.block_id })
      if (!ops.length) continue
      const res = await this.writer.apply(companyId, ops, { actor: 'user' })
      res.results.forEach((r, i) => {
        if (r.status !== 'ok') return
        if (ops[i].op === 'invalidate') invalidated++
        else restored++
      })
    }
    return { invalidated, restored }
  }
}

function parseJsonSafe<T>(s: string, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}

function proposalTitle(kind: string, ops: VaultOp[], evidence: VaultProposal['evidence']): string {
  const first = ops[0]
  switch (kind) {
    case 'external_removal':
      return evidence[0]?.quote ? `Removed outside Principia: ${evidence[0].quote.slice(0, 80)}` : 'Removed outside Principia'
    case 'conflict':
      return `A change could not be applied${evidence[0]?.path ? ` to ${evidence[0].path}` : ''}`
    case 'fact_supersede':
      return first?.op === 'invalidate' ? 'An agent wants to invalidate a line' : 'An agent wants to replace a line'
    case 'harvest':
      return 'Agent note awaiting review'
    case 'taste':
      return tasteTitle(ops)
    case 'import_conflict':
      return `Imported Passport differs${evidence[0]?.path ? ` in ${evidence[0].path}` : ''}: keep ours or take theirs`
    case 'link':
      return first?.op === 'linkMention' ? `Link [[${first.target}]]` : 'Add a link'
    case 'entity':
      return first?.op === 'createNote' ? `New note [[${first.title}]]` : 'New note'
    case 'merge':
      return first?.op === 'merge' ? `Merge [[${first.from}]] into [[${first.into}]]` : 'Merge notes'
    case 'relation':
      return first?.op === 'relate' ? `${first.rel} [[${first.to}]]` : 'Add a relation'
    default:
      return kind.replace(/_/g, ' ')
  }
}

/** Drops a consumed spool request (only inside `<userData>/mem-rpc/`). */
function discardSpoolFile(userData: string, file: string): void {
  const base = memRpcRoot(userData) + path.sep
  if (!path.resolve(file).startsWith(base)) return
  fs.rmSync(file, { force: true })
}

/** Removes a grant's spool folder when the grant ends (§7.5), only inside `<userData>/mem-rpc/`. */
function removeSpoolDir(userData: string, spoolDir: string | null): void {
  if (!spoolDir) return
  const base = memRpcRoot(userData) + path.sep
  if (!path.resolve(spoolDir).startsWith(base)) return
  try {
    fs.rmSync(spoolDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

export class MemoryService implements MemoryBridge {
  readonly db: MemDB
  readonly store: MemoryStore
  readonly paths: ReturnType<typeof memoryPaths>
  private fpCache: FingerprintFile | null = null
  private timer: NodeJS.Timeout | null = null
  private dataVersion = -1
  private lastSeq = 0
  private lastPending = -1
  private lastChangeAt = Date.now()
  private checkpointed = true
  private pollTicks = 0
  private companies: MemoryCompanies | null = null
  private passportRt: PassportRuntime | null = null
  private vaultGrants = new Set<string>()
  private started = false
  private suggester: Suggester | null = null
  private migrator: Migrator | null = null
  /** migrations in flight: the runtime is never stopped under them (the flag may still be off while they run) */
  private migrating = 0
  /** the runtime whose company card renderer is registered */
  private cardFor: PassportRuntime | null = null

  constructor(private deps: MemoryServiceDeps) {
    this.paths = memoryPaths(deps.userData)
    fs.mkdirSync(this.paths.spawnDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(this.paths.dir, 0o700)
      fs.chmodSync(this.paths.spawnDir, 0o700)
    } catch {
      /* best effort */
    }
    this.db = openMemoryDb(this.paths.dbPath, { migrate: true })
    this.store = new MemoryStore(this.db, { now: deps.now, fingerprints: () => this.fpCache })
  }

  /** Boot: close stale grants, sweep spawn files, write fingerprints, start the change poller. */
  start(opts: { poll?: boolean } = {}): void {
    const closed = this.store.closeAllOpenGrants()
    if (closed) this.deps.log.info('memory: closed grants left open by a previous run', { count: closed })
    this.sweepSpawnDir()
    this.refreshFingerprints()
    this.lastSeq = this.store.lastSeq()
    this.lastPending = this.pendingCount()
    if (opts.poll !== false) {
      this.timer = setInterval(() => this.poll(), 1000)
      this.timer.unref?.()
    }
    this.started = true
    this.syncVaultMode()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.passportRt?.stop()
    this.passportRt = null
    this.store.checkpoint()
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }

  // ---------- fingerprints (§9.1) ----------
  refreshFingerprints(): void {
    try {
      const prev = readFingerprintFile(this.paths.fpPath)
      const fp = buildFingerprints(this.deps.secretValues(), prev?.salt)
      writeFingerprintFile(this.paths.fpPath, fp)
      this.fpCache = fp
    } catch (e) {
      this.deps.log.warn('memory: could not write fingerprints', { e: String(e) })
    }
  }

  private sweepSpawnDir(): void {
    try {
      for (const f of fs.readdirSync(this.paths.spawnDir)) fs.rmSync(path.join(this.paths.spawnDir, f), { force: true })
    } catch {
      /* ignore */
    }
  }

  // ---------- MemoryBridge ----------
  grant(req: MemoryGrantRequest): MemoryGrant | null {
    if (this.vaultMode()) return this.vaultGrant(req)
    try {
      const repo = repoForCwd(this.deps.listRepos(), this.deps.mapCwd?.(req.cwd) ?? req.cwd)
      const row = this.store.createGrant({
        // v1: inject is brief-only (read); the harvest path is vault-only
        mode: req.transport === 'inject' ? 'read' : req.mode,
        adapter: req.adapter,
        transport: req.transport,
        profileId: req.profile?.id ?? null,
        profileName: req.profile?.name ?? null,
        model: req.profile?.model ?? null,
        repoId: repo?.id ?? null,
        repoName: repo?.name ?? null,
        runId: req.runId ?? null,
        runTitle: req.runTitle ?? null,
        workflowId: req.workflowId ?? null,
        stepId: req.stepId ?? null,
        nodeId: req.nodeId ?? null,
        nodeLabel: req.nodeLabel ?? null,
        sessionId: req.sessionId ?? null
      })
      const canWrite = req.mode === 'read-write' && req.transport === 'mcp' && !!repo
      const vis = repo ? ({ kind: 'repo', repoId: repo.id } as const) : ({ kind: 'global' } as const)
      const brief = buildBrief(
        this.store,
        { vis, scopeLabel: repo ? `${repo.name} project + global` : 'global', query: req.briefQuery, transport: req.transport },
        (s) => this.deps.redact(s)
      )
      return {
        grantId: row.id,
        server: this.serverSpec(row),
        toolNames: [...MEMORY_READ_TOOLS, ...(canWrite ? MEMORY_WRITE_TOOLS : [])],
        spawnDir: this.paths.spawnDir,
        brief
      }
    } catch (e) {
      this.deps.log.warn('memory: grant failed; spawning without memory', { e: String(e) })
      return null
    }
  }

  serverSpec(g: Pick<GrantRow, 'id'>): MemoryGrant['server'] {
    return {
      name: MEMORY_SERVER_NAME,
      command: this.deps.execPath,
      args: [this.deps.serverScript],
      env: { ELECTRON_RUN_AS_NODE: '1', HIVE_MEM_DB: this.paths.dbPath, HIVE_MEM_GRANT: g.id, HIVE_MEM_FP: this.paths.fpPath }
    }
  }

  /** hivemem with an empty grant (LIVE.md §4.2): only ask_user is listed and memory.db is never opened. */
  askOnlyServer(): MemoryGrant['server'] {
    return this.serverSpec({ id: '' })
  }

  /** "What agents learned" (LIVE.md §8): agent facts created since, active|pending, newest first. */
  factsSince(since: string, limit = 10, companyId?: string | null): LearnedFact[] {
    if (this.vaultMode()) return this.vaultFactsSince(since, limit, companyId ?? null)
    const rows = this.db
      .prepare(
        `SELECT f.*, e.name AS entity_name, g.repo_name AS g_repo_name, g.run_id AS g_run_id, g.run_title AS g_run_title
         FROM mem_fact f JOIN mem_entity e ON e.id = f.entity_id LEFT JOIN mem_grant g ON g.id = f.grant_id
         WHERE f.actor = 'agent' AND f.status IN ('active','pending') AND f.created_at >= ?
         ORDER BY f.created_at DESC LIMIT ?`
      )
      .all(since, Math.min(Math.max(limit, 1), 100)) as (FactRow & {
      entity_name: string
      g_repo_name: string | null
      g_run_id: string | null
      g_run_title: string | null
    })[]
    const map = new RowMapper(this.store, (t) => this.deps.redact(t))
    const facts = map.facts(rows)
    const repos = this.deps.listRepos()
    return rows.map((r, i) => ({
      fact: facts[i],
      entityName: this.deps.redact(r.entity_name),
      repoName: (r.repo_id ? repos.find((x) => x.id === r.repo_id)?.name : null) ?? r.g_repo_name ?? null,
      runId: r.g_run_id,
      runTitle: r.g_run_title ? this.deps.redact(r.g_run_title) : null
    }))
  }

  release(grantId: Id): void {
    if (this.vaultGrants.has(grantId) || (this.passportRt && this.passportRt.grants.get(grantId))) {
      this.releaseVaultGrant(grantId)
      return
    }
    try {
      this.store.closeGrant(grantId)
    } catch (e) {
      this.deps.log.warn('memory: release failed', { e: String(e) })
    }
    try {
      for (const f of fs.readdirSync(this.paths.spawnDir)) {
        if (f.startsWith(`${grantId}.`)) fs.rmSync(path.join(this.paths.spawnDir, f), { force: true })
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- change feed (§10.7) ----------
  private pendingCount(): number {
    return (
      this.db.prepare(
        "SELECT (SELECT count(*) FROM mem_fact WHERE status = 'pending') + (SELECT count(*) FROM mem_relation WHERE status = 'pending') AS n"
      ).get() as { n: number }
    ).n
  }

  /** 1 s tick: PRAGMA data_version sees commits from the server processes; main's own writes call flush(). */
  poll(): void {
    if (++this.pollTicks % 5 === 0) this.syncVaultMode()
    try {
      const v = Number(this.db.pragma('data_version', { simple: true }))
      if (v !== this.dataVersion) {
        this.dataVersion = v
        this.flush()
      } else if (!this.checkpointed && Date.now() - this.lastChangeAt > 60_000) {
        this.store.checkpoint()
        this.checkpointed = true
      }
    } catch (e) {
      this.deps.log.warn('memory: poll failed', { e: String(e) })
    }
  }

  /** Reads mem_event rows after lastSeq, re-screens new agent text (§9), emits memory:changed. */
  flush(): MemoryChangedEvent | null {
    const rows = this.db
      .prepare('SELECT seq, op, target_kind, target_id, entity_id, actor, run_id FROM mem_event WHERE seq > ? ORDER BY seq')
      .all(this.lastSeq) as { seq: number; op: string; target_kind: string; target_id: string; entity_id: string | null; actor: string; run_id: string | null }[]
    if (!rows.length) return null
    this.lastSeq = rows[rows.length - 1].seq
    this.lastChangeAt = Date.now()
    this.checkpointed = false
    for (const r of rows) {
      if (r.actor !== 'agent' || r.op !== 'create' || r.target_kind !== 'fact') continue
      const f = this.store.factRow(r.target_id)
      if (!f || f.status === 'invalid') continue
      const vaultRed = this.deps.redact(f.text)
      const cred = credentialHit(vaultRed)
      const red = cred ? redactCredentials(vaultRed) : vaultRed
      if (red !== f.text) {
        const name = /••••([A-Z_][A-Z0-9_]*)/.exec(vaultRed)?.[1] ?? cred ?? 'secret'
        this.store.quarantineSecretFact(f.id, red, name)
        this.deps.log.warn('memory: quarantined an agent fact containing a secret', { factId: f.id, secret: name })
      }
    }
    const pending = this.pendingCount()
    const ev: MemoryChangedEvent = {
      seq: this.store.lastSeq(),
      runIds: [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))],
      entityIds: [...new Set(rows.map((r) => r.entity_id).filter((x): x is string => !!x))],
      pendingDelta: pending !== this.lastPending
    }
    this.lastPending = pending
    this.lastSeq = Math.max(this.lastSeq, ev.seq)
    this.deps.emit(ev)
    return ev
  }
  // ======================================================================================
  // Passport vault mode (PASSPORT.md §7.5, §8, §11)
  // ======================================================================================

  /** hive.ts injects the CompanyStore (COMPANY.md C4): grants resolve their company through scope.ts. */
  setCompanies(companies: MemoryCompanies): void {
    this.companies = companies
    companies.setMemoryCounter((companyId) => {
      const rt = this.vaultMode() ? this.passportRt : null
      if (!rt) return null
      const c = rt.counts(companyId)
      return { noteCount: c.noteCount, ghostCount: c.ghostCount, pendingSuggestions: c.pendingSuggestions }
    })
    if (this.started) this.syncVaultMode()
  }

  /** True while vault mode is on (`experimental.vault`) and the company module is available. */
  vaultMode(): boolean {
    if (!this.companies) return false
    try {
      return this.deps.vaultEnabled ? this.deps.vaultEnabled() : this.companies.store.getSettings().experimental?.vault === true
    } catch {
      return false
    }
  }

  /**
   * Starts or stops the vault runtime when the flag flips; registers or withdraws the company card renderer. A
   * migration in flight keeps the runtime open even while the flag is still off.
   */
  syncVaultMode(): void {
    const on = this.vaultMode()
    if (on) {
      try {
        this.passport()
      } catch (e) {
        this.deps.log.warn('passport: could not start the vault runtime; agents spawn without memory', { e: String(e) })
      }
    } else if (this.passportRt && !this.migrating) {
      this.passportRt.stop()
      this.passportRt = null
      if (this.cardFor) this.companies?.setPassportRenderer(null)
      this.cardFor = null
    }
  }

  /**
   * The vault runtime (created on first use). In vault mode it is started (spool bridge, grant sweep, every vault) and
   * the company card renderer is registered before anything else uses it, so a grant made right after the flag flips
   * is served. With the flag off (a migration preparing the vaults) it is only opened. Throws when unavailable.
   */
  passport(): PassportRuntime {
    const rt = this.passportRt ?? this.openRuntime()
    if (this.vaultMode()) {
      if (!rt.isRunning()) rt.start()
      if (this.cardFor !== rt) this.registerCard(rt)
    }
    return rt
  }

  private openRuntime(): PassportRuntime {
    if (!this.companies) throw new MemoryRefusal('The company module is not ready', 'refused')
    const rt = new PassportRuntime({
      userData: this.deps.userData,
      companies: this.companies,
      fingerprints: () => this.fpCache,
      redact: (t) => this.deps.redact(t),
      emit: (e) => this.deps.emit(e),
      log: this.deps.log,
      now: this.deps.now,
      watch: this.deps.watchVaults
    })
    rt.suggester = this.suggester
    rt.migrator = this.migrator
    this.passportRt = rt
    return rt
  }

  /** COMPANY.md §5 / PASSPORT.md §8.3: the vault's company card is the Passport context (also with memory off). */
  private registerCard(rt: PassportRuntime): void {
    const companies = this.companies
    if (!companies) return
    this.cardFor = rt
    companies.setPassportRenderer((company, department) => {
      try {
        rt.ensure(company.id)
        // DEPARTMENTS.md §7: the slot reads the department's note; a department made while the vault was off gets it now
        if (department) rt.ensureDepartmentNote(company.id, department)
        const redact = (t: string) => this.deps.redact(t)
        return renderCompanyCard(rt.db, company, redact, department ?? null) ?? staticCard(company, department, rt.db, redact)
      } catch {
        return staticCard(company, department)
      }
    })
  }

  /**
   * memory:vault migrate (§9). It may run before the flag is on, so the runtime is opened (not started, no card) and
   * kept open until the migration ends. Null when no migrator is registered (P5).
   */
  async migrate(opts: { dryRun: boolean }): Promise<VaultMigrationReport | null> {
    const fn = this.migrator
    if (!fn) return null
    this.migrating++
    try {
      this.passport()
      return await fn(opts)
    } finally {
      this.migrating--
      this.syncVaultMode()
    }
  }

  /**
   * DEPARTMENTS.md §7: called when a department is created (or renamed into a vault without its note). Creates
   * `Departments/<Name>.md` once; a second call is a no-op. Null with the vault off, read-only, or an unknown department.
   */
  ensureDepartmentNote(companyId: Id, department: PassportDepartment | Id): NotePath | null {
    if (!this.vaultMode()) return null
    try {
      const d = typeof department === 'string' ? this.companies?.scope?.passportDepartment(companyId, department) ?? null : department
      return d ? this.passport().ensureDepartmentNote(companyId, d) : null
    } catch (e) {
      this.deps.log.warn('passport: department note skipped', { companyId, e: String(e) })
      return null
    }
  }

  /** Open Passport export/import need the vault (the notes are the passport). */
  openPassport(): PassportRuntime {
    if (!this.vaultMode()) throw new MemoryRefusal('Open Passport export and import need the Passport vault. Turn it on under Settings → Experimental.', 'refused')
    return this.passport()
  }

  /**
   * Open Passport §8.3: a task approved with a note (`likes`) or sent back (`dislikes`) is filed as a `taste` proposal
   * on its department's note (the company's Taste note without one). Vault mode only; short notes say nothing.
   */
  async reviewTaste(task: { companyId: Id; departmentId?: Id | null; title: string }, outcome: 'approved' | 'sent_back', note: string): Promise<VaultTasteResult | null> {
    if (!this.vaultMode()) return null
    const signal = reviewSignal(outcome, note, task.title)
    if (!signal) return null
    const department = task.departmentId ? this.companies?.scope?.passportDepartment(task.companyId, task.departmentId) ?? null : null
    return this.passport().taste(task.companyId, { scope: department ? { department } : 'company', ...signal }, { stated: false, source: { kind: 'user' }, proposalSource: 'board' })
  }

  /** P6: the suggestion pipeline behind memory:proposals suggestNow. */
  setSuggester(fn: Suggester | null): void {
    this.suggester = fn
    if (this.passportRt) this.passportRt.suggester = fn
  }
  /** P5: the vault migration behind memory:vault migrate. */
  setMigrator(fn: Migrator | null): void {
    this.migrator = fn
    if (this.passportRt) this.passportRt.migrator = fn
  }

  /** §7.5: a grant bound to one company (the session or run stamp, else the cwd's company); cwd only boosts a repo. */
  private vaultGrant(req: MemoryGrantRequest): MemoryGrant | null {
    try {
      const rt = this.passport()
      const companies = this.companies!
      const cwd = this.deps.mapCwd?.(req.cwd) ?? req.cwd
      const companyId = req.companyId ?? companies.resolveCompany({ cwd }).company.id
      const company = rt.company(companyId)
      const root = rt.ensure(companyId)
      let repo = repoForCwd(this.deps.listRepos(), cwd)
      if (repo) {
        try {
          if (companies.companyForRepo(repo.id).id !== companyId) repo = null
        } catch {
          repo = null
        }
      }
      // a vault another Principia instance holds is read-only here: no write tools the writer would refuse anyway. The
      // row stores the effective mode, so the hivemem server lists exactly the tools the spawn was granted.
      const canWrite = req.mode === 'read-write' && !rt.isPaused() && rt.locks.isHeld(root)
      const row = rt.grants.create({
        companyId,
        vaultPath: root,
        spoolDir: (id) => path.join(memRpcRoot(this.deps.userData), id),
        mode: canWrite ? 'read-write' : 'read',
        adapter: req.adapter,
        transport: req.transport,
        profileId: req.profile?.id ?? null,
        profileName: req.profile?.name ?? null,
        model: req.profile?.model ?? null,
        repoId: repo?.id ?? null,
        repoName: repo?.name ?? null,
        runId: req.runId ?? null,
        runTitle: req.runTitle ?? null,
        workflowId: req.workflowId ?? null,
        stepId: req.stepId ?? null,
        nodeId: req.nodeId ?? null,
        nodeLabel: req.nodeLabel ?? null,
        sessionId: req.sessionId ?? null
      })
      this.vaultGrants.add(row.id)
      if (row.spool_dir) rt.bridge.open(row.id, row.spool_dir)
      // the company card (and the department slot after it) reaches the spawn as its Passport context
      // (setPassportRenderer), so the brief skips both; the department still boosts the notes linked to it
      const department = this.grantDepartment(companyId, req)
      const brief = buildPassportBrief(
        rt.db,
        { companyId, companyName: company.name, repo: repo ? { id: repo.id, name: repo.name } : null, query: req.briefQuery, transport: req.transport, includeCompanyCard: false, department, now: this.deps.now?.() },
        (t) => this.deps.redact(t)
      )
      rt.rememberBrief(row.id, brief.noteIds)
      return {
        grantId: row.id,
        server: this.vaultServerSpec(row, root),
        toolNames: [...MEMORY_READ_TOOLS, ...(canWrite ? VAULT_WRITE_TOOLS : [])],
        spawnDir: this.paths.spawnDir,
        brief: brief.text
      }
    } catch (e) {
      this.deps.log.warn('memory: vault grant failed; spawning without memory', { e: String(e) })
      return null
    }
  }

  /** The spawn's department: an explicit `departmentId`, else the task its run or session works on; null for none. */
  private grantDepartment(companyId: Id, req: MemoryGrantRequest & { departmentId?: Id | null }): PassportDepartment | null {
    const scope = this.companies?.scope
    if (!scope) return null
    try {
      const d = req.departmentId ? scope.passportDepartment(companyId, req.departmentId) : scope.departmentOf({ runId: req.runId, sessionId: req.sessionId })
      return d && d.companyId === companyId ? d : null
    } catch {
      return null
    }
  }

  /** §7.1 env: the index read-only, the grant, fingerprints, the spool, the company and the vault (messages only). */
  vaultServerSpec(g: Pick<VaultGrantRow, 'id' | 'company_id' | 'spool_dir'>, root: string): MemoryGrant['server'] {
    return {
      name: MEMORY_SERVER_NAME,
      command: this.deps.execPath,
      args: [this.deps.serverScript],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HIVE_MEM_INDEX: indexDbPath(this.deps.userData),
        HIVE_MEM_GRANT: g.id,
        HIVE_MEM_FP: this.paths.fpPath,
        HIVE_MEM_SPOOL: g.spool_dir ?? '',
        HIVE_COMPANY_ID: g.company_id,
        HIVE_VAULT: root
      }
    }
  }

  private releaseVaultGrant(grantId: Id): void {
    const rt = this.passportRt
    this.vaultGrants.delete(grantId)
    if (!rt) return
    try {
      const row = rt.grants.close(grantId)
      rt.bridge.close(grantId)
      rt.forgetBrief(grantId)
      removeSpoolDir(this.deps.userData, row?.spool_dir ?? null)
    } catch (e) {
      this.deps.log.warn('memory: release failed', { e: String(e) })
    }
    try {
      for (const f of fs.readdirSync(this.paths.spawnDir)) {
        if (f.startsWith(`${grantId}.`)) fs.rmSync(path.join(this.paths.spawnDir, f), { force: true })
      }
    } catch {
      /* ignore */
    }
  }

  /** Grants of either backend (index.ts reads the last mode of a session). */
  listGrants(q: { runId?: Id; sessionId?: Id; companyId?: Id }) {
    if (this.vaultMode() && this.passportRt) return this.passportRt.grants.list(q)
    return this.store.listGrants(q)
  }

  isPaused(): boolean {
    return this.vaultMode() ? this.passport().isPaused() : this.store.isPaused()
  }
  setPaused(paused: boolean): void {
    if (this.vaultMode()) this.passport().setPaused(paused)
    else this.store.setPaused(paused)
  }

  /** "Reverse this run" (§6.5): vault lines are invalidated or restored, never removed. */
  async revertRun(runId: Id): Promise<{ invalidated: number; restored: number }> {
    if (this.vaultMode()) return this.passport().revertRun(runId)
    return this.store.revertRun(runId)
  }

  /** LIVE.md §8 on the vault: agent lines written since `since`, newest first. */
  private vaultFactsSince(since: string, limit: number, companyId: string | null): LearnedFact[] {
    const rt = this.passportRt
    if (!rt) return []
    const rows = rt.db
      .prepare(
        `SELECT e.ts, e.company_id, e.block_id, e.entity_id, e.actor, e.run_id, e.grant_id, f.id AS fid, f.text, f.category, f.status, f.pinned, f.reviewed, f.repo_id,
           n.title, g.repo_name, g.run_title, g.adapter, g.transport, g.profile_id, g.profile_name, g.model, g.repo_id AS g_repo_id, g.workflow_id, g.step_id,
           g.node_id, g.node_label, g.session_id, g.created_at AS g_created
         FROM mem_event e
         JOIN mem_fact f ON f.company_id = e.company_id AND f.block_id = e.block_id AND f.status IN ('active','pending')
         JOIN mem_note n ON n.company_id = f.company_id AND n.id = f.note_id AND n.removed_at IS NULL
         LEFT JOIN mem_grant g ON g.id = e.grant_id
         WHERE e.target_kind = 'fact' AND e.op IN ('create','supersede') AND e.grant_id IS NOT NULL AND e.ts >= ? ${companyId ? 'AND e.company_id = ?' : ''}
         ORDER BY e.seq DESC LIMIT ?`
      )
      .all(since, ...(companyId ? [companyId] : []), Math.min(Math.max(limit, 1), 100)) as Record<string, string | number | null>[]
    const s = (v: unknown) => (v == null ? null : String(v))
    return rows.map((r) => {
      const kind = categoryKind(String(r.category))
      const fact: MemoryFact = {
        id: String(r.fid),
        entityId: String(r.entity_id),
        entityName: this.deps.redact(String(r.title)),
        text: this.deps.redact(String(r.text)),
        kind: (kind === 'other' ? 'fact' : kind) as MemoryFactKind,
        scope: 'project',
        repoId: s(r.repo_id) ?? s(r.g_repo_id),
        status: r.status === 'pending' ? 'pending' : 'active',
        reviewed: !!r.reviewed,
        pinned: !!r.pinned,
        invalidatedAt: null,
        invalidReason: null,
        supersededBy: null,
        supersedes: [],
        actor: 'agent',
        provenance: r.grant_id
          ? {
              grantId: String(r.grant_id),
              adapter: String(r.adapter ?? 'claude') as AdapterId,
              transport: (r.transport === 'inject' ? 'inject' : 'mcp') as 'mcp' | 'inject',
              profileId: s(r.profile_id),
              profileName: s(r.profile_name),
              model: s(r.model),
              repoId: s(r.g_repo_id),
              repoName: s(r.repo_name),
              runId: s(r.run_id),
              runTitle: s(r.run_title),
              workflowId: s(r.workflow_id),
              stepId: s(r.step_id),
              nodeId: s(r.node_id),
              nodeLabel: s(r.node_label),
              sessionId: s(r.session_id),
              createdAt: String(r.g_created ?? r.ts)
            }
          : null,
        unattributed: !r.grant_id,
        editedByUser: false,
        createdAt: String(r.ts),
        updatedAt: String(r.ts)
      }
      return { fact, entityName: fact.entityName, repoName: s(r.repo_name), runId: s(r.run_id), runTitle: r.run_title ? this.deps.redact(String(r.run_title)) : null }
    })
  }

}

/**
 * Static profile card while a company has no hub note yet (COMPANY.md §5 fallback). The department slot still reads the
 * department's note when the index is at hand, else its contextFallback (DEPARTMENTS.md §7). Vault lines go through
 * `redact` like every other brief line (the note is hand-editable in Obsidian).
 */
function staticCard(company: CompanyPassport, department?: PassportDepartment | null, db?: IndexDB, redact: (s: string) => string = (s) => s): string | null {
  if (!department || !db) return staticPassportRenderer(company, department)
  let slot: string[] = []
  try {
    slot = departmentCardLines(db, company.id, department, hubNote(db, company.id, company.name)?.id ?? null).map((l) => redact(fenceSafe(l)))
  } catch {
    return staticPassportRenderer(company, department)
  }
  const card = staticPassportRenderer(company)
  return [card, slot.join('\n')].filter(Boolean).join('\n\n') || null
}

/**
 * Path of the bundled MCP server next to the main bundle (out/main/mcp-memory.js). In a packaged app the script is
 * asar-unpacked when that copy exists; Electron-as-node can also run it straight from app.asar.
 */
export function resolveServerScript(mainDir: string): string {
  const p = path.join(mainDir, 'mcp-memory.js')
  const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p
}
