import { useEffect, useMemo, useRef, useState } from 'react'
import type { HomeData, Run } from '@shared/types'
import type { DashboardData } from '@shared/live'
import { AgentRow } from '../components/agents/AgentTree'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { LeftoverList, useLeftovers } from '../components/agents/LimitBits'
import { ActivityCharts } from '../components/home/ActivityCharts'
import { ComingUpList, LearnedList, MorningBrief, RunCardView } from '../components/home/DashboardParts'
import { ClaudeHistorySection } from '../components/home/ClaudeHistory'
import { isNothingToDo } from '../lib/authoring'
import { homeWindowLabel, hubGroups, isLive, isSeen, isUnseenIdle } from '../lib/live'
import { focusAgent, mergeAgents, mergeAsks, useAgentIndex, useOpenAsks, useSeenSet } from '../state/live'
import { nativeMenu } from '../lib/hive'
import { Button, EmptyState, ErrorState, Loading, Pill, RelativeTime, SectionHeader, StatusGlyph, Switch, Toolbar, useTick } from '../components/ui'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { runVisual } from '../lib/graph'
import { firstLine, runTitle } from '../lib/format'
import { age, clock, duration } from '../lib/time'
import { useCoalesced } from '../lib/useThrottled'

import { cancelRun, rerun, runContextMenu } from '../lib/runActions'
import { ProviderSwitcher } from '../shell/ProviderSwitcher'
import {
  addRepos,
  attempt,
  closeSession,
  focusSession,
  navigate,
  openPalette,
  providerLabel,
  refreshProviders,
  sessionContextMenu,
  sessionTitle,
  startSession,
  toast,
  updateSettings,
  useStore
} from '../state/store'

type SinceMode = 'last' | '24h' | '7d'
const SEEN_DWELL_MS = 8000

/**
 * Home: "since you were last here" (LIVE.md §8, F5). Needs you · What got done · What agents learned · Activity ·
 * Live now · Coming up · Morning brief. Real data only, from one app:dashboard call, then live via events.
 * Falls back to the classic Home when main doesn't serve app:dashboard.
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
  const idx = useAgentIndex()
  const asks = useOpenAsks()
  const seen = useSeenSet()

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
    hive.app.dashboard(since ? { since } : undefined).then(
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
          void hive.app.dashboard({ since: new Date(Date.now() - 7 * 864e5).toISOString() }).then((e) => setEarlier(e.done), () => setEarlier([]))
        } else setEarlier([])
      },
      (e) => {
        if (/not implemented/i.test(errorMessage(e))) setUnsupported(true)
        else setError(errorMessage(e))
      }
    )
  }
  useEffect(() => load(), [])
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
  const groups = useMemo(() => hubGroups(idx.roots, asks, seen), [idx, asks, seen])
  // Live now leaves out what is already listed under Needs you
  const liveRoots = useMemo(() => {
    const needIds = new Set(groups.needs.map((g) => g.root.id))
    return idx.roots.filter((r) => isLive(r) && !needIds.has(r.id)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  }, [idx, groups])
  const unpriced = useMemo(() => !!data?.activity.days.some((d) => d.byModel.some((m) => m.costUsd == null && m.tokens > 0)), [data])

  if (unsupported) return <ClassicHome />
  const showOnboarding = settings && !settings.onboardingDone && repos.length === 0
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
  const needsCount = groups.needs.reduce((n, g) => n + (g.asks.length || 1), 0)
  const leftoverCount = leftovers.items?.length ?? 0

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
        {data && mode === 'last' && (data.done.length > 0 || data.learned.length > 0) && (
          <Button size="sm" variant="ghost" onClick={markAllSeen} title="Start “since you were last here” from now">
            Mark all seen
          </Button>
        )}
        <ProviderSwitcher />
      </Toolbar>
      <div className="scroll view__body">
        <div className="home home--dash">
          {showOnboarding && <Onboarding />}
          {error && !data ? (
            <ErrorState error={error} onRetry={() => load()} />
          ) : !data ? (
            <Loading />
          ) : (
            <>
              {(groups.needs.length > 0 || leftoverCount > 0) && (
                <>
                  <SectionHeader title="Needs you" count={<span className="text-needs">{needsCount + (leftoverCount ? 1 : 0)}</span>}>
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'agents' })}>
                      Agents →
                    </Button>
                  </SectionHeader>
                  <div className="group-list hub__list">
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
                  </div>
                  {leftoverCount > 0 && (
                    <div className="home__leftovers">
                      <div className="hub__sub">Leftover processes</div>
                      <LeftoverList items={leftovers.items!} onChanged={leftovers.reload} />
                    </div>
                  )}
                </>
              )}

              {data.morningBrief && <MorningBrief artifact={data.morningBrief} />}

              {data.done.length > 0 && (
                <>
                  <SectionHeader title="What got done" count={<DoneTally cards={data.done} />}>
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'canvas' })}>
                      Canvas →
                    </Button>
                  </SectionHeader>
                  <div className="rcards">
                    {data.done
                      .filter((c) => !isNothingToDo(c.run))
                      .map((c) => (
                        <RunCardView key={c.run.id} card={c} />
                      ))}
                  </div>
                  <NothingToDoLine cards={data.done} />
                </>
              )}

              {data.done.length === 0 && earlier.length > 0 && (
                <>
                  <SectionHeader title="What got done" count={<span className="text-tertiary">nothing new</span>} />
                  <button type="button" className="home__earlier link-btn" aria-expanded={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
                    {showEarlier ? '▾' : '▸'} Earlier ({earlier.length})
                  </button>
                  {showEarlier && (
                    <div className="rcards">
                      {earlier.map((c) => (
                        <RunCardView key={c.run.id} card={c} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {data.learned.length > 0 && (
                <>
                  <SectionHeader title="What agents learned" count={data.learned.length}>
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'memory' })}>
                      Memory →
                    </Button>
                  </SectionHeader>
                  <LearnedList facts={data.learned} />
                </>
              )}

              {data.activity.days.some((d) => d.runs > 0 || d.tokens > 0) && (
                <>
                  <SectionHeader title="Activity" />
                  <ActivityCharts days={data.activity.days} successRate={data.activity.successRate} providers={{ unpricedTokens: unpriced }} />
                </>
              )}

              <SectionHeader title="Live now" count={liveRoots.length || undefined}>
                <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'agents' })} kbd="⇧⌘A">
                  Agents
                </Button>
              </SectionHeader>
              <div className="group-list hub__list">
                {liveRoots.length === 0 ? (
                  groups.needs.length > 0 ? (
                    <div className="home__quiet text-tertiary">
                      Nothing working · {groups.needs.length} waiting on you above.
                    </div>
                  ) : (
                    <EmptyState compact text="Nothing running.">
                      <Button size="sm" onClick={() => openPalette('newSession')} kbd="⌘N">
                        Start {providerLabel(settings?.defaultAdapter ?? 'claude')} session
                      </Button>
                    </EmptyState>
                  )
                ) : (
                  liveRoots.map((r) => <AgentRow key={r.id} idx={idx} root={r} asks={[]} seen={isSeen(r, seen)} compact dim={r.status === 'idle' || r.needs === 'idle'} />)
                )}
              </div>

              {data.comingUp.length > 0 && (
                <>
                  <SectionHeader title="Coming up">
                    <Button size="sm" variant="ghost" onClick={() => void navigate({ name: 'schedules' })}>
                      Schedules →
                    </Button>
                  </SectionHeader>
                  <ComingUpList items={data.comingUp} paused={data.status.schedulesPaused} onChanged={() => load()} />
                </>
              )}
              <ClaudeHistorySection />
              {data.done.length === 0 && earlier.length === 0 && data.learned.length === 0 && groups.needs.length === 0 && leftoverCount === 0 && (
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
  const repos = useStore((s) => s.repos)
  const settings = useStore((s) => s.settings)

  const load = (): void => {
    hive.app.home().then(
      (d) => {
        setData(d)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
  }
  useEffect(load, [])
  const refetch = useCoalesced(load, 300)
  useHiveEvent('run:updated', refetch)
  useHiveEvent('session:updated', refetch)
  useHiveEvent('schedule:updated', refetch)
  useHiveEvent('status:changed', refetch)

  const showOnboarding = settings && !settings.onboardingDone && repos.length === 0

  return (
    <div className="view">
      <Toolbar title="Home">
        <ProviderSwitcher />
      </Toolbar>
      <div className="scroll view__body">
        <div className="home">
          {showOnboarding && <Onboarding />}
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

function Onboarding(): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const agents = providers.filter((p) => p.id !== 'shell')
  return (
    <div className="onboarding">
      <div className="onboarding__title">Welcome to Hive</div>
      <div className="onboarding__step">
        <span className="onboarding__num">1</span>
        <span className="flex1">Add your repositories</span>
        <Button variant="primary" icon="folder" onClick={() => void addRepos()}>
          Choose Folders…
        </Button>
      </div>
      <div className="onboarding__step">
        <span className="onboarding__num">2</span>
        <span className="flex1">
          Agents found:{' '}
          {agents.length === 0
            ? 'checking…'
            : agents.map((p) => (
                <span key={p.id} className={`onboarding__agent ${p.available ? '' : 'text-tertiary'}`} title={p.available ? (p.binPath ?? '') : p.installHint}>
                  {p.available ? '✓' : '⊘'} {p.label}
                  {p.version ? ` ${p.version}` : ''}
                </span>
              ))}
        </span>
        <Button icon="refresh" onClick={() => void attempt(() => refreshProviders(true), 'Recheck')}>
          Recheck
        </Button>
      </div>
      <div className="onboarding__step">
        <span className="onboarding__num">3</span>
        <span className="flex1">Keep schedules firing — Launch at Login</span>
        <Switch checked={!!settings?.launchAtLogin} onChange={(v) => void updateSettings({ launchAtLogin: v })} label="Launch at Login" />
      </div>
      <div className="onboarding__footer">
        <Button variant="ghost" onClick={() => void updateSettings({ onboardingDone: true })}>
          Dismiss
        </Button>
        <Button icon="terminal" onClick={() => void startSession({ repoId: null })}>
          Start a {providerLabel(settings?.defaultAdapter ?? 'claude')} session
        </Button>
      </div>
    </div>
  )
}
