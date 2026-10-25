/** Home › "Recent Claude sessions outside Principia" (AUTHORING.md §8.5): last 7 days, up to 8 rows, "Show all" sheet. */
import { useMemo, useState } from 'react'
import type { ClaudeHistorySession } from '@shared/authoring'
import { Button, RelativeTime, SectionHeader, Sheet } from '../ui'
import { historyInScope, historyMeta, historyPlace, matchHistory, recentOutside } from '../../lib/authoring'
import { companyOf, isPersonal } from '../../lib/company'
import { useClaudeHistory } from '../../state/history'
import { TranscriptSheet } from '../history/TranscriptSheet'
import { scopeCompanyId, useStore } from '../../state/store'

const WEEK = 7 * 86_400_000

export function ClaudeHistorySection(): React.JSX.Element | null {
  const since = useMemo(() => new Date(Date.now() - WEEK).toISOString(), [])
  const h = useClaudeHistory({ since, limit: 200 })
  const repos = useStore((s) => s.repos)
  const scope = useStore((s) => scopeCompanyId(s))
  const personal = useStore((s) => !!scope && s.companies.some((c) => c.id === scope && isPersonal(c)))
  const [open, setOpen] = useState<ClaudeHistorySession | null>(null)
  const [all, setAll] = useState(false)
  // only this company's folders (A1: never another client's session on this Home)
  const items = useMemo(() => historyInScope(h.items, scope, repos, companyOf, personal), [h.items, scope, repos, personal])
  if (h.available === false) return null
  const rows = recentOutside(items, Date.now())
  if (h.available === null || (!rows.length && !h.indexing)) return null
  return (
    <>
      <SectionHeader title="Recent Claude sessions outside Principia" count={scope ? rows.length || undefined : h.total > rows.length ? h.total : rows.length || undefined}>
        {h.indexing && <span className="text-tertiary">indexing…</span>}
        {items.filter((x) => !x.inHive).length > rows.length && (
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            Show all
          </Button>
        )}
      </SectionHeader>
      <div className="group-list hist-list">
        {rows.map((s) => (
          <HistoryRow key={s.id} s={s} place={historyPlace(s, repos)} onOpen={() => setOpen(s)} />
        ))}
      </div>
      {open && <TranscriptSheet session={open} onClose={() => setOpen(null)} />}
      {all && !open && <AllHistorySheet items={items.filter((x) => !x.inHive)} onOpen={setOpen} onClose={() => setAll(false)} />}
    </>
  )
}

export function HistoryRow({ s, place, onOpen }: { s: ClaudeHistorySession; place: string; onOpen: () => void }): React.JSX.Element {
  const meta = historyMeta(s)
  return (
    <button type="button" className="hist-row" onClick={onOpen} title={`${s.title}\n${s.cwd ?? ''}\nClick to preview (read-only)`}>
      <span className="hist-row__title">{s.title || 'Untitled'}</span>
      <span className="hist-row__place text-secondary">{place}</span>
      {meta && <span className="hist-row__meta text-tertiary">{meta}</span>}
      {s.model && <span className="mchip mchip--mini">{s.model.replace(/^claude-/, '')}</span>}
      <span className="hist-row__time text-tertiary">
        <RelativeTime iso={s.endedAt ?? s.startedAt} />
      </span>
    </button>
  )
}

function AllHistorySheet({ items, onOpen, onClose }: { items: ClaudeHistorySession[]; onOpen: (s: ClaudeHistorySession) => void; onClose: () => void }): React.JSX.Element {
  const repos = useStore((s) => s.repos)
  const [q, setQ] = useState('')
  const shown = items.filter((x) => matchHistory(x, q))
  return (
    <Sheet title="Claude sessions outside Principia" onCancel={onClose} width={720}>
      <input className="input" placeholder="Search titles, folders, branches" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="group-list hist-list hist-list--sheet scroll">
        {shown.length === 0 && <div className="text-tertiary hist-empty">No matches.</div>}
        {shown.map((s) => (
          <HistoryRow key={s.id} s={s} place={historyPlace(s, repos)} onOpen={() => onOpen(s)} />
        ))}
      </div>
    </Sheet>
  )
}
