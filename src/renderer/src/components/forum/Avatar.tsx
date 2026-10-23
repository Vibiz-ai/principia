/**
 * FORUM.md §8: who a Forum member is on screen. Agents are their seat: bust + persona name + role label (VOICE.md §4.4,
 * the same AgentFace and display rules as the board). Humans get an engraved initial coin (line art, VOICE.md §5.6);
 * guests a dashed one.
 */
import { useMemo } from 'react'
import type { ForumMember } from '@shared/forum'
import type { AgentPersona } from '@shared/personas'
import { AgentFace, useAgentDisplay } from '../board/NeedsYouTasks'
import { useStore } from '../../state/store'

export interface MemberDisplay {
  name: string
  /** agents: the role label ("Copywriter"); humans: their Forum role */
  role: string
  department: string | null
  departmentColor: string | null
  persona: AgentPersona | null
  kind: ForumMember['kind']
  handle: string
  removed: boolean
}

/** member id → display, memoized on the slices it reads. */
export function useMemberDisplay(members: ForumMember[]): (id: string) => MemberDisplay | null {
  const agents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const agentDisplay = useAgentDisplay()
  return useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, m]))
    const cache = new Map<string, MemberDisplay | null>()
    return (id: string) => {
      if (cache.has(id)) return cache.get(id)!
      const m = byId.get(id)
      let d: MemberDisplay | null = null
      if (m) {
        if (m.kind === 'agent') {
          const seat = agents.find((a) => a.id === m.agentId)
          const shown = agentDisplay(seat)
          const dep = seat?.departmentId ? departments.find((x) => x.id === seat.departmentId) : undefined
          d = { name: shown?.name ?? m.name, role: shown?.role || seat?.name || 'agent', department: dep?.name ?? null, departmentColor: dep?.color ?? null, persona: shown?.persona ?? null, kind: 'agent', handle: m.handle, removed: m.status === 'removed' }
        } else {
          d = { name: m.name, role: m.role === 'owner' ? 'owner' : m.role === 'admin' ? 'admin' : m.kind === 'guest' ? 'guest' : 'member', department: null, departmentColor: null, persona: null, kind: m.kind, handle: m.handle, removed: m.status === 'removed' }
        }
      }
      cache.set(id, d)
      return d
    }
  }, [members, agents, departments, agentDisplay])
}

/** Engraved coin with the initial (humans), dashed for guests. Decorative. */
export function InitialCoin({ name, size, guest = false }: { name: string; size: number; guest?: boolean }): React.JSX.Element {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <svg className="fm-coin rm-la" width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <circle cx="20" cy="20" r="18.6" style={{ stroke: 'var(--rm-ln-1)' }} strokeDasharray={guest ? '2 2.6' : undefined} />
      {size >= 24 && !guest && <circle cx="20" cy="20" r="16.4" style={{ stroke: 'var(--rm-ln-3)' }} />}
      <text x="20" y="25.6" textAnchor="middle" className="fm-coin__letter">
        {initial}
      </text>
    </svg>
  )
}

export function MemberAvatar({ display, size = 32, working = false }: { display: MemberDisplay | null; size?: number; working?: boolean }): React.JSX.Element {
  const body = !display ? (
    <InitialCoin name="?" size={size} />
  ) : display.kind === 'agent' ? (
    <AgentFace persona={display.persona} label={display.role || display.name} color={display.departmentColor} size={size} />
  ) : (
    <InitialCoin name={display.name} size={size} guest={display.kind === 'guest'} />
  )
  return (
    <span className={`fm-avatar ${display?.removed ? 'is-removed' : ''}`} style={{ width: size, height: size }}>
      {body}
      {working && <span className="fm-avatar__working" title="Working" aria-label="Working" />}
    </span>
  )
}
