/**
 * VOICE.md §5.3: the Business Passport as an engraved card on `--rm-ink`. A double rule (outer `--rm-ln-2`, inner
 * `--rm-ln-4` 4 px inside) with four corner lozenges, a pediment drawn across the top with the company colour as one
 * 5 px tessera in the tympanum (the only accent), the label between hairlines, the Cinzel inscription in white with
 * `--rm-ln-2` interpuncts, the readable name, the one-liner, meta rows separated by hairlines, the founding line and
 * the line-drawn laurel roundel seal, inside the frame (so BeamBorder never clips it). No material, no radius.
 *
 * The inscription is aria-hidden (a screen reader would spell "SVNDAY" letter by letter); the readable name is the
 * accessible name. Words are joined by an interpunct followed by `<wbr>`, with `word-break: keep-all`, so a line only
 * breaks after an interpunct; landscape never wraps (a wrapped `SVNDAY·` leaves the interpunct dangling) and steps the
 * size down instead. Playful uses classical letters (U → V, J → I) and a Roman-numeral year; plain keeps the craft
 * and drops both. Inside BeamBorder, pass `className="rm-pp--beam"` so the outer rule steps down to `--rm-ln-3`.
 */
import { Fragment, type CSSProperties, type ReactElement } from 'react'
import { inscription, INTERPUNCT } from '@shared/roman'
import { t, type Tone } from '../../lib/voice/core'
import { accentColor, pediment, f2 } from './geometry'
import { Seal } from './Seal'
import { useToneProp } from './tone'

export type TabletLayout = 'portrait' | 'landscape' | 'card'

export interface TabletMeta {
  label: string
  value: string
}

export interface PassportTabletProps {
  name: string
  oneLiner?: string
  /** company colour: only the one tessera in the pediment and the seal's accent tessera */
  color?: string
  /** Stack, Site, Voice, Goals… (portrait and landscape only) */
  meta?: readonly TabletMeta[]
  /** launched: the laurel roundel; otherwise the dashed outline */
  sealed?: boolean
  /** draw the seal's strokes once when this mounts sealed (the flow entering Ready) */
  stampOnMount?: boolean
  layout?: TabletLayout
  tone?: Tone
  /** founding year; defaults to the current year */
  founded?: number
  className?: string
  style?: CSSProperties
}

const SEAL_SIZE: Record<TabletLayout, number> = { portrait: 56, landscape: 72, card: 36 }
const BASE_SIZE: Record<TabletLayout, number> = { portrait: 22, landscape: 24, card: 19 }
const MIN_SIZE = 16
/** usable inscription width in px for each layout (frame, padding, column and the card's seal gutter subtracted) */
const INS_WIDTH: Record<TabletLayout, number> = { portrait: 214, landscape: 236, card: 200 }
/** Cinzel caps advance plus the .1em tracking, per character, in em */
const CHAR_EM = 0.88

/** characters that must fit on one line: the longest word plus its interpunct, or the whole line in landscape */
function lineChars(parts: readonly string[], layout: TabletLayout): number {
  if (layout === 'landscape') return parts.reduce((n, p) => n + Array.from(p).length, 0) + Math.max(0, parts.length - 1)
  return parts.reduce((n, p) => Math.max(n, Array.from(p).length + 1), 0)
}

/**
 * VOICE.md §5.3: 22 px portrait / 24 px landscape / 19 px card, stepping down to a 16 px minimum so the longest word
 * fits (landscape: so the whole line fits, since it never wraps).
 */
export function inscriptionSize(parts: readonly string[], layout: TabletLayout): number {
  const chars = lineChars(parts, layout)
  if (!chars) return BASE_SIZE[layout]
  const fit = Math.floor(INS_WIDTH[layout] / (chars * CHAR_EM))
  return Math.max(MIN_SIZE, Math.min(BASE_SIZE[layout], fit))
}

/** pediment box per layout (§5.3): portrait 236 × 44, landscape 500 × 50 span 300, card 250 × 32 span 170 */
const PEDIMENT: Record<TabletLayout, { w: number; h: number; span?: number }> = {
  portrait: { w: 236, h: 44 },
  landscape: { w: 500, h: 50, span: 300 },
  card: { w: 250, h: 32, span: 170 }
}
const PEDIMENT_ART = {
  portrait: pediment(PEDIMENT.portrait.w, PEDIMENT.portrait.h),
  landscape: pediment(PEDIMENT.landscape.w, PEDIMENT.landscape.h, PEDIMENT.landscape.span),
  card: pediment(PEDIMENT.card.w, PEDIMENT.card.h, PEDIMENT.card.span)
} as const

/** the empty passport's rows, already drawn as dashed hairlines: a form being filled in, not a void */
const GHOST_ROWS = ['Site', 'Voice', 'Goals'] as const
const GHOST_VALUE = 'not yet'

function Pediment({ layout, color }: { layout: TabletLayout; color?: string }): ReactElement {
  const { w, h } = PEDIMENT[layout]
  const { paths, accent } = PEDIMENT_ART[layout]
  return (
    <svg className="rm-la rm-pp__pedsvg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} fill="none" stroke="#fff" aria-hidden="true">
      {paths.map((p, i) => (
        <path key={i} d={p.d} strokeOpacity={p.o} />
      ))}
      <rect
        className="rm-pp__tessera"
        x={f2(accent.x)}
        y={f2(accent.y)}
        width={accent.size}
        height={accent.size}
        stroke="none"
        shapeRendering="crispEdges"
        style={{ fill: accentColor(color) || 'var(--text-tertiary)' }}
      />
    </svg>
  )
}

export function PassportTablet({
  name,
  oneLiner,
  color,
  meta,
  sealed = false,
  stampOnMount = false,
  layout = 'portrait',
  tone: toneProp,
  founded,
  className,
  style
}: PassportTabletProps): ReactElement {
  const tone = useToneProp(toneProp)
  const playful = tone === 'playful'
  const readable = (name ?? '').trim()
  const ins = inscription(readable, { classical: playful })
  const empty = ins.parts.length === 0
  const year = Number.isInteger(founded) && (founded as number) >= 1 && (founded as number) <= 3999 ? (founded as number) : new Date().getFullYear()
  const foundedText = t('pp.founded', { year }, tone)
  const fontSize = inscriptionSize(ins.parts, layout)
  const land = layout === 'landscape'
  const card = layout === 'card'
  // last resort: a landscape line too long even at 16 px wraps (after an interpunct) rather than overflow the card
  const tooLong = land && lineChars(ins.parts, layout) * CHAR_EM * MIN_SIZE > INS_WIDTH.landscape
  const last = ins.parts.length - 1

  const inscriptionEl = empty ? (
    <div className="rm-pp__ins is-empty">{t('pp.empty')}</div>
  ) : (
    <div className="rm-pp__ins" aria-hidden="true" style={tooLong ? { fontSize, whiteSpace: 'normal', overflowWrap: 'anywhere' } : { fontSize }}>
      {ins.parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < last && (
            <>
              <span className="rm-pp__dot">{INTERPUNCT}</span>
              <wbr />
            </>
          )}
        </Fragment>
      ))}
    </div>
  )

  const nameEl = empty ? null : card ? <span className="rm-sr">{readable}</span> : <div className="rm-pp__name">{readable}</div>
  const lineEl = !card && oneLiner?.trim() ? <div className="rm-pp__line">{oneLiner.trim()}</div> : null
  const metaEl = card ? null : meta && meta.length > 0 ? (
    <div className="rm-pp__meta">
      {meta.map((m, i) => (
        <div key={`${i}:${m.label}`} className="rm-pp__row">
          <span>{m.label}</span>
          {/* long values ellipsize on the passport; the hover title keeps the whole value reachable */}
          <b title={m.value}>{m.value}</b>
        </div>
      ))}
    </div>
  ) : empty ? (
    <div className="rm-pp__meta rm-pp__meta--ghost" aria-hidden="true">
      {GHOST_ROWS.map((label) => (
        <div key={label} className="rm-pp__row">
          <span>{label}</span>
          <b>{GHOST_VALUE}</b>
        </div>
      ))}
    </div>
  ) : null

  const seal = (
    <Seal className="rm-pp__seal" name={readable} color={color} size={SEAL_SIZE[layout]} pressed={sealed} stamp={sealed && stampOnMount} />
  )
  const footEl = card ? null : (
    <div className="rm-pp__foot">
      {playful ? (
        <div className="rm-pp__founded" title={String(year)}>
          <span aria-hidden="true">{foundedText}</span>
          <span className="rm-sr">{t.sr('pp.founded', { year })}</span>
        </div>
      ) : (
        <div className="rm-pp__founded">{foundedText}</div>
      )}
      {seal}
    </div>
  )

  const corners = [0, 1, 2, 3].map((i) => <i key={i} className={`rm-cn rm-cn${i}`} aria-hidden="true" />)
  const ped = (
    <div className={land ? 'rm-pp__ped rm-pp__span' : 'rm-pp__ped'}>
      <Pediment layout={layout} color={color} />
    </div>
  )
  const label = <div className={land ? 'rm-pp__lbl rm-pp__span' : 'rm-pp__lbl'}>{t('pp.label')}</div>

  return (
    <div className={['rm-pp', `rm-pp--${layout}`, sealed ? 'rm-pp--sealed' : 'rm-pp--open', className].filter(Boolean).join(' ')} style={style}>
      {corners}
      {ped}
      {label}
      {land ? (
        <>
          <div className="rm-pp__col">
            {inscriptionEl}
            {nameEl}
            {lineEl}
          </div>
          <div className="rm-pp__col">
            {metaEl}
            {footEl}
          </div>
        </>
      ) : (
        <>
          {inscriptionEl}
          {nameEl}
          {lineEl}
          {metaEl}
          {footEl}
          {card && seal}
        </>
      )}
    </div>
  )
}
