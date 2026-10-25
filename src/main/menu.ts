/** App menu (DESIGN §3.13 / SPEC §5). Items route to ui:command or to main-owned actions. */
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { UiCommand, View } from '../shared/ipc'

export interface MenuActions {
  ui(cmd: UiCommand): void
  hideWindow(): void
  importWorkflow(): void
  togglePause(): void
  paused(): boolean
  dataDir: string
  logsDir: string
}

export function buildAppMenu(a: MenuActions): void {
  const nav = (label: string, view: View, key: string): MenuItemConstructorOptions => ({
    label,
    accelerator: `CmdOrCtrl+${key}`,
    click: () => a.ui({ kind: 'navigate', view })
  })
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Principia',
      submenu: [
        { role: 'about', label: 'About Principia' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => a.ui({ kind: 'openSettings' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Principia' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Principia' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => a.ui({ kind: 'newSession' }) },
        { label: 'New Chat', accelerator: 'Alt+CmdOrCtrl+N', click: () => a.ui({ kind: 'newChat' }) },
        { label: 'New Workflow', accelerator: 'Shift+CmdOrCtrl+N', click: () => a.ui({ kind: 'newWorkflow' }) },
        { type: 'separator' },
        { label: 'Add Repository…', accelerator: 'CmdOrCtrl+O', click: () => a.ui({ kind: 'addRepo' }) },
        { label: 'Import Workflow…', click: () => a.importWorkflow() },
        { type: 'separator' },
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: () => a.ui({ kind: 'closeSession' }) },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: () => a.hideWindow() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        // five doors: the same labels and ⌘1-⌘5 as the sidebar (renderer lib/nav PRIMARY)
        nav('Home', 'home', '1'),
        nav('Team', 'team', '2'),
        nav('Board', 'board', '3'),
        nav('Chats', 'chats', '4'),
        nav('Knowledge', 'knowledge', '5'),
        { label: 'Live Chats', accelerator: 'Shift+CmdOrCtrl+A', click: () => a.ui({ kind: 'navigate', view: 'agents' }) },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => a.ui({ kind: 'toggleSidebar' }) },
        { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => a.ui({ kind: 'commandPalette' }) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => a.ui({ kind: 'zoom', dir: 'in' }) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => a.ui({ kind: 'zoom', dir: 'out' }) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => a.ui({ kind: 'zoom', dir: 'reset' }) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Go',
      submenu: [
        // LIVE.md §6: oldest open ask anywhere
        { label: 'Next Needs You', accelerator: 'CmdOrCtrl+J', click: () => a.ui({ kind: 'nextNeedsYou' }) }
      ]
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Pause All Schedules', type: 'checkbox', checked: a.paused(), click: () => a.togglePause() }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Show Data Folder', click: () => void shell.openPath(a.dataDir) },
        { label: 'Show Logs', click: () => void shell.openPath(a.logsDir) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
