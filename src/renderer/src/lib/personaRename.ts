/**
 * VOICE.md §4.1, §4.2: renaming an agent's persona. 1 to 24 characters after trimming, and no other non-archived
 * agent of the same company shown with that name (case-insensitive; legacy agents count with their resolved name,
 * the same rule as usedPersonaNames in main). Errors are plain in both tones (§1: no jokes on errors).
 */
import { PERSONA_LIMITS, resolvePersonas, type AgentPersona, type PersonaAgentLike, type PersonaDepartmentLike } from '@shared/personas'
import type { CompanyAgent } from '@shared/company'

type AgentRow = Pick<CompanyAgent, 'id' | 'companyId' | 'archivedAt'>

/** null when `raw` is a valid new name for `agent`, else the inline error to show. */
export function personaNameError(raw: string, agent: AgentRow, agents: readonly AgentRow[], personas: ReadonlyMap<string, Pick<AgentPersona, 'name'>>): string | null {
  const name = raw.trim()
  if (!name) return 'Enter a name.'
  if (name.length > PERSONA_LIMITS.name) return `Keep it to ${PERSONA_LIMITS.name} characters or fewer.`
  const lower = name.toLowerCase()
  const clash = agents.find((a) => a.id !== agent.id && a.companyId === agent.companyId && !a.archivedAt && personas.get(a.id)?.name.trim().toLowerCase() === lower)
  return clash ? `Another agent in this company is already called ${personas.get(clash.id)!.name}. Pick another name.` : null
}

/** The persona to store after a rename or a bio edit (the look and the rest are kept as they were shown). */
export function editedPersona(current: AgentPersona, patch: Partial<Pick<AgentPersona, 'name' | 'bio'>>): AgentPersona {
  return {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.bio !== undefined ? { bio: patch.bio.trim().slice(0, PERSONA_LIMITS.bio) } : {})
  }
}

const sameFace = (a: AgentPersona | undefined, b: AgentPersona | undefined): boolean => !!a && !!b && a.name === b.name && JSON.stringify(a.look) === JSON.stringify(b.look)

/**
 * Storing `next` on `agentId` can free the name it was resolved with, so another legacy agent of the company (no stored
 * persona) would re-resolve to a different name and face. These are the other active agents whose displayed persona
 * would change; save each with the persona it is shown with now, before `next`, so nobody else is renamed (§4.1: a
 * face never changes behind the user's back).
 */
export function personasToFreeze<T extends PersonaAgentLike>(agentId: string, next: AgentPersona, agents: readonly T[], departments: readonly PersonaDepartmentLike[]): { agent: T; persona: AgentPersona }[] {
  const me = agents.find((a) => a.id === agentId)
  if (!me) return []
  const company = agents.filter((a) => a.companyId === me.companyId)
  const now = resolvePersonas(company, departments)
  const after = resolvePersonas(company.map((a) => (a.id === agentId ? { ...a, data: { ...(a.data && typeof a.data === 'object' ? a.data : {}), persona: next } } : a)), departments)
  const out: { agent: T; persona: AgentPersona }[] = []
  for (const a of company) {
    if (a.id === agentId || a.archivedAt) continue
    const shown = now.get(a.id)
    if (shown && !sameFace(shown, after.get(a.id))) out.push({ agent: a, persona: shown })
  }
  return out
}
