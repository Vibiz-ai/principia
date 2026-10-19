/** memory:* IPC handlers (CONTRACT §11.5, PO10). Every string that may hold agent text is vault-redacted. */
import fs from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import type { MemoryMutation, MemoryMutationResult, MemoryOverview } from '../../shared/memory'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { handle } from '../ipc'
import { MemoryRefusal, RowMapper } from '../memory/store'
import type { MemoryService } from '../memory/service'
import { entityDetail, exportLines, factsQuery, graphQuery, overviewCore, searchPage } from '../memory/search'

function svc(h: Hive): MemoryService {
  if (!h.memory) throw new HiveError('internal', 'Memory is unavailable (memory.db could not be opened; see logs)')
  return h.memory
}

/** Store refusals -> HiveError codes the renderer understands. */
function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof MemoryRefusal) {
      const code = e.code === 'refused' ? 'conflict' : e.code
      throw new HiveError(code, e.message.replace(/^Refused: /, ''))
    }
    throw e
  }
}

export function overview(h: Hive): MemoryOverview {
  const m = svc(h)
  const core = overviewCore(m.store)
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
    defaultRepoId: repos[0]?.repoId ?? h.settings().lastRepoId ?? null,
    lastSeq: core.lastSeq,
    dbPath: m.paths.dbPath,
    dbBytes
  }
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
  handle('memory:overview', () => overview(h))
  handle('memory:graph', (q) => graphQuery(svc(h).store, q, redact))
  handle('memory:entity', ({ id }) => {
    const d = entityDetail(svc(h).store, id, redact)
    if (!d) throw new HiveError('not_found', 'Memory entity not found')
    return d
  })
  handle('memory:search', (q) => searchPage(svc(h).store, q, redact))
  handle('memory:facts', (q) => factsQuery(svc(h).store, q, redact))
  handle('memory:mutate', (req) => after(mutate(svc(h), req, redact)))
  handle('memory:delete', ({ kind, ids }) => {
    wrap(() => svc(h).store.userDelete(kind, ids))
    after(undefined)
  })
  handle('memory:revertRun', ({ runId }) => after(wrap(() => svc(h).store.revertRun(runId))))
  // LIVE.md §7: `reads` = memory_search/memory_get calls by the grant's step/session agent tree (hive.db)
  handle('memory:grants', (q) =>
    svc(h)
      .store.listGrants(q ?? {})
      .map((g) => ({
        ...g,
        runTitle: g.runTitle ? redact(g.runTitle) : g.runTitle,
        reads: h.safe(() => (g.stepId ? h.live.memReads({ stepId: g.stepId }) : g.sessionId ? h.live.memReads({ sessionId: g.sessionId }) : 0), 0)
      }))
  )
  handle('memory:setPaused', ({ paused }) => {
    svc(h).store.setPaused(paused)
    h.memory?.flush()
    return overview(h)
  })
  handle('memory:export', async ({ scope }, sender) => {
    const m = svc(h)
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.SaveDialogOptions = {
      title: 'Export Memory',
      defaultPath: `hive-memory-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const lines = exportLines(m.store, scope, redact)
    fs.writeFileSync(r.filePath, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 })
    return { path: r.filePath }
  })
}
