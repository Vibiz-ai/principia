/**
 * BROWSER.md §6: when the browser panel opens by itself. Pure (tested): the panel opens once per chat or task run when
 * an agent starts browsing, in the company on screen, and never while the founder is typing.
 */
import type { BrowserState } from '@shared/browser'

export interface AutoOpenInput {
  state: BrowserState
  /** the company on screen; null = All companies */
  activeCompany: string | null
  open: boolean
  /** session keys the panel already opened for */
  opened: ReadonlySet<string>
  /** ms since the founder's last key press in a text field */
  sinceTyping: number
}
export type AutoOpen = 'open' | 'later' | 'no'

export const TYPING_QUIET_MS = 1500

export function autoOpen(i: AutoOpenInput): AutoOpen {
  const a = i.state.activity
  if (!a || i.open) return 'no'
  if (i.opened.has(a.sessionKey)) return 'no'
  if (i.activeCompany && i.activeCompany !== i.state.companyId) return 'no'
  if (i.sinceTyping < TYPING_QUIET_MS) return 'later'
  return 'open'
}

export const DOCK_MIN = 360
export const DOCK_DEFAULT = 560
/** However wide the founder drags the dock, this much of the window stays visible on its left (the rail and a strip of the page). */
export const DOCK_PEEK = 160
export function clampDockWidth(w: number, windowWidth: number): number {
  const max = Math.max(DOCK_MIN, windowWidth - DOCK_PEEK)
  return Math.round(Math.min(max, Math.max(DOCK_MIN, Number.isFinite(w) ? w : DOCK_DEFAULT)))
}

/** The page beside the dock never gets narrower than this: an agent's page has three columns, a chat two. */
export const PAGE_MIN = 880
/** When docked beside the page it would be narrower than this, the dock floats over the page's right side instead. */
export const DOCK_SIDE_MIN = 400

export interface DockLayout {
  /**
   * side: beside the page (the page narrows); tight: beside the page with the sidebar stepping aside while the dock is
   * open; over: on top of the page's right side (the page keeps its width)
   */
  mode: 'side' | 'tight' | 'over'
  width: number
}
/**
 * Where the dock goes. `pageLeft` is where the page starts (after the rail and sidebar), `sidebar` the sidebar's width.
 * The page keeps PAGE_MIN. With the default width (`picked` false) the dock takes what is left beside the page; too
 * little left: the sidebar steps aside; still too little: the dock floats over the page. A width the founder dragged
 * (`picked`) is kept: beside the page when it fits there, otherwise over the page, up to all but DOCK_PEEK of the window.
 */
export function dockLayout(want: number, windowWidth: number, pageLeft: number, sidebar = 0, picked = false): DockLayout {
  const chosen = clampDockWidth(want, windowWidth)
  const room = windowWidth - pageLeft - PAGE_MIN
  const over = (): DockLayout => ({ mode: 'over', width: Math.max(Math.min(chosen, windowWidth - DOCK_PEEK), Math.min(DOCK_MIN, windowWidth)) })
  if (picked) {
    if (room >= DOCK_SIDE_MIN && chosen <= room) return { mode: 'side', width: chosen }
    if (room < DOCK_SIDE_MIN && sidebar > 0 && room + sidebar >= DOCK_SIDE_MIN && chosen <= room + sidebar) return { mode: 'tight', width: chosen }
    return over()
  }
  if (room >= DOCK_SIDE_MIN) return { mode: 'side', width: Math.min(chosen, room) }
  if (sidebar > 0 && room + sidebar >= DOCK_SIDE_MIN) return { mode: 'tight', width: Math.min(chosen, room + sidebar) }
  // over the page: leave a strip of it visible on the left
  const maxOver = Math.max(DOCK_MIN, windowWidth - pageLeft - DOCK_PEEK)
  return { mode: 'over', width: Math.max(Math.min(chosen, maxOver), Math.min(DOCK_MIN, windowWidth)) }
}

/** "Claude is browsing: Clicking “Sign in”" */
export function activityLine(s: BrowserState | null | undefined): string {
  const a = s?.activity
  if (!a) return ''
  return `${a.agent} is browsing: ${a.doing}`
}

/** A rectangle overlaps another (the live view and an open sheet or menu). */
export function overlaps(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}
