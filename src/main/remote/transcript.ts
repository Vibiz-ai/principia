/**
 * REMOTE.md RA3 "a terminal on the phone": the agent's own transcript of a terminal session, as the records the chat
 * reducer (shared/chatReduce.ts) reads. Claude Code's transcript (~/.claude/projects/<slug>/<id>.jsonl) already has
 * those shapes; a Codex rollout (~/.codex/sessions/…/rollout-*.jsonl) is turned into them here, so a terminal shows on
 * the phone with the same cards as a chat. Read-only. Pure.
 */
import { unwrapShell } from '../../shared/codexReduce'

export type TranscriptFormat = 'claude' | 'codex'
export interface TranscriptRef {
  file: string
  format: TranscriptFormat
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Codex's own context for the model (environment, AGENTS.md, permissions), never the person typing. */
const CONTEXT = /^\s*(?:<[a-z_]+>|# AGENTS\.md instructions)/i

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((c) => {
      const o = obj(c)
      return o.type === 'input_text' || o.type === 'output_text' || o.type === 'text' ? (str(o.text) ?? '') : ''
    })
    .filter(Boolean)
    .join('\n')
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return obj(raw)
  if (typeof raw !== 'string') return {}
  try {
    return obj(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** A Codex call as a Claude tool: shells read as Bash, the plan as TodoWrite, MCP tools as mcp__server__tool. */
export function codexTool(name: string, args: Record<string, unknown>, namespace: string | null): { name: string; input: Record<string, unknown> } {
  const cmd = args.command ?? args.cmd
  if (name === 'shell' || name === 'container.exec' || name === 'local_shell' || name === 'exec_command' || name === 'shell_command') {
    const line = Array.isArray(cmd) ? cmd.map(String).join(' ') : (str(cmd) ?? '')
    return { name: 'Bash', input: { command: unwrapShell(line) } }
  }
  if (name === 'update_plan') {
    const todos = arr(args.plan).map(obj).map((s) => {
      const st = str(s.status)
      return { content: str(s.step) ?? '', activeForm: str(s.step) ?? '', status: st === 'in_progress' || st === 'inProgress' ? 'in_progress' : st === 'completed' ? 'completed' : 'pending' }
    })
    return { name: 'TodoWrite', input: { todos } }
  }
  // Codex's code-mode tool: a short script calling its tools; the command it runs is what it does
  if (name === 'exec' && typeof args.input === 'string') {
    const m = /exec_command\(\s*\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(args.input)
    if (m) {
      try {
        return { name: 'Bash', input: { command: unwrapShell(String(JSON.parse(m[1]!))) } }
      } catch {
        /* not a plain string: the tool as it is */
      }
    }
  }
  return { name: namespace && !name.startsWith('mcp__') ? `mcp__${namespace}__${name}` : name, input: args }
}

/** One file of an apply_patch: what the diff view and the file counts read (Write for a new file, Edit otherwise). */
export function patchFiles(patch: string): { name: 'Edit' | 'Write'; input: Record<string, unknown> }[] {
  const out: { name: 'Edit' | 'Write'; input: Record<string, unknown>; add: string[]; del: string[] }[] = []
  for (const line of patch.split('\n')) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (head) {
      out.push({ name: head[1] === 'Add' ? 'Write' : 'Edit', input: { file_path: head[2]!.trim() }, add: [], del: [] })
      continue
    }
    const cur = out[out.length - 1]
    if (!cur || line.startsWith('***')) continue
    if (line.startsWith('+')) cur.add.push(line.slice(1))
    else if (line.startsWith('-')) cur.del.push(line.slice(1))
  }
  return out.map((f) => ({
    name: f.name,
    input: f.name === 'Write' ? { ...f.input, content: f.add.join('\n') } : { ...f.input, old_string: f.del.join('\n'), new_string: f.add.join('\n') }
  }))
}

/**
 * A tool's output: Codex wraps it ({output, metadata} or, from its exec tool, a line {output, exit_code} after a
 * header) or prints "Process exited with code N" above it.
 */
export function codexOutput(raw: unknown): { text: string; error: boolean } {
  let text = typeof raw === 'string' ? raw : textOf(raw)
  let code: number | null = null
  const last = text.trimEnd().split('\n').pop()?.trim() ?? ''
  for (const candidate of [text.trim(), last]) {
    if (!candidate.startsWith('{')) continue
    const o = parseArgs(candidate)
    if (typeof o.output !== 'string') continue
    const c = typeof o.exit_code === 'number' ? o.exit_code : obj(o.metadata).exit_code
    return { text: o.output, error: typeof c === 'number' && c !== 0 }
  }
  const m = /^(?:Process exited with code|Exit code:)\s*(-?\d+)/m.exec(text)
  if (m) code = Number(m[1])
  const body = /\nOutput:\n([\s\S]*)$/.exec(text)
  if (body) text = body[1]!
  return { text, error: code !== null && code !== 0 }
}

/**
 * One Codex rollout, line by line, as Claude transcript records. Stateful only to answer every card of a patch that
 * touched several files.
 */
export class CodexTranscript {
  private calls = new Map<string, string[]>()

  records(raw: unknown): unknown[] {
    const o = obj(raw)
    const p = obj(o.payload)
    const at = str(o.timestamp)
    if (o.type === 'event_msg') {
      if (p.type === 'task_complete') return [{ type: 'result', subtype: 'success', ...(typeof p.duration_ms === 'number' ? { duration_ms: p.duration_ms } : {}) }]
      if (p.type === 'turn_aborted') return [{ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }]
      return []
    }
    if (o.type !== 'response_item') return []
    switch (p.type) {
      case 'message': {
        const text = textOf(p.content)
        if (p.role === 'user') return text.trim() && !CONTEXT.test(text) ? [{ type: 'user', ...(at ? { timestamp: at } : {}), message: { role: 'user', content: text } }] : []
        if (p.role === 'assistant') return text.trim() ? [{ type: 'assistant', message: { ...(str(p.id) ? { id: str(p.id) } : {}), role: 'assistant', content: [{ type: 'text', text }] } }] : []
        return []
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = str(p.call_id) ?? str(p.id)
        if (!id) return []
        const name = str(p.name) ?? (p.type === 'local_shell_call' ? 'local_shell' : 'tool')
        const patch = name === 'apply_patch' ? (p.type === 'custom_tool_call' ? str(p.input) : str(parseArgs(p.arguments).input)) : null
        const tools = patch !== null ? patchFiles(patch) : []
        const uses = tools.length
          ? tools.map((t, n) => ({ type: 'tool_use', id: n ? `${id}#${n}` : id, name: t.name, input: t.input }))
          : [{ type: 'tool_use', id, ...codexTool(name, p.type === 'custom_tool_call' ? { input: p.input } : p.type === 'local_shell_call' ? obj(p.action) : parseArgs(p.arguments), str(p.namespace)) }]
        this.calls.set(id, uses.map((u) => u.id))
        return [{ type: 'assistant', message: { id: `call:${id}`, role: 'assistant', content: uses } }]
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = str(p.call_id)
        if (!id) return []
        const out = codexOutput(p.output)
        const ids = this.calls.get(id) ?? [id]
        this.calls.delete(id)
        return [{ type: 'user', message: { role: 'user', content: ids.map((t) => ({ type: 'tool_result', tool_use_id: t, content: out.text, is_error: out.error })) } }]
      }
      default:
        return []
    }
  }
}

/** A rollout's first line: which folder it ran in and when it began (finding the rollout of a terminal session). */
export function codexMeta(firstLine: unknown): { cwd: string; at: number } | null {
  const o = obj(firstLine)
  if (o.type !== 'session_meta') return null
  const p = obj(o.payload)
  const cwd = str(p.cwd)
  const at = Date.parse(str(p.timestamp) ?? str(o.timestamp) ?? '')
  return cwd && Number.isFinite(at) ? { cwd, at } : null
}
