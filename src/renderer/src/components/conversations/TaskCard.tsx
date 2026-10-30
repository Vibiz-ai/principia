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
 *
 * Needs you: the card stays a compact status card (the reason on one line). The question itself is the filer's own
 * message in the conversation (ForumService.followAsk), answered from the conversation's composer: **Answer** focuses
 * it with "Replying to VO-15's question" (askReply), and the strip's line jumps to that message (jumpToMessage).
 *
 * Docked (CHAT-UI.md §8.5): while a task filed from a conversation is queued, working or needs you, its compact live
 * card sits in the dock right above the composer (TaskDock), and its card in the history is a one-line reference
 * ("VO-15 · working · see below", TaskCardRef). Once it came back it leaves the dock (a short fade) and the history's
 * card is the full outcome card again. The dock folds to one summary line ("3 need you ▸"), and × closes a card here
 * until its task moves on (useDockPrefs); a closed card is the full card in the history again.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForumMessage } from '@shared/forum'
import type { Id } from '@shared/types'
import { agentActive, startsWithoutAutopilot, type CompanyTask } from '@shared/company'
import { SLOT_WAIT_LINE, SLOT_WAIT_WHY, clockLabel, queuedReason, workingStrip, type ForumTaskCard, type StripTask, type TaskCardState } from '@shared/taskCard'
import { Button, IconButton, Segmented } from '../ui'
import { AgentFace, useAgentDisplay } from '../board/NeedsYouTasks'
import { AgentTimeline } from '../agents/AgentTimeline'
import { StepLog } from '../StepLog'
import { cardsOfMessages, DOCK_PREFS_KEY, DOCK_VISIBLE, dockedTasks, dockMark, dockRefLine, dockRows, dockSummary, openDocked, parseDockPrefs, type DockPref, type DockPrefs, openAskOfRun, parseRunStarts, rootOfRun, runStartsKey, stripTasks, stripWord, tailLines, taskCardView } from '../../lib/taskCardView'
import { openAskRuns } from '../../lib/departments'
import { reposOf } from '../../lib/companyModel'
import { eventGlyph } from '../../lib/live'
import { errorMessage, hive } from '../../lib/hive'
import { mergeAgents, useAgentEvents } from '../../state/live'
import { attempt, getState, navigate, openBoard, openTaskLive, useStore, type State } from '../../state/store'
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

/** Watch: a task at work opens its live view in Chats (CHAT-UI.md §8.4); a run that ended opens the run view. */
function watch(runId: string | null, taskId?: string | null): void {
  const t = taskId ? getState().tasks.find((x) => x.id === taskId) : undefined
  if (t && t.status === 'in_progress' && t.runId) return openTaskLive(t.id, t.companyId)
  if (runId) void navigate({ name: 'run', runId })
}

/** The conversation's composer replies to a task's question (ConversationThread listens). */
export const TASK_ASK_REPLY_EVENT = 'principia:task-ask-reply'
export interface TaskAskReply { channelId: string; messageId: string; identifier: string }
export function askReply(r: TaskAskReply): void {
  window.dispatchEvent(new CustomEvent<TaskAskReply>(TASK_ASK_REPLY_EVENT, { detail: r }))
}
/** Scrolls a conversation to one of its messages and marks it for a moment. */
export function jumpToMessage(messageId: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('is-flash')
  setTimeout(() => el.classList.remove('is-flash'), 1600)
  return true
}

/** A folded dock, or one whose card was closed, opens it again for the strip's line and the history's reference. */
const DOCK_REVEAL_EVENT = 'principia:dock-reveal'
/** Marks a task's docked card for a moment (the strip's line, the history's reference). */
export function jumpToDockedTask(identifier: string): boolean {
  const find = (): HTMLElement | null => document.querySelector<HTMLElement>(`[data-dock-task="${CSS.escape(identifier)}"]`)
  const flash = (el: HTMLElement): void => {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    el.classList.add('is-flash')
    setTimeout(() => el.classList.remove('is-flash'), 1600)
  }
  const el = find()
  if (el) {
    flash(el)
    return true
  }
  window.dispatchEvent(new CustomEvent<string>(DOCK_REVEAL_EVENT, { detail: identifier }))
  setTimeout(() => {
    const shown = find()
    if (shown) flash(shown)
  }, 60)
  return false
}

/** The dock's prefs for one conversation (folded, cards closed with ×), kept per viewer in localStorage. */
export interface DockControls {
  collapsed: boolean
  closed: Readonly<Record<string, string>>
  setCollapsed: (collapsed: boolean) => void
  close: (taskId: string, mark: string) => void
  /** one card back, or every closed card */
  reopen: (taskId?: string) => void
}
function readDockPrefs(): DockPrefs {
  try {
    return parseDockPrefs(JSON.parse(localStorage.getItem(DOCK_PREFS_KEY) ?? 'null'))
  } catch {
    return {}
  }
}
export function useDockPrefs(channelId: Id): DockControls {
  const [prefs, setPrefs] = useState<DockPrefs>(readDockPrefs)
  const pref = prefs[channelId] ?? {}
  return useMemo(() => {
    const save = (fn: (p: DockPref) => DockPref): void =>
      setPrefs((all) => {
        const next = { ...all, [channelId]: fn(all[channelId] ?? {}) }
        try {
          localStorage.setItem(DOCK_PREFS_KEY, JSON.stringify(next))
        } catch {
          // a full or blocked storage only loses the convenience
        }
        return next
      })
    return {
      collapsed: !!pref.collapsed,
      closed: pref.closed ?? {},
      setCollapsed: (collapsed) => save((p) => ({ ...p, collapsed })),
      close: (taskId, mark) => save((p) => ({ ...p, closed: { ...p.closed, [taskId]: mark } })),
      reopen: (taskId) =>
        save((p) => {
          if (!taskId) return { ...p, closed: {} }
          const closed = { ...p.closed }
          delete closed[taskId]
          return { ...p, closed }
        })
    }
  }, [channelId, pref.collapsed, pref.closed])
}

/** The cards of a conversation the dock shows, and those closed with × (their history card is the full card again). */
export function useDockView(items: readonly StripTask[], cards: readonly ForumTaskCard[], prefs: DockControls): { docked: StripTask[]; shown: StripTask[]; hidden: StripTask[]; markOf: (t: StripTask) => string } {
  return useMemo(() => {
    const docked = dockedTasks(items)
    const markOf = (t: StripTask): string => dockMark(t, cards.find((c) => c.taskId === t.taskId)?.askMessageId)
    return { docked, markOf, ...openDocked(docked, prefs.closed, markOf) }
  }, [items, cards, prefs.closed])
}

/** "1m 12s", ticking every second; its own component so only the clock re-renders. */
export function WorkClock({ since }: { since: string }): React.JSX.Element {
  const now = useNow(true, 1000)
  return (
    <span className="cx-task__age" title="Since its run started" data-chatux="task-clock">
      {clockLabel(since, null, now)}
    </span>
  )
}

/** The last few lines of what the agent is doing (tool calls, its latest message), live from its events. */
function TaskTail({ agentId, code, fallback, n = 4 }: { agentId: Id; code: boolean; fallback: string; n?: number }): React.JSX.Element {
  const { events } = useAgentEvents(agentId, 30)
  const lines = useMemo(() => tailLines(events, { n, code }), [events, code, n])
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

/**
 * The run's full log in the card: the run view's Activity timeline or its Output, following the tail. `fill` (the
 * task's live view in Chats, CHAT-UI.md §8.4): it takes the pane, and tool calls read in words (raw on click).
 */
export function TaskLog({ agentId, runId, stepId, live, fill, code = true }: { agentId: Id; runId: Id; stepId: Id | null; live: boolean; fill?: boolean; code?: boolean }): React.JSX.Element {
  const [tab, setTab] = useState<'activity' | 'output'>('activity')
  return (
    <div className={`cx-task__log ${fill ? 'cx-task__log--fill' : ''}`} data-chatux="task-log">
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
        {tab === 'output' && stepId ? <StepLog runId={runId} stepId={stepId} live={live} /> : <AgentTimeline agentId={agentId} emptyText={live ? 'Waiting for the first tool call…' : 'No activity recorded.'} plain={fill ? { code } : undefined} />}
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
  for (const t of s.tasks) {
    if (t.companyId !== task.companyId || t.status !== 'in_progress' || t.id === task.id) continue
    if (t.runId) inFlight++
  }
  const startsAnyway = startsWithoutAutopilot({ source: task.source, status: task.status, pendingWake: task.pendingWake ?? null, plan: task.plan ?? null, ask: task.ask ?? null, handoffs: task.handoffs ?? 0 })
  const r = queuedReason({
    task,
    agent: seat ? { name: seat.name, archivedAt: seat.archivedAt, pausedAt: agentActive(seat) ? null : (seat.pausedAt ?? 'paused'), data: seat.data } : null,
    company: company ? { name: company.name, autopilot: company.autopilot, pausedAt: company.pausedAt ?? null, maxInFlight: company.maxInFlight } : null,
    depsOpen,
    inFlight,
    startsAnyway,
    runLabel
  })
  return `${r.text}\u0000${r.canRun ? 1 : 0}`
}

/** A Forum message's card (Chats conversations, Forum channels). */
export function TaskCard({ m }: { m: ForumMessage }): React.JSX.Element | null {
  return m.task ? <TaskCardView card={m.task} companyId={m.companyId} channelId={m.channelId} /> : null
}

/**
 * The live card for one task: a conversation's card message, or a chat's company_file_task / task_create call.
 * `dock`: the compact card of the dock above a conversation's composer (CHAT-UI.md §8.5): one head line with the
 * state and clock, the 1–2 latest activity lines, its links; Show logs opens the log above it, capped and scrollable.
 */
export function TaskCardView({ card: stored, companyId, channelId, dock = false, onClose }: { card: ForumTaskCard; companyId?: Id | null; channelId?: Id | null; dock?: boolean; onClose?: () => void }): React.JSX.Element | null {
  const card: ForumTaskCard | undefined = stored
  const task = useStore((s) => (card ? (s.tasks.find((t) => t.id === card.taskId) ?? null) : null))
  const runId = task?.runId ?? card?.runId ?? null
  const root = useStore((s) => (runId ? rootOfRun(Object.values(s.agents), runId) : null))
  const slotWaitSince = useStore((s) => (runId ? (s.slotWaits[runId] ?? null) : null))
  const ask = useStore((s) => (runId ? openAskOfRun(Object.values(s.asks), runId) : null))
  const co = companyId ?? task?.companyId ?? null
  const code = useStore((s) => (co ? reposOf(s.repos, co).length > 0 : true))
  const seat = useStore((s) => (card ? s.companyAgents.find((a) => a.id === (task?.agentId ?? card.agentId)) : undefined))
  const display = useAgentDisplay()(seat)
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
  const v = taskCardView(card, task, { root, ask, code, now, slotWaitSince })
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
  const answer =
    v.state === 'needs_you' && v.needs && !v.needs.live && task?.ask && !task.ask.answer
      ? () => {
          // the question is the filer's message here: answer it from the composer, like any reply
          if (card.askMessageId && channelId) askReply({ channelId, messageId: card.askMessageId, identifier: card.identifier })
          else if (co) openBoard(co, { taskId: card.taskId })
        }
      : null
  if (dock)
    return (
      <div className={`cx-task cx-task--dock is-${v.state} ${logOpen ? 'is-open' : ''}`} data-chatux="task-dock-card" data-state={v.state} data-task={card.identifier} data-dock-task={card.identifier} role="group" aria-label={`${card.identifier}: ${card.title}, ${v.label}`}>
        {logOpen && logAgent && v.runId && <TaskLog agentId={logAgent.id} runId={v.runId} stepId={logAgent.stepId} live={rootLive} />}
        <div className={`cx-task__head ${logAgent ? 'is-toggle' : ''}`} onClick={toggleLog}>
          <span className="cx-task__face" aria-hidden>
            <AgentFace persona={display?.persona ?? null} label={display?.role || seat?.name || who} color={null} size={18} />
          </span>
          <span className="cx-task__id">{card.identifier}</span>
          <span className="cx-task__title" title={card.title}>
            {card.title}
          </span>
          <span className="cx-task__who">{who}</span>
          <span className="flex1" />
          <span className={`cx-task__state is-${v.state}`} data-chatux="task-state">
            <span className="cx-task__mark" aria-hidden />
            <span className={v.state === 'working' && !v.slotWait ? 'shimmer-text' : ''}>{v.label}</span>
          </span>
          <span className="cx-task__sep">·</span>
          {v.state === 'working' ? (
            <WorkClock since={v.since} />
          ) : (
            <span className="cx-task__age" title="Since it started">
              {v.elapsed}
            </span>
          )}
        </div>
        <div className="cx-task__dockrow">
          {v.slotWait ? (
            <span className="cx-task__activity cx-task__why cx-task__dockline" data-chatux="task-slot-wait" title={SLOT_WAIT_WHY}>
              {SLOT_WAIT_LINE}
            </span>
          ) : v.state === 'working' ? (
            !logOpen && (logAgent ? <TaskTail agentId={logAgent.id} code={code} fallback={v.activity ?? 'Working…'} n={2} /> : <div className="cx-task__tail"><div className="cx-task__tl"><span className="cx-task__tl-glyph" aria-hidden>●</span><span className="cx-task__tl-text shimmer-text">Starting…</span></div></div>)
          ) : v.state === 'needs_you' ? (
            <span className="cx-task__activity cx-task__dockline" data-chatux="task-needs" title={v.needs?.prompt}>
              {v.needs?.prompt}
            </span>
          ) : (
            <span className="cx-task__activity cx-task__why cx-task__dockline" data-chatux="task-why" title={queueText}>
              {queueText}
            </span>
          )}
          <span className="flex1" />
          <span className="cx-task__docklinks">
            {canRun && (
              <Button size="sm" variant="primary" icon="play" disabled={busy} data-chatux="task-run" onClick={() => void runNow()}>
                {runLabel}
              </Button>
            )}
            {v.needs?.live && (
              <Button size="sm" variant="primary" data-chatux="task-approve" onClick={() => watch(v.runId, card.taskId)}>
                Answer it
              </Button>
            )}
            {answer && (
              <Button size="sm" variant="primary" data-chatux="task-answer" title={card.askMessageId && channelId ? 'Answer in the conversation' : 'Answer on the board'} onClick={answer}>
                Answer
              </Button>
            )}
            {logAgent && (
              <button type="button" className="link-btn cx-task__link" data-chatux="task-logs" aria-expanded={logOpen} onClick={toggleLog}>
                {logOpen ? 'Hide logs' : 'Show logs'}
              </button>
            )}
            {v.runId && (
              <button type="button" className="link-btn cx-task__link" data-chatux="task-watch" onClick={() => watch(v.runId, card.taskId)}>
                Watch
              </button>
            )}
            {v.onBoard && (
              <button type="button" className="link-btn cx-task__link" data-chatux="task-open" onClick={() => co && openBoard(co, { taskId: card.taskId })}>
                Open task
              </button>
            )}
            {onClose && <IconButton icon="close" label="Close it here (it comes back when the task moves on)" className="cx-task__close" data-chatux="task-dock-close" onClick={onClose} />}
          </span>
        </div>
        {runError && (
          <div className="cx-task__error" role="alert" data-chatux="task-run-error">
            {runError}
          </div>
        )}
      </div>
    )
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
          <span className={v.state === 'working' && !v.slotWait ? 'shimmer-text' : ''}>{v.label}</span>
        </span>
      </div>
      <div className="cx-task__line">
        <span className="cx-task__who">{who}</span>
        <span className="cx-task__sep">·</span>
        {v.state === 'working' ? (
          <>
            {v.slotWait ? (
              <span className="cx-task__activity cx-task__why" data-chatux="task-slot-wait" title={SLOT_WAIT_WHY}>
                {SLOT_WAIT_LINE}
              </span>
            ) : (
              <span className="cx-task__activity shimmer-text" data-chatux="task-activity">
                {logAgent ? 'Working' : 'Starting'}
              </span>
            )}
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
              <span className="cx-task__activity" data-chatux="task-needs" title={v.needs?.prompt}>
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
      {v.state === 'working' && !v.slotWait && !logOpen && (logAgent ? <TaskTail agentId={logAgent.id} code={code} fallback={v.activity ?? 'Working…'} /> : <div className="cx-task__tail"><div className="cx-task__tl"><span className="cx-task__tl-glyph" aria-hidden>●</span><span className="cx-task__tl-text shimmer-text">Starting…</span></div></div>)}
      {logOpen && logAgent && v.runId && <TaskLog agentId={logAgent.id} runId={v.runId} stepId={logAgent.stepId} live={rootLive} />}
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
          <Button size="sm" variant="primary" data-chatux="task-approve" onClick={() => watch(v.runId, card.taskId)}>
            Answer it
          </Button>
        )}
        {answer && (
          <Button size="sm" variant="primary" data-chatux="task-answer" title={card.askMessageId && channelId ? 'Answer in the conversation' : 'Answer on the board'} onClick={answer}>
            Answer
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
          <button type="button" className="link-btn cx-task__link" data-chatux="task-watch" onClick={() => watch(v.runId, card.taskId)}>
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
export function WorkingStrip({ msgs, cards, dock = false }: { msgs?: readonly ForumMessage[]; cards?: readonly ForumTaskCard[]; dock?: boolean }): React.JSX.Element | null {
  const tasks = useStore((s) => s.tasks)
  const [open, setOpen] = useState(false)
  const list = useMemo(() => cards ?? cardsOfMessages(msgs ?? []), [cards, msgs])
  const items = useStripItems(list)
  const anyOpen = items.some((t) => t.state === 'queued' || t.state === 'working' || t.state === 'needs_you')
  const now = useNow(anyOpen)
  const strip = workingStrip(items, now)
  if (!strip) return null
  const runOf = (t: StripTask): Id | null => tasks.find((x) => x.id === t.taskId)?.runId ?? null
  const focusRun = runOf(strip.focus)
  const many = strip.tasks.length > 1
  // "VO-15 needs you · Julia is waiting": the line goes to Julia's question in the conversation
  const askOf = (t: StripTask): string | null => (t.state === 'needs_you' ? (list.find((c) => c.taskId === t.taskId)?.askMessageId ?? null) : null)
  const focusAsk = !many ? askOf(strip.focus) : null
  // a conversation docks its open tasks above the composer: the line marks the docked card (CHAT-UI.md §8.5)
  const focusDock = !many && !focusAsk && dock
  return (
    <div className={`cx-strip ${strip.focus.state === 'needs_you' ? 'is-needs' : ''}`} data-chatux="working-strip" data-state={strip.focus.state} role="status">
      <div className="cx-strip__row">
        <span className={`cx-strip__mark is-${strip.focus.state}`} aria-hidden />
        <button
          type="button"
          className={`cx-strip__line ${strip.focus.state === 'working' ? 'shimmer-text' : ''} ${focusAsk || focusDock ? 'is-link' : ''}`}
          aria-expanded={many ? open : undefined}
          disabled={!many && !focusAsk && !focusDock}
          title={focusAsk ? 'Go to the question' : focusDock ? 'Show it above the reply box' : undefined}
          onClick={() => (focusAsk ? void jumpToMessage(focusAsk) : focusDock ? void jumpToDockedTask(strip.focus.identifier) : setOpen((o) => !o))}
          data-chatux="working-strip-line"
        >
          {strip.line}
          {many && <span className="cx-strip__chev">{open ? ' ▴' : ' ▾'}</span>}
        </button>
        <span className="flex1" />
        {!many && focusRun && (
          <button type="button" className="link-btn" data-chatux="working-strip-watch" onClick={() => watch(focusRun, strip.focus.taskId)}>
            Watch
          </button>
        )}
      </div>
      {many && open && (
        <ul className="cx-strip__list">
          {strip.tasks.map((t) => (
            <li key={t.taskId} className="cx-strip__item">
              <span className={`cx-strip__mark is-${t.state}`} aria-hidden />
              {dock ? (
                <button type="button" className="link-btn cx-strip__id" data-chatux="working-strip-dock" title="Show it above the reply box" onClick={() => void jumpToDockedTask(t.identifier)}>
                  {t.identifier}
                </button>
              ) : (
                <span className="cx-strip__id">{t.identifier}</span>
              )}
              <span className="cx-strip__who">{t.who ?? 'Nobody yet'}</span>
              <span className="cx-strip__who">· {stripWord(t.state, !!t.slotWait)}</span>
              <span className="flex1" />
              {askOf(t) && (
                <button type="button" className="link-btn" data-chatux="working-strip-question" onClick={() => void jumpToMessage(askOf(t)!)}>
                  See the question
                </button>
              )}
              {runOf(t) && (
                <button type="button" className="link-btn" onClick={() => watch(runOf(t), t.taskId)}>
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

/** The live state of each card (the strip's and the dock's): the board task, its open asks, its run's start. */
export function useStripItems(list: readonly ForumTaskCard[]): StripTask[] {
  const tasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const seats = useStore((s) => s.companyAgents)
  const agentDisplay = useAgentDisplay()
  const runIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of list) {
      const r = tasks.find((t) => t.id === c.taskId)?.runId ?? c.runId
      if (r) ids.add(r)
    }
    return ids
  }, [list, tasks])
  const starts = useStore((s) => runStartsKey(Object.values(s.agents), runIds))
  const slotWaits = useStore((s) => s.slotWaits)
  const items = useMemo(() => {
    const who = (agentId: string | null): string | null => {
      const seat = agentId ? seats.find((a) => a.id === agentId) : undefined
      return seat ? (agentDisplay(seat)?.name ?? seat.name) : null
    }
    const since = parseRunStarts(starts)
    return stripTasks(list, tasks, who, openAskRuns(asks), (r) => since.get(r) ?? null, (r) => slotWaits[r] ?? null)
  }, [list, tasks, seats, agentDisplay, asks, starts, slotWaits])
  return items
}

/** The history's card while its task is docked: one line that points at the dock ("VO-15 · working · see below"). */
export function TaskCardRef({ card, state }: { card: ForumTaskCard; state: TaskCardState }): React.JSX.Element {
  const slotWait = useStore((s) => {
    const runId = s.tasks.find((t) => t.id === card.taskId)?.runId ?? card.runId
    return runId ? !!s.slotWaits[runId] : false
  })
  return (
    <button type="button" className={`cx-taskref is-${state}`} data-chatux="task-card-ref" data-state={state} data-task={card.identifier} title={`${card.title} · show it above the reply box`} onClick={() => void jumpToDockedTask(card.identifier)}>
      <span className={`cx-strip__mark is-${state}`} aria-hidden />
      <span className="cx-taskref__line">{dockRefLine(card.identifier, state, slotWait)}</span>
      <span className="cx-taskref__title">{card.title}</span>
    </button>
  )
}

/**
 * The dock above a conversation's composer (CHAT-UI.md §8.5): the compact live card of each task filed here that is
 * queued, working or needs you; at most two, then "+N more". A task that came back fades out of it. With more than
 * one card, a summary line on top ("2 need you · 1 working ▾") folds the dock to that one line; × closes a card here.
 */
export function TaskDock({ items, cards, companyId, channelId, prefs }: { items: readonly StripTask[]; cards: readonly ForumTaskCard[]; companyId: Id; channelId: Id; prefs: DockControls }): React.JSX.Element | null {
  const { docked: all, shown: docked, hidden, markOf } = useDockView(items, cards, prefs)
  const [expanded, setExpanded] = useState(false)
  const [leaving, setLeaving] = useState<StripTask[]>([])
  const prev = useRef<StripTask[]>(all)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const ids = all.map((t) => t.taskId).join(',')
  useEffect(() => {
    // only a task that came back fades out; one closed with × just goes
    const here = new Set(all.map((t) => t.taskId))
    const gone = prev.current.filter((t) => !here.has(t.taskId) && !(prefs.closed[t.taskId] === markOf(t)))
    prev.current = all
    if (!gone.length) return
    const goneIds = new Set(gone.map((t) => t.taskId))
    setLeaving((l) => [...l.filter((x) => !goneIds.has(x.taskId)), ...gone])
    timers.current.push(setTimeout(() => setLeaving((l) => l.filter((x) => !goneIds.has(x.taskId))), 600))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  // the strip's line or a history reference asks for a card that is folded away or closed: open it again
  useEffect(() => {
    const on = (e: Event): void => {
      const t = all.find((x) => x.identifier === (e as CustomEvent<string>).detail)
      if (!t) return
      if (prefs.collapsed) prefs.setCollapsed(false)
      if (hidden.some((h) => h.taskId === t.taskId)) prefs.reopen(t.taskId)
      setExpanded(true)
    }
    window.addEventListener(DOCK_REVEAL_EVENT, on)
    return () => window.removeEventListener(DOCK_REVEAL_EVENT, on)
  }, [all, hidden, prefs])
  const { shown, more } = dockRows(docked, expanded)
  const fading = leaving.filter((t) => !all.some((d) => d.taskId === t.taskId))
  if (!all.length && !fading.length) return null
  const cardOf = (taskId: string): ForumTaskCard | undefined => cards.find((c) => c.taskId === taskId)
  const folded = prefs.collapsed && docked.length > 0
  // one card needs no summary line: its × is enough; the line shows once there is something to fold or bring back
  const bar = docked.length > 1 || folded || hidden.length > 0
  return (
    <div className={`cx-dock ${folded ? 'is-folded' : ''}`} data-chatux="task-dock" aria-label="Work in progress from this conversation">
      {bar && (
        <div className="cx-dock__bar" data-chatux="task-dock-bar">
          {docked.length > 0 && (
            <button type="button" className="link-btn cx-dock__toggle" data-chatux="task-dock-toggle" aria-expanded={!folded} title={folded ? 'Show the cards' : 'Fold to one line'} onClick={() => prefs.setCollapsed(!folded)}>
              <span className={`cx-strip__mark is-${docked.some((t) => t.state === 'needs_you') ? 'needs_you' : docked.some((t) => t.state === 'working') ? 'working' : 'queued'}`} aria-hidden />
              <span>{dockSummary(docked)}</span>
              <span className="cx-dock__chev" aria-hidden>
                {folded ? '▸' : '▾'}
              </span>
            </button>
          )}
          <span className="flex1" />
          {!folded && (more > 0 || (expanded && docked.length > DOCK_VISIBLE)) && (
            <button type="button" className="link-btn cx-dock__more" data-chatux="task-dock-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show fewer' : `+${more} more`}
            </button>
          )}
          {hidden.length > 0 && (
            <button type="button" className="link-btn cx-dock__more" data-chatux="task-dock-reopen" title={hidden.map((t) => t.identifier).join(', ')} onClick={() => prefs.reopen()}>
              {`Show ${hidden.length} closed`}
            </button>
          )}
        </div>
      )}
      {!folded &&
        fading.map((t) => {
          const c = cardOf(t.taskId)
          return c ? (
            <div key={t.taskId} className="cx-dock__item is-leaving" aria-hidden>
              <TaskCardView card={c} companyId={companyId} channelId={channelId} dock />
            </div>
          ) : null
        })}
      {!folded &&
        shown.map((t) => {
          const c = cardOf(t.taskId)
          return c ? (
            <div key={t.taskId} className="cx-dock__item">
              <TaskCardView card={c} companyId={companyId} channelId={channelId} dock onClose={() => prefs.close(t.taskId, markOf(t))} />
            </div>
          ) : null
        })}
    </div>
  )
}
