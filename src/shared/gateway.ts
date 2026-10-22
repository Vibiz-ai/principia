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
