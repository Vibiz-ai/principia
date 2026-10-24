import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { hive: {}, addEventListener: () => {}, removeEventListener: () => {} })
const { logoFit } = await import('./logo')

/** n pixels of one RGBA colour */
const px = (n: number, rgba: [number, number, number, number]) => Array.from({ length: n }, () => rgba).flat()

describe('logoFit', () => {
  it('fills the disc when the image paints its own ground', () => {
    expect(logoFit(px(100, [255, 255, 255, 255]))).toBe('fill')
    expect(logoFit([...px(95, [20, 20, 20, 255]), ...px(5, [0, 0, 0, 0])])).toBe('fill')
  })
  it('puts a dark transparent logo on a light disc, and leaves a light one as it is', () => {
    expect(logoFit([...px(30, [0, 0, 0, 255]), ...px(70, [0, 0, 0, 0])])).toBe('backed')
    expect(logoFit([...px(30, [250, 250, 250, 255]), ...px(70, [0, 0, 0, 0])])).toBe('plain')
    expect(logoFit([...px(30, [120, 90, 255, 255]), ...px(70, [0, 0, 0, 0])])).toBe('plain')
  })
  it('an empty or fully transparent image is backed (never invisible on dark)', () => {
    expect(logoFit([])).toBe('backed')
    expect(logoFit(px(10, [255, 255, 255, 0]))).toBe('backed')
  })
})
