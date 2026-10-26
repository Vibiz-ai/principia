/**
 * docs/BROWSER.md: the company browser. One embedded browser per company (its own cookies and storage), shown in a
 * panel on the right, driven by agents through the principia-browser MCP server and by the founder directly.
 * Shared by main, the renderer and the MCP bridge: types, IPC channels, events and the tool definitions.
 */
import type { Id } from './types'

export const BROWSER_SERVER_NAME = 'principia-browser'

export interface BrowserTabView {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** What an agent is doing in the browser right now (cleared a few seconds after its last call). */
export interface BrowserActivity {
  /** "Claude", "Codex", "Ana (Sales)" */
  agent: string
  /** plain words: "Opening example.com", "Clicking “Sign in”" */
  doing: string
  at: string
  /** one chat or task run: the panel opens by itself once per key */
  sessionKey: string
}

export interface BrowserShot {
  id: string
  path: string
  at: string
  agent: string | null
  /** a small JPEG data URL for the gallery strip */
  thumb: string
  url: string
}

export interface BrowserDownload {
  id: string
  name: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'waiting'
  bytes: number
  note?: string
}

export interface BrowserState {
  companyId: Id
  tabs: BrowserTabView[]
  activeTabId: string | null
  /** the founder is driving: agent actions wait until they hand back */
  takeover: boolean
  activity: BrowserActivity | null
  shots: BrowserShot[]
  downloads: BrowserDownload[]
}

export type BrowserNavAction = 'back' | 'forward' | 'reload' | 'stop'
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

type V = void
export interface BrowserInvokeMap {
  'browser:state': [{ companyId: Id }, BrowserState]
  /** where the live view sits in the window (CSS pixels); null hides it */
  'browser:bounds': [{ companyId: Id; bounds: BrowserBounds | null }, V]
  'browser:navigate': [{ companyId: Id; url: string }, BrowserState]
  'browser:nav': [{ companyId: Id; action: BrowserNavAction }, BrowserState]
  'browser:tab': [{ companyId: Id; op: 'new' | 'close' | 'select'; tabId?: string; url?: string }, BrowserState]
  'browser:takeover': [{ companyId: Id; on: boolean }, BrowserState]
  'browser:openShot': [{ companyId: Id; id: string }, V]
  /** forget the company's cookies, storage and cache, and close its tabs */
  'browser:clear': [{ companyId: Id }, BrowserState]
}
export const BROWSER_CHANNELS = [
  'browser:state',
  'browser:bounds',
  'browser:navigate',
  'browser:nav',
  'browser:tab',
  'browser:takeover',
  'browser:openShot',
  'browser:clear'
] as const satisfies readonly (keyof BrowserInvokeMap)[]
export interface BrowserEventMap {
  'browser:changed': BrowserState
}
export const BROWSER_EVENTS = ['browser:changed'] as const satisfies readonly (keyof BrowserEventMap)[]

/** What the address bar turns typed text into: a URL as typed, a bare host (example.com) as https, else a search. */
export function addressToUrl(input: string): string {
  const t = input.trim()
  if (!t) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z0-9.-]+:\d+/i.test(t)) return t
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`
  if (!/\s/.test(t) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`
}

// ---------- the MCP tools ----------

export interface BrowserToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
}

const ref = { type: 'string', description: 'The element ref from the last browser_snapshot, like e12' }
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })

export const BROWSER_TOOL_DEFS = {
  browser_navigate: {
    name: 'browser_navigate',
    description: 'Open a URL in the company browser (the founder sees it in Principia). Returns the page snapshot with element refs.',
    inputSchema: obj({ url: { type: 'string', description: 'http(s) URL, or a bare host like example.com' }, newTab: { type: 'boolean', description: 'open in a new tab' } }, ['url'])
  },
  browser_snapshot: {
    name: 'browser_snapshot',
    description:
      'The page as an accessibility outline: interactive elements first, each with a ref (e12) to pass to browser_click / browser_type. Large pages are written to a file and the path returned. Prefer this to screenshots.',
    inputSchema: obj({ full: { type: 'boolean', description: 'include all text (default: compact)' } }),
    annotations: { readOnlyHint: true }
  },
  browser_click: {
    name: 'browser_click',
    description: 'Click an element by ref. Returns the new snapshot.',
    inputSchema: obj({ ref, element: { type: 'string', description: 'what you are clicking, in plain words (shown to the founder)' }, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, ['ref'])
  },
  browser_hover: {
    name: 'browser_hover',
    description: 'Move the mouse over an element by ref.',
    inputSchema: obj({ ref, element: { type: 'string' } }, ['ref'])
  },
  browser_type: {
    name: 'browser_type',
    description: 'Type text into an input by ref (replaces what is there unless append is true). submit: press Enter after.',
    inputSchema: obj({ ref, text: { type: 'string' }, element: { type: 'string' }, submit: { type: 'boolean' }, append: { type: 'boolean' } }, ['ref', 'text'])
  },
  browser_press: {
    name: 'browser_press',
    description: 'Press a key in the page: Enter, Tab, Escape, ArrowDown, Backspace, a letter, or a chord like Control+a / Meta+a.',
    inputSchema: obj({ key: { type: 'string' } }, ['key'])
  },
  browser_select: {
    name: 'browser_select',
    description: 'Choose option(s) in a <select> by ref, by value or visible label.',
    inputSchema: obj({ ref, values: { type: 'array', items: { type: 'string' } }, element: { type: 'string' } }, ['ref', 'values'])
  },
  browser_scroll: {
    name: 'browser_scroll',
    description: 'Scroll the page (or the element by ref into view).',
    inputSchema: obj({ ref: { type: 'string' }, direction: { type: 'string', enum: ['down', 'up'] }, pages: { type: 'number' } })
  },
  browser_screenshot: {
    name: 'browser_screenshot',
    description: 'A picture of the visible page (or one element by ref). Saved in the company folder and shown to the founder.',
    inputSchema: obj({ ref: { type: 'string' }, fullPage: { type: 'boolean' } }),
    annotations: { readOnlyHint: true }
  },
  browser_back: { name: 'browser_back', description: 'Go back.', inputSchema: obj({}) },
  browser_forward: { name: 'browser_forward', description: 'Go forward.', inputSchema: obj({}) },
  browser_reload: { name: 'browser_reload', description: 'Reload the page.', inputSchema: obj({}) },
  browser_tabs: {
    name: 'browser_tabs',
    description: 'List, open, select or close tabs. Pages that open a new window get a new tab here.',
    inputSchema: obj({ action: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, tabId: { type: 'string' }, url: { type: 'string' } })
  },
  browser_console: {
    name: 'browser_console',
    description: 'Recent console messages and page errors of the current tab.',
    inputSchema: obj({ level: { type: 'string', enum: ['all', 'error', 'warning'] }, limit: { type: 'number' } }),
    annotations: { readOnlyHint: true }
  },
  browser_network: {
    name: 'browser_network',
    description: 'Recent network requests of the current tab (method, status, type, url). failed: only failures and 4xx/5xx.',
    inputSchema: obj({ failed: { type: 'boolean' }, filter: { type: 'string', description: 'substring of the url' }, limit: { type: 'number' } }),
    annotations: { readOnlyHint: true }
  },
  browser_wait: {
    name: 'browser_wait',
    description: 'Wait for the page to load, for a CSS selector or some text to appear (or disappear with gone: true), or for a number of seconds.',
    inputSchema: obj({ for: { type: 'string', enum: ['load', 'selector', 'text', 'time'] }, selector: { type: 'string' }, text: { type: 'string' }, gone: { type: 'boolean' }, seconds: { type: 'number' } })
  }
} as const satisfies Record<string, BrowserToolDef>

export type BrowserTool = keyof typeof BROWSER_TOOL_DEFS
export const BROWSER_TOOLS = Object.keys(BROWSER_TOOL_DEFS) as BrowserTool[]
export const isBrowserTool = (s: unknown): s is BrowserTool => typeof s === 'string' && Object.prototype.hasOwnProperty.call(BROWSER_TOOL_DEFS, s)
/** Tools that only look; they keep working while the founder has taken over. */
export const BROWSER_READ_TOOLS: ReadonlySet<BrowserTool> = new Set<BrowserTool>(['browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network'])

export const BROWSER_INSTRUCTIONS =
  "Principia's company browser: a real browser the founder watches in Principia (on the right of the chat). Start with browser_navigate, read the page with browser_snapshot (refs like e12), act with browser_click / browser_type / browser_press / browser_select, and take browser_screenshot only when seeing the page matters. If the founder has taken over, wait or ask them. Never type passwords, card numbers or one-time codes yourself and never pay or send anything without the founder's yes."

/** One MCP tool result block (text or image), as the HTTP endpoint returns it. */
export type BrowserContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface BrowserToolResult {
  content: BrowserContent[]
  isError?: boolean
}
