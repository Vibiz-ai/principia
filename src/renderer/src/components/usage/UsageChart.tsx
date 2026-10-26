/** USAGE.md §1: tokens or dollars per day. One series in white line art, one axis, a tooltip per day. */
import { useState } from 'react'
import type { UsageDay } from '@shared/usage'
import { axisTicks, niceIntMax, niceMax, shortDay } from '../../lib/live'
import { dayValue, moneyLabel, tokenLabel, unpricedDay, type UsageMetric } from '../../lib/usage'

const W = 720
const H = 160
const PAD_L = 44
const PAD_B = 18
const PAD_T = 8

export function UsageChart({ days, metric }: { days: UsageDay[]; metric: UsageMetric }): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const vals = days.map((d) => dayValue(d, metric))
  const top = Math.max(0, ...vals)
  const max = metric === 'tokens' ? niceIntMax(top) : niceMax(top)
  const plotW = W - PAD_L
  const plotH = H - PAD_B - PAD_T
  const slot = plotW / Math.max(days.length, 1)
  const bw = Math.max(3, Math.min(18, slot - 4))
  const y = (v: number): number => PAD_T + plotH - (v / max) * plotH
  const fmt = (v: number): string => (metric === 'tokens' ? tokenLabel(Math.round(v)) : v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`)
  const labelEvery = Math.max(1, Math.ceil(days.length / 8))
  const any = vals.some((v) => v > 0) || (metric === 'cost' && days.some(unpricedDay))
  const hd = hover !== null ? days[hover] : null
  const title = metric === 'tokens' ? 'Tokens per day' : 'Cost per day'
  return (
    <figure className="chart usage-chart" aria-label={title}>
      <div className="chart__plot" onMouseLeave={() => setHover(null)}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {axisTicks(max, metric === 'tokens' ? 1 : 0.01).map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} className="chart__grid" />
              <text x={PAD_L - 6} y={y(v) + 3} className="chart__axis" textAnchor="end">
                {v === 0 ? '0' : fmt(v)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const v = vals[i]!
            const x = PAD_L + i * slot + (slot - bw) / 2
            const h = v > 0 ? Math.max(1.5, y(0) - y(v)) : 0
            const est = metric === 'cost' && d.estimated
            // tokens of a model with no price: a small hollow dashed mark so the "+" in the total has a day
            const unpriced = metric === 'cost' && unpricedDay(d)
            return (
              <g key={d.date} onMouseEnter={() => setHover(i)}>
                <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent" />
                {h > 0 && <rect x={x} y={y(0) - h} width={bw} height={h} rx={2} className={`usage-bar ${est ? 'usage-bar--est' : ''} ${hover === i ? 'is-hover' : ''}`} />}
                {unpriced && <rect x={x} y={Math.max(0, y(0) - h - 9)} width={bw} height={6} rx={1.5} className={`usage-mark--unpriced ${hover === i ? 'is-hover' : ''}`} />}
                {((i % labelEvery === 0 && days.length - 1 - i >= labelEvery / 2) || i === days.length - 1) && (
                  <text x={x + bw / 2} y={H - 4} className="chart__axis" textAnchor="middle">
                    {shortDay(d.date)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {!any && <div className="chart__empty">{metric === 'tokens' ? 'No tokens recorded in this range' : 'No cost recorded in this range'}</div>}
        {hd && any && (
          <div className="chart__tip" style={{ left: `${((PAD_L + (hover ?? 0) * slot + slot / 2) / W) * 100}%` }}>
            <div className="chart__tip-day">{shortDay(hd.date)}</div>
            <div className="chart__tip-row">
              <span className="chart__tip-label">Cost</span>
              <span className="chart__tip-val">{moneyLabel(hd)}</span>
            </div>
            <div className="chart__tip-row">
              <span className="chart__tip-label">Tokens</span>
              <span className="chart__tip-val">{tokenLabel(hd.tokensIn + hd.tokensOut)}</span>
            </div>
            <div className="chart__tip-row">
              <span className="chart__tip-label">Agents</span>
              <span className="chart__tip-val">{hd.agents}</span>
            </div>
          </div>
        )}
      </div>
    </figure>
  )
}
