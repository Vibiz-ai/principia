/**
 * CHAT-UI.md §8: the live task card and the "Working on it" strip. A task filed from a conversation (or a Forum
 * message) shows here as a card that moves with it: who is on it, Queued / Working / Needs you / In review / Done /
 * Failed, the run's latest activity, the elapsed time, and what you can do (Watch, Open task, answer or approve).
 * The card is one message, patched in place by main; the live sources (tasks, runs' root agents, open asks) drive it
 * between patches. White line art on the dark surface: status colours only on the small state mark.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import { workingStrip, type StripTask } from '@shared/taskCard'
import { Button } from '../ui'
import { AgentFace, useAgentDisplay } from '../board/NeedsYouTasks'
import { conversationStripTasks, openAskOfRun, rootOfRun, taskCardView } from '../../lib/taskCardView'
import { openAskRuns } from '../../lib/departments'
import { reposOf } from '../../lib/companyModel'
import { hive } from '../../lib/hive'
import { attempt, navigate, openBoard, useStore } from '../../state/store'
import '../../styles/conversations.css'

/** A clock for elapsed labels: ticks while something is open, stops otherwise. */
function useNow(active: boolean, ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

function watch(runId: string | null): void {
  if (runId) void navigate({ name: 'run', runId })
}

export function TaskCard({ m }: { m: ForumMessage }): React.JSX.Element | null {
  const card = m.task
  const task = useStore((s) => (card ? (s.tasks.find((t) => t.id === card.taskId) ?? null) : null))
  const runId = task?.runId ?? card?.runId ?? null
  const root = useStore((s) => (runId ? rootOfRun(Object.values(s.agents), runId) : null))
  const ask = useStore((s) => (runId ? openAskOfRun(Object.values(s.asks), runId) : null))
  const code = useStore((s) => reposOf(s.repos, m.companyId).length > 0)
  const seat = useStore((s) => (card ? s.companyAgents.find((a) => a.id === (task?.agentId ?? card.agentId)) : undefined))
  const display = useAgentDisplay()(seat)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const live = !!card && (task ? ['todo', 'backlog', 'triage', 'in_progress', 'blocked'].includes(task.status) : card.state === 'working' || card.state === 'queued')
  const now = useNow(live)
  if (!card) return null
  const v = taskCardView(card, task, { root, ask, code, now })
  const who = display?.name ?? seat?.name ?? 'Nobody yet'
  const act = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    await attempt(fn, label)
    setBusy(false)
    setAnswer('')
  }
  return (
    <div className={`cx-task is-${v.state}`} data-chatux="task-card" data-state={v.state} data-task={card.identifier} role="group" aria-label={`${card.identifier}: ${card.title}, ${v.label}`}>
      <div className="cx-task__head">
        <span className="cx-task__face" aria-hidden>
          <AgentFace persona={display?.persona ?? null} label={display?.role || seat?.name || who} color={null} size={22} />
        </span>
        <span className="cx-task__id">{card.identifier}</span>
        <span className="cx-task__title" title={card.title}>
          {card.title}
        </span>
        <span className="flex1" />
        <span className={`cx-task__state is-${v.state}`} data-chatux="task-state">
          <span className="cx-task__mark" aria-hidden />
          <span className={v.state === 'working' ? 'shimmer-text' : ''}>{v.label}</span>
        </span>
      </div>
      <div className="cx-task__line">
        <span className="cx-task__who">{who}</span>
        <span className="cx-task__sep">·</span>
        {v.state === 'working' ? (
          <span className="cx-task__activity shimmer-text" data-chatux="task-activity">
            {v.activity ?? (root ? 'Working…' : 'Starting…')}
          </span>
        ) : v.state === 'queued' ? (
          <span className="cx-task__activity">Waiting for its turn</span>
        ) : v.state === 'needs_you' ? (
          <span className="cx-task__activity" data-chatux="task-needs">
            {v.needs?.prompt}
          </span>
        ) : (
          <span className="cx-task__activity cx-task__result selectable" data-chatux="task-result">
            {v.result ?? (v.state === 'failed' ? 'It stopped before it was finished' : 'Finished')}
          </span>
        )}
        <span className="cx-task__sep">·</span>
        <span className="cx-task__age" title="Since it started">
          {v.elapsed}
        </span>
      </div>
      {v.state === 'needs_you' && v.needs && !v.needs.live && task?.ask && !task.ask.answer && (
        <form
          className="cx-task__answer"
          onSubmit={(e) => {
            e.preventDefault()
            if (answer.trim()) void act(() => hive.tasks.answer({ id: card.taskId, answer: answer.trim() }), 'Answer')
          }}
        >
          {v.needs.options.length ? (
            v.needs.options.map((o) => (
              <Button key={o} size="sm" disabled={busy} data-chatux="task-option" onClick={() => void act(() => hive.tasks.answer({ id: card.taskId, answer: o }), 'Answer')}>
                {o}
              </Button>
            ))
          ) : (
            <>
              <input className="input input--sm cx-task__input" value={answer} disabled={busy} placeholder="Your answer…" aria-label={`Answer ${card.identifier}`} data-chatux="task-answer" onChange={(e) => setAnswer(e.target.value)} />
              <Button type="submit" size="sm" variant="primary" disabled={busy || !answer.trim()}>
                Send
              </Button>
            </>
          )}
        </form>
      )}
      <div className="cx-task__actions">
        {v.runId && (
          <Button size="sm" variant="ghost" icon="eye" data-chatux="task-watch" onClick={() => watch(v.runId)}>
            {v.state === 'working' || (v.needs?.live ?? false) ? 'Watch' : 'See the run'}
          </Button>
        )}
        {v.needs?.live && (
          <Button size="sm" variant="primary" data-chatux="task-approve" onClick={() => watch(v.runId)}>
            Answer it
          </Button>
        )}
        {v.state === 'in_review' && task && (
          <Button size="sm" variant="primary" disabled={busy} data-chatux="task-approve" onClick={() => void act(() => hive.tasks.approve({ id: card.taskId, doneNote: v.result ?? 'Approved in the conversation' }), 'Approve')}>
            Approve
          </Button>
        )}
        {v.prUrl && (
          <Button size="sm" variant="ghost" icon="external" data-chatux="task-pr" onClick={() => void hive.app.openExternal({ url: v.prUrl! }).catch(() => undefined)}>
            Pull request
          </Button>
        )}
        {v.onBoard && (
          <Button size="sm" variant="ghost" data-chatux="task-open" onClick={() => openBoard(m.companyId, { taskId: card.taskId })}>
            Open task
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * "Working on it": one line under the conversation's header while a task it started is still open ("Julia is
 * working on VO-9 · 2m · Watch", "2 tasks running"). Click the line to list them.
 */
export function WorkingStrip({ msgs }: { msgs: readonly ForumMessage[] }): React.JSX.Element | null {
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const seats = useStore((s) => s.companyAgents)
  const agentDisplay = useAgentDisplay()
  const [open, setOpen] = useState(false)
  const items = useMemo(() => {
    const who = (agentId: string | null): string | null => {
      const seat = agentId ? seats.find((a) => a.id === agentId) : undefined
      return seat ? (agentDisplay(seat)?.name ?? seat.name) : null
    }
    return conversationStripTasks(msgs, tasks, who, openAskRuns(asks))
  }, [msgs, tasks, seats, agentDisplay, asks])
  const anyOpen = items.some((t) => t.state === 'queued' || t.state === 'working' || t.state === 'needs_you')
  const now = useNow(anyOpen)
  const strip = workingStrip(items, now)
  if (!strip) return null
  const runOf = (t: StripTask): Id | null => tasks.find((x) => x.id === t.taskId)?.runId ?? null
  const focusRun = runOf(strip.focus)
  const many = strip.tasks.length > 1
  return (
    <div className={`cx-strip ${strip.focus.state === 'needs_you' ? 'is-needs' : ''}`} data-chatux="working-strip" role="status">
      <div className="cx-strip__row">
        <span className={`cx-strip__mark is-${strip.focus.state}`} aria-hidden />
        <button type="button" className={`cx-strip__line ${strip.focus.state === 'working' ? 'shimmer-text' : ''}`} aria-expanded={many ? open : undefined} disabled={!many} onClick={() => setOpen((o) => !o)} data-chatux="working-strip-line">
          {strip.line}
          {many && <span className="cx-strip__chev">{open ? ' ▴' : ' ▾'}</span>}
        </button>
        <span className="flex1" />
        {!many && focusRun && (
          <button type="button" className="link-btn" data-chatux="working-strip-watch" onClick={() => watch(focusRun)}>
            Watch
          </button>
        )}
      </div>
      {many && open && (
        <ul className="cx-strip__list">
          {strip.tasks.map((t) => (
            <li key={t.taskId} className="cx-strip__item">
              <span className={`cx-strip__mark is-${t.state}`} aria-hidden />
              <span className="cx-strip__id">{t.identifier}</span>
              <span className="cx-strip__who">{t.who ?? 'Nobody yet'}</span>
              <span className="flex1" />
              {runOf(t) && (
                <button type="button" className="link-btn" onClick={() => watch(runOf(t))}>
                  Watch
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
