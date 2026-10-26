/**
 * Disk (USAGE.md §3), moved from Usage to Settings › Storage in five doors step 4: what Principia keeps on this Mac
 * per company, with Clean up. Inside a company only its own row shows, plus the Mac's total (leak gate A1: a client's
 * name never shows in another client's Settings); All companies lists every company.
 */
import { useEffect, useState } from 'react'
import type { CleanupResult, DiskUsage } from '@shared/usage'
import { Button, ErrorState, Loading } from '../ui'
import { CleanupSheet } from './CleanupSheet'
import { bytesLabel } from '../../lib/usage'
import { companyLabel } from '../../lib/company'
import { errorMessage, hive } from '../../lib/hive'
import { CompanyAvatar } from '../../shell/CompanyRail'
import { toast, useStore } from '../../state/store'
import '../../styles/usage.css'

export function DiskSection({ companyId }: { companyId?: string | null }): React.JSX.Element {
  const companies = useStore((s) => s.companies)
  const [disk, setDisk] = useState<DiskUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState(false)
  const load = (fresh = false): void => {
    setError(null)
    hive.usage.disk(fresh ? { fresh } : undefined).then(setDisk, (e) => setError(errorMessage(e)))
  }
  useEffect(() => load(), [])
  const name = (id: string | null): string => {
    const c = id ? companies.find((x) => x.id === id) : undefined
    return c ? companyLabel(c, true) : id ? 'Archived company' : 'Not filed under a company'
  }
  const done = (r: CleanupResult): void => {
    setCleanup(false)
    toast(r.failed.length ? `Removed ${r.removed}, freed ${bytesLabel(r.freedBytes)}. ${r.failed.length} could not be removed.` : `Removed ${r.removed} item${r.removed === 1 ? '' : 's'}, freed ${bytesLabel(r.freedBytes)}`, r.failed.length ? 'error' : 'info')
    load(true)
  }
  return (
    <div className="sgroup usage__disk usage__disk--settings">
      <div className="sgroup__title">
        Disk{disk && <span className="usage__disk-total">{bytesLabel(disk.total)}{disk.partial ? ' (at least)' : ''}</span>}
        <span className="flex1" />
        <Button size="sm" onClick={() => setCleanup(true)}>
          Clean up…
        </Button>
      </div>
      {error && !disk ? (
        <ErrorState error={error} onRetry={() => load(true)} />
      ) : !disk ? (
        <Loading label="Measuring…" />
      ) : (companyId ? disk.companies.filter((c) => c.companyId === companyId) : disk.companies).length === 0 ? (
        <div className="text-tertiary usage__disk-empty">Principia keeps nothing on disk yet.</div>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Company</th>
              <th className="num">Agent folders</th>
              <th className="num">Files</th>
              <th className="num">Logs</th>
              <th className="num">Company folder</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {(companyId ? disk.companies.filter((c) => c.companyId === companyId) : disk.companies).map((c) => {
              const co = c.companyId ? companies.find((x) => x.id === c.companyId) : undefined
              return (
                <tr key={c.companyId ?? 'none'}>
                  <td>
                    <span className="usage-co">
                      {c.companyId && <CompanyAvatar company={{ id: co?.id, name: name(c.companyId), color: co?.color ?? 'var(--series-other)', railLabel: co?.railLabel }} size={16} />}
                      <span>{name(c.companyId)}</span>
                    </span>
                  </td>
                  <td className="num">{c.byKind.worktrees ? bytesLabel(c.byKind.worktrees) : '—'}</td>
                  <td className="num">{c.byKind.artifacts ? bytesLabel(c.byKind.artifacts) : '—'}</td>
                  <td className="num">{c.byKind.logs ? bytesLabel(c.byKind.logs) : '—'}</td>
                  <td className="num">{c.byKind.company ? bytesLabel(c.byKind.company) : '—'}</td>
                  <td className="num strong">{bytesLabel(c.bytes)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {disk && companyId && <div className="srow"><div className="srow__desc">All your companies together: {bytesLabel(disk.total)}. Open Storage in All companies to see each one.</div></div>}
      {cleanup && <CleanupSheet companyId={companyId ?? undefined} onClose={() => setCleanup(false)} onDone={done} />}
    </div>
  )
}
