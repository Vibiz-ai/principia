/**
 * "From a prompt" (docs/ONBOARDING.md §2 S0b): the founder pastes a brief and the flow reads the About answers out of
 * it. Shared and pure (zod only):
 *
 * - `BriefExtraction`: the lenient shape the extraction call may return (main parses the model's JSON with it);
 * - `cleanBriefAnswers`: that shape (or anything else) → answers within the AnswersSchema limits, empty fields dropped;
 * - `briefFallback`: what can be read without a model (a short first line as the name, the first link as the site, the
 *   next sentence as the one-liner), so a failed or missing CLI never loses the brief;
 * - `briefForPlan`: the capped brief the plan prompt sees.
 */
import { z } from 'zod'
import { GOALS, PLAN_BRIEF_MAX, VIBES, type GoalKey, type OnboardingAnswers, type VibeKey } from './onboarding'

/** The AnswersSchema caps for the free-text fields. */
export const BRIEF_ANSWER_LIMITS = {
  name: 80,
  oneLiner: 200,
  products: 500,
  audience: 500,
  siteUrl: 2048,
  instagram: 100,
  voiceText: 600,
  avoid: 300,
  goalOther: 120
} as const
type TextField = keyof typeof BRIEF_ANSWER_LIMITS
const TEXT_FIELDS = Object.keys(BRIEF_ANSWER_LIMITS) as TextField[]

/** What the model is asked for. Lenient on purpose: anything off is dropped by cleanBriefAnswers, never fatal. */
export const BriefExtraction = z
  .object({
    name: z.string().optional(),
    oneLiner: z.string().optional(),
    products: z.string().optional(),
    audience: z.string().optional(),
    siteUrl: z.string().optional(),
    instagram: z.string().optional(),
    voiceVibe: z.string().nullable().optional(),
    voiceText: z.string().optional(),
    avoid: z.string().optional(),
    goals: z.array(z.string()).optional(),
    goalOther: z.string().optional()
  })
  .passthrough()
export type BriefExtraction = z.infer<typeof BriefExtraction>

/** One line, whitespace collapsed, clipped on a word where it can be. */
function clipLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  const sp = head.lastIndexOf(' ')
  return `${(sp >= max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:–—-]+$/, '')}…`
}

/** "acme.com", "https://acme.com/x" → kept; anything with spaces, credentials or no dot → ''. */
export function plausibleSite(raw: string): string {
  const t = raw.trim()
  if (!t || /\s/.test(t) || t.length > BRIEF_ANSWER_LIMITS.siteUrl) return ''
  const host = /^(?:https?:\/\/)?([^/?#@\s]+)(?:[/?#]|$)/i.exec(t)?.[1]?.toLowerCase() ?? ''
  if (/@/.test(t.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? '')) return ''
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? t : ''
}

/** Model output (or any object) → clean partial answers: known fields only, capped, empty ones dropped. */
export function cleanBriefAnswers(raw: unknown): Partial<OnboardingAnswers> {
  const parsed = BriefExtraction.safeParse(raw)
  if (!parsed.success) return {}
  const v = parsed.data
  const out: Partial<OnboardingAnswers> = {}
  for (const k of TEXT_FIELDS) {
    const val = v[k]
    if (typeof val !== 'string') continue
    const clipped = k === 'siteUrl' ? plausibleSite(val) : clipLine(val, BRIEF_ANSWER_LIMITS[k])
    if (clipped) out[k] = clipped
  }
  if (out.instagram) out.instagram = out.instagram.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30)
  if (!out.instagram) delete out.instagram
  if (typeof v.voiceVibe === 'string' && (VIBES as readonly string[]).includes(v.voiceVibe)) out.voiceVibe = v.voiceVibe as VibeKey
  if (Array.isArray(v.goals)) {
    const goals: GoalKey[] = []
    for (const g of v.goals) if ((GOALS as readonly string[]).includes(g) && !goals.includes(g as GoalKey)) goals.push(g as GoalKey)
    if (goals.length) out.goals = goals
  }
  if (out.goals?.includes('other') && !out.goalOther) out.goals = out.goals.filter((g) => g !== 'other')
  return out
}

const URL_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|io|co|ai|app|dev|net|org|shop|store|xyz|me|so|tech|studio|uk|es|pt|de|fr|it|nl|ar|br|mx)(?:\/[^\s)]*)?/i
const NAME_LABEL_RE = /^\s*(?:company|business|name|brand|startup|product)\s*(?:name)?\s*[:–—-]\s*(.+)$/im

/**
 * No model: the answers a brief gives away on its own. A labelled "Name: …" line wins; else a short first line (≤ 60
 * chars, ≤ 8 words, no sentence end) is the name. The first sentence after it is the one-liner, the first link the site.
 */
export function briefFallback(brief: string): Partial<OnboardingAnswers> {
  const text = brief.replace(/\r\n?/g, '\n').trim()
  if (!text) return {}
  const out: Partial<OnboardingAnswers> = {}
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const clean = (l: string): string => l.replace(/^#+\s*|^[-*•]\s*/, '').replace(/[*_`]/g, '').trim()
  const labelled = NAME_LABEL_RE.exec(text)?.[1]
  const first = clean(lines[0] ?? '')
  let rest = lines.slice(1)
  if (labelled && clean(labelled).length <= 60) out.name = clean(labelled)
  else if (first && first.length <= 60 && first.split(/\s+/).length <= 8 && !/[.!?]$/.test(first)) out.name = first.replace(/[:–—-]+$/, '').trim()
  else rest = lines
  const body = rest.map(clean).filter((l) => !NAME_LABEL_RE.test(l)).join(' ')
  const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(body)?.[1] ?? body
  const oneLiner = clipLine(sentence, BRIEF_ANSWER_LIMITS.oneLiner)
  if (oneLiner) out.oneLiner = oneLiner
  const link = URL_RE.exec(text)?.[0]?.replace(/[.,;:]+$/, '')
  const site = link ? plausibleSite(link) : ''
  if (site) out.siteUrl = site
  return out
}

/** The brief as the plan prompt sees it: trimmed, then capped at PLAN_BRIEF_MAX. Empty → undefined. */
export function briefForPlan(brief: string | undefined | null): string | undefined {
  const t = (brief ?? '').trim()
  if (!t) return undefined
  return t.length > PLAN_BRIEF_MAX ? `${t.slice(0, PLAN_BRIEF_MAX - 1)}…` : t
}
