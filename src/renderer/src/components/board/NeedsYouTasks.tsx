import { useMemo, useState } from 'react'
import type { Id } from '@shared/types'
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { AgentPersona } from '@shared/personas'
import { BLOCK_REASON_TEXT, NEEDS_GROUP_LABEL, REASON_LABEL, needsYouTasks, type NeedsYouItem } from '../../lib/board'
import { laneContext, seatInitials } from '../../lib/departments'
import { displayName, personasOf } from '../../lib/personaView'
import { firstLine } from '../../lib/format'
import { t, usePersonasOn, useTone, type Tone } from '../../lib/voice'
import { departmentsOn, openBoard, useStore } from '../../state/store'
import { Bust } from '../roman'
import { CompanyChip } from '../CompanyChip'
import { AskForm } from './AskForm'
import '../../styles/board.css'

/**
 * An agent's face: the persona bust with personas on; the department-colour initials (SeatAvatar look) with them off
 * or when the agent has no persona. Decorative: the name sits beside it. Busts here are list avatars (16 to 28 px),
 * so they carry the faint ring (VOICE.md §5.4).
 */
export function AgentFace({ persona, label, color, size }: { persona: AgentPersona | null; label: string; color: string | null; size: number }): React.JSX.Element {
  if (persona) return <Bust look={persona.look} size={size} ring={size <= 28} className="agent-face" />
  return (
    <span className="seat-avatar agent-face" style={{ width: size, height: size, background: color ?? 'var(--series-other)', fontSize: Math.max(8, Math.round(size * 0.42)) }} aria-hidden>
      {seatInitials(label)}
    </span>
  )
}

/** Who an agent is on screen, from the store: "{persona} · {role}" with personas on, the role label with them off. */
export function useAgentDisplay(): (agent: CompanyAgent | undefined) => { name: string; role: string; persona: AgentPersona | null } | null {
  const companyAgents = useStore((s) => s.companyAgents)
  const departments = useStore((s) => s.departments)
  const on = usePersonasOn()
  return useMemo(() => {
    const personas = personasOf({ companyAgents, departments })
    return (agent) => (agent ? displayName(agent, personas, on) : null)
  }, [companyAgents, departments, on])
}

/** Who the line names when a waiting task has no agent ("This task needs your review"). */
const NO_AGENT = 'This task'

/**
 * VOICE.md §3.6 item line: ny.ask / ny.review / ny.parked / ny.unassigned. Only the top item of a list may use the
 * playful ny.ask (`tone` is 'plain' for every other row), so five asks never read as five "Ave!"s.
 */
export function needsLine(item: NeedsYouItem, persona: string, tone: Tone): string {
  const { task, group, reason } = item
  if (group === 'ask') return t('ny.ask', { persona }, tone)
  if (group === 'review') return t('ny.review', { persona }, tone)
  if (group === 'unassigned') return t('ny.unassigned', undefined, tone)
  return t('ny.parked', { persona, reason: parkedWhy(task, reason) }, tone)
}
function parkedWhy(task: CompanyTask, reason: NeedsYouItem['reason']): string {
  const said = task.report?.outcome === 'blocked' ? firstLine(task.report.summary ?? '', 60).trim() : ''
  if (said) return said.charAt(0).toLowerCase() + said.slice(1)
  return REASON_LABEL[reason].toLowerCase()
}

/**
 * DEPARTMENTS.md §9 Needs you task items: board asks (answerable inline), reviews, parked tasks with their reason and
 * unassigned tasks, every one through laneOf. Mounted by the sidebar slot (D9), Home and the Portfolio. `companyId`
 * absent = every company (each row with its chip). Returns null when nothing waits, or while departments are off.
 * `skipLiveAsks` (default: every company): where the live ask rows are listed beside this block, a live ask is shown
 * there, once. VOICE.md §3.6: each item names the agent (bust 24, persona and role); the detail line is unchanged.
 * `playfulTop` (default true): whether the first row may use the playful line. A caller that lists other Needs you
 * rows above this block (Home's live asks) passes false, so the screen's one wink stays on the real top item.
 */
export function NeedsYouTasks({ companyId, limit, skipLiveAsks, playfulTop = true }: { companyId?: Id; limit?: number; skipLiveAsks?: boolean; playfulTop?: boolean }): React.JSX.Element | null {
  const on = useStore((s) => departmentsOn(s))
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const agents = useStore((s) => s.companyAgents)
  const multi = useStore((s) => s.companies.length > 1)
  const tone = useTone()
  const [open, setOpen] = useState<Id | null>(null)
  const skip = skipLiveAsks ?? !companyId
  const items = useMemo(() => needsYouTasks(tasks, laneContext(asks, agents), companyId, { skipLiveAsks: skip }), [tasks, asks, agents, companyId, skip])
  if (!on || !items.length) return null
  const shown = limit ? items.slice(0, limit) : items
  const more = items.length - shown.length
  return <div className="needs-tasks" role="list" aria-label="Tasks that need you">
    {shown.map((item, i) => {
      const head = i === 0 || shown[i - 1]!.group !== item.group
      return <div key={item.task.id} role="listitem">
        {head && <div className="needs-tasks__group">{NEEDS_GROUP_LABEL[item.group]}</div>}
        <NeedsTaskRow item={item} tone={i === 0 && playfulTop ? tone : 'plain'} chip={!companyId && multi} open={open === item.task.id} onToggle={() => setOpen((x) => (x === item.task.id ? null : item.task.id))} />
      </div>
    })}
    {more > 0 && <button type="button" className="needs-tasks__more link-btn" onClick={() => openBoard(companyId ?? shown[0]!.task.companyId)}>{more} more on the Board</button>}
  </div>
}

function NeedsTaskRow({ item, tone, chip, open, onToggle }: { item: NeedsYouItem; tone: Tone; chip: boolean; open: boolean; onToggle: () => void }): React.JSX.Element {
  const { task, reason } = item
  const agent = useStore((s) => (task.agentId ? s.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined))
  const color = useStore((s) => {
    const depId = agent?.departmentId ?? task.departmentId
    return depId ? (s.departments.find((d) => d.id === depId)?.color ?? null) : null
  })
  const who = useAgentDisplay()(agent)
  const persona = who?.name ?? NO_AGENT
  const role = who?.role ?? ''
  const unassigned = item.group === 'unassigned'
  // a board ask is answered right here; everything else opens the card
  const answerable = reason === 'needs_input' && !!task.ask && !task.ask.answer
  const why = task.status === 'blocked' && task.blockReason ? BLOCK_REASON_TEXT[task.blockReason] : undefined
  // screen readers hear the plain line, whatever the tone: "Marcus, Copywriter, needs you: Approve 3 post drafts"
  const sr = `${t.sr('ny.item.sr', { persona: unassigned || !who ? NO_AGENT : persona, role: unassigned ? '' : role, task: task.title }).replace(/,\s*,/g, ',')} · ${REASON_LABEL[reason]} · ${task.identifier}`
  return <div className={`needs-task ${open ? 'is-open' : ''}`}>
    <button type="button" className="needs-task__row ny-row" onClick={answerable ? onToggle : () => openBoard(task.companyId, { taskId: task.id })} title={why ?? (answerable ? 'Answer the question' : 'Open the card')} aria-label={sr} aria-expanded={answerable ? open : undefined}>
      <span className="ny-row__face" aria-hidden>
        {unassigned || !who ? <span className="ny-row__empty-face" style={{ width: 24, height: 24 }} /> : <AgentFace persona={who.persona} label={who.name} color={color} size={24} />}
      </span>
      <span className="ny-row__main">
        <span className="ny-row__line">
          {/* "Ave!" greets a colleague: a row with no agent reads plain */}
          <span className="ny-row__text">{needsLine(item, persona, who ? tone : 'plain')}</span>
          {!unassigned && role && <span className="ny-row__role"> · {role}</span>}
        </span>
        <span className="ny-row__detail">
          <span className={`board-reason board-reason--${reason}`}>{REASON_LABEL[reason]}</span>
          {chip && <CompanyChip companyId={task.companyId} avatarOnly size={14} />}
          <span className="task-identifier">{task.identifier}</span>
          <span className="needs-task__title">{task.title}</span>
        </span>
      </span>
    </button>
    {answerable && open && <div className="needs-task__ask">
      <AskForm task={task} compact onAnswered={onToggle} />
      <button type="button" className="link-btn needs-task__open" onClick={() => openBoard(task.companyId, { taskId: task.id })}>Open the card</button>
    </div>}
  </div>
}
