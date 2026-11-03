/**
 * CHAT-UI.md §8.4: a task is a chat (`task:<id>` in Chats), the subagent of the conversation that filed it. The
 * header names who and what ("Julia · VO-15 Check why…"), "Working · 4m 12s", Pause, Open task and "From: <the
 * conversation>" back to its parent. The body is the same chat as a chat with Claude (CHAT-UI.md §9): the thread
 * (lib/taskThread.ts) becomes chat items, drawn by ChatCards with the chat's Composer. The brief is the first
 * message, then what the agent says, its tool rows, its questions, your notes. At the bottom the composer: "Add a note for Julia…" posts a task comment (tasks:comment) that
 * shows in the thread at once and reaches the agent through the task's wake, the same inbox teammates' messages use
 * (picked up as soon as the running turn ends); with an open question, Send answers it (tasks:answer).
 * Full log opens the run's Activity / Output (TaskLog), unchanged.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_CHAT_META } from '@shared/chat'
import { buildBlocks } from '@shared/chatView'
import type { TaskActivity, TaskDetail } from '@shared/company'
import type { Id } from '@shared/types'
import { SLOT_WAIT_LABEL, SLOT_WAIT_LINE, SLOT_WAIT_WHY, TASK_CARD_LABEL, isFinishedCard, taskCardResult, taskCardState } from '@shared/taskCard'
import { Button, EmptyState, Toolbar } from '../ui'
import { Blocks, ChatWho } from '../chat/ChatCards'
import { Composer } from '../chat/Composer'
import { BrowserToggle } from '../browser/BrowserToggle'
import { taskScope } from '@shared/browser'
import { AskCard } from '../agents/AskCard'
import { AgentGlyph } from '../agents/AgentBits'
import { AgentBust } from '../../shell/DepartmentGroup'
import { useAgentDisplay } from '../board/NeedsYouTasks'
import { TaskLog, WorkClock } from '../conversations/TaskCard'
import { openConversation } from '../conversations/ConversationKit'
import { MarkdownLite } from '../diagrams/MarkdownLite'
import { pauseTask, useIsCode } from '../desk/Desk'
import { chatIdOfTask, chatTarget, openAskOfRun, rootOfChat, rootOfRun } from '../../lib/taskCardView'
import { plainActivity } from '../../lib/plainActivity'
import { taskName } from '../../lib/desk'
import { stampsFor } from '../../lib/agentChatView'
import { noteHint, taskChatItems, taskThread, toolWords } from '../../lib/taskThread'
import { focusAgent, mergeAgents, useAgentEvents } from '../../state/live'
import { useForum } from '../../state/forum'
import { useForumLoaded } from '../../state/conversations'
import { errorMessage, hive } from '../../lib/hive'
import { attempt, markTaskSeen, navigate, openBoard, toast, useStore } from '../../state/store'
import '../../styles/conversations.css'
import '../../styles/desk.css'

export function TaskLiveView({ taskId }: { taskId: Id }): React.JSX.Element {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null)
  const seat = useStore((s) => (task?.agentId ? s.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined))
  const runId = task?.runId ?? null
  // PR-100: a chat's own tracked task: its run id is the chat's session, and its progress is that chat's
  const chatId = useStore((s) => chatIdOfTask(task, s.sessions))
  const chat = useStore((s) => (chatId ? (s.sessions.find((x) => x.id === chatId) ?? null) : null))
  const root = useStore((s) => (chatId ? rootOfChat(Object.values(s.agents), chatId) : runId ? rootOfRun(Object.values(s.agents), runId) : null))
  const slotWaitSince = useStore((s) => (runId ? (s.slotWaits[runId] ?? null) : null))
  const ask = useStore((s) => (runId ? openAskOfRun(Object.values(s.asks), runId) : null))
  const code = useIsCode(task?.companyId)
  const display = useAgentDisplay()(seat)
  // the run's agents load on demand (opened from a link before the live snapshot has them)
  const hasRoot = !!root
  useEffect(() => {
    if (runId && !hasRoot) void hive.agents.list({ ...(chatId ? { sessionId: chatId } : { runId }), rootsOnly: true, limit: 20 }).then(mergeAgents, () => undefined)
  }, [runId, chatId, hasRoot])
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
  const rootId = root && (chatId ? root.sessionId === chatId : root.runId === runId) ? root.id : null
  const { events } = useAgentEvents(rootId)
  const who = display?.name ?? seat?.name ?? 'The agent'
  const activity = useMemo(() => [...(detail?.activity ?? []), ...mine], [detail, mine])
  const items = useMemo(() => (task ? taskThread({ task, activity, events, agentName: who, code }) : []), [task, activity, events, who, code])
  const blocks = useMemo(() => buildBlocks(taskChatItems(items, code)), [items, code])
  const stamps = useMemo(() => stampsFor(blocks), [blocks])
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
  const now = slotWait ? SLOT_WAIT_LINE : isWorking ? (rootLive ? (runningCall ? toolWords(runningCall, code) : (plainActivity(root!.activity, { code }) ?? 'Working…')) : chatId ? null : 'Starting…') : null
  const result = taskCardResult({ report: task.report ?? null, doneNote: task.doneNote ?? null })
  const since = slotWait ?? root?.startedAt ?? task.updatedAt
  const question = state === 'needs_you' && task.ask && !task.ask.answer ? task.ask : null
  return (
    <div className="view convo-view" data-chatux="task-live" data-state={state}>
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
            {/* CHAT-UI.md §9: an agent is its name; a task with nobody on it keeps its title */}
            <span className="convo-title__name">{seat ? who : taskName(task, code)}</span>
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
        {task.status === 'in_progress' && task.runId && !chatId && (
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
      <div className="convo">
        <section className="convo__chat" aria-label={`Chat with ${who}`}>
          <div className="agent-chat">
            <ChatWho.Provider value={who}>
              <div className="chat-pane" data-turn={isWorking ? 'working' : 'idle'}>
                <div
                  className="chat-scroll"
                  ref={body}
                  onScroll={(e) => {
                    const el = e.currentTarget
                    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                  }}
                >
                  <div className="chat-col" data-chatux="task-chat">
                    <Blocks blocks={blocks} live={isWorking} actions={null} stamps={stamps} />
                    {ask && <AskCard ask={ask} onOpen={() => void focusAgent(ask.agentId, ask.id)} />}
                    {question && (
                      <div className="chat-text" data-chatux="task-chat-question">
                        <MarkdownLite text={question.prompt} />
                        {question.options?.length ? <AnswerChips taskId={task.id} options={question.options} /> : null}
                      </div>
                    )}
                    {isFinishedCard(state) && (
                      <div className="chat-notice" data-chatux="task-chat-outcome">
                        {TASK_CARD_LABEL[state]}
                        {result ? ` · ${result}` : ''}
                      </div>
                    )}
                    {now && (
                      <div className="chat-working" data-chatux="task-live-activity" aria-live="polite">
                        <span className="chat-spin" aria-hidden />
                        <span className={slotWait ? '' : 'shimmer-text'} title={slotWait ? SLOT_WAIT_WHY : undefined}>{now}</span>
                      </div>
                    )}
                    {chatId && !isFinishedCard(state) && (
                      <div className="chat-notice" data-chatux="task-in-chat">
                        Being worked on in chat{' '}
                        <button type="button" className="link-btn" data-chatux="task-open-chat" onClick={() => void navigate({ name: 'chats', filter: 'all', chat: chatTarget(chatId, chat) })} title="Open the chat working on this task">
                          {chat?.title || 'this task came from'}
                        </button>
                      </div>
                    )}
                    {!rootId && !chatId && isWorking && !slotWait && (
                      <div className="chat-working">
                        <span className="chat-spin" aria-hidden />
                        <span className="shimmer-text">{who} is starting on it…</span>
                      </div>
                    )}
                    {rootId && runId && !chatId && (
                      <div className="task-chat__log">
                        <button type="button" className="link-btn" data-chatux="task-chat-fulllog" onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}>
                          {logOpen ? 'Hide the full log' : 'Full log'}
                        </button>
                        {logOpen && <TaskLog agentId={rootId} runId={runId} stepId={root!.stepId} live={rootLive} code={code} />}
                      </div>
                    )}
                  </div>
                </div>
                <div className="chat-dock" data-chatux="task-chat-composer">
                  <Composer
                    sessionId={`task:${task.id}`}
                    turn="idle"
                    meta={EMPTY_CHAT_META}
                    disabled={false}
                    exited={false}
                    focused={!!question}
                    who={who}
                    note={{ placeholder: question ? `Answer ${who}…` : `Add a note for ${who}…` }}
                    onSend={async (text) => {
                      try {
                        const a = await sendTaskNote(task.id, text, !!question)
                        setMine((l) => [...l, a])
                        atEnd.current = true
                        reload()
                        return true
                      } catch (e) {
                        toast(errorMessage(e), 'error')
                        return false
                      }
                    }}
                    onStop={() => undefined}
                    onTerminal={() => toast(`${who} works in the background: open the session from Open task`)}
                    onSetMode={() => undefined}
                    onSetModel={() => undefined}
                  />
                  <div className="task-chat__hint" data-chatux="task-chat-hint">
                    {noteHint(who, state, { answers: !!question })}
                  </div>
                </div>
              </div>
            </ChatWho.Provider>
          </div>
        </section>
      </div>
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
