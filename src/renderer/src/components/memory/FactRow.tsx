/** One memory in the inspector: click-to-edit text, badges, provenance, actions, per-fact History (supersede chain). */
import { useState } from 'react'
import type { MemoryFact } from '@shared/memory'
import { isUnreviewed, supersedeChain } from '../../lib/memory'
import { hive, nativeMenu } from '../../lib/hive'
import { toast } from '../../state/store'
import { AutoTextarea, IconButton, RelativeTime } from '../ui'
import { deleteRows, invalidateFacts, mutate, replaceFact, toGlobal, useAsk } from './actions'
import { ProvenanceChips } from './ProvenanceChips'

export function FactBadges({ f }: { f: MemoryFact }): React.JSX.Element {
  return (
    <>
      {f.pinned && <span className="mbadge mbadge--pin" title="Pinned: always in the agents’ brief">pinned</span>}
      {f.status === 'pending' && (
        <span className="mbadge mbadge--warn" title={f.invalidReason ?? 'Waiting for your review. Agents don’t see it yet.'}>
          to review
        </span>
      )}
      {f.status === 'invalid' && (
        <span className="mbadge mbadge--off" title={f.invalidReason ?? undefined}>
          invalid
        </span>
      )}
      {isUnreviewed(f) && <span className="mbadge mbadge--new" title="Written by an agent; you haven’t approved or edited it">unreviewed</span>}
      {f.scope === 'global' && <span className="mbadge" title="Shown to agents in every repository">global</span>}
    </>
  )
}

export function FactRow({ f, all, onChanged }: { f: MemoryFact; all: MemoryFact[]; onChanged: () => void }): React.JSX.Element {
  const ask = useAsk()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(f.text)
  const [showHistory, setShowHistory] = useState(false)
  const chain = f.supersedes.length ? supersedeChain(f, all) : []
  const live = f.status !== 'invalid'
  const canApprove = live && (f.status === 'pending' || isUnreviewed(f))

  const commit = async (): Promise<void> => {
    const t = text.trim()
    setEditing(false)
    if (t === f.text || t.length < 3) return setText(f.text)
    if (await mutate({ op: 'edit', target: 'fact', id: f.id, text: t }, 'Edit memory')) onChanged()
    else setText(f.text)
  }
  const done = (ok: boolean | undefined | unknown): void => {
    if (ok) onChanged()
  }

  const menu = async (): Promise<void> => {
    const id = await nativeMenu([
      { id: 'edit', label: 'Edit Text', enabled: live },
      { id: 'replace', label: 'Replace With…', enabled: f.status === 'active' },
      { id: 'kind', label: 'Kind', enabled: live, submenu: (['fact', 'decision', 'convention', 'gotcha'] as const).map((k) => ({ id: `kind:${k}`, label: k, type: 'checkbox' as const, checked: f.kind === k })) },
      { type: 'separator' },
      f.pinned ? { id: 'unpin', label: 'Unpin' } : { id: 'pin', label: 'Pin (always in the brief)', enabled: f.status === 'active' },
      { id: 'approve', label: 'Approve', enabled: canApprove },
      { id: 'global', label: 'Move to Global', enabled: f.scope === 'project' && f.status === 'active' },
      { type: 'separator' },
      live ? { id: 'invalidate', label: 'Invalidate…' } : { id: 'restore', label: 'Restore' },
      { id: 'copy', label: 'Copy Text' },
      { id: 'delete', label: 'Delete…' }
    ])
    if (!id) return
    if (id === 'edit') setEditing(true)
    if (id === 'replace') done(await replaceFact(ask, f))
    if (id.startsWith('kind:')) done(await mutate({ op: 'edit', target: 'fact', id: f.id, kind: id.slice(5) as MemoryFact['kind'] }, 'Change kind'))
    if (id === 'pin' || id === 'unpin') done(await mutate({ op: id, ids: [f.id] }, id === 'pin' ? 'Pin' : 'Unpin'))
    if (id === 'approve') done(await mutate({ op: 'approve', target: 'fact', ids: [f.id] }, 'Approve'))
    if (id === 'global') done(await toGlobal([f.id]))
    if (id === 'invalidate') done(await invalidateFacts(ask, [f.id]))
    if (id === 'restore') done(await mutate({ op: 'restore', target: 'fact', ids: [f.id] }, 'Restore'))
    if (id === 'copy') void hive.clipboard.writeText({ text: f.text }).then(() => toast('Copied'), () => undefined)
    if (id === 'delete') done(await deleteRows('fact', [f.id], f.text))
  }

  return (
    <div
      className={`mfact mfact--${f.status} ${f.kind === 'gotcha' ? 'mfact--gotcha' : ''}`}
      tabIndex={0}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('textarea')) return
        e.preventDefault()
        void menu()
      }}
      onKeyDown={async (e) => {
        if (editing || e.target !== e.currentTarget) return
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          done(await deleteRows('fact', [f.id], f.text))
        } else if (e.key === 'Enter' && live) {
          e.preventDefault()
          setEditing(true)
        }
      }}
    >
      {editing ? (
        <AutoTextarea
          className="mfact__edit"
          value={text}
          autoFocus
          minRows={2}
          maxRows={10}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void commit()
            }
            if (e.key === 'Escape') {
              setText(f.text)
              setEditing(false)
            }
          }}
        />
      ) : (
        <div className={`mfact__text selectable ${live ? 'is-editable' : ''}`} onClick={() => live && setEditing(true)} title={live ? 'Click to edit · ⏎ edit · ⌫ delete' : undefined}>
          {f.text}
        </div>
      )}
      <div className="mfact__meta">
        <FactBadges f={f} />
        <ProvenanceChips provenance={f.provenance} at={f.createdAt} unattributed={f.unattributed} editedByUser={f.editedByUser} compact />
        <span className="flex1" />
        <span className="mfact__actions">
          {canApprove && <IconButton icon="check" label="Approve" onClick={async () => done(await mutate({ op: 'approve', target: 'fact', ids: [f.id] }, 'Approve'))} />}
          {f.status === 'active' && <IconButton icon="pin" label={f.pinned ? 'Unpin' : 'Pin: always in the agents’ brief'} className={f.pinned ? 'is-on' : ''} onClick={async () => done(await mutate({ op: f.pinned ? 'unpin' : 'pin', ids: [f.id] }, 'Pin'))} />}
          {!live && <IconButton icon="refresh" label="Restore" onClick={async () => done(await mutate({ op: 'restore', target: 'fact', ids: [f.id] }, 'Restore'))} />}
          <IconButton icon="more" label="More actions" onClick={() => void menu()} />
        </span>
      </div>
      {f.status === 'invalid' && f.invalidReason && <div className="mfact__reason">✕ {f.invalidReason}{f.invalidatedAt && <> · <RelativeTime iso={f.invalidatedAt} /></>}</div>}
      {f.status === 'pending' && f.invalidReason && <div className="mfact__reason mfact__reason--warn">⚠ {f.invalidReason}</div>}
      {chain.length > 0 && (
        <div className="mfact__history">
          <button type="button" className="link-btn mfact__history-btn" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide history' : `History · ${chain.length} earlier version${chain.length === 1 ? '' : 's'}`}
          </button>
          {showHistory &&
            chain.map((h) => (
              <div key={h.id} className="mfact__old">
                <div className="mfact__old-text selectable">{h.text}</div>
                <div className="mfact__meta">
                  <ProvenanceChips provenance={h.provenance} at={h.createdAt} unattributed={h.unattributed} compact />
                  <span className="flex1" />
                  <button type="button" className="link-btn" onClick={async () => done(await mutate({ op: 'restore', target: 'fact', ids: [h.id] }, 'Restore'))}>
                    Restore
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
