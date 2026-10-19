/** Right panel for a selected entity (MEMORY.md §10.4): header, facts by kind, relations, history. Everything editable. */
import { useEffect, useState } from 'react'
import type { MemoryEntity, MemoryEntityDetail, MemoryFactKind, MemoryRelation, MemoryScopeFilter } from '@shared/memory'
import { MEMORY_FACT_KINDS } from '@shared/memory'
import { ENTITY_TYPES, KIND_LABEL, entityHue, groupFacts, isUnreviewed, nameKey, normalizeRelationType } from '../../lib/memory'
import { confirmNative, errorCode, errorMessage, hive, nativeMenu } from '../../lib/hive'
import { toast } from '../../state/store'
import { AutoTextarea, Disclosure, Field, IconButton, Loading, Sheet } from '../ui'
import { deleteRows, invalidateFacts, mutate, useAsk } from './actions'
import { EntityPicker, type EntityPick } from './EntityPicker'
import { FactRow } from './FactRow'
import { ProvenanceChips } from './ProvenanceChips'

export function MemoryInspector({
  entityId,
  reloadKey,
  candidates,
  scope,
  repoNames,
  onSelect,
  onClose,
  onDeleted
}: {
  entityId: string
  reloadKey: number
  candidates: MemoryEntity[]
  scope: MemoryScopeFilter['scope']
  repoNames: Record<string, string>
  onSelect: (id: string) => void
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const ask = useAsk()
  const [d, setD] = useState<MemoryEntityDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [adding, setAdding] = useState(false)
  const [relating, setRelating] = useState(false)
  const [merging, setMerging] = useState(false)
  const reload = (): void => setNonce((n) => n + 1)

  useEffect(() => {
    let live = true
    hive.memory.entity({ id: entityId }).then(
      (x) => {
        if (!live) return
        setD(x)
        setError(null)
      },
      (e) => {
        if (!live) return
        if (errorCode(e) === 'not_found') onDeleted()
        else setError(errorMessage(e))
      }
    )
    return () => {
      live = false
    }
    // onDeleted is stable enough; refetch on id, external changes and local edits
  }, [entityId, reloadKey, nonce])

  if (!d || d.entity.id !== entityId) {
    return (
      <aside className="drawer minspector">
        <IconButton icon="close" label="Close (Esc)" className="drawer__close" onClick={onClose} />
        {error ? <div className="drawer__body--pad text-failed selectable">{error}</div> : <Loading />}
      </aside>
    )
  }
  const e = d.entity
  const { groups, history } = groupFacts(d.facts)
  const byId = new Map(d.neighbors.map((n) => [n.id, n]))
  const unreviewed = d.facts.filter(isUnreviewed)
  // a project entity and a global entity with the same name are probably the same thing
  const twin = candidates.find((c) => c.id !== e.id && (c.repoId === null) !== (e.repoId === null) && nameKey(c.name) === nameKey(e.name))

  const rename = async (name: string): Promise<void> => {
    const n = name.trim()
    if (!n || n === e.name) return
    if (await mutate({ op: 'rename', id: e.id, name: n }, 'Rename')) reload()
  }
  const editEntity = async (patch: { type?: string; summary?: string; aliases?: string[] }): Promise<void> => {
    if (await mutate({ op: 'edit', target: 'entity', id: e.id, ...patch }, 'Edit entity')) reload()
  }
  const menu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'add', label: 'Add Memory…' },
      { id: 'relate', label: 'Add Relation…' },
      { id: 'approveAll', label: `Approve ${unreviewed.length} Unreviewed`, enabled: unreviewed.length > 0 },
      { type: 'separator' },
      { id: 'merge', label: 'Merge Into…' },
      { id: 'copy', label: 'Copy Name' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete Entity…' }
    ])
    if (id === 'add') setAdding(true)
    if (id === 'relate') setRelating(true)
    if (id === 'merge') setMerging(true)
    if (id === 'copy') void hive.clipboard.writeText({ text: e.name }).then(() => toast('Copied'))
    if (id === 'approveAll' && (await mutate({ op: 'approve', target: 'fact', ids: unreviewed.map((f) => f.id) }, 'Approve'))) reload()
    if (id === 'delete' && (await deleteRows('entity', [e.id], e.name))) onDeleted()
  }

  return (
    <aside className="drawer minspector" aria-label={`Memory: ${e.name}`}>
      <IconButton icon="close" label="Close (Esc)" className="drawer__close" onClick={onClose} />
      <div className="minspector__head">
        <div className="minspector__title-row">
          <span className="mnode__dot" style={{ ['--mnode-hue' as string]: entityHue(e.type) }} />
          <InlineText key={`n${e.name}`} className="minspector__name" value={e.name} onCommit={(v) => void rename(v)} label="Entity name" />
        </div>
        <div className="minspector__sub">
          <TypeSelect value={e.type} onChange={(type) => void editEntity({ type })} />
          <span className={`mscope ${e.repoId ? '' : 'mscope--global'}`}>{e.repoId ? (repoNames[e.repoId] ?? 'project') : 'global'}</span>
          {e.unattributed && <span className="mbadge mbadge--warn" title="Created by an agent whose grant no longer resolves">unattributed</span>}
          <span className="flex1" />
          <IconButton icon="plus" label="Add memory" onClick={() => setAdding(true)} />
          <IconButton icon="more" label="Entity actions" onClick={() => void menu()} />
        </div>
        <Aliases aliases={e.aliases} onChange={(aliases) => void editEntity({ aliases })} />
        <SummaryField key={`s${e.summary}`} value={e.summary} onCommit={(summary) => void editEntity({ summary })} />
        {twin && (
          <div className="minspector__created">
            Same name as {twin.repoId ? `a project entity in ${repoNames[twin.repoId] ?? 'a repository'}` : 'a global entity'}.
            <button type="button" className="link-btn" onClick={() => onSelect(twin.id)}>
              Show
            </button>
            ·
            <button type="button" className="link-btn" onClick={() => setMerging(true)}>
              Merge…
            </button>
          </div>
        )}
        <div className="minspector__created">
          created by <ProvenanceChips provenance={e.provenance} at={e.createdAt} unattributed={e.unattributed} compact />
        </div>
      </div>

      <div className="minspector__body scroll">
        {groups.length === 0 && <div className="minspector__empty text-tertiary">No live memories about {e.name}. <button type="button" className="link-btn" onClick={() => setAdding(true)}>Add one</button></div>}
        {groups.map((g) => (
          <section key={g.kind} className="minspector__group">
            <div className="minspector__label">
              {KIND_LABEL[g.kind]} <span className="text-tertiary">{g.facts.length}</span>
            </div>
            {g.facts.map((f) => (
              <FactRow key={f.id} f={f} all={d.facts} onChanged={reload} />
            ))}
          </section>
        ))}

        <section className="minspector__group">
          <div className="minspector__label">
            Relations <span className="text-tertiary">{d.relations.out.length + d.relations.in.length}</span>
            <span className="flex1" />
            <button type="button" className="link-btn" onClick={() => setRelating(true)}>
              + Relation
            </button>
          </div>
          {d.relations.out.length + d.relations.in.length === 0 && <div className="text-tertiary minspector__hint">Not linked to anything yet.</div>}
          {d.relations.out.map((r) => (
            <RelationRow key={r.id} r={r} dir="out" other={byId.get(r.toId)} onSelect={onSelect} onChanged={reload} ask={ask} />
          ))}
          {d.relations.in.map((r) => (
            <RelationRow key={r.id} r={r} dir="in" other={byId.get(r.fromId)} onSelect={onSelect} onChanged={reload} ask={ask} />
          ))}
        </section>

        {history.length > 0 && (
          <section className="minspector__group">
            <Disclosure label={`History · ${history.length} invalidated`}>
              {history.map((f) => (
                <FactRow key={f.id} f={f} all={d.facts} onChanged={reload} />
              ))}
            </Disclosure>
          </section>
        )}
      </div>

      {adding && (
        <AddFactSheet
          entity={e}
          repoName={e.repoId ? repoNames[e.repoId] : undefined}
          onClose={(ok) => {
            setAdding(false)
            if (ok) reload()
          }}
        />
      )}
      {relating && (
        <RelateSheet
          entity={e}
          candidates={candidates}
          scope={scope}
          onClose={(ok) => {
            setRelating(false)
            if (ok) reload()
          }}
        />
      )}
      {merging && (
        <MergeSheet
          entity={e}
          candidates={candidates}
          scope={scope}
          onClose={(targetId) => {
            setMerging(false)
            if (targetId) onSelect(targetId)
          }}
        />
      )}
    </aside>
  )
}

function InlineText({ value, onCommit, className, label }: { value: string; onCommit: (v: string) => void; className?: string; label: string }): React.JSX.Element {
  const [v, setV] = useState(value)
  return (
    <input
      className={`minline ${className ?? ''}`}
      value={v}
      aria-label={label}
      maxLength={120}
      spellCheck={false}
      onChange={(ev) => setV(ev.target.value)}
      onBlur={() => (v.trim() ? onCommit(v) : setV(value))}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') ev.currentTarget.blur()
        if (ev.key === 'Escape') {
          ev.stopPropagation()
          setV(value)
          setTimeout(() => (ev.target as HTMLInputElement).blur(), 0)
        }
      }}
    />
  )
}

function TypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const known = (ENTITY_TYPES as readonly string[]).includes(value)
  return (
    <select className="mtype" value={value} onChange={(ev) => onChange(ev.target.value)} aria-label="Entity type" title="Entity type">
      {!known && <option value={value}>{value}</option>}
      {ENTITY_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  )
}

function Aliases({ aliases, onChange }: { aliases: string[]; onChange: (v: string[]) => void }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [v, setV] = useState('')
  const commit = (): void => {
    const a = v.trim()
    setAdding(false)
    setV('')
    if (a && !aliases.includes(a) && aliases.length < 5) onChange([...aliases, a])
  }
  return (
    <div className="chips minspector__aliases" title="Other names agents may use for this entity (exact-match search)">
      {aliases.map((a) => (
        <span key={a} className="chip">
          {a}
          <button type="button" className="chip__x" aria-label={`Remove alias ${a}`} onClick={() => onChange(aliases.filter((x) => x !== a))}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="input input--sm minspector__alias-input"
          autoFocus
          value={v}
          maxLength={120}
          onChange={(ev) => setV(ev.target.value)}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') commit()
            if (ev.key === 'Escape') {
              ev.stopPropagation()
              setAdding(false)
              setV('')
            }
          }}
        />
      ) : (
        aliases.length < 5 && (
          <button type="button" className="chip chip--add" onClick={() => setAdding(true)}>
            + alias
          </button>
        )
      )}
    </div>
  )
}

function SummaryField({ value, onCommit }: { value: string; onCommit: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState(value)
  return (
    <AutoTextarea
      className="minspector__summary"
      value={v}
      minRows={1}
      maxRows={5}
      maxLength={300}
      placeholder="Add a one-line summary…"
      onChange={(ev) => setV(ev.target.value)}
      onBlur={() => v.trim() !== value && onCommit(v.trim())}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault()
          ev.currentTarget.blur()
        }
        if (ev.key === 'Escape') {
          ev.stopPropagation()
          setV(value)
        }
      }}
    />
  )
}

function RelationRow({
  r,
  dir,
  other,
  onSelect,
  onChanged,
  ask
}: {
  r: MemoryRelation
  dir: 'in' | 'out'
  other: MemoryEntity | undefined
  onSelect: (id: string) => void
  onChanged: () => void
  ask: ReturnType<typeof useAsk>
}): React.JSX.Element {
  const otherId = dir === 'out' ? r.toId : r.fromId
  const live = r.status !== 'invalid'
  const menu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'open', label: `Show ${other?.name ?? 'Entity'}` },
      { id: 'type', label: 'Rename Relation…', enabled: live },
      { id: 'approve', label: 'Approve', enabled: live && !r.reviewed && r.actor === 'agent' },
      { type: 'separator' },
      live ? { id: 'invalidate', label: 'Invalidate…' } : { id: 'restore', label: 'Restore' },
      { id: 'delete', label: 'Delete…' }
    ])
    if (id === 'open') onSelect(otherId)
    if (id === 'type') {
      const res = await ask({ title: 'Rename relation', label: 'Type', initial: r.type, confirmLabel: 'Rename', minLength: 2, maxLength: 40, placeholder: 'depends_on' })
      if (res && (await mutate({ op: 'edit', target: 'relation', id: r.id, type: normalizeRelationType(res.text) }, 'Rename relation'))) onChanged()
    }
    if (id === 'approve' && (await mutate({ op: 'approve', target: 'relation', ids: [r.id] }, 'Approve'))) onChanged()
    if (id === 'invalidate' && (await invalidateFacts(ask, [r.id], 'relation'))) onChanged()
    if (id === 'restore' && (await mutate({ op: 'restore', target: 'relation', ids: [r.id] }, 'Restore'))) onChanged()
    if (id === 'delete' && (await deleteRows('relation', [r.id], r.type))) onChanged()
  }
  return (
    <div
      className={`mrel mrel--${r.status}`}
      onContextMenu={(ev) => {
        ev.preventDefault()
        void menu()
      }}
      title={r.invalidReason ?? undefined}
    >
      <span className="mrel__dir">{dir === 'out' ? '→' : '←'}</span>
      <span className="mrel__type">{r.type}</span>
      <button type="button" className="link-btn mrel__other" onClick={() => onSelect(otherId)}>
        {other?.name ?? 'unknown'}
      </button>
      {r.status === 'pending' && <span className="mbadge mbadge--warn">to review</span>}
      {r.status === 'invalid' && <span className="mbadge mbadge--off">invalid</span>}
      {r.actor === 'agent' && !r.reviewed && r.status === 'active' && <span className="mbadge mbadge--new">unreviewed</span>}
      <span className="flex1" />
      <ProvenanceChips provenance={r.provenance} at={r.createdAt} unattributed={r.unattributed} compact />
      <IconButton icon="more" label="Relation actions" onClick={() => void menu()} />
    </div>
  )
}

function AddFactSheet({ entity, repoName, onClose }: { entity: MemoryEntity; repoName?: string; onClose: (ok: boolean) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryFactKind>('fact')
  const [scope, setScope] = useState<'project' | 'global'>(entity.repoId ? 'project' : 'global')
  const [pinned, setPinned] = useState(false)
  const [busy, setBusy] = useState(false)
  const valid = text.trim().length >= 3
  const save = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    const res = await mutate({ op: 'create', target: 'fact', input: { entityId: entity.id, text: text.trim(), kind, scope, repoId: scope === 'project' ? entity.repoId : null, pinned } }, 'Add memory')
    setBusy(false)
    if (res) onClose(true)
  }
  return (
    <Sheet title={`Add memory about ${entity.name}`} onCancel={() => onClose(false)} onPrimary={() => void save()} primaryLabel="Add" primaryDisabled={!valid || busy}>
      <Field label="Memory" align="start" hint="One self-contained fact. Agents read it as reference data, not instructions.">
        <AutoTextarea value={text} onChange={(ev) => setText(ev.target.value)} minRows={3} maxRows={10} maxLength={1000} placeholder="All new endpoints go through requireSession()." data-autofocus />
      </Field>
      <Field label="Kind">
        <select className="input input--auto" value={kind} onChange={(ev) => setKind(ev.target.value as MemoryFactKind)}>
          {MEMORY_FACT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Shown to" hint={scope === 'global' ? 'Agents in every repository and in Chat.' : `Agents working in ${repoName ?? 'this repository'}.`}>
        <select className="input input--auto" value={scope} onChange={(ev) => setScope(ev.target.value as 'project' | 'global')}>
          {entity.repoId && <option value="project">{repoName ?? 'This project'}</option>}
          <option value="global">Every repository (global)</option>
        </select>
      </Field>
      <Field label="">
        <label className="checkbox">
          <input type="checkbox" checked={pinned} onChange={(ev) => setPinned(ev.target.checked)} /> Pin: always include it in the agents’ brief
        </label>
      </Field>
    </Sheet>
  )
}

function RelateSheet({ entity, candidates, scope, onClose }: { entity: MemoryEntity; candidates: MemoryEntity[]; scope: MemoryScopeFilter['scope']; onClose: (ok: boolean) => void }): React.JSX.Element {
  const [type, setType] = useState('depends_on')
  const [pick, setPick] = useState<EntityPick | null>(null)
  const [busy, setBusy] = useState(false)
  const t = normalizeRelationType(type)
  const valid = t.length >= 2 && !!pick
  const save = async (): Promise<void> => {
    if (!valid || busy || !pick) return
    setBusy(true)
    let toId: string | undefined
    if ('entity' in pick) toId = pick.entity.id
    else toId = (await mutate({ op: 'create', target: 'entity', input: { repoId: entity.repoId, name: pick.newName } }, 'Create entity'))?.entity?.id
    const res = toId ? await mutate({ op: 'create', target: 'relation', input: { fromId: entity.id, toId, type: t, scope: entity.repoId ? 'project' : 'global' } }, 'Add relation') : undefined
    setBusy(false)
    if (res) onClose(true)
  }
  return (
    <Sheet title={`Relate ${entity.name} to…`} onCancel={() => onClose(false)} onPrimary={() => void save()} primaryLabel="Add Relation" primaryDisabled={!valid || busy}>
      <Field label="Relation" hint="An active verb from this entity: depends_on, calls, owned_by, part_of, same_as.">
        <input className="input mono" value={type} onChange={(ev) => setType(ev.target.value)} maxLength={40} list="mem-rel-types" />
        <datalist id="mem-rel-types">
          {['depends_on', 'calls', 'owned_by', 'part_of', 'replaces', 'same_as', 'configured_by'].map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </Field>
      <Field label="To">
        <EntityPicker
          candidates={candidates}
          scope={scope}
          exclude={[entity.id]}
          allow={(e) => !entity.repoId || !e.repoId || e.repoId === entity.repoId}
          allowNew
          onPick={setPick}
          autoFocus
        />
      </Field>
    </Sheet>
  )
}

function MergeSheet({ entity, candidates, scope, onClose }: { entity: MemoryEntity; candidates: MemoryEntity[]; scope: MemoryScopeFilter['scope']; onClose: (targetId: string | null) => void }): React.JSX.Element {
  const [pick, setPick] = useState<EntityPick | null>(null)
  const target = pick && 'entity' in pick ? pick.entity : null
  const save = async (): Promise<void> => {
    if (!target) return
    const ok = await confirmNative({
      message: `Merge “${entity.name}” into “${target.name}”?`,
      detail: `Its memories, aliases and relations move to “${target.name}”, and “${entity.name}” becomes an alias.`,
      confirmLabel: 'Merge'
    }).catch(() => false)
    if (!ok) return
    if (await mutate({ op: 'merge', sourceIds: [entity.id], targetId: target.id }, 'Merge')) onClose(target.id)
  }
  return (
    <Sheet title={`Merge ${entity.name} into…`} onCancel={() => onClose(null)} onPrimary={() => void save()} primaryLabel="Merge…" primaryDisabled={!target}>
      <p className="sheet__desc text-secondary">Use this when two entities are the same thing under different names.</p>
      <Field label="Keep">
        <EntityPicker candidates={candidates} scope={scope} exclude={[entity.id]} onPick={setPick} autoFocus />
      </Field>
    </Sheet>
  )
}
