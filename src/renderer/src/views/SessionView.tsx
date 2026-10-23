import { useEffect, useRef, useState } from 'react'
import type { Id, SecretMeta, Session } from '@shared/types'
import { Icon } from '../components/Icon'
import { AgentMemoryChip, SessionMemoryChip } from '../components/memory/MemoryChips'
import type { AgentNode } from '@shared/live'
import { AgentGlyph } from '../components/agents/AgentBits'
import { LimitActions, StalledBadge } from '../components/agents/LimitBits'
import { AgentTimeline } from '../components/agents/AgentTimeline'
import { AskCard } from '../components/agents/AskCard'
import { ApprovalCard } from '../components/author/ApprovalCard'
import { useSessionDrafts } from '../state/authoring'
import { activityLine, agentLabel, agentVisual, attributionNote, descendants, isLive, treeMemReads, type AgentIndex } from '../lib/live'
import { useAgentIndex, useOpenAsks, useSeenSet } from '../state/live'
import { Popover } from '../components/ui'
import { TerminalPane, type TerminalHandle } from '../components/TerminalPane'
import { Button, EmptyState, IconButton, Toolbar } from '../components/ui'
import { hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { injectedNames } from '../lib/secrets'
import { keysForCompany } from '../lib/scope'
import { companyOf } from '../lib/companyModel'
import { CompanyChip } from '../components/CompanyChip'
import { clock } from '../lib/time'
import { sessionEndLabel, sessionPlace, tildify } from '../lib/format'
import { ProviderSwitcher } from '../shell/ProviderSwitcher'
import {
  attempt,
  closeSession,
  cycleRepoSession,
  getState,
  handoffSession,
  moveFocus,
  navigate,
  providerLabel,
  refreshProviders,
  removeFromGrid,
  removeRepo,
  restartSession,
  sessionContextMenu,
  setState,
  splitFocused,
  startSession,
  toast,
  updateSettings,
  useStore
} from '../state/store'

export function SessionView(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const grid = useStore((s) => s.grid)
  const gridDir = useStore((s) => s.gridDir)
  const sessions = useStore((s) => s.sessions)
  const focused = useStore((s) => s.focusedSession)
  const repos = useStore((s) => s.repos)
  const providers = useStore((s) => s.providers)
  const fontSize = useStore((s) => s.settings?.terminalFontSize ?? 13)
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const handles = useRef(new Map<Id, TerminalHandle>())

  const loadSecrets = (): void => void hive.secrets.list().then(setSecrets, () => undefined)
  useEffect(loadSecrets, [])
  useHiveEvent('data:changed', ({ domain }) => domain === 'secrets' && loadSecrets())

  const panes = grid.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => !!s)
  const cur = sessions.find((s) => s.id === focused)
  const repo = cur?.repoId ? repos.find((r) => r.id === cur.repoId) : null

  useEffect(() => {
    if (view.name !== 'session') return
    const onZoom = (e: Event): void => {
      const dir = (e as CustomEvent<'in' | 'out' | 'reset'>).detail
      const next = dir === 'reset' ? 13 : Math.min(24, Math.max(9, fontSize + (dir === 'in' ? 1 : -1)))
      if (next !== fontSize) void updateSettings({ terminalFontSize: next })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.code === 'KeyD' && !e.altKey) {
        e.preventDefault()
        void splitFocused(e.shiftKey ? 'col' : 'row')
      } else if (e.altKey && e.key.startsWith('Arrow')) {
        e.preventDefault()
        moveFocus(e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0)
      } else if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        cycleRepoSession(e.code === 'BracketLeft' ? -1 : 1)
      } else if (e.code === 'KeyF' && !e.altKey && !e.shiftKey && focused) {
        e.preventDefault()
        handles.current.get(focused)?.openSearch()
      } else if (e.key === 'Backspace' && focused) {
        e.preventDefault()
        void closeSession(focused)
      }
    }
    window.addEventListener('hive:zoom', onZoom)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('hive:zoom', onZoom)
      window.removeEventListener('keydown', onKey)
    }
  }, [view.name, focused, fontSize])

  if (view.name === 'session' && view.missing) {
    const p = providers.find((x) => x.id === view.missing!.adapter)
    return (
      <div className="view">
        <Toolbar title={providerLabel(view.missing.adapter)}>
          <ProviderSwitcher />
        </Toolbar>
        <EmptyState icon="warning" text={<>{p?.label ?? providerLabel(view.missing.adapter)} isn’t installed. <code className="selectable">{p?.installHint}</code></>}>
          <Button icon="copy" onClick={() => p && void attempt(() => hive.clipboard.writeText({ text: p.installHint })).then(() => toast('Copied'))}>
            Copy
          </Button>
          <Button
            variant="primary"
            icon="refresh"
            onClick={async () => {
              await attempt(() => refreshProviders(true), 'Recheck')
              const again = getState().providers.find((x) => x.id === view.missing!.adapter)
              if (again?.available) void startSession({ repoId: view.missing!.repoId, adapter: view.missing!.adapter, forceNew: true })
              else toast(`${again?.label ?? 'CLI'} still not found on your login PATH`)
            }}
          >
            Recheck
          </Button>
        </EmptyState>
      </div>
    )
  }
  if (view.name === 'session' && view.missingRepoId) {
    const r = repos.find((x) => x.id === view.missingRepoId)
    return (
      <div className="view">
        <Toolbar title={r?.name ?? 'Repository'} />
        <EmptyState icon="folderMissing" text={<>This folder was moved or deleted.<div className="text-tertiary mono selectable">{r?.path}</div></>}>
          {r && (
            <Button variant="primary" onClick={() => void removeRepo(r).then(() => navigate({ name: 'home' }))}>
              Remove from Principia
            </Button>
          )}
        </EmptyState>
      </div>
    )
  }

  const splitMenu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'right', label: 'Split Right', accelerator: 'Cmd+D', enabled: grid.length < 4 },
      { id: 'down', label: 'Split Down', accelerator: 'Cmd+Shift+D', enabled: grid.length < 4 },
      { type: 'separator' },
      { id: 'single', label: 'Show Only Focused Session', enabled: grid.length > 1 }
    ])
    if (id === 'right') void splitFocused('row')
    if (id === 'down') void splitFocused('col')
    if (id === 'single' && focused) setState({ grid: [focused] })
  }

  const title = cur ? (repo?.name ?? (cur.repoId ? 'Repository' : 'Chat')) : 'Session'
  const layoutClass = panes.length <= 1 ? 'grid-1' : panes.length === 2 ? `grid-2 grid-2--${gridDir}` : 'grid-4'
  return (
    <div className="view">
      <Toolbar
        title={
          <button type="button" className="toolbar__title-btn no-drag" onClick={() => cur && void sessionContextMenu(cur)} disabled={!cur}>
            {title} {cur && <Icon name="chevronDown" size={12} />}
          </button>
        }
      >
        <Button icon="split" onClick={() => void splitMenu()} disabled={!cur} title="Split (⌘D / ⌘⇧D, or ⌘-click a session row)">
          Split
        </Button>
        {cur?.status === 'running' && (
          <Button icon="stop" onClick={() => void closeSession(cur.id)} title="Kill session (⌘W)">
            Kill
          </Button>
        )}
        <ProviderSwitcher />
      </Toolbar>
      {panes.length === 0 ? (
        <EmptyState icon="terminal" text="No session open. Click a repository, or press ⌘N.">
          <Button variant="primary" onClick={() => void startSession({ repoId: null })} kbd="⌥⌘N">
            Start a Chat
          </Button>
        </EmptyState>
      ) : (
        <div className={`pane-grid ${layoutClass}`}>
          {panes.map((s) => (
            <SessionPane
              key={s.id}
              session={s}
              focused={s.id === focused}
              multi={panes.length > 1}
              fontSize={fontSize}
              secrets={secrets}
              registerHandle={(h) => (h ? handles.current.set(s.id, h) : handles.current.delete(s.id))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface ExitDiagnosis {
  message: string
  detail: string
  action: string
}

/** Known early-exit causes, matched on the session's terminal output (last ~4 KB). */
export function diagnoseExit(s: Pick<Session, 'adapter' | 'exitCode'>, output: string): ExitDiagnosis | null {
  if (s.exitCode === 0) return null
  const tail = output.slice(-4000)
  const label = providerLabel(s.adapter)
  if (/No conversation found with session ID/i.test(tail)) {
    return {
      message: `${label} couldn’t find this conversation to resume. Start a fresh session in this folder?`,
      detail: 'The transcript was deleted or never saved (for example, the session exited before the first message).',
      action: 'Start Fresh Session'
    }
  }
  if (/trust (this|the files in this) folder|Quick safety check|Do you trust the files/i.test(tail)) {
    return {
      message: `${label} asked to trust this folder and got “No”. Start again and choose “Yes, I trust this folder”.`,
      detail: `Use the arrow keys to pick “Yes, I trust this folder” before pressing Return. ${label} only asks once per folder.`,
      action: 'Start Again'
    }
  }
  return null
}

function SessionPane({
  session: s,
  focused,
  multi,
  fontSize,
  secrets,
  registerHandle
}: {
  session: Session
  focused: boolean
  multi: boolean
  fontSize: number
  secrets: SecretMeta[]
  registerHandle: (h: TerminalHandle | null) => void
}): React.JSX.Element {
  const profiles = useStore((st) => st.profiles)
  const interactiveBypass = useStore((st) => st.settings?.interactiveBypass ?? false)
  // DEPARTMENTS.md §9: a department chat's header reads "<Company> · <Department> · Claude"
  const departmentName = useStore((st) => (s.departmentId ? (st.departments.find((d) => d.id === s.departmentId)?.name ?? null) : null))
  const [artifactCount, setArtifactCount] = useState<number | null>(null)
  const termRef = useRef<TerminalHandle | null>(null)
  const profile = profiles.find((p) => p.id === s.profileId)
  // COMPANY.md §4: Shared keys plus this session's company's (a company key wins), never another company's
  const keys = injectedNames(profile, keysForCompany(secrets, companyOf(s)))
  const exited = s.status === 'exited'
  const providers = useStore((st) => st.providers)
  const alternatives = providers.filter((p) => p.available && p.id !== s.adapter && (p.id === 'claude' || p.id === 'codex'))
  const [handingOff, setHandingOff] = useState(false)
  const handoff = async (): Promise<void> => {
    const selected = alternatives.length === 1 ? alternatives[0].id : await nativeMenu(alternatives.map((p) => ({ id: p.id, label: `Continue in ${p.label}` })))
    if (selected !== 'claude' && selected !== 'codex') return
    setHandingOff(true)
    try { await handoffSession(s.id, selected) } finally { setHandingOff(false) }
  }
  const handoffButton = alternatives.length > 0 && (
    <Button size="sm" disabled={handingOff} onClick={() => void handoff()} title="Start another harness in this folder with the available conversation, recent output and shared memory">
      {handingOff ? 'Preparing handoff…' : alternatives.length === 1 ? `Continue in ${alternatives[0].label}` : 'Continue in another harness…'}
    </Button>
  )
  const [diagnosis, setDiagnosis] = useState<ExitDiagnosis | null>(null)
  const idx = useAgentIndex()
  const asks = useOpenAsks()
  const seen = useSeenSet()
  const root = idx.roots.find((r) => r.kind === 'session' && r.sessionId === s.id) ?? null
  const tree = root ? new Set([root.id, ...descendants(idx, root.id).map((d) => d.agent.id)]) : null
  // agent-authored drafts are pinned from the drafts slice; their approval asks would only duplicate the card
  const paneDrafts = useSessionDrafts(s.id)
  const paneAsks = tree ? asks.filter((a) => tree.has(a.agentId) && !(a.kind === 'approval' && paneDrafts.some((d) => d.id === a.draftId))) : []

  // An exit right after start usually has a known cause printed in the terminal; explain it instead of a bare "exited 1".
  useEffect(() => {
    if (!exited) return setDiagnosis(null)
    const t = setTimeout(() => setDiagnosis(diagnoseExit(s, termRef.current?.copyOutput() ?? '')), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exited, s.id, s.exitCode])

  const startFresh = async (): Promise<void> => {
    const fresh = await startSession({ repoId: s.repoId, adapter: s.adapter, forceNew: true, companyId: companyOf(s) })
    if (!fresh) return
    setState((st) => {
      const grid = st.grid.includes(fresh.id) && st.grid.includes(s.id) ? st.grid.filter((g) => g !== s.id) : st.grid.map((g) => (g === s.id ? fresh.id : g))
      return { grid: grid.includes(fresh.id) ? grid : [...grid, fresh.id], focusedSession: fresh.id }
    })
  }

  useEffect(() => {
    void hive.artifacts.list({ sessionId: s.id }).then((a) => setArtifactCount(a.length), () => setArtifactCount(null))
  }, [s.id])
  useHiveEvent('artifact:added', (a) => a.sessionId === s.id && setArtifactCount((n) => (n ?? 0) + 1))

  const menu = async (): Promise<void> => {
    const id = await nativeMenu([
      exited ? { id: 'restart', label: 'Restart (resume conversation)' } : { id: 'kill', label: 'Kill' },
      { id: 'copy', label: 'Copy Output' },
      { id: 'reveal', label: 'Reveal cwd in Finder' },
      { id: 'dir', label: 'Open ARTIFACTS_DIR' },
      { type: 'separator' },
      { id: 'find', label: 'Find…', accelerator: 'Cmd+F' },
      ...(multi ? [{ id: 'hide', label: 'Remove from Grid' }] : [])
    ])
    if (id === 'kill') void closeSession(s.id)
    if (id === 'restart') void restartSession(s.id)
    if (id === 'copy') {
      const text = termRef.current?.copyOutput() ?? ''
      await attempt(() => hive.clipboard.writeText({ text }))
      toast('Output copied')
    }
    if (id === 'reveal') void attempt(() => hive.app.showItemInFolder({ path: s.cwd }))
    if (id === 'dir') void attempt(() => hive.artifacts.openDir({ sessionId: s.id }))
    if (id === 'find') termRef.current?.openSearch()
    if (id === 'hide') removeFromGrid(s.id)
  }

  return (
    <section className={`pane ${focused ? 'is-focused' : ''} ${exited ? 'is-exited' : ''}`} onMouseDown={() => !focused && setState({ focusedSession: s.id })}>
      <div className="pane__header mono">
        {/* §8.6: a pane may belong to any company, whatever the focus */}
        <CompanyChip companyId={s.companyId} always className="pane__company" />
        <span
          className="pane__cwd selectable"
          title={s.repoId ? tildify(s.cwd) : departmentName ? `${tildify(s.cwd)}\nA chat in the ${departmentName} department: it knows its charter, agents and open tasks` : `${tildify(s.cwd)}\nThis company’s chat folder, not tied to a repository`}
        >
          {departmentName && <span className="text-tertiary" aria-hidden>· </span>}
          {sessionPlace(s, departmentName)}
        </span>
        {s.adapter !== 'shell' && <span className="text-tertiary">· {providerLabel(s.adapter)}</span>}
        {profile && profile.adapter !== 'shell' && interactiveBypass && <span className="text-tertiary" title="The agent edits files and runs commands without asking first. Change it in Settings.">· runs without asking</span>}
        {!exited && <StalledBadge agent={root} />}
        <span className="flex1" />
        {handoffButton}
        <IconButton icon="more" label="Session actions" onClick={() => void menu()} />
        {multi && <IconButton icon="close" label="Remove from grid" onClick={() => removeFromGrid(s.id)} />}
      </div>
      {root && s.adapter !== 'shell' && !exited && <AgentStrip idx={idx} root={root} seen={seen.has(root.id) || !!root.seen} askAgents={new Set(paneAsks.map((a) => a.agentId))} />}
      {root && root.stopReason === 'rate_limited' && !exited && (
        <div className="limit-banner limit-banner--pane">
          <LimitActions target={{ kind: 'session', sessionId: s.id, resetAt: root.resetAt ?? null, retryAt: root.retryAt ?? null }} />
          {handoffButton}
        </div>
      )}
      {paneDrafts.length > 0 && (
        <div
          className="pane__needs pane__needs--approval"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              termRef.current?.focus()
            }
          }}
        >
          <ApprovalCard draft={paneDrafts[0]!} compact hotkeys={focused} showOwner={false} />
          {paneDrafts.length > 1 && <div className="pane__needs-more text-tertiary">+{paneDrafts.length - 1} more from this session — decide this one first</div>}
        </div>
      )}
      {paneAsks.length > 0 && !exited && (
        <div
          className="pane__needs"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              termRef.current?.focus()
            }
          }}
        >
          <AskCard ask={paneAsks[0]!} compact hotkeys={focused} onOpen={() => termRef.current?.focus()} />
          {paneAsks.length > 1 && <div className="pane__needs-more text-tertiary">+{paneAsks.length - 1} more waiting — answer this one first</div>}
        </div>
      )}
      <div className="pane__body">
        <TerminalPane
          ref={(h) => {
            termRef.current = h
            registerHandle(h)
          }}
          sessionId={s.id}
          readOnly={exited}
          fontSize={fontSize}
          focused={focused}
          onFocus={() => setState({ focusedSession: s.id })}
        />
      </div>
      {exited && diagnosis && (
        <div className="pane__banner pane__banner--warn">
          <span className="text-warning">⚠</span>
          <span className="pane__banner-text" title={diagnosis.detail}>
            {diagnosis.message}
          </span>
          <span className="flex1" />
          <Button size="sm" variant="primary" onClick={() => void startFresh()} title={diagnosis.detail}>
            {diagnosis.action}
          </Button>
          <Button size="sm" onClick={() => removeFromGrid(s.id)}>
            Close
          </Button>
        </div>
      )}
      {exited && !diagnosis && (
        <div className="pane__banner">
          <span>
            ○ {[sessionEndLabel(s), s.endedAt ? clock(new Date(s.endedAt)) : null, 'read-only'].filter(Boolean).join(' · ')}
          </span>
          <span className="flex1" />
          <Button size="sm" variant="primary" onClick={() => void restartSession(s.id)} title={s.agentSessionId ? 'Resume this conversation' : 'Start again in the same folder'}>
            Restart
          </Button>
          <Button size="sm" onClick={() => removeFromGrid(s.id)}>
            Close
          </Button>
        </div>
      )}
      <div className="pane__footer">
        {!!artifactCount && (
          <button type="button" className="pane__footer-item" onClick={() => void navigate({ name: 'artifacts', sessionId: s.id })} title="Files this session saved">
            {artifactCount} artifact{artifactCount === 1 ? '' : 's'} →
          </button>
        )}
        {root ? <AgentMemoryChip owner={{ sessionId: s.id }} reads={treeMemReads(idx, root.id)} repoId={s.repoId} mini /> : <SessionMemoryChip sessionId={s.id} />}
        <span className="pane__footer-item" title={keys.join('\n')}>
          keys: {keys.length ? (keys.length > 3 ? `${keys.slice(0, 3).join(', ')} +${keys.length - 3}` : keys.join(', ')) : 'none'}
        </span>
      </div>
    </section>
  )
}

/**
 * Session header strip (LIVE.md §11): the live activity line, then one chip per subagent. A chip opens a popover with
 * that subagent's events. A focus request for a subagent of this session (hub, ⌘J) opens its chip.
 */
function AgentStrip({ idx, root, seen, askAgents }: { idx: AgentIndex; root: AgentNode; seen: boolean; askAgents: ReadonlySet<string> }): React.JSX.Element | null {
  const focus = useStore((st) => st.agentFocus)
  const [pop, setPop] = useState<{ id: string; rect: DOMRect } | null>(null)
  const chipRefs = useRef(new Map<string, HTMLButtonElement>())
  const subs = descendants(idx, root.id)
    .map((d) => d.agent)
    .sort((a, b) => (isLive(a) !== isLive(b) ? (isLive(a) ? -1 : 1) : a.startedAt < b.startedAt ? 1 : -1))
  useEffect(() => {
    if (!focus || !subs.some((a) => a.id === focus.agentId)) return
    const el = chipRefs.current.get(focus.agentId)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    setPop({ id: focus.agentId, rect: el.getBoundingClientRect() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])
  const visual = askAgents.has(root.id) ? 'needs' : agentVisual(root, seen)
  if (root.status === 'starting' && !subs.length) return null
  const popAgent = pop ? idx.byId.get(pop.id) : null
  return (
    <div className="agent-strip">
      <AgentGlyph visual={visual} />
      <span className="agent-strip__activity" title={activityLine(root, seen)}>
        {activityLine(root, seen)}
      </span>
      {subs.length > 0 && (
        <div className="agent-strip__chips">
          {subs.slice(0, 8).map((a) => (
            <button
              key={a.id}
              ref={(el) => {
                if (el) chipRefs.current.set(a.id, el)
                else chipRefs.current.delete(a.id)
              }}
              type="button"
              className={`agent-chip ${pop?.id === a.id ? 'is-on' : ''}`}
              title={`${agentLabel(a)}\n${activityLine(a)}`}
              onClick={(e) => setPop(pop?.id === a.id ? null : { id: a.id, rect: e.currentTarget.getBoundingClientRect() })}
            >
              <AgentGlyph visual={askAgents.has(a.id) ? 'needs' : agentVisual(a)} />
              <span className="agent-chip__label">{agentLabel(a)}</span>
            </button>
          ))}
          {subs.length > 8 && <span className="text-tertiary agent-strip__more">+{subs.length - 8}</span>}
        </div>
      )}
      {pop && popAgent && (
        <Popover anchor={pop.rect} onClose={() => setPop(null)} width={420}>
          <div className="agent-pop">
            <div className="agent-pop__head">
              <AgentGlyph visual={agentVisual(popAgent)} />
              <span className="agent-pop__title">{agentLabel(popAgent)}</span>
              <span className="text-tertiary agent-pop__act">{activityLine(popAgent)}</span>
            </div>
            <div className="agent-pop__body">
              <AgentTimeline agentId={popAgent.id} note={attributionNote(popAgent)} />
            </div>
          </div>
        </Popover>
      )}
    </div>
  )
}
