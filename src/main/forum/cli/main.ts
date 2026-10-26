/**
 * FORUM.md §4.1: the `forum` CLI and the principia-forum stdio MCP server, one bundle (out/main/forum-cli.js), run as
 * `ELECTRON_RUN_AS_NODE=1 <Principia binary> forum-cli.js <command>` through the per-step `forum` shim. Both talk to
 * main's localhost endpoint with the step token (PRINCIPIA_FORUM_URL, PRINCIPIA_FORUM_TOKEN); neither opens a
 * database, so identity and every rule stay in main.
 */
import { serveStdio, type CallContext, type McpHandlers } from '../../memory/server/jsonrpc'
import { FORUM_INSTRUCTIONS, FORUM_SERVER_NAME, FORUM_TOOLS, FORUM_TOOL_DEFS, forumSchema, isForumTool, type ForumTool } from '../protocol'

const USAGE = `forum: Principia Forum protocol v1 (FORUM.md)
  forum read [#chan|@who] [--thread m3fk] [--since c3fk] [--limit N] [--budget N]
  forum post <#chan|@who> <text> [--ref NC-12 ...]
  forum reply <m3fk> <text>
  forum ask <question> [--to @who ...] [--channel #chan] [--option A --option B ...] [--wait SECONDS]
  forum channel new <name> <purpose> [--invite @who ...] [--message TEXT]
       [--propose-department NAME --does TEXT --does-not TEXT --reason TEXT]
       [--propose-agent ROLE --department KEY --instructions TEXT --capabilities TEXT --reason TEXT]
  forum mention <@who[,@who]> <text> [--ref m3fk]
  forum ask-agent <@who|department> <question> [--why TEXT] [--channel #chan] [--wait SECONDS]
  forum activity [@who|department] [--hours N] [--limit N]
  forum usage [@who|department] [--days N]
  forum board [@who|department] [--status S]
  forum call <tool> '<json args>'
  forum schema
  forum mcp            (stdio MCP server)
Env: PRINCIPIA_FORUM_URL, PRINCIPIA_FORUM_TOKEN (set by Principia for each agent step).`

export async function callTool(tool: ForumTool, args: unknown, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; text: string }> {
  const url = env.PRINCIPIA_FORUM_URL
  const token = env.PRINCIPIA_FORUM_TOKEN
  if (!url || !token) return { ok: false, text: 'The Forum is not available to this process (PRINCIPIA_FORUM_URL / PRINCIPIA_FORUM_TOKEN are unset).' }
  try {
    const res = await fetch(`${url}/v1/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args ?? {}), signal })
    return { ok: res.ok, text: await res.text() }
  } catch (e) {
    if (signal?.aborted) throw new Error('canceled')
    return { ok: false, text: `Principia is not reachable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The stdio MCP server's handlers (exported for tests). */
export function forumMcpHandlers(env: NodeJS.ProcessEnv = process.env): McpHandlers {
  return {
    serverInfo: { name: FORUM_SERVER_NAME, version: '1' },
    instructions: () => FORUM_INSTRUCTIONS,
    listTools: () => FORUM_TOOLS.map((t) => FORUM_TOOL_DEFS[t]),
    callTool: async (name: string, args: unknown, ctx?: CallContext) => {
      if (!isForumTool(name)) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      const r = await callTool(name, args, ctx?.signal, env)
      return r.ok ? { content: [{ type: 'text', text: r.text }] } : { content: [{ type: 'text', text: r.text }], isError: true }
    }
  }
}

/** argv → [tool, args]; throws a usage message. */
export function parseCli(argv: string[]): [ForumTool, Record<string, unknown>] {
  const pos: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n\n${USAGE}`)
      flags.set(a.slice(2), [...(flags.get(a.slice(2)) ?? []), v])
      i++
    } else pos.push(a)
  }
  const one = (k: string) => flags.get(k)?.[flags.get(k)!.length - 1]
  const num = (k: string) => (one(k) !== undefined ? Number(one(k)) : undefined)
  const [cmd, ...rest] = pos
  const need = (n: number) => {
    if (rest.length < n) throw new Error(USAGE)
  }
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  switch (cmd) {
    case 'read': {
      const target = rest[0]
      return ['forum_read', clean({ channel: target, thread: one('thread'), since: one('since'), limit: num('limit'), budget: num('budget') })]
    }
    case 'ask-agent':
      need(2)
      return ['forum_ask_agent', clean({ to: rest[0], question: rest.slice(1).join(' '), why: one('why'), channel: one('channel'), wait_s: num('wait') })]
    case 'activity':
      return ['team_activity', clean({ who: rest[0], hours: num('hours'), limit: num('limit') })]
    case 'usage':
      return ['team_usage', clean({ who: rest[0], days: num('days') })]
    case 'board':
      return ['team_board', clean({ who: rest[0], status: one('status') })]
    case 'post':
      need(2)
      return ['forum_post', clean({ channel: rest[0], text: rest.slice(1).join(' '), refs: flags.get('ref') })]
    case 'reply':
      need(2)
      return ['forum_reply', clean({ to: rest[0], text: rest.slice(1).join(' '), refs: flags.get('ref') })]
    case 'ask':
      need(1)
      return ['forum_ask', clean({ question: rest.join(' '), to: flags.get('to'), channel: one('channel'), options: flags.get('option'), wait_s: num('wait') })]
    case 'channel': {
      if (rest[0] !== 'new') throw new Error(USAGE)
      const [, name, ...purpose] = rest
      if (!name || !purpose.length) throw new Error(USAGE)
      const dep = one('propose-department')
      const agent = one('propose-agent')
      const proposal = dep
        ? { kind: 'department', name: dep, does: one('does') ?? '', doesNot: one('does-not') ?? '', reason: one('reason') ?? purpose.join(' ') }
        : agent
          ? clean({ kind: 'agent', role: agent, department: one('department') ?? null, instructions: one('instructions'), capabilities: one('capabilities'), reason: one('reason') ?? purpose.join(' ') })
          : undefined
      return ['forum_create_channel', clean({ name, purpose: purpose.join(' '), invite: flags.get('invite'), first_message: one('message'), proposal })]
    }
    case 'mention':
      need(2)
      return ['forum_mention', clean({ who: rest[0].split(','), text: rest.slice(1).join(' '), ref: one('ref') })]
    case 'call': {
      need(2)
      if (!isForumTool(rest[0])) throw new Error(`Unknown tool ${rest[0]}. Tools: ${FORUM_TOOLS.join(', ')}`)
      let args: unknown
      try {
        args = JSON.parse(rest[1])
      } catch {
        throw new Error('The arguments are not JSON')
      }
      return [rest[0], args as Record<string, unknown>]
    }
    default:
      throw new Error(USAGE)
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv
  if (cmd === 'mcp') {
    // stdout carries JSON-RPC only
    console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')
    serveStdio(forumMcpHandlers(), { stdin: process.stdin, stdout: process.stdout, onClose: () => process.exit(0) })
    return -1
  }
  if (cmd === 'schema') {
    process.stdout.write(`${JSON.stringify(forumSchema(), null, 2)}\n`)
    return 0
  }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return cmd ? 0 : 1
  }
  let tool: ForumTool
  let args: Record<string, unknown>
  try {
    ;[tool, args] = parseCli(argv)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }
  const r = await callTool(tool, args)
  ;(r.ok ? process.stdout : process.stderr).write(`${r.text}\n`)
  return r.ok ? 0 : 1
}

// run only as the bundle entry (tests import the functions)
if (process.env.PRINCIPIA_FORUM_CLI_TEST !== '1' && !process.env.VITEST) {
  void main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exitCode = code
  })
}
