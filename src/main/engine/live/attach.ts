/**
 * Per-spawn hook (and gemini/cursor MCP) injection (LIVE.md §3.5). The engine renders files into the spawn's live
 * dir; nothing under ~/.claude, ~/.gemini or ~/.cursor is ever touched.
 *  - claude: `--settings <dir>/claude-settings.json` (interactive only; headless streams carry everything);
 *  - gemini: ONE system settings file via GEMINI_CLI_SYSTEM_SETTINGS_PATH (hooks + hivemem), merged over the admin file;
 *  - cursor: a temp plugin dir via `--plugin-dir` (hooks/hooks.json, mcp.json).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec } from '../../../shared/engine'
import { MEMORY_SERVER_NAME } from '../../../shared/memory'
import type { AdapterId } from '../../../shared/types'
import type { McpAttachment, McpFile } from '../memory'

/**
 * Blocking hook gates verified on a real CLI run (scripts/verify-live-hooks.cjs). Gates only; observational hooks
 * are injected whenever LIVE_HOOKS says so. Flip per adapter with the CLI version noted:
 *  - claude: verified on 2.1.301 (interactive replies go through guarded PTY keys, A1; no gate is injected);
 *  - gemini, cursor: not installed here; UNVERIFIED.
 */
export const HOOKS_VERIFIED: Record<AdapterId, boolean> = { claude: true, gemini: false, cursor: false, codex: false, shell: false }
/** Kill switch for hook injection itself. */
export const LIVE_HOOKS: Record<AdapterId, boolean> = { claude: true, gemini: true, cursor: true, codex: false, shell: false }

/** Machine-wide gemini system settings that GEMINI_CLI_SYSTEM_SETTINGS_PATH replaces (macOS). */
export const GEMINI_ADMIN_SETTINGS = '/Library/Application Support/GeminiCli/settings.json'

export interface LiveSpawn {
  dir: string
  /** Ready-to-use, quoted base command of Hive's hook script (main). The adapter appends --provider/--gate. */
  hookCommand: string
}
/** The hivemem server to add to a gemini/cursor spawn (memory and/or ask_user). */
export interface LiveMcp {
  server: McpServerSpec
  toolNames: string[]
}
export interface HooksAttachOptions {
  headless: boolean
  /** Inject blocking gates (only when HOOKS_VERIFIED and the profile asks: permissionMode 'default'). */
  gate: boolean
  mcp?: LiveMcp | null
  /** gemini: admin settings path override (tests). */
  geminiAdminPath?: string
}
export interface HooksAttachResult extends McpAttachment {
  /** Set when injection was skipped (e.g. unreadable admin settings). */
  warning?: string
}

const cmd = (live: LiveSpawn, provider: AdapterId, gate = false): string => `${live.hookCommand} --provider ${provider}${gate ? ' --gate' : ''}`
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

// ---------- claude ----------

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  // CONTRACT §13: a turn that ends on an API error (error: "rate_limit" = usage limit)
  'StopFailure',
  'SessionEnd'
] as const
const CLAUDE_MATCHED = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification'])

/** All hooks observational and async (A1: no gate for interactive sessions). */
export function claudeHooksSettings(live: LiveSpawn): Record<string, unknown> {
  const h = { type: 'command', command: cmd(live, 'claude'), async: true }
  const hooks: Record<string, unknown[]> = {}
  for (const ev of CLAUDE_HOOK_EVENTS) hooks[ev] = [CLAUDE_MATCHED.has(ev) ? { matcher: '*', hooks: [h] } : { hooks: [h] }]
  return { hooks }
}

export function claudeHooksAttach(live: LiveSpawn, o: HooksAttachOptions): HooksAttachResult {
  if (o.headless) return { args: [], env: {}, files: [] }
  const path = join(live.dir, 'claude-settings.json')
  return { args: ['--settings', path], env: {}, files: [{ path, content: json(claudeHooksSettings(live)) }] }
}

// ---------- gemini ----------

/** Tools a gemini hook gate holds (MCP except hivemem's own). */
export const GEMINI_GATED_MATCHER = 'run_shell_command|write_file|replace|mcp_(?!hivemem_).*'
const GATE_TIMEOUT_MS = 3_600_000

export function geminiHooks(live: LiveSpawn, gate: boolean): Record<string, unknown[]> {
  const h = (g = false): Record<string, unknown> => ({ type: 'command', command: cmd(live, 'gemini', g), ...(g ? { timeout: GATE_TIMEOUT_MS } : {}) })
  return {
    SessionStart: [{ hooks: [h()] }],
    BeforeAgent: [{ hooks: [h()] }],
    BeforeTool: [{ matcher: '.*', hooks: [h()] }, ...(gate ? [{ matcher: GEMINI_GATED_MATCHER, hooks: [h(true)] }] : [])],
    AfterTool: [{ matcher: '.*', hooks: [h()] }],
    Notification: [{ hooks: [h()] }],
    AfterAgent: [{ hooks: [h()] }],
    SessionEnd: [{ hooks: [h()] }]
  }
}

function geminiMcpEntry(m: LiveMcp): Record<string, unknown> {
  return { command: m.server.command, args: m.server.args, env: m.server.env, trust: true, includeTools: m.toolNames }
}

/**
 * Merge (LIVE.md §3.5): Hive keys are added; on conflict the admin file wins, except `hooks`, which are concatenated
 * per event (admin first).
 */
export function mergeGeminiSettings(admin: Record<string, unknown>, hive: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...hive }
  for (const [k, v] of Object.entries(admin)) {
    if (k === 'hooks' && v && typeof v === 'object' && !Array.isArray(v)) {
      const merged: Record<string, unknown[]> = { ...((hive.hooks as Record<string, unknown[]>) ?? {}) }
      for (const [ev, list] of Object.entries(v as Record<string, unknown>)) {
        merged[ev] = [...(Array.isArray(list) ? list : []), ...(merged[ev] ?? [])]
      }
      out.hooks = merged
    } else if (k === 'mcpServers' && v && typeof v === 'object' && hive.mcpServers && typeof hive.mcpServers === 'object') {
      out.mcpServers = { ...(hive.mcpServers as object), ...(v as object) }
    } else if (k === 'hooksConfig' && v && typeof v === 'object' && hive.hooksConfig && typeof hive.hooksConfig === 'object') {
      out.hooksConfig = { ...(hive.hooksConfig as object), ...(v as object) }
    } else out[k] = v
  }
  return out
}

export function geminiHooksAttach(live: LiveSpawn | null, o: HooksAttachOptions): HooksAttachResult {
  const settings: Record<string, unknown> = {}
  if (live && LIVE_HOOKS.gemini) {
    settings.hooksConfig = { enabled: true }
    settings.hooks = geminiHooks(live, o.gate && HOOKS_VERIFIED.gemini)
  }
  if (o.mcp) settings.mcpServers = { [MEMORY_SERVER_NAME]: geminiMcpEntry(o.mcp) }
  if (!Object.keys(settings).length) return { args: [], env: {}, files: [] }
  const adminPath = o.geminiAdminPath ?? GEMINI_ADMIN_SETTINGS
  let merged = settings
  if (existsSync(adminPath)) {
    try {
      const admin = JSON.parse(readFileSync(adminPath, 'utf8'))
      if (!admin || typeof admin !== 'object' || Array.isArray(admin)) throw new Error('not an object')
      merged = mergeGeminiSettings(admin as Record<string, unknown>, settings)
    } catch (e) {
      // replacing the system path would silently drop the admin's enforced settings: skip injection this spawn
      return { args: [], env: {}, files: [], warning: `gemini admin settings unreadable (${String(e)}); live hooks skipped` }
    }
  }
  const dir = live?.dir
  if (!dir) return { args: [], env: {}, files: [] }
  const path = join(dir, 'gemini-system.json')
  return { args: [], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path }, files: [{ path, content: json(merged) }] }
}

// ---------- cursor ----------

export function cursorHooksJson(live: LiveSpawn, gate: boolean): Record<string, unknown> {
  const h = (g = false): Record<string, unknown> => ({ command: cmd(live, 'cursor', g), ...(g ? { timeout: 3600, failClosed: true } : {}) })
  const hooks: Record<string, unknown[]> = {}
  for (const ev of ['sessionStart', 'beforeSubmitPrompt', 'subagentStart', 'subagentStop', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'stop', 'sessionEnd'])
    hooks[ev] = [h()]
  if (gate) {
    hooks.beforeShellExecution = [h(true)]
    hooks.beforeMCPExecution = [h(true)]
  }
  return { version: 1, hooks }
}

export function cursorHooksAttach(live: LiveSpawn, o: HooksAttachOptions): HooksAttachResult {
  if (!LIVE_HOOKS.cursor) return { args: [], env: {}, files: [] }
  const root = join(live.dir, 'cursor-plugin')
  const gate = o.gate && HOOKS_VERIFIED.cursor
  const files: McpFile[] = [
    { path: join(root, '.cursor-plugin', 'plugin.json'), content: json({ name: 'hive' }) },
    { path: join(root, 'hooks', 'hooks.json'), content: json(cursorHooksJson(live, gate)) }
  ]
  const args = ['--plugin-dir', root]
  if (o.mcp) {
    const s = o.mcp.server
    files.push({ path: join(root, 'mcp.json'), content: json({ mcpServers: { [MEMORY_SERVER_NAME]: { command: s.command, args: s.args, env: s.env } } }) })
    args.push('--approve-mcps')
  }
  return { args, env: {}, files }
}
