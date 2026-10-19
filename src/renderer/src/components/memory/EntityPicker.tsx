/** Type-ahead entity picker: entities already on screen first, then memory:search hits. Optionally "Create “x”". */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryEntity, MemoryScopeFilter } from '@shared/memory'
import { fuzzyFilter } from '../../lib/fuzzy'
import { hive } from '../../lib/hive'
import { entityHue } from '../../lib/memory'

export type EntityPick = { entity: MemoryEntity } | { newName: string }

export function EntityPicker({
  candidates,
  scope,
  exclude = [],
  allowNew,
  placeholder = 'Entity name',
  onPick,
  autoFocus,
  allow
}: {
  candidates: MemoryEntity[]
  scope: MemoryScopeFilter['scope']
  exclude?: string[]
  allowNew?: boolean
  placeholder?: string
  onPick: (p: EntityPick | null) => void
  autoFocus?: boolean
  /** Only offer entities this accepts (e.g. the Relate sheet: same repository or global). */
  allow?: (e: MemoryEntity) => boolean
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [remote, setRemote] = useState<MemoryEntity[]>([])
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) return setRemote([])
    const my = ++seq.current
    const t = setTimeout(() => {
      hive.memory.search({ scope, query, limit: 10 }).then(
        (hits) => my === seq.current && setRemote(hits.map((h) => h.entity)),
        () => undefined
      )
    }, 150)
    return () => clearTimeout(t)
  }, [q, scope])

  const items = useMemo(() => {
    const seen = new Set<string>(exclude)
    const all: MemoryEntity[] = []
    for (const e of [...candidates, ...remote]) {
      if (seen.has(e.id) || (allow && !allow(e))) continue
      seen.add(e.id)
      all.push(e)
    }
    const list = q.trim() ? fuzzyFilter(all, q, (e) => `${e.name} ${e.aliases.join(' ')}`, 8) : all.slice(0, 8)
    const exact = list.some((e) => e.name.toLowerCase() === q.trim().toLowerCase())
    return { list, offerNew: !!allowNew && q.trim().length > 0 && !exact }
  }, [candidates, remote, q, exclude, allowNew, allow])
  const count = items.list.length + (items.offerNew ? 1 : 0)
  useEffect(() => setSel(0), [q])

  const choose = (i: number): void => {
    const e = items.list[i]
    if (e) {
      setPicked(e.name)
      setQ(e.name)
      onPick({ entity: e })
    } else if (items.offerNew) {
      setPicked(q.trim())
      onPick({ newName: q.trim().slice(0, 120) })
    }
    setOpen(false)
  }

  return (
    <div className="mpick">
      <input
        className="input"
        value={q}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={120}
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
          if (picked !== null) {
            setPicked(null)
            onPick(null)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min(count - 1, s + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(0, s - 1))
          } else if (e.key === 'Enter' && open && count > 0 && picked === null) {
            e.preventDefault()
            e.stopPropagation()
            choose(sel)
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {open && picked === null && count > 0 && (
        <div className="mpick__list popover">
          {items.list.map((e, i) => (
            <div key={e.id} className={`popover__item ${i === sel ? 'is-sel' : ''}`} onMouseDown={(ev) => ev.preventDefault()} onMouseMove={() => setSel(i)} onClick={() => choose(i)}>
              <span className="mnode__dot" style={{ ['--mnode-hue' as string]: entityHue(e.type) }} />
              <span className="mpick__name">{e.name}</span>
              <span className="text-tertiary">{e.type}</span>
              <span className="flex1" />
              <span className="text-tertiary">{e.repoId ? '' : 'global'}</span>
            </div>
          ))}
          {items.offerNew && (
            <div className={`popover__item ${sel === items.list.length ? 'is-sel' : ''}`} onMouseDown={(ev) => ev.preventDefault()} onMouseMove={() => setSel(items.list.length)} onClick={() => choose(items.list.length)}>
              <span className="text-secondary">+ Create “{q.trim()}”</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
