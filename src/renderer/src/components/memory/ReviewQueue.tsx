/**
 * Review tab (PO7): only `pending` rows — quarantined text, contested supersedes and contested relations.
 * Agents can't see them yet. Relations are here too, so the sidebar badge (facts + relations) can be cleared.
 */
import { useState } from 'react'
import type { MemoryFact, MemoryRelation } from '@shared/memory'
import { AutoTextarea, Button, EmptyState } from '../ui'
import { deleteRows, mutate } from './actions'
import { ProvenanceChips } from './ProvenanceChips'

export function ReviewQueue({
  facts,
  relations = [],
  entityNames = {},
  elsewhere = 0,
  onShowAll,
  onSelectEntity,
  onChanged
}: {
  facts: MemoryFact[]
  relations?: MemoryRelation[]
  /** id -> name for relation ends. */
  entityNames?: Record<string, string>
  /** Pending rows in other repositories (the sidebar badge counts every repository). */
  elsewhere?: number
  onShowAll?: () => void
  onSelectEntity: (id: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const n = facts.length + relations.length
  const more =
    elsewhere > 0 && onShowAll ? (
      <div className="mreview__more text-secondary">
        {elsewhere} more in other repositories.
        <button type="button" className="link-btn" onClick={onShowAll}>
          Show All Repositories
        </button>
      </div>
    ) : null
  if (n === 0) {
    return (
      <div className="mreview scroll">
        <EmptyState icon="check" text="Nothing to review here. Memories that look like instructions, or that contradict one you approved, wait here before agents can see them." />
        {more}
      </div>
    )
  }
  const approveAll = async (): Promise<void> => {
    let ok = true
    if (facts.length) ok = !!(await mutate({ op: 'approve', target: 'fact', ids: facts.map((f) => f.id) }, 'Approve all'))
    if (ok && relations.length) ok = !!(await mutate({ op: 'approve', target: 'relation', ids: relations.map((r) => r.id) }, 'Approve all'))
    onChanged()
  }
  return (
    <div className="mreview scroll">
      <div className="mreview__intro text-secondary">
        {n} memor{n === 1 ? 'y waits' : 'ies wait'} for you. Agents don’t see them until you approve.
        <span className="flex1" />
        <Button size="sm" onClick={() => void approveAll()}>
          Approve All
        </Button>
      </div>
      {more}
      {facts.map((f) => (
        <ReviewCard key={f.id} f={f} onSelectEntity={onSelectEntity} onChanged={onChanged} />
      ))}
      {relations.map((r) => (
        <RelationCard key={r.id} r={r} names={entityNames} onSelectEntity={onSelectEntity} onChanged={onChanged} />
      ))}
    </div>
  )
}

function reasonLabel(why: string | null): string {
  if (!why) return 'to review'
  if (why.startsWith('quarantined')) return 'looks like an instruction'
  if (why.startsWith('contested') || why.includes('approved')) return 'contradicts one you approved'
  return 'to review'
}

function ReviewCard({ f, onSelectEntity, onChanged }: { f: MemoryFact; onSelectEntity: (id: string) => void; onChanged: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(f.text)
  const approve = async (): Promise<void> => {
    const t = text.trim()
    if (editing && t !== f.text) {
      if (t.length < 3) return
      if (!(await mutate({ op: 'edit', target: 'fact', id: f.id, text: t }, 'Edit memory'))) return
    }
    if (await mutate({ op: 'approve', target: 'fact', ids: [f.id] }, 'Approve')) onChanged()
  }
  const reject = async (): Promise<void> => {
    if (await mutate({ op: 'invalidate', target: 'fact', ids: [f.id], reason: 'rejected in review' }, 'Reject')) onChanged()
  }
  return (
    <div className="mreview__card">
      <div className="mreview__head">
        <button type="button" className="link-btn" onClick={() => onSelectEntity(f.entityId)}>
          {f.entityName}
        </button>
        <span className="text-tertiary">· {f.kind}</span>
        <span className="flex1" />
        <span className="mbadge mbadge--warn" title={f.invalidReason ?? undefined}>
          ⚠ {reasonLabel(f.invalidReason)}
        </span>
      </div>
      {editing ? (
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} maxRows={10} maxLength={1000} autoFocus />
      ) : (
        <div className="mreview__text selectable">{f.text}</div>
      )}
      {f.invalidReason && <div className="mreview__why text-tertiary">{f.invalidReason}</div>}
      <div className="mreview__foot">
        <ProvenanceChips provenance={f.provenance} at={f.createdAt} unattributed={f.unattributed} />
        <span className="flex1" />
        {!editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={async () => (await deleteRows('fact', [f.id], f.text)) && onChanged()}>
          Delete…
        </Button>
        <Button size="sm" onClick={() => void reject()} title="Invalidate it: kept in History, never shown to agents">
          Reject
        </Button>
        <Button size="sm" variant="primary" onClick={() => void approve()}>
          {editing ? 'Save & Approve' : 'Approve'}
        </Button>
      </div>
    </div>
  )
}

function RelationCard({ r, names, onSelectEntity, onChanged }: { r: MemoryRelation; names: Record<string, string>; onSelectEntity: (id: string) => void; onChanged: () => void }): React.JSX.Element {
  const approve = async (): Promise<void> => {
    if (await mutate({ op: 'approve', target: 'relation', ids: [r.id] }, 'Approve')) onChanged()
  }
  const reject = async (): Promise<void> => {
    if (await mutate({ op: 'invalidate', target: 'relation', ids: [r.id], reason: 'rejected in review' }, 'Reject')) onChanged()
  }
  const from = names[r.fromId] ?? 'entity'
  const to = names[r.toId] ?? 'entity'
  return (
    <div className="mreview__card">
      <div className="mreview__head">
        <span className="text-tertiary">relation</span>
        <span className="flex1" />
        <span className="mbadge mbadge--warn" title={r.invalidReason ?? undefined}>
          ⚠ {reasonLabel(r.invalidReason)}
        </span>
      </div>
      <div className="mreview__rel selectable">
        <button type="button" className="link-btn" onClick={() => onSelectEntity(r.fromId)}>
          {from}
        </button>
        <span className="mrel__type">{r.type.replace(/_/g, ' ')}</span>
        <button type="button" className="link-btn" onClick={() => onSelectEntity(r.toId)}>
          {to}
        </button>
      </div>
      {r.invalidReason && <div className="mreview__why text-tertiary">{r.invalidReason}</div>}
      <div className="mreview__foot">
        <ProvenanceChips provenance={r.provenance} at={r.createdAt} unattributed={r.unattributed} />
        <span className="flex1" />
        <Button size="sm" variant="ghost" onClick={async () => (await deleteRows('relation', [r.id], `${from} ${r.type} ${to}`)) && onChanged()}>
          Delete…
        </Button>
        <Button size="sm" onClick={() => void reject()} title="Invalidate it: kept in History, never shown to agents">
          Reject
        </Button>
        <Button size="sm" variant="primary" onClick={() => void approve()}>
          Approve
        </Button>
      </div>
    </div>
  )
}
