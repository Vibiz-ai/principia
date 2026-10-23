/**
 * VOICE.md §5.7: the onboarding stage's arch, the reference drawing of the whole Roman system. Two fluted columns
 * (capital, shaft with five flutes, base) carrying a semicircular double arch with voussoir joints and a keystone,
 * engraved in white stroke tiers: `--rm-ln-1` cornices and shafts, `--rm-ln-2` inner arch, capitals and keystone,
 * `--rm-ln-3` flutes and voussoirs. Every element has pathLength=1 so callers can add `rm-draw` (`draw` does it).
 * Frames the 600 px column at >= 1100 px and is hidden below (roman.css). Decorative; geometry from docs/voice.html.
 */
import type { CSSProperties, ReactElement } from 'react'
import { ARCH, LN } from './geometry'

export interface ArchFrameProps {
  /** 0..1, default .14 */
  opacity?: number
  /** strokes draw themselves (ceremony); the static end state is the full drawing */
  draw?: boolean
  className?: string
  style?: CSSProperties
}

interface Ln { strokeOpacity: number; pathLength: number; className?: string }

function Column({ x, ln }: { x: number; ln: (tier: 1 | 2 | 3) => Ln }): ReactElement {
  return (
    <g>
      <rect x={x} y="96" width="62" height="9" {...ln(1)} />
      <rect x={x + 4} y="105" width="54" height="7" {...ln(2)} />
      <rect x={x + 10} y="112" width="42" height="150" {...ln(1)} />
      {ARCH.flutes.map((dx) => (
        <line key={dx} x1={x + dx} y1="118" x2={x + dx} y2="256" {...ln(3)} />
      ))}
      <rect x={x + 4} y="262" width="54" height="9" {...ln(2)} />
      <rect x={x - 2} y="271" width="66" height="10" {...ln(1)} />
    </g>
  )
}

export function ArchFrame({ opacity = 0.14, draw, className, style }: ArchFrameProps): ReactElement {
  const ln = (tier: 1 | 2 | 3): Ln => ({ strokeOpacity: LN[tier], pathLength: 1, className: draw ? 'rm-draw' : undefined })
  return (
    <svg
      className={['rm-la', 'rm-arch', className].filter(Boolean).join(' ')}
      viewBox={`0 0 ${ARCH.W} ${ARCH.H}`}
      preserveAspectRatio="none"
      fill="none"
      stroke="#fff"
      strokeWidth="1"
      // drawn at up to ~1.9x its 420 x 300 box on the stage (.ob-arch 700 x 560): the dash must cover that (roman.css .rm-draw)
      style={{ opacity, ...(draw ? ({ '--rm-ds': 2.5 } as CSSProperties) : null), ...style }}
      aria-hidden="true"
    >
      {ARCH.columns.map((x) => (
        <Column key={x} x={x} ln={ln} />
      ))}
      <path d={ARCH.outerD} {...ln(1)} />
      <path d={ARCH.innerD} {...ln(2)} />
      {ARCH.voussoirs.map((v, i) => (
        <line key={i} {...v} {...ln(3)} />
      ))}
      <path d={ARCH.keystone} {...ln(2)} />
    </svg>
  )
}
