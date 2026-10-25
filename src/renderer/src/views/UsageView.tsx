/**
 * USAGE.md: one honest page of what agents cost (per day, company, department and agent seat) and what Principia keeps
 * on disk. Reported cost first, estimates marked "~", tokens with no price marked "—". Plan limits only when the engine
 * saw one. The page's one button is Clean Up….
 */
import { useEffect, useMemo, useState } from 'react'
import type { CleanupResult, DiskUsage, UsageRange, UsageRow, UsageSummary } from '@shared/usage'
import { Button, EmptyState, ErrorState, Loading, Segmented, Toolbar } from '../components/ui'
import { useScope } from '../components/CompanyChip'
import { CompanyAvatar } from '../shell/CompanyRail'
import { UsageChart } from '../components/usage/UsageChart'
import { CleanupSheet } from '../components/usage/CleanupSheet'
import { bytesLabel, moneyLabel, moneyTitle, tokenLabel, type UsageMetric } from '../lib/usage'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { absolute } from '../lib/time'
import { companyLabel } from '../lib/company'
import { loadJson, navigate, saveJson, toast, useStore } from '../state/store'
import '../styles/usage.css'

const RANGES: { value: UsageRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' }
]

export function UsageView(): React.JSX.Element {
  const { scope, nonce } = useScope()
  const companies = useStore((s) => s.companies)
  const [range, setRange] = useState<UsageRange>(() => loadJson('principia.usageRange', '7d'))
  const [metric, setMetric] = useState<UsageMetric>(() => loadJson('principia.usageMetric', 'cost'))
  const [data, setData] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [disk, setDisk] = useState<DiskUsage | null>(null)
  const [diskError, setDiskError] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState(false)

  const load = (): void => {
    setError(null)
    hive.usage.summary({ range, ...(scope ? { companyId: scope } : {}) }).then(setData, (e) => setError(errorMessage(e)))
  }
  const loadDisk = (fresh = false): void => {
    setDiskError(null)
    hive.usage.disk(fresh ? { fresh } : undefined).then(setDisk, (e) => setDiskError(errorMessage(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [range, scope, nonce])
  useEffect(() => loadDisk(), [])
  useHiveEvent('run:updated', (r) => {
    if (r.status !== 'running' && r.status !== 'queued') load()
  })

  const name = (id: string | null): string => {
    const c = id ? companies.find((x) => x.id === id) : undefined
    return c ? companyLabel(c, true) : id ? 'Archived company' : 'No company'
  }
  const diskRows = useMemo(() => (disk ? (scope ? disk.companies.filter((c) => c.companyId === scope) : disk.companies) : []), [disk, scope])
  const diskTotal = diskRows.reduce((n, c) => n + c.bytes, 0)

  const done = (r: CleanupResult): void => {
    setCleanup(false)
    toast(r.failed.length ? `Removed ${r.removed}, freed ${bytesLabel(r.freedBytes)}. ${r.failed.length} could not be removed.` : `Removed ${r.removed} item${r.removed === 1 ? '' : 's'}, freed ${bytesLabel(r.freedBytes)}`, r.failed.length ? 'error' : 'info')
    loadDisk(true)
  }

  return (
    <div className="view">
      <Toolbar title="Spend">
        <Segmented
          items={RANGES}
          value={range}
          onChange={(v) => {
            setRange(v)
            saveJson('principia.usageRange', v)
          }}
        />
        <Segmented
          items={[
            { value: 'tokens', label: 'Tokens' },
            { value: 'cost', label: 'Cost' }
          ]}
          value={metric}
          onChange={(v) => {
            setMetric(v)
            saveJson('principia.usageMetric', v)
          }}
        />
      </Toolbar>
      <div className="scroll view__body">
        <div className="usage">
          {error && !data ? (
            <ErrorState error={error} onRetry={load} />
          ) : !data ? (
            <Loading />
          ) : (
            <>
              <div className="usage__total">
                <div className="usage__stat">
                  <span className="usage__stat-val" title={moneyTitle(data.total)}>
                    {moneyLabel(data.total)}
                  </span>
                  <span className="usage__stat-label">cost</span>
                </div>
                <div className="usage__stat">
                  <span className="usage__stat-val">{tokenLabel(data.total.tokensIn + data.total.tokensOut)}</span>
                  <span className="usage__stat-label">tokens</span>
                </div>
                <div className="usage__stat">
                  <span className="usage__stat-val">{data.total.agents}</span>
                  <span className="usage__stat-label">agent runs</span>
                </div>
              </div>
              <UsageChart days={data.days} metric={metric} />
              <div className="usage__limits">
                {data.limits.state === 'seen' && data.limits.lastHitAt ? (
                  <>
                    Last limit hit: {absolute(data.limits.lastHitAt)}, reset {data.limits.resetAt ? absolute(data.limits.resetAt) : 'time unknown'}
                    {data.limits.source?.runId && (
                      <button type="button" className="link-btn" onClick={() => void navigate({ name: 'run', runId: data.limits.source!.runId! })}>
                        Open run
                      </button>
                    )}
                  </>
                ) : (
                  'Plan limits: Unknown. Claude Code does not report them locally.'
                )}
              </div>
              {data.total.agents === 0 ? (
                <EmptyState compact icon="coins" text="No agent usage in this range yet." />
              ) : (
                <div className="usage__tables">
                  {!scope && <UsageTable title="By company" rows={data.byCompany} company={(r) => r.companyId} name={name} />}
                  <UsageTable title="By department" rows={data.byDepartment} company={(r) => (scope ? null : r.companyId)} name={name} />
                  <UsageTable title="By agent" rows={data.byAgent} company={(r) => (scope ? null : r.companyId)} name={name} />
                </div>
              )}
              <div className="usage__foot text-tertiary">
                $ is what the CLI reported; ~$ is estimated from {data.priceSource}; — means tokens with no price (a small dashed mark on the chart). Subscription plans bill the plan; this is what it would cost on the API.
              </div>
            </>
          )}

          <section className="usage__disk">
            <div className="usage__disk-head">
              <span className="usage__h">Disk</span>
              {disk && <span className="text-secondary">{bytesLabel(diskTotal)}{disk.partial ? ' (at least)' : ''}</span>}
              <span className="flex1" />
              <Button onClick={() => setCleanup(true)}>Clean Up…</Button>
            </div>
            {diskError && !disk ? (
              <ErrorState error={diskError} onRetry={() => loadDisk(true)} />
            ) : !disk ? (
              <Loading label="Measuring…" />
            ) : diskRows.length === 0 ? (
              <div className="text-tertiary usage__disk-empty">Principia keeps nothing on disk for {scope ? 'this company' : 'your companies'} yet.</div>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th className="num">Worktrees</th>
                    <th className="num">Artifacts</th>
                    <th className="num">Logs</th>
                    <th className="num">Company folder</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {diskRows.map((c) => (
                    <tr key={c.companyId ?? 'none'}>
                      <td>
                        <CompanyCell id={c.companyId} name={name} />
                      </td>
                      <td className="num">{c.byKind.worktrees ? bytesLabel(c.byKind.worktrees) : '—'}</td>
                      <td className="num">{c.byKind.artifacts ? bytesLabel(c.byKind.artifacts) : '—'}</td>
                      <td className="num">{c.byKind.logs ? bytesLabel(c.byKind.logs) : '—'}</td>
                      <td className="num">{c.byKind.company ? bytesLabel(c.byKind.company) : '—'}</td>
                      <td className="num strong">{bytesLabel(c.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {disk && <div className="text-tertiary usage__foot">Worktrees, artifacts, logs and company folders Principia created. Your repositories and ~/.claude are not counted.</div>}
          </section>
        </div>
      </div>
      {cleanup && <CleanupSheet companyId={scope} onClose={() => setCleanup(false)} onDone={done} />}
    </div>
  )
}

function CompanyCell({ id, name }: { id: string | null; name: (id: string | null) => string }): React.JSX.Element {
  const companies = useStore((s) => s.companies)
  const c = id ? companies.find((x) => x.id === id) : undefined
  return (
    <span className="usage-co">
      {id && <CompanyAvatar company={{ id: c?.id, name: name(id), color: c?.color ?? 'var(--series-other)' }} size={16} />}
      <span>{name(id)}</span>
    </span>
  )
}

function UsageTable({ title, rows, company, name }: { title: string; rows: UsageRow[]; company: (r: UsageRow) => string | null; name: (id: string | null) => string }): React.JSX.Element {
  return (
    <section className="usage__table">
      <div className="usage__h">{title}</div>
      <table className="usage-table">
        <thead>
          <tr>
            <th>{title.replace('By ', '').replace(/^./, (c) => c.toUpperCase())}</th>
            <th className="num">Runs</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const co = company(r)
            return (
              <tr key={r.key}>
                <td>
                  <span className="usage-co">
                    {co && title !== 'By company' && <span className="text-tertiary usage-co__of">{name(co)} ·</span>}
                    {title === 'By company' ? <CompanyCell id={r.companyId} name={name} /> : <span>{r.label}</span>}
                  </span>
                </td>
                <td className="num">{r.agents}</td>
                <td className="num">{tokenLabel(r.tokensIn + r.tokensOut)}</td>
                <td className="num" title={moneyTitle(r)}>
                  {moneyLabel(r)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
