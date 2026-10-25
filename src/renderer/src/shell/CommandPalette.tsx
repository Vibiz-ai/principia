import { useEffect, useMemo, useRef, useState } from 'react'
import type { Run, Schedule, SecretMeta, Workflow } from '@shared/types'
import { Icon } from '../components/Icon'
import { Kbd } from '../components/ui'
import { fuzzyFilter } from '../lib/fuzzy'
import { runTitle, sessionPlace, tildify } from '../lib/format'
import { hive } from '../lib/hive'
import { activityLine, agentLabel, isLive } from '../lib/live'
import { goNextNeedsYou } from '../state/live'
import { showChecklist } from '../state/checklist'
import { openApproval } from '../state/authoring'
import { openVisualize } from '../state/diagrams'
import { kindVerb } from '../lib/authoring'
import { agentCompanyResolver, companyLabel, companyOf, reposOf } from '../lib/company'
import {
  activeCompany,
  addRepos,
  closePalette,
  companyName,
  enterCompany,
  followCompany,
  multiCompany,
  openCompanyPassport,
  openLiveItem,
  openNewCompany,
  openQuickCompany,
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
  return <PaletteInner key={palette.nonce} mode={palette.mode} launchCompanyId={palette.companyId} />
}

function PaletteInner({ mode, launchCompanyId }: { mode: PaletteMode; launchCompanyId?: string }): React.JSX.Element {
  const allRepos = useStore((s) => s.repos)
  const sessions = useStore((s) => s.sessions)
  const companies = useStore((s) => s.companies)
  const multi = useStore((s) => multiCompany(s))
  const active = useStore((s) => activeCompany(s))
  /** COMPANY.md §8.6: workflows, schedules, runs and keys follow the focused company unless widened. */
  const [everywhere, setEverywhere] = useState(false)
  const scope = active === 'all' || everywhere ? undefined : active
  // "New session in X" lists X's repos; focused mode lists the focused company's
  const sessionCompany = launchCompanyId ?? (active === 'all' ? undefined : active)
  const repos = useMemo(() => (multi && sessionCompany ? reposOf(allRepos, sessionCompany) : allRepos), [multi, sessionCompany, allRepos])
  const chip = (x: { companyId?: string | null }): string | undefined => (multi ? companyName(companyOf(x)) : undefined)
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
    if (mode === 'companies') return
    const f = scope ? { companyId: scope } : undefined
    void hive.workflows.list(f).then(setWorkflows, () => undefined)
    if (mode === 'all') {
      void hive.schedules.list(f).then(setSchedules, () => undefined)
      void hive.runs.list({ limit: 20, ...f }).then(setRuns, () => undefined)
      // focused: that company's keys plus shared ones; widened: every key
      void hive.secrets.list(scope ? { companyId: scope } : undefined).then(setSecrets, () => undefined)
    }
  }, [mode, scope])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const lastRepo = settings?.lastRepoId
    const sortedRepos = [...repos].filter((r) => r.exists).sort((a, b) => (a.id === lastRepo ? -1 : b.id === lastRepo ? 1 : 0))
    const inCompany = launchCompanyId && multi ? ` (${companyName(launchCompanyId)})` : ''
    const repoItems: Item[] = sortedRepos.map((r) => ({
      id: `repo:${r.id}`,
      group: mode === 'newSession' ? `New ${providerLabel(adapter)} session in${inCompany}` : 'Repositories',
      label: mode === 'newSession' ? r.name : `New ${providerLabel(adapter)} session in ${r.name}`,
      hint: multi && !sessionCompany ? `${chip(r)} · ${tildify(r.path)}` : tildify(r.path),
      hintIsPath: true,
      icon: 'folder',
      run: () => void startSession({ repoId: r.id, forceNew: true })
    }))
    const chatItem: Item = {
      id: 'chat',
      group: mode === 'newSession' ? `New ${providerLabel(adapter)} session in${inCompany}` : 'Actions',
      label: mode === 'newSession' ? (sessionCompany && multi ? `Chat (${companyName(sessionCompany)} workspace)` : 'Chat (scratch folder)') : 'New Chat',
      icon: 'chat',
      kbd: '⌥⌘N',
      run: () => void openChat(true, launchCompanyId)
    }
    // COMPANY.md §8.6: the Companies group (and the whole list for ⇧⌘O)
    const companyItems: Item[] = !multi
      ? [
          { id: 'co:new', group: 'Companies', label: 'New Company…', hint: 'group repositories, keys and memory per business', icon: 'passport', run: openNewCompany },
          { id: 'co:quick', group: 'Companies', label: 'New company (name only)', hint: 'skip the setup, just a name and a colour', icon: 'plus', run: openQuickCompany }
        ]
      : [
          ...(active !== 'all' ? [{ id: 'co:all', group: 'Companies', label: 'Switch to All companies', icon: 'grid', kbd: '⌃0', run: () => void enterCompany('all') }] : []),
          ...companies.flatMap<Item>((c, i) => [
            ...(c.id !== active ? [{ id: `co:sw:${c.id}`, group: 'Companies', label: `Switch to ${companyLabel(c, true)}`, icon: 'passport', kbd: i < 9 ? `⌃${i + 1}` : undefined, run: () => void enterCompany(c.id) }] : []),
            { id: `co:new:${c.id}`, group: 'Companies', label: `New session in ${companyLabel(c)}…`, icon: 'terminal', run: () => setTimeout(() => openPalette('newSession', c.id), 0) },
            { id: `co:pp:${c.id}`, group: 'Companies', label: `Open ${companyLabel(c)} Passport`, icon: 'passport', run: () => openCompanyPassport(c.id) }
          ]),
          { id: 'co:new', group: 'Companies', label: 'New Company…', icon: 'plus', run: openNewCompany },
          { id: 'co:quick', group: 'Companies', label: 'New company (name only)', hint: 'skip the setup, just a name and a colour', icon: 'plus', run: openQuickCompany }
        ]
    if (mode === 'companies') return companyItems
    const wfItems: Item[] = workflows.map((w) => ({
      id: `wf:${w.id}`,
      group: 'Workflows',
      label: `Run ${w.name}`,
      hint: multi && !scope ? [chip(w), w.description].filter(Boolean).join(' · ') : w.description,
      icon: 'play',
      run: () => openRunInputs(w.id)
    }))
    if (mode === 'newSession') return [...repoItems, chatItem]
    if (mode === 'runWorkflow') return wfItems
    if (multi) out.push(...companyItems)
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
      { id: 'a:visualize', group: 'Actions', label: 'Visualize…', hint: 'ask the agent in the focused chat to draw it as a diagram', icon: 'canvas', run: () => setTimeout(() => openVisualize(), 0) },
      { id: 'a:sidebar', group: 'Actions', label: 'Toggle Sidebar', icon: 'sidebar', kbd: '⌘B', run: toggleSidebar },
      { id: 'a:memSearch', group: 'Actions', label: 'Search Memory…', hint: 'what agents remember about your repos', icon: 'search', run: () => void navigate({ name: 'memory', search: true, nonce: Date.now() }) },
      { id: 'a:nextNeeds', group: 'Actions', label: 'Next Needs You', hint: 'the oldest thing waiting for you', icon: 'agents', kbd: '⌘J', run: goNextNeedsYou },
      { id: 'v:agents', group: 'Go to', label: 'Agents', icon: 'agents', kbd: '⇧⌘A', run: () => void navigate({ name: 'agents' }) },
      { id: 'v:home', group: 'Go to', label: 'Home', icon: 'home', kbd: '⌘1', run: () => void navigate({ name: 'home' }) },
      { id: 'v:tasks', group: 'Go to', label: 'Tasks — company work and agent runs', icon: 'tasks', run: () => void navigate({ name: 'tasks' }) },
      { id: 'v:passport', group: 'Go to', label: 'Passport — what agents know about the company', icon: 'passport', kbd: '⌘7', run: () => void navigate({ name: 'passport', nonce: Date.now() }) },
      { id: 'v:company', group: 'Go to', label: 'Company Settings — name, colour, repositories, profile', icon: 'settings', run: () => void navigate({ name: 'company', nonce: Date.now() }) },
      { id: 'v:canvas', group: 'Go to', label: 'Canvas', icon: 'canvas', kbd: '⌘2', run: () => void navigate({ name: 'canvas' }) },
      { id: 'v:market', group: 'Go to', label: 'Marketplace — workflows and skills', icon: 'marketplace', run: () => void navigate({ name: 'marketplace' }) },
      { id: 'v:wf', group: 'Go to', label: 'Workflows', icon: 'workflows', kbd: '⌘3', run: () => void navigate({ name: 'workflows' }) },
      { id: 'v:sch', group: 'Go to', label: 'Schedules', icon: 'schedules', kbd: '⌘4', run: () => void navigate({ name: 'schedules' }) },
      { id: 'v:art', group: 'Go to', label: 'Artifacts', icon: 'artifacts', kbd: '⌘5', run: () => void navigate({ name: 'artifacts' }) },
      { id: 'v:keys', group: 'Go to', label: 'Keys', icon: 'keys', kbd: '⌘6', run: () => void navigate({ name: 'keys' }) },
      { id: 'v:memory', group: 'Go to', label: 'Open Memory', icon: 'memory', run: () => void navigate({ name: 'memory' }) },
      { id: 'v:usage', group: 'Go to', label: 'Usage', hint: 'tokens, cost and disk per company', icon: 'coins', run: () => void navigate({ name: 'usage' }) },
      { id: 'v:cloud', group: 'Go to', label: 'Cloud', hint: 'Principia Cloud: agents online while your Mac sleeps', icon: 'globe', run: () => void navigate({ name: 'cloud' }) },
      { id: 'v:slack', group: 'Go to', label: 'Slack', icon: 'slack', kbd: '⇧⌘L', run: () => void navigate({ name: 'slack', nonce: Date.now() }) },
      { id: 'a:slackSearch', group: 'Actions', label: 'Search Slack…', hint: 'Principia’s local copy of your Slack', icon: 'search', run: () => void navigate({ name: 'slack', search: true, nonce: Date.now() }) },
      { id: 'a:slackTriggers', group: 'Actions', label: 'Slack Triggers', hint: 'run a workflow when someone mentions @hive', icon: 'slack', run: () => void navigate({ name: 'schedules', tab: 'slack', nonce: Date.now() }) },
      ...(scope && companies.some((c) => c.id === scope && !c.system)
        ? [{ id: 'a:checklist', group: 'Actions', label: 'Show Setup Checklist', hint: 'get the most out of Principia: connections, dashboards, autopilots', icon: 'check', run: () => showChecklist(scope) }]
        : []),
      { id: 'a:slackConnect', group: 'Actions', label: 'Slack Connection…', hint: 'Settings › Connections', icon: 'settings', run: () => void navigate({ name: 'settings', section: 'connections' }) },
      { id: 'v:settings', group: 'Go to', label: 'Settings', icon: 'settings', kbd: '⌘,', run: () => void navigate({ name: 'settings' }) }
    )
    const openAsks = Object.values(asks).filter((a) => a.status === 'open' && a.kind !== 'approval').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const agentCompany = agentCompanyResolver(Object.values(agents), sessions)
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
        hint: [multi ? companyName((a as { companyId?: string }).companyId || agentCompany(agents[a.agentId] ?? agents[a.rootId], a.sessionId)) : null, agents[a.rootId]?.title ?? agents[a.agentId]?.title].filter(Boolean).join(' · '),
        icon: 'reply',
        run: () => void openLiveItem({ agentId: a.agentId, askId: a.id, companyId: (a as { companyId?: string }).companyId || agentCompany(agents[a.agentId] ?? agents[a.rootId], a.sessionId) })
      })),
      ...Object.values(agents)
        .filter((a) => isLive(a))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 40)
        .map<Item>((a) => ({
          id: `agent:${a.id}`,
          group: 'Live agents',
          label: `Go to ${a.kind === 'subagent' ? `${agentLabel(a)} (subagent)` : a.title}`,
          hint: multi ? `${companyName(agentCompany(a))} · ${activityLine(a) ?? ''}` : activityLine(a),
          icon: 'agents',
          run: () => void openLiveItem({ agentId: a.id, askId: null, companyId: agentCompany(a) })
        }))
    )
    out.push(
      ...sessions
        .filter((s) => s.status === 'running')
        .map<Item>((s) => ({ id: `s:${s.id}`, group: 'Sessions', label: sessionTitle(s), hint: multi ? `${chip(s)} · ${sessionPlace(s)}` : sessionPlace(s), hintIsPath: !!s.repoId && !multi, icon: 'terminal', run: () => focusSession(s.id) }))
    )
    if (!multi) out.push(...companyItems)
    out.push(...repoItems, ...wfItems)
    out.push(
      ...workflows.map<Item>((w) => ({ id: `wfe:${w.id}`, group: 'Workflows', label: `Edit ${w.name}`, icon: 'workflows', run: () => void navigate({ name: 'editor', workflowId: w.id, nonce: Date.now() }) })),
      ...workflows.map<Item>((w) => ({ id: `wfs:${w.id}`, group: 'Workflows', label: `Schedule ${w.name}…`, icon: 'schedules', run: () => void navigate({ name: 'schedules', seed: { workflowId: w.id }, nonce: Date.now() }) })),
      ...schedules.map<Item>((s) => ({ id: `sch:${s.id}`, group: 'Schedules', label: s.name, hint: multi && !scope ? `${chip(s)} · ${s.sentence}` : s.sentence, icon: 'clock', run: () => void navigate({ name: 'schedules', selectedId: s.id }) })),
      ...runs.map<Item>((r) => ({
        id: `run:${r.id}`,
        group: 'Recent runs',
        label: runTitle(r, 60),
        hint: scope ? r.status : [chip(r), r.status].filter(Boolean).join(' · '),
        icon: 'play',
        run: () => {
          void navigate({ name: 'run', runId: r.id })
          followCompany(companyOf(r))
        }
      })),
      ...secrets.map<Item>((k) => ({
        id: `key:${k.companyId ?? 'shared'}:${k.name}`,
        group: 'Keys',
        label: k.name,
        hint: multi ? [k.companyId ? companyName(k.companyId) : 'Shared', k.label].filter(Boolean).join(' · ') : k.label,
        icon: 'keys',
        run: () => void navigate({ name: 'keys' })
      }))
    )
    return out
  }, [mode, repos, sessions, workflows, schedules, runs, secrets, adapter, settings?.lastRepoId, agents, asks, drafts, companies, multi, active, scope, launchCompanyId, sessionCompany])

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
  const placeholder = mode === 'newSession' ? `Start ${providerLabel(adapter)} in…` : mode === 'runWorkflow' ? 'Run workflow…' : mode === 'companies' ? 'Switch company…' : 'Search Principia or run a command'
  const canWiden = multi && active !== 'all' && mode !== 'companies' && mode !== 'newSession'
  return (
    <div className="palette-layer" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette__input">
          <Icon name="search" />
          <input autoFocus value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
          {canWiden && (
            <button
              type="button"
              className={`palette__scope ${everywhere ? 'is-on' : ''}`}
              aria-pressed={everywhere}
              title="Workflows, schedules, runs and keys: this company only, or every company"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEverywhere(!everywhere)}
            >
              {everywhere ? 'All companies' : `Only ${companyName(active)}`}
            </button>
          )}
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
