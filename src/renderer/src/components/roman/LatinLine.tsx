/**
 * VOICE.md §2, §6: a Latin phrase with its translation, playful only. The Latin is `lang="la"` and hidden from screen
 * readers (they'd mangle it, and an aria-label on a plain span is ignored by most readers); the English stays visible
 * in --text-secondary because the translation is the meaning. Renders nothing in plain.
 */
import type { ReactElement } from 'react'
import { latinPair, type LatinPair, type Tone } from '../../lib/voice/core'
import type { LatinKey } from '../../lib/voice/latin'
import { useToneProp } from './tone'

export interface LatinLineProps {
  /** a phrase from LATIN ('festina'); or pass `pair` from latinLine()/loadingLine() */
  k?: LatinKey
  pair?: LatinPair | null
  tone?: Tone
  className?: string
}

export function LatinLine({ k, pair, tone: toneProp, className }: LatinLineProps): ReactElement | null {
  const tone = useToneProp(toneProp)
  if (tone !== 'playful') return null
  const p = pair ?? (k ? latinPair(k) : null)
  if (!p) return null
  return (
    <span className={['rm-latin-line', className].filter(Boolean).join(' ')}>
      <span className="rm-latin" lang="la" aria-hidden="true" aria-label={p.en}>
        {p.la}
      </span>{' '}
      <span className="rm-latin__en">{`· ${p.en}`}</span>
    </span>
  )
}
