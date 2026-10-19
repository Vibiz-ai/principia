/** Builds the hivemem handlers from the server env (separate from main.ts so tests can import it). */
import fs from 'node:fs'
import { MemorySchemaMismatch, openMemoryDb, type MemDB } from '../db'
import { MemoryStore } from '../store'
import { readFingerprintFile, type FingerprintFile } from '../screen'
import { MEMORY_SERVER_NAME } from '../../../shared/memory'
import type { McpHandlers } from './jsonrpc'
import { errorResult, MemoryTools, TOOL_DEFS, type ToolDef } from './tools'
import { ASK_USER_DEF, askUser } from './askUser'

const VERSION = '1'

function fingerprints(file: string | undefined): () => FingerprintFile | null {
  let cached: FingerprintFile | null = null
  let mtime = 0
  return () => {
    if (!file) return null
    try {
      const st = fs.statSync(file)
      if (st.mtimeMs !== mtime) {
        mtime = st.mtimeMs
        cached = readFingerprintFile(file)
      }
    } catch {
      cached = null
    }
    return cached
  }
}

const ASK_ONLY_INSTRUCTIONS =
  'Hive: if you need a decision or information only the human user has, call ask_user (the step pauses until they answer). Do not guess.'

/**
 * Handlers from the server env. HIVE_MEM_GRANT empty = memory off (LIVE.md §4.2): only ask_user is listed and
 * memory.db is never opened. Otherwise memory.db opens lazily on first use. HIVE_LIVE_DIR set = ask_user listed.
 */
export function buildHandlers(env: NodeJS.ProcessEnv): { handlers: McpHandlers; db: MemDB | null; close(): void } {
  const dbPath = env.HIVE_MEM_DB
  const grantId = env.HIVE_MEM_GRANT ?? ''
  const liveDir = env.HIVE_LIVE_DIR || null
  const memoryOn = !!grantId
  let db: MemDB | null = null
  let tools: MemoryTools | null = null
  let fatal: string | null = null
  let opened = false
  const open = (): MemoryTools | null => {
    if (opened) return tools
    opened = true
    try {
      if (!dbPath) throw new Error('HIVE_MEM_DB is not set')
      db = openMemoryDb(dbPath, { migrate: false })
      tools = new MemoryTools(new MemoryStore(db, { fingerprints: fingerprints(env.HIVE_MEM_FP) }), grantId)
    } catch (e) {
      fatal = e instanceof MemorySchemaMismatch ? 'Hive memory schema mismatch; restart Hive' : `Hive memory unavailable: ${e instanceof Error ? e.message : String(e)}`
      process.stderr.write(`[hivemem] ${fatal}\n`)
    }
    return tools
  }
  const askDefs: ToolDef[] = liveDir ? [ASK_USER_DEF] : []
  const handlers: McpHandlers = {
    serverInfo: { name: MEMORY_SERVER_NAME, version: VERSION },
    instructions: () => {
      if (!memoryOn) return liveDir ? ASK_ONLY_INSTRUCTIONS : 'Hive shared memory is off for this agent.'
      const t = open()
      const mem = t ? t.instructions() : `Hive shared memory is unavailable: ${fatal}`
      return liveDir ? `${mem}\n${ASK_ONLY_INSTRUCTIONS}`.slice(0, 2800) : mem
    },
    listTools: () => {
      if (!memoryOn) return askDefs
      const t = open()
      return [...(t ? t.list() : [TOOL_DEFS.memory_search, TOOL_DEFS.memory_get]), ...askDefs]
    },
    callTool: (name, args, ctx) => {
      if (name === 'ask_user') {
        if (!liveDir) return errorResult('Unknown tool: ask_user')
        return askUser(liveDir, args, { meta: ctx?.meta ?? null, signal: ctx?.signal })
      }
      if (!memoryOn) return errorResult(`Unknown tool: ${name}`)
      const t = open()
      return t ? t.call(name, args) : errorResult(fatal ?? 'Hive memory unavailable')
    }
  }
  return {
    handlers,
    get db() {
      return db
    },
    close() {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
  }
}
