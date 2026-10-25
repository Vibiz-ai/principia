import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CollabWake, RunConversation } from '@shared/collab'
import '../styles/agentTalk.css'
import type { Artifact, RunDetail, RunStep, RunWorktree } from '@shared/types'
import type { AgentNode } from '@shared/live'
import { AgentGlyph, Elapsed, NeedsBadge } from '../components/agents/AgentBits'
import { LimitActions, StalledBadge, runLimitTarget } from '../components/agents/LimitBits'
import { AgentTimeline } from '../components/agents/AgentTimeline'
import { AgentTree } from '../components/agents/AgentTree'
import { AskCard } from '../components/agents/AskCard'
import { AgentMemoryChip } from '../components/memory/MemoryChips'
import { activityLine, agentLabel, agentVisual, attributionNote, costOrTokens, descendants, treeMemReads } from '../lib/live'
import { mergeAgents, useAgentIndex, useOpenAsks } from '../state/live'
import { ArtifactThumb } from '../components/ArtifactThumb'
import { LogText, StepLog } from '../components/StepLog'
import { Button, EmptyState, ErrorState, IconButton, Loading, Pill, Segmented, StatusGlyph, Toolbar, useTick } from '../components/ui'
import { Icon } from '../components/Icon'
import { StepMemoryChip, StepMemoryMark, useMemoryGrants } from '../components/memory/MemoryChips'
import { runVisual, stepVisual } from '../lib/graph'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { cancelRun, openAsSession, rerun } from '../lib/runActions'
import { duration, tooltipTime } from '../lib/time'
import { runTitle, tildify } from '../lib/format'
import { canRemoveWorktree, isNothingToDo, runStatusLabel, worktreeChip } from '../lib/authoring'
import { attempt, focusSession, goBack, navigate, toast, useStore } from '../state/store'
import type { SlackDraft, SlackRunContext } from '@shared/slack'
import { SlackDraftCard } from '../components/slack/SlackDraftCard'
import { slackCall } from '../lib/slackApi'
import { useSlack } from '../state/slack'
import { TaskStrip } from '../components/board/TaskStrip'

type Tab = 'output' | 'activity' | 'result' | 'prompt'

export function RunView({ runId, stepId, agentId }: { runId: string; stepId?: string; agentId?: string }): React.JSX.Element {
  useTick()
  const [rd, setRd] = useState<RunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selStep, setSelStep] = useState<string | null>(stepId ?? null)
  const [tab, setTab] = useState<Tab>('output')
  const [raw, setRaw] = useState(false)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [scheduleName, setScheduleName] = useState<string | null>(null)
  const repos = useStore((s) => s.repos)
  const memGrants = useMemoryGrants({ runId })
  const idx = useAgentIndex()
  const openAsks = useOpenAsks()
  const focusNonce = useStore((s) => s.agentFocus?.nonce)
  const [selAgent, setSelAgent] = useState<string | null>(null)
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  // the whole agent tree of this run (ended subagents too), then live via events
  useEffect(() => {
    void hive.agents.list({ runId, limit: 1000 }).then(mergeAgents, () => undefined)
  }, [runId])
  const stepRoot = useMemo(() => {
    const m = new Map<string, AgentNode>()
    for (const r of idx.roots) if (r.runId === runId && r.stepId) m.set(r.stepId, r)
    return m
  }, [idx, runId])
  const runAsks = useMemo(() => openAsks.filter((a) => a.runId === runId), [openAsks, runId])
  // jump to a subagent / ask (hub row, ⌘J, notification)
  useEffect(() => {
    if (!agentId) return
    const a = idx.byId.get(agentId)
    if (!a) return
    const root = a.kind === 'subagent' ? idx.byId.get(a.rootId) : a
    if (root?.stepId) {
      setSelStep(root.stepId)
      setOpenSteps((o) => ({ ...o, [root.stepId!]: true }))
    }
    setSelAgent(a.kind === 'subagent' ? a.id : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, focusNonce, !!idx.byId.get(agentId ?? '')])

  const load = (): void => {
    hive.runs.get({ id: runId }).then(
      (d) => {
        setRd(d)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
    hive.artifacts.list({ runId }).then(setArtifacts, () => undefined)
  }
  useEffect(load, [runId])
  useEffect(() => setSelStep(stepId ?? null), [runId, stepId])
  useEffect(() => setSelAgent(null), [runId])
  useEffect(() => {
    if (!rd?.run.scheduleId) return setScheduleName(null)
    void hive.schedules.list().then((l) => setScheduleName(l.find((s) => s.id === rd.run.scheduleId)?.name ?? null), () => undefined)
  }, [rd?.run.scheduleId])

  useHiveEvent('run:updated', (run) => run.id === runId && setRd((d) => (d ? { ...d, run } : d)))
  useHiveEvent('run:step', (step) => {
    if (step.runId !== runId) return
    setRd((d) => {
      if (!d) return d
      const i = d.steps.findIndex((s) => s.id === step.id)
      const steps = i < 0 ? [...d.steps, step] : d.steps.map((s) => (s.id === step.id ? step : s))
      return { ...d, steps: steps.sort((a, b) => a.seq - b.seq) }
    })
  })
  useHiveEvent('worktree:updated', (wt) => wt.runId === runId && setRd((d) => (d ? { ...d, run: { ...d.run, worktree: wt } } : d)))
  useHiveEvent('artifact:added', (a) => a.runId === runId && setArtifacts((l) => [a, ...l.filter((x) => x.id !== a.id)]))
  useHiveEvent('artifact:removed', ({ id }) => setArtifacts((l) => l.filter((x) => x.id !== id)))

  const steps = useMemo(() => [...(rd?.steps ?? [])].sort((a, b) => a.seq - b.seq), [rd?.steps])
  const current: RunStep | undefined =
    steps.find((s) => s.id === selStep) ?? [...steps].reverse().find((s) => s.status === 'running') ?? [...steps].reverse().find((s) => s.status === 'failed') ?? steps[steps.length - 1]
  const run = rd?.run
  const active = run?.status === 'running' || run?.status === 'queued'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === '.' && run && active) {
        e.preventDefault()
        void cancelRun(run)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, active])

  if (error && !rd) {
    return (
      <div className="view">
        <Toolbar left={<BackBtn />} title="Run" />
        <ErrorState error={error} onRetry={load} />
      </div>
    )
  }
  if (!rd || !run) {
    return (
      <div className="view">
        <Toolbar left={<BackBtn />} title="Run" />
        <Loading />
      </div>
    )
  }

  const inputs = run.target.kind === 'workflow' ? Object.entries(run.target.inputs) : []
  const runMenu = async (): Promise<void> => {
    const prompt = run.target.kind === 'prompt' ? run.target.prompt : null
    const id = await nativeMenu([
      { id: 'dir', label: 'Open ARTIFACTS_DIR in Finder' },
      ...(prompt ? [{ id: 'prompt', label: 'Copy Prompt' }] : []),
      { type: 'separator' },
      { id: 'copyId', label: 'Copy Run ID' }
    ])
    if (id === 'dir') void attempt(() => hive.artifacts.openDir({ runId: run.id }))
    if (id === 'prompt' && prompt) await attempt(() => hive.clipboard.writeText({ text: prompt })).then(() => toast('Prompt copied'))
    if (id === 'copyId') await attempt(() => hive.clipboard.writeText({ text: run.id })).then(() => toast('Run ID copied'))
  }
  const inputDefs = rd.workflow?.inputs ?? []
  const stepMenu = async (s: RunStep): Promise<void> => {
    const id = await nativeMenu([
      { id: 'session', label: 'Open as Session', enabled: s.adapter !== 'shell' },
      { id: 'copyOut', label: 'Copy Output', enabled: !!s.output },
      { id: 'copyPrompt', label: 'Copy Prompt' }
    ])
    if (id === 'session') void openAsSession(run.id, s.id)
    if (id === 'copyOut' || id === 'copyPrompt') {
      await attempt(() => hive.clipboard.writeText({ text: (id === 'copyOut' ? s.output : s.prompt) ?? '' }))
      toast('Copied')
    }
  }

  return (
    <div className="view">
      <Toolbar
        left={<BackBtn />}
        title={
          <span className="run-title" title={run.target.kind === 'prompt' ? run.target.prompt : run.title}>
            {runTitle(run, 60)}
          </span>
        }
        sub={
          <span className="run-sub">
            {isNothingToDo(run) ? <span className="glyph glyph--quiet">–</span> : <StatusGlyph status={runVisual(run.status)} />} {runStatusLabel(run)} {duration(run.startedAt, run.endedAt)}
            {run.scheduleId && <Pill tone="scheduled">◷ from “{scheduleName ?? 'schedule'}”</Pill>}
            {run.trigger === 'agent' && run.startedBy && <Pill tone="accent" title="Started by an agent through Principia’s tools">✦ started by {run.startedBy.ownerLabel}</Pill>}
            {run.slack && <SlackProvenance ctx={run.slack} />}
          </span>
        }
      >
        {active ? (
          <Button icon="stop" onClick={() => void cancelRun(run)} kbd="⌘.">
            Cancel
          </Button>
        ) : (
          <Button onClick={() => void rerun(run)}>Re-run</Button>
        )}
        <Button onClick={() => void navigate({ name: 'canvas', focusRunId: run.id })} title="See this run in Activity">Activity</Button>
        <IconButton icon="more" label="More" onClick={() => void runMenu()} />
      </Toolbar>
      {run.stopReason === 'rate_limited' && (
        <div className="limit-banner">
          <LimitActions target={runLimitTarget(run)} open />
        </div>
      )}
      {/* WORKTREE.md: which task this agent is doing */}
      <TaskStrip taskId={(run as { taskId?: string | null }).taskId} ownerId={run.id} />
      <div className="run">
        <div className="run__left scroll">
          {run.reason && (isNothingToDo(run) ? <div className="callout callout--quiet selectable">Nothing to do · {run.reason}</div> : <div className="callout callout--failed selectable">{run.reason}</div>)}
          {run.worktree && <WorktreeChip wt={run.worktree} />}
          <RunSlackDrafts runId={run.id} />
          <RunForumConversation runId={run.id} active={active} />
          <div className="run__label">Steps</div>
          {steps.length === 0 && <div className="text-tertiary run__pad">{active ? 'Starting…' : 'No steps recorded.'}</div>}
          {steps.map((s) => {
            const root = stepRoot.get(s.id)
            const subs = root ? (idx.children.get(root.id)?.length ?? 0) : 0
            const stepAsks = runAsks.filter((a) => a.stepId === s.id)
            const open = subs > 0 && (openSteps[s.id] ?? (s.status === 'running' || stepAsks.length > 0))
            return (
              <div key={s.id}>
                <div
                  className={`step-row ${current?.id === s.id && !selAgent ? 'is-selected' : ''} ${stepAsks.length ? 'step-row--needs' : ''}`}
                  onClick={() => {
                    setSelStep(s.id)
                    setSelAgent(null)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    void stepMenu(s)
                  }}
                  title={root?.activity ?? undefined}
                >
                  <button
                    type="button"
                    className="step-row__twisty"
                    tabIndex={-1}
                    aria-label={open ? 'Hide subagents' : 'Show subagents'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenSteps((o) => ({ ...o, [s.id]: !open }))
                    }}
                  >
                    {subs > 0 && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />}
                  </button>
                  {stepAsks.length ? <AgentGlyph visual="needs" /> : <StatusGlyph status={stepVisual(s.status)} />}
                  <span className="step-row__name">{s.participantLabel ? `${s.nodeId} · ${s.participantLabel}` : s.nodeId === 'prompt' ? 'Prompt' : s.nodeId}</span>
                  <span className="step-row__meta">{s.round != null ? `r${s.round}` : s.attempt > 1 ? `#${s.attempt}` : ''}</span>
                  {s.halt && (
                    <span className="halt-chip" title={`HIVE_STOP: ${s.halt}`}>
                      stopped the run
                    </span>
                  )}
                  {subs > 0 && !open && <span className="step-row__meta" title={`${subs} subagent${subs === 1 ? '' : 's'}`}>⑂{subs}</span>}
                  {s.stopReason === 'rate_limited' && (
                    <span className="limit-chip" title={s.resetAt ? `Resets ${new Date(s.resetAt).toLocaleString()}` : 'Reset time unknown'}>
                      usage limit
                    </span>
                  )}
                  <StalledBadge agent={root} />
                  <StepMemoryMark grants={memGrants.filter((g) => g.stepId === s.id)} />
                  <span className="step-row__meta">{duration(s.startedAt, s.endedAt)}</span>
                </div>
                {open && root && (
                  <AgentTree
                    stacked
                    idx={idx}
                    parentId={root.id}
                    askAgents={new Set(stepAsks.map((a) => a.agentId))}
                    selectedId={selAgent}
                    onSelect={(a) => {
                      setSelStep(s.id)
                      setSelAgent(a.id)
                    }}
                  />
                )}
              </div>
            )
          })}
          {isNothingToDo(run) &&
            (rd.workflow?.nodes ?? [])
              .filter((n) => !steps.some((s) => s.nodeId === n.id))
              .map((n) => (
                <div key={`skip:${n.id}`} className="step-row step-row--skipped" title="Not run: an earlier step said there was nothing to do">
                  <span className="step-row__twisty" />
                  <span className="glyph glyph--quiet">–</span>
                  <span className="step-row__name">{n.id}</span>
                  <span className="step-row__meta">skipped</span>
                </div>
              ))}
          {inputs.length > 0 && (
            <>
              <div className="run__label">Inputs</div>
              <div className="kv run__pad">
                {inputs.map(([k, v]) => {
                  const def = inputDefs.find((i) => i.name === k)
                  const shown = def?.type === 'repo' ? (repos.find((r) => r.id === v)?.name ?? v) : v
                  return (
                    <span key={k} className="kv__pair">
                      <span className="text-tertiary">{k}</span>
                      <span className="selectable kv__val" title={v}>
                        {shown}
                      </span>
                    </span>
                  )
                })}
              </div>
            </>
          )}
          <div className="run__label">Artifacts</div>
          {artifacts.length > 0 && (
            <div className="thumb-strip">
              {artifacts.slice(0, 6).map((a) => (
                <button key={a.id} type="button" className="thumb-strip__item" title={`${a.name}\nClick to preview (Quick Look)`} onClick={() => void attempt(() => hive.artifacts.quickLook({ id: a.id }))}>
                  <ArtifactThumb artifact={a} size={128} compact />
                  <span className="thumb-strip__name">{a.name}</span>
                </button>
              ))}
            </div>
          )}
          {artifacts.length > 0 ? (
            <button type="button" className="step-row step-row--link" onClick={() => void navigate({ name: 'artifacts', runId: run.id })}>
              <span className="flex1">View all {artifacts.length} →</span>
            </button>
          ) : (
            <div className="text-tertiary run__pad run__note">
              <Icon name="artifacts" size={14} /> This run didn’t write to ARTIFACTS_DIR.
            </div>
          )}
        </div>
        <div className="run__right">
          {(() => {
            // an open ask in the selected step's tree is pinned above everything (LIVE.md §11)
            const pinned = runAsks.filter((a) => (selAgent ? a.agentId === selAgent || descendants(idx, selAgent).some((d) => d.agent.id === a.agentId) : current && a.stepId === current.id))
            return pinned.length ? (
              <div className="run__asks">
                {pinned.map((a, i) => (
                  <AskCard key={a.id} ask={a} hotkeys={i === 0} />
                ))}
              </div>
            ) : null
          })()}
          {selAgent && idx.byId.get(selAgent) ? (
            <SubagentPane agent={idx.byId.get(selAgent)!} onBack={() => setSelAgent(null)} stepLabel={current ? (current.nodeId === 'prompt' ? 'Prompt' : current.nodeId) : 'step'} reads={treeMemReads(idx, selAgent)} />
          ) : current ? (
            <>
              <div className="run__step-head">
                <div>
                  <span className="run__step-title">{current.nodeId === 'prompt' ? 'Prompt' : current.nodeId}</span>{' '}
                  <span className="text-secondary">· {stepMeta(current)}</span>
                  {current.verdict && (
                    <>
                      {' '}
                      <Pill tone={current.verdict === 'PASS' ? 'passed' : 'failed'}>VERDICT: {current.verdict}</Pill>
                    </>
                  )}
                </div>
                <div className="run__step-meta text-tertiary mono" title={tooltipTime(current.startedAt)}>
                  {current.cwd}
                  {current.exitCode != null && ` · exit ${current.exitCode}`}
                  {current.agentSessionId && ` · conversation ${current.agentSessionId.slice(0, 8)}`}
                </div>
                {stepRoot.get(current.id) ? (
                  <div className="run__live">
                    {(() => {
                      const root = stepRoot.get(current.id)!
                      const money = costOrTokens(root)
                      return (
                        <>
                          <span className="run__activity" title={activityLine(root)}>
                            {activityLine(root)}
                          </span>
                          {money && <span className="text-tertiary">{money}</span>}
                          <NeedsBadge count={runAsks.filter((a) => a.stepId === current.id).length} />
                          <AgentMemoryChip owner={{ runId: run.id, stepId: current.id }} reads={treeMemReads(idx, root.id)} repoId={root.repoId} />
                        </>
                      )
                    })()}
                  </div>
                ) : (
                  <StepMemoryChip grants={memGrants.filter((g) => g.stepId === current.id)} runId={run.id} />
                )}
                {current.error && !(run.reason && run.reason.includes(current.error)) && <div className="callout callout--failed selectable">{current.error}</div>}
                <div className="run__tabs">
                  <Segmented<Tab>
                    size="sm"
                    items={[
                      { value: 'output', label: 'Output' },
                      ...(stepRoot.get(current.id) ? [{ value: 'activity' as Tab, label: 'Activity', title: 'Tool calls and messages, live' }] : []),
                      { value: 'result', label: 'Result' },
                      { value: 'prompt', label: 'Prompt' }
                    ]}
                    value={tab}
                    onChange={setTab}
                  />
                  <span className="flex1" />
                  {tab === 'output' && (
                    <Button size="sm" variant={raw ? undefined : 'ghost'} onClick={() => setRaw((r) => !r)} title={raw ? 'Show the readable transcript' : 'Show the raw CLI log'} aria-pressed={raw}>
                      Raw
                    </Button>
                  )}
                  {current.adapter !== 'shell' && (
                    <Button size="sm" onClick={() => void openAsSession(run.id, current.id)} title="Resume this agent's conversation interactively in the same folder">
                      Open as Session
                    </Button>
                  )}
                </div>
              </div>
              <div className="run__content">
                {tab === 'output' && <StepLog runId={run.id} stepId={current.id} live={current.status === 'running'} view={raw ? 'raw' : 'readable'} />}
                {tab === 'activity' && stepRoot.get(current.id) && <AgentTimeline agentId={stepRoot.get(current.id)!.id} emptyText={current.status === 'running' ? 'Waiting for the first tool call…' : 'No tool calls recorded.'} />}
                {tab === 'activity' && !stepRoot.get(current.id) && <EmptyState compact text="No live activity for this step." />}
                {tab === 'prompt' && (
                  <pre className="log selectable">
                    <PromptText text={current.prompt} />
                  </pre>
                )}
                {tab === 'result' && (
                  <pre className="log selectable">{current.output ? <LogText text={current.output} /> : <span className="log__note">{current.status === 'running' ? 'Still running — see Output for live progress.' : 'No final output.'}</span>}</pre>
                )}
              </div>
            </>
          ) : (
            <EmptyState icon="workflows" text={active ? 'Waiting for the first step…' : 'No steps.'} />
          )}
        </div>
      </div>
    </div>
  )
}

/** "check · codex · attempt 2 · 4m02s" — no repeated words, shell/attempt-1 noise dropped. */
function stepMeta(s: RunStep): string {
  const parts: string[] = []
  if (s.nodeType !== s.nodeId && s.nodeType !== 'prompt' && s.nodeType !== 'shell') parts.push(s.nodeType)
  parts.push(s.adapter === 'shell' ? 'shell command' : s.adapter)
  if (s.round != null) parts.push(`round ${s.round}`)
  else if (s.attempt > 1) parts.push(`attempt ${s.attempt}`)
  parts.push(duration(s.startedAt, s.endedAt))
  return parts.join(' · ')
}

/** Right pane for a selected subagent: what it is, its live status line, then its own timeline. */
function SubagentPane({ agent: a, onBack, stepLabel, reads }: { agent: AgentNode; onBack: () => void; stepLabel: string; reads: number }): React.JSX.Element {
  const money = costOrTokens(a)
  return (
    <>
      <div className="run__step-head">
        <div className="run__agent-title">
          <button type="button" className="link-btn" onClick={onBack} title="Back to the step">
            {stepLabel}
          </button>
          <span className="text-tertiary"> › </span>
          <AgentGlyph visual={agentVisual(a)} />
          <span className="run__step-title">{agentLabel(a)}</span>
          {a.agentType && a.agentType !== a.title && <span className="text-secondary"> · {a.agentType}</span>}
          {a.background && <span className="text-tertiary"> · background</span>}
        </div>
        <div className="run__live">
          <span className="run__activity">{activityLine(a)}</span>
          <span className="text-tertiary">
            <Elapsed agent={a} />
          </span>
          {money && <span className="text-tertiary">{money}</span>}
          {reads > 0 && <span className="mchip mchip--mini">{reads} read</span>}
        </div>
        {a.report && a.status !== 'working' && (
          <details className="run__report">
            <summary>Report</summary>
            <pre className="log selectable">{a.report}</pre>
          </details>
        )}
      </div>
      <div className="run__content">
        <AgentTimeline agentId={a.id} note={attributionNote(a)} emptyText={a.attribution === 'completion' && a.status === 'working' ? 'Details arrive when it finishes.' : 'No activity recorded.'} />
      </div>
    </>
  )
}

function PromptText({ text }: { text: string }): React.JSX.Element {
  return <LogText text={text} />
}

/** Worktree chip (AUTHORING.md §6.5): branch · state, with Reveal, Open session here and Remove. */
function WorktreeChip({ wt }: { wt: RunWorktree }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const gone = wt.status === 'removed' || wt.status === 'creating'
  const openHere = async (): Promise<void> => {
    const sess = await attempt(() => hive.sessions.create({ adapter: 'claude', cwd: wt.path, cols: 120, rows: 36, title: wt.branch }), 'Open session')
    if (sess) focusSession(sess.id)
  }
  const remove = async (): Promise<void> => {
    const ok = await confirmNative({
      message: `Remove the worktree ${wt.branch}?`,
      detail: `Deletes the folder ${tildify(wt.path)} and Principia’s own branch when it has nothing unpushed. ${wt.keptReason === 'dirty' ? 'It has uncommitted or unpushed work that will be lost.' : 'Branches that exist on the remote are left alone.'} Your checkout is not touched.`,
      confirmLabel: 'Remove Worktree',
      destructive: true
    }).catch(() => false)
    if (!ok) return
    setBusy(true)
    const r = await attempt(() => hive.worktrees.remove({ id: wt.id }), 'Remove worktree')
    setBusy(false)
    if (r) toast('Worktree removed')
  }
  return (
    <div className={`wt-chip wt-chip--${wt.status}`} title={`${tildify(wt.path)}\nbase ${wt.base}`}>
      <span className="wt-chip__glyph">⎇</span>
      <span className="wt-chip__text mono selectable">{worktreeChip(wt)}</span>
      <span className="flex1" />
      {!gone && <IconButton icon="folder" label="Reveal in Finder" onClick={() => void attempt(() => hive.app.showItemInFolder({ path: wt.path }))} />}
      {!gone && <IconButton icon="terminal" label="Open a Claude session in this worktree" onClick={() => void openHere()} />}
      {canRemoveWorktree(wt) && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          Remove
        </Button>
      )}
    </div>
  )
}

function BackBtn(): React.JSX.Element {
  return (
    <button type="button" className="back-btn no-drag" onClick={() => goBack()}>
      <Icon name="chevronLeft" size={14} /> Back
    </button>
  )
}

/** SLACK.md §9.4: "Slack · #support · Dana Lee" with the permalink (opens in Slack). */
function SlackProvenance({ ctx }: { ctx: SlackRunContext }): React.JSX.Element {
  return (
    <button
      type="button"
      className="pill pill--accent run-slack no-drag"
      title={`${ctx.text.slice(0, 300)}${ctx.catchup ? '\n(caught up after Principia was offline)' : ''}\nOpen in Slack`}
      onClick={() => /^https:\/\//.test(ctx.permalink) && void attempt(() => hive.app.openExternal({ url: ctx.permalink }))}
    >
      <Icon name="slack" size={11} /> Slack · {ctx.isDm ? `DM with ${ctx.userName}` : `${ctx.channelName.startsWith('#') ? '' : '#'}${ctx.channelName} · ${ctx.userName}`}
    </button>
  )
}

/** AGENT-COLLAB.md §5: the conversation this run had with other agents in the Forum (asked, was asked, posted). */
function RunForumConversation({ runId, active }: { runId: string; active: boolean }): React.JSX.Element | null {
  const [conv, setConv] = useState<RunConversation | null>(null)
  const load = useCallback(() => {
    hive.forum.runConversation({ runId }).then(setConv, () => setConv(null))
  }, [runId])
  useEffect(() => load(), [load])
  // live while the run is going (its asks get answered, its posts land)
  useHiveEvent('forum:event', (e) => {
    if (active && e.kind === 'message') load()
  })
  if (!conv || (!conv.asked.length && !conv.answered && !conv.messages.length)) return null
  const cost = (w: CollabWake) => (w.costUsd == null ? '' : ` · ${w.costEstimated ? '~' : ''}$${w.costUsd.toFixed(w.costUsd < 0.01 ? 4 : 2)}`)
  const threadId = conv.answered?.threadMessageId || conv.asked.find((w) => w.threadMessageId)?.threadMessageId || conv.messages[0]?.threadId || conv.messages[0]?.id
  return (
    <div className="run-forum">
      <div className="run__label">Agent conversation</div>
      {conv.answered && (
        <div className="run-forum__wake">
          Woken by <strong>{conv.answered.fromName}</strong> to answer (hop {conv.answered.depth}, {conv.answered.via}){conv.answered.why ? ` · why: ${conv.answered.why}` : ''} · {conv.answered.status}
          {cost(conv.answered)}
        </div>
      )}
      {conv.asked.map((w) => (
        <div key={w.id} className="run-forum__wake">
          Asked <strong>{w.toName}</strong> (hop {w.depth}, {w.via}) · {w.status === 'refused' ? `refused: ${w.note}` : w.status}
          {w.why ? ` · why: ${w.why}` : ''}
          {cost(w)}
        </div>
      ))}
      {conv.messages.length > 0 && (
        <div className="run-forum__msgs">
          {conv.messages.map((m) => (
            <div key={m.id} className="run-forum__msg">
              <b>{m.authorName}</b> <span>{m.channelName ? `#${m.channelName}` : 'DM'} · {m.ref} · {tooltipTime(m.createdAt)}</span>
              <p>{m.text}</p>
            </div>
          ))}
        </div>
      )}
      {threadId && (
        <div className="run-forum__open">
          <Button size="sm" onClick={() => void navigate({ name: 'forum', threadId, channelId: conv.messages[0]?.channelId })}>
            Open in the Forum
          </Button>
        </div>
      )}
    </div>
  )
}

/** Slack drafts this run made (SLACK.md §12.4: also in the Run view). */
function RunSlackDrafts({ runId }: { runId: string }): React.JSX.Element | null {
  const drafts = useSlack((s) => s.drafts)
  const [loaded, setLoaded] = useState<SlackDraft[]>([])
  useEffect(() => {
    slackCall('slack:drafts', { runId, status: ['pending', 'failed', 'sending', 'sent', 'discarded'] }).then(setLoaded, () => setLoaded([]))
  }, [runId])
  const list = useMemo(() => {
    const m = new Map(loaded.map((d) => [d.id, d]))
    for (const d of Object.values(drafts)) if (d.runId === runId) m.set(d.id, d)
    return [...m.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }, [loaded, drafts, runId])
  if (!list.length) return null
  return (
    <div className="run-slack-drafts">
      <div className="run__label">Slack replies</div>
      {list.map((d) => (
        <SlackDraftCard key={d.id} draft={d} compact />
      ))}
    </div>
  )
}
