import { useEffect, useMemo, useRef, useState } from 'react'
import type { HomeData, Run } from '@shared/types'
import type { DashboardData } from '@shared/live'
import { AgentRow } from '../components/agents/AgentTree'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { LeftoverList, useLeftovers } from '../components/agents/LimitBits'
import { ActivityCharts } from '../components/home/ActivityCharts'
import { ComingUpList, HomeGreeting, LearnedList, MorningBrief, NeedsYouEmpty, NeedsYouHeader, RunCardView, SenateBriefing } from '../components/home/DashboardParts'
import { MilestoneStrip } from '../components/home/MilestoneStrip'
import { SetupChecklist } from '../components/home/SetupChecklist'
import { NeedsYouTasks } from '../components/board/NeedsYouTasks'
import { CloudNeedsYou } from '../components/cloud/NeedsYou'
import { ClaudeHistorySection } from '../components/home/ClaudeHistory'
import { isNothingToDo } from '../lib/authoring'
import { homeWindowLabel, hubGroups, isSeen, isUnseenIdle } from '../lib/live'
import { focusAgent, mergeAgents, mergeAsks, useNeeds, useSeenSet, useWorking } from '../state/live'
import { useScope, useScopedLive } from '../components/CompanyChip'
import { inScope } from '../lib/scope'
import { reposOf } from '../lib/companyModel'
import type { Id } from '@shared/types'
import { nativeMenu } from '../lib/hive'
import { Button, EmptyState, ErrorState, Loading, Pill, RelativeTime, SectionHeader, StatusGlyph, Toolbar, useTick } from '../components/ui'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { runVisual } from '../lib/graph'
import { firstLine, runTitle } from '../lib/format'
import { age, clock, duration } from '../lib/time'
import { useCoalesced } from '../lib/useThrottled'
import '../styles/board.css'

import { cancelRun, rerun, runContextMenu } from '../lib/runActions'
import { ProviderSwitcher } from '../shell/ProviderSwitcher'
import {
  attempt,
  closeSession,
  companyName,
  setCompanyPaused,
  focusSession,
  navigate,
  openPalette,
  providerLabel,
  sessionContextMenu,
  sessionTitle,
  departmentsOn,
  toast,
  useStore
} from '../state/store'

type SinceMode = 'last' | '24h' | '7d'
const SEEN_DWELL_MS = 8000

/**
 * Home: "since you were last here" (LIVE.md §8, F5). Needs you · What got done · What agents learned · Activity ·
 * Live now · Coming up · Morning brief. Real data only, from one app:dashboard call, then live via events.
 * Falls back to the classic Home when main doesn't serve app:dashboard.
 * COMPANY.md §8.4: in a focused company every section shows that company's rows only (All mode with several
 * companies shows the Portfolio instead). DEPARTMENTS.md §9: a focused company with departments on gets the Overnight
 * digest (tasks done, parked or awaiting review since the last visit). VOICE.md §3.5: the digest is the "Senate
 * briefing" card (plain: "Overnight"), grouped by agent; the Needs you header stays plain, its board items name the
 * agent, and an empty Needs you shows the laurel mosaic. A focused business also gets the Milestones strip (§7).
 */
export function HomeView(): React.JSX.Element {
  useTick()
  const [data, setData] = useState<DashboardData | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<SinceMode>('last')
  const repos = useStore((s) => s.repos)
  const settings = useStore((s) => s.settings)
  const winFocused = useStore((s) => s.window.focused)
  const { scope, nonce } = useScope()
  const { idx, asks } = useScopedLive(scope)
  const seen = useSeenSet()
  // focused mode: the company's run and schedule ids, to narrow the (global) dashboard payload
  const [owned, setOwned] = useState<{ scope: Id; runs: Set<Id>; schedules: Set<Id> } | null>(null)

  // The window this visit shows. Pinned on the first load so a markSeen during the visit (blur, another window)
  // never empties "What got done" under the user; only "Mark all seen" or changing the window moves it.
  const pinnedSince = useRef<string | null>(null)
  // this visit's window started with no last-seen mark (first visit): it is the default last 24 hours
  const neverSeen = useRef(false)
  const [earlier, setEarlier] = useState<DashboardData['done']>([])
  const [showEarlier, setShowEarlier] = useState(false)
  const sinceArg = (m: SinceMode): string | undefined =>
    m === '24h' ? new Date(Date.now() - 864e5).toISOString() : m === '7d' ? new Date(Date.now() - 7 * 864e5).toISOString() : (pinnedSince.current ?? undefined)
  const load = (m: SinceMode = mode): void => {
    const since = sinceArg(m)
    if (scope) {
      const forScope = scope
      void Promise.all([hive.runs.list({ companyId: forScope, limit: 500 }), hive.schedules.list({ companyId: forScope })]).then(
        ([runs, schedules]) => setOwned({ scope: forScope, runs: new Set(runs.map((r) => r.id)), schedules: new Set(schedules.map((x) => x.id)) }),
        () => setOwned({ scope: forScope, runs: new Set(), schedules: new Set() })
      )
    } else setOwned(null)
    // COMPANY.md §8.3: focused mode asks main for that company's done runs, learned facts and activity
    const co = scope ? { companyId: scope } : {}
    hive.app.dashboard(since || scope ? { ...(since ? { since } : {}), ...co } : undefined).then(
      (d) => {
        if (m === 'last' && !pinnedSince.current) {
          pinnedSince.current = d.since
          neverSeen.current = d.lastSeenAt === null
        }
        setData(d)
        setError(null)
        mergeAgents([...d.needsYou.idle, ...d.live])
        mergeAsks(d.needsYou.asks)
        // nothing new in this window: fetch the last 7 days once for a collapsed "Earlier (n)"
        if (d.done.length === 0 && m === 'last') {
          void hive.app.dashboard({ since: new Date(Date.now() - 7 * 864e5).toISOString(), ...co }).then((e) => setEarlier(e.done), () => setEarlier([]))
        } else setEarlier([])
      },
      (e) => {
        if (/not implemented/i.test(errorMessage(e))) setUnsupported(true)
        else setError(errorMessage(e))
      }
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [nonce])
  const refetch = useCoalesced(() => load(), 1000)
  useHiveEvent('run:updated', (r) => r.status !== 'running' && r.status !== 'queued' && refetch())
  useHiveEvent('schedule:updated', refetch)
  useHiveEvent('artifact:added', refetch)
  useHiveEvent('memory:changed', refetch)
  useHiveEvent('data:changed', ({ domain }) => domain === 'schedules' && refetch())

  // "last seen" moves only after the user actually looked: >= 8 s on Home with the window focused, counted across
  // focus changes. Marked when leaving Home or when the window blurs; a quick pass through Home marks nothing.
  const dwell = useRef(0)
  const focusedSince = useRef<number | null>(winFocused ? Date.now() : null)
  const looked = (): boolean => dwell.current + (focusedSince.current ? Date.now() - focusedSince.current : 0) >= SEEN_DWELL_MS
  useEffect(() => {
    if (winFocused) {
      focusedSince.current = Date.now()
      return
    }
    if (focusedSince.current) dwell.current += Date.now() - focusedSince.current
    focusedSince.current = null
    if (data && looked()) void hive.app.markSeen().catch(() => undefined)
  }, [winFocused, !!data])
  const hasData = useRef(false)
  hasData.current = !!data
  useEffect(() => () => void (hasData.current && looked() && hive.app.markSeen().catch(() => undefined)), [])
  const markAllSeen = (): void => {
    void hive.app.markSeen().then(
      () => {
        pinnedSince.current = null
        setShowEarlier(false)
        load('last')
        setMode('last')
      },
      () => undefined
    )
  }

  const leftovers = useLeftovers()
  // VOICE.md §3.5: a focused company with departments on gets the briefing card (it carries the greeting); the
  // milestone strip shows for any focused business (not Personal)
  const briefing = useStore((s) => !!scope && departmentsOn(s))
  const milestones = useStore((s) => !!scope && s.companies.some((c) => c.id === scope && !c.system))
  const groups = useMemo(() => hubGroups(idx.roots, asks, seen), [idx, asks, seen])
  // five doors A2: Working now and the Needs you count are the one live source's, like the sidebar, rail and status bar
  const workingNow = useWorking(scope ?? 'all')
  const needsNow = useNeeds(scope ?? 'all')
  const liveRoots = useMemo(() => workingNow.items.map((i) => idx.byId.get(i.agentId)).filter((a): a is NonNullable<typeof a> => !!a), [workingNow, idx])
  // A4: a paused company starts nothing; what it raised before the pause stays, waiting for the resume
  const pausedAt = useStore((s) => (scope ? (s.companies.find((c) => c.id === scope)?.pausedAt ?? null) : null))
  const unpriced = useMemo(() => !!data?.activity.days.some((d) => d.byModel.some((m) => m.costUsd == null && m.tokens > 0)), [data])
  // focused mode: runs carry their company; schedules and learned facts are matched through the company's ids
  const own = scope && owned?.scope === scope ? owned : null
  const view = useMemo(() => {
    if (!data || !scope) return data ? { ...data, earlier } : null
    const ownRun = (id: Id | null | undefined): boolean => !!id && !!own?.runs.has(id)
    // a fact learned in a session has no run: its repository decides (never a fact of an unknown origin)
    const ownRepos = new Set(reposOf(repos, scope).map((r) => r.id))
    return {
      ...data,
      done: data.done.filter((c) => inScope(c.run, scope)),
      earlier: earlier.filter((c) => inScope(c.run, scope)),
      learned: data.learned.filter((f) => (f.runId ? ownRun(f.runId) : !!f.fact.repoId && ownRepos.has(f.fact.repoId))),
      comingUp: own ? data.comingUp.filter((c) => own.schedules.has(c.scheduleId)) : [],
      morningBrief: data.morningBrief && inScope(data.morningBrief, scope) ? data.morningBrief : null
    }
  }, [data, earlier, scope, own, repos])

  if (unsupported) return <ClassicHome />
  const pickSince = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'last', label: 'Since my last visit', type: 'checkbox', checked: mode === 'last' },
      { id: '24h', label: 'Last 24 hours', type: 'checkbox', checked: mode === '24h' },
      { id: '7d', label: 'Last 7 days', type: 'checkbox', checked: mode === '7d' }
    ])
    if (id === 'last' || id === '24h' || id === '7d') {
      setMode(id)
      load(id)
    }
  }
  const leftoverCount = leftovers.items?.length ?? 0
  // board tasks waiting on you (a running task waiting on a live ask is already one of the live rows: counted once)
  const taskNeeds = needsNow.tasks
  const needsTotal = needsNow.count

  return (
    <div className="view">
      <Toolbar
        title="Home"
        sub={
          data && (
            <button type="button" className="since-btn no-drag" onClick={() => void pickSince()} title="Change the window">
              {homeWindowLabel(mode, data.since, neverSeen.current)} <span className="text-tertiary">▾</span>
            </button>
          )
        }
      >
        {view && mode === 'last' && (view.done.length > 0 || view.learned.length > 0) && (
          <Button size="sm" variant="ghost" onClick={markAllSeen} title="Start “since you were last here” from now">
            Mark all seen
          </Button>
        )}
        <ProviderSwitcher />
      </Toolbar>
      <div className="scroll view__body">
        <div className="home home--dash">
          {error && !data ? (
            <ErrorState error={error} onRetry={() => load()} />
          ) : !data || !view ? (
            <Loading />
          ) : (
            <>
              {!briefing && <HomeGreeting className="home__greet" />}
              {pausedAt && scope && (
                <div className="banner banner--bar home__paused" role="status">
                  <span className="glyph" aria-hidden>‖</span> {companyName(scope)} is paused. Nothing starts until you resume it; other companies keep running.
                  <span className="flex1" />
                  <Button size="sm" variant="primary" icon="play" onClick={() => void setCompanyPaused(scope, false)}>
                    Resume
                  </Button>
                </div>
              )}
              {needsTotal > 0 || leftoverCount > 0 ? (
                <>
                  <NeedsYouHeader count={needsTotal > 0 ? <span className="text-needs">{needsTotal}</span> : undefined}>
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'chats', filter: 'live' })} title="Open Chats on Live">
                      Chats →
                    </Button>
                  </NeedsYouHeader>
                  {/* A4: what was raised before the pause stays, and says it waits for the resume */}
                  {pausedAt && <div className="home__waiting text-tertiary">‖ Waiting until you resume</div>}
                  {groups.needs.length > 0 && <div className="group-list hub__list">
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
                  </div>}
                  {taskNeeds > 0 && (
                    <div className="group-list home__tasks">
                      <NeedsYouTasks companyId={scope ?? undefined} skipLiveAsks playfulTop={groups.needs.length === 0} />
                    </div>
                  )}
                  {leftoverCount > 0 && (
                    <div className="home__leftovers">
                      <div className="hub__sub">Leftover processes</div>
                      <LeftoverList items={leftovers.items!} onChanged={leftovers.reload} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <NeedsYouHeader />
                  <NeedsYouEmpty />
                </>
              )}
              {/* CLOUD.md §0.1: one inbox. Cloud asks and passport facts; nothing when this Mac has no cloud */}
              <CloudNeedsYou companyId={scope ?? undefined} />

              {/* AUTOPILOT.md §2: the setup checklist of a focused business, from real state; leads to the autopilots */}
              {milestones && scope && <SetupChecklist companyId={scope} />}

              {/* one Latin phrase per screen (VOICE.md §1): with Otium on the empty Needs you above, the digest stays plain */}
              {briefing && scope && <SenateBriefing companyId={scope} since={pinnedSince.current ?? data.lastSeenAt ?? data.since} latin={needsTotal > 0} />}

              {view.morningBrief && <MorningBrief artifact={view.morningBrief} />}

              {milestones && scope && <MilestoneStrip companyId={scope} />}

              {view.done.length > 0 && (
                <>
                  <SectionHeader title="What got done" count={<DoneTally cards={view.done} />}>
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'canvas' })}>
                      Canvas →
                    </Button>
                  </SectionHeader>
                  <div className="rcards">
                    {view.done
                      .filter((c) => !isNothingToDo(c.run))
                      .map((c) => (
                        <RunCardView key={c.run.id} card={c} />
                      ))}
                  </div>
                  <NothingToDoLine cards={view.done} />
                </>
              )}

              {view.done.length === 0 && view.earlier.length > 0 && (
                <>
                  <SectionHeader title="What got done" count={<span className="text-tertiary">nothing new</span>} />
                  <button type="button" className="home__earlier link-btn" aria-expanded={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
                    {showEarlier ? '▾' : '▸'} Earlier ({view.earlier.length})
                  </button>
                  {showEarlier && (
                    <div className="rcards">
                      {view.earlier.map((c) => (
                        <RunCardView key={c.run.id} card={c} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {view.learned.length > 0 && (
                <>
                  <SectionHeader title="What agents learned" count={view.learned.length}>
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'memory' })}>
                      Memory →
                    </Button>
                  </SectionHeader>
                  <LearnedList facts={view.learned} />
                </>
              )}

              {data.activity.days.some((d) => d.runs > 0 || d.tokens > 0) && (
                <>
                  <SectionHeader title="Activity" />
                  <ActivityCharts days={data.activity.days} successRate={data.activity.successRate} providers={{ unpricedTokens: unpriced }} />
                </>
              )}

              <SectionHeader title="Working now" count={liveRoots.length || undefined}>
                <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'chats', filter: 'live' })} kbd="⇧⌘A">
                  Chats
                </Button>
              </SectionHeader>
              <div className="group-list hub__list">
                {liveRoots.length === 0 ? (
                  pausedAt ? (
                    <div className="home__quiet text-tertiary">Nothing working while {companyName(scope!)} is paused.</div>
                  ) : needsTotal > 0 ? (
                    <div className="home__quiet text-tertiary">
                      Nothing working · {needsTotal} waiting on you above.
                    </div>
                  ) : (
                    <EmptyState compact text="Nothing running.">
                      <Button size="sm" onClick={() => openPalette('newSession')} kbd="⌘N">
                        Start {providerLabel(settings?.defaultAdapter ?? 'claude')} session
                      </Button>
                    </EmptyState>
                  )
                ) : (
                  liveRoots.map((r) => <AgentRow key={r.id} idx={idx} root={r} asks={[]} seen={isSeen(r, seen)} compact />)
                )}
              </div>

              {view.comingUp.length > 0 && (
                <>
                  <SectionHeader title="Coming up">
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'schedules' })}>
                      Schedules →
                    </Button>
                  </SectionHeader>
                  <ComingUpList items={view.comingUp} paused={data.status.schedulesPaused} onChanged={() => load()} />
                </>
              )}
              <ClaudeHistorySection />
              {view.done.length === 0 && view.earlier.length === 0 && view.learned.length === 0 && needsTotal === 0 && (
                <div className="home__quiet text-tertiary">Nothing new {mode === 'last' ? 'since your last visit' : 'in this window'}.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** "3 runs had nothing to do" (AUTHORING.md §5): one muted line instead of a card each; click to list them. */
function NothingToDoLine({ cards }: { cards: DashboardData['done'] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const quiet = cards.filter((c) => isNothingToDo(c.run))
  if (!quiet.length) return null
  return (
    <div className="home__nothing">
      <button type="button" className="link-btn text-tertiary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {quiet.length} run{quiet.length === 1 ? '' : 's'} had nothing to do
      </button>
      {open && (
        <div className="home__nothing-list">
          {quiet.map((c) => (
            <button key={c.run.id} type="button" className="home__nothing-row" onClick={() => void navigate({ name: 'run', runId: c.run.id })} title={c.run.reason ?? undefined}>
              <span className="glyph glyph--quiet">–</span>
              <span>{runTitle(c.run, 48)}</span>
              {c.run.reason && <span className="text-tertiary"> · {firstLine(c.run.reason, 60)}</span>}
              <span className="flex1" />
              <span className="text-tertiary">
                <RelativeTime iso={c.run.endedAt ?? c.run.createdAt} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DoneTally({ cards }: { cards: DashboardData['done'] }): React.JSX.Element {
  return <RunTally runs={cards.map((c) => c.run)} />
}

/** The pre-live Home (main without app:dashboard): Running now, Last 24 hours, Next fires. */
function ClassicHome(): React.JSX.Element {
  useTick()
  const [data, setData] = useState<HomeData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const settings = useStore((s) => s.settings)

  const { scope, nonce } = useScope()
  const load = (): void => {
    hive.app.home().then(
      (d) => {
        // focused company (§8.4): its sessions and runs only
        setData(scope ? { ...d, runningSessions: d.runningSessions.filter((x) => inScope(x, scope)), activeRuns: d.activeRuns.filter((x) => inScope(x, scope)), recentRuns: d.recentRuns.filter((x) => inScope(x, scope)) } : d)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
  }
  useEffect(load, [nonce])
  const refetch = useCoalesced(load, 300)
  useHiveEvent('run:updated', refetch)
  useHiveEvent('session:updated', refetch)
  useHiveEvent('schedule:updated', refetch)
  useHiveEvent('status:changed', refetch)

  return (
    <div className="view">
      <Toolbar title="Home">
        <ProviderSwitcher />
      </Toolbar>
      <div className="scroll view__body">
        <div className="home">
          {error && !data ? (
            <ErrorState error={error} onRetry={load} />
          ) : !data ? (
            <Loading />
          ) : (
            <>
              <SectionHeader title="Running now" count={data.runningSessions.length + data.activeRuns.length || undefined} />
              <div className="group-list">
                {data.runningSessions.length + data.activeRuns.length === 0 ? (
                  <EmptyState compact text="Nothing running.">
                    <Button size="sm" onClick={() => openPalette('newSession')} kbd="⌘N">
                      Start {providerLabel(settings?.defaultAdapter ?? 'claude')} session
                    </Button>
                  </EmptyState>
                ) : (
                  <>
                    {data.runningSessions.map((s) => (
                      <div
                        key={s.id}
                        className="list-row"
                        onClick={() => focusSession(s.id)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          void sessionContextMenu(s)
                        }}
                      >
                        <StatusGlyph status="running" />
                        <span className="list-row__main">{sessionTitle(s)}</span>
                        <span className="list-row__meta">session · {age(s.startedAt)}</span>
                        <span className="list-row__actions">
                          <Button size="sm" onClick={(e) => (e.stopPropagation(), focusSession(s.id))}>
                            Open
                          </Button>
                          <Button size="sm" icon="stop" title="Kill" onClick={(e) => (e.stopPropagation(), void closeSession(s.id))} />
                        </span>
                      </div>
                    ))}
                    {data.activeRuns.map((r) => (
                      <RunRowItem key={r.id} run={r} />
                    ))}
                  </>
                )}
              </div>

              <SectionHeader
                title="Last 24 hours"
                count={
                  data.recentRuns.length ? <RunTally runs={data.recentRuns} /> : undefined
                }
              >
                <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'canvas' })}>
                  Show all
                </Button>
              </SectionHeader>
              <div className="group-list">
                {data.recentRuns.length === 0 ? (
                  <EmptyState compact text="No runs in the last 24 hours.">
                    <Button size="sm" onClick={() => openPalette('runWorkflow')}>
                      Run a Workflow
                    </Button>
                  </EmptyState>
                ) : (
                  data.recentRuns.map((r) => <RunRowItem key={r.id} run={r} />)
                )}
              </div>

              <SectionHeader title="Next fires">
                <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'schedules' })}>
                  Schedules →
                </Button>
              </SectionHeader>
              <div className="group-list">
                {data.status.schedulesPaused && <div className="banner banner--warning">Schedules are paused — nothing will fire.</div>}
                {data.nextFires.length === 0 ? (
                  <EmptyState compact text="Nothing scheduled.">
                    <Button size="sm" onClick={() => void navigate({ name: 'schedules', seed: {}, nonce: Date.now() })}>
                      New Schedule
                    </Button>
                  </EmptyState>
                ) : (
                  data.nextFires.map((f) => (
                    <div key={f.scheduleId} className="list-row" onClick={() => void navigate({ name: 'schedules', selectedId: f.scheduleId })}>
                      <StatusGlyph status="scheduled" />
                      <span className="list-row__main">{f.name}</span>
                      <span className="list-row__meta">
                        <RelativeTime iso={f.at} />
                      </span>
                      <span className="list-row__actions">
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            void attempt(() => hive.schedules.runNow({ id: f.scheduleId }), 'Run now').then((r) => r && toast(`Started ${f.name}`))
                          }}
                        >
                          Run Now
                        </Button>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** "3 ✓ 1 ✕" — zero counts are left out. */
function RunTally({ runs }: { runs: Run[] }): React.JSX.Element | null {
  const passed = runs.filter((r) => r.status === 'passed').length
  const failed = runs.filter((r) => r.status === 'failed').length
  if (!passed && !failed) return null
  return (
    <>
      {passed > 0 && <span className="text-success">{passed} ✓</span>}
      {passed > 0 && failed > 0 && ' '}
      {failed > 0 && <span className="text-failed">{failed} ✕</span>}
    </>
  )
}

function RunRowItem({ run: r }: { run: Run }): React.JSX.Element {
  const vs = runVisual(r.status)
  const active = r.status === 'running' || r.status === 'queued'
  return (
    <div
      className={`list-row ${r.status === 'failed' ? 'list-row--failed' : ''}`}
      onClick={() => void navigate({ name: 'run', runId: r.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        void runContextMenu(r)
      }}
      title={r.reason ?? undefined}
    >
      <StatusGlyph status={vs} />
      <span className="list-row__main">
        <span title={r.kind === 'prompt' && r.target.kind === 'prompt' ? r.target.prompt : undefined}>{runTitle(r, 60)}</span>
        {r.scheduleId && <Pill tone="scheduled">◷ scheduled</Pill>}
        {r.status === 'failed' && r.reason && <span className="list-row__reason">{firstLine(r.reason, 80)}</span>}
      </span>
      <span className="list-row__meta">
        {[r.startedAt ? clock(new Date(r.startedAt)) : 'queued', duration(r.startedAt, r.endedAt), r.artifactCount ? `▣ ${r.artifactCount}` : null].filter(Boolean).join(' · ')}
      </span>
      <span className="list-row__actions">
        {active ? (
          <Button size="sm" icon="stop" onClick={(e) => (e.stopPropagation(), void cancelRun(r))}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={(e) => (e.stopPropagation(), void rerun(r))}>
            Re-run
          </Button>
        )}
      </span>
    </div>
  )
}
