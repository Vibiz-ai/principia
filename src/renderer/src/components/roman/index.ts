/** VOICE.md §5: the Roman theme components (line art + pixel mosaic). Styles live in styles/roman.css (imported once in main.tsx). */
export { Bust, bustTier, DEFAULT_LOOK, type BustProps, type BustTier } from './Bust'
export { Laurel, WreathGroup, WREATH_48, LAUREL_TONES, type LaurelProps, type LaurelTone, type LaurelVariant, type WreathGroupProps } from './Laurel'
export { Seal, SEAL_WREATH, type SealProps } from './Seal'
export { Medallion, type MedallionProps } from './Medallion'
export { Tesserae, type TesseraeProps } from './Tesserae'
export { PassportTablet, inscriptionSize, type PassportTabletProps, type TabletLayout, type TabletMeta } from './PassportTablet'
export { Plinth, type PlinthProps } from './Plinth'
export { ArchFrame, type ArchFrameProps } from './ArchFrame'
export { MosaicEmpty, Mosaic, type MosaicEmptyProps, type MosaicProps, type MosaicMotif } from './MosaicEmpty'
export { MilestoneCoin, type MilestoneCoinProps } from './MilestoneCoin'
export { LatinLine, type LatinLineProps } from './LatinLine'
export {
  initialOf,
  wreath,
  wreathLeaves,
  leafPath,
  mosaicTiles,
  glyphTiles,
  pixelWreath,
  pediment,
  meander,
  plinthPaths,
  LN,
  PX,
  ARCH,
  ROUNDEL,
  MOSAIC_MOTIFS,
  MILESTONE_GLYPHS,
  type PxKey,
  type PxTile,
  type PxWreathTile,
  type StrokePath,
  type MilestoneGlyph,
  type Leaf,
  type WreathSpec
} from './geometry'
