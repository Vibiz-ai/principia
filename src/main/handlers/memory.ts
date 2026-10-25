/**
 * memory:* IPC handlers (CONTRACT §11.5, PO10; PASSPORT.md §11, amended to 17 channels). Every string that may hold
 * agent text is vault-redacted. The v1 channels serve memory.db while `experimental.vault` is off; with it on, writes
 * go to the company Passport vaults (delete = archive, revertRun = invalidate) and memory.db is only read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { MemoryMutation, MemoryMutationResult, MemoryOverview } from '../../shared/memory'
import { isPassportGraphRequest, type PassportVaultRequest, type PassportVaultResults, type VaultOp } from '../../shared/passport'
import { HiveError } from '../../shared/errors'
import { v1EntityToNoteId, v1ToBlockId } from '../../shared/vault/ids'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { MemoryRefusal, RowMapper } from '../memory/store'
import type { MemoryService, PassportRuntime } from '../memory/service'
import { entityDetail, exportLines, factsQuery, graphQuery, overviewCore, searchPage } from '../memory/search'
import { graphOp, linksOp, noteOp, proposalsOp } from '../memory/passportIpc'
import { indexDbPath, toVaultAbs } from '../memory/vault/paths'
import { isLlmOptedIn, llmActivity, llmCallsOn, llmDailyCap, setLlmDailyCap, setLlmOptIn } from '../memory/vault/suggest/llm'

function svc(h: Hive): MemoryService {
  if (!h.memory) throw new HiveError('internal', 'Memory is unavailable (memory.db could not be opened; see logs)')
  return h.memory
}

/** Store refusals -> HiveError codes the renderer understands. */
function toHive(e: unknown): unknown {
  if (e instanceof MemoryRefusal) {
    const code = e.code === 'refused' ? 'conflict' : e.code
    return new HiveError(code, e.message.replace(/^Refused: /, ''))
  }
  return e
}
function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw toHive(e)
  }
}
async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toHive(e)
  }
}

/** The vault runtime for a Passport channel; refuses while vault mode is off (the v1 page still works). */
function rt(h: Hive): PassportRuntime {
  const m = svc(h)
  if (!m.vaultMode()) throw new HiveError('not_implemented', 'The Passport vault is off (Settings → Experimental → Passport vault)')
  return wrap(() => m.passport())
}

/** v1 ids map 1:1 onto vault ids (PASSPORT.md §3.2): ment_x -> n-x, mfa_x -> ^f-x, mrel_x -> ^r-x. */
function vaultRef(kind: 'entity' | 'fact' | 'relation', id: string): string {
  const ref = kind === 'entity' ? v1EntityToNoteId(id) : v1ToBlockId(id)
  if (!ref) throw new HiveError('not_found', 'This memory item has no Passport counterpart')
  return ref
}

export function overview(h: Hive, companyId?: string): MemoryOverview {
  const m = svc(h)
  if (m.vaultMode()) return vaultOverview(h, m, companyId)
  const within = companyRepoIds(h, companyId)
  const core = overviewCore(m.store, within)
  const repos = core.repos.map((r) => ({
    repoId: r.repoId,
    repoName: h.store.getRepo(r.repoId)?.name ?? r.repoName ?? r.repoId,
    facts: r.facts,
    changedAt: r.changedAt
  }))
  let dbBytes = 0
  for (const f of [m.paths.dbPath, `${m.paths.dbPath}-wal`]) {
    try {
      dbBytes += fs.statSync(f).size
    } catch {
      /* missing wal */
    }
  }
  return {
    agentWritesPaused: core.agentWritesPaused,
    counts: core.counts,
    repos,
    defaultRepoId: repos[0]?.repoId ?? lastRepoWithin(h, within),
    lastSeq: core.lastSeq,
    dbPath: m.paths.dbPath,
    dbBytes
  }
}

/**
 * COMPANY.md §3: the repositories one company owns, for scoping v1 memory reads. undefined = no company asked (All
 * mode, every repo). A repo with no stamp is Personal's.
 */
export function companyRepoIds(h: Hive, companyId: string | null | undefined): string[] | undefined {
  if (!companyId) return undefined
  return h.store.listRepos().filter((r) => (r.companyId ?? PERSONAL_COMPANY_ID) === companyId).map((r) => r.id)
}
function lastRepoWithin(h: Hive, within: string[] | undefined): string | null {
  const last = h.settings().lastRepoId ?? null
  return last && (!within || within.includes(last)) ? last : (within?.[0] ?? null)
}

/** The overview in vault mode: index counts for one company (or every company), no per-repo picker. */
function vaultOverview(h: Hive, m: MemoryService, companyId?: string): MemoryOverview {
  const p = m.passport()
  const where = companyId ? 'company_id = ? AND' : ''
  const args = companyId ? [companyId] : []
  const q = (sql: string) => (p.db.prepare(sql).get(...args) as { n: number }).n
  const file = indexDbPath(h.paths.userData)
  let dbBytes = 0
  for (const f of [file, `${file}-wal`]) {
    try {
      dbBytes += fs.statSync(f).size
    } catch {
      /* missing wal */
    }
  }
  return {
    agentWritesPaused: p.isPaused(),
    counts: {
      entities: q(`SELECT count(*) AS n FROM mem_note WHERE ${where} removed_at IS NULL AND status = 'active'`),
      facts: q(`SELECT count(*) AS n FROM mem_fact WHERE ${where} status = 'active'`),
      relations: q(`SELECT count(*) AS n FROM mem_link WHERE ${where} origin = 'relation' AND status = 'active'`),
      pending: q(`SELECT count(*) AS n FROM mem_proposal WHERE ${where} status = 'pending'`),
      unreviewed: q(`SELECT count(*) AS n FROM mem_fact WHERE ${where} status = 'active' AND reviewed = 0 AND actor NOT LIKE 'user%'`)
    },
    repos: [],
    defaultRepoId: h.settings().lastRepoId ?? null,
    lastSeq: (p.db.prepare('SELECT ifnull(max(seq), 0) AS n FROM mem_event').get() as { n: number }).n,
    dbPath: file,
    dbBytes
  }
}

/** v1 page edits in vault mode, mapped onto writer ops (the user is acting, so policy treats them as user writes). */
async function vaultMutate(p: PassportRuntime, companyId: string, req: MemoryMutation): Promise<MemoryMutationResult> {
  let ops: VaultOp[]
  switch (req.op) {
    case 'invalidate':
      ops = req.ids.map((id) => ({ op: 'invalidate', blockId: vaultRef(req.target, id), reason: req.reason }))
      break
    case 'restore':
      ops = req.ids.map((id) => ({ op: 'restoreLine', blockId: vaultRef(req.target, id) }))
      break
    case 'rename':
      ops = [{ op: 'rename', note: vaultRef('entity', req.id), newTitle: req.name }]
      break
    case 'merge':
      ops = req.sourceIds.map((id) => ({ op: 'merge', from: vaultRef('entity', id), into: vaultRef('entity', req.targetId) }))
      break
    default:
      throw new HiveError('bad_request', 'Edit this in the Passport (memory moved to the company vault)')
  }
  const res = await p.applyOps(companyId, ops, { kind: 'user' })
  return { affected: res.results.filter((r) => r.status === 'ok').length }
}

export function mutate(m: MemoryService, req: MemoryMutation, redact: (s: string) => string): MemoryMutationResult {
  const s = m.store
  const map = new RowMapper(s, redact)
  return wrap(() => {
    switch (req.op) {
      case 'create':
        if (req.target === 'entity') return { affected: 1, entity: map.entities([s.userCreateEntity(req.input)])[0] }
        if (req.target === 'fact') return { affected: 1, fact: map.facts([s.userCreateFact(req.input)])[0] }
        return { affected: 1, relation: map.relations([s.userCreateRelation(req.input)])[0] }
      case 'edit':
        if (req.target === 'fact') return { affected: 1, fact: map.facts([s.userEditFact(req.id, { text: req.text, kind: req.kind })])[0] }
        if (req.target === 'entity')
          return { affected: 1, entity: map.entities([s.userEditEntity(req.id, { type: req.type, summary: req.summary, aliases: req.aliases })])[0] }
        return { affected: 1, relation: map.relations([s.userEditRelation(req.id, req.type)])[0] }
      case 'rename':
        return { affected: 1, entity: map.entities([s.userRenameEntity(req.id, req.name)])[0] }
      case 'pin':
      case 'unpin':
        return { affected: s.userSetPinned(req.ids, req.op === 'pin') }
      case 'approve':
        return { affected: s.userApprove(req.target, req.ids) }
      case 'invalidate':
        return { affected: s.userInvalidate(req.target, req.ids, req.reason) }
      case 'restore':
        return { affected: s.userRestore(req.target, req.ids) }
      case 'toGlobal':
        return { affected: s.userToGlobal(req.ids) }
      case 'merge':
        return { affected: req.sourceIds.length, entity: map.entities([s.userMerge(req.sourceIds, req.targetId)])[0] }
    }
  })
}

export function registerMemoryHandlers(h: Hive): void {
  const redact = (t: string) => h.vault.redact(t)
  const after = <T>(v: T): T => {
    h.memory?.flush()
    return v
  }
  /** The company a v1-shaped vault edit lands in: the request's, else Personal. */
  const companyOf = (q: { companyId?: string | null } | undefined) => q?.companyId ?? PERSONAL_COMPANY_ID
  handle('memory:overview', (q) => overview(h, q?.companyId ?? undefined))
  handle('memory:graph', (q) => (isPassportGraphRequest(q) ? wrap(() => graphOp(rt(h), q)) : graphQuery(svc(h).store, q, redact, companyRepoIds(h, q.companyId))))
  handle('memory:entity', ({ id }) => {
    const d = entityDetail(svc(h).store, id, redact)
    if (!d) throw new HiveError('not_found', 'Memory entity not found')
    return d
  })
  handle('memory:search', (q) => searchPage(svc(h).store, q, redact, companyRepoIds(h, q.companyId)))
  handle('memory:facts', (q) => factsQuery(svc(h).store, q, redact, companyRepoIds(h, q.companyId)))
  handle('memory:mutate', async (req) => {
    const m = svc(h)
    if (m.vaultMode()) return wrapAsync(() => vaultMutate(m.passport(), companyOf(req), req))
    return after(mutate(m, req, redact))
  })
  handle('memory:delete', async ({ kind, ids, companyId }) => {
    const m = svc(h)
    if (m.vaultMode()) {
      // PASSPORT.md §1.5: delete archives a note and moves lines to History; nothing is removed
      const ops: VaultOp[] = ids.map((id) =>
        kind === 'entity' ? { op: 'archive', note: vaultRef('entity', id) } : { op: 'invalidate', blockId: vaultRef(kind, id), reason: 'deleted by the user' }
      )
      const res = await wrapAsync(() => m.passport().applyOps(companyOf({ companyId }), ops, { kind: 'user' }))
      const bad = res.results.find((r) => r.status === 'error' || r.status === 'conflict')
      if (bad) throw new HiveError('conflict', bad.reason ?? 'Some items could not be archived; reload and try again')
      return
    }
    wrap(() => m.store.userDelete(kind, ids))
    after(undefined)
  })
  handle('memory:revertRun', async ({ runId }) => after(await wrapAsync(() => svc(h).revertRun(runId))))
  // LIVE.md §7: `reads` = memory_search/memory_get calls by the grant's step/session agent tree (hive.db)
  handle('memory:grants', (q) =>
    svc(h)
      .listGrants(q ?? {})
      .map((g) => ({
        ...g,
        runTitle: g.runTitle ? redact(g.runTitle) : g.runTitle,
        reads: h.safe(() => (g.stepId ? h.live.memReads({ stepId: g.stepId }) : g.sessionId ? h.live.memReads({ sessionId: g.sessionId }) : 0), 0)
      }))
  )
  handle('memory:setPaused', ({ paused }) => {
    svc(h).setPaused(paused)
    h.memory?.flush()
    return overview(h)
  })
  handle('memory:export', async ({ scope, companyId }, sender) => {
    const m = svc(h)
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.SaveDialogOptions = {
      title: 'Export Memory',
      defaultPath: `hive-memory-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const lines = exportLines(m.store, scope, redact, companyRepoIds(h, companyId))
    fs.writeFileSync(r.filePath, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 })
    return { path: r.filePath }
  })

  // ---------- Passport vault (PASSPORT.md §11) ----------
  handle('memory:note', (req) => wrapAsync(() => noteOp(rt(h), req, redact)))
  handle('memory:links', (req) => wrap(() => linksOp(rt(h), req, redact)))
  handle('memory:proposals', (req) => wrapAsync(() => proposalsOp(rt(h), req)))
  handle('memory:vault', (req, sender) => wrapAsync(() => vaultOp(h, req, sender)))
}

async function vaultOp(h: Hive, req: PassportVaultRequest, sender: Electron.WebContents): Promise<PassportVaultResults[keyof PassportVaultResults]> {
  if (req.op === 'migrate') {
    // runs when the flag is first turned on, so it does not require vault mode yet (the service keeps the runtime open)
    const report = await svc(h).migrate({ dryRun: req.dryRun })
    if (!report) throw new HiveError('not_implemented', 'The Passport migration is not available in this build yet')
    return report
  }
  const p = rt(h)
  switch (req.op) {
    case 'aiSettings':
    case 'setAi': {
      p.company(req.companyId) // unknown company -> not_found
      const now = new Date()
      if (req.op === 'setAi') {
        if (req.optedIn !== undefined) setLlmOptIn(p.db, req.companyId, req.optedIn, now)
        if (req.dailyCap !== undefined) setLlmDailyCap(p.db, req.companyId, req.dailyCap, now)
      }
      return {
        enabled: h.settings().experimental?.vaultAI === true,
        optedIn: isLlmOptedIn(p.db, req.companyId),
        dailyCap: llmDailyCap(p.db, req.companyId),
        callsToday: llmCallsOn(p.db, req.companyId, now.toISOString().slice(0, 10)),
        activity: llmActivity(p.db, req.companyId)
      }
    }
    case 'status':
      return p.status(req.companyId)
    case 'reindex':
      return p.reindex(req.companyId)
    case 'openInObsidian': {
      const root = p.ensure(req.companyId)
      const target = req.path ? toVaultAbs(root, req.path) : root
      if (app.getApplicationNameForProtocol('obsidian://')) {
        await shell.openExternal(`obsidian://open?path=${encodeURIComponent(target)}`)
        return { opened: 'obsidian', hint: null }
      }
      await shell.openPath(req.path ? path.dirname(target) : root)
      return { opened: 'folder', hint: 'Obsidian is not installed. In Obsidian, choose "Open folder as vault" and pick this folder.' }
    }
    case 'reveal': {
      const root = p.ensure(req.companyId)
      if (req.path) shell.showItemInFolder(toVaultAbs(root, req.path))
      else await shell.openPath(root)
      return
    }
    case 'setPath': {
      let target: string | null
      if ('pick' in req) {
        const win = BrowserWindow.fromWebContents(sender)
        const opts: Electron.OpenDialogOptions = { title: 'Use a folder as this company\u2019s Passport', properties: ['openDirectory', 'createDirectory'] }
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (r.canceled || !r.filePaths[0]) return null
        target = r.filePaths[0]
      } else target = req.path
      return p.setPath(req.companyId, target)
    }
  }
}
