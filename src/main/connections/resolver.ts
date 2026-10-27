/**
 * CONNECTIONS.md §3.2: the one answer to "does this company have PostHog?" for every surface. It reads what is already
 * stored (key names in the vault and company_secrets, gateway connections, accounts, Slack, Linear) plus the
 * company_connections choices, and runs the shared status rules (shared/services.ts). `status` / `list` are
 * renderer-safe (names, states, masked forms). `credentialsFor` and `virtuals` stay in main: no IPC returns them and their
 * values are never logged (every value is already in the vault's redaction table). No Electron imports.
 */
import type { CompanyAccounts } from '../../shared/company'
import { connectionsFor, type GatewayConnection } from '../../shared/gateway'
import { HiveError } from '../../shared/errors'
import { connectLink } from '../../shared/deepLink'
import {
  SERVICE_REGISTRY,
  bearerKeyEvidence,
  bearerUrl,
  checkSetting,
  foldAliases,
  keyAliases,
  keyForms,
  mcpForm,
  serviceById,
  serviceForConnection,
  serviceStatus,
  virtualConnectionId,
  withAliases,
  type CompanyHoldings,
  type KeyPresence,
  type Purpose,
  type ServiceChoice,
  type ServiceDef,
  type ServiceStatus,
  type UsageRef
} from '../../shared/services'
import type { ConnectionRow, ConnectionStore } from './store'

export interface ResolverCompany {
  id: string
  name: string
  personal?: boolean
  accounts?: CompanyAccounts | null
}

export interface ResolverDeps {
  store: ConnectionStore
  company(id: string): ResolverCompany | null
  /** every key name this company can read, with where it resolves from and its masked form (no values) */
  keyNames(companyId: string): KeyPresence[]
  /** main only: values for these names in this company (company over Shared). Never crosses IPC. */
  keyValues(names: string[], companyId: string): Record<string, string>
  gateway(): readonly GatewayConnection[]
  slack(): CompanyHoldings['slack']
  linear(companyId: string): CompanyHoldings['linear']
  gh?(): CompanyHoldings['gh']
  /** key names a dashboard was turned down with (invalid_key): name → plain reason. The key is off for everything. */
  keyProblems?(companyId: string): Record<string, string>
  /** key names a dashboard lacks a permission with (forbidden): name → purpose → reason. Only that purpose is off. */
  scopeProblems?(companyId: string): Record<string, Partial<Record<Purpose, string>>>
  /** every company (not archived), for "Use the one from Ledgerline" */
  companies?(): ResolverCompany[]
  /** what uses this service in this company ("Marketing dashboard", "3 agents") */
  usage?(companyId: string, service: ServiceDef, status: Omit<ServiceStatus, 'usedBy' | 'link'>): UsageRef[]
}

/** A key-backed MCP connection (CONNECTIONS.md §3.3): built from the saved key at call time, never stored. */
export interface VirtualConnection {
  id: string
  serviceId: string
  name: string
  url: string
  /** the Authorization header, read at call time (main only) */
  headers(): Record<string, string>
  /** changes when the key changes (the gateway keeps one client per fingerprint) */
  fingerprint: string
  /** the key names it is built from (canonical and older): a spawn gets it only when its profile may read one of them */
  keyNames: string[]
}

export type Credentials =
  | { via: 'key'; values: Record<string, string>; settings: Record<string, string> }
  | { via: 'mcp'; connectionId: string }
  | { via: 'mcpKey'; url: string; headers: Record<string, string> }
  | { via: 'account'; handle: string }
  | { via: 'connector' }

const hash = (s: string): string => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

export class ConnectionResolver {
  constructor(private d: ResolverDeps) {}

  /** What one company holds, for the status rules (names only, plus refuse checks run here in main). */
  holdings(companyId: string): CompanyHoldings {
    const co = this.d.company(companyId)
    const keys = this.d.keyNames(companyId)
    const problems: Record<string, string> = { ...(this.d.keyProblems?.(companyId) ?? {}) }
    const scopes: Record<string, Partial<Record<Purpose, string>>> = {}
    for (const [name, by] of Object.entries(this.d.scopeProblems?.(companyId) ?? {})) scopes[name] = { ...by }
    // what a vendor turned down outside a dashboard's refresh (an add-dashboard check, an agent's call), recorded per service
    for (const row of this.d.store.list(companyId)) {
      for (const [name, p] of Object.entries(row.keyProblems)) {
        if (p.purpose) (scopes[name] ??= {})[p.purpose] ??= p.reason
        else problems[name] ??= p.reason
      }
    }
    // refuse patterns (a PostHog project key, a Stripe secret key where a restricted one belongs) are checked on the value
    // here; only the reason leaves main
    const names = new Set(keys.filter((k) => k.source).map((k) => k.name))
    const checks: { name: string; pattern: string; reason: string }[] = []
    for (const s of SERVICE_REGISTRY)
      for (const f of keyForms(s))
        for (const k of f.keys)
          for (const r of k.refuse ?? []) for (const n of [k.name, ...keyAliases(k.name)]) if (names.has(n)) checks.push({ name: n, pattern: r.pattern, reason: r.reason })
    if (checks.length) {
      const values = this.d.keyValues([...new Set(checks.map((c) => c.name))], companyId)
      for (const c of checks) {
        const v = values[c.name]
        try {
          if (v && new RegExp(c.pattern).test(v.trim())) problems[c.name] ??= c.reason
        } catch {
          /* a bad pattern never blocks */
        }
      }
    }
    return {
      companyId,
      keys,
      connections: this.d.gateway(),
      accounts: co?.personal ? null : (co?.accounts ?? null),
      gh: this.d.gh?.() ?? 'unknown',
      slack: this.d.slack(),
      linear: this.d.linear(companyId),
      keyProblems: problems,
      scopeProblems: scopes
    }
  }

  private choice(row: ConnectionRow | null): ServiceChoice | undefined {
    if (!row) return undefined
    const src = row.sourceCompanyId ? this.d.company(row.sourceCompanyId) : null
    return { mcpConnectionId: row.mcpConnectionId, mcpConfirmed: row.mcpConfirmed, settings: row.settings, sourceCompany: src ? { companyId: src.id, name: src.name } : null, hidden: row.hidden, keyChoice: row.keyChoice }
  }

  private statusWith(companyId: string, s: ServiceDef, hold: CompanyHoldings, sources: Map<string, CompanyHoldings>, withUsage = true): ServiceStatus {
    const row = this.d.store.get(companyId, s.id)
    const choice = this.choice(row)
    let source: CompanyHoldings | null = null
    if (row?.sourceCompanyId && row.sourceCompanyId !== companyId && this.d.company(row.sourceCompanyId)) {
      source = sources.get(row.sourceCompanyId) ?? this.holdings(row.sourceCompanyId)
      sources.set(row.sourceCompanyId, source)
      // SEC-6: the source decides where its key is sent: a reusing company reads the source's host and project, never its own
      const srcRow = this.d.store.get(row.sourceCompanyId, s.id)
      choice!.settings = { ...(srcRow?.settings ?? {}) }
    }
    const st = serviceStatus(s, hold, choice, source)
    const usedBy = withUsage && (st.state === 'connected' || st.state === 'attention') ? this.safeUsage(companyId, s, st) : []
    // the companies that read this company's connection ("Also use in…") use it too
    if (withUsage) {
      for (const b of this.d.store.borrowers(companyId, s.id)) {
        const co = this.d.company(b.companyId)
        if (co) usedBy.push({ kind: 'company', label: `${co.name} (shared)`, id: co.id })
      }
    }
    return { ...st, usedBy, link: connectLink(s.id, companyId) }
  }

  private safeUsage(companyId: string, s: ServiceDef, st: Omit<ServiceStatus, 'usedBy' | 'link'>): UsageRef[] {
    try {
      return this.d.usage?.(companyId, s, st) ?? []
    } catch {
      return []
    }
  }

  private requireCompany(companyId: string): void {
    if (!this.d.company(companyId)) throw new HiveError('not_found', 'Company not found')
  }

  status(companyId: string, serviceId: string): ServiceStatus {
    this.requireCompany(companyId)
    const s = serviceById(serviceId)
    if (!s) throw new HiveError('bad_request', 'Unknown service')
    return this.statusWith(companyId, s, this.holdings(companyId), new Map())
  }

  /**
   * Every registry service for one company, registry order. `usage: false` skips "Used by" (for callers that are
   * themselves a usage source, like the playbooks' connection check).
   */
  list(companyId: string, opts: { usage?: boolean } = {}): ServiceStatus[] {
    this.requireCompany(companyId)
    const hold = this.holdings(companyId)
    const sources = new Map<string, CompanyHoldings>()
    return SERVICE_REGISTRY.map((s) => this.statusWith(companyId, s, hold, sources, opts.usage !== false))
  }

  /**
   * CONNECTIONS.md §4.3 S18: one short block for a company's chats and runs naming what is connected and how agents
   * reach it, so they use it instead of asking the founder to connect it again. Names only; null when nothing is.
   */
  contextBlock(companyId: string): string | null {
    let list: ServiceStatus[]
    try {
      list = this.list(companyId, { usage: false })
    } catch {
      return null
    }
    const on = list.filter((st) => st.state === 'connected')
    if (!on.length) return null
    const how = (st: ServiceStatus): string => {
      const bits: string[] = []
      const mcp = st.forms.find((f) => f.kind === 'mcp' && f.state === 'connected')
      if (mcp) bits.push(`Principia's tools (principia_list_tools, connection ${mcp.connectionId})`)
      // SEC-8: a key another company lends is never in this company's environment; an own key only when the profile allows it
      const keys = st.forms.filter((f) => f.kind === 'key' && f.state === 'connected' && !f.reused).flatMap((f) => f.keyNames?.map((k) => k.name) ?? [])
      if (keys.length) bits.push(`env ${[...new Set(keys)].join(', ')} if your profile includes it`)
      if (st.forms.some((f) => f.kind === 'account' && f.state === 'connected')) bits.push('account')
      if (st.forms.some((f) => f.kind === 'connector' && f.state === 'connected')) bits.push('Principia connector')
      const does = Object.values(st.purposes).filter((p) => p?.ok).map((p) => p!.label.toLowerCase())
      return `${st.name} (${bits.join('; ')}${does.length ? ` — ${does.join(', ')}` : ''})`
    }
    let line = on.map(how).join('; ')
    if (line.length > 900) line = `${line.slice(0, 899)}…`
    return `## Connected services (this company)\n${line}.\nUse these directly, through Principia's tools: never another MCP server or tool for the same service (it may be another company's account). Do not ask the founder to connect them again or to paste a key in chat.`
  }

  isConnected(companyId: string, serviceId: string, purpose?: Purpose): boolean {
    try {
      const st = this.status(companyId, serviceId)
      if (st.state !== 'connected') return false
      return purpose ? !!st.purposes[purpose]?.ok : true
    } catch {
      return false
    }
  }

  /** The company whose keys serve this one for `serviceId` (itself, or the company it reuses from). */
  private keyCompany(companyId: string, serviceId: string): string {
    const row = this.d.store.get(companyId, serviceId)
    if (row?.sourceCompanyId && row.sourceCompanyId !== companyId && this.d.company(row.sourceCompanyId)) {
      const own = this.d.keyNames(companyId).filter((k) => k.source)
      const names = new Set(own.map((k) => k.name))
      const s = serviceById(serviceId)
      const hasOwn = s ? keyForms(s).some((f) => f.keys.filter((k) => k.required).every((k) => names.has(k.name) || keyAliases(k.name).some((a) => names.has(a)))) : false
      return hasOwn ? companyId : row.sourceCompanyId
    }
    return companyId
  }

  /**
   * Main only, never over IPC (CONNECTIONS.md §7). Values for a purpose, or how the gateway serves it. Throws
   * not_connected with the connect link when nothing serves it.
   */
  credentialsFor(companyId: string, serviceId: string, purpose: Purpose): Credentials {
    const st = this.status(companyId, serviceId)
    const s = serviceById(serviceId)!
    const p = st.purposes[purpose]
    if (!p?.ok) throw new HiveError('not_connected', `${s.name} is not connected for this purpose. Connect it here: ${connectLink(s.id, companyId, purpose)}`)
    if (p.via === 'key') {
      const choice = this.d.store.get(companyId, serviceId)?.keyChoice?.[purpose]
      const names = keyForms(s)
        .filter((f) => !f.serves || f.serves.includes(purpose))
        .flatMap((f) => f.keys.map((k) => k.name))
      const ordered = choice && names.includes(choice) ? [choice, ...names.filter((n) => n !== choice)] : names
      const from = this.keyCompany(companyId, serviceId)
      const values = foldAliases(ordered, this.d.keyValues(withAliases(ordered), from))
      return { via: 'key', values, settings: st.settings }
    }
    if (p.via === 'mcp') {
      const ev = st.forms.find((f) => f.kind === 'mcp' && f.state === 'connected')!
      if (ev.virtual) {
        const v = this.virtuals(companyId).find((x) => x.serviceId === serviceId)
        if (!v) throw new HiveError('not_connected', `${s.name} is not connected for this purpose`)
        return { via: 'mcpKey', url: v.url, headers: v.headers() }
      }
      return { via: 'mcp', connectionId: ev.connectionId! }
    }
    if (p.via === 'account') {
      const form = s.forms.find((f) => f.kind === 'account')
      const handle = form?.kind === 'account' ? this.d.company(companyId)?.accounts?.[form.account]?.handle : undefined
      return { via: 'account', handle: handle ?? '' }
    }
    return { via: 'connector' }
  }

  /**
   * CONNECTIONS.md §3.3: for each service whose vendor MCP takes a saved key as a bearer, and that has no working MCP
   * connection of its own here, the connection the gateway builds from the key at call time.
   */
  virtuals(companyId: string | null): VirtualConnection[] {
    if (!companyId || !this.d.company(companyId)) return []
    let list: ServiceStatus[]
    try {
      list = this.list(companyId, { usage: false })
    } catch {
      return []
    }
    const out: VirtualConnection[] = []
    for (const st of list) {
      const v = st.forms.find((f) => f.virtual && f.state === 'connected')
      if (!v) continue
      const s = serviceById(st.serviceId)!
      const bearer = mcpForm(s)?.bearerFromKey
      if (!bearer) continue
      // the key the status found (its real stored name), from the company that holds it
      const held = bearerKeyEvidence(s, st.forms)
      if (!held) continue
      const from = this.keyCompany(companyId, s.id)
      const names = [bearer.key]
      const read = (): string => foldAliases(names, this.d.keyValues(withAliases(names), from))[bearer.key] ?? ''
      const value = read()
      if (!value) continue
      const url = bearerUrl(s, st.settings)
      if (!url) continue
      out.push({
        id: virtualConnectionId(s.id),
        serviceId: s.id,
        name: s.name,
        url,
        keyNames: withAliases(names),
        fingerprint: hash(`${url}\n${value}`),
        headers: () => {
          const now = read()
          if (!now) throw new HiveError('not_connected', `${s.name}'s key was removed`)
          return { Authorization: `Bearer ${now.trim()}` }
        }
      })
    }
    return out
  }

  // ---------- writes (choices only) ----------

  settings(companyId: string, serviceId: string, settings: Record<string, string>): void {
    this.requireCompany(companyId)
    const s = serviceById(serviceId)
    if (!s) throw new HiveError('bad_request', 'Unknown service')
    const row = this.d.store.get(companyId, serviceId)
    const src = row?.sourceCompanyId ? this.d.company(row.sourceCompanyId) : null
    // SEC-6: where a borrowed key is sent is the lending company's choice
    if (src && Object.values(settings).some((v) => v !== '')) throw new HiveError('validation', `${s.name}’s settings come from ${src.name}, whose connection this company uses. Change them in ${src.name}.`)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(settings)) {
      const f = (s.settings ?? []).find((x) => x.key === k)
      if (!f) continue
      const r = checkSetting(f, v)
      if ('error' in r) throw new HiveError('validation', r.error, [{ path: `settings.${k}`, message: r.error }])
      out[k] = r.value
    }
    this.d.store.patch(companyId, serviceId, { settings: out })
  }

  /** The company's own settings check, without saving (connectKey checks before it stores anything). */
  checkSettings(serviceId: string, settings: Record<string, string>): Record<string, string> {
    const s = serviceById(serviceId)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(settings)) {
      const f = (s?.settings ?? []).find((x) => x.key === k)
      if (!f) continue
      const r = checkSetting(f, v)
      if ('error' in r) throw new HiveError('validation', r.error, [{ path: `settings.${k}`, message: r.error }])
      if (r.value) out[k] = r.value
    }
    return out
  }

  /** "Looks like PostHog?" → Use it: the founder says this saved connection is the service here (agent tools only). */
  confirmConnection(companyId: string, serviceId: string, connectionId: string | null): void {
    this.requireCompany(companyId)
    if (!serviceById(serviceId)) throw new HiveError('bad_request', 'Unknown service')
    if (connectionId && !this.d.gateway().some((c) => c.id === connectionId && (!c.companyIds?.length || c.companyIds.includes(companyId)))) throw new HiveError('not_found', 'Connection not found')
    this.d.store.patch(companyId, serviceId, { mcpConnectionId: connectionId, mcpConfirmed: !!connectionId })
  }

  /** A vendor turned a key down outside a refresh (an add-dashboard check, an agent's call): every surface shows it. */
  recordKeyProblem(companyId: string, serviceId: string, keyName: string, reason: string, purpose?: Purpose): void {
    if (!this.d.company(companyId) || !serviceById(serviceId)) return
    const row = this.d.store.get(companyId, serviceId)
    this.d.store.patch(companyId, serviceId, { keyProblems: { ...(row?.keyProblems ?? {}), [keyName]: { reason, at: new Date().toISOString(), ...(purpose ? { purpose } : {}) } } })
  }

  /** A key was replaced or checked fine again: its recorded problems go (`names` absent = every key of the service). */
  clearKeyProblems(companyId: string, serviceId: string, names?: string[]): boolean {
    const row = this.d.store.get(companyId, serviceId)
    if (!row || !Object.keys(row.keyProblems).length) return false
    const drop = new Set(names ? withAliases(names) : Object.keys(row.keyProblems))
    const next = Object.fromEntries(Object.entries(row.keyProblems).filter(([n]) => !drop.has(n)))
    if (Object.keys(next).length === Object.keys(row.keyProblems).length) return false
    this.d.store.patch(companyId, serviceId, { keyProblems: next })
    return true
  }

  /**
   * CONN-QA-07: the founder's other companies that have this service connected themselves (a key or a sign-in, not
   * borrowed), for "Use the one from Ledgerline". Never Personal.
   */
  sources(companyId: string, serviceId: string): { companyId: string; name: string }[] {
    this.requireCompany(companyId)
    const s = serviceById(serviceId)
    if (!s || !this.d.companies) return []
    const out: { companyId: string; name: string }[] = []
    for (const co of this.d.companies()) {
      if (co.id === companyId || co.personal) continue
      if (this.d.store.get(co.id, serviceId)?.sourceCompanyId) continue
      const st = serviceStatus(s, this.holdings(co.id), this.choice(this.d.store.get(co.id, serviceId)))
      if (st.state === 'connected' && st.forms.some((f) => (f.kind === 'key' || (f.kind === 'mcp' && f.exact && !f.virtual)) && f.state === 'connected' && !f.keyNames?.some((k) => k.source === 'shared'))) out.push({ companyId: co.id, name: co.name })
    }
    return out
  }

  /** The gateway connection that serves this service here (connections:signIn made or found it). */
  linkConnection(companyId: string, serviceId: string, connectionId: string): void {
    this.requireCompany(companyId)
    this.d.store.patch(companyId, serviceId, { mcpConnectionId: connectionId })
  }

  chooseKey(companyId: string, serviceId: string, purpose: Purpose, keyName: string): void {
    this.requireCompany(companyId)
    const s = serviceById(serviceId)
    if (!s) throw new HiveError('bad_request', 'Unknown service')
    const allowed = keyForms(s).filter((f) => !f.serves || f.serves.includes(purpose)).flatMap((f) => f.keys.map((k) => k.name))
    if (!allowed.includes(keyName)) throw new HiveError('validation', `${keyName} is not a ${s.name} key for that`)
    const row = this.d.store.get(companyId, serviceId)
    this.d.store.patch(companyId, serviceId, { keyChoice: { ...(row?.keyChoice ?? {}), [purpose]: keyName } })
  }

  unchooseKey(companyId: string, serviceId: string, purpose: Purpose): void {
    this.requireCompany(companyId)
    const row = this.d.store.get(companyId, serviceId)
    if (!row?.keyChoice[purpose]) return
    const { [purpose]: _drop, ...rest } = row.keyChoice
    this.d.store.patch(companyId, serviceId, { keyChoice: rest })
  }

  /**
   * SEC-1 / SEC-2 / SEC-5: exactly what Disconnect removes here. Keys: this company's own, under every name of the
   * service (POSTHOG_API_KEY too). Connections: the ones that ARE the service here (its exact URL, or the one the founder
   * confirmed) and belong to this company, never a look-alike by name. Borrowers: the companies that lose it too.
   */
  disconnectPlan(companyId: string, serviceId: string, ownKey: (name: string) => boolean): { keys: string[]; connections: GatewayConnection[]; borrowers: { companyId: string; name: string }[]; status: ServiceStatus } {
    const st = this.status(companyId, serviceId)
    const s = serviceById(serviceId)!
    const keys = withAliases(keyForms(s).flatMap((f) => f.keys.map((k) => k.name))).filter(ownKey)
    const linked = new Set(st.forms.filter((f) => f.kind === 'mcp' && !f.virtual && !f.reused && f.connectionId).map((f) => f.connectionId!))
    const connections = connectionsFor(this.d.gateway(), companyId).filter((c) => linked.has(c.id) && !!c.companyIds?.includes(companyId))
    const borrowers = st.usedBy.filter((u) => u.kind === 'company' && u.id).map((u) => ({ companyId: u.id!, name: u.label.replace(/ \(shared\)$/, '') }))
    return { keys, connections, borrowers, status: st }
  }

  /** "Also use in…": this company reads `from`'s connection (a reference, never a copy). `from: null` stops it. */
  reuse(companyId: string, serviceId: string, from: string | null): void {
    this.requireCompany(companyId)
    if (!serviceById(serviceId)) throw new HiveError('bad_request', 'Unknown service')
    if (from !== null) {
      if (from === companyId) throw new HiveError('validation', 'A company cannot reuse its own connection')
      const src = this.d.company(from)
      if (!src) throw new HiveError('not_found', 'Company not found')
      if (src.personal) throw new HiveError('validation', 'Personal has no connections to share')
      // SEC-7: Personal stays apart from the portfolio: it never reads a company's connection
      if (this.d.company(companyId)?.personal) throw new HiveError('validation', 'Personal can’t use a company’s connection. Connect it in Personal itself.')
      const srcRow = this.d.store.get(from, serviceId)
      if (srcRow?.sourceCompanyId) throw new HiveError('validation', `That company reuses it from another company: reuse it from there`)
      // SEC-7: nothing to lend is not a dormant link that wakes up when the source connects later
      if (!this.sources(companyId, serviceId).some((x) => x.companyId === from)) throw new HiveError('validation', `${src.name} has no ${serviceById(serviceId)!.name} connection of its own to share.`)
    }
    this.d.store.patch(companyId, serviceId, { sourceCompanyId: from })
  }

  /**
   * Whether a gateway connection reaches `companyId` through reuse (the gateway's company guard asks): the company
   * reuses that connection's service from a company the connection belongs to.
   */
  reusedConnectionReaches(connectionId: string, companyId: string): boolean {
    const conn = this.d.gateway().find((c) => c.id === connectionId)
    const svc = conn ? serviceForConnection(conn)?.id : undefined
    if (!conn || !svc) return false
    const row = this.d.store.get(companyId, svc)
    if (!row?.sourceCompanyId || !this.d.company(row.sourceCompanyId)) return false
    return !conn.companyIds?.length || conn.companyIds.includes(row.sourceCompanyId)
  }

  /**
   * SEC-9: a company was archived: every company that read one of its connections stops (un-archiving never turns it
   * back on silently). Returns the companies that lost one.
   */
  companyArchived(companyId: string): string[] {
    return this.d.store.clearReuseFrom(companyId)
  }

  /** CONNECTIONS.md §3.5: derive the links once (boot, and after dashboards or connections change). */
  backfill(companyIds: readonly string[], dashboards: readonly { companyId: string; kind: string; config: Record<string, string | string[]> }[]): ReturnType<ConnectionStore['backfill']> {
    return this.d.store.backfill({ companyIds, gateway: this.d.gateway(), dashboards })
  }
}

