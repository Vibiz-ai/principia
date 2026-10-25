import { useCallback, useMemo } from 'react'
import type { CompanyPassport, CompanyTask, TaskSource, TaskStatus } from '@shared/company'
import type { Id } from '@shared/types'
import { activeCompany, departmentsOn, refreshCompanies, refreshTasks, useStore } from '../state/store'
import { badgesFromTruth, isMultiCompany, itemsFromTruth, taskCounts, type ActiveCompany, type CompanyBadge, type LiveItem, type TaskCounts } from './companyModel'
import { laneContext, type LaneContext } from './departments'
import { useLiveTruth } from '../state/live'

export const STATUS_LABEL: Record<TaskStatus, string> = { triage: 'Triage', backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done', canceled: 'Canceled' }
export const SOURCE_LABEL: Record<TaskSource, string> = { manual: 'Principia', github: 'GitHub', slack: 'Slack', sentry: 'Sentry', posthog: 'PostHog', agent: 'Agent', schedule: 'Schedule', linear: 'Linear' }
export const PRIORITIES = ['No priority', 'Urgent', 'High', 'Normal', 'Low'] as const

/**
 * Companies and tasks for the Tasks page and company settings. Backed by the global store (COMPANY.md §8.6), which
 * loads both at boot and keeps them fresh on data:changed / run:updated; `reload` refetches on demand.
 */
export function useCompanyData(): { companies: CompanyPassport[]; tasks: CompanyTask[]; loading: boolean; error: string | null; reload: () => void } {
  const companies = useStore((s) => s.companies)
  const tasks = useStore((s) => s.tasks)
  const loaded = useStore((s) => s.companiesLoaded)
  const error = useStore((s) => s.companyError)
  const reload = useCallback(() => {
    void refreshCompanies().catch(() => undefined)
    void refreshTasks()
  }, [])
  return { companies, tasks, loading: !loaded, error, reload }
}

/** The active company for scoped pages: 'all' or an id, the company row, and the companyId to pass to list calls. */
export function useActiveCompany(): { active: ActiveCompany; company: CompanyPassport | null; scopeId: Id | undefined; multi: boolean } {
  const active = useStore((s) => activeCompany(s))
  const companies = useStore((s) => s.companies)
  const multi = isMultiCompany(companies)
  const company = active === 'all' ? null : (companies.find((c) => c.id === active) ?? null)
  return { active, company, scopeId: active === 'all' ? undefined : active, multi }
}

/**
 * Live per-company badges (rail, header, portfolio): a slice of the one live source (state/live.ts truthOf), so the
 * rail tile, the sidebar Home badge and the status bar always show the same numbers. Needs you includes board tasks.
 */
export function useCompanyBadges(): { byCompany: Record<Id, CompanyBadge>; total: CompanyBadge } {
  const companies = useStore((s) => s.companies)
  const overview = useStore((s) => s.companyOverview)
  const truth = useLiveTruth()
  return useMemo(() => badgesFromTruth(truth, companies, overview), [truth, companies, overview])
}

/** Needs-you rows (and with `working`, live working roots) across companies, or one company's. */
export function useLiveItems(opts: { working?: boolean; companyId?: Id } = {}): LiveItem[] {
  const truth = useLiveTruth()
  const { working, companyId } = opts
  return useMemo(() => itemsFromTruth(truth, { working, companyId }), [truth, working, companyId])
}

/** Five doors A4: the companies paused as a whole (their seats wait; their tasks keep their lanes). */
export function usePausedCompanies(): ReadonlySet<Id> {
  const companies = useStore((s) => s.companies)
  return useMemo(() => new Set(companies.filter((c) => c.pausedAt).map((c) => c.id)), [companies])
}
/** laneOf's renderer inputs with the paused rule; every Board, Home and sidebar count uses this one. */
export function useLaneContext(): LaneContext {
  const asks = useStore((s) => s.asks)
  const agents = useStore((s) => s.companyAgents)
  const paused = usePausedCompanies()
  return useMemo(() => laneContext(asks, agents, paused), [asks, agents, paused])
}

/**
 * DEPARTMENTS.md §9: per-company board counts ("3 working · 2 need you · 5 done today") through laneOf. Empty while
 * departments are off, so company cards keep today's lines.
 */
export function useTaskCounts(): Record<Id, TaskCounts> {
  const on = useStore((s) => departmentsOn(s))
  const tasks = useStore((s) => s.tasks)
  const ctx = useLaneContext()
  return useMemo(() => (on ? taskCounts(tasks, ctx) : {}), [on, tasks, ctx])
}

export * from './companyModel'
