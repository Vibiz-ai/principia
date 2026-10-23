/**
 * VOICE.md §7: milestones, earned from real data only. Pure (no store, no React): the Home strip and the toast watcher
 * pass the store slices in. Seen state lives in localStorage under MILESTONES_KEY as
 * `{ [companyId]: { [milestoneKey]: seenAtISO } }`; once seen, a milestone stays earned in the strip even when its rule
 * stops holding (a calm week followed by a failed run is still a calm week you had).
 */
import type { CompanyAgent, CompanyOverview, CompanyPassport, CompanyTask, Department } from '@shared/company'
import { agentActive } from '@shared/company'
import type { JournalMeta } from '@shared/onboarding'
import { ROLE_POOLS, resolvePersonas } from '@shared/personas'
import type { MilestoneKey } from './voice/copy'

export type { MilestoneKey }

/** Strip order (VOICE.md §7 table). */
export const MILESTONE_KEYS: readonly MilestoneKey[] = ['launched', 'firstTask', 'firstPost', 'firstAnswer', 'firstWeek', 'fullTeam', 'calmWeek', 'hundred']
export const MILESTONES_KEY = 'principia.milestones.v1'

const DAY = 864e5
/** A parked task for one of these reasons is a failed run (the board's run_failed family). */
const FAILED_REASONS = new Set(['run_failed', 'interrupted', 'no_report'])
const CONTENT_PERSONAS = new Set(ROLE_POOLS.content ?? [])

/** The slices the rules read. All optional except what every rule needs, so tests and callers stay small. */
export interface MilestoneState {
  companies: readonly Pick<CompanyPassport, 'id' | 'createdAt'>[]
  tasks: readonly CompanyTask[]
  companyAgents: readonly CompanyAgent[]
  departments: readonly Pick<Department, 'id' | 'key'>[]
  /** onboarding:status; `launched` reads its journal */
  onboardingStatus?: { journal: Pick<JournalMeta, 'status' | 'companyId'> | null } | null
  /** company:overview; `calmWeek` reads failed7d (failed24h from an overview without it) */
  companyOverview?: Readonly<Record<string, (Pick<CompanyOverview, 'failed24h'> & Partial<Pick<CompanyOverview, 'failed7d'>>) | undefined>>
}

const ms = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN
  return Number.isFinite(n) ? n : NaN
}

/** Every milestone whose rule holds now for `companyId`, in strip order. */
export function earned(companyId: string, state: MilestoneState, now: Date = new Date()): MilestoneKey[] {
  const t = now.getTime()
  const company = state.companies.find((c) => c.id === companyId)
  const tasks = state.tasks.filter((x) => x.companyId === companyId)
  const done = tasks.filter((x) => x.status === 'done')
  const agents = state.companyAgents.filter((a) => a.companyId === companyId)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const deptKey = new Map(state.departments.map((d) => [d.id, d.key]))
  const age = company ? t - ms(company.createdAt) : NaN
  const out = new Set<MilestoneKey>()

  // launched: created through onboarding, the launch journal finished for this company
  const j = state.onboardingStatus?.journal
  if (j && j.status === 'done' && j.companyId === companyId) out.add('launched')

  if (done.length >= 1) out.add('firstTask')

  // firstPost: a done task by a Marketing agent or a content-role persona
  let personas: ReturnType<typeof resolvePersonas> | null = null
  const isPoster = (a: CompanyAgent): boolean => {
    if (a.departmentId && deptKey.get(a.departmentId) === 'marketing') return true
    personas ??= resolvePersonas(agents, state.departments)
    const p = personas.get(a.id)
    return !!p && CONTENT_PERSONAS.has(p.key)
  }
  if (done.some((x) => { const a = x.agentId ? byId.get(x.agentId) : undefined; return !!a && isPoster(a) })) out.add('firstPost')

  // firstAnswer: an ask on a task that you answered
  if (tasks.some((x) => !!x.ask && typeof x.ask.answer === 'string' && x.ask.answer.trim() !== '')) out.add('firstAnswer')

  // firstWeek: at least 7 days old and at least 3 tasks done
  if (age >= 7 * DAY && done.length >= 3) out.add('firstWeek')

  // fullTeam: at least one active agent, and every active agent has finished at least one task
  const active = agents.filter(agentActive)
  if (active.length > 0) {
    const finished = new Set(done.map((x) => x.agentId).filter(Boolean))
    if (active.every((a) => finished.has(a.id))) out.add('fullTeam')
  }

  // calmWeek: a full week behind the company, a task done in it, and no failed run in it: the overview's failed runs
  // of the last 7 days, and tasks parked by a failure in the window, must both be clear.
  const weekAgo = t - 7 * DAY
  if (age >= 7 * DAY) {
    const doneInWeek = done.some((x) => ms(x.updatedAt) >= weekAgo)
    const failedTask = tasks.some((x) => x.status === 'blocked' && !!x.blockReason && FAILED_REASONS.has(x.blockReason) && ms(x.updatedAt) >= weekAgo)
    const ov = state.companyOverview?.[companyId]
    const failedRuns = ov?.failed7d ?? ov?.failed24h ?? 0
    if (doneInWeek && !failedTask && failedRuns === 0) out.add('calmWeek')
  }

  if (done.length >= 100) out.add('hundred')

  return MILESTONE_KEYS.filter((k) => out.has(k))
}

export type SeenMap = Record<string, Partial<Record<MilestoneKey, string>>>

const KEYS = new Set<string>(MILESTONE_KEYS)
/** What localStorage held, cleaned: unknown keys and non-string stamps are dropped; anything else is `{}`. */
export function parseSeen(raw: unknown): SeenMap {
  const out: SeenMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [companyId, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const clean: Partial<Record<MilestoneKey, string>> = {}
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) if (KEYS.has(k) && typeof v === 'string') clean[k as MilestoneKey] = v
    out[companyId] = clean
  }
  return out
}

/** The earned milestones not yet seen for this company: one toast each. */
export function newlyEarned(companyId: string, earnedNow: readonly MilestoneKey[], seen: SeenMap): MilestoneKey[] {
  const rec = seen[companyId] ?? {}
  return earnedNow.filter((k) => !rec[k])
}

/** `seen` with `keys` stamped at `at` for the company (existing stamps kept). Returns the same object when nothing changes. */
export function markSeen(seen: SeenMap, companyId: string, keys: readonly MilestoneKey[], at: string): SeenMap {
  const rec = seen[companyId] ?? {}
  const add = keys.filter((k) => !rec[k])
  if (!add.length) return seen
  return { ...seen, [companyId]: { ...rec, ...Object.fromEntries(add.map((k) => [k, at])) } }
}

/** What the strip shows as earned: the rules now, plus everything already seen (a milestone never un-earns). */
export function shownEarned(companyId: string, earnedNow: readonly MilestoneKey[], seen: SeenMap): Set<MilestoneKey> {
  const rec = seen[companyId] ?? {}
  return new Set(MILESTONE_KEYS.filter((k) => earnedNow.includes(k) || !!rec[k]))
}

/** How long a freshly earned milestone keeps its playful (Latin) badge name on the Home strip. */
export const FEATURE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * VOICE.md §1 (one Latin phrase per screen; in lists only the top item gets the playful line; nothing that repeats
 * daily): the one coin on the strip that may show its playful badge name. That is the most recently earned milestone,
 * for a week after it was earned; every other coin, and every coin after that week, reads plain. Ties on the stamp go
 * to the later milestone in strip order. A milestone earned by the rules but not yet stamped counts as earned now.
 */
export function featuredMilestone(companyId: string, got: ReadonlySet<MilestoneKey>, seen: SeenMap, now: Date = new Date()): MilestoneKey | null {
  const rec = seen[companyId] ?? {}
  const t = now.getTime()
  let best: { key: MilestoneKey; at: number } | null = null
  for (const key of MILESTONE_KEYS) {
    if (!got.has(key)) continue
    const stamp = rec[key]
    const parsed = stamp ? Date.parse(stamp) : t
    const at = Number.isFinite(parsed) ? parsed : t
    if (t - at > FEATURE_MS) continue
    if (!best || at >= best.at) best = { key, at }
  }
  return best?.key ?? null
}
