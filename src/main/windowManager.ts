/** Main window lifecycle: hiddenInset chrome, close = hide, bounds persistence, window:state, ui:command queue. */
import path from 'node:path'
import { app, BrowserWindow, screen, shell, type Rectangle } from 'electron'
import type { UiCommand } from '../shared/ipc'
import { isWebLink } from '../shared/externalLinks'
import { formatDeepLink, isDeepLinkUrl, parseDeepLink } from '../shared/deepLink'
import { log } from './log'

/** Renderer crash recovery: reload after a crash, but stop after this many within the window (a crash loop). */
const MAX_RELOADS = 3
const RELOAD_WINDOW_MS = 5 * 60_000

export interface WindowHooks {
  loadBounds(): Rectangle | null
  saveBounds(b: Rectangle): void
  onState(state: { focused: boolean; fullscreen: boolean }): void
  onFocus(): void
  sendCommand(cmd: UiCommand): void
  onReadyToShow?(win: BrowserWindow): void
}

export class WindowManager {
  win: BrowserWindow | null = null
  quitting = false
  private rendererReady = false
  private queue: UiCommand[] = []
  private boundsTimer: NodeJS.Timeout | null = null
  private reloads: number[] = []

  constructor(private hooks: WindowHooks) {}

  /** Per-process memory (MB) for crash logs: a renderer near the V8 heap limit points at a leak. */
  private memorySnapshot(): Record<string, unknown> {
    try {
      return { processes: app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.memory.workingSetSize / 1024)}MB`) }
    } catch {
      return {}
    }
  }

  get(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }
  isFocused(): boolean {
    const w = this.get()
    return !!w && w.isVisible() && w.isFocused()
  }

  create(showWhenReady: boolean): BrowserWindow {
    const saved = this.validBounds(this.hooks.loadBounds())
    const win = new BrowserWindow({
      width: saved?.width ?? 1360,
      height: saved?.height ?? 860,
      x: saved?.x,
      y: saved?.y,
      minWidth: 1100,
      minHeight: 700,
      show: false,
      title: 'Principia',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: '#1e1f22',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        webviewTag: false,
        navigateOnDragDrop: false
      }
    })
    this.win = win
    this.rendererReady = false
    win.once('ready-to-show', () => {
      if (showWhenReady) win.show()
      this.hooks.onReadyToShow?.(win)
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebLink(url)) void shell.openExternal(url)
      // a principia:// anchor the UI did not handle itself: navigate in place (never a new window, never the OS)
      else if (isDeepLinkUrl(url)) this.openLink(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (url === win.webContents.getURL()) return
      e.preventDefault()
      if (isDeepLinkUrl(url)) this.openLink(url)
    })
    win.webContents.on('will-attach-webview', (e) => e.preventDefault())
    win.webContents.on('did-start-loading', () => {
      this.rendererReady = false
    })
    // The window's content process died (OOM, GPU/renderer crash, killed): the window stays as an empty frame.
    // Sessions and runs live in main, so reloading the UI loses nothing; log why and bring it back.
    win.webContents.on('render-process-gone', (_e, details) => {
      this.rendererReady = false
      log.error('renderer gone', { reason: details.reason, exitCode: details.exitCode, ...this.memorySnapshot() })
      if (details.reason === 'clean-exit' || this.quitting) return
      const now = Date.now()
      this.reloads = [...this.reloads.filter((t) => now - t < RELOAD_WINDOW_MS), now]
      if (this.reloads.length > MAX_RELOADS) {
        log.error('renderer keeps crashing; not reloading again', { reloads: this.reloads.length })
        return
      }
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload()
      }, 500)
    })
    win.webContents.on('unresponsive', () => log.warn('renderer unresponsive', this.memorySnapshot()))
    win.webContents.on('responsive', () => log.info('renderer responsive again'))
    // uncaught errors in the UI (React render errors, rejected promises) land in main.log
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error') log.warn('renderer error', { message: e.message.slice(0, 2000), source: `${e.sourceId}:${e.lineNumber}` })
    })
    // Close button / Cmd+Shift+W hides; the app keeps running in the menu bar (SPEC §5).
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      this.hide()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
      this.rendererReady = false
    })
    const state = () => this.hooks.onState({ focused: win.isFocused(), fullscreen: win.isFullScreen() })
    win.on('focus', () => {
      this.hooks.onFocus()
      state()
    })
    win.on('blur', state)
    win.on('enter-full-screen', state)
    win.on('leave-full-screen', state)
    const saveBounds = () => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer)
      this.boundsTimer = setTimeout(() => {
        if (!win.isDestroyed() && !win.isFullScreen() && !win.isMinimized()) this.hooks.saveBounds(win.getNormalBounds())
      }, 400)
    }
    win.on('resize', saveBounds)
    win.on('move', saveBounds)

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL) // electron-vite dev server (npm run dev only, HMR)
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
    return win
  }

  private validBounds(b: Rectangle | null): Rectangle | null {
    if (!b || b.width < 600 || b.height < 400) return null
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 50 && b.y < a.y + a.height - 100
    })
    return visible ? b : { ...b, x: undefined as unknown as number, y: undefined as unknown as number }
  }

  show(): BrowserWindow {
    const win = this.get() ?? this.create(true)
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    app.focus({ steal: true })
    return win
  }

  hide(): void {
    const win = this.get()
    if (!win) return
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide())
      win.setFullScreen(false)
    } else win.hide()
  }

  /** The renderer mounted its listeners (ui:ready) and the window still exists. */
  isRendererReady(): boolean {
    return this.rendererReady && !!this.get()
  }

  /** Renderer mounted its listeners: flush queued commands. */
  markReady(): void {
    this.rendererReady = true
    const q = this.queue
    this.queue = []
    for (const c of q) this.hooks.sendCommand(c)
  }

  /** A principia:// link clicked inside the window: checked, then navigated by the renderer. Unknown links do nothing. */
  private openLink(raw: string): void {
    const link = parseDeepLink(raw)
    if (link) this.command({ kind: 'openLink', url: formatDeepLink(link) })
  }

  /** Show the window and deliver a command (queued until the renderer says ui:ready). */
  command(cmd: UiCommand, show = true): void {
    if (show) this.show()
    if (this.rendererReady && this.get()) this.hooks.sendCommand(cmd)
    else this.queue.push(cmd)
  }

  setEdited(edited: boolean): void {
    this.get()?.setDocumentEdited(edited)
  }
}
