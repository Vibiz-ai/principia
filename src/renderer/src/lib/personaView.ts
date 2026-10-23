/**
 * VOICE.md §0, §4: who an agent is on screen. Stored personas (`data.persona`) win; legacy agents get a display-only
 * persona from pickPersona, in createdAt order per company, never reusing a name already taken. Pure: no store import,
 * so callers pass the slices (`useStore((s) => personaFor(id, s))` stays referentially stable thanks to the cache).
 */
import type { CompanyAgent } from '@shared/company'
import {
  resolvePersonas,
  storedPersona,
  type AgentPersona,
  type PersonaAgentLike as AgentLike,
  type PersonaDepartmentLike as DepartmentLike
} from '@shared/personas'

// the resolving rules live in @shared/personas so main reserves the same names the renderer shows
export { resolvePersonas, storedPersona }

export interface DisplayName {
  /** persona name with personas on, else the role label */
  name: string
  /** the role label to show beside the name; '' when personas are off (the name already is the role) */
  role: string
  persona: AgentPersona | null
}

/** VOICE.md §4.4: "{persona} · {role}" with personas on; just the role label with them off. */
export function displayName(agent: Pick<CompanyAgent, 'id' | 'name'>, personas: ReadonlyMap<string, AgentPersona>, personasOn: boolean): DisplayName {
  const p = personasOn ? personas.get(agent.id) ?? null : null
  return p ? { name: p.name, role: agent.name, persona: p } : { name: agent.name, role: '', persona: null }
}

export interface PersonaSource {
  companyAgents: readonly AgentLike[]
  departments: readonly DepartmentLike[]
}
let cache: { agents: readonly AgentLike[]; departments: readonly DepartmentLike[]; map: Map<string, AgentPersona> } | null = null

/** Resolved personas for a store snapshot, memoized on the slices' identity. */
export function personasOf(src: PersonaSource): Map<string, AgentPersona> {
  if (!cache || cache.agents !== src.companyAgents || cache.departments !== src.departments) {
    cache = { agents: src.companyAgents, departments: src.departments, map: resolvePersonas(src.companyAgents, src.departments) }
  }
  return cache.map
}

/** The persona of one agent (stored or resolved), or null when the agent isn't in the snapshot. */
export function personaFor(agentId: string, src: PersonaSource): AgentPersona | null {
  return personasOf(src).get(agentId) ?? null
}
