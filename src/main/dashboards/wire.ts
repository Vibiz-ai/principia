/**
 * DASHBOARDS.md §3: builds the DashboardService over the app's own key storage. Keys are company keys
 * (company_secrets, safeStorage-encrypted, the Keys page lists them) resolved through the vault (company over Shared),
 * so a key the founder already added, like OPENAI_API_KEY from onboarding, is picked up with no re-entry. Saving one
 * refreshes the redaction table and memory's secret fingerprints, like the Keys page does.
 *
 * HIVE_DASHBOARD_FIXTURES=1 (unpackaged builds only) runs every provider on sample data, for development and screenshots.
 */
import { app } from 'electron'
import { departmentsEnabled } from '../../shared/company'
import { CompanySecrets } from '../db/companySecrets'
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import { baseChildEnv } from '../loginEnv'
import type { Cipher } from '../vault'
import { realHttp } from './http'
import { claudeGeoEngine } from './providers'
import { ghCliHttp } from './providers/github'
import { DashboardService, type DashboardKeyStore } from './service'

export function wireDashboards(h: Hive, cipher: Cipher): DashboardService {
  const company = new CompanySecrets(h.db, cipher)
  const keys: DashboardKeyStore = {
    resolve: (names, companyId) => h.vault.resolve(names, companyId),
    lookup: (names, companyId) =>
      names.map((name) => {
        const own = company.get(companyId, name)
        if (own) return { name, source: 'company' as const, masked: own.masked }
        const shared = h.vault.get(name)
        return shared ? { name, source: 'shared' as const, masked: shared.masked } : { name, source: null, masked: null }
      }),
    save: (companyId, name, value, label) => {
      company.set(companyId, name, value, label)
      h.vault.refreshRedactions()
      h.memory?.refreshFingerprints()
      emit('data:changed', { domain: 'secrets' })
    }
  }
  const fixtures = !app.isPackaged && process.env.HIVE_DASHBOARD_FIXTURES === '1'
  if (fixtures) log.warn('dashboards: HIVE_DASHBOARD_FIXTURES is on, every dashboard shows sample data')
  const svc = new DashboardService({
    db: h.db,
    keys,
    enabled: () => departmentsEnabled(h.settings().experimental),
    companyExists: (id) => h.safe(() => !!h.company.passport(id), false),
    departmentCompany: (id) => h.company.departments.get(id)?.companyId ?? null,
    http: realHttp(),
    gh: ghCliHttp(() => baseChildEnv()),
    claudeEngine: () => h.safe(() => claudeGeoEngine(h.engine.providers.cached()), null),
    fixtures,
    onChange: () => emit('data:changed', { domain: 'dashboards' }),
    log
  })
  svc.start()
  app.on('will-quit', () => svc.stop())
  return svc
}
