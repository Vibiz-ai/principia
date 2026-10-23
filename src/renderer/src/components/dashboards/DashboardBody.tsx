/**
 * DASHBOARDS.md §9: one dashboard's widgets, drawn from a snapshot: KPI tiles with deltas, line charts in white line
 * art (series told apart by stroke tier and dash, never by a warm colour), and compact tables. Used by the installed
 * panel and by the marketplace preview (sample data).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardDef, DashboardSnapshot, KpiValue, MetricFormat, Series, TableRow, WidgetDef } from '@shared/dashboards'
import { deltaRatio, deltaTone, formatDelta, formatMetric } from '@shared/dashboards'
import { chartGeometry, nearestIndex, shortDate } from '../../lib/dashboards'

export function DashboardBody({ def, snapshot, details = true }: { def: DashboardDef; snapshot: DashboardSnapshot; details?: boolean }): React.JSX.Element {
  const kpis = def.widgets.filter((w): w is Extract<WidgetDef, { kind: 'kpi' }> => w.kind === 'kpi')
  const lines = def.widgets.filter((w): w is Extract<WidgetDef, { kind: 'line' }> => w.kind === 'line')
  const tables = def.widgets.filter((w): w is Extract<WidgetDef, { kind: 'table' }> => w.kind === 'table')
  // a KPI the source could not fill this time (PageSpeed without an answer) is left out rather than shown as a dash
  const shown = kpis.filter((w) => snapshot.kpis[w.id] && snapshot.kpis[w.id].value != null)
  return (
    <div className="dsh-body">
      <div className="dsh-kpis" style={{ ['--dsh-cols' as string]: kpiColumns(shown.length) }}>
        {shown.map((w) => (
          <KpiTile key={w.id} title={w.title} hint={w.hint} format={w.format} good={w.good} kpi={snapshot.kpis[w.id]} currency={snapshot.currency} />
        ))}
      </div>
      {details && (
        <>
          {lines.some((w) => snapshot.series[w.id]?.some((s) => s.points.length)) && (
            <div className="dsh-charts">
              {lines.map((w) => {
                const series = snapshot.series[w.id]
                return series?.some((s) => s.points.length) ? <LineChart key={w.id} title={w.title} series={series} format={w.format} currency={snapshot.currency} /> : null
              })}
            </div>
          )}
          {tables.some((w) => snapshot.tables[w.id]?.length) && (
            <div className="dsh-tables">
              {tables.map((w) => {
                const rows = snapshot.tables[w.id]
                return rows?.length ? <MetricTable key={w.id} title={w.title} columns={w.columns} rows={rows} currency={snapshot.currency} /> : null
              })}
            </div>
          )}
        </>
      )}
      {!!snapshot.warnings?.length && (
        <ul className="dsh-warnings">
          {snapshot.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Columns for n tiles so rows come out even: 1-5 in one row, 6 as 3 + 3, 7-8 as 4 + 4. */
export const kpiColumns = (n: number): number => (n <= 5 ? Math.max(1, n) : n === 6 ? 3 : 4)

export function KpiTile({ title, hint, format, good, kpi, currency }: { title: string; hint?: string; format: MetricFormat; good: 'up' | 'down' | 'neutral'; kpi: KpiValue; currency?: string }): React.JSX.Element {
  const ratio = deltaRatio(kpi.value, kpi.previous)
  const tone = deltaTone(ratio, good)
  const delta = formatDelta(ratio)
  return (
    <div className="dsh-kpi" title={hint}>
      <span className="dsh-kpi__label">{title}</span>
      <span className="dsh-kpi__value">{formatMetric(kpi.value, format, { currency })}</span>
      <span className="dsh-kpi__foot">
        {delta && tone !== 'flat' ? (
          <span className={`dsh-delta dsh-delta--${tone}`} aria-label={`${delta} vs previous`}>
            <span aria-hidden="true">{ratio! >= 0 ? '▲' : '▼'}</span> {delta}
          </span>
        ) : delta && Math.abs(ratio!) >= 0.005 ? (
          <span className="dsh-delta dsh-delta--flat" aria-label={`${delta} vs previous`}>
            {delta}
          </span>
        ) : kpi.previous != null ? (
          <span className="dsh-delta dsh-delta--flat">no change</span>
        ) : null}
        {kpi.previous != null && <span className="dsh-kpi__prev">was {formatMetric(kpi.previous, format, { currency })}</span>}
      </span>
    </div>
  )
}

const H = 132

/** The plot's pixel width, so the SVG is drawn 1:1 (round dots, even strokes) and redrawn on resize. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(420)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function LineChart({ title, series, format, currency }: { title: string; series: Series[]; format: MetricFormat; currency?: string }): React.JSX.Element {
  const [plotRef, W] = useWidth()
  const g = useMemo(() => chartGeometry(series, W, H, { top: 8, right: 6, bottom: 6, left: 6 }), [series, W])
  const [hover, setHover] = useState<number | null>(null)
  const primary = g.lines[0]
  const at = hover != null && primary ? primary.points[hover] : null
  const area = primary && primary.points.length > 1 ? `${primary.d} L${primary.points.at(-1)!.x.toFixed(1)} ${(H - 6).toFixed(1)} L${primary.points[0].x.toFixed(1)} ${(H - 6).toFixed(1)} Z` : null
  return (
    <figure className="dsh-chart">
      <figcaption className="dsh-chart__head">
        <span className="dsh-chart__title">{title}</span>
        <span className="dsh-chart__legend">
          {g.lines.map((l, i) => (
            <span key={l.label} className={`dsh-legend dsh-legend--${i}`}>
              <svg width="18" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="18" y2="3" className={`dsh-line dsh-line--${i}`} />
              </svg>
              {l.label}
              {g.independent && i > 0 && <span className="dsh-chart__own"> (own scale, max {formatMetric(l.max, format, { currency })})</span>}
            </span>
          ))}
        </span>
      </figcaption>
      <div className="dsh-chart__plot" ref={plotRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}: ${g.lines.map((l) => `${l.label} ${formatMetric(l.points.at(-1)?.v, format, { currency })}`).join(', ')}`}
          onMouseMove={(e) => {
            if (!primary) return
            const r = e.currentTarget.getBoundingClientRect()
            setHover(nearestIndex(primary.points, ((e.clientX - r.left) / r.width) * W))
          }}
          onMouseLeave={() => setHover(null)}
        >
          {g.ticks.map((t) => (
            <line key={t.v} x1="0" x2={W} y1={t.y} y2={t.y} className="dsh-grid" />
          ))}
          {area && <path d={area} className="dsh-area" />}
          {g.lines.map((l, i) => (
            <path key={l.label} d={l.d} className={`dsh-line dsh-line--${i}`} />
          ))}
          {g.lines.map((l, i) => {
            // the newest point is marked; a lone point (the first GEO run) would otherwise draw nothing
            const last = l.points.at(-1)
            return last ? <circle key={`p${i}`} cx={last.x} cy={last.y} r={l.points.length === 1 ? 3 : 2} className={`dsh-dot dsh-dot--${i}`} /> : null
          })}
          {at && <line x1={at.x} x2={at.x} y1="0" y2={H} className="dsh-cursor" />}
        </svg>
        <span className="dsh-chart__max">{formatMetric(g.max, format, { currency })}</span>
        {at && (
          <span className="dsh-chart__tip" style={{ left: `${(at.x / W) * 100}%` }}>
            <strong>{shortDate(at.t)}</strong>
            {g.lines.map((l) => (
              <span key={l.label}>
                {l.label} {formatMetric(l.points[hover!]?.v, format, { currency })}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="dsh-chart__axis">
        <span>{g.first ? shortDate(g.first) : ''}</span>
        {g.first === g.last && <span>One point so far; the line fills in with each refresh.</span>}
        <span>{g.last && g.last !== g.first ? shortDate(g.last) : ''}</span>
      </div>
    </figure>
  )
}

export function MetricTable({ title, columns, rows, currency }: { title: string; columns: { key: string; label: string; format?: MetricFormat }[]; rows: TableRow[]; currency?: string }): React.JSX.Element {
  return (
    <div className="dsh-table">
      <div className="dsh-table__title">{title}</div>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.format ? 'is-num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const v = r[c.key]
                return (
                  <td key={c.key} className={c.format ? 'is-num' : undefined} title={typeof v === 'string' ? v : undefined}>
                    {c.format && typeof v === 'number' ? formatMetric(v, c.format, { currency, compact: false }) : v == null ? '—' : String(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
