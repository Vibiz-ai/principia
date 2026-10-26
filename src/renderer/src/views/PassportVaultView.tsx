/**
 * The Passport (PASSPORT.md §10): one company's Obsidian-style vault. Three modes:
 * - Notes: vault tree, tags, ghosts, Recent and Orphans | reading mode or source editor (⌘E) with `[[` completion
 *   and a three-way merge | properties, backlinks and unlinked mentions, outgoing links, local graph, History.
 * - Graph: every note as a live d3-force canvas with Obsidian's filters, groups, display and forces.
 * - Inbox: suggestions and decisions with diff previews.
 * Always one company: the focused one, a chooser in All mode, Personal for a Personal-only user. While the vault is
 * off (`experimental.vault`), the Passport channels answer not_implemented and the v1 Memory page stands in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Id } from '@shared/types'
import { PERSONAL_COMPANY_ID } from '@shared/company'
import type { VaultGhost, VaultMigrationReport, VaultNoteText, VaultOp, VaultStatus, VaultTagCount } from '@shared/passport'
import { NOTE_TYPES } from '@shared/vault/grammar'
import { CompanyChooser, useScope } from '../components/CompanyChip'
import { Icon } from '../components/Icon'
import { Button, ErrorState, Field, IconButton, Loading, Segmented, Sheet, Toolbar } from '../components/ui'
import { NoteTree, type TreeFilter } from '../components/passport/NoteTree'
import { NoteReader } from '../components/passport/NoteReader'
import { NoteEditor } from '../components/passport/NoteEditor'
import { PropertiesPanel } from '../components/passport/PropertiesPanel'
import { BacklinksPanel } from '../components/passport/BacklinksPanel'
import { LocalGraph } from '../components/passport/LocalGraph'
import { GlobalGraph } from '../components/passport/GlobalGraph'
import { ConflictBanner } from '../components/passport/ConflictBanner'
import { MergeView } from '../components/passport/MergeView'
import { Inbox } from '../components/passport/Inbox'
import { useMemoryGrants } from '../components/memory/MemoryChips'
import { companyLabel } from '../lib/company'
import { liveAction, makeResolver, saveLanding, type TreeNote } from '../lib/passport'
import { errorCode, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { v1EntityToNoteId } from '@shared/vault/ids'
import { enterCompany, loadJson, navigate, saveJson, setState, toast, useStore, type PassportMode, type ViewState } from '../state/store'
import { LegacyMemoryPage, takeMemoryHandoff } from './MemoryView'
import '../styles/passport.css'

type PassportViewState = Extract<ViewState, { name: 'passport' }>

/** Below this window width the vault tree folds into a toggle (like the Memory page's rail). */
const TREE_MIN_WIDTH = 1200

export function PassportVaultView({ view }: { view: PassportViewState }): React.JSX.Element {
  const { active, multi } = useScope()
  const companyId = active === 'all' ? (multi ? null : PERSONAL_COMPANY_ID) : active
  // vault off (settings loaded, flag not set): the v1 Memory page is per repo, not per company, so it opens as it
  // always did instead of asking for a company first
  const vaultOff = useStore((s) => !!s.settings && s.settings.experimental?.vault !== true)
  if (vaultOff && !companyId) {
    const h = takeMemoryHandoff(view.nonce)
    return <LegacyMemoryPage view={{ name: 'memory', runId: view.runId, sessionId: view.sessionId, search: view.search !== undefined, nonce: view.nonce, scope: h?.scope, entityId: h?.entityId }} />
  }
  if (!companyId) {
    return (
      <div className="view">
        <Toolbar title="Knowledge" />
        <div className="scroll view__body">
          <CompanyChooser
            title="Pick a company"
            text="Knowledge is one company’s memory: its notes, people, decisions and the links between them. Open a company to read or edit what its agents know."
            onPick={(id) => void enterCompany(id, { view: { ...view, nonce: Date.now() } })}
          />
        </div>
      </div>
    )
  }
  return <CompanyPassport key={companyId} companyId={companyId} view={view} />
}

/** A note to open: by id or path, optionally at a line, block or heading (n re-applies the same target). */
interface OpenTarget {
  id?: string
  path?: string
  line?: number | null
  block?: string | null
  heading?: string | null
  n: number
}

interface ChangeInfo {
  key: number
  paths: Set<string> | null
  noteIds: Set<string> | null
  runIds: Id[]
}

function CompanyPassport({ companyId, view }: { companyId: Id; view: PassportViewState }): React.JSX.Element {
  const { companies } = useScope()
  const company = companies.find((c) => c.id === companyId) ?? null
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [mode, setModeState] = useState<PassportMode>(() => view.mode ?? loadJson<PassportMode>('hive.passport.mode', 'notes'))
  const [tree, setTree] = useState<TreeNote[] | null>(null)
  /** the tree list failed after the status loaded: without this the tree would spin forever */
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRetry, setTreeRetry] = useState(0)
  const [tags, setTags] = useState<VaultTagCount[]>([])
  const [ghosts, setGhosts] = useState<VaultGhost[]>([])
  const [change, setChange] = useState<ChangeInfo>({ key: 0, paths: null, noteIds: null, runIds: [] })
  const [target, setTarget] = useState<OpenTarget | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState(view.search ?? '')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [filter, setFilter] = useState<TreeFilter | null>(null)
  const [runId, setRunId] = useState<Id | null>(view.runId ?? null)
  const [sessionId, setSessionId] = useState<Id | null>(view.sessionId ?? null)
  const [needsDecision, setNeedsDecision] = useState<number | null>(null)
  const [creating, setCreating] = useState<{ title: string; type: string } | null>(null)
  const [narrow, setNarrow] = useState(() => window.innerWidth < TREE_MIN_WIDTH)
  const [treeOpen, setTreeOpen] = useState(false)
  const [localFocus, setLocalFocus] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const handoff = useRef<{ nonce: number | undefined; h: ReturnType<typeof takeMemoryHandoff> } | null>(null)
  if (!handoff.current || handoff.current.nonce !== view.nonce) handoff.current = { nonce: view.nonce, h: takeMemoryHandoff(view.nonce) }

  const setMode = useCallback((m: PassportMode) => {
    setModeState(m)
    saveJson('hive.passport.mode', m)
  }, [])

  // ---- vault status (and the flag-off fallback); flipping Settings → Experimental → Passport vault re-checks ----
  const vaultFlag = useStore((s) => !!s.settings?.experimental?.vault)
  useEffect(() => {
    setLegacy(false)
    setStatus(null)
  }, [vaultFlag])
  const loadStatus = useCallback(() => {
    hive.memory.vault({ op: 'status', companyId }).then(
      (s) => {
        setStatus(s)
        setStatusError(null)
      },
      (e) => {
        if (errorCode(e) === 'not_implemented') setLegacy(true)
        else setStatusError(errorMessage(e))
      }
    )
  }, [companyId, vaultFlag])
  useEffect(loadStatus, [loadStatus])

  // ---- vault lists: tree, tags, ghosts ----
  useEffect(() => {
    if (!status) return
    let live = true
    Promise.all([
      hive.memory.links({ op: 'tree', companyId }),
      hive.memory.links({ op: 'tags', companyId }).catch(() => [] as VaultTagCount[]),
      hive.memory.links({ op: 'ghosts', companyId, limit: 500 }).catch(() => [] as VaultGhost[])
    ]).then(
      ([t, tg, g]) => {
        if (!live) return
        setTree(t)
        setTags(tg)
        setGhosts(g)
        setTreeError(null)
      },
      (e) => live && setTreeError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [companyId, status?.state, change.key, treeRetry])

  // ---- live updates: agent writes and Obsidian edits arrive as memory:changed (debounced) ----
  const pending = useRef<{ paths: Set<string> | null; noteIds: Set<string> | null; runIds: Set<Id> } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useHiveEvent('memory:changed', (e) => {
    if (e.companyId && e.companyId !== companyId) return
    const p = (pending.current ??= { paths: new Set(), noteIds: new Set(), runIds: new Set() })
    // an event without paths may have touched anything
    if (!e.paths?.length && !e.noteIds?.length) {
      p.paths = null
      p.noteIds = null
    } else {
      for (const x of e.paths ?? []) p.paths?.add(x)
      for (const x of e.noteIds ?? []) p.noteIds?.add(x)
    }
    for (const r of e.runIds ?? []) p.runIds.add(r)
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const c = pending.current
      pending.current = null
      if (c) setChange((prev) => ({ key: prev.key + 1, paths: c.paths, noteIds: c.noteIds, runIds: [...c.runIds] }))
      if (status && status.state !== 'ready' && status.state !== 'readonly') loadStatus()
    }, 250)
  })
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < TREE_MIN_WIDTH)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ---- deep links re-apply on every navigation ----
  useEffect(() => {
    if (view.mode) setMode(view.mode)
    setRunId(view.runId ?? null)
    setSessionId(view.sessionId ?? null)
    if (view.notePath) setTarget({ path: view.notePath, n: Date.now() })
    const entity = handoff.current?.h?.entityId
    const fromEntity = entity ? v1EntityToNoteId(entity) : null
    if (fromEntity) {
      setMode('notes')
      setTarget({ id: fromEntity, n: Date.now() })
    }
    if (view.search !== undefined) {
      setMode('notes')
      setSearch(view.search)
      setTimeout(() => searchRef.current?.focus(), 60)
    }
  }, [view.nonce])

  // first open: the last note of this company, else the hub note
  useEffect(() => {
    if (!tree || target || view.notePath) return
    const last = loadJson<string | null>(`hive.passport.last.${companyId}`, null)
    const pick = (last && tree.find((t) => t.id === last)) || tree.find((t) => t.type === 'company') || tree[0]
    if (pick) setTarget({ id: pick.id, n: 0 })
  }, [tree])
  useEffect(() => {
    if (selectedId) saveJson(`hive.passport.last.${companyId}`, selectedId)
  }, [selectedId, companyId])

  // ---- search and tag filters: FTS through the graph query (titles, aliases and bodies) ----
  useEffect(() => {
    const q = search.trim()
    if (!q && !tagFilter) return setFilter(null)
    const label = tagFilter ? `#${tagFilter}` : `“${q}”`
    setFilter((f) => (f?.label === label ? f : { label, ids: null }))
    let live = true
    const t = setTimeout(() => {
      hive.memory
        .graph({ op: 'global', companyId, filters: { search: q || undefined, tags: tagFilter ? [tagFilter] : undefined, existingOnly: true, orphans: true } })
        .then(
          (g) => {
            if (!live) return
            const ids = new Set(g.nodes.filter((n) => !n[4]).map((n) => n[0]))
            const lq = q.toLowerCase()
            if (q) for (const n of tree ?? []) if (n.title.toLowerCase().includes(lq)) ids.add(n.id)
            setFilter({ label, ids })
          },
          () => live && setFilter({ label, ids: new Set((tree ?? []).filter((n) => n.title.toLowerCase().includes(q.toLowerCase())).map((n) => n.id)) })
        )
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [search, tagFilter, companyId, change.key])

  // ---- actions ----
  const readOnly = status?.state === 'readonly'
  const openNote = useCallback(
    (id: string, opts: { line?: number | null; block?: string | null; heading?: string | null } = {}) => {
      setMode('notes')
      setTarget({ id, ...opts, n: Date.now() })
      if (narrow) setTreeOpen(false)
    },
    [narrow, setMode]
  )
  const createNote = useCallback(
    async (title: string, type?: string | null) => {
      if (readOnly) return toast(status?.readOnlyReason ?? 'This vault is read-only right now', 'error')
      try {
        const s = await hive.memory.note({ op: 'create', companyId, title, type: type ?? undefined, fromGhost: true })
        setChange((c) => ({ ...c, key: c.key + 1, paths: null, noteIds: null }))
        openNote(s.id)
      } catch (e) {
        toast(`Couldn’t create “${title}”: ${errorMessage(e)}`, 'error')
      }
    },
    [companyId, openNote, readOnly, status?.readOnlyReason]
  )
  const applyOps = useCallback(
    async (ops: VaultOp[]): Promise<boolean> => {
      if (readOnly) {
        toast(status?.readOnlyReason ?? 'This vault is read-only right now', 'error')
        return false
      }
      try {
        const r = await hive.memory.note({ op: 'ops', companyId, ops })
        const bad = r.results.find((x) => x.status === 'error' || x.status === 'conflict')
        if (bad) {
          toast(bad.reason ?? 'The change could not be applied; the note changed. Try again.', 'error')
          return false
        }
        return true
      } catch (e) {
        toast(errorMessage(e), 'error')
        return false
      }
    },
    [companyId, readOnly, status?.readOnlyReason]
  )
  const pathOf = useCallback((id: string | null) => (id ? tree?.find((t) => t.id === id)?.path : undefined), [tree])
  const openInObsidian = useCallback(
    async (noteId?: string | null) => {
      try {
        const r = await hive.memory.vault({ op: 'openInObsidian', companyId, path: pathOf(noteId ?? null) })
        if (r.hint && !loadJson<boolean>('hive.passport.obsidianHint', false)) {
          saveJson('hive.passport.obsidianHint', true)
          toast(r.hint)
        }
      } catch (e) {
        toast(`Couldn’t open Obsidian: ${errorMessage(e)}`, 'error')
      }
    },
    [companyId, pathOf]
  )
  const reveal = useCallback(
    (noteId?: string | null) => void hive.memory.vault({ op: 'reveal', companyId, path: pathOf(noteId ?? null) }).catch((e) => toast(errorMessage(e), 'error')),
    [companyId, pathOf]
  )
  const reindex = async (): Promise<void> => {
    try {
      setStatus(await hive.memory.vault({ op: 'reindex', companyId }))
      setChange((c) => ({ ...c, key: c.key + 1, paths: null, noteIds: null }))
      toast('Vault reindexed')
    } catch (e) {
      toast(`Couldn’t reindex: ${errorMessage(e)}`, 'error')
    }
  }
  const archive = async (noteId: string): Promise<void> => {
    try {
      await hive.memory.note({ op: 'archive', companyId, id: noteId })
      setChange((c) => ({ ...c, key: c.key + 1, paths: null, noteIds: null }))
      toast('Note archived. Its file stays in the vault with status: archived.')
    } catch (e) {
      toast(`Couldn’t archive: ${errorMessage(e)}`, 'error')
    }
  }
  const moreMenu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'reindex', label: 'Reindex Vault' },
      { id: 'folder', label: 'Use Existing Folder…', enabled: !readOnly },
      ...(status?.customPath ? [{ id: 'default', label: 'Back to the Default Folder' }] : []),
      { type: 'separator' as const },
      { id: 'settings', label: 'Company Settings…' }
    ])
    if (id === 'reindex') void reindex()
    if (id === 'folder' || id === 'default') {
      try {
        const s = await hive.memory.vault(id === 'folder' ? { op: 'setPath', companyId, pick: true } : { op: 'setPath', companyId, path: null })
        if (s) {
          setStatus(s)
          setTarget(null)
          setChange((c) => ({ ...c, key: c.key + 1, paths: null, noteIds: null }))
        }
      } catch (e) {
        toast(errorMessage(e), 'error')
      }
    }
    if (id === 'settings') void navigate({ name: 'company', companyId })
  }

  // ⌘F focuses the vault search in Notes mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.code === 'KeyF' && mode === 'notes') {
        e.preventDefault()
        if (narrow) setTreeOpen(true)
        setTimeout(() => searchRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, narrow])

  const pathById = useMemo(() => new Map((tree ?? []).map((t) => [t.id, t.path])), [tree])

  // ---- render ----
  if (legacy) {
    const h = handoff.current?.h
    return <LegacyMemoryPage view={{ name: 'memory', runId: view.runId, sessionId: view.sessionId, search: view.search !== undefined, nonce: view.nonce, scope: h?.scope, entityId: h?.entityId }} />
  }
  const title = (
    <span className="pview__title">
      Knowledge
      {company && <span className="pview__company">{companyLabel(company)}</span>}
    </span>
  )
  if (statusError && !status) {
    return (
      <div className="view">
        <Toolbar title={title} />
        <ErrorState error={`Couldn’t open the Passport: ${statusError}`} onRetry={loadStatus} />
      </div>
    )
  }
  if (!status) {
    return (
      <div className="view">
        <Toolbar title={title} />
        <Loading label="Opening the vault…" />
      </div>
    )
  }

  const showTree = !narrow || treeOpen
  return (
    <div className={`view pview pview--${mode}`}>
      <Toolbar
        title={title}
        left={narrow && mode === 'notes' ? <IconButton icon="sidebar" label="Show the vault tree" className={treeOpen ? 'is-on' : ''} onClick={() => setTreeOpen(!treeOpen)} /> : undefined}
        sub={
          <Segmented<PassportMode>
            className="pview__modes no-drag"
            size="sm"
            value={mode}
            onChange={setMode}
            items={[
              { value: 'notes', label: 'Notes' },
              { value: 'graph', label: 'Graph' },
              {
                value: 'inbox',
                label: (
                  <span>
                    Inbox
                    {(needsDecision ?? status.needsDecision) > 0 && <span className="pview__badge">{needsDecision ?? status.needsDecision}</span>}
                    {(needsDecision ?? status.needsDecision) === 0 && status.pendingSuggestions > 0 && <span className="pview__badge pview__badge--quiet">{status.pendingSuggestions}</span>}
                  </span>
                ),
                title: 'Suggestions and decisions. The badge counts only what needs a decision.'
              }
            ]}
          />
        }
      >
        <IconButton icon="plus" label="New note" disabled={readOnly} onClick={() => setCreating({ title: '', type: 'note' })} />
        <IconButton icon="external" label="Open in Obsidian" onClick={() => void openInObsidian(mode === 'notes' ? selectedId : null)} />
        <IconButton icon="folder" label="Reveal in Finder" onClick={() => reveal(mode === 'notes' ? selectedId : null)} />
        <IconButton icon="more" label="More" onClick={() => void moreMenu()} />
      </Toolbar>

      <VaultBanners status={status} />
      <MigrationBanner />
      {(runId || sessionId) && <RunBanner runId={runId} sessionId={sessionId} onClear={() => setState({ view: { ...view, runId: undefined, sessionId: undefined, nonce: Date.now() } })} />}

      <div className="pview__body">
        {mode === 'notes' && (
          <>
            {showTree && (
              <div className={`pview__left ${narrow ? 'is-overlay' : ''}`}>
                {tree ? (
                  <NoteTree
                    companyId={companyId}
                    tree={tree}
                    tags={tags}
                    ghosts={ghosts}
                    selectedId={selectedId}
                    search={search}
                    onSearch={(s) => {
                      setSearch(s)
                      if (s) setTagFilter(null)
                    }}
                    searchRef={searchRef}
                    filter={filter}
                    onClearFilter={() => {
                      setSearch('')
                      setTagFilter(null)
                    }}
                    onTag={(t) => {
                      setSearch('')
                      setTagFilter(t)
                    }}
                    onOpen={(id) => openNote(id)}
                    onCreateGhost={(g) => void createNote(g.text, g.guessedType)}
                    onNewNote={() => setCreating({ title: '', type: 'note' })}
                    onOpenInObsidian={() => void openInObsidian(selectedId)}
                    onReveal={() => reveal(selectedId)}
                    onReindex={() => void reindex()}
                    readOnly={readOnly}
                  />
                ) : treeError ? (
                  <ErrorState error={`Couldn’t list the notes: ${treeError}`} onRetry={() => setTreeRetry((n) => n + 1)} />
                ) : (
                  <Loading />
                )}
              </div>
            )}
            {target ? (
              <NotePane
                companyId={companyId}
                target={target}
                tree={tree ?? []}
                tags={tags}
                ghosts={ghosts}
                change={change}
                readOnly={readOnly}
                highlightRunId={runId}
                pathById={pathById}
                localFocus={localFocus}
                initialDepth={view.depth}
                onLoaded={setSelectedId}
                onOpenNote={openNote}
                onCreateNote={(t) => void createNote(t)}
                onFilterTag={(t) => {
                  setSearch('')
                  setTagFilter(t)
                  if (narrow) setTreeOpen(true)
                }}
                onOps={applyOps}
                onGraph={() => setMode('graph')}
                onMissing={() => {
                  setTarget(null)
                  setSelectedId(null)
                }}
              />
            ) : (
              <div className="pview__center pview__center--empty">
                {!tree && treeError ? (
                  <ErrorState error={`Couldn’t list the notes: ${treeError}`} onRetry={() => setTreeRetry((n) => n + 1)} />
                ) : !tree ? (
                  <Loading />
                ) : tree.length === 0 ? (
                  <div className="pview__empty">
                    <Icon name="passport" size={28} />
                    <div className="pview__empty-title">This vault is empty</div>
                    <div className="text-secondary">Agents add notes as they learn about the company. You can write one yourself, or open the folder in Obsidian.</div>
                    <div className="pview__empty-actions">
                      <Button variant="primary" icon="plus" disabled={readOnly} onClick={() => setCreating({ title: '', type: 'note' })}>
                        New note
                      </Button>
                      <Button icon="external" onClick={() => void openInObsidian()}>
                        Open in Obsidian
                      </Button>
                    </div>
                  </div>
                ) : (
                  <span className="text-tertiary">Pick a note</span>
                )}
              </div>
            )}
          </>
        )}
        {mode === 'graph' && (
          <GlobalGraph
            companyId={companyId}
            tree={tree ?? []}
            reloadKey={change.key}
            selectedId={selectedId}
            onOpen={(id) => openNote(id)}
            onCreateGhost={(t) => void createNote(t)}
            onLocalGraph={(id) => {
              openNote(id)
              setLocalFocus((n) => n + 1)
            }}
            onOpenInObsidian={(id) => void openInObsidian(id)}
            onArchive={(id) => void archive(id)}
          />
        )}
        {mode === 'inbox' && (
          <Inbox
            companyId={companyId}
            reloadKey={change.key}
            readOnly={readOnly}
            onCounts={(c) => setNeedsDecision(c.needsDecision)}
            onOpenNote={(path, line) => {
              setMode('notes')
              setTarget({ path, line: line ?? null, n: Date.now() })
            }}
          />
        )}
      </div>

      {creating && (
        <Sheet
          title="New note"
          onCancel={() => setCreating(null)}
          primaryLabel="Create"
          primaryDisabled={!creating.title.trim()}
          onPrimary={() => {
            const c = creating
            setCreating(null)
            void createNote(c.title.trim(), c.type)
          }}
        >
          <Field label="Title">
            <input className="input" data-autofocus value={creating.title} onChange={(e) => setCreating({ ...creating, title: e.target.value })} placeholder="Ana Ruiz, Pricing v2, Onboarding…" />
          </Field>
          <Field label="Type" hint="Decides the folder. Folders are cosmetic: the type is what counts.">
            <select className="input" value={creating.type} onChange={(e) => setCreating({ ...creating, type: e.target.value })}>
              {NOTE_TYPES.filter((t) => t !== 'company').map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        </Sheet>
      )}
    </div>
  )
}

function VaultBanners({ status }: { status: VaultStatus }): React.JSX.Element | null {
  if (status.state === 'readonly')
    return <div className="pbanner pbanner--warn">Read-only: {status.readOnlyReason ?? 'another Principia instance is writing to this vault'}. Reading and searching keep working.</div>
  if (status.state === 'error') return <div className="pbanner pbanner--error">The vault has a problem: {status.error ?? 'unknown error'}.</div>
  // the folder vanished (unmounted drive, moved in Finder): nothing is treated as deleted; it comes back when the folder does
  if (status.state === 'missing')
    return <div className="pbanner pbanner--error">The Passport folder {status.root} is unavailable (unmounted or moved?). Nothing was deleted; notes come back when the folder does.</div>
  if (status.state === 'indexing' || status.state === 'seeding') return <div className="pbanner">Indexing the vault… notes appear as they are read.</div>
  if (status.onICloud) return <div className="pbanner">This vault is on iCloud Drive. Edits made in Obsidian can take a few seconds to show up here.</div>
  return null
}

const MIGRATION_SEEN_KEY = 'hive.passportMigrationSeen'
const migrationHasWork = (r: VaultMigrationReport): boolean =>
  !r.alreadyMigrated && (r.totals.entityNotes + r.totals.observations + r.totals.historyLines + r.totals.proposals > 0 || r.companies.some((c) => c.hubNote || c.repoNotes > 0))
/** Nothing from the old shared memory: only the company profiles (and repository notes) are left to write. */
const profilesOnly = (r: VaultMigrationReport): boolean => r.totals.entityNotes + r.totals.observations + r.totals.historyLines + r.totals.proposals === 0
const migrationSummary = (r: VaultMigrationReport): string =>
  `${r.totals.entityNotes} notes, ${r.totals.observations} facts, ${r.totals.historyLines} History lines and ${r.totals.proposals} items to review across ${r.companies.length} ${r.companies.length === 1 ? 'company' : 'companies'}`

/**
 * PASSPORT.md §9: the first time the vault is on, shared memory (memory.db) and the company profiles move into the
 * Passports. The dry run's report shows first; nothing is written until the user clicks; the result shows once.
 */
function MigrationBanner(): React.JSX.Element | null {
  const [seen, setSeen] = useState(() => loadJson<boolean>(MIGRATION_SEEN_KEY, false))
  const [plan, setPlan] = useState<VaultMigrationReport | null>(null)
  const [done, setDone] = useState<VaultMigrationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [later, setLater] = useState(false)
  useEffect(() => {
    if (seen) return
    let live = true
    hive.memory.vault({ op: 'migrate', dryRun: true }).then(
      (r) => {
        if (!live) return
        const report = r as VaultMigrationReport
        if (report.alreadyMigrated) {
          saveJson(MIGRATION_SEEN_KEY, true)
          setSeen(true)
        } else setPlan(report)
      },
      () => undefined // no migrator (not_implemented) or memory off: nothing to offer
    )
    return () => {
      live = false
    }
  }, [seen])
  const dismiss = (): void => {
    saveJson(MIGRATION_SEEN_KEY, true)
    setSeen(true)
  }
  if (seen) return null
  if (done)
    return (
      <div className="pbanner pbanner--run">
        <span>
          Moved into your Passports: {migrationSummary(done)}.{done.backupPath ? ' memory.db was backed up first and is never changed.' : ''}
          {done.warnings.length > 0 ? ` ${done.warnings.length} warning${done.warnings.length === 1 ? '' : 's'} in the log.` : ''}
        </span>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    )
  if (!plan || later || !migrationHasWork(plan)) return null
  const migrate = async (): Promise<void> => {
    setBusy(true)
    try {
      setDone((await hive.memory.vault({ op: 'migrate', dryRun: false })) as VaultMigrationReport)
    } catch (e) {
      toast(`Migration failed: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pbanner pbanner--warn">
      <span>{profilesOnly(plan) ? `${plan.companies.length === 1 ? 'A company profile isn’t in its Passport' : `${plan.companies.length} company profiles aren’t in their Passports`} yet. Add ${plan.companies.length === 1 ? 'it' : 'them'} as notes your agents read? Nothing is deleted.` : `Shared memory from before the Passport: ${migrationSummary(plan)}. Move it into the company Passports? memory.db is backed up and never changed.`}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void migrate()}>
        {busy ? 'Adding…' : profilesOnly(plan) ? 'Add to Passports' : 'Move into Passports'}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLater(true)}>
        Not now
      </Button>
    </div>
  )
}

/** "What this run wrote" (MemoryChips' grants): the run's lines get the accent bar in reading mode. */
function RunBanner({ runId, sessionId, onClear }: { runId: Id | null; sessionId: Id | null; onClear: () => void }): React.JSX.Element {
  const grants = useMemoryGrants(runId ? { runId } : sessionId ? { sessionId } : {})
  const wrote = grants.reduce((a, g) => a + g.wrote.facts + g.wrote.relations, 0)
  const invalidated = grants.reduce((a, g) => a + g.wrote.invalidated, 0)
  const title = grants.find((g) => g.runTitle)?.runTitle
  return (
    <div className="pbanner pbanner--run">
      <Icon name="memory" size={12} />
      <span>
        {runId ? `This run${title ? ` (${title})` : ''}` : 'This session'} wrote {wrote} line{wrote === 1 ? '' : 's'}
        {invalidated ? `, invalidated ${invalidated}` : ''}. Its lines are marked in the notes.
      </span>
      {runId && (
        <button type="button" className="link-btn" onClick={() => void navigate({ name: 'run', runId })}>
          Open run
        </button>
      )}
      <span className="flex1" />
      <IconButton icon="close" label="Stop highlighting" onClick={onClear} />
    </div>
  )
}

// ---------- the open note ----------
interface MergeState {
  base: string
  ours: string
  theirs: string
  theirsHash: string
  label: string
}

function NotePane({
  companyId,
  target,
  tree,
  tags,
  ghosts,
  change,
  readOnly,
  highlightRunId,
  pathById,
  localFocus,
  initialDepth,
  onLoaded,
  onOpenNote,
  onCreateNote,
  onFilterTag,
  onOps,
  onGraph,
  onMissing
}: {
  companyId: Id
  target: OpenTarget
  tree: TreeNote[]
  tags: VaultTagCount[]
  ghosts: VaultGhost[]
  change: ChangeInfo
  readOnly: boolean
  highlightRunId: Id | null
  pathById: ReadonlyMap<string, string>
  localFocus: number
  initialDepth?: number
  onLoaded: (id: string) => void
  onOpenNote: (id: string, opts?: { line?: number | null; block?: string | null; heading?: string | null }) => void
  onCreateNote: (title: string) => void
  onFilterTag: (tag: string) => void
  onOps: (ops: VaultOp[]) => Promise<boolean>
  onGraph: () => void
  onMissing: () => void
}): React.JSX.Element {
  const [doc, setDoc] = useState<VaultNoteText | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<{ doc: VaultNoteText; by: string } | null>(null)
  const [merge, setMerge] = useState<MergeState | null>(null)
  const [saving, setSaving] = useState(false)
  const [reveal, setReveal] = useState<{ line: number; n: number } | null>(null)
  const [retry, setRetry] = useState(0)
  const [right, setRight] = useState<Record<string, boolean>>(() => loadJson('hive.passport.right', { props: true, links: true, local: true, history: false }))
  const centre = useRef<HTMLDivElement>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  const draftRef = useRef(draft)
  draftRef.current = draft
  const savingRef = useRef(false)
  const lastChange = useRef(change.key)

  const toggleRight = (k: string): void => {
    const next = { ...right, [k]: !right[k] }
    setRight(next)
    saveJson('hive.passport.right', next)
  }
  useEffect(() => {
    if (localFocus && !right.local) toggleRight('local')
  }, [localFocus])

  const dirty = editing && draft !== null && !!doc && draft !== doc.text

  const get = useCallback(
    (ref: { id?: string; path?: string }) =>
      hive.memory.note(ref.id ? { op: 'get', companyId, id: ref.id } : { op: 'get', companyId, path: ref.path! }),
    [companyId]
  )

  // ---- save: 800 ms idle, blur, leaving the note, ⌘E ----
  const saveNow = useCallback(async (): Promise<void> => {
    const d = docRef.current
    const text = draftRef.current
    if (!d || text === null || text === d.text || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const r = await hive.memory.note({ op: 'save', companyId, path: d.detail.note.path, baseHash: d.hash, text })
      // the user may have moved to another note while this save was in flight (see saveLanding)
      const landing = saveLanding({ openNoteId: docRef.current?.detail.note.id, savedNoteId: d.detail.note.id, status: r.status })
      if (landing === 'report') toast(`Your last edit to “${d.detail.note.title}” was not saved: the note changed on disk. Open it to merge.`, 'error')
      if (landing !== 'apply') return
      if (r.status === 'saved') {
        if (r.movedToHistory > 0) {
          // removed lines with block ids went to History: the file differs from the editor now
          const fresh = await get({ id: r.detail.note.id })
          if (docRef.current?.detail.note.id !== d.detail.note.id) return
          setDoc(fresh)
          if (draftRef.current === text) setDraft(fresh.text)
          toast(`${r.movedToHistory} removed line${r.movedToHistory === 1 ? '' : 's'} moved to History (facts are never deleted)`)
        } else setDoc({ text, hash: r.hash, detail: r.detail })
        setIncoming(null)
      } else {
        setMerge({ base: r.base, ours: r.ours, theirs: r.theirs, theirsHash: r.theirsHash, label: 'the file on disk' })
      }
    } catch (e) {
      toast(`Couldn’t save: ${errorMessage(e)}`, 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [companyId, get])

  // `saving` re-arms the timer: an edit typed while another save was in flight is saved once it lands
  useEffect(() => {
    if (!dirty || merge || incoming || saving) return
    const t = setTimeout(() => void saveNow(), 800)
    return () => clearTimeout(t)
  }, [draft, dirty, merge, incoming, saving, saveNow])

  // ---- load on target change (saving the previous note first) ----
  useEffect(() => {
    let live = true
    setError(null)
    get(target).then(
      (d) => {
        if (!live) return
        setDoc(d)
        setDraft(d.text)
        setIncoming(null)
        setMerge(null)
        onLoaded(d.detail.note.id)
        // scroll to the line / block / heading asked for
        const lines = d.text.split(/\r?\n/)
        let line = target.line ?? null
        if (line === null && target.block) line = lines.findIndex((l) => l.trimEnd().endsWith(`^${target.block}`))
        if (line === null && target.heading) line = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s+/, '').trim() === target.heading)
        if (line !== null && line >= 0) {
          const at = line
          requestAnimationFrame(() => {
            const el = centre.current?.querySelector<HTMLElement>(`[data-line="${at}"]`)
            if (el) {
              el.scrollIntoView({ block: 'center' })
              el.classList.add('is-flash')
              setTimeout(() => el.classList.remove('is-flash'), 1600)
            } else setReveal({ line: at, n: Date.now() })
          })
        } else centre.current?.scrollTo({ top: 0 })
      },
      (e) => {
        if (!live) return
        if (errorCode(e) === 'not_found') {
          toast('That note is gone from the vault')
          onMissing()
        } else setError(errorMessage(e))
      }
    )
    return () => {
      live = false
      void saveNow()
    }
  }, [target.id, target.path, target.n, retry])

  // ---- live updates of the open note ----
  useEffect(() => {
    if (change.key === lastChange.current) return
    lastChange.current = change.key
    const d = docRef.current
    if (!d) return
    const touches = !change.paths || !change.noteIds || change.paths.has(d.detail.note.path) || change.noteIds.has(d.detail.note.id) || (!change.paths.size && !change.noteIds.size)
    if (!touches) return
    let live = true
    get({ id: d.detail.note.id }).then(
      (fresh) => {
        if (!live) return
        const cur = docRef.current
        // our own save landing (or racing its response): not a change by someone else
        if (!cur || savingRef.current) return
        if (fresh.text === draftRef.current) {
          setDoc(fresh)
          return
        }
        const isDirty = editing && draftRef.current !== null && draftRef.current !== cur.text
        const act = liveAction({ baseHash: cur.hash, diskHash: fresh.hash, dirty: isDirty })
        if (act === 'banner') setIncoming({ doc: fresh, by: change.runIds.length ? 'an agent run' : 'Obsidian or another app' })
        else {
          setDoc(fresh)
          if (act === 'replace' || !isDirty) setDraft(fresh.text)
        }
      },
      (e) => {
        if (live && errorCode(e) === 'not_found') {
          toast('The open note was removed from the vault')
          onMissing()
        }
      }
    )
    return () => {
      live = false
    }
  }, [change.key])

  // ⌘E: reading <-> source
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyE') {
        e.preventDefault()
        toggleEditing()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const toggleEditing = (): void => {
    if (editing) {
      void saveNow()
      setEditing(false)
    } else if (!readOnly) {
      setDraft(docRef.current?.text ?? null)
      setEditing(true)
    }
  }

  const resolver = useMemo(() => makeResolver(tree, doc?.detail.outgoing ?? []), [tree, doc?.detail.outgoing])
  const history = useMemo(() => (doc?.detail.facts ?? []).filter((f) => f.section === 'history' || f.status === 'superseded' || f.status === 'invalid'), [doc?.detail.facts])

  if (error && !doc) return <div className="pview__center"><ErrorState error={`Couldn’t open the note: ${error}`} onRetry={() => setRetry((n) => n + 1)} /></div>
  if (!doc) return <div className="pview__center"><Loading /></div>
  const note = doc.detail.note

  const saveMerged = async (text: string): Promise<void> => {
    if (!merge) return
    setSaving(true)
    try {
      const r = await hive.memory.note({ op: 'save', companyId, path: note.path, baseHash: merge.theirsHash, text })
      if (r.status === 'saved') {
        const fresh = r.movedToHistory > 0 ? await get({ id: note.id }) : { text, hash: r.hash, detail: r.detail }
        setDoc(fresh)
        setDraft(fresh.text)
        setMerge(null)
        setIncoming(null)
        toast('Merged and saved')
      } else {
        // changed again while merging: merge against the newest file
        setMerge({ base: r.base, ours: text, theirs: r.theirs, theirsHash: r.theirsHash, label: merge.label })
        toast('The note changed again while you were merging; review the new changes', 'error')
      }
    } catch (e) {
      toast(`Couldn’t save the merge: ${errorMessage(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const showLine = (line: number): void => {
    if (readOnly) return
    if (!editing) {
      setDraft(doc.text)
      setEditing(true)
    }
    setReveal({ line, n: Date.now() })
  }

  return (
    <>
      <div className="pview__center" ref={centre}>
        <div className="pnote__head">
          <div className="pnote__crumbs" title={note.path}>
            {note.path.split('/').slice(0, -1).join(' / ') || 'Vault'}
            {note.status === 'archived' && <span className="ppill ppill--warn">archived</span>}
            {doc.detail.stale && <span className="ppill" title="A newer file is on disk than the index saw; it catches up in a moment">syncing</span>}
          </div>
          <span className="flex1" />
          {saving ? <span className="pnote__saving text-tertiary">Saving…</span> : dirty ? <span className="pnote__saving text-tertiary">Edited</span> : null}
          <Segmented<'read' | 'source'>
            size="sm"
            value={editing ? 'source' : 'read'}
            onChange={(v) => (v === 'source') !== editing && toggleEditing()}
            items={[
              { value: 'read', label: 'Read' },
              { value: 'source', label: 'Source', disabled: readOnly, title: '⌘E' }
            ]}
          />
        </div>
        {incoming && !merge && (
          <ConflictBanner
            by={incoming.by}
            saving={saving}
            onMerge={() => setMerge({ base: doc.text, ours: draft ?? doc.text, theirs: incoming.doc.text, theirsHash: incoming.doc.hash, label: incoming.by })}
            onDiscard={() => {
              const taken = incoming.doc.text
              setDoc(incoming.doc)
              setDraft(incoming.doc.text)
              setIncoming(null)
              // the banner may hold an older copy (or one rebuilt from a conflict answer): take the file as it is now
              void get({ id: note.id }).then(
                (fresh) => {
                  if (docRef.current?.detail.note.id !== fresh.detail.note.id || draftRef.current !== taken) return
                  setDoc(fresh)
                  setDraft(fresh.text)
                },
                () => undefined
              )
            }}
          />
        )}
        {merge ? (
          // keyed by the file it merges against: a re-merge after another change starts with fresh picks, so stale
          // choices (or a hand-edited result) never silently overwrite the newer file
          <MergeView
            key={merge.theirsHash}
            base={merge.base}
            ours={merge.ours}
            theirs={merge.theirs}
            theirsLabel={merge.label}
            saving={saving}
            onSave={(t) => void saveMerged(t)}
            onCancel={() => {
              // keep the banner up so autosave pauses instead of hitting the same conflict again in 800 ms
              if (!incoming) setIncoming({ doc: { text: merge.theirs, hash: merge.theirsHash, detail: doc.detail }, by: merge.label })
              setMerge(null)
            }}
          />
        ) : editing ? (
          <NoteEditor text={draft ?? doc.text} onChange={setDraft} onBlur={() => void saveNow()} tree={tree} ghosts={ghosts} tags={tags} reveal={reveal} readOnly={readOnly} />
        ) : (
          <NoteReader
            title={note.title}
            text={doc.text}
            facts={doc.detail.facts}
            resolve={resolver}
            highlightRunId={highlightRunId}
            actions={{
              openNote: (id, o) => onOpenNote(id, o),
              createNote: onCreateNote,
              filterTag: onFilterTag,
              showLine
            }}
          />
        )}
      </div>
      <aside className="pview__right">
        <Side title="Properties" open={right.props} onToggle={() => toggleRight('props')}>
          <PropertiesPanel detail={doc.detail} tree={tree} onOps={onOps} readOnly={readOnly} />
        </Side>
        <Side title="Links" open={right.links} onToggle={() => toggleRight('links')}>
          <BacklinksPanel
            companyId={companyId}
            noteId={note.id}
            title={note.title}
            outgoing={doc.detail.outgoing}
            reloadKey={change.key}
            readOnly={readOnly}
            onOpen={(id) => onOpenNote(id)}
            onOpenLine={(id, line) => onOpenNote(id, { line })}
            onCreate={onCreateNote}
            onOps={onOps}
          />
        </Side>
        <Side title="Local graph" open={right.local} onToggle={() => toggleRight('local')}>
          <LocalGraph
            companyId={companyId}
            noteId={note.id}
            pathById={pathById}
            reloadKey={change.key}
            initialDepth={initialDepth}
            onOpen={(id) => onOpenNote(id)}
            onCreateGhost={onCreateNote}
            onExpand={onGraph}
          />
        </Side>
        <Side title="History" count={history.length} open={right.history} onToggle={() => toggleRight('history')}>
          {history.length === 0 ? (
            <div className="pside__empty">Nothing superseded or invalidated yet.</div>
          ) : (
            <div className="phist">
              {history.map((f) => (
                <div key={f.id} className="phist__row">
                  <span className={`ppill ppill--history`}>{f.status === 'superseded' ? 'superseded' : 'invalidated'}</span>
                  <span className="phist__text">{f.text}</span>
                  <span className="phist__meta">
                    {f.actor === 'user' ? 'you' : f.actor}
                    {f.date ? ` · ${f.date}` : ''}
                    {f.runId && (
                      <button type="button" className="link-btn" onClick={() => void navigate({ name: 'run', runId: f.runId! })}>
                        run
                      </button>
                    )}
                    {!readOnly && (
                      <button type="button" className="link-btn" onClick={() => showLine(f.line)}>
                        Show in file
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Side>
      </aside>
    </>
  )
}

function Side({ title, count, open, onToggle, children }: { title: string; count?: number; open: boolean; onToggle: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="pside">
      <button type="button" className="pside__head" onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span>{title}</span>
        {count !== undefined && count > 0 && <span className="pside__count">{count}</span>}
      </button>
      {open && <div className="pside__body">{children}</div>}
    </section>
  )
}
