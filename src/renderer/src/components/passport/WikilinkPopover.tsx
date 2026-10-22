/** The source editor's `[[` and `#` suggestions (PASSPORT.md §10): titles, aliases, ghosts, a new link, or tags. */
import { useEffect, useRef } from 'react'
import type { CompletionItem } from '../../lib/passport'

const KIND_GLYPH: Record<CompletionItem['kind'], string> = { note: '◇', alias: '↪', ghost: '◌', tag: '#', new: '+' }

export function WikilinkPopover({
  items,
  selected,
  at,
  onPick,
  onHover
}: {
  items: CompletionItem[]
  selected: number
  /** position inside the editor's scroll container */
  at: { left: number; top: number }
  onPick: (item: CompletionItem) => void
  onHover: (index: number) => void
}): React.JSX.Element | null {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  if (!items.length) return null
  return (
    <div className="pwl" style={{ left: at.left, top: at.top }} ref={list} role="listbox">
      {items.map((it, i) => (
        <div
          key={`${it.kind}:${it.insert}`}
          role="option"
          aria-selected={i === selected}
          className={`pwl__item pwl__item--${it.kind} ${i === selected ? 'is-sel' : ''}`}
          onMouseDown={(e) => {
            // keep the textarea focused
            e.preventDefault()
            onPick(it)
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="pwl__glyph" aria-hidden>
            {KIND_GLYPH[it.kind]}
          </span>
          <span className="pwl__label">{it.label}</span>
          <span className="pwl__detail">{it.detail}</span>
        </div>
      ))}
    </div>
  )
}
