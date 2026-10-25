import { PERSONAL_COMPANY_ID } from '../shared/company'
import type { Id } from '../shared/types'
/** COMPANY.md §7: running sessions + runs and queued runs per company, so a focused company's status bar shows its own. */
export function activeByCompany(runs: readonly { status: string; companyId?: Id | null }[], sessions: Record<Id, number>): Record<Id, { running: number; queued: number }> {
  const out: Record<Id, { running: number; queued: number }> = {}
  const at = (c: Id) => (out[c] ??= { running: 0, queued: 0 })
  for (const [c, n] of Object.entries(sessions)) at(c).running += n
  for (const r of runs) {
    const c = r.companyId || PERSONAL_COMPANY_ID
    if (r.status === 'running') at(c).running++
    else if (r.status === 'queued') at(c).queued++
  }
  return out
}
