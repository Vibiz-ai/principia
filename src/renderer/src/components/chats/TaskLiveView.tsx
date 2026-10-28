/**
 * CHAT-UI.md §8.4: a task at work, watched in Chats (`task:<id>`). Every LIVE entry opens this, never the agent's
 * resting chat: the header names who and what ("Julia · VO-15 Check why…", "Working · 4m 12s", Pause / Open task),
 * the line under it says what it is doing now in words, and the main pane is the run's log streaming as it happens:
 * the same Activity timeline / Output the task card's Show logs opens (TaskLog → AgentTimeline / StepLog), with tool
 * calls in words and the raw call one click away.
 *
 * TaskLiveBanner: the slim line on top of an agent's resting chat while it works on something ("Julia is working on
 * VO-15 now · Watch"), one Watch per running task.
 */
import { useEffect } from 'react'
import type { CompanyAgent } from '@shared/company'
import type { Id } from '@shared/types'
import { TASK_CARD_LABEL, taskCardResult, taskCardState } from '@shared/taskCard'
import { Button, EmptyState, Toolbar } from '../ui'
import { AskCard } from '../agents/AskCard'
import { AgentGlyph } from '../agents/AgentBits'
import { AgentBust } from '../../shell/DepartmentGroup'
import { useAgentDisplay } from '../board/NeedsYouTasks'
import { TaskLog, WorkClock } from '../conversations/TaskCard'
import { pauseTask, useIsCode } from '../desk/Desk'
import { openAskOfRun, rootOfRun } from '../../lib/taskCardView'
import { plainActivity } from '../../lib/plainActivity'
import { taskName } from '../../lib/desk'
import { workingTasksOf } from '../../lib/liveRow'
import { focusAgent, mergeAgents } from '../../state/live'
import { hive } from '../../lib/hive'
import { navigate, openBoard, openTaskLive, useStore } from '../../state/store'
import '../../styles/conversations.css'
import '../../styles/desk.css'

export function TaskLiveView({ taskId }: { taskId: Id }): React.JSX.Element {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null)
  const seat = useStore((s) => (task?.agentId ? s.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined))
  const runId = task?.runId ?? null
  const root = useStore((s) => (runId ? rootOfRun(Object.values(s.agents), runId) : null))
  const ask = useStore((s) => (runId ? openAskOfRun(Object.values(s.asks), runId) : null))
  const code = useIsCode(task?.companyId)
  const display = useAgentDisplay()(seat)
  // the run's agents load on demand (opened from a link before the live snapshot has them)
  const hasRoot = !!root
  useEffect(() => {
    if (runId && !hasRoot) void hive.agents.list({ runId, rootsOnly: true, limit: 20 }).then(mergeAgents, () => undefined)
  }, [runId, hasRoot])
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
  const who = display?.name ?? seat?.name ?? 'Nobody yet'
  const rootLive = !!root && (root.status === 'working' || root.status === 'starting' || root.status === 'needs_you')
  const working = state === 'working'
  const activity = working ? (rootLive ? (plainActivity(root!.activity, { code }) ?? 'Working…') : 'Starting…') : null
  const result = taskCardResult({ report: task.report ?? null, doneNote: task.doneNote ?? null })
  const since = root?.startedAt ?? task.updatedAt
  return (
    <div className="view convo-view task-live" data-chatux="task-live" data-state={state}>
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
            <span className={working ? 'shimmer-text' : ''}>{TASK_CARD_LABEL[state]}</span>
            {working && (
              <>
                <span className="cx-task__sep">·</span>
                <WorkClock since={since} />
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
        {seat && (
          <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'chats', filter: 'all', chat: `agent:${seat.id}` })} title={`${who}’s own chat`}>
            Chat with {who}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openBoard(task.companyId, { taskId: task.id })}>
          Open task
        </Button>
      </Toolbar>
      <div className="task-live__body">
        {activity && (
          <div className="task-live__now" data-chatux="task-live-activity" aria-live="polite">
            <span className="task-live__dot" aria-hidden />
            <span className="shimmer-text">{activity}</span>
          </div>
        )}
        {ask && <AskCard ask={ask} onOpen={() => void focusAgent(ask.agentId, ask.id)} />}
        {!working && state !== 'needs_you' && (
          <div className="task-live__now task-live__now--done" data-chatux="task-live-result">
            {result ?? (state === 'queued' ? 'Waiting for its turn.' : state === 'failed' ? 'It stopped before it was finished.' : 'Finished.')}
          </div>
        )}
        {root && root.runId === runId && runId ? (
          <TaskLog agentId={root.id} runId={runId} stepId={root.stepId} live={rootLive} fill code={code} />
        ) : (
          <div className="task-live__empty text-tertiary">{working ? `${who} is starting on it…` : 'No run recorded for this task yet.'}</div>
        )}
      </div>
    </div>
  )
}

/** "Julia is working on VO-15 now · Watch" on top of the agent's resting chat; one Watch per running task. */
export function TaskLiveBanner({ agent, name }: { agent: CompanyAgent; name: string }): React.JSX.Element | null {
  const all = useStore((s) => s.tasks)
  const code = useIsCode(agent.companyId)
  const tasks = workingTasksOf(agent.id, agent.companyId, all)
  if (!tasks.length) return null
  const one = tasks.length === 1 ? tasks[0]! : null
  return (
    <div className="live-banner" data-chatux="live-banner" role="status">
      <span className="live-banner__dot" aria-hidden />
      {one ? (
        <button type="button" className="live-banner__line" onClick={() => openTaskLive(one.id, one.companyId)} title={taskName(one, code)}>
          {name} is working on {code ? one.identifier : `“${one.title}”`} now
        </button>
      ) : (
        <span className="live-banner__line">
          {name} is working on {tasks.length} tasks now
        </span>
      )}
      {one ? (
        <button type="button" className="link-btn live-banner__watch" onClick={() => openTaskLive(one.id, one.companyId)}>
          Watch
        </button>
      ) : (
        tasks.map((t) => (
          <button key={t.id} type="button" className="link-btn live-banner__watch" onClick={() => openTaskLive(t.id, t.companyId)} title={taskName(t, code)}>
            Watch {code ? t.identifier : t.title}
          </button>
        ))
      )}
    </div>
  )
}
