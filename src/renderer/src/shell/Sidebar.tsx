/**
 * Five doors (design.md §2-3, pm-review step 1). One fixed order, the same in every mode:
 * CompanyHeader → Search or ask (⌘K) → Home · Team · Board · Chats · Knowledge (⌘1-⌘5) → More (popover with pins)
 * → LIVE (working agents, two lines, up to 4, each opens that exact chat) → REPOSITORIES + (code companies and
 * Personal) → PINNED (the user's own, per company in settings.sidebarNav) → Settings.
 * The CHAT, DEPARTMENTS, FORUM channel, NEEDS YOU and OTHER COMPANIES sections and the All-mode company trees are
 * gone: their contents live behind the doors (Chats, Team, Forum in More, Home, the rail).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Id, Repo, Session } from '@shared/types'
import type { AgentNode } from '@shared/live'
import { Icon } from '../components/Icon'
import { IconButton, Kbd, StatusGlyph, useTick } from '../components/ui'
import { hive } from '../lib/hive'
import { useNeedsOwners, useNeeds, useWorking } from '../state/live'
import { usePendingSlackDrafts, useSlack } from '../state/slack'
import { AgentGlyph } from '../components/agents/AgentBits'
import { agentVisual, isStalled } from '../lib/live'
import { age, startedHint } from '../lib/time'
import { collapseExited, sessionEndLabel, tildify } from '../lib/format'
import { agentCompanyResolver, companyOf, reposOf, useLiveItems, type LiveItem } from '../lib/company'
import {
  MORE,
  moreByKey,
  moreGroups,
  morePopoverBox,
  navKeyOf,
  pinnedRefs,
  prefsFor,
  PRIMARY,
  togglePin,
  isPinned,
  viewFor,
  type DoorKey,
  type MoreKey
} from '../lib/nav'
import {
  addRepoPaths,
  moveRepo,
  addRepos,
  focusSession,
  navigate,
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
  openPalette,
  departmentsOn,
  departmentContextMenu,
  openDepartment,
  updateSidebarPrefs,
  companyName
} from '../state/store'
import { DepartmentIcon, agentNameNow } from './DepartmentGroup'
import { CompanyHeader } from './CompanyHeader'
import { CUSTOMIZE_EVENT, CustomizeSidebarSheet, openCustomizeSidebar } from './CustomizeSidebar'
import { useForumBadge } from '../components/forum/SidebarSection'
import { useCloudBadge } from '../state/cloud'
import { plansEnabled } from '@shared/plans'
import { nativeMenu } from '../lib/hive'

/** Drag payload for reordering repositories (Alt+arrows does the same from the keyboard). */
export const REPO_DRAG_TYPE = 'application/x-principia-repository'
/** LIVE shows this many rows, then "+N more in Chats". */
const LIVE_MAX = 4

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
  const departments = useStore((s) => departmentsOn(s))
  const plansOn = useStore((s) => plansEnabled(s.settings?.experimental))
  const navPrefs = useStore((s) => s.settings?.sidebarNav)
  /** 'flat': Personal only, no rail. 'all': All companies. 'focused': one company. */
  const mode: 'flat' | 'all' | 'focused' = !multi ? 'flat' : active === 'all' ? 'all' : 'focused'
  const focusedCompany = mode === 'focused' ? (companies.find((c) => c.id === active) ?? null) : null
  const scope = mode === 'focused' ? active : undefined
  // repositories belong to one company: focused lists that company's, flat (Personal only) lists them all
  const repos = useMemo(() => (mode === 'focused' ? reposOf(allRepos, active) : mode === 'flat' ? allRepos : []), [mode, allRepos, active])
  const sessions = useMemo(() => (mode === 'focused' ? allSessions.filter((s) => companyOf(s) === active) : allSessions), [mode, allSessions, active])
  // five doors A2: the Home badge, the Team dot and LIVE are slices of the one live source (state/live.ts), the same
  // numbers the rail, the status bar and Home show
  const workingSlice = useWorking(scope)
  const needsSlice = useNeeds(scope)
  const liveRows = useLiveItems({ working: true, companyId: scope })
  const working = workingSlice.items
  // a repo row counts the sessions LIVE counts (working now), not every open terminal, so the numbers agree
  const workingSessions = useMemo(() => new Set(working.map((i) => i.sessionId).filter((x): x is string => !!x)), [working])
  const grid = useStore((s) => s.grid)
  const focused = useStore((s) => s.focusedSession)
  const expanded = useStore((s) => s.expandedRepos)
  const memoryPending = useStore((s) => s.memory?.counts.pending ?? 0)
  const memoryPaused = useStore((s) => !!s.memory?.agentWritesPaused)
  // the Home badge counts what Home lists under Needs you: open asks and finished turns, plus board tasks waiting on you
  const needsYou = needsSlice.count
  // the Team dot counts the team's agents; your own chats are live (LIVE lists them) but they are not agents
  const workingCount = workingSlice.agents
  const slackDrafts = usePendingSlackDrafts().filter((d) => d.status === 'pending' || d.status === 'failed').length
  const slackError = useSlack((s) => (s.available === false ? false : s.status?.state === 'error'))
  // FORUM.md §8: mentions and unread DMs of the focused company's Forum (its "Show when active" signal)
  const forumBadge = useForumBadge(mode === 'focused' ? active : null, departments)
  // CLOUD.md §13.1: open cloud asks plus new passport facts; Cloud sync now lives in Settings
  const cloudBadge = useCloudBadge()
  const allNeedsOwners = useNeedsOwners()
  const agentsMap = useStore((s) => s.agents)
  const allDepartments = useStore((s) => s.departments)
  const needsOwners = useMemo(() => {
    if (mode !== 'focused') return allNeedsOwners
    const runs = new Set(liveRows.filter((i) => i.companyId === active && i.runId).map((i) => i.runId!))
    return { sessions: allNeedsOwners.sessions, runs }
  }, [mode, active, allNeedsOwners, liveRows])
  const allTasks = useStore((s) => s.tasks)
  const liveSeats = useStore((s) => s.companyAgents)
  const agentCompany = useMemo(() => agentCompanyResolver(Object.values(agentsMap), allSessions, allTasks), [agentsMap, allSessions, allTasks])
  // "Stalled?" (no output for Settings.stallMinutes): sessions keyed by session id for their repo rows
  const stalled = useMemo(() => {
    const sessions = new Set<string>()
    for (const a of Object.values(agentsMap)) {
      if (a.kind !== 'session' || !a.sessionId || !isStalled(a)) continue
      if (mode === 'focused' && agentCompany(a) !== active) continue
      sessions.add(a.sessionId)
    }
    return { sessions }
  }, [agentsMap, mode, active, agentCompany])
  const sessionAgents = useMemo(() => {
    const m = new Map<string, AgentNode>()
    for (const a of Object.values(agentsMap)) if (a.kind === 'session' && a.sessionId) m.set(a.sessionId, a)
    return m
  }, [agentsMap])
  const [filter, setFilter] = useState('')
  const [drop, setDrop] = useState(false)
  const [draggedRepo, setDraggedRepo] = useState<string | null>(null)
  const [repoDrop, setRepoDrop] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)
  const [width, setWidth] = useState<number>(() => loadJson('hive.sidebarWidth', 232))
  const [showEnded, setShowEnded] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<{ kind: 'repo' | 'session'; id: string } | null>(null)
  const [more, setMore] = useState<DOMRect | null>(null)
  const [customizing, setCustomizing] = useState(false)
  useEffect(() => {
    const open = (): void => (setMore(null), setCustomizing(true))
    window.addEventListener(CUSTOMIZE_EVENT, open)
    return () => window.removeEventListener(CUSTOMIZE_EVENT, open)
  }, [])
  const filterRef = useRef<HTMLInputElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)

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
  // a company switch closes the More popover (its pins belong to the company you left)
  useEffect(() => setMore(null), [active])

  const sessionNeeds = (s: Session): boolean => s.status === 'running' && needsOwners.sessions.has(s.id)
  const byRepo = useMemo(() => {
    const m = new Map<string, Session[]>()
    for (const s of sessions) {
      if (!s.repoId) continue
      if (!m.has(s.repoId)) m.set(s.repoId, [])
      m.get(s.repoId)!.push(s)
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
  const shownRepos = filter ? repos.filter((r) => r.name.toLowerCase().includes(filter.toLowerCase())) : repos
  const inSession = view.name === 'session' && !view.missing && !view.missingRepoId
  const focusedSess = sessions.find((s) => s.id === focused)
  const current = navKeyOf(view)
  // code companies (any repository) get REPOSITORIES; a shop, and a new user with no folders yet, never see it
  // (design §2.1: 7 rows). ⌘O, ⌘K "repo", New ▾ and dropping a folder on the sidebar still add the first one.
  const showRepos = mode !== 'all' && repos.length > 0

  // ---------- pins and More (settings.sidebarNav, per company) ----------
  const prefs = prefsFor(navPrefs, active, multi)
  const available = (k: MoreKey): boolean => (k === 'plans' ? plansOn && departments : true)
  const moreBadge = (k: MoreKey): number => (k === 'forum' ? forumBadge : k === 'slack' ? slackDrafts : 0)
  const activeMore = useMemo(() => new Set<string>(MORE.filter((m) => moreBadge(m.key) > 0 || (m.key === 'slack' && slackError)).map((m) => m.key)), [forumBadge, slackDrafts, slackError])
  const pins = pinnedRefs(prefs, { active: activeMore, available, department: (id) => allDepartments.some((d) => d.id === id && !d.archivedAt && (mode !== 'focused' || d.companyId === active)) })
  // the More row carries a dot when something in it wants you and is not already shown in PINNED
  const moreWants = [...activeMore].some((k) => !pins.includes(k))
  const openMore = (): void => setMore(more ? null : (moreRef.current?.getBoundingClientRect() ?? null))
  const pinMenu = async (ref: string): Promise<void> => {
    const id = await nativeMenu([{ id: 'unpin', label: 'Unpin from Sidebar' }])
    if (id === 'unpin') updateSidebarPrefs((p) => togglePin(p, ref))
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

  /** One nav row (a door, More, a pin, Settings): keyboard-activatable, aria-current when it is the page. */
  const navRow = (o: { key: string; label: React.ReactNode; icon: React.ReactNode; selected: boolean; onOpen: () => void; title?: string; kbd?: string; badge?: React.ReactNode; className?: string; onContextMenu?: () => void; refEl?: React.Ref<HTMLDivElement>; popup?: { expanded: boolean } }): React.JSX.Element => (
    <div
      key={o.key}
      ref={o.refEl}
      className={`side-row side-row--nav ${o.selected ? 'is-selected' : ''} ${o.className ?? ''}`}
      // More opens a popover, so it is a button with popup semantics, not a link
      role={o.popup ? 'button' : 'link'}
      aria-haspopup={o.popup ? 'dialog' : undefined}
      aria-expanded={o.popup ? o.popup.expanded : undefined}
      tabIndex={0}
      aria-current={o.selected && !o.popup ? 'page' : undefined}
      aria-keyshortcuts={o.kbd ? o.kbd.replace('⇧', 'Shift+').replace('⌘', 'Meta+') : undefined}
      title={o.title}
      onClick={o.onOpen}
      onContextMenu={o.onContextMenu ? (e) => (e.preventDefault(), o.onContextMenu!()) : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          o.onOpen()
        }
      }}
    >
      {o.icon}
      <span className="side-row__label">{o.label}</span>
      {o.badge}
      {o.kbd && <Kbd>{o.kbd}</Kbd>}
    </div>
  )

  const doorBadge = (k: DoorKey): React.ReactNode => {
    if (k === 'home' && needsYou > 0)
      return (
        <span className="side-row__count" title={`${needsYou} thing${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you · ⌘J jumps to the oldest`} aria-label={`${needsYou} need you`}>
          {needsYou > 99 ? '99+' : needsYou}
        </span>
      )
    if (k === 'team' && workingCount > 0)
      return (
        <span className="side-row__badge side-row__working" title={`${workingCount} working`} aria-label={`${workingCount} working`}>
          <span className="glyph glyph--running status-dot--running">●</span> {workingCount}
        </span>
      )
    if (k === 'knowledge') {
      if (memoryPaused) return <span className="pill pill--warning" title="Agent writes to memory are paused">paused</span>
      if (mode === 'flat' && memoryPending > 0) return <span className="side-row__badge" title={`${memoryPending} new fact${memoryPending === 1 ? '' : 's'} waiting for review`}>{memoryPending} new</span>
    }
    return null
  }

  /**
   * LIVE (design §2.6): name + time, then the full activity sentence. A click opens that agent's own chat. Step 3: a
   * board task's run reads as its agent ("Pliny", then what it is doing) and opens that agent's thread in Chats; a
   * company with no code never sees a task code (C7).
   */
  const liveWho = (it: LiveItem): { name: string; detail: string | null; agentId: Id | null } => {
    const t = allTasks.find((x) => x.status === 'in_progress' && !!x.runId && (x.runId === it.runId || x.runId === it.sessionId))
    const a = t?.agentId ? liveSeats.find((x) => x.id === t.agentId && x.companyId === t.companyId) : undefined
    const code = allRepos.some((r) => r.companyId === it.companyId)
    if (a && t) return { name: agentNameNow(a).name, detail: it.detail ?? t.title, agentId: a.id }
    return { name: code ? it.title : it.title.replace(/^[A-Z][A-Z0-9]{0,5}-\d+ · /, ''), detail: it.detail, agentId: null }
  }
  const liveRow = (it: LiveItem): React.JSX.Element => {
    const w = liveWho(it)
    return (
    <button key={it.key} type="button" className="live-row is-shimmering" title={`${w.name}${w.detail ? `\n${w.detail}` : ''}`} onClick={() => void (w.agentId ? navigate({ name: 'chats', filter: 'live', chat: `agent:${w.agentId}` }) : openLiveItem(it))}>
      <span className="live-row__dot" aria-hidden />
      <span className="live-row__text">
        <span className="live-row__l1">
          <span className="live-row__name">{w.name}</span>
          <span className="live-row__age">{age(it.startedAt ?? agentsMap[it.agentId]?.startedAt ?? it.at)}</span>
        </span>
        {/* All companies: the company leads line 2, so the title keeps the width (design §2.6: the full sentence) */}
        {(w.detail || mode === 'all') && (
          <span className="live-row__l2 shimmer-text">
            {mode === 'all' && <span className="live-row__co">{companyName(it.companyId)}{w.detail ? ' · ' : ''}</span>}
            {w.detail}
          </span>
        )}
      </span>
    </button>
    )
  }

  const sessionGlyph = (s: Session): React.JSX.Element => {
    if (sessionNeeds(s)) return <AgentGlyph visual="needs" />
    const a = s.status === 'running' ? sessionAgents.get(s.id) : undefined
    if (!a) return <StatusGlyph status={s.status === 'running' ? 'running' : 'exited'} />
    // seen idle turn: static accent "your turn"; working pulses blue
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
    const live = list.filter((s) => s.status === 'running' && workingSessions.has(s.id)).length
    const needing = list.filter(sessionNeeds).length
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
          {r.exists ? <Icon name="branch" size={14} className="side-row__repo-icon" /> : <Icon name="folderMissing" size={14} />}
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
          {!r.exists ? (
            <span className="side-row__meta">folder missing</span>
          ) : needing > 0 ? (
            <span className="side-row__badge side-row__badge--needs" title={`${needing} session${needing === 1 ? '' : 's'} here need${needing === 1 ? 's' : ''} you`}>◆ {needing}</span>
          ) : (
            live > 0 && (
              <span className="side-row__badge" title={`${live} working`}>
                <span className="glyph glyph--running">●</span> {live}
              </span>
            )
          )}
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
      className={`sidebar sidebar--doors ${drop ? 'is-drop' : ''}`}
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
      <div className={`sidebar__drag drag ${multi ? 'has-rail has-switcher' : ''}`}>{multi && <CompanyHeader company={focusedCompany} />}</div>
      {!multi && (
        <div className="sidebar__head">
          <CompanyHeader company={companies[0] ?? null} flat />
        </div>
      )}
      <button type="button" className="side-search" onClick={() => openPalette('all')} title="Search pages, agents, chats and commands (⌘K)">
        <Icon name="search" size={14} />
        <span className="side-search__text">Search or ask…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <nav className="sidebar__nav sidebar__doors" aria-label="Main">
        {PRIMARY.map((d) =>
          navRow({
            key: d.key,
            label: d.label,
            icon: <Icon name={d.icon} />,
            selected: current === d.key,
            onOpen: () => void navigate(viewFor(d.key)),
            title: `${d.label}: ${d.desc} (${d.kbd})`,
            kbd: d.kbd,
            badge: doorBadge(d.key)
          })
        )}
        {navRow({
          key: 'more',
          label: 'More',
          icon: <Icon name="more" />,
          selected: !!more || (!!current && current !== 'settings' && !!moreByKey(current) && !pins.includes(current)),
          onOpen: openMore,
          title: 'Automations, Add-ons, Files, Forum, Activity, Spend…',
          badge: moreWants ? <span className="side-row__dot" aria-label="Something in More wants you" /> : null,
          className: 'side-row--more-anchor',
          refEl: moreRef,
          popup: { expanded: !!more }
        })}
      </nav>
      <div
        className="sidebar__body"
        onContextMenu={(e) => {
          // design §3: right-click the empty sidebar to customize it (rows keep their own menus)
          if ((e.target as HTMLElement).closest('.side-row, .live-row, button, input')) return
          e.preventDefault()
          void nativeMenu([{ id: 'customize', label: 'Customize Sidebar…' }]).then((id) => id === 'customize' && openCustomizeSidebar())
        }}
      >
        {working.length > 0 && (
          <section className="side-sec" aria-label="Live">
            <div className="sidebar__section">
              <span>Live</span>
              <span className="sidebar__section-meta">{working.length} working</span>
            </div>
            <div className="side-sec__rows">
              {working.slice(0, LIVE_MAX).map(liveRow)}
              {working.length > LIVE_MAX && (
                <button type="button" className="live-row live-row--more" onClick={() => void navigate({ name: 'chats', filter: 'live' })}>
                  +{working.length - LIVE_MAX} more in Chats
                </button>
              )}
            </div>
          </section>
        )}
        {showRepos && (
          <section className="side-sec" aria-label="Repositories">
            <div className="sidebar__section">
              <span>Repositories</span>
              <IconButton icon="plus" label={focusedCompany ? `Add Repository to ${focusedCompany.name}… (⌘O)` : 'Add Repository… (⌘O)'} onClick={() => void addRepos()} />
            </div>
            {repos.length > 10 && (
              <div className="sidebar__filter">
                <input ref={filterRef} className="input input--sm" placeholder="Filter  ⌘⌥F" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
              </div>
            )}
            <div className="sidebar__repos">{shownRepos.map(repoRow)}</div>
          </section>
        )}
        {pins.length > 0 && (
          <section className="side-sec" aria-label="Pinned">
            <div className="sidebar__section">
              <span>Pinned</span>
            </div>
            <div className="side-sec__rows side-sec__rows--nav">
              {pins.map((ref) => {
                if (ref.startsWith('dept:')) {
                  const d = allDepartments.find((x) => x.id === ref.slice(5))
                  if (!d) return null
                  return navRow({
                    key: ref,
                    label: (
                      <>
                        {d.name} <span className="side-row__kind">department</span>
                      </>
                    ),
                    icon: <DepartmentIcon department={d} size={16} />,
                    selected: view.name === 'department' && view.id === d.id,
                    onOpen: () => openDepartment(d),
                    title: `${d.name}: right-click for its menu`,
                    onContextMenu: () => void departmentContextMenu(d)
                  })
                }
                const m = moreByKey(ref)!
                const n = moreBadge(m.key)
                return navRow({
                  key: ref,
                  label: m.label,
                  icon: <Icon name={m.icon} />,
                  selected: current === m.key,
                  onOpen: () => void navigate(viewFor(m.key)),
                  title: `${m.label}: ${m.desc}${isPinned(prefs, ref) ? ' · right-click to unpin' : ' · shown while it has something for you'}`,
                  badge: n > 0 ? <span className="side-row__count">{n}</span> : m.key === 'slack' && slackError ? <span className="pill pill--failed">error</span> : null,
                  onContextMenu: isPinned(prefs, ref) ? () => void pinMenu(ref) : undefined
                })
              })}
            </div>
          </section>
        )}
      </div>
      <div className="sidebar__foot">
        {navRow({
          key: 'settings',
          label: 'Settings',
          icon: <Icon name="settings" />,
          selected: current === 'settings',
          onOpen: () => void navigate({ name: 'settings' }),
          title: 'Settings (⌘,)',
          kbd: '⌘,',
          className: 'sidebar__settings',
          badge: cloudBadge > 0 ? <span className="side-row__count" title={`${cloudBadge} thing${cloudBadge === 1 ? '' : 's'} from Cloud sync need${cloudBadge === 1 ? 's' : ''} you`}>{cloudBadge}</span> : null
        })}
      </div>
      <div className="sidebar__resizer" onMouseDown={startResize} />
      {customizing && <CustomizeSidebarSheet onClose={() => setCustomizing(false)} />}
      {more && (
        <MorePopover
          anchor={more}
          onClose={(refocus) => {
            setMore(null)
            if (refocus) moreRef.current?.focus()
          }}
          available={available}
          badge={moreBadge}
          pinned={(k) => isPinned(prefs, k)}
          onPin={(k) => updateSidebarPrefs((p) => togglePin(p, k))}
          onOpen={(k) => {
            setMore(null)
            void navigate(viewFor(k))
          }}
          current={current}
          slackHint={slackDrafts === 0 && !slackError}
        />
      )}
    </aside>
  )
}

/**
 * More (design §2.3): three groups, every row with a pin. Pinning moves the item into PINNED for this company; the
 * pin turns solid. Esc and an outside click close it; ↑/↓ move between rows.
 */
function MorePopover({
  anchor,
  onClose,
  available,
  badge,
  pinned,
  onPin,
  onOpen,
  current,
  slackHint
}: {
  anchor: DOMRect
  /** `refocus`: closed from the keyboard (Esc), so focus goes back to the More row */
  onClose: (refocus?: boolean) => void
  available: (k: MoreKey) => boolean
  badge: (k: MoreKey) => number
  pinned: (k: MoreKey) => boolean
  onPin: (k: MoreKey) => void
  onOpen: (k: MoreKey) => void
  current: string | null
  slackHint: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      if (ref.current && !ref.current.contains(t) && !t.closest('.side-row--more-anchor')) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose(true)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = [...(ref.current?.querySelectorAll<HTMLElement>('.more-pop__open') ?? [])]
        if (!rows.length) return
        e.preventDefault()
        const i = rows.indexOf(document.activeElement as HTMLElement)
        rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
      }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  const width = 320
  const left = Math.min(anchor.right + 6, window.innerWidth - width - 8)
  // measured, then clamped into the window: at 720px tall the popover opens upward instead of running off the bottom
  const [box, setBox] = useState<{ top: number; maxHeight: number }>(() => ({ top: Math.max(8, anchor.top - 8), maxHeight: window.innerHeight - 16 }))
  useLayoutEffect(() => {
    const place = (): void => {
      const el = ref.current
      // the full content height, borders included, even while a max-height is clipping it
      const h = el ? el.scrollHeight + (el.offsetHeight - el.clientHeight) : 0
      setBox(morePopoverBox(anchor.top, h, window.innerHeight))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor.top])
  // keyboard users land on the first row (↑/↓ move, Esc returns to More)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.more-pop__open')?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="more-pop" ref={ref} style={{ left, top: box.top, width, maxHeight: box.maxHeight }} role="dialog" aria-label="More">
      {moreGroups(available).map((g) => (
        <div key={g.group} className="more-pop__group" role="group" aria-label={g.group}>
          <div className="more-pop__head">{g.group}</div>
          {g.items.map((m) => {
            const on = pinned(m.key)
            const n = badge(m.key)
            const desc = m.key === 'slack' && slackHint ? 'Connect it in Settings › Connections' : m.key === 'forum' && !on ? 'Shows up when a thread needs you' : m.desc
            return (
              <div key={m.key} className={`more-pop__row ${current === m.key ? 'is-current' : ''}`}>
                <button type="button" className="more-pop__open" onClick={() => onOpen(m.key)}>
                  <Icon name={m.icon} />
                  <span className="more-pop__text">
                    <span className="more-pop__label">
                      {m.label}
                      {n > 0 && <span className="side-row__count">{n}</span>}
                    </span>
                    <span className="more-pop__desc">{desc}</span>
                  </span>
                </button>
                <button type="button" className={`more-pop__pin ${on ? 'is-on' : ''}`} aria-pressed={on} title={on ? `Unpin ${m.label} from the sidebar` : `Pin ${m.label} to the sidebar`} onClick={() => onPin(m.key)}>
                  <Icon name="pin" size={13} />
                </button>
              </div>
            )
          })}
        </div>
      ))}
      <div className="more-pop__foot">
        <span>Pins are saved for this company. Everything is also in ⌘K.</span>
        <button type="button" className="link-btn more-pop__customize" onClick={() => (onClose(), openCustomizeSidebar())}>
          Customize sidebar…
        </button>
      </div>
    </div>
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
