import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripTags } from '@shared/stripAll'

// the tone fallback reads the store; server markup needs a server snapshot and a window without a bridge
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const useSyncExternalStore = <T,>(sub: (cb: () => void) => () => void, get: () => T): T => actual.useSyncExternalStore(sub, get, get)
  return { ...actual, default: { ...actual, useSyncExternalStore }, useSyncExternalStore }
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })

const { PassportTablet, inscriptionSize } = await import('./PassportTablet')
const { Seal, SEAL_WREATH } = await import('./Seal')
const { ROUNDEL } = await import('./geometry')

type TabletProps = Parameters<typeof PassportTablet>[0]
const pp = (p: Partial<TabletProps> = {}): string =>
  renderToStaticMarkup(createElement(PassportTablet, { name: 'Sunday Bakery', color: '#4c9cff', tone: 'playful', founded: 2026, ...p }))
const seal = (p: Partial<Parameters<typeof Seal>[0]> = {}): string => renderToStaticMarkup(createElement(Seal, { name: 'Sunday Bakery', color: '#4c9cff', pressed: true, ...p }))
const count = (html: string, needle: string | RegExp): number => (typeof needle === 'string' ? html.split(needle).length - 1 : (html.match(needle) ?? []).length)
/** the inscription element's inner markup */
const insOf = (html: string): string => html.match(/<div class="rm-pp__ins"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
/** text a screen reader can reach: drop aria-hidden subtrees, then all tags */
function readableText(html: string): string {
  let out = html
  for (const tag of ['svg', 'span', 'div', 'i']) out = out.replace(new RegExp(`<${tag}\\b[^>]*aria-hidden="true"[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '')
  return out.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const LAYOUTS = ['portrait', 'landscape', 'card'] as const
/** VOICE.md §5.12: the retired material palette, never in these files */
const BANNED_HEX = ['#b0773a', '#d9a066', '#7a4d22', '#d4a84b', '#8a6a22', '#b5532f', '#e8dfcf', '#f3efe7', '#cdbfa5', '#a8987c', '#4a3a28', '#5c5040', '#6b5a44', '#1b1712', '#c08447', '#c56a45']

describe('PassportTablet: line-art passport (VOICE.md §5.3)', () => {
  it.each(LAYOUTS)('%s: engraved card, no material classes', (layout) => {
    const h = pp({ layout, sealed: true, meta: [{ label: 'Site', value: 'sundaybakery.com' }] })
    expect(h).toMatch(new RegExp(`^<div class="rm-pp rm-pp--${layout}`))
    for (const banned of ['rm-stone', 'rm-bronze', 'rm-carved', 'rm-tablet', 'rm-marble', 'rm-gilt', 'inlay', 'radialGradient', 'color-mix']) expect(h).not.toContain(banned)
    for (const hex of BANNED_HEX) expect(h.toLowerCase()).not.toContain(hex)
    // the double rule's four corner lozenges
    expect(count(h, /class="rm-cn rm-cn[0-3]" aria-hidden="true"/g)).toBe(4)
    // label and pediment
    expect(h).toContain('BUSINESS PASSPORT')
    expect(count(h, 'rm-pp__pedsvg')).toBe(1)
  })

  it('draws the pediment at the size each layout asks for', () => {
    expect(pp({ layout: 'portrait' })).toContain('viewBox="0 0 236 44"')
    expect(pp({ layout: 'landscape' })).toContain('viewBox="0 0 500 50"')
    expect(pp({ layout: 'card' })).toContain('viewBox="0 0 250 32"')
  })

  it('puts the company colour in exactly one pediment tessera (plus the seal accent), nowhere else', () => {
    const open = pp({ color: '#ff3366', sealed: false })
    expect(count(open, 'rm-pp__tessera')).toBe(1)
    expect(open).toMatch(/class="rm-pp__tessera"[^>]*width="5" height="5"[^>]*style="fill:#ff3366"/)
    expect(count(open, '#ff3366')).toBe(1)
    const sealed = pp({ color: '#ff3366', sealed: true })
    expect(count(sealed, '#ff3366')).toBe(2)
    expect(sealed).toMatch(/class="rm-seal__accent"[^>]*style="fill:#ff3366"/)
    // no colour yet: the tessera is a quiet grey, never a material
    expect(pp({ color: undefined })).toMatch(/class="rm-pp__tessera"[^>]*style="fill:var\(--text-tertiary\)"/)
  })

  it.each(LAYOUTS)('%s: the seal sits inside the passport frame', (layout) => {
    const h = pp({ layout, sealed: true })
    const at = h.indexOf('rm-pp__seal')
    expect(at).toBeGreaterThan(0)
    expect(count(h, 'class="rm-seal ')).toBe(1)
    // the passport's root div closes after the seal: nothing is rendered outside .rm-pp
    expect(h.startsWith('<div class="rm-pp ')).toBe(true)
    expect(h.endsWith('</div>')).toBe(true)
    if (layout !== 'card') expect(h).toMatch(/<div class="rm-pp__foot">[\s\S]*rm-pp__founded[\s\S]*rm-pp__seal/)
  })

  it('sizes the seal per layout: 56 portrait, 72 landscape, 36 card', () => {
    expect(pp({ layout: 'portrait', sealed: true })).toMatch(/rm-seal__svg"[^>]*width="56"/)
    expect(pp({ layout: 'landscape', sealed: true })).toMatch(/rm-seal__svg"[^>]*width="72"/)
    expect(pp({ layout: 'card', sealed: true })).toMatch(/rm-seal__svg"[^>]*width="36"/)
  })

  it('breaks the inscription only after interpuncts', () => {
    const ins = insOf(pp({ name: 'Sunday Bakery of Lisbon' }))
    expect(ins).toBe(
      'SVNDAY<span class="rm-pp__dot">·</span><wbr/>BAKERY<span class="rm-pp__dot">·</span><wbr/>OF<span class="rm-pp__dot">·</span><wbr/>LISBON'
    )
    // every break opportunity follows an interpunct, and every interpunct is followed by one
    expect(count(ins, '<wbr/>')).toBe(3)
    expect(count(ins, '<span class="rm-pp__dot">·</span><wbr/>')).toBe(3)
    // words carry no break opportunity of their own (no spaces, no soft hyphens)
    expect(stripTags(ins)).not.toMatch(/[\s\u00ad\u200b-]/)
    // a single word: no interpunct, no break
    expect(insOf(pp({ name: 'Northwind' }))).toBe('NORTHWIND')
  })

  it('keeps the readable name accessible and hides the inscription', () => {
    const portrait = pp({ oneLiner: 'Sourdough delivered to offices', meta: [{ label: 'Site', value: 'sundaybakery.com' }] })
    expect(portrait).toMatch(/<div class="rm-pp__ins" aria-hidden="true" style="font-size:22px">/)
    expect(portrait).toContain('<div class="rm-pp__name">Sunday Bakery</div>')
    expect(portrait).toContain('<div class="rm-pp__line">Sourdough delivered to offices</div>')
    expect(portrait).toContain('<div class="rm-pp__row"><span>Site</span><b title="sundaybakery.com">sundaybakery.com</b></div>')
    const text = readableText(portrait)
    expect(text).not.toContain('SVNDAY')
    expect(text).toContain('Sunday Bakery')
    // card: the name is visually hidden but still read; no meta, no founding line
    const card = pp({ layout: 'card', meta: [{ label: 'Site', value: 'x.com' }] })
    expect(card).toContain('<span class="rm-sr">Sunday Bakery</span>')
    expect(card).not.toContain('rm-pp__meta')
    expect(card).not.toContain('rm-pp__founded')
    expect(card).toMatch(/style="font-size:19px"/)
  })

  it('writes the founding line in both tones, with the plain year for screen readers in playful', () => {
    const playful = pp({ tone: 'playful' })
    expect(playful).toContain('<div class="rm-pp__founded" title="2026"><span aria-hidden="true">FOUNDED · MMXXVI</span><span class="rm-sr">')
    expect(readableText(playful)).toContain('2026')
    expect(readableText(playful)).not.toContain('MMXXVI')
    const plain = pp({ tone: 'plain' })
    expect(plain).toContain('<div class="rm-pp__founded">FOUNDED 2026</div>')
    expect(plain).toContain('SUNDAY')
    expect(plain).not.toContain('SVNDAY')
  })

  it('shows the empty passport as a form being filled in', () => {
    const h = pp({ name: '   ', sealed: false })
    expect(h).toContain('<div class="rm-pp__ins is-empty">Your business</div>')
    expect(h).not.toContain('rm-pp__name')
    expect(h).toMatch(/<div class="rm-pp__meta rm-pp__meta--ghost" aria-hidden="true">/)
    expect(count(h, '<b>not yet</b>')).toBe(3)
    // real meta replaces the ghost rows
    expect(pp({ name: '', meta: [{ label: 'Site', value: 'a.b' }] })).not.toContain('rm-pp__meta--ghost')
    // a named passport without meta has no rows at all
    expect(pp({ meta: [] })).not.toContain('rm-pp__meta')
  })
})

describe('inscriptionSize', () => {
  it('starts at 22 portrait, 24 landscape, 19 card', () => {
    expect(inscriptionSize(['ACME'], 'portrait')).toBe(22)
    expect(inscriptionSize(['ACME'], 'landscape')).toBe(24)
    expect(inscriptionSize(['ACME'], 'card')).toBe(19)
    expect(inscriptionSize([], 'card')).toBe(19)
    expect(inscriptionSize(['SVNDAY', 'BAKERY'], 'portrait')).toBe(22)
  })

  it('steps down to a 16 px floor for long words', () => {
    expect(inscriptionSize(['SUPERCALIFRAGILISTIC'], 'portrait')).toBe(16)
    expect(inscriptionSize(['SUPERCALIFRAGILISTICEXPIALIDOCIOUS'], 'card')).toBe(16)
  })

  it('fits the whole landscape line, since landscape never wraps', () => {
    const one = inscriptionSize(['SVNDAY', 'BAKERY'], 'landscape')
    expect(one).toBeLessThan(24)
    expect(one).toBeGreaterThanOrEqual(16)
    expect(inscriptionSize(['SVNDAY', 'BAKERY', 'OF', 'LISBON'], 'landscape')).toBeLessThanOrEqual(one)
    const h = pp({ layout: 'landscape' })
    expect(h).toContain(`style="font-size:${one}px"`)
    // too long even at 16 px: wraps after an interpunct rather than overflowing the card
    expect(pp({ layout: 'landscape', name: 'The Very Long Name Of A Bakery In Lisbon' })).toMatch(/style="font-size:16px;white-space:normal;overflow-wrap:anywhere"/)
  })
})

describe('Seal: line laurel roundel (VOICE.md §5.3)', () => {
  it('labels both states for screen readers', () => {
    expect(seal({ pressed: false })).toContain('role="img" aria-label="Not launched yet"')
    expect(seal({ pressed: true })).toContain('role="img" aria-label="Launched"')
  })

  it('draws the sealed roundel as strokes only: ground disc, rings, beads, wreath, outlined initial, one tessera', () => {
    const h = seal()
    expect(h).toContain('rm-seal--pressed')
    expect(h).toContain('class="rm-la rm-seal__svg"')
    expect(h).toMatch(/class="rm-seal__ground"[^>]*r="31.5"[^>]*style="fill:var\(--rm-ink\)"/)
    for (const r of [ROUNDEL.outer, ROUNDEL.beads, ROUNDEL.inner]) expect(h).toContain(`r="${r}"`)
    expect(h).toContain('stroke-dasharray=".01 2.3"')
    // 8 pairs + a tip leaf per branch
    expect(count(h, /<path d="M-2\.50 0Q0 -1\.75 2\.50 0Q0 1\.75 -2\.50 0Z"/g)).toBe(2 * (SEAL_WREATH.pairs * 2 + 1))
    expect(h).toMatch(/<text class="rm-seal__initial"[^>]*font-weight="600"[^>]*font-size="18.5" fill="none"[^>]*>S<\/text>/)
    expect(count(h, '<rect')).toBe(1)
    expect(h).toMatch(/<rect class="rm-seal__accent"[^>]*width="3.4" height="3.4"[^>]*style="fill:#4c9cff"/)
  })

  it('takes the ground it sits on', () => {
    expect(seal({ ground: 'var(--surface-1)' })).toMatch(/class="rm-seal__ground"[^>]*style="fill:var\(--surface-1\)"/)
  })

  it('shows the unsealed outline: a dashed .2 circle and a ghost initial', () => {
    const h = seal({ pressed: false })
    expect(h).toContain('rm-seal--open')
    expect(h).toMatch(/<circle cx="32" cy="32" r="27" stroke-opacity="0.2" stroke-dasharray="2 3"/)
    expect(h).toMatch(/<text class="rm-seal__initial"[^>]*fill="none" stroke-opacity="0.22">S<\/text>/)
    expect(h).not.toContain('rm-seal__ground')
    expect(h).not.toContain('<rect')
    expect(h).not.toContain('rm-draw')
  })

  it('stamps by drawing strokes, never by scaling: rings, beads, leaves, initial, then the tessera', () => {
    const h = seal({ stamp: true })
    expect(h).toContain('rm-seal--stamp')
    // only the leaves are placed with transforms; nothing on the seal itself scales or turns
    expect(h).not.toMatch(/scale\(|rm-press|rm-seal__chip/)
    expect(h.replace(/<path d="M-2\.50[^>]*>/g, '')).not.toContain('transform')
    // the two rings draw first (pathLength 1)
    expect(count(h, /<circle[^>]*pathLength="1" class="rm-draw"/g)).toBe(2)
    // the beads and the tessera appear (opacity steps), the beads at 300 ms, the tessera last at 700 ms
    expect(h).toMatch(/class="rm-seal__beads rm-tile"[^>]*--rm-delay:300ms/)
    expect(h).toMatch(/class="rm-seal__accent rm-tile"[^>]*--rm-delay:700ms/)
    // leaves draw pair by pair from 300 ms
    expect(h).toContain('style="--rm-delay:300ms"><g class="rm-laurel rm-laurel--draw"')
    expect(h).toMatch(/<path d="M-2\.50[^"]*"[^>]*class="rm-draw" style="--i:\d+"/)
    // the initial draws at 500 ms
    expect(h).toMatch(/class="rm-seal__initial rm-draw"[^>]*--rm-delay:500ms/)
    // `draw` is an alias
    expect(seal({ draw: true })).toContain('rm-seal--stamp')
    // stamping an unsealed seal does nothing
    expect(seal({ pressed: false, stamp: true })).not.toContain('rm-seal--stamp')
    // without stamp the end state is static
    expect(seal()).not.toMatch(/rm-draw|rm-tile|rm-seal--stamp/)
  })

  it('keeps the stroke tiers: 0.9 px on the 36 px card, 1 px at 56 to 80, 1.2 px above 80, and ring opacities .9 / .5 / .2', () => {
    expect(seal({ size: 36 })).toContain('style="stroke-width:0.9"')
    expect(seal({ size: 56 })).toContain('style="stroke-width:1"')
    expect(seal({ size: 72 })).toContain('style="stroke-width:1"')
    expect(seal({ size: 96 })).toMatch(/style="stroke-width:1.2/)
    const h = seal()
    expect(h).toContain(`r="${ROUNDEL.outer}" stroke-opacity="0.9"`)
    expect(h).toContain(`r="${ROUNDEL.beads}" stroke-opacity="0.5"`)
    expect(h).toContain(`r="${ROUNDEL.inner}" stroke-opacity="0.2"`)
    // nothing thicker than 1.5 px anywhere (the bead dots are the 1.3 px exception in the spec)
    for (const m of (seal({ size: 100 }) + pp() + pp({ layout: 'card' })).matchAll(/stroke-width(?:="|:)([\d.]+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(1.5)
  })

  it('carries no wax, purple, gradient or material', () => {
    const h = seal({ stamp: true }) + seal({ pressed: false })
    for (const banned of ['radialGradient', 'color-mix', 'rm-purple', 'rm-terracotta', 'url(#']) expect(h).not.toContain(banned)
  })
})

describe('source hygiene', () => {
  it('has no banned hex, material class or wax path in the passport and seal sources', () => {
    for (const f of ['./PassportTablet.tsx', './Seal.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8').toLowerCase()
      for (const hex of BANNED_HEX) expect(src).not.toContain(hex)
      for (const banned of ['waxpath', 'rm-stone', 'rm-bronze', 'rm-carved', 'marble', 'carve', 'rm-purple', 'color-mix', 'chips']) expect(src).not.toContain(banned)
      for (const word of ['bronze', 'travertine', 'terracotta', 'beige', 'copper', 'gold', 'ochre', 'mustard', 'brown', 'radial-gradient']) expect(src).not.toContain(word)
      // the only literal colour is line-art white
      expect([...new Set(src.match(/#[0-9a-f]{3,8}\b/g) ?? [])]).toEqual(['#fff'])
    }
  })
})
