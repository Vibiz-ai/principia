/**
 * docs/USAGE.md §1: usage:summary. Tokens and dollars of every root agent (a run step or a session; its subagents are
 * inside the root's numbers) per local day, company, department and agent seat. One query over hive.db, no Electron.
 *
 * Cost rule (AGENT-COLLAB.md §4, forum/pricing.ts): the CLI's reported cost_usd always wins; a row with tokens only is
 * estimated from the price table and flagged; a model with no price keeps its tokens and adds no dollars (unpriced).
 * Plan limits: only what the engine saw (a rate_limited stop and its reset time). Never a made-up percentage.
 */
import { PERSONAL_COMPANY_ID } from '../../shared/company'
import type { Id } from '../../shared/types'
import type { PlanLimits, UsageBucket, UsageDay, UsageMoney, UsageRange, UsageRow, UsageSummary } from '../../shared/usage'
import type { DB } from '../db'
import { PRICE_SOURCE, costOf } from '../forum/pricing'

export const RANGE_DAYS: Record<UsageRange, number> = { '7d': 7, '30d': 30, '90d': 90 }
export const NO_DEPARTMENT = 'No department'

interface RootRow {
  id: string
  kind: string
  provider: string
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  model_usage_json: string | null
  started_at: string
  company_id: string
  seat_id: string | null
  seat_name: string | null
  seat_dep: string | null
  task_dep: string | null
  sess_dep: string | null
}

/** Dollars for one root: reported cost, else the CLI's per-model split, else the root's model. */
export function rootCost(r: Pick<RootRow, 'model' | 'tokens_in' | 'tokens_out' | 'cost_usd' | 'model_usage_json'>): UsageMoney {
  if (r.cost_usd != null && Number.isFinite(r.cost_usd)) return { usd: r.cost_usd, estimated: false, unpriced: false }
  let split: Record<string, { tokensIn?: number; tokensOut?: number; costUsd?: number | null }> | null = null
  try {
    split = r.model_usage_json ? JSON.parse(r.model_usage_json) : null
  } catch {
    split = null
  }
  const entries = split && typeof split === 'object' ? Object.entries(split) : []
  if (entries.length) {
    let usd: number | null = null
    let estimated = false
    let unpriced = false
    for (const [model, u] of entries) {
      const c = costOf({ model, tokensIn: u?.tokensIn ?? 0, tokensOut: u?.tokensOut ?? 0, costUsd: u?.costUsd ?? null })
      if (c.usd != null) usd = (usd ?? 0) + c.usd
      else if ((u?.tokensIn ?? 0) + (u?.tokensOut ?? 0) > 0) unpriced = true
      if (c.estimated) estimated = true
    }
    return { usd, estimated, unpriced }
  }
  const c = costOf({ model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: null })
  const tokens = (r.tokens_in ?? 0) + (r.tokens_out ?? 0)
  return { usd: c.usd, estimated: c.estimated, unpriced: c.usd == null && tokens > 0 }
}

const empty = (): UsageBucket => ({ usd: null, estimated: false, unpriced: false, tokensIn: 0, tokensOut: 0, agents: 0 })
function add(b: UsageBucket, r: RootRow, m: UsageMoney): void {
  b.agents++
  b.tokensIn += Math.max(0, r.tokens_in ?? 0)
  b.tokensOut += Math.max(0, r.tokens_out ?? 0)
  if (m.usd != null) b.usd = (b.usd ?? 0) + m.usd
  if (m.estimated) b.estimated = true
  if (m.unpriced) b.unpriced = true
}

/** YYYY-MM-DD in local time. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Local midnight `days - 1` days before `now`: the first day of the range. */
export function rangeStart(range: UsageRange, now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() - (RANGE_DAYS[range] - 1))
  return d
}

const tryAll = <T>(db: DB, sql: string, args: unknown[]): T[] => {
  try {
    return db.prepare(sql).all(...args) as T[]
  } catch {
    return [] // an older or fresh db without a table/column
  }
}

/** The latest usage-limit stop the engine recorded (runs, then session roots). */
/**
 * The last rate-limit hit. Limits are account-wide, so the time shows in every scope; the run or session it came from
 * is linked only when it belongs to `companyId` (or in All companies), never another company's run.
 */
export function planLimits(db: DB, companyId: Id | null = null): PlanLimits {
  type Hit = { at: string; reset_at: string | null; run_id?: string; session_id?: string; title: string | null; company_id: string | null }
  const runs = tryAll<Hit>(
    db,
    `SELECT COALESCE(ended_at, started_at, created_at) AS at, reset_at, id AS run_id, title, COALESCE(company_id, '${PERSONAL_COMPANY_ID}') AS company_id FROM runs WHERE stop_reason = 'rate_limited' ORDER BY at DESC LIMIT 1`,
    []
  )
  const agents = tryAll<Hit>(
    db,
    `SELECT updated_at AS at, reset_at, run_id, session_id, title, COALESCE(company_id, '${PERSONAL_COMPANY_ID}') AS company_id FROM agents WHERE stop_reason = 'rate_limited' AND parent_id IS NULL ORDER BY updated_at DESC LIMIT 1`,
    []
  )
  const best = [...runs, ...agents].filter((h) => h.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (!best) return { state: 'unknown', lastHitAt: null, resetAt: null, source: null }
  const ours = !companyId || best.company_id === companyId
  return {
    state: 'seen',
    lastHitAt: best.at,
    resetAt: best.reset_at ?? null,
    source: !ours ? null : { ...(best.run_id ? { runId: best.run_id } : {}), ...(best.session_id ? { sessionId: best.session_id } : {}), ...(best.title ? { title: best.title } : {}) }
  }
}

export interface SummaryDeps {
  db: DB
  companyName(id: Id): string
  now?: () => Date
}

export function usageSummary(d: SummaryDeps, q: { range: UsageRange; companyId?: Id | null }): UsageSummary {
  const now = d.now?.() ?? new Date()
  const start = rangeStart(q.range, now)
  const since = start.toISOString()
  const companyId = q.companyId ?? null
  const rows = tryAll<RootRow>(
    d.db,
    `SELECT a.id, a.kind, a.provider, a.model, a.tokens_in, a.tokens_out, a.cost_usd, a.model_usage_json, a.started_at,
       COALESCE(a.company_id, '${PERSONAL_COMPANY_ID}') AS company_id,
       ca.id AS seat_id, ca.name AS seat_name, ca.department_id AS seat_dep,
       COALESCE((SELECT t.department_id FROM company_tasks t WHERE t.id = r.task_id), (SELECT t.department_id FROM company_tasks t WHERE t.id = s.task_id)) AS task_dep,
       s.department_id AS sess_dep
     FROM agents a
     LEFT JOIN runs r ON r.id = a.run_id
     LEFT JOIN sessions s ON s.id = a.session_id
     LEFT JOIN company_agents ca ON ca.id = r.agent_id
     WHERE a.parent_id IS NULL AND a.started_at >= ? ${companyId ? `AND COALESCE(a.company_id, '${PERSONAL_COMPANY_ID}') = ?` : ''}`,
    companyId ? [since, companyId] : [since]
  )
  const deps = new Map(tryAll<{ id: string; name: string; company_id: string }>(d.db, 'SELECT id, name, company_id FROM company_departments', []).map((x) => [x.id, x]))

  const days = new Map<string, UsageDay>()
  for (let i = 0; i < RANGE_DAYS[q.range]; i++) {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    const key = localDay(day)
    days.set(key, { date: key, ...empty() })
  }
  const total = empty()
  const byCompany = new Map<string, UsageRow>()
  const byDep = new Map<string, UsageRow>()
  const byAgent = new Map<string, UsageRow>()
  const row = (m: Map<string, UsageRow>, key: string, label: string, co: string | null): UsageRow => {
    let x = m.get(key)
    if (!x) m.set(key, (x = { key, label, companyId: co, ...empty() }))
    return x
  }
  for (const r of rows) {
    const money = rootCost(r)
    add(total, r, money)
    const day = days.get(localDay(new Date(r.started_at)))
    if (day) add(day, r, money)
    add(row(byCompany, r.company_id, d.companyName(r.company_id), r.company_id), r, money)
    const depId = r.task_dep ?? r.sess_dep ?? r.seat_dep
    const dep = depId ? deps.get(depId) : undefined
    const depKey = dep ? dep.id : `none:${r.company_id}`
    add(row(byDep, depKey, dep?.name ?? NO_DEPARTMENT, r.company_id), r, money)
    const agentKey = r.seat_id ?? `none:${r.kind === 'session' ? 'session' : 'run'}:${r.company_id}`
    const agentLabel = r.seat_name ?? (r.kind === 'session' ? 'Chats (no agent seat)' : 'Runs (no agent seat)')
    add(row(byAgent, agentKey, agentLabel, r.company_id), r, money)
  }
  const rank = (m: Map<string, UsageRow>): UsageRow[] =>
    [...m.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || a.label.localeCompare(b.label))
  return {
    range: q.range,
    since,
    companyId,
    total,
    days: [...days.values()],
    byCompany: rank(byCompany),
    byDepartment: rank(byDep),
    byAgent: rank(byAgent),
    limits: planLimits(d.db, companyId),
    priceSource: PRICE_SOURCE
  }
}
