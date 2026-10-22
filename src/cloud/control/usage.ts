/** Usage ledger aggregation (CLOUD.md §10.2): runs and run minutes from cloud_runs, tokens and API dollars from usage. */
import type { UsageSummary } from '../../shared/cloud'
import type { ControlDb } from './db'

export function usageSummary(db: ControlDb, from: Date, to: Date, now: Date): UsageSummary {
  const f = from.toISOString(); const t = to.toISOString()
  const byCompany = new Map<string, UsageSummary['companies'][number]>()
  const get = (cid: string) => {
    let c = byCompany.get(cid)
    if (!c) { c = { companyId: cid, runs: 0, runMinutes: 0, apiUsd: 0, inputTokens: 0, outputTokens: 0 }; byCompany.set(cid, c) }
    return c
  }
  for (const r of db.all<{ company_id: string; created_at: string; started_at: string | null; ended_at: string | null }>(
    'SELECT company_id, created_at, started_at, ended_at FROM cloud_runs WHERE (created_at >= ? AND created_at < ?) OR (started_at IS NOT NULL AND started_at < ? AND (ended_at IS NULL OR ended_at > ?))', f, t, t, f)) {
    const c = get(r.company_id)
    if (r.created_at >= f && r.created_at < t) c.runs++
    if (r.started_at) {
      const s = Math.max(Date.parse(r.started_at), from.getTime())
      const e = Math.min(r.ended_at ? Date.parse(r.ended_at) : now.getTime(), to.getTime())
      if (e > s) c.runMinutes += (e - s) / 60_000
    }
  }
  for (const u of db.all<{ company_id: string; input_tokens: number; output_tokens: number; usd: string | null }>('SELECT company_id, input_tokens, output_tokens, usd FROM usage WHERE at >= ? AND at < ?', f, t)) {
    const c = get(u.company_id)
    c.inputTokens += u.input_tokens
    c.outputTokens += u.output_tokens
    if (u.usd !== null) c.apiUsd += Number(u.usd)
  }
  const round = (n: number, p: number) => Math.round(n * p) / p
  return { from: f, to: t, companies: [...byCompany.values()].sort((a, b) => a.companyId.localeCompare(b.companyId)).map(c => ({ ...c, runMinutes: round(c.runMinutes, 10), apiUsd: round(c.apiUsd, 10_000) })) }
}
