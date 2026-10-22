// "Open on your phone": the QR encoder against published vectors (ISO/IEC 18004 tables; the RS example is the
// 1-M "HELLO WORLD" codewords from the Thonky QR tutorial) plus structural checks on the matrix.
import { describe, expect, it } from 'vitest'
import { dataStream, encodeQr, formatBits, gfMul, interleave, penalty, qrPath, rsDivisor, rsRemainder, versionBits, versionFor } from './cloudQr'

const bin = (n: number, w: number): string => n.toString(2).padStart(w, '0')

describe('Reed-Solomon', () => {
  it('GF(256) multiply with 0x11D', () => {
    expect(gfMul(0x80, 2)).toBe(0x1d)
    expect(gfMul(3, 7)).toBe(9)
    expect(gfMul(0, 0xff)).toBe(0)
  })
  it('1-M HELLO WORLD: 16 data codewords give the published 10 EC codewords', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })
})

describe('format and version information', () => {
  it('level M format strings for the eight masks', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((m) => bin(formatBits(m), 15))).toEqual([
      '101010000010010',
      '101000100100101',
      '101111001111100',
      '101101101001011',
      '100010111111001',
      '100000011001110',
      '100111110010111',
      '100101010100000'
    ])
  })
  it('version information for 7 to 10', () => {
    expect([7, 8, 9, 10].map((v) => bin(versionBits(v), 18))).toEqual(['000111110010010100', '001000010110111100', '001001101010011001', '001010010011010011'])
  })
})

describe('data', () => {
  it('picks the smallest version for byte mode at level M (14, 26, 42, 62 bytes for 1..4; 213 for 10)', () => {
    expect([14, 15, 26, 27, 42, 62, 213].map(versionFor)).toEqual([1, 2, 2, 3, 3, 4, 10])
    expect(versionFor(214)).toBeNull()
  })
  it('mode, count, data, terminator and pad codewords', () => {
    const s = dataStream([0x41], 1)
    expect(s.length).toBe(16)
    expect(s.slice(0, 3)).toEqual([0x40, 0x14, 0x10])
    expect(s.slice(3, 7)).toEqual([0xec, 0x11, 0xec, 0x11])
  })
  it('interleaves short blocks before long ones (version 8: 2x38 + 2x39 data, 22 EC each)', () => {
    const data = Array.from({ length: 154 }, (_, i) => i & 0xff)
    const out = interleave(data, 8)
    expect(out.length).toBe(242)
    expect(out.slice(0, 4)).toEqual([0, 38, 76, 115])
    // the extra 39th codeword of the long blocks comes after the 38th of every block
    expect(out.slice(152, 154)).toEqual([114, 153])
  })
})

describe('matrix', () => {
  const finderAt = (m: boolean[][], x: number, y: number): boolean => {
    for (let dy = 0; dy < 7; dy++)
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        if (m[y + dy][x + dx] !== (ring !== 2)) return false
      }
    return true
  }
  it('a console login link: finders, timing, dark module and format bits are where the standard puts them', () => {
    const q = encodeQr('https://cloud.lautaro.dev/console/login?t=pll_3fQ9xZ2kLm8RtY7wVb1N')
    expect(q.version).toBe(5)
    expect(q.size).toBe(37)
    const m = q.modules
    expect(finderAt(m, 0, 0) && finderAt(m, q.size - 7, 0) && finderAt(m, 0, q.size - 7)).toBe(true)
    for (let i = 8; i < q.size - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0)
      expect(m[i][6]).toBe(i % 2 === 0)
    }
    expect(m[q.size - 8][8]).toBe(true)
    // first format copy, read back
    const f = formatBits(q.mask)
    const read = [0, 1, 2, 3, 4, 5].map((i) => m[i][8]).concat([m[7][8], m[8][8], m[8][7]], [5, 4, 3, 2, 1, 0].map((x) => m[8][x]))
    expect(read.map((b) => (b ? '1' : '0')).join('')).toBe(bin(f, 15).split('').reverse().join(''))
  })
  it('version 7+ carries the version blocks; the lowest-penalty mask wins', () => {
    const long = `https://cloud.example.com/console/login?t=pll_${'x'.repeat(120)}`
    const q = encodeQr(long)
    expect(q.version).toBeGreaterThanOrEqual(7)
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => penalty(encodeQr(long, { mask: k }).modules))
    expect(scores[q.mask]).toBe(Math.min(...scores))
  })
  it('too long throws (the pane falls back to Copy)', () => {
    expect(() => encodeQr('x'.repeat(300))).toThrow(/Too long/)
  })
  it('the SVG path draws only dark modules, offset by the quiet zone', () => {
    const q = encodeQr('hi')
    const path = qrPath(q)
    const dark = q.modules.flat().filter(Boolean).length
    expect(path.match(/M/g)?.length).toBe(dark)
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true)
  })
})
