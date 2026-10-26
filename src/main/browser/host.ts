/**
 * BROWSER.md §2: one embedded browser per company. Each company's tabs are WebContentsViews on its own session
 * (persist:company-<id>): sandboxed, context-isolated, no preload, no Node. The debugger (CDP over
 * webContents.debugger, never a remote-debugging port) is attached to these views only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { session as electronSession, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { BrowserActivity, BrowserBounds, BrowserDownload, BrowserNavAction, BrowserShot, BrowserState, BrowserTabView } from '../../shared/browser'
import { BrowserError, CdpDriver, type CdpTransport } from './driver'
import { handleDownload } from './downloads'
import { checkUrl, partitionFor, permissionAllowed, type UrlVerdict } from './policy'
import type { CompanyBrowser, ShotResult } from './tools'

export interface HostLog {
  info(m: string, meta?: Record<string, unknown>): void
  warn(m: string, meta?: Record<string, unknown>): void
}

export interface HostOptions {
  window(): BrowserWindow | null
  /** the company's folder (screenshots, snapshots, downloads go under it) */
  workspaceDir(companyId: string): string
  /** Principia's own origins: never reachable from the company browser */
  blockedOrigins(): string[]
  emit(state: BrowserState): void
  confirm(message: string, detail: string): Promise<boolean>
  log: HostLog
}

interface Tab {
  id: string
  view: WebContentsView
  driver: CdpDriver
  listeners: Set<(m: string, p: Record<string, unknown>) => void>
  ready: Promise<void>
  dead: boolean
}

interface Company {
  id: string
  session: Session
  tabs: Tab[]
  active: string | null
  takeover: boolean
  activity: BrowserActivity | null
  activityTimer: NodeJS.Timeout | null
  shots: BrowserShot[]
  downloads: BrowserDownload[]
  notes: string[]
  /** where the panel shows the view (null = hidden) */
  bounds: BrowserBounds | null
  /** the page size agents work with while the panel is closed */
  size: { width: number; height: number }
  seq: number
  emitTimer: NodeJS.Timeout | null
}

const DEFAULT_SIZE = { width: 1180, height: 820 }
const MAX_TABS = 12
const MAX_SHOTS = 24
const ACTIVITY_MS = 6_000

export class BrowserHost {
  private companies = new Map<string, Company>()
  private configured = new WeakSet<Session>()
  private addedTo = new WeakMap<WebContentsView, BrowserWindow>()

  constructor(private readonly o: HostOptions) {}

  private guard = { blockedOrigins: () => this.o.blockedOrigins() }
  check(url: string): UrlVerdict {
    return checkUrl(url, this.guard)
  }

  has(companyId: string): boolean {
    return this.companies.has(companyId)
  }

  private company(companyId: string): Company {
    let c = this.companies.get(companyId)
    if (c) return c
    const ses = electronSession.fromPartition(partitionFor(companyId))
    c = {
      id: companyId,
      session: ses,
      tabs: [],
      active: null,
      takeover: false,
      activity: null,
      activityTimer: null,
      shots: [],
      downloads: [],
      notes: [],
      bounds: null,
      size: { ...DEFAULT_SIZE },
      seq: 0,
      emitTimer: null
    }
    this.companies.set(companyId, c)
    this.configure(c)
    return c
  }

  /** Once per session: permissions denied by default, Principia's origins and file:// blocked, downloads routed. */
  private configure(c: Company): void {
    const ses = c.session
    if (this.configured.has(ses)) return
    this.configured.add(ses)
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permissionAllowed(permission)))
    ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission))
    ses.setDevicePermissionHandler(() => false)
    ses.webRequest.onBeforeRequest((details, cb) => {
      const v = checkUrl(details.url, this.guard, details.resourceType === 'mainFrame' || details.resourceType === 'subFrame' ? 'navigation' : 'request')
      if (!v.ok) this.o.log.warn('browser: request blocked', { companyId: c.id, url: details.url.slice(0, 200) })
      cb({ cancel: !v.ok })
    })
    // a plain Chrome user agent: sites that refuse "Electron" still work
    try {
      ses.setUserAgent(ses.getUserAgent().replace(/\s+Electron\/\S+/i, '').replace(/\s+principia\/\S+/i, '').replace(/\s+hive\/\S+/i, ''))
    } catch {
      /* keep the default */
    }
    ses.on('will-download', (_e, item) => {
      const dir = path.join(this.o.workspaceDir(c.id), 'Downloads')
      handleDownload(item, {
        dir,
        confirm: (name) => this.o.confirm(`Download ${name}?`, 'This file can run programs on your Mac. An agent or a page in the company browser started it. Only say yes if you expected it.'),
        update: (d) => {
          const i = c.downloads.findIndex((x) => x.id === d.id)
          if (i >= 0) c.downloads[i] = d
          else c.downloads.unshift(d)
          c.downloads = c.downloads.slice(0, 10)
          this.changed(c)
        },
        note: (t) => c.notes.push(t)
      })
    })
  }

  // ---------- tabs ----------

  private newTab(c: Company, url?: string): Tab {
    if (c.tabs.length >= MAX_TABS) throw new BrowserError(`At most ${MAX_TABS} tabs; close one first (browser_tabs {action: "close"}).`)
    const view = new WebContentsView({
      webPreferences: {
        session: c.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        backgroundThrottling: false,
        safeDialogs: true
      }
    })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    const listeners = new Set<(m: string, p: Record<string, unknown>) => void>()
    const transport: CdpTransport = {
      send: (m, p) => wc.debugger.sendCommand(m, p ?? {}),
      onEvent: (fn) => {
        listeners.add(fn)
        return () => void listeners.delete(fn)
      }
    }
    const tab: Tab = { id: `t${++c.seq}`, view, driver: new CdpDriver(transport), listeners, ready: Promise.resolve(), dead: false }
    this.wire(c, tab, wc)
    // a command sent before the first navigation can hang: load about:blank, attach once it has loaded
    tab.ready = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5_000)
      wc.once('did-finish-load', () => {
        clearTimeout(t)
        resolve()
      })
      void wc.loadURL('about:blank').catch(() => undefined)
    })
      .then(() => this.kick(c, tab))
      .then(() => this.attach(tab))
    c.tabs.push(tab)
    c.active = tab.id
    this.layout(c)
    if (url) void tab.ready.then(() => tab.driver.navigate(url)).catch((e) => this.o.log.warn('browser: open failed', { error: String(e) }))
    this.changed(c)
    return tab
  }

  private wire(c: Company, tab: Tab, wc: WebContents): void {
    // a new window (target=_blank, window.open) becomes a tab in the panel
    wc.setWindowOpenHandler(({ url }) => {
      const v = this.check(url)
      if (v.ok && url !== 'about:blank') {
        try {
          this.newTab(c, v.url)
        } catch (e) {
          this.o.log.warn('browser: new tab refused', { error: String(e) })
        }
      }
      return { action: 'deny' }
    })
    const guardNav = (e: { preventDefault(): void }, url: string): void => {
      if (!this.check(url).ok) e.preventDefault()
    }
    wc.on('will-navigate', (e) => guardNav(e, e.url))
    wc.on('will-redirect', (e) => guardNav(e, e.url))
    wc.on('will-frame-navigate', (e) => guardNav(e, e.url))
    wc.on('will-attach-webview', (e) => e.preventDefault())
    // DevTools on a panel view would detach our debugger
    wc.on('devtools-opened', () => wc.closeDevTools())
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) wc.on(ev as 'did-start-loading', () => this.changed(c))
    wc.on('render-process-gone', (_e, d) => {
      this.o.log.warn('browser: page crashed', { companyId: c.id, reason: d.reason })
      tab.driver.reset()
      this.changed(c)
    })
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      if (sessionId) return
      for (const fn of tab.listeners) fn(method, params as Record<string, unknown>)
    })
    wc.debugger.on('detach', (_e, reason) => {
      this.o.log.info('browser: debugger detached', { companyId: c.id, tab: tab.id, reason })
      tab.driver.reset()
    })
  }

  private async attach(tab: Tab): Promise<void> {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) throw new BrowserError('That tab is closed.')
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3')
      } catch (e) {
        throw new BrowserError(`Could not control this tab: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await tab.driver.init()
  }

  private activeTab(c: Company): Tab | null {
    return c.tabs.find((t) => t.id === c.active) ?? c.tabs[c.tabs.length - 1] ?? null
  }

  async ensureTab(companyId: string): Promise<Tab> {
    const c = this.company(companyId)
    let tab = this.activeTab(c)
    if (!tab) tab = this.newTab(c)
    await tab.ready
    if (tab.view.webContents.isCrashed()) tab.view.webContents.reload()
    await this.attach(tab)
    await this.ensureSize(c, tab)
    return tab
  }

  /**
   * A view that has never overlapped the window keeps a 0x0 page: agents then see nothing to click and screenshots
   * hang. Chromium sizes it once it overlaps the window for a frame, so a parked view is moved to overlap the window's
   * top-left corner pixel (masked by the rounded corner) until the page has a size, then parked again.
   */
  private async kick(c: Company, tab: Tab): Promise<void> {
    const wc = tab.view.webContents
    if (tab.dead || wc.isDestroyed()) return
    const b = this.boundsFor(c, tab)
    if (b.x >= 0) return // on screen: it already has a size
    const sized = async (): Promise<boolean> => {
      const v = await Promise.race([wc.executeJavaScript('[innerWidth, innerHeight]', false).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 300))])
      return Array.isArray(v) && v[0] > 1 && v[1] > 1
    }
    if (await sized()) return
    tab.view.setBounds({ x: 1 - b.width, y: 1 - b.height, width: b.width, height: b.height })
    try {
      for (let i = 0; i < 30 && !tab.dead && !wc.isDestroyed(); i++) {
        await new Promise((r) => setTimeout(r, 30))
        if (await sized()) break
      }
    } finally {
      if (!tab.dead && !wc.isDestroyed()) tab.view.setBounds(this.boundsFor(c, tab))
    }
  }

  /** Before an agent acts: the page has a real size (a short check; a hung page is left to the command timeout). */
  private async ensureSize(c: Company, tab: Tab): Promise<void> {
    const vp = await Promise.race([tab.driver.viewport().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1_500))])
    if (!vp || (vp.width > 1 && vp.height > 1)) return
    this.o.log.info('browser: page had no size, sizing it', { companyId: c.id, tab: tab.id })
    await this.kick(c, tab)
  }

  openTab(companyId: string, url?: string): Tab {
    return this.newTab(this.company(companyId), url)
  }

  selectTab(companyId: string, tabId: string): void {
    const c = this.company(companyId)
    if (!c.tabs.some((t) => t.id === tabId)) throw new BrowserError(`No tab ${tabId}.`)
    c.active = tabId
    this.layout(c)
    this.changed(c)
  }

  closeTab(companyId: string, tabId: string): void {
    const c = this.company(companyId)
    const tab = c.tabs.find((t) => t.id === tabId)
    if (!tab) throw new BrowserError(`No tab ${tabId}.`)
    this.destroyTab(tab)
    c.tabs = c.tabs.filter((t) => t !== tab)
    if (c.active === tabId) c.active = c.tabs[c.tabs.length - 1]?.id ?? null
    this.layout(c)
    this.changed(c)
  }

  private destroyTab(tab: Tab): void {
    tab.dead = true
    tab.driver.dispose()
    const wc = tab.view.webContents
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      /* already gone */
    }
    const win = this.addedTo.get(tab.view)
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
    } catch {
      /* window gone */
    }
    try {
      if (!wc.isDestroyed()) wc.close()
    } catch {
      /* closed */
    }
  }

  async nav(companyId: string, action: BrowserNavAction): Promise<void> {
    const c = this.company(companyId)
    const tab = this.activeTab(c)
    if (!tab) throw new BrowserError('No page is open.')
    const h = tab.view.webContents.navigationHistory
    if (action === 'back') {
      if (!h.canGoBack()) throw new BrowserError('There is no page to go back to.')
      h.goBack()
    } else if (action === 'forward') {
      if (!h.canGoForward()) throw new BrowserError('There is no page to go forward to.')
      h.goForward()
    } else if (action === 'reload') tab.view.webContents.reload()
    else tab.view.webContents.stop()
  }

  /** The founder typed an address in the panel. */
  async navigate(companyId: string, url: string): Promise<void> {
    const v = this.check(url)
    if (!v.ok) throw new BrowserError(v.reason)
    const c = this.company(companyId)
    const tab = this.activeTab(c) ?? this.newTab(c)
    await tab.ready
    await tab.view.webContents.loadURL(v.url).catch((e) => {
      if (!/ERR_ABORTED/.test(String(e))) throw new BrowserError(`Could not open ${v.url}: ${String(e).split('\n')[0]}`)
    })
  }

  // ---------- layout ----------

  /** The panel's live-view rectangle (CSS pixels of the window), or null when the panel is closed. */
  setBounds(companyId: string, bounds: BrowserBounds | null): void {
    const c = this.company(companyId)
    c.bounds = bounds && bounds.width >= 40 && bounds.height >= 40 ? bounds : null
    if (c.bounds) c.size = { width: Math.round(c.bounds.width), height: Math.round(c.bounds.height) }
    // one company's view on screen at a time
    if (c.bounds) for (const other of this.companies.values()) if (other !== c && other.bounds) {
      other.bounds = null
      this.layout(other)
    }
    this.layout(c)
  }

  private layout(c: Company): void {
    const win = this.o.window()
    if (!win || win.isDestroyed()) return
    for (const tab of c.tabs) {
      if (tab.dead) continue
      if (this.addedTo.get(tab.view) !== win) {
        win.contentView.addChildView(tab.view)
        this.addedTo.set(tab.view, win)
      }
      tab.view.setBounds(this.boundsFor(c, tab))
      tab.view.setVisible(true)
    }
  }

  /**
   * Where a tab's view sits. A view the panel does not show is parked outside the window, still "visible": a hidden
   * view stops rendering, and then clicks are dropped (no hit-test frame) and screenshots fail. It keeps the panel's
   * size so pages lay out the same for agents.
   */
  private boundsFor(c: Company, tab: Tab): { x: number; y: number; width: number; height: number } {
    const b = c.bounds
    if (b && tab.id === c.active) return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
    return { x: -c.size.width - 200, y: 0, width: c.size.width, height: c.size.height }
  }

  // ---------- agent-facing helpers ----------

  setTakeover(companyId: string, on: boolean): void {
    const c = this.company(companyId)
    c.takeover = on
    this.changed(c)
  }

  takeover(companyId: string): boolean {
    return this.companies.get(companyId)?.takeover === true
  }

  setActivity(companyId: string, a: BrowserActivity): void {
    const c = this.company(companyId)
    c.activity = a
    if (c.activityTimer) clearTimeout(c.activityTimer)
    c.activityTimer = setTimeout(() => {
      c.activity = null
      c.activityTimer = null
      this.changed(c)
    }, ACTIVITY_MS)
    this.changed(c)
  }

  private browserDir(companyId: string, sub: string): string {
    const dir = path.join(this.o.workspaceDir(companyId), 'Browser', sub)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  async screenshot(companyId: string, o: { box?: { x: number; y: number; width: number; height: number } | null; fullPage?: boolean; agent: string | null }): Promise<ShotResult> {
    const c = this.company(companyId)
    const tab = await this.ensureTab(companyId)
    const wc = tab.view.webContents
    let png: Buffer
    let cssWidth: number
    if (o.fullPage) {
      const m = await tab.driver.send('Page.getLayoutMetrics')
      const size = m?.cssContentSize ?? m?.contentSize ?? { width: c.size.width, height: c.size.height }
      const width = Math.min(Math.ceil(size.width), 4000)
      const height = Math.min(Math.ceil(size.height), 12_000)
      const r = await tab.driver.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })
      png = Buffer.from(String(r?.data ?? ''), 'base64')
      cssWidth = width
    } else {
      const { nativeImage: ni } = await import('electron')
      let got = await wc.capturePage(undefined, { stayHidden: true }).catch(() => null)
      // right after a resize or a click the compositor may not have a frame yet: give it a moment
      for (let i = 0; i < 6 && (!got || got.isEmpty()); i++) {
        await new Promise((r) => setTimeout(r, 120))
        got = await wc.capturePage(undefined, { stayHidden: true }).catch(() => null)
      }
      if (!got || got.isEmpty()) {
        // still no frame: ask the page itself (CDP) for one, briefly (it waits for a frame that may never come)
        const r = await Promise.race([tab.driver.send('Page.captureScreenshot', { format: 'png' }).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 4_000))])
        got = r?.data ? ni.createFromBuffer(Buffer.from(String(r.data), 'base64')) : null
      }
      if (!got || got.isEmpty()) throw new BrowserError('The page has nothing on screen yet. Wait for it to load and try again.')
      let img = got
      const vp = await tab.driver.viewport().catch(() => ({ width: img.getSize().width, height: img.getSize().height }))
      const scale = img.getSize().width / Math.max(1, vp.width)
      cssWidth = vp.width
      if (o.box) {
        const sz = img.getSize()
        const x = Math.max(0, Math.floor(o.box.x * scale))
        const y = Math.max(0, Math.floor(o.box.y * scale))
        const w = Math.min(sz.width - x, Math.ceil(o.box.width * scale))
        const h = Math.min(sz.height - y, Math.ceil(o.box.height * scale))
        if (w > 2 && h > 2) {
          img = img.crop({ x, y, width: w, height: h })
          cssWidth = Math.ceil(o.box.width)
        }
      }
      png = img.toPNG()
    }
    const { nativeImage } = await import('electron')
    const img = nativeImage.createFromBuffer(png)
    if (img.isEmpty()) throw new BrowserError('The screenshot came back empty.')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(this.browserDir(companyId, 'screenshots'), `shot-${stamp}.png`)
    fs.writeFileSync(file, png)
    // the agent's copy: CSS-pixel size (no retina doubling), JPEG
    const w = Math.max(1, Math.min(Math.round(cssWidth), 1600))
    const forAgent = img.getSize().width > w ? img.resize({ width: w, quality: 'good' }) : img
    const thumb = img.resize({ width: 240, quality: 'good' })
    const shot: BrowserShot = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, path: file, at: new Date().toISOString(), agent: o.agent, thumb: `data:image/jpeg;base64,${thumb.toJPEG(70).toString('base64')}`, url: wc.getURL() }
    c.shots = [shot, ...c.shots].slice(0, MAX_SHOTS)
    this.changed(c)
    return { path: file, jpegBase64: forAgent.toJPEG(80).toString('base64') }
  }

  writeSnapshot(companyId: string, text: string): string {
    const dir = this.browserDir(companyId, 'snapshots')
    const file = path.join(dir, `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
    fs.writeFileSync(file, `${text}\n`)
    // keep the last 30
    try {
      const all = fs.readdirSync(dir).filter((f) => f.startsWith('snapshot-')).sort()
      for (const f of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(dir, f), { force: true })
    } catch {
      /* best effort */
    }
    return file
  }

  shotPath(companyId: string, id: string): string | null {
    return this.companies.get(companyId)?.shots.find((s) => s.id === id)?.path ?? null
  }

  takeNotes(companyId: string): string[] {
    const c = this.companies.get(companyId)
    return c ? c.notes.splice(0) : []
  }

  /** The tools' view of one company's browser. */
  forCompany(companyId: string): CompanyBrowser {
    return {
      takeover: () => this.takeover(companyId),
      driver: async () => {
        const tab = await this.ensureTab(companyId)
        return { tabId: tab.id, driver: tab.driver }
      },
      openTab: async (url) => {
        const tab = this.openTab(companyId, undefined)
        await tab.ready
        await this.attach(tab)
        if (url) await tab.driver.navigate(url)
        return tab.id
      },
      selectTab: (id) => this.selectTab(companyId, id),
      closeTab: (id) => this.closeTab(companyId, id),
      tabs: () => this.state(companyId).tabs,
      activeTabId: () => this.state(companyId).activeTabId,
      nav: (a) => this.nav(companyId, a),
      checkUrl: (u) => this.check(u),
      screenshot: (o) => this.screenshot(companyId, o),
      writeSnapshot: (t) => this.writeSnapshot(companyId, t),
      takeDownloadNotes: () => this.takeNotes(companyId)
    }
  }

  // ---------- state ----------

  state(companyId: string): BrowserState {
    const c = this.companies.get(companyId)
    if (!c) return { companyId, tabs: [], activeTabId: null, takeover: false, activity: null, shots: [], downloads: [] }
    const tabs: BrowserTabView[] = c.tabs
      .filter((t) => !t.dead && !t.view.webContents.isDestroyed())
      .map((t) => {
        const wc = t.view.webContents
        const url = wc.getURL()
        return { id: t.id, url: url === 'about:blank' ? '' : url, title: wc.getTitle() === 'about:blank' ? 'New tab' : wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }
      })
    return { companyId, tabs, activeTabId: c.active, takeover: c.takeover, activity: c.activity, shots: c.shots, downloads: c.downloads }
  }

  private changed(c: Company): void {
    if (c.emitTimer) return
    c.emitTimer = setTimeout(() => {
      c.emitTimer = null
      try {
        this.o.emit(this.state(c.id))
      } catch (e) {
        this.o.log.warn('browser: emit failed', { error: String(e) })
      }
    }, 80)
  }

  /** Forget the company's cookies, storage and cache; close its tabs. */
  async clear(companyId: string): Promise<void> {
    const c = this.company(companyId)
    for (const t of c.tabs) this.destroyTab(t)
    c.tabs = []
    c.active = null
    await c.session.clearStorageData()
    await c.session.clearCache()
    this.changed(c)
  }

  /** The window was recreated: re-add the views to it. */
  relayout(): void {
    for (const c of this.companies.values()) this.layout(c)
  }

  dispose(): void {
    for (const c of this.companies.values()) {
      for (const t of c.tabs) this.destroyTab(t)
      c.tabs = []
      if (c.activityTimer) clearTimeout(c.activityTimer)
      if (c.emitTimer) clearTimeout(c.emitTimer)
    }
  }
}
