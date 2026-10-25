import { useEffect, useMemo, useRef, useState } from 'react'
import type { Run, Schedule, SecretMeta, Workflow } from '@shared/types'
import { Icon } from '../components/Icon'
import { Kbd } from '../components/ui'
import { rankPalette } from '../lib/paletteRank'
import { paletteEntities } from '../lib/paletteEntities'
import { agentNameNow } from './DepartmentGroup'
import { CONNECTION_CATALOG } from '../lib/connectionCatalog'
import { runTitle, sessionPlace, tildify } from '../lib/format'
import { hive } from '../lib/hive'
import { goNextNeedsYou, useLiveTruth } from '../state/live'
import { paletteSources } from '../lib/paletteScope'
import { showChecklist } from '../state/checklist'
import { openApproval } from '../state/authoring'
import { openVisualize } from '../state/diagrams'
import { kindVerb } from '../lib/authoring'
import { goToEntries, viewFor } from '../lib/nav'
import { plansEnabled } from '@shared/plans'
import { companyLabel, companyOf, isPersonal, reposOf } from '../lib/company'
import {
  openAgentSeat,
  openBoard,
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
  pauseAllSchedulesAsked,
  setCompanyPaused,
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
  /** extra search text, never shown: old nav names ("Canvas" finds Activity) and synonyms */
  keywords?: string
  /** typed exactly, these make the row the top hit (lib/paletteRank) */
  exact?: readonly string[]
  /** touches every company: never the Enter default by accident, and asks first */
  global?: boolean
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
  const companyAgents = useStore((s) => s.companyAgents)
  const tasks = useStore((s) => s.tasks)
  const truth = useLiveTruth()
  const adapter = settings?.defaultAdapter ?? 'claude'
  const plansOn = plansEnabled(settings?.experimental)
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
            // "Only {company}": another company's Knowledge and sessions stay out until the scope is widened
            ...(!scope || c.id === scope
              ? [
                  { id: `co:new:${c.id}`, group: 'Companies', label: `New session in ${companyLabel(c)}…`, icon: 'terminal', run: () => setTimeout(() => openPalette('newSession', c.id), 0) },
                  { id: `co:pp:${c.id}`, group: 'Companies', label: `Open ${companyLabel(c)} Knowledge`, keywords: 'passport', icon: 'knowledge', run: () => openCompanyPassport(c.id) }
                ]
              : [])
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
      // the company's own pause comes before the global one (design §8: Pause/Resume company in ⌘K)
      ...(scope && companies.some((c) => c.id === scope && !isPersonal(c))
        ? (() => {
            const paused = !!companies.find((c) => c.id === scope)?.pausedAt
            return [{ id: 'a:pauseCo', group: 'Actions', label: `${paused ? 'Resume' : 'Pause'} ${companyName(scope)}`, hint: paused ? 'agents, schedules and autopilot start again' : 'agents, schedules and autopilot; work in flight is saved; other companies keep running', keywords: 'pause company stop resume agents', icon: paused ? 'play' : 'pause', run: () => void setCompanyPaused(scope, !paused) }]
          })()
        : []),
      {
        // principle 1: it touches every company, so it says so, ranks last and asks first (never fired by "schedules")
        id: 'a:pause',
        group: 'Actions',
        label: `${getState().status?.schedulesPaused ? 'Resume' : 'Pause'} ${multi ? 'Schedules in All Companies…' : 'All Schedules'}`,
        icon: 'pause',
        global: multi,
        run: () => void pauseAllSchedulesAsked(!getState().status?.schedulesPaused)
      },
      { id: 'a:visualize', group: 'Actions', label: 'Visualize…', hint: 'ask the agent in the focused chat to draw it as a diagram', icon: 'canvas', run: () => setTimeout(() => openVisualize(), 0) },
      { id: 'a:sidebar', group: 'Actions', label: 'Toggle Sidebar', icon: 'sidebar', kbd: '⌘B', run: toggleSidebar },
      { id: 'a:memSearch', group: 'Actions', label: 'Search Knowledge…', hint: 'what your agents know about the business', keywords: 'memory passport notes', icon: 'search', run: () => void navigate({ name: 'passport', search: '', nonce: Date.now() }) },
      { id: 'a:nextNeeds', group: 'Actions', label: 'Next Needs You', hint: 'the oldest thing waiting for you', icon: 'agents', kbd: '⌘J', run: goNextNeedsYou },
      // five doors: "Go to" labels are the nav's own (lib/nav), old names still match as keywords
      ...goToEntries((k) => k !== 'plans' || plansOn).map<Item>((g) => ({
        id: g.id,
        group: 'Go to',
        label: g.label,
        hint: g.hint,
        icon: g.icon,
        kbd: g.kbd,
        keywords: g.keywords,
        exact: g.exact,
        run: () => void navigate('door' in g.target ? viewFor(g.target.door) : 'more' in g.target ? viewFor(g.target.more) : { name: 'settings', section: g.target.settings, nonce: Date.now() })
      })),
      { id: 'v:workflows', group: 'Go to', label: 'Automations › Workflows', hint: 'multi-step agent workflows and scripts', keywords: 'workflow editor scripts', icon: 'workflows', run: () => void navigate({ name: 'workflows' }) },
      { id: 'a:slackSearch', group: 'Actions', label: 'Search Slack…', hint: 'Principia’s local copy of your Slack', icon: 'search', run: () => void navigate({ name: 'slack', search: true, nonce: Date.now() }) },
      { id: 'a:slackTriggers', group: 'Actions', label: 'Slack Triggers', hint: 'run a workflow when someone mentions @hive', icon: 'slack', run: () => void navigate({ name: 'schedules', tab: 'slack', nonce: Date.now() }) },
      ...(scope && companies.some((c) => c.id === scope && !c.system)
        ? [{ id: 'a:checklist', group: 'Actions', label: 'Show Setup Checklist', hint: 'get the most out of Principia: connections, dashboards, autopilots', icon: 'check', run: () => showChecklist(scope) }]
        : []),
      { id: 'a:slackConnect', group: 'Actions', label: 'Slack Connection…', hint: 'Settings › Connections', icon: 'settings', run: () => void navigate({ name: 'settings', section: 'connections' }) },
      { id: 'a:linear', group: 'Actions', label: 'Linear Sync…', hint: 'Settings › Company › Linear: bring issues in as tasks', keywords: 'linear issues sync tracker', exact: ['linear', 'linear sync'], icon: 'link', run: () => void navigate({ name: 'settings', section: 'company', nonce: Date.now() }) },
      // Connections → {each} (design §8): a tool's name finds where to connect it
      ...CONNECTION_CATALOG.map<Item>((c) => ({ id: `conn:${c.id}`, group: 'Connections', label: `Connect ${c.name}…`, hint: `Settings › Connections · ${c.description}`, keywords: c.keywords, icon: 'link', run: () => void navigate({ name: 'settings', section: 'connections', nonce: Date.now() }) })),
      { id: 'v:settings', group: 'Go to', label: 'Settings', icon: 'settings', kbd: '⌘,', keywords: 'preferences', run: () => void navigate({ name: 'settings' }) }
    )
    // five doors A1/A2: inside a company only its own live rows; the working rows are the one live source's
    const live = paletteSources({ asks: Object.values(asks), drafts: Object.values(drafts), sessions, truth }, scope)
    out.push(
      ...live.drafts.map<Item>((d) => ({
        id: `draft:${d.id}`,
        group: 'Needs you',
        label: `Review: ${kindVerb(d.kind)} “${d.workflowName}”`,
        hint: d.ownerLabel,
        icon: 'workflows',
        run: () => void openApproval(d.id)
      }))
    )
    out.push(
      ...live.asks.map<Item>(({ ask: a, companyId }) => ({
        id: `ask:${a.id}`,
        group: 'Needs you',
        label: `Answer: ${a.kind === 'question' ? (a.question ?? a.title) : a.title}`,
        hint: [multi && !scope ? companyName(companyId) : null, agents[a.rootId]?.title ?? agents[a.agentId]?.title].filter(Boolean).join(' · '),
        icon: 'reply',
        run: () => void openLiveItem({ agentId: a.agentId, askId: a.id, companyId })
      })),
      ...(live.working.length
        ? [{ id: 'a:working', group: 'Working now', label: `Go to working… (${live.working.length})`, hint: 'Chats › Live', keywords: 'running live sessions agents', icon: 'agents', run: () => void navigate({ name: 'chats', filter: 'live' }) }]
        : []),
      ...live.working.slice(0, 40).map<Item>((it) => ({
        id: `agent:${it.agentId}`,
        group: 'Working now',
        label: `Go to ${it.title}`,
        hint: [multi && !scope ? companyName(it.companyId) : null, it.detail].filter(Boolean).join(' · ') || undefined,
        icon: 'agents',
        run: () => void openLiveItem({ agentId: it.agentId, askId: null, companyId: it.companyId })
      }))
    )
    out.push(
      ...live.sessions.map<Item>((s) => ({ id: `s:${s.id}`, group: 'Sessions', label: sessionTitle(s), hint: multi && !scope ? `${chip(s)} · ${sessionPlace(s)}` : sessionPlace(s), hintIsPath: !!s.repoId && !multi, icon: 'terminal', run: () => focusSession(s.id) }))
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
      // tasks by ID or title, agents by persona name (scoped like everything else here)
      ...(mode === 'all'
        ? paletteEntities({ tasks, agents: companyAgents, scope: active === 'all' ? undefined : active, nameOf: agentNameNow, companyName, multi }).map<Item>((r) => ({
            id: r.id,
            group: r.group,
            label: r.label,
            hint: r.hint || undefined,
            keywords: r.keywords,
            exact: r.exact,
            icon: r.kind === 'task' ? 'tasks' : 'agents',
            run: () => (r.kind === 'task' ? openBoard(r.companyId, { taskId: r.targetId }) : openAgentSeat({ id: r.targetId, companyId: r.companyId }))
          }))
        : []),
      ...secrets.map<Item>((k) => ({
        id: `key:${k.companyId ?? 'shared'}:${k.name}`,
        group: 'Keys',
        label: k.name,
        hint: multi ? [k.companyId ? companyName(k.companyId) : 'Shared', k.label].filter(Boolean).join(' · ') : k.label,
        icon: 'keys',
        run: () => void navigate({ name: 'settings', section: 'keys', nonce: Date.now() })
      }))
    )
    return out
  }, [mode, repos, sessions, workflows, schedules, runs, secrets, adapter, settings?.lastRepoId, agents, asks, drafts, companies, multi, active, scope, launchCompanyId, sessionCompany, plansOn, companyAgents, truth, tasks])

  const filtered = useMemo(() => rankPalette(items, q, 60), [items, q])
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
      // no match: Enter does nothing; the fallbacks below are explicit buttons, never the Enter default (D13)
      if (filtered.length) choose(filtered[sel])
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
                      void navigate({ name: 'settings', section: 'connections', nonce: Date.now() })
                    }}
                  >
                    Look in Connections
                  </button>{' '}
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
