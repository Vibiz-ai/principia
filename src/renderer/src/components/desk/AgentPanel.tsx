/**
 * AGENT CHAT part 2: the ONE right panel beside a conversation (Grok's bot panel, in our words and line art).
 * - Agent: top = the bust, name, role, what it is doing now and its one action; tabs Details (what it does, how it
 *   works with its "starts its tasks on its own" switch and limits, Runs on Claude / Codex, its routines with on/off
 *   switches, its chat), Queue, History, Instructions, Library (what it produced) and Computer (what it runs now).
 * - Direct chat (Claude or Codex, no agent): the session instead: where it runs, its model and context, what it made
 *   and what it is running.
 * Collapsible with one click; the choice is remembered on this Mac. When the conversation area is narrow (under 900px,
 * e.g. a 1100px window) the chat keeps the width and the panel opens over it instead.
 * Slot: other packages add a tab with registerPanelTab (the coming Browser panel mounts there); nothing else changes.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CompanyAgent, CompanyTask } from '@shared/company'
import type { Artifact, Id, Schedule, Session } from '@shared/types'
import type { MemoryFact } from '@shared/memory'
import { Button, Switch } from '../ui'
import { Icon } from '../Icon'
import { errorMessage, hive } from '../../lib/hive'
import { taskLane } from '../../lib/departments'
import { autonomyPhrase, taskName } from '../../lib/desk'
import { useCompanyShortName } from '../../lib/company'
import { tildify } from '../../lib/format'
import { age } from '../../lib/time'
import { agentRoutines, computerView, libraryOf, routineLine, type ComputerView, type LibraryItem } from '../../lib/agentChatView'
import { AgentBust, useLaneContext } from '../../shell/DepartmentGroup'
import { useChat } from '../../state/chat'
import { agentAutonomy, useDeskWho } from '../../state/desk'
import { attempt, closeSession, departmentById, focusSession, loadJson, navigate, openBoard, providerLabel, refreshDepartments, saveJson, sessionTitle, setAgentPaused, toast, useStore } from '../../state/store'
import { AgentAction, StatusLine, startTask, useAgentStatus, useIsCode } from './Desk'
import { Instructions, LANE_WORDS, RunHistory, RunsOnPicker } from './AgentSettings'

// ---------- the slot (Browser and later panels) ----------

export interface PanelContext {
  companyId: Id
  agentId: Id | null
  sessionId: Id | null
}
export interface PanelTabExt {
  key: string
  label: string
  /** shown beside an agent conversation, a direct chat, or both (default both) */
  for?: 'agent' | 'session' | 'both'
  render(ctx: PanelContext): React.ReactNode
}
const extTabs: PanelTabExt[] = []
const extListeners = new Set<() => void>()
/** Adds a tab to the conversation's right panel (e.g. the Browser); returns the remover. */
export function registerPanelTab(t: PanelTabExt): () => void {
  const i = extTabs.findIndex((x) => x.key === t.key)
  if (i >= 0) extTabs.splice(i, 1, t)
  else extTabs.push(t)
  for (const l of extListeners) l()
  return () => {
    const j = extTabs.indexOf(t)
    if (j >= 0) extTabs.splice(j, 1)
    for (const l of extListeners) l()
  }
}
function useExtTabs(kind: 'agent' | 'session'): PanelTabExt[] {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = (): void => bump((n) => n + 1)
    extListeners.add(l)
    return () => void extListeners.delete(l)
  }, [])
  return extTabs.filter((t) => !t.for || t.for === 'both' || t.for === kind)
}

// ---------- open / closed, wide / narrow ----------

const OPEN_KEY = 'hive.convoPanel.open'
const TAB_KEY = 'hive.convoPanel.tab'
/** Below this width of the conversation area (chat + panel) the panel opens over the chat instead of beside it. */
export const PANEL_DOCK_MIN = 900

/** Whether the conversation area is wide enough to dock the panel, measured (the sidebar and rail take their share). */
function useRoomy(ref: React.RefObject<HTMLElement | null>): boolean {
  const [roomy, setRoomy] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setRoomy(el.clientWidth >= PANEL_DOCK_MIN))
    ro.observe(el)
    setRoomy(el.clientWidth >= PANEL_DOCK_MIN)
    return () => ro.disconnect()
  }, [ref])
  return roomy
}

/**
 * The panel's state for one conversation screen: docked beside the chat when there is room and you left it open; in a
 * narrow window it starts closed and opens over the chat. `ref` goes on the conversation area (chat + panel).
 */
export function usePanel(ref: React.RefObject<HTMLElement | null>): { open: boolean; docked: boolean; toggle: () => void; close: () => void } {
  const wide = useRoomy(ref)
  const [pref, setPref] = useState<boolean>(() => loadJson<boolean>(OPEN_KEY, true))
  const [overlay, setOverlay] = useState(false)
  useEffect(() => setOverlay(false), [wide])
  const open = wide ? pref : overlay
  const set = (v: boolean): void => {
    if (wide) {
      setPref(v)
      saveJson(OPEN_KEY, v)
    } else setOverlay(v)
  }
  return { open, docked: wide && open, toggle: () => set(!open), close: () => set(false) }
}

/** The header button that shows or hides the panel. */
export function PanelToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }): React.JSX.Element {
  return (
    <button type="button" className={`convo-toggle no-drag ${open ? 'is-on' : ''}`} aria-pressed={open} aria-label={open ? `Hide ${label}` : `Show ${label}`} title={open ? `Hide ${label}` : `Show ${label}`} onClick={onToggle}>
      <Icon name="sidebar" size={14} className="convo-toggle__icon" />
    </button>
  )
}

function useTab<T extends string>(kind: string, fallback: T): [T, (t: T) => void] {
  const key = `${TAB_KEY}.${kind}`
  const [tab, setTab] = useState<T>(() => loadJson<T>(key, fallback))
  return [tab, (t) => (setTab(t), saveJson(key, t))]
}

function Tabs<T extends string>({ items, value, onChange }: { items: { key: T; label: string; n?: number }[]; value: T; onChange: (t: T) => void }): React.JSX.Element {
  return (
    <div className="convo-tabs" role="tablist">
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={`convo-tab ${value === t.key ? 'is-on' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {!!t.n && <span className="convo-tab__n">{t.n}</span>}
        </button>
      ))}
    </div>
  )
}

// ---------- the agent's panel ----------

type AgentTab = 'details' | 'queue' | 'history' | 'instructions' | 'library' | 'computer' | `ext:${string}`

export function AgentPanel({ agent, session, overlay, onClose }: { agent: CompanyAgent; session: Session | null; overlay: boolean; onClose: () => void }): React.JSX.Element {
  const who = useDeskWho(agent)
  const dep = useStore((s) => departmentById(agent.departmentId, s))
  const status = useAgentStatus(agent)
  const code = useIsCode(agent.companyId)
  const ext = useExtTabs('agent')
  const [rawTab, setTab] = useTab<AgentTab>('agent', 'details')
  const st = status.seat
  const queueN = (st.current ? 1 : 0) + st.review.length + st.parked.length + st.queue.length
  const tabs: { key: AgentTab; label: string; n?: number }[] = [
    { key: 'details', label: 'Details' },
    { key: 'queue', label: 'Queue', n: queueN },
    { key: 'history', label: 'History' },
    { key: 'instructions', label: 'Instructions' },
    { key: 'library', label: 'Library' },
    { key: 'computer', label: 'Computer' },
    ...ext.map((t) => ({ key: `ext:${t.key}` as AgentTab, label: t.label }))
  ]
  const tab = tabs.some((t) => t.key === rawTab) ? rawTab : 'details'
  const extTab = tab.startsWith('ext:') ? ext.find((t) => `ext:${t.key}` === tab) : undefined
  const tasks = useStore((s) => s.tasks)
  return (
    <aside className={`convo-panel ${overlay ? 'is-overlay' : ''}`} aria-label={`About ${who.name}`}>
      <div className="convo-panel__top">
        <button type="button" className="convo-panel__close" aria-label="Hide this panel" title="Hide this panel" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
        <AgentBust agent={agent} color={dep?.color ?? null} size={84} className="convo-panel__bust" />
        <div className="convo-panel__name">{who.name}</div>
        <div className="convo-panel__role">
          {who.role}
          {dep ? ` · ${dep.name}` : ''}
          {agent.archivedAt ? ' · archived' : ''}
        </div>
        <div className={`convo-panel__status ${status.kind === 'needs' ? 'is-needs' : ''}`}>
          <StatusLine status={status} />
        </div>
        <AgentAction agent={agent} status={status} size="sm" wide />
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} />
      <div className="convo-panel__body">
        {tab === 'details' && <AgentDetails agent={agent} session={session} />}
        {tab === 'queue' && <AgentQueue agent={agent} status={status} code={code} />}
        {tab === 'history' && <RunHistory agent={agent} tasks={tasks} code={code} />}
        {tab === 'instructions' && <Instructions agent={agent} dep={dep} />}
        {tab === 'library' && <AgentLibrary agent={agent} code={code} />}
        {tab === 'computer' && <AgentComputer agent={agent} session={session} code={code} />}
        {extTab?.render({ companyId: agent.companyId, agentId: agent.id, sessionId: session?.id ?? null })}
      </div>
    </aside>
  )
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }): React.JSX.Element {
  return (
    <section className="convo-sec">
      <header className="convo-sec__head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

function AgentDetails({ agent, session }: { agent: CompanyAgent; session: Session | null }): React.JSX.Element {
  const who = useDeskWho(agent)
  const dep = useStore((s) => departmentById(agent.departmentId, s))
  const autonomy = useStore((s) => agentAutonomy(agent, s))
  const autopilot = useStore((s) => !!s.companies.find((x) => x.id === agent.companyId)?.autopilot)
  const companyPaused = useStore((s) => !!s.companies.find((x) => x.id === agent.companyId)?.pausedAt)
  const short = useCompanyShortName(agent.companyId, 'this company')
  const about = agent.data.persona?.bio?.trim() || agent.data.capabilities?.trim() || `${who.name} is your ${who.role}${dep ? ` in ${dep.name}` : ''}.`
  const setAuto = async (auto: boolean): Promise<void> => {
    const ok = await attempt(() => hive.companyAgents.save({ id: agent.id, companyId: agent.companyId, departmentId: agent.departmentId, kind: agent.kind, refId: agent.refId, name: agent.name, data: { autonomy: auto ? 'auto' : 'manual' } }), 'Autonomy')
    if (ok) {
      await refreshDepartments()
      toast(`${who.name} now: ${autonomyPhrase({ auto, role: agent.name, department: dep?.name })}. Same words on the Team card.`)
    }
  }
  return (
    <>
      <Section title={`What ${who.name} does`}>
        <p className="convo-about">{about}</p>
      </Section>
      <Section title={`How ${who.name} works`}>
        <div className="desk-opt desk-opt--muted">{autonomy}</div>
        {/* the switch says exactly what it changes (when tasks start); it never changes what waits for your OK */}
        <label className="desk-opt">
          <span className="desk-opt__label">Starts its tasks on its own</span>
          <Switch checked={agent.data.autonomy === 'auto'} disabled={!!agent.archivedAt} onChange={(v) => void setAuto(v)} label="Starts its tasks on its own" />
        </label>
        <div className="desk-opt desk-opt--muted">{agent.data.autonomy !== 'auto' ? 'Off: it waits for you to press Start on each task.' : autopilot ? 'On: it picks up its next task when one is ready.' : `On, once Autopilot is on for ${short} (Settings › Team & autonomy). Until then it waits for you.`}</div>
        <div className="desk-opt desk-opt--muted">One task at a time · up to {agent.data.limits.runMinutes} min each</div>
        {!agent.archivedAt && !companyPaused && (
          <div className="convo-sec__acts">
            <Button size="sm" variant="ghost" icon={agent.pausedAt ? 'play' : 'pause'} onClick={() => void setAgentPaused(agent, !agent.pausedAt)} title={agent.pausedAt ? `Let ${who.name} take tasks again` : `${who.name} takes no new task until you resume; the current one keeps its work`}>
              {agent.pausedAt ? `Resume ${who.name}` : `Pause ${who.name}`}
            </Button>
          </div>
        )}
      </Section>
      {agent.kind === 'profile' && (
        <Section title="Runs on">
          <ProviderSwitch agent={agent} />
          <div className="convo-sec__row">
            <RunsOnPicker agent={agent} />
          </div>
        </Section>
      )}
      <AgentRoutines agent={agent} />
      <Section title="Its chat">
        <div className="desk-opt desk-opt--muted">{session ? `Works in ${tildify(session.cwd)}` : `Opens in ${who.name}’s folder`}</div>
        <div className="desk-opt desk-opt--muted">Pick its model and whether it asks before acting in the message box below. It remembers this conversation across restarts.</div>
      </Section>
    </>
  )
}

/** Claude or Codex, one click: the agent keeps its role, instructions and history; its chat starts again on the new tool. */
function ProviderSwitch({ agent }: { agent: CompanyAgent }): React.JSX.Element | null {
  const profiles = useStore((s) => s.profiles)
  const providers = useStore((s) => s.providers)
  const [busy, setBusy] = useState(false)
  const current = profiles.find((p) => p.id === agent.refId)
  const adapters = (['claude', 'codex'] as const).filter((a) => profiles.some((p) => p.adapter === a))
  if (adapters.length < 2) return null
  const installed = (a: string): boolean => providers.find((x) => x.id === a)?.available !== false
  const pick = async (adapter: 'claude' | 'codex'): Promise<void> => {
    if (current?.adapter === adapter) return
    const next = profiles.find((p) => p.adapter === adapter && installed(p.adapter))
    if (!next) return
    setBusy(true)
    const ok = await attempt(() => hive.companyAgents.save({ id: agent.id, companyId: agent.companyId, departmentId: agent.departmentId, kind: agent.kind, refId: next.id, name: agent.name, data: {} }), 'Change AI tool')
    setBusy(false)
    if (ok) {
      await refreshDepartments()
      toast(`${agent.data.persona?.name ?? agent.name} now runs on ${providerLabel(adapter)}. Its role, instructions and board history stay; its chat starts fresh there.`)
    }
  }
  return (
    <div className="convo-provider seg seg--sm" role="radiogroup" aria-label="Runs on">
      {adapters.map((a) => (
        <button key={a} type="button" role="radio" aria-checked={current?.adapter === a} className={`seg__item ${current?.adapter === a ? 'is-on' : ''}`} disabled={busy || !installed(a)} title={installed(a) ? `Run on ${providerLabel(a)}` : `${providerLabel(a)} is not installed`} onClick={() => void pick(a)}>
          {providerLabel(a)}
        </button>
      ))}
    </div>
  )
}

function AgentRoutines({ agent }: { agent: CompanyAgent }): React.JSX.Element {
  const [list, setList] = useState<Schedule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    hive.schedules.list({ companyId: agent.companyId }).then(
      (l) => live && setList(agentRoutines(l, agent)),
      (e: unknown) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [agent.id, agent.companyId])
  const flip = async (s: Schedule, enabled: boolean): Promise<void> => {
    setList((l) => l && l.map((x) => (x.id === s.id ? { ...x, enabled } : x)))
    try {
      const next = await hive.schedules.setEnabled({ id: s.id, enabled })
      setList((l) => l && l.map((x) => (x.id === s.id ? next : x)))
    } catch (e) {
      setList((l) => l && l.map((x) => (x.id === s.id ? s : x)))
      toast(errorMessage(e), 'error')
    }
  }
  return (
    <Section
      title="Routines"
      aside={
        <button type="button" className="link-btn convo-sec__link" onClick={() => void navigate({ name: 'schedules', tab: 'routines' })}>
          Add
        </button>
      }
    >
      {error ? (
        <p className="convo-empty">{error}</p>
      ) : !list ? (
        <p className="convo-empty">Loading…</p>
      ) : list.length === 0 ? (
        <p className="convo-empty">No routines yet. A routine is work it does on its own on a schedule, like a weekly brief.</p>
      ) : (
        list.map((s) => (
          <div key={s.id} className={`convo-routine ${s.enabled ? '' : 'is-off'}`}>
            <div className="convo-routine__text">
              <div className="convo-routine__name">{s.name}</div>
              <div className="convo-routine__when">{routineLine(s)}</div>
            </div>
            <Switch checked={s.enabled} onChange={(v) => void flip(s, v)} label={`${s.name}: ${s.enabled ? 'on' : 'off'}`} />
          </div>
        ))
      )}
    </Section>
  )
}

function AgentQueue({ agent, status, code }: { agent: CompanyAgent; status: ReturnType<typeof useAgentStatus>; code: boolean }): React.JSX.Element {
  const who = useDeskWho(agent)
  const ctx = useLaneContext()
  const tasks = useStore((s) => s.tasks)
  const st = status.seat
  const rows = [...(st.current ? [st.current] : []), ...st.review, ...st.parked, ...st.queue]
  const waiting = new Set(st.queue.filter((t) => t.waiting).map((t) => t.id))
  const done = useMemo(() => tasks.filter((t) => t.agentId === agent.id && t.companyId === agent.companyId && t.status === 'done').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 5), [tasks, agent.id, agent.companyId])
  const paused = status.kind === 'paused'
  return (
    <>
      {rows.length === 0 && <div className="desk-empty">Nothing queued for {who.name}. Work {who.name} files on the board, or that you assign, lands here.</div>}
      {rows.map((t) => {
        const lane = taskLane(t, ctx)
        const g = lane === 'working' ? '●' : lane === 'needs_you' ? '◆' : '○'
        return (
          <div key={t.id} className="desk-q" role="button" tabIndex={0} onClick={() => openBoard(t.companyId, { taskId: t.id })} onKeyDown={(e) => e.key === 'Enter' && openBoard(t.companyId, { taskId: t.id })}>
            <span className={`desk-q__glyph ${lane === 'working' ? 'is-working' : lane === 'needs_you' ? 'is-needs' : ''}`} aria-hidden>
              {g}
            </span>
            <div className="desk-q__body">
              <div>{t.title}</div>
              <div className="desk-q__meta">
                {code ? `${t.identifier} · ` : ''}
                {waiting.has(t.id) ? 'Waiting on another task' : LANE_WORDS[lane]}
              </div>
            </div>
            {lane === 'queued' && t.status === 'todo' && !waiting.has(t.id) && !paused && !st.current && (
              <Button size="sm" onClick={(e) => (e.stopPropagation(), void startTask(t))}>
                Start
              </Button>
            )}
          </div>
        )
      })}
      {done.length > 0 && <div className="desk-q__meta convo-sub">Done recently</div>}
      {done.map((t) => (
        <div key={t.id} className="desk-q" role="button" tabIndex={0} onClick={() => openBoard(t.companyId, { taskId: t.id })} onKeyDown={(e) => e.key === 'Enter' && openBoard(t.companyId, { taskId: t.id })}>
          <span className="desk-q__glyph is-done" aria-hidden>
            ✓
          </span>
          <div className="desk-q__body">
            <div>{t.title}</div>
            {code && <div className="desk-q__meta">{t.identifier}</div>}
          </div>
        </div>
      ))}
    </>
  )
}

const LIB_ICON: Record<LibraryItem['kind'], string> = { draft: 'edit', file: 'file', note: 'knowledge', task: 'check' }
const LIB_GROUP: Record<LibraryItem['kind'], string> = { draft: 'Waiting for your OK', file: 'Files', note: 'Knowledge notes', task: 'Tasks done' }

function AgentLibrary({ agent, code }: { agent: CompanyAgent; code: boolean }): React.JSX.Element {
  const who = useDeskWho(agent)
  const tasks = useStore((s) => s.tasks)
  const sessionIds = useStore((s) => s.sessions.filter((x) => x.companyAgentId === agent.id).map((x) => x.id).join(','))
  const [files, setFiles] = useState<Artifact[] | null>(null)
  const [notes, setNotes] = useState<MemoryFact[]>([])
  useEffect(() => {
    let live = true
    hive.artifacts.list({ companyId: agent.companyId, limit: 400 }).then(
      (l) => live && setFiles(l),
      () => live && setFiles([])
    )
    hive.memory.facts({ scope: 'all', companyId: agent.companyId, limit: 300 }).then(
      (r) => live && setNotes(r.items),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [agent.companyId, agent.id])
  const items = useMemo(() => (files ? libraryOf({ agentId: agent.id, tasks: tasks.filter((t) => t.companyId === agent.companyId), artifacts: files, notes, sessionIds: sessionIds ? sessionIds.split(',') : [] }) : null), [files, notes, tasks, agent.id, agent.companyId, sessionIds])
  if (!items) return <p className="convo-empty">Loading…</p>
  if (!items.length) return <p className="convo-empty">Nothing yet. Files {who.name} makes, notes it saves to Knowledge and the tasks it finishes collect here.</p>
  const open = (it: LibraryItem): void => {
    if (it.kind === 'file') void hive.artifacts.open({ id: it.id }).catch((e: unknown) => toast(errorMessage(e), 'error'))
    else if (it.kind === 'note') void navigate({ name: 'memory', entityId: notes.find((n) => n.id === it.id)?.entityId, nonce: Date.now() })
    else {
      const t = tasks.find((x) => x.id === it.id)
      if (t) openBoard(t.companyId, { taskId: t.id })
    }
  }
  const groups = (['draft', 'file', 'note', 'task'] as const).map((k) => ({ k, list: items.filter((i) => i.kind === k).slice(0, 12) })).filter((g) => g.list.length)
  return (
    <>
      {groups.map((g) => (
        <Section key={g.k} title={LIB_GROUP[g.k]}>
          {g.list.map((it) => (
            <button key={it.key} type="button" className="convo-lib" onClick={() => open(it)} title={it.kind === 'file' ? 'Open the file' : it.kind === 'note' ? 'Open in Knowledge' : 'Open the task'}>
              <Icon name={LIB_ICON[it.kind]} size={13} className="convo-lib__icon" />
              <span className="convo-lib__text">
                <span className="convo-lib__title">{it.kind === 'task' || it.kind === 'draft' ? taskName(tasks.find((t) => t.id === it.id) ?? ({ title: it.title } as CompanyTask), code) : it.title}</span>
                {it.detail && <span className="convo-lib__detail">{it.detail}</span>}
              </span>
              <span className="convo-lib__age">{age(it.at)}</span>
            </button>
          ))}
        </Section>
      ))}
    </>
  )
}

function AgentComputer({ agent, session, code }: { agent: CompanyAgent; session: Session | null; code: boolean }): React.JSX.Element {
  const who = useDeskWho(agent)
  const status = useAgentStatus(agent)
  const st = status.seat
  const open = [...(st.current ? [st.current] : []), ...st.queue.slice(0, 4)]
  return (
    <>
      {session ? <ChatComputer session={session} name={who.name} /> : <p className="convo-empty">No chat with {who.name} yet. Your first message starts it.</p>}
      <Section title="Its tasks">
        {open.length === 0 ? (
          <p className="convo-empty">No task in hand.</p>
        ) : (
          open.map((t) => (
            <button key={t.id} type="button" className="convo-lib" onClick={() => openBoard(t.companyId, { taskId: t.id })}>
              <span className={`desk-q__glyph ${t.status === 'in_progress' ? 'is-working' : ''}`} aria-hidden>
                {t.status === 'in_progress' ? '●' : '○'}
              </span>
              <span className="convo-lib__text">
                <span className="convo-lib__title">{taskName(t, code)}</span>
                <span className="convo-lib__detail">{t.status === 'in_progress' ? (status.kind === 'working' ? status.text : 'Working') : 'To do'}</span>
              </span>
            </button>
          ))
        )}
      </Section>
    </>
  )
}

/** The chat's live turn, its helper agents and its last tool lines (shared by agents and direct chats). */
function ChatComputer({ session, name }: { session: Session; name: string }): React.JSX.Element {
  const v = useChat(session.id)
  const view: ComputerView = useMemo(() => computerView(v.items), [v.items])
  const live = session.status === 'running' && (v.turn === 'working' || v.turn === 'starting' || v.turn === 'needs')
  // a helper started in the background keeps working after the turn ended (the live tracker's "Background: N tasks")
  const background = useStore((s) => {
    let best: { activity: string | null; updatedAt: string } | null = null
    for (const a of Object.values(s.agents)) if (a.kind === 'session' && a.sessionId === session.id && a.parentId === null && (!best || a.updatedAt > best.updatedAt)) best = a
    const m = best?.activity ? /^Background: (\d+)/.exec(best.activity) : null
    return m ? Number(m[1]) : 0
  })
  const busy = live || (session.status === 'running' && background > 0)
  return (
    <>
      <Section title="Right now">
        <div className={`convo-now ${busy ? 'is-live' : ''}`}>
          <span className={`convo-now__dot ${busy ? 'is-live' : ''}`} aria-hidden />
          <span className={busy ? 'shimmer-text' : ''}>
            {session.status !== 'running'
              ? `${name}’s chat is resting; your next message wakes it.`
              : v.turn === 'needs'
                ? `${name} is waiting for you to allow something.`
                : live
                  ? `${v.activity ?? 'Working'}…`
                  : background > 0
                    ? `${background} helper${background === 1 ? ' is' : 's are'} still working in the background; ${name} answers when ${background === 1 ? 'it reports' : 'they report'}.`
                    : `${name} is free.`}
          </span>
        </div>
        {v.meta.contextPct != null && <div className="desk-opt desk-opt--muted">{v.meta.contextPct}% of its memory for this conversation used</div>}
      </Section>
      <Section title="Helper agents">
        {view.helpers.length === 0 ? (
          <p className="convo-empty">None yet. For bigger jobs {name} starts helpers; they show here and in the chat.</p>
        ) : (
          view.helpers.slice(0, 6).map((h) => (
            <div key={h.id} className={`convo-act ${h.running ? 'is-live' : ''}`}>
              <Icon name="agents" size={13} className="convo-act__icon" />
              <span className="convo-act__text">
                <span className={h.running ? 'shimmer-text' : ''}>{h.verb}</span> <span className="convo-act__target">{h.target}</span>
              </span>
              <span className="convo-act__meta">{h.running ? 'working' : `${h.steps} step${h.steps === 1 ? '' : 's'}`}</span>
            </div>
          ))
        )}
      </Section>
      <Section title="Recent activity">
        {view.recent.length === 0 ? (
          <p className="convo-empty">Nothing run yet in this chat.</p>
        ) : (
          view.recent.map((l) => (
            <div key={l.id} className={`convo-act ${l.status === 'running' || l.status === 'pending' ? 'is-live' : ''} ${l.status === 'error' ? 'is-error' : ''}`}>
              <Icon name={l.icon === 'agents' ? 'agents' : l.icon} size={13} className="convo-act__icon" />
              <span className="convo-act__text">
                {l.verb} <span className="convo-act__target">{l.target}</span>
              </span>
              {l.inHelper && <span className="convo-act__meta">helper</span>}
            </div>
          ))
        )}
      </Section>
    </>
  )
}

// ---------- a direct chat's panel ----------

type SessionTab = 'details' | 'library' | 'computer' | `ext:${string}`

export function SessionPanel({ session: s, overlay, onClose }: { session: Session; overlay: boolean; onClose: () => void }): React.JSX.Element {
  const ext = useExtTabs('session')
  const [rawTab, setTab] = useTab<SessionTab>('session', 'details')
  const v = useChat(s.id)
  const place = useStore((x) => (s.repoId ? (x.repos.find((r) => r.id === s.repoId)?.name ?? null) : s.departmentId ? (x.departments.find((d) => d.id === s.departmentId)?.name ?? null) : null))
  const code = useIsCode(s.companyId)
  const name = providerLabel(s.adapter)
  const tabs: { key: SessionTab; label: string }[] = [{ key: 'details', label: 'Details' }, { key: 'library', label: 'Library' }, { key: 'computer', label: 'Computer' }, ...ext.map((t) => ({ key: `ext:${t.key}` as SessionTab, label: t.label }))]
  const tab = tabs.some((t) => t.key === rawTab) ? rawTab : 'details'
  const extTab = tab.startsWith('ext:') ? ext.find((t) => `ext:${t.key}` === tab) : undefined
  return (
    <aside className={`convo-panel ${overlay ? 'is-overlay' : ''}`} aria-label="About this chat">
      <div className="convo-panel__top">
        <button type="button" className="convo-panel__close" aria-label="Hide this panel" title="Hide this panel" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
        <span className="convo-panel__mark" aria-hidden>
          <Icon name={s.repoId ? 'branch' : s.departmentId ? 'department' : 'chat'} size={26} />
        </span>
        <div className="convo-panel__name">{s.departmentId && place ? `${place} chat` : name}</div>
        <div className="convo-panel__role">{s.title && !/ · (Claude|Codex|Cursor|Gemini|Shell)$/.test(s.title) ? s.title : sessionTitle(s)}</div>
        <div className="convo-panel__acts">
          {code && (
            <Button size="sm" icon="terminal" onClick={() => focusSession(s.id)} title="The terminal behind this chat (⌥⌘T)">
              Terminal
            </Button>
          )}
          {s.status === 'running' && (
            <Button size="sm" variant="ghost" onClick={() => void closeSession(s.id)}>
              End this chat
            </Button>
          )}
        </div>
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} />
      <div className="convo-panel__body">
        {tab === 'details' && (
          <>
            <Section title="Where it works">
              <div className="desk-opt desk-opt--muted">{place ? `${place} · ` : ''}{tildify(s.cwd)}</div>
              <div className="desk-opt desk-opt--muted">{s.departmentId ? 'With the department: it knows its charter, agents and open tasks.' : 'A direct chat: no agent, no board work unless you ask for it.'}</div>
            </Section>
            <Section title="This chat">
              <div className="desk-opt desk-opt--muted">{s.status === 'running' ? `Open since ${age(s.startedAt)} ago` : `Ended ${age(s.endedAt ?? s.startedAt)} ago`}</div>
              {v.meta.model && <div className="desk-opt desk-opt--muted">Model: {v.meta.model}</div>}
              {v.meta.contextPct != null && <div className="desk-opt desk-opt--muted">{v.meta.contextPct}% of its memory for this conversation used</div>}
            </Section>
          </>
        )}
        {tab === 'library' && <SessionLibrary session={s} />}
        {tab === 'computer' && <ChatComputer session={s} name={name} />}
        {extTab?.render({ companyId: s.companyId ?? '', agentId: null, sessionId: s.id })}
      </div>
    </aside>
  )
}

function SessionLibrary({ session: s }: { session: Session }): React.JSX.Element {
  const [files, setFiles] = useState<Artifact[] | null>(null)
  useEffect(() => {
    let live = true
    hive.artifacts.list({ sessionId: s.id, limit: 100 }).then(
      (l) => live && setFiles(l),
      () => live && setFiles([])
    )
    return () => {
      live = false
    }
  }, [s.id])
  if (!files) return <p className="convo-empty">Loading…</p>
  if (!files.length) return <p className="convo-empty">No files from this chat yet.</p>
  return (
    <Section title="Files">
      {files.map((a) => (
        <button key={a.id} type="button" className="convo-lib" onClick={() => void hive.artifacts.open({ id: a.id }).catch((e: unknown) => toast(errorMessage(e), 'error'))}>
          <Icon name="file" size={13} className="convo-lib__icon" />
          <span className="convo-lib__text">
            <span className="convo-lib__title">{a.name}</span>
          </span>
          <span className="convo-lib__age">{age(a.mtime || a.createdAt)}</span>
        </button>
      ))}
    </Section>
  )
}

