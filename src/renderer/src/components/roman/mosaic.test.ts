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
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const { MosaicEmpty, Mosaic } = await import('./MosaicEmpty')
const { Tesserae } = await import('./Tesserae')
const { PX, MOSAIC_MOTIFS, mosaicTiles, pixelWreath } = await import('./geometry')

type Motif = keyof typeof MOSAIC_MOTIFS
const MOTIFS = Object.keys(MOSAIC_MOTIFS) as Motif[]
const PALETTE = new Set<string>(Object.values(PX))
const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el)
const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const rects = (html: string): string[] => html.match(/<rect\b[^>]*>/g) ?? []

/** the hex a palette entry resolves to without the stylesheet (`var(--x, #hex)` or a bare hex) */
const hexOf = (fill: string): string => (fill.match(/#[0-9a-fA-F]{6}\b/)?.[0] ?? fill).toLowerCase()

/** hue (deg) and saturation (0..1, HSL) of a #rrggbb colour */
function hsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** brown, ochre, mustard, beige, terracotta, gold, bronze: any noticeably warm hue from red-orange to yellow */
const isWarm = (hex: string): boolean => {
  const { h, s } = hsl(hex)
  return s > 0.12 && h >= 12 && h <= 65
}

/** every colour of the deleted MOSAIC_SHADES except the purples (VOICE.md §5.8) */
const OLD_SHADES = [
  '#8f3f22', '#a84c2b', '#b5532f', '#c05d37', '#b8902f', '#c99c40', '#d4a84b', '#8a6a22', '#9a7628', '#a56d33', '#b0773a',
  '#ddd2bd', '#e8dfcf', '#efe7da', '#f3efe7', '#27251f', '#2b2925', '#2f2c28', '#322e29'
]

describe('pixel palette', () => {
  it('has no warm material colour', () => {
    for (const fill of PALETTE) expect(isWarm(hexOf(fill)), fill).toBe(false)
    // the detector catches every old material tile (the four warm-dark grounds are rejected by exact value instead)
    for (const old of OLD_SHADES.slice(0, 15)) expect(isWarm(old), old).toBe(true)
  })
})

describe('mosaicTiles', () => {
  it.each(MOTIFS)('%s: a 14 × 11 board, palette fills only, square and unjittered', (motif) => {
    const tiles = mosaicTiles(motif)
    expect(tiles).toHaveLength(14 * 11)
    const xs = new Set(tiles.map((t) => t.x))
    const ys = new Set(tiles.map((t) => t.y))
    expect(xs.size).toBe(14)
    expect(ys.size).toBe(11)
    for (const t of tiles) {
      expect(PALETTE.has(t.fill), t.fill).toBe(true)
      expect(OLD_SHADES).not.toContain(hexOf(t.fill))
      expect(isWarm(hexOf(t.fill)), t.fill).toBe(false)
      // on the 10-unit pitch with a .8 half gap: no jitter
      expect(((t.x - 0.8) / 10) % 1).toBeCloseTo(0, 6)
      expect(((t.y - 0.8) / 10) % 1).toBeCloseTo(0, 6)
      expect(t.size).toBeCloseTo(8.4, 6)
    }
  })

  it.each(MOTIFS)('%s: purple border tiles only on the edge, and the motif is visible', (motif) => {
    const tiles = mosaicTiles(motif)
    tiles.forEach((t, i) => {
      const r = Math.floor(i / 14)
      const c = i % 14
      const edge = r === 0 || c === 0 || r === 10 || c === 13
      expect(t.key === 'p' || t.key === 'P', `${r},${c}`).toBe(edge)
    })
    const lit = tiles.filter((t) => !['p', 'P', '.', ','].includes(t.key))
    expect(lit.length).toBeGreaterThan(12)
  })
})

describe('MosaicEmpty', () => {
  it.each(MOTIFS)('%s renders the board crisp and decorative, children readable', (motif) => {
    const html = render(createElement(MosaicEmpty, { motif, width: 104 }, createElement('p', null, 'Nothing yet.')))
    const svg = html.match(/<svg\b[^>]*>/)![0]
    expect(attr(svg, 'aria-hidden')).toBe('true')
    expect(attr(svg, 'shape-rendering')).toBe('crispEdges')
    expect(attr(svg, 'viewBox')).toBe('0 0 140 110')
    expect(attr(svg, 'width')).toBe('104')
    expect(attr(svg, 'height')).toBe(String(Math.round(((104 * 110) / 140) * 100) / 100))
    expect(svg).toContain(`rm-mosaic--${motif}`)
    const rs = rects(html)
    expect(rs).toHaveLength(14 * 11)
    for (const r of rs) {
      expect(PALETTE.has(attr(r, 'fill')!), attr(r, 'fill')).toBe(true)
      expect(r).not.toMatch(/\s(rx|ry|transform|filter)=/)
      expect(r).not.toContain('rm-tile')
    }
    expect(html).not.toMatch(/gradient|feTurbulence|<filter/i)
    expect(html).toContain('<p>Nothing yet.</p>')
  })
})

describe('Mosaic', () => {
  it('sizes the viewBox from the tile bounds by default', () => {
    const html = render(createElement(Mosaic, { tiles: mosaicTiles('coin') }))
    const svg = html.match(/<svg\b[^>]*>/)![0]
    expect(attr(svg, 'viewBox')).toBe('0 0 140 110')
    expect(attr(svg, 'width')).toBe('140')
    expect(attr(svg, 'height')).toBe('110')
  })

  it('falls back to the tile bounds for zero or non-finite sizes (no NaN height)', () => {
    const html = render(createElement(Mosaic, { tiles: mosaicTiles('coin'), width: 0, viewWidth: 0, viewHeight: Number.NaN }))
    const svg = html.match(/<svg\b[^>]*>/)![0]
    expect(attr(svg, 'viewBox')).toBe('0 0 140 110')
    expect(attr(svg, 'width')).toBe('140')
    expect(attr(svg, 'height')).toBe('110')
  })

  it('without anim renders the ceremony wreath as plain tiles', () => {
    const wreath = pixelWreath()
    const vw = wreath.cols * wreath.pitch
    const vh = wreath.rows * wreath.pitch
    const html = render(createElement(Mosaic, { tiles: wreath.tiles, width: 200, viewWidth: vw, viewHeight: vh }))
    const svg = html.match(/<svg\b[^>]*>/)![0]
    expect(attr(svg, 'viewBox')).toBe(`0 0 ${vw} ${vh}`)
    expect(attr(svg, 'aria-hidden')).toBe('true')
    expect(rects(html)).toHaveLength(wreath.tiles.length)
    expect(html).not.toContain('rm-tile')
    for (const t of wreath.tiles) expect(PALETTE.has(t.fill), t.fill).toBe(true)
  })

  it('with anim staggers --i by reveal order', () => {
    const wreath = pixelWreath()
    const html = render(createElement(Mosaic, { tiles: wreath.tiles, order: wreath.order, anim: true }))
    const rs = rects(html)
    expect(rs.every((r) => attr(r, 'class') === 'rm-tile')).toBe(true)
    const iOf = (r: string): number => Number(attr(r, 'style')!.match(/--i:\s*(\d+)/)![1])
    // the first tile revealed gets --i 0, the last gets n - 1, and every index is used once
    expect(iOf(rs[wreath.order[0]])).toBe(0)
    expect(iOf(rs[wreath.order[wreath.order.length - 1]])).toBe(rs.length - 1)
    expect(new Set(rs.map(iOf)).size).toBe(rs.length)
  })

  it('anim without an order falls back to document order', () => {
    const tiles = mosaicTiles('coin').slice(0, 3)
    const html = render(createElement(Mosaic, { tiles, anim: true }))
    expect(rects(html).map((r) => attr(r, 'style'))).toEqual(['--i:0', '--i:1', '--i:2'])
  })
})

describe('Tesserae', () => {
  const states = (html: string): string[] => [...html.matchAll(/rm-tess__tile--(done|cur|todo)/g)].map((m) => m[1])

  it('marks done, current and todo tiles in order, untilted and unfilled inline', () => {
    const html = render(createElement(Tesserae, { index: 2, total: 6 }))
    expect(states(html)).toEqual(['done', 'done', 'cur', 'todo', 'todo', 'todo'])
    expect(html).not.toMatch(/rotate|background/)
    expect(html.match(/<span class="rm-tess__tiles" aria-hidden="true">/)).not.toBeNull()
    expect(html).toContain('Step 3 of 6')
  })

  it('first and last steps', () => {
    expect(states(render(createElement(Tesserae, { index: 0, total: 6 })))).toEqual(['cur', 'todo', 'todo', 'todo', 'todo', 'todo'])
    expect(states(render(createElement(Tesserae, { index: 5, total: 6 })))).toEqual(['done', 'done', 'done', 'done', 'done', 'cur'])
  })

  it('clamps bad inputs', () => {
    expect(states(render(createElement(Tesserae, { index: 99, total: 3 })))).toEqual(['done', 'done', 'cur'])
    expect(states(render(createElement(Tesserae, { index: -4, total: 2 })))).toEqual(['cur', 'todo'])
    const nan = render(createElement(Tesserae, { index: Number.NaN, total: Number.NaN }))
    expect(states(nan)).toEqual(['cur'])
    expect(nan).toContain('Step 1 of 1')
  })
})
