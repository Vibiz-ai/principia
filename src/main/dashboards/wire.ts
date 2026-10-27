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
import { keyAliases, serviceForKey } from '../../shared/services'
import { connectionsChanged, resolveWithAliases } from '../connections/wire'

export function wireDashboards(h: Hive, cipher: Cipher): DashboardService {
  const company = new CompanySecrets(h.db, cipher)
  const keys: DashboardKeyStore = {
    // CONNECTIONS.md §2: a key saved under an older name of the same service (POSTHOG_API_KEY) counts too
    resolve: (names, companyId) => {
      const own = resolveWithAliases((n, c) => h.vault.resolve(n, c), names, companyId)
      const missing = names.filter((n) => !own[n])
      if (!missing.length || !h.connections) return own
      // a service this company uses from another company ("Also use in…") reads that company's key, never a copy
      const extra: Record<string, string> = {}
      for (const n of missing) {
        const svc = serviceForKey(n)
        const from = svc ? h.safe(() => h.connections!.status(companyId, svc.id).sharedFrom?.companyId ?? null, null) : null
        if (from) Object.assign(extra, resolveWithAliases((x, c) => h.vault.resolve(x, c), [n], from))
      }
      return { ...extra, ...own }
    },
    lookup: (names, companyId) =>
      names.map((name) => {
        for (const n of [name, ...keyAliases(name)]) {
          const own = company.get(companyId, n)
          if (own) return { name, source: 'company' as const, masked: own.masked }
        }
        for (const n of [name, ...keyAliases(name)]) {
          const shared = h.vault.get(n)
          if (shared) return { name, source: 'shared' as const, masked: shared.masked }
        }
        return { name, source: null, masked: null }
      }),
    save: (companyId, name, value, label) => {
      company.set(companyId, name, value, label)
      h.vault.refreshRedactions()
      h.memory?.refreshFingerprints()
      emit('data:changed', { domain: 'secrets' })
      connectionsChanged(companyId)
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
    // CONNECTIONS.md §4.3: the company's working sign-in to the service (a real MCP connection, never a key-backed one)
    mcp: (companyId, serviceId) => {
      const gw = h.gateway
      if (!gw || !h.connections) return null
      const st = h.safe(() => h.connections!.status(companyId, serviceId), null)
      // SEC-1: only a connection at PostHog's own URL feeds numbers, never a look-alike the founder linked for agents
      const ev = st?.forms.find((f) => f.kind === 'mcp' && f.state === 'connected' && !f.virtual && f.exact && f.connectionId)
      if (!ev) return null
      const id = ev.connectionId!
      return { tools: () => gw.toolNames(id), call: (tool, args) => gw.callTool(id, tool, args) }
    },
    claudeEngine: () => h.safe(() => claudeGeoEngine(h.engine.providers.cached()), null),
    fixtures,
    // CONN-QA-01 / QP-7: an add-dashboard check that turns down the company's saved key marks the service on every
    // surface (a missing permission marks only the dashboard); a check that passes clears it
    onKeyVerdict: (companyId, def, v) => {
      const r = h.connections
      if (!r) return
      const names = def.keys.filter((k) => k.required).map((k) => k.name)
      for (const sid of def.services) {
        if (v.ok) {
          if (h.safe(() => r.clearKeyProblems(companyId, sid, names), false)) connectionsChanged(companyId, sid)
          continue
        }
        const reason = v.code === 'invalid_key' ? `${def.provider} turned down the key: ${v.message}` : v.message
        for (const n of names) h.safe(() => r.recordKeyProblem(companyId, sid, n, reason, v.code === 'forbidden' ? 'dashboard' : undefined), undefined)
        connectionsChanged(companyId, sid)
      }
    },
    onChange: (companyId) => {
      emit('data:changed', { domain: 'dashboards' })
      // a turned-down key shows on the service's card; a new dashboard shows in its "Used by", and its non-secret
      // settings (PostHog's host and project) become the service's, for every other surface
      h.safe(() => h.connections?.backfill([companyId], svc.store.list(companyId)), undefined)
      connectionsChanged(companyId)
    },
    log
  })
  svc.start()
  app.on('will-quit', () => svc.stop())
  return svc
}
