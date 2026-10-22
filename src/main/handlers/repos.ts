import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { Id, Repo } from '../../shared/types'
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'
import { requireCompany } from './companyScope'

/**
 * companyId (COMPANY.md §3, "adding a repo (⌘O) assigns it to this company"): newly added repos are assigned to it.
 * A repo that was already in Hive keeps its owner; moving it is company:assignRepo.
 */
export function addRepoPaths(h: Hive, paths: string[], companyId?: Id): { all: Repo[]; created: Repo[] } {
  const target = companyId ? requireCompany(h, companyId) : PERSONAL_COMPANY_ID
  const all: Repo[] = []
  const created: Repo[] = []
  for (const p of paths) {
    let real: string
    try {
      real = fs.realpathSync(p)
      if (!fs.statSync(real).isDirectory()) throw new Error('not a dir')
    } catch {
      throw new HiveError('bad_request', `Not a folder: ${p}`)
    }
    const [repo, isNew] = h.store.addRepo(real)
    all.push(repo)
    if (isNew) created.push(repo)
  }
  if (target !== PERSONAL_COMPANY_ID) for (const r of created) h.company.assignRepo(r.id, target)
  if (created.length) {
    if (target !== PERSONAL_COMPANY_ID) emit('data:changed', { domain: 'company' })
    emit('data:changed', { domain: 'repos' })
    h.tray?.update()
  }
  const live = (id: string) => h.sessions.liveCountForRepo(id)
  const fresh = (r: Repo) => h.store.getRepo(r.id, live) ?? r
  return { all: all.map(fresh), created: created.map(fresh) }
}

export function registerRepoHandlers(h: Hive): void {
  const live = (id: string) => h.sessions.liveCountForRepo(id)
  handle('repos:list', (q) => h.store.listRepos(live, q?.companyId))
  handle('repos:pick', async (q, sender) => {
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Add Repository',
      buttonLabel: 'Add',
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return []
    return addRepoPaths(h, r.filePaths, q?.companyId).created
  })
  handle('repos:add', ({ paths, companyId }) => addRepoPaths(h, paths, companyId).all)
  handle('repos:update', ({ id, name }) => {
    h.store.renameRepo(id, name)
    emit('data:changed', { domain: 'repos' })
    return h.store.getRepo(id, live)!
  })
  handle('repos:move', ({ id, targetId, placement }) => {
    h.store.moveRepo(id, targetId, placement)
    emit('data:changed', { domain: 'repos' })
    return h.store.listRepos(live)
  })
  handle('repos:remove', ({ id }) => {
    h.store.removeRepo(id)
    emit('data:changed', { domain: 'repos' })
    h.tray?.update()
  })
  handle('repos:siblings', ({ id }) => {
    const repo = h.store.getRepo(id)
    if (!repo) throw new HiveError('not_found', 'Repository not found')
    const parent = path.dirname(repo.path)
    const known = new Set(h.store.listRepos().map((r) => r.path))
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ path: path.join(parent, e.name), name: e.name }))
      .filter((d) => !known.has(d.path) && fs.existsSync(path.join(d.path, '.git')))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
  })
}
