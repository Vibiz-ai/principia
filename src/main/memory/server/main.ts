/**
 * hivemem: Hive's stdio MCP memory server (MEMORY.md §1, §5). Built as out/main/mcp-memory.js.
 * Spawned by the agent CLI as `<Hive binary> <path>/mcp-memory.js` with ELECTRON_RUN_AS_NODE=1, so it runs on Hive's
 * own Node and loads the same better-sqlite3 build as main. No listener of any kind: stdin/stdout only.
 * Mode from the env (build.ts, PASSPORT.md §7.1):
 *  - Passport vault: HIVE_MEM_INDEX (passport-index.db, read-only), HIVE_MEM_GRANT, HIVE_MEM_FP, HIVE_MEM_SPOOL (writes are
 *    RPCs to main), HIVE_COMPANY_ID (must match the grant row, else only ask_user) and HIVE_VAULT (messages only).
 *  - legacy, while experimental.vault is off: HIVE_MEM_DB, HIVE_MEM_GRANT, HIVE_MEM_FP.
 * Plus HIVE_LIVE_DIR (ask_user, LIVE.md §4.2). stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import { buildHandlers } from './build'
import { serveStdio } from './jsonrpc'

// Anything a dependency logs must not corrupt the JSON-RPC stream.
console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n')

function main(): void {
  const built = buildHandlers(process.env)
  const handlers = built.handlers
  const close = () => {
    built.close()
    process.exit(0)
  }
  serveStdio(handlers, { stdin: process.stdin, stdout: process.stdout, onClose: close })
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
}

main()
