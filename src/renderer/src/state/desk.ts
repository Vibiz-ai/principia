/**
 * Five doors step 3, AGENT CHAT: the agent desk's actions and data. A message to an agent (Home's Ask box, the agent's
 * chat, Chats, ⌘K "Ask Marcus: …", New chat) goes straight into that agent's own standing chat (main: chat:sendAgent):
 * a live CLI conversation on the agent's harness, with its persona, role, instructions and Principia's tools. The
 * agent answers there itself and files board tasks when the work needs one; Principia never writes a reply in its name.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CompanyAgent } from '@shared/company'
import type { Id, Session } from '@shared/types'
import { errorMessage, hive } from '../lib/hive'
import { autonomyPhrase, type DeskAgent } from '../lib/desk'
import { displayName, personasOf } from '../lib/personaView'
import { personasOn } from '../lib/voice'
import { companyName, getState, openAgentSeat, toast, upsertSession, useStore, type State } from './store'

/** Who an agent is on the desk: persona name, role label, department name (personas on or off). */
export function deskAgentOf(a: CompanyAgent, s: State = getState()): DeskAgent {
  const on = personasOn(s.settings)
  const who = displayName(a, personasOf(s), on)
  return { id: a.id, name: who.name, role: who.role || a.name, department: s.departments.find((d) => d.id === a.departmentId)?.name ?? null, paused: !!a.pausedAt }
}
/** deskAgentOf as a hook: memoised on the slices it reads (a selector returning a new object would loop). */
export function useDeskWho(a: CompanyAgent): DeskAgent {
  const agents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const on = useStore((s) => personasOn(s.settings))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => deskAgentOf(a, getState()), [a, agents, departments, on])
}
/** Active agents of a company, as the Ask box routes over them. */
export function deskAgents(companyId: Id, s: State = getState()): DeskAgent[] {
  return s.companyAgents.filter((a) => a.companyId === companyId && !a.archivedAt).map((a) => deskAgentOf(a, s))
}
export function useDeskAgents(companyId: Id | null | undefined): DeskAgent[] {
  const agents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const personas = useStore((s) => personasOn(s.settings))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (companyId ? deskAgents(companyId) : []), [companyId, agents, departments, personas])
}
/** The one autonomy phrase of a seat (Team card, agent page, onboarding). */
export function agentAutonomy(a: CompanyAgent, s: State = getState()): string {
  const dep = s.departments.find((d) => d.id === a.departmentId)
  return autonomyPhrase({ auto: a.data.autonomy === 'auto', role: a.name, department: dep?.name })
}

export interface SendResult {
  sessionId: Id
}
let sending = false
/**
 * Sends a message into one agent's chat (started, or resumed with its conversation, when it was not running). Returns
 * null when nothing was sent (empty, gone, or an error, which is the toast). `open`: go to the agent's page afterwards.
 */
export async function sendToAgent(agentId: Id, text: string, opts: { open?: boolean } = {}): Promise<SendResult | null> {
  const request = text.trim()
  if (!request || sending) return null
  const agent = getState().companyAgents.find((a) => a.id === agentId && !a.archivedAt)
  if (!agent) {
    toast('That agent is no longer on the team', 'error')
    return null
  }
  sending = true
  try {
    const s = await hive.chat.sendAgent({ agentId, text: request })
    upsertSession(s)
    if (opts.open) openAgentSeat(agent)
    return { sessionId: s.id }
  } catch (e) {
    toast(errorMessage(e), 'error')
    return null
  } finally {
    sending = false
  }
}

/**
 * The agent's standing chat session, as the store has it: the running one, else the last one (ended: it reads its
 * history, and your next message reopens it resuming the same conversation). Looking never starts a CLI: an agent
 * with no chat yet shows an empty chat, and the first message starts it (sendToAgent). Only an ended Codex chat is
 * reopened on sight, since its history comes back only from a running thread. `error`: why it cannot chat.
 */
export function useAgentChat(agent: Pick<CompanyAgent, 'id' | 'archivedAt' | 'refId' | 'kind'> | undefined): { session: Session | null; error: string | null } {
  const [error, setError] = useState<string | null>(null)
  const id = agent?.id
  const refId = agent?.refId
  const session = useStore((s) => {
    if (!id) return null
    let best: Session | null = null
    for (const x of s.sessions) {
      if (x.companyAgentId !== id || x.profileId !== refId) continue
      if (!best || Number(x.status === 'running') - Number(best.status === 'running') > 0 || (x.status === best.status && x.startedAt > best.startedAt)) best = x
    }
    return best
  })
  const reopen = !!session && session.status === 'exited' && session.adapter === 'codex' && !!agent && !agent.archivedAt
  const sid = session?.id
  useEffect(() => {
    if (!reopen || !id) return
    let live = true
    hive.chat.openAgent({ agentId: id }).then(
      (s) => live && upsertSession(s),
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [reopen, id, sid])
  useEffect(() => setError(null), [id])
  if (agent?.kind === 'workflow') return { session: null, error: 'This agent is a workflow: it runs, it does not chat' }
  return { session, error }
}

/** "Paused companies still allow chats you start yourself" (step 2 carry-over): the line under a paused company. */
export function pausedChatsLine(companyId: Id): string {
  return `${companyName(companyId)} is paused: agents start nothing. Chats you open yourself still work.`
}
