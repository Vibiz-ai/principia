/**
 * Team in the sidebar expands into the company's departments, and each department into its installed dashboards, so
 * neither hides behind the Team page. Pure: the expanded state, the open-task counts and the dashboard rows. The state
 * is a per-viewer convenience kept in localStorage under the sidebar's own per-company key (lib/nav prefsKey).
 */
import type { Id } from '@shared/types'
import type { CompanyTask } from '@shared/company'
import { dashboardDef, type InstalledDashboard } from '@shared/dashboards'
import { taskDepartment, type LaneContext } from './departments'

export const TEAM_NAV_KEY = 'principia.teamNav'

/** One company's disclosure state: Team open or closed, and which department rows show their dashboards. */
export interface TeamNavState {
  open: boolean
  departments: Id[]
}
export type TeamNavStore = Record<string, TeamNavState>

const CLOSED: TeamNavState = { open: false, departments: [] }

/** The state stored for `key`, tolerant of anything malformed in storage. */
export function teamNavOf(all: unknown, key: string): TeamNavState {
  const v = all && typeof all === 'object' ? (all as Record<string, unknown>)[key] : undefined
  if (!v || typeof v !== 'object') return CLOSED
  const s = v as Partial<TeamNavState>
  return { open: s.open === true, departments: Array.isArray(s.departments) ? s.departments.filter((d): d is Id => typeof d === 'string') : [] }
}

/** `all` with `key` replaced; a closed state with nothing open is dropped, so storage only holds what differs. */
export function withTeamNav(all: TeamNavStore, key: string, next: TeamNavState): TeamNavStore {
  const out = { ...all }
  if (!next.open && !next.departments.length) delete out[key]
  else out[key] = next
  return out
}

export function setTeamOpen(s: TeamNavState, open: boolean): TeamNavState {
  return { ...s, open }
}

export function setDepartmentOpen(s: TeamNavState, id: Id, open: boolean): TeamNavState {
  const rest = s.departments.filter((d) => d !== id)
  return { ...s, departments: open ? [...rest, id] : rest }
}

/** Open tasks per department: not done or canceled, counted where the department page counts them (taskDepartment). */
export function openTaskCounts(tasks: readonly CompanyTask[], ctx: LaneContext): Record<Id, number> {
  const out: Record<Id, number> = {}
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'canceled') continue
    const dep = taskDepartment(t, ctx)
    if (dep) out[dep] = (out[dep] ?? 0) + 1
  }
  return out
}

export interface DashboardRow {
  id: string
  /** the catalog name, "Engineering · GitHub" */
  name: string
}

/** Installed dashboards grouped by department id, in their saved order; unknown kinds and company-wide ones are left out. */
export function dashboardsByDepartment(items: readonly InstalledDashboard[]): Record<Id, DashboardRow[]> {
  const out: Record<Id, DashboardRow[]> = {}
  for (const d of items) {
    const def = dashboardDef(d.kind)
    if (!def || !d.departmentId) continue
    ;(out[d.departmentId] ??= []).push({ id: d.id, name: def.name })
  }
  return out
}
