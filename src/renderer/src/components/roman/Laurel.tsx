/**
 * VOICE.md §5.5: the laurel as line art. Almond leaf outlines (`--rm-ln-1`) on a stroked stem (`--rm-ln-2`), pairs
 * tilted ±28° off the stem, a tip leaf, a two-tail ribbon. `crown` sits over a head, `wreath` is a full ring open at
 * the top (seals, medallions, badges), `sprig` is a single branch for kickers and list accents. Stroke only, no fill;
 * `draw` makes the outlines draw themselves (stroke-dashoffset, 22 ms stagger). Always decorative.
 */
import type { CSSProperties, ReactElement } from 'react'
import { CROWN_LEAVES, LN, SPRIG, f2, leafPath, wreath, type WreathSpec } from './geometry'

export type LaurelVariant = 'crown' | 'wreath' | 'sprig'
/** There is one tone: white line art. A dimmer look (locked states) is the caller's opacity, never a colour. */
export type LaurelTone = 'line'

export const LAUREL_TONES = {
  line: { stroke: '#fff', leaf: LN[1], stem: LN[2], ribbon: LN[2] }
} as const

const T = LAUREL_TONES.line

/** a legacy ribbon spec (filled knot geometry); any truthy value now draws the line ribbon */
interface LegacyRibbon { y: number; r: number; dx: number; dy: number; sw: number }

export interface WreathGroupProps extends WreathSpec {
  /** stroke width in screen px (non-scaling), clamped to 0.75..1.5; default 1 */
  sw?: number
  /** draw the two-tail ribbon at the bottom */
  ribbon?: boolean | LegacyRibbon
  /** strokes draw themselves (ceremony, seal stamp); the static end state is the full wreath */
  draw?: boolean
}

const strokeWidth = (sw: number | undefined): number => (sw === undefined || sw < 0.75 ? 1 : Math.min(sw, 1.5))
const drawStyle = (draw: boolean | undefined, i: number): CSSProperties | undefined => (draw ? ({ '--i': i } as CSSProperties) : undefined)

/** The wreath as an SVG `<g>`, for use inside other SVGs (Seal, Medallion, MilestoneCoin, the ceremony ring). */
export function WreathGroup({ sw, ribbon, draw, ...spec }: WreathGroupProps): ReactElement {
  const w = wreath(spec)
  const half = w.leaves.length / 2
  const dr = draw ? 'rm-draw' : undefined
  return (
    <g
      className={draw ? 'rm-laurel rm-laurel--draw' : 'rm-laurel'}
      fill="none"
      stroke={T.stroke}
      strokeWidth={strokeWidth(sw)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {w.stems.map((d, i) => (
        <path key={`s${i}`} d={d} strokeOpacity={T.stem} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, 0)} />
      ))}
      {w.leaves.map((l, i) => (
        // both branches draw together, pair by pair from the bottom
        <path key={i} {...leafPath(l)} strokeOpacity={T.leaf} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, i % half)} />
      ))}
      {ribbon && (
        <>
          <path d={w.knot} strokeOpacity={T.leaf} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, 0)} />
          <path d={w.tails} strokeOpacity={T.ribbon} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, 1)} />
        </>
      )}
    </g>
  )
}

/** The 48-unit wreath (rail healthy ring, badges): 6 pairs on r 21.6, open at the top (VOICE.md §5.6, §5.10). */
export const WREATH_48: WreathGroupProps = {
  cx: 24, cy: 24.3, r: 21.6, pairs: 6, start: 100, end: -50, rx: 2, ry: 0.675, sw: 1
}

export interface LaurelProps {
  variant: LaurelVariant
  /** width in px; the height follows the variant's aspect ratio */
  size: number
  draw?: boolean
  className?: string
}

export function Laurel({ variant, size, draw, className }: LaurelProps): ReactElement {
  const cls = ['rm-la', 'rm-laurel-svg', `rm-laurel-svg--${variant}`, className].filter(Boolean).join(' ')
  const dr = draw ? 'rm-draw' : undefined
  if (variant === 'sprig') {
    return (
      <svg className={cls} viewBox={`0 0 ${SPRIG.w} ${SPRIG.h}`} width={size} height={f2((size * SPRIG.h) / SPRIG.w)} fill="none" stroke="#fff" aria-hidden="true">
        <g className={draw ? 'rm-laurel rm-laurel--draw' : 'rm-laurel'}>
          <path d={SPRIG.stem} strokeOpacity={T.stem} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, 0)} />
          {SPRIG.leaves.map((l, i) => (
            <path key={i} {...leafPath(l)} strokeOpacity={T.leaf} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, i + 1)} />
          ))}
        </g>
      </svg>
    )
  }
  if (variant === 'crown') {
    // the bust crown, cropped to its leaves (x 16..48, y 11..26 in bust space)
    return (
      <svg className={cls} viewBox="16 11 32 15" width={size} height={f2((size * 15) / 32)} fill="none" stroke="#fff" aria-hidden="true">
        <g className={draw ? 'rm-laurel rm-laurel--draw' : 'rm-laurel'}>
          {CROWN_LEAVES.map((l, i) => (
            <path key={i} {...leafPath(l)} strokeOpacity={T.leaf} vectorEffect="non-scaling-stroke" pathLength={1} className={dr} style={drawStyle(draw, i)} />
          ))}
        </g>
      </svg>
    )
  }
  return (
    <svg className={cls} viewBox="0 0 48 48" width={size} height={size} fill="none" stroke="#fff" aria-hidden="true">
      <WreathGroup {...WREATH_48} ribbon draw={draw} />
    </svg>
  )
}
