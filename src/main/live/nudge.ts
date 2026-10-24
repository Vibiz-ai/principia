/**
 * PROACTIVE.md §4: the one-time "track it" reminder of an interactive claude pane (a Stop hook, bundled into hive-hook.js),
 * attached only under Settings → "Track work as tasks" = Always; never under the default.
 * When a turn changed files or ran many steps but never touched a Principia board tool, the hook blocks the end of the
 * turn once with a reason; Claude then files or updates its task(s), or just finishes when it was one quick ask.
 * `stop_hook_active` (Claude is already continuing because of a Stop hook) always lets the turn end, so it never loops.
 * Pure apart from reading the transcript tail; every failure means "no nudge".
 */
import fs from 'node:fs'

export const NUDGE_REASON =
  'Principia reminder (once; the founder chose "Always" for tracking work): this turn did several steps that the board does not show. ' +
  'If it is worth tracking, open or update its task now (task_create / task_update) and name it in your answer; if it was a quick ask or the founder said no tasks, just finish.'

/** Tool names that count as using the board. */
const BOARD = /^mcp__hive__(task_|company_file_task$|company_create_department$)/
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** A turn needs at least this much work to be nudged. */
export const NUDGE_MIN = { edits: 2, tools: 8 } as const
const TAIL_BYTES = 2 * 1024 * 1024

export interface TurnStats {
  tools: number
  edits: number
  board: boolean
  /** the founder's message that started the turn */
  prompt: string
}

type Block = { type?: string; name?: string; text?: string }
const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
/** A user line that is the founder typing (not a tool result, not an injected meta line). */
function isPrompt(e: Record<string, unknown>): string | null {
  if (e.type !== 'user' || e.isMeta === true) return null
  const m = e.message as { content?: unknown } | undefined
  if (typeof m?.content === 'string') return m.content
  const b = blocks(m?.content)
  if (!b.length || b.some((x) => x.type === 'tool_result')) return null
  const text = b.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n')
  return text || null
}

/** The last turn of a claude transcript (JSONL): its prompt and the tools it used. */
export function lastTurnStats(jsonl: string): TurnStats {
  const lines = jsonl.split('\n')
  const s: TurnStats = { tools: 0, edits: 0, board: false, prompt: '' }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const prompt = isPrompt(e)
    if (prompt !== null) {
      s.prompt = prompt
      break
    }
    if (e.type !== 'assistant') continue
    for (const b of blocks((e.message as { content?: unknown } | undefined)?.content)) {
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
      s.tools++
      if (EDITS.has(b.name)) s.edits++
      if (BOARD.test(b.name)) s.board = true
    }
  }
  return s
}

/** Whether this turn earns the nudge. Questions that changed nothing never do. */
export function shouldNudge(s: TurnStats): boolean {
  if (s.board) return false
  if (s.edits === 0 && s.prompt.trim().endsWith('?')) return false
  return s.edits >= NUDGE_MIN.edits || s.tools >= NUDGE_MIN.tools
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The Stop hook's answer for one payload: the block decision, or null to let the turn end. */
export function nudgeDecision(payload: unknown, read: (file: string) => string = readTail): { decision: 'block'; reason: string } | null {
  try {
    const p = (payload && typeof payload === 'object' ? payload : {}) as { stop_hook_active?: unknown; transcript_path?: unknown; hook_event_name?: unknown }
    if (p.stop_hook_active === true) return null
    if (p.hook_event_name !== undefined && p.hook_event_name !== 'Stop') return null
    if (typeof p.transcript_path !== 'string' || !p.transcript_path) return null
    return shouldNudge(lastTurnStats(read(p.transcript_path))) ? { decision: 'block', reason: NUDGE_REASON } : null
  } catch {
    return null
  }
}
