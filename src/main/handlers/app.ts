import { app, BrowserWindow, clipboard, dialog, Menu, safeStorage, shell, type MenuItemConstructorOptions } from 'electron'
import type { AppInfo, CanvasSnapshot, HomeData, Id } from '../../shared/types'
import type { AgentNode as LiveAgentNode } from '../../shared/live'
import type { NativeMenuItem } from '../../shared/ipc'
import { HiveError } from '../../shared/errors'
import { isWebLink } from '../../shared/externalLinks'
import type { Hive } from '../hive'
import { emit, handle, onSend } from '../ipc'
import { loginEnvState } from '../loginEnv'
import { isInsideAny } from '../pathGuard'
import { dashboard, markSeen } from '../live/dashboard'

const DAY = 86400_000

export function registerAppHandlers(h: Hive): void {
  handle('app:info', (): AppInfo => ({
    name: 'Principia',
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    userDataDir: h.paths.userData,
    artifactsDir: h.paths.artifactsRoot,
    scratchDir: h.paths.scratchDir,
    logsDir: h.paths.logsDir,
    dbPath: h.paths.dbPath,
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    loginShellPath: loginEnvState().loginPath
  }))
  handle('app:status', () => h.status())
  handle('app:home', (): HomeData => {
    const since = new Date(Date.now() - DAY).toISOString()
    return {
      status: h.status(),
      runningSessions: h.store.listSessions('running').filter((s) => h.sessions.isLive(s.id)),
      activeRuns: h.store.listRuns({ status: ['queued', 'running'], limit: 200 }),
      recentRuns: h.store.endedRunsSince(since, 50),
      nextFires: h.settings().schedulesPaused ? [] : h.safe(() => h.engine.scheduler.nextRuns(5), [])
    }
  })
  handle('app:canvas', (): CanvasSnapshot => {
    const since = new Date(Date.now() - DAY).toISOString()
    const active = h.store.listRuns({ status: ['queued', 'running'], limit: 40 })
    const ended = h.store.endedRunsSince(since, 40)
    const runIds = [...new Set([...active, ...ended].map((r) => r.id))].slice(0, 40)
    const runs = runIds.map((id) => h.store.getRunDetail(id)).filter((d) => d !== null)
    const schedules = h.store.listSchedules().filter((s) => s.enabled)
    const wfIds = new Set<Id>()
    for (const d of runs) if (d.run.workflowId) wfIds.add(d.run.workflowId)
    for (const s of schedules) if (s.target.kind === 'workflow') wfIds.add(s.target.workflowId)
    const sessions = h.store.listSessions('all', since)
    // LIVE.md §10: live trees + the trees of the included runs and sessions (<= 400)
    const agentMap = new Map<Id, LiveAgentNode>()
    for (const a of h.safe(() => h.live.liveTrees(400), [])) agentMap.set(a.id, a)
    for (const a of h.safe(() => h.live.treesFor({ runIds: runs.map((d) => d.run.id), sessionIds: sessions.map((x) => x.id) }, 400), [])) {
      if (agentMap.size >= 400) break
      agentMap.set(a.id, a)
    }
    return {
      sessions,
      runs,
      schedules,
      workflows: [...wfIds].map((id) => h.store.getWorkflow(id)).filter((w) => w !== null),
      profiles: h.store.listProfiles(),
      repos: h.store.listRepos((id) => h.sessions.liveCountForRepo(id)),
      agents: [...agentMap.values()]
    }
  })
  // LIVE.md §8: "since you were last here"
  handle('app:dashboard', (req) =>
    dashboard(
      {
        store: h.store,
        live: h.live,
        status: () => h.status(),
        nextRuns: (n) => (h.settings().schedulesPaused ? [] : h.safe(() => h.engine.scheduler.nextRuns(n), [])),
        factsSince: h.memory ? (since, n) => h.memory!.factsSince(since, n) : undefined
      },
      req ?? undefined
    )
  )
  handle('app:markSeen', () => markSeen(h.store))
  handle('app:quit', () => {
    app.quit() // before-quit -> Hive.requestQuit (native confirm when something runs)
  })
  handle('app:hideWindow', () => h.windows.hide())
  handle('app:openExternal', async ({ url }) => {
    if (!isWebLink(url)) throw new HiveError('forbidden', 'Only http:// and https:// links can be opened')
    await shell.openExternal(url)
  })
  handle('app:showItemInFolder', ({ path: p }) => {
    const roots = [h.paths.userData, ...h.store.listRepos().map((r) => r.path)]
    if (!isInsideAny(p, roots)) throw new HiveError('forbidden', 'Path is outside your repositories and Hive data')
    shell.showItemInFolder(p)
  })

  // settings
  handle('settings:get', () => h.readSettings())
  handle('settings:update', (patch) => h.updateSettings(patch))

  // native UI helpers
  handle('ui:contextMenu', ({ items }, sender) => {
    const win = BrowserWindow.fromWebContents(sender) ?? undefined
    return new Promise<string | null>((resolve) => {
      let done = false
      const finish = (v: string | null) => {
        if (done) return
        done = true
        resolve(v)
      }
      const toTemplate = (i: NativeMenuItem): MenuItemConstructorOptions =>
        i.type === 'separator'
          ? { type: 'separator' }
          : {
              label: i.label ?? '',
              type: i.type === 'checkbox' ? 'checkbox' : 'normal',
              checked: i.checked,
              enabled: i.enabled ?? true,
              accelerator: i.accelerator,
              registerAccelerator: false,
              click: i.id ? () => finish(i.id!) : undefined,
              submenu: i.submenu ? i.submenu.map(toTemplate) : undefined
            }
      const menu = Menu.buildFromTemplate((items as NativeMenuItem[]).map(toTemplate))
      // the close callback can fire before the click handler; give the click a moment to land
      menu.popup({ window: win, callback: () => setTimeout(() => finish(null), 50) })
    })
  })
  handle('ui:confirm', async (req, sender) => {
    const key = req.suppressKey ? `confirm_suppress:${req.suppressKey}` : null
    if (key && h.store.getMeta(key)) return true
    const win = BrowserWindow.fromWebContents(sender)
    const opts = {
      type: (req.destructive ? 'warning' : 'question') as 'warning' | 'question',
      message: req.message,
      detail: req.detail,
      buttons: [req.confirmLabel, 'Cancel'],
      defaultId: req.destructive ? 1 : 0,
      cancelId: 1,
      checkboxLabel: key ? "Don't ask again" : undefined,
      checkboxChecked: false
    }
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    const ok = r.response === 0
    if (ok && key && r.checkboxChecked) h.store.setMeta(key, new Date().toISOString())
    return ok
  })
  handle('ui:setEdited', ({ edited }) => h.windows.setEdited(edited))
  handle('clipboard:writeText', ({ text }) => clipboard.writeText(text))

  onSend('ui:ready', () => {
    h.windows.markReady()
    const w = h.windows.get()
    if (w) emit('window:state', { focused: w.isFocused(), fullscreen: w.isFullScreen() })
  })
}
