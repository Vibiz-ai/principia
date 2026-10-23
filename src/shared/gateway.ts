export type GatewayAuthStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export interface GatewayConnection {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  /** Absolute working directories; empty means no access. */
  roots: string[]
  /** Explicit access for all current and future project directories. */
  scope?: 'projects' | 'global'
  /**
   * COMPANY.md §6: only spawns of these companies get the connection (checked against the spawn's company, else the
   * company of its folder). Absent = every company (configs saved before companies).
   */
  companyIds?: string[]
  authentication?: 'none' | 'oauth'
  authStatus?: GatewayAuthStatus
  authError?: string
  hasCredentials: boolean
}
export interface GatewayConnectionInput extends Omit<GatewayConnection, 'hasCredentials' | 'authStatus' | 'authError'> {
  /** Environment for stdio, headers for HTTP. Encrypted at rest, never returned. Omit to retain. */
  credentials?: Record<string, string>
}

/**
 * Vibiz, the default company connection. Endpoint and auth from the Vibiz app (vibiz/app/api/mcp/route.ts and
 * vibiz/app/.well-known/oauth-protected-resource/route.ts): Streamable HTTP JSON-RPC at www (the apex 308-redirects),
 * OAuth through WorkOS AuthKit with dynamic client registration; `vbz_mcp_*` workspace tokens also work as a Bearer.
 */
export const VIBIZ_MCP_URL = 'https://www.vibiz.ai/api/mcp'
export const VIBIZ_CONNECTION_ID = 'vibiz'
/** Seeded once per install (GatewayService): enabled for every project, waiting for the user to sign in. */
export const VIBIZ_DEFAULT_CONNECTION: Omit<GatewayConnection, 'hasCredentials' | 'authStatus' | 'authError'> = {
  id: VIBIZ_CONNECTION_ID,
  name: 'Vibiz',
  transport: 'http',
  url: VIBIZ_MCP_URL,
  enabled: true,
  roots: [],
  scope: 'global',
  authentication: 'oauth'
}
