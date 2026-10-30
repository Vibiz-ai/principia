/**
 * CHAT-UI.md §8.4: a task is a chat (`task:<id>` in Chats), the subagent of the conversation that filed it. The
 * header names who and what ("Julia · VO-15 Check why…"), "Working · 4m 12s", Pause, Open task and "From: <the
 * conversation>" back to its parent. The body is a conversation thread (lib/taskThread.ts): the brief as the first
 * message, what the agent says and thinks as bubbles, its tool calls folded between them into one line ("Ran 6
 * commands · read 3 files · checked memory", a click opens each call in words and the raw call under it), its
 * questions, your notes. At the bottom a composer: "Add a note for Julia…" posts a task comment (tasks:comment) that
 * shows in the thread at once and reaches the agent through the task's wake, the same inbox teammates' messages use
 * (picked up as soon as the running turn ends); with an open question, Send answers it (tasks:answer).
 * Full log opens the run's Activity / Output (TaskLog), unchanged.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '@shared/live'
import type { TaskActivity, TaskDetail } from '@shared/company'
import type { Id } from '@shared/types'
import { SLOT_WAIT_LABEL, SLOT_WAIT_LINE, SLOT_WAIT_WHY, TASK_CARD_LABEL, isFinishedCard, taskCardResult, taskCardState } from '@shared/taskCard'
import { Button, EmptyState, Toolbar } from '../ui'
import { Icon } from '../Icon'
import { BrowserToggle } from '../browser/BrowserToggle'
import { taskScope } from '@shared/browser'
import { AskCard } from '../agents/AskCard'
import { AgentGlyph } from '../agents/AgentBits'
import { AgentBust } from '../../shell/DepartmentGroup'
import { useAgentDisplay } from '../board/NeedsYouTasks'
import { TaskLog, WorkClock } from '../conversations/TaskCard'
import { Bubble, openConversation } from '../conversations/ConversationKit'
import { MarkdownLite } from '../diagrams/MarkdownLite'
import { pauseTask, useIsCode } from '../desk/Desk'
import { openAskOfRun, rootOfRun } from '../../lib/taskCardView'
import { plainActivity } from '../../lib/plainActivity'
import { taskName } from '../../lib/desk'
import { durationMs } from '../../lib/time'
import { eventDurations } from '../../lib/live'
import { noteHint, taskThread, toolWords, type ThreadItem } from '../../lib/taskThread'
import { focusAgent, mergeAgents, useAgentEvents } from '../../state/live'
import { useForum } from '../../state/forum'
import { useForumLoaded } from '../../state/conversations'
import { errorMessage, hive } from '../../lib/hive'
import { attempt, markTaskSeen, openBoard, toast, useStore } from '../../state/store'
import '../../styles/conversations.css'
import '../../styles/desk.css'

export function TaskLiveView({ taskId }: { taskId: Id }): React.JSX.Element {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null)
  const seat = useStore((s) => (task?.agentId ? s.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined))
  const runId = task?.runId ?? null
  const root = useStore((s) => (runId ? rootOfRun(Object.values(s.agents), runId) : null))
  const slotWaitSince = useStore((s) => (runId ? (s.slotWaits[runId] ?? null) : null))
  const ask = useStore((s) => (runId ? openAskOfRun(Object.values(s.asks), runId) : null))
  const code = useIsCode(task?.companyId)
  const display = useAgentDisplay()(seat)
  // the run's agents load on demand (opened from a link before the live snapshot has them)
  const hasRoot = !!root
  useEffect(() => {
    if (runId && !hasRoot) void hive.agents.list({ runId, rootsOnly: true, limit: 20 }).then(mergeAgents, () => undefined)
  }, [runId, hasRoot])
  // the parent conversation (CHAT-UI.md §8.6): "From: …" goes back to it
  useForumLoaded(task?.companyId ?? null)
  const parent = useForum((s) => {
    const st = task ? s.byCompany[task.companyId]?.state : null
    const ch = st?.taskChannels?.[taskId]
    const c = ch ? st?.channels.find((x) => x.id === ch) : undefined
    return c ? `${c.id}\u0000${c.topic || 'Conversation'}` : null
  })
  const [parentId, parentTitle] = parent ? parent.split('\u0000') : [null, null]
  // the task's activity (comments, reports, questions): on open, on every change of the task, and every few seconds
  // while it works (an agent's task_comment does not move the task)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [mine, setMine] = useState<TaskActivity[]>([])
  const req = useRef(0)
  const reload = (): void => {
    const n = ++req.current
    void hive.tasks.get({ id: taskId }).then(
      (d) => {
        if (req.current !== n) return
        setDetail(d)
        // your notes the server now has replace their optimistic copies
        setMine((l) => l.filter((x) => !d.activity.some((a) => a.id === x.id || (a.kind === x.kind && a.by === 'human' && (a.message === x.message || Date.parse(a.createdAt) >= Date.parse(x.createdAt) - 5000)))))
      },
      () => undefined
    )
  }
  const working = !!task && task.status === 'in_progress'
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, task?.updatedAt, task?.status])
  useEffect(() => {
    if (!working) return
    const id = setInterval(reload, 8000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, working])
  // its news is read once its chat is open (CHAT-UI.md §8.6)
  useEffect(() => {
    if (task) markTaskSeen(task.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.updatedAt, task?.status])
  const rootId = root && root.runId === runId ? root.id : null
  const { events } = useAgentEvents(rootId)
  const who = display?.name ?? seat?.name ?? 'The agent'
  const activity = useMemo(() => [...(detail?.activity ?? []), ...mine], [detail, mine])
  const items = useMemo(() => (task ? taskThread({ task, activity, events, agentName: who, code }) : []), [task, activity, events, who, code])
  const [logOpen, setLogOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useEffect(() => {
    const el = body.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [items.length, logOpen])

  if (!task)
    return (
      <div className="view convo-view">
        <Toolbar title="Chats" />
        <div className="scroll view__body">
          <EmptyState icon="chat" text="That task is not on the board any more." />
        </div>
      </div>
    )
  const state = taskCardState({ status: task.status, blockReason: task.blockReason ?? null, ask: task.ask ?? null, runId: task.runId }, { openAsk: !!ask })
  const rootLive = !!root && (root.status === 'working' || root.status === 'starting' || root.status === 'needs_you')
  const isWorking = state === 'working'
  const slotWait = isWorking ? slotWaitSince : null
  // what it does this moment: the running call in its own words ("Run the scheduler tests"), else the live line
  const runningCall = [...events].reverse().find((e) => e.kind === 'tool' && e.state === 'running')
  const now = slotWait ? SLOT_WAIT_LINE : isWorking ? (rootLive ? (runningCall ? toolWords(runningCall, code) : (plainActivity(root!.activity, { code }) ?? 'Working…')) : 'Starting…') : null
  const result = taskCardResult({ report: task.report ?? null, doneNote: task.doneNote ?? null })
  const since = slotWait ?? root?.startedAt ?? task.updatedAt
  const question = state === 'needs_you' && task.ask && !task.ask.answer ? task.ask : null
  const face = seat ? <AgentBust agent={seat} size={26} /> : <AgentGlyph visual="running" />
  return (
    <div className="view convo-view task-live task-chat" data-chatux="task-live" data-state={state}>
      <Toolbar
        title={
          <span className="convo-title">
            {seat ? (
              <AgentBust agent={seat} size={24} className="convo-title__face" />
            ) : (
              <span className="convo-title__mark" aria-hidden>
                <AgentGlyph visual="running" />
              </span>
            )}
            <span className="convo-title__name">{who}</span>
            <span className="convo-title__role" title={taskName(task, code)}>
              · {taskName(task, code)}
            </span>
          </span>
        }
        sub={
          <span className="convo-title__sub task-live__state">
            <span className={`cx-strip__mark is-${state}`} aria-hidden />
            <span className={isWorking && !slotWait ? 'shimmer-text' : ''} title={slotWait ? SLOT_WAIT_WHY : undefined}>{slotWait ? SLOT_WAIT_LABEL : TASK_CARD_LABEL[state]}</span>
            {isWorking && (
              <>
                <span className="cx-task__sep">·</span>
                <WorkClock since={since} />
              </>
            )}
            {parentId && (
              <>
                <span className="cx-task__sep">·</span>
                <button type="button" className="link-btn task-chat__from" data-chatux="task-chat-from" onClick={() => openConversation(parentId)} title="Open the conversation this task was filed from">
                  From: {parentTitle}
                </button>
              </>
            )}
          </span>
        }
      >
        {task.status === 'in_progress' && task.runId && (
          <Button size="sm" icon="pause" onClick={() => void pauseTask(task)}>
            Pause
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openBoard(task.companyId, { taskId: task.id })}>
          Open task
        </Button>
        {/* BROWSER.md §6: this task's own browser tabs (the same across its wakes); they open beside it, never elsewhere */}
        <BrowserToggle companyId={task.companyId} scope={taskScope(task.id)} />
      </Toolbar>
      <div
        className="cx-thread__body scroll task-chat__body"
        ref={body}
        data-chatux="task-chat"
        onScroll={(e) => {
          const el = e.currentTarget
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {items.map((it, i) => (
          <ThreadRow key={it.key} it={it} head={startsRun(items, i)} who={who} role={display?.role ?? null} face={face} code={code} />
        ))}
        {ask && <AskCard ask={ask} onOpen={() => void focusAgent(ask.agentId, ask.id)} />}
        {question && (
          <Bubble mine={false} head face={face} who={who} role={display?.role ?? null} className="is-question" data={{ 'data-chatux': 'task-chat-question' }} after={question.options?.length ? <AnswerChips taskId={task.id} options={question.options} /> : null}>
            <MarkdownLite text={question.prompt} />
          </Bubble>
        )}
        {isFinishedCard(state) && (
          <div className="cx-handoff cx-handoff--small" data-chatux="task-chat-outcome">
            <span className={`cx-strip__mark is-${state}`} aria-hidden />
            <span>
              {TASK_CARD_LABEL[state]}
              {result ? ` · ${result}` : ''}
            </span>
          </div>
        )}
        {now && (
          <div className="cx-pending" data-chatux="task-live-activity" aria-live="polite">
            <span className="task-live__dot" aria-hidden />
            <span className={slotWait ? '' : 'shimmer-text'} title={slotWait ? SLOT_WAIT_WHY : undefined}>{now}</span>
          </div>
        )}
        {!rootId && isWorking && !slotWait && <div className="task-live__empty text-tertiary">{who} is starting on it…</div>}
        {rootId && runId && (
          <div className="task-chat__log">
            <button type="button" className="link-btn" data-chatux="task-chat-fulllog" onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}>
              {logOpen ? 'Hide the full log' : 'Full log'}
            </button>
            {logOpen && <TaskLog agentId={rootId} runId={runId} stepId={root!.stepId} live={rootLive} code={code} />}
          </div>
        )}
      </div>
      <TaskNoteComposer taskId={task.id} who={who} state={state} answers={!!question} onSent={(a) => { setMine((l) => [...l, a]); atEnd.current = true; reload() }} />
    </div>
  )
}

/** A bubble starts a group after a different speaker or anything that is not a bubble. */
function startsRun(items: readonly ThreadItem[], i: number): boolean {
  const it = items[i]!
  const prev = items[i - 1]
  if (it.kind !== 'say') return true
  return !prev || prev.kind !== 'say' || prev.by !== it.by
}

export function ThreadRow({ it, head, who, role, face, code }: { it: ThreadItem; head: boolean; who: string; role: string | null; face: React.ReactNode; code: boolean }): React.JSX.Element {
  if (it.kind === 'brief')
    return (
      <div className="task-chat__brief" data-chatux="task-chat-brief">
        <div className="task-chat__brief-label">The task</div>
        <MarkdownLite text={it.text} />
      </div>
    )
  if (it.kind === 'note')
    return (
      <div className="cx-handoff cx-handoff--small" data-chatux="task-chat-note">
        <span className="cx-handoff__mark" aria-hidden>
          ◆
        </span>
        <span>{it.text}</span>
      </div>
    )
  if (it.kind === 'tools') return <ToolGroup it={it} code={code} />
  return (
    <Bubble mine={it.by === 'you'} head={head} face={face} who={who} role={role} at={it.at} className={`${it.thought ? 'is-thought' : ''} ${it.question ? 'is-question' : ''}`} data={{ 'data-chatux': 'task-chat-msg', 'data-by': it.by, ...(it.thought ? { 'data-thought': '1' } : {}) }}>
      <MarkdownLite text={it.text} />
    </Bubble>
  )
}

/** "Ran 6 commands · read 3 files · checked memory", folded; open: each call in words, its raw call one click further. */
function ToolGroup({ it, code }: { it: Extract<ThreadItem, { kind: 'tools' }>; code: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const durs = useMemo(() => eventDurations(it.events), [it.events])
  const failed = it.events.filter((e) => e.state === 'error' || e.state === 'denied').length
  return (
    <div className={`task-chat__tools ${open ? 'is-open' : ''}`} data-chatux="task-chat-tools" data-count={it.events.length}>
      <button type="button" className="task-chat__tools-head" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Fold' : 'Show each step'}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        <span className={`task-chat__tools-label ${it.running ? 'shimmer-text' : ''}`} data-chatux="task-chat-tools-label">
          {it.label}
        </span>
        {it.events.length > 1 && <span className="task-chat__tools-n">{it.events.length} steps</span>}
        {failed > 0 && <span className="task-chat__tools-n text-failed">{failed} failed</span>}
      </button>
      {open && (
        <div className="task-chat__steps">
          {it.events.map((e) => (
            <ToolStep key={e.seq} e={e} dur={durs.get(e.seq)} code={code} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolStep({ e, dur, code }: { e: AgentEvent; dur: number | undefined; code: boolean }): React.JSX.Element {
  const [raw, setRaw] = useState(false)
  const words = toolWords(e, code)
  const call = [e.name, e.summary].filter(Boolean).join(' · ')
  return (
    <div className={`task-chat__step ${e.state ? `is-${e.state}` : ''}`} data-chatux="task-chat-step">
      <button type="button" className="task-chat__step-head" onClick={() => setRaw(!raw)} aria-expanded={raw} title="Show the raw call">
        <span className="task-chat__step-words">{words}</span>
        {e.state === 'running' && <span className="task-live__dot" aria-hidden />}
        {(e.state === 'error' || e.state === 'denied') && <span className="text-failed">{e.state === 'denied' ? 'denied' : 'failed'}</span>}
        {dur !== undefined && <span className="task-chat__step-dur">{durationMs(dur)}</span>}
      </button>
      {raw && <pre className="tl__detail selectable">{[call, e.detail && e.detail !== e.summary ? e.detail : null].filter(Boolean).join('\n\n')}</pre>}
    </div>
  )
}

/**
 * Sends the composer's text: a task comment by you (tasks:comment), which the dispatcher turns into the task's wake
 * (coalesced while the run works: the agent gets it as soon as the turn ends), or, with an open question, the answer
 * (tasks:answer). Returns the activity row to show at once.
 */
export async function sendTaskNote(taskId: Id, text: string, answers: boolean): Promise<TaskActivity> {
  const t = text.trim()
  if (answers) {
    await hive.tasks.answer({ id: taskId, answer: t })
    return { id: `local-${Date.now()}`, taskId, kind: 'answered', message: t, createdAt: new Date().toISOString(), by: 'human' }
  }
  return hive.tasks.comment({ id: taskId, message: t, by: 'human' })
}

/** The question's options as quick answers (tasks:answer). */
function AnswerChips({ taskId, options }: { taskId: Id; options: readonly string[] }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="cx-task__answers" data-chatux="task-chat-answers">
      {options.map((o) => (
        <Button key={o} size="sm" disabled={busy} onClick={() => { setBusy(true); void attempt(() => hive.tasks.answer({ id: taskId, answer: o }), 'Answer').finally(() => setBusy(false)) }}>
          {o}
        </Button>
      ))}
    </div>
  )
}

/**
 * "Add a note for Julia…": a task comment (tasks:comment, by you) that is in the thread at once and reaches the agent
 * through the task's wake (lib/taskThread.ts noteHint says when). With an open question it is the answer.
 */
function TaskNoteComposer({ taskId, who, state, answers, onSent }: { taskId: Id; who: string; state: ReturnType<typeof taskCardState>; answers: boolean; onSent: (a: TaskActivity) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  // PR-48: Home's Answer lands here; with an open question the cursor is already in the answer box
  useEffect(() => {
    if (answers) input.current?.focus()
  }, [taskId, answers])
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      onSent(await sendTaskNote(taskId, t, answers))
      setText('')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }
  return (
    <form
      className="cx-thread__reply"
      data-chatux="task-chat-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <textarea
        ref={input}
        className="cx-composer__input"
        data-chatux="task-chat-input"
        rows={1}
        value={text}
        disabled={busy}
        maxLength={8000}
        placeholder={answers ? `Answer ${who}…` : `Add a note for ${who}…`}
        aria-label={answers ? `Answer ${who}` : `Add a note for ${who}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="cx-composer__foot">
        <span className="cx-routeline cx-routeline--static" data-chatux="task-chat-hint">
          {noteHint(who, state, { answers })}
        </span>
        <span className="flex1" />
        <Button type="submit" size="sm" variant="primary" icon="send" data-chatux="task-chat-send" disabled={busy || !text.trim()} aria-label="Send" />
      </div>
    </form>
  )
}
