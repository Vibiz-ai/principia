/**
 * VOICE.md §5.3: the seal as a line-drawn laurel roundel (64-unit box). A ground disc in the surface colour (it only
 * occludes the rules behind it), an outer ring, a beaded rim drawn as dots, an inner ring, a stroked wreath of 8 leaf
 * pairs with a ribbon, the initial in Cinzel 600 as an outline (stroke only) and the company's one accent: a 3.4-unit
 * tessera in the gap at the top of the wreath. Before launch it's a dashed circle and a ghost outlined initial.
 *
 * `stamp` (alias `draw`) draws the strokes once, in order: outer then inner ring (0 to 300 ms), the beads appear
 * (300 ms), the leaves draw pair by pair (from 300 ms), the initial draws (500 to 700 ms), the tessera appears last
 * (700 ms). No scale, no rotation, nothing scatters. The motion classes (`rm-draw`, `rm-tile`) only animate inside roman.css's
 * prefers-reduced-motion: no-preference block, so reduced motion shows the drawn end state. Both tones: it's a state
 * change ("Launched"), not a joke.
 */
import type { CSSProperties, ReactElement } from 'react'
import { t } from '../../lib/voice/core'
import { WreathGroup } from './Laurel'
import { LN, ROUNDEL, accentColor, initialOf } from './geometry'

export interface SealProps {
  /** the letter in the middle; defaults to the first character of `name` */
  initial?: string
  /** the business name (source of the initial) */
  name?: string
  /** company colour (any CSS colour): only the one accent tessera; `--text-tertiary` without one */
  color?: string
  /** px, default 56 (portrait passport); 72 landscape, 36 card, 64 to 100 in the ceremony */
  size?: number
  /** launched: the roundel; otherwise the dashed outline */
  pressed: boolean
  /** draw the roundel's strokes once on mount (only meaningful with `pressed`) */
  stamp?: boolean
  /** alias of `stamp` */
  draw?: boolean
  /** fill of the occluding ground disc: the surface the seal sits on (default `var(--rm-ink)`) */
  ground?: string
  className?: string
  style?: CSSProperties
}

/** The seal's wreath (ROUNDEL.wreath) as WreathGroup props: 8 pairs on r 19.4 from 106° to −54°, with the ribbon. */
export const SEAL_WREATH = { ...ROUNDEL.wreath, sw: 1, ribbon: true } as const

/** CSS custom properties for the draw-in, typed loosely (React's CSSProperties has no `--*` keys). */
type Vars = CSSProperties & Record<`--${string}`, string | number>

/** Stroke width in screen px for a rendered size (§5.2): 1 px, 1.2 px above 80 px, a touch finer on the 36 px card. */
const strokeFor = (size: number): number => (size > 80 ? 1.2 : size <= 40 ? 0.9 : 1)

export function Seal({ initial, name, color, size = 56, pressed, stamp, draw, ground, className, style }: SealProps): ReactElement {
  const R = ROUNDEL
  const letter = initialOf(initial ?? name)
  const label = t.sr(pressed ? 'pp.seal.sr.done' : 'pp.seal.sr.open')
  const stamping = pressed && !!(stamp || draw)
  const sw = strokeFor(size)
  const cls = ['rm-seal', pressed ? 'rm-seal--pressed' : 'rm-seal--open', stamping && 'rm-seal--stamp', className].filter(Boolean).join(' ')
  // pathLength is in user units but dashes land in screen px under non-scaling strokes: scale the dash with the size
  const ds = Math.max(1, Math.ceil((size / R.box) * 100) / 100)
  const svgStyle: Vars = { strokeWidth: sw, ...(stamping ? { '--rm-ds': ds } : {}) }
  const dr = stamping ? 'rm-draw' : undefined
  const ring = (i: number): Vars | undefined => (stamping ? { '--i': i, animationDuration: '240ms' } : undefined)

  return (
    <span className={cls} role="img" aria-label={label} style={{ width: size, height: size, ...style }}>
      <svg
        className="rm-la rm-seal__svg"
        viewBox={`0 0 ${R.box} ${R.box}`}
        width={size}
        height={size}
        fill="none"
        stroke="#fff"
        aria-hidden="true"
        style={svgStyle}
      >
        {pressed ? (
          <>
            <circle className="rm-seal__ground" cx={R.c} cy={R.c} r={R.ground} stroke="none" style={{ fill: ground || 'var(--rm-ink)' }} />
            <circle cx={R.c} cy={R.c} r={R.outer} strokeOpacity={LN[1]} pathLength={1} className={dr} style={ring(0)} />
            <circle
              className={stamping ? 'rm-seal__beads rm-tile' : 'rm-seal__beads'}
              cx={R.c}
              cy={R.c}
              r={R.beads}
              strokeOpacity={LN[2]}
              strokeWidth={R.beadWidth}
              strokeDasharray={R.beadDash}
              style={stamping ? ({ '--rm-delay': '300ms' } as Vars) : undefined}
            />
            <circle cx={R.c} cy={R.c} r={R.inner} strokeOpacity={LN[3]} pathLength={1} className={dr} style={ring(1)} />
            <g style={stamping ? ({ '--rm-delay': '300ms' } as Vars) : undefined}>
              <WreathGroup {...SEAL_WREATH} sw={sw} draw={stamping} />
            </g>
            {letter && (
              <text
                className={stamping ? 'rm-seal__initial rm-draw' : 'rm-seal__initial'}
                x={R.initial.x}
                y={R.initial.y}
                textAnchor="middle"
                fontFamily="Cinzel, Georgia, serif"
                fontWeight={600}
                fontSize={R.initial.size}
                fill="none"
                strokeOpacity={LN[1]}
                // text has no pathLength: a 60 px dash covers each glyph outline, so it draws from its start
                style={stamping ? ({ '--rm-ds': 60, '--rm-delay': '500ms', animationDuration: '200ms' } as Vars) : undefined}
              >
                {letter}
              </text>
            )}
            <rect
              className={stamping ? 'rm-seal__accent rm-tile' : 'rm-seal__accent'}
              x={R.accent.x}
              y={R.accent.y}
              width={R.accent.size}
              height={R.accent.size}
              stroke="none"
              shapeRendering="crispEdges"
              style={{ fill: accentColor(color) || 'var(--text-tertiary)', ...(stamping ? { '--rm-delay': '700ms' } : {}) } as Vars}
            />
          </>
        ) : (
          <>
            <circle cx={R.c} cy={R.c} r={R.unsealed} strokeOpacity={LN[3]} strokeDasharray={R.unsealedDash} />
            {letter && (
              <text
                className="rm-seal__initial"
                x={R.c}
                y={38.2}
                textAnchor="middle"
                fontFamily="Cinzel, Georgia, serif"
                fontWeight={600}
                fontSize={17}
                fill="none"
                strokeOpacity={0.22}
              >
                {letter}
              </text>
            )}
          </>
        )}
      </svg>
    </span>
  )
}
