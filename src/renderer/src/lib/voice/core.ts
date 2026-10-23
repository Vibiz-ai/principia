/**
 * VOICE.md §2: the pure half of the copy module (no store, no React), so tests and non-React code can use it.
 * index.ts re-exports all of this plus the hooks.
 */
import { toRoman } from '@shared/roman'
import { COPY, MILESTONE_COPY, type CopyKey, type Entry, type MilestoneKey } from './copy'
import { LATIN, type LatinKey } from './latin'

export type Tone = 'playful' | 'plain'
export type Vars = Record<string, string | number>
export interface LatinPair { la: string; en: string }

/** `{name}` and `{year|roman}`; a missing var becomes ''. */
const VAR = /\{([a-zA-Z][\w]*)(?:\|(roman))?\}/g

export function interpolate(text: string, vars?: Vars): string {
  return text.replace(VAR, (_m, name: string, filter?: string) => {
    const v = vars?.[name]
    if (v === undefined || v === null) return ''
    if (filter === 'roman') {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isInteger(n) && n >= 1 && n <= 3999 ? toRoman(n) : String(v)
    }
    return String(v)
  })
}

/** The `{var}` names a template uses (filters stripped). */
export function varsOf(text: string): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1])
}

/**
 * The string for `key` in `tone` (default 'plain', so flavor is never accidental outside useCopy). Playful falls back
 * to plain when an entry has no playful form.
 */
export function t(key: CopyKey, vars?: Vars, tone: Tone = 'plain'): string {
  const e: Entry | undefined = COPY[key]
  if (!e) return ''
  return interpolate(tone === 'playful' && e.playful ? e.playful : e.plain, vars)
}
/** Screen readers always hear the plain form. */
t.sr = (key: CopyKey, vars?: Vars): string => t(key, vars, 'plain')

export function latinPair(key: LatinKey): LatinPair {
  const p = LATIN[key]
  return { la: p.la, en: p.en }
}

/** The Latin that goes with a copy entry: null in plain or when the entry has none. */
export function latinLine(key: CopyKey, tone: Tone): LatinPair | null {
  if (tone !== 'playful') return null
  const k = (COPY[key] as Entry | undefined)?.latin
  return k ? latinPair(k) : null
}

export type LoadingContext = 'plan' | 'launch' | 'scan' | 'site' | 'run' | 'generic'
const LOADING_KEY: Record<LoadingContext, CopyKey> = {
  plan: 'load.plan',
  launch: 'load.launch',
  scan: 'load.scan',
  site: 'load.site',
  run: 'load.run',
  generic: 'load.generic'
}
/** VOICE.md §3.9: Latin only on the two long, once-per-company waits; everyday loading stays plain. */
export const LOADING_LATIN: Readonly<Record<LoadingContext, readonly LatinKey[]>> = {
  plan: ['festina'],
  launch: ['abovo'],
  scan: [],
  site: [],
  run: [],
  generic: []
}

/**
 * The plain line always says what's happening; playful adds one Latin phrase from the context's pool, `seed % n`.
 * The caller shows the Latin only once the wait passes about 2 s.
 */
export function loadingLine(context: LoadingContext, seed: number, tone: Tone, vars?: Vars): { text: string; latin?: LatinPair } {
  const text = t(LOADING_KEY[context] ?? 'load.generic', vars, 'plain')
  const pool = LOADING_LATIN[context] ?? []
  if (tone !== 'playful' || !pool.length) return { text }
  const i = Math.abs(Math.trunc(Number.isFinite(seed) ? seed : 0)) % pool.length
  return { text, latin: latinPair(pool[i]) }
}

/** VOICE.md §7: the milestone toast. Plain: "Milestone: first post approved." Playful: "Veni, vidi, vici. First post approved." */
export function milestoneToast(key: MilestoneKey, tone: Tone): { text: string; latin?: LatinPair } {
  const m = MILESTONE_COPY[key]
  const meaning = m.meaning.charAt(0).toUpperCase() + m.meaning.slice(1)
  if (tone !== 'playful') return { text: `Milestone: ${m.meaning}.` }
  return m.latin ? { text: `${meaning}.`, latin: latinPair(m.latin) } : { text: `${m.playful}. ${meaning}.` }
}

/** The milestone's display name in a tone, plus its Latin pair in playful. */
export function milestoneName(key: MilestoneKey, tone: Tone): { text: string; latin?: LatinPair } {
  const m = MILESTONE_COPY[key]
  if (tone !== 'playful') return { text: m.plain }
  return m.latin ? { text: m.playful, latin: latinPair(m.latin) } : { text: m.playful }
}
