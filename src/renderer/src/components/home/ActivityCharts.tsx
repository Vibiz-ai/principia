/**
 * Home "Activity" (LIVE.md §8): runs/day (passed/failed), tokens/day by model, spend/day. Small inline-SVG bar charts,
 * one axis each, legend for ≥ 2 series, hover tooltip per day. Real data only: days without reported cost stay empty.
 * Model hues: a validated categorical order (dark surface), see tokens.css --series-*.
 */
import { useMemo, useState } from 'react'
import type { ActivityDay } from '@shared/live'
import { axisTicks, modelSeries, money, niceIntMax, niceMax, shortDay, tokens } from '../../lib/live'

const W = 248
const H = 96
const PAD_L = 30
const PAD_B = 16
const PAD_T = 6
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']
const OTHER = 'var(--series-other)'

interface Stack {
  label: string
  value: number
  color: string
}
interface Col {
  date: string
  stacks: Stack[]
  total: number
}

function Bars({ title, cols, fmt, legend, empty, step = 1, integer = false }: { title: string; cols: Col[]; fmt: (v: number) => string; legend: { label: string; color: string; glyph?: string }[]; empty?: string; step?: number; integer?: boolean }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const top = Math.max(0, ...cols.map((c) => c.total))
  const max = integer ? niceIntMax(top) : niceMax(top)
  const plotW = W - PAD_L
  const plotH = H - PAD_B - PAD_T
  const slot = plotW / Math.max(cols.length, 1)
  const bw = Math.max(4, Math.min(12, slot - 4))
  const y = (v: number): number => PAD_T + plotH - (v / max) * plotH
  const any = cols.some((c) => c.total > 0)
  const hc = hover !== null ? cols[hover] : null
  return (
    <figure className="chart" aria-label={title}>
      <figcaption className="chart__title">{title}</figcaption>
      {legend.length > 1 && (
        <div className="chart__legend">
          {legend.map((l) => (
            <span key={l.label} className="chart__key">
              <span className="chart__swatch" style={{ background: l.color }} />
              {l.glyph && <span className="chart__glyph">{l.glyph}</span>}
              {l.label}
            </span>
          ))}
        </div>
      )}
      <div className="chart__plot" onMouseLeave={() => setHover(null)}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {axisTicks(max, step).map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} className="chart__grid" />
              <text x={PAD_L - 4} y={y(v) + 3} className="chart__axis" textAnchor="end">
                {v === 0 ? '0' : fmt(v)}
              </text>
            </g>
          ))}
          {cols.map((c, i) => {
            const x = PAD_L + i * slot + (slot - bw) / 2
            let acc = 0
            const segs = c.stacks.filter((s) => s.value > 0)
            return (
              <g key={c.date} onMouseEnter={() => setHover(i)}>
                <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent" />
                {segs.map((s, j) => {
                  const y0 = y(acc)
                  acc += s.value
                  const y1 = y(acc)
                  const h = Math.max(1, y0 - y1 - (j < segs.length - 1 ? 2 : 0))
                  const top = j === segs.length - 1
                  return top ? (
                    <path key={s.label} d={roundTop(x, y1, bw, h)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                  ) : (
                    <rect key={s.label} x={x} y={y0 - h} width={bw} height={h} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                  )
                })}
                {(i === 0 || i === cols.length - 1 || i === Math.floor(cols.length / 2)) && (
                  <text x={x + bw / 2} y={H - 3} className="chart__axis" textAnchor="middle">
                    {shortDay(c.date)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {!any && <div className="chart__empty">{empty ?? 'No data yet'}</div>}
        {hc && hover !== null && any && (
          <div className="chart__tip" style={{ left: `${((PAD_L + hover * slot + slot / 2) / W) * 100}%` }}>
            <div className="chart__tip-day">{shortDay(hc.date)}</div>
            {hc.stacks.filter((s) => s.value > 0).length === 0 ? (
              <div className="text-tertiary">nothing</div>
            ) : (
              hc.stacks
                .filter((s) => s.value > 0)
                .map((s) => (
                  <div key={s.label} className="chart__tip-row">
                    <span className="chart__swatch" style={{ background: s.color }} />
                    <span className="chart__tip-label">{s.label}</span>
                    <span className="chart__tip-val">{fmt(s.value)}</span>
                  </div>
                ))
            )}
          </div>
        )}
      </div>
    </figure>
  )
}

/** A bar with 4 px rounded top corners anchored to the baseline. */
function roundTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

export function ActivityCharts({ days, successRate, providers }: { days: ActivityDay[]; successRate: number | null; providers: { unpricedTokens: boolean } }): React.JSX.Element {
  const runs = useMemo<Col[]>(
    () =>
      days.map((d) => ({
        date: d.date,
        total: d.passed + d.failed + Math.max(0, d.runs - d.passed - d.failed),
        stacks: [
          { label: 'passed', value: d.passed, color: 'var(--status-success)' },
          { label: 'failed', value: d.failed, color: 'var(--status-failed)' },
          { label: 'running · canceled', value: Math.max(0, d.runs - d.passed - d.failed), color: 'var(--status-idle)' }
        ]
      })),
    [days]
  )
  const series = useMemo(() => modelSeries(days), [days])
  const colorOf = (i: number, m: string): string => (m === 'other' ? OTHER : (SERIES[i] ?? OTHER))
  const tok = useMemo<Col[]>(
    () =>
      days.map((d, di) => {
        const row = series.values[di] ?? []
        return { date: d.date, total: row.reduce((a, b) => a + b, 0), stacks: series.models.map((m, i) => ({ label: m, value: row[i] ?? 0, color: colorOf(i, m) })) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, series]
  )
  const spend = useMemo<Col[]>(() => days.map((d) => ({ date: d.date, total: d.costUsd ?? 0, stacks: [{ label: 'spend', value: d.costUsd ?? 0, color: 'var(--series-1)' }] })), [days])
  const totalRuns = days.reduce((a, d) => a + d.runs, 0)
  const totalCost = days.reduce((a, d) => a + (d.costUsd ?? 0), 0)
  const totalTok = days.reduce((a, d) => a + d.tokens, 0)
  return (
    <div className="activity">
      <div className="activity__stats">
        <div className="stat">
          <div className="stat__value">{totalRuns}</div>
          <div className="stat__label">runs · 14 days</div>
        </div>
        <div className="stat">
          <div className="stat__value">{successRate == null ? '—' : `${Math.round(successRate * 100)}%`}</div>
          <div className="stat__label">success rate</div>
        </div>
        <div className="stat">
          <div className="stat__value">{totalTok ? tokens(totalTok) : '—'}</div>
          <div className="stat__label">tokens</div>
        </div>
        <div className="stat">
          <div className="stat__value">{totalCost ? money(totalCost) : '—'}</div>
          <div className="stat__label">reported spend</div>
        </div>
      </div>
      <div className="activity__charts">
        <Bars
          title="Runs per day"
          cols={runs}
          fmt={(v) => String(Math.round(v))}
          integer
          legend={[
            { label: 'passed', color: 'var(--status-success)', glyph: '✓' },
            { label: 'failed', color: 'var(--status-failed)', glyph: '✕' },
            ...(days.some((d) => d.runs > d.passed + d.failed) ? [{ label: 'running · canceled', color: 'var(--status-idle)', glyph: '○' }] : [])
          ]}
          empty="No runs in 14 days"
        />
        <Bars title="Tokens per day by model" cols={tok} fmt={tokens} step={1} legend={series.models.map((m, i) => ({ label: m, color: colorOf(i, m) }))} empty="No token usage reported" />
        <div>
          <Bars title="Spend per day" cols={spend} fmt={money} step={0.01} legend={[]} empty="No cost reported" />
          {providers.unpricedTokens && <div className="chart__foot">Gemini and Cursor don’t report cost.</div>}
        </div>
      </div>
    </div>
  )
}
