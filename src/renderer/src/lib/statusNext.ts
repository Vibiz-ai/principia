/**
 * The status bar's "Next" item (five doors §2.6, A2): inside a company its own next fire; in All companies the
 * earliest fire of any company, and whose it is, so it always reads "Next for {company}: …" with two or more companies.
 */
import type { Id, NextFire, StatusSnapshot } from '@shared/types'

export function statusNext(status: Pick<StatusSnapshot, 'nextFire' | 'nextFireByCompany'> | null | undefined, companyId: Id | null): { fire: NextFire; companyId: Id | null } | null {
  if (!status) return null
  const by = status.nextFireByCompany
  if (companyId) {
    const fire = by ? (by[companyId] ?? null) : status.nextFire
    return fire ? { fire, companyId } : null
  }
  if (by) {
    const all = Object.entries(by).sort(([, a], [, b]) => a.at.localeCompare(b.at))
    const first = all[0]
    if (first) return { fire: first[1], companyId: first[0] }
  }
  return status.nextFire ? { fire: status.nextFire, companyId: null } : null
}
