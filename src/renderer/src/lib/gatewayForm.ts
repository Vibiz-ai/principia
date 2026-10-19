import type { GatewayConnectionInput } from '@shared/gateway'

/** Accept the connection object or the common config copied from an MCP setup guide. */
export function importGatewayConfig(text: string): Partial<GatewayConnectionInput> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('Paste a valid MCP configuration.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('An MCP configuration must be an object.')
  const input = parsed as Record<string, unknown>
  if (input.mcpServers && typeof input.mcpServers === 'object' && !Array.isArray(input.mcpServers)) {
    const entries = Object.entries(input.mcpServers)
    if (entries.length !== 1) throw new Error('Import one MCP server at a time.')
    const [name, value] = entries[0]
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP server configuration.')
    const server = value as Record<string, unknown>
    return { name, transport: server.url ? 'http' : 'stdio', url: server.url as string | undefined, command: server.command as string | undefined, args: server.args as string[] | undefined, credentials: (server.headers ?? server.env ?? {}) as Record<string, string> }
  }
  return input as Partial<GatewayConnectionInput>
}

/** A command's argument list is one argument per line; never shell evaluated. */
export function connectionProblem(name: string, transport: 'http' | 'stdio', endpoint: string, roots: string[], scope: 'projects' | 'global' = 'projects'): string | null {
  if (!name.trim()) return 'Give this connection a name.'
  if (transport === 'stdio') { if (!endpoint.trim()) return 'Enter the server executable.' }
  else {
    try {
      const url = new URL(endpoint.trim())
      if (url.username || url.password) return 'Use the authentication fields instead of putting credentials in the URL.'
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return 'Use an HTTPS server URL.'
    } catch { return 'Enter a complete server URL, such as https://api.mobbin.com/mcp.' }
  }
  if (scope !== 'global' && !roots.length) return 'Choose at least one project that can use this connection.'
  return null
}
