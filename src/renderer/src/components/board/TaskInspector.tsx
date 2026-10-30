import { useEffect, useRef, useState } from 'react'
import { agentActive, type CompanyPassport, type CompanyTask, type CompanyTaskInput, type TaskDetail } from '@shared/company'
import { SLOT_WAIT_LABEL, SLOT_WAIT_WHY } from '@shared/taskCard'
import type { Artifact, Run, Session } from '@shared/types'
import { Button, IconButton, Loading, Pill, RelativeTime } from '../ui'
import { Icon } from '../Icon'
import { TaskPriority, TaskSourceBadge, TaskStatusIcon } from '../TaskBits'
import { AskForm } from './AskForm'
import { ActivityTimeline } from './ActivityTimeline'
import { TaskEditor } from './TaskEditor'
import { BriefPanel } from './BriefPanel'
import { BLOCK_REASON_TEXT, REASON_LABEL, canApprove, inspectorActions, statusChoices } from '../../lib/board'
import { PRIORITIES, STATUS_LABEL, useLaneContext } from '../../lib/company'
import { reposOf } from '../../lib/companyModel'
import { departmentsOf, taskLane, taskReason } from '../../lib/departments'
import { errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { runVisual } from '../../lib/graph'
import { runTitle } from '../../lib/format'
import { focusSession, loadJson, navigate, saveJson, setState, toast, useStore } from '../../state/store'
import { useAgentDisplay } from './NeedsYouTasks'
import { useTone } from '../../lib/voice'
import { TASK_DONE_LATIN_KEY, taskDoneToast } from '../../lib/taskDoneToast'
import { StatusGlyph } from '../ui'
import { WorkFlow, WorkSection, companyRepoIds } from './TaskWork'
import { canStartWork, workQueued, workStarted } from '@shared/taskWork'
import { COLUMN_LABEL, columnOfLane, followsPr } from '../../lib/boardFlow'
import { nativeMenu } from '../../lib/hive'
import { TextWithDiagrams } from '../diagrams/TextWithDiagrams'
import { LinearChip } from './LinearSheet'
import { linearWorkLabel, startedInLinear } from '../../lib/linear'
import { TextWithLinks } from '../DeepLinkButton'

type TaskRun = Run & { taskId?: string | null }
type TaskSession = Session & { taskId?: string | null }
/** Board status edits: planning moves, a park by hand and cancel. Work starts with Run now; done needs Approve. */
// the Board's own words (To do · Working · Needs you · Done), never the tracker's Inbox / Backlog / Todo
const STATUS_CHOICE_LABEL = { triage: 'To do · not sorted yet', backlog: 'To do · later', todo: 'To do', 'blocked:manual': 'On hold', canceled: 'Canceled' } as const
const STATUS_WORD: Record<string, string> = { in_progress: 'Working', in_review: 'Needs you · review', blocked: 'Needs you', done: 'Done' }

/**
 * DEPARTMENTS.md §9 inspector for a board task (departments on): department and agent pickers with the routing reason
 * and Accept suggestion, status, priority, optional repo, dependencies and subtasks, the board ask, the report,
 * run and session links, artifacts, Learned notes and the typed timeline. Actions follow the task's state (§1.4):
 * Run now, Open as session, Take over, Stop, Approve as done (a note is required), Send back with a note, Unpark.
 */
export function TaskInspector({ id, tasks, companies, linear = null, onClose, onSaved, onSelect }: { id: string; tasks: CompanyTask[]; companies: CompanyPassport[]; linear?: { key: string; url: string; status?: string } | null; onClose: () => void; onSaved: () => void; onSelect?: (id: string) => void }): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const repos = useStore((s) => s.repos)
  // pm-review C7: no task codes in a company with no code
  const code = useStore((s) => { const t = tasks.find((x) => x.id === id); return !!t && s.repos.some((r) => r.companyId === t.companyId) })
  const allDepartments = useStore((s) => s.departments)
  const allAgents = useStore((s) => s.companyAgents)
  const sessions = useStore((s) => s.sessions)
  const termSize = useStore((s) => s.lastTermSize)
  const version = tasks.find((t) => t.id === id)?.updatedAt
  const request = useRef(0)
  const load = (): void => { const n = ++request.current; void hive.tasks.get({ id }).then((d) => { if (request.current === n) { setDetail(d); setError(null) } }, (e: unknown) => { if (request.current === n) setError(errorMessage(e)) }) }
  useEffect(() => { load(); return () => { request.current++ } }, [id, version])
  useHiveEvent('data:changed', ({ domain }) => { if (domain === 'tasks') load() })
  const mutate = async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true); setError(null)
    try { await fn(); load(); onSaved(); if (done) toast(done); return true } catch (e) { setError(errorMessage(e)); return false } finally { setBusy(false) }
  }
  const tone = useTone()
  const who = useAgentDisplay()
  /** VOICE.md §3.7: "Marcus finished “Draft posts”." (Bene factum on the day's first, playful only). */
  const doneToast = (t: CompanyTask): void => {
    const agent = t.agentId ? allAgents.find((a) => a.id === t.agentId) : undefined
    const r = taskDoneToast({ persona: who(agent)?.name ?? null, task: t.title, identifier: t.identifier }, tone, loadJson<string | null>(TASK_DONE_LATIN_KEY, null))
    if (r.shownDay) saveJson(TASK_DONE_LATIN_KEY, r.shownDay)
    toast(r.text, 'info', r.latin ? { latin: r.latin } : {})
  }
  const task = detail?.task
  const runs = useTaskRuns(task)
  const ctx = useLaneContext()

  if (!task) return <aside className="task-inspector board-inspector" aria-label="Task details">
    <header className="task-inspector-top"><span>Task details</span><div><IconButton icon="close" label="Close task details" onClick={onClose} /></div></header>
    {error ? <div className="company-error" role="alert">{error}</div> : <Loading label="Loading task…" />}
  </aside>

  const departments = departmentsOf(allDepartments, task.companyId)
  const seats = allAgents.filter((a) => a.companyId === task.companyId && (!a.archivedAt || a.id === task.agentId))
  const agent = seats.find((a) => a.id === task.agentId) ?? null
  const department = departments.find((d) => d.id === (task.departmentId ?? agent?.departmentId)) ?? null
  const lane = taskLane(task, ctx)
  const reason = taskReason(task, ctx)
  // LINEAR.md: in progress in Linear with no run here stays editable (it leaves by a status move)
  const elsewhere = startedInLinear(task, linear)
  const inFlight = task.status === 'in_progress' && !elsewhere
  const run = runs.find((r) => r.id === task.runId) ?? null
  const slotWait = inFlight && !!run?.slotWaitSince && (run.status === 'running' || run.status === 'queued')
  const taskSessions = (sessions as TaskSession[]).filter((s) => s.taskId === task.id)
  const liveSession = taskSessions.find((s) => s.status === 'running')
  const headlessRun = inFlight && !liveSession && !!task.runId
  const actions = elsewhere ? new Set<ReturnType<typeof inspectorActions> extends Set<infer A> ? A : never>() : inspectorActions(task, { hasAgent: !!(task.agentId || task.assigneeProfileId), headlessRun })
  const subtasks = tasks.filter((t) => t.parentId === task.id)
  const unresolved = task.dependencyIds.map((d) => tasks.find((t) => t.id === d)).filter((t) => t && t.status !== 'done')
  const routing = task.routing
  const suggestion = routing?.by === 'model' && task.status === 'triage' ? routing : null
  const runBlocked = !agent && !task.assigneeProfileId ? 'Assign an agent first.' : agent && !agentActive(agent) ? `${agent.name} is ${agent.archivedAt ? 'archived' : 'paused'}.` : unresolved.length ? 'Finish this task’s dependencies before starting.' : ''
  const statusValue = task.status === 'blocked' ? (task.blockReason === 'manual' ? 'blocked:manual' : 'blocked') : task.status
  const company = companies.find((c) => c.id === task.companyId)
  // WORKTREE.md: one main action per screen: Start leads for a code task, Run now (in the founder's checkout) follows
  const startOffered = !!company && (canStartWork(task, companyRepoIds(company, repos)) || workQueued(task.work))
  // design §4.5: one primary. A code task to start leads with Start on a new branch (its ▾ holds the other starts);
  // a task with a branch never shows Start again, only its next step
  const branchLed = code && (startOffered || workStarted(task.work))
  // A3: an open pull request decides: approved or merged on GitHub moves it to Done by itself
  const prDecides = followsPr(task)
  const repoName = task.repoId ? (repos.find((r) => r.id === task.repoId)?.name ?? null) : null
  const otherStarts = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'chat', label: 'Start in a chat', enabled: actions.has('openSession') && !runBlocked },
      { id: 'checkout', label: 'Start on my checkout', enabled: actions.has('run') && !runBlocked }
    ])
    if (id === 'chat') openSession(false)
    if (id === 'checkout') void mutate(() => hive.tasks.start({ id: task.id }), `Started ${task.identifier} on your checkout`)
  }

  const assign = (patch: { departmentId?: string | null; agentId?: string | null }): void => void mutate(() => hive.tasks.assign({ id: task.id, ...patch }))
  const pickDepartment = (depId: string | null): void => {
    // the agent stays only when it works in the new department (or company-wide)
    const keep = agent && (agent.departmentId === null || agent.departmentId === depId)
    assign({ departmentId: depId, ...(keep ? {} : { agentId: null }) })
  }
  const pickAgent = (agentId: string | null): void => {
    const seat = seats.find((a) => a.id === agentId)
    assign({ agentId, ...(seat?.departmentId ? { departmentId: seat.departmentId } : {}) })
  }
  const setStatus = (v: string): void => {
    const patch: Partial<CompanyTaskInput> = v === 'blocked:manual' ? { status: 'blocked', blockReason: 'manual' } : { status: v as CompanyTaskInput['status'] }
    void mutate(() => hive.tasks.update({ id: task.id, patch }))
  }
  const openSession = (takeover: boolean): void => void mutate(async () => {
    const q = { id: task.id, cols: termSize.cols, rows: termSize.rows }
    const out = takeover ? await hive.tasks.takeover(q) : await hive.tasks.openSession(q)
    setState((s) => ({ sessions: s.sessions.some((x) => x.id === out.session.id) ? s.sessions.map((x) => (x.id === out.session.id ? out.session : x)) : [out.session, ...s.sessions] }))
    focusSession(out.session.id)
  })

  // a task waiting on your review opens with Approve and Send back on top (Maya: "Where's the button to say yes?");
  // the brief, properties and report follow
  const reviewFirst = task.status === 'in_review' && (actions.has('approve') || actions.has('sendBack'))
  const actionsPanel = (
      <section className="task-agent-panel board-actions"><div className="task-agent-heading"><Icon name="agents" size={16} /><h3>{agent ? agent.name : 'Agent'}</h3>{inFlight && <span className="task-live-dot" />}</div>
        <p>{elsewhere ? `${linearWorkLabel(linear).replace(/^i/, 'I')} (${linear!.key}). Move it to Todo to run an agent here.` : inFlight ? (liveSession ? 'Open in an interactive session. Submit or park it from the session.' : 'An agent is working on this task. Take over to continue it yourself in a session.') : task.status === 'in_review' ? (prDecides ? 'The pull request decides: approved or merged on GitHub, this task moves to Done by itself. Or send it back with what to change.' : 'The agent finished. Approve it with a done note, or send it back with what to change.') : actions.has('run') ? (task.status === 'todo' && company && !company.autopilot && !company.pausedAt ? `Autopilot is off in ${company.name}, so this waits for you: ${code ? 'Run now' : 'Start'} puts ${agent?.name ?? 'the agent'} on it. Turn Autopilot on in Automations and agents start their work by themselves.` : code ? 'Run now starts the agent on this task. With Autopilot on, auto agents start by themselves.' : 'Start puts the agent on this task. Agents that act on their own start by themselves while Autopilot is on.') : runBlocked || 'Nothing to do here right now.'}</p>
        {actions.has('run') && !branchLed && <Button icon="play" variant={task.status === 'in_review' || startOffered ? 'secondary' : 'primary'} disabled={busy || !!runBlocked} title={runBlocked} onClick={() => void mutate(() => hive.tasks.start({ id: task.id }), `Started ${code ? task.identifier : task.title}`)}>{code ? 'Run now' : 'Start'}</Button>}
        {code && actions.has('openSession') && !branchLed && <Button icon="terminal" disabled={busy || !!runBlocked} title={runBlocked} onClick={() => openSession(false)}>Open as session</Button>}
        {code && actions.has('takeover') && <Button icon="terminal" disabled={busy} onClick={() => openSession(true)}>Take over</Button>}
        {actions.has('stop') && <Button icon="pause" disabled={busy} onClick={() => void mutate(() => hive.tasks.pause({ id: task.id }), `Paused ${task.title}. The work so far is kept; Start picks it up again.`)}>Pause this task</Button>}
        {actions.has('unpark') && <Button icon="refresh" disabled={busy} onClick={() => void mutate(() => hive.tasks.unpark({ id: task.id }), `${code ? task.identifier : task.title} is back in the queue`)}>Try again</Button>}
        {(actions.has('approve') || actions.has('sendBack')) && <div className="board-review">
          <textarea aria-label="Done note or what to change" rows={3} maxLength={4000} placeholder="Done note (what shipped, where) or what to change…" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="board-review__buttons">
            {!prDecides && <Button variant="primary" icon="check" disabled={busy || !canApprove(task, note)} title={canApprove(task, note) ? 'Mark the task done with this note' : 'Write a done note first'} onClick={() => void mutate(() => hive.tasks.approve({ id: task.id, doneNote: note.trim() })).then((ok) => { if (ok) { doneToast(task); setNote('') } })}>Approve as done</Button>}
            <Button icon="reply" disabled={busy || !note.trim()} title={note.trim() ? 'Send it back to the agent with this note' : 'Say what to change first'} onClick={() => void mutate(() => hive.tasks.sendBack({ id: task.id, note: note.trim() }), `Sent ${task.identifier} back`).then((ok) => ok && setNote(''))}>Send back with note</Button>
          </div>
        </div>}
        {task.doneNote && <div className="board-done-note"><strong>Done note</strong><p className="selectable">{task.doneNote}</p></div>}
      </section>
  )
  return <aside className="task-inspector board-inspector" aria-label="Task details">
    <header className="task-inspector-top"><span className="board-inspector__id">{code ? task.identifier : 'Task'}{elsewhere ? <Pill tone="idle">{linearWorkLabel(linear).replace(/^i/, 'I')}</Pill> : slotWait ? <Pill tone="idle" title={SLOT_WAIT_WHY}>{SLOT_WAIT_LABEL}</Pill> : <Pill tone={lane === 'needs_you' ? 'warning' : lane === 'working' ? 'running' : lane === 'done' ? 'passed' : 'idle'}>{COLUMN_LABEL[columnOfLane(lane)]}</Pill>}</span><div><IconButton icon="edit" label="Edit task" disabled={busy || inFlight} title={inFlight ? 'Stop the agent before editing' : 'Edit task'} onClick={() => setEditing(true)} /><IconButton icon="close" label="Close task details" onClick={onClose} /></div></header>
    {error && <div className="company-error" role="alert">{error}</div>}
    <div className="task-inspector-scroll">
      <div className="task-detail-company"><Icon name="passport" size={12} />{companies.find((c) => c.id === task.companyId)?.name}{department && <> · <span className="board-dot" style={{ background: department.color ?? 'var(--series-other)' }} />{department.name}</>}</div>
      <h2>{task.title}</h2>
      {code && <WorkFlow task={task} company={company} repoName={repoName} who={agent ? (who(agent)?.name ?? agent.name) : null} inFlight={inFlight} liveSessionId={liveSession?.id ?? null} blocked={runBlocked || null} busy={busy} onDone={() => { load(); onSaved() }} otherStarts={actions.has('run') || actions.has('openSession') ? () => void otherStarts() : undefined} />}
      <WorkSection task={task} compact={code} onDone={() => { load(); onSaved() }} />
      {reason && <div className="board-inspector__lane"><span className={`board-reason board-reason--${reason}`}>{REASON_LABEL[reason]}{code && reason === 'review' && !task.report ? ' · no report' : ''}</span></div>}
      {reviewFirst && <div className="board-review-first">{actionsPanel}</div>}
      <BriefPanel task={task} onChanged={() => { load(); onSaved() }} />

      {task.status === 'blocked' && task.blockReason && task.blockReason !== 'needs_input' && <div className="board-callout" role="note">{BLOCK_REASON_TEXT[task.blockReason]}</div>}
      {task.ask && !task.ask.answer && <section className="board-section board-section--ask"><AskForm task={task} onAnswered={() => { load(); onSaved() }} /></section>}

      <div className="task-properties">
        <label><span>Department</span><div><select aria-label="Department" disabled={busy || inFlight} value={task.departmentId ?? ''} onChange={(e) => pickDepartment(e.target.value || null)}><option value="">No department</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div></label>
        <label><span>Agent</span><div><select aria-label="Agent" disabled={busy || inFlight} value={task.agentId ?? ''} onChange={(e) => pickAgent(e.target.value || null)}><option value="">Unassigned</option>{seats.filter((a) => !task.departmentId || a.departmentId === task.departmentId || a.departmentId === null || a.id === task.agentId).map((a) => <option key={a.id} value={a.id}>{a.name}{a.archivedAt ? ' (archived)' : a.pausedAt ? ' (paused)' : a.data.autonomy === 'auto' ? ' · auto' : ''}</option>)}</select></div></label>
        {routing && <div className="board-routing"><span>Routing</span><span className="selectable">{routing.by === 'model' ? 'Suggested' : routing.by === 'rule' ? 'Rule' : 'You'}: {routing.reason}{routing.confidence != null && ` (${Math.round(routing.confidence * 100)}%)`}</span></div>}
        {suggestion && <div><span /><span><Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void mutate(() => hive.tasks.acceptRoute({ id: task.id }), 'Suggestion accepted')}>Accept suggestion</Button></span></div>}
        <label><span>Status</span><div><TaskStatusIcon status={task.status} />{inFlight || task.status === 'in_review' || (task.status === 'blocked' && task.blockReason !== 'manual') ? <span>{task.status === 'blocked' && task.blockReason ? `Needs you · ${REASON_LABEL[task.blockReason]}` : (STATUS_WORD[task.status] ?? STATUS_LABEL[task.status])}</span> : <select aria-label="Task status" disabled={busy} value={statusValue} onChange={(e) => setStatus(e.target.value)}>{task.status === 'done' && <option value="done" disabled>Done</option>}{elsewhere && <option value="in_progress" disabled>{linearWorkLabel(linear).replace(/^i/, 'I')}</option>}{statusChoices(task).map((v) => <option key={v} value={v}>{(task.status === 'done' || task.status === 'canceled') && v !== 'canceled' ? `Reopen: ${STATUS_CHOICE_LABEL[v]}` : task.status === 'blocked' && v === 'todo' ? `Back to ${STATUS_CHOICE_LABEL[v]}` : STATUS_CHOICE_LABEL[v]}</option>)}</select>}</div></label>
        <label><span>Priority</span><div><TaskPriority priority={task.priority} /><select aria-label="Task priority" value={task.priority} disabled={busy || inFlight} onChange={(e) => void mutate(() => hive.tasks.update({ id: task.id, patch: { priority: Number(e.target.value) as CompanyTaskInput['priority'] } }))}>{PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></div></label>
        {code && <label><span>Repository</span><div><select aria-label="Repository" value={task.repoId ?? ''} disabled={busy || inFlight} onChange={(e) => void mutate(() => hive.tasks.update({ id: task.id, patch: { repoId: e.target.value || null } }))}><option value="">Company workspace</option>{reposOf(repos, task.companyId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div></label>}
        <div><span>Source</span>{task.sourceUrl ? <button className="task-source-link" onClick={() => void hive.app.openExternal({ url: task.sourceUrl! }).catch((e) => setError(errorMessage(e)))}><TaskSourceBadge source={task.source} /><Icon name="external" size={12} /></button> : <TaskSourceBadge source={task.source} />}</div>
        {linear && <div><span>Linear</span><span><LinearChip issueKey={linear.key} url={linear.url} /></span></div>}
        {(task.labels?.length ?? 0) > 0 && <div><span>Labels</span><span className="selectable">{(task.labels ?? []).join(', ')}</span></div>}
        {task.estimate != null && <div><span>Estimate</span><span>{task.estimate} {task.estimate === 1 ? 'point' : 'points'}</span></div>}
        {task.dueDate && <div><span>Due</span><span>{task.dueDate}</span></div>}
        {task.parentId && <div><span>Parent</span><button className="link-btn" onClick={() => onSelect?.(task.parentId!)}>{tasks.find((t) => t.id === task.parentId)?.identifier ?? task.parentId}</button></div>}
      </div>

      {!reviewFirst && actionsPanel}

      {task.report && <section className="board-section"><h3>Report <span className="board-muted">· {task.report.outcome === 'review' ? 'ready for review' : 'blocked'} · <RelativeTime iso={task.report.at} /></span></h3>
        <TextWithDiagrams text={task.report.summary} renderText={(t) => <p className="selectable board-report"><TextWithLinks text={t} /></p>} />
        {(task.report.evidence ?? []).length > 0 && <ul className="board-evidence">{(task.report.evidence ?? []).map((e, i) => <li key={i} className="selectable">{/^https?:\/\//.test(e) ? <button className="link-btn" onClick={() => void hive.app.openExternal({ url: e }).catch(() => undefined)}>{e}</button> : e}</li>)}</ul>}
      </section>}

      {(task.dependencyIds.length > 0 || subtasks.length > 0) && <section className="task-detail-section">
        {task.dependencyIds.length > 0 && <><h3>Depends on</h3>{task.dependencyIds.map((d) => { const t = tasks.find((x) => x.id === d); return <button key={d} className="task-dependency board-link-row" onClick={() => t && onSelect?.(t.id)} disabled={!t}>{t ? <TaskStatusIcon status={t.status} /> : <Icon name="lock" size={11} />}<span>{t?.identifier}</span><span>{t?.title ?? 'Task unavailable'}</span>{t && t.status !== 'done' && <Icon name="lock" size={11} />}</button> })}</>}
        {subtasks.length > 0 && <><h3>Subtasks</h3>{subtasks.map((t) => <button key={t.id} className="task-dependency board-link-row" onClick={() => onSelect?.(t.id)}><TaskStatusIcon status={t.status} /><span>{t.identifier}</span><span>{t.title}</span></button>)}</>}
      </section>}

      <RunsSection task={task} runs={runs} sessions={taskSessions} current={run} code={code} />

      <section className="task-detail-section task-activity"><h3>Activity</h3>
        <ActivityTimeline activity={detail.activity} plain={!code} />
        <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void mutate(async () => { await hive.tasks.comment({ id: task.id, message: comment.trim() }); setComment('') }) }}><textarea aria-label="Add task comment" placeholder={inFlight ? 'Add a note; the agent sees it on its next turn…' : 'Add a note or decision…'} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={8000} /><Button type="submit" disabled={busy || !comment.trim()}>Add comment</Button></form>
      </section>
    </div>
    {editing && <TaskEditor board trackerFields={!!linear} linkedKey={linear?.key ?? null} task={task} companies={companies} tasks={tasks} defaultCompanyId={task.companyId} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onSaved() }} />}
  </aside>
}

/** The task's runs (runs.task_id, plus its latest run), newest first; refetched when a run of the company changes. */
function useTaskRuns(task: CompanyTask | undefined): TaskRun[] {
  const [runs, setRuns] = useState<TaskRun[]>([])
  const companyId = task?.companyId
  const taskId = task?.id
  const runId = task?.runId
  const load = (): void => {
    if (!companyId || !taskId) return
    void hive.runs.list({ companyId, limit: 200 }).then((list) => setRuns((list as TaskRun[]).filter((r) => r.taskId === taskId || r.id === runId)), () => setRuns([]))
  }
  useEffect(load, [companyId, taskId, runId])
  useHiveEvent('run:updated', (r) => { if (taskId && ((r as TaskRun).taskId === taskId || (!!runId && r.id === runId))) setRuns((l) => (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? { ...x, ...r } : x)) : [r as TaskRun, ...l])) })
  return runs
}

/** Run and session links, the latest runs' artifacts and the passport notes they wrote ("Learned: [[X]]"). */
function RunsSection({ task, runs, sessions, current, code }: { task: CompanyTask; runs: TaskRun[]; sessions: TaskSession[]; current: TaskRun | null; code: boolean }): React.JSX.Element | null {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [learned, setLearned] = useState<string[]>([])
  const recent = runs.slice(0, 3).map((r) => r.id).join(',')
  useEffect(() => {
    const ids = recent ? recent.split(',') : []
    if (!ids.length) { setArtifacts([]); setLearned([]); return }
    let live = true
    void Promise.all(ids.map((runId) => hive.artifacts.list({ runId }).catch(() => [] as Artifact[]))).then((l) => live && setArtifacts(l.flat().slice(0, 12)))
    void Promise.all(ids.map((runId) => hive.memory.facts({ scope: 'all', runId, companyId: task.companyId, limit: 20 }).then((r) => r.items, () => []))).then((l) => {
      if (live) setLearned([...new Set(l.flat().map((f) => f.entityName).filter(Boolean))].slice(0, 8))
    })
    return () => { live = false }
  }, [recent, task.companyId])
  if (!runs.length && !sessions.length) return null
  return <section className="task-detail-section board-runs"><h3>{code ? 'Runs' : 'Work so far'}</h3>
    {runs.slice(0, 6).map((r) => <button key={r.id} className="board-link-row" onClick={() => void navigate({ name: 'run', runId: r.id })} title={r.reason ?? undefined}>
      <StatusGlyph status={runVisual(r.status)} /><span className="board-link-row__main">{code ? runTitle(r, 50) : task.title}{r.id === current?.id ? ' · latest' : ''}</span><span className="board-muted"><RelativeTime iso={r.endedAt ?? r.startedAt ?? r.createdAt} /></span>
    </button>)}
    {sessions.map((s) => <button key={s.id} className="board-link-row" onClick={() => focusSession(s.id)}><Icon name="terminal" size={12} /><span className="board-link-row__main">{s.title || 'Session'}</span><span className="board-muted">{s.status === 'running' ? 'open' : 'ended'}</span></button>)}
    {artifacts.length > 0 && <div className="board-artifacts"><h4>Artifacts</h4>{artifacts.map((a) => <button key={a.id} className="board-link-row" onClick={() => void hive.artifacts.open({ id: a.id }).catch(() => undefined)}><Icon name="file" size={12} /><span className="board-link-row__main">{a.name}</span></button>)}</div>}
    {learned.length > 0 && <p className="board-learned">Learned: {learned.map((n) => `[[${n}]]`).join(', ')}</p>}
  </section>
}
