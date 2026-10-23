/**
 * Cross-cutting invariants of the Roman theme (VOICE.md §5.2): every component is either white LINE ART (stroke-only,
 * non-scaling 1 px strokes in the white tiers) or PIXEL MOSAIC (square tiles from the `--rm-px-*` palette). Fills are
 * allowed only on occluding ground discs, tesserae and white lettering; no gradients, filters, noise or warm colours.
 * Component-specific geometry lives in bust/coin/geometry/mosaic/passport tests; this file checks the system rules and
 * the accessibility behaviour across all of them.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, Fragment, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BustLook } from '@shared/personas'

// the tone fallback reads the store; server markup needs a server snapshot and a window without a bridge
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const { Bust, bustTier, DEFAULT_LOOK, Laurel, Seal, Medallion, Tesserae, PassportTablet, Plinth, ArchFrame, MosaicEmpty, MilestoneCoin, LatinLine, inscriptionSize, initialOf, PX } =
  await import('./index')
const { Mosaic } = await import('./MosaicEmpty')
const { pixelWreath } = await import('./geometry')

/** comments stripped so prose about the rules never matches a rule */
const ROMAN_CSS = readFileSync(join(__dirname, '../../styles/roman.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const look = (p: Partial<BustLook> = {}): BustLook => ({ material: 'marble', hair: 'crop', beard: 'full', laurel: true, drape: 'purple', ...p })
const render = (el: ReactElement): string => renderToStaticMarkup(el)

/** VOICE §5.2 retired colours (any case) */
const BANNED_HEX = ['#b0773a', '#d9a066', '#7a4d22', '#d4a84b', '#8a6a22', '#b5532f', '#e8dfcf', '#f3efe7', '#cdbfa5', '#a8987c', '#4a3a28', '#5c5040', '#6b5a44', '#1b1712', '#c08447', '#c56a45']
const PX_FILLS = new Set(Object.values(PX))
const SHAPES = new Set(['path', 'circle', 'ellipse', 'line', 'rect', 'polyline', 'polygon', 'text'])
/** occluding grounds may only use the app's dark surface tokens */
const GROUND = /^var\(--(rm-ink|bg|surface-0|surface-1|bg-elevated)\)$/

/**
 * Line-art opacity tiers (§5.2: --rm-ln-1..4 = .9/.5/.2/.1) plus the three documented exceptions: the unsealed seal's
 * ghost initial (.22, §5.3) and the locked milestone coin (.38 ring, .32 tile outlines, §5.7).
 */
const STROKE_TIERS = new Set([0.9, 0.5, 0.2, 0.1, 0.22, 0.32, 0.38])
/** the one warm hue allowed in markup: amber, as a Needs-you status tile only (§5.2) */
const STATUS_AMBER = new Set(['#f5a524'])

/** "and their kin" (§5.2): any saturated hex in the brown/orange/ochre/mustard/beige band, not just the listed ones */
function isWarmHex(hex: string): boolean {
  let h = hex.slice(1).toLowerCase()
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return false
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return false
  const sat = d / (1 - Math.abs(2 * l - 1))
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  hue = (hue * 60 + 360) % 360
  // beige/cream sits at low saturation but high lightness, so the threshold drops for pale warm tones
  return hue >= 10 && hue <= 65 && (sat >= 0.25 || (l > 0.75 && sat >= 0.12)) && l > 0.08 && l < 0.97
}

/** text a screen reader can reach: drop aria-hidden subtrees (no nesting of same tag needed here), then all tags */
function readableText(html: string): string {
  let out = html
  for (const tag of ['svg', 'span', 'div', 'i']) {
    const re = new RegExp(`<${tag}\\b[^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</${tag}>`, 'g')
    out = out.replace(re, '')
  }
  return out.replace(/<[^>]+>/g, '').trim()
}

interface Node {
  tag: string
  attrs: Record<string, string>
  style: Record<string, string>
  parent: Node | null
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of src.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? ''
  return out
}
function parseStyle(src: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const decl of (src ?? '').split(';')) {
    const i = decl.indexOf(':')
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
  }
  return out
}
/** every element in the markup with its ancestor chain (React's static markup is well-formed) */
function elements(html: string): Node[] {
  const out: Node[] = []
  let cur: Node | null = null
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g)) {
    const [, close, tag, rest, self] = m
    if (close) {
      if (cur) cur = cur.parent
      continue
    }
    const attrs = parseAttrs(rest)
    const node: Node = { tag, attrs, style: parseStyle(attrs.style), parent: cur }
    out.push(node)
    if (!self && !['br', 'wbr', 'img', 'input', 'hr', 'meta'].includes(tag)) cur = node
  }
  return out
}
const prop = (n: Node, name: string): string | undefined => n.style[name] ?? n.attrs[name]
/** the nearest value of a presentation property on the element or an ancestor */
function inherited(n: Node | null, name: string): string | undefined {
  for (let p = n; p; p = p.parent) {
    const v = prop(p, name)
    if (v !== undefined) return v
  }
  return undefined
}
const svgOf = (n: Node): Node | null => {
  for (let p = n.parent; p; p = p.parent) if (p.tag === 'svg') return p
  return null
}
const classes = (n: Node | null): string[] => (n?.attrs.class ?? '').split(/\s+/).filter(Boolean)

/**
 * Asserts the two-tools rule on a piece of markup. Returns the counts so callers can check something was rendered.
 */
function expectRomanInvariants(html: string): { strokes: number; tiles: number } {
  const lower = html.toLowerCase()
  for (const hex of BANNED_HEX) expect(lower, `banned colour ${hex}`).not.toContain(hex)
  for (const [hex] of lower.matchAll(/#[0-9a-f]{3,8}\b/g)) if (!STATUS_AMBER.has(hex)) expect(isWarmHex(hex), `warm colour ${hex}`).toBe(false)
  expect(html).not.toMatch(/<(linearGradient|radialGradient|pattern|filter|feTurbulence|image)\b/i)
  expect(html).not.toMatch(/url\(#/)
  expect(html).not.toMatch(/drop-shadow|box-shadow|text-shadow|gradient\(/)
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  expect(new Set(ids).size).toBe(ids.length)

  let strokes = 0
  let tiles = 0
  for (const n of elements(html)) {
    if (n.tag === 'svg') {
      const mosaic = classes(n).includes('rm-mosaic')
      if (mosaic) {
        expect(n.attrs['shape-rendering']).toBe('crispEdges')
      } else {
        // line art: the shared class sets fill none, the white stroke and (on children) the non-scaling stroke
        expect(classes(n), `svg ${n.attrs.class} is not .rm-la`).toContain('rm-la')
        expect(n.attrs.fill).toBe('none')
        expect(n.attrs.stroke).toBe('#fff')
      }
      continue
    }
    if (!SHAPES.has(n.tag)) continue
    const svg = svgOf(n)
    expect(svg, `<${n.tag}> outside an svg`).not.toBeNull()
    const mosaic = classes(svg).includes('rm-mosaic')

    const stroke = inherited(n, 'stroke')
    if (stroke !== undefined) expect(['#fff', 'none']).toContain(stroke)
    for (const p of [n, ...(n.parent ? [n.parent] : [])]) {
      const sw = prop(p, 'stroke-width')
      if (sw !== undefined) expect(parseFloat(sw), `stroke-width ${sw}`).toBeLessThanOrEqual(1.5)
    }
    const transform = n.attrs.transform ?? ''
    if (!mosaic) {
      const so = prop(n, 'stroke-opacity')
      if (so !== undefined) expect(STROKE_TIERS.has(parseFloat(so)), `stroke-opacity ${so} is not a tier`).toBe(true)
    }

    const fill = inherited(n, 'fill')
    const filled = fill !== undefined && fill !== 'none'
    if (mosaic) {
      // a pixel-mosaic tile: square, unrotated, unrounded, palette colour
      expect(n.tag).toBe('rect')
      expect(n.attrs.width).toBe(n.attrs.height)
      expect(n.attrs.rx ?? n.attrs.ry).toBeUndefined()
      expect(transform).not.toMatch(/rotate|skew/)
      expect(PX_FILLS.has(fill ?? ''), `tile fill ${fill}`).toBe(true)
      tiles++
      continue
    }
    if (!filled) {
      if (stroke !== 'none') strokes++
      continue
    }
    // the only filled things in line art
    if (n.tag === 'text') {
      expect(fill, 'lettering is white').toBe('#fff')
    } else if (n.tag === 'circle' && classes(n).includes('rm-seal__ground')) {
      expect(fill).toMatch(GROUND)
      expect(prop(n, 'stroke')).toBe('none')
    } else if (n.tag === 'rect') {
      // a tessera: square, stroke-less, unrotated; colour from the palette or the one company accent
      expect(inherited(n, 'stroke'), 'tesserae have no stroke').toBe('none')
      expect(n.attrs.width).toBe(n.attrs.height)
      expect(n.attrs.rx ?? n.attrs.ry).toBeUndefined()
      expect(transform).not.toMatch(/rotate|skew/)
      tiles++
    } else {
      throw new Error(`filled <${n.tag} class="${n.attrs.class ?? ''}"> with ${fill} in line art`)
    }
  }
  return { strokes, tiles }
}

describe('roman.css line-art contract', () => {
  it('.rm-la is stroke-only white with non-scaling strokes on every child', () => {
    const rule = ROMAN_CSS.match(/\.rm-la\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/fill:\s*none/)
    expect(rule![1]).toMatch(/stroke:\s*#fff/)
    expect(rule![1]).toMatch(/stroke-linecap:\s*round/)
    expect(rule![1]).toMatch(/stroke-linejoin:\s*round/)
    expect(ROMAN_CSS).toMatch(/\.rm-la \*\s*\{\s*vector-effect:\s*non-scaling-stroke;?\s*\}/)
  })

  it('animations sit inside prefers-reduced-motion: no-preference, are short or a slow loop, and never scale or rotate', () => {
    // the extent of every no-preference block, by brace matching
    const blocks: [number, number][] = []
    for (const m of ROMAN_CSS.matchAll(/@media \(prefers-reduced-motion: no-preference\)\s*\{/g)) {
      let depth = 1
      let i = m.index! + m[0].length
      for (; i < ROMAN_CSS.length && depth > 0; i++) depth += ROMAN_CSS[i] === '{' ? 1 : ROMAN_CSS[i] === '}' ? -1 : 0
      blocks.push([m.index!, i])
    }
    expect(blocks.length).toBeGreaterThan(0)
    const inside = (i: number): boolean => blocks.some(([a, b]) => i > a && i < b)
    const uses = [...ROMAN_CSS.matchAll(/(?<![-\w])(animation(?:-name)?|@keyframes)\b[^;{]*/g)]
    expect(uses.length).toBeGreaterThan(5)
    for (const u of uses) expect(inside(u.index!), `outside the motion block: ${u[0].trim()}`).toBe(true)
    for (const [, decl] of ROMAN_CSS.matchAll(/(?<![-\w])animation:\s*([^;]+);/g)) {
      if (/\binfinite\b/.test(decl)) continue // a slow breathe or the working tiles (§0)
      const ms = [...decl.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map(([, v, u]) => parseFloat(v) * (u === 's' ? 1000 : 1))
      expect(Math.max(...ms), decl).toBeLessThanOrEqual(900)
    }
    for (const [, body] of ROMAN_CSS.matchAll(/@keyframes [\w-]+\s*\{((?:[^{}]|\{[^}]*\})*)\}/g)) expect(body).not.toMatch(/scale|rotate|skew/)
  })
})

describe('Bust', () => {
  const hairs: BustLook['hair'][] = ['crop', 'curls', 'nodus', 'wavy', 'bun', 'bald', 'veil']
  const beards: BustLook['beard'][] = ['none', 'stubble', 'full']
  const materials: BustLook['material'][] = ['marble', 'travertine', 'bronze', 'terracotta']
  const drapes: BustLook['drape'][] = ['purple', 'terracotta', 'gold', 'marble']

  it('is pure line art for every look at every tier, deterministically', () => {
    for (const hair of hairs)
      for (const beard of beards)
        for (const [mi, material] of materials.entries())
          for (const size of [16, 28, 64, 96]) {
            const l = look({ hair, beard, material, drape: drapes[(mi + hairs.indexOf(hair)) % 4], laurel: hair !== 'veil' })
            const a = render(createElement(Bust, { look: l, size, ring: size < 40 }))
            const { strokes, tiles } = expectRomanInvariants(a)
            expect(strokes).toBeGreaterThan(3)
            expect(tiles).toBe(0)
            expect(render(createElement(Bust, { look: l, size, ring: size < 40 }))).toBe(a)
          }
  })

  it('simplifies at small sizes: fewer strokes, 1.25 px at the mini tier, 1.2 px above 80 px, 1 px between', () => {
    const l = look({ hair: 'curls', beard: 'full' })
    const count = (size: number): number => expectRomanInvariants(render(createElement(Bust, { look: l, size }))).strokes
    expect(count(16)).toBeLessThan(count(28))
    expect(count(28)).toBeLessThan(count(64))
    expect(count(16)).toBeLessThanOrEqual(16)
    expect(render(createElement(Bust, { look: l, size: 16 }))).toContain('stroke-width:1.25px')
    expect(render(createElement(Bust, { look: l, size: 64 }))).toContain('stroke-width:1px')
    expect(render(createElement(Bust, { look: l, size: 96 }))).toContain('stroke-width:1.2px')
  })

  it('keeps the tier thresholds and renders several busts without id clashes', () => {
    expect([16, 21, 22, 39, 40, 96].map(bustTier)).toEqual(['mini', 'mini', 'small', 'small', 'full', 'full'])
    const html = render(createElement(Fragment, null, ...[16, 28, 64].map((size) => createElement(Bust, { key: size, look: look(), size }))))
    expect(html.match(/<svg/g)).toHaveLength(3)
    expectRomanInvariants(html)
    for (const s of [16, 28, 64]) expect(html).toContain(`width="${s}"`)
  })

  it('is decorative unless titled', () => {
    expect(render(createElement(Bust, { look: look(), size: 28 }))).toContain('aria-hidden="true"')
    const titled = render(createElement(Bust, { look: look(), size: 28, title: 'Marcus, Copywriter' }))
    expect(titled).toContain('role="img"')
    expect(titled).toContain('aria-label="Marcus, Copywriter"')
    expect(titled).not.toContain('aria-hidden')
  })

  it('falls back to the default look for missing, partial or unknown looks instead of crashing', () => {
    const def = render(createElement(Bust, { look: DEFAULT_LOOK, size: 28 }))
    expect(render(createElement(Bust, { look: undefined, size: 28 }))).toBe(def)
    expect(render(createElement(Bust, { look: null, size: 28 }))).toBe(def)
    expect(render(createElement(Bust, { look: {}, size: 28 }))).toBe(def)
    const odd = { material: 'jade', hair: 'mohawk', drape: 'neon' } as unknown as BustLook
    expectRomanInvariants(render(createElement(Bust, { look: odd, size: 28 })))
    expect(render(createElement(Bust, { look: look(), size: Number.NaN }))).toContain('width="32"')
  })
})

describe('Laurel', () => {
  it('renders the three variants as stroke-only decoration, drawn or static', () => {
    for (const variant of ['crown', 'wreath', 'sprig'] as const)
      for (const draw of [false, true]) {
        const html = render(createElement(Laurel, { variant, size: 40, draw }))
        expect(html).toContain('aria-hidden="true"')
        expect(readableText(html)).toBe('')
        expect(html).not.toContain('<ellipse')
        expect(expectRomanInvariants(html).strokes).toBeGreaterThan(4)
        if (draw) expect(html).toContain('rm-draw')
        else expect(html).not.toContain('rm-draw')
      }
  })
})

describe('Seal', () => {
  it('is a line roundel in every state and size: only the ground disc and the accent tessera are filled', () => {
    for (const size of [36, 56, 72, 100])
      for (const [pressed, stamp] of [[false, false], [true, false], [true, true]] as const) {
        const html = render(createElement(Seal, { name: 'Sunday Bakery', color: '#4c9cff', size, pressed, stamp }))
        const { strokes, tiles } = expectRomanInvariants(html)
        expect(strokes).toBeGreaterThan(0)
        expect(tiles).toBe(pressed ? 1 : 0)
        expect(html.includes('rm-seal__ground')).toBe(pressed)
      }
  })

  it('labels the state; the stamp draws strokes instead of scattering chips', () => {
    const open = render(createElement(Seal, { name: 'Sunday Bakery', pressed: false }))
    expect(open).toContain('aria-label="Not launched yet"')
    expect(open).not.toContain('rm-seal--stamp')

    const pressed = render(createElement(Seal, { name: 'Sunday Bakery', color: '#4c9cff', pressed: true }))
    expect(pressed).toContain('aria-label="Launched"')
    expect(pressed).not.toContain('rm-seal--stamp')
    expect(pressed).not.toContain('rm-draw')
    // the initial is an outline (stroke only), the one outlined letter of the system
    expect(pressed).toMatch(/<text[^>]*class="rm-seal__initial"[^>]*fill="none"/)

    const stamp = render(createElement(Seal, { name: 'Sunday Bakery', pressed: true, stamp: true }))
    expect(stamp).toContain('rm-seal--stamp')
    expect(stamp).toContain('rm-draw')
    expect(stamp).not.toContain('rm-seal__chip')
    // only one accessible name, the state
    expect(stamp.match(/aria-label=/g)).toHaveLength(1)
    expect(readableText(stamp)).toBe('')
  })

  it('takes the first character without splitting emoji', () => {
    expect(initialOf('sunday')).toBe('S')
    expect(initialOf('🍞 Bakery')).toBe('🍞')
    expect(initialOf('  ')).toBe('')
  })
})

describe('Medallion', () => {
  it('is an engraved coin in every state: strokes, the white initial and square tesserae only', () => {
    const cases = [
      { name: 'Sunday Bakery', color: '#4c9cff', laurel: true },
      { name: 'Acme', working: true },
      { name: 'Acme', failed: true, laurel: true },
      { name: 'Personal', initial: 'P' },
      { name: 'Acme', size: 18, color: '#3ecf8e' },
      { name: 'Acme', size: 36 }
    ]
    for (const p of cases) {
      const html = render(createElement(Medallion, p))
      expect(expectRomanInvariants(html).strokes).toBeGreaterThan(0)
      expect(html).not.toContain('<ellipse')
    }
    // working: twelve tiles, not a pulsing ring; personal: no company tessera
    expect(render(createElement(Medallion, { name: 'Acme', working: true })).match(/class="rm-wk"/g)).toHaveLength(12)
    expect(render(createElement(Medallion, { name: 'Personal', initial: 'P' }))).not.toContain('rm-medallion__tessera')
  })

  it('with laurel exposes no text other than the provided label', () => {
    const html = render(createElement(Medallion, { name: 'Sunday Bakery', color: '#4c9cff', laurel: true, label: 'Sunday Bakery, all agents healthy' }))
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Sunday Bakery, all agents healthy"')
    expect(readableText(html)).toBe('')
    expect(html.match(/aria-label=/g)).toHaveLength(1)
    expect(html).toContain('viewBox="0 0 48 48"')
    expect(html).toContain('rm-laurel')
  })

  it('defaults the label to the name plus the healthy line; failed hides the laurel', () => {
    expect(render(createElement(Medallion, { name: 'Acme', laurel: true }))).toContain('aria-label="Acme, all agents healthy"')
    const plain = render(createElement(Medallion, { name: 'Acme', working: true }))
    expect(plain).toContain('aria-label="Acme"')
    expect(plain).toContain('viewBox="0 0 40 40"')
    const failed = render(createElement(Medallion, { name: 'Acme', laurel: true, failed: true }))
    expect(failed).not.toContain('rm-laurel')
    expect(failed).toContain('rm-medallion__fail')
  })

  it('never announces an empty label', () => {
    const bare = render(createElement(Medallion, { name: '  ' }))
    expect(bare).not.toContain('role="img"')
    expect(bare).not.toContain('aria-label=')
    expect(render(createElement(Medallion, { name: '', laurel: true }))).toContain('aria-label="all agents healthy"')
    expect(render(createElement(Medallion, { name: 'Acme', label: ' ' }))).toContain('aria-label="Acme"')
  })
})

describe('Tesserae', () => {
  it('hides the square tiles and shows Step n of N', () => {
    const html = render(createElement(Tesserae, { index: 1, total: 6 }))
    expect(html).toContain('aria-hidden="true"')
    expect(html.match(/rm-tess__tile--done/g)).toHaveLength(1)
    expect(html.match(/rm-tess__tile--cur/g)).toHaveLength(1)
    expect(html.match(/rm-tess__tile--todo/g)).toHaveLength(4)
    expect(html).not.toMatch(/rotate|--tilt/)
    expect(readableText(html)).toBe('Step 2 of 6')
    expectRomanInvariants(html)
  })

  it('never prints NaN for bad inputs', () => {
    expect(readableText(render(createElement(Tesserae, { index: Number.NaN, total: 6 })))).toBe('Step 1 of 6')
    expect(readableText(render(createElement(Tesserae, { index: 2, total: Number.NaN })))).toBe('Step 1 of 1')
  })
})

describe('PassportTablet', () => {
  /** words joined by the --rm-ln-2 interpunct, with a <wbr> after it */
  const DOT = (...words: string[]): string => words.join('<span class="rm-pp__dot">·</span><wbr/>')
  const meta = [{ label: 'Site', value: 'sundaybakery.com' }]

  it('is line art in every layout and state: one company tessera in the pediment, no inlay or material', () => {
    for (const layout of ['portrait', 'landscape', 'card'] as const)
      for (const sealed of [false, true])
        for (const name of ['Sunday Bakery', '  ']) {
          const html = render(createElement(PassportTablet, { name, color: '#4c9cff', meta, sealed, stampOnMount: sealed, layout, tone: 'playful', founded: 2026 }))
          const { strokes, tiles } = expectRomanInvariants(html)
          expect(strokes).toBeGreaterThan(5)
          // the pediment tessera, plus the seal's accent once sealed
          expect(tiles).toBe(sealed ? 2 : 1)
          expect(html).not.toMatch(/rm-(stone|marble|bronze|carved|gilt)\b/)
        }
  })

  it('playful: classical inscription with a dimmed interpunct and <wbr> after it, Roman year with the plain year for readers', () => {
    const html = render(createElement(PassportTablet, { name: 'Sunday Bakery', oneLiner: 'Sourdough for offices', tone: 'playful', founded: 2026, meta }))
    expect(html).toContain(DOT('SVNDAY', 'BAKERY'))
    expect(html).toContain('MMXXVI')
    expect(html).toContain('title="2026"')
    const text = readableText(html)
    expect(text).toContain('Sunday Bakery')
    expect(text).toContain('FOUNDED 2026')
    expect(text).not.toContain('SVNDAY')
    expect(text).not.toContain('MMXXVI')
  })

  it('plain: SUNDAY·BAKERY and FOUNDED 2026', () => {
    const html = render(createElement(PassportTablet, { name: 'Sunday Bakery', tone: 'plain', founded: 2026 }))
    expect(html).toContain(DOT('SUNDAY', 'BAKERY'))
    expect(html).toContain('FOUNDED 2026')
    expect(html).not.toContain('MMXXVI')
    expect(html).not.toContain('SVNDAY')
  })

  it('shows Your business with no name, and the seal state with the layout seal size', () => {
    const empty = render(createElement(PassportTablet, { name: '  ', tone: 'playful' }))
    expect(empty).toContain('Your business')
    expect(empty).toContain('is-empty')
    expect(empty).toContain('Not launched yet')
    const sealed = render(createElement(PassportTablet, { name: 'Acme', sealed: true, stampOnMount: true, layout: 'landscape', tone: 'plain' }))
    expect(sealed).toContain('aria-label="Launched"')
    expect(sealed).toContain('rm-seal--stamp')
    expect(sealed).toContain('width="72"')
    expect(render(createElement(PassportTablet, { name: 'Acme', tone: 'plain' }))).toContain('width="56"')
  })

  it('card: inscription only, seal 36, no meta', () => {
    const html = render(createElement(PassportTablet, { name: 'Acme Studio', layout: 'card', meta, tone: 'plain' }))
    expect(html).toContain(DOT('ACME', 'STUDIO'))
    expect(html).toContain('width="36"')
    expect(html).not.toContain('sundaybakery.com')
    expect(html).not.toContain('FOUNDED')
  })

  it('keeps a long meta value reachable through a hover title, and tolerates repeated labels', () => {
    const value = 'a-very-long-subdomain.sunday-bakery-and-coffee-roasters.example.com'
    const html = render(createElement(PassportTablet, { name: 'Acme', tone: 'plain', meta: [{ label: 'Site', value }, { label: 'Site', value: 'b.dev' }] }))
    expect(html).toContain(`title="${value}"`)
    expect(html).toContain('b.dev')
  })

  it('inscriptionSize: 22 portrait, 24 landscape, 19 card, stepping down to a 16 px floor', () => {
    expect(inscriptionSize(['SVNDAY', 'BAKERY'], 'portrait')).toBe(22)
    expect(inscriptionSize(['ACME'], 'landscape')).toBe(24)
    expect(inscriptionSize(['ACME'], 'card')).toBe(19)
    expect(inscriptionSize(['SUPERCALIFRAGILISTIC'], 'portrait')).toBe(16)
    const land = inscriptionSize(['SVNDAY', 'BAKERY'], 'landscape')
    expect(land).toBeGreaterThanOrEqual(16)
    expect(land).toBeLessThanOrEqual(24)
  })
})

describe('Plinth', () => {
  const persona = { name: 'Marcus', look: look() }
  it('letters MARCVS in playful and MARCUS in plain on a drawn plinth, with a hidden readable name', () => {
    const playful = render(createElement(Plinth, { persona, role: 'Copywriter', tone: 'playful' }))
    expect(playful).toContain('MARCVS')
    expect(readableText(playful)).toBe('MarcusCopywriter')
    expect(expectRomanInvariants(playful).tiles).toBe(0)
    expect(playful).toContain('preserveAspectRatio="none"')
    const plain = render(createElement(Plinth, { persona, role: 'Copywriter', tone: 'plain' }))
    expect(plain).toContain('MARCUS')
    expect(plain).not.toContain('MARCVS')
  })

  it('ellipsizes a long renamed persona in its own box and keeps the whole name in a hover title', () => {
    const long = 'Maximilianus Aurelius Constantinus'
    const html = render(createElement(Plinth, { persona: { name: long, look: look() }, role: 'Copywriter', tone: 'plain' }))
    expect(html).toContain(`title="${long}"`)
    expect(html).toContain('class="rm-plinth__carving"')
    expect(readableText(html)).toBe(`${long}Copywriter`)
  })

  it('renders a legacy agent without a persona: default bust, the role, no crash', () => {
    for (const p of [undefined, null, {}, { name: 'Lucia' }, { name: 'Lucia', look: {} as BustLook }]) {
      const html = render(createElement(Plinth, { persona: p, role: 'Researcher', tone: 'playful' }))
      expectRomanInvariants(html)
      expect(html).toContain('Researcher')
    }
    expect(readableText(render(createElement(Plinth, { persona: null, role: 'Researcher', tone: 'plain' })))).toBe('Researcher')
  })
})

describe('ArchFrame', () => {
  it('is decorative line art at .14 by default, drawable', () => {
    const html = render(createElement(ArchFrame, {}))
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('opacity:0.14')
    expect(expectRomanInvariants(html).strokes).toBeGreaterThan(20)
    expect(html).not.toContain('rm-draw')
    const drawn = render(createElement(ArchFrame, { draw: true, opacity: 0.3 }))
    expect(drawn).toContain('rm-draw')
    expect(drawn).toContain('opacity:0.3')
    expectRomanInvariants(drawn)
  })
})

describe('MosaicEmpty and the pixel wreath', () => {
  it('every motif is square palette tiles, crisp, decorative, children readable after the art', () => {
    for (const motif of ['laurel', 'amphora', 'column', 'coin', 'lamp'] as const) {
      const html = render(createElement(MosaicEmpty, { motif }, createElement('p', null, 'No tasks yet.')))
      expect(expectRomanInvariants(html).tiles).toBe(14 * 11)
      expect(html).toContain('aria-hidden="true"')
      expect(readableText(html)).toBe('No tasks yet.')
    }
  })

  it('the ceremony wreath is pixel mosaic too, animated only when asked', () => {
    const w = pixelWreath()
    const still = render(createElement(Mosaic, { tiles: w.tiles }))
    expect(expectRomanInvariants(still).tiles).toBe(w.tiles.length)
    expect(still).not.toContain('rm-tile')
    const anim = render(createElement(Mosaic, { tiles: w.tiles, order: w.order, anim: true }))
    expect(anim.match(/class="rm-tile"/g)).toHaveLength(w.tiles.length)
  })
})

describe('MilestoneCoin', () => {
  const glyphs = ['column', 'scroll', 'quill', 'seal', 'sun', 'laurel', 'dove', 'coin'] as const

  it('earned: engraved rim around pixel tiles; locked: dashed rim and tile outlines; small: line glyph', () => {
    for (const glyph of glyphs) {
      const earned = render(createElement(MilestoneCoin, { glyph, earned: true }))
      expect(earned).toContain('rm-coin--earned')
      expect(earned).not.toContain('<ellipse')
      expect(expectRomanInvariants(earned).tiles).toBeGreaterThan(5)

      const locked = render(createElement(MilestoneCoin, { glyph, earned: false }))
      expect(locked).toContain('stroke-dasharray="2 2.6"')
      expect(expectRomanInvariants(locked).tiles).toBe(0)

      const small = render(createElement(MilestoneCoin, { glyph, earned: true, size: 28 }))
      expect(small).toContain('rm-coin--line')
      expectRomanInvariants(small)
    }
  })

  it('is decorative unless titled', () => {
    expect(render(createElement(MilestoneCoin, { glyph: 'sun', earned: true }))).toContain('aria-hidden="true"')
    const locked = render(createElement(MilestoneCoin, { glyph: 'sun', earned: false, title: 'First week, locked' }))
    expect(locked).toContain('role="img"')
    expect(locked).toContain('aria-label="First week, locked"')
  })
})

describe('LatinLine', () => {
  it('renders nothing in plain', () => {
    expect(render(createElement(LatinLine, { k: 'festina', tone: 'plain' }))).toBe('')
  })

  it('in playful marks the Latin lang="la", hides it from readers and labels it with the English', () => {
    const html = render(createElement(LatinLine, { k: 'festina', tone: 'playful' }))
    expect(html).toContain('lang="la"')
    expect(html).toContain('aria-label="Make haste slowly"')
    expect(html).toContain('Festina lente')
    expect(readableText(html)).toBe('· Make haste slowly')
  })

  it('follows Settings → Tone when no tone is passed (absent = playful; plain until settings load)', async () => {
    const { setState } = await import('../../state/store')
    setState({ settings: null })
    expect(render(createElement(LatinLine, { k: 'acta' }))).not.toContain('Acta non verba')
    setState({ settings: {} as never })
    expect(render(createElement(LatinLine, { k: 'acta' }))).toContain('Acta non verba')
    setState({ settings: { tone: 'plain' } as never })
    expect(render(createElement(LatinLine, { k: 'acta' }))).not.toContain('Acta non verba')
    setState({ settings: null })
  })
})

describe('the invariant checker itself', () => {
  it('rejects material fills, gradients, warm hexes and non-.rm-la line art', () => {
    const svg = (inner: string, cls = 'rm-la'): string => `<svg class="${cls}" fill="none" stroke="#fff">${inner}</svg>`
    expect(() => expectRomanInvariants(svg('<circle r="3" fill="#888"/>'))).toThrow()
    expect(() => expectRomanInvariants(svg('<path d="M0 0" stroke="#b0773a"/>'))).toThrow()
    expect(() => expectRomanInvariants(svg('<radialGradient id="g"/>'))).toThrow()
    expect(() => expectRomanInvariants(svg('<path d="M0 0"/>', 'rm-bust'))).toThrow()
    expect(() => expectRomanInvariants(svg('<rect width="2" height="2" fill="#fff" stroke="none" rx="1"/>'))).toThrow()
    expect(() => expectRomanInvariants(svg('<path d="M0 0" stroke-width="3"/>'))).toThrow()
    // an unlisted warm "kin" colour (ochre, mustard, beige), and an off-tier opacity
    for (const warm of ['#c9a227', '#a0522d', '#e1c699', '#d97757'])
      expect(() => expectRomanInvariants(svg(`<rect width="2" height="2" fill="${warm}" stroke="none"/>`)), warm).toThrow()
    expect(() => expectRomanInvariants(svg('<path d="M0 0" stroke-opacity="0.65"/>'))).toThrow()
    for (const cool of ['#4c9cff', '#3ecf8e', '#f25c5c', '#5a3a8a', '#e6e6e9', '#141517', '#f5a524']) expect(isWarmHex(cool) && !STATUS_AMBER.has(cool), cool).toBe(false)
    expect(expectRomanInvariants(svg('<path d="M0 0"/><rect width="2" height="2" fill="#fff" stroke="none"/>'))).toEqual({ strokes: 1, tiles: 1 })
  })
})
