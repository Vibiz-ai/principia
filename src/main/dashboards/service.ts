/**
 * DASHBOARDS.md §3-§6: install, validate, fetch, cache and refresh department dashboards.
 *
 * - **Install** takes the newly pasted keys once (renderer → main), resolves the rest from the company's keys (company
 *   over Shared), runs the provider's real read-only validation call, and only then saves the pasted keys to the
 *   company's keys and creates the row. Nothing is stored when validation fails.
 * - **Fetch** runs in main with keys resolved at that moment; the snapshot (numbers only) is cached on the row. A
 *   failure keeps the last good snapshot and records a fixed-code status.
 * - **Refresh** is scheduled per catalog interval (checked every 5 minutes) with backoff after errors, plus on demand.
 * - **contextFor** gives department agents a short read-only summary of the latest numbers (DASHBOARDS.md §6).
 *
 * No key value ever leaves this module except into the provider call that needs it. No Electron imports.
 */
import type Database from 'better-sqlite3'
import type { DashboardConfig, DashboardDef, DashboardInstallInput, DashboardKeyLookup, DashboardKeyState, DashboardKind, DashboardSnapshot, DashboardStatus, InstalledDashboard } from '../../shared/dashboards'
import { configList, configText, dashboardDef, deltaRatio, formatDelta, formatMetric } from '../../shared/dashboards'
import { HiveError } from '../../shared/errors'
import { DashboardFetchError, type HttpFn } from './http'
import { fixtureGeoEngines, fixtureHttp, sampleKeys, SAMPLE_CONFIG } from './fixtures'
import { appendTrend, openAiEngine, perplexityEngine } from './providers/geo'
import { PROVIDERS } from './providers'
import type { GeoEngine, McpReader, ProviderCtx } from './providers/types'
import { DashboardStore, type DashboardRow } from './store'

export const TICK_MS = 5 * 60_000
/** After these errors the next automatic attempt waits at least this long (a manual refresh always runs). */
const BACKOFF_MIN: Partial<Record<NonNullable<DashboardStatus['code']>, number>> = { rate_limited: 30, invalid_key: 6 * 60, forbidden: 6 * 60, config: 6 * 60, no_data: 3 * 60 }
const FETCH_TIMEOUT_MS: Partial<Record<DashboardKind, number>> = { geo: 10 * 60_000 }
const DEFAULT_FETCH_TIMEOUT_MS = 2 * 60_000
const VALUE_MAX = 64 * 1024

export interface DashboardKeyStore {
  /** Values for `names` in this company (company keys over Shared). Main memory only. */
  resolve(names: string[], companyId: string): Record<string, string>
  /** Where each name resolves from, with its masked form (never the value). */
  lookup(names: string[], companyId: string): DashboardKeyLookup[]
  /** Saves one value to the company's keys (encrypted; redaction tables refresh). */
  save(companyId: string, name: string, value: string, label: string): void
}

export interface DashboardServiceDeps {
  db: Database.Database
  keys: DashboardKeyStore
  /** DEPARTMENTS.md flag pair: dashboards live in department pages, so they follow the same switch. */
  enabled: () => boolean
  companyExists: (companyId: string) => boolean
  /** The department's company, or null when it does not exist. */
  departmentCompany: (departmentId: string) => string | null
  http: HttpFn
  /** `gh api` transport (GitHub without a token), null when unavailable. */
  gh?: HttpFn | null
  /**
   * CONNECTIONS.md §4.3: the company's working sign-in to a service (a saved MCP connection, never a key-backed one), for
   * a dashboard that can read through it when no key is saved. null = none.
   */
  mcp?: (companyId: string, serviceId: string) => McpReader | null
  /** The installed Claude CLI as a GEO engine, null without it. */
  claudeEngine?: () => GeoEngine | null
  /** HIVE_DASHBOARD_FIXTURES: every provider runs on sample data (dev and screenshots only). */
  fixtures?: boolean
  now?: () => Date
  onChange?: (companyId: string) => void
  /**
   * CONN-QA-01: a check of a key the company already has (not one pasted with this check) came back: turned down
   * (`invalid_key` off for everything, `forbidden` off for the dashboard only) or fine again. Every surface shows it.
   */
  onKeyVerdict?: (companyId: string, def: DashboardDef, verdict: { ok: true } | { ok: false; code: 'invalid_key' | 'forbidden'; message: string }) => void
  log?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

/** A safe message for any error (never a raw provider error, which may quote a request). */
function asStatus(e: unknown, at: string): DashboardStatus {
  if (e instanceof DashboardFetchError) return { state: 'error', code: e.code, message: e.message, at }
  if (e instanceof HiveError) return { state: 'error', code: 'config', message: e.message, at }
  return { state: 'error', code: 'unavailable', message: 'The dashboard could not be refreshed. Try again later.', at }
}

export class DashboardService {
  readonly store: DashboardStore
  private inflight = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private now: () => Date
  private sampleHttp: HttpFn

  constructor(private deps: DashboardServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.store = new DashboardStore(deps.db, this.now)
    this.sampleHttp = fixtureHttp(this.now)
  }

  assertEnabled(): void {
    if (!this.deps.enabled()) throw new HiveError('forbidden', 'Dashboards need Companies and Departments (Settings → Experimental).')
  }

  // ---------- reads ----------

  list(companyId: string, departmentId?: string | null): InstalledDashboard[] {
    return this.store.list(companyId, departmentId).map((r) => this.view(r))
  }

  get(id: string): InstalledDashboard {
    return this.view(this.store.get(id))
  }

  /** The install form's view of a kind's keys in this company: which exist and where (masked). */
  lookupKeys(companyId: string, kind: DashboardKind): DashboardKeyLookup[] {
    const def = this.def(kind)
    return this.deps.keys.lookup(def.keys.map((k) => k.name), companyId)
  }

  private view(r: DashboardRow): InstalledDashboard {
    const def = dashboardDef(r.kind)!
    const found = new Map(this.deps.keys.lookup(def.keys.map((k) => k.name), r.companyId).map((l) => [l.name, l.source]))
    const keys: DashboardKeyState[] = def.keys.map((k) => ({ name: k.name, required: k.required, source: found.get(k.name) ?? null }))
    const signIn = !!def.viaSignIn && keys.some((k) => k.required && !k.source) && !!this.deps.mcp?.(r.companyId, def.viaSignIn.service)
    const status: DashboardStatus = this.inflight.has(r.id) ? { ...r.status, state: 'loading' } : r.status
    return { id: r.id, companyId: r.companyId, departmentId: r.departmentId, kind: r.kind, config: r.config, status, snapshot: r.snapshot, keys, via: signIn ? 'signIn' : 'key', createdAt: r.createdAt, updatedAt: r.updatedAt }
  }

  private def(kind: string): DashboardDef {
    const def = dashboardDef(kind)
    if (!def) throw new HiveError('bad_request', 'Unknown dashboard')
    return def
  }

  // ---------- install / update / remove ----------

  /** Only fields the catalog declares, trimmed; lists capped; required ones present. */
  cleanConfig(def: DashboardDef, raw: DashboardConfig, viaSignIn = false): DashboardConfig {
    const out: DashboardConfig = {}
    const optional = new Set(viaSignIn ? (def.viaSignIn?.config ?? []) : [])
    for (const f of def.config) {
      if (f.kind === 'list') {
        const items = configList(raw[f.key]).map((s) => s.slice(0, 300)).slice(0, f.max ?? 20)
        if (items.length) out[f.key] = items
      } else {
        const v = configText(raw[f.key]).slice(0, 300)
        if (v) out[f.key] = v
      }
      if (f.required && !optional.has(f.key) && !out[f.key]) throw new HiveError('validation', `${f.label} is required`, [{ path: `config.${f.key}`, message: `${f.label} is required` }])
    }
    return out
  }

  /** Pasted values for this kind's key names only, trimmed (a JSON key file keeps its inner newlines). */
  private cleanKeys(def: DashboardDef, raw: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const k of def.keys) {
      const v = typeof raw[k.name] === 'string' ? raw[k.name].trim() : ''
      if (!v) continue
      if (v.length > VALUE_MAX) throw new HiveError('validation', `${k.label} is too long`, [{ path: `keys.${k.name}`, message: 'That is too long to be a key' }])
      out[k.name] = v
    }
    return out
  }

  /**
   * Saved keys overlaid with the pasted ones. A required key missing from both is a validation error, unless the
   * dashboard can read through the company's sign-in to its service (CONNECTIONS.md §4.3): then `mcp` is that sign-in.
   * A key always wins over a sign-in.
   */
  private keysFor(def: DashboardDef, companyId: string, pasted: Record<string, string>): { keys: Record<string, string>; mcp: McpReader | null } {
    const r = this.route(def, companyId, pasted)
    this.requireKeys(r)
    return r
  }

  /** keysFor without the check (install and update check the config first, then the keys). */
  private route(def: DashboardDef, companyId: string, pasted: Record<string, string>): { keys: Record<string, string>; mcp: McpReader | null; missing: DashboardDef['keys'] } {
    const keys = this.deps.fixtures ? { ...sampleKeys(def.id), ...this.deps.keys.resolve(def.keys.map((k) => k.name), companyId), ...pasted } : { ...this.deps.keys.resolve(def.keys.map((k) => k.name), companyId), ...pasted }
    const missing = def.keys.filter((k) => k.required && !keys[k.name])
    if (!missing.length) return { keys, mcp: null, missing }
    const mcp = def.viaSignIn ? (this.deps.mcp?.(companyId, def.viaSignIn.service) ?? null) : null
    return { keys, mcp, missing: mcp ? [] : missing }
  }

  private requireKeys(r: { missing: DashboardDef['keys'] }): void {
    const k = r.missing[0]
    if (k) throw new HiveError('validation', `Add your ${k.label}`, [{ path: `keys.${k.name}`, message: `${k.label} is required` }])
  }

  /** Whether this dashboard would read through a sign-in for this company right now (no key, a working sign-in). */
  viaSignIn(kind: DashboardKind, companyId: string): boolean {
    const def = this.def(kind)
    try {
      return !!this.keysFor(def, companyId, {}).mcp
    } catch {
      return false
    }
  }

  private ctx(def: DashboardDef, keys: Record<string, string>, config: DashboardConfig, previous: DashboardSnapshot | null, sample = false, mcp: McpReader | null = null): ProviderCtx {
    const fixtures = sample || !!this.deps.fixtures
    const http = fixtures ? this.sampleHttp : this.deps.http
    return {
      http,
      keys,
      config,
      now: this.now(),
      previous,
      gh: fixtures ? null : (this.deps.gh ?? null),
      mcp: fixtures ? null : mcp,
      geoEngines: () => {
        if (fixtures) return fixtureGeoEngines(config)
        const engines: GeoEngine[] = []
        if (keys.OPENAI_API_KEY) engines.push(openAiEngine(http, keys.OPENAI_API_KEY))
        if (keys.PERPLEXITY_API_KEY) engines.push(perplexityEngine(http, keys.PERPLEXITY_API_KEY))
        const claude = this.deps.claudeEngine?.()
        if (claude) engines.push(claude)
        return engines
      }
    }
  }

  /**
   * Runs the provider's validation; failures become a validation error with the safe message. `saved`: the company
   * key was not pasted with this check, so a verdict on it is the connection's (onKeyVerdict).
   */
  private async validate(def: DashboardDef, keys: Record<string, string>, config: DashboardConfig, mcp: McpReader | null = null, saved: { companyId: string } | null = null): Promise<void> {
    try {
      await PROVIDERS[def.id].validate(this.ctx(def, keys, config, null, false, mcp))
      if (saved && !mcp) this.deps.onKeyVerdict?.(saved.companyId, def, { ok: true })
    } catch (e) {
      const st = asStatus(e, this.now().toISOString())
      if (saved && !mcp && (st.code === 'invalid_key' || st.code === 'forbidden')) this.deps.onKeyVerdict?.(saved.companyId, def, { ok: false, code: st.code, message: st.message ?? '' })
      const path = st.code === 'config' ? 'config' : 'keys'
      throw new HiveError('validation', st.message ?? 'The keys could not be checked', [{ path, message: st.message ?? '' }])
    }
  }

  /**
   * CONNECTIONS.md §3.6 / CONN-QA-01: the read-only check on keys pasted outside a dashboard (connections:connectKey).
   * With the config the dashboard needs, its own check; without it, the provider's check of the key alone (PostHog:
   * who the key belongs to, US then EU cloud), which may also find a setting (the EU host). Saves nothing. A rejected
   * key throws a validation error with the safe message; a vendor that can't be reached gives `unchecked`.
   */
  async checkKeys(kind: DashboardKind, companyId: string, pasted: Record<string, string>, config: DashboardConfig): Promise<{ checked: 'ok' | 'unchecked' | 'none'; settings?: Record<string, string> }> {
    const def = this.def(kind)
    const { keys } = this.keysFor(def, companyId, this.cleanKeys(def, pasted))
    const ready = def.config.every((c) => !c.required || configText(config[c.key]))
    const provider = PROVIDERS[def.id]
    if (!ready && !provider.checkKey) return { checked: 'none' }
    try {
      if (ready) {
        await provider.validate(this.ctx(def, keys, this.cleanConfig(def, config), null))
        return { checked: 'ok' }
      }
      const r = await provider.checkKey!(this.ctx(def, keys, config, null))
      return { checked: 'ok', ...(r?.settings ? { settings: r.settings } : {}) }
    } catch (e) {
      if (e instanceof HiveError) throw e
      const st = asStatus(e, this.now().toISOString())
      if (st.code === 'network' || st.code === 'unavailable' || st.code === 'rate_limited') return { checked: 'unchecked' }
      const path = st.code === 'config' ? 'config' : 'keys'
      throw new HiveError('validation', st.message ?? 'The key could not be checked', [{ path, message: st.message ?? '' }])
    }
  }

  private saveKeys(def: DashboardDef, companyId: string, pasted: Record<string, string>): void {
    for (const [name, value] of Object.entries(pasted)) {
      const field = def.keys.find((k) => k.name === name)
      this.deps.keys.save(companyId, name, value, `${def.provider} · ${field?.label ?? name}`)
    }
  }

  async install(input: DashboardInstallInput): Promise<InstalledDashboard> {
    this.assertEnabled()
    const def = this.def(input.kind)
    if (!this.deps.companyExists(input.companyId)) throw new HiveError('not_found', 'Company not found')
    if (input.departmentId && this.deps.departmentCompany(input.departmentId) !== input.companyId) throw new HiveError('not_found', 'Department not found')
    const pasted = this.cleanKeys(def, input.keys)
    const r = this.route(def, input.companyId, pasted)
    const config = this.cleanConfig(def, input.config, !!r.mcp)
    this.requireKeys(r)
    const { keys, mcp } = r
    await this.validate(def, keys, config, mcp, Object.keys(pasted).length ? null : { companyId: input.companyId })
    this.saveKeys(def, input.companyId, pasted)
    const row = this.store.create({ companyId: input.companyId, departmentId: input.departmentId, kind: def.id, config })
    void this.refresh(row.id).catch(() => undefined)
    return this.get(row.id)
  }

  /** New config and/or replacement keys: validated together before anything is saved. */
  async update(id: string, patch: { config?: DashboardConfig; keys?: Record<string, string> }): Promise<InstalledDashboard> {
    this.assertEnabled()
    const row = this.store.get(id)
    const def = this.def(row.kind)
    const pasted = this.cleanKeys(def, patch.keys ?? {})
    const r = this.route(def, row.companyId, pasted)
    const config = patch.config ? this.cleanConfig(def, patch.config, !!r.mcp) : row.config
    this.requireKeys(r)
    const { keys, mcp } = r
    await this.validate(def, keys, config, mcp, Object.keys(pasted).length ? null : { companyId: row.companyId })
    this.saveKeys(def, row.companyId, pasted)
    if (patch.config) this.store.updateConfig(id, config)
    this.store.setStatus(id, { state: 'never' })
    void this.refresh(id).catch(() => undefined)
    return this.get(id)
  }

  /** Removes the dashboard. Its keys stay in the company's keys (other dashboards and agents may use them). */
  remove(id: string): void {
    this.assertEnabled()
    const row = this.store.get(id)
    this.store.remove(id)
    this.deps.onChange?.(row.companyId)
  }

  // ---------- fetching ----------

  /** Fetches now (joins a fetch already running). Resolves with the dashboard as stored afterwards. */
  async refresh(id: string): Promise<InstalledDashboard> {
    const running = this.inflight.get(id)
    if (running) {
      await running
      return this.get(id)
    }
    const row = this.store.get(id)
    const p = this.fetchRow(row).finally(() => {
      this.inflight.delete(id)
      this.deps.onChange?.(row.companyId)
    })
    this.inflight.set(id, p)
    this.deps.onChange?.(row.companyId)
    await p
    return this.get(id)
  }

  private async fetchRow(row: DashboardRow): Promise<void> {
    const def = this.def(row.kind)
    let timer: NodeJS.Timeout | undefined
    try {
      const { keys, mcp } = this.keysFor(def, row.companyId, {})
      const work = PROVIDERS[def.id].fetch(this.ctx(def, keys, row.config, row.snapshot, false, mcp))
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DashboardFetchError('unavailable', 'The service took too long to answer. Try again later.')), FETCH_TIMEOUT_MS[def.id] ?? DEFAULT_FETCH_TIMEOUT_MS)
        timer.unref?.()
      })
      work.catch(() => undefined)
      const snap = await Promise.race([work, deadline])
      if (this.deps.fixtures) snap.sample = true
      this.store.recordFetch(row.id, { state: 'ok', at: this.now().toISOString() }, snap)
    } catch (e) {
      const st = asStatus(e, this.now().toISOString())
      // a missing key is the user's to fix, not a fetch error worth logging
      if (st.code !== 'config' && st.code !== 'invalid_key') this.deps.log?.warn('dashboard refresh failed', { id: row.id, kind: row.kind, code: st.code })
      this.store.recordFetch(row.id, st)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Whether an automatic refresh is due for this row (interval, then backoff after an error). */
  due(row: DashboardRow, now = this.now()): boolean {
    if (this.inflight.has(row.id)) return false
    if (!row.fetchedAt) return true
    const def = dashboardDef(row.kind)
    if (!def) return false
    const backoff = row.status.state === 'error' && row.status.code ? (BACKOFF_MIN[row.status.code] ?? 0) : 0
    const minutes = Math.max(def.refreshMinutes, backoff)
    return now.getTime() - Date.parse(row.fetchedAt) >= minutes * 60_000
  }

  /** One scheduler pass: refresh every due dashboard, one at a time (GEO runs are long; order is stable). */
  async tick(): Promise<void> {
    if (!this.deps.enabled()) return
    for (const row of this.store.list()) {
      if (!this.due(row)) continue
      await this.refresh(row.id).catch(() => undefined)
    }
  }

  start(): void {
    if (this.timer) return
    let running = false
    const run = (): void => {
      if (running) return
      running = true
      void this.tick().finally(() => {
        running = false
      })
    }
    this.timer = setInterval(run, TICK_MS)
    this.timer.unref?.()
    // first pass shortly after boot, off the startup path
    setTimeout(run, 20_000).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ---------- sample data ----------

  /** The marketplace preview: the real provider on fixture data, labelled sample. */
  async sample(kind: DashboardKind): Promise<DashboardSnapshot> {
    const def = this.def(kind)
    const config = SAMPLE_CONFIG[kind]
    let previous: DashboardSnapshot | null = null
    if (kind === 'geo') previous = this.sampleGeoHistory()
    const snap = await PROVIDERS[kind].fetch(this.ctx(def, sampleKeys(kind), config, previous, true))
    return { ...snap, sample: true }
  }

  /** A few weeks of earlier GEO runs so the preview's trend line has a shape. */
  private sampleGeoHistory(): DashboardSnapshot {
    const now = this.now().getTime()
    const mention = [0.25, 0.28, 0.27, 0.33, 0.31, 0.38, 0.42, 0.4, 0.46, 0.5]
    const share = [0.18, 0.2, 0.21, 0.24, 0.23, 0.27, 0.29, 0.3, 0.32, 0.34]
    const t = (i: number): string => new Date(now - (mention.length - i) * 3 * 86_400_000).toISOString().slice(0, 10)
    let a = appendTrend(undefined, 'Mention rate', t(0), mention[0])
    let b = appendTrend(undefined, 'Share of voice', t(0), share[0])
    for (let i = 1; i < mention.length; i++) {
      a = appendTrend([a], 'Mention rate', t(i), mention[i])
      b = appendTrend([b], 'Share of voice', t(i), share[i])
    }
    return { fetchedAt: t(mention.length - 1), period: '', kpis: { mentionRate: { value: 0.5, previous: null }, shareOfVoice: { value: 0.34, previous: null }, avgRank: { value: 2.4, previous: null }, citationRate: { value: 0.2, previous: null } }, series: { trend: [a, b] }, tables: {} }
  }

  // ---------- agent context ----------

  /**
   * DASHBOARDS.md §6: a short, read-only block for the department's runs and chats, from cached snapshots only (no
   * fetch, no keys). null when the department has no dashboard with numbers.
   */
  contextFor(companyId: string, departmentId: string): string | null {
    if (!this.deps.enabled()) return null
    const lines: string[] = []
    for (const r of this.store.list(companyId, departmentId)) {
      if (!r.snapshot) continue
      const def = dashboardDef(r.kind)
      if (!def) continue
      const bits = def.widgets.flatMap((w) => {
        if (w.kind !== 'kpi') return []
        const k = r.snapshot!.kpis[w.id]
        if (!k || k.value == null) return []
        const d = formatDelta(deltaRatio(k.value, k.previous))
        return [`${w.title} ${formatMetric(k.value, w.format, { currency: r.snapshot!.currency })}${d ? ` (${d})` : ''}`]
      })
      if (!bits.length) continue
      const stale = r.status.state === 'error' ? ' — last refresh failed, numbers may be old' : ''
      lines.push(`- ${def.name}${r.snapshot.sample ? ' [sample data]' : ''}, as of ${r.snapshot.fetchedAt.slice(0, 16).replace('T', ' ')} UTC${stale}: ${bits.join('; ')}. (${r.snapshot.period})`)
    }
    if (!lines.length) return null
    const text = ['## Department dashboards (read-only, latest numbers)', ...lines].join('\n')
    return text.length > 2000 ? `${text.slice(0, 1999)}…` : text
  }
}
