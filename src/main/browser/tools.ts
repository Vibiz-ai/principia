/**
 * BROWSER.md §3: the principia-browser tools, run in main against ONE company's browser. The caller's company is
 * decided by its token before this runs (service.ts); nothing here can name another company. No Electron import.
 */
import { addressToUrl, BROWSER_READ_TOOLS, type BrowserNavAction, type BrowserTabView, type BrowserTool, type BrowserToolResult } from '../../shared/browser'
import { BrowserError, type CdpDriver } from './driver'
import { SNAPSHOT_INLINE_MAX } from './snapshot'
import type { UrlVerdict } from './policy'

export interface ShotResult {
  /** where the PNG was saved (the company's folder) */
  path: string
  /** what the agent sees: a JPEG at CSS-pixel size */
  jpegBase64: string
}

/** One company's browser, as the tools see it (host.ts implements it; tests fake it). */
export interface CompanyBrowser {
  takeover(): boolean
  /** the active tab's driver, creating the first tab when there is none */
  driver(): Promise<{ tabId: string; driver: CdpDriver }>
  openTab(url?: string): Promise<string>
  selectTab(tabId: string): void
  closeTab(tabId: string): void
  tabs(): BrowserTabView[]
  activeTabId(): string | null
  nav(action: BrowserNavAction): Promise<void>
  checkUrl(url: string): UrlVerdict
  screenshot(o: { box?: { x: number; y: number; width: number; height: number } | null; fullPage?: boolean; agent: string }): Promise<ShotResult>
  /** writes a big snapshot next to the screenshots; returns its path */
  writeSnapshot(text: string): string
  /** completed downloads the agent has not been told about yet */
  takeDownloadNotes(): string[]
}

export interface Caller {
  agent: string
  sessionKey: string
  activity(doing: string): void
}

const ok = (text: string): BrowserToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): BrowserToolResult => ({ content: [{ type: 'text', text }], isError: true })

export const TAKEOVER_MESSAGE =
  'The founder has taken over the browser and is using it now. Your clicks and typing are paused until they hand it back. Do not end your turn: call browser_wait {for: "time", seconds: 30}, which returns as soon as they hand it back, then try again. Or ask them what they need. browser_snapshot and browser_screenshot still work.'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const quote = (s: string): string => `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`

/** Inline when small; otherwise the start of it plus the file with all of it. */
export function snapshotBlock(b: CompanyBrowser, text: string, max = SNAPSHOT_INLINE_MAX): string {
  if (text.length <= max) return text
  const path = b.writeSnapshot(text)
  const cut = text.lastIndexOf('\n', max)
  return `${text.slice(0, cut > 0 ? cut : max)}\n- … (${text.split('\n').length} lines in all) The full snapshot is in ${path}: read it with your file tools.`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export async function runBrowserTool(b: CompanyBrowser, caller: Caller, tool: BrowserTool, rawArgs: unknown): Promise<BrowserToolResult> {
  const a = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>
  const listOnly = tool === 'browser_tabs' && (!a.action || a.action === 'list')
  const waitOnly = tool === 'browser_wait' && a.for === 'time'
  if (b.takeover() && !BROWSER_READ_TOOLS.has(tool) && !listOnly && !waitOnly) return fail(TAKEOVER_MESSAGE)
  // while the founder drives, a timed wait ends as soon as they hand the browser back
  if (waitOnly && b.takeover()) {
    const ms = Math.min(60, Math.max(1, num(a.seconds) ?? 10)) * 1000
    caller.activity('Waiting for the founder to hand the browser back')
    const end = Date.now() + ms
    while (b.takeover() && Date.now() < end) await new Promise((r) => setTimeout(r, 250))
    return b.takeover()
      ? ok(`The founder is still using the browser after ${Math.round(ms / 1000)} s. Wait again (browser_wait {for: "time", seconds: 30}) or ask them what they need.`)
      : ok('The founder handed the browser back. Take a fresh browser_snapshot: the page may have changed.')
  }
  try {
    const r = await run(b, caller, tool, a)
    const notes = b.takeDownloadNotes()
    if (notes.length && r.content[0]?.type === 'text') r.content[0] = { type: 'text', text: `${r.content[0].text}\n\n${notes.join('\n')}` }
    return r
  } catch (e) {
    if (e instanceof BrowserError) return fail(e.message)
    return fail(`The browser could not do that: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

async function after(b: CompanyBrowser, d: CdpDriver, head: string): Promise<BrowserToolResult> {
  await d.settleAfterAction()
  const s = await d.snapshot()
  return ok(`${head}\n\n${snapshotBlock(b, s.text, 8_000)}`)
}

async function run(b: CompanyBrowser, caller: Caller, tool: BrowserTool, a: Record<string, unknown>): Promise<BrowserToolResult> {
  switch (tool) {
    case 'browser_navigate': {
      const raw = str(a.url).trim()
      if (!raw) return fail('Give a url.')
      const v = b.checkUrl(addressToUrl(raw))
      if (!v.ok) return fail(v.reason)
      caller.activity(`Opening ${hostOf(v.url)}`)
      if (a.newTab === true) await b.openTab(v.url)
      const { driver } = await b.driver()
      if (a.newTab !== true) await driver.navigate(v.url)
      const s = await driver.snapshot()
      return ok(`Opened ${v.url}\n\n${snapshotBlock(b, s.text)}`)
    }
    case 'browser_snapshot': {
      caller.activity('Reading the page')
      const { driver } = await b.driver()
      const s = await driver.snapshot({ full: a.full === true })
      return ok(snapshotBlock(b, s.text))
    }
    case 'browser_click': {
      const { driver } = await b.driver()
      const t = driver.target(str(a.ref))
      const label = str(a.element) || t.name || t.role
      caller.activity(`Clicking ${quote(label)}`)
      const button = a.button === 'right' || a.button === 'middle' ? a.button : 'left'
      await driver.click(str(a.ref), { double: a.double === true, button })
      return after(b, driver, `Clicked ${t.role}${t.name ? ` "${t.name}"` : ''} (${str(a.ref)}).`)
    }
    case 'browser_hover': {
      const { driver } = await b.driver()
      const t = driver.target(str(a.ref))
      caller.activity(`Pointing at ${quote(str(a.element) || t.name || t.role)}`)
      await driver.hover(str(a.ref))
      return ok(`Hovering ${t.role}${t.name ? ` "${t.name}"` : ''} (${str(a.ref)}).`)
    }
    case 'browser_type': {
      const { driver } = await b.driver()
      const t = driver.target(str(a.ref))
      caller.activity(`Typing into ${quote(str(a.element) || t.name || t.role)}`)
      const text = typeof a.text === 'string' ? a.text : String(a.text ?? '')
      await driver.type(str(a.ref), text, { append: a.append === true, submit: a.submit === true })
      const head = `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${t.role}${t.name ? ` "${t.name}"` : ''} (${str(a.ref)})${a.submit === true ? ' and pressed Enter' : ''}.`
      return a.submit === true ? after(b, driver, head) : ok(head)
    }
    case 'browser_press': {
      const key = str(a.key).trim()
      caller.activity(`Pressing ${key}`)
      const { driver } = await b.driver()
      await driver.key(key)
      return after(b, driver, `Pressed ${key}.`)
    }
    case 'browser_select': {
      const { driver } = await b.driver()
      const t = driver.target(str(a.ref))
      const values = Array.isArray(a.values) ? a.values.map(String) : typeof a.values === 'string' ? [a.values] : []
      if (!values.length) return fail('Give values to select.')
      caller.activity(`Choosing ${quote(values.join(', '))} in ${quote(str(a.element) || t.name || 'a list')}`)
      const picked = await driver.select(str(a.ref), values)
      return ok(`Selected ${picked.map((p) => `"${p}"`).join(', ')} in ${t.role}${t.name ? ` "${t.name}"` : ''} (${str(a.ref)}).`)
    }
    case 'browser_scroll': {
      caller.activity('Scrolling')
      const { driver } = await b.driver()
      await driver.scroll({ ref: str(a.ref) || undefined, direction: a.direction === 'up' ? 'up' : 'down', pages: num(a.pages) })
      return ok(a.ref ? `Scrolled ${str(a.ref)} into view.` : `Scrolled ${a.direction === 'up' ? 'up' : 'down'}.`)
    }
    case 'browser_screenshot': {
      caller.activity('Taking a screenshot')
      const { driver } = await b.driver()
      const box = str(a.ref) ? (await driver.point(str(a.ref))).box : null
      const shot = await b.screenshot({ box, fullPage: a.fullPage === true, agent: caller.agent })
      return { content: [{ type: 'text', text: `Screenshot saved to ${shot.path} (the founder sees it in the browser panel).` }, { type: 'image', data: shot.jpegBase64, mimeType: 'image/jpeg' }] }
    }
    case 'browser_back':
    case 'browser_forward':
    case 'browser_reload': {
      const action = tool === 'browser_back' ? 'back' : tool === 'browser_forward' ? 'forward' : 'reload'
      caller.activity(action === 'back' ? 'Going back' : action === 'forward' ? 'Going forward' : 'Reloading')
      const { driver } = await b.driver()
      await b.nav(action)
      await driver.waitForLoad(15_000)
      const s = await driver.snapshot()
      return ok(`${action === 'reload' ? 'Reloaded' : action === 'back' ? 'Went back' : 'Went forward'}.\n\n${snapshotBlock(b, s.text, 8_000)}`)
    }
    case 'browser_tabs': {
      const action = str(a.action) || 'list'
      if (action === 'new') {
        const url = str(a.url).trim()
        let target: string | undefined
        if (url) {
          const v = b.checkUrl(addressToUrl(url))
          if (!v.ok) return fail(v.reason)
          target = v.url
        }
        caller.activity('Opening a new tab')
        await b.openTab(target)
      } else if (action === 'select' || action === 'close') {
        const id = str(a.tabId)
        if (!b.tabs().some((t) => t.id === id)) return fail(`No tab ${id || '(none given)'}. browser_tabs {action: "list"} shows them.`)
        caller.activity(action === 'select' ? 'Switching tabs' : 'Closing a tab')
        if (action === 'select') b.selectTab(id)
        else b.closeTab(id)
      } else if (action !== 'list') return fail('action is list, new, select or close.')
      const tabs = b.tabs()
      const active = b.activeTabId()
      return ok(tabs.length ? tabs.map((t) => `${t.id === active ? '*' : '-'} ${t.id}: ${t.title || '(untitled)'} ${t.url}`).join('\n') : 'No tabs open. browser_navigate opens one.')
    }
    case 'browser_console': {
      const { driver } = await b.driver()
      const level = a.level === 'error' || a.level === 'warning' ? a.level : 'all'
      return ok(driver.consoleText(level, num(a.limit) ?? 50))
    }
    case 'browser_network': {
      const { driver } = await b.driver()
      return ok(driver.networkText({ failed: a.failed === true, filter: str(a.filter) || undefined, limit: num(a.limit) }))
    }
    case 'browser_wait': {
      const kind = a.for === 'selector' || a.for === 'text' || a.for === 'time' ? a.for : 'load'
      caller.activity(kind === 'time' ? 'Waiting' : `Waiting for ${kind === 'load' ? 'the page' : quote(str(a.selector) || str(a.text))}`)
      const { driver } = await b.driver()
      return ok(await driver.waitFor({ for: kind, selector: str(a.selector) || undefined, text: str(a.text) || undefined, gone: a.gone === true, seconds: num(a.seconds) }))
    }
  }
}
