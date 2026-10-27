/**
 * CONNECTIONS.md §3: builds the ConnectionResolver over the app's own stores (vault + company_secrets for key names,
 * the gateway, company accounts, Slack, Linear, dashboards for usage and turned-down keys), runs the backfill once at
 * boot, and sends `connections:changed` to the renderer. Key values are read here only for the refuse checks and the
 * gateway's key-backed connections; none is ever returned over IPC or logged.
 */
import { CompanySecrets } from '../db/companySecrets'
import type { Hive } from '../hive'
import { emit } from '../ipc'
import { log } from '../log'
import type { Cipher } from '../vault'
import { dashboardDef } from '../../shared/dashboards'
import { PLAYBOOKS } from '../../shared/autopilotPlaybooks'
import type { KeyPresence, UsageRef } from '../../shared/services'
import { ConnectionResolver } from './resolver'
import { ConnectionStore } from './store'
import { connectionsChanged, setConnectionsSender } from './events'

const when = (at: string | null | undefined): string => (at ? ` on ${new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}` : '')

export function wireConnections(h: Hive, cipher: Cipher): ConnectionResolver {
  const company = new CompanySecrets(h.db, cipher)
  const store = new ConnectionStore(h.db)
  const resolver = new ConnectionResolver({
    store,
    company: (id) => {
      const c = h.safe(() => h.company.scope.get(id), null)
      return c && !c.archivedAt ? { id: c.id, name: c.name, personal: c.system === 'personal', accounts: c.accounts ?? null } : null
    },
    keyNames: (companyId) => {
      const out = new Map<string, KeyPresence>()
      for (const m of h.safe(() => h.vault.list(), [])) out.set(m.name, { name: m.name, source: 'shared', masked: m.masked })
      for (const m of h.safe(() => company.list(companyId), [])) out.set(m.name, { name: m.name, source: 'company', masked: m.masked })
      return [...out.values()]
    },
    // read without marking Shared keys as used (status runs often); company values win over Shared ones
    keyValues: (names, companyId) => {
      const out: Record<string, string> = {}
      for (const n of names) {
        try {
          if (h.vault.get(n)) out[n] = h.vault.reveal(n)
        } catch {
          /* undecryptable or gone: skipped */
        }
      }
      return { ...out, ...h.safe(() => h.vault.resolveCompanyOnly(names, companyId), {}) }
    },
    companies: () =>
      h.safe(() => h.company.listPassports(), [])
        .filter((c) => !c.archivedAt)
        .map((c) => ({ id: c.id, name: c.name, personal: c.system === 'personal', accounts: c.accounts ?? null })),
    gateway: () => h.safe(() => h.gateway?.list() ?? [], []),
    slack: () => {
      if (!h.slack) return 'unavailable'
      const st = h.safe(() => h.slack?.status().state, undefined)
      return st === 'connected' ? 'connected' : st && st !== 'disabled' ? 'set-up' : 'none'
    },
    linear: (companyId) => {
      const st = h.safe(() => h.linear?.status(companyId) ?? null, null)
      return { connected: !!st?.connected, problem: st?.connected && st.state === 'auth' ? (st.message ?? 'Linear turned down the key.') : null }
    },
    // QP-5: a revoked or wrong key (invalid_key) is off for everything; a missing dashboard permission (forbidden) only
    // for the dashboard: agents keep the vendor's tools from the same key
    keyProblems: (companyId) => {
      const out: Record<string, string> = {}
      for (const d of h.safe(() => h.dashboards?.list(companyId) ?? [], [])) {
        if (d.status.state !== 'error' || d.status.code !== 'invalid_key') continue
        const def = dashboardDef(d.kind)
        for (const k of def?.keys ?? []) if (k.required) out[k.name] ??= `${def!.provider} turned down the key${when(d.status.at)}.`
      }
      return out
    },
    scopeProblems: (companyId) => {
      const out: Record<string, Partial<Record<'dashboard', string>>> = {}
      for (const d of h.safe(() => h.dashboards?.list(companyId) ?? [], [])) {
        if (d.status.state !== 'error' || d.status.code !== 'forbidden') continue
        const def = dashboardDef(d.kind)
        for (const k of def?.keys ?? []) if (k.required) (out[k.name] ??= {}).dashboard ??= `${def!.provider} accepted the key but it can’t read what the dashboard needs${when(d.status.at)}. ${d.status.message ?? ''}`.trim()
      }
      return out
    },
    usage: (companyId, s, st) => {
      const refs: UsageRef[] = []
      const deps = new Map(h.safe(() => h.company.departments.list(companyId), []).map((d) => [d.id, d.name]))
      const seen = new Set<string>()
      for (const d of h.safe(() => h.dashboards?.list(companyId) ?? [], [])) {
        if (!dashboardDef(d.kind)?.services.includes(s.id)) continue
        const label = `${(d.departmentId && deps.get(d.departmentId)) || 'Company'} dashboard`
        if (seen.has(label)) continue
        seen.add(label)
        refs.push({ kind: 'dashboard', label, id: d.id })
      }
      if (st.purposes.agentTools?.ok) {
        // QP-12: a Shared key reaches every company's agents, not only this one's
        const sharedOnly = st.forms.filter((f) => f.state === 'connected' && f.kind === 'key').every((f) => f.keyNames?.every((k) => k.source === 'shared')) && !st.forms.some((f) => f.state === 'connected' && f.kind !== 'key' && !f.virtual)
        const n = h.safe(() => h.company.departments.listAgents({ companyId }).filter((a) => !a.archivedAt).length, 0)
        if (sharedOnly && st.forms.some((f) => f.kind === 'key' && f.state === 'connected')) refs.push({ kind: 'agents', label: 'every company’s agents (Shared key)' })
        else if (n) refs.push({ kind: 'agents', label: `${n} agent${n === 1 ? '' : 's'}` })
      }
      for (const p of h.safe(() => h.playbooks?.list(companyId) ?? [], [])) {
        const def = PLAYBOOKS.find((x) => x.id === p.id)
        if (p.on && def?.needs?.connectId === s.id) refs.push({ kind: 'playbook', label: def.name, id: def.id })
      }
      if (s.id === 'linear' && st.forms.some((f) => f.kind === 'connector')) refs.push({ kind: 'sync', label: 'Board sync' })
      if (s.id === 'slack' && st.state === 'connected') refs.push({ kind: 'sync', label: 'Slack threads and alerts' })
      return refs
    }
  })
  setConnectionsSender((p) => emit('connections:changed', p))
  return resolver
}

/** CONNECTIONS.md §3.5: derive the links once at boot, after dashboards are wired (idempotent; logged as counts only). */
export function backfillConnections(h: Hive): void {
  if (!h.connections) return
  try {
    const ids = h.company.listPassports().filter((c) => !c.archivedAt).map((c) => c.id)
    const dashboards = ids.flatMap((id) => h.safe(() => h.dashboards?.store.list(id) ?? [], []))
    log.info('connections: backfill', h.connections.backfill(ids, dashboards))
  } catch (e) {
    log.warn('connections: backfill failed', { e: String(e) })
  }
}

export { resolveWithAliases } from './resolveAliases'
export { connectionsChanged }
