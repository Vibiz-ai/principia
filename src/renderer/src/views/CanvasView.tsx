import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasSnapshot, RunDetail, RunStep } from '@shared/types'
import { GraphView, PillContext } from '../components/GraphView'
import type { Id } from '@shared/types'
import { AgentTimeline } from '../components/agents/AgentTimeline'
import { AgentTree } from '../components/agents/AgentTree'
import { AskCard } from '../components/agents/AskCard'
import { ReplyBox } from '../components/agents/ReplyBox'
import { agentLabel, attributionNote, descendants, isIdleWaiting, type AgentIndex } from '../lib/live'
import { mergeAgents, useOpenAsks, useSeenSet } from '../state/live'
import { CompanyChip, useScope, useScopedLive } from '../components/CompanyChip'
import { inScope, labelGraphCompanies, scopeRows } from '../lib/scope'
import { reposOf } from '../lib/companyModel'
import { StepLog } from '../components/StepLog'
import { TerminalPane } from '../components/TerminalPane'
import { Button, EmptyState, ErrorState, IconButton, Loading, Pill, RelativeTime, StatusGlyph, Toolbar, useTick } from '../components/ui'
import type { ClaudeHistorySession } from '@shared/authoring'
import { TranscriptSheet } from '../components/history/TranscriptSheet'
import { ActivityCanvas } from '../components/activity/ActivityCanvas'
import { historyGroups, historyMeta, splitRecent } from '../lib/authoring'
import { useClaudeHistory } from '../state/history'
import {
  appendHistory,
  agentHierarchyGraph,
  applyRunUpdate,
  applyScheduleUpdate,
  applySessionUpdate,
  applyStepUpdate,
  canvasGraph,
  runVisual,
  stepVisual,
  type NodeRef
} from '../lib/graph'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { cancelRun, openAsSession, rerun, runContextMenu } from '../lib/runActions'
import { duration } from '../lib/time'
import { runTitle, sessionEndLabel, sessionPlace } from '../lib/format'
import { TaskRunChip } from '../components/board/TaskRunChip'
import { attempt, closeSession, companyName, focusSession, loadJson, navigate, openPalette, providerLabel, restartSession, saveJson, sessionContextMenu, toast, useStore } from '../state/store'

export function CanvasView({ focusRunId }: { focusRunId?: string }): React.JSX.Element {
  const tick = useTick()
  const [snap, setSnap] = useState<CanvasSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<{ ref: NodeRef; id: string; agentId?: Id | null } | null>(null)
  // COMPANY.md §8.3-8.4: focused mode draws the active company's work only; All mode labels cards with their company
  const { scope, chips, nonce } = useScope()
  const { idx, asks: openAsks } = useScopedLive(scope)
  const seen = useSeenSet()
  const [fitKey, setFitKey] = useState('init')
  useEffect(() => {
    setSel(null)
    setFitKey(`scope:${nonce}`)
  }, [nonce])
  const [canvasMode, setCanvasMode] = useState<'agents' | 'workflows'>(() => focusRunId ? 'workflows' : loadJson('principia.canvasMode', 'agents'))
  const [collapsedAgents, setCollapsedAgents] = useState<ReadonlySet<string>>(() => new Set())
  const toggleBranch = (agentId: string): void => {
    setCollapsedAgents(current => { const next = new Set(current); if (next.has(agentId)) next.delete(agentId); else next.add(agentId); return next })
  }
  const changeMode = (mode: 'agents' | 'workflows'): void => { setCanvasMode(mode); saveJson('principia.canvasMode', mode); setSel(null); setFitKey(`mode:${mode}:${Date.now()}`) }

  const [hint, setHint] = useState<boolean>(() => !loadJson('hive.canvasHintSeen', false))
  // History layer (AUTHORING.md §8.5, PO9): per-viewer toggle; fetched when it turns on and on window focus
  const [showHistory, setShowHistory] = useState<boolean>(() => loadJson('hive.canvasHistory', false))
  const historyOn = useStore((s) => s.settings?.claudeHistory !== false)
  const histSince = useMemo(() => new Date(Date.now() - 7 * 86_400_000).toISOString(), [])
  const hist = useClaudeHistory({ since: histSince, limit: 500 }, showHistory && historyOn)
  const [preview, setPreview] = useState<ClaudeHistorySession | null>(null)
  const toggleHistory = (): void => {
    setShowHistory((v) => {
      saveJson('hive.canvasHistory', !v)
      return !v
    })
    setFitKey(`hist:${Date.now()}`)
  }
  // USAGE.md §4: the portfolio Activity layer (All companies only); its watcher runs only while it is shown
  const [activityOn, setActivityOn] = useState<boolean>(() => loadJson('principia.canvasActivity', false))
  const showActivity = activityOn && !scope
  const toggleActivity = (): void => {
    setActivityOn((v) => {
      saveJson('principia.canvasActivity', !v)
      return !v
    })
    setSel(null)
  }
  const select = (ref: NodeRef, id: string): void => {
    if (ref.kind === 'history') {
      const h = hist.items.find((x) => x.id === ref.historyId)
      if (h) setPreview(h)
      else if (!ref.historyId) void navigate({ name: 'home' })
      return
    }
    if ((ref.kind === 'step' || ref.kind === 'run') && !snap?.runs.some(rd => rd.run.id === ref.runId)) ensureRun(ref.runId)
    const agentId = graph?.nodes.find(node => node.id === id)?.data.agentId
    setSel({ ref, id, agentId: typeof agentId === 'string' ? agentId : null })
    if (hint) {
      setHint(false)
      saveJson('hive.canvasHintSeen', true)
    }
  }

  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const load = (): void => {
    // COMPANY.md §8.3: focused mode asks for that company's snapshot (the run cap applies per company); read through
    // the ref so the focus/visibility listener (bound once) loads the current scope
    const forScope = scopeRef.current
    hive.app.canvas(forScope ? { companyId: forScope } : undefined).then(
      (s) => {
        if (forScope !== scopeRef.current) return
        setSnap(s)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [nonce])
  useEffect(() => mergeAgents(snap?.agents), [snap?.agents])
  // Coming back from the tray / from behind another app: resync from main instead of trusting the event stream.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  // a new or just-finished run: fetch its detail (workflow snapshot + final steps), merged with any steps
  // that arrived through run:step while the request was in flight
  const ensureRun = (runId: string): void => {
    void hive.runs.get({ id: runId }).then(
      (rd) =>
        setSnap((s) => {
          if (!s) return s
          const i = s.runs.findIndex((r) => r.run.id === runId)
          const runs = [...s.runs]
          if (i < 0) runs.unshift(rd)
          else runs[i] = mergeRunDetail(runs[i]!, rd)
          return { ...s, runs }
        }),
      () => undefined
    )
  }
  useHiveEvent('run:updated', (run) =>
    setSnap((s) => {
      if (!s) return s
      const known = s.runs.find((r) => r.run.id === run.id)
      const finished = run.status !== 'running' && run.status !== 'queued'
      if (!known || (!known.workflow && run.kind === 'workflow') || (finished && known.run.status !== run.status)) ensureRun(run.id)
      return applyRunUpdate(s, run)
    })
  )
  useHiveEvent('run:step', (step) => setSnap((s) => (s ? applyStepUpdate(s, step) : s)))
  useHiveEvent('session:updated', (sess) => setSnap((s) => (s ? applySessionUpdate(s, sess) : s)))
  useHiveEvent('schedule:updated', (sch) => setSnap((s) => (s ? applyScheduleUpdate(s, sch) : s)))
  useHiveEvent('data:changed', ({ domain }) => (domain === 'repos' || domain === 'profiles') && load())

  // focus the requested run once it is present
  useEffect(() => {
    if (!focusRunId || !snap) return
    const rd = snap.runs.find((r) => r.run.id === focusRunId)
    if (!rd) {
      ensureRun(focusRunId)
      return
    }
    const first = [...rd.steps].sort((a, b) => a.seq - b.seq)[0]
    const nodeId = first?.nodeId ?? rd.workflow?.nodes[0]?.id ?? 'prompt'
    setSel({ ref: { kind: 'step', runId: rd.run.id, nodeId, stepId: first?.id ?? null }, id: `r:${rd.run.id}:${nodeId}` })
    setFitKey(`run:${focusRunId}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunId, !!snap, snap?.runs.some((r) => r.run.id === focusRunId)])

  // sessions come from the app store: it already tracks restarts/removals, which the canvas snapshot never hears about
  const allSessions = useStore((st) => st.sessions)
  const allRepos = useStore((st) => st.repos)
  const storeSessions = useMemo(() => scopeRows(allSessions, scope), [allSessions, scope])
  const repos = useMemo(() => (scope ? reposOf(allRepos, scope) : allRepos), [allRepos, scope])
  const scopedSnap = useMemo(
    () => (snap && scope ? { ...snap, runs: snap.runs.filter((rd) => inScope(rd.run, scope)), schedules: scopeRows(snap.schedules, scope), sessions: scopeRows(snap.sessions, scope) } : snap),
    [snap, scope]
  )
  const lanes = useMemo(() => {
    if (!showHistory || !historyOn || !hist.items.length) return []
    const now = Date.now()
    // focused: only conversations in this company's repositories (history outside a repo has no company)
    const items = scope ? hist.items.filter((h) => repos.some((r) => r.id === h.repoId || (!!h.cwd && (h.cwd === r.path || h.cwd.startsWith(`${r.path}/`))))) : hist.items
    return historyGroups(items, repos).map((g) => {
      const { shown, older } = splitRecent(g.items, now)
      return { key: g.key, label: g.label, older, cards: shown.map((h) => ({ id: h.id, title: h.title || 'Untitled', sub: [historyMeta(h), relativeShort(h.endedAt ?? h.startedAt)].filter(Boolean).join(' · ') })) }
    })
  }, [showHistory, historyOn, hist.items, repos, scope, tick])
  const graph = useMemo(() => {
    if (!scopedSnap) return null
    const live = { idx, asks: openAsks, seen }
    const workflowGraph = canvasGraph({ ...scopedSnap, sessions: storeSessions }, Date.now(), live)
    const lookups = { sessions: storeSessions, runs: scopedSnap.runs.map((rd) => rd.run), schedules: scopedSnap.schedules }
    const label = (g: ReturnType<typeof canvasGraph>): ReturnType<typeof canvasGraph> => (chips ? labelGraphCompanies(g, lookups, (id) => companyName(id)) : g)
    if (canvasMode === 'workflows') return appendHistory(label(workflowGraph), lanes)
    const refs = new Map<string, NodeRef>()
    for (const node of workflowGraph.nodes) if (node.type === 'card' && node.data.agentId) refs.set(node.data.agentId, node.data.ref)
    return label(agentHierarchyGraph(live, collapsedAgents, Date.now(), refs))
  }, [scopedSnap, storeSessions, tick, idx, openAsks, seen, lanes, canvasMode, collapsedAgents, chips])
  const agentCounts = useMemo(() => {
    const agents = [...idx.byId.values()]
    return { total: agents.length, working: agents.filter(a => a.status === 'working' || a.status === 'starting').length, failed: agents.filter(a => a.status === 'failed').length }
  }, [idx])
  const onPill = useMemo(() => (nodeId: string, ref: NodeRef, agentId: string) => {
    if ((ref.kind === 'step' || ref.kind === 'run') && !snap?.runs.some(rd => rd.run.id === ref.runId)) ensureRun(ref.runId)
    setSel({ ref, id: nodeId, agentId })
  }, [snap])

  const onOpen = (ref: NodeRef): void => {
    if (ref.kind === 'session') focusSession(ref.sessionId)
    if (ref.kind === 'step' || ref.kind === 'run') void navigate({ name: 'run', runId: ref.runId, stepId: ref.kind === 'step' ? (ref.stepId ?? undefined) : undefined })
    if (ref.kind === 'schedule') void navigate({ name: 'schedules', selectedId: ref.scheduleId })
  }
  const onContext = (ref: NodeRef): void => {
    if (!snap) return
    if (ref.kind === 'session') {
      const s = storeSessions.find((x) => x.id === ref.sessionId)
      if (s) void sessionContextMenu(s)
    } else if (ref.kind === 'step' || ref.kind === 'run') {
      const r = snap.runs.find((x) => x.run.id === ref.runId)
      if (r) void runContextMenu(r.run)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && sel) {
        e.preventDefault()
        setSel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  const empty = !!graph && graph.nodes.length === 0
  return (
    <div className="view">
      <Toolbar title="Activity">
        <div className="canvas-modes" role="group" aria-label="Canvas view">
          <Button variant={canvasMode === 'agents' && !showActivity ? 'secondary' : 'ghost'} aria-pressed={canvasMode === 'agents' && !showActivity} onClick={() => { if (showActivity) toggleActivity(); changeMode('agents') }}>Agents</Button>
          <Button variant={canvasMode === 'workflows' && !showActivity ? 'secondary' : 'ghost'} aria-pressed={canvasMode === 'workflows' && !showActivity} onClick={() => { if (showActivity) toggleActivity(); changeMode('workflows') }}>Workflows</Button>
        </div>
        {canvasMode === 'agents' && !showActivity && <span className="canvas-agent-summary" aria-live="polite">{agentCounts.total} agents{agentCounts.working > 0 ? ` · ${agentCounts.working} running` : ''}{agentCounts.failed > 0 ? ` · ${agentCounts.failed} failed` : ''}</span>}
        <Button onClick={() => void navigate({ name: 'marketplace' })} title="Find workflows, Claude Code agents and skills to install">
          Marketplace
        </Button>
        {!scope && (
          <Button
            variant={showActivity ? 'secondary' : 'ghost'}
            aria-pressed={showActivity}
            onClick={toggleActivity}
            title="Every Claude session on this Mac, by company: Principia's agents and your own terminals (read-only)"
          >
            Activity
          </Button>
        )}
        {historyOn && canvasMode === 'workflows' && !showActivity && (
          <Button
            variant={showHistory ? 'secondary' : 'ghost'}
            aria-pressed={showHistory}
            onClick={toggleHistory}
            title="Show your Claude Code sessions from outside Principia (read-only), grouped by repository"
          >
            History{showHistory && hist.indexing ? ' · indexing…' : ''}
          </Button>
        )}
        <Button onClick={() => window.dispatchEvent(new CustomEvent('hive:zoom', { detail: 'reset' }))} kbd="⌘0">
          Fit
        </Button>
      </Toolbar>
      <div className="canvas">
        {showActivity ? (
          <ActivityCanvas idx={idx} />
        ) : error && !snap ? (
          <ErrorState error={error} onRetry={load} />
        ) : !snap || !graph ? (
          <Loading />
        ) : empty ? (
          <EmptyState icon="canvas" text={canvasMode === 'agents' ? `Your agent team will appear here when a session or workflow starts${scope ? ' in this company' : ''}.` : scope ? 'Nothing running or scheduled in this company.' : 'Nothing running or scheduled.'}>
            <Button variant="primary" onClick={() => openPalette('runWorkflow')}>
              Run a Workflow
            </Button>
            <Button onClick={() => void navigate({ name: 'marketplace' })}>Browse Marketplace</Button>
          </EmptyState>
        ) : (
          <PillContext.Provider value={onPill}>
          <GraphView
            onToggleBranch={toggleBranch}
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={sel?.id}
            onSelect={select}
            onOpen={onOpen}
            onContext={onContext}
            fitKey={fitKey}
            focusNodeId={canvasMode === 'workflows' && focusRunId ? `f:run:${focusRunId}` : null}
            keyboard
          />
          </PillContext.Provider>
        )}
        {hint && !showActivity && !sel && snap && graph && !empty && (
          <div className="canvas__hint" role="note">
            {canvasMode === 'agents' ? 'Follow the team from parent to subagent · click a card to inspect · collapse branches with the agent count' : 'Click any node to inspect its live terminal or log · double-click to open'}
            <IconButton
              icon="close"
              label="Dismiss"
              onClick={() => {
                setHint(false)
                saveJson('hive.canvasHintSeen', true)
              }}
            />
          </div>
        )}
        {preview && <TranscriptSheet session={preview} onClose={() => setPreview(null)} />}
        {sel && snap && !showActivity && <Drawer sel={sel.ref} snap={snap} idx={idx} agentId={sel.agentId ?? null} onAgent={(agentId) => setSel((s) => (s ? { ...s, agentId } : s))} onClose={() => setSel(null)} />}
      </div>
    </div>
  )
}

/** "2h ago" for history cards; absolute past a day. */
function relativeShort(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/** Keep the fresher copy of each step: the fetched detail may predate run:step events applied meanwhile. */
function mergeRunDetail(local: RunDetail, fetched: RunDetail): RunDetail {
  const rank = (st: RunStep): number => (st.endedAt ? 2 : st.startedAt ? 1 : 0)
  const byId = new Map(fetched.steps.map((st) => [st.id, st]))
  for (const st of local.steps) {
    const f = byId.get(st.id)
    if (!f || rank(st) > rank(f)) byId.set(st.id, st)
  }
  const run = local.run.status !== 'running' && local.run.status !== 'queued' && (fetched.run.status === 'running' || fetched.run.status === 'queued') ? local.run : fetched.run
  return { ...fetched, run, steps: [...byId.values()].sort((a, b) => a.seq - b.seq) }
}

function Drawer({ sel, snap, idx, agentId, onAgent, onClose }: { sel: NodeRef; snap: CanvasSnapshot; idx: AgentIndex; agentId: Id | null; onAgent: (id: Id | null) => void; onClose: () => void }): React.JSX.Element | null {
  useTick()
  const sessions = useStore((st) => st.sessions)
  const fontSize = useStore((s) => s.settings?.terminalFontSize ?? 13)
  const [width, setWidth] = useState(400)
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    const move = (ev: MouseEvent): void => setWidth(Math.min(800, Math.max(320, w0 - (ev.clientX - x0))))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  let body: React.JSX.Element | null = null
  if (sel.kind === 'session') {
    const s = sessions.find((x) => x.id === sel.sessionId)
    if (!s) return null
    body = (
      <>
        <div className="drawer__head">
          <StatusGlyph status={s.status === 'running' ? 'running' : 'exited'} />
          <div className="drawer__title">{s.title}</div>
          <CompanyChip companyId={s.companyId} always className="drawer__company" />
          <TaskRunChip sessionId={s.id} />
          <div className="drawer__sub mono">
            {s.adapter === 'shell' ? 'Terminal' : providerLabel(s.adapter)} · {sessionPlace(s)}
            {s.status !== 'running' && ` · ${sessionEndLabel(s)}`}
          </div>
        </div>
        <DrawerAgents idx={idx} rootId={idx.roots.find((r) => r.kind === 'session' && r.sessionId === s.id)?.id ?? null} agentId={agentId} onAgent={onAgent} />
        {agentId && idx.byId.get(agentId)?.kind === 'subagent' ? (
          <div className="drawer__body">
            <AgentTimeline agentId={agentId} note={attributionNote(idx.byId.get(agentId)!)} />
          </div>
        ) : (
          <div className="drawer__body drawer__body--term">
            <TerminalPane sessionId={s.id} readOnly={s.status !== 'running'} fontSize={Math.max(10, fontSize - 1)} focused={false} />
          </div>
        )}
        <div className="drawer__actions">
          {s.status === 'running' ? (
            <Button icon="stop" onClick={() => void closeSession(s.id)}>
              Kill
            </Button>
          ) : (
            <Button onClick={() => void restartSession(s.id)}>Restart</Button>
          )}
          <span className="flex1" />
          <Button variant="primary" onClick={() => focusSession(s.id)}>
            Open Session
          </Button>
        </div>
      </>
    )
  } else if (sel.kind === 'step' || sel.kind === 'run') {
    const rd = snap.runs.find((r) => r.run.id === sel.runId)
    if (!rd) return null
    const selectedAgent = agentId ? idx.byId.get(agentId) : undefined
    const owner = selectedAgent ? idx.byId.get(selectedAgent.rootId) : undefined
    body = <StepDrawer rd={rd} nodeId={sel.kind === 'step' ? sel.nodeId : null} selectedStepId={owner?.stepId ?? (sel.kind === 'step' ? sel.stepId : null)} idx={idx} agentId={agentId} onAgent={onAgent} />
  } else if (sel.kind === 'schedule') {
    const sch = snap.schedules.find((x) => x.id === sel.scheduleId)
    if (!sch) return null
    body = (
      <>
        <div className="drawer__head">
          <StatusGlyph status="scheduled" />
          <div className="drawer__title">{sch.name}</div>
          <CompanyChip companyId={sch.companyId} always className="drawer__company" />
          <div className="drawer__sub">{sch.sentence}</div>
        </div>
        <div className="drawer__body drawer__body--pad">
          <div className="kv">
            <span>Next</span>
            <span>{sch.nextFireAt ? <RelativeTime iso={sch.nextFireAt} /> : '—'}</span>
            <span>Last</span>
            <span>{sch.lastFireAt ? <RelativeTime iso={sch.lastFireAt} /> : 'never'}</span>
            <span>Result</span>
            <span>{sch.lastRunStatus ?? '—'}</span>
          </div>
        </div>
        <div className="drawer__actions">
          <Button onClick={() => void attempt(() => hive.schedules.runNow({ id: sch.id }), 'Run now').then((r) => r && toast(`Started ${sch.name}`))}>Run Now</Button>
          <span className="flex1" />
          <Button variant="primary" onClick={() => void navigate({ name: 'schedules', selectedId: sch.id })}>
            Open Schedule
          </Button>
        </div>
      </>
    )
  } else if (sel.kind === 'repo') {
    return null
  }
  return (
    <aside className="drawer" style={{ width }}>
      <div className="drawer__resizer" onMouseDown={startResize} />
      <IconButton className="drawer__close" icon="close" label="Close (Esc)" onClick={onClose} />
      {body}
    </aside>
  )
}

/**
 * Drawer agent section (LIVE.md §11): open asks of this node's tree answered inline (or the idle Reply box), then the
 * subagent tree. Selecting a subagent shows its timeline in the drawer body; selecting the root goes back.
 */
function DrawerAgents({ idx, rootId, agentId, onAgent }: { idx: AgentIndex; rootId: Id | null; agentId: Id | null; onAgent: (id: Id | null) => void }): React.JSX.Element | null {
  const asks = useOpenAsks()
  if (!rootId) return null
  const root = idx.byId.get(rootId)
  if (!root) return null
  const tree = new Set([rootId, ...descendants(idx, rootId).map((d) => d.agent.id)])
  const mine = asks.filter((a) => tree.has(a.agentId))
  const hasKids = !!idx.children.get(rootId)?.length
  const sub = agentId && agentId !== rootId ? idx.byId.get(agentId) : null
  if (!mine.length && !hasKids && !isIdleWaiting(root)) return null
  return (
    <div className="drawer__agents">
      {mine.map((a, i) => (
        <AskCard key={a.id} ask={a} compact hotkeys={i === 0} />
      ))}
      {!mine.length && isIdleWaiting(root) && <ReplyBox agent={root} />}
      {hasKids && (
        <>
          <div className="drawer__agents-head">
            <span>Subagents</span>
            {sub && (
              <button type="button" className="link-btn" onClick={() => onAgent(null)}>
                Back to {root.kind === 'session' ? 'terminal' : 'log'}
              </button>
            )}
          </div>
          <div className="drawer__agents-tree scroll">
            <AgentTree idx={idx} parentId={rootId} askAgents={new Set(mine.map((a) => a.agentId))} selectedId={agentId} onSelect={(a) => onAgent(a.id)} />
          </div>
          {sub && <div className="drawer__agents-sel text-secondary">{agentLabel(sub)}</div>}
        </>
      )}
    </div>
  )
}

function StepDrawer({ rd, nodeId, selectedStepId, idx, agentId, onAgent }: { rd: RunDetail; nodeId: string | null; selectedStepId?: Id | null; idx: AgentIndex; agentId: Id | null; onAgent: (id: Id | null) => void }): React.JSX.Element {
  const steps = rd.steps
  let step: RunStep | undefined
  for (const s of steps) if ((selectedStepId ? s.id === selectedStepId : nodeId === null || s.nodeId === nodeId) && (!step || s.seq > step.seq)) step = s
  const run = rd.run
  const active = run.status === 'running' || run.status === 'queued'
  const node = rd.workflow?.nodes.find((n) => n.id === nodeId)
  return (
    <>
      <div className="drawer__head">
        <StatusGlyph status={step ? stepVisual(step.status) : runVisual(run.status)} />
        <div className="drawer__title">{nodeId && nodeId !== 'prompt' ? (node?.label ?? nodeId) : runTitle(run)}</div>
        <CompanyChip companyId={run.companyId} always className="drawer__company" />
        <TaskRunChip runId={run.id} taskId={(run as { taskId?: Id | null }).taskId} />
        <div className="drawer__sub">
          {step ? (
            <>
              {[step.nodeType !== 'prompt' && step.nodeType !== 'shell' && step.nodeType !== step.nodeId ? step.nodeType : null, step.adapter === 'shell' ? 'shell command' : providerLabel(step.adapter)].filter(Boolean).join(' · ')}
              {step.attempt > 1 && ` · attempt ${step.attempt}`}
              {step.round != null && ` · round ${step.round}${step.participantLabel ? ` (${step.participantLabel})` : ''}`} · {duration(step.startedAt, step.endedAt)}
              {step.verdict && (
                <>
                  {' '}
                  <Pill tone={step.verdict === 'PASS' ? 'passed' : 'failed'}>VERDICT: {step.verdict}</Pill>
                </>
              )}
            </>
          ) : (
            <>
              {runTitle(run)} · {active ? 'waiting' : nodeId ? 'not run' : run.status}
            </>
          )}
        </div>
        {run.reason && <div className="callout callout--failed selectable">{run.reason}</div>}
      </div>
      {step && <DrawerAgents idx={idx} rootId={idx.roots.find((r) => r.stepId === step!.id)?.id ?? null} agentId={agentId} onAgent={onAgent} />}
      <div className="drawer__body">
        {step && agentId && idx.byId.get(agentId)?.kind === 'subagent' ? (
          <AgentTimeline agentId={agentId} note={attributionNote(idx.byId.get(agentId)!)} />
        ) : step ? (
          <StepLog runId={run.id} stepId={step.id} live={step.status === 'running'} />
        ) : (
          <EmptyState compact text={active ? 'This step hasn’t started yet.' : run.status === 'failed' ? 'The run failed before this step started.' : 'This step didn’t run.'} />
        )}
      </div>
      <div className="drawer__actions">
        {active ? (
          <Button icon="stop" onClick={() => void cancelRun(run)}>
            Cancel Run
          </Button>
        ) : (
          <Button onClick={() => void rerun(run)}>Re-run</Button>
        )}
        {step && step.adapter !== 'shell' && <Button onClick={() => void openAsSession(run.id, step!.id)}>Open as Session</Button>}
        <span className="flex1" />
        <Button variant="primary" onClick={() => void navigate({ name: 'run', runId: run.id, stepId: step?.id })}>
          Open Run
        </Button>
      </div>
    </>
  )
}
