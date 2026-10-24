import { describe, expect, it } from 'vitest'
import { EMBLEM_VARIANTS, emblemDataUrl, emblemSvg, monogram } from './chatCompany'

describe('the generated emblem', () => {
  it('monogram: first letters of the first two words, accents folded, A-Z / digits only', () => {
    expect(monogram('Sunday Bakery')).toBe('SB')
    expect(monogram('principia')).toBe('P')
    expect(monogram('Café   Olé & co')).toBe('CO')
    expect(monogram('<script>')).toBe('S')
    expect(monogram('  ')).toBe('P')
    expect(monogram('42 labs')).toBe('4L')
  })
  it('is white line art on nothing: no fills but white, no warm colours, nothing but the monogram as text', () => {
    for (const v of EMBLEM_VARIANTS) {
      const svg = emblemSvg('Sunday Bakery', v)
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1])
      expect(new Set(colours)).toEqual(new Set(['none', '#FFFFFF']))
      expect(svg).not.toMatch(/<rect[^>]*fill="#/)
      expect(svg).toMatch(/>SB<\/text>/)
      expect(svg).not.toMatch(/<script|on\w+=/i)
    }
  })
  it('is deterministic and differs per variant', () => {
    expect(emblemSvg('Acme', 'ring')).toBe(emblemSvg('Acme', 'ring'))
    expect(new Set(EMBLEM_VARIANTS.map((v) => emblemSvg('Acme', v))).size).toBe(EMBLEM_VARIANTS.length)
    const url = emblemDataUrl('Acme', 'arch')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(atob(url.split(',')[1]!)).toBe(emblemSvg('Acme', 'arch'))
  })
})
