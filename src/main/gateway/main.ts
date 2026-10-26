import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readPrivateJson, writePrivateJson } from './files'
import { serveStdio } from '../memory/server/jsonrpc'
const dir = process.env.PRINCIPIA_GATEWAY_DIR
if (!dir || !path.isAbsolute(dir)) throw new Error('Missing Principia grant')
const request = async (body: unknown, signal?: AbortSignal): Promise<any> => {
  const id = crypto.randomBytes(16).toString('hex'); const file = path.join(dir, id)
  writePrivateJson(file + '.request', body)
  const deadline = Date.now() + 120_000
  try { while (Date.now() < deadline && !signal?.aborted) { try { const answer = readPrivateJson(file + '.answer', 4 * 1024 * 1024) as { ok: boolean; error?: string; result?: unknown }; if (!answer.ok) throw new Error(answer.error); return answer.result } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Principia gateway timed out or request canceled') } finally { for (const ext of ['.request', '.answer']) try { fs.unlinkSync(file + ext) } catch {} }
}
serveStdio({
  serverInfo: { name: 'principia', version: '1.0.0' },
  instructions: () => 'Company connections are managed by Principia. First discover tools with principia_list_tools, then invoke a discovered tool with principia_call_tool. Access is scoped to this working directory. ' +
    'A tool that is not listed is not connected for this company: say so plainly and give the founder its link, principia://connect/<tool> (for example principia://connect/stripe, or principia://connect/mcp for their own MCP server); it opens that card in Settings › Connections, where they sign in. Never ask for passwords or keys in the chat.',
  listTools: () => [
    { name: 'principia_list_tools', description: 'Discover the tools and input schemas from shared company connections granted to this project.', inputSchema: { type: 'object', properties: {} } },
    { name: 'principia_call_tool', description: 'Call a tool discovered using principia_list_tools. Use the exact connection id, tool name and argument schema returned.', inputSchema: { type: 'object', properties: { connection: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['connection', 'tool', 'arguments'] } }
  ],
  callTool: async (name, args, ctx) => { const a = args as Record<string, unknown>; if (!['principia_list_tools', 'principia_call_tool'].includes(name)) throw new Error('Unknown tool'); const result = await request(name === 'principia_list_tools' ? { method: 'list' } : { method: 'call', connection: a.connection, tool: a.tool, arguments: a.arguments }, ctx?.signal); return { content: [{ type: 'text', text: JSON.stringify(result) }] } }
}, { stdin: process.stdin, stdout: process.stdout, onClose: () => { try { fs.writeFileSync(path.join(dir, 'closed'), '', { flag: 'wx', mode: 0o600 }) } catch {}; process.exit(0) } })
