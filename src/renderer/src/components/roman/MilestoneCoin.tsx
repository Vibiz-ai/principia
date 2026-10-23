/**
 * VOICE.md §5.9: a milestone as an engraved rim around a PIXEL-MOSAIC glyph (56-unit box, line art on dark):
 * - earned: ring r 26.5 `--rm-ln-1`, beads r 24.6 `--rm-ln-2`, ring r 22.8 `--rm-ln-3`, and the glyph as a 9 × 9 tile
 *   grid (3-unit pitch, .6 gap) in white with one accent tile (blue, or green for `seal` and `laurel`);
 * - locked: one dashed ring (`2 2.6`) at .38 and the glyph as empty tile outlines at .32 (dim but legible);
 * - below 40 px (the 28 px toast) the glyph switches to its stroked line version (`Glyph`), since 2 px tiles don't read.
 * No wreath, no metal. The label underneath is the caller's; with `title` the coin itself gets role="img" and that
 * name, otherwise it's decorative.
 */
import type { ReactElement } from 'react'
import type { MilestoneGlyph } from '../../lib/voice/copy'
import { LN, glyphTiles } from './geometry'

export interface MilestoneCoinProps {
  glyph: MilestoneGlyph
  earned: boolean
  /** px, default 56; 28 in toasts (line glyph below 40) */
  size?: number
  title?: string
  className?: string
}

/** locked opacities (§5.9: at .2/.16 they vanished on --bg-elevated) */
const LOCKED_RING = 0.38
const LOCKED_TILE = 0.32
/** below this rendered size the pixel glyph becomes the line glyph */
export const PIXEL_GLYPH_MIN = 40

/** The stroked line version of each glyph, centred on 0,0 in a ±8 box (toasts and other sub-40 px coins). */
export function Glyph({ glyph }: { glyph: MilestoneGlyph }): ReactElement {
  switch (glyph) {
    case 'column':
      return <path d="M-6 -8 h12 M-5 -6.5 h10 M-4 -6.5 v12 M-1.3 -6.5 v12 M1.3 -6.5 v12 M4 -6.5 v12 M-5 6.5 h10 M-6 8 h12" />
    case 'scroll':
      return <path d="M-6 -6 h10 a2 2 0 0 1 0 4 h-10 a2 2 0 0 1 0 -4 Z M-6 -2 v8 h10 a2 2 0 0 0 2 -2 v-8 M-3 1 h6 M-3 3.6 h5" />
    case 'quill':
      return <path d="M6 -8 C-2 -6 -5 1 -6 8 M6 -8 C5 -1 0 3 -4 4 M-1 -2 l3 1 M-3 1 l3 1" />
    case 'seal':
      return (
        <>
          <circle r="6" />
          <path d="M-2.5 -1 l2.5 3 l3 -5" />
        </>
      )
    case 'sun':
      return (
        <>
          <circle r="3.5" />
          <path d="M0 -8 v2.5 M0 5.5 v2.5 M-8 0 h2.5 M5.5 0 h2.5 M-5.6 -5.6 l1.8 1.8 M3.8 3.8 l1.8 1.8 M-5.6 5.6 l1.8 -1.8 M3.8 -3.8 l1.8 -1.8" />
        </>
      )
    case 'laurel':
      return <path d="M0 7 C-6 3 -7 -3 -4 -8 M0 7 C6 3 7 -3 4 -8 M-5 2 l-2.5 -.5 M-5.6 -2 l-2.4 -1.2 M5 2 l2.5 -.5 M5.6 -2 l2.4 -1.2" />
    case 'dove':
      return <path d="M-7 1 C-3 -1 0 -6 5 -6 C3 -3 4 -1 7 0 C3 2 -1 5 -7 1 Z M-2 3 l-2 4" />
    case 'coin':
      return (
        <>
          <circle r="6.5" />
          <text y="2.6" textAnchor="middle" fontFamily="Cinzel, Georgia, serif" fontSize="7" stroke="none" fill="#fff">
            C
          </text>
        </>
      )
  }
}

export function MilestoneCoin({ glyph, earned, size = 56, title, className }: MilestoneCoinProps): ReactElement {
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const }
  const pixel = size >= PIXEL_GLYPH_MIN
  return (
    <svg
      className={['rm-la', 'rm-coin', earned ? 'rm-coin--earned' : 'rm-coin--locked', pixel ? 'rm-coin--pixel' : 'rm-coin--line', className].filter(Boolean).join(' ')}
      viewBox="0 0 56 56"
      width={size}
      height={size}
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeLinejoin="round"
      shapeRendering="geometricPrecision"
      {...a11y}
    >
      {earned ? (
        <>
          <circle cx="28" cy="28" r="26.5" strokeOpacity={LN[1]} vectorEffect="non-scaling-stroke" />
          <circle cx="28" cy="28" r="24.6" strokeOpacity={LN[2]} strokeWidth="1.4" strokeDasharray=".01 2.4" vectorEffect="non-scaling-stroke" />
          <circle cx="28" cy="28" r="22.8" strokeOpacity={LN[3]} vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        <circle cx="28" cy="28" r="26.5" strokeOpacity={LOCKED_RING} strokeDasharray="2 2.6" vectorEffect="non-scaling-stroke" />
      )}
      {pixel ? (
        earned ? (
          <g className="rm-coin__glyph" stroke="none" shapeRendering="crispEdges">
            {glyphTiles(glyph, 14.8, 14.8).map((tile, i) => (
              <rect key={i} x={tile.x} y={tile.y} width={tile.size} height={tile.size} fill={tile.fill} />
            ))}
          </g>
        ) : (
          <g className="rm-coin__glyph" strokeOpacity={LOCKED_TILE} strokeWidth=".6">
            {glyphTiles(glyph, 15, 15).map((tile, i) => (
              <rect key={i} x={tile.x} y={tile.y} width="2" height="2" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        )
      ) : (
        <g className="rm-coin__glyph" transform="translate(28 28) scale(1.15)" strokeOpacity={earned ? LN[1] : LOCKED_TILE}>
          <Glyph glyph={glyph} />
        </g>
      )}
    </svg>
  )
}
