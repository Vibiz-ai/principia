/**
 * Portfolio (COMPANY.md §8.5): Home in All mode. One card per company (status, last runs, repos, runs this week,
 * Passport stats, Enter / New session / Open Passport), then the merged "Needs you across companies" list. Live
 * badges come from the store's agents and asks; counts from company:overview; last runs from one runs:list.
 * DEPARTMENTS.md §9: with departments on, each card adds "3 working · 2 need you · 5 done today" (laneOf) and the
 * Needs you list starts with the board's task items (NeedsYouTasks).
 */
import { useEffect, useMemo, useState } from 'react'
import type { CompanyOverview, CompanyPassport } from '@shared/company'
import type { Run } from '@shared/types'
import { CompanyChip } from '../components/CompanyChip'
import { Button, RelativeTime, SectionHeader, StatusGlyph, Toolbar, useTick } from '../components/ui'
import { companyLabel, EMPTY_BADGE, isCompanyPaused, isPersonal, reposOf, taskCountsLine, useCompanyBadges, useLiveItems, useTaskCounts, type CompanyBadge, type LiveItem, type TaskCounts } from '../lib/company'
import { NeedsYouTasks } from '../components/board/NeedsYouTasks'
import { CloudNeedsYou, useCloudNeedsCount } from '../components/cloud/NeedsYou'
import { runTitle } from '../lib/format'
import { runVisual } from '../lib/graph'
import { hive, useHiveEvent } from '../lib/hive'
import { lastRunsByCompany, missionLine, statusLine } from '../lib/scope'
import { useCoalesced } from '../lib/useThrottled'
import { CompanyBadgeMark, CompanyCoin, railLaurel } from '../shell/CompanyRail'
import { companiesHealth } from '../lib/agentHealth'
import { MosaicEmpty, PassportTablet } from '../components/roman'
import { NeedsYouEmpty } from '../components/home/DashboardParts'
import { t, useTone } from '../lib/voice'
import { companyContextMenu, departmentsOn, enterCompany, multiCompany, navigate, newSessionMenu, openBoard, openCompanyPassport, openLiveItem, openNewCompany, setCompanyPaused, useStore } from '../state/store'
import { useNeeds } from '../state/live'
import '../styles/portfolio.css'

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
      <Toolbar title="All companies" sub={<span className="company-toolbar-meta">{statusLine(total)}</span>}>
        <Button icon="plus" onClick={openNewCompany}>
          New Company
        </Button>
      </Toolbar>
      <div className="scroll view__body">
        <div className="portfolio">
          <div className="portfolio__grid">
            {companies.map((c) => (
              <CompanyCard key={c.id} company={c} badge={byCompany[c.id] ?? EMPTY_BADGE} laurel={railLaurel(c, byCompany[c.id], !!health[c.id])} tasks={taskCounts[c.id]} overview={overview[c.id]} runs={runs ? (lastRuns[c.id] ?? []) : null} repoCount={reposOf(repos, c.id).length} />
            ))}
          </div>
          <SectionHeader title="Needs you across companies" count={allNeeds.count + cloudNeeds ? <span className="text-needs">{allNeeds.count + cloudNeeds}</span> : undefined} />
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
        </div>
      </div>
    </div>
  )
}

function CompanyCard({ company: c, badge, laurel = false, tasks, overview: o, runs, repoCount }: { company: CompanyPassport; badge: CompanyBadge; laurel?: boolean; tasks?: TaskCounts; overview: CompanyOverview | undefined; runs: Run[] | null; repoCount: number }): React.JSX.Element {
  const mission = missionLine(c.mission)
  const taskLine = taskCountsLine(tasks)
  const passport = o && (o.noteCount || o.ghostCount || o.pendingSuggestions)
  const paused = isCompanyPaused(c)
  const personal = isPersonal(c)
  return (
    <article
      className={`pcard ${paused ? 'is-paused' : badge.needsYou ? 'is-needs' : badge.working ? 'is-working' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        void companyContextMenu(c)
      }}
    >
      {/* VOICE.md §5.3: the Passport as a card tablet (inscription and seal 36); a click enters, as the name does */}
      <div className="pcard__tablet" aria-hidden="true" onClick={() => void enterCompany(c.id)}>
        <PassportTablet layout="card" name={c.name} color={c.color} sealed />
      </div>
      <header className="pcard__head">
        {/* VOICE.md §5.6: the engraved coin at 36. The name button beside it is the accessible name; the laurel's meaning is in the visible text too */}
        <span className="pcard__coin" aria-hidden="true" title={laurel ? t.sr('rail.laurel.sr') : undefined}>
          <CompanyCoin company={c} size={36} laurel={laurel} />
        </span>
        <div className="pcard__title">
          <button type="button" className="pcard__name link-btn" onClick={() => void enterCompany(c.id)} title={`Enter ${c.name}`}>
            {companyLabel(c, true)}
          </button>
          <div className={`pcard__status ${badge.needsYou ? 'text-needs' : badge.working ? 'text-running' : 'text-tertiary'}`}>
            {paused ? `‖ Paused${badge.needsYou ? ` · ${statusLine({ needsYou: badge.needsYou, working: 0 })}` : ''}` : statusLine(badge)}
          </div>
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
      <div className="pcard__runs">
        {!runs ? (
          <div className="pcard__none text-tertiary">Loading runs…</div>
        ) : runs.length === 0 ? (
          <div className="pcard__none text-tertiary">No runs yet</div>
        ) : (
          runs.map((r) => (
            <button key={r.id} type="button" className="pcard__run" onClick={() => void navigate({ name: 'run', runId: r.id })} title={r.reason ?? undefined}>
              <StatusGlyph status={runVisual(r.status)} />
              <span className="pcard__run-title">{runTitle(r, 44)}</span>
              <span className="pcard__run-time text-tertiary">
                <RelativeTime iso={r.endedAt ?? r.startedAt ?? r.createdAt} />
              </span>
            </button>
          ))
        )}
      </div>
      <dl className="pcard__stats">
        <div>
          <dt>Repos</dt>
          <dd>{o?.repoCount ?? repoCount}</dd>
        </div>
        <div>
          <dt>Runs this week</dt>
          <dd>{o?.runs7d ?? '—'}</dd>
        </div>
        <div title={passport ? `${o!.noteCount} notes · ${o!.ghostCount} unresolved links · ${o!.pendingSuggestions} suggestions to review` : 'The Passport fills in as agents work'}>
          <dt>Passport</dt>
          <dd>{passport ? `${o!.noteCount} notes · ${o!.ghostCount} ghosts · ${o!.pendingSuggestions} to review` : 'Empty'}</dd>
        </div>
      </dl>
      <footer className="pcard__actions">
        <Button size="sm" variant="primary" onClick={() => void enterCompany(c.id)}>
          Enter
        </Button>
        <Button size="sm" icon="plus" onClick={() => void newSessionMenu(c.id)}>
          New Session
        </Button>
        <Button size="sm" variant="ghost" icon="passport" onClick={() => openCompanyPassport(c.id)}>
          Open Passport
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
