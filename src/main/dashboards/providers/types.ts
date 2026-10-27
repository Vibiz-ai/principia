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
  /** CONNECTIONS.md §4.3: the company's sign-in to the service, when the dashboard reads through it (no key saved). */
  mcp?: McpReader | null
}

/** One saved MCP connection, as a dashboard reads it (main only; the gateway makes the calls). */
export interface McpReader {
  tools(): Promise<string[]>
  call(tool: string, args: Record<string, unknown>): Promise<unknown>
}

export interface DashboardProvider {
  kind: DashboardKind
  /** One cheap, read-only real call per key (DASHBOARDS.md §3). Throws DashboardFetchError. */
  validate(ctx: ProviderCtx): Promise<void>
  /**
   * CONN-QA-01: a check of the key alone, for when the dashboard's settings are not known yet (connections:connectKey).
   * Read-only. May find a setting on the way (PostHog: the EU host). Throws DashboardFetchError.
   */
  checkKey?(ctx: ProviderCtx): Promise<{ settings?: Record<string, string> } | void>
  fetch(ctx: ProviderCtx): Promise<DashboardSnapshot>
}

/** Every key value of the context, for scrubbing quoted provider text. */
export const secretsOf = (ctx: ProviderCtx): string[] => Object.values(ctx.keys).filter(Boolean)
