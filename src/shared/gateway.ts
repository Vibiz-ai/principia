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
  hasCredentials: boolean
}
export interface GatewayConnectionInput extends Omit<GatewayConnection, 'hasCredentials'> {
  /** Environment for stdio, headers for HTTP. Encrypted at rest, never returned. Omit to retain. */
  credentials?: Record<string, string>
}
