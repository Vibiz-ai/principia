/**
 * FORUM.md §4.1.1: adds the principia-forum stdio server to a step's MCP attachment. Claude: into the step's one
 * --mcp-config JSON (or a new one) with the six names appended to --allowedTools. Codex: `-c mcp_servers.…` overrides
 * with the tools pre-approved. Other adapters: unchanged (they use the CLI or the fenced block).
 */
import type { AdapterId } from '../../shared/types'
import type { McpServerSpec } from '../../shared/engine'

export interface McpFile { path: string; content: string }
export interface McpAttachment { args: string[]; env: Record<string, string>; files: McpFile[] }

const toml = (v: string): string => JSON.stringify(v)

export function attachForum(adapter: AdapterId, server: McpServerSpec, toolNames: readonly string[], previous: McpAttachment | null, file: string): McpAttachment | null {
  if (adapter === 'codex') {
    const k = `mcp_servers.${server.name}`
    const args = ['-c', `${k}.command=${toml(server.command)}`, '-c', `${k}.args=${JSON.stringify(server.args)}`]
    for (const [name, value] of Object.entries(server.env)) args.push('-c', `${k}.env.${name}=${toml(value)}`)
    args.push('-c', `${k}.enabled_tools=${JSON.stringify([...toolNames])}`, '-c', `${k}.default_tools_approval_mode="approve"`)
    return { args: [...(previous?.args ?? []), ...args], env: previous?.env ?? {}, files: previous?.files ?? [] }
  }
  if (adapter !== 'claude') return previous
  const spec = { type: 'stdio', command: server.command, args: server.args, env: server.env }
  const allowed = toolNames.map((t) => `mcp__${server.name}__${t}`)
  const files = [...(previous?.files ?? [])]
  let args = [...(previous?.args ?? [])]
  const existing = files.find((f) => f.path.endsWith('.json') && f.content.includes('mcpServers'))
  if (existing) {
    const config = JSON.parse(existing.content) as { mcpServers: Record<string, unknown> }
    config.mcpServers[server.name] = spec
    files.splice(files.indexOf(existing), 1, { ...existing, content: `${JSON.stringify(config, null, 2)}\n` })
  } else {
    files.push({ path: file, content: `${JSON.stringify({ mcpServers: { [server.name]: spec } }, null, 2)}\n` })
    args.push('--mcp-config', file)
  }
  const i = args.indexOf('--allowedTools')
  if (i >= 0 && i + 1 < args.length) args = [...args.slice(0, i + 1), [args[i + 1], ...allowed].filter(Boolean).join(','), ...args.slice(i + 2)]
  else args.push('--allowedTools', allowed.join(','))
  return { args, env: previous?.env ?? {}, files }
}
