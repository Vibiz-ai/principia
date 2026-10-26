// Passport migration (PASSPORT.md §9): memory.db v1 and the company profiles into the company vaults. Runs behind
// `memory:vault migrate { dryRun }` (MemoryService.setMigrator(createMigrator(…)) in hive.ts).
//
//   1. open memory.db read-only (never modified) and, before the first write, back it up to Hive-backups/
//   2. seed every company vault (PassportRuntime.ensure: skeleton, .obsidian once, _schema, _templates, vault.json)
//   3. hub + repo notes per company (passportToVault.ts), 4. v1 entities, facts, relations, proposals (v1ToVault.ts)
//   5. mem_event rows into the index and log.jsonl; `.principia/migration.json` with the v1 id -> ref map
//   6. full reindex, verify that every planned note and line is in the index, report
//
// Everything is planned against what the vault folders hold right now, so the dry run shows exactly what the real
// run writes and a re-run writes nothing. New notes carrying v1 ids are created as whole files (tmp + rename, never
// over an existing file) and indexed and logged like a writer create; lines added to existing notes go through the
// writer's save path, and hub lines through writer ops, all with actor `migration`.

import fs from 'node:fs'
import type { CompanyPassport } from '../../../../shared/company'
import { PERSONAL_COMPANY_ID } from '../../../../shared/company'
import type { VaultMigrationReport } from '../../../../shared/passport'
import type { Repo } from '../../../../shared/types'
import { appendLine as appendSectionLine, appendObservation, appendRelation } from '../../../../shared/vault/patch'
import { formatHistory } from '../../../../shared/vault/grammar'
import { isoDate } from '../../../../shared/vault/serialize'
import type { MemoryCompanies, Migrator, PassportRuntime } from '../../service'
import { memoryPaths } from '../../service'
import { atomicWrite, readFileState, sha1, writeTmp } from '../fsutil'
import { insertProposal } from '../indexDb'
import { logEvent } from '../log'
import { toVaultAbs, vaultFiles } from '../paths'
import { planHub, planRepoNotes, readVaultView, type HubPlan, type NoteCreate, type VaultView } from './passportToVault'
import { buildReport, emptyCompanyReport, formatReport, type CompanyReport } from './report'
import { backupV1, emptyV1, openV1ReadOnly, planEvents, planV1, readV1, type EventPlan, type MapEntry, type V1Plan } from './v1ToVault'

export { formatReport } from './report'
export { productNames } from './passportToVault'

export interface MigrationDeps {
  userData: string
  /** default `<userData>/memory.db` */
  memoryDbPath?: string
  companies: Pick<MemoryCompanies, 'listPassports' | 'companyForRepo' | 'vaultPathFor'>
  listRepos(): Repo[]
  /** the vault runtime (MemoryService.passport()); opened by MemoryService.migrate before the migrator runs */
  runtime(): PassportRuntime
  log?: { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
  now?: () => Date
}

export const MIGRATION_FORMAT = 1

/** `.principia/migration.json` */
export interface MigrationFile {
  formatVersion: number
  companyId: string
  migratedAt: string
  backupPath: string | null
  /** v1 id -> where it lives now */
  map: Record<string, { ref: string; noteId: string; path: string; status: MapEntry['status'] }>
  /** v1 mem_event seqs copied into this vault's log */
  events: number[]
  /**
   * fingerprints of the proposals filed: a proposal the user rejected is not filed again, even after the index db was
   * rebuilt (absent in files written before it existed)
   */
  proposals?: string[]
}

/** The `Migrator` MemoryService.setMigrator expects. Runs are serialized: a second click waits for the first. */
export function createMigrator(deps: MigrationDeps): Migrator {
  let chain: Promise<unknown> = Promise.resolve()
  return (opts) => {
    const next = chain.then(
      () => runMigration(deps, opts),
      () => runMigration(deps, opts)
    )
    chain = next.catch(() => undefined)
    return next
  }
}

function readMigrationFile(root: string): MigrationFile | null {
  try {
    return JSON.parse(fs.readFileSync(vaultFiles(root).migrationJson, 'utf8')) as MigrationFile
  } catch {
    return null
  }
}

export async function runMigration(deps: MigrationDeps, opts: { dryRun: boolean }): Promise<VaultMigrationReport> {
  const now = deps.now?.() ?? new Date()
  const at = now.toISOString()
  const warnings: string[] = []
  const rt = deps.runtime()
  const companies = deps.companies.listPassports({ includeArchived: true })
  const personalId = companies.find((c) => c.system === 'personal')?.id ?? PERSONAL_COMPANY_ID
  const repos = deps.listRepos()
  const dbPath = deps.memoryDbPath ?? memoryPaths(deps.userData).dbPath

  // 1. memory.db read-only
  const src = openV1ReadOnly(dbPath)
  try {
    const v1 = src ? readV1(src) : emptyV1()

    // 2. seed (a dry run writes nothing, so it plans against the folders as they are)
    const readOnly = new Map<string, string>()
    if (!opts.dryRun) {
      for (const c of companies) {
        try {
          rt.ensure(c.id)
          const ro = rt.writer.readOnlyReason(c.id)
          if (ro) readOnly.set(c.id, ro)
        } catch (e) {
          readOnly.set(c.id, e instanceof Error ? e.message : String(e))
        }
      }
    }
    for (const [id, why] of readOnly) warnings.push(`${companies.find((c) => c.id === id)?.name ?? id}: vault not writable (${why}); skipped`)

    const views = new Map<string, VaultView>()
    for (const c of companies) views.set(c.id, readVaultView(c.id, deps.companies.vaultPathFor(c.id)))
    const migratedBefore = companies.some((c) => readMigrationFile(views.get(c.id)!.root) !== null)

    // 3. hub and repo notes
    const hubs = new Map<string, HubPlan>()
    const repoCreates: NoteCreate[] = []
    const repoStems = new Map<string, Map<string, string>>()
    for (const c of companies) {
      const view = views.get(c.id)!
      const hub = planHub(c, view)
      hubs.set(c.id, hub)
      const rp = planRepoNotes(c, repos, view, hub.hubStem, now)
      repoCreates.push(...rp.creates)
      repoStems.set(c.id, rp.stems)
    }

    // 4. v1 entities
    const known = new Set(companies.map((c) => c.id))
    const companyOfRepo = (repoId: string): string => {
      try {
        const id = deps.companies.companyForRepo(repoId).id
        return known.has(id) ? id : personalId
      } catch {
        return personalId
      }
    }
    const before = new Map(companies.map((c) => [c.id, readMigrationFile(views.get(c.id)!.root)]))
    const migrated = new Map(companies.flatMap((c) => (before.get(c.id) ? [[c.id, before.get(c.id)!.map] as const] : [])))
    const plan = planV1(v1, { personalId, companyOfRepo, views, repoStems, now, migrated })
    warnings.push(...plan.warnings)
    const events = planEvents(v1, plan, { personalId, companyOfRepo })

    // what is new (dry run and real run count the same way)
    const proposalExists = rt.db.prepare('SELECT 1 FROM mem_proposal WHERE company_id = ? AND fingerprint = ?')
    const eventExists = rt.db.prepare('SELECT 1 FROM mem_event WHERE company_id = ? AND op_id = ?')
    const copiedBefore = new Map(companies.map((c) => [c.id, new Set(before.get(c.id)?.events ?? [])]))
    const filedBefore = new Map(companies.map((c) => [c.id, new Set(before.get(c.id)?.proposals ?? [])]))
    const newProposals = plan.proposals.filter((p) => !proposalExists.get(p.companyId, p.fingerprint) && !filedBefore.get(p.companyId)?.has(p.fingerprint))
    const newEvents = events.filter((e) => !eventExists.get(e.companyId, e.opId) && !copiedBefore.get(e.companyId)?.has(e.seq))
    const skip = (companyId: string) => readOnly.has(companyId)

    const reports = new Map<string, CompanyReport>(companies.map((c) => [c.id, emptyCompanyReport(c.id, c.name)]))
    const tally = (writes: { creates: NoteCreate[]; appends: V1Plan['appends']; proposals: V1Plan['proposals'] }) => {
      for (const c of writes.creates) {
        const r = reports.get(c.companyId)!
        if (c.v1Id) r.entityNotes++
        else r.repoNotes++
        r.observations += c.observations
        r.historyLines += c.historyLines
      }
      for (const a of writes.appends) {
        const r = reports.get(a.companyId)!
        r.observations += a.observations.length
        r.historyLines += a.history.length
      }
      for (const p of writes.proposals) reports.get(p.companyId)!.proposals++
    }
    const live = {
      creates: [...repoCreates, ...plan.creates].filter((c) => !skip(c.companyId)),
      appends: plan.appends.filter((a) => !skip(a.companyId)),
      proposals: newProposals.filter((p) => !skip(p.companyId))
    }
    tally(live)
    const hubWrites = companies.filter((c) => !skip(c.id)).reduce((n, c) => n + hubs.get(c.id)!.ops.length, 0)
    const liveEvents = newEvents.filter((e) => !skip(e.companyId))
    const mapChanges = companies.filter((c) => !skip(c.id) && migrationFileChanged(views.get(c.id)!.root, c.id, plan, events))
    for (const c of companies) {
      if (skip(c.id)) continue
      // a hub note counts only when this run writes one (an existing hub with nothing to add is not work to offer)
      reports.get(c.id)!.hubNote = hubs.get(c.id)!.ops.length > 0 || !views.get(c.id)!.exists
    }
    const anyWork = live.creates.length + live.appends.length + live.proposals.length + hubWrites + liveEvents.length + mapChanges.length > 0

    if (opts.dryRun || !anyWork) {
      return buildReport({ dryRun: opts.dryRun, backupPath: null, companies: [...reports.values()], events: liveEvents.length, extraWrites: hubWrites + mapChanges.length, migratedBefore, warnings })
    }

    // 1b. backup before the first write
    let backupPath: string | null = null
    if (src) {
      try {
        backupPath = backupV1(src, dbPath, now)
      } catch (e) {
        warnings.push(`memory.db backup failed (${e instanceof Error ? e.message : String(e)}); nothing was written`)
        return buildReport({ dryRun: false, backupPath: null, companies: [], events: 0, extraWrites: 0, migratedBefore, warnings })
      }
    }

    const ctx = { actor: 'migration' as const, date: isoDate(now) }
    // `companyId|path` of notes this run could not create or append to: their new v1 ids stay out of migration.json, so
    // the next run tries again instead of reading them as removed by a human
    const failed = new Set<string>()
    const touched = new Map<string, { paths: Set<string>; noteIds: Set<string> }>()
    const touch = (companyId: string, p: string, noteId: string | null) => {
      const t = touched.get(companyId) ?? { paths: new Set<string>(), noteIds: new Set<string>() }
      t.paths.add(p)
      if (noteId) t.noteIds.add(noteId)
      touched.set(companyId, t)
    }

    // hub lines (writer ops: the writer dedups observations and relations)
    for (const c of companies) {
      const hub = hubs.get(c.id)!
      if (skip(c.id) || !hub.ops.length) continue
      const res = await rt.writer.apply(c.id, hub.ops, ctx)
      for (const r of res.results) if (r.status === 'error' || r.status === 'conflict') warnings.push(`${c.name}: hub note line not written (${r.reason ?? r.status})`)
    }

    // new notes: repo notes first (entity notes link to them), then entities
    for (const n of live.creates) {
      try {
        createNoteFile(rt, n, at)
        touch(n.companyId, n.path, n.noteId)
      } catch (e) {
        warnings.push(`${n.path}: not created (${e instanceof Error ? e.message : String(e)})`)
        failed.add(`${n.companyId}|${n.path}`)
        const r = reports.get(n.companyId)!
        if (n.v1Id) r.entityNotes--
        else r.repoNotes--
        r.observations -= n.observations
        r.historyLines -= n.historyLines
      }
    }

    // lines missing from notes an earlier run created (v1 kept changing while the flag was off)
    for (const a of live.appends) {
      const root = rt.index.root(a.companyId)
      const file = readFileState(toVaultAbs(root, a.path))
      if (!file) {
        warnings.push(`${a.path}: gone; its new v1 lines were not added`)
        failed.add(`${a.companyId}|${a.path}`)
        continue
      }
      let text = file.text
      for (const o of a.observations) text = appendObservation(text, o).text
      for (const r of a.relations) text = appendRelation(text, r).text
      for (const h of a.history) text = appendSectionLine(text, 'history', formatHistory(h)).text
      const res = await rt.writer.save(a.companyId, { path: a.path, baseHash: file.hash, text }, ctx)
      if (res.status !== 'saved') {
        warnings.push(`${a.path}: new v1 lines not added (${res.status === 'error' ? res.reason : 'changed while migrating'})`)
        failed.add(`${a.companyId}|${a.path}`)
      } else touch(a.companyId, a.path, a.noteId)
    }

    // pending facts and relations, global facts
    for (const p of live.proposals) {
      const note = rt.index.noteById(p.companyId, p.noteId)
      insertProposal(rt.db, {
        companyId: p.companyId,
        kind: p.kind,
        payload: p.ops,
        evidence: [{ path: note?.path ?? p.path, line: null, quote: p.quote, note: p.why }],
        score: 1,
        source: 'migration',
        fingerprint: p.fingerprint,
        baseHashes: note ? { [note.path]: note.hash } : {},
        createdAt: at
      })
    }

    // 5. events and migration.json
    for (const e of liveEvents) logEvent(rt.db, rt.index.root(e.companyId), e.record)
    for (const c of mapChanges) writeMigrationFile(rt.index.root(c.id), c.id, plan, events, backupPath, at, failed)

    // 6. reindex, verify, report
    for (const c of companies) {
      if (skip(c.id)) continue
      const t = touched.get(c.id)
      if (t) rt.index.emitChanged({ companyId: c.id, paths: [...t.paths], noteIds: [...t.noteIds] })
      try {
        rt.reindex(c.id)
      } catch (e) {
        warnings.push(`${c.name}: reindex failed (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    warnings.push(...verify(rt, plan, companies, skip))
    const report = buildReport({ dryRun: false, backupPath, companies: [...reports.values()], events: liveEvents.length, extraWrites: hubWrites + mapChanges.length, migratedBefore, warnings })
    deps.log?.info('passport: migration done', { report: formatReport(report) })
    return report
  } finally {
    src?.close()
  }
}

/** A new note with v1 ids: tmp + rename (never over an existing file), indexed and logged like a writer create. */
function createNoteFile(rt: PassportRuntime, n: NoteCreate, at: string): void {
  const root = rt.index.root(n.companyId)
  const abs = toVaultAbs(root, n.path)
  if (fs.existsSync(abs)) throw new Error('a file with this name exists')
  const tmp = writeTmp(abs, n.text)
  if (fs.existsSync(abs)) throw new Error('a file with this name appeared')
  const hash = sha1(n.text)
  rt.expected.register(abs, hash)
  fs.renameSync(tmp, abs)
  const r = rt.index.indexNote(n.companyId, n.path, { own: true, emit: false })
  logEvent(rt.db, root, {
    ts: at,
    companyId: n.companyId,
    op: 'create',
    targetKind: 'note',
    targetId: r.noteId ?? n.noteId,
    entityId: r.noteId ?? n.noteId,
    path: n.path,
    actor: 'migration',
    newHash: hash,
    after: { title: n.title, type: n.type, ...(n.v1Id ? { v1: n.v1Id } : {}), observations: n.observations, history: n.historyLines, relations: n.relations }
  })
}

function mapFor(companyId: string, map: MapEntry[], failed?: Set<string>): MigrationFile['map'] {
  const out: MigrationFile['map'] = {}
  for (const m of map) {
    if (m.companyId !== companyId || failed?.has(`${companyId}|${m.path}`)) continue
    out[m.v1Id] = { ref: m.ref, noteId: m.noteId, path: m.path, status: m.status }
  }
  return out
}

type MergedFile = { prev: MigrationFile | null; map: MigrationFile['map']; events: number[]; proposals: string[] }

function mergedFile(root: string, companyId: string, plan: Pick<V1Plan, 'map' | 'proposals'>, events: EventPlan[], failed?: Set<string>): MergedFile {
  const prev = readMigrationFile(root)
  // the first mapping of a v1 id wins: later runs never re-point it
  const merged = { ...mapFor(companyId, plan.map, failed), ...(prev?.map ?? {}) }
  const seqs = [...new Set([...(prev?.events ?? []), ...events.filter((e) => e.companyId === companyId).map((e) => e.seq)])].sort((a, b) => a - b)
  const proposals = [...new Set([...(prev?.proposals ?? []), ...plan.proposals.filter((p) => p.companyId === companyId).map((p) => p.fingerprint)])].sort()
  return { prev, map: merged, events: seqs, proposals }
}

/** True when migration.json would change (nothing v1 maps to this company and no file yet: no file needed). */
function migrationFileChanged(root: string, companyId: string, plan: Pick<V1Plan, 'map' | 'proposals'>, events: EventPlan[]): boolean {
  const m = mergedFile(root, companyId, plan, events)
  if (!m.prev) return Object.keys(m.map).length > 0 || m.events.length > 0 || m.proposals.length > 0
  return (
    JSON.stringify(m.map) !== JSON.stringify(m.prev.map) ||
    JSON.stringify(m.events) !== JSON.stringify(m.prev.events) ||
    JSON.stringify(m.proposals) !== JSON.stringify(m.prev.proposals ?? [])
  )
}

function writeMigrationFile(
  root: string,
  companyId: string,
  plan: Pick<V1Plan, 'map' | 'proposals'>,
  events: EventPlan[],
  backupPath: string | null,
  at: string,
  failed: Set<string>
): void {
  const m = mergedFile(root, companyId, plan, events, failed)
  const file: MigrationFile = {
    formatVersion: MIGRATION_FORMAT,
    companyId,
    migratedAt: m.prev?.migratedAt ?? at,
    backupPath: m.prev?.backupPath ?? backupPath,
    map: m.map,
    events: m.events,
    proposals: m.proposals
  }
  atomicWrite(vaultFiles(root).migrationJson, `${JSON.stringify(file, null, 2)}\n`)
}

/** §9 step 6: every note and line this run wrote is in the index with the expected status. */
function verify(rt: PassportRuntime, plan: V1Plan, companies: CompanyPassport[], skip: (id: string) => boolean): string[] {
  const out: string[] = []
  for (const c of companies) {
    const w = plan.written.get(c.id)
    if (!w || skip(c.id)) continue
    const missingNotes = [...w.notes].filter((id) => !rt.index.noteById(c.id, id))
    const status = (blockId: string): string | null => {
      const f = rt.db.prepare('SELECT status FROM mem_fact WHERE company_id = ? AND block_id = ? LIMIT 1').get(c.id, blockId) as { status: string } | undefined
      if (f) return f.status
      const l = rt.db.prepare("SELECT status FROM mem_link WHERE company_id = ? AND block_id = ? AND origin = 'relation' LIMIT 1").get(c.id, blockId) as { status: string } | undefined
      return l ? l.status : null
    }
    const badActive = [...w.active].filter((b) => status(b) !== 'active')
    const badHistory = [...w.history].filter((b) => {
      const s = status(b)
      return s !== 'superseded' && s !== 'invalid'
    })
    if (missingNotes.length) out.push(`${c.name}: ${missingNotes.length} migrated notes are not in the index`)
    if (badActive.length) out.push(`${c.name}: ${badActive.length} migrated observations are not active in the index (${badActive.slice(0, 3).map((b) => `^${b}`).join(', ')})`)
    if (badHistory.length) out.push(`${c.name}: ${badHistory.length} migrated History lines are not in History (${badHistory.slice(0, 3).map((b) => `^${b}`).join(', ')})`)
  }
  return out
}
