/**
 * VOICE.md §5.3, §4.1, §7: small, pure Roman helpers shared by main and the renderer. Numerals are for dates and
 * decoration only (VOICE.md §1), never for quantities the user acts on.
 */

const NUMERALS: readonly [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
]

/** 1..3999 as a Roman numeral (2026 -> MMXXVI). Throws a RangeError outside that range or for non-integers. */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError(`toRoman: ${n} is outside 1..3999`)
  let rest = n
  let out = ''
  for (const [value, glyph] of NUMERALS) {
    while (rest >= value) {
      out += glyph
      rest -= value
    }
  }
  return out
}

/** 32-bit FNV-1a over the string's UTF-16 code units. Always a uint32 (0..2^32-1), stable across processes. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export const INSCRIPTION_MAX = 60
export const INTERPUNCT = '·'

export interface Inscription {
  /** the words, already uppercased (and classical when asked); a component joins them with `·` + `<wbr>` */
  parts: string[]
  /** parts joined by `·`, at most INSCRIPTION_MAX characters */
  text: string
}

/**
 * VOICE.md §5.3: the carved name. Uppercase, whitespace collapsed, words joined by a raised interpunct. `classical`
 * (playful tone) uses Roman letters: U -> V, J -> I. 'Sunday Bakery' -> SVNDAY·BAKERY. Capped at 60 characters; a
 * word that would cross the cap is cut, and nothing after it is kept.
 */
export function inscription(name: string, opts: { classical?: boolean } = {}): Inscription {
  let upper = (name ?? '').toUpperCase()
  if (opts.classical) upper = upper.replace(/U/g, 'V').replace(/J/g, 'I')
  const words = upper.split(/\s+/).filter(Boolean)
  const parts: string[] = []
  let length = 0
  for (const w of words) {
    const sep = parts.length ? 1 : 0
    const room = INSCRIPTION_MAX - length - sep
    if (room <= 0) break
    if (w.length <= room) {
      parts.push(w)
      length += sep + w.length
    } else {
      // never split a surrogate pair (an emoji would render as a replacement box)
      let cut = w.slice(0, room)
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
      if (cut) parts.push(cut)
      break
    }
  }
  return { parts, text: parts.join(INTERPUNCT) }
}
