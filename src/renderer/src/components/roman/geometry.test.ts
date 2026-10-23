import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArchFrame } from './ArchFrame'
import { Laurel } from './Laurel'
import {
  ARCH,
  LN,
  MILESTONE_GLYPHS,
  MOSAIC_COLS,
  MOSAIC_MOTIFS,
  MOSAIC_ROWS,
  PX,
  ROUNDEL,
  glyphTiles,
  initialOf,
  leafD,
  meander,
  mosaicTiles,
  pediment,
  pixelWreath,
  wreath,
  wreathLeaves,
  type MilestoneGlyph,
  type MosaicMotif
} from './geometry'

/** VOICE.md §5.2: the retired material colours; none may appear in the Roman foundation. */
const BANNED = [
  '#b0773a', '#d9a066', '#7a4d22', '#d4a84b', '#8a6a22', '#b5532f', '#e8dfcf', '#f3efe7', '#cdbfa5', '#a8987c',
  '#4a3a28', '#5c5040', '#6b5a44', '#1b1712', '#c08447', '#c56a45', '#5b2a5e'
]

const hexOf = (v: string): string => (v.match(/#[0-9a-f]{3,8}/i)?.[0] ?? '').toLowerCase()

/** rough warm check: a brown/ochre/beige/gold hex has red > blue by a wide margin and isn't a status colour */
function isWarm(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return r - b > 40 && g - b > 20
}

describe('PX palette', () => {
  it('every tile colour is a var with a hex fallback outside the banned list and not warm', () => {
    for (const [key, v] of Object.entries(PX)) {
      const hex = hexOf(v)
      expect(hex, key).toMatch(/^#[0-9a-f]{6}$/)
      expect(BANNED, key).not.toContain(hex)
      expect(isWarm(hex), `${key} ${hex}`).toBe(false)
    }
  })

  it('line tiers are the four white opacities', () => {
    expect(LN).toEqual({ 1: 0.9, 2: 0.5, 3: 0.2, 4: 0.1 })
  })
})

describe('banned material colours in the foundation files', () => {
  const read = (p: string): string => readFileSync(join(__dirname, p), 'utf8').toLowerCase()
  const files = { 'roman.css': read('../../styles/roman.css'), 'geometry.ts': read('./geometry.ts'), 'Laurel.tsx': read('./Laurel.tsx'), 'ArchFrame.tsx': read('./ArchFrame.tsx') }

  it.each(Object.keys(files))('%s has no banned hex, no noise texture and no warm stage', (name) => {
    const src = files[name as keyof typeof files]
    for (const hex of BANNED) expect(src, `${name} ${hex}`).not.toContain(hex)
    expect(src).not.toContain('feturbulence')
    expect(src).not.toMatch(/--rm-(travertine|marble|bronze|terracotta|gold|carve|stage|press|purple)\b/)
    expect(src).not.toMatch(/\.rm-(stone|marble|bronze|carved|gilt|stage)\b/)
  })

  it('roman.css keeps its only radial-gradient out (backgrounds stay flat)', () => {
    expect(files['roman.css']).not.toContain('radial-gradient')
  })

  it('roman.css defines the §5.1 tokens and the line-art class', () => {
    const css = files['roman.css']
    for (const t of ['--rm-ln-1', '--rm-ln-2', '--rm-ln-3', '--rm-ln-4', '--rm-ink: #141517', '--rm-stroke', '--rm-glow', '--rm-px-white', '--rm-px-blue', '--rm-px-purple', '--rm-px-ground']) {
      expect(css).toContain(t)
    }
    expect(css).toMatch(/\.rm-la\s*\{[^}]*fill:\s*none[^}]*stroke:\s*#fff/)
    expect(css).toMatch(/\.rm-la \*\s*\{\s*vector-effect:\s*non-scaling-stroke/)
  })

  it('every animation sits inside prefers-reduced-motion: no-preference', () => {
    const css = files['roman.css']
    const start = css.indexOf('@media (prefers-reduced-motion: no-preference)')
    expect(start).toBeGreaterThan(0)
    const before = css.slice(0, start)
    expect(before).not.toMatch(/animation\s*:/)
    expect(before).not.toContain('@keyframes')
    for (const k of ['rm-draw', 'rm-tile', 'rm-breathe', 'rm-letters-in', 'rm-rise', 'rm-wk']) expect(css).toContain(`@keyframes ${k}`)
    for (const k of ['rm-press', 'rm-chip', 'rm-tile-in', 'rm-leaf-in', 'rm-tablet-in']) expect(css).not.toContain(`@keyframes ${k} `)
  })

  it('a drawn stroke ends undashed: the dash lives only in the rm-draw keyframes (non-scaling-stroke + pathLength)', () => {
    const css = files['roman.css']
    const rule = css.match(/\.rm-draw\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).not.toContain('stroke-dasharray')
    expect(rule![1]).toMatch(/animation:\s*rm-draw[^;]*\bbackwards\b/)
    expect(rule![1]).not.toMatch(/\b(both|forwards)\b/)
    const kf = css.slice(css.indexOf('@keyframes rm-draw'))
    expect(kf).toMatch(/from\s*\{[^}]*stroke-dasharray:\s*var\(--rm-ds,\s*1\)[^}]*stroke-dashoffset:\s*var\(--rm-ds,\s*1\)/)
    expect(kf).toMatch(/to\s*\{[^}]*stroke-dashoffset:\s*0/)
  })
})

describe('ArchFrame and Laurel markup (§5.5, §5.7)', () => {
  it('the arch is decorative white line art in the tiers, every element drawable', () => {
    const html = renderToStaticMarkup(createElement(ArchFrame))
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('class="rm-la rm-arch"')
    expect(html).toContain('opacity:0.14')
    expect(html).not.toContain('rm-draw')
    expect(html).not.toContain('--rm-ds')
    const opacities = new Set(Array.from(html.matchAll(/stroke-opacity="([\d.]+)"/g), (m) => Number(m[1])))
    expect([...opacities].sort()).toEqual([LN[1], LN[2], LN[3]].sort())
    expect(html).not.toMatch(/fill="(?!none)/)
    const shapes = html.match(/<(rect|line|path)\b/g)!.length
    expect(html.match(/pathLength="1"/g)!.length).toBe(shapes)
  })

  it('a drawing arch sets a dash scale that covers its stage stretch', () => {
    const html = renderToStaticMarkup(createElement(ArchFrame, { draw: true }))
    expect(html).toContain('--rm-ds:2.5')
    expect(html.match(/class="rm-draw"/g)!.length).toBe(html.match(/<(rect|line|path)\b/g)!.length)
  })

  it('laurels are stroke-only, decorative, in tiers 1 and 2', () => {
    for (const variant of ['crown', 'wreath', 'sprig'] as const) {
      const html = renderToStaticMarkup(createElement(Laurel, { variant, size: 24 }))
      expect(html).toContain('aria-hidden="true"')
      expect(html).not.toMatch(/fill="(?!none)/)
      for (const m of html.matchAll(/stroke-opacity="([\d.]+)"/g)) expect([LN[1], LN[2]]).toContain(Number(m[1]))
      for (const m of html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) expect(m[0].toLowerCase()).toBe('#fff')
    }
  })
})

describe('mosaic', () => {
  const motifs = Object.keys(MOSAIC_MOTIFS) as MosaicMotif[]

  it.each(motifs)('%s is a rectangular 12 × 9 grid of palette keys', (m) => {
    const rows = MOSAIC_MOTIFS[m]
    expect(rows).toHaveLength(9)
    for (const row of rows) {
      expect(row).toHaveLength(12)
      for (const ch of row) expect(ch in PX, `${m} '${ch}'`).toBe(true)
    }
  })

  it.each(motifs)('%s board: 14 × 11 tiles, purple border, crisp pitch, no jitter, deterministic', (m) => {
    const tiles = mosaicTiles(m)
    expect(tiles).toHaveLength(MOSAIC_COLS * MOSAIC_ROWS)
    expect(mosaicTiles(m)).toEqual(tiles)
    tiles.forEach((t, i) => {
      const r = Math.floor(i / MOSAIC_COLS)
      const c = i % MOSAIC_COLS
      expect(t.x).toBeCloseTo(c * 10 + 0.8, 5)
      expect(t.y).toBeCloseTo(r * 10 + 0.8, 5)
      expect(t.size).toBeCloseTo(8.4, 5)
      const border = r === 0 || c === 0 || r === MOSAIC_ROWS - 1 || c === MOSAIC_COLS - 1
      if (border) expect(t.key).toBe((r + c) % 2 === 0 ? 'p' : 'P')
      else expect('pP').not.toContain(t.key)
      expect(t.fill).toBe(PX[t.key])
    })
  })

  it('motifs use the §5.8 colours', () => {
    const keys = (m: MosaicMotif): Set<string> => new Set(MOSAIC_MOTIFS[m].join('').replace(/\./g, ''))
    expect(keys('laurel')).toEqual(new Set(['g', 'G', 'w', 'b']))
    expect(keys('amphora')).toEqual(new Set(['w', 'b', 'B']))
    expect(keys('column')).toEqual(new Set(['w', 's']))
    expect(keys('coin')).toEqual(new Set(['s', 'w', 'b']))
    expect(keys('lamp')).toEqual(new Set(['w', 'b', 's', 'd']))
  })
})

describe('milestone glyphs', () => {
  const names = Object.keys(MILESTONE_GLYPHS) as MilestoneGlyph[]
  it('has the eight §5.9 glyphs', () => {
    expect(names.sort()).toEqual(['coin', 'column', 'dove', 'laurel', 'quill', 'scroll', 'seal', 'sun'])
  })
  it.each(names)('%s is a rectangular 9 × 9 grid in white plus allowed accents', (n) => {
    const rows = MILESTONE_GLYPHS[n]
    expect(rows).toHaveLength(9)
    for (const row of rows) expect(row).toMatch(/^[#.bg]{9}$/)
    const tiles = glyphTiles(n, 0, 0)
    expect(tiles.length).toBe(rows.join('').replace(/\./g, '').length)
    const accents = new Set(tiles.filter((t) => t.key !== 'w').map((t) => t.key))
    // blue accent, or green for seal and laurel (the laurel glyph is green leaves with a blue knot)
    const expected = n === 'seal' ? ['g'] : n === 'laurel' ? ['b', 'g'] : ['b']
    expect([...accents].sort()).toEqual(expected)
  })
})

describe('pixelWreath', () => {
  const pw = pixelWreath()

  it('is deterministic', () => {
    expect(pixelWreath()).toEqual(pw)
  })

  // spec change (VOICE.md §8): the rasterised 29 × 27 wreath read as noise; it is now the hand-authored 21 × 20 one
  it('matches the docs/voice.html hand-authored wreath (21 × 20, 87 tiles)', () => {
    expect(pw.cols).toBe(21)
    expect(pw.rows).toBe(20)
    expect(pw.tiles).toHaveLength(87)
    // the first tiles of the mockup, row-major: x, y, key, reveal step
    expect(pw.tiles.slice(0, 6).map((t) => [t.x, t.y, t.key, t.step])).toEqual([
      [41, 11, 'w', 20], [161, 11, 'w', 20], [11, 21, 'w', 18], [51, 21, 's', 20], [151, 21, 's', 20], [191, 21, 'w', 18]
    ])
  })

  it('uses white outer leaves, blue inner leaves and a silver stem only', () => {
    expect(new Set(pw.tiles.map((t) => t.key))).toEqual(new Set(['w', 'b', 's']))
  })

  it('is mirror-symmetric with no doubled tiles', () => {
    const at = new Map(pw.tiles.map((t) => [`${t.x},${t.y}`, t]))
    expect(at.size).toBe(pw.tiles.length)
    for (const t of pw.tiles) {
      const m = at.get(`${pw.cols * pw.pitch - t.x - t.size},${t.y}`)
      expect(m?.key).toBe(t.key)
      expect(m?.step).toBe(t.step)
    }
  })

  it('reveal order covers every tile exactly once, bottom up', () => {
    expect([...pw.order].sort((a, b) => a - b)).toEqual(pw.tiles.map((_, i) => i))
    const steps = pw.order.map((i) => pw.tiles[i].step)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
    const first = pw.tiles[pw.order[0]]
    expect(first.y).toBeGreaterThan(170)
  })

  it('stays inside its grid', () => {
    for (const t of pw.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.x + t.size).toBeLessThanOrEqual(pw.cols * pw.pitch)
      expect(t.y + t.size).toBeLessThanOrEqual(pw.rows * pw.pitch)
    }
  })
})

describe('line ornaments', () => {
  it('pediment: tiers, dentils and the accent inside the tympanum', () => {
    const p = pediment(236, 44)
    expect(p.paths.map((x) => x.o)).toEqual([LN[1], LN[2], LN[1], LN[3], LN[2], LN[3]])
    expect(p.paths[0].d).toBe('M4.00 30.00 L118.00 3 L232.00 30.00')
    const dentils = p.paths[3].d.match(/M/g) ?? []
    expect(dentils.length).toBe(Math.ceil((236 - 16) / 5))
    expect(p.accent.size).toBe(5)
    expect(p.accent.x + 2.5).toBe(118)
    expect(pediment(236, 44)).toEqual(p)
  })

  it('pediment span narrows the triangle but not the entablature', () => {
    const p = pediment(500, 50, 300)
    expect(p.paths[0].d).toBe('M104.00 36.00 L250.00 3 L396.00 36.00')
    expect(p.paths[2].d).toBe('M2 36.00 H498.00')
  })

  it('meander: 12-unit repeat plus a base line', () => {
    const m = meander(240)
    expect(m.h).toBe(15)
    expect(m.paths[0].d.match(/M/g)?.length).toBe(20)
    expect(m.paths[1].d).toBe('M0 14 H240')
    expect(m.paths.map((x) => x.o)).toEqual([LN[2], LN[3]])
  })

  it('arch: same geometry as before plus a keystone', () => {
    expect(ARCH.columns).toEqual([14, 344])
    expect(ARCH.outerD).toBe('M45 96 A165 88 0 0 1 375 96')
    expect(ARCH.innerD).toBe('M67 96 A143 68 0 0 1 353 96')
    expect(ARCH.voussoirs).toHaveLength(14)
    expect(ARCH.voussoirs[0]).toEqual({ x1: '48.61', y1: '77.70', x2: '70.12', y2: '81.86' })
    expect(ARCH.keystone).toBe('M203 6.5 L217 6.5 L215 28 L205 28 Z')
  })

  it('leaf is an almond outline', () => {
    expect(leafD(2.5, 0.875)).toBe('M-2.50 0Q0 -1.75 2.50 0Q0 1.75 -2.50 0Z')
  })

  it('roundel wreath: 8 pairs plus a tip leaf per branch, mirrored, with stems and ribbon', () => {
    const w = wreath(ROUNDEL.wreath)
    expect(w.leaves).toHaveLength(2 * (8 * 2 + 1))
    expect(w.stems).toHaveLength(2)
    expect(w.knot).toMatch(/^M[\d. ]+Q/)
    const half = w.leaves.length / 2
    for (let i = 0; i < half; i++) {
      const a = w.leaves[i]
      const b = w.leaves[i + half]
      expect(a.cx + b.cx).toBeCloseTo(64, 6)
      expect(a.cy).toBeCloseTo(b.cy, 6)
      expect(a.rot + b.rot).toBeCloseTo(180, 6)
    }
    expect(wreathLeaves(ROUNDEL.wreath)).toEqual(w.leaves)
    expect(wreath(ROUNDEL.wreath)).toEqual(w)
    expect([ROUNDEL.outer, ROUNDEL.beads, ROUNDEL.inner]).toEqual([29.5, 27.6, 25.8])
  })

  it('legacy wreath specs with ri still work (stem halfway)', () => {
    const legacy = wreathLeaves({ cx: 24, cy: 24, r: 22.55, ri: 19.85, pairs: 8, end: -50, rx: 2.52, ry: 1.035 })
    expect(legacy).toHaveLength(34)
  })
})

describe('initialOf', () => {
  it('takes the first user-perceived character, uppercased', () => {
    expect(initialOf('sunday')).toBe('S')
    expect(initialOf('  ')).toBe('')
    expect(initialOf(null)).toBe('')
    expect(initialOf('🍞 bakery')).toBe('🍞')
  })
})
