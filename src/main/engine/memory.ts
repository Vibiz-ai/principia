/**
 * Shared memory, engine side (docs/MEMORY.md 3, 6.3, 7; CONTRACT 11.4; PO amendments 2026-10-16).
 * Pure helpers: mode resolution, transports, MCP config rendering per adapter, brief placement, readable
 * tool-call lines. The store, the MCP server and the brief text itself belong to main (MemoryBridge).
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec, MemoryGrant } from '../../shared/engine'
import type { MemoryMode, MemoryTransport } from '../../shared/memory'
import { MEMORY_MODES, MEMORY_SERVER_NAME } from '../../shared/memory'
import type { AdapterId, WorkflowNode } from '../../shared/types'

/**
 * MCP attach verified on an installed CLI. Unverified adapters fall back to the brief-only 'inject' transport
 * (read-only). Flip only after the adapter's spike passes (MEMORY.md 7, 13.2).
 *  - claude: verified (claude 2.1.x: --mcp-config + --allowedTools, real smoke in __tests__/memory.smoke.test.ts).
 *  - codex: renderer exists; needs `codex exec` + MCP approval behaviour verified (openai/codex#24135).
 *  - gemini: renderer exists; needs GEMINI_CLI_SYSTEM_SETTINGS_PATH merge semantics verified.
 *  - cursor: no per-invocation MCP flag; never mcp without touching ~/.cursor.
 */
export const MCP_VERIFIED: Record<AdapterId, boolean> = {
  claude: true,
  codex: false,
  gemini: false,
  cursor: false,
  shell: false
}

/** null = this adapter never gets memory (shell). */
export function memoryTransport(id: AdapterId, verified: Record<AdapterId, boolean> = MCP_VERIFIED): MemoryTransport | null {
  if (id === 'shell') return null
  return verified[id] ? 'mcp' : 'inject'
}

export const isMemoryMode = (v: unknown): v is MemoryMode => (MEMORY_MODES as readonly unknown[]).includes(v)

/**
 * Effective mode for one spawn (MEMORY.md 3.3). Absent/unknown = off. Shell steps and command checks are
 * always off; agent reviewers are capped at read. Validation rejects the invalid combos at save time; this
 * clamps again at run time so an old snapshot can never escalate.
 */
export function nodeMemoryMode(n: WorkflowNode): MemoryMode {
  const m = isMemoryMode(n.memory) ? n.memory : 'off'
  if (n.type === 'shell') return 'off'
  if (n.type === 'check') {
    if (n.command?.trim() || !n.profileId) return 'off'
    return m === 'read-write' ? 'read' : m
  }
  return m
}

/** A file an adapter needs on disk for its MCP attachment (0600, in grant.spawnDir). */
export interface McpFile {
  path: string
  content: string
}
/** What an adapter adds to one spawn to reach hivemem. */
export interface McpAttachment {
  /** Inserted where the adapter's headless/interactive renderer puts them (claude: right after --verbose). */
  args: string[]
  /** Extra child env (gemini: GEMINI_CLI_SYSTEM_SETTINGS_PATH). Never ELECTRON_*: that lives in the server env. */
  env: Record<string, string>
  files: McpFile[]
}

const claudeToolName = (t: string): string => `mcp__${MEMORY_SERVER_NAME}__${t}`

/** hivemem's blocking question tool (LIVE.md §4.2), listed by the server when HIVE_LIVE_DIR is set. */
export const ASK_USER_TOOL = 'ask_user'
/**
 * A5: claude's MCP client timeout for this spawn only (env, never global config), so an ask_user wait of up to the
 * server's 3600 s does not error first.
 */
export const MCP_TOOL_TIMEOUT_MS = '3700000'

/**
 * claude: per-grant --mcp-config file; tools pre-approved so permissionMode 'default' steps can still call them.
 * `askUser` (headless steps only, A2) also pre-approves mcp__hivemem__ask_user.
 */
export function claudeMcpAttach(grant: MemoryGrant, opts: { askUser?: boolean } = {}): McpAttachment {
  const path = join(grant.spawnDir, `${grant.grantId}.mcp.json`)
  const s = grant.server
  const config = { mcpServers: { [MEMORY_SERVER_NAME]: { type: 'stdio', command: s.command, args: s.args, env: s.env } } }
  const tools = [...grant.toolNames, ...(opts.askUser && !grant.toolNames.includes(ASK_USER_TOOL) ? [ASK_USER_TOOL] : [])]
  // Both options are variadic: callers must follow them with another --flag, never the positional prompt.
  // Never --strict-mcp-config: the user's own MCP servers keep working.
  return {
    args: ['--mcp-config', path, '--allowedTools', tools.map(claudeToolName).join(',')],
    env: {},
    files: [{ path, content: `${JSON.stringify(config, null, 2)}\n` }]
  }
}

/**
 * AUTHORING.md §1.1 (PO1, PO7): ONE per-spawn --mcp-config for an interactive claude session holding every Hive server
 * of that spawn: `hivemem` (when granted) and `hive` (authoring). Tools of both are pre-allowed (Hive's own approval
 * card is the gate for authoring writes; a second CLI prompt would be noise). Never --strict-mcp-config.
 */
export function claudeSessionMcpAttach(
  path: string,
  servers: { server: McpServerSpec; toolNames: readonly string[] }[]
): McpAttachment {
  const mcpServers: Record<string, unknown> = {}
  const tools: string[] = []
  for (const { server: s, toolNames } of servers) {
    mcpServers[s.name] = { type: 'stdio', command: s.command, args: s.args, env: s.env }
    for (const t of toolNames) tools.push(`mcp__${s.name}__${t}`)
  }
  return {
    args: ['--mcp-config', path, '--allowedTools', tools.join(',')],
    env: {},
    files: [{ path, content: `${JSON.stringify({ mcpServers }, null, 2)}\n` }]
  }
}

/** TOML basic string; JSON string escaping is a valid subset. */
const toml = (v: string): string => JSON.stringify(v)
const tomlArr = (vs: string[]): string => `[${vs.map(toml).join(',')}]`

/** codex: `-c mcp_servers.hivemem.*` overrides for this invocation only (no ~/.codex/config.toml edits). Unverified. */
export function codexMcpAttach(grant: MemoryGrant): McpAttachment {
  const k = `mcp_servers.${MEMORY_SERVER_NAME}`
  const s = grant.server
  const args = ['-c', `${k}.command=${toml(s.command)}`, '-c', `${k}.args=${tomlArr(s.args)}`]
  for (const [name, value] of Object.entries(s.env)) args.push('-c', `${k}.env.${name}=${toml(value)}`)
  args.push('-c', `${k}.enabled_tools=${tomlArr(grant.toolNames)}`)
  args.push('-c', `${k}.default_tools_approval_mode="approve"`)
  return { args, env: {}, files: [] }
}

/** gemini: a per-grant system settings file holding only hivemem. Unverified (merge semantics). */
export function geminiMcpAttach(grant: MemoryGrant): McpAttachment {
  const path = join(grant.spawnDir, `${grant.grantId}.gemini.json`)
  const s = grant.server
  const settings = {
    mcpServers: { [MEMORY_SERVER_NAME]: { command: s.command, args: s.args, env: s.env, trust: true, includeTools: grant.toolNames } }
  }
  return {
    args: [],
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path },
    files: [{ path, content: `${JSON.stringify(settings, null, 2)}\n` }]
  }
}

/** Writes the attachment's files (dir 0700, files 0600). Throws on fs errors (caller falls back to inject). */
export function writeMcpFiles(files: McpFile[]): void {
  for (const f of files) {
    mkdirSync(join(f.path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(f.path, f.content, { mode: 0o600 })
    chmodSync(f.path, 0o600)
  }
}
export function removeMcpFiles(files: McpFile[]): void {
  for (const f of files) {
    try {
      rmSync(f.path, { force: true })
    } catch {
      /* best effort; main's release + boot sweep also delete */
    }
  }
}

/**
 * Write discipline for spawns that can write (engine-side, next to the brief). Agents otherwise churn: write
 * five facts, then invalidate three of their own as redundant, which burns writes and fills History with noise.
 */
export const MEMORY_WRITE_RULES = [
  '<memory-write-rules>',
  '- Hive memory (the hivemem tools) is the memory for this project. When the user asks you to remember or save',
  '  something, or you learn a lasting fact (decision, convention, gotcha), save it with memory_write. Do not save it',
  "  in your CLI's own memory instead (~/.claude/projects/*/memory, CLAUDE.md, GEMINI.md, AGENTS.md, .cursor/rules).",
  '- Before you finish a task, check what a future agent on this repo would need that is not obvious from the code',
  '  and not in memory yet (a decision and its reason, a convention, a gotcha, a command that works). Save the best',
  '  0-3 with memory_write. Saving nothing is right when nothing new and lasting came up.',
  '- Before memory_write, call memory_search on the topic and skip anything already stored (even reworded).',
  '- Write only facts the source you read states outright (code, docs, the user). No inferences, summaries,',
  '  restatements or speculation beyond the source.',
  '- Decide before writing: write few, final facts. Never write and then invalidate your own facts;',
  '  use memory_invalidate only for an existing memory the source proves wrong.',
  '</memory-write-rules>'
].join('\n')

/** True when this grant's spawn actually reaches the write tools (MCP attached + memory_write granted). */
export const canWriteMemory = (grant: MemoryGrant, attached: boolean): boolean =>
  attached && grant.toolNames.includes('memory_write')

/** The brief an agent sees: main's <hive-memory> block, plus the write rules when it can write. */
export function agentBrief(grant: MemoryGrant, attached: boolean): string {
  const parts = [grant.brief.trim(), canWriteMemory(grant, attached) ? MEMORY_WRITE_RULES : ''].filter(Boolean)
  return parts.join('\n\n')
}

/** Headless placement (MEMORY.md 6.3): brief block, blank line, the prompt. Empty brief = prompt unchanged. */
export const withBrief = (brief: string, prompt: string): string => (brief.trim() ? `${brief.trim()}\n\n${prompt}` : prompt)

// ---------- readable tool-call lines ----------

const MEM_TOOL = /^(?:mcp__hivemem__|hivemem[.:/_]{1,2})?(memory_(?:search|get|write|invalidate))$/

const short = (s: unknown, n = 60): string => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * `[memory] write auth-service (2 facts)` for a hivemem tool call, null for any other tool.
 * Accepts claude's `mcp__hivemem__memory_write` and codex's `hivemem.memory_write`.
 */
export function memoryToolLine(name: string, input: unknown): string | null {
  const m = MEM_TOOL.exec(name)
  if (!m) return null
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  switch (m[1]) {
    case 'memory_search':
      return `[memory] search "${short(i.query)}"${typeof i.entity === 'string' ? ` near ${short(i.entity, 40)}` : ''}`
    case 'memory_get':
      return `[memory] get ${arr(i.names).map((x) => short(x, 40)).join(', ') || '(nothing)'}`
    case 'memory_write': {
      const bits: string[] = []
      const f = arr(i.facts).length
      const r = arr(i.relations).length
      if (f) bits.push(plural(f, 'fact'))
      if (r) bits.push(plural(r, 'relation'))
      return `[memory] write ${short(i.entity, 60) || '(entity)'}${bits.length ? ` (${bits.join(', ')})` : ''}`
    }
    case 'memory_invalidate':
      return `[memory] invalidate ${plural(arr(i.ids).length, 'item')}${i.reason ? `: ${short(i.reason)}` : ''}`
  }
  return null
}
