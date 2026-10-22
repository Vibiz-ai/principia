/**
 * VOICE.md §5.6: a company on the rail as an engraved coin, line art on dark (no metal, no coloured field):
 * - outer ring r 18.6 at `--rm-ln-1`, a beaded rim r 16.9 (dots, `--rm-ln-2`), an inner ring r 15.2 at `--rm-ln-3`;
 * - the initial in Cinzel 600, filled white .92;
 * - the company colour as ONE 3-unit tessera under the initial (none for Personal);
 * - `laurel` (healthy, §5.10): a stroked wreath in a 48-unit box around the coin, outside the coin's layout box
 *   (negative margin), so the rail never shifts;
 * - `working`: twelve 2-unit blue tesserae on r 13.2 lit one after another (`.rm-wk`, roman.css; static at .6 under
 *   reduced motion);
 * - `failed`: a 6 px red square tessera at the bottom right with a 2 px gap in the surface colour (`.rm-medallion__fail`).
 *   It hides the laurel.
 * - below 24 px (the 18 px menu coin) the beaded rim and inner ring are dropped: three 1 px rings 0.8 px apart read as
 *   one grey smear, so the small coin is the outer ring, the initial and the tessera only.
 *
 * The SVG is decorative; the wrapper carries the accessible name. Pass `label` to set it verbatim (the rail passes
 * "Sunday Bakery, all agents healthy"); the default is the name, plus the plain healthy line when `laurel` is on.
 */
import type { CSSProperties, ReactElement } from 'react'
import { t } from '../../lib/voice/core'
import { WreathGroup, WREATH_48 } from './Laurel'
import { LN, PX, accentColor, f2, initialOf } from './geometry'

export interface MedallionProps {
  name: string
  /** company colour: the one tessera under the initial */
  color?: string
  /** coin diameter in px (default 32; 36 on Portfolio cards, 18 in menus) */
  size?: number
  laurel?: boolean
  working?: boolean
  /** a run failed in the last 24 h: the red square tessera (hides the laurel) */
  failed?: boolean
  /** override the letter (Personal shows "P", which also drops the tessera) */
  initial?: string
  /** accessible name, used verbatim */
  label?: string
  className?: string
  style?: CSSProperties
}

/** the working ring: twelve tiles on r 13.2, clockwise from the top (top-left corner of each 2-unit tile) */
/** below this rendered size the coin keeps only its outer ring (small-size legibility) */
export const MEDALLION_FULL_MIN = 24

export function workingTiles(c: number): { x: string; y: string }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6
    return { x: f2(c + 13.2 * Math.sin(a) - 1), y: f2(c - 13.2 * Math.cos(a) - 1) }
  })
}

export function Medallion({ name, color, size = 32, laurel = false, working = false, failed = false, initial, label, className, style }: MedallionProps): ReactElement {
  const letter = initialOf(initial ?? name)
  const wreathOn = laurel && !failed
  // with the laurel the SVG grows to 48/40 of the coin, and negative margins keep the coin's box where it was
  const box = wreathOn ? 48 : 40
  const c = box / 2
  const px = (size * box) / 40
  const pad = Math.round(((px - size) / 2) * 100) / 100
  const full = size >= MEDALLION_FULL_MIN
  const personal = initial?.trim().toUpperCase() === 'P'
  const tessera = personal ? null : accentColor(color) || PX.a
  const plainName = (name ?? '').trim()
  const accessible = label?.trim() || (wreathOn ? [plainName, t.sr('rail.laurel.sr').toLowerCase()].filter(Boolean).join(', ') : plainName)
  const cls = ['rm-medallion', wreathOn && 'rm-medallion--laurel', working && 'rm-medallion--working', failed && 'rm-medallion--failed', className]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={cls} {...(accessible ? { role: 'img', 'aria-label': accessible } : { 'aria-hidden': true })} style={{ width: size, height: size, ...style }}>
      <svg
        className="rm-la rm-medallion__svg"
        viewBox={`0 0 ${box} ${box}`}
        width={f2(px)}
        height={f2(px)}
        style={pad ? { margin: -pad } : undefined}
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {wreathOn && <WreathGroup {...WREATH_48} />}
        <circle cx={c} cy={c} r="18.6" strokeOpacity={LN[1]} vectorEffect="non-scaling-stroke" />
        {full && <circle cx={c} cy={c} r="16.9" strokeOpacity={LN[2]} strokeWidth="1.4" strokeDasharray=".01 2.2" vectorEffect="non-scaling-stroke" />}
        {full && <circle cx={c} cy={c} r="15.2" strokeOpacity={LN[3]} vectorEffect="non-scaling-stroke" />}
        {working && (
          <g className="rm-medallion__working" stroke="none" shapeRendering="crispEdges">
            {workingTiles(c).map((p, i) => (
              <rect key={i} className="rm-wk" style={{ '--i': i } as CSSProperties} x={p.x} y={p.y} width="2" height="2" fill={PX.b} />
            ))}
          </g>
        )}
        {letter && (
          <text x={c} y={f2(c + 5.2)} textAnchor="middle" fontFamily="Cinzel, Georgia, serif" fontWeight="600" fontSize="14.5" fill="#fff" fillOpacity=".92" stroke="none">
            {letter}
          </text>
        )}
        {tessera && <rect className="rm-medallion__tessera" x={f2(c - 1.5)} y={f2(c + 8.2)} width="3" height="3" stroke="none" shapeRendering="crispEdges" style={{ fill: tessera }} />}
      </svg>
      {failed && <i className="rm-medallion__fail" aria-hidden="true" />}
    </span>
  )
}
