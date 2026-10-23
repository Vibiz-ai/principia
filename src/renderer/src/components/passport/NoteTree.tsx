/**
 * The Notes mode left column (PASSPORT.md §10): search, the vault tree by folder with a type filter and counts,
 * the nested tag tree, ghost notes (click creates the note), Recent and Orphans, and the vault actions.
 */
import { useMemo, useState } from 'react'
import type { VaultGhost, VaultTagCount } from '@shared/passport'
import { Icon } from '../Icon'
import { IconButton } from '../ui'
import { buildFolderTree, buildTagTree, recentNotes, typeCounts, type FolderNode, type TagNode, type TreeNote } from '../../lib/passport'
import { loadJson, saveJson } from '../../state/store'

export interface TreeFilter {
  /** what the list is filtered by ("#pricing", "“ana”") */
  label: string
  /** matching note ids; null while loading */
  ids: ReadonlySet<string> | null
}

export function NoteTree({
  companyId,
  tree,
  tags,
  ghosts,
  selectedId,
  search,
  onSearch,
  searchRef,
  filter,
  onClearFilter,
  onTag,
  onOpen,
  onCreateGhost,
  onNewNote,
  onOpenInObsidian,
  onReveal,
  onReindex,
  readOnly
}: {
  companyId: string
  tree: TreeNote[]
  tags: VaultTagCount[]
  ghosts: VaultGhost[]
  selectedId: string | null
  search: string
  onSearch: (s: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  filter: TreeFilter | null
  onClearFilter: () => void
  onTag: (tag: string) => void
  onOpen: (noteId: string) => void
  onCreateGhost: (g: VaultGhost) => void
  onNewNote: () => void
  onOpenInObsidian: () => void
  onReveal: () => void
  onReindex: () => void
  readOnly?: boolean
}): React.JSX.Element {
  const [type, setType] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>(() => loadJson(`hive.passport.tree.${companyId}`, { '': true, 'sec:files': true, 'sec:tags': true, 'sec:ghosts': true, 'sec:recent': true }))
  const toggle = (k: string): void => {
    const next = { ...open, [k]: !open[k] }
    setOpen(next)
    saveJson(`hive.passport.tree.${companyId}`, next)
  }
  const root = useMemo(() => buildFolderTree(tree, type), [tree, type])
  const types = useMemo(() => typeCounts(tree), [tree])
  const tagTree = useMemo(() => buildTagTree(tags), [tags])
  const recent = useMemo(() => recentNotes(tree), [tree])
  const orphans = useMemo(() => tree.filter((t) => t.orphan).sort((a, b) => a.title.localeCompare(b.title)), [tree])
  const filtered = useMemo(() => (filter?.ids ? tree.filter((t) => filter.ids!.has(t.id)).sort((a, b) => a.title.localeCompare(b.title)) : null), [filter, tree])

  const section = (key: string, label: string, count: number, body: React.ReactNode): React.JSX.Element => (
    <div className="ptree__section">
      <button type="button" className="ptree__section-head" onClick={() => toggle(`sec:${key}`)}>
        <Icon name={open[`sec:${key}`] ? 'chevronDown' : 'chevronRight'} size={12} />
        <span>{label}</span>
        <span className="ptree__count">{count}</span>
      </button>
      {open[`sec:${key}`] && body}
    </div>
  )

  return (
    <nav className="ptree" aria-label="Vault">
      <div className="ptree__search">
        <Icon name="search" size={12} />
        <input
          ref={searchRef}
          className="ptree__search-input"
          placeholder="Search notes"
          value={search}
          spellCheck={false}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onSearch('')
            if (e.key === 'Enter' && filtered?.[0]) onOpen(filtered[0].id)
          }}
        />
      </div>
      <div className="ptree__actions">
        <IconButton icon="plus" label="New note" onClick={onNewNote} disabled={readOnly} />
        <IconButton icon="external" label="Open in Obsidian" onClick={onOpenInObsidian} />
        <IconButton icon="folder" label="Reveal in Finder" onClick={onReveal} />
        <IconButton icon="refresh" label="Reindex" onClick={onReindex} />
        <span className="flex1" />
        <select className="ptree__type" value={type ?? ''} onChange={(e) => setType(e.target.value || null)} aria-label="Filter by type">
          <option value="">All types · {tree.length}</option>
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.type} · {t.count}
            </option>
          ))}
        </select>
      </div>

      <div className="ptree__scroll">
        {filter ? (
          <div className="ptree__section">
            <div className="ptree__filter">
              <span>{filter.label}</span>
              <span className="ptree__count">{filtered ? filtered.length : '…'}</span>
              <span className="flex1" />
              <IconButton icon="close" label="Clear filter" onClick={onClearFilter} />
            </div>
            {filtered?.length === 0 && <div className="ptree__empty">No matching notes.</div>}
            {filtered?.map((n) => (
              <NoteRow key={n.id} n={n} depth={0} selected={n.id === selectedId} onOpen={onOpen} withFolder />
            ))}
          </div>
        ) : (
          <>
            {section('files', 'Files', root.count, <Folder node={root} depth={0} open={open} toggle={toggle} selectedId={selectedId} onOpen={onOpen} />)}
            {tagTree.length > 0 && section('tags', 'Tags', tags.length, <div className="ptree__tags">{tagTree.map((t) => <TagRow key={t.tag} t={t} depth={0} open={open} toggle={toggle} onTag={onTag} />)}</div>)}
            {ghosts.length > 0 &&
              section(
                'ghosts',
                'Ghost notes',
                ghosts.length,
                <div>
                  {ghosts.slice(0, 200).map((g) => (
                    <button
                      key={g.norm}
                      type="button"
                      className="ptree__row ptree__row--ghost"
                      disabled={readOnly}
                      onClick={() => onCreateGhost(g)}
                      title={g.ambiguous ? `Ambiguous: ${g.candidates.join(', ')}` : `Linked ${g.inbound}× from ${g.sources} note${g.sources === 1 ? '' : 's'}. Click to create it${g.guessedType ? ` as a ${g.guessedType}` : ''}.`}
                    >
                      <span className="ptree__ghost-dot" aria-hidden />
                      <span className="ptree__label">{g.text}</span>
                      <span className="ptree__count">{g.inbound}</span>
                    </button>
                  ))}
                </div>
              )}
            {recent.length > 0 && section('recent', 'Recent', recent.length, <div>{recent.map((n) => <NoteRow key={n.id} n={n} depth={0} selected={n.id === selectedId} onOpen={onOpen} withFolder />)}</div>)}
            {orphans.length > 0 && section('orphans', 'Orphans', orphans.length, <div>{orphans.map((n) => <NoteRow key={n.id} n={n} depth={0} selected={n.id === selectedId} onOpen={onOpen} withFolder />)}</div>)}
          </>
        )}
      </div>
    </nav>
  )
}

function Folder({ node, depth, open, toggle, selectedId, onOpen }: { node: FolderNode; depth: number; open: Record<string, boolean>; toggle: (k: string) => void; selectedId: string | null; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <div>
      {node.folders.map((f) => {
        const k = `dir:${f.path}`
        return (
          <div key={f.path}>
            <button type="button" className="ptree__row ptree__row--dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(k)}>
              <Icon name={open[k] ? 'chevronDown' : 'chevronRight'} size={11} />
              <span className="ptree__label">{f.name}</span>
              <span className="ptree__count">{f.count}</span>
            </button>
            {open[k] && <Folder node={f} depth={depth + 1} open={open} toggle={toggle} selectedId={selectedId} onOpen={onOpen} />}
          </div>
        )
      })}
      {node.notes.map((n) => (
        <NoteRow key={n.id} n={n} depth={depth} selected={n.id === selectedId} onOpen={onOpen} />
      ))}
    </div>
  )
}

function NoteRow({ n, depth, selected, onOpen, withFolder }: { n: TreeNote; depth: number; selected: boolean; onOpen: (id: string) => void; withFolder?: boolean }): React.JSX.Element {
  const folder = withFolder ? n.path.split('/').slice(0, -1).join('/') : ''
  return (
    <button
      type="button"
      className={`ptree__row ${selected ? 'is-selected' : ''} ${n.status === 'archived' ? 'is-archived' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 + 13 }}
      onClick={() => onOpen(n.id)}
      title={n.path}
    >
      <span className="ptree__label">{n.title}</span>
      {n.pinned && <Icon name="pin" size={11} className="ptree__pin" />}
      {folder && <span className="ptree__folder">{folder}</span>}
    </button>
  )
}

function TagRow({ t, depth, open, toggle, onTag }: { t: TagNode; depth: number; open: Record<string, boolean>; toggle: (k: string) => void; onTag: (tag: string) => void }): React.JSX.Element {
  const k = `tag:${t.tag}`
  return (
    <div>
      <div className="ptree__row ptree__row--tag" style={{ paddingLeft: 8 + depth * 12 }}>
        {t.children.length > 0 ? (
          <button type="button" className="ptree__twist" onClick={() => toggle(k)} aria-label={open[k] ? 'Collapse' : 'Expand'}>
            <Icon name={open[k] ? 'chevronDown' : 'chevronRight'} size={11} />
          </button>
        ) : (
          <span className="ptree__twist" />
        )}
        <button type="button" className="ptree__label ptree__tag" onClick={() => onTag(t.tag)}>
          #{t.name}
        </button>
        <span className="ptree__count">{t.total}</span>
      </div>
      {open[k] && t.children.map((c) => <TagRow key={c.tag} t={c} depth={depth + 1} open={open} toggle={toggle} onTag={onTag} />)}
    </div>
  )
}
