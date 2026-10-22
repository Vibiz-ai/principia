/**
 * Passport Inbox (PASSPORT.md §10, §12): every suggestion is a proposal with evidence, a score and a diff preview of
 * the exact markdown change. Nothing is written until accepted. Sections: Needs decision (contested supersedes,
 * conflicts, external removals), Link suggestions, New notes, Merges, Relation typing, Harvested notes.
 * Keys: A accept, R reject, E edit, ⇧A accept all of the same kind and source above the threshold (deterministic only).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VaultOp, VaultProposal } from '@shared/passport'
import { Button, EmptyState, ErrorState, Kbd, Loading, Sheet } from '../ui'
import { BULK_THRESHOLD, bulkAcceptIds, diffRows, groupInbox, inboxSection } from '../../lib/passport'
import { errorMessage, hive } from '../../lib/hive'
import { toast } from '../../state/store'

const SOURCE_LABEL: Record<string, string> = {
  mentions: 'mention',
  ghosts: 'ghost',
  dupes: 'duplicate',
  ontology: 'ontology',
  cooccur: 'co-occurrence',
  similar: 'similar text',
  llm: 'AI',
  harvest: 'harvested',
  writer: 'writer',
  indexer: 'file change',
  migration: 'migration'
}

export function Inbox({
  companyId,
  reloadKey,
  readOnly,
  onOpenNote,
  onCounts
}: {
  companyId: string
  reloadKey: number
  readOnly?: boolean
  onOpenNote: (path: string, line?: number | null) => void
  onCounts?: (c: { total: number; needsDecision: number }) => void
}): React.JSX.Element {
  const [items, setItems] = useState<VaultProposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<VaultProposal | null>(null)
  const [addAlias, setAddAlias] = useState<Record<string, boolean>>({})
  const [reload, setReload] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    hive.memory.proposals({ op: 'list', companyId, status: ['pending'], limit: 500 }).then(
      (r) => {
        if (!live) return
        setItems(r.items)
        setError(null)
      },
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
    // onCounts is a notification, not an input
  }, [companyId, reloadKey, reload])

  const sections = useMemo(() => groupInbox(items ?? []), [items])
  // the toolbar badge follows accepts and rejects right away
  useEffect(() => {
    if (items) onCounts?.({ total: items.length, needsDecision: items.filter((p) => inboxSection(p) === 'decision').length })
  }, [items])
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const current = flat.find((p) => p.id === focus) ?? flat[0] ?? null

  useEffect(() => {
    if (current) root.current?.querySelector<HTMLElement>(`[data-pid="${current.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current?.id])

  const drop = (ids: string[]): void => {
    const gone = new Set(ids)
    // focus moves to the next item, not back to the top
    const idx = flat.findIndex((p) => p.id === current?.id)
    const next = flat.slice(idx + 1).find((p) => !gone.has(p.id)) ?? flat.slice(0, Math.max(0, idx)).reverse().find((p) => !gone.has(p.id))
    setFocus(next?.id ?? null)
    setItems((xs) => (xs ? xs.filter((p) => !gone.has(p.id)) : xs))
  }

  const accept = useCallback(
    async (ids: string[], alias?: boolean): Promise<void> => {
      if (!ids.length || readOnly) return
      setBusy(true)
      try {
        const r = await hive.memory.proposals({ op: 'accept', companyId, ids, addAlias: alias })
        drop(ids)
        const failed = r.results.results.filter((x) => x.status === 'error' || x.status === 'conflict').length
        if (r.stale || failed) toast(`${r.accepted} accepted${r.stale ? `, ${r.stale} out of date` : ''}${failed ? `, ${failed} could not be applied` : ''}`, failed ? 'error' : 'info')
        else if (ids.length > 1) toast(`${r.accepted} suggestions accepted`)
        if (r.stale || failed) setReload((n) => n + 1)
      } catch (e) {
        toast(`Couldn’t accept: ${errorMessage(e)}`, 'error')
      } finally {
        setBusy(false)
      }
    },
    [companyId, readOnly, flat, current]
  )
  const reject = useCallback(
    async (ids: string[]): Promise<void> => {
      if (!ids.length || readOnly) return
      setBusy(true)
      try {
        await hive.memory.proposals({ op: 'reject', companyId, ids })
        drop(ids)
      } catch (e) {
        toast(`Couldn’t reject: ${errorMessage(e)}`, 'error')
      } finally {
        setBusy(false)
      }
    },
    [companyId, readOnly, flat, current]
  )

  // keyboard: A / R / E / ⇧A, ↑↓ (or J/K) move
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (editing || busy || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (!current) return
      const i = flat.indexOf(current)
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        setFocus(flat[Math.min(flat.length - 1, i + 1)]?.id ?? null)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        setFocus(flat[Math.max(0, i - 1)]?.id ?? null)
      } else if (e.code === 'KeyA' && e.shiftKey) {
        e.preventDefault()
        const ids = bulkAcceptIds(flat, current)
        if (ids.length) void accept(ids)
        else toast('Accept all works for deterministic suggestions only')
      } else if (e.code === 'KeyA') {
        e.preventDefault()
        void accept([current.id], addAlias[current.id])
      } else if (e.code === 'KeyR') {
        e.preventDefault()
        void reject([current.id])
      } else if (e.code === 'KeyE' && !readOnly) {
        e.preventDefault()
        setEditing(current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, flat, editing, busy, accept, reject, addAlias, readOnly])

  const suggestNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await hive.memory.proposals({ op: 'suggestNow', companyId })
      toast(r.created ? `${r.created} new suggestion${r.created === 1 ? '' : 's'}` : r.queued ? 'Looking for suggestions…' : 'Nothing new to suggest')
      setReload((n) => n + 1)
    } catch (e) {
      toast(`Couldn’t run suggestions: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (error && !items) return <ErrorState error={`Couldn’t load the Inbox: ${error}`} onRetry={() => setReload((n) => n + 1)} />
  if (!items) return <Loading label="Loading Inbox…" />

  return (
    <div className="pinbox" ref={root}>
      <div className="pinbox__bar">
        <span className="pinbox__hint">
          <Kbd>A</Kbd> accept · <Kbd>R</Kbd> reject · <Kbd>E</Kbd> edit · <Kbd>⇧A</Kbd> accept all like this
        </span>
        <span className="flex1" />
        <Button size="sm" icon="spark" onClick={() => void suggestNow()} disabled={busy || readOnly}>
          Suggest now
        </Button>
      </div>
      {flat.length === 0 ? (
        <EmptyState icon="check" text="Inbox zero. Link suggestions, new notes and anything that needs your decision show up here." />
      ) : (
        <div className="pinbox__scroll">
          {sections.map((s) => (
            <section key={s.key} className={`pinbox__section pinbox__section--${s.key}`}>
              <div className="pinbox__section-head">
                {s.label} <span className="pside__count">{s.items.length}</span>
              </div>
              {s.items.map((p) => (
                <ProposalCard
                  key={p.id}
                  p={p}
                  focused={current?.id === p.id}
                  busy={busy}
                  readOnly={readOnly}
                  bulk={bulkAcceptIds(flat, p).length}
                  addAlias={!!addAlias[p.id]}
                  onAddAlias={(v) => setAddAlias({ ...addAlias, [p.id]: v })}
                  onFocus={() => setFocus(p.id)}
                  onAccept={() => void accept([p.id], addAlias[p.id])}
                  onAcceptAll={() => void accept(bulkAcceptIds(flat, p))}
                  onReject={() => void reject([p.id])}
                  onEdit={() => setEditing(p)}
                  onOpenNote={onOpenNote}
                />
              ))}
            </section>
          ))}
        </div>
      )}
      {editing && (
        <EditSheet
          p={editing}
          onCancel={() => setEditing(null)}
          onSave={async (ops) => {
            setBusy(true)
            try {
              await hive.memory.proposals({ op: 'edit', companyId, id: editing.id, ops, accept: true })
              drop([editing.id])
              setEditing(null)
            } catch (e) {
              toast(`Couldn’t apply the edit: ${errorMessage(e)}`, 'error')
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </div>
  )
}

function ProposalCard({
  p,
  focused,
  busy,
  readOnly,
  bulk,
  addAlias,
  onAddAlias,
  onFocus,
  onAccept,
  onAcceptAll,
  onReject,
  onEdit,
  onOpenNote
}: {
  p: VaultProposal
  focused: boolean
  busy: boolean
  readOnly?: boolean
  bulk: number
  addAlias: boolean
  onAddAlias: (v: boolean) => void
  onFocus: () => void
  onAccept: () => void
  onAcceptAll: () => void
  onReject: () => void
  onEdit: () => void
  onOpenNote: (path: string, line?: number | null) => void
}): React.JSX.Element {
  return (
    <div className={`pcard ${focused ? 'is-focused' : ''}`} data-pid={p.id} onMouseDown={onFocus}>
      <div className="pcard__head">
        <span className="pcard__title">{p.title}</span>
        <span className="pcard__meta">
          {p.kind.replace(/_/g, ' ')} · {SOURCE_LABEL[p.source] ?? p.source} · <span title="Score">{Math.round(p.score * 100)}%</span>
        </span>
      </div>
      {p.evidence.length > 0 && (
        <ul className="pcard__evidence">
          {p.evidence.slice(0, 4).map((e, i) => (
            <li key={i}>
              {e.quote && <q className="pcard__quote">{e.quote}</q>}
              {e.note && <span className="text-tertiary"> {e.note}</span>}
              {e.path && (
                <button type="button" className="pcard__path" onClick={() => onOpenNote(e.path!, e.line)}>
                  {e.path}
                  {e.line != null ? `:${e.line + 1}` : ''}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {p.preview.map((pv, i) => (
        <div key={i} className="pdiff">
          <button type="button" className="pdiff__path" onClick={() => onOpenNote(pv.path)}>
            {pv.path}
          </button>
          <div className="pdiff__body mono">
            {diffRows(pv.before, pv.after).map((r, j) => (
              <div key={j} className={`pdiff__row pdiff__row--${r.kind === '+' ? 'add' : r.kind === '-' ? 'del' : r.kind === '…' ? 'fold' : 'ctx'}`}>
                <span className="pdiff__sign">{r.kind === '…' ? '' : r.kind}</span>
                <span className="pdiff__text">{r.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="pcard__actions">
        <Button size="sm" variant="primary" onClick={onAccept} disabled={busy || readOnly}>
          Accept
        </Button>
        <Button size="sm" onClick={onReject} disabled={busy || readOnly}>
          Reject
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy || readOnly}>
          Edit
        </Button>
        {p.kind === 'retarget' && (
          <label className="pcard__alias">
            <input type="checkbox" checked={addAlias} onChange={(e) => onAddAlias(e.target.checked)} /> Also add as alias
          </label>
        )}
        <span className="flex1" />
        {bulk > 1 && (
          <Button size="sm" variant="ghost" onClick={onAcceptAll} disabled={busy || readOnly} title={`Accept every ${p.kind.replace(/_/g, ' ')} suggestion from ${SOURCE_LABEL[p.source] ?? p.source} scoring ${Math.round(BULK_THRESHOLD * 100)}% or more`}>
            Accept all {bulk}
          </Button>
        )}
      </div>
    </div>
  )
}

/** E: the proposal's writer ops as JSON, applied right away when saved (validated by main's schema). */
function EditSheet({ p, onCancel, onSave }: { p: VaultProposal; onCancel: () => void; onSave: (ops: VaultOp[]) => void }): React.JSX.Element {
  const [text, setText] = useState(() => JSON.stringify(p.ops, null, 2))
  let parsed: VaultOp[] | null = null
  let problem: string | null = null
  try {
    const v = JSON.parse(text) as unknown
    if (!Array.isArray(v) || v.some((o) => !o || typeof o !== 'object' || typeof (o as { op?: unknown }).op !== 'string')) problem = 'Expected a list of writer ops, each with an "op".'
    else parsed = v as VaultOp[]
  } catch (e) {
    problem = (e as Error).message
  }
  return (
    <Sheet title={`Edit “${p.title}”`} onCancel={onCancel} onPrimary={parsed ? () => onSave(parsed!) : undefined} primaryLabel="Apply" primaryDisabled={!parsed} width={640}>
      <p className="text-secondary pinbox__edit-help">These are the exact changes the suggestion makes. Adjust a target, a relation type or a title, then apply.</p>
      <textarea className="pinbox__edit mono" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      {problem && <div className="field__error">{problem}</div>}
    </Sheet>
  )
}
