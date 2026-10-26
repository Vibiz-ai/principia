/**
 * AUTOPILOT.md §7: a company just created starts with Autopilot on. It has no work yet, so nothing starts by itself;
 * the limits stay (tasks at once, the monthly cap, Pause), and turning it off is one click. Companies that already
 * exist keep their switch. Personal, an archived company and one that already holds tasks are left as they are.
 */
import type { CompanyPassport } from '../../shared/company'
import type { CompanyStore } from './index'

export function newCompanyAutopilotOn(c: CompanyStore, p: CompanyPassport): CompanyPassport {
  if (p.system === 'personal' || p.archivedAt) return p
  try {
    if (c.listTasks(p.id).length) return p
    c.setAutopilot(p.id, true)
    return c.passport(p.id)
  } catch {
    return p
  }
}
