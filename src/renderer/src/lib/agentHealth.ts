/**
 * VOICE.md §5.10: is a company "healthy" (the rail coin's laurel ring)? True only when all of these hold:
 * - the company has at least one active (non-archived) agent;
 * - none of its agents is paused;
 * - none of its tasks is parked (blocked for any reason other than dependencies);
 * - nothing needs you: no live needs-you badge (asks, unseen idle sessions) and no task in the Needs you lane;
 * - no run failed in the last 24 h.
 *
 * Pure, and computed from slices the rail already reads (companyAgents, tasks, asks, the live badges), so it never
 * fetches and never disagrees with the badges next to it.
 */
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { Ask } from '@shared/live'
import type { Id } from '@shared/types'
import type { CompanyBadge } from './companyModel'
import { openAskRuns, taskLane, type LaneContext } from './departments'

export interface HealthState {
  companyAgents: readonly CompanyAgent[]
  tasks: readonly CompanyTask[]
  /** open live asks: a running task waiting on one is in Needs you */
  asks?: Record<Id, Ask> | Iterable<Ask>
  /** live per-company badges (useCompanyBadges().byCompany): needs-you count and the failed-in-24 h flag */
  badges?: Readonly<Record<Id, Pick<CompanyBadge, 'needsYou' | 'failed'> | undefined>>
}

/** A task the human has to unblock: blocked, but not merely waiting on its dependencies. */
export const isParked = (t: Pick<CompanyTask, 'status' | 'blockReason'>): boolean => t.status === 'blocked' && t.blockReason !== 'deps'

const contextOf = (state: HealthState): LaneContext => ({ openRuns: openAskRuns(state.asks ?? []), agentsById: new Map(state.companyAgents.map((a) => [a.id, a])) })

export function companyHealthy(companyId: Id, state: HealthState, ctx: LaneContext = contextOf(state)): boolean {
  const agents = state.companyAgents.filter((a) => a.companyId === companyId && !a.archivedAt)
  if (agents.length === 0) return false
  if (agents.some((a) => !!a.pausedAt)) return false
  const badge = state.badges?.[companyId]
  if (badge && (badge.failed || badge.needsYou > 0)) return false
  const tasks = state.tasks.filter((t) => t.companyId === companyId)
  if (tasks.some(isParked)) return false
  return !tasks.some((t) => taskLane(t, ctx) === 'needs_you')
}

/** Every company's health at once (the rail), sharing one lane context. */
export function companiesHealth(companyIds: readonly Id[], state: HealthState): Record<Id, boolean> {
  const ctx = contextOf(state)
  const out: Record<Id, boolean> = {}
  for (const id of companyIds) out[id] = companyHealthy(id, state, ctx)
  return out
}
