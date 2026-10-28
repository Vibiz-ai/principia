/**
 * CHAT-UI.md §7.2: the new-specialist card in a conversation. Principia (when nobody on the team fits the request)
 * or an agent (mid-conversation, forum_reply with a proposal) suggests a hire: the role, its department, the AI tool
 * it runs on (the default profile) and short instructions. Create & bring in hires it through the same path as the
 * Departments page (forum:decide → companyAgents save), adds it to the conversation and it answers the message;
 * Edit opens the hire sheet first; Use <closest agent> instead brings them in. Nothing is created without a click.
 */
import { useMemo, useState } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import { Button } from '../ui'
import { DecideSheet } from '../forum/Sheets'
import { attempt, toast, useStore } from '../../state/store'
import { hive } from '../../lib/hive'
import { useDeskAgents } from '../../state/desk'
import type { MemberDisplay } from '../forum/Avatar'

/** The lines of a hire card (pure, for the card and its test). */
export function hireCardModel(m: Pick<ForumMessage, 'text' | 'via' | 'proposal'>, ctx: { author: string | null; departmentName: (key: string) => string | null; profileName: string | null; agentName: (id: string) => string | null; decidedBy: string | null }): {
  kicker: string
  question: string
  rows: [string, string][]
  instead: string | null
  outcome: string | null
} | null {
  const p = m.proposal
  if (!p || p.kind !== 'agent' || !p.agent) return null
  const a = p.agent
  const dep = a.departmentKey ? (ctx.departmentName(a.departmentKey) ?? a.departmentKey) : 'Company level'
  const instructions = a.instructions.trim()
  const rows: [string, string][] = [
    ['Role', a.role],
    ['Department', dep],
    ['AI tool', ctx.profileName ?? 'Your default profile'],
    ...(instructions ? ([['Instructions', instructions.length > 280 ? `${instructions.slice(0, 279)}…` : instructions]] as [string, string][]) : [])
  ]
  const instead = p.insteadAgentId ? ctx.agentName(p.insteadAgentId) : null
  const who = ctx.decidedBy ?? 'You'
  const outcome =
    p.status === 'approved'
      ? `${who} created ${a.role}${p.result?.agentId && ctx.agentName(p.result.agentId) ? ` (${ctx.agentName(p.result.agentId)})` : ''}; they joined to answer.`
      : p.status === 'rejected'
        ? p.usedAgentId
          ? `${who} brought in ${ctx.agentName(p.usedAgentId) ?? 'someone on the team'} instead.`
          : `${who} chose not to hire.`
        : null
  return {
    kicker: m.via === 'principia' || !ctx.author ? 'Principia · new specialist' : `${ctx.author} suggests a new specialist`,
    question: m.text,
    rows,
    instead,
    outcome
  }
}

export function HireCard({ m, companyId, display }: { m: ForumMessage; companyId: Id; display: (id: string) => MemberDisplay | null }): React.JSX.Element | null {
  const departments = useStore((s) => s.departments)
  const profiles = useStore((s) => s.profiles)
  const agents = useDeskAgents(companyId)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const p = m.proposal
  const profile = useMemo(() => {
    const usable = profiles.filter((x) => x.adapter !== 'shell')
    return usable.find((x) => x.adapter === (p?.agent?.adapter ?? 'claude')) ?? usable[0] ?? null
  }, [profiles, p?.agent?.adapter])
  const agentName = (id: string): string | null => {
    const a = agents.find((x) => x.id === id)
    return a ? (a.name === a.role ? a.name : `${a.name}, ${a.role}`) : null
  }
  const model = hireCardModel(m, {
    author: display(m.authorId)?.kind === 'agent' ? (display(m.authorId)?.name ?? null) : null,
    departmentName: (key) => departments.find((d) => d.companyId === companyId && d.key === key)?.name ?? null,
    profileName: profile?.name ?? null,
    agentName,
    decidedBy: p?.decidedBy ? (display(p.decidedBy)?.kind === 'human' ? 'You' : (display(p.decidedBy)?.name ?? null)) : null
  })
  if (!p || !model) return null
  const decide = async (req: { decision: 'approve'; profileId?: string } | { decision: 'reject'; useAgentId?: string }): Promise<void> => {
    if (busy) return
    setBusy(true)
    const r = await attempt(
      () => (req.decision === 'approve' ? hive.forum.decide({ messageId: m.id, decision: 'approve', ...(req.profileId ? { edits: { profileId: req.profileId } } : {}) }) : hive.forum.decide({ messageId: m.id, decision: 'reject', ...(req.useAgentId ? { useAgentId: req.useAgentId } : {}) })),
      req.decision === 'approve' ? 'Create agent' : 'Bring in'
    )
    setBusy(false)
    if (r && req.decision === 'approve') toast(`${p.agent?.role ?? 'The new agent'} is on the team and joins this conversation`)
  }
  const open = p.status === 'open'
  return (
    <div className={`cx-hire is-${p.status}`} data-chatux="hire-card" data-status={p.status}>
      <div className="cx-hire__kicker">
        <span className="cx-handoff__mark" aria-hidden>
          ◆
        </span>
        {model.kicker}
      </div>
      <div className="cx-hire__q">{model.question}</div>
      {p.reason && p.reason !== model.question && <div className="cx-hire__why">{p.reason}</div>}
      <dl className="cx-hire__rows">
        {model.rows.map(([k, v]) => (
          <div key={k} className="cx-hire__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {p.error && <div className="cx-hire__error">{p.error}</div>}
      {open ? (
        <div className="cx-hire__actions">
          <Button size="sm" variant="primary" data-chatux="hire-create" disabled={busy || !profile} title={profile ? `Hire ${p.agent?.role} on ${profile.name}; they answer your message here` : 'Add a profile first (Settings › AI providers)'} onClick={() => void decide({ decision: 'approve', ...(profile ? { profileId: profile.id } : {}) })}>
            Create &amp; bring in
          </Button>
          <Button size="sm" data-chatux="hire-edit" disabled={busy} onClick={() => setEditing(true)}>
            Edit…
          </Button>
          {model.instead ? (
            <Button size="sm" variant="ghost" data-chatux="hire-instead" disabled={busy} onClick={() => void decide({ decision: 'reject', useAgentId: p.insteadAgentId! })}>
              Use {model.instead.split(',')[0]} instead
            </Button>
          ) : (
            <Button size="sm" variant="ghost" data-chatux="hire-dismiss" disabled={busy} onClick={() => void decide({ decision: 'reject' })}>
              Not now
            </Button>
          )}
        </div>
      ) : (
        <div className="cx-hire__done" data-chatux="hire-outcome">
          {model.outcome}
        </div>
      )}
      {editing && <DecideSheet m={m} title={`Create ${p.agent?.role ?? 'agent'}`} primaryLabel="Create & bring in" onCancel={() => setEditing(false)} onDone={() => setEditing(false)} />}
    </div>
  )
}
