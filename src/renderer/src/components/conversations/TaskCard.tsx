/**
 * CHAT-UI.md §8: the live task card and the "Working on it" strip. A task filed from a conversation (or a Forum
 * message) shows here as a card that moves with it: who is on it, Queued / Working / Needs you / In review / Done /
 * Failed, the run's latest activity, the elapsed time, and what you can do (Watch, Open task, answer or approve).
 * The card is one message, patched in place by main; the live sources (tasks, runs' root agents, open asks) drive it
 * between patches. White line art on the dark surface: status colours only on the small state mark.
 *
 * While it works the card shows "Working · 1m 12s" (ticking) and the last few things the agent did, live from its
 * run's root agent events (the same agent:events stream the run view's timeline reads). Show logs opens that run's
 * full log in place: the run view's Activity timeline (AgentTimeline) or its Output (StepLog), following the tail.
 * A queued card says why it waits and offers Run now (tasks:start, the Board drawer's Run now).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import { agentActive, startsWithoutAutopilot, type CompanyTask } from '@shared/company'
import { clockLabel, queuedReason, workingStrip, type ForumTaskCard, type StripTask } from '@shared/taskCard'
import { Button, Segmented } from '../ui'
import { AgentFace, useAgentDisplay } from '../board/NeedsYouTasks'
import { AgentTimeline } from '../agents/AgentTimeline'
import { StepLog } from '../StepLog'
import { cardsOfMessages, openAskOfRun, parseRunStarts, rootOfRun, runStartsKey, stripTasks, tailLines, taskCardView } from '../../lib/taskCardView'
import { openAskRuns } from '../../lib/departments'
import { reposOf } from '../../lib/companyModel'
import { eventGlyph } from '../../lib/live'
import { errorMessage, hive } from '../../lib/hive'
import { mergeAgents, useAgentEvents } from '../../state/live'
import { attempt, navigate, openBoard, useStore, type State } from '../../state/store'
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

/** "1m 12s", ticking every second; its own component so only the clock re-renders. */
function WorkClock({ since }: { since: string }): React.JSX.Element {
  const now = useNow(true, 1000)
  return (
    <span className="cx-task__age" title="Since its run started" data-chatux="task-clock">
      {clockLabel(since, null, now)}
    </span>
  )
}

/** The last few lines of what the agent is doing (tool calls, its latest message), live from its events. */
function TaskTail({ agentId, code, fallback }: { agentId: Id; code: boolean; fallback: string }): React.JSX.Element {
  const { events } = useAgentEvents(agentId, 30)
  const lines = useMemo(() => tailLines(events, { n: 4, code }), [events, code])
  return (
    <div className="cx-task__tail" data-chatux="task-tail" aria-live="polite">
      {lines.length === 0 ? (
        <div className="cx-task__tl">
          <span className="cx-task__tl-glyph" aria-hidden>
            ●
          </span>
          <span className="cx-task__tl-text shimmer-text">{fallback}</span>
        </div>
      ) : (
        lines.map((l, i) => (
          <div key={l.key} className={`cx-task__tl is-${l.kind} ${l.state ? `is-${l.state}` : ''} ${i === lines.length - 1 ? 'is-last' : ''}`}>
            <span className="cx-task__tl-glyph" aria-hidden>
              {eventGlyph({ kind: l.kind, state: l.state } as Parameters<typeof eventGlyph>[0])}
            </span>
            <span className={`cx-task__tl-text ${i === lines.length - 1 && l.state === 'running' ? 'shimmer-text' : ''}`} title={l.text}>
              {l.text}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

/** The run's full log in the card: the run view's Activity timeline or its Output, following the tail. */
export function TaskLog({ agentId, runId, stepId, live }: { agentId: Id; runId: Id; stepId: Id | null; live: boolean }): React.JSX.Element {
  const [tab, setTab] = useState<'activity' | 'output'>('activity')
  return (
    <div className="cx-task__log" data-chatux="task-log">
      {stepId && (
        <Segmented
          size="sm"
          className="cx-task__logtabs"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'activity', label: 'Activity' },
            { value: 'output', label: 'Output' }
          ]}
        />
      )}
      <div className="cx-task__logbox">
        {tab === 'output' && stepId ? <StepLog runId={runId} stepId={stepId} live={live} /> : <AgentTimeline agentId={agentId} emptyText={live ? 'Waiting for the first tool call…' : 'No activity recorded.'} />}
      </div>
    </div>
  )
}

/** "text\u0000canRun" (a primitive, so the store selector stays stable) of why a queued task waits. */
function queueKey(s: State, task: CompanyTask, runLabel: string): string {
  const seat = task.agentId ? s.companyAgents.find((a) => a.id === task.agentId) : undefined
  const company = s.companies.find((c) => c.id === task.companyId) ?? null
  const depsOpen = task.dependencyIds.map((d) => s.tasks.find((t) => t.id === d)).filter((t): t is CompanyTask => !!t && t.status !== 'done').map((t) => t.identifier)
  let inFlight = 0
  let agentRunning = 0
  for (const t of s.tasks) {
    if (t.companyId !== task.companyId || t.status !== 'in_progress' || t.id === task.id) continue
    if (t.runId) inFlight++
    if (task.agentId && t.agentId === task.agentId) agentRunning++
  }
  const startsAnyway = startsWithoutAutopilot({ source: task.source, status: task.status, pendingWake: task.pendingWake ?? null, plan: task.plan ?? null, ask: task.ask ?? null, handoffs: task.handoffs ?? 0 })
  const r = queuedReason({
    task,
    agent: seat ? { name: seat.name, archivedAt: seat.archivedAt, pausedAt: agentActive(seat) ? null : (seat.pausedAt ?? 'paused'), data: seat.data } : null,
    company: company ? { name: company.name, autopilot: company.autopilot, pausedAt: company.pausedAt ?? null, maxInFlight: company.maxInFlight } : null,
    depsOpen,
    inFlight,
    agentRunning,
    startsAnyway,
    runLabel
  })
  return `${r.text}\u0000${r.canRun ? 1 : 0}`
}

/** A Forum message's card (Chats conversations, Forum channels). */
export function TaskCard({ m }: { m: ForumMessage }): React.JSX.Element | null {
  return m.task ? <TaskCardView card={m.task} companyId={m.companyId} /> : null
}

/** The live card for one task: a conversation's card message, or a chat's company_file_task / task_create call. */
export function TaskCardView({ card: stored, companyId }: { card: ForumTaskCard; companyId?: Id | null }): React.JSX.Element | null {
  const card: ForumTaskCard | undefined = stored
  const task = useStore((s) => (card ? (s.tasks.find((t) => t.id === card.taskId) ?? null) : null))
  const runId = task?.runId ?? card?.runId ?? null
  const root = useStore((s) => (runId ? rootOfRun(Object.values(s.agents), runId) : null))
  const ask = useStore((s) => (runId ? openAskOfRun(Object.values(s.asks), runId) : null))
  const co = companyId ?? task?.companyId ?? null
  const code = useStore((s) => (co ? reposOf(s.repos, co).length > 0 : true))
  const seat = useStore((s) => (card ? s.companyAgents.find((a) => a.id === (task?.agentId ?? card.agentId)) : undefined))
  const display = useAgentDisplay()(seat)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const runLabel = code ? 'Run now' : 'Start'
  const queuedTask = task && ['todo', 'backlog', 'triage', 'blocked'].includes(task.status) ? task : null
  const queue = useStore((s) => (queuedTask ? queueKey(s, queuedTask, runLabel) : ''))
  const live = !!card && (task ? ['todo', 'backlog', 'triage', 'in_progress', 'blocked'].includes(task.status) : card.state === 'working' || card.state === 'queued')
  const now = useNow(live)
  // the run's agents load on demand (a chat reopened after a restart has none in the store yet)
  const hasRoot = !!root
  useEffect(() => {
    if (runId && !hasRoot) void hive.agents.list({ runId, rootsOnly: true, limit: 20 }).then(mergeAgents, () => undefined)
  }, [runId, hasRoot])
  // a start that went through clears the error it showed before
  useEffect(() => setRunError(null), [task?.status, task?.runId])
  if (!card) return null
  const v = taskCardView(card, task, { root, ask, code, now })
  const who = display?.name ?? seat?.name ?? 'Nobody yet'
  const [queueText, queueRun] = queue ? queue.split('\u0000') : ['Waiting for its turn', '0']
  const canRun = v.state === 'queued' && queueRun === '1' && !!task
  const logAgent = root && root.runId === v.runId ? root : null
  const rootLive = !!logAgent && (logAgent.status === 'working' || logAgent.status === 'starting' || logAgent.status === 'needs_you')
  const act = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    await attempt(fn, label)
    setBusy(false)
    setAnswer('')
  }
  const runNow = async (): Promise<void> => {
    if (busy || !task) return
    setBusy(true)
    setRunError(null)
    try {
      await hive.tasks.start({ id: task.id })
    } catch (e) {
      // the start refused (busy seat, paused company, no agent…): say why on the card, not in a toast
      setRunError(errorMessage(e))
    }
    setBusy(false)
  }
  const toggleLog = (): void => {
    if (logAgent) setLogOpen((o) => !o)
  }
  return (
    <div className={`cx-task is-${v.state} ${logOpen ? 'is-open' : ''}`} data-chatux="task-card" data-state={v.state} data-task={card.identifier} role="group" aria-label={`${card.identifier}: ${card.title}, ${v.label}`}>
      <div className={`cx-task__head ${logAgent ? 'is-toggle' : ''}`} onClick={toggleLog}>
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
          <>
            <span className="cx-task__activity shimmer-text" data-chatux="task-activity">
              {logAgent ? 'Working' : 'Starting'}
            </span>
            <span className="cx-task__sep">·</span>
            <WorkClock since={v.since} />
          </>
        ) : (
          <>
            {v.state === 'queued' ? (
              <span className="cx-task__activity cx-task__why" data-chatux="task-why" title={queueText}>
                {queueText}
              </span>
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
          </>
        )}
      </div>
      {v.state === 'needs_you' && v.result && (
        <div className="cx-task__outcome selectable" data-chatux="task-result">
          {v.result}
        </div>
      )}
      {v.state === 'working' && !logOpen && (logAgent ? <TaskTail agentId={logAgent.id} code={code} fallback={v.activity ?? 'Working…'} /> : <div className="cx-task__tail"><div className="cx-task__tl"><span className="cx-task__tl-glyph" aria-hidden>●</span><span className="cx-task__tl-text shimmer-text">Starting…</span></div></div>)}
      {logOpen && logAgent && v.runId && <TaskLog agentId={logAgent.id} runId={v.runId} stepId={logAgent.stepId} live={rootLive} />}
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
      {runError && (
        <div className="cx-task__error" role="alert" data-chatux="task-run-error">
          {runError}
        </div>
      )}
      <div className="cx-task__actions">
        {canRun && (
          <Button size="sm" variant="primary" icon="play" disabled={busy} data-chatux="task-run" onClick={() => void runNow()}>
            {runLabel}
          </Button>
        )}
        {logAgent && (
          <Button size="sm" variant="ghost" data-chatux="task-logs" aria-expanded={logOpen} onClick={toggleLog}>
            {logOpen ? 'Hide logs' : 'Show logs'}
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
        <span className="flex1" />
        {v.runId && (
          <button type="button" className="link-btn cx-task__link" data-chatux="task-watch" onClick={() => watch(v.runId)}>
            {v.state === 'working' || (v.needs?.live ?? false) ? 'Watch' : 'See the run'}
          </button>
        )}
        {v.onBoard && (
          <button type="button" className="link-btn cx-task__link" data-chatux="task-open" onClick={() => co && openBoard(co, { taskId: card.taskId })}>
            Open task
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * "Working on it": one line under the conversation's header while a task it started is still open ("Julia is
 * working on VO-9 · 2m · Watch", "2 tasks running"). Click the line to list them. A working task's clock counts from
 * its run's start, like its card.
 */
export function WorkingStrip({ msgs, cards }: { msgs?: readonly ForumMessage[]; cards?: readonly ForumTaskCard[] }): React.JSX.Element | null {
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const seats = useStore((s) => s.companyAgents)
  const agentDisplay = useAgentDisplay()
  const [open, setOpen] = useState(false)
  const list = useMemo(() => cards ?? cardsOfMessages(msgs ?? []), [cards, msgs])
  const runIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of list) {
      const r = tasks.find((t) => t.id === c.taskId)?.runId ?? c.runId
      if (r) ids.add(r)
    }
    return ids
  }, [list, tasks])
  const starts = useStore((s) => runStartsKey(Object.values(s.agents), runIds))
  const items = useMemo(() => {
    const who = (agentId: string | null): string | null => {
      const seat = agentId ? seats.find((a) => a.id === agentId) : undefined
      return seat ? (agentDisplay(seat)?.name ?? seat.name) : null
    }
    const since = parseRunStarts(starts)
    return stripTasks(list, tasks, who, openAskRuns(asks), (r) => since.get(r) ?? null)
  }, [list, tasks, seats, agentDisplay, asks, starts])
  const anyOpen = items.some((t) => t.state === 'queued' || t.state === 'working' || t.state === 'needs_you')
  const now = useNow(anyOpen)
  const strip = workingStrip(items, now)
  if (!strip) return null
  const runOf = (t: StripTask): Id | null => tasks.find((x) => x.id === t.taskId)?.runId ?? null
  const focusRun = runOf(strip.focus)
  const many = strip.tasks.length > 1
  return (
    <div className={`cx-strip ${strip.focus.state === 'needs_you' ? 'is-needs' : ''}`} data-chatux="working-strip" data-state={strip.focus.state} role="status">
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
              <span className="cx-strip__who">· {t.state === 'working' ? 'working' : t.state === 'needs_you' ? 'needs you' : 'queued'}</span>
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
