/**
 * VOICE.md §5.7: an agent presented as a line-art bust on a drawn plinth (onboarding "Meet your team", the ceremony).
 * The plinth is strokes only: a cap rule (--rm-ln-1), an inner rule (--rm-ln-3), tapering sides, a base slab and a
 * ground line (--rm-ln-2), stretched to the card width with non-scaling strokes. The name is lettered inside it in
 * Cinzel (MARCVS in playful, MARCUS in plain) and aria-hidden; a visually hidden plain name carries the meaning.
 * Personality, first task, switches and rename go in `children`, under the role label.
 */
import type { ReactElement, ReactNode } from 'react'
import type { AgentPersona } from '@shared/personas'
import { inscription } from '@shared/roman'
import type { Tone } from '../../lib/voice/core'
import { Bust } from './Bust'
import { useToneProp } from './tone'

export interface PlinthProps {
  /** a legacy agent without a persona still renders: default bust, no lettered name */
  persona?: Partial<Pick<AgentPersona, 'name' | 'look'>> | null
  /** the role label ("Copywriter"); always shown */
  role: string
  /** bust size in px (64 on the plan, 88 in the ceremony) */
  size?: number
  tone?: Tone
  className?: string
  children?: ReactNode
}

/** 130 × 34, stretched (`preserveAspectRatio="none"`); strokes stay 1 px through `.rm-la`'s non-scaling stroke */
export const PLINTH_LINES: readonly (readonly [d: string, o: number])[] = [
  ['M14 1 H116', 0.9], // cap rule
  ['M18 4 H112', 0.2], // inner rule
  ['M14 1 L8 25 M116 1 L122 25', 0.9], // tapering sides
  ['M4 25 H126 V29 H4 Z', 0.9], // base slab
  ['M1 33 H129', 0.5] // ground line
]

export function Plinth({ persona, role, size = 64, tone: toneProp, className, children }: PlinthProps): ReactElement {
  const tone = useToneProp(toneProp)
  const name = (persona?.name ?? '').trim()
  const lettered = inscription(name, { classical: tone === 'playful' }).text
  return (
    <div className={['rm-plinth', className].filter(Boolean).join(' ')}>
      <Bust look={persona?.look} size={size} socle={false} className="rm-plinth__bust" />
      {/* a renamed persona can be long: the lettering ellipsizes and the hover title shows the whole readable name */}
      <div className="rm-plinth__base" aria-hidden="true" title={name || undefined}>
        <svg
          className="rm-la rm-plinth__svg"
          viewBox="0 0 130 34"
          preserveAspectRatio="none"
          fill="none"
          stroke="#fff"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {PLINTH_LINES.map(([d, o]) => (
            <path key={d} d={d} strokeOpacity={o} />
          ))}
        </svg>
        {lettered && <span className="rm-plinth__carving">{lettered}</span>}
      </div>
      {name && <span className="rm-sr">{name}</span>}
      <div className="rm-plinth__role">{role}</div>
      {children}
    </div>
  )
}
