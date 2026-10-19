import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { Repo } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import type { Hive } from '../hive'
import { emit, handle } from '../ipc'

export function addRepoPaths(h: Hive, paths: string[]): { all: Repo[]; created: Repo[] } {
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
  if (created.length) {
    emit('data:changed', { domain: 'repos' })
    h.tray?.update()
  }
  const live = (id: string) => h.sessions.liveCountForRepo(id)
  const fresh = (r: Repo) => h.store.getRepo(r.id, live) ?? r
  return { all: all.map(fresh), created: created.map(fresh) }
}

export function registerRepoHandlers(h: Hive): void {
  const live = (id: string) => h.sessions.liveCountForRepo(id)
  handle('repos:list', () => h.store.listRepos(live))
  handle('repos:pick', async (_req, sender) => {
    const win = BrowserWindow.fromWebContents(sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Add Repository',
      buttonLabel: 'Add',
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return []
    return addRepoPaths(h, r.filePaths).created
  })
  handle('repos:add', ({ paths }) => addRepoPaths(h, paths).all)
  handle('repos:update', ({ id, name }) => {
    h.store.renameRepo(id, name)
    emit('data:changed', { domain: 'repos' })
    return h.store.getRepo(id, live)!
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
