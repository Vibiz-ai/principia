/**
 * Open Passport export / import channels (open-passport SPEC.md; PASSPORT.md "Open Passport"). The v1
 * `principia-passport` JSON channels (company:export / previewImport / import) stay as they are.
 *
 * - company:exportOpenPassport writes the company's `.passport.zip` (notes, departments, taste, manifest, L0/L1 renders).
 * - company:previewOpenPassport reads a passport folder or zip without writing anything.
 * - company:importOpenPassport creates a company from it (profile from the card, departments with their charters, the
 *   notes in a fresh vault) or merges it into an existing company (line-id three-way merge, conflicts to the Inbox).
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { departmentsEnabled } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import type { Id } from '../../shared/types'
import type { OpenPassportExportResult, OpenPassportImportResult, OpenPassportPreview, OpenPassportSyncRequest, OpenPassportSyncResult } from '../../shared/passport'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { incomingDepartments, previewIncoming, profileFromCard, readIncoming, rememberBundle, type ExportDepartment } from '../memory/openPassportIo'
import { PassportSync } from '../memory/openPassportSync'
import { departmentActions, departmentStoreFor } from './company'
import { registerPassportConnectHandlers } from './passportConnect'

const memoryOf = (h: Hive) => {
  if (!h.memory) throw new HiveError('vault_unavailable', 'Company memory is not available')
  return h.memory
}
const boardOn = (h: Hive) => departmentsEnabled(h.settings().experimental)

export function openPassportActions(h: Hive) {
  /** The company's departments and their agent seats, as the export writes them into the department notes. */
  const exportDepartments = (companyId: Id): ExportDepartment[] => {
    if (!boardOn(h)) return []
    const d = departmentStoreFor(h)
    return d.list(companyId).map((dep) => ({
      id: dep.id,
      key: dep.key,
      name: dep.name,
      charter: { does: dep.data.charter.does, doesNot: dep.data.charter.doesNot },
      agents: d.listAgents({ companyId, departmentId: dep.id }).map((a) => ({ name: a.name, capabilities: a.data.capabilities }))
    }))
  }
  /** Departments the passport names, matched to this company's by key (slug) or name; missing ones are created. */
  const departmentIds = (companyId: Id, wanted: ReturnType<typeof incomingDepartments>): { ids: Map<string, string>; created: number } => {
    const ids = new Map<string, string>()
    if (!boardOn(h)) return { ids, created: 0 }
    const existing = departmentStoreFor(h).list(companyId, { includeArchived: true })
    let created = 0
    for (const w of wanted) {
      const hit = existing.find((d) => d.key === w.slug || d.name.trim().toLowerCase() === w.name.trim().toLowerCase())
      if (hit) {
        ids.set(w.slug, hit.id)
        continue
      }
      const dep = departmentActions(h).save({ companyId, key: w.slug, name: w.name.slice(0, 80), data: { charter: { does: w.does, doesNot: w.doesNot } } })
      ids.set(w.slug, dep.id)
      created++
    }
    return { ids, created }
  }
  /** Sync with a configured host (off until the user sets one); `fetch` is injectable for tests. */
  const syncer = (userData: string, fetchImpl?: typeof fetch) =>
    new PassportSync({
      userData,
      fetch: fetchImpl,
      exportZip: (companyId) => {
        const r = memoryOf(h).passport().exportOpenPassport(companyId, exportDepartments(companyId))
        return { zip: r.zip, manifest: r.manifest }
      },
      merge: (companyId, inc, baseDigest) => memoryOf(h).passport().mergeOpenPassport(companyId, inc, departmentIds(companyId, incomingDepartments(inc.model)).ids, { baseDigest }),
      remember: (companyId, inc) => rememberBundle(memoryOf(h).passport().ensure(companyId), inc)
    })
  return {
    async sync(q: OpenPassportSyncRequest, userData: string, fetchImpl?: typeof fetch): Promise<OpenPassportSyncResult> {
      h.company.passport(q.companyId)
      const s = syncer(userData, fetchImpl)
      if (q.op === 'get') return { config: s.view(q.companyId) }
      if (q.op === 'sync') memoryOf(h).openPassport()
      try {
        if (q.op === 'set') return { config: s.configure(q.companyId, { url: q.url, passportId: q.passportId, token: q.token }) }
        if (q.op === 'clear') return { config: s.configure(q.companyId, null) }
        const sync = await s.sync(q.companyId)
        return { config: s.view(q.companyId), sync }
      } catch (e) {
        throw new HiveError('bad_request', e instanceof Error ? e.message : String(e))
      }
    },
    export(companyId: Id): { result: Omit<OpenPassportExportResult, 'path'>; zip: Uint8Array } {
      const mem = memoryOf(h)
      mem.openPassport()
      const r = mem.passport().exportOpenPassport(companyId, exportDepartments(companyId))
      return { result: { revision: r.manifest.revision, digest: r.manifest.digest, tokens: { l0: r.manifest.tokens.l0, l1Max: r.manifest.tokens.l1_max } }, zip: r.zip }
    },
    preview(source: string): OpenPassportPreview {
      try {
        return previewIncoming(readIncoming(source))
      } catch (e) {
        throw new HiveError('bad_request', `Not a readable passport: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    async import(q: { source: string; mode: 'new' | 'merge'; companyId?: Id; repoIds?: Id[] }): Promise<OpenPassportImportResult> {
      const mem = memoryOf(h)
      mem.openPassport()
      const inc = readIncoming(q.source)
      if (inc.errors.length) throw new HiveError('bad_request', `This passport cannot be imported: ${inc.errors.slice(0, 3).join('; ')}`)
      const wanted = incomingDepartments(inc.model)
      if (q.mode === 'new') {
        const company = h.company.savePassport({ name: inc.model.name.slice(0, 120) || 'Imported company', ...profileFromCard(inc.model), repoIds: q.repoIds ?? [] })
        const deps = departmentIds(company.id, wanted)
        const notes = mem.passport().importOpenPassport(company.id, inc, deps.ids)
        return { companyId: company.id, mode: 'new', notes, departmentsCreated: deps.created, conflicts: 0, based: false }
      }
      const companyId = q.companyId!
      h.company.passport(companyId)
      const deps = departmentIds(companyId, wanted)
      const r = await mem.passport().mergeOpenPassport(companyId, inc, deps.ids)
      return { companyId, mode: 'merge', notes: r.updated + r.created, departmentsCreated: deps.created, conflicts: r.conflicts, based: r.based }
    }
  }
}

export function registerOpenPassportHandlers(h: Hive): void {
  const a = openPassportActions(h)
  handle('company:exportOpenPassport', async ({ id }, sender) => {
    const c = h.company.passport(id)
    memoryOf(h).openPassport()
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.SaveDialogOptions = {
      title: 'Export Open Passport',
      defaultPath: path.join(app.getPath('documents'), `${(c.slug || c.name).replace(/[/\\:*?"<>|]+/g, '-').trim() || 'company'}.passport.zip`),
      filters: [{ name: 'Open Passport', extensions: ['zip'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    // built after the dialog, so a cancelled export never counts as a revision
    const { result, zip } = a.export(id)
    fs.writeFileSync(r.filePath, zip)
    return { ...result, path: r.filePath }
  })
  handle('company:previewOpenPassport', async (q, sender) => {
    let source = q?.source
    if (!source) {
      const win = BrowserWindow.fromWebContents(sender)
      const opts: Electron.OpenDialogOptions = {
        title: 'Import Open Passport',
        message: 'Choose a .passport.zip or a passport folder',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: 'Open Passport', extensions: ['zip'] }]
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      source = r.filePaths[0]
    }
    return a.preview(source)
  })
  handle('company:openPassportSync', async (q) => {
    const out = await a.sync(q, app.getPath('userData'))
    if (q.op === 'sync') emit('data:changed', { domain: 'company' })
    return out
  })
  registerPassportConnectHandlers(h, app.getPath('userData'))
  handle('company:importOpenPassport', async (q) => {
    const out = await a.import(q)
    emit('data:changed', { domain: 'company' })
    emit('data:changed', { domain: 'departments' })
    if (q.mode === 'new' && q.repoIds?.length) emit('data:changed', { domain: 'repos' })
    return out
  })
}
