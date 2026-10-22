/**
 * VOICE.md §5.4: an agent as a line-art bust, a profile like a coin engraving or a catalogue plate. Pure strokes in
 * the white tiers (.9 contours, .5 detail, .2 hints) on whatever dark ground it sits on: no disc, no skin, no
 * material, no gradient, no fill. 64-unit drawing, three detail tiers so it stays crisp from 16 to 96 px:
 * - mini (< 22 px), 1.25 px: a coin-head crop, one exaggerated profile, the hair outline and hairline, short neck
 *   lines, no shoulders, and exactly one persona cue drawn big (laurel, else full beard, else the bun);
 * - small (22 to 39), 1 px: shoulders and truncation, every other lock, a one-line eye, the main drapery line and
 *   one fold; no ear, no socle;
 * - full (≥ 40), 1 px (1.2 above 80): everything, the socle optional.
 * The stored `BustLook` keys are legacy names reinterpreted as lines (shared/personas.ts `FACING`, `DRAPE_LINE`).
 * Geometry ported from docs/voice.html §2. Decorative (`aria-hidden`) unless `title` is set ("Marcus, Copywriter").
 */
import type { ReactElement } from 'react'
import { BUST_BEARDS, BUST_HAIRS, DRAPE_LINE, FACING, type BustDrapeLine, type BustHair, type BustLook } from '@shared/personas'

export type BustTier = 'mini' | 'small' | 'full'
export const bustTier = (size: number): BustTier => (size < 22 ? 'mini' : size < 40 ? 'small' : 'full')

/** What a bust falls back to when a look is missing or partial (legacy rows, a corrupt persona): never a crash. */
export const DEFAULT_LOOK: Readonly<BustLook> = { material: 'marble', hair: 'crop', beard: 'none', laurel: false, drape: 'purple' }

export interface BustProps {
  /** missing or partial looks fill in from DEFAULT_LOOK */
  look?: Partial<BustLook> | null
  /** rendered size in px (width = height) */
  size: number
  /** accessible name, e.g. "Marcus, Copywriter"; without it the bust is decorative */
  title?: string
  className?: string
  /** a faint --rm-ln-3 circle around the bust, for avatar slots in lists (sidebar, board card, Needs you) */
  ring?: boolean
  /** the two-step pedestal under the truncation; full tier only, default true (plinths pass false) */
  socle?: boolean
}

/** stroke tiers (--rm-ln-1/2/3 as opacities on a white stroke) */
type Op = 0.9 | 0.5 | 0.2
/** [d, opacity, 'f' = full tier only (default: small and full)] */
type Line = readonly [d: string, o: Op, only?: 'f']

// ---------- face, neck, shoulders (facing right; left is the same drawing mirrored) ----------

export const FACE =
  'M40.2 15.8 C41.6 18.2 42.1 21 41.9 24 C42.2 25.3 43.7 27.8 45.7 30.6 C45.3 31.3 44.2 31.6 43.2 31.8 C43.3 32.4 43.8 32.9 43.7 33.4 C43.4 33.9 42.8 34 42.7 34.3 C43.2 34.7 43.5 35.2 43.1 35.7 C42.5 36.3 42.3 36.9 42.6 37.8 C43.1 39.4 41.8 40.9 39.6 41.4 C38 41.7 36.7 41.6 35.8 41.4'
/** the profile down to the lip, where a full beard takes over the chin */
export const FACE_BEARD =
  'M40.2 15.8 C41.6 18.2 42.1 21 41.9 24 C42.2 25.3 43.7 27.8 45.7 30.6 C45.3 31.3 44.2 31.6 43.2 31.8 C43.3 32.4 43.8 32.9 43.7 33.4 C43.4 33.9 42.8 34 42.7 34.3 C43.2 34.7 43.5 35.2 43.1 35.7'
export const BEARD = 'M43.1 35.7 C44.7 37.4 44.9 40.5 43.3 42.5 C41.4 44.7 37.6 45.1 34.7 43.5 C32.2 42 30.7 38.2 30.4 33.4'
const BEARD_CURLS: readonly string[] = ['M41.6 38.2 q-1 1 -.4 2.2', 'M38.8 40.2 q-1 1 -.4 2.2', 'M36 39 q-1 1 -.4 2.2', 'M33.4 36.6 q-.9 1 -.3 2.2']
const MOUSTACHE = 'M43.2 31.8 C42.6 32.6 41.6 33 40.4 33.1'
export const STUBBLE = 'M31 31.6 C32 36 34.6 39.8 38.6 41.2'
const NECK_FRONT = 'M35.8 41.4 C36 43.4 36.3 45.4 36.9 47'
const NECK_FRONT_BEARD = 'M35.2 43.6 C35.8 44.8 36.3 45.8 36.9 47'
const NECK_BACK = 'M25.4 34 C26.1 38.4 26 42.4 25.2 46'
/** right shoulder, left shoulder, the truncation curve */
export const SHOULDERS: readonly string[] = [
  'M36.9 47 C40.6 48 44.6 50 46.8 54.4',
  'M25.2 46 C20.6 47.4 17.2 50.6 16.2 54.4',
  'M16.2 54.4 C24 57 39 57 46.8 54.4'
]
/** the jaw-to-nape line behind the ear (hidden by a veil, absent on a bald head) */
const NAPE = 'M29.4 31.6 C27.6 32.2 26.4 33 25.4 34'
export const EYE = 'M38.1 24.9 C38.9 24.6 39.8 24.8 40.4 25.3 C39.7 25.8 38.9 26.1 38.2 26'
const EYE_LINE = 'M38.3 25.2 L40.2 25.4'
const BROW = 'M36.8 23.3 C38.4 22.6 40.2 22.8 41.5 23.7'
const NOSTRIL = 'M43.6 30.6 C43 30.4 42.6 30.8 42.8 31.3'
const MOUTH = 'M42.6 34.3 L41.1 34.45'
export const EAR = 'M31.2 24.6 C33.6 24.2 34.6 27 33.2 29.2 C32.6 30.2 31.6 30.4 31.2 31.2'
const EAR_INNER = 'M31.9 26.3 C32.8 26.6 32.9 27.8 32.3 28.6'
/** the two-step pedestal: stem, top step, base, step sides */
const SOCLE: readonly string[] = [
  'M27.6 56.6 L26.8 58.8 M36.4 56.6 L37.2 58.8',
  'M24.2 58.8 H39.8',
  'M23.6 61.6 H40.4',
  'M24.2 58.8 L23.6 61.6 M39.8 58.8 L40.4 61.6'
]

// ---------- mini: a coin-head crop with one exaggerated profile ----------

const MINI_VIEWBOX = '13 9.4 38 38'
/** the nose projects about 2.5 px at 16 px so the facing reads */
export const MINI_FACE = 'M40.2 15.8 C42 18.6 42.6 21.6 42.4 24.2 L47.2 31 L44 31.9 L44.4 34.6 L43 35.3 C43.8 37.6 42.6 40.4 39.4 41 C38.1 41.3 36.9 41.2 35.9 41'
const MINI_FACE_BEARD = 'M40.2 15.8 C42 18.6 42.6 21.6 42.4 24.2 L47.2 31 L44 31.9'
export const MINI_BEARD = 'M44 31.9 C46.4 34.6 46.4 39.6 43.4 42.4 C40.4 45 35.6 44.6 33.2 41.6 C31.6 39.6 31 36.6 31.2 33.6'
const MINI_NECK_FRONT = 'M35.9 41 C36.1 42.6 36.4 44 36.9 45.2'
const MINI_NECK_FRONT_BEARD = 'M35.4 43.6 L36.9 45.2'
const MINI_NECK_BACK = 'M25.4 34 C26 37.6 26 41.4 25.4 45.2'
const MINI_BUN: readonly [cx: number, cy: number, r: number] = [18.2, 21.6, 3.8]

// ---------- hair ----------

const HAIRLINE = 'M39.6 17.8 C36.6 17.4 34.2 18.8 33 21.2 C32.2 22.8 31.2 23.6 30 23.8'
const HAIRLINE_SOFT = 'M39.6 17.8 C36.6 17.6 34.2 19 33 21.4 C32.2 22.8 31.2 23.6 30 23.8'
const HAIRLINE_WAVY = 'M39.6 17.8 C36.4 17.6 34 19.2 32.8 21.6 C32 23 31.2 23.6 30 23.8'
const HAIRLINE_VEIL = 'M39.4 18.6 C36.2 18.4 34.2 20 33.2 22.2 C32.4 23.4 31.4 23.8 30.4 24'
const BALD_FRINGE = 'M30 23.6 C27.2 23.4 24.6 25.4 23.6 28.6'

const CRANIUM_CROP =
  'M40.2 15.8 C40.15 15.67 40.28 15.49 39.92 15.03 C39.56 14.58 38.73 13.64 38.05 13.07 C37.38 12.5 36.64 12.01 35.88 11.61 C35.12 11.22 34.31 10.91 33.49 10.71 C32.68 10.5 31.83 10.4 31 10.4 C30.17 10.4 29.32 10.5 28.51 10.71 C27.69 10.91 26.88 11.22 26.12 11.61 C25.36 12.01 24.62 12.5 23.95 13.07 C23.27 13.64 22.64 14.31 22.08 15.03 C21.53 15.75 21.02 16.56 20.61 17.4 C20.19 18.24 19.84 19.15 19.59 20.07 C19.33 21 19.15 21.97 19.07 22.94 C18.98 23.9 18.98 24.9 19.07 25.86 C19.15 26.83 19.33 27.8 19.59 28.73 C19.84 29.65 20.19 30.56 20.61 31.4 C21.02 32.24 21.84 33.37 22.08 33.77'
const CRANIUM_NODUS =
  'M40.2 15.8 C40.12 15.7 40.12 15.64 39.74 15.22 C39.36 14.8 38.57 13.86 37.91 13.3 C37.25 12.74 36.53 12.25 35.78 11.87 C35.04 11.48 34.24 11.18 33.45 10.98 C32.65 10.78 31.82 10.68 31 10.68 C30.18 10.68 29.35 10.78 28.55 10.98 C27.76 11.18 26.96 11.48 26.22 11.87 C25.47 12.25 24.75 12.74 24.09 13.3 C23.43 13.86 22.81 14.51 22.26 15.22 C21.72 15.93 21.22 16.72 20.82 17.54 C20.41 18.36 20.07 19.26 19.82 20.16 C19.56 21.06 19.39 22.02 19.3 22.97 C19.22 23.91 19.22 24.89 19.3 25.83 C19.39 26.78 19.56 27.74 19.82 28.64 C20.07 29.54 20.41 30.44 20.82 31.26 C21.22 32.08 22.02 33.19 22.26 33.58'
/** scalloped: the curls' outline */
const CRANIUM_CURLS =
  'M40.2 15.8 L40.38 15.22 A2.1 2.1 0 0 0 38.19 12.85 A2.1 2.1 0 0 0 35.59 11.16 A2.1 2.1 0 0 0 32.7 10.26 A2.1 2.1 0 0 0 29.72 10.2 A2.1 2.1 0 0 0 26.81 10.98 A2.1 2.1 0 0 0 24.16 12.56 A2.1 2.1 0 0 0 21.9 14.84 A2.1 2.1 0 0 0 20.19 17.7 A2.1 2.1 0 0 0 19.12 20.95 A2.1 2.1 0 0 0 18.76 24.4 A2.1 2.1 0 0 0 19.12 27.85 A2.1 2.1 0 0 0 20.19 31.1 A2.1 2.1 0 0 0 21.9 33.96'
const CRANIUM_WAVY =
  'M40.2 15.8 C40.2 15.63 40.51 15.27 40.19 14.75 C39.86 14.24 38.94 13.31 38.24 12.71 C37.54 12.12 36.77 11.61 35.97 11.2 C35.18 10.79 34.33 10.48 33.49 10.27 C32.64 10.07 31.75 9.97 30.88 9.98 C30.02 9.99 29.13 10.11 28.29 10.33 C27.44 10.55 26.6 10.89 25.82 11.31 C25.03 11.73 24.27 12.27 23.57 12.87 C22.88 13.48 22.23 14.19 21.66 14.95 C21.09 15.72 20.59 16.57 20.17 17.45 C19.75 18.34 19.41 19.3 19.16 20.26 C18.91 21.23 18.75 22.25 18.68 23.26 C18.61 24.27 18.63 25.31 18.75 26.31 C18.86 27.31 19.07 28.32 19.37 29.27 C19.66 30.22 20.05 31.15 20.5 32.01 C20.96 32.87 21.84 34.02 22.11 34.42'
/** broken where the bun sits at the back */
const CRANIUM_BUN =
  'M40.2 15.8 C40.11 15.72 40.05 15.71 39.65 15.31 C39.25 14.91 38.48 13.95 37.82 13.39 C37.15 12.83 36.43 12.35 35.68 11.96 C34.93 11.58 34.13 11.29 33.33 11.09 C32.53 10.9 31.69 10.81 30.87 10.82 C30.06 10.83 29.22 10.95 28.43 11.16 C27.63 11.37 26.84 11.68 26.09 12.08 C25.35 12.49 24.63 12.99 23.98 13.57 C23.33 14.14 22.72 14.81 22.18 15.53 C21.65 16.25 21.17 17.06 20.78 17.9 C20.39 18.73 20.07 19.64 19.84 20.55 C19.61 21.47 19.45 22.43 19.39 23.38 C19.33 24.33 19.36 25.31 19.47 26.25 C19.58 27.2 19.96 28.58 20.06 29.04 M21.6 28.2 C21.2 30.4 22.4 32.4 25.4 34'
const CRANIUM_BALD =
  'M40.2 15.8 C40.12 15.81 40.1 16.17 39.73 15.85 C39.37 15.53 38.63 14.47 38 13.9 C37.37 13.33 36.67 12.82 35.95 12.42 C35.23 12.01 34.46 11.69 33.68 11.47 C32.9 11.25 32.09 11.13 31.29 11.1 C30.49 11.08 29.67 11.16 28.89 11.33 C28.11 11.5 27.32 11.78 26.58 12.14 C25.85 12.5 25.13 12.96 24.47 13.5 C23.82 14.03 23.2 14.66 22.65 15.34 C22.11 16.02 21.62 16.79 21.21 17.59 C20.8 18.39 20.46 19.26 20.2 20.14 C19.94 21.03 19.76 21.96 19.67 22.89 C19.58 23.81 19.58 24.77 19.65 25.7 C19.73 26.63 19.9 27.56 20.14 28.45 C20.38 29.34 20.72 30.22 21.11 31.02 C21.51 31.83 22.29 32.92 22.53 33.3'
/** the veil: a drape line from the crown down to the shoulder */
const VEIL = 'M41.8 17.8 C40.6 9.6 30.4 8.2 24.6 11.4 C19 14.6 17.6 22 18.2 30 C18.6 37 17.6 43.4 15.6 49.6'

/** a 1.1-unit spiral curl, one turn and a tail */
const curl = (x: number, y: number): string => `M${x} ${y} a1.1 1.1 0 1 1 1.1 1.1`
const CURLS_OUTER: readonly (readonly [number, number])[] = [
  [36.81, 14.85], [34.57, 13.06], [32.01, 12.02], [29.31, 11.78], [26.65, 12.37], [24.21, 13.75],
  [22.17, 15.83], [20.65, 18.45], [19.78, 21.45], [19.6, 24.6], [20.14, 27.7], [21.34, 30.53]
]
const CURLS_INNER: readonly (readonly [number, number])[] = [
  [32.69, 14.85], [30.43, 14.3], [28.13, 14.51], [25.98, 15.45], [24.13, 17.07], [22.75, 19.22], [21.93, 21.74], [21.76, 24.42], [22.23, 27.06]
]
const CROP_LOCKS: readonly string[] = [
  'M39.4 16.9 q-1.6 .5 -2.3 2.3', 'M37.4 14.8 q-1.8 .6 -2.6 2.6', 'M34.6 13.4 q-1.8 .8 -2.4 3', 'M31.4 12.9 q-1.6 1 -2 3.2',
  'M28.2 13.4 q-1.4 1.2 -1.6 3.4', 'M25.2 15 q-1.2 1.4 -1.2 3.6', 'M22.8 17.8 q-.9 1.6 -.6 3.8', 'M21.8 22.4 q-.4 1.8 .2 3.8'
]

interface HairDef {
  /** the head's outline (or the veil) at .9 */
  outline: string
  hairline: string | null
  /** what mini keeps as its only interior stroke */
  miniHairline: string | null
  nape: boolean
  /** texture, in drawing order */
  lines: readonly Line[]
}

/** every other item at small, all at full */
const alternate = (ds: readonly string[], o: Op): Line[] => ds.map((d, i) => (i % 2 === 0 ? [d, o] : [d, o, 'f']))

export const HAIR: Readonly<Record<BustHair, HairDef>> = {
  // comma locks
  crop: { outline: CRANIUM_CROP, hairline: HAIRLINE, miniHairline: HAIRLINE, nape: true, lines: alternate(CROP_LOCKS, 0.5) },
  // scalloped outline plus spiral curls, two rows at full
  curls: {
    outline: CRANIUM_CURLS,
    hairline: HAIRLINE_SOFT,
    miniHairline: HAIRLINE_SOFT,
    nape: true,
    lines: [...alternate(CURLS_OUTER.map(([x, y]) => curl(x, y)), 0.5), ...CURLS_INNER.map(([x, y]): Line => [curl(x, y), 0.5, 'f'])]
  },
  // the Livia roll over the brow plus a nape knot
  nodus: {
    outline: CRANIUM_NODUS,
    hairline: HAIRLINE,
    miniHairline: HAIRLINE,
    nape: true,
    lines: [
      ['M38.4 15.6 C36.6 12.4 38.6 9.6 41 10.8 C42.8 11.8 41.8 14.6 39.4 15.4', 0.5],
      ['M37.8 18.2 C34 16.2 28.6 16.2 24.6 19.4', 0.5],
      ['M36.4 20.6 C32.4 19.4 28 20 24.2 23.4', 0.5, 'f'],
      ['M30 24 C27.6 24.4 25.6 26 24.4 28.4', 0.5],
      ['M22.6 31.2 m-2.4 0 a2.4 2.2 0 1 0 4.8 0 a2.4 2.2 0 1 0 -4.8 0', 0.2, 'f']
    ]
  },
  // two or three wave lines
  wavy: {
    outline: CRANIUM_WAVY,
    hairline: HAIRLINE_WAVY,
    miniHairline: HAIRLINE_WAVY,
    nape: true,
    lines: [
      ['M37.94 15.74 C37.71 15.44 37.17 14.29 36.6 13.96 C36.02 13.63 35.11 14.03 34.49 13.74 C33.86 13.45 33.46 12.5 32.85 12.24 C32.25 11.97 31.5 12.05 30.85 12.16 C30.2 12.27 29.62 12.86 28.95 12.92 C28.29 12.98 27.44 12.32 26.83 12.53 C26.23 12.74 25.82 13.69 25.31 14.19 C24.79 14.68 24.33 15.11 23.76 15.53 C23.2 15.95 22.28 16.08 21.92 16.69 C21.55 17.29 21.83 18.43 21.58 19.16 C21.32 19.88 20.7 20.35 20.41 21.04 C20.11 21.73 19.78 22.52 19.8 23.28 C19.83 24.03 20.5 24.78 20.55 25.56 C20.6 26.34 20 27.22 20.09 27.96 C20.18 28.7 20.92 29.67 21.08 30.01', 0.5],
      ['M36.27 16.13 C36.03 16.03 35.28 15.73 34.79 15.55 C34.31 15.38 33.83 15.34 33.38 15.07 C32.93 14.8 32.56 14 32.08 13.91 C31.61 13.83 31.04 14.48 30.54 14.57 C30.04 14.65 29.57 14.44 29.06 14.43 C28.56 14.42 27.95 14.24 27.52 14.49 C27.08 14.75 26.89 15.65 26.46 15.96 C26.02 16.26 25.34 16.06 24.9 16.34 C24.47 16.62 24.13 17.13 23.87 17.63 C23.62 18.13 23.68 18.86 23.38 19.33 C23.07 19.81 22.27 19.99 22.05 20.49 C21.83 20.99 22.09 21.75 22.07 22.34 C22.05 22.93 22.04 23.46 21.93 24.03 C21.82 24.61 21.31 25.25 21.39 25.81 C21.46 26.36 22.21 27.09 22.37 27.35', 0.5, 'f'],
      ['M33.17 16.55 C32.88 16.6 31.97 16.88 31.4 16.84 C30.83 16.8 30.3 16.35 29.75 16.33 C29.2 16.31 28.56 16.41 28.08 16.71 C27.59 17.01 27.32 17.78 26.84 18.13 C26.35 18.47 25.56 18.39 25.15 18.8 C24.75 19.22 24.6 20.01 24.39 20.62 C24.19 21.23 24.16 21.86 23.94 22.47 C23.71 23.08 23.09 23.66 23.05 24.29 C23.02 24.91 23.63 25.89 23.74 26.21', 0.2, 'f']
    ]
  },
  // swept lines into a spiral bun
  bun: {
    outline: CRANIUM_BUN,
    hairline: HAIRLINE_SOFT,
    miniHairline: HAIRLINE_SOFT,
    nape: true,
    lines: [
      ['M18.2 21.6 m-3.6 0 a3.6 3.4 0 1 0 7.2 0 a3.6 3.4 0 1 0 -7.2 0', 0.5],
      ['M39.4 17.6 C34.6 14.6 27 15 21.6 19', 0.5],
      ['M38.4 19.6 C33.6 17.8 27 18.6 21.6 21.4', 0.5, 'f'],
      ['M33 21.6 C29 21 25 22 21.8 23.8', 0.5, 'f'],
      ['M18.2 21.6 m-1.6 0 a1.6 1.5 0 1 1 1.6 1.5', 0.5]
    ]
  },
  // temple fringe and two forehead lines
  bald: {
    outline: CRANIUM_BALD,
    hairline: null,
    miniHairline: BALD_FRINGE,
    nape: false,
    lines: [
      [BALD_FRINGE, 0.5],
      ['M24.4 25.4 l-.4 1.4', 0.5],
      ['M26.2 24.4 l-.3 1.4', 0.5, 'f'],
      ['M28 23.8 l-.2 1.4', 0.5],
      ['M38.6 17.4 C36.8 16.6 34.8 16.8 33.4 17.6', 0.2, 'f'],
      ['M38.8 19.4 C37.2 18.8 35.6 19 34.4 19.6', 0.2, 'f']
    ]
  },
  // a drape line from crown to shoulder with folds
  veil: {
    outline: VEIL,
    hairline: HAIRLINE_VEIL,
    miniHairline: 'M39.4 18.6 C36.2 18.4 34.2 20 33.2 22.2',
    nape: false,
    lines: [
      ['M41.8 17.8 C39.8 16.8 37.8 17 36.4 18.4', 0.5],
      ['M24.6 13 C21.6 18 21 26 21.6 34 C22 38.8 21.4 43 20.2 46.8', 0.5],
      ['M30.2 11.4 C27.4 15 26.6 19.6 27 23.6', 0.5, 'f'],
      ['M36 12.2 C33.6 14.6 32.6 17.2 32.6 19.8', 0.2, 'f']
    ]
  }
}

// ---------- drapery (the main line first, then the folds) ----------

export const DRAPES: Readonly<Record<BustDrapeLine, readonly Line[]>> = {
  // diagonal sinus edge plus folds
  toga: [
    ['M25.2 46 C30.4 47.8 34.6 51.4 36.6 56.6', 0.9],
    ['M18.4 51 C23.6 50.4 28.4 52 31.6 55.8', 0.5],
    ['M21.6 48.4 C26.6 48.6 30.6 50.6 33.6 53.2', 0.5, 'f'],
    ['M36.4 49.4 C39.2 50.6 41.6 52.6 43.2 55', 0.2, 'f']
  ],
  // a fibula ring on the shoulder with radiating folds
  cloak: [
    ['M20.4 49.2 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0', 0.9],
    ['M21.8 50 C26.4 51.4 30.6 53.6 33.2 56.6', 0.5],
    ['M21.2 50.8 C23.4 53 24.8 55 25.4 56.8', 0.5, 'f'],
    ['M19.2 50.6 C18.4 52 17.9 53.4 17.7 55', 0.5, 'f'],
    ['M36.9 47 C35.2 49.4 34.8 52.2 35.6 55.4', 0.2, 'f']
  ],
  // round neckline, vertical folds
  tunic: [
    ['M26 46.6 C28.8 49.6 33.6 49.8 36.7 47.2', 0.9],
    ['M29.2 50.6 C28.8 52.6 29 54.6 29.5 56.4', 0.5],
    ['M33.4 50.6 C33.8 52.6 33.8 54.6 33.4 56.6', 0.5, 'f'],
    ['M22.8 49.8 C22.3 51.8 22.3 53.8 22.7 55.8', 0.2, 'f'],
    ['M40.4 50.2 C41 52 41.2 54 41 55.8', 0.2, 'f']
  ],
  // bare chest, two faint lines
  herm: [
    ['M30.2 51.8 C33.2 52.8 37.2 52.4 40.8 50.8', 0.2],
    ['M22.4 50.6 C24.6 51.8 26.8 52.2 28.8 52', 0.2, 'f']
  ]
}

// ---------- laurel crown: almond leaves in pairs along the head ----------

/** [x, y, rotation°] per leaf; outer leaves at .9, inner at .5 */
type Leaf = readonly [x: number, y: number, rot: number]
const almond = (h: number, w: number): string => `M${-h} 0 Q0 ${-w} ${h} 0 Q0 ${w} ${-h} 0Z`
const CROWN_FULL: readonly (readonly [Leaf, Leaf])[] = [
  [[18.52, 31.15, -145], [19.97, 30.47, -95]],
  [[17.24, 25.3, -122.57], [18.84, 25.22, -72.57]],
  [[18.05, 19.34, -100.14], [19.55, 19.88, -50.14]],
  [[20.81, 14.17, -77.71], [22, 15.25, -27.71]],
  [[25.12, 10.59, -55.29], [25.8, 12.03, -5.29]],
  [[30.31, 9.12, -32.86], [30.39, 10.72, 17.14]],
  [[35.61, 10, -10.43], [35.08, 11.5, 39.57]],
  [[40.22, 13.08, 12], [39.14, 14.27, 62]]
]
const CROWN_SMALL: readonly (readonly [Leaf, Leaf])[] = [
  [[18.52, 31.15, -145], [19.97, 30.47, -95]],
  [[17.65, 20.78, -105.75], [19.2, 21.18, -55.75]],
  [[22.81, 12.14, -66.5], [23.76, 13.43, -16.5]],
  [[31.66, 9.12, -27.25], [31.58, 10.72, 22.75]],
  [[40.22, 13.08, 12], [39.14, 14.27, 62]]
]
/** mini: 4 leaves 7.2 × 2.6 set just outside the skull */
const CROWN_MINI: readonly Leaf[] = [[16.53, 29.23, -156], [16.69, 19.41, -122], [21.74, 11.36, -88], [29.95, 7.84, -54]]
const RIBBON: readonly string[] = ['M18.6 28.6 C17.4 30.8 17 33 16 35.2', 'M19.4 29 C19 31.4 19.2 33.6 18.4 36']

/** the ring each tier draws for avatar slots, centred on that tier's frame */
const RING: Readonly<Record<BustTier, readonly [cx: number, cy: number, r: number]>> = {
  mini: [32, 28, 18.6],
  small: [32, 31, 24.4],
  full: [32, 32, 30.4]
}
const VIEWBOX: Readonly<Record<BustTier, string>> = { mini: MINI_VIEWBOX, small: '7 6 50 50', full: '0 0 64 64' }

const strokeWidth = (tier: BustTier, size: number): number => (tier === 'mini' ? 1.25 : size > 80 ? 1.2 : 1)

/** valid keys only: an unknown hair or beard (a corrupt row) falls back to the default instead of drawing nothing */
function normalise(lookProp: Partial<BustLook> | null | undefined): BustLook {
  const look: BustLook = { ...DEFAULT_LOOK, ...(lookProp ?? {}) }
  if (!BUST_HAIRS.includes(look.hair)) look.hair = DEFAULT_LOOK.hair
  if (!BUST_BEARDS.includes(look.beard)) look.beard = DEFAULT_LOOK.beard
  if (!(look.material in FACING)) look.material = DEFAULT_LOOK.material
  if (!(look.drape in DRAPE_LINE)) look.drape = DEFAULT_LOOK.drape
  look.laurel = look.laurel === true
  return look
}

export function Bust({ look: lookProp, size: sizeProp, title, className, ring = false, socle = true }: BustProps): ReactElement {
  const look = normalise(lookProp)
  const size = Number.isFinite(sizeProp) && sizeProp > 0 ? sizeProp : 32
  const tier = bustTier(size)
  const full = tier === 'full'
  const hair = HAIR[look.hair]
  const facing = FACING[look.material]
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const }
  const keep = (l: Line): boolean => full || l[2] !== 'f'

  const parts: Line[] = []
  const add = (d: string, o: Op): void => {
    parts.push([d, o])
  }
  const leaves: { d: string; o: Op; t: string }[] = []

  if (tier === 'mini') {
    // one persona cue, drawn big: laurel, else the full beard, else the bun
    const cue = look.laurel ? 'laurel' : look.beard === 'full' ? 'beard' : look.hair === 'bun' ? 'bun' : null
    add(cue === 'beard' ? MINI_FACE_BEARD : MINI_FACE, 0.9)
    add(hair.outline, 0.9)
    add(cue === 'beard' ? MINI_NECK_FRONT_BEARD : MINI_NECK_FRONT, 0.9)
    add(MINI_NECK_BACK, 0.9)
    if (cue === 'beard') add(MINI_BEARD, 0.9)
    if (hair.miniHairline) add(hair.miniHairline, 0.5)
    if (cue === 'bun') {
      const [cx, cy, r] = MINI_BUN
      add(`M${cx} ${cy} m-${r} 0 a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 -${r * 2} 0`, 0.9)
    }
    if (cue === 'laurel') for (const [x, y, rot] of CROWN_MINI) leaves.push({ d: almond(3.6, 2.6), o: 0.9, t: `translate(${x} ${y}) rotate(${rot})` })
  } else {
    const fullBeard = look.beard === 'full'
    // face profile, hair outline, neck, shoulders and truncation
    add(fullBeard ? FACE_BEARD : FACE, 0.9)
    add(hair.outline, 0.9)
    add(fullBeard ? NECK_FRONT_BEARD : NECK_FRONT, 0.9)
    add(NECK_BACK, 0.9)
    for (const d of SHOULDERS) add(d, 0.9)
    // beard
    if (fullBeard) {
      add(BEARD, 0.9)
      BEARD_CURLS.forEach((d, i) => (full || i < 2) && add(d, 0.5))
      if (full) add(MOUSTACHE, 0.5)
    }
    // hairline and texture
    if (hair.hairline) add(hair.hairline, 0.5)
    if (hair.nape) add(NAPE, 0.5)
    for (const l of hair.lines) if (keep(l)) parts.push(l)
    // eye, brow, nostril, mouth, ear
    if (full) {
      add(EYE, 0.9)
      add(BROW, 0.5)
      add(NOSTRIL, 0.5)
      add(MOUTH, 0.5)
      add(EAR, 0.9)
      add(EAR_INNER, 0.2)
    } else add(EYE_LINE, 0.9)
    // drapery
    for (const l of DRAPES[DRAPE_LINE[look.drape]]) if (keep(l)) parts.push(l)
    // laurel crown
    if (look.laurel) {
      const [h, w, ih, iw] = full ? [2, 1.4, 1.7, 1.19] : [2.3, 1.6, 1.95, 1.36]
      for (const [outer, inner] of full ? CROWN_FULL : CROWN_SMALL) {
        leaves.push({ d: almond(h, w), o: 0.9, t: `translate(${outer[0]} ${outer[1]}) rotate(${outer[2]})` })
        leaves.push({ d: almond(ih, iw), o: 0.5, t: `translate(${inner[0]} ${inner[1]}) rotate(${inner[2]})` })
      }
    }
    if (full && look.laurel) for (const d of RIBBON) add(d, 0.5)
    // socle
    if (full && socle) for (const d of SOCLE) add(d, 0.5)
  }
  // stubble: a dotted jaw line (small and full; mini keeps its one cue)
  const stubble = tier !== 'mini' && look.beard === 'stubble'

  const drawing = (
    <>
      {parts.map(([d, o], i) => (
        <path key={i} d={d} strokeOpacity={o} />
      ))}
      {stubble && <path d={STUBBLE} strokeOpacity={0.5} strokeDasharray=".01 1.7" />}
      {leaves.map((l, i) => (
        <path key={`l${i}`} className="rm-bust__leaf" d={l.d} strokeOpacity={l.o} transform={l.t} />
      ))}
    </>
  )
  const [rcx, rcy, rr] = RING[tier]

  return (
    <svg
      className={['rm-la', 'rm-bust', `rm-bust--${tier}`, className].filter(Boolean).join(' ')}
      viewBox={VIEWBOX[tier]}
      width={size}
      height={size}
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ strokeWidth: `${strokeWidth(tier, size)}px` }}
      data-tier={tier}
      data-facing={facing}
      {...a11y}
    >
      {ring && <circle className="rm-bust__ring" cx={rcx} cy={rcy} r={rr} strokeOpacity={0.2} />}
      {facing === 'left' ? <g transform="translate(64 0) scale(-1 1)">{drawing}</g> : drawing}
    </svg>
  )
}
