/**
 * The Passport suggestion pipeline (PASSPORT.md §12). Every job runs for one company and loads only that company's
 * rows; every result is a `mem_proposal` (queue.ts). Nothing is written to a vault until a human accepts.
 *
 * - Stage 0 (deterministic: mentions, ghosts, dupes, relation types) runs for the changed notes after each index
 *   batch, debounced 2 s. Pending suggestions are re-validated first (re-anchored or marked stale).
 * - Stage 1 (statistical: co-occurrence, TF-IDF similarity) runs idle-time, debounced 30 s per company, or on
 *   "Suggest" (memory:proposals suggestNow).
 * - Stage 2 (LLM, llm.ts) runs only when `experimental.vaultAI` is on and the company opted in, under the daily cap:
 *   after a run wrote 2+ memory ops (at most one job per 10 minutes per company), on "Suggest for this note" /
 *   "Garden now", and in a nightly idle sweep.
 * - The harvester (harvest.ts) files `<passport-notes>` from read-write inject steps (EngineContext.onStepOutput).
 *
 * `installSuggestions` wires it into main: MemoryService.setSuggester, the step-output hook, and the change feed of
 * whichever vault runtime is live.
 */
import type { StepOutputEvent } from '../../../../shared/engine'
import type { VaultApplyResult } from '../../../../shared/passport'
import type { FingerprintFile } from '../../screen'
import type { IndexDB } from '../indexDb'
import type { ChangedEvent } from '../indexer'
import { readFileState } from '../fsutil'
import { toVaultAbs } from '../paths'
import { loadVaultView, llmCandidates, type Candidate, type VaultView, type ViewNote } from './candidates'
import { cooccurCandidates } from './cooccur'
import { dupeCandidates } from './dupes'
import { ghostCandidates } from './ghosts'
import { extractHarvestBlock, harvestCandidates, parseHarvestBlock, screenHarvest, shouldHarvest } from './harvest'
import { lastLlmJobAt, llmGate, runLlm, type LlmDeps } from './llm'
import { mentionCandidates, type NoteText } from './mentions'
import { SuggestionQueue, type FileResult } from './queue'
import { relationTypeCandidates } from './relTypes'
import { similarCandidates } from './similar'

export { SuggestionQueue, fingerprintOf, QUEUE_CAP } from './queue'
export { isLlmOptedIn, setLlmOptIn, llmDailyCap, setLlmDailyCap, llmActivity, LLM_CLI_ORDER, LLM_CLI_KEYS, type LlmCli } from './llm'

export const STAGE0_DEBOUNCE_MS = 2000
export const STAGE1_DEBOUNCE_MS = 30_000
export const LLM_COALESCE_MS = 10 * 60_000
export const LLM_RUN_MIN_OPS = 2

/** What the pipeline needs from PassportRuntime (service.ts); the runtime satisfies it structurally. */
export interface SuggestRuntime {
  db: IndexDB
  index: { root(companyId: string): string; hasVault(companyId: string): boolean }
  ensure(companyId: string): string
  onChanged(fn: (e: ChangedEvent) => void): () => void
  fingerprints(): FingerprintFile | null
  acceptProposals(companyId: string, ids: string[], opts?: { addAlias?: boolean }): Promise<{ accepted: number; stale: number; results: VaultApplyResult }>
  listCompanies?(): string[]
}

export interface PipelineDeps {
  runtime(): SuggestRuntime | null
  redact(text: string): string
  log: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
  /** stage 2; absent = the LLM tier never runs */
  llm?: Pick<LlmDeps, 'enabled' | 'cli' | 'env' | 'exec'>
  /** debounce timers and the nightly sweep (default true; tests drive the stages directly) */
  timers?: boolean
}

export interface SuggestRunResult {
  /** a stage-2 job ran (or was attempted) */
  queued: boolean
  created: number
}

export class SuggestionPipeline {
  private attached = new WeakSet<SuggestRuntime>()
  private unsubscribe: (() => void) | null = null
  private pending = new Map<string, { notes: Set<string>; full: boolean }>()
  private t0 = new Map<string, NodeJS.Timeout>()
  private t1 = new Map<string, NodeJS.Timeout>()
  private lastSeq = new Map<string, number>()
  private llmBusy = new Set<string>()
  private nightly: NodeJS.Timeout | null = null
  private lastSweepDay = ''

  constructor(private deps: PipelineDeps) {
    if (deps.timers !== false) {
      this.nightly = setInterval(() => void this.nightlySweep(), 60 * 60_000)
      this.nightly.unref?.()
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private rt(): SuggestRuntime | null {
    try {
      return this.deps.runtime()
    } catch {
      return null
    }
  }

  queue(rt: SuggestRuntime): SuggestionQueue {
    return new SuggestionQueue({ db: rt.db, read: (companyId, rel) => readNote(rt, companyId, rel), now: this.deps.now })
  }

  /** Subscribes to a runtime's change feed once (the runtime is recreated when the vault flag flips). */
  attach(rt: SuggestRuntime): void {
    if (this.attached.has(rt)) return
    this.attached.add(rt)
    this.unsubscribe?.()
    this.unsubscribe = rt.onChanged((e) => this.onChanged(e))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const t of [...this.t0.values(), ...this.t1.values()]) clearTimeout(t)
    this.t0.clear()
    this.t1.clear()
    if (this.nightly) clearInterval(this.nightly)
    this.nightly = null
  }

  // ---------- change feed ----------

  /** indexer batch -> stage 0 for the changed notes (2 s), stage 1 for the company (30 s). */
  onChanged(e: ChangedEvent): void {
    this.reanchorNow(e)
    const p = this.pending.get(e.companyId) ?? { notes: new Set<string>(), full: false }
    e.noteIds.forEach((id) => p.notes.add(id))
    if (e.full) p.full = true
    this.pending.set(e.companyId, p)
    if (this.deps.timers === false) return
    clearTimeout(this.t0.get(e.companyId))
    const t = setTimeout(() => void this.flushChanges(e.companyId), STAGE0_DEBOUNCE_MS)
    t.unref?.()
    this.t0.set(e.companyId, t)
  }

  /**
   * Re-anchors pending mention suggestions on the changed files at once, not after the 2 s debounce. The writer's
   * linkMention trusts the stored line and span, so an accept right after an edit (or the second of two mentions on one
   * line accepted together) must not replay a shifted position.
   */
  private reanchorNow(e: ChangedEvent): void {
    if (!e.paths.length && !e.full) return
    const rt = this.rt()
    if (!rt) return
    try {
      const paths = e.paths.slice(0, 500)
      const hit =
        e.full ||
        e.paths.length > paths.length ||
        !!rt.db
          .prepare(
            `SELECT 1 FROM mem_proposal p, json_each(p.base_hashes_json) j
             WHERE p.company_id = ? AND p.status = 'pending' AND p.kind = 'link' AND j.key IN (${paths.map(() => '?').join(',')}) LIMIT 1`
          )
          .get(e.companyId, ...paths)
      if (hit) this.queue(rt).refresh(e.companyId)
    } catch (err) {
      this.deps.log.warn('passport: re-anchoring suggestions failed', { companyId: e.companyId, e: String(err) })
    }
  }

  /** The debounced stage-0 job (tests call it directly). */
  async flushChanges(companyId: string): Promise<FileResult | null> {
    this.t0.delete(companyId)
    const p = this.pending.get(companyId)
    this.pending.delete(companyId)
    const rt = this.rt()
    if (!p || !rt || !rt.index.hasVault(companyId)) return null
    let res: FileResult | null = null
    try {
      const view = loadVaultView(rt.db, companyId)
      this.queue(rt).refresh(companyId, view)
      // a full rebuild re-checks ghosts, dupes and relation types company-wide; mentions only for touched notes
      res = this.stage0(rt, view, p.full ? null : [...p.notes], { mentions: !p.full })
    } catch (err) {
      this.deps.log.warn('passport: stage 0 suggestions failed', { companyId, e: String(err) })
    }
    this.scheduleStage1(companyId)
    void this.maybeRunTrigger(rt, companyId)
    return res
  }

  private scheduleStage1(companyId: string): void {
    if (this.deps.timers === false) return
    clearTimeout(this.t1.get(companyId))
    const t = setTimeout(() => {
      this.t1.delete(companyId)
      const rt = this.rt()
      if (!rt || !rt.index.hasVault(companyId)) return
      try {
        this.stage1(rt, loadVaultView(rt.db, companyId), null)
      } catch (err) {
        this.deps.log.warn('passport: stage 1 suggestions failed', { companyId, e: String(err) })
      }
    }, STAGE1_DEBOUNCE_MS)
    t.unref?.()
    this.t1.set(companyId, t)
  }

  // ---------- stages ----------

  /** Stage 0 for some notes (null = all): mentions, ghosts, dupes, relation types. */
  stage0(rt: SuggestRuntime, view: VaultView, noteIds: string[] | null, opts: { mentions?: boolean } = {}): FileResult {
    const companyId = view.companyId
    const read = (n: ViewNote) => readNote(rt, companyId, n.path)
    const cands: Candidate[] = [
      ...(opts.mentions === false ? [] : mentionCandidates(view, noteIds, read)),
      ...ghostCandidates(view, noteIds),
      ...dupeCandidates(view, noteIds),
      ...relationTypeCandidates(rt.db, view, noteIds)
    ]
    return this.queue(rt).file(companyId, cands)
  }

  /** Stage 1: co-occurrence (company-wide) and similarity (focus notes, or all). */
  stage1(rt: SuggestRuntime, view: VaultView, noteIds: string[] | null): FileResult {
    const cands = [...cooccurCandidates(rt.db, view), ...similarCandidates(rt.db, view, noteIds)]
    return this.queue(rt).file(view.companyId, cands)
  }

  /**
   * memory:proposals suggestNow (the Suggester): stages 0 and 1 for one note or the whole vault, then stage 2 when the
   * company opted in. `queued` reports whether an LLM job ran.
   */
  suggest = async (companyId: string, noteId?: string): Promise<SuggestRunResult> => {
    const rt = this.rt()
    if (!rt) return { queued: false, created: 0 }
    rt.ensure(companyId)
    let view = loadVaultView(rt.db, companyId)
    const focus = noteId ? [noteId] : null
    const q = this.queue(rt)
    q.refresh(companyId, view)
    let created = this.stage0(rt, view, focus).created.length + this.stage1(rt, view, focus).created.length
    let queued = false
    if (this.deps.llm && !llmGate(this.llmDeps(rt), companyId)) {
      view = loadVaultView(rt.db, companyId)
      const ids = noteId ? [noteId] : this.recentNotes(rt, view, 24 * 60 * 60_000)
      const r = await this.runStage2(rt, view, ids, noteId ? 'note' : 'garden')
      queued = r !== null
      created += r ?? 0
    }
    return { queued, created }
  }

  /** Accept through the queue: re-validate (re-anchor or stale) first, then policy + writer (PassportRuntime). */
  async accept(companyId: string, ids: string[], opts: { addAlias?: boolean } = {}): Promise<{ accepted: number; stale: number; results: VaultApplyResult }> {
    const rt = this.rt()
    if (!rt) throw new Error('The Passport is not running')
    this.queue(rt).refresh(companyId)
    return rt.acceptProposals(companyId, ids, opts)
  }

  // ---------- stage 2 ----------

  private llmDeps(rt: SuggestRuntime): LlmDeps {
    const l = this.deps.llm!
    return { ...l, db: rt.db, redact: this.deps.redact, fingerprints: () => rt.fingerprints(), now: this.deps.now, log: this.deps.log }
  }

  /** Runs one LLM job over these notes and files its proposals. Null when it did not run. */
  async runStage2(rt: SuggestRuntime, view: VaultView, noteIds: string[], trigger: string): Promise<number | null> {
    if (!this.deps.llm || this.llmBusy.has(view.companyId)) return null
    const focus = noteIds
      .map((id) => view.byId.get(id))
      .filter((n): n is ViewNote => !!n && n.status !== 'archived')
      .map((note) => ({ note, file: readNote(rt, view.companyId, note.path) }))
      .filter((f): f is { note: ViewNote; file: NoteText } => !!f.file)
    if (!focus.length) return null
    this.llmBusy.add(view.companyId)
    try {
      const r = await runLlm(this.llmDeps(rt), view.companyId, view, focus, llmCandidates(view, focus.map((f) => f.note.id), []), trigger)
      if (!r.ran) return null
      return this.queue(rt).file(view.companyId, r.candidates).created.length
    } finally {
      this.llmBusy.delete(view.companyId)
    }
  }

  /** §12 trigger: a run that wrote 2+ memory ops; at most one job per 10 minutes per company. */
  private async maybeRunTrigger(rt: SuggestRuntime, companyId: string): Promise<void> {
    if (!this.deps.llm) return
    try {
      const max = (rt.db.prepare('SELECT ifnull(max(seq), 0) AS s FROM mem_event WHERE company_id = ?').get(companyId) as { s: number }).s
      const since = this.lastSeq.get(companyId)
      this.lastSeq.set(companyId, max)
      if (since === undefined || max <= since) return
      if (llmGate(this.llmDeps(rt), companyId)) return
      if (this.now().getTime() - lastLlmJobAt(rt.db, companyId) < LLM_COALESCE_MS) return
      const runs = rt.db
        .prepare(`SELECT run_id, count(*) AS n FROM mem_event WHERE company_id = ? AND seq > ? AND run_id IS NOT NULL GROUP BY run_id HAVING n >= ?`)
        .all(companyId, since, LLM_RUN_MIN_OPS) as { run_id: string; n: number }[]
      if (!runs.length) return
      const notes = rt.db
        .prepare(`SELECT DISTINCT entity_id FROM mem_event WHERE company_id = ? AND seq > ? AND run_id IN (${runs.map(() => '?').join(',')}) AND entity_id IS NOT NULL`)
        .all(companyId, since, ...runs.map((r) => r.run_id)) as { entity_id: string }[]
      await this.runStage2(rt, loadVaultView(rt.db, companyId), notes.map((r) => r.entity_id), 'run')
    } catch (err) {
      this.deps.log.warn('passport: AI suggestion trigger failed', { companyId, e: String(err) })
    }
  }

  /** Notes changed within `ms`, newest first, else orphans: the focus of "Garden now" and the nightly sweep. */
  private recentNotes(rt: SuggestRuntime, view: VaultView, ms: number): string[] {
    const since = new Date(this.now().getTime() - ms).toISOString()
    const ids = (
      rt.db.prepare(`SELECT entity_id, max(seq) AS s FROM mem_event WHERE company_id = ? AND ts >= ? AND entity_id IS NOT NULL GROUP BY entity_id ORDER BY s DESC LIMIT 20`).all(view.companyId, since) as {
        entity_id: string
      }[]
    )
      .map((r) => r.entity_id)
      .filter((id) => view.byId.has(id))
    if (ids.length) return ids
    return view.notes.filter((n) => n.status !== 'archived' && !(view.adj.get(n.id)?.size ?? 0)).map((n) => n.id)
  }

  /** Nightly idle sweep (03:00 local, once a day): stage 2 for every opted-in company. */
  async nightlySweep(force = false): Promise<void> {
    const now = this.now()
    const day = now.toISOString().slice(0, 10)
    if (!force && (now.getHours() !== 3 || this.lastSweepDay === day)) return
    this.lastSweepDay = day
    const rt = this.rt()
    if (!rt || !this.deps.llm) return
    const companies = rt.listCompanies?.() ?? (rt.db.prepare('SELECT company_id FROM mem_vault').all() as { company_id: string }[]).map((r) => r.company_id)
    for (const companyId of companies) {
      if (llmGate(this.llmDeps(rt), companyId)) continue
      try {
        const view = loadVaultView(rt.db, companyId)
        await this.runStage2(rt, view, this.recentNotes(rt, view, 24 * 60 * 60_000), 'nightly')
      } catch (err) {
        this.deps.log.warn('passport: nightly AI suggestions failed', { companyId, e: String(err) })
      }
    }
  }

  // ---------- harvest (§7.6) ----------

  /** EngineContext.onStepOutput: files `<passport-notes>` of a read-write inject step as `harvest` proposals. */
  harvest(e: StepOutputEvent): FileResult | null {
    if (!shouldHarvest(e)) return null
    const block = extractHarvestBlock(e.output)
    if (!block) return null
    const rt = this.rt()
    if (!rt) return null
    const companyId = e.companyId!
    rt.ensure(companyId)
    const { notes, dropped } = screenHarvest(parseHarvestBlock(block), rt.fingerprints())
    if (dropped.length) this.deps.log.warn('passport: harvest dropped lines', { runId: e.runId, stepId: e.stepId, count: dropped.length, reasons: [...new Set(dropped.map((d) => d.reason))] })
    if (!notes.length) return null
    const res = this.queue(rt).file(companyId, harvestCandidates(rt.db, loadVaultView(rt.db, companyId), e, notes))
    if (res.created.length) this.deps.log.info('passport: harvested agent notes', { runId: e.runId, stepId: e.stepId, proposals: res.created.length })
    return res
  }
}

function readNote(rt: SuggestRuntime, companyId: string, rel: string): NoteText | null {
  try {
    const f = readFileState(toVaultAbs(rt.index.root(companyId), rel))
    return f ? { text: f.text, hash: f.hash } : null
  } catch {
    return null
  }
}

/** What installSuggestions needs from MemoryService (structural, so tests can fake it). */
export interface SuggestHost {
  setSuggester(fn: ((companyId: string, noteId?: string) => Promise<SuggestRunResult>) | null): void
  vaultMode(): boolean
  passport(): SuggestRuntime
}

/**
 * Wires the pipeline into main (index.ts): the suggester behind memory:proposals suggestNow, the harvester on step
 * output, and the change feed of the live vault runtime (re-attached when the vault flag recreates it).
 */
export function installSuggestions(
  host: SuggestHost,
  opts: Omit<PipelineDeps, 'runtime'> & { stepOutputHooks?: ((e: StepOutputEvent) => void)[] }
): SuggestionPipeline {
  const runtime = (): SuggestRuntime | null => (host.vaultMode() ? host.passport() : null)
  const p = new SuggestionPipeline({ ...opts, runtime })
  host.setSuggester(p.suggest)
  opts.stepOutputHooks?.push((e) => {
    try {
      p.harvest(e)
    } catch (err) {
      opts.log.warn('passport: harvest failed', { runId: e.runId, stepId: e.stepId, e: String(err) })
    }
  })
  const sync = () => {
    try {
      const rt = runtime()
      if (rt) p.attach(rt)
    } catch {
      // vault mode unavailable right now
    }
  }
  sync()
  if (opts.timers !== false) {
    const t = setInterval(sync, 5000)
    t.unref?.()
    const stop = p.stop.bind(p)
    p.stop = () => {
      clearInterval(t)
      stop()
    }
  }
  return p
}
