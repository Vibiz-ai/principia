/**
 * A small QR Code encoder for "Open on your phone" (docs/CLOUD.md §3 step 8): byte mode, error correction level M,
 * versions 1 to 10 (up to 213 bytes, plenty for a console login link). Pure, no dependencies, no DOM. Follows ISO/IEC
 * 18004: Reed-Solomon over GF(256) (0x11D), block interleaving, function patterns, the eight masks with the four
 * penalty rules, and BCH format and version information. The caller draws `modules` as crisp squares and falls back
 * to Copy when `encodeQr` throws (too long).
 */

/** Per version (index 1..10) for level M: [total codewords, EC codewords per block, [blocks, data codewords][]]. */
const TABLE_M: readonly (readonly [number, number, readonly (readonly [number, number])[]])[] = [
  [0, 0, []],
  [26, 10, [[1, 16]]],
  [44, 16, [[1, 28]]],
  [70, 26, [[1, 44]]],
  [100, 18, [[2, 32]]],
  [134, 24, [[2, 43]]],
  [172, 16, [[4, 27]]],
  [196, 18, [[4, 31]]],
  [242, 22, [[2, 38], [2, 39]]],
  [292, 22, [[3, 36], [2, 37]]],
  [346, 26, [[4, 43], [1, 44]]]
]
const ALIGN: readonly (readonly number[])[] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
export const QR_MAX_VERSION = 10
/** level M format bits are 00 */
const ECC_M = 0

export interface QrCode {
  version: number
  size: number
  mask: number
  /** modules[y][x], true = dark */
  modules: boolean[][]
}

// ---------- GF(256) and Reed-Solomon ----------

export function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

export function rsDivisor(degree: number): number[] {
  const r: number[] = new Array(degree).fill(0)
  r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root)
      if (j + 1 < r.length) r[j] ^= r[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return r
}

/** The EC codewords for one block. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const r: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (r.shift() as number)
    r.push(0)
    divisor.forEach((coef, i) => (r[i] ^= gfMul(coef, factor)))
  }
  return r
}

// ---------- format and version information ----------

/** 15 bits: level M + mask, BCH(15,5), XOR 0x5412. */
export function formatBits(mask: number, ecc = ECC_M): number {
  const data = (ecc << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}
/** 18 bits for versions 7 and up: BCH(18,6). */
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0

// ---------- data codewords ----------

const dataCodewords = (v: number): number => {
  const [, , groups] = TABLE_M[v]
  return groups.reduce((n, [b, d]) => n + b * d, 0)
}
const countBits = (v: number): number => (v < 10 ? 8 : 16)

export function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

/** The smallest version (1..10) that holds `len` bytes, or null. */
export function versionFor(len: number): number | null {
  for (let v = 1; v <= QR_MAX_VERSION; v++) if (4 + countBits(v) + 8 * len <= dataCodewords(v) * 8) return v
  return null
}

/** Mode, count, bytes, terminator, byte padding and 0xEC/0x11 pad codewords. */
export function dataStream(bytes: readonly number[], version: number): number[] {
  const cap = dataCodewords(version) * 8
  const bits: number[] = []
  const put = (val: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, countBits(version))
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, cap - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  return out
}

/** Splits into blocks, adds EC to each, and interleaves (data first, then EC). */
export function interleave(data: readonly number[], version: number): number[] {
  const [, ecLen, groups] = TABLE_M[version]
  const div = rsDivisor(ecLen)
  const blocks: { d: number[]; e: number[] }[] = []
  let k = 0
  for (const [count, len] of groups)
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + len)
      k += len
      blocks.push({ d, e: rsRemainder(d, div) })
    }
  const out: number[] = []
  const maxD = Math.max(...blocks.map((b) => b.d.length))
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i])
  return out
}

// ---------- matrix ----------

class Matrix {
  readonly m: boolean[][]
  readonly fn: boolean[][]
  constructor(readonly size: number) {
    this.m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }
  setFn(x: number, y: number, dark: boolean): void {
    this.m[y][x] = dark
    this.fn[y][x] = true
  }
}

function drawFunctionPatterns(q: Matrix, version: number): void {
  const n = q.size
  for (let i = 0; i < n; i++) {
    q.setFn(6, i, i % 2 === 0)
    q.setFn(i, 6, i % 2 === 0)
  }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= n || y >= n) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        q.setFn(x, y, dist !== 2 && dist !== 4)
      }
  }
  finder(3, 3)
  finder(n - 4, 3)
  finder(3, n - 4)
  const pos = ALIGN[version]
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      // skip the three corners taken by the finder patterns
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) q.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  drawFormat(q, 0) // reserve the areas (real bits drawn after masking)
  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const a = n - 11 + (i % 3)
      const b = Math.floor(i / 3)
      q.setFn(a, b, bit(bits, i))
      q.setFn(b, a, bit(bits, i))
    }
  }
}

function drawFormat(q: Matrix, mask: number): void {
  const n = q.size
  const bits = formatBits(mask)
  for (let i = 0; i <= 5; i++) q.setFn(8, i, bit(bits, i))
  q.setFn(8, 7, bit(bits, 6))
  q.setFn(8, 8, bit(bits, 7))
  q.setFn(7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i++) q.setFn(14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i++) q.setFn(n - 1 - i, 8, bit(bits, i))
  for (let i = 8; i < 15; i++) q.setFn(8, n - 15 + i, bit(bits, i))
  q.setFn(8, n - 8, true) // the dark module
}

function drawCodewords(q: Matrix, data: readonly number[]): void {
  const n = q.size
  let i = 0
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < n; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? n - 1 - vert : vert
        if (!q.fn[y][x] && i < data.length * 8) {
          q.m[y][x] = bit(data[i >>> 3], 7 - (i & 7))
          i++
        }
      }
  }
}

export const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]

function applyMask(q: Matrix, mask: number): void {
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (!q.fn[y][x] && MASKS[mask](x, y)) q.m[y][x] = !q.m[y][x]
}

/** The four penalty rules (runs, 2x2 blocks, finder-like patterns, dark balance). */
export function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length
  let score = 0
  const lines: boolean[][] = []
  for (let y = 0; y < n; y++) lines.push([...m[y]])
  for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]))
  const P1 = [true, false, true, true, true, false, true]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    for (let i = 0; i + 7 <= n; i++) {
      if (!P1.every((v, k) => line[i + k] === v)) continue
      const before = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k])
      const after = i + 11 <= n && [7, 8, 9, 10].every((k) => !line[i + k])
      if (before) score += 40
      if (after) score += 40
    }
  }
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3
  let dark = 0
  for (const row of m) for (const v of row) if (v) dark++
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
  return score
}

/** Encodes text (UTF-8, byte mode, level M). `mask` forces one (tests); otherwise the lowest penalty wins. Throws when too long. */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = utf8(text)
  let version = versionFor(bytes.length)
  if (version === null) throw new Error('Too long for a QR code here')
  version = Math.max(version, opts.minVersion ?? 1)
  const size = version * 4 + 17
  const codewords = interleave(dataStream(bytes, version), version)
  const base = new Matrix(size)
  drawFunctionPatterns(base, version)
  drawCodewords(base, codewords)
  const tryMask = (mask: number): Matrix => {
    const q = new Matrix(size)
    for (let y = 0; y < size; y++) {
      q.m[y] = [...base.m[y]]
      q.fn[y] = [...base.fn[y]]
    }
    applyMask(q, mask)
    drawFormat(q, mask)
    return q
  }
  let best = opts.mask ?? 0
  if (opts.mask === undefined) {
    let bestScore = Infinity
    for (let k = 0; k < 8; k++) {
      const s = penalty(tryMask(k).m)
      if (s < bestScore) {
        bestScore = s
        best = k
      }
    }
  }
  return { version, size, mask: best, modules: tryMask(best).m }
}

/** One SVG path of 1x1 squares for the dark modules, offset by the quiet zone (default 4). */
export function qrPath(q: QrCode, quiet = 4): string {
  const parts: string[] = []
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
  return parts.join('')
}
