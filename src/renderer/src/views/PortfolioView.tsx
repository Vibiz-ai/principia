/**
 * Portfolio (COMPANY.md §8.5): Home in All mode. One card per company (status, last runs, repos, runs this week,
 * Passport stats, Enter / New session / Open Passport), then the merged "Needs you across companies" list. Live
 * badges come from the store's agents and asks; counts from company:overview; last runs from one runs:list.
 * DEPARTMENTS.md §9: with departments on, each card adds "3 working · 2 need you · 5 done today" (laneOf) and the
 * Needs you list starts with the board's task items (NeedsYouTasks).
 */
import { AutopilotMark } from '../components/autopilot/AutopilotChip'
import { useEffect, useMemo, useState } from 'react'
import type { CompanyOverview, CompanyPassport } from '@shared/company'
import type { Run } from '@shared/types'
import { CompanyChip } from '../components/CompanyChip'
import { Button, RelativeTime, SectionHeader, Segmented, StatusGlyph, Toolbar, useTick } from '../components/ui'
import { companyLabel, EMPTY_BADGE, isCompanyPaused, isPersonal, reposOf, useCompanyBadges, useLiveItems, useTaskCounts, type CompanyBadge, type LiveItem, type TaskCounts } from '../lib/company'
import { NeedsYouTasks } from '../components/board/NeedsYouTasks'
import { CloudNeedsYou, useCloudNeedsCount } from '../components/cloud/NeedsYou'
import { runTitle } from '../lib/format'
import { runVisual } from '../lib/graph'
import { hive, useHiveEvent } from '../lib/hive'
import { lastRunsByCompany, missionLine, statusLine } from '../lib/scope'
import { useCoalesced } from '../lib/useThrottled'
import { CompanyBadgeMark, RailMark, railLaurel } from '../shell/CompanyRail'
import { companiesHealth } from '../lib/agentHealth'
import { MosaicEmpty } from '../components/roman'
import { NeedsYouEmpty } from '../components/home/DashboardParts'
import { t, useTone } from '../lib/voice'
import { companyContextMenu, departmentsOn, enterCompany, multiCompany, navigate, newSessionMenu, openBoard, openNewChat, openCompanyPassport, openLiveItem, openNewCompany, setCompanyPaused, toast, useStore } from '../state/store'
import { useNeeds } from '../state/live'
import { companySpend, capLine, dollars, spendCsv, type CompanySpend } from '@shared/spend'
import type { UsageSummary } from '@shared/usage'
import { ThingsMovedCard } from '../components/home/FirstRunCards'
import { useThingsMoved } from '../components/home/useThingsMoved'
import '../styles/portfolio.css'
import '../styles/settings5.css'

export function PortfolioView(): React.JSX.Element {
  useTick()
  const companies = useStore((s) => s.companies)
  const multi = useStore((s) => multiCompany(s))
  const overview = useStore((s) => s.companyOverview)
  const repos = useStore((s) => s.repos)
  const { byCompany, total } = useCompanyBadges()
  const needs = useLiveItems()
  const cloudNeeds = useCloudNeedsCount()
  const taskCounts = useTaskCounts()
  // VOICE.md §5.6, §5.10: the card medallion wears the laurel on the same rule as the rail coin
  const deptOn = useStore((s) => departmentsOn(s))
  const companyAgents = useStore((s) => s.companyAgents)
  const allTasks = useStore((s) => s.tasks)
  const asks = useStore((s) => s.asks)
  const health = useMemo(
    () => (deptOn ? companiesHealth(companies.map((c) => c.id), { companyAgents, tasks: allTasks, asks, badges: byCompany }) : ({} as Record<string, boolean>)),
    [deptOn, companies, companyAgents, allTasks, asks, byCompany]
  )
  // five doors A2: the one live source's count (live items + board tasks, a live ask counted once)
  const allNeeds = useNeeds('all')
  const taskNeeds = allNeeds.tasks
  /** null until the first load: cards say "Loading…" rather than "No runs yet" */
  const [runs, setRuns] = useState<Run[] | null>(null)

  // one small scoped list per company: a busy company's runs never push a quiet one's "last 3" out of a global page
  const ids = companies.map((c) => c.id).join(',')
  const load = (): void =>
    void Promise.all(companies.map((c) => hive.runs.list({ companyId: c.id, limit: 3 }).catch(() => [] as Run[]))).then((l) => setRuns([...new Map(l.flat().map((r) => [r.id, r])).values()]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [ids])
  const refetch = useCoalesced(load, 1500)
  useHiveEvent('run:updated', (r) => {
    // a live status flip updates in place; a new run refetches so every card's "last 3" stays right
    setRuns((l) => (l?.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? r : x)) : l))
    if (!runs?.some((x) => x.id === r.id)) refetch()
  })
  const lastRuns = useMemo(() => lastRunsByCompany(runs ?? [], 3), [runs])
  const tone = useTone()
  // design §4.8: month, week and cap per client (agencies bill with them), one usage query per range
  const [week, setWeek] = useState<UsageSummary | null>(null)
  const [month, setMonth] = useState<UsageSummary | null>(null)
  const loadSpend = (): void =>
    void Promise.all([hive.usage.summary({ range: 'week' }), hive.usage.summary({ range: 'month' })]).then(([w, m]) => (setWeek(w), setMonth(m)), () => undefined)
  useEffect(loadSpend, [])
  const refetchSpend = useCoalesced(loadSpend, 3000)
  useHiveEvent('run:updated', (r) => {
    if (r.status !== 'running' && r.status !== 'queued') refetchSpend()
  })
  const spend = useMemo(() => companySpend(companies, month?.byCompany ?? null, week?.byCompany ?? null), [companies, month, week])
  const moved = useThingsMoved()

  if (!multi)
    return (
      <div className="view">
        <Toolbar title="All companies" />
        <div className="portfolio-empty">
          {/* VOICE.md §5.8: the coin mosaic, one sentence, one action (same in both tones) */}
          <MosaicEmpty motif="coin" width={140}>
            <p>{t('portfolio.empty', undefined, tone)}</p>
            <Button variant="primary" icon="plus" onClick={openNewCompany}>
              {t('portfolio.empty.cta', undefined, tone)}
            </Button>
          </MosaicEmpty>
        </div>
      </div>
    )

  return (
    <div className="view">
      <Toolbar title="All companies" sub={<span className="company-toolbar-meta">{companies.filter((c) => !isPersonal(c)).length} {companies.filter((c) => !isPersonal(c)).length === 1 ? 'company' : 'companies'} · {statusLine(total)}</span>}>
        <Button icon="plus" onClick={openNewCompany}>
          New Company
        </Button>
      </Toolbar>
      <div className="scroll view__body">
        <div className="portfolio">
          {moved && <ThingsMovedCard />}
          {/* design §4.8: Needs you across companies comes first; every action acts inside its own company (B6) */}
          <SectionHeader title="Needs you across companies" count={allNeeds.count + cloudNeeds ? <span className="text-needs">{allNeeds.count + cloudNeeds}</span> : undefined}>
            <span className="portfolio__scope-note text-tertiary">Every action applies to that company only</span>
          </SectionHeader>
          {taskNeeds > 0 && (
            <div className="group-list portfolio__tasks">
              <NeedsYouTasks />
            </div>
          )}
          {needs.length === 0 ? (
            taskNeeds + cloudNeeds > 0 ? null : (
              <div className="portfolio__none">
                <NeedsYouEmpty tone={tone} />
              </div>
            )
          ) : (
            <div className="group-list portfolio__needs">
              {needs.map((item) => (
                <NeedsRow key={item.key} item={item} />
              ))}
            </div>
          )}
          {/* CLOUD.md §0.1: one inbox, in All mode too. Cloud asks and passport facts; nothing when this Mac has no cloud */}
          <CloudNeedsYou />
          <SectionHeader title="Companies" />
          <div className="portfolio__grid">
            {companies.map((c) => (
              <CompanyCard key={c.id} spend={spend.find((x) => x.companyId === c.id) ?? null} company={c} badge={byCompany[c.id] ?? EMPTY_BADGE} laurel={railLaurel(c, byCompany[c.id], !!health[c.id])} tasks={taskCounts[c.id]} overview={overview[c.id]} runs={runs ? (lastRuns[c.id] ?? []) : null} repoCount={reposOf(repos, c.id).length} />
            ))}
          </div>
          <SpendByCompany rows={spend} loaded={!!month && !!week} />
        </div>
      </div>
    </div>
  )
}

function CompanyCard({ company: c, badge, laurel = false, tasks, overview: o, runs, repoCount, spend }: { company: CompanyPassport; badge: CompanyBadge; laurel?: boolean; tasks?: TaskCounts; overview: CompanyOverview | undefined; runs: Run[] | null; repoCount: number; spend: CompanySpend | null }): React.JSX.Element {
  const mission = missionLine(c.mission)
  // C7: a company with no code reads without task codes, repositories or sessions
  const code = (o?.repoCount ?? repoCount) > 0
  // the status line already says who works and what needs you; the task line adds only what is done
  const taskLine = tasks?.doneToday ? `${tasks.doneToday} done today` : null
  const passport = o && (o.noteCount || o.ghostCount || o.pendingSuggestions)
  const paused = isCompanyPaused(c)
  const personal = isPersonal(c)
  // A2: a run whose task now waits on you (review, a question, parked) reads ◆ Needs you, never ✓ beside "1 needs you"
  const boardTasks = useStore((s) => s.tasks)
  const waiting = useMemo(() => new Set(boardTasks.filter((t) => t.companyId === c.id && t.runId && (t.status === 'in_review' || t.status === 'blocked')).map((t) => t.runId!)), [boardTasks, c.id])
  return (
    <article
      className={`pcard ${paused ? 'is-paused' : badge.needsYou ? 'is-needs' : badge.working ? 'is-working' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        void companyContextMenu(c)
      }}
    >
      {/* design §4.8: the Business Passport tablet lives on each company's Knowledge page now; the card leads with the name */}
      <header className="pcard__head">
        {/* VOICE.md §5.6: the engraved coin at 36. The name button beside it is the accessible name; the laurel's meaning is in the visible text too */}
        <span className="pcard__coin" aria-hidden="true" title={laurel ? t.sr('rail.laurel.sr') : undefined}>
          <RailMark company={c} size={36} />
        </span>
        <div className="pcard__title">
          <button type="button" className="pcard__name link-btn" onClick={() => void enterCompany(c.id)} title={`Enter ${c.name}`}>
            {companyLabel(c, true)}
          </button>
          {c.client && <span className="pcard__client">client</span>}
          <div className={`pcard__status ${badge.needsYou ? 'text-needs' : badge.working ? 'text-running' : 'text-tertiary'}`}>
            {paused ? `‖ Paused${badge.needsYou ? ` · ${statusLine({ needsYou: badge.needsYou, working: 0 })}` : ''}` : statusLine(badge)}
          </div>
          {/* AUTOPILOT.md §7: the same truth as the header chip */}
          {!isPersonal(c) && !paused && <AutopilotMark company={c} label />}
          {laurel && <span className="rm-sr">{t.sr('rail.laurel.sr')}</span>}
          {taskLine && (
            <button type="button" className="pcard__tasks link-btn" onClick={() => openBoard(c.id)} title={`Open ${c.name}’s Board`}>
              {taskLine}
            </button>
          )}
        </div>
        <span className="pcard__badges">
          <CompanyBadgeMark badge={badge} />
        </span>
      </header>
      <p className={`pcard__mission ${mission ? '' : 'text-tertiary'}`}>{mission || 'No mission yet. Add one in Company settings.'}</p>
      <CardMoney company={c} spend={spend} />
      <div className="pcard__runs">
        {!runs ? (
          <div className="pcard__none text-tertiary">Loading runs…</div>
        ) : runs.length === 0 ? (
          <div className="pcard__none text-tertiary">{spend?.month?.agents ? 'No agent runs yet. Your own chats count in Runs.' : 'No runs yet'}</div>
        ) : (
          runs.map((r) => (
            <button key={r.id} type="button" className="pcard__run" onClick={() => void navigate({ name: 'run', runId: r.id })} title={r.reason ?? undefined}>
              {waiting.has(r.id) ? <span className="glyph text-needs" title="Needs you">◆</span> : <StatusGlyph status={runVisual(r.status)} />}
              <span className="pcard__run-title">{code ? runTitle(r, 44) : runTitle(r, 60).replace(/^[A-Z][A-Z0-9]{0,5}-\d+ · /, '')}</span>
              <span className="pcard__run-time text-tertiary">
                <RelativeTime iso={r.endedAt ?? r.startedAt ?? r.createdAt} />
              </span>
            </button>
          ))
        )}
      </div>
      <dl className="pcard__stats">
        {code && (
          <div>
            <dt>Repos</dt>
            <dd>{o?.repoCount ?? repoCount}</dd>
          </div>
        )}
        <div>
          <dt>Runs this week</dt>
          <dd>{spend?.week ? spend.week.agents : (o?.runs7d ?? '—')}</dd>
        </div>
        <div className="pcard__stat-link" role="button" tabIndex={0} onClick={() => openCompanyPassport(c.id)} onKeyDown={(e) => e.key === 'Enter' && openCompanyPassport(c.id)} title={passport ? `Open Knowledge: ${o!.noteCount} note${o!.noteCount === 1 ? '' : 's'} · ${o!.ghostCount} unresolved link${o!.ghostCount === 1 ? '' : 's'} · ${o!.pendingSuggestions} suggestion${o!.pendingSuggestions === 1 ? '' : 's'} to review` : 'Open Knowledge. It fills in as agents work'}>
          <dt>Knowledge</dt>
          <dd>{passport ? `${o!.noteCount} note${o!.noteCount === 1 ? '' : 's'}${o!.pendingSuggestions ? ` · ${o!.pendingSuggestions} new to confirm` : ''}` : 'Empty'}</dd>
        </div>
      </dl>
      <footer className="pcard__actions">
        <Button size="sm" variant="primary" onClick={() => void enterCompany(c.id)}>
          Enter
        </Button>
        <Button size="sm" icon="plus" onClick={() => (code ? void newSessionMenu(c.id) : openNewChat(c.id))}>
          New chat
        </Button>
        <Button size="sm" variant="ghost" icon="coins" onClick={() => void enterCompany(c.id, { view: { name: 'usage' } })} title={`${c.name}’s Spend`}>
          Spend
        </Button>
        {/* design §4.8: a labelled Pause / Resume per card; it touches this company only */}
        {!personal && (
          <Button size="sm" variant="ghost" icon={paused ? 'play' : 'pause'} onClick={() => void setCompanyPaused(c.id, !paused)} title={paused ? `Resume ${c.name}` : `Pause ${c.name} only. Other companies keep running.`}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
        )}
      </footer>
    </article>
  )
}

function NeedsRow({ item }: { item: LiveItem }): React.JSX.Element {
  return (
    <div className="list-row portfolio__need" onClick={() => void openLiveItem(item)} title="Open it">
      <span className={`glyph ${item.kind === 'ask' ? 'text-needs' : 'text-tertiary'}`}>{item.kind === 'ask' ? '◆' : '◐'}</span>
      <CompanyChip companyId={item.companyId} />
      <span className="list-row__main">
        <span className="portfolio__need-title">{item.title}</span>
        {item.detail && <span className="text-tertiary"> · {item.detail}</span>}
      </span>
      <span className="list-row__meta">
        <RelativeTime iso={item.at} />
      </span>
      <span className="list-row__actions">
        <Button size="sm" onClick={(e) => (e.stopPropagation(), void openLiveItem(item))}>
          Open
        </Button>
      </span>
    </div>
  )
}

const MONTH = (): string => new Date().toLocaleString('en-US', { month: 'long' })

/** A card's money (design §4.8): "$18.60 October", "$4.20 this week" (or "$0 since Oct 24" while paused), and the cap. */
function CardMoney({ company: c, spend }: { company: CompanyPassport; spend: CompanySpend | null }): React.JSX.Element {
  if (!spend?.month) return <div className="pcard__money text-tertiary">Counting this month…</div>
  const cap = capLine(spend.month.usd, spend.cap)
  const pausedOn = c.pausedAt ? new Date(c.pausedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null
  return (
    <div className="pcard__money">
      <div className="pcard__money-row">
        <span className="pcard__money-v">{dollars(spend.month)}</span>
        <span className="text-tertiary">{MONTH()}</span>
        <span className="pcard__money-week text-tertiary">{pausedOn ? `$0 since ${pausedOn}` : `${dollars(spend.week)} this week`}</span>
      </div>
      {spend.personal ? null : cap.pct !== null ? (
        <>
          <div className="spend5-bar pcard__cap-bar">
            <i style={{ width: `${Math.min(100, cap.pct)}%` }} />
          </div>
          <div className="pcard__cap text-tertiary">{cap.text}</div>
        </>
      ) : (
        <div className="pcard__cap text-tertiary">
          No monthly cap ·{' '}
          <button type="button" className="link-btn" onClick={() => void enterCompany(c.id, { view: { name: 'usage', cap: Date.now() } })}>
            Set a cap
          </button>
        </div>
      )}
    </div>
  )
}

/** Spend by company (design §4.8): every company, $0 included, Week / Month, Export CSV, and a total row. */
function SpendByCompany({ rows, loaded }: { rows: CompanySpend[]; loaded: boolean }): React.JSX.Element {
  const [span, setSpan] = useState<'week' | 'month'>('month')
  const pick = (r: CompanySpend) => (span === 'week' ? r.week : r.month)
  const total = { usd: rows.reduce((n, r) => n + (pick(r)?.usd ?? 0), 0), estimated: rows.some((r) => pick(r)?.estimated), unpriced: rows.some((r) => pick(r)?.unpriced) }
  const runs = rows.reduce((n, r) => n + (pick(r)?.agents ?? 0), 0)
  const max = Math.max(0.01, ...rows.map((r) => pick(r)?.usd ?? 0))
  const exportCsv = (): void => {
    const url = URL.createObjectURL(new Blob([spendCsv(rows, MONTH())], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${MONTH().toLowerCase()}-by-company.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast('Exported one row per company')
  }
  return (
    <section className="portfolio__spend" aria-label="Spend by company">
      <SectionHeader title="Spend by company">
        <Segmented
          size="sm"
          items={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' }
          ]}
          value={span}
          onChange={setSpan}
        />
        <Button size="sm" icon="download" disabled={!loaded} onClick={exportCsv}>
          Export CSV
        </Button>
      </SectionHeader>
      {!loaded ? (
        <div className="text-tertiary">Counting…</div>
      ) : (
        <div className="spend5-table">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>State</th>
                <th className="num">Runs</th>
                <th style={{ width: '26%' }} aria-label="Share" />
                <th className="num">{span === 'week' ? 'This week' : MONTH()}</th>
                <th className="num">Cap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.companyId}>
                  <td className="strong">{r.name}</td>
                  <td className="text-secondary">{r.personal ? '—' : r.paused ? '‖ Paused' : '● Running'}</td>
                  <td className="num">{pick(r)?.agents ?? 0}</td>
                  <td>
                    <div className="spend5-bar">
                      <i style={{ width: `${((pick(r)?.usd ?? 0) / max) * 100}%` }} />
                    </div>
                  </td>
                  <td className="num strong">{dollars(pick(r))}</td>
                  <td className="num text-secondary">{r.cap ? `$${r.cap}` : '—'}</td>
                </tr>
              ))}
              <tr className="spend5-total">
                <td>Total</td>
                <td />
                <td className="num">{runs}</td>
                <td />
                <td className="num strong">{dollars(total)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="spend5-explain text-tertiary">Not charged to you. It’s what this work would cost per use, so agencies can bill each client; on a Claude plan there is nothing extra to pay.</p>
    </section>
  )
}
