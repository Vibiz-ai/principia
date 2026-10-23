/**
 * VOICE.md §5.8: empty states as a pixel mosaic, the approved way to use colour. A 12 × 9 motif inside a one-tile
 * imperial-purple border on grout-dark ground tiles (14 × 11 board, 10-unit pitch, 1.6-unit gap, no jitter,
 * `crispEdges`, full opacity), then one sentence and one action passed as children (DESIGN.md §6). Plain keeps the
 * mosaic; the caller drops the Latin. The mosaic is decorative.
 *
 * `Mosaic` is the generic renderer behind it, reused by the launch ceremony for `pixelWreath()` (§9): with `anim`, each
 * tile gets `rm-tile` and `--i` from its position in `order`, so tiles appear one by one (28 ms, `steps(1)`, roman.css;
 * reduced motion shows them complete). Square tiles only: no rounding, gradients, glow or rotation.
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { MOSAIC_COLS, MOSAIC_PITCH, MOSAIC_ROWS, mosaicTiles, type MosaicMotif, type PxTile } from './geometry'

export type { MosaicMotif }

export interface MosaicProps {
  tiles: readonly PxTile[]
  /** tile indices in reveal order; only read when `anim` (tiles missing from it reveal after the listed ones) */
  order?: readonly number[]
  /** render the tiles with `rm-tile` and a `--i` stagger (the caller decides; skip it under reduced motion) */
  anim?: boolean
  /** rendered width in px; the height keeps the viewBox ratio */
  width?: number
  /** viewBox size in units; defaults to the tile bounds plus the smallest near-side margin on the far sides */
  viewWidth?: number
  viewHeight?: number
  className?: string
  style?: CSSProperties
}

const r2 = (n: number): number => Math.round(n * 100) / 100

function bounds(tiles: readonly PxTile[]): { w: number; h: number } {
  if (tiles.length === 0) return { w: 1, h: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = 0
  let maxY = 0
  for (const t of tiles) {
    minX = Math.min(minX, t.x)
    minY = Math.min(minY, t.y)
    maxX = Math.max(maxX, t.x + t.size)
    maxY = Math.max(maxY, t.y + t.size)
  }
  const m = Math.max(0, Math.min(minX, minY))
  return { w: r2(maxX + m), h: r2(maxY + m) }
}

/** Generic pixel-mosaic SVG: square tesserae, `crispEdges`, aria-hidden. */
export function Mosaic({ tiles, order, anim = false, width, viewWidth, viewHeight, className, style }: MosaicProps): ReactElement {
  const ok = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0
  const b = ok(viewWidth) && ok(viewHeight) ? null : bounds(tiles)
  const vw = ok(viewWidth) ? viewWidth : b!.w
  const vh = ok(viewHeight) ? viewHeight : b!.h
  const w = ok(width) ? width : vw
  let rank: number[] | null = null
  if (anim) {
    rank = new Array<number>(tiles.length).fill(-1)
    let k = 0
    for (const idx of order ?? []) if (idx >= 0 && idx < tiles.length && rank[idx] === -1) rank[idx] = k++
    for (let i = 0; i < rank.length; i++) if (rank[i] === -1) rank[i] = k++
  }
  return (
    <svg
      className={['rm-mosaic', className].filter(Boolean).join(' ')}
      viewBox={`0 0 ${vw} ${vh}`}
      width={w}
      height={r2((w * vh) / vw)}
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={style}
    >
      {tiles.map((tile, i) => (
        <rect
          key={i}
          x={tile.x}
          y={tile.y}
          width={tile.size}
          height={tile.size}
          fill={tile.fill}
          className={rank ? 'rm-tile' : undefined}
          style={rank ? ({ '--i': rank[i] } as CSSProperties) : undefined}
        />
      ))}
    </svg>
  )
}

export interface MosaicEmptyProps {
  motif: MosaicMotif
  /** mosaic width in px (default 140; height keeps the 14:11 board) */
  width?: number
  className?: string
  children?: ReactNode
}

const TILE_CACHE = new Map<MosaicMotif, PxTile[]>()
const tilesFor = (motif: MosaicMotif): PxTile[] => {
  let tiles = TILE_CACHE.get(motif)
  if (!tiles) TILE_CACHE.set(motif, (tiles = mosaicTiles(motif)))
  return tiles
}

export function MosaicEmpty({ motif, width = 140, className, children }: MosaicEmptyProps): ReactElement {
  return (
    <div className={['rm-mosaic-empty', className].filter(Boolean).join(' ')}>
      <Mosaic
        tiles={tilesFor(motif)}
        width={width}
        viewWidth={MOSAIC_COLS * MOSAIC_PITCH}
        viewHeight={MOSAIC_ROWS * MOSAIC_PITCH}
        className={`rm-mosaic--${motif}`}
      />
      {children}
    </div>
  )
}
