/** Builds the hivemem handlers from the server env (separate from main.ts so tests can import it). */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { MemorySchemaMismatch, openMemoryDb, type MemDB } from '../db'
import { MemoryStore } from '../store'
import { readFingerprintFile, redactCredentials, secretHit, type FingerprintFile } from '../screen'
import { IndexSchemaMismatch, openIndexDb, type IndexDB } from '../vault/indexDb'
import { MEM_UNREACHABLE, MEMORY_SERVER_NAME } from '../../../shared/memory'
import type { CallContext, McpHandlers } from './jsonrpc'
import { errorResult, MemoryTools, TOOL_DEFS, VAULT_TOOL_DEFS, VaultTools, withTaskTools, type ToolDef } from './tools'
import { ASK_USER_DEF, askUser } from './askUser'
import { SpoolClient, type SpoolOptions } from './spool'

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

/** Which backend a spawn's env selects (PASSPORT.md §7.1): the vault index wins over the legacy memory.db. */
export type MemoryServerMode = 'off' | 'vault' | 'legacy'
export function memoryServerMode(env: NodeJS.ProcessEnv): MemoryServerMode {
  if (!env.HIVE_MEM_GRANT) return 'off'
  return env.HIVE_MEM_INDEX ? 'vault' : 'legacy'
}

export interface BuildOptions {
  /** Spool client timings (tests). */
  spool?: Partial<Pick<SpoolOptions, 'timeoutMs' | 'pollMinMs' | 'pollMaxMs'>>
}

export interface BuiltHandlers {
  handlers: McpHandlers
  mode: MemoryServerMode
  /** The legacy memory.db, once opened. */
  db: MemDB | null
  /** passport-index.db (read-only), once opened. */
  index: IndexDB | null
  close(): void
}

/**
 * Handlers from the server env. HIVE_MEM_GRANT empty = memory off (LIVE.md §4.2): only ask_user is listed and no
 * database is opened. HIVE_MEM_INDEX set = the Passport vault tools (vaultHandlers); otherwise the legacy v1 tools over
 * HIVE_MEM_DB, opened lazily on first use. HIVE_LIVE_DIR set = ask_user listed.
 */
export function buildHandlers(env: NodeJS.ProcessEnv, opts: BuildOptions = {}): BuiltHandlers {
  const built = memoryHandlers(env, opts)
  // DEPARTMENTS.md §6: a task run's step also lists the hivetask tools (HIVE_TASK_ID)
  built.handlers = withTaskTools(built.handlers, env)
  return built
}

function memoryHandlers(env: NodeJS.ProcessEnv, opts: BuildOptions): BuiltHandlers {
  if (memoryServerMode(env) === 'vault') return vaultHandlers(env, opts)
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
    mode: memoryOn ? 'legacy' : 'off',
    get db() {
      return db
    },
    index: null,
    close() {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Unique per server process: a JSON-RPC id alone repeats after a restart, so it never keys idempotency by itself. */
const PROCESS_NONCE = crypto.randomBytes(6).toString('hex')

/** opId = grantId + MCP call id (§6.4): claude's tool-use id when present, else this process's request id. */
function callIdOf(ctx: CallContext | undefined): string | undefined {
  const toolUse = ctx?.meta?.['claudecode/toolUseId']
  if (typeof toolUse === 'string' && toolUse.trim()) return toolUse.trim().slice(0, 120)
  return ctx?.requestId != null ? `${PROCESS_NONCE}-${String(ctx.requestId).slice(0, 60)}` : undefined
}

/**
 * Vault mode (PASSPORT.md §7.1). passport-index.db opens read-only (`query_only`) on first use; writes are spool RPCs to
 * main. Binding: unless the grant row's company equals HIVE_COMPANY_ID, only ask_user is listed and every memory call is
 * refused. Reads redact credential shapes and the stored secrets HIVE_MEM_FP fingerprints.
 */
function vaultHandlers(env: NodeJS.ProcessEnv, opts: BuildOptions): BuiltHandlers {
  const indexPath = env.HIVE_MEM_INDEX!
  const grantId = env.HIVE_MEM_GRANT!
  const companyId = env.HIVE_COMPANY_ID?.trim() ?? ''
  const liveDir = env.HIVE_LIVE_DIR || null
  const fp = fingerprints(env.HIVE_MEM_FP)
  const spool = env.HIVE_MEM_SPOOL ? new SpoolClient(env.HIVE_MEM_SPOOL, { grantId, companyId, ...opts.spool }) : null
  let index: IndexDB | null = null
  let tools: VaultTools | null = null
  let fatal: string | null = null
  let opened = false
  const open = (): VaultTools | null => {
    if (opened) return tools
    opened = true
    try {
      if (!companyId) throw new Error('HIVE_COMPANY_ID is not set')
      index = openIndexDb(indexPath, { readonly: true })
      tools = new VaultTools({ db: index, grantId, companyId, vault: env.HIVE_VAULT ?? null, spool, redact: (s) => redactStored(fp(), redactCredentials(s)) })
    } catch (e) {
      fatal = e instanceof IndexSchemaMismatch ? 'Principia Passport index schema mismatch; restart Principia' : `Principia Passport unavailable: ${e instanceof Error ? e.message : String(e)}`
      process.stderr.write(`[hivemem] ${fatal}\n`)
    }
    return tools
  }
  const askDefs: ToolDef[] = liveDir ? [ASK_USER_DEF] : []
  const handlers: McpHandlers = {
    serverInfo: { name: MEMORY_SERVER_NAME, version: VERSION },
    instructions: () => {
      const t = open()
      const mem = t ? t.instructions() : `Principia Passport is unavailable: ${fatal}`
      return liveDir ? `${mem}\n${ASK_ONLY_INSTRUCTIONS}`.slice(0, 2800) : mem
    },
    listTools: () => {
      const t = open()
      // the index could not be opened: no reads to offer, and a write would be refused by main anyway
      if (!t) return askDefs
      return [...t.list(), ...askDefs]
    },
    callTool: (name, args, ctx) => {
      if (name === 'ask_user') {
        if (!liveDir) return errorResult('Unknown tool: ask_user')
        return askUser(liveDir, args, { meta: ctx?.meta ?? null, signal: ctx?.signal })
      }
      if (!(name in VAULT_TOOL_DEFS)) return errorResult(`Unknown tool: ${name}`)
      const t = open()
      if (!t) return errorResult(fatal ?? MEM_UNREACHABLE)
      return t.call(name, args, { callId: callIdOf(ctx), signal: ctx?.signal })
    }
  }
  return {
    handlers,
    mode: 'vault',
    db: null,
    get index() {
      return index
    },
    close() {
      try {
        index?.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Masks any whitespace-delimited token whose fingerprint matches a stored secret (the child never sees values). */
function redactStored(fp: FingerprintFile | null, text: string): string {
  if (!fp || !text || !secretHit(fp, text)) return text
  return text
    .split(/(\s+)/)
    .map((tok) => (/\s/.test(tok) || !secretHit(fp, tok) ? tok : '••••'))
    .join('')
}
