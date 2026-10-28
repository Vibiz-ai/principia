/**
 * Team's nested list in the sidebar: under Team, one row per department (its icon, name and open tasks), and under a
 * department its installed dashboards ("Engineering · GitHub"), or one muted "Add a dashboard" row. Every row opens the
 * department page: at the top, at its Dashboards card, or scrolled to that dashboard. With departments off the list is
 * one row, "Turn on departments", which does what the Team page's button does.
 *
 * The open/closed state is remembered per company (lib/teamNav) under the sidebar's own per-company key. Rows behave
 * like the sidebar's other rows: Tab reaches them, Enter or Space opens; → and ← expand and collapse a department.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Department } from '@shared/company'
import type { InstalledDashboard } from '@shared/dashboards'
import type { Id } from '@shared/types'
import { Icon } from '../components/Icon'
import { hive, useHiveEvent } from '../lib/hive'
import { useLaneContext } from '../lib/company'
import { departmentsOf } from '../lib/departments'
import { dashboardsByDepartment, openTaskCounts, setDepartmentOpen, TEAM_NAV_KEY, teamNavOf, withTeamNav, type DashboardRow, type TeamNavState, type TeamNavStore } from '../lib/teamNav'
import { addDepartmentMenu, loadJson, openDepartment, saveJson, updateSettings, useStore, type ViewState } from '../state/store'
import { DepartmentIcon } from './DepartmentGroup'

/** Team's disclosure state for one company key, read and written through localStorage (both wrapped in try/catch). */
export function useTeamNavState(key: string): [TeamNavState, (fn: (s: TeamNavState) => TeamNavState) => void] {
  const [all, setAll] = useState<TeamNavStore>(() => loadJson<TeamNavStore>(TEAM_NAV_KEY, {}))
  const update = useCallback(
    (fn: (s: TeamNavState) => TeamNavState) =>
      setAll((cur) => {
        const next = withTeamNav(cur, key, fn(teamNavOf(cur, key)))
        saveJson(TEAM_NAV_KEY, next)
        return next
      }),
    [key]
  )
  return [teamNavOf(all, key), update]
}

/** The company's installed dashboards by department; fetched only while `companyId` is set (Team open). */
function useCompanyDashboards(companyId: Id | null): Record<Id, DashboardRow[]> | null {
  const [items, setItems] = useState<InstalledDashboard[] | null>(null)
  const req = useRef(0)
  const load = useCallback(() => {
    const n = ++req.current
    if (!companyId) return setItems(null)
    hive.dashboards.list({ companyId }).then(
      (l) => n === req.current && setItems(l),
      () => n === req.current && setItems([])
    )
  }, [companyId])
  useEffect(load, [load])
  useHiveEvent('data:changed', ({ domain }) => {
    if (domain === 'dashboards' || domain === 'departments') load()
  })
  return useMemo(() => (items ? dashboardsByDepartment(items) : null), [items])
}

/** The nested list's live data for the focused company (null: departments off). */
export function TeamNav({ companyId, state, onChange }: { companyId: Id | null; state: TeamNavState; onChange: (fn: (s: TeamNavState) => TeamNavState) => void }): React.JSX.Element {
  const view = useStore((s) => s.view)
  const all = useStore((s) => s.departments)
  const tasks = useStore((s) => s.tasks)
  const ctx = useLaneContext()
  const departments = useMemo(() => (companyId ? departmentsOf(all, companyId) : []), [all, companyId])
  const counts = useMemo(() => (companyId ? openTaskCounts(tasks, ctx) : {}), [companyId, tasks, ctx])
  const dashboards = useCompanyDashboards(companyId && departments.length ? companyId : null)
  return <TeamNavList companyId={companyId} departments={departments} counts={counts} dashboards={dashboards} open={state.departments} view={view} onToggle={(id, open) => onChange((s) => setDepartmentOpen(s, id, open))} />
}

/** Expand with →, collapse with ←, open with Enter or Space: the keys every disclosure row of the sidebar takes. */
export function disclosureKeys(e: React.KeyboardEvent, o: { open: () => void; expanded?: boolean; setExpanded?: (v: boolean) => void }): void {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    o.open()
  } else if (o.setExpanded && e.key === 'ArrowRight' && !o.expanded) {
    e.preventDefault()
    o.setExpanded(true)
  } else if (o.setExpanded && e.key === 'ArrowLeft' && o.expanded) {
    e.preventDefault()
    o.setExpanded(false)
  }
}

/** Presentational: the rows themselves (rendered statically in tests). `companyId` null means departments are off. */
export function TeamNavList({
  companyId,
  departments,
  counts,
  dashboards,
  open,
  view,
  onToggle
}: {
  companyId: Id | null
  departments: Department[]
  counts: Record<Id, number>
  /** null while loading: departments show no dashboard rows yet */
  dashboards: Record<Id, DashboardRow[]> | null
  open: readonly Id[]
  view: ViewState
  onToggle: (id: Id, open: boolean) => void
}): React.JSX.Element {
  const row = (o: { key: string; className?: string; selected?: boolean; title?: string; onOpen: () => void; expanded?: boolean; setExpanded?: (v: boolean) => void; children: React.ReactNode }): React.JSX.Element => (
    <div
      key={o.key}
      className={`side-row side-row--session team-nav__row ${o.className ?? ''} ${o.selected ? 'is-selected' : ''}`}
      role="link"
      tabIndex={0}
      aria-current={o.selected ? 'page' : undefined}
      aria-expanded={o.setExpanded ? !!o.expanded : undefined}
      title={o.title}
      onClick={o.onOpen}
      onKeyDown={(e) => disclosureKeys(e, { open: o.onOpen, expanded: o.expanded, setExpanded: o.setExpanded })}
    >
      {o.children}
    </div>
  )
  if (!companyId)
    return (
      <div className="team-nav" role="group" aria-label="Departments">
        {row({
          key: 'turn-on',
          className: 'side-row--indent is-dim',
          title: 'Departments group your agents by what they do: Marketing, Support, Development…',
          onOpen: () => void updateSettings({ experimental: { companies: true, departments: true } }),
          children: (
            <>
              <Icon name="agents" size={14} />
              <span className="side-row__label">Turn on departments</span>
            </>
          )
        })}
      </div>
    )
  return (
    <div className="team-nav" role="group" aria-label="Departments">
      {departments.length === 0 &&
        row({
          key: 'add-dep',
          className: 'side-row--indent is-dim',
          title: 'Each department comes with its agents, a charter and a board',
          onOpen: () => void addDepartmentMenu(companyId),
          children: (
            <>
              <Icon name="plus" size={14} />
              <span className="side-row__label">Add a department</span>
            </>
          )
        })}
      {departments.map((d) => {
        const expanded = open.includes(d.id)
        const n = counts[d.id] ?? 0
        const list = dashboards?.[d.id] ?? []
        const here = view.name === 'department' && view.id === d.id
        return (
          <div key={d.id} className="team-nav__dep">
            {row({
              key: d.id,
              className: 'side-row--indent',
              selected: here && !view.dashboard && view.focus !== 'dashboards',
              title: `${d.name}${n ? ` · ${n} open task${n === 1 ? '' : 's'}` : ''}`,
              onOpen: () => openDepartment(d),
              expanded,
              setExpanded: (v) => onToggle(d.id, v),
              children: (
                <>
                  <button
                    type="button"
                    className="side-row__twisty"
                    tabIndex={-1}
                    aria-label={expanded ? `Hide ${d.name} dashboards` : `Show ${d.name} dashboards`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggle(d.id, !expanded)
                    }}
                  >
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                  </button>
                  <DepartmentIcon department={d} size={14} />
                  <span className="side-row__label">{d.name}</span>
                  {n > 0 && (
                    <span className="side-row__meta team-nav__count" aria-label={`${n} open task${n === 1 ? '' : 's'}`}>
                      {n}
                    </span>
                  )}
                </>
              )
            })}
            {expanded &&
              dashboards &&
              (list.length
                ? list.map((b) =>
                    row({
                      key: b.id,
                      className: 'team-nav__dash',
                      selected: here && view.dashboard === b.id,
                      title: `${b.name} on the ${d.name} page`,
                      onOpen: () => openDepartment(d, 'dashboards', b.id),
                      children: (
                        <>
                          <Icon name="activity" size={14} />
                          <span className="side-row__label">{b.name}</span>
                        </>
                      )
                    })
                  )
                : row({
                    key: `${d.id}:add`,
                    className: 'team-nav__dash is-dim',
                    selected: here && view.focus === 'dashboards' && !view.dashboard,
                    title: `Pick a dashboard for ${d.name} from the marketplace`,
                    onOpen: () => openDepartment(d, 'dashboards'),
                    children: (
                      <>
                        <Icon name="plus" size={14} />
                        <span className="side-row__label">Add a dashboard</span>
                      </>
                    )
                  }))}
          </div>
        )
      })}
    </div>
  )
}
