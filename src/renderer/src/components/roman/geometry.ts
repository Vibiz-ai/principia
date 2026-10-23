/**
 * VOICE.md §5: pure SVG geometry shared by the Roman components, ported from docs/voice.html (generator art.py).
 * The system has two tools only (§5.2): white LINE ART (structure, frames, busts, architecture, lettering) and PIXEL
 * MOSAIC (colour, icons, celebration). Everything here is deterministic (no Math.random, no Date), so a face, a seal or
 * a mosaic never changes between renders. No brown, bronze, ochre, beige, terracotta or gold anywhere (§5.12).
 */

import { coolAccent } from '@shared/company'

/** 2-decimal fixed numbers keep the markup short and stable across platforms. */
export const f2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2)

/** React's useId() returns characters like `«r0»` or `:r0:`; keep only what is safe inside `url(#…)`. */
export const svgId = (raw: string, suffix: string): string => `rm${raw.replace(/[^a-zA-Z0-9_-]/g, '')}-${suffix}`

/**
 * The company accent as drawn on a Roman surface (coin tessera, seal accent, pediment pixel). Companies and departments
 * saved before the cool palette may still store the retired warm hues (Claude orange, warning amber); those map to the
 * cool replacements (VOICE.md §5: no orange/brown/ochre accents). Anything else passes through.
 */
export function accentColor(color: string | null | undefined): string | undefined {
  const c = color?.trim()
  if (!c) return undefined
  return coolAccent(c)
}

/** First user-perceived character, uppercased; '' for an empty name. Never splits an emoji's surrogate pair. */
export function initialOf(text: string | null | undefined): string {
  const first = Array.from((text ?? '').trim())[0]
  return first ? first.toLocaleUpperCase() : ''
}

// ---------- line-art tiers (§5.1) ----------

/** Stroke opacities of the four white tiers (`--rm-ln-1..4`); use as `strokeOpacity` under `.rm-la` (stroke #fff). */
export const LN = { 1: 0.9, 2: 0.5, 3: 0.2, 4: 0.1 } as const

/** One stroked path: `d` plus its tier opacity; `i` is the draw-in stagger index when the path may animate. */
export interface StrokePath {
  d: string
  o: number
  i?: number
}

// ---------- pixel-mosaic palette (§5.1, §5.2) ----------

export type PxKey = 'w' | 'W' | 's' | 'd' | 'b' | 'a' | 'B' | 'g' | 'G' | 'r' | 'p' | 'P' | 'v' | '.' | ','

/**
 * Tile colours by mosaic letter: CSS variables from roman.css with the token's hex as fallback, so they work in SVG
 * attributes, inline styles and in tests without the stylesheet. App tokens plus clean accents; no brown, ochre,
 * mustard or beige tile exists. Imperial purple (`p`, `P`) is a border tile only.
 */
export const PX: Readonly<Record<PxKey, string>> = {
  w: 'var(--rm-px-white, #e6e6e9)',
  W: '#ffffff',
  s: 'var(--rm-px-silver, #a1a1a9)',
  d: 'var(--rm-px-grey, #6d6e76)',
  b: 'var(--rm-px-blue, #4c9cff)',
  a: 'var(--rm-px-accent, #6e8cff)',
  B: 'var(--rm-px-blue-deep, #2f6bd0)',
  g: 'var(--rm-px-green, #3ecf8e)',
  G: 'var(--rm-px-green-deep, #2a9d6b)',
  r: 'var(--rm-px-red, #f25c5c)',
  p: 'var(--rm-px-purple, #5a3a8a)',
  P: 'var(--rm-px-purple-2, #4a2f74)',
  v: 'var(--status-scheduled, #b28cff)',
  '.': 'var(--rm-px-ground, #26272b)',
  ',': 'var(--rm-px-ground-2, #2a2b2f)'
}

// ---------- laurel (§5.2 ornaments, §5.5) ----------

/** A leaf: centre, rotation in degrees, `rx` half its length and `ry` half its width (an almond outline). */
export interface Leaf { cx: number; cy: number; rx: number; ry: number; rot: number }

/** The almond outline of a leaf of half-length `rx` and half-width `ry`, centred at 0,0 along +x. */
export const leafD = (rx: number, ry: number): string => `M${f2(-rx)} 0Q0 ${f2(-2 * ry)} ${f2(rx)} 0Q0 ${f2(2 * ry)} ${f2(-rx)} 0Z`

/** A leaf as path attributes: the almond outline plus its placement. */
export function leafPath(l: Leaf): { d: string; transform: string } {
  return { d: leafD(l.rx, l.ry), transform: `translate(${f2(l.cx)} ${f2(l.cy)}) rotate(${l.rot.toFixed(1)})` }
}

export interface WreathSpec {
  cx: number
  cy: number
  /** radius of the stem arc (with the legacy `ri`, the stem runs halfway between `r` and `ri`) */
  r: number
  /** @deprecated legacy inner leaf row radius */
  ri?: number
  /** leaf pairs per branch */
  pairs: number
  /** first stem angle (degrees, SVG: 0 = right, 90 = bottom), default 100, and the last; the top stays open */
  start?: number
  end: number
  /** leaf half-length and half-width */
  rx: number
  ry: number
}

const RAD = Math.PI / 180

/** Catmull-Rom through points as a cubic Bézier path (art.py `catmull`). */
export function catmull(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length
  let d = `M${f2(pts[0][0])} ${f2(pts[0][1])}`
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i > 0 ? i - 1 : 0]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2 < n ? i + 2 : n - 1]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C${f2(c1x)} ${f2(c1y)} ${f2(c2x)} ${f2(c2y)} ${f2(p2[0])} ${f2(p2[1])}`
  }
  return d
}

const stemRadius = (s: WreathSpec): number => (s.ri !== undefined ? (s.r + s.ri) / 2 : s.r)

/** One branch (art.py `branch`): leaf pairs tilted ±28° off the stem, a tip leaf, and the stem points. */
function branch(s: WreathSpec, mirror: boolean): { leaves: Leaf[]; stem: [number, number][] } {
  const { cx, cy, pairs: n, rx, ry } = s
  const r = stemRadius(s)
  const a0 = s.start ?? 100
  const a1 = s.end
  const L = rx * 2
  const sgn = a1 < a0 ? -1 : 1
  const leaves: Leaf[] = []
  const stem: [number, number][] = []
  const place = (x: number, y: number, ang: number): void => {
    leaves.push(mirror ? { cx: 2 * cx - x, cy: y, rx, ry, rot: 180 - ang } : { cx: x, cy: y, rx, ry, rot: ang })
  }
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? a0 + ((a1 - a0) * i) / (n - 1) : a0
    const rad = a * RAD
    stem.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)])
    const tang = a + 90 * sgn
    for (const [dr, tilt] of [[1.25, -28 * sgn], [-1.25, 28 * sgn]] as const) {
      const ang = tang + tilt
      let x = cx + (r + dr) * Math.cos(rad)
      let y = cy + (r + dr) * Math.sin(rad)
      // push the leaf forward along its own axis so its base sits on the stem
      x += Math.cos(ang * RAD) * L * 0.45 - dr * 0.9 * Math.cos(rad)
      y += Math.sin(ang * RAD) * L * 0.45 - dr * 0.9 * Math.sin(rad)
      place(x, y, ang)
    }
  }
  const tipRad = a1 * RAD
  const tipAng = a1 + 90 * sgn
  place(
    cx + r * Math.cos(tipRad) + Math.cos(tipAng * RAD) * L * 0.5,
    cy + r * Math.sin(tipRad) + Math.sin(tipAng * RAD) * L * 0.5,
    tipAng
  )
  return { leaves, stem: mirror ? stem.map(([x, y]) => [2 * cx - x, y] as [number, number]) : stem }
}

/**
 * Two mirrored branches of leaf pairs along a circle, open at the top (§5.2): right branch leaves first (pairs then
 * the tip), then the left. Each leaf is an almond outline (`leafPath`).
 */
export function wreathLeaves(s: WreathSpec): Leaf[] {
  return [...branch(s, false).leaves, ...branch(s, true).leaves]
}

/** The full wreath as line art: leaves (`--rm-ln-1`), two stems and the ribbon (knot `--rm-ln-1`, tails `--rm-ln-2`). */
export function wreath(s: WreathSpec): { leaves: Leaf[]; stems: string[]; knot: string; tails: string } {
  const right = branch(s, false)
  const left = branch(s, true)
  const r = stemRadius(s)
  const by = s.cy + r + 0.6
  const k = r / 20
  const { cx } = s
  return {
    leaves: [...right.leaves, ...left.leaves],
    stems: [catmull(right.stem), catmull(left.stem)],
    knot: `M${f2(cx - 2.6 * k)} ${f2(by - 0.8 * k)} Q${f2(cx)} ${f2(by + 1.4 * k)} ${f2(cx + 2.6 * k)} ${f2(by - 0.8 * k)}`,
    tails:
      `M${f2(cx - 0.6 * k)} ${f2(by + 0.3 * k)} L${f2(cx - 2.8 * k)} ${f2(by + 3.6 * k)} ` +
      `M${f2(cx + 0.6 * k)} ${f2(by + 0.3 * k)} L${f2(cx + 2.8 * k)} ${f2(by + 3.6 * k)}`
  }
}

/** The crown over a bust's head (64 × 64 bust space), outer and inner leaves, left branch; the right is mirrored. */
const CROWN_LEFT: readonly (readonly [number, number, number, number, number, number])[] = [
  [19.15, 23.32, 134.3, 20.8, 23.76, 84.3],
  [20.05, 21.11, 146.0, 21.57, 21.85, 96.0],
  [21.38, 19.1, 157.4, 22.74, 20.12, 107.4],
  [23.1, 17.36, 168.4, 24.24, 18.62, 118.4],
  [25.15, 15.96, 179.1, 26.03, 17.41, 129.1],
  [27.45, 14.94, 189.5, 28.03, 16.54, 139.5],
  [29.69, 14.39, 198.8, 29.99, 16.06, 148.8]
]
export const CROWN_LEAVES: readonly Leaf[] = (() => {
  const left: Leaf[] = []
  for (const [ox, oy, orot, ix, iy, irot] of CROWN_LEFT) {
    left.push({ cx: ox, cy: oy, rx: 2.7, ry: 1.15, rot: orot })
    left.push({ cx: ix, cy: iy, rx: 2.4, ry: 1.0, rot: irot })
  }
  return [...left, ...left.map((l) => ({ ...l, cx: 64 - l.cx, rot: 180 - l.rot }))]
})()

/** The kicker sprig (22 × 12): a stem at `--rm-ln-2` and six leaves at `--rm-ln-1` (art.py `sprig`). */
export const SPRIG = {
  w: 22,
  h: 12,
  stem: 'M1 10 C7 9 14 6 21 2',
  leaves: ([[6, 8.2, -50], [11, 6.6, -60], [16, 4.4, -70], [8.4, 10.6, 10], [13.4, 9, 0], [18, 6.6, -10]] as const).map(
    ([cx, cy, rot]): Leaf => ({ cx, cy, rot, rx: 1.8, ry: 0.6 })
  )
} as const

// ---------- the seal roundel (§5.3) ----------

/** The line-drawn laurel roundel in a 64-unit box. */
export const ROUNDEL = {
  box: 64,
  c: 32,
  /** ground disc that occludes rules behind the seal */
  ground: 31.5,
  outer: 29.5,
  beads: 27.6,
  beadDash: '.01 2.3',
  beadWidth: 1.3,
  inner: 25.8,
  /** the unsealed dashed circle */
  unsealed: 27,
  unsealedDash: '2 3',
  wreath: { cx: 32, cy: 32.6, r: 19.4, pairs: 8, start: 106, end: -54, rx: 2.5, ry: 0.875 } as WreathSpec,
  initial: { x: 32, y: 38.6, size: 18.5 },
  accent: { x: 30.3, y: 5.2, size: 3.4 }
} as const

// ---------- architecture (§5.2, §5.7) ----------

/**
 * An engraved pediment (art.py `pediment`): raking cornice `--rm-ln-1`, tympanum `--rm-ln-2`, architrave `--rm-ln-1`,
 * a dentil row `--rm-ln-3` (2.6 ticks every 5 units), then two more rules (`--rm-ln-2`, `--rm-ln-3`). `span` narrows
 * the triangle while the entablature keeps the full width. `accent` is where the company's one 5-unit tessera sits.
 */
export function pediment(w: number, h: number, span?: number): { paths: StrokePath[]; accent: { x: number; y: number; size: number } } {
  const cx = w / 2
  const top = 3
  const base = h - 14
  const s = span ?? w
  const l = cx - s / 2 + 4
  const r = cx + s / 2 - 4
  const dentils: string[] = []
  for (let x = 8; x < w - 8; x += 5) dentils.push(`M${f2(x)} ${f2(base + 2.6)} v2.6`)
  const ty = (top + 5.6 + base - 2.6) / 2 + 2
  return {
    paths: [
      { d: `M${f2(l)} ${f2(base)} L${f2(cx)} ${top} L${f2(r)} ${f2(base)}`, o: LN[1], i: 0 },
      { d: `M${f2(l + 12)} ${f2(base - 2.6)} L${f2(cx)} ${f2(top + 5.6)} L${f2(r - 12)} ${f2(base - 2.6)} Z`, o: LN[2], i: 1 },
      { d: `M2 ${f2(base)} H${f2(w - 2)}`, o: LN[1], i: 2 },
      { d: dentils.join(' '), o: LN[3] },
      { d: `M2 ${f2(base + 7)} H${f2(w - 2)}`, o: LN[2] },
      { d: `M6 ${f2(base + 10)} H${f2(w - 6)}`, o: LN[3] }
    ],
    accent: { x: cx - 2.5, y: ty - 2.5, size: 5 }
  }
}

/** A Greek-key rule (art.py `meander`): 12-unit repeat at `--rm-ln-2` over a `--rm-ln-3` base line; box w × (h + 3). */
export function meander(w: number, h = 12): { w: number; h: number; paths: StrokePath[] } {
  const d: string[] = []
  for (let x = 0; x + 10 <= w; x += 12) d.push(`M${x} ${h - 1} V1 H${x + 9} V${h - 3} H${x + 3.5} V4.5 H${x + 6}`)
  return { w, h: h + 3, paths: [{ d: d.join(' '), o: LN[2] }, { d: `M0 ${h + 2} H${w}`, o: LN[3] }] }
}

/**
 * The onboarding arch (the reference drawing of the whole system): two fluted columns carrying a semicircular double
 * arch with 14 voussoir joints and a keystone, in a 420 × 300 box.
 */
export const ARCH = (() => {
  const W = 420
  const H = 300
  const spring = 96
  const outer = { rx: 165, ry: 88 }
  const inner = { rx: 143, ry: 68 }
  const voussoirs = Array.from({ length: 14 }, (_, k) => {
    const a = (Math.PI * (k + 1)) / 15
    return {
      x1: f2(W / 2 - outer.rx * Math.cos(a)),
      y1: f2(spring - outer.ry * Math.sin(a)),
      x2: f2(W / 2 - inner.rx * Math.cos(a)),
      y2: f2(spring - inner.ry * Math.sin(a))
    }
  })
  return {
    W,
    H,
    spring,
    columns: [14, W - 76] as const,
    flutes: [17, 24, 31, 38, 45] as const,
    outerD: `M${W / 2 - outer.rx} ${spring} A${outer.rx} ${outer.ry} 0 0 1 ${W / 2 + outer.rx} ${spring}`,
    innerD: `M${W / 2 - inner.rx} ${spring} A${inner.rx} ${inner.ry} 0 0 1 ${W / 2 + inner.rx} ${spring}`,
    voussoirs,
    keystone: `M${W / 2 - 7} 6.5 L${W / 2 + 7} 6.5 L${W / 2 + 5} 28 L${W / 2 - 5} 28 Z`
  }
})()

/** The drawn plinth (art.py `plinth_svg`), w × h, stretched with preserveAspectRatio="none". */
export function plinthPaths(w = 120, h = 40): StrokePath[] {
  return [
    { d: `M14 1 H${w - 14}`, o: LN[1] },
    { d: `M18 4 H${w - 18}`, o: LN[3] },
    { d: `M14 1 L8 ${h - 9} M${w - 14} 1 L${w - 8} ${h - 9}`, o: LN[1] },
    { d: `M4 ${h - 9} H${w - 4} V${h - 5} H4 Z`, o: LN[1] },
    { d: `M1 ${h - 1} H${w - 1}`, o: LN[2] }
  ]
}

// ---------- pixel mosaic (§5.8) ----------

export type MosaicMotif = 'laurel' | 'amphora' | 'column' | 'coin' | 'lamp'

/** 12 × 9 motif grids inside the purple border; letters are `PX` keys, '.' is grout-dark ground (§5.8). */
export const MOSAIC_MOTIFS: Readonly<Record<MosaicMotif, readonly string[]>> = {
  laurel: [
    '............',
    '..g......g..',
    '.g.G....G.g.',
    '.gg......gg.',
    'G.g......g.G',
    '.gg......gg.',
    '..gG....Gg..',
    '....gwwg....',
    '.....bb.....'
  ],
  amphora: [
    '...wwwwww...',
    '...w.ww.w...',
    '....wwww....',
    '...bbbbbb...',
    '..bBwwwwBb..',
    '..bbbbbbbb..',
    '...bBbbBb...',
    '....bbbb....',
    '.....ww.....'
  ],
  column: [
    '..wwwwwwww..',
    '...ssssss...',
    '...w.ww.w...',
    '...w.ww.w...',
    '...w.ww.w...',
    '...w.ww.w...',
    '...w.ww.w...',
    '..ssssssss..',
    '.wwwwwwwwww.'
  ],
  coin: [
    '....ssss....',
    '..sswwwwss..',
    '.swwwbbwwws.',
    '.swwbwwbwws.',
    '.swwbwwbwws.',
    '.swwwbbwwws.',
    '..sswwwwss..',
    '....ssss....',
    '............'
  ],
  lamp: [
    '..........w.',
    '.........wbw',
    '..........w.',
    '....sss...s.',
    '..ssswsssss.',
    'ddsswwwsssss',
    'd.ssssssss..',
    'dd..ssss....',
    '....dddd....'
  ]
}

export const MOSAIC_PITCH = 10
export const MOSAIC_GAP = 1.6
/** board size in tiles: the 12 × 9 motif plus a one-tile border */
export const MOSAIC_COLS = 14
export const MOSAIC_ROWS = 11

export interface PxTile { x: number; y: number; size: number; fill: string; key: PxKey }

const pxRound = (n: number): number => Math.round(n * 100) / 100

/**
 * The full 14 × 11 board (viewBox 140 × 110): alternating purple border tiles around the motif on two ground shades.
 * 10-unit pitch, 1.6-unit gap, no jitter; render with `shape-rendering="crispEdges"`.
 */
export function mosaicTiles(motif: MosaicMotif): PxTile[] {
  const rows = MOSAIC_MOTIFS[motif]
  const size = pxRound(MOSAIC_PITCH - MOSAIC_GAP)
  const tiles: PxTile[] = []
  for (let r = 0; r < MOSAIC_ROWS; r++) {
    for (let c = 0; c < MOSAIC_COLS; c++) {
      let key: PxKey
      if (r === 0 || c === 0 || r === MOSAIC_ROWS - 1 || c === MOSAIC_COLS - 1) {
        key = (r + c) % 2 === 0 ? 'p' : 'P'
      } else {
        const rr = r - 1
        const cc = c - 1
        const ch = (rows[rr]?.[cc] ?? '.') as PxKey
        key = ch === '.' ? ((rr * 7 + cc * 3) % 5 ? '.' : ',') : ch in PX ? ch : '.'
      }
      tiles.push({ x: pxRound(c * MOSAIC_PITCH + MOSAIC_GAP / 2), y: pxRound(r * MOSAIC_PITCH + MOSAIC_GAP / 2), size, fill: PX[key], key })
    }
  }
  return tiles
}

export type MilestoneGlyph = 'column' | 'scroll' | 'quill' | 'seal' | 'sun' | 'laurel' | 'dove' | 'coin'

/** 9 × 9 pixel glyphs for milestone coins (§5.9): '#' white tile, 'b' blue / 'g' green accent, '.' empty. */
export const MILESTONE_GLYPHS: Readonly<Record<MilestoneGlyph, readonly string[]>> = {
  column: ['.#######.', '..#####..', '..#.#.#..', '..#.#.#..', '..#.#.#..', '..#.#.#..', '..#.#.#..', '..#####..', '.###b###.'],
  scroll: ['.#######.', '#########', '.#.....#.', '.#.bbb.#.', '.#.....#.', '.#.bb..#.', '.#.....#.', '#########', '.#######.'],
  quill: ['.......##', '......###', '.....###.', '....###..', '...###...', '..##.....', '..#......', '.b.......', 'b........'],
  seal: ['..#####..', '.#.....#.', '#.......#', '#.....g.#', '#.g..g..#', '#..gg...#', '#.......#', '.#.....#.', '..#####..'],
  sun: ['....#....', '.#.....#.', '...###...', '..#####..', '#.##b##.#', '..#####..', '...###...', '.#.....#.', '....#....'],
  laurel: ['g.......g', 'g.......g', 'gg.....gg', '.g.....g.', '.gg...gg.', '..g...g..', '..gg.gg..', '...g.g...', '....b....'],
  dove: ['......##.', '.....####', '#...###..', '##.####..', '#######..', '.######..', '..####...', '...b.....', '.........'],
  coin: ['..#####..', '.#.....#.', '#..###..#', '#.#...#.#', '#.#.b.#.#', '#.#...#.#', '#..###..#', '.#.....#.', '..#####..']
}

/** A glyph's lit cells as tiles at (x0, y0) on `pitch` with `gap`: '#' is white, other letters their `PX` colour. */
export function glyphTiles(name: MilestoneGlyph, x0: number, y0: number, pitch = 3, gap = 0.6): PxTile[] {
  const out: PxTile[] = []
  MILESTONE_GLYPHS[name].forEach((row, r) => {
    Array.from(row).forEach((ch, c) => {
      if (ch === '.') return
      const key = (ch === '#' ? 'w' : ch) as PxKey
      out.push({ x: pxRound(x0 + c * pitch), y: pxRound(y0 + r * pitch), size: pxRound(pitch - gap), fill: PX[key] ?? PX.w, key })
    })
  })
  return out
}

export interface PxWreathTile extends PxTile {
  /** reveal step (ribbon first, tips last, both branches together) */
  step: number
}

/**
 * The ceremony's pixel-mosaic laurel (VOICE.md §8, docs/voice.html `.pxw`): a 21 × 20 grid (viewBox 210 × 200, 10 pitch,
 * 2 gap), authored tile by tile with the left half mirrored. A one-tile silver stem, white outer leaves and blue inner
 * leaves as two-tile diagonal strokes pointing up the branch, a white knot and blue ribbon at the base, open at the top.
 * No stray or doubled tiles. `step` is the mockup's reveal index (ribbon first, tips last, both branches together);
 * `order` lists tile indices by step for the 28 ms `steps(1)` reveal.
 */
const PIXEL_WREATH_ROWS: readonly string[] = [
  '                     ',
  '    w           w    ',
  ' w   s         s   w ',
  '  w s           s w  ',
  '   s b         b s   ',
  'w  sb           bs  w',
  ' ws               sw ',
  '  s b           b s  ',
  'w sb             bs w',
  ' ws               sw ',
  '  s b           b s  ',
  ' wsb             bsw ',
  '  ws             sw  ',
  '   s  b       b  s   ',
  '  w sb         bs w  ',
  '   w s  b   b  s w   ',
  '      sb     bs      ',
  '    ww ss   ss ww    ',
  '         sws         ',
  '        bb bb        '
]
/** reveal step per tile, base 36 ('0'–'9', 'a'–'k'); spaces where there is no tile */
const PIXEL_WREATH_STEPS: readonly string[] = [
  '                     ',
  '    k           k    ',
  ' i   k         k   i ',
  '  i j           j i  ',
  '   i j         j i   ',
  'g  hi           ih  g',
  ' fg               gf ',
  '  f g           g f  ',
  'e ee             ee e',
  ' dd               dd ',
  '  c c           c c  ',
  ' bbb             bbb ',
  '  aa             aa  ',
  '   9  6       6  9   ',
  '  8 76         67 8  ',
  '   7 6  2   2  6 7   ',
  '      43     34      ',
  '    54 32   23 45    ',
  '         000         ',
  '        10 01        '
]

export function pixelWreath(): { cols: number; rows: number; pitch: number; gap: number; tiles: PxWreathTile[]; order: number[] } {
  const W = 21
  const H = 20
  const pitch = 10
  const gap = 2
  const tiles: PxWreathTile[] = []
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const key = PIXEL_WREATH_ROWS[r][c]
      if (key === ' ') continue
      const step = parseInt(PIXEL_WREATH_STEPS[r][c], 36)
      tiles.push({ x: c * pitch + gap / 2, y: r * pitch + gap / 2, size: pitch - gap, fill: PX[key as PxKey], key: key as PxKey, step })
    }
  }
  const order = tiles.map((_, i) => i).sort((p, q) => tiles[p].step - tiles[q].step || p - q)
  return { cols: W, rows: H, pitch, gap, tiles, order }
}
