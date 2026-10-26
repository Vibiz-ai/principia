/**
 * ⌘K ranking (design §2, pm-review A4/D13). The fuzzy score, plus two rules so muscle memory never fires the wrong
 * thing on Enter:
 * - a navigation row whose label or one of its old names IS the query ("schedules", "canvas", "passport") ranks first;
 * - an action that touches every company ranks below every other match, so it is never the Enter default by accident
 *   (it still lists, and it asks before it runs);
 * - hidden keywords only match as a substring, so long synonym lists add no noise;
 * - a query of several words matches a row that has every word, in any order ("openai key", "gh login").
 * Pure: no store, no DOM.
 */
import { fuzzyScore } from '@shared/fuzzy'

export interface Rankable {
  label: string
  group: string
  /** extra search text, never shown */
  keywords?: string
  /** whole phrases that make this row the top hit when typed exactly (a door's old names) */
  exact?: readonly string[]
  /** touches every company (Pause All Schedules): never the top hit while anything else matches */
  global?: boolean
}

export const EXACT_BOOST = 600
export const GLOBAL_PENALTY = 2000

/** null = no match. */
export function paletteScore(query: string, it: Rankable): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  // keywords match as words (a substring), never as a scattered subsequence: "pause" must not find HubSpot through
  // "crm pipeline marketing deals customers". The label and group keep the loose subsequence match.
  const head = `${it.label} ${it.group}`
  const full = it.keywords ? `${head} ${it.keywords}` : head
  const low = full.toLowerCase()
  let s = low.includes(q) ? fuzzyScore(q, full) : fuzzyScore(q, head)
  // several words ("openai key", "gh login"): every word must be in the row's text, in any order
  if (s < 0) {
    const words = q.split(/\s+/).filter(Boolean)
    if (words.length > 1 && words.every((w) => low.includes(w))) s = Math.min(...words.map((w) => fuzzyScore(w, full)))
  }
  if (s < 0) return null
  const exact = it.label.toLowerCase() === q || !!it.exact?.some((w) => w.toLowerCase() === q)
  return s + (exact ? EXACT_BOOST : 0) - (it.global ? GLOBAL_PENALTY : 0)
}

/** Matches best first (stable for equal scores); an empty query keeps the given order. */
export function rankPalette<T extends Rankable>(items: readonly T[], query: string, limit = 60): T[] {
  if (!query.trim()) return items.slice(0, limit)
  return items
    .map((it, i) => ({ it, i, s: paletteScore(query, it) }))
    .filter((x): x is { it: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it)
}
