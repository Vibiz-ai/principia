/** Home dashboard sections (LIVE.md §8): run result cards, learned facts, coming up, morning brief. */
import { useEffect, useState } from 'react'
import type { Artifact } from '@shared/types'
import type { ComingUp, LearnedFact, RunCard } from '@shared/live'
import { ArtifactThumb } from '../ArtifactThumb'
import { Button, RelativeTime, StatusGlyph } from '../ui'
import { runVisual } from '../../lib/graph'
import { firstLine, runTitle } from '../../lib/format'
import { durationMs } from '../../lib/time'
import { money, tokens } from '../../lib/live'
import { hive } from '../../lib/hive'
import { rerun } from '../../lib/runActions'
import { attempt, navigate, toast } from '../../state/store'
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
