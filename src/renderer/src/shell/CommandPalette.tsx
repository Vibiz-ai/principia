import { useEffect, useMemo, useRef, useState } from 'react'
import type { Run, Schedule, SecretMeta, Workflow } from '@shared/types'
import { Icon } from '../components/Icon'
import { Kbd } from '../components/ui'
import { fuzzyFilter } from '../lib/fuzzy'
import { runTitle, sessionPlace, tildify } from '../lib/format'
import { hive } from '../lib/hive'
import { activityLine, agentLabel, isLive } from '../lib/live'
import { focusAgent, goNextNeedsYou } from '../state/live'
import { openApproval } from '../state/authoring'
import { kindVerb } from '../lib/authoring'
import {
  addRepos,
  closePalette,
  focusSession,
  getState,
  navigate,
  openChat,
  openPalette,
  openRunInputs,
  pauseAll,
  providerLabel,
  sessionTitle,
  startSession,
  toggleSidebar,
  useStore,
  type PaletteMode
} from '../state/store'

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  /** Dimmed monospace ~/path. */
  hintIsPath?: boolean
  icon: string
  kbd?: string
  run: () => void
}

export function CommandPalette(): React.JSX.Element | null {
  const palette = useStore((s) => s.palette)
  if (!palette.open) return null
  return <PaletteInner key={palette.nonce} mode={palette.mode} />
}

function PaletteInner({ mode }: { mode: PaletteMode }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const sessions = useStore((s) => s.sessions)
  const settings = useStore((s) => s.settings)
  const agents = useStore((s) => s.agents)
  const asks = useStore((s) => s.asks)
  const drafts = useStore((s) => s.drafts)
  const adapter = settings?.defaultAdapter ?? 'claude'
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void hive.workflows.list().then(setWorkflows, () => undefined)
    if (mode === 'all') {
      void hive.schedules.list().then(setSchedules, () => undefined)
      void hive.runs.list({ limit: 20 }).then(setRuns, () => undefined)
      void hive.secrets.list().then(setSecrets, () => undefined)
    }
  }, [mode])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const lastRepo = settings?.lastRepoId
    const sortedRepos = [...repos].filter((r) => r.exists).sort((a, b) => (a.id === lastRepo ? -1 : b.id === lastRepo ? 1 : 0))
    const repoItems: Item[] = sortedRepos.map((r) => ({
      id: `repo:${r.id}`,
      group: mode === 'newSession' ? `New ${providerLabel(adapter)} session in` : 'Repositories',
      label: mode === 'newSession' ? r.name : `New ${providerLabel(adapter)} session in ${r.name}`,
      hint: tildify(r.path),
      hintIsPath: true,
      icon: 'folder',
      run: () => void startSession({ repoId: r.id, forceNew: true })
    }))
    const chatItem: Item = { id: 'chat', group: mode === 'newSession' ? `New ${providerLabel(adapter)} session in` : 'Actions', label: mode === 'newSession' ? 'Chat (scratch folder)' : 'New Chat', icon: 'chat', kbd: '⌥⌘N', run: () => void openChat(true) }
    const wfItems: Item[] = workflows.map((w) => ({
      id: `wf:${w.id}`,
      group: 'Workflows',
      label: `Run ${w.name}`,
      hint: w.description,
      icon: 'play',
      run: () => openRunInputs(w.id)
    }))
    if (mode === 'newSession') return [...repoItems, chatItem]
    if (mode === 'runWorkflow') return wfItems
    out.push(
      { id: 'a:newSession', group: 'Actions', label: 'New Session…', icon: 'terminal', kbd: '⌘N', run: () => setTimeout(() => openPalette('newSession'), 0) },
      chatItem,
      { id: 'a:newWf', group: 'Actions', label: 'New Workflow', icon: 'workflows', kbd: '⌘⇧N', run: () => void navigate({ name: 'editor', workflowId: null, nonce: Date.now() }) },
      { id: 'a:newSch', group: 'Actions', label: 'New Schedule', icon: 'schedules', run: () => void navigate({ name: 'schedules', seed: {}, nonce: Date.now() }) },
      { id: 'a:addRepo', group: 'Actions', label: 'Add Repository…', icon: 'folder', kbd: '⌘O', run: () => void addRepos() },
      {
        id: 'a:pause',
        group: 'Actions',
        label: getState().status?.schedulesPaused ? 'Resume All Schedules' : 'Pause All Schedules',
        icon: 'pause',
        run: () => void pauseAll(!getState().status?.schedulesPaused)
      },
      { id: 'a:sidebar', group: 'Actions', label: 'Toggle Sidebar', icon: 'sidebar', kbd: '⌘B', run: toggleSidebar },
      { id: 'a:memSearch', group: 'Actions', label: 'Search Memory…', hint: 'what agents remember about your repos', icon: 'search', run: () => void navigate({ name: 'memory', search: true, nonce: Date.now() }) },
      { id: 'a:nextNeeds', group: 'Actions', label: 'Next Needs You', hint: 'the oldest thing waiting for you', icon: 'agents', kbd: '⌘J', run: goNextNeedsYou },
      { id: 'v:agents', group: 'Go to', label: 'Agents', icon: 'agents', kbd: '⇧⌘A', run: () => void navigate({ name: 'agents' }) },
      { id: 'v:home', group: 'Go to', label: 'Home', icon: 'home', kbd: '⌘1', run: () => void navigate({ name: 'home' }) },
      { id: 'v:canvas', group: 'Go to', label: 'Canvas', icon: 'canvas', kbd: '⌘2', run: () => void navigate({ name: 'canvas' }) },
      { id: 'v:market', group: 'Go to', label: 'Marketplace — workflows and skills', icon: 'marketplace', run: () => void navigate({ name: 'marketplace' }) },
      { id: 'v:wf', group: 'Go to', label: 'Workflows', icon: 'workflows', kbd: '⌘3', run: () => void navigate({ name: 'workflows' }) },
      { id: 'v:sch', group: 'Go to', label: 'Schedules', icon: 'schedules', kbd: '⌘4', run: () => void navigate({ name: 'schedules' }) },
      { id: 'v:art', group: 'Go to', label: 'Artifacts', icon: 'artifacts', kbd: '⌘5', run: () => void navigate({ name: 'artifacts' }) },
      { id: 'v:keys', group: 'Go to', label: 'Keys', icon: 'keys', kbd: '⌘6', run: () => void navigate({ name: 'keys' }) },
      { id: 'v:memory', group: 'Go to', label: 'Open Memory', icon: 'memory', kbd: '⌘7', run: () => void navigate({ name: 'memory' }) },
      { id: 'v:slack', group: 'Go to', label: 'Slack', icon: 'slack', kbd: '⇧⌘L', run: () => void navigate({ name: 'slack', nonce: Date.now() }) },
      { id: 'a:slackSearch', group: 'Actions', label: 'Search Slack…', hint: 'Principia’s local copy of your Slack', icon: 'search', run: () => void navigate({ name: 'slack', search: true, nonce: Date.now() }) },
      { id: 'a:slackTriggers', group: 'Actions', label: 'Slack Triggers', hint: 'run a workflow when someone mentions @hive', icon: 'slack', run: () => void navigate({ name: 'schedules', tab: 'slack', nonce: Date.now() }) },
      { id: 'a:slackConnect', group: 'Actions', label: 'Slack Connection…', hint: 'Settings › Connections', icon: 'settings', run: () => void navigate({ name: 'settings', section: 'connections' }) },
      { id: 'v:settings', group: 'Go to', label: 'Settings', icon: 'settings', kbd: '⌘,', run: () => void navigate({ name: 'settings' }) }
    )
    const openAsks = Object.values(asks).filter((a) => a.status === 'open' && a.kind !== 'approval').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    out.push(
      ...Object.values(drafts)
        .filter((d) => d.status === 'pending')
        .map<Item>((d) => ({
          id: `draft:${d.id}`,
          group: 'Needs you',
          label: `Review: ${kindVerb(d.kind)} “${d.workflowName}”`,
          hint: d.ownerLabel,
          icon: 'workflows',
          run: () => void openApproval(d.id)
        }))
    )
    out.push(
      ...openAsks.map<Item>((a) => ({
        id: `ask:${a.id}`,
        group: 'Needs you',
        label: `Answer: ${a.kind === 'question' ? (a.question ?? a.title) : a.title}`,
        hint: agents[a.rootId]?.title ?? agents[a.agentId]?.title,
        icon: 'reply',
        run: () => void focusAgent(a.agentId, a.id)
      })),
      ...Object.values(agents)
        .filter((a) => isLive(a))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 40)
        .map<Item>((a) => ({
          id: `agent:${a.id}`,
          group: 'Live agents',
          label: `Go to ${a.kind === 'subagent' ? `${agentLabel(a)} (subagent)` : a.title}`,
          hint: activityLine(a),
          icon: 'agents',
          run: () => void focusAgent(a.id)
        }))
    )
    out.push(
      ...sessions
        .filter((s) => s.status === 'running')
        .map<Item>((s) => ({ id: `s:${s.id}`, group: 'Sessions', label: sessionTitle(s), hint: sessionPlace(s), hintIsPath: !!s.repoId, icon: 'terminal', run: () => focusSession(s.id) }))
    )
    out.push(...repoItems, ...wfItems)
    out.push(
      ...workflows.map<Item>((w) => ({ id: `wfe:${w.id}`, group: 'Workflows', label: `Edit ${w.name}`, icon: 'workflows', run: () => void navigate({ name: 'editor', workflowId: w.id, nonce: Date.now() }) })),
      ...workflows.map<Item>((w) => ({ id: `wfs:${w.id}`, group: 'Workflows', label: `Schedule ${w.name}…`, icon: 'schedules', run: () => void navigate({ name: 'schedules', seed: { workflowId: w.id }, nonce: Date.now() }) })),
      ...schedules.map<Item>((s) => ({ id: `sch:${s.id}`, group: 'Schedules', label: s.name, hint: s.sentence, icon: 'clock', run: () => void navigate({ name: 'schedules', selectedId: s.id }) })),
      ...runs.map<Item>((r) => ({ id: `run:${r.id}`, group: 'Recent runs', label: runTitle(r, 60), hint: `${r.status}`, icon: 'play', run: () => void navigate({ name: 'run', runId: r.id }) })),
      ...secrets.map<Item>((k) => ({ id: `key:${k.name}`, group: 'Keys', label: k.name, hint: k.label, icon: 'keys', run: () => void navigate({ name: 'keys' }) }))
    )
    return out
  }, [mode, repos, sessions, workflows, schedules, runs, secrets, adapter, settings?.lastRepoId, agents, asks, drafts])

  const filtered = useMemo(() => fuzzyFilter(items, q, (i) => `${i.label} ${i.group}`, 60), [items, q])
  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const choose = (it: Item | undefined): void => {
    if (!it) return
    closePalette()
    it.run()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(filtered.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered.length) choose(filtered[sel])
      else if (q.trim()) {
        closePalette()
        void navigate({ name: 'editor', workflowId: null, nonce: Date.now() })
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
    }
  }

  let lastGroup = ''
  const placeholder = mode === 'newSession' ? `Start ${providerLabel(adapter)} in…` : mode === 'runWorkflow' ? 'Run workflow…' : 'Search Principia or run a command'
  return (
    <div className="palette-layer" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette__input">
          <Icon name="search" />
          <input autoFocus value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        </div>
        <div className="palette__list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette__empty">
              {q.trim() ? (
                <>
                  No results for “{q}”.{' '}
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => {
                      closePalette()
                      void navigate({ name: 'editor', workflowId: null, nonce: Date.now() })
                    }}
                  >
                    New Workflow “{q}”
                  </button>
                </>
              ) : mode === 'newSession' ? (
                'Add a repository first (⌘O), or start a Chat.'
              ) : (
                'Nothing here yet.'
              )}
            </div>
          ) : (
            filtered.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null
              lastGroup = it.group
              return (
                <div key={it.id}>
                  {header && !q && <div className="palette__group">{header}</div>}
                  <div data-idx={i} className={`palette__item ${i === sel ? 'is-sel' : ''}`} onMouseMove={() => setSel(i)} onClick={() => choose(it)}>
                    <Icon name={it.icon} size={14} />
                    <span className="palette__label">{it.label}</span>
                    {it.hint && <span className={`palette__hint ${it.hintIsPath ? 'palette__hint--path' : ''}`}>{it.hint}</span>}
                    {it.kbd && <Kbd>{it.kbd}</Kbd>}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
