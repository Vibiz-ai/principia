/** DASHBOARDS.md §4: what a dashboard provider gets and implements. No Electron imports. */
import type { DashboardConfig, DashboardKind, DashboardSnapshot } from '../../../shared/dashboards'
import type { HttpFn } from '../http'

/** GEO answer engines: one question in, the answer text (and any citation URLs) out. */
export interface GeoAnswer {
  text: string
  citations: string[]
}
export interface GeoEngine {
  id: 'claude' | 'openai' | 'perplexity'
  label: string
  ask(prompt: string): Promise<GeoAnswer>
}

export interface ProviderCtx {
  http: HttpFn
  /** Resolved key values by name (company keys over Shared). Main memory only. */
  keys: Record<string, string>
  config: DashboardConfig
  now: Date
  /** The last good snapshot (GEO appends to its trend). */
  previous: DashboardSnapshot | null
  /** GEO: the engines available for these keys (built by the service). */
  geoEngines?: () => GeoEngine[]
  /** GitHub: the signed-in `gh` CLI as an HttpFn for api.github.com URLs, when no token is set. null = not installed. */
  gh?: HttpFn | null
}

export interface DashboardProvider {
  kind: DashboardKind
  /** One cheap, read-only real call per key (DASHBOARDS.md §3). Throws DashboardFetchError. */
  validate(ctx: ProviderCtx): Promise<void>
  fetch(ctx: ProviderCtx): Promise<DashboardSnapshot>
}

/** Every key value of the context, for scrubbing quoted provider text. */
export const secretsOf = (ctx: ProviderCtx): string[] => Object.values(ctx.keys).filter(Boolean)
