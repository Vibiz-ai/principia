/**
 * Home (five doors step 3, design §4.1): the 5-second answer. "Good morning, Maya. Northwind Coffee · 3 things need
 * you, 1 agent is working." Then, in this order:
 * 1. Ask your team… (AskBox): a real input that routes to an agent ("→ Marcus · Content Writer") and opens its desk.
 * 2. Needs you: everything that waits on you in this company, from the one live source (useNeeds): live asks and
 *    finished turns (with their buttons), drafts to approve, board tasks (Approve / Send back / Answer / Try again /
 *    Assign, all in place), cloud asks and leftover processes. It absorbs the old Agents hub and NeedsYouTasks.
 * 3. Working now: one row per working agent (useWorking), Open opens that exact chat, Pause this task (C9).
 * 4. The Setup chip, with only the steps that fit this company ("Setup 4 of 6").
 * 5. This week: three tiles (C10): tasks done, drafts approved (pull requests in a code company), plan use, which
 *    Claude doesn't report yet, so it says so (never a fake number).
 * All companies mode shows the Portfolio (App.tsx). The provider switcher left Home (design §5 #36): it lives in New
 * chat and Settings › AI providers.
 */
import { useMemo, useState } from 'react'
import type { CompanyTask } from '@shared/company'
import type { Id } from '@shared/types'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import { AgentRow } from '../components/agents/AgentTree'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { LeftoverList, useLeftovers } from '../components/agents/LimitBits'
import { ApprovalCard } from '../components/author/ApprovalCard'
import { AgentFace, useAgentDisplay } from '../components/board/NeedsYouTasks'
import { AskForm } from '../components/board/AskForm'
import { CloudNeedsYou } from '../components/cloud/NeedsYou'
import { SetupChecklist } from '../components/home/SetupChecklist'
import { ArchFrame } from '../components/roman'
import { AskBox, DraftCard, pauseTask, useIsCode } from '../components/desk/Desk'
import { Button, Kbd, SectionHeader, Toolbar, useTick } from '../components/ui'
import { useScope, useScopedLive } from '../components/CompanyChip'
import { AgentBust } from '../shell/DepartmentGroup'
import { finishedLine, greeting, homeHeadline, waitsOnOther, weekTiles } from '../lib/desk'
import { hubGroups, isSeen, isUnseenIdle } from '../lib/live'
import { needsYouTasks, REASON_LABEL, BLOCK_REASON_TEXT, type NeedsYouItem } from '../lib/board'
import { useCompanyShortName, useLaneContext } from '../lib/company'
import { inScope } from '../lib/scope'
import { firstLine } from '../lib/format'
import { age } from '../lib/time'
import { attempt, closeSession, companyName, departmentsOn, getState, navigate, openBoard, providerLabel, refreshTasks, setCompanyPaused, toast, useStore } from '../state/store'
import { focusAgent, goNextNeedsYou, useNeeds, useSeenSet, useWorking } from '../state/live'
import { usePendingDrafts } from '../state/authoring'
import { deskAgents } from '../state/desk'
import { hive, nativeMenu } from '../lib/hive'
import type { LiveItem } from '../lib/companyModel'
import { claudeSignedOut, useClaudeAuth } from '../state/claudeAuth'
import { Icon } from '../components/Icon'
import { FirstWeekCard, ThingsMovedCard } from '../components/home/FirstRunCards'
import { useThingsMoved } from '../components/home/useThingsMoved'
import '../styles/board.css'
import '../styles/desk.css'

export function HomeView(): React.JSX.Element {
  useTick()
  const { scope: scoped, company } = useScope()
  const scope: Id = scoped ?? PERSONAL_COMPANY_ID
  const name = company?.name ?? 'Personal'
  const userName = useStore((s) => s.info?.userName ?? null)
  const pausedAt = useStore((s) => s.companies.find((c) => c.id === scope)?.pausedAt ?? null)
  const code = useIsCode(scope)
  const agentCount = useStore((s) => (departmentsOn(s) ? s.companyAgents.filter((a) => a.companyId === scope && !a.archivedAt).length : 0))
  const needs = useNeeds(scope)
  const working = useWorking(scope)
  const drafts = useScopedDrafts(scope)
  const tasks = useStore((s) => s.tasks)
  const own = useMemo(() => tasks.filter((t) => t.companyId === scope), [tasks, scope])
  const ctx = useLaneContext()
  const reviews = useMemo(() => needsYouTasks(own, ctx, scope, { skipLiveAsks: true }).filter((i) => i.group === 'review').length, [own, ctx, scope])
  const needsTotal = needs.count + drafts.length
  const short = useCompanyShortName(scope, name)
  const personal = scope === PERSONAL_COMPANY_ID
  const tiles = useMemo(() => weekTiles(own, { now: new Date(), code, waitingReview: reviews, paused: !!pausedAt }), [own, code, reviews, pausedAt])
  // E12: with Claude signed out (or not installed) agents can't start: Home says so, and offers no Start
  const { auth } = useClaudeAuth()
  const noClaude = auth?.state === 'signedOut' || auth?.state === 'missing' ? auth.state : null
  // design §6.7: a company just set up asks "Start the first week?" first; Needs you and Working now wait for the answer
  const firstWeek = useStore((s) => !!s.settings?.firstWeek?.[scope])
  const moved = useThingsMoved()

  return (
    <div className="view">
      <Toolbar title="Home" sub={<span className="company-toolbar-meta">{name}</span>}>
        {!personal &&
          (pausedAt ? (
            <Button variant="primary" icon="play" onClick={() => void setCompanyPaused(scope, false)}>
              Resume {short}
            </Button>
          ) : (
            <Button icon="pause" onClick={() => void setCompanyPaused(scope, true)} title={`Pause ${name} only. Other companies keep running.`}>
              Pause {short}
            </Button>
          ))}
      </Toolbar>
      <div className="scroll view__body">
        <div className="home home5">
          <header className="home5__hero">
            <ArchFrame className="home5__arch" opacity={0.1} />
            <h1 className="home5__greet">{greeting(new Date(), userName)}</h1>
            <p className="home5__line">{homeHeadline({ company: name, needs: needsTotal, working: working.agents, chats: working.chats, paused: !!pausedAt, agents: personal ? 1 : agentCount })}</p>
          </header>

          {firstWeek && <FirstWeekCard companyId={scope} />}
          {moved && <ThingsMovedCard />}

          {!firstWeek && <AskBox companyId={scope} />}

          {pausedAt && (
            <div className="banner banner--bar home__paused" role="status">
              <span className="glyph" aria-hidden>
                ‖
              </span>
              <span>
                {name} is paused. Agents start nothing and its schedules wait; other companies keep running. Chats you open yourself still work.
              </span>
              <span className="flex1" />
              <Button size="sm" variant="primary" icon="play" onClick={() => void setCompanyPaused(scope, false)}>
                Resume
              </Button>
            </div>
          )}

          {noClaude && (
            <div className="banner banner--bar home__paused" role="alert">
              <Icon name="warning" size={14} />
              <span>{noClaude === 'missing' ? 'Claude Code isn’t installed on this Mac' : 'Claude isn’t signed in on this Mac'}, so agents can’t start. Sign in, or get a Claude plan.</span>
              <span className="flex1" />
              <Button size="sm" variant="primary" onClick={() => void navigate({ name: 'settings', section: 'providers', nonce: Date.now() })}>
                Sign in to Claude
              </Button>
            </div>
          )}

          {!firstWeek && <>
          <SectionHeader title="Needs you" count={needsTotal > 0 ? <span className="text-needs">{needsTotal}</span> : undefined}>
            {needsTotal > 0 && (
              <button type="button" className="link-btn text-tertiary home5__keys" onClick={goNextNeedsYou}>
                <Kbd>⌘J</Kbd> next
              </button>
            )}
          </SectionHeader>
          {pausedAt && needsTotal > 0 && <div className="home__waiting text-tertiary">‖ Waiting until you resume</div>}
          <NeedsList scope={scope} code={code} drafts={drafts} empty={needsTotal === 0} paused={!!pausedAt} />

          <SectionHeader title="Working now" count={working.count || undefined}>
            <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'chats', filter: 'live' })} kbd="⇧⌘A">
              All live chats →
            </Button>
          </SectionHeader>
          <WorkingList items={working.items} scope={scope} paused={!!pausedAt} code={code} noClaude={!!noClaude} />
          </>}

          {!personal && agentCount > 0 && (
            <div className="home5__setup">
              <SetupChecklist companyId={scope} chip />
            </div>
          )}

          {!personal && (
            <>
              <SectionHeader title="This week" />
              <div className="week-tiles">
                {tiles.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className="week-tile"
                    onClick={() => void navigate(t.key === 'plan' ? { name: 'usage' } : t.key === 'done' ? { name: 'canvas' } : { name: 'tasks' })}
                    title={t.key === 'plan' ? 'Open Spend' : t.key === 'done' ? 'Open Activity' : 'Open the Board'}
                  >
                    <span className="week-tile__label">{t.label}</span>
                    <span className={`week-tile__value ${t.value === '—' ? 'is-unknown' : ''}`}>{t.value}</span>
                    <span className="week-tile__detail">{t.key === 'plan' && noClaude ? 'Claude isn’t signed in' : t.detail}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Authoring drafts (Approvals) of this company: a draft belongs to its authoring session's company. */
function useScopedDrafts(scope: Id): ReturnType<typeof usePendingDrafts> {
  const all = usePendingDrafts()
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => all.filter((d) => inScope(d.sessionId ? sessions.find((s) => s.id === d.sessionId) : null, scope)), [all, sessions, scope])
}

function NeedsList({ scope, code, drafts, empty, paused }: { scope: Id; code: boolean; drafts: ReturnType<typeof usePendingDrafts>; empty: boolean; paused: boolean }): React.JSX.Element {
  const { idx, asks: allAsks } = useScopedLive(scope)
  const asks = useMemo(() => allAsks.filter((a) => a.kind !== 'approval'), [allAsks])
  const seen = useSeenSet()
  const groups = useMemo(() => hubGroups(idx.roots, asks, seen), [idx, asks, seen])
  const tasks = useStore((s) => s.tasks)
  const on = useStore((s) => departmentsOn(s))
  const ctx = useLaneContext()
  const items = useMemo(() => (on ? needsYouTasks(tasks, ctx, scope, { skipLiveAsks: true }) : []), [on, tasks, ctx, scope])
  const leftovers = useLeftovers()
  return (
    <>
      {empty ? (
        <div className="group-list home5__list">
          <div className="home5-row">
            <span className="home5-row__glyph home5-row__glyph--ok" aria-hidden>
              ✓
            </span>
            <div className="home5-row__body">
              <div className="home5-row__title">Nothing needs you</div>
              <div className="home5-row__desc">{paused ? 'A paused company asks for nothing new.' : 'Your team asks here when they need a decision.'}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="home5__needs">
          {(groups.needs.length > 0 || items.length > 0 || drafts.length > 0) && (
            <div className="group-list home5__list">
              {groups.needs.map(({ root, asks: ra }, i) => (
                <AgentRow key={root.id} idx={idx} root={root} asks={ra} seen={isSeen(root, seen)}>
                  {ra.length > 0 && (
                    <div className="arow__asks">
                      {ra.map((a, j) => (
                        <AskCard key={a.id} ask={a} hotkeys={i === 0 && j === 0} onOpen={() => void focusAgent(a.agentId, a.id)} />
                      ))}
                    </div>
                  )}
                  {ra.length === 0 && isUnseenIdle(root, seen) && <ReplyBox agent={root} onOpen={() => void focusAgent(root.id)} />}
                </AgentRow>
              ))}
              {items.map((item) => (
                <TaskNeedsRow key={item.task.id} item={item} code={code} />
              ))}
            </div>
          )}
          {drafts.length > 0 && (
            <div className="hub__approvals home5__drafts">
              {drafts.map((d, i) => (
                <ApprovalCard key={d.id} draft={d} hotkeys={i === 0 && !groups.needs.length} />
              ))}
            </div>
          )}
        </div>
      )}
      <CloudNeedsYou companyId={scope} />
      {(leftovers.items?.length ?? 0) > 0 && (
        <div className="home__leftovers">
          <div className="hub__sub">Leftover processes</div>
          <LeftoverList items={leftovers.items!} onChanged={leftovers.reload} />
        </div>
      )}
    </>
  )
}

/**
 * One board task that waits on you, with its action right here: a review gets Approve (and Review, which opens the
 * draft with its pictures and Send back); a question gets Answer; a stopped task gets Try again; an unassigned one gets
 * Assign. Non-code companies never see task codes (C7).
 */
function TaskNeedsRow({ item, code }: { item: NeedsYouItem; code: boolean }): React.JSX.Element {
  const { task, reason, group } = item
  const agent = useStore((s) => (task.agentId ? s.companyAgents.find((a) => a.id === task.agentId && a.companyId === task.companyId) : undefined))
  const color = useStore((s) => s.departments.find((d) => d.id === (agent?.departmentId ?? task.departmentId))?.color ?? null)
  const who = useAgentDisplay()(agent)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<unknown>, label: string, done: string): Promise<void> => {
    setBusy(true)
    const ok = await attempt(f, label)
    setBusy(false)
    if (ok !== undefined) {
      await refreshTasks()
      toast(done)
    }
  }
  const approve = (): Promise<void> => run(() => hive.tasks.approve({ id: task.id, doneNote: `Approved: ${firstLine(task.report?.summary ?? task.title, 200)}` }), 'Approve', `Approved ${task.title}`)
  const assign = async (): Promise<void> => {
    const list = deskAgents(task.companyId, getState()).filter((a) => !a.paused)
    if (!list.length) return toast('Nobody can take it: hire or resume an agent first.')
    const id = await nativeMenu(list.map((a) => ({ id: a.id, label: `${a.name} · ${a.role}` })))
    const a = id ? getState().companyAgents.find((x) => x.id === id) : undefined
    if (a) await run(() => hive.tasks.assign({ id: task.id, agentId: a.id, departmentId: a.departmentId }), 'Assign', `${task.title} is with ${list.find((x) => x.id === a.id)?.name}`)
  }
  const desc =
    group === 'review'
      ? task.report?.summary
        ? firstLine(task.report.summary, 160)
        : finishedLine(task.title)
      : reason === 'needs_input' && task.ask
        ? task.ask.prompt
        : group === 'unassigned'
          ? `${task.title} has no agent yet`
          : `${task.title}: ${task.status === 'blocked' && task.blockReason ? BLOCK_REASON_TEXT[task.blockReason] : REASON_LABEL[reason]}`
  const answerable = reason === 'needs_input' && !!task.ask && !task.ask.answer
  return (
    <div className={`home5-row home5-row--needs ${reason === 'run_failed' ? 'home5-row--failed' : ''}`}>
      <span className="home5-row__face" aria-hidden>
        {who ? <AgentFace persona={who.persona} label={who.name} color={color} size={28} /> : <span className="home5-row__glyph">◆</span>}
      </span>
      <div className="home5-row__body">
        <div className="home5-row__title">
          {who ? who.name : 'Board'} {who?.role && <span className="home5-row__role">· {who.role}</span>}
          {group === 'review' && <span className="home5-row__what"> · {code ? `${task.identifier} ` : ''}{task.title}</span>}
          {group !== 'review' && code && <span className="home5-row__what"> · {task.identifier}</span>}
        </div>
        <div className="home5-row__desc selectable">{desc}</div>
        {open && group === 'review' && <DraftCard task={task} code={code} onHome />}
        {open && answerable && (
          <div className="home5-row__inline">
            <AskForm task={task} compact onAnswered={() => setOpen(false)} />
          </div>
        )}
      </div>
      <div className="home5-row__acts">
        {group === 'review' && (
          <>
            {/* open, the draft card below carries Approve and Send back: one Approve on screen */}
            {!open && (
              <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void approve()}>
                Approve
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? 'Close' : 'Review'}
            </Button>
          </>
        )}
        {answerable && (
          <Button size="sm" variant="primary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Close' : 'Answer'}
          </Button>
        )}
        {group === 'parked' && !answerable && (
          <Button size="sm" variant="primary" icon="refresh" disabled={busy} onClick={() => void run(() => hive.tasks.unpark({ id: task.id }), 'Try again', `${task.title} is back in the queue`)}>
            Try again
          </Button>
        )}
        {group === 'unassigned' && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void assign()}>
            Assign…
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openBoard(task.companyId, { taskId: task.id })}>
          Open
        </Button>
      </div>
      <span className="home5-row__age">{age(task.updatedAt)}</span>
    </div>
  )
}

function WorkingList({ items, scope, paused, code, noClaude = false }: { items: LiveItem[]; scope: Id; paused: boolean; code: boolean; noClaude?: boolean }): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const agents = useStore((s) => s.companyAgents)
  const who = useAgentDisplay()
  const sessions = useStore((s) => s.sessions)
  // ready = has a To do task that can start now (not one waiting on another task)
  const ready = useMemo(() => agents.filter((a) => a.companyId === scope && !a.archivedAt && !a.pausedAt && tasks.some((t) => t.agentId === a.id && t.status === 'todo' && !waitsOnOther(t, tasks)) && !tasks.some((t) => t.agentId === a.id && t.status === 'in_progress')), [agents, tasks, scope])
  if (!items.length)
    return (
      <div className="group-list home5__list">
        <div className="home5-row">
          <span className="home5-row__glyph" aria-hidden>
            {paused ? '‖' : '○'}
          </span>
          <div className="home5-row__body">
            <div className="home5-row__title">{paused ? 'Paused' : 'No one is working right now'}</div>
            <div className="home5-row__desc">
              {paused ? 'Resume to let agents pick up their tasks.' : ready.length ? `${ready.length} agent${ready.length === 1 ? ' is' : 's are'} ready with a task${noClaude ? '. They start once Claude is signed in.' : '.'}` : 'Give someone a task from the box above.'}
            </div>
          </div>
          {!paused && !noClaude && ready.length > 0 && (
            <div className="home5-row__acts">
              <Button size="sm" variant="primary" icon="play" onClick={() => void startReady(ready.map((a) => a.id))}>
                Start {ready.length === 1 ? 'it' : 'them'}
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  return (
    <div className="group-list home5__list">
      {items.map((i) => {
        const task = (i.taskId ? tasks.find((t) => t.id === i.taskId && t.status === 'in_progress') : undefined) ?? tasks.find((t) => !!t.runId && (t.runId === i.runId || t.runId === i.sessionId) && t.status === 'in_progress')
        const agent = task?.agentId ? agents.find((a) => a.id === task.agentId) : undefined
        const w = who(agent)
        const chat = i.chat && i.sessionId ? sessions.find((x) => x.id === i.sessionId) : undefined
        return (
          <div key={i.key} className="home5-row">
            <span className="home5-row__face" aria-hidden>
              {agent ? <AgentBust agent={agent} size={28} /> : <span className="home5-row__glyph home5-row__glyph--run">●</span>}
            </span>
            <div className="home5-row__body">
              <div className="home5-row__title">
                {w ? w.name : chat ? `Your chat · ${providerLabel(chat.adapter)}` : i.title} {w?.role && <span className="home5-row__role">· {w.role}</span>}
              </div>
              <div className="home5-row__desc">
                <span className="desk-status__glyph desk-status--working" aria-hidden>
                  ●
                </span>{' '}
                {task ? `${code ? `${task.identifier} ` : ''}${task.title}` : i.title}
                {i.detail ? ` · ${i.detail}` : ''} · {age(i.startedAt ?? i.at)}
              </div>
            </div>
            <div className="home5-row__acts">
              <Button size="sm" onClick={() => (agent ? void navigate({ name: 'chats', filter: 'live', chat: `agent:${agent.id}` }) : i.agentId ? void focusAgent(i.agentId) : undefined)}>
                Open
              </Button>
              {task ? (
                <Button size="sm" variant="ghost" icon="pause" onClick={() => void pauseTask(task)}>
                  Pause this task
                </Button>
              ) : i.sessionId ? (
                <Button size="sm" variant="ghost" onClick={() => void closeSession(i.sessionId!)}>
                  Stop
                </Button>
              ) : i.runId ? (
                <Button size="sm" variant="ghost" onClick={() => void attempt(() => hive.runs.cancel({ id: i.runId! }), 'Stop')}>
                  Stop
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** "Start them": each ready agent's first queued task (one per agent, highest priority first). */
async function startReady(agentIds: Id[]): Promise<void> {
  if (claudeSignedOut()) return void toast('Sign in to Claude first (Settings › AI providers): agents can’t start without it.', 'error')
  const s = getState()
  let n = 0
  for (const id of agentIds) {
    const next: CompanyTask | undefined = s.tasks.filter((t) => t.agentId === id && t.status === 'todo' && !waitsOnOther(t, s.tasks)).sort((a, b) => (a.priority || 9) - (b.priority || 9) || (a.createdAt < b.createdAt ? -1 : 1))[0]
    if (!next) continue
    const ok = await attempt(() => hive.tasks.start({ id: next.id }), 'Start')
    if (ok) n++
  }
  await refreshTasks()
  if (n) toast(`${n} agent${n === 1 ? '' : 's'} started. They ask in Needs you before anything goes out.`)
}

export { companyName }
