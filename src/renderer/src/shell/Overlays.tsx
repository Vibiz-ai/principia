import { useState } from 'react'
import { Sheet } from '../components/ui'
import { addRepoPaths, setState, useStore } from '../state/store'

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.kind === 'error' ? '✕ ' : ''}
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** After adding the first repo: offer its sibling git folders (one checkbox list). */
export function SiblingOffer(): React.JSX.Element | null {
  const offer = useStore((s) => s.siblingOffer)
  const [checked, setChecked] = useState<Set<string> | null>(null)
  if (!offer) return null
  const sel = checked ?? new Set(offer.items.map((i) => i.path))
  const close = (): void => {
    setChecked(null)
    setState({ siblingOffer: null })
  }
  return (
    <Sheet
      title={`Also add folders next to ${offer.repo.name}?`}
      onCancel={close}
      primaryLabel={`Add ${sel.size}`}
      primaryDisabled={sel.size === 0}
      onPrimary={() => {
        const paths = [...sel]
        close()
        void addRepoPaths(paths)
      }}
    >
      <div className="env-list">
        {offer.items.map((i) => (
          <label key={i.path} className="env-row">
            <input
              type="checkbox"
              checked={sel.has(i.path)}
              onChange={() => {
                const x = new Set(sel)
                if (x.has(i.path)) x.delete(i.path)
                else x.add(i.path)
                setChecked(x)
              }}
            />
            <span>{i.name}</span>
            <span className="text-tertiary mono env-row__path">{i.path}</span>
          </label>
        ))}
      </div>
    </Sheet>
  )
}
