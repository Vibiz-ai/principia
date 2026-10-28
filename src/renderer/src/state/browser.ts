/**
 * BROWSER.md §6: the browser dock (open, width, which company) and each company's browser state from main.
 */
import { useSyncExternalStore } from 'react'
import type { BrowserState } from '@shared/browser'
import { hive } from '../lib/hive'
import { autoOpen, clampDockWidth, DOCK_DEFAULT, TYPING_QUIET_MS } from '../lib/browserDock'
import { activeCompany, getState as appState, scopeCompanyId, toast } from './store'

interface DockState {
  open: boolean
  companyId: string | null
  width: number
  /** the founder dragged the width (kept as chosen, over the page when it does not fit beside it) */
  picked: boolean
  states: Record<string, BrowserState>
  /** an address to open once the panel has mounted */
  pendingUrl: string | null
  /** the company of the page on screen, when the page names one (a session, an agent's page) */
  pageCompany: string | null
}

const WIDTH_KEY = 'principia.browser.width'
const readWidth = (): Pick<DockState, 'width' | 'picked'> => {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return saved ? { width: saved, picked: true } : { width: DOCK_DEFAULT, picked: false }
  } catch {
    return { width: DOCK_DEFAULT, picked: false }
  }
}

let st: DockState = { open: false, companyId: null, width: DOCK_DEFAULT, picked: false, states: {}, pendingUrl: null, pageCompany: null }
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

export function openBrowser(o: { companyId?: string | null; url?: string | null } = {}): void {
  const companyId = o.companyId ?? st.companyId ?? defaultCompany()
  if (!companyId) {
    toast('Open a company first: each company has its own browser.', 'error')
    return
  }
  set({ open: true, companyId, pendingUrl: o.url ?? null })
  void hive.browser.state({ companyId }).then((s) => setBrowserState(s), () => undefined)
}
/**
 * The open panel always shows the browser of the company on screen: the page's company when the page names one,
 * else the company picked in the rail. Never another company's browser under this company's name.
 */
export function followCompany(companyId: string | null | undefined): void {
  if (!companyId || companyId === st.companyId) return
  set({ companyId, pendingUrl: null })
  void hive.browser.state({ companyId }).then((s) => setBrowserState(s), () => undefined)
}
/** A page that belongs to one company says so while it is on screen (null when it unmounts). */
export function setPageCompany(companyId: string | null): void {
  if (st.pageCompany !== companyId) set({ pageCompany: companyId })
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
  set({ width, picked: true })
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
  set({ states: { ...st.states, [s.companyId]: s } })
}

// ---------- auto-open ----------
const opened = new Set<string>()
let lastTyping = 0
let retry: ReturnType<typeof setTimeout> | null = null

function consider(s: BrowserState): void {
  const a = activeCompany()
  const verdict = autoOpen({ state: s, activeCompany: a === 'all' ? null : a, open: st.open, opened, sinceTyping: performance.now() - lastTyping })
  if (verdict === 'open') {
    opened.add(s.activity!.sessionKey)
    // never takes focus: the panel only appears beside what the founder is doing
    set({ open: true, companyId: s.companyId })
  } else if (verdict === 'later' && !retry) {
    retry = setTimeout(() => {
      retry = null
      const latest = st.states[s.companyId]
      if (latest) consider(latest)
    }, TYPING_QUIET_MS)
  }
}

let wired = false
export function wireBrowser(): () => void {
  if (wired) return () => undefined
  wired = true
  set(readWidth())
  const onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) lastTyping = performance.now()
  }
  window.addEventListener('keydown', onKey, true)
  const off = hive.on('browser:changed', (s) => {
    setBrowserState(s)
    // the panel follows the company an agent is browsing in when it is the one on screen
    if (s.activity) consider(s)
  })
  return () => {
    window.removeEventListener('keydown', onKey, true)
    off()
    wired = false
  }
}
