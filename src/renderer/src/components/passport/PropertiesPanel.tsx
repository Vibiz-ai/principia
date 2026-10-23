/**
 * Properties (PASSPORT.md §10 right column): the note's frontmatter as typed fields. Link-valued properties
 * (`company`, `repos`, `owner`, any `"[[X]]"`) are note pickers; expected-but-missing fields from the type's schema
 * hints are offered, never required. Every change is one `setProperty` writer op, so unknown YAML stays untouched.
 */
import { useEffect, useId, useState } from 'react'
import type { VaultNoteDetail, VaultOp, VaultPropertyValue } from '@shared/passport'
import { NOTE_TYPES } from '@shared/vault/grammar'
import { IconButton, Switch } from '../ui'
import { linkValueTitle, missingProperties, propertyKind, SYSTEM_PROPERTIES, toLinkValue, type TreeNote } from '../../lib/passport'

export function PropertiesPanel({
  detail,
  tree,
  onOps,
  readOnly
}: {
  detail: VaultNoteDetail
  tree: TreeNote[]
  onOps: (ops: VaultOp[]) => Promise<boolean>
  readOnly?: boolean
}): React.JSX.Element {
  const note = detail.note
  const listId = useId()
  const [adding, setAdding] = useState<string | null>(null)
  const props = detail.properties
  const set = (key: string, value: VaultPropertyValue): void => void onOps([{ op: 'setProperty', note: note.id, key, value }])
  const keys = Object.keys(props).filter((k) => !SYSTEM_PROPERTIES.has(k))
  const missing = missingProperties(note.type, props)

  return (
    <div className="pprops">
      <datalist id={listId}>
        {tree.map((t) => (
          <option key={t.id} value={t.title} />
        ))}
      </datalist>
      <PropRow label="type">
        <select className="input input--sm" value={note.type} disabled={readOnly} onChange={(e) => set('type', e.target.value)}>
          {[...new Set([...NOTE_TYPES, note.type])].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </PropRow>
      {keys
        .filter((k) => k !== 'type')
        .map((k) => (
          <PropRow key={k} label={k}>
            <PropField name={k} value={props[k] ?? null} listId={listId} readOnly={readOnly} onChange={(v) => set(k, v)} />
          </PropRow>
        ))}
      {adding !== null && (
        <PropRow label={<input className="input input--sm" autoFocus placeholder="name" value={adding} onChange={(e) => setAdding(e.target.value.replace(/[^\w-]/g, ''))} />}>
          <input
            className="input input--sm"
            placeholder="value, or [[Note]]"
            list={listId}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAdding(null)
              if (e.key !== 'Enter' || !adding) return
              const raw = e.currentTarget.value.trim()
              const link = /^\[\[.*\]\]$/.test(raw) ? raw : tree.some((t) => t.title === raw) && ['company', 'owner'].includes(adding) ? toLinkValue(raw) : null
              set(adding, raw === 'true' ? true : raw === 'false' ? false : (link ?? raw))
              setAdding(null)
            }}
          />
        </PropRow>
      )}
      {missing.length > 0 && !readOnly && (
        <div className="pprops__hints">
          {missing.map((k) => (
            <button key={k} type="button" className="pprops__hint" title={`Notes of type ${note.type} usually have “${k}”`} onClick={() => setAdding(k)}>
              + {k}
            </button>
          ))}
        </div>
      )}
      {!readOnly && adding === null && (
        <button type="button" className="pprops__add" onClick={() => setAdding('')}>
          + Add property
        </button>
      )}
      {detail.parseWarnings.length > 0 && (
        <div className="pprops__warn" title={detail.parseWarnings.join('\n')}>
          This note didn’t parse cleanly, so Principia treats it as prose and never rewrites it.
        </div>
      )}
    </div>
  )
}

function PropRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pprops__row">
      <span className="pprops__key">{label}</span>
      <div className="pprops__val">{children}</div>
    </div>
  )
}

function PropField({ name, value, listId, readOnly, onChange }: { name: string; value: VaultPropertyValue; listId: string; readOnly?: boolean; onChange: (v: VaultPropertyValue) => void }): React.JSX.Element {
  const kind = propertyKind(name, value)
  if (kind === 'checkbox') return <Switch checked={value === true} disabled={readOnly} onChange={(v) => onChange(v)} label={name} />
  if (kind === 'link') return <LinkPicker value={typeof value === 'string' ? (linkValueTitle(value) ?? value) : ''} listId={listId} readOnly={readOnly} onCommit={(t) => onChange(t ? toLinkValue(t) : null)} />
  if (kind === 'links') {
    const items = (Array.isArray(value) ? value : []).map((v) => linkValueTitle(v) ?? v)
    return (
      <div className="pprops__chips">
        {items.map((t, i) => (
          <span key={`${t}:${i}`} className="pprops__chip">
            {t}
            {!readOnly && <IconButton icon="close" label={`Remove ${t}`} onClick={() => onChange(items.filter((_, j) => j !== i).map(toLinkValue))} />}
          </span>
        ))}
        {!readOnly && <LinkPicker value="" listId={listId} placeholder="Add…" onCommit={(t) => t && onChange([...items, t].map(toLinkValue))} />}
      </div>
    )
  }
  if (kind === 'list') {
    return <TextCommit value={(Array.isArray(value) ? value : []).join(', ')} readOnly={readOnly} onCommit={(s) => onChange(s.split(',').map((x) => x.trim()).filter(Boolean))} />
  }
  if (kind === 'number') return <TextCommit value={String(value ?? '')} readOnly={readOnly} onCommit={(s) => onChange(s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : s)} />
  if (kind === 'date') return <TextCommit type="date" value={String(value ?? '')} readOnly={readOnly} onCommit={(s) => onChange(s || null)} />
  return <TextCommit value={value === null ? '' : String(value)} readOnly={readOnly} onCommit={(s) => onChange(s)} />
}

/** Commits on Enter or blur, only when changed. */
function TextCommit({ value, onCommit, readOnly, type = 'text', list, placeholder }: { value: string; onCommit: (v: string) => void; readOnly?: boolean; type?: string; list?: string; placeholder?: string }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft === value) return
    onCommit(draft)
    // an "add" field starts empty again
    if (!value) setDraft('')
  }
  return (
    <input
      className="input input--sm"
      type={type}
      value={draft}
      list={list}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

function LinkPicker({ value, listId, onCommit, readOnly, placeholder = 'Pick a note…' }: { value: string; listId: string; onCommit: (title: string) => void; readOnly?: boolean; placeholder?: string }): React.JSX.Element {
  return <TextCommit value={value} list={listId} placeholder={placeholder} readOnly={readOnly} onCommit={(s) => onCommit(s.replace(/^\[\[|\]\]$/g, '').trim())} />
}
