import { join } from 'node:path'
import type { McpServerSpec } from '../../shared/engine'
import type { AdapterId } from '../../shared/types'
import type { McpAttachment } from '../engine/memory'
/** The gateway server's two tools (gateway/main.ts); the "Use Principia" rules name them when the spawn has them. */
export const GATEWAY_TOOLS = ['principia_list_tools', 'principia_call_tool'] as const
/** Keep harness-native approval policies; external tools are never automatically pre-approved. */
export function attachGateway(adapter: AdapterId, server: McpServerSpec, previous: McpAttachment | null, dir: string): McpAttachment | null {
  if (adapter === 'codex') {
    const k = 'mcp_servers.principia'; const args = ['-c', `${k}.command=${JSON.stringify(server.command)}`, '-c', `${k}.args=${JSON.stringify(server.args)}`]
    for (const [key,value] of Object.entries(server.env)) args.push('-c', `${k}.env.${key}=${JSON.stringify(value)}`)
    return { args: [...(previous?.args ?? []), ...args], env: previous?.env ?? {}, files: previous?.files ?? [] }
  }
  if (adapter !== 'claude') return previous
  const files = [...(previous?.files ?? [])]; const existing = files.find(f => f.path.endsWith('.json') && f.content.includes('mcpServers'))
  const spec = { type: 'stdio', command: server.command, args: server.args, env: server.env }
  // QP-2: the founder's own servers for services Principia serves here stay out (variadic: placed with the MCP flags)
  const deny = server.deny?.length ? ['--disallowedTools', server.deny.join(',')] : []
  if (existing) { const config = JSON.parse(existing.content); config.mcpServers.principia = spec; return { ...previous!, args: [...previous!.args, ...deny], files: files.map(f => f === existing ? { ...f, content: JSON.stringify(config) } : f) } }
  const file = join(dir, 'principia.mcp.json')
  return { args: [...(previous?.args ?? []), '--mcp-config', file, ...deny], env: previous?.env ?? {}, files: [...files, { path: file, content: JSON.stringify({ mcpServers: { principia: spec } }) }] }
}
