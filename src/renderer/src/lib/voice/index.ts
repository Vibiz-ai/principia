/**
 * VOICE.md §2: the copy module. Components ask here for every flavored string; Settings → Tone → Plain turns the
 * flavor off everywhere at once. Pure helpers live in core.ts (testable without the store); the hooks live here.
 */
import { useCallback } from 'react'
import type { Settings } from '@shared/types'
import { useStore } from '../../state/store'
import { t, type Tone, type Vars } from './core'
import type { CopyKey } from './copy'

export * from './core'
export { COPY, MILESTONE_COPY, type CopyKey, type Entry, type MilestoneCopy, type MilestoneGlyph, type MilestoneKey } from './copy'
export { LATIN, type LatinKey, type LatinPhrase } from './latin'
export { inscription, toRoman, type Inscription } from '@shared/roman'

/** VOICE.md §0: absent = 'playful'. */
export const toneOf = (settings: Pick<Settings, 'tone'> | null | undefined): Tone => (settings?.tone === 'plain' ? 'plain' : 'playful')
/** VOICE.md §0: absent = true. */
export const personasOn = (settings: Pick<Settings, 'personas'> | null | undefined): boolean => settings?.personas !== false

/**
 * The current tone. Until settings:get resolves (settings null) it is plain: a user who chose Plain never sees a
 * flash of playful copy at startup, and plain is always a correct reading of the same meaning.
 */
export function useTone(): Tone {
  return useStore((s) => (s.settings ? toneOf(s.settings) : 'plain'))
}
export function usePersonasOn(): boolean {
  return useStore((s) => personasOn(s.settings))
}
/** `t` bound to the current tone. */
export function useCopy(): (key: CopyKey, vars?: Vars) => string {
  const tone = useTone()
  return useCallback((key: CopyKey, vars?: Vars) => t(key, vars, tone), [tone])
}
