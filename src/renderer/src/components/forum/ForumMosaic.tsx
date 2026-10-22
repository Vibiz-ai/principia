/**
 * VOICE.md §5.8 for the Forum: a pixel-mosaic "speech scroll" (two speech bubbles, white and blue, a silver tail)
 * on the standard 14 × 11 board with the imperial-purple border. Same tiles, pitch and palette as MosaicEmpty.
 */
import { Mosaic, PX, type PxKey, type PxTile } from '../roman'

/** 12 × 9 motif rows (letters are MOSAIC palette keys). */
export const FORUM_MOTIF: readonly string[] = [
  '............',
  '.wwwwwww....',
  '.wsssssw....',
  '.wwwwwwwbbb.',
  '...w.bbbbbb.',
  '..w..baaaab.',
  '.....bbbbbb.',
  '.........b..',
  '..........b.'
]

const COLS = 14
const ROWS = 11
const PITCH = 10
const GAP = 1.6
const r2 = (n: number) => Math.round(n * 100) / 100

export function forumTiles(rows: readonly string[] = FORUM_MOTIF): PxTile[] {
  const size = r2(PITCH - GAP)
  const tiles: PxTile[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let key: PxKey
      if (r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1) key = (r + c) % 2 === 0 ? 'p' : 'P'
      else {
        const ch = (rows[r - 1]?.[c - 1] ?? '.') as PxKey
        key = ch === '.' ? (((r - 1) * 7 + (c - 1) * 3) % 5 ? '.' : ',') : ch in PX ? ch : '.'
      }
      tiles.push({ x: r2(c * PITCH + GAP / 2), y: r2(r * PITCH + GAP / 2), size, fill: PX[key], key })
    }
  }
  return tiles
}

const TILES = forumTiles()

export function ForumMosaic({ width = 120 }: { width?: number }): React.JSX.Element {
  return <Mosaic tiles={TILES} width={width} viewWidth={COLS * PITCH} viewHeight={ROWS * PITCH} className="rm-mosaic--forum" />
}
