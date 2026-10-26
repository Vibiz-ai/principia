/**
 * Team (five doors ⌘2, design §4.2): "who works for me and what are they doing?". One section per department (its
 * name in Cinzel and its charter line), each agent a card: bust, NAME, role, a status sentence in plain words (the
 * same one the agent page shows), the agent's ONE autonomy phrase (the same string as on its page and in onboarding),
 * and two buttons: Message (opens the agent's desk with the composer focused) and the one next action (Start, Pause
 * this task, Resume, See what's needed). All companies mode groups by company; every card opens in its own company.
 */
import { useMemo } from 'react'
import type { CompanyAgent, CompanyPassport } from '@shared/company'
import { Button, EmptyState, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { useScope } from '../components/CompanyChip'
import { AgentAction, StatusLine, useAgentStatus } from '../components/desk/Desk'
import { CompanyAvatar } from '../shell/CompanyRail'
import { AgentBust } from '../shell/DepartmentGroup'
import { agentsOf, departmentsOf } from '../lib/departments'
import { companyLabel, isPersonal } from '../lib/company'
import { useWorking } from '../state/live'
import { agentAutonomy, useDeskWho } from '../state/desk'
import { addDepartmentMenu, departmentContextMenu, departmentsOn, enterCompany, navigate, openAgentSeat, openDepartment, openNewCompany, setCompanyPaused, updateSettings, useStore } from '../state/store'
import '../styles/departments.css'
import '../styles/desk.css'

export function TeamView(): React.JSX.Element {
  const { scope, companies, company } = useScope()
  const on = useStore((s) => departmentsOn(s))
  const agents = useStore((s) => s.companyAgents)
  const shown = useMemo(() => (scope ? companies.filter((c) => c.id === scope) : companies), [companies, scope])
  const seats = agents.filter((a) => !a.archivedAt && shown.some((c) => c.id === a.companyId))
  const working = useWorking(scope ?? 'all')
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
  const meta = `${seats.length} agent${seats.length === 1 ? '' : 's'} · ${working.agents} working${scope ? '' : ' · all companies'}`
  const short = company?.name.split(/\s+/)[0] ?? ''
  return (
    <div className="view">
      <Toolbar title="Team" sub={<span className="company-toolbar-meta">{meta}</span>}>
        {company && !isPersonal(company) && (
          <>
            {company.pausedAt ? (
              <Button variant="primary" icon="play" onClick={() => void setCompanyPaused(company.id, false)}>
                Resume {short}
              </Button>
            ) : (
              <Button icon="pause" onClick={() => void setCompanyPaused(company.id, true)} title={`Pause ${company.name} only. Other companies keep running.`}>
                Pause {short}
              </Button>
            )}
            <Button icon="plus" onClick={() => void addDepartmentMenu(company.id)} title="Add a department with its agents">
              Hire
            </Button>
          </>
        )}
      </Toolbar>
      <div className="scroll view__body">
        <div className="team5">
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
          {company.pausedAt && <span className="text-tertiary">‖ Paused</span>}
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
        <div className="team5-dep">
          <div className="team5-dep__head">
            <span className="team5-dep__name">Company-wide</span>
          </div>
          <div className="team5-cards">
            {top.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        </div>
      )}
      {deps.map((d) => {
        const seats = agentsOf(agents, company.id, d.id)
        const charter = d.data.charter?.does?.split(/[.\n]/)[0]?.trim()
        return (
          <div key={d.id} className="team5-dep">
            <div className="team5-dep__head">
              <button
                type="button"
                className="team5-dep__name"
                onClick={() => openDepartment(d)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  void departmentContextMenu(d)
                }}
                title={`Open ${d.name}: its agents, its board, dashboards and charter · right-click to pin it`}
              >
                {d.name}
              </button>
              {charter && <span className="team5-dep__charter">{charter}</span>}
              <span className="flex1" />
              <Button size="sm" variant="ghost" onClick={() => openDepartment(d)}>
                Open department
              </Button>
            </div>
            {seats.length ? (
              <div className="team5-cards">
                {seats.map((a) => (
                  <AgentCard key={a.id} agent={a} />
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

/** One agent: face, name, role, the status sentence, the autonomy phrase, Message and the next action. */
export function AgentCard({ agent }: { agent: CompanyAgent }): React.JSX.Element {
  const who = useDeskWho(agent)
  const autonomy = useStore((s) => agentAutonomy(agent, s))
  const color = useStore((s) => s.departments.find((d) => d.id === agent.departmentId)?.color ?? null)
  const status = useAgentStatus(agent)
  return (
    <div
      className={`team5-card ${status.kind === 'paused' ? 'is-paused' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${who.name}, ${who.role}: ${status.text}`}
      onClick={() => openAgentSeat(agent)}
      onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openAgentSeat(agent))}
    >
      <div className="team5-card__top">
        <span className="team5-card__bust">
          <AgentBust agent={agent} color={color} size={48} />
        </span>
        <div>
          <div className="team5-card__name">{who.name}</div>
          <div className="team5-card__role">{who.role}</div>
        </div>
      </div>
      <div className="team5-card__status">
        <StatusLine status={status} />
      </div>
      <span className="team5-chip" title={`Change it on ${who.name}’s page`}>
        {autonomy}
      </span>
      <div className="team5-card__acts" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" icon="chat" onClick={() => openAgentSeat(agent, { focus: true })}>
          Message
        </Button>
        <AgentAction agent={agent} status={status} />
      </div>
    </div>
  )
}
