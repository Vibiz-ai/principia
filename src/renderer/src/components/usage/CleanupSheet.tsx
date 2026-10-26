/**
 * USAGE.md §3: Clean Up…. Things Principia created that can go: worktrees of finished runs with nothing to lose, and
 * run logs older than 30 days. A worktree with uncommitted, unpushed or pushed-but-unmerged work is listed greyed with
 * its reason and cannot be picked. Main checks every item again before removing it.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CleanupItem, CleanupResult } from '@shared/usage'
import { bytesLabel, removeLabel } from '../../lib/usage'
import { errorMessage, hive } from '../../lib/hive'
import { companyLabel } from '../../lib/company'
import { tildify } from '../../lib/format'
import { ErrorState, Loading, Sheet } from '../ui'
import { useStore } from '../../state/store'

export function CleanupSheet({ companyId, onClose, onDone }: { companyId?: string; onClose: () => void; onDone: (r: CleanupResult) => void }): React.JSX.Element {
  const companies = useStore((s) => s.companies)
  const [items, setItems] = useState<CleanupItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const load = (): void => {
    setError(null)
    hive.usage.cleanupList().then(
      (list) => {
        const shown = companyId ? list.filter((i) => i.companyId === companyId) : list
        setItems(shown)
        setPicked(new Set(shown.filter((i) => i.selectable).map((i) => i.id)))
      },
      (e) => setError(errorMessage(e))
    )
  }
  useEffect(load, [companyId])
  const chosen = useMemo(() => (items ?? []).filter((i) => picked.has(i.id)), [items, picked])
  const bytes = chosen.reduce((n, i) => n + i.bytes, 0)
  const toggle = (id: string): void =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await hive.usage.cleanup({ ids: chosen.map((i) => i.id) })
      onDone(r)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  const co = (id: string | null): string => {
    const c = id ? companies.find((x) => x.id === id) : undefined
    return c ? companyLabel(c, true) : 'No company'
  }
  return (
    <Sheet
      title="Clean Up"
      onCancel={onClose}
      onPrimary={() => void remove()}
      primaryLabel={busy ? 'Removing…' : removeLabel(chosen.length, bytes)}
      primaryDisabled={busy || chosen.length === 0}
      width={640}
      footerLeft={items && items.length > 0 ? <span className="text-tertiary">Only things Principia created. Your own folders are never touched.</span> : undefined}
    >
      {error ? (
        <ErrorState error={error} onRetry={load} />
      ) : !items ? (
        <Loading label="Checking worktrees…" />
      ) : items.length === 0 ? (
        <div className="cleanup__empty text-secondary">Nothing to clean up. Finished runs already removed their worktrees.</div>
      ) : (
        <ul className="cleanup">
          {items.map((i) => (
            <li key={i.id} className={`cleanup__row ${i.selectable ? '' : 'is-disabled'}`}>
              <label className="cleanup__label" title={i.path}>
                <input type="checkbox" checked={picked.has(i.id)} disabled={!i.selectable || busy} onChange={() => toggle(i.id)} />
                <span className="cleanup__text">
                  <span className="cleanup__title">{i.kind === 'worktree' ? `Worktree · ${i.title}` : i.title}</span>
                  <span className="cleanup__sub">
                    {i.reason && <span className="cleanup__reason">{i.reason} · </span>}
                    {co(i.companyId)} · {tildify(i.path)}
                  </span>
                </span>
                <span className="cleanup__size">{bytesLabel(i.bytes)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
