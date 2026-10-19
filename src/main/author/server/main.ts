/**
 * `hive`: Hive's stdio MCP authoring server (AUTHORING.md §1.1). Built as out/main/mcp-hive.js and spawned by an
 * interactive claude session (PO1, PO7) as `<Hive binary> <path>/mcp-hive.js` with ELECTRON_RUN_AS_NODE=1.
 * Env: HIVE_LIVE_DIR (the session's live dir), HIVE_SPAWN_ID, HIVE_USER_DATA. Opens no database, holds no secrets, no
 * listener of any kind: stdin/stdout only. stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import { serveStdio } from '../../memory/server/jsonrpc'
import { buildAuthorHandlers } from './tools'

console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')

function main(): void {
  const handlers = buildAuthorHandlers(process.env)
  const close = () => process.exit(0)
  serveStdio(handlers, { stdin: process.stdin, stdout: process.stdout, onClose: close })
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
}

main()
