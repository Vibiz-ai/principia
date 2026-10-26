/**
 * Spend (five doors step 4, design §4.9, pm-review B5): plan use first. A plan user reads one money line, "Included in
 * your plan. Nothing extra to pay.", and the pay-as-you-go dollars sit behind "Show value in $" (on by default only
 * for a Claude sign-in that bills per use). Every run is counted, your own chats included; each table ends in a total
 * row and the line under it is that same total. Plan limits are said honestly: Claude doesn't report them yet, so no
 * percentage is ever made up. Disk moved to Settings › Storage. In All companies the table lists every company.
 */
import { useEffect, useMemo, useState } from 'react'
import type { UsageBucket, UsageRow, UsageSummary } from '@shared/usage'
import { capError, capLine, dollars, heroCount, formatCap, parseCap, rowsCsv, runsLine, withTotal } from '@shared/spend'
import { claudePlanLabel, onPlan } from '@shared/providerAuth'
import { Button, ErrorState, Loading, Segmented, Switch, Toolbar } from '../components/ui'
import { Icon } from '../components/Icon'
import { useScope } from '../components/CompanyChip'
import { CompanyAvatar } from '../shell/CompanyRail'
import { tokenLabel } from '../lib/usage'
import { errorMessage, hive, useHiveEvent } from '../lib/hive'
import { absolute } from '../lib/time'
import { companyLabel } from '../lib/company'
import { useClaudeAuth } from '../state/claudeAuth'
import { loadJson, navigate, saveJson, toast, updateCompany, useStore } from '../state/store'
import '../styles/usage.css'
import '../styles/settings5.css'

type Span = 'week' | 'month'
const monthName = (d = new Date()): string => d.toLocaleString('en-US', { month: 'long' })

export function UsageView({ cap: capAsk }: { cap?: number } = {}): React.JSX.Element {
  const { scope, company, nonce } = useScope()
  const companies = useStore((s) => s.companies)
  const { auth } = useClaudeAuth()
  const billedPerUse = onPlan(auth) === false
  const [span, setSpan] = useState<Span>(() => loadJson<Span>('principia.spendSpan', 'week'))
  const [showUsd, setShowUsd] = useState<boolean | null>(() => loadJson<boolean | null>('principia.spendUsd', null))
  const usd = showUsd ?? billedPerUse
  // a card's "Set a cap" lands here with the cap editor open: the cap is a $ figure, so the $ view comes on with it
  const [capEdit, setCapEdit] = useState(0)
  const openCap = (): void => {
    setShowUsd(true)
    saveJson('principia.spendUsd', true)
    setCapEdit(Date.now())
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (capAsk) openCap() }, [capAsk])
  const [week, setWeek] = useState<UsageSummary | null>(null)
  const [month, setMonth] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = (): void => {
    setError(null)
    const q = scope ? { companyId: scope } : {}
    void Promise.all([hive.usage.summary({ range: 'week', ...q }), hive.usage.summary({ range: 'month', ...q })]).then(
      ([w, m]) => (setWeek(w), setMonth(m)),
      (e) => setError(errorMessage(e))
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [scope, nonce])
  useHiveEvent('run:updated', (r) => {
    if (r.status !== 'running' && r.status !== 'queued') load()
  })
  const data = span === 'week' ? week : month
  const paused = company?.pausedAt ?? null
  const cap = company?.monthlyCap ?? null
  const name = (id: string | null): string => {
    const c = id ? companies.find((x) => x.id === id) : undefined
    return c ? companyLabel(c, true) : id ? 'Archived company' : 'No company'
  }
  // All companies: every company is a row, $0 included (design §4.8)
  const byCompany = useMemo<UsageRow[]>(() => {
    if (scope || !data) return []
    const empty = (): UsageBucket => ({ usd: null, estimated: false, unpriced: false, tokensIn: 0, tokensOut: 0, agents: 0 })
    const known = companies.filter((c) => !c.archivedAt).map<UsageRow>((c) => data.byCompany.find((r) => r.companyId === c.id) ?? { key: c.id, label: c.name, companyId: c.id, ...empty() })
    return [...known, ...data.byCompany.filter((r) => !known.some((k) => k.key === r.key))]
  }, [scope, data, companies])
  const chatsOf = (d: UsageSummary | null): number => (d ? d.byAgent.filter((r) => r.key.startsWith('none:session')).reduce((n, r) => n + r.agents, 0) : 0)
  const chats = useMemo(() => chatsOf(data), [data])
  const monthChats = useMemo(() => chatsOf(month), [month])
  const weekChats = useMemo(() => chatsOf(week), [week])
  const exportCsv = (): void => {
    if (!data) return
    const rows = scope ? data.byAgent : byCompany
    const blob = new Blob([rowsCsv(rows, scope ? 'Agent' : 'Company')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(company?.slug ?? 'all-companies').replace(/[^a-z0-9-]/gi, '-')}-${span === 'week' ? 'this-week' : monthName().toLowerCase()}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast('Spend exported as CSV')
  }
  const spanLabel = span === 'week' ? 'this week' : monthName()
  // the hero's sentence: "… in Northwind this week", "… in Northwind in October", "… across your companies in October"
  const heroWhen = span === 'week' ? 'this week' : `in ${monthName()}`

  return (
    <div className="view">
      <Toolbar title="Spend" sub={<span className="company-toolbar-meta">{company ? company.name : 'All companies'}</span>}>
        <Segmented<Span>
          items={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' }
          ]}
          value={span}
          onChange={(v) => (setSpan(v), saveJson('principia.spendSpan', v))}
        />
        <label className="spend5-usd">
          <span>Show value in $</span>
          <Switch checked={usd} onChange={(v) => (setShowUsd(v), saveJson('principia.spendUsd', v))} label="Show value in $" />
        </label>
        <Button icon="download" onClick={exportCsv} disabled={!data}>
          Export CSV
        </Button>
      </Toolbar>
      <div className="scroll view__body">
        <div className="spend5">
          {error && !data ? (
            <ErrorState error={error} onRetry={load} />
          ) : !data || !month ? (
            <Loading />
          ) : (
            <>
              <section className="spend5-hero" aria-label="Your Claude plan">
                <div className="spend5-hero__kicker">YOUR CLAUDE PLAN · {span === 'week' ? 'THIS WEEK' : monthName().toUpperCase()}</div>
                <div className="spend5-hero__big">
                  <span className="spend5-hero__n">{heroCount(data.total.agents, chats).n}</span>
                  <span className="spend5-hero__of">
                    {heroCount(data.total.agents, chats).of} {company ? `in ${company.name.split(/\s+/)[0]}` : 'across your companies'} {heroWhen}
                    {paused ? `. Paused since ${new Date(paused).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                  </span>
                </div>
                {auth && (auth.state === 'signedOut' || auth.state === 'missing') ? (
                  <div className="spend5-hero__line">
                    <Icon name="warning" size={14} />
                    <b>{auth.state === 'missing' ? 'Claude Code isn’t installed on this Mac.' : 'Claude isn’t signed in on this Mac.'}</b>
                    <span className="text-secondary"> Agents can’t start until it is.</span>
                    <button type="button" className="link-btn" onClick={() => void navigate({ name: 'settings', section: 'providers', nonce: Date.now() })}>
                      Sign in or get a plan →
                    </button>
                  </div>
                ) : billedPerUse ? (
                  <div className="spend5-hero__line">
                    <Icon name="coins" size={14} />
                    <b>Billed per use by Anthropic: {dollars(data.total)} {spanLabel}.</b>
                    <span className="text-secondary"> Claude is signed in with an API key, so each run costs what it says here.</span>
                  </div>
                ) : (
                  <div className="spend5-hero__line">
                    <Icon name="check" size={14} />
                    <b>Included in your {claudePlanLabel(auth?.plan) ?? 'Claude plan'}. Nothing extra to pay.</b>
                    <span className="text-secondary"> Principia adds nothing on top.</span>
                  </div>
                )}
                <div className="spend5-hero__limits text-tertiary">
                  {data.limits.state === 'seen' && data.limits.lastHitAt ? (
                    <>
                      An agent last hit the plan’s limit {absolute(data.limits.lastHitAt)}; it reset {data.limits.resetAt ? absolute(data.limits.resetAt) : 'at a time Claude didn’t say'}.
                      {data.limits.source?.runId && (
                        <>
                          {' '}
                          <button type="button" className="link-btn" onClick={() => void navigate({ name: 'run', runId: data.limits.source!.runId! })}>
                            Open that run
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    'Claude doesn’t report plan limits yet, so there is no percentage here. If an agent hits the limit, it shows in Needs you with the reset time.'
                  )}
                </div>
              </section>

              {usd && (
                <>
                  <div className="spend5-tiles">
                    <div className="spend5-tile">
                      <div className="spend5-tile__l">Pay-as-you-go value · this week</div>
                      <div className="spend5-tile__v">{dollars(week?.total)}</div>
                      <div className="spend5-tile__d">{runsLine(week?.total.agents ?? 0, weekChats)}</div>
                    </div>
                    <div className="spend5-tile">
                      <div className="spend5-tile__l">Pay-as-you-go value · {monthName()}</div>
                      <div className="spend5-tile__v">{dollars(month.total)}</div>
                      <div className="spend5-tile__d">{runsLine(month.total.agents, monthChats)} · {paused ? 'all before the pause' : 'month to date'}</div>
                    </div>
                    {company && <CapTile companyId={company.id} cap={cap} monthUsd={month.total.usd} personal={company.system === 'personal'} open={capEdit} />}
                  </div>
                  <p className="spend5-explain text-tertiary">
                    What’s “pay-as-you-go value”? It’s what the same work would cost if you paid Claude per use instead of a plan. Use it to compare agents, or to bill a client. ~ means part of it is estimated from Anthropic’s list prices.
                  </p>
                </>
              )}
              {!usd && cap && company && <p className="spend5-explain text-tertiary">{capLine(month.total.usd, cap).text.replace('Cap', 'Monthly cap')}. {company.name} pauses when this month’s pay-as-you-go value reaches it.</p>}
              {!usd && !cap && company && company.system !== 'personal' && (
                <p className="spend5-explain text-tertiary">
                  No monthly cap.{' '}
                  <button type="button" className="link-btn" onClick={openCap}>
                    Set a cap
                  </button>{' '}
                  (in pay-as-you-go $, so the value in $ turns on).
                </p>
              )}

              {scope ? (
                <>
                  <SpendTable title={`By agent · ${spanLabel}`} what="Agent" rows={data.byAgent} usd={usd} />
                  <SpendTable title={`By department · ${spanLabel}`} what="Department" rows={data.byDepartment} usd={usd} />
                </>
              ) : (
                <SpendTable title={`By company · ${spanLabel}`} what="Company" rows={byCompany} usd={usd} company={(r) => r.companyId} name={name} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Monthly cap (design §4.9): None · Set a cap, or "$25 · 24% used · agents pause at the cap". */
function CapTile({ companyId, cap, monthUsd, personal, open }: { companyId: string; cap: number | null; monthUsd: number | null; personal: boolean; open?: number }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState('')
  const parsed = parseCap(v)
  const problem = capError(v)
  // a card's "Set a cap" (or the line shown while $ is off) opens the editor with the cursor in it
  useEffect(() => {
    if (!open || personal) return
    setV(cap ? String(cap) : '')
    setEditing(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const save = async (next: number | null): Promise<void> => {
    const r = await updateCompany(companyId, { monthlyCap: next })
    if (r) {
      setEditing(false)
      toast(next ? `Cap set: $${formatCap(next)} a month` : 'Cap removed')
    }
  }
  const line = capLine(monthUsd, cap)
  return (
    <div className="spend5-tile">
      <div className="spend5-tile__l">Monthly cap</div>
      {editing ? (
        <form
          className="spend5-cap"
          onSubmit={(e) => {
            e.preventDefault()
            if (parsed) void save(parsed)
          }}
        >
          <span className="spend5-cap__dollar">$</span>
          <input className="input" autoFocus inputMode="decimal" placeholder="60" value={v} onChange={(e) => setV(e.target.value)} aria-label="Monthly cap in dollars" />
          <Button size="sm" variant="primary" type="submit" disabled={!parsed}>
            Set
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {problem && (
            <span className="spend5-cap__err" role="alert">
              {problem}
            </span>
          )}
        </form>
      ) : (
        <div className="spend5-tile__v">{cap ? `$${formatCap(cap)}` : 'None'}</div>
      )}
      <div className="spend5-tile__d">
        {personal ? (
          'Personal has no cap.'
        ) : cap ? (
          <>
            {line.pct}% used · agents pause at the cap ·{' '}
            <button type="button" className="link-btn" onClick={() => (setV(String(cap)), setEditing(true))}>
              Change
            </button>{' '}
            ·{' '}
            <button type="button" className="link-btn" onClick={() => void save(null)}>
              Remove
            </button>
          </>
        ) : (
          !editing && (
            <button type="button" className="link-btn" onClick={() => (setV(''), setEditing(true))}>
              Set a cap
            </button>
          )
        )}
      </div>
    </div>
  )
}

function SpendTable({ title, what, rows, usd, company, name }: { title: string; what: string; rows: UsageRow[]; usd: boolean; company?: (r: UsageRow) => string | null; name?: (id: string | null) => string }): React.JSX.Element {
  const companies = useStore((s) => s.companies)
  const { total } = withTotal(rows)
  const max = Math.max(1, ...rows.map((r) => (usd ? (r.usd ?? 0) : r.agents)))
  const share = (r: UsageBucket): number => ((usd ? (r.usd ?? 0) : r.agents) / max) * 100
  return (
    <section className="spend5-table">
      <div className="s5-group__title">{title}</div>
      {rows.length === 0 ? (
        <div className="spend5-empty text-tertiary">No agent work {title.split(' · ')[1] ?? 'yet'}.</div>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>{what}</th>
              <th className="num">Runs</th>
              <th className="num">Tokens</th>
              <th style={{ width: '32%' }} aria-label="Share" />
              {usd && <th className="num">Value</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const co = company?.(r)
              const c = co ? companies.find((x) => x.id === co) : undefined
              return (
                <tr key={r.key}>
                  <td>
                    {company && name ? (
                      <span className="usage-co">
                        <CompanyAvatar company={{ id: c?.id, name: name(co ?? null), color: c?.color ?? 'var(--series-other)', railLabel: c?.railLabel }} size={16} />
                        <span>{name(co ?? null)}</span>
                      </span>
                    ) : (
                      r.label
                    )}
                  </td>
                  <td className="num">{r.agents}</td>
                  <td className="num text-secondary">{tokenLabel(r.tokensIn + r.tokensOut)}</td>
                  <td>
                    <div className="spend5-bar">
                      <i style={{ width: `${share(r)}%` }} />
                    </div>
                  </td>
                  {usd && <td className="num strong">{dollars(r)}</td>}
                </tr>
              )
            })}
            <tr className="spend5-total">
              <td>Total</td>
              <td className="num">{total.agents}</td>
              <td className="num">{tokenLabel(total.tokensIn + total.tokensOut)}</td>
              <td />
              {usd && <td className="num strong">{dollars(total)}</td>}
            </tr>
          </tbody>
        </table>
      )}
    </section>
  )
}
