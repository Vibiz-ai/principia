/** Facts tab (MEMORY.md §10.5, PO9): newest first, multi-select bulk actions, run filter + Revert run. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryFact } from '@shared/memory'
import { sourceLabel } from '../../lib/memory'
import { nativeMenu } from '../../lib/hive'
import { Button, RelativeTime } from '../ui'
import { deleteRows, invalidateFacts, mutate, toGlobal, useAsk } from './actions'
import { FactBadges } from './FactRow'

/** Rows rendered at once; "Show more" adds the next page (keeps 1,000-row tables smooth). */
const PAGE = 120

export function FactsTable({
  facts,
  total,
  selectedEntityId,
  runLabel,
  onRevertRun,
  onSelectEntity,
  onChanged
}: {
  facts: MemoryFact[]
  total: number
  selectedEntityId: string | null
  runLabel: string | null
  onRevertRun: (() => void) | null
  onSelectEntity: (id: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const ask = useAsk()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE)
  const lastClicked = useRef<number | null>(null)
  useEffect(() => {
    // drop selections that left the list
    setChecked((c) => new Set([...c].filter((id) => facts.some((f) => f.id === id))))
  }, [facts])
  useEffect(() => setShown(PAGE), [facts])

  const sel = useMemo(() => facts.filter((f) => checked.has(f.id)), [facts, checked])
  const ids = sel.map((f) => f.id)
  const allOn = facts.length > 0 && sel.length === facts.length
  const done = (ok: unknown): void => {
    if (!ok) return
    setChecked(new Set())
    onChanged()
  }

  const toggle = (i: number, e: React.MouseEvent | React.ChangeEvent): void => {
    const f = facts[i]!
    const shift = 'shiftKey' in e && (e as React.MouseEvent).shiftKey
    setChecked((c) => {
      const n = new Set(c)
      if (shift && lastClicked.current !== null) {
        const [a, b] = [Math.min(lastClicked.current, i), Math.max(lastClicked.current, i)]
        for (let k = a; k <= b; k++) n.add(facts[k]!.id)
      } else if (n.has(f.id)) n.delete(f.id)
      else n.add(f.id)
      return n
    })
    lastClicked.current = i
  }

  const rowMenu = async (f: MemoryFact): Promise<void> => {
    const target = checked.has(f.id) && sel.length > 1 ? sel : [f]
    const tIds = target.map((x) => x.id)
    const n = target.length > 1 ? ` ${target.length}` : ''
    const id = await nativeMenu([
      { id: 'open', label: `Show ${f.entityName}` },
      { type: 'separator' },
      { id: 'approve', label: `Approve${n}` },
      { id: 'global', label: `Move${n} to Global`, enabled: target.some((x) => x.scope === 'project' && x.status === 'active') },
      { id: 'invalidate', label: `Invalidate${n}…`, enabled: target.some((x) => x.status !== 'invalid') },
      { id: 'restore', label: `Restore${n}`, enabled: target.some((x) => x.status === 'invalid') },
      { type: 'separator' },
      { id: 'delete', label: `Delete${n}…` }
    ])
    if (id === 'open') onSelectEntity(f.entityId)
    if (id === 'approve') done(await mutate({ op: 'approve', target: 'fact', ids: tIds }, 'Approve'))
    if (id === 'global') done(await toGlobal(target.filter((x) => x.scope === 'project' && x.status === 'active').map((x) => x.id)))
    if (id === 'invalidate') done(await invalidateFacts(ask, target.filter((x) => x.status !== 'invalid').map((x) => x.id)))
    if (id === 'restore') done(await mutate({ op: 'restore', target: 'fact', ids: target.filter((x) => x.status === 'invalid').map((x) => x.id) }, 'Restore'))
    if (id === 'delete') done(await deleteRows('fact', tIds, target.length === 1 ? f.text : undefined))
  }

  return (
    <div className="mfacts">
      <div className="mfacts__bar">
        {sel.length > 0 ? (
          <>
            <span className="text-secondary">{sel.length} selected</span>
            <Button size="sm" onClick={async () => done(await mutate({ op: 'approve', target: 'fact', ids }, 'Approve'))}>
              Approve
            </Button>
            <Button size="sm" onClick={async () => done(await invalidateFacts(ask, sel.filter((f) => f.status !== 'invalid').map((f) => f.id)))} disabled={!sel.some((f) => f.status !== 'invalid')}>
              Invalidate…
            </Button>
            <Button size="sm" onClick={async () => done(await toGlobal(sel.filter((f) => f.scope === 'project' && f.status === 'active').map((f) => f.id)))} disabled={!sel.some((f) => f.scope === 'project' && f.status === 'active')}>
              Move to Global
            </Button>
            <Button size="sm" variant="ghost" onClick={async () => done(await deleteRows('fact', ids))}>
              Delete…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
              Clear
            </Button>
          </>
        ) : (
          <span className="text-tertiary">
            {total > facts.length ? `${facts.length} of ${total}` : `${facts.length}`} memor{facts.length === 1 ? 'y' : 'ies'}, newest first{runLabel ? ` · written or changed by run “${runLabel}”` : ''}
          </span>
        )}
        <span className="flex1" />
        {onRevertRun && (
          <Button size="sm" variant="secondary" className="btn--caution" onClick={onRevertRun} title="Invalidate everything this run wrote and restore what it replaced. One-way: restore single items from History.">
            Revert Run…
          </Button>
        )}
      </div>
      <div className="table scroll mfacts__table" role="grid" aria-rowcount={facts.length}>
        <div className="tr tr--head mfacts-cols">
          <span className="th">
            <input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setChecked(allOn ? new Set() : new Set(facts.map((f) => f.id)))} />
          </span>
          <span className="th">Entity</span>
          <span className="th">Memory</span>
          <span className="th">Kind</span>
          <span className="th">Status</span>
          <span className="th">Written by</span>
          <span className="th">When</span>
        </div>
        {facts.slice(0, shown).map((f, i) => (
          <div
            key={f.id}
            role="row"
            className={`tr mfacts-cols ${checked.has(f.id) ? 'is-selected' : ''} ${f.entityId === selectedEntityId ? 'is-current' : ''} ${f.status === 'invalid' ? 'is-dim' : ''}`}
            onClick={(e) => (e.metaKey || e.shiftKey ? toggle(i, e) : onSelectEntity(f.entityId))}
            onContextMenu={(e) => {
              e.preventDefault()
              void rowMenu(f)
            }}
          >
            <span className="td" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" aria-label="Select" checked={checked.has(f.id)} onChange={(e) => toggle(i, e)} onClick={(e) => e.shiftKey && (e.preventDefault(), toggle(i, e))} />
            </span>
            <span className="td td--ellipsis" title={f.entityName}>
              {f.entityName}
            </span>
            <span className={`td td--main ${f.status === 'invalid' ? 'mfacts__struck' : ''}`} title={f.text}>
              {f.text}
            </span>
            <span className="td text-secondary">{f.kind}</span>
            <span className="td">
              <FactBadges f={f} />
              {f.status === 'active' && !f.pinned && f.reviewed && <span className="text-tertiary">active</span>}
            </span>
            <span className="td td--ellipsis text-secondary" title={sourceLabel(f.provenance, { unattributed: f.unattributed })}>
              {sourceLabel(f.provenance, { unattributed: f.unattributed })}
            </span>
            <span className="td text-tertiary">
              <RelativeTime iso={f.createdAt} />
            </span>
          </div>
        ))}
        {shown < facts.length && (
          <div className="mfacts__more">
            <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, facts.length - shown)} more
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
