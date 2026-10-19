/**
 * Memory page (MEMORY.md §10, PO8/PO9): what agents know about a repo, as a graph you can click,
 * a newest-first table, and a review queue. Every row shows who wrote it, from which run, and when.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AdapterId, Id } from '@shared/types'
import type { MemoryEntity, MemoryFact, MemoryFactKind, MemoryGraph as Graph, MemoryOverview, MemoryRelation, MemoryScopeFilter, MemorySearchHit } from '@shared/memory'
import { MEMORY_FACT_KINDS } from '@shared/memory'
import { Icon } from '../components/Icon'
import { MemoryGraph } from '../components/memory/MemoryGraph'
import { MemoryInspector } from '../components/memory/MemoryInspector'
import { FactsTable } from '../components/memory/FactsTable'
import { ReviewQueue } from '../components/memory/ReviewQueue'
import { AskProvider, mutate } from '../components/memory/actions'
import { EntityPicker, type EntityPick } from '../components/memory/EntityPicker'
import { AutoTextarea, Button, EmptyState, ErrorState, Field, IconButton, Kbd, Loading, Segmented, Sheet, Switch, Toolbar } from '../components/ui'
import { ENTITY_TYPES, KIND_GLYPH, KIND_LABEL, KIND_SINGULAR, TIME_WINDOW_LABEL, adapterName, briefPinned, entityHue, factsByEntity, keyKnowledge, recentOffGraph, runsFrom, typeCounts, whyText, withinWindow, type TimeWindow } from '../lib/memory'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { attempt, getState, loadJson, navigate, saveJson, setMemoryPaused, setState, toast, useStore, type MemoryPageScope, type ViewState } from '../state/store'
import '../styles/memory.css'

type Tab = 'graph' | 'facts' | 'review'
type Author = 'all' | 'user' | Exclude<AdapterId, 'shell'>
const AUTHORS: Author[] = ['all', 'user', 'claude', 'codex', 'cursor', 'gemini']

interface Filters {
  kinds: MemoryFactKind[] // [] = all
  author: Author
  window: TimeWindow
  history: boolean
  unreviewedOnly: boolean
  /** Entity types to isolate on the graph (legend clicks); [] = all. */
  types: string[]
}
const NO_FILTERS: Filters = { kinds: [], author: 'all', window: 'any', history: false, unreviewedOnly: false, types: [] }
/** Below this window width (or with the inspector open) the filter rail folds into a "Filters" popover. */
const RAIL_MIN_WIDTH = 1200
const sameFilters = (a: Filters, b: Filters): boolean => JSON.stringify(a) === JSON.stringify(b)

function scopeKey(s: MemoryPageScope | null): string {
  return !s ? '' : typeof s === 'string' ? s : s.repoId
}

export function MemoryView({ view }: { view: Extract<ViewState, { name: 'memory' }> }): React.JSX.Element {
  return (
    <AskProvider>
      <MemoryPage view={view} />
    </AskProvider>
  )
}

function MemoryPage({ view }: { view: Extract<ViewState, { name: 'memory' }> }): React.JSX.Element {
  const overview = useStore((s) => s.memory)
  const repos = useStore((s) => s.repos)
  const lastRepoId = useStore((s) => s.settings?.lastRepoId ?? null)
  const sessionsWrite = useStore((s) => (s.settings?.sessionMemory ?? 'read-write') === 'read-write')
  const [ovError, setOvError] = useState<string | null>(null)
  const [scope, setScope] = useState<MemoryPageScope | null>(view.scope ?? null)
  const [runId, setRunId] = useState<Id | null>(view.runId ?? null)
  /** LIVE.md §7: what one interactive session wrote (session memory chip). */
  const [sessionId, setSessionId] = useState<Id | null>(view.sessionId ?? null)
  const [runTitle, setRunTitle] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => loadJson<Tab>('hive.memory.tab', 'graph'))
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [selected, setSelected] = useState<Id | null>(view.entityId ?? null)
  const [center, setCenter] = useState<{ id: Id; name: string; hops: 1 | 2 } | null>(null)
  const [focus, setFocus] = useState<{ id: Id; n: number } | null>(view.entityId ? { id: view.entityId, n: 0 } : null)
  const [graph, setGraph] = useState<Graph | null>(null)
  /** When the current graph arrived: a focus requested after that waits for the next load. */
  const [graphAt, setGraphAt] = useState(0)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [facts, setFacts] = useState<{ items: MemoryFact[]; total: number } | null>(null)
  const [pending, setPending] = useState<MemoryFact[]>([])
  const [pendingRels, setPendingRels] = useState<{ relations: MemoryRelation[]; names: Record<string, string> }>({ relations: [], names: {} })
  const [briefOpen, setBriefOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth < RAIL_MIN_WIDTH)
  const [allRuns, setAllRuns] = useState<{ runId: Id; title: string; at: string }[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const [adding, setAdding] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // ---- overview (also refreshed by the store on memory:changed) ----
  const loadOverview = useCallback(() => {
    hive.memory.overview().then(
      (o) => {
        setState({ memory: o })
        setOvError(null)
      },
      (e) => setOvError(errorMessage(e))
    )
  }, [])
  useEffect(loadOverview, [loadOverview])

  // deep links (RunView chip, palette) re-apply on every navigation
  useEffect(() => {
    if (view.scope) setScope(view.scope)
    if (view.runId !== undefined) setRunId(view.runId ?? null)
    setSessionId(view.sessionId ?? null)
    if (view.entityId) {
      setSelected(view.entityId)
      setFocus({ id: view.entityId, n: Date.now() })
    }
    if (view.runId) setTab((t) => (t === 'review' ? 'graph' : t))
    if (view.search) setTimeout(() => searchRef.current?.focus(), 50)
  }, [view.nonce])

  // PO8: open on the most recently used repo, not "All"
  useEffect(() => {
    if (scope || !overview) return
    const id = overview.defaultRepoId ?? (lastRepoId && repos.some((r) => r.id === lastRepoId) ? lastRepoId : null) ?? overview.repos[0]?.repoId ?? null
    setScope(id ? { repoId: id } : 'all')
  }, [overview, scope, lastRepoId, repos])

  // live updates from any process (agent MCP servers included), debounced
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useHiveEvent('memory:changed', () => {
    if (changeTimer.current) return
    changeTimer.current = setTimeout(() => {
      changeTimer.current = null
      setReloadKey((k) => k + 1)
    }, 250)
  })
  useEffect(() => () => void (changeTimer.current && clearTimeout(changeTimer.current)), [])
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  const repoNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const r of overview?.repos ?? []) m[r.repoId] = r.repoName
    for (const r of repos) m[r.id] = r.name
    return m
  }, [overview?.repos, repos])

  const scopeArg: MemoryScopeFilter['scope'] = scope ?? 'all'
  const sk = scopeKey(scope)
  const query = useMemo<Omit<MemoryScopeFilter, 'runId'>>(
    () => ({
      scope: scopeArg,
      kinds: filters.kinds.length && filters.kinds.length < MEMORY_FACT_KINDS.length ? filters.kinds : undefined,
      actors: filters.author === 'all' ? undefined : filters.author === 'user' ? ['user'] : ['agent'],
      adapters: filters.author === 'all' || filters.author === 'user' ? undefined : [filters.author],
      statuses: filters.history ? ['active', 'pending', 'invalid'] : undefined,
      unreviewedOnly: filters.unreviewedOnly || undefined,
      sessionId: sessionId ?? undefined
    }),
    // scopeArg is derived from sk
    [sk, filters.kinds, filters.author, filters.history, filters.unreviewedOnly, sessionId]
  )

  // ---- data ----
  useEffect(() => {
    if (!scope) return
    let live = true
    hive.memory
      .graph({ ...query, runId: runId ?? undefined, centerId: center?.id, hops: center ? center.hops : undefined })
      .then(
        (g) => {
          if (!live) return
          setGraph(g)
          setGraphAt(Date.now())
          setGraphError(null)
        },
        (e) => live && setGraphError(errorMessage(e))
      )
    return () => {
      live = false
    }
  }, [scope, query, runId, center, reloadKey])

  useEffect(() => {
    if (!scope) return
    let live = true
    hive.memory.facts({ ...query, runId: runId ?? undefined, limit: 1000 }).then(
      (r) => live && setFacts(r),
      () => live && setFacts({ items: [], total: 0 })
    )
    return () => {
      live = false
    }
  }, [scope, query, runId, reloadKey])

  useEffect(() => {
    if (!scope) return
    let live = true
    hive.memory.facts({ scope: scopeArg, statuses: ['pending'], limit: 500 }).then(
      (r) => live && setPending(r.items),
      () => live && setPending([])
    )
    // contested relations wait for review too (they count in the sidebar badge). The graph query caps entities at
    // 150, so "All" asks per repository (and global) to stay complete for real repo sizes.
    const scopes: MemoryScopeFilter['scope'][] = scopeArg === 'all' ? [...(getState().memory?.repos ?? []).map((r) => ({ repoId: r.repoId })), 'global'] : [scopeArg]
    Promise.all(scopes.map((sc) => hive.memory.graph({ scope: sc, statuses: ['pending'] }))).then(
      (gs) => {
        if (!live) return
        const names: Record<string, string> = {}
        const rels = new Map<string, MemoryRelation>()
        for (const g of gs) {
          for (const e of g.entities) names[e.id] = e.name
          for (const r of g.relations) if (r.status === 'pending') rels.set(r.id, r)
        }
        setPendingRels({ relations: [...rels.values()].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)), names })
      },
      () => live && setPendingRels({ relations: [], names: {} })
    )
    // run picker options: every run that wrote memory in this scope (unaffected by the other filters)
    hive.memory.facts({ scope: scopeArg, statuses: ['active', 'pending', 'invalid'], limit: 1000 }).then(
      (r) => live && setAllRuns(runsFrom(r.items)),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [sk, reloadKey])

  useEffect(() => {
    if (!runId) return setRunTitle(null)
    const known = allRuns.find((r) => r.runId === runId)
    if (known) return setRunTitle(known.title)
    void hive.memory.grants({ runId }).then((g) => setRunTitle(g.find((x) => x.runTitle)?.runTitle ?? null), () => undefined)
  }, [runId, allRuns])

  // ---- client-side time window (the contract leaves time to the page) ----
  const windowGraph = useMemo<Graph | null>(() => {
    if (!graph || filters.window === 'any') return graph
    const keep = new Set(graph.entities.filter((e) => withinWindow(e.changedAt, filters.window)).map((e) => e.id))
    return { ...graph, entities: graph.entities.filter((e) => keep.has(e.id)), relations: graph.relations.filter((r) => keep.has(r.fromId) && keep.has(r.toId)) }
  }, [graph, filters.window])
  // legend types come from the graph before the type filter, so an isolated type can be switched back
  const types = useMemo(() => (windowGraph ? typeCounts(windowGraph.entities) : []), [windowGraph])
  const shownGraph = useMemo<Graph | null>(() => {
    if (!windowGraph || !filters.types.length) return windowGraph
    const on = new Set(filters.types)
    const keep = new Set(windowGraph.entities.filter((e) => on.has(e.type.trim().toLowerCase() || 'other')).map((e) => e.id))
    return { ...windowGraph, entities: windowGraph.entities.filter((e) => keep.has(e.id)), relations: windowGraph.relations.filter((r) => keep.has(r.fromId) && keep.has(r.toId)) }
  }, [windowGraph, filters.types])
  const shownFacts = useMemo(() => (facts ? facts.items.filter((f) => withinWindow(f.createdAt, filters.window)) : null), [facts, filters.window])
  const runTouched = useMemo(() => (runId && graph?.runTouched ? new Set(graph.runTouched) : null), [runId, graph?.runTouched])
  const factsMap = useMemo(() => factsByEntity(facts?.items ?? []), [facts])
  // over the 150 cap, recently written entities may be outside the overview: offer them in the banner
  const recentHidden = useMemo(
    () => (graph?.truncated && !center && facts ? recentOffGraph(facts.items, new Set(graph.entities.map((e) => e.id))) : []),
    [graph, center, facts]
  )

  // a focused entity (just added, deep link) that the capped overview doesn't show: open its neighborhood
  const focusHandled = useRef<string | null>(null)
  useEffect(() => {
    if (!focus || !graph || center || graphAt < focus.n) return
    const k = `${focus.id}:${focus.n}`
    if (focusHandled.current === k) return
    focusHandled.current = k
    if (graph.entities.some((e) => e.id === focus.id)) return
    const name = facts?.items.find((f) => f.entityId === focus.id)?.entityName ?? 'entity'
    setCenter({ id: focus.id, name, hops: 1 })
  }, [focus, graph, graphAt, center, facts])

  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < RAIL_MIN_WIDTH)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ---- selection / navigation inside the page ----
  const selectEntity = useCallback(
    (id: Id | null, opts: { focus?: boolean } = {}) => {
      setSelected(id)
      if (id && opts.focus) setFocus({ id, n: Date.now() })
    },
    []
  )
  const pickSearchHit = (e: MemoryEntity): void => {
    const onGraph = shownGraph?.entities.some((x) => x.id === e.id)
    if (!onGraph) setCenter({ id: e.id, name: e.name, hops: 2 })
    setTab('graph')
    selectEntity(e.id, { focus: true })
  }

  useEffect(() => saveJson('hive.memory.tab', tab), [tab])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyF') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key === 'Escape' && !document.querySelector('.sheet-layer, .palette-layer')) {
        const t = e.target as HTMLElement
        if (t.closest('input, textarea, select')) return
        if (selected) {
          e.preventDefault()
          setSelected(null)
        } else if (center) {
          e.preventDefault()
          setCenter(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, center])

  // ---- actions ----
  const revertRun = async (): Promise<void> => {
    if (!runId) return
    const ok = await confirmNative({
      message: `Revert what “${runTitle ?? 'this run'}” wrote to memory?`,
      detail: 'Everything it wrote is invalidated (kept in History) and the memories it replaced come back. This can’t be undone as a whole; restore single items from History if needed.',
      confirmLabel: 'Revert Run',
      destructive: true
    }).catch(() => false)
    if (!ok) return
    const res = await attempt(() => hive.memory.revertRun({ runId }), 'Revert run')
    if (res) {
      toast(`Reverted: ${res.invalidated} invalidated, ${res.restored} restored`)
      reload()
    }
  }
  const exportMemory = async (): Promise<void> => {
    const res = await attempt(() => hive.memory.export({ scope: scopeArg }), 'Export memory')
    if (res) toast(`Exported to ${res.path}`)
  }
  const moreMenu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'add', label: 'Add Memory…' },
      { id: 'export', label: 'Export as JSONL…' },
      { type: 'separator' },
      { id: 'sessions', label: 'Memory for New Sessions…' }
    ])
    if (id === 'add') setAdding(true)
    if (id === 'export') void exportMemory()
    if (id === 'sessions') void navigate({ name: 'settings', section: 'agents' })
  }

  // ---- render ----
  if (ovError && !overview) {
    return (
      <div className="view">
        <Toolbar title="Memory" />
        <ErrorState error={`Couldn’t open memory: ${ovError}`} onRetry={loadOverview} />
      </div>
    )
  }
  if (!overview || !scope) {
    return (
      <div className="view">
        <Toolbar title="Memory" />
        <Loading />
      </div>
    )
  }

  const nothingAtAll = overview.counts.entities === 0 && overview.counts.facts === 0
  const filtered = !sameFilters(filters, NO_FILTERS) || !!runId || !!sessionId
  const reviewCount = pending.length + pendingRels.relations.length
  const elsewhere = Math.max(0, overview.counts.pending - reviewCount)
  const compactRail = narrow || !!selected
  const activeFilters =
    (filters.kinds.length ? 1 : 0) + (filters.author !== 'all' ? 1 : 0) + (filters.window !== 'any' ? 1 : 0) + (filters.history ? 1 : 0) + (filters.unreviewedOnly ? 1 : 0) + (filters.types.length ? 1 : 0)
  const toggleType = (t: string): void => {
    const cur = filters.types
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    setFilters({ ...filters, types: next.length >= types.length ? [] : next })
  }

  return (
    <div className="view mview">
      <Toolbar
        title="Memory"
        sub={
          !nothingAtAll && (
            <div className="mview__pickers">
              <ScopePicker scope={scope} onChange={(s) => {
                setScope(s)
                setCenter(null)
                setSelected(null)
              }} overview={overview} repoNames={repoNames} />
              <RunPicker runId={runId} title={runTitle} runs={allRuns} onChange={setRunId} />
              {sessionId && (
                <button type="button" className="hchip is-on no-drag" onClick={() => setSessionId(null)} title="Showing what one session wrote. Click to show everything.">
                  This session ×
                </button>
              )}
            </div>
          )
        }
      >
        {!nothingAtAll && <SearchBox inputRef={searchRef} scope={scopeArg} onPick={pickSearchHit} />}
        <label className="mview__pause" title="Stops every agent from writing memory. Reading keeps working.">
          <Switch checked={overview.agentWritesPaused} onChange={(v) => void setMemoryPaused(v)} label="Pause agent writes" />
          <span className={overview.agentWritesPaused ? 'text-warning' : 'text-secondary'}>{overview.agentWritesPaused ? 'Agent writes paused' : 'Pause agent writes'}</span>
        </label>
        <IconButton icon="plus" label="Add memory" onClick={() => setAdding(true)} />
        <IconButton icon="more" label="More" onClick={() => void moreMenu()} />
      </Toolbar>

      {nothingAtAll ? (
        <EmptyState
          icon="memory"
          text={
            <span className="mview__empty-text">
              <span className="mview__empty-title">No memories yet</span>
              {sessionsWrite ? (
                <>
                  Memory is on: new sessions in a repo can read and write it, and agents save decisions, conventions and gotchas
                  here as they finish tasks. Chat sessions (no repo) can only read. Workflow steps read by default; set a step or
                  a whole workflow to Read &amp; write to let it add memories.
                </>
              ) : (
                <>
                  Agents save decisions, conventions and gotchas about your repos here, so the next run starts from them. New
                  workflow steps read memory by default; set a step, a whole workflow or new sessions to Read &amp; write to let
                  agents add to it.
                </>
              )}
            </span>
          }
        >
          {!sessionsWrite && (
            <Button variant="primary" onClick={() => void navigate({ name: 'settings', section: 'agents' })}>
              Turn On for Sessions
            </Button>
          )}
          <Button onClick={() => void navigate({ name: 'workflows' })}>Open Workflows</Button>
          <Button variant="ghost" icon="plus" onClick={() => setAdding(true)}>
            Add Memory
          </Button>
        </EmptyState>
      ) : (
        <div className="mview__body">
          {(!compactRail || railOpen) && (
            <FilterRail filters={filters} onChange={setFilters} graph={shownGraph} factCount={shownFacts?.length ?? null} overlay={compactRail} onClose={() => setRailOpen(false)} />
          )}
          <div className="mview__main">
            <div className="mview__tabs">
              {compactRail && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={`mview__filters-btn ${activeFilters ? 'is-active' : ''}`}
                  onClick={() => setRailOpen((o) => !o)}
                  title="Show filters"
                >
                  Filters{activeFilters ? ` · ${activeFilters}` : ''}
                </Button>
              )}
              <Segmented<Tab>
                size="sm"
                items={[
                  { value: 'graph', label: 'Graph' },
                  { value: 'facts', label: 'Facts' },
                  { value: 'review', label: reviewCount ? <>Review <span className="mview__count">{reviewCount}</span></> : 'Review' }
                ]}
                value={tab}
                onChange={setTab}
              />
              {center && tab === 'graph' && (
                <span className="chip mview__chip" title="Showing one entity’s neighborhood">
                  Around {center.name} · {center.hops} hop{center.hops === 1 ? '' : 's'}
                  <button type="button" className="chip__x" aria-label="Back to the overview (Esc)" onClick={() => setCenter(null)}>
                    ×
                  </button>
                </span>
              )}
              <span className="flex1" />
              <Button size="sm" variant="ghost" icon="memory" onClick={() => setBriefOpen(true)} title="What agents get from memory at the start of a step or session">
                What Agents Know
              </Button>
            </div>

            {tab === 'graph' &&
              (graphError && !graph ? (
                <ErrorState error={graphError} onRetry={reload} />
              ) : !shownGraph ? (
                <Loading />
              ) : shownGraph.entities.length === 0 ? (
                <FilteredEmpty filtered={filtered} scope={scope} repoNames={repoNames} onClear={() => {
                  setFilters(NO_FILTERS)
                  setRunId(null)
                }} onAdd={() => setAdding(true)} />
              ) : (
                <>
                  {shownGraph.truncated && (
                    <div className="banner banner--bar mview__banner">
                      Showing the {graph?.entities.length ?? shownGraph.entities.length} most connected of {shownGraph.total} entities. Search (⌘F) or double-click a node to explore its neighborhood.
                      {recentHidden.length > 0 && (
                        <>
                          <span className="text-tertiary">Recently changed, not shown:</span>
                          {recentHidden.map((r) => (
                            <button key={r.id} type="button" className="link-btn" onClick={() => {
                              setCenter({ id: r.id, name: r.name, hops: 1 })
                              selectEntity(r.id, { focus: true })
                            }}>
                              {r.name}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                  <MemoryGraph
                    graph={shownGraph}
                    repoNames={repoNames}
                    facts={factsMap}
                    selectedId={selected}
                    focusId={focus ? focus.id : null}
                    runTouched={runTouched}
                    onSelect={(id) => selectEntity(id)}
                    onExpand={(id) => {
                      const e = shownGraph.entities.find((x) => x.id === id)
                      setCenter({ id, name: e?.name ?? 'entity', hops: 1 })
                      selectEntity(id, { focus: true })
                    }}
                    onContext={(id) => void entityContextMenu(id, shownGraph, selectEntity, setCenter)}
                  >
                    <GraphLegend types={types} isolated={filters.types} onToggle={toggleType} onReset={() => setFilters({ ...filters, types: [] })} />
                  </MemoryGraph>
                </>
              ))}
            {tab === 'facts' &&
              (!shownFacts ? (
                <Loading />
              ) : shownFacts.length === 0 ? (
                <FilteredEmpty filtered={filtered} scope={scope} repoNames={repoNames} onClear={() => {
                  setFilters(NO_FILTERS)
                  setRunId(null)
                }} onAdd={() => setAdding(true)} />
              ) : (
                <FactsTable
                  facts={shownFacts}
                  total={facts?.total ?? shownFacts.length}
                  selectedEntityId={selected}
                  runLabel={runId ? (runTitle ?? 'run') : null}
                  onRevertRun={runId ? () => void revertRun() : null}
                  onSelectEntity={(id) => selectEntity(id)}
                  onChanged={reload}
                />
              ))}
            {tab === 'review' && (
              <ReviewQueue
                facts={pending}
                relations={pendingRels.relations}
                entityNames={pendingRels.names}
                elsewhere={scope === 'all' ? 0 : elsewhere}
                onShowAll={() => {
                  setScope('all')
                  setCenter(null)
                  setSelected(null)
                }}
                onSelectEntity={(id) => selectEntity(id)}
                onChanged={reload}
              />
            )}
          </div>
          {selected && (
            <MemoryInspector
              entityId={selected}
              reloadKey={reloadKey}
              candidates={shownGraph?.entities ?? []}
              scope={scopeArg}
              repoNames={repoNames}
              onSelect={(id) => selectEntity(id, { focus: true })}
              onClose={() => setSelected(null)}
              onDeleted={() => {
                setSelected(null)
                reload()
              }}
            />
          )}
        </div>
      )}
      {briefOpen && (
        <BriefSheet
          scope={scope}
          repoNames={repoNames}
          onPickEntity={(id) => {
            setBriefOpen(false)
            setTab('graph')
            selectEntity(id, { focus: true })
          }}
          onClose={() => setBriefOpen(false)}
        />
      )}
      {adding && (
        <AddMemorySheet
          scope={scope}
          repoNames={repoNames}
          candidates={shownGraph?.entities ?? []}
          onClose={(entityId) => {
            setAdding(false)
            if (!entityId) return
            reload()
            loadOverview()
            selectEntity(entityId, { focus: true })
          }}
        />
      )}
    </div>
  )
}

async function entityContextMenu(id: Id, g: Graph, select: (id: Id | null, o?: { focus?: boolean }) => void, setCenter: (c: { id: Id; name: string; hops: 1 | 2 } | null) => void): Promise<void> {
  const e = g.entities.find((x) => x.id === id)
  if (!e) return
  const choice = await nativeMenu([
    { id: 'inspect', label: 'Inspect' },
    { id: 'n1', label: 'Show Neighbors' },
    { id: 'n2', label: 'Show 2 Hops' },
    { type: 'separator' },
    { id: 'copy', label: 'Copy Name' }
  ])
  if (choice === 'inspect') select(id)
  if (choice === 'n1' || choice === 'n2') {
    setCenter({ id, name: e.name, hops: choice === 'n1' ? 1 : 2 })
    select(id, { focus: true })
  }
  if (choice === 'copy') void hive.clipboard.writeText({ text: e.name }).then(() => toast('Copied'))
}

// ---------- header pieces ----------
function ScopePicker({ scope, onChange, overview, repoNames }: { scope: MemoryPageScope; onChange: (s: MemoryPageScope) => void; overview: MemoryOverview; repoNames: Record<string, string> }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const withMemory = new Map(overview.repos.map((r) => [r.repoId, r]))
  const others = repos.filter((r) => !withMemory.has(r.id))
  const value = typeof scope === 'string' ? scope : `repo:${scope.repoId}`
  return (
    <select
      className="input input--sm mview__select"
      value={value}
      aria-label="Which memory to show"
      title="Project memory of one repository (plus global), global only, or everything"
      onChange={(e) => {
        const v = e.target.value
        onChange(v === 'all' || v === 'global' ? v : { repoId: v.slice(5) })
      }}
    >
      {overview.repos.length > 0 && (
        <optgroup label="Repositories with memory">
          {overview.repos.map((r) => (
            <option key={r.repoId} value={`repo:${r.repoId}`}>
              {repoNames[r.repoId] ?? r.repoName} · {r.facts}
            </option>
          ))}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label="Other repositories">
          {others.map((r) => (
            <option key={r.id} value={`repo:${r.id}`}>
              {r.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Everywhere">
        <option value="global">Global only</option>
        <option value="all">All repositories</option>
      </optgroup>
      {typeof scope !== 'string' && !withMemory.has(scope.repoId) && !repos.some((r) => r.id === scope.repoId) && <option value={value}>{repoNames[scope.repoId] ?? 'Removed repository'}</option>}
    </select>
  )
}

function RunPicker({ runId, title, runs, onChange }: { runId: Id | null; title: string | null; runs: { runId: Id; title: string; at: string }[]; onChange: (id: Id | null) => void }): React.JSX.Element | null {
  if (!runs.length && !runId) return null
  return (
    <select className="input input--sm mview__select mview__select--run" value={runId ?? ''} aria-label="Run filter" title="Highlight what one run wrote" onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Any run</option>
      {runId && !runs.some((r) => r.runId === runId) && <option value={runId}>{title ?? 'This run'}</option>}
      {runs.map((r) => (
        <option key={r.runId} value={r.runId}>
          {r.title.length > 48 ? `${r.title.slice(0, 48)}…` : r.title}
        </option>
      ))}
    </select>
  )
}

function SearchBox({ inputRef, scope, onPick }: { inputRef: React.RefObject<HTMLInputElement | null>; scope: MemoryScopeFilter['scope']; onPick: (e: MemoryEntity) => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null)
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    const query = q.trim()
    if (!query) return setHits(null)
    const my = ++seq.current
    const t = setTimeout(() => {
      hive.memory.search({ scope, query, limit: 12, includeHistory: false }).then(
        (h) => {
          if (my !== seq.current) return
          setHits(h)
          setSel(0)
        },
        (e) => my === seq.current && (setHits([]), toast(errorMessage(e), 'error'))
      )
    }, 150)
    return () => clearTimeout(t)
  }, [q, scope])
  const choose = (h: MemorySearchHit | undefined): void => {
    if (!h) return
    onPick(h.entity)
    setOpen(false)
    inputRef.current?.blur()
  }
  return (
    <div className="msearch">
      <Icon name="search" size={13} className="msearch__icon" />
      <input
        ref={inputRef}
        className="input input--sm msearch__input"
        placeholder="Search memory"
        value={q}
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min((hits?.length ?? 1) - 1, s + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(0, s - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(hits?.[sel])
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            if (q) setQ('')
            else inputRef.current?.blur()
          }
        }}
      />
      {!q && <Kbd>⌘F</Kbd>}
      {open && q.trim() && hits && (
        <div className="msearch__results popover" role="listbox">
          {hits.length === 0 ? (
            <div className="msearch__none text-tertiary">Nothing about “{q.trim()}”. Try other keywords or a name.</div>
          ) : (
            hits.map((h, i) => (
              <div
                key={h.entity.id}
                role="option"
                aria-selected={i === sel}
                className={`msearch__hit ${i === sel ? 'is-sel' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setSel(i)}
                onClick={() => choose(h)}
                title={`Why it ranked: ${whyText(h.why)} = ${h.score.toFixed(2)}`}
              >
                <div className="msearch__hit-head">
                  <span className="mnode__dot" style={{ ['--mnode-hue' as string]: entityHue(h.entity.type) }} />
                  <span className="msearch__name">{h.entity.name}</span>
                  <span className="text-tertiary">{h.entity.type}</span>
                  <span className="flex1" />
                  <span className="msearch__score mono">{h.why.exact ? 'name' : h.score.toFixed(2)}</span>
                </div>
                {h.facts[0] && <div className="msearch__fact">{h.facts[0].text}</div>}
                <div className="msearch__why">{whyText(h.why)}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ---------- filter rail ----------
function FilterRail({ filters, onChange, graph, factCount, overlay, onClose }: { filters: Filters; onChange: (f: Filters) => void; graph: Graph | null; factCount: number | null; overlay: boolean; onClose: () => void }): React.JSX.Element {
  const set = (p: Partial<Filters>): void => onChange({ ...filters, ...p })
  const kindOn = (k: MemoryFactKind): boolean => filters.kinds.length === 0 || filters.kinds.includes(k)
  const toggleKind = (k: MemoryFactKind): void => {
    const cur = filters.kinds.length === 0 ? [...MEMORY_FACT_KINDS] : filters.kinds
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
    set({ kinds: next.length === MEMORY_FACT_KINDS.length ? [] : next })
  }
  return (
    <aside className={`mrail ${overlay ? 'mrail--overlay' : ''}`} aria-label="Filters">
      {overlay && (
        <div className="mrail__group" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <div className="mrail__title">Filters</div>
          <span className="flex1" />
          <IconButton icon="close" label="Close filters" onClick={onClose} />
        </div>
      )}
      <div className="mrail__group">
        <div className="mrail__title">Kind</div>
        {MEMORY_FACT_KINDS.map((k) => (
          <label key={k} className="checkbox mrail__row">
            <input type="checkbox" checked={kindOn(k)} onChange={() => toggleKind(k)} /> <span className={`mnode__kind mnode__kind--${k}`}>{KIND_GLYPH[k]}</span> {k}
          </label>
        ))}
        {filters.kinds.length > 0 && <div className="mrail__hint">The graph hides entities with no memories of the checked kinds.</div>}
      </div>
      <div className="mrail__group">
        <div className="mrail__title">Written by</div>
        <select className="input input--sm" value={filters.author} onChange={(e) => set({ author: e.target.value as Author })} aria-label="Written by">
          {AUTHORS.map((a) => (
            <option key={a} value={a}>
              {a === 'all' ? 'Anyone' : a === 'user' ? 'You' : adapterName(a)}
            </option>
          ))}
        </select>
      </div>
      <div className="mrail__group">
        <div className="mrail__title">Changed</div>
        <select className="input input--sm" value={filters.window} onChange={(e) => set({ window: e.target.value as TimeWindow })} aria-label="Changed">
          {(Object.keys(TIME_WINDOW_LABEL) as TimeWindow[]).map((w) => (
            <option key={w} value={w}>
              {TIME_WINDOW_LABEL[w]}
            </option>
          ))}
        </select>
      </div>
      <div className="mrail__group">
        <div className="mrail__title">Show</div>
        <label className="checkbox mrail__row" title="Agent-written memories you haven’t approved or edited">
          <input type="checkbox" checked={filters.unreviewedOnly} onChange={(e) => set({ unreviewedOnly: e.target.checked })} /> Unreviewed only
        </label>
        <label className="checkbox mrail__row" title="Include invalidated and superseded memories">
          <input type="checkbox" checked={filters.history} onChange={(e) => set({ history: e.target.checked })} /> History
        </label>
      </div>
      <span className="flex1" />
      {!sameFilters(filters, NO_FILTERS) && (
        <Button size="sm" variant="ghost" onClick={() => onChange(NO_FILTERS)}>
          Clear Filters
        </Button>
      )}
      <div className="mrail__stats text-tertiary">
        {graph && (
          <div>
            {graph.total} entit{graph.total === 1 ? 'y' : 'ies'} · {graph.relations.length} relation{graph.relations.length === 1 ? '' : 's'}
          </div>
        )}
        {factCount !== null && (
          <div>
            {factCount} memor{factCount === 1 ? 'y' : 'ies'}
          </div>
        )}
      </div>
    </aside>
  )
}

/** Bottom-left overlay: entity types (click to isolate) and what the marks mean. */
function GraphLegend({ types, isolated, onToggle, onReset }: { types: { type: string; count: number }[]; isolated: string[]; onToggle: (t: string) => void; onReset: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(() => loadJson<boolean>('hive.memory.legend', true))
  useEffect(() => saveJson('hive.memory.legend', open), [open])
  if (!open) {
    return (
      <div className="mlegend-box">
        <button type="button" className="mlegend-box__toggle" onClick={() => setOpen(true)}>
          Legend
        </button>
      </div>
    )
  }
  return (
    <div className="mlegend-box" aria-label="Legend">
      <div className="mlegend-box__row">
        <span className="mlegend-box__title">Types</span>
        {types.map((t) => {
          const on = isolated.includes(t.type)
          return (
            <button
              key={t.type}
              type="button"
              className={`mtype-chip ${on ? 'is-on' : isolated.length ? 'is-off' : ''}`}
              aria-pressed={on}
              title={on ? `Show every type again (${t.type} is isolated)` : `Show only ${t.type}`}
              onClick={() => onToggle(t.type)}
            >
              <span className="mnode__dot" style={{ ['--mnode-hue' as string]: entityHue(t.type) }} />
              {t.type} <span className="mtype-chip__n">{t.count}</span>
            </button>
          )
        })}
        {isolated.length > 0 && (
          <button type="button" className="link-btn" onClick={onReset}>
            All types
          </button>
        )}
        <button type="button" className="mlegend-box__toggle" onClick={() => setOpen(false)} aria-label="Hide legend">
          Hide
        </button>
      </div>
      <div className="mlegend-box__row">
        {(['gotcha', 'decision', 'convention'] as const).map((k) => (
          <span key={k} className="mlegend-key">
            <span className={`mnode__kind mnode__kind--${k}`}>{KIND_GLYPH[k]}</span> {KIND_SINGULAR[k]}
          </span>
        ))}
        <span className="mlegend-key">
          <span className="mlegend-key__new" /> changed this week
        </span>
        <span className="mlegend-key">⚠ to review</span>
        <span className="mlegend-key">⌖ pinned</span>
        <span className="mlegend-key">┄ same name</span>
      </div>
    </div>
  )
}

function FilteredEmpty({ filtered, scope, repoNames, onClear, onAdd }: { filtered: boolean; scope: MemoryPageScope; repoNames: Record<string, string>; onClear: () => void; onAdd: () => void }): React.JSX.Element {
  if (filtered) {
    return (
      <EmptyState icon="search" text="Nothing matches these filters.">
        <Button onClick={onClear}>Clear Filters</Button>
      </EmptyState>
    )
  }
  const where = typeof scope === 'string' ? (scope === 'global' ? 'global memory' : 'any repository') : repoNames[scope.repoId] ?? 'this repository'
  return (
    <EmptyState icon="memory" text={`Agents haven’t written anything about ${where} yet. Turn memory on (Read & write) for a workflow step that works here, or add a memory yourself.`}>
      <Button variant="primary" icon="plus" onClick={onAdd}>
        Add Memory
      </Button>
      <Button onClick={() => void navigate({ name: 'workflows' })}>Open Workflows</Button>
    </EmptyState>
  )
}

// ---------- + Add memory (user-authored) ----------
function AddMemorySheet({ scope, repoNames, candidates, onClose }: { scope: MemoryPageScope; repoNames: Record<string, string>; candidates: MemoryEntity[]; onClose: (entityId: Id | null) => void }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const [where, setWhere] = useState<string>(typeof scope === 'string' ? (scope === 'all' && repos[0] ? repos[0].id : 'global') : scope.repoId)
  const [pick, setPick] = useState<EntityPick | null>(null)
  const [type, setType] = useState('concept')
  const [kind, setKind] = useState<MemoryFactKind>('convention')
  const [text, setText] = useState('')
  const [pinned, setPinned] = useState(false)
  const [busy, setBusy] = useState(false)
  const repoId = where === 'global' ? null : where
  const valid = !!pick && text.trim().length >= 3
  const save = async (): Promise<void> => {
    if (!valid || busy || !pick) return
    setBusy(true)
    let entityId: Id | undefined
    if ('entity' in pick) entityId = pick.entity.id
    else entityId = (await mutate({ op: 'create', target: 'entity', input: { repoId, name: pick.newName, type } }, 'Create entity'))?.entity?.id
    const ok = entityId ? await mutate({ op: 'create', target: 'fact', input: { entityId, text: text.trim(), kind, scope: repoId ? 'project' : 'global', repoId, pinned } }, 'Add memory') : undefined
    setBusy(false)
    if (ok && entityId) {
      toast('Memory added')
      onClose(entityId)
    }
  }
  const pickerScope: MemoryScopeFilter['scope'] = repoId ? { repoId } : 'global'
  return (
    <Sheet title="Add memory" onCancel={() => onClose(null)} onPrimary={() => void save()} primaryLabel="Add" primaryDisabled={!valid || busy}>
      <p className="sheet__desc text-secondary">Write down something every agent should know. Agents read memory as reference notes, never as instructions.</p>
      <Field label="Shown to" hint={repoId ? `Agents working in ${repoNames[repoId] ?? 'that repository'}.` : 'Agents in every repository and in Chat.'}>
        <select className="input input--auto" value={where} onChange={(e) => {
          setWhere(e.target.value)
          setPick(null)
        }}>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
          <option value="global">Every repository (global)</option>
        </select>
      </Field>
      <Field label="About" hint="A component, file, API, library, person or topic. Pick one or create it.">
        <EntityPicker key={where} candidates={candidates.filter((c) => c.repoId === repoId || c.repoId === null)} scope={pickerScope} allowNew onPick={setPick} autoFocus />
      </Field>
      {pick && 'newName' in pick && (
        <Field label="Type">
          <select className="input input--auto" value={type} onChange={(e) => setType(e.target.value)}>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Kind">
        <Segmented<MemoryFactKind> size="sm" items={MEMORY_FACT_KINDS.map((k) => ({ value: k, label: k }))} value={kind} onChange={setKind} />
      </Field>
      <Field label="Memory" align="start">
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={3} maxRows={10} maxLength={1000} placeholder="Run npm run rebuild:native after changing Electron versions." />
      </Field>
      <Field label="">
        <label className="checkbox">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin: always include it in the agents’ brief
        </label>
      </Field>
    </Sheet>
  )
}

// ---------- "What agents know": a preview of the injected brief ----------
/**
 * Mirrors search.ts buildBrief: pinned memories always go in (1,500-char budget), and for a given task the most
 * relevant active memories are added (up to 8, same ranking as memory_search; the real brief then adds the top project
 * notes by importance). Without a task, it lists the key
 * gotchas, decisions and conventions agents can find, so "what do agents know?" has a direct answer.
 */
function BriefSheet({ scope, repoNames, onPickEntity, onClose }: { scope: MemoryPageScope; repoNames: Record<string, string>; onPickEntity: (id: Id) => void; onClose: () => void }): React.JSX.Element {
  const scopeArg: MemoryScopeFilter['scope'] = scope
  const [facts, setFacts] = useState<MemoryFact[] | null>(null)
  const [task, setTask] = useState('')
  const [relevant, setRelevant] = useState<MemoryFact[] | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    let live = true
    hive.memory.facts({ scope: scopeArg, statuses: ['active'], limit: 1000 }).then(
      (r) => live && setFacts(r.items),
      () => live && setFacts([])
    )
    return () => {
      live = false
    }
  }, [scopeKey(scope)])
  useEffect(() => {
    const q = task.trim()
    if (!q) return setRelevant(null)
    const my = ++seq.current
    const t = setTimeout(() => {
      hive.memory.search({ scope: scopeArg, query: q.slice(0, 300), limit: 20 }).then(
        (hits) => {
          if (my !== seq.current) return
          const out: MemoryFact[] = []
          for (const h of hits) for (const f of h.facts) if (f.status === 'active' && !f.pinned && out.length < 8) out.push(f)
          setRelevant(out)
        },
        () => my === seq.current && setRelevant([])
      )
    }, 200)
    return () => clearTimeout(t)
  }, [task, scopeKey(scope)])

  const where = typeof scope === 'string' ? (scope === 'global' ? 'global memory' : 'all repositories') : (repoNames[scope.repoId] ?? 'this repository')
  const pinned = facts ? briefPinned(facts) : null
  const key = facts ? keyKnowledge(facts) : []
  const Item = ({ f, over }: { f: MemoryFact; over?: boolean }): React.JSX.Element => (
    <li className="mbrief__item">
      <span className={`mcard__kind mnode__kind--${f.kind}`} title={KIND_SINGULAR[f.kind]}>
        {KIND_GLYPH[f.kind]}
      </span>
      <span className={over ? 'mbrief__over' : ''}>
        <button type="button" className="mbrief__entity" onClick={() => onPickEntity(f.entityId)}>
          {f.entityName}
        </button>
        <span className="mbrief__text">: {f.text}</span>
        {f.scope === 'global' && typeof scope !== 'string' && <span className="text-tertiary"> (global)</span>}
      </span>
    </li>
  )
  return (
    <Sheet title={`What agents know about ${where}`} onCancel={onClose} onPrimary={onClose} primaryLabel="Done">
      {!facts || !pinned ? (
        <Loading />
      ) : (
        <div className="mbrief">
          {scope === 'all' && <div className="mbrief__note">Agents get the brief of the repository they work in. Pick a repository in the header to see exactly what its agents get.</div>}
          <section className="mbrief__section">
            <div className="mbrief__label">Always in the brief · pinned</div>
            {pinned.included.length === 0 ? (
              <div className="mbrief__note">Nothing is pinned. Pin a memory (⌖ in the inspector) to put it in front of every agent here.</div>
            ) : (
              <ul className="mbrief__list">
                {pinned.included.map((f) => (
                  <Item key={f.id} f={f} />
                ))}
                {pinned.overflow.map((f) => (
                  <Item key={f.id} f={f} over />
                ))}
              </ul>
            )}
            {pinned.overflow.length > 0 && <div className="mbrief__note">Struck-through pins don’t fit the brief’s 1,500-character pinned budget (newest first). Agents can still find them with memory_search.</div>}
          </section>
          <section className="mbrief__section">
            <div className="mbrief__label">Added for a task · most relevant</div>
            <div className="mbrief__task">
              <input className="input input--sm" placeholder="Try a task, e.g. “fix the flaky login test”" value={task} onChange={(e) => setTask(e.target.value)} spellCheck={false} autoFocus />
            </div>
            {relevant === null ? (
              <div className="mbrief__note">Each step or session also gets up to 8 memories matching its prompt, then the most important project notes that still fit. Type a task to see which match.</div>
            ) : relevant.length === 0 ? (
              <div className="mbrief__note">Nothing matches that task by keyword: agents get the pinned memories and the most important project notes, and are told to search memory before assuming it has nothing.</div>
            ) : (
              <ul className="mbrief__list">
                {relevant.map((f) => (
                  <Item key={f.id} f={f} />
                ))}
              </ul>
            )}
          </section>
          <section className="mbrief__section">
            <div className="mbrief__label">What agents can look up</div>
            {key.length === 0 ? (
              <div className="mbrief__note">No gotchas, decisions or conventions yet. {facts.length ? `${facts.length} plain fact${facts.length === 1 ? '' : 's'} so far.` : ''}</div>
            ) : (
              key.map((g) => (
                <div key={g.kind}>
                  <div className="mbrief__note">
                    {KIND_LABEL[g.kind]} · {g.total}
                  </div>
                  <ul className="mbrief__list">
                    {g.facts.map((f) => (
                      <Item key={f.id} f={f} />
                    ))}
                  </ul>
                </div>
              ))
            )}
            <div className="mbrief__note">Agents with memory tools find these with memory_search and memory_get; agents without them get the brief only.</div>
          </section>
        </div>
      )}
    </Sheet>
  )
}
