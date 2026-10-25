/** Home dashboard sections (LIVE.md §8): run result cards, learned facts, coming up, morning brief. */
import { useEffect, useMemo, useState } from 'react'
import type { Artifact, Id } from '@shared/types'
import type { CompanyAgent } from '@shared/company'
import type { ComingUp, LearnedFact, RunCard } from '@shared/live'
import { ArtifactThumb } from '../ArtifactThumb'
import { Button, RelativeTime, SectionHeader, StatusGlyph } from '../ui'
import { runVisual } from '../../lib/graph'
import { firstLine, runTitle } from '../../lib/format'
import { durationMs } from '../../lib/time'
import { money, tokens } from '../../lib/live'
import { hive } from '../../lib/hive'
import { rerun } from '../../lib/runActions'
import { attempt, departmentsOn, navigate, openBoard, toast, useStore } from '../../state/store'
import { overnight, REASON_LABEL, type OvernightGroup, type OvernightKind } from '../../lib/board'
import { taskCountsLine, useLaneContext, useTaskCounts } from '../../lib/company'
import { latinLine, t, useTone, type Tone } from '../../lib/voice'
import { Laurel, LatinLine, MosaicEmpty } from '../roman'
import { AgentFace, useAgentDisplay } from '../board/NeedsYouTasks'
import { LimitActions, runLimitTarget } from '../agents/LimitBits'
import { limitLine } from '../../lib/live'

export function RunCardView({ card: c }: { card: RunCard }): React.JSX.Element {
  const r = c.run
  const failed = r.status === 'failed'
  const usage = c.costUsd != null ? money(c.costUsd) : c.tokens ? `${tokens(c.tokens.in + c.tokens.out)} tok` : null
  return (
    <div
      className={`rcard ${failed ? 'rcard--failed' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => void navigate({ name: 'run', runId: r.id })}
      onKeyDown={(e) => e.key === 'Enter' && void navigate({ name: 'run', runId: r.id })}
    >
      <div className="rcard__head">
        <StatusGlyph status={runVisual(r.status)} />
        <span className="rcard__title" title={r.title}>
          {runTitle(r, 60)}
        </span>
        <span className="rcard__when">
          <RelativeTime iso={r.endedAt ?? r.createdAt} />
        </span>
      </div>
      <div className="rcard__meta">
        {[r.status, c.durationMs != null ? durationMs(c.durationMs) : null, usage, c.filesChanged ? `${c.filesChanged} file${c.filesChanged === 1 ? '' : 's'} changed` : null].filter(Boolean).join(' · ')}
      </div>
      {c.files.length > 0 && (
        <div className="rcard__files mono" title={c.files.join('\n')}>
          {c.files.slice(0, 5).join('  ')}
          {c.filesChanged > 5 && ` +${c.filesChanged - 5}`}
        </div>
      )}
      {r.stopReason === 'rate_limited' && <div className="rcard__error limit-line">{limitLine(r)}</div>}
      {failed && c.failedStep && r.stopReason !== 'rate_limited' && (
        <div className="rcard__error" title={c.failedStep.error ?? undefined}>
          <span className="mono">{c.failedStep.nodeId}</span>: {firstLine(c.failedStep.error ?? 'failed', 90)}
        </div>
      )}
      {c.artifacts.length > 0 && (
        <div className="rcard__thumbs">
          {c.artifacts.slice(0, 4).map((a) => (
            <button
              key={a.id}
              type="button"
              className="rcard__thumb"
              title={`${a.name}\nClick to preview (Quick Look)`}
              onClick={(e) => {
                e.stopPropagation()
                void attempt(() => hive.artifacts.quickLook({ id: a.id }))
              }}
            >
              <ArtifactThumb artifact={a} size={128} compact />
              <span className="rcard__thumb-name">{midName(a.name, 18)}</span>
            </button>
          ))}
        </div>
      )}
      {r.stopReason === 'rate_limited' && (
        <div className="rcard__actions">
          <LimitActions target={runLimitTarget(r)} compact showLine={false} open />
        </div>
      )}
      {failed && r.stopReason !== 'rate_limited' && (
        <div className="rcard__actions">
          <Button
            size="sm"
            icon="refresh"
            onClick={(e) => {
              e.stopPropagation()
              void rerun(r)
            }}
          >
            Retry
          </Button>
          {c.failedStep && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation()
                void navigate({ name: 'run', runId: r.id, stepId: c.failedStep!.stepId })
              }}
            >
              Show step
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function LearnedList({ facts }: { facts: LearnedFact[] }): React.JSX.Element {
  return (
    <div className="group-list">
      {facts.map((l) => (
        <div
          key={l.fact.id}
          className="learned"
          onClick={() => void navigate({ name: 'memory', entityId: l.fact.entityId, scope: l.fact.repoId ? { repoId: l.fact.repoId } : 'global', nonce: Date.now() })}
          title="Open on the Memory page"
        >
          <span className={`learned__kind learned__kind--${l.fact.kind}`}>{l.fact.kind}</span>
          <div className="learned__text">
            <div className="learned__fact">{l.fact.text}</div>
            <div className="learned__meta">
              {[l.entityName, l.repoName ?? 'global', l.runTitle ? `from ${l.runTitle}` : null].filter(Boolean).join(' · ')}
              {l.fact.status === 'pending' && <span className="pill pill--warning">needs review</span>}
            </div>
          </div>
          <span className="learned__when">
            <RelativeTime iso={l.fact.createdAt} />
          </span>
        </div>
      ))}
    </div>
  )
}

export function ComingUpList({ items, paused, onChanged }: { items: ComingUp[]; paused: boolean; onChanged: () => void }): React.JSX.Element {
  return (
    <div className="group-list">
      {paused && <div className="banner banner--warning">Schedules are paused — nothing will fire.</div>}
      {items.map((c) => (
        <div key={`${c.scheduleId}:${c.at}`} className="list-row" onClick={() => void navigate({ name: 'schedules', selectedId: c.scheduleId })}>
          <StatusGlyph status="scheduled" />
          <span className="list-row__main">
            {c.name} <span className="text-tertiary">· {c.sentence}</span>
          </span>
          <span className="list-row__meta">
            <RelativeTime iso={c.at} />
          </span>
          <span className="list-row__actions list-row__actions--shown">
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                void attempt(() => hive.schedules.runNow({ id: c.scheduleId }), 'Run now').then((r) => r && toast(`Started ${c.name}`))
              }}
            >
              Run Now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Skip only the next fire; the schedule keeps running after it"
              onClick={(e) => {
                e.stopPropagation()
                void attempt(() => hive.schedules.skipNext({ id: c.scheduleId }), 'Skip').then((s) => {
                  if (!s) return
                  toast(`Skipped the next ${c.name}`)
                  onChanged()
                })
              }}
            >
              Skip
            </Button>
          </span>
        </div>
      ))}
    </div>
  )
}

export function MorningBrief({ artifact: a }: { artifact: Artifact }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    void hive.artifacts.peek({ id: a.id, bytes: 1200 }).then((t) => setText(t.text), () => setText(null))
  }, [a.id])
  const body = (text ?? '').slice(0, 600)
  const lines = body.split('\n')
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '') ?? a.name.replace(/\.md$/i, '')
  return (
    <div className="brief" role="button" tabIndex={0} onClick={() => void attempt(() => hive.artifacts.quickLook({ id: a.id }))} onKeyDown={(e) => e.key === ' ' && void attempt(() => hive.artifacts.quickLook({ id: a.id }))} title="Space or click to preview (Quick Look)">
      <div className="brief__head">
        <span className="brief__pin">Morning brief</span>
        <span className="brief__title">{title}</span>
        <span className="brief__when">
          <RelativeTime iso={a.mtime} />
        </span>
      </div>
      <div className="brief__body">
        {text === null
          ? '…'
          : lines
              .filter((l) => !/^#\s+/.test(l))
              .join('\n')
              .trim()}
        {(text?.length ?? 0) > 600 && '…'}
      </div>
    </div>
  )
}

/** "morning-brief-2026-10-16.md" -> "morning-b…10-16.md": keep the start and the extension visible. */
export function midName(name: string, max: number): string {
  if (name.length <= max) return name
  const keep = max - 1
  const tail = Math.ceil(keep * 0.45)
  return `${name.slice(0, keep - tail)}…${name.slice(name.length - tail)}`
}

// ---------- VOICE.md §3.5 / §3.6: greeting, Needs you header and empty state, the Senate briefing ----------

/**
 * The greeting kicker: home.greet.morning before noon, home.greet.afternoon until 17:00, then home.greet.evening.
 * Plain in both tones (the digest title is the card's wink).
 */
export function greetingFor(now: Date, tone: Tone): string {
  const h = now.getHours()
  if (h < 12) return t('home.greet.morning', undefined, tone)
  if (h >= 17) return t('home.greet.evening', undefined, tone)
  return t('home.greet.afternoon', undefined, tone)
}

export function HomeGreeting({ now, className }: { now?: Date; className?: string }): React.JSX.Element {
  const tone = useTone()
  return (
    <div className={['home-kicker', className].filter(Boolean).join(' ')}>
      <Laurel variant="sprig" size={18} />
      <span>{greetingFor(now ?? new Date(), tone)}</span>
    </div>
  )
}

/** The Needs you section header: plain "Needs you" in both tones (VOICE.md §1, §3.6). */
export function NeedsYouHeader({ count, children }: { count?: React.ReactNode; children?: React.ReactNode }): React.JSX.Element {
  return (
    <SectionHeader title="Needs you" count={count}>
      {children}
    </SectionHeader>
  )
}

/** ny.empty over a laurel mosaic; playful adds *Otium cum dignitate* with its translation. */
export function NeedsYouEmpty({ tone: toneProp }: { tone?: Tone }): React.JSX.Element {
  const current = useTone()
  const tone = toneProp ?? current
  return (
    <MosaicEmpty motif="laurel" width={104} className="home-empty">
      <p>
        {t('ny.empty', undefined, tone)} <LatinLine pair={latinLine('ny.empty', tone)} tone={tone} />
      </p>
    </MosaicEmpty>
  )
}

const KIND_LABEL: Record<OvernightKind, string> = { done: 'Done', parked: 'Parked', review: 'Review' }
interface AgentGroup {
  key: string
  agent: CompanyAgent | undefined
  color: string | null
  items: OvernightGroup['items']
}
/** Overnight items regrouped by agent (department order kept, unassigned last). */
export function byAgent(groups: OvernightGroup[], agents: ReadonlyMap<Id, CompanyAgent>): AgentGroup[] {
  const out = new Map<string, AgentGroup>()
  let loose: AgentGroup | null = null
  for (const g of groups)
    for (const it of g.items) {
      const a = it.task.agentId ? agents.get(it.task.agentId) : undefined
      const agent = a && a.companyId === it.task.companyId ? a : undefined
      if (!agent) {
        loose ??= { key: 'none', agent: undefined, color: null, items: [] }
        loose.items.push(it)
        continue
      }
      const cur = out.get(agent.id) ?? { key: agent.id, agent, color: g.color, items: [] }
      cur.items.push(it)
      out.set(agent.id, cur)
    }
  return loose ? [...out.values(), loose] : [...out.values()]
}
/** "3 done, 1 to review, 1 parked" (zero counts left out). */
export function agentSummary(items: OvernightGroup['items']): string {
  const n = (k: OvernightKind): number => items.filter((i) => i.kind === k).length
  return [n('done') && `${n('done')} done`, n('review') && `${n('review')} to review`, n('parked') && `${n('parked')} parked`].filter(Boolean).join(', ')
}

/**
 * DEPARTMENTS.md §9 Overnight, VOICE.md §3.5: the focused company's tasks done, parked or awaiting review since
 * `since` (the last visit), as a briefing card grouped by agent (bust 20, persona and role). Title home.digest.title
 * ("The Senate briefing" playful, "Overnight" plain), with a plain greeting and subtitle so the card has one wink.
 * Nothing new: home.digest.empty over a lamp mosaic. A row opens its card on the Board. Null with departments off.
 * `latin` false drops the empty state's *Quid novi?* (Home passes it when the Needs you empty state above already shows
 * *Otium cum dignitate*: one Latin phrase per screen, VOICE.md §1).
 */
export function SenateBriefing({ companyId, since, now, latin = true }: { companyId: Id; since: string; now?: Date; latin?: boolean }): React.JSX.Element | null {
  const on = useStore((s) => departmentsOn(s))
  const tasks = useStore((s) => s.tasks)
  const departments = useStore((s) => s.departments)
  const tone = useTone()
  const who = useAgentDisplay()
  const counts = useTaskCounts()[companyId]
  const ctx = useLaneContext()
  const groups = useMemo(() => (on ? overnight(tasks, companyId, since, departments, ctx) : []), [on, tasks, companyId, since, departments, ctx])
  const people = useMemo(() => byAgent(groups, ctx.agentsById), [groups, ctx])
  if (!on) return null
  const line = taskCountsLine(counts)
  const all = groups.flatMap((g) => g.items)
  const n = (k: OvernightKind): number => all.filter((i) => i.kind === k).length
  const playful = tone === 'playful'
  const empty = latin ? latinLine('home.digest.empty', tone) : null
  return (
    <section className="briefing" aria-label={t.sr('home.digest.title')}>
      <header className="briefing__head">
        <div className="briefing__titles">
          <HomeGreeting now={now} />
          {/* VOICE.md §9: screen readers hear the plain title ("Overnight"), never the playful one */}
          <h2 className="briefing__title">
            {playful ? (
              <>
                <span aria-hidden>{t('home.digest.title', undefined, tone)}</span>
                <span className="rm-sr">{t.sr('home.digest.title')}</span>
              </>
            ) : (
              t('home.digest.title', undefined, tone)
            )}
          </h2>
          <div className="briefing__sub">{t('home.digest.sub', undefined, tone)}</div>
        </div>
        <div className="briefing__actions">
          {line && <span className="text-tertiary briefing__line">{line}</span>}
          <Button size="sm" variant="ghost" onClick={() => openBoard(companyId)}>
            Board →
          </Button>
        </div>
      </header>
      {all.length === 0 ? (
        <MosaicEmpty motif="lamp" width={104} className="home-empty">
          <p>
            {empty && (
              <>
                <LatinLine pair={empty} tone={tone} />{' '}
              </>
            )}
            {/* the playful line leans on the Latin before it; without the Latin, the full plain sentence */}
            {t('home.digest.empty', undefined, empty ? tone : 'plain')}
          </p>
        </MosaicEmpty>
      ) : (
        <>
          <div className="briefing__stats">
            <div className="briefing__stat"><b>{n('done')}</b><span>tasks done</span></div>
            <div className="briefing__stat"><b>{n('review')}</b><span>awaiting review</span></div>
            <div className="briefing__stat"><b>{n('parked')}</b><span>parked</span></div>
          </div>
          <div className="briefing__people">
            {people.map((g) => {
              const d = who(g.agent)
              return (
                <div key={g.key} className="briefing__agent">
                  <div className="briefing__agent-head">
                    <span className="briefing__bar" style={{ background: g.color ?? 'var(--border-strong, var(--border))' }} />
                    {d ? <AgentFace persona={d.persona} label={d.name} color={g.color} size={20} /> : <span className="briefing__noface" aria-hidden />}
                    <b className="briefing__name">{d ? d.name : 'Unassigned'}</b>
                    {d?.role && <span className="briefing__role">{d.role}</span>}
                    <span className="briefing__summary">{agentSummary(g.items)}</span>
                  </div>
                  {g.items.map(({ task, kind }) => (
                    <button key={task.id} type="button" className="overnight__item briefing__item" onClick={() => openBoard(companyId, { taskId: task.id })}>
                      <span className={`overnight__kind overnight__kind--${kind}`}>
                        {/* a parked card says why, as the board's chip does ("Question", "Run failed") */}
                        {kind === 'parked' && task.blockReason ? REASON_LABEL[task.blockReason] : KIND_LABEL[kind]}
                      </span>
                      <span className="task-identifier">{task.identifier}</span>
                      <span className="overnight__title">{task.title}</span>
                      <RelativeTime iso={task.updatedAt} />
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
