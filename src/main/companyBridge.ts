/**
 * COMPANY.md §5, §6: the engine's and sessions' view of the company module. One resolver (scope.ts through
 * CompanyStore) and one guard switch (`settings.experimental.companies`). Pure (no Electron), so tests use the real one.
 */
import type { CompanyBridge } from '../shared/engine'
import type { CompanyStore } from './company'

export function createCompanyBridge(company: CompanyStore, store: { companyGuardsEnforced(): boolean }): CompanyBridge {
  return {
    resolve: (q) => company.resolveCompany(q).company.id,
    crossCompany: (companyId, refs) => company.crossCompany(companyId, refs),
    enforced: () => store.companyGuardsEnforced(),
    workspaceDir: (companyId) => {
      try {
        return company.workspaceDir(companyId)
      } catch {
        return null // in-memory db: no company folders
      }
    },
    repoIds: (companyId) => company.passport(companyId).repoIds
  }
}
