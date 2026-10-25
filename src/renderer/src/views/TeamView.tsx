/**
 * Team (five doors, ⌘2): "who works for me and what are they doing?". Step 1 mounts the existing department roster
 * under the new name: one section per department with its agent seat cards (the Department page's), company-level
 * agents first. All companies mode groups by company, and each row opens in its own company. The agent cards with
 * status sentences, Message and Start/Pause land in step 3.
 */
import { useMemo } from 'react'
import type { CompanyPassport } from '@shared/company'
import { Button, EmptyState, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { useScope } from '../components/CompanyChip'
import { CompanyAvatar } from '../shell/CompanyRail'
import { DepartmentIcon } from '../shell/DepartmentGroup'
import { agentsOf, departmentsOf } from '../lib/departments'
import { companyLabel, isPersonal, teamMeta } from '../lib/company'
import { addDepartmentMenu, departmentContextMenu, departmentsOn, enterCompany, navigate, openDepartment, openNewCompany, updateSettings, useStore } from '../state/store'
import { SeatCard } from './DepartmentView'
import '../styles/departments.css'

export function TeamView(): React.JSX.Element {
  const { scope, companies, company } = useScope()
  const on = useStore((s) => departmentsOn(s))
  const agents = useStore((s) => s.companyAgents)
  const shown = useMemo(() => (scope ? companies.filter((c) => c.id === scope) : companies), [companies, scope])
  const seats = agents.filter((a) => !a.archivedAt && shown.some((c) => c.id === a.companyId))
  const meta = teamMeta(seats, shown, !scope)
  if (!on)
    return (
      <div className="view">
        <Toolbar title="Team" />
        <EmptyState icon="agents" text="Your team lives in departments: a Marketing writer, a Support responder, a Builder for your code. Turn on companies and departments to hire them.">
          <Button variant="primary" onClick={() => void updateSettings({ experimental: { companies: true, departments: true } })}>
            Turn on departments
          </Button>
          <Button onClick={() => void navigate({ name: 'chats' })}>See live chats</Button>
        </EmptyState>
      </div>
    )
  return (
    <div className="view">
      <Toolbar title="Team" sub={<span className="company-toolbar-meta">{meta}</span>} />
      <div className="scroll view__body">
        <div className="team-page">
          {shown.map((c) => (
            <CompanyTeam key={c.id} company={c} grouped={!scope} />
          ))}
          {!company && shown.length === 0 && <EmptyState icon="agents" text="No companies yet." />}
        </div>
      </div>
    </div>
  )
}

function CompanyTeam({ company, grouped }: { company: CompanyPassport; grouped: boolean }): React.JSX.Element | null {
  const all = useStore((s) => s.departments)
  const agents = useStore((s) => s.companyAgents)
  const deps = departmentsOf(all, company.id)
  const top = agentsOf(agents, company.id, null)
  if (grouped && !deps.length && !top.length) return null
  return (
    <section className="team-co" aria-label={company.name}>
      {grouped && (
        <header className="team-co__head">
          <CompanyAvatar company={company} size={18} />
          <span className="team-co__name">{companyLabel(company, true)}</span>
          <span className="flex1" />
          <button type="button" className="link-btn" onClick={() => void enterCompany(company.id, { view: { name: 'team' } })}>
            Open in {company.name} <Icon name="chevronRight" size={11} />
          </button>
        </header>
      )}
      {!deps.length && !top.length &&
        (isPersonal(company) ? (
          <EmptyState icon="agents" text="Personal is just you: your own chats and repositories. Agents work inside a company, so add one to hire a team." compact>
            <Button onClick={openNewCompany}>New Company…</Button>
          </EmptyState>
        ) : (
          <EmptyState icon="agents" text={`${company.name} has no departments yet. Each one comes with its agents, a charter and a board.`} compact>
            <Button onClick={() => void addDepartmentMenu(company.id)}>Add a Department…</Button>
          </EmptyState>
        ))}
      {top.length > 0 && (
        <div className="team-dep">
          <div className="team-dep__head">
            <span className="team-dep__name">Company-wide</span>
            <span className="team-dep__count">{top.length}</span>
          </div>
          <div className="dep-seats">
            {top.map((a) => (
              <SeatCard key={a.id} agentId={a.id} color={company.color} />
            ))}
          </div>
        </div>
      )}
      {deps.map((d) => {
        const seats = agentsOf(agents, company.id, d.id)
        return (
          <div key={d.id} className="team-dep">
            <button
              type="button"
              className="team-dep__head team-dep__head--link"
              onClick={() => openDepartment(d)}
              // design §3: right-click any department to pin it (and the rest of its menu)
              onContextMenu={(e) => {
                e.preventDefault()
                void departmentContextMenu(d)
              }}
              title={`Open ${d.name}: charter, dashboards, board · right-click to pin it to the sidebar`}
            >
              <DepartmentIcon department={d} size={14} />
              <span className="team-dep__name">{d.name}</span>
              <span className="team-dep__count">{seats.length}</span>
              <Icon name="chevronRight" size={11} />
            </button>
            {seats.length ? (
              <div className="dep-seats">
                {seats.map((a) => (
                  <SeatCard key={a.id} agentId={a.id} color={d.color} />
                ))}
              </div>
            ) : (
              <div className="team-dep__empty">No agents yet. Open {d.name} to add one.</div>
            )}
          </div>
        )
      })}
    </section>
  )
}
