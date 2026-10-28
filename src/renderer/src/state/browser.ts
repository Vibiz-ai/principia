/**
 * BROWSER.md §6: the browser dock (open, width, which company and which chat's tabs) and each chat's browser state
 * from main. The panel shows the tabs of the chat or task on screen; a page that is no chat or task shows the
 * founder's own tabs.
 */
import { useSyncExternalStore } from 'react'
import { browserStateKey, FOUNDER_SCOPE, type BrowserScope, type BrowserState } from '@shared/browser'
import { hive } from '../lib/hive'
import { autoOpen, clampDockWidth, DOCK_DEFAULT, TYPING_QUIET_MS } from '../lib/browserDock'
import { activeCompany, getState as appState, scopeCompanyId, toast } from './store'

interface DockState {
  open: boolean
  companyId: string | null
  /** whose tabs the panel shows: the chat or task on screen, else the founder's own */
  scope: BrowserScope
  width: number
  /** by browserStateKey(company, scope) */
  states: Record<string, BrowserState>
  /** an address to open once the panel has mounted */
  pendingUrl: string | null
  /** the company of the page on screen, when the page names one (a session, an agent's page) */
  pageCompany: string | null
  /** the chat or task on screen, when the page is one */
  pageScope: BrowserScope | null
}

const WIDTH_KEY = 'principia.browser.width'
const readWidth = (): number => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || DOCK_DEFAULT
  } catch {
    return DOCK_DEFAULT
  }
}

let st: DockState = { open: false, companyId: null, scope: FOUNDER_SCOPE, width: DOCK_DEFAULT, states: {}, pendingUrl: null, pageCompany: null, pageScope: null }
const listeners = new Set<() => void>()
const set = (p: Partial<DockState>): void => {
  st = { ...st, ...p }
  for (const l of listeners) l()
}
export const getDock = (): DockState => st
export function useDock<T>(sel: (s: DockState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => sel(st),
    () => sel(st)
  )
}

/** The company the panel shows when nothing names one: the company on screen, else the first one. */
function defaultCompany(): string | null {
  return scopeCompanyId() ?? appState().companies.find((c) => !c.archivedAt)?.id ?? null
}

/** The state the panel shows for one company and chat. */
export const stateOf = (s: DockState, companyId: string | null | undefined, scope: BrowserScope): BrowserState | undefined => (companyId ? s.states[browserStateKey(companyId, scope)] : undefined)

const loadState = (companyId: string, scope: BrowserScope): void => void hive.browser.state({ companyId, scope }).then((s) => setBrowserState(s), () => undefined)

export function openBrowser(o: { companyId?: string | null; scope?: BrowserScope | null; url?: string | null } = {}): void {
  const companyId = o.companyId ?? st.companyId ?? defaultCompany()
  if (!companyId) {
    toast('Open a company first: each company has its own browser.', 'error')
    return
  }
  const scope = o.scope ?? st.pageScope ?? FOUNDER_SCOPE
  set({ open: true, companyId, scope, pendingUrl: o.url ?? null })
  loadState(companyId, scope)
}
/**
 * The open panel always shows the browser of the company on screen (the page's company when the page names one, else
 * the company picked in the rail) and the tabs of the chat or task on screen. Never another company's browser under
 * this company's name, never another chat's tabs beside this chat.
 */
export function followPage(companyId: string | null | undefined, scope: BrowserScope | null): void {
  const target = scope ?? FOUNDER_SCOPE
  const company = companyId ?? st.companyId
  if (!company || (company === st.companyId && target === st.scope)) return
  set({ companyId: company, scope: target, pendingUrl: null })
  loadState(company, target)
}
/** A page that belongs to one company (and maybe one chat or task) says so while it is on screen (null when it unmounts). */
export function setPageCompany(companyId: string | null, scope: BrowserScope | null = null): void {
  if (st.pageCompany === companyId && st.pageScope === scope) return
  set({ pageCompany: companyId, pageScope: scope })
  // the founder opened a chat whose agent is browsing right now: the panel opens beside it
  if (companyId && scope) {
    const latest = st.states[browserStateKey(companyId, scope)]
    if (latest?.activity) consider(latest)
  }
}
export function closeBrowser(): void {
  set({ open: false })
}
export function toggleBrowser(): void {
  if (st.open) closeBrowser()
  else openBrowser({ companyId: defaultCompany() })
}
export function setDockWidth(w: number): void {
  const width = clampDockWidth(w, window.innerWidth)
  set({ width })
  try {
    localStorage.setItem(WIDTH_KEY, String(width))
  } catch {
    /* per-viewer convenience only */
  }
}
export function takePendingUrl(): string | null {
  const u = st.pendingUrl
  if (u) set({ pendingUrl: null })
  return u
}
export function setBrowserState(s: BrowserState): void {
  set({ states: { ...st.states, [browserStateKey(s.companyId, s.scope)]: s } })
}

// ---------- auto-open ----------
const opened = new Set<string>()
let lastTyping = 0
let retry: ReturnType<typeof setTimeout> | null = null

function consider(s: BrowserState): void {
  const a = activeCompany()
  const verdict = autoOpen({ state: s, activeCompany: a === 'all' ? null : a, pageScope: st.pageScope, open: st.open, opened, sinceTyping: performance.now() - lastTyping })
  if (verdict === 'open') {
    opened.add(s.activity!.sessionKey)
    // never takes focus: the panel only appears beside the chat or task that is browsing
    set({ open: true, companyId: s.companyId, scope: s.scope })
  } else if (verdict === 'later' && !retry) {
    retry = setTimeout(() => {
      retry = null
      const latest = st.states[browserStateKey(s.companyId, s.scope)]
      if (latest) consider(latest)
    }, TYPING_QUIET_MS)
  }
}

let wired = false
export function wireBrowser(): () => void {
  if (wired) return () => undefined
  wired = true
  set({ width: readWidth() })
  const onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) lastTyping = performance.now()
  }
  window.addEventListener('keydown', onKey, true)
  const off = hive.on('browser:changed', (s) => {
    setBrowserState(s)
    // the panel opens by itself only beside the chat or task an agent is browsing in, when it is on screen
    if (s.activity) consider(s)
  })
  return () => {
    window.removeEventListener('keydown', onKey, true)
    off()
    wired = false
  }
}
