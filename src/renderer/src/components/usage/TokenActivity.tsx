/**
 * USAGE.md §5: Token activity, the top of Spend. A stat strip (lifetime, peak day, longest task, streaks) over a year
 * of round dots, one per local day, in a calm blue scale. Every token on this Mac: Claude Code, Codex and Principia's
 * own calls, whatever company. The first count reads the transcripts once (usage:tokens answers "counting" with its
 * progress, polled here); later visits read only what was appended.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TokenActivity as Activity, TokenActivityDay, TokenCounts, TokenSourceId } from '@shared/usage'
import { GRID_WEEKS, LEVELS, activityGrid, activityStats, addCounts, compactTokens, nextDay, parseDay, streakLabel, sumCounts, taskDuration, zeroCounts, type ActivityMode, type GridCell } from '@shared/tokenActivity'
import { errorMessage, hive, useHiveEvent } from '../../lib/hive'
import { bytesLabel } from '../../lib/usage'
import { loadJson, saveJson } from '../../state/store'

const MODES: { value: ActivityMode; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cumulative', label: 'Cumulative' }
]
const SOURCE_LABEL: Record<TokenSourceId, string> = { claude: 'Claude Code', codex: 'Codex', principia: 'Principia' }
const POLL_MS = 800
/** A dot's slot (dot + gap) in px: shrinks with the card down to MIN_CELL, then the grid scrolls inside the card. */
const MIN_CELL = 10
const MAX_CELL = 17
const LABEL_H = 18

const fmtDay = (k: string, year = true): string => parseDay(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) })
const shortDate = (k: string): string => parseDay(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function TokenActivity(): React.JSX.Element {
  const [data, setData] = useState<Activity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ActivityMode>(() => loadJson<ActivityMode>('principia.tokenActivityMode', 'daily'))
  const timer = useRef<number | null>(null)
  const load = (): void => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    void hive.usage.tokens().then(
      (a) => {
        setError(null)
        setData(a)
        // the first count runs in main: poll its progress until it is done
        if (a.state === 'counting') timer.current = window.setTimeout(load, POLL_MS)
      },
      (e) => setError(errorMessage(e))
    )
  }
  useEffect(() => {
    load()
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useHiveEvent('run:updated', (r) => {
    if (r.status !== 'running' && r.status !== 'queued' && !timer.current) load()
  })

  const now = useMemo(() => new Date(data?.at ?? Date.now()), [data?.at])
  const stats = useMemo(() => activityStats(data?.days ?? [], now), [data, now])
  const counting = data?.state === 'counting'
  const p = data?.progress
  const pct = p && p.bytesTotal > 0 ? Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 0
  const pending = !data && !error
  const v = (s: string): string => (pending ? '—' : s)

  return (
    <section className="tact" aria-label="Token activity">
      <div className="tact-stats" aria-busy={counting || pending}>
        <Stat value={v(compactTokens(stats.lifetime))} label="Lifetime tokens" />
        <Stat value={v(stats.peak ? compactTokens(stats.peak.tokens) : '0')} label="Peak tokens" title={stats.peak ? `Biggest day: ${fmtDay(stats.peak.date)}` : undefined} />
        <Stat value={v(taskDuration(data?.longestTaskMs ?? 0))} label="Longest task" title="The longest single agent turn, from your prompt to its finished reply (waits over 10 minutes left out)" />
        <Stat value={v(streakLabel(stats.longestStreak))} label="Longest streak" />
        <Stat value={v(streakLabel(stats.currentStreak))} label="Current streak" />
      </div>

      <div className="tact-head">
        <div className="tact-title">Token activity</div>
        <div className="tact-modes" role="radiogroup" aria-label="Activity view">
          {MODES.map((m, i) => (
            <span key={m.value} className="tact-modes__item">
              {i > 0 && <span className="tact-modes__sep" aria-hidden="true">·</span>}
              <button type="button" role="radio" aria-checked={mode === m.value} className={`tact-modes__btn${mode === m.value ? ' is-on' : ''}`} onClick={() => (setMode(m.value), saveJson('principia.tokenActivityMode', m.value))}>
                {m.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="tact-card">
        {error && !data ? (
          <div className="tact-note text-tertiary">
            Couldn’t count tokens: {error}.{' '}
            <button type="button" className="link-btn" onClick={load}>
              Try again
            </button>
          </div>
        ) : (
          <DotGrid days={data?.days ?? []} now={now} mode={mode} />
        )}
        {(counting || pending) && (
          <div className="tact-progress" role="status">
            <span>Counting your history…</span>
            {p && p.bytesTotal > 0 && (
              <>
                <span className="tact-progress__bar" aria-hidden="true">
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span className="text-tertiary">
                  {bytesLabel(p.bytesDone)} of {bytesLabel(p.bytesTotal)} · {p.filesDone.toLocaleString('en-US')} of {p.filesTotal.toLocaleString('en-US')} files
                </span>
              </>
            )}
          </div>
        )}
        <div className="tact-foot">
          <p className="tact-foot__text text-tertiary">
            {data ? <Footnote data={data} /> : 'Every agent on this Mac, every company.'}
          </p>
          <span className="tact-legend text-tertiary" aria-hidden="true">
            Less
            {Array.from({ length: LEVELS + 1 }, (_, l) => (
              <i key={l} className={`tact-dot tact-dot--${l}`} />
            ))}
            More
          </span>
        </div>
      </div>
    </section>
  )
}

function Stat({ value, label, title }: { value: string; label: string; title?: string }): React.JSX.Element {
  return (
    <div className="tact-stat" title={title}>
      <div className="tact-stat__v">{value}</div>
      <div className="tact-stat__l">{label}</div>
    </div>
  )
}

/** Counted sources with their totals, what is left out, and the token rule: said once, plainly. */
function Footnote({ data }: { data: Activity }): React.JSX.Element {
  const counted = data.sources.filter((s) => s.counted)
  const left = data.sources.filter((s) => !s.counted)
  return (
    <>
      Counted: {counted.map((s) => `${s.label} ${compactTokens(s.tokens)}`).join(' · ') || 'nothing yet'}
      {left.length ? `. Not counted: ${left.map((s) => `${s.label} (${(s.note ?? 'not found').toLowerCase()})`).join(', ')}` : ''}. Cursor and Gemini apps keep no local token record. Tokens are input + output + cache writes + cache reads, as the CLIs report them; a run Principia started counts once, from its transcript. Every company, local days.
    </>
  )
}

/** The year of dots. Hover a dot for its day (or week, or running total) split per source and model. */
function DotGrid({ days, now, mode }: { days: TokenActivityDay[]; now: Date; mode: ActivityMode }): React.JSX.Element {
  const grid = useMemo(() => activityGrid(days, now, mode), [days, now, mode])
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days])
  const wrap = useRef<HTMLDivElement | null>(null)
  const [cell, setCell] = useState(MAX_CELL)
  const [hover, setHover] = useState<GridCell | null>(null)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const fit = (): void => setCell(Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(el.clientWidth / GRID_WEEKS))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // the tooltip opens under the dot, over the footnote, so it never hides the view toggle
  // a grid wider than its card scrolls; it opens on the newest weeks, like the right end of a contribution graph
  useLayoutEffect(() => {
    const el = wrap.current
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth
  }, [cell])
  const r = Math.max(2.5, cell * 0.36)
  const w = GRID_WEEKS * cell
  const h = 7 * cell + LABEL_H
  const tipLeft = hover ? hover.col * cell + cell / 2 - (wrap.current?.scrollLeft ?? 0) : 0
  const clientW = wrap.current?.clientWidth ?? w
  return (
    <div className="tact-grid" onMouseLeave={() => setHover(null)}>
      <div className="tact-grid__scroll" ref={wrap}>
        <svg width={w} height={h} role="img" aria-label={`Tokens per ${mode === 'weekly' ? 'week' : 'day'}, the last 12 months`}>
          {grid.cells.map((c) =>
            c.future ? null : (
              <circle
                key={c.date}
                cx={c.col * cell + cell / 2}
                cy={c.row * cell + cell / 2}
                r={r}
                className={`tact-dot tact-dot--${c.level}${hover && (mode === 'weekly' ? hover.col === c.col : hover.date === c.date) ? ' is-hover' : ''}`}
                onMouseEnter={() => setHover(c)}
              />
            )
          )}
          {grid.months.map((m) => (
            <text key={`${m.col}-${m.label}`} x={m.col * cell + cell / 2 - r} y={7 * cell + 13} className="tact-month">
              {m.label}
            </text>
          ))}
        </svg>
      </div>
      {hover && (
        <div
          className="chart__tip tact-tip"
          style={{ left: Math.max(115, Math.min(clientW - 115, tipLeft)), top: (hover.row + 1) * cell + 4 }}
        >
          <Tip cell={hover} mode={mode} byDate={byDate} />
        </div>
      )}
    </div>
  )
}

function Tip({ cell, mode, byDate }: { cell: GridCell; mode: ActivityMode; byDate: Map<string, TokenActivityDay> }): React.JSX.Element {
  // the days the tooltip sums: the day, or its week (Monday to Sunday)
  const dates = mode === 'weekly' ? Array.from({ length: 7 }, (_, i) => nextDay(cell.date, i - cell.row)) : [cell.date]
  const per = new Map<TokenSourceId, TokenCounts>()
  const models = new Map<string, number>()
  const parts = zeroCounts()
  for (const k of dates) {
    const d = byDate.get(k)
    if (!d) continue
    for (const [src, c] of Object.entries(d.byProvider) as [TokenSourceId, TokenCounts][]) {
      addCounts((per.has(src) ? per : per.set(src, zeroCounts())).get(src)!, c)
      addCounts(parts, c)
    }
    for (const [m, n] of Object.entries(d.byModel)) models.set(m, (models.get(m) ?? 0) + n)
  }
  const total = sumCounts(parts)
  const head = mode === 'weekly' ? `Week of ${shortDate(dates[0])}` : fmtDay(cell.date)
  const top = [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  return (
    <>
      <div className="chart__tip-day">{head}</div>
      {mode === 'cumulative' && (
        <div className="chart__tip-row tact-tip__total">
          <span className="chart__tip-label">Running total</span>
          <span className="chart__tip-val">{compactTokens(cell.value)}</span>
        </div>
      )}
      <div className="chart__tip-row tact-tip__total">
        <span className="chart__tip-label">{mode === 'cumulative' ? 'That day' : 'Tokens'}</span>
        <span className="chart__tip-val">{total ? compactTokens(total) : 'None'}</span>
      </div>
      {[...per.entries()]
        .filter(([, c]) => sumCounts(c) > 0)
        .sort((a, b) => sumCounts(b[1]) - sumCounts(a[1]))
        .map(([src, c]) => (
          <div key={src} className="chart__tip-row">
            <span className="chart__tip-label text-secondary">{SOURCE_LABEL[src]}</span>
            <span className="chart__tip-val">{compactTokens(sumCounts(c))}</span>
          </div>
        ))}
      {top.length > 0 && (
        <div className="tact-tip__sect">
          {top.map(([m, n]) => (
            <div key={m} className="chart__tip-row">
              <span className="chart__tip-label text-tertiary">{m}</span>
              <span className="chart__tip-val text-secondary">{compactTokens(n)}</span>
            </div>
          ))}
        </div>
      )}
      {total > 0 && (
        <div className="tact-tip__parts text-tertiary">
          In {compactTokens(parts.input)} · Out {compactTokens(parts.output)} · Cache write {compactTokens(parts.cacheWrite)} · Cache read {compactTokens(parts.cacheRead)}
        </div>
      )}
    </>
  )
}
