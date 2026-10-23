/**
 * VOICE.md §5.7: onboarding progress as pixel tesserae. Square 11 px tiles, 3 px apart, no tilt (roman.css `.rm-tess`):
 * todo is an inset `--rm-ln-3` outline, the current tile an inset `--rm-ln-1` outline with a 4 px blue pixel, breathing
 * slower than 1 Hz (static with reduced motion), done tiles are solid white. The tiles are decoration; the visible
 * "Step n of N" carries the meaning, in both tones.
 */
import type { ReactElement } from 'react'
import { t } from '../../lib/voice/core'

export interface TesseraeProps {
  /** 0-based index of the current step */
  index: number
  total: number
  className?: string
}

export function Tesserae({ index, total, className }: TesseraeProps): ReactElement {
  const count = Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 1
  const current = Number.isFinite(index) ? Math.min(Math.max(0, Math.floor(index)), count - 1) : 0
  return (
    <div className={['rm-tess', className].filter(Boolean).join(' ')}>
      <span className="rm-tess__tiles" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => {
          const state = i < current ? 'done' : i === current ? 'cur' : 'todo'
          return <b key={i} className={`rm-tess__tile rm-tess__tile--${state}`} />
        })}
      </span>
      <span className="rm-tess__label">{t('ob.progress', { n: current + 1, total: count })}</span>
    </div>
  )
}
