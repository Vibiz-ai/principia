import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BUST_BEARDS, BUST_DRAPES, BUST_HAIRS, BUST_MATERIALS, DRAPE_LINE, FACING, PERSONAS, lookFor, type BustLook
} from '@shared/personas'

// the tone fallback reads the store; server markup needs a server snapshot and a window without a bridge
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const { Bust, bustTier, DEFAULT_LOOK, EAR, EYE, MINI_FACE, MINI_BEARD, FACE, FACE_BEARD, BEARD, STUBBLE, SHOULDERS, HAIR, DRAPES } = await import('./Bust')
const { Plinth, PLINTH_LINES } = await import('./Plinth')

const look = (p: Partial<BustLook> = {}): BustLook => ({ material: 'marble', hair: 'crop', beard: 'none', laurel: false, drape: 'purple', ...p })
const render = (l: Partial<BustLook> | null | undefined, size: number, extra: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(Bust, { look: l, size, ...extra }))
const has = (html: string, d: string): boolean => html.includes(`d="${d}"`)
const MIRROR = 'transform="translate(64 0) scale(-1 1)"'
/** VOICE.md §5.2: the retired material palette, never in a bust */
const BANNED = ['#b0773a', '#d9a066', '#7a4d22', '#d4a84b', '#8a6a22', '#b5532f', '#e8dfcf', '#f3efe7', '#cdbfa5', '#a8987c', '#4a3a28', '#5c5040', '#6b5a44', '#1b1712', '#c08447', '#c56a45']
const SIZES = [16, 18, 20, 24, 28, 40, 64, 96]

/** every attribute that could paint colour: fill, stroke, stop-color, style */
function paintIssues(html: string): string[] {
  const issues: string[] = []
  for (const m of html.matchAll(/\sfill="([^"]*)"/g)) if (m[1] !== 'none') issues.push(`fill=${m[1]}`)
  for (const m of html.matchAll(/\sstroke="([^"]*)"/g)) if (m[1] !== '#fff') issues.push(`stroke=${m[1]}`)
  if (/<(linearGradient|radialGradient|pattern|filter|feTurbulence|image|text)\b/i.test(html)) issues.push('gradient/pattern/filter/image')
  if (/url\(#/.test(html)) issues.push('url() paint')
  if (/\sid="/.test(html)) issues.push('id (no defs needed)')
  if (/\s(stop-color|stop-opacity)=/.test(html)) issues.push('gradient stop')
  for (const m of html.matchAll(/style="([^"]*)"/g)) if (/fill|background|color/i.test(m[1])) issues.push(`style=${m[1]}`)
  const lower = html.toLowerCase()
  for (const hex of BANNED) if (lower.includes(hex)) issues.push(hex)
  return issues
}

const strokeWidthOf = (html: string): string => html.match(/stroke-width:([\d.]+px)/)![1]
const opacities = (html: string): Set<string> => new Set([...html.matchAll(/stroke-opacity="([^"]*)"/g)].map((m) => m[1]))

describe('Bust: line art only', () => {
  it('keeps the tier thresholds', () => {
    expect([16, 21, 22, 39, 40, 96].map(bustTier)).toEqual(['mini', 'mini', 'small', 'small', 'full', 'full'])
  })

  it('renders at 16 to 96 px with the tier viewBox and stroke width from VOICE.md §5.4', () => {
    const want: Record<number, [string, string]> = {
      16: ['13 9.4 38 38', '1.25px'], 18: ['13 9.4 38 38', '1.25px'], 20: ['13 9.4 38 38', '1.25px'],
      24: ['7 6 50 50', '1px'], 28: ['7 6 50 50', '1px'],
      40: ['0 0 64 64', '1px'], 64: ['0 0 64 64', '1px'], 96: ['0 0 64 64', '1.2px']
    }
    for (const size of SIZES) {
      const html = render(look({ laurel: true }), size)
      expect(html).toContain(`viewBox="${want[size][0]}"`)
      expect(strokeWidthOf(html)).toBe(want[size][1])
      expect(html).toContain(`width="${size}"`)
      expect(html).toContain('class="rm-la rm-bust')
    }
  })

  it('has no fill but none, no gradients, no colour and none of the banned hexes, for every look and size', () => {
    for (const hair of BUST_HAIRS)
      for (const beard of BUST_BEARDS)
        for (const material of BUST_MATERIALS)
          for (const drape of BUST_DRAPES)
            for (const laurel of [false, true])
              for (const size of [16, 28, 64, 96]) {
                const html = render({ hair, beard, material, drape, laurel }, size, { ring: true })
                expect(paintIssues(html), `${hair}/${beard}/${material}/${drape}/${laurel}@${size}`).toEqual([])
              }
  })

  it('uses only the three stroke tiers, 1.5 px at most', () => {
    for (const size of SIZES) {
      const html = render(look({ laurel: true, beard: 'full', drape: 'gold' }), size, { ring: true })
      for (const o of opacities(html)) expect(['0.9', '0.5', '0.2']).toContain(o)
      expect(parseFloat(strokeWidthOf(html))).toBeLessThanOrEqual(1.5)
    }
  })

  it('mini is a coin head: no eye, ear, shoulders, drapery or socle; exactly one cue', () => {
    for (const hair of BUST_HAIRS)
      for (const beard of BUST_BEARDS)
        for (const drape of BUST_DRAPES)
          for (const laurel of [false, true]) {
            const html = render(look({ hair, beard, drape, laurel }), 16)
            expect(has(html, EYE)).toBe(false)
            expect(html).not.toContain('M38.3 25.2') // the one-line eye
            expect(has(html, EAR)).toBe(false)
            for (const d of SHOULDERS) expect(has(html, d)).toBe(false)
            for (const lines of Object.values(DRAPES)) for (const [d] of lines) expect(has(html, d)).toBe(false)
            expect(html).not.toContain('M24.2 58.8') // socle
            expect(has(html, STUBBLE)).toBe(false)
            const leaves = (html.match(/rm-bust__leaf/g) ?? []).length
            expect(leaves).toBe(laurel ? 4 : 0)
            // the beard is the cue only without a laurel
            expect(has(html, MINI_BEARD)).toBe(!laurel && beard === 'full')
            expect(has(html, MINI_FACE)).toBe(!(!laurel && beard === 'full'))
            expect(has(html, HAIR[hair].outline)).toBe(true)
          }
  })

  it('small has the one-line eye and shoulders but no ear and no socle; full has the ear, eye and socle', () => {
    const small = render(look({ laurel: true }), 28)
    expect(small).toContain('M38.3 25.2 L40.2 25.4')
    expect(has(small, EYE)).toBe(false)
    expect(has(small, EAR)).toBe(false)
    expect(small).not.toContain('M24.2 58.8')
    for (const d of SHOULDERS) expect(has(small, d)).toBe(true)
    expect((small.match(/rm-bust__leaf/g) ?? []).length).toBe(10)
    // every other lock at small, all eight at full
    const locks = (html: string): number => HAIR.crop.lines.filter(([d]) => has(html, d)).length
    expect(locks(small)).toBe(4)

    const full = render(look({ laurel: true }), 64)
    expect(has(full, EYE)).toBe(true)
    expect(has(full, EAR)).toBe(true)
    expect(full).toContain('M24.2 58.8')
    expect((full.match(/rm-bust__leaf/g) ?? []).length).toBe(16)
    expect(locks(full)).toBe(8)
    expect(render(look(), 64, { socle: false })).not.toContain('M24.2 58.8')
  })

  it('mirrors the left-facing looks (travertine, terracotta) and leaves the right-facing ones as drawn', () => {
    for (const material of BUST_MATERIALS)
      for (const size of [16, 28, 64]) {
        const html = render(look({ material }), size)
        expect(html.includes(MIRROR), `${material}@${size}`).toBe(FACING[material] === 'left')
        expect(html).toContain(`data-facing="${FACING[material]}"`)
      }
    expect(FACING).toEqual({ marble: 'right', bronze: 'right', travertine: 'left', terracotta: 'left' })
  })

  it('keeps the ring outside the mirror so it stays centred', () => {
    const html = render(look({ material: 'terracotta' }), 28, { ring: true })
    expect(html.indexOf('rm-bust__ring')).toBeLessThan(html.indexOf(MIRROR))
    expect(render(look(), 28)).not.toContain('rm-bust__ring')
    for (const size of [16, 28, 64]) expect(render(look(), size, { ring: true })).toContain('stroke-opacity="0.2"')
  })

  it('draws every hair, beard and drape combination, distinct and deterministic', () => {
    for (const size of [16, 28, 64]) {
      const seen = new Set<string>()
      for (const hair of BUST_HAIRS)
        for (const beard of BUST_BEARDS)
          for (const drape of BUST_DRAPES) {
            const html = render(look({ hair, beard, drape }), size)
            expect(html.startsWith('<svg')).toBe(true)
            expect(render(look({ hair, beard, drape }), size)).toBe(html)
            expect(has(html, HAIR[hair].outline)).toBe(true)
            if (size > 16) {
              expect(has(html, DRAPES[DRAPE_LINE[drape]][0][0])).toBe(true)
              expect(has(html, beard === 'full' ? FACE_BEARD : FACE)).toBe(true)
              expect(has(html, BEARD)).toBe(beard === 'full')
              expect(has(html, STUBBLE)).toBe(beard === 'stubble')
            }
            seen.add(html)
          }
      // mini has no drapery and folds hair cues together, so only small and full must be fully distinct
      if (size > 16) expect(seen.size).toBe(BUST_HAIRS.length * BUST_BEARDS.length * BUST_DRAPES.length)
    }
  })

  it('draws the stubble as a dotted jaw line', () => {
    const html = render(look({ beard: 'stubble' }), 64)
    expect(html).toContain('stroke-dasharray=".01 1.7"')
  })

  it('maps the legacy drape keys to drapery lines', () => {
    expect(DRAPE_LINE).toEqual({ purple: 'toga', terracotta: 'cloak', gold: 'tunic', marble: 'herm' })
    expect(Object.keys(DRAPES).sort()).toEqual(['cloak', 'herm', 'toga', 'tunic'])
  })

  it('is decorative unless titled', () => {
    expect(render(look(), 28)).toContain('aria-hidden="true"')
    const titled = render(look(), 28, { title: 'Marcus, Copywriter' })
    expect(titled).toContain('role="img"')
    expect(titled).toContain('aria-label="Marcus, Copywriter"')
    expect(titled).not.toContain('aria-hidden')
  })

  it('falls back to the default look for missing, partial or unknown looks', () => {
    const def = render(DEFAULT_LOOK, 28)
    expect(render(undefined, 28)).toBe(def)
    expect(render(null, 28)).toBe(def)
    expect(render({}, 28)).toBe(def)
    const odd = { material: 'jade', hair: 'mohawk', beard: 'goatee', drape: 'neon' } as unknown as BustLook
    expect(render(odd, 28)).toBe(def)
    expect(renderToStaticMarkup(createElement(Bust, { look: look(), size: Number.NaN }))).toContain('width="32"')
  })
})

describe('lookFor stays put', () => {
  it('gives the same faces for the same seeds as before the line-art rewrite (pinned from HEAD)', () => {
    // VOICE.md §5.4: the stored keys are reinterpreted, never migrated, so no persona changes face
    const pins: readonly (readonly [string, string, BustLook])[] = [
      ['marcus', 'c1:a1', { material: 'terracotta', hair: 'crop', beard: 'none', laurel: true, drape: 'marble' }],
      ['marcus', 'acme:agent-7', { material: 'marble', hair: 'crop', beard: 'none', laurel: true, drape: 'purple' }],
      ['marcus', 'x:y', { material: 'bronze', hair: 'crop', beard: 'none', laurel: true, drape: 'marble' }],
      ['vitruvius', 'c1:a1', { material: 'terracotta', hair: 'crop', beard: 'full', laurel: true, drape: 'marble' }],
      ['vitruvius', 'acme:agent-7', { material: 'marble', hair: 'crop', beard: 'full', laurel: true, drape: 'purple' }],
      ['vitruvius', 'x:y', { material: 'bronze', hair: 'crop', beard: 'full', laurel: false, drape: 'marble' }],
      ['petronia', 'c1:a1', { material: 'terracotta', hair: 'veil', beard: 'none', laurel: true, drape: 'marble' }],
      ['petronia', 'acme:agent-7', { material: 'marble', hair: 'veil', beard: 'none', laurel: true, drape: 'purple' }],
      ['petronia', 'x:y', { material: 'bronze', hair: 'veil', beard: 'none', laurel: false, drape: 'marble' }],
      ['flavia', 'c1:a1', { material: 'terracotta', hair: 'bun', beard: 'none', laurel: true, drape: 'marble' }],
      ['flavia', 'acme:agent-7', { material: 'marble', hair: 'bun', beard: 'none', laurel: true, drape: 'purple' }],
      ['flavia', 'x:y', { material: 'bronze', hair: 'bun', beard: 'none', laurel: false, drape: 'marble' }]
    ]
    for (const [key, seed, want] of pins) expect(lookFor(PERSONAS.find((p) => p.key === key)!, seed), `${key} ${seed}`).toEqual(want)
  })
})

describe('Plinth: drawn plinth with the lettered name', () => {
  it('draws the plinth as strokes only, stretched with non-scaling strokes', () => {
    const html = renderToStaticMarkup(createElement(Plinth, { persona: { name: 'Marcus', look: look({ laurel: true }) }, role: 'Copywriter', tone: 'playful' }))
    expect(html).toContain('preserveAspectRatio="none"')
    for (const [d] of PLINTH_LINES) expect(html).toContain(`d="${d}"`)
    expect(paintIssues(html)).toEqual([])
    expect(html).toContain('MARCVS')
    expect(html).toContain('<span class="rm-sr">Marcus</span>')
    // the plinth bust has no socle and no ring
    expect(html).not.toContain('M24.2 58.8')
    expect(html).not.toContain('rm-bust__ring')
  })

  it('letters MARCUS in plain, with no surface variant', () => {
    const plain = renderToStaticMarkup(createElement(Plinth, { persona: { name: 'Marcus', look: look() }, role: 'Copywriter', tone: 'plain' }))
    expect(plain).toContain('MARCUS')
    expect(plain).not.toMatch(/rm-plinth--|rm-stone|rm-carved/)
  })

  it('renders a legacy agent without a persona', () => {
    for (const persona of [undefined, null, {}, { name: 'Lucia' }]) {
      const html = renderToStaticMarkup(createElement(Plinth, { persona, role: 'Researcher', tone: 'playful' }))
      expect(html).toContain('<svg')
      expect(html).toContain('Researcher')
    }
  })
})
