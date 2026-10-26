/**
 * ⌘K finds work and people (five doors §2, Diego round 2: "The prefix is great, but I can't jump to it"): a company's
 * tasks by ID ("LA-6") or title ("rounding"), and its agents by persona name ("Marcus") or role. Scoped like every
 * other palette row: inside a company only its own rows (never another client's Marcus), every company's in All
 * companies with the company named. Canceled and archived rows are left out. Pure: the palette adds `run`.
 */
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { Id } from '@shared/types'

export interface EntityRow {
  id: string
  group: 'Tasks' | 'Team'
  label: string
  hint: string
  keywords: string
  exact: string[]
  kind: 'task' | 'agent'
  targetId: Id
  companyId: Id
}

export function paletteEntities<A extends Pick<CompanyAgent, 'id' | 'companyId' | 'name' | 'archivedAt' | 'pausedAt'>>(input: {
  tasks: readonly Pick<CompanyTask, 'id' | 'identifier' | 'title' | 'companyId' | 'status'>[]
  agents: readonly A[]
  /** undefined = All companies */
  scope: Id | undefined
  /** the agent's shown name and role (persona on: "Marcus" + "Content Writer"; off: the role, '') */
  nameOf: (a: A) => { name: string; role: string }
  companyName: (id: Id) => string
  multi: boolean
}): EntityRow[] {
  const inScope = (companyId: Id): boolean => !input.scope || companyId === input.scope
  const where = (companyId: Id): string[] => (input.multi && !input.scope ? [input.companyName(companyId)] : [])
  const tasks = input.tasks
    .filter((t) => inScope(t.companyId) && t.status !== 'canceled')
    .map<EntityRow>((t) => ({
      id: `task:${t.id}`,
      group: 'Tasks',
      label: t.title,
      hint: [...where(t.companyId), t.identifier].join(' · '),
      keywords: t.identifier,
      exact: [t.identifier],
      kind: 'task',
      targetId: t.id,
      companyId: t.companyId
    }))
  const agents = input.agents
    .filter((a) => inScope(a.companyId) && !a.archivedAt)
    .map<EntityRow>((a) => {
      const n = input.nameOf(a)
      return {
        id: `agent:${a.id}`,
        group: 'Team',
        label: n.role ? `${n.name} · ${n.role}` : n.name,
        hint: [...where(a.companyId), a.pausedAt ? 'paused' : ''].filter(Boolean).join(' · '),
        keywords: `${n.name} ${a.name} agent`,
        exact: [n.name],
        kind: 'agent',
        targetId: a.id,
        companyId: a.companyId
      }
    })
  return [...agents, ...tasks]
}
