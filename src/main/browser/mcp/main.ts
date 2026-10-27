/**
 * BROWSER.md §3: the principia-browser stdio MCP server (out/main/mcp-browser.js), run by claude / codex as
 * `ELECTRON_RUN_AS_NODE=1 <Principia binary> mcp-browser.js`. A thin bridge: every call goes to main's 127.0.0.1
 * endpoint with this spawn's token (PRINCIPIA_BROWSER_URL, PRINCIPIA_BROWSER_TOKEN). It holds no browser itself.
 */
import { serveStdio, type McpHandlers } from '../../memory/server/jsonrpc'
import type { ToolResult } from '../../memory/server/tools'
import { BROWSER_INSTRUCTIONS, BROWSER_SERVER_NAME, BROWSER_TOOL_DEFS, BROWSER_TOOLS, isBrowserTool, type BrowserToolResult } from '../../../shared/browser'

export async function callBrowser(tool: string, args: unknown, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<BrowserToolResult> {
  const url = env.PRINCIPIA_BROWSER_URL
  const token = env.PRINCIPIA_BROWSER_TOKEN
  if (!url || !token) return { content: [{ type: 'text', text: 'The Principia browser is not available to this process.' }], isError: true }
  try {
    const res = await fetch(`${url}/v1/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, args: args ?? {} }), signal })
    if (!res.ok) return { content: [{ type: 'text', text: (await res.text()) || `Principia answered ${res.status}` }], isError: true }
    return (await res.json()) as BrowserToolResult
  } catch (e) {
    if (signal?.aborted) throw new Error('canceled', { cause: e })
    return { content: [{ type: 'text', text: `Principia is not reachable: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
}

export function browserMcpHandlers(env: NodeJS.ProcessEnv = process.env): McpHandlers {
  return {
    serverInfo: { name: BROWSER_SERVER_NAME, version: '1' },
    instructions: () => BROWSER_INSTRUCTIONS,
    listTools: () => BROWSER_TOOLS.map((t) => ({ ...BROWSER_TOOL_DEFS[t] })),
    callTool: async (name, args, ctx) => {
      if (!isBrowserTool(name)) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      // image blocks pass through as MCP image content
      return (await callBrowser(name, args, ctx?.signal, env)) as unknown as ToolResult
    }
  }
}

if (!process.env.VITEST) {
  console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')
  serveStdio(browserMcpHandlers(), { stdin: process.stdin, stdout: process.stdout, onClose: () => process.exit(0) })
}
