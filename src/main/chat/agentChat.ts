/**
 * AGENT CHAT: the one standing chat of each company agent. Messaging an agent (its page, Chats, Home's Ask box, ⌘K,
 * the phone) writes straight into a live CLI chat bound to that agent, never into a board task:
 *
 * - run on the agent's own profile (claude or codex harness, model, keys), in its folder (its default repo for a code
 *   agent, else the company workspace), with the agent's brief (shared/agentChat.ts) plus Principia's team context
 *   (teammates, recent work: the orchestrator's block without the run report contract) as its system prompt, and
 *   Principia's MCP tools (tasks, memory, Forum, connections) like any company chat;
 * - one per agent: the newest session stamped with the agent (Session.companyAgentId). A running one is reused; an
 *   ended one (an app restart, Kill, sleep past an exit) is restarted resuming the same CLI conversation, so the chat
 *   never comes back "ended";
 * - the agent decides itself whether something becomes a board task (its tools). Chat turns are not runs: the
 *   orchestrator's after-run work (update posts, extracted follow-ups) never fires per chat message.
 * No Electron imports.
 */
import type { CompanyAgent } from '../../shared/company'
import type { Id, Session } from '../../shared/types'
import { HiveError } from '../../shared/errors'
import { agentChatBrief } from '../../shared/agentChat'
import { resolvePersonas } from '../../shared/personas'
import type { AgentChatSpawn, SessionManager } from '../sessions'

export interface AgentChatDeps {
  getAgent(id: Id): CompanyAgent | null
  /** the company's agents and departments (persona resolution, department name) */
  agentsOf(companyId: Id): CompanyAgent[]
  departmentsOf(companyId: Id): { id: Id; key: string; name: string }[]
  companyName(companyId: Id): string
  profileAdapter(profileId: Id): string | null
  /** a repository's folder when it still exists */
  repoPath(repoId: Id): string | null
  workspaceDir(companyId: Id): string | null
  /** the company has code repositories */
  isCode(companyId: Id): boolean
  personasOn(): boolean
  /** the orchestrator's team block for a chat (no inbox consumed, no report contract); null when it is off */
  teamContext?(companyId: Id, agentId: Id): string | null
  /** sessions stamped with this agent, newest first */
  sessionsOf(agentId: Id, companyId: Id): Session[]
  sessions(): SessionManager
  redact(text: string): string
}

const CHAT_ADAPTERS = new Set(['claude', 'codex'])

export class AgentChats {
  constructor(private d: AgentChatDeps) {}

  private agent(agentId: Id): CompanyAgent {
    const a = this.d.getAgent(agentId)
    if (!a || a.archivedAt) throw new HiveError('not_found', 'That agent is no longer on the team')
    return a
  }

  /** How the agent's chat is spawned (SessionDeps.agentChat): null when it cannot chat (gone, a workflow, a shell). */
  spawnOptions(agentId: Id): AgentChatSpawn | null {
    const a = this.d.getAgent(agentId)
    if (!a || a.archivedAt || a.kind !== 'profile') return null
    const adapter = this.d.profileAdapter(a.refId)
    if (!adapter || !CHAT_ADAPTERS.has(adapter)) return null
    const deps = this.d.departmentsOf(a.companyId)
    const dep = a.departmentId ? (deps.find((x) => x.id === a.departmentId) ?? null) : null
    const persona = this.d.personasOn() ? (resolvePersonas(this.d.agentsOf(a.companyId), deps).get(a.id) ?? a.data.persona ?? null) : null
    const name = persona?.name || a.name
    const cwd = (a.data.defaultRepoId ? this.d.repoPath(a.data.defaultRepoId) : null) ?? this.d.workspaceDir(a.companyId)
    if (!cwd) return null
    const brief = agentChatBrief({
      name,
      role: a.name,
      company: this.d.companyName(a.companyId),
      department: dep?.name ?? null,
      personality: persona?.personality ?? null,
      bio: persona?.bio ?? null,
      instructions: a.data.instructions ?? '',
      auto: a.data.autonomy === 'auto',
      code: this.d.isCode(a.companyId)
    })
    let team: string | null = null
    try {
      team = this.d.teamContext?.(a.companyId, a.id) ?? null
    } catch {
      team = null // the chat never waits on the team block
    }
    return {
      profileId: a.refId,
      companyId: a.companyId,
      cwd,
      title: name === a.name ? a.name : `${name} · ${a.name}`,
      agentBrief: this.d.redact([brief, team ?? ''].filter(Boolean).join('\n\n')),
      agentDepartmentId: a.departmentId
    }
  }

  /** The agent's chat, running: reused, resumed (same conversation) or started. */
  open(agentId: Id): Session {
    const a = this.agent(agentId)
    if (a.kind !== 'profile') throw new HiveError('bad_request', 'This agent is a workflow: it runs, it does not chat')
    const spawn = this.spawnOptions(agentId)
    if (!spawn) {
      const adapter = this.d.profileAdapter(a.refId)
      throw new HiveError('bad_request', adapter && !CHAT_ADAPTERS.has(adapter) ? `Chats with agents run on Claude or Codex; this agent uses ${adapter}` : 'This agent has no folder to work in yet')
    }
    const sm = this.d.sessions()
    const mine = this.d.sessionsOf(agentId, a.companyId)
    // a chat on another AI tool (the agent was switched from Claude to Codex, or back) is not this agent's chat any
    // more: it ends, and the next one starts on the agent's tool now (a different CLI cannot resume its conversation)
    for (const s of mine) if (s.profileId !== a.refId && sm.isLive(s.id)) void sm.kill(s.id).catch(() => undefined)
    const same = mine.filter((s) => s.profileId === a.refId)
    const live = same.find((s) => sm.isLive(s.id))
    if (live) return live
    const last = same[0]
    if (last) {
      try {
        return sm.restart(last.id)
      } catch (e) {
        // its profile changed harness, its folder is gone…: a fresh chat rather than none
        if (!(e instanceof HiveError) || e.code === 'conflict') throw e
      }
    }
    return sm.create({ profileId: spawn.profileId, companyId: spawn.companyId, cwd: spawn.cwd, chat: true, title: spawn.title, companyAgentId: agentId, agentBrief: spawn.agentBrief, agentDepartmentId: spawn.agentDepartmentId, cols: 120, rows: 32 })
  }
}
