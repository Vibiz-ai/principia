import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState } from '@shared/browser'

// The dock store, driven the way main drives it: browser:changed events while a chat is on screen.
let emit: (s: BrowserState) => void = () => undefined
vi.mock('../lib/hive', () => ({
  hive: {
    browser: { state: () => new Promise(() => undefined) },
    on: (_e: string, cb: (s: BrowserState) => void) => {
      emit = cb
      return () => undefined
    }
  }
}))
vi.mock('./store', () => ({ activeCompany: () => 'co_a', scopeCompanyId: () => 'co_a', getState: () => ({ companies: [] }), toast: () => undefined }))

const state = (sessionKey: string | null, scope = 'pane:1'): BrowserState => ({
  companyId: 'co_a',
  scope,
  tabs: [],
  activeTabId: null,
  takeover: false,
  activity: sessionKey ? { agent: 'Claude', doing: 'Opening example.com', at: '2026-01-01T00:00:00Z', sessionKey } : null,
  shots: [],
  downloads: []
})

type Dock = typeof import('./browser')
let dock: Dock
beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1600 })
  // the founder has not typed for a long while
  vi.spyOn(performance, 'now').mockReturnValue(1e9)
  dock = await import('./browser')
  dock.wireBrowser()
  dock.setPageCompany('co_a', 'pane:1')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser dock: closing it beside a browsing chat sticks', () => {
  it('opens once by itself, and stays closed after the founder closes it', () => {
    emit(state('pane:1'))
    expect(dock.getDock().open).toBe(true)
    dock.closeBrowser()
    emit(state('pane:1'))
    expect(dock.getDock().open).toBe(false)
  })
  it('stays closed when the panel was already open beside the chat as its agent started browsing', () => {
    dock.openBrowser({ companyId: 'co_a', scope: 'pane:1' })
    emit(state('pane:1'))
    dock.closeBrowser()
    emit(state('pane:1'))
    expect(dock.getDock().open).toBe(false)
  })
  it('stays closed when the founder closes it on a chat already browsing', () => {
    dock.openBrowser({ companyId: 'co_a', scope: 'pane:1' })
    // the browsing reached the panel without an event (loaded with the chat's state)
    dock.setBrowserState(state('pane:1'))
    dock.closeBrowser()
    emit(state('pane:1'))
    expect(dock.getDock().open).toBe(false)
  })
  it('still opens by itself for a chat whose agent was not browsing when the founder closed the panel', () => {
    dock.openBrowser({ companyId: 'co_a', scope: 'pane:1' })
    dock.closeBrowser()
    emit(state('pane:1'))
    expect(dock.getDock().open).toBe(true)
  })
  it('a close beside one chat does not keep the panel shut for another chat', () => {
    dock.openBrowser({ companyId: 'co_a', scope: 'pane:1' })
    emit(state('pane:1'))
    dock.closeBrowser()
    dock.setPageCompany('co_a', 'pane:2')
    emit(state('pane:2', 'pane:2'))
    expect(dock.getDock()).toMatchObject({ open: true, scope: 'pane:2' })
  })
})
