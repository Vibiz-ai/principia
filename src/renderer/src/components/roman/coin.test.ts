import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// the tone fallback reads the store; server markup needs a server snapshot and a window without a bridge
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) })

const { Medallion, workingTiles } = await import('./Medallion')
const { MilestoneCoin, PIXEL_GLYPH_MIN } = await import('./MilestoneCoin')
const { MILESTONE_GLYPHS } = await import('./geometry')
const { badgeTitle, railLaurel, RailCoin, CompanyBadgeMark } = await import('../../shell/CompanyRail')

const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el)
const GLYPHS = ['column', 'scroll', 'quill', 'seal', 'sun', 'laurel', 'dove', 'coin'] as const

/** VOICE.md §5.2: the retired material colours. */
const BANNED = [
  '#b0773a', '#d9a066', '#7a4d22', '#d4a84b', '#8a6a22', '#b5532f', '#e8dfcf', '#f3efe7', '#cdbfa5', '#a8987c',
  '#4a3a28', '#5c5040', '#6b5a44', '#1b1712', '#c08447', '#c56a45',
  // the old aureus and bronze coin stops
  '#f6e2a6', '#7d5e1e', '#e3ac70', '#5e3a17', '#a86f36', '#6e4520', '#f3d39a', '#fbeec4', '#4a2f15', '#6d5420', '#f3e6c8'
]
const MATERIAL = /bronze|gold|terracotta|travertine|marble|copper/i

function expectClean(html: string): void {
  expect(html).not.toMatch(/Gradient/)
  expect(html).not.toMatch(/url\(#/)
  expect(html).not.toMatch(/<ellipse/)
  expect(html).not.toMatch(/drop-shadow|feTurbulence/)
  expect(html).not.toMatch(/--rm-(terracotta|gold|bronze|travertine|marble)/)
  for (const hex of BANNED) expect(html.toLowerCase()).not.toContain(hex)
}

const rectsOf = (html: string, cls: string): string[] => html.match(new RegExp(`<rect[^>]*class="${cls}"[^>]*>`, 'g')) ?? []

describe('Medallion: the engraved coin (VOICE.md §5.6)', () => {
  it('draws three rings, a beaded rim, a white filled initial and one 3-unit company tessera; no metal, no field', () => {
    const html = render(createElement(Medallion, { name: 'Sunday Bakery', color: '#4c9cff' }))
    expectClean(html)
    expect(html).toContain('viewBox="0 0 40 40"')
    expect(html).toContain('r="18.6"')
    expect(html).toContain('r="16.9"')
    expect(html).toContain('stroke-dasharray=".01 2.2"')
    expect(html).toContain('r="15.2"')
    // rings are stroke-only: the only fills are the initial and the tessera
    expect(html.match(/<circle[^>]*fill=/g)).toBeNull()
    expect(html).toMatch(/<text[^>]*font-weight="600"[^>]*font-size="14.5"[^>]*fill="#fff"[^>]*fill-opacity=".92"[^>]*>S<\/text>/)
    const tess = rectsOf(html, 'rm-medallion__tessera')
    expect(tess).toHaveLength(1)
    expect(tess[0]).toContain('width="3"')
    expect(tess[0]).toContain('height="3"')
    expect(tess[0]).toContain('x="18.50"')
    expect(tess[0]).toContain('y="28.20"')
    expect(tess[0]).toContain('fill:#4c9cff')
  })

  it('Personal ("P") is the same coin with no tessera', () => {
    const p = render(createElement(Medallion, { name: 'Personal', initial: 'P', color: '#4c9cff' }))
    expect(rectsOf(p, 'rm-medallion__tessera')).toHaveLength(0)
    expect(p).toContain('>P</text>')
    expectClean(p)
  })

  it('below 24 px (the 18 px menu coin) keeps only the outer ring, the initial and the tessera', () => {
    const small = render(createElement(Medallion, { name: 'Sunday Bakery', color: '#4c9cff', size: 18 }))
    expect(small).toContain('r="18.6"')
    expect(small).not.toContain('r="16.9"')
    expect(small).not.toContain('r="15.2"')
    expect(small).toContain('>S</text>')
    expect(rectsOf(small, 'rm-medallion__tessera')).toHaveLength(1)
    expect(render(createElement(Medallion, { name: 'Sunday Bakery', size: 24 }))).toContain('r="15.2"')
  })

  it('the Portfolio card coin marks Personal as "P" with no tessera, like the rail', () => {
    // the card draws the shared CompanyCoin (logo-aware), which keeps Personal's "P"
    const src = readFileSync(join(__dirname, '../../views/PortfolioView.tsx'), 'utf8')
    expect(src).toMatch(/<CompanyCoin company=\{c\}/)
    const rail = readFileSync(join(__dirname, '../../shell/CompanyRail.tsx'), 'utf8')
    const coin = rail.slice(rail.indexOf('export function CompanyCoin'))
    expect(coin).toMatch(/const personal = isPersonal\(company\)/)
    expect(coin).toMatch(/<Medallion[^>]*initial=\{personal \? 'P' : undefined\}/)
  })

  it('working renders twelve 2-unit blue tiles on r 13.2 with a staggered index, and no ring', () => {
    const html = render(createElement(Medallion, { name: 'Northwind', color: '#3ecf8e', working: true }))
    expectClean(html)
    const tiles = rectsOf(html, 'rm-wk')
    expect(tiles).toHaveLength(12)
    tiles.forEach((tile, i) => {
      expect(tile).toContain('width="2"')
      expect(tile).toContain('height="2"')
      expect(tile).toContain(`--i:${i}`)
      expect(tile).toContain('#4c9cff')
    })
    // matches the voice.html coordinates: first tile at the top, a quarter turn later at the right
    expect(tiles[0]).toContain('x="19.00" y="5.80"')
    expect(tiles[3]).toContain('x="32.20" y="19.00"')
    for (const p of workingTiles(20)) expect(Math.hypot(+p.x + 1 - 20, +p.y + 1 - 20)).toBeCloseTo(13.2, 1)
    expect(html).not.toContain('r="13.2"')
    expect(render(createElement(Medallion, { name: 'Northwind' }))).not.toContain('rm-wk')
  })

  it('the laurel ring grows the SVG to 48 units around the coin but keeps the layout box', () => {
    const html = render(createElement(Medallion, { name: 'Sunday Bakery', color: '#4c9cff', laurel: true, label: 'Sunday Bakery, all agents healthy' }))
    expectClean(html)
    expect(html).toContain('viewBox="0 0 48 48"')
    expect(html).toContain('width:32px;height:32px')
    expect(html).toContain('width="38.40" height="38.40"')
    expect(html).toContain('margin:-3.2px')
    expect(html).toContain('rm-laurel')
    expect(html).toContain('aria-label="Sunday Bakery, all agents healthy"')
    expect(html.match(/aria-label=/g)).toHaveLength(1)
    const at36 = render(createElement(Medallion, { name: 'Acme', size: 36, laurel: true }))
    expect(at36).toContain('width:36px;height:36px')
    expect(at36).toContain('margin:-3.6')
    expect(at36).toContain('aria-label="Acme, all agents healthy"')
  })

  it('failed renders the red square tessera (no round dot) and hides the laurel', () => {
    const html = render(createElement(Medallion, { name: 'Kestrel', color: '#f25c5c', laurel: true, failed: true }))
    expectClean(html)
    expect(html).toContain('class="rm-medallion__fail"')
    expect(html).toContain('rm-medallion--failed')
    expect(html).not.toContain('rm-laurel')
    expect(html).toContain('viewBox="0 0 40 40"')
    expect(html).not.toMatch(/border-radius|rail__failed/)
    expect(html).toContain('aria-label="Kestrel"')
    expect(render(createElement(Medallion, { name: 'Kestrel' }))).not.toContain('rm-medallion__fail')
  })

  it('the failed square is a 6 px square with a 2 px gap in roman.css', () => {
    const css = readFileSync(join(__dirname, '../../styles/roman.css'), 'utf8')
    const rule = css.match(/\.rm-medallion__fail\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/width:\s*6px/)
    expect(rule).toMatch(/height:\s*6px/)
    expect(rule).toMatch(/0 0 0 2px/)
    expect(rule).not.toMatch(/border-radius/)
  })
})

describe('MilestoneCoin: an engraved rim around a pixel glyph (VOICE.md §5.9)', () => {
  it('earned: three rings and the 9 x 9 glyph as 2.4-unit tiles on a 3-unit pitch, white plus one accent', () => {
    for (const glyph of GLYPHS) {
      const html = render(createElement(MilestoneCoin, { glyph, earned: true }))
      expectClean(html)
      expect(html).toContain('rm-coin--earned')
      expect(html).toContain('r="26.5"')
      expect(html).toContain('r="24.6"')
      expect(html).toContain('r="22.8"')
      const lit = MILESTONE_GLYPHS[glyph].join('').replace(/\./g, '').length
      const tiles = html.match(/<rect[^>]*width="2.4"[^>]*>/g) ?? []
      expect(tiles).toHaveLength(lit)
      const accents = tiles.filter((r) => !r.includes('--rm-px-white'))
      expect(accents.length).toBeGreaterThanOrEqual(1)
      expect(accents.every((r) => /--rm-px-(blue|green)/.test(r))).toBe(true)
    }
    // the column's first tile sits where the mockup draws it
    expect(render(createElement(MilestoneCoin, { glyph: 'column', earned: true }))).toContain('x="17.8" y="14.8"')
  })

  it('locked: one dashed ring and empty tile outlines, dim but legible', () => {
    const html = render(createElement(MilestoneCoin, { glyph: 'sun', earned: false, title: 'First week, locked' }))
    expectClean(html)
    expect(html).toContain('rm-coin--locked')
    expect(html).toContain('stroke-dasharray="2 2.6"')
    expect(html).toContain('stroke-opacity="0.38"')
    expect(html).toContain('stroke-opacity="0.32"')
    expect(html).not.toContain('r="24.6"')
    const lit = MILESTONE_GLYPHS.sun.join('').replace(/\./g, '').length
    const outlines = html.match(/<rect[^>]*width="2"[^>]*>/g) ?? []
    expect(outlines).toHaveLength(lit)
    expect(outlines.every((r) => !/fill="(?!none)/.test(r))).toBe(true)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="First week, locked"')
  })

  it('below 40 px (the 28 px toast) the glyph is the stroked line version', () => {
    expect(PIXEL_GLYPH_MIN).toBe(40)
    for (const glyph of GLYPHS) {
      const html = render(createElement(MilestoneCoin, { glyph, earned: true, size: 28 }))
      expectClean(html)
      expect(html).toContain('rm-coin--line')
      expect(html).toContain('translate(28 28) scale(1.15)')
      expect(html).not.toContain('width="2.4"')
      expect(html).toContain('aria-hidden="true"')
    }
  })

  it('carries no material words in its classes or styles', () => {
    for (const glyph of GLYPHS) for (const earned of [true, false]) expect(render(createElement(MilestoneCoin, { glyph, earned }))).not.toMatch(MATERIAL)
    expect(render(createElement(Medallion, { name: 'Acme', color: '#4c9cff', laurel: true, working: true }))).not.toMatch(MATERIAL)
  })
})

describe('the rail coin (CompanyRail)', () => {
  const co = { id: 'c1', name: 'Sunday Bakery', color: '#4c9cff', system: undefined }
  const personal = { id: 'personal', name: 'Personal', color: '', system: 'personal' as const }

  it('keeps the accessible names', () => {
    expect(badgeTitle('Sunday Bakery', undefined, true)).toBe('Sunday Bakery, all agents healthy')
    expect(badgeTitle('Kestrel', { needsYou: 0, working: 0, failed: true } as never)).toBe('Kestrel · a run failed in the last 24 h')
  })

  it('laurel precedence: healthy only, never with needs-you, a failed run or on Personal', () => {
    expect(railLaurel(co as never, undefined, true)).toBe(true)
    expect(railLaurel(co as never, { needsYou: 2, working: 0, failed: false } as never, true)).toBe(false)
    expect(railLaurel(co as never, { needsYou: 0, working: 0, failed: true } as never, true)).toBe(false)
    expect(railLaurel(co as never, undefined, false)).toBe(false)
    expect(railLaurel(personal as never, undefined, true)).toBe(railLaurel(personal as never, undefined, false))
  })

  it('renders the failed state through the Medallion square, the working tiles only without needs-you', () => {
    const failed = render(createElement(RailCoin, { company: co as never, badge: { needsYou: 0, working: 0, failed: true } as never, healthy: true }))
    expect(failed).toContain('rm-medallion__fail')
    expect(failed).not.toContain('rm-laurel')
    expectClean(failed)
    const healthy = render(createElement(RailCoin, { company: co as never, badge: undefined, healthy: true }))
    expect(healthy).toContain('rm-laurel')
    expect(healthy).not.toContain('rm-medallion__fail')
    const busy = render(createElement(RailCoin, { company: co as never, badge: { needsYou: 0, working: 2, failed: false } as never, healthy: false }))
    expect(rectsOf(busy, 'rm-wk')).toHaveLength(12)
    const needs = render(createElement(RailCoin, { company: co as never, badge: { needsYou: 1, working: 2, failed: false } as never, healthy: true }))
    expect(rectsOf(needs, 'rm-wk')).toHaveLength(0)
    expect(needs).not.toContain('rm-laurel')
  })

  it('the sidebar failed mark is a square tessera too', () => {
    const html = render(createElement(CompanyBadgeMark, { badge: { needsYou: 0, working: 0, failed: true } as never }))
    expect(html).toContain('co-failed-tess')
    // the base dot itself is square (shell.css), so no rail override is needed (VOICE.md §5.6)
    const shell = readFileSync(join(__dirname, '../../styles/shell.css'), 'utf8')
    expect(shell).toMatch(/\.co-failed-dot\s*\{[^}]*border-radius:\s*0[;\s]/)
    const css = readFileSync(join(__dirname, '../../styles/rail.css'), 'utf8')
    expect(css).not.toMatch(/\.rail__failed/)
  })
})

describe('rail.css and portfolio.css', () => {
  it('have no gold or bronze refs, no drop shadows on coins and no round failed dot', () => {
    for (const f of ['rail.css', 'portfolio.css']) {
      const css = readFileSync(join(__dirname, '../../styles', f), 'utf8')
      expect(css).not.toMatch(/gold|bronze|terracotta|travertine|240,\s*212,\s*138/i)
      expect(css).not.toMatch(/rm-medallion\s*\{[^}]*drop-shadow/)
      for (const hex of BANNED) expect(css.toLowerCase()).not.toContain(hex)
    }
  })
})
