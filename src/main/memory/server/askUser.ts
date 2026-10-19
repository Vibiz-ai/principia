/**
 * hivemem `ask_user` (docs/LIVE.md §4.2, A2/A4c/A5). Listed only when HIVE_LIVE_DIR is set (headless steps).
 * Appends `{"hive":"ask_user",gate_id,question,options,allow_text,agent_hint}` to $HIVE_LIVE_DIR/events.jsonl and blocks
 * on $HIVE_LIVE_DIR/answers/<gate_id>.json (<= 3600 s). The JSON-RPC loop stays responsive (ping) while it waits.
 * On notifications/cancelled it appends `{"hive":"ask_user_cancelled",gate_id}` so Hive closes the ask (A4c).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import { waitForAnswer } from '../../live/hook'
import type { ToolDef, ToolResult } from './tools'

export const ASK_USER_TIMEOUT_MS = 3600_000
export const NO_ANSWER_NOTE = 'The user did not answer; continue with your best judgement.'

export const ASK_USER_DEF: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the human user a question and wait for the answer. Use when you need a decision or information only the user has. The step pauses until they answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 2000, description: 'The question, self-contained.' },
      options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, maxItems: 6, description: 'Optional choices.' },
      allow_text: { type: 'boolean', default: true, description: 'Whether a free-text answer is accepted.' }
    },
    required: ['question'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
}

const ARGS = z.strictObject({
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(120)).max(6).optional(),
  allow_text: z.boolean().optional()
})

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
export function newGateId(): string {
  const b = crypto.randomBytes(10)
  let s = ''
  for (const x of b) s += ALPHABET[x % 36]
  return `ask_${s}`
}

export interface AskCallContext {
  /** _meta of the tools/call request (claude: "claudecode/toolUseId"). */
  meta?: Record<string, unknown> | null
  /** Aborted on notifications/cancelled for this request. */
  signal?: AbortSignal
}

const text = (o: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o })

export function agentHint(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null
  for (const k of ['claudecode/toolUseId', 'toolUseId', 'tool_use_id']) {
    const v = meta[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** Runs one ask_user call. Resolves { answer } / { answer: null, note }; rejects with 'canceled' when aborted. */
export async function askUser(liveDir: string, rawArgs: unknown, ctx: AskCallContext = {}, timeoutMs = ASK_USER_TIMEOUT_MS): Promise<ToolResult> {
  const r = ARGS.safeParse(rawArgs ?? {})
  if (!r.success) {
    const i = r.error.issues[0]
    return { content: [{ type: 'text', text: `Invalid arguments: ${i.path.join('.') || '(root)'}: ${i.message}` }], isError: true }
  }
  const a = r.data
  const gateId = newGateId()
  const events = path.join(liveDir, 'events.jsonl')
  const line = {
    hive: 'ask_user',
    gate_id: gateId,
    question: a.question,
    options: a.options ?? [],
    allow_text: a.allow_text ?? true,
    agent_hint: agentHint(ctx.meta)
  }
  try {
    fs.appendFileSync(events, JSON.stringify(line) + '\n')
  } catch (e) {
    return { content: [{ type: 'text', text: `Hive could not reach the user: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
  const aborted = new Promise<'aborted'>((resolve) => {
    if (ctx.signal?.aborted) resolve('aborted')
    ctx.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  const answer = await Promise.race([waitForAnswer(liveDir, gateId, timeoutMs), aborted])
  if (answer === 'aborted') {
    try {
      fs.appendFileSync(events, JSON.stringify({ hive: 'ask_user_cancelled', gate_id: gateId }) + '\n')
    } catch {
      /* ignore */
    }
    throw new Error('canceled')
  }
  if (answer && typeof answer === 'object' && typeof (answer as { answer?: unknown }).answer === 'string') {
    return text({ answer: (answer as { answer: string }).answer })
  }
  return text({ answer: null, note: (answer as { note?: string } | null)?.note ?? NO_ANSWER_NOTE })
}
