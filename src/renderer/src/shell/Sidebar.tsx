import { useEffect, useMemo, useRef, useState } from 'react'
import type { Repo, Schedule, Session } from '@shared/types'
import type { AgentNode } from '@shared/live'
import { Icon } from '../components/Icon'
import { IconButton, Kbd, StatusGlyph, useTick } from '../components/ui'
import { hive, useHiveEvent } from '../lib/hive'
import { useNeedsOwners, useNeedsYouCount } from '../state/live'
import { isSetUp, usePendingSlackDrafts, useSlack, useUnreadCount } from '../state/slack'
import { AgentGlyph } from '../components/agents/AgentBits'
import { agentVisual, isStalled } from '../lib/live'
import { age, startedHint } from '../lib/time'
import { collapseExited, sessionEndLabel, tildify } from '../lib/format'
import { agentCompanyResolver, companyOf, reposOf, useCompanyBadges, useLiveItems, type LiveItem } from '../lib/company'
import {
  addRepoPaths,
  moveRepo,
  addRepos,
  focusSession,
  navigate,
  openChat,
  renameSession,
  repoContextMenu,
  saveJson,
  loadJson,
  sessionContextMenu,
  startSession,
  toggleRepoExpanded,
  providerLabel,
  useStore,
  attempt,
  refreshRepos,
  activeCompany,
  assignRepoToCompany,
  multiCompany,
  openLiveItem,
  openNewCompany,
  scopeCompanyId,
  departmentsOn,
  type ViewState
} from '../state/store'
import { CompanyGroup, REPO_DRAG_TYPE } from './CompanyGroup'
import { DepartmentGroup, NeedsYouTasksSlot, useBoardCounts, useNeedsYouTaskCount } from './DepartmentGroup'
import { CompanyAvatar } from './CompanyRail'
import { CompanySwitcher, OtherCompanies } from './OtherCompanies'
import { ForumSidebarSection, useForumBadge } from '../components/forum/SidebarSection'
import { CloudMark } from '../components/cloud/bits'
import { useCloudBadge } from '../state/cloud'

type NavItem = { key: ViewState['name']; label: string; icon: string; kbd?: string }

/** Personal-only and All mode. PASSPORT.md §10: Passport replaces Memory (⌘7). */
const NAV: NavItem[] = [
  { key: 'agents', label: 'Agents', icon: 'agents', kbd: '⇧⌘A' },
  { key: 'home', label: 'Home', icon: 'home', kbd: '⌘1' },
  { key: 'tasks', label: 'Tasks', icon: 'tasks' },
  { key: 'canvas', label: 'Canvas', icon: 'canvas', kbd: '⌘2' },
  { key: 'workflows', label: 'Workflows', icon: 'workflows', kbd: '⌘3' },
  { key: 'marketplace', label: 'Marketplace', icon: 'marketplace' },
  { key: 'schedules', label: 'Schedules', icon: 'schedules', kbd: '⌘4' },
  { key: 'artifacts', label: 'Artifacts', icon: 'artifacts', kbd: '⌘5' },
  { key: 'keys', label: 'Keys', icon: 'keys', kbd: '⌘6' },
  { key: 'passport', label: 'Passport', icon: 'passport', kbd: '⌘7' },
  { key: 'slack', label: 'Slack', icon: 'slack', kbd: '⇧⌘L' },
  { key: 'forum', label: 'Forum', icon: 'forum', kbd: '⇧⌘F' },
  { key: 'cloud', label: 'Cloud', icon: 'cloud' }
]
/** COMPANY.md §8.4: focused NAV, every badge counts this company only. */
const NAV_FOCUSED: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home', kbd: '⌘1' },
  { key: 'agents', label: 'Agents', icon: 'agents', kbd: '⇧⌘A' },
  { key: 'canvas', label: 'Canvas', icon: 'canvas', kbd: '⌘2' },
  { key: 'workflows', label: 'Workflows', icon: 'workflows', kbd: '⌘3' },
  { key: 'schedules', label: 'Schedules', icon: 'schedules', kbd: '⌘4' },
  { key: 'artifacts', label: 'Artifacts', icon: 'artifacts', kbd: '⌘5' },
  { key: 'keys', label: 'Keys', icon: 'keys', kbd: '⌘6' },
  { key: 'passport', label: 'Passport', icon: 'passport', kbd: '⌘7' },
  { key: 'slack', label: 'Slack', icon: 'slack', kbd: '⇧⌘L' },
  { key: 'tasks', label: 'Tasks', icon: 'tasks' },
  { key: 'forum', label: 'Forum', icon: 'forum', kbd: '⇧⌘F' },
  { key: 'cloud', label: 'Cloud', icon: 'cloud' }
]

/** Custom title when the user renamed it, else the agent name. */
function sessionLabel(s: Session): { label: string; custom: boolean } {
  const custom = !!s.title && !/ · (Claude|Codex|Cursor|Gemini|Shell)$/.test(s.title)
  return { label: custom ? s.title : providerLabel(s.adapter), custom }
}

export function Sidebar(): React.JSX.Element {
  useTick()
  const view = useStore((s) => s.view)
  const allRepos = useStore((s) => s.repos)
  const allSessions = useStore((s) => s.sessions)
  const companies = useStore((s) => s.companies)
  const multi = useStore((s) => multiCompany(s))
  const active = useStore((s) => activeCompany(s))
  const scopeNonce = useStore((s) => s.scopeNonce)
  const expandedCompanies = useStore((s) => s.expandedCompanies)
  // DEPARTMENTS.md §9: with the flag off nothing below changes (no Board label, no Departments, no task items)
  const departments = useStore((s) => departmentsOn(s))
  const boardCounts = useBoardCounts()
  // All mode: board task items join the Needs you section (header count = live items + task items)
  const needsTaskCount = useNeedsYouTaskCount()
  /** 'flat': Personal only, the pre-company sidebar. 'all': grouped by company. 'focused': one company. */
  const mode: 'flat' | 'all' | 'focused' = !multi ? 'flat' : active === 'all' ? 'all' : 'focused'
  const focusedCompany = mode === 'focused' ? companies.find((c) => c.id === active) : undefined
  // focused mode lists this company's chats and repos only (§8.4); All mode groups everything
  const repos = useMemo(() => (mode === 'focused' ? reposOf(allRepos, active) : allRepos), [mode, allRepos, active])
  const sessions = useMemo(() => (mode === 'focused' ? allSessions.filter((s) => companyOf(s) === active) : allSessions), [mode, allSessions, active])
  const { byCompany } = useCompanyBadges()
  const needsItems = useLiveItems()
  const status = useStore((s) => s.status)
  const grid = useStore((s) => s.grid)
  const focused = useStore((s) => s.focusedSession)
  const expanded = useStore((s) => s.expandedRepos)
  const memoryPending = useStore((s) => s.memory?.counts.pending ?? 0)
  const memoryPaused = useStore((s) => !!s.memory?.agentWritesPaused)
  const globalNeedsYou = useNeedsYouCount()
  const needsYou = mode === 'focused' ? (byCompany[active]?.needsYou ?? 0) : globalNeedsYou
  const slackUnread = useUnreadCount()
  const slackDrafts = usePendingSlackDrafts().filter((d) => d.status === 'pending' || d.status === 'failed').length
  const slackState = useSlack((s) => (s.available === false ? null : s.status))
  const slackAutoPaused = useStore((s) => !!s.settings?.slackAutoPaused)
  // FORUM.md §8: mentions and unread DMs of the focused company's Forum
  const forumBadge = useForumBadge(mode === 'focused' ? active : null, departments)
  // CLOUD.md §13.1: open cloud asks plus new passport facts
  const cloudBadge = useCloudBadge()
  const allNeedsOwners = useNeedsOwners()
  const agentsWorkingAll = useStore((s) => Object.values(s.agents).some((a) => a.status === 'working' || a.status === 'starting'))
  const agentsWorking = mode === 'focused' ? (byCompany[active]?.working ?? 0) > 0 : agentsWorkingAll
  const agentsMap = useStore((s) => s.agents)
  // focused: runs needing you only count when they belong to this company
  const needsOwners = useMemo(() => {
    if (mode !== 'focused') return allNeedsOwners
    const runs = new Set(needsItems.filter((i) => i.companyId === active && i.runId).map((i) => i.runId!))
    return { sessions: allNeedsOwners.sessions, runs }
  }, [mode, active, allNeedsOwners, needsItems])
  // an agent's company: its stamp, else its root's or its session's (the badge rule), so focused counts match the rail
  const agentCompany = useMemo(() => agentCompanyResolver(Object.values(agentsMap), allSessions), [agentsMap, allSessions])
  // "Stalled?" (no output for Settings.stallMinutes): live roots only; sessions keyed by session id for their rows
  const stalled = useMemo(() => {
    const sessions = new Set<string>()
    let roots = 0
    for (const a of Object.values(agentsMap)) {
      if (a.kind === 'subagent' || !isStalled(a)) continue
      if (mode === 'focused' && agentCompany(a) !== active) continue
      roots++
      if (a.kind === 'session' && a.sessionId) sessions.add(a.sessionId)
    }
    return { sessions, roots }
  }, [agentsMap, mode, active, agentCompany])
  // the live session agent per session row: working vs finished-your-turn, not just "process alive"
  const sessionAgents = useMemo(() => {
    const m = new Map<string, AgentNode>()
    for (const a of Object.values(agentsMap)) if (a.kind === 'session' && a.sessionId) m.set(a.sessionId, a)
    return m
  }, [agentsMap])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [filter, setFilter] = useState('')
  const [drop, setDrop] = useState(false)
  const [draggedRepo, setDraggedRepo] = useState<string | null>(null)
  const [repoDrop, setRepoDrop] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)
  const [width, setWidth] = useState<number>(() => loadJson('hive.sidebarWidth', 232))
  const [showEnded, setShowEnded] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<{ kind: 'repo' | 'session'; id: string } | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const loadSchedules = (): void => {
    const companyId = scopeCompanyId()
    void hive.schedules.list(companyId ? { companyId } : undefined).then(setSchedules, () => undefined)
  }
  useEffect(loadSchedules, [scopeNonce])
  useHiveEvent('schedule:updated', (s) => {
    const scope = scopeCompanyId()
    if (scope && companyOf(s) !== scope) return setSchedules((list) => list.filter((x) => x.id !== s.id))
    setSchedules((list) => (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]))
  })
  useHiveEvent('data:changed', ({ domain }) => domain === 'schedules' && loadSchedules())

  useEffect(() => {
    const onRename = (e: Event): void => setRenaming({ kind: (e.type === 'hive:renameRepo' ? 'repo' : 'session') as 'repo' | 'session', id: (e as CustomEvent<string>).detail })
    window.addEventListener('hive:renameRepo', onRename)
    window.addEventListener('hive:renameSession', onRename)
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.altKey && e.code === 'KeyF') {
        e.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('hive:renameRepo', onRename)
      window.removeEventListener('hive:renameSession', onRename)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // focused: this company's running sessions plus the runs its live step agents belong to
  const running = useMemo(() => {
    if (mode !== 'focused') return (status?.runningSessions ?? 0) + (status?.runningRuns ?? 0)
    const runs = new Set<string>()
    for (const a of Object.values(agentsMap)) {
      if (a.kind === 'step' && a.runId && (a.status === 'working' || a.status === 'starting' || a.status === 'needs_you') && agentCompany(a) === active) runs.add(a.runId)
    }
    return sessions.filter((s) => s.status === 'running').length + runs.size
  }, [mode, status, agentsMap, sessions, active, agentCompany])
  const sessionNeeds = (s: Session): boolean => s.status === 'running' && needsOwners.sessions.has(s.id)
  // Canvas shows running sessions and runs; amber as soon as one of them waits for you
  const canvasNeeds = needsOwners.runs.size > 0 || sessions.some(sessionNeeds)
  const enabledSchedules = schedules.filter((s) => s.enabled).length
  const byRepo = useMemo(() => {
    const m = new Map<string, Session[]>()
    for (const s of sessions) {
      const k = s.repoId ?? '__chat'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(s)
    }
    for (const l of m.values()) l.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    return m
  }, [sessions])
  /** Sessions whose row label would repeat a sibling's ("Claude", "Claude"): those also show their start time. */
  const dupLabel = useMemo(() => {
    const count = new Map<string, number>()
    const key = (s: Session): string => `${s.repoId ?? '__chat'}|${sessionLabel(s).label}`
    for (const s of sessions) count.set(key(s), (count.get(key(s)) ?? 0) + 1)
    return new Set(sessions.filter((s) => (count.get(key(s)) ?? 0) > 1).map((s) => s.id))
  }, [sessions])
  const chatSessions = byRepo.get('__chat') ?? []
  const chatsByCompany = useMemo(() => {
    const m = new Map<string, Session[]>()
    for (const s of chatSessions) {
      const k = companyOf(s)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(s)
    }
    return m
  }, [chatSessions])
  const shownRepos = filter ? repos.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())) : repos
  const inSession = view.name === 'session' && !view.missing && !view.missingRepoId
  const focusedSess = sessions.find((s) => s.id === focused)

  const navActive = (k: ViewState['name']): boolean => {
    if (k === 'workflows') return view.name === 'workflows' || view.name === 'editor'
    if (k === 'canvas') return view.name === 'canvas'
    if (k === 'home') return view.name === 'home' || view.name === 'portfolio'
    if (k === 'passport') return view.name === 'passport' || view.name === 'memory'
    if (k === 'settings') return view.name === 'settings' || view.name === 'company'
    if (k === 'tasks') return view.name === 'tasks' || view.name === 'department' || view.name === 'agentSeat'
    return view.name === k
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDrop(false)
    if (!e.dataTransfer.types.includes('Files')) return
    const paths = Array.from(e.dataTransfer.files).map((f) => hive.pathForFile(f)).filter(Boolean)
    void addRepoPaths(paths)
  }

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let w = startW
    const move = (ev: MouseEvent): void => {
      w = Math.min(320, Math.max(200, startW + ev.clientX - startX))
      setWidth(w)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      saveJson('hive.sidebarWidth', w)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** All-mode Needs you (§8.3): every open ask and unseen idle turn across companies, with the company avatar. */
  const needsRow = (it: LiveItem): React.JSX.Element => {
    const c = companies.find((x) => x.id === it.companyId)
    return (
      <div key={it.key} className="side-row side-row--session side-row--needs" role="button" tabIndex={0} title={`${c?.name ?? 'Personal'} · ${it.title}${it.detail ? `\n${it.detail}` : ''}`} onClick={() => void openLiveItem(it)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void openLiveItem(it))}>
        {c ? <CompanyAvatar company={c} size={14} /> : <AgentGlyph visual="needs" />}
        <span className="side-row__label">{it.title}</span>
        <AgentGlyph visual={it.kind === 'idle' ? 'idle' : 'needs'} />
      </div>
    )
  }

  const sessionGlyph = (s: Session): React.JSX.Element => {
    if (sessionNeeds(s)) return <AgentGlyph visual="needs" />
    const a = s.status === 'running' ? sessionAgents.get(s.id) : undefined
    if (!a) return <StatusGlyph status={s.status === 'running' ? 'running' : 'exited'} />
    // seen idle turn: static amber "your turn"; working pulses blue
    const v = agentVisual(a, true)
    return v === 'idle' ? <AgentGlyph visual="idle" title="Finished, your turn" /> : <AgentGlyph visual={v} />
  }
  const sessionRow = (s: Session, indent = true): React.JSX.Element => {
    const isRenaming = renaming?.kind === 'session' && renaming.id === s.id
    const lbl = sessionLabel(s)
    return (
      <div
        key={s.id}
        className={`side-row side-row--session ${indent ? 'side-row--indent' : ''} ${inSession && grid.includes(s.id) ? (focused === s.id ? 'is-selected' : 'is-in-grid') : ''} ${s.status === 'exited' ? 'is-dim' : ''}`}
        onClick={(e) => focusSession(s.id, { add: e.metaKey })}
        onContextMenu={(e) => {
          e.preventDefault()
          void sessionContextMenu(s)
        }}
        title={`${s.repoId ? tildify(s.cwd) : 'Chat'}\n⌘-click to add to the grid`}
      >
        {sessionGlyph(s)}
        {isRenaming ? (
          <InlineRename
            value={s.title}
            onDone={(v) => {
              setRenaming(null)
              if (v && v !== s.title) void renameSession(s.id, v)
            }}
          />
        ) : (
          <span className="side-row__label">
            {lbl.label}
            {lbl.custom && s.adapter !== 'shell' && <span className="side-row__adapter"> · {providerLabel(s.adapter)}</span>}
            {dupLabel.has(s.id) && <span className="side-row__adapter"> · {startedHint(s.startedAt)}</span>}
          </span>
        )}
        {s.status === 'running' && stalled.sessions.has(s.id) && (
          <span className="stalled-badge stalled-badge--side" title="No output for a while. Principia never stops it on its own.">
            Stalled?
          </span>
        )}
        <span className="side-row__meta">{s.status === 'running' ? age(s.startedAt) : sessionEndLabel(s)}</span>
      </div>
    )
  }

  /** The repos `r` is ordered among: its company's in grouped / focused mode. */
  const siblingsOf = (r: Repo): Repo[] => (mode === 'flat' ? repos : reposOf(allRepos, companyOf(r)))
  const dropRepoOn = (id: string, r: Repo, placement: 'before' | 'after'): void => {
    const dragged = allRepos.find((x) => x.id === id)
    if (!dragged) return
    // §8.3: a repo dropped among another company's repos moves to that company (after a confirm)
    if (mode !== 'flat' && companyOf(dragged) !== companyOf(r)) return void assignRepoToCompany(dragged, companyOf(r))
    void moveRepo(id, r.id, placement)
  }
  const repoRow = (r: Repo): React.JSX.Element => {
    const list = byRepo.get(r.id) ?? []
    const live = list.filter((s) => s.status === 'running').length
    const liveNeeds = list.some(sessionNeeds)
    const folded = collapseExited(list)
    const showAll = !!showEnded[r.id]
    const open = !!expanded[r.id]
    const selected = inSession && focusedSess?.repoId === r.id
    const isRenaming = renaming?.kind === 'repo' && renaming.id === r.id
    return (
      <div key={r.id}>
        <div
          className={`side-row side-row--repo ${selected ? 'is-selected-parent' : ''} ${!r.exists ? 'is-missing' : ''} ${draggedRepo === r.id ? 'is-dragging' : ''} ${repoDrop?.id === r.id ? `repo-drop--${repoDrop.placement}` : ''}`}
          draggable={!isRenaming}
          role="button"
          tabIndex={0}
          aria-label={`${r.name}. Drag to reorder, or use Alt and arrow keys to move.`}
          onDragStart={e => {
            e.dataTransfer.setData(REPO_DRAG_TYPE, r.id)
            e.dataTransfer.effectAllowed = 'move'
            setDraggedRepo(r.id)
          }}
          onDragEnd={() => { setDraggedRepo(null); setRepoDrop(null) }}
          onDragOver={e => {
            if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
            e.preventDefault(); e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            const rect = e.currentTarget.getBoundingClientRect()
            setRepoDrop({ id: r.id, placement: e.clientY < rect.top + rect.height / 2 ? 'before' : 'after' })
          }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setRepoDrop(null) }}
          onDrop={e => {
            if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
            e.preventDefault(); e.stopPropagation()
            const id = e.dataTransfer.getData(REPO_DRAG_TYPE)
            const rect = e.currentTarget.getBoundingClientRect()
            const placement = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
            setRepoDrop(null); setDraggedRepo(null)
            dropRepoOn(id, r, placement)
          }}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return
            if (e.altKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
              e.preventDefault()
              const siblings = siblingsOf(r)
              const index = siblings.findIndex(repo => repo.id === r.id)
              const target = e.key === 'Home' ? siblings[0] : e.key === 'End' ? siblings.at(-1) : siblings[index + (e.key === 'ArrowUp' ? -1 : 1)]
              if (target) void moveRepo(r.id, target.id, e.key === 'ArrowDown' || e.key === 'End' ? 'after' : 'before')
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault(); e.currentTarget.click()
            }
          }}
          onClick={(e) => {
            if (!r.exists) return void navigate({ name: 'session', missingRepoId: r.id })
            toggleRepoExpanded(r.id, true)
            void startSession({ repoId: r.id, forceNew: e.altKey, addToGrid: e.metaKey })
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            void repoContextMenu(r)
          }}
          title={r.exists ? `${tildify(r.path)}\nDrag to reorder · Right-click to move to top\nClick: focus or start a session · ⌥-click: new session` : `${tildify(r.path)} — folder not found`}
        >
          <button
            type="button"
            className="side-row__twisty"
            onClick={(e) => {
              e.stopPropagation()
              toggleRepoExpanded(r.id)
            }}
            aria-label={open ? 'Collapse' : 'Expand'}
            tabIndex={-1}
          >
            {list.length > 0 && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
          </button>
          {!r.exists && <Icon name="folderMissing" size={14} />}
          {isRenaming ? (
            <InlineRename
              value={r.name}
              onDone={(v) => {
                setRenaming(null)
                if (v && v !== r.name) void attempt(() => hive.repos.update({ id: r.id, name: v }), 'Rename').then(() => refreshRepos())
              }}
            />
          ) : (
            <span className="side-row__label">{r.name}</span>
          )}
          {!r.exists ? <span className="side-row__meta">folder missing</span> : live > 0 && (liveNeeds ? <span className="side-row__badge side-row__badge--needs" title="A session here needs you">⚑ {live}</span> : <span className="side-row__badge"><span className="glyph glyph--running">●</span> {live}</span>)}
        </div>
        {open && (showAll ? list : folded.shown).map((s) => sessionRow(s))}
        {open && folded.hidden > 0 && (
          <div className="side-row side-row--session side-row--indent side-row--more" onClick={() => setShowEnded((m) => ({ ...m, [r.id]: !showAll }))}>
            <span className="side-row__label">{showAll ? 'Hide ended sessions' : `${folded.hidden} more ended`}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className={`sidebar ${drop ? 'is-drop' : ''}`}
      style={{ width }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDrop(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false)
      }}
      onDrop={onDrop}
    >
      <div className={`sidebar__drag drag ${multi ? 'has-rail' : ''} ${focusedCompany ? 'has-switcher' : ''}`}>{focusedCompany && <CompanySwitcher company={focusedCompany} />}</div>
      <nav className="sidebar__nav">
        {(mode === 'focused' ? NAV_FOCUSED : NAV).map((n) => (
          <div
            key={n.key}
            className={`side-row side-row--nav ${navActive(n.key) ? 'is-selected' : ''}`}
            role="link"
            tabIndex={0}
            aria-current={navActive(n.key) ? 'page' : undefined}
            aria-keyshortcuts={n.kbd ? n.kbd.replace('⇧', 'Shift+').replace('⌘', 'Meta+') : undefined}
            title={n.kbd ? `${n.label} (${n.kbd})` : n.label}
            onClick={() => void navigate({ name: n.key } as ViewState)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void navigate({ name: n.key } as ViewState)
              }
            }}
          >
            {n.key === 'cloud' ? <CloudMark size={16} className="icon" /> : <Icon name={n.icon} />}
            <span className="side-row__label">{n.key === 'tasks' && departments ? 'Board' : n.label}</span>
            {n.key === 'agents' &&
              (needsYou > 0 ? (
                <span className="side-row__badge side-row__badge--needs" title={`${needsYou} thing${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you · ⌘J jumps to the oldest · ${n.kbd} opens Agents`} aria-label={`${needsYou} need you`}>
                  ⚑ {needsYou}
                </span>
              ) : stalled.roots > 0 ? (
                <span className="stalled-badge stalled-badge--side" title={`${stalled.roots} agent${stalled.roots === 1 ? '' : 's'} with no output for a while. Principia never stops them on its own.`}>
                  Stalled? {stalled.roots}
                </span>
              ) : (
                agentsWorking && <span className="glyph glyph--running status-dot--running" title="Agents are working">●</span>
              ))}
            {n.key === 'canvas' &&
              running > 0 &&
              (canvasNeeds ? (
                <span className="side-row__badge side-row__badge--needs" title={`${running} running · something here needs you`}>
                  ⚑ {running}
                </span>
              ) : (
                <span className="side-row__badge">
                  <span className="glyph glyph--running">●</span> {running}
                </span>
              ))}
            {n.key === 'passport' && (memoryPaused ? <span className="pill pill--warning" title="Agent writes to memory are paused">paused</span> : mode === 'flat' && memoryPending > 0 && <span className="side-row__badge" title={`${memoryPending} memor${memoryPending === 1 ? 'y' : 'ies'} waiting for review, across all repositories`}>{memoryPending}</span>)}
            {n.key === 'slack' &&
              (slackState?.state === 'error' ? (
                <span className="pill pill--failed" title={slackState.error ?? 'Slack connection error'}>
                  error
                </span>
              ) : slackDrafts > 0 ? (
                <span className="side-row__badge side-row__badge--needs" title={`${slackDrafts} Slack draft${slackDrafts === 1 ? '' : 's'} waiting for you`}>
                  ⚑ {slackDrafts}
                </span>
              ) : slackAutoPaused && isSetUp(slackState) ? (
                <span className="pill pill--warning" title="Auto-replies are paused: every reply becomes a draft">
                  paused
                </span>
              ) : (
                slackUnread > 0 && <span className="schan__dot schan__dot--side" title={`${slackUnread} conversation${slackUnread === 1 ? '' : 's'} with new messages`} aria-label="Unread" />
              ))}
            {n.key === 'cloud' && cloudBadge > 0 && <span className="side-row__badge side-row__badge--needs" title={`${cloudBadge} thing${cloudBadge === 1 ? '' : 's'} from your cloud need${cloudBadge === 1 ? 's' : ''} you`}>{cloudBadge}</span>}
            {n.key === 'forum' && forumBadge > 0 && <span className="side-row__badge side-row__badge--needs" title={`${forumBadge} mention${forumBadge === 1 ? '' : 's'} or direct message${forumBadge === 1 ? '' : 's'} for you`}>{forumBadge}</span>}
            {n.key === 'schedules' && (status?.schedulesPaused ? <span className="pill pill--warning">paused</span> : enabledSchedules > 0 && <span className="side-row__badge">{enabledSchedules}</span>)}
          </div>
        ))}
      </nav>
      {mode === 'all' ? (
        <div className="sidebar__groups" onDragOverCapture={e => {
          if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
          const bounds = e.currentTarget.getBoundingClientRect()
          if (e.clientY < bounds.top + 40) e.currentTarget.scrollTop -= 16
          if (e.clientY > bounds.bottom - 40) e.currentTarget.scrollTop += 16
        }}>
          {needsItems.length + needsTaskCount > 0 && (
            <>
              <div className="sidebar__section sidebar__section--needs">
                <span>Needs you</span>
                <span className="side-row__badge side-row__badge--needs">⚑ {needsItems.length + needsTaskCount}</span>
              </div>
              {needsItems.slice(0, 8).map((it) => needsRow(it))}
              {needsItems.length > 8 && (
                <div className="side-row side-row--session side-row--more" onClick={() => void navigate({ name: 'agents' })}>
                  <span className="side-row__label">{needsItems.length - 8} more in Agents</span>
                </div>
              )}
            </>
          )}
          <NeedsYouTasksSlot limit={8} />
          {allRepos.length > 10 && (
            <div className="sidebar__filter">
              <input ref={filterRef} className="input input--sm" placeholder="Filter  ⌘⌥F" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
            </div>
          )}
          {companies.map((c) => (
            <CompanyGroup
              key={c.id}
              company={c}
              badge={byCompany[c.id]}
              board={departments ? boardCounts[c.id] : undefined}
              expanded={filter ? true : expandedCompanies[c.id] !== false}
              chats={filter ? [] : (chatsByCompany.get(c.id) ?? [])}
              repos={reposOf(shownRepos, c.id)}
              renderSession={sessionRow}
              renderRepo={repoRow}
              onRepoDrop={(id) => {
                const repo = allRepos.find((r) => r.id === id)
                if (repo) void assignRepoToCompany(repo, c.id)
              }}
            />
          ))}
          {allRepos.length === 0 && (
            <div className="sidebar__empty">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void addRepos()}>
                <Icon name="plus" size={12} /> <span>Add Repository…</span>
              </button>
              <div className="text-tertiary">or drop folders here</div>
            </div>
          )}
        </div>
      ) : (
        <>
        <div className="sidebar__section">
          <span>Chat</span>
          <IconButton icon="plus" label="New Chat — a session with no repository (⌥⌘N)" onClick={() => void openChat(true)} />
        </div>
        <div className="sidebar__chat">
          {chatSessions.length === 0 ? (
            <div className="side-row side-row--session is-dim" onClick={() => void openChat(false)} title={focusedCompany ? `Start an agent in ${focusedCompany.name}’s workspace folder, not tied to a repository` : "Start an agent in Principia's scratch folder, not tied to a repository"}>
              <Icon name="chat" size={14} />
              <span className="side-row__label">New chat (no repo)</span>
            </div>
          ) : (
            collapseExited(chatSessions).shown.slice(0, 5).map((s) => sessionRow(s, false))
          )}
        </div>
        {focusedCompany && departments && (
          <>
            <NeedsYouTasksSlot companyId={focusedCompany.id} limit={5} heading />
            <DepartmentGroup companyId={focusedCompany.id} companyName={focusedCompany.name} />
            <ForumSidebarSection companyId={focusedCompany.id} />
          </>
        )}
        <div className="sidebar__section">
          <span>Repositories</span>
          <span className="sidebar__section-actions">
            {mode === 'flat' && <IconButton icon="passport" label="New company… — group repositories, keys and memory per business" onClick={openNewCompany} />}
            <IconButton icon="plus" label={focusedCompany ? `Add Repository to ${focusedCompany.name}… (⌘O)` : 'Add Repository… (⌘O)'} onClick={() => void addRepos()} />
          </span>
        </div>
        {repos.length > 10 && (
          <div className="sidebar__filter">
            <input ref={filterRef} className="input input--sm" placeholder="Filter  ⌘⌥F" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
          </div>
        )}
        <div className="sidebar__repos" onDragOverCapture={e => {
          if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
          const bounds = e.currentTarget.getBoundingClientRect()
          if (e.clientY < bounds.top + 40) e.currentTarget.scrollTop -= 16
          if (e.clientY > bounds.bottom - 40) e.currentTarget.scrollTop += 16
        }}>
          {repos.length === 0 ? (
            <div className="sidebar__empty">
              <div>Add the folders you work in.</div>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void addRepos()}>
                <Icon name="plus" size={12} /> <span>Add Repository…</span>
              </button>
              <div className="text-tertiary">or drop folders here</div>
            </div>
          ) : (
            shownRepos.map(repoRow)
          )}
        </div>
        </>
      )}
      {focusedCompany && <OtherCompanies activeId={focusedCompany.id} />}
      <div className={`side-row side-row--nav sidebar__settings ${view.name === 'settings' ? 'is-selected' : ''}`} onClick={() => void navigate({ name: 'settings' })}>
        <Icon name="settings" />
        <span className="side-row__label">Settings</span>
        <Kbd>⌘,</Kbd>
      </div>
      <div className="sidebar__resizer" onMouseDown={startResize} />
    </aside>
  )
}

function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }): React.JSX.Element {
  const [v, setV] = useState(value)
  return (
    <input
      className="input input--sm side-row__rename"
      autoFocus
      value={v}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() || null)
        if (e.key === 'Escape') onDone(null)
        e.stopPropagation()
      }}
    />
  )
}
