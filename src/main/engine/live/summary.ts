/**
 * Activity lines, file touches and memory-read detection for one tool call (LIVE.md §1.3, §3.7). Pure.
 */
import { isAbsolute, relative } from 'node:path'
import type { AdapterId } from '../../../shared/types'
import { memoryToolLine } from '../memory'

export const ACTIVITY_MAX = 120
export const SUMMARY_MAX = 200
export const DETAIL_MAX = 4096

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
export const clip = (s: string, n: number): string => {
  const t = oneLine(s)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
/** Detail text: kept multi-line, capped at 4 KB. */
export const clipDetail = (s: string | null | undefined): string | null => {
  if (s == null) return null
  const t = String(s)
  if (!t.trim()) return null
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1)}…` : t
}
export const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim()) ?? '').trim()

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** The main argument of a tool call, by provider-agnostic field names. */
function mainArg(input: unknown): string | null {
  const i = obj(input)
  for (const k of ['file_path', 'notebook_path', 'command', 'pattern', 'query', 'path', 'url', 'agent_name', 'subagent_type', 'description', 'prompt']) {
    const v = s(i[k])
    if (v) return v
  }
  // cursor: args nested under the oneof
  const args = obj(i.args)
  for (const k of ['command', 'path', 'pattern', 'query', 'url', 'description']) {
    const v = s(args[k])
    if (v) return v
  }
  return null
}

/** Display name of a tool: strips MCP prefixes for readability. */
export function displayToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (m) return `${m[1]}.${m[2]}`
  const c = /^mcp:([^.]+)\.(.+)$/.exec(name)
  if (c) return `${c[1]}.${c[2]}`
  return name
}

/**
 * `Edit src/login.ts`, `Bash npm test`, `[memory] search "auth"`. Memory tools reuse memoryToolLine().
 * Returns the activity line (<= 120 chars) and lastTool (the tool name).
 */
export function summarizeTool(provider: AdapterId, name: string, input: unknown): { line: string; lastTool: string } {
  const memName = normalizeMemoryName(provider, name)
  const mem = memName ? memoryToolLine(memName, memoryInput(provider, input)) : null
  if (mem) return { line: clip(mem, ACTIVITY_MAX), lastTool: name }
  const arg = mainArg(input)
  const disp = displayToolName(name)
  return { line: clip(arg ? `${disp} ${arg}` : disp, ACTIVITY_MAX), lastTool: name }
}

/** cursor wraps MCP args one level deeper ({name, args, toolName}). */
function memoryInput(provider: AdapterId, input: unknown): unknown {
  if (provider !== 'cursor') return input
  const i = obj(input)
  const args = obj(i.args)
  return Object.keys(obj(args.args)).length ? args.args : Object.keys(args).length ? args : input
}

/**
 * Maps any provider's hivemem tool name to the claude form `mcp__hivemem__memory_x`, or null for non-memory tools.
 * claude `mcp__hivemem__memory_search`, gemini `mcp_hivemem_memory_search`, cursor `mcp:hivemem.memory_search`,
 * codex `hivemem.memory_search`.
 */
export function normalizeMemoryName(_provider: AdapterId, name: string): string | null {
  const m = /^(?:mcp__hivemem__|mcp_hivemem_|mcp:hivemem\.|hivemem[.:/_]{1,2}|hivemem-)?(memory_(?:search|get|write|invalidate))$/.exec(name)
  if (!m) return null
  // a bare `memory_search` only counts when it came with a hivemem prefix
  if (m[0] === m[1]) return null
  return `mcp__hivemem__${m[1]}`
}

/** True for memory_search / memory_get under any provider's naming (LIVE.md §1.4). */
export function isMemoryRead(provider: AdapterId, name: string): boolean {
  const n = normalizeMemoryName(provider, name)
  return n === 'mcp__hivemem__memory_search' || n === 'mcp__hivemem__memory_get'
}

/** True for the hivemem ask_user tool under any provider's naming. */
export function isAskUserTool(name: string): boolean {
  return /^(?:mcp__hivemem__|mcp_hivemem_|mcp:hivemem\.|hivemem[.:/_-]{1,2})ask_user$/.test(name)
}

const EDIT_TOOLS: Partial<Record<AdapterId, Record<string, string[]>>> = {
  claude: { Edit: ['file_path'], MultiEdit: ['file_path'], Write: ['file_path'], NotebookEdit: ['notebook_path'] },
  gemini: { write_file: ['file_path'], replace: ['file_path'] },
  cursor: { edit: ['path'], write: ['path'] },
  codex: {}
}

/** Paths an edit-type tool touched, relative to `cwd` when inside it (LIVE.md §3.7). */
export function editedFiles(provider: AdapterId, name: string, input: unknown, cwd: string): string[] {
  const i = obj(input)
  const out: string[] = []
  if (provider === 'codex') {
    if (name === 'file_change' || i.type === 'file_change') {
      for (const c of Array.isArray(i.changes) ? (i.changes as unknown[]) : []) {
        const p = s(obj(c).path)
        if (p) out.push(p)
      }
    }
  } else {
    const fields = EDIT_TOOLS[provider]?.[name]
    if (!fields) return []
    const src = provider === 'cursor' ? { ...i, ...obj(i.args) } : i
    for (const f of fields) {
      const p = s((src as Record<string, unknown>)[f])
      if (p) out.push(p)
    }
  }
  return out.map((p) => relPath(p, cwd))
}

export function relPath(p: string, cwd: string): string {
  if (!isAbsolute(p) || !cwd) return p
  const r = relative(cwd, p)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : p
}

export const FILES_CAP = 50
/** Adds paths to a capped, de-duplicated list (keeps first 50). */
export function addFiles(list: string[], paths: string[]): string[] {
  if (!paths.length || list.length >= FILES_CAP) return list
  const next = [...list]
  for (const p of paths) if (!next.includes(p) && next.length < FILES_CAP) next.push(p)
  return next
}
