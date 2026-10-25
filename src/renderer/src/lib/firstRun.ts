/**
 * Five doors step 5 (design §6, pm-review step 5): what a new company's Home and an existing user's first Home show
 * once. Pure, so the tests drive it.
 */
import type { CompanyAgent, CompanyPassport, CompanyTask } from '@shared/company'

/** The one-time card that says where the old pages went. */
export const THINGS_MOVED = 'things-moved'
/**
 * Show "Things moved" to someone who used Principia before the five doors: they have a company of their own or a
 * task, and haven't dismissed it. A brand-new user (onboarding still open, or nothing yet) never sees it.
 */
export function showThingsMoved(o: { notices: Record<string, string> | undefined; companies: readonly Pick<CompanyPassport, 'system' | 'archivedAt' | 'createdAt'>[]; taskCount: number; onboardingOpen: boolean; firstWeekPending: boolean }): boolean {
  if (o.notices?.[THINGS_MOVED] || o.onboardingOpen || o.firstWeekPending) return false
  return o.taskCount > 0 || o.companies.some((c) => c.system !== 'personal' && !c.archivedAt)
}
/** Old name → where it lives now (the card's list; the palette knows the old names too). */
export const MOVED: readonly { from: string; to: string }[] = [
  { from: 'Agents', to: 'Home › Needs you, and Chats › Live' },
  { from: 'Departments', to: 'Team' },
  { from: 'Passport', to: 'Knowledge' },
  { from: 'Canvas', to: 'More › Activity' },
  { from: 'Usage', to: 'More › Spend' },
  { from: 'Schedules, Workflows', to: 'More › Automations' },
  { from: 'Artifacts', to: 'More › Files' },
  { from: 'Keys, Cloud', to: 'Settings' }
]

export interface FirstWeekRow { agent: CompanyAgent; task: CompanyTask | null }
/** A task's number on its board (LA-7 → 7), the order it was made in; Infinity when it has none. */
function seqOf(t: Pick<CompanyTask, 'identifier'>): number {
  const n = Number(/-(\d+)$/.exec(t.identifier ?? '')?.[1])
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}
/**
 * "Your team is ready. Start the first week?": each active agent of the company with its first task, the one
 * onboarding promised ("First task: …", the plan's first task for that agent) and the one the dispatcher really starts
 * (its oldest To do task: main orders by seq). Agents with nothing assigned are listed last, with no task.
 */
export function firstWeekRows(companyId: string, agents: readonly CompanyAgent[], tasks: readonly CompanyTask[]): FirstWeekRow[] {
  const mine = agents.filter((a) => a.companyId === companyId && !a.archivedAt)
  const open = tasks.filter((t) => t.companyId === companyId && (t.status === 'todo' || t.status === 'triage' || t.status === 'backlog'))
  const rank = (t: CompanyTask): number => (t.status === 'todo' ? 0 : 1)
  const ordered = [...open].sort((a, b) => rank(a) - rank(b) || seqOf(a) - seqOf(b) || ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1))
  const rows = mine.map((agent) => ({ agent, task: ordered.find((t) => t.agentId === agent.id) ?? null }))
  return [...rows.filter((r) => r.task), ...rows.filter((r) => !r.task)]
}

/**
 * The first company made in onboarding by someone with nothing else: no other company and no task outside it. They
 * never used the old app, so "Things moved" is not for them (Maya: "Canvas? Agents? I've never had those.").
 */
export function brandNewUser(newCompanyId: string, companies: readonly Pick<CompanyPassport, 'id' | 'system' | 'archivedAt'>[], tasks: readonly Pick<CompanyTask, 'companyId'>[]): boolean {
  const others = companies.filter((c) => c.id !== newCompanyId && c.system !== 'personal' && !c.archivedAt)
  return others.length === 0 && tasks.every((t) => t.companyId === newCompanyId)
}
