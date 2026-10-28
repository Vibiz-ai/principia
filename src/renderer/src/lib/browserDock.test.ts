import { describe, expect, it } from 'vitest'
import type { BrowserState } from '@shared/browser'
import { addressToUrl } from '@shared/browser'
import { formatDeepLink, parseDeepLink } from '@shared/deepLink'
import { activityLine, autoOpen, clampDockWidth, DOCK_PEEK, dockLayout, overlaps, PAGE_MIN } from './browserDock'

const state = (companyId: string, sessionKey: string | null): BrowserState => ({
  companyId,
  tabs: [],
  activeTabId: null,
  takeover: false,
  activity: sessionKey ? { agent: 'Claude', doing: 'Opening example.com', at: '2026-01-01T00:00:00Z', sessionKey } : null,
  shots: [],
  downloads: []
})

describe('autoOpen', () => {
  it('opens once per chat or run when an agent starts browsing in the company on screen', () => {
    expect(autoOpen({ state: state('co_a', 'pane:1'), activeCompany: 'co_a', open: false, opened: new Set(), sinceTyping: 10_000 })).toBe('open')
    expect(autoOpen({ state: state('co_a', 'pane:1'), activeCompany: 'co_a', open: false, opened: new Set(['pane:1']), sinceTyping: 10_000 })).toBe('no')
    expect(autoOpen({ state: state('co_a', 'pane:1'), activeCompany: null, open: false, opened: new Set(), sinceTyping: 10_000 })).toBe('open')
  })
  it('never opens for another company, when already open, or without an agent', () => {
    expect(autoOpen({ state: state('co_b', 'pane:1'), activeCompany: 'co_a', open: false, opened: new Set(), sinceTyping: 10_000 })).toBe('no')
    expect(autoOpen({ state: state('co_a', 'pane:1'), activeCompany: 'co_a', open: true, opened: new Set(), sinceTyping: 10_000 })).toBe('no')
    expect(autoOpen({ state: state('co_a', null), activeCompany: 'co_a', open: false, opened: new Set(), sinceTyping: 10_000 })).toBe('no')
  })
  it('waits while the founder is typing', () => {
    expect(autoOpen({ state: state('co_a', 'pane:1'), activeCompany: 'co_a', open: false, opened: new Set(), sinceTyping: 200 })).toBe('later')
  })
})

describe('dock bits', () => {
  it('clamps the width', () => {
    expect(clampDockWidth(100, 1400)).toBe(360)
    // all but DOCK_PEEK of the window
    expect(clampDockWidth(5000, 1400)).toBe(1240)
    expect(clampDockWidth(5000, 400)).toBe(360)
    expect(clampDockWidth(Number.NaN, 1400)).toBe(560)
  })
  it('says who is browsing', () => {
    expect(activityLine(state('co_a', 'k'))).toBe('Claude is browsing: Opening example.com')
    expect(activityLine(state('co_a', null))).toBe('')
  })
  it('detects an overlay on the live view', () => {
    expect(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true)
    expect(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false)
  })
})

describe('addresses and links', () => {
  it('turns typed text into an address', () => {
    expect(addressToUrl('example.com')).toBe('https://example.com')
    expect(addressToUrl('localhost:8080/form')).toBe('http://localhost:8080/form')
    expect(addressToUrl('https://a.test/x')).toBe('https://a.test/x')
    expect(addressToUrl('best coffee in town')).toBe('https://duckduckgo.com/?q=best%20coffee%20in%20town')
  })
  it('principia://browser opens the browser, optionally on an http(s) page', () => {
    expect(parseDeepLink('principia://browser')).toEqual({ kind: 'browser' })
    expect(parseDeepLink('principia://browser?company=co_acme&url=https%3A%2F%2Fexample.com%2F')).toEqual({ kind: 'browser', url: 'https://example.com/', companyId: 'co_acme' })
    expect(parseDeepLink('principia://browser?url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull()
    expect(parseDeepLink('principia://browser?url=https%3A%2F%2Fuser%3Apw%40example.com')).toBeNull()
    const l = parseDeepLink('principia://browser?url=https%3A%2F%2Fexample.com%2F&company=co_acme')!
    expect(parseDeepLink(formatDeepLink(l))).toEqual(l)
  })
})

describe('dockLayout', () => {
  it('sits beside the page when the page keeps its minimum width', () => {
    expect(dockLayout(560, 1728, 288)).toEqual({ mode: 'side', width: 560 })
    // less room than chosen: the dock narrows, the page keeps PAGE_MIN
    const l = dockLayout(560, 1600, 288)
    expect(l.mode).toBe('side')
    expect(1600 - 288 - l.width).toBe(PAGE_MIN)
  })
  it('lets the sidebar step aside on a smaller window, and floats over the page when even that is not enough', () => {
    // 1360 wide, rail 56 + sidebar 232: without the sidebar 1360 - 56 - 880 = 424 is left
    expect(dockLayout(560, 1360, 288, 232)).toEqual({ mode: 'tight', width: 424 })
    expect(dockLayout(560, 1360, 288)).toEqual({ mode: 'over', width: 560 })
    const tiny = dockLayout(560, 800, 288)
    expect(tiny.mode).toBe('over')
    expect(tiny.width).toBe(360)
  })
  it('keeps a width the founder dragged: beside the page when it fits, over the page when it does not', () => {
    // 1728 wide, rail 56 + sidebar 232: 560 fits beside the page
    expect(dockLayout(500, 1728, 288, 232, true)).toEqual({ mode: 'side', width: 500 })
    expect(dockLayout(560, 1728, 288, 232, true)).toEqual({ mode: 'side', width: 560 })
    // wider than fits beside: no longer stuck at 560, it floats over the page at the dragged width
    expect(dockLayout(561, 1728, 288, 232, true)).toEqual({ mode: 'over', width: 561 })
    expect(dockLayout(1200, 1728, 288, 232, true)).toEqual({ mode: 'over', width: 1200 })
    // as wide as the window allows, leaving DOCK_PEEK of it (the rail and a strip of the page) visible
    expect(dockLayout(5000, 1728, 288, 232, true)).toEqual({ mode: 'over', width: 1728 - DOCK_PEEK })
    expect(dockLayout(5000, 1440, 288, 232, true)).toEqual({ mode: 'over', width: 1440 - DOCK_PEEK })
  })
  it('a dragged width on a small window: the sidebar steps aside when that is enough, over the page when not', () => {
    expect(dockLayout(420, 1360, 288, 232, true)).toEqual({ mode: 'tight', width: 420 })
    expect(dockLayout(900, 1360, 288, 232, true)).toEqual({ mode: 'over', width: 900 })
    expect(dockLayout(5000, 800, 288, 232, true).width).toBe(800 - DOCK_PEEK)
  })
  it('the default width still adapts to the window', () => {
    expect(dockLayout(560, 1600, 288, 232, false)).toEqual({ mode: 'side', width: 1600 - 288 - PAGE_MIN })
  })
})
