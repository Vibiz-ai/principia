import { useEffect, useMemo, useRef, useState } from 'react'
import type { Artifact, Run } from '@shared/types'
import { ArtifactThumb, dropThumb } from '../components/ArtifactThumb'
import { Button, EmptyState, ErrorState, IconButton, Loading, Segmented, Toolbar } from '../components/ui'
import { confirmNative, errorMessage, hive, nativeMenu, useHiveEvent } from '../lib/hive'
import { absolute, bytes, dayLabel, relative } from '../lib/time'
import { runTitle as shortRunTitle } from '../lib/format'
import { attempt, loadJson, navigate, providerLabel, saveJson, setStatusHint, toast, useStore } from '../state/store'
import { CompanyChip, useScope } from '../components/CompanyChip'
import { inScope } from '../lib/scope'

type KindFilter = 'all' | 'image' | 'video' | 'docs' | 'code' | 'other'
const KINDS: { value: KindFilter; label: string; title?: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Video' },
  { value: 'docs', label: 'Docs', title: 'Markdown, HTML and PDF' },
  { value: 'code', label: 'Code' },
  { value: 'other', label: 'Other', title: 'Audio and other files' }
]
const KIND_NAME: Record<KindFilter, string> = { all: 'files', image: 'images', video: 'videos', docs: 'documents', code: 'code files', other: 'other files' }
const KIND_MATCH: Record<Exclude<KindFilter, 'all'>, string[]> = { image: ['image'], video: ['video'], docs: ['markdown', 'html', 'pdf'], code: ['code'], other: ['audio', 'other'] }

/** COMPANY.md §3, §8.3-8.4: the focused company's files (stamped from their run or session), or all with a chip. */
export function ArtifactsView({ runId, sessionId }: { runId?: string; sessionId?: string }): React.JSX.Element {
  const { scope, chips, nonce } = useScope()
  const sessions = useStore((s) => s.sessions)
  const repos = useStore((s) => s.repos)
  const info = useStore((s) => s.info)
  const [list, setList] = useState<Artifact[] | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [owner, setOwner] = useState<string>(runId ? `r:${runId}` : sessionId ? `s:${sessionId}` : '')
  const [mode, setMode] = useState<'grid' | 'list'>(() => loadJson('hive.artifactsMode', 'grid'))
  const [sel, setSel] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => setOwner(runId ? `r:${runId}` : sessionId ? `s:${sessionId}` : ''), [runId, sessionId])
  const load = (): void => {
    hive.artifacts.list({ limit: 2000, ...(scope ? { companyId: scope } : {}) }).then(
      (l) => {
        setList(l)
        setError(null)
      },
      (e) => setError(errorMessage(e))
    )
    hive.runs.list({ limit: 300, ...(scope ? { companyId: scope } : {}) }).then(setRuns, () => undefined)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [nonce])
  useHiveEvent('artifact:added', (a) => inScope(a, scope) && setList((l) => (l ? [a, ...l.filter((x) => x.id !== a.id)] : l)))
  useHiveEvent('artifact:removed', ({ id }) => {
    dropThumb(id)
    setList((l) => l?.filter((x) => x.id !== id) ?? l)
  })

  const repoName = (id: string | null | undefined): string | null => (id ? (repos.find((r) => r.id === id)?.name ?? null) : null)
  const runTitle = (id: string | null): string | null => {
    if (!id) return null
    const r = runs.find((x) => x.id === id)
    return r ? shortRunTitle(r) : 'Run'
  }
  const sessTitle = (id: string | null): string | null => {
    if (!id) return null
    const s = sessions.find((x) => x.id === id)
    // repo + agent + when: two sessions in the same repo must not read the same
    return s ? [repoName(s.repoId) ?? 'Chat', s.adapter === 'shell' ? 'Terminal' : providerLabel(s.adapter), relative(s.startedAt)].join(' · ') : 'Session'
  }
  /** Where it came from, in human terms: the repo when known, else the workflow/run name. */
  const origin = (a: Artifact): string => {
    if (a.runId) {
      const r = runs.find((x) => x.id === a.runId)
      if (r?.target.kind === 'prompt') return repoName(r.target.repoId) ?? runTitle(a.runId) ?? ''
      if (r?.target.kind === 'workflow') {
        const repo = Object.values(r.target.inputs).map((v) => repoName(v)).find(Boolean)
        return repo ? `${repo} · ${r.title}` : r.title
      }
      return 'Run'
    }
    if (a.sessionId) {
      const s = sessions.find((x) => x.id === a.sessionId)
      return repoName(s?.repoId) ?? 'Chat'
    }
    return ''
  }
  const source = (a: Artifact): string => [origin(a), relative(a.createdAt)].filter(Boolean).join(' · ')

  const filtered = useMemo(() => {
    let l = list ?? []
    if (kind !== 'all') l = l.filter((a) => KIND_MATCH[kind].includes(a.kind))
    if (owner.startsWith('r:')) l = l.filter((a) => a.runId === owner.slice(2))
    if (owner.startsWith('s:')) l = l.filter((a) => a.sessionId === owner.slice(2))
    return [...l].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [list, kind, owner])

  const owners = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of list ?? []) {
      if (a.runId) {
        const r = runs.find((x) => x.id === a.runId)
        m.set(`r:${a.runId}`, [runTitle(a.runId) ?? a.runId, r ? relative(r.createdAt) : null].filter(Boolean).join(' · '))
      }
      else if (a.sessionId) m.set(`s:${a.sessionId}`, sessTitle(a.sessionId) ?? a.sessionId)
    }
    if (owner && !m.has(owner)) m.set(owner, owner.startsWith('r:') ? (runTitle(owner.slice(2)) ?? 'run') : (sessTitle(owner.slice(2)) ?? 'session'))
    return [...m.entries()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, runs, sessions, owner])

  const groups = useMemo(() => {
    const out: { label: string; items: Artifact[] }[] = []
    for (const a of filtered) {
      const l = dayLabel(a.createdAt)
      if (!out.length || out[out.length - 1]!.label !== l) out.push({ label: l, items: [] })
      out[out.length - 1]!.items.push(a)
    }
    return out
  }, [filtered])

  const selected = filtered.find((a) => a.id === sel) ?? null
  useEffect(() => {
    setStatusHint(selected ? `${selected.name} — Space to preview · ↵ to open · ⌘R to reveal in Finder` : null)
  }, [selected])
  useEffect(() => () => setStatusHint(null), [])

  const trash = async (a: Artifact): Promise<void> => {
    const ok = await confirmNative({ message: `Move “${a.name}” to the Trash?`, confirmLabel: 'Move to Trash', destructive: true }).catch(() => false)
    if (!ok) return
    await attempt(() => hive.artifacts.trash({ id: a.id }), 'Move to Trash')
  }
  const quickLook = (a: Artifact): void => void attempt(() => hive.artifacts.quickLook({ id: a.id }), 'Quick Look')
  const menu = async (a: Artifact): Promise<void> => {
    const id = await nativeMenu([
      { id: 'ql', label: 'Quick Look', accelerator: 'Space' },
      { id: 'open', label: 'Open', accelerator: 'Enter' },
      { id: 'reveal', label: 'Reveal in Finder', accelerator: 'Cmd+R' },
      { id: 'copy', label: 'Copy Path', accelerator: 'Cmd+Alt+C' },
      ...(a.runId ? [{ id: 'run', label: 'Go to Run' }] : a.sessionId ? [{ id: 'session', label: 'Show Session Files' }] : []),
      { type: 'separator' },
      { id: 'trash', label: 'Move to Trash', accelerator: 'Cmd+Backspace' }
    ])
    if (id === 'ql') quickLook(a)
    if (id === 'open') void attempt(() => hive.artifacts.open({ id: a.id }))
    if (id === 'reveal') void attempt(() => hive.artifacts.reveal({ id: a.id }))
    if (id === 'copy') void attempt(() => hive.artifacts.copyPath({ id: a.id })).then(() => toast('Path copied'))
    if (id === 'run' && a.runId) void navigate({ name: 'run', runId: a.runId })
    if (id === 'session' && a.sessionId) setOwner(`s:${a.sessionId}`)
    if (id === 'trash') void trash(a)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (!filtered.length) return
    const i = filtered.findIndex((a) => a.id === sel)
    const cols = mode === 'grid' && gridRef.current ? Math.max(1, Math.floor((gridRef.current.clientWidth - 32) / 176)) : 1
    const moveTo = (j: number): void => {
      const a = filtered[Math.min(filtered.length - 1, Math.max(0, j))]!
      setSel(a.id)
      document.querySelector(`[data-art="${a.id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'ArrowRight') (e.preventDefault(), moveTo(i + 1))
    else if (e.key === 'ArrowLeft') (e.preventDefault(), moveTo(i - 1))
    else if (e.key === 'ArrowDown') (e.preventDefault(), moveTo(i < 0 ? 0 : i + cols))
    else if (e.key === 'ArrowUp') (e.preventDefault(), moveTo(i - cols))
    else if (!selected) return
    else if (e.key === ' ') {
      e.preventDefault()
      quickLook(selected)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void attempt(() => hive.artifacts.open({ id: selected.id }))
    } else if (e.metaKey && e.code === 'KeyR') {
      e.preventDefault()
      void attempt(() => hive.artifacts.reveal({ id: selected.id }))
    } else if (e.metaKey && e.altKey && e.code === 'KeyC') {
      e.preventDefault()
      void attempt(() => hive.artifacts.copyPath({ id: selected.id })).then(() => toast('Path copied'))
    } else if (e.metaKey && e.key === 'Backspace') {
      e.preventDefault()
      void trash(selected)
    }
  }

  const tileProps = (a: Artifact): React.HTMLAttributes<HTMLDivElement> & { draggable: boolean; 'data-art': string } => ({
    'data-art': a.id,
    draggable: true,
    onDragStart: (e) => {
      e.preventDefault()
      hive.send('artifacts:startDrag', { id: a.id })
    },
    onClick: () => setSel(a.id),
    onDoubleClick: () => void attempt(() => hive.artifacts.open({ id: a.id })),
    onContextMenu: (e) => {
      e.preventDefault()
      setSel(a.id)
      void menu(a)
    }
  })

  const openRoot = (): void => {
    if (owner.startsWith('r:')) void attempt(() => hive.artifacts.openDir({ runId: owner.slice(2) }))
    else if (owner.startsWith('s:')) void attempt(() => hive.artifacts.openDir({ sessionId: owner.slice(2) }))
    else if (info) void attempt(() => hive.app.showItemInFolder({ path: info.artifactsDir }))
  }

  return (
    <div className="view">
      <Toolbar title="Files">
        <Segmented size="sm" items={KINDS} value={kind} onChange={setKind} className="no-drag" />
        <select className="input input--sm input--select-fixed no-drag" value={owner} onChange={(e) => setOwner(e.target.value)} title={owner ? (owners.find(([k]) => k === owner)?.[1] ?? '') : 'Filter by run or session'}>
          <option value="">All sources</option>
          {owners.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <IconButton icon="folder" label="Open in Finder" onClick={openRoot} />
        <Segmented
          size="sm"
          items={[
            { value: 'grid', label: '⊞', title: 'Grid' },
            { value: 'list', label: '☰', title: 'List' }
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m)
            saveJson('hive.artifactsMode', m)
          }}
        />
      </Toolbar>
      {error && !list ? (
        <ErrorState error={error} onRetry={load} />
      ) : !list ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState icon="artifacts" text={`${scope ? 'No files from this company yet. ' : ''}Files agents save appear here (Principia tells every agent to save into $ARTIFACTS_DIR).`}>
          <Button onClick={openRoot}>Open Artifacts Folder</Button>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState icon="artifacts" text={`No ${KIND_NAME[kind]}${owner ? ' from this source' : ''}.`}>
          <Button
            onClick={() => {
              setKind('all')
              setOwner('')
            }}
          >
            Clear Filter
          </Button>
        </EmptyState>
      ) : mode === 'grid' ? (
        <div className="gallery scroll" ref={gridRef} tabIndex={0} onKeyDown={onKey}>
          {groups.map((g) => (
            <section key={g.label}>
              <div className="gallery__day">{g.label}</div>
              <div className="gallery__grid">
                {g.items.map((a) => (
                  <div key={a.id} className={`tile ${sel === a.id ? 'is-selected' : ''}`} {...tileProps(a)} title={`${a.name}\n${bytes(a.bytes)} · ${absolute(a.createdAt)}\nSpace: Quick Look · Enter: Open`}>
                    <ArtifactThumb artifact={a} />
                    <div className="tile__name">{a.name}</div>
                    <div className="tile__src">
                      {chips && <CompanyChip companyId={a.companyId} avatarOnly size={12} className="tile__company" />}
                      {source(a)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="table scroll" tabIndex={0} onKeyDown={onKey}>
          <div className="tr tr--head art-cols">
            <span className="th">Name</span>
            <span className="th">Kind</span>
            <span className="th">Size</span>
            <span className="th">Source</span>
            <span className="th">Created</span>
          </div>
          {filtered.map((a) => (
            <div key={a.id} className={`tr art-cols ${sel === a.id ? 'is-selected' : ''}`} {...tileProps(a)}>
              <span className="td td--main td--ellipsis">
                <ArtifactThumb artifact={a} size={64} className="thumb--icon" /> {a.name}
              </span>
              <span className="td text-secondary">{a.kind}</span>
              <span className="td text-secondary">{bytes(a.bytes)}</span>
              <span className="td text-secondary td--ellipsis">
                {chips && <CompanyChip companyId={a.companyId} className="wf-company" />}
                {source(a)}
              </span>
              <span className="td text-tertiary">{absolute(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

