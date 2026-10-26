/**
 * The agent page (Team › Julia) is the conversation with the agent, the same layout as Chats › Julia
 * (AgentConversation): the chat across the full width and ONE right panel with the bust, name, role, what it is doing
 * and its one action, then Details (how it works, its switch, limits, routines, Runs on), Queue, History,
 * Instructions (persona, About, what it is told, how it runs, Archive: never next to Pause, C9), Library and Computer.
 * DEPARTMENTS.md §9's seat (current task, queue, what waits for you, run history, instructions) lives in that panel.
 */
import type { CompanyAgent } from '@shared/company'
import type { Id } from '@shared/types'
import { Button, EmptyState, Toolbar } from '../components/ui'
import { AgentConversation } from '../components/desk/AgentConversation'
import { activeCompany, companyAgentById, multiCompany, openAgentSeat, useStore } from '../state/store'
import '../styles/departments.css'
import '../styles/desk.css'

export function AgentSeatView({ id, nonce }: { id: Id; focus?: boolean; nonce?: number }): React.JSX.Element {
  const agent = useStore((s) => companyAgentById(id, s))
  if (!agent)
    return (
      <div className="view">
        <Toolbar title="Agent" />
        <EmptyState icon="agents" text="This agent is gone or still loading." />
      </div>
    )
  return (
    <SeatInCompany agent={agent}>
      <AgentConversation key={agent.id} agent={agent} crumb nonce={nonce} />
    </SeatInCompany>
  )
}

/** A seat opens only inside its own company: another company's agent (a stale link, a pasted id) shows where it works. */
function SeatInCompany({ agent, children }: { agent: CompanyAgent; children: React.ReactNode }): React.JSX.Element {
  const active = useStore((s) => (multiCompany(s) ? activeCompany(s) : null))
  const owner = useStore((s) => s.companies.find((c) => c.id === agent.companyId)?.name ?? 'another company')
  if (!active || active === 'all' || active === agent.companyId) return <>{children}</>
  return (
    <div className="view">
      <Toolbar title="Agent" />
      <EmptyState icon="agents" text={`This agent works for ${owner}, not this company.`}>
        <Button size="sm" onClick={() => openAgentSeat(agent)}>Open in {owner}</Button>
      </EmptyState>
    </div>
  )
}
