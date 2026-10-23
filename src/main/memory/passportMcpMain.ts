/**
 * The Open Passport stdio MCP server for other apps (open-passport SPEC.md §9.4; docs/connect.md). Built as
 * out/main/mcp-passport.js and run by Claude Desktop, Cursor, VS Code, Codex... as
 * `<Principia binary> <path>/mcp-passport.js --dir <vault> --writes propose --actor <app>` with ELECTRON_RUN_AS_NODE=1,
 * so it needs no Node install. It reads the live vault on every call and never writes notes: with `--writes propose`
 * an app's `remember` / `taste` become proposal files under `<vault>/.open-passport/proposals/`, which Principia moves
 * into the Inbox (handlers/passportConnect.ts). stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import { serveMcp, type WriteMode } from '../openPassport/mcp'

console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const dir = arg('dir')
const writes = (arg('writes') ?? 'propose') as WriteMode
const actor = (arg('actor') ?? 'app').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'app'
if (!dir || !['direct', 'propose', 'off'].includes(writes)) {
  process.stderr.write('usage: mcp-passport.js --dir <vault> [--writes propose|off|direct] [--actor name]\n')
  process.exit(2)
}
serveMcp(dir, { actor, writes, name: 'principia-passport' }).then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`[principia-passport] ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
)
process.on('SIGTERM', () => process.exit(0))
