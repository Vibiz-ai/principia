import { describe, expect, it } from 'vitest'
import { INSCRIPTION_MAX, fnv1a, inscription, toRoman } from './roman'

describe('toRoman', () => {
  it('converts known numerals', () => {
    expect(toRoman(1)).toBe('I')
    expect(toRoman(2)).toBe('II')
    expect(toRoman(4)).toBe('IV')
    expect(toRoman(9)).toBe('IX')
    expect(toRoman(14)).toBe('XIV')
    expect(toRoman(40)).toBe('XL')
    expect(toRoman(90)).toBe('XC')
    expect(toRoman(400)).toBe('CD')
    expect(toRoman(1994)).toBe('MCMXCIV')
    expect(toRoman(2026)).toBe('MMXXVI')
    expect(toRoman(3999)).toBe('MMMCMXCIX')
  })
  it('rejects values outside 1..3999 and non-integers', () => {
    expect(() => toRoman(0)).toThrow(RangeError)
    expect(() => toRoman(4000)).toThrow(RangeError)
    expect(() => toRoman(-3)).toThrow(RangeError)
    expect(() => toRoman(2.5)).toThrow(RangeError)
    expect(() => toRoman(Number.NaN)).toThrow(RangeError)
  })
})

describe('fnv1a', () => {
  it('matches the reference vectors and stays uint32', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
    for (const s of ['co_1:agent', 'x'.repeat(500), 'Ünïcødé']) {
      const h = fnv1a(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(2 ** 32)
    }
  })
  it('is deterministic', () => {
    expect(fnv1a('co_1:marketing')).toBe(fnv1a('co_1:marketing'))
    expect(fnv1a('co_1:a')).not.toBe(fnv1a('co_1:b'))
  })
})

describe('inscription', () => {
  it('carves Sunday Bakery in both tones', () => {
    expect(inscription('Sunday Bakery', { classical: true })).toEqual({ parts: ['SVNDAY', 'BAKERY'], text: 'SVNDAY·BAKERY' })
    expect(inscription('Sunday Bakery')).toEqual({ parts: ['SUNDAY', 'BAKERY'], text: 'SUNDAY·BAKERY' })
    expect(inscription('Sunday Bakery', { classical: false }).text).toBe('SUNDAY·BAKERY')
  })
  it('uses classical letters: U -> V, J -> I', () => {
    expect(inscription('Jupiter', { classical: true }).text).toBe('IVPITER')
    expect(inscription('jupiter').text).toBe('JUPITER')
  })
  it('collapses whitespace', () => {
    expect(inscription('  Acme \n\t  Labs  ').text).toBe('ACME·LABS')
    expect(inscription('   ')).toEqual({ parts: [], text: '' })
    expect(inscription('')).toEqual({ parts: [], text: '' })
  })
  it('caps the text at 60 characters', () => {
    const long = inscription('word '.repeat(40))
    expect(long.text.length).toBeLessThanOrEqual(INSCRIPTION_MAX)
    expect(long.text).toBe(long.parts.join('·'))
    const one = inscription('a'.repeat(100))
    expect(one.text).toBe('A'.repeat(60))
    expect(one.parts).toEqual(['A'.repeat(60)])
  })
  it('never cuts an emoji in half at the cap', () => {
    const r = inscription('A'.repeat(59) + '😀')
    expect(r.text).toBe('A'.repeat(59))
    expect(/[\uD800-\uDBFF]$/.test(r.text)).toBe(false)
    expect(inscription('AB ' + '😀'.repeat(40)).parts[0]).toBe('AB')
  })
})
