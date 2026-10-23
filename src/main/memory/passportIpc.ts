/**
 * The Passport IPC operations (PASSPORT.md §11) without Electron: memory:note, memory:graph (ops), memory:links and
 * memory:proposals, plus the non-shell parts of memory:vault. handlers/memory.ts registers them and adds the dialogs
 * and the shell. Every request names its company; the runtime makes sure that company's vault is open first.
 */
import type {
  PassportGraphRequest,
  PassportGraphResults,
  PassportLinksRequest,
  PassportLinksResults,
  PassportNoteRequest,
  PassportNoteResults,
  PassportProposalsRequest,
  PassportProposalsResults,
  VaultApplyResult,
  VaultNoteSummary,
  VaultOp,
  VaultSaveResult
} from '../../shared/passport'
import { setProperty } from '../../shared/vault/patch'
import { saveLayout } from './vault/indexDb'
import { readFileState } from './vault/fsutil'
import { toVaultAbs } from './vault/paths'
import { MemoryRefusal } from './store'
import { screenText } from './screen'
import type { PassportRuntime } from './service'
import { backlinks, globalGraph, localGraph, noteSummary, notesTree, outgoingLinks, unlinkedMentions, vaultGhosts, vaultNoteDetail, vaultTags } from './search'

type Redact = (s: string) => string

const notFound = (m: string): never => {
  throw new MemoryRefusal(m, 'not_found')
}
const conflict = (m: string): never => {
  throw new MemoryRefusal(m, 'conflict')
}

/** The note row for `{ path }` or `{ id }`; a path the index has not seen yet is indexed first (watcher lag). */
function noteRow(rt: PassportRuntime, companyId: string, ref: { path?: string; id?: string }) {
  if (ref.id) return rt.index.noteById(companyId, ref.id)
  if (!ref.path) return null
  let row = rt.index.noteByPath(companyId, ref.path)
  if (!row || row.removed_at) {
    rt.index.indexNote(companyId, ref.path)
    row = rt.index.noteByPath(companyId, ref.path)
  }
  return row
}

function failed(res: VaultApplyResult): string | null {
  const bad = res.results.find((r) => r.status === 'error' || r.status === 'conflict')
  return bad ? (bad.reason ?? bad.status) : null
}

function summaryOrThrow(rt: PassportRuntime, companyId: string, noteId: string | null, redact: Redact): VaultNoteSummary {
  const s = noteId ? noteSummary(rt.db, companyId, noteId, redact) : null
  return s ?? notFound('Note not found')
}

export async function noteOp(rt: PassportRuntime, req: PassportNoteRequest, redact: Redact): Promise<PassportNoteResults[keyof PassportNoteResults]> {
  const companyId = req.companyId
  const root = rt.ensure(companyId)
  switch (req.op) {
    case 'get': {
      const row = noteRow(rt, companyId, req as { path?: string; id?: string })
      if (!row || row.removed_at) return notFound('Note not found')
      const file = readFileState(toVaultAbs(root, row.path))
      if (!file) return notFound(`${row.path} is gone from the vault`)
      rt.index.rememberText(file.text, file.hash)
      const detail = vaultNoteDetail(rt.db, companyId, row.id, redact, { mtimeMs: file.mtimeMs })!
      return { text: file.text, hash: file.hash, detail } satisfies PassportNoteResults['get']
    }
    case 'save': {
      const hit = screenText(rt.fingerprints(), req.text)
      if (hit) throw new MemoryRefusal(`Refused: the note contains a ${hit.label}. Do not store credentials in the Passport.`, 'validation')
      const r = await rt.writer.save(companyId, { path: req.path, baseHash: req.baseHash, text: req.text }, { actor: 'user' })
      if (r.status === 'error') return conflict(r.reason)
      if (r.status === 'conflict') return r satisfies VaultSaveResult
      const row = noteRow(rt, companyId, { path: req.path })
      const detail = row ? vaultNoteDetail(rt.db, companyId, row.id, redact) : null
      if (!detail) return notFound('Note not found after saving')
      return { status: 'saved', hash: r.hash, detail, movedToHistory: r.movedToHistory } satisfies VaultSaveResult
    }
    case 'ops':
      return rt.applyOps(companyId, req.ops, { kind: 'user' })
    case 'create': {
      const op: VaultOp = { op: 'createNote', title: req.title, type: req.type ?? 'note', ...(req.folder ? { folder: req.folder } : {}), ...(req.properties ? { properties: req.properties } : {}) }
      const res = await rt.applyOps(companyId, [op], { kind: 'user' })
      const r = res.results[0]
      if (!r || r.status === 'error' || r.status === 'conflict') return conflict(r?.reason ?? 'The note could not be created')
      return summaryOrThrow(rt, companyId, r.noteId, redact)
    }
    case 'rename': {
      const row = noteRow(rt, companyId, req as { path?: string; id?: string })
      if (!row || row.removed_at) return notFound('Note not found')
      const res = await rt.applyOps(companyId, [{ op: 'rename', note: row.id, newTitle: req.newTitle }], { kind: 'user' })
      const err = failed(res)
      if (err) return conflict(err)
      const r = res.results[0] as (typeof res.results)[number] & { linksRewritten?: number }
      return { note: summaryOrThrow(rt, companyId, r.noteId ?? row.id, redact), linksRewritten: r.linksRewritten ?? 0 }
    }
    case 'archive': {
      const row = noteRow(rt, companyId, req as { path?: string; id?: string })
      if (!row || row.removed_at) return notFound('Note not found')
      if (req.archived !== false) {
        const err = failed(await rt.applyOps(companyId, [{ op: 'archive', note: row.id }], { kind: 'user' }))
        if (err) return conflict(err)
      } else {
        // restore: `status: active` through the editor-save path (the writer reserves `status` for archive)
        const file = readFileState(toVaultAbs(root, row.path))
        if (!file) return notFound(`${row.path} is gone from the vault`)
        const next = setProperty(file.text, 'status', 'active')
        if (next.changed) {
          const r = await rt.writer.save(companyId, { path: row.path, baseHash: file.hash, text: next.text }, { actor: 'user' })
          if (r.status !== 'saved') return conflict(r.status === 'error' ? r.reason : 'The note changed while restoring; try again')
        }
      }
      return summaryOrThrow(rt, companyId, row.id, redact)
    }
  }
}

export function graphOp(rt: PassportRuntime, req: PassportGraphRequest): PassportGraphResults[keyof PassportGraphResults] {
  rt.ensure(req.companyId)
  switch (req.op) {
    case 'global':
      return globalGraph(rt.db, req.companyId, req.filters ?? {})
    case 'local':
      return localGraph(rt.db, req.companyId, req.noteId, req.depth, req.filters ?? {})
    case 'layout':
      return { saved: saveLayout(rt.db, req.companyId, req.positions.map((p) => ({ noteId: p.noteId, x: p.x, y: p.y, pinned: !!p.pinned }))) }
  }
}

export function linksOp(rt: PassportRuntime, req: PassportLinksRequest, redact: Redact): PassportLinksResults[keyof PassportLinksResults] {
  const root = rt.ensure(req.companyId)
  switch (req.op) {
    case 'backlinks':
      return backlinks(rt.db, req.companyId, req.noteId, redact)
    case 'unlinked':
      return unlinkedMentions(rt.db, req.companyId, req.noteId, { root, limit: req.limit, redact })
    case 'outgoing':
      return outgoingLinks(rt.db, req.companyId, req.noteId, redact)
    case 'tags':
      return vaultTags(rt.db, req.companyId)
    case 'ghosts':
      return vaultGhosts(rt.db, req.companyId, req.limit ?? 500)
    case 'tree':
      return notesTree(rt.db, req.companyId, { includeArchived: req.includeArchived })
  }
}

export async function proposalsOp(rt: PassportRuntime, req: PassportProposalsRequest): Promise<PassportProposalsResults[keyof PassportProposalsResults]> {
  switch (req.op) {
    case 'list':
      rt.ensure(req.companyId)
      return rt.listProposals(req.companyId, { status: req.status, kinds: req.kinds, noteId: req.noteId, limit: req.limit })
    case 'accept':
      return rt.acceptProposals(req.companyId, req.ids, { addAlias: req.addAlias })
    case 'reject':
      return rt.rejectProposals(req.companyId, req.ids)
    case 'edit':
      return rt.editProposal(req.companyId, req.id, req.ops, req.accept)
    case 'suggestNow':
      return rt.suggestNow(req.companyId, req.noteId)
  }
}
